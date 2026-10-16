// node extension/sidepanel.selftest.js
if (process.versions.bun) (console.error("This selftest needs Node: it fails or hangs under bun (see 自检 in README.md)."), process.exit(1));
// The side panel page around its state (sidepanel-state.selftest.js tests the conversation rules themselves): the
// loads, the send gates, Obsidian, timestamps, export, wording and untrusted text. State is set up through dispatch.
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

// sidepanel.js is a DOM page: drop init(), stub the DOM, and drive the context loads by hand. Startup is scripts/smoke.mjs's job.
const page = fs.readFileSync(path.join(__dirname, "sidepanel.js"), "utf8");
const source = page.replace(/^init\(\)\.catch\(/m, "(async () => {})().catch(");
assert.ok(source.includes("(async () => {})().catch("), "harness strips the page entry point");

// The conversation and its context live in sidepanel-state.js only; the page keeps none of its own copies.
for (const name of ["contextData", "currentContextKey", "liveContextData", "liveContextKey", "liveTabUrl", "chatHistory", "savedConversations", "currentConversationId", "currentConversationMeta", "conversationEpoch", "summaryFillEpoch", "lastLiveVideoUrl", "previousVideoConversationId"]) {
  assert.ok(!new RegExp(`^(let|const|var)\\s+${name}\\b`, "m").test(page), `sidepanel.js declares ${name}`);
}
for (const name of ["decideFollow", "applyConversation", "restartChat", "persistCurrentConversation", "normalizeConversations", "buildContextKey"]) {
  assert.ok(!new RegExp(`function\\s+${name}\\b`).test(page), `sidepanel.js defines ${name}`);
}

const stubEl = () => new Proxy({ classList: { toggle() {}, add() {}, remove() {}, contains: () => false }, style: {}, dataset: {}, querySelectorAll: () => [], querySelector: () => null }, {
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
  document: { body: stubEl(), getElementById: stubEl, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, createElement: stubEl },
  window: { addEventListener() {}, setTimeout: (f) => setImmediate(f), clearTimeout: (id) => clearImmediate(id), matchMedia: () => ({ matches: false }), cancelAnimationFrame() {} },
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
    storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} }, session: { get: async () => ({}), set: async () => {}, remove: async () => {} }, onChanged: { addListener() {} } }
  }
});
ctx.globalThis = ctx;
// The scripts sidepanel.html loads before sidepanel.js, read from the page so the test cannot load a different set.
const scripts = [...fs.readFileSync(path.join(__dirname, "sidepanel.html"), "utf8").matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => path.join(__dirname, m[1]));
assert.strictEqual(scripts.pop(), path.join(__dirname, "sidepanel.js"), "sidepanel.js loads last");
for (const f of scripts) vm.runInContext(fs.readFileSync(f, "utf8"), ctx);
vm.runInContext(source, ctx);
const state = vm.runInContext("state", ctx);
const view = () => state.view();
const realRenderHistoryList = ctx.renderHistoryList;
// The page's own functions, for the behaviour tests below that need them past the stubs.
const real = Object.fromEntries(["hydratePinnedConversationContext", "renderPreviousVideoBar", "ensureCurrentContextForSend", "renderInitialState"].map((f) => [f, ctx[f]]));
// Untrusted text (titles, UP names, comments, AI replies, tag names, paths) stays text: no tag of its own, no way out of
// a quoted attribute.
const XSS = ["<img src=x onerror=alert(1)>", `"'><script>alert(1)</script>`];
const assertInert = (html, where) => assert.ok(!/<img src=x|<script|"'>/i.test(html) && /&lt;|&#60;/.test(html), `${where}: ${html}`);
for (const f of ["updateContextChip", "renderHistoryList", "renderSuggestions", "renderInitialState", "resetConversationView", "renderPreviousVideoBar"]) ctx[f] = () => {};

const web = (id) => ({ url: `https://example.com/${id}`, title: id, isVideoContext: false });
const webPage = (id) => ({ ok: true, payload: web(id) });
const video = { url: "https://www.bilibili.com/video/BV1xx411c7mD", title: "T", site: "bilibili", videoId: "BV1xx411c7mD", pageIndex: 1, isVideoContext: true, subtitleMarkdown: "s" };
// The tab shows payload, as a context load would leave it (without the page's I/O).
const show = (payload) => {
  state.dispatch({ type: "TAB_READ", tab: { url: payload.url, title: payload.title }, follow: false });
  state.dispatch({ type: "CONTEXT_ARRIVED", payload, follow: false });
};
// A fresh conversation on context with one question answered.
const chatOn = (context) => {
  state.dispatch({ type: "NEW" });
  show(context);
  state.dispatch({ type: "SEND", prompt: "这个视频" });
  state.dispatch({ type: "STREAM_ENDED", raw: "回答" });
};

(async () => {
  // Switching tabs quickly: tab A's slow reply arrives after tab B's and must not replace it.
  let releaseA;
  answer = (tabId) => (tabId === 1 ? new Promise((r) => (releaseA = () => r(webPage("a")))) : webPage("b"));
  activeTab = { id: 1, url: "https://example.com/a" };
  const loadA = ctx.loadContextState({ silent: true });
  await new Promise((r) => setImmediate(r));
  activeTab = { id: 2, url: "https://example.com/b" };
  assert.strictEqual(await ctx.loadContextState({ silent: true }), true);
  releaseA();
  assert.strictEqual(await loadA, true, "the older call answers with the newer result");
  assert.deepStrictEqual([view().live.context.url, view().context.url], ["https://example.com/b", "https://example.com/b"], "tab B's context stays");

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

  // A load that follows the tab to another video says so (the tab events then skip their own redraw).
  activeTab = { id: 3, url: "https://www.bilibili.com/video/BV1GJ411x7h7" };
  answer = async () => ({ ok: true, payload: { url: activeTab.url, title: "b", site: "bilibili", videoId: "BV1GJ411x7h7", isVideoContext: true } });
  show(video);
  assert.strictEqual(await ctx.loadContextState({ silent: true }), "followed");
  assert.strictEqual(view().context.videoId, "BV1GJ411x7h7");

  {
    // Neither gate of sendMessage reaches the request (chrome.runtime.connect is not stubbed and would throw).
    const errors = [];
    let loads = 0;
    ctx.showConversationContextError = (text) => errors.push(text);
    ctx.ensureCurrentContextForSend = async () => (loads++, true);
    vm.runInContext("providers = [{}]", ctx);
    // A conversation saved on a web page does not even load its context.
    state.dispatch({ type: "SAVED_CHANGED", list: [{ id: "w", contextUrl: web("w").url, isVideoContext: false, messages: [{ role: "user", content: "q" }] }] });
    state.dispatch({ type: "OPEN", id: "w" });
    vm.runInContext('els.input.value = "q"; els.modelSelect.value = "p"', ctx);
    await ctx.sendMessage();
    assert.strictEqual(loads, 0, "a saved web conversation does not even load its context");
    // The tab leaves the video while the context loads: the context that came back is checked too.
    state.dispatch({ type: "NEW" });
    show(video);
    ctx.ensureCurrentContextForSend = async () => (loads++, show(web("b")), true);
    await ctx.sendMessage();
    assert.deepStrictEqual([loads, ...errors], [1, "当前网页不是支持的视频页"]);
    // No enabled platform: the conversation and the typed text stay, and the settings page opens.
    let resets = 0;
    let opened = 0;
    ctx.resetConversationView = () => resets++;
    ctx.showConversationContextNotice = () => {};
    ctx.chrome.runtime.openOptionsPage = () => opened++;
    show(video);
    vm.runInContext('els.input.value = "q"; els.modelSelect.value = ""', ctx);
    await ctx.sendMessage();
    assert.deepStrictEqual([resets, opened, loads, vm.runInContext("els.input.value", ctx)], [0, 1, 1, "q"]);
    ctx.resetConversationView = () => {};
    // 快捷追问 and 重试 send their own text: the draft in the input box stays as typed.
    const asked = [];
    const realConnect = ctx.chrome.runtime.connect;
    const [realUser, realPlaceholder] = [ctx.appendUserMessage, ctx.appendAssistantPlaceholder];
    ctx.chrome.runtime.connect = () => ({ onMessage: { addListener() {} }, onDisconnect: { addListener() {} }, postMessage() {}, disconnect() {} });
    ctx.appendUserMessage = (text) => asked.push(text);
    ctx.appendAssistantPlaceholder = () => stubEl();
    ctx.ensureCurrentContextForSend = async () => true;
    state.dispatch({ type: "NEW" });
    show(video);
    vm.runInContext('els.input.value = "还没写完的草稿"; els.modelSelect.value = "p"', ctx);
    await ctx.sendMessage("快捷追问的话");
    assert.deepStrictEqual([asked, vm.runInContext("els.input.value", ctx)], [["快捷追问的话"], "还没写完的草稿"]);
    assert.ok(/sendPrompt\(prompt\) \{\n  void sendMessage\(prompt\);/.test(page) && page.includes("    void sendMessage(prompt);\n  });"), "快捷追问 and 重试 pass their text");
    vm.runInContext("activeStream = null", ctx);
    Object.assign(ctx, { appendUserMessage: realUser, appendAssistantPlaceholder: realPlaceholder });
    ctx.chrome.runtime.connect = realConnect;
  }

  {
    // 写入 Obsidian: one write-video-note with this conversation (and the open page's note when the tab shows the video).
    // ask → the dialog → the same request with the mode; 取消, or a conversation switched meanwhile, sends nothing again.
    const sent = [];
    const shown = [];
    let choice;
    let asked;
    ctx.showConversationContextNotice = (text, ms, opts) => shown.push([text, opts?.error]);
    ctx.MdgOverwriteDialog = { choose: async (path, opts) => ((asked = [path, opts.hasAiSection]), choice()) };
    const realSend = ctx.sendRuntimeMessage;
    ctx.sendRuntimeMessage = async (m) => (sent.push(m), m.mode ? { ok: true, path: "p.md", kind: m.mode, text: `已更新 AI 问答：p.md` } : { ok: true, ask: true, path: "p.md", hasAiSection: true });
    const write = async (pick, tab) => {
      sent.length = 0;
      shown.length = 0;
      choice = pick;
      chatOn(video);
      show(tab);
      await ctx.saveCurrentConversationToObsidian();
      return sent.map((m) => m.mode || "-").join();
    };
    // The page is not open: no page note.
    activeTab = { id: 3, url: "https://example.com/" };
    assert.strictEqual(await write(() => "ai", web("x")), "-,ai");
    assert.deepStrictEqual([asked, sent[1].conversation.messages[0].content, sent[1].ref.videoId, sent[1].page, shown.at(-1)], [["p.md", true], "这个视频", "BV1xx411c7mD", undefined, ["已更新 AI 问答：p.md", undefined]]);
    assert.strictEqual(await write(() => "", web("x")), "-", "取消: nothing sent again");
    assert.deepStrictEqual(shown.at(-1), [ctx.MdgErrors.TEXT.obsidianCancelled, undefined]);
    assert.strictEqual(await write(() => (state.dispatch({ type: "NEW" }), "full"), web("x")), "-", "switched during the dialog");
    // H1: said like the video page's, not as a red failure.
    assert.deepStrictEqual(shown.at(-1), [ctx.MdgErrors.TEXT.obsidianConvSwitched, undefined]);
    // The tab shows this video: its settled note goes along.
    activeTab = { id: 4, url: video.url };
    const realTab = ctx.sendMessageToActiveTab;
    // G3: with the page's subtitle state, so the result starts with it as for a note the background builds.
    ctx.sendMessageToActiveTab = async (id, m) => (m.type === "popup-refresh" ? { ok: true, payload: { url: video.url, markdown: "# 页面", cover: "c", noteWarning: "未登录 B站，拿不到字幕。" } } : null);
    await write(() => "full", video);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(sent[1].page)), { markdown: "# 页面", cover: "c", warning: "未登录 B站，拿不到字幕。" });
    ctx.sendMessageToActiveTab = realTab;
    ctx.sendRuntimeMessage = realSend;

    // A failed write is red; only not set up or a wrong key (code OBSIDIAN) opens the settings page, not a closed Obsidian.
    const notices = [];
    let settings = 0;
    ctx.showConversationContextNotice = (text, ms, opts) => notices.push([text, opts?.error]);
    ctx.chrome.runtime.openOptionsPage = () => settings++;
    const E = ctx.MdgErrors;
    ctx.showObsidianFailure(E.fromResp({ ok: false, error: E.TEXT.obsidianKey, code: "OBSIDIAN" }, "Local API 写入失败"));
    ctx.showObsidianFailure(E.fromResp({ ok: false, error: "Obsidian 返回 HTTP 500" }, "Local API 写入失败"));
    ctx.showObsidianFailure(E.fromResp({ ok: false, error: E.TEXT.obsidianDown, code: "OBSIDIAN_DOWN" }, "Local API 写入失败"));
    assert.deepStrictEqual(notices, [[`写入 Obsidian 失败：${E.TEXT.obsidianKey}`, true], ["写入 Obsidian 失败：Obsidian 返回 HTTP 500", true], [`写入 Obsidian 失败：${E.TEXT.obsidianDown}`, true]]);
    assert.strictEqual(settings, 1);
  }

  {
    // AI 总结 (popup, player ✦, 专注模式, 分拣台's viewer): one SUMMARY. A request with a video reference goes straight
    // to it; one about the tab's video reads the tab first. A request for another tab is not taken.
    const calls = [];
    const realAct = ctx.act;
    const realLoad = ctx.loadContextState;
    ctx.act = async (event) => (calls.push([event.type, event.ref?.videoId || ""]), []);
    ctx.loadContextState = async () => (calls.push(["load"]), true);
    activeTab = { id: 7, url: "chrome-extension://test/triage/triage.html" };
    const req = (extra) => ({ id: `q${Math.random()}`, tabId: activeTab.id, prompt: "总结", createdAt: Date.now(), ...extra });
    assert.strictEqual(await ctx.handlePlayerAiQuickActionRequest(req({ contextRef: { site: "bilibili", videoId: "BV1xx" } })), true);
    assert.strictEqual(await ctx.handlePlayerAiQuickActionRequest(req()), true);
    assert.strictEqual(await ctx.handlePlayerAiQuickActionRequest(req({ tabId: 99 })), false);
    assert.deepStrictEqual(calls, [["SUMMARY", "BV1xx"], ["load"], ["SUMMARY", ""]]);
    Object.assign(ctx, { act: realAct, loadContextState: realLoad });
  }

  {
    // A timestamp clicked while 分拣台's viewer plays the video seeks that frame; the 分拣台 tab is not navigated.
    // A normal tab on another video still goes to the video first.
    const updates = [];
    const seeks = [];
    ctx.showConversationContextNotice = () => {};
    ctx.chrome.runtime.getURL = (p) => `chrome-extension://test/${p}`;
    ctx.chrome.tabs.update = async (id, props) => updates.push(props.url);
    ctx.chrome.tabs.get = async () => ({ status: "complete" });
    ctx.chrome.tabs.sendMessage = (id, msg, cb) => (seeks.push(msg), cb({ ok: true }));
    state.dispatch({ type: "NEW" });
    show(video);
    activeTab = { id: 7, url: "chrome-extension://test/triage/triage.html" };
    await ctx.jumpToAssistantTimestamp(75, "1:15");
    activeTab = { id: 8, url: "https://www.bilibili.com/video/BV1GJ411x7h7" };
    await ctx.jumpToAssistantTimestamp(5, "0:05");
    assert.deepStrictEqual(updates, ["https://www.bilibili.com/video/BV1xx411c7mD"], "only the normal tab navigates");
    assert.deepStrictEqual(seeks.map((m) => [m.seconds, m.videoId]), [[75, "BV1xx411c7mD"], [5, ""]]);
    ctx.chrome.runtime.getURL = (p) => p;
  }

  {
    // 新对话 while the AI is still answering keeps the reply: the port stays open and the reply knows its saved
    // conversation. Deleting that conversation cuts it off.
    const realLoad = ctx.loadContextState;
    ctx.loadContextState = async () => true;
    let closed = 0;
    const stream = { prompt: "还在回答", raw: "", port: { disconnect: () => closed++ } };
    state.dispatch({ type: "SAVED_CHANGED", list: [] });
    state.dispatch({ type: "NEW" });
    show(video);
    ctx.stream = stream;
    vm.runInContext("activeStream = stream", ctx);
    state.dispatch({ type: "SEND", prompt: "还在回答" });
    await ctx.startNewConversation();
    assert.strictEqual(closed, 0, "the reply is not cut off");
    assert.deepStrictEqual([vm.runInContext("activeStream", ctx), view().saved[0]?.messages[0]?.content, stream.conversationId === view().saved[0]?.id, view().messages.length], [null, "还在回答", true, 0]);
    // The reply ends: its answer goes after its question.
    stream.raw = "答";
    ctx.endStream(stream);
    await new Promise((r) => setImmediate(r));
    assert.deepStrictEqual([...view().saved[0].messages].map((m) => m.content), ["还在回答", "答"]);
    closed = 0;
    // Delete while answering: the shown conversation's reply is dropped.
    chatOn(video);
    const doomed = { prompt: "q", raw: "", port: { disconnect: () => closed++ } };
    ctx.stream = doomed;
    vm.runInContext("activeStream = stream", ctx);
    state.dispatch({ type: "SEND", prompt: "q" });
    ctx.confirm = () => true;
    await ctx.deleteConversation(view().id);
    assert.deepStrictEqual([closed, vm.runInContext("activeStream", ctx), view().id], [1, null, ""]);
    ctx.loadContextState = realLoad;
  }

  {
    // The draft follows what state says: cleared for another conversation, then AI 总结 puts its prompt there.
    const input = vm.runInContext("els.input", ctx);
    input.value = "草稿";
    await ctx.act({ type: "NEW" });
    assert.strictEqual(input.value, "", "another conversation");
    input.value = "草稿";
    state.dispatch({ type: "SAVED_CHANGED", list: [] });
    show(video);
    await ctx.act({ type: "SUMMARY", prompt: "总结" });
    assert.strictEqual(input.value, "总结", "AI 总结 replaces the draft");
  }

  {
    // A video opened from 分拣台 or 视频记录 is loading until its context resolves: the 快捷追问 say why they wait. A
    // failed load ends it, and the error says what happened.
    let pendingAtLoad;
    ctx.hydratePinnedConversationContext = async () => (pendingAtLoad = view().context.pending);
    ctx.showConversationContextNotice = () => {};
    show(web("triage"));
    vm.runInContext("els.input.disabled = false; activeStream = null", ctx);
    await ctx.act({ type: "SUMMARY", prompt: "总结", ref: { site: "bilibili", videoId: "BV1xx411c7mD", url: video.url, title: "t" } });
    assert.strictEqual(pendingAtLoad, true);
    assert.strictEqual(ctx.followupBlockReason(), "正在读取视频字幕…");
    ctx.hydratePinnedConversationContext = real.hydratePinnedConversationContext;
    const realResolve = ctx.resolveConversationContext;
    ctx.resolveConversationContext = async () => ({ ok: false, error: "x" });
    ctx.showConversationContextError = () => {};
    ctx.removeConversationContextNotice = () => {};
    assert.strictEqual(await ctx.hydratePinnedConversationContext(), false);
    assert.strictEqual(view().context.pending, false);
    ctx.resolveConversationContext = realResolve;
  }

  {
    // 分拣台's viewer: its AI 总结 names the frame, and the panel asks that frame for the video like a video page, so the
    // track picked in its 专注模式 is what the AI reads, also when picked later. Once the viewer is closed, the video is
    // read like a closed video page's.
    const realSend = ctx.sendRuntimeMessage;
    const asked = [];
    let frame = { ...video, selectedSubtitleId: "en", subtitleMarkdown: "英文字幕" };
    ctx.sendRuntimeMessage = async (msg) => {
      asked.push([msg.type, msg.frameId || 0, msg.videoId || ""]);
      if (msg.type === "ai-sidepanel-get-state" && !msg.frameId) return webPage("triage");
      if (msg.type === "ai-sidepanel-get-state") return frame ? { ok: true, payload: frame } : { ok: false, error: "Could not establish connection. Receiving end does not exist." };
      // I10: only what the background reads.
      if (msg.type === "ai-sidepanel-resolve-context") assert.deepStrictEqual(Object.keys(msg), ["type", "contextRef"]);
      if (msg.type === "ai-sidepanel-resolve-context") return { ok: true, payload: { ...video, selectedSubtitleId: "zh", subtitleMarkdown: "中文字幕" } };
      return { ok: true };
    };
    ctx.showConversationContextNotice = () => {};
    ctx.removeConversationContextNotice = () => {};
    activeTab = { id: 7, url: "chrome-extension://test/triage/triage.html" };
    show(web("triage"));
    const fromViewer = (id) => ctx.handlePlayerAiQuickActionRequest({ id, tabId: 7, prompt: "总结", createdAt: Date.now(), frameId: 3, contextRef: { site: "bilibili", videoId: video.videoId, url: video.url, title: "T" } });
    await fromViewer("v1");
    assert.strictEqual(view().context.subtitleMarkdown, "英文字幕", "the viewer frame's picked track");
    assert.deepStrictEqual(asked, [["ai-sidepanel-get-state", 3, video.videoId]], "asked the frame, no background re-read");
    frame = { ...frame, selectedSubtitleId: "ja", subtitleMarkdown: "日文字幕" };
    assert.strictEqual(await real.ensureCurrentContextForSend(), true);
    assert.strictEqual(view().context.subtitleMarkdown, "日文字幕", "a track picked since: asked again at send");
    // A6: the viewer played on into P2: its answer is not this conversation's P1.
    frame = { ...frame, pageIndex: 2, subtitleMarkdown: "P2 字幕" };
    assert.strictEqual(await real.ensureCurrentContextForSend(), true);
    assert.deepStrictEqual([view().context.subtitleMarkdown, view().pinned.contextRef.pageIndex], ["日文字幕", 1]);
    frame = { ...frame, pageIndex: 1 };

    // Viewer closed: the frame does not answer, so the panel reads the video like a closed page, then stops asking it.
    frame = null;
    asked.length = 0;
    state.dispatch({ type: "NEW" });
    await fromViewer("v2");
    assert.strictEqual(view().context.subtitleMarkdown, "中文字幕");
    assert.deepStrictEqual(asked, [["ai-sidepanel-get-state", 3, video.videoId], ["ai-sidepanel-resolve-context", 0, ""]]);
    assert.strictEqual(vm.runInContext("viewerFrame", ctx), null);
    ctx.sendRuntimeMessage = realSend;
  }

  {
    // 导出对话 is disabled with its reason until there is a question with an answer.
    ctx.renderFollowups = () => {};
    const exportState = () => vm.runInContext("activeStream = null; setStreamingUiState(false); [els.exportBtn.disabled, els.exportBtn.title]", ctx);
    state.dispatch({ type: "NEW" });
    show(video);
    assert.deepStrictEqual([...exportState()], [true, "当前没有可导出的对话"]);
    chatOn(video);
    assert.deepStrictEqual([...exportState()], [false, "导出整段对话"]);
  }

  // get-settings fails: the defaults stand in, so AI 总结 and the 快捷追问 do not vanish.
  {
    const realSend = ctx.sendRuntimeMessage;
    ctx.document.body = stubEl();
    for (const f of ["renderModelSelect", "renderPresetPrompts", "renderFollowups"]) ctx[f] = () => {};
    ctx.sendRuntimeMessage = async (msg) => (msg.type === "get-settings" ? Promise.reject(new Error("worker gone")) : { ok: true, providers: [] });
    await ctx.loadProvidersAndPrefs();
    const prefs = vm.runInContext("aiPrefs", ctx);
    assert.strictEqual(prefs.playerAiQuickPrompt, ctx.MdgSettings.DEFAULTS.playerAiQuickPrompt);
    assert.deepStrictEqual([...prefs.aiPresetPrompts], [...ctx.MdgSettings.DEFAULTS.aiPresetPrompts]);
    // A33: but they are not the user's list, so neither 添加 nor 删除 saves them over it.
    const saves = [];
    ctx.sendRuntimeMessage = async (msg) => (saves.push(msg.type), { ok: true });
    vm.runInContext('els.presetInput.value = "新的"', ctx);
    assert.strictEqual(vm.runInContext("presetAddReason()", ctx), "读取设置失败，暂时不能修改快捷追问");
    await ctx.addPresetPrompt();
    await ctx.removePresetPrompt(0);
    assert.deepStrictEqual(saves, []);
    vm.runInContext("settingsReadFailed = false", ctx);
    ctx.sendRuntimeMessage = realSend;
  }

  // A history conversation whose B站 video was deleted or hidden: said once as such, not as a read error to retry.
  {
    const errors = [];
    ctx.showConversationContextError = (text) => errors.push(text);
    ctx.removeConversationContextNotice = () => {};
    const realResolve = ctx.resolveConversationContext;
    show(web("x"));
    state.dispatch({ type: "SAVED_CHANGED", list: [{ id: "gone", contextUrl: video.url, contextRef: { url: video.url }, messages: [{ role: "user", content: "q" }] }] });
    state.dispatch({ type: "OPEN", id: "gone" });
    for (const code of [-404, -352, "THROTTLED"]) {
      ctx.resolveConversationContext = async () => ({ ok: false, error: "啥都木有", code });
      assert.strictEqual(await ctx.hydratePinnedConversationContext(), false);
    }
    // A B站 limit reads as everywhere else (MdgErrors.text), not as the background's own words.
    assert.deepStrictEqual(errors, ["视频已失效，这段对话只能查看，不能继续提问。", "读取原视频失败：啥都木有", "读取原视频失败：B站限流，请稍后再试"]);
    ctx.resolveConversationContext = realResolve;
  }

  // A bad key, used-up quota, unreachable platform or timeout offers 去设置 before 重试, as 分拣台 does; others only 重试.
  {
    const errorButtons = (code) => {
      const kids = [];
      ctx.appendStreamError({ node: { appendChild: (c) => kids.push(c) }, prompt: "q", raw: "" }, "x", false, code);
      return kids.slice(1).map((k) => (typeof k.textContent === "string" ? k.textContent : k.innerHTML.replace(/<[^>]*>/g, "")));
    };
    assert.deepStrictEqual(errorButtons("AI_QUOTA"), ["去设置", "重试"]);
    assert.deepStrictEqual(errorButtons("AI_NETWORK"), ["去设置", "重试"]);
    assert.deepStrictEqual(errorButtons("AI_TIMEOUT"), ["去设置", "重试"]);
    assert.deepStrictEqual(errorButtons("AI_THROTTLED"), ["重试"]);
  }

  // Saved conversations: the video's title, the question and the AI's answer, in the history list and 上一个视频.
  ctx.renderPreviousVideoBar = real.renderPreviousVideoBar;
  for (const bad of XSS) {
    const conv = (id) => ({ id, title: bad, contextTitle: bad, updatedAt: 1, messages: [{ role: "user", content: bad }, { role: "assistant", content: bad }] });
    state.dispatch({ type: "SAVED_CHANGED", list: [conv("now"), conv("before")] });
    state.dispatch({ type: "OPEN", id: "now" });
    state.dispatch({ type: "PREVIOUS_LOADED", id: "before" });
    vm.runInContext('previousVideoExpanded = true; previousVideoBarSignature = ""', ctx);
    const els = vm.runInContext("els", ctx);
    els.historyList.querySelectorAll = () => [];
    realRenderHistoryList();
    assertInert(els.historyList.innerHTML, "history list");
    assertInert(els.previousVideoBar.innerHTML, "previous video");
  }

  // Without subtitles the intro says why in the video page's sentence (MdgErrors.subtitleMissing).
  {
    let n = 0;
    const intro = (fields) => {
      const id = `BV1intro${++n}`;
      state.dispatch({ type: "NEW" });
      show({ ...video, url: `https://www.bilibili.com/video/${id}`, videoId: id, subtitleMarkdown: "", ...fields });
      return ctx.introText();
    };
    assert.deepStrictEqual(
      [intro({}), intro({ subtitleFailure: "网络断了" }), intro({ subtitleNeedLogin: true })],
      ["视频没有字幕，AI 只能读标题、简介和评论。", "字幕抓取失败：网络断了，AI 只能读标题、简介和评论。", "未登录 B站，拿不到字幕，AI 只能读标题、简介和评论。登录 B站后刷新网页。"]
    );
  }

  // 分拣台 finishing 细看 on the open video shows its AI 总结 card at once; another video's result changes nothing.
  {
    const card = [];
    const node = { querySelector: () => null, insertAdjacentHTML: (_, html) => card.push(html) };
    vm.runInContext("suggestionsNode = globalThis.__node", Object.assign(ctx, { __node: node }));
    state.dispatch({ type: "NEW" });
    show(video);
    const analysis = { status: "done", verdict: "keep", oneLiner: "一句话", points: ["要点"] };
    ctx.chrome.storage.local.get = async (k) => (k === "triage_analysis_BV1xx411c7mD" ? { [k]: analysis } : {});
    ctx.followTriageAnalysis({ triage_analysis_BV2other: { newValue: analysis } });
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(card.length, 0, "another video's analysis is not shown");
    ctx.followTriageAnalysis({ triage_analysis_BV1xx411c7mD: { newValue: analysis } });
    await new Promise((r) => setImmediate(r));
    assert.ok(card.length === 1 && card[0].includes("分拣台的 AI 总结") && card[0].includes("一句话"), "the card appears");
    ctx.chrome.storage.local.get = async () => ({});
    assert.ok(page.includes('if (areaName === "local") followTriageAnalysis(changes);'), "the storage listener follows analyses");
  }

  // 导出对话: any conversation change closes its menu; with nothing to export the button and every item are disabled
  // and say why, instead of answering a click with 「当前没有可复制的对话」.
  {
    const els = vm.runInContext("els", ctx);
    state.dispatch({ type: "SAVED_CHANGED", list: [{ id: "x1", contextUrl: video.url, isVideoContext: true, messages: [{ role: "user", content: "q" }, { role: "assistant", content: "a" }] }] });
    await ctx.act({ type: "OPEN", id: "x1" });
    ctx.setStreamingUiState(false);
    assert.deepStrictEqual([els.copyConversationBtn.disabled, els.exportBtn.disabled], [false, false]);
    els.exportPopover.hidden = false;
    await ctx.act({ type: "NEW" });
    ctx.setStreamingUiState(false);
    assert.strictEqual(els.exportPopover.hidden, true, "a conversation change closes the menu");
    for (const b of ["exportBtn", "copyConversationBtn", "downloadConversationBtn", "saveConversationBtn"]) {
      assert.deepStrictEqual([b, els[b].disabled, els[b].title], [b, true, "当前没有可导出的对话"]);
    }
    // H10: after 写入 Obsidian the buttons are recomputed for the conversation now open, never just switched back on.
    els.saveConversationBtn.disabled = false;
    vm.runInContext("syncExportButtons()", ctx);
    assert.deepStrictEqual([els.saveConversationBtn.disabled, els.saveConversationBtn.title], [true, "当前没有可导出的对话"]);
    // K8: 下载 .md failing to read the note's extras says so in red, not 「没有可下载的对话」.
    await ctx.act({ type: "OPEN", id: "x1" });
    const realGet = ctx.chrome.storage.local.get;
    const said = [];
    ctx.chrome.storage.local.get = async () => Promise.reject(new Error("读不到"));
    ctx.showConversationContextNotice = (text, ms, opts) => said.push([text, opts?.error]);
    await ctx.downloadCurrentConversation();
    ctx.chrome.storage.local.get = realGet;
    ctx.showConversationContextNotice = () => {};
    assert.deepStrictEqual(said, [["下载失败：读不到", true]]);
    // A32: during a write a reply starting or ending (which recomputes the buttons) leaves 写入 Obsidian off, and a
    // second write is not started.
    const realSend = ctx.sendRuntimeMessage;
    let finish;
    let writes = 0;
    ctx.sendRuntimeMessage = (m) => (writes++, new Promise((r) => (finish = () => r({ ok: true, text: "已写入" }))));
    els.syncStatus.hidden = false;
    const writing = ctx.saveCurrentConversationToObsidian();
    await new Promise((r) => setImmediate(r));
    ctx.setStreamingUiState(false);
    assert.deepStrictEqual([els.saveConversationBtn.disabled, els.saveConversationBtn.title], [true, ctx.MdgErrors.TEXT.obsidianWriting]);
    void ctx.saveCurrentConversationToObsidian();
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(writes, 1, "no second write");
    finish();
    await writing;
    // A38: a manual write that succeeded clears the auto-sync status.
    assert.deepStrictEqual([els.saveConversationBtn.disabled, els.syncStatus.hidden], [false, true]);
    ctx.sendRuntimeMessage = realSend;
    // A38: another conversation clears it too.
    els.syncStatus.hidden = false;
    await ctx.act({ type: "NEW" });
    assert.strictEqual(els.syncStatus.hidden, true);
    // H14: 发送 says why it is off: while stopping, and on a page that is not a supported video page.
    ctx.setStreamingUiState(true, { stopping: true });
    assert.deepStrictEqual([els.sendBtn.disabled, els.sendBtn.title], [true, "正在停止生成"]);
    ctx.setStreamingUiState(false);
    assert.deepStrictEqual([els.sendBtn.disabled, els.sendBtn.title], [false, ""]);
    show(web("h14"));
    ctx.setStreamingUiState(false);
    assert.deepStrictEqual([view().nonVideo, els.sendBtn.disabled, els.sendBtn.title], [true, true, ctx.MdgErrors.TEXT.notVideoPage]);
    // K2: the quick prompts say the same as 发送.
    assert.strictEqual(vm.runInContext("providers = [{}]; followupBlockReason()", ctx), ctx.MdgErrors.TEXT.notVideoPage);
    show(video);
    ctx.setStreamingUiState(false);
  }

  // 快捷追问's 添加: disabled with the reason while the box is empty or the list is full.
  {
    const els = vm.runInContext("els", ctx);
    const prefs = vm.runInContext("aiPrefs", ctx);
    els.presetInput.value = " ";
    prefs.aiPresetPrompts = [];
    vm.runInContext("syncPresetAdd()", ctx);
    assert.deepStrictEqual([els.presetAddBtn.disabled, els.presetAddBtn.title], [true, "先输入快捷追问"]);
    els.presetInput.value = "再讲讲";
    vm.runInContext("syncPresetAdd()", ctx);
    assert.strictEqual(els.presetAddBtn.disabled, false);
    // H13: one already listed is not added again: disabled with the reason, the box keeps the text.
    prefs.aiPresetPrompts = ["再讲讲"];
    vm.runInContext("syncPresetAdd()", ctx);
    assert.deepStrictEqual([els.presetAddBtn.disabled, els.presetAddBtn.title], [true, "已有这条快捷追问"]);
    prefs.aiPresetPrompts = Array.from({ length: ctx.MdgSettings.MAX_PRESET_PROMPTS }, (_, i) => `q${i}`);
    vm.runInContext("syncPresetAdd()", ctx);
    assert.deepStrictEqual([els.presetAddBtn.disabled, els.presetAddBtn.title], [true, `最多 ${ctx.MdgSettings.MAX_PRESET_PROMPTS} 条快捷追问，先删掉一条再添加`]);
    prefs.aiPresetPrompts = [];
    // A35: save-settings refused the list: it stays as it was, the typed text too, and the reason shows in red.
    const realSend = ctx.sendRuntimeMessage;
    const said = [];
    ctx.showConversationContextNotice = (text, ms, opts) => said.push([text, opts?.error]);
    ctx.sendRuntimeMessage = async () => ({ ok: false, error: "同步存储已满" });
    els.presetInput.value = "再讲讲";
    await ctx.addPresetPrompt();
    assert.deepStrictEqual([[...vm.runInContext("aiPrefs", ctx).aiPresetPrompts], els.presetInput.value, said], [[], "再讲讲", [["保存设置失败：同步存储已满", true]]]);
    ctx.sendRuntimeMessage = async () => ({ ok: true });
    await ctx.addPresetPrompt();
    assert.deepStrictEqual([[...vm.runInContext("aiPrefs", ctx).aiPresetPrompts], els.presetInput.value], [["再讲讲"], ""]);
    vm.runInContext("aiPrefs.aiPresetPrompts = []", ctx);
    ctx.sendRuntimeMessage = realSend;
    ctx.showConversationContextNotice = () => {};
  }

  // A7: a reply that failed before a word: a redraw (去设置, a focus change) draws its question and error again.
  {
    const drawn = [];
    const prev = [ctx.appendUserMessage, ctx.appendStreamError, ctx.removeConversationContextNotice];
    ctx.appendUserMessage = (text) => drawn.push(text);
    ctx.appendStreamError = (turn, error, saved, code) => drawn.push([turn.prompt, error, code]);
    ctx.removeConversationContextNotice = () => {};
    state.dispatch({ type: "NEW" });
    show(video);
    const stream = { prompt: "问", raw: "", notice: "", node: stubEl(), port: { disconnect() {} } };
    ctx.stream = stream;
    vm.runInContext("activeStream = stream", ctx);
    state.dispatch({ type: "SEND", prompt: "问" });
    ctx.endStream(stream, { error: "余额不足", code: "AI_QUOTA" });
    drawn.length = 0;
    real.renderInitialState();
    assert.deepStrictEqual(drawn, ["问", ["问", "余额不足", "AI_QUOTA"]]);
    [ctx.appendUserMessage, ctx.appendStreamError, ctx.removeConversationContextNotice] = prev;
  }

  // A34: no AI platform: a conversation stays on screen (sending says why); an empty one offers to add a platform.
  {
    const calls = [];
    const prev = [ctx.renderConversationMessages, ctx.resetConversationView];
    ctx.renderConversationMessages = () => calls.push("messages");
    ctx.resetConversationView = (html) => calls.push(`reset:${html}`);
    vm.runInContext("providers = []", ctx);
    chatOn(video);
    real.renderInitialState();
    state.dispatch({ type: "NEW" });
    real.renderInitialState();
    assert.deepStrictEqual(calls, ["messages", "reset:"]);
    vm.runInContext("providers = [{}]", ctx);
    // A37: the context read failed: the empty state and a send say why (B站 限流 here), not only 读取当前页面失败.
    calls.length = 0;
    state.dispatch({ type: "CONTEXT_ARRIVED", payload: null, error: "B站限流，请稍后再试" });
    real.renderInitialState();
    const realLoad = ctx.loadContextState;
    ctx.loadContextState = async () => false;
    assert.strictEqual(await real.ensureCurrentContextForSend(), false);
    assert.deepStrictEqual(calls, ["reset:B站限流，请稍后再试", "reset:B站限流，请稍后再试"]);
    // A36: a question sent while 重试 reads the page: the empty state is not redrawn over it and its reply.
    calls.length = 0;
    const prevInitial = ctx.renderInitialState;
    ctx.renderInitialState = () => calls.push("initial");
    ctx.loadContextState = async () => (vm.runInContext("activeStream = {}", ctx), true);
    await ctx.refreshContextManually();
    assert.deepStrictEqual(calls, []);
    vm.runInContext("activeStream = null", ctx);
    ctx.loadContextState = realLoad;
    ctx.renderInitialState = prevInitial;
    [ctx.renderConversationMessages, ctx.resetConversationView] = prev;
    show(video);
  }

  // A8: a notice shown while the reply streams stays: only the first token clears the slow notice.
  {
    let cleared = 0;
    const prev = ctx.removeConversationContextNotice;
    ctx.removeConversationContextNotice = () => cleared++;
    vm.runInContext("streamFirstTokenReceived = false", ctx);
    ctx.handleFirstStreamToken();
    ctx.handleFirstStreamToken();
    ctx.handleFirstStreamToken();
    assert.strictEqual(cleared, 1);
    ctx.removeConversationContextNotice = prev;
  }

  // Each reply's copy button is named per the 用词表: 复制 Markdown, never a bare 复制.
  assert.ok(page.includes("<span>${MdgErrors.LABEL.copyMd}</span>") && !page.includes("<span>复制</span>"), "a reply's copy button says 复制 Markdown");

  // B3: a failed auto-sync to Obsidian offers 去设置 before 重试 when the fix is in the settings page, like a manual write;
  // a closed Obsidian gets 重试 only.
  {
    const prev = [ctx.showSyncStatus, ctx.sendRuntimeMessage];
    const shown = [];
    ctx.showSyncStatus = (text, opts = {}) => shown.push([Boolean(opts.error), Boolean(opts.settings), Boolean(opts.retry)]);
    state.dispatch({ type: "SAVED_CHANGED", list: [{ id: "s", contextRef: { site: "bilibili", videoId: "BV1sync" }, messages: [{ role: "user", content: "q" }] }] });
    for (const code of ["OBSIDIAN", "OBSIDIAN_DOWN"]) {
      ctx.sendRuntimeMessage = async () => ({ ok: false, error: "x", code });
      await ctx.autoSyncConversation("s");
    }
    assert.deepStrictEqual(shown, [[true, true, true], [true, false, true]]);
    [ctx.showSyncStatus, ctx.sendRuntimeMessage] = prev;
  }

  // B4: a failed copy is red, from the export menu and from a reply's own 复制 alike.
  {
    const prev = [ctx.showConversationContextNotice, ctx.buildCurrentConversationNote];
    const notices = [];
    ctx.showConversationContextNotice = (text, ms, opts) => notices.push([text.split("：")[0], Boolean(opts?.error)]);
    ctx.navigator.clipboard = { writeText: async () => { throw new Error("无法访问剪贴板"); } };
    ctx.buildCurrentConversationNote = async () => ({ content: "x" });
    await ctx.copyCurrentConversationMarkdown();
    assert.strictEqual(await ctx.copyText("x"), false, "a reply's 复制 reports a failure");
    assert.deepStrictEqual(notices, [["复制失败", true], ["复制失败", true]]);
    delete ctx.navigator.clipboard;
    [ctx.showConversationContextNotice, ctx.buildCurrentConversationNote] = prev;
  }

  console.log("sidepanel selftest: all passed");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
