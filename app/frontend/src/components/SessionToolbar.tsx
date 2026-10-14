import { useEffect, useRef, useState, type ReactNode } from "react";
import clsx from "clsx";
import {
  GripVertical,
  ZoomIn,
  ZoomOut,
  Maximize2,
  Maximize,
  Minimize,
  ChevronDown,
  ChevronsLeftRight,
  EyeOff,
  FolderOpen,
  ClipboardList,
  MonitorCog,
  Power,
  RotateCw,
  Keyboard,
  Braces,
  Camera,
  Crop,
  Monitor,
  Share2,
  Minus,
  Plus,
} from "lucide-react";
import { Menu, MenuCheckbox, MenuContent, MenuItem, MenuLabel, MenuRadio, MenuSeparator, MenuTrigger } from "./ui/Menu";
import type { Protocol } from "@/lib/types";
import { K, PROFILE_KEYS, type SessionProfile } from "@/lib/sessionProfile";
import { TerminalAppearance, type TerminalAppearanceProps } from "./TerminalAppearance";


export type Resolution = "window" | "monitor" | "1280x720" | "1600x900" | "1920x1080" | "2560x1440" | "3840x2160";

export interface ToolbarProps {
  protocol?: Protocol;
  /** What the remote side is; decides which keys and controls are offered. */
  profile: SessionProfile;
  /** SSH and Telnet only: the look of the terminal. */
  terminalAppearance?: TerminalAppearanceProps;
  title: ReactNode;
  status: ReactNode;
  connected: boolean;
  zoomLabel: string;
  fit: boolean;
  onZoom: (delta: number) => void;
  onFit: () => void;
  onActualSize: () => void;
  latched: Set<number>;
  onLatch: (keysym: number) => void;
  onKeys: (...keysyms: number[]) => void;
  filesAvailable: boolean;
  filesOpen: boolean;
  onFiles: () => void;
  clipOpen: boolean;
  onClipboard: () => void;
  /** Terminal sessions only: personal command snippets. */
  snippetsOpen?: boolean;
  onSnippets?: () => void;
  /** Saves a picture of the remote screen: all of it, or an area the user selects. */
  onScreenshot?: (mode: "full" | "area") => void;
  /** Opens the dialog for sharing this session (view only). */
  onShare?: () => void;
  shared?: boolean;
  resolution: Resolution;
  onResolution: (r: Resolution) => void;
  nativeDensity: boolean;
  onNativeDensity: (v: boolean) => void;
  keyboardInfo?: string;
  /** RDP only: current layout setting and the choices offered in the menu. */
  keyboardLayout?: string;
  keyboardOptions?: { value: string; label: string }[];
  onKeyboardLayout?: (layout: string) => void;
  remoteSize?: string;
  fullscreen: boolean;
  onFullscreen: () => void;
  onDisconnect: () => void;
  onReconnect: () => void;
  canReconnect: boolean;
  /** In a workspace with several panes, only the focused pane reacts to the toolbar shortcut. */
  active?: boolean;
  /** Width of side panels docked left/right; the toolbar stays clear of them. */
  insetLeft?: number;
  insetRight?: number;
}

const STORE = "emremote-session-toolbar";

interface Placement {
  x: number; // centre, px from the left edge
  y: number; // px from the top edge
  collapsed: boolean;
  hidden: boolean; // fully hidden; revealed from the top edge or Ctrl+Alt+Shift+T
}

function loadPlacement(): Placement {
  try {
    const p = JSON.parse(localStorage.getItem(STORE) || "{}");
    // The horizontal position is never restored: it starts centred in every window or pane, whatever their size was before.
    return { x: -1, y: typeof p.y === "number" ? p.y : 10, collapsed: !!p.collapsed, hidden: !!p.hidden };
  } catch {
    return { x: -1, y: 10, collapsed: false, hidden: false };
  }
}

