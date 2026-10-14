import { useState, type FormEvent, type ReactNode } from "react";
import { Lock, ShieldAlert, AlertTriangle, RotateCw } from "lucide-react";
import clsx from "clsx";
import type { AccessState } from "@/hooks/useSSHAccess";
import { Button } from "./ui/Button";
import { Spinner } from "./ui/Spinner";

/** Renders the right prompt for an SSH access state, or the children when ready. */
export function SSHAccessGate({
  state,
  onSubmitCredentials,
  onRetry,
  onVerifyHostKey,
  compact,
  defaultUsername = "",
  children,
}: {
  state: AccessState;
  onSubmitCredentials: (c: { username: string; password: string }) => void;
  onRetry: () => void;
  onVerifyHostKey?: () => void;
  compact?: boolean;
  defaultUsername?: string;
  children: (id: string, username: string) => ReactNode;
}) {
  const [username, setUsername] = useState(defaultUsername);
  const [password, setPassword] = useState("");
  if (state.status === "ready") return <>{children(state.id, state.username)}</>;

  const box = (icon: ReactNode, title: string, body: ReactNode) => (
    <div className={clsx("flex flex-col items-center justify-center text-center", compact ? "px-4 py-10" : "px-6 py-16")}>
      <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-surface-2 text-muted">{icon}</div>
      <h3 className="text-sm font-semibold">{title}</h3>
      <div className="mt-1.5 max-w-sm text-[13px] text-muted">{body}</div>
    </div>
  );

  if (state.status === "idle" || state.status === "connecting")
    return box(<Spinner className="h-4 w-4" />, "Connecting over SSH…", "Opening a secure session to the device.");

  if (state.status === "needs-host-key")
    return box(
      <ShieldAlert className="h-5 w-5 text-warning" />,
      "The server's host key changed",
      <>
        <p>{state.message}</p>
        {onVerifyHostKey && (
          <Button variant="primary" size="sm" className="mt-4" onClick={onVerifyHostKey}>
            Review host key
          </Button>
        )}
      </>,
    );

  if (state.status === "error")
    return box(
      <AlertTriangle className="h-5 w-5 text-danger" />,
      "Could not connect",
      <>
        <p className="break-words">{state.message}</p>
        <Button size="sm" className="mt-4" icon={<RotateCw className="h-3.5 w-3.5" />} onClick={onRetry}>
          Try again
        </Button>
      </>,
    );

  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSubmitCredentials({ username, password });
    setPassword("");
  };
  return (
    <div className={clsx("flex justify-center", compact ? "px-4 py-8" : "px-6 py-14")}>
      <form noValidate onSubmit={submit} className="w-full max-w-xs space-y-3" data-no-capture>
        <div className="mb-2 flex items-center gap-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-surface-2 text-muted">
            <Lock className="h-4 w-4" />
          </span>
          <div>
            <h3 className="text-sm font-semibold">Sign in over SSH</h3>
            <p className="text-xs text-subtle">Used for this session only, never stored.</p>
          </div>
        </div>
        {state.failed && <p className="rounded-md bg-danger/10 px-3 py-2 text-xs text-danger">{state.message}</p>}
        <input className="input" placeholder="Username" value={username} onChange={(e) => setUsername(e.target.value)} autoCapitalize="off" spellCheck={false} aria-label="SSH username" required />
        <input className="input" type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} aria-label="SSH password" required autoFocus />
        <Button variant="primary" type="submit" className="w-full justify-center">
          Connect
        </Button>
      </form>
    </div>
  );
}
