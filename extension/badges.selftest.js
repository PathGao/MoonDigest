// node extension/badges.selftest.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const ctx = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname, "badges.js"), "utf8"), ctx);
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

// A tiny DOM: enough for the selectors badges.js uses (tag, .class, #id, [attr*="x"], descendant).
class Node_ {
  constructor() { this.parentNode = null; }
  get nextSibling() { const k = this.parentNode?.childNodes; return k ? k[k.indexOf(this) + 1] || null : null; }
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
  get nextElementSibling() { let n = this.nextSibling; while (n && n.nodeType !== 1) n = n.nextSibling; return n; }
  getAttribute(k) { return this.attrs[k] ?? null; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  append(...ns) { for (const n of ns) { const x = typeof n === "string" ? new Text_(n) : n; x.parentNode = this; this.childNodes.push(x); } }
  addEventListener(t, f) { (this.listeners[t] ||= []).push(f); }
  removeEventListener() {}
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

// ---- the live script on a fake 动态 page (badges.js alone, as the manifest loads it) ----
(async () => {
  const card = (name) => h("div", { class: "bili-dyn-list__item" }, h("div", { class: "bili-dyn-title" }, h("span", { class: "bili-dyn-title__text" }, ` ${name} `)));
  const items = [card("甲"), card("乙"), card("丙")];
  const list = h("div", { class: "bili-dyn-list" }, h("div", { class: "bili-dyn-list__items" }, ...items));
  const homeAuthor = h("span", { class: "bili-video-card__info--author" }, "甲");
  const body = h("body", {}, h("div", { class: "bili-dyn-list-tabs" }), list, h("a", { href: "//space.bilibili.com/1", class: "bili-video-card__info--owner" }, homeAuthor), h("a", { href: "//space.bilibili.com/9" }, h("img")));
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
  const win = {
    document: doc,
    location: { hostname: "t.bilibili.com", pathname: "/", search: "" },
    sessionStorage: { getItem: (k) => session[k] ?? null, setItem: (k, v) => (session[k] = String(v)) },
    MutationObserver: class { observe() {} disconnect() {} },
    setTimeout: (f) => setTimeout(f, 0),
    clearTimeout,
    console,
    URLSearchParams,
    chrome: {
      runtime: { id: "x", sendMessage: async (m) => sent.push(m), getURL: (p) => p },
      storage: {
        sync: { get: async (d) => ({ ...d, showBiliTriageBadges: false }) },
        local: { get: async (k) => (reads.push(k), Object.fromEntries([].concat(k).map((x) => [x, store[x]]))) },
        onChanged: { addListener: (f) => changed.push(f) }
      }
    }
  };
  win.window = win;
  win.top = win;
  const live = vm.createContext(win);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "badges.js"), "utf8"), live);
  const settle = () => new Promise((r) => setTimeout(r, 30));
  const chipAfter = (n) => (n.nextSibling?.classList?.contains("mdg-ups") ? n.nextSibling : null);
  const bar = () => doc.querySelector(".mdg-upbar");
  const hidden = () => items.map((i) => i.classList.contains("mdg-up-hide"));
  await settle();

  const titles = items.map((i) => i.querySelector(".bili-dyn-title__text"));
  assert.strictEqual(chipAfter(homeAuthor)?.textContent, "常看", "chip right after the author name inside the link");
  assert.strictEqual(chipAfter(homeAuthor).title, "MoonDigest 的 UP 标签 · 只存在扩展里");
  assert.strictEqual(chipAfter(titles[0])?.textContent, "常看", "动态 card: name matched via follow_people");
  assert.strictEqual(chipAfter(titles[1])?.textContent, "游戏");
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
  assert.strictEqual(doc.querySelectorAll(".mdg-ups").length, 3);

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
  assert.strictEqual(chipAfter(homeAuthor).textContent, "常看游戏");
  assert.strictEqual(homeAuthor.parentNode.querySelectorAll(".mdg-ups").length, 1);

  // A chip click opens the triage page's 关注 mode on that tag, not the space page behind it.
  const chip = chipAfter(homeAuthor).childNodes[1];
  let stopped = 0;
  const ev = { type: "click", composedPath: () => [chip, chip.parentNode, homeAuthor], preventDefault: () => stopped++, stopPropagation: () => stopped++ };
  doc.listeners.click.forEach((f) => f(ev));
  assert.deepStrictEqual(plain(sent), [{ type: "triage-open", hash: "follow&tag=t2" }]);
  assert.strictEqual(stopped, 2);

  // No UP tags left: chips, bar and hidden cards all go.
  store.follow_tags = [];
  changed.forEach((f) => f({ follow_tags: {} }, "local"));
  await settle();
  assert.strictEqual(doc.querySelectorAll(".mdg-ups, .mdg-upbar").length, 0);
  assert.deepStrictEqual(hidden(), [false, false, false, false]);
  console.log("badges selftest ok");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
