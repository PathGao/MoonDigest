// /usr/local/bin/node extension/triage/runs.selftest.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

for (const f of ["../errors.js", "../tag-core.js", "shared.js", "runs.js"]) vm.runInThisContext(fs.readFileSync(path.join(__dirname, f), "utf8"));
const { create } = globalThis.BocRuns;
const LIMIT = { ms: 90000, label: "B站限流卡住" };

// A runs table over a fake clock: sleep moves the clock 100 ms per turn and stops early once ok() is false.
function setup() {
  const log = [];
  let clock = 0;
  const runs = create({
    redraw: () => {},
    hold: (r) => (r.code === "THROTTLED" ? LIMIT : null),
    now: () => clock,
    async sleep(ms, ok = () => true) {
      log.push(["sleep", ms]);
      for (let left = ms; left > 0 && ok(); left -= 100) {
        await new Promise((r) => setImmediate(r));
        clock += Math.min(100, left);
      }
    }
  });
  return { runs, log, at: () => clock };
}
// Steps from a list; act answers from answers (or ok) and logs each send.
const steps = (list) => {
  let i = 0;
  return () => list[i++] || null;
};
const sender = (log, answers = []) => async (s) => (log.push(["send", s.id]), answers.shift() || { ok: true });
const until = async (cond) => {
  for (let i = 0; i < 10000 && !cond(); i++) await new Promise((r) => setImmediate(r));
  assert.ok(cond(), "timed out");
};
const line = (d, t, stopping) => `跑 ${d}/${t}${stopping ? " 停" : ""}`;

