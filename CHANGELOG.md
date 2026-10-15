# Changelog

## 0.1.5 (2026-10-15)

- Removed the Donate button, its dialog, the `EMREMOTE_HIDE_DONATE` setting and the bank details from the
  README. Screenshots show the current interface.

## 0.1.4 (2026-10-15)

- **Switches, routers and firewalls:** "Network" is now a device kind in Add device (SSH or Telnet). Over
  SSH emremote reads the vendor, firmware, model, serial number, uptime, CPU and memory with a few fixed
  read-only `show` commands, and shows the vendor logo. Cisco IOS/IOS XE/NX-OS, Juniper Junos, MikroTik
  RouterOS, Huawei VRP and HPE/Aruba (ProCurve, AOS-CX) are recognised; other vendors still work for
  terminals. These devices have no Files tab. Checked with a simulated Cisco switch and sample output
  of the other vendors, not with real hardware of each brand.
- A new installation starts with three shared groups: Workstations, Servers and Network. Existing
  installations are not changed.
- GitHub button with the star count in the top bar and on the sign-in and setup screens.

## 0.1.3 (2026-10-15)

- The sidebar footer tells administrators when a newer release exists ("Update available") instead of
  repeating the gateway status, which is now the dot's tooltip. emremote checks GitHub's latest release
  every 12 hours; `EMREMOTE_UPDATE_CHECK=false` turns it off.

## 0.1.2 (2026-10-15)

- **Empty-database guard:** if a server that was set up before comes up with no accounts (usually a data
  folder that is not mounted), first-time setup is refused with an explanation instead of letting a stranger
  create a new administrator. `EMREMOTE_ALLOW_EMPTY_DATABASE=true` starts over on purpose.
- **Audit log retention:** `EMREMOTE_AUDIT_RETENTION_DAYS` and `EMREMOTE_AUDIT_MAX_ENTRIES` (default one
  million) remove old entries every six hours.
- **Secrets from files:** `EMREMOTE_ENCRYPTION_KEY_FILE`, `EMREMOTE_DATABASE_URL_FILE` and
  `EMREMOTE_SETUP_TOKEN_FILE` (Docker secrets).
- Donate button in the top bar, with a way to hide it.
- SSH connections: "Allow legacy algorithms" lets emremote's own SSH client (files, system overview, jump
  host, host key lookup) talk to old switches and routers; modern algorithms are still preferred.
- `scripts/update.sh`: backup, pull, restart and health check in one command, from any folder.
- Release images carry build provenance and an SBOM and are signed with cosign (keyless). CI runs
  govulncheck, `npm audit` for production dependencies and CodeQL, and Dependabot watches dependencies.

## 0.1.1 (2026-10-15)

- **Set up without a token:** the first page creates the administrator and signs in, in the same
  terminal-style window as the sign-in screen. Setup is limited to private-network addresses, or
  protected by an optional `EMREMOTE_SETUP_TOKEN`.
- **Published images and one-step install:** `docker compose pull && docker compose up -d`
  (amd64 and arm64, from the GitHub Container Registry on every `v*` tag), `scripts/install.sh` and
  `scripts/init-env.sh`, which also picks free ports when 80 and 443 are taken.
- **SSH key files:** choose or drop a `.pem`, `id_rsa` or `id_ed25519` file instead of pasting; keys are
  checked when saved (wrong passphrase, public key, PuTTY format are explained) and stored encrypted.
- Favicon uses the white terminal icon.
- **Donate button** in the top bar with support details; each person can hide it, and operators can
  remove it with `EMREMOTE_HIDE_DONATE=true`.

## Before the first tag

- **Session sharing:** a view-only link to a live session, with a viewer count, revocation and audit.
- **Wake-on-LAN:** MAC address per device (learned over SSH), Wake button, audited and rate limited.
- **RDP:** printing to PDF, microphone, RemoteApp, Hyper-V VMConnect (VM name or id).
- **SSH:** Backspace code and locale settings.
- **Workspace:** all sessions open as tabs in one window, with one, two (side by side or stacked) or
  four panes; hidden sessions stay connected and the keyboard follows the active pane.
- **Jump hosts:** reach devices that only a bastion can see (RDP, VNC, SSH, Telnet, files, system
  info), off by default and limited to `EMREMOTE_JUMP_TARGET_NETWORKS`. See docs/CONNECTIONS.md.
- **Two-factor authentication (TOTP)** with QR setup, recovery codes, a code line on the terminal-style
  login, administrator reset and CLI recovery.
- **Import and export** of devices (emremote JSON, CSV, OpenSSH config import) with preview and
  conflict handling; exports never contain secrets.
- **Command snippets** for terminal sessions: private, one-click insert, recent list, no keystroke
  recording.
- **Terminal appearance:** ten color themes, three fonts and a text size, per browser from the
  toolbar or per connection.
- Paste into RDP and VNC waits a little longer (350 ms) for the remote clipboard to update.
- **Multi-user:** a Users screen for accounts, teams, permissions and shared-inventory access
  (everything, selected devices and groups, or nothing). Members can keep a private inventory that
  starts empty. Per-user favorites and recent activity, per-user vault keys, administrator password
  reset, disable and delete (keeping or removing the user's inventory). Migration 0005 keeps all
  existing data as the shared inventory. See docs/USERS.md.
- **Clipboard that always works:** Ctrl+V / ⌘V / Shift+Insert paste local text into RDP, VNC and
  SSH/Telnet sessions without any browser permission (the text is synced, then the target's own
  paste shortcut is sent). Right-click paste uses the same text, and is refreshed from the local
  clipboard in Chromium where allowed. Remote copies reach the local clipboard, retried on the next
  gesture if the browser refuses. ⌘ shortcuts map to Ctrl on Windows/Linux. "Type it" types text
  key by key for sign-in screens. Dragging a selection under the toolbar no longer stops.
- **Context-aware session toolbar:** keys and shortcuts per target (Windows, macOS, Linux desktop,
  terminal); display settings only where they apply.
- **SFTP transfer** page: copy files and folders directly between two servers (SFTP or RDP transfer
  drives) with progress, cancel and skip/overwrite, audited as `file.copy`.
- **Quick connect** on Overview: connect to a host without adding it; nothing is saved unless
  "Save as a device" is ticked. The password is kept only in server memory for that browser session.
- **Statistics** page: favorites, recently added devices, and connection type, OS and reachability
  breakdowns (moved off Overview).
- Terminal-style sign-in screen (Enter moves from login to password, then signs in).
- English-only UI: dates and relative times always use English, whatever the browser language,
  browser-native (localized) form validation bubbles were replaced with in-app messages, and em dashes were removed.

## 0.1.0: first release

- Device inventory with groups, tags, favorites, notes, search/filter, table and card views.
- Browser-based RDP, VNC and SSH sessions through Apache Guacamole guacd 1.6.0 and the official
  guacamole-common-js client. No agent on target computers.
- Live resize (RDP display-update, SSH), VNC scale-to-fit, HiDPI modes, fullscreen with keyboard
  lock, clipboard panel, special keys, credential prompts.
- RDP certificate pinning (with downgrade protection) and SSH host key pinning.
- Encrypted credential storage (AES-256-GCM): per-connection secrets or reusable saved credentials.
- TCP reachability probes as a truthful device status.
- Local authentication: Argon2id, secure session cookies, CSRF protection, rate limiting, one-time
  setup token, CLI password reset.
- Audit log of authentication, inventory changes and remote sessions.
- Docker Compose deployment: Caddy (HTTPS), distroless non-root application image, internal-only
  database and gateway networks, health checks, backup and restore scripts.
