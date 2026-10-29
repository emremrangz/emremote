// Real-browser end-to-end test (Playwright + Chromium).
//
// Drives the actual web UI: sign in, add a device through the form, configure
// an RDP connection (store credentials, fetch and pin the certificate), open
// live RDP and SSH sessions in the browser using the official Guacamole client,
// type into the remote desktop, and capture screenshots of every screen.
//
//   EMREMOTE_URL=https://192.168.1.50 ADMIN_USER=admin ADMIN_PASSWORD=... \
//   TARGET_HOST=192.168.1.50 TARGET_PASSWORD=... CA_SPKI=<base64 sha256 of CA SPKI> \
//   SHOTS=/path/to/screenshots node tests/e2e/browser.mjs
//
// CA_SPKI makes Chromium trust exactly the deployment's local CA key (instead
// of disabling certificate checks):
//   openssl x509 -in root.crt -pubkey -noout | openssl pkey -pubin -outform der \
//     | openssl dgst -sha256 -binary | base64

import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { createHmac } from "node:crypto";

const BASE = process.env.EMREMOTE_URL;
const SHOTS = process.env.SHOTS ?? "/tmp/emremote-shots";
const { ADMIN_USER = "admin", ADMIN_PASSWORD, TARGET_HOST, TARGET_PASSWORD, CA_SPKI } = process.env;
mkdirSync(SHOTS, { recursive: true });

let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

const browser = await chromium.launch({
  args: CA_SPKI ? [`--ignore-certificate-errors-spki-list=${CA_SPKI}`] : [],
});
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
const consoleErrors = [];
page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
page.on("pageerror", (e) => consoleErrors.push(String(e)));
// The app's dropdowns are custom menus: open the trigger, then click the entry.
const choose = async (trigger, entry) => {
  await trigger.click();
  const items = trigger.page().getByRole("menuitemradio");
  await (typeof entry === "number" ? items.nth(entry) : items.filter({ hasText: entry }).first()).click();
};
const shot = (name, p = page) => p.screenshot({ path: `${SHOTS}/${name}.png` });

// --- Sign in ---
await page.goto(BASE);
await page.getByRole("heading", { name: "Sign in" }).waitFor();
await shot("01-login");
await page.getByLabel("Username").fill(ADMIN_USER);
await page.getByLabel("Password").fill(ADMIN_PASSWORD);
await page.getByRole("button", { name: "Sign in" }).click();
await page.getByRole("button", { name: "Quick connect" }).waitFor();
check("sign in through the UI", true);
// Remove leftovers from earlier runs.
await page.evaluate(async () => {
  const csrf = (await (await fetch("/api/auth/me")).json()).csrf_token;
  for (const d of await (await fetch("/api/devices")).json())
    if (d.name === "Lab workstation" || d.name === "Core switch") await fetch(`/api/devices/${d.id}`, { method: "DELETE", headers: { "X-CSRF-Token": csrf } });
  for (const cr of await (await fetch("/api/credentials")).json())
    if (cr.name === "Lab tester" || cr.name === "UI vault entry") await fetch(`/api/credentials/${cr.id}`, { method: "DELETE", headers: { "X-CSRF-Token": csrf } });
  for (const sn of await (await fetch("/api/snippets")).json())
    await fetch(`/api/snippets/${sn.id}`, { method: "DELETE", headers: { "X-CSRF-Token": csrf } });
  for (const u of await (await fetch("/api/users")).json())
    if (u.username.startsWith("ui-member-") || u.username.startsWith("ui-2fa-")) await fetch(`/api/users/${u.id}?keep_inventory=false`, { method: "DELETE", headers: { "X-CSRF-Token": csrf } });
  for (const t of await (await fetch("/api/teams")).json())
    if (t.name === "UI Team") await fetch(`/api/teams/${t.id}`, { method: "DELETE", headers: { "X-CSRF-Token": csrf } });
  for (const g of await (await fetch("/api/groups")).json())
    if (g.name === "Lab") await fetch(`/api/groups/${g.id}`, { method: "DELETE", headers: { "X-CSRF-Token": csrf } });
});
await page.reload();
await page.getByRole("button", { name: "Quick connect" }).waitFor();
await shot("02-overview-empty");

// --- The terminal sign-in: login, Enter, password, Enter ---
{
  const c2 = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const p2 = await c2.newPage();
  await p2.goto(BASE);
  await p2.getByLabel("Username").fill(ADMIN_USER);
  await p2.keyboard.press("Enter");
  await p2.getByLabel("Password").waitFor({ state: "visible" });
  await p2.getByLabel("Password").fill(ADMIN_PASSWORD);
  await p2.keyboard.press("Enter");
  await p2.getByRole("link", { name: "Statistics" }).waitFor({ timeout: 15000 });
  check("the sign-in is typed line by line and Enter on the password signs in", true);
  check("the sign-in no longer asks 'remember me'", (await p2.getByLabel("Remember me").count()) === 0);
  await c2.close();
}

// --- Dialogs open centred, without sideways movement ---
{
  const sampling = page.evaluate(() => new Promise((resolve) => {
    const xs = []; const t0 = performance.now();
    const tick = () => {
      const el = document.querySelector('[role="dialog"]');
      if (el) { const r = el.getBoundingClientRect(); xs.push(Math.round(r.left + r.width / 2)); }
      if (performance.now() - t0 < 400) requestAnimationFrame(tick); else resolve(xs);
    };
    requestAnimationFrame(tick);
  }));
  await page.getByRole("button", { name: "Add device" }).first().click();
  const xs = await sampling;
  check("dialog opens without sideways movement", xs.length > 3 && Math.max(...xs) - Math.min(...xs) <= 1, `centre x ${Math.min(...xs)}–${Math.max(...xs)}`);
  await page.keyboard.press("Escape");
}

// --- Create a group from the sidebar ---
await page.getByRole("button", { name: "Add or manage groups" }).click();
await page.getByLabel("New group name").fill("Lab");
await page.getByRole("button", { name: "Create group" }).click();
await page.getByRole("dialog").getByText("Lab", { exact: true }).waitFor();
await shot("03a-groups");
await page.keyboard.press("Escape");
await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: /Lab/ }).waitFor();
check("create a group from the sidebar", true);

// --- Add device with the two-step wizard ---
await page.getByRole("button", { name: "Add device" }).first().click();
const dlg = page.getByRole("dialog");
await dlg.getByRole("radio", { name: "Linux" }).click();
await dlg.getByLabel("Name", { exact: true }).fill("Lab workstation");
await dlg.getByLabel("IP address or hostname").fill(TARGET_HOST);
await choose(dlg.locator("button.input").first(), "Lab");
await dlg.getByText("More details").click();
await dlg.getByLabel(/^Hostname/).fill("lab-ws-01");
await dlg.locator("#device-tags").fill("lab");
await dlg.locator("#device-tags").press("Enter");
await shot("03b-add-device-step1");
await dlg.getByRole("button", { name: "Continue" }).click();
for (const [p, port] of [["ssh", 12222], ["vnc", 15900], ["rdp", 13389]]) {
  const box = dlg.locator(`#m-${p}`);
  if (!(await box.isChecked())) await box.check();
  await dlg.getByLabel(`${p.toUpperCase()} port`).fill(String(port));
}
await dlg.getByRole("radio", { name: /Save username and password/ }).click();
await dlg.getByLabel("Username", { exact: true }).fill("tester");
await dlg.getByLabel("Password", { exact: true }).fill(TARGET_PASSWORD);
await shot("03c-add-device-step2");
await dlg.getByRole("button", { name: "Add device" }).click();
await page.getByRole("heading", { name: "Lab workstation" }).waitFor();
check("create device with three methods and saved sign-in via the wizard", true);
const deviceId = page.url().split("/devices/")[1];

// --- No manual verification step: identities are recorded on first connect ---
const cd = page.getByRole("dialog");
check("new methods need no manual verification", (await page.getByText("Trusted on first connect").count()) >= 2 && (await page.getByText(/Verify (certificate|host key)/).count()) === 0);

// Settings dialog tabs render
const rdpRow = page.locator("li", { hasText: "13389" });
await rdpRow.getByRole("button", { name: "Settings" }).click();
await cd.getByRole("button", { name: "Display" }).click();
await shot("04b-connection-settings-display");
await cd.getByRole("button", { name: "Sign-in" }).click();
await shot("04c-connection-settings-signin");
await cd.getByRole("button", { name: "Cancel" }).click();

const conns = await page.evaluate(async (id) => (await fetch(`/api/devices/${id}/connections`)).json(), deviceId);
const byProto = Object.fromEntries(conns.map((c) => [c.protocol, c]));
await page.getByRole("button", { name: "More actions", exact: true }).click();
await page.getByRole("menuitem", { name: "Check reachability now" }).click();
await page.getByText("Reachable", { exact: true }).waitFor({ timeout: 15000 });
await page.reload();
await shot("05-device-detail");

// Command palette
await page.getByRole("button", { name: /Search devices, pages and actions/ }).click();
await page.getByText("Quick actions", { exact: true }).waitFor();
await page.getByText("Go to", { exact: true }).waitFor();
await shot("05a-command-palette-empty");
check("the search box in the sidebar opens a palette with quick actions and pages", (await page.getByRole("button", { name: "Add device" }).count()) >= 1);
await page.getByPlaceholder(/Search devices, pages/).fill("lab");
await shot("05b-command-palette");
await page.keyboard.press("Escape");

