import { EventEmitter } from "node:events";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
vi.mock("node:fs/promises", () => ({
  mkdtemp: vi.fn(async () => "/tmp/dossier-codex-test"),
  readFile: vi.fn(async () => "A polished answer."),
  rm: vi.fn(async () => undefined),
}));

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";

import type { UsageEntry } from "@/lib/usage";

import { AntigravityProvider, ANTIGRAVITY_FALLBACK_MODELS } from "./antigravity";
import { runCommand } from "./cli";
import { CodexProvider } from "./codex";

afterEach(() => vi.unstubAllGlobals());

const ask = { task: "connection-check" as const, system: "Be brief.", messages: [{ role: "user" as const, content: "Hi" }] };

/** A child process that says whatever a test tells it to. */
class FakeChild extends EventEmitter {
  readonly stdout = Object.assign(new EventEmitter(), { setEncoding: () => undefined });
  readonly stderr = Object.assign(new EventEmitter(), { setEncoding: () => undefined });
  readonly stdin = { on: () => undefined, end: vi.fn() };
  args: string[] = [];
  command = "";
  readonly killSignals: string[] = [];
  kill = (signal: string) => {
    this.killSignals.push(signal);
    return true;
  };
  /** Answers after the provider has attached its listeners, as a real child would. */
  answer(stdout = "", stderr = "", code: number | null = 0, killedBy: NodeJS.Signals | null = null) {
    queueMicrotask(() => {
      if (stdout) this.stdout.emit("data", stdout);
      if (stderr) this.stderr.emit("data", stderr);
      this.emit("close", code, killedBy);
    });
    return this;
  }
}

/** Makes `spawn` return `child`, remembering how it was asked for. */
function run(child: FakeChild) {
  vi.mocked(spawn).mockImplementation(((command: string, args: string[]) => {
    child.command = command;
    child.args = args;
    return child as unknown as ReturnType<typeof spawn>;
  }) as never);
  return child;
}

beforeEach(() => vi.mocked(spawn).mockReset());

const envelope = (body: Record<string, unknown>) => JSON.stringify({ conversation_id: "c1", duration_seconds: 1, num_turns: 1, ...body });

describe("runCommand", () => {
  it("runs the tool, sending the prompt on stdin and collecting both streams", async () => {
    const child = run(new FakeChild());
    const pending = runCommand({ command: "agy", args: ["-p", "x"], input: "the prompt", signal: new AbortController().signal });
    child.answer("answer", "progress");
    expect(await pending).toEqual({ stdout: "answer", stderr: "progress", code: 0, killedBy: null });
    expect(child.stdin.end).toHaveBeenCalledWith("the prompt");
    expect(spawn).toHaveBeenCalledWith("agy", ["-p", "x"], expect.objectContaining({ stdio: ["pipe", "pipe", "pipe"] }));
  });

  it("stops the tool on SIGTERM when the caller cancels", async () => {
    const child = run(new FakeChild());
    const controller = new AbortController();
    const pending = runCommand({ command: "codex", args: [], signal: controller.signal });
    controller.abort();
    child.answer("", "", null, "SIGTERM");
    await pending;
    expect(child.killSignals).toEqual(["SIGTERM"]);
  });

  it("says the tool isn't installed when it can't be started", async () => {
    const child = run(new FakeChild());
    const pending = runCommand({ command: "nope", args: [], signal: new AbortController().signal });
    child.emit("error", Object.assign(new Error("spawn nope ENOENT"), { code: "ENOENT" }));
    await expect(pending).rejects.toMatchObject({ kind: "config", message: expect.stringContaining("isn't installed") });
  });
});

