// node extension/background.selftest.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

let onConnect;
const anything = new Proxy(function () {}, { get: () => anything, apply: () => anything });
const runtime = new Proxy({}, { get: (_, k) => (k === "onConnect" ? { addListener: (fn) => (onConnect = fn) } : anything) });
const chrome = new Proxy({}, { get: (_, k) => (k === "runtime" ? runtime : anything) });

const ctx = vm.createContext({
  chrome, console, setTimeout, clearTimeout, AbortController, AbortSignal, TextDecoder, TextEncoder, URL, URLSearchParams,
  // Loads files when background.js calls it, so the selftest sees the browser's load order.
  importScripts: (...files) => files.forEach((file) => vm.runInContext(fs.readFileSync(path.join(__dirname, file), "utf8"), ctx))
});
vm.runInContext(fs.readFileSync(path.join(__dirname, "background.js"), "utf8"), ctx);
ctx.loadAiProviders = async () => [{ id: "p", baseUrl: "https://ai.test", model: "m", requiresKey: false }];
ctx.loadAiProviderKeys = async () => ({});
vm.runInContext("STREAM_TIMEOUT_MS.first = 60; STREAM_TIMEOUT_MS.idle = 60;", ctx);

const sse = (delta) => new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`);
const abortError = () => Object.assign(new Error("aborted"), { name: "AbortError" });
// Feeds chunks with the given delays; past the script the body stalls until the request is aborted, like a real fetch.
const streamingFetch = (script) => async (url, { signal }) => {
  const queue = [...script];
  return {
    ok: true,
    body: {
      getReader: () => ({
        read: () =>
          new Promise((resolve, reject) => {
            if (signal.aborted) return reject(abortError());
            signal.addEventListener("abort", () => reject(abortError()));
            const next = queue.shift();
            if (!next) return;
            setTimeout(() => resolve(next.done ? { done: true } : { value: next.chunk, done: false }), next.after);
          })
      })
    }
  };
};

function chat() {
  const out = [];
  return new Promise((resolve) => {
    const port = {
      name: "sidepanel-chat",
      onDisconnect: { addListener() {} },
      onMessage: { addListener: (fn) => fn({ action: "chat", providerId: "p", prompt: "q" }) },
      postMessage: (m) => {
        out.push(m);
        if (["done", "error", "stopped"].includes(m.type)) resolve(out);
      }
    };
    onConnect(port);
  });
}

// AbortSignal.timeout does not keep Node alive, so without this the run ends mid-test with exit code 0.
const keepAlive = setInterval(() => {}, 1000);
let finished = false;
process.on("exit", (code) => {
  if (!finished && code === 0) {
    console.error("background selftest: ended before the last check");
    process.exitCode = 1;
  }
});

(async () => {
  // Reasoning chunks count as activity, so a long think outlasts the first-response limit.
  ctx.fetch = streamingFetch([
    ...Array.from({ length: 6 }, () => ({ after: 30, chunk: sse({ reasoning_content: "…" }) })),
    { after: 30, chunk: sse({ content: "答" }) },
    { after: 0, done: true }
  ]);
  let out = await chat();
  assert.deepStrictEqual(out.map((m) => m.type), ["token", "done"]);

  // A stream that goes quiet after the first token ends with the idle error.
  ctx.fetch = streamingFetch([{ after: 5, chunk: sse({ content: "半句" }) }]);
  out = await chat();
  assert.strictEqual(out.at(-1).type, "error");
  assert.match(out.at(-1).error, /^回复中断：.* 秒没有新内容，可重试$/);

  // No response at all ends with the first-response error, not a generic network error.
  ctx.fetch = (url, { signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(abortError())));
  out = await chat();
  assert.deepStrictEqual(out.map((m) => m.type), ["error"]);
  assert.match(out[0].error, /^请求超时：.* 秒没有返回/);

  // Settings migration: the empty-panel chips fold into the one follow-up list, once.
  const area = (data) => ({
    data,
    async get(keys) {
      if (keys && typeof keys === "object" && !Array.isArray(keys)) {
        return Object.fromEntries(Object.entries(keys).map(([k, d]) => [k, k in data ? data[k] : d]));
      }
      return Object.fromEntries([].concat(keys).filter((k) => k in data).map((k) => [k, data[k]]));
    },
    async set(obj) { Object.assign(data, JSON.parse(JSON.stringify(obj))); },
    async remove(k) { [].concat(k).forEach((key) => delete data[key]); }
  });
  const install = (sync) => {
    ctx.chrome = { storage: { sync: area(sync), local: area({}) } };
    return () => ctx.initializeSettingsStorage();
  };
  const oldUser = {
    obsidianEnabled: false,
    aiInitialQuickPrompts: ["说重点", "", "列出数据", "说重点"],
    aiPresetPrompts: ["列出数据", "我的追问"],
    playerAiQuickPrompt: "我的总结格式"
  };
  let init = install(oldUser);
  await init();
  assert.deepStrictEqual(oldUser.aiPresetPrompts, ["说重点", "列出数据", "我的追问"]);
  assert.ok(!("aiInitialQuickPrompts" in oldUser));
  assert.strictEqual(oldUser.playerAiQuickPrompt, "我的总结格式");
  const once = JSON.stringify(oldUser);
  await init();
  assert.strictEqual(JSON.stringify(oldUser), once);

  const fresh = {};
  init = install(fresh);
  await init();
  assert.deepStrictEqual(fresh.aiPresetPrompts, JSON.parse(vm.runInContext("JSON.stringify(DEFAULT_PRESET_PROMPTS)", ctx)));
  assert.strictEqual(fresh.playerAiQuickPrompt, vm.runInContext("DEFAULT_PLAYER_AI_QUICK_PROMPT", ctx));
  assert.ok(!("aiInitialQuickPrompts" in fresh));

  // Saving a partial payload (the options page has no reading-view controls) keeps every key it omits.
  const stored = { readerTheme: "dark", readerFontScale: "l", aiPresetPrompts: ["a"] };
  ctx.chrome = { storage: { sync: area(stored), local: area({ obsidianApiKey: "k" }) } };
  await ctx.saveSettings({ aiPresetPrompts: [], noteFolder: "N" });
  assert.strictEqual(stored.readerTheme, "dark");
  assert.strictEqual(stored.readerFontScale, "l");
  assert.deepStrictEqual(stored.aiPresetPrompts, []);
  assert.strictEqual(stored.noteFolder, "N");
  assert.strictEqual((await ctx.chrome.storage.local.get("obsidianApiKey")).obsidianApiKey, "k");

  // 看多少算看完了: 0 clamps to 1, only a missing or non-numeric value means 80.
  for (const [input, want] of [[0, 1], ["150", 100], [42.4, 42], [undefined, 80], ["", 80], ["x", 80]]) {
    assert.strictEqual(ctx.normalizeSyncSettings({ seenThreshold: input }).seenThreshold, want);
  }

  const systemFor = (extra) =>
    ctx.buildAiMessages({ context: { isVideoContext: true, title: "T", description: "简介", ...extra }, userPrompt: "q" }).messages[0].content;
  const none = systemFor({});
  assert.match(none, /这个视频没有字幕/);
  assert.doesNotMatch(none, /抓取失败/);
  const failed = systemFor({ subtitleFailure: "字幕接口限流（429），稍后再试" });
  assert.match(failed, /字幕抓取失败（字幕接口限流（429），稍后再试）/);
  assert.match(failed, /以下仅基于简介和评论/);
  assert.doesNotMatch(failed, /这个视频没有字幕/);
  assert.match(failed, /以下是视频简介：\n\n简介/);
  assert.doesNotMatch(systemFor({ subtitleMarkdown: "字幕", subtitleFailure: "旧失败" }), /抓取失败/);

  // A long subtitle is sampled across the whole video and capped; the model and the user are both told.
  const subtitleLines = Array.from({ length: 4000 }, (_, i) => `\`${i}\` ${"字".repeat(40)}`);
  const big = ctx.buildAiMessages({
    context: { isVideoContext: true, subtitleMarkdown: ["## 字幕", "", ...subtitleLines].join("\n") },
    userPrompt: "q"
  });
  const bigSystem = big.messages[0].content;
  assert.ok(bigSystem.length < 62000);
  assert.match(bigSystem, /## 字幕/);
  assert.match(bigSystem, /`0` /);
  assert.match(bigSystem, /`3999` |`399[0-9]` /);
  assert.match(bigSystem, /均匀抽取了约 1\/\d+ 的行/);
  assert.match(big.notices[0], /字幕过长/);

  // Old turns beyond the budget are dropped whole, oldest first, and the newest turn survives.
  const turn = (i) => [{ role: "user", content: `问${i}` }, { role: "assistant", content: `${i}`.padEnd(15000, "答") }];
  const longHistory = [1, 2, 3, 4].flatMap(turn);
  const trimmedRequest = ctx.buildAiMessages({ context: {}, userPrompt: "q", history: longHistory });
  assert.deepStrictEqual([...trimmedRequest.messages.slice(1, -1)].map((m) => m.content.slice(0, 2)), ["问3", "3答", "问4", "4答"]);
  assert.match(trimmedRequest.messages[0].content, /最早的 4 条消息没有提供给你/);
  assert.match(trimmedRequest.notices[0], /最早的 4 条消息没有发送/);
  assert.strictEqual(ctx.buildAiMessages({ context: {}, userPrompt: "q", history: turn(1) }).notices.length, 0);

  // An error object inside a 200 stream ends the reply with that error instead of a silent "done".
  ctx.fetch = streamingFetch([
    { after: 5, chunk: sse({ content: "半" }) },
    { after: 5, chunk: new TextEncoder().encode(`data: ${JSON.stringify({ error: { message: "quota exceeded" } })}\n\n`) },
    { after: 0, done: true }
  ]);
  out = await chat();
  assert.deepStrictEqual(out.map((m) => m.type), ["token", "error"]);
  assert.strictEqual(out[1].error, "接口返回错误：quota exceeded");

  // A request that never answers fails with a retryable timeout instead of hanging the caller.
  ctx.fetch = (url, { signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
  await assert.rejects(ctx.fetchWithTimeout("https://api.bilibili.com/x", {}, 30), (e) => e.status === 408 && /timeout/.test(e.message));

  // The side panel saves the context URL with a conversation, so reader mode and tracking params never reach it.
  const contextFor = async (tabUrl, payload) => {
    ctx.chrome = { tabs: { get: async () => ({ id: 1, url: tabUrl }) } };
    ctx.ensureReaderContentReady = async () => {};
    ctx.sendMessageToTab = async (_, { type }) =>
      type === "sidepanel-get-context" ? { ok: true, payload: { url: tabUrl, title: "T", ...payload } } : { ok: true, comments: [] };
    return ctx.getAiSidepanelState(1);
  };
  const bili = await contextFor("https://www.bilibili.com/video/BV1xx411c7mD/?p=2&boc_reader=1&spm_id_from=333.1", {
    site: "bilibili", videoId: "BV1xx411c7mD", pageIndex: 2, pageCount: 3
  });
  assert.strictEqual(bili.url, "https://www.bilibili.com/video/BV1xx411c7mD/?p=2");
  const yt = await contextFor("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s&boc_reader=1", { site: "youtube", videoId: "dQw4w9WgXcQ" });
  assert.strictEqual(yt.url, "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  // Before the page has read its video id, the URL itself is cleaned.
  const early = await contextFor("https://www.bilibili.com/video/BV1xx411c7mD/?boc_reader=1", { videoId: "" });
  assert.strictEqual(early.url, "https://www.bilibili.com/video/BV1xx411c7mD/");

  // A history conversation's context rejects another video's subtitle and keeps it out of the shared cache.
  const local = {};
  ctx.chrome = { storage: { sync: area({}), local: area(local) } };
  const subUrl = "https://aisubtitle.hdslb.com/a.json";
  const sidepanelRoutes = (to) => ({
    "/view/detail": { code: 0, data: { View: { title: "T", aid: 22, cid: 11, duration: 273, pages: [{ cid: 11, page: 1, duration: 273 }] } } },
    "/x/player/wbi/v2": { code: 0, data: { subtitle: { subtitles: [{ id: 5, lan: "ai-zh", lan_doc: "中文", subtitle_url: subUrl }] } } },
    [subUrl]: { body: [{ from: 0, to: 1, content: "a" }, { from: 1, to, content: "b" }] },
    "/reply/main": { code: 0, data: { replies: [] } }
  });
  const historyContext = () => ctx.resolveAiSidepanelContext({ site: "bilibili", videoId: "BVa", cid: "11" });
  // A subtitle running far past the 273 s video belongs to another video.
  let routes = sidepanelRoutes(400);
  ctx.fetchJsonForAi = async (url) => routes[Object.keys(routes).find((part) => url.includes(part))];
  await assert.rejects(historyContext(), /时长不匹配/);
  assert.deepStrictEqual(Object.keys(local).filter((k) => k.startsWith("boc_subtitle_cache_")), []);
  // Speech ending at 100 s (a long silent outro) passes the video page's loose guard, so the side panel takes it too.
  routes = sidepanelRoutes(100);
  assert.strictEqual((await historyContext()).subtitleBody.length, 2);
  assert.ok("boc_subtitle_cache_BVa_11_id_5" in local);

  finished = true;
  clearInterval(keepAlive);
  console.log("background selftest: all passed");
})();
