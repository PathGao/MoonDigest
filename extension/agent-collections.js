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
  const ITEM_RESERVE_MS = 12_000; // an item is not started with less left before the deadline: the rest are returned undone
  const STOP = [MdgErrors.CODE.THROTTLED, MdgErrors.CODE.NOT_LOGGED_IN];
  const ITEM = /^[\w-]{1,64}$/;

  const fail = (message, code) => Object.assign(new Error(message), code ? { code } : {});
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const on = async (key) => MdgSettings.normalizeSwitches({ [key]: (await chrome.storage.sync.get(key))[key] })[key];
  const READ_OFF = "The user has not allowed AI tools to read their collections. Ask the user to turn on 设置 → 高级 → 允许 AI 工具读我的收藏、关注和历史 (Settings → Advanced) in MoonDigest, then call again.";
  const WRITE_OFF = "The user has not allowed AI tools to change their collections. Ask the user to turn on 设置 → 高级 → 允许 AI 工具改我的收藏 (Settings → Advanced) in MoonDigest, then call again. dryRun works without it.";

  // The site and kind, checked: { adapter, kind, ops } (ops: the writes the kind takes).
  function target(params) {
    const p = params && typeof params === "object" ? params : {};
    const adapter = typeof p.site === "string" ? MdgAgentSites.get(p.site) : null;
    if (!adapter?.collections) {
      throw fail(`site must be one of ${MdgAgentSites.list().filter((s) => s.collections).map((s) => `"${s.id}"`).join(", ")}.`);
    }
    const ops = Object.hasOwn(adapter.collections, p.kind) ? adapter.collections[p.kind] : null;
    if (!ops) throw fail(`${adapter.id} has no kind ${p.kind}. Kinds: ${Object.keys(adapter.collections).join(", ")}.`, "UNSUPPORTED_KIND");
    return { p, adapter, kind: p.kind, ops };
  }

  async function list(params, deadline) {
    const { p, adapter, kind } = target(params);
    if (p.cursor != null && (typeof p.cursor !== "string" || p.cursor.length > 4096)) throw fail("cursor must be the cursor a previous list_collection returned.");
    if (!(await on("mcpPersonalData"))) throw fail(READ_OFF, "PERSONAL_DATA_OFF");
    const { items, cursor } = await adapter.list({ kind, id: p.id, cursor: p.cursor || "" }, deadline);
    return { site: adapter.id, kind, ...(p.id != null && { id: String(p.id) }), items, cursor };
  }

  // → { site, op, kind, id?, dryRun, results: [{ item, status, before?, after?, error? }], done, notDone, stopped?, undo }.
  // status: unchanged (already as asked: skipped), would_change (dryRun), done (confirmed by the read after),
  // unconfirmed (sent, but the read after still shows the old state), failed. stopped: the code that ended the batch
  // (THROTTLED, NOT_LOGGED_IN, or TIMEOUT when the call's time ran out); notDone are the items not tried.
  async function write(params, deadline) {
    const { p, adapter, kind, ops } = target(params);
    const op = p.op;
    if (!ops.includes(op)) throw fail(ops.length ? `op must be ${ops.map((o) => `"${o}"`).join(" or ")} for ${kind}.` : `${adapter.id} ${kind} is read only.`, "UNSUPPORTED_KIND");
    const items = p.items;
    if (!Array.isArray(items) || !items.length || items.length > MAX_ITEMS) throw fail(`items must be 1 to ${MAX_ITEMS} ids.`);
    if (!items.every((i) => typeof i === "string" && ITEM.test(i)) || new Set(items).size !== items.length) throw fail("items must be distinct ids.");
    const dryRun = p.dryRun === true;
    if (!(await on("mcpPersonalData"))) throw fail(READ_OFF, "PERSONAL_DATA_OFF");
    if (!dryRun && !(await on("mcpCollectionWrite"))) throw fail(WRITE_OFF, "WRITE_OFF");
    const at = { kind, id: p.id };
    const want = op === "add";
    const results = [];
    let stopped = "";
    for (const [n, item] of items.entries()) {
      if (n) await sleep(ITEM_GAP[0] + Math.random() * (ITEM_GAP[1] - ITEM_GAP[0]));
      if (Date.now() + ITEM_RESERVE_MS > deadline) { stopped = "TIMEOUT"; break; }
      let before;
      try {
        before = await adapter.has({ ...at, item }, deadline);
        if (before === want) { results.push({ item, status: "unchanged", before }); continue; }
        if (dryRun) { results.push({ item, status: "would_change", before }); continue; }
        await adapter.write({ ...at, op, item }, deadline);
        await sleep(SETTLE_MS);
        const after = await adapter.has({ ...at, item }, deadline);
        results.push({ item, status: after === want ? "done" : "unconfirmed", before, after });
      } catch (e) {
        results.push({ item, status: "failed", ...(before != null && { before }), error: String(e?.message || e) });
        if (STOP.includes(e?.code)) { stopped = e.code; break; }
      }
    }
    const done = results.filter((r) => r.status === "done").map((r) => r.item);
    // unconfirmed may have landed: undo takes it too, and skips it if it had not.
    const undoItems = results.filter((r) => r.status === "done" || r.status === "unconfirmed").map((r) => r.item);
    return {
      site: adapter.id, op, kind, ...(p.id != null && { id: String(p.id) }), dryRun, results, done,
      notDone: items.slice(results.length),
      ...(stopped && { stopped }),
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

  MdgAgentBridge.addMethods({
    collection: (params, deadline) => run(list, params, deadline),
    collectionWrite: (params, deadline) => run(write, params, deadline)
  });
})();
