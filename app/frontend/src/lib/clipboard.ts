// Local clipboard helpers for remote sessions.
//
// Browsers only let a page read the clipboard without asking in one situation:
// inside a "paste" event, which the user triggers with Ctrl+V / ⌘V /
// Shift+Insert. Writing is allowed while the page has focus (Chromium) or
// right after a user gesture (Firefox, Safari). These helpers use exactly those
// paths and fall back gracefully, so clipboard sync never depends on a
// permission prompt.

export type ReadState = "granted" | "prompt" | "denied" | "unsupported";

/** Whether the page may read the clipboard without a paste event (Chromium only). */
export async function clipboardReadState(): Promise<ReadState> {
  if (!navigator.clipboard?.readText || !navigator.permissions?.query) return "unsupported";
  try {
    const p = await navigator.permissions.query({ name: "clipboard-read" as PermissionName });
    return p.state as ReadState;
  } catch {
    return "unsupported"; // Firefox and Safari do not expose this permission
  }
}

/** Reads text without a paste event. Only called where the browser allows it. */
export async function readLocal(): Promise<string | null> {
  try {
    return await navigator.clipboard.readText();
  } catch {
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