// Edit device: everything visible without scrolling, and the dialog sits in the middle of the window
await page.getByRole("button", { name: "Edit", exact: true }).first().click();
await page.getByRole("dialog").getByText("Details", { exact: true }).waitFor();
await page.waitForTimeout(400);
const geo = await page.getByRole("dialog").evaluate((d) => {
  const body = d.querySelector(".overflow-y-auto");
  const r = d.getBoundingClientRect();
  return { scrolls: body.scrollHeight > body.clientHeight + 1, top: r.top, bottom: innerHeight - r.bottom, left: r.left, right: innerWidth - r.right };
});
await shot("05d-edit-device");
check("the Edit device dialog needs no scrolling", !geo.scrolls, JSON.stringify(geo));
check("dialogs are centred in the window", Math.abs(geo.top - geo.bottom) <= 2 && Math.abs(geo.left - geo.right) <= 2, JSON.stringify(geo));
await page.keyboard.press("Escape");

// --- System overview and SFTP file browser on the device page ---
const folderName = `ui-test-${Date.now()}`;
await page.getByRole("tab", { name: "System" }).click();
await page.getByText("Top processes").waitFor({ timeout: 30000 });
await page.waitForTimeout(500);
await shot("05c-system");
check("system tab shows CPU, memory, storage and logs", (await page.getByText("Recent system log").count()) === 1 && (await page.getByText("Uptime").count()) > 0);
await page.getByRole("tab", { name: "Files" }).click();
await page.getByRole("button", { name: "New folder" }).click();
await page.getByLabel(/Folder name in/).fill(folderName);
await page.getByRole("dialog").getByRole("button", { name: "Create" }).click();
await page.getByRole("button", { name: folderName, exact: true }).click();
await page.locator("input[type=file]").setInputFiles([
  { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello from emremote\n") },
  { name: "report.pdf", mimeType: "application/pdf", buffer: Buffer.alloc(180_000, 7) },
]);
await page.getByRole("button", { name: "report.pdf", exact: true }).waitFor();
await page.waitForTimeout(400);
await shot("05d-files");
check("create a folder and upload files through the UI", (await page.getByRole("button", { name: "notes.txt", exact: true }).count()) === 1);
await page.getByRole("button", { name: "Parent folder" }).click();
await page.getByRole("button", { name: `Actions for ${folderName}` }).click();
await page.getByRole("menuitem", { name: "Delete" }).click();
await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
await page.getByText(/Deleted 3 item/).waitFor();
const gone = await page.getByRole("button", { name: folderName, exact: true }).waitFor({ state: "detached", timeout: 10000 }).then(() => true, () => false);
check("delete a folder with its contents through the UI", gone);
await page.getByRole("tab", { name: "Overview" }).click();

// --- Live RDP session in the browser ---
async function session(conn, name, typed, minPainted, { follows = true, context = ctx, expectSize, resized = "1100×700" } = {}) {
  const p = await context.newPage();
  p.on("pageerror", (e) => consoleErrors.push(String(e)));
  await p.goto(`${BASE}/connect/${conn.id}`);
  await p.getByTitle("Connected").waitFor({ timeout: 30000 });
  const remote = async () => (await p.locator("[data-remote-size]").getAttribute("data-remote-size"))?.trim();
  // Count non-black pixels on the remote display's canvases; xrdp starts a
  // fresh X session per connection, so allow it a few seconds to paint.
  const countPainted = () => p.evaluate(() => {
    let n = 0;
    for (const c of document.querySelectorAll(".guac-viewport canvas")) {
      if (!c.width || !c.height) continue;
      const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
      for (let i = 0; i < d.length; i += 4 * 97) if (d[i + 3] && (d[i] | d[i + 1] | d[i + 2])) n++;
    }
    return n;
  });
  let painted = 0;
  for (let i = 0; i < 30 && painted <= minPainted; i++) {
    await p.waitForTimeout(500);
    painted = await countPainted();
  }
  check(`${name}: live session renders remote pixels in the browser`, painted > minPainted, `${painted} sampled pixels`);
  const noScroll = await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth && document.documentElement.scrollHeight <= window.innerHeight);
  check(`${name}: no page scrollbars`, noScroll);
  if (typed) {
    await p.locator("[aria-label^='Remote screen']").click({ position: { x: 300, y: 160 } });
    await p.waitForTimeout(400); // let the remote window manager focus the clicked window
    await p.keyboard.type(typed, { delay: 25 });
    await p.keyboard.press("Enter");
    await p.waitForTimeout(1500);
  }
  await shot(`06-session-${name.toLowerCase()}`, p);
  if (name === "SSH") {
    await p.getByRole("button", { name: "Files (SFTP)" }).click();
    await p.getByRole("button", { name: "Parent folder" }).waitFor({ timeout: 20000 });
    await p.waitForTimeout(800);
    await shot("06b-session-ssh-files", p);
    check("SSH session: SFTP side panel lists files", (await p.getByRole("button", { name: "Home folder" }).count()) === 1);
    const tbBox = await p.getByRole("toolbar", { name: "Session toolbar" }).boundingBox();
    check("toolbar stays clear of the files panel", tbBox !== null && tbBox.x >= 360, `toolbar left edge ${Math.round(tbBox?.x ?? -1)}px, panel ends at 360px`);
    await p.getByRole("button", { name: "Close files" }).click();
  }
  if (expectSize) {
    const initial = await remote();
    check(`${name}: remote resolution`, initial === expectSize, `remote ${initial}, expected ${expectSize}`);
  }
  // Resize the browser window: RDP (display-update) and SSH follow it; VNC keeps
  // the server's resolution and is scaled to fit instead.
  const before = await remote();
  await p.setViewportSize({ width: 1100, height: 700 });
  await p.waitForTimeout(2500);
  const size = await remote();
  if (follows) check(`${name}: remote resolution follows the browser window`, size === resized, `remote ${size}, expected ${resized}`);
  else {
    const width = await p.locator(".guac-viewport").evaluate((el) => el.getBoundingClientRect().width);
    check(`${name}: fixed-resolution desktop is scaled to fit the window`, size === before && width <= 1100, `remote ${size}, displayed width ${Math.round(width)}px`);
  }
  await shot(`07-session-${name.toLowerCase()}-resized`, p);
  await p.getByRole("button", { name: "Disconnect" }).click();
  await p.getByRole("heading", { name: "Session ended" }).waitFor();
  check(`${name}: disconnect shows clear state`, true);
  await p.close();
}

// A desktop paints most of the screen; a terminal only its (sparse) text.
await session(byProto.rdp, "RDP", "echo hello-from-emremote-browser", 5000);
await session(byProto.ssh, "SSH", "uname -a", 150);
await session(byProto.vnc, "VNC", null, 5000, { follows: false });

