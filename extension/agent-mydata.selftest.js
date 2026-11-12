// /usr/local/bin/node extension/agent-mydata.selftest.js
if (process.versions.bun) (console.error("This selftest needs Node: it fails or hangs under bun (see 自检 in CONTRIBUTING.md)."), process.exit(1));
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

// The worker's load order, with the bridge's addMethods caught so the methods can be called directly.
// agent-mydata.js's 1 s gap between calls runs at once and is recorded; other timers stay real.
const gaps = [];
const fastGap = (fn, ms) => (ms > 0 && ms <= 1000 ? (gaps.push(ms), setImmediate(fn)) : setTimeout(fn, ms));
const ctx = vm.createContext({ TextEncoder, URL, URLSearchParams, console, setTimeout: fastGap, clearTimeout, setInterval, clearInterval, AbortController });
const order = [...fs.readFileSync(path.join(__dirname, "background.js"), "utf8").matchAll(/importScripts\(([^)]*)\)/g)].flatMap((m) => m[1].match(/"[^"]+"/g).map((f) => JSON.parse(f)));
assert.ok(order.indexOf("agent-mydata.js") > order.indexOf("triage/follow-core.js") && order.indexOf("agent-mydata.js") > order.indexOf("triage/follow-bg.js"), "agent-mydata.js loads after the triage helpers it uses");
let M = null;
for (const file of order) {
  if (file === "agent-mydata.js") ctx.MdgAgentBridge = { addMethods: (m) => (M ??= m) };
  if (file === "agent-writes.js") ctx.MdgAgentBridge = { addMethods() {} }; // agent-writes.selftest.js's
  vm.runInContext(fs.readFileSync(path.join(__dirname, file), "utf8"), ctx);
}
assert.deepStrictEqual(Object.keys(M), ["favorites", "follows", "history"]);
const plain = (x) => JSON.parse(JSON.stringify(x));
const K = ctx.MdgLimits.KEYS;

// ---- fake chrome storage ----
let local = {};
let sync = {};
const pick = (store, keys) => {
  if (keys == null) return { ...store };
  if (typeof keys === "string") keys = [keys];
  if (Array.isArray(keys)) return Object.fromEntries(keys.filter((k) => k in store).map((k) => [k, plain(store[k])]));
  return Object.fromEntries(Object.entries(keys).map(([k, d]) => [k, k in store ? plain(store[k]) : d]));
};
const writes = [];
ctx.chrome = {
  storage: {
    local: { get: async (k) => pick(local, k), set: async (o) => void writes.push(o), remove: async (k) => void writes.push(k) },
    sync: { get: async (k) => pick(sync, k), set: async (o) => void writes.push(o) }
  },
  cookies: { get: async () => ({ value: "csrf" }) }
};

// ---- fake B站: every request is recorded; only GETs to these paths are answered ----
const json = (body, status = 200) => ({ ok: status === 200, status, json: async () => body });
const fetched = [];
let inFlight = 0;
let maxInFlight = 0;
let routes = {};
ctx.fetch = async (url, init = {}) => {
  fetched.push({ url, method: init.method || "GET", body: init.body });
  inFlight++;
  maxInFlight = Math.max(maxInFlight, inFlight);
  await new Promise((r) => setTimeout(r, 2));
  inFlight--;
  const u = new URL(url);
  const r = routes[u.pathname];
  if (!r) throw new Error(`no route ${u.pathname}`);
  return r(u);
};
const READS = new Set([
  "/x/web-interface/nav", "/x/v3/fav/folder/created/list", "/x/v2/history/toview/web", "/x/v2/history/toview",
  "/x/v3/fav/resource/list", "/x/relation/tag", "/x/relation/followings", "/x/relation/tags", "/x/web-interface/history/cursor"
]);
const ok = (data) => () => json({ code: 0, data });
const baseRoutes = () => ({
  "/x/web-interface/nav": ok({ isLogin: true, mid: 1000 }),
  "/x/v3/fav/folder/created/list": ok({ list: [{ id: 11, title: "Rust", media_count: 2, cover: "http://c" }, { id: 22, title: "杂", media_count: 50, cover: "" }], has_more: false }),
  "/x/v2/history/toview/web": ok({ count: 1, list: [{ pic: "http://p" }] }),
  "/x/v2/history/toview": ok({ list: [{ bvid: "BV1toview001", aid: 5, title: "稍后 Rust", pic: "", owner: { name: "UPt", mid: 9 }, duration: 600, add_at: 1700000000, desc: "", state: 0, progress: 120 }] }),
  "/x/v3/fav/resource/list": (u) => ok({ info: { media_count: 50 }, has_more: u.searchParams.get("pn") === "1", medias: [
    { type: 2, id: 77, bvid: "BV1remote001", title: "远程视频", upper: { name: "UPr", mid: 8 }, duration: 61, fav_time: 1700000100, attr: 0, intro: "" },
    { type: 12, id: 1, title: "音频不列" }
  ] })(),
  // A group's members: 2 is in 特别关注 and in none of their own groups, so in 默认分组 too (listed twice, counted once).
  "/x/relation/tag": (u) => ok({ "-10": [{ mid: 2, uname: "乙", sign: "", tag: null, special: 1 }], 0: [{ mid: 2, uname: "乙", sign: "", tag: null, special: 1 }], 5: [{ mid: 1, uname: "甲", sign: "写 Rust", tag: [5], special: 0 }] }[u.searchParams.get("tagid")] || [])(),
  "/x/relation/followings": ok({ total: 2, list: [
    { mid: 1, uname: "甲", sign: "写 Rust", tag: [5], special: 0 },
    { mid: 2, uname: "乙", sign: "", tag: null, special: 1 }
  ] }),
  "/x/relation/tags": ok([{ tagid: 0, name: "默认分组", count: 1 }, { tagid: 5, name: "编程", count: 1 }, { tagid: -10, name: "特别关注", count: 1 }, { tagid: 6, name: "空", count: 0 }]),
  "/x/web-interface/history/cursor": ok({ cursor: { max: 999, view_at: 1700000500, business: "archive" }, list: [
    { title: "看过的", author_name: "UPh", view_at: 1700000600, progress: -1, duration: 300, history: { business: "archive", bvid: "BV1hist00001" } },
    { title: "直播", author_name: "主播", view_at: 1700000550, progress: 0, duration: 0, uri: "https://live.bilibili.com/1", history: { business: "live" } }
  ] })
});

const cases = [];
const check = (name, fn) => cases.push([name, fn]);
const reset = () => {
  local = {};
  sync = {};
  routes = baseRoutes();
  fetched.length = 0;
  writes.length = 0;
};

check("folder list: 稍后再看 first, ids as strings", async () => {
  const r = await M.favorites({});
  assert.deepStrictEqual(plain(r), { ok: true, data: { folders: [{ id: "toview", title: "稍后再看", count: 1 }, { id: "11", title: "Rust", count: 2 }, { id: "22", title: "杂", count: 50 }] } });
});

check("all: every chosen folder's copy as one list, a video once with its folders; filters by verdict, stage, tag, invalid; no B站 request", async () => {
  const it = (bvid, title, more = {}) => ({ bvid, title, upper: "UP", duration: 60, favTime: 1700000000, invalid: false, ...more });
  local[K.triageIncludedFolders] = [11, 22, 33];
  local[K.triageSnapshot("11")] = { items: [it("BV1aaaaaaaaa", "所有权"), it("BV1bbbbbbbbb", "别的", { invalid: true }), it("BV1ccccccccc", "已取消")] };
  local[K.triageSnapshot("22")] = { items: [it("BV1aaaaaaaaa", "所有权"), it("BV1ddddddddd", "没看过")] };
  local[K.triageDecisions("11")] = { BV1ccccccccc: { action: "unfav", at: 1800000000000 } };
  local[K.triageTags] = [{ id: "t1", name: "Rust", folder: "11" }];
  local[K.triageVideoTags] = { BV1aaaaaaaaa: ["t1"] };
  local[K.triageAnalysis("BV1aaaaaaaaa")] = { status: "done", verdict: "keep", oneLiner: "讲透所有权" };
  local[K.triageZones] = { BV1aaaaaaaaa: 201, BV1ddddddddd: 0 }; // 201: 科学科普, under 知识; 0: B站 gave none
  const all = (p) => M.favorites({ all: true, ...p }).then((r) => r.data);
  const ids = (d) => d.items.map((x) => x.bvid.slice(3, 4)).join("");
  const d = await all({});
  assert.deepStrictEqual([d.source, d.total, plain(d.unsynced), ids(d)], ["local", 3, ["33"], "abd"], "the 取消收藏 one is left out; folder 33 has no copy yet");
  assert.deepStrictEqual([d.items[0].zone, "zone" in d.items[2]], [ctx.TriageCore.zoneName(201), false]);
  assert.ok(d.items[0].zone);
  assert.deepStrictEqual([plain(d.items[0].folders), d.items[0].stage, d.items[1].stage, d.items[1].verdict, d.items[2].stage], [["11", "22"], "fine", "none", "drop", "none"]);
  assert.deepStrictEqual([ids(await all({ verdict: "none" })), ids(await all({ stage: "fine" })), ids(await all({ tag: "Rust" })), ids(await all({ invalid: true })), ids(await all({ invalid: false })), ids(await all({ folderId: "22" })), ids(await all({ query: "没看" }))], ["d", "a", "a", "b", "ad", "ad", "d"]);
  assert.strictEqual((await M.favorites({ all: true, verdict: "maybe" })).code, "BAD_PARAMS");
  assert.strictEqual(fetched.length, 0);
  assert.strictEqual((await M.favorites({ folderId: "11" })).data.total, 2, "one folder's copy leaves the 取消收藏 one out too");
});

check("a ticked folder reads the 分拣台's copy, with tags, note, verdict, summary and 保留; query searches them", async () => {
  local[K.triageIncludedFolders] = [11];
  local[K.triageSnapshot("11")] = { intro: "", items: [
    { bvid: "BV1aaaaaaaaa", title: "所有权", upper: "UPa", duration: 125, favTime: 1700000000, invalid: false },
    { bvid: "BV1bbbbbbbbb", title: "别的", upper: "UPb", duration: 30, favTime: 1700000001, invalid: true }
  ] };
  local[K.triageTags] = [{ id: "t1", name: "Rust", folder: "11" }];
  local[K.triageVideoTags] = { BV1aaaaaaaaa: ["t1"] };
  local[K.triageNotes] = { BV1bbbbbbbbb: { text: "讲 rust 宏", updatedAt: 1 } };
  local[K.triageAnalysis("BV1aaaaaaaaa")] = { status: "done", verdict: "keep", oneLiner: "讲透所有权", reason: "好" };
  local[K.triageTitle("BV1bbbbbbbbb")] = { verdict: "unsure", reason: "看不出" };
  local[K.triageKept] = { BV1aaaaaaaaa: { action: "keep", at: 1 } };
  const r = await M.favorites({ folderId: "11" });
  assert.strictEqual(fetched.length, 0, "no B站 request for a folder the 分拣台 keeps");
  assert.deepStrictEqual(plain(r.data), { folderId: "11", source: "local", total: 2, page: 1, hasMore: false, items: [
    { bvid: "BV1aaaaaaaaa", url: "https://www.bilibili.com/video/BV1aaaaaaaaa", title: "所有权", author: "UPa", duration: 125, favTime: 1700000000, tags: ["Rust"], verdict: "keep", summary: "讲透所有权", kept: true },
    // An invalid video is 可清理 whatever the 粗看 said (MdgTagCore.verdictOf).
    { bvid: "BV1bbbbbbbbb", url: "https://www.bilibili.com/video/BV1bbbbbbbbb", title: "别的", author: "UPb", duration: 30, favTime: 1700000001, invalid: true, note: "讲 rust 宏", verdict: "drop" }
  ] });
  const q = await M.favorites({ folderId: "11", query: "RUST" });
  assert.deepStrictEqual(plain(q.data.items.map((it) => it.bvid)), ["BV1aaaaaaaaa", "BV1bbbbbbbbb"], "a tag and a note match");
  assert.deepStrictEqual(plain((await M.favorites({ folderId: "11", query: "rust 宏" })).data.items.map((it) => it.bvid)), ["BV1bbbbbbbbb"], "every word");
  assert.deepStrictEqual(plain((await M.favorites({ folderId: "11", page: 2 })).data.items), []);
});

check("another folder: one B站 page, B站 searches by keyword (total left out: B站 gives the folder's); only videos", async () => {
  // An unticked folder's old copy (until the 分拣台 next opens) is not used.
  local[K.triageSnapshot("22")] = { intro: "", items: [{ bvid: "BV1stale0001", title: "旧", upper: "x", duration: 1, favTime: 1 }] };
  local[K.triageTags] = [{ id: "t9", name: "收藏", folder: "22" }];
  local[K.triageVideoTags] = { BV1remote001: ["t9"] };
  const r = await M.favorites({ folderId: 22, page: 1, query: "远程" });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(plain(r.data), { folderId: "22", source: "bilibili", page: 1, hasMore: true, items: [
    { bvid: "BV1remote001", url: "https://www.bilibili.com/video/BV1remote001", title: "远程视频", author: "UPr", duration: 61, favTime: 1700000100, tags: ["收藏"] }
  ] });
  assert.strictEqual(fetched.length, 1);
  const u = new URL(fetched[0].url);
  assert.deepStrictEqual([u.searchParams.get("media_id"), u.searchParams.get("pn"), u.searchParams.get("ps"), u.searchParams.get("keyword")], ["22", "1", "40", "远程"]);
});

check("稍后再看: the whole list in one request, searched locally, progress kept", async () => {
  const r = await M.favorites({ folderId: "toview", query: "rust" });
  assert.deepStrictEqual(plain(r.data), { folderId: "toview", source: "bilibili", total: 1, page: 1, hasMore: false, items: [
    { bvid: "BV1toview001", url: "https://www.bilibili.com/video/BV1toview001", title: "稍后 Rust", author: "UPt", duration: 600, favTime: 1700000000, progress: 120 }
  ] });
  assert.strictEqual((await M.favorites({ folderId: "../x" })).ok, false);
});

check("follows: the synced list with groups and UP 标签, query on it", async () => {
  local[K.follow("list")] = { list: ["1", "2"], special: { 2: 1 }, groups: { 1: [5] } };
  local[K.follow("people")] = { 1: { mid: "1", name: "甲", sign: "写 Rust" }, 2: { mid: "2", name: "乙", sign: "" } };
  local[K.follow("groups")] = [{ id: 5, name: "编程", count: 1 }];
  local[K.follow("tags")] = [{ id: "u1", name: "硬核" }];
  local[K.follow("tag_map")] = { 1: ["u1", "gone"] };
  const r = await M.follows({});
  assert.strictEqual(fetched.length, 0);
  assert.deepStrictEqual(plain(r.data), { source: "local", total: 2, page: 1, hasMore: false, items: [
    { mid: "1", name: "甲", sign: "写 Rust", groups: ["编程"], tags: ["硬核"] },
    { mid: "2", name: "乙", sign: "", groups: ["特别关注", "默认分组"] }
  ] });
  assert.deepStrictEqual((await M.follows({ query: "硬核" })).data.items.map((u) => u.mid), ["1"]);
});

check("follows without a synced list: groups short of followings' total fall back to one followings page, not kept", async () => {
  routes["/x/relation/followings"] = ok({ total: 3, list: [{ mid: 1, uname: "甲", sign: "写 Rust", tag: [5], special: 0 }] });
  const r = await M.follows({ query: "x" });
  assert.deepStrictEqual(plain(r.data), { source: "bilibili", queryIgnored: true, total: 3, page: 1, hasMore: false, items: [{ mid: "1", name: "甲", sign: "写 Rust", groups: ["编程"] }] });
  // not kept: the next check (followings whole again) reads the groups again
});

check("follows without a synced list: B站's list read whole by group, as the 分拣台 reads it; query works", async () => {
  const r = await M.follows({});
  // In B站's group order: no follow time comes with a group's members.
  assert.deepStrictEqual(plain(r.data), { source: "bilibili", total: 2, page: 1, hasMore: false, items: [
    { mid: "2", name: "乙", sign: "", groups: ["特别关注", "默认分组"] },
    { mid: "1", name: "甲", sign: "写 Rust", groups: ["编程"] }
  ] });
  assert.deepStrictEqual(fetched.map((f) => { const u = new URL(f.url); return u.pathname + (u.searchParams.has("tagid") ? `#${u.searchParams.get("tagid")}` : ""); }), ["/x/relation/tags", "/x/relation/tag#0", "/x/relation/tag#5", "/x/relation/tag#-10", "/x/web-interface/nav", "/x/relation/followings"], "an empty group is not read; followings' total checks the list is whole");
  assert.strictEqual(new URL(fetched[1].url).searchParams.get("ps"), "500");
  fetched.length = 0;
  assert.deepStrictEqual(plain((await M.follows({ query: "rust" })).data.items.map((u) => u.mid)), ["1"]);
  assert.strictEqual(fetched.length, 0, "a second call within minutes pages the list already read");
});


check("history: one page, cursor round trip", async () => {
  const r = await M.history({});
  assert.deepStrictEqual(plain(r.data), { cursor: "999:1700000500:archive", items: [
    { bvid: "BV1hist00001", url: "https://www.bilibili.com/video/BV1hist00001", title: "看过的", author: "UPh", viewAt: 1700000600, progress: -1, duration: 300, kind: "archive" },
    { url: "https://live.bilibili.com/1", title: "直播", author: "主播", viewAt: 1700000550, progress: 0, duration: 0, kind: "live" }
  ] });
  await M.history({ cursor: r.data.cursor });
  const u = new URL(fetched[1].url);
  assert.deepStrictEqual([u.searchParams.get("max"), u.searchParams.get("view_at"), u.searchParams.get("business"), u.searchParams.get("ps")], ["999", "1700000500", "archive", "30"]);
  assert.strictEqual((await M.history({ cursor: "1&x=2" })).ok, false);
  assert.strictEqual(fetched.length, 2, "a bad cursor asks B站 nothing");
  await M.history({ cursor: "5:1700000400:article-list" });
  assert.strictEqual(new URL(fetched[2].url).searchParams.get("business"), "article-list", "文集's business has a hyphen");
});

check("B站 412 is THROTTLED; not logged in is NOT_LOGGED_IN", async () => {
  routes["/x/web-interface/history/cursor"] = () => json("<html>", 412);
  assert.strictEqual((await M.history({})).code, "THROTTLED");
  routes["/x/web-interface/nav"] = () => json({ code: -101, data: { isLogin: false } });
  assert.strictEqual((await M.favorites({})).code, "NOT_LOGGED_IN");
});

check("calls run one at a time", async () => {
  maxInFlight = 0;
  const all = await Promise.all([M.history({}), M.favorites({ folderId: "22" }), M.follows({}), M.favorites({})]);
  assert.ok(all.every((r) => r.ok));
  assert.strictEqual(maxInFlight, 1);
  assert.ok(gaps.length > 0, "calls wait for the gap");
  assert.strictEqual((await M.history({}, Date.now() - 1)).code, "TIMEOUT", "a call nobody waits for any more asks B站 nothing");
});

(async () => {
  for (const [name, fn] of cases) {
    reset();
    await fn();
    // Read only: GETs to B站's read endpoints, nothing written to storage.
    for (const f of fetched) {
      assert.strictEqual(f.method, "GET", `${name}: ${f.url}`);
      assert.strictEqual(f.body, undefined);
      assert.ok(READS.has(new URL(f.url).pathname), `${name}: ${f.url} is not a read endpoint`);
    }
    assert.deepStrictEqual(writes, [], `${name}: wrote storage`);
    console.log(`ok   ${name}`);
  }
  console.log(`agent-mydata selftest: all ${cases.length} passed`);
})().catch((e) => (console.error(e), process.exit(1)));
