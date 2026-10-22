// Produces the README screenshots from a throw-away test stack with made-up devices.
//   SHOTS=docs/images EMREMOTE_URL=... ADMIN_PASSWORD=... TARGET_HOST=... TARGET_PASSWORD=... node tests/e2e/screenshots.mjs
// Needs the test targets (tests/targets, ports 12222 SSH, 13389 RDP, 15900 VNC, 12323 Telnet) and the
// fake switch (tests/targets/fakeswitch, port 12522). Never run it against a real installation:
// it creates and deletes devices.
import { chromium } from "playwright";

const BASE = process.env.EMREMOTE_URL, ADMIN = process.env.ADMIN_USER ?? "admin", PASS = process.env.ADMIN_PASSWORD;
const HOST = process.env.TARGET_HOST, TPW = process.env.TARGET_PASSWORD, OUT = process.env.SHOTS ?? "docs/images";
const browser = await chromium.launch({ args: process.env.CA_SPKI ? [`--ignore-certificate-errors-spki-list=${process.env.CA_SPKI}`] : [] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true, colorScheme: "dark" });
const page = await ctx.newPage();
const shot = (name, p = page) => p.screenshot({ path: `${OUT}/${name}.png` });
const api = (method, path, body) =>
  page.evaluate(async ({ method, path, body }) => {
    const csrf = (await (await fetch("/api/auth/me")).json()).csrf_token;
    const r = await fetch(path, { method, headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf }, body: body ? JSON.stringify(body) : undefined });
    return r.status === 204 ? {} : r.json();
  }, { method, path, body });

await page.goto(BASE);
await page.getByRole("heading", { name: "Sign in" }).waitFor();
await page.waitForTimeout(800);
await shot("login");
await page.getByLabel("Username").fill(ADMIN);
await page.getByLabel("Password").fill(PASS);
await page.getByRole("button", { name: "Sign in" }).click();
await page.getByRole("link", { name: "Statistics" }).waitFor();

// ---- made-up inventory ----
for (const d of await api("GET", "/api/devices")) await api("DELETE", `/api/devices/${d.id}`);
// A fresh installation already has the groups Workstations, Servers and Network.
const grp = {};
for (const g of await api("GET", "/api/groups")) grp[g.name] = g.id;
console.log("default groups:", Object.keys(grp).join(", "));
const conns = {};
const PLACES = { Frankfurt: ["Frankfurt, Germany", 50.11, 8.68], Amsterdam: ["Amsterdam, Netherlands", 52.37, 4.9], Istanbul: ["Istanbul, Turkey", 41.01, 28.98], Ashburn: ["Ashburn, United States", 39.04, -77.49], Mumbai: ["Mumbai, India", 19.08, 72.88], Singapore: ["Singapore, Singapore", 1.35, 103.82], Ankara: ["Ankara, Turkey", 39.93, 32.86], Sydney: ["Sydney, Australia", -33.87, 151.21] };
const add = async (name, address, os, type, group, tags, list, place) => {
  const pl = place && PLACES[place];
  const d = await api("POST", "/api/devices", { name, hostname: "", address, os, device_type: type, description: "", notes: "", tags, group_id: grp[group], favorite: tags.includes("prod"), ...(pl ? { location: { label: pl[0], latitude: pl[1], longitude: pl[2] } } : {}) });
  conns[name] = {};
  for (const [protocol, port, user] of list) {
    const c = await api("POST", `/api/devices/${d.id}/connections`, { name: protocol.toUpperCase(), protocol, port, username: user, domain: "", credential_id: null, settings: {}, secret: { mode: "set", password: TPW } });
    if (protocol === "ssh") {
      const hk = await api("POST", `/api/connections/${c.id}/ssh-host-key`);
      await api("PUT", `/api/connections/${c.id}`, { name: "SSH", protocol, port, username: user, domain: "", credential_id: null, settings: { ...c.settings, host_key: hk.key ?? "" }, secret: { mode: "keep" } });
    }
    conns[name][protocol] = c.id;
  }
  return d.id;
};
const ids = {};
ids.web = await add("web-01", HOST, "linux", "server", "Servers", ["web", "prod"], [["ssh", 12222, "tester"]], "Frankfurt");
await add("db-01", HOST, "linux", "server", "Servers", ["database", "prod"], [["ssh", 12222, "tester"]], "Frankfurt");
await add("build-02", HOST, "linux", "virtual_machine", "Servers", ["ci"], [["ssh", 12222, "tester"]], "Amsterdam");
await add("win-dc01", HOST, "windows", "server", "Servers", ["domain"], [["rdp", 13389, "tester"]], "Istanbul");
await add("frontdesk-pc", HOST, "windows", "desktop", "Workstations", [], [["rdp", 13389, "tester"]], "Ankara");
await add("mac-studio", HOST, "macos", "desktop", "Workstations", ["design"], [["vnc", 15900, ""]], "Ashburn");
ids.sw = await add("core-sw1", HOST, "network", "network", "Network", ["core"], [["ssh", 12522, "tester"]], "Mumbai");
await add("edge-sw2", HOST, "network", "network", "Network", ["edge"], [["telnet", 12323, "tester"]], "Singapore");

