"use strict";
// 收藏夹's reads: 观看进度, opening and reading a folder from B站, 已出分拣范围 and 所有收藏夹.

// ---------- 观看进度：看完了 ----------
const { SEEN_DEFAULTS, seenConfig, seenWords } = MdgSurfaces;
function setSeenCfg(v) {
  S.seenCfg = seenConfig(v);
  document.documentElement.dataset.seenStyle = S.seenCfg.style;
  // The background reads only what is new, at most every 10 minutes (triage-seen-sync); its writes come back through followSeen.
  if (S.seenCfg.on) seenSync(false);
}
// While this page waits on a read it shows the pages read so far; B站 risk control shows how long the background waits.
// A run started by a Bilibili page is joined when its first page lands. triage-seen-sync answers as a read starts, which
// then goes on in the background until triage-seen-done.
async function seenSync(force) {
  const r = S.seenRead;
  if (r.busy) return;
  r.busy = true;
  const res = await send({ type: "triage-seen-sync", force });
  r.busy = Boolean(res.data?.reading);
  if (res.data?.until) r.until = res.data.until;
  if (force && res.data?.skipped === "throttled") toast(runs.pill(["seen"])?.text || "");
  renderStatus();
}

// The background's read ended; one that failed (not on B站限流, which the pill counts down) says why.
function seenDone({ error }) {
  S.seenRead.busy = false;
  if (error) toast(`观看进度没有读完：${error}`, true);
  renderStatus();
}
function followSeenMeta(meta) {
  S.seenRead.pages = meta?.resume?.pages || 0;
  S.seenRead.until = meta?.backoffUntil || 0;
  if (S.seenRead.pages && !S.seenRead.busy && S.seenCfg.on) seenSync(false);
  renderStatus();
}
// Reads the listed videos' history entries not read yet; one key per video, so a folder costs a few KB.
async function loadSeen(run) {
  if (!S.seenCfg.on) return;
  const want = S.items.map((it) => it.bvid).filter((b) => !(b in S.seenPct));
  if (!want.length) return;
  const got = await chrome.storage.local.get(want.map(KEYS.seen));
  if (!run.alive) return;
  for (const b of want) S.seenPct[b] = got[KEYS.seen(b)] || null;
}
function followSeen(changes) {
  if (changes[KEYS.triageSeenMeta]) followSeenMeta(changes[KEYS.triageSeenMeta].newValue);
  let hit = false;
  for (const [key, c] of Object.entries(changes)) {
    if (!key.startsWith(KEYS.seenPrefix)) continue;
    S.seenPct[key.slice(KEYS.seenPrefix.length)] = c.newValue || null;
    hit = true;
  }
  if (hit && S.seenCfg.on) render();
}
// 稍后再看's own progress (seconds, or -1 once finished) as a percent; null without one.
function toviewPercent(it) {
  if (it.seen == null || it.seen === 0) return null;
  return it.seen < 0 ? 100 : it.duration > 0 ? Math.min(100, Math.round((it.seen / it.duration) * 100)) : null;
}
// Percent watched: the history's, else 稍后再看's own progress; null with no record or with the setting off.
const seenPercentOf = (it) => (S.seenCfg.on ? S.seenPct[it.bvid]?.[0] || toviewPercent(it) : null);
// 看完了: the history says at least the set share was watched (only while that mark is shown).
const isFinished = (it) => S.seenCfg.mark && (seenPercentOf(it) ?? 0) >= S.seenCfg.threshold;
// The cover with its progress bar and, once 看完了, the corner tag or the veil (html[data-seen-style] picks one).
// Below the share, a faint 看到 N% says how far it got.
function coverHtml(it) {
  const pic = `<img class="cover" src="${esc(img(it.cover, "480w_270h_1c"))}" alt="" loading="lazy" referrerpolicy="no-referrer" />`;
  const known = seenPercentOf(it);
  const p = S.seenCfg.bar ? known : null;
  const seen = isFinished(it);
  const faint = !seen && known && S.seenCfg.mark;
  const label = seenWords(known, seen);
  const mark = seen ? `<span class="seen-veil">${label}</span><span class="seen-tag">${label}</span>` : faint ? `<span class="seen-tag faint">${label}</span>` : "";
  // Once the user has decided, their decision replaces the AI's verdict label; the AI's reason and summary stay.
  const v = isProcessed(it.bvid) ? { verdict: "none" } : verdictOf(it);
  const tag = S.analyzing.has(it.bvid) ? `<span class="cover-tag running">${ANALYZING}</span>` : VERDICTS[v.verdict] ? `<span class="cover-tag ${v.verdict}" title="${esc(v.reason)}">${VERDICTS[v.verdict]}</span>` : "";
  const dur = it.duration ? `<span class="cover-dur">${fmtDuration(it.duration)}</span>` : "";
  // A real link for right-click 在新标签页中打开 and ⌘-click; a plain click selects the card. Out of the tab order: the title
  // is the same link for the keyboard, and the title is what plays.
  return `<a class="cover-wrap${seen ? " seen" : ""}" href="${esc(videoUrl(it.bvid))}" tabindex="-1" aria-hidden="true">${pic}${tag}${dur}${mark}${p ? `<span class="seen-bar" title="${label}"><i style="width:${Math.max(p, 2)}%"></i></span>` : ""}</a>`;
}

async function loadTagsAndCriteria() {
  const got = await chrome.storage.local.get([K.tags, K.videoTags, K.folderCriteria]);
  return { tags: got[K.tags] || [], videoTags: got[K.videoTags] || {}, folderCriteria: got[K.folderCriteria] || {} };
}

// The chosen folders other than exceptId, the ones whose cached lists keep a video out of 已出分拣范围. 稍后再看 missing
// from the list because its read failed is not deleted: it counts until the next read, if it is ticked.
function chosenOtherIds(exceptId) {
  const ids = S.folders.map((f) => String(f.id));
  if (S.toviewUnread && S.included.includes(TOVIEW) && !ids.includes(TOVIEW)) ids.push(TOVIEW);
  return ids.filter((id) => id !== String(exceptId));
}

