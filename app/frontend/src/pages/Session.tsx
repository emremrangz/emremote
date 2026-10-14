import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import clsx from "clsx";
import { Power, RotateCw, X, ArrowLeft, AlertTriangle, Wifi, Lock } from "lucide-react";
import { FileBrowser } from "@/components/FileBrowser";
import { SSHAccessGate } from "@/components/SSHAccessGate";
import { SnippetsPanel } from "@/components/SnippetsPanel";
import { ShareDialog } from "@/components/ShareDialog";
import { FloatingFileButton } from "@/components/FloatingFileButton";
import { AreaSelect, type Region } from "@/components/AreaSelect";
import { duration } from "@/lib/format";
import { SessionToolbar, type Resolution } from "@/components/SessionToolbar";
import { useSSHAccess } from "@/hooks/useSSHAccess";
import type { Connection, Protocol, RDPSettings } from "@/lib/types";
import { connectionBase, isQuickConnection, useConnection } from "@/hooks/queries";
import { ApiError, errorMessage, getCsrfToken, patch, post, put } from "@/lib/api";
import { useToast } from "@/components/ui/Toast";
import { loadGuacamole, ClientState, TunnelState, statusMessage, supportedImageTypes, type GuacClient } from "@/lib/guac";
import { detectKeyboardLayout } from "@/lib/keyboard";
import { useAccess } from "@/lib/auth";
import { loadTerminalPrefs, saveTerminalPrefs, terminalRequest, type TerminalPrefs } from "@/lib/terminalPrefs";
import type { SSHSettings } from "@/lib/types";
import { clipboardReadState, execCopy, isMacClient, readLocal, textToKeysyms, writeLocal, type ReadState } from "@/lib/clipboard";
import { K, sessionProfile } from "@/lib/sessionProfile";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { ProtocolBadge } from "@/components/Status";
import { OsIcon } from "@/components/OsIcon";
import { Field } from "@/components/ui/Field";
import { KEYBOARD_LAYOUTS, PROTOCOL_LABELS } from "@/lib/constants";

type Phase = "loading" | "connecting" | "connected" | "disconnected" | "error";
interface Prefs {
  /** "fit" scales the remote screen to the window; a number is a fixed zoom in percent. */
  zoom: "fit" | number;
  resolution: Resolution;
  /**
   * "auto": report the screen's real DPI. guacd then keeps RDP desktops at a
   * normal (96 DPI) logical size, so UI elements have their usual size.
   * "native": report 96 DPI at device-pixel size, so the remote desktop runs at
   * full device resolution (sharpest, but its UI appears smaller unless the
   * remote OS display scaling is raised).
   */
  density: "auto" | "native";
}

const PREFS_KEY = "emremote-session-prefs";
// Upper bound on requested remote pixels; protects the gateway CPU and bandwidth
// when HiDPI is enabled on very large windows.
const MAX_PIXELS = 3840 * 2400;

const DEFAULT_PREFS: Prefs = { zoom: "fit", resolution: "window", density: "auto" };
const RESOLUTIONS: Resolution[] = ["window", "monitor", "1280x720", "1600x900", "1920x1080", "2560x1440", "3840x2160"];
const MODIFIERS = new Set([0xffe1, 0xffe2, 0xffe3, 0xffe4, 0xffe7, 0xffe8, 0xffe9, 0xffea, 0xffeb, 0xffec, 0xfe03]);

