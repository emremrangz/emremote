import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import clsx from "clsx";
import { TerminalShell, TermPrompt, TERM_FIELD } from "@/components/TerminalShell";
import { useAuth } from "@/lib/auth";
import { ApiError, errorMessage } from "@/lib/api";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const delay = (ms: number) => ({ "--d": `${ms}ms` }) as React.CSSProperties;

/** First-run screen: create the administrator, in the same terminal as the sign-in screen. */
export default function SetupPage() {
  const { setup, state } = useAuth();
  const tokenRequired = state.status === "setup" && state.tokenRequired;
  const secure = window.location.protocol === "https:";
  const [token, setToken] = useState("");
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [reveal, setReveal] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [shaking, setShaking] = useState(false);
  const [tick, setTick] = useState(0);
  const tokenRef = useRef<HTMLInputElement>(null);
  const userRef = useRef<HTMLInputElement>(null);
  const passRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => setTick((n) => n + 1), 80);
    return () => clearInterval(t);
  }, [busy]);

  useEffect(() => {
    (tokenRequired ? tokenRef : passRef).current?.focus();
  }, [tokenRequired]);

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (busy) return;
    setErrors({});
    setError("");
    const missing: Record<string, string> = {};
    if (tokenRequired && !token.trim()) missing.setup_token = "Enter the setup token.";
    if (!username.trim()) missing.username = "Choose a username.";
    if (password.length < 8) missing.password = "Use at least 8 characters.";
    else if (password !== confirm) missing.confirm = "The passwords do not match.";
    if (Object.keys(missing).length) {
      setErrors(missing);
      setShaking(true);
      return;
    }
    setBusy(true);
    try {
      await setup(token.trim(), username, password);
    } catch (err) {
      if (err instanceof ApiError) setErrors(err.fields);
      setError(errorMessage(err));
      setShaking(true);
    } finally {
      setBusy(false);
    }
  };

  const next = (ref: React.RefObject<HTMLInputElement>) => (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      ref.current?.focus();
    }
  };
  const messages = Object.entries(errors).filter(([, m]) => m);

  return (
    <TerminalShell title="setup" heading="Welcome to emremote" shaking={shaking} onShakeEnd={() => setShaking(false)} onSubmit={submit} onBackgroundClick={() => (password ? confirmRef : passRef).current?.focus()}>
      <p data-term className="term-line mb-1 flex items-baseline gap-3" style={delay(0)}>
        <span className="bg-gradient-to-r from-[#7ee787] to-[#79c0ff] bg-clip-text text-2xl font-bold tracking-tight text-transparent">emremote</span>
        <span className="text-white/35">welcome</span>
      </p>
      <p data-term className="term-line text-white/45" style={delay(120)}>
        <span className={secure ? "text-[#7ee787]" : "text-[#e3b341]"}>{secure ? "[ ok ]" : "[warn]"}</span>{" "}
        {secure ? "encrypted connection" : "this connection is not encrypted; use https on untrusted networks"}
      </p>
      <p data-term className="term-line text-white/45" style={delay(240)}>
        <span className="text-white/40">[ -- ]</span> first run: no administrator account exists yet.
      </p>
      <p data-term className="term-line text-white/45" style={delay(360)}>
        <span className="text-white/40">[ -- ]</span> Choose a username and password. You will be signed in right away.
      </p>
      <div data-term className="h-3" />

      {tokenRequired && (
        <label className="term-line flex items-center gap-3" style={delay(440)}>
          <TermPrompt label="setup token" />
          <input ref={tokenRef} aria-label="Setup token" className={clsx(TERM_FIELD, "tracking-[0.1em]")} value={token} onChange={(e) => setToken(e.target.value)} onKeyDown={next(userRef)} autoComplete="off" spellCheck={false} disabled={busy} />
        </label>
      )}
      <label className="term-line flex items-center gap-3" style={delay(480)}>
        <TermPrompt label="username" />
        <input ref={userRef} aria-label="Username" className={TERM_FIELD} value={username} onChange={(e) => setUsername(e.target.value)} onKeyDown={next(passRef)} autoComplete="username" autoCapitalize="off" spellCheck={false} disabled={busy} />
      </label>
      <label className="term-line flex items-center gap-3" style={delay(560)}>
        <TermPrompt label="password" />
        <input
          ref={passRef}
          aria-label="Password"
          type={reveal ? "text" : "password"}
          className={clsx(TERM_FIELD, !reveal && "tracking-[0.2em]")}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={next(confirmRef)}
          autoComplete="new-password"
          disabled={busy}
        />
        <button type="button" tabIndex={-1} onClick={() => setReveal((r) => !r)} className="shrink-0 rounded px-1.5 text-[11px] text-white/35 hover:bg-white/5 hover:text-white/70" aria-label="Reveal characters" aria-pressed={reveal} disabled={busy}>
          {reveal ? "hide" : "show"}
        </button>
      </label>
      <label className="term-line flex items-center gap-3" style={delay(640)}>
        <TermPrompt label="confirm" />
        <input
          ref={confirmRef}
          aria-label="Confirm password"
          type={reveal ? "text" : "password"}
          className={clsx(TERM_FIELD, !reveal && "tracking-[0.2em]")}
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          autoComplete="new-password"
          disabled={busy}
        />
      </label>
      <p className="term-line pt-1 text-xs text-white/35" style={delay(700)}>
        # at least 8 characters; a longer passphrase is stronger
      </p>

      {busy && (
        <p className="text-white/70">
          <span className="text-[#7ee787]">{SPINNER[tick % SPINNER.length]}</span> Creating the account
          <span className="text-white/40">{".".repeat((tick >> 2) % 4)}</span>
        </p>
      )}
      {messages.length > 0 &&
        messages.map(([k, m]) => (
          <p key={k} className="text-[#ff7b72]" role="alert">
            ✗ {m}
          </p>
        ))}
      {error && messages.length === 0 && (
        <p className="text-[#ff7b72]" role="alert">
          ✗ {error}
        </p>
      )}

      <div data-term className="flex flex-wrap items-center justify-between gap-3 pt-5">
        <p data-term className="max-w-[60%] text-xs leading-5 text-white/30">
          # this screen closes for good once the account exists
        </p>
        <div className="ml-auto flex items-center gap-3">
          <span className="hidden text-[11px] text-white/30 sm:inline">
            <kbd className="rounded border border-white/15 px-1">Enter</kbd> next field
          </span>
          <button
            type="submit"
            disabled={busy}
            className="rounded-md border border-[#7ee787]/40 bg-[#7ee787]/10 px-3.5 py-1.5 text-xs font-semibold text-[#7ee787] shadow-[0_0_24px_-8px_rgba(126,231,135,0.6)] transition-colors hover:bg-[#7ee787]/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7ee787]/50 disabled:opacity-50"
          >
            Create account ↵
          </button>
        </div>
      </div>
    </TerminalShell>
  );
}
