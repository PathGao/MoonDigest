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
  },
  cookies: { get: async () => ({ value: "csrf" }) }
};
const held = new Map();
const navigator = { locks: { request: (name, fn) => { const run = (held.get(name) || Promise.resolve()).then(fn); held.set(name, run.catch(() => {})); return run; } } };

// The worker's load order, with the bridge's addMethods caught so the methods can be called directly; chrome.runtime
// from agent-writes.js on (triage-bg.js would register its worker listeners with it).
// B站's gaps between requests (300 ms, 1 s) pass at once here; the request timeout stays.
const ctx = vm.createContext({ TextEncoder, URL, URLSearchParams, console, setTimeout: (f, ms) => setTimeout(f, ms > 5000 ? ms : 0), clearTimeout, setInterval, clearInterval, AbortController, chrome, navigator, structuredClone });
const order = [...fs.readFileSync(path.join(__dirname, "background.js"), "utf8").matchAll(/importScripts\(([^)]*)\)/g)].flatMap((m) => m[1].match(/"[^"]+"/g).map((f) => JSON.parse(f)));
assert.ok(order.indexOf("agent-writes.js") > order.indexOf("triage/triage-bg.js"), "agent-writes.js loads after triage-bg.js");
let M = null;
for (const file of order) {
  if (file === "agent-writes.js") {
    ctx.MdgAgentBridge = { addMethods: (m) => (M = { ...M, ...m }) };
    chrome.runtime = { onMessage: { addListener: (l) => listeners.push(l) }, getURL: (p) => `chrome-extension://x/${p}` };
  } else if (file === "agent-mydata.js") {
    ctx.MdgAgentBridge = { addMethods() {} };
  }
  vm.runInContext(fs.readFileSync(path.join(__dirname, file), "utf8"), ctx);
}
assert.deepStrictEqual(Object.keys(M), ["triage", "favWrite", "undo", "log", "triageSettings", "collection", "collectionWrite", "covers", "sync"]);
// B站, faked: every request recorded; a route answers by path (default: code 0).
const posts = [];
let routes = {};
ctx.fetch = async (url, init = {}) => {
  const u = new URL(url);
  const body = Object.fromEntries(new URLSearchParams(init.body || ""));
  if (init.method === "POST") posts.push([u.pathname, body]);
  const r = routes[u.pathname]?.(u.searchParams, body) ?? { code: 0, data: {} };
  return r.status ? { ok: false, status: r.status } : { ok: true, status: 200, json: async () => r };
};
const far = () => Date.now() + 50_000;
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
  sync = {};
};
const log = () => local[K.triageAgentLog] || [];

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
    { items: [{ bvid: A, addTags: ["一二三四五六七八九十一二三"], folderId: "11" }] }, // past the 12 a tag name holds
    // A good item does not get through beside a bad one.
    { items: [{ bvid: A, kept: true }, { bvid: B, verdict: "keep" }] }
  ];
  for (const p of refused) {
    const r = await M.triage(p);
    assert.deepStrictEqual([r.ok, r.code], [false, "BAD_PARAMS"], JSON.stringify(p).slice(0, 80));
  }
  assert.deepStrictEqual(local, before);
});

check("a journal that cannot be written leaves the call ok, with noUndo: the writes landed, so no error to retry on", async () => {
  const set = chrome.storage.local.set;
  chrome.storage.local.set = async (o) => {
    if (K.triageAgentLog in o) throw new Error("quota");
    return set(o);
  };
  try {
    const r = await M.triage({ items: [{ bvid: A, kept: true }] });
    assert.deepStrictEqual(plain(r), { ok: true, data: { changed: 1, noUndo: true } });
    assert.deepStrictEqual(log(), []);
  } finally {
    chrome.storage.local.set = set;
  }
});

