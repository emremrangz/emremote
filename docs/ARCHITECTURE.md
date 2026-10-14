# Architecture

## Components

```
┌──────────────┐  HTTPS / WSS  ┌───────┐  HTTP / WS   ┌────────────────────────────────────┐
│   Browser    │──────────────▶│ caddy │─────────────▶│ emremote (Go, single binary)       │
│ React UI     │               └───────┘  edge net    │  • REST API (/api/*)               │
│ guacamole-   │                                      │  • auth, sessions, CSRF, audit     │
│ common-js    │                                      │  • network policy (SSRF boundary)  │
└──────────────┘                                      │  • reachability prober             │
                                                      │  • Guacamole WebSocket tunnel      │
                                                      │  • static UI (/app/web)            │
                                                      └──────┬──────────────┬──────────────┘
                                                core net     │ SQL          │ Guacamole protocol (TCP 4822)
                                                (internal)   ▼              ▼
                                                      ┌───────────┐  ┌──────────────┐ egress net
                                                      │ PostgreSQL│  │    guacd     │─────────────▶ RDP / VNC / SSH
                                                      └───────────┘  └──────────────┘               targets on the LAN
```

### Why guacd plus our own tunnel, instead of the full Guacamole web application

Apache Guacamole has two parts: `guacd`, the protocol gateway written in C, and the Java/Tomcat web
application, which includes its own users, connections and UI. emremote uses the **gateway and the
official JavaScript client** and replaces the Java web application with a small Go service. That
service speaks the [documented Guacamole protocol](https://guacamole.apache.org/doc/gug/guacamole-protocol.html)
to guacd. This is the integration path the Guacamole manual describes for custom applications.

Reasons:

- **One source of truth.** Users, devices, credentials and audit live in emremote's database. The
  Java application would bring a second user and connection model that has to be kept in sync.
- **Secrets stay server-side.** emremote decrypts credentials and passes them to guacd during the
  handshake. They never reach the browser and never pass through another web application.
- **Footprint.** Tomcat needs about 400–600 MB of RAM. The whole emremote stack idles at about
  210 MB, which matters on a 2 GB LXC.
- **Licensing.** guacd and guacamole-common-js are Apache-2.0. Both are used unmodified.

The trade-off: features the Java application provides, such as session recording playback, file
browser UI, sharing profiles and LDAP, are not available until emremote implements them.

## Request flow: launching a session

1. The browser opens `/connect/<connection-id>` in a new tab. The React session page lazily loads the
   vendored `guacamole-common-js` 1.6.0.
2. `POST /api/connections/{id}/sessions` sends the viewport size, DPI, supported image and audio
   types, and the time zone. It is authenticated and CSRF-protected. The server:
   - resolves the device address and checks every resolved IP against the network policy
   - decrypts the connection's or credential's secrets
   - builds the guacd parameter map from the protocol settings, using a whitelist of parameters
   - stores everything in a **one-time ticket** (30 s, bound to the browser session) and returns
     only the ticket ID.
3. The browser opens `wss://…/api/tunnel?ticket=…` (subprotocol `guacamole`). The server checks the
   origin, the session cookie and the ticket, then dials guacd and performs the handshake:
   `select` → `args` → `size`/`audio`/`video`/`image`/`timezone` → `connect` → `ready`.
4. The server sends the tunnel UUID to the browser and relays instructions in both directions:
   - **guacd → browser:** whole instructions, batched, never split.
   - **browser → guacd:** only input-type opcodes. Internal `ping` messages are answered.
5. On close, `session.end` is audited with duration, who closed it and any gateway error. Logout,
   password change, device or connection deletion, an expired browser session or an admin
   "Terminate" cancel the tunnel.

## File manager and system overview

These features do not go through guacd. emremote opens its own SSH connection (`internal/sshhelper`),
which must verify against the pinned host key. It holds that connection as an **access session** tied
to the browser session: `POST /api/connections/{id}/ssh-access`, then `/api/ssh-access/{aid}/files…`
and `/api/ssh-access/{aid}/system`.

- Files use SFTP: list, streamed download (directories as zip), streamed upload, mkdir, rename and
  recursive delete.
- The system overview runs one of three fixed scripts, chosen by `uname`/PowerShell detection, and
  parses the result into a common JSON shape.

### Server-to-server copies

`POST /api/copy-jobs` takes a source and a destination endpoint (`{kind:"ssh", access_id}` or
`{kind:"drive", device_id}`), the selected paths, a target folder and `on_conflict`
(`skip`|`overwrite`). A background job (`internal/api/copy.go`) walks the selection (symlinks are
skipped), creates folders and streams each file with `io.Copy` from one endpoint to the other.
`GET /api/copy-jobs` reports progress; `DELETE /api/copy-jobs/{id}` cancels. Jobs live in memory,
belong to the browser session and are forgotten an hour after they finish.

## Quick connections

`POST /api/quick-connections` validates a connection like a saved one (plus `host`), checks the
network policy and stores it **in memory** (`internal/api/quick.go`) under an id starting with `q_`.
`POST /api/quick-connections/{id}/sessions` issues a tunnel ticket through the same code path as
saved connections (`issueTicket`), with identity pinning kept in memory. The session page detects
the `q_` prefix and uses these endpoints instead of `/api/connections/{id}`.

## Users and access control

`users` has a role (`admin`/`member`), direct permissions, an `inventory_mode` (`none`/`selected`/`all`)
and an optional team. `teams` carry the same fields; `access_grants` lists the shared devices and
groups granted to a user or team. `devices`, `device_groups` and `credentials` have an `owner_id`
(NULL = shared). Visibility lives in two SQL functions, `emr_visible_devices(uid)` and
`emr_visible_groups(uid)`; list queries filter with them. Route guards in `internal/api/access.go`
(`dev`, `conn`, `group`, `credential`, `withPerm`, `adminOnly`) run before handlers, so a handler
only sees requests that are already authorised. Favorites and last-opened times are per user
(`device_user_state`). Each user has a `vault_keys` row: the same data key wrapped with their own
password.

## Backend layout (`app/backend`)

| Package | Responsibility |
|---|---|
| `cmd/emremote` | Entry point; `healthcheck` and `reset-password` subcommands |
| `internal/config` | Environment configuration and validation |
| `internal/db` | pgx pool and embedded, versioned SQL migrations (advisory-locked) |
| `internal/store` | Persistence: users, sessions, groups, devices, connections, credentials, audit, dashboard |
| `internal/secrets` | AES-256-GCM sealing of credential material with per-row associated data |
| `internal/auth` | Argon2id, tokens, login rate limiter |
| `internal/netpolicy` | Address validation and the allowed/denied network policy |
| `internal/guac` | Guacamole protocol parser/encoder, handshake, WebSocket proxy |
| `internal/rdpcert` | X.224/TLS negotiation that retrieves an RDP certificate for pinning |
| `internal/sshkey` | SSH key exchange that retrieves a host key for pinning |
| `internal/status` | Periodic TCP reachability prober |
| `internal/sshhelper` | Server-side SSH client (pinned host key required): SFTP file operations, zip streaming, fixed read-only system inspection scripts and their parsers |
| `internal/api` | HTTP handlers, middleware (auth, CSRF, origin, security headers), validation, protocol settings → guacd parameters |

Handlers validate input, call the store, and map errors to JSON responses of the form
`{"error": {"code", "message", "fields"}}`. All SQL is parameterised.

## Data model

```
users ─┬─< sessions
       └─(actor)─< audit_events
device_groups ─< devices ─< connections >─ credentials
```

- `connections.settings` (JSONB) holds normalized, validated protocol settings. Every field maps to a
  guacd 1.6 parameter.
- `connections.secret_enc` and `credentials.secret_enc` hold the AES-GCM sealed JSON
  `{password, private_key, passphrase}`. `secret_fields` lists which fields are present, so the API
  can report that without decrypting anything.
- `connections.status_*` holds the last reachability probe result.
- `users.role` exists (only `admin` today), so RBAC can be added without a schema rewrite.

## Frontend layout (`app/frontend`)

React 18, TypeScript, Vite, Tailwind CSS, TanStack Query, React Router, plus Radix primitives for
dialogs and menus.

- `src/pages`: Overview, Devices (also Favorites), DeviceDetail, Connections (+ Credentials),
  Activity, Settings, Session.
- `src/components`: forms (device, connection, credential, groups), status and OS indicators, UI
  primitives.
- `src/lib`: API client (cookies + CSRF), auth context, theme, Guacamole loader and helpers.
- `public/vendor/guacamole-common-js`: the official 1.6.0 client, concatenated in upstream order and
  otherwise unmodified, with its LICENSE and NOTICE.

## Extension points

- **Optional agent (future).** Device status already comes from a single place
  (`connections.status_*`, written by `internal/status`). An agent would be one more status source,
  for example a `device_heartbeats` table and an authenticated `/api/agent/*` endpoint group. It
  would not change the UI contract (`status_reachable`, `status_detail`). Agent-based features such as
  Wake-on-LAN relaying or presence detection would be new endpoints. Remote access stays protocol
  based.
- **Multiple users / RBAC.** Add roles to `users.role` and a permission check in `requireAuth`, plus
  an owner or ACL table for devices.
- **More protocols.** guacd also supports Telnet and Kubernetes. Add the protocol to the CHECK
  constraint, `normalizeSettings` and `buildGuacdParams`.
- **Session recording.** guacd can record sessions (`recording-path`). This would need a volume and a
  playback UI.
