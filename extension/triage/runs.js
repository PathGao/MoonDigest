// Long tasks of the 分拣台 (MdgRuns.create), one instance per mode. Every loop that sends one request at a time (粗看,
// 细看, AI 打标签, 逐个视频笔记, 核对, B站 writes) is a run here, and the progress pill is drawn from one table.
// - run(job, o): one per job at a time (a second is refused with { busy: the running one's name }, nothing sent).
//   o.next() gives a step { n = keys.length or 1, gap?, ... } or null (finished) or { idle: ms } (sleep, nothing sent); o.act(step) sends
//   it; o.judge(r, hold) says ok | item (this step failed, go on) | retry (send it again now) | wait (count down hold(r), then
//   send the same step again) | stop. Default: hold(r) ? wait : r.ok ? ok : stop. o.done(step, r) after ok and item;
//   the count is the sum of their n (failed: the item steps' part of it). The gap (step.gap ?? o.gap ?? gap) only between two sends. stop(job) and o.alive()
//   turning false end it at once, in a gap or a countdown; a request in flight still lands and counts. o.plan() (async)
//   runs once the job is taken and may add total / next / act / line, or return null to end without a request.
//   o.line(done, total, stopping) is its pill text; o.finished(done - failed) its line after it ends (green), until it starts again;
//   the newest one shows;
//   o.tick() runs each second of its countdowns.
// - wait(job, hold, alive): a countdown on its own (a loop with its own flow). put(job, row | () => row): a row mirrored
//   from elsewhere ({ text, done, total, wait: { until, label }, slowed }).
// - pill(order): the first job in order that runs, waits or has a row, else the newest finished line. A wait always
//   reads 「‹its line› · B站限流卡住，m:ss 后重试」, keeping the bar.
// triage.html and history.html (摘读记录's AI 打标签) load this classic script after shared.js; runs.selftest.js tests it in node.
(() => {
  // Waits ms in short naps, returning early once ok() turns false.
  async function nap(ms, ok = () => true) {
    const end = Date.now() + ms;
    while (Date.now() < end && ok()) await new Promise((r) => setTimeout(r, Math.min(200, end - Date.now())));
  }

  function create({ redraw = () => {}, hold = () => null, gap = 0, now = Date.now, sleep = nap }) {
    const runs = new Map(); // job → { name, line, done, total, stopping }
    const waits = new Map(); // job → { until, label }
    const rows = new Map(); // job → put row
    const ended = new Map(); // job → () => its finished line

    // tick() after each second's redraw, for a countdown drawn elsewhere too (the AI 打标签 dialog).
    async function wait(job, h, alive = () => true, tick = () => {}) {
      waits.set(job, { until: now() + h.ms, label: h.label });
      redraw();
      tick();
      try {
        for (let left = h.ms; left > 0 && alive(); left -= 1000) {
          await sleep(Math.min(1000, left), alive);
          redraw();
          tick();
        }
      } finally {
        waits.delete(job);
      }
      redraw();
    }

    async function run(job, o) {
      if (runs.has(job)) return { done: 0, total: 0, stopped: false, error: "", code: "", busy: runs.get(job).name };
      const r = { name: o.name || job, line: o.line, done: 0, failed: 0, total: o.total || 0, stopping: false };
      runs.set(job, r);
      ended.delete(job);
      const alive = () => !r.stopping && (!o.alive || o.alive());
      let error = "";
      let code = "";
      let finished = false;
      try {
        if (o.plan) {
          const more = await o.plan();
          if (!more) return { done: 0, total: 0, stopped: false, error, code };
          o = { ...o, ...more };
          Object.assign(r, { total: o.total || 0, line: o.line });
        }
        const judge = o.judge || ((x) => (hold(x) ? "wait" : x.ok ? "ok" : "stop"));
        let sent = false;
        redraw();
        while (alive()) {
          const step = await o.next();
          if (!step) {
            finished = true;
            break;
          }
          if (step.idle) {
            await sleep(step.idle, alive);
            continue;
          }
          const g = step.gap ?? o.gap ?? gap;
          if (sent && g) await sleep(g, alive);
          if (!alive()) break;
          let x, v;
          for (;;) {
            x = await o.act(step);
            sent = true;
            v = judge(x, hold);
            if (v === "wait") await wait(job, hold(x), alive, o.tick);
            if ((v !== "retry" && v !== "wait") || !alive()) break;
          }
          if (v === "stop") {
            // Never without words: that would read as the user's 停止 (stopped is "no error").
            error = MdgErrors.text(x);
            code = x.code || "";
            break;
          }
          if (v !== "ok" && v !== "item") break; // a retry or wait cut short
          const n = step.n ?? step.keys?.length ?? 1;
          r.done += n;
          if (v === "item") r.failed += n;
          await o.done?.(step, x);
          redraw();
        }
      } finally {
        runs.delete(job);
        if (o.finished) ended.set(job, () => o.finished(r.done - r.failed));
        redraw();
      }
      return { done: r.done, failed: r.failed, total: r.total, stopped: !finished && !error, error, code };
    }

    function waitText(w) {
      const sec = w ? Math.ceil((w.until - now()) / 1000) : 0;
      return sec > 0 ? TriageUi.waitText(w.label, sec) : "";
    }
    function rowOf(job) {
      const r = runs.get(job);
      const put = rows.get(job);
      const row = r?.line ? { text: r.line(r.done, r.total, r.stopping), done: r.done, total: r.total, stopping: r.stopping } : typeof put === "function" ? put() : put;
      if (!row) return null;
      const { wait: w, ...rest } = row;
      const left = waitText(waits.get(job) || w);
      return left ? { ...rest, job, text: `${row.text} · ${left}`, wait: left, stuck: true } : { ...rest, job };
    }

    return {
      run,
      wait,
      hold,
      stop(job) {
        const r = runs.get(job);
        if (r) r.stopping = true;
        redraw();
      },
      // The running job's { done, total, stopping, wait } (wait: its countdown's text, ""); a wait alone gives only wait.
      get(job) {
        const r = runs.get(job);
        const w = waitText(waits.get(job));
        return r ? { done: r.done, total: r.total, stopping: r.stopping, wait: w } : w ? { done: 0, total: 0, stopping: false, wait: w } : null;
      },
      // The running job's name, "" when none.
      busy: (job) => runs.get(job)?.name || "",
      put(job, row) {
        if (row) rows.set(job, row);
        else rows.delete(job);
      },
      pill(order) {
        for (const job of order) {
          const row = rowOf(job);
          if (row) return row;
        }
        // The newest finished line: a 粗看 that just ended is not hidden behind an older 细看's.
        for (const job of [...ended.keys()].reverse()) {
          const text = order.includes(job) && ended.get(job)();
          if (text) return { job, text, finished: true };
        }
        return null;
      }
    };
  }
  // An AI 429's wait (hold), for every page that runs AI batches.
  const AI_HOLD = { ms: 60 * 1000, label: "AI 平台限流卡住" };
  // AI errors after which every later request fails alike: the AI_ codes MdgErrors.CODES sends to 去设置 (the side panel
  // offers 去设置 on the same list), plus AI_ACCESS (未授权访问; the banner offers the grant). 粗看, 细看 and AI 打标签 stop at
  // the first one. AI_TIMEOUT sends the
  // same request again and ends the run after AI_TIMEOUT_TRIES in a row; AI_THROTTLED waits, AI_THROTTLE_WAITS times in a
  // row at most, then ends the run as AI_GAVE_UP.
  const aiSettingsCode = (code) => String(code || "").startsWith("AI_") && MdgErrors.action(code) === "settings";
  const aiEnds = (r) => aiSettingsCode(r.code) || MdgErrors.action(r.code) === "grant";
  const AI_TIMEOUT_TRIES = 2;
  const AI_THROTTLE_WAITS = 5;
  const aiGaveUp = () => ({ ok: false, code: "AI_GAVE_UP", error: `AI 平台持续限流，已等待重试 ${AI_THROTTLE_WAITS} 次，已停止` });
  // A run's judge of AI answers, by the rule above, with its own counts in a row; any other error fails only this
  // request (a video in 细看, a batch in 粗看). "ok"; "retry" (the same request at once); "wait" (the run's hold(r), then
  // the same request); "stop" (r is then AI_GAVE_UP after too many waits); "item" (only this request failed).
  function aiJudge() {
    const n = { timeouts: 0, waits: 0 };
    return (r, hold) => {
      if (!r.ok && r.code === "AI_TIMEOUT" && ++n.timeouts < AI_TIMEOUT_TRIES) return "retry";
      if (!r.ok && r.code === "AI_THROTTLED" && n.waits++ === AI_THROTTLE_WAITS) Object.assign(r, aiGaveUp());
      if (!r.ok && hold(r)) return "wait";
      if (!r.ok && aiEnds(r)) return "stop";
      n.timeouts = n.waits = 0;
      return r.ok ? "ok" : "item";
    };
  }

  globalThis.MdgRuns = { create, sleep: nap, AI_HOLD, aiSettingsCode, aiEnds, aiJudge };
})();
