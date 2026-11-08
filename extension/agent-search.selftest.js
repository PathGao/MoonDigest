// node extension/agent-search.selftest.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const waits = [];
const calls = [];
let wbiResets = 0;
const ctx = vm.createContext({
  URL, URLSearchParams, TextEncoder, console,
  // The gap between searches: recorded, not waited.
  setTimeout: (fn, ms) => (waits.push(ms), setImmediate(fn)),
  chrome: { storage: { local: {} } }
});
for (const f of ["common.js", "limits.js", "errors.js", "sites.js", "agent-sites/registry.js", "agent-search.js", "agent-sites/bilibili.js", "agent-sites/youtube.js"]) vm.runInContext(fs.readFileSync(path.join(__dirname, f), "utf8"), ctx);
const A = ctx.MdgAgentSearch;
const eq = (actual, expected) => assert.deepStrictEqual(JSON.parse(JSON.stringify(actual)), expected);

// Bilibili: highlight tags and entities stripped, "12:34" → 754, non-video results dropped.
eq(A.biliItems({
  result: [
    { type: "video", bvid: "BV1xx411c7mD", title: '<em class="keyword">Rust</em> &amp; 所有权 &quot;入门&quot;', author: "UP主", duration: "12:34", play: 12345, pubdate: 1700000000, description: "第一行\n第二行" },
    { type: "video", bvid: "BV1yy411c7mE", title: "长视频", author: "a", duration: "75:10", play: 0, pubdate: 0, description: "x".repeat(300) },
    { type: "ketang", title: "课程" }
  ]
}).map(({ uploadDate, description, ...r }) => ({ ...r, uploadDate: /^\d{4}-\d{2}-\d{2}$/.test(uploadDate) || uploadDate, description: description.length })), [
  { site: "bilibili", videoId: "BV1xx411c7mD", url: "https://www.bilibili.com/video/BV1xx411c7mD", title: 'Rust & 所有权 "入门"', author: "UP主", duration: 754, views: 12345, uploadDate: true, description: 7 },
  { site: "bilibili", videoId: "BV1yy411c7mE", url: "https://www.bilibili.com/video/BV1yy411c7mE", title: "长视频", author: "a", duration: 4510, views: 0, uploadDate: "", description: 201 }
]);
eq(A.biliItems({}), []);
eq(A.biliItems(null), []);

// YouTube: only the result list's own videoRenderer items; shorts, ads, channels and shelves are skipped.
const video = (id, extra = {}) => ({ videoRenderer: { videoId: id, title: { runs: [{ text: `Title ${id}` }] }, ownerText: { runs: [{ text: "Chan" }] }, lengthText: { simpleText: "1:02:03" }, viewCountText: { simpleText: "1,234,567 views" }, publishedTimeText: { simpleText: "2 years ago" }, detailedMetadataSnippets: [{ snippetText: { runs: [{ text: "About " }, { text: "rust" }] } }], ...extra } });
const initial = {
  contents: { twoColumnSearchResultsRenderer: { primaryContents: { sectionListRenderer: { contents: [
    { itemSectionRenderer: { contents: [
      { adSlotRenderer: {} },
      video("aaa"),
      { channelRenderer: { channelId: "UC1" } },
      { reelShelfRenderer: { items: [{ reelItemRenderer: { videoId: "short1" } }] } },
      { shelfRenderer: { content: { verticalListRenderer: { items: [video("shelf1")] } } } },
      { playlistRenderer: { playlistId: "PL1" } },
      video("live", { lengthText: undefined, viewCountText: { runs: [{ text: "No views" }] }, publishedTimeText: undefined, detailedMetadataSnippets: undefined, descriptionSnippet: { runs: [{ text: "live &amp; now" }] } })
    ] } },
    { continuationItemRenderer: {} }
  ] } } } }
};
const html = `<html><script>var ytInitialData = ${JSON.stringify(initial)};</script><script>var x = 1;</script></html>`;
eq(A.ytItems(html), [
  { site: "youtube", videoId: "aaa", url: "https://www.youtube.com/watch?v=aaa", title: "Title aaa", author: "Chan", duration: 3723, views: 1234567, uploadDate: "2 years ago", description: "About rust" },
  { site: "youtube", videoId: "live", url: "https://www.youtube.com/watch?v=live", title: "Title live", author: "Chan", duration: 0, views: null, uploadDate: "", description: "live & now" }
]);
assert.strictEqual(A.ytItems("<html>consent</html>"), null);
eq(A.ytItems(`<script>var ytInitialData = {"contents":{}};</script>`), []);

