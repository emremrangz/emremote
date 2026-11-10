import { useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { Maximize2, Minimize2, MousePointer2, Pause, Play, Route, SkipBack, SkipForward } from "lucide-react";
import { Dialog } from "@/components/ui/Dialog";
import { CastPlayer } from "@/components/CastPlayer";
import { Button } from "@/components/ui/Button";
import { loadGuacamole } from "@/lib/guac";
import { dateTime } from "@/lib/format";
import { MAX_TRACK_BYTES, activity, readMouseTrack, upperBound, type MouseClick, type MouseTrack } from "@/lib/recordingMouse";
import type { Recording } from "@/lib/types";

/* eslint-disable @typescript-eslint/no-explicit-any */

const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

const RIPPLE_MS = 700;
const TRAIL_MS = 600;
const COLORS: Record<MouseClick["button"], string> = { left: "250,204,21", middle: "96,165,250", right: "251,113,133" };

/** The choices "Highlight the pointer" and "Pointer trail" are remembered in this browser only. */
const PREF_KEY = "emremote.recording.player";
function loadPrefs(): { pointer: boolean; trail: boolean } {
  try {
    const p = JSON.parse(localStorage.getItem(PREF_KEY) ?? "{}");
    return { pointer: p.pointer !== false, trail: p.trail === true };
  } catch {
    return { pointer: true, trail: false };
  }
}
function savePrefs(p: { pointer: boolean; trail: boolean }) {
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify(p));
  } catch {
    /* storage unavailable */
  }
}

/** Plays a recorded session in the browser with the gateway's own display code. */
export function RecordingPlayer({ recording, onClose }: { recording: Recording | null; onClose: () => void }) {
  return (
    <Dialog
      open={!!recording}
      onOpenChange={(o) => !o && onClose()}
      title={recording ? `${recording.device_name} / ${recording.connection_name}` : ""}
      description={recording ? `${recording.username}, ${dateTime(recording.started_at)}` : undefined}
      size="2xl"
    >
      {recording && (recording.format === "cast" ? <CastPlayer key={recording.id} recording={recording} /> : <Player key={recording.id} recording={recording} />)}
    </Dialog>
  );
}

