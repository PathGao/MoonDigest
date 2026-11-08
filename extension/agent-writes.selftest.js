// /usr/local/bin/node extension/agent-writes.selftest.js
if (process.versions.bun) (console.error("This selftest needs Node: it fails or hangs under bun (see 自检 in CONTRIBUTING.md)."), process.exit(1));
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

// One storage and one lock manager for the worker and a 分拣台 page (its tag backend, tag-store.js), each call a tick
// late so overlapping writes really interleave.
const plain = (x) => JSON.parse(JSON.stringify(x));
const tick = () => new Promise((r) => setImmediate(r));
let local = {};
let sync = {};
const pick = (store, keys) => {
  if (keys == null) return plain(store);
  if (typeof keys === "string") keys = [keys];
  if (Array.isArray(keys)) return Object.fromEntries(keys.filter((k) => k in store).map((k) => [k, plain(store[k])]));
  return Object.fromEntries(Object.entries(keys).map(([k, d]) => [k, k in store ? plain(store[k]) : d]));
};
const listeners = [];
const chrome = {
  storage: {
    local: {
      get: async (k) => (await tick(), pick(local, k)),
      set: async (o) => (await tick(), Object.assign(local, plain(o))),
      remove: async (k) => (await tick(), [].concat(k).forEach((x) => delete local[x]))
    },
    sync: { get: async (k) => pick(sync, k) }
  }
};
const held = new Map();
const navigator = { locks: { request: (name, fn) => { const run = (held.get(name) || Promise.resolve()).then(fn); held.set(name, run.catch(() => {})); return run; } } };

// The worker's load order, with the bridge's addMethods caught so the methods can be called directly; chrome.runtime
// from agent-writes.js on (triage-bg.js would register its worker listeners with it).
const ctx = vm.createContext({ TextEncoder, URL, URLSearchParams, console, setTimeout, clearTimeout, setInterval, clearInterval, AbortController, chrome, navigator, structuredClone });
const order = [...fs.readFileSync(path.join(__dirname, "background.js"), "utf8").matchAll(/importScripts\(([^)]*)\)/g)].flatMap((m) => m[1].match(/"[^"]+"/g).map((f) => JSON.parse(f)));
assert.ok(order.indexOf("agent-writes.js") > order.indexOf("triage/triage-bg.js"), "agent-writes.js loads after triage-bg.js");
let M = null;
let switchOff = null; // the real bridge's, loaded earlier in the order
for (const file of order) {
  if (file === "agent-writes.js") {
    ctx.MdgAgentBridge = { switchOff, addMethods: (m) => (M = { ...M, ...m }) };
    chrome.runtime = { onMessage: { addListener: (l) => listeners.push(l) }, getURL: (p) => `chrome-extension://x/${p}` };
  } else if (file === "agent-mydata.js") {
    switchOff = ctx.MdgAgentBridge.switchOff;
    ctx.MdgAgentBridge = { switchOff, addMethods() {} };
  }
  vm.runInContext(fs.readFileSync(path.join(__dirname, file), "utf8"), ctx);
}
assert.deepStrictEqual(Object.keys(M), ["triage", "propose"]);
const K = ctx.MdgLimits.KEYS;
// U from the 分拣台: the message a page of the extension sends; a B站 page's content script is refused.
const undo = (id, url = "chrome-extension://x/triage/triage.html") => new Promise((r) => listeners.at(-1)({ type: "agent-undo", id }, { url }, r));

// A 收藏夹 page's tag backend over the same storage, its copy updated only by its own writes (no storage events here).
const page = vm.createContext({ chrome, navigator, console, structuredClone, setTimeout, document: { getElementById: () => null } });
page.globalThis = page;
for (const f of ["common.js", "errors.js", "limits.js", "settings.js", "tag-core.js", "triage/shared.js", "triage/runs.js", "triage/tag-picker.js", "triage/tag-store.js"]) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, f), "utf8"), page);
}

const A = "BV1aaaaaaaaa";
const B = "BV1bbbbbbbbb";
const C = "BV1ccccccccc";
const cases = [];
const check = (name, fn) => cases.push([name, fn]);
const reset = () => {
  local = {
    [K.triageIncludedFolders]: [11, "toview"],
    [K.triageSnapshot("11")]: { bvids: [A, B], items: [] },
    [K.triageSnapshot("toview")]: { bvids: [C], items: [] },
    [K.triageFolderList]: { mid: 1, folders: [{ id: 11, title: "Rust" }, { id: 22, title: "杂" }] },
    [K.triageTags]: [{ id: "t1", name: "入门", color: "#111", folder: "11" }],
    [K.triageVideoTags]: { [B]: ["t1"] }
  };
  sync = { mcpPersonalData: true, mcpWrites: true };
};
const log = () => local[K.triageAgentLog] || [];

