import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import clsx from "clsx";
import { AlertTriangle, ArrowLeft, ChevronDown, ChevronUp, Lock, Power, RotateCw, Search, X } from "lucide-react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import { SessionToolbar } from "@/components/SessionToolbar";
import { Overlay, SessionFiles } from "@/components/SessionParts";
import { SnippetsPanel } from "@/components/SnippetsPanel";
import { ShareDialog } from "@/components/ShareDialog";
import { ProtocolBadge } from "@/components/Status";
import { OsIcon } from "@/components/OsIcon";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Spinner } from "@/components/ui/Spinner";
import { copyText } from "@/components/ui/misc";
import { useToast } from "@/components/ui/Toast";
import { connectionBase, isQuickConnection } from "@/hooks/queries";
import { ApiError, errorMessage, post } from "@/lib/api";
import { useAccess } from "@/lib/auth";
import { isMacClient } from "@/lib/clipboard";
import { duration } from "@/lib/format";
import { loadTerminalPrefs, saveTerminalPrefs, terminalRequest, type TerminalPrefs } from "@/lib/terminalPrefs";
import { keysToSequence, xtermFont, xtermTheme } from "@/lib/xterm";
import type { Connection, SSHSettings } from "@/lib/types";
import type { Phase, SessionViewProps } from "./Session";

/** What the server says about the terminal when the session is authorized. */
interface TerminalConfig {
  color_scheme: string;
  font_name: string;
  font_size: number;
  scrollback: number;
  backspace: number;
  read_only: boolean;
  disable_copy: boolean;
  disable_paste: boolean;
}

interface TicketResponse {
  ticket: string;
  engine?: "terminal";
  recording?: boolean;
  username?: string;
  terminal: TerminalConfig;
}

const SEARCH_DECORATIONS = {
  matchBackground: "#facc1555",
  matchOverviewRuler: "#facc15",
  activeMatchBackground: "#facc15",
  activeMatchColorOverviewRuler: "#f59e0b",
};

// A large paste goes to the server in pieces, well under the WebSocket message limit.
const SEND_CHUNK = 256 << 10;

/**
 * The built-in SSH terminal: xterm.js in the browser, carried by emremote's own SSH client. It behaves like a desktop
 * SSH client: selecting copies, right-click pastes (or only copies while text is selected), Ctrl+V and Shift+Insert
 * paste as one bracketed paste, Ctrl+Shift+C copies, Ctrl+Shift+F searches and Ctrl +/- changes the text size.
 */
