# Changelog

## Unreleased

- **SSH key files:** choose or drop a `.pem`, `id_rsa` or `id_ed25519` file instead of pasting; keys are
  checked when saved (wrong passphrase, public key, PuTTY format are explained) and stored encrypted.

- **First run without a token:** the first page creates the administrator and signs in. Setup is
  limited to private-network addresses, or protected by an optional `EMREMOTE_SETUP_TOKEN`.
- **Published images:** `docker compose pull && docker compose up -d` (amd64 and arm64, from the
  GitHub Container Registry on every `v*` tag); `scripts/install.sh` and `scripts/init-env.sh`.

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
