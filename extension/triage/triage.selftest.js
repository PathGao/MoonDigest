// node extension/triage/triage.selftest.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

// triage.js is a DOM page module; drop the dev-mock import and init(), stub the DOM, and expose S/K.
const source = fs
  .readFileSync(path.join(__dirname, "triage.js"), "utf8")
  .replace(/^if \(!globalThis\.chrome\?\.runtime\?\.id\) await import.*$/m, "")
  .replace(/^init\(\);$/m, "");
assert.ok(!/await import|^init\(\);$/m.test(source), "harness strips the page entry points");

const stubEl = () => new Proxy({ classList: { toggle() {}, add() {}, remove() {} }, style: {}, dataset: {} }, {
  get: (o, k) => (k in o ? o[k] : () => {}),
  set: (o, k, v) => ((o[k] = v), true)
});
const store = {};
const syncStore = {};
const handlers = {};
const sent = [];
const ctx = vm.createContext({
  console,
  structuredClone,
  setTimeout: (f) => setImmediate(f),
  clearTimeout: (id) => clearImmediate(id),
  document: { getElementById: stubEl, querySelector: () => null, addEventListener() {} },
  window: { addEventListener() {} },
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
vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "limits.js"), "utf8"), ctx);
vm.runInContext(`${source}\n;globalThis.S = S; globalThis.K = K; globalThis.el = el; globalThis.verdictBadge = verdictBadge; globalThis.seenText = seenText; globalThis.staleCoarse = staleCoarse; globalThis.staleFine = staleFine; globalThis.groupDone = groupDone; globalThis.mergeHead = mergeHead; globalThis.isFinished = isFinished;`, ctx);
const t = ctx;
const plain = (v) => JSON.parse(JSON.stringify(v));
const realSync = t.syncFolder;
const toasts = [];
Object.assign(t, { render() {}, setFocus() {}, toast: (m) => toasts.push(m), askConfirm: async () => true });

const item = (n) => ({ bvid: `BV${n}`, aid: 1000 + n, title: `视频${n}`, upper: "up", duration: 61 });
function openFake(mediaId, items, decisions = {}) {
  t.S.folderToken++;
  t.S.mediaId = mediaId;
  t.S.items = items;
  t.S.itemMap = new Map(items.map((it) => [it.bvid, it]));
  t.S.decisions = decisions;
  t.S.undo = [];
  // In the page every unfavorite record is stored too; patchDecisions merges into the stored one.
  if (Object.keys(decisions).length) store[t.K.decisions(mediaId)] = structuredClone(unfavOnlyOf(decisions));
}
const unfavOnlyOf = (d) => Object.fromEntries(Object.entries(d).filter(([, v]) => v?.action === "unfav"));

