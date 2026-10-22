export type OS = "windows" | "macos" | "linux" | "network" | "esxi" | "other";
export type DeviceType = "desktop" | "laptop" | "server" | "virtual_machine" | "network" | "other";
export type Protocol = "rdp" | "vnc" | "ssh" | "telnet";

export type Permission = "sessions.connect" | "files.use" | "quick.connect" | "inventory.manage" | "credentials.manage";
export type InventoryMode = "none" | "selected" | "all";

export interface User {
  id: string;
  username: string;
  role: "admin" | "member";
  created_at: string;
  last_login_at: string | null;
  password_changed_at: string;
  disabled: boolean;
  /** Granted directly; the team adds more. */
  permissions: Permission[];
  inventory_mode: InventoryMode;
  team_id: string | null;
  team_name: string | null;
  team_permissions: Permission[];
  team_inventory_mode: InventoryMode;
  /** Everything this user may do (administrators: all). */
  effective_permissions: Permission[];
  two_factor_enabled: boolean;
}

export interface Grants {
  device_ids: string[];
  group_ids: string[];
}

export interface UserRow extends User {
  grants: Grants;
  owned_devices: number;
  active_sessions: number;
}

export interface Team {
  id: string;
  name: string;
  description: string;
  permissions: Permission[];
  inventory_mode: InventoryMode;
  grants: Grants;
  member_count: number;
}

export interface Me {
  user: User;
  csrf_token: string;
  expires_at: string;
}

export interface ConnectionSummary {
  id: string;
  device_id: string;
  name: string;
  protocol: Protocol;
  port: number;
  last_used_at: string | null;
  status_reachable: boolean | null;
  status_checked_at: string | null;
  status_detail: string;
}

export interface Device {
  id: string;
  /** null = shared inventory */
  owner_id: string | null;
  /** Whether the signed-in user may edit or delete it. */
  can_manage: boolean;
  name: string;
  hostname: string;
  address: string;
  os: OS;
  device_type: DeviceType;
  description: string;
  notes: string;
  tags: string[];
  /** The first group; `groups` lists all of them. */
  group_id: string | null;
  group_name: string | null;
  groups: { id: string; name: string }[];
  favorite: boolean;
  created_at: string;
  updated_at: string;
  last_accessed_at: string | null;
  connections: ConnectionSummary[];
  /** For Wake-on-LAN. */
  mac: string;
  wol_broadcast: string;
  /** Details read from the device over SSH; empty until first collected. */
  facts: DeviceFacts | Record<string, never>;
  /** Where the device is, for the map. */
  location: { label: string; latitude: number; longitude: number } | null;
}

export interface Virtualization {
  kind: "vm" | "container" | "physical";
  platform: string;
  note?: string;
  hardware?: string;
}

export interface DeviceFacts {
  platform?: "linux" | "macos" | "windows" | "network";
  os?: string;
  vendor?: string;
  model?: string;
  serial?: string;
  kernel?: string;
  arch?: string;
  hostname?: string;
  cpu_model?: string;
  cpu_cores?: number;
  memory_bytes?: number;
  uptime_s?: number;
  virtualization?: Virtualization;
  /** "rdp" when learned from the RDP negotiation only. */
  source?: string;
  domain?: string;
  collected_at?: string;
}

export interface Group {
  id: string;
  owner_id: string | null;
  can_manage: boolean;
  name: string;
  description: string;
  device_count: number;
}

