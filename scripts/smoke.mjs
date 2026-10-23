// Startup check in a real browser: load extension/ unpacked into a throwaway headless Chrome, open every page
// (no AI platform, then one), let the background and the video-page scripts start, and fail on any uncaught
// error or console.error from the extension. Selftests run pages in vm with init() removed, so a page that dies
// on open passes them; this is the check that catches it.
//   node scripts/smoke.mjs            CHROME=/path/to/chrome to override the browser
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ext = path.join(root, "extension");
const chromeBin = process.env.CHROME || {
  darwin: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  // System-wide install first, then the per-user one.
  win32: ["C:\\Program Files", process.env.LOCALAPPDATA].map((d) => d && path.join(d, "Google\\Chrome\\Application\\chrome.exe")).find((f) => f && fs.existsSync(f))
}[process.platform] || "google-chrome";
// Every page the extension ships; dev previews stay out of the release and out of this check. Paths use / on every
// OS: they become the pages' URLs.
const pages = fs.readdirSync(ext, { recursive: true })
  .map((f) => f.split(path.sep).join("/"))
  .filter((f) => f.endsWith(".html") && !/(^|\/)dev[-/]/.test(f))
  .sort();
// Ids the pages' scripts look up: getElementById("x"), the pages' $("x") shorthand, querySelector("#x ...").
// The page selftests stub getElementById to return an element for any id, so a renamed or deleted id passes them.
// An id counts as there if an open page has it, or the html or a script writes it out (a placeholder swapped at
// startup, a template rendered on demand, a dialog of a shared script that only one page opens).
const written = new Set();
const lookupsOf = new Map();
for (const page of pages) {
  const html = fs.readFileSync(path.join(ext, page), "utf8");
  for (const m of html.matchAll(/\bid="([^"]+)"/g)) written.add(m[1]);
  const found = new Map();
  for (const [, src] of html.matchAll(/<script[^>]*src="([^"]+)"/g)) {
    const file = path.posix.join(path.posix.dirname(page), src);
    const code = fs.readFileSync(path.join(ext, file), "utf8");
    for (const m of code.matchAll(/\bid\s*=\s*["'`]([\w-]+)["'`]/g)) written.add(m[1]);
    for (const m of code.matchAll(/(?:getElementById|(?<![\w.])\$)\(\s*["'`]([\w-]+)["'`]\s*\)|querySelector(?:All)?\(\s*["'`]#([\w-]+)/g)) {
      const id = m[1] || m[2];
      if (!found.has(id)) found.set(id, `${file}:${code.slice(0, m.index).split("\n").length}`);
    }
    // The settings page reads its controls as elements.x (every element with an id, by its id); assigned ones are not.
    if (file === "options.js") {
      const assigned = new Set([...code.matchAll(/\belements\.(\w+)\s*=[^=]/g)].map((m) => m[1]));
      for (const m of code.matchAll(/\belements\.(\w+)/g)) {
        if (!assigned.has(m[1]) && !found.has(m[1])) found.set(m[1], `${file}:${code.slice(0, m.index).split("\n").length}`);
      }
    }
  }
  lookupsOf.set(page, found);
}
const lookupCount = [...lookupsOf.values()].reduce((n, found) => n + found.size, 0);
if (lookupCount < 100) throw new Error(`only ${lookupCount} id lookups found; the patterns no longer match the code`);
const seen = new Set();
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
      const t = await open(`chrome-extension://${id}/${page}`, 3000);
      const ids = [...lookupsOf.get(page).keys()];
      const absent = await evaluate(t, `${JSON.stringify(ids)}.filter((id) => !document.getElementById(id))`);
      ids.filter((i) => !absent.includes(i)).forEach((i) => seen.add(i));
      await close(t);
    }
  }
  const lost = new Set();
  for (const found of lookupsOf.values()) for (const [i, at] of found) if (!seen.has(i) && !written.has(i)) lost.add(`${at} looks up #${i}, which no page has`);
  errors.push(...lost);
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

console.log(`smoke: ${pages.length} pages × 2 (${lookupCount} id lookups), background, ${SITES.length} video pages`);
if (errors.length) {
  console.error(`smoke: ${errors.length} error(s)\n${errors.join("\n")}`);
  process.exit(1);
}
console.log("smoke: ok");