function Player({ recording }: { recording: Recording }) {
  const root = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const overlay = useRef<HTMLCanvasElement>(null);
  const rec = useRef<any>(null);
  const scale = useRef(1);
  const trackRef = useRef<MouseTrack | null>(null);
  const clickTimes = useRef<number[]>([]);
  const [duration, setDuration] = useState(0);
  const [position, setPosition] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [percent, setPercent] = useState(0);
  const [track, setTrack] = useState<MouseTrack | null>(null);
  const [skipped, setSkipped] = useState(false);
  const [prefs, setPrefs] = useState(loadPrefs);
  const [fullscreen, setFullscreen] = useState(false);
  const opts = useRef(prefs);
  const seeking = useRef(false);

  useEffect(() => {
    opts.current = prefs;
    savePrefs(prefs);
  }, [prefs]);

  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement === root.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  useEffect(() => {
    let dead = false;
    let timer = 0;
    let frame = 0;
    let r: any;
    const abort = new AbortController();

    // One download feeds both the player and the pointer reader.
    const download = async (): Promise<Blob> => {
      const res = await fetch(`/api/recordings/${recording.id}/file`, { signal: abort.signal });
      if (!res.ok || !res.body) throw new Error("download");
      const total = Number(res.headers.get("Content-Length")) || recording.size_bytes || 0;
      const reader = res.body.getReader();
      const parts: Uint8Array[] = [];
      let got = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value);
        got += value.length;
        if (total > 0 && !dead) setPercent(Math.min(99, Math.round((got / total) * 100)));
      }
      return new Blob(parts as BlobPart[]);
    };

    const draw = () => {
      frame = requestAnimationFrame(draw);
      const cv = overlay.current;
      const ctx = cv?.getContext("2d");
      if (!cv || !ctx || !rec.current) return;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, cv.width, cv.height);
      const tr = trackRef.current;
      if (!tr || !opts.current.pointer || !tr.t.length) return;
      const dpr = cv.width / Math.max(1, cv.clientWidth);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const s = scale.current;
      const pos: number = rec.current.getPosition();
      const last = upperBound(tr.t, pos) - 1;
      if (last < 0) return;

      if (opts.current.trail) {
        const from = Math.max(0, upperBound(tr.t, pos - TRAIL_MS));
        ctx.lineCap = "round";
        for (let i = Math.max(from, 1); i <= last; i++) {
          const age = (pos - tr.t[i]) / TRAIL_MS;
          ctx.strokeStyle = `rgba(250,204,21,${(1 - age) * 0.8})`;
          ctx.lineWidth = 3;
          ctx.beginPath();
          ctx.moveTo(tr.x[i - 1] * s, tr.y[i - 1] * s);
          ctx.lineTo(tr.x[i] * s, tr.y[i] * s);
          ctx.stroke();
        }
      }

      // A ring that grows and fades where each click happened.
      const times = clickTimes.current;
      for (let i = Math.max(0, upperBound(times, pos - RIPPLE_MS)); i < times.length && times[i] <= pos; i++) {
        const c = tr.clicks[i];
        const p = (pos - c.t) / RIPPLE_MS;
        ctx.beginPath();
        ctx.arc(c.x * s, c.y * s, 8 + 34 * p, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${COLORS[c.button]},${0.25 * (1 - p)})`;
        ctx.fill();
        ctx.lineWidth = 3;
        ctx.strokeStyle = `rgba(${COLORS[c.button]},${1 - p})`;
        ctx.stroke();
      }

      // A halo around the pointer so it can be followed on a large screen scaled down.
      ctx.beginPath();
      ctx.arc(tr.x[last] * s, tr.y[last] * s, 16, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(250,204,21,0.18)";
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = "rgba(250,204,21,0.9)";
      ctx.stroke();
    };

    Promise.all([loadGuacamole(), download()])
      .then(([G, blob]) => {
        if (dead || !box.current) return;
        r = new G.SessionRecording(blob, 100);
        rec.current = r;
        const display = r.getDisplay();
        const el: HTMLElement = display.getElement();
        el.style.position = "relative";
        box.current.appendChild(el);
        const fit = () => {
          const w = display.getWidth();
          const h = display.getHeight();
          const avail = box.current?.clientWidth ?? 0;
          if (!w || !h || !avail) return;
          const s = Math.min(1, avail / w);
          scale.current = s;
          display.scale(s);
          const height = Math.round(h * s);
          if (box.current) box.current.style.height = `${height}px`;
          const cv = overlay.current;
          if (cv) {
            const dpr = window.devicePixelRatio || 1;
            if (cv.width !== Math.round(avail * dpr) || cv.height !== Math.round(height * dpr)) {
              cv.style.width = `${avail}px`;
              cv.style.height = `${height}px`;
              cv.width = Math.round(avail * dpr);
              cv.height = Math.round(height * dpr);
            }
          }
        };
        display.onresize = fit;
        // Playing straight from the start can stop at once, so playback always begins with a seek to where it should start.
        r.onload = () => {
          setDuration(r.getDuration());
          setLoading(false);
          r.seek(0, () => r.play());
        };
        r.onerror = () => {
          setError("The recording could not be loaded. The file may be damaged.");
          setLoading(false);
        };
        r.onplay = () => setPlaying(true);
        r.onpause = () => setPlaying(false);
        timer = window.setInterval(() => {
          if (!seeking.current) setPosition(r.getPosition());
          fit();
        }, 250);
        frame = requestAnimationFrame(draw);

        if (blob.size > MAX_TRACK_BYTES) setSkipped(true);
        else
          readMouseTrack(blob)
            .then((t) => {
              if (dead) return;
              trackRef.current = t;
              clickTimes.current = t.clicks.map((c) => c.t);
              setTrack(t);
            })
            .catch(() => undefined); // the player works without the pointer overlay
      })
      .catch((e) => {
        if (dead || e?.name === "AbortError") return;
        setError(
          e?.message === "download"
            ? "The recording could not be loaded. The file may have been removed from the server."
            : "The player could not be loaded.",
        );
        setLoading(false);
      });
    return () => {
      dead = true;
      abort.abort();
      cancelAnimationFrame(frame);
      window.clearInterval(timer);
      try {
        r?.pause();
        r?.disconnect();
        r?.abort();
      } catch {
        /* already closed */
      }
    };
  }, [recording.id, recording.size_bytes]);

  const toggle = () => {
    const r = rec.current;
    if (!r) return;
    if (r.isPlaying()) r.pause();
    else r.seek(duration > 0 && position >= duration - 50 ? 0 : r.getPosition(), () => r.play());
  };
  const seek = (ms: number) => {
    const to = Math.min(Math.max(0, ms), duration);
    seeking.current = true;
    setPosition(to);
    rec.current?.seek(to, () => {
      seeking.current = false;
    });
  };
  /** Jumps to the previous or next click, starting a moment early so the approach is visible. */
  const jumpClick = (dir: -1 | 1) => {
    const times = clickTimes.current;
    if (!times.length) return;
    const now: number = rec.current?.getPosition() ?? position;
    // Next: the first click clearly ahead. Previous: the last click that is not the one we are already heading for.
    const i = dir === 1 ? times.findIndex((t) => t > now + 1600) : upperBound(times, now + 1399) - 1;
    if (i >= 0 && i < times.length) seek(times[i] - 1500);
  };
  const fullscreenToggle = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void root.current?.requestFullscreen?.();
  };

  const bars = useMemo(() => (track && duration ? activity(track, duration, 120) : []), [track, duration]);
  // Click marks on the timeline, thinned out so a busy recording does not draw thousands of lines.
  const marks = useMemo(() => {
    const out: number[] = [];
    if (!track || !duration) return out;
    let lastMark = -Infinity;
    for (const c of track.clicks) {
      if (c.t - lastMark >= duration / 300) {
        out.push(c.t);
        lastMark = c.t;
      }
    }
    return out;
  }, [track, duration]);

  const noPointer = track && track.t.length === 0;

  return (
    <div ref={root} className={clsx("space-y-3", fullscreen && "flex h-full flex-col overflow-auto bg-bg p-4")}>
      <div className="relative overflow-hidden rounded-lg border border-border bg-black">
        <div ref={box} className="relative mx-auto w-full" style={{ minHeight: 120 }} />
        <canvas ref={overlay} className="pointer-events-none absolute left-0 top-0" aria-hidden="true" />
      </div>
      {error ? (
        <p className="text-sm text-danger">{error}</p>
      ) : (
        <>
          <div className="space-y-1">
            <div className="relative h-5" aria-hidden="true">
              <div className="absolute inset-x-0 bottom-0 flex h-full items-end gap-px">
                {bars.map((v, i) => (
                  <span key={i} className="flex-1 rounded-t-sm bg-accent/40" style={{ height: `${Math.max(v > 0 ? 12 : 0, v * 100)}%` }} />
                ))}
              </div>
              {marks.map((t) => (
                <span key={t} className="absolute bottom-0 h-full w-px bg-warning" style={{ left: `${(t / duration) * 100}%` }} />
              ))}
            </div>
            <input
              type="range"
              className="block w-full accent-[rgb(var(--accent,59_130_246))]"
              min={0}
              max={Math.max(duration, 1)}
              step={100}
              value={Math.min(position, Math.max(duration, 1))}
              onChange={(e) => seek(Number(e.target.value))}
              aria-label="Position in the recording"
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button icon={playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />} onClick={toggle} aria-label={playing ? "Pause" : "Play"} />
            <Button size="sm" variant="ghost" onClick={() => seek(position - 10000)} aria-label="Back 10 seconds" title="Back 10 seconds">
              -10 s
            </Button>
            <Button size="sm" variant="ghost" onClick={() => seek(position + 10000)} aria-label="Forward 10 seconds" title="Forward 10 seconds">
              +10 s
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              icon={<SkipBack className="h-3.5 w-3.5" />}
              onClick={() => jumpClick(-1)}
              disabled={!track?.clicks.length}
              aria-label="Previous click"
              title="Previous click"
            />
            <Button
              size="icon-sm"
              variant="ghost"
              icon={<SkipForward className="h-3.5 w-3.5" />}
              onClick={() => jumpClick(1)}
              disabled={!track?.clicks.length}
              aria-label="Next click"
              title="Next click"
            />
            <span className="font-mono text-xs text-muted">
              {clock(position)} / {clock(duration)}
            </span>
            <div className="ml-auto flex items-center gap-1">
              <Button
                size="icon-sm"
                variant={prefs.pointer ? "outline" : "ghost"}
                icon={<MousePointer2 className="h-3.5 w-3.5" />}
                onClick={() => setPrefs((p) => ({ ...p, pointer: !p.pointer }))}
                aria-pressed={prefs.pointer}
                aria-label="Highlight the pointer and clicks"
                title="Highlight the pointer and clicks"
              />
              <Button
                size="icon-sm"
                variant={prefs.trail ? "outline" : "ghost"}
                icon={<Route className="h-3.5 w-3.5" />}
                onClick={() => setPrefs((p) => ({ ...p, trail: !p.trail }))}
                disabled={!prefs.pointer}
                aria-pressed={prefs.trail}
                aria-label="Show the pointer trail"
                title="Show the pointer trail"
              />
              <Button
                size="icon-sm"
                variant="ghost"
                icon={fullscreen ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
                onClick={fullscreenToggle}
                aria-label={fullscreen ? "Leave full screen" : "Full screen"}
                title={fullscreen ? "Leave full screen" : "Full screen"}
              />
            </div>
          </div>
          <p className="text-xs text-subtle">
            {track && track.clicks.length > 0 && `${track.clicks.length} click${track.clicks.length === 1 ? "" : "s"} marked on the timeline. `}
            {noPointer && "This recording has no pointer events (for example a text-only terminal session). "}
            {track?.truncated && "Only the first part of the pointer movement is shown. "}
            {skipped && "The recording is large, so the pointer highlight is off. "}
            Pointer data comes from the recording; the keyboard is never recorded.
          </p>
        </>
      )}
      {loading && !error && <p className="text-xs text-subtle">Loading the recording{percent > 0 ? ` (${percent}%)` : ""}…</p>}
    </div>
  );
}
