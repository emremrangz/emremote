// The workspace's New session picker (logos, tags, groups, group filter) and the hidden session toolbar (an arrow stays,
// pointing at it shows the toolbar, clicking it brings it back). Run with: tests/stack.sh workspace
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";

const U = process.env.EMREMOTE_URL;
const b = await chromium.launch({ args: [`--ignore-certificate-errors-spki-list=${process.env.CA_SPKI}`] });
const c = await b.newContext({ viewport: { width: 1400, height: 900 }, ignoreHTTPSErrors: true, colorScheme: "dark" });
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

const tag = Date.now().toString(36);
const groups = await p.evaluate(async () => (await fetch("/api/groups")).json());
const grp = groups.length ? groups[0] : await api("POST", "/api/groups", { name: `ws-${tag}` });
const dev = await api("POST", "/api/devices", { name: `ws-${tag}`, hostname: "", address: process.env.TARGET_HOST, os: "linux", device_type: "server", description: "", notes: "", tags: ["prod", "web"], group_ids: [grp.id], favorite: true });
const rdp = await api("POST", `/api/devices/${dev.id}/connections`, { name: "RDP", protocol: "rdp", port: 13389, username: "tester", domain: "", credential_id: null, settings: { ignore_cert: true, security: "any" }, secret: { mode: "set", password: process.env.TARGET_PASSWORD } });
await api("POST", `/api/devices/${dev.id}/connections`, { name: "SSH", protocol: "ssh", port: 12222, username: "tester", domain: "", credential_id: null, settings: {}, secret: { mode: "set", password: process.env.TARGET_PASSWORD } });
chk("test device created", dev.id && rdp.id, JSON.stringify({ dev: dev.status, rdp: rdp.status }));

await p.goto(`${U}/workspace`);
await p.getByRole("button", { name: "New session" }).first().click();
const d = p.getByRole("dialog");
await d.getByText(`ws-${tag}`).waitFor();
const row = d.locator("li", { hasText: `ws-${tag}` });
chk("the picker shows the operating system logo", (await row.locator("svg").count()) > 0);
chk("the picker shows the tags", (await row.getByText("prod", { exact: true }).count()) === 1 && (await row.getByText("web", { exact: true }).count()) === 1);
chk("the picker shows the group", (await row.getByText(grp.name, { exact: true }).count()) === 1, grp.name);
chk("each connection method has its own button", (await row.getByRole("button").count()) === 2);
await p.screenshot({ path: "/s/shots/ws-picker.png" });
await d.getByRole("group", { name: "Filter by group" }).getByRole("button", { name: grp.name, exact: true }).click();
chk("filtering by group keeps the device", await d.getByText(`ws-${tag}`).isVisible());
await d.getByLabel("Search devices").fill("prod");
chk("search finds a device by tag", await d.getByText(`ws-${tag}`).isVisible());
await d.getByLabel("Search devices").fill("no-such-thing-xyz");
chk("search with no match says so", await d.getByText("No devices match.").isVisible());
await d.getByLabel("Search devices").fill(`ws-${tag}`);
await row.getByRole("button", { name: /with RDP/ }).click();

// The session toolbar: hide it completely, then find it again.
const bar = p.getByRole("toolbar", { name: "Session toolbar" });
await bar.waitFor({ timeout: 40000 });
await p.waitForTimeout(3000);
await bar.getByRole("button", { name: /Hide completely/ }).first().click().catch(async () => {
  await bar.getByRole("button", { name: "Hide toolbar" }).click();
  await bar.getByRole("button", { name: /Hide completely/ }).first().click();
});
await p.waitForTimeout(400);
chk("hiding removes the toolbar", (await bar.count()) === 0);
const arrow = p.getByRole("button", { name: "Show toolbar" });
const opacity = Number(await arrow.evaluate((el) => getComputedStyle(el).opacity));
chk("an arrow stays visible at the top", (await arrow.isVisible()) && opacity >= 0.5, `opacity ${opacity}`);
await p.screenshot({ path: "/s/shots/ws-hidden.png" });
await arrow.hover();
await p.waitForTimeout(600);
chk("pointing at the arrow shows the toolbar", await bar.isVisible());
await p.screenshot({ path: "/s/shots/ws-peek.png" });
await p.mouse.move(700, 600);
await p.waitForTimeout(1000);
chk("it hides again when the pointer leaves", (await bar.count()) === 0);
await arrow.click();
await p.waitForTimeout(400);
await p.mouse.move(700, 600);
await p.waitForTimeout(800);
chk("clicking the arrow brings the toolbar back for good", await bar.isVisible());

// The tab: the device's name, its logo and the protocol.
const tabEl = p.getByRole("tab").first();
const tabText = await tabEl.innerText();
chk("the tab shows the device name and the protocol", tabText.includes(`ws-${tag}`) && /rdp/i.test(tabText), tabText.replace(/\s+/g, " "));
chk("the tab shows the operating system logo", (await tabEl.locator("svg").count()) >= 1);
await p.screenshot({ path: "/s/shots/ws-tabs.png", clip: { x: 0, y: 0, width: 1400, height: 60 } });

// A dropped connection comes back by itself. The test stack restarts the proxy in front of emremote when this file
// appears, which cuts the session's WebSocket like a network drop would.
if (process.env.DROP_FILE) {
  writeFileSync(process.env.DROP_FILE, "now");
  const sawReconnect = await p.getByText(/Reconnecting/).first().waitFor({ timeout: 30000 }).then(() => true, () => false);
  chk("a dropped connection says it is reconnecting", sawReconnect);
  await p.waitForTimeout(1000);
  const back = await p.getByTitle("Connected", { exact: true }).first().waitFor({ timeout: 60000 }).then(() => true, () => false);
  chk("and is connected again without a click", back && !(await p.getByText("Session ended", { exact: true }).isVisible()));
  await p.screenshot({ path: "/s/shots/ws-reconnected.png" });
}

await api("DELETE", `/api/devices/${dev.id}`);
console.log(`${ok} passed, ${bad} failed`);
await b.close();
