// node extension/history/history.selftest.js
// Loads history.js as the page does, after the scripts history.html lists before it, on a stub DOM.
// A morning in UTC+8 is still yesterday in UTC: a file name dated by toISOString would show it (B7).
process.env.TZ = "Asia/Shanghai";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const source = fs.readFileSync(path.join(__dirname, "history.js"), "utf8").replace(/^if \(!globalThis\.chrome\?\.runtime\?\.id\) await import.*$/m, "");
const L = {};
const els = {};
const node = (id) =>
  (els[id] ||= {
    id,
    value: "",
    checked: false,
    textContent: "",
    innerHTML: "",
    attrs: {},
    setAttribute(k, v) { this.attrs[k] = String(v); },
    removeAttribute(k) { delete this.attrs[k]; },
    classList: { toggle() {}, add() {}, remove() {} },
    querySelectorAll: () => [],
    addEventListener: (t, f) => ((L[id] ||= {})[t] ||= []).push(f)
  });
// Untrusted text (titles, UP names, comments, AI replies, tag names, paths) stays text: no tag of its own, no way out of
// a quoted attribute.
const XSS = ["<img src=x onerror=alert(1)>", `"'><script>alert(1)</script>`];
const assertInert = (html, where) => assert.ok(!/<img src=x|<script|"'>/i.test(html) && /&lt;|&#60;/.test(html), `${where}: ${html}`);
// Each video's title, link, question and AI answer come from the page or the AI.
const conv = (key, bad) => ({ id: key, contextKey: key, title: bad, contextUrl: `https://example.com/${bad}`, createdAt: 1, updatedAt: 1, messages: [{ role: "user", content: bad }, { role: "assistant", content: bad }] });
// A saved context URL with another scheme is never turned into a link.
let onChanged = null;
const store = { mdg_ai_conversations_v1: [conv("a", XSS[0]), { ...conv("b", XSS[1]), contextUrl: "javascript:alert(1)" }] };
const ctx = vm.createContext({
  console,
  setTimeout,
  clearTimeout,
  window: { scrollY: 0, scrollTo() {} },
  document: { getElementById: node, addEventListener() {}, activeElement: null },
  chrome: {
    runtime: { id: "test", sendMessage: async () => ({}) },
    tabs: { getCurrent: async () => ({ id: 1 }) },
    storage: { local: { get: async () => store, set: async () => {} }, onChanged: { addListener: (f) => (onChanged = f) } }
  }
});
ctx.globalThis = ctx;
// The scripts history.html loads before history.js, read from the page so the test cannot load a different set.
const scripts = [...fs.readFileSync(path.join(__dirname, "history.html"), "utf8").matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => path.join(__dirname, m[1]));
assert.strictEqual(scripts.pop(), path.join(__dirname, "history.js"), "history.js loads last");
// H12: 清空全部 clears AI conversations only, and says so.
assert.ok(fs.readFileSync(path.join(__dirname, "history.html"), "utf8").includes(">清空全部 AI 对话</button>"));
for (const f of scripts) vm.runInContext(fs.readFileSync(f, "utf8"), ctx);

(async () => {
  await vm.runInContext(`(async () => {\n${source}\n})()`, ctx);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const fire = (t, e = {}) => (L.search[t] || []).forEach((f) => f(e));
  // the search box renders once typing stops, never on each pinyin keystroke.
  let renders = 0;
  const list = els.list;
  let html = list.innerHTML;
  Object.defineProperty(list, "innerHTML", { get: () => html, set: (v) => (renders++, (html = v)) });
  els.search.value = "z";
  fire("compositionstart");
  fire("input", { isComposing: true });
  els.search.value = "zhong";
  fire("input", { isComposing: true });
  await wait(200);
  assert.strictEqual(renders, 0, "no render mid-composition");
  els.search.value = "中";
  fire("compositionend");
  await wait(200);
  assert.strictEqual(renders, 1, "compositionend renders the committed text once");

  // 全选 is three-state over the listed videos, says how many it covers, and disabled bulk buttons say why.
  els.search.value = "";
  fire("input", {});
  await wait(200);
  assertInert(html, "history list");
  assert.ok(!/href="javascript:/i.test(html) && /https:\/\/example\.com/.test(html), "only http(s) context URLs become links");
  const sa = els.selectAll;
  const reason = (id) => [els[id].disabled, els[id].title, els[id].attrs["aria-description"]];
  assert.deepStrictEqual([sa.checked, sa.indeterminate], [false, false], "none selected: empty box");
  assert.deepStrictEqual(reason("bulkMd"), [true, "先勾选视频", "先勾选视频"]);
  assert.deepStrictEqual(reason("bulkDelete"), [true, "先勾选视频", "先勾选视频"]);
  assert.deepStrictEqual(reason("clearAll"), [false, "", undefined], "conversations exist: clear-all usable, no reason");
  const pick = (key, checked) => {
    const target = { checked, dataset: { act: "pick" }, closest: (s) => (s === ".entry" ? { dataset: { key } } : target) };
    (L.list.click || []).forEach((f) => f({ target }));
  };
  pick("a", true);
  assert.deepStrictEqual([sa.checked, sa.indeterminate], [false, true], "some selected: indeterminate");
  assert.deepStrictEqual(reason("bulkMd"), [false, "", undefined]);
  pick("b", true);
  assert.deepStrictEqual([sa.checked, sa.indeterminate], [true, false], "all selected: checked");
  assert.strictEqual(els.selectAllLabel?.textContent, "全选 2 个");
  assert.deepStrictEqual([els.bulkMd.textContent, els.bulkDelete.textContent], ["下载选中的 2 个 .md", "删除选中的 2 个"]);
  // A search keeps hidden selections (like the 分拣台): the buttons count and act on the listed ones; with every one
  // hidden they say all of them, disabled with 「选中的都被筛选隐藏了」; clearing the search brings the selection back.
  const search = async (q) => ((els.search.value = q), fire("input", {}), await wait(200));
  await search("img");
  assert.deepStrictEqual([els.bulkMd.textContent, els.bulkMd.disabled], ["下载选中的 1 个 .md", false]);
  await search("没有这个");
  assert.deepStrictEqual([els.bulkMd.textContent, els.bulkDelete.textContent, reason("bulkMd")[1], reason("bulkDelete")[1]], ["下载选中的 2 个 .md", "删除选中的 2 个", "选中的都被筛选隐藏了", "选中的都被筛选隐藏了"]);
  await search("");
  assert.deepStrictEqual([sa.checked, els.bulkMd.textContent], [true, "下载选中的 2 个 .md"], "the selection is still there");
  // H9: 删除 removes AI conversations only. A selected video with only a 备注 is not counted, and the tooltip says so;
  // with none that has a conversation it is disabled with the reason.
  const NOTES = ctx.MdgLimits.KEYS.triageNotes;
  store[NOTES] = { BV1note: { text: "备注", updatedAt: 9 } };
  onChanged({ [NOTES]: {} }, "local");
  await wait(350);
  const noteKey = html.match(/data-key="([^"]*BV1note[^"]*)"/)[1];
  pick(noteKey, true);
  assert.deepStrictEqual([els.bulkMd.textContent, els.bulkDelete.textContent, reason("bulkDelete")], ["下载选中的 3 个 .md", "删除选中的 2 个", [false, "选中的 3 个里，1 个没有 AI 对话，删除后会留下；它们的 AI 总结和备注在分拣台清理", undefined]]);
  pick("a", false);
  pick("b", false);
  assert.deepStrictEqual([els.bulkDelete.textContent, reason("bulkDelete")], ["删除选中的", [true, "选中的视频没有 AI 对话，它们的 AI 总结和备注在分拣台清理", "选中的视频没有 AI 对话，它们的 AI 总结和备注在分拣台清理"]]);
  pick(noteKey, false);
  pick("a", true);
  pick("b", true);
  delete store[NOTES];
  onChanged({ [NOTES]: {} }, "local");
  await wait(350);

  // 写入 Obsidian: one write-video-note with the entry's newest conversation; ask → the dialog → the same request with
  // the mode, and the background's words; 取消 sends nothing again and says so, not red.
  const sent = [];
  let choice = "";
  ctx.chrome.runtime.sendMessage = async (m) => (sent.push(m), m.mode ? { ok: true, path: "p.md", kind: "full", text: "已写入 Obsidian：p.md" } : { ok: true, ask: true, path: "p.md", hasAiSection: true });
  ctx.MdgOverwriteDialog = { choose: async (p, opts) => (p === "p.md" && opts.hasAiSection ? choice : "wrong") };
  let red = null;
  els.status.classList = { toggle: (c, on) => c === "is-error" && (red = on) };
  const target = { dataset: { act: "obsidian" }, closest: (s) => (s === ".entry" ? { dataset: { key: "a" } } : target) };
  const click = async () => ((sent.length = 0), (L.list.click || []).forEach((f) => f({ target })), await wait(50));
  await click();
  assert.deepStrictEqual([sent.length, els.status.textContent, red], [1, "已取消写入 Obsidian，原笔记未被覆盖。", false]);
  assert.strictEqual(sent[0].conversation.messages[0].content, XSS[0]);
  choice = "full";
  await click();
  assert.deepStrictEqual([sent.map((m) => m.mode), els.status.textContent], [[undefined, "full"], "已写入 Obsidian：p.md"]);

  // B5: each entry offers 复制 Markdown, then 下载 .md, then 写入 Obsidian (hidden while Obsidian is off), like elsewhere.
  const at = (act) => html.indexOf(`data-act="${act}"`);
  assert.ok(at("copy") > 0 && at("copy") < at("md"), "复制 Markdown comes before 下载 .md");
  assert.match(html, /data-act="copy">复制 Markdown</);
  const act = async (name) => {
    const t = { dataset: { act: name }, closest: (s) => (s === ".entry" ? { dataset: { key: "a" } } : t) };
    (L.list.click || []).forEach((f) => f({ target: t }));
    await wait(20);
  };
  let copied = null;
  ctx.navigator = { clipboard: { writeText: async (text) => (copied = text) } };
  await act("copy");
  assert.ok(copied?.startsWith("---\n"), "the entry's note is copied");
  assert.deepStrictEqual([els.status.textContent, red], ["已复制 Markdown", false]);
  // B4: failures are red: a copy, and opening the side panel from 继续问.
  ctx.navigator.clipboard.writeText = async () => { throw new Error("无法访问剪贴板"); };
  await act("copy");
  assert.deepStrictEqual([els.status.textContent, red], ["复制失败：无法访问剪贴板", true]);
  ctx.chrome.sidePanel = { open: async () => { throw new Error("没有窗口"); } };
  await act("ask");
  assert.deepStrictEqual([els.status.textContent, red], ["打开侧边栏失败：没有窗口", true]);

  // B7: several entries download as one file dated by the local day, not UTC.
  const saved = [];
  ctx.MdgDownload = { ...ctx.MdgDownload, text: (name) => saved.push(name) };
  const RealDate = ctx.Date;
  vm.runInContext("Date = class extends Date { constructor(...a) { a.length ? super(...a) : super(2026, 9, 14, 7, 30); } }", ctx);
  (L.bulkMd.click || []).forEach((f) => f({}));
  ctx.Date = RealDate;
  assert.deepStrictEqual(saved, ["MoonDigest视频记录-2026-10-14.md"]);

  console.log("history selftest: all passed");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
