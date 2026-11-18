// Local clipboard helpers for remote sessions.
//
// Browsers only let a page read the clipboard without asking in one situation:
// inside a "paste" event, which the user triggers with Ctrl+V / ⌘V /
// Shift+Insert. Writing is allowed while the page has focus (Chromium) or
// right after a user gesture (Firefox, Safari). These helpers use exactly those
// paths and fall back gracefully, so clipboard sync never depends on a
// permission prompt.

/**
 * "gesture": the browser can read the clipboard only during a click and asks each time with its own Paste button
 * (Safari, recent Firefox); "granted" / "prompt" / "denied": Chromium's clipboard permission.
 */
type ReadState = "granted" | "prompt" | "denied" | "gesture" | "unsupported";

/** Whether the page may read the clipboard without a paste event. */
async function clipboardReadState(): Promise<ReadState> {
  if (!navigator.clipboard?.readText) return "unsupported";
  if (!navigator.permissions?.query) return "gesture";
  try {
    const p = await navigator.permissions.query({ name: "clipboard-read" as PermissionName });
    return p.state as ReadState;
  } catch {
    return "gesture"; // Firefox and Safari do not expose this permission but read during a click
  }
}

// Shared view of clipboard read access for every session on the page. "refused" means a read failed although the
// permission did not say "denied": Chrome reports "prompt" while it blocks a site by itself after its question was
// closed without an answer a few times, so only a failed read tells.
interface ReadAccess {
  state: ReadState;
  refused: boolean;
}
let access: ReadAccess = { state: "unsupported", refused: false };
const listeners = new Set<() => void>();
let watching = false;
const setAccess = (next: Partial<ReadAccess>) => {
  const merged = { ...access, ...next };
  if (merged.state === "granted") merged.refused = false;
  if (merged.state === access.state && merged.refused === access.refused) return;
  access = merged;
  listeners.forEach((l) => l());
};
const watch = () => {
  if (watching) return;
  watching = true;
  void clipboardReadState().then((state) => setAccess({ state }));
  navigator.permissions
    ?.query({ name: "clipboard-read" as PermissionName })
    .then((p) => p.addEventListener("change", () => setAccess({ state: p.state as ReadState })))
    .catch(() => {});
};

// Start at once: the first right-click must not find the answer still pending.
if (typeof navigator !== "undefined") watch();

export function getReadAccess(): ReadAccess {
  watch();
  return access;
}
export function subscribeReadAccess(listener: () => void): () => void {
  watch();
  listeners.add(listener);
  return () => listeners.delete(listener);
}
/** Whether a read may succeed (silently, or after the browser asks); false once the browser has refused. */
export const mayRead = (a: ReadAccess = getReadAccess()) => a.state === "granted" || ((a.state === "prompt" || a.state === "gesture") && !a.refused);

/** Reads text without a paste event. Only called where the browser allows it. */
export async function readLocal(): Promise<string | null> {
  try {
    const text = await navigator.clipboard.readText();
    setAccess({ refused: false });
    return text;
  } catch {
    setAccess({ refused: true });
    void clipboardReadState().then((state) => setAccess({ state }));
    return null;
  }
}

/** Copy via a synthetic copy event; works inside any user gesture, no permission needed. */
export function execCopy(text: string): boolean {
  const onCopy = (e: ClipboardEvent) => {
    e.clipboardData?.setData("text/plain", text);
    e.preventDefault();
  };
  document.addEventListener("copy", onCopy, true);
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    document.removeEventListener("copy", onCopy, true);
  }
}

/** Writes text to the local clipboard; false if the browser refused (retry on the next gesture). */
export async function writeLocal(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** X11 keysyms for typing text key by key (for screens without clipboard support). */
export function textToKeysyms(text: string): number[] {
  const out: number[] = [];
  for (const ch of text.replace(/\r\n?/g, "\n")) {
    const cp = ch.codePointAt(0)!;
    if (ch === "\n") out.push(0xff0d);
    else if (ch === "\t") out.push(0xff09);
    else if (cp >= 0x20 && cp <= 0x7e) out.push(cp);
    else if (cp >= 0xa0 && cp <= 0xff) out.push(cp);
    else if (cp > 0xff) out.push(0x01000000 | cp);
  }
  return out;
}

export const isMacClient = () => /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
