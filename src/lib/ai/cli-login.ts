import "server-only";

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Signing in to a command-line AI tool from the web UI (E21-2, Settings → AI
// provider): the tool runs on the server and does the OAuth dance itself, so
// the user never opens a terminal.
//
// Codex has `codex login --device-auth`: it prints a page and a one-time code,
// then polls until the user enters the code there, and writes its own
// `~/.codex/auth.json` when done.
//
// Antigravity has no login command, but `agy -p` in headless mode prints a
// Google sign-in page and takes the authorization code on stdin. It keeps
// that prompt open for a minute, so the panel counts down and offers a retry.
//
// Each sign-in is a process kept in memory between the Server Actions that
// start it, poll it and hand it the code. Dossier is self-hosted, so this is
// one server process, as with the job runner.

export type CliProvider = "CODEX" | "ANTIGRAVITY";

/** A sign-in that couldn't start, in words the panel shows as they are. */
export class CliLoginError extends Error {
  override name = "CliLoginError";
}

/** What the panel needs to show the user about a sign-in that has started. */
export type CliLoginView = {
  id: string;
  provider: CliProvider;
  /** Where to sign in. */
  url: string;
  /** The one-time code to enter there, for Codex; null when the tool asks for a code back. */
  code: string | null;
  /** What to do next, in words. */
  note: string;
  /** How long the code prompt stays open, when that's short (Antigravity). */
  expiresInSeconds: number | null;
};

export type CliLoginState = { state: "pending" | "done" | "failed"; message?: string };

/** How long a sign-in may sit waiting before it's forgotten. */
const SESSION_TTL_MS = 20 * 60_000;
/** How long to wait for the tool to print its sign-in page. */
const URL_WAIT_MS = 20_000;
/** Antigravity's own wait for the authorization code, from its headless mode. */
const CODE_WAIT_MS = 60_000;

type Session = {
  id: string;
  provider: CliProvider;
  child: ChildProcess;
  view: CliLoginView | null;
  state: CliLoginState;
  output: string;
  startedAt: number;
  deadline: number | null;
};

const sessions = new Map<string, Session>();

/** Where each tool keeps its credentials, so a signed-in server can be seen. */
export function cliAuthPath(provider: CliProvider): string {
  if (provider === "CODEX") return join(process.env.CODEX_HOME || join(homedir(), ".codex"), "auth.json");
  return join(homedir(), ".gemini", "antigravity-cli", "antigravity-oauth-token");
}

/** Whether the tool already has credentials on this server. */
export function isCliSignedIn(provider: CliProvider): boolean {
  return existsSync(cliAuthPath(provider));
}

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

/** The tool's output with its terminal colours taken out. */
export function plainOutput(text: string): string {
  return text.replace(ANSI, "");
}

/** The page and one-time code from `codex login --device-auth`. */
export function codexFields(text: string): { url: string | null; code: string | null } {
  const clean = plainOutput(text);
  return {
    url: /https:\/\/[^\s"'<>]+\/codex\/device/.exec(clean)?.[0] ?? null,
    code: /\b([A-Z0-9]{4,}-[A-Z0-9]{4,})\b/.exec(clean)?.[1] ?? null,
  };
}

/** The Google sign-in page `agy` prints in headless mode. */
export function antigravityUrl(text: string): string | null {
  const match = /https:\/\/accounts\.google\.com\/[^\s"'<>]+/.exec(plainOutput(text))?.[0];
  return match ? match.replace(/[.,;:)\]}]+$/, "") : null;
}

function notInstalled(provider: CliProvider): string {
  return provider === "CODEX"
    ? "The `codex` command isn't installed on this server, or isn't on its PATH. Install OpenAI's Codex CLI there, then try again."
    : "The `agy` command isn't installed on this server, or isn't on its PATH. Install Google's Antigravity CLI there, then try again.";
}

/** Starts the tool's sign-in and returns once it has printed where to go. */
export async function startCliLogin(provider: CliProvider): Promise<CliLoginView> {
  sweep();
  // One sign-in at a time per tool, so an old panel doesn't keep a process.
  for (const [id, session] of sessions) {
    if (session.provider === provider) {
      stop(session);
      sessions.delete(id);
    }
  }

  const session: Session = {
    id: randomUUID(),
    provider,
    child: null as unknown as ChildProcess,
    view: null,
    state: { state: "pending" },
    output: "",
    startedAt: Date.now(),
    deadline: null,
  };
  session.child = spawnTool(session);
  sessions.set(session.id, session);
  wire(session);

  const view = await waitForView(session, URL_WAIT_MS);
  if (!view) {
    const message =
      session.state.state === "done" && isCliSignedIn(provider)
        ? "This server is already signed in to that account."
        : failureMessage(session);
    stop(session);
    sessions.delete(session.id);
    throw new CliLoginError(message);
  }
  return view;
}

