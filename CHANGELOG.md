# Changelog

## 0.1.13 (2026-10-22)

- **A device in several groups:** a device can belong to more than one group (the first is its main group). Every group
  counts it, a group granted to a person reaches the devices in it, and deleting the main group leaves the next one in
  charge. JSON exports and imports keep all groups.
- **VMware ESXi** is a device kind of its own, with the VMware logo. It has no system overview (its shell is not a Linux
  shell), so that tab is hidden; files over SFTP and terminals work as for any SSH server.
- **Proxmox VE hosts** show the Proxmox logo and version instead of Debian (found by the "-pve" kernel and `pveversion`);
  hosts read earlier are read again once.

- **Device locations:** when adding or editing a device you can say where it is: search a city from a built-in list,
  click the map, or type coordinates. Nothing is sent to a map service.
- **Map on the Overview page:** the located devices on a world map; devices close to each other become one marker with a
  count, and a click lists them. Colours follow reachability. The outlines ship with the application (Natural Earth,
  public domain), so the map also works without internet access.
- **Clone a device:** "Clone device" (device page menu and the list's row menu) creates a new device of the same kind in
  the same group with the same tags and place, copies its connection methods and, when the original is yours (or shared and
  you are an administrator), the saved passwords and keys too. Pinned SSH host keys and RDP certificates are not copied; the
  clone records its own on the first connection. A member cloning a shared device never receives its saved passwords.
- Locations are part of the JSON export and import.

## 0.1.12 (2026-10-22)

- **Allowed target networks in Settings:** administrators add the public servers or networks emremote may connect to
  without editing `.env` or restarting (Settings, "Allowed target networks"; one address or network per line). `0.0.0.0` or
  `::` allows every address, after a warning. What is saved replaces `EMREMOTE_ALLOWED_TARGET_NETWORKS`; "Use the default"
  goes back to it.
- Link-local addresses (169.254.0.0/16, which includes the cloud metadata service) are now always refused, so a wide allowed
  list can never reach them. Loopback, multicast and emremote's own networks were and are refused too.
- `tests/stack.sh` starts the isolated test stack (the application, the test servers and a simulated switch) and runs the
  end-to-end suites.

## 0.1.11 (2026-10-21)

- **Right click in SSH and Telnet terminals:** with text selected it now only copies (and clears the selection) instead of
  copying and then pasting the text back into the shell; without a selection it pastes, as in PuTTY and Windows Terminal.
- **A sign-in that ended is noticed:** a tab that nobody touches used to keep showing the app after the server had
  ended the sign-in (idle timeout, longest sign-in, signed out elsewhere), while connections no longer worked until a
  refresh. The page now checks in the background every 30 seconds and when you come back to it, and goes to the
  sign-in screen with a note. The background check does not count as activity, so a forgotten tab still times out.
- **The sign-in screen says why you are there:** when a sign-in ended on the server it now says so ("Your sign-in ended (it
  timed out or was ended elsewhere)"), after a restart it says that, and when the browser sent no cookie at all there is no
  note. That makes it easy to tell a restart, a timeout and a browser that does not keep cookies apart.
- **Sign-in limits in Settings:** administrators choose how long an unused sign-in lasts, the longest sign-in and how
  long "remember me" keeps a browser signed in (Settings, "Sign-in sessions"). What is saved replaces the environment
  defaults; open remote sessions still count as activity.

## 0.1.10 (2026-10-18)

- **Sign-in screen:** a neofetch-style header with the emremote logo and facts about the installation (version,
  Docker or other runtime, container OS, architecture, Go version, uptime; `EMREMOTE_LOGIN_INFO=false` hides them).
  The login is typed line by line like in a terminal: login, Enter, password, Enter, then **remember me (yes/no)**.
- **Remember me:** a yes keeps the browser signed in for 30 days (`EMREMOTE_REMEMBER_DAYS`, `0` turns it off; at most
  7 days unused) with a cookie, so people do not have to sign in again all the time.
- The GitHub link sits in the title bar of the terminal window. The hints at the bottom now also show how to reset
  two-factor and how to update from the server.
- Removed code that nothing used (found with Knip and Go's deadcode); Knip now runs in CI so unused code is caught early.

## 0.1.9 (2026-10-17)

- **Update from the interface (optional):** the "Update available" notice opens a window with the release notes and, when the
  optional `updater` container is on (`COMPOSE_PROFILES=updater`), an **Update now** button. It backs up the database,
  downloads the new image, restarts, checks that it is healthy (and goes back to the old version if not), shows the
  progress, and reloads the page afterwards. See docs/DEPLOYMENT.md for what the updater can do and why it is off by default.
- Images carry their version in the `org.opencontainers.image.version` label.
- **Quick view:** next to Connect there is now a button (and a menu section) that opens the session in a large
  window on top of the current page, without leaving it or opening another browser window. Closing it
  ends the session; "Open in window" moves it to the workspace. Escape goes to the remote computer, not to
  the window.
- The Wake button is no longer shown for virtual machines and containers, which have no network card to wake.
- Closing a connected session tab in the workspace asks for confirmation in a dialog first.
- `emremote reset-2fa <user>` turns two-factor off from the server without changing the password.
- README: installing from the ZIP file, what to do when locked out, a clearer support section.
- The front end is checked with ESLint (`npm run lint`) in CI, next to the type check and the tests.
- npm packages: minor and patch updates.
- The buttons at the top of a device page (Wake, Quick view, Connect, Edit device) have the same size.

## 0.1.8 (2026-10-16)

- The check for a newer release (and the GitHub star count) now runs every hour instead of every 12 hours.

## 0.1.7 (2026-10-16)

- `scripts/update.sh` prints short progress lines; the details of git, the backup and docker appear only when
  a step fails.
- The star count and the "Update available" notice retry after 10 minutes when GitHub cannot be reached,
  instead of waiting 12 hours.
- Dependabot groups minor updates and skips major versions; the end-to-end suite runs in CI.

## 0.1.6 (2026-10-15)

- A Sponsor button in the top bar and a README section link to GitHub Sponsors (no bank details).
  `EMREMOTE_HIDE_SPONSOR=true` hides the button.

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
