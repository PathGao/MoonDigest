// /usr/local/bin/node extension/agent-video.selftest.js
if (process.versions.bun) (console.error("This selftest needs Node: it fails or hangs under bun (see 自检 in CONTRIBUTING.md)."), process.exit(1));
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

// The worker's load order up to agent-video.js. Its 300 ms gap between calls runs at once and is recorded; other
// timers stay real.
const gaps = [];
const fastGap = (fn, ms) => (ms > 0 && ms <= 1000 ? (gaps.push(ms), setImmediate(fn)) : setTimeout(fn, ms));
const ctx = vm.createContext({ TextEncoder, URL, URLSearchParams, console, setTimeout: fastGap, clearTimeout, setInterval, clearInterval, AbortController });
const order = [...fs.readFileSync(path.join(__dirname, "background.js"), "utf8").matchAll(/importScripts\(([^)]*)\)/g)].flatMap((m) => m[1].match(/"[^"]+"/g).map((f) => JSON.parse(f)));
assert.ok(order.indexOf("agent-video.js") > order.indexOf("triage/triage-bg.js"), "agent-video.js loads after triage-bg.js, whose B站 channel it reads through");
for (const file of order.slice(0, order.indexOf("agent-video.js") + 1)) vm.runInContext(fs.readFileSync(path.join(__dirname, file), "utf8"), ctx);
const V = ctx.MdgAgentVideo;
const plain = (x) => JSON.parse(JSON.stringify(x));

// The subtitle cache's storage.
let local = {};
ctx.chrome = {
  storage: {
    local: {
      get: async (k) => (k == null ? { ...local } : Object.fromEntries([k].flat().filter((x) => x in local).map((x) => [x, local[x]]))),
      set: async (o) => void Object.assign(local, o),
      remove: async (k) => [k].flat().forEach((x) => delete local[x])
    }
  }
};

// ---- fake B站: videos by BV id; every request is recorded ----
const seg = (from, to) => ({ from, to, content: `s${from}` });
const video = (o) => ({ title: "标题", desc: "简介", tname: "科技", duration: 300, pubdate: 1700049600, tags: ["Rust", "教程"], parts: [""], points: [], body: [seg(0, 60), seg(100, 130), seg(130, 200), seg(250, 295)], replies: ["好", "一般"], ...o });
let videos = {};
let fail = {}; // pathname → a response in place of the answer
const json = (body, status = 200) => ({ ok: status === 200, status, json: async () => body });
const fetched = [];
let inFlight = 0;
let maxInFlight = 0;
ctx.fetch = async (url) => {
  const u = new URL(url);
  fetched.push(u);
  inFlight++;
  maxInFlight = Math.max(maxInFlight, inFlight);
  await new Promise((r) => setTimeout(r, 2));
  inFlight--;
  if (fail[u.pathname]) return fail[u.pathname];
  const q = u.searchParams;
  const byAid = (aid) => Object.values(videos).find((v) => String(v.aid) === aid);
  if (u.pathname === "/x/web-interface/nav") return json({ code: 0, data: { isLogin: true, mid: 1 } });
  if (u.pathname === "/x/web-interface/view") return json({ code: -404, message: "啥都木有" });
  if (u.pathname === "/x/web-interface/view/detail") {
    const v = videos[q.get("bvid")];
    if (!v) return json({ code: -404, message: "啥都木有" });
    return json({ code: 0, data: {
      View: { bvid: q.get("bvid"), aid: v.aid, title: v.title, desc: v.desc, tname: v.tname, duration: v.duration, pubdate: v.pubdate, owner: { name: "UP", mid: 9 }, pages: v.parts.map((part, i) => ({ cid: v.aid * 10 + i, page: i + 1, part, duration: v.duration })) },
      Tags: v.tags.map((tag_name) => ({ tag_name }))
    } });
  }
  if (u.pathname === "/x/player/wbi/v2") {
    const v = byAid(q.get("aid"));
    return json({ code: 0, data: { view_points: v.points, subtitle: { subtitles: v.body.length ? [{ id: 7, lan: "ai-zh", lan_doc: "中文（自动生成）", subtitle_url: `//aisubtitle.hdslb.com/${v.aid}.json` }] : [] } } });
  }
  if (u.hostname === "aisubtitle.hdslb.com") return json({ body: byAid(u.pathname.slice(1, -5)).body });
  if (u.pathname === "/x/v2/reply/main") return json({ code: 0, data: { replies: byAid(q.get("oid")).replies.map((message, i) => ({ member: { uname: `u${i}` }, like: i, content: { message } })) } });
  throw new Error(`no route ${u.pathname}`);
};

const A = "BV1aaaaaaaaa";
const B = "BV1bbbbbbbbb";
const page = (bvid) => `https://www.bilibili.com/video/${bvid}`;
const later = () => Date.now() + 60_000;
const day = (s) => { const d = new Date(s * 1000); return [d.getFullYear(), d.getMonth() + 1, d.getDate()].map((n) => String(n).padStart(2, "0")).join("-"); };

const cases = [];
const check = (name, fn) => cases.push([name, fn]);
const reset = () => {
  local = {};
  fail = {};
  fetched.length = 0;
  maxInFlight = 0;
  videos = { [A]: video({ aid: 111, points: [{ content: "开头", from: 0, to: 100 }, { content: "后段", from: 100, to: 300 }] }), [B]: video({ aid: 222, title: "另一个" }) };
};

check("a full read: §1's data for the requested video, with zone and tags, and no tab API touched", async () => {
  const r = await V.read(page(A), {}, later());
  assert.deepStrictEqual(plain(r), { ok: true, data: {
    url: page(A), site: "bilibili", videoId: A, title: "标题", author: "UP", uploadDate: day(1700049600), duration: 300, description: "简介",
    zone: "科技", tags: ["Rust", "教程"],
    part: { index: 1, count: 0, title: "" },
    chapters: [{ title: "开头", from: 0, to: 100 }, { title: "后段", from: 100, to: 300 }],
    subtitle: { lang: "中文（自动生成）", warning: "", missing: "", needLogin: false, segments: [seg(0, 60), seg(100, 130), seg(130, 200), seg(250, 295)] },
    comments: [{ uname: "u0", like: 0, message: "好" }, { uname: "u1", like: 1, message: "一般" }]
  } });
});

check("a part, chapters from the description, a subtitle that does not fit the video, no subtitle", async () => {
  videos[A] = video({ aid: 111, parts: ["上", "下"], desc: "00:00 开场\n01:40 正题", body: [seg(0, 60), seg(900, 960)] });
  let d = (await V.read(`${page(A)}?p=2`, {}, later())).data;
  assert.deepStrictEqual(plain([d.url, d.part]), [`${page(A)}?p=2`, { index: 2, count: 2, title: "下" }]);
  assert.deepStrictEqual(plain(d.chapters), [{ title: "开场", from: 0, to: 100 }, { title: "正题", from: 100, to: 300 }]);
  assert.match(d.subtitle.warning, /字幕时间可能对不上/);
  assert.strictEqual(d.subtitle.segments.length, 2);
  videos[B] = video({ aid: 222, body: [] });
  d = (await V.read(page(B), {}, later())).data;
  assert.deepStrictEqual(plain(d.subtitle), { lang: "", warning: "", missing: "视频没有字幕", needLogin: false, segments: [] });
});

check("brief: the subtitle's first two minutes, no chapters, no comment request; comments stand in for a missing subtitle", async () => {
  let d = (await V.read(page(A), { brief: true }, later())).data;
  assert.deepStrictEqual(plain(d), {
    url: page(A), site: "bilibili", videoId: A, title: "标题", author: "UP", uploadDate: day(1700049600), duration: 300, description: "简介",
    zone: "科技", tags: ["Rust", "教程"],
    part: { index: 1, count: 0, title: "" },
    chapters: [],
    subtitle: { lang: "中文（自动生成）", warning: "", missing: "", needLogin: false, segments: [seg(0, 60), seg(100, 130)] },
    comments: [],
    brief: true
  });
  assert.ok(!fetched.some((u) => u.pathname === "/x/v2/reply/main"));
  videos[B] = video({ aid: 222, body: [], replies: ["1", "2", "3", "4", "5", "6", "7"] });
  d = (await V.read(page(B), { brief: true }, later())).data;
  assert.deepStrictEqual([d.subtitle.missing, d.comments.map((c) => c.message)], ["视频没有字幕", ["1", "2", "3", "4", "5"]]);
  // A subtitle whose first line comes after two minutes is not reported as no subtitle: its own first two minutes.
  videos[B] = video({ aid: 222, body: [seg(130, 140), seg(240, 249), seg(260, 270)] });
  d = (await V.read(page(B), { brief: true }, later())).data;
  assert.deepStrictEqual(plain(d.subtitle.segments), [seg(130, 140), seg(240, 249)]);
});

check("only a URL that names its video is read here: the others are null and ask B站 nothing", async () => {
  for (const url of [
    "https://www.bilibili.com/bangumi/play/ep123", `https://www.bilibili.com/bangumi/play/ep123?bvid=${A}`, `https://www.bilibili.com/festival/x?bvid=${A}`,
    "https://www.bilibili.com/list/watchlater", "https://www.youtube.com/watch?v=dQw4w9WgXcQ", "not a url"
  ]) assert.strictEqual(await V.read(url, {}, later()), null, url);
  assert.strictEqual(fetched.length, 0);
  assert.strictEqual((await V.read(`https://www.bilibili.com/list/watchlater?bvid=${B}`, {}, later())).data.videoId, B);
  videos.BV17x411w7KC = video({ aid: 170001 });
  assert.strictEqual((await V.read("https://www.bilibili.com/video/av170001", {}, later())).data.videoId, "BV17x411w7KC");
});

check("B站 412 is THROTTLED; a gone video keeps its sentence, without a code", async () => {
  fail["/x/web-interface/view/detail"] = json("<html>", 412);
  let r = await V.read(page(A), {}, later());
  assert.deepStrictEqual([r.ok, r.code], [false, "THROTTLED"]);
  fail = { "/x/player/wbi/v2": json({ code: -352, message: "风控校验失败" }) };
  assert.strictEqual((await V.read(page(A), {}, later())).code, "THROTTLED", "a limit on the subtitle list is not 没有字幕");
  fail = {};
  r = await V.read(page("BV1gone00000"), {}, later());
  assert.deepStrictEqual(plain(r), { ok: false, error: ctx.MdgErrors.LABEL.videoGone });
});

check("two reads at once run one after the other, each with its own video; one past its deadline is TIMEOUT", async () => {
  const [a, b] = await Promise.all([V.read(page(A), {}, later()), V.read(page(B), {}, later())]);
  assert.deepStrictEqual([a.data.videoId, a.data.title, b.data.videoId, b.data.title], [A, "标题", B, "另一个"]);
  assert.strictEqual(maxInFlight, 1);
  const firstOfB = fetched.findIndex((u) => u.searchParams.get("bvid") === B);
  assert.ok(fetched.slice(firstOfB).every((u) => !/111|BV1a/.test(u.href)), "every request of the first video before the second's");
  assert.ok(gaps.some((g) => g > 250 && g <= 300), "calls wait for the gap");
  fetched.length = 0;
  const late = await V.read(page(A), {}, Date.now() - 1);
  assert.deepStrictEqual([late.ok, late.code], [false, "TIMEOUT"]);
  assert.strictEqual(fetched.length, 0, "a call nobody waits for any more asks B站 nothing");
});

(async () => {
  for (const [name, fn] of cases) {
    reset();
    await fn();
    console.log(`ok   ${name}`);
  }
  console.log(`agent-video selftest: all ${cases.length} passed`);
})().catch((e) => (console.error(e), process.exit(1)));