// --- Clipboard: Ctrl+V and right-click paste, without any clipboard permission ---
{
  const readRemote = (pg, path) => pg.evaluate(async ({ connId, path }) => {
    const csrf = (await (await fetch("/api/auth/me")).json()).csrf_token;
    const a = await (await fetch(`/api/connections/${connId}/ssh-access`, { method: "POST", headers: { "X-CSRF-Token": csrf, "Content-Type": "application/json" }, body: "{}" })).json();
    const r = await fetch(`/api/ssh-access/${a.id}/files/download?path=${encodeURIComponent(path)}`);
    const t = r.ok ? await r.text() : `HTTP ${r.status}`;
    await fetch(`/api/ssh-access/${a.id}`, { method: "DELETE", headers: { "X-CSRF-Token": csrf } });
    return t;
  }, { connId: byProto.ssh.id, path });
  const stamp = Date.now();
  const open = async (context, conn) => {
    const pg = await context.newPage();
    pg.on("pageerror", (e) => consoleErrors.push(String(e)));
    await pg.goto(`${BASE}/connect/${conn.id}`);
    await pg.getByTitle("Connected").waitFor({ timeout: 30000 });
    await pg.waitForTimeout(2500);
    return pg;
  };
  const setLocal = (pg, t) => pg.evaluate((t) => navigator.clipboard.writeText(t), t);
  const screen = (pg) => pg.locator("[aria-label^='Remote screen']");

  // No "clipboard-read" permission: only the paste event can deliver the text.
  const plain = await browser.newContext({ viewport: { width: 1280, height: 800 }, storageState: await ctx.storageState() });
  await plain.grantPermissions(["clipboard-write"], { origin: BASE }); // lets the test put text on the local clipboard
  const sp = await open(plain, byProto.ssh);
  await screen(sp).click({ position: { x: 400, y: 300 } });
  const f = `/home/tester/emr-paste-${stamp}.txt`;
  await setLocal(sp, `echo ctrl-v >> ${f}`);
  await sp.keyboard.press("Control+V");
  await sp.waitForTimeout(800);
  await sp.keyboard.press("Enter");
  await sp.waitForTimeout(1200);
  check("SSH: Ctrl+V pastes from this computer (no clipboard permission)", (await readRemote(sp, f)) === "ctrl-v\n", JSON.stringify(await readRemote(sp, f)));
  await screen(sp).click({ button: "right", position: { x: 400, y: 300 } });
  await sp.waitForTimeout(800);
  await sp.keyboard.press("Enter");
  await sp.waitForTimeout(1200);
  check("SSH: right-click pastes the same text (no clipboard permission)", (await readRemote(sp, f)) === "ctrl-v\nctrl-v\n", JSON.stringify(await readRemote(sp, f)));
  const tb = sp.getByRole("toolbar", { name: "Session toolbar" });
  check("SSH toolbar is terminal-specific (Ctrl+C, no Win, CAD or zoom)", (await tb.getByRole("button", { name: "Ctrl+C", exact: true }).count()) === 1 && (await tb.getByText("Win", { exact: true }).count()) === 0 && (await tb.getByText("Ctrl+Alt+Del").count()) === 0 && (await tb.getByTitle("Zoom in").count()) === 0);
  await shot("06f-ssh-toolbar", sp);
  // Snippets: save a command, insert it into the live SSH session, check its effect on the server.
  const fs_ = `/home/tester/emr-snip-${stamp}.txt`;
  await tb.getByRole("button", { name: "Snippets" }).click();
  await sp.getByRole("button", { name: "New snippet" }).first().click();
  const sd = sp.getByRole("dialog");
  await sd.getByLabel("Name").fill("append marker");
  await sd.getByLabel(/^Category/).fill("tests");
  await sd.getByLabel("Text").fill(`echo snippet-ok >> ${fs_}`);
  await sd.getByRole("button", { name: "Save" }).click();
  await sp.getByRole("button", { name: "Run append marker" }).waitFor();
  await shot("06i-snippets", sp);
  await sp.getByRole("button", { name: "Run append marker" }).click();
  await sp.waitForTimeout(1500);
  check("a snippet is typed into the terminal and runs", (await readRemote(sp, fs_)) === "snippet-ok\n", JSON.stringify(await readRemote(sp, fs_)));
  check("used snippets appear under Recent", (await sp.getByRole("region", { name: "Recent snippets" }).getByText("append marker").count()) === 1);
  await sp.getByRole("button", { name: "Type append marker" }).first().click();
  await sp.waitForTimeout(500);
  await sp.getByRole("button", { name: "Actions for append marker" }).first().click();
  await sp.getByRole("menuitem", { name: "Delete" }).click();
  await sp.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
  await sp.getByText("No snippets yet.").waitFor();
  await sp.getByRole("button", { name: "Close snippets" }).click();
  // Personal terminal look: pick a theme from the toolbar; the session reconnects rendered with it.
  // The remote screen is drawn on transparent layers, so read the real pixel from a screenshot.
  const bgPixel = async () => {
    const vp = sp.viewportSize();
    const png = await sp.screenshot({ clip: { x: vp.width - 40, y: vp.height - 40, width: 1, height: 1 } });
    const idat = [];
    let colorType = 2;
    for (let o = 8; o < png.length; ) {
      const len = png.readUInt32BE(o), type = png.toString("ascii", o + 4, o + 8);
      if (type === "IHDR") colorType = png[o + 8 + 9];
      if (type === "IDAT") idat.push(png.subarray(o + 8, o + 8 + len));
      o += 12 + len;
    }
    const raw = inflateSync(Buffer.concat(idat));
    const bpp = colorType === 6 ? 4 : 3;
    return [...raw.subarray(1, 1 + bpp)].slice(0, 3);
  };
  await tb.getByRole("button", { name: "Terminal appearance" }).click();
  await sp.getByRole("menuitemradio", { name: /Solarized Dark/ }).click();
  await sp.keyboard.press("Escape");
  await sp.waitForTimeout(800);
  await sp.getByTitle("Connected").waitFor({ timeout: 30000 });
  await sp.waitForTimeout(2500);
  const px = await bgPixel();
  await shot("06h-ssh-solarized", sp);
  check("choosing a terminal theme reconnects with that theme", !!px && Math.abs(px[0] - 0) <= 6 && Math.abs(px[1] - 43) <= 6 && Math.abs(px[2] - 54) <= 6, `background pixel ${JSON.stringify(px)} (expected about 0,43,54)`);
  const stored = await sp.evaluate(() => JSON.parse(localStorage.getItem("emremote-terminal-prefs") || "{}"));
  check("the choice is remembered in this browser only", stored.color_scheme === "solarized-dark");
  await sp.evaluate(() => localStorage.removeItem("emremote-terminal-prefs"));
  await sp.close();

  const rp = await open(plain, byProto.rdp);
  await screen(rp).click({ position: { x: 300, y: 160 } });
  await rp.waitForTimeout(400);
  const fr = `/home/tester/emr-rdp-${stamp}.txt`;
  await setLocal(rp, `echo rdp-ctrl-v > ${fr}`);
  await rp.keyboard.press("Control+V");
  await rp.waitForTimeout(1000);
  await rp.keyboard.press("Enter");
  await rp.waitForTimeout(1500);
  check("RDP: Ctrl+V pastes from this computer (no clipboard permission)", (await readRemote(rp, fr)) === "rdp-ctrl-v\n", JSON.stringify(await readRemote(rp, fr)));
  const rtb = rp.getByRole("toolbar", { name: "Session toolbar" });
  check("RDP to Linux toolbar offers Super, not Win", (await rtb.getByRole("button", { name: "Super", exact: true }).count()) >= 1 && (await rtb.getByText("Win", { exact: true }).count()) === 0);
  await rp.close();

  const vp = await open(plain, byProto.vnc);
  await screen(vp).click({ position: { x: 300, y: 160 } });
  await vp.waitForTimeout(400);
  const fv = `/home/tester/emr-vnc-${stamp}.txt`;
  await setLocal(vp, `echo vnc-ctrl-v > ${fv}`);
  await vp.keyboard.press("Control+V");
  await vp.waitForTimeout(1500);
  await vp.keyboard.press("Enter");
  await vp.waitForTimeout(1500);
  const vncGot = await readRemote(vp, fv);
  if (vncGot !== "vnc-ctrl-v\n") await shot("06z-vnc-paste-failure", vp); // what the remote screen showed
  check("VNC: Ctrl+V pastes from this computer (no clipboard permission)", vncGot === "vnc-ctrl-v\n", JSON.stringify(vncGot));
  await vp.close();
  await plain.close();

  // Where the browser already allows reading (Chromium, granted once), right-click
  // picks up text copied on this computer since, and remote copies arrive locally.
  const granted = await browser.newContext({ viewport: { width: 1280, height: 800 }, storageState: await ctx.storageState() });
  await granted.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE });
  const gp = await open(granted, byProto.ssh);
  await screen(gp).click({ position: { x: 400, y: 300 } });
  await setLocal(gp, `echo right-click >> ${f}`);
  await screen(gp).click({ button: "right", position: { x: 400, y: 300 } });
  await gp.waitForTimeout(800);
  await gp.keyboard.press("Enter");
  await gp.waitForTimeout(1200);
  check("SSH: right-click pastes newly copied local text when reading is allowed", (await readRemote(gp, f)) === "ctrl-v\nctrl-v\nright-click\n", JSON.stringify(await readRemote(gp, f)));
  await gp.keyboard.type("clear; echo COPYME-4711", { delay: 15 });
  await gp.keyboard.press("Enter");
  await gp.waitForTimeout(1000);
  const box = await screen(gp).boundingBox();
  await gp.mouse.move(box.x + 2, box.y + 20);
  await gp.mouse.down();
  await gp.mouse.move(box.x + 700, box.y + 22, { steps: 8 });
  await gp.mouse.up();
  await gp.waitForTimeout(1000);
  const local = await gp.evaluate(() => navigator.clipboard.readText());
  check("SSH: selecting text copies it to this computer", local.includes("COPYME-4711"), JSON.stringify(local.slice(0, 60)));
  await gp.close();
  await granted.close();

  // A Windows target (quick connections over RDP default to Windows) gets Windows keys.
  const qid = await page.evaluate(async ({ host, pw }) => {
    const csrf = (await (await fetch("/api/auth/me")).json()).csrf_token;
    const r = await fetch("/api/quick-connections", { method: "POST", headers: { "X-CSRF-Token": csrf, "Content-Type": "application/json" }, body: JSON.stringify({ host, protocol: "rdp", port: 13389, username: "tester", settings: {}, secret: { mode: "set", password: pw } }) });
    return (await r.json()).id;
  }, { host: TARGET_HOST, pw: TARGET_PASSWORD });
  const wp = await open(ctx, { id: qid });
  const wtb = wp.getByRole("toolbar", { name: "Session toolbar" });
  await wtb.getByRole("button", { name: "Keyboard shortcuts" }).click();
  const menuOk = (await wp.getByRole("menuitem", { name: /Task Manager/ }).count()) === 1;
  await wp.waitForTimeout(300);
  await shot("06g-windows-toolbar", wp);
  await wp.keyboard.press("Escape");
  check("Windows toolbar offers Ctrl+Alt+Del, Win and Windows shortcuts", (await wtb.getByRole("button", { name: "Ctrl+Alt+Del", exact: true }).count()) === 1 && (await wtb.getByText("Win", { exact: true }).count()) >= 1 && (await wtb.getByText("⌘").count()) === 0 && menuOk);
  await wp.close();
}

