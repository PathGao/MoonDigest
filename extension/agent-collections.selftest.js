// /usr/local/bin/node extension/agent-collections.selftest.js
// The collection tools (agent-collections.js) over the real YouTube adapter (agent-sites/youtube.js), with a fake
// YouTube behind the bridge's inSitePage: hand-written youtubei answers in the shapes the adapter parses (fixtures, not
// recorded from YouTube). No request leaves this process.
if (process.versions.bun) (console.error("This selftest needs Node: it fails or hangs under bun (see 自检 in CONTRIBUTING.md)."), process.exit(1));
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

// The worker's load order up to agent-collections.js. Its gaps run at once and are recorded.
const gaps = [];
const fastGap = (fn, ms) => (ms > 0 && ms <= 3000 ? (gaps.push(ms), setImmediate(fn)) : setTimeout(fn, ms));
const ctx = vm.createContext({ TextEncoder, URL, URLSearchParams, console, setTimeout: fastGap, clearTimeout, setInterval, clearInterval, AbortController });
const order = [...fs.readFileSync(path.join(__dirname, "background.js"), "utf8").matchAll(/importScripts\(([^)]*)\)/g)].flatMap((m) => m[1].match(/"[^"]+"/g).map((f) => JSON.parse(f)));
assert.ok(order.indexOf("agent-collections.js") > order.indexOf("agent-sites/youtube.js"), "agent-collections.js loads after the site adapters");
let M = null;
const calls = [];
let yt = null; // the fake YouTube: (endpoint, body) → ytApi's answer
let inFlight = 0;
let maxInFlight = 0;
for (const file of order) {
  if (file === "agent-collections.js") {
    ctx.MdgAgentBridge = {
      addMethods: (m) => (M = m),
      inSitePage: async (site, url, ready, func, args) => {
        assert.strictEqual(site.id, "youtube");
        assert.strictEqual(func.name, "ytApi", "every YouTube call is one ytApi in the page");
        calls.push(args);
        maxInFlight = Math.max(maxInFlight, ++inFlight);
        await new Promise((r) => setImmediate(r));
        inFlight--;
        return { ok: true, data: yt(...args) };
      }
    };
  }
  vm.runInContext(fs.readFileSync(path.join(__dirname, file), "utf8"), ctx);
  if (file === "agent-collections.js") break;
}
assert.deepStrictEqual(Object.keys(M), ["collection", "collectionWrite"]);
const plain = (x) => JSON.parse(JSON.stringify(x));

let sync = {};
ctx.chrome = { storage: { sync: { get: async (k) => (k in sync ? { [k]: sync[k] } : {}) } } };

// ---- fake YouTube state and answers ----
const ID = (n) => `vid${String(n).padStart(8, "0")}`; // 11 characters
let lists; // playlistId → Set of video ids
let throttleAt; // the request number (1-based) answered 429, 0 for none
let ignoreWrites; // edit_playlist answers 200 but changes nothing
const ok = (json) => ({ status: 200, url: "https://www.youtube.com/youtubei/v1/x", json });
const pvr = (id, title) => ({ playlistVideoRenderer: { videoId: id, setVideoId: `s${id}`, title: { runs: [{ text: title }] }, shortBylineText: { runs: [{ text: "Chan" }] }, lengthSeconds: "125", isPlayable: true } });
function fakeYt(endpoint, body) {
  if (throttleAt && calls.length === throttleAt) return { status: 429, url: "https://www.youtube.com/youtubei/v1/x", json: null };
  if (endpoint === "playlist/get_add_to_playlist") {
    const v = body.videoIds[0];
    return ok({ contents: [{ addToPlaylistRenderer: { playlists: Object.entries(lists).map(([pl, set]) => ({ playlistAddToOptionRenderer: { playlistId: pl, title: { simpleText: pl }, containsSelectedVideos: set.has(v) ? "ALL" : "NONE" } })) } }] });
  }
  if (endpoint === "browse/edit_playlist") {
    const [a] = body.actions;
    if (!ignoreWrites) a.action === "ACTION_ADD_VIDEO" ? lists[body.playlistId].add(a.addedVideoId) : lists[body.playlistId].delete(a.removedVideoId);
    return ok({ status: "STATUS_SUCCEEDED" });
  }
  throw new Error(`no fake for ${endpoint}`);
}

const cases = [];
const check = (name, fn) => cases.push([name, fn]);
const reset = () => {
  sync = { mcpPersonalData: true, mcpCollectionWrite: true };
  lists = { WL: new Set([ID(1)]), PLmine: new Set() };
  throttleAt = 0;
  ignoreWrites = false;
  calls.length = 0;
  gaps.length = 0;
  yt = fakeYt;
};
const far = () => Date.now() + 600_000;
const write = (params, deadline = far()) => M.collectionWrite({ site: "youtube", ...params }, deadline);
const sent = (endpoint) => calls.filter(([e]) => e === endpoint);

check("off: list is PERSONAL_DATA_OFF, a write COLLECTION_WRITES_OFF, a dryRun runs on the read switch alone; nothing asked of YouTube", async () => {
  sync = { mcpCollectionWrite: true };
  assert.strictEqual((await M.collection({ site: "youtube", kind: "watch_later" }, far())).code, "PERSONAL_DATA_OFF");
  assert.strictEqual((await write({ op: "add", kind: "watch_later", items: [ID(2)] })).code, "PERSONAL_DATA_OFF", "the write switch alone does not open writes");
  sync = { mcpPersonalData: true };
  const r = await write({ op: "add", kind: "watch_later", items: [ID(2)] });
  assert.deepStrictEqual([r.ok, r.code], [false, "COLLECTION_WRITES_OFF"]);
  assert.match(r.error, /允许 AI 工具改我的收藏/);
  sync = { mcpPersonalData: true, mcpCollectionWrite: "true" }; // not a boolean: stays off
  assert.strictEqual((await write({ op: "add", kind: "watch_later", items: [ID(2)] })).code, "COLLECTION_WRITES_OFF");
  assert.strictEqual(calls.length, 0);
  const dry = await write({ op: "add", kind: "watch_later", items: [ID(2)], dryRun: true });
  assert.strictEqual(dry.ok, true);
  assert.strictEqual(sent("browse/edit_playlist").length, 0);
});

check("refused before any request: unknown site and kind, writes to a read-only kind, bad and too many items", async () => {
  const bad = [
    [{ site: "nope", op: "add", kind: "watch_later", items: [ID(2)] }, ""],
    [{ op: "add", kind: "tags", items: [ID(2)] }, "UNSUPPORTED_KIND"],
    [{ op: "remove", kind: "likes", items: [ID(2)] }, "UNSUPPORTED_KIND"],
    [{ op: "remove", kind: "subscriptions", items: ["UC123"] }, "UNSUPPORTED_KIND"],
    [{ op: "delete", kind: "watch_later", items: [ID(2)] }, "UNSUPPORTED_KIND"],
    [{ op: "add", kind: "__proto__", items: [ID(2)] }, "UNSUPPORTED_KIND"],
    [{ op: "add", kind: "watch_later", items: [] }, ""],
    [{ op: "add", kind: "watch_later", items: Array.from({ length: 21 }, (_, i) => ID(i)) }, ""],
    [{ op: "add", kind: "watch_later", items: [ID(2), ID(2)] }, ""],
    [{ op: "add", kind: "watch_later", items: ["a b"] }, ""],
    [{ op: "add", kind: "watch_later", items: "x" }, ""]
  ];
  for (const [p, code] of bad) {
    const r = await M.collectionWrite({ site: "youtube", ...p }, far());
    assert.strictEqual(r.ok, false, JSON.stringify(p));
    assert.strictEqual(r.code || "", code, JSON.stringify(p));
  }
  assert.strictEqual((await M.collection({ site: "youtube", kind: "tags" }, far())).code, "UNSUPPORTED_KIND");
  assert.strictEqual(calls.length, 0);
  // 20 is the limit, not 19.
  const twenty = await write({ op: "add", kind: "watch_later", items: Array.from({ length: 20 }, (_, i) => ID(i + 100)), dryRun: true });
  assert.strictEqual(twenty.data.results.length, 20);
});

check("dryRun: each item's state and what would change; nothing written", async () => {
  const r = await write({ op: "add", kind: "watch_later", items: [ID(1), ID(2)], dryRun: true });
  assert.deepStrictEqual(plain(r.data), {
    site: "youtube", op: "add", kind: "watch_later", dryRun: true,
    results: [{ item: ID(1), status: "unchanged", before: true }, { item: ID(2), status: "would_change", before: false }],
    done: [], notDone: [], undo: null
  });
  assert.strictEqual(sent("browse/edit_playlist").length, 0);
  assert.deepStrictEqual([...lists.WL], [ID(1)]);
});

check("a write: no-op skipped, the rest written one at a time 1.5–3 s apart, confirmed by a read after, undo given", async () => {
  const r = await write({ op: "add", kind: "watch_later", items: [ID(1), ID(2), ID(3)] });
  assert.deepStrictEqual(plain(r.data.results), [
    { item: ID(1), status: "unchanged", before: true },
    { item: ID(2), status: "done", before: false, after: true },
    { item: ID(3), status: "done", before: false, after: true }
  ]);
  assert.deepStrictEqual(plain(r.data.done), [ID(2), ID(3)]);
  assert.deepStrictEqual(plain(r.data.undo), { site: "youtube", op: "remove", kind: "watch_later", items: [ID(2), ID(3)] });
  assert.deepStrictEqual(sent("browse/edit_playlist").map(([, b]) => plain(b)), [ID(2), ID(3)].map((v) => ({ playlistId: "WL", actions: [{ action: "ACTION_ADD_VIDEO", addedVideoId: v }] })), "ID(1) was already there: not sent");
  assert.deepStrictEqual(calls.map(([e]) => e), ["playlist/get_add_to_playlist", "playlist/get_add_to_playlist", "browse/edit_playlist", "playlist/get_add_to_playlist", "playlist/get_add_to_playlist", "browse/edit_playlist", "playlist/get_add_to_playlist"]);
  // A call gap is what is left of CALL_GAP_MS (at most 1000, less under load); an item gap is at least 1500.
  const itemGaps = gaps.filter((g) => g > 1000);
  assert.strictEqual(itemGaps.length, 2, "a gap before each item after the first");
  assert.ok(itemGaps.every((g) => g >= 1500 && g <= 3000), itemGaps.join());
  // The undo runs as given and puts things back.
  calls.length = 0;
  const u = await M.collectionWrite(plain(r.data.undo), far());
  assert.deepStrictEqual(plain(u.data.done), [ID(2), ID(3)]);
  assert.deepStrictEqual([...lists.WL], [ID(1)]);
  assert.deepStrictEqual(plain(u.data.undo.items), [ID(2), ID(3)]);
  assert.strictEqual(u.data.undo.op, "add");
});

check("a playlist by id: remove; a playlist that is not the user's fails the item", async () => {
  lists.PLmine.add(ID(5));
  const r = await write({ op: "remove", kind: "playlist", id: "VLPLmine", items: [ID(5)] });
  assert.deepStrictEqual(plain(r.data.results), [{ item: ID(5), status: "done", before: true, after: false }]);
  assert.deepStrictEqual(plain(sent("browse/edit_playlist")[0][1]), { playlistId: "PLmine", actions: [{ action: "ACTION_REMOVE_VIDEO_BY_VIDEO_ID", removedVideoId: ID(5) }] });
  const other = await write({ op: "add", kind: "playlist", id: "PLsomeoneelse", items: [ID(5)] });
  assert.strictEqual(other.data.results[0].status, "failed");
  assert.match(other.data.results[0].error, /not one of the user's own playlists/);
  assert.strictEqual(other.data.undo, null);
  assert.strictEqual((await write({ op: "add", kind: "playlist", items: [ID(5)] })).data.results[0].status, "failed", "playlist needs an id");
});

check("a write the read after does not see is unconfirmed, and undo still takes it", async () => {
  ignoreWrites = true;
  const r = await write({ op: "add", kind: "watch_later", items: [ID(2)] });
  assert.deepStrictEqual(plain(r.data.results), [{ item: ID(2), status: "unconfirmed", before: false, after: false }]);
  assert.deepStrictEqual(plain(r.data.done), []);
  assert.deepStrictEqual(plain(r.data.undo.items), [ID(2)]);
});

check("a write that fails after it went out (HTTP 500, a timeout) is failed, and undo still takes it", async () => {
  yt = (e, b) => {
    const r = fakeYt(e, b);
    return e === "browse/edit_playlist" ? { status: 500, url: "", json: null } : r; // applied, then the answer failed
  };
  const r = await write({ op: "add", kind: "watch_later", items: [ID(2)] });
  assert.deepStrictEqual(plain(r.data.results.map((x) => x.status)), ["failed"]);
  assert.deepStrictEqual(plain(r.data.undo), { site: "youtube", op: "remove", kind: "watch_later", items: [ID(2)] });
  assert.ok(lists.WL.has(ID(2)), "it had landed");
});

check("429 mid-batch stops it: THROTTLED, done and not-done lists, no request after", async () => {
  throttleAt = 4; // ID(2) takes 3 requests (read, write, read); the 4th is ID(3)'s read before
  const r = await write({ op: "add", kind: "watch_later", items: [ID(2), ID(3), ID(4)] });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.data.stopped, "THROTTLED");
  assert.deepStrictEqual(plain(r.data.done), [ID(2)]);
  assert.deepStrictEqual(plain(r.data.notDone), [ID(4)]);
  assert.deepStrictEqual(plain(r.data.results.map((x) => x.status)), ["done", "failed"]);
  assert.strictEqual(calls.length, 4, "nothing asked after the 429");
  assert.deepStrictEqual(plain(r.data.undo.items), [ID(2)]);
});

check("a captcha page, 403 and a lost login stop the batch too; a plain HTTP error fails only its item", async () => {
  for (const [answer, code] of [
    [{ status: 200, url: "https://www.google.com/sorry/index?continue=x", json: null }, "THROTTLED"],
    [{ status: 403, url: "", json: null }, "THROTTLED"],
    [{ status: 401, loggedOut: true }, "NOT_LOGGED_IN"]
  ]) {
    reset();
    yt = () => answer;
    const r = await write({ op: "add", kind: "watch_later", items: [ID(2), ID(3)] });
    assert.deepStrictEqual([r.data.stopped, plain(r.data.notDone), calls.length], [code, [ID(3)], 1], code);
  }
  reset();
  yt = (e, b) => (b.videoIds?.[0] === ID(2) ? { status: 500, url: "", json: null } : fakeYt(e, b));
  const r = await write({ op: "add", kind: "watch_later", items: [ID(2), ID(3)] });
  assert.deepStrictEqual(plain(r.data.results.map((x) => x.status)), ["failed", "done"]);
  assert.strictEqual(r.data.stopped, undefined);
});

check("time runs out: the items not started are returned, none half done", async () => {
  const r = await write({ op: "add", kind: "watch_later", items: [ID(2), ID(3)] }, Date.now() + 5_000);
  assert.deepStrictEqual([r.data.stopped, plain(r.data.notDone), calls.length], ["TIMEOUT", [ID(2), ID(3)], 0]);
});

check("lists: the browseId per kind, a playlist by id, the cursor to the next page; THROTTLED as an error", async () => {
  const pages = [];
  yt = (e, b) => {
    pages.push(plain(b));
    if (b.browseId === "FEhistory") return ok({ sections: [
      { videoRenderer: { videoId: ID(7), title: { runs: [{ text: "Seen" }] }, ownerText: { runs: [{ text: "Up" }] }, lengthText: { simpleText: "1:02:03" } } },
      { lockupViewModel: { contentId: ID(8), contentType: "LOCKUP_CONTENT_TYPE_VIDEO", metadata: { lockupMetadataViewModel: { title: { content: "New look" },
        metadata: { contentMetadataViewModel: { metadataRows: [{ metadataParts: [{ text: { content: "Chan B" } }] }, { metadataParts: [{ text: { content: "3 views" } }] }] } } } } } },
      { lockupViewModel: { contentId: "PLx", contentType: "LOCKUP_CONTENT_TYPE_PLAYLIST" } }
    ] });
    if (b.browseId === "FEchannels") return ok({ contents: { x: [{ channelRenderer: { channelId: "UCa", title: { simpleText: "Chan A" } } }] } });
    if (b.browseId === "FEplaylist_aggregation") return ok({ items: [
      { lockupViewModel: { contentId: "PLmine", contentType: "LOCKUP_CONTENT_TYPE_PLAYLIST", metadata: { lockupMetadataViewModel: { title: { content: "Mine" } } } } },
      { gridPlaylistRenderer: { playlistId: "PLold", title: { runs: [{ text: "Old" }] }, videoCountShortText: { simpleText: "1,204" } } }
    ] });
    if (b.continuation) return ok({ onResponseReceivedActions: [{ appendContinuationItemsAction: { continuationItems: [pvr(ID(9), "Last")] } }] });
    return ok({ contents: { tabs: [{ list: [pvr(ID(1), "First"), { continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: "TOK" } } } }] }] } });
  };
  const wl = await M.collection({ site: "youtube", kind: "watch_later" }, far());
  assert.deepStrictEqual(plain(wl.data), { site: "youtube", kind: "watch_later", cursor: "TOK", items: [{ videoId: ID(1), url: `https://www.youtube.com/watch?v=${ID(1)}`, title: "First", author: "Chan", duration: 125 }] });
  const next = await M.collection({ site: "youtube", kind: "watch_later", cursor: "TOK" }, far());
  assert.deepStrictEqual([next.data.items[0].videoId, next.data.cursor], [ID(9), ""]);
  await M.collection({ site: "youtube", kind: "likes" }, far());
  await M.collection({ site: "youtube", kind: "playlist", id: "PLmine" }, far());
  const hist = await M.collection({ site: "youtube", kind: "history" }, far());
  assert.deepStrictEqual(plain(hist.data.items), [
    { videoId: ID(7), url: `https://www.youtube.com/watch?v=${ID(7)}`, title: "Seen", author: "Up", duration: 3723 },
    { videoId: ID(8), url: `https://www.youtube.com/watch?v=${ID(8)}`, title: "New look", author: "Chan B", duration: 0 }
  ], "videoRenderer and the newer lockupViewModel; a playlist lockup is not a video");
  const pl = await M.collection({ site: "youtube", kind: "playlists" }, far());
  assert.deepStrictEqual(plain(pl.data.items), [{ id: "PLmine", title: "Mine" }, { id: "PLold", title: "Old", count: 1204 }]);
  const subs = await M.collection({ site: "youtube", kind: "subscriptions" }, far());
  assert.deepStrictEqual(plain(subs.data.items), [{ channelId: "UCa", url: "https://www.youtube.com/channel/UCa", title: "Chan A" }]);
  assert.deepStrictEqual(pages.map((b) => b.browseId || `cont:${b.continuation}`), ["VLWL", "cont:TOK", "VLLL", "VLPLmine", "FEhistory", "FEplaylist_aggregation", "FEchannels"]);
  assert.strictEqual((await M.collection({ site: "youtube", kind: "playlist", id: "../x" }, far())).ok, false, "a bad playlist id is refused");
  yt = () => ({ status: 429, url: "", json: null });
  const t = await M.collection({ site: "youtube", kind: "watch_later" }, far());
  assert.deepStrictEqual([t.ok, t.code], [false, "THROTTLED"]);
});

check("calls run one at a time, a second apart", async () => {
  maxInFlight = 0;
  yt = (e, b) => (e === "browse" ? ok({}) : fakeYt(e, b));
  const both = await Promise.all([write({ op: "add", kind: "watch_later", items: [ID(2), ID(3)], dryRun: true }), M.collection({ site: "youtube", kind: "subscriptions" }, far())]);
  assert.deepStrictEqual([both[0].ok, both[1].ok], [true, true]);
  assert.strictEqual(maxInFlight, 1);
  assert.ok(gaps.includes(1000), "the second call waited for the gap");
});

(async () => {
  let n = 0;
  for (const [name, fn] of cases) {
    reset();
    try {
      await fn();
      console.log(`ok   ${name}`);
      n++;
    } catch (e) {
      console.error(`FAIL ${name}`);
      console.error(e);
      process.exit(1);
    }
  }
  console.log(`agent-collections selftest: all ${n} passed`);
})();
