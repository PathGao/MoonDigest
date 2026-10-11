// /usr/local/bin/node extension/download.selftest.js
// BocOverwriteDialog: the one 该笔记已存在 dialog of the extension pages, its words matching the video page's
// (content.js), and writeBuiltNote / writeNote, the side panel's and the 视频记录 page's note writes.
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
const sent = [];
let replies = {};
const ctx = vm.createContext({ document, chrome: { runtime: { sendMessage: async (m) => (sent.push(m), replies[m.type]) } } });
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
  for (const f of ["sidepanel.js", "history/history.js"]) {
    assert.ok(!/confirmOverwriteNote|confirm\(`该笔记已存在/.test(read(f)), `${f} uses BocOverwriteDialog`);
  }

  // writeBuiltNote: the note is new → written, then its AI 问答 section.
  const built = { path: "v/x.md", markdown: "# x", cover: { url: "c" } };
  const args = { baseUrl: "u", apiKey: "k", built, noteKey: "bilibili:BV1" };
  const types = () => sent.splice(0).map((m) => m.type).join();
  replies = { "obsidian-note-exists": { ok: true, exists: false }, "write-obsidian-note": { ok: true }, "update-obsidian-ai-section": { ok: true } };
  assert.strictEqual(await D.writeBuiltNote({ ...args, section: "S" }), "full");
  assert.strictEqual(types(), "obsidian-note-exists,write-obsidian-note,update-obsidian-ai-section");
  // No conversation: no section call.
  assert.strictEqual(await D.writeBuiltNote({ ...args, section: "" }), "full");
  assert.strictEqual(types(), "obsidian-note-exists,write-obsidian-note");
  // The note exists: 只更新 AI 问答 leaves the note, 取消 writes nothing.
  replies["obsidian-note-exists"] = { ok: true, exists: true };
  let p = D.writeBuiltNote({ ...args, section: "S" });
  await new Promise((r) => setImmediate(r));
  assert.match(last().innerHTML, /value="ai"/);
  last().close("ai");
  assert.strictEqual(await p, "ai");
  assert.strictEqual(types(), "obsidian-note-exists,update-obsidian-ai-section");
  p = D.writeBuiltNote({ ...args, section: "" });
  await new Promise((r) => setImmediate(r));
  assert.ok(!/value="ai"/.test(last().innerHTML), "no section: no 只更新 AI 问答");
  last().close("");
  assert.strictEqual(await p, "");
  assert.strictEqual(types(), "obsidian-note-exists");
  // A failed write throws with BocErrors' action.
  replies = { "obsidian-note-exists": { ok: true, exists: false }, "write-obsidian-note": { ok: false, error: "key", code: "OBSIDIAN" } };
  await assert.rejects(D.writeBuiltNote({ ...args, section: "S" }), (e) => e.action === "settings" && e.message === "key");
  assert.strictEqual(types(), "obsidian-note-exists,write-obsidian-note");

  // writeNote (a conversation note): new → written; exists → the dialog without 只更新 AI 问答, 取消 writes nothing.
  const note = { baseUrl: "u", apiKey: "k", filepath: "c.md", content: "# c" };
  replies = { "obsidian-note-exists": { ok: true, exists: false }, "write-obsidian-note": { ok: true } };
  assert.strictEqual(await D.writeNote(note), true);
  assert.strictEqual(types(), "obsidian-note-exists,write-obsidian-note");
  replies["obsidian-note-exists"] = { ok: true, exists: true };
  p = D.writeNote(note);
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(text(last()), "该笔记已存在 整篇覆盖会替换全部内容： 整篇覆盖 取消");
  last().close("");
  assert.strictEqual(await p, false);
  assert.strictEqual(types(), "obsidian-note-exists");
  for (const f of ["sidepanel.js", "history/history.js"]) {
    assert.ok(!read(f).includes('"write-obsidian-note"'), `${f} writes notes through BocOverwriteDialog`);
  }
  console.log("download selftest: all passed");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
