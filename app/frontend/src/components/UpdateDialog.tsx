import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Download, ExternalLink } from "lucide-react";
import { Dialog } from "./ui/Dialog";
import { Button } from "./ui/Button";
import { Spinner } from "./ui/Spinner";
import { CopyButton } from "./ui/misc";
import { get, post, errorMessage } from "@/lib/api";

interface UpdateStatus {
  current: string;
  latest: string;
  available: boolean;
  updater: "ready" | "missing";
  state: "idle" | "running" | "done" | "failed";
  from: string;
  log: string[];
}

type Phase = "idle" | "running" | "restarting" | "done" | "failed";

const RESTART_LIMIT_MS = 5 * 60 * 1000;

/** Updating emremote from the interface. It needs the optional updater container (see docs/DEPLOYMENT.md). */
export function UpdateDialog({ open, onOpenChange, releaseUrl }: { open: boolean; onOpenChange: (o: boolean) => void; releaseUrl?: string }) {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState("");
  const [starting, setStarting] = useState(false);
  const logRef = useRef<HTMLPreElement>(null);
  const sawDown = useRef(false);
  const downSince = useRef(0);
  const readyChecks = useRef(0);

  const refresh = useCallback(async () => {
    try {
      const s = await get<UpdateStatus>("/api/update");
      sawDown.current = false;
      setStatus(s);
      setPhase((p) => {
        if (s.state === "running") return "running";
        if (s.state === "failed" && (p === "running" || p === "restarting")) return "failed";
        if (s.state === "done" && (p === "running" || p === "restarting")) return "done";
        return p === "idle" || p === "failed" || p === "done" ? p : "idle";
      });
      return s;
    } catch {
      return null;
    }
  }, []);

  // Opening the window shows the current state; an update that is already running is picked up.
  useEffect(() => {
    if (!open) return;
    setError("");
    refresh().then((s) => {
      if (s && s.state === "running") setPhase("running");
      else if (s) setPhase("idle");
    });
  }, [open, refresh]);

  // While an update runs: read the log; when the server goes away it is restarting, so wait for it to come back.
  useEffect(() => {
    if (!open || (phase !== "running" && phase !== "restarting")) return;
    const t = setInterval(async () => {
      if (phase === "running") {
        try {
          const s = await get<UpdateStatus>("/api/update");
          sawDown.current = false;
          setStatus(s);
          if (s.state === "failed") setPhase("failed");
          else if (s.state === "done") setPhase("done");
        } catch {
          // Gone (restart) or signed out by the restart: from here on only the health check matters.
          sawDown.current = true;
          downSince.current = Date.now();
          readyChecks.current = 0;
          setPhase("restarting");
        }
        return;
      }
      if (Date.now() - downSince.current > RESTART_LIMIT_MS) {
        setError("emremote did not come back within five minutes. Check the server: docker compose ps, docker compose logs emremote.");
        setPhase("failed");
        return;
      }
      try {
        // Back only when the health check passes and the application answers (200, or 401 because the restart signed everyone out) twice in a row.
        const r = await fetch("/healthz", { cache: "no-store" });
        const m = r.ok ? await fetch("/api/auth/me", { cache: "no-store" }) : null;
        readyChecks.current = m && (m.status === 200 || m.status === 401) ? readyChecks.current + 1 : 0;
        if (readyChecks.current >= 2 && sawDown.current) setPhase("done");
      } catch {
        /* still restarting */
      }
    }, 1000);
    return () => clearInterval(t);
  }, [open, phase]);

  // The new version is running: reload, which lands on the sign-in page (saved passwords are locked after a restart).
  useEffect(() => {
    if (phase !== "done" || !sawDown.current) return;
    const t = setTimeout(() => window.location.reload(), 2500);
    return () => clearTimeout(t);
  }, [phase]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [status?.log.length, phase]);

  const start = async () => {
    setStarting(true);
    setError("");
    try {
      await post("/api/update", {});
      sawDown.current = false;
      setPhase("running");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setStarting(false);
    }
  };

  const busy = phase === "running" || phase === "restarting";
  const ready = status?.updater === "ready";
  const to = status?.latest ?? "";
  const log = status?.log ?? [];

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Update emremote"
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {busy ? "Hide" : "Close"}
          </Button>
          {phase === "idle" && ready && status?.available && (
            <Button variant="primary" icon={<Download className="h-3.5 w-3.5" />} onClick={start} loading={starting}>
              Update now
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-4 text-[13px]">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="font-mono text-sm">
            v{status?.current ?? "…"} <span className="text-subtle">→</span> {to ? `v${to}` : "…"}
          </span>
          {releaseUrl && (
            <a href={releaseUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-accent hover:underline">
              Release notes <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>

        {phase === "idle" && status && !status.available && <p className="text-muted">This is the newest version.</p>}

        {phase === "idle" && status?.available && ready && (
          <div className="space-y-2 text-muted">
            <p>emremote will:</p>
            <ol className="list-decimal space-y-0.5 pl-5">
              <li>back up the database,</li>
              <li>download the new version,</li>
              <li>restart (about a minute), and go back to the old version if the new one does not start.</li>
            </ol>
            <p>
              Running remote sessions end. You will be asked to sign in again afterwards, because saved passwords are locked whenever emremote
              restarts.
            </p>
          </div>
        )}

        {phase === "idle" && status?.available && !ready && (
          <div className="space-y-3 text-muted">
            <p>Updating from this window needs the optional updater, which is not running on this server. You can update on the server instead:</p>
            <Command text="scripts/update.sh" note="in the install folder; it backs up, downloads, restarts and checks" />
            <p>To turn on the Update button (it needs access to Docker, see the security note in docs/DEPLOYMENT.md):</p>
            <Command text="echo 'COMPOSE_PROFILES=updater' >> .env && docker compose up -d" note="in the install folder" />
          </div>
        )}

        {(busy || phase === "failed" || (phase === "done" && log.length > 0)) && (
          <pre
            ref={logRef}
            className="max-h-64 overflow-auto rounded-lg border border-border bg-surface-2/60 p-3 font-mono text-[11.5px] leading-relaxed text-fg/90"
            aria-label="Update progress"
          >
            {log.length ? log.join("\n") : "Starting…"}
          </pre>
        )}

        {busy && (
          <p className="flex items-center gap-2 text-muted">
            <Spinner className="h-4 w-4" />
            {phase === "restarting" ? "emremote is restarting. This page reloads when it is back…" : "Updating…"}
          </p>
        )}
        {phase === "done" && (
          <p className="flex items-center gap-2 text-success">
            <CheckCircle2 className="h-4 w-4" /> {sawDown.current ? "Updated. Reloading…" : "Done."}
          </p>
        )}
        {phase === "failed" && (
          <p className="flex items-start gap-2 text-danger">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> The update did not finish. The log above says why. Your data was not touched, and a backup was made first.
          </p>
        )}
        {error && <p className="text-danger">{error}</p>}
      </div>
    </Dialog>
  );
}

function Command({ text, note }: { text: string; note: string }) {
  return (
    <div>
      <div className="flex items-center gap-2 rounded-lg border border-border bg-surface-2/60 px-3 py-2 font-mono text-xs text-fg">
        <span className="min-w-0 flex-1 break-all">{text}</span>
        <CopyButton value={text} label="Copy command" />
      </div>
      <p className="mt-1 text-xs text-subtle">{note}</p>
    </div>
  );
}
