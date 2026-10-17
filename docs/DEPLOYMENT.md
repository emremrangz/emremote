# Deployment

## Requirements

| Resource | Minimum | Recommended | Notes |
|---|---|---|---|
| CPU | 1 vCPU | 2 vCPU | guacd encodes the remote screen; more concurrent graphical sessions need more CPU. |
| RAM | 1 GB | 2 GB | Measured: about 210 MB for the whole stack when idle, and about 270 MB with one 1920×1080 RDP session plus one SSH session open. Allow 50–250 MB per extra RDP session. |
| Disk | 3 GB | 10 GB | Images: about 25 MB (emremote) + 380 MB (guacd) + 425 MB (postgres) + 85 MB (caddy). Build stages need about 1.5 GB of build cache. The database stays small (MBs). |
| Software | Docker Engine 24+, Compose v2 | | Tested with Docker 29.9 and Compose v5.6 on Debian 12. |

### Network ports

| Port | Direction | Purpose |
|---|---|---|
| 443/tcp | clients → emremote host | Web UI and session WebSocket (HTTPS). |
| 80/tcp | clients → emremote host | Redirects to HTTPS. Optional: set `EMREMOTE_HTTP_PORT` to another value or remove the mapping. |
| 3389, 5900, 22 (or your ports) | emremote host → targets | Outbound from the `guacd` and `emremote` containers to your computers. |

PostgreSQL (5432) and guacd (4822) are **never published**. They sit on an internal Docker network
(`core`, `internal: true`) that has no route outside the host.

### Proxmox LXC

- Use an **unprivileged** container with **nesting enabled** (`features: nesting=1`). Docker inside
  an LXC often also needs `keyctl=1`; set it if Docker itself asks for it. emremote adds no
  requirements beyond what Docker needs.
- No container in the stack runs privileged, uses host networking, mounts the Docker socket or needs
  extra kernel capabilities. A one-shot `init-transfer` container (no network, only `CHOWN`) hands
  the transfer-drive folder to uid 1000, which guacd and emremote run as. Each container drops all capabilities and adds back only what it needs:
  - Caddy: `NET_BIND_SERVICE`.
  - PostgreSQL: the standard set its entrypoint needs to switch to the `postgres` user.
  - emremote and guacd: none.
- `no-new-privileges` is set on every container. Root filesystems are read-only where possible
  (emremote, guacd, caddy).
- Nothing in this stack needs you to change the LXC's AppArmor profile or other host security
  settings.

## Installation

```bash
cd /opt/emremote
./scripts/init-env.sh 192.168.1.50   # creates .env with fresh secrets (or copy .env.example and edit it)
docker compose up -d                 # pulls the published images
docker compose ps                    # all services "healthy"
```

To build the image yourself instead of pulling it (for development): `docker compose build && docker compose up -d`.
To update: run `scripts/update.sh` (works from any folder: backs up the database, pulls the images, restarts and checks health; `--no-backup` skips the backup). By hand: `docker compose pull && docker compose up -d` inside the install folder. Pin a version with `EMREMOTE_IMAGE_TAG=0.1.0` in `.env`.

Required `.env` values:

| Variable | How to set |
|---|---|
| `EMREMOTE_SITE_ADDRESS` | The name(s) you will type into the browser, comma-separated (e.g. `emremote.home.arpa, 192.168.1.50`). The certificate is issued for these. |
| `EMREMOTE_DEFAULT_SNI` | If you browse by **IP address**, set it to that IP. Browsers send no SNI for IP addresses, and without this value TLS fails with "internal error". |
| `POSTGRES_PASSWORD` | `openssl rand -base64 24 \| tr -d '/+='` |
| `EMREMOTE_ENCRYPTION_KEY` | `openssl rand -base64 32`. **Back it up.** Without it, stored connection passwords cannot be decrypted. |

