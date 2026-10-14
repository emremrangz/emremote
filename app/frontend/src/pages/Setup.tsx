import { useState, type FormEvent } from "react";
import { AuthShell } from "@/components/Layout";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { useAuth } from "@/lib/auth";
import { ApiError, errorMessage } from "@/lib/api";

export default function SetupPage() {
  const { setup, state } = useAuth();
  const tokenRequired = state.status === "setup" && state.tokenRequired;
  const [token, setToken] = useState("");
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErrors({});
    setError("");
    const missing: Record<string, string> = {};
    if (tokenRequired && !token.trim()) missing.setup_token = "Required";
    if (!username.trim()) missing.username = "Required";
    if (password.length < 8) missing.password = "Use at least 8 characters";
    else if (password !== confirm) missing.confirm = "Passwords do not match";
    if (Object.keys(missing).length) {
      setErrors(missing);
      return;
    }
    setBusy(true);
    try {
      await setup(token.trim(), username, password);
    } catch (err) {
      if (err instanceof ApiError) setErrors(err.fields);
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell>
      <form noValidate onSubmit={submit} className="card space-y-4 p-6 shadow-pop">
        <div>
          <h1 className="text-lg font-semibold">Welcome to emremote</h1>
          <p className="mt-1 text-sm text-muted">Choose a username and password for the first administrator. You will be signed in right away.</p>
        </div>
        {tokenRequired && (
          <Field
            label="Setup token"
            hint={
              <>
                The <span className="font-mono text-fg">EMREMOTE_SETUP_TOKEN</span> value from the server's <span className="font-mono text-fg">.env</span> file.
              </>
            }
            error={errors.setup_token}
          >
            <input className="input font-mono" value={token} onChange={(e) => setToken(e.target.value)} required autoFocus autoComplete="off" spellCheck={false} />
          </Field>
        )}
        <Field label="Username" error={errors.username}>
          <input className="input" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required autoCapitalize="off" autoFocus={!tokenRequired} />
        </Field>
        <Field label="Password" hint="At least 8 characters. A longer passphrase is stronger." error={errors.password}>
          <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" required minLength={8} />
        </Field>
        <Field label="Confirm password" error={errors.confirm}>
          <input className="input" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" required />
        </Field>
        {error && !Object.keys(errors).length && (
          <p className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger" role="alert">
            {error}
          </p>
        )}
        <Button variant="primary" type="submit" loading={busy} className="w-full justify-center">
          Create account
        </Button>
      </form>
    </AuthShell>
  );
}
