import { useAccess, useAuth } from "@/lib/auth";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import * as RD from "@radix-ui/react-dialog";
import clsx from "clsx";
import {
  ArrowLeftRight,
  BarChart3,
  Cable,
  Columns2,
  CornerDownLeft,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Monitor,
  Moon,
  Plus,
  ScrollText,
  Search,
  Settings,
  Star,
  Sun,
  Users,
  Zap,
} from "lucide-react";
import { useDevices } from "@/hooks/queries";
import { useTheme } from "@/lib/theme";
import { OsIcon } from "./OsIcon";
import { ProtocolBadge } from "./Status";
import { launchConnection, openWorkspaceWindow } from "@/lib/launch";
import type { ConnectionSummary, Device } from "@/lib/types";

type Item =
  | { kind: "connection"; device: Device; connection: ConnectionSummary }
  | { kind: "device"; device: Device }
  | { kind: "command"; id: string; label: string; icon: ReactNode; hint?: string; keywords: string; run: () => void };

interface Section {
  title: string;
  items: Item[];
}

/** Ctrl/⌘+K: jump anywhere, run a quick action, or find a device and connect, all from the keyboard. */
export function CommandPalette({
  open,
  onOpenChange,
  onAddDevice,
  onQuickConnect,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onAddDevice?: () => void;
  onQuickConnect?: () => void;
}) {
  const devices = useDevices();
  const navigate = useNavigate();
  const { can, isAdmin } = useAccess();
  const { logout } = useAuth();
  const [theme, setTheme] = useTheme();
  const dark = theme === "dark" || (theme === "system" && document.documentElement.classList.contains("dark"));
  const [q, setQ] = useState("");
  const [index, setIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setQ("");
      setIndex(0);
    }
  }, [open]);

  const sections = useMemo<Section[]>(() => {
    const go = (to: string) => () => navigate(to);
    const icon = (I: typeof Plus) => <I className="h-4 w-4" />;
    const cmd = (id: string, label: string, I: typeof Plus, run: () => void, keywords = "", hint?: string): Item => ({ kind: "command", id, label, icon: icon(I), run, keywords: `${label} ${keywords}`.toLowerCase(), hint });

    const actions: Item[] = [];
    if (can("inventory.manage") && onAddDevice) actions.push(cmd("add", "Add device", Plus, onAddDevice, "new create server computer"));
    if (can("quick.connect") && onQuickConnect) actions.push(cmd("quick", "Quick connect", Zap, onQuickConnect, "connect ssh rdp vnc telnet temporary"));
    if (can("sessions.connect")) actions.push(cmd("workspace", "Open the session workspace", Columns2, () => openWorkspaceWindow(), "tabs split panes sessions window"));
    actions.push(cmd("theme", dark ? "Switch to the light theme" : "Switch to the dark theme", dark ? Sun : Moon, () => setTheme(dark ? "light" : "dark"), "appearance dark light mode"));
    actions.push(cmd("signout", "Sign out", LogOut, () => logout(), "logout log out exit"));

    const pages: Item[] = [
      cmd("p-overview", "Overview", LayoutDashboard, go("/"), "home dashboard"),
      cmd("p-devices", "All devices", Monitor, go("/devices"), "inventory list"),
      cmd("p-favorites", "Favorites", Star, go("/favorites"), "starred"),
      cmd("p-stats", "Statistics", BarChart3, go("/statistics"), "charts usage"),
    ];
    if (can("files.use")) pages.push(cmd("p-transfer", "SFTP transfer", ArrowLeftRight, go("/transfer"), "files copy upload download"));
    pages.push(cmd("p-methods", "Connection methods", Cable, go("/connections"), "protocols rdp ssh vnc telnet"));
    if (can("credentials.manage")) pages.push(cmd("p-creds", "Credentials", KeyRound, go("/credentials"), "passwords keys saved"));
    if (isAdmin) pages.push(cmd("p-users", "Users", Users, go("/users"), "teams accounts admin"));
    pages.push(cmd("p-activity", isAdmin ? "Activity log" : "My activity", ScrollText, go("/activity"), "audit history events"));
    pages.push(cmd("p-settings", "Settings", Settings, go("/settings"), "account password two-factor terminal jump hosts"));

    const n = q.trim().toLowerCase();
    const match = (list: Item[]) => (n ? list.filter((i) => i.kind === "command" && i.keywords.includes(n)) : list);

    const devs: Item[] = [];
    const sorted = [...(devices.data ?? [])];
    if (!n) sorted.sort((a, b) => (b.last_accessed_at ?? "").localeCompare(a.last_accessed_at ?? ""));
    for (const d of sorted) {
      const hay = [d.name, d.address, d.hostname, d.group_name ?? "", d.facts?.os ?? "", ...d.tags].join(" ").toLowerCase();
      if (n && !hay.includes(n)) continue;
      if (can("sessions.connect")) for (const c of d.connections) devs.push({ kind: "connection", device: d, connection: c });
      devs.push({ kind: "device", device: d });
    }
    // With nothing typed, show only the most recently used devices after the shortcuts.
    const deviceItems = devs.slice(0, n ? 40 : 8);

    const out: Section[] = [];
    const a = match(actions);
    const p = match(pages);
    if (n) {
      if (deviceItems.length) out.push({ title: "Devices", items: deviceItems });
      if (a.length) out.push({ title: "Quick actions", items: a });
      if (p.length) out.push({ title: "Go to", items: p });
    } else {
      out.push({ title: "Quick actions", items: a }, { title: "Go to", items: p });
      if (deviceItems.length) out.push({ title: "Recent devices", items: deviceItems });
    }
    return out.filter((s) => s.items.length);
  }, [devices.data, q, can, isAdmin, dark, onAddDevice, onQuickConnect, logout, navigate, setTheme]);

  const flat = useMemo(() => sections.flatMap((s) => s.items), [sections]);

  useEffect(() => setIndex(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${index}"]`)?.scrollIntoView({ block: "nearest" });
  }, [index]);

  const run = (it: Item) => {
    onOpenChange(false);
    if (it.kind === "connection") launchConnection(it.connection.id);
    else if (it.kind === "device") navigate(`/devices/${it.device.id}`);
    else it.run();
  };

  let counter = -1;
  return (
    <RD.Root open={open} onOpenChange={onOpenChange}>
      <RD.Portal>
        <RD.Overlay className="fixed inset-0 z-40 bg-black/50 animate-fade-in" />
        <RD.Content
          className="fixed left-1/2 top-[12vh] z-50 w-[calc(100vw-1.5rem)] max-w-xl -translate-x-1/2 overflow-hidden rounded-xl border border-border bg-surface shadow-pop animate-palette-in focus:outline-none"
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setIndex((i) => Math.min(flat.length - 1, i + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setIndex((i) => Math.max(0, i - 1));
            } else if (e.key === "Enter" && flat[index]) {
              e.preventDefault();
              run(flat[index]);
            }
          }}
        >
          <RD.Title className="sr-only">Search and quick actions</RD.Title>
          <RD.Description className="sr-only">Type to filter pages, actions, devices and connection methods. Enter opens the selected item.</RD.Description>
          <div className="flex items-center gap-3 border-b border-border px-4">
            <Search className="h-4 w-4 text-subtle" />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search devices, pages and actions…"
              className="h-12 flex-1 bg-transparent text-sm outline-none placeholder:text-subtle focus-visible:ring-0"
              aria-label="Search"
            />
            <kbd className="kbd">Esc</kbd>
          </div>
          <div ref={listRef} className="max-h-[56vh] overflow-y-auto p-1.5">
            {flat.length === 0 && (
              <p className="px-3 py-8 text-center text-sm text-subtle">{q ? "No matches" : "Nothing to show"}</p>
            )}
            {sections.map((s) => (
              <div key={s.title} className="mb-1 last:mb-0">
                <p className="px-3 pb-1 pt-2 text-[11px] font-medium uppercase tracking-[0.06em] text-subtle">{s.title}</p>
                {s.items.map((it) => {
                  counter++;
                  const i = counter;
                  return (
                    <button
                      key={it.kind === "connection" ? it.connection.id : it.kind === "device" ? it.device.id + "-d" : it.id}
                      data-index={i}
                      onMouseMove={() => setIndex(i)}
                      onClick={() => run(it)}
                      className={clsx("flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm", i === index ? "bg-surface-2" : "")}
                    >
                      {it.kind === "command" ? (
                        <>
                          <span className="flex h-5 w-5 items-center justify-center text-muted">{it.icon}</span>
                          <span className="min-w-0 flex-1 truncate">{it.label}</span>
                        </>
                      ) : (
                        <>
                          <OsIcon os={it.device.os} distro={it.device.facts?.os} />
                          <span className="min-w-0 flex-1 truncate">
                            <span className="font-medium">{it.device.name}</span>
                            <span className="ml-2 font-mono text-xs text-subtle">{it.device.address}</span>
                          </span>
                          {it.kind === "connection" ? (
                            <span className="flex items-center gap-2 text-xs text-muted">
                              Connect <ProtocolBadge protocol={it.connection.protocol} />
                            </span>
                          ) : (
                            <span className="flex items-center gap-1.5 text-xs text-muted">
                              <Monitor className="h-3.5 w-3.5" /> Open device
                            </span>
                          )}
                        </>
                      )}
                      {i === index && <CornerDownLeft className="h-3.5 w-3.5 text-subtle" />}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
          <div className="flex items-center gap-4 border-t border-border bg-surface-2/40 px-4 py-2 text-[11px] text-subtle">
            <span className="flex items-center gap-1.5"><kbd className="kbd">↑</kbd><kbd className="kbd">↓</kbd> move</span>
            <span className="flex items-center gap-1.5"><kbd className="kbd">Enter</kbd> open</span>
            <span className="flex items-center gap-1.5"><kbd className="kbd">Esc</kbd> close</span>
          </div>
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  );
}