function loadPrefs(): Prefs {
  try {
    const p = { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(PREFS_KEY) || "{}") };
    return {
      zoom: typeof p.zoom === "number" && p.zoom >= 10 && p.zoom <= 400 ? p.zoom : "fit",
      resolution: RESOLUTIONS.includes(p.resolution) ? p.resolution : "window",
      density: p.density === "native" ? "native" : "auto",
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

function isTypingTarget(el: Element | null) {
  if (!el) return false;
  // The hidden paste target belongs to the remote screen.
  if (el.closest("[data-paste-sink]")) return false;
  // Menus and dialogs are portaled outside the toolbar, so match them by role too:
  // keys pressed there (e.g. Esc to close a menu) must not reach the remote computer.
  return !!el.closest(
    'input, textarea, select, [contenteditable=true], [data-no-capture], [role="menu"], [role="dialog"], [data-radix-popper-content-wrapper]',
  );
}

/** The standalone session window (/connect/:id). */
export default function SessionPage() {
  const { connectionId = "" } = useParams();
  return <SessionView connectionId={connectionId} active embedded={false} />;
}

export interface SessionInfo {
  title: string;
  phase: Phase;
  protocol?: Protocol;
}

export interface SessionViewProps {
  connectionId: string;
  /** The pane that receives the keyboard. A standalone window is always active. */
  active: boolean;
  /** Shown inside a workspace pane rather than as the whole page. */
  embedded: boolean;
  onInfo?: (info: SessionInfo) => void;
  /** Called when the pane is clicked or focused, so a workspace can make it the active one. */
  onActivate?: () => void;
  /** "Close tab" in the disconnected message (closes the window when absent). */
  onClose?: () => void;
}

/** One remote session: display, toolbar and side panels. Several can live side by side in a workspace. */
export function SessionView({ connectionId, active, embedded, onInfo, onActivate, onClose }: SessionViewProps) {
  const embeddedRef = useRef(embedded);
  embeddedRef.current = embedded;
  const activeRef = useRef(active);
  activeRef.current = active;
  const keyboardRef = useRef<{ reset: () => void } | null>(null);
  const conn = useConnection(connectionId);
  const quick = isQuickConnection(connectionId);
  const { can } = useAccess();
  const viewportRef = useRef<HTMLDivElement>(null);
  const displayHostRef = useRef<HTMLDivElement>(null);
  const clientRef = useRef<GuacClient | null>(null);
  const prefsRef = useRef<Prefs>(loadPrefs());
  const [prefs, setPrefsState] = useState<Prefs>(prefsRef.current);
  const [phase, setPhase] = useState<Phase>("loading");
  const [phaseDetail, setPhaseDetail] = useState("Preparing…");
  const [error, setError] = useState<{ title: string; hint?: string; detail?: string } | null>(null);
  const [unstable, setUnstable] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [fullscreen, setFullscreen] = useState(false);
  const [scale, setScale] = useState(1);
  const [latched, setLatched] = useState<Set<number>>(new Set());
  const latchedRef = useRef<Set<number>>(new Set());
  const [keyboardLayout, setKeyboardLayout] = useState<string>("");
  const [termPrefs, setTermPrefs] = useState<TerminalPrefs>(loadTerminalPrefs);
  const termPrefsRef = useRef<TerminalPrefs>(termPrefs);
  const [clipOpen, setClipOpen] = useState(false);
  const [snippetsOpen, setSnippetsOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const selectingRef = useRef(false);
  selectingRef.current = selecting;
  const connectedAtRef = useRef<number | null>(null);
  const [endedAfter, setEndedAfter] = useState<number | null>(null);
  const toast = useToast();
  const [dropping, setDropping] = useState(false);
  // Files pasted or dropped on an RDP session go to its transfer drive.
  const driveRef = useRef<{ deviceId: string; enabled: boolean }>({ deviceId: "", enabled: false });
  const sendToDriveRef = useRef<(files: File[]) => void>(() => {});
  const tunnelRef = useRef<{ uuid?: string } | null>(null);
  const [filesOpen, setFilesOpen] = useState(false);
  const [remoteClip, setRemoteClip] = useState("");
  const [localClip, setLocalClip] = useState("");
  const [required, setRequired] = useState<string[] | null>(null);
  const [remoteSize, setRemoteSize] = useState<[number, number] | null>(null);
  // Size updates are only valid once the remote session is fully connected;
  // VNC never resizes the remote desktop (it is scaled locally instead).
  const canResizeRef = useRef(false);
  const connectedRef = useRef(false);
  // Last text known to be on the remote clipboard (avoids echoing it back).
  const lastSyncedRef = useRef<string | null>(null);
  const pasteSinkRef = useRef<HTMLTextAreaElement>(null);

  const protocol = conn.data?.protocol;
  driveRef.current = {
    deviceId: conn.data?.device_id ?? "",
    enabled: protocol === "rdp" && !quick && (conn.data?.settings as RDPSettings | undefined)?.enable_drive !== false && !(conn.data?.settings as RDPSettings | undefined)?.read_only,
  };
  sendToDriveRef.current = async (files: File[]) => {
    const { deviceId } = driveRef.current;
    if (!deviceId || files.length === 0) return;
    const base = `/api/devices/${deviceId}/transfer`;
    const folder = "from-browser";
    toast.info(files.length === 1 ? "Sending to the remote computer…" : `Sending ${files.length} files to the remote computer…`);
    try {
      await post(`${base}/mkdir`, { dir: "", name: folder }).catch((e) => {
        if (!(e instanceof ApiError && e.code === "exists")) throw e;
      });
      const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
      const sent: string[] = [];
      for (const f of files) {
        const ext = f.type.startsWith("image/") ? "." + (f.type.split("/")[1] || "png").replace("jpeg", "jpg") : "";
        // Clipboard images arrive with a generic name such as "image.png".
        let name = /^image\.\w+$/i.test(f.name) || !f.name ? `pasted-image-${stamp}${ext || ".png"}` : f.name;
        for (let attempt = 0; attempt < 5; attempt++) {
          const q = new URLSearchParams({ dir: folder, name });
          const r = await fetch(`${base}/upload?${q}`, { method: "POST", credentials: "same-origin", headers: { "X-CSRF-Token": getCsrfToken(), "Content-Type": "application/octet-stream" }, body: f });
          if (r.status === 201) {
            sent.push(name);
            break;
          }
          const body = await r.json().catch(() => ({}));
          if (r.status === 409 || body?.error?.code === "exists") name = name.replace(/(\.[^.]*)?$/, `-${attempt + 2}$1`);
          else throw new Error(body?.error?.message ?? `Upload failed (${r.status})`);
        }
      }
      toast.success(
        sent.length === 1
          ? `Sent: ${sent[0]}. In Windows, type \\\\tsclient\\emremote\\${folder} in File Explorer's address bar.`
          : `Sent ${sent.length} files. In Windows, type \\\\tsclient\\emremote\\${folder} in File Explorer's address bar.`,
      );
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  const title = conn.data ? `${conn.data.device_name} · ${conn.data.name}` : "Remote session";

  const setPrefs = (p: Partial<Prefs>) => {
    const next = { ...prefsRef.current, ...p };
    prefsRef.current = next;
    setPrefsState(next);
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
  };

  useEffect(() => {
    if (!embedded) document.title = `${title} | emremote`;
  }, [title, embedded]);

  useEffect(() => {
    onInfo?.({ title, phase, protocol });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title, phase, protocol]);

  /** Size to request from the server, in remote pixels, plus DPI. */
  const computeSize = useCallback((): { width: number; height: number; dpi: number } => {
    const vp = viewportRef.current;
    // A pane of the workspace always follows its own size; monitor or fixed sizes would not fit it.
    const p = embeddedRef.current ? { ...prefsRef.current, resolution: "window" as Resolution } : prefsRef.current;
    if (p.resolution === "monitor") {
      // The physical monitor: what the remote desktop becomes in fullscreen.
      const r = window.devicePixelRatio || 1;
      return {
        width: Math.min(8192, Math.round(window.screen.width * r)),
        height: Math.min(8192, Math.round(window.screen.height * r)),
        dpi: p.density === "native" ? 96 : Math.round(96 * r),
      };
    }
    if (p.resolution !== "window") {
      const [w, h] = p.resolution.split("x").map(Number);
      return { width: w, height: h, dpi: 96 };
    }
    const cssW = Math.max(320, vp?.clientWidth ?? window.innerWidth);
    const cssH = Math.max(240, vp?.clientHeight ?? window.innerHeight);
    let ratio = window.devicePixelRatio || 1;
    if (cssW * cssH * ratio * ratio > MAX_PIXELS) ratio = Math.max(1, Math.sqrt(MAX_PIXELS / (cssW * cssH)));
    return {
      width: Math.min(8192, Math.round(cssW * ratio)),
      height: Math.min(8192, Math.round(cssH * ratio)),
      dpi: p.density === "native" ? 96 : Math.round(96 * ratio),
    };
  }, []);

  /** Scale the Guacamole display to the viewport according to preferences. */
  const rescale = useCallback(() => {
    const client = clientRef.current;
    const vp = viewportRef.current;
    if (!client || !vp) return;
    const display = client.getDisplay();
    const w = display.getWidth();
    const h = display.getHeight();
    if (!w || !h) return;
    const z = prefsRef.current.zoom;
    const s = z === "fit" ? Math.min(vp.clientWidth / w, vp.clientHeight / h) : z / 100;
    display.scale(s);
    setScale(s);
  }, []);

  // ---- Connect ----
  useEffect(() => {
    if (!conn.data) return;
    let cancelled = false;
    let client: GuacClient | null = null;
    let keyboard: any = null;
    const cleanups: (() => void)[] = [];

    (async () => {
      setPhase("loading");
      setError(null);
      setRequired(null);
      setPhaseDetail("Loading remote display client…");
      let Guacamole: any;
      try {
        Guacamole = await loadGuacamole();
      } catch (e) {
        setError({ title: errorMessage(e) });
        setPhase("error");
        return;
      }
      if (cancelled) return;

      setPhaseDetail("Authorizing session…");
      const size = computeSize();
      const layout = await detectKeyboardLayout();
      setKeyboardLayout(layout);
      let ticket: string;
      try {
        const r = await post<{ ticket: string }>(`${connectionBase(connectionId)}/sessions`, {
          ...size,
          image: supportedImageTypes(),
          audio: Guacamole.AudioPlayer.getSupportedTypes(),
          video: Guacamole.VideoPlayer.getSupportedTypes(),
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? "",
          keyboard_layout: layout,
          ...(conn.data!.protocol === "ssh" || conn.data!.protocol === "telnet" ? { terminal: terminalRequest(termPrefsRef.current) } : {}),
        });
        ticket = r.ticket;
      } catch (e) {
        const msg = e instanceof ApiError && e.code === "target_not_allowed"
          ? { title: "This target is blocked by the server's network policy.", hint: "See EMREMOTE_ALLOWED_TARGET_NETWORKS in docs/SECURITY.md.", detail: e.message }
          : { title: "Could not start the session.", detail: errorMessage(e) };
        setError(msg);
        setPhase("error");
        return;
      }
      if (cancelled) return;

      setPhase("connecting");
      setPhaseDetail(`Connecting to ${conn.data!.device_name}…`);

      const tunnel = new Guacamole.WebSocketTunnel("/api/tunnel");
      tunnelRef.current = tunnel;
      client = new Guacamole.Client(tunnel);
      clientRef.current = client;
      // Print jobs from the RDP printer arrive as PDF streams; everything else is refused.
      client.onfile = (stream: any, mimetype: string, filename: string) => {
        if (mimetype !== "application/pdf") {
          stream.sendAck("Not supported", Guacamole.Status.Code.UNSUPPORTED);
          return;
        }
        const reader = new Guacamole.BlobReader(stream, mimetype);
        reader.onend = () => {
          const name = (filename || "print").replace(/[^\w.\- ]/g, "_").replace(/(\.pdf)?$/i, ".pdf");
          const url = URL.createObjectURL(reader.getBlob());
          const a = document.createElement("a");
          a.href = url;
          a.download = name;
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 30000);
        };
      };
      const display = client.getDisplay();
      const displayEl: HTMLElement = display.getElement();
      displayEl.classList.add("guac-viewport");
      const host = displayHostRef.current!;
      host.replaceChildren(displayEl);

      tunnel.onstatechange = (s: number) => {
        setUnstable(s === TunnelState.UNSTABLE);
        // The gateway closing the socket (the session was terminated or the server restarted).
        if (s === TunnelState.CLOSED) setPhase((p) => (p === "connected" || p === "connecting" ? "disconnected" : p));
      };

      client.onstatechange = (s: number) => {
        if (s === ClientState.WAITING) setPhaseDetail("Waiting for the remote computer…");
        canResizeRef.current = s === ClientState.CONNECTED && conn.data!.protocol !== "vnc";
        connectedRef.current = s === ClientState.CONNECTED;
        if (s === ClientState.CONNECTED) {
          setPhase("connected");
          setError(null);
          setTimeout(rescale, 0);
          if (activeRef.current) viewportRef.current?.focus();
        }
        if (s === ClientState.DISCONNECTED) setPhase((p) => (p === "error" ? p : "disconnected"));
      };
      client.onerror = (status: any) => {
        const m = statusMessage(status.code, conn.data!.protocol);
        setError({ ...m, detail: status.message && status.message !== String(status.code) ? status.message : undefined });
        setPhase("error");
      };
      client.onrequired = (params: string[]) => setRequired(params);

      display.onresize = (w: number, h: number) => {
        setRemoteSize([w, h]);
        rescale();
      };

      // Cursor: prefer a native CSS cursor (smoothest); fall back to the software cursor layer.
      const mouse = new Guacamole.Mouse(displayEl);
      let nativeCursor = false;
      display.oncursor = (canvas: HTMLCanvasElement, x: number, y: number) => {
        nativeCursor = mouse.setCursor(canvas, x, y);
      };
      // Right-click paste: refresh the remote clipboard from this computer first,
      // where the browser allows reading it (Chromium; asked once, then silent).
      let readState: ReadState = "unsupported";
      const refreshReadState = () => clipboardReadState().then((st) => (readState = st));
      refreshReadState();
      const syncFromLocal = async () => {
        const t = await readLocal();
        refreshReadState();
        if (t && t !== lastSyncedRef.current && connectedRef.current) pushClipboard(t);
      };
      let gate: Promise<void> | null = null;
      const queued: any[] = [];
      const sendMouse = (e: any) => {
        display.showCursor(!nativeCursor);
        const st = e.state;
        // While a button is held (e.g. selecting text), let the pointer pass over the toolbar.
        if (st.left || st.middle || st.right) document.body.dataset.remoteDrag = "";
        else delete document.body.dataset.remoteDrag;
        const copy = { x: st.x, y: st.y, left: st.left, middle: st.middle, right: st.right, up: st.up, down: st.down };
        if (gate) {
          queued.push(copy);
          return;
        }
        if (e.type === "mousedown" && st.right && (readState === "granted" || readState === "prompt")) {
          queued.push(copy);
          const flush = () => {
            gate = null;
            queued.splice(0).forEach((q) => client!.sendMouseState(q, true));
          };
          const wait = new Promise<void>((r) => setTimeout(r, readState === "granted" ? 300 : 150));
          gate = Promise.race([syncFromLocal(), wait]).then(flush, flush);
          return;
        }
        client!.sendMouseState(copy, true);
      };
      mouse.onEach(["mousedown", "mousemove", "mouseup"], sendMouse);
      mouse.on("mouseout", () => display.showCursor(false));
      const touch = new Guacamole.Mouse.Touchscreen(displayEl);
      touch.onEach(["mousedown", "mousemove", "mouseup"], sendMouse);

      // ---- Clipboard ----
      const profile = sessionProfile(conn.data!.protocol, conn.data!.device_os);
      const terminal = profile === "terminal";
      const pushClipboard = (text: string) => {
        lastSyncedRef.current = text;
        const writer = new Guacamole.StringWriter(client!.createClipboardStream("text/plain"));
        writer.sendText(text);
        writer.sendEnd();
      };

      // Remote → local. If the browser refuses (no focus or no recent gesture),
      // retry on the next key press or click, which always allows copying.
      let pendingCopy: string | null = null;
      client.onclipboard = (stream: any, mimetype: string) => {
        if (!/^text\//.test(mimetype)) return;
        const reader = new Guacamole.StringReader(stream);
        let data = "";
        reader.ontext = (t: string) => (data += t);
        reader.onend = () => {
          setRemoteClip(data);
          lastSyncedRef.current = data;
          writeLocal(data).then((ok) => {
            if (!ok) pendingCopy = data;
          });
        };
      };
      const flushPendingCopy = () => {
        if (pendingCopy === null || !activeRef.current) return;
        const t = pendingCopy;
        pendingCopy = null;
        if (!execCopy(t))
          writeLocal(t).then((ok) => {
            if (!ok) pendingCopy = t;
          });
      };
      window.addEventListener("pointerdown", flushPendingCopy, true);
      window.addEventListener("keydown", flushPendingCopy, true);
      cleanups.push(() => {
        window.removeEventListener("pointerdown", flushPendingCopy, true);
        window.removeEventListener("keydown", flushPendingCopy, true);
      });

      // ---- Keyboard ----
      const down = new Set<number>(); // keys currently held on the remote side
      const press = (k: number) => {
        down.add(k);
        client!.sendKeyEvent(1, k);
      };
      const release = (k: number) => {
        down.delete(k);
        client!.sendKeyEvent(0, k);
      };
      const held = (k: number) => down.has(k) || down.has(k + 1); // left or right variant
      const isMeta = (k: number) => k === 0xffe7 || k === 0xffe8 || k === 0xffeb || k === 0xffec;
      const swallowed = new Set<number>(); // key-ups that must not be forwarded
      const remapped = new Map<number, number[]>(); // ⌘+key sent as Ctrl+key → the ⌘ keys released

      /** The remote side's own paste shortcut, sent once its clipboard holds the text. */
      const sendPasteKeys = (keysym: number) => {
        if (terminal) {
          // guacd terminals paste their clipboard on Ctrl+Shift+V.
          const addCtrl = !held(K.Ctrl);
          const addShift = !held(K.Shift);
          const others = [...down].filter((k) => MODIFIERS.has(k) && k !== K.Ctrl && k !== K.Ctrl + 1 && k !== K.Shift && k !== K.Shift + 1);
          others.forEach(release);
          if (addCtrl) press(K.Ctrl);
          if (addShift) press(K.Shift);
          press(0x56);
          release(0x56);
          if (addShift) release(K.Shift);
          if (addCtrl) release(K.Ctrl);
          others.forEach(press);
          return;
        }
        if (keysym === 0xff63 && held(K.Shift)) {
          press(0xff63);
          release(0xff63);
          return;
        }
        const mod = profile === "mac" ? K.Meta : K.Ctrl;
        const v = held(K.Shift) ? 0x56 : 0x76;
        const others = [...down].filter((k) => MODIFIERS.has(k) && k !== mod && k !== mod + 1 && k !== K.Shift && k !== K.Shift + 1);
        const addMod = !held(mod);
        others.forEach(release);
        if (addMod) press(mod);
        press(v);
        release(v);
        if (addMod) release(mod);
        others.forEach(press);
      };

      // Local → remote paste. Ctrl+V / ⌘V / Shift+Insert are allowed through to
      // the browser, which then fires a "paste" event with the clipboard text
      // (no permission needed). The text goes to the remote clipboard first,
      // then the remote paste shortcut follows.
      let pastePending: { keysym: number; timer: number } | null = null;
      const finishPaste = (text: string | null) => {
        if (!pastePending) return;
        const { keysym, timer } = pastePending;
        pastePending = null;
        window.clearTimeout(timer);
        viewportRef.current?.focus({ preventScroll: true });
        if (text) pushClipboard(text);
        // Let the remote clipboard update before the keystroke (RDP announces it asynchronously).
        const delay = text ? (terminal ? 50 : 350) : 0;
        window.setTimeout(() => connectedRef.current && sendPasteKeys(keysym), delay);
      };
      const beginPaste = (keysym: number) => {
        swallowed.add(keysym);
        if (pastePending) return;
        // No paste event (e.g. the clipboard holds an image): paste whatever the remote has.
        pastePending = { keysym, timer: window.setTimeout(() => finishPaste(null), 400) };
        pasteSinkRef.current?.focus({ preventScroll: true });
      };
      const onPaste = (e: ClipboardEvent) => {
        if (!activeRef.current) return;
        if (isTypingTarget(e.target as Element)) return; // pasting into emremote's own fields
        // Images and files cannot go through the remote clipboard (it carries text only):
        // they are placed on the session's transfer drive instead.
        const files = driveRef.current.enabled ? Array.from(e.clipboardData?.files ?? []) : [];
        if (files.length > 0) {
          e.preventDefault();
          if (pastePending) {
            window.clearTimeout(pastePending.timer);
            pastePending = null;
          }
          sendToDriveRef.current(files);
          return;
        }
        const text = e.clipboardData?.getData("text/plain") ?? "";
        e.preventDefault();
        if (pastePending) finishPaste(text);
        else if (text && connectedRef.current) {
          // Paste from the browser's own menu.
          pushClipboard(text);
          window.setTimeout(() => sendPasteKeys(0x76), terminal ? 50 : 350);
        }
      };
      document.addEventListener("paste", onPaste, true);
      cleanups.push(() => document.removeEventListener("paste", onPaste, true));

      // On a Mac, ⌘ shortcuts (copy, select all, undo…) become Ctrl shortcuts on
      // Windows and Linux. In a terminal, selecting text already copies it.
      const remapCmd = isMacClient() && profile !== "mac";
      const isShortcutKey = (k: number) => (k >= 0x30 && k <= 0x39) || (k >= 0x41 && k <= 0x5a) || (k >= 0x61 && k <= 0x7a);

      // Forward everything unless the user is typing in an emremote control.
      keyboard = new Guacamole.Keyboard(document);
      keyboardRef.current = keyboard;
      keyboard.onkeydown = (keysym: number) => {
        if (!activeRef.current || selectingRef.current) return true; // another pane has the keyboard, or an area is being chosen
        if (isTypingTarget(document.activeElement)) return true;
        const m = keyboard.modifiers;
        const isV = keysym === 0x76 || keysym === 0x56;
        if ((isV && (m.ctrl || m.meta) && !m.alt) || (keysym === 0xff63 && m.shift && !m.ctrl && !m.alt)) {
          beginPaste(keysym);
          return true; // let the browser fire its paste event
        }
        if (m.meta && !m.ctrl && isShortcutKey(keysym)) {
          if (terminal) {
            swallowed.add(keysym);
            return false;
          }
          if (remapCmd) {
            const metas = [...down].filter(isMeta);
            metas.forEach(release);
            press(K.Ctrl);
            press(keysym);
            remapped.set(keysym, metas);
            return false;
          }
        }
        press(keysym);
        return false;
      };
      keyboard.onkeyup = (keysym: number) => {
        if (!activeRef.current) return;
        if (swallowed.delete(keysym)) return;
        if (isTypingTarget(document.activeElement)) return;
        const metas = remapped.get(keysym);
        if (metas) {
          remapped.delete(keysym);
          release(keysym);
          release(K.Ctrl);
          if (keyboard.modifiers.meta) metas.forEach(press);
          return;
        }
        release(keysym);
        // Toolbar modifiers stay held for exactly one ordinary key.
        if (!MODIFIERS.has(keysym) && latchedRef.current.size) releaseLatched();
      };
      const onBlur = () => keyboard?.reset();
      window.addEventListener("blur", onBlur);
      cleanups.push(() => window.removeEventListener("blur", onBlur));

      // Refresh the remote clipboard when coming back to this tab (only where reading is silent).
      const onFocus = () => {
        if (readState === "granted" && activeRef.current) syncFromLocal();
      };
      window.addEventListener("focus", onFocus);
      cleanups.push(() => window.removeEventListener("focus", onFocus));

      client.connect("ticket=" + encodeURIComponent(ticket));
    })();

    const onUnload = () => clientRef.current?.disconnect();
    window.addEventListener("pagehide", onUnload);

    return () => {
      cancelled = true;
      window.removeEventListener("pagehide", onUnload);
      cleanups.forEach((f) => f());
      if (keyboard) {
        keyboard.onkeydown = null;
        keyboard.onkeyup = null;
      }
      keyboardRef.current = null;
      client?.disconnect();
      clientRef.current = null;
      canResizeRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn.data?.id, attempt]);

  // ---- Resize handling ----
  useEffect(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    let t: number | undefined;
    const ro = new ResizeObserver(() => {
      if (vp.clientWidth < 50 || vp.clientHeight < 50) return; // hidden tab of a workspace
      rescale();
      window.clearTimeout(t);
      t = window.setTimeout(() => {
        const client = clientRef.current;
        if (client && canResizeRef.current && (embeddedRef.current || prefsRef.current.resolution === "window")) {
          const s = computeSize();
          client.sendSize(s.width, s.height);
        }
      }, 250);
    });
    ro.observe(vp);
    return () => {
      ro.disconnect();
      window.clearTimeout(t);
    };
  }, [rescale, computeSize]);

  // Re-apply size/scale when display preferences change.
  useEffect(() => {
    const client = clientRef.current;
    if (!client || phase !== "connected") return;
    if (canResizeRef.current) {
      const s = computeSize();
      client.sendSize(s.width, s.height);
    }
    rescale();
  }, [prefs, phase, computeSize, rescale]);

  // Warn before closing the tab during an active session.
  useEffect(() => {
    if (phase !== "connected" || embedded) return; // a workspace warns for all of its sessions
    const h = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [phase, embedded]);

  // ---- Fullscreen ----
  useEffect(() => {
    const onChange = () => {
      const fs = !!document.fullscreenElement;
      setFullscreen(fs);
      const kb = (navigator as any).keyboard;
      if (fs) kb?.lock?.().catch(() => {});
      else kb?.unlock?.();
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const toggleFullscreen = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen({ navigationUI: "hide" });
    } catch {
      /* not allowed (e.g. iOS Safari) */
    }
    viewportRef.current?.focus();
  };

  // ---- Actions ----
  function setLatchedKeys(next: Set<number>) {
    latchedRef.current = next;
    setLatched(new Set(next));
  }
  function releaseLatched() {
    const c = clientRef.current;
    latchedRef.current.forEach((k) => c?.sendKeyEvent(0, k));
    setLatchedKeys(new Set());
  }
  const toggleLatch = (k: number) => {
    const c = clientRef.current;
    if (!c) return;
    const next = new Set(latchedRef.current);
    if (next.has(k)) {
      c.sendKeyEvent(0, k);
      next.delete(k);
    } else {
      c.sendKeyEvent(1, k);
      next.add(k);
    }
    setLatchedKeys(next);
    viewportRef.current?.focus();
  };

  /** Press and release keys in order (held toolbar modifiers apply and are then released). */
  const sendCombo = (...keys: number[]) => {
    const c = clientRef.current;
    if (!c) return;
    keys.forEach((k) => c.sendKeyEvent(1, k));
    [...keys].reverse().forEach((k) => c.sendKeyEvent(0, k));
    if (latchedRef.current.size) releaseLatched();
    viewportRef.current?.focus();
  };

  // Opens the transfer folder inside Windows the way a person would: Win+R, the path, Enter.
  const TRANSFER_PATH = "\\\\tsclient\\emremote\\from-browser";
  const openTransferFolder = async () => {
    const c = clientRef.current;
    if (!c || !connectedRef.current) return;
    // The folder must exist for Explorer to open it.
    await post(`/api/devices/${driveRef.current.deviceId}/transfer/mkdir`, { dir: "", name: "from-browser" }).catch(() => {});
    sendCombo(K.Super, 0x72);
    window.setTimeout(() => {
      typeText(TRANSFER_PATH);
      window.setTimeout(() => sendCombo(K.Return), 150);
    }, 800);
  };

  // Saves the remote screen as a PNG: all of it, or the part the user dragged over.
  const takeScreenshot = (region?: Region) => {
    const client = clientRef.current;
    if (!client) return;
    try {
      const display = client.getDisplay();
      const full: HTMLCanvasElement = display.flatten();
      let out = full;
      if (region) {
        const r = (display.getElement() as HTMLElement).getBoundingClientRect();
        const k = display.getWidth() / r.width;
        const x = Math.max(0, Math.round((region.x - r.left) * k));
        const y = Math.max(0, Math.round((region.y - r.top) * k));
        const w = Math.min(full.width - x, Math.round(region.w * k));
        const h = Math.min(full.height - y, Math.round(region.h * k));
        if (w < 4 || h < 4) {
          toast.error("That area is outside the remote screen.");
          return;
        }
        out = document.createElement("canvas");
        out.width = w;
        out.height = h;
        out.getContext("2d")!.drawImage(full, x, y, w, h, 0, 0, w, h);
      }
      const d = new Date();
      const p = (n: number) => String(n).padStart(2, "0");
      const name = `${(conn.data?.device_name ?? "screenshot").replace(/[^\w.-]+/g, "_")}-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.png`;
      out.toBlob((blob) => {
        if (!blob) {
          toast.error("Could not create the screenshot.");
          return;
        }
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 30000);
        toast.success(`Saved ${name}`);
      }, "image/png");
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  // How long the session lasted, for the "ended" screen; Enter reconnects.
  useEffect(() => {
    if (phase === "connected") {
      connectedAtRef.current = Date.now();
      setEndedAfter(null);
    } else if (phase === "disconnected" && connectedAtRef.current) {
      setEndedAfter(Math.round((Date.now() - connectedAtRef.current) / 1000));
      connectedAtRef.current = null;
    }
  }, [phase]);
  useEffect(() => {
    if (phase !== "disconnected" || !active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter" && !isTypingTarget(document.activeElement)) {
        e.preventDefault();
        reconnect();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, active]);

  const zoomBy = (delta: number) => {
    const current = Math.round(scale * 100);
    const next = Math.min(400, Math.max(10, Math.round((current + delta) / 10) * 10));
    setPrefs({ zoom: next });
  };

  const sendClipboard = async (text: string) => {
    const Guacamole = window.Guacamole;
    const c = clientRef.current;
    if (!c || !Guacamole) return;
    lastSyncedRef.current = text;
    const stream = c.createClipboardStream("text/plain");
    const writer = new Guacamole.StringWriter(stream);
    writer.sendText(text);
    writer.sendEnd();
  };

  /** Types text key by key: for login screens and other places without clipboard support. */
  const typeText = (text: string) => {
    const c = clientRef.current;
    if (!c) return;
    for (const k of textToKeysyms(text)) {
      c.sendKeyEvent(1, k);
      c.sendKeyEvent(0, k);
    }
    viewportRef.current?.focus();
  };




  const disconnect = () => {
    clientRef.current?.disconnect();
    setPhase("disconnected");
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  };

  // In a workspace the keyboard follows the active pane.
  useEffect(() => {
    if (active) {
      if (phase === "connected") viewportRef.current?.focus({ preventScroll: true });
    } else {
      keyboardRef.current?.reset();
      if (latchedRef.current.size) releaseLatched();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  /** Saves personal terminal appearance and reconnects so the gateway renders it. */
  const changeTerminal = (p: Partial<TerminalPrefs> | null) => {
    const next = p === null ? {} : { ...termPrefsRef.current, ...p };
    termPrefsRef.current = next;
    setTermPrefs(next);
    saveTerminalPrefs(next);
    reconnect();
  };

  const reconnect = () => {
    setError(null);
    setAttempt((a) => a + 1);
  };

  const submitRequired = (values: Record<string, string>) => {
    const Guacamole = window.Guacamole;
    const c = clientRef.current;
    if (!c || !Guacamole) return;
    for (const name of required ?? []) {
      const stream = c.createArgumentValueStream("text/plain", name);
      const writer = new Guacamole.StringWriter(stream);
      writer.sendText(values[name] ?? "");
      writer.sendEnd();
    }
    setRequired(null);
    viewportRef.current?.focus();
  };

  if (conn.error) {
    return (
      <FullMessage icon={<AlertTriangle className="h-5 w-5 text-danger" />} title="Connection not found">
        {errorMessage(conn.error)}
      </FullMessage>
    );
  }

  const statusPill =
    phase === "connected" ? (
      unstable ? (
        <span className="flex items-center gap-1.5 text-warning"><Wifi className="h-3.5 w-3.5" />Unstable</span>
      ) : (
        <span className="h-2 w-2 shrink-0 rounded-full bg-success" title="Connected" />
      )
    ) : phase === "connecting" || phase === "loading" ? (
      <Spinner className="h-3 w-3 text-muted" />
    ) : (
      <span className="h-2 w-2 shrink-0 rounded-full bg-subtle" title="Disconnected" />
    );
  const fit = prefs.zoom === "fit";
  const filesAvailable =
    !quick &&
    can("files.use") &&
    (protocol === "ssh" || (protocol === "rdp" && (conn.data?.settings as RDPSettings | undefined)?.enable_drive !== false));
  const layoutLabel = KEYBOARD_LAYOUTS.find((k) => k.value === keyboardLayout)?.label;
  const serverLayout = (conn.data?.settings as RDPSettings | undefined)?.server_layout;
  const keyboardInfo =
    protocol !== "rdp"
      ? undefined
      : "Pick the input language set on the remote computer (Automatic assumes it matches this computer). If the remote uses a different language, choose that one. Unicode is a last resort and does not work with every server.";
  const currentLayout = serverLayout || "auto";
  const keyboardOptions =
    protocol !== "rdp"
      ? undefined
      : [
          { value: "auto", label: `Automatic (this computer: ${layoutLabel ?? "detecting…"})` },
          { value: "tr-tr-qwerty", label: "Turkish (Q)" },
          { value: "en-us-qwerty", label: "English (US)" },
          { value: "failsafe", label: "Unicode fallback (Windows; last resort)" },
          ...(["auto", "tr-tr-qwerty", "en-us-qwerty", "failsafe"].includes(currentLayout)
            ? []
            : [{ value: currentLayout, label: KEYBOARD_LAYOUTS.find((k) => k.value === currentLayout)?.label ?? currentLayout }]),
        ];
  /** Saves the layout on the connection and reconnects so guacd uses it. */
  const changeLayout = async (layout: string) => {
    const c = conn.data;
    if (!c || layout === currentLayout) return;
    try {
      if (quick) {
        await patch(connectionBase(c.id), { settings: { server_layout: layout } });
        await conn.refetch();
        reconnect();
        return;
      }
      // Only the layout changes, so this works on shared connections too.
      await put(`/api/connections/${c.id}/keyboard-layout`, { server_layout: layout });
      await conn.refetch();
      reconnect();
    } catch (e) {
      setError({ title: "Could not change the keyboard layout.", detail: errorMessage(e) });
      setPhase("error");
    }
  };

  return (
    <div
      className="dark relative flex h-full overflow-hidden bg-[#05070a] text-fg"
      data-session-pane
      onPointerDownCapture={() => onActivate?.()}
      onFocusCapture={() => onActivate?.()}
    >
      {/* Files: SFTP for SSH sessions, the transfer drive for RDP (docked left). */}
      {filesOpen && conn.data && (
        <aside className="z-10 flex w-[360px] shrink-0 flex-col border-r border-border bg-surface" data-no-capture>
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <h2 className="text-sm font-semibold">{protocol === "ssh" ? "Files" : "Transfer drive"}</h2>
            <button onClick={() => setFilesOpen(false)} className="rounded p-1 text-muted hover:bg-surface-2" aria-label="Close files">
              <X className="h-4 w-4" />
            </button>
          </div>
          {protocol === "ssh" ? (
            <SessionFiles conn={conn.data} />
          ) : (
            <>
              <p className="border-b border-border px-3 py-2 text-2xs leading-relaxed text-subtle">
                This folder is the <b className="font-medium text-muted">emremote</b> drive inside the remote session. In File Explorer open{" "}
                <span className="font-mono text-muted">\\tsclient\emremote</span> (or This PC → Network locations → "emremote on …"). Upload here to open
                files there; copy files to that drive to download them here.
              </p>
              <div className="min-h-0 flex-1">
                <FileBrowser compact base={`/api/devices/${conn.data.device_id}/transfer`} />
              </div>
            </>
          )}
        </aside>
      )}

      {/* Remote display: always the whole window; scrolls only when zoomed in. */}
      <div
        ref={viewportRef}
        tabIndex={0}
        aria-label={`Remote screen of ${title}`}
        data-remote-size={remoteSize ? `${remoteSize[0]}×${remoteSize[1]}` : undefined}
        onMouseDown={() => viewportRef.current?.focus()}
        onDragOver={(e) => {
          if (driveRef.current.enabled && e.dataTransfer.types.includes("Files")) {
            e.preventDefault();
            setDropping(true);
          }
        }}
        onDragLeave={(e) => {
          if (e.currentTarget === e.target) setDropping(false);
        }}
        onDrop={(e) => {
          setDropping(false);
          if (driveRef.current.enabled && e.dataTransfer.files.length) {
            e.preventDefault();
            sendToDriveRef.current(Array.from(e.dataTransfer.files));
          }
        }}
        className={clsx("relative min-w-0 flex-1 outline-none", fit ? "overflow-hidden" : "overflow-auto")}
      >
        {dropping && (
          <div className="pointer-events-none absolute inset-3 z-20 flex items-center justify-center rounded-xl border-2 border-dashed border-accent/70 bg-accent/10 text-sm font-medium text-fg">
            Drop to send to the remote computer
          </div>
        )}
        {/* Receives the browser's paste event for Ctrl+V / ⌘V; never visible. */}
        <textarea
          ref={pasteSinkRef}
          data-paste-sink
          aria-hidden="true"
          tabIndex={-1}
          readOnly={false}
          value=""
          onChange={() => {}}
          className="pointer-events-none fixed left-0 top-0 h-px w-px opacity-0"
        />
        <div
          ref={displayHostRef}
          className={clsx(
            fit ? "flex h-full w-full items-center justify-center" : "flex min-h-full min-w-full w-max items-center justify-center",
            phase !== "connected" && "pointer-events-none opacity-30",
          )}
        />

        {(phase === "loading" || phase === "connecting") && (
          <Overlay conn={conn.data}>
            <Spinner className="h-6 w-6 text-accent" />
            <p className="mt-4 text-sm text-muted">{phaseDetail}</p>
            <Button variant="ghost" size="sm" className="mt-4" onClick={disconnect}>
              Cancel
            </Button>
          </Overlay>
        )}

        {phase === "error" && error && (
          <Overlay conn={conn.data}>
            <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-danger/30 bg-danger/10">
              <AlertTriangle className="h-5 w-5 text-danger" />
            </div>
            <h2 className="mt-4 text-base font-semibold">{error.title}</h2>
            {error.hint && <p className="mt-2 max-w-md text-sm text-muted">{error.hint}</p>}
            {error.detail && <p className="mt-3 max-w-md break-words rounded bg-surface-2 px-3 py-2 font-mono text-2xs text-subtle">{error.detail}</p>}
            <div className="mt-6 flex gap-2">
              <Button variant="primary" icon={<RotateCw className="h-4 w-4" />} onClick={reconnect}>
                Try again
              </Button>
              {conn.data && !quick && (
                <Link to={`/devices/${conn.data.device_id}`}>
                  <Button icon={<ArrowLeft className="h-4 w-4" />}>Device settings</Button>
                </Link>
              )}
            </div>
          </Overlay>
        )}

        {phase === "disconnected" && (
          <Overlay conn={conn.data}>
            <div className="relative flex h-14 w-14 items-center justify-center rounded-2xl border border-white/10 bg-white/[0.04]">
              <Power className="h-6 w-6 text-muted" />
              <span className="absolute -right-1 -top-1 h-3 w-3 rounded-full border-2 border-[#0d1117] bg-danger" />
            </div>
            <h2 className="mt-5 text-lg font-semibold tracking-[-0.01em]">Session ended</h2>
            <p className="mt-2 max-w-sm text-sm leading-relaxed text-muted">
              The connection to {conn.data?.device_name ?? "the remote computer"} was closed
              {endedAfter !== null ? <> after {duration(endedAfter)}</> : null}. It may have been closed on the remote computer, by an administrator, or
              the network dropped.
            </p>
            <div className="mt-6 flex w-full flex-wrap justify-center gap-2">
              <Button variant="primary" icon={<RotateCw className="h-4 w-4" />} onClick={reconnect}>
                Reconnect
              </Button>
              <Button icon={<X className="h-4 w-4" />} onClick={() => (onClose ? onClose() : window.close())}>
                Close tab
              </Button>
            </div>
            <p className="mt-4 flex items-center gap-3 text-xs text-subtle">
              <span>
                Press <kbd className="kbd">Enter</kbd> to reconnect
              </span>
              {conn.data && (
                <a className="text-muted underline-offset-2 hover:text-fg hover:underline" href={`/devices/${conn.data.device_id}`} target="emremote-main" rel="noopener">
                  Open device page
                </a>
              )}
            </p>
          </Overlay>
        )}
      </div>

      {phase === "connected" && driveRef.current.enabled && (
        <FloatingFileButton onOpen={openTransferFolder} title={`Open ${TRANSFER_PATH} in Windows (a file window on the remote computer)`} />
      )}
      {selecting && (
        <AreaSelect
          onCancel={() => setSelecting(false)}
          onDone={(r) => {
            setSelecting(false);
            window.setTimeout(() => takeScreenshot(r), 30);
          }}
        />
      )}
      {shareOpen && <ShareDialog sessionId={tunnelRef.current?.uuid ?? ""} open={shareOpen} onOpenChange={setShareOpen} />}
      {snippetsOpen && <SnippetsPanel disabled={phase !== "connected"} onInsert={(text) => typeText(text)} onClose={() => setSnippetsOpen(false)} />}

      {/* Clipboard panel (docked right, never covers the screen). */}
      {clipOpen && (
        <aside data-no-capture className="z-10 flex w-80 shrink-0 flex-col border-l border-border bg-surface">
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <h2 className="text-sm font-semibold">Clipboard</h2>
            <button onClick={() => setClipOpen(false)} className="rounded p-1 text-muted hover:bg-surface-2" aria-label="Close clipboard">
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-3 text-sm">
            <div>
              <label className="label">From remote computer</label>
              <textarea className="input min-h-[110px] font-mono text-xs" readOnly value={remoteClip} placeholder="Copy something on the remote computer…" />
              <p className="mt-1 text-2xs text-subtle">Copied to this computer's clipboard automatically.</p>
            </div>
            <div>
              <label className="label">Send to remote computer</label>
              <textarea className="input min-h-[110px] font-mono text-xs" value={localClip} onChange={(e) => setLocalClip(e.target.value)} placeholder="Paste text here, then press Send." />
              <div className="mt-2 flex gap-2">
                <Button size="sm" variant="primary" disabled={phase !== "connected" || !localClip} onClick={() => sendClipboard(localClip)}>
                  Send
                </Button>
                <Button size="sm" disabled={phase !== "connected" || !localClip} onClick={() => typeText(localClip)} title="Types the text key by key, for login screens and other places where paste does not work">
                  Type it
                </Button>
              </div>
              <p className="mt-2 text-2xs text-subtle">
                Usually not needed: {isMacClient() ? "⌘V" : "Ctrl+V"} in the session pastes from this computer directly.
                {protocol === "ssh" || protocol === "telnet" ? " Right-click also pastes; selecting text copies it." : " Right-click → Paste uses the same text."}
              </p>
            </div>
          </div>
        </aside>
      )}

      <SessionToolbar
        protocol={protocol}
        active={active}
        profile={sessionProfile(protocol, conn.data?.device_os)}
        terminalAppearance={
          conn.data && (protocol === "ssh" || protocol === "telnet")
            ? {
                current: {
                  color_scheme: termPrefs.color_scheme ?? (conn.data.settings as SSHSettings).color_scheme ?? "gray-black",
                  font_name: termPrefs.font_name ?? (conn.data.settings as SSHSettings).font_name ?? "",
                  font_size: termPrefs.font_size ?? (conn.data.settings as SSHSettings).font_size ?? 12,
                },
                customized: Object.keys(termPrefs).length > 0,
                onChange: changeTerminal,
                onReset: () => changeTerminal(null),
              }
            : undefined
        }
        title={title}
        status={
          <>
            {statusPill}
            {conn.data && <OsIcon os={conn.data.device_os} />}
            <span className="truncate font-medium">{conn.data?.device_name ?? "Remote session"}</span>
            {conn.data && <ProtocolBadge protocol={conn.data.protocol} />}
          </>
        }
        connected={phase === "connected"}
        zoomLabel={`${Math.round(scale * 100)}%`}
        fit={fit}
        onZoom={zoomBy}
        onFit={() => setPrefs({ zoom: "fit" })}
        onActualSize={() => setPrefs({ zoom: 100 })}
        latched={latched}
        onLatch={toggleLatch}
        onKeys={sendCombo}
        filesAvailable={filesAvailable}
        filesOpen={filesOpen}
        onFiles={() => setFilesOpen((o) => !o)}
        clipOpen={clipOpen}
        onClipboard={() => {
          setSnippetsOpen(false);
          setClipOpen((o) => !o);
        }}
        onScreenshot={(m) => (m === "full" ? takeScreenshot() : setSelecting(true))}
        onShare={can("sessions.connect") ? () => setShareOpen(true) : undefined}
        snippetsOpen={snippetsOpen}
        onSnippets={
          (protocol === "ssh" || protocol === "telnet") && can("sessions.connect")
            ? () => {
                setClipOpen(false);
                setSnippetsOpen((o) => !o);
              }
            : undefined
        }
        resolution={prefs.resolution}
        onResolution={(r) => setPrefs({ resolution: r })}
        nativeDensity={prefs.density === "native"}
        onNativeDensity={(v) => setPrefs({ density: v ? "native" : "auto" })}
        keyboardInfo={keyboardInfo}
        keyboardLayout={currentLayout}
        keyboardOptions={keyboardOptions}
        onKeyboardLayout={changeLayout}
        remoteSize={remoteSize ? `${remoteSize[0]}×${remoteSize[1]}` : undefined}
        fullscreen={fullscreen}
        onFullscreen={toggleFullscreen}
        onDisconnect={disconnect}
        onReconnect={reconnect}
        canReconnect={phase === "disconnected" || phase === "error"}
        insetLeft={filesOpen ? 360 : 0}
        insetRight={clipOpen || snippetsOpen ? 320 : 0}
      />

      {required && <RequiredDialog params={required} protocol={protocol} defaultUser={conn.data?.username ?? ""} onSubmit={submitRequired} onCancel={disconnect} />}
    </div>
  );
}

function SessionFiles({ conn }: { conn: Connection }) {
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

function Overlay({ children, conn }: { children: ReactNode; conn?: Connection }) {
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

function FullMessage({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
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

const PARAM_LABELS: Record<string, string> = { username: "Username", password: "Password", domain: "Domain" };

function RequiredDialog({
  params,
  protocol,
  defaultUser,
  onSubmit,
  onCancel,
}: {
  params: string[];
  protocol?: string;
  defaultUser: string;
  onSubmit: (v: Record<string, string>) => void;
  onCancel: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>((): Record<string, string> => (params.includes("username") ? { username: defaultUser } : {}));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit(values);
  };
  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/60 px-4" data-no-capture>
      <form noValidate onSubmit={submit} className="w-full max-w-sm rounded-xl border border-border bg-surface p-5 shadow-pop">
        <div className="mb-4 flex items-center gap-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent/10 text-accent">
            <Lock className="h-4 w-4" />
          </span>
          <div>
            <h2 className="text-sm font-semibold">Sign in to the remote computer</h2>
            <p className="text-xs text-subtle">
              {protocol ? PROTOCOL_LABELS[protocol as "rdp"] : "The server"} requires credentials. They are not stored.
            </p>
          </div>
        </div>
        <div className="space-y-3">
          {params.map((p, i) => (
            <Field key={p} label={PARAM_LABELS[p] ?? p}>
              <input
                className="input"
                type={p === "password" || p === "passphrase" ? "password" : "text"}
                value={values[p] ?? ""}
                onChange={(e) => setValues((v) => ({ ...v, [p]: e.target.value }))}
                autoFocus={i === 0 && !(p === "username" && defaultUser) ? true : p === "password" && !!defaultUser}
                autoComplete={p === "password" ? "current-password" : p === "username" ? "username" : "off"}
                autoCapitalize="off"
                spellCheck={false}
              />
            </Field>
          ))}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="primary" type="submit">
            Continue
          </Button>
        </div>
      </form>
    </div>
  );
}