// A folder that is no longer chosen (deleted on Bilibili or unticked) gets no new list to diff against, so its videos
// (unless in a chosen folder's list) move to 已出分拣范围 here and its records go. Runs once S.folders is known.
function retireUnchosenFolders() {
  return lockRecords(async () => {
    if (!S.allFolders.length) return; // 默认收藏夹 always exists; an empty list is never "every folder deleted"
    if (!S.included.length) return; // nothing chosen yet (or all unticked by accident): never empty every folder into 已出分拣范围
    const live = new Set(chosenOtherIds());
    const keys = (await MdgLimits.storageKeys(chrome.storage.local)).filter((k) => k.startsWith(KEYS.triageSnapshotPrefix));
    const gone = keys.map((k) => k.slice(KEYS.triageSnapshotPrefix.length)).filter((id) => !live.has(id));
    if (!gone.length) return;
    const got = await chrome.storage.local.get([K.removed, K.left, ...keys]);
    const otherBvids = new Set([...live].flatMap((id) => got[K.snapshot(id)]?.bvids || []));
    let out = { removed: got[K.removed] || {}, left: got[K.left] || {} };
    for (const id of gone) {
      const old = got[K.snapshot(id)];
      const oldItems = old?.items || (old?.bvids || []).map((bvid) => ({ bvid, title: old.titles?.[bvid] || bvid }));
      out = updateRemoved(out.removed, out.left, oldItems, [], otherBvids, Date.now(), null, { id, title: knownTitle(id) ?? old?.title ?? folderName(id) });
    }
    if (!(await store({ [K.removed]: out.removed, [K.left]: out.left }))) return; // keep the old lists until it is recorded
    await chrome.storage.local.remove(gone.flatMap((id) => [K.snapshot(id), K.decisions(id)]));
  });
}

// Opt-in: a new user starts with no folder chosen. The first load after this change keeps every folder for
// someone who already triaged (a snapshot exists).
async function loadIncluded() {
  let included;
  await MdgLimits.update(K.included, async (stored) => {
    if (Array.isArray(stored)) return void (included = stored);
    const keys = await MdgLimits.storageKeys(chrome.storage.local);
    // 稍后再看 missing from the list this time (its read failed) is still one of every folder.
    const every = [...S.allFolders.map((f) => String(f.id)), ...(S.toviewUnread ? [TOVIEW] : [])];
    return (included = keys.some((k) => k.startsWith(KEYS.triageSnapshotPrefix)) ? [...new Set(every)] : []);
  });
  return included;
}

// With 观看进度 off, the meta line still says how far 稍后再看 says each video was watched, in the covers' words.
function seenText(it) {
  const p = S.seenCfg.on ? null : toviewPercent(it);
  return p ? seenWords(p, false) : "";
}

// 「（p/P 页）」 while a folder of more than one page (UI.FAV_PAGE_SIZE videos each) loads.
function pageText(mediaId) {
  if (String(mediaId) === TOVIEW) return ""; // read in one request, no pages
  const pages = Math.ceil(Number(S.folders.find((f) => String(f.id) === String(mediaId))?.count || 0) / UI.FAV_PAGE_SIZE);
  const done = S.loadPage?.mediaId === String(mediaId) ? S.loadPage.page : 0;
  return pages > 1 ? `（${Math.min(done, pages)}/${pages} 页）` : "";
}
const loadingHtml = () => `<p class="empty">正在加载收藏夹…${pageText(S.mediaId)}</p>`;

// The folder list opens from the last one read (K.folderList) while B站's is read again: the last folder shows its
// snapshot at once. B站's list then only updates the folder select, and the folder open stays (its tab, filters and
// selection with it) while it is still chosen; 所有收藏夹 and 已出分拣范围 reopen when the chosen folders changed.
async function loadFolders() {
  // An AI setup banner stays until a run gets through (DESIGN), whatever reloads the folder list.
  if (el.banner.dataset.kind !== "ai") el.banner.hidden = true;
  const reading = send({ type: "triage-folders" });
  const cached = !S.allFolders.length && (await storeGet(K.folderList, null));
  if (cached?.folders) await showFolders(cached, false);
  else if (!S.mediaId) el.list.innerHTML = `<p class="empty">正在加载收藏夹列表…</p>`;
  const r = await reading;
  if (!r.ok) {
    S.foldersRead = MdgErrors.text(r);
    if (MdgErrors.action(r.code) !== "login") showBanner(`读取收藏夹失败：${S.foldersRead}`, MdgErrors.LABEL.retry, loadFolders); // send() showed 去登录
    if (!S.mediaId) el.list.innerHTML = `<p class="empty">无法读取收藏夹</p>`;
    return;
  }
  S.foldersRead = "";
  // A list missing 稍后再看 (its read failed) is not kept: the next open would lose it until B站 answered.
  if (!r.data.toviewUnread) storeSet(K.folderList, { mid: r.data.mid, folders: r.data.folders || [] });
  await showFolders(r.data, true);
}