check("triage writes verdict, 保留, note and tags, journals it, and U puts all of it back", async () => {
  local[K.triageAnalysis(B)] = { bvid: B, status: "done", verdict: "drop", oneLiner: "旧的细看" };
  const r = await M.triage({ items: [
    { bvid: A, verdict: "keep", summary: "讲透所有权", reason: "能跟着做", points: ["一", "二"], kept: true, note: "先看第 3 节", addTags: ["入门", "进阶"], folderId: "11" },
    { bvid: B, verdict: "unsure", summary: "说不清", removeTags: ["入门"], folderId: "11" }
  ] });
  assert.deepStrictEqual(plain(r), { ok: true, data: { changed: 2, undoId: log()[0].id } });
  const a = local[K.triageAnalysis(A)];
  assert.deepStrictEqual([a.status, a.source, a.verdict, a.oneLiner, a.reason, a.points], ["done", "agent", "keep", "讲透所有权", "能跟着做", ["一", "二"]]);
  assert.strictEqual(local[K.triageKept][A].action, "keep");
  assert.strictEqual(local[K.triageNotes][A].text, "先看第 3 节");
  const made = local[K.triageTags].find((t) => t.name === "进阶");
  assert.deepStrictEqual(plain([made.folder, local[K.triageVideoTags]]), ["11", { [A]: ["t1", made.id] }], "B, left with no tag, drops out");
  assert.strictEqual(log().length, 1);
  assert.deepStrictEqual(plain(log()[0].made), [made.id]);

  const u = await undo(log()[0].id);
  assert.deepStrictEqual(plain(u), { ok: true, data: { id: r.data.undoId, n: 2, skipped: 0 } });
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
  assert.deepStrictEqual(Object.values(plain((await undo(log()[0].id)).data)).slice(1), [1, 0]);
  assert.strictEqual(local[K.triageAnalysis(A)], undefined);
  // A 细看 run since is the user's: it stays.
  await M.triage({ items: [{ bvid: A, verdict: "keep", summary: "好" }] });
  await ctx.MdgLimits.update(K.triageAnalysis(A), (a) => ({ ...a, oneLiner: "重新细看", criteria: "" }));
  assert.deepStrictEqual(Object.values(plain((await undo(log()[0].id)).data)).slice(1), [1, 1]);
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
  assert.deepStrictEqual([u.data.n, u.data.skipped], [2, 2]);
  assert.deepStrictEqual(plain([local[K.triageNotes][A].text, local[K.triageKept]]), ["我的备注", {}], "A's 保留 went back, the user's note and B stayed");
  assert.strictEqual((await undo(id)).ok, false, "the step is gone");
});

