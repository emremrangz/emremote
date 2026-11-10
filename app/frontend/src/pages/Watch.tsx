import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { Link, useParams } from "react-router-dom";
import { Eye } from "lucide-react";
import { ApiError, errorMessage, get } from "@/lib/api";
import { loadGuacamole, ClientState, TunnelState, type GuacClient } from "@/lib/guac";
import { PageLoader } from "@/components/ui/Spinner";
import { ProtocolBadge } from "@/components/Status";
import { relativeTime } from "@/lib/format";
import { xtermFont, xtermTheme } from "@/lib/xterm";
import type { Protocol } from "@/lib/types";

interface Info {
  device_name: string;
  connection_name: string;
  protocol: Protocol;
  owner: string;
  started_at: string;
  /** "terminal": a session in the built-in SSH terminal; "gateway": drawn by guacd. */
  engine?: "terminal" | "gateway";
}

/** A shared session, watched read only (no input is ever sent). */
export default function WatchPage() {
  const { token = "" } = useParams();
  const [info, setInfo] = useState<Info | null>(null);
  const [phase, setPhase] = useState<"loading" | "connecting" | "live" | "ended" | "error">("loading");
  const [message, setMessage] = useState("");
  const viewport = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const clientRef = useRef<GuacClient | null>(null);
  const info0 = useRef<Info | null>(null);

  useEffect(() => {
    let cancelled = false;
    let client: GuacClient | null = null;
    let ro: ResizeObserver | null = null;
    let term: Terminal | null = null;
    let ws: WebSocket | null = null;
    (async () => {
      try {
        const i = await get<Info>(`/api/watch/${encodeURIComponent(token)}`);
        if (cancelled) return;
        info0.current = i;
        setInfo(i);
        document.title = `Watching ${i.device_name} | emremote`;
      } catch (e) {
        if (cancelled) return;
        setMessage(e instanceof ApiError && e.status === 404 ? "This shared session has ended, or the link is no longer valid." : errorMessage(e));
        setPhase("error");
        return;
      }
      if (info0.current?.engine === "terminal") {
        // The built-in terminal: the owner's output, at the owner's size, nothing is ever sent back.
        setPhase("connecting");
        term = new Terminal({ disableStdin: true, cursorBlink: false, fontFamily: xtermFont(""), fontSize: 13, theme: xtermTheme("gray-black"), scrollback: 5000 });
        term.open(host.current!);
        const proto = location.protocol === "https:" ? "wss:" : "ws:";
        ws = new WebSocket(`${proto}//${location.host}/api/watch-tunnel?${new URLSearchParams({ token })}`);
        ws.binaryType = "arraybuffer";
        ws.onmessage = (ev) => {
          if (ev.data instanceof ArrayBuffer) {
            term?.write(new Uint8Array(ev.data));
            return;
          }
          try {
            const m = JSON.parse(ev.data);
            if (m.type === "size") {
              term?.resize(m.cols, m.rows);
              setPhase("live");
            } else if (m.type === "exit") setPhase("ended");
          } catch {
            /* not a control message */
          }
        };
        ws.onclose = () => setPhase((p) => (p === "loading" || p === "connecting" ? "error" : p === "error" ? p : "ended"));
        setMessage("The shared session could not be joined, or it has ended.");
        return;
      }
      let G;
      try {
        G = await loadGuacamole();
      } catch (e) {
        setMessage(errorMessage(e));
        setPhase("error");
        return;
      }
      if (cancelled) return;
      setPhase("connecting");
      const tunnel = new G.WebSocketTunnel("/api/watch-tunnel");
      client = new G.Client(tunnel);
      clientRef.current = client;
      const display = client.getDisplay();
      const el: HTMLElement = display.getElement();
      host.current!.replaceChildren(el);
      const fit = () => {
        const vp = viewport.current;
        const w = display.getWidth();
        const h = display.getHeight();
        if (!vp || !w || !h) return;
        display.scale(Math.min(vp.clientWidth / w, vp.clientHeight / h));
      };
      display.onresize = fit;
      ro = new ResizeObserver(fit);
      ro.observe(viewport.current!);
      // The gateway closing the socket is how the session ending is announced.
      tunnel.onerror = () => setPhase((p) => (p === "error" ? p : "ended"));
      tunnel.onstatechange = (s: number) => {
        if (s === TunnelState.CLOSED) setPhase((p) => (p === "error" ? p : "ended"));
      };
      client.onstatechange = (s: number) => {
        if (s === ClientState.CONNECTED) setPhase("live");
        if (s === ClientState.DISCONNECTED) setPhase((p) => (p === "error" ? p : "ended"));
      };
      client.onerror = (status: { code?: number; message?: string }) => {
        // 0x20B: the session was closed (the owner stopped sharing or ended it).
        if (status.code === 0x020b || status.code === 0x0200) {
          setPhase("ended");
          return;
        }
        setMessage(status.message && !/^\d+$/.test(status.message) ? status.message : "The shared session could not be joined, or it has ended.");
        setPhase("error");
      };
      const vp = viewport.current!;
      const q = new URLSearchParams({ token, width: String(Math.round(vp.clientWidth)), height: String(Math.round(vp.clientHeight)), dpi: "96" });
      client.connect(q.toString());
    })();
    return () => {
      cancelled = true;
      ws?.close();
      term?.dispose();
      ro?.disconnect();
      try {
        client?.disconnect();
      } catch {
        /* already closed */
      }
    };
  }, [token]);

  return (
    <div className="dark flex h-full flex-col bg-[#05070a] text-fg">
      <header className="flex h-10 shrink-0 items-center gap-3 border-b border-white/10 bg-[#0b0d11] px-3 text-[13px]">
        <span className="flex items-center gap-1.5 rounded-md bg-white/10 px-2 py-0.5 text-xs font-medium">
          <Eye className="h-3.5 w-3.5" /> View only
        </span>
        {info ? (
          <>
            <span className="font-medium">{info.device_name}</span>
            <ProtocolBadge protocol={info.protocol} />
            <span className="text-muted">
              shared by {info.owner} · started {relativeTime(info.started_at)}
            </span>
          </>
        ) : (
          <span className="text-muted">Shared session</span>
        )}
        <span className="ml-auto text-xs text-muted">
          {phase === "connecting" ? "Connecting…" : phase === "live" ? "Live" : phase === "ended" ? "Ended" : ""}
        </span>
      </header>
      <div ref={viewport} className="relative min-h-0 flex-1 overflow-hidden">
        <div ref={host} className={info?.engine === "terminal" ? "absolute inset-0 overflow-auto bg-black p-1.5" : "absolute inset-0 flex items-center justify-center"} />
        {phase === "loading" && <PageLoader label="Opening shared session…" />}
        {(phase === "ended" || phase === "error") && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-[#05070a]/85 px-6 text-center">
            <p className="text-sm font-medium">{phase === "ended" ? "The shared session has ended." : message}</p>
            <Link to="/" className="text-sm font-medium text-accent hover:underline">
              Back to emremote
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
