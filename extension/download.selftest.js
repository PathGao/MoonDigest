// /usr/local/bin/node extension/download.selftest.js
// MdgOverwriteDialog: the one 该笔记已存在 dialog of the extension pages, its words matching the video page's (content.js).
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const read = (file) => fs.readFileSync(path.join(__dirname, file), "utf8");
const dialogs = [];
const document = {
  body: { appendChild() {} },
  querySelector: (sel) => (sel === "dialog.mdg-overwrite[open]" ? dialogs.find((d) => d.open) || null : null),
  createElement: () => {
    const listeners = {};
    const d = {
      open: false,
      returnValue: "",
      innerHTML: "",
      code: { textContent: "" },
      full: { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; } },
      querySelector: (sel) => ({ code: d.code, '[value="full"]': d.full })[sel] || null,
      addEventListener: (t, f) => (listeners[t] ||= []).push(f),
      fire: (t, target) => (listeners[t] || []).forEach((f) => f({ target: target === "self" ? d : target })),
      showModal() { d.open = true; },
      close(v) { d.open = false; d.returnValue = v; (listeners.close || []).forEach((f) => f()); },
      remove() {}
    };
    dialogs.push(d);
    return d;
  }
};
const ctx = vm.createContext({ document });
ctx.globalThis = ctx;
for (const f of ["errors.js", "download.js"]) vm.runInContext(read(f), ctx);
const D = ctx.MdgOverwriteDialog;
const text = (d) => d.innerHTML.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const last = () => dialogs[dialogs.length - 1];

// MdgFlash: a copy or download button says 已复制 for a moment, on a clock the test drives.
{
  let now = 0;
  const timers = new Map();
  let nextId = 1;
  const tick = (ms) => {
    now += ms;
    for (const [id, t] of [...timers].sort((a, b) => a[1].at - b[1].at)) if (t.at <= now && timers.delete(id)) t.fn();
  };
  const added = [];
  const doc = {
    body: { append: (n) => added.push(Object.assign(n, { isConnected: true })) },
    createElement: () => ({ attrs: {}, textContent: "", setAttribute(k, v) { this.attrs[k] = v; } })
  };
  const fctx = vm.createContext({ document: doc, setTimeout: (fn, ms) => (timers.set(nextId, { fn, at: now + ms }), nextId++), clearTimeout: (id) => timers.delete(id) });
  fctx.globalThis = fctx;
  vm.runInContext(read("download.js"), fctx);
  const { show } = fctx.MdgFlash;
  const button = (attrs = {}) => ({ isConnected: true, dataset: {}, getAttribute: (k) => attrs[k] ?? null });
  const b = button();
  assert.strictEqual(show(b, "已复制", "已复制 Markdown"), true);
  assert.strictEqual(b.dataset.flash, "已复制");
  tick(50);
  const live = added[0];
  assert.deepStrictEqual([added.length, live.attrs.role, live.textContent], [1, "status", "已复制 Markdown"], "a screen reader hears the whole sentence");
  // A second click while it shows: the time starts again, and the word never becomes the button's own content.
  tick(1000);
  show(b, "已复制", "已复制 Markdown");
  tick(1000);
  assert.strictEqual(b.dataset.flash, "已复制", "still showing 1 s after the second click");
  tick(500);
  assert.strictEqual(b.dataset.flash, undefined, "back to its own content");
  assert.strictEqual(added.length, 1, "one live region for the page");
  // Busy (setBusy's 「…中」) or redrawn away: nothing shown, false, so the entry shows the sentence its own way.
  const busy = button({ "aria-busy": "true" });
  const gone = Object.assign(button(), { isConnected: false });
  assert.deepStrictEqual([show(busy, "已下载", "已下载 .md"), busy.dataset.flash, show(gone, "已下载", "已下载 .md"), show(null, "已下载", "x")], [false, undefined, false, false]);
  // A busy button that is idle again flashes.
  assert.strictEqual(show(button({ "aria-busy": "false" }), "已下载", "已下载 .md"), true);
  // In an open modal dialog (一篇摘录) the page behind is inert, so the live region goes inside the dialog.
  const inDialog = [];
  const dialog = { append: (n) => inDialog.push(Object.assign(n, { isConnected: true })) };
  show(Object.assign(button(), { closest: () => dialog }), "已复制", "已复制 Markdown");
  assert.deepStrictEqual([inDialog.length, added.length], [1, 1]);
}

