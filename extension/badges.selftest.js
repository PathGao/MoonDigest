// node extension/badges.selftest.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

// The manifest loads typing.js, tag-core.js and bili-surfaces.js before badges.js in the same content-script world.
const tagCoreJs = fs.readFileSync(path.join(__dirname, "tag-core.js"), "utf8");
const badgesJs = fs.readFileSync(path.join(__dirname, "typing.js"), "utf8") + tagCoreJs + fs.readFileSync(path.join(__dirname, "bili-surfaces.js"), "utf8") + fs.readFileSync(path.join(__dirname, "badges.js"), "utf8");
const ctx = vm.createContext({ URLSearchParams });
vm.runInContext(badgesJs, ctx);
const { bvidFromHref, badgeInfo, mergeDecisions } = ctx.BocBadges;
const plain = (v) => JSON.parse(JSON.stringify(v));

assert.strictEqual(bvidFromHref("//www.bilibili.com/video/BV1GJ411x7h7?spm_id_from=333"), "BV1GJ411x7h7");
assert.strictEqual(bvidFromHref("/video/BV1eS4y157Ey/"), "BV1eS4y157Ey");
assert.strictEqual(bvidFromHref("https://www.bilibili.com/list/ml123?bvid=BV1oEga61EFk&oid=1"), "BV1oEga61EFk");
assert.strictEqual(bvidFromHref("https://www.bilibili.com/video/av170001"), "");
assert.strictEqual(bvidFromHref("https://space.bilibili.com/2773586"), "");
assert.strictEqual(bvidFromHref(null), "");

assert.strictEqual(badgeInfo({}), null, "no data, no mark");
assert.strictEqual(badgeInfo({ analysis: { status: "error", error: "x" } }), null, "failed analysis alone is not a mark");
assert.strictEqual(badgeInfo({ tagIds: ["gone"], tags: [] }), null, "dangling tag ids are not a mark");

const s1 = badgeInfo({ title: { verdict: "drop", reason: "标题党", confidence: "low" } });
assert.deepStrictEqual(plain(s1), {
  label: "AI 可清理",
  aria: "MoonDigest 分拣，AI 判断 可清理（标题粗看，低置信）",
  verdict: "drop",
  stage: 1,
  low: true,
  action: "",
  reason: "标题党",
  oneLiner: "",
  points: [],
  tags: []
});

const analysis = { status: "done", verdict: "keep", reason: "干货", oneLiner: "讲 Rust 所有权", points: ["a", "b", ""] };
const s2 = badgeInfo({ title: { verdict: "drop", reason: "x", confidence: "high" }, analysis });
assert.strictEqual(s2.label, "AI 值得留", "stage 2 beats stage 1");
assert.strictEqual(s2.stage, 2);
assert.strictEqual(s2.oneLiner, "讲 Rust 所有权");
assert.deepStrictEqual(plain(s2.points), ["a", "b"]);

const tags = [{ id: "t1", name: "Rust", color: "#f60" }];
const tagOnly = badgeInfo({ tagIds: ["t1"], tags });
assert.strictEqual(tagOnly.label, "");
assert.deepStrictEqual(plain(tagOnly.tags), [{ name: "Rust", color: "#f60" }]);
assert.strictEqual(tagOnly.aria, "MoonDigest 分拣，标签：Rust");

const decided = badgeInfo({ title: { verdict: "keep", confidence: "high" }, decision: { action: "unfav", at: 1 } });
assert.strictEqual(decided.label, "已取消收藏", "a user decision outranks the AI verdict in the label");
assert.strictEqual(decided.verdict, "keep");

assert.strictEqual(badgeInfo({ title: { verdict: "bogus" } }), null, "unknown verdicts are ignored");

assert.strictEqual(badgeInfo({ title: { verdict: "t-must", confidence: "high" } }), null, "old custom-tier verdicts are not a mark");
assert.strictEqual(badgeInfo({ title: { verdict: "unsure" } }).verdict, "unsure");
assert.strictEqual(badgeInfo({ analysis: { status: "done", verdict: "t-must" } }).label, "AI 拿不准", "a done 细看 with an old verdict reads as 待定, like the triage page");

// A video decided in several folders shows its latest decision, whatever the storage-key order.
const merged = mergeDecisions({
  triage_decisions_b: { BV1: { action: "keep", at: 5 }, BV2: { action: "keep", at: 1 } },
  triage_decisions_a: { BV1: { action: "unfav", at: 3 }, BV2: { action: "unfav", at: 9 } },
  triage_video_tags: { BV1: ["t1"] }
});
assert.deepStrictEqual(plain(merged), { BV1: { action: "keep", at: 5 }, BV2: { action: "unfav", at: 9 } });


// ---- UP tags: author link -> mid, where the chip lands ----
const { midFromHref, upTagsOf, spotIn, upCounts, upHidden } = ctx.BocBadges;
assert.strictEqual(midFromHref("//space.bilibili.com/591081863"), "591081863");
assert.strictEqual(midFromHref("https://space.bilibili.com/276268291/?spm_id_from=333.788.upinfo.detail.click"), "276268291");
assert.strictEqual(midFromHref("//space.bilibili.com/1629915907?spm_id_from=333.1387.homepage.video_card.click"), "1629915907");
assert.strictEqual(midFromHref("//space.bilibili.com/6823116#/album"), "6823116");
assert.strictEqual(midFromHref("//space.bilibili.com/85846467/dynamic"), "85846467", "the 动态 popover's author links");
assert.strictEqual(midFromHref("//space.bilibili.com/2773586/favlist"), "", "menu links are not authors");
assert.strictEqual(midFromHref("https://space.bilibili.com/2773586/fans/follow"), "");
assert.strictEqual(midFromHref("https://www.bilibili.com/video/BV1xx411c7mD"), "");
assert.strictEqual(midFromHref(null), "");
const upTags = [{ id: "a", name: "常看", color: "#f00" }, { id: "b", name: "游戏" }, { id: "c", name: "学习" }];
assert.deepStrictEqual(upTagsOf("1", upTags, { 1: ["c", "a", "gone"] }).map((t) => t.id), ["a", "c"], "follow_tags order, dangling ids dropped");
assert.strictEqual(upTagsOf("2", upTags, { 1: ["a"] }).length, 0);
assert.strictEqual(upTagsOf("", upTags, { "": ["a"] }).length, 0);
assert.deepStrictEqual(plain(upCounts(["1", "2", "", "1"], upTags, { 1: ["a", "b"], 2: ["b"] })), { "": 4, a: 2, b: 3, c: 0 });
assert.strictEqual(upHidden("1", "", {}), false, "全部 hides nothing");
assert.strictEqual(upHidden("1", "a", { 1: ["a"] }), false);
assert.strictEqual(upHidden("2", "a", { 1: ["a"] }), true);
assert.strictEqual(upHidden("", "a", { 1: ["a"] }), true, "an unknown author is hidden under a tag");