// search(): validation, one at a time with the gap, THROTTLED kept as the code.
ctx.MdgSites.biliWbiReset = () => wbiResets++;
ctx.MdgSites.biliWbiSigned = async (p) => new URLSearchParams(p).toString();
vm.runInContext("var TRIAGE_BILI_API = 'https://api.bilibili.com', TRIAGE_BILI_IO = {};", ctx);
let biliAnswer = () => ({ result: [{ type: "video", bvid: "BV1", title: "t", author: "a", duration: "1:00", play: 1, pubdate: 0, description: "" }] });
ctx.triageBiliGet = async (url) => (calls.push(await url()), biliAnswer());
let ytStatus = 200;
ctx.fetchWithTimeout = async (url, init) => (calls.push(url), { ok: ytStatus < 300, status: ytStatus, text: async () => html, init });

(async () => {
  const far = Date.now() + 60_000;
  eq(await A.search({ site: "vimeo", query: "x" }, far), { ok: false, error: 'site must be one of "bilibili", "youtube".' });
  // A site without search is not offered; one with search is dispatched to, through the same queue.
  ctx.MdgAgentSites.register({ id: "nosearch", origins: ["https://n.test/*"], key: () => null, read: "content" });
  ctx.MdgAgentSites.register({ id: "demo", origins: ["https://d.test/*"], key: () => null, read: "content", search: async (q, p) => [{ q, p }] });
  eq(await A.search({ site: "nosearch", query: "x" }, far), { ok: false, error: 'site must be one of "bilibili", "youtube", "demo".' });
  eq(await A.search({ site: "demo", query: " x ", page: 3 }, far), { ok: true, data: { site: "demo", query: "x", page: 3, items: [{ q: "x", p: 3 }] } });
  eq(await A.search({ site: "toString", query: "x" }, far), { ok: false, error: 'site must be one of "bilibili", "youtube", "demo".' });
  waits.length = 0;
  eq(await A.search({ site: "bilibili", query: "  " }, far), { ok: false, error: "query is required." });
  eq(await A.search({ site: "bilibili", query: "x", page: 0 }, far), { ok: false, error: "page must be an integer ≥ 1." });
  assert.strictEqual(calls.length, 0);

  const [b, y] = await Promise.all([A.search({ site: "bilibili", query: " rust ", page: 2 }, far), A.search({ site: "youtube", query: "rust 所有权" }, far)]);
  assert.strictEqual(b.ok, true);
  eq({ ...b.data, items: b.data.items.length }, { site: "bilibili", query: "rust", page: 2, items: 1 });
  assert.strictEqual(calls[0], "https://api.bilibili.com/x/web-interface/wbi/search/type?search_type=video&keyword=rust&page=2");
  assert.strictEqual(y.data.items.length, 2);
  assert.strictEqual(calls[1], "https://www.youtube.com/results?search_query=rust%20%E6%89%80%E6%9C%89%E6%9D%83");
  assert.ok(waits.some((ms) => ms > 1500 && ms <= 2000), `the second search waited the gap: ${waits}`);

  // Empty is no error.
  biliAnswer = () => ({});
  eq(await A.search({ site: "bilibili", query: "nothing" }, far), { ok: true, data: { site: "bilibili", query: "nothing", page: 1, items: [] } });

  // Risk control: THROTTLED code, WBI key dropped.
  biliAnswer = () => { throw Object.assign(new Error("B站限流"), { code: "THROTTLED" }); };
  eq(await A.search({ site: "bilibili", query: "x" }, far), { ok: false, error: "B站限流", code: "THROTTLED" });
  assert.strictEqual(wbiResets, 1);
  ytStatus = 429;
  const t = await A.search({ site: "youtube", query: "x" }, far);
  assert.strictEqual(t.code, "THROTTLED");
  ytStatus = 500;
  eq(await A.search({ site: "youtube", query: "x" }, far), { ok: false, error: "YouTube answered HTTP 500." });
  const n = calls.length;
  assert.match((await A.search({ site: "youtube", query: "x", page: 2 }, far)).error, /first page only/);
  // Queued past the deadline: dropped before any request.
  eq(await A.search({ site: "youtube", query: "x" }, Date.now() - 1), { ok: false, code: "TIMEOUT", error: "The search waited too long behind earlier ones." });
  assert.strictEqual(calls.length, n);
  console.log("agent-search selftest ok");
})().catch((e) => { console.error(e); process.exit(1); });
