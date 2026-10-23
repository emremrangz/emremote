// Session recording in a real browser: records an SSH session to the test target, lists and plays it back, checks per-device
// rules and cleans up. Run with: tests/stack.sh recording
import { chromium } from "playwright";
const U = process.env.EMREMOTE_URL;
const b = await chromium.launch({ args: [`--ignore-certificate-errors-spki-list=${process.env.CA_SPKI}`] });
const c = await b.newContext({ viewport: { width: 1280, height: 800 }, ignoreHTTPSErrors: true, colorScheme: "dark" });
const p = await c.newPage(); p.on("console", m => { if (["error","warning"].includes(m.type())) console.log("CONSOLE", m.text().slice(0,300)); }); p.on("pageerror", e => console.log("PAGEERR", e.message.slice(0,300)));
let ok = 0, bad = 0; const chk = (n, v) => { v ? ok++ : bad++; console.log(v ? "PASS" : "FAIL", n); };
await p.goto(U); await p.getByLabel("Username").fill("admin"); await p.getByLabel("Password").fill(process.env.ADMIN_PASSWORD);
await p.getByRole("button", { name: /Sign in/ }).click(); await p.getByRole("link", { name: "Statistics" }).waitFor();
const api = (m, path, body) => p.evaluate(async ({ m, path, body }) => { const c = (await (await fetch("/api/auth/me")).json()).csrf_token; const r = await fetch(path, { method: m, headers: { "Content-Type": "application/json", "X-CSRF-Token": c }, body: body ? JSON.stringify(body) : undefined }); return r.status === 204 ? { status: 204 } : { status: r.status, ...(await r.json().catch(() => ({}))) }; }, { m, path, body });
const mk = async (name) => { const d = await api("POST", "/api/devices", { name, hostname: "", address: process.env.TARGET_HOST, os: "linux", device_type: "server", description: "", notes: "", tags: [], group_ids: [], favorite: false });
  const cn = await api("POST", `/api/devices/${d.id}/connections`, { name: "SSH", protocol: "ssh", port: 12222, username: "tester", domain: "", credential_id: null, settings: {}, secret: { mode: "set", password: process.env.TARGET_PASSWORD } }); return { d, cn }; };
const A = await mk("rec-a"), B = await mk("rec-b");
const session = async (cn, text, wantRec) => {
  await p.goto(`${U}/connect/${cn.id}`); await p.getByTitle("Connected").waitFor({ timeout: 40000 }); await p.waitForTimeout(2000);
  chk(`REC badge ${wantRec ? "shown" : "absent"}`, (await p.getByText("REC", { exact: true }).count() > 0) === wantRec);
  const box = await p.locator("[aria-label^='Remote screen']").boundingBox();
  await p.mouse.click(box.x + 400, box.y + 300); await p.keyboard.type(text, { delay: 8 }); await p.keyboard.press("Enter"); await p.waitForTimeout(1500);
  await p.goto(U); await p.waitForTimeout(1500);
};
let s = await api("GET", "/api/settings/recording"); chk("default: off", s.config.enabled === false);
await session(A.cn, "echo before-enable", false);
let l = await api("GET", "/api/recordings"); chk("nothing recorded while off", l.total === 0);
s = await api("PUT", "/api/settings/recording", { ...s.config, enabled: true, record_all: true, devices: { [B.d.id]: "off" } });
chk("enable ok", s.status === 200 && s.config.enabled && s.storage.writable);
await session(A.cn, "echo RECORDED-MARKER-123", true);
await session(B.cn, "echo not-recorded", false);
l = await api("GET", "/api/recordings"); chk("one recording (device B excluded)", l.total === 1 && l.items[0].device_name === "rec-a" && l.items[0].ended_at && l.items[0].size_bytes > 500);
const f = await p.evaluate(async (id) => { const r = await fetch(`/api/recordings/${id}/file`); const t = await r.text(); return { status: r.status, n: t.length, hasKeys: /\.key,/.test(t), hasSync: t.includes("sync,") }; }, l.items[0].id);
chk("file streams guac instructions without key events", f.status === 200 && f.hasSync && !f.hasKeys);
await p.goto(`${U}/recordings`); await p.getByText("rec-a").first().waitFor();
await p.screenshot({ path: "/s/shots/rec-list.png" });
await p.getByRole("button", { name: "Play" }).first().click(); await p.waitForTimeout(4500);
await p.screenshot({ path: "/s/shots/rec-play.png" });
const cv = await p.evaluate(() => { const els = [...document.querySelectorAll('[role=dialog] canvas')]; let lit = 0; for (const c of els) { try { const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; for (let i = 0; i < d.length; i += 4 * 17) if (d[i] + d[i + 1] + d[i + 2] > 120) lit++; } catch {} } return { n: els.length, lit }; });
chk("player draws the recorded screen", cv.n > 0 && cv.lit > 20);
await p.keyboard.press("Escape");
// MP4 download (made in the browser; the test browser can only encode VP9, real browsers use H.264)
await p.getByRole("button", { name: "Download the recording" }).first().click();
const [dl] = await Promise.all([p.waitForEvent("download", { timeout: 120000 }), p.getByRole("menuitem", { name: /Video \(MP4\)/ }).click()]);
await dl.saveAs("/s/shots/recording.mp4");
chk("video download is an .mp4 file", dl.suggestedFilename().endsWith(".mp4"));
await p.keyboard.press("Escape");
// traversal and access
chk("bad id is 404", (await api("GET", "/api/recordings/..%2f..%2fetc%2fpasswd/file")).status === 404);
s = await api("GET", "/api/settings/recording");
await api("PUT", "/api/settings/recording", { ...s.config, enabled: true, retention_days: 0, max_gb: 0 });
chk("delete", (await api("DELETE", `/api/recordings/${l.items[0].id}`)).status === 204 && (await api("GET", "/api/recordings")).total === 0);
await api("PUT", "/api/settings/recording", { ...s.config, enabled: false });
await api("DELETE", `/api/devices/${A.d.id}`); await api("DELETE", `/api/devices/${B.d.id}`);
console.log(`${ok} passed, ${bad} failed`); await b.close();