(async () => {
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
  await t.batchUnfav(many);
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
  await t.refavBatch(savedA.BV0.batch);
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
  await t.batchUnfav(many);
  assert.strictEqual(Object.keys(store[t.K.decisions("A2")]).length, 45, "the first chunk's records survive");
  assert.strictEqual(t.S.undo.length, 1, "back in its folder, the batch is undoable with U");

  // U7: after a reload the unfavorited videos are listed and re-favorited into their own folder.
  openFake("A", many.slice(40), savedA);
  const recent = t.recentUnfavs();
  assert.strictEqual(recent.length, 40);
  assert.ok(t.recentUnfavHtml().includes('data-refav="BV0"'));
  handlers["triage-refav"] = () => ({ ok: true });
  t.syncFolder = async () => true;
  await t.refavRecent("BV7");
  assert.deepStrictEqual(plain(sent.at(-1)), { type: "triage-refav", mediaId: "A", aid: 1007 });
  assert.ok(!("BV7" in store[t.K.decisions("A")]), "re-favorited video leaves the recent list");
  const capped = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`BVx${i}`, { action: "unfav", at: i, aid: i, title: "x" }]));
  openFake("C", [], capped);
  assert.strictEqual(t.recentUnfavs().length, 50, "the recent list is capped");
  assert.strictEqual(t.recentUnfavs()[0][0], "BVx59", "newest first");

  // B9: a refav failure partway through a batch undo keeps the rest undoable.
  const three = [item(1), item(2), item(3)];
  openFake("D", three, Object.fromEntries(three.map((it) => [it.bvid, { action: "unfav", at: 1, aid: it.aid, title: it.title }])));
  t.S.undo = [{ kind: "unfavMany", items: three.map(({ bvid, aid }) => ({ bvid, aid })) }];
  handlers["triage-refav"] = ({ aid }) => (aid === 1002 ? { ok: false, error: "网络错误" } : { ok: true });
  await t.undo();
  assert.deepStrictEqual(Object.keys(store[t.K.decisions("D")]), ["BV2", "BV3"]);
  assert.deepStrictEqual(plain(t.S.undo), [{ kind: "unfavMany", items: [{ bvid: "BV2", aid: 1002 }, { bvid: "BV3", aid: 1003 }] }]);
  handlers["triage-refav"] = () => ({ ok: true });
  await t.undo();
  assert.deepStrictEqual(store[t.K.decisions("D")], {});
  assert.strictEqual(t.S.undo.length, 0);

  // A batch undo also runs to the end after another folder opens.
  openFake("D", three, Object.fromEntries(three.map((it) => [it.bvid, { action: "unfav", at: 1, aid: it.aid, title: it.title }])));
  t.S.undo = [{ kind: "unfavMany", items: three.map(({ bvid, aid }) => ({ bvid, aid })) }];
  let refavs = 0;
  handlers["triage-refav"] = () => {
    if (++refavs === 1) openFake("E", []);
    return { ok: true };
  };
  await t.undo();
  assert.deepStrictEqual([refavs, store[t.K.decisions("D")], toasts.at(-1)], [3, {}, "「D」已重新收藏 3 个"]);
  handlers["triage-refav"] = () => ({ ok: true });

  // B11: cells that a spreadsheet would run as a formula are prefixed with '.
  for (const s of ["=1+1", "+cmd", "-2", "@SUM(A1)", "\tx", "\rx"]) assert.ok(t.csvField(s).replace(/^"/, "").startsWith(`'${s[0]}`), s);
  assert.strictEqual(t.csvField('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`);
  assert.strictEqual(t.csvField("普通 标题"), "普通 标题");
  assert.strictEqual(t.csvField("a,b"), '"a,b"');
  openFake("E", [{ ...item(5), title: "=cmd|' /C calc'!A0", upper: "@up" }]);
  t.S.folders = t.S.allFolders = [{ id: "E", title: "+夹" }];
  const csvRows = t.buildCsv().replace(/^\uFEFF/, "").split("\r\n");
  assert.ok(csvRows[1].startsWith("'+夹,BV5,'=cmd|' /C calc'!A0,'@up,"), csvRows[1]);

  // 优先看: E adds in order, 已看 removes and marks 真人已看 without touching decisions.
  openFake("P", [item(1), item(2), item(3)], { BV2: { action: "keep", at: 1 } });
  t.S.basket = [{ bvid: "BVgone", title: "别的收藏夹" }];
  for (const b of ["BV1", "BV2", "BV3"]) t.toggleBasket(b);
  assert.deepStrictEqual(plain(store[t.K.basket]), [{ bvid: "BVgone", title: "别的收藏夹" }, ...[1, 2, 3].map((n) => ({ bvid: `BV${n}`, title: `视频${n}`, upper: "up", duration: 61 }))]);
  t.removeBasketItem(2);
  t.toggleBasket("BV1");
  assert.deepStrictEqual(plain(store[t.K.basket].map((x) => x.bvid)), ["BVgone", "BV3"]);
  assert.deepStrictEqual(plain(t.S.decisions), { BV2: { action: "keep", at: 1 } }, "已看 leaves decisions alone");

  // 批量导出 scopes: 优先看 keeps its order and videos outside the folder; invalid videos are left out.
  t.S.items.push({ ...item(4), invalid: true });
  t.S.itemMap.set("BV4", t.S.items[3]);
  t.S.basket.push({ bvid: "BV4" });
  t.S.selected.clear();
  t.S.selected.add("BV2"); // kept, so not listed in 未分析: a selection hidden there is left out
  t.S.selected.add("BV3");
  Object.assign(t.S, { tab: "none", titleRes: {}, analyses: { BVgone: { status: "done", oneLiner: "一句话", points: ["要点"] } }, notes: { BV3: { text: " 我的笔记 " } }, videoTags: {} });
  const scope = (s) => plain(t.writeScopeItems(s).map((it) => it.bvid));
  assert.deepStrictEqual([scope("basket"), scope("selected"), scope("all"), scope("filter")], [["BVgone", "BV3"], ["BV3"], ["BV1", "BV2", "BV3"], ["BV1", "BV3"]]);
  t.renderListHeader(t.visibleItems());
  assert.ok(t.el.listHeader.innerHTML.includes("已选中 1 个") && t.el.listHeader.innerHTML.includes("另有 1 个被筛选隐藏"), "the bar counts only what is listed");
  const digest = t.buildMarkdown(t.writeScopeItems("basket"));
  assert.ok(digest.includes("## [别的收藏夹](https://www.bilibili.com/video/BVgone)\n\n> 一句话\n\n- 要点"), digest);
  assert.ok(digest.includes("## [视频3](https://www.bilibili.com/video/BV3)\n\nUP：up\n\n备注：我的笔记"), digest);
  t.S.selected.clear();

  // B12: titles with | [[ ]] or newlines cannot end the index-note link early.
  assert.strictEqual(t.wikiLink("B站/2026-10-02-a_b.md", "a|b [[c]]\nd"), "[[B站/2026-10-02-a_b|a b c d]]");
  assert.strictEqual(t.wikiLink("x.md", "|||"), "[[x|x]]");

  // verdictOf precedence: invalid > done analysis > title result.
  const v = { bvid: "BVv", title: "v" };
  Object.assign(t.S, { analyses: {}, titleRes: {} });
  assert.deepStrictEqual(plain(t.verdictOf(v)), { verdict: "none", reason: "", stage: -1, failed: "" });
  t.S.titleRes.BVv = { verdict: "keep", reason: "标题", confidence: "low" };
  t.S.analyses.BVv = { status: "error", error: "超时" };
  assert.deepStrictEqual(plain(t.verdictOf(v)), { verdict: "keep", reason: "标题", stage: 1, low: true, failed: "超时" });
  t.S.analyses.BVv = { status: "done", verdict: "drop", reason: "字幕" };
  assert.strictEqual(t.verdictOf(v).stage, 2);
  assert.strictEqual(t.verdictOf({ ...v, invalid: true }).reason, "视频已失效");

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

  // 细看 batch: first GROUP_SIZE open cards of 粗看完成, or the selected ones; 细看完成 buttons follow the selection too.
  const pool = Array.from({ length: 12 }, (_, i) => item(200 + i));
  openFake("F", pool);
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
  t.S.tab = "fine";
  t.S.classFilter.fine = "all";
  assert.deepStrictEqual(plain(t.batchList("keep").map((it) => it.bvid)), ["BV210"], "the selection overrides the verdict scope");
  t.S.selected.clear();
  assert.deepStrictEqual(plain(t.batchList("drop").map((it) => it.bvid)), ["BV210", "BV211"]);
  // Buttons lead with the action and name the AI class; filter chips show the bare class name.
  t.renderListHeader(t.visibleItems());
  for (const part of ["取消收藏（AI：可清理）2 个", "保留（AI：值得留）0 个"]) assert.ok(t.el.listHeader.innerHTML.includes(part), part);
  for (const part of [">全部 2<", ">可清理 2<", ">值得留 0<", ">拿不准 0<"]) assert.ok(t.el.classFilter.innerHTML.includes(part), part);
  assert.ok(t.verdictBadge("BV210", t.verdictOf(pool[10])).includes('class="badge drop"') && t.verdictBadge("BV210", t.verdictOf(pool[10])).includes('<span class="ai-mark">AI</span>可清理'));
  t.S.classFilter.fine = "keep";
  t.renderListHeader(t.visibleItems());
  assert.ok(t.el.listHeader.innerHTML.includes("保留（AI：值得留）") && !t.el.listHeader.innerHTML.includes("取消收藏（AI"), "a filter shows only its own batch button");
  t.S.classFilter.fine = "all";
  t.S.selected.add("BV210");
  t.renderListHeader(t.visibleItems());
  assert.ok(t.el.listHeader.innerHTML.includes("取消收藏选中的 1 个") && t.el.listHeader.innerHTML.includes("保留选中的 1 个"));
  t.S.selected.clear();
  // A3: 待定 left after 细看 sits in 细看完成 under its own filter, and a selection there drives both batch buttons.
  t.S.analyses = { BV200: { status: "done", verdict: "unsure" } };
  t.S.classFilter.fine = "unsure";
  assert.deepStrictEqual(plain(t.visibleItems().map((it) => it.bvid)), ["BV200"]);
  t.renderListHeader(t.visibleItems());
  assert.ok(!t.el.listHeader.innerHTML.includes("（AI") && t.el.listHeader.innerHTML.includes("按 X 或全选后"), "待定 has no verdict-scoped button");
  // 全选 selects what this tab lists; the selection then offers 移动/复制 with 保留 ones included.
  assert.ok(t.el.listHeader.innerHTML.includes("全选这里的 1 个"));
  t.S.selected.add("BV200");
  t.renderListHeader(t.visibleItems());
  assert.ok(!t.el.listHeader.innerHTML.includes("全选这里") && t.el.listHeader.innerHTML.includes("移动/复制选中的 1 个"));
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
  assert.ok(t.el.listHeader.innerHTML.includes("细看下一批 10 个"));
  // AI-starting buttons lead with the sparkle; plain actions do not.
  assert.ok(t.el.listHeader.innerHTML.includes('<span class="ai-spark" aria-hidden="true"></span>细看下一批 10 个</button>'), "细看 carries the AI sparkle");
  assert.ok(t.verdictBadge("BV206", t.verdictOf(pool[6])).includes("低置信"), "low confidence is a badge in 粗看完成");
  t.S.classFilter.coarse = "keep";
  assert.deepStrictEqual(plain(t.nextBatch()), ["BV207", "BV209", "BV211"], "the batch comes from the filtered videos");
  t.renderListHeader(t.visibleItems());
  assert.ok(/保留（AI：值得留）3 个.*细看下一批 3 个/.test(t.el.listHeader.innerHTML), "chip 留 leads with batch 保留, 细看 second");
  t.S.classFilter.coarse = "drop";
  assert.deepStrictEqual(plain(t.batchList("drop").map((it) => it.bvid)), ["BV206", "BV208", "BV210"], "chip 可以删 gives a batch 取消收藏 list");
  t.renderListHeader(t.visibleItems());
  assert.ok(/取消收藏（AI：可清理）3 个.*细看下一批 3 个/.test(t.el.listHeader.innerHTML), "chip 可以删 leads with batch 取消收藏, 细看 second");
  assert.ok(t.el.listHeader.innerHTML.includes(">取消收藏（AI：可清理）3 个</button>"), "取消收藏 has no sparkle");
  t.S.classFilter.coarse = "keep";
  t.S.classFilter.fine = "drop";
  assert.strictEqual(t.S.classFilter.coarse, "keep", "细看完成's chip does not touch 粗看完成's");
  t.S.selected.add("BV207");
  assert.deepStrictEqual(plain(t.nextBatch()), ["BV207"], "a selection still wins");
  t.renderListHeader(t.visibleItems());
  for (const part of ["细看选中 1 个", "保留选中的 1 个", "取消收藏选中的 1 个"]) assert.ok(t.el.listHeader.innerHTML.includes(part), part);
  // The activity pill names what runs, whatever the tab: 细看 first, then 粗看; a wait keeps the job's pause button.
  t.S.group = { bvids: ["BV207"], stop: false, mediaId: String(t.S.mediaId), items: t.S.itemMap, text: "字幕细看 1/1" };
  t.S.stage1 = { ...t.S.stage1, running: true, done: 2, total: 5, mediaId: String(t.S.mediaId), text: "标题粗看中 2/5" };
  assert.deepStrictEqual(plain(t.activityState()), { text: "字幕细看 1/1", done: 0, total: 1, act: "group", actLabel: "暂停细看", warn: false });
  t.S.group = null;
  assert.deepStrictEqual(plain(t.activityState()), { text: "标题粗看中 2/5", done: 2, total: 5, act: "stage1", actLabel: "暂停粗看", warn: false });
  Object.assign(t.S, { throttleUntil: Date.now() + 61000, throttleLabel: "B站限流" });
  const waiting = t.activityState();
  assert.ok(waiting.warn && waiting.text.startsWith("B站限流，") && waiting.act === "stage1", "a wait shows its countdown and keeps 暂停粗看");
  t.S.stage1 = { ...t.S.stage1, running: false, text: "" };
  assert.ok(t.activityState().warn && !t.activityState().act, "a wait alone has no button");
  t.S.throttleUntil = 0;
  assert.strictEqual(t.activityState(), null, "nothing running hides the pill");
  // 稍后再看 progress: seconds watched, -1 once finished, 0 or missing for not started.
  assert.strictEqual(t.seenText({ seen: 98, duration: 768 }), "看过 13%");
  assert.strictEqual(t.seenText({ seen: -1, duration: 768 }), "看完了");
  assert.strictEqual(t.seenText({ seen: 0, duration: 768 }), "");
  assert.strictEqual(t.seenText({ duration: 768 }), "");
  assert.strictEqual(t.seenText({ seen: 767, duration: 768 }), "看过 99%", "unfinished never reads 100%");
  // Results remember their 判断标准; after it changes, the old ones are offered for a redo. Unstamped ones count as current.
  const savedTitles = t.S.titleRes;
  const savedAnalyses = t.S.analyses;
  t.S.folderCriteria = { F: "新标准" };
  t.S.titleRes = { BV200: { verdict: "keep", criteria: "旧标准" }, BV201: { verdict: "keep", criteria: "新标准" }, BV202: { verdict: "keep" } };
  t.S.analyses = { BV203: { status: "done", verdict: "keep", criteria: "旧标准" }, BV204: { status: "done", verdict: "keep", criteria: "新标准" } };
  assert.deepStrictEqual(plain(t.staleCoarse().map((it) => it.bvid)), ["BV200"]);
  assert.deepStrictEqual(plain(t.staleFine().map((it) => it.bvid)), ["BV203"]);
  t.S.tab = "fine";
  t.renderListHeader(t.visibleItems());
  assert.ok(t.el.listHeader.innerHTML.includes("按新标准重新细看 1 个"));
  // A redo batch counts by what it has redone, not by whether a result exists.
  const redo = { bvids: ["BV203", "BV204"], stop: false, redo: new Set(["BV203", "BV204"]) };
  assert.strictEqual(t.groupDone(redo), 0);
  redo.redo.delete("BV203");
  assert.strictEqual(t.groupDone(redo), 1);
  t.S.folderCriteria = {};
  t.S.titleRes = savedTitles;
  t.S.analyses = savedAnalyses;
  t.S.tab = "coarse";
  t.S.selected.clear();
  t.S.classFilter.coarse = "all";
  // 细看下一批 picks 待定 and low confidence before confident classes.
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
    triage_schemes: [{ id: "old" }], triage_folder_scheme: { 7: "old" }, triage_tags: [{ id: "t1", name: "AI", color: "#111" }], triage_tag_presets: [{ id: "old" }],
    triage_folder_criteria: { 7: "只留干货" }, triage_simplified_v1: true,
    triage_video_tags: { BVa: ["t1"] }, triage_basket: [{ bvid: "BVa" }],
    triage_notes: { BVa: { text: "n", updatedAt: 1 } }, triage_notes_migrated: true,
    triage_snapshot_7: { bvids: ["BVa"] }, triage_decisions_7: { BVa: { action: "keep" } },
    triage_title_BVa: { verdict: "keep" }, triage_analysis_BVa: { status: "done" },
    triage_tab: "all", aiProviderKeys: { x: "sk-live-1" }, obsidianApiKey: "secret-token"
  });
  t.S.folders = t.S.allFolders = [{ id: 7, title: "夹" }];
  const backup = plain(await t.buildBackup());
  assert.deepStrictEqual(backup.folders, { 7: { title: "夹", snapshot: { bvids: ["BVa"] }, decisions: { BVa: { action: "keep" } } } });
  assert.strictEqual(backup.schemaVersion, 3);
  assert.deepStrictEqual([backup.tags, backup.folderCriteria, backup.videoTags, backup.basket], [[{ id: "t1", name: "AI", color: "#111" }], { 7: "只留干货" }, { BVa: ["t1"] }, [{ bvid: "BVa" }]]);
  assert.ok(!("schemes" in backup) && !("folderScheme" in backup) && !/"old"/.test(JSON.stringify(backup)), "old scheme keys are not exported");
  assert.deepStrictEqual([backup.titleResults, backup.analyses], [{ BVa: { verdict: "keep" } }, { BVa: { status: "done" } }]);
  assert.deepStrictEqual(backup.notes, { BVa: { text: "n", updatedAt: 1 } });
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
  assert.ok(t.el.listHeader.innerHTML.includes("判断标准：只留干货"));
  t.el.criteriaInput = { value: "  " };
  t.saveCriteria();
  assert.deepStrictEqual(plain(store[t.K.folderCriteria]), {});
  t.renderListHeader(t.visibleItems());
  assert.ok(t.el.listHeader.innerHTML.includes("未设判断标准") && t.el.listHeader.innerHTML.includes(">写判断标准<"));

  // 移动/复制 is offered for a selection in any tab, 未分析 too.
  openFake("Z", [item(700)]);
  t.S.tab = "none";
  t.S.selected.add("BV700");
  t.renderListHeader(t.visibleItems());
  assert.ok(["移动/复制选中的 1 个", "保留选中的 1 个", "取消收藏选中的 1 个"].every((x) => t.el.listHeader.innerHTML.includes(x)), "未分析 offers every selection action");
  t.S.selected.clear();

  // 批量打标签 proposals: new tags only by name, at most 5; a verdict in the reply changes nothing.
  openFake("K", [item(600), item(601)]);
  Object.assign(t.S, { tags: [{ id: "a", name: "旧", color: "#111", folder: "K" }, { id: "o", name: "别处", color: "#222", folder: "L" }], videoTags: {}, titleRes: { BV600: { verdict: "drop", confidence: "high" } } });
  const prop = { newTags: [], rows: [], notes: [], errors: [] };
  t.mergeAiBatch(prop, { newTags: ["n1", "n2", "旧", "n3", "n4", "n5", "n6"], assignments: { BV600: { add: ["n1", "旧"], verdict: "keep" }, BV601: { verdict: "t-must" } } }, { maxNewTags: 5, folder: "K" }, new Set(["BV600", "BV601"]));
  assert.deepStrictEqual(plain(prop.newTags.map((x) => x.name)), ["n1", "n2", "n3", "n4", "n5"]);
  assert.deepStrictEqual(plain(prop.rows), [{ bvid: "BV600", add: ["new:n1", "id:a"], remove: [], reason: "", checked: true }]);
  t.S.ai.proposal = prop;
  t.el.tagsDialog = { close() {} };
  t.applyAiProposal();
  assert.deepStrictEqual(plain(t.S.tags.map((x) => x.name)), ["旧", "别处", "n1", "n2", "n3", "n4", "n5"]);
  assert.ok(t.S.tags.slice(2).every((x) => Object.keys(x).join() === "id,name,color,folder" && x.folder === "K"), "new tags belong to the open folder, no rule");
  assert.strictEqual(t.verdictOf(item(600)).verdict, "drop", "批量打标签 never changes the verdict");

  // 管理: a rule is saved trimmed and capped at 80, an empty one removed; 批量打 sends { name, rule } for every tag.
  const ruled = t.S.tags[0];
  assert.ok(t.saveTagEdit(ruled, "rule", `  ${"讲".repeat(90)} `) && ruled.rule.length === 80);
  assert.ok(t.saveTagEdit(ruled, "rule", "  讲老技术的  ") && ruled.rule === "讲老技术的");
  assert.deepStrictEqual(plain(store[t.K.tags][0]), { id: "a", name: "旧", color: "#111", folder: "K", rule: "讲老技术的" });
  assert.ok(!t.saveTagEdit(ruled, "name", "n1") && ruled.name === "旧", "a duplicate name is refused");
  t.el.aiInstruction = { value: "按深度分" };
  t.el.aiScope = { value: "filter", options: [], selectedOptions: [] };
  Object.assign(t.S, { tab: "read", aiHistory: [] });
  handlers["triage-ai-command"] = () => ({ ok: true, data: {} });
  await t.runAiCommand();
  assert.deepStrictEqual(plain(sent.at(-1).tags.slice(0, 2)), [{ name: "旧", rule: "讲老技术的" }, { name: "n1", rule: "" }]);
  assert.ok(!sent.at(-1).tags.some((x) => x.name === "别处"), "批量打 sends only the open folder's tags");
  assert.strictEqual(sent.at(-1).maxNewTags, 4, "6 tags in K: min(5, 10 - 6)");
  t.saveTagEdit(ruled, "rule", " ");
  assert.ok(!("rule" in ruled));
  t.S.ai.proposal = null;

  // The 标签 button: its text shows a pending run or proposal, and it opens 批量打 then; I always opens 批量打.
  const spark = '<span class="ai-spark" aria-hidden="true"></span>';
  const btnText = () => (t.renderTop(), t.el.aiBtn.innerHTML.replace(spark, ""));
  assert.ok((t.renderTop(), t.el.aiBtn.innerHTML.startsWith(spark)), "the 标签 button carries the AI sparkle");
  assert.deepStrictEqual([btnText(), t.tagsBtnMode()], ["标签", "manage"]);
  t.S.ai.running = true;
  assert.deepStrictEqual([btnText(), t.tagsBtnMode()], ["标签 · 运行中", "batch"]);
  Object.assign(t.S.ai, { running: false, proposal: { newTags: [], rows: [], notes: [], errors: [] } });
  assert.deepStrictEqual([btnText(), t.tagsBtnMode()], ["标签 · 待确认", "batch"]);
  t.S.ai.proposal = null;
  t.el.tagsDialog = { showModal() {} };
  t.onKey({ key: "i", target: {}, preventDefault() {} });
  assert.deepStrictEqual([t.el.tagsManage.hidden, t.el.aiForm.hidden, t.el.aiReview.hidden], [true, false, true], "I opens the 批量打 form");
  t.openTags();
  assert.deepStrictEqual([t.el.tagsManage.hidden, t.el.aiForm.hidden, t.el.aiReview.hidden], [false, true, true], "openTags opens 管理");

  // Cap: 10 tags per folder. Creating an 11th is refused, a same-name one is reused; 批量打's room shrinks to 0.
  for (const n of ["c1", "c2", "c3", "c4"]) assert.ok(t.createTag(n));
  assert.strictEqual(t.viewTags().length, 10);
  toasts.length = 0;
  assert.strictEqual(t.createTag("c5"), null);
  assert.ok(/已经有 10 个标签/.test(toasts.at(-1)) && !t.S.tags.some((x) => x.name === "c5"));
  assert.strictEqual(t.createTag("c1").folder, "K", "an existing name is still found at the cap");
  assert.strictEqual(vm.runInContext("aiNewTagRoom()", ctx), 0);
  t.renderAiForm();
  assert.ok(t.el.aiTagsPreview.innerHTML.includes("名额已满"));
  t.S.tags = t.S.tags.filter((x) => !/^c\d$/.test(x.name));
  assert.strictEqual(vm.runInContext("aiNewTagRoom()", ctx), 4);
  t.renderAiForm();
  assert.ok(t.el.aiTagsPreview.innerHTML.includes("AI 这次最多新建 4 个（这个收藏夹还剩 4 个名额）"));
  // U after 批量打 restores the tags and video tags.
  const beforeApply = plain([t.S.tags, t.S.videoTags]);
  t.S.ai.proposal = { newTags: [{ key: "z", name: "z", checked: true }], rows: [{ bvid: "BV600", add: ["new:z"], remove: [], checked: true }], notes: [], errors: [] };
  t.el.tagsDialog = { close() {} };
  t.applyAiProposal();
  const z = t.S.tags.find((x) => x.name === "z" && x.folder === "K");
  assert.ok(z && t.S.videoTags.BV600.includes(z.id));
  await t.undo();
  assert.deepStrictEqual(plain([t.S.tags, t.S.videoTags]), beforeApply);
  t.S.tags = t.S.tags.filter((x) => x.folder !== "K" || x.id === "a");
  assert.strictEqual(vm.runInContext("aiNewTagRoom()", ctx), 5, "at most 5 even with 9 left");

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
  t.S.tagFilter = new Set(t.tagChips()[0].ids);
  assert.deepStrictEqual(plain(t.S.items.filter((it) => t.passFilter(it)).map((it) => it.bvid)), ["BV1", "BV2"], "the merged chip matches either folder's tag");
  t.S.tagFilter = new Set();
  t.S.query = "y";
  assert.deepStrictEqual(plain(t.S.items.filter((it) => t.passFilter(it)).map((it) => it.bvid)), ["BV2"], "search by tag name");
  t.S.query = "";
  assert.strictEqual(t.createTag("新"), null, "no new tag outside a folder");
  t.renderTagManager();
  assert.ok(t.el.tagsRows.innerHTML.includes("请先打开一个具体收藏夹") && t.el.addTagBtn.disabled);
  t.renderAiForm();
  assert.ok(t.el.aiTagsPreview.innerHTML.includes("请先打开一个具体收藏夹"));
  const pk = vm.runInContext("picker", ctx);
  t.el.pickerInput = { value: "" };
  t.el.pickerList = { innerHTML: "", querySelector: () => null };
  const pickNames = (b, q = "") => ((pk.bvid = b), (t.el.pickerInput.value = q), t.renderPicker(), plain(pk.options.map((o) => o.create ? `+${o.create}` : o.tag.id)));
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
  // 已取消收藏 filters by AI class, 真人已看 and tags like 阅览.
  {
    const saved = { items: t.S.items, tab: t.S.tab, titleRes: t.S.titleRes, watched: t.S.watched, classFilter: t.S.classFilter };
    Object.assign(t.S, { items: [item(1), item(2), item(3)], tab: "read", titleRes: { BV1: { verdict: "keep" }, BV2: { verdict: "drop" } }, watched: { BV2: true }, classFilter: { coarse: "all", fine: "all", read: "all" } });
    const shown = () => plain(t.visibleItems().map((it) => it.bvid));
    t.renderListHeader(t.visibleItems());
    for (const part of [">全部 3<", ">值得留 1<", ">可清理 1<", ">拿不准 0<"]) assert.ok(t.el.classFilter.innerHTML.includes(part), part);
    t.S.classFilter.read = "drop";
    assert.deepStrictEqual(shown(), ["BV2"], "已取消收藏: AI class chip");
    t.S.classFilter.read = "all";
    t.S.watchedFilter = true;
    assert.deepStrictEqual(shown(), ["BV2"], "已取消收藏: 真人已看 chip");
    t.S.watchedFilter = false;
    t.S.tagFilter.add("xa");
    assert.deepStrictEqual(shown(), ["BV1"], "已取消收藏: tag chip");
    t.S.tagFilter.clear();
    Object.assign(t.S, saved);
  }
  t.S.mediaId = "A";
  t.el.pickerInput.focus = () => {};
  t.openPicker("BV1");
  t.pickOption(0);
  t.closePicker();
  assert.deepStrictEqual(plain(t.S.videoTags.BV1), ["yb"], "unticking 甲's x keeps 乙's y");
  // A 批量打 proposal skips a video that left the folder since.
  t.S.ai.proposal = { newTags: [], rows: [{ bvid: "BV1", add: ["id:xa"], remove: [], checked: true }, { bvid: "BV2", add: ["id:xa"], remove: [], checked: true }], notes: [], errors: [] };
  t.el.tagsDialog = { close() {} };
  t.applyAiProposal();
  assert.deepStrictEqual(plain([t.S.videoTags.BV1, t.S.videoTags.BV2]), [["yb", "xa"], ["xb", "yb"]]);
  pk.bvid = "";
  Object.assign(t.S, { tags: [], videoTags: {}, folders: [] });
  openFake("K", [item(600), item(601)]);

  // Migration to per-folder tags (pure).
  const fmig = (o) => plain(t.tagsByFolderMigration(o));
  const one = fmig({ tags: [{ id: "a", name: "A", color: "#1" }], videoTags: { BV1: ["a"] }, folders: [{ id: "1", bvids: ["BV1"] }, { id: "2", bvids: ["BV2"] }], fallback: "2" });
  assert.deepStrictEqual(one, { tags: [{ id: "a", name: "A", color: "#1", folder: "1" }], videoTags: { BV1: ["a"] } }, "used in one folder");
  const multi = fmig({
    tags: [{ id: "a", name: "A", color: "#1", rule: "r" }, { id: "k", name: "K", color: "#2", folder: "9" }],
    videoTags: { BV1: ["a"], BV2: ["a", "k"], BV3: ["a"], BV9: ["a"] },
    folders: [{ id: "1", bvids: ["BV1", "BV3"] }, { id: "2", bvids: ["BV2", "BV3"] }, { id: "3", bvids: ["BV3"] }]
  });
  const [a1, a2, a3] = multi.tags.filter((x) => x.name === "A");
  assert.deepStrictEqual([a1.id, a1.folder, a2.folder, a3.folder], ["a", "1", "2", "3"], "the first folder keeps the original");
  assert.ok(a2.id !== "a" && a3.id !== a2.id && a2.rule === "r" && a3.color === "#1", "copies keep name, color and rule");
  assert.deepStrictEqual(multi.tags.find((x) => x.id === "k"), { id: "k", name: "K", color: "#2", folder: "9" }, "a placed tag is left alone");
  assert.deepStrictEqual(multi.videoTags, { BV1: ["a"], BV2: [a2.id, "k"], BV3: ["a", a2.id, a3.id], BV9: ["a"] }, "each video gets the copy of every folder it is in");
  assert.deepStrictEqual(fmig({ tags: [{ id: "u", name: "U" }], videoTags: { BVx: ["u"] }, folders: [{ id: "1", bvids: [] }], fallback: "7" }).tags, [{ id: "u", name: "U", folder: "7" }], "unused → the fallback folder");
  assert.deepStrictEqual(fmig({ tags: [{ id: "u", name: "U" }], videoTags: {}, folders: [] }), { tags: [{ id: "u", name: "U" }], videoTags: {} }, "no folder: unchanged");

  // Migration (storage): last folder as fallback, chosen folders first; the flag waits until every tag is placed.
  for (const k of Object.keys(store)) delete store[k];
  const unplaced = { tags: [{ id: "a", name: "A" }, { id: "b", name: "B" }], videoTags: { BV1: ["a"] } };
  assert.deepStrictEqual(plain(await t.loadTagsByFolder(unplaced)), unplaced, "no folder yet");
  assert.ok(!store[t.K.tagsByFolder]);
  Object.assign(store, { triage_snapshot_5: { bvids: ["BV1"] }, triage_snapshot_6: { bvids: ["BV1"] }, triage_included_folders: [6, 5], triage_last_folder: "5" });
  const placed = plain(await t.loadTagsByFolder(unplaced));
  assert.deepStrictEqual(placed.tags.map((x) => [x.name, x.folder]), [["A", "6"], ["A", "5"], ["B", "5"]]);
  assert.deepStrictEqual(placed.videoTags.BV1, ["a", placed.tags[1].id]);
  assert.ok(store[t.K.tagsByFolder] === true && store.triage_tags.length === 3);
  assert.deepStrictEqual(plain(await t.loadTagsByFolder(unplaced)), unplaced, "runs once");

  // 只处理细看过的: only videos with a done 细看 from the current filter results.
  Object.assign(t.S, { tab: "read", analyses: { BV600: { status: "done", oneLiner: "x" } }, titleRes: { BV601: { verdict: "drop", confidence: "high" } } });
  t.el.aiScope = { value: "analyzed" };
  assert.deepStrictEqual(plain(t.aiScopeItems().map((it) => it.bvid)), ["BV600"]);
  t.S.analyses = {};

  // Migration (pure): criteria per seen folder, the default scheme's tags plus used ones, same names merged.
  const schemes = [
    { id: "s2", name: "学习", criteria: " 只留课程 ", tags: [{ id: "x1", name: "数学", color: "#1" }, { id: "x2", name: "AI", color: "#2" }, { id: "x3", name: "没用到" }] },
    { id: "default", name: "默认方案", criteria: "只留干货", tags: [{ id: "d1", name: "AI", description: "大模型", color: "#d" }, { id: "d2", name: "工具" }] },
    { id: "s3", name: "空", criteria: "", tags: [] }
  ];
  const mig = plain(t.simplifyMigration({
    schemes,
    folderScheme: { 2: "s2", 3: "s3", 4: "gone" },
    videoTags: { BVa: ["x2", "d1", "x1"], BVb: ["zz"] },
    folderIds: ["1", "2"],
    folderCriteria: { 9: "已有" }
  }));
  assert.deepStrictEqual(mig.tags, [{ id: "d1", name: "AI", color: "#d" }, { id: "d2", name: "工具", color: "#298287" }, { id: "x1", name: "数学", color: "#1" }]);
  assert.deepStrictEqual(mig.videoTags, { BVa: ["d1", "x1"], BVb: ["zz"] }, "a same-name tag is remapped; unknown ids stay");
  assert.deepStrictEqual(mig.folderCriteria, { 1: "只留干货", 2: "只留课程", 4: "只留干货", 9: "已有" }, "unmapped or missing scheme → default; empty criteria are not written");
  // Pre-scheme users: the global tags and criteria carry over.
  const pre = plain(t.simplifyMigration({ tags: [{ id: "t1", name: "AI", color: "#1", description: "d" }], videoTags: { BVa: ["t1"] }, criteria: "全局", folderIds: ["5"] }));
  assert.deepStrictEqual(pre, { tags: [{ id: "t1", name: "AI", color: "#1" }], videoTags: { BVa: ["t1"] }, folderCriteria: { 5: "全局" } });
  assert.deepStrictEqual(plain(t.simplifyMigration({})), { tags: [], videoTags: {}, folderCriteria: {} });

  // Migration (storage): runs once, writes the new keys, drops the old ones, then never reads them.
  for (const k of Object.keys(store)) delete store[k];
  Object.assign(store, { triage_schemes: schemes, triage_folder_scheme: { 2: "s2" }, triage_video_tags: { BVa: ["x2"] }, triage_snapshot_1: { bvids: [] }, triage_decisions_2: {} });
  const loaded = plain(await t.loadTagsAndCriteria());
  assert.deepStrictEqual(loaded.folderCriteria, { 1: "只留干货", 2: "只留课程" });
  assert.deepStrictEqual(loaded.videoTags, { BVa: ["d1"] });
  assert.deepStrictEqual(plain(store.triage_tags.map((x) => x.id)), ["d1", "d2"]);
  assert.strictEqual(store.triage_simplified_v1, true);
  assert.ok(!store.triage_schemes && !store.triage_folder_scheme, "old keys are dropped");
  store.triage_schemes = [{ id: "default", criteria: "后来改的" }];
  store.triage_folder_criteria = { 1: "我改的" };
  assert.deepStrictEqual(plain((await t.loadTagsAndCriteria()).folderCriteria), { 1: "我改的" }, "a second run reads only the new keys");
  // Pre-scheme storage: global criteria from sync, triage_tags kept.
  for (const k of Object.keys(store)) delete store[k];
  Object.assign(store, { triage_tags: [{ id: "t1", name: "AI", color: "#1" }], triage_video_tags: { BVa: ["t1"] }, triage_decisions_7: {} });
  syncStore.triageCriteria = "全局标准";
  assert.deepStrictEqual(plain(await t.loadTagsAndCriteria()), { tags: [{ id: "t1", name: "AI", color: "#1" }], videoTags: { BVa: ["t1"] }, folderCriteria: { 7: "全局标准" } });
  assert.ok(!("triageCriteria" in syncStore), "the migrated sync criteria is dropped");

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
  t.pickUnfavFolders = async () => ["B"];
  handlers["triage-unfav"] = () => ({ ok: true });
  await t.decide("BV7", "unfav");
  assert.deepStrictEqual(plain(sent.at(-1)), { type: "triage-unfav", mediaId: "B", aids: [1007] });
  assert.deepStrictEqual(plain(shared.folders), ["A"]);
  assert.strictEqual(store[t.K.decisions("B")].BV7.action, "unfav");
  assert.ok(!store[t.K.decisions("A")] && !t.S.decisions.BV7, "still in 甲, so not processed");
  assert.ok(!store[t.K.decisions("all")], "no decisions key for the merged view");
  await t.undo();
  assert.deepStrictEqual(plain(sent.at(-1)), { type: "triage-refav", mediaId: "B", aid: 1007 });
  assert.deepStrictEqual(plain(shared.folders), ["A", "B"]);
  assert.ok(!("BV7" in store[t.K.decisions("B")]));

  // 保留 belongs to the video: the one-time split moves every folder's keeps into triage_kept, newest first.
  const split = plain(t.splitKept({
    triage_decisions_A: { BV1: { action: "keep", at: 5 }, BV2: { action: "unfav", at: 6 } },
    triage_decisions_B: { BV1: { action: "keep", at: 9 }, BV3: { action: "keep", at: 1 } },
    triage_tags: []
  }));
  assert.deepStrictEqual(split.kept, { BV1: { action: "keep", at: 9 }, BV3: { action: "keep", at: 1 } });
  assert.deepStrictEqual(split.folders, { triage_decisions_A: { BV2: { action: "unfav", at: 6 } }, triage_decisions_B: {} });

  // A 保留 made in one folder shows in another; folder records keep only 取消收藏; U removes it everywhere.
  for (const k of Object.keys(store)) delete store[k];
  t.S.kept = {};
  openFake("A", [item(1)]);
  await t.decide("BV1", "keep");
  assert.deepStrictEqual(Object.keys(store[t.K.kept]), ["BV1"]);
  assert.ok(!store[t.K.decisions("A")], "保留 writes no folder record");
  t.S.decisions = { ...t.S.kept, ...store[t.K.decisions("B")] };
  assert.strictEqual(t.stageOf(item(1)), "done", "kept in A is kept in B");
  await t.undo();
  assert.deepStrictEqual(plain(store[t.K.kept]), {});
  // Unfavoriting a kept video in a folder keeps the 保留 for other folders; U restores the folder view.
  openFake("A", [item(1)]);
  await t.decide("BV1", "keep");
  handlers["triage-unfav"] = () => ({ ok: true });
  handlers["triage-refav"] = () => ({ ok: true });
  await t.decide("BV1", "unfav");
  assert.deepStrictEqual(Object.keys(store[t.K.decisions("A")]), ["BV1"]);
  assert.ok(store[t.K.kept].BV1);
  await t.undo();
  assert.deepStrictEqual(plain(store[t.K.decisions("A")]), {});
  assert.strictEqual(t.S.decisions.BV1.action, "keep");

  // 已取消收藏: a video that left every folder is recorded with where it had been; one still in another folder only gets
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
    // Moved out of triage: the source folder is the origin (after its trail); from 已取消收藏 itself the origin is kept.
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

  // 已取消收藏 renders the normal card: the leaving line and the origin in the meta, 选中 / 清理 as the pair, no 保留 / 取消收藏.
  {
    openFake("removed", []);
    const html = t.cardHtml({ ...item(1), removedAt: 5, from: [{ id: "A", title: "甲", at: 1 }, { id: "B", title: "乙", at: 3 }, { id: "C", title: "丙", at: 5 }] }, true, "");
    assert.ok(html.includes('data-select="BV1"') && html.includes('class="danger" data-clean="BV1"') && !html.includes('data-act="keep"') && !html.includes('data-act="unfav"'), html);
    assert.ok(html.includes("离开收藏夹：") && html.includes('title="原在「甲」「乙」「丙」">原在「甲」「乙」等 3 个<'), html);
    assert.ok(t.cardHtml({ ...item(2), removedAt: 5, from: [{ id: "A", title: "甲", at: 5 }] }, true, "").includes(">原在「甲」<"));
    const hidden = t.cardHtml({ ...item(3), removedAt: 5, hidden: true }, true, "");
    assert.ok(!hidden.includes("原在") && hidden.includes("已失效（B 站已隐藏）："), "a record without an origin shows none");
    assert.ok(t.cardHtml({ ...item(4), removedAt: 5, movedTo: { id: "Z", title: "外" } }, true, "").includes("移到「外」（未勾选）："));
    openFake("A", [item(1)]);
    assert.ok(t.cardHtml(item(1), false, "").includes('<span class="pair">\n            <button type="button" data-act="keep"'), "a folder's card keeps 保留 / 取消收藏 as the pair");
  }

  // Cleaning a removed video deletes its AI results, note, tags, 保留, basket entry and 取消收藏 records, and nothing else.
  Object.assign(store, { triage_analysis_BV1: {}, triage_title_BV1: {}, triage_analysis_BV5: {} });
  Object.assign(store, { triage_decisions_A: { BV1: { action: "unfav" }, BV5: { action: "unfav" } }, triage_decisions_B: { BV1: { action: "unfav" } } });
  Object.assign(t.S, { notes: { BV1: { text: "n" }, BV5: { text: "m" } }, videoTags: { BV1: ["t"] }, kept: { BV1: { action: "keep" } }, basket: [{ bvid: "BV1" }, { bvid: "BV5" }] });
  handlers["triage-folder-ids"] = () => ({ ok: true, data: { bvids: [] } });
  await t.openRemoved();
  assert.deepStrictEqual(plain(t.S.items.map((it) => it.bvid)), ["BV1"]);
  await t.cleanRemoved(t.S.items);
  assert.ok(!store.triage_analysis_BV1 && !store.triage_title_BV1 && store.triage_analysis_BV5);
  assert.deepStrictEqual(plain([Object.keys(store[t.K.notes]), store[t.K.videoTags], store[t.K.kept], store[t.K.removed]]), [["BV5"], {}, {}, {}]);
  assert.deepStrictEqual(plain(store[t.K.basket]), [{ bvid: "BV5" }]);
  assert.deepStrictEqual(plain([store.triage_decisions_A, store.triage_decisions_B]), [{ BV5: { action: "unfav" } }, {}], "cleaned videos leave 最近取消收藏");

  // Opening 已取消收藏 checks every folder's id list; a video found in one again leaves the list.
  store[t.K.removed] = { BV1: { item: item(1), at: 1 }, BV2: { item: item(2), at: 2 } };
  handlers["triage-folder-ids"] = ({ mediaId }) => ({ ok: true, data: { bvids: mediaId === "B" ? ["BV1"] : [] } });
  t.S.mediaId = "removed";
  await t.openRemoved();
  for (let i = 0; i < 20 && t.S.removedCheck; i++) await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(Object.keys(store[t.K.removed]), ["BV2"]);
  assert.deepStrictEqual(plain(t.S.items.map((it) => it.bvid)), ["BV2"]);
  assert.strictEqual(t.S.removedCount, 1);

  // Opt-in folders: a new user starts with none; someone who already triaged keeps every folder but the ones switched off.
  for (const k of Object.keys(store)) delete store[k];
  t.S.allFolders = [{ id: 1 }, { id: 2 }, { id: 3 }];
  assert.deepStrictEqual(plain(await t.loadIncluded()), []);
  delete store[t.K.included];
  Object.assign(store, { triage_snapshot_1: { bvids: [] }, triage_excluded_folders: ["2"] });
  assert.deepStrictEqual(plain(await t.loadIncluded()), ["1", "3"]);
  assert.ok(!("triage_excluded_folders" in store));
  store[t.K.included] = ["3"];
  assert.deepStrictEqual(plain(await t.loadIncluded()), ["3"], "a saved choice is kept as is");

  // A folder deleted on Bilibili: its videos move to 已取消收藏 unless still in a live folder; its records go.
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
  // saveSnapshot counts only chosen folders: BV3 left folder 2 and only an unchosen folder's stale list had it.
  store.triage_snapshot_9 = { bvids: ["BV3"], items: [item(3)] };
  await t.saveSnapshot("2", [item(2)]);
  assert.deepStrictEqual(Object.keys(store[t.K.removed]).sort(), ["BV1", "BV3"]);

  // 批量打标签 keeps running when another folder opens; its proposal stays with its folder and shows on return.
  openFake("K", [item(600), item(601)]);
  t.S.folders = t.S.allFolders = [{ id: "K", title: "夹K" }, { id: "L", title: "夹L" }];
  Object.assign(t.S, { tags: [{ id: "a", name: "旧", color: "#111", folder: "K" }, { id: "b", name: "旧", color: "#222", folder: "L" }], videoTags: {}, aiHistory: [], tab: "read", query: "", tagFilter: new Set(), classFilter: { coarse: "all", fine: "all", read: "all" } });
  Object.assign(t.S.settings, { triageTitleBatchSize: 1, triageIntervalSec: 0 });
  t.el.aiInstruction = { value: "分一下" };
  t.el.aiScope = { value: "filter", options: [], selectedOptions: [] };
  t.el.tagsDialog = { open: false };
  let aiCalls = 0;
  handlers["triage-ai-command"] = ({ items }) => {
    if (++aiCalls === 1) {
      openFake("L", [item(700)]);
      t.renderAiForm();
      assert.ok(t.el.aiScopeCount.textContent.startsWith("正在处理「夹K」的视频"), "the form in L says which folder runs");
      assert.strictEqual(vm.runInContext("activityState()", ctx).text, "标签 AI 运行中（夹K）");
    }
    return { ok: true, data: { assignments: { [items[0].bvid]: { add: ["旧"] } } } };
  };
  toasts.length = 0;
  await t.runAiCommand();
  assert.strictEqual(aiCalls, 2, "the second batch is still sent after the switch");
  assert.ok(!t.S.ai.running && t.S.ai.proposal === null, "folder L sees no proposal");
  assert.ok(/「夹K」的标签建议已完成，在状态栏点「查看」确认/.test(toasts.at(-1)), toasts.at(-1));
  assert.deepStrictEqual(plain(vm.runInContext("activityState()", ctx)), { text: "「夹K」的标签建议待确认", act: "aiOther", actLabel: "查看" }, "folder L points back to K");
  openFake("K", [item(600), item(601)]);
  assert.deepStrictEqual(plain(t.S.ai.proposal.rows.map((r) => [r.bvid, r.add])), [["BV600", ["id:a"]], ["BV601", ["id:a"]]], "K's own 旧, not L's");
  t.S.ai.proposal = null;
  Object.assign(t.S.settings, { triageTitleBatchSize: 30 });

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
  Object.assign(t.S, { titleRes: {}, analyses: {}, decisions: {}, folderCriteria: { K: "K 标准", L: "L 标准" }, stage1Skip: new Set() });
  Object.assign(t.S.settings, { triageTitleBatchSize: 1, triageIntervalSec: 0 });
  const classified = [];
  handlers["triage-classify-titles"] = ({ items, criteria }) => {
    classified.push([items[0].bvid, criteria]);
    if (classified.length === 1) {
      openFake("L", [item(820)]);
      assert.strictEqual(t.activityState().text, "标题粗看中 0/2（夹K）");
    }
    return { ok: true, data: { results: { [items[0].bvid]: { verdict: "keep", confidence: "high" } } } };
  };
  toasts.length = 0;
  await t.runStage1();
  assert.deepStrictEqual(plain(classified), [["BV810", "K 标准"], ["BV811", "K 标准"]]);
  assert.deepStrictEqual([t.S.titleRes.BV811?.criteria, t.S.stage1.running], ["K 标准", false]);
  assert.strictEqual(toasts.at(-1), "「夹K」标题粗看完成 2 个");

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
  assert.strictEqual(toasts.at(-1), "「夹K」这批字幕细看完成");
  assert.strictEqual(t.el.banner.hidden, false, "a finished run leaves a banner that is not about AI");
  assert.strictEqual(t.activityState(), null, "K's last 粗看 line is not shown in L");
  t.handleAiError("请先配置 AI 服务");
  t.startGroup(["BV820"]);
  for (let i = 0; i < 20 && t.S.group; i++) await new Promise((r) => setImmediate(r));
  assert.strictEqual(t.el.banner.hidden, true, "a run that works clears the AI banner wherever it ran");
  openFake("K", []);
  assert.strictEqual(t.activityState().text, "标题粗看完成 2 个", "back in K, its last 粗看 line shows");
  Object.assign(t.S.settings, { triageTitleBatchSize: 30 });

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

  // 所有收藏夹: a folder whose ids changed takes only the difference.
  handlers["triage-folder-ids"] = () => ({ ok: true, data: { bvids: ["BV5", ...store.triage_snapshot_6.ids] } });
  handlers["triage-folder-items"] = (m) => (itemCalls.push(m.known), { ok: true, data: { items: [item(5)], info: { intro: "" }, head: true } });
  t.S.mediaId = "all";
  t.S.loadAll = { lists: { 6: { items: store.triage_snapshot_6.items, ids: store.triage_snapshot_6.ids, at: 0 } }, check: ["6"], checkTotal: 1, queue: [], paused: false, running: false, error: "", partial: 0 };
  await t.runLoadAll(t.S.folderToken);
  assert.deepStrictEqual([itemCalls.length, t.S.loadAll.queue.length], [1, 0], "one head request, no full load queued");
  assert.strictEqual(t.S.loadAll.lists["6"].items[0].bvid, "BV5");
  assert.strictEqual(store.triage_snapshot_6.ids[0], "BV5");

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

  // R1: another triage tab's write to a shared list replaces this page's copy, so the next write here keeps it. This
  // page's own writes echo back too, and an older echo arriving after a newer edit is skipped.
  openFake("N", [item(50), item(51)], { BV51: { action: "unfav", at: 1 } });
  t.S.kept = {};
  const keep = { action: "keep", at: 5 };
  t.patchKept({ BV50: keep });
  const echo1 = { triage_kept: { newValue: structuredClone(store.triage_kept) } };
  t.S.watched = { BV50: 1 };
  vm.runInContext("saveWatched()", ctx);
  t.S.watched.BV51 = 2;
  vm.runInContext("saveWatched()", ctx);
  t.followShared({ triage_watched: { newValue: { BV50: 1 } } });
  t.followShared(echo1);
  assert.deepStrictEqual(plain(t.S.watched), { BV50: 1, BV51: 2 }, "an older echo of this page's write is skipped");
  t.followShared({ triage_kept: { newValue: { BV51: keep } }, triage_tags: { newValue: [{ id: "n", name: "新", folder: "N" }] } });
  assert.deepStrictEqual(plain([t.S.kept, t.S.decisions, t.S.tags.map((x) => x.id)]), [{ BV51: keep }, { BV51: { action: "unfav", at: 1 } }, ["n"]],
    "the other tab's 保留 list replaces this one; 取消收藏 still wins in the folder; tags follow");
  t.followShared({ triage_basket: { newValue: undefined } });
  assert.deepStrictEqual(plain(t.S.basket), [], "a removed key reads as empty");
  t.patchKept({ BV50: keep });
  assert.deepStrictEqual(Object.keys(store.triage_kept), ["BV51", "BV50"], "the next write keeps the other tab's 保留");
  Object.assign(t.S, { kept: {}, watched: {}, tags: [], basket: [] });

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
  // either folder mid-run never sends moved videos to 已取消收藏.
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
        assert.ok(t.writingTo("1") && t.writingTo("2") && !t.writingTo("3"));
        t.S.syncing = false;
        const before = sent.length;
        return realSync({ force: true }).then(async (synced) => {
          assert.strictEqual(synced, false, "no sync of a folder being written");
          await t.decide("BV924", "unfav");
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
    await t.batchTransfer(vids);
    assert.strictEqual(calls, 2);
    assert.strictEqual(store[t.K.snapshot("2")].bvids.length, 25);
    assert.deepStrictEqual(plain(store[t.K.removed]), {}, "moving between chosen folders sends nothing to 已取消收藏");
    assert.strictEqual(toasts.at(-1), "「源」已移动 25 个到「目标」");
    assert.deepStrictEqual(t.S.allFolders.map((f) => f.count), [0, 25, 0], "the folder counts follow the move");

    // A target outside triage: the moved videos go to 已取消收藏 marked with it; ticking it takes them back.
    const two = [item(950), item(951)];
    store[t.K.snapshot("1")] = snap(two);
    openFake("1", two);
    handlers["triage-transfer"] = () => ({ ok: true });
    t.askTransfer = async () => ({ how: "move", target: { id: "3" } });
    handlers["triage-transfer"] = () => (openFake("removed", []), { ok: true });
    await t.batchTransfer(two);
    assert.deepStrictEqual(plain(t.S.items.map((it) => [it.bvid, it.movedTo.title])), [["BV951", "没勾"], ["BV950", "没勾"]], "已取消收藏 open meanwhile lists them");
    openFake("1", []);
    assert.deepStrictEqual(plain(store[t.K.removed].BV950.movedTo), { id: "3", title: "没勾" });
    assert.ok(toasts.at(-1).includes("已取消收藏"), toasts.at(-1));
    handlers["triage-folder-ids"] = () => ({ ok: true, data: { bvids: ["BV950", "BV951", "BV999"] } });
    await t.recoverRemoved(["3"]);
    assert.deepStrictEqual(plain(store[t.K.removed]), {});
    assert.strictEqual(toasts.at(-1), "已从「已取消收藏」找回 2 个视频");

    // 已取消收藏 收藏到 a chosen folder: added with no source, back in that folder's list without the removed fields.
    store[t.K.removed] = { BV960: { item: item(960), at: 5 }, BV961: { item: item(961), at: 5 } };
    openFake("removed", [{ ...item(960), removedAt: 5 }, { ...item(961), removedAt: 5 }]);
    t.S.selected.add("BV960");
    t.renderListHeader(t.visibleItems());
    assert.ok(t.el.listHeader.innerHTML.includes("清理选中的 1 个") && !t.el.listHeader.innerHTML.includes("清理这 2 个"), "清理 takes the selection");
    const adds = [];
    handlers["triage-transfer"] = (m) => (adds.push([m.from, m.to, m.move, m.aids.length]), { ok: true });
    t.askTransfer = async () => ({ how: "add", target: { id: "2" } });
    await t.batchTransfer(t.S.items.slice());
    assert.deepStrictEqual(adds, [["", "2", false, 1], ["", "2", false, 1]], "one video per request");
    assert.deepStrictEqual(plain(store[t.K.removed]), {});
    assert.deepStrictEqual(plain(store[t.K.snapshot("2")].items.slice(0, 2)), [item(961), item(960)]);
    assert.strictEqual(toasts.at(-1), "已收藏 2 个到「目标」");
  }

  // 失效: a video Bilibili turns into a placeholder keeps what was known; one it hides (still in the id list, no longer
  // listed) goes to 已取消收藏 marked hidden, and an id check never takes it out again.
  {
    const was = { bvid: "BV70", title: "原标题", cover: "c.jpg", upper: "UP", intro: "简介", duration: 90 };
    const now = { bvid: "BV70", title: "已失效视频", cover: "ph.jpg", upper: "", intro: "", duration: 0, invalid: true };
    assert.deepStrictEqual(plain(t.keepInvalidInfo([now, item(71)], [was])), [{ ...now, title: "原标题", cover: "c.jpg", upper: "UP", intro: "简介", duration: 90 }, item(71)]);
    const rec = t.updateRemoved({}, {}, [item(72), item(73)], [], new Set(), 9, ["BV72"], { id: "A", title: "甲" }).removed;
    const fromA = [{ id: "A", title: "甲", at: 9 }];
    assert.deepStrictEqual(plain(rec), { BV72: { item: item(72), at: 9, from: fromA, hidden: true }, BV73: { item: item(73), at: 9, from: fromA } });
    store[t.K.removed] = structuredClone(rec);
    assert.strictEqual(await t.dropRemoved(["BV72", "BV73"]), 1, "only the unhidden one leaves on an id match");
    assert.deepStrictEqual(Object.keys(store[t.K.removed]), ["BV72"]);
    // The 已失效 chip appears when the view has one and filters to them.
    openFake("I", [{ ...item(74), invalid: true }, item(75)]);
    t.S.tab = "read";
    t.renderTabs();
    assert.ok(t.el.tagFilter.innerHTML.includes("已失效 1"));
    t.S.invalidFilter = true;
    assert.deepStrictEqual(plain(t.visibleItems().map((it) => it.bvid)), ["BV74"]);
    t.S.invalidFilter = false;
  }

  // 观看进度 on covers: bar and 看完了 mark each follow the setting; 看完了 counts the set share only (优先看过 is separate).
  {
    openFake("S", [item(80), item(81), item(82)]);
    t.S.seenPct = { BV80: [100, 1], BV81: [50, 1], BV82: null };
    t.S.watched = { BV82: 1 };
    const cfg = (bar, mark) => (t.S.seenCfg = { on: bar || mark, bar, mark, threshold: 80, style: "badge" });
    cfg(false, false);
    assert.ok(!t.coverHtml(t.S.items[0]).includes("seen-") && !t.isFinished(t.S.items[0]), "both off: nothing");
    cfg(true, false);
    assert.ok(t.coverHtml(t.S.items[1]).includes('style="width:50%"') && !t.coverHtml(t.S.items[0]).includes("seen-tag"), "bar only");
    cfg(false, true);
    const done = t.coverHtml(t.S.items[0]);
    assert.ok(done.includes("✓ 看完了") && !done.includes("seen-bar"), "mark only");
    assert.ok(!t.isFinished(t.S.items[1]) && !t.coverHtml(t.S.items[2]).includes("seen-"), "50% is under the threshold; 优先看过 stays off the cover");
    t.S.seenCfg.threshold = 50;
    assert.ok(t.coverHtml(t.S.items[1]).includes("✓ 看过 50%") && t.coverHtml(t.S.items[0]).includes("✓ 看完了"));
    t.S.seenCfg.threshold = 80;
    assert.ok(t.coverHtml(t.S.items[1]).includes('seen-tag faint">看过 50%'), "below the share: a faint 看过 N%");
    t.S.seenCfg.bar = true;
    assert.ok(t.coverHtml(t.S.items[1]).includes("faint") && t.coverHtml(t.S.items[1]).includes("seen-bar"), "with the bar too");
    t.S.seenCfg.bar = false;
    t.S.seenCfg.threshold = 50;
    // Two chips, each for its own source: 看完了 from the history, 优先看过 from 优先看.
    t.S.watched = { BV82: 1 };
    t.S.tab = "read";
    t.renderTabs();
    assert.ok(t.el.tagFilter.innerHTML.includes(">看完了<") && t.el.tagFilter.innerHTML.includes(">优先看过<"));
    t.S.finishedFilter = true;
    assert.deepStrictEqual(plain(t.visibleItems().map((it) => it.bvid)), ["BV80", "BV81"]);
    t.S.finishedFilter = false;
    t.S.watchedFilter = true;
    assert.deepStrictEqual(plain(t.visibleItems().map((it) => it.bvid)), ["BV82"]);
    t.S.watchedFilter = false;
    t.S.watched = {};
    cfg(false, false);
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
    Object.assign(t.S, { folders: [{ id: "PA", title: "A" }, { id: "PB", title: "B" }], kept: {}, unfavBatch: null, transferRun: null });
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

    // A read deferred for a folder being written is not dropped because another folder's read was waiting first.
    const ran = [];
    t.S.transferRun = { mediaId: "PA", to: "PB" };
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
    t.S.transferRun = null;
    t.syncFolder = realSync;
  }

  console.log("triage selftest: all passed");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
