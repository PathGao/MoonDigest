// /usr/local/bin/node extension/triage/tag-store.selftest.js
// The tag pipeline the three pages share (tag-store.js), driven through its own API with the backends over fake storage.
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const plain = (v) => JSON.parse(JSON.stringify(v));
const tick = () => new Promise((r) => setImmediate(r));
// One storage and one lock manager for the page and a second context (the background).
const store = {};
let failSet = false;
const chrome = {
  storage: {
    local: {
      get: async (keys) => (await tick(), Object.fromEntries([].concat(keys).filter((k) => k in store).map((k) => [k, structuredClone(store[k])]))),
      set: async (o) => {
        await tick();
        if (failSet) throw new Error("QUOTA_BYTES quota exceeded");
        Object.assign(store, structuredClone(o));
      },
      remove: async (keys) => [].concat(keys).forEach((k) => delete store[k])
    }
  }
};
const held = new Map();
const navigator = { locks: { request: (name, fn) => { const run = (held.get(name) || Promise.resolve()).then(fn); held.set(name, run.catch(() => {})); return run; } } };
const load = (files) => {
  const ctx = vm.createContext({ chrome, navigator, console, structuredClone, setTimeout, document: { getElementById: () => null } });
  ctx.globalThis = ctx;
  for (const f of files) vm.runInContext(fs.readFileSync(path.join(__dirname, f), "utf8"), ctx);
  return ctx;
};
const ctx = load(["../common.js", "../errors.js", "../limits.js", "../settings.js", "../tag-core.js", "shared.js", "runs.js", "tag-picker.js", "tag-store.js"]);
const { MdgTagStore: TS, TriageUi: UI } = ctx;

// A page: the adapter with its words, data in memory behind the local backend (收藏夹's), or any backend given.
function page(o = {}) {
  const p = { tags: [], map: {}, said: [], asked: [], changed: 0, proposal: null, recent: null, saveOk: true, gone: [] };
  const db = TS.local({
    keys: { tags: "tags", map: "map" },
    get: () => ({ tags: p.tags, map: p.map }),
    put: (part) => Object.assign(p, part),
    save: async (patch) => p.saveOk && (Object.assign(store, structuredClone(patch)), true)
  });
  p.store = TS.create({
    ...db,
    who: "视频",
    idPrefix: "t",
    cap: () => 3,
    full: (n) => `已经有 ${n} 个`,
    fullShort: () => "名额已满",
    capName: "这里的标签",
    keepOverCap: true,
    newTagMax: () => 5,
    confirm: async (...a) => (p.asked.push(a), true),
    say: (text, error = false) => p.said.push([text, error]),
    changed: () => p.changed++,
    tagGone: (id) => p.gone.push(id),
    setProposal: (x) => (p.proposal = x),
    live: () => new Set(["a", "b", "c"]),
    markRecent: (keys, at) => (p.recent = { keys, at }),
    endRecent: (at) => p.recent?.at === at && (p.recent = null),
    ...o
  });
  return p;
}
const proposal = (newTags, rows) => ({ newTags: newTags.map((name) => ({ key: name, name, checked: true })), rows, notes: [], errors: [] });

