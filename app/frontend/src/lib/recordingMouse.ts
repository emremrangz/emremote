// Reads the pointer out of a session recording (.guac) so the player can show where it was and what it clicked.
// The gateway writes every pointer event as `mouse,x,y,buttons,timestamp`. The timestamp runs on the clock of the
// `sync` instructions, so the first sync is time zero. Only digits are read; nothing from the recording is rendered.

export interface MouseClick {
  /** Milliseconds from the start of the recording. */
  t: number;
  x: number;
  y: number;
  button: "left" | "middle" | "right";
}

export interface MouseTrack {
  /** Pointer samples: milliseconds from the start and screen pixels, in time order. */
  t: number[];
  x: number[];
  y: number[];
  clicks: MouseClick[];
  /** True when the recording had more pointer events than are kept. */
  truncated: boolean;
}

/** Recordings larger than this are played without the pointer overlay (the cursor itself is still shown). */
export const MAX_TRACK_BYTES = 200 << 20;
const MAX_SAMPLES = 3_000_000;
const BUTTONS: [number, MouseClick["button"]][] = [
  [1, "left"],
  [2, "middle"],
  [4, "right"],
];

const MOUSE = "5.mouse,";
const SYNC = "4.sync,";

/** The value of one `length.value` element. */
const value = (element: string) => Number(element.slice(element.indexOf(".") + 1));

export async function readMouseTrack(blob: Blob): Promise<MouseTrack> {
  const track: MouseTrack = { t: [], x: [], y: [], clicks: [], truncated: false };
  const stamps: number[] = []; // absolute timestamps, made relative at the end
  let t0: number | null = null;
  let buttons = 0;
  const clickAt: { at: number; x: number; y: number; button: MouseClick["button"] }[] = [];

  const scan = (text: string) => {
    let i = 0;
    while ((i = text.indexOf(MOUSE, i)) !== -1) {
      // An instruction starts at the beginning of the text or right after a ";".
      if (i > 0 && text[i - 1] !== ";") {
        i += MOUSE.length;
        continue;
      }
      const end = text.indexOf(";", i);
      if (end === -1) break;
      const p = text.slice(i + MOUSE.length, end).split(",");
      i = end;
      if (p.length < 4) continue;
      const x = value(p[0]);
      const y = value(p[1]);
      const mask = value(p[2]);
      const at = value(p[3]);
      if (![x, y, mask, at].every(Number.isFinite)) continue;
      if (stamps.length < MAX_SAMPLES) {
        stamps.push(Math.max(at, stamps.length ? stamps[stamps.length - 1] : at));
        track.x.push(x);
        track.y.push(y);
      } else track.truncated = true;
      for (const [bit, button] of BUTTONS) if (mask & bit && !(buttons & bit)) clickAt.push({ at, x, y, button });
      buttons = mask;
    }
    if (t0 === null) {
      const s = text.indexOf(SYNC);
      if (s !== -1) {
        const end = text.indexOf(";", s);
        // The timestamp is the first parameter; newer gateways add more after it.
        if (end !== -1) {
          const first = value(text.slice(s + SYNC.length, end).split(",")[0]);
          if (Number.isFinite(first)) t0 = first;
        }
      }
    }
  };

  // Read in pieces; a piece is cut after its last ";" so no instruction is split.
  const reader = blob.stream().getReader();
  const decoder = new TextDecoder();
  let carry = "";
  for (;;) {
    const { done, value: chunk } = await reader.read();
    const text = carry + (done ? decoder.decode() : decoder.decode(chunk, { stream: true }));
    const cut = done ? text.length : text.lastIndexOf(";") + 1;
    scan(text.slice(0, cut));
    carry = text.slice(cut);
    if (done) break;
  }

  const zero = t0 ?? stamps[0] ?? 0;
  track.t = stamps.map((s) => Math.max(0, s - zero));
  track.clicks = clickAt.map((c) => ({ t: Math.max(0, c.at - zero), x: c.x, y: c.y, button: c.button }));
  return track;
}

/** Index of the first value in the sorted list that is greater than `ms` (so `result - 1` is the last one at or before it). */
export function upperBound(list: number[], ms: number): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid] <= ms) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Pointer activity per slice of the recording, from 0 (none) to 1 (the busiest slice). */
export function activity(track: MouseTrack, duration: number, slices: number): number[] {
  const out = new Array<number>(slices).fill(0);
  if (duration <= 0) return out;
  for (const t of track.t) out[Math.min(slices - 1, Math.floor((t / duration) * slices))]++;
  const max = Math.max(...out, 1);
  return out.map((n) => n / max);
}
