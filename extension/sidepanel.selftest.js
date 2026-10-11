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
// The scripts sidepanel.html loads before sidepanel.js, read from the page so the test cannot load a different set.
const scripts = [...fs.readFileSync(path.join(__dirname, "sidepanel.html"), "utf8").matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => path.join(__dirname, m[1]));
assert.strictEqual(scripts.pop(), path.join(__dirname, "sidepanel.js"), "sidepanel.js loads last");
for (const f of scripts) vm.runInContext(fs.readFileSync(f, "utf8"), ctx);
vm.runInContext(
  `${source}\n;globalThis.peek = () => ({ live: liveContextData, ctx: contextData });
  globalThis.showConversations = (saved) => { savedConversations = saved; currentConversationId = saved[0].id; previousVideoConversationId = saved[1].id; previousVideoExpanded = true; previousVideoBarSignature = ""; };`,
  ctx
);
const realRenderHistoryList = ctx.renderHistoryList;
// Untrusted text (titles, UP names, comments, AI replies, tag names, paths) stays text: no tag of its own, no way out of
// a quoted attribute.
const XSS = ["<img src=x onerror=alert(1)>", `"'><script>alert(1)</script>`];
const assertInert = (html, where) => assert.ok(!/<img src=x|<script|"'>/i.test(html) && /&lt;|&#60;/.test(html), `${where}: ${html}`);
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
  // No enabled platform: the conversation and the typed text stay, and the settings page opens.
  let resets = 0;
  let opened = 0;
  ctx.resetConversationView = () => resets++;
  ctx.showConversationContextNotice = () => {};
  ctx.chrome.runtime.openOptionsPage = () => opened++;
  blocked(video, null);
  vm.runInContext('els.input.value = "q"; els.modelSelect.value = ""', ctx);
  await ctx.sendMessage();
  assert.deepStrictEqual([resets, opened, loads, vm.runInContext("els.input.value", ctx)], [0, 1, 1, "q"]);
  ctx.resetConversationView = () => {};

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
    // BocOverwriteDialog.writeBuiltNote sends its own messages.
    const realRuntimeSend = ctx.chrome.runtime.sendMessage;
    ctx.chrome.runtime.sendMessage = ctx.sendRuntimeMessage;
    ctx.video = { ...video, pageIndex: 1, title: "T" };
    vm.runInContext('contextData = video; currentConversationMeta = null; chatHistory = [{ role: "user", content: "这个视频" }, { role: "assistant", content: "回答" }]', ctx);
    await ctx.saveCurrentConversationToObsidian();
    const write = sent.find((m) => m.type === "write-obsidian-note");
    assert.deepStrictEqual([write.filepath, write.cover.name], ["B站/UP/T.md", "bilibili-BV1xx411c7mD"]);
    const section = sent.filter((m) => m.type === "update-obsidian-ai-section").pop();
    assert.ok(section.filepath === "B站/UP/T.md" && section.section.includes("这个视频") && !section.section.includes("别的视频"), section.section);
    ctx.sendRuntimeMessage = realSend;
    ctx.chrome.runtime.sendMessage = realRuntimeSend;
  }

  {
    // A failed write is red; only not set up or a wrong key (code OBSIDIAN) opens the settings page, not a closed Obsidian.
    const notices = [];
    let settings = 0;
    ctx.showConversationContextNotice = (text, ms, opts) => notices.push([text, opts?.error]);
    ctx.chrome.runtime.openOptionsPage = () => settings++;
    const E = ctx.BocErrors;
    ctx.showObsidianFailure(E.fromResp({ ok: false, error: E.TEXT.obsidianKey, code: "OBSIDIAN" }, "Local API 写入失败"));
    ctx.showObsidianFailure(E.fromResp({ ok: false, error: "Obsidian 返回 HTTP 500" }, "Local API 写入失败"));
    ctx.showObsidianFailure(E.fromResp({ ok: false, error: E.TEXT.obsidianDown, code: "OBSIDIAN_DOWN" }, "Local API 写入失败"));
    assert.deepStrictEqual(notices, [[`写入 Obsidian 失败：${E.TEXT.obsidianKey}`, true], ["写入 Obsidian 失败：Obsidian 返回 HTTP 500", true], [`写入 Obsidian 失败：${E.TEXT.obsidianDown}`, true]]);
    assert.strictEqual(settings, 1);
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

  {
    // The popup's AI 总结 over an opened history conversation, when the tab cannot be read: the fresh conversation does
    // not keep the old video's context (the empty state shows the read error and 重试).
    answer = async () => ({ ok: false, error: "读取失败" });
    ctx.autosizeInput = () => {};
    activeTab = { id: 9, url: "https://www.bilibili.com/video/BV1GJ411x7h7" };
    vm.runInContext('savedConversations = []; activeStream = null; currentConversationMeta = { pinnedContext: true }; contextData = { url: "https://www.bilibili.com/video/BV1hh", isVideoContext: true }; currentContextKey = "video:BV1hh"', ctx);
    await ctx.showLiveVideoConversation();
    assert.deepStrictEqual([...vm.runInContext("[contextData, currentContextKey]", ctx)], [null, ""]);
    vm.runInContext("currentConversationMeta = null", ctx);
  }

  {
    // A timestamp clicked while 分拣台's viewer plays the video seeks that frame; the 分拣台 tab is not navigated.
    // A normal tab on another video still goes to the video first.
    const updates = [];
    const seeks = [];
    const notices = [];
    ctx.showConversationContextNotice = (text) => notices.push(text);
    ctx.chrome.runtime.getURL = (p) => `chrome-extension://test/${p}`;
    ctx.chrome.tabs.update = async (id, props) => updates.push(props.url);
    ctx.chrome.tabs.get = async () => ({ status: "complete" });
    ctx.chrome.tabs.sendMessage = (id, msg, cb) => (seeks.push(msg), cb({ ok: true }));
    vm.runInContext('contextData = { url: "https://www.bilibili.com/video/BV1xx411c7mD" }', ctx);
    activeTab = { id: 7, url: "chrome-extension://test/triage/triage.html" };
    await ctx.jumpToAssistantTimestamp(75, "1:15");
    activeTab = { id: 8, url: "https://www.bilibili.com/video/BV1GJ411x7h7" };
    await ctx.jumpToAssistantTimestamp(5, "0:05");
    assert.deepStrictEqual(updates, ["https://www.bilibili.com/video/BV1xx411c7mD"], "only the normal tab navigates");
    assert.deepStrictEqual(seeks.map((m) => [m.seconds, m.videoId]), [[75, "BV1xx411c7mD"], [5, ""]]);
    ctx.chrome.runtime.getURL = (p) => p;
  }

  {
    // Following: a conversation with nothing asked follows any other video, also the first one after a web page
    // or an empty 问 AI conversation; one with messages follows only from the video it belongs to.
    const v = (id) => `https://www.bilibili.com/video/${id}`;
    ctx.web = page("home").payload;
    const follows = (setup, from, to) => vm.runInContext(`${setup}; isFollowCandidate(${JSON.stringify(from)}, ${JSON.stringify(to)})`, ctx);
    assert.strictEqual(follows("contextData = web; currentConversationMeta = null; chatHistory = []", "", v("BV1aa")), true, "first video after a web page");
    assert.strictEqual(follows(`contextData = { url: "${v("BV1aa")}" }`, v("BV1aa"), v("BV1aa")), false, "the video already shown");
    const pinned = `currentConversationMeta = { pinnedContext: true, contextUrl: "${v("BV1vv")}" }; chatHistory = []`;
    assert.strictEqual(follows(pinned, v("BV1ee"), v("BV1ee")), true, "empty 问 AI conversation, back to the video tab");
    const history = `currentConversationMeta = { pinnedContext: true, contextUrl: "${v("BV1hh")}" }; chatHistory = [{ role: "user", content: "q" }]`;
    assert.strictEqual(follows(history, v("BV1ee"), v("BV1ff")), false, "an opened history conversation stays");
    assert.strictEqual(follows(history, "", v("BV1ff")), false);
    assert.strictEqual(follows(history, v("BV1hh"), v("BV1ff")), true, "the conversation of the video just played");

    // Showing another conversation drops a pending AI 总结 fill.
    assert.strictEqual(vm.runInContext('summaryFillPending = true; applyConversation({ id: "h", messages: [] }); summaryFillPending', ctx), false);

    // 导出对话 is disabled with its reason until there is a question with an answer.
    ctx.renderFollowups = () => {};
    const exportState = (messages) => vm.runInContext(`activeStream = null; chatHistory = ${JSON.stringify(messages)}; setStreamingUiState(false); [els.exportBtn.disabled, els.exportBtn.title]`, ctx);
    assert.deepStrictEqual([...exportState([])], [true, "当前没有可导出的对话"]);
    assert.deepStrictEqual([...exportState([{ role: "user", content: "q" }, { role: "assistant", content: "a" }])], [false, "导出整段对话"]);
  }

  // A history conversation whose B站 video was deleted or hidden: said once as such, not as a read error to retry.
  {
    const errors = [];
    ctx.showConversationContextError = (text) => errors.push(text);
    ctx.removeConversationContextNotice = () => {};
    const realResolve = ctx.resolveConversationContext;
    for (const code of [-404, -352]) {
      ctx.resolveConversationContext = async () => ({ ok: false, error: "啥都木有", code });
      vm.runInContext('currentConversationMeta = { contextKey: "k", contextRef: { url: "https://www.bilibili.com/video/BV1xx411c7mD" } }; liveContextKey = ""', ctx);
      assert.strictEqual(await ctx.hydratePinnedConversationContext(), false);
    }
    assert.deepStrictEqual(errors, ["视频已失效，这段对话只能查看，不能继续提问。", "读取原视频失败：啥都木有"]);
    ctx.resolveConversationContext = realResolve;
  }

  // A bad key or used-up quota offers 去设置 before 重试; a network error only 重试.
  {
    const errorButtons = (code) => {
      const kids = [];
      ctx.appendStreamError({ node: { appendChild: (c) => kids.push(c) }, prompt: "q", raw: "" }, "x", false, code);
      return kids.slice(1).map((k) => (typeof k.textContent === "string" ? k.textContent : k.innerHTML.replace(/<[^>]*>/g, "")));
    };
    assert.deepStrictEqual(errorButtons("AI_QUOTA"), ["去设置", "重试"]);
    assert.deepStrictEqual(errorButtons("AI_NETWORK"), ["重试"]);
  }

  // Saved conversations: the video's title, the question and the AI's answer, in the history list and 上一个视频.
  for (const bad of XSS) {
    const conv = (id) => ({ id, title: bad, contextTitle: bad, updatedAt: 1, messages: [{ role: "user", content: bad }, { role: "assistant", content: bad }] });
    ctx.showConversations([conv("now"), conv("before")]);
    const els = vm.runInContext("els", ctx);
    els.historyList.querySelectorAll = () => [];
    realRenderHistoryList();
    assertInert(els.historyList.innerHTML, "history list");
    assertInert(els.previousVideoBar.innerHTML, "previous video");
  }

  console.log("sidepanel selftest: all passed");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
