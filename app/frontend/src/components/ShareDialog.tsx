import { useCallback, useEffect, useState } from "react";
import { Eye, Link2, Users } from "lucide-react";
import { Dialog } from "./ui/Dialog";
import { Button } from "./ui/Button";
import { CopyButton } from "./ui/misc";
import { del, errorMessage, get, post } from "@/lib/api";
import { relativeTime } from "@/lib/format";

/** Create or stop a view-only link to the live session. */
export function ShareDialog({ sessionId, open, onOpenChange }: { sessionId: string; open: boolean; onOpenChange: (o: boolean) => void }) {
  const [state, setState] = useState<{ shared: boolean; viewers: number } | null>(null);
  const [link, setLink] = useState<{ url: string; expires: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    if (!sessionId) return;
    try {
      setState(await get<{ shared: boolean; viewers: number }>(`/api/active-sessions/${sessionId}/share`));
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [sessionId]);

  useEffect(() => {
    if (!open) return;
    setError("");
    refresh();
    const t = window.setInterval(refresh, 4000);
    return () => window.clearInterval(t);
  }, [open, refresh]);

  const create = async () => {
    setBusy(true);
    setError("");
    try {
      const r = await post<{ path: string; expires_at: string }>(`/api/active-sessions/${sessionId}/share`);
      setLink({ url: window.location.origin + r.path, expires: r.expires_at });
      refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    setBusy(true);
    try {
      await del(`/api/active-sessions/${sessionId}/share`);
      setLink(null);
      refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="md"
      title="Share this session"
      description="Let someone else watch what you are doing. They can only look: their keyboard and mouse never reach the remote computer."
      footer={
        <>
          {state?.shared && (
            <Button variant="danger" onClick={stop} loading={busy}>
              Stop sharing
            </Button>
          )}
          <Button onClick={() => onOpenChange(false)}>Close</Button>
        </>
      }
    >
      <div className="space-y-4 px-5 py-4 text-[13px]">
        {link ? (
          <div className="space-y-2">
            <p className="font-medium">Send this link</p>
            <div className="flex items-center gap-1 rounded-md border border-border bg-surface-2 px-3 py-2 font-mono text-xs">
              <span className="min-w-0 flex-1 select-all break-all">{link.url}</span>
              <CopyButton value={link.url} label="Copy link" />
            </div>
            <p className="text-xs text-subtle">Expires {relativeTime(link.expires)}, or when the session ends or you stop sharing.</p>
          </div>
        ) : (
          <Button icon={<Link2 className="h-4 w-4" />} onClick={create} loading={busy}>
            {state?.shared ? "Create another link" : "Create a view-only link"}
          </Button>
        )}
        <ul className="space-y-1.5 text-xs text-muted">
          <li className="flex items-center gap-2">
            <Users className="h-3.5 w-3.5" /> The person must sign in to emremote and be allowed to open sessions. Up to 5 can watch at once.
          </li>
          <li className="flex items-center gap-2">
            <Eye className="h-3.5 w-3.5" /> They see everything on your screen, including anything you type into a visible field. The audit log records who watched.
          </li>
        </ul>
        {state?.shared && (
          <p className="rounded-md border border-border px-3 py-2 text-xs">
            Sharing is on. {state.viewers === 0 ? "Nobody is watching right now." : `${state.viewers} ${state.viewers === 1 ? "person is" : "people are"} watching.`}
          </p>
        )}
        {error && <p className="text-xs text-danger">{error}</p>}
      </div>
    </Dialog>
  );
}