function Key({ children, onClick, active, title, wide }: { children: ReactNode; onClick: () => void; active?: boolean; title?: string; wide?: boolean }) {
  return (
    <button
      type="button"
      title={title}
      aria-pressed={active}
      onMouseDown={(e) => e.preventDefault()} // keep focus on the remote screen
      onClick={onClick}
      className={clsx(
        "flex h-7 items-center justify-center rounded-md font-mono text-[12px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/30 active:scale-95",
        wide ? "px-2" : "min-w-[28px] px-1.5",
        active ? "bg-fg text-bg" : "text-muted hover:bg-white/10 hover:text-fg",
      )}
    >
      {children}
    </button>
  );
}

const SHORTCUT_TITLES: Record<SessionProfile, string> = {
  windows: "Windows shortcuts",
  mac: "macOS shortcuts",
  linux: "Desktop shortcuts",
  terminal: "Terminal shortcuts",
};

/** A cluster of related controls on a slightly lighter plate. */
function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div role="group" aria-label={label} className="flex items-center gap-0.5 rounded-lg bg-white/[0.045] p-0.5">
      {children}
    </div>
  );
}

/**
 * Floating, draggable session toolbar (collapsible to a small pill). It never
 * reserves screen space, so the remote desktop always uses the whole window.
 */
