// node extension/popup.selftest.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

// popup.js is a DOM page: drop init() and check which tools are disabled, and why.
const source = fs.readFileSync(path.join(__dirname, "popup.js"), "utf8").replace(/^init\(\)\.catch\(/m, "(async () => {})().catch(");
assert.ok(source.includes("(async () => {})().catch("), "harness strips the page entry point");
const button = () => {
  const attrs = {};
  const on = {};
  return { disabled: false, title: "", dataset: {}, attrs, on, addEventListener: (t, f) => (on[t] = f), classList: { toggle() {} }, getAttribute: (k) => attrs[k] ?? null, setAttribute: (k, v) => (attrs[k] = v), removeAttribute: (k) => delete attrs[k] };
};
const ctx = vm.createContext({ document: { getElementById: button } });
// The scripts popup.html loads before popup.js, read from the page so the test cannot load a different set.
const scripts = [...fs.readFileSync(path.join(__dirname, "popup.html"), "utf8").matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => m[1]);
assert.strictEqual(scripts.pop(), "./popup.js", "popup.js loads last");
for (const f of scripts) vm.runInContext(fs.readFileSync(path.join(__dirname, f), "utf8"), ctx);
vm.runInContext(`${source}\n;globalThis.el = el;`, ctx);
const { refreshFromTab, bindEvents } = ctx; // B1 below stubs them
const state = () => Object.fromEntries(["downloadBtn", "readingViewBtn", "summaryBtn", "copyBtn", "mdBtn", "sendBtn"].map((k) => {
  const b = ctx.el[k];
  assert.strictEqual(b.title, b.attrs["aria-description"] || "", `${k}: tooltip and aria-description agree`);
  return [k, b.disabled ? b.title : ""];
}));

ctx.syncTools(null, false);
assert.deepStrictEqual(new Set(Object.values(state())), new Set(["当前网页不是支持的视频页"]), "a web page disables every tool");
ctx.syncTools(null);
assert.deepStrictEqual(new Set(Object.values(state())), new Set([""]), "a video page before its first reply keeps them usable");
ctx.syncTools({ markdown: "# t", srt: "", txt: "" });
assert.deepStrictEqual(state(), { downloadBtn: "当前视频没有可下载的字幕", readingViewBtn: "", summaryBtn: "", copyBtn: "", mdBtn: "", sendBtn: "" }, "no subtitles");
ctx.syncTools({ markdown: "# t", srt: "1", txt: "a" });
assert.deepStrictEqual(new Set(Object.values(state())), new Set([""]), "everything ready");

// A non-video page whose content script still answers (youtube.com home): its payload keeps the tools disabled.
vm.runInContext("onVideoPage = false", ctx);
ctx.render({ markdown: "# t", srt: "1", txt: "a" }, { preserveStatus: true });
assert.deepStrictEqual(new Set(Object.values(state())), new Set(["当前网页不是支持的视频页"]), "a web page's payload does not re-enable the tools");
vm.runInContext("onVideoPage = true", ctx);

// B2: 下载 .md is named like the note 写入 Obsidian writes (date prefix setting, 分 P): the content script's filename.
(async () => {
  const saved = [];
  ctx.bindEvents();
  ctx.ensurePayload = async () => ({ title: "标题", markdown: "# t", filename: "2026-10-14-标题-P2-第二集.md" });
  ctx.MdgDownload = { ...ctx.MdgDownload, text: (name) => saved.push(name) };
  await ctx.el.mdBtn.on.click();
  assert.deepStrictEqual(saved, ["2026-10-14-标题-P2-第二集.md"]);
})().catch((e) => (console.error(e), process.exit(1)));

// B1: opening on a web page reads nothing: no 抓取失败, the status says why, and 刷新 is disabled with that reason.
(async () => {
  const fetched = [];
  Object.assign(ctx, {
    bindEvents() {},
    getActiveTab: async () => ({ id: 1, url: "https://example.com/" }),
    getSettingsFromRuntime: async () => ({}),
    refreshFromTab: async () => fetched.push(1)
  });
  await ctx.init();
  const why = ctx.MdgErrors.TEXT.notVideoPage;
  assert.deepStrictEqual(fetched, [], "a web page is not read");
  assert.strictEqual(ctx.el.status.textContent, why);
  assert.deepStrictEqual([ctx.el.refreshBtn.disabled, ctx.el.refreshBtn.title], [true, why], "刷新 is disabled and says why");
  vm.runInContext("onVideoPage = true", ctx);
})().catch((e) => (console.error(e), process.exit(1)));

// Untrusted text (titles, UP names, comments, AI replies, tag names, paths) stays text: no tag of its own, no way out of
// a quoted attribute.
const XSS = ["<img src=x onerror=alert(1)>", `"'><script>alert(1)</script>`];
const assertInert = (html, where) => assert.ok(!/<img src=x|<script|"'>/i.test(html) && /&lt;|&#60;/.test(html), `${where}: ${html}`);
// The video's subtitle names and links come from the site.
for (const bad of XSS) {
  ctx.render({ subtitleOptions: [{ url: bad, id: bad, lang: bad, optionLabel: bad }] }, { preserveStatus: true });
  assertInert(ctx.el.subtitleSelect.innerHTML, "subtitle options");
}

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
    await ctx.el.subtitleSelect.on.change({ target: { selectedIndex: 0, options: [{ value: "u", dataset: {} }] } });
    assert.strictEqual(ctx.el.status.textContent, `${T.subtitleSwitchFailed}：网络断了`);
    console.log("popup selftest: all passed");
  })().catch((e) => (console.error(e), process.exit(1)))
);