// The folder list ({ mid, folders, toviewUnread? }) into the page; fresh: B站's own, which alone retires folders gone
// from it and says 稍后再看 was not read. Opens a folder when none is open, or when the one open is no longer chosen.
async function showFolders(data, fresh) {
  const before = S.folders.map((f) => String(f.id)).join();
  S.allFolders = data.folders || [];
  S.toviewUnread = Boolean(data.toviewUnread);
  S.mid = data.mid;
  S.included = (await loadIncluded()).map(String);
  // Its data stays (retireUnchosenFolders keeps it); say so, amber like any reminder that blocks nothing.
  if (fresh && S.toviewUnread && S.included.includes(TOVIEW)) showBanner("稍后再看这次没读到，点「重试」再读一次", MdgErrors.LABEL.retry, loadFolders, "toview");
  S.folders = S.allFolders.filter((f) => S.included.includes(String(f.id)));
  if (fresh) await retireUnchosenFolders();
  S.removedCount = Object.keys(await storeGet(K.removed, {})).length;
  // 所有收藏夹 leads and 已出分拣范围 closes the list; renderTop keeps their labels and visibility current.
  el.folderSelect.innerHTML =
    `<option value="${ALL}" title="把所有收藏夹合在一起看和搜索。第一次要逐个加载，收藏夹多时需要几分钟；之后只核对变化，很快">所有收藏夹</option><hr />` +
    S.folders.map((f) => `<option value="${esc(f.id)}"${f.cover ? ` data-cover="${esc(f.cover)}"` : ""}>${esc(f.title)} (${esc(f.count)})</option>`).join("") +
    `<hr /><option value="${REMOVED}" title="不在你勾选的收藏夹里、但 MoonDigest 还留着信息的视频：取消收藏的、在没勾选的收藏夹里的、已失效的">${REMOVED_NAME}</option>`;
  const open = String(S.mediaId || "");
  if (open) el.folderSelect.value = open;
  renderTop();
  if (!S.folders.length) {
    el.list.innerHTML = S.allFolders.length
      ? `<div class="empty pick-folders"><p><strong>先选要分拣的收藏夹</strong></p>
          <p>MoonDigest 只读取你勾选的收藏夹，没勾的不会读取里面的内容。<br>以后可以在「${SETTINGS_NAME}」里随时改。</p>
          <button type="button" class="primary" data-pick-folders>${PICK_FOLDERS}</button></div>`
      : `<p class="empty">${NO_FOLDERS}</p>`;
    return;
  }
  const changed = S.folders.map((f) => String(f.id)).join() !== before;
  if (open === ALL || open === REMOVED) return changed ? openFolder(open) : undefined;
  if (open && S.folders.some((f) => String(f.id) === open)) return render();
  // Back to the last real folder, else the first (默认收藏夹); 所有收藏夹 is slow to load, so it never opens by itself.
  const last = String(await storeGet(K.lastFolder, ""));
  const pick = String((S.folders.find((f) => String(f.id) === last) || S.folders[0]).id);
  el.folderSelect.value = pick;
  await openFolder(pick);
}

async function openFolder(mediaId) {
  // The folder left ends here: its reads in flight land nowhere. A later click during the decisions read wins the same way.
  const run = S.view.next();
  const all = mediaId === ALL;
  const removed = mediaId === REMOVED;
  S.mediaId = mediaId;
  S.decisions = {};
  S.folderDecisions = {};
  S.loadAll = null;
  S.removedCheck = null;
  setItems([]);
  S.selected.clear();
  S.tagFilter.clear();
  S.finishedFilter = S.dupFilter = false;
  S.tagState = "";
  S.aiRecentFilter = false;
  S.kindFilter = "";
  S.undo = [];
  S.focused = "";
  S.syncError = S.readError = "";
  hideSyncNotice();
  if (!all && !removed) storeSet(K.lastFolder, mediaId);
  el.folderSelect.value = mediaId;
  el.list.innerHTML = loadingHtml();
  // 已出分拣范围 shows 保留 too; its 取消收藏 is on each card's leaving line.
  const decisions = all ? {} : removed ? { ...S.kept } : { ...S.kept, ...(await storeGet(K.decisions(mediaId), {})) };
  if (!run.alive) return;
  S.decisions = decisions;
  let ok;
  if (all) ok = await openAll(run);
  else if (removed) ok = await openRemoved(run);
  else ok = (await openCached(run)) || (run.alive && (await syncFolder({ force: true })));
  // A failed first read (limit, offline) still leaves the last folder's step and chips behind; a later folder owns the page.
  if (!ok && !run.alive) return;
  S.tab = removed ? "read" : currentStage(stageCounts());
  S.classFilter = { coarse: "all", fine: "all", read: "all" };
  S.focused = visibleItems()[0]?.bvid || "";
  render();
}

// A folder with a cached list shows it at once; one light id request then decides whether it needs a full sync.
async function openCached(run) {
  const mediaId = S.mediaId;
  const toview = mediaId === TOVIEW;
  const snap = await storeGet(K.snapshot(mediaId), null);
  // Snapshots from before the intro was cached sync once, so the AI is not told an empty intro (稍后再看 has none).
  if (!run.alive || !snap?.items || (!toview && snap.intro === undefined)) return false;
  if (!toview) S.folderIntro[mediaId] = snap.intro;
  setItems([...snap.items]);
  if (!(await loadResults(run))) return false;
  // 稍后再看 is read in one request anyway, and its watch progress goes stale: it always syncs, behind its snapshot.
  if (toview) syncFolder({ force: true });
  else checkCached(run, snap);
  return true;
}

async function checkCached(run, snap) {
  if (fav.state().writing(S.mediaId)) return deferRead(() => quickSync({ force: true }));
  const r = await send({ type: "triage-folder-ids", mediaId: S.mediaId });
  if (!run.alive) return;
  if (!r.ok) syncFolder({ force: true });
  else if (!idsChanged(snap.ids || snap.bvids, r.data.bvids)) markRead(S.mediaId);
  else syncFolder({ force: true, cached: { snap, ids: r.data.bvids } });
}

// bvid → { item, from } for videos in another chosen folder's cached list (from: its id) or in 已出分拣范围 (from: REMOVED).
async function localItems(mediaId) {
  const others = chosenOtherIds(mediaId);
  const got = await chrome.storage.local.get([K.removed, ...others.map(K.snapshot)]);
  const local = new Map();
  for (const id of others) for (const item of got[K.snapshot(id)]?.items || []) if (!local.has(item.bvid)) local.set(item.bvid, { item, from: id });
  for (const [bvid, rec] of Object.entries(got[K.removed] || {})) if (!local.has(bvid)) local.set(bvid, { item: rec.item, from: REMOVED });
  return local;
}

