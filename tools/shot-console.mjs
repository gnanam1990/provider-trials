// Rendered-evidence capture: drives headless Chrome over CDP (no npm deps,
// Node >=22 native WebSocket) and screenshots console pages at
// desktop/tablet/phone widths into build-progress/provider-trials/shots/.
// Usage: node tools/shot-console.mjs <baseUrl> <accountId> <reportId> <trialId>
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const [base, accountId, reportId, trialId, providerId] = process.argv.slice(2);
if (!base || !accountId || !reportId || !trialId) {
  console.error("usage: node tools/shot-console.mjs <baseUrl> <accountId> <reportId> <trialId>");
  process.exit(2);
}
const CHROME = path.join(os.homedir(),
  "Library/Caches/ms-playwright/chromium_headless_shell-1254/chrome-headless-shell-mac-arm64/chrome-headless-shell");
const OUT = path.resolve("build-progress/provider-trials/shots");
fs.mkdirSync(OUT, { recursive: true });
const TMP = fs.mkdtempSync(path.join(process.cwd(), ".tmp-chrome-"));
const DEBUG_PORT = 9333;

const session = (() => {
  const payload = Buffer.from(
    JSON.stringify({ accountId, subject: "analyst", role: "analyst" }),
  ).toString("base64url");
  const sig = crypto.createHmac("sha256", "dev-only-hmac-secret").update(payload).digest("base64url");
  return `${payload}.${sig}`;
})();

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
const once = (method) => new Promise((r) => { events.set(method, r); setTimeout(r, 4000); });

await send("Page.enable");
await send("Network.enable");

async function shot(name, url, width, height, cookie) {
  if (cookie) await send("Network.setCookie", {
    name: "pt_session", value: session, domain: "127.0.0.1", path: "/",
  });
  await send("Emulation.setDeviceMetricsOverride",
    { width, height, deviceScaleFactor: 1, mobile: width < 500 });
  const loaded = once("Page.loadEventFired");
  await send("Page.navigate", { url });
  await loaded;
  await new Promise((r) => setTimeout(r, 200));
  const { data } = await send("Page.captureScreenshot", { format: "png" });
  const file = path.join(OUT, `${name}.png`);
  fs.writeFileSync(file, Buffer.from(data, "base64"));
  console.log(`wrote ${file}`);
}

await shot("login-phone", `${base}/console/login`, 390, 844, false);
await shot("report-desktop", `${base}/console/reports/${reportId}`, 1440, 1100, true);
await shot("report-tablet", `${base}/console/reports/${reportId}`, 834, 1112, true);
await shot("report-phone", `${base}/console/reports/${reportId}`, 390, 844, true);
await shot("trial-phone", `${base}/console/trials/${trialId}`, 390, 844, true);
await shot("fields-phone", `${base}/console/reports/${reportId}/fields?provider_id=${encodeURIComponent(providerId ?? "")}`, 390, 844, true);
ws.close();
cleanup();
