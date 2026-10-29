import type { DeviceType, OS, Protocol, RDPSettings, SSHSettings, TelnetSettings, VNCSettings } from "./types";

export const OS_LABELS: Record<OS, string> = {
  windows: "Windows",
  macos: "macOS",
  linux: "Linux",
  network: "Network",
  esxi: "VMware ESXi",
  other: "Other",
};

export const DEVICE_TYPE_LABELS: Record<DeviceType, string> = {
  desktop: "Desktop",
  laptop: "Laptop",
  server: "Server",
  virtual_machine: "Virtual machine",
  network: "Network device",
  other: "Other",
};

export const PROTOCOL_LABELS: Record<Protocol, string> = { rdp: "RDP", vnc: "VNC", ssh: "SSH", telnet: "Telnet" };
export const DEFAULT_PORTS: Record<Protocol, number> = { rdp: 3389, vnc: 5900, ssh: 22, telnet: 23 };
/** Protocols whose traffic (including the password) is not encrypted. */
export const UNENCRYPTED: Partial<Record<Protocol, boolean>> = { telnet: true };

export const PROTOCOL_HINT: Record<Protocol, string> = {
  rdp: "Remote Desktop for Windows Pro/Enterprise/Server, or xrdp on Linux.",
  vnc: "VNC for macOS Screen Sharing, or a VNC server on Linux/Windows.",
  ssh: "Secure Shell terminal for Linux, macOS (Remote Login), Windows OpenSSH.",
  telnet: "Unencrypted terminal for switches, routers and old devices without SSH.",
};

/** Protocols that make sense for each OS, in suggested order. */
export const SUGGESTED_PROTOCOLS: Record<OS, Protocol[]> = {
  windows: ["rdp", "ssh", "vnc"],
  macos: ["vnc", "ssh"],
  linux: ["ssh", "vnc", "rdp", "telnet"],
  network: ["ssh", "telnet"],
  esxi: ["ssh"],
  other: ["ssh", "telnet", "vnc", "rdp"],
};

export const KEYBOARD_LAYOUTS: { value: string; label: string }[] = [
  ["auto", "Automatic (detect from this computer)"],
  ["en-us-qwerty", "English (US)"],
  ["en-gb-qwerty", "English (UK)"],
  ["tr-tr-qwerty", "Turkish (Q)"],
  ["de-de-qwertz", "German"],
  ["de-ch-qwertz", "German (Swiss)"],
  ["fr-fr-azerty", "French"],
  ["fr-be-azerty", "French (Belgian)"],
  ["fr-ca-qwerty", "French (Canadian)"],
  ["fr-ch-qwertz", "French (Swiss)"],
  ["es-es-qwerty", "Spanish"],
  ["es-latam-qwerty", "Spanish (Latin America)"],
  ["it-it-qwerty", "Italian"],
  ["pt-br-qwerty", "Portuguese (Brazil)"],
  ["pt-pt-qwerty", "Portuguese"],
  ["sv-se-qwerty", "Swedish"],
  ["da-dk-qwerty", "Danish"],
  ["no-no-qwerty", "Norwegian"],
  ["pl-pl-qwerty", "Polish"],
  ["cs-cz-qwertz", "Czech"],
  ["hu-hu-qwertz", "Hungarian"],
  ["ro-ro-qwerty", "Romanian"],
  ["ja-jp-qwerty", "Japanese"],
  ["failsafe", "Unicode fallback (Windows; last resort)"],
].map(([value, label]) => ({ value, label }));

const DEFAULT_RDP: RDPSettings = {
  jump_connection_id: "",
  security: "any",
  ignore_cert: false,
  cert_fingerprints: "",
  color_depth: 32,
  resize_method: "display-update",
  force_lossless: false,
  disable_gfx: false,
  enable_font_smoothing: true,
  enable_wallpaper: false,
  enable_theming: false,
  enable_full_window_drag: false,
  enable_desktop_composition: false,
  enable_menu_animations: false,
  disable_audio: false,
  console: false,
  server_layout: "auto",
  disable_copy: false,
  disable_paste: false,
  read_only: false,
  enable_drive: true,
  enable_printing: false,
  enable_audio_input: false,
  remote_app: "",
  remote_app_dir: "",
  remote_app_args: "",
  preconnection_blob: "",
  preconnection_id: 0,
};

