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
    querySelector: () => null,
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
  document: { getElementById: node, addEventListener: (t, f) => ((L.document ||= {})[t] ||= []).push(f), activeElement: null },
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
  assert.deepStrictEqual([els.bulkMd.textContent, els.bulkDelete.textContent], ["下载选中的 2 个 .md", "删除选中的 2 个的 AI 对话"]);
  // A search keeps hidden selections (like the 分拣台): the buttons count and act on the listed ones; with every one
  // hidden they say all of them, disabled with 「选中的都被筛选隐藏了」; clearing the search brings the selection back.
  const search = async (q) => ((els.search.value = q), fire("input", {}), await wait(200));
  await search("img");
  assert.deepStrictEqual([els.bulkMd.textContent, els.bulkMd.disabled], ["下载选中的 1 个 .md", false]);
  await search("没有这个");
  assert.deepStrictEqual([els.bulkMd.textContent, els.bulkDelete.textContent, reason("bulkMd")[1], reason("bulkDelete")[1]], ["下载选中的 2 个 .md", "删除选中的 2 个的 AI 对话", "选中的都被筛选隐藏了", "选中的都被筛选隐藏了"]);
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
  assert.deepStrictEqual([els.bulkMd.textContent, els.bulkDelete.textContent, reason("bulkDelete")], ["下载选中的 3 个 .md", "删除选中的 2 个的 AI 对话", [false, "选中的 3 个里，1 个没有 AI 对话，删除后会留下", undefined]]);
  // A21: a 备注 closed by pressing another entry's button (focusout on pointerdown) redraws only after that press,
  // so the button the click lands on is still the one pressed.
  const docFire = (t) => (L.document[t] || []).forEach((f) => f({}));
  const noteTarget = { dataset: { act: "note" }, closest: (s) => (s === ".entry" ? { dataset: { key: noteKey } } : noteTarget) };
  L.list.click.forEach((f) => f({ target: noteTarget }));
  assert.ok(html.includes("data-note"), "the 备注 box is open");
  const before = renders;
  docFire("pointerdown");
  L.list.focusout.forEach((f) => f({ target: { matches: (sel) => sel === "[data-note]" } }));
  await wait(20);
  assert.strictEqual(renders, before, "no redraw mid-press");
  docFire("pointerup");
  await wait(20);
  assert.ok(renders > before && !html.includes("data-note"), "redrawn after the press, the box closed");
  pick("a", false);
  pick("b", false);
  assert.deepStrictEqual([els.bulkDelete.textContent, reason("bulkDelete")], ["删除选中的 AI 对话", [true, "选中的视频没有 AI 对话", "选中的视频没有 AI 对话"]]);
  // K13: each entry's button says what it deletes.
  assert.ok(html.includes('data-act="delete" class="danger">删除 AI 对话</button>'), html);
  // K10: 继续问 on a record that is not a video is off with why, through setReason.
  const ask = { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; } };
  const realQsa = els.list.querySelectorAll;
  els.list.querySelectorAll = (sel) => (sel === "[data-no-video]" ? [ask] : []);
  assert.ok(html.includes('data-act="ask" data-no-video>'), html);
  // K12: 清空全部 AI 对话 keeps the selection of the entries still listed (a 备注 only); the deleted ones leave it.
  pick("a", true);
  const convs = store.mdg_ai_conversations_v1;
  ctx.confirm = () => true;
  ctx.chrome.storage.local.set = async (o) => Object.assign(store, o);
  for (const f of L.clearAll.click) await f({});
  onChanged({ mdg_ai_conversations_v1: {} }, "local");
  await wait(350);
  els.list.querySelectorAll = realQsa;
  assert.deepStrictEqual([ask.disabled, ask.title, ask.attrs["aria-description"]], [true, ctx.MdgErrors.TEXT.notVideo, ctx.MdgErrors.TEXT.notVideo]);
  assert.deepStrictEqual([els.bulkMd.textContent, els.status.textContent], ["下载选中的 1 个 .md", "已清空全部 AI 对话"]);
  ctx.chrome.storage.local.set = async () => {};
  store.mdg_ai_conversations_v1 = convs;
  onChanged({ mdg_ai_conversations_v1: {} }, "local");
  await wait(350);
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
  ctx.chrome.runtime.sendMessage = async (m) => (sent.push(m), m.mode ? { ok: true, path: "p.md", kind: "full", text: "已写入 Obsidian：p.md" } : { ok: true, ask: true, path: "p.md", hasAiSection: true, fullReason: "整篇覆盖要先打开视频页" });
  ctx.MdgOverwriteDialog = { choose: async (p, opts) => (p === "p.md" && opts.hasAiSection && opts.fullReason === "整篇覆盖要先打开视频页" ? choice : "wrong") };
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

  // ---- 2026-10-16 scan, group c7 ----
  {
    const reload = async () => (onChanged({ mdg_ai_conversations_v1: {} }, "local"), await wait(350));
    const entry = (key) => html.split("<article").find((a) => a.includes(`data-key="${key}"`)) || "";
    const on = async (key, name, extra = {}) => {
      const t = { dataset: { act: name }, ...extra, closest: (sel) => (sel === ".entry" ? { dataset: { key } } : t) };
      (L.list.click || []).forEach((f) => f({ target: t }));
      await wait(20);
    };
    const qa = (q, a) => [{ role: "user", content: q }, { role: "assistant", content: a }];
    const BV = "BV1abcdefghi";
    const p2Key = `video:bilibili:${BV}|c2`;
    const before = store.mdg_ai_conversations_v1;
    store.mdg_ai_conversations_v1 = [
      ...before,
      { id: "p2", contextKey: p2Key, title: "视频-P2", contextRef: { site: "bilibili", videoId: BV, cid: "c2", pageIndex: 2, title: "视频" }, createdAt: 2, updatedAt: 2, messages: qa("问", "答") },
      // C156: saved before contextRef, its video only in contextSnapshot.
      { id: "old", contextKey: "video:bilibili:BV1oldoldold|", title: "旧对话", contextSnapshot: { bvid: "BV1oldoldold", title: "旧视频" }, createdAt: 1, updatedAt: 1, messages: qa("旧问", "旧答") }
    ];
    store[NOTES] = { [BV]: { text: "整个视频的备注", updatedAt: 1 }, BVabcdefghi: { text: "油管备注", updatedAt: 1 } };
    await reload();
    // C159, C161: P2's entry shows the video's 备注 and copies it, and no entry of its own is added for it.
    assert.ok(entry(p2Key).includes("整个视频的备注") && entry(p2Key).includes('data-act="note"'), entry(p2Key));
    assert.strictEqual(html.split(BV).length - 1, entry(p2Key).split(BV).length - 1, "one entry for the video");
    ctx.navigator.clipboard.writeText = async (text) => (copied = text);
    await on(p2Key, "copy");
    assert.ok(copied.includes("## 我的备注\n\n整个视频的备注"), copied);
    // C158: an 11-character YouTube id that starts with BV is YouTube's.
    assert.ok(html.includes("https://www.youtube.com/watch?v=BVabcdefghi"), html);
    // C156: the old conversation is still its video: 继续问 is on.
    assert.ok(entry("video:bilibili:BV1oldoldold|") && !entry("video:bilibili:BV1oldoldold|").includes("data-no-video"));
    // C166: web pages are not counted as videos.
    assert.ok(els.count.textContent.startsWith("3 个视频、2 个网页 · "), els.count.textContent);
    // C167: an opened entry stays open while a search hides it.
    (L.list.toggle || []).forEach((f) => f({ target: { open: true, closest: () => ({ dataset: { key: p2Key } }) } }));
    await search("没有这个");
    await search("");
    assert.ok(entry(p2Key).includes("<details open>"), entry(p2Key));
    // C165, C173: a failed save or delete says so in red.
    ctx.chrome.storage.local.set = async () => { throw new Error("存储已满"); };
    await on(p2Key, "note");
    (L.list.input || []).forEach((f) => f({ target: { value: "新备注", matches: (sel) => sel === "[data-note]" } }));
    (L.list.keydown || []).forEach((f) => f({ key: "Enter", target: { matches: (sel) => sel === "[data-note]" }, preventDefault() {} }));
    await wait(20);
    assert.deepStrictEqual([els.status.textContent, red], ["保存备注失败：存储已满", true]);
    ctx.confirm = () => true;
    await on(p2Key, "delete");
    assert.deepStrictEqual([els.status.textContent, red], ["删除失败：存储已满", true]);
    els.status.textContent = "";
    for (const f of L.clearAll.click) await f({});
    assert.deepStrictEqual([els.status.textContent, red], ["删除失败：存储已满", true]);
    ctx.chrome.storage.local.set = async () => {};
    // C174: a reply saved while the 该笔记已存在 dialog is open is in the write.
    sent.length = 0;
    ctx.MdgOverwriteDialog = {
      choose: async () => {
        store.mdg_ai_conversations_v1 = store.mdg_ai_conversations_v1.map((c) => (c.id === "p2" ? { ...c, updatedAt: 3, messages: [...c.messages, ...qa("再问", "新回答")] } : c));
        await reload();
        return "ai";
      }
    };
    await on(p2Key, "obsidian");
    await wait(450);
    assert.deepStrictEqual(sent.map((m) => m.conversation.messages.length), [2, 4]);
  }


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