(async () => {
  // Create: a name is cleaned and found again; the cap refuses a new one with why, in red; an existing name still works.
  {
    const p = page();
    const a = await p.store.createTag(" 科普, ");
    assert.deepStrictEqual([a.name, a.id.startsWith("t"), p.tags.length, plain(store.tags).length], ["科普", true, 1, 1]);
    assert.strictEqual(await p.store.createTag("科普"), a, "the same name is the same tag");
    await p.store.createTag("二");
    await p.store.createTag("三");
    assert.strictEqual(await p.store.createTag("四"), null);
    assert.deepStrictEqual([p.said.at(-1), p.tags.length, p.store.full()], [["已经有 3 个", true], 3, "已经有 3 个"]);
    assert.strictEqual((await p.store.createTag("二")).name, "二", "an existing name at the cap");
    assert.strictEqual(await p.store.createTag("、"), null, "a name that cleans to nothing");
    assert.deepStrictEqual(p.said.at(-1), ["标签名不能为空", true]);
  }

  // Scoped (收藏夹): a tag belongs to its folder; outside one nothing is made; the picker over two folders offers no
  // 新建 and says why with the folder words (K25), as 标签管理 and AI 打标签 do.
  {
    const FOLDER_ONLY = "标签按收藏夹分开，先打开一个具体收藏夹";
    const p = page({ scoped: true, scopeWhy: (f) => (!f || f === "all" ? FOLDER_ONLY : "") });
    const x = await p.store.createTag("甲", "A");
    const y = await p.store.createTag("甲", "B");
    assert.ok(x.folder === "A" && y.folder === "B" && x.id !== y.id, "same name, two folders, two tags");
    assert.strictEqual(await p.store.createTag("乙", "all"), null);
    assert.deepStrictEqual(p.said.at(-1), [FOLDER_ONLY, true]);
    let po = null;
    ctx.TagPicker.open = (o) => (po = o);
    p.store.openPicker({ title: "t", targets: ["a"], scopes: ["A", "B"] });
    assert.deepStrictEqual([po.canCreate, po.empty, po.tags().length], [false, FOLDER_ONLY, 2]);
    p.store.openPicker({ title: "t", targets: ["a"], scopes: ["A"] });
    assert.deepStrictEqual(plain([po.canCreate, po.empty, po.tags().map((t) => t.folder)]), [true, "", ["A"]]);
    // A rename checks only its own folder.
    assert.ok(await p.store.edit(x, "name", "丙"));
    assert.ok(await p.store.edit(y, "name", "丙"), "B may have its own 丙");
  }

  // Picker changes are one write and one U step; 2+ ask first; U puts them back, a later edit to another item stays,
  // a tag deleted since stays gone.
  {
    const p = page();
    const [g, s] = [await p.store.createTag("g"), await p.store.createTag("s")];
    p.map = { b: [g.id] };
    assert.strictEqual(await p.store.change([{ key: "a", add: [s.id], remove: [] }, { key: "b", add: [], remove: [g.id] }]), 2);
    assert.deepStrictEqual(plain(p.map), { a: [s.id] }, "an item left with none drops out");
    assert.strictEqual(await p.store.change([{ key: "a", add: [s.id], remove: [] }]), 0, "no change, no step");
    p.map = { ...p.map, c: [g.id] }; // another item edited later
    // The store's own stack (摘读记录's; the others pass the page's): U asks for 2, then puts both back.
    await p.store.undo();
    assert.deepStrictEqual([p.asked.at(-1)[0], plain(p.map), p.said.at(-1)[0]], ["撤销批量改标签？", { b: [g.id], c: [g.id] }, "已撤销：2 个视频的标签修改"]);
    await p.store.untag("b", g.id);
    assert.deepStrictEqual([plain(p.map), p.said.at(-1)[0]], [{ c: [g.id] }, UI.untagged("g")]);
    await p.store.undo();
    assert.deepStrictEqual([plain(p.map.b), p.said.at(-1)[0]], [[g.id], "已撤销：去掉「g」"]);
  }

  // Delete: asks with every carrier, the ones only uses() knows too (关注's 已取消关注); takes it off all, drops tag steps.
  {
    const steps = [];
    const p = page({ uses: () => 2, steps: { push: (x) => steps.push(x), drop: (pred) => steps.splice(0, steps.length, ...steps.filter((x) => !pred(x))) } });
    const t = await p.store.createTag("t");
    await p.store.change([{ key: "a", add: [t.id], remove: [] }]);
    steps.push({ keep: true });
    assert.ok(await p.store.remove(t));
    assert.deepStrictEqual([p.asked.at(-1)[1], plain(p.map), p.tags.length, steps.length, p.gone], ["<p>将从 3 个视频上去掉这个标签，无法撤销。</p>", {}, 0, 1, [t.id]]);
  }

  // The AI's room and why it has none (K6): the setting's 0 says 「新建上限是 0」 on every page; a full scope its own words.
  {
    const p = page({ newTagMax: () => 0 });
    assert.deepStrictEqual([p.store.room(), p.store.noRoom()], [0, "新建上限是 0"]);
    const q = page();
    assert.strictEqual(q.store.room(), 3, "min(newTagMax 5, cap 3 - 0)");
    for (const n of ["1", "2", "3"]) await q.store.createTag(n);
    assert.deepStrictEqual([q.store.room(), q.store.noRoom()], [0, "名额已满"]);
    assert.strictEqual(UI.aiRoomHint({ tags: [{ id: "x" }], excluded: new Set(), room: 0, full: p.store.noRoom() }), "新建上限是 0，AI 只会用已有标签。");
  }

  // 应用 past the cap. keepOverCap (收藏夹, 关注): every ticked new tag is made. Hard limit (摘读记录): made in order while
  // there is room, the rest named up front (notMade) and said after.
  {
    const p = page();
    await p.store.createTag("旧");
    const prop = proposal(["n1", "n2", "n3"], [{ id: "a", add: ["new:n1", "new:n2", "new:n3"], remove: [] }, { id: "gone", add: ["new:n1"], remove: [] }]);
    assert.strictEqual(p.store.notMade, undefined);
    assert.ok(await p.store.apply(prop));
    assert.deepStrictEqual([p.tags.length, p.map.a.length, "gone" in p.map, p.proposal, plain(p.recent.keys)], [4, 3, false, null, ["a"]]);
    assert.strictEqual(p.said.at(-1)[0], `已应用 AI 建议：1 个视频，列表只显示这些${UI.UNDO}`);
    // U: the item back, the tags it made deleted, 「AI 刚打的」 ended.
    await p.store.undo();
    assert.deepStrictEqual(plain([p.tags.map((t) => t.name), p.map, p.recent]), [["旧"], {}, null]);

    const h = page({ keepOverCap: false, who: "记录" });
    await h.store.createTag("旧");
    const hp = proposal(["n1", "n2", "n3"], [{ id: "a", add: ["new:n1", "new:n3"], remove: [] }]);
    assert.deepStrictEqual(plain([...h.store.notMade(hp).keys]), ["n3"]);
    assert.strictEqual(h.store.notMade(hp).why, "这里的标签最多 3 个");
    await h.store.apply(hp);
    assert.deepStrictEqual(plain([h.tags.map((t) => t.name), h.map.a.length]), [["旧", "n1", "n2"], 1]);
    assert.ok(h.said.at(-1)[0].endsWith("；1 个新标签没有建：已经有 3 个"), h.said.at(-1)[0]);
  }

  // F61: 应用 whose write fails keeps the proposal, says so in red and pushes no step; nothing else changes.
  {
    const p = page();
    const prop = proposal(["n1"], [{ id: "a", add: ["new:n1"], remove: [] }]);
    p.proposal = prop;
    p.saveOk = false;
    assert.strictEqual(await p.store.apply(prop), false);
    assert.deepStrictEqual([p.proposal, p.tags.length, plain(p.map), p.recent, p.said.at(-1)], [prop, 0, {}, null, [UI.AI_APPLY_FAILED, true]]);
    await p.store.undo();
    assert.strictEqual(p.said.at(-1)[0], ctx.MdgErrors.TEXT.noUndo, "no step");
  }

  // 关注's backend: a change applies to what storage holds now, under the lock the background takes too; neither loses
  // the other's. A failed write is false, the proposal stays (F61 in 关注).
  {
    const bg = load(["../common.js", "../errors.js", "../limits.js"]).MdgLimits;
    Object.assign(store, { follow_tag_map: { b: ["t9"] }, follow_tags: [{ id: "t9", name: "旧" }] });
    const D = { tags: [], map: {} };
    let wrote = 0;
    const p = page({ ...TS.follow({ get: () => D, put: (part) => Object.assign(D, part), set: async (o) => (await chrome.storage.local.set(o).then(() => true, () => false)) && ++wrote > 0 }), who: "UP 主", make: (name, tags) => ctx.MdgTagCore.newUpTag(name, tags), restorable: (m) => m !== "u", goneWord: "已取消关注" });
    await Promise.all([
      p.store.change([{ key: "a", add: ["t9"], remove: [] }]),
      bg.updateFollow(["tag_map"], (s) => ({ tag_map: { ...s.tag_map, z: ["t9"] } })),
      p.store.change([{ key: "u", add: ["t9"], remove: [] }])
    ]);
    assert.deepStrictEqual(plain(store.follow_tag_map), { b: ["t9"], a: ["t9"], z: ["t9"], u: ["t9"] }, "neither write loses the other's or the background's");
    assert.deepStrictEqual(plain(D.map), plain(store.follow_tag_map), "the page holds what was written");
    // U skips an UP unfollowed since and says how many.
    await p.store.undo();
    assert.deepStrictEqual([plain(store.follow_tag_map.u), p.said.at(-1)[0]], [["t9"], "已撤销：标签修改（1 个已取消关注，标签没改）"]);
    const prop = proposal(["新"], [{ id: "a", add: ["new:新"], remove: [] }]);
    p.proposal = prop;
    failSet = true;
    assert.strictEqual(await p.store.apply(prop), false);
    failSet = false;
    assert.deepStrictEqual([p.proposal, store.follow_tags.length, p.said.at(-1)], [prop, 1, [UI.AI_APPLY_FAILED, true]]);
    assert.ok(await p.store.apply(prop));
    assert.deepStrictEqual(plain([p.proposal, store.follow_tags.map((t) => t.name), store.follow_tags[1].id.startsWith("ft")]), [null, ["旧", "新"], true]);
  }

  // 摘读记录's backend: the marks record, through the page's edit of records; a failed write is said by fail.
  {
    const KEY = ctx.MdgLimits.KEYS.readingMarks;
    store[KEY] = { tags: [], items: { r: { star: 1, tags: [], ref: { url: "x" } } } };
    let marks = store[KEY];
    const fails = [];
    const db = TS.marks({
      get: () => marks,
      put: (m) => (marks = m),
      edit: (m, keys, change) => ({ ...m, items: { ...m.items, ...Object.fromEntries(keys.map((k) => [k, change({ star: 0, tags: [], ...m.items[k] }, k)])) } }),
      fail: (e) => fails.push(e.message)
    });
    const p = page({ ...db, who: "记录", idPrefix: "rt" });
    const t = await p.store.createTag("读过");
    await p.store.change([{ key: "r", add: [t.id], remove: [] }]);
    assert.deepStrictEqual(plain(store[KEY].items.r), { star: 1, tags: [t.id], ref: { url: "x" } }, "the 星标 and address stay");
    assert.deepStrictEqual(plain(db.map()), { r: [t.id] });
    failSet = true;
    assert.strictEqual(await p.store.change([{ key: "r", add: [], remove: [t.id] }]), 0);
    failSet = false;
    assert.deepStrictEqual(fails, ["QUOTA_BYTES quota exceeded"]);
  }

  // The AI 打标签 run (K7: 摘读记录 runs this one too): a stop says what it kept in 收藏夹's words; a tag deleted
  // meanwhile drops the proposal.
  {
    const R = ctx.MdgRuns.create({});
    const p = page();
    const t = await p.store.createTag("甲");
    const run = (o) => p.store.runAi({ R, job: "ai", total: 2, request: () => ({}), merge: (q, data) => UI.mergeAiBatch(q, data, { tags: p.tags, map: p.map, maxNewTags: 5, scope: new Set(["a"]) }), intervalMs: 0, progress() {}, ...o });
    let r = await run({ send: async () => (R.stop("ai"), { ok: false, error: "格式不对" }) });
    assert.deepStrictEqual([r.proposal, r.errors.at(-1)], [null, "已手动停止，还没有批次完成"]);
    let n = 0;
    r = await run({ send: async () => (++n === 1 && R.stop("ai"), { ok: true, data: { assignments: { a: { add: ["甲"] } } } }) });
    assert.deepStrictEqual([r.proposal.rows.length, r.errors.at(-1)], [1, "已手动停止，这里只有已完成批次的建议"]);
    const progress = [];
    const merge = (q, data) => (UI.mergeAiBatch(q, data, { tags: p.tags, map: p.map, maxNewTags: 5, scope: new Set(["a"]) }), (p.tags = []));
    r = await run({ total: 1, merge, progress: (x) => progress.push(x), send: async () => ({ ok: true, data: { assignments: { a: { add: ["甲"] } } } }) });
    assert.deepStrictEqual([r.proposal, progress.at(-1)], [null, UI.AI_TAG_GONE], `${t.id} deleted during the run`);
  }

  console.log("tag-store selftest: all passed");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
