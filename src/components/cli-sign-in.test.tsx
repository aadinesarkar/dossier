import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CliSignIn } from "./cli-sign-in";
import { cliSignedIn, startCliSignIn, submitCliSignInCode } from "@/lib/ai/cli-login-actions";

vi.mock("@/lib/ai/cli-login-actions", () => ({
  startCliSignIn: vi.fn(),
  cliSignInStatus: vi.fn(),
  submitCliSignInCode: vi.fn(),
  cancelCliSignIn: vi.fn(),
  cliSignedIn: vi.fn(),
}));
vi.mock("@/components/toast", () => ({ toast: vi.fn(), toastResult: (result: unknown) => result }));

const codexView = {
  id: "login-1",
  provider: "CODEX" as const,
  url: "https://auth.openai.com/codex/device",
  code: "ABCD-EFGH",
  note: "Enter the code on OpenAI's page and approve.",
  expiresInSeconds: null,
};

const antigravityView = {
  id: "login-2",
  provider: "ANTIGRAVITY" as const,
  url: "https://accounts.google.com/o/oauth2/v2/auth?client_id=x",
  code: null,
  note: "Sign in with Google, then paste the code it shows you back here.",
  expiresInSeconds: 30,
};

beforeEach(() => {
  vi.mocked(cliSignedIn).mockReset().mockResolvedValue({ ok: true, data: false });
  vi.mocked(startCliSignIn).mockReset();
  vi.mocked(submitCliSignInCode).mockReset().mockResolvedValue({ ok: true, data: { state: "pending" } });
});

describe("CliSignIn", () => {
  it("shows Codex's page and one-time code after a click", async () => {
    vi.mocked(startCliSignIn).mockResolvedValue({ ok: true, data: codexView });
    render(<CliSignIn provider="CODEX" onDone={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Sign in with ChatGPT" }));
    expect(await screen.findByRole("link", { name: /Open the sign-in page/ })).toHaveAttribute("href", codexView.url);
    expect(screen.getByText("ABCD-EFGH")).toBeInTheDocument();
    expect(screen.getByText(codexView.note)).toBeInTheDocument();
  });

  it("hands Antigravity the code Google showed", async () => {
    vi.mocked(startCliSignIn).mockResolvedValue({ ok: true, data: antigravityView });
    render(<CliSignIn provider="ANTIGRAVITY" onDone={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Sign in with Google" }));
    await userEvent.type(await screen.findByLabelText("Code from Google"), "4/0Abc");
    await userEvent.click(screen.getByRole("button", { name: "Finish sign-in" }));
    expect(submitCliSignInCode).toHaveBeenCalledWith({ id: "login-2", code: "4/0Abc" });
  });

  it("says nothing needs doing when the server is already signed in, and tells the page", async () => {
    const done = vi.fn();
    vi.mocked(cliSignedIn).mockResolvedValue({ ok: true, data: true });
    render(<CliSignIn provider="CODEX" onDone={done} />);
    expect(await screen.findByText("Signed in on this server.")).toBeInTheDocument();
    await waitFor(() => expect(done).toHaveBeenCalledTimes(1));
  });

  it("shows a failure in words", async () => {
    vi.mocked(startCliSignIn).mockResolvedValue({ ok: false, error: "The `codex` command isn't installed on this server." });
    render(<CliSignIn provider="CODEX" onDone={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Sign in with ChatGPT" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("isn't installed");
  });
});
