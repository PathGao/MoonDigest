// Startup check in a real browser: load extension/ unpacked into a throwaway headless Chrome, open every page
// (no AI platform, then one), let the background and the video-page scripts start, and fail on any uncaught
// error or console.error from the extension. Selftests run pages in vm with init() removed, so a page that dies
// on open passes them; this is the check that catches it.
//   node scripts/smoke.mjs            CHROME=/path/to/chrome to override the browser
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const ext = path.join(root, "extension");
const chromeBin = process.env.CHROME
  || (process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "google-chrome");
// Every page the extension ships; dev previews stay out of the release and out of this check.
const pages = fs.readdirSync(ext, { recursive: true })
  .filter((f) => f.endsWith(".html") && !/(^|\/)dev[-/]/.test(f))
  .sort();
const SITES = ["https://www.bilibili.com/video/BV1GJ411x7h7", "https://www.youtube.com/watch?v=dQw4w9WgXcQ"];

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdg-smoke-"));
const args = ["--headless=new", "--remote-debugging-pipe", "--enable-unsafe-extension-debugging",
  `--user-data-dir=${userDataDir}`, "--no-first-run", "--no-default-browser-check", "about:blank"];
if (process.platform === "linux") args.unshift("--no-sandbox");
const chrome = spawn(chromeBin, args, { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
const [, , , toChrome, fromChrome] = chrome.stdio;

let nextId = 0;
let buf = "";
let step = "start";
const pending = new Map();
const where = new Map();
const errors = [];
const send = (method, params = {}, sessionId) => new Promise((resolve) => {
  const id = ++nextId;
  pending.set(id, resolve);
  toChrome.write(JSON.stringify({ id, method, params, sessionId }) + "\0");
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fromExt = (...s) => s.some((x) => String(x || "").startsWith("chrome-extension://"));

fromChrome.on("data", (chunk) => {
  buf += chunk;
  for (let i; (i = buf.indexOf("\0")) >= 0; buf = buf.slice(i + 1)) onMessage(JSON.parse(buf.slice(0, i)));
});

function onMessage(m) {
  if (m.id) {
    pending.get(m.id)?.(m);
    pending.delete(m.id);
    return;
  }
  const at = where.get(m.sessionId);
  if (m.method === "Target.attachedToTarget") {
    // Attach to everything paused, the service worker and content-script frames included, so startup errors
    // happen while we listen.
    const { sessionId, targetInfo } = m.params;
    where.set(sessionId, targetInfo.url);
    send("Runtime.enable", {}, sessionId);
    send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId);
    send("Runtime.runIfWaitingForDebugger", {}, sessionId);
  } else if (m.method === "Runtime.exceptionThrown") {
    const d = m.params.exceptionDetails;
    const url = d.url || d.stackTrace?.callFrames?.[0]?.url;
    if (fromExt(url, at)) errors.push(`${step}: uncaught at ${url || at}\n  ${(d.exception?.description || d.text).split("\n").slice(0, 4).join("\n  ")}`);
  } else if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
    const url = m.params.stackTrace?.callFrames?.[0]?.url;
    const text = m.params.args.map((a) => a.value ?? a.description ?? "").join(" ");
    if (fromExt(url, at)) errors.push(`${step}: console.error at ${url || at}\n  ${text.slice(0, 400)}`);
  }
}

async function open(url, waitMs) {
  const { targetId } = (await send("Target.createTarget", { url })).result;
  await sleep(waitMs);
  return targetId;
}
async function evaluate(targetId, expression) {
  const { sessionId } = (await send("Target.attachToTarget", { targetId, flatten: true })).result;
  const r = (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId)).result;
  return r?.exceptionDetails ? `threw: ${r.exceptionDetails.exception?.description}` : r?.result?.value;
}
const close = (targetId) => send("Target.closeTarget", { targetId });

try {
  await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  await send("Target.setDiscoverTargets", { discover: true });
  const loaded = await send("Extensions.loadUnpacked", { path: ext });
  const id = loaded.result?.id;
  if (!id) throw new Error(`loadUnpacked failed: ${JSON.stringify(loaded.error || loaded)}`);
  await sleep(2000);

  for (const config of ["no AI platform", "one AI platform"]) {
    if (config === "one AI platform") {
      step = "add platform";
      const t = await open(`chrome-extension://${id}/options.html`, 2000);
      const saved = await evaluate(t, `chrome.runtime.sendMessage({ type: "ai-providers-save", providers: [{
        id: "smoke", presetId: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat",
        temperature: 0.7, requiresKey: true, enabled: true, apiKey: "sk-smoke", hasSavedKey: false }] })`);
      if (!saved?.ok) errors.push(`add platform: ai-providers-save answered ${JSON.stringify(saved)}`);
      await close(t);
    }
    for (const page of pages) {
      step = `${page} (${config})`;
      await close(await open(`chrome-extension://${id}/${page}`, 3000));
    }
  }
  // Network failures here are not ours; only errors from the extension's scripts count.
  for (const site of SITES) {
    step = site;
    await close(await open(site, 10000));
  }
} catch (err) {
  errors.push(`${step}: ${err.stack || err}`);
} finally {
  chrome.kill();
  await sleep(500);
  fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5 });
}

console.log(`smoke: ${pages.length} pages × 2, background, ${SITES.length} video pages`);
if (errors.length) {
  console.error(`smoke: ${errors.length} error(s)\n${errors.join("\n")}`);
  process.exit(1);
}
console.log("smoke: ok");