export interface RDPSettings {
  /** SSH connection to reach this target through (jump host); empty for a direct connection. */
  jump_connection_id: string;
  security: "any" | "nla" | "nla-ext" | "tls" | "rdp" | "vmconnect";
  ignore_cert: boolean;
  cert_fingerprints: string;
  color_depth: number;
  resize_method: "display-update" | "reconnect" | "none";
  force_lossless: boolean;
  disable_gfx: boolean;
  enable_font_smoothing: boolean;
  enable_wallpaper: boolean;
  enable_theming: boolean;
  enable_full_window_drag: boolean;
  enable_desktop_composition: boolean;
  enable_menu_animations: boolean;
  disable_audio: boolean;
  console: boolean;
  server_layout: string;
  disable_copy: boolean;
  disable_paste: boolean;
  read_only: boolean;
  enable_drive: boolean;
  /** A virtual printer; documents arrive in the browser as PDF files. */
  enable_printing: boolean;
  enable_audio_input: boolean;
  /** Opens one application instead of the desktop (RemoteApp), e.g. "||notepad". */
  remote_app: string;
  remote_app_dir: string;
  remote_app_args: string;
  /** Hyper-V: VM name or id, with security "vmconnect" on port 2179. */
  preconnection_blob: string;
  preconnection_id: number;
}

export interface VNCSettings {
  /** SSH connection to reach this target through (jump host); empty for a direct connection. */
  jump_connection_id: string;
  color_depth: number;
  quality_level: number;
  compress_level: number;
  force_lossless: boolean;
  cursor: "local" | "remote";
  swap_red_blue: boolean;
  clipboard_encoding: string;
  disable_copy: boolean;
  disable_paste: boolean;
  read_only: boolean;
}

export interface SSHSettings {
  /** SSH connection to reach this target through (jump host); empty for a direct connection. */
  jump_connection_id: string;
  host_key: string;
  allow_legacy_algorithms: boolean;
  font_name: string;
  font_size: number;
  color_scheme: string;
  scrollback: number;
  terminal_type: string;
  server_alive_interval: number;
  /** Code the Backspace key sends: 127 (DEL) or 8 (BS). */
  backspace: number;
  /** Remote shell locale, e.g. en_US.UTF-8; empty uses the server default. */
  locale: string;
  disable_copy: boolean;
  disable_paste: boolean;
  read_only: boolean;
}

export interface TelnetSettings {
  /** SSH connection to reach this target through (jump host); empty for a direct connection. */
  jump_connection_id: string;
  font_name: string;
  font_size: number;
  color_scheme: string;
  scrollback: number;
  terminal_type: string;
  backspace: number;
  username_regex: string;
  password_regex: string;
  login_success_regex: string;
  login_failure_regex: string;
  disable_copy: boolean;
  disable_paste: boolean;
  read_only: boolean;
}

export type Settings = RDPSettings | VNCSettings | SSHSettings | TelnetSettings;

export interface Connection extends ConnectionSummary {
  can_manage: boolean;
  device_owner_id: string | null;
  device_name: string;
  device_address: string;
  device_os: OS;
  username: string;
  domain: string;
  credential_id: string | null;
  credential_name: string | null;
  secret_fields: string[];
  settings: Settings;
  created_at: string;
  updated_at: string;
}

export interface Credential {
  id: string;
  owner_id: string | null;
  can_manage: boolean;
  name: string;
  username: string;
  domain: string;
  secret_fields: string[];
  usage_count: number;
  created_at: string;
  updated_at: string;
}

export interface SecretInput {
  mode: "keep" | "set" | "clear";
  password?: string;
  private_key?: string;
  passphrase?: string;
}

export interface AuditEvent {
  id: number;
  occurred_at: string;
  actor_user_id: string | null;
  actor_name: string;
  action: string;
  target_type: string;
  target_id: string;
  target_name: string;
  ip: string;
  success: boolean;
  details: Record<string, unknown>;
}

export interface ActiveSession {
  id: string;
  user_id: string;
  connection_id: string;
  connection_name: string;
  device_id: string;
  device_name: string;
  protocol: Protocol;
  username: string;
  client_ip: string;
  started_at: string;
  /** People watching through a share link. */
  viewers: number;
  shared: boolean;
}