// Changed ids without the full load: removed videos leave the cached list, added ones come from local when MoonDigest
// already holds them, and only truly new ones are fetched from the newest part of the list. null when an added id is
// found nowhere (a new favorite deep in the list), so the caller loads the whole folder.
async function fromCache(mediaId, { snap, ids }, local) {
  const old = snap.ids || snap.bvids;
  const oldSet = new Set(old);
  const added = ids.filter((b) => !oldSet.has(b));
  const moved = added.filter((b) => local.has(b)).map((b) => local.get(b).item);
  let head = [];
  let info = { intro: snap.intro };
  if (moved.length < added.length) {
    const r = await send({ type: "triage-folder-items", mediaId, known: [...snap.bvids, ...moved.map((it) => it.bvid)] });
    if (!r.ok || !r.data.head) return r;
    head = r.data.items;
    info = r.data.info || info;
  }
  const items = mergeHead(head, [...moved, ...snap.items], old, ids);
  return items && { ok: true, data: { items, ids, info } };
}

// A folder being written (fav.state().writing: a batch on it, or a write a moment ago) is not read; a read asked for
// meanwhile runs once it settles.
// The latest request replaces a waiting one (it may be for the folder opened since), except that a waiting full sync
// is not traded for the light check.
let deferredRead = null;
function deferRead(fn, full = false) {
  if (deferredRead?.full && deferredRead.run.alive && !full) return;
  clearTimeout(deferredRead?.timer);
  const run = S.view.current;
  const timer = setTimeout(() => {
    deferredRead = null;
    if (run.alive) fn();
  }, 1000);
  deferredRead = { timer, run, full };
}

// The light refresh (back on the tab, the player closed, a video re-favorited): check the id list and apply only the
// difference. 刷新 still loads the whole folder, which also catches videos that became invalid.
// Coming back to the tab fires both focus and visibilitychange: while one check runs, the other returns.
let quickChecking = null; // the view run of the check going on
async function quickSync({ force = false } = {}) {
  if (!force && (Date.now() - S.lastSyncAt < SYNC_MIN_GAP_MS || quickChecking?.alive)) return;
  const run = (quickChecking = S.view.current);
  try {
    const snap = S.mediaId === TOVIEW ? null : await storeGet(K.snapshot(S.mediaId), null);
    if (!run.alive) return;
    if (!snap?.items || snap.intro === undefined) syncFolder({ force });
    else await checkCached(run, snap);
  } finally {
    if (quickChecking === run) quickChecking = null;
  }
}

// A chosen folder other than the open one with a proposal waiting.
const otherAiFolder = () => Object.keys(S.ai.proposals).find((id) => id !== String(S.mediaId) && (id === ALL || S.folders.some((f) => String(f.id) === id)));

// The folder's list and its bvid lookup, always replaced together.
function setItems(list) {
  S.items = list;
  S.itemMap = new Map(list.map((it) => [it.bvid, it]));
}

// ---------- sync with bilibili ----------
// cached ({ snap, ids }, from checkCached) fetches only the newest pages and takes the rest from the cached list.
async function syncFolder({ force = false, cached = null } = {}) {
  // S.syncing is the running sync's view run, so a forced sync for a newly opened folder is not blocked by the old one.
  if (S.syncing?.alive || (!force && Date.now() - S.lastSyncAt < SYNC_MIN_GAP_MS)) return false;
  if (fav.state().writing(S.mediaId)) {
    deferRead(() => (cached ? quickSync({ force: true }) : syncFolder({ force: true })), !cached);
    return false;
  }
  const run = (S.syncing = S.view.current);
  S.loadPage = null;
  const mediaId = S.mediaId;
  const started = Date.now();
  renderTop();
  try {
    // Videos MoonDigest already holds from another chosen folder or 已出分拣范围: added here, they reuse that info.
    const local = await localItems(mediaId);
    if (!run.alive) return false;
    let r = cached ? await fromCache(mediaId, cached, local) : null;
    if (!run.alive) return false;
    r ||= await send({ type: "triage-folder-items", mediaId });
    if (!run.alive) return false;
    if (!r.ok) {
      const needLogin = MdgErrors.action(r.code) === "login"; // send() showed 去登录
      if (!needLogin) S.syncError = `刷新失败：${r.error}`;
      if (!S.items.length) {
        S.readError = needLogin ? "登录 B站后点刷新。" : r.error;
        renderList();
      }
      return false;
    }
    markRead(mediaId);
    S.syncError = S.readError = "";
    if (r.data.info) S.folderIntro[mediaId] = r.data.info.intro;
    const snap = await storeGet(K.snapshot(mediaId), null);
    if (!run.alive) return false;
    // A run that wrote here while the list was read makes it stale (it would bring moved videos back): read again later.
    if (fav.state().writing(mediaId, started)) {
      deferRead(() => syncFolder({ force: true }), true);
      return false;
    }
    const remote = keepInvalidInfo(r.data.items || [], snap?.items);
    // A partial list proves what exists, never what was removed, so it skips the removed diff and the snapshot.
    const partial = r.data.partial ? { ...r.data.partial, count: remote.length } : null;
    const remoteSet = new Set(remote.map((it) => it.bvid));
    const diff = { added: [], removed: [], invalid: [], restored: [] };
    const restored = new Set();

    for (const it of remote) {
      const dec = S.decisions[it.bvid];
      if (dec?.action === "unfav" && refavorited(it, dec)) {
        delete S.decisions[it.bvid];
        restored.add(it.bvid);
        diff.restored.push(it.title);
      }
    }
    if (snap) {
      const snapSet = new Set(snap.bvids);
      const snapInvalid = new Set(snap.invalid || []);
      for (const it of remote) {
        if (!snapSet.has(it.bvid) && !restored.has(it.bvid)) diff.added.push({ ...it, from: local.get(it.bvid)?.from });
        if (it.invalid && snapSet.has(it.bvid) && !snapInvalid.has(it.bvid)) diff.invalid.push(it.title);
      }
      // Still in the id list but no longer listed: Bilibili hid it as invalid.
      const ids = new Set(r.data.ids || []);
      for (const b of partial ? [] : snap.bvids) {
        if (!remoteSet.has(b) && S.decisions[b]?.action !== "unfav") (ids.has(b) ? diff.invalid : diff.removed).push(snap.titles?.[b] || b);
      }
    }
    if (restored.size) patchDecisions(mediaId, Object.fromEntries([...restored].map((b) => [b, null])));

    // Remote order, newly added first; keep items we unfavorited this session so undo stays possible,
    // and after a partial load keep everything the missing pages may still hold.
    const addedSet = new Set(diff.added.map((it) => it.bvid));
    const next = [...remote.filter((it) => addedSet.has(it.bvid)), ...remote.filter((it) => !addedSet.has(it.bvid))];
    for (const it of S.items) {
      if (!remoteSet.has(it.bvid) && (partial || S.decisions[it.bvid]?.action === "unfav")) next.push(it);
    }
    setItems(next);
    if (S.group?.mediaId === String(mediaId)) S.group.bvids = S.group.bvids.filter((b) => S.itemMap.has(b));
    for (const b of [...S.selected]) if (!S.itemMap.has(b)) S.selected.delete(b);

    if (!partial) await saveSnapshot(mediaId, remote, r.data.ids);
    if (!(await loadResults(run))) return false;
    showSyncNotice(diff, partial);
    render();
    return true;
  } finally {
    if (S.syncing === run) S.syncing = null;
    renderTop();
  }
}

