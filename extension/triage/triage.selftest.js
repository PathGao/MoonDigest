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
vm.runInContext(`${source}\n;globalThis.S = S; globalThis.K = K;`, ctx);
const t = ctx;
const plain = (v) => JSON.parse(JSON.stringify(v));
const toasts = [];
Object.assign(t, { render() {}, setFocus() {}, afterProcessedChange() {}, toast: (m) => toasts.push(m), askConfirm: async () => true });

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
  t.visibleItems = () => many;
  let unfavCalls = 0;
  handlers["triage-unfav"] = () => {
    if (++unfavCalls === 2) openFake("B", [item(99)]);
    return { ok: true };
  };
  await t.batchUnfav({});
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
    triage_tags: [], triage_video_tags: { BVold: ["t"] }, triage_basket: [{ bvid: "BVbasket" }], triage_tag_presets: []
  };
  const plan = t.staleCacheKeys(all, [1], ["BVopen"]);
  assert.deepStrictEqual([...plan.keys].sort(), ["triage_analysis_BVold", "triage_decisions_9", "triage_snapshot_9", "triage_title_BVold", "triage_verdict_override_BVold"]);
  assert.deepStrictEqual([plan.videos, plan.title, plan.analysis, plan.override, plan.folders], [1, 1, 1, 1, 1]);

  console.log("triage selftest: all passed");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
