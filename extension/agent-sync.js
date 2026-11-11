// MoonDigest's agent interface, docs/AGENT.md §2 sync: which B站 folders the 分拣台 keeps a copy of (ticked in 收藏夹设置),
// and reading those copies from B站 in the background, without the 分拣台 page open. The copies are saved through
// fav-records.js, as the page saves them. The worker loads it after triage-bg.js and fav-records.js.
(() => {
  const K = MdgLimits.KEYS;
  const R = MdgFavRecords;
  const fail = (message, code) => Object.assign(new Error(message), code ? { code } : {});
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const PAGE_GAP_MS = 300; // between two folders' id checks, as the 分拣台's 所有收藏夹
  const included = async () => ((await chrome.storage.local.get(K.triageIncludedFolders))[K.triageIncludedFolders] || []).map(String);

  // The one read in flight (or the last one): { running, total, done, current, read, unchanged, partial, stopped?, error? }.
  // In memory: a restarted worker has no read running.
  let job = null;

  // One folder: unchanged when B站's id list still equals the copy's (one request), else read whole and saved. A list
  // B站 cut short is not saved: a partial list must not pass for the folder.
  async function readFolder(id, title) {
    const writes = MdgAgentQueue.writes();
    const key = K.triageSnapshot(id);
    const old = (await chrome.storage.local.get(key))[key];
    if (old && id !== TRIAGE_TOVIEW) {
      const ids = await triageFolderIds(id);
      if (!TriageCore.idsChanged(old.ids || old.bvids || [], ids)) return "unchanged";
    }
    const r = await TRIAGE_HANDLERS["triage-folder-items"]({ mediaId: id });
    if (r.partial) return "partial";
    const items = TriageCore.keepInvalidInfo(r.items, old?.items);
    // Saved in the Agent's write queue, and not at all when a write started while this was reading: the list may be from
    // before it. The read itself stays outside the queue, so a long folder holds up no write or undo.
    return MdgAgentQueue(async () => {
      if (MdgAgentQueue.writes() !== writes) return "partial";
      await R.lock(async () => {
        // Read again inside the lock: a folder unticked meanwhile is not saved back.
        const now = await included();
        if (!now.includes(id)) return;
        await R.saveNow(id, items, r.ids ?? null, { others: now.filter((f) => f !== id), title: r.info?.title || title, intro: r.info?.intro });
        await R.refreshElsewhereNow(id, now);
      });
      return "read";
    });
  }

  async function runJob(ids, titles, gapMs) {
    const mine = (job = { running: true, total: ids.length, done: 0, current: "", read: 0, unchanged: 0, partial: [] });
    try {
      for (const id of ids) {
        if (!(await included()).includes(id)) {
          mine.done++;
          continue;
        }
        mine.current = id;
        const was = await readFolder(id, titles[id]);
        if (was === "partial") mine.partial.push(id);
        else mine[was]++;
        mine.done++;
        if (mine.done < ids.length) await sleep(was === "unchanged" ? PAGE_GAP_MS : gapMs);
      }
    } catch (e) {
      if (e.code === MdgErrors.CODE.THROTTLED) mine.stopped = "THROTTLED";
      else mine.error = String(e?.message || e);
    } finally {
      mine.running = false;
      mine.current = "";
    }
  }

  // { include?, exclude?, start?, folders? } → { folders: [{ id, title, count, private?, included?, synced? }], job?, notes? }.
  // include / exclude tick and untick folders (the 分拣台's 收藏夹设置). start reads the ticked folders (or those of
  // folders) in the background and answers at once; call again with no parameters for the progress.
  async function sync({ include, exclude, start, folders }) {
    const ids = (v, name) => {
      if (v == null) return [];
      if (!Array.isArray(v) || !v.every(triageFolderId)) throw fail(`${name} must be a list of folder ids from get_favorites (or toview).`, "BAD_PARAMS");
      return v.map(String);
    };
    const add = ids(include, "include");
    const drop = ids(exclude, "exclude");
    const only = ids(folders, "folders");
    if (add.some((id) => drop.includes(id))) throw fail("A folder cannot be in both include and exclude.", "BAD_PARAMS");
    const list = await triageCreatedFolders();
    const known = new Set(list.folders.map((f) => String(f.id)));
    const unknown = [...add, ...only].filter((id) => !known.has(id));
    if (unknown.length) throw fail(`Not one of the user's folders: ${unknown.join(", ")}.`, "BAD_PARAMS");
    const notes = [];
    if (add.length || drop.length) {
      // The 取消收藏 records an unticked folder loses, read before the 分拣台 can drop them: undo puts them back.
      const records = await chrome.storage.local.get(drop.map(K.triageDecisions));
      let gone = [];
      await MdgLimits.update(K.triageIncludedFolders, (cur) => {
        const was = (cur || []).map(String);
        gone = drop.filter((id) => was.includes(id));
        const next = [...new Set([...was.filter((id) => !drop.includes(id)), ...add])];
        return next.length === was.length && next.every((id, i) => id === was[i]) ? undefined : next;
      });
      if (gone.length) {
        const names = list.folders.filter((f) => gone.includes(String(f.id))).map((f) => f.title).join("、");
        const undoId = await MdgAgentJournal.add({ kind: "scope", n: gone.length, dropped: gone, decisions: Object.fromEntries(gone.map((id) => [id, records[K.triageDecisions(id)] || {}])), titles: { from: names } }).catch(() => "");
        notes.push(`Unticked: ${gone.join(", ")}. The 分拣台 drops their copies and their 取消收藏 records the next time it is open, and their videos that are in no other ticked folder go to 已出分拣范围. AI verdicts, notes and tags stay. Tell the user.${undoId ? ` Undo: undo {"id":"${undoId}"} ticks them again and puts those records back.` : ""}`);
      }
    }
    if (!list.toviewUnread) await chrome.storage.local.set({ [K.triageFolderList]: { mid: list.mid, folders: list.folders } }).catch(() => {});
    const chosen = await included();
    if (start === true) {
      if (job?.running) notes.push("A read is already running; this call did not start another.");
      else {
        const todo = (only.length ? only : chosen).filter((id) => chosen.includes(id) && known.has(id));
        const skipped = only.filter((id) => !chosen.includes(id));
        if (skipped.length) notes.push(`Not ticked, so not read: ${skipped.join(", ")}. Tick them with include first.`);
        const gapMs = TriageUi.numSetting("interval", (await chrome.storage.sync.get("triageIntervalSec")).triageIntervalSec) * 1000;
        if (todo.length) runJob(todo, Object.fromEntries(list.folders.map((f) => [String(f.id), f.title])), gapMs);
      }
    }
    const got = await chrome.storage.local.get(list.folders.map((f) => K.triageSnapshot(f.id)));
    return {
      folders: list.folders.map((f) => {
        const snap = got[K.triageSnapshot(f.id)];
        return { id: String(f.id), title: f.title || "", count: Number(f.count) || 0, ...(f.private && { private: true }), ...(chosen.includes(String(f.id)) && { included: true, ...(snap && { synced: snap.bvids?.length || 0 }) }) };
      }),
      ...(job && { job: { ...job, partial: [...job.partial] } }),
      ...(notes.length && { notes })
    };
  }

  // An untick undone: ticked again, and the 取消收藏 records the 分拣台 dropped meanwhile are back. The copy is read again
  // by the next sync; videos gone to 已出分拣范围 return when the 分拣台 opens (it takes back a ticked folder's).
  MdgAgentJournal.undoer("scope", async (e) => {
    await MdgLimits.update(K.triageIncludedFolders, (cur) => [...new Set([...(cur || []).map(String), ...e.dropped])]);
    await R.lock(async () => {
      const got = await chrome.storage.local.get(e.dropped.map(K.triageDecisions));
      const back = Object.fromEntries(e.dropped.filter((id) => !got[K.triageDecisions(id)] && Object.keys(e.decisions?.[id] || {}).length).map((id) => [K.triageDecisions(id), e.decisions[id]]));
      if (Object.keys(back).length) await chrome.storage.local.set(back);
    });
    return { done: 0 };
  });

  MdgAgentBridge.addMethods({
    sync: (params) => sync(params && typeof params === "object" ? params : {}).then((data) => ({ ok: true, data }), (e) => ({ ok: false, error: String(e?.message || e), ...(e?.code ? { code: String(e.code) } : {}) }))
  });
})();
