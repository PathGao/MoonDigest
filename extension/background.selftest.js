// node extension/background.selftest.js
if (process.versions.bun) (console.error("This selftest needs Node: it fails or hangs under bun (see 自检 in README.md)."), process.exit(1));
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");
const PS = require("./page-sources.selftest.js");

let onConnect;
const onMessage = [];
const anything = new Proxy(function () {}, { get: () => anything, apply: () => anything });
const runtime = new Proxy({}, {
  get: (_, k) =>
    k === "onConnect" ? { addListener: (fn) => (onConnect = fn) } : k === "onMessage" ? { addListener: (fn) => onMessage.push(fn) } : k === "getURL" ? (p) => `chrome-extension://me/${p}` : anything
});
// A runtime message as a page sends it (the side panel by default): the first listener that keeps the channel open answers.
const PANEL = { url: "chrome-extension://me/sidepanel.html" };
const ask = (message, sender = PANEL) => new Promise((resolve) => onMessage.some((fn) => fn(message, sender, resolve) === true));
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
  assert.doesNotMatch(PS.text(PS.own("background.js")), /简介前\d|≤\d+字、不含逗号/, "a prompt writes a limit itself");
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
      sender: { url: "chrome-extension://me/sidepanel.html" },
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

  // J16: a connection that drops mid-reply (a TypeError from the body) is a stall too: the platform did answer.
  {
    const dropping = streamingFetch([{ after: 0, chunk: sse({ content: "半句" }) }]);
    ctx.fetch = async (url, init) => {
      const resp = await dropping(url, init);
      const reader = resp.body.getReader();
      let reads = 0;
      resp.body.getReader = () => ({ read: () => (reads++ ? Promise.reject(new (vm.runInContext("TypeError", ctx))("network error")) : reader.read()) });
      return resp;
    };
    out = await chat();
    assert.deepStrictEqual([out.at(-1).type, out.at(-1).error, out.at(-1).code], ["error", ctx.MdgErrors.TEXT.aiDropped, "AI_STALLED"]);
  }

  // J17: a failed page-ref resolve passes its code, so the side panel stops asking about a gone video.
  {
    const realResolve = ctx.resolveAiSidepanelPageRef;
    ctx.resolveAiSidepanelPageRef = async () => {
      throw Object.assign(new Error(ctx.MdgErrors.LABEL.videoGone), { code: -404 });
    };
    assert.deepStrictEqual({ ...(await ask({ type: "ai-sidepanel-resolve-page-ref", contextRef: {} })) }, { ok: false, error: ctx.MdgErrors.LABEL.videoGone, code: -404 });
    ctx.resolveAiSidepanelPageRef = realResolve;
  }

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
  // F8: an AI Key pasted with its 「Bearer 」 goes out as one Bearer, like the Obsidian Key (MdgSettings.normalizeApiKey).
  {
    const auth = [];
    ctx.fetch = async (u, init) => (auth.push(init.headers.Authorization), { ok: true });
    await ctx.probeAiChatCompletion({ baseUrl: "https://ai.test", apiKey: "Bearer sk-1", model: "m" });
    assert.deepStrictEqual(auth, ["Bearer sk-1"]);
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

  // The chat port, message by message: fn is the background's listener, disconnect the panel going away.
  ctx.chrome = chrome;
  const openPort = (postMessage) => {
    const port = { name: "sidepanel-chat", sender: PANEL, out: [], fn: null, disconnect: null, postMessage: postMessage || ((m) => port.out.push(m)) };
    port.onMessage = { addListener: (f) => (port.fn = f) };
    port.onDisconnect = { addListener: (f) => (port.disconnect = f) };
    onConnect(port);
    return port;
  };
  const CHAT = { action: "chat", providerId: "p", prompt: "q", context: { isVideoContext: true, subtitleMarkdown: "字幕" } };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const stalling = () => (url, { signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(abortError())));
  // Gap 9c: two chats on one port: the first's end does not disarm the second (its 停止 still aborts it).
  {
    const port = openPort();
    ctx.fetch = stalling();
    const first = port.fn(CHAT);
    await wait(5);
    ctx.fetch = streamingFetch([{ after: 5, chunk: sse({ content: "a" }) }, { after: 200, chunk: sse({ content: "b" }) }, { after: 0, done: true }]);
    const second = port.fn(CHAT);
    await first;
    await wait(20);
    port.fn({ action: "stop" });
    await second;
    assert.deepStrictEqual(port.out.map((m) => m.type), ["token", "stopped"]);
  }
  // Gap 9a, 9b: the panel closed while the platforms were read: no request goes out, and nothing is thrown at a port
  // nobody listens to (an answer to a closed port is swallowed, not rethrown out of the listener).
  {
    const dead = () => {
      throw new Error("Attempting to use a disconnected port object");
    };
    const port = openPort(dead);
    let release;
    const was = ctx.loadAiProviders;
    ctx.loadAiProviders = () => new Promise((r) => (release = r));
    let fetched = 0;
    ctx.fetch = async () => (fetched++, { ok: true, body: null });
    const chat = port.fn(CHAT);
    port.disconnect();
    release([{ id: "p", baseUrl: "https://ai.test", model: "m", requiresKey: false }]);
    await assert.doesNotReject(chat);
    assert.strictEqual(fetched, 0, "the request is not sent after the panel closed");
    ctx.loadAiProviders = async () => [];
    await assert.doesNotReject(openPort(dead).fn(CHAT), "no provider: the error has nowhere to go");
    ctx.loadAiProviders = was;
  }
  // Gap 2: a reply the panel left to its conversation (detach) outlives the panel: the port closing no longer aborts
  // it, and the answer goes into that conversation by id as the panel would have put it; a conversation deleted
  // meanwhile gets nothing. 停止 before the port closes (a delete) still aborts it, and the worker is pinged only while
  // such a reply runs.
  {
    const wasChrome = ctx.chrome;
    const conv = (id) => ({ id, messages: [{ role: "user", content: "q" }], updatedAt: 1 });
    const store = { [ctx.MdgLimits.KEYS.aiConversations]: ["c1", "c2", "c3", "c4", "c5", "c6", "c7", "c9"].map(conv).concat([{ id: "c8", messages: [{ role: "user", content: "q0" }, { role: "assistant", content: "a0" }], updatedAt: 1 }]) };
    const stored = (id) => store[ctx.MdgLimits.KEYS.aiConversations].find((c) => c.id === id).messages;
    const pings = [];
    const timers = [];
    ctx.chrome = { runtime: { getURL: (p) => `chrome-extension://me/${p}`, getPlatformInfo: () => pings.push(1) }, storage: { local: area(store) } };
    const realInterval = [ctx.setInterval, ctx.clearInterval];
    ctx.setInterval = (fn) => (timers.push(fn), timers.length);
    ctx.clearInterval = (id) => (timers[id - 1] = null);
    const slowReply = () => streamingFetch([{ after: 5, chunk: sse({ content: "答" }) }, { after: 30, chunk: sse({ content: "案" }) }, { after: 0, done: true }]);
    // Finished after the panel closed: written into c1.
    let port = openPort();
    ctx.fetch = slowReply();
    let chat = port.fn(CHAT);
    port.fn({ action: "detach", conversationId: "c1", promptIndex: 0 });
    await wait(10);
    port.disconnect();
    assert.strictEqual(timers.filter(Boolean).length, 1, "pinged while the orphaned reply runs");
    await chat;
    assert.deepStrictEqual(store[ctx.MdgLimits.KEYS.aiConversations].find((c) => c.id === "c1").messages, [{ role: "user", content: "q" }, { role: "assistant", content: "答案" }]);
    assert.strictEqual(timers.filter(Boolean).length, 0, "the ping stops with it");
    // Deleted meanwhile: nothing written, the list otherwise untouched.
    port = openPort();
    ctx.fetch = slowReply();
    chat = port.fn(CHAT);
    port.fn({ action: "detach", conversationId: "gone", promptIndex: 0 });
    await wait(10);
    port.disconnect();
    await chat;
    assert.deepStrictEqual(store[ctx.MdgLimits.KEYS.aiConversations].map((c) => c.id), ["c1", "c2", "c3", "c4", "c5", "c6", "c7", "c9", "c8"]);
    // 停止, then the port closes (the panel deleted the conversation): aborted, nothing written.
    port = openPort();
    ctx.fetch = stalling();
    chat = port.fn(CHAT);
    port.fn({ action: "detach", conversationId: "c2", promptIndex: 0 });
    await wait(10);
    port.fn({ action: "stop" });
    port.disconnect();
    await chat;
    assert.deepStrictEqual([store[ctx.MdgLimits.KEYS.aiConversations].find((c) => c.id === "c2").messages.length, port.out.at(-1).type], [1, "stopped"]);
    // Not detached (the question was never saved): the port closing aborts, as before.
    port = openPort();
    let aborted = false;
    ctx.fetch = (url, { signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => ((aborted = true), reject(abortError()))));
    chat = port.fn(CHAT);
    await wait(10);
    port.disconnect();
    await chat;
    assert.deepStrictEqual([aborted, timers.filter(Boolean).length], [true, 0]);
    // F1: a detached reply that ended while the panel was still open is no orphan when the port closes afterwards:
    // nothing is pinged, and the panel's own write (not here) keeps the answer.
    port = openPort();
    ctx.fetch = slowReply();
    chat = port.fn(CHAT);
    port.fn({ action: "detach", conversationId: "c3", promptIndex: 0 });
    await chat;
    port.disconnect();
    await wait(5);
    assert.deepStrictEqual([timers.filter(Boolean).length, stored("c3").length], [0, 1]);
    // F2: an orphaned reply that fails midway keeps what came, as the panel does; one that fails before a word takes
    // its question away, so the conversation never ends in two questions in a row.
    port = openPort();
    ctx.fetch = streamingFetch([{ after: 5, chunk: sse({ content: "半" }) }]);
    chat = port.fn(CHAT);
    port.fn({ action: "detach", conversationId: "c4", promptIndex: 0 });
    await wait(10);
    port.disconnect();
    await chat;
    assert.deepStrictEqual(stored("c4"), [{ role: "user", content: "q" }, { role: "assistant", content: "半" }], "the stalled reply's half");
    port = openPort();
    ctx.fetch = async () => ({ ok: false, status: 401, text: async () => "" });
    chat = port.fn(CHAT);
    port.fn({ action: "detach", conversationId: "c5", promptIndex: 0 });
    port.disconnect();
    await chat;
    assert.deepStrictEqual([stored("c5"), timers.filter(Boolean).length], [[], 0], "no answer: the question goes, the ping stops");
    // Closed while the reply was shown (no detach, so the question is not stored): the chat message named the
    // conversation and the question's place from the start, so the question and the answer both go in. On the first
    // question of a conversation not saved yet, the conversation is created as the panel would save it; nothing is
    // created when no answer came. 停止 before the port closes still aborts and writes nothing.
    port = openPort();
    ctx.fetch = slowReply();
    chat = port.fn({ ...CHAT, reply: { conversationId: "c8", promptIndex: 2 } });
    await wait(10);
    port.disconnect();
    await chat;
    assert.deepStrictEqual(stored("c8"), [{ role: "user", content: "q0" }, { role: "assistant", content: "a0" }, { role: "user", content: "q" }, { role: "assistant", content: "答案" }]);
    const record = { id: "new1", title: "T", contextKey: "video:bilibili:BV1n|c", contextTitle: "T", contextUrl: "https://www.bilibili.com/video/BV1n/", isVideoContext: true, createdAt: 2, updatedAt: 2, contextRef: { site: "bilibili", videoId: "BV1n" }, pageHydrated: false, messages: [{ role: "user", content: "q" }] };
    port = openPort();
    ctx.fetch = slowReply();
    chat = port.fn({ ...CHAT, reply: { conversationId: "new1", promptIndex: 0, record } });
    await wait(10);
    port.disconnect();
    await chat;
    const made = store[ctx.MdgLimits.KEYS.aiConversations].find((c) => c.id === "new1");
    assert.deepStrictEqual([made.title, made.contextKey, made.messages], ["T", record.contextKey, [{ role: "user", content: "q" }, { role: "assistant", content: "答案" }]]);
    port = openPort();
    ctx.fetch = async () => ({ ok: false, status: 401, text: async () => "" });
    chat = port.fn({ ...CHAT, reply: { conversationId: "new2", promptIndex: 0, record: { ...record, id: "new2" } } });
    port.disconnect();
    await chat;
    assert.strictEqual(store[ctx.MdgLimits.KEYS.aiConversations].some((c) => c.id === "new2"), false, "no answer: no conversation");
    port = openPort();
    ctx.fetch = stalling();
    chat = port.fn({ ...CHAT, reply: { conversationId: "c9", promptIndex: 1 } });
    await wait(10);
    port.fn({ action: "stop" });
    port.disconnect();
    await chat;
    assert.deepStrictEqual([stored("c9").length, timers.filter(Boolean).length], [1, 0], "停止 then close: aborted, nothing written");
    // Attach: a reopened panel asks which replies still run, attaches to one by id, gets what comes from now on and
    // 停止 ends it; while attached nothing is pinged (its port keeps the worker). The end is still written here.
    port = openPort();
    ctx.fetch = streamingFetch([{ after: 5, chunk: sse({ content: "一" }) }, { after: 40, chunk: sse({ content: "二" }) }, { after: 300, chunk: sse({ content: "三" }) }, { after: 0, done: true }]);
    chat = port.fn(CHAT);
    port.fn({ action: "detach", conversationId: "c6", promptIndex: 0 });
    await wait(15);
    port.disconnect();
    assert.deepStrictEqual(JSON.parse(JSON.stringify((await ask({ type: "ai-replies-running" })).replies)), [{ conversationId: "c6", promptIndex: 0 }]);
    const again = openPort();
    again.fn({ action: "attach", conversationId: "c6" });
    assert.strictEqual(timers.filter(Boolean).length, 0, "attached: no ping");
    await wait(50);
    assert.deepStrictEqual(again.out.map((m) => m.data), ["二"], "only what came after the attach");
    again.fn({ action: "stop" });
    await chat;
    assert.deepStrictEqual([again.out.at(-1).type, stored("c6")], ["stopped", [{ role: "user", content: "q" }, { role: "assistant", content: "一二" }]]);
    assert.deepStrictEqual(JSON.parse(JSON.stringify((await ask({ type: "ai-replies-running" })).replies)), [], "ended: no longer listed");
    // Nothing to attach to (ended, or never orphaned): done at once. An attached panel closing orphans the reply again.
    const none = openPort();
    none.fn({ action: "attach", conversationId: "c6" });
    assert.deepStrictEqual(none.out.map((m) => m.type), ["done"]);
    port = openPort();
    ctx.fetch = streamingFetch([{ after: 5, chunk: sse({ content: "甲" }) }, { after: 30, chunk: sse({ content: "乙" }) }, { after: 0, done: true }]);
    chat = port.fn(CHAT);
    port.fn({ action: "detach", conversationId: "c7", promptIndex: 0 });
    await wait(15);
    port.disconnect();
    const brief = openPort();
    brief.fn({ action: "attach", conversationId: "c7" });
    brief.disconnect();
    assert.strictEqual(timers.filter(Boolean).length, 1, "orphaned again: pinged again");
    await chat;
    assert.deepStrictEqual([stored("c7"), timers.filter(Boolean).length, brief.out], [[{ role: "user", content: "q" }, { role: "assistant", content: "甲乙" }], 0, []]);
    [ctx.setInterval, ctx.clearInterval] = realInterval;
    ctx.chrome = wasChrome;
  }

  // C13: a fresh install writes no defaults into sync (only the Obsidian switch's one-time migration); reading fills
  // them in, so a default changed later reaches everyone who never set it.
  const fresh = {};
  init = install(fresh);
  await init();
  assert.deepStrictEqual(fresh, { obsidianEnabled: false });
  const read = await ctx.getMergedSettings();
  assert.deepStrictEqual([[...read.aiPresetPrompts], read.playerAiQuickPrompt], [[...ctx.MdgSettings.DEFAULTS.aiPresetPrompts], ctx.MdgSettings.DEFAULTS.playerAiQuickPrompt]);

  // Saving a partial payload (the options page has no reading-view controls) keeps every key it omits.
  const stored = { readerTheme: "dark", readerFontScale: "l", aiPresetPrompts: ["a"] };
  ctx.chrome = { runtime: { getURL: (p) => `chrome-extension://me/${p}` }, storage: { sync: area(stored), local: area({ obsidianApiKey: "k" }) } };
  await ctx.saveSettings({ aiPresetPrompts: [], noteFolder: "N" });
  assert.strictEqual(stored.readerTheme, "dark");
  assert.strictEqual(stored.readerFontScale, "l");
  assert.deepStrictEqual(stored.aiPresetPrompts, []);
  assert.strictEqual(stored.noteFolder, "N");
  assert.strictEqual((await ctx.chrome.storage.local.get("obsidianApiKey")).obsidianApiKey, "k");
  // Two pages saving different settings at once: each writes only its own keys, so neither reverts the other.
  await Promise.all([ctx.saveSettings({ readerTheme: "light" }), ctx.saveSettings({ noteFolder: "M" })]);
  assert.deepStrictEqual([stored.readerTheme, stored.noteFolder], ["light", "M"]);
  // Gap 13: a save during an import waits for it, so the import's remove of the keys its file lacks never drops what
  // the save wrote. The import's first write is held to open the window.
  {
    const data = { readerTheme: "light" };
    let release;
    const held = area(data);
    const plainSet = held.set.bind(held);
    held.set = (o) => ("noteFolder" in o && release === undefined ? new Promise((r) => (release = () => r(plainSet(o)))) : plainSet(o));
    ctx.chrome = { runtime: { getURL: (p) => `chrome-extension://me/${p}` }, storage: { sync: held, local: area({}) } };
    const wasInit = ctx.initializeSettingsStorage;
    ctx.initializeSettingsStorage = async () => {};
    const importing = ctx.importSettings({ app: "moondigest", kind: "settings", schemaVersion: 1, settings: { noteFolder: "F" } });
    await new Promise((r) => setTimeout(r, 5));
    const saving = ctx.saveSettings({ readerTheme: "dark" });
    await new Promise((r) => setTimeout(r, 5));
    release();
    await Promise.all([importing, saving]);
    assert.deepStrictEqual(data, { noteFolder: "F", readerTheme: "dark" });
    ctx.initializeSettingsStorage = wasInit;
  }
  // An imported file's frontmatterFields that is not a list reads as the default (the settings page maps over it).
  assert.deepStrictEqual([...ctx.MdgSettings.normalizeSyncSettings({ frontmatterFields: "title" }).frontmatterFields], [...ctx.MdgSettings.DEFAULTS.frontmatterFields]);

  // C17: the saved and read settings go through MdgSettings.normalizeSwitches: a non-boolean keeps a default-on switch on.
  {
    const n = ctx.MdgSettings.normalizeSyncSettings({ enablePlayerAiQuickAction: "true", includeDateInFilename: 1, includeTimestampInBody: "yes", obsidianEnabled: "true" });
    assert.deepStrictEqual([n.enablePlayerAiQuickAction, n.includeDateInFilename, n.includeTimestampInBody, n.obsidianEnabled], [true, true, true, false]);
  }

  // 看多少算看完了 (1–100): empty, not a number, 0 or negative is 80; above 100 is 100.
  for (const [input, want] of [[0, 80], [-5, 80], [1, 1], ["150", 100], [42.4, 42], [undefined, 80], ["", 80], ["x", 80]]) {
    assert.strictEqual(ctx.MdgSettings.normalizeSyncSettings({ seenThreshold: input }).seenThreshold, want);
  }

  const systemFor = (extra) =>
    ctx.buildAiMessages({ context: { isVideoContext: true, title: "T", description: "简介", ...extra }, userPrompt: "q" }).messages[0].content;
  const none = systemFor({});
  // The shared sentence (MdgErrors.subtitleMissing), told to the user too, like the login and failure branches.
  assert.match(none, /^视频没有字幕。你拿不到/m);
  assert.match(none, /告诉用户：视频没有字幕。/);
  assert.doesNotMatch(none, /抓取失败/);
  const failed = systemFor({ subtitleFailure: "YouTube 拒绝了字幕请求" });
  assert.match(failed, /字幕抓取失败：YouTube 拒绝了字幕请求。/);
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

  // A web page (isVideoContext false): a reading assistant over its main text, never the subtitle wording; a long body is
  // sampled like a long subtitle and the user is told 正文过长.
  const pageCtx = { isVideoContext: false, title: "文章", author: "作者", published: "2026-01-02", siteName: "example.com", pageMarkdown: "## 一节\n\n正文内容", pageAccess: "ready" };
  const pageAsk = ctx.buildAiMessages({ context: pageCtx, userPrompt: "q", systemPrompt: "自定义要求" });
  const pageSystem = pageAsk.messages[0].content;
  assert.match(pageSystem, /^你是一个阅读助手。当前用户正在读一个网页，标题：「文章」/);
  assert.match(pageSystem, /作者：作者 \| 发布日期：2026-01-02 \| 网站：example\.com/);
  assert.match(pageSystem, /以下是网页正文（Markdown）：\n\n## 一节\n\n正文内容/);
  assert.match(pageSystem, /以下是额外系统要求：\n自定义要求/);
  assert.doesNotMatch(pageSystem, /字幕|评论|视频/);
  assert.deepStrictEqual([...pageAsk.notices], []);
  // The system prompt goes as the side panel sent it (the set of the context's kind), never swapped here.
  const { webAiSystemPrompt, aiSystemPrompt } = ctx.MdgSettings.DEFAULTS;
  const pageDefault = ctx.buildAiMessages({ context: pageCtx, userPrompt: "q", systemPrompt: webAiSystemPrompt }).messages[0].content;
  assert.ok(pageDefault.endsWith(`以下是额外系统要求：\n${webAiSystemPrompt}`), pageDefault);
  assert.doesNotMatch(webAiSystemPrompt, /字幕|视频|时间戳/, "the web default is written for pages");
  assert.ok(ctx.buildAiMessages({ context: pageCtx, userPrompt: "q", systemPrompt: aiSystemPrompt }).messages[0].content.endsWith(aiSystemPrompt), "no swap: what was sent is used");
  assert.ok(ctx.buildAiMessages({ context: { isVideoContext: true, subtitleMarkdown: "字幕" }, userPrompt: "q", systemPrompt: aiSystemPrompt }).messages[0].content.endsWith(aiSystemPrompt));
  // The web set is normalized like the video set: trimmed, 快捷追问 deduplicated and capped, missing ones defaulted.
  const norm = ctx.MdgSettings.normalizeSyncSettings({ ...ctx.MdgSettings.DEFAULTS, webAiSystemPrompt: "  规则  ", webAiSummaryPrompt: " 总结 ", webAiPresetPrompts: ["a", "a", " ", ...Array.from({ length: 20 }, (_, i) => `q${i}`)] });
  assert.deepStrictEqual([norm.webAiSystemPrompt, norm.webAiSummaryPrompt, norm.webAiPresetPrompts.length, norm.webAiPresetPrompts[0]], ["规则", "总结", ctx.MdgSettings.MAX_PRESET_PROMPTS, "a"]);
  assert.deepStrictEqual([...ctx.MdgSettings.normalizeSyncSettings({ ...ctx.MdgSettings.DEFAULTS, webAiPresetPrompts: "x" }).webAiPresetPrompts], []);
  assert.throws(() => ctx.checkSyncItems({ webAiSystemPrompt: "字".repeat(3000) }), /网页的系统提示词太长/);
  const longPage = ctx.buildAiMessages({ context: { ...pageCtx, pageMarkdown: Array.from({ length: 4000 }, (_, i) => `第 ${i} 行 ${"字".repeat(40)}`).join("\n") }, userPrompt: "q" });
  assert.ok(longPage.messages[0].content.length < 62000);
  assert.match(longPage.messages[0].content, /全文过长，均匀抽取了约 1\/\d+ 的行/);
  assert.deepStrictEqual([...longPage.notices].map((n) => n.replace(/\d+$/, "N")), ["正文过长，只发送了均匀抽取的约 1/N"]);

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
  // An answer cut at the output limit (finish_reason length) keeps its tokens and ends in 分拣台's AI_TRUNCATED, with
  // [DONE], without it, and as one plain completion; the table's remedies for it are the panel's 重试.
  const cut = { error: ctx.MdgErrors.TEXT.aiTruncated, code: "AI_TRUNCATED" };
  const lengthEnd = `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "length" }] })}\n\n`;
  for (const tail of [[raw(lengthEnd), raw("data: [DONE]\n\n")], [raw(lengthEnd)]]) {
    ctx.fetch = streamingFetch([{ after: 0, chunk: sse({ content: "半句" }) }, ...tail, { after: 0, done: true }]);
    assert.deepStrictEqual((await chat()).map((m) => m.data || `${m.type} ${m.error} ${m.code}`), ["半句", `error ${cut.error} ${cut.code}`]);
  }
  ctx.fetch = streamingFetch([raw(JSON.stringify({ choices: [{ message: { content: "整段" }, finish_reason: "length" }] })), { after: 0, done: true }]);
  assert.deepStrictEqual((await chat()).map((m) => m.data || `${m.type} ${m.error} ${m.code}`), ["整段", `error ${cut.error} ${cut.code}`]);
  assert.deepStrictEqual([...ctx.MdgErrors.remedies("AI_TRUNCATED")], ["retry"]);
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

  // A B站 or YouTube page's script (a hijacked renderer too) gets only the types content.js sends: it cannot send a saved
  // AI key to an address of its choice (ai-providers-test), save settings other than 专注模式's, or read the Obsidian key.
  {
    const web = { tab: { id: 5 }, url: "https://www.bilibili.com/video/BV1" };
    const was = { chrome: ctx.chrome, test: ctx.testAiConnection, keys: ctx.loadAiProviderKeys, settings: ctx.getMergedSettings };
    const tested = [];
    const written = [];
    ctx.testAiConnection = async (args) => (tested.push(args), { ok: true });
    ctx.loadAiProviderKeys = async () => ({ p: "saved-key" });
    ctx.getMergedSettings = async () => ({ readerTheme: "light", obsidianApiKey: "vault-key" });
    ctx.chrome = { runtime: { getURL: (p) => `chrome-extension://me/${p}` }, storage: { sync: { set: async (o) => written.push(o) }, local: { set: async (o) => written.push(o) } } };
    const probe = { type: "ai-providers-test", providerId: "p", baseUrl: "https://evil.example/v1", model: "m" };
    assert.deepStrictEqual({ ...(await ask(probe, web)) }, { ok: false, error: "网页不能发送 ai-providers-test" });
    assert.deepStrictEqual(tested, [], "the key never leaves");
    assert.deepStrictEqual({ ...(await ask(probe)) }, { ok: true }, "the settings page's 测试连接 still works");
    assert.deepStrictEqual([tested[0].apiKey, tested[0].baseUrl], ["saved-key", "https://evil.example/v1"]);
    for (const type of ["settings-import", "ai-providers-save", "ai-providers-delete", "test-obsidian-connection", "ai-sidepanel-get-state", "popup-page-note"]) {
      assert.strictEqual((await ask({ type }, web)).error, `网页不能发送 ${type}`, type);
    }
    assert.match((await ask({ type: "save-settings", settings: { readerTheme: "dark", obsidianBaseUrl: "https://evil.example" } }, web)).error, /专注模式/);
    assert.deepStrictEqual(written, []);
    assert.deepStrictEqual({ ...(await ask({ type: "save-settings", settings: { readerTheme: "dark" } }, web)) }, { ok: true }, "专注模式's look from the video page");
    assert.deepStrictEqual({ ...(await ask({ type: "save-settings", settings: { obsidianBaseUrl: "http://127.0.0.1:27123" } })) }, { ok: true }, "any setting from the settings page");
    assert.deepStrictEqual(written.map((o) => Object.keys(o).join()), ["readerTheme", "obsidianBaseUrl"]);
    assert.ok(!("obsidianApiKey" in (await ask({ type: "get-settings" }, web)).settings), "a video page does not get the Obsidian key");
    assert.strictEqual((await ask({ type: "get-settings" })).settings.obsidianApiKey, "vault-key");
    // What content.js sends still reaches its handler (an answer other than the refusal; fetch-json's own URL check).
    assert.deepStrictEqual({ ...(await ask({ type: "fetch-json", url: "https://evil.example/" }, web)) }, { ok: false, error: "URL not allowed" });
    // obsidian.js's: the video page writes its note; exporting one (a remembered note's text) and syncing the side
    // panel's AI section are the extension pages'.
    for (const type of ["export-note", "sync-video-note-ai"]) assert.strictEqual((await ask({ type }, web)).error, `网页不能发送 ${type}`, type);
    // The side panel's chat port: a page's script is disconnected before anything is read or sent.
    {
      const seen = [];
      const port = { name: "sidepanel-chat", sender: web, disconnect: () => seen.push("disconnect"), onDisconnect: { addListener: () => seen.push("listen") }, onMessage: { addListener: () => seen.push("listen") }, postMessage: (m) => seen.push(m) };
      onConnect(port);
      assert.deepStrictEqual(seen, ["disconnect"]);
    }
    for (const type of ["open-options", "player-ai-quick-action", "page-player", "write-video-note"]) {
      let refused = null;
      const kept = onMessage.some((fn) => fn({ type }, web, (r) => (refused = r)) === true);
      assert.ok(kept && !refused, `${type} from a video page`);
    }
    // 分拣台's viewer frame on a 番剧 asks for the video itself (ref): the episode's aid makes its BV id.
    {
      ctx.chrome = { scripting: { executeScript: async () => [{ result: { aid: 170001, cid: 2, episodeId: 397236 } }] } };
      // sender.url is where the frame loaded; ref is where B站's pushState took it, the episode the player now has.
      const ep = { tab: { id: 5 }, frameId: 3, url: "https://www.bilibili.com/bangumi/play/ep1" };
      assert.strictEqual((await ask({ type: "page-player", ref: "https://www.bilibili.com/bangumi/play/ep397236" }, ep)).data.id, "BV17x411w7KC");
      assert.strictEqual((await ask({ type: "page-player", ref: "https://www.bilibili.com/bangumi/play/ep1" }, ep)).data, null, "not this episode yet");
      assert.strictEqual((await ask({ type: "page-player" }, ep)).data.aid, 170001, "content.js still gets the manifest");
    }
    Object.assign(ctx, { chrome: was.chrome, testAiConnection: was.test, loadAiProviderKeys: was.keys, getMergedSettings: was.settings });
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

  // K5: a page the content script cannot be put into: the one sentence of a page that did not answer, which says to
  // reload, and code PAGE_SILENT, so no entry offers a 重试 that fails alike.
  {
    const was = [ctx.chrome, ctx.injectReaderContent];
    ctx.chrome = { scripting: { executeScript: async () => [{ result: "old" }] } };
    ctx.injectReaderContent = async () => {};
    await assert.rejects(ctx.ensureReaderContentReady(1), (e) => e.message === ctx.MdgErrors.TEXT.pageSilent && e.code === "PAGE_SILENT");
    // A15: Chrome's error page refuses the injection; the reason stays ours, not Chrome's English.
    ctx.injectReaderContent = async () => {
      throw new Error("Frame with ID 0 is showing error page");
    };
    await assert.rejects(ctx.ensureReaderContentReady(1), (e) => e.message === ctx.MdgErrors.TEXT.pageSilent && e.code === "PAGE_SILENT");
    [ctx.chrome, ctx.injectReaderContent] = was;
  }

  // A web page (readWebPage): its one pageAccess state, the main text read on demand, the bundle injected once.
  {
    const was = ctx.chrome;
    let granted = false;
    let loaded = false;
    let page = { title: "文章", author: "作者", published: "2026-01-02", site: "", wordCount: 3, content: "正文" };
    let refuse = false;
    const calls = [];
    ctx.chrome = {
      runtime: { getURL: (p) => `chrome-extension://me/${p}` },
      tabs: { get: async (id) => ({ id, url: tabUrl, title: "标签标题" }) },
      permissions: { contains: async ({ origins }) => (calls.push(origins[0]), granted) },
      scripting: {
        executeScript: async ({ target, files, func, args }) => {
          if (refuse) throw new Error("Cannot access contents of the page. Extension manifest must request permission to access the respective host.");
          if (files) return calls.push(...files), (loaded = true), [];
          calls.push(`parse ${args[0]}`);
          // The parsed document names its own URL (location.href), the page's unless a test moves it.
          return [{ result: loaded && typeof func === "function" && page ? { ...page, url: page.url ?? tabUrl } : null }];
        }
      }
    };
    let tabUrl = "chrome-extension://other/page.html";
    const read = async () => JSON.parse(JSON.stringify(await ctx.getAiSidepanelState(1)));
    let got = await read();
    assert.deepStrictEqual([got.isVideoContext, got.pageAccess, calls], [false, "unsupported", []], "not http(s): nothing is asked");
    // Chrome hides the URL of a site the extension cannot read yet (and of chrome:// pages).
    tabUrl = undefined;
    got = await read();
    assert.deepStrictEqual([got.pageAccess, got.url, calls.splice(0)], ["needPermission", "", ["http://*/*"]]);
    // B2: with web pages granted, a URL still hidden is a chrome:// page: not readable, and no grant offered.
    granted = true;
    got = await read();
    assert.deepStrictEqual([got.pageAccess, calls.splice(0)], ["unsupported", ["http://*/*"]]);
    // A URL that shows can be read: a granted site, or the tab whose toolbar icon was clicked (activeTab), which
    // permissions.contains does not count, so it is not asked.
    granted = false;
    tabUrl = "https://example.com/a?x=1#part";
    got = await read();
    assert.deepStrictEqual(calls.splice(0), ["parse 200000", "vendor/defuddle.js", "parse 200000"], "injected once it is missing");
    assert.deepStrictEqual([got.pageAccess, got.url, got.title, got.author, got.published, got.siteName, got.pageMarkdown], ["ready", "https://example.com/a?x=1", "文章", "作者", "2026-01-02", "example.com", "正文"]);
    got = await read();
    assert.deepStrictEqual(calls.splice(0), ["parse 200000"], "the bundle stays loaded");
    // Gap 8: the tab navigated between the tab read and the extraction: the text is another page's, so it is not
    // stored under this URL; said as a failed read, with 重试 (the next tab event reads again anyway).
    page.url = "https://example.com/moved";
    got = await read();
    assert.deepStrictEqual([got.pageAccess, got.pageError, got.url, "pageMarkdown" in got], ["failed", "读取时页面已跳转", "https://example.com/a?x=1", false]);
    delete page.url;
    // Nothing parsed at all (no URL came back either): the no-body reason, not a navigation.
    const whole = page;
    page = null;
    got = await read();
    assert.deepStrictEqual([got.pageAccess, got.pageError], ["failed", "没有找到正文"]);
    page = whole;
    calls.splice(0);
    // The popup's note of a web page (popup-page-note): the side panel's note file, with the page's newest conversation.
    {
      const wasSettings = ctx.getMergedSettings;
      ctx.getMergedSettings = async () => ({ ...ctx.MdgSettings.DEFAULTS, includeAiChatInNote: true });
      const conv = (contextKey, updatedAt, q) => ({ contextKey, updatedAt, messages: [{ role: "user", content: q }, { role: "assistant", content: `答：${q}` }] });
      const key = "page:https://example.com/a?x=1";
      const stored = { [ctx.MdgLimits.KEYS.aiConversations]: [conv(key, 1, "旧问题"), conv(key, 2, "新问题"), conv("page:https://example.com/b", 3, "别的页")] };
      ctx.chrome.storage = { local: { get: async () => stored } };
      const resp = await ask({ type: "popup-page-note", tabId: 1 });
      calls.splice(0);
      const context = await read();
      calls.splice(0);
      const expected = ctx.MdgNote.buildPageNoteFile(context, await ctx.getMergedSettings(), ctx.MdgNote.buildConversationTurns(stored[ctx.MdgLimits.KEYS.aiConversations][1].messages), stored);
      assert.deepStrictEqual([resp.ok, resp.filename, resp.content], [true, expected.filename, expected.content]);
      assert.ok(resp.content.includes("正文") && resp.content.includes("新问题") && !/旧问题|别的页/.test(resp.content), resp.content);
      assert.deepStrictEqual([resp.ref.url, resp.ref.isVideoContext], ["https://example.com/a?x=1", false], "write-video-note's ref");
      // R11: a page written to Obsidian downloads under that note's name (its date), not today's.
      stored[ctx.MdgLimits.KEYS.obsidianNotePaths] = { [key]: { path: "N/网页/2026-01-01-文章.md" } };
      ctx.chrome.storage = { local: { get: async (keys) => Object.fromEntries([].concat(keys).filter((k) => k in stored).map((k) => [k, stored[k]])) } };
      assert.strictEqual((await ask({ type: "popup-page-note", tabId: 1 })).filename, "2026-01-01-文章.md");
      calls.splice(0);
      delete stored[ctx.MdgLimits.KEYS.obsidianNotePaths];
      ctx.chrome.storage = { local: { get: async () => stored } };
      // Only the popup asks: an extension page in a tab (sender.tab) is refused too.
      assert.strictEqual((await ask({ type: "popup-page-note", tabId: 1 }, { tab: { id: 9 }, url: "chrome-extension://me/popup.html" })).ok, false);
      // No main text: the side panel's words.
      const text = page.content;
      page.content = "  ";
      assert.deepStrictEqual({ ...(await ask({ type: "popup-page-note", tabId: 1 })) }, { ok: false, error: `${ctx.MdgErrors.TEXT.pageReadFailed}：没有找到正文`, code: "PAGE_FAILED" });
      page.content = text;
      calls.splice(0);
      // J18: a page that cannot be read, or is not granted yet, in the side panel's sentence for it, with its code (F6:
      // the popup offers 允许读取网页 by PAGE_GRANT).
      const realRead = ctx.readWebPage;
      for (const [pageAccess, error, code] of [["unsupported", ctx.MdgErrors.TEXT.pageUnsupported, "PAGE_UNSUPPORTED"], ["needPermission", ctx.MdgErrors.TEXT.pageGrant, "PAGE_GRANT"]]) {
        ctx.readWebPage = async () => ({ pageAccess });
        assert.deepStrictEqual({ ...(await ask({ type: "popup-page-note", tabId: 1 })) }, { ok: false, error, code }, pageAccess);
      }
      ctx.readWebPage = realRead;
      ctx.getMergedSettings = wasSettings;
    }
    page = { ...page, content: "  " };
    got = await read();
    assert.deepStrictEqual([got.pageAccess, got.pageError, got.pageMarkdown], ["failed", "没有找到正文", undefined]);
    refuse = true;
    got = await read();
    assert.deepStrictEqual([got.pageAccess, got.pageError], ["failed", "浏览器不允许读取这个页面"], "Chrome's English stays out");
    ctx.chrome = was;
  }

  // The side panel saves the context URL with a conversation, so reader mode and tracking params never reach it.
  // chrome.tabs.sendMessage answering with reply(message), or with Chrome's error when reply throws.
  const tabsSend = (reply) => (tabId, message, ...rest) =>
    Promise.resolve()
      .then(() => reply(message))
      .then(rest.at(-1), (e) => {
        ctx.chrome.runtime.lastError = { message: e.message };
        rest.at(-1)();
        delete ctx.chrome.runtime.lastError;
      });
  const contextFor = async (tabUrl, payload) => {
    // One request: the page settles its video and answers with the comments.
    const sendMessage = tabsSend(({ type }) => {
      assert.strictEqual(type, "sidepanel-get-context");
      return payload.ok === false ? payload : { ok: true, payload: { url: tabUrl, title: "T", ...payload } };
    });
    ctx.chrome = { runtime: {}, tabs: { get: async () => ({ id: 1, url: tabUrl }), sendMessage } };
    ctx.ensureReaderContentReady = async () => {};
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
    ctx.chrome.tabs.sendMessage = tabsSend(() => {
      throw new Error("Could not establish connection. Receiving end does not exist.");
    });
    await assert.rejects(ctx.getAiSidepanelState(1), (e) => e.message === ctx.MdgErrors.TEXT.pageSilent && e.code === "PAGE_SILENT");
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
    const was = ctx.ensureReaderContentReady;
    const sent = [];
    const sendMessage = tabsSend((m) => {
      sent.push(m.readerUrl);
      throw new Error("Could not establish connection. Receiving end does not exist.");
    });
    ctx.chrome = { runtime: {}, tabs: { get: async () => ({ id: 1, url: "https://www.bilibili.com/video/BV1GJ411x7h7" }), sendMessage } };
    ctx.ensureReaderContentReady = async () => {};
    assert.strictEqual(await ctx.triggerReaderModeInTab(1, "https://www.bilibili.com/video/BV1xx411c7mD?mdg_reader=1", 5, 1), false);
    assert.strictEqual(sent.length, 1, "no retry lands on the other video's page");
    ctx.ensureReaderContentReady = was;
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
  const dead = { triage_watched: { BV1: 1 }, triage_tab: "none", triage_schemes: [], triage_excluded_folders: ["2"], triage_simplified_v1: true, triage_tags_by_folder_v1: true, triage_kept_v1: true, triage_basket: [{ bvid: "BV1" }] };
  ctx.chrome = { storage: { sync: area({}), local: { ...area(dead), getKeys: async () => Object.keys(dead) } } };
  await ctx.removeDeadStorageKeys();
  assert.deepStrictEqual(Object.keys(dead), ["triage_basket"]);
  // C563: the old global 判断标准 stays in sync; another computer may not have updated yet.
  const syncLeft = { triageCriteria: "全局", readerChapterVisibility: "x" };
  ctx.chrome = { storage: { sync: area(syncLeft), local: { ...area({ triage_simplified_v1: true }), getKeys: async () => ["triage_simplified_v1"] } } };
  await ctx.removeDeadStorageKeys();
  assert.deepStrictEqual(syncLeft, { triageCriteria: "全局" });

  // Settings file: everything in sync (收藏夹 and 关注 included), never a key, even one an older version left in sync.
  const exportSync = { noteFolder: "X", triageFineBatchSize: 20, follow_ai_settings: { batchSize: 7 }, aiProviders: [{ id: "p", apiKey: "sk-old" }], obsidianApiKey: "leak" };
  ctx.chrome = { runtime: { getManifest: () => ({ version: "9" }) }, storage: { sync: area(exportSync), local: area({ obsidianApiKey: "k", aiProviderKeys: { p: "sk" }, triage_included_folders: ["11", "toview"], triage_folder_criteria: { 11: "只留菜谱" }, triage_sort: { 11: "pub" }, triage_tags: [] }) } };
  const file = JSON.parse(JSON.stringify(await ctx.exportSettings()));
  assert.deepStrictEqual([file.kind, file.extensionVersion, file.settings.triageFineBatchSize, file.settings.follow_ai_settings], ["settings", "9", 20, { batchSize: 7 }]);
  assert.deepStrictEqual(file.settings.aiProviders, [{ id: "p" }]);
  assert.ok(!/sk|leak|"k"/.test(JSON.stringify(file)), "no keys in the file");
  assert.deepStrictEqual(file.local, { triage_included_folders: ["11", "toview"], triage_folder_criteria: { 11: "只留菜谱" } }, "the 分拣台's folder choice and 判断标准; no sort, no data");

  // Import replaces every setting, migrates an older file's keys, writes no defaults, and leaves local keys alone.
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
  assert.ok(!("seenThreshold" in importSync), "a setting the file lacks is not written");
  assert.strictEqual((await ctx.getMergedSettings()).seenThreshold, 80, "and reads as its default");
  assert.deepStrictEqual(importLocal, { obsidianApiKey: "k2", aiProviderKeys: { q: "sk2" }, triage_included_folders: ["11", "toview"], triage_folder_criteria: { 11: "只留菜谱" } });
  // A file from before the folder choice was exported leaves the current choice.
  importLocal.triage_included_folders = ["7"];
  const { local: _, ...older } = file;
  await ctx.importSettings(older);
  assert.deepStrictEqual(importLocal.triage_included_folders, ["7"]);
  // An import during a 分拣台 tick (MdgLimits.update under the key's lock) waits for it: the tick's read-modify-write
  // lands first and the import replaces it, instead of the tick writing its stale list over the import. Same for 判断标准.
  {
    const held = [];
    const release = (p) => (held.push(p), new Promise((r) => (p.release = r)));
    const tick = ctx.MdgLimits.update("triage_included_folders", async (stored) => (await release({}), [...stored, "9"]));
    const edit = ctx.MdgLimits.update("triage_folder_criteria", async (stored) => (await release({}), { ...stored, 9: "新" }));
    await new Promise((r) => setTimeout(r, 5));
    const importing = ctx.importSettings(file);
    await new Promise((r) => setTimeout(r, 5));
    assert.deepStrictEqual([importLocal.triage_included_folders, importLocal.triage_folder_criteria], [["7"], { 11: "只留菜谱" }], "the import waits for the held writes");
    held.forEach((p) => p.release());
    await Promise.all([tick, edit, importing]);
    assert.deepStrictEqual([importLocal.triage_included_folders, importLocal.triage_folder_criteria], [["11", "toview"], { 11: "只留菜谱" }], "the import's lists win, written after the tick's");
  }

  // R2: a key goes with the host it was saved for. An imported row that keeps its id but moves to another origin, or a
  // moved Obsidian address, drops that key; a row on the same origin and an unrelated key stay.
  {
    const sync = { aiProviders: [{ id: "p", baseUrl: "https://b.example/v1" }, { id: "s", baseUrl: "https://same.example/v1" }], obsidianApiBaseUrl: "http://127.0.0.1:27123" };
    const local = { obsidianApiKey: "ok", aiProviderKeys: { p: "sk-for-B", s: "sk-same", q: "sk-q" } };
    ctx.chrome = { storage: { sync: area(sync), local: area(local) } };
    const stub = ctx.loadAiProviderKeys;
    ctx.loadAiProviderKeys = async () => ({ ...local.aiProviderKeys });
    await ctx.importSettings({ ...file, settings: { aiProviders: [{ id: "p", baseUrl: "https://a.example/v1" }, { id: "s", baseUrl: "https://same.example/v2" }], obsidianApiBaseUrl: "https://other.example:27124" } });
    assert.deepStrictEqual(local.aiProviderKeys, { s: "sk-same", q: "sk-q" });
    assert.strictEqual(local.obsidianApiKey, "");
    local.obsidianApiKey = "ok";
    await ctx.importSettings({ ...file, settings: { obsidianApiBaseUrl: "https://other.example:27124/" } });
    assert.strictEqual(local.obsidianApiKey, "ok", "the same origin keeps the Obsidian key");
    ctx.loadAiProviderKeys = stub;
  }

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
        runtime: fake({ getManifest: () => manifest, lastError: undefined, onInstalled: { addListener: (fn) => installed.push(fn) }, onMessage: { addListener: (fn) => onMessage.push(fn) }, getURL: (p) => `chrome-extension://x/${p}` }),
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
    const reply = await new Promise((resolve) => onMessage.forEach((fn) => fn({ type: "ai-sidepanel-get-state", tabId: 7, frameId: 3, videoId: "BV1xx411c7mD" }, { url: "chrome-extension://x/sidepanel.html" }, resolve)));
    assert.deepStrictEqual(JSON.parse(JSON.stringify(sentTo)), [[7, { type: "sidepanel-get-context", refresh: false, videoId: "BV1xx411c7mD" }, { frameId: 3 }]]);
    assert.deepStrictEqual([reply.ok, reply.payload.subtitleMarkdown, reply.payload.url, reply.payload.isVideoContext], [true, "picked", "https://www.bilibili.com/video/BV1xx411c7mD/", true]);
    // The side panel's 刷新 is refresh on both messages (popup-refresh too), never force / forceRefresh.
    sentTo.length = 0;
    await new Promise((resolve) => onMessage.forEach((fn) => fn({ type: "ai-sidepanel-get-state", tabId: 7, frameId: 3, videoId: "BV1xx411c7mD", refresh: true }, { url: "chrome-extension://x/sidepanel.html" }, resolve)));
    assert.strictEqual(sentTo[0][1].refresh, true);
    // The ✦ AI 总结按钮 switch stops only the player button (no source); 专注模式 (reader) and the popup still open AI 总结.
    ictx.getMergedSettings = async () => ({ enablePlayerAiQuickAction: false, playerAiQuickPrompt: "" });
    const quick = (source) => new Promise((resolve) => onMessage.forEach((fn) => fn({ type: "player-ai-quick-action", ...(source && { source }) }, { tab: { id: 7 } }, resolve)));
    assert.deepStrictEqual([(await quick()).error, (await quick("reader")).ok, (await quick("popup")).ok], ["✦ AI 总结按钮未开启", true, true]);
    // 摘读记录 opens through the same one-tab rule as 分拣台.
    const opened = [];
    ictx.focusOrOpenPage = async (page) => opened.push(page);
    ictx.chrome.runtime.getURL = (p) => `chrome-extension://x/${p}`;
    assert.ok((await new Promise((resolve) => onMessage.forEach((fn) => fn({ type: "history-open" }, { url: "chrome-extension://x/sidepanel.html" }, resolve)))).ok);
    assert.deepStrictEqual(opened, ["chrome-extension://x/history/history.html"]);
    for (const f of PS.pageCode) assert.ok(!/forceRefresh|message\.force\b|"popup-refresh", force\b/.test(PS.read(f)), `${f}: the refresh flag is named refresh`);
    for (const f of ["popup.js", "sidepanel.js", "options.js"]) assert.ok(fs.readFileSync(path.join(__dirname, f), "utf8").includes('"history-open"'), `${f} opens 摘读记录 by history-open`);
  }

  finished = true;
  clearInterval(keepAlive);
  console.log("background selftest: all passed");
})();
