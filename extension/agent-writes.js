// MoonDigest's agent interface, docs/AGENT.md §2: what an AI tool changes, on while 设置 → MCP's one switch is on.
// - triage writes the 分拣台's local results (AI 判断, 保留, 备注, 视频标签), each key read-modify-written under the lock
//   the 分拣台 takes for it.
// - favWrite changes B站's favorites at once (移动, 复制, 取消收藏, 清理失效; a folder made, renamed, made public or
//   private, deleted) through triage-bg.js's handlers, the ones the 分拣台 sends to, and keeps the local records through
//   fav-records.js, the ones the 分拣台 keeps.
// Nothing asks first: every call is journaled (KEYS.triageAgentLog) with what it changed and how it was before, and
// undo puts that back, from 设置 → MCP, the 分拣台 (U) or the tool itself.
// The worker loads it after triage-bg.js and fav-records.js, whose helpers it uses.
(() => {
  const K = MdgLimits.KEYS;
  const ITEMS_MAX = 50;
  const FAV_MAX = 500; // videos one favWrite takes
  const LOG_MAX = 100;
  const TOVIEW = TRIAGE_TOVIEW;
  const R = MdgFavRecords;
  const NOTE_MAX = 2000;
  const BVID = /^BV[0-9A-Za-z]{10}$/;

  const fail = (message, code) => Object.assign(new Error(message), code ? { code } : {});
  const bad = (message) => fail(message, "BAD_PARAMS");
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
  // The tool's verdict as written: the 分拣台 stamps a result without criteria with its folder's (loadResults) when it
  // opens, which is not a change of the user's.
  const asWritten = ({ criteria, ...a } = {}) => a;
  const tagNames = (v, name) =>
    listOf(v ?? [], 10, name).map((n, j) => {
      const clean = MdgTagCore.cleanTagName(text(n, MdgTagCore.TAG_NAME_MAX, `${name}[${j}]`));
      if (!clean) throw bad(`${name}[${j}] is not a tag name.`);
      return clean;
    });

  // One entry of triage's items, checked whole before anything is written.
  function itemOf(x, i) {
    const at = `items[${i}]`;
    if (!x || typeof x !== "object" || !BVID.test(x.bvid)) throw bad(`${at}.bvid must be a BV id (BV and 10 letters or digits).`);
    const it = { bvid: x.bvid };
    if (given(x, "verdict")) {
      if (!Object.hasOwn(MdgTagCore.VERDICTS, x.verdict ?? "")) throw bad(`${at}.verdict must be keep, drop or unsure.`);
      // A 粗看's shape (triageClassifyTitles): a verdict from the title alone, which a later 细看 overrides.
      if (x.coarse === true) {
        const reason = text(x.reason ?? "", 300, `${at}.reason`);
        if (!reason) throw bad(`${at}.reason is required with a coarse verdict.`);
        if (["summary", "points"].some((k) => given(x, k))) throw bad(`${at}: summary and points go with a verdict that is not coarse.`);
        it.title = { verdict: x.verdict, reason, confidence: x.confidence === "low" ? "low" : "high", model: "agent" };
        return rest(it, x, at);
      }
      const summary = text(x.summary ?? "", 100, `${at}.summary`);
      if (!summary) throw bad(`${at}.summary is required with a verdict.`);
      const points = listOf(x.points ?? [], TRIAGE_POINTS, `${at}.points`).map((p, j) => text(p, 200, `${at}.points[${j}]`)).filter(Boolean);
      // A 细看's shape (triageAnalyze), from the tool: the card names it by source and shows no basis line.
      it.analysis = { bvid: x.bvid, status: "done", source: "agent", oneLiner: summary, points, verdict: x.verdict, reason: text(x.reason ?? "", 300, `${at}.reason`) };
    } else if (["summary", "reason", "points", "coarse"].some((k) => given(x, k))) throw bad(`${at}: summary, reason, points and coarse go with a verdict.`);
    return rest(it, x, at);
  }
  function rest(it, x, at) {
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
    const changedIds = () => [...new Set(Object.values(changes).flatMap(Object.keys))];
    let noUndo = false;
    let entryId = "";
    try {
      const keep = list.filter((it) => "kept" in it);
      if (keep.length) {
        const kept = [];
        await MdgLimits.update(K.triageKept, (cur = {}) => {
          const next = { ...cur };
          kept.length = 0;
          for (const it of keep) {
            const was = cur[it.bvid] || null;
            const v = it.kept ? was || { action: "keep", at: now } : null;
            if (same(was, v)) continue;
            kept.push([it.bvid, was, v]);
            if (v) next[it.bvid] = v;
            else delete next[it.bvid];
          }
          return kept.length ? next : undefined;
        });
        for (const [b, was, v] of kept) note("kept", b, was, v); // once stored, as every part
      }
      for (const it of list.filter((x) => "note" in x)) {
        const was = (await chrome.storage.local.get(K.triageNotes))[K.triageNotes]?.[it.bvid]?.text || "";
        if (await MdgLimits.saveVideoNote(it.bvid, it.note, undefined, was)) note("note", it.bvid, was, it.note);
      }
      for (const it of list.filter((x) => x.title)) {
        const v = { ...it.title, analyzedAt: now };
        let was;
        await MdgLimits.update(K.triageTitle(it.bvid), (cur) => ((was = cur), v));
        note("title", it.bvid, was, v);
      }
      for (const it of list.filter((x) => x.analysis)) {
        const v = { ...it.analysis, analyzedAt: now };
        let was;
        await MdgLimits.update(K.triageAnalysis(it.bvid), (cur) => ((was = cur), v));
        note("analysis", it.bvid, was, v); // once stored: a failed write is not journaled
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
    } catch (e) {
      // What landed stays (and is journaled below): the tool must not send it again blindly.
      if (changedIds().length) e.message += ` Written before the failure, and kept (the user can undo it in the 分拣台): ${changedIds().join(", ")}.`;
      throw e;
    } finally {
      const n = changedIds().length;
      if (n || made.length) {
        const entry = { id: MdgTagCore.newTagId("a"), at: now, kind: "triage", n, changes, made };
        // A failed journal must not turn landed writes into an error the tool would retry: the reply says no undo.
        await journal(entry).then(() => (entryId = entry.id), () => (noUndo = true));
      }
    }
    return { changed: changedIds().length, ...(entryId && { undoId: entryId }), ...(notMade.length && { tagsNotMade: [...new Set(notMade)] }), ...(noUndo && { noUndo }) };
  }

  // The last LOG_MAX B站 changes and the last LOG_MAX local ones, counted apart: cheap local writes never push a B站
  // change (the only record of what a deleted folder held) out of the journal.
  const onBili = (e) => ["fav", "folder", "collection"].includes(e.kind);
  // Entries other files journal (agent-collections.js, agent-sync.js): add resolves the new entry's id; undoer(kind,
  // fn) is how one of that kind is undone, fn(entry, deadline) resolving as undoFav does.
  const undoers = {};
  globalThis.MdgAgentJournal = {
    // Through the write queue: an entry being undone is never pushed out of the journal meanwhile.
    add: (entry) => {
      const e = { id: MdgTagCore.newTagId("a"), at: Date.now(), ...entry };
      return queued(() => journal(e)).then(() => e.id);
    },
    undoer: (kind, fn) => (undoers[kind] = fn)
  };
  const journal = (entry) =>
    MdgLimits.update(K.triageAgentLog, (log = []) => {
      const all = [...log, entry];
      const keep = new Set([...all.filter(onBili).slice(-LOG_MAX), ...all.filter((e) => !onBili(e)).slice(-LOG_MAX)]);
      return all.filter((e) => keep.has(e));
    });
  // The journal's entry of this id replaced by next; null takes it out.
  const putEntry = (id, next) => MdgLimits.update(K.triageAgentLog, (log = []) => (next ? log.map((e) => (e.id === id ? next : e)) : log.filter((e) => e.id !== id)));
  const UNDO_HOLD_MS = 120_000;

  // One journaled call undone (id; none: the newest). The entry stays in the journal while it is undone, marked, so a
  // second undo of it (another page) is refused and a background that dies midway loses nothing: the mark runs out and
  // it can be undone again. What could not be undone stays journaled: a failed write whole, a B站 undo cut short (the
  // call's time, B站's limit) with the videos still to do, so undoing it again goes on.
  async function undo({ id } = {}, deadline = Date.now() + 50_000) {
    let entry = null;
    let busy = false;
    await MdgLimits.update(K.triageAgentLog, (log = []) => {
      entry = (id == null ? log.at(-1) : log.find((e) => e.id === id)) || null;
      if (!entry) return undefined;
      if (Date.now() - (entry.undoing || 0) < UNDO_HOLD_MS) return void (busy = true);
      return log.map((e) => (e === entry ? { ...e, undoing: Date.now() } : e));
    });
    if (!entry) throw fail(id == null ? "没有可以撤销的修改" : "这一步已经撤销过了");
    if (busy) throw fail("这一步正在撤销");
    const { undoing: _, ...plain } = entry;
    entry = plain;
    let out;
    let rest = null;
    try {
      if (entry.kind === "criteria") out = await undoCriteria(entry);
      else if (onBili(entry) || undoers[entry.kind]) {
        const r = await (undoers[entry.kind] || (entry.kind === "fav" ? undoFav : undoFolder))(entry, deadline);
        rest = r.entry || null;
        out = { id: entry.id, n: r.done, skipped: 0, ...(r.failed && { failed: r.failed }), ...(rest && { left: r.left, ...(r.stopped && { stopped: r.stopped }) }) };
      } else out = await undoTriage(entry);
    } catch (e) {
      await putEntry(entry.id, e.rest || entry).catch(() => {});
      throw e;
    }
    await putEntry(entry.id, rest);
    return out;
  }

  async function undoCriteria(entry) {
    let skipped = 1;
    await MdgLimits.update(K.triageFolderCriteria, (cur = {}) => {
      if ((cur[entry.folder] || "") !== entry.after) return undefined;
      skipped = 0;
      const { [entry.folder]: _, ...others } = cur;
      return entry.before ? { ...others, [entry.folder]: entry.before } : others;
    });
    return { id: entry.id, n: 1 - skipped, skipped };
  }

  // A triage's values still as the tool left them go back; one changed since stays (skipped).
  async function undoTriage(entry) {
    const { kept = {}, note = {}, title = {}, analysis = {}, tags = {} } = entry.changes;
    const skipped = new Set();
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
    const results = [...Object.entries(title).map(([b, p]) => [K.triageTitle(b), b, p]), ...Object.entries(analysis).map(([b, p]) => [K.triageAnalysis(b), b, p])];
    for (const [key, b, [was, v]] of results) {
      await MdgLimits.locked(MdgLimits.keyLock(key), async () => {
        const cur = (await chrome.storage.local.get(key))[key];
        if (!cur || !same(asWritten(cur), asWritten(v))) return skipped.add(b);
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
    return { id: entry.id, n: entry.n, skipped: skipped.size };
  }

  // ---------- B站's favorites ----------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const chosenIds = async () => ((await chrome.storage.local.get(K.triageIncludedFolders))[K.triageIncludedFolders] || []).map(String);
  // A folder's name as MoonDigest last knew it (the folder list, else its cached list).
  async function titleOf(id) {
    const got = await chrome.storage.local.get([K.triageFolderList, K.triageSnapshot(id)]);
    if (id === TOVIEW) return MdgErrors.LABEL.watchLater;
    return (got[K.triageFolderList]?.folders || []).find((f) => String(f.id) === id)?.title || got[K.triageSnapshot(id)]?.title || id;
  }
  const res = (it) => (it.ogv ? `${it.aid}:42` : it.aid); // as the 分拣台's favRes
  // A video known only by its BV id (its folder has no cached list): good for B站's requests, not for a cached list,
  // which then waits for its next read.
  const listed = (items) => items.filter((it) => !it.bare);
  // The videos as the folder's cached list has them (its aid, 番剧 mark and title); a folder MoonDigest has no list of
  // gives only the aid its BV id encodes. One the cached list does not hold is refused: the list is stale, or the id wrong.
  async function itemsIn(folder, bvids) {
    const snap = (await chrome.storage.local.get(K.triageSnapshot(folder)))[K.triageSnapshot(folder)];
    if (!snap) return bvids.map((bvid) => ({ bvid, aid: triageBvToAv(bvid), title: "", bare: true }));
    const by = new Map((snap.items || []).map((it) => [it.bvid, it]));
    const missing = bvids.filter((b) => !by.get(b)?.aid);
    if (missing.length) throw bad(`Not in folder ${folder} as MoonDigest has it (sync_favorites reads it again): ${missing.join(", ")}.`);
    return bvids.map((b) => by.get(b));
  }

  // One run of B站 requests over items, a chunk of size per request (20 for a folder's batch endpoints, TRIAGE_DEAL_MAX
  // where B站 adds to a folder or takes out of 稍后再看, 1 for 稍后再看's add), until the call's time or B站's limit ends
  // it: send(chunk)
  // makes the request (triage-bg.js's handler, as the 分拣台 sends it), then landed(chunk, reply) keeps the local
  // records. Resolves { done: the items written, failed: those B站 said no to (skip, one at a time), stopped?:
  // "TIMEOUT" | "THROTTLED" }; another error is thrown with .done, the items written before it.
  async function run(items, size, deadline, send, landed, { skip = false } = {}) {
    const gap = size === 1 ? 300 : size === TRIAGE_DEAL_MAX ? TRIAGE_DEAL_GAP_MS : 1000;
    const done = [];
    const failed = [];
    for (let i = 0; i < items.length; i += size) {
      if (i) await sleep(gap);
      if (Date.now() > deadline - 8000) return { done, failed, stopped: "TIMEOUT" };
      const chunk = items.slice(i, i + size);
      let reply;
      try {
        reply = await send(chunk);
      } catch (e) {
        if (e.code === MdgErrors.CODE.THROTTLED) return { done, failed, stopped: "THROTTLED" };
        // B站 said no to this one video (deleted, say): an undo goes on with the others. A request that failed (HTTP
        // 500, no JSON) is not that, and stops the run as any error.
        if (skip && size === 1 && e.refused) {
          failed.push(...chunk);
          continue;
        }
        if (e.code === "NETWORK") e.message += ` (${chunk.map((it) => it.bvid).join(", ")})`;
        throw Object.assign(e, { done });
      }
      done.push(...chunk); // on B站 now, whatever happens to the records
      await Promise.resolve(landed(chunk, reply)).catch((e) => {
        throw Object.assign(e, { done });
      });
    }
    return { done, failed };
  }

  // 移动 / 复制 from → to, records kept as the 分拣台's transfer keeps them. Resolves run's result.
  async function transfer(from, to, items, move, deadline) {
    const [fromName, toName] = [await titleOf(from), await titleOf(to)];
    return run(items, from === TOVIEW ? TRIAGE_DEAL_MAX : 20, deadline,
      (chunk) => TRIAGE_HANDLERS["triage-transfer"]({ from, to, aids: chunk.map(res), move }),
      (chunk, reply) => R.lock(async () => {
        const chosen = await chosenIds();
        const inTo = chosen.includes(to);
        if (inTo) {
          await R.patchSnapshotNow(to, { add: listed(chunk) }, { title: toName });
          await R.dropRemovedNow(chunk.map((it) => it.bvid));
        }
        if (!move) return;
        const kept = new Set((reply?.stayed || []).map(String)); // B站 kept them in 稍后再看 too
        const left = chunk.filter((it) => !kept.has(String(res(it))));
        if (!left.length) return;
        await R.patchSnapshotNow(from, { drop: left.map((it) => it.bvid) }, { title: fromName });
        if (!inTo && chosen.includes(from)) await R.movedNow({ id: from, title: fromName }, listed(left), { id: to, title: toName }, chosen.filter((id) => id !== from));
      }));
  }

  // Out of a folder with no 取消收藏 record (a 复制 undone): the cached list just loses them.
  const remove = (folder, items, deadline) =>
    run(items, folder === TOVIEW ? TRIAGE_DEAL_MAX : 20, deadline,
      (chunk) => TRIAGE_HANDLERS["triage-unfav"]({ mediaId: folder, aids: chunk.map(res) }),
      (chunk) => R.lock(() => R.patchSnapshotNow(folder, { drop: chunk.map((it) => it.bvid) })));

  // 取消收藏, recorded as the 分拣台's batch is: the folder's 最近取消收藏 lists them.
  async function unfav(folder, items, deadline) {
    const batch = Date.now();
    const chosen = await chosenIds();
    const others = chosen.filter((id) => id !== folder && id !== TOVIEW);
    const got = await chrome.storage.local.get(others.map(K.triageSnapshot));
    const elsewhere = new Set(others.flatMap((id) => got[K.triageSnapshot(id)]?.bvids || []));
    return run(items, folder === TOVIEW ? TRIAGE_DEAL_MAX : 20, deadline,
      (chunk) => TRIAGE_HANDLERS["triage-unfav"]({ mediaId: folder, aids: chunk.map(res) }),
      (chunk) => chosen.includes(folder) && R.lock(() => R.patchDecisionsNow(folder, Object.fromEntries(chunk.map((it) => [it.bvid, R.unfavRecord(it, Date.now(), batch, elsewhere.has(it.bvid))])))));
  }

  // Back into the folder, one per request, so a video B站 refuses (deleted, say) is skipped and the others go on; its
  // 取消收藏 record goes.
  const refav = (folder, items, deadline) =>
    run(items, 1, deadline,
      ([it]) => TRIAGE_HANDLERS["triage-refav"]({ mediaId: folder, aid: res(it) }),
      ([it]) => R.lock(async () => {
        await R.patchDecisionsNow(folder, { [it.bvid]: null });
        await R.patchSnapshotNow(folder, { add: listed([it]) });
        await R.dropRemovedNow([it.bvid]);
      }), { skip: true });

  const folderInfo = (id) => triageBiliGet(`${TRIAGE_BILI_API}/x/v3/fav/folder/info?media_id=${id}`);
  const isPrivate = (info) => (Number(info?.attr) & 1) === 1; // attr's lowest bit: 1 私密, 0 公开
  const editFolder = (id, info, change) =>
    triageBiliPost("/x/v3/fav/folder/edit", { media_id: id, title: info.title, intro: info.intro || "", privacy: isPrivate(info) ? 1 : 0, cover: info.cover || "", ...change });
  // The folder list MoonDigest keeps (the 分拣台 opens from it) follows a folder change.
  const editList = (edit) => MdgLimits.update(K.triageFolderList, (cur) => (cur?.folders ? { ...cur, folders: edit(cur.folders) } : undefined));

  const bvidsOf = (v) => {
    const ids = listOf(v, FAV_MAX, "bvids");
    if (!ids.length || !ids.every((b) => BVID.test(b))) throw bad(`bvids must be 1 to ${FAV_MAX} BV ids.`);
    if (new Set(ids).size < ids.length) throw bad("Name each bvid once.");
    return ids;
  };
  const folderOf = (v, name, toview = true) => {
    const id = String(v ?? "");
    if (!(toview ? triageFolderId(id) : triageNumId(id))) throw bad(`${name} must be a folder id from get_favorites${toview ? ", or toview" : " (not toview)"}.`);
    return id;
  };

  const FAV_OPS = {
    async move(p, deadline) {
      return copyOrMove(p, true, deadline);
    },
    async copy(p, deadline) {
      return copyOrMove(p, false, deadline);
    },
    async unfav({ from, bvids }, deadline) {
      const folder = folderOf(from, "from");
      const items = await itemsIn(folder, bvidsOf(bvids));
      return favDone({ op: "unfav", from: folder }, items, (list) => unfav(folder, list, deadline));
    },
    // The folder's videos B站 marks 已失效, as MoonDigest's list has them: taken out one by one, so undo knows which.
    async clean_invalid({ from }, deadline) {
      const folder = folderOf(from, "from", false);
      const snap = (await chrome.storage.local.get(K.triageSnapshot(folder)))[K.triageSnapshot(folder)];
      if (!snap) throw bad(`MoonDigest has no list of folder ${folder}: sync it first (sync_favorites).`);
      const gone = new Set(Object.keys((await chrome.storage.local.get(K.triageDecisions(folder)))[K.triageDecisions(folder)] || {}));
      const items = (snap.items || []).filter((it) => it.invalid && it.aid && !gone.has(it.bvid)).slice(0, FAV_MAX);
      if (!items.length) return { op: "clean_invalid", from: folder, done: [], notDone: [] };
      return favDone({ op: "clean_invalid", from: folder }, items, (list) => unfav(folder, list, deadline));
    },
    async folder_create({ title, private: priv }) {
      const name = text(title ?? "", 20, "title");
      if (!name) throw bad("title is required.");
      const made = await TRIAGE_HANDLERS["triage-folder-create"]({ title: name, privacy: priv === true });
      const id = String(made.id);
      await editList((list) => [...list, { id: made.id, title: made.title, count: 0 }]).catch(() => {});
      return folderDone({ op: "folder_create", folder: id, after: { title: made.title, private: priv === true } });
    },
    async folder_rename({ folder, title }) {
      const id = folderOf(folder, "folder", false);
      const name = text(title ?? "", 20, "title");
      if (!name) throw bad("title is required.");
      const info = await folderInfo(id);
      await editFolder(id, info, { title: name });
      await renamed(id, name);
      return folderDone({ op: "folder_rename", folder: id, before: { title: info.title }, after: { title: name } });
    },
    async folder_privacy({ folder, private: priv }) {
      const id = folderOf(folder, "folder", false);
      if (typeof priv !== "boolean") throw bad("private must be true or false.");
      const info = await folderInfo(id);
      await editFolder(id, info, { privacy: priv ? 1 : 0 });
      return folderDone({ op: "folder_privacy", folder: id, before: { private: isPrivate(info) }, after: { private: priv } });
    },
    // B站's count can exceed what its list returns (videos deleted there stay counted, unseen): they go with the folder
    // and no undo brings them back, so the call says how many and wants acceptLoss before it deletes.
    async folder_delete({ folder, acceptLoss }, deadline) {
      const id = folderOf(folder, "folder", false);
      const info = await folderInfo(id);
      const { items, partial } = await TRIAGE_HANDLERS["triage-folder-items"]({ mediaId: id });
      if (partial) throw fail(`Folder ${id} could not be read whole (${partial.error}); nothing was deleted.`, "NETWORK");
      const hidden = Math.max(0, (Number(info.media_count) || 0) - items.length);
      if (hidden && acceptLoss !== true) {
        throw fail(`Nothing was deleted. B站 counts ${info.media_count} videos in 「${info.title}」 but lists ${items.length}: ${hidden} cannot be seen (most likely deleted videos) and would be gone for good, undo cannot bring them back. Tell the user; call again with acceptLoss: true to delete anyway.`, "HIDDEN_ITEMS");
      }
      // Reading the folder took the call's time: the caller has stopped waiting, so nothing is deleted behind its back.
      if (Date.now() > deadline - 5000) throw fail(`Reading folder ${id} took too long; nothing was deleted. Call again.`, "TIMEOUT");
      await triageBiliPost("/x/v3/fav/folder/del", { media_ids: id });
      await editList((list) => list.filter((f) => String(f.id) !== id)).catch(() => {});
      await MdgLimits.update(K.triageIncludedFolders, (cur) => (cur?.map(String).includes(id) ? cur.filter((f) => String(f) !== id) : undefined)).catch(() => {});
      return folderDone({ op: "folder_delete", folder: id, before: { title: info.title, private: isPrivate(info), intro: info.intro || "" }, items: items.filter((it) => it.aid), ...(hidden && { hidden }) });
    }
  };

  async function renamed(id, title) {
    await editList((list) => list.map((f) => (String(f.id) === id ? { ...f, title } : f))).catch(() => {});
    await R.lock(async () => {
      const key = K.triageSnapshot(id);
      const snap = (await chrome.storage.local.get(key))[key];
      if (snap) await chrome.storage.local.set({ [key]: { ...snap, title } });
    });
  }

  async function copyOrMove({ from, to, bvids }, move, deadline) {
    const src = folderOf(from, "from");
    const dest = folderOf(to, "to", false);
    if (src === dest) throw bad("to must be another folder.");
    const items = await itemsIn(src, bvidsOf(bvids));
    // Already in the target before this call: undo must leave them there. Asked of B站 (one request): a cached list
    // may be behind, and undo would then take out videos the user had there.
    const there = new Set(await triageFolderIds(dest, items));
    return favDone({ op: move ? "move" : "copy", from: src, to: dest, had: items.filter((it) => there.has(it.bvid)).map((it) => it.bvid) }, items, (list) => transfer(src, dest, list, move, deadline));
  }

  // A B站 write's result and journal entry: what landed is journaled even when a later request fails.
  async function favDone(entry, items, write) {
    let r;
    let error = null;
    try {
      r = await write(items);
    } catch (e) {
      r = { done: e.done || [] };
      error = e;
    }
    const done = r.done.map((it) => it.bvid);
    let undoId = "";
    if (done.length) {
      const e = { id: MdgTagCore.newTagId("a"), at: Date.now(), kind: "fav", n: done.length, ...entry, items: r.done, titles: { from: await titleOf(entry.from), ...(entry.to && { to: await titleOf(entry.to) }) } };
      if (e.had) e.had = e.had.filter((b) => done.includes(b));
      await journal(e).then(() => (undoId = e.id), () => {});
    }
    const went = new Set(done);
    const out = { op: entry.op, from: entry.from, ...(entry.to && { to: entry.to }), done, notDone: items.map((it) => it.bvid).filter((b) => !went.has(b)), ...(r.stopped && { stopped: r.stopped }), ...(undoId ? { undoId } : done.length && { noUndo: true }) };
    if (!error) return out;
    error.message += done.length ? ` Done before the failure, and kept (undo ${undoId || "is not possible"}): ${done.length} of ${items.length}.` : "";
    throw error;
  }
  async function folderDone(entry) {
    const e = { id: MdgTagCore.newTagId("a"), at: Date.now(), kind: "folder", n: entry.items?.length || 0, ...entry };
    let undoId = "";
    await journal(e).then(() => (undoId = e.id), () => {});
    return { op: entry.op, folder: entry.folder, ...(entry.after?.title && { title: entry.after.title }), ...(entry.hidden && { hiddenLost: entry.hidden }), ...(undoId ? { undoId } : { noUndo: true }) };
  }

  // Cut short, the rest of an undo stays journaled under the same id.
  // The ones B站 said no to stay journaled with the rest ("REFUSED" when nothing else stopped the run): the user may
  // make room or log in and undo again, and the record of what was taken is not lost.
  const restOf = (entry, r, items) => {
    const went = new Set(r.done.map((it) => it.bvid));
    const left = items.filter((it) => !went.has(it.bvid));
    const failed = r.failed?.length || 0;
    return { done: r.done.length, ...(failed && { failed }), ...(left.length && { left: left.length, stopped: r.stopped || (failed ? "REFUSED" : undefined), entry: { ...entry, items: left, n: left.length } }) };
  };
  const failRest = (entry, items) => (e) => {
    const went = new Set((e.done || []).map((it) => it.bvid));
    throw Object.assign(e, { rest: { ...entry, items: items.filter((it) => !went.has(it.bvid)) } });
  };

  async function undoFav(entry, deadline) {
    const { op, from, to, items } = entry;
    if (op === "unfav" || op === "clean_invalid") return restOf(entry, await refav(from, items, deadline).catch(failRest(entry, items)), items);
    // The ones the target held before stay in it: a 移动 gives them back to the source by 复制, a 复制 changed nothing.
    const had = new Set(entry.had || []);
    const fresh = items.filter((it) => !had.has(it.bvid));
    const old = op === "move" ? items.filter((it) => had.has(it.bvid)) : [];
    // 稍后再看 takes no 移动: each goes back into it, then out of the target.
    if (op === "move" && from === TOVIEW) {
      const r = await run(items, 1, deadline,
        async ([it]) => {
          await TRIAGE_HANDLERS["triage-refav"]({ mediaId: TOVIEW, aid: res(it) });
          if (!had.has(it.bvid)) await TRIAGE_HANDLERS["triage-unfav"]({ mediaId: to, aids: [res(it)] });
        },
        ([it]) => R.lock(async () => {
          await R.patchSnapshotNow(TOVIEW, { add: listed([it]) });
          if (!had.has(it.bvid)) await R.patchSnapshotNow(to, { drop: [it.bvid] });
        }), { skip: true }).catch(failRest(entry, items));
      return restOf(entry, r, items);
    }
    const first = await (op === "move" ? transfer(to, from, fresh, true, deadline) : remove(to, fresh, deadline)).catch(failRest(entry, items));
    const second = first.stopped || !old.length ? { done: [], stopped: first.stopped } : await transfer(to, from, old, false, deadline).catch(failRest(entry, [...old]));
    return restOf(entry, { done: [...first.done, ...second.done], stopped: first.stopped || second.stopped }, [...fresh, ...old]);
  }

  async function undoFolder(entry, deadline) {
    const { op, folder, before } = entry;
    if (op === "folder_create") {
      const info = await folderInfo(folder);
      if (Number(info.media_count) > 0) throw fail(`「${info.title}」里已经有 ${info.media_count} 个视频，没有删除`);
      await triageBiliPost("/x/v3/fav/folder/del", { media_ids: folder });
      await editList((list) => list.filter((f) => String(f.id) !== folder)).catch(() => {});
      return { done: 0 };
    }
    if (op === "folder_rename") {
      await editFolder(folder, await folderInfo(folder), { title: before.title });
      await renamed(folder, before.title);
      return { done: 0 };
    }
    if (op === "folder_privacy") {
      await editFolder(folder, await folderInfo(folder), { privacy: before.private ? 1 : 0 });
      return { done: 0 };
    }
    // A deleted folder comes back as a new one (a new id) with the videos its list held; made once, then filled.
    let e = entry;
    if (!e.remade) {
      const made = await TRIAGE_HANDLERS["triage-folder-create"]({ title: before.title, privacy: before.private });
      e = { ...entry, remade: String(made.id) };
      await editList((list) => [...list, { id: made.id, title: made.title, count: 0 }]).catch(() => {});
    }
    // Oldest first, so the newest favorite ends up on top as it was.
    const r = await refav(e.remade, [...e.items].reverse(), deadline).catch(failRest(e, e.items));
    return restOf(e, r, e.items);
  }

  async function favWrite(params, deadline) {
    const op = FAV_OPS[Object.hasOwn(FAV_OPS, params.op) ? params.op : ""];
    if (!op) throw bad(`op must be one of ${Object.keys(FAV_OPS).join(", ")}.`);
    return op(params, deadline);
  }

  // { folderId?, criteria? } → { folders: [{ id, title, criteria, tags: [{ name, rule?, videos }] }] } for the chosen
  // folders (or the one named). criteria sets folderId's 判断标准 ("" removes it): results judged by the old one then
  // count as stale in the 分拣台, so the answer says so and the change is journaled.
  async function triageSettings({ folderId, criteria }) {
    let changed = null;
    if (criteria !== undefined) {
      const id = folderOf(folderId, "folderId");
      const next = text(criteria, 1000, "criteria");
      let was = "";
      const wrote = await MdgLimits.update(K.triageFolderCriteria, (cur = {}) => {
        was = cur[id] || "";
        if (was === next) return undefined;
        const { [id]: _, ...others } = cur;
        return next ? { ...others, [id]: next } : others;
      });
      if (wrote) {
        const e = { id: MdgTagCore.newTagId("a"), at: Date.now(), kind: "criteria", n: 0, folder: id, before: was, after: next, titles: { from: await titleOf(id) } };
        changed = { folderId: id, was, ...(await journal(e).then(() => ({ undoId: e.id }), () => ({ noUndo: true }))) };
      }
    }
    const chosen = folderId == null ? await chosenIds() : [folderOf(folderId, "folderId")];
    const got = await chrome.storage.local.get([K.triageFolderCriteria, K.triageTags, K.triageVideoTags]);
    const uses = {};
    for (const ids of Object.values(got[K.triageVideoTags] || {})) for (const t of ids) uses[t] = (uses[t] || 0) + 1;
    const folders = [];
    for (const id of chosen) {
      folders.push({ id, title: await titleOf(id), criteria: got[K.triageFolderCriteria]?.[id] || "", tags: (got[K.triageTags] || []).filter((t) => String(t.folder) === id).map((t) => ({ name: t.name, ...(t.rule && { rule: t.rule }), videos: uses[t.id] || 0 })) });
    }
    return { folders, ...(changed && { changed }) };
  }

  // The journal for a tool and 设置 → MCP, newest first: what each call changed, in a line's worth of fields.
  async function log() {
    const list = (await chrome.storage.local.get(K.triageAgentLog))[K.triageAgentLog] || [];
    return { entries: list.map(({ id, at, kind = "triage", op, n, titles, before, after, folder }) => ({ id, at, kind, ...(op && { op }), n, ...(titles && { titles }), ...(folder && { folder }), ...(before?.title && { was: before.title }), ...(after?.title && { title: after.title }) })).reverse() };
  }

  // Writes run one at a time: two B站 batches at once would double the request rate, and an undo must not overtake
  // the write it undoes.
  let queue = Promise.resolve();
  const queued = (fn) => {
    const call = queue.then(fn);
    queue = call.catch(() => {});
    return call;
  };
  let writes = 0; // B站 writes started so far
  const method = (fn) => (params, deadline = Date.now() + 50_000) =>
    queued(async () => {
      if (Date.now() > deadline) throw fail("The call waited too long behind earlier ones.", "TIMEOUT");
      if (fn === favWrite || fn === undo) writes++;
      return fn(params && typeof params === "object" ? params : {}, deadline);
    }).then((data) => ({ ok: true, data }), (e) => ({ ok: false, error: String(e?.message || e), ...(e?.code ? { code: String(e.code) } : {}) }));
  // agent-sync.js saves a folder's list through the same queue, and only when no write started since it began reading
  // (writes): a list read before a write must not be saved after it.
  globalThis.MdgAgentQueue = Object.assign(queued, { writes: () => writes });
  MdgAgentBridge.addMethods({ triage: method(triage), favWrite: method(favWrite), undo: method(undo), log: method(log), triageSettings: method(triageSettings) });
  // 设置 → MCP and the 分拣台 (U) undo through the same queue, whatever the switch says now: the user takes back what
  // was written while it was on.
  if (globalThis.chrome?.runtime?.onMessage) {
    triageListen("", {
      "agent-undo": async (msg) => {
        const r = await method(undo)({ id: msg.id });
        if (r.ok) return r.data;
        throw fail(r.error, r.code);
      }
    });
  }
})();