(async () => {
  // Three kinds of note, one set of words; the default (autofocus) button is never 整篇覆盖.
  D.choose("a.md", { hasAiSection: true });
  assert.strictEqual(text(last()), "该笔记已存在 只更新 AI 问答：保留原笔记，只替换标记之间的「AI 问答」。整篇覆盖：替换全部内容。 整篇覆盖 取消 只更新 AI 问答");
  assert.match(last().innerHTML, /value="ai" autofocus/);
  assert.strictEqual(last().code.textContent, "a.md");
  // A second dialog answers the first with 取消.
  const first = last();
  const second = D.choose("b.md", { hasAiSection: false });
  assert.strictEqual([first.open, first.returnValue].join(), "false,");
  assert.strictEqual(text(last()), "该笔记已存在 没有 AI 问答可更新。整篇覆盖会替换全部内容： 整篇覆盖 取消");
  assert.match(last().innerHTML, /<button value="" autofocus>取消/);
  last().close("full");
  assert.strictEqual(await second, "full");
  // K9: 「附带 AI 问答」 off says that, not 没有 AI 问答.
  D.choose("b.md", { hasAiSection: false, aiOff: true });
  assert.strictEqual(text(last()), "该笔记已存在 「附带 AI 问答」已关。整篇覆盖会替换全部内容： 整篇覆盖 取消");
  last().close("");
  // A2: no open video page to rebuild the note from: 整篇覆盖 is disabled and says why; 只更新 AI 问答 stays.
  D.choose("d.md", { hasAiSection: true, fullReason: "整篇覆盖要先打开视频页" });
  assert.deepStrictEqual([last().full.disabled, last().full.title, last().full.attrs["aria-description"]], [true, "整篇覆盖要先打开视频页", "整篇覆盖要先打开视频页"]);
  assert.match(last().innerHTML, /value="ai" autofocus/);
  D.choose("e.md", { hasAiSection: true });
  assert.ok(!last().full.disabled, "with the page, 整篇覆盖 stays usable");
  last().close("");
  D.choose("c.md").then(() => {});
  assert.strictEqual(text(last()), "该笔记已存在 整篇覆盖会替换全部内容： 整篇覆盖 取消", "a note without an AI 问答 section");
  last().close("");

  // C150: a click outside closes it, which the browser does for closedBy "any".
  D.choose("f.md");
  assert.strictEqual(last().closedBy, "any");
  last().close("");

  // K23: a write says 写, never 存.
  D.choosePage("https://example.com/x", false, true, "写");
  assert.strictEqual(text(last()), "网页没有打开 要写成完整的网页笔记，先在后台打开这个网页。只写 AI 笔记会单独写一篇，之后再写网页笔记时库里会有两篇。 只写 AI 笔记 取消 打开网页再写");
  last().close("");
  // The page dialog names what the button does: 复制 / 下载 say what the AI 笔记 lacks (写 warns of a second note in the
  // vault); without own (「附带 AI 问答」 off) there is no 只… AI 笔记.
  D.choosePage("https://www.youtube.com/watch?v=y", true, true, "复制");
  assert.strictEqual(text(last()), "视频页没有打开 要复制完整的视频笔记，先在后台打开视频页。只复制 AI 笔记只有对话，没有字幕。 只复制 AI 笔记 取消 打开视频页再复制");
  D.choosePage("https://example.com/x", false, false, "下载");
  assert.strictEqual(text(last()), "网页没有打开 要下载完整的网页笔记，先在后台打开这个网页。 取消 打开网页再下载");
  last().close("");

  // The video page cannot use this dialog (a content script on a B站 page) but says the same words.
  const content = read("content.js");
  for (const words of ["只更新 AI 问答：保留原笔记，只替换标记之间的「AI 问答」。整篇覆盖：替换全部内容。", "没有 AI 问答可更新。", "「附带 AI 问答」已关。", "整篇覆盖会替换全部内容：", "该笔记已存在", ">整篇覆盖<", ">只更新 AI 问答<"]) {
    assert.ok(content.includes(words), `content.js says ${words}`);
  }
  console.log("download selftest: all passed");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