Strongly recommended: narrow `EMREMOTE_ALLOWED_TARGET_NETWORKS` to your LAN, e.g. `192.168.1.0/24`.
See [SECURITY.md](SECURITY.md#target-network-policy-ssrf-protection).

### First-run setup

When the database has no users, the first page you open asks you to create the administrator
(username and password), and signs you in. No token or log reading is needed.

Until that account exists, anyone who can reach the page could create it. emremote therefore only offers
first-time setup to computers on a **private network** (RFC 1918 and unique-local addresses, loopback,
link-local and the 100.64.0.0/10 range used by Tailscale); a request from a public address is
refused. If the instance is reachable from outside, or you simply want a second factor for setup, set
`EMREMOTE_SETUP_TOKEN` (at least 12 characters) in `.env`: the setup screen then asks for it, from
anywhere. Create the account promptly after starting a new instance.

### Secrets from files (Docker secrets)

Instead of keeping the encryption key and database password in `.env`, give emremote files. Each of
`EMREMOTE_ENCRYPTION_KEY`, `EMREMOTE_DATABASE_URL` and `EMREMOTE_SETUP_TOKEN` can be replaced by the same
name with `_FILE` appended, which names a file whose content is the value (trailing newlines are ignored,
and the file wins if both are set). A missing or empty file stops the start with a clear message.

```yaml
# compose.override.yaml (next to compose.yaml); .env then leaves EMREMOTE_ENCRYPTION_KEY empty
services:
  emremote:
    environment:
      EMREMOTE_ENCRYPTION_KEY_FILE: /run/secrets/emremote_key
    secrets: [emremote_key]
secrets:
  emremote_key:
    file: ./secrets/emremote_key   # chmod 600; contains the output of: openssl rand -base64 32
```

For the database, set `POSTGRES_PASSWORD_FILE` on the `postgres` service the same way and point
`EMREMOTE_DATABASE_URL_FILE` at a file holding the full connection URL.

### Audit log size

The audit log is kept in the database. By default the oldest entries are removed beyond one million.
Set `EMREMOTE_AUDIT_RETENTION_DAYS` (delete entries older than that many days, `0` = no age limit) and
`EMREMOTE_AUDIT_MAX_ENTRIES` in `.env` to change it. Cleanup runs at start and every six hours, and
Settings → System shows the active limits.

### "The database looks empty"

emremote keeps a small marker in its own Docker volume (`state`) once the first account exists. If it
later finds no accounts but the marker is there, it does **not** offer first-time setup. It shows this
message instead, because the likely cause is a data folder that is not mounted (for example a changed
`EMREMOTE_DATA_DIR`, or a different folder). Otherwise anyone who reached the page could put a new
administrator on top of an empty database. Fix the mount and run `docker compose up -d`. To start over
on purpose, set `EMREMOTE_ALLOW_EMPTY_DATABASE=true` in `.env` and restart (remove it afterwards).
The check is tied to the Compose project name, so it does not notice a copy installed under another name.

### Trusting the local certificate authority

With `EMREMOTE_TLS=internal`, Caddy issues certificates from its own CA. That CA is created on first
start and stored in `data/caddy/data/caddy/pki/authorities/local/`. To stop browser warnings, install
its **root** certificate on each client:

```bash
# On the emremote host
cat data/caddy/data/caddy/pki/authorities/local/root.crt
```

- **Windows:** double-click `root.crt` → Install Certificate → Local Machine → "Trusted Root Certification Authorities".
- **macOS:** open it in Keychain Access → System keychain → set "Always Trust".
- **Linux (Debian/Ubuntu):** `sudo cp root.crt /usr/local/share/ca-certificates/emremote.crt && sudo update-ca-certificates`.
  Firefox has its own store: Settings → Privacy & Security → Certificates → Import.
- **iOS/Android:** install the profile/certificate and enable full trust in settings.

The root CA's private key never leaves `data/caddy`. Protect that directory and include it in backups.

If you have a publicly resolvable domain (for example via DNS-01 with your own Caddy build), you can
set `EMREMOTE_TLS` to your e-mail address and use ACME instead.

### Using your own reverse proxy

If you already run a reverse proxy (Traefik, nginx, Nginx Proxy Manager):

1. Remove the `caddy` service and publish emremote only on the proxy's network.
2. Your proxy must:
   - pass `Host` unchanged
   - support WebSockets on `/api/tunnel` with no read timeout
   - set `X-Forwarded-For`
3. Set `EMREMOTE_TRUSTED_PROXIES` (emremote's environment) to the proxy's IP or subnet. Only those
   addresses may set the client IP.
4. Keep `EMREMOTE_COOKIE_SECURE=true` and terminate HTTPS at the proxy.

## Upgrading

Administrators see **Update available** in the sidebar when GitHub has a newer release. emremote asks
`api.github.com` for the latest release every hour (no data about your install is sent); set
`EMREMOTE_UPDATE_CHECK=false` to turn it off, for example on a host without internet access.

### Updating from the interface (optional)

Clicking **Update available** opens a window with the release notes. With the optional **updater** turned on it
also has an **Update now** button: emremote backs up the database, downloads the new image, restarts, waits until
it is healthy (and goes back to the old version if it is not), and the page reloads at the sign-in screen.
Everyone has to sign in again after an update, because saved passwords are locked whenever emremote restarts.

Turn it on by adding this line to `.env`, then start it:

```bash
echo 'COMPOSE_PROFILES=updater' >> .env
docker compose up -d
```

Be aware of what this is: the updater container holds the **Docker socket**, which is root-equivalent on the
host. It is kept as small as possible (no network, read-only filesystem, no capabilities except writing to its
state folder, one fixed script) and emremote itself never gets the socket: the application only creates a request
file, the updater reacts to the file and runs the same fixed steps every time. Nothing from the application is used
as a command or an argument. If you do not want that trade-off, leave the profile off and use `scripts/update.sh`
on the server, which does the same steps by hand.

What it does not do: it does not change `compose.yaml` (new options arrive with `scripts/update.sh` or a new
download, the release notes say so), and it follows the image tag in `.env`: with `EMREMOTE_IMAGE_TAG` pinned to a
version it only repeats that version. Database backups it makes are kept in `backups/` (the newest five).

Image versions are pinned in `compose.yaml` and `app/Dockerfile`.

1. Back up first: `scripts/backup.sh`.
2. Read the release notes of the component you are upgrading:
   [guacd](https://guacamole.apache.org/releases/), PostgreSQL minor releases, Caddy, Go and Node
   base images.
3. Change the tag, then `docker compose up -d --build`. Database migrations run automatically at
   startup, guarded by an advisory lock.
4. **PostgreSQL major upgrades** (e.g. 17 → 18) need a dump and restore: back up, stop the stack,
   move `data/postgres` aside, change the image, start, then run `scripts/restore.sh`.
5. When upgrading guacd, also upgrade the bundled JavaScript client in
   `app/frontend/public/vendor/guacamole-common-js` to the same version. Download it from the
   [official source release](https://archive.apache.org/dist/guacamole/), verify the checksum and
   concatenate `guacamole-common-js/src/main/webapp/modules/*.js` in alphabetical order.

## Backup and restore

```bash
scripts/backup.sh                 # → backups/emremote-db-<ts>.dump and emremote-caddy-<ts>.tar.gz
scripts/restore.sh backups/emremote-db-<ts>.dump
```

- Files in the RDP transfer drive live in `data/transfer/`. Back that folder up as well if you keep
  files there.
- A restored dump unlocks with the sign-in password that was valid **when the dump was taken**.
- The dump contains the inventory, audit log and **encrypted** secrets. `.env` (with
  `EMREMOTE_ENCRYPTION_KEY`) is deliberately **not** included. Keep it separately, for example in a
  password manager. Anyone holding both the dump and the key can decrypt stored passwords.
- To restore on a new host, copy the repository and your `.env`, extract the Caddy archive into
  `data/caddy/` (this keeps the same CA, so clients stay trusted), run `docker compose up -d`, then
  run `scripts/restore.sh`.
- For automatic backups, schedule `scripts/backup.sh` with cron or a systemd timer, and copy the
  results off the host. Proxmox Backup Server snapshots of the LXC also work; prefer stopping the
  stack or using the dump for a consistent database copy.

Restore was tested end to end: a deleted device and its encrypted RDP password came back and could
be used to start a session.

## Account recovery

If you forget the administrator password:

```bash
docker compose exec emremote /app/emremote reset-password admin
```

This prints a new random password once, signs out all of that user's sessions and records the
reset in the audit log. Administrators can reset other users' passwords under **Users**.

If you only lost the authenticator app (the password is fine), turn two-factor off for that user without
touching the password or the saved passwords:

```bash
docker compose exec emremote /app/emremote reset-2fa <username>
```

The user is signed out and signs in with the password alone; recovery codes and administrators resetting
it under **Users** are the other ways (see [USERS.md](USERS.md#two-factor-authentication)).

Saved connection passwords are protected by the sign-in password (see SECURITY.md), so they cannot
survive a forgotten password. The command refuses to run until you confirm with
`--forget-saved-passwords`; the saved secrets are then deleted, and connections ask for credentials
until you save them again. Restart emremote afterwards.

### After a restart

Saved passwords are locked whenever emremote starts. Everyone is signed out and the sign-in page
says why; signing in unlocks them again.

## Operations

| Task | Command |
|---|---|
| Status | `docker compose ps` |
| Logs | `docker compose logs -f emremote guacd` |
| Restart | `docker compose restart` |
| Stop | `docker compose down` (data is kept in `data/`) |
| Rebuild after code change | `docker compose up -d --build emremote` |

Container logs are rotated (`json-file`, 3 × 10 MB per service). Application logs never contain
passwords, session tokens or tunnel tickets.
