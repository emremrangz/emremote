import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { FileBrowser } from "@/components/FileBrowser";
import { SSHAccessGate } from "@/components/SSHAccessGate";
import { ProtocolBadge } from "@/components/Status";
import { OsIcon } from "@/components/OsIcon";
import { useSSHAccess } from "@/hooks/useSSHAccess";
import type { Connection } from "@/lib/types";

// Pieces shared by the remote session views (the gateway's display and the built-in terminal).

/** SFTP files of an SSH connection, in the panel docked on the left. */
export function SessionFiles({ conn }: { conn: Connection }) {
  const { state, open, expired } = useSSHAccess(conn.id);
  return (
    <div className="min-h-0 flex-1">
      <SSHAccessGate
        compact
        state={state}
        onSubmitCredentials={open}
        onRetry={() => open()}
        onVerifyHostKey={() => window.open(`/devices/${conn.device_id}`, "emremote-main")}
        defaultUsername={conn.username}
      >
        {(id) => <FileBrowser compact base={`/api/ssh-access/${id}/files`} onExpired={expired} />}
      </SSHAccessGate>
    </div>
  );
}

/** A message over the remote screen while it connects, after an error or when it ended. */
export function Overlay({ children, conn }: { children: ReactNode; conn?: Connection }) {
  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center bg-[#05070a]/75 px-4 backdrop-blur-sm" data-no-capture>
      <div className="flex w-full max-w-md flex-col items-center rounded-2xl border border-white/10 bg-[#0d1117]/90 px-8 py-8 text-center shadow-[0_30px_80px_-20px_rgba(0,0,0,0.8)] animate-fade-in">
        {conn && (
          <p className="mb-6 flex max-w-full flex-wrap items-center justify-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-3.5 py-1.5 text-sm text-muted">
            <OsIcon os={conn.device_os} distro={undefined} />
            <span className="truncate font-medium text-fg">{conn.device_name}</span> <ProtocolBadge protocol={conn.protocol} />
            <span className="font-mono text-2xs text-subtle">
              {conn.device_address}:{conn.port}
            </span>
          </p>
        )}
        {children}
      </div>
    </div>
  );
}

/** A whole-page message, when there is no session to show. */
export function FullMessage({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center bg-bg px-6 text-center">
      {icon}
      <h1 className="mt-3 text-base font-semibold">{title}</h1>
      <p className="mt-2 text-sm text-muted">{children}</p>
      <Link to="/" className="mt-6 text-sm font-medium text-accent hover:underline">
        Back to emremote
      </Link>
    </div>
  );
}
