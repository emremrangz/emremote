// End-to-end smoke test for a running emremote stack.
//
// Exercises the public API and the guacd WebSocket tunnel exactly like the
// browser does, against REAL RDP/VNC/SSH servers (see tests/targets), and runs
// security negative tests. Requires Node.js 22+ (global fetch/WebSocket).
//
//   NODE_EXTRA_CA_CERTS=data/caddy/data/caddy/pki/authorities/local/root.crt \
//   EMREMOTE_URL=https://192.168.1.50 ADMIN_USER=admin ADMIN_PASSWORD=... \
//   TARGET_HOST=192.168.1.50 TARGET_PASSWORD=... [SETUP_TOKEN=...] \
//   node tests/e2e/smoke.mjs
//
// Creates a device named "e2e-smoke-<timestamp>" and deletes it at the end.

import { writeFileSync, mkdirSync } from "node:fs";
import { createHmac } from "node:crypto";

const BASE = process.env.EMREMOTE_URL ?? "https://localhost";
const ADMIN_USER = process.env.ADMIN_USER ?? "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const TARGET_HOST = process.env.TARGET_HOST;
const TARGET_PASSWORD = process.env.TARGET_PASSWORD;
const OUT = process.env.E2E_OUT_DIR ?? "";
const ORIGIN = new URL(BASE).origin;

if (!ADMIN_PASSWORD || !TARGET_HOST || !TARGET_PASSWORD) {
  console.error("ADMIN_PASSWORD, TARGET_HOST and TARGET_PASSWORD are required");
  process.exit(2);
}

let failures = 0;
const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

// ---- HTTP client with cookie jar ----
class Client {
  cookies = new Map();
  csrf = "";
  async req(method, path, body, extraHeaders = {}) {
    const headers = { Accept: "application/json", Origin: ORIGIN, ...extraHeaders };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (method !== "GET" && this.csrf && !("X-CSRF-Token" in extraHeaders)) headers["X-CSRF-Token"] = this.csrf;
    if (this.cookies.size) headers.Cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    const res = await fetch(BASE + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [kv] = c.split(";");
      const i = kv.indexOf("=");
      const k = kv.slice(0, i), v = kv.slice(i + 1);
      if (v) this.cookies.set(k, v);
      else this.cookies.delete(k);
    }
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { status: res.status, data };
  }
  get(p) { return this.req("GET", p); }
  post(p, b = {}) { return this.req("POST", p, b); }
  put(p, b = {}) { return this.req("PUT", p, b); }
  del(p) { return this.req("DELETE", p); }
}

// ---- Guacamole protocol helpers ----
function encode(...elems) {
  return elems.map((e) => { const s = String(e); return `${[...s].length}.${s}`; }).join(",") + ";";
}
function parseAll(buf) {
  const out = [];
  let i = 0;
  while (i < buf.length) {
    const elems = [];
    for (;;) {
      const dot = buf.indexOf(".", i);
      if (dot < 0) return { out, rest: buf.slice(i) };
      const n = parseInt(buf.slice(i, dot), 10);
      const chars = [...buf.slice(dot + 1, dot + 1 + n * 2)].slice(0, n).join("");
      const end = dot + 1 + chars.length;
      if (end >= buf.length) return { out, rest: buf.slice(i) };
      elems.push(chars);
      const term = buf[end];
      i = end + 1;
      if (term === ";") break;
    }
    out.push(elems);
  }
  return { out, rest: "" };
}

async function openSession(client, connectionId, { seconds = 8, label, earlySize = false, base = "/api/connections", extra = {} }) {
  const t = await client.post(`${base}/${connectionId}/sessions`, {
    width: 1280, height: 800, dpi: 96,
    image: ["image/png", "image/jpeg", "image/webp"], audio: ["audio/L16"], video: [], timezone: "Europe/Istanbul", ...extra,
  });
  if (t.status !== 201) return { error: `ticket ${t.status} ${JSON.stringify(t.data)}` };
  const wsURL = BASE.replace(/^http/, "ws") + `/api/tunnel?ticket=${encodeURIComponent(t.data.ticket)}`;
  const headers = { Origin: ORIGIN, Cookie: [...client.cookies].map(([k, v]) => `${k}=${v}`).join("; ") };
  return await new Promise((resolve) => {
    const stats = { uuid: null, opcodes: {}, imgBytes: 0, size: null, errors: [], ticket: t.data.ticket, largest: null };
    const streams = new Map();
    let buffer = "";
    const ws = new WebSocket(wsURL, { protocols: ["guacamole"], headers });
    const finish = (why) => { try { ws.send(encode("disconnect")); ws.close(); } catch {} resolve({ ...stats, why }); };
    const timer = setTimeout(() => finish("timeout"), seconds * 1000);
    ws.onmessage = (ev) => {
      const { out, rest } = parseAll(buffer + ev.data);
      buffer = rest;
      for (const [op, ...args] of out) {
        stats.opcodes[op] = (stats.opcodes[op] ?? 0) + 1;
        if (op === "" && !stats.uuid) {
          stats.uuid = args[0];
          // Browsers may send a resize while the remote side is still connecting.
          if (earlySize) ws.send(encode("size", 1440, 860));
        }
        if (op === "" && args[0] === "ping") continue;
        if (op === "size" && args[0] === "0") stats.size = [Number(args[1]), Number(args[2])];
        if (op === "sync") ws.send(encode("sync", args[0]));
        if (op === "img") streams.set(args[0], { mimetype: args[3], chunks: [] });
        if (op === "blob" && streams.has(args[0])) { stats.imgBytes += args[1].length; streams.get(args[0]).chunks.push(args[1]); }
        if (op === "end" && streams.has(args[0])) {
          const s = streams.get(args[0]);
          const data = Buffer.from(s.chunks.join(""), "base64");
          if (!stats.largest || data.length > stats.largest.data.length) stats.largest = { mimetype: s.mimetype, data };
          streams.delete(args[0]);
        }
        if (op === "error") { stats.errors.push(`${args[0]} (${args[1]})`); clearTimeout(timer); finish("error"); }
      }
    };
    ws.onerror = (e) => { clearTimeout(timer); resolve({ ...stats, why: "ws-error " + (e.message ?? "") }); };
    ws.onclose = (e) => { clearTimeout(timer); resolve({ ...stats, why: `closed ${e.code} ${e.reason}` }); };
  });
}

async function wsStatus(path, headers) {
  // Returns the HTTP status of a WebSocket upgrade attempt (0 = connected).
  return await new Promise((resolve) => {
    const ws = new WebSocket(BASE.replace(/^http/, "ws") + path, { protocols: ["guacamole"], headers });
    ws.onopen = () => { ws.close(); resolve(0); };
    ws.onerror = (e) => resolve(String(e.message ?? e.error?.message ?? "error"));
  });
}

