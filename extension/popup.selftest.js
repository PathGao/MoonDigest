// node extension/popup.selftest.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

// popup.js is a DOM page: drop init() and check which tools are disabled, and why. Startup is scripts/smoke.mjs's job.
const source = fs.readFileSync(path.join(__dirname, "popup.js"), "utf8").replace(/^init\(\)\.catch\(/m, "(async () => {})().catch(");
assert.ok(source.includes("(async () => {})().catch("), "harness strips the page entry point");
const button = () => {
  const attrs = {};
  const on = {};
  return { disabled: false, title: "", dataset: {}, attrs, on, kids: [], append(...n) { this.kids.push(...n); }, addEventListener: (t, f) => (on[t] = f), classList: { toggle() {} }, getAttribute: (k) => attrs[k] ?? null, setAttribute: (k, v) => (attrs[k] = v), removeAttribute: (k) => delete attrs[k] };
};
const body = { classes: new Set() };
body.classList = { add: (c) => body.classes.add(c), toggle() {} };
const ctx = vm.createContext({ URL, setTimeout, document: { getElementById: button, body, createElement: () => ({}) }, chrome: { runtime: { sendMessage: async () => ({ ok: true }) }, tabs: { query: async () => [] } } });
// The scripts popup.html loads before popup.js, read from the page so the test cannot load a different set.
const scripts = [...fs.readFileSync(path.join(__dirname, "popup.html"), "utf8").matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => m[1]);
assert.strictEqual(scripts.pop(), "./popup.js", "popup.js loads last");
for (const f of scripts) vm.runInContext(fs.readFileSync(path.join(__dirname, f), "utf8"), ctx);
vm.runInContext(`${source}\n;globalThis.el = el;`, ctx);
const { refreshFromTab, bindEvents, ensurePayload, sendToContent } = ctx; // the blocks below stub them
const state = () => Object.fromEntries(["downloadBtn", "readingViewBtn", "summaryBtn", "copyBtn", "mdBtn", "sendBtn"].map((k) => {
  const b = ctx.el[k];
  assert.strictEqual(b.title, b.attrs["aria-description"] || "", `${k}: tooltip and aria-description agree`);
  return [k, b.disabled ? b.title : ""];
}));

vm.runInContext("onVideoPage = false", ctx);
ctx.syncTools(null);
assert.deepStrictEqual(new Set(Object.values(state())), new Set(["当前网页不是支持的视频页"]), "a web page disables every tool");
vm.runInContext("onVideoPage = true", ctx);
ctx.syncTools(null);
assert.deepStrictEqual(new Set(Object.values(state())), new Set([""]), "a video page before its first reply keeps them usable");
ctx.syncTools({ markdown: "# t", srt: "", txt: "" });
assert.deepStrictEqual(state(), { downloadBtn: "视频没有字幕", readingViewBtn: "", summaryBtn: "", copyBtn: "", mdBtn: "", sendBtn: "" }, "no subtitles");
// J11: 下载字幕 says what the dropdown says (the page's noTrackText): a read in progress or a failed one is no 没有字幕.
ctx.syncTools({ markdown: "# t", srt: "", txt: "", subtitleMissing: "正在加载字幕…" });
assert.strictEqual(state().downloadBtn, "正在加载字幕…");
ctx.syncTools({ markdown: "# t", srt: "1", txt: "a" });
assert.deepStrictEqual(new Set(Object.values(state())), new Set([""]), "everything ready");
// K3: no note yet: the note's tools say what their click says.
ctx.syncTools({ markdown: "", srt: "1", txt: "a" });
assert.deepStrictEqual([state().copyBtn, state().mdBtn, state().sendBtn], Array(3).fill(ctx.MdgErrors.TEXT.noNoteYet));

// A non-video page whose content script still answers (youtube.com home): its payload keeps the tools disabled.
vm.runInContext("onVideoPage = false", ctx);
ctx.render({ markdown: "# t", srt: "1", txt: "a" }, { preserveStatus: true });
assert.deepStrictEqual(new Set(Object.values(state())), new Set(["当前网页不是支持的视频页"]), "a web page's payload does not re-enable the tools");
vm.runInContext("onVideoPage = true", ctx);

// A19: tracks listed, none loaded: the dropdown shows the reason, not the first track as the current one.
ctx.render({ markdown: "# t", subtitleMissing: "字幕抓取失败：网络断了", subtitleOptions: [{ url: "u1", optionLabel: "中文" }, { url: "u2", optionLabel: "English" }] }, { preserveStatus: true });
assert.match(ctx.el.subtitleSelect.innerHTML, /^<option value="" selected disabled>字幕抓取失败：网络断了<\/option><option value="u1"/);
ctx.render({ markdown: "# t", subtitleOptions: [{ url: "u1", optionLabel: "中文", selected: true }] }, { preserveStatus: true });
assert.match(ctx.el.subtitleSelect.innerHTML, /^<option value="u1"[^>]* selected>/, "a loaded track: no placeholder");

// B2: 下载 .md is named like the note 写入 Obsidian writes (date prefix setting, 分 P): the content script's filename.
(async () => {
  const saved = [];
  ctx.bindEvents();
  ctx.ensurePayload = async () => ({ title: "标题", markdown: "# t", filename: "2026-10-14-标题-P2-第二集.md" });
  ctx.MdgDownload = { ...ctx.MdgDownload, text: (name) => saved.push(name) };
  await ctx.el.mdBtn.on.click();
  assert.deepStrictEqual(saved, ["2026-10-14-标题-P2-第二集.md"]);
  // C287: 下载字幕 takes the same name (srt is the default format).
  ctx.ensurePayload = async () => ({ title: "标题", srt: "1", filename: "2026-10-14-标题-P2-第二集.md" });
  await ctx.el.downloadBtn.on.click();
  assert.deepStrictEqual(saved, ["2026-10-14-标题-P2-第二集.md", "2026-10-14-标题-P2-第二集.srt"]);
  // The format is the settings read when the popup opened (settingsLoad), not read again.
  vm.runInContext('settingsLoad = Promise.resolve({ downloadFormat: "txt" })', ctx);
  ctx.ensurePayload = async () => ({ title: "标题", srt: "1", txt: "字幕", filename: "a.md" });
  await ctx.el.downloadBtn.on.click();
  vm.runInContext("settingsLoad = null", ctx);
  assert.strictEqual(saved.at(-1), "a.txt");
})().catch((e) => (console.error(e), process.exit(1)));

// B1: opening on a web page reads nothing: no 抓取失败, the status says why, and 刷新 is disabled with that reason.
// After B2 (promises only), which stubs MdgDownload too.
setTimeout(() => (async () => {
  const fetched = [];
  ctx.chrome.tabs.query = async () => [{ id: 1, url: "https://example.com/post", title: "一篇文章" }];
  Object.assign(ctx, {
    bindEvents() {},
    getSettingsFromRuntime: async () => ({}),
    refreshFromTab: async () => fetched.push(1)
  });
  // The page's note comes from the background (popup-page-note), which reads the tab through activeTab.
  const asked = [];
  let answer = { ok: true, ref: { url: "https://example.com/post", isVideoContext: false }, filename: "一篇文章.md", content: "---\ntitle: 一篇文章\n---\n\n正文\n" };
  ctx.chrome.runtime.sendMessage = async (m) => (asked.push(m), typeof answer === "function" ? answer(m) : answer);
  await ctx.init();
  const why = ctx.MdgErrors.TEXT.notVideoPage;
  const T = ctx.MdgErrors.TEXT;
  assert.deepStrictEqual(fetched, [], "a web page is not read like a video page");
  assert.deepStrictEqual(asked.map((m) => ({ ...m })), [{ type: "popup-page-note", tabId: 1 }]);
  // F1: an ordinary web page says what it is; the video tools are hidden, AI 总结 works. K17: once read it says what
  // the note's exits can do, in the video page's words.
  assert.deepStrictEqual([ctx.el.status.textContent, ctx.el.videoTitle.textContent, ctx.el.videoMeta.textContent], [T.readDone, "一篇文章", "example.com"]);
  assert.ok(body.classes.has("web-page"), "the video tools are hidden");
  assert.strictEqual(ctx.el.summaryBtn.disabled, false, "AI 总结 opens the side panel on a web page");
  const noteTools = () => [ctx.el.copyBtn, ctx.el.mdBtn, ctx.el.sendBtn].map((b) => (b.disabled ? b.title : ""));
  assert.deepStrictEqual(noteTools(), ["", "", ""], "the page note's tools work once it is read");
  // 复制 Markdown and 下载 .md take the note and its file name as the side panel builds them.
  const copied = [];
  const saved = [];
  ctx.navigator = { clipboard: { writeText: async (t) => copied.push(t) } };
  const download = ctx.MdgDownload;
  ctx.MdgDownload = { ...download, text: (name, content) => saved.push([name, content]) };
  ctx.bindEvents = bindEvents;
  ctx.bindEvents();
  await ctx.el.copyBtn.on.click();
  assert.deepStrictEqual([copied, ctx.el.status.textContent], [[answer.content], T.copied]);
  await ctx.el.mdBtn.on.click();
  assert.deepStrictEqual(saved, [["一篇文章.md", answer.content]]);
  // 写入 Obsidian writes that note through write-video-note; an existing note asks here, like the side panel.
  const chosen = [];
  ctx.MdgOverwriteDialog = { choose: async (p, opts) => (chosen.push([p, opts.hasAiSection]), "ai") };
  const note = answer;
  answer = (m) => (m.mode ? { ok: true, text: "已写入 Obsidian：网页/一篇文章.md" } : { ok: true, ask: true, path: "网页/一篇文章.md", hasAiSection: true });
  asked.length = 0;
  await ctx.el.sendBtn.on.click();
  assert.deepStrictEqual(asked.map((m) => JSON.parse(JSON.stringify(m))), [
    { type: "write-video-note", ref: note.ref, page: { markdown: note.content } },
    { type: "write-video-note", ref: note.ref, page: { markdown: note.content }, mode: "ai" }
  ]);
  assert.deepStrictEqual([chosen, ctx.el.status.textContent, ctx.el.sendBtn.disabled], [[["网页/一篇文章.md", true]], "已写入 Obsidian：网页/一篇文章.md", false]);
  ctx.MdgOverwriteDialog = { choose: async () => "" };
  await ctx.el.sendBtn.on.click();
  assert.strictEqual(ctx.el.status.textContent, T.obsidianCancelled, "取消 writes nothing");
  answer = { ok: false, error: "连不上" };
  await ctx.el.sendBtn.on.click();
  assert.strictEqual(ctx.el.status.textContent, `${T.obsidianFailed}：连不上`);
  // Not set up or a wrong key (OBSIDIAN): 去设置 in the status line, the settings page only on its click. A closed
  // Obsidian (OBSIDIAN_DOWN) gets the red line only.
  for (const [code, toSettings] of [["OBSIDIAN", true], ["OBSIDIAN_DOWN", false]]) {
    answer = { ok: false, error: "Key 不对", code };
    ctx.el.status.kids = [];
    asked.length = 0;
    await ctx.el.sendBtn.on.click();
    assert.deepStrictEqual(ctx.el.status.kids.map((b) => b.textContent), toSettings ? [ctx.MdgErrors.LABEL.toSettings] : [], code);
    assert.ok(!asked.some((m) => m.type === "open-options"), `${code}: nothing opens before the click`);
    if (toSettings) {
      await ctx.el.status.kids[0].onclick();
      assert.strictEqual(asked.at(-1).type, "open-options");
    }
  }
  // A page that cannot be read (no main text, a timeout, the Web Store): the note's tools are disabled with the reason.
  answer = { ok: false, error: `${T.pageReadFailed}：没有找到正文` };
  await ctx.init();
  assert.deepStrictEqual(noteTools(), Array(3).fill(`${T.pageReadFailed}：没有找到正文`));
  assert.strictEqual(ctx.el.status.textContent, `${T.pageReadFailed}：没有找到正文`);
  assert.strictEqual(ctx.el.summaryBtn.disabled, false, "AI 总结 still opens the side panel, which says the same");
  // 刷新 reads the page again, as a video's does; a read that now works turns the tools on.
  assert.strictEqual(ctx.el.refreshBtn.disabled, false, "刷新 works on a web page");
  answer = note;
  asked.length = 0;
  await ctx.el.refreshBtn.on.click();
  assert.deepStrictEqual([asked.map((m) => m.type), noteTools()], [["popup-page-note"], ["", "", ""]]);
  ctx.MdgDownload = download;
  ctx.bindEvents = () => {};
  body.classes.clear();
  // J18: a tab nothing can be read from is said as the side panel and the background say it (pageUnsupported); on a
  // web page only the video tools say notVideoPage.
  assert.strictEqual(ctx.el.readingViewBtn.title, why);
  ctx.chrome.tabs.query = async () => [{ id: 1, url: "chrome://extensions/" }];
  await ctx.init();
  const cannot = T.pageUnsupported;
  assert.strictEqual(ctx.el.status.textContent, cannot);
  assert.deepStrictEqual([ctx.el.refreshBtn.disabled, ctx.el.refreshBtn.title], [true, cannot], "刷新 is disabled and says why");
  assert.deepStrictEqual([ctx.el.summaryBtn.disabled, ctx.el.summaryBtn.title, body.classes.has("web-page")], [true, cannot, false], "not on a page the side panel cannot read");
  vm.runInContext("onVideoPage = true", ctx);
})().catch((e) => (console.error(e), process.exit(1))));

// Untrusted text (titles, UP names, comments, AI replies, tag names, paths) stays text: no tag of its own, no way out of
// a quoted attribute.
const XSS = ["<img src=x onerror=alert(1)>", `"'><script>alert(1)</script>`];
const assertInert = (html, where) => assert.ok(!/<img src=x|<script|"'>/i.test(html) && /&lt;|&#60;/.test(html), `${where}: ${html}`);
// The video's subtitle names and links come from the site.
for (const bad of XSS) {
  ctx.render({ subtitleOptions: [{ url: bad, id: bad, lang: bad, optionLabel: bad }] }, { preserveStatus: true });
  assertInert(ctx.el.subtitleSelect.innerHTML, "subtitle options");
}

// G9: no track reads as everywhere else (MdgErrors.subtitleMissing), not a word of its own.
ctx.render({ subtitleOptions: [], subtitleMissing: "未登录 B站，拿不到字幕" }, { preserveStatus: true });
assert.strictEqual(ctx.el.subtitleSelect.innerHTML, '<option value="">未登录 B站，拿不到字幕</option>');
ctx.render({ subtitleOptions: [] }, { preserveStatus: true });
assert.strictEqual(ctx.el.subtitleSelect.innerHTML, '<option value="">视频没有字幕</option>');

// After the blocks above (promises only), which share el.status.
setTimeout(() =>
  (async () => {
    bindEvents();
    // D3: one sentence per situation, as the video page and 专注模式 say it (MdgErrors.TEXT).
    const T = ctx.MdgErrors.TEXT;
    ctx.ensurePayload = async () => ({ title: "标题", markdown: "" });
    await ctx.el.copyBtn.on.click();
    const copied = ctx.el.status.textContent;
    await ctx.el.mdBtn.on.click();
    assert.deepStrictEqual([copied, ctx.el.status.textContent], [T.noNoteYet, T.noNoteYet]);
    ctx.sendToContent = async () => ({ ok: false, error: "网络断了" });
    await refreshFromTab(true);
    assert.strictEqual(ctx.el.status.textContent, `${T.videoReadFailed}：网络断了`);
    let picked;
    ctx.sendToContent = async (m) => ((picked = m), { ok: false, error: "网络断了" });
    await ctx.el.subtitleSelect.on.change({ target: { selectedIndex: 0, options: [{ value: "u", dataset: { lang: "中文", id: "1" } }] } });
    // I10: the content script reads only the track's url.
    assert.deepStrictEqual({ ...picked }, { type: "popup-select-subtitle", url: "u" });
    assert.strictEqual(ctx.el.status.textContent, `${T.subtitleSwitchFailed}：网络断了`);
    // J10: 写入 Obsidian's result comes in the reply (the page keeps no status line of it); a lost message is a failure.
    ctx.sendToContent = async () => ({ ok: true, text: "已写入 Obsidian：p.md", payload: { status: "读取完成。" } });
    await ctx.el.sendBtn.on.click();
    assert.strictEqual(ctx.el.status.textContent, "已写入 Obsidian：p.md");
    ctx.sendToContent = async () => ({ ok: false, error: "网络断了" });
    await ctx.el.sendBtn.on.click();
    assert.strictEqual(ctx.el.status.textContent, `${T.obsidianFailed}：网络断了`);
    // The video page answers OBSIDIAN (not set up, a wrong key): 去设置 here, the settings page only on its click.
    const opened = [];
    ctx.chrome.runtime.sendMessage = async (m) => (opened.push(m.type), { ok: true });
    ctx.el.status.kids = [];
    ctx.sendToContent = async () => ({ ok: false, text: `${T.obsidianFailed}：Key 不对`, code: "OBSIDIAN" });
    await ctx.el.sendBtn.on.click();
    assert.deepStrictEqual([ctx.el.status.textContent, ctx.el.status.kids.map((b) => b.textContent), opened], [`${T.obsidianFailed}：Key 不对`, [ctx.MdgErrors.LABEL.toSettings], []]);
    await ctx.el.status.kids[0].onclick();
    assert.deepStrictEqual(opened, ["open-options"]);
    // G5: 专注模式 that did not start reads as on the video page: TEXT.readerStartFailed and the background's reason.
    ctx.sendToContent = async () => ({ ok: true });
    ctx.chrome.runtime.sendMessage = async () => ({ ok: false, error: T.pageSilent });
    await ctx.el.readingViewBtn.on.click();
    assert.strictEqual(ctx.el.status.textContent, `${T.readerStartFailed}：${T.pageSilent}`);
    // 专注模式's state check failing reads like its other failures: the lead, then the reason.
    Object.assign(ctx, { sendToContent: async () => ({ ok: false, error: "网络断了" }) });
    await ctx.el.readingViewBtn.on.click();
    assert.strictEqual(ctx.el.status.textContent, `${T.readerStartFailed}：网络断了`);
    // A failed read without words: 未知错误, not 不是视频页 (init already turned web pages away).
    ctx.sendToContent = async () => ({ ok: false });
    await refreshFromTab(true);
    assert.strictEqual(ctx.el.status.textContent, `${T.videoReadFailed}：${T.unknown}`);
    // The page did not answer: 下载字幕 keeps that reason instead of claiming 视频没有字幕.
    vm.runInContext("latestPayload = null", ctx);
    ctx.ensurePayload = ensurePayload;
    ctx.getSettingsFromRuntime = async () => ({});
    await ctx.el.downloadBtn.on.click();
    assert.strictEqual(ctx.el.status.textContent, T.reloadRetry);
    // No active tab: 写入 Obsidian fails in words and ends its busy state, with no unhandled rejection.
    ctx.sendToContent = sendToContent;
    ctx.chrome.tabs.query = async () => [];
    await ctx.el.sendBtn.on.click();
    assert.deepStrictEqual([ctx.el.status.textContent, ctx.el.sendBtn.disabled], [`${T.obsidianFailed}：${T.noTab}`, false]);
    // M3: Chrome's English messaging errors read as the one sentence of a page that did not answer (MdgErrors.pageSilent);
    // the extension's own reasons pass through.
    ctx.chrome.tabs.query = async () => [{ id: 1, url: "https://example.com/" }];
    ctx.chrome.tabs.sendMessage = (id, m, cb) => ((ctx.chrome.runtime.lastError = { message: "The message port closed before a response was received." }), cb(), delete ctx.chrome.runtime.lastError);
    assert.strictEqual((await ctx.sendToContent({ type: "popup-get-state" })).error, T.pageSilent);
    // No content script on a video page: inject (ensure-reader-content) and ask again; injecting that fails says the same sentence.
    ctx.chrome.tabs.query = async () => [{ id: 1, url: "https://www.bilibili.com/video/BV1xx411c7mD/" }];
    ctx.chrome.tabs.sendMessage = (id, m, cb) => ((ctx.chrome.runtime.lastError = { message: "Could not establish connection. Receiving end does not exist." }), cb(), delete ctx.chrome.runtime.lastError);
    const ensured = [];
    ctx.chrome.runtime.sendMessage = async (m) => (ensured.push(m.type), { ok: false, error: T.pageSilent });
    assert.deepStrictEqual([(await ctx.sendToContent({ type: "popup-get-state" })).error, ensured], [T.pageSilent, ["ensure-reader-content"]]);
    // C135: ⚙ that could not open the settings page says so, as the video page does.
    ctx.chrome.runtime.sendMessage = async () => ({ ok: false, error: "没有权限" });
    await ctx.el.settingsBtn.on.click();
    assert.strictEqual(ctx.el.status.textContent, `${T.settingsOpenFailed}：没有权限`);
    console.log("popup selftest: all passed");
  })().catch((e) => (console.error(e), process.exit(1)))
);
