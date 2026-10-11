// node extension/sidepanel.selftest.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

// sidepanel.js is a DOM page: drop init(), stub the DOM, and drive the context loads by hand.
const source = fs.readFileSync(path.join(__dirname, "sidepanel.js"), "utf8").replace(/^init\(\)\.catch\(/m, "(async () => {})().catch(");
assert.ok(source.includes("(async () => {})().catch("), "harness strips the page entry point");

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
// The page's own functions, for the behaviour tests below that need them past the stubs.
const real = Object.fromEntries(["restartChat", "renderSuggestions", "fillPrompt", "applyConversation", "startNewConversation", "hydratePinnedConversationContext"].map((f) => [f, ctx[f]]));
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
  assert.deepStrictEqual([loads, ...errors], [1, "当前网页不是支持的视频页"], "the context that came back is checked too");
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
    const shown = [];
    ctx.showConversationContextNotice = (text) => shown.push(text);
    const realSend = ctx.sendRuntimeMessage;
    ctx.sendRuntimeMessage = async (msg) => {
      sent.push(msg);
      if (msg.type === "get-settings") {
        vm.runInContext('chatHistory = [{ role: "user", content: "别的视频" }, { role: "assistant", content: "别的回答" }]; conversationEpoch += 1', ctx);
        return { ok: true, settings: { obsidianApiBaseUrl: "http://127.0.0.1:27123", obsidianApiKey: "k" } };
      }
      if (msg.type === "triage-build-note") return { ok: true, data: { title: "T", markdown: "m", path: "B站/UP/T.md", cover: { url: "https://i0.hdslb.com/a.jpg", name: "bilibili-BV1xx411c7mD" }, subtitleWarning: "字幕时间可能对不上。" } };
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
    // A subtitle that does not match the video's length leads the result line, as on the video page.
    assert.strictEqual(shown.at(-1), "字幕时间可能对不上。已写入 Obsidian：B站/UP/T.md");
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

    // The same write with the video page open: the page's failure shows once, with one prefix, and a write the page
    // did not make for another reason (the video switched) is said as it is, not as a failure.
    const saved = Object.fromEntries(["loadObsidianSettings", "syncVideoNoteAiSection", "sendMessageToActiveTab"].map((k) => [k, ctx[k]]));
    const url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
    let reply;
    Object.assign(ctx, {
      loadObsidianSettings: async () => ({ settings: {}, baseUrl: "http://127.0.0.1:27123", apiKey: "k" }),
      syncVideoNoteAiSection: async () => ({ exists: false, filepath: "p.md" }),
      sendMessageToActiveTab: async () => reply,
      yt: { url, site: "youtube", videoId: "dQw4w9WgXcQ", isVideoContext: true, title: "Y" }
    });
    activeTab = { id: 4, url };
    vm.runInContext('contextData = yt; liveContextData = yt; liveTabUrl = yt.url; currentConversationMeta = null; chatHistory = [{ role: "user", content: "q" }, { role: "assistant", content: "a" }]', ctx);
    notices.length = 0;
    reply = { ok: false, error: E.TEXT.obsidianDown, code: "OBSIDIAN_DOWN", payload: { message: `写入 Obsidian 失败：${E.TEXT.obsidianDown}` } };
    await ctx.saveCurrentConversationToObsidian();
    reply = { ok: true, payload: { message: "视频已切换，未写入 Obsidian。" } };
    await ctx.saveCurrentConversationToObsidian();
    assert.deepStrictEqual(notices.filter(([text]) => !text.startsWith("正在")), [[`写入 Obsidian 失败：${E.TEXT.obsidianDown}`, true], ["视频已切换，未写入 Obsidian。", undefined]]);
    assert.strictEqual(settings, 1, "a closed Obsidian does not open the settings page");
    Object.assign(ctx, saved);
  }

  {
    // AI 总結 from 分拣台's viewer (a video reference), the popup, the player ✦ or 专注模式: a video with a saved
    // conversation opens it and nothing is filled; only one without gets the prompt. The viewer's prompt lands in the
    // video's own conversation, not a new one, which would fall back to the tab's own page (分拣台).
    const realStart = ctx.startNewConversation;
    const realFill = ctx.fillPrompt;
    const realOpen = ctx.openRequestedVideoContext;
    const realLoad = ctx.loadConversationById;
    let calls = [];
    let saved = false;
    activeTab = { id: 7, url: "chrome-extension://test/triage/triage.html" };
    ctx.openRequestedVideoContext = async (ref) => (calls.push(["open", ref.videoId]), saved);
    ctx.startNewConversation = async () => calls.push(["new"]);
    ctx.fillPrompt = (text) => calls.push(["fill", text]);
    ctx.loadConversationById = async (id) => calls.push(["load", id]);
    const req = (extra) => ({ id: `q${Math.random()}`, tabId: activeTab.id, prompt: "总结", createdAt: Date.now(), ...extra });
    const viewer = { contextRef: { site: "bilibili", videoId: "BV1xx" } };
    assert.strictEqual(await ctx.handlePlayerAiQuickActionRequest(req(viewer)), true);
    assert.deepStrictEqual(calls.splice(0), [["open", "BV1xx"], ["fill", "总结"]]);
    saved = true;
    await ctx.handlePlayerAiQuickActionRequest(req(viewer));
    assert.deepStrictEqual(calls.splice(0), [["open", "BV1xx"]], "the viewer's video has a conversation");

    const url = "https://www.bilibili.com/video/BV1GJ411x7h7";
    activeTab = { id: 9, url };
    answer = async () => ({ ok: true, payload: { url, title: "v", site: "bilibili", videoId: "BV1GJ411x7h7", isVideoContext: true } });
    vm.runInContext("savedConversations = []; activeStream = null; currentConversationMeta = null", ctx);
    await ctx.handlePlayerAiQuickActionRequest(req());
    assert.deepStrictEqual(calls.splice(0), [["new"], ["fill", "总结"]], "no conversation yet: the summary prompt");
    ctx.conv = { id: "c1", contextUrl: url, contextRef: { site: "bilibili", videoId: "BV1GJ411x7h7", url }, messages: [] };
    vm.runInContext("savedConversations = [conv]", ctx);
    await ctx.handlePlayerAiQuickActionRequest(req());
    assert.deepStrictEqual(calls.splice(0), [["load", "c1"]], "the player ✦ opens the saved conversation");
    vm.runInContext("savedConversations = []", ctx);
    Object.assign(ctx, { startNewConversation: realStart, fillPrompt: realFill, openRequestedVideoContext: realOpen, loadConversationById: realLoad });
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
    // Following (decideFollow): a conversation with nothing asked follows any other video, also the first one after a
    // web page or an empty 问 AI conversation; one with messages follows only from the video it belongs to.
    const v = (id) => `https://www.bilibili.com/video/${id}`;
    const web = page("home").payload.url;
    const fresh = { shownUrl: web, hasMessages: false, bound: false, lastVideoUrl: "", hasContext: true };
    const pinnedEmpty = { shownUrl: v("BV1vv"), hasMessages: false, bound: true, lastVideoUrl: v("BV1ee"), hasContext: true };
    const history = { shownUrl: v("BV1hh"), hasMessages: true, bound: true, lastVideoUrl: v("BV1ee"), hasContext: true };
    const at = (state, ev) => ({ ...ctx.decideFollow(state, { stage: "payload", follow: true, keyChanged: true, ...ev }) });
    const table = [
      ["first video after a web page", fresh, { toUrl: v("BV1aa") }, "follow", v("BV1aa")],
      ["the video already shown", { ...fresh, shownUrl: v("BV1aa"), lastVideoUrl: v("BV1aa") }, { toUrl: v("BV1aa"), keyChanged: false }, "adopt", v("BV1aa")],
      ["empty 问 AI conversation, back to the video tab", pinnedEmpty, { toUrl: v("BV1ee") }, "follow", v("BV1ee")],
      ["an opened history conversation stays", history, { toUrl: v("BV1ff") }, "keep", v("BV1ff")],
      ["no video played before", { ...history, lastVideoUrl: "" }, { toUrl: v("BV1ff") }, "keep", v("BV1ff")],
      ["the conversation of the video just played", { ...history, lastVideoUrl: v("BV1hh") }, { toUrl: v("BV1ff") }, "follow", v("BV1ff")],
      // U1: any load that finds an unbound conversation on another video follows, not only a tab event.
      ["send, refresh or chip click on another video", { ...fresh, shownUrl: v("BV1aa") }, { toUrl: v("BV1bb"), follow: false }, "follow", v("BV1bb")],
      ["a web page is adopted, not followed", { ...fresh, shownUrl: v("BV1aa") }, { toUrl: "", follow: false }, "adopt", ""],
      // The panel's first load takes the tab without the AI 总结 fill.
      ["first load", { ...fresh, shownUrl: "", hasContext: false }, { toUrl: v("BV1aa") }, "adopt", v("BV1aa")],
      ["first load, not a tab event", { ...fresh, shownUrl: "", hasContext: false }, { toUrl: v("BV1aa"), follow: false }, "adopt", v("BV1aa")],
      // A load that leaves a bound conversation in place does not move lastVideoUrl, so the follow load after it still
      // sees the tab leave the video just played.
      ["non-follow load does not advance", { ...history, lastVideoUrl: v("BV1hh") }, { toUrl: v("BV1ff"), follow: false }, "keep", v("BV1hh")]
    ];
    for (const [name, state, ev, action, last] of table) assert.deepStrictEqual(at(state, ev), { action, lastVideoUrl: last }, name);
    // The tab stage acts on the tab URL alone, except a watch-later part (named by oid) and the first load.
    const tab = (state, ev) => ({ ...ctx.decideFollow(state, { stage: "tab", follow: true, oid: false, ...ev }) });
    assert.deepStrictEqual(tab(fresh, { toUrl: v("BV1aa") }), { action: "follow", lastVideoUrl: v("BV1aa") });
    assert.deepStrictEqual(tab(fresh, { toUrl: v("BV1aa"), oid: true }), { action: "none", lastVideoUrl: "" }, "oid");
    assert.deepStrictEqual(tab({ ...fresh, hasContext: false }, { toUrl: v("BV1aa") }), { action: "none", lastVideoUrl: "" }, "first load");
    assert.deepStrictEqual(tab(fresh, { toUrl: v("BV1aa"), follow: false }), { action: "none", lastVideoUrl: "" }, "not a tab event");

    // The wiring: a send's context load on an unbound conversation whose tab moved on follows the new video.
    {
      const followed = [];
      const realFollow = ctx.followLiveVideo;
      ctx.followLiveVideo = async (c) => followed.push(c.url);
      activeTab = { id: 3, url: v("BV1bb") };
      answer = async () => ({ ok: true, payload: { url: v("BV1bb"), title: "b", site: "bilibili", videoId: "BV1bb", isVideoContext: true } });
      ctx.shown = { url: v("BV1aa"), site: "bilibili", videoId: "BV1aa", isVideoContext: true };
      vm.runInContext("activeStream = null; chatHistory = []; currentConversationMeta = null; contextData = shown; currentContextKey = buildContextKey(shown); lastLiveVideoUrl = shown.url", ctx);
      assert.strictEqual(await ctx.loadContextState({ silent: true }), "followed");
      assert.deepStrictEqual(followed, [v("BV1bb")]);
      // The first load only adopts.
      vm.runInContext("contextData = null; currentContextKey = ''; lastLiveVideoUrl = ''", ctx);
      assert.strictEqual(await ctx.loadContextState({ silent: true, follow: true }), true);
      assert.deepStrictEqual(followed, [v("BV1bb")]);
      ctx.followLiveVideo = realFollow;
    }

    // AI 总结 after a video switch fills once, in the conversation it was asked for; showing another one cancels it.
    {
      const fills = [];
      ctx.fillPrompt = (text) => fills.push(text);
      ctx.renderSuggestions = real.renderSuggestions;
      ctx.renderFollowups = () => {};
      ctx.shown = { url: v("BV1aa"), title: "a", site: "bilibili", videoId: "BV1aa", isVideoContext: true, subtitleMarkdown: "s" };
      vm.runInContext('providers = [{}]; aiPrefs = { ...aiPrefs, playerAiQuickPrompt: "总结" }; suggestionsNode = document.createElement("div"); chatHistory = []; contextData = shown; summaryFillEpoch = conversationEpoch', ctx);
      ctx.renderSuggestions();
      ctx.renderSuggestions();
      assert.deepStrictEqual(fills.splice(0), ["总结"], "filled once");
      vm.runInContext('summaryFillEpoch = conversationEpoch; applyConversation({ id: "h", messages: [] }); contextData = shown', ctx);
      ctx.renderSuggestions();
      assert.deepStrictEqual(fills, [], "another conversation does not get it");
      vm.runInContext("summaryFillEpoch = conversationEpoch", ctx);
      real.restartChat();
      ctx.renderSuggestions();
      assert.deepStrictEqual(fills, [], "nor a fresh one");
      ctx.renderSuggestions = () => {};
      ctx.fillPrompt = real.fillPrompt;
    }

    // 新对话 while the AI is still answering keeps the reply: it goes on into the conversation it was asked in, like a
    // video or conversation switch. Only a delete drops it.
    {
      const realLoad = ctx.loadContextState;
      ctx.loadContextState = async () => true;
      ctx.restartChat = real.restartChat;
      let closed = 0;
      ctx.stream = { prompt: "还在回答", raw: "", port: { disconnect: () => closed++ }, context: ctx.shown };
      vm.runInContext("savedConversations = []; chatHistory = []; currentConversationId = ''; currentConversationMeta = null; contextData = shown; activeStream = stream", ctx);
      await real.startNewConversation();
      assert.strictEqual(closed, 0, "the reply is not cut off");
      assert.deepStrictEqual([...vm.runInContext("[activeStream, savedConversations[0]?.messages[0]?.content, stream.conversationId === savedConversations[0]?.id, chatHistory.length]", ctx)], [null, "还在回答", true, 0]);
      ctx.loadContextState = realLoad;
    }

    // The input draft belongs to the conversation: a switch of any kind starts the next one empty (AI 总结 puts its
    // prompt there); within one conversation it stays.
    {
      const input = vm.runInContext("els.input", ctx);
      input.value = "草稿";
      await ctx.followLiveVideo(ctx.shown);
      assert.strictEqual(input.value, "", "following another video");
      vm.runInContext('currentConversationId = "c1"', ctx);
      input.value = "草稿";
      ctx.applyConversation({ id: "c1", messages: [] });
      assert.strictEqual(input.value, "草稿", "the same conversation again");
      ctx.applyConversation({ id: "c2", messages: [] });
      assert.strictEqual(input.value, "", "another conversation");
      input.value = "草稿";
      ctx.showLiveContextInFreshConversation();
      assert.strictEqual(input.value, "", "the shown conversation deleted");
      input.value = "草稿";
      const realStart = ctx.startNewConversation;
      ctx.startNewConversation = async () => real.restartChat();
      await ctx.runPlayerAiQuickActionPrompt("总结");
      assert.strictEqual(input.value, "总结", "AI 总结 replaces the draft");
      ctx.startNewConversation = realStart;
      ctx.restartChat = () => {};
    }

    // A video opened from 分拣台 or 视频记录 is loading until its context resolves: no 「没有字幕」, no AI 总结, and the
    // 快捷追问 say why they wait. A failed load ends it, and the error says what happened.
    {
      let pendingAtLoad;
      ctx.hydratePinnedConversationContext = async () => (pendingAtLoad = vm.runInContext("contextData.pending", ctx));
      ctx.restoreLatestConversationForCurrentContext = async () => false;
      ctx.showConversationContextNotice = () => {};
      vm.runInContext("activeStream = null; liveContextData = null; liveContextKey = ''", ctx);
      await ctx.openRequestedVideoContext({ site: "bilibili", videoId: "BV1xx411c7mD", url: v("BV1xx411c7mD"), title: "t" });
      assert.strictEqual(pendingAtLoad, true);
      assert.strictEqual(ctx.followupBlockReason(), "正在读取视频字幕…");
      ctx.hydratePinnedConversationContext = real.hydratePinnedConversationContext;
      const realResolve = ctx.resolveConversationContext;
      ctx.resolveConversationContext = async () => ({ ok: false, error: "x" });
      ctx.showConversationContextError = () => {};
      ctx.removeConversationContextNotice = () => {};
      assert.strictEqual(await ctx.hydratePinnedConversationContext(), false);
      assert.strictEqual(vm.runInContext("contextData.pending", ctx), false);
      ctx.resolveConversationContext = realResolve;
      ctx.restoreLatestConversationForCurrentContext = async () => {};
    }

    // 导出对话 is disabled with its reason until there is a question with an answer.
    ctx.renderFollowups = () => {};
    const exportState = (messages) => vm.runInContext(`activeStream = null; chatHistory = ${JSON.stringify(messages)}; setStreamingUiState(false); [els.exportBtn.disabled, els.exportBtn.title]`, ctx);
    assert.deepStrictEqual([...exportState([])], [true, "当前没有可导出的对话"]);
    assert.deepStrictEqual([...exportState([{ role: "user", content: "q" }, { role: "assistant", content: "a" }])], [false, "导出整段对话"]);
  }

  // get-settings fails: the defaults stand in, so AI 总结 and the 快捷追问 do not vanish.
  {
    const realSend = ctx.sendRuntimeMessage;
    ctx.document.body = stubEl();
    for (const f of ["renderModelSelect", "renderPresetPrompts", "renderFollowups"]) ctx[f] = () => {};
    ctx.sendRuntimeMessage = async (msg) => (msg.type === "get-settings" ? Promise.reject(new Error("worker gone")) : { ok: true, providers: [] });
    await ctx.loadProvidersAndPrefs();
    const prefs = vm.runInContext("aiPrefs", ctx);
    assert.strictEqual(prefs.playerAiQuickPrompt, ctx.BocSettings.DEFAULTS.playerAiQuickPrompt);
    assert.deepStrictEqual([...prefs.aiPresetPrompts], [...ctx.BocSettings.DEFAULTS.aiPresetPrompts]);
    ctx.sendRuntimeMessage = realSend;
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
