import type { DeviceType, OS, Protocol, RDPSettings, SSHSettings, TelnetSettings, VNCSettings } from "./types";

export const OS_LABELS: Record<OS, string> = {
  windows: "Windows",
  macos: "macOS",
  linux: "Linux",
  network: "Network",
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

export const DEFAULT_RDP: RDPSettings = {
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

export const DEFAULT_VNC: VNCSettings = {
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

export const DEFAULT_TELNET: TelnetSettings = {
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
  "connection.identity_pinned": "Server identity recorded",
  "connection.quick": "Quick connection created",
  "vault.created": "Password vault created",
  "vault.migrated": "Saved passwords moved into the vault",
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
export interface TerminalTheme {
  value: string;
  label: string;
  fg: string;
  bg: string;
  accents: [string, string, string, string];
}

export const TERMINAL_THEMES: TerminalTheme[] = [
  { value: "gray-black", label: "Gray on black", fg: "#aaaaaa", bg: "#000000", accents: ["#aa0000", "#00aa00", "#aa5500", "#0000aa"] },
  { value: "white-black", label: "White on black", fg: "#ffffff", bg: "#000000", accents: ["#aa0000", "#00aa00", "#aa5500", "#0000aa"] },
  { value: "green-black", label: "Green on black", fg: "#00cc00", bg: "#000000", accents: ["#00cc00", "#00cc00", "#00cc00", "#00cc00"] },
  { value: "black-white", label: "Black on white", fg: "#000000", bg: "#ffffff", accents: ["#aa0000", "#00aa00", "#aa5500", "#0000aa"] },
  { value: "solarized-dark", label: "Solarized Dark", fg: "#839496", bg: "#002b36", accents: ["#dc322f", "#859900", "#b58900", "#268bd2"] },
  { value: "solarized-light", label: "Solarized Light", fg: "#657b83", bg: "#fdf6e3", accents: ["#dc322f", "#859900", "#b58900", "#268bd2"] },
  { value: "dracula", label: "Dracula", fg: "#f8f8f2", bg: "#282a36", accents: ["#ff5555", "#50fa7b", "#f1fa8c", "#bd93f9"] },
  { value: "nord", label: "Nord", fg: "#d8dee9", bg: "#2e3440", accents: ["#bf616a", "#a3be8c", "#ebcb8b", "#81a1c1"] },
  { value: "one-dark", label: "One Dark", fg: "#abb2bf", bg: "#282c34", accents: ["#e06c75", "#98c379", "#e5c07b", "#61afef"] },
  { value: "tomorrow-night", label: "Tomorrow Night", fg: "#c5c8c6", bg: "#1d1f21", accents: ["#cc6666", "#b5bd68", "#f0c674", "#81a2be"] },
];

/** Monospace fonts installed in the gateway (guacd) image. */
export const TERMINAL_FONTS = ["DejaVu Sans Mono", "Liberation Mono", "Terminus"];