check("switch off: TRIAGE_WRITES_OFF for both methods; on but the read switch off: PERSONAL_DATA_OFF; nothing written", async () => {
  const before = plain(local);
  for (const [s, code, words] of [[{ mcpPersonalData: true }, "TRIAGE_WRITES_OFF", /允许 AI 工具改分拣台/], [{ mcpWrites: true }, "PERSONAL_DATA_OFF", /允许 AI 工具读我的收藏/]]) {
    sync = s;
    for (const [name, p] of [["triage", { items: [{ bvid: A, kept: true }] }], ["propose", { action: "unfav", from: "11", bvids: [A] }]]) {
      const r = await M[name](p);
      assert.deepStrictEqual([r.ok, r.code], [false, code], name);
      assert.match(r.error, words);
    }
  }
  assert.deepStrictEqual(local, before);
});

check("triage refuses bad input whole, before writing anything", async () => {
  const before = plain(local);
  const refused = [
    {},
    { items: [] },
    { items: Array.from({ length: 51 }, () => ({ bvid: A, kept: true })) },
    { items: [{ bvid: "BV1", kept: true }] },
    { items: [{ bvid: A }] },
    { items: [{ bvid: A, kept: true }, { bvid: A, note: "x" }] },
    { items: [{ bvid: A, kept: "yes" }] },
    { items: [{ bvid: A, verdict: "keep" }] },
    { items: [{ bvid: A, verdict: "maybe", summary: "x" }] },
    { items: [{ bvid: A, verdict: "toString", summary: "x" }] },
    { items: [{ bvid: A, verdict: "constructor", summary: "x" }] },
    { items: [{ bvid: A, verdict: "__proto__", summary: "x" }] },
    { items: [{ bvid: A, summary: "只有总结" }] },
    { items: [{ bvid: A, verdict: "keep", summary: "x".repeat(101) }] },
    { items: [{ bvid: A, note: 5 }] },
    { items: [{ bvid: A, addTags: ["新"] }] }, // no folder
    { items: [{ bvid: A, addTags: ["新"], folderId: "22" }] }, // not ticked
    { items: [{ bvid: C, addTags: ["新"], folderId: "11" }] }, // not in that folder
    { items: [{ bvid: A, addTags: ["、"], folderId: "11" }] },
    // A good item does not get through beside a bad one.
    { items: [{ bvid: A, kept: true }, { bvid: B, verdict: "keep" }] }
  ];
  for (const p of refused) {
    const r = await M.triage(p);
    assert.deepStrictEqual([r.ok, r.code], [false, "BAD_PARAMS"], JSON.stringify(p).slice(0, 80));
  }
  assert.deepStrictEqual(local, before);
});

check("triage writes verdict, 保留, note and tags, journals it, and U puts all of it back", async () => {
  local[K.triageAnalysis(B)] = { bvid: B, status: "done", verdict: "drop", oneLiner: "旧的细看" };
  const r = await M.triage({ items: [
    { bvid: A, verdict: "keep", summary: "讲透所有权", reason: "能跟着做", points: ["一", "二"], kept: true, note: "先看第 3 节", addTags: ["入门", "进阶"], folderId: "11" },
    { bvid: B, verdict: "unsure", summary: "说不清", removeTags: ["入门"], folderId: "11" }
  ] });
  assert.deepStrictEqual(plain(r), { ok: true, data: { changed: 2 } });
  const a = local[K.triageAnalysis(A)];
  assert.deepStrictEqual([a.status, a.source, a.verdict, a.oneLiner, a.reason, a.points], ["done", "agent", "keep", "讲透所有权", "能跟着做", ["一", "二"]]);
  assert.strictEqual(local[K.triageKept][A].action, "keep");
  assert.strictEqual(local[K.triageNotes][A].text, "先看第 3 节");
  const made = local[K.triageTags].find((t) => t.name === "进阶");
  assert.deepStrictEqual(plain([made.folder, local[K.triageVideoTags]]), ["11", { [A]: ["t1", made.id] }], "B, left with no tag, drops out");
  assert.strictEqual(log().length, 1);
  assert.deepStrictEqual(plain(log()[0].made), [made.id]);

  const u = await undo(log()[0].id);
  assert.deepStrictEqual(plain(u), { ok: true, data: { n: 2, skipped: 0 } });
  assert.strictEqual(local[K.triageAnalysis(A)], undefined, "a verdict it made is removed");
  assert.strictEqual(local[K.triageAnalysis(B)].oneLiner, "旧的细看", "one it replaced comes back");
  assert.deepStrictEqual(plain([local[K.triageKept], local[K.triageNotes], local[K.triageVideoTags]]), [{}, {}, { [B]: ["t1"] }]);
  assert.deepStrictEqual(local[K.triageTags].map((t) => t.id), ["t1"], "the tag it made, carried by nothing now, goes");
  assert.deepStrictEqual(log(), []);
  const again = await undo("gone");
  assert.strictEqual((await undo("gone", "https://www.bilibili.com/")).error, "网页不能发送 agent-undo");
  assert.deepStrictEqual([again.ok, again.error], [false, "这一步已经撤销过了"], "a step undone (or unknown) is refused");
});

