// /usr/local/bin/node extension/triage/writes.selftest.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

vm.runInThisContext(fs.readFileSync(path.join(__dirname, "writes.js"), "utf8"));
const { create } = globalThis.BocWrites;

// A writer over a fake Bilibili: answer(msg) gives each reply (may return a promise); the log records what happened.
function setup(answer = () => ({ ok: true })) {
  const log = [];
  let clock = 1000;
  const w = create({
    send: (msg) => (log.push(["send", msg.id]), answer(msg)),
    limited: (r) => r.code === "THROTTLED",
    hold: async (job) => log.push(["hold", job]),
    sleep: async (ms) => log.push(["sleep", ms]),
    now: () => clock,
    settleMs: 3000
  });
  return { w, log, tick: (ms) => (clock += ms), at: () => clock };
}
const chunk = (id, keys, folders = ["F"], gap = 0) => ({ msg: { id }, keys, folders, gap });
const gate = () => {
  let open;
  return [new Promise((r) => (open = r)), () => open({ ok: true })];
};

(async () => {
  // Chunks go in order with each one's gap before it (none before the first); onChunk follows each success.
  {
    const { w, log } = setup();
    const r = await w.run("unfav", "批量取消收藏", {
      verb: "取消收藏",
      chunks: [chunk(1, ["a", "b"], ["F"], 1000), chunk(2, ["c"], ["F"], 1000), chunk(3, ["d"], ["T"], 300)],
      onChunk: (c) => log.push(["chunk", c.msg.id])
    });
    assert.deepStrictEqual(r, { done: 4, total: 4, error: "" });
    assert.deepStrictEqual(log, [["send", 1], ["chunk", 1], ["sleep", 1000], ["send", 2], ["chunk", 2], ["sleep", 300], ["send", 3], ["chunk", 3]]);
    assert.strictEqual(w.busy(), "", "free after it finishes");
  }

  // One batch at a time: a second is refused with the running one's name and sends nothing. Keys are pending from the
  // start, each until its chunk goes through; progress counts done keys and names the current chunk's folders.
  {
    const [first, open] = gate();
    const [second, open2] = gate();
    const { w, log } = setup((m) => (m.id === 1 ? first : m.id === 2 ? second : { ok: true }));
    const running = w.run("refav", "重新收藏", { verb: "重新收藏", chunks: [chunk(1, ["a"], ["F"]), chunk(2, ["b"], ["G"])], folders: ["all"], meta: { mediaId: "all" } });
    assert.strictEqual(w.busy(), "重新收藏");
    assert.deepStrictEqual([w.pending("a"), w.pending("b"), w.pending("z")], ["重新收藏", "重新收藏", ""]);
    assert.deepStrictEqual(w.progress(), { job: "refav", name: "重新收藏", done: 0, total: 2, folders: ["F"], meta: { mediaId: "all" } });
    const refused = await w.run("unfav", "批量取消收藏", { verb: "取消收藏", chunks: [chunk(9, ["x"])] });
    assert.deepStrictEqual(refused, { done: 0, total: 0, error: "", busy: "重新收藏" });
    assert.ok(!log.some(([, id]) => id === 9), "the refused batch sent nothing");
    open();
    await new Promise((r) => setImmediate(r));
    assert.deepStrictEqual([w.pending("a"), w.pending("b"), w.progress().done, [...w.progress().folders]], ["", "重新收藏", 1, ["G"]]);
    open2();
    await running;
    assert.deepStrictEqual([w.busy(), w.pending("b"), w.progress()], ["", "", null]);
  }

  // A limit holds, then the same chunk goes again; the batch never stops for one.
  {
    let limits = 2;
    const { w, log } = setup((m) => (m.id === 1 && limits-- > 0 ? { ok: false, code: "THROTTLED", error: "412" } : { ok: true }));
    const r = await w.run("transfer", "移动/复制", { verb: "移动", chunks: [chunk(1, ["a"]), chunk(2, ["b"], ["F"], 1000)] });
    assert.deepStrictEqual(r, { done: 2, total: 2, error: "" });
    assert.deepStrictEqual(log, [["send", 1], ["hold", "transfer"], ["send", 1], ["hold", "transfer"], ["send", 1], ["sleep", 1000], ["send", 2]]);
  }

  // Any other failure stops at that chunk: done counts what went through, the rest is no longer pending, the slot is free.
  {
    const { w, log } = setup((m) => (m.id === 2 ? { ok: false, error: "网络错误" } : { ok: true }));
    const r = await w.run("unfav", "批量取消收藏", { verb: "取消收藏", chunks: [chunk(1, ["a", "b"]), chunk(2, ["c"]), chunk(3, ["d"])] });
    assert.deepStrictEqual(r, { done: 2, total: 4, error: "网络错误" });
    assert.ok(!log.some(([, id]) => id === 3));
    assert.deepStrictEqual([w.busy(), w.pending("c"), w.pending("d")], ["", "", ""]);
  }

  // A plan given as a function runs once the slot is taken; null ends the batch without a request.
  {
    const { w, log } = setup();
    let busyInPlan = "";
    const r = await w.run("transfer", "移动/复制", async () => ((busyInPlan = w.busy()), null));
    assert.deepStrictEqual([r, busyInPlan, w.busy(), log.length], [{ done: 0, total: 0, error: "" }, "移动/复制", "", 0]);
  }

  // Settle: a folder counts as written while the batch names it or writes it now, and for settleMs after the last
  // request that reached it; since also catches a write at or after it.
  {
    const [first, open] = gate();
    const { w, tick, at } = setup((m) => (m.id === 1 ? first : { ok: true }));
    const running = w.run("transfer", "移动/复制", { verb: "移动", chunks: [chunk(1, ["a"], ["S", "T"])], folders: ["S"] });
    assert.ok(w.writing("S") && w.writing("T") && !w.writing("U"));
    open();
    await running;
    assert.ok(w.writing("T"), "settling");
    const since = at();
    tick(3000);
    assert.ok(!w.writing("T"), "settled");
    assert.ok(w.writing("T", since) && !w.writing("T", since + 1), "a read started before the write is stale");
  }

  // single: no slot (it runs beside a batch), stops at the first failure; a limit fails at once but its folder counts as
  // written, since B站 may have taken it; a plain failure marks nothing.
  {
    const [first, open] = gate();
    const { w, log } = setup((m) => (m.id === 1 ? first : m.id === 3 ? { ok: false, code: "THROTTLED", error: "412" } : m.id === 5 ? { ok: false, error: "x" } : { ok: true }));
    const running = w.run("unfav", "批量取消收藏", { verb: "取消收藏", chunks: [chunk(1, ["a"], ["B"])] });
    const done = [];
    const one = await w.single("取消收藏", [chunk(2, ["k"], ["P"]), chunk(3, ["k"], ["Q"]), chunk(4, ["k"], ["R"])], (c) => done.push(c.msg.id));
    assert.deepStrictEqual([one, done], [{ done: 1, error: "412", limited: true }, [2]]);
    assert.ok(w.writing("P") && w.writing("Q") && !w.writing("R"));
    assert.ok(!log.some(([k]) => k === "hold"), "a single write never holds");
    assert.deepStrictEqual([w.pending("k"), w.pending("a")], ["", "取消收藏"]);
    assert.deepStrictEqual(await w.single("取消收藏", [chunk(5, ["m"], ["V"])]), { done: 0, error: "x" });
    assert.ok(!w.writing("V"));
    open();
    await running;
  }

  console.log("writes selftest: all passed");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
