// /usr/local/bin/node extension/note-actions.selftest.js
// MdgNoteActions: the one flow of 复制 Markdown / 下载 .md / 写入 Obsidian. Drives run() with a fake background and
// fake dialogs: askPage → open / own / 取消, ask → modes / 取消, a switch during a dialog, failures with remedies, and
// the result words of each exit.
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const read = (f) => fs.readFileSync(path.join(__dirname, f), "utf8");
const copied = [];
const saved = [];
const ctx = vm.createContext({
  navigator: { clipboard: { writeText: async (t) => copied.push(t) } },
  MdgDownload: { text: (name, text) => saved.push([name, text]) },
  chrome: { runtime: { sendMessage: async () => ({ ok: false }) } }
});
ctx.globalThis = ctx;
for (const f of ["errors.js", "note-actions.js"]) vm.runInContext(read(f), ctx);
const { run, build } = ctx.MdgNoteActions;
const T = ctx.MdgErrors.TEXT;

// A background answering by the message: answer(m) → the reply. sent: [type, pageChoice, mode] per send.
function fake(answer) {
  const sent = [];
  const send = async (m) => (sent.push([m.type, m.pageChoice || "-", m.mode || "-", m.ref.id].join()), answer(m));
  return { sent, send };
}
const dialogs = (page, mode, log = []) => ({
  choosePage: async (...a) => (log.push(["page", ...a].join()), page),
  choose: async (p, opts) => (log.push(["ask", p, opts.hasAiSection, opts.aiOff, opts.fullReason].join()), mode)
});
const request = () => ({ ref: { id: "r" } });
const plain = (r) => JSON.parse(JSON.stringify(r));