const DEFAULT_VNC: VNCSettings = {
  jump_connection_id: "",
  color_depth: 24,
  quality_level: -1,
  compress_level: -1,
  force_lossless: false,
  cursor: "local",
  swap_red_blue: false,
  clipboard_encoding: "UTF-8",
  disable_copy: false,
  disable_paste: false,
  read_only: false,
};

export const DEFAULT_SSH: SSHSettings = {
  jump_connection_id: "",
  host_key: "",
  allow_legacy_algorithms: false,
  font_name: "monospace",
  font_size: 12,
  color_scheme: "gray-black",
  scrollback: 1000,
  terminal_type: "xterm-256color",
  server_alive_interval: 0,
  backspace: 127,
  locale: "",
  disable_copy: false,
  disable_paste: false,
  read_only: false,
};

const DEFAULT_TELNET: TelnetSettings = {
  jump_connection_id: "",
  font_name: "monospace",
  font_size: 12,
  color_scheme: "gray-black",
  scrollback: 1000,
  terminal_type: "xterm-256color",
  backspace: 127,
  username_regex: "",
  password_regex: "",
  login_success_regex: "",
  login_failure_regex: "",
  disable_copy: false,
  disable_paste: false,
  read_only: false,
};

export const DEFAULT_SETTINGS = { rdp: DEFAULT_RDP, vnc: DEFAULT_VNC, ssh: DEFAULT_SSH, telnet: DEFAULT_TELNET };

/** Image-quality presets. Each maps to protocol settings that actually exist in guacd. */
export type QualityPreset = "best" | "balanced" | "bandwidth";

export const RDP_PRESETS: Record<QualityPreset, Partial<RDPSettings>> = {
  best: {
    color_depth: 32,
    force_lossless: true,
    enable_font_smoothing: true,
    disable_gfx: false,
    enable_wallpaper: true,
    enable_theming: true,
    enable_desktop_composition: true,
    enable_full_window_drag: true,
    enable_menu_animations: false,
  },
  // Matches the defaults, so a new connection shows "Balanced".
  balanced: {
    color_depth: 32,
    force_lossless: false,
    enable_font_smoothing: true,
    disable_gfx: false,
    enable_wallpaper: false,
    enable_theming: false,
    enable_desktop_composition: false,
    enable_full_window_drag: false,
    enable_menu_animations: false,
  },
  bandwidth: {
    color_depth: 16,
    force_lossless: false,
    enable_font_smoothing: false,
    disable_gfx: false,
    enable_wallpaper: false,
    enable_theming: false,
    enable_desktop_composition: false,
    enable_full_window_drag: false,
    enable_menu_animations: false,
  },
};

export const VNC_PRESETS: Record<QualityPreset, Partial<VNCSettings>> = {
  best: { color_depth: 24, force_lossless: true, quality_level: 9, compress_level: -1 },
  balanced: { color_depth: 24, force_lossless: false, quality_level: -1, compress_level: -1 },
  bandwidth: { color_depth: 16, force_lossless: false, quality_level: 4, compress_level: 9 },
};

