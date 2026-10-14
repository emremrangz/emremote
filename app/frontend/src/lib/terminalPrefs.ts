import { TERMINAL_FONTS, TERMINAL_THEMES } from "./constants";

/** Personal terminal appearance, kept in this browser. Missing fields mean "use the connection's setting". */
export interface TerminalPrefs {
  color_scheme?: string;
  font_name?: string;
  font_size?: number;
}

const KEY = "emremote-terminal-prefs";

export function loadTerminalPrefs(): TerminalPrefs {
  try {
    const p = JSON.parse(localStorage.getItem(KEY) || "{}");
    const out: TerminalPrefs = {};
    if (TERMINAL_THEMES.some((t) => t.value === p.color_scheme)) out.color_scheme = p.color_scheme;
    if (TERMINAL_FONTS.includes(p.font_name)) out.font_name = p.font_name;
    if (typeof p.font_size === "number" && p.font_size >= 6 && p.font_size <= 48) out.font_size = Math.round(p.font_size);
    return out;
  } catch {
    return {};
  }
}

export function saveTerminalPrefs(p: TerminalPrefs) {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* ignore */
  }
}

/** What to send with a session request (nothing when no personal choice was made). */
export function terminalRequest(p: TerminalPrefs): TerminalPrefs | undefined {
  return p.color_scheme || p.font_name || p.font_size ? p : undefined;
}