// ---- the 「+」: which UP a name is (only a reliable mid may be written to), the picker's rows, the storage write ----
const { faceKey, whoIndex, resolveMid, pickRows, applyUpTag, saveUpTag } = ctx.BocBadges;
assert.strictEqual(faceKey("//i0.hdslb.com/bfs/face/A69e0c.jpg@96w_96h_1c_1s.webp"), "a69e0c.jpg", "the avatar file, size suffix dropped");
assert.strictEqual(faceKey("https://i1.hdslb.com/bfs/face/a69e0c.jpg"), "a69e0c.jpg", "follow_people stores the bare URL");
assert.strictEqual(faceKey("//i0.hdslb.com/bfs/vip/dbe23f.png@40w"), "", "a vip badge is not a face");
const folks = {
  1: { name: "甲", face: "https://i0.hdslb.com/bfs/face/f1.jpg" },
  2: { name: "重名", face: "https://i0.hdslb.com/bfs/face/f2.jpg" },
  3: { name: "重名", face: "https://i0.hdslb.com/bfs/face/f3.jpg" },
  4: { name: "丁", face: "https://i0.hdslb.com/bfs/face/noface.jpg" },
  5: { name: "戊", face: "https://i0.hdslb.com/bfs/face/noface.jpg" },
  6: { name: "未关注", face: "" }
};
const idx = whoIndex(folks, ["1", "2", "3", "4", "5"]);
assert.strictEqual(resolveMid({ href: "//space.bilibili.com/42", name: "甲" }, idx), "42", "a profile link wins over everything");
assert.strictEqual(resolveMid({ data: "77", name: "甲" }, idx), "77", "then a data attribute");
assert.strictEqual(resolveMid({ data: "abc", name: "甲" }, idx), "1", "a non-numeric data value is ignored");
assert.strictEqual(resolveMid({ face: "//i0.hdslb.com/bfs/face/f3.jpg@96w.webp", name: "重名" }, idx), "3", "the avatar tells same-named UPs apart");
assert.strictEqual(resolveMid({ name: " 甲 " }, idx), "1", "a name exactly one followed UP has");
assert.strictEqual(resolveMid({ name: "重名" }, idx), "", "a name two followed UPs share: no mid, no 「+」");
assert.strictEqual(resolveMid({ face: "//i0.hdslb.com/bfs/face/noface.jpg", name: "丁" }, idx), "4", "a shared default avatar falls back to a unique name");
assert.strictEqual(resolveMid({ face: "//i0.hdslb.com/bfs/face/noface.jpg", name: "重名" }, idx), "", "shared avatar and shared name: nothing");
assert.strictEqual(resolveMid({ name: "未关注" }, idx), "", "only followed UPs are matched by name");
assert.strictEqual(resolveMid({ name: "甲" }, null), "", "no index, no name match");

const pt = [{ id: "a", name: "常看", color: "#f00" }, { id: "b", name: "游戏" }];
assert.deepStrictEqual(plain(pickRows("1", pt, { 1: ["b"] })), [{ id: "a", name: "常看", color: "#f00", on: false }, { id: "b", name: "游戏", color: "", on: true }]);
let r = applyUpTag(pt, { 1: ["b"], 2: ["a"] }, "1", { toggle: "a" });
assert.deepStrictEqual(plain(r.map), { 1: ["b", "a"], 2: ["a"] }, "toggle on appends");
assert.strictEqual(r.tags, pt, "a toggle leaves follow_tags alone");
r = applyUpTag(pt, { 1: ["b"] }, "1", { toggle: "b" });
assert.deepStrictEqual(plain(r.map), {}, "toggling the last tag off drops the UP's entry");
assert.strictEqual(applyUpTag(pt, {}, "1", { toggle: "gone" }), null, "a deleted tag is not written");
r = applyUpTag(pt, {}, "9", { create: " 学，习, " });
assert.deepStrictEqual(plain(r.tags.slice(0, 2)), plain(pt));
assert.strictEqual(r.tags.length, 3);
assert.deepStrictEqual([r.tags[2].name, r.tags[2].color, r.tags[2].rule], ["学习", "#da86c3", ""], "triage page's name cleaning and first free color");
assert.match(r.tags[2].id, /^ft[0-9a-z]+$/);
assert.deepStrictEqual(plain(r.map), { 9: [r.tags[2].id] }, "the new tag is switched on for this UP");
r = applyUpTag(pt, { 9: ["a"] }, "9", { create: "常看" });
assert.strictEqual(r.tags, pt, "an existing name is reused, not duplicated");
assert.deepStrictEqual(plain(r.map), { 9: ["a"] }, "and stays on");
assert.strictEqual(applyUpTag(pt, {}, "9", { create: " ，" }), null, "an empty name writes nothing");