// --- Floating toolbar: zoom, held modifiers, collapse ---
{
  const p = await ctx.newPage();
  await p.goto(`${BASE}/connect/${byProto.rdp.id}`);
  await p.getByTitle("Connected").waitFor({ timeout: 30000 });
  await p.waitForTimeout(1500);
  const bar = p.getByRole("toolbar", { name: "Session toolbar" });
  await shot("06c-toolbar", p);
  await bar.getByTitle("Zoom in").click();
  const zoomed = await bar.getByTitle("Actual size (100%)").textContent();
  await bar.getByTitle("Fit to window").click();
  check("toolbar zoom changes the scale", zoomed !== null && /\d+%/.test(zoomed), zoomed ?? "");
  await bar.getByTitle("Hold Ctrl for the next key").click();
  const held = await bar.getByTitle("Hold Ctrl for the next key").getAttribute("aria-pressed");
  await p.locator("[aria-label^='Remote screen']").click({ position: { x: 300, y: 300 } });
  await p.keyboard.press("a");
  await p.waitForTimeout(300);
  const released = await bar.getByTitle("Hold Ctrl for the next key").getAttribute("aria-pressed");
  check("held Ctrl applies to the next key and is then released", held === "true" && released === "false", `held=${held} after=${released}`);
  await bar.getByTitle("Hide toolbar").click();
  await shot("06d-toolbar-collapsed", p);
  await p.getByTitle("Show toolbar").click();
  check("toolbar collapses and expands", (await bar.getByTitle("Zoom in").count()) === 1);
  await bar.getByTitle("Hide completely (Ctrl+Alt+Shift+T)").click();
  const hidden = (await bar.count()) === 0;
  await p.mouse.move(640, 3);
  await p.getByRole("button", { name: "Show toolbar" }).click();
  check("toolbar hides completely and returns from the top edge", hidden && (await bar.count()) === 1);
  await p.getByRole("button", { name: "Disconnect" }).click();
  await p.close();
}

// --- Keyboard layout follows this computer (Turkish Q keyboard simulated) ---
{
  const tr = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "tr-TR", storageState: await ctx.storageState() });
  await tr.addInitScript(() => {
    Object.defineProperty(navigator, "keyboard", { value: { getLayoutMap: async () => new Map([["KeyI", "ı"], ["Quote", "i"], ["KeyQ", "q"]]) } });
  });
  const p = await tr.newPage();
  await p.goto(`${BASE}/connect/${byProto.rdp.id}`);
  await p.getByTitle("Connected").waitFor({ timeout: 30000 });
  const layout = await p.evaluate(async () => {
    const r = await (await fetch("/api/audit?action=session.start&limit=1")).json();
    return r.events[0]?.details?.keyboard_layout;
  });
  check("RDP keyboard layout is detected from this computer (Turkish Q)", layout === "tr-tr-qwerty", `layout=${layout}`);
  await p.getByRole("button", { name: "Disconnect" }).click();
  await tr.close();
}

// HiDPI on a 2x screen. Default: guacd keeps RDP at a normal 96-DPI logical
// size. "Native pixel density": the remote desktop runs at device resolution.
const hidpi = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, storageState: await ctx.storageState() });
await session(byProto.rdp, "RDP on 2x screen (auto density)", null, 5000, { context: hidpi, expectSize: "1280×800" });
await hidpi.addInitScript(() => localStorage.setItem("emremote-session-prefs", JSON.stringify({ density: "native" })));
await session(byProto.rdp, "RDP on 2x screen (native density)", null, 5000, { context: hidpi, expectSize: "2560×1600", resized: "2200×1400" });
await hidpi.close();

// After the first sessions, the identities show as verified.
await page.goto(`${BASE}/devices/${deviceId}`);
await page.getByText("Verified").first().waitFor();
check("server identities were recorded automatically by the first sessions", (await page.getByText("Verified").count()) === 2);
await shot("05e-device-detail-verified");

// --- Network device via the wizard: Telnet + a saved credential ---
{
  await page.evaluate(async (pw) => {
    const csrf = (await (await fetch("/api/auth/me")).json()).csrf_token;
    await fetch("/api/credentials", { method: "POST", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf }, body: JSON.stringify({ name: "Lab tester", username: "tester", domain: "", secret: { mode: "set", password: pw } }) });
  }, TARGET_PASSWORD);
  await page.goto(`${BASE}/devices`);
  await page.getByRole("button", { name: "Add device" }).first().click();
  const w = page.getByRole("dialog");
  await w.getByRole("radio", { name: "Other" }).click();
  await w.getByLabel("Name", { exact: true }).fill("Core switch");
  await w.getByLabel("IP address or hostname").fill(TARGET_HOST);
  await choose(w.locator("button.input").nth(1), "Network device");
  await w.getByRole("button", { name: "Continue" }).click();
  for (const p of ["ssh", "vnc", "rdp"]) if (await w.locator(`#m-${p}`).isChecked()) await w.locator(`#m-${p}`).uncheck();
  await w.locator("#m-telnet").check();
  await w.getByLabel("Telnet port").fill("12323");
  await w.getByRole("radio", { name: /Use a saved credential/ }).click();
  await choose(w.locator("button.input"), "Lab tester (tester)");
  await shot("03d-add-network-device");
  check("wizard offers saved credentials and marks Telnet unencrypted", (await w.getByText("Unencrypted").count()) >= 1);
  await w.getByRole("button", { name: "Add device" }).click();
  await page.getByRole("heading", { name: "Core switch" }).waitFor();
  const telConn = (await page.evaluate(async () => (await (await fetch("/api/connections")).json()))).find((x) => x.device_name === "Core switch");
  check("wizard links the saved credential", telConn?.protocol === "telnet" && telConn.credential_name === "Lab tester", `${telConn?.protocol} ${telConn?.credential_name}`);
  const tp = await ctx.newPage();
  await tp.goto(`${BASE}/connect/${telConn.id}`);
  await tp.getByTitle("Connected").waitFor({ timeout: 30000 });
  await tp.waitForTimeout(4000);
  const painted = await tp.evaluate(() => {
    let n = 0;
    for (const c of document.querySelectorAll(".guac-viewport canvas")) {
      if (!c.width || !c.height) continue;
      const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
      for (let i = 0; i < d.length; i += 4 * 97) if (d[i + 3] && (d[i] | d[i + 1] | d[i + 2])) n++;
    }
    return n;
  });
  await shot("06e-session-telnet", tp);
  // The automatic sign-in itself is verified byte-for-byte against a switch-style
  // server (see docs/DEVELOPMENT.md); here we check the session renders the device's prompt.
  check("Telnet session connects and renders the device's terminal", painted > 20, `${painted} sampled pixels`);
  // BusyBox telnetd in the test target may already have closed the session.
  await tp.getByRole("button", { name: "Disconnect" }).click({ timeout: 3000 }).catch(() => {});
  await tp.close();
}

// --- Windows device with RDP only ---
const mkWin = (name, password) =>
  page.evaluate(
    async ([name, host, password]) => {
      const csrf = (await (await fetch("/api/auth/me")).json()).csrf_token;
      const h = { "Content-Type": "application/json", "X-CSRF-Token": csrf };
      const d = await (await fetch("/api/devices", { method: "POST", headers: h, body: JSON.stringify({ name, hostname: "", address: host, os: "windows", device_type: "desktop", description: "", notes: "", tags: [], group_id: null, favorite: false }) })).json();
      await fetch(`/api/devices/${d.id}/connections`, { method: "POST", headers: h, body: JSON.stringify({ name: "RDP", protocol: "rdp", port: 13389, username: "tester", domain: "", credential_id: null, settings: {}, secret: password ? { mode: "set", password } : { mode: "keep" } }) });
      return d.id;
    },
    [name, TARGET_HOST, password],
  );
const winId = await mkWin("Office PC (RDP only)", TARGET_PASSWORD);
await page.goto(`${BASE}/devices/${winId}?tab=system`);
await page.getByText("Top processes").waitFor({ timeout: 40000 });
await shot("17-windows-rdp-system-auto");
check("RDP-only device: System tab finds SSH and uses the RDP sign-in automatically", true);
const win2 = await mkWin("Reception PC (no saved password)", "");
await page.goto(`${BASE}/devices/${win2}?tab=files`);
await page.getByText("RDP transfer drive").waitFor({ timeout: 20000 });
await page.getByRole("button", { name: "Check again" }).waitFor();
await shot("18-windows-rdp-files-transfer");
check("RDP-only device without SSH access: transfer drive and setup guidance are shown", (await page.getByRole("button", { name: "New folder" }).count()) === 1);
await page.evaluate(async (ids) => {
  const csrf = (await (await fetch("/api/auth/me")).json()).csrf_token;
  for (const id of ids) await fetch(`/api/devices/${id}`, { method: "DELETE", headers: { "X-CSRF-Token": csrf } });
}, [winId, win2]);

