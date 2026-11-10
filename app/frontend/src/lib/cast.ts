// Terminal recordings of the built-in SSH terminal (asciicast v2): a JSON header line, then one JSON array per event,
// [seconds, "o", text] for screen output and [seconds, "r", "COLSxROWS"] for a size change. The keyboard is never in them.

export interface CastEvent {
  /** Milliseconds from the start. */
  t: number;
  kind: string;
  data: string;
}

export interface Cast {
  width: number;
  height: number;
  events: CastEvent[];
}

export function parseCast(text: string): Cast {
  const lines = text.split("\n");
  let header: { width?: number; height?: number };
  try {
    header = JSON.parse(lines[0]);
  } catch {
    throw new Error("This is not a terminal recording.");
  }
  const events: CastEvent[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    try {
      const [t, kind, data] = JSON.parse(line);
      if (typeof t === "number" && typeof kind === "string" && typeof data === "string") events.push({ t: Math.round(t * 1000), kind, data });
    } catch {
      // The last line of a recording cut off by a restart may be incomplete.
    }
  }
  return { width: header.width || 80, height: header.height || 24, events };
}

/**
 * Playback times with long pauses shortened to `limit` milliseconds (like asciinema's idle time limit), so a session
 * where someone stepped away for ten minutes does not play ten minutes of nothing. 0 keeps the real times.
 */
export function playbackTimes(events: CastEvent[], limit: number): number[] {
  const out: number[] = [];
  let shift = 0;
  let prev = 0;
  for (const e of events) {
    const gap = e.t - prev;
    if (limit > 0 && gap > limit) shift += gap - limit;
    out.push(e.t - shift);
    prev = e.t;
  }
  return out;
}

// eslint-disable-next-line no-control-regex
const ESCAPES = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[PX^_][^\x1b]*\x1b\\|\x1b[()][0-9A-Za-z]|\x1b[@-Z\\-_=>]|\x1b./g;

/** Text without terminal control sequences (colors, cursor movement, titles). */
export function stripEscapes(s: string): string {
  return s.replace(ESCAPES, "");
}

/**
 * What the session printed, as plain text lines: carriage returns overwrite the line, backspace moves back, tabs become
 * spaces. Full-screen programs (editors, top) do not turn into tidy text, but commands and their output do.
 */
export function transcript(events: CastEvent[]): string {
  const out: string[] = [];
  let line: string[] = [];
  let col = 0;
  for (const e of events) {
    if (e.kind !== "o") continue;
    for (const ch of stripEscapes(e.data)) {
      if (ch === "\n") {
        out.push(line.join("").trimEnd());
        line = [];
        col = 0;
      } else if (ch === "\r") col = 0;
      else if (ch === "\b") col = Math.max(0, col - 1);
      else if (ch === "\t") {
        const to = (Math.floor(col / 8) + 1) * 8;
        while (col < to) line[col++] = " ";
      } else if (ch >= " " || ch > "\x7f") {
        line[col++] = ch;
      }
    }
  }
  if (line.length) out.push(line.join("").trimEnd());
  return out.join("\n");
}

export interface CastMatch {
  /** Index of the event in which the text appears. */
  index: number;
  t: number;
  /** The line it was found on, shortened. */
  context: string;
}

/** Moments where the session printed `query` (case does not matter), at most `max` of them. */
export function findInCast(events: CastEvent[], query: string, max = 100): CastMatch[] {
  const q = query.trim().toLowerCase();
  const out: CastMatch[] = [];
  if (!q) return out;
  // Output arrives in pieces, so the end of the previous event is searched along with each one; a match counts for the
  // event in which it ends.
  let tail = "";
  for (let i = 0; i < events.length && out.length < max; i++) {
    const e = events[i];
    if (e.kind !== "o") continue;
    const text = tail + stripEscapes(e.data);
    const at = text.toLowerCase().indexOf(q);
    if (at !== -1 && at + q.length > tail.length) {
      const start = text.lastIndexOf("\n", at) + 1;
      // The rest of the line may arrive in the next events (a command is echoed as it is typed).
      let rest = text.slice(start);
      for (let j = i + 1; j < events.length && !rest.includes("\n") && rest.length < 300; j++) {
        if (events[j].kind === "o") rest += stripEscapes(events[j].data);
      }
      const end = rest.indexOf("\n");
      out.push({ index: i, t: e.t, context: rest.slice(0, end === -1 ? undefined : end).replace(/\r/g, "").trim().slice(0, 160) });
    }
    // Enough to find text split between pieces and to show the line around a match.
    tail = text.slice(-Math.max(q.length - 1, 200));
  }
  return out;
}