(async () => {
  const db = { follow_tags: pt, follow_tag_map: { 1: ["a"] } };
  const sets = [];
  const local = { get: async (k) => Object.fromEntries(k.map((x) => [x, db[x]])), set: async (o) => (sets.push(Object.keys(o)), Object.assign(db, o)) };
  db.follow_tag_map = { 1: ["a"], 5: ["b"] }; // written by the triage page after this tab last read it
  await saveUpTag(local, "1", { toggle: "b" });
  assert.deepStrictEqual(plain(db.follow_tag_map), { 1: ["a", "b"], 5: ["b"] }, "reads fresh: another page's write survives");
  assert.deepStrictEqual(sets, [["follow_tag_map"]], "a toggle writes only follow_tag_map");
  await saveUpTag(local, "1", { create: "新" });
  assert.deepStrictEqual(sets[1], ["follow_tags", "follow_tag_map"]);
  assert.strictEqual(db.follow_tags.at(-1).name, "新");
  assert.strictEqual(await saveUpTag(local, "1", { toggle: "nope" }), null);
  assert.strictEqual(sets.length, 2, "nothing written for a tag that is gone");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

// ---- Per-surface rules (DESIGN §8): which page is which, and what each shows ----
const { SURFACES, surfaceOf, fitCount, biliSaysSeen } = ctx.BocBadges;
const where = (url, viewer) => {
  const u = new URL(url);
  return surfaceOf({ host: u.hostname, path: u.pathname, search: u.search, viewer });
};
assert.strictEqual(where("https://www.bilibili.com/video/BV1GJ411x7h7", true), "", "the 分拣台's player iframe: nothing");
assert.strictEqual(where("https://www.bilibili.com/video/BV1GJ411x7h7"), "video");
assert.strictEqual(where("https://www.bilibili.com/list/watchlater?bvid=BV1GJ411x7h7"), "video");
assert.strictEqual(where("https://www.bilibili.com/"), "card");
assert.strictEqual(where("https://www.bilibili.com/?page=Home&tab=ForYou"), "card");
assert.strictEqual(where("https://search.bilibili.com/all?keyword=x"), "card");
assert.strictEqual(where("https://space.bilibili.com/2773586/favlist?fid=1"), "fav");
assert.strictEqual(where("https://www.bilibili.com/?page=Favorites"), "fav");
assert.strictEqual(where("https://www.bilibili.com/watchlater/list"), "later");
assert.strictEqual(where("https://www.bilibili.com/history"), "history");
assert.strictEqual(where("https://www.bilibili.com/account/history"), "history");
assert.strictEqual(where("https://www.bilibili.com/?page=WatchLater"), "later");
assert.strictEqual(where("https://www.bilibili.com/?page=History"), "history");
assert.strictEqual(where("https://t.bilibili.com/"), "feed");
assert.strictEqual(where("https://space.bilibili.com/2773586"), "space");
assert.strictEqual(where("https://space.bilibili.com/2773586/video"), "space");
const show = (k) => { const r = SURFACES[k]; return `${r.novideo ? "x" : r.vtags ? "V" : "-"}${r.ups ? "U" : "-"}${r.plus[0] || "-"}${r.above ? "^" : ""}`; };
assert.deepStrictEqual(Object.keys(SURFACES).map((k) => `${k}:${show(k)}`), [
  "card:VUh", "fav:V--^", "later:VUh", "history:VUh", "feed:xUh", "space:V--", "owner:xUa", "video:VU-", "popover:VU-", "popfeed:xU-"
], "the approved matrix: 动态 (page and popover) shows no video marks, popovers and recommendations no 「+」, 收藏夹 no UP tags, owner names always offer 「+ UP 标签」");
assert.ok(SURFACES.popover.tight && SURFACES.popfeed.tight, "popovers: 看到 N% without ✓");
assert.deepStrictEqual(Object.keys(SURFACES).filter((k) => SURFACES[k].corner), ["history"], "only 历史 swaps the veil for the corner tag");

// The settings table: which cells exist (the others show 「–」 and cannot be turned on), and what turning one off does.
const { ROWS, COLS, allowed, normalizeOff, rulesWith } = ctx.BocSurfaces;
assert.deepStrictEqual(Object.keys(ROWS).sort(), Object.keys(SURFACES).sort(), "a row per surface");
const grid = (k) => Object.keys(COLS).map((c) => (allowed(k, c) ? "✓" : "-")).join("");
assert.deepStrictEqual(Object.keys(ROWS).map((k) => `${k}:${grid(k)}`), [
  "card:✓✓✓✓✓", "popover:✓✓✓-✓", "popfeed:--✓-✓", "feed:--✓✓✓", "video:✓✓✓-✓", "owner:--✓✓-",
  "fav:✓✓--✓", "later:✓✓✓✓✓", "history:✓✓✓✓✓", "space:✓✓--✓"
], "columns: AI 判断, 视频标签, UP 标签, 「+ UP 标签」, 观看进度");
assert.deepStrictEqual(plain(normalizeOff(["fav.vtags", "fav.ups", "nope.seen", "card.vtags", "card.vtags", 3, null])), ["fav.vtags", "card.vtags"], "only cells that exist, once");
const all = rulesWith([]);
assert.ok(Object.keys(SURFACES).every((k) => all[k].ups === allowed(k, "ups") && all[k].seen === allowed(k, "seen")), "nothing off: each surface as offered");
const off = rulesWith(["card.verdict", "card.plus", "popover.seen", "fav.ups"]);
assert.deepStrictEqual([off.card.verdict, off.card.vtags, off.card.ups, off.card.plus, off.card.seen], [false, true, true, "", true], "首页: verdict and 「+」 off, the rest stays");
assert.strictEqual(off.popover.seen, false);
assert.strictEqual(off.fav.ups, false, "a cell that does not exist stays off");
assert.strictEqual(off.later.plus, "hover", "other surfaces untouched");
const noVerdicts = rulesWith([], ["verdict"]);
assert.ok(Object.keys(SURFACES).every((k) => !noVerdicts[k].verdict) && noVerdicts.card.vtags, "a switch that is off turns its whole column off");

// Fitting by width, not count: as many whole chips as fit, then 「+N」; -1 rather than an empty marker.
assert.strictEqual(fitCount([30, 30, 30], 96, { gap: 3 }), 3, "exactly fitting: 30+3+30+3+30 = 96, no 「+N」");
assert.strictEqual(fitCount([30, 30, 30], 95, { gap: 3, more: 20 }), 2, "one px short: the last chip goes, 30+3+30+3+20 = 86");
assert.strictEqual(fitCount([20, 120, 20], 100, { gap: 3, more: 20 }), 1, "a long name stops the row at the chip before it");
assert.strictEqual(fitCount([12, 12, 12, 12, 12, 12], 60, { gap: 2, more: 18 }), 3, "short names: more of them fit");
assert.strictEqual(fitCount([200], 100, { more: 20 }), 0, "one chip that doesn't fit: just 「+1」");
assert.strictEqual(fitCount([30], 60, { gap: 3, fixed: [50], more: 20 }), -1, "not even 「+N」 beside the verdict: hide the group");
assert.strictEqual(fitCount([], 60, { fixed: [50] }), 0, "no chips: the verdict alone");

// A tiny DOM: enough for the selectors badges.js uses (tag, .class, #id, [attr*="x"], descendant).
class Node_ {
  constructor() { this.parentNode = null; }
  get nextSibling() { const k = this.parentNode?.childNodes; return k ? k[k.indexOf(this) + 1] || null : null; }
  get previousSibling() { const k = this.parentNode?.childNodes; return k ? k[k.indexOf(this) - 1] || null : null; }
  after(n) { n.remove(); n.parentNode = this.parentNode; this.parentNode.childNodes.splice(this.parentNode.childNodes.indexOf(this) + 1, 0, n); muts.n++; }
  before(n) { n.remove(); n.parentNode = this.parentNode; this.parentNode.childNodes.splice(this.parentNode.childNodes.indexOf(this), 0, n); muts.n++; }
  remove() { if (!this.parentNode) return; this.parentNode.childNodes.splice(this.parentNode.childNodes.indexOf(this), 1); this.parentNode = null; muts.n++; }
}
class Text_ extends Node_ { constructor(d) { super(); this.nodeType = 3; this.data = d; } get textContent() { return this.data; } }
class El extends Node_ {
  constructor(tag, attrs = {}, kids = []) {
    super();
    Object.assign(this, { nodeType: 1, tagName: tag.toUpperCase(), childNodes: [], attrs: { ...attrs }, dataset: {}, listeners: {}, props: {} });
    const cls = new Set(String(attrs.class || "").split(/\s+/).filter(Boolean));
    const el = this;
    this.classList = { contains: (c) => cls.has(c), add: (c) => cls.add(c), remove: (c) => cls.delete(c), toggle: (c, on) => (on ? cls.add(c) : cls.delete(c), muts.n++), _s: cls };
    this.style = { setProperty: (k, v) => (el.props[k] = v) };
    for (const k of kids) this.append(typeof k === "string" ? new Text_(k) : k);
  }
  get className() { return [...this.classList._s].join(" "); }
  set className(v) { this.classList._s.clear(); for (const c of v.split(/\s+/).filter(Boolean)) this.classList._s.add(c); }
  get textContent() { return this.childNodes.map((n) => n.textContent).join(""); }
  set textContent(v) { this.childNodes = []; this.append(new Text_(String(v))); }
  get firstChild() { return this.childNodes[0] || null; }
  get nextElementSibling() { let n = this.nextSibling; while (n && n.nodeType !== 1) n = n.nextSibling; return n; }
  get title() { return this.attrs.title ?? ""; }
  set title(v) { this.attrs.title = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  append(...ns) { for (const n of ns) { const x = typeof n === "string" ? new Text_(n) : n; x.parentNode = this; this.childNodes.push(x); } }
  addEventListener(t, f) { (this.listeners[t] ||= []).push(f); }
  removeEventListener(t, f) { const l = this.listeners[t]; if (l?.includes(f)) l.splice(l.indexOf(f), 1); }
  replaceChildren(...ns) { this.childNodes = []; this.append(...ns); }
  attachShadow() { this.shadow = h("#shadow"); this.shadow.parentNode = null; this.shadow.host = this; return this.shadow; }
  getBoundingClientRect() { const left = this.x ?? 100; const width = this.w ?? 20; return { left, top: 50, bottom: 70, right: left + width, width }; }
  get clientWidth() { return this.cw ?? 1000; }
  get offsetWidth() { return 270; }
  get offsetHeight() { return 200; }
  get isConnected() { let n = this; while (n.parentNode) n = n.parentNode; return n.host ? n.host.isConnected : n.tagName === "HTML"; }
  focus() { let n = this; while (n.parentNode) n = n.parentNode; if (n.host) n.activeElement = this; focused.el = this; }
  closest(sel) { for (let n = this; n?.nodeType === 1; n = n.parentNode) if (matches(n, sel)) return n; return null; }
  querySelectorAll(sel) { const out = []; const walk = (n) => { for (const k of n.childNodes) if (k.nodeType === 1) { if (matches(k, sel)) out.push(k); walk(k); } }; walk(this); return out; }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}
function simple(el, s) {
  const bare = s.replace(/\[[^\]]*\]/g, "");
  const tag = /^[a-z]+/i.exec(bare)?.[0];
  if (tag && el.tagName !== tag.toUpperCase()) return false;
  for (const [, c] of bare.matchAll(/\.([\w-]+)/g)) if (!el.classList.contains(c)) return false;
  for (const [, i] of bare.matchAll(/#([\w-]+)/g)) if (el.attrs.id !== i) return false;
  for (const [, k, v] of s.matchAll(/\[([\w-]+)\*="([^"]*)"\]/g)) if (!String(el.attrs[k] ?? "").includes(v)) return false;
  return true;
}
function matches(el, sel) {
  return sel.split(",").some((part) => {
    const steps = part.trim().split(/\s+/);
    if (!simple(el, steps.pop())) return false;
    let n = el.parentNode;
    for (let i = steps.length - 1; i >= 0; i--) { while (n?.nodeType === 1 && !simple(n, steps[i])) n = n.parentNode; if (n?.nodeType !== 1) return false; n = n.parentNode; }
    return true;
  });
}
const muts = { n: 0 };
const focused = { el: null };
const h = (tag, attrs, ...kids) => new El(tag, attrs || {}, kids);

// spotIn on markup measured on real pages.
const author = h("span", { class: "bili-video-card__info--author" }, "华师沈威");
assert.strictEqual(spotIn(h("a", {}, h("svg", {}, h("path")), author, h("span", { class: "bili-video-card__info--date" }, "· 3-12"))), author, "home card");
const living = h("a", {}, h("div", { class: "status-1 bili-video-card__info--living" }, h("img"), h("span", {}, "直播中")), h("span", { class: "bili-video-card__info--author" }, "DL"));
assert.strictEqual(spotIn(living).textContent, "DL", "search card with a 直播中 badge: the name, not the badge");
const owner = h("a", { class: "up-name vip" }, " 说我糖是夸我甜吧 ", h("span", { class: "mask" }));
assert.strictEqual(spotIn(owner), owner, "video page owner: after the link, which cuts its overflow off");
const bare = h("a", { class: "channel-name keep-one-line" }, "什么都说-防重名");
assert.strictEqual(spotIn(bare), bare.childNodes[0], "BewlyCat channel name: right after the bare name");
const rec = h("a", {}, h("svg", {}, "icon"), h("span", { class: "name" }, "B站老陈聊AI"));
assert.strictEqual(spotIn(rec).textContent, "B站老陈聊AI", "right-side recommendation");
const spaceCard = h("a", { class: "bili-video-card__author" }, h("div", { class: "bili-video-card__text" }, h("i", { class: "sic-BDC-uploader_name_square_line" }), h("span")), h("div", { class: "bili-video-card__text" }, h("span", { title: "木兰香事" }, "木兰香事")));
assert.strictEqual(spotIn(spaceCard).getAttribute("title"), "木兰香事", "space page card: the titled name, not the name icon");
assert.strictEqual(spotIn(h("a", {}, h("div", {}, h("img"), "  "))), null, "avatar links get no chip");

// B站's own 已看完 on the cover: ours stays off.
const stat = (t) => h("div", { class: "bili-cover-card__stat" }, h("span", {}, t));
assert.ok(biliSaysSeen(h("a", {}, h("div", { class: "bili-cover-card__stats" }, stat("418"), stat("已看完")))));
assert.ok(!biliSaysSeen(h("a", {}, h("div", { class: "bili-cover-card__stats" }, stat("418"), stat("02:31")))));

// ---- the live script on a fake 动态 page (badges.js alone, as the manifest loads it) ----
(async () => {
  const card = (name) => h("div", { class: "bili-dyn-list__item" }, h("div", { class: "bili-dyn-title" }, h("span", { class: "bili-dyn-title__text" }, ` ${name} `)));
  const items = [card("甲"), card("乙"), card("丙")];
  const list = h("div", { class: "bili-dyn-list" }, h("div", { class: "bili-dyn-list__items" }, ...items));
  const homeAuthor = h("span", { class: "bili-video-card__info--author" }, "甲");
  const body = h("body", {}, h("div", { class: "bili-dyn-list-tabs" }), list, h("a", { href: "//space.bilibili.com/1", class: "bili-video-card__info--owner" }, homeAuthor), h("a", { href: "//space.bilibili.com/9" }, h("img")), h("a", { href: "//space.bilibili.com/2", class: "channel-name" }, "乙"));
  const doc = Object.assign(h("html", {}, body), { getElementById: () => null, createElement: (t) => h(t), documentElement: null });
  doc.documentElement = doc;
  const store = {
    follow_tags: [{ id: "t1", name: "常看", color: "#f00" }, { id: "t2", name: "游戏" }],
    follow_tag_map: { 1: ["t1"], 2: ["t2"] },
    follow_people: { 1: { mid: 1, name: "甲" }, 2: { mid: 2, name: "乙" }, 3: { mid: 3, name: "丙" } }
  };
  const changed = [];
  const sent = [];
  const reads = [];
  const session = {};
  const syncVals = { showBiliTriageBadges: false };
  const resized = [];
  const win = {
    document: doc,
    location: { hostname: "t.bilibili.com", pathname: "/", search: "" },
    sessionStorage: { getItem: (k) => session[k] ?? null, setItem: (k, v) => (session[k] = String(v)) },
    MutationObserver: class { observe() {} disconnect() {} },
    ResizeObserver: class { constructor(f) { resized.push(f); } observe() {} disconnect() {} },
    requestAnimationFrame: (f) => setTimeout(f, 0),
    getComputedStyle: () => ({ columnGap: "3px", paddingLeft: "0px", paddingRight: "0px", position: "static", textIndent: "0px" }),
    setTimeout: (f) => setTimeout(f, 0),
    clearTimeout,
    console,
    URLSearchParams,
    chrome: {
      runtime: { id: "x", sendMessage: async (m) => sent.push(m), getURL: (p) => p },
      storage: {
        sync: { get: async (d) => ({ ...d, ...syncVals }) },
        local: { get: async (k) => (reads.push(k), Object.fromEntries([].concat(k).map((x) => [x, store[x]]))) },
        onChanged: { addListener: (f) => changed.push(f) }
      }
    }
  };
  win.window = win;
  win.top = win;
  const live = vm.createContext(win);
  vm.runInContext(badgesJs, live);
  const settle = () => new Promise((r) => setTimeout(r, 30));
  const chipAfter = (n) => (n.nextSibling?.classList?.contains("mdg-ups") ? n.nextSibling : null);
  const tagsText = (box) => box?.querySelectorAll(".mdg-up").filter((c) => !c.classList.contains("mdg-up-add")).map((c) => c.textContent).join("");
  const bar = () => doc.querySelector(".mdg-upbar");
  const hidden = () => items.map((i) => i.classList.contains("mdg-up-hide"));
  await settle();

  const titles = items.map((i) => i.querySelector(".bili-dyn-title__text"));
  assert.strictEqual(tagsText(chipAfter(homeAuthor)), "常看", "chip right after the author name inside the link");
  assert.strictEqual(chipAfter(homeAuthor).title, "MoonDigest 的 UP 标签 · 只存在扩展里");
  assert.strictEqual(tagsText(chipAfter(titles[0])), "常看", "动态 card: name matched via follow_people");
  assert.strictEqual(tagsText(chipAfter(titles[1])), "游戏");
  assert.strictEqual(chipAfter(titles[2]), null, "an UP without tags: no DOM change");
  assert.strictEqual(bar()?.nextElementSibling, list, "the filter bar sits right above the list");
  assert.deepStrictEqual(bar().querySelectorAll(".mdg-upbar-tag").map((b) => b.textContent), ["全部3", "常看1", "游戏1"]);
  assert.deepStrictEqual(hidden(), [false, false, false]);
  assert.strictEqual(reads.filter((k) => [].concat(k).includes("follow_people")).length, 1, "follow_people read once, not per card");

  // A rerun changes nothing.
  muts.n = 0;
  changed.forEach((f) => f({ follow_people: {} }, "local"));
  await settle();
  assert.strictEqual(muts.n, 0, "rerun is idempotent");
  assert.strictEqual(doc.querySelectorAll(".mdg-ups").length, 4);
  assert.strictEqual(body.childNodes.at(-1).querySelectorAll(".mdg-ups").length, 1, "a bare-text name link: our own titled box is not taken for the name");

  // Picking 常看 hides the other UPs' cards with a class and is remembered for the session.
  const pick = (id) => bar().listeners.click[0]({ target: bar().querySelectorAll(".mdg-upbar-tag").find((b) => b.dataset.tag === id) });
  pick("t1");
  await settle();
  assert.deepStrictEqual(hidden(), [false, true, true]);
  assert.strictEqual(session["mdg-up-filter"], "t1");
  assert.deepStrictEqual(bar().querySelectorAll(".mdg-upbar-tag").filter((b) => b.attrs["aria-pressed"] === "true").map((b) => b.dataset.tag), ["t1"]);
  // A card loaded later by infinite scroll is filtered too.
  const late = card("乙");
  list.childNodes[0].append(late);
  items.push(late);
  changed.forEach((f) => f({ follow_people: {} }, "local"));
  await settle();
  assert.deepStrictEqual(hidden(), [false, true, true, true]);
  assert.deepStrictEqual(bar().querySelectorAll(".mdg-upbar-tag").map((b) => b.textContent), ["全部4", "常看1", "游戏2"]);

  // Retagging replaces the chip in place rather than adding a second one.
  store.follow_tag_map = { 1: ["t1", "t2"], 2: ["t2"] };
  changed.forEach((f) => f({ follow_tag_map: {} }, "local"));
  await settle();
  assert.strictEqual(tagsText(chipAfter(homeAuthor)), "常看游戏");
  assert.strictEqual(homeAuthor.parentNode.querySelectorAll(".mdg-ups").length, 1);

  // UP tag chips are not controls: no role, no tab stop, and a click or Enter goes to B站's own link (the space page).
  const chip = chipAfter(homeAuthor).childNodes[1];
  assert.deepStrictEqual([chip.attrs.role, chip.tabIndex], [undefined, undefined], "a chip is not a link or a button");
  let stopped = 0;
  const ev = { type: "click", composedPath: () => [chip, chip.parentNode, homeAuthor], preventDefault: () => stopped++, stopPropagation: () => stopped++ };
  doc.listeners.click.forEach((f) => f(ev));
  doc.listeners.keydown.forEach((f) => f({ ...ev, type: "keydown", key: "Enter" }));
  assert.deepStrictEqual([sent.length, stopped], [0, 0], "clicking a chip neither opens the 分拣台 nor stops B站's link");

  // 「+N」: every chip fits in a wide box; a narrow one keeps whole chips and counts the rest (ResizeObserver refit).
  // The room is the box's own width with every chip laid out (the chips wrap, so that is the room the card gives it).
  const ups = chipAfter(homeAuthor);
  const room = { set w(v) { ups.cw = v; ups.x = 0; Object.assign(homeAuthor.parentNode, { x: 0, w: v }); } };
  const more = ups.querySelector(".mdg-more");
  room.w = 1000;
  resized.forEach((f) => f());
  await settle();
  assert.ok(more.classList.contains("mdg-off"), "all fit: no 「+N」");
  assert.strictEqual(more.dataset.names, "常看、游戏", "「+N」 lists every tag on hover or focus");
  // 「常看」 20, a long 「游戏」 60, 「+N」 20 and the hover 「+ UP 标签」 20 (it keeps its place), gaps 3: all = 106 > 70,
  // one chip + 「+1」 + the button = 66 fits.
  ups.querySelectorAll(".mdg-up")[1].w = 60;
  room.w = 70;
  resized.forEach((f) => f());
  await settle();
  assert.deepStrictEqual(ups.querySelectorAll(".mdg-up").map((c) => c.classList.contains("mdg-off")), [false, true], "the chip that doesn't fit hides whole");
  assert.strictEqual(more.textContent, "+1");
  assert.ok(!more.classList.contains("mdg-off"));
  room.w = 1000;
  resized.forEach((f) => f());
  await settle();
  assert.ok(more.classList.contains("mdg-off") && !ups.querySelectorAll(".mdg-up")[1].classList.contains("mdg-off"), "room again: all chips back");
  // In a line of text the parent's edge bounds the box even when the box itself lays out wider (BewlyCat's names).
  Object.assign(homeAuthor.parentNode, { x: 0, w: 70 });
  resized.forEach((f) => f());
  await settle();
  assert.strictEqual(more.textContent, "+1", "the parent's edge is the limit, not the box's own width");
  room.w = 1000;
  resized.forEach((f) => f());
  await settle();

  // 「在 B站页面显示 UP 标签」 off: every box and the filter bar go; on again, they come back.
  syncVals.showBiliUpTags = false;
  changed.forEach((f) => f({ showBiliUpTags: { newValue: false } }, "sync"));
  await settle();
  assert.strictEqual(doc.querySelectorAll(".mdg-ups, .mdg-upbar").length, 0, "setting off: no UP tags");
  syncVals.showBiliUpTags = true;
  changed.forEach((f) => f({ showBiliUpTags: { newValue: true } }, "sync"));
  await settle();
  assert.strictEqual(tagsText(chipAfter(homeAuthor)), "常看游戏", "setting on: back");

  // 动态页's UP tags off in the settings table: the filter bar goes with them and every card shows; on again, back.
  pick("t1");
  await settle();
  assert.ok(hidden().some(Boolean), "a tag picked: some cards hidden");
  syncVals.biliMarksOff = ["feed.ups"];
  changed.forEach((f) => f({ biliMarksOff: { newValue: ["feed.ups"] } }, "sync"));
  await settle();
  assert.strictEqual(bar(), null, "feed.ups off: no filter bar");
  assert.deepStrictEqual(hidden(), [false, false, false, false], "feed.ups off: every card shows");
  syncVals.biliMarksOff = [];
  changed.forEach((f) => f({ biliMarksOff: { newValue: [] } }, "sync"));
  await settle();
  assert.ok(bar(), "feed.ups on: the bar is back");
  pick("");
  await settle();

  // No UP tags left: chips, bar and hidden cards all go.
  store.follow_tags = [];
  changed.forEach((f) => f({ follow_tags: {} }, "local"));
  await settle();
  assert.strictEqual(doc.querySelectorAll(".mdg-ups, .mdg-upbar").length, 0);
  assert.deepStrictEqual(hidden(), [false, false, false, false]);
  await plusPage();
  await surfacePages();
  console.log("badges selftest ok");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

// ---- the 「+」 and its picker on a fake 动态 page: followed UPs only, a reliable mid only, writes redraw every box ----
async function plusPage() {
  const face = (f) => h("div", { class: "bili-dyn-item__avatar" }, h("img", { src: `//i0.hdslb.com/bfs/face/${f}.jpg@96w_96h_1c_1s.webp` }));
  const card = (name, f, attrs = {}) =>
    h("div", { class: "bili-dyn-list__item" }, h("div", { class: "bili-dyn-item", ...attrs }, f ? face(f) : h("div"), h("div", { class: "bili-dyn-title" }, h("span", { class: "bili-dyn-title__text" }, name))));
  const cards = { a: card("甲", "f1"), dup: card("重名", "zz"), c: card("丙", ""), d: card("重名", "f3"), e: card("不在名单", "", { "data-mid": "7" }), a2: card("甲", "") };
  const list = h("div", { class: "bili-dyn-list" }, h("div", { class: "bili-dyn-list__items" }, ...Object.values(cards)));
  const linkName = h("span", { class: "bili-video-card__info--author" }, "重名");
  const doc = Object.assign(h("html", {}, h("body", {}, list, h("a", { href: "//space.bilibili.com/3" }, linkName))), { getElementById: () => null, createElement: (t) => h(t) });
  doc.documentElement = doc;
  const store = {
    follow_tags: [{ id: "a", name: "常看", color: "#f00" }, { id: "b", name: "游戏", color: "#0a0" }],
    follow_tag_map: { 1: ["a"] },
    follow_list: { list: ["1", "2", "3", "4", "7"] },
    follow_people: {
      1: { name: "甲", face: "https://i0.hdslb.com/bfs/face/f1.jpg" },
      2: { name: "重名", face: "https://i0.hdslb.com/bfs/face/f2.jpg" },
      3: { name: "重名", face: "https://i0.hdslb.com/bfs/face/f3.jpg" },
      4: { name: "丙", face: "" },
      7: { name: "改过名", face: "" }
    }
  };
  const sets = [];
  const winL = {};
  let textColor = "rgb(24, 25, 28)";
  const win = {
    document: doc,
    location: { hostname: "t.bilibili.com", pathname: "/", search: "" },
    sessionStorage: { getItem: () => null, setItem() {} },
    MutationObserver: class { observe() {} disconnect() {} },
    setTimeout: (f) => setTimeout(f, 0),
    clearTimeout,
    console,
    URLSearchParams,
    innerWidth: 1440,
    innerHeight: 900,
    getComputedStyle: () => ({ color: textColor, position: "static", textIndent: "0px" }),
    addEventListener: (t, f) => (winL[t] ||= []).push(f),
    removeEventListener: (t, f) => winL[t]?.includes(f) && winL[t].splice(winL[t].indexOf(f), 1),
    chrome: {
      runtime: { id: "x", sendMessage: async () => {}, getURL: (p) => p },
      storage: {
        sync: { get: async (d) => ({ ...d, showBiliTriageBadges: false }) },
        local: {
          get: async (k) => JSON.parse(JSON.stringify(Object.fromEntries([].concat(k).map((x) => [x, store[x]])))),
          set: async (o) => (sets.push(Object.keys(o)), Object.assign(store, JSON.parse(JSON.stringify(o))))
        },
        onChanged: { addListener: (f) => changed.push(f) }
      }
    }
  };
  const changed = [];
  win.window = win;
  win.top = win;
  vm.runInContext(badgesJs, vm.createContext(win));
  const settle = () => new Promise((r) => setTimeout(r, 30));
  await settle();
  const title = (k) => cards[k].querySelector(".bili-dyn-title__text");
  const boxOf = (n) => (n.nextSibling?.classList?.contains("mdg-ups") ? n.nextSibling : null);
  const plusOf = (n) => boxOf(n)?.querySelector(".mdg-up-add") || null;
  const tagsOf = (n) => boxOf(n)?.querySelectorAll(".mdg-up").filter((c) => !c.classList.contains("mdg-up-add")).map((c) => c.textContent).join("");
  const counts = () => doc.querySelector(".mdg-upbar").querySelectorAll(".mdg-upbar-tag").map((b) => b.textContent);

  assert.strictEqual(tagsOf(title("a")), "常看", "avatar match: 甲's chips");
  assert.ok(plusOf(title("a")), "a tagged UP gets the 「+」 after its chips");
  assert.strictEqual(tagsOf(title("a2")), "常看", "name match: the only followed 甲");
  assert.strictEqual(boxOf(title("dup")), null, "a name two followed UPs share and an unknown avatar: no chips, no 「+」");
  assert.ok(plusOf(title("d")), "the same name with a known avatar: 「+」 for mid 3");
  assert.strictEqual(boxOf(title("d")).dataset.mid, "3");
  assert.strictEqual(boxOf(title("e")).dataset.mid, "7", "a data attribute on the card names the UP even after a rename");
  assert.strictEqual(boxOf(linkName).dataset.mid, "3", "a profile link names the UP outright");
  const cBox = boxOf(title("c"));
  assert.ok(cBox.classList.contains("mdg-ups-empty"), "an untagged followed UP: a box with only the 「+」");
  assert.strictEqual(tagsOf(title("c")), "");
  const plus = plusOf(title("c"));
  assert.strictEqual(plus.title, "给这个 UP 打标签 · 只存在扩展里，不改 B站");
  assert.deepStrictEqual([plus.attrs.role, plus.attrs["aria-label"], plus.attrs["aria-expanded"], plus.tabIndex], ["button", "给 丙 打 UP 标签", "false", 0]);
  assert.deepStrictEqual(counts(), ["全部6", "常看2", "游戏0"]);

  // Opening: a click on the 「+」 is kept from Bilibili's own handlers (the name opens the space page).
  let stopped = 0;
  const ev = (target, extra = {}) => ({ type: "click", composedPath: () => [target, target.parentNode, doc], preventDefault: () => stopped++, stopPropagation: () => stopped++, ...extra });
  doc.listeners.click.forEach((f) => f(ev(plus)));
  assert.strictEqual(stopped, 2);
  const host = doc.childNodes.at(-1);
  assert.ok(host.classList.contains("mdg-tagpick-host") && host.shadow, "the picker is its own shadow root on <html>");
  const panel = host.shadow.querySelector(".pick");
  assert.ok(!panel.classList.contains("dark"));
  assert.strictEqual(plus.attrs["aria-expanded"], "true");
  const rows = () => panel.querySelectorAll(".opt").filter((b) => b.dataset.id).map((b) => `${b.textContent}:${b.attrs["aria-checked"]}`);
  assert.deepStrictEqual(rows(), ["常看:false", "游戏:false"]);
  assert.strictEqual(panel.querySelector(".h").textContent, "给「丙」打标签");
  assert.strictEqual(panel.querySelector(".new").textContent, "+新建标签");
  assert.strictEqual(panel.querySelector(".foot").textContent, "只存在 MoonDigest 里，不改 B站 · Esc 关闭");
  assert.strictEqual(focused.el, panel.querySelector(".opt"), "focus moves into the picker");
  let hostStops = 0;
  host.listeners.keydown.forEach((f) => f({ stopPropagation: () => hostStops++ }));
  assert.strictEqual(hostStops, 1, "keys typed in the picker stop at its host (page hotkeys never see them)");

  // A check writes follow_tag_map and redraws this UP's box and the bar counts at once (no storage event needed here).
  panel.listeners.click[0]({ target: panel.querySelectorAll(".opt")[1] });
  await settle();
  assert.deepStrictEqual(store.follow_tag_map, { 1: ["a"], 4: ["b"] });
  assert.deepStrictEqual(sets, [["follow_tag_map"]]);
  assert.strictEqual(tagsOf(title("c")), "游戏");
  assert.ok(!boxOf(title("c")).classList.contains("mdg-ups-empty"));
  assert.deepStrictEqual(counts(), ["全部6", "常看2", "游戏1"]);
  assert.deepStrictEqual(rows(), ["常看:false", "✓游戏:true"]);
  assert.strictEqual(focused.el?.dataset.id, "b", "focus stays on the row just toggled");
  assert.strictEqual(plusOf(title("c")).attrs["aria-expanded"], "true", "the rebuilt box's 「+」 still shows the picker open");

  // 新建标签: the row turns into a name field; Enter creates the tag and switches it on.
  panel.listeners.click[0]({ target: panel.querySelector(".new").firstChild });
  const input = panel.querySelector("input");
  assert.ok(input && focused.el === input);
  // Enter picking an IME candidate creates nothing, Esc cancelling the composition keeps the panel and the text.
  input.value = "zhong";
  panel.listeners.keydown[0]({ key: "Enter", target: input, isComposing: true, keyCode: 229, preventDefault() {} });
  await settle();
  assert.ok(!store.follow_tags.some((t) => t.name === "zhong"), "no UP tag named after half-typed pinyin");
  panel.listeners.keydown[0]({ key: "Escape", target: input, isComposing: true, keyCode: 229, preventDefault() {} });
  assert.ok(host.isConnected, "Esc mid-IME leaves the picker open");
  // a follow sync rewriting follow_list does not rebuild the picker under the name being typed.
  changed.forEach((f) => f({ follow_list: { newValue: store.follow_list } }, "local"));
  await settle();
  assert.strictEqual(panel.querySelector("input"), input, "the name field survives the sync");
  assert.strictEqual(input.value, "zhong");
  input.value = "学习";
  panel.listeners.keydown[0]({ key: "Enter", target: input, preventDefault() {} });
  await settle();
  const made = store.follow_tags.at(-1);
  assert.strictEqual(made.name, "学习");
  assert.deepStrictEqual(store.follow_tag_map[4], ["b", made.id]);
  assert.strictEqual(tagsOf(title("c")), "游戏学习");
  assert.deepStrictEqual(counts(), ["全部6", "常看2", "游戏1", "学习1"]);
  assert.strictEqual(focused.el?.dataset.id, made.id);

  // Esc closes and hands focus back to the (rebuilt) 「+」.
  panel.listeners.keydown[0]({ key: "Escape", preventDefault() {} });
  assert.ok(!host.isConnected);
  assert.strictEqual(focused.el, plusOf(title("c")));
  assert.strictEqual(plusOf(title("c")).attrs["aria-expanded"], "false");
  assert.deepStrictEqual(winL.scroll, [], "page listeners go with it");

  // Bilibili dark: the picker follows. Unchecking 甲's only tag empties every 甲 box on the page at once.
  doc.classList.add("bili_dark");
  doc.listeners.click.forEach((f) => f(ev(plusOf(title("a")))));
  const host2 = doc.childNodes.at(-1);
  const panel2 = host2.shadow.querySelector(".pick");
  assert.ok(panel2.classList.contains("dark"));
  panel2.listeners.click[0]({ target: panel2.querySelectorAll(".opt")[0] });
  await settle();
  assert.strictEqual(store.follow_tag_map[1], undefined);
  assert.deepStrictEqual([tagsOf(title("a")), tagsOf(title("a2"))], ["", ""]);
  assert.ok(boxOf(title("a2")).classList.contains("mdg-ups-empty"), "甲 is still followed: the 「+」 stays");
  assert.deepStrictEqual(counts(), ["全部6", "常看0", "游戏1", "学习1"]);
  // A pointerdown anywhere else closes it without touching the page's own handling.
  doc.listeners.pointerdown.forEach((f) => f({ composedPath: () => [list, doc] }));
  assert.ok(!host2.isConnected);
  // BewlyCat's own dark theme (no bili_dark class): light name text means a dark picker.
  doc.classList.remove("bili_dark");
  textColor = "rgb(231, 233, 235)";
  doc.listeners.click.forEach((f) => f(ev(plusOf(title("d")))));
  assert.ok(doc.childNodes.at(-1).shadow.querySelector(".pick").classList.contains("dark"));
}

// ---- the live script on other surfaces: the 分拣台's player, a home page with a header popover, a 收藏夹 page ----
async function surfacePages() {
  const store = {
    follow_tags: [{ id: "a", name: "常看", color: "#f00" }],
    follow_tag_map: { 1: ["a"] },
    follow_list: { list: ["1"] }
  };
  const page = async (location, body, viewer) => {
    const doc = Object.assign(h("html", {}, body), { getElementById: () => null, createElement: (t) => h(t), hasAttribute: (k) => viewer && k === "data-mdg-viewer" });
    doc.documentElement = doc;
    const reads = [];
    const listen = [];
    const win = {
      document: doc,
      location: { search: "", ...location },
      sessionStorage: { getItem: () => null, setItem() {} },
      MutationObserver: class { observe() {} disconnect() {} },
      setTimeout: (f) => setTimeout(f, 0),
      clearTimeout,
      console,
      URLSearchParams,
      getComputedStyle: () => ({ columnGap: "3px", paddingLeft: "0px", paddingRight: "0px", position: "static", textIndent: "0px", color: "" }),
      chrome: {
        runtime: { id: "x", sendMessage: async () => {}, getURL: (p) => p },
        storage: {
          sync: { get: async (d) => d },
          local: { get: async (k) => (reads.push(k), Object.fromEntries([].concat(k).map((x) => [x, store[x]]))) },
          onChanged: { addListener: (f) => listen.push(f) }
        }
      }
    };
    win.window = win;
    win.top = win;
    vm.runInContext(badgesJs, vm.createContext(win));
    await new Promise((r) => setTimeout(r, 30));
    return { doc, reads, listen };
  };
  const author = () => h("a", { href: "//space.bilibili.com/1" }, h("span", { class: "bili-video-card__info--author" }, "甲"));

  // The 分拣台's player iframe: badges.js draws nothing and reads nothing.
  const viewer = await page({ hostname: "www.bilibili.com", pathname: "/video/BV1GJ411x7h7" }, h("body", {}, author()), true);
  assert.deepStrictEqual([viewer.reads.length, viewer.listen.length, viewer.doc.querySelectorAll(".mdg-ups").length], [0, 0, 0], "player iframe: no reads, no listeners, no marks");

  // Home: a card's author gets its UP tags and 「+」; the same author in a header popover gets the tags, no 「+」.
  const inPop = author();
  const onCard = author();
  const home = await page({ hostname: "www.bilibili.com", pathname: "/" }, h("body", {}, h("div", { class: "bew-popover" }, inPop), onCard));
  const boxAfter = (a) => a.querySelector(".mdg-ups");
  assert.ok(boxAfter(onCard), "home card: UP tags");
  assert.ok(boxAfter(onCard).classList.contains("mdg-plus-hover"), "home card: 「+ UP 标签」 on hover");
  assert.ok(boxAfter(inPop), "header popover: UP tags");
  assert.strictEqual(boxAfter(inPop).querySelector(".mdg-up-add"), null, "header popover: no 「+」 (so no orphaned picker)");
  assert.ok(boxAfter(inPop).querySelector(".mdg-more"), "header popover: the 「+N」 that fitBoxes shows when the tags don't fit");

  // 收藏夹 page: no UP tags at all.
  const fav = await page({ hostname: "space.bilibili.com", pathname: "/9/favlist" }, h("body", {}, author()));
  assert.strictEqual(fav.doc.querySelectorAll(".mdg-ups").length, 0, "收藏夹 page: no UP tags");

  // The video page's UP name: its own line under the name row, 「+ UP 标签」 always shown.
  const row = h("div", { class: "up-detail-top" }, h("a", { href: "//space.bilibili.com/1/", class: "up-name" }, " 甲 ", h("span", { class: "mask" })), h("a", { href: "//message.bilibili.com/" }, "发消息"));
  const rec = author();
  await page({ hostname: "www.bilibili.com", pathname: "/video/BV1GJ411x7h7" }, h("body", {}, h("div", { class: "up-detail" }, row), h("div", { class: "right-container" }, rec)));
  const line = row.nextSibling;
  assert.ok(line?.classList.contains("mdg-ups-line") && line.classList.contains("mdg-plus-always"), "UP name: a line of its own, 「+」 always");
  assert.strictEqual(line.querySelector(".mdg-up-add").dataset.name, "甲", "the picker names the UP, not the whole row");
  assert.strictEqual(line.querySelector(".mdg-up-add").textContent, "+ UP 标签");
  assert.ok(boxAfter(rec), "recommendations beside the video: UP tags");
  assert.strictEqual(boxAfter(rec).querySelector(".mdg-up-add"), null, "recommendations beside the video: no 「+」");
}
