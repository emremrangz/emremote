import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, del, errorMessage, post } from "@/lib/api";

export type AccessState =
  | { status: "idle" }
  | { status: "connecting" }
  | { status: "ready"; id: string; username: string }
  | { status: "needs-credentials"; message: string; failed: boolean }
  | { status: "needs-host-key"; message: string }
  | { status: "error"; message: string };

/**
 * Opens (and keeps) a server-side SSH access session for a connection, used by
 * the file browser and system overview. Typed credentials are used once and
 * never stored. The session is closed when the component unmounts.
 */
export function useSSHAccess(connectionId: string | undefined) {
  const [state, setState] = useState<AccessState>({ status: "idle" });
  const idRef = useRef<string | null>(null);

  const open = useCallback(
    async (creds?: { username: string; password: string }) => {
      if (!connectionId) return;
      setState({ status: "connecting" });
      try {
        const r = await post<{ id: string; username: string }>(`/api/connections/${connectionId}/ssh-access`, creds ?? {});
        idRef.current = r.id;
        setState({ status: "ready", id: r.id, username: r.username });
      } catch (e) {
        if (e instanceof ApiError && (e.code === "credentials_required" || e.code === "authentication_failed"))
          setState({ status: "needs-credentials", message: e.message, failed: e.code === "authentication_failed" });
        else if (e instanceof ApiError && (e.code === "host_key_mismatch"))
          setState({ status: "needs-host-key", message: e.message });
        else setState({ status: "error", message: errorMessage(e) });
      }
    },
    [connectionId],
  );

  useEffect(() => {
    open();
    return () => {
      if (idRef.current) del(`/api/ssh-access/${idRef.current}`).catch(() => {});
      idRef.current = null;
    };
  }, [open]);

  /** Call when a request returns 410 (access expired): reconnect transparently. */
  const expired = useCallback(() => {
    idRef.current = null;
    open();
  }, [open]);

  return { state, open, expired };
}

export function isExpired(e: unknown) {
  return e instanceof ApiError && e.status === 410;
}
