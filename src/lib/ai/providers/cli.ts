import "server-only";

import { spawn } from "node:child_process";

import type { UsageSink } from "@/lib/usage";

import { AiError } from "../errors";
import { BaseProvider, type ChatAnswer, type ChatCall } from "../provider";

// A model reached through a command-line agent on the server instead of an
// HTTP API: `codex` (OpenAI Codex CLI) or `agy` (Google's Antigravity CLI).
// Both sign in with an account on the server, so Dossier needs no API key for
// them. Each has a headless mode that prints the answer to stdout, which is
// what these providers run.

/** What one run of a CLI got back. */
export type CliOutput = {
  stdout: string;
  stderr: string;
  /** The exit code, or null when a signal ended it. */
  code: number | null;
  killedBy: NodeJS.Signals | null;
};

/** One run asked for. */
export type CliRun = {
  /** The binary, looked up on the server's PATH. */
  command: string;
  args: string[];
  /** Written to stdin, so a long prompt never meets the argument limit. */
  input?: string;
  signal: AbortSignal;
};

/**
 * Runs `command` to completion, and kills it when `signal` aborts: first with
 * SIGTERM, then SIGKILL if it lingers. No shell is used, and the prompt goes
 * on stdin, so neither the arguments nor anything in the prompt are shell
 * words. Rejects with an `AiError` when the binary isn't there at all.
 */
export function runCommand({ command, args, input, signal }: CliRun): Promise<CliOutput> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      reject(notInstalled(command, error));
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    let stopping = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      signal.removeEventListener("abort", onAbort);
      if (killTimer) clearTimeout(killTimer);
    };
    const onAbort = () => {
      if (stopping) return;
      stopping = true;
      child.kill("SIGTERM");
      // A CLI that ignores SIGTERM gets one more chance.
      killTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
      killTimer.unref?.();
    };

    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(notInstalled(command, error));
    });
    child.on("close", (code, killedBy) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ stdout, stderr, code, killedBy });
    });

    // The prompt goes on stdin; a CLI that exits early needn't be complained at.
    if (child.stdin) {
      child.stdin.on("error", () => {
        // The process may close before reading the prompt.
      });
      child.stdin.end(input ?? "");
    }
  });
}

/** An `ENOENT` means the binary isn't installed, which is a setup problem, not a model one. */
function notInstalled(command: string, error: unknown): unknown {
  if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
    return AiError.config(
      `\`${command}\` isn't installed on the server, or isn't on its PATH. Install it and sign in there, or pick another AI provider in Settings.`,
    );
  }
  return error;
}

/** The words a CLI used about a failure, from both streams, never the prompt. */
export function said(output: CliOutput): string {
  return `${output.stderr}\n${output.stdout}`.trim();
}

/**
 * Turns a failed run into an `AiError`, reading only what the CLI said. A
 * caller that passed `signal` gets a plain error so `BaseProvider` can tell
 * a cancellation or a timeout from a real failure.
 */
export function cliFailure(command: string, signIn: string, model: string, output: CliOutput): AiError {
  const message = said(output);
  const detail = `${command} ${output.code ?? output.killedBy ?? "failed"}`;
  if (/auth|sign in|logged in|login|credential|unauthenticated|401/i.test(message)) {
    return AiError.config(`\`${command}\` isn't signed in on the server. Run \`${signIn}\` there once, then try again.`);
  }
  if (/unknown model|invalid model|not recognized as a known model|model .*not found|no such model/i.test(message)) {
    return AiError.unknownModel(model, detail);
  }
  if (/rate.?limit|too many requests|quota/i.test(message)) return AiError.of("rate-limited", detail);
  if (/timed? ?out|timeout/i.test(message)) return AiError.of("timeout", detail);
  if (/too long|context length|maximum.*token|token limit|exceeds/i.test(message)) return AiError.of("too-long", detail);
  if (/not found|no such file|command not found|ENOENT/i.test(message)) {
    return AiError.config(
      `\`${command}\` isn't installed on the server, or isn't on its PATH. Install it and sign in there, or pick another AI provider in Settings.`,
    );
  }
  return AiError.of("provider", detail);
}

/** A model behind a command-line agent: one answer per run, in the tool's headless mode. */
export abstract class CliProvider extends BaseProvider {
  constructor(
    /** The binary, from the server's PATH. */
    protected readonly command: string,
    /** What signs the tool in on the server, named in the error when it isn't. */
    protected readonly signIn: string,
    model: string | null,
    timeoutMs: number,
    onUsage?: UsageSink,
  ) {
    super(model, timeoutMs, onUsage);
  }

  /** The single prompt a headless run gets: the instructions, then the conversation. */
  protected prompt(call: ChatCall): string {
    const turns = call.messages.map((message) => `${message.role === "user" ? "User" : "Assistant"}: ${message.content}`);
    return [call.system, ...turns].filter(Boolean).join("\n\n");
  }

  /** Runs the tool once, returning its answer and, when it says, the tokens it used. */
  protected abstract ask(call: ChatCall, signal: AbortSignal): Promise<{ text: string; cutOff?: boolean; usage?: { input: number | null; output: number | null } }>;

  protected async chat(call: ChatCall): Promise<ChatAnswer> {
    const answer = await this.ask(call, call.signal);
    if (answer.usage) call.used(answer.usage);
    return { text: answer.text, cutOff: answer.cutOff ?? false };
  }

  /** Runs the tool for `args`; a run stopped by `signal` is left for `BaseProvider` to explain. */
  protected async run(args: string[], signal: AbortSignal, input?: string): Promise<CliOutput> {
    const output = await runCommand({ command: this.command, args, signal, input });
    if (signal.aborted) throw new Error(`\`${this.command}\` was stopped.`);
    return output;
  }
}
