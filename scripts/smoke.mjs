// Startup check in a real browser: load extension/ unpacked into a throwaway headless Chrome, open every page
// (no AI platform, then one), let the background and the video-page scripts start, and fail on any uncaught
// error or console.error from the extension. Selftests run pages in vm with init() removed, so a page that dies
// on open passes them; this is the check that catches it. The B站 pages (BILI_PAGES) also have to keep working under
// each storage seed (SEEDS): our marks drawn, hydrated, B站's content there, comments loaded and 网页全屏 filling the
// window on the players, no new B站 exception, and B站 not drawing the page anew where the empty store hydrated it
// (REDRAWN). Then 分拣台, 摘读记录 and the side panel open with data (DATA_PAGES).
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
const YOUTUBE = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
// The B站 pages in BILI_PAGES open once per seed, those its `expect` or `none` names: what chrome.storage holds for some
// account, written before the pages open, and the elements of ours the seed must draw on each page (a seed that draws
// nothing tests nothing) or must not. An empty store never reaches the 「+ UP 标签」 line that broke hydration in #394.
// The empty seed is each page's baseline for B站's own errors; each seed adds to what the ones before wrote. Few
// pages, opened one at a time: B站 answers a burst with 412.
const BVID = "BV1GJ411x7h7";
const BILI = `https://www.bilibili.com/video/${BVID}`; // server-rendered: #app hydrates after our scripts start
const OWNER = "486906719"; // BVID's uploader
const BILI_PAGES = [
  // body: B站's own content that has to be there. player: comments and 网页全屏 have to work.
  { name: "video", url: BILI, player: true, body: "#commentapp" },
  // The uploader's videos as a playlist, server-rendered like BILI; its items are divs that take 观看进度 only.
  { name: "list", url: `https://www.bilibili.com/list/${OWNER}?bvid=${BVID}`, player: true, body: `.action-list-item-wrap[data-key="${BVID}"]` },
  // A bvid as the keyword finds that one video, a card with its uploader's link.
  { name: "search", url: `https://search.bilibili.com/all?keyword=${BVID}`, body: `.bili-video-card a[href*="${BVID}"]` }
];
// Other videos of OWNER in the list page's playlist, for 观看进度 on both sides of seenThreshold.
const [SEEN_OVER, SEEN_UNDER] = ["BV1GJ411x7hs", "BV1WJ411a7Cg"];
// The 分拣台's folder for 取消收藏 and its cached list: 稍后再看, whose read fails without a login and leaves the list.
// B站 answers an anonymous read of any other folder with no videos, which the 分拣台 takes as the folder emptied.
const FID = "toview";
const TAG = { id: "smoke", name: "冒烟", color: "#e66" };
const YT_ID = new URL(YOUTUBE).searchParams.get("v");
const nowS = Math.floor(Date.now() / 1000);
const SEEDS = [
  { name: "empty", local: () => ({}), sync: {} },
  {
    // The UP line under OWNER's name on its own: drawn into markup Vue 2 has yet to hydrate, it makes Vue throw and
    // stop, so with other marks on the page the REDRAWN they bring would go unseen. OWNER's links that must take no UP
    // tags (#420): the /list/ playlist's header, the search page's cards.
    name: "follow-tagged",
    sync: {},
    local: () => ({ follow_list: { list: [OWNER] }, follow_tags: [TAG], follow_tag_map: { [OWNER]: [TAG.id] } }),
    expect: Object.fromEntries(["video", "list"].map((p) => [p, [`.mdg-ups-line[data-mid="${OWNER}"] .mdg-up ~ .mdg-up-add`]])),
    none: { list: [".action-list-body-top .mdg-ups"], search: [".bili-video-card .mdg-ups"] }
  },
  {
    // Every other mark at once, so B站 is asked as few times as possible. recs and mids: the videos and uploaders the empty
    // seed's pages linked to (recommendations change from day to day). The videos are split three ways for 粗看
    // verdicts, 保留 and 取消收藏, which each take a video's one label.
    name: "marked",
    sync: { showBiliVerdicts: true, seenShow: "both", seenStyle: "veil", seenThreshold: 50, biliMarksOff: ["video.vtags"] },
    local: (recs, mids) => ({
      follow_list: { list: [] },
      follow_tags: [TAG],
      follow_tag_map: Object.fromEntries([...mids].map((m) => [m, [TAG.id]])),
      triage_tags: [{ ...TAG, folder: FID }],
      triage_video_tags: Object.fromEntries([BVID, ...recs].map((b) => [b, [TAG.id]])),
      [`triage_analysis_${BVID}`]: { bvid: BVID, status: "done", verdict: "keep", reason: "冒烟", oneLiner: "冒烟检查的种子", points: ["一"], analyzedAt: Date.now() },
      ...Object.fromEntries(recs.filter((b, i) => i % 3 === 0).map((b) => [`triage_title_${b}`, { verdict: "drop", reason: "冒烟", confidence: "low" }])),
      triage_kept: Object.fromEntries(recs.filter((b, i) => i % 3 === 1).map((b) => [b, { action: "keep", at: Date.now() }])),
      [`triage_decisions_${FID}`]: Object.fromEntries(recs.filter((b, i) => i % 3 === 2).map((b) => [b, { action: "unfav", at: Date.now() }])),
      ...Object.fromEntries([[BVID, 100], [SEEN_OVER, 60], [SEEN_UNDER, 40], ...recs.map((b) => [b, 100])].map(([b, p]) => [`seen_${b}`, [p, nowS]])),
      // The extension pages in DATA_PAGES read these.
      triage_folder_list: { mid: 1, folders: [{ id: FID, title: "稍后再看", count: 1, cover: "" }] },
      triage_included_folders: [FID],
      [`triage_snapshot_${FID}`]: {
        bvids: [BVID], invalid: [], titles: { [BVID]: "Never Gonna Give You Up" },
        items: [{ bvid: BVID, aid: 80433022, title: "Never Gonna Give You Up", cover: "", upper: "索尼音乐中国", duration: 213, pubdate: nowS, favTime: nowS, intro: "", invalid: false }]
      },
      mdg_ai_conversations_v1: [{
        id: "smoke", title: "冒烟", contextKey: `video:youtube:${YT_ID}|`, contextTitle: "冒烟", contextUrl: YOUTUBE, isVideoContext: true, createdAt: Date.now(), updatedAt: Date.now(),
        contextRef: { site: "youtube", videoId: YT_ID, cid: "", title: "冒烟", url: YOUTUBE, author: "", pageIndex: 1, pageCount: 1, isVideoContext: true },
        messages: [{ role: "user", content: "冒烟" }, { role: "assistant", content: "冒烟检查的回答" }]
      }]
    }),
    expect: {
      video: [
        `.mdg-line[data-bvid="${BVID}"] .mdg-v.mdg-keep`,
        ".mdg-line .mdg-chip", // the line under the title keeps 视频标签 that biliMarksOff takes off the cards
        ".mdg-badge .mdg-v.mdg-s1",
        ".mdg-badge .mdg-act-keep",
        ".mdg-badge .mdg-act-unfav",
        ".mdg-seen-veil",
        ".mdg-ups:not(.mdg-ups-line) .mdg-up" // the recommendations' uploaders
      ],
      list: [
        `.mdg-line[data-bvid="${BVID}"] .mdg-v.mdg-keep`, // drawn once Vue has hydrated
        `.action-list-item-wrap[data-key="${BVID}"] .mdg-seen-veil .mdg-seen-bar`,
        `.action-list-item-wrap[data-key="${SEEN_OVER}"] .mdg-seen-mark:not(.mdg-faint)`,
        `.action-list-item-wrap[data-key="${SEEN_UNDER}"] .mdg-seen-mark.mdg-faint`
      ],
      search: [
        `.mdg-badge[data-bvid="${BVID}"] .mdg-v.mdg-keep ~ .mdg-chip`,
        ".mdg-seen-veil"
      ]
    },
    // 视频标签 that biliMarksOff takes off the cards, and a badge on the /list/ title, which links to the video it is (#420).
    none: { video: [".mdg-badge:not(.mdg-line .mdg-badge) .mdg-chip"], list: [".video-info-title .mdg-badge"] }
  }
];
const pagesOf = (seed) => BILI_PAGES.filter((p) => !seed.expect || seed.expect[p.name] || seed.none?.[p.name]);
// Extension pages opened once more after the seeds, with their data in storage: each has to draw `count` from it.
// ?demo only swaps in dev/mock-chrome.js, which the extension never loads. They open behind the YouTube video: the
// side panel shows the active tab's video.
const DATA_PAGES = [
  { page: "triage/triage.html", count: `#list article[data-bvid="${BVID}"]` },
  { page: "history/history.html", count: "#list article.entry" },
  { page: "sidepanel.html", count: ".sp-msg-assistant" }
];
// Signs that B站 drew a page anew on hydrating, which our marks drawn into server-rendered markup cause (#421): Vue 2
// replaces #app with a fresh copy, Vue 3 logs a mismatch. The script runs in the page's world from document start.
const REDRAWN = `new MutationObserver((rs) => rs.forEach((r) => r.removedNodes.forEach((n) => {
  if (n.nodeName === "DIV" && n.id === "app") window.__mdgRedrawn = "#app drawn anew";
}))).observe(document, { childList: true, subtree: true })`;
const MISMATCH = "Hydration completed but contains mismatches.";
let pageErrors = null; // B站's own uncaught exceptions, and REDRAWN's signs, on pageSession's page while it is open
let pageSession = null;
let biliOpens = 0;

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
    else if (pageErrors && m.sessionId === pageSession) pageErrors.add((d.exception?.description || d.text).split("\n")[0]);
  } else if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
    const url = m.params.stackTrace?.callFrames?.[0]?.url;
    const text = m.params.args.map((a) => a.value ?? a.description ?? "").join(" ");
    if (pageErrors && m.sessionId === pageSession && text.includes(MISMATCH)) pageErrors.add(`Vue 3: ${MISMATCH}`);
    if (fromExt(url, at)) errors.push(`${step}: console.error at ${url || at}\n  ${text.slice(0, 400)}`);
  }
}

