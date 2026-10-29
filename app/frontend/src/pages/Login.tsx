import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import clsx from "clsx";
import { TerminalShell, TermPrompt, TERM_FIELD } from "@/components/TerminalShell";
import { Neofetch, type About } from "@/components/Neofetch";
import { useAuth } from "@/lib/auth";
import { ApiError, errorMessage } from "@/lib/api";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Sign-in screen styled as a terminal window. */
export default function LoginPage() {
  const { login, login2fa, state } = useAuth();
  const notice = state.status === "anonymous" ? state.notice : undefined;
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  // The sign-in is typed line by line, like a terminal: login, then password.
  const [step, setStep] = useState<"user" | "pass">("user");
  const [about, setAbout] = useState<About | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);
  // Set after a correct password when the account has two-factor authentication.
  const [challenge, setChallenge] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const codeRef = useRef<HTMLInputElement>(null);
  const userRef = useRef<HTMLInputElement>(null);
  const passRef = useRef<HTMLInputElement>(null);
  const host = window.location.host;
  const secure = window.location.protocol === "https:";
  const [health, setHealth] = useState<"ok" | "down" | null>(null);
  const [reveal, setReveal] = useState(false);
  const [recovery, setRecovery] = useState(false);
  const [shaking, setShaking] = useState(false);
  const now = new Date();

  // The facts next to the logo come from the server; the screen works without them.
  useEffect(() => {
    let live = true;
    fetch("/api/about", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((a) => live && a && setAbout(a))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  // A real check, not decoration: is the server answering?
  useEffect(() => {
    let live = true;
    fetch("/healthz", { cache: "no-store" })
      .then((r) => live && setHealth(r.ok ? "ok" : "down"))
      .catch(() => live && setHealth("down"));
    return () => {
      live = false;
    };
  }, []);

  // Shake the window when a sign-in attempt fails.
  useEffect(() => {
    if (error) setShaking(true);
  }, [error]);

  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => setTick((n) => n + 1), 80);
    return () => clearInterval(t);
  }, [busy]);

  // Inputs are disabled while signing in, so restore focus once that is over.
  useEffect(() => {
    if (busy) return;
    if (challenge) codeRef.current?.focus();
    else if (error) (username.trim() ? passRef : userRef).current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, error, challenge, step]);

  // The real sign-in. The button calls it directly (all lines as they are now); Enter reaches it after the last line.
  const signIn = async () => {
    if (busy) return;
    if (!username.trim()) {
      setError("Username is required.");
      setStep("user");
      userRef.current?.focus();
      return;
    }
    if (!password) {
      setError("Password is required.");
      setStep("pass");
      passRef.current?.focus();
      return;
    }
    setBusy(true);
    setError("");
    try {
      const r = await login(username, password);
      if (r) {
        setChallenge(r.challenge);
        setCode("");
      }
    } catch (err) {
      setError(errorMessage(err));
      setPassword("");
      setStep("pass");
    } finally {
      setBusy(false);
    }
  };

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (busy) return;
    if (challenge) {
      if (!code.trim()) {
        setError("Enter the code from your authenticator app.");
        codeRef.current?.focus();
        return;
      }
      setBusy(true);
      setError("");
      try {
        await login2fa(challenge, code);
      } catch (err) {
        const m = errorMessage(err);
        setError(m);
        setCode("");
        // An expired sign-in starts over from the password.
        if (err instanceof ApiError && err.code === "challenge_expired") {
          setChallenge(null);
          setPassword("");
        }
      } finally {
        setBusy(false);
      }
      return;
    }
    if (!username.trim()) {
      setError("Username is required.");
      setStep("user");
      userRef.current?.focus();
      return;
    }
    // Enter on the login line asks for the password.
    if (step === "user") {
      setError("");
      setStep("pass");
      window.setTimeout(() => passRef.current?.focus(), 0);
      return;
    }
    if (!password) {
      setError("Password is required.");
      setStep("pass");
      passRef.current?.focus();
      return;
    }
    await signIn();
  };

  // Tab on the login line behaves like Enter, as in a terminal.
  const onUserKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Tab" && !e.shiftKey && step === "user" && username.trim()) {
      e.preventDefault();
      void submit();
    }
  };

  const prompt = (label: string) => <TermPrompt label={label} />;
  const field = TERM_FIELD;

  return (
    <TerminalShell
      title="login"
      heading="Sign in"
      shaking={shaking}
      onShakeEnd={() => setShaking(false)}
      onSubmit={submit}
      onBackgroundClick={() => (challenge ? codeRef : step === "pass" ? passRef : userRef).current?.focus()}
    >
          <Neofetch about={about} host={host} secure={secure} />
          {/* Enter on any line submits the form (the visible button only clicks), so the form needs a default button. */}
          <button type="submit" tabIndex={-1} aria-hidden="true" className="sr-only" />
          <p data-term className="term-line text-white/45" style={{ "--d": "120ms" } as React.CSSProperties}>
            <span className={secure ? "text-[#7ee787]" : "text-[#e3b341]"}>{secure ? "[ ok ]" : "[warn]"}</span>{" "}
            {secure ? `encrypted connection to ${host}` : "this connection is not encrypted; use https on untrusted networks"}
          </p>
          <p data-term className="term-line text-white/45" style={{ "--d": "240ms" } as React.CSSProperties}>
            {health === null ? (
              <>
                <span className="text-white/40">[ .. ]</span> checking the server
              </>
            ) : health === "ok" ? (
              <>
                <span className="text-[#7ee787]">[ ok ]</span> server is up and ready
              </>
            ) : (
              <>
                <span className="text-[#ff7b72]">[fail]</span> the server is not answering
              </>
            )}
          </p>
          <p data-term className="term-line text-white/45" style={{ "--d": "360ms" } as React.CSSProperties}>
            <span className="text-white/40">[ -- ]</span> {now.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })} · type each answer and press Enter.
          </p>
          <div data-term className="h-3" />

          {notice && !error && <p className="term-line text-[#e3b341]">! {notice}</p>}

          <label className="term-line flex items-center gap-3" style={{ "--d": "480ms" } as React.CSSProperties}>
            {prompt("login")}
            <input
              ref={userRef}
              aria-label="Username"
              className={field}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              onKeyDown={onUserKey}
              onFocus={() => !busy && !challenge && step !== "user" && setStep("user")}
              autoComplete="username"
              autoFocus
              autoCapitalize="off"
              spellCheck={false}
              disabled={busy || !!challenge}
            />
          </label>
          {/* Hidden (but present, so password managers can fill it) until the login line was confirmed with Enter. */}
          <label
            className={clsx("flex items-center gap-3", step === "user" && !challenge ? "pointer-events-none absolute -z-10 w-64 opacity-0" : "term-line")}
            style={{ "--d": "0ms" } as React.CSSProperties}
          >
            {prompt("password")}
            <input
              ref={passRef}
              aria-label="Password"
              type={reveal ? "text" : "password"}
              className={clsx(field, !reveal && "tracking-[0.2em]")}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              disabled={busy || !!challenge}
            />
            <button
              type="button"
              tabIndex={-1}
              onClick={() => setReveal((r) => !r)}
              className="shrink-0 rounded px-1.5 text-[11px] text-white/35 hover:bg-white/5 hover:text-white/70"
              aria-label="Reveal characters"
              aria-pressed={reveal}
              disabled={busy || !!challenge}
            >
              {reveal ? "hide" : "show"}
            </button>
          </label>
          {challenge && (
            <div className="term-line space-y-2 pt-1">
              <label className="flex items-center gap-3">
                {prompt("2fa code")}
                {recovery ? (
                  <input
                    ref={codeRef}
                    aria-label="Authentication code"
                    className={clsx(field, "tracking-[0.15em]")}
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    placeholder="xxxxx-xxxxx"
                    autoComplete="off"
                    spellCheck={false}
                    autoCapitalize="off"
                    disabled={busy}
                  />
                ) : (
                  <span className="relative inline-flex">
                    {/* The real field sits invisibly over the boxes, so typing, pasting and password managers behave normally. */}
                    <input
                      ref={codeRef}
                      aria-label="Authentication code"
                      className="absolute inset-0 z-10 h-full w-full cursor-text bg-transparent text-transparent caret-transparent opacity-0 outline-none"
                      value={code}
                      onChange={(e) => {
                        const v = e.target.value;
                        // Anything that is not a digit is a recovery code: switch to the plain field and keep what was typed.
                        if (/[^\d\s]/.test(v)) {
                          setRecovery(true);
                          setCode(v);
                        } else setCode(v.replace(/\s/g, "").slice(0, 6));
                      }}
                      autoComplete="one-time-code"
                      inputMode="numeric"
                      pattern="[0-9]*"
                      maxLength={12}
                      spellCheck={false}
                      disabled={busy}
                    />
                    <span className="flex gap-1.5" aria-hidden="true">
                      {Array.from({ length: 6 }, (_, i) => {
                        const ch = code[i];
                        const current = !busy && i === Math.min(code.length, 5) && (code.length < 6 || i === 5);
                        return (
                          <span
                            key={i}
                            className={clsx(
                              "flex h-9 w-8 items-center justify-center rounded-md border bg-white/[0.03] text-base font-semibold text-[#e6edf3] transition-colors",
                              current ? "border-[#7ee787]/70 shadow-[0_0_0_3px_rgba(126,231,135,0.12)]" : ch ? "border-white/25" : "border-white/10",
                              i === 2 && "mr-2",
                            )}
                          >
                            {ch ?? (current ? <span className="term-cursor h-4 w-px bg-[#7ee787]" /> : "")}
                          </span>
                        );
                      })}
                    </span>
                  </span>
                )}
              </label>
              <p className="flex flex-wrap items-center gap-x-3 text-xs text-white/40">
                <span># {recovery ? "one of your recovery codes" : "6-digit code from your authenticator app"}</span>
                <button
                  type="button"
                  className="text-white/55 underline-offset-2 hover:text-white/80 hover:underline"
                  onClick={() => {
                    setRecovery((r) => !r);
                    setCode("");
                    window.setTimeout(() => codeRef.current?.focus(), 0);
                  }}
                >
                  {recovery ? "use the authenticator code" : "use a recovery code"}
                </button>
              </p>
            </div>
          )}

          {busy && (
            <p className="text-white/70">
              <span className="text-[#7ee787]">{SPINNER[tick % SPINNER.length]}</span> Authenticating
              <span className="text-white/40">{".".repeat((tick >> 2) % 4)}</span>
            </p>
          )}
          {error && (
            <p className="text-[#ff7b72]" role="alert">
              ✗ {error}
            </p>
          )}

          <div data-term className="flex flex-wrap items-center justify-between gap-3 pt-5">
            <div data-term className="min-w-0 text-xs leading-5 text-white/30">
              <p># locked out, or time to update? on the server, in the install folder:</p>
              {[
                ["reset password", "docker compose exec emremote /app/emremote reset-password admin"],
                ["reset 2FA", "docker compose exec emremote /app/emremote reset-2fa admin"],
                ["update", "scripts/update.sh"],
              ].map(([label, cmd]) => (
                <p key={label} className="flex flex-wrap gap-x-2">
                  <span className="w-[7.5rem] shrink-0 text-white/40">{label}</span>
                  <span className="break-all text-white/55">{cmd}</span>
                </p>
              ))}
            </div>
            <div className="ml-auto flex items-center gap-3">
              <span className="hidden text-[11px] text-white/30 sm:inline">
                <kbd className="rounded border border-white/15 px-1">Enter</kbd> next line
              </span>
              <button
                type={challenge ? "submit" : "button"}
                onClick={challenge ? undefined : () => void signIn()}
                disabled={busy}
                className="rounded-md border border-[#7ee787]/40 bg-[#7ee787]/10 px-3.5 py-1.5 text-xs font-semibold text-[#7ee787] shadow-[0_0_24px_-8px_rgba(126,231,135,0.6)] transition-colors hover:bg-[#7ee787]/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7ee787]/50 disabled:opacity-50"
              >
                Sign in ↵
              </button>
            </div>
          </div>
    </TerminalShell>
  );
}
