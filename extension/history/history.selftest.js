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
    querySelector: (sel) => (sel === "[data-open-options]" ? node("openOptions") : null),
    contains: () => false,
    focus() {},
    showModal() {},
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
const sync = {}; // chrome.storage.sync
const store = { mdg_ai_conversations_v1: [conv("a", XSS[0]), { ...conv("b", XSS[1]), contextUrl: "javascript:alert(1)" }] };
// The AI platform picked in the side panel, under 3.5's key: this page moves it before reading it, as 收藏夹 does.
const lsData = { boc_ai_selected_provider: "b" };
const localStorage = {
  get length() { return Object.keys(lsData).length; },
  key: (i) => Object.keys(lsData)[i] ?? null,
  getItem: (k) => (k in lsData ? lsData[k] : null),
  setItem: (k, v) => (lsData[k] = String(v)),
  removeItem: (k) => delete lsData[k]
};
const ctx = vm.createContext({
  localStorage,
  AbortController,
  TextEncoder,
  URL,
  URLSearchParams,
  console,
  setTimeout,
  clearTimeout,
  window: { scrollY: 0, scrollTo() {} },
  // No #tagPicker: tag-picker.js loads its pure half, and the test stands in for the picker's open (TagPicker.open below).
  document: { getElementById: (id) => (id === "tagPicker" ? null : node(id)), addEventListener: (t, f) => ((L.document ||= {})[t] ||= []).push(f), activeElement: null, querySelector: () => null },
  chrome: {
    runtime: { id: "test", sendMessage: async () => ({}) },
    tabs: { getCurrent: async () => ({ id: 1 }) },
    storage: { local: { get: async () => store, set: async () => {}, remove: async (keys) => [].concat(keys).forEach((k) => delete store[k]) }, sync: { get: async () => ({ ...sync }), set: async (o) => Object.assign(sync, o) }, onChanged: { addListener: (f) => (onChanged = f) } }
  }
});
ctx.globalThis = ctx;
// The scripts history.html loads before history.js, read from the page so the test cannot load a different set.
const scripts = [...fs.readFileSync(path.join(__dirname, "history.html"), "utf8").matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => path.join(__dirname, m[1]));
assert.strictEqual(scripts.pop(), path.join(__dirname, "history.js"), "history.js loads last");
// H12: 清空全部 clears AI conversations only, and says so.
assert.ok(fs.readFileSync(path.join(__dirname, "history.html"), "utf8").includes(">清空全部 AI 对话</button>"));
for (const f of scripts) vm.runInContext(fs.readFileSync(f, "utf8"), ctx);
// H5: 删除标签 and U 撤销 ask in the 分拣台's confirm dialog (UI.askConfirm), not the browser's confirm(): asks records each.
const asks = [];
let confirmAnswer = true;
ctx.TriageUi.askConfirm = async (...a) => (asks.push(JSON.parse(JSON.stringify(a))), confirmAnswer);
assert.ok(/<dialog id="confirmDialog"[\s\S]*id="confirmTitle"[\s\S]*id="confirmBody"[\s\S]*value="cancel"[\s\S]*id="confirmOk"/.test(fs.readFileSync(path.join(__dirname, "history.html"), "utf8")), "history.html has the confirm dialog");

