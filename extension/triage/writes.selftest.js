// /usr/local/bin/node extension/triage/writes.selftest.js
// The loop itself (gaps, limits, stop, the count) is runs.js's, tested in runs.selftest.js; here only the write rules.
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

for (const f of ["../errors.js", "../tag-core.js", "../settings.js", "shared.js", "runs.js", "writes.js"]) vm.runInThisContext(fs.readFileSync(path.join(__dirname, f), "utf8"));

// Two writers on one runs table (as 收藏夹 and 关注 on theirs), over a fake Bilibili: answer(msg) gives each reply (may
// return a promise). Sleeps take no time.
function setup(answer = () => ({ ok: true })) {
  const log = [];
  let clock = 1000;
  const runs = globalThis.MdgRuns.create({ hold: (r) => (r.code === "THROTTLED" ? { ms: 2000, label: "B站限流卡住" } : null), now: () => clock, sleep: async () => {} });
  const make = (lane) => globalThis.MdgWrites.create({ runs, lane, send: (msg) => (log.push(["send", msg.id]), answer(msg)), line: (p) => `${p.name} ${p.done}/${p.total}`, now: () => clock, settleMs: 3000 });
  return { w: make("fav"), w2: make("follow-write"), runs, log, tick: (ms) => (clock += ms), at: () => clock };
}
const chunk = (id, keys, folders = ["F"], gap = 0) => ({ msg: { id }, keys, folders, gap });
const gate = () => {
  let open;
  return [new Promise((r) => (open = r)), () => open({ ok: true })];
};
const turn = () => new Promise((r) => setImmediate(r));