check("a folder at its tag cap makes no new tag and says which; the journal keeps the last 100", async () => {
  sync.triageTagLimit = 1;
  const r = await M.triage({ items: [{ bvid: A, addTags: ["满了", "入门"], folderId: "11" }] });
  assert.deepStrictEqual(plain(r.data), { changed: 1, undoId: log()[0].id, tagsNotMade: ["满了"] });
  assert.deepStrictEqual(local[K.triageVideoTags][A], ["t1"]);
  for (let i = 0; i < 101; i++) await M.triage({ items: [{ bvid: A, note: `第 ${i} 次` }] });
  assert.strictEqual(log().length, 100);
  const nothing = await M.triage({ items: [{ bvid: A, note: "第 100 次" }] });
  assert.deepStrictEqual([nothing.data.changed, log().length], [0, 100], "an unchanged value is not journaled");
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

// ---------- favWrite: B站 changes at once, the local records follow, undo reverses ----------
const vid = (bvid, aid, more = {}) => ({ bvid, aid, title: `标题${aid}`, ...more });
const favReset = () => {
  local = {
    [K.triageIncludedFolders]: ["11", "33"],
    [K.triageSnapshot("11")]: { bvids: [A, B], invalid: [], titles: {}, items: [vid(A, 1), vid(B, 2)], ids: [A, B], title: "Rust" },
    [K.triageSnapshot("33")]: { bvids: [B], invalid: [], titles: {}, items: [vid(B, 2)], ids: [B], title: "已有" },
    [K.triageFolderList]: { mid: 1, folders: [{ id: 11, title: "Rust" }, { id: 22, title: "杂" }, { id: 33, title: "已有" }] }
  };
  posts.length = 0;
  routes = {
    "/x/web-interface/nav": () => ({ code: 0, data: { isLogin: true, mid: 1 } }),
    // What B站 says each folder holds: 33 has B, which MoonDigest's copy of it may or may not know.
    "/x/v3/fav/resource/ids": (q) => ({ code: 0, data: q.get("media_id") === "33" ? [{ type: 2, bvid: B }] : [] })
  };
};
const paths = () => posts.map(([p]) => p.replace("/x/v3/fav/", ""));

check("move: B站 is written at once, the source list loses them, a target outside triage sends them to 已出分拣范围; undo moves them back", async () => {
  favReset();
  const r = await M.favWrite({ op: "move", from: "11", to: "22", bvids: [A] }, far());
  assert.deepStrictEqual([r.ok, plain(r.data.done), r.data.notDone.length], [true, [A], 0]);
  assert.deepStrictEqual(plain(posts), [["/x/v3/fav/resource/move", { src_media_id: "11", tar_media_id: "22", mid: "1", resources: "1:2", platform: "web", csrf: "csrf" }]]);
  assert.deepStrictEqual(local[K.triageSnapshot("11")].bvids, [B]);
  assert.deepStrictEqual(plain(local[K.triageRemoved][A].movedTo), { id: "22", title: "杂" });
  const [e] = log();
  assert.deepStrictEqual([e.kind, e.op, e.n, e.id, plain(e.titles)], ["fav", "move", 1, r.data.undoId, { from: "Rust", to: "杂" }]);
  const u = await M.undo({}, far());
  assert.deepStrictEqual([u.ok, u.data.n, u.data.left], [true, 1, undefined]);
  assert.deepStrictEqual(plain(posts[1]), ["/x/v3/fav/resource/move", { src_media_id: "22", tar_media_id: "11", mid: "1", resources: "1:2", platform: "web", csrf: "csrf" }]);
  assert.deepStrictEqual([local[K.triageSnapshot("11")].bvids, local[K.triageRemoved][A], log().length], [[A, B], undefined, 0]);
});

check("copy: one the target already held stays there on undo; only the new one is taken out", async () => {
  favReset();
  const r = await M.favWrite({ op: "copy", from: "11", to: "33", bvids: [A, B] }, far());
  assert.deepStrictEqual([plain(r.data.done), local[K.triageSnapshot("33")].bvids, log()[0].had], [[A, B], [A, B], [B]]);
  await M.undo({ id: r.data.undoId }, far());
  assert.deepStrictEqual(plain(posts[1]), ["/x/v3/fav/resource/batch-del", { media_id: "33", resources: "1:2", platform: "web", csrf: "csrf" }]);
  assert.deepStrictEqual([local[K.triageSnapshot("33")].bvids, local[K.triageSnapshot("11")].bvids], [[B], [A, B]]);
});

check("a background read whose folder was written meanwhile is not saved: its list may be from before the write", async () => {
  syncRoutes();
  let wrote = null;
  const list = routes["/x/v3/fav/resource/list"];
  routes["/x/v3/fav/resource/list"] = (q) => {
    wrote ||= M.favWrite({ op: "unfav", from: "33", bvids: [B] }, far()); // a write starts while folder 11 is being read
    return list(q);
  };
  await M.sync({ start: true, folders: ["11"] });
  const done = await idle();
  await wrote;
  assert.deepStrictEqual([plain(done.job.partial), local[K.triageSnapshot("11")].bvids], [["11"], [A, B]]);
});

check("what the target already held is asked of B站, not of a copy that may be behind: undo leaves it there", async () => {
  favReset();
  local[K.triageSnapshot("33")] = { bvids: [], invalid: [], titles: {}, items: [], ids: [], title: "已有" }; // the copy does not know B is there
  const r = await M.favWrite({ op: "copy", from: "11", to: "33", bvids: [B] }, far());
  await M.undo({ id: r.data.undoId }, far());
  assert.deepStrictEqual([plain(log()), paths()], [[], ["resource/copy"]], "nothing is taken out of 33");
});

check("a 番剧 the target already holds is recognised by its episode id, so undo leaves it there", async () => {
  favReset();
  const X = "BV1xxxxxxxxx";
  local[K.triageSnapshot("11")].items.push(vid(X, 5, { ogv: true, ep: "7:24" }));
  delete local[K.triageSnapshot("33")];
  routes["/x/v3/fav/resource/ids"] = () => ({ code: 0, data: [{ type: 24, id: 7 }] }); // B站 lists it by episode id, no BV id
  const r = await M.favWrite({ op: "copy", from: "11", to: "33", bvids: [X] }, far());
  assert.deepStrictEqual(plain(log()[0].had), [X]);
  await M.undo({ id: r.data.undoId }, far());
  assert.deepStrictEqual(paths(), ["resource/copy"], "nothing is taken out of 33");
});

check("a move out of 稍后再看 is undone one video at a time: back into it, then out of the target", async () => {
  favReset();
  local[K.triageIncludedFolders] = ["11", "toview"];
  local[K.triageSnapshot("toview")] = { bvids: [C], invalid: [], titles: {}, items: [vid(C, 3)], ids: [C] };
  const r = await M.favWrite({ op: "move", from: "toview", to: "11", bvids: [C] }, far());
  assert.deepStrictEqual([r.ok, local[K.triageSnapshot("toview")].bvids, local[K.triageSnapshot("11")].bvids], [true, [], [C, A, B]]);
  posts.length = 0;
  const u = await M.undo({ id: r.data.undoId }, far());
  assert.deepStrictEqual([u.ok, u.data.n, plain(posts)], [true, 1, [["/x/v2/history/toview/add", { aid: "3", csrf: "csrf" }], ["/x/v3/fav/resource/batch-del", { media_id: "11", resources: "3:2", platform: "web", csrf: "csrf" }]]]);
  assert.deepStrictEqual([local[K.triageSnapshot("toview")].bvids, local[K.triageSnapshot("11")].bvids, log()], [[C], [A, B], []]);
  assert.strictEqual(local[K.triageSnapshot("toview")].items[0].title, "标题3", "the copy gets the whole item back, not a stub");
});

check("an undo goes on past a video B站 says no to, which stays journaled; a request that only failed loses nothing; one in progress is refused, and a dead one can be undone again", async () => {
  favReset();
  const r = await M.favWrite({ op: "unfav", from: "11", bvids: [A, B] }, far());
  routes["/x/v3/fav/resource/deal"] = (_, b) => (b.rid === "1" ? { code: 11010, message: "稿件不存在" } : null);
  const u = await M.undo({ id: r.data.undoId }, far());
  assert.deepStrictEqual([u.ok, u.data.n, u.data.failed, u.data.left, u.data.stopped, log().map((e) => e.items.map((it) => it.bvid)), Object.keys(local[K.triageDecisions("11")])], [true, 1, 1, 1, "REFUSED", [[A]], [A]]);
  // B站 down (HTTP 500) is no refusal: the undo fails and the entry keeps both videos.
  favReset();
  const d = await M.favWrite({ op: "unfav", from: "11", bvids: [A, B] }, far());
  routes["/x/v3/fav/resource/deal"] = () => ({ status: 500 });
  const down = await M.undo({ id: d.data.undoId }, far());
  assert.deepStrictEqual([down.ok, log().map((e) => e.items.length), Object.keys(local[K.triageDecisions("11")]).length], [false, [2], 2]);
  routes["/x/v3/fav/resource/deal"] = () => null;
  assert.deepStrictEqual([(await M.undo({ id: d.data.undoId }, far())).data.n, log().length], [2, 0], "and goes through once B站 answers again");
  favReset();
  const w = await M.favWrite({ op: "unfav", from: "11", bvids: [A] }, far());
  local[K.triageAgentLog][0].undoing = Date.now(); // another page is undoing it right now
  assert.match((await M.undo({ id: w.data.undoId }, far())).error, /正在撤销/);
  local[K.triageAgentLog][0].undoing = Date.now() - 3 * 60_000; // the background died midway: the mark ran out
  assert.deepStrictEqual([(await M.undo({ id: w.data.undoId }, far())).data.n, log().length], [1, 0]);
});

check("a batch that landed on B站 is journaled even when its local records cannot be written", async () => {
  favReset();
  const set = chrome.storage.local.set;
  chrome.storage.local.set = async (o) => {
    if (Object.keys(o).some((k) => k.startsWith("triage_snapshot_"))) throw new Error("QUOTA");
    return set(o);
  };
  const r = await M.favWrite({ op: "move", from: "11", to: "22", bvids: [A] }, far());
  chrome.storage.local.set = set;
  assert.deepStrictEqual([r.ok, posts.length, log().length, log()[0].items.map((it) => it.bvid)], [false, 1, 1, [A]]);
  assert.match(r.error, /QUOTA.*1 of 1/);
});

check("B站 changes and local ones are counted apart in the journal: a hundred triage calls leave a folder change in it", async () => {
  favReset();
  const f = await M.favWrite({ op: "unfav", from: "11", bvids: [A] }, far());
  for (let i = 0; i < 101; i++) await M.triage({ items: [{ bvid: B, note: `第 ${i} 次` }] });
  assert.deepStrictEqual([log().length, log()[0].id], [101, f.data.undoId]);
});

check("unfav: recorded as the 分拣台's 取消收藏 (elsewhere when another chosen folder holds it); undo re-favorites into the folder", async () => {
  favReset();
  const r = await M.favWrite({ op: "unfav", from: "11", bvids: [A, B] }, far());
  assert.deepStrictEqual(paths(), ["resource/batch-del"]);
  const d = local[K.triageDecisions("11")];
  assert.deepStrictEqual([d[A].action, d[A].aid, d[A].elsewhere, d[B].elsewhere, d[A].batch === d[B].batch], ["unfav", 1, undefined, true, true]);
  const u = await M.undo({ id: r.data.undoId }, far());
  assert.deepStrictEqual([u.data.n, paths().slice(1), plain(posts[1][1])], [2, ["resource/deal", "resource/deal"], { rid: "1", type: "2", add_media_ids: "11", del_media_ids: "", csrf: "csrf" }]);
  assert.deepStrictEqual([local[K.triageDecisions("11")], log()], [{}, []]);
});

check("B站's limit mid-batch stops it: what landed is journaled and reported, the rest is notDone; an error keeps what landed too", async () => {
  favReset();
  const many = Array.from({ length: 25 }, (_, i) => `BV1${String(i).padStart(9, "x")}`);
  local[K.triageSnapshot("11")].items = many.map((b, i) => vid(b, 100 + i));
  let n = 0;
  routes["/x/v3/fav/resource/batch-del"] = () => (++n === 2 ? { status: 412 } : null);
  const r = await M.favWrite({ op: "unfav", from: "11", bvids: many }, far());
  assert.deepStrictEqual([r.ok, r.data.done.length, r.data.notDone.length, r.data.stopped, log()[0].n], [true, 20, 5, "THROTTLED", 20]);
  n = 1;
  routes["/x/v3/fav/resource/batch-del"] = () => (++n === 3 ? { code: 11010, message: "内容不存在" } : null);
  local[K.triageDecisions("11")] = {};
  const bad = await M.favWrite({ op: "unfav", from: "11", bvids: many }, far());
  assert.deepStrictEqual([bad.ok, log().length, log()[1].n], [false, 2, 20]);
  assert.match(bad.error, /内容不存在.*20 of 25/);
});

check("refused whole before any request: a video the cached list does not hold, the same folder, a bad op, too many", async () => {
  favReset();
  for (const [p, words] of [
    [{ op: "move", from: "11", to: "22", bvids: [C] }, /Not in folder 11/],
    [{ op: "move", from: "11", to: "11", bvids: [A] }, /another folder/],
    [{ op: "move", from: "11", to: "toview", bvids: [A] }, /not toview/],
    [{ op: "explode" }, /op must be one of/],
    [{ op: "unfav", from: "11", bvids: [A, A] }, /once/],
    [{ op: "unfav", from: "11", bvids: Array.from({ length: 501 }, () => A) }, /at most 500/]
  ]) {
    const r = await M.favWrite(p, far());
    assert.deepStrictEqual([r.ok, r.code], [false, "BAD_PARAMS"], JSON.stringify(p).slice(0, 60));
    assert.match(r.error, words);
  }
  assert.deepStrictEqual([posts.length, log().length], [0, 0]);
});

check("a folder MoonDigest has no list of: the aid comes from the BV id, no local record is made", async () => {
  favReset();
  const r = await M.favWrite({ op: "unfav", from: "22", bvids: ["BV1xx411c7mD"] }, far());
  assert.deepStrictEqual([r.ok, posts[0][1].resources, local[K.triageDecisions("22")]], [true, "2:2", undefined]);
});

check("clean_invalid takes out the folder's 已失效 videos as the list has them, and undo knows which", async () => {
  favReset();
  local[K.triageSnapshot("11")].items = [vid(A, 1, { invalid: true }), vid(B, 2)];
  const r = await M.favWrite({ op: "clean_invalid", from: "11" }, far());
  assert.deepStrictEqual([plain(r.data.done), posts[0][1].resources, log()[0].items.map((it) => it.bvid)], [[A], "1:2", [A]]);
  assert.deepStrictEqual(plain((await M.favWrite({ op: "clean_invalid", from: "11" }, far())).data.done), [], "already taken out: nothing to do");
  assert.strictEqual((await M.favWrite({ op: "clean_invalid", from: "22" }, far())).code, "BAD_PARAMS", "no list: sync first");
});

check("an undo cut short by the call's time keeps the rest journaled under the same id; undoing again finishes", async () => {
  favReset();
  const r = await M.favWrite({ op: "unfav", from: "11", bvids: [A, B] }, far());
  let calls = 0;
  const slow = Date.now() + 8000 + 400; // run stops with less than 8 s left
  routes["/x/v3/fav/resource/deal"] = () => (calls++, null);
  const D = vm.runInContext("Date", ctx);
  const realNow = D.now;
  D.now = () => realNow() + (calls ? 1000 : 0); // the first re-favorite uses the time up
  const u = await M.undo({ id: r.data.undoId }, slow);
  D.now = realNow;
  assert.deepStrictEqual([u.ok, u.data.n, u.data.left, u.data.stopped, log().map((e) => [e.id, e.n])], [true, 1, 1, "TIMEOUT", [[r.data.undoId, 1]]]);
  const again = await M.undo({ id: r.data.undoId }, far());
  assert.deepStrictEqual([again.data.n, again.data.left, log().length, calls], [1, undefined, 0, 2]);
  assert.match((await M.undo({ id: r.data.undoId }, far())).error, /已经撤销过了/);
  assert.match((await M.undo({}, far())).error, /没有可以撤销的修改/);
});

check("folders: made, renamed, made private, each undone; the folder list MoonDigest keeps follows", async () => {
  favReset();
  const info = { id: 11, title: "Rust", intro: "简介", cover: "c.jpg", attr: 22, media_count: 0 };
  routes["/x/v3/fav/folder/info"] = () => ({ code: 0, data: info });
  routes["/x/v3/fav/folder/add"] = (_, b) => ({ code: 0, data: { id: 77, title: b.title } });
  const made = await M.favWrite({ op: "folder_create", title: "待审", private: true }, far());
  assert.deepStrictEqual([made.data.folder, plain(posts[0]), local[K.triageFolderList].folders.at(-1).title], ["77", ["/x/v3/fav/folder/add", { title: "待审", intro: "", privacy: "1", cover: "", csrf: "csrf" }], "待审"]);
  const named = await M.favWrite({ op: "folder_rename", folder: "11", title: "Rust 入门" }, far());
  assert.deepStrictEqual(plain(posts[1]), ["/x/v3/fav/folder/edit", { media_id: "11", title: "Rust 入门", intro: "简介", privacy: "0", cover: "c.jpg", csrf: "csrf" }]);
  assert.deepStrictEqual([local[K.triageFolderList].folders[0].title, local[K.triageSnapshot("11")].title], ["Rust 入门", "Rust 入门"]);
  await M.favWrite({ op: "folder_privacy", folder: "11", private: true }, far());
  assert.strictEqual(posts[2][1].privacy, "1");
  info.attr = 23; // B站 now says 私密
  await M.undo({}, far());
  assert.strictEqual(posts[3][1].privacy, "0", "back to 公开");
  await M.undo({ id: named.data.undoId }, far());
  assert.deepStrictEqual([posts[4][1].title, local[K.triageFolderList].folders[0].title], ["Rust", "Rust"]);
  await M.undo({ id: made.data.undoId }, far());
  assert.deepStrictEqual([plain(posts[5]), local[K.triageFolderList].folders.length, log().length], [["/x/v3/fav/folder/del", { media_ids: "77", csrf: "csrf" }], 3, 0]);
  info.media_count = 2;
  const full = await M.favWrite({ op: "folder_create", title: "又一个" }, far());
  assert.match((await M.undo({ id: full.data.undoId }, far())).error, /已经有 2 个视频，没有删除/, "a folder that got videos since is not deleted");
});

check("folder_delete says how many videos B站 counts but does not list, and deletes only with acceptLoss; undo makes it again with the listed videos", async () => {
  favReset();
  routes["/x/v3/fav/folder/info"] = () => ({ code: 0, data: { id: 11, title: "Rust", intro: "", cover: "", attr: 23, media_count: 3 } });
  routes["/x/v3/fav/resource/list"] = () => ({ code: 0, data: { info: { title: "Rust", intro: "" }, has_more: false, medias: [{ type: 2, id: 1, bvid: A, title: "一", attr: 0 }, { type: 2, id: 2, bvid: B, title: "二", attr: 0 }] } });
  routes["/x/v3/fav/folder/add"] = () => ({ code: 0, data: { id: 88, title: "Rust" } });
  const asked = await M.favWrite({ op: "folder_delete", folder: "11" }, far());
  assert.deepStrictEqual([asked.code, posts.length], ["HIDDEN_ITEMS", 0]);
  assert.match(asked.error, /counts 3 .* lists 2: 1 cannot be seen/);
  const gone = await M.favWrite({ op: "folder_delete", folder: "11", acceptLoss: true }, far());
  assert.deepStrictEqual([gone.data.hiddenLost, plain(posts[0]), local[K.triageIncludedFolders], local[K.triageFolderList].folders.map((f) => f.id)], [1, ["/x/v3/fav/folder/del", { media_ids: "11", csrf: "csrf" }], ["33"], [22, 33]]);
  const u = await M.undo({ id: gone.data.undoId }, far());
  assert.deepStrictEqual([u.data.n, plain(posts.slice(1).map(([p, b]) => [p.split("/").pop(), b.privacy ?? `${b.rid}>${b.add_media_ids}`]))], [2, [["add", "1"], ["deal", "2>88"], ["deal", "1>88"]]]);
});

check("a coarse verdict is stored as a 粗看 (title only), needs a reason, and U takes it back", async () => {
  assert.strictEqual((await M.triage({ items: [{ bvid: A, verdict: "drop", coarse: true }] })).code, "BAD_PARAMS", "no reason");
  assert.strictEqual((await M.triage({ items: [{ bvid: A, verdict: "drop", coarse: true, reason: "x", summary: "y" }] })).code, "BAD_PARAMS", "summary is a 细看's");
  const r = await M.triage({ items: [{ bvid: A, verdict: "drop", coarse: true, reason: "标题党", confidence: "low" }] });
  const t = local[K.triageTitle(A)];
  assert.deepStrictEqual([r.ok, t.verdict, t.reason, t.confidence, t.model, local[K.triageAnalysis(A)]], [true, "drop", "标题党", "low", "agent", undefined]);
  await undo(r.data.undoId);
  assert.strictEqual(local[K.triageTitle(A)], undefined);
});

check("triageSettings lists each chosen folder's 判断标准 and tags; setting the 判断标准 is journaled and undone unless changed since", async () => {
  local[K.triageFolderCriteria] = { 11: "只留教程" };
  const read = await M.triageSettings({});
  assert.deepStrictEqual(plain(read.data.folders[0]), { id: "11", title: "Rust", criteria: "只留教程", tags: [{ name: "入门", videos: 1 }] });
  const w = await M.triageSettings({ folderId: "11", criteria: "教程和演讲" });
  assert.deepStrictEqual([local[K.triageFolderCriteria]["11"], w.data.changed.was, log()[0].kind], ["教程和演讲", "只留教程", "criteria"]);
  assert.strictEqual((await M.triageSettings({ folderId: "11", criteria: "教程和演讲" })).data.changed, undefined, "the same text changes nothing");
  await M.undo({ id: w.data.changed.undoId });
  assert.strictEqual(local[K.triageFolderCriteria]["11"], "只留教程");
  const w2 = await M.triageSettings({ folderId: "11", criteria: "" });
  assert.deepStrictEqual(local[K.triageFolderCriteria], {}, "empty removes it");
  local[K.triageFolderCriteria] = { 11: "用户自己改的" };
  assert.deepStrictEqual([(await M.undo({ id: w2.data.changed.undoId })).data.skipped, local[K.triageFolderCriteria]["11"]], [1, "用户自己改的"]);
});

// ---------- sync: which folders are kept, and their copies read in the background ----------
const syncRoutes = () => {
  favReset();
  sync.triageIntervalSec = 1; // the gap between two folders, instant under this file's timers
  local[K.triageSnapshot("11")].ids = [A, B];
  const medias = { 11: [A, B, C], 22: [C] };
  Object.assign(routes, {
    "/x/v3/fav/folder/created/list": () => ({ code: 0, data: { has_more: false, list: [{ id: 11, title: "Rust", media_count: 3, attr: 22 }, { id: 22, title: "杂", media_count: 1, attr: 23 }, { id: 33, title: "已有", media_count: 1, attr: 22 }] } }),
    "/x/v2/history/toview/web": () => ({ code: 0, data: { count: 0, list: [] } }),
    "/x/v3/fav/resource/ids": (q) => ({ code: 0, data: (medias[q.get("media_id")] || [B]).map((b) => ({ type: 2, bvid: b })) }),
    "/x/v3/fav/resource/list": (q) => ({ code: 0, data: { info: { title: "新名", intro: "简介" }, has_more: false, medias: (medias[q.get("media_id")] || []).map((b, i) => ({ type: 2, id: i + 1, bvid: b, title: `T${i}`, attr: 0 })) } })
  });
};
const idle = async () => {
  for (let i = 0; i < 400; i++) {
    const r = await M.sync({});
    if (!r.data.job?.running) return r.data;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.fail("the read never ended");
};

check("sync lists the folders with 私密, ticked and how many videos its copy holds; include and exclude tick and untick, saying what unticking costs", async () => {
  syncRoutes();
  const r = await M.sync({});
  assert.deepStrictEqual(plain(r.data.folders), [{ id: "toview", title: "稍后再看", count: 0 }, { id: "11", title: "Rust", count: 3, included: true, synced: 2 }, { id: "22", title: "杂", count: 1, private: true }, { id: "33", title: "已有", count: 1, included: true, synced: 1 }]);
  const t = await M.sync({ include: ["22"], exclude: ["33"] });
  assert.deepStrictEqual(plain([local[K.triageIncludedFolders], t.data.folders.map((f) => Boolean(f.included))]), [["11", "22"], [false, true, true, false]]);
  assert.match(t.data.notes[0], /Unticked: 33.*取消收藏 records.*已出分拣范围.*verdicts, notes and tags stay/);
  for (const p of [{ include: ["99"] }, { include: ["11"], exclude: ["11"] }, { include: "11" }]) assert.strictEqual((await M.sync(p)).code, "BAD_PARAMS");
});

check("start reads in the background: a changed folder is read and saved as the 分拣台 saves it, an unchanged one costs one request, a new one gets its copy", async () => {
  syncRoutes();
  local[K.triageIncludedFolders] = ["11", "22", "33"];
  const started = await M.sync({ start: true });
  assert.strictEqual(started.data.job.total, 3);
  const done = await idle();
  assert.deepStrictEqual([done.job.read, done.job.unchanged, done.job.done, plain(done.job.partial)], [2, 1, 3, []]);
  assert.deepStrictEqual([local[K.triageSnapshot("11")].bvids, local[K.triageSnapshot("11")].title, local[K.triageSnapshot("22")].bvids, local[K.triageSnapshot("33")].bvids], [[A, B, C], "新名", [C], [B]]);
  assert.deepStrictEqual(plain(done.folders.map((f) => f.synced ?? 0)), [0, 3, 1, 1]);
});

check("a changed folder reads only the difference, as the 分拣台 page does: a video held in another chosen folder's copy costs no list read, a new one only the newest page", async () => {
  syncRoutes();
  local[K.triageSnapshot("11")].intro = ""; // a copy from before the intro was kept is read whole, as the page does
  local[K.triageSnapshot("33")] = { ...local[K.triageSnapshot("33")], bvids: [B, C], ids: [B, C], items: [vid(B, 2), vid(C, 3)] };
  const lists = [];
  const list = routes["/x/v3/fav/resource/list"];
  routes["/x/v3/fav/resource/list"] = (q) => (lists.push(q.get("pn")), list(q));
  await M.sync({ start: true, folders: ["11"] });
  const done = await idle();
  assert.deepStrictEqual([done.job.read, lists], [1, []], "C came from 33's copy");
  assert.deepStrictEqual(plain([...local[K.triageSnapshot("11")].bvids].sort()), [A, B, C].sort());
  // A favorite MoonDigest holds nowhere: the newest pages are read until one holds nothing new, not the whole folder.
  const D = "BV1ddddddddd";
  routes["/x/v3/fav/resource/ids"] = (q) => ({ code: 0, data: (q.get("media_id") === "11" ? [D, A, B, C] : [B]).map((b) => ({ type: 2, bvid: b })) });
  routes["/x/v3/fav/resource/list"] = (q) => (lists.push(q.get("pn")), { code: 0, data: { has_more: true, medias: (q.get("pn") === "1" ? [D, A] : [B, C]).map((b, i) => ({ type: 2, id: i + 1, bvid: b, title: b, attr: 0 })) } });
  await M.sync({ start: true, folders: ["11"] });
  await idle();
  assert.deepStrictEqual(lists, ["1", "2"], "page 2 holds no new video: the rest is the copy");
  assert.deepStrictEqual(plain([...local[K.triageSnapshot("11")].bvids].sort()), [A, B, C, D].sort());
});

check("a read B站 cuts short is not saved; B站's limit stops the run and says so; a folder not ticked is not read", async () => {
  syncRoutes();
  routes["/x/v3/fav/resource/list"] = () => ({ code: 0, data: { has_more: true, medias: [] } });
  await M.sync({ start: true, folders: ["11"] });
  const cut = await idle();
  assert.deepStrictEqual([plain(cut.job.partial), local[K.triageSnapshot("11")].bvids], [["11"], [A, B]]);
  routes["/x/v3/fav/resource/ids"] = () => ({ status: 412 });
  await M.sync({ start: true });
  assert.strictEqual((await idle()).job.stopped, "THROTTLED");
  const no = await M.sync({ start: true, folders: ["22"] });
  assert.match(no.data.notes[0], /Not ticked, so not read: 22/);
});

check("a 稍后再看 change (collectionWrite) is journaled with the others and undo reverses it; a dry run is not", async () => {
  favReset();
  const V = A;
  let later = [];
  Object.assign(routes, {
    "/x/v2/history/toview": () => ({ code: 0, data: { list: later.map((bvid) => ({ bvid, aid: 9, state: 0 })) } }),
    "/x/web-interface/view": () => ({ code: 0, data: { aid: 2 } }),
    "/x/v2/history/toview/add": () => (later.push(V), null),
    "/x/v2/history/toview/del": () => ((later = []), null)
  });
  const dry = await M.collectionWrite({ site: "bilibili", op: "add", kind: "watch_later", items: [V], dryRun: true }, far());
  assert.deepStrictEqual([dry.ok, dry.data.undoId, log().length], [true, undefined, 0]);
  const r = await M.collectionWrite({ site: "bilibili", op: "add", kind: "watch_later", items: [V] }, far());
  const [e] = log();
  assert.deepStrictEqual([r.ok, plain(later), e.kind, e.op, e.n, plain(e.items), e.titles.from, r.data.undoId], [true, [V], "collection", "add", 1, [V], "稍后再看", e.id]);
  const u = await M.undo({ id: e.id }, far());
  assert.deepStrictEqual([u.ok, u.data.n, plain(later), log().length], [true, 1, [], 0], "taken out again, and the undo itself is not journaled");
});

check("unticking is journaled with the folder's 取消收藏 records; undo ticks it again and puts back the records the 分拣台 dropped", async () => {
  syncRoutes();
  local[K.triageDecisions("33")] = { [B]: { action: "unfav", at: 1, aid: 2, title: "二" } };
  const t = await M.sync({ exclude: ["33", "22"] }); // 22 was not ticked: nothing to undo for it
  const [e] = log();
  assert.deepStrictEqual([e.kind, plain(e.dropped), e.titles.from, local[K.triageIncludedFolders]], ["scope", ["33"], "已有", ["11"]]);
  assert.match(t.data.notes[0], new RegExp(`Unticked: 33\\..*undo \\{"id":"${e.id}"\\}`));
  delete local[K.triageDecisions("33")]; // the 分拣台 opened meanwhile and dropped them
  delete local[K.triageSnapshot("33")];
  await M.undo({ id: e.id }, far());
  assert.deepStrictEqual([local[K.triageIncludedFolders], Object.keys(local[K.triageDecisions("33")]), log().length], [["11", "33"], [B], 0]);
  assert.strictEqual((await M.sync({ exclude: ["22"] })).data.notes, undefined, "unticking what was not ticked changes and journals nothing");
});

check("log lists the journal newest first, a line's worth per call", async () => {
  favReset();
  await M.favWrite({ op: "unfav", from: "11", bvids: [A] }, far());
  await M.triage({ items: [{ bvid: B, kept: true }] });
  const { entries } = (await M.log({})).data;
  assert.deepStrictEqual(entries.map((e) => [e.kind, e.op, e.n]), [["triage", undefined, 1], ["fav", "unfav", 1]]);
});

(async () => {
  for (const [name, fn] of cases) {
    reset();
    await fn();
    console.log(`ok   ${name}`);
  }
  console.log(`agent-writes selftest: all ${cases.length} passed`);
})().catch((e) => (console.error(e), process.exit(1)));