/** How the sign-in is doing, asked every couple of seconds by the panel. */
export function cliLoginStatus(id: string): CliLoginState {
  const session = sessions.get(id);
  if (!session) return { state: "failed", message: "This sign-in has ended. Start again." };
  if (session.state.state === "pending" && session.deadline !== null && Date.now() > session.deadline) {
    session.state = { state: "failed", message: "The sign-in link expired. Start again, and paste the code within a minute." };
    stop(session);
  }
  return session.state;
}

/** Hands the authorization code back to `agy`, which is waiting for it. */
export function cliLoginSubmitCode(id: string, code: string): CliLoginState {
  const session = sessions.get(id);
  if (!session) return { state: "failed", message: "This sign-in has ended. Start again." };
  if (session.provider !== "ANTIGRAVITY") return { state: "failed", message: "This sign-in doesn't take a code here." };
  if (session.state.state !== "pending") return session.state;
  if (session.deadline !== null && Date.now() > session.deadline) {
    session.state = { state: "failed", message: "The sign-in link expired. Start again, and paste the code within a minute." };
    stop(session);
    return session.state;
  }
  // The code is in: the tool may take its time finishing now.
  session.deadline = null;
  session.child.stdin?.write(`${code.trim()}\n`);
  return session.state;
}

/** Stops a sign-in the user left. */
export function cancelCliLogin(id: string): void {
  const session = sessions.get(id);
  if (!session) return;
  stop(session);
  sessions.delete(id);
}

function spawnTool(session: Session): ChildProcess {
  if (session.provider === "CODEX") {
    return spawn("codex", ["login", "--device-auth"], { stdio: ["ignore", "pipe", "pipe"] });
  }
  // SSH variables make `agy` store its token in a file rather than a keyring
  // it can't reach here (which would fail silently).
  return spawn("agy", ["-p", "Reply with the single word OK."], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, SSH_CONNECTION: "dossier", SSH_CLIENT: "dossier", SSH_TTY: "dossier" },
  });
}

function wire(session: Session): void {
  const onData = (chunk: Buffer | string) => {
    session.output += chunk.toString();
    if (session.view) return;
    const view = readView(session);
    if (!view) return;
    session.view = view;
    // A few seconds of grace, so a code sent just before the limit isn't cut
    // off by the status check racing the submit.
    if (session.provider === "ANTIGRAVITY") session.deadline = Date.now() + CODE_WAIT_MS + 5_000;
  };
  session.child.stdout?.on("data", onData);
  session.child.stderr?.on("data", onData);
  session.child.on("error", (error: NodeJS.ErrnoException) => {
    session.state = {
      state: "failed",
      message: error.code === "ENOENT" ? notInstalled(session.provider) : "The sign-in tool couldn't start on this server.",
    };
  });
  session.child.on("close", (code) => {
    if (session.state.state === "failed") return;
    session.state =
      code === 0 || isCliSignedIn(session.provider)
        ? { state: "done" }
        : { state: "failed", message: failureMessage(session) };
  });
}

function readView(session: Session): CliLoginView | null {
  if (session.provider === "CODEX") {
    const { url, code } = codexFields(session.output);
    if (!url || !code) return null;
    return {
      id: session.id,
      provider: "CODEX",
      url,
      code,
      note: "Enter the code on OpenAI's page and approve. This panel notices when it's done.",
      expiresInSeconds: null,
    };
  }
  const url = antigravityUrl(session.output);
  if (!url) return null;
  return {
    id: session.id,
    provider: "ANTIGRAVITY",
    url,
    code: null,
    note: "Sign in with Google, then paste the code it shows you back here.",
    expiresInSeconds: Math.round(CODE_WAIT_MS / 1000),
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForView(session: Session, timeoutMs: number): Promise<CliLoginView | null> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (session.view) return session.view;
    if (session.state.state !== "pending") return null;
    await sleep(50);
  }
  return null;
}

/** A failure in words people can act on, never the tool's raw output. */
function failureMessage(session: Session): string {
  if (session.state.state === "failed" && session.state.message) return session.state.message;
  const said = plainOutput(session.output);
  if (/device code login is not enabled/i.test(said)) return "This Codex server doesn't allow device sign-in. Pick another AI provider, or try again later.";
  if (/not logged in|sign in|authentication|auth required/i.test(said)) return "The sign-in didn't complete. Start again.";
  if (/approval|permission|sandbox/i.test(said)) return "The tool needed a permission it couldn't get. Start again.";
  return "The sign-in didn't start. Check that the tool is installed on this server, then try again.";
}

function stop(session: Session): void {
  if (session.child.killed) return;
  session.child.kill("SIGTERM");
  const timer = setTimeout(() => session.child.kill("SIGKILL"), 2_000);
  timer.unref?.();
}

/** Forgets sign-ins left open too long, so their processes don't linger. */
function sweep(): void {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.startedAt <= SESSION_TTL_MS) continue;
    stop(session);
    sessions.delete(id);
  }
}