// --- SFTP transfer page: server-to-server copy ---
{
  const name = `ui-copy-${Date.now()}.txt`;
  await page.evaluate(async ({ id, name }) => {
    const csrf = (await (await fetch("/api/auth/me")).json()).csrf_token;
    await fetch(`/api/devices/${id}/transfer/upload?dir=%2F&name=${encodeURIComponent(name)}`, { method: "POST", body: "copied by the browser test\n", headers: { "X-CSRF-Token": csrf, "Content-Type": "application/octet-stream" } });
  }, { id: deviceId, name });
  await page.getByRole("link", { name: "SFTP transfer" }).click();
  await page.getByRole("heading", { name: "SFTP transfer" }).waitFor();
  const srcPane = page.getByRole("region", { name: "Source" });
  const dstPane = page.getByRole("region", { name: "Destination" });
  await choose(page.getByLabel("Source server"), "Lab workstation (RDP transfer drive)");
  await choose(page.getByLabel("Destination server"), "Lab workstation (SFTP)");
  await srcPane.getByLabel(`Select ${name}`).check();
  await dstPane.getByRole("button", { name: "Home folder" }).waitFor({ timeout: 30000 });
  await page.waitForTimeout(500);
  await page.getByRole("button", { name: "Copy", exact: true }).click();
  const arrived = await dstPane.getByRole("button", { name, exact: true }).waitFor({ timeout: 20000 }).then(() => true, () => false);
  await page.waitForTimeout(300);
  await shot("19-sftp-transfer");
  check("SFTP transfer page copies a file from one server to another", arrived && (await page.getByText(/1 of 1 files/).count()) === 1);
  await page.evaluate(async ({ id, name }) => {
    const csrf = (await (await fetch("/api/auth/me")).json()).csrf_token;
    await fetch(`/api/devices/${id}/transfer/delete`, { method: "POST", body: JSON.stringify({ paths: [`/${name}`], recursive: false }), headers: { "X-CSRF-Token": csrf, "Content-Type": "application/json" } });
  }, { id: deviceId, name });
}

// --- Quick connect from Overview (nothing saved) ---
{
  await page.goto(`${BASE}/`);
  await page.getByRole("button", { name: "Quick connect" }).waitFor();
  const before = await page.evaluate(async () => (await (await fetch("/api/connections")).json()).length);
  await page.getByRole("button", { name: "Quick connect" }).click();
  const dlg = page.getByRole("dialog");
  await dlg.getByRole("radio", { name: "SSH" }).click();
  await dlg.getByLabel("Host", { exact: true }).fill(TARGET_HOST);
  await dlg.getByLabel("Port", { exact: true }).fill("12222");
  await dlg.getByLabel(/^User name/).fill("tester");
  await dlg.getByLabel(/^Password/).fill(TARGET_PASSWORD);
  await shot("20-quick-connect");
  const popupP = ctx.waitForEvent("page");
  await dlg.getByRole("button", { name: "Connect", exact: true }).click();
  const qp = await popupP;
  qp.on("pageerror", (e) => consoleErrors.push(String(e)));
  const ok = await qp.getByTitle("Connected").waitFor({ timeout: 30000 }).then(() => true, () => false);
  await qp.waitForTimeout(1500);
  await shot("21-quick-session", qp);
  const after = await page.evaluate(async () => (await (await fetch("/api/connections")).json()).length);
  check("Quick connect opens a live session without saving anything", ok && /\/workspace/.test(qp.url()) && after === before, `url=${qp.url()} connections ${before}→${after}`);
  await qp.close();
}

// --- Import and export of the inventory ---
{
  const tag = Date.now().toString(36);
  await page.goto(`${BASE}/devices`);
  await page.getByRole("heading", { name: "All devices" }).waitFor();
  await page.getByRole("button", { name: "Import / Export" }).click();
  await page.getByRole("menuitem", { name: "Import devices…" }).click();
  const id = page.getByRole("dialog");
  await id.getByLabel("Content to import").fill(`name,address,os,protocol,port,username,group,tags\nimp-${tag}-a,10.10.1.50,linux,ssh,22,root,Imported,x;y\nimp-${tag}-a,10.10.1.50,linux,vnc,5900,,Imported,x;y\nimp-${tag}-bad,not a host!,linux,ssh,22,,,`);
  await id.getByRole("button", { name: "Preview" }).click();
  await id.getByText(/Read as/).waitFor();
  await shot("25-import-preview", page);
  const summary = await id.getByText(/Read as/).innerText();
  check("import preview reads a CSV and flags the invalid row", /CSV: 1 new, 0 already exist, 1 invalid/.test(summary) && (await id.getByText("Invalid").count()) >= 1, summary);
  await id.getByRole("button", { name: "Import 1 device" }).click();
  await id.getByText(/Imported 1 device with 2 connection methods/).waitFor();
  await id.getByRole("button", { name: "Done" }).click();
  await page.getByText(`imp-${tag}-a`).first().waitFor();
  const made = await page.evaluate(async (n) => {
    const ds = await (await fetch("/api/devices")).json();
    const d = ds.find((x) => x.name === n);
    return d ? { methods: d.connections.map((c) => c.protocol).sort().join(","), group: d.group_name, tags: d.tags.join(",") } : null;
  }, `imp-${tag}-a`);
  check("an imported device arrives with its methods, group and tags", made?.methods === "ssh,vnc" && made.group === "Imported" && made.tags === "x,y", JSON.stringify(made));
  const dl = page.waitForEvent("download");
  await page.getByRole("button", { name: "Import / Export" }).click();
  await page.getByRole("menuitem", { name: "Export as JSON" }).click();
  const file = await dl;
  check("the export downloads as a JSON file", /^emremote-inventory-\d{8}\.json$/.test(file.suggestedFilename()), file.suggestedFilename());
  await page.evaluate(async (n) => {
    const csrf = (await (await fetch("/api/auth/me")).json()).csrf_token;
    for (const d of await (await fetch("/api/devices")).json()) if (d.name.startsWith(n)) await fetch(`/api/devices/${d.id}`, { method: "DELETE", headers: { "X-CSRF-Token": csrf } });
    for (const g of await (await fetch("/api/groups")).json()) if (g.name === "Imported") await fetch(`/api/groups/${g.id}`, { method: "DELETE", headers: { "X-CSRF-Token": csrf } });
  }, `imp-${tag}`);
}

// --- Workspace: tabs and split panes ---
{
  const tag = Date.now().toString(36);
  const conns = await page.evaluate(async () => (await (await fetch("/api/connections")).json()));
  const sshId = conns.find((c) => c.protocol === "ssh" && c.device_name === "Lab workstation").id;
  const activeCount = () => page.evaluate(async () => (await (await fetch("/api/active-sessions")).json()).length);
  const readRemote = (path) => page.evaluate(async ({ connId, path }) => {
    const csrf = (await (await fetch("/api/auth/me")).json()).csrf_token;
    const a = await (await fetch(`/api/connections/${connId}/ssh-access`, { method: "POST", headers: { "X-CSRF-Token": csrf, "Content-Type": "application/json" }, body: "{}" })).json();
    const r = await fetch(`/api/ssh-access/${a.id}/files/download?path=${encodeURIComponent(path)}`);
    const t = r.ok ? await r.text() : `HTTP ${r.status}`;
    await fetch(`/api/ssh-access/${a.id}`, { method: "DELETE", headers: { "X-CSRF-Token": csrf } });
    return t;
  }, { connId: sshId, path });
  const before = await activeCount();

  // Launching from the app opens ONE workspace window; later launches add tabs to it.
  await page.goto(`${BASE}/devices`);
  await page.getByRole("heading", { name: "All devices" }).waitFor();
  const launchSSH = async () => {
    await page.getByRole("row", { name: /Lab workstation/ }).getByRole("button", { name: /Connect/ }).click();
    await page.getByRole("menuitem", { name: /SSH/ }).first().click();
  };
  const popup = ctx.waitForEvent("page");
  await launchSSH();
  const ws = await popup;
  ws.on("pageerror", (e) => consoleErrors.push(String(e)));
  await ws.getByRole("tab").first().waitFor({ timeout: 30000 });
  const pagesBefore = ctx.pages().length;
  await launchSSH();
  await ws.getByRole("tab").nth(1).waitFor({ timeout: 30000 });
  await page.waitForTimeout(800);
  check("a second launch adds a tab to the open workspace instead of opening another window", ctx.pages().length === pagesBefore && (await ws.getByRole("tab").count()) === 2, `windows ${pagesBefore}→${ctx.pages().length}, tabs ${await ws.getByRole("tab").count()}`);
  await ws.locator("[data-active-pane]").getByTitle("Connected").waitFor({ timeout: 30000 });
  await shot("31-workspace-tabs", ws);

  // A third shell (added the way other pages do it), then two side by side
  await ws.evaluate((id) => { const ch = new BroadcastChannel("emremote-workspace"); ch.postMessage({ type: "open", id }); setTimeout(() => ch.close(), 200); }, sshId);
  await ws.getByRole("tab").nth(2).waitFor({ timeout: 30000 });
  await ws.getByRole("button", { name: "Two side by side" }).click();
  await ws.locator("[data-pane]").nth(1).waitFor();
  await ws.waitForTimeout(3500);
  const panes = await ws.locator("[data-pane]").count();
  check("the two-column layout shows two sessions side by side", panes === 2 && (await ws.getByRole("button", { name: "Two side by side" }).getAttribute("aria-pressed")) === "true", `${panes} panes`);
  await shot("32-workspace-split", ws);

  // Keys go to the active pane only: each command is appended once, by its own shell
  const f0 = `/home/tester/emr-ws-${tag}-0.txt`, f1 = `/home/tester/emr-ws-${tag}-1.txt`;
  const typeIn = async (pane, text) => {
    const box = await ws.locator(`[data-pane="${pane}"] [aria-label^='Remote screen']`).boundingBox();
    await ws.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await ws.waitForTimeout(400);
    await ws.keyboard.type(text, { delay: 20 });
    await ws.keyboard.press("Enter");
    await ws.waitForTimeout(1200);
  };
  await typeIn(0, `echo x0 >> ${f0}`);
  await typeIn(1, `echo x1 >> ${f1}`);
  const [a, b] = [await readRemote(f0), await readRemote(f1)];
  check("typing goes only to the active pane (no cross-talk between sessions)", a === "x0\n" && b === "x1\n", `pane 0 file ${JSON.stringify(a)}, pane 1 file ${JSON.stringify(b)}`);
  check("the active pane is marked", (await ws.locator("[data-active-pane]").count()) === 1);

  // Four panes, then closing tabs ends the sessions
  await ws.getByRole("button", { name: "Four panes" }).click();
  await ws.waitForTimeout(1500);
  const four = await ws.locator("[data-pane]").count();
  check("the four-pane layout fills panes with the open sessions", four >= 3, `${four} panes with a session`);
  await shot("33-workspace-grid", ws);
  const tabCount = await ws.getByRole("tab").count();
  const midCount = await activeCount();
  // Closing a live session asks first; cancelling keeps it, confirming ends it.
  await ws.getByRole("button", { name: /^Close / }).first().click();
  await ws.getByRole("heading", { name: "Close this session?" }).waitFor();
  await shot("33b-close-session-confirm", ws);
  await ws.getByRole("button", { name: "Cancel" }).click();
  await ws.waitForTimeout(500);
  check("cancelling the close prompt keeps the session", (await ws.getByRole("tab").count()) === tabCount && (await activeCount()) === midCount, `tabs ${await ws.getByRole("tab").count()}/${tabCount}`);
  await ws.getByRole("button", { name: /^Close / }).first().click();
  await ws.getByRole("button", { name: "Close session" }).click();
  await ws.waitForTimeout(2500);
  const afterClose = await activeCount();
  check("closing a tab ends that remote session", (await ws.getByRole("tab").count()) === tabCount - 1 && afterClose === midCount - 1, `tabs ${tabCount}→${await ws.getByRole("tab").count()}, live sessions ${midCount}→${afterClose}`);
  await ws.getByRole("button", { name: "One session" }).click();
  await ws.waitForTimeout(800);
  check("back to one session shows a single pane", (await ws.locator("[data-pane]").count()) === 1);
  // Closing the workspace window ends the rest
  await ws.close({ runBeforeUnload: false });
  await page.waitForTimeout(3000);
  check("closing the workspace window ends all of its sessions", (await activeCount()) <= before, `before ${before}, after ${await activeCount()}`);
}