// A read of the folder's list from B站 got through: kept, so a reopened page still says when.
function markRead(mediaId) {
  S.lastSyncAt = S.readAt[mediaId] = Date.now();
  storeSet(K.readAt, S.readAt);
}

// The full item list doubles as the 所有收藏夹 cache; bvids/invalid/titles drive the sync diff. Videos that left every
// chosen folder go to 已出分拣范围.
function saveSnapshot(mediaId, items, ids = null) {
  return lockRecords(async () => {
    const others = chosenOtherIds(mediaId);
    const got = await chrome.storage.local.get([K.snapshot(mediaId), K.removed, K.left, ...others.map(K.snapshot)]);
    const old = got[K.snapshot(mediaId)];
    const oldItems = old?.items || (old?.bvids || []).map((bvid) => ({ bvid, title: old.titles?.[bvid] || bvid }));
    const otherBvids = new Set(others.flatMap((id) => got[K.snapshot(id)]?.bvids || []));
    const { removed, left } = updateRemoved(got[K.removed] || {}, got[K.left] || {}, oldItems, items, otherBvids, Date.now(), ids, { id: String(mediaId), title: folderName(mediaId) });
    const saved = await store({
      [K.snapshot(mediaId)]: {
        bvids: items.map((it) => it.bvid),
        invalid: items.filter((it) => it.invalid).map((it) => it.bvid),
        titles: Object.fromEntries(items.map((it) => [it.bvid, it.title])),
        items,
        ids, // the folder's id list at this load; 所有收藏夹 compares the next id list with it
        intro: S.folderIntro[mediaId] ?? old?.intro,
        title: knownTitle(mediaId) ?? old?.title // named in 已出分拣范围 after the folder is deleted on B站
      },
      [K.removed]: removed,
      [K.left]: left
    });
    if (!saved) return;
    S.removedCount = Object.keys(removed).length;
    renderTop();
  });
}

// ---------- 已出分拣范围 ----------
// A folder's id list could not be read while checking it (已出分拣范围, 所有收藏夹); 已出分拣范围 adds how to retry.
const checkFailed = (id, error) => `核对「${folderName(id)}」失败：${error}`;
const RETRY_REFRESH = "，可点刷新重试";
async function openRemoved(run = S.view.current) {
  const keys = (await MdgLimits.storageKeys(chrome.storage.local)).filter((k) => k.startsWith(KEYS.triageDecisionsPrefix));
  const got = await chrome.storage.local.get([K.removed, ...keys]);
  if (!run.alive) return false;
  const rec = got[K.removed] || {};
  const decisionsByFolder = Object.fromEntries(keys.map((k) => [k.slice(KEYS.triageDecisionsPrefix.length), got[k]]));
  setItems(Object.values(rec)
    .sort((x, y) => y.at - x.at)
    .map(({ item, at, movedTo, hidden, inFolder, from }) => ({ ...item, removedAt: at, movedTo, hidden, inFolder, from: from || inferFrom(decisionsByFolder, item.bvid, folderName) })));
  if (!(await loadResults(run))) return false;
  checkRemoved(run);
  return true;
}

// Re-favorited videos leave 已出分拣范围 as soon as one chosen folder's id list has them again; then each one left is
// asked where it is now (checkWhere). Both are runs' "check": the count in the pill, a B站 limit counting down there and
// asking again, a failure in row 3 (S.removedCheck.error). Opening another folder ends them.
async function checkRemoved(run) {
  const ids = S.folders.map((f) => String(f.id));
  const alive = () => run.alive;
  S.removedCheck = { error: "" };
  // A check of an earlier opening ends once its request in flight lands.
  while (runs.busy("check") && alive()) await sleepWhile(50, () => true);
  let i = 0;
  const r = await runs.run("check", {
    total: ids.length,
    gap: 300,
    alive,
    line: (d, t) => `核对收藏夹 ${d}/${t}`,
    next: () => (i < ids.length ? { id: ids[i++] } : null),
    // A folder being written is checked next time; its list is changing now.
    act: ({ id }) => (fav.state().writing(id) ? { ok: true } : send({ type: "triage-folder-ids", mediaId: id })),
    async done(step, x) {
      if (!alive() || !x.data) return;
      await dropRemoved(x.data.bvids);
      render();
    }
  });
  if (!alive()) return;
  if (r.error) {
    S.removedCheck.error = `${checkFailed(ids[i - 1], r.error)}${RETRY_REFRESH}`;
    return render();
  }
  await checkWhere(run);
  if (alive() && !S.removedCheck.error) S.removedCheck = null;
  render();
}

