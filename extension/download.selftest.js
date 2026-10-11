// /usr/local/bin/node extension/download.selftest.js
// BocOverwriteDialog: the one 该笔记已存在 dialog of the extension pages, its words matching the video page's (content.js).
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const read = (file) => fs.readFileSync(path.join(__dirname, file), "utf8");
const dialogs = [];
const document = {
  body: { appendChild() {} },
  querySelector: (sel) => (sel === "dialog.boc-overwrite[open]" ? dialogs.find((d) => d.open) || null : null),
  createElement: () => {
    const listeners = {};
    const d = {
      open: false,
      returnValue: "",
      innerHTML: "",
      code: { textContent: "" },
      querySelector: (sel) => (sel === "code" ? d.code : null),
      addEventListener: (t, f) => (listeners[t] ||= []).push(f),
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
const D = ctx.BocOverwriteDialog;
const text = (d) => d.innerHTML.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const last = () => dialogs[dialogs.length - 1];

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
  D.choose("c.md").then(() => {});
  assert.strictEqual(text(last()), "该笔记已存在 整篇覆盖会替换全部内容： 整篇覆盖 取消", "a note without an AI 问答 section");
  last().close("");

  // The video page cannot use this dialog (a content script on a B站 page) but says the same words.
  const content = read("content.js");
  for (const words of ["只更新 AI 问答：保留原笔记，只替换标记之间的「AI 问答」。整篇覆盖：替换全部内容。", "没有 AI 问答可更新。整篇覆盖会替换全部内容：", "该笔记已存在", ">整篇覆盖<", ">只更新 AI 问答<"]) {
    assert.ok(content.includes(words), `content.js says ${words}`);
  }
  console.log("download selftest: all passed");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
