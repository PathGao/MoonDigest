// node extension/background.selftest.js
if (process.versions.bun) (console.error("This selftest needs Node: it fails or hangs under bun (see 自检 in README.md)."), process.exit(1));
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

let onConnect;
const onMessage = [];
const anything = new Proxy(function () {}, { get: () => anything, apply: () => anything });
const runtime = new Proxy({}, {
  get: (_, k) => (k === "onConnect" ? { addListener: (fn) => (onConnect = fn) } : k === "onMessage" ? { addListener: (fn) => onMessage.push(fn) } : anything)
});
// A runtime message as a page sends it: the first listener that keeps the channel open answers.
const ask = (message) => new Promise((resolve) => onMessage.some((fn) => fn(message, {}, resolve) === true));
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

// I6: the prompts state the limits the code applies (简介 chars sent, tag name length), from the constants.
{
  const intro = `简介前${ctx.TriageUi.INTRO_CHARS}字`;
  assert.ok(vm.runInContext("TRIAGE_TITLE_PROMPT", ctx).includes(intro) && vm.runInContext("TRIAGE_AI_UNIT.header", ctx).includes(intro));
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, "triage/triage-bg.js"), "utf8"), /简介前\d|≤\d+字、不含逗号/, "a prompt writes a limit itself");
}

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
      onMessage: { addListener: (fn) => fn({ action: "chat", providerId: "p", prompt: "q", context: { isVideoContext: true, subtitleMarkdown: "字幕" } }) },
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
  // F14: its own code, so the panel offers only 重试 (the settings cannot fix a reply that stopped midway).
  assert.strictEqual(out.at(-1).error, ctx.MdgErrors.aiStalled(vm.runInContext("STREAM_TIMEOUT_MS.idle", ctx)));
  assert.strictEqual(out.at(-1).code, "AI_STALLED");
  assert.strictEqual(ctx.MdgErrors.action("AI_STALLED"), "none");

  // No response at all ends with the first-response error, not a generic network error.
  ctx.fetch = (url, { signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(abortError())));
  out = await chat();
  assert.deepStrictEqual(out.map((m) => m.type), ["error"]);
  // The same sentence as 分拣台's timeout (MdgErrors.aiTimeout), with the side panel's own limit.
  assert.strictEqual(out[0].error, ctx.MdgErrors.aiTimeout(vm.runInContext("STREAM_TIMEOUT_MS.first", ctx)));
  assert.strictEqual(out[0].code, "AI_TIMEOUT");

  // The side panel and 测试连接 turn thinking off where the platform takes the switch, and send nothing elsewhere.
  for (const [url, on] of [
    ["https://api.deepseek.com/v1", true], ["https://open.bigmodel.cn/api/paas/v4", true], ["https://api.moonshot.cn/v1", true],
    ["https://api.openai.com/v1", false], ["https://openrouter.ai/api/v1", false], ["http://localhost:11434/v1", false], ["https://api.minimaxi.com/v1", false]
  ]) {
    ctx.loadAiProviders = async () => [{ id: "p", baseUrl: url, model: "m", requiresKey: false }];
    const bodies = [];
    const stream = streamingFetch([{ after: 0, done: true }]);
    ctx.fetch = (u, init) => (bodies.push(JSON.parse(init.body)), stream(u, init));
    await chat();
    ctx.fetch = async (u, init) => (bodies.push(JSON.parse(init.body)), { ok: true });
    await ctx.probeAiChatCompletion({ baseUrl: url, apiKey: "", model: "m" });
    assert.deepStrictEqual(bodies.map((b) => b.thinking), on ? [{ type: "disabled" }, { type: "disabled" }] : [undefined, undefined], url);
  }
  ctx.loadAiProviders = async () => [{ id: "p", baseUrl: "https://ai.test", model: "m", requiresKey: false }];

  // 测试连接 in the settings page: the side panel's classification, words and codes, never the raw body or English.
  {
    const test = (fetch, fields = {}) => ((ctx.fetch = fetch), ctx.testAiConnection({ baseUrl: "https://ai.test/v1", apiKey: "k", model: "m", ...fields }));
    const was = ctx.hostPermissionError;
    ctx.hostPermissionError = async () => "";
    const failed = async () => {
      throw new TypeError("Failed to fetch");
    };
    assert.deepStrictEqual({ ...(await test(async () => ({ ok: false, status: 401, text: async () => '{"error":{"message":"Incorrect API key"}}' }))) }, { ok: false, error: "AI 平台的 API Key 无效或没有权限", code: "AI_AUTH" });
    assert.deepStrictEqual({ ...(await test(failed)) }, { ok: false, error: "连不上 AI 平台，请检查网络和接口地址", code: "AI_NETWORK" });
    ctx.hostPermissionError = async () => "未授权访问 https://ai.test，授权后重试";
    assert.deepStrictEqual({ ...(await test(failed)) }, { ok: false, error: "未授权访问 https://ai.test，授权后重试", code: "AI_ACCESS" });
    // L7: one classification of a request that got no answer (aiFetchError), for the side panel, 测试连接 and 分拣台;
    // a saved platform's address is normalized once (normalizeAiProvider), not again per request.
    const src = ["background.js", "triage/triage-bg.js"].map((f) => fs.readFileSync(path.join(__dirname, f), "utf8")).join("\n");
    assert.strictEqual(src.match(/await hostPermissionError\(/g).length, 1, "hostPermissionError is asked only in aiFetchError");
    assert.strictEqual(ctx.normalizeAiProvider({ id: "x", baseUrl: " https://ai.test/v1// " }).baseUrl, "https://ai.test/v1", "a saved platform's address is trimmed");
    const timeout = async () => {
      throw Object.assign(new Error("timeout"), { name: "TimeoutError" });
    };
    assert.deepStrictEqual({ ...(await test(timeout)) }, { ok: false, error: ctx.MdgErrors.aiTimeout(vm.runInContext("AI_TEST_TIMEOUT_MS", ctx)), code: "AI_TIMEOUT" });
    ctx.hostPermissionError = async () => "";
    // The 30 s also cover the reply's body: a body that stalls is the timeout, not 「不是 JSON」.
    {
      const realSignal = ctx.AbortSignal;
      ctx.AbortSignal = { timeout: () => { const c = new AbortController(); setTimeout(() => c.abort(Object.assign(new Error("timeout"), { name: "TimeoutError" })), 20); return c.signal; } };
      const stalled = await test(async (url, { signal }) => ({ ok: true, json: () => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason))) }));
      ctx.AbortSignal = realSignal;
      assert.strictEqual(stalled.code, "AI_TIMEOUT", "a stalled body is the timeout");
    }
    // F4: the side panel's and 分拣台's check (aiProviderProblem), API Key included.
    assert.deepStrictEqual(
      [{ ...(await test(failed, { baseUrl: " " })) }, { ...(await test(failed, { model: "" })) }, { ...(await test(failed, { apiKey: "" })) }],
      [
        { ok: false, error: "AI 平台的接口地址没填", code: "AI_SETUP" },
        { ok: false, error: "AI 平台的模型名没填", code: "AI_SETUP" },
        { ok: false, error: "AI 平台的 API Key 没填", code: "AI_AUTH" }
      ]
    );
    assert.strictEqual((await test(failed, { apiKey: "", requiresKey: false })).code, "AI_NETWORK", "Ollama needs no key");
    // F2: a 200 that carries an error in its body is that error, as in 分拣台 and the side panel; not 连接成功.
    const reply = (json) => async () => ({ ok: true, json: async () => json });
    assert.deepStrictEqual({ ...(await test(reply({ error: { message: "余额不足" } }))) }, { ok: false, error: "AI 平台余额不足或额度已用完，请充值或换一个平台", code: "AI_QUOTA" });
    assert.deepStrictEqual({ ...(await test(async () => ({ ok: true, json: async () => JSON.parse("<html>") }))) }, { ok: false, error: "AI 平台的回复不是 JSON" });
    assert.deepStrictEqual({ ...(await test(reply({ choices: [{ message: { content: "" }, finish_reason: "length" }] }))) }, { ok: true });
    ctx.hostPermissionError = was;
  }

  // Settings migration: the empty-panel chips fold into the one follow-up list, once.
  const area = (data) => ({
    data,
    async get(keys) {
      if (keys == null) return JSON.parse(JSON.stringify(data));
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
  assert.deepStrictEqual(fresh.aiPresetPrompts, [...ctx.MdgSettings.DEFAULTS.aiPresetPrompts]);
  assert.strictEqual(fresh.playerAiQuickPrompt, ctx.MdgSettings.DEFAULTS.playerAiQuickPrompt);
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
  // Two pages saving different settings at once: each writes only its own keys, so neither reverts the other.
  await Promise.all([ctx.saveSettings({ readerTheme: "light" }), ctx.saveSettings({ noteFolder: "M" })]);
  assert.deepStrictEqual([stored.readerTheme, stored.noteFolder], ["light", "M"]);
  // An imported file's frontmatterFields that is not a list reads as the default (the settings page maps over it).
  assert.deepStrictEqual([...ctx.normalizeSyncSettings({ frontmatterFields: "title" }).frontmatterFields], [...ctx.MdgSettings.DEFAULTS.frontmatterFields]);

  // C17: the saved and read settings go through MdgSettings.normalizeSwitches: a non-boolean keeps a default-on switch on.
  {
    const n = ctx.normalizeSyncSettings({ enablePlayerAiQuickAction: "true", includeDateInFilename: 1, includeTimestampInBody: "yes", obsidianEnabled: "true" });
    assert.deepStrictEqual([n.enablePlayerAiQuickAction, n.includeDateInFilename, n.includeTimestampInBody, n.obsidianEnabled], [true, true, true, false]);
  }

  // 看多少算看完了 (1–100): empty, not a number, 0 or negative is 80; above 100 is 100.
  for (const [input, want] of [[0, 80], [-5, 80], [1, 1], ["150", 100], [42.4, 42], [undefined, 80], ["", 80], ["x", 80]]) {
    assert.strictEqual(ctx.normalizeSyncSettings({ seenThreshold: input }).seenThreshold, want);
  }

  const systemFor = (extra) =>
    ctx.buildAiMessages({ context: { isVideoContext: true, title: "T", description: "简介", ...extra }, userPrompt: "q" }).messages[0].content;
  const none = systemFor({});
  // The shared sentence (MdgErrors.subtitleMissing), told to the user too, like the login and failure branches.
  assert.match(none, /^视频没有字幕。你拿不到/m);
  assert.match(none, /告诉用户：视频没有字幕。/);
  assert.doesNotMatch(none, /抓取失败/);
  const failed = systemFor({ subtitleFailure: "字幕接口限流（429），稍后再试" });
  assert.match(failed, /字幕抓取失败：字幕接口限流（429），稍后再试。/);
  assert.match(failed, /以下仅基于简介和评论/);
  assert.doesNotMatch(failed, /这个视频没有字幕/);
  assert.match(failed, /以下是视频简介：\n\n简介/);
  assert.doesNotMatch(systemFor({ subtitleMarkdown: "字幕", subtitleFailure: "旧失败" }), /抓取失败/);
  // The user is told too, under the reply: no subtitles, or they failed to load.
  const noticesFor = (extra) => [...ctx.buildAiMessages({ context: { isVideoContext: true, title: "T", ...extra }, userPrompt: "q" }).notices];
  // The three states read as on every other entry (MdgErrors.subtitleMissing).
  assert.deepStrictEqual(noticesFor({}), ["视频没有字幕，只根据标题、简介和评论回答"]);
  assert.deepStrictEqual(noticesFor({ subtitleFailure: "429" }), ["字幕抓取失败：429，只根据标题、简介和评论回答"]);
  assert.deepStrictEqual(noticesFor({ subtitleFailure: "要登录", subtitleNeedLogin: true }), ["未登录 B站，拿不到字幕，只根据标题、简介和评论回答"]);
  assert.match(systemFor({ subtitleNeedLogin: true }), /未登录 B站，拿不到字幕。视频本身可能有字幕/);
  assert.deepStrictEqual(noticesFor({ subtitleMarkdown: "字幕" }), [], "with subtitles there is nothing to say");
  // A subtitle that does not match the video's length is sent with the video page's warning.
  assert.deepStrictEqual(noticesFor({ subtitleMarkdown: "字幕", subtitleWarning: "字幕时间轴到 06:40，视频长 04:33，字幕时间可能对不上。" }), ["字幕时间轴到 06:40，视频长 04:33，字幕时间可能对不上"]);

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
  assert.match(trimmedRequest.notices.at(-1), /最早的 4 条消息没有发送/);
  assert.strictEqual(ctx.buildAiMessages({ context: { subtitleMarkdown: "字幕" }, userPrompt: "q", history: turn(1) }).notices.length, 0);

  // An error object inside a 200 stream ends the reply with that error instead of a silent "done".
  ctx.fetch = streamingFetch([
    { after: 5, chunk: sse({ content: "半" }) },
    { after: 5, chunk: new TextEncoder().encode(`data: ${JSON.stringify({ error: { message: "quota exceeded" } })}\n\n`) },
    { after: 0, done: true }
  ]);
  out = await chat();
  assert.deepStrictEqual(out.map((m) => m.type), ["token", "error"]);
  assert.deepStrictEqual([out[1].error, out[1].code], ["AI 平台余额不足或额度已用完，请充值或换一个平台", "AI_QUOTA"]);
  // A per-minute quota in the stream is 限流, as it is over HTTP 429 (Gemini's wording).
  ctx.fetch = streamingFetch([
    { after: 5, chunk: new TextEncoder().encode(`data: ${JSON.stringify({ error: { message: "Quota exceeded for metric: requests per minute" } })}\n\n`) },
    { after: 0, done: true }
  ]);
  out = await chat();
  assert.deepStrictEqual([out[0].error, out[0].code], ["AI 平台限流", "AI_THROTTLED"]);

  // F3: a reply without one word of answer (only thinking, or a 200 whose body is a plain JSON error) is an error the
  // panel shows with 重试, not an empty bubble; a last line without its newline still counts.
  const raw = (text) => ({ after: 0, chunk: new TextEncoder().encode(text) });
  for (const [script, error, code] of [
    [[{ after: 0, chunk: sse({ reasoning_content: "想" }) }], ctx.MdgErrors.TEXT.aiEmpty, undefined],
    [[raw('{"error":{"message":"Insufficient Balance"}}')], "AI 平台余额不足或额度已用完，请充值或换一个平台", "AI_QUOTA"],
    [[raw('{\n  "error": {\n    "message": "rate limit"\n  }\n}\n')], "AI 平台限流", "AI_THROTTLED"]
  ]) {
    ctx.fetch = streamingFetch([...script, { after: 0, done: true }]);
    out = await chat();
    assert.deepStrictEqual(out.map((m) => [m.type, m.error, m.code]), [["error", error, code]]);
  }
  ctx.fetch = streamingFetch([raw(`data: ${JSON.stringify({ choices: [{ delta: { content: "尾" } }] })}`), { after: 0, done: true }]);
  assert.deepStrictEqual((await chat()).map((m) => m.data || m.type), ["尾", "done"]);
  // A platform that ignores stream:true and answers with one plain completion: that answer, not 「回答为空」.
  ctx.fetch = streamingFetch([raw(JSON.stringify({ choices: [{ message: { content: "整段回答" } }] })), { after: 0, done: true }]);
  assert.deepStrictEqual((await chat()).map((m) => m.data || m.type), ["整段回答", "done"]);
  // An HTTP error whose body stalls until the watchdog fires: the timeout, as on the other paths, not the HTTP error.
  ctx.fetch = async (url, { signal }) => ({ ok: false, status: 500, text: () => new Promise((_, reject) => signal.addEventListener("abort", () => reject(abortError()))) });
  assert.deepStrictEqual((await chat()).map((m) => m.code), ["AI_TIMEOUT"]);

  // HTTP and network errors reach the panel in Chinese with the 分拣台's code, never the body.
  ctx.fetch = async () => ({ ok: false, status: 401, text: async () => '{"error":{"message":"Incorrect API key provided"}}' });
  out = await chat();
  assert.deepStrictEqual([out[0].error, out[0].code], ["AI 平台的 API Key 无效或没有权限", "AI_AUTH"]);
  ctx.fetch = async () => {
    throw new TypeError("Failed to fetch");
  };
  out = await chat();
  assert.deepStrictEqual([out[0].error, out[0].code], ["连不上 AI 平台，请检查网络和接口地址", "AI_NETWORK"]);

  // Setup the settings page fixes (key, base URL, model) carries a code, so the panel offers 去设置, not only 重试.
  const setupError = async (provider) => {
    const was = ctx.loadAiProviders;
    ctx.loadAiProviders = async () => [{ id: "p", baseUrl: "https://ai.test", model: "m", requiresKey: false, ...provider }];
    const [m] = await chat();
    ctx.loadAiProviders = was;
    return [m.error, m.code];
  };
  assert.deepStrictEqual(await setupError({ requiresKey: true }), ["AI 平台的 API Key 没填", "AI_AUTH"]);
  assert.deepStrictEqual(await setupError({ baseUrl: "" }), ["AI 平台的接口地址没填", "AI_SETUP"]);
  assert.deepStrictEqual(await setupError({ model: "" }), ["AI 平台的模型名没填", "AI_SETUP"]);

  // A request that never answers fails with a retryable timeout instead of hanging the caller.
  ctx.fetch = (url, { signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
  await assert.rejects(ctx.fetchWithTimeout("https://api.bilibili.com/x", {}, 30), (e) => e.status === 408 && /超时/.test(e.message));
  // A body that stalls is the same 408.
  ctx.fetch = async (url, { signal }) => ({ ok: true, json: () => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason))) });
  const slowBody = await ctx.fetchWithTimeout("http://127.0.0.1:27123/", {}, 30);
  await assert.rejects(slowBody.json(), (e) => e.status === 408 && /超时/.test(e.message));

  // D2: the video page's fetch-json reads B站 like 分拣台 and the side panel: their request, timeout and words.
  {
    const bili = "https://api.bilibili.com/x/web-interface/view?bvid=BV1";
    ctx.fetch = async () => ({ ok: false, status: 403 });
    assert.deepStrictEqual({ ...(await ask({ type: "fetch-json", url: bili })) }, { ok: false, error: "B站请求失败 HTTP 403", code: undefined, status: 403 });
    ctx.fetch = async () => ({ ok: true, json: async () => JSON.parse("<html>") });
    assert.match((await ask({ type: "fetch-json", url: bili })).error, /^B站返回的不是 JSON/);
    vm.runInContext("TRIAGE_BILI_CFG.timeoutMs = 20", ctx);
    ctx.fetch = () => new Promise(() => {});
    const late = await ask({ type: "fetch-json", url: bili });
    vm.runInContext("TRIAGE_BILI_CFG.timeoutMs = MdgErrors.NET_TIMEOUT_MS", ctx);
    assert.deepStrictEqual([late.error, late.code], [ctx.MdgErrors.netTimeout(20), "NETWORK"]);
    ctx.fetch = async (url, init) => ({ ok: true, json: async () => ({ code: 0, data: { referrer: init.referrer } }) });
    assert.deepStrictEqual({ ...(await ask({ type: "fetch-json", url: bili })).data.data }, { referrer: "https://www.bilibili.com/" }, "the whole JSON, sent as B站 pages send it");
  }

  // F1: 去设置 from the popup, the video page and 分拣台 focuses an open settings page instead of opening another.
  {
    const was = ctx.chrome;
    const calls = [];
    ctx.chrome = { runtime: { openOptionsPage: async () => calls.push("focus") }, tabs: { create: async () => calls.push("new tab") } };
    assert.deepStrictEqual({ ...(await ask({ type: "open-options" })) }, { ok: true });
    assert.deepStrictEqual(calls, ["focus"]);
    ctx.chrome = was;
  }

  // With #297: a platform the settings page sends with hasSavedKey: false (its base URL changed host) loses its old key;
  // one sent without a new key and without that flag keeps it.
  {
    const was = [ctx.chrome, ctx.loadAiProviderKeys];
    let written = null;
    ctx.loadAiProviderKeys = async () => ({ a: "old-a", b: "old-b", c: "old-c" });
    ctx.chrome = { storage: { sync: { set: async () => {} }, local: { set: async (v) => (written = Object.values(v)[0]) } } };
    const out = await ctx.saveAiProviders([{ id: "a", hasSavedKey: false }, { id: "b", hasSavedKey: true }, { id: "c", apiKey: "new-c", hasSavedKey: false }]);
    assert.deepStrictEqual({ ...written }, { b: "old-b", c: "new-c" });
    assert.deepStrictEqual([...out.map((p) => p.hasSavedKey)], [false, true, true]);
    [ctx.chrome, ctx.loadAiProviderKeys] = was;
  }

  // L2: a page the content script cannot sync with: the reason only, no instruction (the popup words the failure).
  {
    const was = [ctx.chrome, ctx.injectReaderContent];
    ctx.chrome = { scripting: { executeScript: async () => [{ result: "old" }] } };
    ctx.injectReaderContent = async () => {};
    await assert.rejects(ctx.ensureReaderContentReady(1), (e) => e.message === "扩展脚本未能和当前页面同步");
    // A15: Chrome's error page refuses the injection; the reason stays ours, not Chrome's English.
    ctx.injectReaderContent = async () => {
      throw new Error("Frame with ID 0 is showing error page");
    };
    await assert.rejects(ctx.ensureReaderContentReady(1), (e) => e.message === "扩展脚本未能和当前页面同步");
    [ctx.chrome, ctx.injectReaderContent] = was;
  }

  // The side panel saves the context URL with a conversation, so reader mode and tracking params never reach it.
  const contextFor = async (tabUrl, payload) => {
    ctx.chrome = { tabs: { get: async () => ({ id: 1, url: tabUrl }) } };
    ctx.ensureReaderContentReady = async () => {};
    // One request: the page settles its video and answers with the comments.
    ctx.sendMessageToTab = async (_, { type }) => {
      assert.strictEqual(type, "sidepanel-get-context");
      return payload.ok === false ? payload : { ok: true, payload: { url: tabUrl, title: "T", ...payload } };
    };
    return ctx.getAiSidepanelState(1);
  };
  const bili = await contextFor("https://www.bilibili.com/video/BV1xx411c7mD/?p=2&mdg_reader=1&spm_id_from=333.1", {
    site: "bilibili", videoId: "BV1xx411c7mD", pageIndex: 2, pageCount: 3
  });
  assert.strictEqual(bili.url, "https://www.bilibili.com/video/BV1xx411c7mD/?p=2");
  const yt = await contextFor("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s&mdg_reader=1", { site: "youtube", videoId: "dQw4w9WgXcQ" });
  assert.strictEqual(yt.url, "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  // Before the page has read its video id, the URL itself is cleaned.
  const early = await contextFor("https://www.bilibili.com/video/BV1xx411c7mD/?mdg_reader=1", { videoId: "" });
  assert.strictEqual(early.url, "https://www.bilibili.com/video/BV1xx411c7mD/");
  // The page's failure for the current video is the side panel's error.
  await assert.rejects(contextFor("https://www.bilibili.com/video/BV1xx411c7mD/", { ok: false, error: "B站限流，请稍后再试" }), /B站限流/);
  // The page did not answer (Chrome's English messaging error): said in our words.
  {
    const was = ctx.sendMessageToTab;
    ctx.sendMessageToTab = async () => {
      throw new Error("Could not establish connection. Receiving end does not exist.");
    };
    await assert.rejects(ctx.getAiSidepanelState(1), (e) => e.message === `视频页没有回应，${ctx.MdgErrors.TEXT.reloadRetry}`);
    ctx.sendMessageToTab = was;
  }
  // A YouTube conversation read through the open tab asks for its own video: a page now on another one does not answer.
  {
    const was = [ctx.findTabForRef, ctx.getAiSidepanelState];
    ctx.findTabForRef = async () => ({ id: 4 });
    ctx.getAiSidepanelState = async (tabId, opts) => ({ tabId, ...opts });
    const got = await ctx.resolveAiSidepanelContext({ isVideoContext: true, site: "youtube", videoId: "dQw4w9WgXcQ", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" });
    assert.deepStrictEqual([got.tabId, got.videoId], [4, "dQw4w9WgXcQ"]);
    [ctx.findTabForRef, ctx.getAiSidepanelState] = was;
  }
  // 专注模式's retries stop once the tab has moved on to another video: its page is never sent this one's address.
  {
    const was = [ctx.sendMessageToTab, ctx.ensureReaderContentReady];
    const sent = [];
    ctx.chrome = { tabs: { get: async () => ({ id: 1, url: "https://www.bilibili.com/video/BV1GJ411x7h7" }) } };
    ctx.ensureReaderContentReady = async () => {};
    ctx.sendMessageToTab = async (_, m) => {
      sent.push(m.readerUrl);
      throw new Error("Could not establish connection. Receiving end does not exist.");
    };
    assert.strictEqual(await ctx.triggerReaderModeInTab(1, "https://www.bilibili.com/video/BV1xx411c7mD?mdg_reader=1", 5, 1), false);
    assert.strictEqual(sent.length, 1, "no retry lands on the other video's page");
    [ctx.sendMessageToTab, ctx.ensureReaderContentReady] = was;
  }
  // AI platforms: a delete sent while a save is pending is not undone by it, and sync keeps no hasSavedKey.
  {
    const was = [ctx.chrome, ctx.loadAiProviders, ctx.loadAiProviderKeys];
    const syncData = { aiProviders: [{ id: "a" }, { id: "b" }] };
    let keys = { a: "ka", b: "kb" };
    const later = (v) => new Promise((r) => setTimeout(() => r(v), 5));
    ctx.chrome = { storage: { sync: { set: async (o) => Object.assign(syncData, JSON.parse(JSON.stringify(o))) }, local: { set: async (o) => (keys = { ...Object.values(o)[0] }) } } };
    ctx.loadAiProviderKeys = () => later({ ...keys });
    ctx.loadAiProviders = async () => syncData.aiProviders.map((p) => ({ ...p, hasSavedKey: Boolean(keys[p.id]) }));
    await Promise.all([ctx.saveAiProviders([{ id: "a" }, { id: "b" }]), ctx.deleteAiProvider("b")]);
    assert.deepStrictEqual([syncData.aiProviders.map((p) => p.id), Object.keys(keys)], [["a"], ["a"]]);
    assert.ok(!("hasSavedKey" in syncData.aiProviders[0]), "sync keeps the platforms only");
    [ctx.chrome, ctx.loadAiProviders, ctx.loadAiProviderKeys] = was;
  }

  // A history conversation's context takes the video page's way with a subtitle that does not match the video.
  const local = {};
  ctx.chrome = { storage: { sync: area({}), local: area(local) } };
  const subUrl = "https://aisubtitle.hdslb.com/a.json";
  const sidepanelRoutes = (to) => ({
    "/view/detail": { code: 0, data: { View: { title: "T", aid: 22, cid: 11, duration: 273, pages: [{ cid: 11, page: 1, duration: 273 }] } } },
    "/nav": { code: -101, data: { wbi_img: { img_url: "https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png", sub_url: "https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png" } } },
    "/x/player/wbi/v2": { code: 0, data: { subtitle: { subtitles: [{ id: 5, lan: "ai-zh", lan_doc: "中文", subtitle_url: subUrl }] } } },
    [subUrl]: { body: [{ from: 0, to: 1, content: "a" }, { from: 1, to, content: "b" }] },
    "/reply/main": { code: 0, data: { replies: [] } }
  });
  const historyContext = () => ctx.resolveAiSidepanelContext({ site: "bilibili", videoId: "BVa", cid: "11" });
  // A subtitle running far past the 273 s video is still used, with the video page's warning, and not cached.
  let routes = sidepanelRoutes(400);
  // The side panel reads B站 through triage-bg.js's channel (fetch), with the B站 referrer.
  const inits = [];
  const urls = [];
  // A route's Error is a dropped connection.
  ctx.fetch = async (url, init) => {
    inits.push(init);
    urls.push(url);
    const answer = routes[Object.keys(routes).find((part) => url.includes(part))];
    if (answer instanceof Error) throw answer;
    return { ok: true, status: 200, json: async () => answer };
  };
  // The subtitle lines the AI reads (L6: the context carries only the note, no body or track list).
  const lines = (r) => (r.subtitleMarkdown.split("## 字幕\n")[1] || "").split("\n").filter((l) => /\S/.test(l) && !l.startsWith("#")).length;
  const mismatched = await historyContext();
  assert.deepStrictEqual([lines(mismatched), "subtitleBody" in mismatched, "subtitleOptions" in mismatched], [2, false, false]);
  assert.match(mismatched.subtitleMarkdown, /## 字幕/);
  assert.strictEqual(mismatched.subtitleWarning, "字幕时间轴到 06:40，视频长 04:33，字幕时间可能对不上。");
  // I2: with the part count, as the video page sends it (a P1 conversation note's name needs it).
  assert.strictEqual(mismatched.pageCount, 1);
  assert.deepStrictEqual(Object.keys(local).filter((k) => k.startsWith("mdg_subtitle_cache_")), []);
  // Like the video page, the next track is tried when the chosen one does not match; the match wins, without a warning.
  const otherUrl = "https://aisubtitle.hdslb.com/b.json";
  routes = sidepanelRoutes(400);
  routes["/x/player/wbi/v2"].data.subtitle.subtitles.push({ id: 6, lan: "ai-en", lan_doc: "English", subtitle_url: otherUrl });
  routes[otherUrl] = { body: [{ from: 0, to: 270, content: "c" }] };
  const second = await historyContext();
  assert.deepStrictEqual([second.selectedSubtitleId, second.subtitleWarning, lines(second)], ["6", "", 1]);
  delete local.mdg_subtitle_cache_BVa_11_id_6;
  // Tracks with empty bodies leave the AI the title, description and comments, flagged as a failed fetch.
  routes = { ...sidepanelRoutes(100), [subUrl]: { body: [] } };
  const empty = await historyContext();
  assert.deepStrictEqual([lines(empty), empty.subtitleMarkdown, empty.subtitleFailure], [0, "", "字幕文件为空"]);
  // A failed download or track list (not a limit) answers like the video page: no subtitle, and why, for 字幕抓取失败.
  const dropConn = () => new TypeError("Failed to fetch");
  routes = { ...sidepanelRoutes(100), [subUrl]: dropConn() };
  const dropped = await historyContext();
  assert.deepStrictEqual([lines(dropped), dropped.subtitleMarkdown, dropped.subtitleFailure], [0, "", "网络断了"]);
  routes = { ...sidepanelRoutes(100), "/x/player/wbi/v2": dropConn(), "/x/player/v2": dropConn() };
  assert.strictEqual((await historyContext()).subtitleFailure, "网络断了");
  // Speech ending at 100 s (a long silent outro) passes the video page's loose guard, so the side panel takes it too.
  routes = sidepanelRoutes(100);
  const resolved = await historyContext();
  assert.strictEqual(lines(resolved), 2);
  // As many hot comments as the video page and 分拣台 notes ask for: one count, MdgLimits.HOT_COMMENTS.
  assert.ok(urls.some((u) => u.includes("/reply/main") && u.includes(`&ps=${ctx.MdgLimits.HOT_COMMENTS}&`)) && ctx.MdgLimits.HOT_COMMENTS === 20);
  // The AI gets the same note the video page sends (MdgNote.buildAiContext): front matter and subtitles, no player embed.
  assert.match(resolved.subtitleMarkdown, /^---\ntitle: "T"\n/);
  assert.match(resolved.subtitleMarkdown, /subtitle_lang: "中文"/);
  assert.ok(!/<iframe|player\.bilibili\.com/.test(resolved.subtitleMarkdown), "the AI context carries no player embed");
  assert.match(resolved.subtitleMarkdown, /\n## 字幕\n\n`00:00` a\n`00:01` b$/);
  assert.ok("mdg_subtitle_cache_BVa_11_id_5" in local);
  // Signed like 细看, and risk control on the subtitle list fails the follow-up as a B站 limit, not as 没有字幕.
  assert.ok(urls.some((u) => u.includes("/x/player/wbi/v2?") && u.includes("w_rid=")));
  routes = { ...sidepanelRoutes(100), "/x/player/wbi/v2": { code: -352, message: "风控" }, "/x/player/v2": { code: 0, data: { subtitle: { subtitles: [] } } } };
  await assert.rejects(historyContext(), (e) => e.code === "THROTTLED");
  // An empty list because B站 wants a login carries the flag the side panel's login sentence reads.
  routes = { ...sidepanelRoutes(100), "/x/player/wbi/v2": { code: 0, data: { need_login_subtitle: true, subtitle: { subtitles: [] } } } };
  assert.strictEqual((await historyContext()).subtitleNeedLogin, true);
  routes = sidepanelRoutes(100);
  assert.strictEqual((await historyContext()).subtitleNeedLogin, false);
  assert.ok(inits.length && inits.every((i) => i.referrer === "https://www.bilibili.com/" && i.cache === "no-store" && i.credentials === "include"));

  // Dead keys go on install and update, the old 已看 mark (triage_watched) among them; the 待播 list stays.
  const dead = { triage_watched: { BV1: 1 }, triage_tab: "none", triage_schemes: [], triage_excluded_folders: ["2"], triage_basket: [{ bvid: "BV1" }] };
  ctx.chrome = { storage: { sync: area({}), local: { ...area(dead), getKeys: async () => Object.keys(dead) } } };
  await ctx.removeDeadStorageKeys();
  assert.deepStrictEqual(Object.keys(dead), ["triage_basket"]);

  // Settings file: everything in sync (收藏夹 and 关注 included), never a key, even one an older version left in sync.
  const exportSync = { noteFolder: "X", triageFineBatchSize: 20, follow_ai_settings: { batchSize: 7 }, aiProviders: [{ id: "p", apiKey: "sk-old" }], obsidianApiKey: "leak" };
  ctx.chrome = { runtime: { getManifest: () => ({ version: "9" }) }, storage: { sync: area(exportSync), local: area({ obsidianApiKey: "k", aiProviderKeys: { p: "sk" }, triage_included_folders: ["11", "toview"], triage_folder_criteria: { 11: "只留菜谱" }, triage_sort: { 11: "pub" }, triage_tags: [] }) } };
  const file = JSON.parse(JSON.stringify(await ctx.exportSettings()));
  assert.deepStrictEqual([file.kind, file.extensionVersion, file.settings.triageFineBatchSize, file.settings.follow_ai_settings], ["settings", "9", 20, { batchSize: 7 }]);
  assert.deepStrictEqual(file.settings.aiProviders, [{ id: "p" }]);
  assert.ok(!/sk|leak|"k"/.test(JSON.stringify(file)), "no keys in the file");
  assert.deepStrictEqual(file.local, { triage_included_folders: ["11", "toview"], triage_folder_criteria: { 11: "只留菜谱" } }, "the 分拣台's folder choice and 判断标准; no sort, no data");

  // Import replaces every setting, migrates an older file's keys, fills defaults, and leaves local keys alone.
  const importSync = { noteFolder: "Y", stray: 1 };
  const importLocal = { obsidianApiKey: "k2", aiProviderKeys: { q: "sk2" } };
  ctx.chrome = { storage: { sync: area(importSync), local: area(importLocal) } };
  // L12: a file that carries a platform's API Key (hand-edited, or from another tool) never puts it into sync.
  const old = { ...file, settings: { ...file.settings, aiInitialQuickPrompts: ["旧"], obsidianApiKey: "x", aiProviders: [{ id: "p", apiKey: "sk-file" }] } };
  await ctx.importSettings(old);
  assert.ok(!JSON.stringify(importSync).includes("sk-file") && importSync.aiProviders?.[0]?.id === "p", "a provider's key in the file stays out of sync");
  assert.deepStrictEqual([importSync.noteFolder, importSync.triageFineBatchSize, importSync.follow_ai_settings], ["X", 20, { batchSize: 7 }]);
  assert.ok(!("stray" in importSync) && !("aiInitialQuickPrompts" in importSync) && !("obsidianApiKey" in importSync));
  assert.ok(importSync.aiPresetPrompts.includes("旧"));
  assert.strictEqual(importSync.seenThreshold, 80);
  assert.deepStrictEqual(importLocal, { obsidianApiKey: "k2", aiProviderKeys: { q: "sk2" }, triage_included_folders: ["11", "toview"], triage_folder_criteria: { 11: "只留菜谱" } });
  // A file from before the folder choice was exported leaves the current choice.
  importLocal.triage_included_folders = ["7"];
  const { local: _, ...older } = file;
  await ctx.importSettings(older);
  assert.deepStrictEqual(importLocal.triage_included_folders, ["7"]);

  // 分拣台's 完整备份 and a newer file are refused without touching anything.
  const before = JSON.stringify(importSync);
  await assert.rejects(ctx.importSettings({ app: "moondigest", schemaVersion: 3, settings: {} }), /不是 MoonDigest 的设置文件/);
  await assert.rejects(ctx.importSettings({ ...file, schemaVersion: 2 }), /更新的版本/);
  await assert.rejects(ctx.importSettings({ ...file, schemaVersion: undefined }), /不是 MoonDigest 的设置文件/, "no schemaVersion is no settings file, not a newer one");
  await assert.rejects(ctx.importSettings({ ...file, local: { triage_included_folders: "11" } }), /不是 MoonDigest 的设置文件/);
  await assert.rejects(ctx.importSettings({ ...file, local: { triage_folder_criteria: { 11: 5 } } }), /不是 MoonDigest 的设置文件/);
  // F5: an import past sync's 8 KB per item is refused in Chinese, as a save is, and changes nothing.
  await assert.rejects(ctx.importSettings({ ...file, settings: { ...file.settings, aiSystemPrompt: "字".repeat(2800) } }), /^Error: 系统提示词太长，存不下/);
  assert.strictEqual(JSON.stringify(importSync), before);

  // A setting past sync's 8 KB per item is named before Chrome refuses it in English: 2700 汉字 fit, 2800 do not.
  const tooLong = (n) => vm.runInContext(`oversizedSyncItem({ tags: "a", aiSystemPrompt: "字".repeat(${n}) })`, ctx);
  assert.deepStrictEqual([tooLong(2700), tooLong(2800)], ["", "aiSystemPrompt"]);

  // 测试连接 on the settings page reports with the words every Obsidian write uses.
  const E = ctx.MdgErrors.TEXT;
  const probe = async (fetch) => ((ctx.fetch = fetch), ctx.testObsidianConnection("http://127.0.0.1:27123", "k"));
  const reply = (status, body) => async () => ({ ok: status < 300, status, json: async () => body });
  assert.strictEqual((await probe(reply(401, null))).error, E.obsidianKey);
  assert.strictEqual((await probe(reply(403, null))).error, E.obsidianKey);
  assert.strictEqual((await probe(reply(200, { authenticated: false }))).error, E.obsidianKey);
  assert.strictEqual((await probe(reply(500, null))).error, "Obsidian 返回 HTTP 500");
  // The same 404 as a note's write and the pre-run check: a wrong address, with 去设置's code.
  assert.deepStrictEqual({ ...(await probe(reply(404, null))) }, { ok: false, error: E.obsidianNotFound, code: "OBSIDIAN" });
  const down = await probe(async () => { throw new TypeError("Failed to fetch"); });
  assert.ok(down.error.startsWith(E.obsidianDown) && /证书/.test(down.error), down.error);
  assert.deepStrictEqual({ ...(await probe(reply(200, { authenticated: true, service: "S" }))) }, { ok: true, service: "S" });

  // An install or update re-injects into open tabs: the reader into the top frame, the B站 marks into every frame,
  // each with the manifest entry's own files.
  {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "manifest.json"), "utf8"));
    const injected = [];
    const installed = [];
    const onMessage = [];
    const stored = [];
    const sentTo = [];
    const tabsByMatch = { "https://www.bilibili.com/video/*": [{ id: 1 }], "https://www.bilibili.com/*": [{ id: 1 }, { id: 2 }] };
    const fake = (over) => new Proxy(over, { get: (o, k) => (k in o ? o[k] : anything) });
    const ictx = vm.createContext({
      console, setTimeout, clearTimeout, URL, URLSearchParams, TextDecoder, TextEncoder, AbortController, AbortSignal,
      chrome: fake({
        runtime: fake({ getManifest: () => manifest, lastError: undefined, onInstalled: { addListener: (fn) => installed.push(fn) }, onMessage: { addListener: (fn) => onMessage.push(fn) } }),
        tabs: fake({
          query: async ({ url }) => [...new Map(url.flatMap((u) => tabsByMatch[u] || []).map((t) => [t.id, t])).values()],
          get: async (id) => ({ id, url: "chrome-extension://x/triage/triage.html" }),
          sendMessage: (tabId, message, options, cb) => (sentTo.push([tabId, message, options]), cb({ ok: true, payload: { site: "bilibili", videoId: "BV1xx411c7mD", pageIndex: 1, url: "https://www.bilibili.com/video/BV1xx411c7mD/?mdg_reader=1", subtitleMarkdown: "picked" } }))
        }),
        sidePanel: fake({ open: async () => {} }),
        storage: fake({ local: fake({ set: async (o) => stored.push(o) }) }),
        scripting: fake({
          insertCSS: async ({ target, files }) => injected.push(["css", target.tabId, Boolean(target.allFrames), files.join()]),
          executeScript: async ({ target, files }) => injected.push(["js", target.tabId, Boolean(target.allFrames), files.at(-1)])
        })
      }),
      importScripts: (...files) => files.forEach((file) => vm.runInContext(fs.readFileSync(path.join(__dirname, file), "utf8"), ictx))
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, "background.js"), "utf8"), ictx);
    ictx.migrateRenamedStorage = async () => {};
    ictx.initializeSettingsStorage = async () => {};
    await Promise.allSettled(installed.map((fn) => fn()));
    const sorted = (list) => list.map(String).sort();
    assert.deepStrictEqual(sorted(injected), sorted([
      ["css", 1, false, "content.css"], ["js", 1, false, "content.js"],
      ["css", 1, true, "badges.css"], ["js", 1, true, "badges.js"],
      ["css", 2, true, "badges.css"], ["js", 2, true, "badges.js"]
    ]));

    // 分拣台's viewer: AI 总结 from it hands the side panel the frame with the video, and the panel's read goes to that
    // frame's content script like a video page's (sidepanel-get-context), naming the video so another one does not answer.
    ictx.getMergedSettings = async () => ({ enablePlayerAiQuickAction: true, playerAiQuickPrompt: "" });
    const contextRef = { site: "bilibili", videoId: "BV1xx411c7mD" };
    await new Promise((resolve) => onMessage.forEach((fn) => fn({ type: "player-ai-quick-action", contextRef }, { tab: { id: 7 }, frameId: 3 }, resolve)));
    const request = Object.values(stored.at(-1))[0];
    assert.deepStrictEqual([request.tabId, request.frameId, request.contextRef], [7, 3, contextRef]);
    const reply = await new Promise((resolve) => onMessage.forEach((fn) => fn({ type: "ai-sidepanel-get-state", tabId: 7, frameId: 3, videoId: "BV1xx411c7mD" }, {}, resolve)));
    assert.deepStrictEqual(JSON.parse(JSON.stringify(sentTo)), [[7, { type: "sidepanel-get-context", refresh: false, videoId: "BV1xx411c7mD" }, { frameId: 3 }]]);
    assert.deepStrictEqual([reply.ok, reply.payload.subtitleMarkdown, reply.payload.url, reply.payload.isVideoContext], [true, "picked", "https://www.bilibili.com/video/BV1xx411c7mD/", true]);
    // The side panel's 刷新 is refresh on both messages (popup-refresh too), never force / forceRefresh.
    sentTo.length = 0;
    await new Promise((resolve) => onMessage.forEach((fn) => fn({ type: "ai-sidepanel-get-state", tabId: 7, frameId: 3, videoId: "BV1xx411c7mD", refresh: true }, {}, resolve)));
    assert.strictEqual(sentTo[0][1].refresh, true);
    // The ✦ AI 总结按钮 switch stops only the player button (no source); 专注模式 (reader) and the popup still open AI 总结.
    ictx.getMergedSettings = async () => ({ enablePlayerAiQuickAction: false, playerAiQuickPrompt: "" });
    const quick = (source) => new Promise((resolve) => onMessage.forEach((fn) => fn({ type: "player-ai-quick-action", ...(source && { source }) }, { tab: { id: 7 } }, resolve)));
    assert.deepStrictEqual([(await quick()).error, (await quick("reader")).ok, (await quick("popup")).ok], ["✦ AI 总结按钮未开启", true, true]);
    // 视频记录 opens through the same one-tab rule as 分拣台.
    const opened = [];
    ictx.focusOrOpenPage = async (page) => opened.push(page);
    ictx.chrome.runtime.getURL = (p) => `chrome-extension://x/${p}`;
    assert.ok((await new Promise((resolve) => onMessage.forEach((fn) => fn({ type: "history-open" }, {}, resolve)))).ok);
    assert.deepStrictEqual(opened, ["chrome-extension://x/history/history.html"]);
    for (const f of ["popup.js", "sidepanel.js", "content.js", "background.js"]) assert.ok(!/forceRefresh|message\.force\b|"popup-refresh", force\b/.test(fs.readFileSync(path.join(__dirname, f), "utf8")), `${f}: the refresh flag is named refresh`);
    for (const f of ["popup.js", "sidepanel.js", "options.js"]) assert.ok(fs.readFileSync(path.join(__dirname, f), "utf8").includes('"history-open"'), `${f} opens 视频记录 by history-open`);
  }

  finished = true;
  clearInterval(keepAlive);
  console.log("background selftest: all passed");
})();