(async () => {
  await vm.runInContext(`(async () => {\n${source}\n})()`, ctx);
  assert.deepStrictEqual(lsData, { mdg_ai_selected_provider: "b" }, "the old localStorage key is moved on load");
  // J11 / J18: with no record, ✦ AI 打标签 is off and says why, as 收藏夹's in an empty folder (I says it too); 全选 says
  // nothing is listed without calling the records videos.
  {
    const pause = (ms) => new Promise((r) => setTimeout(r, ms));
    const kept = { ...store };
    const realOpen = ctx.TagDialogs.ai.open;
    for (const k of Object.keys(store)) delete store[k];
    onChanged({ mdg_ai_conversations_v1: {} }, "local");
    await pause(350);
    assert.ok(/data-f="ai"[^>]* disabled title="还没有摘读记录"/.test(els.tagActs.innerHTML), els.tagActs.innerHTML);
    let opened = 0;
    ctx.TagDialogs.ai.open = () => opened++;
    L.filters.click.forEach((h) => h({ target: { closest: () => ({ dataset: { f: "ai" } }) } }));
    await pause(20);
    assert.deepStrictEqual([opened, els.status.textContent], [0, "还没有摘读记录"]);
    assert.ok(els.selectAllSlot.innerHTML.includes('disabled title="这里没有列出记录"'), els.selectAllSlot.innerHTML);
    ctx.TagDialogs.ai.open = realOpen;
    Object.assign(store, kept);
    onChanged({ mdg_ai_conversations_v1: {} }, "local");
    await pause(350);
  }

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

  // 全选 is three-state over the listed videos and says how many it covers; the selection bar shows only with a selection.
  els.search.value = "";
  fire("input", {});
  await wait(200);
  assertInert(html, "history list");
  assert.ok(!/href="javascript:/i.test(html) && /https:\/\/example\.com/.test(html), "only http(s) context URLs become links");
  const reason = (id) => [els[id].disabled, els[id].title, els[id].attrs["aria-description"]];
  const allBox = () => els.selectAllSlot.innerHTML.match(/aria-checked="(\w+)"/)[1];
  // A selection bar button by its data-sel: [label, disabled, title].
  const btn = (name) => {
    const m = els.selbar.innerHTML.match(new RegExp(`<button[^>]*data-sel="${name}"[^>]*>([^<]*)</button>`));
    return m && [m[1], /\sdisabled[\s>]/.test(m[0]), (m[0].match(/title="([^"]*)"/) || [])[1] || ""];
  };
  assert.strictEqual(allBox(), "false", "none selected: empty box");
  assert.strictEqual(els.selbar.innerHTML, "", "no selection, no selection bar");
  assert.deepStrictEqual(reason("clearAll"), [false, "", undefined], "conversations exist: clear-all usable without a selection");
  const pick = (key, checked) => {
    const target = { checked, dataset: { act: "pick" }, closest: (s) => (s === ".entry" ? { dataset: { key } } : target) };
    (L.list.click || []).forEach((f) => f({ target }));
  };
  pick("a", true);
  assert.strictEqual(allBox(), "mixed", "some selected");
  assert.ok(els.selbar.innerHTML.includes("已选中 1 个"), els.selbar.innerHTML);
  assert.deepStrictEqual(btn("md"), ["下载选中的 1 个 .md", false, ""]);
  pick("b", true);
  assert.strictEqual(allBox(), "true", "all selected");
  assert.ok(els.selectAllSlot.innerHTML.includes("全选 2 个"), els.selectAllSlot.innerHTML);
  assert.deepStrictEqual([btn("md")[0], btn("delete")[0]], ["打包下载选中的 2 个 .md", "删除选中的 2 个的 AI 对话"]);
  // 清空选中 empties the selection and takes the bar away; 全选 selects every listed one again.
  const selClick = (sel) => (L.selbar.click || []).forEach((f) => f({ target: { closest: () => ({ dataset: { sel } }) } }));
  const headClick = (f) => (L.filters.click || []).forEach((h) => h({ target: { closest: () => ({ dataset: { f } }) } }));
  selClick("clear");
  assert.deepStrictEqual([allBox(), els.selbar.innerHTML], ["false", ""]);
  headClick("select-all");
  assert.deepStrictEqual([allBox(), btn("md")[0]], ["true", "打包下载选中的 2 个 .md"]);
  // A search keeps hidden selections (like the 分拣台): the buttons count and act on the listed ones; with every one
  // hidden they say all of them, disabled with 「选中的都被筛选隐藏了」; clearing the search brings the selection back.
  const search = async (q) => ((els.search.value = q), fire("input", {}), await wait(200));
  await search("img");
  assert.deepStrictEqual(btn("md"), ["下载选中的 1 个 .md", false, ""]);
  assert.ok(els.selbar.innerHTML.includes("另有 1 个被筛选隐藏"), els.selbar.innerHTML);
  await search("没有这个");
  assert.deepStrictEqual([btn("md"), btn("delete")], [["打包下载选中的 2 个 .md", true, "选中的都被筛选隐藏了"], ["删除选中的 2 个的 AI 对话", true, "选中的都被筛选隐藏了"]]);
  assert.ok(els.selbar.innerHTML.includes("已选中 2 个</strong><span class=\"muted\">都被筛选隐藏"), els.selbar.innerHTML);
  await search("");
  assert.deepStrictEqual([allBox(), btn("md")[0]], ["true", "打包下载选中的 2 个 .md"], "the selection is still there");
  // H4: 已打标签 with none tagged lists nothing and says why, as the other filters do.
  headClick("tagstate:tagged");
  assert.ok(html.includes("没有符合筛选的记录"), html);
  headClick("all");
  // H9: 删除 removes AI conversations only. A selected video with only a 备注 is not counted, and the tooltip says so;
  // with none that has a conversation it is disabled with the reason.
  const NOTES = ctx.MdgLimits.KEYS.triageNotes;
  store[NOTES] = { BV1note: { text: "备注", updatedAt: 9 } };
  onChanged({ [NOTES]: {} }, "local");
  await wait(350);
  const noteKey = html.match(/data-key="([^"]*BV1note[^"]*)"/)[1];
  pick(noteKey, true);
  assert.deepStrictEqual([btn("md")[0], btn("delete")], ["打包下载选中的 3 个 .md", ["删除选中的 2 个的 AI 对话", false, "选中的 3 个里，1 个没有 AI 对话，删除后会留下"]]);
  // A21: a 备注 closed by pressing another entry's button (focusout on pointerdown) redraws only after that press,
  // so the button the click lands on is still the one pressed.
  // A key pressed on the page (I, U), outside any text field.
  const press = (key, target = {}) => (L.document.keydown || []).forEach((f) => f({ key, target, preventDefault() {} }));
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
  assert.deepStrictEqual(btn("delete"), ["删除选中的 AI 对话", true, "选中的记录没有 AI 对话"]);
  // K13: each entry's button says what it deletes.
  assert.ok(html.includes('data-act="delete" class="quiet danger">删除 AI 对话</button>'), html);
  // The buttons top right in reading order: 继续问, 复制 Markdown, 下载 .md, 写入 Obsidian; 删除 is not among them.
  const [actsHtml] = html.split("<article").find((a) => a.includes('data-key="b"')).split('class="entry-acts"')[1].split("</div>");
  const actAt = (act) => actsHtml.indexOf(`data-act="${act}"`);
  assert.ok(actAt("ask") >= 0 && actAt("ask") < actAt("copy") && actAt("copy") < actAt("md") && (actAt("obsidian") < 0 || actAt("md") < actAt("obsidian")) && actAt("delete") < 0, actsHtml);
  // 删除 sits on the 问答 line; a record without AI conversations has none.
  assert.match(html.split("<article").find((a) => a.includes('data-key="b"')), /<div class="qa"><details>[^]*<\/details><button type="button" data-act="delete" class="quiet danger">删除 AI 对话<\/button><\/div>/);
  assert.ok(!html.split("<article").find((a) => a.includes(`data-key="${noteKey}"`)).includes('data-act="delete"'), "a 备注-only record has no 删除");
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
  assert.deepStrictEqual([btn("md")[0], els.status.textContent], ["下载选中的 1 个 .md", "已清空全部 AI 对话"]);
  // Out of the selection bar, 清空全部 still clears every conversation, not the selected one.
  assert.strictEqual(store.mdg_ai_conversations_v1.length, 0, "the unselected record's conversation is gone too");
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
  // askPage (a web page with no note, not open): the page dialog first; its choice goes along with every later send.
  let pageChoice = "";
  const writeSend = ctx.chrome.runtime.sendMessage;
  ctx.chrome.runtime.sendMessage = async (m) => (sent.push(m), !m.pageChoice ? { ok: true, askPage: true, url: "https://example.com/x" } : m.mode ? { ok: true, text: "已写入 Obsidian：q.md" } : { ok: true, ask: true, path: "p.md", hasAiSection: true, fullReason: "整篇覆盖要先打开视频页" });
  ctx.MdgOverwriteDialog.choosePage = async (url) => (url === "https://example.com/x" ? pageChoice : "wrong");
  await click();
  // K11: no note yet, so no 「原笔记未被覆盖」.
  assert.deepStrictEqual([sent.length, els.status.textContent], [1, "已取消写入 Obsidian"], "取消 sends nothing again");
  pageChoice = "own";
  await click();
  assert.deepStrictEqual([sent.map((m) => [m.pageChoice, m.mode]), els.status.textContent], [[[undefined, undefined], ["own", undefined], ["own", "full"]], "已写入 Obsidian：q.md"]);
  ctx.chrome.runtime.sendMessage = writeSend;
  // Not set up or a wrong key (OBSIDIAN): 去设置 after the red line, the settings page only on its click. A closed
  // Obsidian (OBSIDIAN_DOWN) gets the red line only.
  {
    const realCreate = ctx.document.createElement;
    let opened = 0;
    let kids = [];
    ctx.document.createElement = () => ({});
    ctx.chrome.runtime.openOptionsPage = () => opened++;
    els.status.append = (...n) => (kids = n.filter((k) => typeof k === "object"));
    for (const code of ["OBSIDIAN", "OBSIDIAN_DOWN"]) {
      kids = [];
      ctx.chrome.runtime.sendMessage = async (m) => (sent.push(m), { ok: false, error: "Key 不对", code });
      await click();
      assert.deepStrictEqual([els.status.textContent, red, kids.map((b) => b.textContent), opened], ["写入 Obsidian 失败：Key 不对", true, code === "OBSIDIAN" ? [ctx.MdgErrors.LABEL.toSettings] : [], 0], code);
      if (kids[0]) kids[0].onclick();
      assert.strictEqual(opened, code === "OBSIDIAN" ? 1 : 0);
      opened = 0;
    }
    ctx.chrome.runtime.sendMessage = writeSend;
    ctx.document.createElement = realCreate;
    delete els.status.append;
  }

  // B5: each entry offers 复制 Markdown, then 下载 .md, then 写入 Obsidian (hidden while Obsidian is off), like elsewhere.
  const at = (act) => html.indexOf(`data-act="${act}"`);
  assert.ok(at("copy") > 0 && at("copy") < at("md"), "复制 Markdown comes before 下载 .md");
  assert.match(html, /data-act="copy">复制 Markdown</);
  const act = async (name) => {
    const t = { dataset: { act: name }, closest: (s) => (s === ".entry" ? { dataset: { key: "a" } } : t) };
    (L.list.click || []).forEach((f) => f({ target: t }));
    await wait(20);
  };
  // 复制 and 下载 give the note 写入 Obsidian writes: export-note with the newest conversation, asked about with the
  // button's verb when the page is not open; what comes back is copied or downloaded as is.
  let copied = null;
  const exported = [];
  let pageAnswer = "open";
  const exportSend = async (m) => (exported.push(m), m.type !== "export-note" ? {} : m.pageChoice ? { ok: true, filename: "a.md", markdown: `---\n${m.pageChoice}` } : { ok: true, askPage: true, url: "https://example.com/x", video: true });
  ctx.chrome.runtime.sendMessage = exportSend;
  const verbs = [];
  ctx.MdgOverwriteDialog.choosePage = async (url, video, own, verb) => (verbs.push([url, video, own, verb].join()), pageAnswer);
  ctx.navigator = { clipboard: { writeText: async (text) => (copied = text) } };
  await act("copy");
  assert.deepStrictEqual([copied, exported.map((m) => [m.type, m.pageChoice || "-"].join()), exported[0].conversation.messages[0].content], ["---\nopen", ["export-note,-", "export-note,open"], XSS[0]]);
  assert.deepStrictEqual([els.status.textContent, red], ["已复制 Markdown", false]);
  // J26: the record deleted while the dialog is open: nothing is sent again or copied, and the line says so, not red.
  {
    const keep = [...store.mdg_ai_conversations_v1];
    const pageDialog = ctx.MdgOverwriteDialog.choosePage;
    ctx.MdgOverwriteDialog.choosePage = async () => {
      store.mdg_ai_conversations_v1 = keep.filter((c) => c.contextKey !== "a");
      onChanged({ mdg_ai_conversations_v1: {} }, "local");
      await wait(350);
      return "open";
    };
    copied = null;
    exported.length = 0;
    await act("copy");
    await wait(400);
    assert.deepStrictEqual([copied, exported.length, els.status.textContent, red], [null, 1, "记录已删除，未复制。", false]);
    store.mdg_ai_conversations_v1 = keep;
    onChanged({ mdg_ai_conversations_v1: {} }, "local");
    await wait(350);
    ctx.MdgOverwriteDialog.choosePage = pageDialog;
  }
  const realDownload = ctx.MdgDownload;
  const downloaded = [];
  ctx.MdgDownload = { ...realDownload, text: (name, text) => downloaded.push([name, text]) };
  await act("md");
  pageAnswer = "";
  await act("md");
  assert.deepStrictEqual([downloaded, verbs, els.status.textContent], [[["a.md", "---\nopen"]], ["https://example.com/x,true,true,复制", "https://example.com/x,true,true,下载", "https://example.com/x,true,true,下载"], "已取消下载"]);
  ctx.MdgDownload = realDownload;
  pageAnswer = "open";
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
    // Its note is P2's (the background adds the video's 备注 to it).
    exported.length = 0;
    ctx.chrome.runtime.sendMessage = exportSend;
    ctx.navigator.clipboard.writeText = async (text) => (copied = text);
    await on(p2Key, "copy");
    assert.deepStrictEqual([exported[0].ref.cid, exported[0].ref.pageIndex, exported[0].conversation.messages[0].content], ["c2", 2, "问"]);
    ctx.chrome.runtime.sendMessage = writeSend;
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


  // T8: the list as laid out: entries 100px tall from y=50, each found by its data-key in the html.
  {
    const win = ctx.window;
    win.scrollY = 0;
    win.scrollTo = (x, y) => (win.scrollY = y);
    win.scrollBy = (x, y) => (win.scrollY += y);
    const realQsa = els.list.querySelectorAll;
    els.list.querySelectorAll = (sel) =>
      sel !== ".entry" ? [] : [...html.matchAll(/data-key="([^"]*)"/g)].map((m, i) => ({
        dataset: { key: m[1].replace(/&amp;/g, "&") },
        getBoundingClientRect: () => ({ top: 50 + i * 100 - win.scrollY, bottom: 150 + i * 100 - win.scrollY })
      }));
    const keys = () => els.list.querySelectorAll(".entry").map((e) => e.dataset.key);
    const firstInView = () => els.list.querySelectorAll(".entry").find((e) => e.getBoundingClientRect().bottom > 0);
    const reload = async () => (onChanged({ mdg_ai_conversations_v1: {} }, "local"), await wait(350));
    // (a) A conversation saved in the background lands on top: the entry being read stays where it was.
    win.scrollY = 270;
    const read = firstInView();
    const at = read.getBoundingClientRect().top;
    store.mdg_ai_conversations_v1 = [...store.mdg_ai_conversations_v1, { ...conv("new", "新对话"), createdAt: 9e12, updatedAt: 9e12 }];
    await reload();
    assert.strictEqual(keys()[0], "new", "the new entry is on top");
    assert.deepStrictEqual([firstInView().dataset.key, firstInView().getBoundingClientRect().top, win.scrollY], [read.dataset.key, at, 370]);
    // (b) The focused 展开 of an entry keeps the focus once the list is rebuilt.
    const focused = [];
    const realQsa2 = els.list.querySelectorAll;
    els.list.querySelectorAll = (sel) => realQsa2(sel).map((e) => ({ ...e, querySelector: (q) => ({ focus: (o) => focused.push(JSON.stringify([e.dataset.key, q, o])) }) }));
    ctx.document.activeElement = { dataset: { act: "summary" }, closest: (sel) => (sel === ".entry" ? { dataset: { key: "b" } } : null) };
    await reload();
    ctx.document.activeElement = null;
    assert.deepStrictEqual(focused, [JSON.stringify(["b", '[data-act="summary"]', { preventScroll: true }])]);
    els.list.querySelectorAll = realQsa;
    // (c) 删除 takes the entry off the list before the write ends; a failed write brings it back, still selected, in red.
    let settle;
    ctx.chrome.storage.local.set = () => new Promise((ok, fail) => (settle = { ok, fail }));
    const del = { dataset: { act: "delete" }, closest: (sel) => (sel === ".entry" ? { dataset: { key: "new" } } : del) };
    pick("new", true);
    L.list.click.forEach((f) => f({ target: del }));
    await wait(20);
    assert.ok(!html.includes('data-key="new"') && settle, "gone while the write runs");
    settle.fail(new Error("存储已满"));
    await wait(20);
    assert.ok(html.includes('data-key="new"') && /data-key="new">\s*<input[^>]*checked/.test(html), "back and still selected");
    assert.deepStrictEqual([els.status.textContent, red], ["删除失败：存储已满", true]);
    L.list.click.forEach((f) => f({ target: del }));
    await wait(20);
    settle.ok();
    await wait(20);
    assert.ok(!html.includes('data-key="new"') && els.status.textContent === "已删除 1 条记录的 AI 对话");
    // 清空全部 too: the list is empty before the write ends.
    for (const f of L.clearAll.click) void f({});
    await wait(20);
    assert.ok(!html.includes('data-act="delete"'), "no conversation left while the write runs");
    settle.ok();
    await wait(20);
    ctx.chrome.storage.local.set = async () => {};
  }


  // A web page's conversations group under its page key (MdgSites.buildContextKey): one entry, its title linking the
  // page, no 备注 (备注 belong to videos), and 继续问 off with why.
  {
    const pageKey = ctx.MdgSites.buildContextKey({ url: "https://example.com/post#top" });
    assert.strictEqual(pageKey, "page:https://example.com/post");
    const page = { url: "https://example.com/post", title: "一篇文章", isVideoContext: false };
    const pageConv = (id, updatedAt) => ({ id, contextKey: pageKey, title: page.title, contextTitle: page.title, contextUrl: page.url, contextRef: page, isVideoContext: false, createdAt: updatedAt, updatedAt, messages: [{ role: "user", content: `问${id}` }, { role: "assistant", content: `答${id}` }] });
    store.mdg_ai_conversations_v1 = [pageConv("w1", 5), pageConv("w2", 6)];
    onChanged({ mdg_ai_conversations_v1: {} }, "local");
    await wait(350);
    const entries = html.split("<article").slice(1).filter((a) => a.includes("example.com/post"));
    assert.strictEqual(entries.length, 1, "one entry for the page");
    assert.ok(entries[0].includes('href="https://example.com/post"') && entries[0].includes("一篇文章") && entries[0].includes("2 段对话"), entries[0]);
    assert.ok(!entries[0].includes('data-act="note"') && !entries[0].includes("data-no-video"), entries[0]);
    // 继续问 on a page: the side panel opens on this window in the click, the page's tab is focused (or opened), and
    // the panel is asked for the page's conversation (askSidepanel), as for a video.
    const calls = [];
    const was = { sidePanel: ctx.chrome.sidePanel, tabs: ctx.chrome.tabs, set: ctx.chrome.storage.local.set };
    ctx.chrome.sidePanel = { open: async (o) => calls.push(["open", o]) };
    let openTabs = [{ id: 7, url: "https://example.com/post#top", windowId: 1 }];
    ctx.chrome.tabs = { ...was.tabs, query: async () => openTabs, update: async (id, o) => (calls.push(["focus", id]), { id }), create: async (o) => (calls.push(["create", o.url]), { id: 9 }) };
    ctx.chrome.storage.local.set = async (o) => calls.push(["ask", Object.values(o)[0].tabId, Object.values(o)[0].contextRef.url]);
    const askPage = async () => {
      const t = { dataset: { act: "ask" }, closest: (s) => (s === ".entry" ? { dataset: { key: pageKey } } : t) };
      L.list.click.forEach((f) => f({ target: t }));
      await wait(20);
    };
    await askPage();
    const taken = () => JSON.parse(JSON.stringify(calls.splice(0)));
    assert.deepStrictEqual(taken(), [["open", {}], ["focus", 7], ["ask", 7, "https://example.com/post"]]);
    openTabs = [];
    await askPage();
    assert.deepStrictEqual(taken(), [["open", {}], ["create", "https://example.com/post"], ["ask", 9, "https://example.com/post"]]);
    // J12: a YouTube video is read only from its page (pageOnly), so its 继续问 focuses or opens that page as a web
    // page's does, instead of a side panel that can only say 请先打开这个 YouTube 视频页.
    {
      const yt = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
      const ytRef = { url: yt, title: "YT", site: "youtube", videoId: "dQw4w9WgXcQ", isVideoContext: true };
      const ytKey = ctx.MdgSites.buildContextKey(ytRef);
      const saved = store.mdg_ai_conversations_v1;
      store.mdg_ai_conversations_v1 = [...saved, { id: "y1", contextKey: ytKey, title: "YT", contextTitle: "YT", contextUrl: yt, contextRef: ytRef, isVideoContext: true, createdAt: 7, updatedAt: 7, messages: [{ role: "user", content: "问" }, { role: "assistant", content: "答" }] }];
      onChanged({ mdg_ai_conversations_v1: {} }, "local");
      await wait(350);
      const askYt = async () => {
        const t = { dataset: { act: "ask" }, closest: (sel) => (sel === ".entry" ? { dataset: { key: ytKey } } : t) };
        L.list.click.forEach((f) => f({ target: t }));
        await wait(20);
      };
      openTabs = [{ id: 11, url: `${yt}&t=30s`, windowId: 1 }];
      await askYt();
      assert.deepStrictEqual(taken(), [["open", {}], ["focus", 11], ["ask", 11, yt]]);
      openTabs = [];
      await askYt();
      assert.deepStrictEqual(taken(), [["open", {}], ["create", yt], ["ask", 9, yt]]);
      store.mdg_ai_conversations_v1 = saved;
      onChanged({ mdg_ai_conversations_v1: {} }, "local");
      await wait(350);
    }
    Object.assign(ctx.chrome, { sidePanel: was.sidePanel, tabs: was.tabs });
    ctx.chrome.storage.local.set = was.set;
    assert.match(els.count.textContent, /个视频、1 个网页 · 对话 2\//);
  }

  // 星标 and tags: one mark per record (every part of a video), kept in MdgLimits.KEYS.readingMarks.
  {
    const MARKS = ctx.MdgLimits.KEYS.readingMarks;
    const BV = "BV1star00001";
    const videoKey = `video:bilibili:${BV}|`;
    const pageKey = "page:https://example.com/post";
    const qa = [{ role: "user", content: "问" }, { role: "assistant", content: "答" }];
    const part = (n) => ({ id: `s${n}`, contextKey: `video:bilibili:${BV}|c${n}`, title: "星标视频", contextRef: { site: "bilibili", videoId: BV, cid: `c${n}`, pageIndex: n, title: "星标视频", url: `https://www.bilibili.com/video/${BV}` }, createdAt: n, updatedAt: n, messages: qa });
    const webConvs = store.mdg_ai_conversations_v1;
    store.mdg_ai_conversations_v1 = [part(1), part(2), ...webConvs];
    store[ctx.MdgLimits.KEYS.triageTags] = [{ id: "ft1", name: "分拣标签", color: "#888888", folder: "1" }, { id: "ft2", name: "分拣标签", color: "#888888", folder: "2" }];
    store[ctx.MdgLimits.KEYS.triageVideoTags] = { [BV]: ["ft1", "ft2"] };
    ctx.chrome.storage.local.set = async (o) => Object.assign(store, o);
    ctx.CSS = { escape: (s) => s };
    ctx.confirm = () => true;
    const plain = (v) => JSON.parse(JSON.stringify(v ?? null));
    const reload = async () => (onChanged({ [MARKS]: {} }, "local"), await wait(350));
    const entry = (key) => html.split("<article").find((a) => a.includes(`data-key="${key}"`)) || "";
    const on = async (key, name) => {
      const t = { dataset: { act: name }, closest: (sel) => (sel === ".entry" ? { dataset: { key } } : t) };
      (L.list.click || []).forEach((f) => f({ target: t }));
      await wait(20);
    };
    const filter = async (f) => (L.filters.click.forEach((h) => h({ target: { closest: () => ({ dataset: { f } }) } })), await wait(20));
    await reload();
    const p1 = `${videoKey}c1`;
    const p2 = `${videoKey}c2`;
    // J18: the header counts videos by record (MdgLimits.readingKeyOf), as 星标, tags and 备注 do: P1 and P2 are one video.
    assert.match(els.count.textContent, /^3 个视频、1 个网页 · /);

    // 「+ 标签」 ends the tags line, after the chips, and is there alone without tags; with no 备注, 「✎ 备注」 is in the
    // body where the 备注 would show.
    assert.match(entry(p1), /分拣标签<\/span><button type="button" class="quiet tag-plus" data-act="tags"/);
    assert.match(entry(pageKey), /<div class="chips"><button type="button" class="quiet tag-plus" data-act="tags"/);
    const body = entry(p1).split('class="entry-acts"')[0];
    assert.ok(body.includes('class="quiet note-add" data-act="note">✎ 备注</button>') && !entry(p1).split('class="entry-acts"')[1].includes('data-act="note"'), entry(p1));
    // ☆ before the title; a click stars the video (both parts) and keeps its title and address.
    assert.match(entry(p1), /data-act="star" aria-pressed="false" aria-label="加星标" title="加星标">☆<\/button>\s*<div class="card-body">\s*<a class="title"/);
    await on(p1, "star");
    const item = store[MARKS].items[videoKey];
    assert.ok(item.star > 0 && item.ref.title === "星标视频" && item.ref.videoId === BV, JSON.stringify(item));
    for (const k of [p1, p2]) assert.ok(entry(k).includes('aria-pressed="true" aria-label="取消星标" title="取消星标">★'), entry(k));
    // 清空全部 keeps a starred record's conversations and says so; they are not counted against the cap.
    assert.ok(els.count.textContent.includes("星标 2 段不计"), els.count.textContent);
    const allConvs = store.mdg_ai_conversations_v1;
    let asked = "";
    ctx.confirm = (text) => ((asked = text), true);
    for (const f of L.clearAll.click) await f({});
    assert.ok(asked.includes("加了星标的记录的 2 段不删"), asked);
    assert.deepStrictEqual(plain(store.mdg_ai_conversations_v1.map((c) => c.id).sort()), ["s1", "s2"]);
    assert.strictEqual(els.clearAll.title, "只剩加了星标的记录的 AI 对话");
    ctx.confirm = () => true;
    store.mdg_ai_conversations_v1 = allConvs;
    await reload();
    // The 分拣台's tags show read-only, one per name, and are said to be edited there.
    assert.strictEqual(entry(p1).split("triage-tag").length - 1, 1, entry(p1));
    assert.ok(entry(p1).includes('<span class="chip triage-tag" style="--c:#888888" title="分拣台的标签，在分拣台里改">分拣标签</span>'), entry(p1));
    // 星标 filter: only starred records are listed.
    await filter("star");
    assert.ok(entry(p1) && entry(p2) && !entry(pageKey), html);
    assert.match(els.stateRow.innerHTML, /data-f="star" aria-pressed="true">★ 星标 2</);
    // Unstarred under the filter: still listed (☆) until the page reloads, so the row does not vanish under the cursor.
    await on(p1, "star");
    assert.ok(entry(p1).includes("☆"), html);
    assert.match(els.stateRow.innerHTML, />★ 星标 2</, "the 星标 count is what the list under it shows");
    await on(p1, "star");
    // 「全部」 clears row 2.
    await filter("all");
    assert.ok(entry(pageKey) && /data-f="all" aria-pressed="true">全部 /.test(els.stateRow.innerHTML), els.stateRow.innerHTML);

    // A starred record stays when every conversation of it is gone, from what the mark kept.
    store.mdg_ai_conversations_v1 = [...webConvs, conv("untagged", "没有标签")];
    await reload();
    assert.ok(entry(videoKey).includes("星标视频") && entry(videoKey).includes("仅星标，没有 AI 对话") && entry(videoKey).includes("★"), entry(videoKey));
    // It is placed by when it was first marked: unstarring and starring again does not move it.
    const order = () => [...html.matchAll(/data-key="([^"]+)"/g)].map((m) => m[1]).join();
    // A record newer than its first mark is listed above it, and stays above.
    Object.assign(store[MARKS].items[videoKey], { at: 1000, updatedAt: 1000 });
    store.mdg_ai_conversations_v1.find((c) => c.id === "untagged").updatedAt = 2000;
    await reload();
    const before = order();
    assert.ok(before.indexOf("untagged") < before.indexOf(videoKey), before);
    await on(videoKey, "star");
    await on(videoKey, "star");
    assert.strictEqual(order(), before);

    // 打标签 on the selected records: a tag made in the picker goes on all of them.
    let picker = null;
    ctx.TagPicker = { ...ctx.TagPicker, open: (o) => (picker = o) };
    pick(videoKey, true);
    pick(pageKey, true);
    assert.ok(/<button type="button" data-sel="tags" aria-label="打标签">打标签<\/button>/.test(els.selbar.innerHTML), els.selbar.innerHTML);
    L.selbar.click.forEach((f) => f({ target: { closest: () => ({ dataset: { sel: "tags" } }) } }));
    assert.deepStrictEqual(plain([picker.title, [...picker.targets].sort(), picker.anchor]), ["给选中的 2 个打标签", [pageKey, videoKey], ""]);
    const tag = await picker.create(" 读过 ");
    assert.deepStrictEqual(plain([tag.name, store[MARKS].tags.map((t) => t.name)]), ["读过", ["读过"]]);
    assert.strictEqual(await picker.create("读过"), store[MARKS].tags[0], "the same name is the same tag");
    await picker.onClose(picker.targets.map((key) => ({ key, add: [tag.id], remove: [] })));
    await wait(20);
    assert.deepStrictEqual(plain([store[MARKS].items[videoKey].tags, store[MARKS].items[pageKey].tags, store[MARKS].items[pageKey].ref.url]), [[tag.id], [tag.id], "https://example.com/post"]);
    assert.ok(entry(pageKey).includes('aria-label="去掉标签 读过"'), entry(pageKey));
    // A tag chip on a card takes the tag off that record with a click; U puts it back.
    const chip = { dataset: { untag: tag.id }, closest: (sel) => (sel === ".entry" ? { dataset: { key: pageKey } } : chip) };
    L.list.click.forEach((f) => f({ target: chip }));
    await wait(20);
    assert.deepStrictEqual(plain([store[MARKS].items[pageKey], els.status.textContent]), [null, "已去掉「读过」 · U 撤销"]);
    press("u");
    await wait(20);
    assert.deepStrictEqual(plain(store[MARKS].items[pageKey].tags), [tag.id], "U puts it back");
    // U: that close is one step; for 2 records it asks first, then puts their tags back in one marks write.
    confirmAnswer = false;
    press("u");
    await wait(20);
    assert.ok(asks.at(-1)[0] === "撤销批量改标签？" && asks.at(-1)[2] === "撤销" && store[MARKS].items[pageKey].tags.length === 1, JSON.stringify(asks.at(-1)));
    confirmAnswer = true;
    press("u");
    await wait(20);
    assert.deepStrictEqual(plain([store[MARKS].items[videoKey].tags, store[MARKS].items[pageKey]]), [[], null], "the tags as before the close; a record left with nothing is dropped");
    await picker.onClose(picker.targets.map((key) => ({ key, add: [tag.id], remove: [] })));
    await wait(20);
    // A record's own 「+ 标签」 opens the picker under it, for that record alone.
    await on(pageKey, "tags");
    assert.deepStrictEqual(plain([picker.targets, picker.anchor]), [[pageKey], `.entry[data-key="${pageKey}"] .tag-plus`]);
    // Counts as on the 分拣台: each group leaves out its own choice and keeps the search and the other row. A third page,
    // tagged in storage (not here, so a filter hides it), tells the rules apart.
    const third = "page:https://example.com/third";
    const convsBefore = store.mdg_ai_conversations_v1;
    store.mdg_ai_conversations_v1 = [...convsBefore, { ...conv(third, "第三篇"), contextUrl: "https://example.com/third", contextRef: { url: "https://example.com/third", title: "第三篇" } }];
    store[MARKS].items[third] = { star: 0, tags: [tag.id], ref: { site: "", videoId: "", url: "https://example.com/third", title: "第三篇" }, at: 1, updatedAt: 1 };
    const marksBefore = JSON.parse(JSON.stringify(store[MARKS]));
    store[MARKS].tags = [...store[MARKS].tags, { id: "t2", name: "乙", color: "#222222" }];
    store[MARKS].items[videoKey].tags = [...store[MARKS].items[videoKey].tags, "t2"];
    await reload();
    const count = (re) => Number((els.stateRow.innerHTML + els.tagRow.innerHTML).match(re)?.[1]);
    const STAR_N = />★ 星标 (\d+)</, ALL_N = />全部 (\d+)</, TAG_N = /按标签筛选 读过 (\d+)/;
    assert.deepStrictEqual([count(STAR_N), count(TAG_N)], [1, 3]);
    await search("一篇文章");
    assert.deepStrictEqual([count(STAR_N), count(ALL_N), count(TAG_N)], [0, html.split("<article").length - 1, 1], "the search scopes every count");
    // J5: row 4 lists only the tags the listed records carry (乙 is on the video, searched away), and a tag turned on.
    assert.ok(!els.tagRow.innerHTML.includes("按标签筛选 乙"), els.tagRow.innerHTML);
    await filter("tag:t2");
    assert.ok(els.tagRow.innerHTML.includes("按标签筛选 乙 0"), els.tagRow.innerHTML);
    await filter("tag:t2");
    await search("");
    await filter("star");
    // J21: the page tagged here is not starred: tag edits keep nothing under 星标 (only a 星标 click does).
    assert.deepStrictEqual([count(STAR_N), count(TAG_N)], [1, 1], "星标 scopes the tag counts, not its own");
    await filter("star");
    await filter(`tag:${tag.id}`);
    assert.deepStrictEqual([count(STAR_N), count(ALL_N), count(TAG_N)], [1, 3, 3], "a tag scopes row 2, not its own count");
    await filter(`tag:${tag.id}`);
    await filter("tag:t2");
    assert.strictEqual(count(TAG_N), 3, "another tag of the row does not scope it either");
    await filter("tag:t2");
    store[MARKS] = marksBefore;
    delete store[MARKS].items[third];
    store.mdg_ai_conversations_v1 = convsBefore;
    await reload();
    // The tag filter and the search find the tagged records; the export carries the tags and 星标.
    await filter(`tag:${tag.id}`);
    assert.ok(entry(videoKey) && entry(pageKey) && !entry("untagged"), html);
    // J21: under a tag filter, a record whose tag comes off leaves the list at once, as on the 分拣台; U brings it back.
    const off = { dataset: { untag: tag.id }, closest: (sel) => (sel === ".entry" ? { dataset: { key: pageKey } } : off) };
    L.list.click.forEach((f) => f({ target: off }));
    await wait(20);
    assert.ok(!entry(pageKey) && entry(videoKey), html);
    press("u");
    await wait(20);
    assert.ok(entry(pageKey) && els.status.textContent === "已撤销：去掉「读过」", els.status.textContent);
    await filter(`tag:${tag.id}`);
    // 未打标签 / 已打标签 as on the 分拣台, by the record's own tags; 全部 clears them.
    await filter("tagstate:untagged");
    assert.ok(entry("untagged") && /data-f="tagstate:untagged" aria-pressed="true">未打标签 \d+</.test(els.stateRow.innerHTML), els.stateRow.innerHTML);
    await filter("tagstate:tagged");
    assert.ok(!entry("untagged") && entry(videoKey) && entry(pageKey), html);
    await filter("all");
    assert.ok(entry("untagged") && !els.stateRow.innerHTML.includes('aria-pressed="true">已打标签'), els.stateRow.innerHTML);
    await search("读过");
    assert.ok(entry(videoKey) && entry(pageKey), html);
    await search("分拣标签");
    assert.ok(entry(videoKey) && !entry(pageKey), "the search matches 分拣台 tag names too");
    // As the 分拣台's: every word, each anywhere in the record.
    await search("星标视频 分拣标签");
    assert.ok(entry(videoKey) && !entry(pageKey), html);
    await search("星标视频 没有这个词");
    assert.ok(!entry(videoKey), html);
    await search("");
    // A record with no conversation is exported too: its note carries the tags and 星标 (the background's MdgNote.triageExtras).
    exported.length = 0;
    const wasSend = ctx.chrome.runtime.sendMessage;
    ctx.chrome.runtime.sendMessage = exportSend;
    await on(videoKey, "copy");
    ctx.chrome.runtime.sendMessage = wasSend;
    assert.deepStrictEqual([exported[0].type, `video:${exported[0].ref.site}:${exported[0].ref.videoId}|`, exported[0].conversation.messages.length], ["export-note", videoKey, 0]);

    // Deleting a tag in 标签管理 takes it off every record; the page, left with nothing, stays listed until a reload.
    await filter("manage");
    assert.ok(els.tagsRows.innerHTML.includes("读过") && els.tagsRows.innerHTML.includes("2 个记录"), els.tagsRows.innerHTML);
    const del = { closest: (sel) => (sel === ".tag-row" ? { dataset: { id: tag.id } } : sel === "[data-tag-del]" ? {} : null) };
    for (const f of L.tagsRows.click) await f({ target: del });
    assert.deepStrictEqual(asks.at(-1), ["删除标签「读过」？", "<p>将从 2 个记录上去掉这个标签，无法撤销。</p>", "删除", { danger: true }], "a red 删除, the body as html");
    assert.deepStrictEqual(plain([store[MARKS].tags, store[MARKS].items[videoKey].tags, store[MARKS].items[pageKey]]), [[], [], null]);
    assert.ok(entry(pageKey) && !entry(pageKey).includes("读过"), entry(pageKey));

    // Unstarring a record with nothing else: gone from storage, still listed (☆) until the page reloads.
    await on(videoKey, "star");
    assert.strictEqual(store[MARKS].items[videoKey], undefined);
    assert.ok(entry(videoKey).includes("☆") && entry(videoKey).includes("星标视频"), entry(videoKey));
    // Tagged again after that, it stays unstarred.
    await on(videoKey, "tags");
    const again = await picker.create("再看");
    await picker.onClose([{ key: videoKey, add: [again.id], remove: [] }]);
    await wait(20);
    assert.deepStrictEqual(plain([store[MARKS].items[videoKey].star, store[MARKS].items[videoKey].tags]), [0, [again.id]]);
    pick(videoKey, false);
    pick(pageKey, false);
  }

  // ✦ AI 打标签: one request per batch keyed by record (a video's parts are one record, a web page is one), the proposal
  // applied in one marks write, new tags within READING_TAGS.
  {
    const MARKS = ctx.MdgLimits.KEYS.readingMarks;
    const BV = "BV1star00001";
    const videoKey = `video:bilibili:${BV}|`;
    const pageKey = "page:https://example.com/post";
    const qa = (q) => [{ role: "user", content: q }, { role: "assistant", content: "答" }];
    const part = (n) => ({ id: `s${n}`, contextKey: `video:bilibili:${BV}|c${n}`, title: "星标视频", contextRef: { site: "bilibili", videoId: BV, cid: `c${n}`, pageIndex: n, title: "星标视频", url: `https://www.bilibili.com/video/${BV}` }, createdAt: n, updatedAt: 10 + n, messages: qa(`第${n}P 讲了什么`) });
    const web = { id: "w", contextKey: pageKey, title: "一篇文章", contextUrl: "https://example.com/post", contextRef: { title: "一篇文章", url: "https://example.com/post", isVideoContext: false }, createdAt: 1, updatedAt: 1, messages: qa("这篇的结论") };
    const old = { id: "t1", name: "旧", color: "#111111" };
    const reset = async (tags = [old]) => {
      for (const k of Object.keys(store)) delete store[k];
      Object.assign(store, {
        mdg_ai_conversations_v1: [part(1), part(2), web],
        [ctx.MdgLimits.KEYS.triageAnalysis(BV)]: { status: "done", oneLiner: "讲 Transformer", points: [] },
        [ctx.MdgLimits.KEYS.triageNotes]: { [BV]: { text: "值得再看", updatedAt: 1 } },
        [MARKS]: { tags, items: {} }
      });
      onChanged({ [MARKS]: {} }, "local");
      await wait(350);
    };
    await reset();
    const plain = (v) => JSON.parse(JSON.stringify(v ?? null));
    let ad = null;
    const realOpen = ctx.TagDialogs.ai.open;
    ctx.TagDialogs.ai.open = (a) => (ad = a);
    L.filters.click.forEach((h) => h({ target: { closest: () => ({ dataset: { f: "ai" } }) } }));
    await wait(20);
    assert.ok(els.tagActs.innerHTML.includes('data-f="ai"') && ad?.who === "记录", "「✦ AI 打标签」 opens the dialog with 摘读记录's adapter");
    // Scopes: 当前筛选 counts records (the video's two parts once); 选中 counts the selected ones, hidden or not.
    const scopes = () => plain(ad.scopes().map((s) => [s.value, s.n, s.shown]));
    assert.deepStrictEqual(scopes(), [["filter", 2, null], ["selected", 0, 0]]);
    pick(`video:bilibili:${BV}|c1`, true);
    pick(`video:bilibili:${BV}|c2`, true);
    assert.deepStrictEqual(scopes(), [["filter", 2, null], ["selected", 1, 1]]);
    await search("一篇文章");
    assert.deepStrictEqual(scopes(), [["filter", 1, null], ["selected", 1, 0]], "a hidden selection still counts in n, not in shown");
    await search("");
    pick(`video:bilibili:${BV}|c1`, false);
    pick(`video:bilibili:${BV}|c2`, false);
    assert.strictEqual(ad.room(), 5, "the new-tag cap's default");

    // A run: one request with both records by key, what the AI reads of each.
    const sent = [];
    const answer = { newTags: ["新"], assignments: { [videoKey]: { add: ["新", "旧"], remove: [] }, [pageKey]: { add: ["旧"], remove: [] } }, note: "按主题分" };
    ctx.chrome.runtime.sendMessage = async (msg) => (sent.push(plain(msg)), { ok: true, data: answer });
    await ad.run({ instruction: "按主题分", scope: "filter", allowRemove: false });
    assert.strictEqual(sent.length, 1);
    const { type, items, tags, maxNewTags, aiProviderId } = sent[0];
    assert.deepStrictEqual([type, tags, maxNewTags, aiProviderId], ["triage-reading-ai-tag", [{ name: "旧", rule: "" }], 5, "b"]);
    const byId = Object.fromEntries(items.map((it) => [it.id, it]));
    assert.deepStrictEqual(Object.keys(byId).sort(), [pageKey, videoKey]);
    // A record with conversations sends their 问/答, oldest first, not the AI 总结 or 备注.
    assert.deepStrictEqual(byId[videoKey], { id: videoKey, title: "星标视频", site: "B站", currentTags: [], turns: [{ q: "第1P 讲了什么", a: "答" }, { q: "第2P 讲了什么", a: "答" }] });
    assert.deepStrictEqual([byId[pageKey].site, byId[pageKey].turns], ["网页", [{ q: "这篇的结论", a: "答" }]]);
    assert.deepStrictEqual(plain(ad.proposal().rows.map((r) => [r.id, r.add]).sort()), [[pageKey, ["id:t1"]], [videoKey, ["new:新", "id:t1"]]]);

    // 应用: the new tag and both records' tags in one marks write; a page keeps its address.
    const realSet = ctx.chrome.storage.local.set;
    let writes = 0;
    ctx.chrome.storage.local.set = async (o) => ((writes += MARKS in o), Object.assign(store, o));
    await ad.apply();
    const made = store[MARKS].tags.find((t) => t.name === "新");
    assert.ok(made, plain(store[MARKS].tags));
    assert.deepStrictEqual(plain([writes, [...store[MARKS].items[videoKey].tags].sort(), store[MARKS].items[pageKey].tags, store[MARKS].items[pageKey].ref.url]), [1, ["t1", made.id].sort(), ["t1"], "https://example.com/post"]);
    assert.strictEqual(ad.proposal(), null);
    assert.ok(html.includes('aria-label="去掉标签 新"'), "the chips show on the records");

    // Room: never past READING_TAGS (50); 应用 creates only what fits.
    const many = (n) => Array.from({ length: n }, (_, i) => ({ id: `m${i}`, name: `标签${i}`, color: "#222222" }));
    await reset(many(48));
    assert.strictEqual(ad.room(), 2);
    await reset(many(50));
    assert.strictEqual(ad.room(), 0, "full: the AI may make none");
    await reset(many(49));
    assert.strictEqual(ad.room(), 1);
    ctx.chrome.runtime.sendMessage = async () => ({ ok: true, data: { newTags: ["甲", "乙"], assignments: { [videoKey]: { add: ["甲", "乙"], remove: [] } }, note: "" } });
    await ad.run({ instruction: "分", scope: "filter", allowRemove: false });
    // H3: the review is told up front which ticked new tag 应用 will not create, and why.
    const skip = ad.notMade(ad.proposal());
    assert.deepStrictEqual([[...skip.keys], skip.why], [["乙"], "摘读记录的标签最多 50 个"]);
    writes = 0;
    await ad.apply();
    assert.deepStrictEqual(plain([writes, store[MARKS].tags.length, store[MARKS].items[videoKey].tags.length]), [1, 50, 1], "one of the two new tags fits");
    assert.match(els.status.textContent, /1 个新标签没有建/);

    // A tag deleted while the run waits for the AI: the proposal naming it is dropped, not kept for 应用.
    await reset();
    ctx.chrome.runtime.sendMessage = async () => {
      store[MARKS] = { tags: [], items: {} };
      onChanged({ [MARKS]: {} }, "local");
      await wait(350);
      return { ok: true, data: answer };
    };
    await ad.run({ instruction: "按主题分", scope: "filter", allowRemove: false });
    assert.strictEqual(ad.proposal(), null);
    assert.ok(els.status.textContent.includes(ctx.TriageUi.AI_TAG_GONE), els.status.textContent);

    // J24: the instruction goes into the stored 最近指令 by read-modify-write: one another 摘读记录 tab added meanwhile is kept.
    await reset();
    {
      const sets = [];
      const realSet = ctx.chrome.storage.local.set;
      ctx.chrome.storage.local.set = async (o) => sets.push(o);
      const HISTORY = ctx.MdgLimits.KEYS.readingAiHistory;
      store[HISTORY] = ["另一标签页的指令"];
      ctx.chrome.runtime.sendMessage = async (msg) => (msg.type === "triage-settings-get" ? { ok: false } : { ok: true, data: answer });
      await ad.run({ instruction: "按主题打标签", scope: "filter", allowRemove: false });
      await wait(20);
      assert.deepStrictEqual(plain(sets.find((o) => HISTORY in o)?.[HISTORY]), ["按主题打标签", "另一标签页的指令"]);
      ctx.chrome.storage.local.set = realSet;
      delete store[HISTORY];
      ad.discard(); // the run's proposal is not this test's subject
      await wait(20);
    }

    // J25: the proposal's save is still queued when it is applied or discarded: the clear waits behind it under the key
    // lock, so the applied proposal does not come back.
    await reset();
    {
      const KEY = ctx.MdgLimits.KEYS.readingAiProposal;
      const realSet = ctx.chrome.storage.local.set;
      let release;
      ctx.chrome.storage.local.set = (o) => (KEY in o && o[KEY] && !release ? new Promise((r) => (release = () => (Object.assign(store, o), r()))) : (Object.assign(store, o), Promise.resolve()));
      ctx.chrome.runtime.sendMessage = async (msg) => (msg.type === "triage-settings-get" ? { ok: false } : { ok: true, data: answer });
      await ad.run({ instruction: "按主题分", scope: "filter", allowRemove: false });
      await wait(20);
      assert.ok(release && ad.proposal(), "the proposal's save is waiting");
      ad.discard();
      await wait(20);
      release();
      await wait(20);
      assert.strictEqual(store[KEY], null, "the late save does not bring the discarded proposal back");
      ctx.chrome.storage.local.set = realSet;
    }


    // 应用 → 「AI 刚打的」 → U. Storage keeps what is written from here on.
    ctx.chrome.storage.local.set = async (o) => Object.assign(store, o);
    const { readingAiProposal: PROPOSAL, readingAiRecent: RECENT } = ctx.MdgLimits.KEYS;
    const entry = (key) => html.split("<article").find((a) => a.includes(`data-key="${key}"`)) || "";
    const filterClick = async (f) => (L.filters.click.forEach((h) => h({ target: { closest: () => ({ dataset: { f } }) } })), await wait(20));
    await reset();
    pick(`video:bilibili:${BV}|c1`, true);
    assert.ok(els.tagActs.innerHTML.includes(">AI 打标签选中的 1 个</button>"), els.tagActs.innerHTML);
    pick(`video:bilibili:${BV}|c1`, false);
    let release;
    ctx.chrome.runtime.sendMessage = (msg) => (msg.type === "triage-settings-get" ? Promise.resolve({ ok: false }) : new Promise((r) => (release = () => r({ ok: true, data: answer }))));
    const running = ad.run({ instruction: "按主题分", scope: "filter", allowRemove: false });
    await wait(20);
    assert.ok(els.tagActs.innerHTML.includes(">AI 打标签 · 运行中</button>"), els.tagActs.innerHTML);
    release();
    await running;
    assert.ok(els.tagActs.innerHTML.includes(">AI 打标签 · 待确认</button>"), els.tagActs.innerHTML);
    await wait(20); // the write goes under the key's lock (MdgLimits.update), a tick after the run settles
    assert.deepStrictEqual(plain(store[PROPOSAL]), plain(ad.proposal()), "the proposal is stored for a reload");
    await ad.apply();
    await wait(20);
    assert.strictEqual(store[PROPOSAL], null, "cleared under the key lock, as null");
    assert.deepStrictEqual(plain(store[RECENT].keys.sort()), [pageKey, videoKey].sort());
    assert.ok(/data-f="recent" title="[^"]*在记录上逐个看，不对的点「\+ 标签」改[^"]*" aria-pressed="true">.*AI 刚打的 3/.test(els.stateRow.innerHTML), els.stateRow.innerHTML); // entries, as the other chips count
    // A record the run did not change is not listed under 「AI 刚打的」; its × stops marking them and lists it again.
    store.mdg_ai_conversations_v1 = [...store.mdg_ai_conversations_v1, { ...web, id: "w2", contextKey: "page:https://example.com/other", contextUrl: "https://example.com/other", contextRef: { ...web.contextRef, url: "https://example.com/other" } }];
    onChanged({ mdg_ai_conversations_v1: {} }, "local");
    await wait(350);
    assert.ok(entry(pageKey) && !entry("page:https://example.com/other"), html);
    await filterClick("recent-done");
    assert.ok(entry("page:https://example.com/other") && store[RECENT] === undefined && !els.stateRow.innerHTML.includes("AI 刚打的"), html);
    // U on the 应用: asks (2 records), puts both records' tags back, deletes the tag it made.
    await reset();
    ctx.chrome.runtime.sendMessage = async (msg) => (msg.type === "triage-settings-get" ? { ok: false } : { ok: true, data: answer });
    await ad.run({ instruction: "按主题分", scope: "filter", allowRemove: false });
    await ad.apply();
    asks.length = 0;
    const undoAsked = () => asks.at(-1)?.[0] || "";
    press("u", { closest: () => ({ tagName: "TEXTAREA" }) });
    await wait(20);
    assert.ok(!undoAsked() && store[MARKS].items[videoKey], "U typed in a text field is text");
    press("u");
    await wait(20);
    assert.ok(undoAsked().startsWith("撤销这次 AI 打标签？"), undoAsked());
    const tagsNow = Object.values(store[MARKS].items).flatMap((item) => item.tags);
    assert.deepStrictEqual(plain([store[MARKS].tags.map((t) => t.name), tagsNow, store[RECENT]]), [["旧"], [], null], "tags as before, 新 deleted, 「AI 刚打的」 gone");
    ctx.confirm = () => true;
    // A stored proposal comes back on a reload; one naming a deleted tag is dropped there.
    ad.discard();
    await wait(20); // the clear is written under the key lock
    store[PROPOSAL] = { newTags: [], rows: [{ id: pageKey, add: ["id:t1"], remove: [] }], notes: [], errors: [] };
    onChanged({ [MARKS]: {} }, "local");
    await wait(350);
    assert.deepStrictEqual(plain(ad.proposal().rows), [{ id: pageKey, add: ["id:t1"], remove: [] }]);
    ad.discard();
    await wait(20);
    store[PROPOSAL] = { newTags: [], rows: [{ id: pageKey, add: ["id:gone"], remove: [] }], notes: [], errors: [] };
    onChanged({ [MARKS]: {} }, "local");
    await wait(350);
    assert.deepStrictEqual([ad.proposal(), store[PROPOSAL]], [null, null]);
    // I opens ✦ AI 打标签, not with a dialog open.
    ad = null;
    ctx.document.querySelector = (sel) => (sel === "dialog[open]" ? {} : null);
    press("i");
    await wait(20);
    assert.strictEqual(ad, null);
    ctx.document.querySelector = () => null;
    press("i");
    await wait(20);
    assert.strictEqual(ad?.who, "记录");
    // / goes to the search box, as on the 分拣台.
    let searchFocused = false;
    els.search.focus = () => (searchFocused = true);
    press("/");
    assert.ok(searchFocused, "/ focuses the search");

    // What the AI reads: answers are cut to the budget before questions; a record without a conversation sends its AI
    // 总结 and 备注.
    await reset();
    const NOTE_BV = "BV1onlynote1";
    store.mdg_ai_conversations_v1 = [{ ...web, messages: [{ role: "user", content: "问一" }, { role: "assistant", content: "x".repeat(1000) }, { role: "user", content: "问二" }, { role: "assistant", content: "y".repeat(1000) }] }];
    store[ctx.MdgLimits.KEYS.triageNotes] = { [NOTE_BV]: { text: "只有备注", updatedAt: 1 } };
    onChanged({ [MARKS]: {} }, "local");
    await wait(350);
    sent.length = 0;
    ctx.chrome.runtime.sendMessage = async (msg) => (sent.push(plain(msg)), msg.type === "triage-settings-get" ? { ok: false } : { ok: true, data: { newTags: [], assignments: {}, note: "" } });
    await ad.run({ instruction: "分", scope: "filter", allowRemove: false });
    const read = Object.fromEntries(sent.find((m) => m.type === "triage-reading-ai-tag").items.map((it) => [it.id, it]));
    const half = (ctx.TriageUi.READING_AI_CHARS - 4) / 2;
    assert.deepStrictEqual(read[pageKey].turns, [{ q: "问一", a: "x".repeat(half) }, { q: "问二", a: "y".repeat(half) }]);
    const noteOnly = Object.values(read).find((it) => it.id.includes(NOTE_BV));
    assert.deepStrictEqual([noteOnly.note, noteOnly.turns], ["只有备注", undefined], JSON.stringify(read));
    store.mdg_ai_conversations_v1 = [{ ...web, messages: [{ role: "user", content: "z".repeat(900) }, { role: "assistant", content: "答" }] }];
    onChanged({ [MARKS]: {} }, "local");
    await wait(350);
    sent.length = 0;
    await ad.run({ instruction: "分", scope: "filter", allowRemove: false });
    assert.deepStrictEqual(sent.find((m) => m.type === "triage-reading-ai-tag").items.find((it) => it.id === pageKey).turns, [{ q: "z".repeat(ctx.TriageUi.READING_AI_CHARS), a: "" }], "a question past the budget is cut too");
    ad.discard();

    // 摘读记录设置: the first use copies the 收藏夹's AI 打标签 values into its own sync key; changing them writes only that
    // key; a run batches and caps by them; 允许 AI 去掉已有标签 is stored with them.
    await reset();
    const RS = ctx.MdgLimits.KEYS.readingAiSettings;
    for (const k of Object.keys(sync)) delete sync[k];
    const fav = { triageAiBatchSize: 7, triageIntervalSec: 0, triageAiNewTagMax: 3, triageAiRemoveTags: true };
    sent.length = 0;
    ctx.chrome.runtime.sendMessage = async (msg) => (sent.push(plain(msg)), msg.type === "triage-settings-get" ? { ok: true, data: fav } : { ok: true, data: answer });
    L.filters.click.forEach((h) => h({ target: { closest: () => ({ dataset: { f: "ai" } }) } }));
    await wait(20);
    assert.deepStrictEqual(plain(sync), { [RS]: { batchSize: 7, intervalSec: 0, newTagMax: 3, allowRemove: true } }, "seeded from the 收藏夹 values");
    assert.deepStrictEqual([ad.room(), ad.allowRemove()], [3, true]);
    L.filters.click.forEach((h) => h({ target: { closest: () => ({ dataset: { f: "settings" } }) } }));
    await wait(20);
    assert.deepStrictEqual([els.rsBatchInput.value, els.rsIntervalInput.value, els.rsNewMaxInput.value, els.rsRemoveInput.checked], [7, 0, 3, true], "the dialog shows the stored values");
    els.rsBatchInput.value = "1";
    els.rsNewMaxInput.value = "2";
    els.readingSettingsDialog.returnValue = "save";
    for (const f of L.readingSettingsDialog.close) await f();
    assert.deepStrictEqual(plain(sync), { [RS]: { batchSize: 1, intervalSec: 0, newTagMax: 2, allowRemove: true } }, "only 摘读记录's key changes");
    assert.ok(!sent.some((m) => m.type === "triage-settings-save"), "the 收藏夹's settings are not written");
    // J10: a value imported elsewhere while the dialog is open is kept: saving writes only the fields changed in it.
    L.filters.click.forEach((h) => h({ target: { closest: () => ({ dataset: { f: "settings" } }) } }));
    await wait(20);
    sync[RS] = { ...sync[RS], intervalSec: 9 };
    els.rsNewMaxInput.value = "3";
    els.readingSettingsDialog.returnValue = "save";
    for (const f of L.readingSettingsDialog.close) await f();
    assert.deepStrictEqual(plain(sync[RS]), { batchSize: 1, intervalSec: 9, newTagMax: 3, allowRemove: true }, "the imported 9 stays");
    sync[RS] = { batchSize: 1, intervalSec: 0, newTagMax: 2, allowRemove: true };
    sent.length = 0;
    await ad.run({ instruction: "按主题分", scope: "filter", allowRemove: true });
    assert.deepStrictEqual(plain(sent.filter((m) => m.type === "triage-reading-ai-tag").map((m) => [m.items.length, m.maxNewTags])), [[1, 2], [1, 1]], "batches of the stored size, within the stored cap");
    // The 分拣台's run rules (MdgRuns.aiJudge): an AI 429 waits and sends the same batch again, a timeout is sent again
    // at once; a setup error ends the run with 去设置 on the status line.
    ctx.MdgRuns.AI_HOLD.ms = 30;
    const replies = [{ ok: false, code: "AI_THROTTLED", error: "AI 平台限流" }, { ok: false, code: "AI_TIMEOUT", error: "超时" }, { ok: true, data: answer }, { ok: false, code: "AI_AUTH", error: "API Key 不对" }];
    sent.length = 0;
    ctx.chrome.runtime.sendMessage = async (msg) => (sent.push(plain(msg)), msg.type === "triage-reading-ai-tag" ? replies.shift() : { ok: true, data: fav });
    const appended = [];
    els.status.append = (...nodes) => appended.push(...nodes);
    ctx.document.createElement = () => ({});
    await ad.run({ instruction: "按主题分", scope: "filter", allowRemove: true });
    const batches = sent.filter((m) => m.type === "triage-reading-ai-tag").map((m) => m.items[0].id);
    assert.deepStrictEqual([batches.length, batches[0] === batches[2], batches[2] !== batches[3]], [4, true, true], "batch 1 sent 3 times, then batch 2");
    assert.ok(els.status.textContent.includes("API Key 不对") && appended.at(-1).textContent === "去设置", els.status.textContent);
    ad.discard();
    delete els.status.append;
    assert.strictEqual(await ad.setAllowRemove(false), true);
    assert.deepStrictEqual([sync[RS].allowRemove, ad.allowRemove()], [false, false], "the switch is stored");

    ctx.chrome.storage.local.set = realSet;
    ctx.TagDialogs.ai.open = realOpen;
  }

  // R27 / R28: two parts of one B站 video, and P1's AI 总结.
  {
    const keep = { ...store };
    const BV = "BV1abcdefghi";
    const qa = [{ role: "user", content: "q" }, { role: "assistant", content: "a" }];
    const part = (n) => ({ id: `p${n}`, contextKey: `video:bilibili:${BV}|c${n}`, title: "V", contextRef: { site: "bilibili", videoId: BV, cid: `c${n}`, pageIndex: n, title: "V" }, createdAt: n, updatedAt: n, messages: qa });
    const act = (key, a, checked) => {
      const t = { checked, dataset: { act: a }, closest: (s) => (s === ".entry" ? { dataset: { key } } : t) };
      L.list.click.forEach((f) => f({ target: t }));
    };
    for (const k of Object.keys(store)) delete store[k];
    store.mdg_ai_conversations_v1 = [part(1), part(2)];
    store[ctx.MdgLimits.KEYS.triageAnalysisPrefix + BV] = { status: "done", oneLiner: "一句话", verdict: "keep", analyzedAt: 1 };
    onChanged({ mdg_ai_conversations_v1: {} }, "local");
    await wait(350);
    // R27: 备注 on P2 opens one editor, on P2's entry.
    act(`video:bilibili:${BV}|c2`, "note");
    await wait(20);
    const editors = [...els.list.innerHTML.matchAll(/<article[^>]*data-key="([^"]*)"[\s\S]*?<\/article>/g)].filter(([a]) => a.includes("data-note")).map(([, k]) => k);
    assert.deepStrictEqual(editors, [`video:bilibili:${BV}|c2`]);
    (L.list.keydown || []).forEach((f) => f({ key: "Escape", target: { matches: (sel) => sel === "[data-note]" }, preventDefault() {} }));
    await wait(20);
    // R28: P1 selected, its summary unfolded and 问答 open; 清空全部 AI 对话 leaves P1's AI 总结 as an entry keyed anew,
    // which keeps all three.
    store.mdg_ai_conversations_v1 = [part(1)];
    onChanged({ mdg_ai_conversations_v1: {} }, "local");
    await wait(350);
    const p1 = `video:bilibili:${BV}|c1`;
    act(p1, "pick", true);
    act(p1, "summary");
    L.list.toggle.forEach((f) => f({ target: { open: true, closest: () => ({ dataset: { key: p1 } }) } }));
    ctx.confirm = () => true;
    for (const f of L.clearAll.click) await f({});
    await wait(50);
    const after = [...els.list.innerHTML.matchAll(/data-key="([^"]*)"/g)].map(([, k]) => k).filter((k) => k.includes(BV));
    assert.deepStrictEqual(after, [`video:bilibili:${BV}|`]);
    const entry = els.list.innerHTML.match(/<article[^>]*data-key="video:bilibili:BV1abcdefghi\|"[\s\S]*?<\/article>/)[0];
    assert.ok(/class="card entry selected"/.test(entry) && /data-act="pick"[^>]*checked/.test(entry) && /aria-expanded="true"/.test(entry), entry);
    act(after[0], "pick", false);
    act(after[0], "summary");
    for (const k of Object.keys(store)) delete store[k];
    Object.assign(store, keep);
    onChanged({ mdg_ai_conversations_v1: {} }, "local");
    await wait(350);
  }

  // D2: 取消星标 that puts the AI 对话 over the cap asks first with how many of the oldest go, this record's among them;
  // cancelled, the 星标 stays; confirmed, the cap applies at once.
  {
    const keep = { ...store };
    const MARKS = ctx.MdgLimits.KEYS.readingMarks;
    const key = "page:https://old.example/";
    const qa = [{ role: "user", content: "q" }, { role: "assistant", content: "a" }];
    const c = (id, contextKey, at) => ({ id, contextKey, title: id, contextUrl: contextKey.slice(5), createdAt: at, updatedAt: at, messages: qa });
    for (const k of Object.keys(store)) delete store[k];
    store.mdg_ai_conversations_v1 = [c("old1", key, 1), c("old2", key, 2), ...Array.from({ length: 500 }, (_, i) => c(`n${i}`, `page:https://n${i}.example/`, 1000 + i))];
    store[MARKS] = { tags: [], items: { [key]: { star: 5, tags: [], ref: { url: "https://old.example/", title: "旧网页" } } } };
    onChanged({ mdg_ai_conversations_v1: {}, [MARKS]: {} }, "local");
    await wait(350);
    const star = async () => {
      const t = { dataset: { act: "star" }, closest: (sel) => (sel === ".entry" ? { dataset: { key } } : t) };
      L.list.click.forEach((f) => f({ target: t }));
      await wait(50);
    };
    confirmAnswer = false;
    await star();
    assert.deepStrictEqual(asks.at(-1), ["取消星标？", "<p>AI 对话超过 500 段，将删除最旧的 2 段，其中 2 段是「old2」的，删除后不能恢复。</p>", "取消星标并删除", { danger: true }]);
    assert.deepStrictEqual([store[MARKS].items[key].star, store.mdg_ai_conversations_v1.length], [5, 502], "cancelled: nothing changes");
    confirmAnswer = true;
    await star();
    assert.deepStrictEqual([store[MARKS].items[key]?.star || 0, store.mdg_ai_conversations_v1.length, store.mdg_ai_conversations_v1.some((x) => x.contextKey === key)], [0, 500, false]);
    for (const k of Object.keys(store)) delete store[k];
    Object.assign(store, keep);
    onChanged({ mdg_ai_conversations_v1: {}, [MARKS]: {} }, "local");
    await wait(350);
  }

  // J23: two loads overlap (a burst of changes): the one that read storage last lands, the earlier read is dropped even
  // when it answers later.
  {
    onChanged({ mdg_ai_conversations_v1: {} }, "local");
    await wait(350);
    const expected = html; // the store as it is, drawn by a load on its own
    const realGet = ctx.chrome.storage.local.get;
    const older = { ...store, mdg_ai_conversations_v1: [conv("old-only", "旧")] };
    let release;
    let gated = false;
    ctx.chrome.storage.local.get = async (k) => (k === null && !gated ? ((gated = true), new Promise((r) => (release = () => r(older)))) : realGet(k));
    onChanged({ mdg_ai_conversations_v1: {} }, "local");
    await wait(350);
    assert.ok(release, "the first load is reading");
    onChanged({ mdg_ai_conversations_v1: {} }, "local");
    await wait(350);
    release();
    await wait(50);
    assert.ok(!html.includes('data-key="old-only"'), "the earlier read is dropped");
    assert.strictEqual(html, expected, "the newer read is what shows");
    ctx.chrome.storage.local.get = realGet;
  }
  // B7: several entries download as one zip, one note per record, dated by the local day and time, not UTC. Each is the
  // record's note (export-note) without a dialog: one whose page is not open is its AI 笔记 (pageChoice own), one that
  // cannot be built is this page's AI 笔记, and the status line counts both.
  const saved = [];
  ctx.MdgDownload = { ...ctx.MdgDownload, text: (name, data, type) => saved.push(name, type, Buffer.from(data).toString()) };
  const choices = [];
  for (const [, key] of [...html.matchAll(/<article[^>]*data-key="([^"]*)"/g)].slice(0, 3)) pick(key, true);
  ctx.chrome.runtime.sendMessage = async (m) => (choices.push(`${m.type},${m.pageChoice}`), choices.length === 1 ? { ok: true, filename: "页面.md", markdown: "# 网页笔记", noPage: true } : { ok: false, error: "B站 不可用" });
  const RealDate = ctx.Date;
  vm.runInContext("Date = class extends Date { constructor(...a) { a.length ? super(...a) : super(2026, 9, 14, 7, 30); } }", ctx);
  (L.selbar.click || []).forEach((f) => f({ target: { closest: () => ({ dataset: { sel: "md" } }) } }));
  await wait(50);
  ctx.Date = RealDate;
  const count = choices.length;
  assert.strictEqual(count, 3, "three records selected");
  assert.deepStrictEqual([saved[0], saved[1], [...new Set(choices)], els.status.textContent], ["MoonDigest摘读记录-2026-10-14-0730.zip", "application/zip", ["export-note,own"], `已下载 ${count} 条记录，1 条没打开页面，放的是 AI 笔记，${count - 1} 条生成不了笔记，放的是 AI 笔记`]);
  assert.ok(saved[2].includes("页面.md") && saved[2].includes("# 网页笔记") && saved[2].includes("【AI笔记】"), saved[2]);

  console.log("history selftest: all passed");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