// Asks Bilibili, per video, which folders hold it (not invalid ones: those are known, and records too old to have an aid
// are left as they are). Only folders not chosen count; one in a chosen folder is taken out by the next id check.
async function checkWhere(run) {
  if (!run.alive) return;
  const list = S.items.filter((it) => it.aid && kindOf(it) !== "invalid");
  const alive = () => run.alive;
  const found = {};
  let mid; // who is logged in, asked once per check (the first answer carries it)
  let i = 0;
  const r = await runs.run("check", {
    total: list.length,
    gap: 150,
    alive,
    line: (d, t) => `核对视频的收藏状态 ${d}/${t}`,
    next: () => (i < list.length ? { it: list[i++] } : null),
    act: ({ it }) => send({ type: "triage-fav-where", aid: favRes(it), mid }),
    done({ it }, x) {
      if (!alive()) return;
      mid ||= x.data?.mid;
      const folders = x.data?.folders || [];
      const out = folders.find((f) => !S.included.includes(String(f.id)));
      if (out || !folders.length) {
        it.inFolder = out ? { id: out.id, title: out.title } : null;
        found[it.bvid] = it.inFolder;
      }
      render();
    }
  });
  if (r.error && alive()) S.removedCheck.error = `核对《${shortTitle(list[i - 1])}》的收藏状态失败：${r.error}${RETRY_REFRESH}`;

  await lockRecords(async () => {
    const rec = await storeGet(K.removed, {});
    const hit = Object.keys(found).filter((b) => rec[b]);
    for (const b of hit) rec[b].inFolder = found[b];
    if (hit.length) await storeSet(K.removed, rec);
  });
}

// Drops these bvids from 已出分拣范围 (they are in a folder again); returns how many were there.
function dropRemoved(bvids) {
  return lockRecords(async () => {
    const rec = await storeGet(K.removed, {});
    // A hidden invalid video stays in the id list; only its listing coming back (updateRemoved) takes it out.
    const back = bvids.filter((b) => rec[b] && !rec[b].hidden);
    if (!back.length) return 0;
    for (const b of back) delete rec[b];
    await storeSet(K.removed, rec);
    S.removedCount = Object.keys(rec).length;
    if (S.mediaId === REMOVED) {
      setItems(S.items.filter((it) => !back.includes(it.bvid)));
    }
    return back.length;
  });
}

// Deletes what 分拣台 holds for these videos (AI results, 保留, note, 分拣 tags, 待播, 取消收藏 records) and their record.
// 摘读记录's 星标 and tags (KEYS.readingMarks) are its own and stay.
async function cleanRemoved(list) {
  if (!list.length) return;
  if (favBusyReason()) return toast(favBusyReason(), true);
  const one = list.length === 1 ? `《${shortTitle(list[0])}》` : `这 ${list.length} 个视频`;
  const body = `<p>删除${esc(one)}的 AI 判断、AI 总结、备注、分拣标签、保留标记、待播记录和取消收藏记录，无法撤销。摘读记录里的星标和标签会保留。删除后不能再从「处理完成」重新收藏。<br>${UI.CLEAN_BACKUP.ask}</p>`;
  if (!(await askConfirm(`清理${one}？`, body, `清理 ${list.length} 个`, { danger: true }))) return;
  return lockRecords(async () => {
    const bvids = list.map((it) => it.bvid);
    const set = new Set(bvids);
    const rec = await storeGet(K.removed, {});
    for (const b of bvids) {
      for (const map of [rec, S.notes, S.kept, S.analyses, S.titleRes]) delete map[b];
    }
    S.basket = S.basket.filter((x) => !set.has(x.bvid));
    const decisionKeys = (await MdgLimits.storageKeys(chrome.storage.local)).filter((k) => k.startsWith(KEYS.triageDecisionsPrefix));
    const decisions = await chrome.storage.local.get(decisionKeys);
    for (const map of [...Object.values(decisions), S.decisions, ...Object.values(S.folderDecisions)]) for (const b of bvids) delete map[b];
    noteOwnWrites(decisions);
    if (!(await store(decisions))) return;
    await chrome.storage.local.remove(bvids.flatMap((b) => [KEYS.triageTitle(b), KEYS.triageAnalysis(b)]));
    // Notes one at a time through the shared writer: a note the side panel saved meanwhile is kept.
    for (const b of bvids) {
      notePending.delete(b);
      await MdgLimits.saveVideoNote(b, "", (notes) => storeSet(K.notes, notes));
    }
    const write = { [K.removed]: rec, ...tagsDb.without(bvids), [K.kept]: S.kept, [K.basket]: S.basket };
    noteOwnWrites(write);
    if (!(await store(write))) return;
    S.removedCount = Object.keys(rec).length;
    setItems(S.items.filter((it) => !set.has(it.bvid)));
    toast(`已清理 ${list.length} 个视频`);
    render();
  });
}

// Reads cached 粗分/细看 results for listed videos not loaded yet; false when the folder changed meanwhile.
async function loadResults(run) {
  await loadSeen(run);
  if (!run.alive) return false;
  const missing = S.items.map((it) => it.bvid).filter((b) => !(b in S.titleRes) && !(b in S.analyses));
  if (!missing.length) return true;
  const [t, a] = await Promise.all([
    send({ type: "triage-title-get", bvids: missing }),
    send({ type: "triage-analysis-get", bvids: missing })
  ]);
  if (!run.alive) return false;
  // Results from before criteria were recorded count as made under this folder's current criteria: stamped under the
  // key's lock, and only while the stored one still has none (the background may have written a newer result meanwhile).
  const stamped = async (key, r) => {
    if (!inFolderView() || r.criteria !== undefined) return r;
    const c = criteria();
    let stored;
    const next = await MdgLimits.update(key, (now) => ((stored = now), now && now.criteria === undefined ? { ...now, criteria: c } : undefined)).catch((e) => storeFailed([key], e));
    return next || stored || r;
  };
  for (const b of missing) {
    if (t.ok && t.data?.[b]) S.titleRes[b] = await stamped(KEYS.triageTitle(b), t.data[b]);
    if (a.ok && a.data?.[b]) S.analyses[b] = await stamped(KEYS.triageAnalysis(b), a.data[b]);
  }
  if (!run.alive) return false;
  // Their cards would read as 未分析; the next load reads the missing ones again.
  const failed = [t, a].find((r) => !r.ok);
  if (failed) toast(`读取已有的 AI 判断失败：${MdgErrors.text(failed)}`, true);
  return true;
}

