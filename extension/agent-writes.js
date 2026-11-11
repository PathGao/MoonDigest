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

  const journal = (entry) => MdgLimits.update(K.triageAgentLog, (log = []) => [...log, entry].slice(-LOG_MAX));

  // One journaled call undone (id; none: the newest). The entry is taken first, so a second undo of it (another page)
  // is refused. What could not be undone goes back into the journal: a failed write whole, a B站 undo cut short (the
  // call's time, B站's limit) with the videos still to do, so undoing it again goes on.
  async function undo({ id } = {}, deadline = Date.now() + 50_000) {
    let entry = null;
    await MdgLimits.update(K.triageAgentLog, (log = []) => {
      entry = (id == null ? log.at(-1) : log.find((e) => e.id === id)) || null;
      return entry ? log.filter((e) => e !== entry) : undefined;
    });
    if (!entry) throw fail(id == null ? "没有可以撤销的修改" : "这一步已经撤销过了");
    const back = (e) => MdgLimits.update(K.triageAgentLog, (log = []) => [...log, e].sort((x, y) => x.at - y.at)).catch(() => {});
    if (entry.kind === "criteria") {
      let skipped = 1;
      await MdgLimits.update(K.triageFolderCriteria, (cur = {}) => {
        if ((cur[entry.folder] || "") !== entry.after) return undefined;
        skipped = 0;
        const { [entry.folder]: _, ...others } = cur;
        return entry.before ? { ...others, [entry.folder]: entry.before } : others;
      }).catch(async (e) => {
        await back(entry);
        throw e;
      });
      return { id: entry.id, n: 1 - skipped, skipped };
    }
    if (entry.kind === "fav" || entry.kind === "folder") {
      let rest;
      try {
        rest = await (entry.kind === "fav" ? undoFav : undoFolder)(entry, deadline);
      } catch (e) {
        await back(e.rest || entry);
        throw e;
      }
      if (rest.entry) await back(rest.entry);
      return { id: entry.id, n: rest.done, skipped: 0, ...(rest.entry && { left: rest.left, ...(rest.stopped && { stopped: rest.stopped }) }) };
    }
    return undoTriage(entry);
  }

  // A triage's values still as the tool left them go back; one changed since stays (skipped).
  async function undoTriage(entry) {
    const { kept = {}, note = {}, title = {}, analysis = {}, tags = {} } = entry.changes;
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
    } catch (e) {
      await MdgLimits.update(K.triageAgentLog, (log = []) => [...log, entry].sort((x, y) => x.at - y.at)).catch(() => {});
      throw e;
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
  const ref = ({ bvid, aid, ogv, title }) => ({ bvid, aid, ...(ogv && { ogv: true }), title: title || "" });
  // The videos as the folder's cached list has them (its aid, 番剧 mark and title); a folder MoonDigest has no list of
  // gives only the aid its BV id encodes. One the cached list does not hold is refused: the list is stale, or the id wrong.
  async function itemsIn(folder, bvids) {
    const snap = (await chrome.storage.local.get(K.triageSnapshot(folder)))[K.triageSnapshot(folder)];
    if (!snap) return bvids.map((bvid) => ({ bvid, aid: triageBvToAv(bvid), title: "" }));
    const by = new Map((snap.items || []).map((it) => [it.bvid, it]));
    const missing = bvids.filter((b) => !by.get(b)?.aid);
    if (missing.length) throw bad(`Not in folder ${folder} as MoonDigest has it (sync_favorites reads it again): ${missing.join(", ")}.`);
    return bvids.map((b) => by.get(b));
  }

  // One run of B站 requests over items, a chunk per request, until the call's time or B站's limit ends it: send(chunk)
  // makes the request (triage-bg.js's handler, as the 分拣台 sends it), then landed(chunk, reply) keeps the local
  // records. Resolves { done: the items written, stopped?: "TIMEOUT" | "THROTTLED" }; another error is thrown with
  // .done, the items written before it.
  async function run(items, one, deadline, send, landed) {
    const size = one ? 1 : 20;
    const gap = one ? 300 : 1000;
    const done = [];
    for (let i = 0; i < items.length; i += size) {
      if (i) await sleep(gap);
      if (Date.now() > deadline - 8000) return { done, stopped: "TIMEOUT" };
      const chunk = items.slice(i, i + size);
      let reply;
      try {
        reply = await send(chunk);
      } catch (e) {
        if (e.code === MdgErrors.CODE.THROTTLED) return { done, stopped: "THROTTLED" };
        throw Object.assign(e, { done });
      }
      await landed(chunk, reply);
      done.push(...chunk);
    }
    return { done };
  }

  // 移动 / 复制 from → to, records kept as the 分拣台's transfer keeps them. Resolves run's result.
  async function transfer(from, to, items, move, deadline) {
    const [fromName, toName] = [await titleOf(from), await titleOf(to)];
    return run(items, from === TOVIEW, deadline,
      (chunk) => TRIAGE_HANDLERS["triage-transfer"]({ from, to, aids: chunk.map(res), move }),
      (chunk, reply) => R.lock(async () => {
        const chosen = await chosenIds();
        const inTo = chosen.includes(to);
        if (inTo) {
          await R.patchSnapshotNow(to, { add: chunk }, { title: toName });
          await R.dropRemovedNow(chunk.map((it) => it.bvid));
        }
        if (!move) return;
        const kept = new Set((reply?.stayed || []).map(String)); // B站 kept them in 稍后再看 too
        const left = chunk.filter((it) => !kept.has(String(res(it))));
        if (!left.length) return;
        await R.patchSnapshotNow(from, { drop: left.map((it) => it.bvid) }, { title: fromName });
        if (!inTo && chosen.includes(from)) await R.movedNow({ id: from, title: fromName }, left, { id: to, title: toName }, chosen.filter((id) => id !== from));
      }));
  }

  // Out of a folder with no 取消收藏 record (a 复制 undone): the cached list just loses them.
  const remove = (folder, items, deadline) =>
    run(items, folder === TOVIEW, deadline,
      (chunk) => TRIAGE_HANDLERS["triage-unfav"]({ mediaId: folder, aids: chunk.map(res) }),
      (chunk) => R.lock(() => R.patchSnapshotNow(folder, { drop: chunk.map((it) => it.bvid) })));

  // 取消收藏, recorded as the 分拣台's batch is: the folder's 最近取消收藏 lists them.
  async function unfav(folder, items, deadline) {
    const batch = Date.now();
    const chosen = await chosenIds();
    const others = chosen.filter((id) => id !== folder && id !== TOVIEW);
    const got = await chrome.storage.local.get(others.map(K.triageSnapshot));
    const elsewhere = new Set(others.flatMap((id) => got[K.triageSnapshot(id)]?.bvids || []));
    return run(items, folder === TOVIEW, deadline,
      (chunk) => TRIAGE_HANDLERS["triage-unfav"]({ mediaId: folder, aids: chunk.map(res) }),
      (chunk) => chosen.includes(folder) && R.lock(() => R.patchDecisionsNow(folder, Object.fromEntries(chunk.map((it) => [it.bvid, R.unfavRecord(it, Date.now(), batch, elsewhere.has(it.bvid))])))));
  }

  // Back into the folder, one per request (B站 has no batch for it); its 取消收藏 record goes.
  const refav = (folder, items, deadline) =>
    run(items, true, deadline,
      ([it]) => TRIAGE_HANDLERS["triage-refav"]({ mediaId: folder, aid: res(it) }),
      ([it]) => R.lock(async () => {
        await R.patchDecisionsNow(folder, { [it.bvid]: null });
        await R.patchSnapshotNow(folder, { add: [it] });
        await R.dropRemovedNow([it.bvid]);
      }));

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
    async folder_delete({ folder, acceptLoss }) {
      const id = folderOf(folder, "folder", false);
      const info = await folderInfo(id);
      const { items, partial } = await TRIAGE_HANDLERS["triage-folder-items"]({ mediaId: id });
      if (partial) throw fail(`Folder ${id} could not be read whole (${partial.error}); nothing was deleted.`, "NETWORK");
      const hidden = Math.max(0, (Number(info.media_count) || 0) - items.length);
      if (hidden && acceptLoss !== true) {
        throw fail(`Nothing was deleted. B站 counts ${info.media_count} videos in 「${info.title}」 but lists ${items.length}: ${hidden} cannot be seen (most likely deleted videos) and would be gone for good, undo cannot bring them back. Tell the user; call again with acceptLoss: true to delete anyway.`, "HIDDEN_ITEMS");
      }
      await triageBiliPost("/x/v3/fav/folder/del", { media_ids: id });
      await editList((list) => list.filter((f) => String(f.id) !== id)).catch(() => {});
      await MdgLimits.update(K.triageIncludedFolders, (cur) => (cur?.map(String).includes(id) ? cur.filter((f) => String(f) !== id) : undefined)).catch(() => {});
      return folderDone({ op: "folder_delete", folder: id, before: { title: info.title, private: isPrivate(info), intro: info.intro || "" }, items: items.filter((it) => it.aid).map(ref), ...(hidden && { hidden }) });
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
    // Already in the target before this call: undo must leave them there.
    const snap = (await chrome.storage.local.get(K.triageSnapshot(dest)))[K.triageSnapshot(dest)];
    const there = new Set(snap?.bvids || (await triageFolderIds(dest)));
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
      const e = { id: MdgTagCore.newTagId("a"), at: Date.now(), kind: "fav", n: done.length, ...entry, items: r.done.map(ref), titles: { from: await titleOf(entry.from), ...(entry.to && { to: await titleOf(entry.to) }) } };
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
  const restOf = (entry, r, items) => {
    const went = new Set(r.done.map((it) => it.bvid));
    const left = items.filter((it) => !went.has(it.bvid));
    return { done: r.done.length, ...(left.length && { left: left.length, stopped: r.stopped, entry: { ...entry, items: left, n: left.length } }) };
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
    const todo = [...e.items].reverse();
    const r = await refav(e.remade, todo, deadline).catch((err) => failRest(e, todo)(err));
    const rest = restOf(e, r, todo);
    if (rest.entry) rest.entry.items = rest.entry.items.reverse();
    return rest;
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
  const method = (fn) => (params, deadline = Date.now() + 50_000) => {
    const call = queue.then(async () => {
      if (Date.now() > deadline) throw fail("The call waited too long behind earlier ones.", "TIMEOUT");
      return fn(params && typeof params === "object" ? params : {}, deadline);
    });
    queue = call.catch(() => {});
    return call.then((data) => ({ ok: true, data }), (e) => ({ ok: false, error: String(e?.message || e), ...(e?.code ? { code: String(e.code) } : {}) }));
  };
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