export const AUDIT_ACTION_LABELS: Record<string, string> = {
  "auth.login": "Sign-in",
  "auth.logout": "Sign-out",
  "auth.setup": "Initial setup",
  "auth.password_change": "Password change",
  "auth.password_reset": "Password reset (CLI)",
  "auth.sessions_revoked": "Sessions revoked",
  "device.create": "Device created",
  "device.update": "Device updated",
  "device.delete": "Device deleted",
  "group.create": "Group created",
  "group.update": "Group updated",
  "group.delete": "Group deleted",
  "connection.create": "Connection created",
  "connection.update": "Connection updated",
  "connection.delete": "Connection deleted",
  "credential.create": "Credential created",
  "credential.update": "Credential updated",
  "credential.delete": "Credential deleted",
  "session.start": "Remote session started",
  "session.end": "Remote session ended",
  "session.terminate": "Remote session terminated",
  "ssh.access": "File/system access opened",
  "session.share": "Session shared (view only)",
  "session.unshare": "Session sharing stopped",
  "session.watch": "Shared session watched",
  "session.watch.end": "Stopped watching a shared session",
  "device.wake": "Wake-on-LAN packet sent",
  "settings.jump": "Jump host networks changed",
  "settings.targets": "Allowed target networks changed",
  "settings.sessions": "Sign-in limits changed",
  "settings.recording": "Session recording settings changed",
  "recording.view": "Recording watched or downloaded",
  "recording.delete": "Recording deleted",
  "device.clone": "Device cloned",
  "system.update": "Update started from the interface",
  "connection.identity_pinned": "Server identity recorded",
  "connection.quick": "Quick connection created",
  "vault.created": "Password vault created",
  "vault.migrated": "Saved passwords moved into the vault",
  "vault.reveal": "Vault secret shown",
  "vault.checkout": "Vault entry checked out",
  "vault.checkin": "Vault entry checked in",
  "vault.break_glass": "Break-glass check-out",
  "vault.request": "Vault access requested",
  "vault.request_cancel": "Vault request withdrawn",
  "vault.approve": "Vault request approved",
  "vault.reject": "Vault request rejected",
  "vault.share": "Vault entry sharing changed",
  "vault.restore": "Older vault value made current",
  "vault.rotate": "Vault password rotated",
  "settings.vault": "Vault password policy changed",
  "file.upload": "File uploaded",
  "file.download": "File downloaded",
  "file.delete": "File deleted",
  "file.rename": "File renamed",
  "file.mkdir": "Folder created",
  "file.copy": "Files copied between servers",
  "inventory.export": "Inventory exported",
  "inventory.import": "Inventory imported",
  "auth.2fa_enabled": "Two-factor authentication turned on",
  "auth.2fa_disabled": "Two-factor authentication turned off",
  "auth.2fa_recovery_codes": "Recovery codes renewed",
  "user.2fa_reset": "Two-factor reset by an administrator",
  "user.create": "User created",
  "user.update": "User access changed",
  "user.delete": "User deleted",
  "user.password_reset": "Password reset by an administrator",
  "user.sign_out": "User signed out by an administrator",
  "team.create": "Team created",
  "team.update": "Team changed",
  "team.delete": "Team deleted",
};

// ---- Terminal appearance (SSH and Telnet) ----
// Colors mirror the palettes the server sends to guacd (internal/api/themes.go); they only draw the swatches.
interface TerminalTheme {
  value: string;
  label: string;
  fg: string;
  bg: string;
  /** The 16 ANSI colors: what programs on the remote computer get when they ask for red, green, bright blue and so on. */
  ansi: string[];
  /** Red, green, yellow and blue, for the small swatches. */
  accents: [string, string, string, string];
}

const theme = (value: string, label: string, fg: string, bg: string, ansi: string[]): TerminalTheme => ({
  value,
  label,
  fg,
  bg,
  ansi,
  accents: [ansi[1], ansi[2], ansi[3], ansi[4]],
});