// ---------- 所有收藏夹 ----------
// Folders with a cached list (triage_snapshot_*.items) show at once, then each is checked against the folder's video ids
// (one light request) and re-fetched if they differ. Folders without a cache are fetched one by one in the background
// with the same loader and request interval as the rest of the page.
async function openAll(run = S.view.current) {
  const ids = S.folders.map((f) => String(f.id));
  const got = await chrome.storage.local.get(ids.flatMap((id) => [K.snapshot(id), K.decisions(id)]));
  if (!run.alive) return false;
  const lists = {};
  for (const f of S.folders) {
    const id = String(f.id);
    S.folderDecisions[id] = got[K.decisions(id)] || {};
    const snap = got[K.snapshot(id)];
    if (snap?.items) lists[id] = { items: snap.items, ids: snap.ids };
    else if (!Number(f.count)) lists[id] = { items: [] };
  }
  const check = ids.filter((id) => got[K.snapshot(id)]?.items);
  S.loadAll = { lists, check, checkTotal: check.length, queue: ids.filter((id) => !lists[id]), paused: false, running: false, error: "", partial: 0 };
  rebuildAll();
  if (!(await loadResults(run))) return false;
  runLoadAll(run);
  return true;
}

function rebuildAll() {
  const L = S.loadAll;
  const lists = S.folders.map((f) => String(f.id)).filter((id) => L.lists[id]).map((id) => ({ id, ...L.lists[id], decisions: S.folderDecisions[id] }));
  const items = mergeFolderItems(lists);
  const decisions = {};
  for (const it of items) if (S.kept[it.bvid]) decisions[it.bvid] = S.kept[it.bvid];
  // Keep videos unfavorited from every folder this session, so they sit in 处理完成 and U can undo.
  const have = new Set(items.map((it) => it.bvid));
  for (const it of S.items) {
    if (!have.has(it.bvid) && S.decisions[it.bvid]?.action === "unfav") {
      items.push(it);
      decisions[it.bvid] = S.decisions[it.bvid];
    }
  }
  setItems(items);
  S.decisions = decisions;
  for (const b of [...S.selected]) if (!S.itemMap.has(b)) S.selected.delete(b);
}

async function runLoadAll(run) {
  const L = S.loadAll;
  if (!L || L.running) return;
  const keepGoing = () => !L.paused && run.alive;
  L.running = true;
  L.error = "";
  render();
  while ((L.check.length || L.queue.length) && keepGoing()) {
    // Checks go first: they are light (~300 ms apart) and may add folders to the full-load queue.
    const next = L.check[0] ?? L.queue[0];
    if (fav.state().writing(next)) {
      // A folder being written waits at the back of its line.
      const line = L.check.length ? L.check : L.queue;
      line.push(line.shift());
      await sleepWhile(1000, keepGoing);
      continue;
    }
    if (L.check.length) {
      const id = L.check[0];
      const r = await send({ type: "triage-folder-ids", mediaId: id });
      if (!run.alive) return;
      if (runs.hold(r)) {
        await runs.wait("load", runs.hold(r), keepGoing);
        continue;
      }
      if (!r.ok) {
        L.error = checkFailed(id, r.error);
        L.paused = true;
        break;
      }
      L.check.shift();
      await dropRemoved(r.data.bvids);
      const list = L.lists[id];
      const bvids = list.items.map((it) => it.bvid);
      if (idsChanged(list.ids || bvids, r.data.bvids)) {
        // Only the difference, as in a single folder; the whole folder loads when that is not enough.
        const q = await fromCache(id, { snap: { ...list, bvids }, ids: r.data.bvids }, await localItems(id));
        if (!run.alive) return;
        // B站 risk control: wait, then check this folder again; a full read now would only be refused longer.
        if (q && runs.hold(q)) {
          await runs.wait("load", runs.hold(q), keepGoing);
          L.check.unshift(id);
          continue;
        }
        if (q?.ok && !q.data.partial) {
          L.lists[id] = { items: q.data.items, ids: q.data.ids };
          await saveSnapshot(id, q.data.items, q.data.ids);
          rebuildAll();
          if (!(await loadResults(run))) return;
        } else L.queue.push(id);
      }
      render();
      if (L.check.length || L.queue.length) await sleepWhile(300, keepGoing);
      continue;
    }
    const id = L.queue[0];
    S.loadPage = null;
    // The folder being read, for the pill; not the next one while waiting between two.
    L.current = id;
    renderStatus();
    const r = await send({ type: "triage-folder-items", mediaId: id });
    L.current = "";
    if (!run.alive) return;
    if (runs.hold(r)) {
      await runs.wait("load", runs.hold(r), keepGoing);
      continue;
    }
    if (!r.ok) {
      L.error = `「${folderName(id)}」加载失败：${r.error}`;

      L.paused = true;
      break;
    }
    L.queue.shift();
    const items = keepInvalidInfo(r.data.items || [], (await storeGet(K.snapshot(id), null))?.items);
    L.lists[id] = { items, ids: r.data.ids };
    // A partial list is still searchable but never becomes the cache, as in syncFolder.
    if (r.data.partial) L.partial++;
    else await saveSnapshot(id, items, r.data.ids);
    rebuildAll();
    if (!(await loadResults(run))) return;
    render();
    if (L.queue.length) await sleepWhile(S.settings.triageIntervalSec * 1000, keepGoing);
  }
  L.running = false;
  render();
}

