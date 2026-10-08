// node extension/sidepanel.selftest.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

// sidepanel.js is a DOM page: drop init(), stub the DOM, and drive the context loads by hand.
const source = fs.readFileSync(path.join(__dirname, "sidepanel.js"), "utf8").replace(/^init\(\)\.catch\(/m, "(async () => {})().catch(");
assert.ok(source.includes("(async () => {})().catch("), "harness strips the page entry point");

const stubEl = () => new Proxy({ classList: { toggle() {}, add() {}, remove() {} }, style: {}, dataset: {} }, {
  get: (o, k) => (k in o ? o[k] : () => {}),
  set: (o, k, v) => ((o[k] = v), true)
});
let activeTab = null;
let answer = null; // (tabId) => promise of the ai-sidepanel-get-state reply
const ctx = vm.createContext({
  console,
  structuredClone,
  URL,
  setTimeout: (f) => setImmediate(f),
  clearTimeout: (id) => clearImmediate(id),
  document: { getElementById: stubEl, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, createElement: stubEl },
  window: { addEventListener() {}, setTimeout: (f) => setImmediate(f), clearTimeout: (id) => clearImmediate(id), matchMedia: () => ({ matches: false }) },
  navigator: {},
  chrome: {
    runtime: {
      id: "test",
      lastError: undefined,
      getURL: (p) => p,
      onMessage: { addListener() {} },
      sendMessage(msg, cb) {
        Promise.resolve(msg.type === "ai-sidepanel-get-state" ? answer(msg.tabId) : { ok: true }).then(cb);
      }
    },
    tabs: { query: async () => [activeTab], onActivated: { addListener() {} }, onUpdated: { addListener() {} } },
    storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} }, onChanged: { addListener() {} } }
  }
});
ctx.globalThis = ctx;
for (const f of ["limits.js", "typing.js", "sites.js", "note.js", "download.js"]) vm.runInContext(fs.readFileSync(path.join(__dirname, f), "utf8"), ctx);
vm.runInContext(`${source}\n;globalThis.peek = () => ({ live: liveContextData, ctx: contextData });`, ctx);
for (const f of ["updateContextChip", "renderHistoryList", "restartChat", "renderSuggestions", "renderInitialState", "resetConversationView"]) ctx[f] = () => {};
ctx.restoreLatestConversationForCurrentContext = async () => {};

const page = (id) => ({ ok: true, payload: { url: `https://example.com/${id}`, title: id, isVideoContext: false } });