check("U puts back a verdict the 分拣台 stamped with its folder's criteria on open (not a change of the user's)", async () => {
  await M.triage({ items: [{ bvid: A, verdict: "keep", summary: "好" }] });
  // loadResults (fav-folders.js) stamps a result without criteria under the key's lock.
  await ctx.MdgLimits.update(K.triageAnalysis(A), (a) => ({ ...a, criteria: "" }));
  assert.deepStrictEqual(plain((await undo(log()[0].id)).data), { n: 1, skipped: 0 });
  assert.strictEqual(local[K.triageAnalysis(A)], undefined);
  // A 细看 run since is the user's: it stays.
  await M.triage({ items: [{ bvid: A, verdict: "keep", summary: "好" }] });
  await ctx.MdgLimits.update(K.triageAnalysis(A), (a) => ({ ...a, oneLiner: "重新细看", criteria: "" }));
  assert.deepStrictEqual(plain((await undo(log()[0].id)).data), { n: 1, skipped: 1 });
  assert.strictEqual(local[K.triageAnalysis(A)].oneLiner, "重新细看");
});

check("a write failing midway says what was written before it, which stays journaled", async () => {
  const set = chrome.storage.local.set;
  chrome.storage.local.set = async (o) => {
    if (K.triageAnalysis(B) in o) throw new Error("QUOTA_BYTES quota exceeded");
    return set(o);
  };
  const r = await M.triage({ items: [{ bvid: A, kept: true }, { bvid: B, verdict: "drop", summary: "坏" }] });
  chrome.storage.local.set = set;
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /^QUOTA_BYTES quota exceeded Written before the failure, and kept \(the user can undo it in the 分拣台\): BV1aaaaaaaaa\.$/);
  assert.deepStrictEqual(plain(Object.keys(log()[0].changes.kept)), [A]);
  // A write that failed is not journaled: the first one failing leaves nothing to undo or report.
  delete local[K.triageAgentLog];
  chrome.storage.local.set = async (o) => { if (K.triageKept in o) throw new Error("QUOTA_BYTES quota exceeded"); return set(o); };
  const none = await M.triage({ items: [{ bvid: C, kept: true }] });
  chrome.storage.local.set = set;
  assert.deepStrictEqual([none.error, log()], ["QUOTA_BYTES quota exceeded", []]);
});

check("U leaves what the user changed since and says how many", async () => {
  await M.triage({ items: [{ bvid: A, kept: true, note: "AI 的备注" }, { bvid: B, kept: true }] });
  const id = log()[0].id;
  // The user then edits A's note and un-keeps B.
  await ctx.MdgLimits.saveVideoNote(A, "我的备注");
  await ctx.MdgLimits.update(K.triageKept, (k) => (delete k[B], k));
  const u = await undo(id);
  assert.deepStrictEqual(plain(u.data), { n: 2, skipped: 2 });
  assert.deepStrictEqual(plain([local[K.triageNotes][A].text, local[K.triageKept]]), ["我的备注", {}], "A's 保留 went back, the user's note and B stayed");
  assert.strictEqual((await undo(id)).ok, false, "the step is gone");
});

check("a folder at its tag cap makes no new tag and says which; the journal keeps the last 20", async () => {
  sync.triageTagLimit = 1;
  const r = await M.triage({ items: [{ bvid: A, addTags: ["满了", "入门"], folderId: "11" }] });
  assert.deepStrictEqual(plain(r.data), { changed: 1, tagsNotMade: ["满了"] });
  assert.deepStrictEqual(local[K.triageVideoTags][A], ["t1"]);
  for (let i = 0; i < 21; i++) await M.triage({ items: [{ bvid: A, note: `第 ${i} 次` }] });
  assert.strictEqual(log().length, ctx.MdgLimits.TRIAGE_UNDO_STEPS);
  const nothing = await M.triage({ items: [{ bvid: A, note: "第 20 次" }] });
  assert.deepStrictEqual([nothing.data.changed, log().length], [0, 20], "an unchanged value is not journaled");
});

