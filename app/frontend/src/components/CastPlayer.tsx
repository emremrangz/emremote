import { useEffect, useMemo, useRef, useState } from "react";
import { Pause, Play, Search } from "lucide-react";
import { Terminal } from "@xterm/xterm";
import { SearchAddon } from "@xterm/addon-search";
import "@xterm/xterm/css/xterm.css";
import { Button } from "@/components/ui/Button";
import { Select } from "@/components/ui/Select";
import { findInCast, parseCast, playbackTimes, type Cast, type CastMatch } from "@/lib/cast";
import { xtermFont, xtermTheme } from "@/lib/xterm";
import type { Recording } from "@/lib/types";

const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(h ? 2 : 1, "0");
  return `${h ? `${h}:` : ""}${mm}:${String(s % 60).padStart(2, "0")}`;
};

/** Pauses longer than this are shortened when "Skip pauses" is on. */
const IDLE_LIMIT = 2000;
const SPEEDS = [1, 2, 4, 8];

/** Plays a recording of the built-in terminal: the text is redrawn in a terminal, so it stays sharp and can be searched. */
export function CastPlayer({ recording }: { recording: Recording }) {
  const box = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const [cast, setCast] = useState<Cast | null>(null);
  const [error, setError] = useState("");
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [skipPauses, setSkipPauses] = useState(true);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<CastMatch[] | null>(null);
  // Playback state lives in refs: the animation loop reads and moves it every frame.
  const pos = useRef(0);
  const next = useRef(0); // the next event to draw
  const speedRef = useRef(1);
  speedRef.current = speed;
  const playingRef = useRef(false);

  const times = useMemo(() => (cast ? playbackTimes(cast.events, skipPauses ? IDLE_LIMIT : 0) : []), [cast, skipPauses]);
  const timesRef = useRef(times);
  timesRef.current = times;
  const duration = times.length ? times[times.length - 1] : 0;

  useEffect(() => {
    const abort = new AbortController();
    fetch(`/api/recordings/${recording.id}/file`, { signal: abort.signal })
      .then((r) => {
        if (!r.ok) throw new Error("download");
        return r.text();
      })
      .then((t) => setCast(parseCast(t)))
      .catch((e) => {
        if (e?.name === "AbortError") return;
        setError(e?.message === "download" ? "The recording could not be loaded. The file may have been removed from the server." : errorText(e));
      });
    return () => abort.abort();
  }, [recording.id]);

  /** Text size that fits the recorded width into the player. */
  const fitFont = (cols: number) => {
    const term = termRef.current;
    const w = box.current?.clientWidth ?? 800;
    if (term) term.options.fontSize = Math.max(7, Math.min(15, Math.floor((w - 12) / (cols * 0.6))));
  };

  // The terminal that draws the recording.
  useEffect(() => {
    if (!cast || !box.current) return;
    const term = new Terminal({
      cols: cast.width,
      rows: cast.height,
      disableStdin: true,
      cursorBlink: false,
      scrollback: 5000,
      fontFamily: xtermFont(""),
      theme: xtermTheme("gray-black"),
      allowProposedApi: true,
    });
    const search = new SearchAddon();
    term.loadAddon(search);
    term.open(box.current);
    termRef.current = term;
    searchRef.current = search;
    fitFont(cast.width);
    pos.current = 0;
    next.current = 0;
    playingRef.current = true;
    setPlaying(true);
    return () => {
      term.dispose();
      termRef.current = null;
    };
  }, [cast]);

  /** Draws every event up to `ms` that has not been drawn yet. */
  const drawUntil = (ms: number) => {
    const term = termRef.current;
    if (!term || !cast) return;
    const t = timesRef.current;
    let batch = "";
    while (next.current < cast.events.length && t[next.current] <= ms) {
      const e = cast.events[next.current++];
      if (e.kind === "o") batch += e.data;
      else if (e.kind === "r") {
        if (batch) term.write(batch);
        batch = "";
        const [c, r] = e.data.split("x").map(Number);
        if (c > 0 && r > 0) {
          term.resize(c, r);
          fitFont(c);
        }
      }
    }
    if (batch) term.write(batch);
  };

  const seek = (ms: number) => {
    const term = termRef.current;
    if (!term || !cast) return;
    const to = Math.max(0, Math.min(ms, duration));
    if (to < pos.current) {
      // Going back: start from an empty screen and redraw up to there.
      term.reset();
      term.resize(cast.width, cast.height);
      fitFont(cast.width);
      next.current = 0;
    }
    pos.current = to;
    drawUntil(to);
    setPosition(to);
  };

  // The playback loop.
  useEffect(() => {
    if (!cast) return;
    let frame = 0;
    let last = performance.now();
    let shown = 0;
    const tick = (now: number) => {
      frame = requestAnimationFrame(tick);
      const dt = now - last;
      last = now;
      if (!playingRef.current) return;
      pos.current = Math.min(duration, pos.current + dt * speedRef.current);
      drawUntil(pos.current);
      if (now - shown > 100) {
        shown = now;
        setPosition(pos.current);
      }
      if (pos.current >= duration) {
        playingRef.current = false;
        setPlaying(false);
        setPosition(duration);
      }
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cast, duration]);

  // Shortening pauses changes every time: keep the same moment of the session in view.
  const prevTimes = useRef(times);
  useEffect(() => {
    const old = prevTimes.current;
    prevTimes.current = times;
    if (!cast || old === times || !old.length) return;
    const i = Math.max(0, next.current - 1);
    pos.current = times[i] ?? 0;
    setPosition(pos.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [times]);

  const toggle = () => {
    if (playingRef.current) {
      playingRef.current = false;
      setPlaying(false);
      return;
    }
    if (pos.current >= duration - 50) seek(0);
    playingRef.current = true;
    setPlaying(true);
  };

  const runSearch = () => {
    if (!cast) return;
    setMatches(findInCast(cast.events, query));
  };
  const jumpTo = (m: CastMatch) => {
    playingRef.current = false;
    setPlaying(false);
    seek((times[m.index] ?? 0) + 1);
    searchRef.current?.findPrevious(query.trim(), { decorations: { matchBackground: "#facc1555", matchOverviewRuler: "#facc15", activeMatchBackground: "#facc15", activeMatchColorOverviewRuler: "#f59e0b" } });
  };

  if (error) return <p className="text-sm text-danger">{error}</p>;

  return (
    <div className="space-y-3">
      <div className="overflow-hidden rounded-lg border border-border bg-black p-1.5">
        <div ref={box} className="w-full overflow-x-auto" style={{ minHeight: 120 }} />
      </div>
      {!cast ? (
        <p className="text-xs text-subtle">Loading the recording…</p>
      ) : (
        <>
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
          <div className="flex flex-wrap items-center gap-2">
            <Button icon={playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />} onClick={toggle} aria-label={playing ? "Pause" : "Play"} />
            <Button size="sm" variant="ghost" onClick={() => seek(pos.current - 10000)} aria-label="Back 10 seconds" title="Back 10 seconds">
              -10 s
            </Button>
            <Button size="sm" variant="ghost" onClick={() => seek(pos.current + 10000)} aria-label="Forward 10 seconds" title="Forward 10 seconds">
              +10 s
            </Button>
            <span className="font-mono text-xs text-muted">
              {clock(position)} / {clock(duration)}
            </span>
            <div className="ml-auto flex items-center gap-2">
              <label className="flex items-center gap-1.5 text-xs text-muted" title={`Pauses longer than ${IDLE_LIMIT / 1000} seconds are shortened`}>
                <input type="checkbox" checked={skipPauses} onChange={(e) => setSkipPauses(e.target.checked)} />
                Skip pauses
              </label>
              <Select className="input h-7 w-20 py-0 text-xs" value={String(speed)} onChange={(e) => setSpeed(Number(e.target.value))} aria-label="Playback speed">
                {SPEEDS.map((s) => (
                  <option key={s} value={s}>
                    {s}x
                  </option>
                ))}
              </Select>
            </div>
          </div>
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              runSearch();
            }}
          >
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-subtle" />
              <input
                className="input h-8 pl-8 text-sm"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setMatches(null);
                }}
                placeholder="Find text in the session, e.g. sudo or rm -rf"
                aria-label="Find text in the session"
              />
            </div>
            <Button size="sm" type="submit" disabled={!query.trim()}>
              Find
            </Button>
          </form>
          {matches && (
            <div className="max-h-40 overflow-y-auto rounded-md border border-border">
              {matches.length === 0 ? (
                <p className="px-3 py-2 text-xs text-subtle">Not found in what the session printed.</p>
              ) : (
                <ul className="divide-y divide-border">
                  {matches.map((m) => (
                    <li key={m.index}>
                      <button className="flex w-full items-baseline gap-3 px-3 py-1.5 text-left text-xs hover:bg-surface-2" onClick={() => jumpTo(m)}>
                        <span className="w-14 shrink-0 font-mono text-muted">{clock(times[m.index] ?? 0)}</span>
                        <span className="truncate font-mono">{m.context || query}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          <p className="text-xs text-subtle">
            A terminal recording: what the server printed, redrawn as text. The keyboard is never recorded, so a password typed at a prompt that does not
            echo is not in it.
          </p>
        </>
      )}
    </div>
  );
}

function errorText(e: unknown) {
  return e instanceof Error ? e.message : "The recording could not be played.";
}
