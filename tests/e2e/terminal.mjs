// The built-in SSH terminal in a real browser: typing, the terminal size, an indented script pasted into nano with
// auto-indent on (it must arrive byte for byte), copy on select, right-click paste and copy, Ctrl+C, the end of the
// session, and the recording as searchable text. Run with: tests/stack.sh terminal
import { chromium } from "playwright";
import { createHash } from "node:crypto";

const U = process.env.EMREMOTE_URL;
// No WebGL, so the terminal draws text into the page and the test can read it.
const b = await chromium.launch({ args: [`--ignore-certificate-errors-spki-list=${process.env.CA_SPKI}`, "--disable-3d-apis"] });
const c = await b.newContext({ viewport: { width: 1280, height: 800 }, ignoreHTTPSErrors: true, colorScheme: "dark" });
await c.grantPermissions(["clipboard-read", "clipboard-write"], { origin: U });
const p = await c.newPage();
p.on("pageerror", (e) => console.log("PAGEERR", e.message.slice(0, 300)));
let ok = 0, bad = 0;
const chk = (n, v, extra = "") => { v ? ok++ : bad++; console.log(v ? "PASS" : "FAIL", n, extra); };

await p.goto(U);
await p.getByLabel("Username").fill("admin");
await p.keyboard.press("Enter");
await p.getByLabel("Password").fill(process.env.ADMIN_PASSWORD);
await p.keyboard.press("Enter");
await p.getByRole("link", { name: "Statistics" }).waitFor({ timeout: 20000 });
const api = (m, path, body) => p.evaluate(async ({ m, path, body }) => {
  const csrf = (await (await fetch("/api/auth/me")).json()).csrf_token;
  const r = await fetch(path, { method: m, headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf }, body: body ? JSON.stringify(body) : undefined });
  return r.status === 204 ? { status: 204 } : { status: r.status, ...(await r.json().catch(() => ({}))) };
}, { m, path, body });

const dev = await api("POST", "/api/devices", { name: "term-test", hostname: "", address: process.env.TARGET_HOST, os: "linux", device_type: "server", description: "", notes: "", tags: [], group_ids: [], favorite: false });
const cn = await api("POST", `/api/devices/${dev.id}/connections`, { name: "SSH", protocol: "ssh", port: 12222, username: "tester", domain: "", credential_id: null, settings: {}, secret: { mode: "set", password: process.env.TARGET_PASSWORD } });
const recBefore = await api("GET", "/api/settings/recording");
await api("PUT", "/api/settings/recording", { ...recBefore.config, enabled: true, record_all: true, devices: {} });

const rows = p.locator("[data-terminal] .xterm-rows");
const screen = () => rows.innerText();
const waitScreen = async (re, ms = 15000) => {
  const end = Date.now() + ms;
  let s = "";
  while (Date.now() < end) {
    s = await screen().catch(() => "");
    if (re.test(s)) return true;
    await p.waitForTimeout(200);
  }
  console.log("--- screen ---\n" + s.slice(-1500) + "\n--------------");
  return false;
};
const typeLine = async (text) => { await p.keyboard.type(text, { delay: 5 }); await p.keyboard.press("Enter"); };

await p.goto(`${U}/connect/${cn.id}`);
await rows.waitFor({ timeout: 40000 });
await p.getByTitle("Connected").first().waitFor({ timeout: 40000 });
chk("the built-in terminal opens (not the gateway's display)", (await p.locator("[data-terminal] .xterm").count()) === 1);
chk("REC is shown while recording", (await p.getByText("REC", { exact: true }).count()) > 0);
await p.locator("[data-terminal]").click();
await typeLine("echo HELLO-$((40+2))");
chk("typing reaches the shell and the output comes back", await waitScreen(/^HELLO-42\s*$/m));

await typeLine("stty size");
await waitScreen(/^\d+ \d+\s*$/m);
const size = (await screen()).match(/^(\d+) (\d+)\s*$/m);
chk("the terminal size follows the window", !!size && Number(size[2]) >= 100 && Number(size[1]) >= 20, size?.[0]);