export interface DashboardStats {
  device_count: number;
  favorite_count: number;
  connection_count: number;
  credential_count: number;
  group_count: number;
  protocols: Partial<Record<Protocol, number>>;
  operating_systems: Partial<Record<OS, number>>;
  reachability: Partial<Record<"reachable" | "unreachable" | "unknown", number>>;
  recently_accessed: Device[];
  recently_created: Device[];
  favorites: Device[];
  recent_activity: AuditEvent[];
  sessions_by_day: { date: string; count: number }[];
  top_devices: { device_id: string; name: string; sessions: number }[];
  attention: { device_id: string; name: string; address: string; protocol: Protocol; port: number; detail: string; checked_at: string | null }[];
}

export interface Statistics {
  days: number;
  totals: { sessions: number; failed: number; unique_devices: number; total_seconds: number; ended: number };
  by_day: { date: string; rdp: number; ssh: number; vnc: number; telnet: number }[];
  heatmap: number[][];
  top_devices: { device_id: string; name: string; sessions: number; seconds: number }[];
  users: { username: string; sessions: number; seconds: number }[];
  transfers: { uploads: number; downloads: number; upload_bytes: number; download_bytes: number };
  security: {
    failed_logins: number;
    users: number;
    two_factor_users: number;
    admin_view: boolean;
    ssh_pinned: number;
    ssh_total: number;
    rdp_pinned: number;
    rdp_total: number;
  };
  fleet: {
    devices: number;
    with_facts: number;
    cores: number;
    memory_bytes: number;
    kinds: Record<string, number>;
    types: Record<string, number>;
    never_used: number;
    idle_30_days: number;
    tags: { name: string; count: number }[];
    groups: { name: string; count: number }[];
    reachability: Record<string, number>;
  };
}

export interface Dashboard {
  stats: DashboardStats;
  active_sessions: ActiveSession[];
}

export interface SystemInfo {
  version: string;
  gateway: "reachable" | "unreachable";
  allowed_target_networks: string[];
  denied_target_networks: string[];
  status_check_interval_s: number;
  session_ttl_s: number;
  session_idle_timeout_s: number;
  secure_cookies: boolean;
  jump_enabled?: boolean;
  update_check?: boolean;
  sponsor?: boolean;
  github_stars?: number;
  latest_version?: string;
  release_url?: string;
  audit_retention_days?: number;
  audit_max_entries?: number;
}

export interface LoginSession {
  created_at: string;
  last_seen_at: string;
  expires_at: string;
  ip: string;
  user_agent: string;
  current: boolean;
}

export interface RDPCertificate {
  subject: string;
  issuer: string;
  not_before: string;
  not_after: string;
  self_signed: boolean;
  sha256: string;
  fingerprint: string;
  protocol: string;
}

export interface SSHHostKey {
  type: string;
  key: string;
  fingerprint: string;
}

export interface FileEntry {
  name: string;
  path: string;
  type: "dir" | "file" | "link" | "other";
  size: number;
  mode: string;
  modified: string;
  target?: "dir" | "file";
}

export interface FileListing {
  path: string;
  parent: string;
  entries: FileEntry[];
}

export interface SystemInfo {
  collected_at: string;
  platform: "linux" | "macos" | "windows" | "network";
  vendor?: string;
  model?: string;
  serial?: string;
  hostname: string;
  os: string;
  kernel: string;
  arch: string;
  uptime_seconds: number;
  cpu: { model: string; cores: number; usage_percent: number | null; load?: number[] };
  memory: { total_bytes: number; used_bytes: number; swap_total_bytes: number; swap_used_bytes: number };
  disks: { mount: string; filesystem: string; total_bytes: number; used_bytes: number }[];
  processes: { pid: number; name: string; cpu_percent?: number; mem_percent?: number; cpu_seconds?: number; mem_bytes?: number }[];
  log_source: string;
  logs: { time?: string; level?: string; source?: string; message: string }[];
  duration_ms: number;
  virtualization?: Virtualization;
}

export interface Snippet {
  id: string;
  name: string;
  body: string;
  category: string;
  use_count: number;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}
