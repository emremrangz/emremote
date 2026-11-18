// Clipboard in a real browser, with and without the browser's clipboard read access: Ctrl+V in the SSH terminal and
// in RDP, right-click in the SSH terminal falling back to the browser's own menu once reading is refused, right-click
// in RDP never asking for access (Chrome blocks a site by itself after its question is closed unanswered a few times),
// the same text pasted twice in RDP, and the Clipboard panel explaining the current access.
// Run with: tests/stack.sh clipboard
import { chromium } from "playwright";

const U = process.env.EMREMOTE_URL;
const b = await chromium.launch({ args: [`--ignore-certificate-errors-spki-list=${process.env.CA_SPKI}`, "--disable-3d-apis"] });
let ok = 0, bad = 0;
const chk = (n, v, extra = "") => { v ? ok++ : bad++; console.log(v ? "PASS" : "FAIL", n, extra); };

// Counts clipboard reads and records whether each right-click kept the browser's own menu.
const instrument = () => {
  window.__reads = 0;
  const orig = navigator.clipboard.readText.bind(navigator.clipboard);
  navigator.clipboard.readText = () => { window.__reads++; return orig(); };
  window.__menus = [];
  window.addEventListener("contextmenu", (e) => window.__menus.push(e.defaultPrevented));
};
const newContext = async (perms) => {
  const c = await b.newContext({ viewport: { width: 1280, height: 800 }, ignoreHTTPSErrors: true });
  await c.grantPermissions(perms, { origin: U });
  await c.addInitScript(instrument);
  return c;
};

const c1 = await newContext(["clipboard-write"]); // no read access: only paste events deliver text
const p = await c1.newPage();
p.on("pageerror", (e) => console.log("PAGEERR", e.message.slice(0, 300)));
await p.goto(U);
await p.getByLabel("Username").fill("admin");
await p.keyboard.press("Enter");
await p.getByLabel("Password").fill(process.env.ADMIN_PASSWORD);
await p.keyboard.press("Enter");
await p.getByRole("link", { name: "Statistics" }).waitFor({ timeout: 20000 });
const api = (pg, m, path, body) => pg.evaluate(async ({ m, path, body }) => {
  const csrf = (await (await fetch("/api/auth/me")).json()).csrf_token;
  const r = await fetch(path, { method: m, headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf }, body: body ? JSON.stringify(body) : undefined });
  return r.status === 204 ? { status: 204 } : { status: r.status, ...(await r.json().catch(() => ({}))) };
}, { m, path, body });
const TP = process.env.TARGET_PASSWORD;
const dev = await api(p, "POST", "/api/devices", { name: "clip-test", hostname: "", address: process.env.TARGET_HOST, os: "linux", device_type: "server", description: "", notes: "", tags: [], group_ids: [], favorite: false });
const ssh = await api(p, "POST", `/api/devices/${dev.id}/connections`, { name: "SSH", protocol: "ssh", port: 12222, username: "tester", domain: "", credential_id: null, settings: {}, secret: { mode: "set", password: TP } });
const rdp = await api(p, "POST", `/api/devices/${dev.id}/connections`, { name: "RDP", protocol: "rdp", port: 13389, username: "tester", domain: "", credential_id: null, settings: {}, secret: { mode: "set", password: TP } });
const readRemote = (pg, path) => pg.evaluate(async ({ id, path }) => {
  const csrf = (await (await fetch("/api/auth/me")).json()).csrf_token;
  const a = await (await fetch(`/api/connections/${id}/ssh-access`, { method: "POST", headers: { "X-CSRF-Token": csrf, "Content-Type": "application/json" }, body: "{}" })).json();
  const r = await fetch(`/api/ssh-access/${a.id}/files/download?path=${encodeURIComponent(path)}`);
  const t = r.ok ? await r.text() : `HTTP ${r.status}`;
  await fetch(`/api/ssh-access/${a.id}`, { method: "DELETE", headers: { "X-CSRF-Token": csrf } });
  return t;
}, { id: ssh.id, path });
const setLocal = (pg, t) => pg.evaluate((t) => navigator.clipboard.writeText(t), t);
const state = await p.evaluate(async () => (await navigator.permissions.query({ name: "clipboard-read" })).state);
console.log("clipboard-read permission without a grant:", state);
const stamp = Date.now();

