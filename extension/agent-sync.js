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
    const key = K.triageSnapshot(id);
    const old = (await chrome.storage.local.get(key))[key];
    if (old && id !== TRIAGE_TOVIEW) {
      const ids = await triageFolderIds(id);
      if (!TriageCore.idsChanged(old.ids || old.bvids || [], ids)) return "unchanged";
    }
    const r = await TRIAGE_HANDLERS["triage-folder-items"]({ mediaId: id });
    if (r.partial) return "partial";
    const items = TriageCore.keepInvalidInfo(r.items, old?.items);
    await R.lock(async () => {
      // Read again inside the lock: a folder unticked meanwhile is not saved back.
      const now = await included();
      if (!now.includes(id)) return;
      await R.saveNow(id, items, r.ids ?? null, { others: now.filter((f) => f !== id), title: r.info?.title || title, intro: r.info?.intro });
      await R.refreshElsewhereNow(id, now);
    });
    return "read";
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
      await MdgLimits.update(K.triageIncludedFolders, (cur) => {
        const next = [...new Set([...(cur || []).map(String).filter((id) => !drop.includes(id)), ...add])];
        return next.length === (cur || []).length && next.every((id, i) => id === String(cur[i])) ? undefined : next;
      });
      if (drop.length) notes.push(`Unticked: ${drop.join(", ")}. The 分拣台 drops their copies and their 取消收藏 records the next time it is open, and their videos that are in no other ticked folder go to 已出分拣范围. AI verdicts, notes and tags stay. Tell the user.`);
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

  MdgAgentBridge.addMethods({
    sync: (params) => sync(params && typeof params === "object" ? params : {}).then((data) => ({ ok: true, data }), (e) => ({ ok: false, error: String(e?.message || e), ...(e?.code ? { code: String(e.code) } : {}) }))
  });
})();