// 刷新 in 所有收藏夹 re-fetches every folder; the cached lists stay visible until each one is replaced.
function refreshAll() {
  const L = S.loadAll;
  if (!L) return;
  L.queue = S.folders.map((f) => String(f.id));
  L.check = [];
  L.paused = false;
  L.partial = 0;
  runLoadAll(S.view.current);
}

// Row 3 of 所有收藏夹: what was loaded once done, else only a failure (the progress is in the pill, loadAllActivity).
function loadAllLine() {
  const L = S.loadAll;
  const n = S.folders.length;
  const partial = L.partial ? `（${L.partial} 个只加载了部分）` : "";
  if (!L.queue.length && !L.check.length) return `<span class="muted">${n} 个收藏夹 · ${S.items.length} 个视频${partial}</span>`;
  return L.error ? `<span class="fail-text">${esc(L.error)}</span>` : "";
}

// The pill's row while 所有收藏夹 checks or loads its folders: counts, the folder being read and its pages; 暂停 / 继续
// on it. runs adds the B站限流 countdown.
function loadAllActivity() {
  const L = S.loadAll;
  if (!L || (!L.queue.length && !L.check.length)) return null;
  const n = S.folders.length;
  const [verb, done, total] = L.check.length ? ["核对", L.checkTotal - L.check.length, L.checkTotal] : ["加载", n - L.queue.length, n];
  const now = L.current ? ` · 「${folderName(L.current)}」${pageText(L.current)}` : "";
  const text = L.paused ? `${verb}收藏夹 ${done}/${total} · 已暂停` : `${verb}收藏夹 ${done}/${total}${now}`;
  return { text, done, total, act: L.paused ? "all-resume" : "all-pause", actLabel: L.paused ? "继续" : "暂停" };
}

// The folder's name in B站's list; undefined once it is gone from there.
const knownTitle = (id) => S.allFolders.find((f) => String(f.id) === String(id))?.title;
const folderName = (id) => id === REMOVED ? REMOVED_NAME : id === ALL ? "所有收藏夹" : knownTitle(id) || String(id);
// The folder select's counts follow our own writes at once instead of waiting for the next folder-list load.
function bumpCount(id, delta) {
  const f = S.allFolders.find((x) => String(x.id) === String(id));
  if (!f || !delta) return;
  f.count = Math.max(0, Number(f.count || 0) + delta);
  const opt = el.folderSelect.querySelector?.(`option[value="${f.id}"]`);
  if (opt) opt.textContent = `${f.title} (${f.count})`;
}
// 所有收藏夹's batch 取消收藏 (and its undo) names the folder it is writing to now.
const unfavWhere = (run) => (run.folder && run.folder !== run.mediaId ? `「${folderName(run.folder)}」` : "");
const folderNames = (it) => it.folders.map(folderName).join("、");

// A video in several folders: pick which ones to unfavorite it from (all checked by default).
async function pickUnfavFolders(it) {
  const boxes = it.folders
    .map((f) => `<label class="toggle"><input type="checkbox" name="unfavFolder" value="${esc(f)}" checked /> ${esc(folderName(f))}</label>`)
    .join("");
  const ask = askConfirm(`取消收藏《${shortTitle(it)}》？`, `<p>这个视频在 ${it.folders.length} 个收藏夹里，从勾选的收藏夹取消收藏：</p>${boxes}`, "取消收藏", { danger: true });
  el.confirmBody.onchange = () => UI.setReason(el.confirmOk, el.confirmBody.querySelector("input:checked") ? "" : PICK_ONE);
  const ok = await ask;
  el.confirmBody.onchange = null;
  UI.setReason(el.confirmOk, "");
  return ok ? [...el.confirmBody.querySelectorAll("input:checked")].map((x) => x.value) : [];
}
// The 取消收藏 folder pickers' OK is off with nothing ticked.
const PICK_ONE = "至少勾选一个收藏夹";
// A batch 取消收藏's confirm, in one folder or several.
const unfavManyTitle = (n) => `在 B站取消收藏这 ${n} 个视频？`;
const unfavManyOk = (n) => `取消收藏 ${n} 个`;

// Row 1's sync pill (shared.js draws it, as in 关注). Declarations, not consts: init() runs above them.
function syncEls() {
  return { pill: el.syncViewBtn, notice: el.syncNotice, text: el.syncText, detail: el.syncDetail, close: el.syncCloseBtn };
}

function showSyncNotice(diff, partial) {
  const { added, removed, invalid, restored } = diff;
  if (!partial && !added.length && !removed.length && !invalid.length && !restored.length) {
    if (el.syncNotice.dataset.partial) hideSyncNotice();
    return;
  }
  el.syncNotice.dataset.partial = partial ? "1" : "";
  const where = (it) => (it.from === REMOVED ? `原在${REMOVED_NAME}` : `也在「${folderName(it.from)}」`);
  // [name, its list, whether the summary counts it, what the detail adds to the name]: the summary and the detail alike.
  const others = added.filter((it) => it.from);
  const groups = [
    ["新增", added.filter((it) => !it.from).map((it) => it.title), true],
    ["来自其他收藏夹", others.map((it) => `${it.title}（${where(it)}）`), others.length > 0],
    ["已在B站移除", removed, !partial],
    [KIND_NAME.invalid, invalid, true],
    ["恢复", restored, restored.length > 0, "（在B站重新收藏）"]
  ];
  const parts = groups.filter((g) => g[2]).map(([name, list]) => `${name} ${list.length}`);
  const head = partial ? `只加载了前 ${partial.count} 个（第 ${partial.page} 页失败：${partial.error}），可稍后再刷新。` : "";
  UI.setSync(syncEls(), {
    label: `已刷新${partial ? "（部分）" : ""} +${added.length}${partial ? "" : ` −${removed.length}`}`,
    text: `${head}刷新结果：${parts.join(" · ")}`,
    // A partial load is a notice to retry later, not a blocker: amber, per the color rules in tokens.css.
    warn: Boolean(partial),
    sections: groups.map(([name, list, , more = ""]) => [name + more, list])
  });
}

function hideSyncNotice() {
  UI.setSync(syncEls(), null);
}