// --- Overview and Statistics ---
{
  await page.goto(`${BASE}/`);
  await page.getByText("Fleet health").waitFor();
  await page.getByText("Session activity").waitFor();
  await page.waitForTimeout(600);
  await shot("39-overview", page);
  const gaps = await page.evaluate(() => {
    // Cards that share a row must end at the same height (no ragged gaps between them).
    const cards = [...document.querySelectorAll("main .card")].map((c) => c.getBoundingClientRect());
    return cards.length;
  });
  check("the overview shows its panels", gaps >= 8, `${gaps} cards`);
  await page.goto(`${BASE}/statistics`);
  await page.getByText("Sessions per day").waitFor();
  await page.getByText("When sessions start").waitFor();
  await page.getByRole("button", { name: "90 days" }).click();
  await page.getByRole("button", { name: "90 days" }).and(page.locator("[aria-pressed=true]")).waitFor();
  await page.waitForTimeout(500);
  await shot("40-statistics", page);
  check("statistics can switch the period", true);
  await page.getByRole("button", { name: "30 days" }).click();
}

// --- Jump host networks are managed in Settings ---
{
  await page.goto(`${BASE}/settings?tab=access`);
  const box = page.getByLabel("Networks behind jump hosts");
  await box.waitFor();
  await box.fill("172.29.77.0/24");
  await page.locator("section", { hasText: "Networks behind jump hosts" }).getByRole("button", { name: "Save", exact: true }).click();
  await page.getByText("Jump host networks saved.").waitFor({ timeout: 8000 });
  await shot("37-settings-jump-hosts", page);
  check("administrators can set the jump host networks in Settings", true);
}

// --- Files and images dropped or pasted on an RDP session go to its transfer drive ---
{
  const conns = await page.evaluate(async () => (await (await fetch("/api/connections")).json()));
  const rdpC = conns.find((c) => c.protocol === "rdp" && c.device_name === "Lab workstation");
  const rp = await ctx.newPage();
  rp.on("pageerror", (e) => consoleErrors.push(String(e)));
  await rp.goto(`${BASE}/connect/${rdpC.id}`);
  await rp.getByTitle("Connected").waitFor({ timeout: 40000 });
  await rp.waitForTimeout(1500);
  const fname = `drop-${Date.now()}.txt`;
  await rp.evaluate(async (name) => {
    const el = document.querySelector("[aria-label^='Remote screen']");
    const dt = new DataTransfer();
    dt.items.add(new File(["hello from the browser"], name, { type: "text/plain" }));
    el.dispatchEvent(new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true }));
    el.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, fname);
  const fb = rp.getByRole("button", { name: /tsclient/ });
  await fb.waitFor({ timeout: 10000 });
  const b0 = await fb.boundingBox();
  await rp.mouse.move(b0.x + b0.width / 2, b0.y + b0.height / 2);
  await rp.mouse.down();
  await rp.mouse.move(b0.x - 300, b0.y + 120, { steps: 8 });
  await rp.mouse.up();
  const b1 = await fb.boundingBox();
  check("the floating file button is draggable and stays on screen", Math.abs(b1.x - b0.x) > 200 && b1.x >= 0 && b1.y + b1.height <= 900, `${Math.round(b0.x)},${Math.round(b0.y)} -> ${Math.round(b1.x)},${Math.round(b1.y)}`);
  // Screenshots: the whole screen, and a dragged area, both downloaded straight from the browser
  const { statSync } = await import("node:fs");
  try {
    const dlFull = rp.waitForEvent("download", { timeout: 15000 });
    dlFull.catch(() => undefined);
    await rp.getByRole("button", { name: "Screenshot" }).click();
    await rp.screenshot({ path: `${SHOTS}/38x-screenshot-menu.png` });
    await rp.getByRole("menuitem", { name: "Whole screen" }).click();
    const shotFull = await dlFull.catch(async (e) => {
      await rp.screenshot({ path: `${SHOTS}/38y-screenshot-failed.png` });
      console.log("DIAGNOSTIC console errors:", JSON.stringify(consoleErrors.slice(-8)));
      console.log("DIAGNOSTIC toasts/text:", JSON.stringify((await rp.locator("[role=status], [role=alert], [data-sonner-toast]").allInnerTexts()).slice(0, 5)));
      throw e;
    });
    const fullSize = statSync(await shotFull.path()).size;
    check("a whole-screen screenshot is downloaded as a PNG", /\.png$/.test(shotFull.suggestedFilename()) && fullSize > 1000, `${shotFull.suggestedFilename()} ${fullSize} bytes`);
    await rp.getByRole("button", { name: "Screenshot" }).click();
    await rp.getByRole("menuitem", { name: "Select an area…" }).click();
    await rp.getByText(/Drag over the part of the screen/).waitFor();
    const dlArea = rp.waitForEvent("download");
    await rp.mouse.move(250, 250);
    await rp.mouse.down();
    await rp.mouse.move(650, 480, { steps: 6 });
    await rp.mouse.up();
    const shotArea = await dlArea;
    const areaSize = statSync(await shotArea.path()).size;
    check("a selected area is downloaded as a smaller PNG", areaSize > 200 && areaSize < fullSize, `${areaSize} < ${fullSize}`);
    await rp.getByText(/Sent: /).waitFor({ timeout: 15000 });
    await shot("38-sent-to-remote-drive", rp);
  } catch (e) {
    check("screenshots of the remote screen are downloaded", false, String(e.message ?? e).split("\n")[0]);
  }
  // A pasted image (no text on the clipboard) takes the same path
  await rp.evaluate(async () => {
    const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([png], "image.png", { type: "image/png" }));
    const ta = document.querySelector("textarea[data-paste-sink]");
    ta.focus();
    ta.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await rp.waitForTimeout(2500);
  const listing = await page.evaluate(async (dev) => (await (await fetch(`/api/devices/${dev}/transfer?path=from-browser`)).json()), rdpC.device_id);
  const names = (listing.entries ?? []).map((e) => e.name);
  check("a dropped file reaches the transfer drive", names.includes(fname), names.join(", "));
  check("a pasted image reaches the transfer drive with a readable name", names.some((n) => /^pasted-image-\d{14}\.png$/.test(n)), names.join(", "));
  await rp.close();
}

