// Rendered-evidence capture: drives headless Chrome over CDP (no npm deps,
// Node >=22 native WebSocket). Signs in through the REAL login form with
// keyboard input, navigates by clicking real links, and screenshots console
// pages at desktop/tablet/phone/320px widths into
// build-progress/provider-trials/shots/.
// Usage: node tools/shot-console.mjs <baseUrl> <accountId> <subject> <credential> <reportId> <trialId> <providerId>
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const [base, accountId, subject, credential, reportId, trialId, providerId] = process.argv.slice(2);
if (!base || !accountId || !subject || !credential || !reportId || !trialId) {
  console.error("usage: node tools/shot-console.mjs <baseUrl> <accountId> <subject> <credential> <reportId> <trialId> [providerId]");
  process.exit(2);
}
const CHROME = path.join(os.homedir(),
  "Library/Caches/ms-playwright/chromium_headless_shell-1254/chrome-headless-shell-mac-arm64/chrome-headless-shell");
const OUT = path.resolve("build-progress/provider-trials/shots");
fs.mkdirSync(OUT, { recursive: true });
const TMP = fs.mkdtempSync(path.join(process.cwd(), ".tmp-chrome-"));
const DEBUG_PORT = 9333;

const chrome = spawn(CHROME, [
  "--no-sandbox", "--single-process", "--disable-gpu",
  `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${TMP}`,
  "--no-first-run", "--disable-extensions", "about:blank",
], { stdio: "ignore" });
const cleanup = () => { try { chrome.kill("SIGKILL"); } catch {} fs.rmSync(TMP, { recursive: true, force: true }); };
process.on("exit", cleanup);

async function waitEndpoint() {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new Error("chrome devtools endpoint never came up");
}
await waitEndpoint();
const targets = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
const page = targets.find((t) => t.type === "page");

let seq = 0;
const pending = new Map();
const events = new Map();
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  else if (msg.method && events.has(msg.method)) events.get(msg.method)(msg);
};
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq;
  pending.set(id, (m) => (m.error ? reject(new Error(m.error.message)) : resolve(m.result)));
  ws.send(JSON.stringify({ id, method, params }));
});
const once = (method) => new Promise((r) => { events.set(method, r); setTimeout(r, 5000); });

await send("Page.enable");
await send("Runtime.enable");

const metrics = (width, height) =>
  send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 500 });
const evalJs = async (expr) => {
  const res = await send("Runtime.evaluate", { expression: expr, returnByValue: true });
  return res.result?.value;
};
const key = async (k, code, vk, text) => {
  await send("Input.dispatchKeyEvent", {
    type: "keyDown", key: k, code, windowsVirtualKeyCode: vk,
    ...(text !== undefined ? { text } : {}),
  });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk });
};
const type = (text) => send("Input.insertText", { text });
const clickSel = async (sel) => {
  const pt = await evalJs(`(() => { const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return null; const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  if (!pt) throw new Error(`no element for selector ${sel}`);
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: pt.x, y: pt.y, button: "left", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: pt.x, y: pt.y, button: "left", clickCount: 1 });
};

async function navigate(url) {
  const loaded = once("Page.loadEventFired");
  await send("Page.navigate", { url });
  await loaded;
  await new Promise((r) => setTimeout(r, 150));
}
async function capture(name) {
  const { data } = await send("Page.captureScreenshot", { format: "png" });
  const file = path.join(OUT, `${name}.png`);
  fs.writeFileSync(file, Buffer.from(data, "base64"));
  console.log(`wrote ${file}`);
}

// --- Real login: type through the form with the keyboard, submit with Enter.
await metrics(390, 844);
await navigate(`${base}/console`);
if (!(await evalJs("location.pathname")).endsWith("/console/login")) {
  throw new Error("expected unauthenticated redirect to /console/login");
}
await capture("login-phone");
await metrics(320, 568);
await capture("login-320");

// Click each field (real focus), type into it, and Tab between fields.
await clickSel('input[name="account_id"]');
await type(accountId);
await key("Tab", "Tab", 9);
await type(subject);
await key("Tab", "Tab", 9);
await type(credential);
const loggedIn = once("Page.loadEventFired");
await key("Enter", "Enter", 13, "\r"); // implicit form submission via keyboard
await loggedIn;
await new Promise((r) => setTimeout(r, 200));
if ((await evalJs("location.pathname")) !== "/console") {
  const dbg = await evalJs(`JSON.stringify({
    href: location.href,
    acct: document.querySelector('input[name="account_id"]')?.value,
    subj: document.querySelector('input[name="subject"]')?.value,
    cred: document.querySelector('input[name="credential"]')?.value?.length,
    warn: document.querySelector('.warn')?.textContent,
    active: document.activeElement?.name || document.activeElement?.tagName,
  })`);
  throw new Error(`login did not land on the work queue: ${dbg}`);
}
console.log("login OK via keyboard-submitted credential form");

// --- Keyboard focus traversal proof on the landed page.
await key("Tab", "Tab", 9);
const focused = await evalJs("(document.activeElement && document.activeElement.tagName + ':' + (document.activeElement.textContent || '').trim())");
console.log(`focus after Tab: ${focused}`);
await capture("workqueue-phone");

// --- Real navigation: click nav "Reports", then the report row link.
const nav = once("Page.loadEventFired");
await clickSel('nav a[href="/console/reports"]');
await nav;
const rep = once("Page.loadEventFired");
await clickSel(`a[href="/console/reports/${reportId}"]`);
await rep;
await new Promise((r) => setTimeout(r, 150));
if (!(await evalJs("location.pathname")).includes(`/console/reports/${reportId}`)) {
  throw new Error("click navigation did not reach the report page");
}
console.log("reached report via real link clicks");

await metrics(1440, 1100);
await new Promise((r) => setTimeout(r, 150));
await capture("report-desktop");
await metrics(834, 1112);
await capture("report-tablet");
await metrics(390, 844);
await capture("report-phone");
await metrics(320, 568);
await capture("report-320");

await metrics(390, 844);
await navigate(`${base}/console/trials/${trialId}`);
await capture("trial-phone");
if (providerId) {
  await navigate(`${base}/console/reports/${reportId}/fields?provider_id=${encodeURIComponent(providerId)}`);
  await capture("fields-phone");
}
ws.close();
cleanup();
