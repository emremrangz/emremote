# Troubleshooting

Start with:

```bash
docker compose ps
docker compose logs --tail=100 emremote guacd caddy
```

Settings → System in the UI shows whether the gateway (guacd) is reachable and which target networks
are allowed.

## Web UI

| Symptom | Cause / fix |
|---|---|
| Browser: `ERR_SSL_PROTOCOL_ERROR` or "internal error" when browsing by IP | Set `EMREMOTE_DEFAULT_SNI` to that IP in `.env`, then run `docker compose up -d caddy`. Also make sure `EMREMOTE_SITE_ADDRESS` contains that IP. |
| Certificate warning | Expected until Caddy's local root CA is trusted on the client. See [DEPLOYMENT.md](DEPLOYMENT.md#trusting-the-local-certificate-authority). |
| Login keeps returning to the sign-in page | The cookie is `Secure`, so you must use `https://`. If you run behind your own TLS proxy, it must forward `Host` unchanged. |
| "Too many failed attempts" | Wait 15 minutes, or restart emremote (the limiter is in memory). |
| "emremote was restarted. Sign in again to unlock saved passwords." | Expected after every restart: saved passwords are locked until you sign in. |
| "Your password is correct, but saved passwords could not be unlocked" | `EMREMOTE_ENCRYPTION_KEY` in `.env` differs from the one used when the vault was created. Restore the original key. If it is lost: `docker compose exec emremote /app/emremote reset-password <user> --forget-saved-passwords`. |
| A member sees no devices | They were given none. Edit them under **Users** and choose "Everything shared" or select devices, or let them add their own (permission "Manage own devices"). |
| A member cannot sign in after a restart ("saved-password key is missing") | Their key was removed by an offline reset. Any other user signs in once, then they can. |
| Connect opens in the same tab instead of a new window | The browser blocked the pop-up. Allow pop-ups for emremote; the workspace window then opens and collects all your sessions as tabs. |
| "The jump host refused to forward the connection" | The bastion's SSH server has TCP forwarding turned off. Set `AllowTcpForwarding yes` in its `sshd_config` and reload sshd. |
| The Wake button does nothing | Wake-on-LAN must be enabled on the device and its broadcast has to reach the LAN. Enter the network's broadcast address in the device's More details, and check the BIOS/UEFI and network card wake settings. |
| A shared-session link says it has ended | The owner stopped sharing, two hours passed, or the session ended. Ask for a new link. |
| Lost the phone with the authenticator app | Use a recovery code on the login screen's code line. If you have none, an administrator resets it under Users, or run `reset-2fa <user>` on the host (`docker compose exec emremote /app/emremote reset-2fa <user>`). |
| "That code is not valid" with the right app | The phone's clock is off by more than about 30 seconds, or the code was already used (wait for the next one). |
| Forgot the password | `docker compose exec emremote /app/emremote reset-password admin` |
| First-time setup says "only offered to computers on a private network" | You opened emremote from a public address (or through a proxy that hides your real address). Open it from your local network, or set `EMREMOTE_SETUP_TOKEN` in `.env`, restart, and enter that token on the setup screen. |
| `no configuration file provided: not found` | You ran `docker compose` outside the emremote folder. Run `cd emremote` first (the folder that contains `compose.yaml`). |
| `port is already allocated` / `address already in use` | Another service owns port 80 or 443. Set `EMREMOTE_HTTPS_PORT` and `EMREMOTE_HTTP_PORT` in `.env` to free ports (for example 8443 and 8088), then `docker compose up -d`, and open `https://<address>:<https port>`. `scripts/init-env.sh` does this automatically for a new install. |
| `emremote` unhealthy at start | Usually the database is still starting, or `EMREMOTE_ENCRYPTION_KEY` is invalid. The log says which. The key must decode to exactly 32 bytes (`openssl rand -base64 32`). |

## Sessions

| Message in the session window | Likely cause |
|---|---|
| "This target is blocked by the server's network policy" | The device address resolves outside `EMREMOTE_ALLOWED_TARGET_NETWORKS`, or into a denied range such as loopback or a container network. Adjust `.env` and restart. |
| "SSL/TLS connection failed (untrusted/self-signed certificate?)" (RDP) | The certificate changed since the first connection (Windows renews it yearly). Settings → Security → Fetch certificate → Trust this certificate. |
| "The remote computer could not be reached" | Port closed or filtered, computer asleep, or Remote Desktop / Screen Sharing / sshd not enabled. Check the device's reachability from its page (**⋯ → Check reachability now**). |
| "Authentication failed" | Wrong username, password or domain. For Microsoft accounts use the e-mail address and password, not the PIN. Check that Windows Hello-only sign-in is off. |
| "The remote computer reported an error" (RDP) | Often NLA with missing credentials, or a security mode the server does not accept. Try *Negotiate*, or let the session prompt for credentials. |
| Session stays on "Connecting…" (VNC) | The VNC server rejected the protocol version or authentication. On macOS, enable "VNC viewers may control screen with password". |
| "Aborted. See logs." (SSH), or "host key has changed" | The host key changed since the first connection, usually after a reinstall. Settings → Host key → Fetch host key → Trust this key. |
| Wrong characters when typing (RDP) | The keyboard layout given to the remote computer must match **its** input language. Automatic uses this computer's layout, which works when both sides use the same one (e.g. Turkish Q). If a server uses another input language, pick it in the session toolbar (display menu → Keyboard); the choice is saved per connection. "Unicode fallback" sends characters instead of keys, which works on Windows but not on every server (e.g. xrdp). |
| Remote desktop does not resize with the window | VNC never resizes; it is scaled. For RDP on older Windows, set "When the browser window resizes" to *Reconnect*. |
| Blurry text on a Retina/4K screen | Session toolbar → Display → **Native pixel density**, then raise display scaling on the remote computer. |
| Esc or Win/⌘ keys are taken by the browser | Use **Fullscreen**: Chromium-based browsers then lock the keyboard for the remote session. Or use the toolbar keys (Esc, Win, CAD, held Ctrl/Alt/Shift/Win). |
| Right-click → Paste on the remote side pastes old text | Firefox and Safari never let a page read the clipboard on a right-click, and Chrome does so only after you allow it once. Press Ctrl+V (⌘V) instead: it always pastes your current clipboard, and right-click pastes that text afterwards. |
| Paste does nothing on a sign-in screen | Those screens have no clipboard. Open the clipboard panel, enter the text and press **Type it**. |
| No audio | Browsers start audio only after you interact with the page. Also check "Play remote audio" in the RDP advanced settings. |

To see more detail, raise the log levels in `.env` (`GUACD_LOG_LEVEL=debug`,
`EMREMOTE_LOG_LEVEL=debug`) and run `docker compose up -d`.

## Reachability shows "Not reachable" but the session works

The probe runs from the emremote container, and sessions run from the guacd container. Both use the
same egress network, so they should agree. If they disagree, check for host firewall rules that
treat the two containers differently, and remember that probes time out after 3 s.

## Database

```bash
docker compose exec postgres psql -U emremote -d emremote -c '\dt'
docker compose exec postgres psql -U emremote -d emremote -c 'select version, name, applied_at from schema_migrations'
```

## Starting completely fresh

This deletes all data:

```bash
docker compose down
rm -rf data/postgres          # keep data/caddy to keep the same local CA
docker compose up -d
```