// --- Sharing a session, and Wake-on-LAN from the device page ---
{
  const conns = await page.evaluate(async () => (await (await fetch("/api/connections")).json()));
  const sshC = conns.find((c) => c.protocol === "ssh" && c.device_name === "Lab workstation");
  const sp = await ctx.newPage();
  sp.on("pageerror", (e) => consoleErrors.push(String(e)));
  await sp.goto(`${BASE}/connect/${sshC.id}`);
  await sp.getByTitle("Connected").waitFor({ timeout: 40000 });
  await sp.waitForTimeout(1200);
  await sp.getByRole("button", { name: /Share this session/ }).click();
  const sd = sp.getByRole("dialog");
  await sd.getByRole("button", { name: /Create a view-only link/ }).click();
  const url = (await sd.locator("span.select-all").textContent()).trim();
  await shot("34-share-dialog", sp);
  const wp = await ctx.newPage();
  wp.on("pageerror", (e) => consoleErrors.push(String(e)));
  await wp.goto(url);
  await wp.getByText("View only").waitFor({ timeout: 20000 });
  await wp.getByText("Live").waitFor({ timeout: 30000 });
  await wp.waitForTimeout(2000);
  const lit = await wp.evaluate(() => {
    let n = 0;
    for (const c of document.querySelectorAll("canvas")) {
      if (!c.width || !c.height) continue;
      const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
      for (let i = 0; i < d.length; i += 4 * 61) if (d[i + 3] && (d[i] | d[i + 1] | d[i + 2])) n++;
    }
    return n;
  });
  await shot("35-watching-shared-session", wp);
  check("a shared session can be watched through its link", lit > 50, `${lit} lit pixels`);
  await sp.waitForTimeout(4500);
  check("the owner sees how many are watching", (await sd.getByText(/1 person is watching/).count()) === 1);
  await sd.getByRole("button", { name: "Stop sharing" }).click();
  await wp.getByText("The shared session has ended.").waitFor({ timeout: 15000 });
  check("stopping sharing ends the watcher's view", true);
  await wp.close();
  await sp.close();

  // Wake button
  await page.evaluate(async (id) => {
    const csrf = (await (await fetch("/api/auth/me")).json()).csrf_token;
    const d = await (await fetch(`/api/devices/${id}`)).json();
    const body = { name: d.name, hostname: d.hostname, address: d.address, os: d.os, device_type: d.device_type, description: d.description, notes: d.notes, tags: d.tags, group_id: d.group_id, favorite: d.favorite, mac: "aa:bb:cc:dd:ee:01" };
    await fetch(`/api/devices/${id}`, { method: "PUT", headers: { "X-CSRF-Token": csrf, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  }, sshC.device_id);
  await page.goto(`${BASE}/devices/${sshC.device_id}`);
  await page.getByRole("button", { name: "Wake" }).click();
  await page.getByText(/Wake-up packet sent/).waitFor({ timeout: 10000 });
  await shot("36-device-with-wake", page);
  check("the device page offers Wake and confirms the packet was sent", (await page.getByText("aa:bb:cc:dd:ee:01").count()) >= 1);
}

// --- Jump host: choose a bastion in the connection form and open a session behind it ---
{
  const tag = Date.now().toString(36);
  const ids = await page.evaluate(async ({ tag, pw }) => {
    const csrf = (await (await fetch("/api/auth/me")).json()).csrf_token;
    const h = { "X-CSRF-Token": csrf, "Content-Type": "application/json" };
    const d = await (await fetch("/api/devices", { method: "POST", headers: h, body: JSON.stringify({ name: `jump-inner-${tag}`, hostname: "", address: "172.29.77.10", os: "linux", device_type: "server", description: "", notes: "", tags: [], group_id: null, favorite: false }) })).json();
    const c = await (await fetch(`/api/devices/${d.id}/connections`, { method: "POST", headers: h, body: JSON.stringify({ name: "SSH", protocol: "ssh", port: 22, username: "tester", domain: "", credential_id: null, settings: {}, secret: { mode: "set", password: pw } }) })).json();
    return { device: d.id, conn: c.id };
  }, { tag, pw: TARGET_PASSWORD });
  await page.goto(`${BASE}/devices/${ids.device}`);
  await page.getByRole("heading", { name: `jump-inner-${tag}` }).waitFor();
  await page.getByRole("button", { name: "Settings", exact: true }).first().click();
  const jd = page.getByRole("dialog");
  await jd.getByRole("button", { name: "Advanced" }).click();
  await jd.getByText("Connect through a jump host").waitFor();
  await choose(jd.getByLabel(/^Jump host/), 1);
  await shot("29-jump-host-form", page);
  await jd.getByRole("button", { name: "Save changes" }).click();
  await page.getByText(/via /).first().waitFor();
  check("the connection form offers jump hosts and the device shows it is reached through one", (await page.getByText(/via /).count()) >= 1);
  const jp = await ctx.newPage();
  jp.on("pageerror", (e) => consoleErrors.push(String(e)));
  await jp.goto(`${BASE}/connect/${ids.conn}`);
  const up = await jp.getByTitle("Connected").waitFor({ timeout: 40000 }).then(() => true, () => false);
  await jp.waitForTimeout(2500);
  await shot("30-jump-host-session", jp);
  const inner = await jp.evaluate(() => {
    let n = 0;
    for (const c of document.querySelectorAll(".guac-viewport canvas")) {
      if (!c.width || !c.height) continue;
      const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
      for (let i = 0; i < d.length; i += 4 * 97) if (d[i + 3] && (d[i] | d[i + 1] | d[i + 2])) n++;
    }
    return n;
  });
  check("a terminal opens on the device behind the jump host", up && inner > 100, `connected=${up}, ${inner} sampled pixels`);
  await jp.close();
  await page.evaluate(async (id) => {
    const csrf = (await (await fetch("/api/auth/me")).json()).csrf_token;
    await fetch(`/api/devices/${id}`, { method: "DELETE", headers: { "X-CSRF-Token": csrf } });
  }, ids.device);
}

// --- Two-factor sign-in through the terminal-style login ---
{
  const b32 = (str) => { const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"; let bits = 0, val = 0; const out = []; for (const ch of str) { val = (val << 5) | A.indexOf(ch); bits += 5; if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; } } return Buffer.from(out); };
  const code = (secret, step) => { const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(step)); const h = createHmac("sha1", b32(secret)).update(msg).digest(); const o = h[h.length - 1] & 15; return String((((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1000000).padStart(6, "0"); };
  const uname = `ui-2fa-${Date.now().toString(36)}`, upw = "Ui-twofa-pass-1";
  await page.evaluate(async ({ uname, upw }) => {
    const csrf = (await (await fetch("/api/auth/me")).json()).csrf_token;
    await fetch("/api/users", { method: "POST", headers: { "X-CSRF-Token": csrf, "Content-Type": "application/json" }, body: JSON.stringify({ username: uname, password: upw, role: "member", team_id: null, permissions: [], inventory_mode: "none", device_ids: [], group_ids: [] }) });
  }, { uname, upw });
  const tctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const tp = await tctx.newPage();
  tp.on("pageerror", (e) => consoleErrors.push(String(e)));
  const typeLogin = async (pw) => {
    await tp.goto(BASE);
    await tp.getByLabel("Username").fill(uname);
    await tp.getByLabel("Password").fill(pw);
    await tp.getByRole("button", { name: "Sign in" }).click();
  };
  await typeLogin(upw);
  await tp.getByRole("heading", { name: "Overview" }).waitFor();
  // Turn two-factor on from Settings, with the real UI and a QR code.
  await tp.goto(`${BASE}/settings?tab=account`);
  await tp.getByRole("heading", { name: "Settings" }).waitFor();
  await tp.getByRole("button", { name: "Set up", exact: true }).click();
  await tp.getByRole("dialog").getByLabel("Your password").fill(upw);
  await tp.getByRole("dialog").getByRole("button", { name: "Continue" }).click();
  await tp.getByRole("img", { name: /QR code/ }).waitFor();
  const secret = (await tp.getByRole("dialog").locator("span.select-all").innerText()).trim();
  await shot("26-2fa-setup", tp);
  await tp.getByRole("dialog").getByLabel("6-digit code").fill(code(secret, Math.floor(Date.now() / 30000)));
  await tp.getByRole("dialog").getByRole("button", { name: "Turn on" }).click();
  await tp.getByRole("list", { name: "Recovery codes" }).waitFor();
  const recovery = await tp.getByRole("list", { name: "Recovery codes" }).locator("li").allInnerTexts();
  await shot("27-2fa-recovery-codes", tp);
  check("two-factor is set up from Settings with a QR code and 10 recovery codes", recovery.length === 10 && /^[a-z2-9]{5}-[a-z2-9]{5}$/.test(recovery[0]));
  await tp.getByRole("button", { name: "I saved the codes" }).click();
  await tctx.clearCookies();
  await typeLogin(upw);
  await tp.getByLabel("Authentication code").waitFor();
  await shot("28-2fa-login", tp);
  check("the terminal login asks for the code after a correct password", (await tp.getByLabel("Password").isDisabled()) && (await tp.getByText("2fa code:").count()) === 1);
  await tp.getByLabel("Authentication code").fill("000000");
  await tp.keyboard.press("Enter");
  await tp.getByRole("alert").waitFor();
  check("a wrong code shows an error and stays on the code line", (await tp.getByRole("alert").innerText()).includes("not valid") && (await tp.getByLabel("Authentication code").count()) === 1);
  await tp.getByLabel("Authentication code").fill(code(secret, Math.floor(Date.now() / 30000) + 1));
  await tp.keyboard.press("Enter");
  await tp.getByRole("heading", { name: "Overview" }).waitFor();
  check("the right code signs in", true);
  await tctx.close();
  await page.evaluate(async (n) => {
    const csrf = (await (await fetch("/api/auth/me")).json()).csrf_token;
    for (const u of await (await fetch("/api/users")).json()) if (u.username === n) await fetch(`/api/users/${u.id}?keep_inventory=false`, { method: "DELETE", headers: { "X-CSRF-Token": csrf } });
  }, uname);
}

// --- Users page: teams, members and what a member sees ---
{
  const uname = `ui-member-${Date.now().toString(36)}`;
  await page.goto(`${BASE}/`);
  await page.getByRole("link", { name: "Users" }).click();
  await page.getByRole("heading", { name: "Users", exact: true }).waitFor();
  await page.getByRole("button", { name: "New team" }).first().click();
  const td = page.getByRole("dialog");
  await td.getByLabel("Team name").fill("UI Team");
  await td.getByRole("radio", { name: /Everything shared/ }).click();
  await td.getByRole("button", { name: "Create team" }).click();
  await page.getByRole("article").filter({ hasText: "UI Team" }).waitFor();
  await page.getByRole("button", { name: "New user" }).click();
  const ud = page.getByRole("dialog");
  await ud.getByLabel("Username").fill(uname);
  await ud.getByLabel("Password", { exact: true }).fill("Ui-member-pass-1");
  await choose(ud.getByLabel(/^Team/), "UI Team");
  await ud.getByRole("radio", { name: /Selected devices and groups/ }).click();
  await ud.getByText("Lab workstation").first().waitFor();
  await shot("22-user-dialog", page);
  await ud.getByRole("radio", { name: /Own inventory only/ }).click();
  await ud.getByRole("button", { name: "Create user" }).click();
  const row = page.getByRole("row").filter({ hasText: uname });
  await row.waitFor();
  await page.waitForTimeout(300);
  await shot("23-users", page);
  check("Users page creates a team and a user who joins it", (await row.getByText("UI Team").count()) === 1);

  const mctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const mp = await mctx.newPage();
  mp.on("pageerror", (e) => consoleErrors.push(String(e)));
  await mp.goto(BASE);
  await mp.getByLabel("Username").fill(uname);
  await mp.getByLabel("Password").fill("Ui-member-pass-1");
  await mp.getByRole("button", { name: "Sign in" }).click();
  // With devices shared with them, a member's Overview greets them instead of showing an "Overview" heading.
  await mp.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Overview" }).waitFor();
  await mp.waitForTimeout(600);
  await shot("24-member-overview", mp);
  const navText = await mp.getByRole("navigation", { name: "Main" }).innerText();
  check("a member's menu hides administration and features they do not have", !/Users/.test(navText) && /Vault/.test(navText) && /SFTP transfer/.test(navText) && /My activity/.test(navText), navText.replace(/\s+/g, " ").slice(0, 160));
  check("a member without the permissions has no Add device or Quick connect", (await mp.getByRole("button", { name: "Add device" }).count()) === 0 && (await mp.getByRole("button", { name: "Quick connect" }).count()) === 0);
  await mp.goto(`${BASE}/users`);
  await mp.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Overview" }).waitFor();
  await mp.waitForTimeout(500);
  check("a member who opens the Users address is sent back to Overview", new URL(mp.url()).pathname === "/");
  await mctx.close();

  await page.evaluate(async (name) => {
    const csrf = (await (await fetch("/api/auth/me")).json()).csrf_token;
    const h = { "X-CSRF-Token": csrf };
    for (const u of await (await fetch("/api/users")).json()) if (u.username === name) await fetch(`/api/users/${u.id}?keep_inventory=false`, { method: "DELETE", headers: h });
    for (const t of await (await fetch("/api/teams")).json()) if (t.name === "UI Team") await fetch(`/api/teams/${t.id}`, { method: "DELETE", headers: h });
  }, uname);
}

// --- Remaining screens ---
await page.goto(`${BASE}/devices`);
await page.getByRole("heading", { name: "All devices" }).waitFor();
await shot("08-devices-table");
await page.getByRole("radio", { name: "Card view" }).click();
await shot("09-devices-grid");
await page.getByRole("radio", { name: "Table view" }).click();
await page.goto(`${BASE}/`);
await page.getByText("Recently accessed").waitFor();
check("Overview no longer shows Favorites or Recently added", (await page.getByRole("heading", { name: "Favorites" }).count()) === 0 && (await page.getByRole("heading", { name: "Recently added" }).count()) === 0);
await page.getByRole("link", { name: "Statistics" }).click();
await page.getByRole("heading", { name: "Statistics" }).waitFor();
await shot("10b-statistics");
check("Statistics page shows Favorites, Recently added and breakdowns", (await page.getByRole("heading", { name: "Recently added" }).count()) === 1 && (await page.getByRole("heading", { name: "Favorites" }).count()) === 1 && (await page.getByRole("heading", { name: "Reachability" }).count()) === 1);
await page.goto(`${BASE}/`);
await page.getByText("Recently accessed").waitFor();
await shot("10-overview");
await page.goto(`${BASE}/connections`);
await page.getByRole("heading", { name: "Connection methods" }).waitFor();
await shot("11-connections");
await page.goto(`${BASE}/credentials`);
await page.getByRole("heading", { name: "Vault", exact: true }).waitFor();
check("the old Credentials address opens the Vault", new URL(page.url()).pathname === "/vault");
// --- Vault: an entry with a generated password, shown only with a reason ---
{
  await page.getByRole("button", { name: "New entry" }).click();
  const dlg = page.getByRole("dialog");
  await dlg.getByLabel("Name", { exact: true }).fill("UI vault entry");
  await dlg.getByLabel(/^Folder/).fill("UI/Test");
  await dlg.getByLabel(/^Username/).fill("svc");
  await dlg.getByRole("button", { name: "Generate" }).click();
  const generated = await dlg.getByLabel(/^Password/).inputValue();
  await shot("30-vault-form");
  await dlg.getByRole("button", { name: "Create entry" }).click();
  const row = page.locator("li", { hasText: "UI vault entry" });
  await row.waitFor();
  check("vault: an entry is created with a generated password", generated.length === 24 && /[A-Z]/.test(generated) && /[0-9]/.test(generated), `${generated.length}`);
  await shot("31-vault-list");
  await row.getByRole("button", { name: "Show" }).click();
  const rd = page.getByRole("dialog");
  check("vault: showing needs a reason first", await rd.getByRole("button", { name: "Show" }).isDisabled());
  await rd.getByLabel(/^Reason/).fill("UI check");
  await rd.getByRole("button", { name: "Show" }).click();
  await rd.getByText(generated).waitFor();
  check("vault: the secret is shown after a reason and hidden again on request", true);
  await shot("32-vault-reveal");
  await rd.getByRole("button", { name: "Hide now" }).click();
  await rd.waitFor({ state: "detached" });
  await row.getByRole("button", { name: "Show" }).waitFor();
  check("vault: the list never holds the secret", !(await page.content()).includes(generated));
  await page.getByRole("tab", { name: /Health/ }).click();
  await page.getByText("Vault health score").waitFor();
  await shot("33-vault-health");
}
await page.goto(`${BASE}/activity`);
await page.getByRole("heading", { name: "Activity log" }).waitFor();
await page.getByText("Remote session ended").first().waitFor();
await shot("12-activity");
await page.goto(`${BASE}/settings?tab=system`);
await page.getByRole("heading", { name: "Settings" }).waitFor();
await page.getByText("guacd reachable").waitFor();
await shot("13-settings");
await page.goto(`${BASE}/settings`);
await page.getByRole("button", { name: "Light", exact: true }).click();
await page.goto(`${BASE}/devices/${deviceId}`);
await page.getByRole("heading", { name: "Lab workstation" }).waitFor();
await shot("14-device-detail-light");
await page.goto(`${BASE}/`);
await shot("15-overview-light");
await page.getByRole("button", { name: "Dark", exact: true }).click().catch(() => {});
await page.evaluate(() => localStorage.setItem("emremote-theme", "dark"));

// English only: no em dashes, and no browser-locale (Turkish) dates even with a Turkish browser.
{
  const tr = await browser.newContext({ locale: "tr-TR", viewport: { width: 1440, height: 900 }, storageState: await ctx.storageState() });
  const tp = await tr.newPage();
  const bad = [];
  for (const path of ["/", "/statistics", "/devices", `/devices/${deviceId}`, "/connections", "/vault", "/activity", "/settings", "/transfer"]) {
    await tp.goto(`${BASE}${path}`);
    await tp.waitForLoadState("networkidle");
    await tp.waitForTimeout(400);
    const text = await tp.evaluate(() => document.body.innerText);
    if (text.includes("\u2014")) bad.push(`${path}: em dash`);
    const m = text.match(/[çğışÇĞİŞ]|önce|dakika|saat önce|Eki|Oca|Şub/);
    if (m) bad.push(`${path}: "${m[0]}"`);
  }
  check("UI is English only (no em dashes, no Turkish dates in a Turkish browser)", bad.length === 0, bad.join("; "));
  await tr.close();
}

// Mobile layout
const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, storageState: await ctx.storageState() });
const mp = await mobile.newPage();
await mp.goto(`${BASE}/devices`);
await mp.getByRole("heading", { name: "All devices" }).waitFor();
await shot("16-mobile-devices", mp);
await mobile.close();

const relevantErrors = consoleErrors.filter((e) => !/favicon|401/.test(e));
check("no JavaScript errors in the browser console", relevantErrors.length === 0, relevantErrors.slice(0, 3).join(" | "));

await browser.close();
console.log(failures ? `\n${failures} check(s) failed` : "\nall browser checks passed");
process.exit(failures ? 1 : 0);
