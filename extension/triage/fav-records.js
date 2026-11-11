// 收藏夹's stored records after a B站 write or a full read: a folder's cached list (triage_snapshot_<id>), 已出分拣范围
// (triage_removed), the left trail (triage_left) and the 取消收藏 records (triage_decisions_<id>). The 分拣台 page
// (fav-*.js) and the background (agent-writes.js, agent-sync.js) both change them through here, so a write an AI tool
// makes leaves the same records a write in the 分拣台 leaves. Storage only: no DOM, no page state; callers pass the
// folder titles and the other chosen folders. Loaded after limits.js and triage-core.js.
(() => {
  const K = MdgLimits.KEYS;
  const { updateRemoved, moveToRemoved, forgetLeft, noteLeft, unfavOnly, refreshElsewhere } = TriageCore;
  const TOVIEW = "toview";

  // Read-modify-writes of these records run one at a time across every 分拣台 tab and the background. A locked fn must
  // not lock again (it would wait on itself): the *Now functions are for a fn already inside.
  const lock = (fn) => MdgLimits.locked("mdg-triage-records", fn);

  // using(set): the functions writing through set(obj). The page's set notes its own writes and resolves false when
  // storage refuses (it has told the user); a function whose write was refused resolves null.
  const using = (set) => {
    // A folder's cached list follows a write: the target gains the videos (a new folder, created, starts with exactly
    // these), the source loses them without counting them as having left every folder. A folder with no cached list is
    // left to its first read.
    async function patchSnapshotNow(mediaId, { add = [], drop = [] }, { created = false, title } = {}) {
      const key = K.triageSnapshot(mediaId);
      const got = await chrome.storage.local.get([key, K.triageLeft]);
      const snap = got[key];
      if (!snap && !created) return;
      const old = snap || { bvids: [], invalid: [], titles: {}, items: [], ids: [], intro: "" };
      const gone = new Set(drop);
      const fresh = add.filter((it) => !old.bvids.includes(it.bvid));
      const added = fresh.map((it) => it.bvid);
      const keep = (b) => !gone.has(b);
      // The trail follows this move like a folder diff would: added here forgets this folder, dropped from here adds it.
      const left = { ...got[K.triageLeft] };
      for (const it of add) forgetLeft(left, it.bvid, String(mediaId));
      const folder = { id: String(mediaId), title: title ?? old.title ?? String(mediaId) };
      const at = Date.now();
      for (const b of drop) noteLeft(left, b, folder, at);
      await set({
        [K.triageLeft]: left,
        [key]: {
          ...old,
          bvids: [...added, ...old.bvids.filter(keep)],
          invalid: [...fresh.filter((it) => it.invalid).map((it) => it.bvid), ...(old.invalid || []).filter(keep)], // as saveNow
          titles: { ...old.titles, ...Object.fromEntries(fresh.map((it) => [it.bvid, it.title])) },
          items: [...fresh, ...(old.items || []).filter((it) => keep(it.bvid))],
          ids: old.ids ? [...added, ...old.ids.filter(keep)] : old.ids
        }
      });
    }

    // Moved to a folder outside triage: like any video that left every chosen folder, it goes to 已出分拣范围, marked with
    // where it went. from: { id, title }, or null from 已出分拣范围 itself; others: the chosen folders but from. Resolves
    // the new 已出分拣范围.
    async function movedNow(from, items, movedTo, others) {
      const got = await chrome.storage.local.get([K.triageRemoved, K.triageLeft, ...others.map(K.triageSnapshot)]);
      const otherBvids = new Set(others.flatMap((id) => got[K.triageSnapshot(id)]?.bvids || []));
      const { removed, left } = moveToRemoved(got[K.triageRemoved] || {}, got[K.triageLeft] || {}, items, otherBvids, from, Date.now(), movedTo);
      return (await set({ [K.triageRemoved]: removed, [K.triageLeft]: left })) === false ? null : removed;
    }

    // Back in a chosen folder: out of 已出分拣范围 (a hidden invalid one stays until its listing comes back).
    async function dropRemovedNow(bvids) {
      const rec = { ...(await chrome.storage.local.get(K.triageRemoved))[K.triageRemoved] };
      const back = bvids.filter((b) => rec[b] && !rec[b].hidden);
      if (!back.length) return;
      for (const b of back) delete rec[b];
      await set({ [K.triageRemoved]: rec });
    }

    // A folder's full new list replaces its cached one; videos that left every chosen folder go to 已出分拣范围. ids: the
    // folder's id list at this read (null when unread). Resolves the new 已出分拣范围.
    async function saveNow(mediaId, items, ids, { others, title, intro }) {
      const key = K.triageSnapshot(mediaId);
      const got = await chrome.storage.local.get([key, K.triageRemoved, K.triageLeft, ...others.map(K.triageSnapshot)]);
      const old = got[key];
      const oldItems = old?.items || (old?.bvids || []).map((bvid) => ({ bvid, title: old.titles?.[bvid] || bvid }));
      const otherBvids = new Set(others.flatMap((id) => got[K.triageSnapshot(id)]?.bvids || []));
      const { removed, left } = updateRemoved(got[K.triageRemoved] || {}, got[K.triageLeft] || {}, oldItems, items, otherBvids, Date.now(), ids, { id: String(mediaId), title: title ?? old?.title ?? String(mediaId) });
      const saved = await set({
        [key]: {
          bvids: items.map((it) => it.bvid),
          invalid: items.filter((it) => it.invalid).map((it) => it.bvid),
          titles: Object.fromEntries(items.map((it) => [it.bvid, it.title])),
          items,
          ids, // 所有收藏夹 compares the next id list with it
          intro: intro ?? old?.intro,
          title: title ?? old?.title // named in 已出分拣范围 after the folder is deleted on B站
        },
        [K.triageRemoved]: removed,
        [K.triageLeft]: left
      });
      return saved === false ? null : removed;
    }

    // One folder's 取消收藏 records: a null value deletes. Merged into the stored record, never written from a copy.
    // Resolves what was written.
    async function patchDecisionsNow(mediaId, patch) {
      const key = K.triageDecisions(mediaId);
      const stored = { ...(await chrome.storage.local.get(key))[key] };
      for (const [b, v] of Object.entries(patch)) {
        if (v) stored[b] = v;
        else delete stored[b];
      }
      const next = unfavOnly(stored);
      return (await set({ [key]: next })) === false ? null : next;
    }

    // A chosen folder's list changed: whether the other folders' 取消收藏 videos are still in a chosen folder follows the
    // cached lists. chosen: every chosen folder. Resolves { folderId: patch } of what changed, already written.
    async function refreshElsewhereNow(mediaId, chosen) {
      const targets = chosen.filter((id) => id !== String(mediaId));
      const sources = chosen.filter((id) => id !== TOVIEW);
      const got = await chrome.storage.local.get([...targets.map(K.triageDecisions), ...sources.map(K.triageSnapshot)]);
      const lists = Object.fromEntries(sources.map((id) => [id, got[K.triageSnapshot(id)]?.bvids || null]));
      const changed = refreshElsewhere(Object.fromEntries(targets.map((id) => [id, got[K.triageDecisions(id)]])), lists);
      for (const [id, patch] of Object.entries(changed)) await patchDecisionsNow(id, patch);
      return changed;
    }

    return { patchSnapshotNow, movedNow, saveNow, dropRemovedNow, patchDecisionsNow, refreshElsewhereNow };
  };

  // aid and title let 最近取消收藏 re-favorite the video after it has left the folder list. batch: when the batch that
  // made it started. elsewhere: still in another chosen folder.
  const unfavRecord = (it, at, batch, elsewhere) => ({ action: "unfav", at, aid: it.aid, ...(it.ogv && { ogv: true }), title: it.title, ...(batch && { batch }), ...(elsewhere && { elsewhere }) });

  globalThis.MdgFavRecords = { lock, using, unfavRecord, ...using((obj) => chrome.storage.local.set(obj)) };
})();
