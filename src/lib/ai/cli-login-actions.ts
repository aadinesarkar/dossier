"use server";

import { z } from "zod";

import { ActionError, action } from "@/lib/action";

import { CliLoginError, cancelCliLogin, cliLoginConfirmed, cliLoginStatus, cliLoginSubmitCode, startCliLogin } from "./cli-login";

const PROVIDERS = z.enum(["CODEX", "ANTIGRAVITY"]);

/** Starts a tool's sign-in and returns the page and code to show. */
export const startCliSignIn = action(z.object({ provider: PROVIDERS }), async ({ provider }) => {
  try {
    return await startCliLogin(provider);
  } catch (error) {
    // The tool not being installed, or not signing in, is a message for the user.
    if (error instanceof CliLoginError) throw new ActionError(error.message);
    throw error;
  }
});

/** How the sign-in is doing; the panel asks this while it waits. */
export const cliSignInStatus = action(z.object({ id: z.string().min(1) }), async ({ id }) => cliLoginStatus(id));

/** Hands Google's authorization code back to `agy`. */
export const submitCliSignInCode = action(
  z.object({ id: z.string().min(1), code: z.string().trim().min(1).max(2000) }),
  async ({ id, code }) => cliLoginSubmitCode(id, code),
);

/** Stops a sign-in the user left. */
export const cancelCliSignIn = action(z.object({ id: z.string().min(1) }), async ({ id }) => {
  cancelCliLogin(id);
  return null;
});

/** Whether the tool already has credentials on this server. */
export const cliSignedIn = action(z.object({ provider: PROVIDERS }), async ({ provider }) => cliLoginConfirmed(provider));
