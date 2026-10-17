import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { ExternalLink, X } from "lucide-react";
import { SessionView, type SessionInfo } from "@/pages/Session";
import { ProtocolBadge } from "@/components/Status";
import { launchConnection } from "@/lib/launch";
import { onQuickView } from "@/lib/quickview";

/**
 * Shows one session in a large window over the current page. Closing the window ends the session.
 * It is not a Radix dialog on purpose: those close on Escape and trap keys, which a remote
 * session needs for itself.
 */
export function QuickViewHost() {
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const [info, setInfo] = useState<SessionInfo | null>(null);

  useEffect(
    () =>
      onQuickView((id) => {
        setInfo(null);
        setConnectionId(id);
      }),
    [],
  );
  useEffect(() => {
    if (!connectionId) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [connectionId]);

  if (!connectionId) return null;
  const close = () => setConnectionId(null);
  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-3 backdrop-blur-sm sm:p-6" role="region" aria-label="Quick view">
      <div className="flex h-full max-h-[900px] w-full max-w-[1400px] flex-col overflow-hidden rounded-xl border border-white/15 bg-[#05070a] shadow-2xl">
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-white/10 bg-white/[0.03] px-3 text-xs">
          <span className="truncate font-medium text-fg">{info?.title ?? "Connecting…"}</span>
          {info?.protocol && <ProtocolBadge protocol={info.protocol} className="shrink-0" />}
          <span className="ml-auto hidden text-subtle sm:inline">Closing this window ends the session</span>
          <button
            className="flex items-center gap-1 rounded px-2 py-1 text-muted hover:bg-white/10 hover:text-fg"
            onClick={() => {
              const id = connectionId;
              close();
              launchConnection(id);
            }}
            title="Move this session to the workspace window (it reconnects there)"
          >
            <ExternalLink className="h-3.5 w-3.5" /> Open in window
          </button>
          <button className="rounded p-1.5 text-muted hover:bg-white/10 hover:text-fg" onClick={close} aria-label="Close quick view" title="Close and end the session">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="relative min-h-0 flex-1" data-pane="quick">
          <SessionView key={connectionId} connectionId={connectionId} active embedded onInfo={setInfo} onClose={close} />
        </div>
      </div>
    </div>,
    document.body,
  );
}
