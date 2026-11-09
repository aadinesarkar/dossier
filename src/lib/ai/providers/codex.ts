import "server-only";

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { UsageSink } from "@/lib/usage";

import { withJsonSchema, type ChatCall } from "../provider";
import { cliFailure, CliProvider } from "./cli";

/**
 * Models offered in the select before anyone types one: Codex's own list, the
 * newest Luna first. Codex has no command that lists them; "Other model…"
 * takes any the account has.
 */
export const CODEX_FALLBACK_MODELS = [
  "gpt-6-luna",
  "gpt-6.1-terra",
  "gpt-6.1-sol",
  "gpt-6-sol",
  "gpt-6-astra",
  "gpt-5.6-luna",
  "gpt-5.6-terra",
  "gpt-5.6-sol",
];

/**
 * OpenAI's Codex CLI, signed in with a ChatGPT account on the server. `codex
 * exec` runs one prompt without the terminal UI; `-o` writes just the answer,
 * which keeps it clear of the progress lines it prints along the way.
 */
export class CodexProvider extends CliProvider {
  readonly kind = "CODEX" as const;

  constructor(model: string | null, timeoutMs: number, onUsage?: UsageSink) {
    super("codex", model, timeoutMs, onUsage);
  }

  protected async ask(call: ChatCall, signal: AbortSignal) {
    // Codex has no schema flag: the schema goes in the prompt, and
    // BaseProvider asks again when the answer doesn't fit it.
    const prompt = call.json ? withJsonSchema(this.prompt(call), call.json.schema) : this.prompt(call);
    const dir = await mkdtemp(join(tmpdir(), "dossier-codex-"));
    const answerPath = join(dir, "answer.txt");
    try {
      // `-c` names the same credential file the sign-in wrote, so `exec` and
      // `login` can't disagree about where the token is.
      const args = ["exec", "--skip-git-repo-check", "--sandbox", "read-only", "-c", "cli_auth_credentials_store=file", "--output-last-message", answerPath];
      if (call.model) args.push("--model", call.model);
      // `-` takes the prompt from stdin, so a long posting never meets the argument limit.
      args.push("-");
      const output = await this.run(args, signal, prompt);
      if (output.code !== 0) throw cliFailure(this.command, call.model, output);
      const text = await readFile(answerPath, "utf8").catch(() => "");
      // `-o` is the clean answer; stdout is a fallback for a build that didn't write it.
      return { text: text.trim() ? text : output.stdout };
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /** Codex prints no model list, so the known names are offered and any other can be typed. */
  protected async fetchModels(): Promise<string[]> {
    return CODEX_FALLBACK_MODELS;
  }
}
