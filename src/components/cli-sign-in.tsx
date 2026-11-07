"use client";

import { useEffect, useRef, useState } from "react";

import { toastResult } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cancelCliSignIn, cliSignedIn, cliSignInStatus, startCliSignIn, submitCliSignInCode } from "@/lib/ai/cli-login-actions";

type Provider = "CODEX" | "ANTIGRAVITY";

const NAME: Record<Provider, string> = { CODEX: "ChatGPT", ANTIGRAVITY: "Google" };

type State =
  | { state: "idle" }
  | { state: "starting" }
  | { state: "awaiting"; id: string; url: string; code: string | null; note: string; expiresInSeconds: number | null }
  | { state: "done" }
  | { state: "failed"; message: string };

/**
 * Signing a command-line AI tool in from Dossier (E21-2, Settings → AI
 * provider): the tool runs on the server and does the OAuth dance there, so
 * the user only opens a page, and sometimes pastes a code back.
 */
export function CliSignIn({ provider, onDone }: { provider: Provider; onDone: () => void }) {
  const [state, setState] = useState<State>({ state: "idle" });
  const [code, setCode] = useState("");
  const [left, setLeft] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const onDoneRef = useRef(onDone);
  const announced = useRef(false);

  useEffect(() => {
    onDoneRef.current = onDone;
  }, [onDone]);

  // The tool may already be signed in on this server: then there's nothing to do.
  useEffect(() => {
    let live = true;
    void cliSignedIn({ provider }).then((result) => {
      if (!live || !result.ok || !result.data) return;
      setState((current) => (current.state === "idle" ? { state: "done" } : current));
      if (announced.current) return;
      announced.current = true;
      onDoneRef.current();
    });
    return () => {
      live = false;
    };
  }, [provider]);

  const awaitingId = state.state === "awaiting" ? state.id : null;

  // While the tool waits for the browser, ask it how it's doing.
  useEffect(() => {
    if (!awaitingId) return;
    let live = true;
    const timer = setInterval(async () => {
      const result = await cliSignInStatus({ id: awaitingId });
      if (!live) return;
      if (!result.ok) return setState({ state: "failed", message: result.error });
      if (result.data.state === "done") {
        setState({ state: "done" });
        if (announced.current) return;
        announced.current = true;
        onDoneRef.current();
      } else if (result.data.state === "failed") {
        setState({ state: "failed", message: result.data.message ?? "The sign-in didn't complete." });
      }
    }, 2_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [awaitingId]);

  // Antigravity keeps its code prompt open for only 30 seconds: count them down.
  const expires = state.state === "awaiting" ? state.expiresInSeconds : null;
  useEffect(() => {
    if (expires === null) return;
    const timer = setInterval(() => setLeft((value) => (value === null ? null : Math.max(0, value - 1))), 1_000);
    return () => clearInterval(timer);
  }, [expires]);

  const start = async () => {
    announced.current = false;
    // Already signed in, and not asking to change account: nothing to start.
    if (state.state === "idle") {
      const check = await cliSignedIn({ provider });
      if (check.ok && check.data) {
        setState({ state: "done" });
        announced.current = true;
        onDoneRef.current();
        return;
      }
    }
    setState({ state: "starting" });
    const result = toastResult(await startCliSignIn({ provider }));
    if (!result.ok) return setState({ state: "failed", message: result.error });
    setCode("");
    setLeft(result.data.expiresInSeconds);
    setState({ state: "awaiting", ...result.data });
  };

  const submit = async () => {
    if (state.state !== "awaiting" || !code.trim() || busy) return;
    setBusy(true);
    const result = toastResult(await submitCliSignInCode({ id: state.id, code: code.trim() }));
    setBusy(false);
    if (!result.ok) return setState({ state: "failed", message: result.error });
    if (result.data.state === "failed") setState({ state: "failed", message: result.data.message ?? "The sign-in didn't complete." });
  };

  const restart = async () => {
    if (state.state === "awaiting") await cancelCliSignIn({ id: state.id });
    announced.current = false;
    setCode("");
    setLeft(null);
    setState({ state: "idle" });
  };

  return (
    <div className="flex flex-col gap-3">
      {(state.state === "idle" || state.state === "failed" || state.state === "done") && (
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="secondary" size="sm" onClick={() => void start()}>
            {state.state === "done" ? "Sign in again" : `Sign in with ${NAME[provider]}`}
          </Button>
          {state.state === "done" && (
            <p role="status" className="text-sm text-success">
              Signed in on this server.
            </p>
          )}
        </div>
      )}

      {state.state === "starting" && (
        <p role="status" className="text-sm text-muted">
          Starting the sign-in on the server…
        </p>
      )}

      {state.state === "failed" && (
        <p role="alert" className="rounded-card bg-warning-surface px-4 py-3 text-sm text-warning">
          {state.message}
        </p>
      )}

      {state.state === "awaiting" && (
        <div className="flex flex-col gap-3 rounded-card border border-line-card bg-card px-4 py-3">
          <p className="text-sm text-muted">{state.note}</p>
          <a
            href={state.url}
            target="_blank"
            rel="noopener noreferrer"
            className="self-start text-sm font-medium text-ink underline underline-offset-2"
          >
            Open the sign-in page <span className="sr-only">(opens in a new tab)</span>
          </a>
          {state.code && (
            <p className="flex flex-wrap items-center gap-2 text-sm">
              Code: <code className="rounded bg-surface px-1.5 py-0.5 font-mono text-[13px]">{state.code}</code>
              <button
                type="button"
                className="text-meta text-muted underline underline-offset-2 hover:text-ink"
                onClick={() => void navigator.clipboard?.writeText(state.code ?? "")}
              >
                Copy
              </button>
            </p>
          )}
          {provider === "ANTIGRAVITY" && (
            <form
              className="flex flex-col gap-2 sm:flex-row sm:items-start"
              onSubmit={(event) => {
                event.preventDefault();
                void submit();
              }}
            >
              <Input label="Code from Google" value={code} onChange={(event) => setCode(event.target.value)} />
              <Button type="submit" disabled={!code.trim() || busy} className="self-start sm:mt-[25px]">
                {busy ? "Finishing…" : "Finish sign-in"}
              </Button>
            </form>
          )}
          {left !== null && (
            <p className="text-meta text-muted">
              {left > 0
                ? `The link lasts about ${left} more second${left === 1 ? "" : "s"}.`
                : "The link may have expired. Start again if nothing happens."}
            </p>
          )}
          <Button variant="text" size="sm" className="self-start" onClick={() => void restart()}>
            Start again
          </Button>
        </div>
      )}
    </div>
  );
}