// The reported problem: an indented script pasted into nano with auto-indent on must not drift.
const script = "def main():\n    for i in range(3):\n        if i % 2:\n            print('odd', i)\n        else:\n\t\tprint('even', i)\n    return 0\n\nif __name__ == '__main__':\n    main()\n";
await typeLine("rm -f /tmp/paste.py; nano -i /tmp/paste.py");
await waitScreen(/GNU nano/);
await p.evaluate((t) => navigator.clipboard.writeText(t), script);
await p.keyboard.press("Control+V");
await p.waitForTimeout(800);
await p.keyboard.press("Control+O");
await p.waitForTimeout(300);
await p.keyboard.press("Enter");
await waitScreen(/Wrote \d+ lines/);
await p.keyboard.press("Control+X");
await p.waitForTimeout(500);
await typeLine("md5sum /tmp/paste.py");
const want = createHash("md5").update(script).digest("hex");
const pasted = await waitScreen(new RegExp(`^${want}\\s+/tmp/paste.py`, "m"), 8000);
chk("a script pasted into nano (auto-indent on) is saved byte for byte", pasted, want);
if (!pasted) {
  await typeLine("cat -A /tmp/paste.py");
  await p.waitForTimeout(800);
}

// Copy on select: double-click a word, it is on the clipboard.
await typeLine("clear; echo COPY-ME-123");
await waitScreen(/^COPY-ME-123\s*$/m);
const line = rows.locator("div", { hasText: /^COPY-ME-123\s*$/ }).first();
const bx = await line.boundingBox();
await p.mouse.dblclick(bx.x + 20, bx.y + bx.height / 2);
await p.waitForTimeout(300);
chk("selecting text copies it", (await p.evaluate(() => navigator.clipboard.readText())) === "COPY-ME-123");

// Right-click with a selection only copies (nothing is typed).
await p.evaluate(() => navigator.clipboard.writeText("something else"));
await p.mouse.click(bx.x + 20, bx.y + bx.height / 2, { button: "right" });
await p.waitForTimeout(400);
chk("right-click with text selected copies and pastes nothing", (await p.evaluate(() => navigator.clipboard.readText())) === "COPY-ME-123" && !/something else/.test(await screen()));

// Right-click without a selection pastes.
await p.mouse.click(bx.x + 300, bx.y + bx.height / 2);
await p.evaluate(() => navigator.clipboard.writeText("echo RIGHT-$((1+1))"));
await p.mouse.click(bx.x + 300, bx.y + 200, { button: "right" });
await p.waitForTimeout(400);
await p.keyboard.press("Enter");
chk("right-click pastes", await waitScreen(/^RIGHT-2\s*$/m));

// Ctrl+C stays the interrupt key.
await typeLine("sleep 30");
await p.waitForTimeout(500);
await p.keyboard.press("Control+C");
await typeLine("echo AFTER-$((2*21))");
chk("Ctrl+C interrupts the running command", await waitScreen(/^AFTER-42\s*$/m, 5000));

await typeLine("exit");
await p.getByText("Session ended", { exact: true }).waitFor({ timeout: 15000 });
chk("the session ends when the shell exits, the output stays visible", /AFTER-42/.test(await screen()));

// The recording is text and can be searched.
await p.waitForTimeout(1500);
const list = await api("GET", "/api/recordings");
const rec = list.items?.find((r) => r.device_name === "term-test");
chk("the session was recorded as a terminal recording", rec?.format === "cast" && !!rec?.ended_at && rec?.size_bytes > 100, JSON.stringify({ format: rec?.format, size: rec?.size_bytes }));
const raw = await p.evaluate(async (id) => (await fetch(`/api/recordings/${id}/file`)).text(), rec?.id);
chk("the keyboard is not in the recording (only output events)", raw.split("\n").slice(1).filter(Boolean).every((l) => /^\[[\d.]+, "[or]", /.test(l)));
await p.goto(`${U}/recordings`);
await p.getByText("term-test").first().waitFor();
await p.getByRole("button", { name: "Play" }).first().click();
const d = p.getByRole("dialog");
await d.getByLabel("Find text in the session").fill("COPY-ME");
await d.getByRole("button", { name: "Find" }).click();
chk("the recording can be searched", await d.getByText(/COPY-ME-123/).first().isVisible().catch(() => false));
await p.screenshot({ path: "/s/shots/terminal-player.png" });
await p.keyboard.press("Escape");

await api("DELETE", `/api/recordings/${rec?.id}`);
await api("PUT", "/api/settings/recording", recBefore.config);
await api("DELETE", `/api/devices/${dev.id}`);
console.log(`${ok} passed, ${bad} failed`);
await b.close();
