import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import clsx from "clsx";
import { Columns2, ExternalLink, Grid2x2, Plus, Rows2, Square, X, Zap } from "lucide-react";
import { SessionView, type SessionInfo } from "./Session";
import { Dialog } from "@/components/ui/Dialog";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/Button";
import { OsIcon } from "@/components/OsIcon";
import { ProtocolBadge } from "@/components/Status";
import { QuickConnectDialog } from "@/components/QuickConnect";
import { useConnections } from "@/hooks/queries";
import { useAccess } from "@/lib/auth";
import { launchStandalone, WORKSPACE_CHANNEL, WORKSPACE_NAME } from "@/lib/launch";
import type { Connection, Protocol } from "@/lib/types";

// The workspace: several remote sessions as tabs, shown one at a time or side by
// side in 2 or 4 panes. Every session stays connected while hidden.

type LayoutName = "single" | "columns" | "rows" | "grid";
const LAYOUTS: { name: LayoutName; label: string; slots: number; icon: typeof Square }[] = [
  { name: "single", label: "One session", slots: 1, icon: Square },
  { name: "columns", label: "Two side by side", slots: 2, icon: Columns2 },
  { name: "rows", label: "Two stacked", slots: 2, icon: Rows2 },
  { name: "grid", label: "Four panes", slots: 4, icon: Grid2x2 },
];
const MAX_TABS = 8;
const LAYOUT_KEY = "emremote-workspace-layout";

interface Tab {
  key: string;
  connectionId: string;
  title: string;
  phase: SessionInfo["phase"];
  protocol?: Protocol;
}

function loadLayout(): LayoutName {
  try {
    const v = localStorage.getItem(LAYOUT_KEY) as LayoutName | null;
    if (v && LAYOUTS.some((l) => l.name === v)) return v;
  } catch {
    /* ignore */
  }
  return "single";
}

function slotStyle(layout: LayoutName, slot: number): React.CSSProperties {
  switch (layout) {
    case "columns":
      return { gridColumn: slot + 1, gridRow: 1 };
    case "rows":
      return { gridColumn: 1, gridRow: slot + 1 };
    case "grid":
      return { gridColumn: (slot % 2) + 1, gridRow: Math.floor(slot / 2) + 1 };
    default:
      return { gridColumn: 1, gridRow: 1 };
  }
}

function gridTemplate(layout: LayoutName): React.CSSProperties {
  const [c, r] = layout === "single" ? [1, 1] : layout === "columns" ? [2, 1] : layout === "rows" ? [1, 2] : [2, 2];
  return { gridTemplateColumns: `repeat(${c}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${r}, minmax(0, 1fr))` };
}

const dot = (t: Tab) =>
  t.phase === "connected" ? "bg-success" : t.phase === "error" ? "bg-danger" : t.phase === "disconnected" ? "bg-subtle" : "bg-warning animate-pulse";

function NewSessionDialog({ open, onOpenChange, onPick, onQuick }: { open: boolean; onOpenChange: (o: boolean) => void; onPick: (c: Connection) => void; onQuick?: () => void }) {
  const conns = useConnections();
  const [q, setQ] = useState("");
  useEffect(() => {
    if (open) setQ("");
  }, [open]);
  const list = useMemo(() => {
    const n = q.trim().toLowerCase();
    return (conns.data ?? []).filter((c) => !n || [c.device_name, c.name, c.device_address, c.protocol].some((x) => x.toLowerCase().includes(n))).slice(0, 80);
  }, [conns.data, q]);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="md"
      title="New session"
      description="Choose a device and connection method. It opens as a new tab."
      footer={
        onQuick ? (
          <Button icon={<Zap className="h-4 w-4" />} onClick={onQuick}>
            Quick connect…
          </Button>
        ) : undefined
      }
      bodyClassName="p-0"
    >
      <div className="border-b border-border p-3">
        <input className="input" placeholder="Search devices…" value={q} onChange={(e) => setQ(e.target.value)} autoFocus aria-label="Search devices" />
      </div>
      <ul className="max-h-[50vh] divide-y divide-border overflow-y-auto">
        {list.map((c) => (
          <li key={c.id}>
            <button className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-surface-2" onClick={() => onPick(c)}>
              <OsIcon os={c.device_os} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{c.device_name}</span>
                <span className="block truncate font-mono text-2xs text-subtle">
                  {c.device_address}:{c.port}
                </span>
              </span>
              <ProtocolBadge protocol={c.protocol} />
            </button>
          </li>
        ))}
        {conns.data && list.length === 0 && <li className="px-4 py-6 text-center text-sm text-subtle">No connection methods match.</li>}
      </ul>
    </Dialog>
  );
}