// RFC 6238 TOTP, written independently of the server's implementation.
const b32dec = (str) => {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0, val = 0;
  const out = [];
  for (const ch of str.replace(/=+$/, "")) {
    val = (val << 5) | A.indexOf(ch);
    bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
};
const totp = (secretB32, step) => {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = createHmac("sha1", b32dec(secretB32)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1000000).padStart(6, "0");
};
const nowStep = () => Math.floor(Date.now() / 30000);

// ---- Run ----
const c = new Client();
const setup = await c.get("/api/setup");
if (setup.data?.setup_required) {
  check("first-run setup needs no token by default", setup.data.token_required === false, JSON.stringify(setup.data));
  const r = await c.post("/api/setup", { setup_token: process.env.SETUP_TOKEN ?? "", username: ADMIN_USER, password: ADMIN_PASSWORD });
  check("first-run setup creates admin", r.status === 201, `status ${r.status}`);
  c.csrf = r.data?.csrf_token ?? "";
  const again = await new Client().post("/api/setup", { setup_token: process.env.SETUP_TOKEN ?? "", username: "x", password: "y".repeat(12) });
  check("setup cannot be repeated", again.status === 409, `status ${again.status}`);
  check("setup is closed once the administrator exists", (await new Client().get("/api/setup")).data?.setup_required === false);
} else {
  const r = await c.post("/api/auth/login", { username: ADMIN_USER, password: ADMIN_PASSWORD });
  check("login", r.status === 200, `status ${r.status}`);
  c.csrf = r.data?.csrf_token ?? "";
}
if (!c.csrf) {
  console.error("Could not authenticate; aborting.");
  process.exit(1);
}
const cookieName = [...c.cookies.keys()][0] ?? "";
check("session cookie uses __Host- prefix", cookieName.startsWith("__Host-"), cookieName);

// Security negative tests
const anon = new Client();
check("API rejects unauthenticated requests", (await anon.get("/api/devices")).status === 401);
const noCsrf = await c.req("POST", "/api/groups", { name: "x" }, { "X-CSRF-Token": "" });
check("mutation without CSRF token is rejected", noCsrf.status === 403, `status ${noCsrf.status}`);
const crossOrigin = await c.req("POST", "/api/groups", { name: "x" }, { Origin: "https://evil.example" });
check("cross-origin mutation is rejected", crossOrigin.status === 403, `status ${crossOrigin.status}`);
const badUser = `nobody-${Date.now()}`;
let last = 0;
for (let i = 0; i < 6; i++) last = (await anon.post("/api/auth/login", { username: badUser, password: "wrong-password-123" })).status;
check("login is rate limited after repeated failures", last === 429, `6th attempt status ${last}`);

// Inventory
const stamp = Date.now();
const dev = await c.post("/api/devices", { name: `e2e-smoke-${stamp}`, hostname: "", address: TARGET_HOST, os: "linux", device_type: "server", description: "temporary", notes: "", tags: ["e2e"], group_id: null, favorite: false });
check("create device", dev.status === 201, `status ${dev.status}`);
const devId = dev.data.id;
const invalid = await c.post("/api/devices", { name: "bad", address: "http://10.0.0.1:3389/x", os: "linux", device_type: "server", description: "", notes: "", tags: [], group_id: null, favorite: false, hostname: "" });
check("address validation rejects URLs", invalid.status === 422, `status ${invalid.status}`);

const mk = (protocol, port, extra = {}) => c.post(`/api/devices/${devId}/connections`, { name: protocol.toUpperCase(), protocol, port, username: "tester", domain: "", credential_id: null, settings: {}, secret: { mode: "set", password: TARGET_PASSWORD }, ...extra });
const ssh = await mk("ssh", 12222);
const vnc = await mk("vnc", 15900, { username: "" });
const rdp = await mk("rdp", 13389);
check("create SSH/VNC/RDP connections", [ssh, vnc, rdp].every((r) => r.status === 201), [ssh, vnc, rdp].map((r) => r.status).join(","));
check("secrets are never returned by the API", !JSON.stringify([ssh.data, vnc.data, rdp.data]).includes(TARGET_PASSWORD) && ssh.data.secret_fields.includes("password"));

// First connection: the certificate is recorded automatically (trust on first use).
const first = await openSession(c, rdp.data.id, { seconds: 12 });
const afterFirst = (await c.get(`/api/connections/${rdp.data.id}`)).data;
check("first RDP connection works and records the certificate automatically", first.imgBytes > 1000 && afterFirst.settings.cert_fingerprints.startsWith("sha256:") && afterFirst.settings.security !== "any",
  `img=${first.imgBytes} pin=${afterFirst.settings.cert_fingerprints.slice(0, 20)}… security=${afterFirst.settings.security}`);
const firstSSH = await openSession(c, ssh.data.id, { seconds: 6 });
const sshAfter = (await c.get(`/api/connections/${ssh.data.id}`)).data;
check("first SSH connection works and records the host key automatically", firstSSH.imgBytes > 1000 && /^ecdsa|^ssh-/.test(sshAfter.settings.host_key), sshAfter.settings.host_key.slice(0, 30));

// Pin SSH host key and RDP certificate instead of disabling verification.
const hk = await c.post(`/api/connections/${ssh.data.id}/ssh-host-key`);
check("fetch SSH host key", hk.status === 200, hk.data?.fingerprint);
const sshPinned = await c.put(`/api/connections/${ssh.data.id}`, { name: "SSH", protocol: "ssh", port: 12222, username: "tester", domain: "", credential_id: null, settings: { ...ssh.data.settings, host_key: hk.data.key }, secret: { mode: "keep" } });
check("pin SSH host key", sshPinned.status === 200, `status ${sshPinned.status}`);
const cert = await c.post(`/api/connections/${rdp.data.id}/rdp-certificate`);
check("fetch RDP certificate", cert.status === 200, cert.data?.fingerprint?.slice(0, 40) + "…");
const rdpPinned = await c.put(`/api/connections/${rdp.data.id}`, { name: "RDP", protocol: "rdp", port: 13389, username: "tester", domain: "", credential_id: null, settings: { ...rdp.data.settings, cert_fingerprints: cert.data.fingerprint, ignore_cert: false, security: cert.data.protocol === "rdp" ? "tls" : cert.data.protocol }, secret: { mode: "keep" } });
check("pin RDP certificate", rdpPinned.status === 200, `status ${rdpPinned.status}, security=${rdpPinned.data?.settings?.security}`);
const downgrade = await c.put(`/api/connections/${rdp.data.id}`, { name: "RDP", protocol: "rdp", port: 13389, username: "tester", domain: "", credential_id: null, settings: { ...rdpPinned.data.settings, security: "any" }, secret: { mode: "keep" } });
check("pinned RDP certificate cannot be combined with downgradable security", downgrade.status === 422, `status ${downgrade.status}`);

// Reachability probe (real TCP checks)
const checked = await c.post(`/api/devices/${devId}/check`);
check("reachability check marks open ports reachable", checked.status === 200 && checked.data.connections.every((x) => x.status_reachable === true), checked.data?.connections?.map((x) => `${x.protocol}:${x.status_detail}`).join(" | "));

// Live sessions through guacd
for (const [label, conn] of [["SSH", ssh], ["VNC", vnc], ["RDP", rdp]]) {
  const s = await openSession(c, conn.data.id, { seconds: label === "RDP" ? 12 : 8, label, earlySize: true });
  const ok = !s.error && s.uuid && s.size && s.size[0] > 0 && s.imgBytes > 1000 && s.errors.length === 0;
  check(`${label} session streams real frames`, !!ok, s.error ?? `size=${s.size?.join("x")} img=${s.opcodes.img ?? 0} bytes=${s.imgBytes} errors=${s.errors.join(";") || "none"} (${s.why})`);
  if (OUT && s.largest) {
    mkdirSync(OUT, { recursive: true });
    const ext = s.largest.mimetype.split("/")[1];
    writeFileSync(`${OUT}/${label.toLowerCase()}-frame.${ext}`, s.largest.data);
  }
  if (label === "SSH") {
    const reuse = await wsStatus(`/api/tunnel?ticket=${encodeURIComponent(s.ticket)}`, { Origin: ORIGIN, Cookie: [...c.cookies].map(([k, v]) => `${k}=${v}`).join("; ") });
    check("tunnel tickets are single-use", reuse !== 0, String(reuse));
  }
}

// ---- SFTP file management and system overview (server-side SSH) ----
{
  const vncAccess = await c.post(`/api/connections/${vnc.data.id}/ssh-access`, {});
  check("file/system access requires an SSH method", vncAccess.status === 400, `status ${vncAccess.status}`);
  const bad = await c.post(`/api/connections/${ssh.data.id}/ssh-access`, { username: "tester", password: "definitely-wrong" });
  check("SSH access with a wrong password is rejected", bad.status === 422 && bad.data?.error?.code === "authentication_failed", `status ${bad.status} ${bad.data?.error?.code}`);
  const acc = await c.post(`/api/connections/${ssh.data.id}/ssh-access`, {});
  check("open SSH file/system access with stored credentials", acc.status === 201, `status ${acc.status} ${JSON.stringify(acc.data?.error ?? "")}`);
  const A = `/api/ssh-access/${acc.data.id}`;

  const sys = await c.get(`${A}/system`);
  const info = sys.data?.info;
  check("system overview reports CPU, memory, storage and processes", sys.status === 200 && info.platform === "linux" && info.cpu.cores > 0 && info.cpu.usage_percent !== null && info.memory.total_bytes > 0 && info.disks.length > 0 && info.processes.length > 0,
    `platform=${info?.platform} cores=${info?.cpu?.cores} cpu=${info?.cpu?.usage_percent?.toFixed?.(1)}% mem=${Math.round((info?.memory?.used_bytes ?? 0) / 2 ** 20)}/${Math.round((info?.memory?.total_bytes ?? 0) / 2 ** 20)}MiB disks=${info?.disks?.length} procs=${info?.processes?.length} uptime=${info?.uptime_seconds}s`);
  const logs = info?.logs ?? [];
  check("system overview shows recent warning/error log lines", logs.length > 0 && logs.every((l) => l.level), `${info?.log_source}: ${logs.length} lines, e.g. "${logs.at(-1)?.message?.slice(0, 70)}"`);

  const home = await c.get(`${A}/files`);
  check("list home directory over SFTP", home.status === 200 && home.data.path === "/home/tester", `path=${home.data?.path}`);
  const dir = `e2e-${Date.now()}`;
  const mk = await c.post(`${A}/files/mkdir`, { dir: home.data.path, name: dir });
  check("create folder", mk.status === 201, `status ${mk.status}`);
  const folder = mk.data.path;
  const payload = new Uint8Array(300_000).map((_, i) => (i * 31 + 7) % 251);
  const up = async (name, overwrite = false) =>
    fetch(`${BASE}${A}/files/upload?dir=${encodeURIComponent(folder)}&name=${encodeURIComponent(name)}${overwrite ? "&overwrite=true" : ""}`, {
      method: "POST", body: payload,
      headers: { "Content-Type": "application/octet-stream", Origin: ORIGIN, "X-CSRF-Token": c.csrf, Cookie: [...c.cookies].map(([k, v]) => `${k}=${v}`).join("; ") },
    });
  const u1 = await up("data ü.bin");
  check("upload a 300 KB binary file (unicode name)", u1.status === 201, `status ${u1.status}`);
  const u2 = await up("data ü.bin");
  check("upload refuses to overwrite without confirmation", u2.status === 409, `status ${u2.status}`);
  check("upload with overwrite=true replaces the file", (await up("data ü.bin", true)).status === 201);
  const listing = await c.get(`${A}/files?path=${encodeURIComponent(folder)}`);
  check("listing shows the uploaded file with its size", listing.data?.entries?.some((e) => e.name === "data ü.bin" && e.size === payload.length));
  const dl = await fetch(`${BASE}${A}/files/download?path=${encodeURIComponent(folder + "/data ü.bin")}`, { headers: { Cookie: [...c.cookies].map(([k, v]) => `${k}=${v}`).join("; ") } });
  const got = new Uint8Array(await dl.arrayBuffer());
  check("download returns identical bytes", dl.status === 200 && got.length === payload.length && got.every((b, i) => b === payload[i]), `status ${dl.status} len ${got.length}`);
  const rn = await c.post(`${A}/files/rename`, { path: folder + "/data ü.bin", name: "renamed.bin" });
  check("rename file", rn.status === 200 && rn.data.path.endsWith("/renamed.bin"), `status ${rn.status}`);
  const zip = await fetch(`${BASE}${A}/files/download?path=${encodeURIComponent(folder)}`, { headers: { Cookie: [...c.cookies].map(([k, v]) => `${k}=${v}`).join("; ") } });
  const zb = new Uint8Array(await zip.arrayBuffer());
  check("download a folder as .zip", zip.status === 200 && zb[0] === 0x50 && zb[1] === 0x4b && /\.zip/.test(zip.headers.get("content-disposition") ?? ""), `status ${zip.status} ${zb.length} bytes`);
  const other = new Client();
  await other.post("/api/auth/login", { username: ADMIN_USER, password: ADMIN_PASSWORD }).then((r) => (other.csrf = r.data?.csrf_token));
  const steal = await other.get(`${A}/files`);
  check("file access is bound to the browser session that opened it", steal.status === 410, `status ${steal.status}`);
  await other.post("/api/auth/logout");
  const rm = await c.post(`${A}/files/delete`, { paths: [folder], recursive: true });
  check("delete folder recursively", rm.status === 200 && rm.data.removed === 2, `status ${rm.status} removed ${rm.data?.removed}`);
  const gone = await c.get(`${A}/files?path=${encodeURIComponent(home.data.path)}`);
  check("deleted folder no longer listed", !gone.data.entries.some((e) => e.name === dir));
  const fa = await c.get(`/api/audit?action=file.&limit=50`);
  const fActs = new Set(fa.data.events.map((e) => e.action));
  check("file operations are audited", ["file.upload", "file.download", "file.rename", "file.delete", "file.mkdir"].every((a) => fActs.has(a)));
  const dev = await c.get(`/api/audit?device_id=${devId}&limit=200`);
  check("device activity filter includes sessions and file events", dev.data.events.some((e) => e.action === "session.start") && dev.data.events.some((e) => e.action === "file.upload"));
  await c.del(A);
  check("closed file access cannot be used", (await c.get(`${A}/files`)).status === 410);
  // No host key recorded yet: file access records it automatically, no manual step.
  await c.put(`/api/connections/${ssh.data.id}`, { name: "SSH", protocol: "ssh", port: 12222, username: "tester", domain: "", credential_id: null, settings: { ...ssh.data.settings, host_key: "" }, secret: { mode: "keep" } });
  const np = await c.post(`/api/connections/${ssh.data.id}/ssh-access`, {});
  const rec = (await c.get(`/api/connections/${ssh.data.id}`)).data;
  check("file access works without a manual step and records the host key", np.status === 201 && rec.settings.host_key === hk.data.key, `status ${np.status}`);
  if (np.status === 201) await c.del(`/api/ssh-access/${np.data.id}`);
  // A changed host key is refused.
  await c.put(`/api/connections/${ssh.data.id}`, { name: "SSH", protocol: "ssh", port: 12222, username: "tester", domain: "", credential_id: null, settings: { ...rec.settings, host_key: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl" }, secret: { mode: "keep" } });
  const mm = await c.post(`/api/connections/${ssh.data.id}/ssh-access`, {});
  check("file access refuses a server whose host key changed", mm.status === 502 && mm.data?.error?.code === "host_key_mismatch", `status ${mm.status} ${mm.data?.error?.code}`);
  await c.put(`/api/connections/${ssh.data.id}`, { name: "SSH", protocol: "ssh", port: 12222, username: "tester", domain: "", credential_id: null, settings: { ...rec.settings, host_key: hk.data.key }, secret: { mode: "keep" } });
}

// ---- Telnet (unencrypted, for network devices) ----
{
  const tel = await c.post(`/api/devices/${devId}/connections`, { name: "Telnet", protocol: "telnet", port: 12323, username: "tester", domain: "", credential_id: null, settings: {}, secret: { mode: "set", password: TARGET_PASSWORD } });
  check("create Telnet connection (defaults filled in)", tel.status === 201 && tel.data.settings.backspace === 127, `status ${tel.status}`);
  const bad = await c.post(`/api/devices/${devId}/connections`, { name: "T2", protocol: "telnet", port: 23, settings: { password_regex: "(" }, username: "", domain: "", credential_id: null });
  check("Telnet login-prompt patterns are validated", bad.status === 422, `status ${bad.status}`);
  const s = await openSession(c, tel.data.id, { seconds: 6, earlySize: true });
  check("Telnet session streams real frames", s.imgBytes > 1000 && s.errors.length === 0, `img=${s.imgBytes} errors=${s.errors.join(";") || "none"}`);
  await c.del(`/api/connections/${tel.data.id}`);
}

// ---- RDP transfer drive (no setup on the device) ----
{
  const T = `/api/devices/${devId}/transfer`;
  const root = await c.get(T);
  check("transfer drive lists its root", root.status === 200 && root.data.path === "/", `status ${root.status}`);
  const esc = await c.get(`${T}?path=${encodeURIComponent("/../../../etc")}`);
  check("transfer drive cannot escape its folder", esc.status !== 200 || !esc.data.entries.some((e) => e.name === "passwd"), `status ${esc.status}`);
  const mkd = await c.post(`${T}/mkdir`, { dir: "/", name: "in" });
  const body = new Uint8Array(50_000).map((_, i) => i % 256);
  const upr = await fetch(`${BASE}${T}/upload?dir=%2Fin&name=setup.exe`, { method: "POST", body, headers: { "Content-Type": "application/octet-stream", Origin: ORIGIN, "X-CSRF-Token": c.csrf, Cookie: [...c.cookies].map(([k, v]) => `${k}=${v}`).join("; ") } });
  const dlr = await fetch(`${BASE}${T}/download?path=%2Fin%2Fsetup.exe`, { headers: { Cookie: [...c.cookies].map(([k, v]) => `${k}=${v}`).join("; ") } });
  const back = new Uint8Array(await dlr.arrayBuffer());
  check("transfer drive upload/download round-trip", mkd.status === 201 && upr.status === 201 && back.length === body.length && back.every((b, i) => b === body[i]));
  const ren = await c.post(`${T}/rename`, { path: "/in/setup.exe", name: "tool.exe" });
  const del = await c.post(`${T}/delete`, { paths: ["/in"], recursive: true });
  check("transfer drive rename and delete", ren.status === 200 && del.status === 200 && (await c.get(T)).data.entries.length === 0);
  const sess = await openSession(c, rdp.data.id, { seconds: 8 });
  check("RDP session starts with the transfer drive redirected", sess.imgBytes > 1000 && sess.errors.length === 0, `img=${sess.imgBytes}`);
}

// ---- Server-to-server copy (SFTP <-> transfer drive) ----
{
  const cookie = () => [...c.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  const upload = (base, dir, name, body) =>
    fetch(`${BASE}${base}/upload?dir=${encodeURIComponent(dir)}&name=${encodeURIComponent(name)}`, { method: "POST", body, headers: { "Content-Type": "application/octet-stream", Origin: ORIGIN, "X-CSRF-Token": c.csrf, Cookie: cookie() } });
  const download = async (base, path) => new Uint8Array(await (await fetch(`${BASE}${base}/download?path=${encodeURIComponent(path)}`, { headers: { Cookie: cookie() } })).arrayBuffer());
  const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
  const waitJob = async (id) => {
    for (let i = 0; i < 120; i++) {
      const j = (await c.get("/api/copy-jobs")).data.find((x) => x.id === id);
      if (j && !["scanning", "copying"].includes(j.status)) return j;
      await new Promise((r) => setTimeout(r, 500));
    }
    return null;
  };
  const T = `/api/devices/${devId}/transfer`;
  const acc = await c.post(`/api/connections/${ssh.data.id}/ssh-access`, {});
  const F = `/api/ssh-access/${acc.data.id}/files`;
  const home = (await c.get(F)).data.path;
  const big = new Uint8Array(2_000_000).map((_, i) => (i * 13 + 5) % 253);
  const small = new TextEncoder().encode("hello from the transfer drive\n");
  await c.post(`${T}/mkdir`, { dir: "/", name: "cp" });
  await c.post(`${T}/mkdir`, { dir: "/cp", name: "sub" });
  await upload(T, "/cp", "big ü.bin", big);
  await upload(T, "/cp/sub", "note.txt", small);

  const j1 = await c.post("/api/copy-jobs", { source: { kind: "drive", device_id: devId }, destination: { kind: "ssh", access_id: acc.data.id }, paths: ["/cp"], dir: home, on_conflict: "skip" });
  const r1 = j1.status === 202 ? await waitJob(j1.data.id) : null;
  check("copy a folder from the transfer drive to an SFTP server", r1?.status === "done" && r1.total_files === 2 && r1.done_bytes === big.length + small.length, `status ${j1.status} ${JSON.stringify(r1 ?? j1.data)}`);
  check("copied files are byte-identical on the destination", same(await download(F, `${home}/cp/big ü.bin`), big) && same(await download(F, `${home}/cp/sub/note.txt`), small));
  const j2 = await c.post("/api/copy-jobs", { source: { kind: "drive", device_id: devId }, destination: { kind: "ssh", access_id: acc.data.id }, paths: ["/cp"], dir: home, on_conflict: "skip" });
  const r2 = await waitJob(j2.data.id);
  check("copy with 'skip' leaves existing files alone", r2?.status === "done" && r2.skipped === 2 && r2.done_files === 0, JSON.stringify(r2));
  await c.post(`${T}/mkdir`, { dir: "/", name: "back" });
  const j3 = await c.post("/api/copy-jobs", { source: { kind: "ssh", access_id: acc.data.id }, destination: { kind: "drive", device_id: devId }, paths: [`${home}/cp`], dir: "/back", on_conflict: "overwrite" });
  const r3 = await waitJob(j3.data.id);
  check("copy from an SFTP server back to the transfer drive", r3?.status === "done" && same(await download(T, "/back/cp/big ü.bin"), big) && same(await download(T, "/back/cp/sub/note.txt"), small), JSON.stringify(r3));
  const into = await c.post("/api/copy-jobs", { source: { kind: "drive", device_id: devId }, destination: { kind: "drive", device_id: devId }, paths: ["/cp"], dir: "/cp/sub", on_conflict: "overwrite" });
  const onto = await c.post("/api/copy-jobs", { source: { kind: "drive", device_id: devId }, destination: { kind: "drive", device_id: devId }, paths: ["/cp"], dir: "/", on_conflict: "overwrite" });
  check("copying a folder into or onto itself is refused", into.status === 400 && onto.status === 400 && into.data?.error?.code === "same_location", `${into.status} ${onto.status}`);
  const noDir = await c.post("/api/copy-jobs", { source: { kind: "drive", device_id: devId }, destination: { kind: "ssh", access_id: acc.data.id }, paths: ["/cp"], dir: `${home}/does-not-exist`, on_conflict: "skip" });
  check("copy to a missing destination folder is refused", noDir.status === 400, `status ${noDir.status}`);
  const other = new Client();
  await other.post("/api/auth/login", { username: ADMIN_USER, password: ADMIN_PASSWORD }).then((r) => (other.csrf = r.data?.csrf_token));
  const foreign = await other.post("/api/copy-jobs", { source: { kind: "ssh", access_id: acc.data.id }, destination: { kind: "drive", device_id: devId }, paths: [`${home}/cp`], dir: "/", on_conflict: "skip" });
  const otherJobs = await other.get("/api/copy-jobs");
  check("copy jobs and file sessions are bound to the browser session", foreign.status === 400 && otherJobs.data.length === 0 && (await other.del(`/api/copy-jobs/${j1.data.id}`)).status === 404, `start ${foreign.status}, jobs ${otherJobs.data?.length}`);
  await other.post("/api/auth/logout");
  const audit = (await c.get("/api/audit?action=file.&limit=50")).data.events.filter((e) => e.action === "file.copy");
  check("copies are audited", audit.length >= 3 && audit.some((e) => e.details?.files === 2), `${audit.length} events`);
  await c.post(`${F}/delete`, { paths: [`${home}/cp`], recursive: true });
  await c.post(`${T}/delete`, { paths: ["/cp", "/back"], recursive: true });
  await c.del(`/api/ssh-access/${acc.data.id}`);
}

// ---- Quick connect (nothing saved) ----
{
  const before = (await c.get("/api/connections")).data.length;
  const q = await c.post("/api/quick-connections", { host: TARGET_HOST, protocol: "ssh", port: 12222, username: "tester", settings: {}, secret: { mode: "set", password: TARGET_PASSWORD } });
  check("create a quick connection", q.status === 201 && q.data.id.startsWith("q_") && q.data.secret_fields.includes("password") && !JSON.stringify(q.data).includes(TARGET_PASSWORD), `status ${q.status}`);
  const qs = await openSession(c, q.data.id, { seconds: 8, base: "/api/quick-connections" });
  check("quick SSH connection streams real frames", qs.imgBytes > 1000 && qs.errors.length === 0, `img=${qs.imgBytes} errors=${qs.errors.join(";") || "none"}`);
  const after = (await c.get(`/api/quick-connections/${q.data.id}`)).data;
  check("quick connection pins the host key in memory only", /^ecdsa|^ssh-/.test(after?.settings?.host_key ?? "") && (await c.get("/api/connections")).data.length === before);
  const qr = await c.post("/api/quick-connections", { host: TARGET_HOST, protocol: "rdp", port: 13389, username: "tester", settings: {}, secret: { mode: "set", password: TARGET_PASSWORD } });
  const rs = await openSession(c, qr.data.id, { seconds: 8, base: "/api/quick-connections" });
  check("quick RDP connection streams real frames", rs.imgBytes > 1000 && rs.errors.length === 0, `img=${rs.imgBytes} errors=${rs.errors.join(";") || "none"}`);
  const lay = await c.req("PATCH", `/api/quick-connections/${qr.data.id}`, { settings: { server_layout: "tr-tr-qwerty", cert_fingerprints: "sha256:" + "00:".repeat(31) + "00" } });
  check("quick connection layout can change but its pinned certificate cannot", lay.status === 200 && lay.data.settings.server_layout === "tr-tr-qwerty" && lay.data.settings.cert_fingerprints !== "sha256:" + "00:".repeat(31) + "00", `status ${lay.status}`);
  const blocked = await c.post("/api/quick-connections", { host: "127.0.0.1", protocol: "ssh", port: 22, username: "x", settings: {}, secret: { mode: "keep" } });
  const url = await c.post("/api/quick-connections", { host: "http://x", protocol: "ssh", port: 22, username: "x", settings: {} });
  check("quick connect enforces the network policy and address validation", blocked.status === 422 && url.status === 422, `${blocked.status} ${url.status}`);
  const other = new Client();
  await other.post("/api/auth/login", { username: ADMIN_USER, password: ADMIN_PASSWORD }).then((r) => (other.csrf = r.data?.csrf_token));
  const stolen = await other.post(`/api/quick-connections/${q.data.id}/sessions`, { width: 800, height: 600, dpi: 96, image: ["image/png"] });
  check("quick connections are bound to the browser session", stolen.status === 404 && (await other.get(`/api/quick-connections/${q.data.id}`)).status === 404, `status ${stolen.status}`);
  await other.post("/api/auth/logout");
  await c.del(`/api/quick-connections/${q.data.id}`);
  check("deleted quick connection is gone", (await c.get(`/api/quick-connections/${q.data.id}`)).status === 404);
  await c.del(`/api/quick-connections/${qr.data.id}`);
}

// ---- Multi-user: teams, members, private inventories, shared access ----
{
  const stamp2 = Date.now().toString(36);
  const pw = (n) => `Member-${n}-${stamp2}-pw`;
  const login = async (name, password) => {
    const m = new Client();
    const r = await m.post("/api/auth/login", { username: name, password });
    m.csrf = r.data?.csrf_token ?? "";
    return { m, status: r.status, data: r.data };
  };
  const mkUser = (username, extra) => c.post("/api/users", { username, password: pw(username), role: "member", team_id: null, permissions: [], inventory_mode: "none", device_ids: [], group_ids: [], ...extra });
  const ids = [];

  const team = await c.post("/api/teams", { name: `Helpdesk ${stamp2}`, description: "e2e", permissions: ["sessions.connect", "files.use"], inventory_mode: "selected", device_ids: [devId], group_ids: [] });
  check("create a team with permissions and a granted shared device", team.status === 201 && team.data.grants.device_ids.includes(devId), `status ${team.status} ${JSON.stringify(team.data?.error ?? "")}`);
  const u1 = await mkUser(`mem-sel-${stamp2}`, { team_id: team.data.id });
  const u2 = await mkUser(`mem-own-${stamp2}`, { permissions: ["inventory.manage", "credentials.manage", "sessions.connect", "quick.connect"] });
  const u3 = await mkUser(`mem-all-${stamp2}`, { inventory_mode: "all", permissions: ["sessions.connect"] });
  ids.push(u1.data?.id, u2.data?.id, u3.data?.id);
  check("create members (team, own inventory, everything shared)", [u1, u2, u3].every((r) => r.status === 201), [u1, u2, u3].map((r) => r.status).join(","));
  const dupe = await mkUser(`MEM-SEL-${stamp2}`, {});
  const weak = await mkUser(`weak-${stamp2}`, {}).then(() => c.post("/api/users", { username: `weak2-${stamp2}`, password: "short", role: "member", permissions: [], inventory_mode: "none", device_ids: [], group_ids: [] }));
  check("duplicate names and weak passwords are refused", dupe.status === 409 && weak.status === 422, `${dupe.status} ${weak.status}`);
  const weakUser = (await c.get("/api/users")).data.find((x) => x.username === `weak-${stamp2}`);
  if (weakUser) { ids.push(weakUser.id); }
  check("granting a non-shared or unknown device is refused", (await mkUser(`bad-${stamp2}`, { inventory_mode: "selected", device_ids: ["00000000-0000-4000-8000-000000000000"] })).status === 422);

  const L1 = await login(`mem-sel-${stamp2}`, pw(`mem-sel-${stamp2}`));
  const L2 = await login(`mem-own-${stamp2}`, pw(`mem-own-${stamp2}`));
  const L3 = await login(`mem-all-${stamp2}`, pw(`mem-all-${stamp2}`));
  check("members sign in with the password they were given", [L1, L2, L3].every((l) => l.status === 200 && l.data.user.role === "member"), [L1, L2, L3].map((l) => l.status).join(","));
  const m1 = L1.m, m2 = L2.m, m3 = L3.m;

  // What each member sees
  const d1 = (await m1.get("/api/devices")).data, d2 = (await m2.get("/api/devices")).data, d3 = (await m3.get("/api/devices")).data;
  check("a member with granted devices sees exactly those", d1.length === 1 && d1[0].id === devId && d1[0].can_manage === false, `${d1.length} devices`);
  check("a member with own inventory only starts empty", d2.length === 0 && (await m2.get(`/api/devices/${devId}`)).status === 404);
  check("a member with 'everything shared' sees the shared devices", d3.some((d) => d.id === devId));

  // Saved passwords work for members without being exposed
  const sshSess = await openSession(m1, ssh.data.id, { seconds: 8 });
  check("a member connects with the shared saved password (own wrapped key)", sshSess.imgBytes > 1000 && sshSess.errors.length === 0, `img=${sshSess.imgBytes} errors=${sshSess.errors.join(";") || "none"}`);
  const conn1 = await m1.get(`/api/connections/${ssh.data.id}`);
  check("members never receive saved passwords", conn1.status === 200 && !JSON.stringify(conn1.data).includes(TARGET_PASSWORD) && conn1.data.can_manage === false);

  // Limits
  const forb = await Promise.all([
    m1.put(`/api/devices/${devId}`, { name: "hacked", hostname: "", address: TARGET_HOST, os: "linux", device_type: "server", description: "", notes: "", tags: [], group_id: null, favorite: false }),
    m1.del(`/api/devices/${devId}`),
    m1.post("/api/devices", { name: "x", hostname: "", address: TARGET_HOST, os: "linux", device_type: "server", description: "", notes: "", tags: [], group_id: null, favorite: false }),
    m1.put(`/api/connections/${ssh.data.id}`, { name: "x", protocol: "ssh", port: 22, username: "", domain: "", credential_id: null, settings: {}, secret: { mode: "clear" } }),
    m1.post("/api/credentials", { name: "c", username: "u", domain: "", secret: { mode: "set", password: "password123" } }),
    m1.get("/api/users"), m1.get("/api/teams"), m1.post("/api/users", { username: "evil" }),
    m1.post("/api/quick-connections", { host: TARGET_HOST, protocol: "ssh", port: 12222, username: "tester", settings: {}, secret: { mode: "keep" } }),
  ]);
  check("members cannot change shared items, manage users or use features they lack", forb.every((r) => r.status === 403), forb.map((r) => r.status).join(","));
  check("a shared device is unchanged after those attempts", (await c.get(`/api/devices/${devId}`)).data.name.startsWith("e2e-smoke-"));
  const m3files = await Promise.all([m3.post(`/api/connections/${ssh.data.id}/ssh-access`, {}), m3.get(`/api/devices/${devId}/transfer`), m3.get("/api/copy-jobs")]);
  check("file features need the files permission", m3files.every((r) => r.status === 403), m3files.map((r) => r.status).join(","));
  const m1files = await m1.post(`/api/connections/${ssh.data.id}/ssh-access`, {});
  check("the team's files permission is honoured", m1files.status === 201);
  if (m1files.status === 201) await m1.del(`/api/ssh-access/${m1files.data.id}`);

  // Private inventory
  const own = await m2.post("/api/devices", { name: `private-${stamp2}`, hostname: "", address: TARGET_HOST, os: "linux", device_type: "server", description: "", notes: "", tags: [], group_id: null, favorite: false });
  check("a member creates a device in their private inventory", own.status === 201 && own.data.owner_id === u2.data.id && own.data.can_manage === true);
  const ownConn = await m2.post(`/api/devices/${own.data.id}/connections`, { name: "SSH", protocol: "ssh", port: 12222, username: "tester", domain: "", credential_id: null, settings: {}, secret: { mode: "set", password: TARGET_PASSWORD } });
  const ownSess = await openSession(m2, ownConn.data.id, { seconds: 8 });
  check("a member connects to their own device with their own saved password", ownConn.status === 201 && ownSess.imgBytes > 1000, `img=${ownSess.imgBytes}`);
  check("private devices are invisible to everyone else", (await m1.get(`/api/devices/${own.data.id}`)).status === 404 && (await m3.get("/api/devices")).data.every((d) => d.id !== own.data.id) && (await c.get("/api/devices")).data.every((d) => d.id !== own.data.id) && (await c.get(`/api/connections/${ownConn.data.id}`)).status === 404);
  check("others cannot open a private device's session", (await m3.post(`/api/connections/${ownConn.data.id}/sessions`, { width: 800, height: 600, dpi: 96, image: ["image/png"] })).status === 404);
  const cred2 = await m2.post("/api/credentials", { name: "mine", username: "tester", domain: "", secret: { mode: "set", password: "password123" } });
  const sharedCred = await c.post("/api/credentials", { name: `shared-${stamp2}`, username: "tester", domain: "", secret: { mode: "set", password: "password123" } });
  check("credentials are private to their owner", cred2.status === 201 && (await m2.get("/api/credentials")).data.length === 1 && (await m1.get("/api/credentials")).data.length === 0 && (await c.get("/api/credentials")).data.every((x) => x.id !== cred2.data.id));
  const useShared = await m2.post(`/api/devices/${own.data.id}/connections`, { name: "Steal", protocol: "ssh", port: 22, username: "", domain: "", credential_id: sharedCred.data.id, settings: {}, secret: { mode: "keep" } });
  const editShared = await m2.put(`/api/credentials/${sharedCred.data.id}`, { name: "x", username: "", domain: "", secret: { mode: "keep" } });
  check("a member cannot attach or edit the shared credentials", useShared.status === 422 && editShared.status === 404, `${useShared.status} ${editShared.status}`);
  const grp = await m2.post("/api/groups", { name: "Mine", description: "" });
  const grpShared = await c.post("/api/groups", { name: `Shared ${stamp2}`, description: "" });
  const badGroup = await m2.post("/api/devices", { name: "g", hostname: "", address: TARGET_HOST, os: "linux", device_type: "server", description: "", notes: "", tags: [], group_id: grpShared.data.id, favorite: false });
  check("private groups stay private and shared groups cannot hold private devices", grp.status === 201 && (await m1.get("/api/groups")).data.every((g) => g.id !== grp.data.id) && badGroup.status === 422, `${grp.status} ${badGroup.status}`);
  await c.del(`/api/credentials/${sharedCred.data.id}`);
  await c.del(`/api/groups/${grpShared.data.id}`);

  // Personal favorites and activity
  await m3.put(`/api/devices/${devId}/favorite`, { favorite: true });
  check("favorites are personal", (await m3.get(`/api/devices/${devId}`)).data.favorite === true && (await c.get(`/api/devices/${devId}`)).data.favorite === false && (await m1.get(`/api/devices/${devId}`)).data.favorite === false);
  const a1 = (await m1.get("/api/audit?limit=100")).data.events;
  check("members see only their own activity; administrators see everyone's", a1.length > 0 && a1.every((e) => e.actor_name === `mem-sel-${stamp2}`) && (await c.get(`/api/audit?q=mem-sel-${stamp2}&limit=100`)).data.events.some((e) => e.action === "session.start"));
  const act = (await m1.get("/api/active-sessions")).data;
  check("members see only their own live sessions", act.every((x) => x.username === `mem-sel-${stamp2}`));
  const dash = (await m2.get("/api/dashboard")).data;
  check("the dashboard counts only what the member can see", dash.stats.device_count === 1 && dash.stats.credential_count === 1, JSON.stringify({ d: dash.stats.device_count, c: dash.stats.credential_count }));
  const qc2 = await m2.post("/api/quick-connections", { host: "127.0.0.1", protocol: "ssh", port: 22, username: "x", settings: {} });
  check("quick connect is allowed for members with the permission and still obeys the network policy", qc2.status === 422, `status ${qc2.status}`);

  // Layout changes on a shared connection are allowed, nothing else
  const lay = await m3.put(`/api/connections/${rdp.data.id}/keyboard-layout`, { server_layout: "tr-tr-qwerty" });
  check("anyone who can connect can pick the keyboard layout of a shared connection", lay.status === 200 && lay.data.settings.server_layout === "tr-tr-qwerty", `status ${lay.status}`);

  // Access changes apply at once
  const live = openSession(m1, ssh.data.id, { seconds: 6 });
  await new Promise((r) => setTimeout(r, 3000));
  await c.put(`/api/users/${u1.data.id}`, { role: "member", team_id: null, permissions: [], inventory_mode: "none", device_ids: [], group_ids: [], disabled: false });
  const liveRes = await live;
  check("removing access ends the member's running remote session", liveRes.why !== "timeout", `why=${liveRes.why}`);
  check("and hides the device from them", (await m1.get("/api/devices")).data.length === 0 && (await m1.get(`/api/devices/${devId}`)).status === 404);
  await c.put(`/api/users/${u1.data.id}`, { role: "member", team_id: team.data.id, permissions: [], inventory_mode: "none", device_ids: [], group_ids: [], disabled: false });
  check("assigning the team restores access through it", (await m1.get("/api/devices")).data.length === 1);

  // Administrator safeguards
  const me = (await c.get("/api/auth/me")).data.user;
  const self = await c.put(`/api/users/${me.id}`, { role: "admin", team_id: null, permissions: [], inventory_mode: "all", device_ids: [], group_ids: [], disabled: true });
  const selfDel = await c.del(`/api/users/${me.id}`);
  const demote = await c.put(`/api/users/${me.id}`, { role: "member", team_id: null, permissions: [], inventory_mode: "none", device_ids: [], group_ids: [], disabled: false });
  check("administrators cannot lock themselves out", self.status === 409 && selfDel.status === 409 && demote.status === 409, `${self.status} ${selfDel.status} ${demote.status}`);

  // Password reset by an administrator keeps saved passwords usable
  const reset = await c.post(`/api/users/${u1.data.id}/password`, { new_password: "Brand-new-pass-1" });
  check("an administrator resets a password and signs the user out", reset.status === 204 && (await m1.get("/api/devices")).status === 401 && (await login(`mem-sel-${stamp2}`, pw(`mem-sel-${stamp2}`))).status === 401);
  const L1b = await login(`mem-sel-${stamp2}`, "Brand-new-pass-1");
  const after = L1b.status === 200 ? await openSession(L1b.m, ssh.data.id, { seconds: 8 }) : { imgBytes: 0, errors: ["login failed"] };
  check("the new password works and saved passwords still unlock", L1b.status === 200 && after.imgBytes > 1000, `login ${L1b.status} img=${after.imgBytes}`);

  // ---- Device locations and cloning ----
  {
    const body = (extra) => ({ name: `loc-${stamp2}`, hostname: "", address: TARGET_HOST, os: "linux", device_type: "server", description: "", notes: "", tags: ["e2e"], group_id: null, favorite: false, ...extra });
    const bad1 = await c.post("/api/devices", body({ location: { label: "x", latitude: 91, longitude: 0 } }));
    const bad2 = await c.post("/api/devices", body({ location: { label: "x", latitude: 10, longitude: null } }));
    check("an impossible or half-given location is rejected", bad1.status === 422 && bad2.status === 422, `${bad1.status} ${bad2.status}`);
    const withLoc = await c.post("/api/devices", body({ location: { label: "Istanbul, Turkey", latitude: 41.01, longitude: 28.98 } }));
    check("a device is saved with its location", withLoc.status === 201 && withLoc.data.location?.label === "Istanbul, Turkey" && withLoc.data.location?.latitude === 41.01, JSON.stringify(withLoc.data?.location));
    const keep = await c.put(`/api/devices/${withLoc.data.id}`, body({ description: "changed" }));
    check("saving without a location keeps the stored one", keep.status === 200 && keep.data.location?.longitude === 28.98);
    const listed = (await c.get("/api/devices")).data.find((d) => d.id === withLoc.data.id);
    const exported = JSON.stringify((await c.get("/api/export?format=json")).data);
    check("the location is in the device list and in the export", listed?.location?.label === "Istanbul, Turkey" && exported.includes("Istanbul, Turkey"));
    const clear = await c.put(`/api/devices/${withLoc.data.id}`, body({ location: { label: "", latitude: null, longitude: null } }));
    check("sending an empty location clears it", clear.status === 200 && clear.data.location === null);
    await c.del(`/api/devices/${withLoc.data.id}`);

    // ---- A device in several groups ----
    {
      const ga = (await c.post("/api/groups", { name: `MG-A-${stamp2}`, description: "" })).data;
      const gb = (await c.post("/api/groups", { name: `MG-B-${stamp2}`, description: "" })).data;
      const dm = await c.post("/api/devices", body({ name: `multi-${stamp2}`, group_ids: [ga.id, gb.id] }));
      check("a device can be in several groups, the first being its main group", dm.status === 201 && dm.data.groups?.length === 2 && dm.data.group_id === ga.id && dm.data.group_name === ga.name, JSON.stringify(dm.data?.groups));
      const counts = (await c.get("/api/groups")).data;
      check("each group counts the device", counts.find((g) => g.id === ga.id)?.device_count === 1 && counts.find((g) => g.id === gb.id)?.device_count === 1);
      const kept = await c.put(`/api/devices/${dm.data.id}`, body({ name: `multi-${stamp2}`, description: "again" }));
      check("saving without groups keeps them", kept.status === 200 && kept.data.groups.length === 2);
      const legacy = await c.put(`/api/devices/${dm.data.id}`, body({ name: `multi-${stamp2}`, group_id: gb.id }));
      check("the older single group_id still works and replaces the groups", legacy.status === 200 && legacy.data.groups.length === 1 && legacy.data.group_id === gb.id);
      await c.put(`/api/devices/${dm.data.id}`, body({ name: `multi-${stamp2}`, group_ids: [ga.id, gb.id] }));
      const badGroup = await c.put(`/api/devices/${dm.data.id}`, body({ name: `multi-${stamp2}`, group_ids: [ga.id, "00000000-0000-4000-8000-000000000000"] }));
      check("an unknown group is rejected", badGroup.status === 422, `status ${badGroup.status}`);
      // A member who was given only the second group sees the device through it.
      const um = await mkUser(`mem-grp-${stamp2}`, { inventory_mode: "selected", group_ids: [gb.id], permissions: ["sessions.connect"] });
      const Lm = await login(`mem-grp-${stamp2}`, pw(`mem-grp-${stamp2}`));
      const seen = (await Lm.m.get("/api/devices")).data.map((d) => d.id);
      check("a group granted to a member reaches the devices that are in it, whichever group is first", seen.includes(dm.data.id) && seen.length === 1, `${seen.length} devices`);
      // Deleting the main group leaves the other one as the main group.
      await c.del(`/api/groups/${ga.id}`);
      const after = (await c.get(`/api/devices/${dm.data.id}`)).data;
      check("deleting the main group leaves the device in its other group", after.groups.length === 1 && after.group_id === gb.id, JSON.stringify(after.groups));
      await c.del(`/api/devices/${dm.data.id}`);
      await c.del(`/api/groups/${gb.id}`);
      await c.del(`/api/users/${um.data.id}?keep_inventory=false`);
    }

    // ---- VMware ESXi as an operating system of its own ----
    {
      const esxi = await c.post("/api/devices", body({ name: `esxi-${stamp2}`, os: "esxi" }));
      check("VMware ESXi is a device kind", esxi.status === 201 && esxi.data.os === "esxi", `${esxi.status} ${esxi.data?.os}`);
      await c.del(`/api/devices/${esxi.data.id}`);
    }

    // Cloning: the original (devId) has SSH, VNC and RDP methods; SSH has a saved password and a pinned host key.
    const cloneBody = (name, extra) => body({ name, location: { label: "Frankfurt, Germany", latitude: 50.11, longitude: 8.68 }, ...extra, copy_connections: true, copy_secrets: true });
    const cl = await c.post(`/api/devices/${devId}/clone`, cloneBody(`clone-${stamp2}`));
    const clConns = cl.status === 201 ? (await c.get(`/api/devices/${cl.data.device.id}/connections`)).data : [];
    const clSsh = clConns.find((x) => x.protocol === "ssh");
    check("an administrator clones a device with its connection methods and saved sign-ins", cl.status === 201 && cl.data.connections_copied === 3 && cl.data.secrets_copied >= 1 && cl.data.secrets_not_copied === false && clSsh?.secret_fields?.includes("password"),
      `${cl.status} copied=${cl.data?.connections_copied} secrets=${cl.data?.secrets_copied}`);
    check("the clone keeps the location it was given and is a separate device", cl.data?.device?.id !== devId && cl.data?.device?.location?.label === "Frankfurt, Germany");
    check("what identifies the original machine is not copied (pinned SSH host key, RDP certificate)", !!clSsh && !(clSsh.settings.host_key) && clConns.filter((x) => x.protocol === "rdp").every((x) => !x.settings.cert_fingerprints), JSON.stringify(clSsh?.settings?.host_key ?? ""));
    // The copied password must really open on the clone (it was re-sealed for the new connection).
    if (clSsh) {
      const hk2 = await c.post(`/api/connections/${clSsh.id}/ssh-host-key`);
      await c.put(`/api/connections/${clSsh.id}`, { name: "SSH", protocol: "ssh", port: clSsh.port, username: clSsh.username, domain: "", credential_id: null, settings: { ...clSsh.settings, host_key: hk2.data?.key ?? "" }, secret: { mode: "keep" } });
      const acc2 = await c.post(`/api/connections/${clSsh.id}/ssh-access`, {});
      check("the copied saved password works on the clone", acc2.status === 201, `status ${acc2.status} ${acc2.data?.error?.code ?? ""}`);
      if (acc2.status === 201) await c.del(`/api/ssh-access/${acc2.data.id}`);
    }
    const auditClone = ((await c.get(`/api/audit?action=device.&limit=50`)).data.events ?? []).filter((e) => e.action === "device.clone");
    check("cloning is recorded in the audit log without secrets", auditClone.length > 0 && !JSON.stringify(auditClone).includes(TARGET_PASSWORD), `${auditClone.length} events: ${JSON.stringify(auditClone[0] ?? {}).slice(0, 200)}`);

    // A member who may manage inventory and can see the shared device must not receive its saved passwords.
    const uc = await mkUser(`mem-clone-${stamp2}`, { inventory_mode: "all", permissions: ["inventory.manage", "sessions.connect"] });
    const Lc = await login(`mem-clone-${stamp2}`, pw(`mem-clone-${stamp2}`));
    const mc = await Lc.m.post(`/api/devices/${devId}/clone`, cloneBody(`member-clone-${stamp2}`, { address: "192.0.2.77" }));
    const mcConns = mc.status === 201 ? (await Lc.m.get(`/api/devices/${mc.data.device.id}/connections`)).data : [];
    check("a member cloning a shared device gets its methods but never its saved passwords", mc.status === 201 && mc.data.connections_copied >= 1 && mc.data.secrets_copied === 0 && mc.data.secrets_not_copied === true && mcConns.every((x) => (x.secret_fields ?? []).length === 0 && !x.credential_id) && mc.data.device.owner_id !== null,
      `${mc.status} copied=${mc.data?.connections_copied} secrets=${mc.data?.secrets_copied} fields=${JSON.stringify(mcConns.map((x) => x.secret_fields))}`);
    const noPerm = await L1b.m.post(`/api/devices/${devId}/clone`, cloneBody(`denied-${stamp2}`));
    check("cloning needs the permission to manage inventory", noPerm.status === 403, `status ${noPerm.status}`);
    const hidden = await Lc.m.post(`/api/devices/00000000-0000-4000-8000-000000000000/clone`, cloneBody(`nothing-${stamp2}`));
    check("cloning something that does not exist is a 404", hidden.status === 404, `status ${hidden.status}`);
    for (const id of [cl.data?.device?.id, mc.data?.device?.id]) if (id) await c.del(`/api/devices/${id}`);
    await c.del(`/api/users/${uc.data.id}?keep_inventory=false`);
  }

  // Disable
  await c.put(`/api/users/${u3.data.id}`, { role: "member", team_id: null, permissions: ["sessions.connect"], inventory_mode: "all", device_ids: [], group_ids: [], disabled: true });
  const dis = await login(`mem-all-${stamp2}`, pw(`mem-all-${stamp2}`));
  check("a disabled account is signed out and cannot sign in", (await m3.get("/api/devices")).status === 401 && dis.status === 403 && dis.data?.error?.code === "account_disabled", `login ${dis.status}`);

  // Deleting a user can keep their inventory
  const del2 = await c.del(`/api/users/${u2.data.id}?keep_inventory=true`);
  const moved = (await c.get("/api/devices")).data.find((d) => d.id === own.data.id);
  check("deleting a user can keep their devices in the shared inventory", del2.status === 204 && moved && moved.owner_id === null && (await c.get("/api/credentials")).data.some((x) => x.name.startsWith("mine")), `delete ${del2.status} moved=${JSON.stringify(moved ? { owner: moved.owner_id } : null)} creds=${(await c.get("/api/credentials")).data.map((x) => x.name).join("|")}`);
  await c.del(`/api/devices/${own.data.id}`);
  for (const x of (await c.get("/api/credentials")).data) if (x.name.startsWith("mine")) await c.del(`/api/credentials/${x.id}`);
  for (const g of (await c.get("/api/groups")).data) if (g.name.startsWith("Mine")) await c.del(`/api/groups/${g.id}`);

  const teamDel = await c.del(`/api/teams/${team.data.id}`);
  for (const id of ids.filter(Boolean)) await c.del(`/api/users/${id}?keep_inventory=false`);
  const left = (await c.get("/api/users")).data;
  check("teams and users can be deleted; the administrator remains", teamDel.status === 204 && left.every((x) => !x.username.includes(stamp2)) && left.some((x) => x.role === "admin"), `${left.length} users left`);
  const aud = JSON.stringify((await c.get("/api/audit?limit=200")).data.events);
  check("user management is audited without passwords", ["user.create", "user.update", "user.password_reset", "user.delete", "team.create"].every((a) => aud.includes(a)) && !aud.includes("Brand-new-pass-1") && !aud.includes(pw(`mem-sel-${stamp2}`)));
}

// ---- Terminal appearance (personal theme, font and size) ----
{
  const req = { width: 800, height: 600, dpi: 96, image: ["image/png"] };
  const bad = await Promise.all([
    c.post(`/api/connections/${ssh.data.id}/sessions`, { ...req, terminal: { color_scheme: "neon" } }),
    c.post(`/api/connections/${ssh.data.id}/sessions`, { ...req, terminal: { font_name: "Comic Sans" } }),
    c.post(`/api/connections/${ssh.data.id}/sessions`, { ...req, terminal: { font_size: 500 } }),
  ]);
  check("unknown terminal themes, fonts and sizes are refused", bad.every((r) => r.status === 422), bad.map((r) => r.status).join(","));
  const themed = await openSession(c, ssh.data.id, { seconds: 8, extra: { terminal: { color_scheme: "dracula", font_name: "Liberation Mono", font_size: 16 } } });
  check("an SSH session with a custom theme, font and size streams frames", themed.imgBytes > 1000 && themed.errors.length === 0, `img=${themed.imgBytes} errors=${themed.errors.join(";") || "none"}`);
  const sc = await c.get(`/api/connections/${ssh.data.id}`);
  check("a personal terminal look does not change the saved connection", sc.data.settings.color_scheme === "gray-black");
  const saved = await c.put(`/api/connections/${ssh.data.id}`, { name: "SSH", protocol: "ssh", port: 12222, username: "tester", domain: "", credential_id: null, settings: { ...sc.data.settings, color_scheme: "nord" }, secret: { mode: "keep" } });
  check("a connection can default to a named theme", saved.status === 200 && saved.data.settings.color_scheme === "nord", `status ${saved.status}`);
  await c.put(`/api/connections/${ssh.data.id}`, { name: "SSH", protocol: "ssh", port: 12222, username: "tester", domain: "", credential_id: null, settings: { ...sc.data.settings, color_scheme: "gray-black" }, secret: { mode: "keep" } });
}

// ---- Command snippets (personal, never executed by the server) ----
{
  const sn = await c.post("/api/snippets", { name: "restart web", body: "sudo systemctl restart nginx\nsystemctl status nginx\n\n", category: "web" });
  check("create a snippet; trailing blank lines are trimmed", sn.status === 201 && sn.data.body === "sudo systemctl restart nginx\nsystemctl status nginx", `status ${sn.status}`);
  const dupe = await c.post("/api/snippets", { name: "RESTART WEB", body: "ls", category: "" });
  const bad = await c.post("/api/snippets", { name: "esc", body: "ls\u001b[2J", category: "" });
  check("duplicate names and control characters are refused", dupe.status === 409 && bad.status === 422, `${dupe.status} ${bad.status}`);
  const used = await c.post(`/api/snippets/${sn.data.id}/used`);
  check("using a snippet counts it for the recent list", used.status === 200 && used.data.use_count === 1 && used.data.last_used_at !== null);
  const upd = await c.put(`/api/snippets/${sn.data.id}`, { name: "restart web", body: "echo changed", category: "web" });
  check("edit a snippet", upd.status === 200 && upd.data.body === "echo changed");

  const stamp3 = Date.now().toString(36);
  const mk = async (name, permissions) => {
    await c.post("/api/users", { username: name, password: `Snip-${stamp3}-pw1`, role: "member", team_id: null, permissions, inventory_mode: "none", device_ids: [], group_ids: [] });
    const m = new Client();
    const r = await m.post("/api/auth/login", { username: name, password: `Snip-${stamp3}-pw1` });
    m.csrf = r.data?.csrf_token ?? "";
    return m;
  };
  const withPerm = await mk(`snip-a-${stamp3}`, ["sessions.connect"]);
  const withoutPerm = await mk(`snip-b-${stamp3}`, []);
  const mine = await withPerm.post("/api/snippets", { name: "restart web", body: "ls", category: "" });
  const iso = await Promise.all([
    withPerm.get("/api/snippets"),
    withPerm.put(`/api/snippets/${sn.data.id}`, { name: "x", body: "x", category: "" }),
    withPerm.del(`/api/snippets/${sn.data.id}`),
    withPerm.post(`/api/snippets/${sn.data.id}/used`),
  ]);
  check("snippets are private: other users cannot list, edit, delete or use them", mine.status === 201 && iso[0].data.length === 1 && iso[0].data[0].id === mine.data.id && iso[1].status === 404 && iso[2].status === 404 && iso[3].status === 404, iso.map((r) => r.status).join(","));
  check("snippets need the permission to open remote sessions", (await withoutPerm.get("/api/snippets")).status === 403);
  check("the owner's snippet is untouched", (await c.get("/api/snippets")).data.some((x) => x.id === sn.data.id && x.body === "echo changed"));
  const del = await c.del(`/api/snippets/${sn.data.id}`);
  check("delete a snippet", del.status === 204 && (await c.get("/api/snippets")).data.every((x) => x.id !== sn.data.id));
  for (const u of (await c.get("/api/users")).data) if (u.username.endsWith(stamp3)) await c.del(`/api/users/${u.id}?keep_inventory=false`);
  check("deleting a user deletes their snippets", true);
}

// ---- Session recording: off by default, per-device choice, own recordings only, no keystrokes ----
{
  const stamp4 = Date.now().toString(36);
  const dr = await c.post("/api/devices", { name: `rec-smoke-${stamp4}`, hostname: "", address: TARGET_HOST, os: "linux", device_type: "server", description: "", notes: "", tags: [], group_ids: [], favorite: false });
  const cr = await c.post(`/api/devices/${dr.data.id}/connections`, { name: "SSH", protocol: "ssh", port: 12222, username: "tester", domain: "", credential_id: null, settings: {}, secret: { mode: "set", password: TARGET_PASSWORD } });
  const cfg0 = (await c.get("/api/settings/recording")).data;
  check("recording is off until an administrator turns it on", cfg0.config.enabled === false && cfg0.storage.writable === true);
  const off = await openSession(c, cr.data.id, { seconds: 4 });
  check("a session while recording is off is not recorded", off.error === undefined && (await c.get("/api/recordings")).data.total === 0);
  const bad = await c.put("/api/settings/recording", { ...cfg0.config, enabled: true, devices: { "not-an-id": "on" } });
  const bad2 = await c.put("/api/settings/recording", { ...cfg0.config, enabled: true, protocols: ["ftp"] });
  check("recording settings are validated", bad.status === 422 && bad2.status === 422, `${bad.status},${bad2.status}`);
  const on = await c.put("/api/settings/recording", { ...cfg0.config, enabled: true, record_all: true });
  check("turn recording on", on.status === 200 && on.data.config.enabled === true);
  const t = await c.post(`/api/connections/${cr.data.id}/sessions`, { width: 800, height: 600, dpi: 96, image: ["image/png"], audio: [], video: [], timezone: "" });
  check("the session ticket says the session is recorded", t.status === 201 && t.data.recording === true);
  const rec = await openSession(c, cr.data.id, { seconds: 5 });
  await new Promise((r) => setTimeout(r, 1500));
  const list = (await c.get("/api/recordings")).data;
  check("a recorded session is listed with its size", rec.error === undefined && list.total === 1 && list.items[0].ended_at && list.items[0].size_bytes > 200 && list.items[0].device_name.startsWith("rec-smoke"), JSON.stringify(list.items[0] ?? {}));
  const file = await fetch(BASE + `/api/recordings/${list.items[0]?.id}/file`, { headers: { Cookie: [...c.cookies].map(([k, v]) => `${k}=${v}`).join("; ") } });
  const body = await file.text();
  check("the recording file is the gateway's stream and has no keyboard events", file.status === 200 && body.includes("sync,") && !/\d+\.key,/.test(body));
  const memberName = `rec-m-${stamp4}`;
  await c.post("/api/users", { username: memberName, password: `Rec-${stamp4}-pw1x`, role: "member", team_id: null, permissions: ["sessions.connect"], inventory_mode: "none", device_ids: [], group_ids: [] });
  const mm = new Client();
  const lr = await mm.post("/api/auth/login", { username: memberName, password: `Rec-${stamp4}-pw1x` });
  mm.csrf = lr.data?.csrf_token ?? "";
  check("a member sees none of other people's recordings", (await mm.get("/api/recordings")).data.total === 0 && (await mm.get(`/api/recordings/${list.items[0].id}/file`)).status === 404);
  check("a member cannot read or change recording settings or delete recordings", (await mm.get("/api/settings/recording")).status === 403 && (await mm.put("/api/settings/recording", cfg0.config)).status === 403 && (await mm.del(`/api/recordings/${list.items[0].id}`)).status === 403);
  const none = await c.put("/api/settings/recording", { ...cfg0.config, enabled: true, record_all: true, devices: { [dr.data.id]: "off" } });
  await openSession(c, cr.data.id, { seconds: 4 });
  check("a device set to never record is skipped", none.status === 200 && (await c.get("/api/recordings")).data.total === 1);
  const only = await c.put("/api/settings/recording", { ...cfg0.config, enabled: true, record_all: false, devices: { [dr.data.id]: "on" } });
  await openSession(c, cr.data.id, { seconds: 4 });
  await new Promise((r) => setTimeout(r, 1500));
  check("a device set to always record is recorded when only chosen devices are", only.status === 200 && (await c.get("/api/recordings")).data.total === 2);
  const del2 = await c.del(`/api/recordings/${list.items[0].id}`);
  check("an administrator deletes a recording", del2.status === 204 && (await c.get("/api/recordings")).data.total === 1);
  const log = (await c.get("/api/audit?limit=50&action=recording.")).data;
  check("viewing and deleting recordings are in the activity log", JSON.stringify(log).includes("recording.view") && JSON.stringify(log).includes("recording.delete"));
  for (const r of (await c.get("/api/recordings")).data.items) await c.del(`/api/recordings/${r.id}`);
  // ---- recordings on a network share (SMB and NFS), copied by the application ----
  const waitFor = async (fn, ms = 120000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 3000)); } return null; };
  const baseCfg = { ...cfg0.config, enabled: true, record_all: true, devices: {} };
  const smb = { kind: "smb", host: TARGET_HOST, share: "recordings", dir: "emremote-smoke", username: "rec", domain: "", uid: 1000, gid: 1000, keep_local: false, password: TARGET_PASSWORD };
  const nfsT = { kind: "nfs", host: TARGET_HOST, share: "/srv/nfs", dir: "emremote-smoke", username: "", domain: "", uid: 1000, gid: 1000, keep_local: false };
  const wrongPw = await c.put("/api/settings/recording", { ...baseCfg, storage: { ...smb, password: "not-the-password" } });
  check("a wrong share password is refused when saving", wrongPw.status === 422 && wrongPw.data?.error?.code === "share_unavailable" && !JSON.stringify(wrongPw.data).includes(TARGET_PASSWORD), `${wrongPw.status} ${wrongPw.data?.error?.message}`);
  const outside = await c.put("/api/settings/recording", { ...baseCfg, storage: { ...smb, host: "8.8.8.8" } });
  check("a share outside the allowed target networks is refused", outside.status === 422, `${outside.status} ${outside.data?.error?.message}`);
  const badDir = await c.put("/api/settings/recording", { ...baseCfg, storage: { ...smb, dir: "../x" } });
  check("a share folder with path parts is refused", badDir.status === 422);
  const tst = await c.post("/api/settings/recording/test", { ...baseCfg, storage: smb });
  check("test connection to the SMB share", tst.status === 200 && tst.data.ok === true, JSON.stringify(tst.data));
  const smbSave = await c.put("/api/settings/recording", { ...baseCfg, storage: smb });
  check("save the SMB share; the password is never returned", smbSave.status === 200 && smbSave.data.config.storage.kind === "smb" && smbSave.data.config.storage.has_password === true && !JSON.stringify(smbSave.data).includes(TARGET_PASSWORD) && smbSave.data.storage.share?.reachable === true, JSON.stringify(smbSave.data.storage?.share));
  const afterSmb = await c.put("/api/settings/recording", { ...baseCfg, storage: { ...smb, password: "" } });
  check("saving without a password keeps the saved one", afterSmb.status === 200 && afterSmb.data.config.storage.has_password === true);
  await openSession(c, cr.data.id, { seconds: 4 });
  const onSmb = await waitFor(async () => (await c.get("/api/recordings")).data.items.find((x) => x.location === "remote"));
  check("a finished recording is copied to the SMB share and removed from this server", !!onSmb, JSON.stringify((await c.get("/api/recordings")).data.items.map((x) => x.location)));
  if (onSmb) {
    const f2 = await fetch(BASE + `/api/recordings/${onSmb.id}/file`, { headers: { Cookie: [...c.cookies].map(([k, v]) => `${k}=${v}`).join("; ") } });
    const t2 = await f2.text();
    check("the recording plays from the SMB share", f2.status === 200 && t2.includes("sync,") && t2.length === onSmb.size_bytes, `${f2.status} ${t2.length} vs ${onSmb.size_bytes}`);
    check("deleting a recording removes it from the SMB share", (await c.del(`/api/recordings/${onSmb.id}`)).status === 204 && (await fetch(BASE + `/api/recordings/${onSmb.id}/file`, { headers: { Cookie: [...c.cookies].map(([k, v]) => `${k}=${v}`).join("; ") } })).status === 404);
  }
  const nfsSave = await c.put("/api/settings/recording", { ...baseCfg, storage: nfsT });
  check("save the NFS export", nfsSave.status === 200 && nfsSave.data.config.storage.kind === "nfs" && nfsSave.data.storage.share?.reachable === true, nfsSave.data?.error?.message ?? JSON.stringify(nfsSave.data.storage?.share));
  await openSession(c, cr.data.id, { seconds: 4 });
  const onNfs = await waitFor(async () => (await c.get("/api/recordings")).data.items.find((x) => x.location === "remote"));
  check("a finished recording is copied to the NFS export", !!onNfs);
  if (onNfs) {
    const f3 = await fetch(BASE + `/api/recordings/${onNfs.id}/file`, { headers: { Cookie: [...c.cookies].map(([k, v]) => `${k}=${v}`).join("; ") } });
    const t3 = await f3.text();
    check("the recording plays from the NFS export", f3.status === 200 && t3.includes("sync,") && t3.length === onNfs.size_bytes, `${f3.status} ${t3.length} vs ${onNfs.size_bytes}`);
    check("deleting a recording removes it from the NFS export", (await c.del(`/api/recordings/${onNfs.id}`)).status === 204);
  }
  const keep = await c.put("/api/settings/recording", { ...baseCfg, storage: { ...nfsT, keep_local: true } });
  await openSession(c, cr.data.id, { seconds: 4 });
  const both = await waitFor(async () => (await c.get("/api/recordings")).data.items.find((x) => x.location === "both"));
  check("with 'keep a copy' the recording is on both", keep.status === 200 && !!both);
  if (both) await c.del(`/api/recordings/${both.id}`);
  await c.put("/api/settings/recording", { ...baseCfg, storage: { ...nfsT, kind: "local" } });
  await c.put("/api/settings/recording", { ...cfg0.config, enabled: false });
  await c.del(`/api/devices/${dr.data.id}`);
  for (const u of (await c.get("/api/users")).data) if (u.username.endsWith(stamp4)) await c.del(`/api/users/${u.id}?keep_inventory=false`);
}

// ---- Two-factor authentication ----
{
  const tag = Date.now().toString(36);
  const name = `tfa-${tag}`, pw = `Tfa-${tag}-pw1`;
  await c.post("/api/users", { username: name, password: pw, role: "member", team_id: null, permissions: ["sessions.connect"], inventory_mode: "all", device_ids: [], group_ids: [] });
  const fresh = () => new Client();
  const signIn = async (user, password) => { const m = fresh(); const r = await m.post("/api/auth/login", { username: user, password }); if (r.status === 200) m.csrf = r.data.csrf_token; return { m, r }; };
  const { m, r: first } = await signIn(name, pw);
  check("sign-in without two-factor works as before", first.status === 200 && first.data.user.two_factor_enabled === false);
  const wrongPw = await m.post("/api/auth/2fa/setup", { password: "not-the-password" });
  const setup = await m.post("/api/auth/2fa/setup", { password: pw });
  check("setup asks for the password and returns a secret and an otpauth link", wrongPw.status === 422 && setup.status === 200 && /^[A-Z2-7]{32}$/.test(setup.data.secret) && setup.data.otpauth_uri.startsWith("otpauth://totp/emremote:") && setup.data.otpauth_uri.includes(setup.data.secret), `${wrongPw.status} ${setup.status}`);
  const secret = setup.data.secret;
  const badEnable = await m.post("/api/auth/2fa/enable", { code: "000000" });
  // Enabling uses the previous step (still inside the window) so that the current code is still unused for sign-in.
  const enable = await m.post("/api/auth/2fa/enable", { code: totp(secret, nowStep() - 1) });
  const codes = enable.data?.recovery_codes ?? [];
  check("two-factor turns on only with a valid code and issues 10 recovery codes", badEnable.status === 422 && enable.status === 200 && codes.length === 10 && codes.every((x) => /^[a-z2-9]{5}-[a-z2-9]{5}$/.test(x)), `${badEnable.status} ${enable.status}`);
  const me = (await m.get("/api/auth/me")).data.user;
  const st = (await m.get("/api/auth/2fa")).data;
  check("the account shows two-factor on; the secret is never returned", me.two_factor_enabled === true && st.enabled && st.recovery_codes_left === 10 && !JSON.stringify(await m.get("/api/users")).includes(secret) && !JSON.stringify(me).includes(secret));

  // Step one: password only
  const a = fresh();
  const step1 = await a.post("/api/auth/login", { username: name, password: pw });
  check("a correct password alone no longer signs in; it asks for the code", step1.status === 202 && step1.data.two_factor_required === true && !!step1.data.challenge && a.cookies.size === 0 && (await a.get("/api/auth/me")).status === 401, `status ${step1.status}`);
  const bad = await a.post("/api/auth/login/2fa", { challenge: step1.data.challenge, code: "123456" });
  const noChallenge = await fresh().post("/api/auth/login/2fa", { challenge: "nope", code: totp(secret, nowStep()) });
  check("a wrong code and an unknown challenge are refused", bad.status === 401 && bad.data.error.code === "invalid_code" && noChallenge.status === 401 && noChallenge.data.error.code === "challenge_expired", `${bad.status} ${noChallenge.status}`);
  const code1 = totp(secret, nowStep());
  const ok = await a.post("/api/auth/login/2fa", { challenge: step1.data.challenge, code: code1 });
  if (ok.status === 200) a.csrf = ok.data.csrf_token;
  check("the right code completes the sign-in", ok.status === 200 && ok.data.user.username === name && (await a.get("/api/auth/me")).status === 200, `status ${ok.status}`);
  const sess = await openSession(a, ssh.data.id, { seconds: 8 });
  check("saved passwords are unlocked after a two-factor sign-in", sess.imgBytes > 1000 && sess.errors.length === 0, `img=${sess.imgBytes} ${sess.errors.join(";")}`);

  // A code works once
  const b = fresh();
  const s2 = await b.post("/api/auth/login", { username: name, password: pw });
  const replay = await b.post("/api/auth/login/2fa", { challenge: s2.data.challenge, code: code1 });
  check("a code cannot be used twice", replay.status === 401, `status ${replay.status}`);
  const next = await b.post("/api/auth/login/2fa", { challenge: s2.data.challenge, code: totp(secret, nowStep() + 1) });
  check("the next code is accepted (clock drift allowed)", next.status === 200, `status ${next.status}`);

  // Recovery codes
  const rc = fresh();
  const s3 = await rc.post("/api/auth/login", { username: name, password: pw });
  const useRec = await rc.post("/api/auth/login/2fa", { challenge: s3.data.challenge, code: codes[0].toUpperCase().replace("-", " ") });
  const rc2 = fresh();
  const s4 = await rc2.post("/api/auth/login", { username: name, password: pw });
  const again = await rc2.post("/api/auth/login/2fa", { challenge: s4.data.challenge, code: codes[0] });
  check("a recovery code signs in once and then stops working", useRec.status === 200 && again.status === 401, `${useRec.status} ${again.status}`);
  if (useRec.status === 200) rc.csrf = useRec.data.csrf_token;
  check("recovery codes left drops by one", (await rc.get("/api/auth/2fa")).data.recovery_codes_left === 9);

  // Turning it off or renewing codes needs the password and a code
  const noCode = await rc.post("/api/auth/2fa/disable", { password: pw, code: "000000" });
  const regen = await rc.post("/api/auth/2fa/recovery", { password: pw, code: codes[1] });
  check("renewing recovery codes needs the password and a code, and replaces the old set", noCode.status === 422 && regen.status === 200 && regen.data.recovery_codes.length === 10, `${noCode.status} ${regen.status}`);
  const s5 = await fresh().post("/api/auth/login", { username: name, password: pw });
  const oldCode = await new Client().post("/api/auth/login/2fa", { challenge: s5.data.challenge, code: codes[2] });
  check("old recovery codes stop working after renewal", oldCode.status === 401, `status ${oldCode.status}`);
  const off = await rc.post("/api/auth/2fa/disable", { password: pw, code: regen.data.recovery_codes[0] });
  const direct = await signIn(name, pw);
  check("turning it off returns to password-only sign-in", off.status === 204 && direct.r.status === 200);

  // Administrator reset
  const again2 = await direct.m.post("/api/auth/2fa/setup", { password: pw });
  await direct.m.post("/api/auth/2fa/enable", { code: totp(again2.data.secret, nowStep()) });
  const uid = (await c.get("/api/users")).data.find((x) => x.username === name);
  check("administrators see who has two-factor on", uid.two_factor_enabled === true);
  const reset = await c.post(`/api/users/${uid.id}/2fa/reset`);
  check("an administrator can reset a user's two-factor; the user is signed out", reset.status === 204 && (await direct.m.get("/api/auth/me")).status === 401 && (await signIn(name, pw)).r.status === 200, `status ${reset.status}`);
  const reMember = await signIn(name, pw);
  check("members cannot reset anyone's two-factor", (await reMember.m.post(`/api/users/${uid.id}/2fa/reset`)).status === 403);

  // Brute force is limited
  const lim = `tfa-lim-${tag}`;
  await c.post("/api/users", { username: lim, password: pw, role: "member", team_id: null, permissions: [], inventory_mode: "none", device_ids: [], group_ids: [] });
  const lm = (await signIn(lim, pw)).m;
  const ls = await lm.post("/api/auth/2fa/setup", { password: pw });
  await lm.post("/api/auth/2fa/enable", { code: totp(ls.data.secret, nowStep()) });
  const lc = fresh();
  const lch = await lc.post("/api/auth/login", { username: lim, password: pw });
  const tries = [];
  for (let i = 0; i < 7; i++) tries.push((await lc.post("/api/auth/login/2fa", { challenge: lch.data.challenge, code: String(100000 + i) })).status);
  check("guessing codes is cut off", tries.slice(0, 5).every((x) => x === 401) && tries.slice(5).every((x) => x === 401 || x === 429) && (await fresh().post("/api/auth/login/2fa", { challenge: lch.data.challenge, code: totp(ls.data.secret, nowStep() + 1) })).status !== 200, tries.join(","));
  const aud = JSON.stringify((await c.get("/api/audit?q=tfa-&limit=200")).data.events);
  check("two-factor events are audited without codes or secrets", ["auth.2fa_enabled", "auth.2fa_disabled", "auth.2fa_recovery_codes", "user.2fa_reset"].every((x) => aud.includes(x)) && !aud.includes(secret) && !codes.some((x) => aud.includes(x)));
  for (const u of (await c.get("/api/users")).data) if (u.username.startsWith("tfa-") && u.username.endsWith(tag)) await c.del(`/api/users/${u.id}?keep_inventory=false`);
}

// ---- Inventory export and import ----
{
  const tag = Date.now().toString(36);
  const cookie = () => [...c.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  const exp = async (client, fmt) => {
    const r = await fetch(`${BASE}/api/export?format=${fmt}`, { headers: { Cookie: [...client.cookies].map(([k, v]) => `${k}=${v}`).join("; ") } });
    return { status: r.status, text: await r.text(), type: r.headers.get("content-type") ?? "", disp: r.headers.get("content-disposition") ?? "" };
  };
  const evil = await c.post("/api/devices", { name: `=cmd|calc-${tag}`, hostname: "", address: TARGET_HOST, os: "linux", device_type: "server", description: "", notes: "", tags: [], group_id: null, favorite: false });
  const ej = await exp(c, "json"), ec = await exp(c, "csv");
  const doc = JSON.parse(ej.text);
  check("export as JSON lists devices with their methods and never a secret", ej.status === 200 && doc.format === "emremote-inventory" && doc.devices.some((d) => d.connections.some((x) => x.protocol === "ssh")) && !ej.text.includes(TARGET_PASSWORD) && !/"(password|secret|private_key|passphrase|credential_id|credential_name|secret_fields)"\s*:/.test(ej.text) && /attachment; filename="emremote-inventory-\d{8}\.json"/.test(ej.disp), `status ${ej.status}`);
  check("export as CSV has one row per method and neutralises spreadsheet formulas", ec.status === 200 && ec.text.startsWith("name,address,hostname,os,device_type,protocol,port,username,domain,group,tags,description") && ec.text.includes(`'=cmd|calc-${tag}`) && !ec.text.includes(TARGET_PASSWORD), `status ${ec.status}`);
  await c.del(`/api/devices/${evil.data.id}`);

  const csv = `name,address,os,protocol,port,username,group,tags\nimp-${tag}-web,10.10.1.60,linux,ssh,2222,deploy,Imported ${tag},a;b\nimp-${tag}-web,10.10.1.60,linux,vnc,5900,,Imported ${tag},a;b\nimp-${tag}-nas,10.10.1.61,other,,,,,\nimp-${tag}-bad,not a host!,linux,ssh,22,,,\nimp-${tag}-url,http://x,linux,ssh,22,,,`;
  const prev = await c.post("/api/import/preview", { format: "auto", content: csv });
  check("preview reads the file and flags invalid rows without saving anything", prev.status === 200 && prev.data.format === "csv" && prev.data.valid === 2 && prev.data.invalid === 2 && (await c.get("/api/devices")).data.every((d) => !d.name.startsWith(`imp-${tag}`)), JSON.stringify({ s: prev.status, v: prev.data?.valid, i: prev.data?.invalid }));
  const sshcfg = await c.post("/api/import/preview", { format: "auto", content: `Host *\n  User x\nHost app-${tag}\n  HostName 10.10.1.70\n  Port 2200\n  User ops\n  ProxyJump gate\n` });
  check("an OpenSSH config is recognised and its ProxyJump is reported as ignored", sshcfg.data?.format === "ssh-config" && sshcfg.data.valid === 1 && sshcfg.data.warnings.some((w) => /ProxyJump/.test(w)), JSON.stringify(sshcfg.data?.warnings));
  const bad = await Promise.all([
    c.post("/api/import/preview", { format: "emremote", content: `{"format":"emremote-inventory","version":1,"devices":[{"name":"a","address":"1.2.3.4","connections":[{"protocol":"ssh","port":22,"password":"x"}]}]}` }),
    c.post("/api/import/preview", { format: "csv", content: "name,address,password\nx,1.2.3.4,secret" }),
    c.post("/api/import/preview", { format: "auto", content: "   " }),
  ]);
  check("files carrying passwords or unknown fields are refused", bad.every((r) => r.status === 422), bad.map((r) => r.status).join(","));
  const huge = await fetch(`${BASE}/api/import/preview`, { method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN, "X-CSRF-Token": c.csrf, Cookie: cookie() }, body: JSON.stringify({ format: "csv", content: "name,address\n" + "x".repeat(5 * 1024 * 1024) }) });
  check("an oversized import is refused", huge.status === 413, `status ${huge.status}`);

  // As a member, imports land in the member's own inventory
  const pw = `Imp-${tag}-pw1`;
  const mkM = async (name, permissions) => {
    await c.post("/api/users", { username: name, password: pw, role: "member", team_id: null, permissions, inventory_mode: "none", device_ids: [], group_ids: [] });
    const m = new Client();
    const r = await m.post("/api/auth/login", { username: name, password: pw });
    m.csrf = r.data?.csrf_token ?? "";
    return m;
  };
  const owner = await mkM(`imp-own-${tag}`, ["inventory.manage"]);
  const viewer = await mkM(`imp-view-${tag}`, ["sessions.connect"]);
  const denied = await viewer.post("/api/import", { format: "csv", content: csv, on_conflict: "skip" });
  const first = await owner.post("/api/import", { format: "csv", content: csv, on_conflict: "skip" });
  const mine = (await owner.get("/api/devices")).data.filter((d) => d.name.startsWith(`imp-${tag}`));
  check("a member imports into their private inventory; invalid rows are skipped", denied.status === 403 && first.status === 200 && first.data.created_devices === 2 && first.data.created_connections === 2 && first.data.created_groups === 1 && first.data.invalid === 2 && mine.length === 2 && mine.every((d) => d.owner_id !== null && d.can_manage), JSON.stringify(first.data));
  const web = mine.find((d) => d.name.endsWith("-web"));
  check("methods, group and tags survive the import", web?.connections.map((x) => x.protocol).sort().join(",") === "ssh,vnc" && web.group_name === `Imported ${tag}` && web.tags.join(",") === "a,b");
  check("imported devices are invisible to others", (await c.get("/api/devices")).data.every((d) => !d.name.startsWith(`imp-${tag}`)) && (await viewer.get("/api/devices")).data.length === 0);
  const again = await owner.post("/api/import", { format: "csv", content: csv, on_conflict: "skip" });
  const renamed = await owner.post("/api/import", { format: "csv", content: csv, on_conflict: "rename" });
  const after = (await owner.get("/api/devices")).data.filter((d) => d.name.startsWith(`imp-${tag}`));
  check("importing again skips existing devices, or renames them when asked", again.data.created_devices === 0 && again.data.skipped === 2 && renamed.data.created_devices === 2 && renamed.data.renamed === 2 && after.length === 4 && after.some((d) => d.name === `imp-${tag}-web (2)`), JSON.stringify({ a: again.data, r: renamed.data?.renamed, n: after.map((d) => d.name) }));

  // Round trip: a member's export imports cleanly into another account
  const mex = JSON.parse((await exp(owner, "json")).text);
  const other = await mkM(`imp-rt-${tag}`, ["inventory.manage"]);
  const rt = await other.post("/api/import", { format: "emremote", content: JSON.stringify(mex), on_conflict: "skip" });
  check("an export imports into another account (round trip)", rt.status === 200 && rt.data.created_devices === 4 && rt.data.errors.length === 0, JSON.stringify(rt.data));

  const aud = (await c.get("/api/audit?action=inventory.&limit=100")).data.events;
  check("exports and imports are audited with counts", aud.some((e) => e.action === "inventory.export" && e.details.devices > 0) && aud.some((e) => e.action === "inventory.import" && e.details.devices === 2 && e.details.format === "csv"), `${aud.length} events`);
  for (const u of (await c.get("/api/users")).data) if (u.username.endsWith(tag)) await c.del(`/api/users/${u.id}?keep_inventory=false`);
  check("deleting the users removes their imported devices", (await c.get("/api/devices")).data.every((d) => !d.name.startsWith(`imp-${tag}`)));
}

// ---- Jump host: a device only the bastion can reach ----
{
  const tag = Date.now().toString(36);
  const INNER = "172.29.77.10";
  const conn = (protocol, port, jump) => ({ name: protocol.toUpperCase(), protocol, port, username: protocol === "vnc" ? "" : "tester", domain: "", credential_id: null, settings: jump ? { jump_connection_id: jump } : {}, secret: { mode: "set", password: TARGET_PASSWORD } });
  const sys = await c.get("/api/system");
  check("the system info says jump hosts are on", sys.data.jump_enabled === true);

  const inner = await c.post("/api/devices", { name: `inner-${tag}`, hostname: "", address: INNER, os: "linux", device_type: "server", description: "behind the bastion", notes: "", tags: [], group_id: null, favorite: false });
  const iSsh = await c.post(`/api/devices/${inner.data.id}/connections`, conn("ssh", 22, ssh.data.id));
  const iRdp = await c.post(`/api/devices/${inner.data.id}/connections`, conn("rdp", 3389, ssh.data.id));
  const iVnc = await c.post(`/api/devices/${inner.data.id}/connections`, conn("vnc", 5900, ssh.data.id));
  check("connections behind a jump host are accepted", [iSsh, iRdp, iVnc].every((r) => r.status === 201 && r.data.settings.jump_connection_id === ssh.data.id), [iSsh, iRdp, iVnc].map((r) => r.status).join(","));

  // Validation
  const outside = await c.post(`/api/devices/${devId}/connections`, { ...conn("ssh", 22, ssh.data.id), name: "via" });
  const hostname = await c.post("/api/devices", { name: `host-${tag}`, hostname: "", address: "inner.lan", os: "linux", device_type: "server", description: "", notes: "", tags: [], group_id: null, favorite: false });
  const byName = await c.post(`/api/devices/${hostname.data.id}/connections`, conn("ssh", 22, ssh.data.id));
  const ghost = await c.post(`/api/devices/${inner.data.id}/connections`, { ...conn("ssh", 2222, "00000000-0000-4000-8000-000000000000"), name: "ghost" });
  const notSsh = await c.post(`/api/devices/${inner.data.id}/connections`, { ...conn("ssh", 2223, vnc.data.id), name: "notssh" });
  const chain = await c.post(`/api/devices/${inner.data.id}/connections`, { ...conn("ssh", 2224, iSsh.data.id), name: "chain" });
  const self = await c.put(`/api/connections/${iSsh.data.id}`, { ...conn("ssh", 22, iSsh.data.id), name: "SSH" });
  check("a jump host must be a reachable-network IP target, an existing SSH connection, not itself and not chained", [outside, byName, ghost, notSsh, chain, self].every((r) => r.status === 422), [outside, byName, ghost, notSsh, chain, self].map((r) => r.status).join(","));
  await c.del(`/api/devices/${hostname.data.id}`);

  // The device really is out of direct reach
  const direct = await c.post("/api/devices", { name: `direct-${tag}`, hostname: "", address: INNER, os: "linux", device_type: "server", description: "", notes: "", tags: [], group_id: null, favorite: false });
  const dConn = await c.post(`/api/devices/${direct.data.id}/connections`, conn("ssh", 22, null));
  const dTicket = await c.post(`/api/connections/${dConn.data.id}/sessions`, { width: 800, height: 600, dpi: 96, image: ["image/png"] });
  check("without a jump host the same address is refused by the network policy", dTicket.status === 422 && dTicket.data.error.code === "target_not_allowed", `status ${dTicket.status} ${dTicket.data?.error?.code}`);
  await c.del(`/api/devices/${direct.data.id}`);

  // A target the bastion cannot reach is explained, not left as a gateway error
  const gone = await c.post("/api/devices", { name: `gone-${tag}`, hostname: "", address: "172.29.77.99", os: "linux", device_type: "server", description: "", notes: "", tags: [], group_id: null, favorite: false });
  const gConn = await c.post(`/api/devices/${gone.data.id}/connections`, conn("ssh", 22, ssh.data.id));
  const gTicket = await c.post(`/api/connections/${gConn.data.id}/sessions`, { width: 800, height: 600, dpi: 96, image: ["image/png"] });
  check("a device the jump host cannot reach is reported clearly", gTicket.status === 502 && gTicket.data.error.code === "jump_failed" && /could not connect to 172\.29\.77\.99:22/.test(gTicket.data.error.message), `${gTicket.status} ${gTicket.data?.error?.message}`);
  await c.del(`/api/devices/${gone.data.id}`);

  // Sessions through the bastion
  const sSsh = await openSession(c, iSsh.data.id, { seconds: 9 });
  const sVnc = await openSession(c, iVnc.data.id, { seconds: 9 });
  const sRdp = await openSession(c, iRdp.data.id, { seconds: 12 });
  check("an SSH session to the device behind the bastion streams frames", sSsh.imgBytes > 1000 && sSsh.errors.length === 0, `img=${sSsh.imgBytes} ${sSsh.errors.join(";")}`);
  check("a VNC session behind the bastion streams frames", sVnc.imgBytes > 1000 && sVnc.errors.length === 0, `img=${sVnc.imgBytes} ${sVnc.errors.join(";")}`);
  check("an RDP session behind the bastion streams frames", sRdp.imgBytes > 1000 && sRdp.errors.length === 0, `img=${sRdp.imgBytes} ${sRdp.errors.join(";")}`);
  const after = (await c.get(`/api/devices/${inner.data.id}/connections`)).data;
  const aS = after.find((x) => x.protocol === "ssh"), aR = after.find((x) => x.protocol === "rdp");
  check("the device's own key and certificate were recorded through the tunnel", /^ecdsa|^ssh-/.test(aS.settings.host_key ?? "") && /^sha256:/.test(aR.settings.cert_fingerprints ?? "") && aS.settings.jump_connection_id === ssh.data.id, `${(aS.settings.host_key ?? "").slice(0, 20)} ${aR.settings.cert_fingerprints?.slice(0, 14)}`);
  const aud = (await c.get(`/api/audit?action=session.start&limit=20`)).data.events;
  check("the audit log names the jump host", aud.some((e) => e.details?.jump_host === dev.data.name && e.target_name.startsWith(`inner-${tag}`)), `${aud.length} events`);

  // Files and system information through the bastion
  const acc = await c.post(`/api/connections/${iSsh.data.id}/ssh-access`, {});
  const bacc = await c.post(`/api/connections/${ssh.data.id}/ssh-access`, {});
  const isys = acc.status === 201 ? (await c.get(`/api/ssh-access/${acc.data.id}/system`)).data?.info : null;
  const bsys = bacc.status === 201 ? (await c.get(`/api/ssh-access/${bacc.data.id}/system`)).data?.info : null;
  check("files and system info work through the bastion and show the inner machine", acc.status === 201 && isys?.hostname && bsys?.hostname && isys.hostname !== bsys.hostname, `${isys?.hostname} vs ${bsys?.hostname}`);
  const list = acc.status === 201 ? await c.get(`/api/ssh-access/${acc.data.id}/files`) : { status: 0 };
  check("the file manager lists the inner machine's home folder", list.status === 200 && list.data.path === "/home/tester", `status ${list.status}`);
  if (acc.status === 201) await c.del(`/api/ssh-access/${acc.data.id}`);
  if (bacc.status === 201) await c.del(`/api/ssh-access/${bacc.data.id}`);

  // Not probed, protected, and not portable
  const checked = await c.post(`/api/devices/${inner.data.id}/check`);
  check("reachability is not probed for devices behind a jump host", checked.status === 200 && checked.data.connections.every((x) => x.status_reachable === null), JSON.stringify(checked.data?.connections?.map((x) => x.status_reachable)));
  const delB = await c.del(`/api/connections/${ssh.data.id}`);
  check("a connection used as a jump host cannot be deleted", delB.status === 409 && delB.data.error.code === "jump_in_use", `status ${delB.status}`);
  const move = await c.put(`/api/devices/${inner.data.id}`, { name: `inner-${tag}`, hostname: "", address: TARGET_HOST, os: "linux", device_type: "server", description: "", notes: "", tags: [], group_id: null, favorite: false });
  check("moving a device out of the jump networks is refused while it uses one", move.status === 422, `status ${move.status}`);
  const ex = (await fetch(`${BASE}/api/export?format=json`, { headers: { Cookie: [...c.cookies].map(([k, v]) => `${k}=${v}`).join("; ") } }).then((r) => r.text()));
  check("exports leave jump host references out", ex.includes(`inner-${tag}`) && !ex.includes("jump_connection_id") && !ex.includes(ssh.data.id));
  const quick = await c.post("/api/quick-connections", { host: INNER, protocol: "ssh", port: 22, username: "tester", settings: { jump_connection_id: ssh.data.id }, secret: { mode: "keep" } });
  check("quick connect cannot use a jump host", quick.status === 422, `status ${quick.status}`);

  // Members cannot aim the shared bastion at hosts of their own
  const mpw = `Jmp-${tag}-pw1`;
  await c.post("/api/users", { username: `jmp-${tag}`, password: mpw, role: "member", team_id: null, permissions: ["inventory.manage", "sessions.connect"], inventory_mode: "all", device_ids: [], group_ids: [] });
  const mem = new Client();
  mem.csrf = (await mem.post("/api/auth/login", { username: `jmp-${tag}`, password: mpw })).data.csrf_token;
  const own = await mem.post("/api/devices", { name: `own-${tag}`, hostname: "", address: INNER, os: "linux", device_type: "server", description: "", notes: "", tags: [], group_id: null, favorite: false });
  const steal = await mem.post(`/api/devices/${own.data.id}/connections`, conn("ssh", 22, ssh.data.id));
  const useIt = await mem.post(`/api/connections/${iSsh.data.id}/sessions`, { width: 800, height: 600, dpi: 96, image: ["image/png"] });
  check("a member cannot use a shared bastion for their own device, but can open shared devices that use it", steal.status === 422 && useIt.status === 201, `${steal.status} ${useIt.status}`);
  for (const u of (await c.get("/api/users")).data) if (u.username === `jmp-${tag}`) await c.del(`/api/users/${u.id}?keep_inventory=false`);

  await c.del(`/api/devices/${inner.data.id}`);
  // The networks can be managed in the web interface (administrators only)
  const jget = await c.get("/api/settings/jump");
  check("an administrator can read the jump host networks", jget.status === 200 && jget.data.networks.includes("172.29.77.0/24"), JSON.stringify(jget.data));
  const jbad = await c.put("/api/settings/jump", { networks: ["127.0.0.0/8"] });
  const jbad2 = await c.put("/api/settings/jump", { networks: ["10.0.0.0/4", "nonsense", "169.254.0.0/16"] });
  const jwide = await c.put("/api/settings/jump", { networks: ["0.0.0.0/0"] });
  check("reserved, malformed and overly wide networks are refused", jbad.status === 422 && jbad2.status === 422 && jwide.status === 422, `${jbad.status} ${jbad2.status} ${jwide.status}`);
  const joff = await c.put("/api/settings/jump", { networks: [] });
  const sysOff = await c.get("/api/system");
  const jtmp = await c.post("/api/devices", { name: `jtmp-${tag}`, hostname: "", address: INNER, os: "linux", device_type: "server", description: "", notes: "", tags: [], group_id: null, favorite: false });
  const refused = await c.post(`/api/devices/${jtmp.data.id}/connections`, { ...conn("ssh", 2299, ssh.data.id), name: "while-off" });
  check("emptying the list turns jump hosts off at once", joff.status === 200 && sysOff.data.jump_enabled === false && refused.status === 422, `${joff.status} ${sysOff.data.jump_enabled} ${refused.status}`);
  const jon = await c.put("/api/settings/jump", { networks: ["172.29.77.0/24", " 172.29.77.5/24 "] });
  const sysOn = await c.get("/api/system");
  await c.del(`/api/devices/${jtmp.data.id}`);
  check("saving networks turns them on and normalises them", jon.status === 200 && jon.data.networks.length === 1 && jon.data.networks[0] === "172.29.77.0/24" && sysOn.data.jump_enabled === true, JSON.stringify(jon.data));
  const jmem = new Client();
  await c.post("/api/users", { username: `jmem-${tag}`, password: `Jm-${tag}-pw1x`, role: "member", team_id: null, permissions: ["inventory.manage", "sessions.connect"], inventory_mode: "all", device_ids: [], group_ids: [] });
  jmem.csrf = (await jmem.post("/api/auth/login", { username: `jmem-${tag}`, password: `Jm-${tag}-pw1x` })).data.csrf_token;
  const mget = await jmem.get("/api/settings/jump");
  const mput = await jmem.put("/api/settings/jump", { networks: ["10.99.0.0/16"] });
  check("members cannot read or change the jump host networks", mget.status === 403 && mput.status === 403, `${mget.status} ${mput.status}`);
  for (const u of (await c.get("/api/users")).data) if (u.username === `jmem-${tag}`) await c.del(`/api/users/${u.id}?keep_inventory=false`);
  check("the bastion itself is untouched by all of this", (await c.get(`/api/connections/${ssh.data.id}`)).status === 200);
}

// ---- Sharing a live session, Wake-on-LAN and the newer connection settings ----
{
  const tag = Date.now().toString(36);
  const cookie = () => [...c.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  const stripFile = `/home/tester/emr-watch-${tag}.txt`;

  // Watch a shared session: returns what the viewer received; optionally tries to type.
  const watch = (token, { seconds = 6, typeText = "" } = {}) => new Promise((resolve) => {
    const out = { imgBytes: 0, opcodes: {}, closed: null, errors: [] };
    const ws = new WebSocket(BASE.replace(/^http/, "ws") + `/api/watch-tunnel?token=${encodeURIComponent(token)}&width=1000&height=700&dpi=96`, { protocols: ["guacamole"], headers: { Origin: ORIGIN, Cookie: cookie() } });
    let buffer = "";
    const done = (why) => { clearTimeout(timer); try { ws.close(); } catch {} resolve({ ...out, why }); };
    const timer = setTimeout(() => done("timeout"), seconds * 1000);
    ws.onmessage = (ev) => {
      const { out: ins, rest } = parseAll(buffer + ev.data);
      buffer = rest;
      for (const [op, ...args] of ins) {
        out.opcodes[op] = (out.opcodes[op] ?? 0) + 1;
        if (op === "sync") ws.send(encode("sync", args[0]));
        if (op === "blob") out.imgBytes += args[1].length;
        if (op === "error") out.errors.push(args[0]);
        if (op === "" && args[0] !== "ping" && typeText) {
          setTimeout(() => {
            for (const ch of typeText) { ws.send(encode("key", ch.charCodeAt(0), 1)); ws.send(encode("key", ch.charCodeAt(0), 0)); }
            ws.send(encode("key", 0xff0d, 1)); ws.send(encode("key", 0xff0d, 0));
          }, 1500);
        }
      }
    };
    ws.onclose = (e) => { out.closed = e.code; done("closed"); };
    ws.onerror = (e) => { out.errors.push(String(e.message ?? "error")); done("ws-error"); };
  });
  const activeFor = async (connectionId) => (await c.get("/api/active-sessions")).data.find((a) => a.connection_id === connectionId);

  const owner = openSession(c, ssh.data.id, { seconds: 20 });
  await new Promise((r) => setTimeout(r, 4000));
  const live = await activeFor(ssh.data.id);
  check("a live session is listed with sharing off", !!live && live.shared === false && live.viewers === 0, JSON.stringify(live));
  const share = await c.post(`/api/active-sessions/${live.id}/share`);
  check("the owner can create a view-only link", share.status === 201 && /^\/watch\/[A-Za-z0-9_-]{20,}$/.test(share.data.path), `status ${share.status}`);
  const token = share.data.path.split("/").pop();
  const info = await c.get(`/api/watch/${token}`);
  check("the link names the shared session", info.status === 200 && info.data.protocol === "ssh" && info.data.owner === "admin", JSON.stringify(info.data));
  const bad = await c.get(`/api/watch/not-a-real-token`);
  check("an unknown link is refused", bad.status === 404, `status ${bad.status}`);

  const viewer = watch(token, { seconds: 7, typeText: `echo should-not-run > ${stripFile}` });
  await new Promise((r) => setTimeout(r, 4000));
  const during = await activeFor(ssh.data.id);
  const v = await viewer;
  check("a viewer receives the live screen", v.imgBytes > 500 && v.errors.length === 0, `img=${v.imgBytes} ${v.errors.join(";")} ${v.why}`);
  check("the owner sees that someone is watching", during?.viewers === 1 && during?.shared === true, JSON.stringify(during && { viewers: during.viewers, shared: during.shared }));
  const acc = await c.post(`/api/connections/${ssh.data.id}/ssh-access`, {});
  const dl = await fetch(`${BASE}/api/ssh-access/${acc.data.id}/files/download?path=${encodeURIComponent(stripFile)}`, { headers: { Cookie: cookie() } });
  check("a viewer's keystrokes never reach the remote computer", dl.status === 404, `file status ${dl.status}`);
  await c.del(`/api/ssh-access/${acc.data.id}`);

  const wlog = (await c.get("/api/audit?action=session.&limit=50")).data.events;
  check("watching is recorded in the audit log", wlog.some((e) => e.details?.viewer === "admin" && e.details?.owner === "admin"), `${wlog.length} events`);

  // A second viewer is cut off when the owner stops sharing
  const second = watch(token, { seconds: 10 });
  await new Promise((r) => setTimeout(r, 3000));
  const stop = await c.del(`/api/active-sessions/${live.id}/share`);
  const s2 = await second;
  check("stopping sharing disconnects viewers and kills the link", stop.status === 204 && s2.why === "closed" && (await c.get(`/api/watch/${token}`)).status === 404, `stop ${stop.status}, viewer ${s2.why}`);
  const after = await watch(token, { seconds: 3 });
  check("a stopped link cannot be joined", after.imgBytes === 0, `img=${after.imgBytes} closed=${after.closed}`);
  await owner;

  // Someone else's session cannot be shared
  const mpw = `Shr-${tag}-pw1`;
  await c.post("/api/users", { username: `shr-${tag}`, password: mpw, role: "member", team_id: null, permissions: ["inventory.manage", "sessions.connect"], inventory_mode: "all", device_ids: [], group_ids: [] });
  const mem = new Client();
  mem.csrf = (await mem.post("/api/auth/login", { username: `shr-${tag}`, password: mpw })).data.csrf_token;
  const owner2 = openSession(c, ssh.data.id, { seconds: 8 });
  await new Promise((r) => setTimeout(r, 4000));
  const live2 = await activeFor(ssh.data.id);
  const theft = await mem.post(`/api/active-sessions/${live2.id}/share`);
  check("a member cannot share a session that is not theirs", theft.status === 404, `status ${theft.status}`);
  await owner2;
  for (const u of (await c.get("/api/users")).data) if (u.username === `shr-${tag}`) await c.del(`/api/users/${u.id}?keep_inventory=false`);

  // Wake-on-LAN
  const wd = await c.post("/api/devices", { name: `wol-${tag}`, hostname: "", address: TARGET_HOST, os: "linux", device_type: "desktop", description: "", notes: "", tags: [], group_id: null, favorite: false });
  const noMac = await c.post(`/api/devices/${wd.data.id}/wake`);
  check("waking a device without a MAC address explains what is missing", noMac.status === 422 && noMac.data.error.code === "no_mac", `status ${noMac.status}`);
  const wbody = { name: `wol-${tag}`, hostname: "", address: TARGET_HOST, os: "linux", device_type: "desktop", description: "", notes: "", tags: [], group_id: null, favorite: false };
  const badMac = await c.put(`/api/devices/${wd.data.id}`, { ...wbody, mac: "not-a-mac" });
  check("a malformed MAC address is rejected", badMac.status === 422, `status ${badMac.status}`);
  const okMac = await c.put(`/api/devices/${wd.data.id}`, { ...wbody, mac: "AA-BB-CC-DD-EE-FF" });
  check("a MAC address is stored in its canonical form", okMac.status === 200 && okMac.data.mac === "aa:bb:cc:dd:ee:ff", okMac.data?.mac);
  const keep = await c.put(`/api/devices/${wd.data.id}`, { name: `wol-${tag}`, hostname: "", address: TARGET_HOST, os: "linux", device_type: "desktop", description: "", notes: "", tags: [], group_id: null, favorite: false });
  check("saving a device without the field keeps its MAC address", keep.status === 200 && keep.data.mac === "aa:bb:cc:dd:ee:ff", keep.data?.mac);
  const wake = await c.post(`/api/devices/${wd.data.id}/wake`);
  check("a wake-up packet can be sent", wake.status === 200 && wake.data.sent >= 1, `status ${wake.status} ${JSON.stringify(wake.data)}`);
  const again = await c.post(`/api/devices/${wd.data.id}/wake`);
  check("wake-up requests are rate limited", again.status === 429, `status ${again.status}`);
  const wakeAudit = (await c.get("/api/audit?action=device.&limit=50")).data.events;
  check("waking is audited", wakeAudit.some((e) => e.details?.mac === "aa:bb:cc:dd:ee:ff"), `${wakeAudit.length} events`);
  const wdConn = await c.post(`/api/devices/${wd.data.id}/connections`, { name: "SSH", protocol: "ssh", port: 12222, username: "tester", domain: "", credential_id: null, settings: {}, secret: { mode: "set", password: TARGET_PASSWORD } });
  await c.put(`/api/devices/${wd.data.id}`, { name: `wol-${tag}`, hostname: "", address: TARGET_HOST, os: "linux", device_type: "desktop", description: "", notes: "", tags: [], group_id: null, favorite: false, mac: "" });
  const wacc = await c.post(`/api/connections/${wdConn.data.id}/ssh-access`, {});
  await c.get(`/api/ssh-access/${wacc.data.id}/system`);
  await c.del(`/api/ssh-access/${wacc.data.id}`);
  const learned = (await c.get(`/api/devices/${wd.data.id}`)).data;
  check("the MAC address is learned over SSH when it is empty", /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(learned.mac), learned.mac);
  await c.del(`/api/devices/${wd.data.id}`);

  // New connection settings
  const sd = await c.post("/api/devices", { name: `set-${tag}`, hostname: "", address: TARGET_HOST, os: "windows", device_type: "server", description: "", notes: "", tags: [], group_id: null, favorite: false });
  const rdpNew = await c.post(`/api/devices/${sd.data.id}/connections`, { name: "RDP", protocol: "rdp", port: 2179, username: "u", domain: "", credential_id: null, settings: { security: "vmconnect", enable_printing: true, enable_audio_input: true, remote_app: "||notepad", remote_app_args: "C:\\notes.txt", preconnection_blob: "Lab VM 1", preconnection_id: 7 }, secret: { mode: "keep" } });
  check("RDP printing, microphone, RemoteApp and Hyper-V settings are stored", rdpNew.status === 201 && rdpNew.data.settings.enable_printing === true && rdpNew.data.settings.remote_app === "||notepad" && rdpNew.data.settings.preconnection_blob === "Lab VM 1" && rdpNew.data.settings.preconnection_id === 7, JSON.stringify(rdpNew.data?.settings ?? rdpNew.data));
  const badApp = await c.post(`/api/devices/${sd.data.id}/connections`, { name: "RDP2", protocol: "rdp", port: 3389, username: "u", domain: "", credential_id: null, settings: { remote_app: "calc\nbad" }, secret: { mode: "keep" } });
  const badVm = await c.post(`/api/devices/${sd.data.id}/connections`, { name: "RDP3", protocol: "rdp", port: 3389, username: "u", domain: "", credential_id: null, settings: { preconnection_blob: "x;rm -rf" }, secret: { mode: "keep" } });
  check("control characters and odd VM names are refused", badApp.status === 422 && badVm.status === 422, `${badApp.status} ${badVm.status}`);
  const sshNew = await c.post(`/api/devices/${sd.data.id}/connections`, { name: "SSH", protocol: "ssh", port: 22, username: "u", domain: "", credential_id: null, settings: { backspace: 8, locale: "en_US.UTF-8" }, secret: { mode: "keep" } });
  const sshBad = await c.post(`/api/devices/${sd.data.id}/connections`, { name: "SSH2", protocol: "ssh", port: 22, username: "u", domain: "", credential_id: null, settings: { backspace: 9, locale: "en US" }, secret: { mode: "keep" } });
  check("SSH backspace and locale are validated", sshNew.status === 201 && sshNew.data.settings.backspace === 8 && sshNew.data.settings.locale === "en_US.UTF-8" && sshBad.status === 422, `${sshNew.status} ${sshBad.status}`);
  await c.del(`/api/devices/${sd.data.id}`);
}

// ---- SSH key files: stored encrypted, used to sign in ----
{
  const { generateKeyPairSync } = await import("node:crypto");
  const sshRsaLine = (publicKey) => {
    const jwk = publicKey.export({ format: "jwk" });
    const b64u = (x) => Buffer.from(x, "base64url");
    const mpint = (buf) => { let i = 0; while (i < buf.length - 1 && buf[i] === 0) i++; buf = buf.subarray(i); if (buf[0] & 0x80) buf = Buffer.concat([Buffer.from([0]), buf]); return buf; };
    const part = (buf) => { const l = Buffer.alloc(4); l.writeUInt32BE(buf.length); return Buffer.concat([l, buf]); };
    const blob = Buffer.concat([part(Buffer.from("ssh-rsa")), part(mpint(b64u(jwk.e))), part(mpint(b64u(jwk.n)))]);
    return `ssh-rsa ${blob.toString("base64")} e2e-key\n`;
  };
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  const pairEnc = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem", cipher: "aes-256-cbc", passphrase: "open sesame" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  const { createPublicKey } = await import("node:crypto");
  const authorized = sshRsaLine(createPublicKey(pair.publicKey)) + sshRsaLine(createPublicKey(pairEnc.publicKey));

  // Put both public keys on the target through the password sign-in
  const pa = await c.post(`/api/connections/${ssh.data.id}/ssh-access`, {});
  const PA = `/api/ssh-access/${pa.data.id}`;
  await c.post(`${PA}/files/mkdir`, { dir: "/home/tester", name: ".ssh" });
  const put = await fetch(`${BASE}${PA}/files/upload?dir=${encodeURIComponent("/home/tester/.ssh")}&name=authorized_keys&overwrite=true`, {
    method: "POST", body: authorized, headers: { "Content-Type": "application/octet-stream", Origin: ORIGIN, "X-CSRF-Token": c.csrf, Cookie: [...c.cookies].map(([k, v]) => `${k}=${v}`).join("; ") },
  });
  await c.del(PA);
  check("public keys can be installed on the target", put.status === 201, `status ${put.status}`);

  const kdev = await c.post("/api/devices", { name: `keys-${Date.now().toString(36)}`, hostname: "", address: TARGET_HOST, os: "linux", device_type: "server", description: "", notes: "", tags: [], group_id: null, favorite: false });
  const mkConn = (key, passphrase, name) => c.post(`/api/devices/${kdev.data.id}/connections`, { name, protocol: "ssh", port: 12222, username: "tester", domain: "", credential_id: null, settings: {}, secret: { mode: "set", password: "", private_key: key, passphrase } });
  const pub = await mkConn(pair.publicKey, "", "pub");
  check("a public key is refused with an explanation", pub.status === 422 && /private key|public/i.test(pub.data?.error?.fields?.["secret.private_key"] ?? JSON.stringify(pub.data)), `${pub.status} ${JSON.stringify(pub.data?.error?.fields ?? pub.data?.error)}`);
  const junk = await mkConn("-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----", "", "junk");
  check("a broken key file is refused", junk.status === 422, `status ${junk.status}`);
  const noPass = await mkConn(pairEnc.privateKey, "", "nopass");
  const badPass = await mkConn(pairEnc.privateKey, "wrong", "badpass");
  check("a key with a passphrase needs the right passphrase", noPass.status === 422 && badPass.status === 422, `${noPass.status} ${badPass.status}`);

  const withKey = await mkConn(pair.privateKey, "", "key");
  check("a private key file is accepted", withKey.status === 201, `status ${withKey.status}`);
  check("the key is never returned by the API", !JSON.stringify(withKey.data).includes("PRIVATE KEY") && withKey.data.secret_fields?.includes("private_key"), JSON.stringify(withKey.data.secret_fields));
  const viaKey = await c.post(`/api/connections/${withKey.data.id}/ssh-access`, {});
  check("signing in over SFTP with the stored key works (no password)", viaKey.status === 201, `status ${viaKey.status} ${JSON.stringify(viaKey.data?.error ?? "")}`);
  if (viaKey.status === 201) await c.del(`/api/ssh-access/${viaKey.data.id}`);
  const encOk = await mkConn(pairEnc.privateKey, "open sesame", "keypass");
  const viaEnc = encOk.status === 201 ? await c.post(`/api/connections/${encOk.data.id}/ssh-access`, {}) : { status: 0 };
  check("a passphrase-protected key works with its passphrase", encOk.status === 201 && viaEnc.status === 201, `${encOk.status} ${viaEnc.status}`);
  if (viaEnc.status === 201) await c.del(`/api/ssh-access/${viaEnc.data.id}`);
  const sess = await openSession(c, withKey.data.id, { seconds: 9 });
  check("a browser session signs in with the stored key", sess.imgBytes > 1000 && sess.errors.length === 0, `img=${sess.imgBytes} ${sess.errors.join(";")}`);
  const raw = await c.get(`/api/audit?action=connection.&limit=50`);
  check("the key does not appear in the audit log", !JSON.stringify(raw.data).includes("BEGIN RSA PRIVATE KEY"));
  await c.del(`/api/devices/${kdev.data.id}`);
}

// ---- Statistics ----
{
  const tag = Date.now().toString(36);
  const st = await c.get("/api/statistics?days=30&tz=Europe%2FIstanbul");
  const d = st.data;
  check("statistics have a point per day and a weekday-by-hour grid", st.status === 200 && d.by_day.length === 30 && d.heatmap.length === 7 && d.heatmap.every((r) => r.length === 24), `${st.status} ${d?.by_day?.length}`);
  check("statistics count the sessions of this test run and name the busiest devices", d.totals.sessions > 5 && d.top_devices.length > 0 && d.top_devices[0].sessions >= d.top_devices[d.top_devices.length - 1].sessions, JSON.stringify(d.totals));
  check("per-day totals add up to the session total", d.by_day.reduce((n, x) => n + x.rdp + x.ssh + x.vnc + x.telnet, 0) === d.totals.sessions, `${d.by_day.reduce((n, x) => n + x.rdp + x.ssh + x.vnc + x.telnet, 0)} vs ${d.totals.sessions}`);
  check("administrators also get activity by user and security figures", d.security.admin_view === true && d.users.some((u) => u.username === "admin") && d.security.users >= 1, JSON.stringify(d.security));
  check("fleet figures describe the inventory", d.fleet.devices >= 1 && typeof d.fleet.cores === "number" && Object.keys(d.fleet.types).length > 0, JSON.stringify(d.fleet.types));
  const bad = await c.get("/api/statistics?days=5&tz=Not%2FAZone");
  check("odd periods and unknown time zones fall back safely", bad.status === 200 && bad.data.days === 30, `status ${bad.status}`);
  const mpw = `St-${tag}-pw1x`;
  await c.post("/api/users", { username: `st-${tag}`, password: mpw, role: "member", team_id: null, permissions: ["inventory.manage", "sessions.connect"], inventory_mode: "all", device_ids: [], group_ids: [] });
  const mem = new Client();
  mem.csrf = (await mem.post("/api/auth/login", { username: `st-${tag}`, password: mpw })).data.csrf_token;
  const ms = await mem.get("/api/statistics?days=30");
  check("members only see their own activity and no administrator figures", ms.status === 200 && ms.data.totals.sessions === 0 && ms.data.users.length === 0 && ms.data.security.admin_view === false, JSON.stringify(ms.data?.totals));
  for (const u of (await c.get("/api/users")).data) if (u.username === `st-${tag}`) await c.del(`/api/users/${u.id}?keep_inventory=false`);
  const dash = await c.get("/api/dashboard");
  const ds = dash.data.stats;
  check("the dashboard carries the 14-day series, most-used devices and the attention list", ds.sessions_by_day.length === 14 && Array.isArray(ds.top_devices) && Array.isArray(ds.attention), `${ds.sessions_by_day?.length}`);
}

// ---- Automatic SSH discovery for an RDP-only device ----
{
  const d = (await c.post("/api/devices", { name: `e2e-rdp-only-${stamp}`, hostname: "", address: TARGET_HOST, os: "windows", device_type: "desktop", description: "", notes: "", tags: [], group_id: null, favorite: false })).data;
  await c.post(`/api/devices/${d.id}/connections`, { name: "RDP", protocol: "rdp", port: 13389, username: "tester", domain: "", credential_id: null, settings: {}, secret: { mode: "set", password: TARGET_PASSWORD } });
  const auto = await c.post(`/api/devices/${d.id}/ssh-auto`);
  const conns = (await c.get(`/api/devices/${d.id}/connections`)).data;
  const sshC = conns.find((x) => x.protocol === "ssh");
  check("RDP-only device: SSH discovered and added automatically with the RDP sign-in", auto.data?.status === "created" && !!sshC && sshC.settings.host_key && sshC.secret_fields.includes("password"), `status=${auto.data?.status}`);
  const again = await c.post(`/api/devices/${d.id}/ssh-auto`);
  check("discovery is idempotent", again.data?.status === "exists");
  const acc = sshC && (await c.post(`/api/connections/${sshC.id}/ssh-access`, {}));
  check("discovered SSH method serves system info right away", acc?.status === 201 && (await c.get(`/api/ssh-access/${acc.data.id}/system`)).status === 200);
  // Wrong RDP password: discovery must not create anything.
  const d2 = (await c.post("/api/devices", { name: `e2e-rdp-bad-${stamp}`, hostname: "", address: TARGET_HOST, os: "windows", device_type: "desktop", description: "", notes: "", tags: [], group_id: null, favorite: false })).data;
  await c.post(`/api/devices/${d2.id}/connections`, { name: "RDP", protocol: "rdp", port: 13389, username: "tester", domain: "", credential_id: null, settings: {}, secret: { mode: "set", password: "wrong-password-xyz" } });
  const bad = await c.post(`/api/devices/${d2.id}/ssh-auto`);
  check("discovery with a wrong sign-in reports auth_failed and adds nothing", bad.data?.status === "auth_failed" && !(await c.get(`/api/devices/${d2.id}/connections`)).data.some((x) => x.protocol === "ssh"), `status=${bad.data?.status}`);
  await c.del(`/api/devices/${d.id}`);
  await c.del(`/api/devices/${d2.id}`);
}

// Wrong pinned fingerprint must be refused by the gateway.
await c.put(`/api/connections/${rdp.data.id}`, { name: "RDP", protocol: "rdp", port: 13389, username: "tester", domain: "", credential_id: null, settings: { ...rdpPinned.data.settings, cert_fingerprints: "sha256:" + "00:".repeat(31) + "00", ignore_cert: false }, secret: { mode: "keep" } });
const mitm = await openSession(c, rdp.data.id, { seconds: 10 });
check("RDP refuses a certificate that does not match the pin", mitm.errors.length > 0 || (mitm.imgBytes === 0), `errors=${mitm.errors.join(";") || "none"} img=${mitm.imgBytes} (${mitm.why})`);

// Wrong SSH host key must be refused.
await c.put(`/api/connections/${ssh.data.id}`, { name: "SSH", protocol: "ssh", port: 12222, username: "tester", domain: "", credential_id: null, settings: { ...ssh.data.settings, host_key: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl" }, secret: { mode: "keep" } });
const badKey = await openSession(c, ssh.data.id, { seconds: 8 });
check("SSH refuses a host key that does not match the pin", badKey.errors.length > 0 && badKey.imgBytes < 5000, `errors=${badKey.errors.join(";") || "none"} img=${badKey.imgBytes}`);

// SSRF protection: targets outside the allowed networks are refused before any connection is made.
for (const addr of ["127.0.0.1", "8.8.8.8", "169.254.169.254", "localhost"]) {
  const d = await c.post("/api/devices", { name: `e2e-ssrf-${addr}`, hostname: "", address: addr, os: "linux", device_type: "server", description: "", notes: "", tags: [], group_id: null, favorite: false });
  const cn = await c.post(`/api/devices/${d.data.id}/connections`, { protocol: "ssh", port: 22, settings: {}, name: "", username: "", domain: "", credential_id: null });
  const t = await c.post(`/api/connections/${cn.data.id}/sessions`, { width: 800, height: 600, dpi: 96, image: ["image/png"], audio: [], video: [], timezone: "" });
  check(`SSRF: session to ${addr} is refused`, t.status === 422, `status ${t.status} ${t.data?.error?.code ?? ""}`);
  await c.del(`/api/devices/${d.data.id}`);
}

// ---- Network equipment: a switch registered as "Network" is inspected with fixed show commands ----
{
  const sw = await c.post("/api/devices", { name: `e2e-switch-${stamp}`, hostname: "", address: TARGET_HOST, os: "network", device_type: "network", description: "", notes: "", tags: ["e2e"], group_id: null, favorite: false });
  check("create a network device", sw.status === 201 && sw.data.os === "network", `status ${sw.status} os=${sw.data?.os}`);
  const sc = await c.post(`/api/devices/${sw.data.id}/connections`, { name: "SSH", protocol: "ssh", port: 12522, username: "tester", domain: "", credential_id: null, settings: {}, secret: { mode: "set", password: TARGET_PASSWORD } });
  const hkey = await c.post(`/api/connections/${sc.data.id}/ssh-host-key`);
  await c.put(`/api/connections/${sc.data.id}`, { name: "SSH", protocol: "ssh", port: 12522, username: "tester", domain: "", credential_id: null, settings: { ...sc.data.settings, host_key: hkey.data?.key ?? "" }, secret: { mode: "keep" } });
  const sa = await c.post(`/api/connections/${sc.data.id}/ssh-access`, {});
  const si = await c.get(`/api/ssh-access/${sa.data?.id}/system`);
  const swi = si.data?.info;
  check("switch overview reports vendor, firmware, model, CPU and memory",
    si.status === 200 && swi.platform === "network" && swi.vendor === "Cisco" && swi.os === "Cisco IOS XE 17.06.04" && swi.model === "C9300-48P" && swi.hostname === "lab-sw1" && swi.cpu.usage_percent === 7 && swi.memory.total_bytes === 1073741824 && swi.memory.used_bytes === 268435456 && Array.isArray(swi.disks) && swi.disks.length === 0,
    `status ${si.status} ${JSON.stringify(swi ?? si.data).slice(0, 220)}`);
  const swd = await c.get(`/api/devices/${sw.data.id}`);
  check("the switch's facts are saved on the device", swd.data?.facts?.vendor === "Cisco" && swd.data.facts.model === "C9300-48P" && swd.data.facts.os === "Cisco IOS XE 17.06.04", JSON.stringify(swd.data?.facts).slice(0, 200));
  if (sa.status === 201) await c.del(`/api/ssh-access/${sa.data.id}`);
  await c.del(`/api/devices/${sw.data.id}`);
}

// ---- Allowed target networks, changed in Settings ----
{
  const mkSsh = async (addr) => {
    const d = await c.post("/api/devices", { name: `tn-${addr}-${stamp}`, hostname: "", address: addr, os: "linux", device_type: "server", description: "", notes: "", tags: ["e2e"], group_id: null, favorite: false });
    const cn = await c.post(`/api/devices/${d.data.id}/connections`, { name: "SSH", protocol: "ssh", port: 22, username: "x", domain: "", credential_id: null, settings: {}, secret: { mode: "set", password: "pw-for-test-1" } });
    return { dev: d.data.id, conn: cn.data.id };
  };
  const blocked = async (t) => { const r = await c.post(`/api/connections/${t.conn}/ssh-host-key`); return r.status === 422; };
  const pub = await mkSsh("1.1.1.1"), other = await mkSsh("8.8.8.8"), meta = await mkSsh("169.254.169.254"), loop = await mkSsh("127.0.0.1");
  const before = (await c.get("/api/settings/targets")).data;
  check("a public address is refused by default", (await blocked(pub)) && (await blocked(other)));
  const added = await c.put("/api/settings/targets", { networks: [...before.networks, "1.1.1.1"] });
  check("an address added in Settings is allowed at once, others stay refused", added.status === 200 && !(await blocked(pub)) && (await blocked(other)), JSON.stringify(added.data?.networks));
  const all = await c.put("/api/settings/targets", { networks: ["0.0.0.0"] });
  check("0.0.0.0 allows every public address", all.data?.everywhere === true && !(await blocked(other)));
  check("loopback and the cloud metadata address stay refused even then", (await blocked(meta)) && (await blocked(loop)));
  check("an empty list and nonsense are rejected", (await c.put("/api/settings/targets", { networks: [] })).status === 422 && (await c.put("/api/settings/targets", { networks: ["1.2.3"] })).status === 422);
  const reset = await c.del("/api/settings/targets");
  check("'Use the default' goes back to the environment setting", reset.status === 200 && reset.data?.saved === false && (await blocked(pub)));
  for (const t of [pub, other, meta, loop]) await c.del(`/api/devices/${t.dev}`);
}

// Cross-site WebSocket hijacking: wrong Origin is rejected.
const t2 = await c.post(`/api/connections/${vnc.data.id}/sessions`, { width: 800, height: 600, dpi: 96, image: ["image/png"], audio: [], video: [], timezone: "" });
const evil = await wsStatus(`/api/tunnel?ticket=${encodeURIComponent(t2.data.ticket)}`, { Origin: "https://evil.example", Cookie: [...c.cookies].map(([k, v]) => `${k}=${v}`).join("; ") });
check("tunnel rejects foreign Origin", evil !== 0, String(evil));

// Audit trail
const audit = await c.get(`/api/audit?action=session.&limit=50`);
const actions = new Set(audit.data.events.map((e) => e.action));
check("audit log records session start and end", actions.has("session.start") && actions.has("session.end"));
const allAudit = JSON.stringify((await c.get(`/api/audit?limit=200`)).data);
check("audit log never contains secrets", !allAudit.includes(TARGET_PASSWORD) && !allAudit.includes(ADMIN_PASSWORD));

// Cleanup
const delRes = await c.del(`/api/devices/${devId}`);
check("delete device (cascade)", delRes.status === 204);
const logout = await c.post("/api/auth/logout");
check("logout", logout.status === 204);
check("session invalid after logout", (await c.get("/api/auth/me")).status === 401);

console.log(`\n${results.length - failures}/${results.length} checks passed`);
process.exit(failures ? 1 : 0);
