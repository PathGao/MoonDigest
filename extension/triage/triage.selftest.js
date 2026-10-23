// node extension/triage/triage.selftest.js
if (process.versions.bun) (console.error("This selftest needs Node: it fails or hangs under bun (see 自检 in README.md)."), process.exit(1));
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");
const PS = require("../page-sources.selftest.js");

// 收藏夹 is the classic scripts fav-*.js, run below with the page's other scripts on a stub DOM; the module triage.js
// only starts it. Drops its entry points (the dev-mock import and init()). Startup is scripts/smoke.mjs's job.
const entry = fs
  .readFileSync(path.join(__dirname, "triage.js"), "utf8")
  .replace(/^if \(!globalThis\.chrome\?\.runtime\?\.id\) await import.*$/m, "")
  .replace(/^init\(\);$/m, "");
assert.ok(!/await import|^init\(\);$/m.test(entry), "harness strips the page entry points");
// 收藏夹's code, for the checks below that read it.
const source = PS.text(PS.favorites);
// 优先看, then 播放列表, was renamed 待播: no page text or README still says an old name ("YouTube 播放列表" in the README is YouTube's own).
for (const f of [...PS.pageCode, "triage/shared.js", "triage/triage.html", "options.html", "sidepanel.html", "popup.html", "../README.md"]) {
  const text = PS.read(f).replaceAll("YouTube 播放列表", "");
  for (const old of ["优先看", "播放列表"]) assert.ok(!text.includes(old), `${f} still says ${old}`);
}

// H6: 导出's item hints are written once each.
for (const hint of ["摘录，或逐个视频的笔记", "标题、AI 判断、标签、备注"]) assert.strictEqual(source.split(hint).length - 1, 1, hint);
const stubEl = () => new Proxy({ classList: { toggle() {}, add() {}, remove() {} }, style: {}, dataset: {} }, {
  get: (o, k) => (k in o ? o[k] : () => {}),
  set: (o, k, v) => ((o[k] = v), true)
});
const store = {};
const syncStore = {};
const handlers = {};
const sent = [];
const docL = {}; // document listeners: typing.js's composition flag, onKey
const winL = {}; // window listeners: beforeunload
// tag-dialogs.js stands in: each open records [which dialog, the mode's adapter] (tag-dialogs.selftest.js tests the dialogs).
const dialogs = [];
const TagDialogs = {
  manage: { open: (a) => dialogs.push(["manage", a]), isOpen: () => false },
  ai: { open: (a) => dialogs.push(["ai", a]), isOpen: () => false, render() {}, progress() {} }
};
const ctx = vm.createContext({
  console,
  structuredClone,
  TextEncoder,
  TagDialogs,
  CSS: { escape: (x) => x },
  __TRIAGE_THROTTLE_MS: 30, // B站限流 waits this long here, not 10 minutes
  __TRIAGE_SETTLE_MS: 40, // a written folder settles this fast here, not in 3 s
  setTimeout: (f) => setImmediate(f),
  clearTimeout: (id) => clearImmediate(id),
  // No #tagPicker: tag-picker.js gives only its pure part; the tests stand in for the dialog (pickWith).
  document: { getElementById: (id) => (id === "tagPicker" ? null : stubEl()), querySelector: () => null, querySelectorAll: () => [], addEventListener: (t, f) => (docL[t] ||= []).push(f) },
  window: { addEventListener: (t, f) => (winL[t] ||= []).push(f) },
  chrome: {
    runtime: {
      id: "test",
      lastError: undefined,
      sendMessage(msg, cb) {
        sent.push(msg);
        Promise.resolve((handlers[msg.type] || (() => ({ ok: true })))(msg)).then(cb);
      }
    },
    storage: {
      local: {
        async get(k) {
          if (k == null) return structuredClone(store);
          return Object.fromEntries([].concat(k).filter((x) => x in store).map((x) => [x, structuredClone(store[x])]));
        },
        async set(o) {
          Object.assign(store, structuredClone(o));
        },
        async remove(keys) {
          for (const k of [].concat(keys)) delete store[k];
        }
      },
      sync: {
        get: async (d) => ({ ...d, ...structuredClone(syncStore) }),
        async remove(keys) {
          for (const k of [].concat(keys)) delete syncStore[k];
        }
      }
    }
  }
});
// The classic scripts triage.html loads, read from the page so the test cannot load a different set; they all run before
// its modules (triage.js, then follow.js). tag-dialogs.js is left out: TagDialogs above stands in for it.
const pageScripts = [...fs.readFileSync(path.join(__dirname, "triage.html"), "utf8").matchAll(/<script([^>]*) src="([^"]+)"/g)];
assert.deepStrictEqual(pageScripts.filter((m) => /type="module"/.test(m[1])).map((m) => m[2]), ["./triage.js", "./follow.js"], "triage.html's modules");
for (const [, attrs, src] of pageScripts) {
  if (!/type="module"/.test(attrs) && !src.endsWith("/tag-dialogs.js")) vm.runInContext(fs.readFileSync(path.join(__dirname, src), "utf8"), ctx);
}
vm.runInContext(`${entry}\n;globalThis.S = S; globalThis.K = K; globalThis.el = el; globalThis.verdictBadge = verdictBadge; globalThis.seenText = seenText; globalThis.staleCoarse = staleCoarse; globalThis.staleFine = staleFine; globalThis.mergeHead = mergeHead; globalThis.isFinished = isFinished; globalThis.pointerMoved = pointerMoved; globalThis.inferFrom = inferFrom; globalThis.hasAllTags = hasAllTags; globalThis.sortItems = sortItems; globalThis.sortOf = sortOf; globalThis.visibleItems = visibleItems; globalThis.fav = fav;`, ctx);
const t = ctx;
Object.assign(t, t.TriageCore);
vm.runInContext("globalThis.plainClick = plainClick;", ctx);
const plain = (v) => JSON.parse(JSON.stringify(v));
// Row 3 as drawn now.
const row3 = () => (t.renderListHeader(t.visibleItems()), t.el.classFilter.innerHTML);
const realSync = t.syncFolder;
const toasts = [];
Object.assign(t, { render() {}, setFocus() {}, toast: (m) => toasts.push(m), askConfirm: async () => true });

// The picker as 收藏夹 opens it: po = the last open's options; pickWith ticks (fn gets the Map of Sets) and closes.
let po = null;
ctx.TagPicker.open = (o) => (po = o);
async function pickWith(bvid, fn, anchor) {
  po = null;
  t.openPicker(bvid, anchor);
  if (!po) return false;
  const sets = new Map(po.targets.map((k) => [k, new Set(po.idsOf(k))]));
  const before = new Map([...sets].map(([k, s]) => [k, [...s]]));
  fn(sets);
  await po.onClose(ctx.TagPicker.changesOf(before, sets));
  return true;
}
// 收藏夹's tags go through its tag store (tag-store.js): these stand for the page's own functions it replaced.
const tagStore = () => vm.runInContext("tagStore", ctx);
const createTag = (name, folder = t.S.mediaId) => tagStore().createTag(name, folder);
const saveTagEdit = (tag, field, value) => tagStore().edit(tag, field, value);
const tagNow = (tag) => t.S.tags.find((x) => x.id === tag.id);
const applyAi = () => vm.runInContext("aiTags", ctx).apply();
const room = () => tagStore().room(t.S.mediaId);
const item = (n) => ({ bvid: `BV${n}`, aid: 1000 + n, title: `视频${n}`, upper: "up", duration: 61 });
// Untrusted text (titles, UP names, comments, AI replies, tag names, paths) stays text: no tag of its own, no way out of
// a quoted attribute.
const XSS = ["<img src=x onerror=alert(1)>", `"'><script>alert(1)</script>`];
const assertInert = (html, where) => assert.ok(!/<img src=x|<script|"'>/i.test(html) && /&lt;|&#60;/.test(html), `${where}: ${html}`);
function openFake(mediaId, items, decisions = {}) {
  t.S.folderToken++;
  t.S.mediaId = mediaId;
  t.S.items = items;
  t.S.itemMap = new Map(items.map((it) => [it.bvid, it]));
  t.S.decisions = decisions;
  t.S.undo = [];
  t.S.aiRecentFilter = false;
  // In the page every unfavorite record is stored too; patchDecisions merges into the stored one.
  if (Object.keys(decisions).length) store[t.K.decisions(mediaId)] = structuredClone(unfavOnlyOf(decisions));
}
const unfavOnlyOf = (d) => Object.fromEntries(Object.entries(d).filter(([, v]) => v?.action === "unfav"));

// 收藏夹 sort: 收藏时间 keeps or reverses the list; the others order by value, missing values last in both directions.
{
  const L = [
    { bvid: "a", title: "乙", pubdate: 30, play: 500, duration: 60 },
    { bvid: "b", title: "甲", pubdate: 10, duration: 600 },
    { bvid: "c", title: "丙", pubdate: 20, play: 9000, duration: 0 },
    { bvid: "d", title: "丁", pubdate: 0, play: 0, duration: 120 }
  ];
  const ids = (sort, dir) => t.sortItems(L, sort, dir).map((it) => it.bvid).join("");
  assert.strictEqual(ids("fav", "desc"), "abcd", "收藏时间 新→旧 = Bilibili's order");
  assert.strictEqual(ids("fav", "asc"), "dcba");
  assert.strictEqual(ids("play", "desc"), "cadb", "no 播放量 (b) last; 0 is a count");
  assert.strictEqual(ids("play", "asc"), "dacb", "no 播放量 still last");
  assert.strictEqual(ids("pub", "desc"), "acbd", "no 发布时间 last");
  assert.strictEqual(ids("pub", "asc"), "bcad");
  assert.strictEqual(ids("dur", "desc"), "bdac", "no 时长 last");
  assert.strictEqual(ids("title", "asc"), t.sortItems(L, "title", "desc").map((it) => it.bvid).reverse().join(""));
  assert.strictEqual(L.map((it) => it.bvid).join(""), "abcd", "the list itself is not reordered");
  // remembered per folder; none = 收藏时间 新→旧
  t.S.sortBy = { 7: { sort: "play", dir: "asc" } };
  assert.deepStrictEqual(plain(t.sortOf("7")), { sort: "play", dir: "asc" });
  assert.deepStrictEqual(plain(t.sortOf("8")), { sort: "fav", dir: "desc" });
  t.S.sortBy = {};
}

(async () => {
  // Every request carries the AI platform picked in the side panel (its localStorage key), so 分拣台's AI uses the same one.
  {
    ctx.localStorage = { getItem: (k) => (k === "mdg_ai_selected_provider" ? "b" : null) };
    const last = () => plain(sent.filter((m) => m.type === "ai-pick-test").at(-1));
    await t.sendRaw({ type: "ai-pick-test" });
    assert.deepStrictEqual(last(), { type: "ai-pick-test", aiProviderId: "b" });
    delete ctx.localStorage;
    await t.sendRaw({ type: "ai-pick-test" });
    assert.deepStrictEqual(last(), { type: "ai-pick-test" }, "nothing picked: nothing sent");
    // C548: Chrome's English lastError never becomes the page's error words.
    ctx.chrome.runtime.lastError = { message: "Could not establish connection. Receiving end does not exist." };
    const warn = console.warn;
    console.warn = () => {};
    const r = await t.sendRaw({ type: "ai-pick-test" });
    console.warn = warn;
    ctx.chrome.runtime.lastError = undefined;
    assert.deepStrictEqual(plain(r), { ok: false, error: "后台无响应" });
  }
  // C135: 去设置 that could not open the settings page says why, as the video page does; one that opened says nothing.
  {
    const before = toasts.length;
    handlers["open-options"] = () => ({ ok: true });
    await t.MoonTriage.openOptions();
    handlers["open-options"] = () => ({ ok: false, error: "没有权限" });
    await t.MoonTriage.openOptions();
    assert.deepStrictEqual(toasts.slice(before), [`${t.MdgErrors.TEXT.settingsOpenFailed}：没有权限`]);
  }
  // C549: a failed write is toasted once while writes keep failing, and again once one succeeded in between.
  {
    const set = ctx.chrome.storage.local.set;
    const err = console.error;
    const failing = async () => { throw new Error("QUOTA_BYTES quota exceeded"); };
    const fails = () => toasts.filter((m) => m.startsWith("保存失败")).length;
    const before = fails();
    console.error = () => {};
    ctx.chrome.storage.local.set = failing;
    await t.store({ x: 1 });
    await t.store({ x: 1 });
    const once = fails() - before;
    ctx.chrome.storage.local.set = set;
    await t.store({ x: 1 });
    ctx.chrome.storage.local.set = failing;
    await t.store({ x: 1 });
    ctx.chrome.storage.local.set = set;
    console.error = err;
    assert.strictEqual(once, 1, "once while it keeps failing");
    assert.strictEqual(fails() - before, 2, "again after a write succeeded");
    delete store.x;
  }
  // B8: a batch unfavorite runs to the end after another folder opens, every chunk recorded under its folder, aid and
  // title included; the other folder gets no undo entry, only a toast naming the folder.
  const many = Array.from({ length: 45 }, (_, i) => item(i));
  openFake("A", many);
  let unfavCalls = 0;
  handlers["triage-unfav"] = (m) => {
    assert.strictEqual(m.mediaId, "A");
    if (++unfavCalls === 2) openFake("B", [item(99)]);
    assert.strictEqual(t.activityState().text, unfavCalls === 1 ? "取消收藏中 0/45" : `取消收藏中 ${(unfavCalls - 1) * 20}/45（A）`);
    return { ok: true };
  };
  await t.fav.unfavMany(many);
  assert.strictEqual(unfavCalls, 3, "the last chunk is still sent after the switch");
  const savedA = store[t.K.decisions("A")];
  assert.strictEqual(Object.keys(savedA).length, 45, "every chunk is recorded under folder A");
  assert.ok(toasts.at(-1).startsWith("「A」已取消收藏 45 个"), toasts.at(-1));
  assert.deepStrictEqual(plain(savedA.BV25), { action: "unfav", at: savedA.BV25.at, aid: 1025, title: "视频25", batch: savedA.BV0.batch });
  assert.ok(Object.values(savedA).every((d) => d.batch === savedA.BV0.batch), "every chunk carries the batch's start");
  assert.deepStrictEqual(plain(t.S.decisions), {}, "folder B's decisions are untouched");
  assert.strictEqual(t.S.undo.length, 0, "folder B's undo stack gets no entry for folder A");

  // 最近取消收藏 re-favorites a whole batch in one go (all 45, though it lists only the latest), a single one alone.
  openFake("A", [], structuredClone(savedA));
  t.S.decisions.BVsolo = { action: "unfav", at: 1, aid: 7, title: "单个" };
  assert.ok(t.recentUnfavHtml().includes(`data-refav-batch="${savedA.BV0.batch}"`) && t.recentUnfavHtml().includes("批量取消收藏 45 个"));
  const refavAids = [];
  handlers["triage-refav"] = (m) => (refavAids.push(m.aid), { ok: true });
  await t.fav.refavBatch(savedA.BV0.batch);
  assert.strictEqual(refavAids.length, 45, "the batch, not the single one");
  assert.deepStrictEqual(Object.keys(store[t.K.decisions("A")]), [], "the stored records are gone");
  assert.ok(t.S.decisions.BVsolo && toasts.at(-1) === "已重新收藏这批 45 个", toasts.at(-1));
  assert.ok(!t.recentUnfavHtml().includes("data-refav-batch"), "no batch line once it is re-favorited");
  store[t.K.decisions("A")] = structuredClone(savedA);

  // Back in the folder mid-run with a record read before the batch's last write: nothing written earlier is lost.
  openFake("A2", many);
  let a2Calls = 0;
  handlers["triage-unfav"] = () => {
    if (++a2Calls === 2) openFake("A2", many);
    return { ok: true };
  };
  await t.fav.unfavMany(many);
  assert.strictEqual(Object.keys(store[t.K.decisions("A2")]).length, 45, "the first chunk's records survive");
  assert.strictEqual(t.S.undo.length, 1, "back in its folder, the batch is undoable with U");

  // U7: after a reload the unfavorited videos are listed and re-favorited into their own folder.
  openFake("A", many.slice(40), savedA);
  const recent = t.recentUnfavs();
  assert.strictEqual(recent.length, 40);
  assert.ok(t.recentUnfavHtml().includes('data-refav="BV0"'));
  handlers["triage-refav"] = () => ({ ok: true });
  t.syncFolder = async () => true;
  // Waits out the settle window (__TRIAGE_SETTLE_MS) and drops a read deferred meanwhile.
  const settled = async () => {
    await new Promise((r) => setTimeout(r, 50));
    vm.runInContext("clearTimeout(deferredRead?.timer); deferredRead = null;", ctx);
  };
  await settled();
  await t.fav.refav("BV7");
  assert.deepStrictEqual(plain(sent.at(-1)), { type: "triage-refav", mediaId: "A", aid: 1007 });
  assert.ok(!("BV7" in store[t.K.decisions("A")]), "re-favorited video leaves the recent list");
  // X10: the folder counts as written, so the read after it waits for B站 to catch up.
  assert.ok(t.fav.state().writing("A"), "the read after a 重新收藏 waits for B站 to catch up");
  await settled();
  const capped = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`BVx${i}`, { action: "unfav", at: i, aid: i, title: "x" }]));
  openFake("C", [], capped);
  assert.strictEqual(t.recentUnfavs().length, 50, "the recent list is capped");
  assert.strictEqual(t.recentUnfavs()[0][0], "BVx59", "newest first");

  // B9: a refav failure partway through a batch undo keeps the rest undoable.
  const three = [item(1), item(2), item(3)];
  const unfavThree = async (mediaId) => {
    openFake(mediaId, three);
    handlers["triage-unfav"] = () => ({ ok: true });
    await t.fav.unfavMany(three);
    assert.deepStrictEqual(Object.keys(store[t.K.decisions(mediaId)]), ["BV1", "BV2", "BV3"]);
  };
  await unfavThree("D");
  handlers["triage-refav"] = ({ aid }) => (aid === 1002 ? { ok: false, error: "网络错误" } : { ok: true });
  await t.undo();
  assert.deepStrictEqual(Object.keys(store[t.K.decisions("D")]), ["BV2", "BV3"]);
  assert.strictEqual(toasts.at(-1), "撤销中断（已重新收藏 1 个，剩余 2 个可再按 U 重试）：网络错误");
  const retried = [];
  handlers["triage-refav"] = ({ aid }) => (retried.push(aid), { ok: true });
  await t.undo();
  assert.deepStrictEqual(retried, [1002, 1003], "U again re-favorites the ones left");
  assert.deepStrictEqual(store[t.K.decisions("D")], {});
  assert.strictEqual(t.S.undo.length, 0);

  // X9 / B1: 重新收藏 and 移动/复制 wait out a B站 limit with the amber countdown after their progress line, then send
  // the same video / chunk again.
  {
    const realStatus = t.renderStatus, saved = { allFolders: t.S.allFolders, folders: t.S.folders, included: t.S.included }, realAsk = t.askTransfer;
    const pills = [];
    t.renderStatus = () => {
      const a = t.activityState();
      if (a?.stuck && !pills.includes(a.text)) pills.push(a.text);
    };
    const limitedOnce = (log) => (m) => (log.push(m.aid || m.aids), log.length === 1 ? { ok: false, code: "THROTTLED", error: "412" } : { ok: true });
    const refavs = [];
    openFake("R", [], { BV60: { action: "unfav", at: 1, aid: 1060, title: "视频60" } });
    handlers["triage-refav"] = limitedOnce(refavs);
    await t.fav.refav("BV60");
    assert.deepStrictEqual(plain(refavs), [1060, 1060]);
    assert.ok(!("BV60" in store[t.K.decisions("R")]) && toasts.at(-1) === "已重新收藏《视频60》", toasts.at(-1));
    const moves = [];
    t.S.allFolders = t.S.folders = [{ id: "R", title: "源" }, { id: "T", title: "目标" }];
    t.S.included = ["R", "T"];
    openFake("R", [item(61), item(62)]);
    handlers["triage-transfer"] = limitedOnce(moves);
    t.askTransfer = async () => ({ how: "copy", target: { id: "T" } });
    t.S.selected = new Set(["BV61", "BV62"]);
    await t.fav.transfer([item(61), item(62)]);
    assert.deepStrictEqual(plain(moves), [[1061, 1062], [1061, 1062]]);
    assert.deepStrictEqual(plain([...t.S.selected]), ["BV61", "BV62"], "copied, still listed: they stay selected");
    assert.strictEqual(toasts.at(-1), "已复制 2 个到「目标」");
    assert.deepStrictEqual(pills, ["重新收藏中 0/1 · B站限流卡住，0:01 后重试", "复制到「目标」0/2 · B站限流卡住，0:01 后重试"]);
    Object.assign(t.S, saved);
    t.askTransfer = realAsk;
    t.renderStatus = realStatus;

    await settled();
  }

  // G2: 稍后再看 goes one video per request; a B站 limit waits and retries the same one; a failure keeps the ones done
  // (recorded, undoable) and says how many.
  {
    const five = [1, 2, 3, 4, 5].map((n) => item(70 + n));
    openFake("toview", five);
    const tv = [];
    let limited = false;
    handlers["triage-unfav"] = (m) => {
      tv.push(m.aids);
      if (m.aids[0] === 1072 && !limited) return (limited = true), { ok: false, code: "THROTTLED", error: "412" };
      return m.aids[0] === 1074 ? { ok: false, error: "网络错误" } : { ok: true };
    };
    await t.fav.unfavMany(five);
    assert.deepStrictEqual(plain(tv), [[1071], [1072], [1072], [1073], [1074]]);
    assert.deepStrictEqual(Object.keys(store[t.K.decisions("toview")]), ["BV71", "BV72", "BV73"]);
    assert.strictEqual(toasts.at(-1), "批量取消收藏中断（已完成 3 个）：网络错误 · U 撤销已完成的");
    const back = [];
    handlers["triage-refav"] = (m) => (back.push(m.aid), { ok: true });
    await t.undo();
    assert.deepStrictEqual(back, [1071, 1072, 1073], "U re-favorites the ones done");
  }

  // A batch undo also runs to the end after another folder opens.
  await unfavThree("D");
  let refavs = 0;
  handlers["triage-refav"] = () => {
    if (++refavs === 1) openFake("E", []);
    return { ok: true };
  };
  await t.undo();
  assert.deepStrictEqual([refavs, store[t.K.decisions("D")], toasts.at(-1)], [3, {}, "「D」已重新收藏 3 个"]);

  // G7: one B站 batch write at a time. While a 重新收藏 runs (held here by a slow B站), no batch 取消收藏 / 移动 / 重新收藏
  // starts and U leaves a step that writes to B站 for later; a single 重新收藏 waits too, so it cannot take over the run.
  const ticks = async () => {
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  };
  const holdNext = (type) => {
    const h = { release: null };
    handlers[type] = () => new Promise((r) => (h.release = () => (handlers[type] = () => ({ ok: true }), r({ ok: true }))));
    return h;
  };
  // Waits (real time: runs' gaps go through sleepWhile) until cond() holds, 5 s at most.
  const until = async (cond) => {
    for (const end = Date.now() + 5000; !cond() && Date.now() < end; ) await new Promise((r) => setImmediate(r));
  };
  // A run of job on the page's runs, held in flight until the returned function lets it end.
  const hang = (job) => {
    let end;
    let first = true;
    const done = vm.runInContext("runs", ctx).run(job, { total: 1, line: () => job, next: () => first && !(first = false) && {}, act: () => new Promise((r) => (end = r)) });
    return async () => (await ticks(), end({ ok: true }), await done);
  };
  {
    openFake("D", three);
    handlers["triage-unfav"] = () => ({ ok: true });
    await t.fav.unfav("BV2");
    await t.fav.unfavMany([three[0]]);
    Object.assign(t.S.decisions, { BV8: { action: "unfav", at: 2, aid: 1008, title: "视频8" }, BV9: { action: "unfav", at: 1, aid: 1009, title: "视频9" } });
    const h = holdNext("triage-refav");
    const running = t.fav.refav("BV8");
    await ticks();
    let asked = 0;
    const savedAsk = t.askConfirm;
    t.askConfirm = async () => (asked++, true);
    const [sentBefore, toastsBefore] = [sent.length, toasts.length];
    await t.fav.unfavMany([three[2]]);
    await t.fav.transfer([three[2]]);
    await t.fav.refav("BV9");
    assert.deepStrictEqual([asked, sent.length, toasts.length], [0, sentBefore, toastsBefore], "nothing asked, sent or told");
    await t.undo();
    assert.deepStrictEqual([asked, sent.length, t.S.undo.length, toasts.at(-1)], [0, sentBefore, 2, "重新收藏还在跑，等它完成再撤销"]);
    const html = t.recentUnfavHtml();
    assert.ok(/data-refav="BV9"[^>]* disabled title="重新收藏还在跑，等它完成"/.test(html) && html.includes("重新收藏中…"), html);
    h.release();
    await running;
    // The batch's step undone, the single 取消收藏's waits for the next run the same way.
    await t.undo();
    assert.deepStrictEqual([t.S.undo.length, toasts.at(-1)], [1, "已重新收藏 1 个"]);
    const h2 = holdNext("triage-refav");
    const again = t.fav.refav("BV9");
    await ticks();
    await t.undo();
    assert.deepStrictEqual([t.S.undo.length, toasts.at(-1)], [1, "重新收藏还在跑，等它完成再撤销"]);
    h2.release();
    await again;
    t.askConfirm = savedAsk;
    t.S.undo = [];
  }
  // While a batch 取消收藏 runs, 最近取消收藏's 重新收藏 is refused and says why on its button. D is not blocked by it:
  // a video outside the batch goes; one the batch still has to write is refused, nothing sent.
  {
    const five = [1, 2, 3, 4, 5].map((n) => item(40 + n));
    openFake("H", five, { BV9: { action: "unfav", at: 1, aid: 1009, title: "视频9" } });
    const h = holdNext("triage-unfav");
    const running = t.fav.unfavMany(five.slice(0, 3));
    await ticks();
    const sentBefore = sent.length;
    await t.fav.refav("BV9");
    await t.fav.unfav("BV43");
    assert.strictEqual(sent.length, sentBefore, "nothing sent");
    assert.ok(/data-refav="BV9"[^>]* disabled title="批量取消收藏还在跑，等它完成"/.test(t.recentUnfavHtml()), t.recentUnfavHtml());
    assert.ok(t.cardHtml(five[2], false, "").includes("正在取消收藏…"), "a video the batch still has to write shows it");
    // J7: its 保留 is off with the same why, and S (keepOne) says it instead of doing nothing.
    assert.ok(t.cardHtml(five[2], false, "").includes('aria-label="保留 (S)" disabled title="正在取消收藏…"'), t.cardHtml(five[2], false, ""));
    t.keepOne("BV43");
    assert.ok(toasts.at(-1) === "正在取消收藏…" && !t.S.decisions.BV43, toasts.at(-1));
    // G6: 清理 drops the records such a batch writes: row 3's and the card's are disabled with why, and it does nothing.
    {
      const was = [t.S.mediaId, t.S.tab];
      Object.assign(t.S, { mediaId: "removed", tab: "read" });
      const why = 'disabled title="批量取消收藏还在跑，等它完成"';
      assert.ok(t.cardHtml(five[3], false, "").includes(`aria-label="清理 视频44" ${why}`), t.cardHtml(five[3], false, ""));
      t.renderListHeader(t.visibleItems());
      assert.ok(new RegExp(`aria-label="清理这 \\d+ 个" ${why}`).test((t.el.listHeader.innerHTML + t.el.favSel.innerHTML)), (t.el.listHeader.innerHTML + t.el.favSel.innerHTML));
      const savedAsk = t.askConfirm;
      let asked = 0;
      t.askConfirm = async () => (asked++, true);
      await t.cleanRemoved([five[3]]);
      t.askConfirm = savedAsk;
      assert.deepStrictEqual([asked, toasts.at(-1)], [0, "批量取消收藏还在跑，等它完成"]);
      [t.S.mediaId, t.S.tab] = was;
    }
    handlers["triage-unfav"] = () => ({ ok: true });
    await t.fav.unfav("BV45");
    assert.deepStrictEqual(plain(sent.at(-1)), { type: "triage-unfav", mediaId: "H", aids: [1045] }, "D outside the batch goes");
    h.release();
    await running;
    assert.deepStrictEqual(Object.keys(store[t.K.decisions("H")]).sort(), ["BV41", "BV42", "BV43", "BV45", "BV9"]);
    // D on a B站 limit fails at once, worded like every other limit hit.
    handlers["triage-unfav"] = () => ({ ok: false, code: "THROTTLED", error: "412" });
    await t.fav.unfav("BV44");
    assert.strictEqual(toasts.at(-1), `取消收藏失败：${t.MdgErrors.TEXT.biliThrottled}`);
    assert.ok(t.fav.state().writing("H"), "B站 may have taken it: the folder counts as written");
    handlers["triage-unfav"] = () => ({ ok: true });
    await settled();
    t.S.undo = [];
  }
  {
    // G4: a card's 细看 重试 is a run of one like 字幕细看: the pill, a B站 limit waited out in it, the finish line.
    openFake("R3", [item(1)]);
    let n = 0;
    const pills = [];
    handlers["triage-analyze"] = ({ bvid }) => (pills.push(t.activityState().text), ++n === 1 ? { ok: false, code: "THROTTLED", error: "412" } : { ok: true, data: { bvid, status: "done", verdict: "keep" } });
    t.S.analyses.BV1 = { bvid: "BV1", status: "error", error: "字幕取不到" };
    t.retry("BV1");
    for (let i = 0; i < 100 && t.S.group; i++) await new Promise((r) => setTimeout(r, 5));
    assert.deepStrictEqual([pills[0], n, t.S.analyses.BV1.status, t.activityState().text], ["字幕细看中 0/1", 2, "done", "字幕细看完成 1 个"]);
    // While an AI run goes, the card's 重试 is disabled with why (粗看's and 细看's alike) and does nothing.
    t.S.analyses.BV1 = { bvid: "BV1", status: "error", error: "字幕取不到" };
    t.S.group = { bvids: ["x"], mediaId: "other" };
    assert.ok(/data-act="retry"[^>]* disabled title="字幕细看还在跑，等它完成"/.test(t.cardHtml(item(1), false, "")), t.cardHtml(item(1), false, ""));
    t.retry("BV1");
    assert.strictEqual(n, 2, "nothing sent while busy");
    t.S.group = null;
    delete t.S.analyses.BV1;
    t.S.undo = [];
  }

  // C39: a 取消收藏 that leaves the video in another chosen folder (by its cached list, 稍后再看 aside) records elsewhere,
  // so B站 pages other than a favorites page leave 已取消收藏 off; checked against the folder it started in, even when
  // another folder opens while B站 answers.
  {
    const savedFolders = t.S.folders;
    t.S.folders = [{ id: "E", title: "夹E" }, { id: "F", title: "夹F" }, { id: "toview", title: "稍后再看" }];
    store[t.K.snapshot("E")] = { bvids: [] };
    store[t.K.snapshot("F")] = { bvids: ["BV71", "BV73"] };
    store[t.K.snapshot("toview")] = { bvids: ["BV72"] };
    const vids = [item(70), item(71), item(72), item(73)];
    openFake("E", vids);
    handlers["triage-unfav"] = () => (openFake("F", []), { ok: true });
    await t.fav.unfav("BV71");
    openFake("E", vids);
    handlers["triage-unfav"] = () => ({ ok: true });
    await t.fav.unfav("BV70");
    const rec = store[t.K.decisions("E")];
    assert.deepStrictEqual([rec.BV70.elsewhere, rec.BV71.elsewhere], [undefined, true], "single, and switched away mid-request");
    const savedAsk = t.askConfirm;
    t.askConfirm = async () => true;
    await t.fav.unfavMany([vids[2], vids[3]]);
    t.askConfirm = savedAsk;
    const recs = store[t.K.decisions("E")];
    assert.deepStrictEqual([recs.BV72.elsewhere, recs.BV73.elsewhere], [undefined, true], "batch; 稍后再看 is no favorite");
    for (const id of ["E", "F", "toview"]) delete store[t.K.snapshot(id)], delete store[t.K.decisions(id)];
    t.S.folders = savedFolders;
  }
  // 所有收藏夹: batch 取消收藏 asks which folders (each with its count), then goes folder by folder, naming it; a video
  // leaves each checked folder it is in, and the view only once it is in none. One U puts it back in every one.
  {
    const vids = [{ ...item(60), folders: ["W1"] }, { ...item(61), folders: ["W1", "W2"] }, { ...item(62), folders: ["W2", "W3"] }];
    openFake("all", vids);
    const savedFolders = [t.S.folders, t.S.allFolders];
    t.S.folders = t.S.allFolders = [{ id: "W1", title: "夹1" }, { id: "W2", title: "夹2" }, { id: "W3", title: "夹3" }];
    t.S.folderDecisions = { W1: {}, W2: {}, W3: {} };
    t.S.loadAll = { lists: {}, check: [], checkTotal: 0, queue: [], paused: false, running: false, error: "", partial: 0 };
    let asked = null;
    const savedAsk = t.askConfirm;
    const savedBody = t.el.confirmBody;
    t.askConfirm = async (title, body, ok) => ((asked = [title, body, ok]), true);
    t.el.confirmBody = { querySelectorAll: () => [{ value: "W1" }, { value: "W2" }] }; // R unchecked
    const calls = [];
    handlers["triage-unfav"] = (m) => (calls.push([m.mediaId, m.aids, t.activityState().text]), { ok: true });
    await t.fav.unfavMany(vids);
    assert.deepStrictEqual(asked[0], "在 B站取消收藏这 3 个视频？");
    assert.ok(asked[1].includes("「夹1」· 2 个") && asked[1].includes("「夹2」· 2 个") && asked[1].includes("「夹3」· 1 个"), asked[1]);
    assert.strictEqual(asked[2], "取消收藏 3 个");
    assert.deepStrictEqual(calls, [["W1", [1060, 1061], "取消收藏中「夹1」 0/4"], ["W2", [1061, 1062], "取消收藏中「夹2」 2/4"]]);
    assert.deepStrictEqual(plain(vids.map((it) => it.folders)), [[], [], ["W3"]]);
    assert.deepStrictEqual(plain(Object.keys(t.S.decisions)), ["BV60", "BV61"], "out of every folder: 处理完成");
    assert.deepStrictEqual([Object.keys(store[t.K.decisions("W1")]), Object.keys(store[t.K.decisions("W2")])], [["BV60", "BV61"], ["BV61", "BV62"]]);
    // C39: W1's BV61 and W2's BV62 left the video in a chosen folder (W2, W3); W2's BV61 was its last.
    const els = (f, b) => store[t.K.decisions(f)][b].elsewhere;
    assert.deepStrictEqual([els("W1", "BV60"), els("W1", "BV61"), els("W2", "BV61"), els("W2", "BV62")], [undefined, true, undefined, true]);
    const refav = [];
    const pills = [];
    handlers["triage-refav"] = (m) => (refav.push([m.mediaId, m.aid]), pills.push([t.activityState().text, t.fav.state().busy, t.fav.state().writing(m.mediaId)]), { ok: true });
    await t.undo();
    assert.deepStrictEqual([asked[0], asked[2]], ["在 B站重新收藏这 3 个视频？", "重新收藏 3 个"], "U asks first");
    assert.deepStrictEqual(refav, [["W1", 1060], ["W1", 1061], ["W2", 1061], ["W2", 1062]]);
    // G7: the undo shows in the pill, folder by folder, and counts as a batch write on the folder it writes to.
    assert.deepStrictEqual(pills, [["重新收藏中「夹1」 0/4", "重新收藏", true], ["重新收藏中「夹1」 1/4", "重新收藏", true], ["重新收藏中「夹2」 2/4", "重新收藏", true], ["重新收藏中「夹2」 3/4", "重新收藏", true]]);
    assert.strictEqual(t.fav.state().busy, "");
    assert.deepStrictEqual(plain(vids.map((it) => [...it.folders].sort())), [["W1"], ["W1", "W2"], ["W2", "W3"]]);
    assert.deepStrictEqual([t.S.decisions, store[t.K.decisions("W1")], store[t.K.decisions("W2")], t.S.undo.length], [{}, {}, {}, 0]);
    // 保留 is one list for every folder: the batch marks it everywhere, one U takes it back.
    t.S.tab = "read";
    t.S.selected = new Set(["BV61", "BV62"]);
    t.renderListHeader(t.visibleItems());
    assert.ok(["保留选中的 2 个", "取消收藏选中的 2 个"].every((x) => (t.el.listHeader.innerHTML + t.el.favSel.innerHTML).includes(x)), (t.el.listHeader.innerHTML + t.el.favSel.innerHTML));
    // H7: the bar has its own slot outside the header's rows (a folded header hides those).
    assert.ok(t.el.favSel.innerHTML.startsWith('<div class="selbar"') && !t.el.listHeader.innerHTML.includes("selbar"), t.el.favSel.innerHTML);
    t.batchKeep(t.batchList(null));
    assert.deepStrictEqual(plain(Object.keys(t.S.kept).filter((b) => b.startsWith("BV6"))), ["BV61", "BV62"]);
    assert.deepStrictEqual(plain([...t.S.selected]), ["BV61", "BV62"], "阅览 still lists them: 保留 keeps them selected");
    // K1: none of the selection left to keep: the count is still the selection's, off with why.
    t.renderListHeader(t.visibleItems());
    assert.ok(/aria-label="保留选中的 2 个"[^>]*disabled title="选中的都已经处理过了"/.test(t.el.favSel.innerHTML), t.el.favSel.innerHTML);
    await t.undo();
    assert.ok(!t.S.kept.BV61 && !t.S.kept.BV62);
    // U cut short by a failure: still in 所有收藏夹, the rest is the next U; after another folder opened, the rest stays
    // in each folder's 最近取消收藏 and the open folder gets no step.
    for (const away of [false, true]) {
      const again = [{ ...item(63), folders: ["W1"] }, { ...item(64), folders: ["W2"] }];
      openFake("all", again);
      handlers["triage-unfav"] = () => ({ ok: true });
      await t.fav.unfavMany(again);
      handlers["triage-refav"] = (m) => (m.aid === 1064 ? { ok: false, error: "网络错误" } : (away && openFake("E", []), { ok: true }));
      await t.undo();
      const want = away ? ["「所有收藏夹」撤销中断（已重新收藏 1 个，剩余 1 个在各收藏夹的最近取消收藏里）：网络错误", 0] : ["撤销中断（已重新收藏 1 个，剩余 1 个可再按 U 重试）：网络错误", 1];
      assert.deepStrictEqual([toasts.at(-1), t.S.undo.length], want, away ? "elsewhere: told only" : "here: U again");
    }
    // No folder checked: the dialog's button is off and says why; it is on again for the next dialog.
    let checkedNow = [];
    let answer;
    t.el.confirmBody = { querySelectorAll: () => checkedNow };
    t.askConfirm = () => new Promise((r) => (answer = r));
    const picking = t.pickBatchUnfavFolders(vids);
    t.el.confirmBody.onchange();
    assert.deepStrictEqual([t.el.confirmOk.textContent, t.el.confirmOk.disabled, t.el.confirmOk.title], ["取消收藏 0 个", true, "至少勾选一个收藏夹"]);
    answer(false);
    assert.deepStrictEqual(plain(await picking), []);
    assert.ok(!t.el.confirmOk.disabled && !t.el.confirmOk.title);
    t.askConfirm = savedAsk;
    t.el.confirmBody = savedBody;
    t.S.selected.clear();
    [t.S.folders, t.S.allFolders] = savedFolders;
    t.S.loadAll = null;
  }
  handlers["triage-refav"] = () => ({ ok: true });

  // B11: cells that a spreadsheet would run as a formula are prefixed with '.
  // (the cell rule itself is in shared.selftest.js)
  openFake("E", [{ ...item(5), title: "=cmd|' /C calc'!A0", upper: "@up" }]);
  t.S.folders = t.S.allFolders = [{ id: "E", title: "+夹" }];
  const csvRows = t.buildCsv().replace(/^\uFEFF/, "").split("\r\n");
  assert.ok(csvRows[1].startsWith("'+夹,BV5,'=cmd|' /C calc'!A0,'@up,"), csvRows[1]);

  // 待播: E adds in order, 移除 removes without touching decisions.
  openFake("P", [item(1), item(2), item(3)], { BV2: { action: "keep", at: 1 } });
  t.S.basket = [{ bvid: "BVgone", title: "别的收藏夹" }];
  for (const b of ["BV1", "BV2", "BV3"]) t.toggleBasket(b);
  assert.deepStrictEqual(plain(store[t.K.basket]), [{ bvid: "BVgone", title: "别的收藏夹" }, ...[1, 2, 3].map((n) => ({ bvid: `BV${n}`, title: `视频${n}`, upper: "up", duration: 61 }))]);
  // The card's button says what a click does: 「+ 待播 E」 outside, 「✓ 待播」 inside.
  {
    const btn = (b) => t.cardHtml(item(b), true, "").match(/<button[^>]*data-act="basket"[^]*?<\/button>/)[0];
    assert.strictEqual(btn(1), '<button type="button" data-act="basket" class="on" aria-label="已在待播，点一下移除 (E)" title="已在待播，点一下移除">✓ 待播</button>');
    const kept = t.S.basket;
    t.S.basket = kept.filter((x) => x.bvid !== "BV1");
    assert.strictEqual(btn(1), '<button type="button" data-act="basket" aria-label="加入待播 (E)" title="加入待播">+ 待播<kbd class="key">E</kbd></button>');
    t.S.basket = kept;
  }
  // F27: a 细看 judged without subtitles says so on the card, and why (the login, a failed download); a subtitle that may
  // not match the video gets the video page's warning.
  {
    const meta = () => t.cardHtml(item(1), false, "").match(/<div class="meta">([^]*?)<\/div>/)[1];
    t.S.analyses.BV1 = { status: "done", source: "subtitle", verdict: "keep" };
    assert.ok(!meta().includes("字幕"));
    t.S.analyses.BV1 = { status: "done", source: "meta", verdict: "keep" };
    assert.ok(meta().includes("视频没有字幕，按简介和评论判断"), meta());
    t.S.analyses.BV1.needLogin = true;
    assert.ok(meta().includes("未登录 B站，拿不到字幕，按简介和评论判断"), meta());
    t.S.analyses.BV1 = { status: "done", source: "meta", verdict: "keep", subtitleFailure: "网络断了" };
    assert.ok(meta().includes("字幕抓取失败：网络断了，按简介和评论判断") && !meta().includes("没有字幕"), meta());
    t.S.analyses.BV1 = { status: "done", source: "subtitle", verdict: "keep", subtitleWarning: "字幕时间轴到 06:40，视频长 04:33，字幕时间可能对不上。" };
    assert.ok(meta().includes(" · 字幕时间轴到 06:40，视频长 04:33，字幕时间可能对不上"), meta());
    delete t.S.analyses.BV1;
  }
  t.removeBasketItems([2]);
  t.toggleBasket("BV1");
  // E on a video already in 待播 is a 移除 too: one undo step, so U puts it back instead of undoing an older step.
  assert.strictEqual(toasts.at(-1), "已从待播移除 · U 撤销");
  await t.undo();
  assert.deepStrictEqual(plain(store[t.K.basket].map((x) => x.bvid)), ["BVgone", "BV1", "BV3"], "U undoes E's 移除");
  t.toggleBasket("BV1");
  assert.deepStrictEqual(plain(store[t.K.basket].map((x) => x.bvid)), ["BVgone", "BV3"]);
  assert.deepStrictEqual(plain(t.S.decisions), { BV2: { action: "keep", at: 1 } }, "移除 leaves decisions alone");
  // 移除 takes one out, leaving no mark behind; U puts it back.
  t.removeBasketItems([0]);
  assert.deepStrictEqual(plain(store[t.K.basket].map((x) => x.bvid)), ["BV3"]);
  assert.ok(!("triage_watched" in store), "移除 writes no 优先看过 mark");
  await t.undo();
  assert.deepStrictEqual(plain(store[t.K.basket].map((x) => x.bvid)), ["BVgone", "BV3"], "U puts 移除 back in place");
  // Each item's button is 移除, not 已看: the list is a queue with no watched state.
  t.S.viewing = "";
  t.renderBasket();
  assert.ok(t.el.basketList.innerHTML.includes('data-basket="remove" aria-label="从待播移除 ') && t.el.basketList.innerHTML.includes('title="从待播移除">移除</button>') && !t.el.basketList.innerHTML.includes("已看"), "待播 says 移除");
  for (const f of ["triage.html", "../../README.md"]) assert.ok(!/「已看」/.test(fs.readFileSync(path.join(__dirname, f), "utf8")), `${f} still says 「已看」`);
  // H11: an entry saved without a duration (BVgone, an old one) shows none, not 「0:00」.
  assert.ok(!t.S.itemMap.has("BVgone") && !t.el.basketList.innerHTML.includes("0:00"), "no 0:00 for an entry without a duration");
  // 清空 empties the list in one undoable step.
  t.clearBasket();
  assert.deepStrictEqual([plain(store[t.K.basket]), toasts.at(-1)], [[], "已清空待播 2 个 · U 撤销"]);
  await t.undo();
  assert.deepStrictEqual(plain(store[t.K.basket].map((x) => x.bvid)), ["BVgone", "BV3"], "U undoes 清空 in order");

  // 摘录或笔记 scopes: 逐个视频笔记 leaves invalid videos out, 一篇摘录 keeps them, marked.
  t.S.items.push({ ...item(4), invalid: true });
  t.S.itemMap.set("BV4", t.S.items[3]);
  t.S.basket.push({ bvid: "BV4" });
  t.S.selected.clear();
  t.S.selected.add("BV2"); // kept, so not listed in 未分析: a selection hidden there is left out
  t.S.selected.add("BV3");
  Object.assign(t.S, { tab: "none", titleRes: {}, analyses: { BVgone: { status: "done", oneLiner: "一句话", points: ["要点"] } }, notes: { BV3: { text: " 我的笔记 " } }, videoTags: {} });
  const scope = (s) => plain(t.writeScopeItems(s, true).map((it) => it.bvid));
  assert.deepStrictEqual([scope("selected"), scope("all"), scope("filter")], [["BV3"], ["BV1", "BV2", "BV3"], ["BV1", "BV3"]]);
  // A filter hides part of the selection: the bar counts only what is listed, and the hidden one stays selected.
  t.S.selected.add("BV1");
  t.S.query = "视频3";
  t.renderListHeader(t.visibleItems());
  assert.ok((t.el.listHeader.innerHTML + t.el.favSel.innerHTML).includes("已选中 1 个") && (t.el.listHeader.innerHTML + t.el.favSel.innerHTML).includes("另有 1 个被筛选隐藏"), "the bar counts only what is listed");
  assert.ok(t.S.selected.has("BV1"), "a video a filter hides stays selected");
  const sight = () => (t.renderListHeader(t.visibleItems()), t.renderTagButtons(), t.el.favSel.innerHTML + t.el.aiTagSlot.innerHTML);
  // K2: ✦ AI 打标签 counts the selected ones listed, as the bar does (its 选中 runs only those).
  assert.ok(sight().includes('aria-label="AI 打标签选中的 1 个 (I)"'), t.el.aiTagSlot.innerHTML);
  // K2 / K3: filters hide the whole selection: the bar's title and AI 打标签 count all of it, never 0.
  t.S.query = "没有这个标题";
  const hiddenAll = sight();
  assert.ok(hiddenAll.includes("已选中 2 个</strong><span class=\"muted\">都被筛选隐藏</span>") && hiddenAll.includes('aria-label="AI 打标签选中的 2 个 (I)"'), hiddenAll);
  t.S.query = "";
  // The selection belongs to the tab: the kept BV2 is not in 未分析, so it leaves the selection, and so does one kept now.
  await t.keepOne("BV1");
  t.renderListHeader(t.visibleItems());
  assert.deepStrictEqual(plain([...t.S.selected]), ["BV3"]);
  assert.ok((t.el.listHeader.innerHTML + t.el.favSel.innerHTML).includes("已选中 1 个") && !(t.el.listHeader.innerHTML + t.el.favSel.innerHTML).includes("被筛选隐藏"), (t.el.listHeader.innerHTML + t.el.favSel.innerHTML));
  delete t.S.kept.BV1;
  assert.deepStrictEqual(plain(t.writeScopeItems("all", false).map((it) => it.bvid)), ["BV1", "BV2", "BV3", "BV4"]);
  // 一篇摘录 carries what each video's own note carries (MdgNote.triageExtras), read from storage as the note is: the
  // 「AI 判断」 line, every folder's 分拣 tags and 摘读记录's, 星标 and the note.
  const KS = t.MdgLimits.KEYS;
  const digestScope = t.writeScopeItems("all", false);
  const digestStored = {
    [KS.triageAnalysis("BV1")]: { status: "done", oneLiner: "一句话", points: ["要点"], verdict: "keep", reason: "讲得清楚" },
    [KS.triageNotes]: { BV3: { text: " 我的笔记 " } },
    [KS.triageTags]: [{ id: "tx", name: "别的夹", folder: "999" }],
    [KS.triageVideoTags]: { BV1: ["tx"] },
    [KS.readingMarks]: { tags: [{ id: "r1", name: "精读" }], items: { [t.MdgNote.readingKey({ site: "bilibili", videoId: "BV1" })]: { tags: ["r1"], star: true } } }
  };
  const keys = vm.runInContext("digestKeys", ctx)(digestScope);
  assert.ok(Object.keys(digestStored).every((k) => keys.includes(k)), keys);
  const digest = t.buildMarkdown(digestScope, digestStored);
  assert.ok(digest.includes("## [视频4](https://www.bilibili.com/video/BV4)\n\nUP 主：up · 已失效"), digest);
  assert.ok(digest.includes("## [视频1](https://www.bilibili.com/video/BV1)\n\nUP 主：up · 星标\n\n> 一句话\n\n- 要点\n\nAI 判断：值得留，讲得清楚\n\n标签：别的夹、精读\n"), digest);
  assert.ok(digest.includes("## [视频3](https://www.bilibili.com/video/BV3)\n\nUP 主：up\n\n备注：我的笔记"), digest);
  t.S.selected.clear();

  // B12: titles with | [[ ]] or newlines cannot end the index-note link early.
  assert.strictEqual(t.wikiLink("B站/2026-10-02-a_b.md", "a|b [[c]]\nd"), "[[B站/2026-10-02-a_b|a b c d]]");
  assert.strictEqual(t.wikiLink("x.md", "|||"), "[[x|x]]");

  // 下载 .zip: the index links each note by a relative Markdown link, notes keep their frontmatter, and the
  // archive passes the system unzip with its Chinese names intact.
  {
    const { execFileSync } = require("child_process");
    const os = require("os");
    const note = "---\ntitle: \"窗口函数\"\n---\n\n## 字幕\n";
    const files = t.zipNotes("干货", [
      { bvid: "BVz1", title: "窗口 [函数]", filename: "2026-10-08-窗口 函数.md", markdown: note, oneLiner: "一句\n总结" },
      { bvid: "BVz2", title: "同名", filename: "2026-10-08-窗口 函数.md", markdown: "二" },
      { bvid: "BVz3", title: "撞索引", filename: "干货.md", markdown: "三" }
    ], "干货");
    assert.deepStrictEqual(plain(files.map((f) => f.name)), ["干货.md", "2026-10-08-窗口 函数.md", "2026-10-08-窗口 函数 (2).md", "干货 (2).md"]);
    assert.ok(files[0].text.includes("- [窗口 \\[函数\\]](<2026-10-08-窗口 函数.md>) 一句 总结\n"), files[0].text);
    assert.ok(files[0].text.includes("- [同名](<2026-10-08-窗口 函数 (2).md>)"), files[0].text);
    assert.strictEqual(files[1].text, note, "frontmatter stays frontmatter");

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "triage-zip-"));
    const zip = path.join(dir, "干货.zip");
    fs.writeFileSync(zip, t.MdgDownload.zipStored(files));
    // Info-ZIP's unzip checks the archive when it is on PATH (not on Windows by default); the hand read below always runs.
    const unzip = (args) => execFileSync("unzip", args, { encoding: "utf8" });
    let hasUnzip = true;
    try {
      unzip(["-v"]);
    } catch {
      hasUnzip = false;
      console.log("triage selftest: no unzip on PATH, the zip is only read by hand");
    }
    try {
      if (hasUnzip) {
        assert.match(unzip(["-t", zip]), /No errors detected/);
        unzip(["-q", zip, "-d", path.join(dir, "out")]);
        assert.deepStrictEqual(fs.readdirSync(path.join(dir, "out")).sort(), plain(files.map((f) => f.name)).sort(), "extracts under the same names");
        // Windows keeps no Unix permission bits to check.
        if (process.platform !== "win32") assert.strictEqual(fs.statSync(path.join(dir, "out", "干货.md")).mode & 0o777, 0o644, "extracted notes are readable");
        for (const f of files) assert.strictEqual(unzip(["-p", zip, f.name]), f.text, `unzip finds ${f.name} by its UTF-8 name`);
      }
      // The central directory read back by hand: UTF-8 flag, stored, CRC and name per entry.
      const buf = fs.readFileSync(zip);
      const end = buf.length - 22;
      assert.strictEqual(buf.readUInt32LE(end), 0x06054b50);
      let p = buf.readUInt32LE(end + 16);
      for (const f of files) {
        assert.strictEqual(buf.readUInt32LE(p), 0x02014b50);
        assert.strictEqual(buf.readUInt16LE(p + 8) & 0x0800, 0x0800, "bit 11 set");
        assert.strictEqual(buf.readUInt16LE(p + 10), 0, "stored");
        assert.strictEqual(buf.readUInt32LE(p + 16), require("zlib").crc32(f.text));
        const n = buf.readUInt16LE(p + 28);
        assert.strictEqual(buf.toString("utf8", p + 46, p + 46 + n), f.name);
        p += 46 + n;
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  // verdictOf precedence: invalid > done analysis > title result; invalid keeps the AI's reason and step.
  const v = { bvid: "BVv", title: "v" };
  Object.assign(t.S, { analyses: {}, titleRes: {} });
  assert.deepStrictEqual(plain(t.verdictOf(v)), { verdict: "none", reason: "", stage: -1, failed: "" });
  t.S.titleRes.BVv = { verdict: "keep", reason: "标题", confidence: "low" };
  t.S.analyses.BVv = { status: "error", error: "超时" };
  assert.deepStrictEqual(plain(t.verdictOf(v)), { verdict: "keep", reason: "标题", stage: 1, low: true, failed: "超时" });
  t.S.analyses.BVv = { status: "done", verdict: "drop", reason: "字幕" };
  assert.strictEqual(t.verdictOf(v).stage, 2);
  assert.deepStrictEqual(plain(t.verdictOf({ ...v, invalid: true })), { verdict: "drop", reason: "视频已失效。AI 原理由：字幕", stage: 2, failed: "" });
  assert.strictEqual(t.verdictOf({ bvid: "BVnone", invalid: true }).reason, "视频已失效");

  // Progress tabs follow which AI steps ran: no 粗看 → 未分析, a 粗看 class or invalid → 粗看完成,
  // a done 细看 → 细看完成, processed → 处理完成. Class and confidence never move a card.
  Object.assign(t.S, { analyses: {}, titleRes: {}, decisions: {}, videoTags: {}, tags: [] });
  const st = (patch = {}, it = v) => {
    Object.assign(t.S, patch);
    return t.stageOf(it);
  };
  assert.strictEqual(st(), "none");
  assert.strictEqual(st({ titleRes: { BVv: { verdict: "unsure", confidence: "high" } } }), "coarse");
  assert.strictEqual(st({ titleRes: { BVv: { verdict: "keep", confidence: "low" } } }), "coarse");
  assert.strictEqual(st({ titleRes: { BVv: { verdict: "drop", confidence: "high" } } }), "coarse", "a confident 粗看 可以删 stays in 粗看完成");
  assert.strictEqual(st({ analyses: { BVv: { status: "done", verdict: "unsure" } } }), "fine");
  assert.strictEqual(st({ analyses: { BVv: { status: "error" } }, titleRes: { BVv: { verdict: "unsure" } } }), "coarse", "a failed 细看 stays in 粗看完成 with its retry button");
  assert.strictEqual(st({ analyses: {}, titleRes: {} }, { ...v, invalid: true }), "coarse");
  assert.strictEqual(t.verdictOf({ ...v, invalid: true }).verdict, "drop", "invalid videos count as 可以删");
  assert.strictEqual(st({ decisions: { BVv: { action: "keep" } } }), "done");
  assert.strictEqual(st({ decisions: {} }, { ...v, invalid: true, bvid: "BVv" }), "coarse");
  // A1: only 取消收藏 / 保留 move a video to 处理完成; tags (T, 批量打标签) and notes do not.
  const tagged = { tags: [{ id: "t1", name: "x" }], videoTags: { BVv: ["t1"] }, notes: { BVv: { text: "备注", updatedAt: 1 } } };
  assert.strictEqual(st({ ...tagged, titleRes: {} }), "none", "a tagged, noted video without 粗看 stays in 未分析");
  assert.strictEqual(st({ titleRes: { BVv: { verdict: "unsure", confidence: "high" } } }), "coarse", "tagged 待定 stays in 粗看完成");
  assert.strictEqual(st({ analyses: { BVv: { status: "done", verdict: "keep" } } }), "fine", "tagged after 细看 stays in 细看完成");
  assert.strictEqual(st({ decisions: { BVv: { action: "unfav" } } }), "done");
  Object.assign(t.S, { videoTags: {}, tags: [], notes: {} });

  // 细看 batch: first fineBatchSize() open cards of 粗看完成, or the selected ones; 细看完成 buttons follow the selection too.
  const pool = Array.from({ length: 12 }, (_, i) => item(200 + i));
  openFake("F", pool);
  t.S.tab = "coarse"; // the selection is the open tab's
  t.S.titleRes = Object.fromEntries(pool.map((it, i) => [it.bvid, { verdict: i < 10 ? "unsure" : "drop", confidence: "high" }]));
  t.S.selected.clear();
  assert.deepStrictEqual(plain(t.nextBatch()), pool.slice(0, 10).map((it) => it.bvid));
  for (const it of pool) t.S.selected.add(it.bvid);
  assert.strictEqual(t.nextBatch().length, 10, "细看 takes at most 10 of a large selection");
  t.S.selected.clear();
  t.S.selected.add("BV209");
  t.S.selected.add("BV210");
  assert.deepStrictEqual(plain(t.nextBatch()), ["BV209", "BV210"], "a confident 粗看 card can be 细看'd too");
  t.S.analyses = { BV210: { status: "done", verdict: "drop" }, BV211: { status: "done", verdict: "drop" } };
  assert.deepStrictEqual(plain(t.nextBatch()), ["BV209"], "a selected card outside 粗看完成 is ignored");
  // G9: a selection none of which can be 细看'd (here a failed one) sends nothing rather than the next batch; the
  // button stays the selection's, disabled with why.
  t.S.selected = new Set(["BV208"]);
  t.S.analyses.BV208 = { bvid: "BV208", status: "error", error: "字幕取不到" };
  assert.deepStrictEqual(plain(t.nextBatch()), [], "not the next batch");
  t.renderListHeader(t.visibleItems());
  assert.ok((t.el.listHeader.innerHTML + t.el.favSel.innerHTML).includes('aria-label="字幕细看选中的 1 个" disabled title="选中的都不能字幕细看"'), (t.el.listHeader.innerHTML + t.el.favSel.innerHTML));
  delete t.S.analyses.BV208;
  t.S.selected = new Set(["BV209", "BV210"]);
  t.S.tab = "fine";
  t.S.classFilter.fine = "all";
  assert.deepStrictEqual(plain(t.batchList("keep").map((it) => it.bvid)), ["BV210"], "the selection overrides the verdict scope");
  t.S.selected.clear();
  assert.deepStrictEqual(plain(t.batchList("drop").map((it) => it.bvid)), ["BV210", "BV211"]);
  // Buttons lead with the action and name the AI class; filter chips show the bare class name.
  t.renderListHeader(t.visibleItems());
  for (const part of ["取消收藏（AI：可清理）2 个", "保留（AI：值得留）0 个"]) assert.ok((t.el.listHeader.innerHTML + t.el.favSel.innerHTML).includes(part), part);
  for (const part of [">全部 2<", ">可清理 2<", ">值得留 0<", ">拿不准 0<"]) assert.ok(t.el.classFilter.innerHTML.includes(part), part);
  assert.ok(t.el.classFilter.innerHTML.includes('class="zero">值得留 0<') && !t.el.classFilter.innerHTML.includes('class="zero">可清理'), "a 0 count stays, dimmed");
  assert.ok(t.verdictBadge("BV210", t.verdictOf(pool[10])).includes('class="badge drop"') && t.verdictBadge("BV210", t.verdictOf(pool[10])).includes('<span class="ai-mark">AI</span>可清理'));
  t.S.classFilter.fine = "keep";
  t.renderListHeader(t.visibleItems());
  assert.ok((t.el.listHeader.innerHTML + t.el.favSel.innerHTML).includes("保留（AI：值得留）") && !(t.el.listHeader.innerHTML + t.el.favSel.innerHTML).includes("取消收藏（AI"), "a filter shows only its own batch button");
  // J1: a selection the filter hides whole still decides: no AI-verdict batch for the cards listed.
  t.S.selected.add("BV211");
  t.renderListHeader(t.visibleItems());
  assert.ok(!t.el.listHeader.innerHTML.includes("（AI"), "a hidden selection: no verdict batch in 细看完成");
  t.S.selected.clear();
  t.S.classFilter.fine = "all";
  t.S.selected.add("BV210");
  t.renderListHeader(t.visibleItems());
  assert.ok((t.el.listHeader.innerHTML + t.el.favSel.innerHTML).includes("取消收藏选中的 1 个") && (t.el.listHeader.innerHTML + t.el.favSel.innerHTML).includes("保留选中的 1 个"));
  t.S.selected.clear();
  // A3: 待定 left after 细看 sits in 细看完成 under its own filter, and a selection there drives both batch buttons.
  t.S.analyses = { BV200: { status: "done", verdict: "unsure" } };
  t.S.classFilter.fine = "unsure";
  assert.deepStrictEqual(plain(t.visibleItems().map((it) => it.bvid)), ["BV200"]);
  t.renderListHeader(t.visibleItems());
  assert.ok(!(t.el.listHeader.innerHTML + t.el.favSel.innerHTML).includes("（AI") && !(t.el.listHeader.innerHTML + t.el.favSel.innerHTML).includes("按 X 或全选后"), "待定 has no verdict-scoped button and no hint");
  // 全选 selects what this tab lists; the selection then offers 移动/复制 with 保留 ones included.
  assert.ok((t.el.listHeader.innerHTML + t.el.favSel.innerHTML).includes('aria-checked="false"') && (t.el.listHeader.innerHTML + t.el.favSel.innerHTML).includes("全选 1 个"));
  t.S.selected.add("BV200");
  t.renderListHeader(t.visibleItems());
  assert.ok((t.el.listHeader.innerHTML + t.el.favSel.innerHTML).includes('aria-checked="true"') && (t.el.listHeader.innerHTML + t.el.favSel.innerHTML).includes("移动/复制选中的 1 个"));
  t.S.selected.clear();
  assert.strictEqual(t.batchList("keep").length, 0, "without a selection 待定 has no verdict-scoped batch");
  t.S.selected.add("BV200");
  assert.deepStrictEqual(plain(t.batchList("keep").map((it) => it.bvid)), ["BV200"]);
  assert.deepStrictEqual(plain(t.batchList("drop").map((it) => it.bvid)), ["BV200"]);
  t.batchKeep(t.batchList("keep"));
  assert.strictEqual(t.stageOf(pool[0]), "done", "batch 保留 moves it to 处理完成");
  Object.assign(t.S, { analyses: {}, decisions: {}, classFilter: { coarse: "all", fine: "all" } });
  t.S.selected.clear();
  // 粗看完成 chips: per-class counts in the tab; a chip narrows the next batch, a selection still wins; each tab keeps its chip.
  t.S.tab = "coarse";
  t.S.titleRes = Object.fromEntries(pool.map((it, i) => [it.bvid, i < 6 ? { verdict: "unsure", confidence: "high" } : { verdict: i % 2 ? "keep" : "drop", confidence: "low" }]));
  t.renderListHeader(t.visibleItems());
  for (const part of [">全部 12<", ">值得留 3<", ">可清理 3<", ">拿不准 6<"]) assert.ok(t.el.classFilter.innerHTML.includes(part), part);
  assert.ok((t.el.listHeader.innerHTML + t.el.favSel.innerHTML).includes("字幕细看下一批 10 个"));
  t.S.settings.triageFineBatchSize = 4;
  t.renderListHeader(t.visibleItems());
  assert.ok((t.el.listHeader.innerHTML + t.el.favSel.innerHTML).includes("字幕细看下一批 4 个"), "细看 batch size comes from the setting");
  t.S.settings.triageFineBatchSize = 999;
  assert.strictEqual(t.nextBatch().length, 12, "clamped to 50, so all 12 fit");
  // F7 / F14: the batch settings and 请求间隔 parse with UI.intIn (shared.selftest.js): rounded and capped at max, empty or
  // below min is the default, 0 a value where min is 0.
  {
    const html = fs.readFileSync(path.join(__dirname, "triage.html"), "utf8");
    assert.ok(html.includes('<input id="intervalInput" type="number" data-num="interval"') && html.includes('<input id="fwIntervalInput" type="number" data-num="interval"'), "the box has 关注's range");
    t.S.settings.triageFineBatchSize = 2.7;
    assert.strictEqual(t.nextBatch().length, 3, "rounded");
    t.S.settings.triageFineBatchSize = 999;
  }
  t.S.settings.triageFineBatchSize = 10;
  t.renderListHeader(t.visibleItems());
  // AI-starting buttons lead with the sparkle; plain actions do not.
  assert.ok((t.el.listHeader.innerHTML + t.el.favSel.innerHTML).includes('<span class="ai-spark" aria-hidden="true"></span>字幕细看下一批 10 个</button>'), "细看 carries the AI sparkle");
  assert.ok(t.verdictBadge("BV206", t.verdictOf(pool[6])).includes("低置信"), "low confidence is a badge in 粗看完成");
  t.S.classFilter.coarse = "keep";
  assert.deepStrictEqual(plain(t.nextBatch()), ["BV207", "BV209", "BV211"], "the batch comes from the filtered videos");
  t.renderListHeader(t.visibleItems());
  assert.ok(/保留（AI：值得留）3 个.*字幕细看下一批 3 个/.test((t.el.listHeader.innerHTML + t.el.favSel.innerHTML)), "chip 留 leads with batch 保留, 细看 second");
  t.S.classFilter.coarse = "drop";
  assert.deepStrictEqual(plain(t.batchList("drop").map((it) => it.bvid)), ["BV206", "BV208", "BV210"], "chip 可以删 gives a batch 取消收藏 list");
  t.renderListHeader(t.visibleItems());
  assert.ok(/取消收藏（AI：可清理）3 个.*字幕细看下一批 3 个/.test((t.el.listHeader.innerHTML + t.el.favSel.innerHTML)), "chip 可以删 leads with batch 取消收藏, 细看 second");
  assert.ok((t.el.listHeader.innerHTML + t.el.favSel.innerHTML).includes(">取消收藏（AI：可清理）3 个</button>"), "取消收藏 has no sparkle");
  // J1 / J3: the same in 粗看完成, and 细看 keeps the selection's true count, off with why.
  t.S.selected.add("BV207");
  assert.deepStrictEqual(plain(t.batchList("drop")), [], "not the listed 可清理 ones");
  t.renderListHeader(t.visibleItems());
  assert.ok(!t.el.listHeader.innerHTML.includes("（AI") && t.el.listHeader.innerHTML.includes('aria-label="字幕细看选中的 1 个" disabled title="选中的都被筛选隐藏了"'), t.el.listHeader.innerHTML);
  t.S.selected.clear();
  t.S.classFilter.coarse = "keep";
  t.S.classFilter.fine = "drop";
  assert.strictEqual(t.S.classFilter.coarse, "keep", "细看完成's chip does not touch 粗看完成's");
  t.S.selected.add("BV207");
  assert.deepStrictEqual(plain(t.nextBatch()), ["BV207"], "a selection still wins");
  t.renderListHeader(t.visibleItems());
  for (const part of ["字幕细看选中的 1 个", "保留选中的 1 个", "取消收藏选中的 1 个"]) assert.ok((t.el.listHeader.innerHTML + t.el.favSel.innerHTML).includes(part), part);
  assert.ok((t.el.listHeader.innerHTML + t.el.favSel.innerHTML).split("</div>")[0].includes("字幕细看选中的 1 个"), "细看 stays in row 3 with a selection, like 标题粗看");
  // The pill (runs' table, PILL's order) names what runs, whatever the tab: 细看 before 粗看. Its button pauses the run;
  // pressed, it says so (disabled) on the pill and in row 3 until the step in flight lands.
  {
    const runs = vm.runInContext("runs", ctx);
    let release;
    handlers["triage-analyze"] = () => new Promise((r) => (release = () => r({ ok: true, data: { bvid: "BV207", status: "done" } })));
    t.startGroup(["BV207"]);
    let release1;
    handlers["triage-classify-titles"] = () => new Promise((r) => (release1 = () => r({ ok: true, data: { results: {} } })));
    const stage1 = t.runStage1([item(950)]);
    await ticks();
    assert.deepStrictEqual(plain(t.activityState()), { text: "字幕细看中 0/1", done: 0, total: 1, act: "group", actLabel: "暂停细看", stopping: false });
    runs.stop("group");
    assert.deepStrictEqual(plain(t.activityState()), { text: "当前视频细看完就暂停", done: 0, total: 1, act: "group", actLabel: "暂停中", stopping: true });
    t.renderStatus();
    assert.ok(t.el.activity.innerHTML.includes('aria-label="暂停中" disabled title="当前视频细看完就暂停" aria-description="当前视频细看完就暂停">暂停中</button>'), t.el.activity.innerHTML);
    t.renderListHeader(t.visibleItems());
    assert.ok((t.el.listHeader.innerHTML + t.el.favSel.innerHTML).includes('aria-label="暂停中 0/1" disabled title="当前视频细看完就暂停" aria-description="当前视频细看完就暂停">暂停中 0/1</button>'), (t.el.listHeader.innerHTML + t.el.favSel.innerHTML));
    release();
    for (let i = 0; i < 50 && t.S.group; i++) await new Promise((r) => setImmediate(r));
    assert.ok(!t.S.group && t.S.analyses.BV207.status === "done", "the video in flight still lands");
    assert.deepStrictEqual(plain(t.activityState()), { text: "标题粗看中 0/1", done: 0, total: 1, act: "stage1", actLabel: "暂停粗看", stopping: false });
    runs.stop("stage1");
    assert.deepStrictEqual(plain(t.activityState()), { text: "当前批次粗看完就暂停", done: 0, total: 1, act: "stage1", actLabel: "暂停中", stopping: true });
    // J6: one wording per step for why it waits: the pill's line, its button and row 3's.
    t.renderStatus();
    t.S.tab = "none";
    t.renderListHeader(t.visibleItems());
    assert.ok(t.el.activity.innerHTML.includes('title="当前批次粗看完就暂停"') && t.el.listHeader.innerHTML.includes('title="当前批次粗看完就暂停"'), t.el.activity.innerHTML);
    t.S.tab = "coarse";
    release1();
    await stage1;
    delete t.S.analyses.BV207;
    delete t.S.titleRes.BV950;
    t.S.coarseFailed.delete("BV950");
  }
  // B1: an AI limit keeps the run's line, count and button, with the countdown after it.
  {
    const realSleep = t.sleepWhile, realStatus = t.renderStatus;
    const stuck = [];
    t.sleepWhile = async () => {};
    t.renderStatus = () => {
      const a = t.activityState();
      if (a?.stuck && !stuck.some((x) => x.text === a.text)) stuck.push(plain(a));
    };
    let n = 0;
    handlers["triage-classify-titles"] = () => (++n === 1 ? { ok: false, code: "AI_THROTTLED", error: "429" } : { ok: true, data: { results: { BV950: { verdict: "keep" } } } });
    await t.runStage1([item(950)]);
    assert.deepStrictEqual(stuck, [{ text: "标题粗看中 0/1 · AI 平台限流卡住，1:00 后重试", done: 0, total: 1, wait: "AI 平台限流卡住，1:00 后重试", stuck: true, act: "stage1", actLabel: "暂停粗看", stopping: false }]);
    assert.deepStrictEqual([n, t.activityState().text], [2, "标题粗看完成 1 个"]);
    // A timeout sends the same batch once more (aiJudge), as 细看 and AI 打标签 do.
    n = 0;
    delete t.S.titleRes.BV950;
    handlers["triage-classify-titles"] = () => (++n === 1 ? { ok: false, code: "AI_TIMEOUT", error: "超时" } : { ok: true, data: { results: { BV950: { verdict: "keep" } } } });
    await t.runStage1([item(950)]);
    assert.strictEqual(n, 2);
    // An unknown verdict fails the card with why; it does not become 拿不准 or move to 粗看完成.
    delete t.S.titleRes.BV950;
    handlers["triage-classify-titles"] = () => ({ ok: true, data: { results: {}, failed: { BV950: "AI 给的判断看不懂：「maybe」" } } });
    await t.runStage1([item(950)]);
    assert.deepStrictEqual([t.S.titleRes.BV950, t.S.coarseFailed.get("BV950")], [undefined, "AI 给的判断看不懂：「maybe」"]);
    t.S.coarseFailed.delete("BV950");

    Object.assign(t, { sleepWhile: realSleep, renderStatus: realStatus });
    delete t.S.titleRes.BV950;
    for (const job of ["stage1", "group"]) await vm.runInContext("runs", ctx).run(job, { line: () => "", next: () => null }); // drops their finished lines
  {
    const keep = { mediaId: t.S.mediaId, items: t.S.items, itemMap: t.S.itemMap, decisions: t.S.decisions, titleRes: t.S.titleRes, analyses: t.S.analyses };
    openFake("T553", [item(553)]);
    t.S.titleRes = { BV553: { verdict: "unsure" } };
    t.S.analyses = {};
    const analyze = handlers["triage-analyze"];
    handlers["triage-analyze"] = () => ({ ok: false, code: "AI_TRUNCATED", error: "模型输出被截断" });
    t.startGroup(["BV553"]);
    while (t.S.group) await new Promise(setImmediate);
    handlers["triage-analyze"] = analyze;
    assert.ok(t.el.bannerText.textContent.includes("调大细看输出上限"), t.el.bannerText.textContent);
    Object.assign(t.S, keep);
  }
  }
  assert.strictEqual(t.activityState(), null, "nothing running hides the pill");
  // 观看进度: pages read while this page waits on the read; B站 risk control shows the wait, and 刷新 during it says so.
  t.S.seenCfg.on = true;
  Object.assign(t.S.seenRead, { busy: true, pages: 3 });
  assert.deepStrictEqual(plain(t.activityState()), { text: "读观看进度… 已读 3 页" });
  Object.assign(t.S.seenRead, { busy: false, pages: 0 });
  handlers["triage-seen-sync"] = () => ({ ok: true, data: { skipped: "throttled", until: Date.now() + 90000 } });
  toasts.length = 0;
  await t.seenSync(true);
  assert.ok(/^观看进度 · B站限流卡住，1:(30|29) 后重试$/.test(toasts[0]), `a forced 刷新 while backing off is not silent: ${toasts}`);
  assert.ok(t.activityState().stuck && t.activityState().text === toasts[0]);
  // A read answers as it starts and goes on in the background: the page keeps showing it until triage-seen-done.
  t.S.seenRead.until = 0;
  handlers["triage-seen-sync"] = () => ({ ok: true, data: { reading: true } });
  await t.seenSync(false);
  assert.strictEqual(t.S.seenRead.busy, true);
  // C518: the read ending on an error (not B站限流) says why.
  toasts.length = 0;
  t.seenDone({ error: "未登录 B站" });
  assert.ok(!t.S.seenRead.busy && toasts[0] === "观看进度没有读完：未登录 B站", toasts.join("|"));
  t.seenDone({});
  assert.strictEqual(toasts.length, 1, "a read that finished says nothing");
  t.S.seenRead.busy = true;
  t.S.seenRead.busy = false;
  delete handlers["triage-seen-sync"];
  t.S.seenRead.until = 0;
  t.S.seenCfg.on = false;
  assert.strictEqual(t.activityState(), null);
  // 稍后再看 progress: seconds watched, -1 once finished, 0 or missing for not started.
  assert.strictEqual(t.seenText({ seen: 98, duration: 768 }), "看到 13%");
  assert.strictEqual(t.seenText({ seen: -1, duration: 768 }), "✓ 看完了");
  assert.strictEqual(t.seenText({ seen: 0, duration: 768 }), "");
  assert.strictEqual(t.seenText({ duration: 768 }), "");
  assert.strictEqual(t.seenText({ seen: 767, duration: 768 }), "✓ 看完了", "the covers' percent and words (seenPercentOf, seenWords)");
  // Results remember their 判断标准; after it changes, the old ones are offered for a redo. Unstamped ones count as current.
  const savedTitles = t.S.titleRes;
  const savedAnalyses = t.S.analyses;
  t.S.folderCriteria = { F: "新标准" };
  t.S.titleRes = { BV200: { verdict: "keep", criteria: "旧标准" }, BV201: { verdict: "keep", criteria: "新标准" }, BV202: { verdict: "keep" } };
  t.S.analyses = { BV203: { status: "done", verdict: "keep", criteria: "旧标准" }, BV204: { status: "done", verdict: "keep", criteria: "新标准" } };
  assert.deepStrictEqual(plain(t.staleCoarse().map((it) => it.bvid)), ["BV200"]);
  assert.deepStrictEqual(plain(t.staleFine().map((it) => it.bvid)), ["BV203"]);
  // C546: an invalid video can never be 细看'd again, so it is not offered for the redo.
  t.S.itemMap.get("BV206").invalid = true;
  t.S.analyses.BV206 = { status: "done", verdict: "keep", criteria: "旧标准" };
  assert.deepStrictEqual(plain(t.staleFine().map((it) => it.bvid)), ["BV203"], "invalid stays out of 按新标准重新细看");
  delete t.S.itemMap.get("BV206").invalid;
  delete t.S.analyses.BV206;
  t.S.tab = "fine";
  t.renderListHeader(t.visibleItems());
  // G10: the redo button counts only what is listed; filtered out, it stays, disabled, and says why.
  assert.ok((t.el.listHeader.innerHTML + t.el.favSel.innerHTML).includes('aria-label="按新标准重新细看" disabled title="当前筛选下没有要重新细看的视频"'));
  t.S.classFilter.fine = "all";
  t.renderListHeader(t.visibleItems());
  assert.ok((t.el.listHeader.innerHTML + t.el.favSel.innerHTML).includes("按新标准重新细看下一批 1 个"));
  // F1: like the step's own button, a selection of stale ones wins. G9: a selection with none stale does not fall back
  // to the next batch: the button stays the selection's, disabled with why.
  t.S.selected = new Set(["BV204"]);
  t.renderListHeader(t.visibleItems());
  assert.ok((t.el.listHeader.innerHTML + t.el.favSel.innerHTML).includes('aria-label="按新标准重新细看选中的 1 个" disabled title="选中的都不用按新标准重新细看"'), (t.el.listHeader.innerHTML + t.el.favSel.innerHTML));
  t.S.selected = new Set(["BV203", "BV204"]);
  t.renderListHeader(t.visibleItems());
  assert.ok((t.el.listHeader.innerHTML + t.el.favSel.innerHTML).includes("按新标准重新细看选中的 1 个"), (t.el.listHeader.innerHTML + t.el.favSel.innerHTML));
  t.S.settings.triageFineBatchSize = 1;
  t.S.analyses.BV205 = { status: "done", verdict: "keep", criteria: "旧标准" };
  t.S.selected = new Set(["BV203", "BV205"]);
  t.renderListHeader(t.visibleItems());
  assert.ok((t.el.listHeader.innerHTML + t.el.favSel.innerHTML).includes("按新标准重新细看选中的前 1 个"), "more selected than one batch");
  t.S.selected = new Set(["BV205"]);
  assert.deepStrictEqual(plain(vm.runInContext('redoState("细看", redoFineOpen(), fineBatchSize(), "fine")', ctx).batch.map((it) => it.bvid)), ["BV205"], "the selected one, not the first listed");
  delete t.S.analyses.BV205;
  t.S.settings.triageFineBatchSize = 10;
  t.S.selected.clear();
  // A redo batch goes by what it has redone, not by whether a result exists.
  const redo = { bvids: ["BV203", "BV204"], redo: new Set(["BV203", "BV204"]) };
  const pendingOf = (g) => g.bvids.filter((b) => vm.runInContext("groupPending", ctx)(g, b));
  assert.deepStrictEqual(pendingOf(redo), ["BV203", "BV204"]);
  redo.redo.delete("BV203");
  assert.deepStrictEqual(pendingOf(redo), ["BV204"]);
  t.S.folderCriteria = {};
  t.S.titleRes = savedTitles;
  t.S.analyses = savedAnalyses;
  t.S.tab = "coarse";
  t.S.selected.clear();
  t.S.classFilter.coarse = "all";
  // 字幕细看下一批 picks 待定 and low confidence before confident classes.
  t.S.titleRes = Object.fromEntries(pool.map((it, i) => [it.bvid, i < 6 ? { verdict: "keep", confidence: "high" } : i < 9 ? { verdict: "unsure", confidence: "high" } : { verdict: "drop", confidence: "low" }]));
  assert.deepStrictEqual(plain(t.nextBatch()), ["BV206", "BV207", "BV208", "BV209", "BV210", "BV211", "BV200", "BV201", "BV202", "BV203"]);
  Object.assign(t.S, { titleRes: Object.fromEntries(pool.map((it, i) => [it.bvid, { verdict: i < 10 ? "unsure" : "drop", confidence: "high" }])), classFilter: { coarse: "all", fine: "all" } });
  // A5: 粗看完成 lists the next batch first and failed cards last.
  t.S.tab = "coarse";
  t.S.analyses = { BV201: { status: "error", error: "x" } };
  const deepOrder = plain(t.visibleItems().map((it) => it.bvid));
  assert.deepStrictEqual(deepOrder.slice(0, 8), ["BV200", "BV202", "BV203", "BV204", "BV205", "BV206", "BV207", "BV208"]);
  assert.strictEqual(deepOrder.at(-1), "BV201");
  t.S.selected.add("BV209");
  assert.strictEqual(t.visibleItems()[0].bvid, "BV209", "a selected card is the batch and goes first");
  t.S.selected.clear();
  Object.assign(t.S, { analyses: {}, tab: "fine" });
  assert.strictEqual(vm.runInContext("currentStage(stageCounts())", ctx), "coarse", "the default tab is the earliest step with videos");

  // Backup maps storage keys to sections and never exports secrets or unrelated keys.
  for (const k of Object.keys(store)) delete store[k];
  Object.assign(store, {
    triage_tags: [{ id: "t1", name: "AI", color: "#111" }], triage_tag_presets: [{ id: "old" }],
    triage_folder_criteria: { 7: "只留干货" }, triage_simplified_v1: true,
    triage_video_tags: { BVa: ["t1"] }, triage_basket: [{ bvid: "BVa" }],
    triage_notes: { BVa: { text: "n", updatedAt: 1 } }, triage_notes_migrated: true,
    triage_snapshot_7: { bvids: ["BVa"] }, triage_decisions_7: { BVa: { action: "keep" } },
    triage_title_BVa: { verdict: "keep" }, triage_analysis_BVa: { status: "done" },
    [t.MdgLimits.KEYS.readingMarks]: { tags: [{ id: "r1", name: "精读" }], items: { "bilibili:BVa": { tags: ["r1"], star: true } } },
    triage_tab: "all", aiProviderKeys: { x: "sk-live-1" }, obsidianApiKey: "secret-token", triage_ai_command_history: ["按主题分"]
  });
  t.S.folders = t.S.allFolders = [{ id: 7, title: "夹" }];
  Object.assign(t.S.settings, { triageCoarseBatchSize: 5000, triageFineBatchSize: 7 });
  const backup = plain(await t.buildBackup());
  // G13: both batch sizes go in too, as read (clamped).
  assert.deepStrictEqual([backup.settings.triageCoarseBatchSize, backup.settings.triageFineBatchSize], [1000, 7]);
  Object.assign(t.S.settings, { triageCoarseBatchSize: 100, triageFineBatchSize: 10 });
  assert.deepStrictEqual(backup.folders, { 7: { title: "夹", snapshot: { bvids: ["BVa"] }, decisions: { BVa: { action: "keep" } } } });
  assert.strictEqual(backup.schemaVersion, 3);
  assert.deepStrictEqual([backup.tags, backup.folderCriteria, backup.videoTags], [[{ id: "t1", name: "AI", color: "#111" }], { 7: "只留干货" }, { BVa: ["t1"] }]);
  assert.ok(!("basket" in backup), "待播 is not backed up");
  assert.ok(!("schemes" in backup) && !("folderScheme" in backup) && !/"old"/.test(JSON.stringify(backup)), "old scheme keys are not exported");
  assert.deepStrictEqual([backup.titleResults, backup.analyses], [{ BVa: { verdict: "keep" } }, { BVa: { status: "done" } }]);
  assert.deepStrictEqual(backup.notes, { BVa: { text: "n", updatedAt: 1 } });
  assert.deepStrictEqual(backup.readingMarks, { tags: [{ id: "r1", name: "精读" }], items: { "bilibili:BVa": { tags: ["r1"], star: true } } }, "J1: 摘读记录's 星标 and tags");
  assert.deepStrictEqual(backup.aiHistory, ["按主题分"], "C664: AI 打标签's instructions, as 关注's");
  assert.ok(!/sk-live-1|secret-token|triage_tab|migrated|simplified/.test(JSON.stringify(backup)), "no secrets or unrelated keys");

  // Old custom-tier results: a 粗看 one counts as not classified, a done 细看 one as 待定.
  const old = item(400);
  openFake("H", [old]);
  Object.assign(t.S, { analyses: {}, decisions: {}, titleRes: { BV400: { verdict: "t-must", confidence: "high" } } });
  assert.strictEqual(t.stageOf(old), "none");
  assert.strictEqual(t.verdictOf(old).stage, -1);
  t.S.analyses.BV400 = { status: "done", verdict: "t-must", reason: "旧" };
  assert.deepStrictEqual([t.verdictOf(old).verdict, t.stageOf(old)], ["unsure", "fine"]);
  Object.assign(t.S, { analyses: {}, titleRes: {} });

  // 判断标准 is per folder and goes with 粗看 requests together with the folder name and intro; an empty one is removed.
  openFake("J", [item(500)]);
  t.S.folders = t.S.allFolders = [{ id: "J", title: "干货" }];
  t.S.folderIntro = { J: "学习用" };
  t.S.folderCriteria = { J: "只留干货" };
  handlers["triage-classify-titles"] = () => ({ ok: true, data: { results: { BV500: { verdict: "keep", reason: "", confidence: "high" } } } });
  Object.assign(t.S.settings, { triageIntervalSec: 0 });
  await t.runStage1();
  assert.deepStrictEqual(plain(sent.at(-1)), { type: "triage-classify-titles", items: [{ bvid: "BV500", title: "视频500", upper: "up", duration: 61 }], criteria: "只留干货", folder: { title: "干货", intro: "学习用" } });
  t.S.tab = "none";
  t.renderListHeader(t.visibleItems());
  // 判断标准 written: the button, its text in the tooltip, no dot. Not written: the warn dot and the label says so.
  assert.ok((t.el.listHeader.innerHTML + t.el.favSel.innerHTML).includes('title="判断标准：只留干货" aria-label="判断标准">') && !(t.el.listHeader.innerHTML + t.el.favSel.innerHTML).includes("dot-warn"));
  t.el.criteriaInput = { value: "  " };
  t.saveCriteria();
  assert.deepStrictEqual(plain(store[t.K.folderCriteria]), {});
  t.renderListHeader(t.visibleItems());
  assert.ok((t.el.listHeader.innerHTML + t.el.favSel.innerHTML).includes('aria-label="判断标准（还没写）"') && (t.el.listHeader.innerHTML + t.el.favSel.innerHTML).includes('判断标准<i class="dot-warn"'));
  // Clearing the 判断标准 offered 重新粗看 (askConfirm says yes here); stop it before the next block swaps the state.
  await new Promise((r) => setTimeout(r, 0));
  vm.runInContext("runs", ctx).stop("stage1");
  while (vm.runInContext("runs", ctx).get("stage1")) await new Promise((r) => setTimeout(r, 0));

  // 重新粗看 keeps the old result until a new one arrives: a failed run leaves the card as it was.
  t.S.folderCriteria = { J: "新标准" };
  t.S.titleRes.BV500 = { verdict: "keep", reason: "旧理由", confidence: "high", criteria: "旧标准" };
  handlers["triage-classify-titles"] = () => ({ ok: false, error: "AI 出错" });
  await t.runStage1(t.staleCoarse());
  assert.strictEqual(t.S.titleRes.BV500?.reason, "旧理由", "a failed 重新粗看 keeps the old 粗看");
  assert.strictEqual(sent.at(-1).criteria, "新标准");
  handlers["triage-classify-titles"] = () => ({ ok: true, data: { results: { BV500: { verdict: "drop", reason: "新理由", confidence: "high" } } } });
  await t.runStage1(t.staleCoarse());
  assert.deepStrictEqual([t.S.titleRes.BV500.reason, t.S.titleRes.BV500.criteria], ["新理由", "新标准"], "the new result replaces it");
  Object.assign(t.S, { titleRes: {}, folderCriteria: {} });

  // 移动/复制 is offered for a selection in any tab, 未分析 too.
  openFake("Z", [item(700)]);
  t.S.tab = "none";
  t.S.selected.add("BV700");
  t.renderListHeader(t.visibleItems());
  assert.ok(["移动/复制选中的 1 个", "保留选中的 1 个", "取消收藏选中的 1 个"].every((x) => (t.el.listHeader.innerHTML + t.el.favSel.innerHTML).includes(x)), "未分析 offers every selection action");
  t.S.selected.clear();

  // 批量打标签 proposals: new tags only by name, all kept past the cap of 5; a verdict in the reply changes nothing.
  openFake("K", [item(600), item(601)]);
  Object.assign(t.S, { tags: [{ id: "a", name: "旧", color: "#111", folder: "K" }, { id: "o", name: "别处", color: "#222", folder: "L" }], videoTags: {}, titleRes: { BV600: { verdict: "drop", confidence: "high" } } });
  const prop = { newTags: [], rows: [], notes: [], errors: [] };
  t.TriageUi.mergeAiBatch(prop, { newTags: ["n1", "n2", "旧", "n3", "n4", "n5", "n6"], assignments: { BV600: { add: ["n1", "旧"], verdict: "keep" }, BV601: { verdict: "t-must" } } }, { tags: t.viewTags(), map: t.S.videoTags, maxNewTags: 5, scope: new Set(["BV600", "BV601"]) });
  assert.deepStrictEqual(plain(prop.newTags.map((x) => x.name)), ["n1", "n2", "n3", "n4", "n5", "n6"]);
  assert.deepStrictEqual(plain(prop.rows), [{ id: "BV600", add: ["new:n1", "id:a"], remove: [] }]);
  t.S.ai.proposal = prop;
  await applyAi();
  assert.deepStrictEqual(plain(t.S.tags.map((x) => x.name)), ["旧", "别处", "n1", "n2", "n3", "n4", "n5", "n6"]);
  assert.ok(t.S.tags.slice(2).every((x) => Object.keys(x).join() === "id,name,color,folder" && x.folder === "K"), "new tags belong to the open folder, no rule");
  t.S.tags = t.S.tags.filter((x) => x.name !== "n6"); // the cap tests below count from 6 tags in K
  assert.strictEqual(t.verdictOf(item(600)).verdict, "drop", "批量打标签 never changes the verdict");

  // 管理: a rule is saved trimmed and capped at 80, an empty one removed; 批量打 sends { name, rule } for every tag.
  const ruled = t.S.tags[0];
  assert.ok((await saveTagEdit(ruled, "rule", `  ${"讲".repeat(90)} `)) && tagNow(ruled).rule.length === 80);
  assert.ok((await saveTagEdit(ruled, "rule", "  讲老技术的  ")) && tagNow(ruled).rule === "讲老技术的");
  assert.deepStrictEqual(plain(store[t.K.tags][0]), { id: "a", name: "旧", color: "#111", folder: "K", rule: "讲老技术的" });
  assert.ok(!(await saveTagEdit(ruled, "name", "n1")) && tagNow(ruled).name === "旧", "a duplicate name is refused");
  // Names are cleaned as 关注 and the AI clean them: no commas or 顿号, at most 12 characters.
  assert.ok(!(await saveTagEdit(ruled, "name", "n1、")) && tagNow(ruled).name === "旧", "a cleaned duplicate is refused too");
  assert.ok((await saveTagEdit(ruled, "name", " 旧, ")) && tagNow(ruled).name === "旧");
  assert.strictEqual(t.TriageUi.previewId({ newTags: [{ key: "k", name: "旧，", checked: true }] }, "k", t.viewTags()), "a", "an edited AI name matches the cleaned tag");
  Object.assign(t.S, { tab: "read", aiHistory: [] });
  handlers["triage-ai-command"] = () => ({ ok: true, data: {} });
  await t.runAiCommand({ instruction: "按深度分", scope: "filter", allowRemove: false });
  assert.deepStrictEqual(plain(sent.at(-1).tags.slice(0, 2)), [{ name: "旧", rule: "讲老技术的" }, { name: "n1", rule: "" }]);
  assert.ok(!sent.at(-1).tags.some((x) => x.name === "别处"), "批量打 sends only the open folder's tags");
  assert.strictEqual(sent.at(-1).maxNewTags, 4, "6 tags in K: min(5, 10 - 6)");
  // An AI 429 waits and sends the same batch again; it is not a failed batch.
  {
    const realSleep = t.sleepWhile;
    const waits = [];
    t.sleepWhile = async (ms) => waits.push(ms);
    let calls = 0;
    handlers["triage-ai-command"] = () => (++calls === 1 ? { ok: false, code: "AI_THROTTLED", error: "HTTP 429" } : { ok: true, data: {} });
    const before = sent.length;
    await t.runAiCommand({ instruction: "按深度分", scope: "filter", allowRemove: false });
    const batches = sent.slice(before).filter((m) => m.type === "triage-ai-command");
    assert.strictEqual(batches.length, 2, "the throttled batch is sent again");
    assert.deepStrictEqual(plain(batches[1].items), plain(batches[0].items));
    assert.deepStrictEqual([waits.reduce((a, b) => a + b), plain(t.S.ai.proposal.errors)], [60000, []]);
    t.sleepWhile = realSleep;
    t.S.ai.proposal = null;
    handlers["triage-ai-command"] = () => ({ ok: true, data: {} });
  }
  // An AI that keeps answering 429 is waited out AI_THROTTLE_WAITS (5) times in a row, then the run ends with a banner.
  {
    const realSleep = t.sleepWhile;
    const waits = [];
    t.sleepWhile = async (ms) => waits.push(ms);
    handlers["triage-ai-command"] = () => ({ ok: false, code: "AI_THROTTLED", error: "AI 平台限流" });
    const before = sent.length;
    await t.runAiCommand({ instruction: "按深度分", scope: "filter", allowRemove: false });
    assert.strictEqual(sent.slice(before).filter((m) => m.type === "triage-ai-command").length, 6);
    assert.deepStrictEqual([waits.reduce((a, b) => a + b), t.S.ai.proposal], [5 * 60000, null]);
    assert.deepStrictEqual([t.el.bannerText.textContent, t.el.bannerBtn.textContent], ["AI 平台持续限流，已等待重试 5 次，已停止", "去设置"]);
    t.sleepWhile = realSleep;
    t.el.banner.hidden = true;
    handlers["triage-ai-command"] = () => ({ ok: true, data: {} });
  }
  // Which AI errors end a run is MdgErrors' 去设置 list (the side panel's too), not a list of its own.
  for (const code of ["AI_AUTH", "AI_QUOTA", "AI_SETUP", "AI_NETWORK", "AI_TIMEOUT", "AI_GAVE_UP"])
    assert.ok(vm.runInContext("aiEnds", ctx)({ ok: false, code }) && ctx.MdgErrors.action(code) === "settings", code);
  // I7: 未授权访问 ends it by its code, not by matching the words.
  assert.ok(vm.runInContext("aiEnds", ctx)({ ok: false, code: "AI_ACCESS", error: "x" }) && !vm.runInContext("aiEnds", ctx)({ ok: false, error: "未授权访问 https://a.test" }));
  assert.ok(!vm.runInContext("aiEnds", ctx)({ ok: false, code: "AI_BAD_JSON" }) && !vm.runInContext("aiEnds", ctx)({ ok: false, code: "OBSIDIAN" }), "a video's own error or a non-AI code goes on");
  // X3: one judge for 粗看, 细看 and AI 打标签 (aiJudge, a run's own counts, with the 收藏夹 runs' hold). An error of this
  // request alone fails only it.
  {
    const aiJudge = () => {
      const judge = t.MdgRuns.aiJudge();
      return (r) => judge(r, vm.runInContext("runs", ctx).hold);
    };
    const steps = (rs) => {
      const judge = aiJudge();
      return rs.map((r) => judge({ ...r }));
    };
    const T = { ok: false, code: "AI_TIMEOUT" }, L = { ok: false, code: "AI_THROTTLED" }, own = { ok: false, error: "字幕取不到" };
    assert.deepStrictEqual(steps([T, T]), ["retry", "stop"], "the second timeout in a row ends the run");
    assert.deepStrictEqual(steps([T, { ok: true }, T]), ["retry", "ok", "retry"], "an answer resets the count");
    assert.deepStrictEqual(steps([L, L, L, L, L, L]), ["wait", "wait", "wait", "wait", "wait", "stop"]);
    const judge = aiJudge();
    const last = { ...L };
    for (const r of [L, L, L, L, L]) judge({ ...r });
    assert.deepStrictEqual([judge(last), last.code], ["stop", "AI_GAVE_UP"], "the run then ends as AI_GAVE_UP");
    assert.strictEqual(aiJudge()({ ...L }), "wait", "each run counts its own");

    assert.deepStrictEqual(steps([T, own, T]), ["retry", "item", "retry"], "only this video (粗看: this batch) failed");
    assert.deepStrictEqual(steps([{ ok: false, code: "AI_QUOTA" }]), ["stop"]);
  }
  // Every batch failed: nothing to confirm (no 待确认), the reason is toasted. A setup error (配置 AI) stops the run at
  // the first batch, as in 关注.
  {
    const realScope = t.aiScopeItems;
    t.aiScopeItems = () => [item(600), item(601)];
    t.S.settings.triageAiBatchSize = 1;
    handlers["triage-ai-command"] = () => ({ ok: false, code: "AI_SETUP", error: "没有启用的 AI 平台" });
    const before = sent.length;
    await t.runAiCommand({ instruction: "按深度分", scope: "filter", allowRemove: false });
    const batches = sent.slice(before).filter((m) => m.type === "triage-ai-command");
    assert.strictEqual(batches.length, 1, "a 配置 AI error ends the run");
    assert.strictEqual(t.S.ai.proposal, null, "no proposal when no batch got through");
    t.renderTabs();
    assert.ok(!t.el.aiTagSlot.innerHTML.includes("待确认"), "no 「待确认」 after a run that got nothing");
    assert.strictEqual(toasts.at(-1), "AI 打标签没有成功：第 1 批失败：没有启用的 AI 平台");
    // The AI 打标签 batch size: its own setting, 30 until it is saved; whole numbers (rounded) within 1–100.
    const aiBatchSize = vm.runInContext("aiBatchSize", ctx);
    delete t.S.settings.triageAiBatchSize;
    assert.strictEqual(aiBatchSize(), 30, "no triageAiBatchSize yet: 30");
    t.S.settings.triageAiBatchSize = 7.9;
    assert.strictEqual(aiBatchSize(), 8, "rounded");
    delete t.S.settings.triageAiBatchSize;
    t.aiScopeItems = realScope;
    handlers["triage-ai-command"] = () => ({ ok: true, data: {} });
  }
  t.S.settings.triageAiNewTagMax = 2;
  assert.strictEqual(room(), 2, "分拣设置 caps AI new tags below the folder's room");
  t.S.settings.triageAiNewTagMax = 0;
  assert.strictEqual(room(), 0, "0 = AI only uses existing tags");
  t.S.settings.triageAiNewTagMax = 5;
  await saveTagEdit(tagNow(ruled), "rule", " ");
  assert.ok(!("rule" in tagNow(ruled)));
  t.S.ai.proposal = null;

  // 标签管理 then ✦ AI 打标签 on the tag row (the sidebar has neither); AI 打标签 says when a run or a proposal is pending; I always opens its section.
  const spark = '<span class="ai-spark" aria-hidden="true"></span>';
  const btnText = () => (t.renderTabs(), t.el.aiTagSlot.innerHTML.replace(/<[^>]+>/g, ""));
  assert.ok((t.renderTabs(), t.el.aiTagSlot.innerHTML.includes(spark)), "AI 打标签 carries the AI sparkle");
  // F10: with a selection listed the dialog opens on 选中, so the row-4 button says how many; the selection bar has none.
  t.S.selected.clear();
  const firstShown = t.visibleItems()[0].bvid;
  t.S.selected.add(firstShown);
  t.S.selected.add("BV-not-listed");
  t.renderListHeader(t.visibleItems());
  assert.strictEqual(btnText(), "标签管理AI 打标签选中的 1 个", "counts only the selected ones listed");
  assert.ok(t.el.aiTagSlot.innerHTML.includes('aria-label="AI 打标签选中的 1 个 (I)"') && !(t.el.listHeader.innerHTML + t.el.favSel.innerHTML).includes("AI 打标签"), "row 4 only");
  t.S.selected.clear();
  t.renderListHeader(t.visibleItems());
  assert.strictEqual(btnText(), "标签管理AI 打标签");
  assert.ok(t.el.aiTagSlot.innerHTML.indexOf("标签管理") < t.el.aiTagSlot.innerHTML.indexOf(spark), "only AI 打标签 has the sparkle");
  const aiRun = hang("ai");
  assert.strictEqual(btnText(), "标签管理AI 打标签 · 运行中");
  await aiRun();
  Object.assign(t.S.ai, { proposal: { newTags: [], rows: [], notes: [], errors: [] } });
  assert.strictEqual(btnText(), "标签管理AI 打标签 · 待确认");
  // A run ends with renderTop only (no list render): the button turns to 待确认 then and there.
  t.el.aiTagSlot.innerHTML = "";
  t.renderTop();
  assert.ok(t.el.aiTagSlot.innerHTML.includes("· 待确认"), "renderTop redraws AI 打标签");
  t.S.ai.proposal = null;
  // I opens the AI 打标签 dialog with 收藏夹's adapter; its link to 标签管理 carries 收藏夹's 标签管理 adapter.
  const aiTags = vm.runInContext("aiTags", ctx);
  const manageTags = vm.runInContext("manageTags", ctx);
  dialogs.length = 0;
  t.onKey({ key: "i", target: {}, preventDefault() {} });
  assert.deepStrictEqual(dialogs, [["ai", aiTags]], "I opens AI 打标签, not 标签管理");
  assert.ok(aiTags.who === "视频" && manageTags.who === "视频" && aiTags.manage === manageTags);
  assert.deepStrictEqual(plain(aiTags.scopes().map((x) => x.value)), ["filter", "selected", "analyzed"]);
  // C493: a run in another folder is not this folder's: its proposal shows (运行 stays off through blocked()).
  {
    const R = vm.runInContext("runs", ctx);
    const get = R.get;
    R.get = (job) => (job === "ai" ? { name: "AI 打标签" } : get(job));
    t.S.ai.mediaId = "elsewhere";
    assert.ok(!aiTags.running() && aiTags.blocked().startsWith("正在处理"), aiTags.blocked());
    t.S.ai.mediaId = String(t.S.mediaId);
    assert.ok(aiTags.running());
    R.get = get;
    t.S.ai.mediaId = "";
  }

  // Cap: 10 tags per folder. Creating an 11th is refused, a same-name one is reused; 批量打's room shrinks to 0.
  for (const n of ["c1", "c2", "c3", "c4"]) assert.ok((await createTag(n)));
  assert.strictEqual(t.viewTags().length, 10);
  toasts.length = 0;
  assert.strictEqual((await createTag("c5")), null);
  assert.ok(/已经有 10 个标签/.test(toasts.at(-1)) && !t.S.tags.some((x) => x.name === "c5"));
  assert.strictEqual((await createTag("c1")).folder, "K", "an existing name is still found at the cap");
  // K16: at the cap 标签管理's 添加 says why before the click, and the picker offers no 新建「…」, its empty list says why.
  assert.ok(/已经有 10 个标签/.test(manageTags.addReason("c9")), manageTags.addReason("c9"));
  t.openPicker(t.S.items[0].bvid);
  assert.ok(!po.canCreate && /已经有 10 个标签/.test(po.empty), po.empty);
  po = null;
  assert.strictEqual(room(), 0);
  assert.ok(aiTags.roomHint().includes("名额已满"));
  // The cap comes from 分拣设置: raising it lets c5 in, lowering it keeps existing tags but refuses new ones.
  t.S.settings.triageTagLimit = 11;
  assert.strictEqual(room(), 1);
  assert.ok((await createTag("c5")));
  t.S.settings.triageTagLimit = 3;
  assert.strictEqual((await createTag("c6")), null);
  assert.strictEqual(t.viewTags().length, 11, "lowering the cap deletes nothing");
  t.S.settings.triageTagLimit = 10;
  t.S.tags = t.S.tags.filter((x) => !/^c\d$/.test(x.name));
  assert.deepStrictEqual([manageTags.addReason(""), manageTags.addReason("c1"), manageTags.addReason("c1x")], ["标签名不能为空", "", ""]);
  assert.strictEqual(room(), 4);
  const long = (await createTag("入门，进阶一二三四五六七八九十"));
  assert.strictEqual(long.name, "入门进阶一二三四五六七八");
  assert.strictEqual((await createTag(" 入门进阶一二三四五六七八 ")).id, long.id);
  assert.strictEqual((await createTag("、")), null, "a name that cleans to nothing is refused");
  t.S.tags = t.S.tags.filter((x) => x !== long);
  assert.ok(aiTags.roomHint().includes("AI 这次最多新建 4 个（这个收藏夹还剩 4 个名额）"));
  // A new tag takes the folder's first free color, so a deleted tag's color comes back instead of a taken one
  // repeating; 管理's color button moves to the next color.
  {
    const C = ctx.MdgTagCore.TAG_COLORS;
    openFake("K", [item(710)]);
    t.S.tags = [{ id: "p0", name: "p0", color: C[0], folder: "K" }, { id: "p2", name: "p2", color: C[2], folder: "K" }, { id: "q", name: "q", color: C[1], folder: "Z" }];
    t.S.videoTags = { BV710: ["p0"] };
    const p1 = (await createTag("p1"));
    assert.strictEqual(p1.color, C[1], "not C[2] (two tags → third color), which p2 has");
    assert.ok(await saveTagEdit(p1, "color"));
    assert.strictEqual(tagNow(p1).color, C[2]);
    assert.deepStrictEqual([manageTags.count("p0"), manageTags.count("p1")], [1, 0], "标签管理 counts the videos per tag");

    // The picker saves once on close, as one undo step, on top of what changed meanwhile.
    toasts.length = 0;
    assert.ok(await pickWith("BV710", (sets) => {
      t.TagPicker.toggle(sets, "p2");
      t.S.videoTags.BV710 = ["p0", p1.id]; // AI 批量打 or another tab, while the picker is open
    }));
    assert.deepStrictEqual(plain(t.S.videoTags.BV710), ["p0", p1.id, "p2"]);
    assert.strictEqual(t.S.undo.length, 1, "one close, one undo step");
    assert.deepStrictEqual(toasts, ["标签已更新 · U 撤销"]);
    await t.undo();
    assert.deepStrictEqual(plain(t.S.videoTags.BV710), ["p0", p1.id]);
    assert.ok(await pickWith("BV710", () => {}) && t.S.undo.length === 0, "closing without a change saves nothing");

    // The viewer line: the playing video's tags and 「+ 标签 T」, which opens the picker under it.
    const play = (b) => ((t.S.viewing = b), (t.S.viewer = t.viewerOf(b)), t.renderViewerTags());
    play("BV710");
    assert.ok(!t.el.viewerTags.hidden && t.el.viewerTags.innerHTML.includes("data-vtag>p0</span>") && t.el.viewerTags.innerHTML.includes('class="quiet tag-plus" data-vtag'));
    assert.ok(t.el.viewerTags.innerHTML.includes('data-vtag aria-label="打视频标签"'), "the button says what it does, as the picker's title (给「…」打视频标签)");
    // It is named 「视频标签」, and T (which tags the playing video in 收藏夹) shows on its 「+ 标签」.
    assert.ok(t.el.viewerTags.innerHTML.startsWith('<span class="row-label">视频标签</span>') && t.el.viewerTags.innerHTML.includes('<kbd class="k-faint" aria-hidden="true">T</kbd>'));
    po = null;
    vm.runInContext("tagPlaying()", ctx);
    assert.deepStrictEqual([po?.anchor, plain(po?.targets)], ["#viewerTags .tag-plus", ["BV710"]]);
    // 已出分拣范围 shows the tags but cannot change them.
    t.S.mediaId = "removed";
    play("BV710");
    assert.ok(t.el.viewerTags.innerHTML.includes(">p0</span>") && !t.el.viewerTags.innerHTML.includes("data-vtag"));
    // No tags: no 「未打标签」, only the name (and 「+ 标签」 where it can change them).
    const p0s = t.S.videoTags.BV710;
    t.S.videoTags.BV710 = [];
    t.renderViewerTags();
    assert.strictEqual(t.el.viewerTags.innerHTML, '<span class="row-label">视频标签</span>');
    t.S.mediaId = "K";
    play("BV710");
    assert.ok(!t.el.viewerTags.innerHTML.includes("未打标签") && t.el.viewerTags.innerHTML.endsWith("</kbd></button>"));
    t.S.videoTags.BV710 = p0s;
    t.S.mediaId = "removed";
    play("BV710");
    po = null;
    vm.runInContext("tagPlaying()", ctx);
    assert.strictEqual(po, null);
    play("");
    assert.ok(t.el.viewerTags.hidden && t.el.viewerTags.innerHTML === "");
    // Each draw also redraws 关注's 「UP 标签」 line (the hook), which in 收藏夹 asks for the playing video's UP. 关注 keeps
    // the 「视频标签」 line for a video in a chosen folder, and the UP line is its own.
    let hooked = 0;
    t.MoonTriage.setViewerHook(() => hooked++);
    t.S.mediaId = "K";
    t.S.itemMap.get("BV710").upper = "甲";
    play("BV710");
    assert.ok(!t.el.viewerTags.hidden && hooked === 1);
    assert.deepStrictEqual(plain(t.MoonTriage.viewingUp()), { mid: "", name: "甲" }, "an item saved before mids");
    t.S.itemMap.get("BV710").upperMid = "42";
    assert.deepStrictEqual(plain(t.MoonTriage.viewingUp()), { mid: "42", name: "甲" });
    t.document.body = { classList: { contains: (c) => c === "follow-mode" } };
    t.renderViewerTags();
    assert.ok(!t.el.viewerTags.hidden && /视频标签/.test(t.el.viewerTags.innerHTML) && hooked === 2 && t.MoonTriage.viewingUp() === null);
    delete t.document.body;
    t.MoonTriage.setViewerHook(null);
    t.S.viewing = "";
    t.S.viewer = null;
  }
  // F3: the viewer keeps its video's folder across a folder switch: its tag line, T and the refresh on close. A 待播
  // video from a folder not open finds its folder in the cached lists.
  {
    const realEl = { viewerFrame: t.el.viewerFrame, viewer: t.el.viewer, main: t.el.main };
    Object.assign(t.el, { viewerFrame: {}, viewer: {}, main: { classList: { add() {}, remove() {} } } });
    const savedTags = t.S.tags;
    t.S.tags = [{ id: "ka", name: "甲标签", color: "#1", folder: "K" }, { id: "la", name: "乙标签", color: "#2", folder: "L" }];
    t.S.videoTags.BV880 = ["ka", "la"];
    openFake("K", [item(880)]);
    t.openViewer(item(880));
    openFake("L", [item(881)]);
    t.renderViewerTags();
    assert.ok(t.el.viewerTags.innerHTML.includes(">甲标签<") && !t.el.viewerTags.innerHTML.includes("乙标签"), t.el.viewerTags.innerHTML);
    po = null;
    vm.runInContext("tagPlaying()", ctx);
    assert.deepStrictEqual([plain(po?.targets), plain(po?.tags().map((x) => x.id))], [["BV880"], ["ka"]], "T tags it in K");
    const synced = sent.length;
    t.closeViewer();
    assert.ok(!sent.slice(synced).some((m) => m.type === "triage-folder-ids"), "closing does not refresh L");
    store[t.K.snapshot("K")] = { items: [item(880)] };
    const savedFolders = t.S.folders;
    t.S.folders = [{ id: "K" }, { id: "L" }];
    t.openViewer({ bvid: "BV880", title: "视频880" });
    for (let i = 0; i < 20 && !t.S.viewer; i++) await new Promise((r) => setImmediate(r));
    assert.deepStrictEqual(plain(t.S.viewer.folders), ["K"], "from 待播: K's cached list holds it");
    t.closeViewer();
    Object.assign(t.el, realEl);
    Object.assign(t.S, { tags: savedTags, folders: savedFolders });
    delete t.S.videoTags.BV880;
    delete store[t.K.snapshot("K")];
  }
  // 批量打 确认页 sums the changes per tag; applying records 「AI 刚打的」, which ends four ways.
  openFake("K", [item(700), item(701), item(702)]);
  Object.assign(t.S, { tags: [{ id: "ga", name: "A", color: "#1", folder: "K" }, { id: "gb", name: "B", color: "#2", folder: "K" }], videoTags: { BV702: ["ga"] }, aiRecent: {} });
  const gp = { newTags: [{ key: "C", name: "C", checked: true }], notes: [], errors: [], rows: [
    { id: "BV700", add: ["id:ga"], remove: [] },
    { id: "BV701", add: ["id:ga", "id:gb"], remove: [] },
    { id: "BV702", add: ["new:C"], remove: ["ga"] }] };
  // What tag-dialogs.js's review computes from the adapter: the changes 应用 would make, summed per tag.
  const preview = (p) => {
    const a = vm.runInContext("aiTags", ctx);
    const U = ctx.TriageUi;
    const changes = U.aiChanges(p, a.map(), a.live(), (key) => U.previewId(p, key, a.tags()));
    return { changes, tally: U.aiTally(p, changes, a.tagName).map((x) => `${x.text} ${x.n}`) };
  };
  assert.deepStrictEqual(plain(preview(gp).tally), ["+ A 2", "+ B 1", "+ C 1", "− A 1"]);
  t.S.ai.proposal = gp;
  await applyAi();
  assert.deepStrictEqual([plain(t.S.aiRecent.K.bvids), t.S.aiRecentFilter], [["BV700", "BV701", "BV702"], true], "applying shows the batch");
  t.S.videoTags = { ...t.S.videoTags, BV701: ["gb"] }; // an edit made after the batch
  vm.runInContext("__realAsk = askConfirm; __asked = 0; __answer = false; askConfirm = async () => (__asked++, __answer)", ctx);
  await t.undo();
  assert.ok(vm.runInContext("__asked", ctx) === 1 && t.S.aiRecent.K, "U on a batch asks first; 取消 keeps it");
  vm.runInContext("__answer = true", ctx);
  await t.undo();
  vm.runInContext("askConfirm = __realAsk", ctx);
  assert.ok(!t.S.aiRecent.K && !t.S.aiRecentFilter, "U ends the batch");
  assert.deepStrictEqual(plain([t.S.videoTags.BV700, t.S.videoTags.BV701, t.S.videoTags.BV702]), [null, null, ["ga"]], "U puts every video of the batch back, later edits included");
  assert.ok(!t.S.tags.some((x) => x.name === "C"), "a tag the batch created and nothing uses any more goes");
  t.S.aiRecent.K = { at: 1, bvids: ["BV701"] };
  t.S.aiRecentFilter = true;
  vm.runInContext("endAiRecent", ctx)();
  assert.ok(!t.S.aiRecent.K && !t.S.aiRecentFilter, "× ends it");
  Object.assign(t.S, { tags: t.S.tags.filter((x) => x.folder !== "K" || !/^g[ab]$|^C$/.test(x.name === "C" ? "C" : x.id)), videoTags: {}, aiRecent: {} });

  // A batch counts only the videos whose tags change: not a cleared new-tag name, a tag the user added since, or a
  // new tag unticked on the review page.
  openFake("K", [item(720), item(721), item(722), item(723)]);
  Object.assign(t.S, { tags: [{ id: "na", name: "A", color: "#1", folder: "K" }, { id: "nb", name: "B", color: "#2", folder: "K" }], videoTags: { BV721: ["na"], BV722: ["nb"] }, aiRecent: {} });
  t.S.ai.proposal = { newTags: [{ key: "E", name: "  ", checked: true }, { key: "F", name: "F", checked: true }], notes: [], errors: [], rows: [
    { id: "BV720", add: ["new:E"], remove: [] },
    { id: "BV721", add: ["id:na"], remove: [] },
    { id: "BV722", add: ["id:na"], remove: [] },
    { id: "BV723", add: ["new:F"], remove: [] }] };
  assert.strictEqual(preview(t.S.ai.proposal).changes.length, 2, "no-op rows are not counted");
  assert.deepStrictEqual(plain(preview(t.S.ai.proposal).tally), ["+ A 1", "+ F 1"], "no entry for a cleared name");
  t.S.ai.proposal.newTags[1].checked = false;
  toasts.length = 0;
  await applyAi();
  const batchA = t.S.undo.at(-1);
  assert.deepStrictEqual(plain([t.S.aiRecent.K.bvids, batchA.tags, batchA.ask]), [["BV722"], true, null], "only BV722 changed: one video, so U does not ask");
  assert.ok(toasts.some((x) => x.includes("1 个视频")), toasts.join());
  // Nothing to change: no undo step.
  t.S.ai.proposal = { newTags: [], notes: [], errors: [], rows: [{ id: "BV721", add: ["id:na"], remove: [] }] };
  await applyAi();
  assert.strictEqual(t.S.undo.at(-1), batchA, "a batch that changed nothing pushes no undo");
  // Another tab ran batch B and deleted tag nb since: U on A keeps B's 「AI 刚打的」 and does not bring the deleted tag back.
  t.S.aiRecent.K = { at: t.S.aiRecent.K.at + 1, bvids: ["BV723"] };
  t.S.tags = t.S.tags.filter((x) => x.id !== "nb");
  await t.undo();
  assert.deepStrictEqual(plain(t.S.aiRecent.K.bvids), ["BV723"], "undoing A leaves the newer batch B");
  assert.strictEqual(t.S.videoTags.BV722, undefined, "a tag deleted since is not written back");
  Object.assign(t.S, { tags: [], videoTags: {}, aiRecent: {}, aiRecentFilter: false });
  openFake("K", [item(600), item(601)]);

  // A step that changed several videos asks before U undoes it; declined, it stays; one video never asks.
  {
    openFake("K", [item(730), item(731)]);
    const saved = t.askConfirm;
    let asked = [];
    let yes = false;
    t.askConfirm = async (title) => (asked.push(title), yes);
    t.S.undo = [];
    vm.runInContext("batchKeep", ctx)([t.S.itemMap.get("BV730"), t.S.itemMap.get("BV731")]);
    await t.undo();
    assert.deepStrictEqual([asked, t.S.undo.length, t.S.decisions.BV730?.action], [["撤销批量保留？"], 1, "keep"], "declined: the step stays");
    yes = true;
    await t.undo();
    assert.deepStrictEqual([asked.length, t.S.undo.length, t.S.decisions.BV730, toasts.at(-1)], [2, 0, undefined, "已撤销：批量保留 2 个"]);
    vm.runInContext("batchKeep", ctx)([t.S.itemMap.get("BV730")]);
    await t.undo();
    assert.ok(asked.length === 2 && toasts.at(-1).startsWith("已撤销：保留《"), "one video: no question");
    t.askConfirm = saved;
  }

  // A card's tag chip takes that tag off the video in one click, and U puts it back.
  openFake("K", [item(710)]);
  Object.assign(t.S, { tags: [{ id: "ua", name: "A", color: "#1", folder: "K" }, { id: "ub", name: "B", color: "#2", folder: "K" }], videoTags: { BV710: ["ua", "ub"] } });
  await tagStore().untag("BV710", "ua");
  assert.deepStrictEqual(plain(t.S.videoTags.BV710), ["ub"]);
  await t.undo();
  assert.deepStrictEqual(plain(t.S.videoTags.BV710), ["ua", "ub"]);
  // J18: U names the tag, as 关注 and 摘读记录 do (TriageUi.untagStep).
  assert.strictEqual(toasts.at(-1), "已撤销：去掉「A」");
  Object.assign(t.S, { tags: t.S.tags.filter((x) => !/^u[ab]$/.test(x.id)), videoTags: {} });
  openFake("K", [item(600), item(601)]);

  // U after 批量打 restores the tags and video tags.
  const beforeApply = plain([t.S.tags, t.S.videoTags]);
  t.S.ai.proposal = { newTags: [{ key: "z", name: "z", checked: true }], rows: [{ id: "BV600", add: ["new:z"], remove: [] }], notes: [], errors: [] };
  await applyAi();
  const z = t.S.tags.find((x) => x.name === "z" && x.folder === "K");
  assert.ok(z && t.S.videoTags.BV600.includes(z.id));
  await t.undo();
  assert.deepStrictEqual(plain([t.S.tags, t.S.videoTags]), beforeApply);
  t.S.tags = t.S.tags.filter((x) => x.folder !== "K" || x.id === "a");
  assert.strictEqual(room(), 5, "at most 5 even with 9 left");

  // 所有收藏夹: same-name tags of the chosen folders merge into one chip that filters across folders;
  // 管理 and 批量打 ask for a folder; the picker offers only the video's folders' tags.
  openFake("all", [{ ...item(1), folders: ["A"] }, { ...item(2), folders: ["B"] }, { ...item(3), folders: ["A", "B"] }]);
  Object.assign(t.S, {
    folders: [{ id: "A", title: "甲" }, { id: "B", title: "乙" }],
    tags: [{ id: "xa", name: "x", color: "#1", folder: "A" }, { id: "xb", name: "x", color: "#2", folder: "B" }, { id: "yb", name: "y", color: "#3", folder: "B" }, { id: "zc", name: "z", color: "#4", folder: "C" }],
    videoTags: { BV1: ["xa"], BV2: ["xb", "yb"] },
    tagFilter: new Set(),
    query: ""
  });
  t.renderTabs();
  assert.ok(t.el.tagFilter.innerHTML.includes('data-tagfilter="xa,xb"') && t.el.tagFilter.innerHTML.includes('data-tagfilter="yb"') && !t.el.tagFilter.innerHTML.includes("zc"));
  // A tag no video on this tab carries stays out of the row, unless its filter is on (so it can be turned off).
  t.S.tags.push({ id: "wa", name: "w", color: "#5", folder: "A" });
  t.renderTabs();
  assert.ok(!t.el.tagFilter.innerHTML.includes('data-tagfilter="wa"'), "an unused tag is not shown");
  t.S.tagFilter = new Set(["wa"]);
  t.renderTabs();
  assert.ok(t.el.tagFilter.innerHTML.includes('data-tagfilter="wa"'), "an unused tag with its filter on is shown");
  t.S.tags.pop();
  t.S.tagFilter = new Set(t.tagChips()[0].ids);
  assert.deepStrictEqual(plain(t.S.items.filter((it) => t.passFilter(it)).map((it) => it.bvid)), ["BV1", "BV2"], "the merged chip matches either folder's tag");
  t.S.tagFilter = new Set();
  t.S.query = "y";
  assert.deepStrictEqual(plain(t.S.items.filter((it) => t.passFilter(it)).map((it) => it.bvid)), ["BV2"], "search by tag name");
  t.S.query = "";
  assert.strictEqual((await createTag("新")), null, "no new tag outside a folder");
  assert.ok(manageTags.reason().includes("先打开一个具体收藏夹") && !manageTags.tags().length);
  // 重复收藏 (所有收藏夹 only, right after 全部): videos in more than one chosen folder; gone at 0 and outside 所有收藏夹.
  {
    const isDup = vm.runInContext("isDup", ctx);
    assert.deepStrictEqual(plain(t.S.items.map(isDup)), [false, false, true]);
    assert.ok(!isDup(item(9)), "a folder's items have no .folders");
    Object.assign(t.S, { tab: "none", loadAll: { lists: {}, check: [], checkTotal: 0, queue: [], paused: false, running: false, error: "", partial: 0 } });
    const r3 = row3();
    assert.ok(r3.includes('全部 3</button></span><span class="seg" role="group" aria-label="重复收藏">') && r3.includes(">重复收藏 1<"), r3);
    t.pickState("dup");
    assert.deepStrictEqual(plain(t.visibleItems().map((it) => it.bvid)), ["BV3"]);
    t.pickState("all");
    assert.strictEqual(t.S.dupFilter, false, "全部 clears it");
    const saved = t.S.items;
    t.S.items = saved.filter((it) => !isDup(it));
    assert.ok(!row3().includes("重复收藏"), "none: no chip");
    t.S.items = saved;
    t.S.mediaId = "A";
    assert.ok(!row3().includes("重复收藏"), "not in a single folder");
    Object.assign(t.S, { mediaId: "all", loadAll: null });
  }
  // AI 打标签 runs in 所有收藏夹: one chip per name (off = that name in every folder); one part per folder with its own tags
  // and new-tag room, a video in two folders in both; same-name new tags stay apart and go into their own folder.
  {
    assert.strictEqual(aiTags.blocked(), "");
    assert.deepStrictEqual(plain(aiTags.tags().map((x) => x.id)), ["xa", "yb"]);
    Object.assign(t.S, { tab: "none", titleRes: {}, analyses: {}, undo: [], allFolders: t.S.folders });
    Object.assign(t.S.settings, { triageAiBatchSize: 1, triageIntervalSec: 0, triageAiNewTagMax: 5 });
    t.S.ai.excluded.add("xa");
    assert.ok(aiTags.scopeText("filter").includes("按收藏夹分开打") && aiTags.scopeText("filter").endsWith("2 个收藏夹共 4 批发送"), aiTags.scopeText("filter"));
    const reqs = [];
    const lines = [];
    const savedProgress = t.TagDialogs.ai.progress;
    t.TagDialogs.ai.progress = (_, text) => lines.push(text);
    handlers["triage-ai-command"] = (m) => {
      reqs.push([m.items[0].bvid, plain(m.tags), m.items[0].currentTags || []]);
      return { ok: true, data: { newTags: ["新"], assignments: { [m.items[0].bvid]: { add: ["新"] } } } };
    };
    await t.runAiCommand({ instruction: "分", scope: "filter", allowRemove: false });
    t.TagDialogs.ai.progress = savedProgress;
    t.S.ai.excluded.clear();
    assert.deepStrictEqual(reqs, [["BV1", [], []], ["BV3", [], []], ["BV2", [{ name: "y", rule: "" }], ["y"]], ["BV3", [{ name: "y", rule: "" }], []]]);
    assert.ok(lines.includes("AI 正在处理「乙」第 2/2 批…"), lines.join("|"));
    const prop = t.S.ai.proposals.all;
    assert.deepStrictEqual(plain(prop.newTags), [{ key: "A/新", name: "新", checked: true, folder: "A", where: "甲" }, { key: "B/新", name: "新", checked: true, folder: "B", where: "乙" }]);
    assert.strictEqual(t.S.ai.proposal, prop, "kept under 所有收藏夹");
    await applyAi();
    const made = t.S.tags.filter((x) => x.name === "新");
    assert.deepStrictEqual(plain(made.map((x) => x.folder)), ["A", "B"]);
    assert.deepStrictEqual(plain(t.S.videoTags.BV3.map((id) => t.S.tags.find((x) => x.id === id).folder)), ["A", "B"], "a video in two folders is tagged in both");
    t.undo();
    await new Promise((r) => setTimeout(r, 0));
    assert.ok(!t.S.tags.some((x) => x.name === "新"), "one undo step");
  }
  const pickNames = (b, q = "") => (t.openPicker(b), plain(t.TagPicker.rowsOf(po.tags(), q, po.canCreate).map((o) => (o.create ? `+${o.create}` : o.tag.id))));
  assert.deepStrictEqual(pickNames("BV1"), ["xa"]);
  assert.deepStrictEqual(pickNames("BV3"), ["xa", "xb", "yb"]);
  assert.deepStrictEqual(pickNames("BV1", "w"), ["+w"], "one folder: a new name can be created there");
  assert.deepStrictEqual(pickNames("BV3", "w"), [], "two folders: no new tag");
  // F15: a tag stays in its folder when the video moves. BV1 is only in 甲 now: 乙's y shows nowhere, finds nothing,
  // and the picker in 甲 keeps it when saving.
  t.S.videoTags.BV1 = ["xa", "yb"];
  assert.deepStrictEqual(plain(t.tagIdsOf("BV1")), ["xa"], "所有收藏夹: the video's folders' tags");
  t.S.query = "y";
  assert.deepStrictEqual(plain(t.S.items.filter((it) => t.passFilter(it)).map((it) => it.bvid)), ["BV2"], "another folder's tag name finds nothing");
  t.S.query = "";
  openFake("A", [item(1)]);
  assert.deepStrictEqual(plain(t.tagIdsOf("BV1")), ["xa"], "a folder: its own tags");
  t.S.mediaId = "removed";
  assert.deepStrictEqual(plain(t.tagIdsOf("BV1")), ["xa", "yb"], "已取消收藏: every tag");
  // 已出分拣范围 filters by AI class and tags like 阅览.
  {
    const saved = { items: t.S.items, tab: t.S.tab, titleRes: t.S.titleRes, classFilter: t.S.classFilter };
    Object.assign(t.S, { items: [item(1), item(2), item(3)], tab: "read", titleRes: { BV1: { verdict: "keep" }, BV2: { verdict: "drop" } }, classFilter: { coarse: "all", fine: "all", read: "all" } });
    const shown = () => plain(t.visibleItems().map((it) => it.bvid));
    t.renderListHeader(t.visibleItems());
    for (const part of [">全部 3<", ">值得留 1<", ">可清理 1<", ">拿不准 0<"]) assert.ok(t.el.classFilter.innerHTML.includes(part), part);
    t.S.classFilter.read = "drop";
    assert.deepStrictEqual(shown(), ["BV2"], "已取消收藏: AI class chip");
    t.S.classFilter.read = "all";
    t.S.tagFilter.add("xa");
    assert.deepStrictEqual(shown(), ["BV1"], "已取消收藏: tag chip");
    t.S.tagFilter.clear();
    // F13: X selects here too (清理选中的 and 收藏到 act on the selection), as 关注's 已出分拣范围.
    t.S.selected.clear();
    t.S.focused = "BV1";
    const realList = t.el.list;
    t.el.list = { querySelectorAll: () => [], querySelector: () => null };
    t.onKey({ key: "x", target: {}, preventDefault() {} });
    // G3: O and Enter play here too (like a title click, and like 关注's); D and S still do nothing.
    const opened = [];
    const realOpen = t.openViewer;
    t.openViewer = (it) => opened.push(it.bvid);
    for (const k of ["o", "Enter", "d", "s"]) t.onKey({ key: k, target: {}, preventDefault() {} });
    t.openViewer = realOpen;
    assert.deepStrictEqual(opened, ["BV1", "BV1"], "O / Enter play in 已出分拣范围");
    t.el.list = realList;
    assert.deepStrictEqual([...t.S.selected], ["BV1"], "X in 已出分拣范围 selects");
    assert.ok((t.el.listHeader.innerHTML + t.el.favSel.innerHTML).includes("清理选中的 1 个"));
    // F9: everything selected hidden by a filter: the bar keeps its buttons, disabled with why, as 关注's.
    const hid = "选中的都被筛选隐藏了";
    const disabledWhy = (label) => new RegExp(`aria-label="${label}"[^>]*disabled title="${hid}"`).test((t.el.listHeader.innerHTML + t.el.favSel.innerHTML));
    t.S.classFilter.read = "drop";
    t.renderListHeader(t.visibleItems());
    // J14: with the true count, as row 3's.
    assert.ok(disabledWhy("收藏选中的 1 个到…"), (t.el.listHeader.innerHTML + t.el.favSel.innerHTML));
    // J2: 清理 stays the selection's, with its true count, off with why.
    assert.ok(disabledWhy("清理选中的 1 个") && !t.el.listHeader.innerHTML.includes("清理这"), t.el.listHeader.innerHTML);
    // F12 / F9: 所有收藏夹 has 全选 like a folder (across its folders), and its bar says why as well.
    t.S.mediaId = "all";
    const savedLoad = t.S.loadAll;
    t.S.loadAll = { queue: [], check: [], partial: 0 };
    t.S.tab = "fine";
    t.S.items = [item(1), item(2), item(3)];
    t.S.classFilter.fine = "drop";
    t.S.titleRes = {};
    t.S.analyses = { BV1: { status: "done", verdict: "keep" }, BV2: { status: "done", verdict: "drop" }, BV3: { status: "done", verdict: "drop" } };
    t.S.selected.clear();
    t.S.selected.add("BV1");
    t.renderListHeader(t.visibleItems());
    assert.ok((t.el.listHeader.innerHTML + t.el.favSel.innerHTML).includes('data-head="select-all" aria-checked="false"') && (t.el.listHeader.innerHTML + t.el.favSel.innerHTML).includes("全选 2 个"), "所有收藏夹 has 全选");
    for (const label of ["保留选中的 1 个", "取消收藏选中的 1 个"]) assert.ok(disabledWhy(label), label);
    vm.runInContext("UI.toggleAll(visibleItems().map((it) => it.bvid), S.selected)", ctx);
    assert.deepStrictEqual([...t.S.selected].sort(), ["BV1", "BV2", "BV3"], "全选 adds what is listed, keeps the hidden one");
    t.S.selected.clear();
    t.S.analyses = {};
    t.S.classFilter.fine = "all";
    t.S.mediaId = "removed";
    t.S.loadAll = savedLoad;
    Object.assign(t.S, saved);
  }
  t.S.mediaId = "A";
  await pickWith("BV1", (sets) => t.TagPicker.toggle(sets, "xa"));
  assert.deepStrictEqual(plain(t.S.videoTags.BV1), ["yb"], "unticking 甲's x keeps 乙's y");
  // A 批量打 proposal skips a video that left the folder since.
  t.S.ai.proposal = { newTags: [], rows: [{ id: "BV1", add: ["id:xa"], remove: [] }, { id: "BV2", add: ["id:xa"], remove: [] }], notes: [], errors: [] };
  await applyAi();
  assert.deepStrictEqual(plain([t.S.videoTags.BV1, t.S.videoTags.BV2]), [["yb", "xa"], ["xb", "yb"]]);
  Object.assign(t.S, { tags: [], videoTags: {}, folders: [] });
  openFake("K", [item(600), item(601)]);

  // 只处理细看过的: only videos with a done 细看 from the current filter results.
  Object.assign(t.S, { tab: "read", analyses: { BV600: { status: "done", oneLiner: "x" } }, titleRes: { BV601: { verdict: "drop", confidence: "high" } } });
  assert.deepStrictEqual(plain(t.aiScopeItems("analyzed").map((it) => it.bvid)), ["BV600"]);
  t.S.analyses = {};

  // F1 search: title, uploader, one-liner, points, note and tag names; case-insensitive; every word must match; combines with tags.
  openFake("Q", [{ ...item(1), title: "Claude Code 实战", upper: "老王" }, { ...item(2), title: "红烧肉" }, item(3)]);
  Object.assign(t.S, {
    analyses: { BV2: { status: "done", oneLiner: "家常做法", points: ["火候是关键"] } },
    notes: { BV3: { text: "周末试试 Agent" } },
    tags: [{ id: "f", name: "美食", color: "#1", folder: "Q" }],
    videoTags: { BV2: ["f"] },
    tagFilter: new Set()
  });
  const hits = (q) => ((t.S.query = q), t.S.items.filter((it) => t.passFilter(it)).map((it) => it.bvid));
  assert.deepStrictEqual(hits(""), ["BV1", "BV2", "BV3"]);
  assert.deepStrictEqual(hits("claude"), ["BV1"], "title, case-insensitive");
  assert.deepStrictEqual(hits("老王"), ["BV1"], "uploader");
  assert.deepStrictEqual(hits("火候"), ["BV2"], "points");
  assert.deepStrictEqual(hits("家常"), ["BV2"], "one-liner");
  assert.deepStrictEqual(hits("美食"), ["BV2"], "tag name");
  assert.deepStrictEqual(hits("agent"), ["BV3"], "note");
  assert.deepStrictEqual(hits(" claude  实战 "), ["BV1"], "all words match");
  assert.deepStrictEqual(hits("claude 红烧肉"), [], "a word that misses drops the video");
  t.S.tagFilter = new Set(["f"]);
  assert.deepStrictEqual(hits("claude"), [], "search and tag filter combine");
  Object.assign(t.S, { query: "", tagFilter: new Set(), analyses: {}, notes: {}, tags: [], videoTags: {} });

  // F2 所有收藏夹: one entry per video with every folder; an unfav drops that folder unless B's favorite time is newer.
  const merged = plain(t.mergeFolderItems([
    { id: "A", items: [item(1), item(2)], decisions: {} },
    { id: "B", items: [item(2), { ...item(3), favTime: 10 }, { ...item(4), favTime: 10 }, item(5)],
      decisions: { BV3: { action: "unfav", at: 20000 }, BV4: { action: "unfav", at: 5000 }, BV5: { action: "unfav", at: 1 } } }
  ]));
  assert.deepStrictEqual(merged.map((it) => [it.bvid, it.folders]), [["BV1", ["A"]], ["BV2", ["A", "B"]], ["BV4", ["B"]]], "BV3 favorited before its unfav (stale list); BV4 re-favorited since; BV5 has no favTime");

  // F2 取消收藏 in 所有收藏夹: only the picked folder is unfavorited and recorded; U re-favorites it there.
  const shared = { ...item(7), folders: ["A", "B"] };
  openFake("all", [shared]);
  t.S.folderDecisions = { A: {}, B: {} };
  t.S.folders = t.S.allFolders = [{ id: "A", title: "甲" }, { id: "B", title: "乙" }];
  const savedTags = { tags: t.S.tags, videoTags: t.S.videoTags };
  Object.assign(t.S, { tags: [{ id: "ta", name: "甲标", color: "#1", folder: "A" }, { id: "tb", name: "乙标", color: "#2", folder: "B" }], videoTags: { BV7: ["ta", "tb"] } });
  t.pickUnfavFolders = async () => ["B"];
  handlers["triage-unfav"] = () => ({ ok: true });
  await t.fav.unfav("BV7");
  assert.deepStrictEqual(plain(t.tagIdsOf("BV7")), ["ta", "tb"], "the folder it just left keeps its tags on the card");
  assert.deepStrictEqual(plain(sent.at(-1)), { type: "triage-unfav", mediaId: "B", aids: [1007] });
  assert.deepStrictEqual(plain(shared.folders), ["A"]);
  assert.strictEqual(store[t.K.decisions("B")].BV7.action, "unfav");
  assert.ok(!store[t.K.decisions("A")] && !t.S.decisions.BV7, "still in 甲, so not processed");
  assert.ok(!store[t.K.decisions("all")], "no decisions key for the merged view");
  await t.undo();
  assert.deepStrictEqual(plain(sent.at(-1)), { type: "triage-refav", mediaId: "B", aid: 1007 });
  assert.deepStrictEqual(plain(shared.folders), ["A", "B"]);
  assert.ok(!("BV7" in store[t.K.decisions("B")]));
  assert.deepStrictEqual(plain(shared.left), [], "undo clears the left folder");
  // A56: U that gets it back into 甲 but not 乙 shows it in 甲 and keeps 乙 for the next U.
  {
    t.pickUnfavFolders = async () => ["A", "B"];
    await t.fav.unfav("BV7");
    assert.deepStrictEqual([plain(shared.folders), t.S.decisions.BV7?.action], [[], "unfav"]);
    handlers["triage-refav"] = ({ mediaId }) => (mediaId === "B" ? { ok: false, error: "网络错误" } : { ok: true });
    await t.undo();
    assert.deepStrictEqual([plain(shared.folders), plain(shared.left), t.S.decisions.BV7, toasts.at(-1)], [["A"], ["B"], undefined, "撤销中断（可再按 U 重试）：网络错误"]);
    handlers["triage-refav"] = () => ({ ok: true });
    await t.undo();
    assert.deepStrictEqual([plain(shared.folders), plain(shared.left), plain(store[t.K.decisions("B")])], [["A", "B"], [], {}]);
  }
  // A 番剧 episode in 稍后再看 and two folders: 稍后再看's cached list may lack the mark, the folders' have it, and the merge keeps the
  // mark whichever comes first. Every place gets "aid:42" (the background sends 稍后再看 the bare aid); the records and
  // U keep it.
  {
    const ep = { bvid: "BVep", aid: "714816118", title: "番剧" };
    const [one] = plain(t.mergeFolderItems([{ id: "toview", items: [ep] }, { id: "A", items: [{ ...ep, ogv: true }] }, { id: "B", items: [{ ...ep, ogv: true }] }]));
    assert.deepStrictEqual([one.folders, one.ogv], [["toview", "A", "B"], true]);
    openFake("all", [one]);
    t.S.folderDecisions = { toview: {}, A: {}, B: {} };
    t.S.folders = t.S.allFolders = [{ id: "toview", title: "稍后再看" }, { id: "A", title: "甲" }, { id: "B", title: "乙" }];
    t.pickUnfavFolders = async () => ["toview", "A", "B"];
    const from = sent.length;
    await t.fav.unfav("BVep");
    assert.deepStrictEqual(plain(sent.slice(from).map((m) => [m.mediaId, m.aids])), [["toview", ["714816118:42"]], ["A", ["714816118:42"]], ["B", ["714816118:42"]]]);
    assert.strictEqual(store[t.K.decisions("A")].BVep.ogv, true);
    await t.undo();
    assert.deepStrictEqual(plain(sent.slice(from + 3).map((m) => [m.type, m.mediaId, m.aid])), ["toview", "A", "B"].map((f) => ["triage-refav", f, "714816118:42"]));
    // A video's are unchanged: its bare aid everywhere.
    assert.strictEqual(vm.runInContext("favRes", ctx)(item(7)), 1007);
  }
  Object.assign(t.S, savedTags);

  // A 保留 made in one folder shows in another; folder records keep only 取消收藏; U removes it everywhere.
  for (const k of Object.keys(store)) delete store[k];
  t.S.kept = {};
  openFake("A", [item(1)]);
  await t.keepOne("BV1");
  assert.deepStrictEqual(Object.keys(store[t.K.kept]), ["BV1"]);
  assert.ok(!store[t.K.decisions("A")], "保留 writes no folder record");
  t.S.decisions = { ...t.S.kept, ...store[t.K.decisions("B")] };
  assert.strictEqual(t.stageOf(item(1)), "done", "kept in A is kept in B");
  await t.undo();
  assert.deepStrictEqual(plain(store[t.K.kept]), {});
  // Unfavoriting a kept video in a folder keeps the 保留 for other folders; U restores the folder view.
  openFake("A", [item(1)]);
  await t.keepOne("BV1");
  handlers["triage-unfav"] = () => ({ ok: true });
  handlers["triage-refav"] = () => ({ ok: true });
  await t.fav.unfav("BV1");
  assert.deepStrictEqual(Object.keys(store[t.K.decisions("A")]), ["BV1"]);
  assert.ok(store[t.K.kept].BV1);
  await t.undo();
  assert.deepStrictEqual(plain(store[t.K.decisions("A")]), {});
  assert.strictEqual(t.S.decisions.BV1.action, "keep");

  // T1/D2: D moves the focus on as it sends, as 保留 does; B站's answer (yes or no) leaves the focus where it is by then,
  // and the record waits for the yes.
  {
    const realFocus = t.setFocus;
    const was = { focused: t.S.focused, tab: t.S.tab, kept: t.S.kept, decisions: t.S.decisions, items: t.S.items, itemMap: t.S.itemMap };
    t.setFocus = (b) => (t.S.focused = b);
    for (const ok of [true, false]) {
      openFake("A", [item(1), item(2), item(3)]);
      Object.assign(t.S, { tab: "none", focused: "BV1", kept: {} });
      delete store[t.K.decisions("A")];
      let answer;
      handlers["triage-unfav"] = () => new Promise((res) => (answer = res));
      const done = t.fav.unfav("BV1");
      await new Promise(setImmediate);
      assert.deepStrictEqual([t.S.focused, t.fav.state().pending("BV1"), t.S.decisions.BV1], ["BV2", "取消收藏", undefined], "focus first, data later");
      t.S.focused = "BV3"; // J/K meanwhile
      answer(ok ? { ok: true } : { ok: false, error: "网络错误" });
      await done;
      assert.deepStrictEqual([t.S.focused, t.S.decisions.BV1?.action], ["BV3", ok ? "unfav" : undefined], ok ? "a yes does not pull the focus back" : "a no only says so");
      if (!ok) assert.strictEqual(toasts.at(-1), "取消收藏失败：网络错误");
    }
    handlers["triage-unfav"] = () => ({ ok: true });
    t.setFocus = realFocus;
    Object.assign(t.S, was);
  }

  // 已出分拣范围: a video that left every folder is recorded with where it had been; one still in another folder only gets
  // this folder on its trail; one listed again is dropped from the record and this folder from its trail.
  {
    const A = { id: "A", title: "甲" };
    const B = { id: "B", title: "乙" };
    const rec = t.updateRemoved({ BV9: { item: item(9), at: 1 } }, { BV1: { A: { title: "甲", at: 2 } } }, [item(1), item(2), item(3)], [item(1), item(9)], new Set(["BV3"]), 5, null, A);
    assert.deepStrictEqual(plain(rec), { removed: { BV2: { item: item(2), at: 5, from: [{ id: "A", title: "甲", at: 5 }] } }, left: { BV3: { A: { title: "甲", at: 5 } } } }, "BV3 is in another folder (trail), BV9 came back, BV1 listed again clears its trail");
    // Left A first (still in B), then B: the record names both, oldest first, and the trail is gone.
    const one = t.updateRemoved({}, {}, [item(1)], [], new Set(["BV1"]), 2, null, A);
    assert.deepStrictEqual(plain(one), { removed: {}, left: { BV1: { A: { title: "甲", at: 2 } } } });
    const both = t.updateRemoved(one.removed, one.left, [item(1)], [], new Set(), 7, null, B);
    assert.deepStrictEqual(plain(both), { removed: { BV1: { item: item(1), at: 7, from: [{ id: "A", title: "甲", at: 2 }, { id: "B", title: "乙", at: 7 }] } }, left: {} });
    // Back in A before leaving B: A leaves the trail, so leaving B later names B alone.
    const back = t.updateRemoved(one.removed, one.left, [], [item(1)], new Set(["BV1"]), 3, null, A);
    assert.deepStrictEqual(plain(back), { removed: {}, left: {} });
    assert.deepStrictEqual(plain(t.updateRemoved(back.removed, back.left, [item(1)], [], new Set(), 8, null, B).removed.BV1.from), [{ id: "B", title: "乙", at: 8 }]);
    // A hidden (still in the id list) video is marked so, with its origin.
    assert.deepStrictEqual(plain(t.updateRemoved({}, {}, [item(4)], [], new Set(), 9, ["BV4"], A).removed), { BV4: { item: item(4), at: 9, from: [{ id: "A", title: "甲", at: 9 }], hidden: true } });
    // It leaves the id list later (unfavorited): no longer marked hidden; an id list not read changes nothing.
    const hid = t.updateRemoved({}, {}, [item(4)], [], new Set(), 9, ["BV4"], A).removed;
    assert.strictEqual(t.updateRemoved(hid, {}, [], [], new Set(), 10, [], A).removed.BV4.hidden, undefined);
    assert.strictEqual(t.updateRemoved(hid, {}, [], [], new Set(), 10, null, A).removed.BV4.hidden, true);
    assert.strictEqual(t.mdLinkText("a\\b[c]"), "a\\\\b\\[c\\]", "a backslash is escaped too");
    // Moved out of triage: the source folder is the origin (after its trail); from 已出分拣范围 itself the origin is kept.
    const moved = t.moveToRemoved({}, { BV1: { A: { title: "甲", at: 2 } } }, [item(1), item(3)], new Set(["BV3"]), B, 7, { id: "Z", title: "外" });
    assert.deepStrictEqual(plain(moved), { removed: { BV1: { item: item(1), at: 7, movedTo: { id: "Z", title: "外" }, from: [{ id: "A", title: "甲", at: 2 }, { id: "B", title: "乙", at: 7 }] } }, left: {} });
    const again = t.moveToRemoved(moved.removed, {}, [item(1)], new Set(), null, 8, { id: "Y", title: "另" });
    assert.deepStrictEqual(plain(again.removed.BV1), { item: item(1), at: 8, movedTo: { id: "Y", title: "另" }, from: plain(moved.removed.BV1.from) });
    assert.deepStrictEqual(plain(t.moveToRemoved({}, {}, [item(1)], new Set(), null, 8, { id: "Y", title: "另" }).removed.BV1), { item: item(1), at: 8, movedTo: { id: "Y", title: "另" } }, "an old record without an origin stays without one");
  }

  // 所有收藏夹 keeps a cached list only while the folder's video ids match it as a set.
  assert.strictEqual(t.idsChanged(["BV1", "BV2"], ["BV2", "BV1"]), false, "order does not matter");
  assert.strictEqual(t.idsChanged(["BV1", "BV2"], ["BV1", "BV3"]), true, "add + remove with the same count");
  assert.strictEqual(t.idsChanged(["BV1"], ["BV1", "BV2"]), true);
  assert.strictEqual(t.idsChanged(["BV1", "BV2"], ["BV1"]), true);
  assert.strictEqual(t.idsChanged([], []), false);

  // saveSnapshot records against the other folders' snapshots and keeps the id list the next check compares with.
  for (const k of Object.keys(store)) delete store[k];
  t.S.folders = t.S.allFolders = [{ id: "A", count: 1 }, { id: "B", count: 1 }];
  store[t.K.snapshot("A")] = { bvids: ["BV1", "BV2"], items: [item(1), item(2)] };
  store[t.K.snapshot("B")] = { bvids: ["BV2"], items: [item(2)] };
  await t.saveSnapshot("A", [], ["BVhidden"]);
  assert.deepStrictEqual(Object.keys(store[t.K.removed]), ["BV1"]);
  assert.deepStrictEqual(plain(store[t.K.snapshot("A")].ids), ["BVhidden"], "an id the paged list leaves out stays in the check baseline");
  assert.strictEqual(t.S.removedCount, 1);

  // 已出分拣范围 renders the normal card: a line under the title with the origin chip and when / why it left, the select box and 清理, no 保留 / 取消收藏.
  {
    openFake("removed", []);
    const at = new Date(new Date().getFullYear(), 9, 5, 17, 25).getTime();
    const html = t.cardHtml({ ...item(1), removedAt: at, from: [{ id: "A", title: "甲", at: 1 }, { id: "B", title: "乙", at: 3 }, { id: "C", title: "丙", at: 5 }] }, true, "");
    assert.ok(html.includes('class="danger" data-clean="BV1"') && !html.includes('data-act="keep"') && !html.includes('data-act="unfav"'), html);
    assert.ok(html.includes('data-act="basket"') && html.includes('data-act="ask"') && !html.includes('data-act="tag"'), "已出分拣范围 keeps 待播 and 问 AI, not 标签");
    // 保留 shows here too, and the table carries the note, origin and why it left (not 待播).
    t.S.decisions = { BV1: { action: "keep", at } };
    assert.ok(t.cardHtml({ ...item(1), removedAt: at }, true, "").includes(">已保留<"));
    const savedNotes = t.S.notes, savedBasket = t.S.basket;
    Object.assign(t.S, { notes: { BV1: { text: " 我的话 " } }, basket: [{ bvid: "BV1" }] });
    t.S.items = [{ ...item(1), removedAt: at, from: [{ id: "A", title: "甲", at: 1 }], inFolder: null }];
    const [head, row] = t.buildCsv().replace(/^\uFEFF/, "").split("\r\n");
    const col = (name) => row.split(",")[head.split(",").indexOf(name)];
    assert.deepStrictEqual([col("备注"), col("我的处理"), col("原在"), col("离开原因")], ["我的话", "保留", "甲", "10月5日 17:25 已取消收藏"]);
    assert.ok(!head.includes("待播"));
    t.S.items = [{ ...item(1), cover: "https://i0.hdslb.com/c.jpg", pubdate: 1759622400, favTime: 1759708800, intro: "简介文字" }];
    const [, row2] = t.buildCsv().replace(/^\uFEFF/, "").split("\r\n");
    const col2 = (name) => row2.split(",")[head.split(",").indexOf(name)];
    assert.deepStrictEqual([col2("封面"), col2("发布时间"), col2("收藏时间"), col2("简介")], ["https://i0.hdslb.com/c.jpg", "2025-10-05", "2025-10-06", "简介文字"]);
    Object.assign(t.S, { notes: savedNotes, basket: savedBasket, decisions: {}, items: [] });
    assert.ok(html.includes('<div class="left-row"><span class="origin-chip" title="原在「甲」「乙」「丙」">原在「甲」「乙」等 3 个</span><span>10月5日 17:25 离开收藏夹</span></div>'), html);
    assert.ok(!/class="meta">[^<]*(离开收藏夹|原在)/.test(html), "the gray meta line does not repeat the leaving line");
    assert.ok(t.cardHtml({ ...item(2), removedAt: at, from: [{ id: "A", title: "甲", at: 5 }] }, true, "").includes(">原在「甲」<"));
    const hidden = t.cardHtml({ ...item(3), removedAt: new Date(2020, 9, 2).getTime(), hidden: true }, true, "");
    assert.ok(!hidden.includes("原在") && hidden.includes('<div class="left-row"><span>2020年10月2日 已失效（B站已隐藏）</span></div>'), "a record without an origin shows no chip; another year shows the year and no time");
    assert.ok(t.cardHtml({ ...item(4), removedAt: at, movedTo: { id: "Z", title: "外" } }, true, "").includes("10月5日 17:25 移到「外」（未勾选）"));
    assert.ok(t.leftText({ ...item(6), removedAt: Date.now(), inFolder: null }).startsWith("今天 "), "the day text 刷新过 uses: 今天 / 昨天");
    // Once looked up, where the video is now wins over where a 移动 sent it.
    const leftOf = (extra) => t.leftText({ ...item(5), removedAt: at, ...extra }).slice(12);
    assert.strictEqual(leftOf({ inFolder: { id: "Y", title: "别处" } }), "在「别处」（未勾选）");
    assert.strictEqual(leftOf({ movedTo: { id: "Z", title: "外" }, inFolder: { id: "Z", title: "外" } }), "移到「外」（未勾选）");
    assert.strictEqual(leftOf({ movedTo: { id: "Z", title: "外" }, inFolder: null }), "已取消收藏");
    assert.strictEqual(leftOf({ hidden: true, inFolder: null }), "已失效（B站已隐藏）");
    openFake("A", [item(1)]);
    assert.ok(t.cardHtml(item(1), false, "").includes('<span class="pair">\n            <button type="button" data-act="keep"'), "a folder's card keeps 保留 / 取消收藏 as the pair");
    // Selecting is a click on the card: no select box or 「选中 X」 action on it; a selected card carries .selected.
    const plainCard = t.cardHtml(item(1), false, "");
    assert.ok(!plainCard.includes("pick-box") && !plainCard.includes('data-act="select"') && !/>选中</.test(plainCard) && !/class="card[^"]* selected/.test(plainCard), plainCard);
    t.S.selected.add("BV1");
    assert.ok(/class="card[^"]* selected/.test(t.cardHtml(item(1), false, "")), "a selected card carries .selected");
    t.S.selected.clear();
    // Once decided, the decision replaces the AI verdict label; the reason stays.
    t.S.titleRes.BV1 = { verdict: "keep", reason: "好看" };
    assert.ok(t.cardHtml(item(1), false, "").includes("值得留"), "undecided shows the verdict");
    t.S.decisions.BV1 = { action: "keep" };
    const kept = t.cardHtml(item(1), false, "");
    assert.ok(!kept.includes("值得留") && kept.includes("好看") && kept.includes("已保留"), kept);
    delete t.S.decisions.BV1;
    delete t.S.titleRes.BV1;
  }

  // 处理完成 keeps what 细看 found: the one-liner and the points stay on the card.
  {
    const saved = { tab: t.S.tab, analyses: t.S.analyses };
    openFake("A", [item(1)], { BV1: { action: "keep" } });
    Object.assign(t.S, { tab: "done", analyses: { BV1: { status: "done", verdict: "keep", reason: "讲得清楚", oneLiner: "一句话", points: ["要点甲", "要点乙"] } } });
    t.renderList();
    for (const part of ["一句话", "要点甲", "要点乙", "讲得清楚", "已保留"]) assert.ok(t.el.list.innerHTML.includes(part), part);
    assert.ok(!t.el.list.innerHTML.includes("值得留"), "the decision replaces the verdict label");
    // 已取消收藏 keeps them too.
    openFake("removed", [item(1)]);
    t.S.tab = "read";
    t.renderList();
    for (const part of ["一句话", "要点甲"]) assert.ok(t.el.list.innerHTML.includes(part), `已取消收藏: ${part}`);
    Object.assign(t.S, saved);
    openFake("A", [item(1)]);
  }

  // 阅览: a decided video leaves the AI classes for 已保留, the same word its card shows.
  {
    const saved = { tab: t.S.tab, titleRes: t.S.titleRes, classFilter: t.S.classFilter };
    openFake("A", [item(1), item(2)], { BV1: { action: "keep" } });
    Object.assign(t.S, { tab: "read", titleRes: { BV1: { verdict: "keep" }, BV2: { verdict: "keep" } }, classFilter: { coarse: "all", fine: "all", read: "all" } });
    t.renderListHeader(t.visibleItems());
    for (const part of [">全部 2<", ">值得留 1<", ">已保留 1<"]) assert.ok(t.el.classFilter.innerHTML.includes(part), part);
    t.S.classFilter.read = "kept";
    assert.deepStrictEqual(plain(t.visibleItems().map((it) => it.bvid)), ["BV1"]);
    t.S.classFilter.read = "keep";
    assert.deepStrictEqual(plain(t.visibleItems().map((it) => it.bvid)), ["BV2"]);
    Object.assign(t.S, saved);
    openFake("A", [item(1)]);
  }

  // The 重新收藏 of the undo tests above marked A and B written a moment ago (markWritten); B站 has long caught up here.
  await settled();
  // Back to the tab, focus and visibilitychange both call quickSync: B站 is asked for the ids once.
  {
    const was = { mediaId: t.S.mediaId, lastSyncAt: t.S.lastSyncAt, snap: store[t.K.snapshot("A")], ids: handlers["triage-folder-ids"] };
    Object.assign(t.S, { mediaId: "A", lastSyncAt: 0 });
    store[t.K.snapshot("A")] = { ids: ["BV1"], items: [item(1)], intro: "" };
    handlers["triage-folder-ids"] = () => ({ ok: true, data: { bvids: ["BV1"] } });
    const from = sent.length;
    await Promise.all([t.quickSync(), t.quickSync()]);
    assert.strictEqual(sent.slice(from).filter((m) => m.type === "triage-folder-ids").length, 1, "one id check");
    Object.assign(t.S, { mediaId: was.mediaId, lastSyncAt: was.lastSyncAt });
    if (was.snap) store[t.K.snapshot("A")] = was.snap;
    else delete store[t.K.snapshot("A")];
    handlers["triage-folder-ids"] = was.ids;
  }
  // Cleaning a removed video deletes its AI results, note, tags, 保留, basket entry and 取消收藏 records, and nothing else.
  Object.assign(store, { triage_analysis_BV1: {}, triage_title_BV1: {}, triage_analysis_BV5: {} });
  Object.assign(store, { triage_decisions_A: { BV1: { action: "unfav" }, BV5: { action: "unfav" } }, triage_decisions_B: { BV1: { action: "unfav" } } });
  Object.assign(t.S, { notes: { BV1: { text: "n" }, BV5: { text: "m" } }, videoTags: { BV1: ["t"] }, kept: { BV1: { action: "keep" } }, basket: [{ bvid: "BV1" }, { bvid: "BV5" }] });
  store[t.K.notes] = structuredClone(t.S.notes);
  const marksBV1 = { tags: [{ id: "r1", name: "精读" }], items: { [t.MdgNote.readingKey({ site: "bilibili", videoId: "BV1" })]: { tags: ["r1"], star: true } } };
  store[t.MdgLimits.KEYS.readingMarks] = structuredClone(marksBV1);
  handlers["triage-folder-ids"] = () => ({ ok: true, data: { bvids: [] } });
  await t.openRemoved();
  assert.deepStrictEqual(plain(t.S.items.map((it) => it.bvid)), ["BV1"]);
  await t.cleanRemoved(t.S.items);
  assert.ok(!store.triage_analysis_BV1 && !store.triage_title_BV1 && store.triage_analysis_BV5);
  assert.deepStrictEqual(plain([Object.keys(store[t.K.notes]), store[t.K.videoTags], store[t.K.kept], store[t.K.removed]]), [["BV5"], {}, {}, {}]);
  assert.deepStrictEqual(plain(store[t.K.basket]), [{ bvid: "BV5" }]);
  assert.deepStrictEqual(plain([store.triage_decisions_A, store.triage_decisions_B]), [{ BV5: { action: "unfav" } }, {}], "cleaned videos leave 最近取消收藏");
  assert.deepStrictEqual(plain(store[t.MdgLimits.KEYS.readingMarks]), marksBV1, "J19: 摘读记录's 星标 and tags stay");

  // Opening 已出分拣范围 checks every folder's id list; a video found in one again leaves the list.
  store[t.K.removed] = { BV1: { item: item(1), at: 1 }, BV2: { item: item(2), at: 2 } };
  handlers["triage-folder-ids"] = ({ mediaId }) => ({ ok: true, data: { bvids: mediaId === "B" ? ["BV1"] : [] } });
  t.S.mediaId = "removed";
  await t.openRemoved();
  await until(() => !t.S.removedCheck);
  assert.strictEqual(t.S.removedCheck, null);
  assert.deepStrictEqual(Object.keys(store[t.K.removed]), ["BV2"]);
  assert.deepStrictEqual(plain(t.S.items.map((it) => it.bvid)), ["BV2"]);
  assert.strictEqual(t.S.removedCount, 1);

  // Then each video left is asked where it is: a folder not chosen makes it 在未勾选收藏夹, none 已取消收藏; one only in a
  // chosen folder, an invalid one and one without an aid stay unknown. The answers are kept on the records.
  {
    const rec = (n, extra) => ({ item: { ...item(n), aid: n * 10, ...extra }, at: n });
    const { aid: _, ...noAid } = item(5);
    store[t.K.removed] = { BV1: rec(1), BV2: rec(2), BV3: rec(3), BV4: rec(4, { invalid: true }), BV5: { item: noAid, at: 5 } };
    t.S.included = ["A", "B"];
    t.S.folderToken++; // earlier checks still running stop
    handlers["triage-folder-ids"] = () => ({ ok: true, data: { bvids: [] } });
    const asked = [];
    const mids = [];
    handlers["triage-fav-where"] = ({ aid, mid }) => {
      asked.push(aid);
      mids.push(mid);
      const folders = { 10: [{ id: "B", title: "乙" }, { id: "X", title: "外" }], 20: [], 30: [{ id: "A", title: "甲" }] }[aid];
      return { ok: true, data: { mid: 77, folders } };
    };
    await t.openRemoved();
    await until(() => !t.S.removedCheck);
    assert.deepStrictEqual(asked.sort(), [10, 20, 30]);
    assert.deepStrictEqual(mids, [undefined, 77, 77], "G6: who is logged in is asked once per check");
    assert.deepStrictEqual(plain(Object.fromEntries(Object.entries(store[t.K.removed]).map(([b, r]) => [b, r.inFolder]))), { BV1: { id: "X", title: "外" }, BV2: null }, "only answers are kept");
    assert.deepStrictEqual(plain(t.S.items.map((it) => [it.bvid, t.kindOf(it)]).sort()), [["BV1", "out"], ["BV2", "unfav"], ["BV3", ""], ["BV4", "invalid"], ["BV5", ""]]);
    t.S.tab = "read";
    t.renderTabs();
    const tabs = () => [...t.el.tabs.innerHTML.matchAll(/aria-label="([^"]+)"/g)].map((m) => m[1]);
    assert.deepStrictEqual(tabs(), ["全部 5", "已取消收藏 1", "在未勾选收藏夹 1", "已失效 1"], "why they left are the tabs here");
    assert.ok(!row3().includes("data-kindfilter"), "no 已失效 chip beside the tab");
    t.S.kindFilter = "out";
    assert.deepStrictEqual(plain(t.visibleItems().map((it) => it.bvid)), ["BV1"]);
    t.S.kindFilter = "";
    t.S.items = t.S.items.filter((it) => it.bvid === "BV2");
    t.renderTabs();
    assert.deepStrictEqual(tabs(), ["全部 1", "已取消收藏 1", "在未勾选收藏夹 0", "已失效 0"], "all show, even at 0");
    // A failed lookup stops there and says so; nothing found so far is lost.
    handlers["triage-fav-where"] = () => ({ ok: false, error: "offline" });
    await t.openRemoved();
    await until(() => t.S.removedCheck?.error);
    assert.ok(t.S.removedCheck.error.includes("offline"), t.S.removedCheck.error);
    assert.deepStrictEqual(plain(store[t.K.removed].BV1.inFolder), { id: "X", title: "外" });
    // F13: the check is in the pill; a B站 limit waits (amber countdown) and asks the same video again.
    let n = 0;
    const pills = [];
    handlers["triage-fav-where"] = () => (pills.push(t.activityState().text), ++n === 1 ? { ok: false, code: "THROTTLED", error: "412" } : { ok: true, data: { folders: [] } });
    const realStatus = t.renderStatus;
    t.renderStatus = () => {
      const a = t.activityState();
      if (a?.stuck && pills.at(-1) !== a.text) pills.push(a.text);
    };
    await t.openRemoved();
    await until(() => !t.S.removedCheck);
    t.renderStatus = realStatus;
    assert.deepStrictEqual(plain(pills), ["核对视频的收藏状态 0/3", "核对视频的收藏状态 0/3 · B站限流卡住，0:01 后重试", "核对视频的收藏状态 0/3", "核对视频的收藏状态 1/3", "核对视频的收藏状态 2/3"]);

    assert.strictEqual(t.S.removedCheck, null, "went on to the end, no red line");
    delete handlers["triage-fav-where"];
    t.S.removedCheck = null;
  }

  // Opt-in folders: a new user starts with none; someone who already triaged keeps every folder.
  for (const k of Object.keys(store)) delete store[k];
  t.S.allFolders = [{ id: 1 }, { id: 2 }, { id: 3 }];
  assert.deepStrictEqual(plain(await t.loadIncluded()), []);
  delete store[t.K.included];
  Object.assign(store, { triage_snapshot_1: { bvids: [] } });
  assert.deepStrictEqual(plain(await t.loadIncluded()), ["1", "2", "3"]);
  store[t.K.included] = ["3"];
  assert.deepStrictEqual(plain(await t.loadIncluded()), ["3"], "a saved choice is kept as is");

  // A folder deleted on Bilibili: its videos move to 已出分拣范围 unless still in a live folder; its records go.
  for (const k of Object.keys(store)) delete store[k];
  t.S.folders = t.S.allFolders = [{ id: 1 }];
  t.S.included = ["1"];
  Object.assign(store, {
    triage_snapshot_1: { bvids: ["BV2"], items: [item(2)] },
    triage_snapshot_9: { bvids: ["BV1", "BV2"], items: [item(1), item(2)] },
    triage_decisions_9: { BV1: { action: "unfav" } }
  });
  await t.retireUnchosenFolders();
  assert.deepStrictEqual(Object.keys(store[t.K.removed]), ["BV1"], "BV2 is still in folder 1");
  assert.ok(!store.triage_snapshot_9 && !store.triage_decisions_9 && store.triage_snapshot_1);
  t.S.folders = t.S.allFolders = [];
  store.triage_snapshot_8 = { bvids: ["BV3"], items: [item(3)] };
  await t.retireUnchosenFolders();
  assert.ok(store.triage_snapshot_8, "an empty folder list never retires anything");
  // A full storage: 保存失败 is shown, nothing rejects, and a list whose videos could not be recorded is kept.
  {
    const realSet = ctx.chrome.storage.local.set;
    ctx.chrome.storage.local.set = async () => { throw new Error("QUOTA_BYTES quota exceeded"); };
    t.S.folders = t.S.allFolders = [{ id: 1 }];
    t.S.removedCount = 0;
    await t.retireUnchosenFolders();
    assert.ok(store.triage_snapshot_8 && !store[t.K.removed]?.BV3, "retire: the old list stays");
    assert.ok(toasts.at(-1).startsWith("保存失败"), toasts.at(-1));
    await t.saveSnapshot("1", []);
    assert.strictEqual(t.S.removedCount, 0, "saveSnapshot: the count follows what was saved");
    ctx.chrome.storage.local.set = realSet;
    delete store.triage_snapshot_8;
  }

  // An unticked folder is retired like a deleted one, on the reload after the settings save; zero chosen retires nothing.
  for (const k of Object.keys(store)) delete store[k];
  Object.assign(store, {
    triage_included_folders: ["1", "2"],
    triage_snapshot_1: { bvids: ["BV1", "BV2"], items: [item(1), item(2)] },
    triage_snapshot_2: { bvids: ["BV2", "BV3"], items: [item(2), item(3)] },
    triage_decisions_2: { BV3: { action: "unfav" } }
  });
  handlers["triage-folders"] = () => ({ ok: true, data: { folders: [{ id: 1, count: 2 }, { id: 2, count: 2 }] } });
  handlers["triage-folder-ids"] = () => ({ ok: false, error: "offline" });
  store.triage_included_folders = [];
  await t.loadFolders();
  assert.ok(store.triage_snapshot_1 && store.triage_snapshot_2 && !store[t.K.removed], "zero chosen folders retires nothing");
  store.triage_included_folders = ["2"];
  await t.loadFolders();
  assert.deepStrictEqual(Object.keys(store[t.K.removed]), ["BV1"], "BV2 is still in chosen folder 2");
  assert.ok(!store.triage_snapshot_1 && store.triage_snapshot_2 && store.triage_decisions_2);
  // R12: 稍后再看 missing from the list because its read failed is not deleted: its videos and records stay.
  {
    const removedBefore = plain(store[t.K.removed]);
    Object.assign(store, { triage_included_folders: ["2", "toview"], triage_snapshot_toview: { bvids: ["BV5"], items: [item(5)] }, triage_decisions_toview: { BV6: { action: "unfav" } } });
    handlers["triage-folders"] = () => ({ ok: true, data: { folders: [{ id: 2, count: 2 }], toviewUnread: true } });
    await t.loadFolders();
    assert.ok(store.triage_snapshot_toview && store.triage_decisions_toview, "稍后再看 kept");
    assert.deepStrictEqual(plain(store[t.K.removed]), removedBefore, "nothing moved to 已出分拣范围");
    assert.deepStrictEqual([t.el.banner.hidden, t.el.banner.dataset.kind, t.el.bannerText.textContent], [false, "toview", "稍后再看这次没读到，点「重试」再读一次"], "the user is told and offered 重试");
    // The unread 稍后再看 still counts as a chosen folder everywhere: BV5 leaving folder 2 stays in it, not 已出分拣范围.
    const snap2 = store.triage_snapshot_2;
    store.triage_snapshot_2 = { bvids: ["BV2", "BV5"], items: [item(2), item(5)] };
    await t.saveSnapshot("2", [item(2)]);
    assert.deepStrictEqual(plain(store[t.K.removed]), removedBefore, "saveSnapshot: BV5 is still in 稍后再看");
    assert.ok(store[t.K.left].BV5?.["2"], "BV5 only gets folder 2 on its trail");
    await t.addMovedToRemoved("2", [item(5)], "T");
    assert.deepStrictEqual(plain(store[t.K.removed]), removedBefore, "移动: BV5 is still in 稍后再看");
    assert.strictEqual((await t.localItems("2")).get("BV5")?.from, "toview", "localItems finds BV5 in 稍后再看");
    store.triage_snapshot_2 = snap2;
    delete store[t.K.left].BV5;
    handlers["triage-folders"] = () => ({ ok: true, data: { folders: [{ id: 2, count: 2 }] } });
    store.triage_included_folders = ["2"];
    await t.loadFolders();
    assert.ok(!store.triage_snapshot_toview && "BV5" in store[t.K.removed], "a read 稍后再看 that is unticked retires as before");
    assert.ok(t.el.banner.hidden, "the next read that gets it clears the reminder");
    delete store[t.K.removed].BV5;
  }
  // saveSnapshot counts only chosen folders: BV3 left folder 2 and only an unchosen folder's stale list had it.
  store.triage_snapshot_9 = { bvids: ["BV3"], items: [item(3)] };
  await t.saveSnapshot("2", [item(2)]);
  assert.deepStrictEqual(Object.keys(store[t.K.removed]).sort(), ["BV1", "BV3"]);
  // L4: 导入设置 on the options page writes the folder choice and 判断标准 here; the open page takes both, as a save does.
  {
    const realLoad = t.loadFolders;
    let loads = 0;
    t.loadFolders = async () => (loads++, realLoad());
    store.triage_included_folders = ["1", "2"];
    await t.followIncluded({ triage_included_folders: { newValue: ["1", "2"] } });
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    assert.deepStrictEqual([loads, plain(t.S.included)], [1, ["1", "2"]]);
    t.followIncluded({ triage_included_folders: { newValue: ["2", "1"] } });
    assert.strictEqual(loads, 1, "the same choice: no reload");
    t.loadFolders = realLoad;
    t.followShared({ [t.K.folderCriteria]: { newValue: { 2: "只留教程" } } });
    assert.strictEqual(t.S.folderCriteria[2], "只留教程");
  }

  // T5: the page opens from the folder list last read: the last folder shows its snapshot before B站's list is back, and
  // that list (the same folders) leaves the folder open as it was. Ticking another folder does not reopen it either.
  // 稍后再看 shows its snapshot first too, then reads its list.
  {
    const keep = { allFolders: t.S.allFolders, folders: t.S.folders, mediaId: t.S.mediaId, tab: t.S.tab };
    const flush = async () => { for (let i = 0; i < 30; i++) await new Promise(setImmediate); };
    for (const k of Object.keys(store)) delete store[k];
    const folders = [{ id: 1, title: "甲", count: 2 }, { id: 2, title: "乙", count: 1 }];
    Object.assign(store, {
      triage_included_folders: ["1"],
      triage_last_folder: "1",
      triage_snapshot_1: { bvids: ["BV1", "BV2"], ids: ["BV1", "BV2"], items: [item(1), item(2)], intro: "" },
      triage_snapshot_2: { bvids: ["BV3"], ids: ["BV3"], items: [item(3)], intro: "" }
    });
    handlers["triage-folder-ids"] = ({ mediaId }) => ({ ok: true, data: { bvids: store[t.K.snapshot(mediaId)]?.bvids || [] } });
    handlers["triage-folders"] = () => ({ ok: true, data: { mid: 7, folders } });
    t.S.allFolders = [];
    t.S.mediaId = "";
    await t.loadFolders();
    assert.deepStrictEqual(plain(store[t.K.folderList]), { mid: 7, folders }, "B站's list is kept for the next open");
    let answer;
    handlers["triage-folders"] = () => new Promise((res) => (answer = res));
    t.S.allFolders = [];
    t.S.mediaId = "";
    const loading = t.loadFolders();
    await flush();
    assert.deepStrictEqual(plain([t.S.mediaId, t.S.items.map((it) => it.bvid)]), ["1", ["BV1", "BV2"]], "the last folder's snapshot, before B站's list");
    t.S.selected.add("BV2");
    t.S.tab = "done";
    answer({ ok: true, data: { mid: 7, folders } });
    await loading;
    assert.deepStrictEqual([t.S.mediaId, [...t.S.selected], t.S.tab], ["1", ["BV2"], "done"], "the same list leaves the folder open as it was");
    handlers["triage-folders"] = () => ({ ok: true, data: { mid: 7, folders } });
    store.triage_included_folders = ["1", "2"];
    await t.applyIncluded(["1", "2"]);
    assert.deepStrictEqual([t.S.mediaId, [...t.S.selected], t.S.tab, t.S.folders.length], ["1", ["BV2"], "done", 2], "ticking a folder keeps the open one");
    // 稍后再看: its snapshot first, then its list.
    store.triage_snapshot_toview = { bvids: ["BV5"], items: [item(5)] };
    const stub = t.syncFolder;
    t.syncFolder = realSync;
    let list;
    handlers["triage-folder-items"] = () => new Promise((res) => (list = res));
    const opening = t.openFolder("toview");
    await flush();
    assert.deepStrictEqual(plain(t.S.items.map((it) => it.bvid)), ["BV5"], "稍后再看's snapshot first");
    list({ ok: true, data: { items: [item(5), item(6)] } });
    await opening;
    await flush();
    assert.deepStrictEqual(plain(t.S.items.map((it) => it.bvid).sort()), ["BV5", "BV6"], "then what B站 lists");
    delete handlers["triage-folder-items"];
    t.syncFolder = stub;
    t.S.selected.clear();
    Object.assign(t.S, keep);
  }

  // A tag greyed out in 批量打 is nowhere in what the AI gets; a reply that still adds, creates or removes it is dropped.
  {
    openFake("K", [item(610)]);
    Object.assign(t.S, { tags: [{ id: "a", name: "旧", color: "#111", folder: "K" }, { id: "b", name: "留", color: "#222", folder: "K" }], videoTags: { BV610: ["a"] }, aiHistory: [], tab: "read" });
    t.S.settings.triageAiRemoveTags = true;
    t.S.ai.excluded.add("a");
    handlers["triage-ai-command"] = () => ({ ok: true, data: { newTags: ["旧"], assignments: { BV610: { add: ["旧", "留"], remove: ["旧"] } } } });
    await t.runAiCommand({ instruction: "分", scope: "filter", allowRemove: true });
    assert.deepStrictEqual(plain(sent.at(-1).tags), [{ name: "留", rule: "" }]);
    assert.ok(!JSON.stringify(sent.at(-1)).includes("旧"), "not in the tag list nor in the video's current tags");
    assert.deepStrictEqual(plain(t.S.ai.proposal.newTags), [], "not created as a new tag");
    assert.deepStrictEqual(plain(t.S.ai.proposal.rows), [{ id: "BV610", add: ["id:b"], remove: [] }], "not added, not removed");
    t.S.ai.proposal = null;
    t.S.ai.excluded.clear();
    t.S.settings.triageAiRemoveTags = false;
  }

  // A54: a 核对 that fails after another opening writes nothing into that opening's check.
  {
    openFake("removed", [item(620)]);
    t.S.removedCheck = { error: "" };
    const token = t.S.folderToken;
    handlers["triage-fav-where"] = () => {
      t.S.folderToken++;
      t.S.removedCheck = { error: "" };
      return { ok: false, error: "网络断了" };
    };
    await t.checkWhere(token);
    assert.strictEqual(t.S.removedCheck.error, "");
    delete handlers["triage-fav-where"];
    t.S.removedCheck = null;
  }
  // A55: 清理's confirm shows a title as text.
  {
    const realAsk = t.askConfirm;
    let body = "";
    t.askConfirm = async (_, b) => ((body = b), false);
    await t.cleanRemoved([{ ...item(621), title: XSS[0] }]);
    t.askConfirm = realAsk;
    assertInert(body, "清理");
    assert.ok(body.includes("分拣标签") && body.includes("摘读记录里的星标和标签会保留"), "J19: says 摘读记录's marks stay");
  }
  // A14: each batch is told what is left of the run's new-tag cap. A57: a tag deleted mid-run drops the proposal naming it.
  {
    openFake("K", [item(611), item(612)]);
    Object.assign(t.S, { tags: [{ id: "b", name: "留", color: "#222", folder: "K" }], videoTags: {}, aiHistory: [], tab: "read" });
    Object.assign(t.S.settings, { triageAiBatchSize: 1, triageIntervalSec: 0, triageAiNewTagMax: 2 });
    const maxes = [];
    handlers["triage-ai-command"] = (m) => (maxes.push(m.maxNewTags), { ok: true, data: { newTags: [`新${maxes.length}`], assignments: { [m.items[0].bvid]: { add: [`新${maxes.length}`] } } } });
    await t.runAiCommand({ instruction: "分", scope: "filter", allowRemove: false });
    assert.deepStrictEqual(maxes, [2, 1]);
    t.S.ai.proposals = {};
    let calls = 0;
    handlers["triage-ai-command"] = async (m) => {
      if (++calls === 2) await tagStore().remove(t.S.tags.find((x) => x.id === "b"));
      return { ok: true, data: { assignments: { [m.items[0].bvid]: { add: ["留"] } } } };
    };
    toasts.length = 0;
    await t.runAiCommand({ instruction: "分", scope: "filter", allowRemove: false });
    assert.ok(!t.S.ai.proposals.K && toasts.some((x) => x.includes("删除了建议用到的标签")), toasts.join("|"));
    Object.assign(t.S, { tags: [], videoTags: {} });
  }

  // G1: while a notes export or a B站 batch write runs, closing or reloading the page asks first.
  {
    const leave = () => {
      let asked = false;
      winL.beforeunload.forEach((f) => f({ preventDefault: () => (asked = true) }));
      return asked;
    };
    assert.strictEqual(leave(), false, "nothing running: no prompt");
    const writeRun = hang("write");
    assert.strictEqual(leave(), true, "notes export");
    await writeRun();
    t.S.decisions.BV9 = { action: "unfav", at: 1, aid: 1009, title: "视频9" };
    const h = holdNext("triage-refav");
    const running = t.fav.refav("BV9");
    await ticks();
    assert.strictEqual(leave(), true, "a 重新收藏 running");
    h.release();
    await running;
    assert.strictEqual(leave(), false, "done: no prompt");
    await settled();
  }

  // 批量打标签 keeps running when another folder opens; its proposal stays with its folder and shows on return.
  openFake("K", [item(600), item(601)]);
  t.S.folders = t.S.allFolders = [{ id: "K", title: "夹K" }, { id: "L", title: "夹L" }];
  Object.assign(t.S, { tags: [{ id: "a", name: "旧", color: "#111", folder: "K" }, { id: "b", name: "旧", color: "#222", folder: "L" }], videoTags: {}, aiHistory: [], tab: "read", query: "", tagFilter: new Set(), classFilter: { coarse: "all", fine: "all", read: "all" } });
  Object.assign(t.S.settings, { triageIntervalSec: 0 });
  let aiCalls = 0;
  handlers["triage-ai-command"] = ({ items }) => {
    if (++aiCalls === 1) {
      openFake("L", [item(700)]);
      assert.ok(vm.runInContext("aiTags", ctx).blocked().startsWith("正在处理「夹K」的视频"), "the form in L says which folder runs");
      assert.strictEqual(vm.runInContext("activityState()", ctx).text, "AI 打标签 0/2 批（夹K）");
    }
    return { ok: true, data: { assignments: { [items[0].bvid]: { add: ["旧"] } } } };
  };
  toasts.length = 0;
  await t.runAiCommand({ instruction: "分一下", scope: "filter", allowRemove: false });
  assert.strictEqual(aiCalls, 2, "the second batch is still sent after the switch");
  assert.ok(!vm.runInContext("aiRunning()", ctx) && t.S.ai.proposal === null, "folder L sees no proposal");
  assert.ok(/「夹K」的标签建议已完成，点进度胶囊上的「查看」确认/.test(toasts.at(-1)), toasts.at(-1));
  assert.deepStrictEqual(plain(vm.runInContext("activityState()", ctx)), { text: "「夹K」的标签建议待确认", act: "aiOther", actLabel: "查看" }, "folder L points back to K");
  openFake("K", [item(600), item(601)]);
  assert.deepStrictEqual(plain(t.S.ai.proposal.rows.map((r) => [r.id, r.add])), [["BV600", ["id:a"]], ["BV601", ["id:a"]]], "K's own 旧, not L's");
  // G1: the proposal is saved, so a reload keeps it; one naming a deleted tag is dropped, and discarding removes it.
  assert.deepStrictEqual(plain(store[t.K.aiProposals].K), plain(t.S.ai.proposal));
  t.S.ai.proposals = { K: t.S.ai.proposal, L: { newTags: [], notes: [], errors: [], rows: [{ id: "BV700", add: ["id:gone"], remove: [] }] } };
  t.pruneAiProposals();
  assert.deepStrictEqual([Object.keys(t.S.ai.proposals), Object.keys(store[t.K.aiProposals])], [["K"], ["K"]], "L's names a deleted tag");
  t.S.ai.proposal = null;
  assert.deepStrictEqual(store[t.K.aiProposals], {});

  // Opening a folder with a cached list shows it without the full sync; changed ids still sync once.
  let synced = 0;
  t.syncFolder = async () => (synced++, true); // stubbed since U7
  Object.assign(t.S, { folders: [{ id: "2", title: "夹" }], kept: {} });
  t.el.folderSelect = { value: "", querySelector: () => null };
  store.triage_snapshot_2 = { bvids: ["BV2"], ids: ["BV2"], items: [item(2)], intro: "简介" };
  handlers["triage-folder-ids"] = () => ({ ok: true, data: { bvids: ["BV2"] } });
  await t.openFolder("2");
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual([synced, plain(t.S.items.map((it) => it.bvid)), t.S.folderIntro["2"]], [0, ["BV2"], "简介"]);
  handlers["triage-folder-ids"] = () => ({ ok: true, data: { bvids: ["BV2", "BV8"] } });
  await t.openFolder("2");
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(synced, 1, "changed ids trigger a full sync");
  delete store.triage_snapshot_2.intro;
  await t.openFolder("2");
  assert.strictEqual(synced, 2, "a snapshot without the intro syncs instead");
  // S2: a failed first read still resets the step and chips, so the page is not folder B with A's tabs and filters.
  Object.assign(t.S, { tab: "fine", classFilter: { coarse: "all", fine: "drop", read: "all" } });
  t.syncFolder = async () => false;
  await t.openFolder("2");
  assert.deepStrictEqual([t.S.tab !== "fine", t.S.classFilter.fine], [true, "all"], "a failed open drops the last folder's step and chips");

  // Changed ids fetch only the newest pages: removed videos leave, added ones come from the head, the rest from the cache.
  assert.deepStrictEqual(plain(t.mergeHead([item(8)], [item(2), item(3)], ["BV2", "BV3"], ["BV8", "BV2"]).map((it) => it.bvid)), ["BV8", "BV2"]);
  assert.strictEqual(t.mergeHead([item(8)], [item(2)], ["BV2"], ["BV8", "BV7", "BV2"]), null, "an added id outside the head loads the whole folder");
  assert.ok(t.mergeHead([], [item(2)], ["BV2", "BVhidden"], ["BV2", "BVhidden"]), "an id the list never shows was already in the old ids");
  t.syncFolder = realSync;
  t.S.folders = [{ id: "6", title: "夹6" }];
  store.triage_snapshot_6 = { bvids: ["BV2", "BV3"], ids: ["BV2", "BV3"], items: [item(2), item(3)], intro: "简介" };
  handlers["triage-folder-ids"] = () => ({ ok: true, data: { bvids: ["BV8", "BV2"] } });
  const itemCalls = [];
  handlers["triage-folder-items"] = (m) => (itemCalls.push(m.known), { ok: true, data: { items: [item(8), item(2)], info: { intro: "简介" }, head: true } });
  t.S.lastSyncAt = 0;
  await t.openFolder("6");
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(plain(itemCalls), [["BV2", "BV3"]], "one head request with the cached bvids");
  assert.deepStrictEqual(plain(t.S.items.map((it) => it.bvid)), ["BV8", "BV2"]);
  assert.deepStrictEqual(plain(store.triage_snapshot_6.ids), ["BV8", "BV2"], "the snapshot takes the new id list");
  // An added id already in another chosen folder's cache is taken from there, no request, and the notice says so.
  t.S.folders = [{ id: "6", title: "夹6" }, { id: "7", title: "夹7" }];
  t.S.allFolders = t.S.folders;
  store.triage_snapshot_7 = { bvids: ["BV9"], ids: ["BV9"], items: [{ ...item(9), title: "从7来" }], intro: "" };
  handlers["triage-folder-ids"] = () => ({ ok: true, data: { bvids: ["BV9", "BV8", "BV2"] } });
  // It keeps its 粗看 result from folder 7; under folder 6's other 判断标准 the result is marked stale. BV8 was never analyzed.
  Object.assign(t.S, { titleRes: {}, analyses: {}, folderCriteria: { 6: "B 的标准", 7: "A 的标准" } });
  handlers["triage-title-get"] = ({ bvids }) => ({ ok: true, data: bvids.includes("BV9") ? { BV9: { verdict: "keep", confidence: "high", criteria: "A 的标准" } } : {} });
  handlers["triage-analysis-get"] = () => ({ ok: true, data: {} });
  itemCalls.length = 0;
  t.el.syncDetail = {};
  t.el.syncText = {};
  await t.openFolder("6");
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(plain(itemCalls), [], "nothing fetched for a video that moved in");
  assert.deepStrictEqual(plain(t.S.items.map((it) => it.bvid)), ["BV9", "BV8", "BV2"]);
  assert.ok(t.el.syncDetail.innerHTML.includes("<strong>来自其他收藏夹</strong><ul><li>从7来（也在「夹7」）</li>"), t.el.syncDetail.innerHTML);
  assert.ok(t.el.syncText.textContent.includes("新增 0 · 来自其他收藏夹 1"), t.el.syncText.textContent);
  assert.ok(!("from" in store.triage_snapshot_6.items[0]), "the cache keeps plain items");
  assert.deepStrictEqual([t.stageOf(t.S.itemMap.get("BV9")), t.stageOf(t.S.itemMap.get("BV8"))], ["coarse", "none"], "a moved video stays at its step");
  assert.deepStrictEqual(plain(t.staleCoarse().map((it) => it.bvid)), ["BV9"], "and is offered for redo under this folder's criteria");

  // 粗看 keeps going after another folder opens, with its own folder's criteria; the other folder sees where it runs.
  openFake("K", [item(810), item(811)]);
  t.S.folders = t.S.allFolders = [{ id: "K", title: "夹K" }, { id: "L", title: "夹L" }];
  Object.assign(t.S, { titleRes: {}, analyses: {}, decisions: {}, folderCriteria: { K: "K 标准", L: "L 标准" }, coarseFailed: new Map() });
  Object.assign(t.S.settings, { triageIntervalSec: 0 });
  const classified = [];
  handlers["triage-classify-titles"] = ({ items, criteria }) => {
    if (!classified.length) {
      openFake("L", [item(820)]);
      assert.strictEqual(t.activityState().text, "标题粗看中 0/2（夹K）");
    }
    for (const x of items) classified.push([x.bvid, criteria]);
    return { ok: true, data: { results: Object.fromEntries(items.map((x) => [x.bvid, { verdict: "keep", confidence: "high" }])) } };
  };
  toasts.length = 0;
  await t.runStage1();
  assert.deepStrictEqual(plain(classified), [["BV810", "K 标准"], ["BV811", "K 标准"]]);
  assert.deepStrictEqual([t.S.titleRes.BV811?.criteria, vm.runInContext("runs", ctx).get("stage1")], ["K 标准", null]);
  assert.strictEqual(toasts.at(-1), "「夹K」标题粗看完成 2 个");

  // Between batches the line counts the batch that came back, not only once the next one starts. A request carries 20
  // titles (TITLES_PER_REQUEST).
  openFake("K", Array.from({ length: 21 }, (_, i) => item(840 + i)));
  Object.assign(t.S, { titleRes: {}, coarseFailed: new Map() });
  t.S.settings.triageIntervalSec = 0.2;
  const sizes = [];
  handlers["triage-classify-titles"] = ({ items }) => (sizes.push(items.length), { ok: true, data: { results: Object.fromEntries(items.map((x) => [x.bvid, { verdict: "keep", confidence: "high" }])) } });
  const between = t.runStage1();
  await new Promise((r) => setTimeout(r, 80));
  assert.strictEqual(t.activityState().text, "标题粗看中 20/21");
  await between;
  assert.deepStrictEqual(sizes, [20, 1]);
  t.S.settings.triageIntervalSec = 0;

  // 细看 too: the run judges by its own items, not the open folder's.
  openFake("K", [item(830), item(831)]);
  const analyzed = [];
  handlers["triage-analyze"] = ({ bvid, criteria }) => {
    analyzed.push([bvid, criteria]);
    // Back in K while its list is still loading (empty): the run must not take that as done.
    if (analyzed.length === 1) openFake("K", []);
    if (analyzed.length === 2) {
      openFake("L", [item(820)]);
      t.showBanner("未登录 B 站", "去登录", () => {});
    }
    return { ok: true, data: { bvid, status: "done", verdict: "keep" } };
  };
  t.startGroup(["BV830", "BV831"]);
  for (let i = 0; i < 20 && t.S.group; i++) await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(plain(analyzed), [["BV830", "K 标准"], ["BV831", "K 标准"]]);
  assert.deepStrictEqual([t.S.analyses.BV831?.criteria, t.S.group], ["K 标准", null]);
  assert.strictEqual(toasts.at(-1), "「夹K」字幕细看完成 2 个");
  // F5: both steps tell another folder the same way how they ended, paused or stopped on an error too.
  {
    const oft = vm.runInContext("otherFolderToast", ctx);
    oft({ mediaId: "K" }, "字幕细看", { done: 2, failed: 1, stopped: true, error: "" });
    assert.strictEqual(toasts.at(-1), "「夹K」字幕细看已暂停，完成 1 个");
    oft({ mediaId: "K" }, "标题粗看", { done: 0, failed: 0, stopped: false, error: "API Key 不对" });
    assert.strictEqual(toasts.at(-1), "「夹K」标题粗看出错停下，完成 0 个");
    const n = toasts.length;
    oft({ mediaId: "L" }, "标题粗看", { done: 3, failed: 0, stopped: false, error: "" });
    assert.strictEqual(toasts.length, n, "in its own folder the pill says it");
  }
  assert.strictEqual(t.el.banner.hidden, false, "a finished run leaves a banner that is not about AI");
  assert.strictEqual(t.activityState(), null, "K's last 粗看 line is not shown in L");
  // entry-matrix: a run's stop shows the remedy MdgErrors.remedies lists first (the run's own buttons are its 重试), and
  // 授权 only for AI_ACCESS, never for the same words under another code.
  {
    const labels = { settings: ctx.MdgErrors.LABEL.toSettings, grant: ctx.MdgErrors.LABEL.grant, retry: "" };
    for (const code of Object.keys(ctx.MdgErrors.CODE).filter((c) => c.startsWith("AI_") && c !== "AI_TRUNCATED")) {
      t.el.banner.hidden = true;
      t.handleAiError(ctx.MdgErrors.noAccess("https://ai.test"), code);
      const want = labels[ctx.MdgErrors.remedies(code)[0]];
      assert.deepStrictEqual(want ? [t.el.banner.hidden, t.el.bannerBtn.textContent] : [t.el.banner.hidden], want ? [false, want] : [true], code);
    }
  }
  t.handleAiError("没有启用的 AI 平台", "AI_SETUP");
  t.startGroup(["BV820"]);
  for (let i = 0; i < 20 && t.S.group; i++) await new Promise((r) => setImmediate(r));
  assert.strictEqual(t.el.banner.hidden, true, "a run that works clears the AI banner wherever it ran");
  // An AI error that fails every video (bad key, quota, network) ends 细看 at the first video, leaves its card as it was
  // and shows the banner with 去设置; a timeout sends the same video again once, the second ends the run.
  {
    openFake("K", [item(860), item(861)]);
    t.S.analyses = {};
    const calls = [];
    const failWith = (code, error) => (handlers["triage-analyze"] = ({ bvid }) => (calls.push(bvid), { ok: false, code, error }));
    const runFine = async () => {
      calls.length = 0;
      t.startGroup(["BV860", "BV861"]);
      for (let i = 0; i < 20 && t.S.group; i++) await new Promise((r) => setImmediate(r));
    };
    failWith("AI_AUTH", "AI 平台的 API Key 无效或没有权限");
    await runFine();
    assert.deepStrictEqual([calls, t.S.analyses.BV860, t.S.group], [["BV860"], undefined, null]);
    assert.deepStrictEqual([t.el.banner.hidden, t.el.bannerText.textContent, t.el.bannerBtn.textContent], [false, "AI 平台的 API Key 无效或没有权限", "去设置"]);
    failWith("AI_TIMEOUT", "AI 平台 120 秒没有回应");
    await runFine();
    assert.deepStrictEqual([calls, t.S.analyses.BV860], [["BV860", "BV860"], undefined]);
    // A bad answer is that video's own: its card fails and the run goes on.
    failWith(undefined, "AI 回复格式不对");
    await runFine();
    assert.deepStrictEqual([calls, t.S.analyses.BV861.status], [["BV860", "BV861"], "error"]);
    t.S.analyses = {};
    t.el.banner.hidden = true;
  }

  // 所有收藏夹: each video is judged under its first chosen folder's 判断标准 and context; a 粗看 batch holds one folder.
  {
    const vids = [{ ...item(850), folders: ["K"] }, { ...item(851), folders: ["L", "K"] }, { ...item(852), folders: ["L"] }, { ...item(853), folders: ["K"] }];
    openFake("all", vids);
    t.S.folders = t.S.allFolders = [{ id: "K", title: "夹K" }, { id: "L", title: "夹L" }];
    Object.assign(t.S, { titleRes: {}, analyses: {}, decisions: {}, folderCriteria: { K: "K 标准", L: "L 标准" }, folderIntro: { L: "L 简介" }, coarseFailed: new Map(), tab: "none", loadAll: { lists: {}, check: [], checkTotal: 0, queue: [], paused: false, running: false, error: "", partial: 0 } });
    Object.assign(t.S.settings, { triageIntervalSec: 0 });
    assert.deepStrictEqual(vids.map((it) => vm.runInContext("homeOf", ctx)(it)), ["K", "K", "L", "K"], "the first chosen folder it is in");
    // The step bar offers the run (no single 判断标准 button); the run asks first, listing each folder's count and 判断标准.
    t.renderListHeader(t.visibleItems());
    assert.ok((t.el.listHeader.innerHTML + t.el.favSel.innerHTML).includes("标题粗看下一批 4 个") && !(t.el.listHeader.innerHTML + t.el.favSel.innerHTML).includes('data-head="criteria"'), (t.el.listHeader.innerHTML + t.el.favSel.innerHTML));
    const batches = [];
    handlers["triage-classify-titles"] = ({ items, criteria, folder }) => {
      batches.push([items.map((x) => x.bvid), criteria, folder.title, folder.intro]);
      return { ok: true, data: { results: Object.fromEntries(items.map((x) => [x.bvid, { verdict: "keep", confidence: "high" }])) } };
    };
    let asked = null;
    t.askConfirm = async (title, body, ok) => ((asked = [title, body, ok]), true);
    t.el.confirmBody = { querySelectorAll: () => [{ dataset: { crit: "L" }, value: " L 新标准 " }] };
    await vm.runInContext("startJudging", ctx)("标题粗看", "粗看", t.S.items, () => t.runStage1(t.S.items));
    while (vm.runInContext("runs", ctx).get("stage1")) await new Promise((r) => setTimeout(r, 0));
    assert.deepStrictEqual([asked[0], asked[2]], ["标题粗看", "开始粗看 4 个"]);
    assert.ok(asked[1].includes("「夹K」· 3 个") && asked[1].includes(">L 标准</textarea>") && asked[1].indexOf("夹K") < asked[1].indexOf("夹L"), asked[1]);
    assert.deepStrictEqual(plain(store[t.K.folderCriteria]), { K: "K 标准", L: "L 新标准" }, "edits save like the 判断标准 dialog");
    assert.deepStrictEqual(batches, [[["BV850", "BV851", "BV853"], "K 标准", "夹K", ""], [["BV852"], "L 新标准", "夹L", "L 简介"]]);
    // Staleness goes by each video's own folder.
    t.S.folderCriteria = { K: "K 改了", L: "L 新标准" };
    t.S.tab = "coarse";
    assert.deepStrictEqual(plain(t.staleCoarse().map((it) => it.bvid)), ["BV850", "BV851", "BV853"]);
    t.renderListHeader(t.visibleItems());
    assert.ok((t.el.listHeader.innerHTML + t.el.favSel.innerHTML).includes("按新标准重新粗看下一批 3 个") && (t.el.listHeader.innerHTML + t.el.favSel.innerHTML).includes("字幕细看下一批"), (t.el.listHeader.innerHTML + t.el.favSel.innerHTML));
    // 细看: one video per request, each with its own folder's 判断标准.
    const fine = [];
    handlers["triage-analyze"] = ({ bvid, criteria, folder }) => (fine.push([bvid, criteria, folder.title]), { ok: true, data: { bvid, status: "done", verdict: "keep" } });
    t.startGroup(["BV851", "BV852"]);
    for (let i = 0; i < 20 && t.S.group; i++) await new Promise((r) => setImmediate(r));
    assert.deepStrictEqual(fine, [["BV851", "K 改了", "夹K"], ["BV852", "L 新标准", "夹L"]]);
    assert.strictEqual(t.S.analyses.BV852.criteria, "L 新标准");
    // 取消 starts nothing and saves nothing.
    t.askConfirm = async () => false;
    let started = false;
    await vm.runInContext("startJudging", ctx)("细看", "细看", [vids[0]], () => (started = true));
    assert.ok(!started);
    Object.assign(t, { askConfirm: async () => true });
    Object.assign(t.S, { titleRes: {}, analyses: {}, folderCriteria: {}, folderIntro: {}, loadAll: null });
  }
  for (const thinkingToggle of [false, true]) {
    t.S.settings.thinkingToggle = thinkingToggle;
    t.handleAiError("模型输出被截断", "AI_TRUNCATED");
    assert.strictEqual(t.el.bannerText.textContent.endsWith("关闭思考"), thinkingToggle, "only a platform with the thinking switch is told to turn it off");
  }
  t.S.settings.thinkingToggle = false;
  // C553: a cut 细看 answer names 细看's own limit; 粗看 and AI 打标签 share 粗看's.
  assert.ok(t.el.bannerText.textContent.includes("调大粗看输出上限"), t.el.bannerText.textContent);
  t.el.banner.hidden = true;
  openFake("all", []);
  assert.strictEqual(t.activityState().text, "字幕细看完成 2 个", "back in its folder, the newest finished line shows (细看 ran after 粗看)");
  for (const job of ["stage1", "group"]) await vm.runInContext("runs", ctx).run(job, { line: () => "", next: () => null }); // drops their finished lines

  // Back on the tab: the id check alone when nothing changed, no full load.
  t.S.folders = t.S.allFolders = [{ id: "6", title: "夹6" }];
  openFake("6", store.triage_snapshot_6.items.slice());
  handlers["triage-folder-ids"] = () => ({ ok: true, data: { bvids: store.triage_snapshot_6.ids.slice() } });
  itemCalls.length = 0;
  t.S.lastSyncAt = 0;
  await t.quickSync();
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(plain(itemCalls), [], "no full load when the ids match");
  assert.ok(Date.now() - t.S.lastSyncAt < 1000, "and it counts as a sync");
  assert.ok(Date.now() - store.triage_read_at["6"] < 1000, "its read time is kept for a reopened page");

  // 所有收藏夹: a folder whose ids changed takes only the difference.
  handlers["triage-folder-ids"] = () => ({ ok: true, data: { bvids: ["BV5", ...store.triage_snapshot_6.ids] } });
  handlers["triage-folder-items"] = (m) => (itemCalls.push(m.known), { ok: true, data: { items: [item(5)], info: { intro: "" }, head: true } });
  t.S.mediaId = "all";
  t.S.loadAll = { lists: { 6: { items: store.triage_snapshot_6.items, ids: store.triage_snapshot_6.ids, at: 0 } }, check: ["6"], checkTotal: 1, queue: [], paused: false, running: false, error: "", partial: 0 };
  await t.runLoadAll(t.S.folderToken);
  assert.deepStrictEqual([itemCalls.length, t.S.loadAll.queue.length], [1, 0], "one head request, no full load queued");
  assert.strictEqual(t.S.loadAll.lists["6"].items[0].bvid, "BV5");
  assert.strictEqual(store.triage_snapshot_6.ids[0], "BV5");
  // C581: the difference read hitting B站's limit waits and checks again, never falling back to a full load.
  {
    const snap = structuredClone(store.triage_snapshot_6);
    handlers["triage-folder-ids"] = () => ({ ok: true, data: { bvids: ["BV581", ...snap.ids] } });
    let n = 0;
    handlers["triage-folder-items"] = (m) => (itemCalls.push(m.known), ++n === 1 ? { ok: false, code: "THROTTLED", error: "412" } : { ok: true, data: { items: [item(581)], info: { intro: "" }, head: true } });
    itemCalls.length = 0;
    t.S.loadAll = { lists: { 6: { items: snap.items, ids: snap.ids, at: 0 } }, check: ["6"], checkTotal: 1, queue: [], paused: false, running: false, error: "", partial: 0 };
    await t.runLoadAll(t.S.folderToken);
    assert.ok(itemCalls.length === 2 && itemCalls.every(Boolean), "two difference reads, no full one");
    assert.strictEqual(t.S.loadAll.lists["6"].items[0].bvid, "BV581");
    store.triage_snapshot_6 = snap;
  }

  // F12: loading 所有收藏夹 shows in the pill with counts; a B站 limit waits with the amber countdown and goes on.
  {
    let calls = 0;
    const seen = [];
    handlers["triage-folder-items"] = () => {
      seen.push(t.activityState().text);
      return ++calls === 1 ? { ok: false, code: "THROTTLED", error: "412" } : { ok: true, data: { items: [item(7)], ids: ["BV7"], info: { intro: "" } } };
    };
    const realStatus = t.renderStatus;
    t.renderStatus = () => {
      const a = t.activityState();
      if (a?.stuck && !seen.some((x) => x[0] === a.text)) seen.push([a.text, a.stuck, a.actLabel, a.total]);
    };
    t.S.loadAll = { lists: {}, check: [], checkTotal: 0, queue: ["6"], paused: false, running: false, error: "", partial: 0 };
    await t.runLoadAll(t.S.folderToken);
    t.renderStatus = realStatus;
    assert.deepStrictEqual(plain(seen), ["加载收藏夹 0/1 · 「夹6」", ["加载收藏夹 0/1 · B站限流卡住，0:01 后重试", true, "暂停", 1], "加载收藏夹 0/1 · 「夹6」"]);

    assert.ok(!t.S.loadAll.error && !t.S.loadAll.queue.length && t.activityState() === null, "loaded, no red line, pill gone");
  }

  // R2: a list fetched before a 取消收藏, or lagging behind it, still holds the video with its old favTime. Only a
  // favorite time not older than the 取消收藏 counts as re-favorited.
  t.S.folders = t.S.allFolders = [{ id: "M", title: "夹M" }];
  const unfavAt = (n) => ({ action: "unfav", at: 200000, aid: 1000 + n, title: `视频${n}` });
  openFake("M", [item(40), item(41)], { BV40: unfavAt(40), BV41: unfavAt(41) });
  handlers["triage-folder-items"] = () => ({ ok: true, data: { items: [{ ...item(40), favTime: 100 }, { ...item(41), favTime: 300 }], ids: ["BV40", "BV41"], info: { intro: "" } } });
  Object.assign(t.S, { syncing: false, lastSyncAt: 0 });
  await t.syncFolder({ force: true });
  assert.deepStrictEqual(Object.keys(plain(store[t.K.decisions("M")])), ["BV40"], "BV40 stays unfavorited, BV41 was re-favorited");
  assert.ok(t.S.decisions.BV40 && !t.S.decisions.BV41);

  // U9: a failed 刷新 stays under the title (no toast that fades) until a read gets through; the read time shows there.
  handlers["triage-folder-items"] = () => ({ ok: false, error: "网络断了" });
  Object.assign(t.S, { syncing: false, lastSyncAt: 0 });
  await t.syncFolder({ force: true });
  t.renderFolderHead();
  assert.ok(t.el.folderHead.innerHTML.includes('<span class="fail-text">刷新失败：网络断了</span>') && !toasts.includes("刷新收藏夹失败：网络断了"), t.el.folderHead.innerHTML);
  // X1: not logged in, a read shows the 去登录 banner once (send()'s, kind "login", so 关注's loginBanner(false) hides
  // it); a read error that only mentions 登录 is not a login and offers 重试.
  {
    const realBanner = t.showBanner, banners = [];
    t.showBanner = (...a) => (banners.push(a[0]), realBanner(...a));
    const realFolders = handlers["triage-folders"];
    for (const [type, run] of [["triage-folder-items", () => (Object.assign(t.S, { syncing: false, lastSyncAt: 0 }), t.syncFolder({ force: true }))], ["triage-folders", () => t.loadFolders()]]) {
      const real = handlers[type];
      handlers[type] = () => ({ ok: false, error: "未登录 B站", code: "NOT_LOGGED_IN" });
      banners.length = 0;
      await run();
      assert.deepStrictEqual([banners.length, t.el.banner.dataset.kind, t.el.banner.hidden], [1, "login", false], type);
      t.MoonTriage.loginBanner(false);
      assert.strictEqual(t.el.banner.hidden, true, type);
      handlers[type] = real;
    }
    handlers["triage-folders"] = () => ({ ok: false, error: "B站返回的不是 JSON（可能被风控拦截或需要重新登录）" });
    await t.loadFolders();
    assert.deepStrictEqual([t.el.banner.dataset.kind, t.el.bannerBtn.textContent], ["", "重试"]);
    t.el.banner.hidden = true;
    handlers["triage-folders"] = realFolders;
    t.showBanner = realBanner;
  }
  handlers["triage-folder-items"] = () => ({ ok: true, data: { items: [item(40)], ids: ["BV40"], info: { intro: "" } } });
  Object.assign(t.S, { syncing: false, lastSyncAt: 0 });
  await t.syncFolder({ force: true });
  t.renderFolderHead();
  assert.ok(!t.el.folderHead.innerHTML.includes("fail-text") && /今天 \d\d:\d\d 刷新过/.test(t.el.folderHead.innerHTML), t.el.folderHead.innerHTML);
  assert.ok(Date.now() - store[t.K.readAt].M < 1000, "a reopened page still says when");

  // A12/A13: a folder with nothing listed whose read failed says so on every redraw, not 「这个收藏夹没有视频」, until a read gets through.
  {
    openFake("E", []);
    t.S.tab = "none";
    handlers["triage-folder-items"] = () => ({ ok: false, error: "网络断了" });
    Object.assign(t.S, { syncing: false, lastSyncAt: 0 });
    await t.syncFolder({ force: true });
    t.el.list.innerHTML = "";
    t.renderList();
    assert.ok(t.el.list.innerHTML.includes("无法读取这个收藏夹") && t.el.list.innerHTML.includes("网络断了") && !t.el.list.innerHTML.includes("这个收藏夹没有视频"), t.el.list.innerHTML);
    handlers["triage-folder-items"] = () => ({ ok: true, data: { items: [], ids: [], info: { intro: "" } } });
    Object.assign(t.S, { syncing: false, lastSyncAt: 0 });
    await t.syncFolder({ force: true });
    t.renderList();
    assert.ok(t.el.list.innerHTML.includes("这个收藏夹没有视频"), t.el.list.innerHTML);
    openFake("M", [item(40)]);
  }

  // R1: another triage tab's write to a shared list replaces this page's copy, so the next write here keeps it. This
  // page's own writes echo back too, and an older echo arriving after a newer edit is skipped.
  openFake("N", [item(50), item(51)], { BV51: { action: "unfav", at: 1 } });
  t.S.kept = {};
  const keep = { action: "keep", at: 5 };
  t.patchKept({ BV50: keep });
  const echo1 = { triage_kept: { newValue: structuredClone(store.triage_kept) } };
  t.S.basket = [{ bvid: "BV50" }];
  vm.runInContext("saveBasket()", ctx);
  t.S.basket.push({ bvid: "BV51" });
  vm.runInContext("saveBasket()", ctx);
  t.followShared({ triage_basket: { newValue: [{ bvid: "BV50" }] } });
  t.followShared(echo1);
  assert.deepStrictEqual(plain(t.S.basket), [{ bvid: "BV50" }, { bvid: "BV51" }], "an older echo of this page's write is skipped");
  t.followShared({ triage_kept: { newValue: { BV51: keep } }, triage_tags: { newValue: [{ id: "n", name: "新", folder: "N" }] } });
  assert.deepStrictEqual(plain([t.S.kept, t.S.decisions, t.S.tags.map((x) => x.id)]), [{ BV51: keep }, { BV51: { action: "unfav", at: 1 } }, ["n"]],
    "the other tab's 保留 list replaces this one; 取消收藏 still wins in the folder; tags follow");
  t.followShared({ triage_basket: { newValue: undefined } });
  assert.deepStrictEqual(plain(t.S.basket), [], "a removed key reads as empty");
  t.patchKept({ BV50: keep });
  assert.deepStrictEqual(Object.keys(store.triage_kept), ["BV51", "BV50"], "the next write keeps the other tab's 保留");
  Object.assign(t.S, { kept: {}, tags: [], basket: [] });

  // R3: another tab's 取消收藏 records for the open folder are followed, and a restore here does not wipe the ones this
  // page never saw. In 所有收藏夹 the loaded folders' records follow too.
  openFake("P", [item(60), item(61)], { BV60: unfavAt(60) });
  const other = { BV60: unfavAt(60), BV62: unfavAt(62) };
  store[t.K.decisions("P")] = structuredClone(other);
  t.followShared({ [t.K.decisions("P")]: { newValue: structuredClone(other) } });
  assert.ok(t.S.decisions.BV62, "the other tab's record shows here");
  store[t.K.decisions("P")].BV63 = unfavAt(63); // its event not delivered yet
  handlers["triage-folder-items"] = () => ({ ok: true, data: { items: [{ ...item(60), favTime: 300 }, item(61)], ids: ["BV60", "BV61"], info: { intro: "" } } });
  Object.assign(t.S, { syncing: false, lastSyncAt: 0 });
  await t.syncFolder({ force: true });
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(Object.keys(plain(store[t.K.decisions("P")])).sort(), ["BV62", "BV63"], "the restore removes BV60 only");
  t.followShared({ [t.K.decisions("P")]: { newValue: structuredClone(store[t.K.decisions("P")]) } });
  assert.deepStrictEqual(Object.keys(plain(t.S.decisions)).sort(), ["BV62"], "this page's own echo is skipped");
  t.S.mediaId = "all";
  t.S.folderDecisions = { P: {} };
  t.S.loadAll = { lists: { P: { items: [item(60), item(62)] } } };
  t.S.folders = [{ id: "P", title: "夹P" }];
  t.S.items = [];
  t.followShared({ [t.K.decisions("P")]: { newValue: { BV62: unfavAt(62) } } });
  assert.deepStrictEqual(plain(t.S.items.map((it) => it.bvid)), ["BV60"], "所有收藏夹 drops the video the other tab unfavorited");
  t.S.loadAll = null;

  // 阅览: every step in one list, the AI-class chip filters across steps.
  openFake("R", [item(701), item(702), item(703), item(704)]);
  Object.assign(t.S, { tab: "read", query: "", tagFilter: new Set(), classFilter: { coarse: "all", fine: "all", read: "drop" },
    titleRes: { BV701: { verdict: "drop", confidence: "high" }, BV702: { verdict: "keep", confidence: "high" } },
    analyses: { BV703: { status: "done", verdict: "drop" } }, decisions: {} });
  assert.deepStrictEqual(plain(t.visibleItems().map((it) => it.bvid)), ["BV701", "BV703"], "粗看 and 细看 可以删 together, 未分析 left out");
  t.S.classFilter.read = "all";
  assert.strictEqual(t.visibleItems().length, 4);
  Object.assign(t.S, { titleRes: {}, analyses: {}, classFilter: { coarse: "all", fine: "all", read: "all" } });

  // 移动 runs to the end after another folder opens, and each chunk updates both cached lists at once, so opening
  // either folder mid-run never sends moved videos to 已出分拣范围.
  {
    const vids = Array.from({ length: 25 }, (_, i) => item(900 + i));
    const snap = (items) => ({ bvids: items.map((v) => v.bvid), items, titles: {}, ids: items.map((v) => v.bvid), intro: "" });
    t.S.allFolders = [{ id: 1, title: "源", count: 25 }, { id: 2, title: "目标", count: 0 }, { id: 3, title: "没勾", count: 0 }];
    t.S.folders = t.S.allFolders.slice(0, 2);
    t.S.included = ["1", "2"];
    store[t.K.snapshot("1")] = snap(vids);
    store[t.K.snapshot("2")] = snap([]);
    store[t.K.removed] = {};
    openFake("1", vids);
    let calls = 0;
    handlers["triage-transfer"] = (m) => {
      assert.deepStrictEqual([m.from, m.to, m.move], ["1", "2", true]);
      if (calls === 0) {
        // Mid-run: the folders being written are not read from Bilibili, and a queued video cannot be unfavorited.
        assert.ok(t.fav.state().writing("1") && t.fav.state().writing("2") && !t.fav.state().writing("3"));
        t.S.syncing = false;
        const before = sent.length;
        return realSync({ force: true }).then(async (synced) => {
          assert.strictEqual(synced, false, "no sync of a folder being written");
          await t.fav.unfav("BV924");
          assert.ok(!sent.slice(before).some((m) => m.type === "triage-folder-items" || m.type === "triage-unfav"));
          assert.ok(toasts.at(-1).includes("等待移动"), toasts.at(-1));
          calls++;
          return { ok: true };
        });
      }
      if (++calls === 2) {
        assert.strictEqual(store[t.K.snapshot("2")].bvids.length, 20, "the first chunk is already in the target's list");
        assert.strictEqual(store[t.K.snapshot("1")].bvids.length, 5, "and out of the source's");
        openFake("2", []);
        assert.ok(t.activityState().text.endsWith("（源）"), t.activityState().text);
      }
      return { ok: true };
    };
    t.askTransfer = async () => ({ how: "move", target: { id: "2" } });
    await t.fav.transfer(vids);
    assert.strictEqual(calls, 2);
    assert.strictEqual(store[t.K.snapshot("2")].bvids.length, 25);
    assert.deepStrictEqual(plain(store[t.K.removed]), {}, "moving between chosen folders sends nothing to 已取消收藏");
    assert.strictEqual(toasts.at(-1), "「源」已移动 25 个到「目标」");
    assert.deepStrictEqual(t.S.allFolders.map((f) => f.count), [0, 25, 0], "the folder counts follow the move");

    // A target outside triage: the moved videos go to 已出分拣范围 marked with it; ticking it takes them back.
    const two = [item(950), item(951)];
    store[t.K.snapshot("1")] = snap(two);
    openFake("1", two);
    handlers["triage-transfer"] = () => ({ ok: true });
    t.askTransfer = async () => ({ how: "move", target: { id: "3" } });
    handlers["triage-transfer"] = () => (openFake("removed", []), { ok: true });
    await t.fav.transfer(two);
    assert.deepStrictEqual(plain(t.S.items.map((it) => [it.bvid, it.movedTo.title])), [["BV951", "没勾"], ["BV950", "没勾"]], "已取消收藏 open meanwhile lists them");
    openFake("1", []);
    assert.deepStrictEqual(plain(store[t.K.removed].BV950.movedTo), { id: "3", title: "没勾" });
    assert.ok(toasts.at(-1).includes("已出分拣范围"), toasts.at(-1));
    handlers["triage-folder-ids"] = () => ({ ok: true, data: { bvids: ["BV950", "BV951", "BV999"] } });
    await t.recoverRemoved(["3"]);
    assert.deepStrictEqual(plain(store[t.K.removed]), {});
    assert.strictEqual(toasts.at(-1), "已从「已出分拣范围」找回 2 个视频");

    // R34: B站 kept some in 稍后再看 after adding them to the target: they stay listed here, the count only drops by the
    // ones that left, and the toast says so instead of 「已移动」.
    const pair = [item(970), item(971)];
    store[t.K.snapshot("1")] = snap(pair);
    openFake("1", pair);
    t.S.allFolders[0].count = 2;
    handlers["triage-transfer"] = () => ({ ok: true, data: { done: 1, stayed: [1971], stayedError: "B站返回 90001：不在" } });
    t.askTransfer = async () => ({ how: "move", target: { id: "2" } });
    await t.fav.transfer(pair);
    assert.deepStrictEqual(t.S.items.map((it) => it.bvid), ["BV971"]);
    assert.deepStrictEqual(store[t.K.snapshot("1")].bvids, ["BV971"]);
    assert.strictEqual(t.S.allFolders[0].count, 1);
    assert.strictEqual(toasts.at(-1), "1 个已收藏到「目标」，但没能从稍后再看移除：B站返回 90001：不在");
    openFake("removed", []);

    // 已出分拣范围 收藏到 a chosen folder: added with no source, back in that folder's list without the removed fields.
    store[t.K.removed] = { BV960: { item: item(960), at: 5 }, BV961: { item: item(961), at: 5 } };
    openFake("removed", [{ ...item(960), removedAt: 5 }, { ...item(961), removedAt: 5 }]);
    t.S.selected.add("BV960");
    t.renderListHeader(t.visibleItems());
    assert.ok((t.el.listHeader.innerHTML + t.el.favSel.innerHTML).includes("清理选中的 1 个") && !(t.el.listHeader.innerHTML + t.el.favSel.innerHTML).includes("清理这 2 个"), "清理 takes the selection");
    const adds = [];
    const busy = [];
    handlers["triage-transfer"] = (m) => (busy.push(t.fav.state().busy), adds.push([m.from, m.to, m.move, m.aids.length]), { ok: true });
    t.askTransfer = async () => ({ how: "add", target: { id: "2" } });
    await t.fav.transfer(t.S.items.slice());
    assert.deepStrictEqual(adds, [["", "2", false, 1], ["", "2", false, 1]], "one video per request");
    assert.strictEqual(busy[0], "收藏", "C625: others wait on 「收藏还在跑」, not 移动/复制");
    assert.deepStrictEqual(plain(store[t.K.removed]), {});
    assert.deepStrictEqual(plain(store[t.K.snapshot("2")].items.slice(0, 2)), [item(961), item(960)]);
    assert.strictEqual(toasts.at(-1), "已收藏 2 个到「目标」");
  }

  // 失效: a video Bilibili turns into a placeholder keeps what was known; one it hides (still in the id list, no longer
  // listed) goes to 已出分拣范围 marked hidden, and an id check never takes it out again.
  {
    const was = { bvid: "BV70", title: "原标题", cover: "c.jpg", upper: "UP", upperMid: "5", intro: "简介", duration: 90 };
    const now = { bvid: "BV70", title: "已失效视频", cover: "ph.jpg", upper: "", intro: "", duration: 0, invalid: true };
    assert.deepStrictEqual(plain(t.keepInvalidInfo([now, item(71)], [was])), [{ ...now, title: "原标题", cover: "c.jpg", upper: "UP", upperMid: "5", intro: "简介", duration: 90 }, item(71)]);
    const rec = t.updateRemoved({}, {}, [item(72), item(73)], [], new Set(), 9, ["BV72"], { id: "A", title: "甲" }).removed;
    const fromA = [{ id: "A", title: "甲", at: 9 }];
    assert.deepStrictEqual(plain(rec), { BV72: { item: item(72), at: 9, from: fromA, hidden: true }, BV73: { item: item(73), at: 9, from: fromA } });
    store[t.K.removed] = structuredClone(rec);
    assert.strictEqual(await t.dropRemoved(["BV72", "BV73"]), 1, "only the unhidden one leaves on an id match");
    assert.deepStrictEqual(Object.keys(store[t.K.removed]), ["BV72"]);
    // The 已失效 chip appears when the view has one and filters to them.
    openFake("I", [{ ...item(74), invalid: true }, item(75)]);
    t.S.tab = "read";
    assert.ok(row3().includes(">已失效 1<"));
    assert.ok(!row3().includes("已取消收藏") && !row3().includes("在未勾选收藏夹"), "why a video left is told only in 已出分拣范围");
    t.S.kindFilter = "invalid";
    assert.deepStrictEqual(plain(t.visibleItems().map((it) => it.bvid)), ["BV74"]);
    t.S.kindFilter = "";
  }

  // 观看进度 on covers: bar and 看完了 mark each follow the setting; 看完了 counts the set share only.
  {
    openFake("S", [item(80), item(81), item(82)]);
    t.S.seenPct = { BV80: [100, 1], BV81: [50, 1], BV82: null };
    const cfg = (bar, mark) => (t.S.seenCfg = { on: bar || mark, bar, mark, threshold: 80, style: "badge" });
    cfg(false, false);
    assert.ok(!t.coverHtml(t.S.items[0]).includes("seen-") && !t.isFinished(t.S.items[0]), "both off: nothing");
    cfg(true, false);
    assert.ok(t.coverHtml(t.S.items[1]).includes('style="width:50%"') && !t.coverHtml(t.S.items[0]).includes("seen-tag"), "bar only");
    cfg(false, true);
    const done = t.coverHtml(t.S.items[0]);
    assert.ok(done.includes("✓ 看完了") && !done.includes("seen-bar"), "mark only");
    assert.ok(!t.isFinished(t.S.items[1]) && !t.coverHtml(t.S.items[2]).includes("seen-"), "50% is under the threshold; no record, no mark");
    t.S.seenCfg.threshold = 50;
    assert.ok(t.coverHtml(t.S.items[1]).includes("✓ 看到 50%") && t.coverHtml(t.S.items[0]).includes("✓ 看完了"));
    t.S.seenCfg.threshold = 80;
    assert.ok(t.coverHtml(t.S.items[1]).includes('seen-tag faint">看到 50%'), "below the share: a faint 看到 N%");
    t.S.seenCfg.bar = true;
    assert.ok(t.coverHtml(t.S.items[1]).includes("faint") && t.coverHtml(t.S.items[1]).includes("seen-bar"), "with the bar too");
    t.S.seenCfg.bar = false;
    t.S.seenCfg.threshold = 50;
    // 看完了 chip from the history.
    t.S.tab = "read";
    assert.ok(row3().includes(">看完了 2<"));
    t.S.finishedFilter = true;
    assert.deepStrictEqual(plain(t.visibleItems().map((it) => it.bvid)), ["BV80", "BV81"]);
    t.S.finishedFilter = false;
    cfg(false, false);
  }

  // Row 3: one pick per group (again = clear), AND across groups, each group counted without its own pick; the
  // conditional chips last and gone at 0; 全部 clears row 3 only; 全选 heads the right-hand buttons.
  {
    openFake("R", [1, 2, 3, 4, 5, 6].map((n) => item(90 + n)));
    t.S.items[4].invalid = true; // BV95: 已失效, so 粗看完成 · 可清理
    const v = (verdict) => ({ verdict, confidence: "high" });
    Object.assign(t.S, { analyses: {}, titleRes: { BV91: v("keep"), BV92: v("keep"), BV93: v("drop"), BV94: v("unsure") }, classFilter: { coarse: "all", fine: "all", read: "all" }, tab: "coarse", query: "" });
    t.S.tags = [{ id: "ra", name: "甲", folder: "R", color: "#da86c3" }, { id: "rb", name: "乙", folder: "R", color: "#298287" }];
    t.S.videoTags = { BV91: ["ra"], BV93: ["ra", "rb"] };
    t.S.tagFilter.clear();
    t.S.selected.clear();
    const groups = () => [...row3().matchAll(/role="group" aria-label="([^"]+)"/g)].map((m) => m[1]);
    const has = (...parts) => parts.forEach((p) => assert.ok(row3().includes(p), p));
    assert.deepStrictEqual(groups(), ["全部", "按 AI 判断筛选", "按有没有标签", "已失效"], "fixed groups, then 已失效 (conditional) last");
    has(">全部 5<", ">值得留 2<", ">可清理 2<", ">拿不准 1<", ">已失效 1<");
    assert.ok(row3().startsWith('<span class="row-label">状态</span>'), "row 3 starts with its name");
    t.renderTabs();
    assert.ok(t.el.tagFilter.innerHTML.startsWith('<span class="row-label">标签</span>'), "row 4 starts with its name");
    assert.ok((t.el.listHeader.innerHTML + t.el.favSel.innerHTML).startsWith('<div class="step-actions"><button type="button" role="checkbox"'), "全选 heads the right-hand buttons");
    assert.strictEqual(t.el.searchCount.textContent, "", "no 「N 个结果」 with nothing on");
    // 未打标签 / 已打标签, as in 关注: by the tags the card shows, counted without its own pick, cleared by 全部.
    has(">未打标签 3<", ">已打标签 2<");
    t.pickState("tagged", "untagged");
    assert.deepStrictEqual(plain(t.visibleItems().map((it) => it.bvid)), ["BV92", "BV94", "BV95"], "untagged only");
    has('aria-pressed="true">未打标签 3<', ">已打标签 2<");
    t.pickState("tagged", "untagged");
    assert.strictEqual(t.S.tagState, "", "a second click clears it");
    t.pickState("tagged", "tagged");
    t.pickState("all");
    assert.strictEqual(t.S.tagState, "", "全部 clears it");
    t.pickState("class", "drop");
    has('aria-pressed="true">可清理 2<', '<button type="button" data-states-all aria-pressed="false">');
    t.pickState("kind", "invalid");
    assert.deepStrictEqual(plain(t.visibleItems().map((it) => it.bvid)), ["BV95"], "groups AND together");
    has('class="zero">值得留 0<', 'class="zero">拿不准 0<', ">可清理 1<", ">已失效 1<");
    assert.strictEqual(t.el.searchCount.textContent, "1 个结果", "filters on: 「N 个结果」 without a search");
    t.pickState("class", "drop");
    assert.strictEqual(t.S.classFilter.coarse, "all", "a second click clears the pick");
    t.pickState("kind", "invalid");
    t.pickState("class", "keep");
    t.pickState("class", "unsure");
    assert.strictEqual(t.S.classFilter.coarse, "unsure", "one pick per group: the other one replaces it");
    t.pickState("class", "unsure");
    // Conditional chips: 看完了 and AI 刚打的 join after 已失效; at 0 they go (unless on).
    t.S.seenCfg = { on: true, bar: false, mark: true, threshold: 80, style: "badge" };
    t.S.seenPct = { BV93: [100, 1] };
    t.S.aiRecent = { R: { bvids: ["BV94"] } };
    assert.deepStrictEqual(groups(), ["全部", "按 AI 判断筛选", "按有没有标签", "看完了", "已失效", "AI 刚打的"]);
    t.pickState("class", "unsure");
    assert.ok(!row3().includes("data-finishedfilter"), "看完了 at 0 (BV93 is 可清理) is not shown");
    t.S.tagFilter.add("rb");
    t.pickState("seen");
    assert.ok(row3().includes("data-finishedfilter"), "but stays while on");
    t.pickState("all");
    assert.ok(!t.S.finishedFilter && t.S.classFilter.coarse === "all" && t.S.tagFilter.has("rb"), "全部 clears row 3, not row 4");
    t.S.tagFilter.clear();
    // Row 4 counts the videos of the tab, row 3 applied; 未分析 has no AI group; 已保留 is 阅览全部's.
    t.pickState("class", "drop");
    t.renderTabs();
    assert.ok(t.el.tagFilter.innerHTML.includes('甲<span class="chip-n">1</span>') && t.el.tagFilter.innerHTML.includes('乙<span class="chip-n">1</span>'));
    t.pickState("all");
    t.S.tab = "none";
    assert.deepStrictEqual(groups().filter((g) => g !== "已失效"), ["全部", "按有没有标签"], "未分析: no AI verdict group");
    t.S.decisions = { BV92: { action: "keep", at: 1 } };
    t.S.tab = "read";
    has(">已保留 1<");
    t.S.tab = "coarse";
    assert.ok(!row3().includes("已保留"));
    Object.assign(t.S, { decisions: {}, aiRecent: {}, seenPct: {}, titleRes: {}, tags: [], videoTags: {} });
    t.S.seenCfg = { on: false, bar: false, mark: false, threshold: 80, style: "badge" };
  }

  {
    // Overlapping read-modify-writes of one record each read it before the other wrote; neither change may be lost.
    openFake("S", []);
    store[t.K.removed] = { BV90: { item: item(90), at: 1 } };
    t.S.folders = [];
    await Promise.all([t.dropRemoved(["BV90"]), t.addMovedToRemoved("S", [item(91)], "T")]);
    assert.deepStrictEqual(Object.keys(store[t.K.removed]), ["BV91"], "已取消收藏: the drop and the add both land");
    delete store[t.K.decisions("S")];
    await Promise.all([t.patchDecisions("S", { BV92: { action: "unfav" } }), t.patchDecisions("S", { BV93: { action: "unfav" } })]);
    assert.deepStrictEqual(Object.keys(store[t.K.decisions("S")]).sort(), ["BV92", "BV93"], "two decision patches both land");
    // Two folders' cached lists patched at once both add to the shared trail of where videos left.
    const snap = (b) => ({ bvids: [b], invalid: [], titles: {}, items: [item(+b.slice(2))], ids: [b], intro: "" });
    Object.assign(store, { [t.K.snapshot("S")]: snap("BV94"), [t.K.snapshot("T")]: snap("BV95"), [t.K.left]: {} });
    await Promise.all([t.patchSnapshot("S", { drop: ["BV94"] }), t.patchSnapshot("T", { drop: ["BV95"] })]);
    assert.deepStrictEqual(Object.keys(store[t.K.left]).sort(), ["BV94", "BV95"], "both moves are in the trail");
    for (const k of [t.K.snapshot("S"), t.K.snapshot("T"), t.K.left]) delete store[k];
    delete store[t.K.removed];
    delete store[t.K.decisions("S")];
  }

  {
    // A read held back until a test lets it go: the slow one of two overlapping async flows.
    const realGet = ctx.chrome.storage.local.get;
    const holdRead = (key) => {
      let open;
      const gate = new Promise((r) => (open = r));
      ctx.chrome.storage.local.get = async (k) => {
        if (k === key) {
          ctx.chrome.storage.local.get = realGet;
          await gate;
        }
        return realGet(k);
      };
      return open;
    };
    const settle = async () => {
      for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
    };
    t.syncFolder = async () => true;
    Object.assign(t.S, { folders: [{ id: "PA", title: "A" }, { id: "PB", title: "B" }], kept: {} });
    t.el.folderSelect = { value: "", querySelector: () => null };
    store.triage_snapshot_PA = { bvids: ["BV71"], ids: ["BV71"], items: [item(71)], intro: "" };
    store.triage_snapshot_PB = { bvids: ["BV72"], ids: ["BV72"], items: [item(72)], intro: "" };
    handlers["triage-folder-ids"] = ({ mediaId }) => ({ ok: true, data: { bvids: [mediaId === "PA" ? "BV71" : "BV72"] } });
    handlers["triage-title-get"] = handlers["triage-analysis-get"] = () => ({ ok: true, data: {} });

    // Two quick folder switches: the first folder's slow read finishing last must not take the view back.
    const releaseA = holdRead(t.K.decisions("PA"));
    const openA = t.openFolder("PA");
    await t.openFolder("PB");
    releaseA();
    await openA;
    await settle();
    assert.deepStrictEqual([t.S.mediaId, plain(t.S.items.map((it) => it.bvid))], ["PB", ["BV72"]], "the last folder clicked stays open");

    // A full sync whose folder changes while it reads the old list leaves the new folder's list alone.
    t.syncFolder = realSync;
    openFake("PA", [item(71)]);
    t.S.syncing = false;
    handlers["triage-folder-items"] = () => ({ ok: true, data: { items: [item(71), item(73)], ids: ["BV71", "BV73"] } });
    const releaseSnap = holdRead(t.K.snapshot("PA"));
    const sync = t.syncFolder({ force: true });
    await settle();
    openFake("PB", [item(72)]);
    releaseSnap();
    assert.strictEqual(await sync, false, "the stale sync gives up");
    assert.deepStrictEqual(plain(t.S.items.map((it) => it.bvid)), ["BV72"], "folder B keeps its own list");
    // A batch write that starts while a full sync reads the folder: the list read is from before it, so the sync drops it.
    openFake("PA", [item(71)]);
    t.S.syncing = false;
    const releaseSnap2 = holdRead(t.K.snapshot("PA"));
    const sync2 = t.syncFolder({ force: true });
    await settle();
    const h = holdNext("triage-unfav");
    const writing = t.fav.unfavMany([item(71)]);
    await settle();
    releaseSnap2();
    assert.strictEqual(await sync2, false, "the sync read before the write gives up");
    assert.deepStrictEqual([plain(t.S.items.map((it) => it.bvid)), store.triage_snapshot_PA.bvids], [["BV71"], ["BV71"]], "the list stays");

    // A read deferred for a folder being written is not dropped because another folder's read was waiting first.
    const ran = [];
    openFake("PA", []);
    t.deferRead(() => ran.push("A"));
    openFake("PB", []);
    t.deferRead(() => ran.push("B"));
    await settle();
    assert.deepStrictEqual(ran, ["B"], "the open folder's deferred read runs");
    // A pending full sync is not downgraded to the light check by a later request.
    ran.length = 0;
    t.deferRead(() => ran.push("full"), true);
    t.deferRead(() => ran.push("quick"));
    await settle();
    assert.deepStrictEqual(ran, ["full"]);
    h.release();
    await writing;
    await settled();
    t.syncFolder = realSync;
  }
  // The pointer takes the current card only on real movement; a mousemove at the last position (scroll, re-render) is ignored.
  assert.ok(t.pointerMoved(null, 10, 10), "first pointer event counts as movement");
  assert.ok(!t.pointerMoved({ x: 10, y: 10 }, 10, 10), "same position is not movement");
  assert.ok(t.pointerMoved({ x: 10, y: 10 }, 10, 11), "a changed coordinate is movement");

  // .ai-review-head styled nothing the pages draw.
  assert.ok(!fs.readFileSync(path.join(__dirname, "triage.css"), "utf8").includes(".ai-review-head"), "unused .ai-review-head is gone");

  // 一篇摘录's title time comes from fmtTime, not formatted again by hand.
  assert.ok(t.buildMarkdown([], {}, new Date(2026, 0, 2, 3, 4)).includes("title: B站摘录 2026-01-02 03:04\n"));
  assert.ok(!/pad\(now\.getHours\(\)\)/.test(source), "buildMarkdown uses fmtTime");

  // The list and its lookup map change together, in setItems only.
  assert.strictEqual(source.match(/S\.itemMap = /g).length, 1, "S.itemMap is set only by setItems");

  // The page opens on one round of storage reads: init awaits none of them one after another.
  assert.ok(!/= await storeGet\(/.test(vm.runInContext("init.toString()", ctx)), "init reads storage in its Promise.all");

  // passFilter runs per video several times a render: the 「AI 刚打的」 set and the search words are built once per change.
  {
    const [aiRecentSet, queryWords] = vm.runInContext("[aiRecentSet, queryWords]", ctx);
    const saved = { mediaId: t.S.mediaId, aiRecent: t.S.aiRecent, query: t.S.query };
    Object.assign(t.S, { mediaId: "R", aiRecent: { R: { at: 1, bvids: ["BV1"] } }, query: "A  b" });
    const set = aiRecentSet();
    assert.ok(set.has("BV1") && aiRecentSet() === set, "one set until the list changes");
    t.S.aiRecent = { R: { at: 2, bvids: ["BV2"] } };
    assert.ok(aiRecentSet().has("BV2") && !aiRecentSet().has("BV1"), "a new list, a new set");
    const words = queryWords();
    assert.ok(queryWords() === words && words.join() === "a,b");
    t.S.query = "c";
    assert.strictEqual(queryWords().join(), "c");
    Object.assign(t.S, saved);
  }

  // X (and a card click) marks just that card and redraws the selection bar, not the whole list; 粗看完成 redraws all,
  // since there the selection is the next batch (its order and labels).
  {
    const realList = t.el.list, realRender = t.render;
    const marks = {};
    const cards = ["BV1", "BV2"].map((bvid) => ({ dataset: { bvid }, classList: { toggle: (c, on) => (marks[bvid] = on) } }));
    t.el.list = { querySelectorAll: () => cards, querySelector: () => null };
    let renders = 0;
    t.render = () => renders++;
    openFake("A", [item(1), item(2)]);
    Object.assign(t.S, { tab: "none" });
    t.S.selected.clear();
    t.cardAction("select", "BV2");
    assert.deepStrictEqual([renders, marks, (t.el.listHeader.innerHTML + t.el.favSel.innerHTML).includes("已选中 1 个")], [0, { BV1: false, BV2: true }, true]);
    t.S.tab = "coarse";
    t.cardAction("select", "BV2");
    assert.ok(renders === 1 && !t.S.selected.size, "粗看完成 draws the list again");
    Object.assign(t, { render: realRender });
    t.el.list = realList;
    t.S.tab = "none";
  }

  // J/K and a card that leaves the list go by the cards on screen; no focus index is kept (hovering cards stays cheap).
  {
    const realList = t.el.list, realFocus = t.setFocus;
    const cards = ["BV1", "BV2", "BV3"].map((bvid) => ({ dataset: { bvid } }));
    t.el.list = { querySelectorAll: (sel) => (sel === ".card" ? cards : []), querySelector: () => null, scrollTop: 0, innerHTML: "" };
    const went = [];
    t.setFocus = (b) => went.push(b);
    assert.ok(!("focusIndex" in t.S), "no focus index state");
    t.S.focused = "BV2";
    t.moveFocus(1);
    t.moveFocus(-1);
    t.S.focused = "BV3";
    t.moveFocus(1);
    assert.deepStrictEqual(went, ["BV3", "BV1", "BV3"]);
    // BV2 leaves the list: the card now in its place takes the focus.
    openFake("A", [item(1), item(3)]);
    Object.assign(t.S, { tab: "none", focused: "BV2" });
    t.renderList();
    assert.strictEqual(t.S.focused, "BV3");
    Object.assign(t.el, { list: realList });
    t.setFocus = realFocus;
  }

  // Card links: cover and title are a[href] to the video (right-click / ⌘-click open it natively), no control inside a link;
  // a plain primary click stays in the page: on the title it opens the viewer, on the cover it selects the card.
  {
    const html = t.cardHtml(item(1), false, "");
    const links = [...html.matchAll(/<a\b[^>]*>/g)].map((m) => m[0]);
    assert.strictEqual(links.length, 2, html);
    for (const a of links) assert.ok(a.includes(`href="https://www.bilibili.com/video/${item(1).bvid}"`), a);
    assert.deepStrictEqual(links.map((a) => a.includes('data-act="open"')), [false, true], "only the title plays");
    assert.ok(!/<a\b(?:(?!<\/a>).)*<(button|a|input)\b/s.test(html), "nothing interactive inside a link");
    const click = (o) => ({ button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...o });
    assert.ok(t.plainClick(click({})), "plain click opens the viewer");
    for (const k of ["metaKey", "ctrlKey", "shiftKey", "altKey"]) assert.ok(!t.plainClick(click({ [k]: true })), `${k}-click is the browser's`);
    assert.ok(!t.plainClick(click({ button: 1 })), "middle click is the browser's");
  }

  // An old 已出分拣范围 record without `from` gets its folder from a 取消收藏 decision made there; keep/none give nothing.
  {
    const title = (id) => ({ f1: "稍后-AI", f2: "学习" })[id] || id;
    assert.deepStrictEqual(plain(t.inferFrom({ f1: { BV1: { action: "unfav" } }, f2: { BV1: { action: "keep" } } }, "BV1", title)), [{ id: "f1", title: "稍后-AI" }]);
    assert.deepStrictEqual(plain(t.inferFrom({ f1: { BV1: { action: "unfav" } }, f2: { BV1: { action: "unfav" } } }, "BV1", title)), [{ id: "f1", title: "稍后-AI" }, { id: "f2", title: "学习" }]);
    assert.strictEqual(t.inferFrom({ f1: { BV2: { action: "unfav" } } }, "BV1", title), undefined);
  }

  // Tag chips intersect: every selected tag name must be on the video; same-named tags of two folders count as one.
  {
    const name = (id) => ({ a1: "AI", a2: "AI", m: "数学", t: "工具" })[id];
    assert.ok(t.hasAllTags(["a1", "m"], ["a1", "a2", "m"], name), "has AI (either folder's) and 数学");
    assert.ok(!t.hasAllTags(["a1"], ["a1", "a2", "m"], name), "missing 数学 fails");
    assert.ok(t.hasAllTags(["a2"], ["a1", "a2"], name), "one merged chip needs only one of its ids");
    assert.ok(!t.hasAllTags(["t"], ["a1", "a2"], name), "no selected tag fails");
  }

  // 收藏夹 search and the IME: nothing runs mid-composition, compositionend searches the committed text.
  {
    const ls = {};
    const input = { value: "", addEventListener: (type, fn) => ((ls[type] ||= []).push(fn)) };
    const fire = (type, e = {}) => (ls[type] || []).forEach((fn) => fn(e));
    const wait = () => new Promise((r) => setTimeout(r, 20));
    // Run bindEvents on fresh stub elements (earlier tests swapped some for plain objects); the stub DOM gives out
    // after the search box is wired, which is all this needs.
    const real = { ...t.el };
    for (const k of Object.keys(real)) t.el[k] = stubEl();
    t.el.searchInput = input;
    try {
      vm.runInContext("bindEvents()", ctx);
    } catch {}
    Object.assign(t.el, real);
    assert.ok(ls.compositionend, "bindEvents wires the search box through bindLive");
    t.S.query = "";
    fire("compositionstart");
    input.value = "l";
    fire("input", { isComposing: true });
    input.value = "lu";
    fire("input", { isComposing: true });
    await wait();
    assert.strictEqual(t.S.query, "", "no search while composing");
    input.value = "路";
    fire("compositionend");
    await wait();
    assert.strictEqual(t.S.query, "路", "compositionend searches the committed text");
    input.value = "路a";
    fire("input", { isComposing: false });
    fire("compositionstart");
    await wait();
    assert.strictEqual(t.S.query, "路", "a pending search is dropped when composition starts");
  }

  // IME: Enter or a pause mid-composition never acts on the half-typed pinyin. bindEvents runs on recording stubs.
  {
    const L = {};
    const rec = (n) => new Proxy({ classList: { toggle() {}, add() {}, remove() {}, contains: () => false }, style: {}, dataset: {}, addEventListener: (type, f) => ((L[n] ||= {})[type] ||= []).push(f), querySelector: () => rec(`${n}?`), querySelectorAll: () => [] }, {
      get: (o, k) => (k in o ? o[k] : () => {}),
      set: (o, k, v) => ((o[k] = v), true)
    });
    const real = { ...t.el };
    for (const k of Object.keys(real)) t.el[k] = rec(k);
    const W = {};
    const realWin = ctx.window.addEventListener;
    ctx.window.addEventListener = (type, f) => (W[type] ||= []).push(f);
    vm.runInContext("bindEvents()", ctx);
    ctx.window.addEventListener = realWin;
    const fire = (n, type, e) => (L[n][type] || []).forEach((f) => f(e));
    // C676: clicks a button as drawn in html, found by its words: the click handlers on path (the element and those it
    // bubbles through) get its data-* values, as the page's [data-head] lookup reads them.
    const press = (html, words, path) => {
      const btn = [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].find(([, attrs, inner]) => /\bdata-head=/.test(attrs) && inner.replace(/<[^>]*>/g, "").includes(words));
      assert.ok(btn, `no drawn button says ${words}: ${html}`);
      const dataset = Object.fromEntries([...btn[1].matchAll(/\bdata-([\w-]+)="([^"]*)"/g)].map(([, k, v]) => [k, v]));
      const e = { target: { closest: (sel) => (sel === "[data-head]" ? { dataset } : null) } };
      for (const n of path) (L[n]?.click || []).forEach((f) => f(e));
    };
    // Row 3 as drawn now; its clicks bubble through stagebar.
    const pressRow3 = (words) => (t.renderListHeader(t.visibleItems()), press(t.el.listHeader.innerHTML, words, ["listHeader", "stagebar"]));

    // C671: saving 收藏夹设置 redraws, so row 3 shows the new batch sizes.
    {
      const was = { render: t.render, allFolders: t.S.allFolders };
      let drawn = 0;
      t.render = () => drawn++;
      t.S.allFolders = [];
      t.el.settingsDialog.returnValue = "save";
      handlers["triage-settings-save"] = () => ({ ok: true });
      fire("settingsDialog", "close");
      for (let i = 0; i < 5; i++) await new Promise(setImmediate);
      assert.ok(drawn > 0, "redrawn after the save");
      Object.assign(t, { render: was.render });
      t.S.allFolders = was.allFolders;
      delete handlers["triage-settings-save"];
    }

    // H1: 收藏夹 follows its settings written elsewhere (导入设置), and a save writes only the fields changed in the dialog,
    // so an import that lands while it is open is not put back.
    {
      const was = { render: t.render, allFolders: t.S.allFolders, settings: { ...t.S.settings } };
      t.render = () => {};
      t.S.allFolders = [];
      handlers["triage-settings-get"] = () => ({ ok: true, data: { ...was.settings, triageTagLimit: 7, triageAiBatchSize: 9 } });
      assert.strictEqual(t.followSettings({ obsidianEnabled: { newValue: true } }), undefined, "other keys ask nothing");
      await t.followSettings({ triageTagLimit: { newValue: 7 } });
      assert.deepStrictEqual([t.S.settings.triageTagLimit, t.S.settings.triageAiBatchSize], [7, 9], "the stored values are taken");
      t.openSettings();
      await new Promise(setImmediate);
      t.el.intervalInput.value = "99";
      let saved = null;
      handlers["triage-settings-save"] = (m) => ((saved = m), { ok: true });
      t.el.settingsDialog.returnValue = "save";
      fire("settingsDialog", "close");
      for (let i = 0; i < 5; i++) await new Promise(setImmediate);
      const { type, aiProviderId, ...patch } = saved;
      assert.deepStrictEqual(plain(patch), { triageIntervalSec: 99 }, "only the edited field is written");
      // R24: the folder ticks too. An import that changed the folder choice while the dialog was open stays when the
      // ticks were left as they opened; ticks the user changed are written.
      const keep = { included: t.S.included, applyIncluded: t.applyIncluded, folderToggles: t.el.folderToggles };
      const applied = [];
      t.applyIncluded = async (x) => applied.push(plain(x));
      let ticked = ["1"];
      t.el.folderToggles = { querySelectorAll: () => ticked.map((value) => ({ value })) };
      Object.assign(t.S, { allFolders: [{ id: 1, title: "一" }, { id: 2, title: "二" }], included: ["1"] });
      const close = async () => {
        t.openSettings();
        t.S.included = store[t.K.included] = ["1", "2"]; // 导入设置 lands
        t.el.settingsDialog.returnValue = "save";
        fire("settingsDialog", "close");
        for (let i = 0; i < 5; i++) await new Promise(setImmediate);
      };
      await close();
      assert.deepStrictEqual([plain(store[t.K.included]), applied], [["1", "2"], []], "the imported choice stays");
      t.S.included = ["1"];
      t.openSettings();
      ticked = ["2"];
      t.el.settingsDialog.returnValue = "save";
      fire("settingsDialog", "close");
      for (let i = 0; i < 5; i++) await new Promise(setImmediate);
      assert.deepStrictEqual([plain(store[t.K.included]), applied], [["2"], [["2"]]], "a changed tick is written");
      Object.assign(t, { applyIncluded: keep.applyIncluded });
      Object.assign(t.S, { included: keep.included });
      t.el.folderToggles = keep.folderToggles;
      Object.assign(t, { render: was.render });
      Object.assign(t.S.settings, was.settings);
      t.S.allFolders = was.allFolders;
      delete handlers["triage-settings-save"];
      delete handlers["triage-settings-get"];
    }

    // The selection bar's slot (outside stagebar) sends its clicks to the same handler.
    assert.strictEqual(L.favSel?.click?.length, 1);
    // 全选 sits in listHeader inside stagebar: one click bubbles through both and selects once, not on and off again.
    {
      openFake("A", [item(1), item(2)]);
      const was = { tab: t.S.tab, query: t.S.query };
      Object.assign(t.S, { tab: "read", query: "" });
      t.S.selected.clear();
      pressRow3("全选");
      assert.deepStrictEqual(plain([...t.S.selected]), ["BV1", "BV2"], "one click on 全选 selects all");
      t.S.selected.clear();
      Object.assign(t.S, was);
    }

    // J5: each AI step's 所有收藏夹 dialog is titled like the button that opened it.
    {
      openFake("A", [item(1), item(2), item(3)]);
      const was = { tab: t.S.tab, titleRes: t.S.titleRes, analyses: t.S.analyses, query: t.S.query, folderCriteria: t.S.folderCriteria };
      const titles = [];
      const realStart = t.startJudging;
      t.startJudging = async (title) => titles.push(title);
      Object.assign(t.S, { tab: "none", query: "", titleRes: {}, analyses: {}, folderCriteria: { A: "新" } });
      t.S.selected.clear();
      pressRow3("标题粗看下一批 3 个");
      const old = { verdict: "unsure", criteria: "旧" };
      Object.assign(t.S, { tab: "coarse", titleRes: { BV1: old, BV2: old, BV3: { ...old, criteria: "新" } } });
      t.S.selected = new Set(["BV1"]);
      pressRow3("字幕细看选中的 1 个");
      pressRow3("按新标准重新粗看选中的 1 个");
      Object.assign(t.S, { tab: "fine", analyses: { BV3: { status: "done", verdict: "keep", criteria: "旧" } } });
      t.S.selected.clear();
      pressRow3("按新标准重新细看下一批 1 个");
      assert.deepStrictEqual(titles, ["标题粗看下一批 3 个", "字幕细看选中的 1 个", "按新标准重新粗看选中的 1 个", "按新标准重新细看下一批 1 个"]);
      t.startJudging = realStart;
      t.S.selected.clear();
      Object.assign(t.S, was);
    }

    // F4: 字幕细看 keeps its batch selected, like 标题粗看; the cards leave the selection when they leave the tab.
    {
      openFake("A", [item(1), item(2), item(3)]);
      const was = { tab: t.S.tab, titleRes: t.S.titleRes, analyses: t.S.analyses, query: t.S.query };
      Object.assign(t.S, { tab: "coarse", query: "", titleRes: { BV1: { verdict: "unsure" }, BV2: { verdict: "unsure" }, BV3: { verdict: "unsure" } }, analyses: {} });
      t.S.selected = new Set(["BV1", "BV2"]);
      let release;
      handlers["triage-analyze"] = ({ bvid }) => new Promise((r) => (release = () => r({ ok: true, data: { bvid, status: "done", verdict: "keep" } })));
      pressRow3("字幕细看选中的 2 个");
      await new Promise((r) => setImmediate(r));
      assert.ok(t.S.group && t.S.selected.has("BV1") && t.S.selected.has("BV2"), "the batch stays selected while it runs");
      vm.runInContext("runs", ctx).stop("group");
      release();
      for (let i = 0; i < 50 && t.S.group; i++) await new Promise((r) => setImmediate(r));
      t.renderListHeader(t.visibleItems());
      assert.deepStrictEqual(plain([...t.S.selected]), ["BV2"], "a card the run moved to 细看完成 leaves the selection");
      t.S.selected.clear();
      Object.assign(t.S, was);
      await vm.runInContext("runs", ctx).run("group", { line: () => "", next: () => null });
    }

    // T pressed in the player (viewer-frame.js) opens the picker under the viewer line; only from the viewer's frame.
    {
      openFake("A", [item(1)]);
      const frame = {};
      t.el.viewerFrame = { contentWindow: frame };
      t.S.viewing = "BV1";
      t.S.viewer = t.viewerOf("BV1");
      const msg = (source) => W.message.forEach((f) => f({ source, origin: "https://www.bilibili.com", data: { type: "mdg-viewer-key", key: "t" } }));
      po = null;
      msg({});
      assert.strictEqual(po, null, "another frame");
      msg(frame);
      assert.strictEqual(po?.anchor, "#viewerTags .tag-plus");
      // Esc in the player closes it, as Esc on the page does.
      const esc = () => W.message.forEach((f) => f({ source: frame, origin: "https://www.bilibili.com", data: { type: "mdg-viewer-key", key: "Escape" } }));
      esc();
      assert.strictEqual(t.S.viewing, "", "Esc from the player closes it");
      // One listener for both modes: with 关注 on, its keys get the player's keys and 收藏夹's do not run.
      assert.strictEqual(W.message.length, 1);
      const got = [];
      t.MoonTriage.setModeKeys((k) => (got.push(k), true));
      t.S.viewing = "BV1";
      po = null;
      msg(frame);
      esc();
      assert.ok(got.join() === "t,Escape" && po === null && t.S.viewing === "BV1", "关注 gets T and Esc");
      t.MoonTriage.setModeKeys(null);
      t.S.viewing = "";
    }
    // S5: B站's autoplay moves the player to another video: the 分拣台 follows it (pink card, tag line, T); a video in no
    // chosen folder has no lines; closing still refreshes the folder of the one played first.
    {
      openFake("A", [item(1), item(2)]);
      const frame = {};
      t.el.viewerFrame = { contentWindow: frame };
      const show = (bvid, source = frame) => W.message.forEach((f) => f({ source, origin: "https://www.bilibili.com", data: { type: "mdg-viewer-video", bvid } }));
      const realEl = { viewer: t.el.viewer, main: t.el.main };
      Object.assign(t.el, { viewer: {}, main: { classList: { add() {}, remove() {} } } });
      t.openViewer(item(1));
      show("BV1");
      assert.strictEqual(t.S.viewing, "BV1");
      show("BV2", {});
      assert.strictEqual(t.S.viewing, "BV1", "another frame");
      show("BV2");
      assert.deepStrictEqual([t.S.viewing, t.S.viewer?.item.bvid, plain(t.S.viewer?.folders)], ["BV2", "BV2", ["A"]]);
      show("BV1unknown");
      for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
      assert.deepStrictEqual([t.S.viewing, t.S.viewer], ["BV1unknown", null], "unknown: no lines, T does nothing");
      const realQuick = t.quickSync;
      let quick = 0;
      t.quickSync = () => quick++;
      t.closeViewer();
      t.quickSync = realQuick;
      assert.strictEqual(quick, 1, "A is refreshed on close");
      show("BV2");
      assert.strictEqual(t.S.viewing, "", "closed: ignored");
      Object.assign(t.el, realEl);
    }
    // 停止 on a 收藏夹 batch write's pill (as 关注's): pressed, it says 停止中 (disabled, with why) until the request in
    // flight lands; what went through stays, recorded and undoable. A batch undo stopped the same way keeps the rest for U.
    {
      const vids = [1, 2, 3, 4].map((n) => item(90 + n));
      const stopAt = (type, aid) => {
        const h = { inFlight: false, release: null };
        handlers[type] = (m) => ((m.aid ?? m.aids[0]) === aid ? ((h.inFlight = true), new Promise((r) => (h.release = () => r({ ok: true })))) : { ok: true });
        return h;
      };
      const pressStop = async (h) => {
        for (let i = 0; i < 500 && !h.inFlight; i++) await new Promise((r) => setTimeout(r, 2));
        assert.deepStrictEqual([t.activityState().act, t.activityState().actLabel], ["fav", "停止"]);
        t.renderStatus();
        press(t.el.activity.innerHTML, "停止", ["activity"]);
        assert.deepStrictEqual([t.activityState().actLabel, t.activityState().stopping], ["停止中", true]);
        t.renderStatus();
        assert.ok(t.el.activity.innerHTML.includes('aria-label="停止中" disabled title="当前这一批做完就停止"'), t.el.activity.innerHTML);
        h.release();
      };
      openFake("toview", vids);
      const unfavs = stopAt("triage-unfav", 1092);
      const running = t.fav.unfavMany(vids);
      await pressStop(unfavs);
      await running;
      assert.deepStrictEqual([Object.keys(store[t.K.decisions("toview")]), toasts.at(-1)], [["BV91", "BV92"], "已停止批量取消收藏：完成 2 个，未完成 2 个 · U 撤销已完成的"]);
      const refavs = stopAt("triage-refav", 1091);
      const undoing = t.undo();
      await pressStop(refavs);
      await undoing;
      assert.deepStrictEqual([Object.keys(store[t.K.decisions("toview")]), toasts.at(-1), t.S.undo.length], [["BV92"], "已停止撤销：完成 1 个，未完成 1 个，可再按 U 撤销", 1]);
      await t.undo();
      assert.deepStrictEqual([store[t.K.decisions("toview")], toasts.at(-1)], [{}, "已重新收藏 1 个"]);
      // 移动 / 复制 stopped: the ones copied stay, and it says how far it got.
      const saved = { allFolders: t.S.allFolders, folders: t.S.folders, included: t.S.included, ask: t.askTransfer };
      t.S.allFolders = t.S.folders = [{ id: "toview", title: "稍后再看" }, { id: "T", title: "目标" }];
      t.S.included = ["toview", "T"];
      t.askTransfer = async () => ({ how: "copy", target: { id: "T" } });
      const copies = stopAt("triage-transfer", 1093);
      const copying = t.fav.transfer(vids);
      await pressStop(copies);
      await copying;
      assert.strictEqual(toasts.at(-1), "已停止复制到「目标」：完成 3 个，未完成 1 个");
      Object.assign(t.S, { allFolders: saved.allFolders, folders: saved.folders, included: saved.included });
      t.askTransfer = saved.ask;
      handlers["triage-unfav"] = handlers["triage-refav"] = handlers["triage-transfer"] = () => ({ ok: true });
      await new Promise((r) => setTimeout(r, 60));
      openFake("A", [item(1)]);
    }
    const doc = (type) => docL[type].forEach((f) => f({}));
    const wait = () => new Promise((r) => setTimeout(r, 20));
    const key = (k, target, o = {}) => ({ key: k, target, isComposing: false, keyCode: 0, prevented: 0, preventDefault() { this.prevented++; }, ...o });
    const field = (sel, value = "") => ({ value, matches: (s) => s.split(", ").includes(sel), closest: () => ({ dataset: { bvid: "BV1" } }) });

    // The player has no top bar; its only control is the round × on the corner (outside #viewer), and Esc.
    {
      const html = fs.readFileSync(path.join(__dirname, "triage.html"), "utf8");
      const viewer = html.slice(html.indexOf('<aside id="viewer"'), html.indexOf("</aside>", html.indexOf('<aside id="viewer"')));
      assert.ok(viewer && !/viewer-head|viewerTitle|viewerFocusBtn|viewerTabBtn|专注模式|在 B站打开/.test(viewer), "no top bar in the player");
      // No 已看，下一个 either: the 待播 panel's 移除 and 清空 take videos out.
      for (const f of ["triage/triage.html", ...PS.triage, "triage/follow.css", "../README.md"]) {
        assert.ok(!/已看，下一个|viewerNextBtn|viewerBasket|basketDoneAndNext/.test(PS.read(f)), `${f} still has 已看，下一个`);
      }
      assert.ok(!/viewer-head/.test(fs.readFileSync(path.join(__dirname, "triage.css"), "utf8")), "no top bar CSS");
      assert.ok(/<\/aside>\s*<!--[^>]*-->\s*<button id="viewerCloseBtn" type="button" class="viewer-close" aria-label="关闭播放（Esc）" title="关闭播放（Esc）">×<\/button>/.test(html), "× right after #viewer, labeled");
      openFake("A", [item(1)]);
      t.openViewer(t.S.itemMap.get("BV1"));
      fire("viewerCloseBtn", "click");
      assert.strictEqual(t.S.viewing, "", "× closes the player");
      t.openViewer(t.S.itemMap.get("BV1"));
      t.onKey(key("Escape", {}));
      assert.strictEqual(t.S.viewing, "", "Esc closes the player");
      // 待播's 移除: out of the list, a toast that says so, U puts it back.
      t.S.basket = [{ bvid: "BV1" }, { bvid: "BV2" }];
      const btn = { closest: (s) => (s === "[data-basket]" ? { dataset: { basket: "remove" } } : { dataset: { i: "0" } }) };
      fire("basketList", "click", { target: btn });
      assert.deepStrictEqual([t.S.basket.map((x) => x.bvid), toasts.at(-1)], [["BV2"], "已从待播移除 · U 撤销"]);
      await t.undo();
      assert.deepStrictEqual(t.S.basket.map((x) => x.bvid), ["BV1", "BV2"], "U puts it back");
      t.S.basket = [];
    }
    openFake("A", [item(1)]);

    // The tag row: 标签管理 opens 标签管理, ✦ AI 打标签 opens AI 打标签, each its own dialog.
    const hit = (sel) => ({ target: { closest: (s) => (s === sel ? {} : null) } });
    dialogs.length = 0;
    fire("aiTagSlot", "click", hit("[data-tags-manage]"));
    fire("aiTagSlot", "click", hit("[data-ai-tag]"));
    assert.deepStrictEqual(dialogs.map(([kind, a]) => [kind, a.who]), [["manage", "视频"], ["ai", "视频"]], "each button opens its own dialog");

    // a card note saves nothing mid-composition, compositionend saves the committed text.
    delete store[t.K.notes];
    t.S.notes = {};
    const note = field("[data-note]", "zhong");
    fire("list", "input", { target: note, isComposing: true });
    await wait();
    assert.strictEqual(store[t.K.notes], undefined, "no save while composing");
    assert.strictEqual(t.S.notes.BV1, undefined);
    note.value = "中";
    fire("list", "compositionend", { target: note });
    await wait();
    assert.strictEqual(store[t.K.notes].BV1.text, "中");
    // this page's own save coming back is not a re-render; another page's edit is.
    let renders = 0;
    const realRender = t.render;
    t.render = () => renders++;
    t.followNotes({ [t.K.notes]: { newValue: structuredClone(store[t.K.notes]) } });
    assert.strictEqual(renders, 0, "own echo ignored");
    t.followNotes({ [t.K.notes]: { newValue: { BV1: { text: "侧边栏改的", updatedAt: 1 } } } });
    assert.strictEqual(renders, 1);
    assert.strictEqual(t.S.notes.BV1.text, "侧边栏改的");
    // A note the side panel saves while this card's note waits its 400 ms is kept: the save writes only this card's entry
    // over a fresh read (MdgLimits.saveVideoNote), and the outside change shows without dropping what is being typed.
    const texts = () => plain(Object.fromEntries(Object.entries(store[t.K.notes]).map(([b, n]) => [b, n.text])));
    note.value = "中文";
    fire("list", "input", { target: note });
    store[t.K.notes] = { ...store[t.K.notes], BV2: { text: "侧边栏的", updatedAt: 2 } };
    await wait();
    assert.deepStrictEqual(texts(), { BV1: "中文", BV2: "侧边栏的" }, "the save does not write back a stale map");
    note.value = "中文字";
    fire("list", "input", { target: note });
    store[t.K.notes] = { ...store[t.K.notes], BV3: { text: "视频记录的", updatedAt: 3 } };
    t.followNotes({ [t.K.notes]: { newValue: structuredClone(store[t.K.notes]) } });
    assert.deepStrictEqual([t.S.notes.BV1.text, t.S.notes.BV3.text, renders], ["中文字", "视频记录的", 1], "pending text kept, no re-render under it");
    await wait();
    assert.deepStrictEqual(texts(), { BV1: "中文字", BV2: "侧边栏的", BV3: "视频记录的" });
    t.render = realRender;
    // 开启思考 follows the platform the side panel picks now: opening 收藏夹设置 asks the background again.
    handlers["triage-settings-get"] = () => ({ ok: true, data: { thinkingToggle: true } });
    t.S.settings.thinkingToggle = false;
    t.openSettings();
    await wait();
    assert.deepStrictEqual([t.S.settings.thinkingToggle, t.el.thinkingRow.hidden], [true, false], "the switch follows the platform in use");
    delete handlers["triage-settings-get"];
    t.el.settingsDialog.close?.();
    // a background re-render waits while a note is composing, and runs on compositionend.
    t.S.items = [];
    t.document.activeElement = { closest: (s) => (s === "[data-note]" ? note : null) };
    t.el.list.innerHTML = "before";
    doc("compositionstart");
    t.renderList();
    assert.strictEqual(t.el.list.innerHTML, "before", "the list is not rebuilt under the composition");
    doc("compositionend");
    fire("list", "compositionend", { target: note });
    await wait();
    assert.notStrictEqual(t.el.list.innerHTML, "before", "compositionend renders what waited");
    delete t.document.activeElement;

    // 逐个视频笔记: B站限流 waits and retries the same video; an Obsidian-level failure ends the run (checked first too);
    // closing the dialog leaves the run going.
    {
      openFake("W", [item(801), item(802), item(803)]);
      t.S.folders = t.S.allFolders = [{ id: "W", title: "甲" }];
      t.S.settings.triageIntervalSec = 0;
      t.document.body = { classList: { contains: () => false } };
      Object.assign(t.el, { writeScope: { value: "all", options: [], selectedOptions: [] }, writeFormat: { value: "notes" }, writeOverwrite: { checked: false } });
      let calls = [];
      let stuck = null;
      let check = { ok: true };
      let fail = () => null;
      handlers["triage-obsidian-check"] = () => check;
      handlers["triage-export"] = () => ({ ok: true, data: { path: "甲.md" } });
      handlers["triage-write-note"] = async (m) => {
        calls.push(m.bvid);
        return fail(m.bvid) || { ok: true, data: { path: `${m.bvid}.md`, title: m.bvid } };
      };
      fail = (b) => (b === "BV802" && calls.length === 2 ? (setTimeout(() => (stuck = t.activityState())), { ok: false, code: "THROTTLED", error: "B站返回 -412" }) : null);
      await t.runWrite();
      assert.deepStrictEqual(calls, ["BV801", "BV802", "BV802", "BV803"], "THROTTLED waits, then the same video again");
      assert.ok(stuck?.stuck && stuck.act === "write" && stuck.text === "写入笔记 1/3 · B站限流卡住，0:01 后重试" && stuck.total === 3, JSON.stringify(stuck));

      assert.strictEqual(t.S.write.text, "逐个视频笔记完成：写入 3 篇");
      // C661: the vault's index failing is said apart, not counted as a failed note.
      handlers["triage-export"] = () => ({ ok: false, error: "网络断了" });
      await t.runWrite();
      assert.strictEqual(t.S.write.text, "逐个视频笔记完成：写入 3 篇 · 索引写入失败：网络断了");
      handlers["triage-export"] = () => ({ ok: true, data: { path: "甲.md" } });

      // A note written without its subtitle, or with one that may not match, is listed with the warning, in amber.
      calls = [];
      fail = (b) => (b === "BV803" ? { ok: true, data: { path: "BV803.md", title: "BV803", subtitleWarning: "字幕抓取失败：网络断了。" } } : null);
      await t.runWrite();
      assert.strictEqual(t.el.writeFailed.innerHTML, '<li class="warn">视频803：字幕抓取失败：网络断了。</li>');
      assert.ok(!t.el.writeFailed.hidden && t.S.write.text === "逐个视频笔记完成：写入 3 篇", "written, not failed");
      assert.deepStrictEqual(plain(t.activityState()), { text: "逐个视频笔记完成：写入 3 篇", finished: true });

      calls = [];
      fail = (b) => (b === "BV802" ? { ok: false, code: "OBSIDIAN", error: "Obsidian 的 API Key 无效或未授权" } : null);
      await t.runWrite();
      assert.deepStrictEqual(calls, ["BV801", "BV802"], "an Obsidian failure ends the run");
      assert.ok(!vm.runInContext("writeRunning()", ctx) && !t.S.write.text && t.el.writeSettingsBtn.hidden === false, "no green line; 去设置 in the dialog");
      assert.ok(t.el.bannerText.textContent.startsWith("写入 Obsidian 失败：Obsidian 的 API Key") && t.el.bannerBtn.textContent === "去设置" && !t.el.bannerBtn.hidden);

      // Obsidian not running ends the run too, but the settings page cannot fix it: no 去设置 anywhere.
      calls = [];
      fail = (b) => (b === "BV802" ? { ok: false, code: "OBSIDIAN_DOWN", error: "连不上 Obsidian，请确认它已打开并启用了 Local REST API" } : null);
      await t.runWrite();
      assert.deepStrictEqual(calls, ["BV801", "BV802"], "a closed Obsidian ends the run");
      assert.ok(!t.S.write.text && t.el.writeSettingsBtn.hidden === true, "no 去设置 in the dialog");
      assert.ok(t.el.bannerText.textContent.startsWith("写入 Obsidian 失败：连不上") && t.el.bannerBtn.hidden === true, "the banner has only its ×");
      // C663: reopened after Obsidian stopped it, the dialog still says how far it got.
      const said = t.el.writeProgress.textContent;
      t.openWrite();
      assert.ok(said && t.el.writeProgress.textContent === said, said);

      calls = [];
      check = { ok: false, code: "OBSIDIAN", error: "请先在设置页填写 Obsidian Local REST API 地址和 API Key" };
      await t.runWrite();
      assert.deepStrictEqual(calls, [], "checked before any video");
      check = { ok: true };

      calls = [];
      let release;
      fail = (b) => (b === "BV801" ? new Promise((r) => (release = r)).then(() => null) : null);
      const run = t.runWrite();
      await wait();
      assert.ok(vm.runInContext("writeRunning()", ctx) && t.activityState().act === "write");
      (L.writeDialog?.close || []).forEach((f) => f());
      release();
      await run;
      assert.deepStrictEqual(calls, ["BV801", "BV802", "BV803"], "closing the dialog leaves the run going");

      // The dialog's 停止 is the pill's: 停止中, off with the pill's reason, and no sentence of its own.
      const cls = new Set();
      t.el.writeProgress = { textContent: "", classList: { add: (c) => cls.add(c), remove: (c) => cls.delete(c), toggle: (c, on) => (on ? cls.add(c) : cls.delete(c)) } };
      fail = (b) => (b === "BV801" ? new Promise((r) => (release = r)).then(() => null) : null);
      const run2 = t.runWrite();
      await wait();
      t.stopWrite();
      assert.deepStrictEqual([t.el.writeStopBtn.textContent, t.el.writeStopBtn.disabled, t.el.writeStopBtn.title], ["停止中", true, "当前视频做完就停止"]);
      assert.ok(t.el.writeProgress.textContent.startsWith("写入 1/3"), t.el.writeProgress.textContent);
      release();
      await run2;
      assert.ok(!t.el.writeStopBtn.disabled, "the next run's 停止 is on again");

      // 一篇摘录: a failed copy is red like a failed write; a write says what every other entry says.
      t.el.writeFormat.value = "digest";
      t.navigator = { clipboard: { writeText: async () => { throw new Error("没有权限"); } } };
      await t.exportDigest("copy");
      assert.ok(t.el.writeProgress.textContent === "复制失败：没有权限" && cls.has("fail-text"), "copy failure in red");
      handlers["triage-export"] = (m) => ({ ok: true, data: { path: `库/${m.filename}`, text: `已写入 Obsidian：库/${m.filename}` } });
      await t.exportDigest("obsidian");
      assert.ok(/^已写入 Obsidian：库\/B站摘录-/.test(t.el.writeProgress.textContent) && !cls.has("fail-text"), t.el.writeProgress.textContent);
      // A scope with nothing to write: copy, download and write are off and say why.
      openFake("W", []);
      t.renderWriteScope();
      for (const b of ["writeCopyBtn", "writeMdBtn", "writeRunBtn"]) assert.ok(t.el[b].disabled && t.el[b].title === "作用范围里没有视频", b);
      // C659: changing the scope while 摘录 is being written into Obsidian leaves that busy button off.
      openFake("W", [item(659)]);
      t.setBusy(t.el.writeRunBtn, "写入中…");
      t.renderWriteScope();
      assert.ok(t.el.writeRunBtn.disabled, "busy stays off");
      t.setBusy(t.el.writeRunBtn, "");
      t.renderWriteScope();
      assert.ok(!t.el.writeRunBtn.disabled, "on again once done");
      delete t.navigator;
      openFake("A", []);
      delete t.document.body;
    }
    Object.assign(t.el, real);
  }

  // 关注 (follow.js) takes the keys through setModeKeys while on; typing and IME never reach it; its steps share U.
  {
    const keys = [];
    const ev = (key, extra = {}) => ({ key, target: { closest: () => null }, preventDefault() { this.prevented = true; }, ...extra });
    t.MoonTriage.setModeKeys((key) => (keys.push(key), key === "j"));
    const j = ev("j");
    t.onKey(j);
    assert.ok(j.prevented && keys.join() === "j", "the mode used J");
    t.S.undo = [t.basketStep([])];
    const u = ev("u");
    t.onKey(u);
    assert.ok(!u.prevented && t.S.undo.length === 1, "mode on: 收藏夹's U does not run");
    t.onKey(ev("j", { isComposing: true }));
    t.onKey(ev("j", { target: { closest: (sel) => (sel.includes("input") ? {} : null) } }));
    assert.strictEqual(keys.join(), "j,u", "keys typed into a field or the IME skip the mode");
    t.MoonTriage.setModeKeys(() => null);
    // Each mode keeps its own steps: U undoes only the steps of the mode it is pressed in.
    t.S.undo = [];
    let undone = 0;
    t.MoonTriage.pushUndo({ kind: "mode", undo: async () => (undone++, "已撤销：去掉「x」") });
    t.S.undo.push(t.basketStep([]));
    t.onKey(ev("u"));
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(undone === 0 && toasts.at(-1) === "已撤销：放回待播 0 个" && t.S.modeUndo.length === 1, "收藏夹's U undoes its own step, not 关注's later one");
    t.onKey(ev("u"));
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(undone === 0 && toasts.at(-1) === "没有可撤销的操作", "收藏夹's U never reaches a 关注 step");
    t.S.undo.push(t.basketStep([]));
    t.document.body = { classList: { contains: (c) => c === "follow-mode" } };
    await t.MoonTriage.undo();
    assert.ok(undone === 1 && toasts.at(-1) === "已撤销：去掉「x」" && t.S.undo.length === 1 && !t.S.modeUndo.length, "关注's U undoes its step and leaves 收藏夹's");
    const ask = t.askConfirm;
    t.askConfirm = async () => false;
    t.MoonTriage.pushUndo({ kind: "mode", ask: ["撤销？", ""], undo: async () => (undone++, "") });
    await t.MoonTriage.undo();
    assert.ok(undone === 1 && t.S.modeUndo.length === 1, "a step that asks and is declined stays");
    t.askConfirm = ask;
    t.S.modeUndo = [];
    delete t.document.body;
    // 已出分拣范围: 清空待播 says 「U 撤销」, so U works there too.
    openFake("removed", []);
    t.S.undo.push(t.basketStep([]));
    const ur = ev("u");
    t.onKey(ur);
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(ur.prevented && !t.S.undo.length && toasts.at(-1) === "已撤销：放回待播 0 个", "U undoes in 已出分拣范围");
    openFake("A", []);
    t.MoonTriage.setModeKeys(null);
  }

  // G10: 标题粗看 counts and sends exactly the 未分析 videos listed (search applied); filtered to none, it is disabled
  // and says so.
  {
    openFake("G", [item(701), { ...item(702), title: "数学课" }, { ...item(703), title: "数学题" }]);
    t.S.folders = t.S.allFolders = [{ id: "G", title: "甲" }];
    Object.assign(t.S, { tab: "none", titleRes: {}, analyses: {}, query: "数学", stage1: { running: false, stop: false, done: 0, total: 0 }, group: null });
    t.S.coarseFailed.clear();
    Object.assign(t.S.settings, { triageIntervalSec: 0 });
    t.renderListHeader(t.visibleItems());
    assert.ok((t.el.listHeader.innerHTML + t.el.favSel.innerHTML).includes("标题粗看下一批 2 个"), (t.el.listHeader.innerHTML + t.el.favSel.innerHTML));
    let sentBvids = [];
    handlers["triage-classify-titles"] = (m) => ((sentBvids = m.items.map((x) => x.bvid)), { ok: true, data: { results: {} } });
    await t.runStage1();
    assert.deepStrictEqual(plain(sentBvids), plain(t.visibleItems().map((it) => it.bvid)), "the run sends the listed ones");
    assert.deepStrictEqual(plain(sentBvids), ["BV702", "BV703"]);
    // One run takes at most triageCoarseBatchSize (default 100, clamped to 1000), the selection too; 重新粗看 likewise.
    {
      const many = Array.from({ length: 1005 }, (_, i) => item(5000 + i));
      openFake("G", many);
      Object.assign(t.S, { tab: "none", titleRes: {}, analyses: {}, query: "" });
      t.S.coarseFailed.clear();
      const head = () => (t.renderListHeader(t.visibleItems()), (t.el.listHeader.innerHTML + t.el.favSel.innerHTML));
      const pending = () => vm.runInContext("stage1Pending()", ctx).map((it) => it.bvid);
      delete t.S.settings.triageCoarseBatchSize;
      assert.ok(head().includes("标题粗看下一批 100 个"), "default 100");
      t.S.settings.triageCoarseBatchSize = 5000;
      assert.ok(head().includes("标题粗看下一批 1000 个"), "clamped to 1000");
      t.S.settings.triageCoarseBatchSize = 3;
      assert.deepStrictEqual(plain(pending()), ["BV5000", "BV5001", "BV5002"], "the first ones in list order");
      for (const b of ["BV5010", "BV5011"]) t.S.selected.add(b);
      assert.ok(head().includes("标题粗看选中的 2 个"));
      for (const b of ["BV5012", "BV5013"]) t.S.selected.add(b);
      assert.ok(head().includes("标题粗看选中的前 3 个"), "more selected than the cap");
      await t.runStage1();
      assert.deepStrictEqual(plain(sentBvids), ["BV5010", "BV5011", "BV5012"], "the run sends only the capped selection");
      t.S.selected.clear();
      t.S.folderCriteria = { G: "新标准" };
      t.S.titleRes = Object.fromEntries(many.map((it) => [it.bvid, { verdict: "keep", criteria: "旧标准" }]));
      t.S.tab = "coarse";
      assert.ok(head().includes("按新标准重新粗看下一批 3 个"), "重新粗看 is capped too");
      // F1: a selection of stale ones wins, as on 标题粗看.
      for (const b of ["BV5020", "BV5021"]) t.S.selected.add(b);
      assert.ok(head().includes("按新标准重新粗看选中的 2 个"), head());
      assert.deepStrictEqual(plain(vm.runInContext('redoState("粗看", redoCoarseOpen(), coarseBatchSize(), "coarse")', ctx).batch.map((it) => it.bvid)), ["BV5020", "BV5021"]);
      t.S.selected.clear();
      // F2: the 判断标准 prompt offers the same batch as that button and says how many.
      const realAsk = t.askConfirm;
      let asked = null;
      t.askConfirm = async (...a) => ((asked = a), false);
      t.el.criteriaInput = { value: "更新的标准" };
      await t.saveCriteria();
      assert.deepStrictEqual([asked[0], asked[2]], ["判断标准改了", "按新标准重新粗看下一批 3 个"]);
      assert.ok(asked[1].includes("有 1005 个视频"), asked[1]);
      // G12: filters hiding them all still ask, with the total and how many are listed; its button is disabled with why.
      t.S.query = "没有这个词";
      t.el.criteriaInput = { value: "再改的标准" };
      asked = null;
      await t.saveCriteria();
      assert.deepStrictEqual(plain([asked?.[2], asked?.[3]]), ["按新标准重新粗看", { reason: "当前筛选下没有要重新粗看的视频" }]);
      assert.ok(asked[1].includes("有 1005 个视频是按旧标准粗看的（当前筛选下列出 0 个）"), asked[1]);
      t.S.query = "";
      // While an AI step runs no dialog: a toast says what to click once it is done.
      t.S.group = { bvids: ["x"], stop: false, mediaId: "other" };
      t.el.criteriaInput = { value: "第三版标准" };
      asked = null;
      await t.saveCriteria();
      assert.deepStrictEqual([asked, toasts.at(-1)], [null, "有 1005 个视频是按旧标准粗看的，等字幕细看跑完，点「按新标准重新粗看」就能更新"]);
      t.S.group = null;
      t.askConfirm = realAsk;
      Object.assign(t.S, { tab: "none", titleRes: {}, folderCriteria: {} });
      t.S.coarseFailed.clear();
      t.S.settings.triageCoarseBatchSize = 100;
      openFake("G", [item(701), { ...item(702), title: "数学课" }, { ...item(703), title: "数学题" }]);
    }
    t.S.query = "没有这个词";
    t.renderListHeader(t.visibleItems());
    assert.ok((t.el.listHeader.innerHTML + t.el.favSel.innerHTML).includes('aria-label="标题粗看" disabled title="当前筛选下没有要粗看的视频"'), (t.el.listHeader.innerHTML + t.el.favSel.innerHTML));
    t.S.query = "";
    // N1: another AI run first.
    t.S.group = { bvids: ["x"], stop: false, mediaId: "other" };
    t.renderListHeader(t.visibleItems());
    assert.ok((t.el.listHeader.innerHTML + t.el.favSel.innerHTML).includes('disabled title="字幕细看还在跑，等它完成"'), (t.el.listHeader.innerHTML + t.el.favSel.innerHTML));
    t.S.group = null;
    // D4: a 粗看 error about one batch (a reply in the wrong format) fails that batch's cards and the run goes on; a
    // platform error still ends it. Failed cards stay in 未分析, last, with the failure, a retry and 「全部重试」.
    {
      const realList = t.el.list;
      t.el.list = { innerHTML: "", scrollTop: 0, querySelectorAll: () => [], querySelector: () => null };
      openFake("G", Array.from({ length: 21 }, (_, i) => item(6000 + i)));
      Object.assign(t.S, { tab: "none", titleRes: {}, analyses: {}, query: "", folderCriteria: {} });
      t.S.coarseFailed.clear();
      let calls = 0;
      handlers["triage-classify-titles"] = ({ items }) =>
        ++calls === 1 ? { ok: false, code: "AI_BAD_JSON", error: "AI 回复格式不对" } : { ok: true, data: { results: Object.fromEntries(items.map((x) => [x.bvid, { verdict: "keep", confidence: "high" }])) } };
      await t.runStage1();
      assert.strictEqual(calls, 2, "the run goes on after a batch's own error");
      assert.strictEqual(t.S.titleRes.BV6020?.verdict, "keep");
      assert.deepStrictEqual([t.S.coarseFailed.size, t.S.coarseFailed.get("BV6000")], [20, "AI 回复格式不对"]);
      assert.ok(t.verdictOf(t.S.itemMap.get("BV6000")).failed === "AI 回复格式不对" && t.stageOf(t.S.itemMap.get("BV6000")) === "none");
      t.renderList();
      assert.ok(t.el.list.innerHTML.includes("分析失败：AI 回复格式不对") && t.el.list.innerHTML.includes('data-act="retry"'), "the card shows it with a retry");
      assert.ok(t.el.list.innerHTML.includes("分析失败 20 · ") && t.el.list.innerHTML.includes("全部重试"), "the group head in 未分析");
      assert.ok(t.el.list.innerHTML.indexOf("BV6020") < t.el.list.innerHTML.indexOf("BV6000"), "failed cards last");
      t.renderListHeader(t.visibleItems());
      assert.ok((t.el.listHeader.innerHTML + t.el.favSel.innerHTML).includes('aria-label="标题粗看" disabled title="没有要粗看的视频"'), "标题粗看 does not send them again by itself");
      // 全部重试: through startJudging, one 粗看 batch (here 10); the label says so when more failed.
      t.S.settings.triageCoarseBatchSize = 10;
      t.renderList();
      assert.ok(t.el.list.innerHTML.includes("重试下一批 10 个"), "more failed than one batch");
      const judged = [];
      const realStart = t.startJudging;
      t.startJudging = async (title, verb, items, start) => (judged.push([title, verb, items.length]), start());
      handlers["triage-classify-titles"] = ({ items }) => ({ ok: true, data: { results: Object.fromEntries(items.map((x) => [x.bvid, { verdict: "drop", confidence: "high" }])) } });
      t.retryFailed();
      while (vm.runInContext("runs", ctx).get("stage1")) await new Promise((r) => setTimeout(r, 0));
      assert.deepStrictEqual(judged, [["重试下一批 10 个", "粗看", 10]], "G10: the dialog is titled like the button");
      assert.strictEqual(t.S.coarseFailed.size, 10);
      t.renderList();
      assert.ok(t.el.list.innerHTML.includes("全部重试") && !t.el.list.innerHTML.includes("重试下一批"));
      // G9 / G11: a pick of a failed card: 标题粗看 stays the selection's, disabled with why (no fallback to the next
      // batch); the group head says 重试选中的 1 个 at once, redrawn by the pick without rebuilding the list.
      t.S.selected = new Set([[...t.S.coarseFailed.keys()][0]]);
      const head = { outerHTML: "" };
      t.el.list.querySelector = (sel) => (sel === ".group-head" ? head : null);
      t.showPicks();
      assert.ok(head.outerHTML.includes("分析失败 10 · ") && head.outerHTML.includes("重试选中的 1 个</button>"), head.outerHTML);
      assert.ok((t.el.listHeader.innerHTML + t.el.favSel.innerHTML).includes('aria-label="标题粗看选中的 1 个" disabled title="选中的都不能标题粗看"'), (t.el.listHeader.innerHTML + t.el.favSel.innerHTML));
      t.S.selected = new Set();
      t.showPicks();
      assert.ok(head.outerHTML.includes("全部重试</button>"), "unpicked: back to 全部重试");
      t.el.list.querySelector = () => null;
      // A card's 重试 sends that one, through startJudging like 全部重试 (J4), its dialog titled like the button.
      judged.length = 0;
      t.retry("BV6019");
      while (vm.runInContext("runs", ctx).get("stage1")) await new Promise((r) => setTimeout(r, 0));
      assert.ok(t.S.titleRes.BV6019 && !t.S.coarseFailed.has("BV6019"));
      assert.deepStrictEqual(judged, [["重试", "粗看", 1]]);
      // A platform error ends the run at the first batch and fails no card.
      t.S.coarseFailed.clear();
      t.S.titleRes = {};
      calls = 0;
      handlers["triage-classify-titles"] = () => (++calls, { ok: false, code: "AI_AUTH", error: "API Key 不对" });
      await t.runStage1();
      assert.deepStrictEqual([calls, t.S.coarseFailed.size], [1, 0]);
      // G5: its 去设置 banner stays through a paused 粗看, as through a paused 细看; a finished run clears it.
      assert.deepStrictEqual([t.el.banner.hidden, t.el.banner.dataset.kind], [false, "ai"]);
      t.S.settings.triageCoarseBatchSize = 100;
      handlers["triage-classify-titles"] = ({ items }) => (vm.runInContext("runs", ctx).stop("stage1"), { ok: true, data: { results: Object.fromEntries(items.map((x) => [x.bvid, { verdict: "keep", confidence: "high" }])) } });
      assert.ok((await t.runStage1(), Object.keys(t.S.titleRes).length === 20), "paused after one request");
      assert.strictEqual(t.el.banner.hidden, false, "a paused 粗看 keeps the banner");
      handlers["triage-classify-titles"] = ({ items }) => ({ ok: true, data: { results: Object.fromEntries(items.map((x) => [x.bvid, { verdict: "keep", confidence: "high" }])) } });
      await t.runStage1();
      assert.deepStrictEqual([Object.keys(t.S.titleRes).length, t.el.banner.hidden], [21, true], "a finished one clears it");
      t.S.titleRes = {};
      t.S.settings.triageCoarseBatchSize = 20;
      t.el.banner.hidden = true;

      // F3: 细看's 全部重试 goes the same way: startJudging, one 字幕细看 batch.
      t.S.titleRes = Object.fromEntries(t.S.items.map((it) => [it.bvid, { verdict: "unsure", confidence: "high" }]));
      t.S.analyses = Object.fromEntries(t.S.items.slice(0, 12).map((it) => [it.bvid, { bvid: it.bvid, status: "error", error: "字幕取不到" }]));
      Object.assign(t.S, { tab: "coarse" });
      t.S.settings.triageFineBatchSize = 5;
      t.renderList();
      assert.ok(t.el.list.innerHTML.includes("分析失败 12 · ") && t.el.list.innerHTML.includes("重试下一批 5 个"), "细看's label says how many");
      judged.length = 0;
      const analyzed = [];
      handlers["triage-analyze"] = ({ bvid }) => (analyzed.push(bvid), { ok: true, data: { bvid, status: "done", verdict: "keep" } });
      t.retryFailed();
      for (let i = 0; i < 50 && t.S.group; i++) await new Promise((r) => setImmediate(r));
      assert.deepStrictEqual([judged, analyzed.length], [[["重试下一批 5 个", "细看", 5]], 5]);
      // F5: 字幕细看 ends on a green 「字幕细看完成 N 个」 like 粗看.
      t.startJudging = realStart;
      t.S.analyses = {};
      t.startGroup(["BV6001", "BV6002"]);
      for (let i = 0; i < 50 && t.S.group; i++) await new Promise((r) => setImmediate(r));
      assert.strictEqual(t.activityState().text, "字幕细看完成 2 个");
      // 重新粗看 says so in the pill, like 重新细看.
      t.S.folderCriteria = { G: "新" };
      t.S.titleRes.BV6005 = { verdict: "keep", criteria: "旧" };
      let release;
      handlers["triage-classify-titles"] = () => new Promise((r) => (release = () => r({ ok: true, data: { results: { BV6005: { verdict: "keep" } } } })));
      const redo = t.runStage1([t.S.itemMap.get("BV6005")], true);
      await new Promise((r) => setImmediate(r));
      assert.strictEqual(t.activityState().text, "按新标准重新粗看 0/1");
      // K5: seen from another folder it still says 按新标准重新…, with where it runs.
      const home = t.S.mediaId;
      t.S.mediaId = "elsewhere";
      assert.ok(t.activityState().text.startsWith("按新标准重新粗看 0/1（"), t.activityState().text);
      t.S.mediaId = home;
      release();
      await redo;
      assert.strictEqual(t.activityState().text, "按新标准重新粗看完成 1 个");
      // K5: 按新标准重新细看 too, from another folder.
      let releaseFine;
      handlers["triage-analyze"] = ({ bvid }) => new Promise((r) => (releaseFine = () => r({ ok: true, data: { bvid, status: "done", verdict: "keep" } })));
      t.startGroup(["BV6001"], true);
      for (let i = 0; i < 50 && !releaseFine; i++) await new Promise((r) => setImmediate(r));
      t.S.mediaId = "elsewhere";
      assert.ok(t.activityState().text.startsWith("按新标准重新细看 0/1（"), t.activityState().text);
      t.S.mediaId = home;
      releaseFine();
      for (let i = 0; i < 50 && t.S.group; i++) await new Promise((r) => setImmediate(r));
      t.S.folderCriteria = {};
      t.S.settings.triageCoarseBatchSize = 100;
      t.S.settings.triageFineBatchSize = 10;
      Object.assign(t.S, { tab: "none", titleRes: {}, analyses: {} });
      t.S.coarseFailed.clear();
      for (const job of ["stage1", "group"]) await vm.runInContext("runs", ctx).run(job, { line: () => "", next: () => null });
      t.el.list = realList;
    }
    // G1 / G7: ✦ AI 打标签 needs videos (and not 已出分拣范围), unless a run or a proposal waits.
    t.aiTagReason = () => vm.runInContext("aiTagReason()", ctx);
    assert.strictEqual(t.aiTagReason(), "");
    t.S.mediaId = "all";
    assert.strictEqual(t.aiTagReason(), "", "所有收藏夹 runs per folder");
    t.S.mediaId = "removed";
    assert.strictEqual(t.aiTagReason(), "标签按收藏夹分开，先打开一个具体收藏夹");
    openFake("E", []);
    assert.strictEqual(t.aiTagReason(), "这个收藏夹没有视频");
    const aiRun = hang("ai");
    assert.strictEqual(t.aiTagReason(), "", "while it runs it opens the progress");
    await aiRun();
  }

  // U8: a B站 batch asks in a dialog that starts with 在 B站 and whose button carries the count.
  {
    openFake("C", [item(801), item(802)]);
    const asked = [];
    t.askConfirm = async (...a) => (asked.push(a), false);
    const before = sent.length;
    await t.fav.unfavMany(t.S.items);
    assert.deepStrictEqual(plain(asked[0].slice(0, 1).concat(asked[0][2])), ["在 B站取消收藏这 2 个视频？", "取消收藏 2 个"]);
    assert.strictEqual(sent.length, before, "declined: nothing sent");
    t.askConfirm = async (...a) => (asked.push(a), true);
    handlers["triage-unfav"] = () => ({ ok: true });
    await t.fav.unfavMany(t.S.items);
    t.askConfirm = async (...a) => (asked.push(a), false);
    await t.undo();
    const ask = asked.at(-1);
    assert.ok(ask[0].startsWith("在 B站") && ask[2] === "重新收藏 2 个" && t.S.undo.length === 1, ask);
    t.askConfirm = async () => true;
  }

  // 标签… on a selection opens the shared picker for the selected videos; the save is one U step.
  {
    openFake("M", [item(901), item(902)]);
    Object.assign(t.S, { tags: [{ id: "ma", name: "甲", color: "#111", folder: "M" }, { id: "mb", name: "乙", color: "#222", folder: "M" }], videoTags: { BV901: ["ma"] } });
    await pickWith(["BV901", "BV902"], (sets) => t.TagPicker.toggle(sets, "mb"));
    assert.deepStrictEqual(plain(po.targets), ["BV901", "BV902"]);
    assert.deepStrictEqual(plain(t.S.videoTags), { BV901: ["ma", "mb"], BV902: ["mb"] });
    assert.strictEqual(t.S.undo.length, 1, "one step for the batch");
    // 2+ videos: U asks first, like the other batch steps; declined, nothing changes.
    const ask = t.askConfirm;
    let asked = 0;
    t.askConfirm = async () => (asked++, false);
    await t.undo();
    assert.ok(asked === 1 && t.S.undo.length === 1 && t.S.videoTags.BV902, "declined: the batch stays");
    t.askConfirm = ask;
    await t.undo();
    assert.deepStrictEqual(plain(t.S.videoTags), { BV901: ["ma"] });
    Object.assign(t.S, { tags: [], videoTags: {} });
  }

  // C567: a folder deleted on B站 is retired under the name its list was saved with, not its number.
  {
    const backup = structuredClone(store);
    const keep = { allFolders: t.S.allFolders, folders: t.S.folders, included: t.S.included };
    for (const k of Object.keys(store)) if (k.startsWith("triage_snapshot_")) delete store[k];
    Object.assign(t.S, { allFolders: [{ id: 77, title: "旧夹" }, { id: 1, title: "夹1" }], folders: [{ id: 1, title: "夹1" }], included: ["1"] });
    await t.saveSnapshot("77", [item(567)]);
    t.S.allFolders = [{ id: 1, title: "夹1" }];
    await t.retireUnchosenFolders();
    assert.deepStrictEqual(plain(store[t.K.removed].BV567.from.map((f) => f.title)), ["旧夹"], JSON.stringify(store[t.K.removed].BV567));
    for (const k of Object.keys(store)) delete store[k];
    Object.assign(store, backup);
    Object.assign(t.S, keep);
  }

  // C568: the first load keeps every folder for someone who triaged before, 稍后再看 too when its read failed.
  // C570: reloading the folder list keeps an AI setup banner.
  {
    const backup = structuredClone(store);
    const keep = { allFolders: t.S.allFolders, folders: t.S.folders, included: t.S.included, toviewUnread: t.S.toviewUnread };
    delete store[t.K.included];
    store.triage_snapshot_toview = { bvids: [] };
    Object.assign(t.S, { allFolders: [{ id: 1, title: "夹1" }], toviewUnread: true });
    assert.deepStrictEqual(plain(await t.loadIncluded()), ["1", "toview"]);
    t.el.banner.dataset.kind = "ai";
    t.el.banner.hidden = false;
    const folders = handlers["triage-folders"];
    handlers["triage-folders"] = () => ({ ok: true, data: { folders: [], toviewUnread: false } });
    await t.loadFolders();
    handlers["triage-folders"] = folders;
    assert.strictEqual(t.el.banner.hidden, false, "the AI banner stays");
    t.el.banner.hidden = true;
    t.el.banner.dataset.kind = "";
    for (const k of Object.keys(store)) delete store[k];
    Object.assign(store, backup);
    Object.assign(t.S, keep);
  }

  // C572 / C627: an invalid video copied or moved into a folder is in its cached list's invalid ids, as a read would put it.
  {
    await t.patchSnapshotNow("C627", { add: [{ ...item(627), invalid: true }, item(628)] }, true);
    assert.deepStrictEqual(plain(store[t.K.snapshot("C627")].invalid), ["BV627"]);
    delete store[t.K.snapshot("C627")];
  }

  // C577: 清理 deletes its videos' notes one by one, keeping a note another page saved after this page read them.
  {
    openFake("removed", [{ ...item(577), inFolder: null }]);
    store[t.K.notes] = { BV577: { text: "删", updatedAt: 1 }, BV578: { text: "侧边栏刚存的", updatedAt: 2 } };
    t.S.notes = { BV577: { text: "删", updatedAt: 1 } };
    await t.cleanRemoved([t.S.items[0]]);
    assert.deepStrictEqual(plain(store[t.K.notes]), { BV578: { text: "侧边栏刚存的", updatedAt: 2 } });
    delete store[t.K.notes];
    t.S.notes = {};
  }

  // C578: the stored AI results that could not be read say so; their cards would otherwise just read 未分析.
  {
    openFake("C578", [item(578)]);
    const get = handlers["triage-title-get"];
    handlers["triage-title-get"] = () => ({ ok: false, error: "后台无响应" });
    await t.loadResults(t.S.folderToken);
    handlers["triage-title-get"] = get;
    assert.strictEqual(toasts.at(-1), "读取已有的 AI 判断失败：后台无响应");
  }

  // C646: stopped before any batch answered: no 「只有已完成批次的建议」.
  {
    const R = vm.runInContext("runs", ctx);
    handlers["test-ai-646"] = () => (R.stop("ai646"), { ok: false, error: "AI 回复格式不对" });
    const { proposal, errors } = await tagStore().runAi({ R, job: "ai646", total: 3, request: () => ({ type: "test-ai-646" }), merge() {}, send: t.send, intervalMs: 0, progress() {} });
    assert.ok(!proposal && errors.at(-1) === "已手动停止，还没有批次完成", JSON.stringify(errors));
  }

  // C648: in 所有收藏夹, a scope whose videos are in no chosen folder sends nothing and records no instruction.
  {
    const keep = { folders: t.S.folders, aiHistory: t.S.aiHistory, tab: t.S.tab };
    openFake("all", [{ ...item(648), folders: [] }]);
    Object.assign(t.S, { folders: [{ id: "1", title: "夹1" }], aiHistory: [], tab: "read" });
    const before = sent.length;
    await t.runAiCommand({ instruction: "分类", scope: "filter", allowRemove: false });
    assert.ok(!sent.slice(before).some((m) => m.type === "triage-ai-command") && !t.S.aiHistory.length);
    Object.assign(t.S, keep);
  }

  // A checked new tag is made even when the folder is at its tag cap: the user confirmed it on the review page.
  {
    const keep = { tags: t.S.tags, videoTags: t.S.videoTags, limit: t.S.settings.triageTagLimit };
    openFake("C650", [item(650)]);
    Object.assign(t.S, { tags: [{ id: "x650", name: "旧", color: "#111", folder: "C650" }], videoTags: {} });
    t.S.settings.triageTagLimit = 1;
    t.S.ai.proposals.C650 = { newTags: [{ key: "k", name: "新", checked: true }], rows: [{ id: "BV650", add: ["new:k", "id:x650"], remove: [] }], notes: [], errors: [] };
    await applyAi();
    const made = t.S.tags.find((x) => x.name === "新");
    assert.ok(made && made.folder === "C650", "past the folder's cap");
    assert.deepStrictEqual(plain(t.S.videoTags.BV650), [made.id, "x650"].sort((a, b) => plain(t.S.videoTags.BV650).indexOf(a) - plain(t.S.videoTags.BV650).indexOf(b)));
    t.S.settings.triageTagLimit = keep.limit;
    Object.assign(t.S, { tags: keep.tags, videoTags: keep.videoTags, undo: [] });
  }

  // A result from before criteria were recorded counts as made under the open folder's criteria, and is stored so;
  // 所有收藏夹 has no one criteria to stamp.
  {
    const was = { title: handlers["triage-title-get"], analysis: handlers["triage-analysis-get"], crit: t.S.folderCriteria };
    handlers["triage-analysis-get"] = () => ({ ok: true, data: {} });
    handlers["triage-title-get"] = ({ bvids }) => ({ ok: true, data: Object.fromEntries(bvids.map((b) => [b, { verdict: "keep" }])) });
    t.S.folderCriteria = { F700: "只留干货" };
    for (const [id, n, want] of [["F700", 700, "只留干货"], ["all", 701, undefined]]) {
      openFake(id, [item(n)]);
      await t.loadResults(t.S.folderToken);
      assert.strictEqual(t.S.titleRes[`BV${n}`].criteria, want, id);
    }
    Object.assign(handlers, { "triage-title-get": was.title, "triage-analysis-get": was.analysis });
    t.S.folderCriteria = was.crit;
  }

  // R20: another tab deletes the tag this tab filters by: the filter drops it, so the list is not left empty with no
  // chip to turn it off.
  {
    openFake("R20", [item(1), item(2)]);
    Object.assign(t.S, { tab: "read", tags: [{ id: "x", name: "X", folder: "R20", color: "#f00" }], videoTags: { BV1: ["x"] }, tagFilter: new Set(["x"]) });
    assert.deepStrictEqual(plain(t.visibleItems().map((i) => i.bvid)), ["BV1"]);
    t.followShared({ [t.K.tags]: { newValue: [] } });
    assert.deepStrictEqual([t.visibleItems().length, t.S.tagFilter.size], [2, 0]);
    Object.assign(t.S, { tags: [], videoTags: {} });
  }

  // R25: 保留, then 取消收藏, then favorited again on B站: the sync drops the 取消收藏 and the 保留 shows again.
  {
    const keep = { action: "keep", at: 1 };
    openFake("R25", [item(3)], { BV3: { action: "unfav", at: 1000, aid: 1003, title: "视频3" } });
    t.S.kept = { BV3: keep };
    store[t.K.snapshot("R25")] = { bvids: ["BV3"], items: [item(3)], ids: ["BV3"], intro: "" };
    Object.assign(t.S, { syncing: false, lastSyncAt: 0 });
    const was = handlers["triage-folder-items"];
    handlers["triage-folder-items"] = () => ({ ok: true, data: { items: [{ ...item(3), favTime: 9e9 }], ids: ["BV3"], info: { intro: "" } } });
    await t.syncFolder({ force: true });
    handlers["triage-folder-items"] = was;
    assert.deepStrictEqual(plain(t.S.decisions.BV3), keep);
    t.S.kept = {};
  }

  // R9: 所有收藏夹's batch 取消收藏 while a folder load rebuilds the list mid-run (the video left every folder, so the
  // rebuilt list lacks it): it still gets its record, the U step and the toast.
  {
    const was = { sleepWhile: t.sleepWhile, pick: t.pickBatchUnfavFolders, unfav: handlers["triage-unfav"] };
    t.S.folderToken++;
    t.S.allFolders = t.S.folders = [{ id: "f1", title: "一", count: 1 }, { id: "f2", title: "二", count: 1 }];
    Object.assign(t.S, { included: ["f1", "f2"], mediaId: "all", decisions: {}, undo: [], folderDecisions: { f1: {}, f2: {} } });
    t.S.loadAll = { lists: { f1: { items: [item(10)] }, f2: { items: [item(20)] } }, check: [], checkTotal: 0, queue: [], paused: false, running: false, error: "", partial: 0 };
    t.rebuildAll();
    t.pickBatchUnfavFolders = async () => ["f1", "f2"];
    handlers["triage-unfav"] = (m) => (m.mediaId === "f2" && t.rebuildAll(), { ok: true }); // as runLoadAll after checking a folder
    await t.fav.unfavMany([...t.S.items]);
    assert.deepStrictEqual([t.S.undo.length, t.S.decisions.BV10?.action, t.S.itemMap.has("BV10"), toasts.at(-1)], [1, "unfav", true, `已从 2 个收藏夹取消收藏 2 个视频${t.TriageUi.UNDO}`]);
    Object.assign(t, { sleepWhile: was.sleepWhile, pickBatchUnfavFolders: was.pick });
    handlers["triage-unfav"] = was.unfav;
    Object.assign(t.S, { loadAll: null, undo: [], folderDecisions: {} });
  }

  // R26: Esc with the 导出 popover open closes only the popover (the browser's), not the player too.
  {
    let closed = 0;
    const was = { closeViewer: t.closeViewer, q: ctx.document.querySelector, viewing: t.S.viewing };
    t.S.viewing = "BV1";
    t.closeViewer = () => closed++;
    ctx.document.querySelector = (sel) => (sel === ":popover-open" ? {} : null);
    t.onKey({ key: "Escape", target: { closest: () => null }, preventDefault() {} });
    ctx.document.querySelector = was.q;
    t.onKey({ key: "Escape", target: { closest: () => null }, preventDefault() {} });
    assert.strictEqual(closed, 1, "only the second Esc closes the player");
    Object.assign(t, { closeViewer: was.closeViewer });
    t.S.viewing = was.viewing;
  }

  console.log("triage selftest: all passed");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

// Folder tints never land on pink (where you are) or blue (next step); an empty 稍后再看 shows a gray clock, not a tint.
{
  const thumbHue = vm.runInContext("thumbHue", ctx), folderThumb = vm.runInContext("folderThumb", ctx);
  for (const id of ["toview", 1, 2, 3, 77, 123456, "abc", 987654321]) {
    const h = thumbHue(id);
    assert.ok(!(h >= 180 && h <= 240) && !(h >= 300 || h <= 10), `hue ${h} for ${id}`);
  }
  assert.match(folderThumb("toview", ""), /toview-thumb[^>]*><svg/);
  assert.doesNotMatch(folderThumb("toview", ""), /--h:/);
  assert.match(folderThumb("toview", "https://i1.hdslb.com/t.jpg"), /<img src="https:\/\/i1\.hdslb\.com\/t\.jpg"/);
}

// C559: this page's own write comes back as an event and is skipped; a write of an unchanged value fires none, so later
// another tab's write of that same value is taken, not swallowed as this page's echo.
{
  const keep = t.S.aiRecent;
  const D = vm.runInContext("Date", ctx);
  const now = D.now;
  t.storeSet(t.K.aiRecent, { F: { at: 1, bvids: ["a"] } });
  t.S.aiRecent = { mine: true };
  t.followShared({ [t.K.aiRecent]: { newValue: { F: { at: 1, bvids: ["a"] } } } });
  assert.deepStrictEqual(plain(t.S.aiRecent), { mine: true }, "the echo is skipped");
  t.storeSet(t.K.aiRecent, { F: { at: 2, bvids: ["b"] } }); // say storage already held it: no event
  const later = now() + 5000;
  D.now = () => later;
  t.followShared({ [t.K.aiRecent]: { newValue: { F: { at: 2, bvids: ["b"] } } } });
  D.now = now;
  assert.deepStrictEqual(plain(t.S.aiRecent), { F: { at: 2, bvids: ["b"] } }, "another tab's write of the same value later is taken");
  t.S.aiRecent = keep;
}

// C562: the cover's progress bar names the same words as its tag (100% reads 看完了, not 看到 100%).
{
  const [cfg, pct] = [t.S.seenCfg, t.S.seenPct];
  t.S.seenCfg = t.MdgSurfaces.seenConfig({ seenShow: "both", seenThreshold: 90 });
  t.S.seenPct = { BV562: [100, 1], BV563: [40, 1] };
  assert.ok(t.coverHtml(item(562)).includes('class="seen-bar" title="✓ 看完了"'), t.coverHtml(item(562)));
  assert.ok(t.coverHtml(item(563)).includes('class="seen-bar" title="看到 40%"'));
  [t.S.seenCfg, t.S.seenPct] = [cfg, pct];
}

// C565: 稍后再看 kept through a failed read only while it is ticked; unticked it leaves like any unticked folder.
{
  const keep = { folders: t.S.folders, included: t.S.included, toviewUnread: t.S.toviewUnread };
  Object.assign(t.S, { folders: [{ id: 1 }], toviewUnread: true, included: ["1"] });
  assert.deepStrictEqual(plain(t.chosenOtherIds()), ["1"], "unticked 稍后再看 does not count");
  t.S.included = ["1", "toview"];
  assert.deepStrictEqual(plain(t.chosenOtherIds()), ["1", "toview"], "ticked, it counts until the next read");
  Object.assign(t.S, keep);
}

// C585 / C586: the 刷新 notice's summary and detail name each group once.
{
  const setSync = t.TriageUi.setSync;
  let got = null;
  t.TriageUi.setSync = (els, v) => (got = v);
  t.showSyncNotice({ added: [{ title: "甲" }, { title: "乙", from: "removed" }], removed: ["丙"], invalid: [], restored: [] });
  t.TriageUi.setSync = setSync;
  assert.strictEqual(got.text, "刷新结果：新增 1 · 来自其他收藏夹 1 · 已在B站移除 1 · 已失效 0");
  assert.deepStrictEqual(plain(got.sections), [["新增", ["甲"]], ["来自其他收藏夹", ["乙（原在已出分拣范围）"]], ["已在B站移除", ["丙"]], ["已失效", []], ["恢复（在B站重新收藏）", []]]);
}

// C587: a 刷新 still reading the folder just left does not show as this folder's.
{
  const keep = { syncing: t.S.syncing, token: t.S.folderToken };
  t.S.syncing = t.S.folderToken = 587;
  assert.ok(String(t.activityState()?.text).startsWith("刷新中…"), "this folder's");
  t.S.folderToken++;
  assert.ok(!String(t.activityState()?.text).startsWith("刷新中…"), "the folder left's");
  Object.assign(t.S, { syncing: keep.syncing, folderToken: keep.token });
}

// C593: 保留选中的 N 个 leaves out the selected videos a running batch 取消收藏 is about to write.
{
  const keep = { mediaId: t.S.mediaId, items: t.S.items, itemMap: t.S.itemMap, decisions: t.S.decisions, tab: t.S.tab, selected: t.S.selected, titleRes: t.S.titleRes };
  openFake("C593", [item(593), item(594)]);
  Object.assign(t.S, { tab: "none", titleRes: {}, selected: new Set(["BV593", "BV594"]) });
  const W = vm.runInContext("W", ctx);
  const pending = W.pending;
  W.pending = (b) => (b === "BV593" ? "取消收藏" : "");
  const list = t.batchList(null).map((it) => it.bvid);
  W.pending = pending;
  assert.deepStrictEqual(plain(list), ["BV594"]);
  Object.assign(t.S, keep);
}

// C595: 字幕细看 with every waiting card hidden by the AI-class chip says the filter hides them.
{
  const keep = { mediaId: t.S.mediaId, items: t.S.items, itemMap: t.S.itemMap, decisions: t.S.decisions, tab: t.S.tab, selected: t.S.selected, titleRes: t.S.titleRes, analyses: t.S.analyses, cf: t.S.classFilter.coarse };
  openFake("C595", [item(595)]);
  Object.assign(t.S, { tab: "coarse", titleRes: { BV595: { verdict: "keep", confidence: "high" } }, analyses: {}, selected: new Set() });
  t.S.classFilter.coarse = "drop";
  t.renderListHeader(t.visibleItems());
  assert.ok((t.el.listHeader.innerHTML + t.el.favSel.innerHTML).includes("当前筛选下没有要细看的视频"));
  t.S.classFilter.coarse = keep.cf;
  Object.assign(t.S, keep);
}

// C660: two notes whose names differ only in case get separate files in the zip.
assert.deepStrictEqual(plain(t.zipNotes("夹", [{ filename: "Go.md", markdown: "" }, { filename: "go.md", markdown: "" }], "夹").map((f) => f.name)), ["夹.md", "Go.md", "go (2).md"]);

// C674: 收藏夹设置 with no folder list says why: not read yet, the read failed, or B站 has none.
{
  const keep = { allFolders: t.S.allFolders, foldersRead: t.S.foldersRead };
  t.S.allFolders = [];
  handlers["triage-settings-get"] = () => ({ ok: false });
  for (const [read, says] of [[null, "收藏夹列表还没加载"], ["网络断了", "读取收藏夹失败：网络断了"], ["", "没有找到收藏夹"]]) {
    t.S.foldersRead = read;
    t.openSettings();
    assert.ok(t.el.folderToggles.innerHTML.includes(says), t.el.folderToggles.innerHTML);
  }
  delete handlers["triage-settings-get"];
  Object.assign(t.S, keep);
}

// C675: a video opened over a playing one keeps the first one's folders for the re-read on close.
{
  const keep = { mediaId: t.S.mediaId, viewing: t.S.viewing, viewer: t.S.viewer, quickSync: t.quickSync };
  let synced = 0;
  t.quickSync = () => synced++;
  t.S.mediaId = "F675";
  Object.assign(t.S, { viewing: "BV675", viewer: { item: item(675), folders: ["F675"] } });
  t.openViewer(item(676));
  t.S.viewer = null; // the second video is in no chosen folder
  t.closeViewer();
  assert.strictEqual(synced, 1, "the first video's folder is re-read");
  Object.assign(t.S, { mediaId: keep.mediaId, viewing: keep.viewing, viewer: keep.viewer });
  t.quickSync = keep.quickSync;
}

// T2: opening or closing the player re-lays the list; the card playing (or that was) is scrolled back into view.
{
  const keep = { list: t.el.list, viewing: t.S.viewing, viewer: t.S.viewer, quickSync: t.quickSync };
  const shown = [];
  t.el.list = { querySelector: (sel) => ({ scrollIntoView: (o) => shown.push([sel, o.block]) }), querySelectorAll: () => [] };
  t.quickSync = () => {};
  t.S.viewing = "";
  t.openViewer(item(1));
  t.closeViewer();
  assert.deepStrictEqual(shown, [[".playing", "nearest"], ['.card[data-bvid="BV1"]', "nearest"]]);
  Object.assign(t.S, { viewing: keep.viewing, viewer: keep.viewer });
  Object.assign(t, { quickSync: keep.quickSync });
  t.el.list = keep.list;
}

// C557 / C600: 已出分拣范围's kind is its tab: an empty one names the kind, not a filter; its 导出 reason names the view.
{
  const keep = { mediaId: t.S.mediaId, items: t.S.items, itemMap: t.S.itemMap, decisions: t.S.decisions, tab: t.S.tab };
  const list = t.el.list;
  t.el.list = { innerHTML: "", querySelectorAll: () => [], scrollTop: 0 };
  openFake("removed", [{ ...item(557), inFolder: null }]);
  t.S.tab = "read";
  t.S.kindFilter = "invalid";
  t.renderList();
  assert.ok(t.el.list.innerHTML.includes("没有已失效的视频"), t.el.list.innerHTML);
  t.S.kindFilter = "";
  openFake("removed", []);
  t.renderSort();
  assert.strictEqual(t.el.csvBtn.title, "已出分拣范围里没有视频");
  openFake("all", []);
  t.renderSort();
  assert.strictEqual(t.el.csvBtn.title, "勾选的收藏夹里都没有视频");
  // K8: 刷新 fills a missing 播放量 only in a single folder; elsewhere the sort just says 播放量.
  for (const [view, says] of [["all", false], ["removed", false], ["123", true]]) {
    openFake(view, [item(8)]);
    t.renderSort();
    assert.strictEqual(t.el.sortBox.innerHTML.includes("刷新后才有"), says, view);
  }
  t.el.list = list;
  Object.assign(t.S, keep);
}

// A card shows the video's title, UP, cover, the AI's words and the user's note as text.
{
  const [analysis, note] = [t.S.analyses.BV1, t.S.notes.BV1];
  for (const bad of XSS) {
    t.S.analyses.BV1 = { status: "done", source: "subtitle", verdict: "keep", oneLiner: bad, points: [bad], reason: bad };
    t.S.notes.BV1 = { text: bad };
    assertInert(t.cardHtml({ ...item(1), title: bad, upper: bad, cover: bad, folders: [{ id: 1, title: bad }] }, true, ""), "cardHtml");
  }
  [t.S.analyses.BV1, t.S.notes.BV1] = [analysis, note];
  if (!analysis) delete t.S.analyses.BV1;
  if (!note) delete t.S.notes.BV1;
}

// N5: NOT_LOGGED_IN on any request (a write too: D, 批量取消收藏, U, 关注's writes) brings up the 去登录 banner.
handlers["test-login"] = () => ({ ok: false, error: "未登录 B站", code: "NOT_LOGGED_IN" });
t.el.banner.hidden = true;
t.MoonTriage.send({ type: "test-login" }).then((r) => {
  assert.ok(r.code === "NOT_LOGGED_IN" && t.el.banner.hidden === false && t.el.banner.dataset.kind === "login" && t.el.bannerBtn.textContent === "去登录", "去登录 banner");
});

// C558: a start that throws (here: the bare stand-in list cannot take listeners) says so in the list, not a blank page.
{
  const list = t.el.list;
  const box = { innerHTML: "" };
  const err = console.error;
  t.el.list = box;
  console.error = () => {};
  t.init().then(() => {
    console.error = err;
    t.el.list = list;
    assert.ok(box.innerHTML.includes("分拣台启动失败"), box.innerHTML);
    // K29: its instruction is the table's one.
    assert.ok(box.innerHTML.includes(`，${t.MdgErrors.TEXT.reloadRetry}`), box.innerHTML);
  });
}