// ---- SSH terminal without read access ----
const rows = p.locator("[data-terminal] .xterm-rows");
const waitScreen = async (re, ms = 10000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (re.test(await rows.innerText().catch(() => ""))) return true;
    await p.waitForTimeout(200);
  }
  return false;
};
await p.goto(`${U}/connect/${ssh.id}`);
await p.getByTitle("Connected").first().waitFor({ timeout: 40000 });
const term = p.locator("[data-terminal]");
await term.click();
await setLocal(p, "echo PLAIN-$((40+2))");
await p.keyboard.press("Control+V");
await p.keyboard.press("Enter");
chk("SSH: Ctrl+V pastes without clipboard read access", await waitScreen(/^PLAIN-42\s*$/m));
const box = await term.boundingBox();
await setLocal(p, "echo MENU-$((1+1))");
await p.mouse.click(box.x + 400, box.y + 300, { button: "right" });
await p.waitForTimeout(1500);
await p.mouse.click(box.x + 400, box.y + 300, { button: "right" }); // the first read was refused (or never allowed)
await p.waitForTimeout(500);
const menus = await p.evaluate(() => window.__menus);
chk("SSH: once reading is refused, right-click opens the browser's own menu (its Paste needs no permission)", menus.at(-1) === false, JSON.stringify(menus));
// The browser menu's Paste arrives as an ordinary paste event on the terminal.
await p.evaluate(() => {
  const dt = new DataTransfer();
  dt.setData("text/plain", "echo MENU-$((1+1))");
  document.querySelector("[data-terminal] textarea").dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
});
await p.keyboard.press("Enter");
chk("SSH: Paste from the browser's menu reaches the terminal", await waitScreen(/^MENU-2\s*$/m));
await p.getByRole("toolbar", { name: "Session toolbar" }).getByRole("button", { name: "Clipboard" }).click();
chk("SSH: the Clipboard panel explains that the browser blocks reading", (await p.getByText(/blocking clipboard access/).count()) === 1 || (state === "prompt" && (await p.getByRole("button", { name: "Allow clipboard access" }).count()) === 1));

// ---- RDP without read access ----
await p.goto(`${U}/connect/${rdp.id}`);
await p.getByTitle("Connected").waitFor({ timeout: 40000 });
await p.waitForTimeout(2500);
const screen = p.locator("[aria-label^='Remote screen']");
await screen.click({ position: { x: 300, y: 160 } });
await p.waitForTimeout(400);
const f = `/home/tester/emr-clip-${stamp}.txt`;
await setLocal(p, `echo rdp-same >> ${f}`);
for (let i = 0; i < 2; i++) {
  await p.keyboard.press("Control+V");
  await p.waitForTimeout(1000);
  await p.keyboard.press("Enter");
  await p.waitForTimeout(1200);
}
const twice = await readRemote(p, f);
chk("RDP: Ctrl+V pastes, and the same text pasted again (not sent again) pastes too", twice === "rdp-same\nrdp-same\n", JSON.stringify(twice));
await setLocal(p, `echo rdp-new >> ${f}`);
await p.keyboard.press("Control+V");
await p.waitForTimeout(1000);
await p.keyboard.press("Enter");
await p.waitForTimeout(1200);
const after = await readRemote(p, f);
chk("RDP: newly copied text pastes after that", after === "rdp-same\nrdp-same\nrdp-new\n", JSON.stringify(after));
const readsBefore = await p.evaluate(() => window.__reads);
await screen.click({ button: "right", position: { x: 600, y: 400 } });
await p.waitForTimeout(800);
await p.keyboard.press("Escape");
chk("RDP: right-click without read access never asks the browser for the clipboard", (await p.evaluate(() => window.__reads)) === readsBefore);
chk("RDP: a hint explains what right-click → Paste uses", (await p.getByText(/Right-click → Paste uses the remote clipboard/).count()) === 1);
await c1.close();

// ---- With read access (Chromium, allowed once) ----
const c2 = await newContext(["clipboard-read", "clipboard-write"]);
const g = await c2.newPage();
g.on("pageerror", (e) => console.log("PAGEERR", e.message.slice(0, 300)));
await g.goto(U);
await g.getByLabel("Username").fill("admin");
await g.keyboard.press("Enter");
await g.getByLabel("Password").fill(process.env.ADMIN_PASSWORD);
await g.keyboard.press("Enter");
await g.getByRole("link", { name: "Statistics" }).waitFor({ timeout: 20000 });
await g.goto(`${U}/connect/${rdp.id}`);
await g.getByTitle("Connected").waitFor({ timeout: 40000 });
await g.waitForTimeout(2500);
const gs = g.locator("[aria-label^='Remote screen']");
await gs.click({ position: { x: 300, y: 160 } });
const r0 = await g.evaluate(() => window.__reads);
await gs.click({ button: "right", position: { x: 600, y: 400 } });
await g.waitForTimeout(800);
await g.keyboard.press("Escape");
chk("RDP: with read access, right-click first brings this computer's clipboard over", (await g.evaluate(() => window.__reads)) > r0);
chk("RDP: no hint when right-click can use this computer's clipboard", (await g.getByText(/Right-click → Paste uses the remote clipboard/).count()) === 0);
await g.getByRole("toolbar", { name: "Session toolbar" }).getByRole("button", { name: "Clipboard" }).click();
chk("RDP: the Clipboard panel says access is on", (await g.getByText(/Clipboard access is on/).count()) === 1);

await api(g, "DELETE", `/api/devices/${dev.id}`);
await b.close();
console.log(`${ok} passed, ${bad} failed`);
process.exit(bad ? 1 : 0);
