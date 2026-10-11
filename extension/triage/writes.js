// Writes that change Bilibili, for a page that sends them (MdgWrites.create). It knows nothing of the page: the request
// (send) and the pill line (line) come in, and the batch runs as job lane on runs (runs.js: one batch per lane, the gap,
// a limit counting down and sending the same chunk again, stop). Two adapters each have their own lane and undo stack:
// 收藏夹 (keys are bvids) and 关注 (keys are mids).
// - run: a batch, chunk by chunk with each chunk's gap before it; any failure other than a limit stops it. onChunk(chunk)
//   runs after each chunk that went through. plan may be a function, called once the lane is taken (work that must not
//   race another batch, such as creating the target). stop() ends it after the chunk in flight (stopped: some were
//   left).
// - single: a write that does not wait for the batch (one key press). A limit fails at once.
// - Every key of a running batch (until its chunk goes through) and of a single write is pending, with its verb.
// - A folder is being written while the batch names it (folders) or is on its current chunk, and for settleMs after a
//   request reached it, a limited one included: the lists trail a write, and a paged read across changes shifts.
// triage.html loads this classic script after runs.js; writes.selftest.js tests it in node.
(() => {
  // chunk: { msg, keys, folders, gap? } (other fields ride along for onChunk). line(progress()) is the pill's text.
  function create({ runs, lane, send, line, now = Date.now, settleMs = 3000 }) {
    let batch = null; // { job, name, chunk, folders, meta }
    const pending = new Map(); // key → verb
    const lastWrite = new Map(); // folder → when a request last reached it
    const mark = (folders = []) => folders.forEach((f) => lastWrite.set(String(f), now()));
    const release = (keys, verb) => keys.forEach((k) => pending.get(k) === verb && pending.delete(k));
    const limited = (r) => Boolean(runs.hold(r));

    async function run(job, name, plan) {
      let p = null;
      let took = false;
      try {
        const r = await runs.run(lane, {
          name,
          async plan() {
            took = true;
            batch = { job, name, chunk: null, folders: [], meta: {} };
            p = typeof plan === "function" ? await plan() : plan;
            if (!p) return null;
            const { verb, chunks, folders = [], meta = {}, onChunk } = p;
            Object.assign(batch, { folders: folders.map(String), meta });
            for (const c of chunks) for (const k of c.keys) pending.set(k, verb);
            let i = 0;
            return {
              total: chunks.reduce((n, c) => n + c.keys.length, 0),
              line: () => line(progress()),
              next: () => (i < chunks.length ? (batch.chunk = chunks[i++]) : null),
              act: (c) => send(c.msg),
              async done(c) {
                mark(c.folders);
                release(c.keys, verb);
                await onChunk?.(c);
              }
            };
          }
        });
        if (r.busy) return { done: 0, total: 0, error: "", busy: r.busy };
        // Stopped while its last chunk was in flight, the batch is whole: not stopped.
        return { done: r.done, total: r.total, error: r.error, stopped: r.stopped && r.done < r.total };
      } finally {
        if (took) {
          if (p) for (const c of p.chunks) release(c.keys, p.verb);
          batch = null;
        }
      }
    }

    async function single(verb, chunks, onChunk) {
      let done = 0;
      for (const c of chunks) for (const k of c.keys) pending.set(k, verb);
      try {
        for (const c of chunks) {
          const r = await send(c.msg);
          if (!r.ok && !limited(r)) return { done, error: r.error || "" };
          mark(c.folders);
          if (!r.ok) return { done, error: r.error || "", limited: true };
          done += c.keys.length;
          await onChunk?.(c);
        }
        return { done, error: "" };
      } finally {
        for (const c of chunks) release(c.keys, verb);
      }
    }

    // The running batch once planned: { job, name, done, total, folders (its current chunk's), meta }; else null.
    function progress() {
      const g = batch && runs.get(lane);
      return g?.total ? { job: batch.job, name: batch.name, done: g.done, total: g.total, folders: batch.chunk?.folders || [], meta: batch.meta } : null;
    }

    return {
      run,
      single,
      progress,
      stop: () => runs.stop(lane),
      busy: () => runs.busy(lane),
      pending: (key) => pending.get(key) || "",
      // since: also true when a request reached it at or after that time.
      writing(folder, since = null) {
        const k = String(folder);
        const at = lastWrite.get(k);
        const touched = batch && [...batch.folders, ...(batch.chunk?.folders || [])].some((f) => String(f) === k);
        return Boolean(touched) || (at != null && (now() - at < settleMs || (since != null && at >= since)));
      }
    };
  }
  globalThis.MdgWrites = { create };
})();