(async () => {
  // Switching tabs quickly: tab A's slow reply arrives after tab B's and must not replace it.
  let releaseA;
  answer = (tabId) => (tabId === 1 ? new Promise((r) => (releaseA = () => r(page("a")))) : page("b"));
  activeTab = { id: 1, url: "https://example.com/a" };
  const loadA = ctx.loadContextState({ silent: true });
  await new Promise((r) => setImmediate(r));
  activeTab = { id: 2, url: "https://example.com/b" };
  assert.strictEqual(await ctx.loadContextState({ silent: true }), true);
  releaseA();
  assert.strictEqual(await loadA, true, "the older call answers with the newer result");
  const { live, ctx: current } = ctx.peek();
  assert.deepStrictEqual([live.url, current.url], ["https://example.com/b", "https://example.com/b"], "tab B's context stays");

  // A follow asked for by a load that a newer one replaced is done by the newer one, and only until it settles.
  const realRead = ctx.readContextState;
  const follows = [];
  let release;
  ctx.readContextState = (opts) => (follows.push(opts.follow), new Promise((r) => (release = r)));
  ctx.loadContextState({ follow: true });
  const send = ctx.loadContextState({});
  release(true);
  await send;
  const later = ctx.loadContextState({});
  release(true);
  await later;
  assert.deepStrictEqual(follows, [true, true, false]);
  ctx.readContextState = realRead;

  // Only videos can be asked: not a web page, and not a conversation saved on one, even with a video open.
  const video = { url: "https://www.bilibili.com/video/BV1xx411c7mD", site: "bilibili", videoId: "BV1xx411c7mD", isVideoContext: true };
  const blocked = (current, meta) => {
    ctx.current = current;
    ctx.meta = meta;
    return [...vm.runInContext("providers = [{}]; contextData = current; currentConversationMeta = meta; [isNonVideoConversation(), followupBlockReason()]", ctx)];
  };
  assert.deepStrictEqual(blocked(page("a").payload, null), [true, "不是视频，不能问"], "a fresh conversation on a web page");
  assert.deepStrictEqual(blocked(video, { pinnedContext: true, isVideoContext: false }), [true, "不是视频，不能问"], "a saved web conversation");
  assert.strictEqual(blocked(page("a").payload, { pinnedContext: true, isVideoContext: true })[0], false, "a saved video conversation on a web page");
  assert.strictEqual(blocked(video, null)[0], false, "a fresh conversation on a video");

  // Neither gate of sendMessage reaches the request (chrome.runtime.connect is not stubbed and would throw).
  const errors = [];
  let loads = 0;
  ctx.showConversationContextError = (text) => errors.push(text);
  ctx.ensureCurrentContextForSend = async () => (loads++, true);
  vm.runInContext('els.input.value = "q"; els.modelSelect.value = "p"', ctx);
  blocked(video, { pinnedContext: true, isVideoContext: false });
  await ctx.sendMessage();
  assert.strictEqual(loads, 0, "a saved web conversation does not even load its context");
  // The tab leaves the video while the context loads.
  ctx.ensureCurrentContextForSend = async () => (loads++, vm.runInContext("contextData = current", ctx), true);
  ctx.current = page("b").payload;
  vm.runInContext("contextData = { ...current, isVideoContext: true }; currentConversationMeta = null", ctx);
  await ctx.sendMessage();
  assert.deepStrictEqual([loads, ...errors], [1, "这不是支持的视频页。"], "the context that came back is checked too");

  // 写入 Obsidian with the video page closed: the built note goes to the background's path with its cover, and the
  // conversation switched during the write does not replace this video's chat.
  {
    const sent = [];
    let updates = 0;
    ctx.showConversationContextNotice = () => {};
    const realSend = ctx.sendRuntimeMessage;
    ctx.sendRuntimeMessage = async (msg) => {
      sent.push(msg);
      if (msg.type === "get-settings") {
        vm.runInContext('chatHistory = [{ role: "user", content: "别的视频" }, { role: "assistant", content: "别的回答" }]; conversationEpoch += 1', ctx);
        return { ok: true, settings: { obsidianApiBaseUrl: "http://127.0.0.1:27123", obsidianApiKey: "k" } };
      }
      if (msg.type === "triage-build-note") return { ok: true, data: { title: "T", markdown: "m", path: "B站/UP/T.md", cover: { url: "https://i0.hdslb.com/a.jpg", name: "bilibili-BV1xx411c7mD" } } };
      if (msg.type === "obsidian-note-exists") return { ok: true, exists: false };
      if (msg.type === "update-obsidian-ai-section") return { ok: true, exists: updates++ > 0, updated: true };
      return { ok: true };
    };
    ctx.video = { ...video, pageIndex: 1, title: "T" };
    vm.runInContext('contextData = video; currentConversationMeta = null; chatHistory = [{ role: "user", content: "这个视频" }, { role: "assistant", content: "回答" }]', ctx);
    await ctx.saveCurrentConversationToObsidian();
    const write = sent.find((m) => m.type === "write-obsidian-note");
    assert.deepStrictEqual([write.filepath, write.cover.name], ["B站/UP/T.md", "bilibili-BV1xx411c7mD"]);
    const section = sent.filter((m) => m.type === "update-obsidian-ai-section").pop();
    assert.ok(section.filepath === "B站/UP/T.md" && section.section.includes("这个视频") && !section.section.includes("别的视频"), section.section);
    ctx.sendRuntimeMessage = realSend;
  }

  {
    // 分拣台's viewer asks for AI 总结 with a video reference: the prompt lands in that video's conversation,
    // not in a new one, which would fall back to the tab's own page (分拣台).
    const calls = [];
    activeTab = { id: 7, url: "chrome-extension://test/triage/triage.html" };
    ctx.openRequestedVideoContext = async (ref) => calls.push(["open", ref.videoId]);
    ctx.startNewConversation = async () => calls.push(["new"]);
    ctx.fillPrompt = (text) => calls.push(["fill", text]);
    const req = { id: "q1", tabId: 7, prompt: "总结", createdAt: Date.now(), contextRef: { site: "bilibili", videoId: "BV1xx" } };
    assert.strictEqual(await ctx.handlePlayerAiQuickActionRequest(req), true);
    assert.deepStrictEqual(calls, [["open", "BV1xx"], ["fill", "总结"]]);
  }

  console.log("sidepanel selftest: all passed");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