export function TerminalSessionView({ connectionId, conn, active, embedded, onInfo, onActivate, onClose }: SessionViewProps & { conn: Connection }) {
  const quick = isQuickConnection(connectionId);
  const { can } = useAccess();
  const toast = useToast();
  const rootRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const cfgRef = useRef<TerminalConfig | null>(null);
  const latchedRef = useRef<Set<number>>(new Set());
  const credsRef = useRef<{ username: string; password: string } | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const [phaseDetail, setPhaseDetail] = useState("Preparing…");
  const [error, setError] = useState<{ title: string; hint?: string; detail?: string } | null>(null);
  const [askCreds, setAskCreds] = useState<{ message: string; username: string } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [recording, setRecording] = useState(false);
  const [sessionId, setSessionId] = useState("");
  const [endReason, setEndReason] = useState("");
  const [endedAfter, setEndedAfter] = useState<number | null>(null);
  const [termPrefs, setTermPrefs] = useState<TerminalPrefs>(loadTerminalPrefs);
  const termPrefsRef = useRef(termPrefs);
  const [fontSize, setFontSize] = useState<number | null>(null);
  const [latched, setLatched] = useState<Set<number>>(new Set());
  const [fullscreen, setFullscreen] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  const [clipOpen, setClipOpen] = useState(false);
  const [clipText, setClipText] = useState("");
  const [snippetsOpen, setSnippetsOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const reconnectRef = useRef(() => {});

  const settings = conn.settings as SSHSettings;
  const title = `${conn.device_name} · ${conn.name}`;

  useEffect(() => {
    if (!embedded) document.title = `${title} | emremote`;
  }, [title, embedded]);
  useEffect(() => {
    onInfo?.({ title, phase, protocol: conn.protocol });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title, phase]);

  /** Sends typed text or a paste to the server. */
  const send = useCallback((data: string) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || cfgRef.current?.read_only) return;
    const bytes = new TextEncoder().encode(data);
    for (let i = 0; i < bytes.length; i += SEND_CHUNK) ws.send(bytes.subarray(i, i + SEND_CHUNK));
  }, []);

  const pasteText = useCallback(
    (text: string) => {
      const term = termRef.current;
      if (!term || !text || cfgRef.current?.disable_paste || cfgRef.current?.read_only) return;
      term.paste(text); // xterm.js wraps it as a bracketed paste when the remote program asked for that
      term.focus();
    },
    [],
  );

  const copySelection = useCallback(() => {
    const term = termRef.current;
    if (!term?.hasSelection() || cfgRef.current?.disable_copy) return false;
    void copyText(term.getSelection());
    return true;
  }, []);

  const pasteFromClipboard = useCallback(async () => {
    if (cfgRef.current?.disable_paste) return;
    try {
      pasteText(await navigator.clipboard.readText());
    } catch {
      toast.info(`The browser did not allow reading the clipboard. Paste with ${isMacClient() ? "⌘V" : "Ctrl+V or Shift+Insert"} instead.`);
    }
  }, [pasteText, toast]);

  // ---- Connect ----
  useEffect(() => {
    let cancelled = false;
    let ro: ResizeObserver | null = null;
    let readyAt = 0;
    const cleanups: (() => void)[] = [];

    (async () => {
      setPhase("loading");
      setError(null);
      setEndReason("");
      setPhaseDetail("Signing in…");
      const host = hostRef.current!;
      let r: TicketResponse;
      try {
        const creds = credsRef.current;
        r = await post<TicketResponse>(`${connectionBase(connectionId)}/sessions`, {
          width: Math.max(64, Math.min(8192, host.clientWidth || 800)),
          height: Math.max(64, Math.min(8192, host.clientHeight || 600)),
          dpi: 96,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? "",
          terminal: terminalRequest(termPrefsRef.current),
          ...(creds ? { username: creds.username, password: creds.password } : {}),
        });
      } catch (e) {
        if (cancelled) return;
        if (e instanceof ApiError && (e.code === "credentials_required" || e.code === "authentication_failed")) {
          setAskCreds({ message: e.message, username: credsRef.current?.username ?? conn.username ?? "" });
          setPhase("error");
          return;
        }
        setError(
          e instanceof ApiError && e.code === "target_not_allowed"
            ? { title: "This target is blocked by the server's network policy.", hint: "See EMREMOTE_ALLOWED_TARGET_NETWORKS in docs/SECURITY.md.", detail: e.message }
            : e instanceof ApiError && e.code === "host_key_mismatch"
              ? { title: "The server's identity has changed.", detail: e.message }
              : { title: "Could not start the session.", detail: errorMessage(e) },
        );
        setPhase("error");
        return;
      }
      if (cancelled) return;
      credsRef.current = null; // typed credentials are used once
      const cfg = r.terminal;
      cfgRef.current = cfg;
      setRecording(!!r.recording);
      setFontSize(termPrefsRef.current.font_size ?? cfg.font_size);
      setPhase("connecting");
      setPhaseDetail(`Connecting to ${conn.device_name}…`);

      const term = new Terminal({
        fontFamily: xtermFont(cfg.font_name),
        fontSize: termPrefsRef.current.font_size ?? cfg.font_size,
        theme: xtermTheme(cfg.color_scheme),
        scrollback: cfg.scrollback,
        cursorBlink: true,
        allowProposedApi: true,
        macOptionIsMeta: true,
        rightClickSelectsWord: false,
        drawBoldTextInBrightColors: true,
        disableStdin: cfg.read_only,
      });
      termRef.current = term;
      const fit = new FitAddon();
      fitRef.current = fit;
      const search = new SearchAddon();
      searchRef.current = search;
      term.loadAddon(fit);
      term.loadAddon(search);
      term.loadAddon(new Unicode11Addon());
      term.unicode.activeVersion = "11";
      term.loadAddon(new WebLinksAddon((_e, uri) => window.open(uri, "_blank", "noopener,noreferrer")));
      term.open(host);
      try {
        const gl = new WebglAddon();
        gl.onContextLoss(() => gl.dispose()); // falls back to the DOM renderer
        term.loadAddon(gl);
      } catch {
        /* no WebGL: the DOM renderer is used */
      }
      fit.fit();
      cleanups.push(() => term.dispose());

      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(`${proto}//${location.host}/api/terminal?ticket=${encodeURIComponent(r.ticket)}&cols=${term.cols}&rows=${term.rows}`);
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;
      cleanups.push(() => ws.close());

      ws.onmessage = (ev) => {
        if (ev.data instanceof ArrayBuffer) {
          term.write(new Uint8Array(ev.data));
          return;
        }
        let m: { type?: string; session_id?: string; reason?: string; recording?: boolean };
        try {
          m = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (m.type === "ready") {
          readyAt = Date.now();
          setSessionId(m.session_id ?? "");
          setRecording(!!m.recording);
          setPhase("connected");
          if (activeRef.current) term.focus();
        } else if (m.type === "exit") {
          setEndReason(m.reason ?? "");
        }
      };
      ws.onclose = () => {
        if (cancelled) return;
        wsRef.current = null;
        if (readyAt) {
          setEndedAfter(Math.round((Date.now() - readyAt) / 1000));
          setPhase("disconnected");
        } else {
          setError((e) => e ?? { title: "The session could not be opened.", detail: "The connection closed before the terminal was ready." });
          setPhase("error");
        }
        if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      };

      term.onData(send);
      term.onBinary((d) => {
        const ws = wsRef.current;
        if (ws?.readyState === WebSocket.OPEN && !cfgRef.current?.read_only) ws.send(Uint8Array.from(d, (c) => c.charCodeAt(0)));
      });
      term.onResize(({ cols, rows }) => {
        const ws = wsRef.current;
        if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "resize", cols, rows }));
      });

      // The terminal follows the size of its area.
      let frame = 0;
      ro = new ResizeObserver(() => {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => {
          try {
            fit.fit();
          } catch {
            /* not laid out */
          }
        });
      });
      ro.observe(host);

      // Keys handled here instead of being sent to the server.
      term.attachCustomKeyEventHandler((e) => {
        if (e.type !== "keydown") return true;
        // After the session ended the output stays readable; R or Enter starts a new session.
        if (phaseRef.current === "disconnected") {
          if ((e.key === "Enter" || e.key === "r" || e.key === "R") && !e.ctrlKey && !e.metaKey && !e.altKey) {
            e.preventDefault();
            reconnectRef.current();
            return false;
          }
        }
        const mac = isMacClient();
        const code = e.code;
        // Copy: Ctrl+Shift+C, Ctrl+Insert, ⌘C.
        if ((e.ctrlKey && e.shiftKey && code === "KeyC") || (e.ctrlKey && code === "Insert") || (mac && e.metaKey && code === "KeyC")) {
          copySelection();
          e.preventDefault();
          return false;
        }
        // Paste: Ctrl+V, Ctrl+Shift+V, Shift+Insert, ⌘V. The browser then delivers a paste event to the terminal,
        // which sends it as one bracketed paste.
        if ((e.ctrlKey && code === "KeyV") || (e.shiftKey && code === "Insert") || (mac && e.metaKey && code === "KeyV")) {
          return false;
        }
        // Search: Ctrl+Shift+F.
        if (e.ctrlKey && e.shiftKey && code === "KeyF") {
          e.preventDefault();
          setSearchOpen(true);
          window.setTimeout(() => searchInputRef.current?.select(), 0);
          return false;
        }
        // Text size: Ctrl + / Ctrl - / Ctrl 0 (⌘ on a Mac).
        if ((mac ? e.metaKey : e.ctrlKey) && !e.shiftKey && !e.altKey && ["Equal", "NumpadAdd", "Minus", "NumpadSubtract", "Digit0"].includes(code)) {
          e.preventDefault();
          if (code === "Digit0") resetFontRef.current();
          else zoomRef.current(code === "Minus" || code === "NumpadSubtract" ? -1 : 1);
          return false;
        }
        // Backspace sends BS instead of DEL when the connection is set to.
        if (e.key === "Backspace" && !e.ctrlKey && !e.altKey && !e.metaKey && cfgRef.current?.backspace === 8) {
          e.preventDefault();
          send("\b");
          return false;
        }
        // Modifiers held from the toolbar apply to the next key.
        if (latchedRef.current.size && e.key.length === 1) {
          const seq = keysToSequence([...latchedRef.current, e.key.toLowerCase().charCodeAt(0)]);
          latchedRef.current = new Set();
          setLatched(new Set());
          if (seq) {
            e.preventDefault();
            send(seq);
            return false;
          }
        }
        return true;
      });

      // Like PuTTY and MobaXterm: releasing the mouse after selecting copies, right-click pastes, and right-click
      // while text is selected only copies.
      const onMouseUp = (e: MouseEvent) => {
        if (e.button === 0) window.setTimeout(copySelection, 0);
      };
      const onContextMenu = (e: MouseEvent) => {
        e.preventDefault();
        if (term.hasSelection()) {
          copySelection();
          term.clearSelection();
        } else void pasteFromClipboard();
        term.focus();
      };
      const onAuxClick = (e: MouseEvent) => {
        if (e.button === 1) {
          e.preventDefault();
          void pasteFromClipboard();
        }
      };
      // Settings that forbid copying or pasting also stop the browser's own shortcuts.
      const onPaste = (e: ClipboardEvent) => {
        if (cfgRef.current?.disable_paste || cfgRef.current?.read_only) {
          e.preventDefault();
          e.stopImmediatePropagation();
        }
      };
      const onCopy = (e: ClipboardEvent) => {
        if (cfgRef.current?.disable_copy) {
          e.preventDefault();
          e.stopImmediatePropagation();
        }
      };
      host.addEventListener("mouseup", onMouseUp);
      host.addEventListener("contextmenu", onContextMenu);
      host.addEventListener("auxclick", onAuxClick);
      host.addEventListener("paste", onPaste, true);
      host.addEventListener("copy", onCopy, true);
      cleanups.push(() => {
        host.removeEventListener("mouseup", onMouseUp);
        host.removeEventListener("contextmenu", onContextMenu);
        host.removeEventListener("auxclick", onAuxClick);
        host.removeEventListener("paste", onPaste, true);
        host.removeEventListener("copy", onCopy, true);
      });
    })();

    return () => {
      cancelled = true;
      ro?.disconnect();
      for (const c of cleanups.reverse()) c();
      wsRef.current = null;
      termRef.current = null;
      fitRef.current = null;
      searchRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId, attempt]);

  // In a workspace the keyboard follows the active pane.
  useEffect(() => {
    if (active && phase === "connected") termRef.current?.focus();
    else if (!active) termRef.current?.blur();
  }, [active, phase]);

  useEffect(() => {
    const onChange = () => {
      setFullscreen(document.fullscreenElement === rootRef.current);
      window.setTimeout(() => fitRef.current?.fit(), 50);
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  // ---- Appearance ----
  const applyFont = (size: number) => {
    const s = Math.max(6, Math.min(48, size));
    setFontSize(s);
    const term = termRef.current;
    if (term) {
      term.options.fontSize = s;
      fitRef.current?.fit();
    }
    return s;
  };
  const zoomRef = useRef<(d: number) => void>(() => {});
  zoomRef.current = (d: number) => applyFont((fontSize ?? 12) + d);
  const resetFontRef = useRef(() => {});
  resetFontRef.current = () => applyFont(termPrefsRef.current.font_size ?? cfgRef.current?.font_size ?? 12);

  /** Personal appearance: applied at once, nothing reconnects. */
  const changeTerminal = (p: Partial<TerminalPrefs> | null) => {
    const next = p === null ? {} : { ...termPrefsRef.current, ...p };
    termPrefsRef.current = next;
    setTermPrefs(next);
    saveTerminalPrefs(next);
    const term = termRef.current;
    const cfg = cfgRef.current;
    if (!term || !cfg) return;
    term.options.theme = xtermTheme(next.color_scheme ?? cfg.color_scheme);
    term.options.fontFamily = xtermFont(next.font_name ?? cfg.font_name);
    applyFont(next.font_size ?? cfg.font_size);
  };

  const toggleLatch = (k: number) => {
    const next = new Set(latchedRef.current);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    latchedRef.current = next;
    setLatched(next);
    termRef.current?.focus();
  };
  const sendCombo = (...keys: number[]) => {
    const seq = keysToSequence([...latchedRef.current, ...keys]);
    latchedRef.current = new Set();
    setLatched(new Set());
    if (seq) send(seq);
    termRef.current?.focus();
  };

  const reconnect = () => {
    setError(null);
    setAskCreds(null);
    setAttempt((a) => a + 1);
  };
  reconnectRef.current = reconnect;
  const disconnect = () => {
    wsRef.current?.close();
    setPhase("disconnected");
  };
  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void rootRef.current?.requestFullscreen?.();
  };

  const find = (dir: 1 | -1) => {
    const s = searchRef.current;
    if (!s || !query) return;
    if (dir === 1) s.findNext(query, { decorations: SEARCH_DECORATIONS });
    else s.findPrevious(query, { decorations: SEARCH_DECORATIONS });
  };
  const closeSearch = () => {
    setSearchOpen(false);
    searchRef.current?.clearDecorations();
    termRef.current?.focus();
  };

  const statusPill =
    phase === "connected" ? (
      <span className="h-2 w-2 shrink-0 rounded-full bg-success" title="Connected" />
    ) : phase === "connecting" || phase === "loading" ? (
      <Spinner className="h-3 w-3 text-muted" />
    ) : (
      <span className="h-2 w-2 shrink-0 rounded-full bg-subtle" title="Disconnected" />
    );
  const filesAvailable = !quick && conn.device_os !== "network" && can("files.use");
  const cfg = cfgRef.current;
  const background = xtermTheme(termPrefs.color_scheme ?? cfg?.color_scheme ?? settings.color_scheme ?? "gray-black").background;

  return (
    <div
      ref={rootRef}
      className="dark relative flex h-full overflow-hidden bg-[#05070a] text-fg"
      data-session-pane
      onPointerDownCapture={() => onActivate?.()}
      onFocusCapture={() => onActivate?.()}
    >
      {filesOpen && (
        <aside className="z-10 flex w-[360px] shrink-0 flex-col border-r border-border bg-surface" data-no-capture>
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <h2 className="text-sm font-semibold">Files</h2>
            <button onClick={() => setFilesOpen(false)} className="rounded p-1 text-muted hover:bg-surface-2" aria-label="Close files">
              <X className="h-4 w-4" />
            </button>
          </div>
          <SessionFiles conn={conn} />
        </aside>
      )}

      <div className="relative min-w-0 flex-1" style={{ background }}>
        <div
          ref={hostRef}
          aria-label={`Terminal of ${title}`}
          data-terminal
          className={clsx("absolute inset-0 px-1.5 pb-1 pt-1.5", phase !== "connected" && phase !== "disconnected" && "opacity-30")}
        />

        {searchOpen && (
          <div data-no-capture className="absolute right-3 top-14 z-20 flex items-center gap-1 rounded-lg border border-white/10 bg-[#111317]/95 p-1 shadow-lg">
            <Search className="ml-1.5 h-3.5 w-3.5 text-subtle" />
            <input
              ref={searchInputRef}
              autoFocus
              className="h-7 w-48 bg-transparent px-1 text-sm text-fg outline-none placeholder:text-subtle"
              placeholder="Find in the terminal"
              aria-label="Find in the terminal"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                if (e.target.value) searchRef.current?.findNext(e.target.value, { incremental: true, decorations: SEARCH_DECORATIONS });
                else searchRef.current?.clearDecorations();
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") find(e.shiftKey ? -1 : 1);
                if (e.key === "Escape") closeSearch();
              }}
            />
            <button className="rounded p-1 text-muted hover:bg-white/10 hover:text-fg" onClick={() => find(-1)} aria-label="Previous match" title="Previous match (Shift+Enter)">
              <ChevronUp className="h-4 w-4" />
            </button>
            <button className="rounded p-1 text-muted hover:bg-white/10 hover:text-fg" onClick={() => find(1)} aria-label="Next match" title="Next match (Enter)">
              <ChevronDown className="h-4 w-4" />
            </button>
            <button className="rounded p-1 text-muted hover:bg-white/10 hover:text-fg" onClick={closeSearch} aria-label="Close search" title="Close (Esc)">
              <X className="h-4 w-4" />
            </button>
          </div>
        )}

        {(phase === "loading" || phase === "connecting") && (
          <Overlay conn={conn}>
            <Spinner className="h-6 w-6 text-accent" />
            <p className="mt-4 text-sm text-muted">{phaseDetail}</p>
            <Button variant="ghost" size="sm" className="mt-4" onClick={disconnect}>
              Cancel
            </Button>
          </Overlay>
        )}

        {phase === "error" && error && (
          <Overlay conn={conn}>
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
              {!quick && (
                <Link to={`/devices/${conn.device_id}`}>
                  <Button icon={<ArrowLeft className="h-4 w-4" />}>Device settings</Button>
                </Link>
              )}
            </div>
          </Overlay>
        )}

        {phase === "disconnected" && (
          // A bar instead of a cover: the output stays readable and can still be selected and copied.
          <div data-no-capture role="status" className="absolute inset-x-0 bottom-0 z-20 flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-white/10 bg-[#111317]/95 px-4 py-2.5 text-sm shadow-[0_-8px_30px_rgb(0_0_0/0.4)]">
            <Power className="h-4 w-4 shrink-0 text-danger" />
            <span className="font-medium">Session ended</span>
            <span className="min-w-0 text-muted">
              {endReason || `The connection to ${conn.device_name} was closed.`}
              {endedAfter !== null ? <> It lasted {duration(endedAfter)}.</> : null}
            </span>
            <div className="ml-auto flex items-center gap-2">
              <span className="hidden text-2xs text-subtle sm:inline">
                Press <kbd className="kbd">R</kbd> or <kbd className="kbd">Enter</kbd>
              </span>
              <Button size="sm" variant="primary" icon={<RotateCw className="h-3.5 w-3.5" />} onClick={reconnect}>
                Reconnect
              </Button>
              <Button size="sm" icon={<X className="h-3.5 w-3.5" />} onClick={() => (onClose ? onClose() : window.close())}>
                Close tab
              </Button>
            </div>
          </div>
        )}
      </div>

      {shareOpen && <ShareDialog sessionId={sessionId} open={shareOpen} onOpenChange={setShareOpen} />}
      {snippetsOpen && (
        <SnippetsPanel
          disabled={phase !== "connected"}
          onInsert={(text, run) => {
            pasteText(text);
            if (run) send("\r");
          }}
          onClose={() => setSnippetsOpen(false)}
        />
      )}

      {clipOpen && (
        <aside data-no-capture className="z-10 flex w-80 shrink-0 flex-col border-l border-border bg-surface">
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <h2 className="text-sm font-semibold">Clipboard</h2>
            <button onClick={() => setClipOpen(false)} className="rounded p-1 text-muted hover:bg-surface-2" aria-label="Close clipboard">
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-3 text-sm">
            <Field label="Paste into the terminal">
              <textarea
                className="input min-h-[140px] font-mono text-xs"
                value={clipText}
                onChange={(e) => setClipText(e.target.value)}
                placeholder="Text or a script; it arrives as one paste, so editors keep its indentation."
              />
            </Field>
            <Button size="sm" variant="primary" disabled={phase !== "connected" || !clipText || !!cfg?.disable_paste} onClick={() => pasteText(clipText)}>
              Paste
            </Button>
            <ul className="space-y-1 text-2xs leading-relaxed text-subtle">
              <li>Select with the mouse to copy. Right-click pastes; with text selected it only copies.</li>
              <li>{isMacClient() ? "⌘C / ⌘V" : "Ctrl+Shift+C copies, Ctrl+V or Shift+Insert pastes"}. Ctrl+C stays the interrupt key.</li>
              <li>Ctrl+Shift+F finds text, {isMacClient() ? "⌘" : "Ctrl"} + and - change the text size.</li>
            </ul>
          </div>
        </aside>
      )}

      <SessionToolbar
        protocol={conn.protocol}
        active={active}
        profile="terminal"
        terminalAppearance={{
          current: {
            color_scheme: termPrefs.color_scheme ?? cfg?.color_scheme ?? settings.color_scheme ?? "gray-black",
            font_name: termPrefs.font_name ?? cfg?.font_name ?? settings.font_name ?? "",
            font_size: fontSize ?? termPrefs.font_size ?? cfg?.font_size ?? settings.font_size ?? 12,
          },
          customized: Object.keys(termPrefs).length > 0,
          onChange: changeTerminal,
          onReset: () => changeTerminal(null),
        }}
        title={title}
        status={
          <>
            {statusPill}
            <OsIcon os={conn.device_os} />
            <span className="truncate font-medium">{conn.device_name}</span>
            <ProtocolBadge protocol={conn.protocol} />
            {recording && (
              <span className="inline-flex items-center gap-1 rounded bg-danger/15 px-1.5 py-0.5 text-[10px] font-semibold text-danger" title="This session is being recorded">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-danger" /> REC
              </span>
            )}
          </>
        }
        connected={phase === "connected"}
        zoomLabel={`${fontSize ?? 12} px`}
        fit
        onZoom={(d) => zoomRef.current(d > 0 ? 1 : -1)}
        onFit={() => resetFontRef.current()}
        onActualSize={() => resetFontRef.current()}
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
        onShare={can("sessions.connect") && sessionId ? () => setShareOpen(true) : undefined}
        snippetsOpen={snippetsOpen}
        onSnippets={
          can("sessions.connect")
            ? () => {
                setClipOpen(false);
                setSnippetsOpen((o) => !o);
              }
            : undefined
        }
        resolution="window"
        onResolution={() => {}}
        nativeDensity={false}
        onNativeDensity={() => {}}
        fullscreen={fullscreen}
        onFullscreen={toggleFullscreen}
        onDisconnect={disconnect}
        onReconnect={reconnect}
        canReconnect={phase === "disconnected" || phase === "error"}
        insetLeft={filesOpen ? 360 : 0}
        insetRight={clipOpen || snippetsOpen ? 320 : 0}
      />

      {askCreds && (
        <CredentialsDialog
          message={askCreds.message}
          defaultUser={askCreds.username}
          onSubmit={(username, password) => {
            credsRef.current = { username, password };
            reconnect();
          }}
          onCancel={() => {
            setAskCreds(null);
            setError({ title: "Not signed in.", hint: "The server needs a username and password." });
          }}
        />
      )}
    </div>
  );
}

