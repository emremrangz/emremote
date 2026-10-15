# Development

## Layout

```
compose.yaml            production stack (caddy, emremote, guacd, postgres)
.env.example            configuration template
deploy/Caddyfile        reverse proxy / TLS
app/Dockerfile          multi-stage build: web UI → Go binary → distroless runtime
app/backend/            Go module (API, tunnel, migrations)
app/frontend/           React + TypeScript + Vite UI
scripts/                backup.sh, restore.sh
tests/e2e/              end-to-end tests (API + tunnel, real browser)
tests/targets/          disposable RDP/VNC/SSH test server (for tests only)
docs/                   documentation
```

The host does not need Go or Node. Everything builds in containers. To develop locally with
toolchains installed:

### Backend

```bash
cd app/backend
go test ./...
go vet ./...
# Run against a local database and guacd:
docker run -d --name dev-pg -e POSTGRES_PASSWORD=dev -p 127.0.0.1:5432:5432 postgres:17.11-alpine3.24
docker run -d --name dev-guacd -p 127.0.0.1:4822:4822 guacamole/guacd:1.6.0
EMREMOTE_DATABASE_URL=postgres://postgres:dev@127.0.0.1:5432/postgres?sslmode=disable \
EMREMOTE_ENCRYPTION_KEY=$(openssl rand -base64 32) \
EMREMOTE_GUACD_ADDR=127.0.0.1:4822 EMREMOTE_COOKIE_SECURE=false \
EMREMOTE_WEB_DIR=../frontend/dist go run ./cmd/emremote
```

With guacd in Docker and targets on your LAN, keep the default allowed networks. Container networks
are denied automatically.

### Frontend

```bash
cd app/frontend
npm install -g npm@11.19.1   # npm 10 cannot resolve vitest 4's optional peers
npm ci
npm run dev                  # http://localhost:5173, proxies /api to localhost:8080
npm run typecheck && npm test && npm run build
```

Use `EMREMOTE_COOKIE_SECURE=false` only for plain-HTTP development on `localhost`.

Without a toolchain, the same checks run inside Docker:

```bash
docker run --rm -v "$PWD/app/backend":/src -w /src golang:1.26.9-alpine3.24 go test ./...
docker run --rm -v "$PWD/app/frontend":/app -w /app node:22.23.3-alpine3.24 \
  sh -c 'npm i -g npm@11.19.1 && npm ci && npm run typecheck && npm test'
```

The production image build (`docker compose build`) also runs `go vet`, the Go tests, the TypeScript
check and the frontend tests, and fails if any of them fail.

## Tests

| Suite | What it covers | How to run |
|---|---|---|
| Go unit tests | Protocol parser (Unicode / chunking), network policy and SSRF rules, AES-GCM row binding, Argon2id, rate limiter, settings validation and guacd parameter mapping, origin checks, trusted-proxy IP resolution, static path traversal | `go test ./...` |
| Frontend unit tests | Formatting, reachability semantics, status messages | `npm test` |
| `tests/e2e/smoke.mjs` | over 220 checks against a running stack, including jump hosts (SSH, RDP and VNC sessions through a bastion, validation, policy, pinning through the tunnel), two-factor sign-in, import and export, snippets, terminal appearance, multi-user access (teams, member visibility, private inventories, 403/404 boundaries, saved passwords for members, access changes closing live sessions, password reset, disabling, deleting with and without keeping inventory),  server-to-server copies (byte-identical both ways, skip/overwrite, into-itself refusal, session binding), quick connections (live SSH and RDP sessions, nothing saved, policy, session binding), SFTP upload/download byte-equality, overwrite protection, rename, zip download, recursive delete, session binding, host-key enforcement, the system overview and audit coverage. Also covered: setup/login, CSRF, origin, rate limit, address validation, secrets never returned, RDP certificate rejection, pinning and downgrade prevention, SSH host key pinning and mismatch, reachability, **live SSH/VNC/RDP sessions streaming frames through guacd**, single-use tickets, SSRF refusals, foreign-origin WebSocket refusal, audit completeness and secret-freedom, cleanup | see header of the file |
| `tests/e2e/browser.mjs` | Real Chromium via Playwright (90+ checks): the workspace (tabs, split panes, no keyboard cross-talk), jump host form and session, two-factor login, import dialog, snippets, terminal themes, the SFTP transfer page (copy between two servers), Quick connect from Overview, System and Files tabs (create folder, upload, delete), the SFTP panel in the SSH session window, UI sign-in, device form, RDP certificate pin flow, live RDP/SSH/VNC sessions rendering pixels, typing into the remote desktop, live resize, VNC scaling, HiDPI modes, disconnect state, console errors, screenshots | see header of the file |
| `tests/e2e/screenshots.mjs` | Creates made-up devices on a throw-away test stack, uses them and takes the README screenshots into `docs/images`. Needs the test targets and `tests/targets/fakeswitch`. Never run it against a real installation | see header of the file |

### Test targets

`tests/targets` builds a disposable container with real `xrdp` (with a self-signed TLS
certificate), `x11vnc` and `sshd`, published on host ports 13389, 15900 and 12222:

```bash
TARGET_PASSWORD=$(openssl rand -base64 12) docker compose -f tests/targets/compose.yaml up -d --build
# Jump host tests need EMREMOTE_JUMP_TARGET_NETWORKS=172.29.77.0/24 on the emremote under test:
# "inner" (172.29.77.10) is only reachable through the bastion "target" (SSH on 12222).
# … run the e2e suites with TARGET_HOST=<host LAN IP> …
docker compose -f tests/targets/compose.yaml down --rmi local
```

It exposes password-protected remote-access services on the LAN. **Stop it when you are done.**

BusyBox `telnetd` in the target mishandles carriage returns in character mode, so Telnet *automatic
sign-in* is verified against `tests/targets/fake-switch.py`, a switch-style server that checks the
credentials and logs every command it receives. Create a Telnet connection to it (port 12325) with a
saved credential `tester` / `s3cret` and the username pattern `[Uu]sername:`, open a session and type
a command. The server log then shows `LOGIN ... SUCCESS` and `COMMAND '...'`.

## Conventions

- Go: standard library HTTP routing (Go 1.22+ patterns), `log/slog`, no ORM, parameterised SQL.
  Every new endpoint goes through `requireAuth` unless it is part of setup or login.
- New guacd parameters: add a typed field to the protocol's settings struct, validate it in
  `normalizeSettings`, map it in `buildGuacdParams`, and add a test.
- Migrations: add `internal/db/migrations/NNNN_description.sql`. Never edit a migration that has
  been released.
- Never log or return secrets; audit details must not contain them. The e2e smoke test checks this.
