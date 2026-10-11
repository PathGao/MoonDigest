// Writes that change Bilibili, for a page that sends them (BocWrites.create). It knows nothing of the page: the request
// (send), what counts as a limit (limited), the limit wait (hold) and the gap (sleep) come in.
// - run: a batch. One at a time (a second is refused with the running one's name); chunk by chunk with each chunk's gap
//   before it; a limit holds and sends the same chunk again; any other failure stops it. onChunk(chunk) runs after each
//   chunk that went through. plan may be a function, called once the slot is taken (work that must not race another
//   batch, such as creating the target).
// - single: a write that does not wait for the batch (one key press). A limit fails at once.
// - Every key of a running batch (until its chunk goes through) and of a single write is pending, with its verb.
// - A folder is being written while the batch names it (folders) or is on its current chunk, and for settleMs after a
//   request reached it, a limited one included: the lists trail a write, and a paged read across changes shifts.
// triage.html loads this classic script before triage.js; writes.selftest.js tests it in node.
(() => {
  // chunk: { msg, keys, folders, gap? } (other fields ride along for onChunk).
  function create({ send, limited, hold, sleep, now = Date.now, settleMs = 3000 }) {
    let batch = null; // { job, name, done, total, chunk, folders, meta }
    const pending = new Map(); // key → verb
    const lastWrite = new Map(); // folder → when a request last reached it
    const mark = (folders) => folders.forEach((f) => lastWrite.set(String(f), now()));
    const release = (keys, verb) => keys.forEach((k) => pending.get(k) === verb && pending.delete(k));

    async function run(job, name, plan) {
      if (batch) return { done: 0, total: 0, error: "", busy: batch.name };
      batch = { job, name, done: 0, total: 0, chunk: null, folders: [], meta: {} };
      let p = null;
      try {
        p = typeof plan === "function" ? await plan() : plan;
        if (!p) return { done: 0, total: 0, error: "" };
        const { verb, chunks, folders = [], meta = {}, onChunk } = p;
        const total = chunks.reduce((n, c) => n + c.keys.length, 0);
        Object.assign(batch, { total, folders: folders.map(String), meta });
        for (const c of chunks) for (const k of c.keys) pending.set(k, verb);
        for (let i = 0; i < chunks.length; i++) {
          const c = (batch.chunk = chunks[i]);
          if (i && c.gap) await sleep(c.gap);
          let r;
          while (!(r = await send(c.msg)).ok && limited(r)) await hold(job, r);
          if (!r.ok) return { done: batch.done, total, error: r.error || "" };
          mark(c.folders);
          release(c.keys, verb);
          batch.done += c.keys.length;
          await onChunk?.(c);
        }
        return { done: batch.done, total, error: "" };
      } finally {
        if (p) for (const c of p.chunks) release(c.keys, p.verb);
        batch = null;
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

    return {
      run,
      single,
      busy: () => batch?.name || "",
      pending: (key) => pending.get(key) || "",
      // since: also true when a request reached it at or after that time.
      writing(folder, since = null) {
        const k = String(folder);
        const at = lastWrite.get(k);
        const touched = batch && [...batch.folders, ...(batch.chunk?.folders || [])].some((f) => String(f) === k);
        return Boolean(touched) || (at != null && (now() - at < settleMs || (since != null && at >= since)));
      },
      // The running batch once planned: { job, name, done, total, folders (its current chunk's), meta }; else null.
      progress: () => (batch?.total ? { job: batch.job, name: batch.name, done: batch.done, total: batch.total, folders: batch.chunk?.folders || [], meta: batch.meta } : null)
    };
  }
  globalThis.BocWrites = { create };
})();