// ---- some real usage so Statistics and Activity have something to show ----
const sessions = [["web-01", "ssh", 5], ["win-dc01", "rdp", 7], ["mac-studio", "vnc", 5], ["web-01", "ssh", 4], ["db-01", "ssh", 4], ["frontdesk-pc", "rdp", 6], ["edge-sw2", "telnet", 4]];
for (const [dev, proto, secs] of sessions) {
  await page.goto(`${BASE}/connect/${conns[dev][proto]}`);
  await page.waitForTimeout(secs * 1000);
}
await page.goto(`${BASE}/`);
// Device pages read facts over SSH the first time they are opened.
for (const id of [ids.web, ids.sw]) { await page.goto(`${BASE}/devices/${id}`); await page.waitForTimeout(7000); }
await page.goto(`${BASE}/devices/${ids.web}`); await page.waitForTimeout(2500);
await shot("device");
await page.goto(`${BASE}/devices/${ids.sw}`); await page.waitForTimeout(2500);
await shot("network-device");
await page.goto(`${BASE}/devices/${ids.sw}?tab=system`); await page.waitForTimeout(3500);
await shot("network-system");
await page.goto(`${BASE}/devices/${ids.web}?tab=system`); await page.waitForTimeout(4500);
await shot("system");
await page.goto(`${BASE}/`); await page.waitForTimeout(3000);
await shot("overview");
{
  // The map on its own, with the list of one group of servers open.
  const panel = page.locator("section", { hasText: "Locations" }).first();
  await panel.scrollIntoViewIfNeeded();
  await page.locator("svg g[role=button]").filter({ hasText: /^[2-9]$/ }).first().click();
  await page.waitForTimeout(500);
  await panel.screenshot({ path: `${OUT}/map.png` });
}
await page.goto(`${BASE}/devices`); await page.waitForTimeout(2500);
await shot("devices");
await page.goto(`${BASE}/statistics`); await page.waitForTimeout(3000);
await shot("statistics");
await page.goto(`${BASE}/activity`); await page.waitForTimeout(2500);
await shot("activity");
await page.goto(`${BASE}/`); await page.waitForTimeout(1500);
await page.keyboard.press("Control+k");
await page.keyboard.type("sw");
await page.waitForTimeout(800);
await shot("search");
await page.keyboard.press("Escape");

// ---- an SSH session: the terminal themes menu, and the same session as a quick view over the device page ----
{
  await page.goto(`${BASE}/connect/${conns["web-01"].ssh}`);
  await page.getByTitle("Connected").waitFor({ timeout: 40000 });
  await page.waitForTimeout(2500);
  await page.getByRole("toolbar", { name: "Session toolbar" }).getByRole("button", { name: "Terminal appearance" }).click();
  await page.waitForTimeout(600);
  await shot("terminal-themes");
  await page.keyboard.press("Escape");
  await page.goto(`${BASE}/devices/${ids.web}`);
  await page.waitForTimeout(1500);
  await page.getByRole("button", { name: /Quick view/ }).click();
  const qv = page.getByRole("region", { name: "Quick view" });
  await qv.getByTitle("Connected").waitFor({ timeout: 40000 });
  await page.waitForTimeout(2500);
  const box = await qv.locator("[aria-label^='Remote screen']").boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.type("uptime && hostname", { delay: 25 });
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1500);
  await shot("quick-view");
  await qv.getByRole("button", { name: "Close quick view" }).click();
}

// ---- choosing a location, and cloning a device ----
{
  await page.goto(`${BASE}/devices/${ids.sw}`);
  await page.getByRole("button", { name: "Edit device" }).click();
  const dlg = page.getByRole("dialog", { name: "Edit device" });
  await dlg.getByRole("button", { name: "Choose on the map" }).click();
  await page.waitForTimeout(600);
  await dlg.getByText("Location").first().scrollIntoViewIfNeeded();
  await shot("location-picker");
  await page.keyboard.press("Escape");
  await page.goto(`${BASE}/devices/${ids.web}`);
  await page.getByRole("button", { name: "More actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Clone device" }).click();
  await page.getByRole("dialog", { name: "Clone device" }).waitFor();
  await page.waitForTimeout(600);
  await shot("clone-device");
  await page.keyboard.press("Escape");
}

// ---- workspace: two shells side by side ----
await page.goto(`${BASE}/devices`);
await page.getByRole("heading", { name: "All devices" }).waitFor();
const launch = async (name) => {
  await page.getByRole("row", { name: new RegExp(name) }).getByRole("button", { name: /^SSH$/ }).click();
};
const popup = ctx.waitForEvent("page");
await launch("web-01");
const ws = await popup;
await ws.getByRole("tab").first().waitFor({ timeout: 30000 });
await launch("db-01");
await ws.getByRole("tab").nth(1).waitFor({ timeout: 30000 });
await ws.getByRole("button", { name: "Two side by side" }).click();
await ws.locator("[data-pane]").nth(1).waitFor();
await ws.waitForTimeout(4500);
await shot("workspace", ws);
await ws.close();

// ---- remove the made-up data ----
await page.goto(`${BASE}/`);
for (const d of await api("GET", "/api/devices")) await api("DELETE", `/api/devices/${d.id}`);
await browser.close();
console.log("screenshots written to", OUT);
