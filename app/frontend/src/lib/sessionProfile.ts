import type { OS, Protocol } from "./types";

// X11 keysyms used by the session toolbar.
export const K = {
  Ctrl: 0xffe3,
  Alt: 0xffe9,
  Shift: 0xffe1,
  Super: 0xffeb, // Windows key / Linux Super
  Meta: 0xffe7, // macOS Command (what the browser sends for ⌘)
  Delete: 0xffff,
  Escape: 0xff1b,
  Tab: 0xff09,
  Return: 0xff0d,
  Space: 0x0020,
  Home: 0xff50,
  End: 0xff57,
  PageUp: 0xff55,
  PageDown: 0xff56,
  Left: 0xff51,
  Up: 0xff52,
  Right: 0xff53,
  Down: 0xff54,
  Print: 0xff61,
  F2: 0xffbf,
  F4: 0xffc1,
} as const;

const key = (c: string) => c.charCodeAt(0);

/**
 * What the remote side is, for keyboard behaviour and the toolbar:
 * - windows: RDP (or VNC) to Windows
 * - mac: VNC/Screen Sharing (or RDP) to macOS
 * - linux: a graphical Linux/other desktop (xrdp, VNC)
 * - terminal: SSH or Telnet
 */
export type SessionProfile = "windows" | "mac" | "linux" | "terminal";

export function sessionProfile(protocol?: Protocol, os?: OS): SessionProfile {
  if (protocol === "ssh" || protocol === "telnet") return "terminal";
  if (os === "macos") return "mac";
  if (os === "windows") return "windows";
  if (os === "linux") return "linux";
  return protocol === "rdp" ? "windows" : "linux";
}

interface Shortcut {
  label: string;
  keys: number[];
  hint?: string;
}

interface ModifierKey {
  label: string;
  keysym: number;
  title: string;
}

interface ProfileKeys {
  /** One-click buttons shown on the toolbar. */
  quick: Shortcut[];
  /** Keys that can be held for the next key press. */
  modifiers: ModifierKey[];
  /** The full list in the shortcuts menu. */
  shortcuts: Shortcut[];
  /** Whether to show navigation keys (Esc, Tab, Home, End, PgUp, PgDn, arrows). */
  navigation: boolean;
}

const hold = (label: string, keysym: number, name = label): ModifierKey => ({ label, keysym, title: `Hold ${name} for the next key` });

export const PROFILE_KEYS: Record<SessionProfile, ProfileKeys> = {
  windows: {
    quick: [
      { label: "Ctrl+Alt+Del", keys: [K.Ctrl, K.Alt, K.Delete], hint: "Security screen" },
      { label: "Win", keys: [K.Super], hint: "Start menu" },
    ],
    modifiers: [hold("Ctrl", K.Ctrl), hold("Alt", K.Alt), hold("Shift", K.Shift), hold("Win", K.Super, "the Windows key")],
    shortcuts: [
      { label: "Ctrl+Alt+Del", keys: [K.Ctrl, K.Alt, K.Delete], hint: "Security screen" },
      { label: "Task Manager", keys: [K.Ctrl, K.Shift, K.Escape], hint: "Ctrl+Shift+Esc" },
      { label: "Lock", keys: [K.Super, key("l")], hint: "Win+L" },
      { label: "Switch windows", keys: [K.Alt, K.Tab], hint: "Alt+Tab" },
      { label: "Close window", keys: [K.Alt, K.F4], hint: "Alt+F4" },
      { label: "Run", keys: [K.Super, key("r")], hint: "Win+R" },
      { label: "File Explorer", keys: [K.Super, key("e")], hint: "Win+E" },
      { label: "Show desktop", keys: [K.Super, key("d")], hint: "Win+D" },
      { label: "Settings", keys: [K.Super, key("i")], hint: "Win+I" },
      { label: "Snipping tool", keys: [K.Super, K.Shift, key("S")], hint: "Win+Shift+S" },
      { label: "Print Screen", keys: [K.Print], hint: "PrtScn" },
    ],
    navigation: true,
  },
  mac: {
    quick: [
      { label: "⌘Space", keys: [K.Meta, K.Space], hint: "Spotlight" },
      { label: "⌘Tab", keys: [K.Meta, K.Tab], hint: "Switch apps" },
    ],
    modifiers: [hold("⌘", K.Meta, "Command"), hold("⌥", K.Alt, "Option"), hold("⌃", K.Ctrl, "Control"), hold("⇧", K.Shift, "Shift")],
    shortcuts: [
      { label: "Spotlight", keys: [K.Meta, K.Space], hint: "⌘Space" },
      { label: "Switch apps", keys: [K.Meta, K.Tab], hint: "⌘Tab" },
      { label: "Force Quit", keys: [K.Meta, K.Alt, K.Escape], hint: "⌘⌥Esc" },
      { label: "Quit app", keys: [K.Meta, key("q")], hint: "⌘Q" },
      { label: "Close window", keys: [K.Meta, key("w")], hint: "⌘W" },
      { label: "Mission Control", keys: [K.Ctrl, K.Up], hint: "⌃↑" },
      { label: "Lock screen", keys: [K.Ctrl, K.Meta, key("q")], hint: "⌃⌘Q" },
      { label: "Screenshot (area)", keys: [K.Meta, K.Shift, key("$")], hint: "⌘⇧4" },
    ],
    navigation: true,
  },
  linux: {
    quick: [
      { label: "Super", keys: [K.Super], hint: "Activities / menu" },
      { label: "Alt+Tab", keys: [K.Alt, K.Tab], hint: "Switch windows" },
    ],
    modifiers: [hold("Ctrl", K.Ctrl), hold("Alt", K.Alt), hold("Shift", K.Shift), hold("Super", K.Super)],
    shortcuts: [
      { label: "Activities / menu", keys: [K.Super], hint: "Super" },
      { label: "Switch windows", keys: [K.Alt, K.Tab], hint: "Alt+Tab" },
      { label: "Close window", keys: [K.Alt, K.F4], hint: "Alt+F4" },
      { label: "Run command", keys: [K.Alt, K.F2], hint: "Alt+F2" },
      { label: "Open terminal", keys: [K.Ctrl, K.Alt, key("t")], hint: "Ctrl+Alt+T" },
      { label: "Log out / power", keys: [K.Ctrl, K.Alt, K.Delete], hint: "Ctrl+Alt+Del" },
    ],
    navigation: true,
  },
  terminal: {
    quick: [{ label: "Ctrl+C", keys: [K.Ctrl, key("c")], hint: "Interrupt the running command" }],
    modifiers: [hold("Ctrl", K.Ctrl), hold("Alt", K.Alt), hold("Shift", K.Shift)],
    shortcuts: [
      { label: "Interrupt", keys: [K.Ctrl, key("c")], hint: "Ctrl+C" },
      { label: "End of input / log out", keys: [K.Ctrl, key("d")], hint: "Ctrl+D" },
      { label: "Suspend", keys: [K.Ctrl, key("z")], hint: "Ctrl+Z" },
      { label: "Clear screen", keys: [K.Ctrl, key("l")], hint: "Ctrl+L" },
      { label: "Search history", keys: [K.Ctrl, key("r")], hint: "Ctrl+R" },
      { label: "Start of line", keys: [K.Ctrl, key("a")], hint: "Ctrl+A" },
      { label: "End of line", keys: [K.Ctrl, key("e")], hint: "Ctrl+E" },
    ],
    navigation: true,
  },
};
