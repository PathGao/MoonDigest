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
vm.runInContext(`${source}\n;globalThis.S = S; globalThis.K = K; globalThis.el = el; globalThis.verdictBadge = verdictBadge;`, ctx);
const t = ctx;
const plain = (v) => JSON.parse(JSON.stringify(v));
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
}

(async () => {
  // B8: switching folders while a batch unfavorite is in flight keeps the finished chunks, aid and title included.
  const many = Array.from({ length: 45 }, (_, i) => item(i));
  openFake("A", many);
  let unfavCalls = 0;
  handlers["triage-unfav"] = () => {
    if (++unfavCalls === 2) openFake("B", [item(99)]);
    return { ok: true };
  };
  await t.batchUnfav(many);
  assert.strictEqual(unfavCalls, 2, "no chunk is sent after the folder switch");
  const savedA = store[t.K.decisions("A")];
  assert.strictEqual(Object.keys(savedA).length, 40, "both finished chunks are recorded under folder A");
  assert.deepStrictEqual(plain(savedA.BV25), { action: "unfav", at: savedA.BV25.at, aid: 1025, title: "视频25" });
  assert.deepStrictEqual(plain(t.S.decisions), {}, "folder B's decisions are untouched");
  assert.strictEqual(t.S.undo.length, 0, "folder B's undo stack gets no entry for folder A");

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

  // B11: cells that a spreadsheet would run as a formula are prefixed with '.
  for (const s of ["=1+1", "+cmd", "-2", "@SUM(A1)", "\tx", "\rx"]) assert.ok(t.csvField(s).replace(/^"/, "").startsWith(`'${s[0]}`), s);
  assert.strictEqual(t.csvField('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`);
  assert.strictEqual(t.csvField("普通 标题"), "普通 标题");
  assert.strictEqual(t.csvField("a,b"), '"a,b"');
  openFake("E", [{ ...item(5), title: "=cmd|' /C calc'!A0", upper: "@up" }]);
  t.S.folders = t.S.allFolders = [{ id: "E", title: "+夹" }];
  const csvRows = t.buildCsv().replace(/^\uFEFF/, "").split("\r\n");
  assert.ok(csvRows[1].startsWith("'+夹,BV5,'=cmd|' /C calc'!A0,'@up,"), csvRows[1]);

  // 优先看: E adds in order with only bvid + title, ↑↓ reorder, 看过了 removes without touching decisions.
  openFake("P", [item(1), item(2), item(3)], { BV2: { action: "keep", at: 1 } });
  t.S.basket = [{ bvid: "BVgone", title: "别的收藏夹" }];
  for (const b of ["BV1", "BV2", "BV3"]) t.toggleBasket(b);
  assert.deepStrictEqual(plain(store[t.K.basket]), [{ bvid: "BVgone", title: "别的收藏夹" }, { bvid: "BV1", title: "视频1" }, { bvid: "BV2", title: "视频2" }, { bvid: "BV3", title: "视频3" }]);
  t.basketAction("up", 3);
  t.basketAction("down", 0);
  assert.strictEqual(t.basketAction("down", 3), undefined, "the last item cannot move down");
  assert.deepStrictEqual(plain(t.S.basket.map((x) => x.bvid)), ["BV1", "BVgone", "BV3", "BV2"]);
  t.basketAction("done", 3);
  t.toggleBasket("BV1");
  assert.deepStrictEqual(plain(store[t.K.basket].map((x) => x.bvid)), ["BVgone", "BV3"]);
  assert.deepStrictEqual(plain(t.S.decisions), { BV2: { action: "keep", at: 1 } }, "看过了 leaves decisions alone");

  // 批量导出 scopes: 优先看 keeps its order and videos outside the folder; invalid videos are left out.
  t.S.items.push({ ...item(4), invalid: true });
  t.S.itemMap.set("BV4", t.S.items[3]);
  t.S.basket.push({ bvid: "BV4" });
  t.S.selected.clear();
  t.S.selected.add("BV2");
  Object.assign(t.S, { tab: "none", titleRes: {}, analyses: { BVgone: { status: "done", oneLiner: "一句话", points: ["要点"] } }, notes: { BV3: { text: " 我的笔记 " } }, videoTags: {} });
  const scope = (s) => plain(t.writeScopeItems(s).map((it) => it.bvid));
  assert.deepStrictEqual([scope("basket"), scope("selected"), scope("all"), scope("filter")], [["BVgone", "BV3"], ["BV2"], ["BV1", "BV2", "BV3"], ["BV1", "BV3"]]);
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
  // A1: only 取消收藏 / 保留 move a video to 处理完成; tags (T, AI 指令) and notes do not.
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
  assert.deepStrictEqual(plain(t.nextBatch()), pool.slice(0, 8).map((it) => it.bvid));
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
  for (const part of ["取消收藏（AI：可清理）2 个", "保留（AI：值得留）0 个", ">全部 2<", ">可清理 2<", ">值得留 0<", ">拿不准 0<"]) assert.ok(t.el.listHeader.innerHTML.includes(part), part);
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
  assert.ok(!t.el.listHeader.innerHTML.includes("（AI") && t.el.listHeader.innerHTML.includes("按 X 选中后"), "待定 has no verdict-scoped button");
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
  for (const part of [">全部 12<", ">值得留 3<", ">可清理 3<", ">拿不准 6<", "细看下一批 8 个"]) assert.ok(t.el.listHeader.innerHTML.includes(part), part);
  assert.ok(t.verdictBadge("BV206", t.verdictOf(pool[6])).includes("低置信"), "low confidence is a badge in 粗看完成");
  t.S.classFilter.coarse = "keep";
  assert.deepStrictEqual(plain(t.nextBatch()), ["BV207", "BV209", "BV211"], "the batch comes from the filtered videos");
  t.renderListHeader(t.visibleItems());
  assert.ok(/保留（AI：值得留）3 个.*细看下一批 3 个/.test(t.el.listHeader.innerHTML), "chip 留 leads with batch 保留, 细看 second");
  t.S.classFilter.coarse = "drop";
  assert.deepStrictEqual(plain(t.batchList("drop").map((it) => it.bvid)), ["BV206", "BV208", "BV210"], "chip 可以删 gives a batch 取消收藏 list");
  t.renderListHeader(t.visibleItems());
  assert.ok(/取消收藏（AI：可清理）3 个.*细看下一批 3 个/.test(t.el.listHeader.innerHTML), "chip 可以删 leads with batch 取消收藏, 细看 second");
  t.S.classFilter.coarse = "keep";
  t.S.classFilter.fine = "drop";
  assert.strictEqual(t.S.classFilter.coarse, "keep", "细看完成's chip does not touch 粗看完成's");
  t.S.selected.add("BV207");
  assert.deepStrictEqual(plain(t.nextBatch()), ["BV207"], "a selection still wins");
  t.renderListHeader(t.visibleItems());
  for (const part of ["细看选中 1 个", "保留选中的 1 个", "取消收藏选中的 1 个"]) assert.ok(t.el.listHeader.innerHTML.includes(part), part);
  t.S.selected.clear();
  t.S.classFilter.coarse = "all";
  // 细看下一批 picks 待定 and low confidence before confident classes.
  t.S.titleRes = Object.fromEntries(pool.map((it, i) => [it.bvid, i < 6 ? { verdict: "keep", confidence: "high" } : i < 9 ? { verdict: "unsure", confidence: "high" } : { verdict: "drop", confidence: "low" }]));
  assert.deepStrictEqual(plain(t.nextBatch()), ["BV206", "BV207", "BV208", "BV209", "BV210", "BV211", "BV200", "BV201"]);
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
  assert.ok(t.el.listHeader.innerHTML.includes("未设判断标准") && t.el.listHeader.innerHTML.includes("写一句"));

  // AI 指令 proposals: new tags only by name, at most 5; a verdict in the reply changes nothing.
  openFake("K", [item(600), item(601)]);
  Object.assign(t.S, { tags: [{ id: "a", name: "旧", color: "#111" }], videoTags: {}, titleRes: { BV600: { verdict: "drop", confidence: "high" } } });
  const prop = { newTags: [], rows: [], notes: [], errors: [] };
  t.mergeAiBatch(prop, { newTags: ["n1", "n2", "旧", "n3", "n4", "n5", "n6"], assignments: { BV600: { add: ["n1", "旧"], verdict: "keep" }, BV601: { verdict: "t-must" } } }, { maxNewTags: 5 }, new Set(["BV600", "BV601"]));
  assert.deepStrictEqual(plain(prop.newTags.map((x) => x.name)), ["n1", "n2", "n3", "n4", "n5"]);
  assert.deepStrictEqual(plain(prop.rows), [{ bvid: "BV600", add: ["new:n1", "id:a"], remove: [], reason: "", checked: true }]);
  t.S.ai.proposal = prop;
  t.el.aiDialog = { close() {} };
  t.applyAiProposal();
  assert.deepStrictEqual(plain(t.S.tags.map((x) => x.name)), ["旧", "n1", "n2", "n3", "n4", "n5"]);
  assert.ok(t.S.tags.every((x) => Object.keys(x).join() === "id,name,color"), "tags carry only id, name and color");
  assert.strictEqual(t.verdictOf(item(600)).verdict, "drop", "AI 指令 never changes the verdict");

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
    tags: [{ id: "f", name: "美食", color: "#1" }],
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

  // F2 所有收藏夹: one entry per video with every folder; an unfav newer than a folder's cache drops that folder.
  const merged = plain(t.mergeFolderItems([
    { id: "A", at: 10, items: [item(1), item(2)], decisions: {} },
    { id: "B", at: 10, items: [item(2), item(3), item(4)], decisions: { BV3: { action: "unfav", at: 20 }, BV4: { action: "unfav", at: 5 } } }
  ]));
  assert.deepStrictEqual(merged.map((it) => [it.bvid, it.folders]), [["BV1", ["A"]], ["BV2", ["A", "B"]], ["BV4", ["B"]]], "BV3 unfavorited after B's cache; BV4 re-favorited since");

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

  // 已取消收藏: a video that left every folder is recorded; moved to another folder or listed again, it is not.
  const rec = t.updateRemoved({ BV9: { item: item(9), at: 1 } }, [item(1), item(2), item(3)], [item(1), item(9)], new Set(["BV3"]), 5);
  assert.deepStrictEqual(plain(rec), { BV2: { item: item(2), at: 5 } }, "BV3 is in another folder, BV9 came back");

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

  // 阅览: every step in one list, the AI-class chip filters across steps.
  openFake("R", [item(701), item(702), item(703), item(704)]);
  Object.assign(t.S, { tab: "read", query: "", tagFilter: new Set(), classFilter: { coarse: "all", fine: "all", read: "drop" },
    titleRes: { BV701: { verdict: "drop", confidence: "high" }, BV702: { verdict: "keep", confidence: "high" } },
    analyses: { BV703: { status: "done", verdict: "drop" } }, decisions: {} });
  assert.deepStrictEqual(plain(t.visibleItems().map((it) => it.bvid)), ["BV701", "BV703"], "粗看 and 细看 可以删 together, 未分析 left out");
  t.S.classFilter.read = "all";
  assert.strictEqual(t.visibleItems().length, 4);
  Object.assign(t.S, { titleRes: {}, analyses: {}, classFilter: { coarse: "all", fine: "all", read: "all" } });

  console.log("triage selftest: all passed");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