export default function WorkspacePage() {
  const { can } = useAccess();
  const [params, setParams] = useSearchParams();
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [layout, setLayoutState] = useState<LayoutName>(loadLayout);
  // Which tab key each pane shows (index = pane). Panes beyond the layout's count are hidden.
  const [slots, setSlots] = useState<(string | null)[]>([null, null, null, null]);
  const [activeSlot, setActiveSlot] = useState(0);
  const [picking, setPicking] = useState(false);
  const [quick, setQuick] = useState(false);
  const [notice, setNotice] = useState("");
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const slotsRef = useRef(slots);
  slotsRef.current = slots;
  const n = LAYOUTS.find((l) => l.name === layout)!.slots;

  const setLayout = (l: LayoutName) => {
    const count = LAYOUTS.find((x) => x.name === l)!.slots;
    setLayoutState(l);
    setActiveSlot((a) => Math.min(a, count - 1));
    // More panes: fill the empty ones with sessions that were hidden, in tab order.
    const next = [...slotsRef.current];
    const shown = new Set(next.slice(0, count));
    const hidden = tabsRef.current.filter((t) => !shown.has(t.key));
    for (let i = 0; i < count; i++) {
      if ((!next[i] || !tabsRef.current.some((t) => t.key === next[i])) && hidden.length) next[i] = hidden.shift()!.key;
    }
    setSlots(next);
    try {
      localStorage.setItem(LAYOUT_KEY, l);
    } catch {
      /* ignore */
    }
  };

  const addTab = useCallback(
    (connectionId: string) => {
      if (tabsRef.current.length >= MAX_TABS) {
        setNotice(`At most ${MAX_TABS} sessions can be open here. Close one first.`);
        return;
      }
      setNotice("");
      const key = Math.random().toString(36).slice(2, 10);
      setTabs((t) => [...t, { key, connectionId, title: "Connecting…", phase: "loading" }]);
      // A new session goes to the first empty pane, else replaces what the active pane shows.
      const visible = slotsRef.current.slice(0, n);
      const empty = visible.findIndex((x) => x === null || !tabsRef.current.some((t) => t.key === x));
      const target = empty >= 0 ? empty : Math.min(activeSlot, n - 1);
      setSlots((s) => s.map((x, i) => (i === target ? key : x)));
      setActiveSlot(target);
      setPicking(false);
      setQuick(false);
    },
    [activeSlot, n],
  );

  // Sessions requested by links elsewhere in the app: ?open=<id> on load, a broadcast afterwards.
  const opened = useRef(false);
  useEffect(() => {
    window.name = WORKSPACE_NAME;
    const id = params.get("open");
    if (id && !opened.current) {
      opened.current = true;
      addTab(id);
      setParams({}, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    const ch = new BroadcastChannel(WORKSPACE_CHANNEL);
    ch.onmessage = (e) => {
      if (e.data?.type === "open" && typeof e.data.id === "string") {
        addTab(e.data.id);
        ch.postMessage({ type: "ack", id: e.data.id });
      }
    };
    return () => ch.close();
  }, [addTab]);

  // Closing a live session asks first; a session that is still connecting or already ended closes at once.
  const [closing, setClosing] = useState<Tab | null>(null);
  const askClose = (t: Tab) => (t.phase === "connected" ? setClosing(t) : closeTab(t.key));

  const closeTab = (key: string) => {
    setTabs((t) => t.filter((x) => x.key !== key));
    setSlots((s) => s.map((x) => (x === key ? null : x)));
  };

  const show = (key: string) => {
    const at = slots.indexOf(key);
    if (at >= 0 && at < n) {
      setActiveSlot(at);
      return;
    }
    // Put it in the active pane (the session that was there is hidden, not closed).
    const target = Math.min(activeSlot, n - 1);
    setSlots((s) => s.map((x, i) => (i === target ? key : x === key ? null : x)));
  };

  const onInfo = useCallback((key: string, info: SessionInfo) => {
    setTabs((t) => t.map((x) => (x.key === key && (x.title !== info.title || x.phase !== info.phase || x.protocol !== info.protocol) ? { ...x, ...info } : x)));
  }, []);

  const activeKey = slots[Math.min(activeSlot, n - 1)];
  const activeTab = tabs.find((t) => t.key === activeKey);
  useEffect(() => {
    document.title = `${activeTab && activeTab.title !== "Connecting…" ? activeTab.title + " | " : ""}emremote workspace`;
  }, [activeTab]);

  // Warn before closing the window while sessions are open.
  useEffect(() => {
    if (!tabs.some((t) => t.phase === "connected")) return;
    const h = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [tabs]);

  const popOut = (t: Tab) => {
    launchStandalone(t.connectionId);
    closeTab(t.key);
  };

  return (
    <div className="dark flex h-full flex-col bg-[#05070a] text-fg" data-workspace>
      <header className="flex h-10 shrink-0 items-stretch gap-1 border-b border-white/10 bg-[#0b0d11] px-1.5" data-no-capture>
        <a href="/" target="emremote-main" rel="noopener" className="flex items-center px-2 text-xs font-semibold text-muted hover:text-fg" title="Open emremote in its own window">
          emremote
        </a>
        <div role="tablist" aria-label="Sessions" className="flex min-w-0 flex-1 items-end gap-0.5 overflow-x-auto pt-1.5">
          {tabs.map((t) => {
            const slot = slots.indexOf(t.key);
            const shown = slot >= 0 && slot < n;
            const current = shown && slot === activeSlot;
            return (
              <div
                key={t.key}
                role="tab"
                aria-selected={shown}
                className={clsx(
                  "group flex h-8 max-w-[220px] shrink-0 items-center gap-2 rounded-t-md border border-b-0 px-2.5 text-xs",
                  current ? "border-white/15 bg-[#05070a] text-fg" : shown ? "border-white/10 bg-white/[0.04] text-fg" : "border-transparent text-muted hover:bg-white/5 hover:text-fg",
                )}
                onAuxClick={(e) => e.button === 1 && askClose(t)}
              >
                <button className="flex min-w-0 items-center gap-2" onClick={() => show(t.key)} title={t.title}>
                  <span className={clsx("h-2 w-2 shrink-0 rounded-full", dot(t))} />
                  <span className="truncate">{t.title}</span>
                  {t.protocol && <ProtocolBadge protocol={t.protocol} className="shrink-0" />}
                </button>
                <button className="rounded p-0.5 text-subtle opacity-0 hover:bg-white/10 hover:text-fg group-hover:opacity-100 focus:opacity-100" onClick={() => popOut(t)} aria-label={`Open ${t.title} in its own window`} title="Open in its own window">
                  <ExternalLink className="h-3 w-3" />
                </button>
                <button className="rounded p-0.5 text-subtle hover:bg-white/10 hover:text-fg" onClick={() => askClose(t)} aria-label={`Close ${t.title}`} title="Close session">
                  <X className="h-3 w-3" />
                </button>
              </div>
            );
          })}
          {can("sessions.connect") && (
            <button className="mb-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted hover:bg-white/10 hover:text-fg" onClick={() => setPicking(true)} aria-label="New session" title="New session">
              <Plus className="h-4 w-4" />
            </button>
          )}
        </div>
        <div className="flex items-center gap-0.5 px-1" role="group" aria-label="Layout">
          {LAYOUTS.map((l) => (
            <button
              key={l.name}
              onClick={() => setLayout(l.name)}
              aria-pressed={layout === l.name}
              aria-label={l.label}
              title={l.label}
              className={clsx("flex h-7 w-7 items-center justify-center rounded-md", layout === l.name ? "bg-white/15 text-fg" : "text-muted hover:bg-white/10 hover:text-fg")}
            >
              <l.icon className="h-4 w-4" />
            </button>
          ))}
        </div>
      </header>
      {notice && (
        <p className="border-b border-warning/30 bg-warning/10 px-3 py-1.5 text-xs text-warning" role="status">
          {notice}
        </p>
      )}

      <div className="grid min-h-0 flex-1 gap-px bg-white/10" style={gridTemplate(layout)}>
        {tabs.map((t) => {
          const slot = slots.indexOf(t.key);
          const shown = slot >= 0 && slot < n;
          const current = shown && slot === activeSlot;
          return (
            <div
              key={t.key}
              style={shown ? slotStyle(layout, slot) : { display: "none" }}
              className={clsx("relative min-h-0 min-w-0 bg-[#05070a]", n > 1 && current && "outline outline-1 -outline-offset-1 outline-accent/70")}
              data-pane={shown ? slot : undefined}
              data-active-pane={current ? "" : undefined}
            >
              <SessionView
                connectionId={t.connectionId}
                active={current}
                embedded
                onInfo={(i) => onInfo(t.key, i)}
                onActivate={() => shown && setActiveSlot(slot)}
                onClose={() => closeTab(t.key)}
              />
            </div>
          );
        })}
        {Array.from({ length: n }, (_, i) => i)
          .filter((i) => !slots[i] || !tabs.some((t) => t.key === slots[i]))
          .map((i) => (
            <button
              key={`empty-${i}`}
              style={slotStyle(layout, i)}
              onClick={() => {
                setActiveSlot(i);
                // With sessions waiting in hidden tabs, just pick the pane and choose a tab; otherwise offer a new session.
                const waiting = tabs.some((t) => !slots.slice(0, n).includes(t.key));
                if (!waiting && can("sessions.connect")) setPicking(true);
              }}
              className={clsx(
                "flex min-h-0 min-w-0 flex-col items-center justify-center gap-2 bg-[#05070a] text-sm text-muted hover:text-fg",
                i === activeSlot && n > 1 && "outline outline-1 -outline-offset-1 outline-accent/70",
              )}
              aria-label={`Empty pane ${i + 1}: choose a session`}
            >
              <Plus className="h-5 w-5" />
              {tabs.length === 0 && i === 0 ? "Open a session to get started" : "Choose a session for this pane"}
            </button>
          ))}
      </div>

      <NewSessionDialog open={picking} onOpenChange={setPicking} onPick={(c) => addTab(c.id)} onQuick={can("quick.connect") ? () => { setPicking(false); setQuick(true); } : undefined} />
      <QuickConnectDialog open={quick} onOpenChange={setQuick} onLaunch={addTab} />
      <ConfirmDialog
        open={!!closing}
        onOpenChange={(o) => !o && setClosing(null)}
        title="Close this session?"
        confirmLabel="Close session"
        onConfirm={async () => {
          if (closing) closeTab(closing.key);
        }}
      >
        <p className="text-[13px] text-muted">
          <span className="font-medium text-fg">{closing?.title}</span> is connected. Closing it ends the session; anything you have not saved on the remote computer may be lost.
        </p>
      </ConfirmDialog>
    </div>
  );
}