// L3/L4: the worker and an open 分拣台 write the same keys. A page write from a copy that has not seen the tool's
// write yet, and writes that overlap, all land.
check("interleaved with a 分拣台 page: neither loses the other's tags or 保留", async () => {
  const mem = { tags: plain(local[K.triageTags]), map: plain(local[K.triageVideoTags]) };
  const db = page.MdgTagStore.local({ keys: { tags: K.triageTags, map: K.triageVideoTags }, get: () => mem, put: (part) => Object.assign(mem, part), save: async (patch) => (await chrome.storage.local.set(patch), true) });
  const pageTag = (b) => db.write((cur) => ({ ...cur, map: { ...cur.map, [b]: ["t1"] } }));
  // The tool's write lands; the page's copy does not have it when the page writes next.
  await M.triage({ items: [{ bvid: A, addTags: ["进阶"], folderId: "11" }] });
  await pageTag(C);
  const made = local[K.triageTags].find((t) => t.name === "进阶").id;
  assert.deepStrictEqual(plain([local[K.triageVideoTags][A], local[K.triageVideoTags][C]]), [[made], ["t1"]], "the stale page write kept the tool's");
  // Overlapping, in both orders.
  await Promise.all([pageTag("x1"), M.triage({ items: [{ bvid: B, addTags: ["新"], folderId: "11" }] }), pageTag("x2")]);
  await Promise.all([M.triage({ items: [{ bvid: A, removeTags: ["进阶"], folderId: "11" }] }), pageTag("x3")]);
  const map = local[K.triageVideoTags];
  assert.ok(["x1", "x2", "x3", C].every((k) => map[k]?.[0] === "t1") && map[B].length === 2 && map[A] === undefined, JSON.stringify(map));
  assert.ok(local[K.triageTags].some((t) => t.name === "新"));
  // 保留: the page's storeEdit is a MdgLimits.update of the same key.
  await Promise.all([M.triage({ items: [{ bvid: A, kept: true }] }), page.MdgLimits.update(K.triageKept, (k = {}) => ({ ...k, [C]: { action: "keep", at: 1 } }))]);
  assert.deepStrictEqual(Object.keys(local[K.triageKept]).sort(), [A, C]);
  // U of the tool's tags after the page tagged other videos leaves those.
  await undo(log().find((e) => e.changes.tags?.[B]).id);
  assert.ok(["x1", "x2", "x3", C].every((k) => map[k]?.[0] === "t1"));
});

check("propose queues a B站 change for the user, checked whole, never written to B站", async () => {
  const ok = await M.propose({ action: "move", from: "11", to: "22", bvids: [A, B], reason: "都是入门" });
  assert.deepStrictEqual([ok.ok, ok.data.status], [true, "proposed"]);
  assert.deepStrictEqual(plain(local[K.triageAgentProposals].map(({ id, at, ...p }) => p)), [{ action: "move", from: "11", bvids: [A, B], reason: "都是入门", to: "22" }]);
  assert.ok((await M.propose({ action: "unfav", from: "toview", bvids: [C] })).ok, "稍后再看 when ticked");
  const before = plain(local);
  for (const p of [
    { action: "delete", from: "11", bvids: [A] },
    { action: "unfav", from: "22", bvids: [A] }, // not ticked
    { action: "unfav", from: "11", bvids: [C] }, // not in it
    { action: "unfav", from: "11", bvids: [] },
    { action: "unfav", from: "11", bvids: [A, A] },
    { action: "unfav", from: "11", bvids: ["av1"] },
    { action: "unfav", from: "11", to: "22", bvids: [A] },
    { action: "move", from: "11", bvids: [A] },
    { action: "move", from: "11", to: "11", bvids: [A] },
    { action: "copy", from: "11", to: "toview", bvids: [A] },
    { action: "copy", from: "11", to: "33", bvids: [A] }, // not in the folder list
    { action: "unfav", from: "11", bvids: [A], reason: "x".repeat(201) }
  ]) {
    const r = await M.propose(p);
    assert.deepStrictEqual([r.ok, r.code], [false, "BAD_PARAMS"], JSON.stringify(p));
  }
  assert.deepStrictEqual(local, before);
  for (let i = 2; i < 20; i++) await M.propose({ action: "unfav", from: "11", bvids: [A] });
  const full = await M.propose({ action: "unfav", from: "11", bvids: [A] });
  assert.deepStrictEqual([full.code, local[K.triageAgentProposals].length], ["PROPOSALS_FULL", 20]);
});

(async () => {
  for (const [name, fn] of cases) {
    reset();
    await fn();
    console.log(`ok   ${name}`);
  }
  console.log(`agent-writes selftest: all ${cases.length} passed`);
})().catch((e) => (console.error(e), process.exit(1)));
