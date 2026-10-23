import { useEffect, useRef, useState } from "react";
import { Pause, Play } from "lucide-react";
import { Dialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { loadGuacamole } from "@/lib/guac";
import { dateTime } from "@/lib/format";
import type { Recording } from "@/lib/types";

/* eslint-disable @typescript-eslint/no-explicit-any */

const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

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
      {recording && <Player key={recording.id} recording={recording} />}
    </Dialog>
  );
}

function Player({ recording }: { recording: Recording }) {
  const box = useRef<HTMLDivElement>(null);
  const rec = useRef<any>(null);
  const [duration, setDuration] = useState(0);
  const [position, setPosition] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const seeking = useRef(false);

  useEffect(() => {
    let dead = false;
    let timer = 0;
    let r: any;
    loadGuacamole()
      .then((G) => {
        if (dead || !box.current) return;
        const tunnel = new G.StaticHTTPTunnel(`/api/recordings/${recording.id}/file`);
        r = new G.SessionRecording(tunnel, 100);
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
          const scale = Math.min(1, avail / w);
          display.scale(scale);
          if (box.current) box.current.style.height = `${Math.round(h * scale)}px`;
        };
        display.onresize = fit;
        // Playing straight from the start can stop at once, so playback always begins with a seek to where it should start.
        r.onprogress = (d: number) => {
          setDuration(d);
          setLoading(false);
        };
        r.onload = () => {
          setLoading(false);
          r.seek(0, () => r.play());
        };
        r.onerror = () => {
          setError("The recording could not be loaded. The file may have been removed from the server.");
          setLoading(false);
        };
        r.onplay = () => setPlaying(true);
        r.onpause = () => setPlaying(false);
        r.connect();
        timer = window.setInterval(() => {
          if (!seeking.current) setPosition(r.getPosition());
          fit();
        }, 250);
      })
      .catch(() => setError("The player could not be loaded."));
    return () => {
      dead = true;
      window.clearInterval(timer);
      try {
        r?.pause();
        r?.disconnect();
        r?.abort();
      } catch {
        /* already closed */
      }
    };
  }, [recording.id]);

  const toggle = () => {
    const r = rec.current;
    if (!r) return;
    if (r.isPlaying()) r.pause();
    else r.seek(duration > 0 && position >= duration - 50 ? 0 : r.getPosition(), () => r.play());
  };
  const seek = (ms: number) => {
    seeking.current = true;
    setPosition(ms);
    rec.current?.seek(ms, () => {
      seeking.current = false;
    });
  };

  return (
    <div className="space-y-3">
      <div className="overflow-hidden rounded-lg border border-border bg-black">
        <div ref={box} className="relative mx-auto w-full" style={{ minHeight: 120 }} />
      </div>
      {error ? (
        <p className="text-sm text-danger">{error}</p>
      ) : (
        <div className="flex items-center gap-3">
          <Button icon={playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />} onClick={toggle} aria-label={playing ? "Pause" : "Play"} />
          <input
            type="range"
            className="min-w-0 flex-1 accent-[rgb(var(--accent,59_130_246))]"
            min={0}
            max={Math.max(duration, 1)}
            step={100}
            value={Math.min(position, Math.max(duration, 1))}
            onChange={(e) => seek(Number(e.target.value))}
            aria-label="Position in the recording"
          />
          <span className="w-24 shrink-0 text-right font-mono text-xs text-muted">
            {clock(position)} / {clock(duration)}
          </span>
        </div>
      )}
      {loading && !error && <p className="text-xs text-subtle">Loading the recording…</p>}
    </div>
  );
}