async function open(url, waitMs, background = false) {
  const { targetId } = (await send("Target.createTarget", { url, background })).result;
  await sleep(waitMs);
  return targetId;
}
// One session per target: every attach also reports the target's errors again (Target.attachedToTarget above).
const sessions = new Map();
async function session(targetId) {
  if (!sessions.has(targetId)) sessions.set(targetId, (await send("Target.attachToTarget", { targetId, flatten: true })).result.sessionId);
  return sessions.get(targetId);
}
async function evaluate(targetId, expression) {
  const r = (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, await session(targetId))).result;
  return r?.exceptionDetails ? `threw: ${r.exceptionDetails.exception?.description}` : r?.result?.value;
}
const close = (targetId) => send("Target.closeTarget", { targetId });
// Hydration, the player and the comments all come in late and at their own pace: wait for `expression` to be true.
async function until(targetId, expression, ms) {
  for (const end = Date.now() + ms; ; await sleep(500)) {
    if ((await evaluate(targetId, expression)) === true) return true;
    if (Date.now() > end) return false;
  }
}
// The comments load once scrolled to, and the page above them still grows while the player loads, so every poll
// scrolls again. B站 draws them in nested shadow roots.
async function playerWorks(t) {
  const comments = `(document.querySelector("#commentapp")?.scrollIntoView(), !!document.querySelector("bili-comments")?.shadowRoot?.querySelector("bili-comment-thread-renderer"))`;
  if (!(await until(t, comments, 20000))) {
    errors.push(`${step}: the comments never loaded (#commentapp: ${await evaluate(t, `document.querySelector("#commentapp")?.innerHTML.slice(0, 200)`)})`);
  }
  await evaluate(t, `scrollTo(0, 0)`);
  if (!(await until(t, `!!document.querySelector(".bpx-player-ctrl-web")`, 10000))) return errors.push(`${step}: the player has no 网页全屏 button`);
  await evaluate(t, `document.querySelector(".bpx-player-ctrl-web").click()`);
  const box = `document.querySelector(".bpx-player-container")?.getBoundingClientRect()`;
  if (!(await until(t, `(({ left, top, width, height } = ${box} || {}) => left <= 0 && top <= 0 && width >= innerWidth - 1 && height >= innerHeight - 1)()`, 5000))) {
    errors.push(`${step}: 网页全屏 left the player at ${await evaluate(t, `JSON.stringify(${box})`)} in ${await evaluate(t, `innerWidth + "x" + innerHeight`)}`);
  }
}

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
  // Network failures here are not ours. Errors from the extension's scripts count; B站's own count only when a seed
  // brings one the empty store did not on that page, and the page has to still work.
  const baseline = new Map();
  const recs = new Set();
  const mids = new Set();
  const unserved = new Set();
  for (const seed of SEEDS) {
    step = `seed ${seed.name}`;
    const s = await open(`chrome-extension://${id}/options.html`, 1000);
    await evaluate(s, `Promise.all([chrome.storage.local.set(${JSON.stringify(seed.local([...recs], [...mids]))}), chrome.storage.sync.set(${JSON.stringify(seed.sync)})])`);
    await close(s);
    for (const page of pagesOf(seed).filter((p) => !unserved.has(p.name))) {
      step = `${page.url} (${seed.name})`;
      // REDRAWN goes in before the page loads: blank first, then navigated.
      const t = await open("about:blank", 0);
      pageSession = await session(t);
      await send("Page.enable", {}, pageSession);
      await send("Page.addScriptToEvaluateOnNewDocument", { source: REDRAWN }, pageSession);
      pageErrors = new Set();
      await send("Page.navigate", { url: page.url }, pageSession);
      biliOpens++;
      // From GitHub's runners B站 may serve something without the page itself. Only the page's empty-store baseline
      // can tell that apart from a page we broke, so its seeds are skipped when the empty store gets no page either.
      if (!(await until(t, `!!document.querySelector(${JSON.stringify(page.body)})`, 15000))) {
        const got = await evaluate(t, `location.href + " " + JSON.stringify(document.title)`);
        await close(t);
        pageErrors = null;
        if (!baseline.has(page.name)) {
          console.log(`smoke: B站 served no ${page.name} page here (${got}); seed checks skipped`);
          unserved.add(page.name);
        } else errors.push(`${step}: no ${page.name} page (${got}), though the empty store got one`);
        continue;
      }
      // data-mdg-ssr: hydration.js's sign on the Vue 3 pages.
      if (!(await until(t, `!document.querySelector("[data-server-rendered], [data-mdg-ssr]")`, 15000))) errors.push(`${step}: the page never hydrated`);
      const want = seed.expect?.[page.name] || [];
      const missing = `${JSON.stringify(want)}.filter((s) => !document.querySelector(s))`;
      if (want.length && !(await until(t, `${missing}.length === 0`, 10000))) errors.push(`${step}: the seed drew no ${(await evaluate(t, missing)).join(", ")}`);
      const drawn = await evaluate(t, `${JSON.stringify(seed.none?.[page.name] || [])}.filter((s) => document.querySelector(s))`);
      if (drawn.length) errors.push(`${step}: the seed drew what it must not: ${drawn.join(", ")}`);
      if (page.player) await playerWorks(t);
      if (!baseline.has(page.name)) {
        const linked = await evaluate(t, `[...document.querySelectorAll('a[href*="/video/BV"]')].map((a) => /BV[0-9A-Za-z]{10}/.exec(a.href)[0])`);
        for (const b of linked) if (b !== BVID) recs.add(b);
        const ups = await evaluate(t, `[...document.querySelectorAll('a[href*="space.bilibili.com/"]')].map((a) => new URL(a.href).pathname.split("/")[1])`);
        for (const m of ups) if (/^\d+$/.test(m) && m !== OWNER) mids.add(m);
      }
      const redrawn = await evaluate(t, "window.__mdgRedrawn");
      if (redrawn) pageErrors.add(`Vue 2: ${redrawn}`);
      await close(t);
      if (!baseline.has(page.name)) baseline.set(page.name, pageErrors);
      else for (const e of pageErrors) if (!baseline.get(page.name).has(e)) errors.push(`${step}: B站 did what it did not with the empty store: ${e}`);
      pageErrors = null;
      pageSession = null;
    }
  }
  step = YOUTUBE;
  const yt = await open(YOUTUBE, 10000);
  for (const { page, count } of DATA_PAGES) {
    step = `${page} (seeded)`;
    const t = await open(`chrome-extension://${id}/${page}`, 0, true);
    if (!(await until(t, `!!document.querySelector(${JSON.stringify(count)})`, 10000))) errors.push(`${step}: the seeded data drew no ${count}`);
    await close(t);
  }
  await close(yt);
} catch (err) {
  errors.push(`${step}: ${err.stack || err}`);
} finally {
  chrome.kill();
  await sleep(500);
  fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5 });
}

console.log(`smoke: ${pages.length} pages × 2 (${lookupCount} id lookups), background, B站 pages × seeds (${SEEDS.map((s) => `${s.name}: ${pagesOf(s).map((p) => p.name).join(" ")}`).join(", ")}; ${biliOpens} opened), YouTube, ${DATA_PAGES.length} pages seeded`);
if (errors.length) {
  console.error(`smoke: ${errors.length} error(s)\n${errors.join("\n")}`);
  process.exit(1);
}
console.log("smoke: ok");
