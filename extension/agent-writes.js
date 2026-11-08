// MoonDigest's agent interface, docs/AGENT.md §2: what an AI tool may change in the 分拣台, off until 设置 → 高级 → 允许
// AI 工具改分拣台 (mcpWrites).
// - triage writes local results at once (AI 判断, 保留, 备注, 视频标签), each key read-modify-written under the lock the
//   分拣台 takes for it, and journals the change (KEYS.triageAgentLog): the 分拣台 offers it to U, and agent-undo puts back
//   what is still as the tool left it.
// - propose changes nothing on B站: it queues a 取消收藏, 移动 or 复制 (KEYS.triageAgentProposals) that the user confirms
//   or rejects in the 分拣台, whose own B站 writes (limits, undo) then run it.
// The worker loads it after triage-bg.js, whose helpers it uses.
(() => {
  const K = MdgLimits.KEYS;
  const ITEMS_MAX = 50;
  const PROPOSALS_MAX = 20;
  const NOTE_MAX = 2000;
  const BVID = /^BV[0-9A-Za-z]{10}$/;
  const ACTIONS = ["unfav", "move", "copy"];

  const fail = (code, message) => Object.assign(new Error(message), code ? { code } : {});
  const bad = (message) => fail("BAD_PARAMS", message);
  const text = (v, max, name) => {
    if (typeof v !== "string" || v.length > max) throw bad(`${name} must be a string of at most ${max} characters.`);
    return v.trim();
  };
  const listOf = (v, max, name) => {
    if (!Array.isArray(v) || v.length > max) throw bad(`${name} must be a list of at most ${max}.`);
    return v;
  };
  const given = (x, k) => x[k] !== undefined;
  const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  const tagNames = (v, name) =>
    listOf(v ?? [], 10, name).map((n, j) => {
      const clean = MdgTagCore.cleanTagName(text(n, 40, `${name}[${j}]`));
      if (!clean) throw bad(`${name}[${j}] is not a tag name.`);
      return clean;
    });

  // One entry of triage's items, checked whole before anything is written.
  function itemOf(x, i) {
    const at = `items[${i}]`;
    if (!x || typeof x !== "object" || !BVID.test(x.bvid)) throw bad(`${at}.bvid must be a BV id (BV and 10 letters or digits).`);
    const it = { bvid: x.bvid };
    if (given(x, "verdict")) {
      if (!MdgTagCore.VERDICTS[x.verdict]) throw bad(`${at}.verdict must be keep, drop or unsure.`);
      const summary = text(x.summary ?? "", 100, `${at}.summary`);
      if (!summary) throw bad(`${at}.summary is required with a verdict.`);
      const points = listOf(x.points ?? [], TRIAGE_POINTS, `${at}.points`).map((p, j) => text(p, 200, `${at}.points[${j}]`)).filter(Boolean);
      // A 细看's shape (triageAnalyze), from the tool: the card names it by source and shows no basis line.
      it.analysis = { bvid: x.bvid, status: "done", source: "agent", oneLiner: summary, points, verdict: x.verdict, reason: text(x.reason ?? "", 300, `${at}.reason`) };
    } else if (["summary", "reason", "points"].some((k) => given(x, k))) throw bad(`${at}: summary, reason and points go with a verdict.`);
    if (given(x, "kept")) {
      if (typeof x.kept !== "boolean") throw bad(`${at}.kept must be true or false.`);
      it.kept = x.kept;
    }
    if (given(x, "note")) it.note = text(x.note, NOTE_MAX, `${at}.note`);
    const add = tagNames(x.addTags, `${at}.addTags`);
    const remove = tagNames(x.removeTags, `${at}.removeTags`);
    if (add.length || remove.length) {
      if (!triageFolderId(x.folderId)) throw bad(`${at}.folderId must be the folder whose tags these are (a folder id from get_favorites, or toview).`);
      Object.assign(it, { folderId: String(x.folderId), add, remove });
    }
    if (Object.keys(it).length === 1) throw bad(`${at} changes nothing.`);
    return it;
  }

  // The local results of up to ITEMS_MAX videos. Resolves { changed, tagsNotMade? }; what landed is journaled even when a
  // later write fails.
  async function triage({ items }) {
    const list = listOf(items, ITEMS_MAX, "items").map(itemOf);
    if (!list.length) throw bad("items must name at least one video.");
    if (new Set(list.map((it) => it.bvid)).size < list.length) throw bad("Name each bvid once per call.");
    const tagged = list.filter((it) => it.folderId);
    const folders = [...new Set(tagged.map((it) => it.folderId))];
    if (folders.length) {
      const got = await chrome.storage.local.get([K.triageIncludedFolders, ...folders.map(K.triageSnapshot)]);
      const ticked = new Set((got[K.triageIncludedFolders] || []).map(String));
      const off = tagged.find((it) => !ticked.has(it.folderId) || !got[K.triageSnapshot(it.folderId)]?.bvids?.includes(it.bvid));
      if (off) throw bad(`${off.bvid} is not in folder ${off.folderId} as MoonDigest has it: a folder's tags go on its own videos, in folders ticked in the 分拣台.`);
    }
    const now = Date.now();
    const changes = {}; // part → { bvid: [before, after] }
    const note = (part, b, was, next) => ((changes[part] ||= {})[b] = [was ?? null, next ?? null]);
    const made = [];
    const notMade = [];
    try {
      const keep = list.filter((it) => "kept" in it);
      if (keep.length) {
        await MdgLimits.update(K.triageKept, (cur = {}) => {
          const next = { ...cur };
          for (const it of keep) {
            const was = cur[it.bvid] || null;
            const v = it.kept ? was || { action: "keep", at: now } : null;
            if (same(was, v)) continue;
            note("kept", it.bvid, was, v);
            if (v) next[it.bvid] = v;
            else delete next[it.bvid];
          }
          return changes.kept ? next : undefined;
        });
      }
      for (const it of list.filter((x) => "note" in x)) {
        const was = (await chrome.storage.local.get(K.triageNotes))[K.triageNotes]?.[it.bvid]?.text || "";
        if (await MdgLimits.saveVideoNote(it.bvid, it.note, undefined, was)) note("note", it.bvid, was, it.note);
      }
      for (const it of list.filter((x) => x.analysis)) {
        const v = { ...it.analysis, analyzedAt: now };
        await MdgLimits.update(K.triageAnalysis(it.bvid), (was) => (note("analysis", it.bvid, was, v), v));
      }
      if (tagged.length) {
        const cap = TriageUi.numSetting("tagLimit", (await chrome.storage.sync.get("triageTagLimit")).triageTagLimit);
        await MdgLimits.locked(MdgLimits.keyLock(K.triageTags), async () => {
          const got = await chrome.storage.local.get([K.triageTags, K.triageVideoTags]);
          let tags = got[K.triageTags] || [];
          const map = { ...got[K.triageVideoTags] };
          const before = {};
          for (const it of tagged) {
            const own = () => tags.filter((t) => t.folder === it.folderId);
            const idOf = (name) => own().find((t) => t.name === name)?.id;
            const add = [];
            for (const name of it.add) {
              let id = idOf(name);
              // A new tag only while the folder has room (收藏夹设置's cap), as 标签管理 makes one.
              if (!id && own().length < cap) {
                const t = { id: MdgTagCore.newTagId("t"), name, color: MdgTagCore.nextTagColor(own()), folder: it.folderId };
                tags = [...tags, t];
                made.push(t.id);
                id = t.id;
              }
              if (id) add.push(id);
              else notMade.push(name);
            }
            const drop = new Set(it.remove.map(idOf));
            const was = map[it.bvid] || [];
            const next = [...new Set([...was.filter((id) => !drop.has(id)), ...add])];
            if (same(was, next)) continue;
            before[it.bvid] = was;
            if (next.length) map[it.bvid] = next;
            else delete map[it.bvid];
          }
          if (!made.length && !Object.keys(before).length) return;
          await chrome.storage.local.set({ [K.triageTags]: tags, [K.triageVideoTags]: map });
          for (const [b, was] of Object.entries(before)) note("tags", b, was, map[b] || []);
        });
      }
    } finally {
      const n = new Set(Object.values(changes).flatMap(Object.keys)).size;
      if (n || made.length) {
        const entry = { id: MdgTagCore.newTagId("a"), at: now, n, changes, made };
        await MdgLimits.update(K.triageAgentLog, (log = []) => [...log, entry].slice(-MdgLimits.TRIAGE_UNDO_STEPS));
      }
    }
    const n = new Set(Object.values(changes).flatMap(Object.keys)).size;
    return { changed: n, ...(notMade.length && { tagsNotMade: [...new Set(notMade)] }) };
  }

  // U in the 分拣台 on one journaled triage: each value still as the tool left it goes back; one changed since stays
  // (skipped). The entry is taken first, so a second U on it (another tab) is refused; a failed write puts it back.
  async function undo({ id }) {
    let entry = null;
    await MdgLimits.update(K.triageAgentLog, (log = []) => {
      entry = log.find((e) => e.id === id) || null;
      return entry ? log.filter((e) => e !== entry) : undefined;
    });
    if (!entry) throw fail("", "这一步已经撤销过了");
    const { kept = {}, note = {}, analysis = {}, tags = {} } = entry.changes;
    const skipped = new Set();
    try {
      if (Object.keys(kept).length) {
        await MdgLimits.update(K.triageKept, (cur = {}) => {
          const next = { ...cur };
          for (const [b, [was, v]] of Object.entries(kept)) {
            if (!same(cur[b], v)) skipped.add(b);
            else if (was) next[b] = was;
            else delete next[b];
          }
          return next;
        });
      }
      for (const [b, [was, v]] of Object.entries(note)) {
        if (!(await MdgLimits.saveVideoNote(b, was || "", undefined, v || ""))) skipped.add(b);
      }
      for (const [b, [was, v]] of Object.entries(analysis)) {
        const key = K.triageAnalysis(b);
        await MdgLimits.locked(MdgLimits.keyLock(key), async () => {
          if (!same((await chrome.storage.local.get(key))[key], v)) return skipped.add(b);
          if (was) await chrome.storage.local.set({ [key]: was });
          else await chrome.storage.local.remove(key);
        });
      }
      if (Object.keys(tags).length || entry.made.length) {
        await MdgLimits.locked(MdgLimits.keyLock(K.triageTags), async () => {
          const got = await chrome.storage.local.get([K.triageTags, K.triageVideoTags]);
          const map = { ...got[K.triageVideoTags] };
          const live = new Set((got[K.triageTags] || []).map((t) => t.id));
          for (const [b, [was, v]] of Object.entries(tags)) {
            if (!same(map[b] || [], v)) skipped.add(b);
            else if (was.some((id) => live.has(id))) map[b] = was.filter((id) => live.has(id));
            else delete map[b];
          }
          // Tags it made that nothing carries any more go too.
          const used = new Set(Object.values(map).flat());
          const left = (got[K.triageTags] || []).filter((t) => !entry.made.includes(t.id) || used.has(t.id));
          await chrome.storage.local.set({ [K.triageTags]: left, [K.triageVideoTags]: map });
        });
      }
    } catch (e) {
      await MdgLimits.update(K.triageAgentLog, (log = []) => [...log, entry].sort((x, y) => x.at - y.at)).catch(() => {});
      throw e;
    }
    return { n: entry.n, skipped: skipped.size };
  }

  // A B站 write the user confirms in the 分拣台. from is a ticked folder (or 稍后再看) and every video in its local copy,
  // so the page has their aids; to is a folder of the list the 分拣台 last read, not 稍后再看.
  async function propose({ action, from, to, bvids, reason }) {
    if (!ACTIONS.includes(action)) throw bad('action must be "unfav", "move" or "copy".');
    const src = String(from ?? "");
    if (!triageFolderId(src)) throw bad("from must be a folder id from get_favorites, or toview.");
    const ids = listOf(bvids, ITEMS_MAX, "bvids");
    if (!ids.length || !ids.every((b) => BVID.test(b))) throw bad("bvids must be 1 to 50 BV ids.");
    if (new Set(ids).size < ids.length) throw bad("Name each bvid once.");
    const why = text(reason ?? "", 200, "reason");
    const got = await chrome.storage.local.get([K.triageIncludedFolders, K.triageSnapshot(src), K.triageFolderList]);
    if (!(got[K.triageIncludedFolders] || []).map(String).includes(src)) throw bad(`Folder ${src} is not ticked in the 分拣台: the user can confirm changes only to ticked folders.`);
    const have = new Set(got[K.triageSnapshot(src)]?.bvids || []);
    const missing = ids.filter((b) => !have.has(b));
    if (missing.length) throw bad(`Not in folder ${src} as MoonDigest has it: ${missing.join(", ")}.`);
    const p = { id: MdgTagCore.newTagId("p"), at: Date.now(), action, from: src, bvids: ids, ...(why && { reason: why }) };
    if (action !== "unfav") {
      const dest = String(to ?? "");
      if (!triageNumId(dest) || dest === src) throw bad("to must be another folder id from get_favorites (not toview).");
      if (!(got[K.triageFolderList]?.folders || []).some((f) => String(f.id) === dest)) throw bad(`Folder ${dest} is not in the folder list MoonDigest last read.`);
      p.to = dest;
    } else if (to != null) throw bad("to goes with move and copy only.");
    await MdgLimits.update(K.triageAgentProposals, (cur = []) => {
      if (cur.length >= PROPOSALS_MAX) throw fail("PROPOSALS_FULL", `${PROPOSALS_MAX} proposals already wait for the user in the 分拣台. Ask the user to go through them first.`);
      return [...cur, p];
    });
    return { id: p.id, status: "proposed" };
  }

  const on = async () => MdgSettings.normalizeSwitches({ mcpWrites: (await chrome.storage.sync.get("mcpWrites")).mcpWrites }).mcpWrites;
  const OFF = "The user has not allowed AI tools to change the 分拣台. Ask the user to turn on 设置 → 高级 → 允许 AI 工具改分拣台 (Settings → Advanced) in MoonDigest, then call again.";
  const method = (fn) => async (params) => {
    try {
      if (!(await on())) throw fail("WRITES_OFF", OFF);
      return { ok: true, data: await fn(params && typeof params === "object" ? params : {}) };
    } catch (e) {
      return { ok: false, error: String(e?.message || e), ...(e?.code ? { code: String(e.code) } : {}) };
    }
  };
  MdgAgentBridge.addMethods({ triage: method(triage), propose: method(propose) });
  // U works whatever the switch says now: the user takes back what was written while it was on.
  if (globalThis.chrome?.runtime?.onMessage) triageListen("", { "agent-undo": (msg) => undo(msg) });
})();
