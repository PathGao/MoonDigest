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
const handlers = {};
const sent = [];
const ctx = vm.createContext({
  console,
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
      }
    }
  }
});
vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "limits.js"), "utf8"), ctx);
vm.runInContext(`${source}\n;globalThis.S = S; globalThis.K = K;`, ctx);
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
  await t.batchUnfav({}, many);
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
  t.S.folders = [{ id: "E", title: "+夹" }];
  const csvRows = t.buildCsv().replace(/^\uFEFF/, "").split("\r\n");
  assert.ok(csvRows[1].startsWith("'+夹,BV5,'=cmd|' /C calc'!A0,'@up,"), csvRows[1]);

  // B12: titles with | [[ ]] or newlines cannot end the index-note link early.
  assert.strictEqual(t.wikiLink("B站/2026-10-02-a_b.md", "a|b [[c]]\nd"), "[[B站/2026-10-02-a_b|a b c d]]");
  assert.strictEqual(t.wikiLink("x.md", "|||"), "[[x|x]]");

  // U4: the cache cleanup removes only caches of videos and folders nothing references.
  const all = {
    triage_snapshot_1: { bvids: ["BVa"] },
    triage_decisions_1: { BVgone: { action: "unfav" } },
    triage_snapshot_9: { bvids: ["BVold"] },
    triage_decisions_9: {},
    triage_title_BVa: {}, triage_analysis_BVa: {},
    triage_title_BVold: {}, triage_analysis_BVold: {}, triage_verdict_override_BVold: {},
    triage_analysis_BVbasket: {}, triage_title_BVopen: {},
    triage_tags: [], triage_video_tags: { BVold: ["t"] }, triage_basket: [{ bvid: "BVbasket" }], triage_tag_presets: [],
    triage_notes: { BVold: { text: "n" } }
  };
  const plan = t.staleCacheKeys(all, [1], ["BVopen"]);
  assert.deepStrictEqual([...plan.keys].sort(), ["triage_analysis_BVold", "triage_decisions_9", "triage_snapshot_9", "triage_title_BVold", "triage_verdict_override_BVold"]);
  assert.deepStrictEqual([plan.videos, plan.title, plan.analysis, plan.override, plan.folders], [1, 1, 1, 1, 1]);

  // verdictOf precedence: invalid > override > done analysis > title result.
  const v = { bvid: "BVv", title: "v" };
  Object.assign(t.S, { analyses: {}, overrides: {}, titleRes: {} });
  assert.deepStrictEqual(plain(t.verdictOf(v)), { verdict: "none", reason: "", stage: -1, failed: "" });
  t.S.titleRes.BVv = { verdict: "keep", reason: "标题", confidence: "low" };
  t.S.analyses.BVv = { status: "error", error: "超时" };
  assert.deepStrictEqual(plain(t.verdictOf(v)), { verdict: "keep", reason: "标题", stage: 1, low: true, failed: "超时" });
  t.S.analyses.BVv = { status: "done", verdict: "drop", reason: "字幕" };
  assert.strictEqual(t.verdictOf(v).stage, 2);
  t.S.overrides.BVv = { verdict: "unsure", reason: "指令" };
  assert.strictEqual(t.verdictOf(v).verdict, "unsure");
  assert.strictEqual(t.verdictOf({ ...v, invalid: true }).reason, "视频已失效");

  // Progress tabs: no 粗分 → 未分析, unsure/low → 待细看, confident or 细看 done or invalid → 待处理, processed → 已处理.
  Object.assign(t.S, { analyses: {}, overrides: {}, titleRes: {}, decisions: {}, videoTags: {}, tags: [] });
  const st = (patch = {}, it = v) => {
    Object.assign(t.S, patch);
    return t.stageOf(it);
  };
  assert.strictEqual(st(), "none");
  assert.strictEqual(st({ titleRes: { BVv: { verdict: "unsure", confidence: "high" } } }), "deep");
  assert.strictEqual(st({ titleRes: { BVv: { verdict: "keep", confidence: "low" } } }), "deep");
  assert.strictEqual(st({ titleRes: { BVv: { verdict: "drop", confidence: "high" } } }), "act");
  assert.strictEqual(st({ analyses: { BVv: { status: "done", verdict: "unsure" } } }), "act");
  assert.strictEqual(st({ analyses: { BVv: { status: "error" } }, titleRes: { BVv: { verdict: "unsure" } } }), "deep", "a failed 细看 stays in 待细看 with its retry button");
  assert.strictEqual(st({ analyses: {}, titleRes: {} }, { ...v, invalid: true }), "act");
  assert.strictEqual(t.verdictOf({ ...v, invalid: true }).verdict, "drop", "invalid videos count as 建议删");
  assert.strictEqual(st({ decisions: { BVv: { action: "keep" } } }), "done");
  assert.strictEqual(st({ decisions: {} }, { ...v, invalid: true, bvid: "BVv" }), "act");
  // A1: only 取消收藏 / 保留 move a video to 已处理; tags (T, A, AI 指令) and notes do not.
  const tagged = { tags: [{ id: "t1", name: "x" }], videoTags: { BVv: ["t1"] }, notes: { BVv: { text: "备注", updatedAt: 1 } } };
  assert.strictEqual(st({ ...tagged, titleRes: {} }), "none", "a tagged, noted video without 粗分 stays in 未分析");
  assert.strictEqual(st({ titleRes: { BVv: { verdict: "unsure", confidence: "high" } } }), "deep", "tagged 待定 stays in 待细看");
  assert.strictEqual(st({ analyses: { BVv: { status: "done", verdict: "keep" } } }), "act", "tagged after 细看 stays in 待处理");
  assert.strictEqual(st({ decisions: { BVv: { action: "unfav" } } }), "done");
  Object.assign(t.S, { videoTags: {}, tags: [], notes: {} });

  // 待细看 batch: first GROUP_SIZE open cards, or the selected ones; 待处理 buttons follow the selection too.
  const pool = Array.from({ length: 12 }, (_, i) => item(200 + i));
  openFake("F", pool);
  t.S.titleRes = Object.fromEntries(pool.map((it, i) => [it.bvid, { verdict: i < 10 ? "unsure" : "drop", confidence: "high" }]));
  t.S.selected.clear();
  assert.deepStrictEqual(plain(t.nextBatch()), pool.slice(0, 8).map((it) => it.bvid));
  t.S.selected.add("BV209");
  t.S.selected.add("BV210");
  assert.deepStrictEqual(plain(t.nextBatch()), ["BV209"], "a selected card outside 待细看 is ignored");
  t.S.tab = "act";
  t.S.actFilter = "all";
  assert.deepStrictEqual(plain(t.batchList("keep").map((it) => it.bvid)), ["BV210"], "the selection overrides the verdict scope");
  t.S.selected.clear();
  assert.deepStrictEqual(plain(t.batchList("drop").map((it) => it.bvid)), ["BV210", "BV211"]);
  // A3: 待定 left after 细看 sits in 待处理 under its own filter, and a selection there drives both batch buttons.
  t.S.analyses = { BV200: { status: "done", verdict: "unsure" } };
  t.S.actFilter = "unsure";
  assert.deepStrictEqual(plain(t.visibleItems().map((it) => it.bvid)), ["BV200"]);
  assert.strictEqual(t.batchList("keep").length, 0, "without a selection 待定 has no verdict-scoped batch");
  t.S.selected.add("BV200");
  assert.deepStrictEqual(plain(t.batchList("keep").map((it) => it.bvid)), ["BV200"]);
  assert.deepStrictEqual(plain(t.batchList("drop").map((it) => it.bvid)), ["BV200"]);
  t.batchKeep(t.batchList("keep"));
  assert.strictEqual(t.stageOf(pool[0]), "done", "batch 保留 moves it to 已处理");
  Object.assign(t.S, { analyses: {}, decisions: {}, actFilter: "all" });
  t.S.selected.clear();
  // A5: 待细看 lists the next batch first and failed cards last.
  t.S.tab = "deep";
  t.S.analyses = { BV201: { status: "error", error: "x" } };
  const deepOrder = plain(t.visibleItems().map((it) => it.bvid));
  assert.deepStrictEqual(deepOrder.slice(0, 8), ["BV200", "BV202", "BV203", "BV204", "BV205", "BV206", "BV207", "BV208"]);
  assert.strictEqual(deepOrder.at(-1), "BV201");
  t.S.selected.add("BV209");
  assert.strictEqual(t.visibleItems()[0].bvid, "BV209", "a selected card is the batch and goes first");
  t.S.selected.clear();
  Object.assign(t.S, { analyses: {}, tab: "act" });
  assert.strictEqual(vm.runInContext("currentStage(stageCounts())", ctx), "deep", "the default tab is the earliest step with videos");

  // Backup maps storage keys to sections and never exports secrets or unrelated keys.
  for (const k of Object.keys(store)) delete store[k];
  Object.assign(store, {
    triage_tags: [{ id: "t1" }], triage_video_tags: { BVa: ["t1"] }, triage_basket: [{ bvid: "BVa" }], triage_tag_presets: [{ id: "p" }],
    triage_notes: { BVa: { text: "n", updatedAt: 1 } }, triage_notes_migrated: true,
    triage_snapshot_7: { bvids: ["BVa"] }, triage_decisions_7: { BVa: { action: "keep" } },
    triage_title_BVa: { verdict: "keep" }, triage_analysis_BVa: { status: "done" }, triage_verdict_override_BVa: { verdict: "drop" },
    triage_tab: "all", aiProviderKeys: { x: "sk-live-1" }, obsidianApiKey: "secret-token"
  });
  t.S.folders = [{ id: 7, title: "夹" }];
  const backup = plain(await t.buildBackup());
  assert.deepStrictEqual(backup.folders, { 7: { title: "夹", snapshot: { bvids: ["BVa"] }, decisions: { BVa: { action: "keep" } } } });
  assert.deepStrictEqual([backup.tags, backup.videoTags, backup.basket, backup.tagPresets], [[{ id: "t1" }], { BVa: ["t1"] }, [{ bvid: "BVa" }], [{ id: "p" }]]);
  assert.deepStrictEqual([backup.titleResults, backup.analyses, backup.verdictOverrides], [{ BVa: { verdict: "keep" } }, { BVa: { status: "done" } }, { BVa: { verdict: "drop" } }]);
  assert.deepStrictEqual(backup.notes, { BVa: { text: "n", updatedAt: 1 } });
  assert.ok(!/sk-live-1|secret-token|triage_tab|migrated/.test(JSON.stringify(backup)), "no secrets or unrelated keys");

  console.log("triage selftest: all passed");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