(async () => {
  // One batch per lane: a second is refused with the running one's name and sends nothing; another lane runs beside it.
  // Keys are pending from the start, each until its chunk goes through; progress and the pill count done keys.
  {
    const [first, open] = gate();
    const [second, open2] = gate();
    const { w, w2, runs, log } = setup((m) => (m.id === 1 ? first : m.id === 2 ? second : { ok: true }));
    const running = w.run("refav", "重新收藏", { verb: "重新收藏", chunks: [chunk(1, ["a"], ["F"]), chunk(2, ["b"], ["G"])], folders: ["all"], meta: { mediaId: "all" } });
    await turn();
    assert.strictEqual(w.busy(), "重新收藏");
    assert.deepStrictEqual([w.pending("a"), w.pending("b"), w.pending("z")], ["重新收藏", "重新收藏", ""]);
    assert.deepStrictEqual(w.progress(), { job: "refav", name: "重新收藏", done: 0, total: 2, folders: ["F"], meta: { mediaId: "all" } });
    const refused = await w.run("unfav", "批量取消收藏", { verb: "取消收藏", chunks: [chunk(9, ["x"])] });
    assert.deepStrictEqual(refused, { done: 0, total: 0, error: "", busy: "重新收藏" });
    assert.ok(!log.some(([, id]) => id === 9), "the refused batch sent nothing");
    assert.deepStrictEqual(await w2.run("follow-write", "取消关注", { verb: "取消关注", chunks: [chunk(8, ["m1"], [])] }), { done: 1, total: 1, error: "", stopped: false }, "关注's lane is its own");
    open();
    await turn();
    await turn();
    assert.deepStrictEqual([w.pending("a"), w.pending("b"), w.progress().done, [...w.progress().folders]], ["", "重新收藏", 1, ["G"]]);
    assert.strictEqual(runs.pill(["fav"]).text, "重新收藏 1/2");
    open2();
    await running;
    assert.deepStrictEqual([w.busy(), w.pending("b"), w.progress()], ["", "", null]);
  }

  // A failure stops at that chunk: done counts what went through, the rest is no longer pending, the lane is free.
  {
    const { w, log } = setup((m) => (m.id === 2 ? { ok: false, error: "网络错误" } : { ok: true }));
    const done = [];
    const r = await w.run("unfav", "批量取消收藏", { verb: "取消收藏", chunks: [chunk(1, ["a", "b"]), chunk(2, ["c"]), chunk(3, ["d"])], onChunk: (c) => done.push(c.msg.id) });
    assert.deepStrictEqual(r, { done: 2, total: 4, error: "网络错误", stopped: false });
    assert.deepStrictEqual([done, log.some(([, id]) => id === 3)], [[1], false]);
    assert.deepStrictEqual([w.busy(), w.pending("c"), w.pending("d")], ["", "", ""]);
  }

  // stop() ends a batch after the chunk in flight, which still counts; the rest is no longer pending.
  {
    const [first, open] = gate();
    const { w, log } = setup((m) => (m.id === 1 ? first : { ok: true }));
    const running = w.run("follow", "取消关注", { verb: "取消关注", chunks: [chunk(1, ["m1"], []), chunk(2, ["m2"], [])] });
    await turn();
    w.stop();
    open();
    assert.deepStrictEqual(await running, { done: 1, total: 2, error: "", stopped: true });
    assert.deepStrictEqual([log.length, w.pending("m2")], [1, ""]);
    // Pressed while the last chunk is in flight: nothing was left, so it is not stopped.
    const [last, openLast] = gate();
    const s2 = setup(() => last);
    const whole = s2.w.run("follow", "取消关注", { verb: "取消关注", chunks: [chunk(1, ["m1"], [])] });
    await turn();
    s2.w.stop();
    openLast();
    assert.deepStrictEqual(await whole, { done: 1, total: 1, error: "", stopped: false });
  }

  // A plan given as a function runs once the lane is taken; null ends the batch without a request.
  {
    const { w, log } = setup();
    let busyInPlan = "";
    const r = await w.run("transfer", "移动/复制", async () => ((busyInPlan = w.busy()), null));
    assert.deepStrictEqual([r, busyInPlan, w.busy(), log.length], [{ done: 0, total: 0, error: "", stopped: false }, "移动/复制", "", 0]);
  }

  // Settle: a folder counts as written while the batch names it or writes it now (a limit's countdown included), and for
  // settleMs after the last request that reached it; since also catches a write at or after it.
  {
    const [first, open] = gate();
    let limits = 1;
    const { w, tick, at } = setup((m) => (m.id === 1 && limits-- > 0 ? { ok: false, code: "THROTTLED" } : m.id === 1 ? first : { ok: true }));
    const running = w.run("transfer", "移动/复制", { verb: "移动", chunks: [chunk(1, ["a"], ["S", "T"])], folders: ["S"] });
    await turn();
    assert.ok(w.writing("S") && w.writing("T") && !w.writing("U"));
    open();
    await running;
    assert.ok(w.writing("T"), "settling");
    const since = at();
    tick(3000);
    assert.ok(!w.writing("T"), "settled");
    assert.ok(w.writing("T", since) && !w.writing("T", since + 1), "a read started before the write is stale");
  }

  // single: no lane (it runs beside a batch), stops at the first failure; a limit fails at once but its folder counts as
  // written, since B站 may have taken it; a plain failure marks nothing.
  {
    const [first, open] = gate();
    const { w, log } = setup((m) => (m.id === 1 ? first : m.id === 3 ? { ok: false, code: "THROTTLED", error: "412" } : m.id === 5 ? { ok: false, error: "x" } : { ok: true }));
    const running = w.run("unfav", "批量取消收藏", { verb: "取消收藏", chunks: [chunk(1, ["a"], ["B"])] });
    await turn();
    const done = [];
    const one = await w.single("取消收藏", [chunk(2, ["k"], ["P"]), chunk(3, ["k"], ["Q"]), chunk(4, ["k"], ["R"])], (c) => done.push(c.msg.id));
    assert.deepStrictEqual([one, done], [{ done: 1, error: "412", limited: true }, [2]]);
    assert.ok(w.writing("P") && w.writing("Q") && !w.writing("R"));
    assert.deepStrictEqual(log.filter(([, id]) => id === 3).length, 1, "a single write never waits and resends");
    assert.deepStrictEqual([w.pending("k"), w.pending("a")], ["", "取消收藏"]);
    assert.deepStrictEqual(await w.single("取消收藏", [chunk(5, ["m"], ["V"])]), { done: 0, error: "x" });
    assert.ok(!w.writing("V"));
    open();
    await running;
  }

  // A key in two chunks stays pending until its last chunk goes through.
  {
    const [first, open] = gate();
    const [second, open2] = gate();
    const { w } = setup((m) => (m.id === 1 ? first : m.id === 2 ? second : { ok: true }));
    const running = w.run("refav", "重新收藏", { verb: "重新收藏", chunks: [chunk(1, ["a", "k"]), chunk(2, ["k"])] });
    await turn();
    open();
    await turn();
    await turn();
    assert.deepStrictEqual([w.pending("a"), w.pending("k")], ["", "重新收藏"], "k still has chunk 2 to go");
    open2();
    await running;
    assert.strictEqual(w.pending("k"), "");
  }

  // A single write and a batch on the same key and verb: the one done first leaves the other's mark.
  {
    const [first, open] = gate();
    const { w } = setup((m) => (m.id === 1 ? first : { ok: true }));
    const running = w.run("unfav", "批量取消收藏", { verb: "取消收藏", chunks: [chunk(1, ["k"])] });
    await turn();
    await w.single("取消收藏", [chunk(2, ["k"])]);
    assert.strictEqual(w.pending("k"), "取消收藏", "the batch still writes k");
    open();
    await running;
    assert.strictEqual(w.pending("k"), "");
  }

  // plan or onChunk throwing: the batch ends with its message, no rejection, nothing left pending.
  {
    const { w } = setup();
    assert.deepStrictEqual(await w.run("move", "移动", async () => { throw new Error("建不了收藏夹"); }), { done: 0, total: 0, error: "建不了收藏夹" });
    const r = await w.run("unfav", "批量取消收藏", { verb: "取消收藏", chunks: [chunk(1, ["a"]), chunk(2, ["b"])], onChunk: () => { throw new Error("存不下"); } });
    assert.deepStrictEqual([r.error, r.done, w.pending("b"), w.busy()], ["存不下", 1, "", ""]);
  }

  console.log("writes selftest: all passed");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