(async () => {
  // The gap goes only between two sends: none before the first or after the last; a step's own gap wins.
  {
    const { runs, log } = setup();
    const r = await runs.run("j", { total: 3, line, gap: 1000, next: steps([{ id: 1 }, { id: 2, gap: 300 }, { id: 3 }]), act: sender(log) });
    assert.deepStrictEqual(log, [["send", 1], ["sleep", 300], ["send", 2], ["sleep", 1000], ["send", 3]]);
    assert.deepStrictEqual(r, { done: 3, total: 3, stopped: false, error: "", code: "" });
  }

  // One run per job: a second call is refused with the running one's name and sends nothing; another job runs beside it.
  {
    const { runs, log } = setup();
    let open;
    const first = runs.run("j", { name: "批量取消收藏", total: 1, line, next: steps([{ id: 1 }]), act: () => new Promise((r) => (open = r)) });
    const refused = await runs.run("j", { total: 1, line, next: () => assert.fail("refused runs never ask"), act: sender(log) });
    assert.deepStrictEqual(refused, { done: 0, total: 0, stopped: false, error: "", code: "", busy: "批量取消收藏" });
    assert.strictEqual(runs.busy("j"), "批量取消收藏");
    assert.strictEqual((await runs.run("k", { total: 1, line, next: steps([{ id: 9 }]), act: sender(log) })).done, 1, "another job is not blocked");
    open({ ok: true });
    await first;
    assert.deepStrictEqual([runs.busy("j"), log], ["", [["send", 9]]]);
  }

  // The judge's five answers. ok and item count n and call done; retry sends the same step at once; wait counts down,
  // then sends the same step (next is not asked again); stop ends with the reply's error and code, done not called.
  {
    const { runs, log } = setup();
    const answers = [{ ok: true }, { ok: false, v: "item", error: "这条坏了" }, { ok: false, v: "retry" }, { ok: true }, { ok: false, code: "THROTTLED" }, { ok: true }, { ok: false, v: "stop", error: "Key 不对", code: "AI_AUTH" }];
    const done = [];
    let asked = 0;
    const r = await runs.run("j", {
      total: 9,
      line,
      next: () => (asked++, { id: asked, n: 2 }),
      act: sender(log, answers),
      judge: (x) => x.v || (runs.hold(x) ? "wait" : "ok"),
      done: (s, x) => done.push([s.id, x.ok])
    });
    assert.deepStrictEqual(log.filter(([k]) => k === "send").map(([, id]) => id), [1, 2, 3, 3, 4, 4, 5]);
    assert.deepStrictEqual(done, [[1, true], [2, false], [3, true], [4, true]]);
    assert.deepStrictEqual(r, { done: 8, total: 9, stopped: false, error: "Key 不对", code: "AI_AUTH" });
    assert.strictEqual(asked, 5, "a retry and a wait resend the step they hold");
  }

  // The default judge: a limit waits, any other failure stops.
  {
    const { runs, log } = setup();
    const r = await runs.run("j", { total: 2, line, next: steps([{ id: 1 }, { id: 2 }]), act: sender(log, [{ ok: false, code: "THROTTLED" }, { ok: true }, { ok: false, error: "网络错误" }]) });
    assert.deepStrictEqual(r, { done: 1, total: 2, stopped: false, error: "网络错误", code: "" });
  }

  // A countdown keeps the run's line, count and bar: 「‹line› · B站限流卡住，1:30 后重试」, amber, ticking down.
  {
    const { runs, log } = setup();
    const answers = [{ ok: true }, { ok: false, code: "THROTTLED" }];
    const p = runs.run("j", { total: 2, line, next: steps([{ id: 1 }, { id: 2 }]), act: sender(log, answers) });
    await until(() => runs.get("j")?.wait);
    assert.deepStrictEqual(runs.pill(["j"]), { text: "跑 1/2 · B站限流卡住，1:30 后重试", done: 1, total: 2, stopping: false, job: "j", stuck: true });
    await until(() => runs.get("j")?.wait === "B站限流卡住，1:29 后重试");
    assert.strictEqual(runs.pill(["j"]).text, "跑 1/2 · B站限流卡住，1:29 后重试");
    await p;
    assert.deepStrictEqual(log.filter(([k]) => k === "send").map(([, id]) => id), [1, 2, 2]);
  }

  // stop() ends a gap at once, and a countdown at once; neither sends again. A request in flight lands and counts.
  {
    const { runs, log, at } = setup();
    const p = runs.run("j", { total: 2, line, gap: 60000, next: steps([{ id: 1 }, { id: 2 }]), act: sender(log) });
    await until(() => log.some(([k]) => k === "sleep"));
    runs.stop("j");
    assert.strictEqual(runs.pill(["j"]).text, "跑 1/2 停", "the line knows it is stopping");
    assert.deepStrictEqual(await p, { done: 1, total: 2, stopped: true, error: "", code: "" });
    assert.ok(at() < 1000 && !log.some(([k, id]) => k === "send" && id === 2), "the gap ended at once");
  }
  {
    const { runs, log, at } = setup();
    const p = runs.run("j", { total: 1, line, next: steps([{ id: 1 }]), act: sender(log, [{ ok: false, code: "THROTTLED" }]) });
    await until(() => runs.get("j")?.wait);
    runs.stop("j");
    assert.deepStrictEqual(await p, { done: 0, total: 1, stopped: true, error: "", code: "" });
    assert.ok(at() < 1000 && log.filter(([k]) => k === "send").length === 1, "the countdown ended at once, nothing resent");
  }
  {
    const { runs } = setup();
    let open;
    const p = runs.run("j", { total: 2, line, next: steps([{ id: 1 }, { id: 2 }]), act: () => new Promise((r) => (open = r)) });
    await until(() => open);
    runs.stop("j");
    open({ ok: true });
    assert.deepStrictEqual(await p, { done: 1, total: 2, stopped: true, error: "", code: "" });
  }
  // alive() turning false does the same as stop().
  {
    const { runs, log, at } = setup();
    let alive = true;
    const p = runs.run("j", { total: 2, line, gap: 60000, alive: () => alive, next: steps([{ id: 1 }, { id: 2 }]), act: sender(log) });
    await until(() => log.some(([k]) => k === "sleep"));
    alive = false;
    assert.strictEqual((await p).stopped, true);
    assert.ok(at() < 1000);
  }

  // { idle } sleeps without a send, a count or a gap; plan runs once the job is taken and may end it before any request.
  {
    const { runs, log } = setup();
    const r = await runs.run("j", { total: 1, line, gap: 500, next: steps([{ idle: 1000 }, { id: 1 }]), act: sender(log) });
    assert.deepStrictEqual([log, r.done], [[["sleep", 1000], ["send", 1]], 1]);
    let busyInPlan = "";
    const none = await runs.run("p", { name: "移动", line, plan: async () => ((busyInPlan = runs.busy("p")), null), next: () => assert.fail(), act: () => assert.fail() });
    assert.deepStrictEqual([none.done, busyInPlan, runs.busy("p")], [0, "移动", ""]);
    const planned = await runs.run("p", { line, plan: async () => ({ total: 2, next: steps([{ id: 7, n: 2 }]) }), act: sender(log) });
    assert.deepStrictEqual([planned.done, planned.total], [2, 2]);
  }

  // An exception in done() comes out of run, and the job is free again.
  {
    const { runs, log } = setup();
    await assert.rejects(runs.run("j", { total: 1, line, next: steps([{ id: 1 }]), act: sender(log), done: () => { throw new Error("坏了"); } }), /坏了/);
    assert.strictEqual(runs.busy("j"), "");
    assert.strictEqual((await runs.run("j", { total: 1, line, next: steps([{ id: 2 }]), act: sender(log) })).done, 1);
  }

  // The pill: the first job in order that runs or has a row; finished lines only after every row, in order, each until
  // its job starts again. A put row with a wait reads like a run's; a past wait adds nothing.
  {
    const { runs, log, at } = setup();
    await runs.run("a", { total: 2, line, next: steps([{ id: 1 }, { id: 2 }]), act: sender(log), finished: (d) => `a 完成 ${d} 个` });
    await runs.run("b", { total: 1, line, next: steps([]), act: sender(log), finished: () => "" });
    assert.deepStrictEqual(runs.pill(["a", "b"]), { job: "a", text: "a 完成 2 个", finished: true });
    let syncing = true;
    runs.put("sync", () => syncing && { text: "刷新中…" });
    runs.put("seen", { text: "观看进度", wait: { until: at() + 61000, label: "B站限流卡住" } });
    assert.deepStrictEqual(runs.pill(["a", "sync", "seen"]), { text: "刷新中…", job: "sync" }, "a row before any finished line");
    syncing = false;
    assert.deepStrictEqual(runs.pill(["sync", "seen", "a"]), { text: "观看进度 · B站限流卡住，1:01 后重试", job: "seen", stuck: true });
    runs.put("seen", { text: "观看进度", wait: { until: at() - 1, label: "B站限流卡住" }, slowed: true });
    assert.deepStrictEqual(runs.pill(["seen"]), { text: "观看进度", slowed: true, job: "seen" }, "a past wait is over");
    runs.put("seen", null);
    let open;
    const again = runs.run("a", { total: 1, line, next: steps([{ id: 3 }]), act: () => new Promise((r) => (open = r)) });
    await until(() => open);
    assert.deepStrictEqual(runs.pill(["b", "a"]), { text: "跑 0/1", done: 0, total: 1, stopping: false, job: "a" }, "running again: no old line");
    open({ ok: true });
    await again;
    assert.strictEqual(runs.pill(["a"]), null, "this run left no line");
  }

  // wait() on its own: the countdown shows on the job's row and ends early once alive() is false.
  {
    const { runs, at } = setup();
    let alive = true;
    runs.put("load", { text: "加载收藏夹 1/3", done: 1, total: 3 });
    const p = runs.wait("load", LIMIT, () => alive);
    await until(() => at() >= 1000);
    assert.deepStrictEqual(runs.pill(["load"]), { text: "加载收藏夹 1/3 · B站限流卡住，1:29 后重试", done: 1, total: 3, job: "load", stuck: true });
    alive = false;
    await p;
    assert.ok(at() < 2000 && runs.get("load") === null);
  }

  console.log("runs selftest: all passed");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