/** Dark themes first, then the light ones. Keep in step with internal/api/themes.go. */
export const TERMINAL_THEMES: TerminalTheme[] = [
  theme("gray-black", "Gray on black", "#aaaaaa", "#000000", ["#000000", "#aa0000", "#00aa00", "#aa5500", "#0000aa", "#aa00aa", "#00aaaa", "#aaaaaa", "#555555", "#ff5555", "#55ff55", "#ffff55", "#5555ff", "#ff55ff", "#55ffff", "#ffffff"]),
  theme("white-black", "White on black", "#ffffff", "#000000", ["#000000", "#aa0000", "#00aa00", "#aa5500", "#0000aa", "#aa00aa", "#00aaaa", "#aaaaaa", "#555555", "#ff5555", "#55ff55", "#ffff55", "#5555ff", "#ff55ff", "#55ffff", "#ffffff"]),
  theme("green-black", "Green on black", "#00cc00", "#000000", ["#000000", "#00cc00", "#00cc00", "#00cc00", "#00cc00", "#00cc00", "#00cc00", "#00cc00", "#00cc00", "#00cc00", "#00cc00", "#00cc00", "#00cc00", "#00cc00", "#00cc00", "#00cc00"]),
  theme("solarized-dark", "Solarized Dark", "#839496", "#002b36", ["#073642", "#dc322f", "#859900", "#b58900", "#268bd2", "#d33682", "#2aa198", "#eee8d5", "#002b36", "#cb4b16", "#586e75", "#657b83", "#839496", "#6c71c4", "#93a1a1", "#fdf6e3"]),
  theme("dracula", "Dracula", "#f8f8f2", "#282a36", ["#21222c", "#ff5555", "#50fa7b", "#f1fa8c", "#bd93f9", "#ff79c6", "#8be9fd", "#f8f8f2", "#6272a4", "#ff6e6e", "#69ff94", "#ffffa5", "#d6acff", "#ff92df", "#a4ffff", "#ffffff"]),
  theme("nord", "Nord", "#d8dee9", "#2e3440", ["#3b4252", "#bf616a", "#a3be8c", "#ebcb8b", "#81a1c1", "#b48ead", "#88c0d0", "#e5e9f0", "#4c566a", "#bf616a", "#a3be8c", "#ebcb8b", "#81a1c1", "#b48ead", "#8fbcbb", "#eceff4"]),
  theme("one-dark", "One Dark", "#abb2bf", "#282c34", ["#282c34", "#e06c75", "#98c379", "#e5c07b", "#61afef", "#c678dd", "#56b6c2", "#abb2bf", "#5c6370", "#e06c75", "#98c379", "#e5c07b", "#61afef", "#c678dd", "#56b6c2", "#ffffff"]),
  theme("tomorrow-night", "Tomorrow Night", "#c5c8c6", "#1d1f21", ["#1d1f21", "#cc6666", "#b5bd68", "#f0c674", "#81a2be", "#b294bb", "#8abeb7", "#c5c8c6", "#969896", "#cc6666", "#b5bd68", "#f0c674", "#81a2be", "#b294bb", "#8abeb7", "#ffffff"]),
  theme("monokai", "Monokai", "#f8f8f2", "#272822", ["#272822", "#f92672", "#a6e22e", "#f4bf75", "#66d9ef", "#ae81ff", "#a1efe4", "#f8f8f2", "#75715e", "#f92672", "#a6e22e", "#f4bf75", "#66d9ef", "#ae81ff", "#a1efe4", "#f9f8f5"]),
  theme("gruvbox-dark", "Gruvbox Dark", "#ebdbb2", "#282828", ["#282828", "#cc241d", "#98971a", "#d79921", "#458588", "#b16286", "#689d6a", "#a89984", "#928374", "#fb4934", "#b8bb26", "#fabd2f", "#83a598", "#d3869b", "#8ec07c", "#ebdbb2"]),
  theme("tokyo-night", "Tokyo Night", "#c0caf5", "#1a1b26", ["#15161e", "#f7768e", "#9ece6a", "#e0af68", "#7aa2f7", "#bb9af7", "#7dcfff", "#a9b1d6", "#414868", "#f7768e", "#9ece6a", "#e0af68", "#7aa2f7", "#bb9af7", "#7dcfff", "#c0caf5"]),
  theme("catppuccin-mocha", "Catppuccin Mocha", "#cdd6f4", "#1e1e2e", ["#45475a", "#f38ba8", "#a6e3a1", "#f9e2af", "#89b4fa", "#f5c2e7", "#94e2d5", "#bac2de", "#585b70", "#f38ba8", "#a6e3a1", "#f9e2af", "#89b4fa", "#f5c2e7", "#94e2d5", "#a6adc8"]),
  theme("github-dark", "GitHub Dark", "#c9d1d9", "#0d1117", ["#484f58", "#ff7b72", "#3fb950", "#d29922", "#58a6ff", "#bc8cff", "#39c5cf", "#b1bac4", "#6e7681", "#ffa198", "#56d364", "#e3b341", "#79c0ff", "#d2a8ff", "#56d4dd", "#f0f6fc"]),
  theme("material-dark", "Material Dark", "#eeffff", "#263238", ["#263238", "#ff5370", "#c3e88d", "#ffcb6b", "#82aaff", "#c792ea", "#89ddff", "#eeffff", "#546e7a", "#ff5370", "#c3e88d", "#ffcb6b", "#82aaff", "#c792ea", "#89ddff", "#ffffff"]),
  theme("rose-pine", "Rosé Pine", "#e0def4", "#191724", ["#26233a", "#eb6f92", "#31748f", "#f6c177", "#9ccfd8", "#c4a7e7", "#ebbcba", "#e0def4", "#6e6a86", "#eb6f92", "#31748f", "#f6c177", "#9ccfd8", "#c4a7e7", "#ebbcba", "#e0def4"]),
  theme("everforest", "Everforest", "#d3c6aa", "#2d353b", ["#475258", "#e67e80", "#a7c080", "#dbbc7f", "#7fbbb3", "#d699b6", "#83c092", "#d3c6aa", "#475258", "#e67e80", "#a7c080", "#dbbc7f", "#7fbbb3", "#d699b6", "#83c092", "#d3c6aa"]),
  theme("night-owl", "Night Owl", "#d6deeb", "#011627", ["#011627", "#ef5350", "#22da6e", "#addb67", "#82aaff", "#c792ea", "#21c7a8", "#ffffff", "#575656", "#ef5350", "#22da6e", "#ffeb95", "#82aaff", "#c792ea", "#7fdbca", "#ffffff"]),
  theme("ayu-dark", "Ayu Dark", "#bfbdb6", "#0b0e14", ["#11151c", "#ea6c73", "#7fd962", "#f9af4f", "#53bdfa", "#cda1fa", "#90e1c6", "#c7c7c7", "#686868", "#f07178", "#aad94c", "#ffb454", "#59c2ff", "#d2a6ff", "#95e6cb", "#ffffff"]),
  theme("zenburn", "Zenburn", "#dcdccc", "#3f3f3f", ["#4d4d4d", "#705050", "#60b48a", "#f0dfaf", "#506070", "#dc8cc3", "#8cd0d3", "#dcdccc", "#709080", "#dca3a3", "#c3bf9f", "#e0cf9f", "#94bff3", "#ec93d3", "#93e0e3", "#ffffff"]),
  theme("tango-dark", "Tango Dark", "#d3d7cf", "#2e3436", ["#2e3436", "#cc0000", "#4e9a06", "#c4a000", "#3465a4", "#75507b", "#06989a", "#d3d7cf", "#555753", "#ef2929", "#8ae234", "#fce94f", "#729fcf", "#ad7fa8", "#34e2e2", "#eeeeec"]),
  theme("amber", "Amber (retro)", "#ffb000", "#1a1000", ["#1a1000", "#ff6a00", "#d6a100", "#ffcc33", "#ff9d00", "#ff7a00", "#ffc766", "#ffb000", "#7a5600", "#ff8c3a", "#ffd24d", "#ffe08a", "#ffb84d", "#ff9a5c", "#ffd699", "#fff0cc"]),
  theme("black-white", "Black on white", "#000000", "#ffffff", ["#000000", "#aa0000", "#00aa00", "#aa5500", "#0000aa", "#aa00aa", "#00aaaa", "#aaaaaa", "#555555", "#ff5555", "#55ff55", "#ffff55", "#5555ff", "#ff55ff", "#55ffff", "#ffffff"]),
  theme("solarized-light", "Solarized Light", "#657b83", "#fdf6e3", ["#073642", "#dc322f", "#859900", "#b58900", "#268bd2", "#d33682", "#2aa198", "#eee8d5", "#002b36", "#cb4b16", "#586e75", "#657b83", "#839496", "#6c71c4", "#93a1a1", "#fdf6e3"]),
  theme("gruvbox-light", "Gruvbox Light", "#3c3836", "#fbf1c7", ["#fbf1c7", "#cc241d", "#98971a", "#d79921", "#458588", "#b16286", "#689d6a", "#7c6f64", "#928374", "#9d0006", "#79740e", "#b57614", "#076678", "#8f3f71", "#427b58", "#3c3836"]),
  theme("catppuccin-latte", "Catppuccin Latte", "#4c4f69", "#eff1f5", ["#5c5f77", "#d20f39", "#40a02b", "#df8e1d", "#1e66f5", "#ea76cb", "#179299", "#acb0be", "#6c6f85", "#d20f39", "#40a02b", "#df8e1d", "#1e66f5", "#ea76cb", "#179299", "#bcc0cc"]),
  theme("github-light", "GitHub Light", "#24292f", "#ffffff", ["#24292f", "#cf222e", "#116329", "#4d2d00", "#0969da", "#8250df", "#1b7c83", "#6e7781", "#57606a", "#a40e26", "#1a7f37", "#633c01", "#218bff", "#a475f9", "#3192aa", "#8c959f"]),
  theme("paper", "Paper", "#333333", "#f5f2e9", ["#333333", "#b00020", "#1b7f3b", "#8a6500", "#1f5fbf", "#8e3b9e", "#0e7c86", "#bdbdbd", "#6b6b6b", "#d93a4a", "#2fa353", "#b58900", "#3b82f6", "#a855f7", "#1fa3ad", "#ffffff"]),
];

/** Monospace fonts installed in the gateway (guacd) image. */
export const TERMINAL_FONTS = ["DejaVu Sans Mono", "Liberation Mono", "Terminus"];
