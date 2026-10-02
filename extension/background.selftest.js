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
  importScripts() {}
});
vm.runInContext(fs.readFileSync(path.join(__dirname, "sites.js"), "utf8"), ctx);
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
        if (m.type !== "token") resolve(out);
      }
    };
    onConnect(port);
  });
}

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
  const stored = { readerTheme: "dark", readerFontScale: "l", readerTranscriptVisible: false, aiPresetPrompts: ["a"] };
  ctx.chrome = { storage: { sync: area(stored), local: area({ obsidianApiKey: "k" }) } };
  await ctx.saveSettings({ aiPresetPrompts: [], noteFolder: "N" });
  assert.strictEqual(stored.readerTheme, "dark");
  assert.strictEqual(stored.readerFontScale, "l");
  assert.strictEqual(stored.readerTranscriptVisible, false);
  assert.deepStrictEqual(stored.aiPresetPrompts, []);
  assert.strictEqual(stored.noteFolder, "N");
  assert.strictEqual((await ctx.chrome.storage.local.get("obsidianApiKey")).obsidianApiKey, "k");

  const systemFor = (extra) =>
    ctx.buildAiMessages({ context: { isVideoContext: true, title: "T", description: "简介", ...extra }, userPrompt: "q" })[0].content;
  const none = systemFor({});
  assert.match(none, /这个视频没有字幕/);
  assert.doesNotMatch(none, /抓取失败/);
  const failed = systemFor({ subtitleFailure: "字幕接口限流（429），稍后再试" });
  assert.match(failed, /字幕抓取失败（字幕接口限流（429），稍后再试）/);
  assert.match(failed, /以下仅基于简介和评论/);
  assert.doesNotMatch(failed, /这个视频没有字幕/);
  assert.match(failed, /以下是视频简介：\n\n简介/);
  assert.doesNotMatch(systemFor({ subtitleMarkdown: "字幕", subtitleFailure: "旧失败" }), /抓取失败/);

  console.log("background selftest: all passed");
})();
