// Settings for the built-in terminal (xterm.js): colors, fonts and the bytes a terminal expects for keys.
import type { ITheme } from "@xterm/xterm";
import { TERMINAL_THEMES } from "./constants";
import { K } from "./sessionProfile";

const ANSI_NAMES = [
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite",
] as const;

/** The xterm.js theme for one of the color schemes offered in the connection settings. */
export function xtermTheme(scheme: string): ITheme {
  const t = TERMINAL_THEMES.find((x) => x.value === scheme) ?? TERMINAL_THEMES[0];
  const theme: ITheme = {
    foreground: t.fg,
    background: t.bg,
    cursor: t.fg,
    cursorAccent: t.bg,
    selectionBackground: `${t.fg}55`,
  };
  ANSI_NAMES.forEach((name, i) => (theme[name] = t.ansi[i]));
  return theme;
}

/**
 * CSS font list for a font chosen in the settings. Those names are the gateway's server fonts; in the browser the
 * bundled JetBrains Mono is the fallback, so every choice looks right even where the named font is not installed.
 */
export function xtermFont(name: string | undefined): string {
  const fallback = '"JetBrains Mono Variable", "DejaVu Sans Mono", Menlo, Consolas, monospace';
  return name && name !== "monospace" ? `"${name}", ${fallback}` : fallback;
}

const MODIFIERS = new Set<number>([K.Ctrl, K.Alt, K.Shift, K.Super, K.Meta, 0xffe4, 0xffea, 0xffe2, 0xffec]);

const SPECIAL: Record<number, string> = {
  [K.Escape]: "\x1b",
  [K.Return]: "\r",
  [K.Delete]: "\x1b[3~",
  [K.Home]: "\x1b[H",
  [K.End]: "\x1b[F",
  [K.PageUp]: "\x1b[5~",
  [K.PageDown]: "\x1b[6~",
  [K.Left]: "\x1b[D",
  [K.Up]: "\x1b[A",
  [K.Right]: "\x1b[C",
  [K.Down]: "\x1b[B",
  [K.F2]: "\x1bOQ",
  [K.F4]: "\x1bOS",
};

/**
 * What a terminal sends for a key combination from the toolbar (X11 keysyms, modifiers first), for example
 * Ctrl+C gives "\x03". null when the combination means nothing to a terminal (the Windows key, Print Screen).
 */
export function keysToSequence(keys: number[]): string | null {
  const ctrl = keys.includes(K.Ctrl) || keys.includes(0xffe4);
  const alt = keys.includes(K.Alt) || keys.includes(0xffea);
  const shift = keys.includes(K.Shift) || keys.includes(0xffe2);
  const main = keys.filter((k) => !MODIFIERS.has(k)).pop();
  if (main === undefined) return null;
  let out: string | null = null;
  if (main === K.Tab) out = shift ? "\x1b[Z" : "\t";
  else if (SPECIAL[main] !== undefined) out = SPECIAL[main];
  else if (main >= 0x20 && main <= 0x7e) {
    let ch = String.fromCharCode(main);
    if (shift) ch = ch.toUpperCase();
    if (ctrl) {
      const up = ch.toUpperCase().charCodeAt(0);
      if (ch === " " || ch === "@") out = "\x00";
      else if (up >= 0x41 && up <= 0x5f) out = String.fromCharCode(up & 0x1f);
      else if (ch === "?") out = "\x7f";
      else out = ch;
    } else out = ch;
  }
  if (out === null) return null;
  return alt ? "\x1b" + out : out;
}