function CredentialsDialog({
  message,
  defaultUser,
  onSubmit,
  onCancel,
}: {
  message: string;
  defaultUser: string;
  onSubmit: (username: string, password: string) => void;
  onCancel: () => void;
}) {
  const [username, setUsername] = useState(defaultUser);
  const [password, setPassword] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (username.trim() && password) onSubmit(username.trim(), password);
  };
  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/60 px-4" data-no-capture>
      <form noValidate onSubmit={submit} className="w-full max-w-sm rounded-xl border border-border bg-surface p-5 shadow-pop">
        <div className="mb-4 flex items-center gap-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent/10 text-accent">
            <Lock className="h-4 w-4" />
          </span>
          <div>
            <h2 className="text-sm font-semibold">Sign in to the server</h2>
            <p className="text-xs text-subtle">{message} They are used for this session only and not stored.</p>
          </div>
        </div>
        <div className="space-y-3">
          <Field label="Username">
            <input
              className="input"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="e.g. root or admin"
              autoFocus={!defaultUser}
              autoComplete="username"
              autoCapitalize="off"
              spellCheck={false}
            />
          </Field>
          <Field label="Password">
            <input
              className="input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="The account's password"
              autoFocus={!!defaultUser}
              autoComplete="current-password"
            />
          </Field>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" disabled={!username.trim() || !password}>
            Sign in
          </Button>
        </div>
      </form>
    </div>
  );
}
