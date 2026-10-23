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
      sendMessage: async (msg) => (msg.type === "ai-sidepanel-get-state" ? answer(msg.tabId) : { ok: true })
    },
    tabs: { query: async () => [activeTab], onActivated: { addListener() {} }, onUpdated: { addListener() {} } },
    storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} }, session: { get: async () => ({}), set: async () => {}, remove: async () => {} }, onChanged: { addListener() {} } }
  }
});
ctx.globalThis = ctx;
// The scripts sidepanel.html loads before sidepanel.js, read from the page so the test cannot load a different set.
const scripts = [...fs.readFileSync(path.join(__dirname, "sidepanel.html"), "utf8").matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => path.join(__dirname, m[1]));
assert.strictEqual(scripts.pop(), path.join(__dirname, "sidepanel.js"), "sidepanel.js loads last");
// K39: a YouTube video has a 备注 and no 分拣台 card; the tooltip names where the same 备注 shows.
assert.ok(fs.readFileSync(path.join(__dirname, "sidepanel.html"), "utf8").includes('title="这个视频的备注，和分拣台、摘读记录里的是同一份"'));
for (const f of scripts) vm.runInContext(fs.readFileSync(f, "utf8"), ctx);
vm.runInContext(source, ctx);
// The input starts empty, as in the page: switching conversations reads what is typed in it.
vm.runInContext('els.input.value = ""', ctx);
const state = vm.runInContext("state", ctx);
const view = () => state.view();
const realRenderHistoryList = ctx.renderHistoryList;
// The page's own functions, for the behaviour tests below that need them past the stubs.
const real = Object.fromEntries(["hydratePinnedConversationContext", "renderPreviousVideoBar", "ensureCurrentContextForSend", "renderInitialState", "renderModelSelect", "updateContextChip", "renderConversationMessages"].map((f) => [f, ctx[f]]));
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
  // A39: a failed video read is said as on the popup and in 专注模式: 「读取视频失败：原因」.
  answer = async () => ({ ok: false, error: "读取当前分 P 失败" });
  assert.strictEqual(await ctx.loadContextState({ silent: true }), false);
  assert.strictEqual(view().live.error, "读取视频失败：读取当前分 P 失败");
  // J8: a video deleted or hidden on B站 is said as a saved conversation's (视频已失效), without 重试; a limit keeps it.
  {
    const views = [];
    const realReset = ctx.resetConversationView;
    ctx.resetConversationView = (html, opts) => views.push([html, opts.retry]);
    for (const code of [-404, 62002, "THROTTLED", "PAGE_SILENT"]) {
      answer = async () => ({ ok: false, error: "x", code });
      await ctx.loadContextState({});
    }
    // K5: a page that did not answer (or took no content script) says to reload it, without a 重试 that fails alike.
    const silent = `读取视频失败：${ctx.MdgErrors.TEXT.pageSilent}`;
    assert.deepStrictEqual(views, [["视频已失效", false], ["视频已失效", false], ["读取视频失败：B站限流，请稍后再试", true], [silent, false]]);
    ctx.resetConversationView = realReset;
  }

  {
    // Neither gate of sendMessage reaches the request (chrome.runtime.connect is not stubbed and would throw).
    const errors = [];
    let loads = 0;
    // The question and its reply's cursor are drawn before the context loads (S4); here they only stand in.
    const [realUser, realPlaceholder] = [ctx.appendUserMessage, ctx.appendAssistantPlaceholder];
    const drawn = [];
    ctx.appendUserMessage = (text) => (drawn.push(text), { remove: () => drawn.push(`-${text}`) });
    ctx.appendAssistantPlaceholder = () => stubEl();
    ctx.showConversationContextError = (text) => errors.push(text);
    ctx.ensureCurrentContextForSend = async () => (loads++, true);
    vm.runInContext("providers = [{}]", ctx);
    // A conversation saved on a web page does not even load its context.
    state.dispatch({ type: "SAVED_CHANGED", list: [{ id: "w", contextUrl: web("w").url, isVideoContext: false, messages: [{ role: "user", content: "q" }] }] });
    state.dispatch({ type: "OPEN", id: "w" });
    vm.runInContext('els.input.value = "q"; els.modelSelect.value = "p"', ctx);
    await ctx.sendMessage();
    assert.strictEqual(loads, 0, "a saved web conversation does not even load its context");
    // C339: the tab leaves the video while the context loads, so the panel shows another conversation: the question is
    // not asked there. R14: it waits as its own conversation's draft, not in the other one's box.
    state.dispatch({ type: "NEW" });
    show(video);
    const videoDraft = view().draftKey;
    ctx.ensureCurrentContextForSend = async () => (loads++, show(web("b")), true);
    vm.runInContext('els.input.value = "q"', ctx);
    await ctx.sendMessage();
    assert.deepStrictEqual([loads, ...errors, vm.runInContext("els.input.value", ctx), vm.runInContext("drafts", ctx).get(videoDraft)], [1, "", "q"]);
    assert.deepStrictEqual(drawn, ["q", "-q"], "the question shows while the context loads and goes when it is not asked");
    vm.runInContext("drafts.clear()", ctx);
    {
      // R14: another saved conversation opened while the context loads; the question is back in its own one's box.
      const conv = (id, bv) => ({ id, contextUrl: `https://www.bilibili.com/video/${bv}`, contextTitle: id, contextRef: { site: "bilibili", videoId: bv, url: `https://www.bilibili.com/video/${bv}` }, messages: [{ role: "user", content: "q" }, { role: "assistant", content: "a" }], updatedAt: 1 });
      state.dispatch({ type: "SAVED_CHANGED", list: [conv("A", "BV1xx411c7mD"), conv("B", "BV1GJ411x7h7")] });
      const realHydrate = ctx.hydratePinnedConversationContext;
      ctx.hydratePinnedConversationContext = async () => true;
      await ctx.act({ type: "OPEN", id: "A" });
      let release;
      ctx.ensureCurrentContextForSend = () => new Promise((r) => (release = r));
      vm.runInContext('els.input.value = "question for A"', ctx);
      const sending = ctx.sendMessage();
      await new Promise((r) => setImmediate(r));
      await ctx.act({ type: "OPEN", id: "B" });
      release(true);
      await sending;
      assert.strictEqual(vm.runInContext("els.input.value", ctx), "", "not in B's box");
      await ctx.act({ type: "OPEN", id: "A" });
      assert.strictEqual(vm.runInContext("els.input.value", ctx), "question for A");
      vm.runInContext('els.input.value = ""', ctx);
      ctx.hydratePinnedConversationContext = realHydrate;
    }
    {
      // R15: the load a send waits on ends on another conversation (the tab followed the next video): nothing is said
      // on that one, from a saved conversation or a new one, even when the load then fails.
      const [realLoad, realReset] = [ctx.loadContextState, ctx.resetConversationView];
      const said = [];
      ctx.resetConversationView = (html) => said.push(html);
      ctx.loadContextState = async () => (await ctx.act({ type: "NEW" }), false);
      ctx.ensureCurrentContextForSend = real.ensureCurrentContextForSend;
      const before = errors.length;
      for (const open of [() => ctx.act({ type: "OPEN", id: "A" }), () => (state.dispatch({ type: "NEW" }), show(video))]) {
        await open();
        vm.runInContext('els.input.value = "q2"', ctx);
        await ctx.sendMessage();
      }
      assert.deepStrictEqual([errors.slice(before), said], [[], []]);
      vm.runInContext('els.input.value = ""', ctx);
      Object.assign(ctx, { loadContextState: realLoad, resetConversationView: realReset });
    }
    // J9: no enabled platform: the conversation and the typed text stay, and 去设置 opens the settings page only when
    // clicked, as every other entry does.
    let resets = 0;
    let opened = 0;
    let notice = null;
    ctx.resetConversationView = () => resets++;
    ctx.showConversationContextNotice = (text, ms, opts) => (notice = { text, ms, ...opts });
    ctx.chrome.runtime.openOptionsPage = () => opened++;
    show(video);
    vm.runInContext('els.input.value = "q"; els.modelSelect.value = ""', ctx);
    await ctx.sendMessage();
    assert.deepStrictEqual([resets, opened, loads, vm.runInContext("els.input.value", ctx)], [0, 0, 1, "q"]);
    assert.deepStrictEqual([notice.text, notice.ms, notice.error, notice.action.label], [ctx.MdgErrors.TEXT.aiNone, 0, true, ctx.MdgErrors.LABEL.toSettings]);
    notice.action.run();
    assert.strictEqual(opened, 1);
    ctx.resetConversationView = () => {};
    // 快捷追问 and 重试 send their own text: the draft in the input box stays as typed.
    const asked = [];
    const realConnect = ctx.chrome.runtime.connect;
    ctx.chrome.runtime.connect = () => ({ onMessage: { addListener() {} }, onDisconnect: { addListener() {} }, postMessage() {}, disconnect() {} });
    ctx.appendUserMessage = (text) => (asked.push(text), stubEl());
    ctx.ensureCurrentContextForSend = async () => true;
    state.dispatch({ type: "NEW" });
    show(video);
    vm.runInContext('els.input.value = "还没写完的草稿"; els.modelSelect.value = "p"', ctx);
    // R16: a newer turn takes the older turns' 重试 away (RETRY only replaces the latest failed turn), as a redraw does.
    const messagesEl = vm.runInContext("els.messages", ctx);
    let retries = 0;
    messagesEl.querySelectorAll = (sel) => (sel === ".sp-msg-retry" ? [{ remove: () => retries++ }] : []);
    await ctx.sendMessage("快捷追问的话");
    messagesEl.querySelectorAll = () => [];
    assert.deepStrictEqual([asked, vm.runInContext("els.input.value", ctx), retries], [["快捷追问的话"], "还没写完的草稿", 1]);
    assert.ok(page.includes('btn.addEventListener("click", () => void sendMessage(visible[index]));'), "快捷追问 passes its text");
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
    ctx.MdgOverwriteDialog = { choose: async (path, opts) => ((asked = [path, opts.hasAiSection, opts.fullReason]), choice()) };
    const realSend = ctx.chrome.runtime.sendMessage;
    // F3: why 整篇覆盖 is off (the video page must be open) reaches the dialog.
    ctx.chrome.runtime.sendMessage = async (m) => (sent.push(m), m.mode ? { ok: true, path: "p.md", kind: m.mode, text: `已更新 AI 问答：p.md` } : { ok: true, ask: true, path: "p.md", hasAiSection: true, fullReason: "先打开视频页" });
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
    assert.deepStrictEqual([asked, sent[1].conversation.messages[0].content, sent[1].ref.videoId, sent[1].page, shown.at(-1)], [["p.md", true, "先打开视频页"], "这个视频", "BV1xx411c7mD", undefined, ["已更新 AI 问答：p.md", undefined]]);
    assert.strictEqual(await write(() => "", web("x")), "-", "取消: nothing sent again");
    assert.deepStrictEqual(shown.at(-1), [ctx.MdgErrors.TEXT.obsidianCancelled, undefined]);
    assert.strictEqual(await write(() => (state.dispatch({ type: "NEW" }), "full"), web("x")), "-", "switched during the dialog");
    // H1: said like the video page's, not as a red failure.
    assert.deepStrictEqual(shown.at(-1), [ctx.MdgErrors.TEXT.obsidianConvSwitched, undefined]);
    // askPage (a web page with no note, not open): the page dialog first, then the same request with its choice.
    {
      const was = ctx.chrome.runtime.sendMessage;
      ctx.chrome.runtime.sendMessage = async (m) => (sent.push(m), m.pageChoice ? { ok: true, text: "已写入 Obsidian：网页/x.md" } : { ok: true, askPage: true, url: "https://example.com/x" });
      ctx.MdgOverwriteDialog.choosePage = async (url) => (url === "https://example.com/x" ? choice() : "wrong");
      assert.strictEqual(await write(() => "open", web("x")), "-,-");
      assert.deepStrictEqual([sent.map((m) => m.pageChoice), shown.at(-1)], [[undefined, "open"], ["已写入 Obsidian：网页/x.md", undefined]]);
      assert.strictEqual(await write(() => "", web("x")), "-", "取消: nothing sent again");
      ctx.chrome.runtime.sendMessage = was;
    }
    // 复制 Markdown and 下载 .md give the note 写入 Obsidian writes: export-note with the conversation on screen, asked
    // about with the button's verb when the page is not open; what comes back is copied or downloaded as is.
    {
      const was = [ctx.chrome.runtime.sendMessage, ctx.MdgDownload];
      const copied = [];
      const saved = [];
      const asked = [];
      ctx.navigator.clipboard = { writeText: async (t) => copied.push(t) };
      ctx.MdgDownload = { text: (name, text) => saved.push([name, text]) };
      ctx.chrome.runtime.sendMessage = async (m) => (sent.push(m), m.pageChoice ? { ok: true, filename: "V.md", markdown: "# 视频笔记" } : { ok: true, askPage: true, url: "u", video: true });
      ctx.MdgOverwriteDialog.choosePage = async (url, isVideo, own, verb) => (asked.push([url, isVideo, own, verb]), choice());
      const run = async (fn, pick) => {
        sent.length = shown.length = 0;
        choice = pick;
        chatOn(video);
        show(web("x"));
        await fn();
        return sent.map((m) => [m.type, m.pageChoice || "-", m.ref.videoId, m.conversation.messages[0].content].join());
      };
      const ask = ["export-note,-,BV1xx411c7mD,这个视频", "export-note,open,BV1xx411c7mD,这个视频"];
      assert.deepStrictEqual(await run(ctx.copyCurrentConversationMarkdown, () => "open"), ask);
      assert.deepStrictEqual(await run(ctx.downloadCurrentConversation, () => "open"), ask);
      // K16: 下载 .md says so here too, as on every entry.
      assert.deepStrictEqual(shown.at(-1), [ctx.MdgErrors.TEXT.downloaded, undefined]);
      assert.deepStrictEqual([copied, saved, asked.map((a) => a.join())], [["# 视频笔记"], [["V.md", "# 视频笔记"]], ["u,true,true,复制", "u,true,true,下载"]]);
      assert.deepStrictEqual(await run(ctx.downloadCurrentConversation, () => ""), [ask[0]]);
      assert.deepStrictEqual([saved.length, shown.at(-1)], [1, ["已取消下载", undefined]]);
      // R12: another conversation shown during the dialog: nothing copied or downloaded, and said so (not red).
      for (const [fn, text] of [[ctx.copyCurrentConversationMarkdown, ctx.MdgErrors.TEXT.convSwitchedCopy], [ctx.downloadCurrentConversation, ctx.MdgErrors.TEXT.convSwitchedDownload]]) {
        assert.deepStrictEqual(await run(fn, () => (state.dispatch({ type: "NEW" }), "open")), [ask[0]]);
        assert.deepStrictEqual([copied.length, saved.length, shown.at(-1)], [1, 1, [text, undefined]]);
      }
      delete ctx.navigator.clipboard;
      [ctx.chrome.runtime.sendMessage, ctx.MdgDownload] = was;
    }
    // The tab shows this video: its settled note goes along.
    activeTab = { id: 4, url: video.url };
    const realTab = ctx.sendMessageToActiveTab;
    // G3: with the page's subtitle state, so the result starts with it as for a note the background builds.
    ctx.sendMessageToActiveTab = async (id, m) => (m.type === "popup-refresh" ? { ok: true, payload: { url: video.url, markdown: "# 页面", cover: "c", noteWarning: "未登录 B站，拿不到字幕。" } } : null);
    await write(() => "full", video);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(sent[1].page)), { markdown: "# 页面", cover: "c", warning: "未登录 B站，拿不到字幕。" });
    ctx.sendMessageToActiveTab = realTab;
    ctx.chrome.runtime.sendMessage = realSend;

    // A failed write is red; only not set up or a wrong key (code OBSIDIAN) adds 去设置, which stays up and opens the
    // settings page on its click. A closed Obsidian gets the red line only.
    const notices = [];
    let settings = 0;
    const actions = [];
    ctx.showConversationContextNotice = (text, ms, opts) => (notices.push([text, opts?.error, opts?.action?.label || "", ms]), opts?.action && actions.push(opts.action));
    ctx.chrome.runtime.openOptionsPage = () => settings++;
    const E = ctx.MdgErrors;
    const LONG = vm.runInContext("NOTICE_LONG_MS", ctx);
    const fail = async (reply) => ctx.showNoteResult(await ctx.MdgNoteActions.run("write", { request: () => ({ ref: {} }), send: async () => reply }));
    await fail({ ok: false, error: E.TEXT.obsidianKey, code: "OBSIDIAN" });
    await fail({ ok: false, error: "Obsidian 返回 HTTP 500" });
    await fail({ ok: false, error: E.TEXT.obsidianDown, code: "OBSIDIAN_DOWN" });
    assert.deepStrictEqual(notices, [[`写入 Obsidian 失败：${E.TEXT.obsidianKey}`, true, E.LABEL.toSettings, 0], ["写入 Obsidian 失败：Obsidian 返回 HTTP 500", true, "", LONG], [`写入 Obsidian 失败：${E.TEXT.obsidianDown}`, true, "", LONG]]);
    assert.strictEqual(settings, 0, "nothing opens before the click");
    actions[0].run();
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
    // A video opened from 分拣台 or 摘读记录 is loading until its context resolves: the 快捷追问 say why they wait. A
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
    const realSend = ctx.chrome.runtime.sendMessage;
    const asked = [];
    let frame = { ...video, selectedSubtitleId: "en", subtitleMarkdown: "英文字幕" };
    ctx.chrome.runtime.sendMessage = async (msg) => {
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
    ctx.chrome.runtime.sendMessage = realSend;
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
    const realSend = ctx.chrome.runtime.sendMessage;
    ctx.document.body = stubEl();
    for (const f of ["renderModelSelect", "renderPresetPrompts", "renderFollowups"]) ctx[f] = () => {};
    ctx.chrome.runtime.sendMessage = async (msg) => (msg.type === "get-settings" ? Promise.reject(new Error("worker gone")) : { ok: true, providers: [] });
    await ctx.loadProvidersAndPrefs();
    const prefs = vm.runInContext("aiPrefs", ctx);
    assert.strictEqual(prefs.playerAiQuickPrompt, ctx.MdgSettings.DEFAULTS.playerAiQuickPrompt);
    assert.deepStrictEqual([...prefs.aiPresetPrompts], [...ctx.MdgSettings.DEFAULTS.aiPresetPrompts]);
    // A33: but they are not the user's list, so neither 添加 nor 删除 saves them over it.
    const saves = [];
    ctx.chrome.runtime.sendMessage = async (msg) => (saves.push(msg.type), { ok: true });
    vm.runInContext('els.presetInput.value = "新的"', ctx);
    assert.strictEqual(vm.runInContext("presetAddReason()", ctx), "读取设置失败，暂时不能修改快捷追问");
    await ctx.addPresetPrompt();
    await ctx.removePresetPrompt(0);
    assert.deepStrictEqual(saves, []);
    vm.runInContext("settingsReadFailed = false", ctx);
    ctx.chrome.runtime.sendMessage = realSend;
  }

  // A history conversation whose B站 video was deleted or hidden: said once as such, not as a read error to retry.
  {
    const errors = [];
    const remedies = [];
    ctx.showConversationContextError = (text, remedy) => (errors.push(text), remedies.push(remedy?.label || ""));
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
    // J7: a failure that may pass (a limit, the network) gets 重试, as the tab's own read does; a gone video none. The
    // 重试 reads it again and takes the error down once it loads.
    assert.deepStrictEqual(remedies, ["", "重试", "重试"]);
    const failure = vm.runInContext("contextFailure()", ctx);
    assert.strictEqual(failure.remedy.label, "重试", "a redraw shows it again");
    let centered = 0;
    const realRemove = ctx.removeCenteredState;
    ctx.removeCenteredState = () => centered++;
    ctx.resolveConversationContext = async () => ({ ok: true, payload: video });
    await failure.remedy.run();
    assert.deepStrictEqual([centered, view().resolved?.videoId], [1, video.videoId]);
    ctx.removeCenteredState = realRemove;
    // J12: a YouTube video reads only from its page: the remedy opens it (in this tab, as the chip does), then reads.
    errors.length = remedies.length = 0;
    const yt = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
    state.dispatch({ type: "SAVED_CHANGED", list: [{ id: "yt", contextUrl: yt, contextRef: { url: yt }, messages: [{ role: "user", content: "q" }] }] });
    state.dispatch({ type: "OPEN", id: "yt" });
    ctx.resolveConversationContext = async () => ({ ok: false, error: "请先打开这个 YouTube 视频页，再继续这段对话" });
    await ctx.hydratePinnedConversationContext();
    assert.deepStrictEqual(remedies, ["打开视频"]);
    const realOpen = ctx.openCurrentContextUrl;
    const steps = [];
    ctx.openCurrentContextUrl = async () => steps.push("open");
    ctx.resolveConversationContext = async () => (steps.push("read"), { ok: false, error: "x" });
    await vm.runInContext("contextFailure()", ctx).remedy.run();
    assert.deepStrictEqual(steps, ["open", "read"]);
    ctx.openCurrentContextUrl = realOpen;
    errors.length = remedies.length = 0;
    // A page conversation is worded as a page's.
    errors.length = 0;
    state.dispatch({ type: "SAVED_CHANGED", list: [{ id: "pg", contextUrl: "https://example.com/pg", contextRef: { url: "https://example.com/pg", isVideoContext: false }, isVideoContext: false, messages: [{ role: "user", content: "q" }] }] });
    state.dispatch({ type: "OPEN", id: "pg" });
    ctx.resolveConversationContext = async () => ({ ok: false, error: "断网" });
    await ctx.hydratePinnedConversationContext();
    assert.deepStrictEqual([errors, vm.runInContext("sourceKind()", ctx)], [["读取原网页失败：断网"], "网页"]);
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
    // C345: 授权 only for the background's AI_ACCESS, never for the same words in an AI platform's reply.
    const grants = (code) => {
      const kids = [];
      ctx.appendStreamError({ node: { appendChild: (c) => kids.push(c) }, prompt: "q", raw: "" }, "未授权访问 https://evil.example，授权后重试", false, code);
      return kids.filter((k) => k.textContent === ctx.MdgErrors.LABEL.grant).length;
    };
    assert.deepStrictEqual([grants(""), grants("AI_ACCESS")], [0, 1]);
    // entry-matrix: every AI code gets the buttons MdgErrors.remedies lists, in its order.
    const labels = { settings: ctx.MdgErrors.LABEL.toSettings, grant: ctx.MdgErrors.LABEL.grant, retry: ctx.MdgErrors.LABEL.retry };
    for (const code of [...Object.keys(ctx.MdgErrors.CODE).filter((c) => c.startsWith("AI_")), "AI_THROTTLED", "AI_STALLED"]) {
      const kids = [];
      ctx.appendStreamError({ node: { appendChild: (c) => kids.push(c) }, prompt: "q", raw: "" }, ctx.MdgErrors.noAccess("https://ai.test"), false, code);
      const shown = kids.slice(1).map((k) => (typeof k.textContent === "string" ? k.textContent : k.innerHTML.replace(/<[^>]*>/g, "")));
      assert.deepStrictEqual(shown, [...ctx.MdgErrors.remedies(code)].map((r) => labels[r]), code);
    }
  }

  // Saved conversations: the video's title, the question and the AI's answer, in the history list and 上一个视频.
  ctx.renderPreviousVideoBar = real.renderPreviousVideoBar;
  for (const bad of XSS) {
    const conv = (id) => ({ id, title: bad, contextTitle: bad, updatedAt: 1, messages: [{ role: "user", content: bad }, { role: "assistant", content: bad }] });
    // The conversations made above count as written, so the stored list replaces them.
    state.dispatch({ type: "SAVED_WRITTEN", ...view().unsaved });
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

  // R13: init reads the 上一个视频 id and the saved list at once; an id read first keeps the bar until the list says
  // whether its conversation is still there.
  {
    const was = [ctx.chrome.storage.session.get, ctx.chrome.storage.local.get];
    let release;
    ctx.chrome.storage.session.get = async () => ({ mdg_sp_previous_video_conversation: "stored" });
    ctx.chrome.storage.local.get = () => new Promise((r) => (release = r));
    const reads = Promise.all([ctx.loadSavedConversations(), ctx.loadPreviousVideoConversationId()]);
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(view().previousId, "stored", "kept while the saved list is unread");
    release({ [vm.runInContext("CONVERSATIONS_STORAGE_KEY", ctx)]: [...view().saved, { id: "stored", contextUrl: "https://example.com/stored", isVideoContext: false, updatedAt: 1, messages: [{ role: "user", content: "q" }] }] });
    await reads;
    ctx.renderPreviousVideoBar(); // renderHistoryList's, stubbed here
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(view().previousId, "stored", "its conversation is still saved");
    state.dispatch({ type: "PREVIOUS_LOADED", id: "gone" });
    ctx.renderPreviousVideoBar();
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(view().previousId, "", "a conversation not in the read list is dismissed");
    [ctx.chrome.storage.session.get, ctx.chrome.storage.local.get] = was;
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
    // K8: 下载 .md failing to build the note says why in red, not 「没有可下载的对话」.
    await ctx.act({ type: "OPEN", id: "x1" });
    const realExport = ctx.chrome.runtime.sendMessage;
    const said = [];
    ctx.chrome.runtime.sendMessage = async () => ({ ok: false, error: "读不到" });
    ctx.showConversationContextNotice = (text, ms, opts) => said.push([text, opts?.error]);
    await ctx.downloadCurrentConversation();
    ctx.chrome.runtime.sendMessage = realExport;
    ctx.showConversationContextNotice = () => {};
    assert.deepStrictEqual(said, [["下载失败：读不到", true]]);
    // A32: during a write a reply starting or ending (which recomputes the buttons) leaves 写入 Obsidian off, and a
    // second write is not started.
    const realSend = ctx.chrome.runtime.sendMessage;
    let finish;
    let writes = 0;
    ctx.chrome.runtime.sendMessage = (m) => (writes++, new Promise((r) => (finish = () => r({ ok: true, text: "已写入" }))));
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
    ctx.chrome.runtime.sendMessage = realSend;
    // A38: another conversation clears it too.
    els.syncStatus.hidden = false;
    await ctx.act({ type: "NEW" });
    assert.strictEqual(els.syncStatus.hidden, true);
    // H14: 发送 says why it is off: while stopping, and on a page that is not a supported video page.
    ctx.setStreamingUiState(true, { stopping: true });
    assert.deepStrictEqual([els.sendBtn.disabled, els.sendBtn.title], [true, "正在停止生成"]);
    ctx.setStreamingUiState(false);
    assert.deepStrictEqual([els.sendBtn.disabled, els.sendBtn.title], [false, ""]);
    // A web page by its pageAccess (background.js readWebPage): only a page whose main text was read can be asked about.
    const sendFor = (payload) => (show(payload), ctx.setStreamingUiState(false), [els.sendBtn.disabled, els.sendBtn.title]);
    const GRANT = "读取网页正文要先允许一次，之后所有网页都能直接读";
    assert.deepStrictEqual(sendFor({ ...web("h14"), pageAccess: "needPermission" }), [true, GRANT]);
    assert.strictEqual(view().nonVideo, true);
    // K2: the quick prompts say the same as 发送.
    assert.strictEqual(vm.runInContext("providers = [{}]; followupBlockReason()", ctx), GRANT);
    // 允许读取网页 granted: the same page read again is ready, and 发送 unlocks.
    assert.deepStrictEqual(sendFor({ ...web("h14"), pageAccess: "ready", pageMarkdown: "正文" }), [false, ""]);
    // No URL (Chrome hides it before the grant): the same one-time grant.
    assert.deepStrictEqual(sendFor({ url: "", title: "", isVideoContext: false, pageAccess: "needPermission" }), [true, GRANT]);
    assert.deepStrictEqual(sendFor({ ...web("h14"), pageAccess: "failed", pageError: "没有找到正文" }), [true, "读取网页失败：没有找到正文"]);
    assert.deepStrictEqual(sendFor({ url: "chrome://newtab/", title: "新标签页", isVideoContext: false, pageAccess: "unsupported" }), [true, "这个页面不能读取：只支持 B站 / YouTube 视频页和普通网页"]);
    // A page conversation shown without its page (no pageAccess: opened from the list) is only read.
    assert.deepStrictEqual(sendFor(web("h14")), [true, "打开这个网页后才能继续问"]);
    // The two sets of AI texts: a page reads the web* keys, a video the original ones, whatever their values.
    {
      const prefs = vm.runInContext("aiPrefs", ctx);
      const was = { ...prefs };
      Object.assign(prefs, { aiSystemPrompt: "视频规则", playerAiQuickPrompt: "视频总结", aiPresetPrompts: ["视频追问"], webAiSystemPrompt: "网页规则", webAiSummaryPrompt: "网页总结", webAiPresetPrompts: ["网页追问"] });
      const pick = () => JSON.parse(vm.runInContext("JSON.stringify([presetPrompts(), summaryPrompt(state.view().context), systemPromptFor(state.view().context), presetKey()])", ctx));
      show({ ...web("chips"), pageAccess: "ready", pageMarkdown: "正文" });
      assert.deepStrictEqual(pick(), [["网页追问"], "网页总结", "网页规则", "webAiPresetPrompts"]);
      show(video);
      assert.deepStrictEqual(pick(), [["视频追问"], "视频总结", "视频规则", "aiPresetPrompts"]);
      // Defaults are no exception: the page shows the web defaults, never the video ones.
      Object.assign(prefs, { aiPresetPrompts: [...ctx.MdgSettings.DEFAULTS.aiPresetPrompts], webAiPresetPrompts: [...ctx.MdgSettings.DEFAULTS.webAiPresetPrompts] });
      state.dispatch({ type: "NEW" });
      show({ ...web("chips"), pageAccess: "ready", pageMarkdown: "正文" });
      assert.deepStrictEqual(pick()[0], [...ctx.MdgSettings.DEFAULTS.webAiPresetPrompts]);
      Object.assign(prefs, was);
      show(video);
    }
    // autoSend sends the prompt only while the input still holds it as filled.
    {
      const realSendMessage = ctx.sendMessage;
      const sends = [];
      ctx.sendMessage = async () => sends.push(els.input.value);
      els.input.value = "整理这篇网页";
      await ctx.runEffect({ type: "autoSend", prompt: "整理这篇网页" });
      els.input.value = "整理这篇网页，只要三点";
      await ctx.runEffect({ type: "autoSend", prompt: "整理这篇网页" });
      assert.deepStrictEqual(sends, ["整理这篇网页"], "an edited prompt is not sent");
      els.input.value = "";
      ctx.sendMessage = realSendMessage;
    }
    // 复制 Markdown / 下载 .md of a read page: the page note (body + AI 问答), named like a video note.
    const realSendNote = ctx.chrome.runtime.sendMessage;
    ctx.chrome.runtime.sendMessage = async () => ({ ok: true, settings: { ...ctx.MdgSettings.DEFAULTS, includeDateInFilename: false } });
    const ready = { ...web("note"), title: "文章", pageAccess: "ready", pageMarkdown: "正文段落" };
    const note = await ctx.pageNote(ready, ctx.MdgNote.buildConversationTurns([{ role: "user", content: "问" }, { role: "assistant", content: "答" }]));
    assert.strictEqual(note.filename, "文章.md");
    assert.ok(note.content.includes("正文段落") && note.content.includes(ctx.MdgNote.AI_SECTION_START), note.content);
    assert.strictEqual(await ctx.pageNote(web("note"), []), null, "no body: the conversation's own note");
    ctx.chrome.runtime.sendMessage = realSendNote;
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
    const realSend = ctx.chrome.runtime.sendMessage;
    const said = [];
    ctx.showConversationContextNotice = (text, ms, opts) => said.push([text, opts?.error]);
    ctx.chrome.runtime.sendMessage = async () => ({ ok: false, error: "同步存储已满" });
    els.presetInput.value = "再讲讲";
    await ctx.addPresetPrompt();
    assert.deepStrictEqual([[...vm.runInContext("aiPrefs", ctx).aiPresetPrompts], els.presetInput.value, said], [[], "再讲讲", [["保存设置失败：同步存储已满", true]]]);
    ctx.chrome.runtime.sendMessage = async () => ({ ok: true });
    await ctx.addPresetPrompt();
    assert.deepStrictEqual([[...vm.runInContext("aiPrefs", ctx).aiPresetPrompts], els.presetInput.value], [["再讲讲"], ""]);
    vm.runInContext("aiPrefs.aiPresetPrompts = []", ctx);
    ctx.chrome.runtime.sendMessage = realSend;
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
    // A web page that failed to read gets 重试, as a failed video does; one that needs the grant gets 允许读取网页 only.
    ctx.resetConversationView = (html, opts) => calls.push([html, opts.retry, opts.grant]);
    calls.length = 0;
    show({ ...web("slow"), pageAccess: "failed", pageError: "没有找到正文" });
    real.renderInitialState();
    show({ ...web("slow"), pageAccess: "needPermission" });
    real.renderInitialState();
    assert.deepStrictEqual(calls.map((c) => c.slice(1)), [[true, false], [false, true]]);
    ctx.resetConversationView = (html) => calls.push(`reset:${html}`);
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

  // A8, C349: the first token takes down the slow notice and only it: a notice shown while the reply waits stays.
  {
    let cleared = 0;
    let others = 0;
    const prev = ctx.removeConversationContextNotice;
    ctx.removeConversationContextNotice = () => others++;
    ctx.__slow = { remove: () => cleared++ };
    vm.runInContext("streamFirstTokenReceived = false; streamSlowNotice = __slow", ctx);
    ctx.handleFirstStreamToken();
    ctx.handleFirstStreamToken();
    ctx.handleFirstStreamToken();
    assert.deepStrictEqual([cleared, others], [1, 0]);
    ctx.removeConversationContextNotice = prev;
  }

  // Each reply's copy button is named per the 用词表: 复制 Markdown, never a bare 复制.
  assert.ok(page.includes("<span>${MdgErrors.LABEL.copyMd}</span>") && !page.includes("<span>复制</span>"), "a reply's copy button says 复制 Markdown");

  // B3: a failed auto-sync to Obsidian offers 去设置 before 重试 when the fix is in the settings page, like a manual write;
  // a closed Obsidian gets 重试 only.
  {
    const prev = [ctx.showSyncStatus, ctx.chrome.runtime.sendMessage];
    const shown = [];
    ctx.showSyncStatus = (text, opts = {}) => shown.push([Boolean(opts.error), Boolean(opts.settings), Boolean(opts.retry)]);
    state.dispatch({ type: "SAVED_CHANGED", list: [{ id: "s", contextRef: { site: "bilibili", videoId: "BV1sync" }, messages: [{ role: "user", content: "q" }] }] });
    for (const code of ["OBSIDIAN", "OBSIDIAN_DOWN"]) {
      ctx.chrome.runtime.sendMessage = async () => ({ ok: false, error: "x", code });
      await ctx.autoSyncConversation("s");
    }
    assert.deepStrictEqual(shown, [[true, true, true], [true, false, true]]);
    [ctx.showSyncStatus, ctx.chrome.runtime.sendMessage] = prev;
  }

  // B4: a failed copy is red, from the export menu and from a reply's own 复制 alike.
  {
    const prev = [ctx.showConversationContextNotice, ctx.chrome.runtime.sendMessage];
    const notices = [];
    ctx.showConversationContextNotice = (text, ms, opts) => notices.push([text.split("：")[0], Boolean(opts?.error)]);
    ctx.navigator.clipboard = { writeText: async () => { throw new Error("无法访问剪贴板"); } };
    ctx.chrome.runtime.sendMessage = async () => ({ ok: true, filename: "x.md", markdown: "x" });
    await ctx.copyCurrentConversationMarkdown();
    await ctx.copyMarkdown("x");
    assert.deepStrictEqual(notices, [["复制失败", true], ["复制失败", true]]);
    // C353, C354: an error without words says 无法访问剪贴板, never 「{}」 or 未知错误.
    notices.length = 0;
    ctx.showConversationContextNotice = (text, ms, opts) => notices.push([text, Boolean(opts?.error)]);
    ctx.navigator.clipboard = { writeText: async () => { throw new Error(""); } };
    await ctx.copyMarkdown("x");
    assert.strictEqual(ctx.MdgErrors.messageOf(new Error("")), "未知错误");
    // C350: a reply's 复制 Markdown says 已复制 Markdown, like the export menu's.
    ctx.navigator.clipboard = { writeText: async () => {} };
    await ctx.copyMarkdown("x");
    assert.deepStrictEqual(notices, [["复制失败：无法访问剪贴板", true], ["已复制 Markdown", false]]);
    delete ctx.navigator.clipboard;
    [ctx.showConversationContextNotice, ctx.chrome.runtime.sendMessage] = prev;
  }

  const tick = () => new Promise((r) => setImmediate(r));
  // A DOM element that keeps what the page does to it.
  const el = (extra = {}) => ({
    attrs: {}, listeners: {}, style: {}, dataset: {}, kids: [],
    classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
    setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return this.attrs[k]; }, removeAttribute(k) { delete this.attrs[k]; },
    addEventListener(t, f) { this.listeners[t] = f; }, appendChild(c) { this.kids.push(c); }, remove() { this.removed = true; },
    ...extra
  });
  const els = vm.runInContext("els", ctx);

  // C318, C319: the AI platform list could not be read: said as that, not as 没有启用的 AI 平台, and init goes on.
  {
    const realSend = ctx.chrome.runtime.sendMessage;
    ctx.renderModelSelect = real.renderModelSelect;
    const settings = { ok: true, settings: ctx.MdgSettings.DEFAULTS };
    ctx.chrome.runtime.sendMessage = async (m) => (m.type === "ai-providers-list" ? Promise.reject(new Error("后台没回应")) : settings);
    await ctx.loadProvidersAndPrefs();
    assert.deepStrictEqual([els.modelSelect.title, ctx.followupBlockReason()], ["读取 AI 平台失败：后台没回应", "读取 AI 平台失败：后台没回应"]);
    els.modelSelect.title = "上一个模型";
    ctx.chrome.runtime.sendMessage = async (m) => (m.type === "ai-providers-list" ? { ok: true, providers: [] } : settings);
    await ctx.loadProvidersAndPrefs();
    assert.strictEqual(els.modelSelect.title, "没有启用的 AI 平台");
    ctx.chrome.runtime.sendMessage = realSend;
    vm.runInContext("providers = [{}]; settingsReadFailed = false", ctx);
  }

  // C320: the panel's AI 总结 sends at once; the prompt a video switch filled goes with it, typed text stays.
  {
    vm.runInContext('__realSend = sendMessage; __sent = []; sendMessage = async (p) => { __sent.push(p === undefined ? ["box", els.input.value] : ["prompt", p]); }', ctx);
    vm.runInContext('els.input.value = "总结一下"; sendSummary("总结一下"); els.input.value = "草稿"; sendSummary("总结一下")', ctx);
    assert.deepStrictEqual(JSON.parse(vm.runInContext("JSON.stringify(__sent)", ctx)), [["box", "总结一下"], ["prompt", "总结一下"]]);
    vm.runInContext('sendMessage = __realSend; els.input.value = ""', ctx);
  }

  // C323: the chip offers to go to the video only on a video.
  {
    Object.assign(els, { contextTitle: stubEl(), contextMeta: stubEl() });
    state.dispatch({ type: "NEW" });
    show(web("tip"));
    real.updateContextChip();
    const onWeb = els.contextChip.title;
    show(video);
    real.updateContextChip();
    assert.deepStrictEqual([onWeb.includes("点击跳转目标视频"), els.contextChip.title.includes("点击跳转目标视频")], [false, true]);
    // B1: a page without a title (chrome://newtab) is 这个页面, not the video words.
    state.dispatch({ type: "NEW" });
    show({ url: "chrome://newtab/", title: "", isVideoContext: false, pageAccess: "unsupported" });
    real.updateContextChip();
    assert.strictEqual(els.contextTitle.textContent, "这个页面");
    show({ url: "", title: "", isVideoContext: false, pageAccess: "needPermission" });
    real.updateContextChip();
    assert.strictEqual(els.contextTitle.textContent, "这个页面");
    // B3: a page conversation drawn with 打开这个网页后才能继续问 loses it once its page is read.
    let cleared = 0;
    const realRemove = ctx.removeCenteredState;
    ctx.removeCenteredState = () => cleared++;
    const pageCtx = { url: "https://example.com/b3", title: "B3", isVideoContext: false };
    state.dispatch({ type: "SAVED_CHANGED", list: [{ id: "b3", contextKey: "page:https://example.com/b3", contextUrl: pageCtx.url, contextTitle: "B3", contextRef: pageCtx, isVideoContext: false, createdAt: 1, updatedAt: 1, messages: [{ role: "user", content: "q" }, { role: "assistant", content: "a" }] }] });
    state.dispatch({ type: "OPEN", id: "b3" });
    real.updateContextChip();
    assert.strictEqual(cleared, 0, "the page is not open: the notice stays");
    show({ ...pageCtx, pageAccess: "ready", pageMarkdown: "正文" });
    real.updateContextChip();
    assert.ok(cleared > 0, "the page is read: the notice goes");
    ctx.removeCenteredState = realRemove;
    state.dispatch({ type: "NEW" });
    show(video);
  }

  // C325: the tab moves from P1 to P2 while 分拣台's summary is read: P2 does not get P1's summary.
  {
    const card = [];
    const node = { querySelector: () => null, insertAdjacentHTML: (_, html) => card.push(html) };
    ctx.__node = node;
    vm.runInContext("suggestionsNode = __node", ctx);
    state.dispatch({ type: "NEW" });
    show(video);
    let release;
    ctx.chrome.storage.local.get = (k) => new Promise((r) => (release = () => r({ [k]: { status: "done", verdict: "keep", oneLiner: "一句话", points: ["要点"] } })));
    const drawing = ctx.renderTriageSummary(node);
    show({ ...video, url: `${video.url}?p=2`, pageIndex: 2 });
    release();
    await drawing;
    assert.deepStrictEqual([view().context.pageIndex, card.length], [2, 0]);
    ctx.chrome.storage.local.get = async () => ({});
    vm.runInContext("suggestionsNode = null", ctx);
  }

  // C327: a second × during the first one's save removes the prompt it was drawn for, and the first stays removed.
  {
    const realSend = ctx.chrome.runtime.sendMessage;
    const saves = [];
    const pending = [];
    vm.runInContext('aiPrefs.aiPresetPrompts = ["a", "b", "c"]', ctx);
    ctx.chrome.runtime.sendMessage = (m) => (saves.push([...m.settings.aiPresetPrompts]), new Promise((r) => pending.push(() => r({ ok: true }))));
    const one = ctx.removePresetPrompt("a");
    const two = ctx.removePresetPrompt("b");
    await tick();
    pending[0]();
    await tick();
    await tick();
    pending[1]();
    await Promise.all([one, two]);
    assert.deepStrictEqual([saves, [...vm.runInContext("aiPrefs", ctx).aiPresetPrompts]], [[["b", "c"], ["c"]], ["c"]]);
    vm.runInContext("aiPrefs.aiPresetPrompts = []", ctx);
    ctx.chrome.runtime.sendMessage = realSend;
  }

  // C328: a conversation whose video is gone is looked up once, not at every open.
  {
    const realSend = ctx.chrome.runtime.sendMessage;
    ctx.chrome.runtime.sendMessage = async () => ({ ok: false, error: "啥都木有", code: -404 });
    state.dispatch({ type: "SAVED_CHANGED", list: [{ id: "h", contextRef: { site: "bilibili", videoId: "BV1gone", cid: "c1" }, contextUrl: "https://www.bilibili.com/video/BV1gone", messages: [{ role: "user", content: "q" }] }] });
    await ctx.hydrateConversationPageMetadata();
    assert.strictEqual(view().saved[0].pageHydrated, true);
    ctx.chrome.runtime.sendMessage = realSend;
  }

  // C331: a menu's button says whether it is open.
  {
    const said = {};
    els.exportBtn.setAttribute = (k, v) => (said[k] = v);
    els.exportPopover.hidden = true;
    ctx.toggleExportPopover();
    const open = [els.exportPopover.hidden, said["aria-expanded"]];
    ctx.hideExportPopover();
    assert.deepStrictEqual([...open, said["aria-expanded"]], [false, "true", "false"]);
  }

  // C334, C337: a history conversation whose video is gone: 快捷追问 and 发送 are off and say why, a redraw says it
  // again, and a send does not even load.
  {
    const errors = [];
    const prev = [ctx.showConversationContextError, ctx.resolveConversationContext, ctx.renderAssistantMessage, ctx.ensureCurrentContextForSend];
    ctx.showConversationContextError = (text) => errors.push(text);
    ctx.resolveConversationContext = async () => ({ ok: false, error: "x", code: -404 });
    ctx.renderAssistantMessage = () => {};
    show(web("g"));
    state.dispatch({ type: "SAVED_CHANGED", list: [{ id: "g2", contextUrl: video.url, contextRef: { url: video.url }, messages: [{ role: "user", content: "q" }, { role: "assistant", content: "a" }] }] });
    state.dispatch({ type: "OPEN", id: "g2" });
    await real.hydratePinnedConversationContext();
    vm.runInContext("activeStream = null; providers = [{}]", ctx);
    const gone = vm.runInContext("VIDEO_GONE", ctx);
    real.renderConversationMessages();
    let loads = 0;
    ctx.ensureCurrentContextForSend = async () => (loads++, true);
    vm.runInContext('els.input.value = "q2"; els.modelSelect.value = "p"', ctx);
    await ctx.sendMessage();
    assert.deepStrictEqual([ctx.followupBlockReason(), els.sendBtn.title, errors, loads], [gone, gone, [gone, gone], 0]);
    [ctx.showConversationContextError, ctx.resolveConversationContext, ctx.renderAssistantMessage, ctx.ensureCurrentContextForSend] = prev;
    state.dispatch({ type: "NEW" });
  }

  // C335: a long title is cut between characters, never inside an emoji.
  {
    const { main } = ctx.buildConversationTitleDisplay(`a${"😀".repeat(30)}`, 22);
    assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(main) && main.endsWith("…"), main);
  }

  // C340: what is typed while the context loads is not lost when the question goes. C343: a reply that left for its
  // saved conversation does not take down the slow notice of the one asked now. L-sidepanel: a reply's error is said
  // through MdgErrors.text (a code's words first).
  {
    const asked = [];
    const errorsShown = [];
    let listener;
    const prev = [ctx.chrome.runtime.connect, ctx.appendUserMessage, ctx.appendAssistantPlaceholder, ctx.ensureCurrentContextForSend, ctx.appendStreamError, ctx.renderAssistantMessage];
    ctx.chrome.runtime.connect = () => ({ onMessage: { addListener: (f) => (listener = f) }, onDisconnect: { addListener() {} }, postMessage() {}, disconnect() {} });
    ctx.appendUserMessage = (text) => asked.push(text);
    ctx.appendAssistantPlaceholder = () => stubEl();
    ctx.appendStreamError = (turn, error) => errorsShown.push(error);
    ctx.renderAssistantMessage = () => {};
    ctx.ensureCurrentContextForSend = async () => (vm.runInContext('els.input.value = "下一个问题"', ctx), true);
    state.dispatch({ type: "NEW" });
    show(video);
    vm.runInContext('activeStream = null; els.input.value = "第一个问题"; els.modelSelect.value = "p"', ctx);
    await ctx.sendMessage();
    assert.deepStrictEqual([asked, els.input.value], [["第一个问题"], "下一个问题"]);
    let slowGone = 0;
    ctx.__slow = { remove: () => slowGone++ };
    ctx.__now = vm.runInContext("activeStream", ctx);
    vm.runInContext("activeStream = {}; streamFirstTokenReceived = false; streamSlowNotice = __slow", ctx);
    ctx.window.requestAnimationFrame = () => 0;
    listener({ type: "token", data: "x" });
    assert.strictEqual(slowGone, 0);
    vm.runInContext("activeStream = __now; streamSlowNotice = null", ctx);
    listener({ type: "error", error: "", code: "THROTTLED" });
    assert.deepStrictEqual(errorsShown, ["B站限流，请稍后再试"]);
    [ctx.chrome.runtime.connect, ctx.appendUserMessage, ctx.appendAssistantPlaceholder, ctx.ensureCurrentContextForSend, ctx.appendStreamError, ctx.renderAssistantMessage] = prev;
    vm.runInContext("activeStream = null", ctx);
  }

  // C344: a redraw asked for while a reply streams (a detached reply ended into this conversation) happens when it ends.
  {
    let draws = 0;
    const prev = [ctx.renderConversationMessages, ctx.renderAssistantMessage];
    ctx.renderConversationMessages = () => draws++;
    ctx.renderAssistantMessage = () => {};
    const stream = { prompt: "p", raw: "r", notice: "", node: stubEl(), port: { disconnect() {} } };
    ctx.__stream = stream;
    vm.runInContext("activeStream = __stream", ctx);
    await ctx.runEffect({ type: "redraw" });
    const during = draws;
    ctx.endStream(stream);
    assert.deepStrictEqual([during, draws], [0, 1]);
    [ctx.renderConversationMessages, ctx.renderAssistantMessage] = prev;
  }

  // C347: 重试 whose resend stops before it starts (the video no longer loads) keeps the failed turn.
  {
    const prevCreate = ctx.document.createElement;
    const made = [];
    ctx.document.createElement = () => (made.push(el()), made.at(-1));
    const node = el();
    chatOn(video);
    ctx.appendStreamError({ node, prompt: "这个视频", raw: "回答" }, "x", true, "");
    ctx.document.createElement = prevCreate;
    const prev = [ctx.ensureCurrentContextForSend, ctx.appendUserMessage, ctx.appendAssistantPlaceholder];
    let hiddenWhileLoading;
    ctx.ensureCurrentContextForSend = async () => ((hiddenWhileLoading = node.hidden), false);
    ctx.appendUserMessage = () => stubEl();
    ctx.appendAssistantPlaceholder = () => stubEl();
    vm.runInContext('activeStream = null; sendPending = false; els.modelSelect.value = "p"', ctx);
    made.find((b) => /重试/.test(b.innerHTML || "")).listeners.click();
    await tick();
    await tick();
    // S4: the failed turn is hidden while the resend waits for the video, and comes back when it is not sent.
    assert.deepStrictEqual([view().messages.length, Boolean(node.removed), hiddenWhileLoading, node.hidden], [2, false, true, false]);
    [ctx.ensureCurrentContextForSend, ctx.appendUserMessage, ctx.appendAssistantPlaceholder] = prev;
  }

  // C351: an auto-sync with nothing to do (the video has no note) takes down an earlier failure.
  {
    const prev = [ctx.hideSyncStatus, ctx.chrome.runtime.sendMessage];
    let hidden = 0;
    ctx.hideSyncStatus = () => hidden++;
    ctx.chrome.runtime.sendMessage = async () => ({ ok: true });
    state.dispatch({ type: "SAVED_CHANGED", list: [{ id: "s2", contextRef: { site: "bilibili", videoId: "BV1sync" }, messages: [{ role: "user", content: "q" }] }] });
    await ctx.autoSyncConversation("s2");
    assert.strictEqual(hidden, 1);
    [ctx.hideSyncStatus, ctx.chrome.runtime.sendMessage] = prev;
  }

  // C357, C358: two timestamps clicked while the tab is elsewhere: only the newer one seeks; 正在跳转… stays until the
  // jump is done. C359–C362: a failed jump is one red 时间跳转失败 in Chinese.
  {
    const notices = [];
    let busyDown = 0;
    const prevNotice = ctx.showConversationContextNotice;
    ctx.showConversationContextNotice = (text, ms, opts) => (notices.push([text, ms || 0, Boolean(opts?.error)]), { remove: () => busyDown++ });
    ctx.chrome.tabs.get = async () => ({ status: "complete" });
    const seeks = [];
    let navs = 0;
    let releaseNav;
    ctx.chrome.tabs.update = () => (++navs === 1 ? new Promise((r) => (releaseNav = r)) : Promise.resolve());
    ctx.chrome.tabs.sendMessage = (id, msg, cb) => (seeks.push(msg.seconds), cb({ ok: true }));
    state.dispatch({ type: "NEW" });
    show(video);
    activeTab = { id: 9, url: "https://example.com/elsewhere" };
    const first = ctx.jumpToAssistantTimestamp(10, "0:10");
    await tick();
    await ctx.jumpToAssistantTimestamp(20, "0:20");
    releaseNav();
    await first;
    assert.deepStrictEqual([seeks, notices.map((n) => n[1]), busyDown], [[20], [0, 0], 1]);
    notices.length = 0;
    activeTab = { id: 9, url: video.url };
    ctx.chrome.tabs.sendMessage = (id, msg, cb) => cb({ ok: false });
    await ctx.jumpToAssistantTimestamp(5, "0:05");
    ctx.chrome.runtime.lastError = { message: "Could not establish connection. Receiving end does not exist." };
    ctx.chrome.tabs.sendMessage = (id, msg, cb) => cb(undefined);
    await ctx.jumpToAssistantTimestamp(5, "0:05");
    ctx.chrome.runtime.lastError = undefined;
    assert.deepStrictEqual(notices.filter((n) => n[2]).map((n) => n[0]), ["时间跳转失败：请刷新网页后重试", `时间跳转失败：${ctx.MdgErrors.TEXT.pageSilent}`], "M3: a page that did not answer says the one sentence");
    // F5: a video page without the script gets it from the background (ensure-reader-content), as in the popup, then seeks.
    {
      let injected = false;
      const asked = [];
      const prevSend = ctx.chrome.runtime.sendMessage;
      ctx.chrome.runtime.sendMessage = async (m) => (asked.push(m.type), m.type === "ensure-reader-content" && (injected = true), { ok: true });
      ctx.chrome.tabs.sendMessage = (id, msg, cb) => {
        if (injected) return cb({ ok: true });
        ctx.chrome.runtime.lastError = { message: "Could not establish connection. Receiving end does not exist." };
        cb(undefined);
        ctx.chrome.runtime.lastError = undefined;
      };
      notices.length = 0;
      await ctx.jumpToAssistantTimestamp(7, "0:07");
      assert.deepStrictEqual([asked.filter((t) => t === "ensure-reader-content"), notices.filter((n) => n[2])], [["ensure-reader-content"], []]);
      ctx.chrome.runtime.sendMessage = prevSend;
    }
    ctx.showConversationContextNotice = prevNotice;
    // C363: the tab closed while it loads: said at once, not after 15 seconds as a load timeout.
    ctx.chrome.tabs.get = async () => Promise.reject(new Error("No tab with id: 9"));
    await assert.rejects(ctx.MdgSites.waitTabLoaded(9), (e) => e.message === ctx.MdgErrors.TEXT.tabClosed);
  }

  // C329: a save reads the stored list again and changes it by entry: a conversation 摘读记录 deleted after this page
  // last read the list is not written back; a delete here removes only its own entry.
  {
    const KEY = ctx.MdgLimits.KEYS.aiConversations;
    const store = {};
    const [get, set] = [ctx.chrome.storage.local.get, ctx.chrome.storage.local.set];
    ctx.chrome.storage.local.get = async (k) => Object.fromEntries([k].flat().map((x) => [x, structuredClone(store[x])]));
    ctx.chrome.storage.local.set = async (o) => void Object.assign(store, structuredClone(o));
    const c = (id) => ({ id, contextUrl: `https://www.bilibili.com/video/BV1${id}`, isVideoContext: true, updatedAt: 1, messages: [{ role: "user", content: "q" }] });
    state.dispatch({ type: "SAVED_WRITTEN", ...view().unsaved });
    state.dispatch({ type: "SAVED_CHANGED", list: [c("k"), c("l"), c("gone")] });
    store[KEY] = [c("k"), c("l")]; // 摘读记录's delete, whose change has not reached this page yet
    await ctx.saveConversations();
    assert.deepStrictEqual(store[KEY].map((x) => x.id).sort(), ["k", "l"], "not written back");
    await ctx.act({ type: "DELETED", id: "k" });
    assert.deepStrictEqual(store[KEY].map((x) => x.id), ["l"]);
    Object.assign(ctx.chrome.storage.local, { get, set });
  }

  // J6: a subtitle that failed or needs a login gets 重试 in the empty state, as in 专注模式; it reads the context again.
  {
    vm.runInContext('providers = [{}]; providersError = ""', ctx);
    state.dispatch({ type: "NEW" });
    for (const [extra, retry] of [[{ subtitleFailure: "超时" }, true], [{ subtitleNeedLogin: true }, true], [{}, false]]) {
      show({ ...video, subtitleMarkdown: "", ...extra });
      assert.strictEqual(ctx.suggestionsContent().html.includes('data-act="retry"'), retry, JSON.stringify(extra));
    }
    const html = (show({ ...video, subtitleMarkdown: "", subtitleFailure: "超时" }), ctx.suggestionsContent().html);
    assert.ok(html.includes("字幕抓取失败：超时") && html.includes(`>${ctx.MdgErrors.LABEL.retry}</button>`), html);
  }

  // J18: the side panel's sentences are the shared ones.
  {
    assert.strictEqual(ctx.pageReason({ pageAccess: "unsupported" }), ctx.MdgErrors.TEXT.pageUnsupported);
    assert.strictEqual(ctx.pageReason({ pageAccess: "needPermission" }), ctx.MdgErrors.TEXT.pageGrant);
    // While a followed video still loads, the send says what the popup and the video page say.
    const notices = [];
    const prev = [ctx.showConversationContextNotice, ctx.loadContextState];
    ctx.showConversationContextNotice = (text) => (notices.push(text), { remove() {} });
    ctx.loadContextState = async () => true;
    state.dispatch({ type: "NEW" });
    show(video);
    state.dispatch({ type: "TAB_READ", tab: { url: "https://www.bilibili.com/video/BV1GJ411x7h7", title: "" }, follow: true });
    assert.ok(view().context.pending, "a followed video's placeholder");
    await real.ensureCurrentContextForSend();
    assert.deepStrictEqual(notices, [ctx.MdgErrors.TEXT.videoReading]);
    [ctx.showConversationContextNotice, ctx.loadContextState] = prev;
    // After 授权 the reply's error says 已授权，请重试, as 分拣台 and 摘读记录 do: the button beside it is 重试.
    const made = [];
    const realCreate = ctx.document.createElement;
    ctx.document.createElement = () => {
      const el = stubEl();
      el.addEventListener = (type, fn) => (el.click = fn);
      made.push(el);
      return el;
    };
    ctx.chrome.permissions = { request: async () => true };
    ctx.appendStreamError({ node: stubEl(), prompt: "q", raw: "" }, ctx.MdgErrors.noAccess("https://ai.test"), false, "AI_ACCESS");
    await made.find((el) => el.textContent === ctx.MdgErrors.LABEL.grant).click();
    assert.strictEqual(made[0].textContent, ctx.MdgErrors.TEXT.granted);
    ctx.document.createElement = realCreate;
  }

  {
    // A tab event's redraw: a conversation bound to its video redraws its chip, the empty one its start state; a load
    // that followed another video drew it already.
    const keep = Object.fromEntries(["loadContextState", "updateContextChip", "renderInitialState", "renderSuggestions"].map((k) => [k, ctx[k]]));
    const drawn = [];
    let result;
    Object.assign(ctx, { loadContextState: async () => result, updateContextChip: () => drawn.push("chip"), renderInitialState: () => drawn.push("start"), renderSuggestions: () => drawn.push("suggestions") });
    for (const [setup, r] of [[() => state.dispatch({ type: "NEW" }), true], [() => state.dispatch({ type: "NEW" }), false], [() => chatOn(video), true], [() => chatOn(video), "followed"]]) {
      setup();
      result = r;
      await ctx.syncLiveContextState();
    }
    assert.deepStrictEqual(drawn, ["start", "start", "chip"]);
    Object.assign(ctx, keep);
  }

  {
    // An answer's timestamps become jump buttons, outside links, code and buttons; the text around them stays.
    class Text {
      constructor(text, parent = { closest: () => null }) {
        Object.assign(this, { textContent: text, parentElement: parent });
      }
      replaceWith(fragment) {
        this.replaced = fragment.parts.map((p) => (p instanceof Text ? p.textContent : `[${p.textContent}]`));
      }
    }
    ctx.Text = Text;
    ctx.NodeFilter = { SHOW_TEXT: 4 };
    const nodes = [new Text("看 1:15 和 1:02:03 两处"), new Text("没有时间"), new Text("12:00", { closest: () => ({}) })];
    Object.assign(ctx.document, {
      createTreeWalker: () => ({ i: -1, nextNode() { return ++this.i < nodes.length; }, get currentNode() { return nodes[this.i]; } }),
      createDocumentFragment: () => ({ parts: [], append(p) { this.parts.push(p); } }),
      createTextNode: (text) => new Text(text)
    });
    ctx.linkifyAssistantTimestamps({});
    assert.deepStrictEqual(nodes.map((n) => n.replaced), [["看 ", "[1:15]", " 和 ", "[1:02:03]", " 两处"], undefined, undefined]);
    for (const k of ["createTreeWalker", "createDocumentFragment", "createTextNode", "Text", "NodeFilter"]) delete (k in ctx.document ? ctx.document : ctx)[k];
  }

  console.log("sidepanel selftest: all passed");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