(async () => {
  // askPage → open: the page dialog with the exit's verb, then the same request with pageChoice.
  const note = { ok: true, filename: "V.md", markdown: "# V" };
  for (const [kind, verb] of [["copy", "复制"], ["download", "下载"]]) {
    const log = [];
    const bg = fake((m) => (m.pageChoice ? note : { ok: true, askPage: true, url: "u", video: true }));
    const r = await run(kind, { request, send: bg.send, dialogs: dialogs("open", "", log) });
    assert.deepStrictEqual(bg.sent, ["export-note,-,-,r", "export-note,open,-,r"]);
    assert.deepStrictEqual(log, [`page,u,true,true,${verb}`]);
    assert.deepStrictEqual(plain(r), { ok: true, done: true, text: kind === "copy" ? T.copied : T.downloaded, remedies: [] });
  }
  // K16: one sentence for 下载 .md, on every entry.
  assert.strictEqual(T.downloaded, "已下载 .md");
  assert.deepStrictEqual([copied, saved], [["# V"], [["V.md", "# V"]]]);

  // askPage → own (「附带 AI 问答」 off: own false reaches the dialog), then a write that asks → ai.
  {
    const log = [];
    const bg = fake((m) => (!m.pageChoice ? { ok: true, askPage: true, url: "u", own: false } : !m.mode ? { ok: true, ask: true, path: "p.md", hasAiSection: false, aiOff: true } : { ok: true, text: "已写入 Obsidian：p.md" }));
    const r = await run("write", { request, send: bg.send, dialogs: dialogs("own", "full", log) });
    assert.deepStrictEqual(bg.sent, ["write-video-note,-,-,r", "write-video-note,own,-,r", "write-video-note,own,full,r"]);
    assert.deepStrictEqual(log, ["page,u,,false,写", "ask,p.md,false,true,"]);
    assert.deepStrictEqual(plain(r), { ok: true, done: true, text: "已写入 Obsidian：p.md", remedies: [] });
  }
  // ask → each mode is sent as chosen, with fullReason passed on.
  for (const mode of ["ai", "full"]) {
    const log = [];
    const bg = fake((m) => (!m.mode ? { ok: true, ask: true, path: "p.md", hasAiSection: true, fullReason: "整篇覆盖要先打开视频页" } : { ok: true, text: `done ${m.mode}` }));
    const r = await run("write", { request, send: bg.send, dialogs: dialogs("", mode, log) });
    assert.deepStrictEqual([bg.sent.at(-1), log, r.text], [`write-video-note,-,${mode},r`, ["ask,p.md,true,,整篇覆盖要先打开视频页"], `done ${mode}`]);
  }

  // 取消: nothing sent again, not red. K11: the page question has no note yet, so no 「原笔记未被覆盖」.
  for (const [kind, answer, want] of [
    ["copy", { ok: true, askPage: true, url: "u" }, "已取消复制"],
    ["download", { ok: true, askPage: true, url: "u" }, "已取消下载"],
    ["write", { ok: true, askPage: true, url: "u" }, "已取消写入 Obsidian"],
    ["write", { ok: true, ask: true, path: "p.md" }, T.obsidianCancelled]
  ]) {
    const bg = fake(() => answer);
    const r = await run(kind, { request, send: bg.send, dialogs: dialogs("", "") });
    assert.deepStrictEqual([bg.sent.length, plain(r)], [1, { ok: true, done: false, text: want, remedies: [] }], `${kind} cancel`);
  }
  assert.ok(!"已取消写入 Obsidian".includes("原笔记"));

  // Switched during a dialog (isStale): nothing sent again, said in the entry's words.
  for (const answer of [{ ok: true, askPage: true, url: "u" }, { ok: true, ask: true, path: "p.md" }]) {
    const bg = fake(() => answer);
    const r = await run("write", { request, send: bg.send, dialogs: dialogs("open", "ai"), isStale: () => T.obsidianConvSwitched });
    assert.deepStrictEqual([bg.sent.length, plain(r)], [1, { ok: true, done: false, text: T.obsidianConvSwitched, remedies: [] }]);
  }
  // Not stale before a dialog: a direct answer is not checked.
  assert.strictEqual((await run("write", { request, send: async () => ({ ok: true, text: "w" }), isStale: () => "x" })).text, "w");

  // The request is read again at each send (摘读记录 picks up a reply saved while the dialog was open).
  {
    let n = 0;
    const bg = fake((m) => (m.pageChoice ? note : { ok: true, askPage: true, url: "u" }));
    await run("copy", { request: () => ({ ref: { id: `r${++n}` } }), send: bg.send, dialogs: dialogs("open", "") });
    assert.deepStrictEqual(bg.sent, ["export-note,-,-,r1", "export-note,open,-,r2"]);
  }

  // Failures: the exit's words, the reason, and MdgErrors.remedies of the code.
  const fail = (reply) => async () => reply;
  assert.deepStrictEqual(plain(await run("write", { request, send: fail({ ok: false, error: T.obsidianUnset, code: "OBSIDIAN" }) })), { ok: false, done: false, text: `${T.obsidianFailed}：${T.obsidianUnset}`, remedies: ["settings", "retry"], code: "OBSIDIAN", reason: T.obsidianUnset });
  assert.deepStrictEqual(plain(await run("write", { request, send: fail({ ok: false, error: T.obsidianDown, code: "OBSIDIAN_DOWN" }) })).remedies, ["retry"]);
  assert.strictEqual((await run("write", { request, send: fail(undefined) })).text, `${T.obsidianFailed}：${T.obsidianWriteFailed}`);
  assert.strictEqual((await run("download", { request, send: fail({ ok: false, error: "读不到" }) })).text, `${T.downloadFailed}：读不到`);
  // K10: nothing to export says which exit had nothing.
  for (const [kind, want] of [["copy", T.nothingToCopy], ["download", T.nothingToDownload], ["write", T.nothingToWrite]]) {
    const r = await run(kind, { request, send: fail({ ok: false, error: T.nothingToWrite, code: "NOTE_EMPTY" }) });
    assert.deepStrictEqual([r.ok, r.text, [...r.remedies]], [false, want, []], kind);
  }
  // The clipboard refused: 复制失败：无法访问剪贴板, never Chrome's English, with or without words.
  for (const message of ["", "Failed to execute 'writeText' on 'Clipboard': Document is not focused."]) {
    ctx.navigator.clipboard.writeText = async () => { throw Object.assign(new Error(message), { name: "NotAllowedError", code: 0 }); };
    const r = await run("copy", { note: { markdown: "x" } });
    assert.deepStrictEqual([r.text, r.code], [`${T.copyFailed}：${T.noClipboard}`, undefined], message);
  }
  // The extension reloaded under the video page: its own sentence.
  assert.strictEqual((await run("write", { request, send: async () => { throw new Error("Extension context invalidated."); } })).text, T.reloaded);

  // A note the entry built: no message, copied or downloaded as is.
  saved.length = 0;
  assert.deepStrictEqual(plain(await run("download", { note: { filename: "D.md", markdown: "# D" }, send: () => assert.fail("no send") })), { ok: true, done: true, text: T.downloaded, remedies: [] });
  assert.deepStrictEqual(saved, [["D.md", "# D"]]);

  // build: 摘读记录's zip asks nothing and downloads nothing; a failed reply rejects.
  {
    const bg = fake(() => note);
    assert.strictEqual((await build({ ref: { id: "z" }, pageChoice: "own" }, bg.send)).markdown, "# V");
    assert.deepStrictEqual([bg.sent, saved.length], [["export-note,own,-,z"], 1]);
    await assert.rejects(build({ ref: { id: "z" } }, fail({ ok: false, error: "x" })));
  }
  console.log("note-actions selftest: all passed");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
