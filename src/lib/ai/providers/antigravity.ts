import "server-only";

import { z } from "zod";

import type { UsageSink } from "@/lib/usage";

import { AiError } from "../errors";
import type { ChatCall } from "../provider";
import { cliFailure, CliProvider, type CliOutput } from "./cli";

/** The model slugs `agy models` lists, offered before anyone runs it. */
export const ANTIGRAVITY_FALLBACK_MODELS = [
  "gemini-4-argon-high",
  "gemini-4-argon-medium",
  "gemini-3.8-flash-high",
  "gemini-3.8-flash-medium",
];

/** What `agy --output-format json` prints at the end of a run. */
const ENVELOPE = z.object({
  status: z.string(),
  response: z.string().optional(),
  error: z.string().optional(),
  structured_output: z.unknown().optional(),
  usage: z
    .object({
      input_tokens: z.number().optional(),
      output_tokens: z.number().optional(),
    })
    .optional(),
});

/** Google's Antigravity CLI (`agy`), signed in with a Google account on the server. */
export class AntigravityProvider extends CliProvider {
  readonly kind = "ANTIGRAVITY" as const;

  constructor(model: string | null, timeoutMs: number, onUsage?: UsageSink) {
    super("agy", model, timeoutMs, onUsage);
  }

  protected async ask(call: ChatCall, signal: AbortSignal) {
    const args = ["-p", this.prompt(call), "--output-format", "json"];
    if (call.model) args.push("--model", call.model);
    if (call.effort) args.push("--effort", call.effort);
    // The CLI can hold the answer to a schema itself, so it isn't asked in words too.
    if (call.json) args.push("--json-schema", JSON.stringify(z.toJSONSchema(call.json.schema)));
    return this.answer(call.model, await this.run(args, signal));
  }

  /** Reads the JSON envelope; a run without one is explained from what the tool said. */
  private answer(model: string, output: CliOutput) {
    const envelope = parseEnvelope(output.stdout);
    if (!envelope) throw cliFailure(this.command, model, output);
    if (envelope.status === "SUCCESS") {
      const text =
        envelope.structured_output !== undefined ? JSON.stringify(envelope.structured_output) : (envelope.response ?? "");
      return {
        text,
        usage: { input: envelope.usage?.input_tokens ?? null, output: envelope.usage?.output_tokens ?? null },
      };
    }
    if (envelope.error && /auth|sign in|logged in|credential/i.test(envelope.error)) {
      throw AiError.config(`\`agy\` isn't signed in on the server. Run \`agy\` there once, then try again.`);
    }
    if (envelope.error && /model/i.test(envelope.error)) throw AiError.unknownModel(model, envelope.status);
    throw cliFailure(this.command, model, output);
  }

  protected async fetchModels(signal: AbortSignal): Promise<string[]> {
    const output = await this.run(["models"], signal);
    if (output.code !== 0) return ANTIGRAVITY_FALLBACK_MODELS;
    // Each line is a slug, then the name people see: `gemini-4-argon-high   Gemini 4 Argon (High)`.
    const names = output.stdout
      .split("\n")
      .map((line) => line.trim().split(/\s+/, 1)[0])
      .filter((name) => /^[a-z0-9][a-z0-9._-]+$/i.test(name));
    return names.length > 0 ? [...new Set(names)].sort((a, b) => a.localeCompare(b)) : ANTIGRAVITY_FALLBACK_MODELS;
  }
}

/** The envelope `agy --output-format json` ends with, or null when there isn't one. */
function parseEnvelope(text: string) {
  const last = text.trim().split("\n").at(-1) ?? "";
  try {
    const result = ENVELOPE.safeParse(JSON.parse(last));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