export function SessionToolbar(p: ToolbarProps) {
  const [place, setPlace] = useState<Placement>(loadPlacement);
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ dx: number; dy: number } | null>(null);
  // The toolbar floats inside whatever area it is placed in (the whole window, or one
  // pane of a workspace). The anchor fills that area so its size and position can be measured.
  const anchor = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: window.innerWidth, h: window.innerHeight, left: 0, top: 0 });
  const measure = () => {
    const r = anchor.current?.getBoundingClientRect();
    if (r && r.width > 0 && r.height > 0) setBox((b) => (b.w === r.width && b.h === r.height && b.left === r.left && b.top === r.top ? b : { w: r.width, h: r.height, left: r.left, top: r.top }));
  };
  useEffect(() => {
    measure();
    const el = anchor.current;
    if (!el) return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const save = (n: Placement) => {
    setPlace(n);
    try {
      localStorage.setItem(STORE, JSON.stringify(n));
    } catch {
      /* ignore */
    }
  };

  const left = p.insetLeft ?? 0;
  const right = p.insetRight ?? 0;
  const areaCentre = () => left + (box.w - left - right) / 2;

  // Keep the toolbar over the remote screen: inside the window and clear of
  // any docked side panel (so it never covers a panel's controls).
  const clamp = (x: number, y: number) => {
    const w = ref.current?.offsetWidth ?? 300;
    const h = ref.current?.offsetHeight ?? 40;
    const lo = left + w / 2 + 4;
    const hi = box.w - right - w / 2 - 4;
    return {
      x: lo > hi ? areaCentre() : Math.min(Math.max(x, lo), hi),
      y: Math.min(Math.max(y, 4), box.h - h - 4),
    };
  };
  useEffect(() => {
    // Centred (x < 0) stays centred; only a position the user dragged to is kept inside the area.
    const onResize = () => setPlace((pl) => (pl.x < 0 ? { ...pl, y: clamp(0, pl.y).y } : { ...pl, ...clamp(pl.x, pl.y) }));
    window.addEventListener("resize", onResize);
    onResize();
    const raf = requestAnimationFrame(onResize); // again once the new width is laid out
    return () => {
      window.removeEventListener("resize", onResize);
      cancelAnimationFrame(raf);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [place.collapsed, left, right, box.w, box.h]);

  // The toolbar's own size changes as it wraps or its content loads: re-check that it fits.
  const [, bump] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => bump((n) => n + 1));
    ro.observe(el);
    return () => ro.disconnect();
  }, [place.collapsed, place.hidden]);

  // Ctrl+Alt+Shift+T toggles the toolbar (captured before the remote session sees the T).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (p.active === false) return;
      if (e.ctrlKey && e.altKey && e.shiftKey && e.code === "KeyT") {
        e.preventDefault();
        e.stopPropagation();
        setPlace((pl) => {
          const n = { ...pl, hidden: !pl.hidden, collapsed: false };
          try {
            localStorage.setItem(STORE, JSON.stringify(n));
          } catch {
            /* ignore */
          }
          return n;
        });
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [p.active]);

  const startDrag = (e: React.PointerEvent) => {
    measure();
    const rect = ref.current!.getBoundingClientRect();
    drag.current = { dx: e.clientX - (rect.left + rect.width / 2), dy: e.clientY - rect.top };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onDrag = (e: React.PointerEvent) => {
    if (!drag.current) return;
    setPlace((pl) => ({ ...pl, ...clamp(e.clientX - box.left - drag.current!.dx, e.clientY - box.top - drag.current!.dy) }));
  };
  const endDrag = () => {
    if (!drag.current) return;
    drag.current = null;
    save(place);
  };

  const x = place.x < 0 ? areaCentre() : clamp(place.x, place.y).x;
  const keys = PROFILE_KEYS[p.profile];
  const terminal = p.profile === "terminal";
  // Only RDP can change the remote resolution; VNC keeps the server's size and terminals follow the window.
  const displayMenu = p.protocol === "rdp";
  const grip = (
    <span
      onPointerDown={startDrag}
      onPointerMove={onDrag}
      onPointerUp={endDrag}
      className="flex h-7 w-5 shrink-0 cursor-grab touch-none items-center justify-center text-subtle active:cursor-grabbing"
      title="Drag to move"
      aria-label="Move toolbar"
    >
      <GripVertical className="h-4 w-4" />
    </span>
  );

  if (place.hidden)
    return (
      // Invisible strip at the top edge; hovering it reveals a small handle.
      <>
      <div ref={anchor} className="pointer-events-none absolute inset-0 -z-10" aria-hidden="true" />
      <div data-no-capture className="group absolute left-1/2 top-0 z-30 flex h-6 w-56 -translate-x-1/2 items-start justify-center">
        <button
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => save({ ...place, hidden: false })}
          title="Show toolbar (Ctrl+Alt+Shift+T)"
          aria-label="Show toolbar"
          className="flex h-5 items-center gap-1 rounded-b-lg border border-t-0 border-white/10 bg-[#111317]/95 px-3 text-[11px] text-muted opacity-0 shadow-lg transition-opacity duration-150 hover:text-fg focus:opacity-100 group-hover:opacity-100"
        >
          <ChevronDown className="h-3.5 w-3.5" /> Toolbar
        </button>
      </div>
      </>
    );

  return (
    <>
    <div ref={anchor} className="pointer-events-none absolute inset-0 -z-10" aria-hidden="true" />
    <div
      ref={ref}
      data-no-capture
      role="toolbar"
      aria-label="Session toolbar"
      style={{ left: x, top: place.y, transform: "translateX(-50%)", maxWidth: box.w - left - right - 8 }}
      className={clsx(
        "absolute z-30 flex w-max items-center rounded-xl border border-white/10 bg-[#111317]/95 p-1 text-fg shadow-[0_8px_30px_rgb(0_0_0/0.5)] backdrop-blur",
        place.collapsed && p.fullscreen && "opacity-50 transition-opacity hover:opacity-100",
      )}
    >
      {grip}
      {place.collapsed ? (
        <>
          <span className="flex items-center gap-2 px-1.5 text-xs">{p.status}</span>
          <Key title="Show toolbar" onClick={() => save({ ...place, collapsed: false })}>
            <ChevronsLeftRight className="h-4 w-4" />
          </Key>
          <Key title="Hide completely (Ctrl+Alt+Shift+T)" onClick={() => save({ ...place, hidden: true })}>
            <EyeOff className="h-4 w-4" />
          </Key>
        </>
      ) : (
        <div className="flex flex-wrap items-center justify-center gap-1">
          <span className="flex max-w-[220px] items-center gap-2 truncate rounded-lg bg-white/[0.04] px-2.5 py-1 text-xs" title={typeof p.title === "string" ? p.title : undefined}>
            {p.status}
          </span>
          {terminal && p.terminalAppearance && (
            <Group label="Text size">
              <Key title="Smaller text (reconnects)" onClick={() => p.terminalAppearance!.onChange({ font_size: Math.max(6, p.terminalAppearance!.current.font_size - 1) })}>
                <Minus className="h-4 w-4" />
              </Key>
              <span className="min-w-[2.6rem] select-none text-center font-mono text-[11px] tabular-nums text-muted" title="Text size in points">
                {p.terminalAppearance.current.font_size} pt
              </span>
              <Key title="Larger text (reconnects)" onClick={() => p.terminalAppearance!.onChange({ font_size: Math.min(48, p.terminalAppearance!.current.font_size + 1) })}>
                <Plus className="h-4 w-4" />
              </Key>
            </Group>
          )}
          {!terminal && (
            <Group label="Zoom">
              <Key title="Zoom out" onClick={() => p.onZoom(-10)}>
                <ZoomOut className="h-4 w-4" />
              </Key>
              <Key title="Actual size (100%)" onClick={p.onActualSize} wide>
                {p.zoomLabel}
              </Key>
              <Key title="Zoom in" onClick={() => p.onZoom(10)}>
                <ZoomIn className="h-4 w-4" />
              </Key>
              <Key title="Fit to window" onClick={p.onFit} active={p.fit}>
                <Maximize2 className="h-4 w-4" />
              </Key>
            </Group>
          )}
          <Group label="Quick keys">
            {keys.quick.map((k) => (
              <Key key={k.label} title={k.hint ? `${k.hint} (${k.label})` : k.label} onClick={() => p.onKeys(...k.keys)} wide>
                {k.label}
              </Key>
            ))}
          </Group>
          <Group label="Modifier keys">
            {keys.modifiers.map((m) => (
              <Key key={m.keysym} title={m.title} active={p.latched.has(m.keysym)} onClick={() => p.onLatch(m.keysym)} wide>
                {m.label}
              </Key>
            ))}
          </Group>
          <Group label="Tools">
          <Menu>
              <MenuTrigger asChild>
                <button className="flex h-7 min-w-[28px] items-center justify-center rounded-md px-1.5 text-muted hover:bg-white/10 hover:text-fg" title="Keyboard shortcuts" aria-label="Keyboard shortcuts">
                  <Keyboard className="h-4 w-4" />
                </button>
              </MenuTrigger>
              <MenuContent>
                <MenuLabel>{SHORTCUT_TITLES[p.profile]}</MenuLabel>
                {keys.shortcuts.map((k) => (
                  <MenuItem key={k.label} onSelect={() => p.onKeys(...k.keys)} shortcut={k.hint}>
                    {k.label}
                  </MenuItem>
                ))}
                {keys.navigation && (
                  <>
                    <MenuSeparator />
                    <MenuLabel>Special keys</MenuLabel>
                    {(
                      [
                        ["Esc", K.Escape],
                        ["Tab", K.Tab],
                        ["Home", K.Home],
                        ["End", K.End],
                        ["Page Up", K.PageUp],
                        ["Page Down", K.PageDown],
                        ["Arrow up", K.Up],
                        ["Arrow down", K.Down],
                        ["Arrow left", K.Left],
                        ["Arrow right", K.Right],
                      ] as [string, number][]
                    ).map(([label, k]) => (
                      <MenuItem key={label} onSelect={() => p.onKeys(k)}>
                        {label}
                      </MenuItem>
                    ))}
                  </>
                )}
              </MenuContent>
            </Menu>
            {p.filesAvailable && (
              <Key title={p.protocol === "ssh" ? "Files (SFTP)" : "Transfer drive"} active={p.filesOpen} onClick={p.onFiles}>
                <FolderOpen className="h-4 w-4" />
              </Key>
            )}
            {p.onSnippets && (
              <Key title="Snippets" active={p.snippetsOpen} onClick={p.onSnippets}>
                <Braces className="h-4 w-4" />
              </Key>
            )}
            {p.onScreenshot && (
              <Menu>
                <MenuTrigger asChild>
                  <button
                    className="flex h-7 min-w-[28px] items-center justify-center rounded-md px-1.5 text-muted transition-colors hover:bg-white/10 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/30"
                    title="Screenshot"
                    aria-label="Screenshot"
                  >
                    <Camera className="h-4 w-4" />
                  </button>
                </MenuTrigger>
                <MenuContent>
                  <MenuLabel>Screenshot (downloads a PNG)</MenuLabel>
                  <MenuItem icon={<Monitor className="h-4 w-4" />} onSelect={() => p.onScreenshot!("full")}>
                    Whole screen
                  </MenuItem>
                  <MenuItem icon={<Crop className="h-4 w-4" />} onSelect={() => p.onScreenshot!("area")}>
                    Select an area…
                  </MenuItem>
                </MenuContent>
              </Menu>
            )}
            {p.onShare && (
              <Key title={p.shared ? "Sharing is on (view only)" : "Share this session (view only)"} active={p.shared} onClick={p.onShare}>
                <Share2 className="h-4 w-4" />
              </Key>
            )}
            <Key title="Clipboard" active={p.clipOpen} onClick={p.onClipboard}>
              <ClipboardList className="h-4 w-4" />
            </Key>
            {p.terminalAppearance && <TerminalAppearance {...p.terminalAppearance} />}
          {displayMenu && (
          <Menu>
            <MenuTrigger asChild>
              <button className="flex h-7 min-w-[28px] items-center justify-center rounded-md px-1.5 text-muted hover:bg-white/10 hover:text-fg" title="Display and keyboard" aria-label="Display and keyboard">
                <MonitorCog className="h-4 w-4" />
              </button>
            </MenuTrigger>
            <MenuContent>
              <MenuLabel>Remote resolution{p.remoteSize ? ` · now ${p.remoteSize}` : ""}</MenuLabel>
              <MenuRadio<Resolution>
                value={p.resolution}
                onChange={p.onResolution}
                options={[
                  { value: "window", label: "Match this window" },
                  { value: "monitor", label: `Match my monitor (${Math.round(window.screen.width * devicePixelRatio)}×${Math.round(window.screen.height * devicePixelRatio)})` },
                  { value: "1920x1080", label: "1920 × 1080" },
                  { value: "2560x1440", label: "2560 × 1440" },
                  { value: "1600x900", label: "1600 × 900" },
                  { value: "1280x720", label: "1280 × 720" },
                ]}
              />
              <MenuSeparator />
              <MenuCheckbox checked={p.nativeDensity} onChange={p.onNativeDensity}>
                Native pixel density (HiDPI)
              </MenuCheckbox>
              {p.keyboardOptions && p.onKeyboardLayout && (
                <>
                  <MenuSeparator />
                  <MenuLabel>Keyboard (reconnects)</MenuLabel>
                  <MenuRadio<string> value={p.keyboardLayout ?? "auto"} onChange={p.onKeyboardLayout} options={p.keyboardOptions} />
                </>
              )}
              {p.keyboardInfo && <p className="max-w-[280px] px-2.5 pb-2 pt-1 text-xs text-muted">{p.keyboardInfo}</p>}
            </MenuContent>
          </Menu>
          )}
            <Key title={p.fullscreen ? "Exit fullscreen" : "Fullscreen"} onClick={p.onFullscreen}>
              {p.fullscreen ? <Minimize className="h-4 w-4" /> : <Maximize className="h-4 w-4" />}
            </Key>
          </Group>
          <Group label="Session">
            {p.canReconnect ? (
              <Key title="Reconnect" onClick={p.onReconnect}>
                <RotateCw className="h-4 w-4" />
              </Key>
            ) : (
              <button
                type="button"
                title="Disconnect"
                aria-label="Disconnect"
                onClick={p.onDisconnect}
                className="flex h-7 min-w-[28px] items-center justify-center rounded-md px-1.5 text-danger transition-colors hover:bg-danger/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/30"
              >
                <Power className="h-4 w-4" />
              </button>
            )}
            <Key title="Hide toolbar" onClick={() => save({ ...place, collapsed: true })}>
              <ChevronsLeftRight className="h-4 w-4" />
            </Key>
            <Key title="Hide completely (Ctrl+Alt+Shift+T)" onClick={() => save({ ...place, hidden: true })}>
              <EyeOff className="h-4 w-4" />
            </Key>
          </Group>
        </div>
      )}
    </div>
    </>
  );
}