describe("AntigravityProvider", () => {
  it("reads the JSON envelope, with the answer and the tokens", async () => {
    const child = run(new FakeChild());
    const usage: UsageEntry[] = [];
    const pending = new AntigravityProvider("gemini-4-argon-high", 60_000, (entry) => void usage.push(entry)).complete({ ...ask, task: "write-email" });
    child.answer(envelope({ status: "SUCCESS", response: "Hello!", usage: { input_tokens: 120, output_tokens: 8 } }));
    expect(await pending).toBe("Hello!");
    expect(child.command).toBe("agy");
    expect(child.args).toEqual(["-p", "Be brief.\n\nUser: Hi", "--output-format", "json", "--model", "gemini-4-argon-high"]);
    expect(usage).toEqual([{ task: "write-email", provider: "ANTIGRAVITY", model: "gemini-4-argon-high", input: 120, output: 8 }]);
  });

  it("pins the effort, and holds the answer to a schema the tool enforces itself", async () => {
    const Person = z.object({ name: z.string() });
    const child = run(new FakeChild());
    const pending = new AntigravityProvider("gemini-4-argon-high", 60_000).complete({ ...ask, schema: Person, effort: "low" });
    child.answer(envelope({ status: "SUCCESS", structured_output: { name: "Jane" }, response: '{"name":"Jane"}' }));
    expect(await pending).toEqual({ name: "Jane" });
    expect(child.args).toContain("--effort");
    expect(child.args).toContain("low");
    const schemaAt = child.args.indexOf("--json-schema");
    expect(schemaAt).toBeGreaterThan(-1);
    expect(JSON.parse(child.args[schemaAt + 1])).toMatchObject({ type: "object", required: ["name"] });
  });

  it("says when the tool isn't signed in, or doesn't know the model", async () => {
    const signedOut = run(new FakeChild());
    const pending = new AntigravityProvider("gemini-4-argon-high", 60_000).complete(ask);
    signedOut.answer(envelope({ status: "ERROR", error: "authentication required" }));
    await expect(pending).rejects.toMatchObject({ kind: "config", message: expect.stringContaining("isn't signed in") });

    const unknownModel = run(new FakeChild());
    const second = new AntigravityProvider("nope", 60_000).complete(ask);
    unknownModel.answer(envelope({ status: "ERROR", error: "model nope is not recognized" }));
    await expect(second).rejects.toMatchObject({ kind: "model" });
  });

  it("lists the models `agy models` prints, else the known ones", async () => {
    const child = run(new FakeChild());
    const pending = new AntigravityProvider(null, 60_000).listModels();
    child.answer("gemini-4-argon-high   Gemini 4 Argon (High)\ngemini-3.8-flash-medium   Gemini 3.8 Flash (Medium)");
    expect(await pending).toEqual(["gemini-3.8-flash-medium", "gemini-4-argon-high"]);

    const failing = run(new FakeChild());
    const fallback = new AntigravityProvider(null, 60_000).listModels();
    failing.answer("", "boom", 1);
    expect(await fallback).toEqual(ANTIGRAVITY_FALLBACK_MODELS);
  });
});

describe("CodexProvider", () => {
  it("runs `codex exec` read-only, taking the prompt on stdin and the answer from -o", async () => {
    const child = run(new FakeChild());
    vi.mocked(readFile).mockResolvedValue("A polished answer.");
    const pending = new CodexProvider("gpt-6-luna", 60_000).complete({ ...ask, task: "write-cover-letter" });
    child.answer("progress lines");
    expect(await pending).toBe("A polished answer.");
    expect(child.command).toBe("codex");
    expect(child.args).toEqual([
      "exec",
      "--skip-git-repo-check",
      "--sandbox",
      "read-only",
      "-c",
      "cli_auth_credentials_store=file",
      "--output-last-message",
      "/tmp/dossier-codex-test/answer.txt",
      "--model",
      "gpt-6-luna",
      "-",
    ]);
    expect(child.stdin.end).toHaveBeenCalledWith("Be brief.\n\nUser: Hi");
    expect(readFile).toHaveBeenCalledWith("/tmp/dossier-codex-test/answer.txt", "utf8");
  });

  it("puts a schema in the prompt, since Codex has no schema flag", async () => {
    const Person = z.object({ name: z.string() });
    const child = run(new FakeChild());
    vi.mocked(readFile).mockResolvedValue('{"name":"Jane"}');
    const pending = new CodexProvider("gpt-6-luna", 60_000).complete({ ...ask, schema: Person });
    child.answer("");
    expect(await pending).toEqual({ name: "Jane" });
    expect(child.stdin.end).toHaveBeenCalledWith(expect.stringContaining("matches this JSON schema"));
  });

  it("says when the tool isn't signed in", async () => {
    const child = run(new FakeChild());
    const pending = new CodexProvider("gpt-6-luna", 60_000).complete(ask);
    child.answer("", "Not logged in. Run codex login.", 1);
    await expect(pending).rejects.toMatchObject({ kind: "config", message: expect.stringContaining("isn't signed in") });
  });

  it("offers the known models, since Codex prints no list", async () => {
    expect(await new CodexProvider(null, 60_000).listModels()).toEqual([
      "gpt-6-luna",
      "gpt-6.1-terra",
      "gpt-6.1-sol",
      "gpt-6-sol",
      "gpt-6-astra",
      "gpt-5.6-luna",
      "gpt-5.6-terra",
      "gpt-5.6-sol",
    ]);
  });
});
