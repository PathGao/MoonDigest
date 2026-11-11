// MoonDigest's agent interface, docs/AGENT.md §2 `collection` and `collectionWrite`: the user's collections on a site
// whose adapter has `collections` (agent-sites/, §5), read and changed with no page of MoonDigest's own: the agent is
// the UI. The rules every site's writes get are here, not in the adapters: off until the user allows it, at most
// MAX_ITEMS a call, one item at a time ITEM_GAP apart, each read before (no-op skipped) and after (confirmed), stop at
// THROTTLED or a lost login, and the inverse op to undo what was done.
(() => {
  const MAX_ITEMS = 20;
  const ITEM_GAP = [1500, 3000];
  const CALL_GAP_MS = 1000;
  const SETTLE_MS = 1000; // between a write and the read that confirms it
  // An item is not started with less left before the deadline, nor its write sent with less than WRITE_RESERVE_MS
  // (write, settle and the read after, each request capped at 10 s by the adapter): the rest are returned undone, so a
  // write is never sent without time to confirm it. Each request also ends by the deadline, before the server's.
  const ITEM_RESERVE_MS = 12_000;
  const WRITE_RESERVE_MS = 22_000;
  const STOP = [MdgErrors.CODE.THROTTLED, MdgErrors.CODE.NOT_LOGGED_IN];
  // A site's state read can lag its writes (YouTube: about 12 s): an item written here counts as written for this long,
  // so an undo right after is not skipped as already done. In memory: a restarted worker forgets, and reads again.
  const WRITTEN_MS = 30_000;
  const written = new Map(); // "site|kind|id|item" → { state, at }
  const ITEM = /^[\w-]{1,64}$/;

  const fail = (message, code) => Object.assign(new Error(message), code ? { code } : {});
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // The site and kind, checked: { adapter, kind, ops } (ops: the writes the kind takes).
  function target(params) {
    const p = params && typeof params === "object" ? params : {};
    const adapter = typeof p.site === "string" ? MdgAgentSites.get(p.site) : null;
    if (!adapter?.collections) {
      throw fail(`site must be one of ${MdgAgentSites.list().filter((s) => s.collections).map((s) => `"${s.id}"`).join(", ")}.`, "BAD_PARAMS");
    }
    const ops = Object.hasOwn(adapter.collections, p.kind) ? adapter.collections[p.kind] : null;
    if (!ops) throw fail(`${adapter.id} has no kind ${p.kind}. Kinds: ${Object.keys(adapter.collections).join(", ")}.`, "UNSUPPORTED_KIND");
    return { p, adapter, kind: p.kind, ops };
  }

  async function list(params, deadline) {
    const { p, adapter, kind } = target(params);
    if (p.cursor != null && (typeof p.cursor !== "string" || p.cursor.length > 4096)) throw fail("cursor must be the cursor a previous list_collection returned.", "BAD_PARAMS");
    const { items, cursor } = await adapter.list({ kind, id: p.id, cursor: p.cursor || "" }, deadline);
    return { site: adapter.id, kind, ...(p.id != null && { id: String(p.id) }), items, cursor };
  }

  // → { site, op, kind, id?, dryRun, results: [{ item, status, before?, after?, error? }], done, notDone, stopped?, undo }.
  // status: unchanged (already as asked: skipped), would_change (dryRun), done (confirmed by the read after),
  // unconfirmed (sent, but the read after still shows the old state), failed. stopped: the code that ended the batch
  // (THROTTLED, NOT_LOGGED_IN, or TIMEOUT when the call's time ran out); notDone are the items not tried.
  // record: false is the journal's own undo of an earlier write, which makes no new entry.
  async function write(params, deadline, { record = true } = {}) {
    const { p, adapter, kind, ops } = target(params);
    const op = p.op;
    if (!ops.includes(op)) throw fail(ops.length ? `op must be ${ops.map((o) => `"${o}"`).join(" or ")} for ${kind}.` : `${adapter.id} ${kind} is read only.`, "UNSUPPORTED_KIND");
    const items = p.items;
    if (!Array.isArray(items) || !items.length || items.length > MAX_ITEMS) throw fail(`items must be 1 to ${MAX_ITEMS} ids.`, "BAD_PARAMS");
    if (!items.every((i) => typeof i === "string" && ITEM.test(i)) || new Set(items).size !== items.length) throw fail("items must be distinct ids.", "BAD_PARAMS");
    const dryRun = p.dryRun === true;
    const at = { kind, id: p.id };
    const want = op === "add";
    const slot = (item) => [adapter.id, kind, p.id ?? "", item].join("|");
    const has = async (item) => {
      const w = written.get(slot(item));
      return w && Date.now() - w.at < WRITTEN_MS ? w.state : adapter.has({ ...at, item }, deadline);
    };
    const results = [];
    const sent = new Set(); // written, whatever the answer: a write that timed out or failed may still have landed
    let stopped = "";
    for (const [n, item] of items.entries()) {
      if (n) await sleep(ITEM_GAP[0] + Math.random() * (ITEM_GAP[1] - ITEM_GAP[0]));
      if (Date.now() + ITEM_RESERVE_MS > deadline) { stopped = "TIMEOUT"; break; }
      let before;
      try {
        before = await has(item);
        if (before === want) { results.push({ item, status: "unchanged", before }); continue; }
        if (dryRun) { results.push({ item, status: "would_change", before }); continue; }
        if (Date.now() + WRITE_RESERVE_MS > deadline) { stopped = "TIMEOUT"; break; }
        sent.add(item);
        // true: the site's own answer confirms the change, so no read after (it may lag); else read after to confirm.
        const confirmed = (await adapter.write({ ...at, op, item }, deadline)) === true;
        if (!confirmed) await sleep(SETTLE_MS);
        const after = confirmed ? want : await adapter.has({ ...at, item }, deadline);
        if (after === want) written.set(slot(item), { state: want, at: Date.now() });
        results.push({ item, status: after === want ? "done" : "unconfirmed", before, after });
      } catch (e) {
        results.push({ item, status: "failed", ...(before != null && { before }), error: String(e?.message || e) });
        if (STOP.includes(e?.code)) { stopped = e.code; break; }
      }
    }
    const done = results.filter((r) => r.status === "done").map((r) => r.item);
    // Every item sent may have landed (unconfirmed, or failed after the write went out): undo takes it too, and skips it
    // if it had not, since undo reads each item first.
    const undoItems = items.filter((i) => sent.has(i));
    // Journaled with the Agent's other changes (agent-writes.js), so 设置 → MCP lists it and undoes it.
    const where = adapter.id === "bilibili" ? MdgErrors.LABEL.watchLater : kind === "watch_later" ? "YouTube 稍后观看" : `YouTube 播放列表 ${p.id}`;
    const undoId = record && undoItems.length
      ? await MdgAgentJournal.add({ kind: "collection", op, n: undoItems.length, site: adapter.id, list: kind, ...(p.id != null && { listId: String(p.id) }), items: undoItems, titles: { from: where } }).catch(() => "")
      : "";
    return {
      site: adapter.id, op, kind, ...(p.id != null && { id: String(p.id) }), dryRun, results, done,
      notDone: items.slice(results.length),
      ...(stopped && { stopped }),
      ...(undoId && { undoId }),
      undo: undoItems.length ? { site: adapter.id, op: want ? "remove" : "add", kind, ...(p.id != null && { id: String(p.id) }), items: undoItems } : null
    };
  }

  // One call at a time, CALL_GAP_MS apart (a write's items have their own gaps). deadline: as agent-bridge.js handle.
  let queue = Promise.resolve();
  let lastAt = 0;
  function run(fn, params, deadline) {
    const call = queue.then(async () => {
      const wait = lastAt + CALL_GAP_MS - Date.now();
      if (wait > 0) await sleep(wait);
      if (Date.now() > deadline) throw fail("The call waited too long behind earlier ones.", "TIMEOUT");
      try {
        return await fn(params, deadline);
      } finally {
        lastAt = Date.now();
      }
    });
    queue = call.catch(() => {});
    return call.then(
      (data) => ({ ok: true, data }),
      (e) => ({ ok: false, error: String(e?.message || e), ...(e?.code ? { code: String(e.code) } : {}) })
    );
  }

  // The reverse write: each item is read first, so one already back is skipped. What did not go through stays journaled.
  MdgAgentJournal.undoer("collection", async (e, deadline) => {
    const r = await write({ site: e.site, op: e.op === "add" ? "remove" : "add", kind: e.list, ...(e.listId != null && { id: e.listId }), items: e.items }, deadline, { record: false });
    const back = new Set(r.results.filter((x) => x.status === "done" || x.status === "unchanged").map((x) => x.item));
    const left = e.items.filter((i) => !back.has(i));
    return { done: back.size, ...(left.length && { left: left.length, stopped: r.stopped || "FAILED", entry: { ...e, items: left, n: left.length } }) };
  });

  MdgAgentBridge.addMethods({
    collection: (params, deadline) => run(list, params, deadline),
    collectionWrite: (params, deadline) => run(write, params, deadline)
  });
  globalThis.MdgAgentCollections = { forget: () => written.clear() }; // for the selftest: each case starts with none
})();
