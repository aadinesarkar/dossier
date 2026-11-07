import { afterEach, describe, expect, it } from "vitest";

import { antigravityUrl, cliAuthPath, codexFields } from "./cli-login";

afterEach(() => {
  delete process.env.CODEX_HOME;
});

describe("the sign-in pages the tools print", () => {
  it("reads Codex's page and one-time code, colours and all", () => {
    const output = [
      "\u001b[94mWelcome to Codex\u001b[0m",
      "",
      "1. Open this link in your browser and sign in to your account",
      "   \u001b[94mhttps://auth.openai.com/codex/device\u001b[0m",
      "",
      "2. Enter this one-time code \u001b[90m(expires in 15 minutes)\u001b[0m",
      "   \u001b[94mABCD-EFGH\u001b[0m",
    ].join("\n");
    expect(codexFields(output)).toEqual({ url: "https://auth.openai.com/codex/device", code: "ABCD-EFGH" });
  });

  it("reads Antigravity's Google page, without the punctuation after it", () => {
    const output = "Open this link to sign in:\n  https://accounts.google.com/o/oauth2/v2/auth?client_id=x&state=y.\n";
    expect(antigravityUrl(output)).toBe("https://accounts.google.com/o/oauth2/v2/auth?client_id=x&state=y");
    expect(antigravityUrl("nothing here")).toBeNull();
  });

  it("finds Codex's auth file where the CLI keeps it", () => {
    process.env.CODEX_HOME = "/data/codex";
    expect(cliAuthPath("CODEX")).toBe("/data/codex/auth.json");
    expect(cliAuthPath("ANTIGRAVITY")).toMatch(/\.gemini\/antigravity-cli\/antigravity-oauth-token$/);
  });
});
