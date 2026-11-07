# Developing Dossier

Next.js 16 (App Router) + Prisma 7 + PostgreSQL 18, run with Docker Compose and Yarn 4. Nothing runs on the host: every command goes through the containers. For installing and running Dossier, see the [README](README.md); for how it's secured, [SECURITY.md](SECURITY.md).

## Getting started

```bash
cp .env.example .env
docker compose build
docker/bin/yarn hash-password   # set DOSSIER_PASSWORD in .env to what it prints
# set DOSSIER_SECRET (openssl rand -base64 32) in .env
docker compose up
```

Open [http://localhost:3000](http://localhost:3000). Source is bind-mounted, so edits hot-reload.

`.env.example` documents every variable. The server refuses to start while `DOSSIER_PASSWORD` or `DOSSIER_SECRET` is missing, `DOSSIER_PASSWORD` isn't a password hash, or the secret is shorter than 32 characters, and logs which variable to fix.
Server code reads configuration from the validated `env` object instead of `process.env`:

```ts
import { env } from "@/lib/env";
```

On every start the `app` container runs `prisma generate`, `prisma migrate deploy`, then `next dev`.
Postgres is also exposed on `localhost:5432` for host tools, using `DATABASE_URL` from `.env`.

## Yarn

Dependencies live in the container (a named `node_modules` volume), not on the host.
Run yarn through `docker/bin/yarn`, which uses the running `app` container or, if it's stopped, a one-off one:

```bash
docker/bin/yarn add <package>
docker/bin/yarn install   # after pulling changes to yarn.lock
docker/bin/yarn lint
```

## Database

Define models in `prisma/schema.prisma`, then create and apply a migration:

```bash
docker/bin/yarn prisma migrate dev --name <migration-name>
docker compose restart app
```

The restart regenerates the Prisma Client and picks it up; since Prisma 7, `migrate dev` no longer runs `prisma generate` on its own.

### SQLite

Dossier also runs on an SQLite file, when `DATABASE_URL` is one (`file:/data/dossier.db`), for a single container without a database server. `src/lib/database.ts` picks the client, and `prisma7.config.ts` the schema and migrations, from `DATABASE_URL`. The SQLite schema, `prisma/sqlite/schema.prisma`, is made from `prisma/schema.prisma`, which stays the only one to edit. After changing it, update the SQLite schema and make its migration too:

```bash
docker/bin/yarn sqlite-schema
docker/bin/yarn prisma migrate dev --name <migration-name>                                                   # PostgreSQL
docker compose exec -e DATABASE_URL=file:/app/data/dev.db app yarn prisma migrate dev --name <migration-name> # SQLite
```

`yarn generate` makes both clients (the container does it on start). The code uses the PostgreSQL client's types for both, so keep to what both databases do:

- No `skipDuplicates` (SQLite doesn't have it) and no `SELECT … FOR UPDATE`: lock a row with a write that changes nothing, `UPDATE "Application" SET id = id WHERE id = …`, which works in both.
- Inside `prisma.$transaction(async (tx) => …)`, query through `tx` only. SQLite has one connection, so a query through `prisma` waits until the transaction ends, and the transaction times out.
- SQLite sorts enums by name, PostgreSQL in the order they're declared.
- What Prisma doesn't manage is added to both migrations by hand: the built-in themes' delete trigger, and `COLLATE NOCASE` for the unique Skill and Language names (citext in PostgreSQL). SQLite's NOCASE only ignores the case of ASCII letters.
- SQLite can't change most columns in place, so for those Prisma's migration rebuilds the table: it creates `new_<Table>`, copies the rows, drops the old table and renames the new one. That drops the trigger (on Theme) and `COLLATE NOCASE` (on Skill and Language) too. When a migration rebuilds one of these tables, add them back by hand: `COLLATE NOCASE` in its `CREATE TABLE`, and the trigger after the rename, as in `prisma/sqlite/migrations/20261102120000_init/migration.sql`. The database tests on SQLite fail when one is missing.
- `yarn lint` refuses `skipDuplicates`, and a test checks that the SQLite migrations make exactly the SQLite schema.

To browse and edit rows in Prisma Studio, start it on demand (plain `docker compose up` leaves it off) and open [http://localhost:5555](http://localhost:5555):

```bash
docker compose up -d studio
docker compose stop studio   # when you're done
```

Query the database from server code with the shared client:

```ts
import { prisma } from "@/lib/prisma";
```

JSON columns (document units, the posting's extracted details, the match, chat edits) are validated with the zod schemas in `src/lib/application-data.ts`.
Change an application's status only through `setStatus` in `src/lib/status-actions.ts` (or `changeStatus()` in client code, which adds the Undo toast), so the funnel figures stay consistent.

### Seed data

Each start runs `prisma db seed`, which creates the six built-in themes, an empty profile and default settings. It never overwrites your profile or settings. To load the prototype's sample data (Jane Doe and nine applications):

```bash
docker/bin/yarn prisma db seed -- --demo           # refuses if you already have a profile or applications
docker/bin/yarn prisma db seed -- --demo --reset   # deletes your profile and applications first
```

## Mutations and private routes

Every mutation goes through one of two helpers. Both check the session first, keep unexpected errors out of responses (they're logged on the server without the data involved), and let `redirect()` and `notFound()` work as usual.

**Server Actions** are the default. Define them with `action(schema, handler)` in a `"use server"` file: the input is validated with zod, and the action returns `{ ok: true, data, toast? } | { ok: false, error, fieldErrors? }`, with messages written for the user.

```ts
// src/app/(app)/settings/actions.ts
"use server";

import { z } from "zod";

import { action, ActionError } from "@/lib/action";
import { prisma } from "@/lib/prisma";

export const renameTheme = action(
  z.object({ id: z.string(), name: z.string().trim().min(1, "Give the theme a name.") }),
  async ({ id, name }, { toast }) => {
    const theme = await prisma.theme.findUnique({ where: { id } });
    if (!theme) throw new ActionError("That theme no longer exists."); // shown to the user
    await prisma.theme.update({ where: { id }, data: { name } });
    toast(`Renamed to “${name}”.`);
    return { id, name };
  },
);
```

On the client, `toastResult()` from `@/components/toast` shows the action's `toast` or its error, and `toast("…")` shows any other message:

```tsx
const result = toastResult(await renameTheme({ id, name }));
```

Next.js already refuses Server Actions whose `Origin` doesn't match the host (or `X-Forwarded-Host` behind a proxy), so keep `experimental.serverActions.allowedOrigins` empty unless the proxy rewrites the host. Action bodies are limited to 1 MB, so large uploads such as imports go through a route handler.

**Route handlers** are for responses a Server Action can't give: files (PDFs, exports), uploads and progress streams. Wrap them in `route()`, which also refuses cross-origin requests (403) and signed-out ones (401), and marks responses `Cache-Control: private, no-store` unless the handler sets its own.

```ts
// src/app/api/pdf/[id]/route.ts
import { route } from "@/lib/route";

export const GET = route<RouteContext<"/api/pdf/[id]">>(async (request, { params }) => {
  const { id } = await params;
  const pdf = await renderPdf(id);
  return new Response(pdf, { headers: { "content-type": "application/pdf" } });
});
```

Both get the session from `getSession()` in `src/lib/auth/session.ts` (see [Sign-in](#sign-in)).

## Sign-in

Dossier has one user and no accounts: you sign in with the password that `DOSSIER_PASSWORD` is a hash of. The session is an encrypted token (JWE, keyed from `DOSSIER_SECRET`) in an HttpOnly, SameSite=Lax cookie, so nothing is stored on the server. It lasts until the browser closes, but at most 24 hours; with "Keep me signed in", 30 days.

The hash is argon2id with OWASP's settings (19 MiB, 2 passes, 1 lane) from Node's own `crypto.argon2`, made by `docker/bin/yarn hash-password` (`scripts/hash-password.ts`, which the image bundles as the `hash-password` command). Checking a password against it is in `src/lib/auth/password-hash.ts`, and `src/lib/env.ts` refuses anything that isn't a hash. It's written as `argon2id:m=19456,t=2,p=1:<salt>:<hash>` rather than the usual `$argon2id$v=19$…`, because Next.js and Docker Compose expand `$` in `.env` files, even inside quotes. The settings are part of each hash, so stronger ones can come later without breaking existing hashes.

Sign out from the sidebar ends the session in that browser. To sign out everywhere, set `DOSSIER_PASSWORD` to a new hash (even of the same password, since each has its own salt) or rotate `DOSSIER_SECRET` and restart: every session carries a fingerprint of the password and is encrypted with a key from the secret, so all existing sessions stop working. Rotating the secret also means API keys saved in Settings have to be entered again, since they're encrypted with it too.

In server code, `getSession()` returns the session or null, and `verifySession()` (for pages and layouts) sends the visitor to `/login` when there is none. `action()` and `route()` already check it.

Failed sign-ins are rate-limited in Postgres: after 5 failures within a minute from one IP, attempts are refused for 30 seconds, then 60, 120 and so on up to 15 minutes. The IP is the last `X-Forwarded-For` entry, which is the real client behind a reverse proxy but can be faked when the app is exposed directly, so 30 failures within 10 minutes from all IPs together also trigger the backoff. If you lock yourself out while developing, clear the counters with `docker compose exec db psql -U postgres -d dossier -c 'DELETE FROM "LoginThrottle"'`.

## AI provider

Dossier reads job postings and writes drafts with the model you choose in Settings → AI provider: a local model through Ollama or llama.cpp, LM Studio, any OpenAI-compatible server, Anthropic or Mistral, or a command-line agent signed in on the server (`codex` for OpenAI's Codex CLI, `agy` for Google's Antigravity CLI). Until you save a choice there, the `DOSSIER_AI_*` variables decide (see `.env.example`). API keys are stored encrypted with a key derived from `DOSSIER_SECRET`, and never sent back to the browser. The two CLI providers need no key or address: they run the binary from the server's PATH, and Dossier runs the tool's own sign-in from the setup guide or Settings, so nobody has to use a terminal.

`src/lib/ai/cli-login.ts` starts that sign-in and keeps the process while the panel polls it: `codex login --device-auth` prints a page and a one-time code, and `agy -p` prints Google's page and takes the authorization code back on stdin. Antigravity keeps that code prompt open for a minute, so the panel counts down and offers a retry. Tokens land where the tools keep them (`~/.codex/auth.json`, `~/.gemini/antigravity-cli/antigravity-oauth-token`); `agy` is given SSH variables so it writes a token file rather than a keyring it can't reach. The Docker image installs both CLIs and keeps those files under `/data` (`CODEX_HOME=/data/codex`, and `~/.gemini` links to `/data/gemini`), so an upgrade doesn't sign them out. Build with `--build-arg INSTALL_AI_CLIS=false` for a slimmer image without them.

`CliProvider` (`src/lib/ai/providers/cli.ts`) starts the binary without a shell, sends the prompt on stdin and reads the headless mode's output: `agy -p … --output-format json` returns a JSON envelope with the answer and its token counts, and `codex exec --output-last-message …` writes just the answer to a file. Both run read-only, and the process is killed when the call is cancelled or times out. A tool that isn't installed or isn't signed in is reported as a setup problem, naming the command to run.

A server that speaks OpenAI's API with a difference (an address people tend to get wrong, a header it requires, a field every request needs) doesn't need a provider of its own: give it an entry in `src/lib/ai/providers/servers.ts` and a case in `servers.test.ts`. DeepSeek, OpenRouter and OpenCode are there already.

Long AI tasks run as background jobs (`src/lib/jobs`): the page follows their named steps as they happen and picks them up again after a reload. A job's input and result hold personal data, so they don't last: a job that works on an application names it (`startJob(…, { applicationId })`) and is deleted with it, and finished jobs are deleted once they're older than **Keep task data for** in Settings → Your data (`src/lib/jobs/retention.ts`). Keep nothing in a job that has to outlast that; Undo on a toast and a page reattaching after a reload are fine. The prompts live in `src/lib/ai/tasks`; in strict mode ("Never invent experience", on by default) a fact guard flags names and numbers that aren't in the profile or the posting.

The Usage screen shows the tokens each task used, as the servers counted them. Every request names its task (`task`, one of `USAGE_TASKS` in `src/lib/usage.ts`, where a new task gets its label), and a provider passes each answer's counts to `call.used`, null where the server sends none. That includes answers it asks again and answers that end in an error, since those used tokens too. Nothing of the prompt or the answer is kept.

To try the AI features without a hosted provider, run a small model in Docker:

```bash
docker compose up -d ollama
docker compose exec ollama ollama pull qwen2.5:3b   # about 2 GB
```

Then pick Local model in Settings with the address `http://ollama:11434` (inside Docker, `localhost` is the app's own container). The Ollama image takes about 9 GB of disk, and a 3B model about 3 GB of memory while it runs; `docker compose stop ollama` when you're done.

The tests use a mock provider. To check the providers and prompts against real models, run the live tests, which are skipped otherwise:

```bash
docker compose exec -e AI_LIVE=ollama app yarn vitest run src/lib/ai/providers.live.test.ts src/lib/ai/tasks/tasks.live.test.ts
```

`AI_LIVE=mistral` checks Mistral instead, with the key saved in Settings → AI provider while Mistral is chosen there, or with `DOSSIER_AI_KEY` (and `DOSSIER_AI_MODEL`) passed with `-e`.

`AI_LIVE=anthropic` checks Anthropic in `providers.live.test.ts` the same way, with the key saved while Anthropic is chosen, or with `-e DOSSIER_AI_KEY=…` (and `DOSSIER_AI_MODEL`, by default `claude-haiku-4-5`). Besides the provider checks, it imports a profile from a short resume: the profile's schema is too large for the API's structured output, so it goes in the prompt instead (#230).

`AI_LIVE=lmstudio` checks LM Studio, with the model saved in Settings while LM Studio is chosen there, or with `-e DOSSIER_AI_MODEL=…` (and `DOSSIER_AI_URL`, by default `http://host.docker.internal:1234`). A model that isn't loaded gets loaded and stays loaded until you eject it.

## Job search

Find jobs (`/jobs`) searches the job source chosen in Settings → Job search: JSearch, Adzuna, FreeHire or the Bundesagentur für Arbeit. Until a choice is saved, `DOSSIER_JOBS_SOURCE` and the key variables decide (see `.env.example`). In the code, "job" already means a background task (`Job`, `src/lib/jobs`), so a job ad is a "posting", and job search lives in `src/lib/job-search`:

- `search.ts` and `sources.ts`: the query and posting shapes every source maps to, the URL format, and what each source covers. Shared with the browser.
- One adapter per source (`jsearch.ts`, `adzuna.ts`, `arbeitsagentur.ts`, `freehire.ts`), behind `index.ts`, which checks the country, caches answers in memory for 30 minutes and logs a source that changed or isn't answering, without the search. Failures are a `JobSearchError` with a message for the screen.
- `config.ts`: which source and key are in effect. Job source keys are encrypted like the AI key, each kind of secret under its own derived key (`src/lib/secrets.ts`). FreeHire needs no key; `DOSSIER_FREEHIRE_URL` points at a self-hosted catalogue when set.
- `src/lib/postings.ts`: the `Posting` table holds what the user saved, dismissed or started an application from. `src/lib/posting-searches.ts`: every search, kept with what it found (`PostingSearch`) until the user removes it, so opening one again asks the source nothing.

The tests use answers in each source's shape (`src/test/job-search-fixtures.ts`). The live tests check the real services, and are skipped otherwise. JSearch and Adzuna spend searches from your plan; the Arbeitsagentur and FreeHire are free:

```bash
docker compose exec -e JOBS_LIVE=jsearch -e JSEARCH_TEST_KEY=… app yarn vitest run src/lib/job-search/jsearch.live.test.ts
docker compose exec -e JOBS_LIVE=arbeitsagentur app yarn vitest run src/lib/job-search/sources.live.test.ts
docker compose exec -e JOBS_LIVE=adzuna -e ADZUNA_TEST_APP_ID=… -e ADZUNA_TEST_KEY=… app yarn vitest run src/lib/job-search/sources.live.test.ts
docker compose exec -e JOBS_LIVE=freehire app yarn vitest run src/lib/job-search/sources.live.test.ts
```

## Scoring

Score in Find jobs and the job agent score postings with what Settings → Scoring chose (`src/lib/scoring`): the AI model's `score-posting` task, or Jev, TypeSafe's System One model, with the user's TypeSafe key. Until a choice is saved, `DOSSIER_SCORER` and `DOSSIER_TYPESAFE_KEY` decide. `loadPostingScorer()` in `index.ts` sets up either one; both give a score from 0 to 100 with up to four reasons and three red flags, and `scoredWith` names what made it.

Jev answers typed questions and writes no text, so `jev.ts` asks, in one request, three Scores about the whole posting (how much of it the profile covers, how close the past work is, the level), three Nouls (a location or permit the profile can't meet, a missing language, a posting too thin to judge) and, for each line `posting-lines.ts` finds (bullets and sentences, wrapped lines joined), whether it's asked of applicants and whether the profile shows it. Code weighs the Scores (`JEV_WEIGHTS`), takes off for the mismatches and quotes the lines: "Covers: …", "Missing: …". `typesafe.ts` is the HTTP client: it retries 429 and 529 and turns failures into an `AiError` with a message for people.

The live tests ask the real Jev with the key saved in Settings → Scoring, or `DOSSIER_TYPESAFE_KEY`, and spend tokens on that account. `check` scores two postings against the demo profile; `compare` scores the job agent's latest 40 candidates again, against the profile in the database, and prints Jev's scores next to the AI model's, what was done with each posting, and the weights that would come closest to the AI model's scores. To compare on your own data, import an export of it into the development app first (Settings → Your data, which backs up what's there):

```bash
docker compose exec -e JEV_LIVE=check app yarn vitest run src/lib/scoring/jev.live.test.ts
docker compose exec -e JEV_LIVE=compare app yarn vitest run src/lib/scoring/jev.live.test.ts
```

## Your data

Settings → Your data exports everything (profile, custom themes, settings, applications with their history, documents, chat and notes, and the postings kept from Find jobs) as one JSON file, and imports such a file to restore it. An import replaces all data in one transaction, after writing a backup of the current data to `DOSSIER_DATA_DIR/backups` (default `/data`; `./data` in development, which git ignores). "Download all PDFs" zips every tailored document there too, in `downloads`, and removes the zip once it's downloaded.

With "Nightly backups" on (the default), the app writes the same export to `backups` every night at 03:00 server time and deletes backups older than `DOSSIER_BACKUP_RETENTION_DAYS` (14 by default). The timer runs inside the app process, so run a single instance of the app. These are the app's own backups: back up the PostgreSQL database itself too, the way your host does it (for example `pg_dump` on a schedule), or the SQLite file: stop the app and copy the file.

### Import size limit

Import files are capped at 10 MB, roughly 500 applications. The limit comes from Next.js, which buffers request bodies up to [`experimental.proxyClientMaxBodySize`](https://nextjs.org/docs/app/api-reference/config/next-config-js/proxyClientMaxBodySize) (10 MB by default) because `src/proxy.ts` runs on every request; larger bodies are cut off, so the app refuses them up front. To accept bigger files, raise that option in `next.config.ts` and `IMPORT_MAX_BYTES` in `src/lib/import-limits.ts`. Behind a reverse proxy, its own limit applies as well: with nginx, raise `client_max_body_size` (see [Troubleshooting](https://github.com/AienTech/dossier/wiki/Troubleshooting) in the wiki).

## Job agent

The job agent (`src/lib/agent`, the `/agent` screen and Settings → Job agent) runs one saved search a day, scores what's new and can prepare drafts:

- **`agent-scan`** (`run.ts`, defined in `jobs.ts` with the key `agent`): one run. It asks the source for the first page only, drops what Find jobs has saved, dismissed or applied for and what the agent has seen (`newPostings()`, by source and id or by `agentDedupeKey()`, a hash of the link without tracking parameters, else of company, title and place), scores the newest of the rest with the scorer Settings → Scoring chose (`src/lib/scoring`, see [Scoring](#scoring)) and keeps each as an `AgentCandidate`.
- **`agent-draft`** (`draft.ts`, keyed `agent-candidate:<id>`): one draft. The candidate is claimed (SCORED → DRAFTING → DRAFTED) so nothing makes two, and the documents are written by `createApplicationFromDocuments()` in `src/lib/application-create.ts`, which New application uses too. The draft is `origin: AGENT` with `awaitingReview` set, which keeps it off Applications, the board, the dashboard, the inbox and Find jobs until Approve.
- **Limits** (`runs.ts`): runs are recorded in the `agentRuns` setting, not as Job rows, which the task-data sweep deletes. At most 3 runs in 24 hours, Run now at most an hour after the last run, and the caps `agentMaxScores` and `agentMaxDrafts` in Settings.
- **Schedule** (`schedule.ts`): a timer in the process, like the nightly backups, that checks every 15 minutes and starts the day's run after `agentHour` in `lastKnownTimeZone()`. It only works with one instance. At startup, candidates left DRAFTING go back to SCORED.

The end-to-end spec `e2e/agent.spec.ts` runs it against the fake JSearch and the fake AI, which scores by title (`posting_score` in `e2e/fake-ai.mts`).

## Usage ping

The usage ping is opt-in. A production server asks once after sign-in (`src/app/(app)/usage-ping-dialog.tsx`, shown by the signed-in layout while nobody has answered and `DOSSIER_TELEMETRY` isn't set) and sends nothing before a yes. After one, on each day someone signed in opens a page, it sends `https://telemetry.dossier.aien.me/ping` the install's random ID and the version, once (`src/lib/usage-ping.ts`, called with `after()` from the signed-in layout). `DOSSIER_TELEMETRY=on` or `off` answers in advance and wins while it's set.

The answer, when it was given and the version of the question's text are the settings `usagePingChoice`, `usagePingChoiceAt` and `usagePingChoiceText`; the ID and the day of the last ping are `usagePingId` and `usagePingDay`. Exports leave them all out and imports keep them (`INSTALL_SETTINGS` in `src/lib/data-export.ts`). A no deletes the ID. When the question's text changes, raise `USAGE_PING_TEXT_VERSION`, and everyone is asked again. Development servers and tests never ask or send it (`NODE_ENV` isn't `production`). The end-to-end run is a production build: `resetData()` answers no, `e2e/usage-ping.spec.ts` asks, and a yes goes to the fake job sources (`DOSSIER_USAGE_PING_TEST_URL`), never the project.

The receiving end is a small service on the project's own server that isn't published with the app. Change what the ping sends only together with it, the wiki's [Privacy](https://github.com/AienTech/dossier/wiki/Privacy) page and Settings → About.

## Announcements

The project can publish short notices, such as a security fix, and each page shows them in a card over the page (`src/app/(app)/announcement-notice.tsx`), one at a time, until they're dismissed. The sidebar's notice is for updates only. The signed-in layout starts the check after a page load, using the settings it read anyway, so a page costs nothing until a check is due (`src/lib/announcements/check.ts`). When to ask next comes from the answer's `Cache-Control`, between 1 hour and 7 days.

- **The request carries nothing about the install,** only `User-Agent: Dossier`. Which notices apply (version range, expiry, dismissed) is decided on the install (`src/lib/announcements/visible.ts`).
- **A failure changes nothing:** the last good answer stays, and nothing is shown or logged.
- **Notices are plain text,** with one optional link, which can go anywhere on the web. Anything but `http` or `https` is dropped, because the link becomes an `href`. This is not a channel for advertising.

The answer and the dismissed IDs are the settings `announcementFeed` and `announcementsDismissed`, which exports leave out and imports keep (`INSTALL_SETTINGS` in `src/lib/data-export.ts`).

The backend is the project's own service and isn't published with the app. `src/lib/announcements/api-v1.schema.json` is a copy of its contract, and a test compares it with what the app reads, so update the copy when the contract grows. The API only grows, so the app ignores what it doesn't know.

A production server asks `https://api.dossier.aien.me/v1`. A development server only asks while `DOSSIER_API_URL` is set, and then on every page, so a change shows without the wait: the first reload asks, and the next one shows it. To try it against a local copy of the backend, set that variable, for example in an untracked `compose.override.yml`. The variable isn't in `.env.example` or `compose.production.yml`, because nobody running the image needs it. `e2e/announcements.spec.ts` points it at the fake job sources.
## The desktop app

`desktop/` is the app for Linux and Windows, built with Electron. One download, two modes, chosen on first launch: **On my server** opens the user's own Dossier in a window, and **On this computer** runs Dossier itself. There's no auto-update: people download each new version from the release page.

It has its own `package.json` and `yarn.lock`, so the image doesn't carry Electron.

The window has no title bar or menu row of the system's. `desktop/bar/` is the app's own top bar, with the system's window buttons drawn over it, and the page is a view below it, so no server version has to know about the bar. The bar takes its colours from the page's `body` (`bar-colors.ts`), read again when the page loads and when the `dossier_theme` cookie changes.

On this computer runs the same standalone server as the image, on a plain Node binary that ships inside the app, and on SQLite in the user's app folder. So nothing native is built for Electron, and an Electron update, which is how Chromium's security fixes arrive, can't be held back by it. `desktop/scripts/prepare-server.mjs` puts it together for one platform, checking every download against a pinned hash, and the app's own Chromium prints the PDFs (`print-service.ts`, `src/lib/pdf/desktop-print.ts`). The server listens on 127.0.0.1 only. The app makes a secret on first launch and a token at each launch, and signs itself in with the token (`src/lib/desktop.ts`): there's no password, but the sign-in page stays, so other programs reaching the port get nowhere.

Migrations run without Prisma's tools (`server-tools/migrate.mjs`) and **not in a transaction**, because SQLite ignores the files' `PRAGMA foreign_keys=OFF` inside one, and rebuilding a table would then delete the rows that point at it. It copies the database first, and refuses a database from a newer version.

A view showing a server has no preload and is treated as any web page: other sites and mail go to the system browser (`window-rules.ts`), and the page may ask for nothing but writing to the clipboard, for the app's Copy buttons. Only the app's own start screen and bar get the small APIs in `preload.ts` and `bar-preload.ts`.

## Tests and checks

Tests use [Vitest](https://vitest.dev) and run inside the container like everything else:

```bash
docker/bin/yarn test          # run all tests once
docker/bin/yarn test:watch    # re-run tests on change
docker/bin/yarn test:coverage # run once with coverage (report in coverage/index.html)
docker/bin/yarn lint
docker/bin/yarn typecheck     # generates Next.js route types, then runs tsc
```

Put tests next to the code they cover. `*.test.ts` files run in Node (server code, pure logic);
`*.test.tsx` files run in jsdom with [Testing Library](https://testing-library.com) and its `jest-dom` matchers (components and hooks).
`*.db.test.ts` files run against a real Postgres database: `dossier_test` on the same server (or `TEST_DATABASE_URL`), which is created and migrated at the start of each run, and which each test empties with `resetDatabase()` from `src/test/db.ts`.
They refuse to run against a database whose name doesn't end in `_test`, so your development data is never touched.
With an SQLite `DATABASE_URL`, they run against the file next to it with `_test` added to its name (`file:/app/data/dev_test.db`).

GitHub Actions (`.github/workflows/ci.yml`) runs lint, type-check and tests with coverage, with a Postgres service for the database tests (then runs those again on SQLite), on release branches (`release/1.12.0`), when one is pushed and on each push after that, and shows the coverage in the job summary. A newer push to the same branch cancels the run it replaces. Nothing else runs them: pull requests aren't checked, so run the checks yourself before you open one. The public repository has no release branches: `image.yml` runs the same jobs there after each merge or publish to `main`, before it builds the image. The coverage thresholds in `vitest.config.mts` ratchet: they sit a few points below the coverage when they were set, and CI fails if coverage drops below them. Raise them when you add tests.

### End-to-end tests

[Playwright](https://playwright.dev) tests in `e2e/` click through the main flows in headless Chromium: signing in, the profile, the theme builder and PDFs, finding a job and applying from it, a new application, refining and undoing, the application email, the board and table, the dashboard, and export, delete and import. `e2e/accessibility.spec.ts` runs [axe](https://github.com/dequelabs/axe-core) on every screen and its open menus and dialogs (no serious or critical WCAG 2.2 AA violations allowed) and checks where keyboard focus goes. They run against a production build, on the standalone server the image uses, so build first:

```bash
docker/bin/yarn build && docker/bin/yarn test:e2e
```

The run starts its own server on port 3100 with a separate `dossier_e2e` database (created and migrated on the way, reset to the demo data before the specs that change data), a fake OpenAI-compatible server on port 3999 (`e2e/fake-ai.mts`) that answers each AI task with plausible output, fake job sources on port 3998 (`e2e/fake-jobs.mts`), which the app reaches through `DOSSIER_JOBS_TEST_BASE_URL`, a variable for the tests only, and a fake Google on port 3997 (`e2e/fake-google.mts`) for sign-in, Gmail and Calendar (`DOSSIER_GOOGLE_TEST_BASE_URL`), which only comes into play once a spec enters an OAuth client in Settings → Google. The daily update check asks the same fake instead of GitHub (`DOSSIER_UPDATES_TEST_BASE_URL`), which says no release is out, so a spec can store the latest release itself, and so does Jev (`DOSSIER_TYPESAFE_TEST_BASE_URL`), with answers made from the questions. The same fake answers for the project's backend (`DOSSIER_API_URL`), with no notices until a spec says otherwise. Your development server and data are never touched: the tests refuse any database whose name doesn't end in `_e2e`. CI runs them in a job of their own and keeps the report of a failed run as an artifact.

## The production image

The `Dockerfile`'s last stage is the production image (the `dev` stage is what Compose runs here). It holds the standalone Next.js server, Playwright's Chromium for PDFs, and Prisma's CLI for migrations, runs as `node`, and starts with `docker/start.sh`: `prisma migrate deploy`, the seed (compiled with esbuild at build time), then the server. To build and try it next to the development stack:

```bash
docker build -t dossier:local .
DOSSIER_IMAGE=dossier:local DOSSIER_PORT=3300 docker compose -f compose.production.yml -p dossier-local up -d
```

In the public repository, `image.yml` pushes an image for every commit on `main` to `ghcr.io/<owner>/<repository>:<sha>` (lower case), once the checks and the end-to-end tests pass. A version tag (`v1.0.0`) then tags that commit's image with the version and `latest`.

## The website

`site/` is the project's website, plain HTML, CSS and a little JavaScript. `site/build.sh` puts it together in `_site/` with the README's screenshots (`.github/images/`), the app's icons and three of its fonts, so there's one copy of each. To look at it, serve `_site/` with any static server, for example `docker run --rm -p 8080:80 -v "$PWD/_site:/usr/share/nginx/html:ro" nginx:alpine`, then open http://localhost:8080. The public repository's Pages workflow publishes it when any of those change on `main`, and once a day. When the README's screenshots change, the site's change with them.

The number above the hero's buttons is the Docker image's download count. GitHub's API has no download counts for `ghcr.io`, so `build.sh` reads it from the package page (the `title` of the number under "Total downloads") and writes it into `_site/index.html`, rounded down. The daily run keeps it current. If the page can't be read (you're offline, or GitHub changed its markup), the build prints a warning and keeps the floor written in `site/index.html`. Raise that floor now and then, and update the `sed` in `build.sh` if the warning keeps coming.

## Reset

```bash
docker compose down -v   # stops everything and deletes the database and node_modules volumes
```
