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
      sync: { get: async (d) => ({ ...d, ...structuredClone(syncStore) }) }
    }
  }
});
vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "limits.js"), "utf8"), ctx);
vm.runInContext(`${source}\n;globalThis.S = S; globalThis.K = K; globalThis.DEFAULT_TIERS = DEFAULT_TIERS; globalThis.el = el; globalThis.verdictBadge = verdictBadge; globalThis.schemePayload = schemePayload;`, ctx);
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
  assert.strictEqual(t.verdictOf({ ...v, invalid: true }).verdict, "drop", "invalid videos count as 可以删");
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
  // Default scheme: buttons lead with the action and name the AI class; chips and badges show the bare tier name.
  t.renderListHeader(t.visibleItems());
  for (const part of ["取消收藏（AI：可以删）2 个", ">可以删<", ">留<", ">待定<"]) assert.ok(t.el.listHeader.innerHTML.includes(part), part);
  assert.ok(t.verdictBadge("BV210", t.verdictOf(pool[10])).includes('<span class="ai-mark">AI</span>可以删'));
  t.S.selected.add("BV210");
  t.renderListHeader(t.visibleItems());
  assert.ok(t.el.listHeader.innerHTML.includes("取消收藏选中的 1 个") && t.el.listHeader.innerHTML.includes("保留选中的 1 个"));
  t.S.selected.clear();
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
    triage_schemes: [{ id: "default" }], triage_folder_scheme: { 7: "s2" }, triage_tags: [{ id: "old" }], triage_tag_presets: [{ id: "old" }],
    triage_video_tags: { BVa: ["t1"] }, triage_basket: [{ bvid: "BVa" }],
    triage_notes: { BVa: { text: "n", updatedAt: 1 } }, triage_notes_migrated: true,
    triage_snapshot_7: { bvids: ["BVa"] }, triage_decisions_7: { BVa: { action: "keep" } },
    triage_title_BVa: { verdict: "keep" }, triage_analysis_BVa: { status: "done" }, triage_verdict_override_BVa: { verdict: "drop" },
    triage_tab: "all", aiProviderKeys: { x: "sk-live-1" }, obsidianApiKey: "secret-token"
  });
  t.S.folders = [{ id: 7, title: "夹" }];
  const backup = plain(await t.buildBackup());
  assert.deepStrictEqual(backup.folders, { 7: { title: "夹", snapshot: { bvids: ["BVa"] }, decisions: { BVa: { action: "keep" } } } });
  assert.deepStrictEqual([backup.schemes, backup.folderScheme, backup.videoTags, backup.basket], [[{ id: "default" }], { 7: "s2" }, { BVa: ["t1"] }, [{ bvid: "BVa" }]]);
  assert.ok(!("tags" in backup) && !("tagPresets" in backup) && !/"old"/.test(JSON.stringify(backup)), "pre-scheme keys are not exported");
  assert.deepStrictEqual([backup.titleResults, backup.analyses, backup.verdictOverrides], [{ BVa: { verdict: "keep" } }, { BVa: { status: "done" } }, { BVa: { verdict: "drop" } }]);
  assert.deepStrictEqual(backup.notes, { BVa: { text: "n", updatedAt: 1 } });
  assert.ok(!/sk-live-1|secret-token|triage_tab|migrated/.test(JSON.stringify(backup)), "no secrets or unrelated keys");

  // Custom tiers: the route decides the step, the tier id the 待处理 filter and buttons; low confidence still goes to 待细看.
  const custom = {
    id: "s2",
    name: "优先级",
    criteria: "",
    tags: [{ id: "c1", name: "Rust", color: "#000" }],
    onlyMyTags: true,
    grading: {
      tiers: [
        { id: "t-must", name: "必看", route: "keep" },
        { id: "t-later", name: "有空看", route: "keep" },
        { id: "t-del", name: "删", route: "unfav" },
        { id: "t-again", name: "再看看", route: "deep" }
      ]
    }
  };
  const cv = Array.from({ length: 6 }, (_, i) => item(300 + i));
  openFake("G", cv);
  t.S.schemes = [vm.runInContext("defaultScheme()", ctx), custom];
  t.S.folderScheme = { G: "s2" };
  Object.assign(t.S, { analyses: {}, overrides: {}, decisions: {}, tab: "act", actFilter: "all" });
  t.S.selected.clear();
  t.S.titleRes = {
    BV300: { verdict: "t-must", confidence: "high" },
    BV301: { verdict: "t-later", confidence: "high" },
    BV302: { verdict: "t-del", confidence: "high" },
    BV303: { verdict: "t-again", confidence: "high" },
    BV304: { verdict: "t-must", confidence: "low" },
    BV305: { verdict: "keep", confidence: "high" }
  };
  assert.deepStrictEqual(cv.map((it) => t.stageOf(it)), ["act", "act", "act", "deep", "deep", "none"], "another scheme's tier counts as not classified");
  assert.deepStrictEqual(plain(t.batchList("t-later").map((it) => it.bvid)), ["BV301"]);
  assert.strictEqual(t.batchList(null).length, 0, "no tier, no selection → nothing");
  t.renderListHeader(t.visibleItems());
  const head = t.el.listHeader.innerHTML;
  for (const part of ['data-act-filter="t-again"', "取消收藏（AI：删）1 个", "保留（AI：必看）1 个", "保留（AI：有空看）1 个", ">再看看<"]) assert.ok(head.includes(part), part);
  assert.ok(!head.includes("AI：再看看"), "a 要细看 tier gets no batch button");
  assert.ok(t.verdictBadge("BV302", t.verdictOf(cv[2])).includes('class="badge drop"') && t.verdictBadge("BV302", t.verdictOf(cv[2])).includes('<span class="ai-mark">AI</span>删<'), "badge = AI + tier name, red for unfav");
  assert.strictEqual(t.verdictOf({ ...cv[0], invalid: true }).verdict, "t-del", "invalid counts as the first 取消收藏 tier");
  t.S.analyses = { BV305: { status: "done", verdict: "keep" } };
  assert.strictEqual(t.stageOf(cv[5]), "act", "a done 细看 stays in 待处理 even with a foreign tier");
  assert.ok(t.verdictBadge("BV305", t.verdictOf(cv[5])).includes("未分级"));
  t.S.analyses = {};
  // A deleted tier sends its 粗分 results back to 未分析.
  custom.grading.tiers = custom.grading.tiers.filter((x) => x.id !== "t-later");
  assert.strictEqual(t.stageOf(cv[1]), "none");
  // Grading off: every 粗分 result goes to 待处理, low confidence included; no tier badge, only selection buttons.
  custom.grading = null;
  assert.deepStrictEqual(cv.map((it) => t.stageOf(it)), ["act", "act", "act", "act", "act", "act"]);
  assert.strictEqual(t.verdictBadge("BV300", t.verdictOf(cv[0])), "");
  t.renderListHeader(t.visibleItems());
  assert.ok(t.el.listHeader.innerHTML.includes("取消收藏选中的 0 个") && !t.el.listHeader.innerHTML.includes("data-act-filter"));
  assert.deepStrictEqual(plain(t.schemePayload()), { criteria: "", tags: [{ name: "Rust", description: "" }], onlyMyTags: true, tiers: null });
  // Tags of another scheme stay on the video when this scheme's tags change.
  t.S.videoTags = { BV300: ["t1", "c1"] };
  t.setVideoTags("BV300", [], ["c1"]);
  assert.deepStrictEqual(plain(t.S.videoTags.BV300), ["t1"]);
  t.S.folderScheme = {};

  // Migration: global criteria, tags, 只用我的标签 and presets become schemes once; nothing is lost; later runs are no-ops.
  for (const k of Object.keys(store)) delete store[k];
  const oldTags = [{ id: "t1", name: "AI", color: "#111", description: "大模型" }];
  Object.assign(store, { triage_tags: oldTags, triage_video_tags: { BVa: ["t1"] }, triage_tag_presets: [{ id: "p1", name: "主题", instruction: "旧指令", tags: [{ name: "前端", description: "d" }] }] });
  Object.assign(syncStore, { triageCriteria: "只留干货", triageOwnTagsOnly: true });
  const first = plain(await t.loadSchemes());
  assert.strictEqual(first.schemes.length, 2);
  assert.deepStrictEqual(
    { ...first.schemes[0], grading: undefined },
    { id: "default", name: "默认方案", criteria: "只留干货", tags: oldTags, onlyMyTags: true, grading: undefined }
  );
  assert.deepStrictEqual(first.schemes[0].grading.tiers.map((x) => [x.id, x.route]), [["keep", "keep"], ["drop", "unfav"], ["unsure", "deep"]], "default tier ids are the old verdicts");
  assert.deepStrictEqual(first.schemes[1].tags.map((x) => [x.id, x.name]), [["p1-t0", "前端"]]);
  assert.ok(!("instruction" in first.schemes[1]), "the preset instruction is dropped");
  assert.strictEqual(store.triage_schemes_migrated, true);
  assert.deepStrictEqual(store.triage_video_tags, { BVa: ["t1"] }, "video tags are untouched");
  assert.deepStrictEqual(store.triage_tags, oldTags, "old keys stay for rollback");
  store.triage_schemes[0].name = "改过";
  store.triage_tags = [];
  syncStore.triageCriteria = "后来改的";
  assert.strictEqual((await t.loadSchemes()).schemes[0].name, "改过", "a second run neither rebuilds nor reads the old keys");
  delete store.triage_schemes_migrated;
  assert.strictEqual((await t.loadSchemes()).schemes[0].name, "改过", "existing schemes are never rebuilt, even without the flag");
  // The default 「删」 tier is renamed to 「可以删」 once; a renamed tier and other schemes' 删 stay.
  store.triage_schemes[0].grading.tiers[1].name = "删";
  store.triage_schemes[1].grading.tiers[1].name = "扔掉";
  store.triage_schemes.push({ id: "x", name: "x", tags: [], grading: { tiers: [{ id: "t-del", name: "删", route: "unfav" }] } });
  await t.loadSchemes();
  assert.deepStrictEqual(store.triage_schemes.map((x) => x.grading.tiers.find((y) => y.route === "unfav").name), ["可以删", "扔掉", "删"]);
  assert.strictEqual(t.renameDefaultDrop(store.triage_schemes), false, "a second run changes nothing");
  for (const k of Object.keys(store)) delete store[k];
  for (const k of Object.keys(syncStore)) delete syncStore[k];
  const fresh = plain(await t.loadSchemes());
  assert.deepStrictEqual(fresh.schemes.map((x) => x.name), ["默认方案", "学习主题", "处理优先级"], "new users get the built-in presets as schemes");
  assert.deepStrictEqual(fresh.schemes.map((x) => x.grading.tiers.map((y) => y.name).join("/")), ["留/可以删/待定", "留/可以删/待定", "留/可以删/待定"], "sample schemes inherit the default tiers");

  console.log("triage selftest: all passed");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
