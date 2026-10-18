# Security

emremote holds the keys to other computers. This document describes what the first release
protects against, what it assumes, and where its limits are.

## Trust assumptions

1. **The host is trusted.** Anyone with root on the emremote host, or with access to Docker on it,
   can read `.env` (the encryption key) and the database, and can therefore decrypt every stored
   credential. Protect the host like a password vault.
2. **The network is a trusted home or lab LAN.** emremote is **not** intended to be exposed directly
   to the internet. For remote use, put it behind a VPN (WireGuard, Tailscale) or an authenticating
   reverse proxy with MFA.
3. **Administrators are fully trusted.** An administrator can manage every user and the whole shared
   inventory, and can set other users' passwords. Members only get what they are granted
   (see [USERS.md](USERS.md)).
4. **Target computers are configured sensibly**: firewall, strong passwords, NLA on Windows.
   emremote cannot make an insecure service secure.

## Threat model

| Threat | Mitigation |
|---|---|
| Password guessing against the UI | Argon2id hashing (64 MiB, t=3). Rate limit of 5 failures per username and 20 per IP per 15 minutes (HTTP 429), constant-time comparisons, a dummy hash for unknown users (no username enumeration via timing). Minimum password length is 8. |
| Someone claiming a fresh install | First-run setup creates the administrator without a secret, so it is only offered to private-network addresses (RFC 1918, unique-local, loopback, link-local, 100.64.0.0/10) and is closed for good once the account exists. Anyone on that LAN who gets there first could claim an instance that was just started, so create the account right away. Set `EMREMOTE_SETUP_TOKEN` to require a token from anywhere; do that if the instance is reachable from outside. |
| First-run setup on an emptied database | If the database later has no accounts but a marker in the `state` volume says the server was set up before, setup is refused (HTTP 409 and a warning screen) instead of letting a stranger create a new administrator. `EMREMOTE_ALLOW_EMPTY_DATABASE=true` switches this off on purpose. |
| Secrets sitting in `.env` or the process environment | The encryption key, database URL and setup token can be read from files (`*_FILE`), for example Docker secrets, see [DEPLOYMENT.md](DEPLOYMENT.md#secrets-from-files-docker-secrets). |
| Unbounded audit log | Entries older than `EMREMOTE_AUDIT_RETENTION_DAYS` and entries beyond `EMREMOTE_AUDIT_MAX_ENTRIES` (default one million) are removed every six hours. |
| Information on the sign-in screen | `GET /api/about` is public and returns only the version, the container runtime, the container OS name, the architecture, the Go version and the uptime of the application, never the host name, kernel, CPU, memory or addresses. `EMREMOTE_LOGIN_INFO=false` hides all of it. |
| Session theft | Random 256-bit session tokens. Only their SHA-256 hash is stored in the database. Cookies are `__Host-` prefixed, `Secure`, `HttpOnly` and `SameSite=Strict`. Sessions have a 12 h absolute lifetime and a 2 h idle timeout (configurable). A person can answer "yes" to **remember me** on the sign-in screen: that session lasts `EMREMOTE_REMEMBER_DAYS` days (default 30, at most 7 days unused; `0` removes the option) and needs the same cookie protections; it is not offered for shared computers and is gone after a restart like every other session. Logout and password changes revoke sessions and close their remote sessions. |
| CSRF | Per-session CSRF token required on every state-changing request, plus a same-origin `Origin` check and the SameSite=Strict cookie. JSON-only APIs (`Content-Type` enforced). |
| Cross-site WebSocket hijacking | The tunnel requires a same-origin `Origin` header, a valid session cookie **and** a one-time ticket. The ticket expires after 30 s, can be used once, and is bound to the browser session that created it. |
| XSS | React escaping and a strict CSP: `script-src 'self'`, no inline scripts, `object-src 'none'`, `frame-ancestors 'none'`. `style-src` allows inline styles, which React style attributes and the Guacamole display need. `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: no-referrer`. |
| Credential disclosure via API | Secrets are write-only. Responses only say which fields exist (`secret_fields`). Secrets are decrypted server-side when a session starts and handed straight to guacd. |
| Credential disclosure at rest | **Password vault.** Saved connection passwords and keys cannot be *hashed*: emremote has to send them to the remote computer, and a hash cannot be turned back into a password. That is why every remote-access tool encrypts them instead. emremote encrypts them with AES-256-GCM under a random 256-bit data key, which is stored only wrapped. The wrapping key is derived from the administrator's **sign-in password** (Argon2id, 64 MiB, t=3) combined with `EMREMOTE_ENCRYPTION_KEY`. The unwrapped key exists only in memory, after a successful sign-in. A copy of the database together with `.env` therefore does **not** reveal saved passwords without the sign-in password. Each ciphertext is also bound to its row (associated data). The sign-in password itself is stored only as an Argon2id hash. |
| Secrets in logs | Passwords, tokens, cookies and tunnel tickets are never logged. Request logs contain paths without query strings. The reverse proxy has no access log. The audit log stores usernames and targets, never secrets. |
| **SSRF / using emremote as a pivot** | Sessions target configured devices or, with **Quick connect**, a host an authenticated user types in. There is no URL-fetching proxy. Addresses must be bare IPs or hostnames, and quick connections are subject to exactly the same policy as devices. Every connection, reachability probe and certificate/host-key fetch resolves the address and checks it against the network policy (below). The **resolved IP** is then passed to guacd, which prevents DNS rebinding between check and use. |
| Man-in-the-middle on RDP | **Trust on first use.** On the first connection emremote records the server's certificate fingerprint and locks the security layer to the negotiated TLS/NLA mode, so the connection cannot later be downgraded to certificate-less legacy RDP. Every later connection must present the same certificate, or it is refused. A pin can be reviewed or replaced in the connection's Security settings. "Accept any certificate" exists but is off by default and shows a warning. |
| Man-in-the-middle on SSH | **Trust on first use**, like OpenSSH's `accept-new`. The host key is recorded on the first terminal session or file access, and a changed key is refused, both by guacd and by emremote's own SSH client. |
| Malicious instructions from the browser | The tunnel forwards only the input-related Guacamole instructions (key, mouse, size, clipboard, …). Handshake parameters are set server-side and cannot be changed by the client. Drive mapping, printing, microphone and RemoteApp are per-connection settings chosen by the connection's owner (printing, microphone and RemoteApp are off by default); the SSH `command` parameter is never exposed. |
| emremote connecting to impostor SSH servers (files / system overview) | emremote's own SSH client always verifies against the recorded host key (recorded on first use if missing), restricting the negotiated algorithm to the pinned key's type. A changed key is refused with a clear message. |
| Arbitrary command execution via system overview | Only three fixed, read-only scripts (Linux, macOS, Windows) can run. No request parameter reaches a command line. Output is size-limited (512 KB) and time-limited (25 s). |
| Misuse of file access | File/system sessions are bound to the browser session that opened them (other sessions get 410), expire after 10 minutes idle and 1 hour total, close on sign-out, password change and connection or device deletion, and are limited to 6 per browser session. Remote permissions are those of the configured account. Every upload, download, rename, mkdir and delete is audited with its path and size, never its content. Uploads are size-capped (`EMREMOTE_MAX_UPLOAD_MB`) and do not overwrite existing files unless you confirm. |
| RDP transfer drive | A per-device folder on the emremote host is redirected into RDP sessions (it can be disabled per connection). The remote computer can read and write only that folder. emremote's access is confined to it: no `..` escapes and symlinks are refused. Uploads are size-capped. The folder is stored under `data/transfer` and is included in disk usage, so watch free space. |
| Automatic SSH discovery | Only probes the device's own configured address on one port (`EMREMOTE_AUTO_SSH_PORT`) and only when you open its System or Files tab. It tries the sign-in already saved for that device, once, and creates nothing if that fails. |
| Quick connect | The target and its password are held only in server memory, bound to the browser session that created them (other sessions get 404), never returned by the API, and dropped after 12 h unused, on sign-out and on restart. Creation is audited (`connection.quick`, without secrets); sessions are audited like any other. The identity pinned on first connect cannot be changed through the API for the rest of that quick connection. |
| Server-to-server copies | Both ends must be file sessions opened by the same browser session (or RDP transfer drives, confined as above). Data is streamed, never stored on the emremote host. Symbolic links are skipped. Copies are cancelled on sign-out and each one is audited with source, destination, file count and size. |
| Stolen or guessed password | Optional **two-factor authentication** (TOTP, RFC 6238). The sign-in is two requests: the password check returns a short-lived challenge (5 minutes, five tries, bound to the client address) and only a valid code creates the session. Codes are single-use (accepted time steps are recorded), failures count against the same rate limiter as passwords, and the TOTP secret is stored encrypted with the server key (it is needed before the saved-password vault unlocks). The password waits in server memory for the few minutes between the two requests, because unlocking the vault needs it; it is never written to disk or logged. Recovery codes are random, stored only as hashes and work once. Turning it off needs password and a code. |
| Using emremote to reach networks it should not (jump hosts) | Off by default: `EMREMOTE_JUMP_TARGET_NETWORKS` must list the networks behind bastions, and a device behind one must be an IP literal in those networks, never loopback, link-local or denied ranges (the usual target allow-list does not apply to them, the jump target list does). The bastion itself is an ordinary allowed target with a pinned host key and saved credentials. Only the connection owner's own bastions can be used, so a shared bastion password cannot be pointed at a host a member chooses. The tunnel to the gateway is a per-session, random-port listener bound to the one interface facing guacd, accepting only guacd's addresses and closed with the session or after 45 s unused. |
| Watching someone else's session | Sharing is opt-in per session and needs a random 256-bit link; viewers must also be signed in and allowed to open sessions. Viewers join read only at the gateway and every instruction except keep-alives is dropped by emremote, so input, clipboard and resize cannot reach the target. Links expire after two hours, die with the session, and can be revoked (which also disconnects viewers). At most five viewers per session; sharing and watching are audited. |
| Using Wake-on-LAN to probe the network | The packet is a fixed 102-byte UDP datagram to port 9, sent only to the device's own address and a broadcast address inside the allowed target networks, at most once per five seconds per device, and audited. |
| Command snippets | Personal text typed into the user's own session from the browser. The server stores but never runs it, no keystrokes are recorded, and a user cannot see another's snippets (administrators included). Multi-line snippets ask for confirmation. |
| Import and export | Exports contain no passwords, keys or saved credentials. Imports go through the same validation as the forms (address rules, settings, per-user scope), cannot carry secrets (files with unknown fields such as passwords are refused), are limited to 2000 devices and 4 MB, and are audited with counts. Exported names that look like spreadsheet formulas are neutralised. |
| One user reaching another's data | Every route is checked on the server: items a user may not see answer 404, items they may see but not change answer 403, and user management is administrators-only. Private devices, groups and saved credentials belong to one member and are invisible to everyone else, administrators included. A member cannot attach a shared credential to a device of their own, so a shared password cannot be aimed at a host they control. Access changes close the person's running remote sessions. Members' activity log shows only their own events. |
| Database or gateway exposure | PostgreSQL and guacd have no published ports and live on an internal-only Docker network. Containers run without privileges, with all capabilities dropped, `no-new-privileges` and read-only root filesystems where possible. The emremote image is distroless (no shell) and runs as non-root. The Docker socket is never mounted into the application or the database. The one exception is the optional, off-by-default `updater` container (see [DEPLOYMENT.md](DEPLOYMENT.md#updating-from-the-interface-optional)), which has no network and reacts only to a request file. |

### Target network policy (SSRF protection)

- `EMREMOTE_ALLOWED_TARGET_NETWORKS` (default: RFC 1918 ranges, `100.64.0.0/10`, `fc00::/7`) is the
  allow-list. Narrow it to the LAN segments that contain your computers.
- Always denied: loopback, unspecified, multicast and broadcast addresses, link-local addresses
  (including cloud metadata `169.254.169.254`), every network attached to the emremote container (the
  Docker networks of the database, gateway and proxy), and `EMREMOTE_DENIED_TARGET_NETWORKS`.
- The Docker host's own LAN address is reachable if it is in the allow-list, because you may want
  to manage the host itself. Add it to `EMREMOTE_DENIED_TARGET_NETWORKS` if not.

### Audit log

Recorded events:

- sign-in (success and failure, with reason), sign-out and first-run setup
- password change, CLI password reset and session revocation
- device, group, connection and credential create/update/delete, including the list of changed
  fields, such as `settings.cert_fingerprints` or `secret`
- remote session start (target, protocol, username), remote session end (duration, who closed it,
  gateway error) and administrative termination
- file/system access opened, file uploads, downloads, renames, folder creation and deletion (path
  and size only), and server-to-server copies (source, destination, file count and size)
- quick connections created (target, protocol and username)

Events are stored in PostgreSQL and cannot be edited through the UI.

## Known limitations of the first release

- **No SSO and no hardware keys.** Two-factor is TOTP only (opt-in per user, not enforceable). Use a VPN for any access from outside the LAN.
- **Coarse roles.** Two roles and five permissions; no per-connection rules, time limits or approval
  workflow. Members see only their own private items and the shared inventory they were granted.
- **Trust on first use** cannot detect an impersonator who is already present during the *very first*
  connection to a device. That is the same assumption a normal SSH client makes. For high-assurance
  machines, compare the recorded fingerprint (shown in the connection's Security settings) with the
  server once.
- **Vault trade-offs:**
  - While emremote runs, the data key is in memory, so a compromised *running* host can still read
    secrets.
  - After every restart, saved passwords stay locked until someone signs in again, so users are
    signed out.
  - With several users, every user holds their own wrapped copy of the same data key. Knowing one
    user's sign-in password (plus `.env` and the database) is therefore enough to decrypt all saved
    passwords, including other users' private ones: the vault separates users in the application, not
    cryptographically. Treat every account that can sign in as having access to that key.
  - Forgetting the only sign-in password means saved connection passwords are lost:
    `reset-password --forget-saved-passwords` deletes them. If other users exist, resetting one user's
    password deletes nothing: that user simply gets a new wrapped copy at their next sign-in, once any
    other user has signed in since the last restart.
- **Telnet is unencrypted**, including the password. It exists only for equipment without SSH and is
  marked "Unencrypted" throughout the UI.
- **VNC is unencrypted** between guacd and the target, and VNC passwords are limited to 8 characters
  by the protocol. Prefer RDP or SSH, or restrict VNC to trusted segments.
- **Remote sessions are not recorded.** Session start and end are audited, but not their content.
- **Rate limiting is in memory** and resets when the server restarts.
- **Clipboard:** clipboard text passes between your browser and the remote computer by design. Use
  the per-connection "Block copy/paste" options for sensitive machines.
- **Dependency notices:** Tailwind CSS 3 has transitive advisories (`braces`,
  `postcss-selector-parser`, both denial-of-service on crafted input). These packages run only at
  build time, on this repository's own source files, and are not part of the runtime image. Runtime
  dependencies (`npm audit --omit=dev`) and the Go module graph as called by the code (`govulncheck`)
  were clean at release time.

## Hardening checklist

- [ ] `EMREMOTE_ALLOWED_TARGET_NETWORKS` narrowed to your LAN.
- [ ] `EMREMOTE_BIND_ADDRESS` set to the LAN IP, not `0.0.0.0`, if the host has several interfaces.
- [ ] Caddy's root CA installed on clients, and certificate warnings not clicked through.
- [ ] For critical machines, recorded RDP certificate and SSH host-key fingerprints compared once with the server.
- [ ] Backups of the database and `.env` stored separately, off the host.
- [ ] The host's firewall allows only 443 (and optionally 80) from client networks.
- [ ] Remote access from outside the LAN goes through a VPN.

## Verifying a release image

Release images are signed with cosign (keyless, GitHub Actions identity) and published with provenance and an SBOM:

```
cosign verify ghcr.io/emremrangz/emremote:0.1.2 \
  --certificate-identity-regexp 'https://github.com/emremrangz/emremote/.*' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

## Reporting vulnerabilities

Please report security problems privately to the maintainers rather than opening a public issue.
