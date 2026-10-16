"use strict";
// 收藏夹's page, a classic script: its names are the page's globals, shared with the other fav-*.js. triage.html loads
// it before the module triage.js, which starts it (init) once the dev preview's mock is in.

// ---------- init ----------
// 关注 mode (follow.js) borrows the viewer, the toast and the confirm dialog, keeps its undo steps here (S.modeUndo) and
// takes the keys while on.
const followMode = () => Boolean(document.body?.classList.contains("follow-mode"));
// modeKeys(key, e): null while that mode is off (the keys below run); otherwise true when it used the key.
let modeKeys = null;
// 关注's 「UP 标签」 line, redrawn with the 「视频标签」 line.
let viewerHook = null;
globalThis.MoonTriage = {
  openViewer, closeViewer, toast, askConfirm, send, openOptions, store, runAiBatches, hold: (r) => THROTTLES[r.code] || null, viewing: () => S.viewing,
  // The playing 收藏夹 video's UP as { mid, name } (mid "" on items saved before it was stored); null in 关注 or with
  // nothing playing.
  viewingUp() {
    const it = !followMode() && S.viewer?.item;
    return it ? { mid: it.upperMid || "", name: it.upper || "" } : null;
  },
  // 关注's 没登录: the same 去登录 banner as 收藏夹's; off hides it only when it is that one.
  loginBanner(on) {
    if (on) showLogin();
    else if (el.banner.dataset.kind === "login") el.banner.hidden = true;
  },
  undo, pushUndo, dropModeUndo: (drop) => (S.modeUndo = S.modeUndo.filter((e) => !drop(e))), help: () => el.helpDialog.showModal(), setModeKeys: (fn) => (modeKeys = fn), setViewerHook: (fn) => (viewerHook = fn)
};

// A failed start (a storage read, say) says so in the list instead of leaving the page blank.
async function init() {
  try {
    await start();
  } catch (e) {
    console.error("[triage] start failed", e);
    el.list.innerHTML = UI.emptyState("分拣台启动失败", `${MdgErrors.text({ error: e?.message })}。刷新网页再试。`);
  }
}
async function start() {
  UI.fillSetRows(document);
  UI.clampNumbers(document);
  bindEvents();
  // Read up front: sidePanel.open must run inside the click's user gesture, before any await.
  chrome.tabs.getCurrent().then((tab) => (ownTabId = tab?.id));
  const [{ tags, videoTags, folderCriteria }, kept, basket, notes, settingsResp, aiHistory, aiRecent, sortBy, readAt, aiProposals] = await Promise.all([
    loadTagsAndCriteria(),
    storeGet(K.kept, {}),
    storeGet(K.basket, []),
    storeGet(K.notes, {}),
    send({ type: "triage-settings-get" }),
    storeGet(K.aiHistory, []),
    storeGet(K.aiRecent, {}),
    storeGet(K.sort, {}),
    storeGet(K.readAt, {}),
    storeGet(K.aiProposals, {})
  ]);
  Object.assign(S, { tags, videoTags, folderCriteria, kept, notes, aiHistory, aiRecent, sortBy, readAt });
  S.ai.proposals = aiProposals;
  pruneAiProposals();
  S.basket = basket.map(({ bvid, title, cover, upper, duration, opened }) => ({ bvid, title, cover, upper, duration, ...(opened ? { opened: true } : {}) }));
  if (settingsResp.ok) Object.assign(S.settings, settingsResp.data);
  renderTagLimit();
  // Stored values, raw: the switch reads through normalizeSwitches like everywhere else.
  const syncObsidian = (stored) => document.body.classList.toggle("obsidian-off", !MdgSettings.normalizeSwitches(stored).obsidianEnabled);
  const sync = await chrome.storage.sync.get({ obsidianEnabled: MdgSettings.DEFAULTS.obsidianEnabled, ...SEEN_DEFAULTS });
  syncObsidian(sync);
  setSeenCfg(sync);
  followSeenMeta(await storeGet(KEYS.triageSeenMeta));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && changes.obsidianEnabled) syncObsidian({ obsidianEnabled: changes.obsidianEnabled.newValue });
    if (area === "sync" && Object.keys(SEEN_DEFAULTS).some((k) => changes[k])) {
      chrome.storage.sync.get(SEEN_DEFAULTS).then((v) => {
        setSeenCfg(v);
        loadSeen(S.folderToken).then(render);
      });
    }
    if (area === "local") followSeen(changes);
    if (area === "local") followNotes(changes);
    if (area === "local") followShared(changes);
    if (area === "local") followIncluded(changes);
  });
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "triage-seen-done") return seenDone(msg);
    if (msg?.type !== "triage-folder-page") return;
    S.loadPage = { mediaId: msg.mediaId, page: msg.page };
    renderTop();
    if (S.loadAll) renderListHeader(visibleItems());
    else if (!S.items.length && msg.mediaId === String(S.mediaId)) el.list.innerHTML = loadingHtml();
  });
  renderBasket();
  await loadFolders();
  setInterval(tick, 1000);
}

// A new folder choice (收藏夹设置, or 导入设置 on the options page, which writes it here): the folder list reloads and
// newly ticked folders take back their videos; unticked ones move theirs to 已出分拣范围 (retireUnchosenFolders).
async function applyIncluded(included) {
  const ticked = included.filter((id) => !S.included.includes(id));
  await loadFolders();
  recoverRemoved(ticked);
}
function followIncluded(changes) {
  const c = changes[K.included];
  if (!c || ownEcho(K.included, c) || !S.allFolders.length) return;
  const included = (c.newValue || []).map(String);
  if (included.length === S.included.length && included.every((id) => S.included.includes(id))) return;
  applyIncluded(included);
}

// Another triage tab wrote one of the lists every page writes whole: take its value, so the next
// write here does not put back what it removed. This page's own writes come back as events too and are skipped: an
// older one arriving after a newer edit would undo that edit.
const SHARED = { kept: {}, videoTags: {}, tags: [], basket: [], folderCriteria: {}, aiRecent: {} };
function followShared(changes) {
  let changed = false;
  for (const [name, empty] of Object.entries(SHARED)) {
    const c = changes[K[name]];
    if (!c) continue;
    if (ownEcho(K[name], c)) continue;
    const value = c.newValue ?? structuredClone(empty);
    if (name === "kept") followKept(value);
    else S[name] = value;
    changed = true;
  }
  // 取消收藏 records: the open folder's, as openFolder builds them; in 所有收藏夹 those of the loaded folders.
  for (const [key, c] of Object.entries(changes)) {
    const id = /^triage_decisions_(.+)$/.exec(key)?.[1];
    if (!id || ownEcho(key, c)) continue;
    const d = c.newValue || {};
    if (id === String(S.mediaId)) S.decisions = { ...S.kept, ...d };
    else if (S.loadAll && S.folderDecisions[id]) {
      S.folderDecisions[id] = d;
      rebuildAll();
    } else continue;
    changed = true;
  }
  if (changed) render();
}
// The side panel and history page edit the same notes. A pending local save is newer than the stored entry, and
// neither it nor this page's own saves coming back re-render: that rebuilds the note being typed (and its IME composition).
function followNotes(changes) {
  const c = changes[K.notes];
  if (!c || ownEcho(K.notes, c)) return;
  const next = { ...c.newValue };
  for (const b of notePending) {
    if (S.notes[b]) next[b] = S.notes[b];
    else delete next[b];
  }
  S.notes = next;
  if (!notePending.size) render();
}
function ownEcho(key, c) {
  const mine = (ownWrites[key] || []).filter((w) => Date.now() - w.at < ECHO_MS);
  ownWrites[key] = mine;
  const json = JSON.stringify(c.newValue ?? null);
  const i = mine.findIndex((w) => w.json === json);
  if (i >= 0) mine.splice(0, i + 1);
  return i >= 0;
}
// 保留 also sits in the open view's decisions (see openFolder and rebuildAll); 取消收藏 there wins, as on open.
function followKept(kept) {
  for (const [b, d] of Object.entries(S.decisions)) if (d?.action === "keep" && !kept[b]) delete S.decisions[b];
  for (const [b, d] of Object.entries(kept)) if (S.decisions[b]?.action !== "unfav") S.decisions[b] = d;
  S.kept = kept;
}

// ---------- tags ----------
const saveTags = () => storeSet(K.tags, S.tags);

// Why the folder takes no new tag: it has tagLimit() already ("" while it has room).
function tagCapReason(folder = S.mediaId) {
  const n = S.tags.filter((t) => t.folder === String(folder)).length;
  return n >= tagLimit() ? `这个收藏夹已经有 ${n} 个标签了，先删掉不用的，或在${SETTINGS_NAME}里调高上限` : "";
}

// Returns the folder's tag with this name, creating it if needed; the color comes from the palette in turn.
// null (with a toast) outside a folder or when the folder already has tagLimit() tags.
function createTag(name, folder = S.mediaId) {
  name = cleanTagName(name);
  if (!name) return toast(UI.tagNameError(name, []), true), null;
  if (folder === ALL || folder === REMOVED || !folder) return toast(FOLDER_ONLY, true), null;
  const own = S.tags.filter((t) => t.folder === String(folder));
  const existing = own.find((t) => t.name === name);
  if (existing) return existing;
  const full = tagCapReason(folder);
  if (full) return toast(full, true), null;
  const tag = { id: newTagId(), name, color: UI.nextTagColor(own), folder: String(folder) };
  S.tags.push(tag);
  saveTags();
  return tag;
}

function writeVideoTags(bvid, ids) {
  if (ids.length) S.videoTags[bvid] = ids;
  else delete S.videoTags[bvid];
}
function setVideoTags(bvid, ids, prev) {
  const same = ids.length === prev.length && ids.every((id) => prev.includes(id));
  if (same) return false;
  writeVideoTags(bvid, ids);
  saveVideoTags();
  pushUndo(
    pageStep("tags", 1, "", () => {
      writeVideoTags(bvid, prev);
      saveVideoTags();
      S.focused = bvid;
      return "已撤销：标签修改";
    })
  );
  return true;
}

// A tag's chip on the card takes it off that video in one click; U puts it back.
function removeVideoTag(bvid, id) {
  const prev = (S.videoTags[bvid] || []).filter((x) => tagById(x));
  const name = tagById(id)?.name;
  if (!setVideoTags(bvid, prev.filter((x) => x !== id), prev)) return;
  render();
  toast(UI.untagged(name));
}

// 「AI 刚打的」 of the open folder (a Set of bvids); empty in 所有收藏夹 and 已出分拣范围.
// Asked per video while filtering, so the set is built once per list (lists are replaced, never changed in place).
let aiRecentMemo = [null, new Set()];
const aiRecentSet = () => {
  const bvids = S.aiRecent[String(S.mediaId)]?.bvids;
  if (aiRecentMemo[0] !== bvids) aiRecentMemo = [bvids, new Set(bvids || [])];
  return aiRecentMemo[1];
};
const saveAiRecent = () => storeSet(K.aiRecent, S.aiRecent);
// × and U end the folder's 「AI 刚打的」; × leaves the tags as they are.
function endAiRecent(folder = String(S.mediaId)) {
  delete S.aiRecent[folder];
  if (folder === String(S.mediaId)) S.aiRecentFilter = false;
  saveAiRecent();
}

// T on a card opens the shared picker (tag-picker.js) as a modal; T in the player or 「+ 标签」 on the viewer line opens
// it under that line. The selection bar's 标签… opens it for the selected videos (one folder). Closing saves once, as
// one undo step. home ({ item, folders }, the viewer's) tags that video in its own folders, whatever is open.
function openPicker(bvids, anchor = "", home = null) {
  bvids = [].concat(bvids).filter((b) => home || S.itemMap.has(b));
  if (!bvids.length || (!home && S.mediaId === REMOVED)) return;
  const bvid = bvids[0];
  const folders = home?.folders || pickerFolders(bvid);
  const one = folders.length === 1;
  TagPicker.open({
    title: UI.pickTitle(bvids.length, shortTitle(home?.item || S.itemMap.get(bvid)), "视频"),
    targets: bvids,
    // Every tag of the video, so saving keeps the ones of other folders the picker does not list.
    idsOf: (b) => (S.videoTags[b] || []).filter((id) => tagById(id)),
    tags: () => S.tags.filter((t) => folders.includes(t.folder)),
    // Read at each redraw: a tag made here may fill the folder; full, no 新建「…」 and the empty list says why.
    get canCreate() {
      return one && !tagCapReason(folders[0]);
    },
    create: (name) => createTag(name, folders[0]),
    get empty() {
      // "" leaves tag-picker.js's own 「输入名称后回车新建标签」.
      return !one ? "在具体收藏夹里新建标签" : tagCapReason(folders[0]);
    },
    anchor,
    onClose: savePicked
  });
}

// The picker's tags: the open folder's; in 所有收藏夹 those of the folders the video is in. New tags need one folder.
function pickerFolders(bvid) {
  return inFolderView() ? [String(S.mediaId)] : (S.itemMap.get(bvid)?.folders || []).map(String);
}

// Several videos changed (标签… on a selection) are one undo step too.
function savePicked(changes) {
  if (changes.length === 1) {
    const [c] = changes;
    const prev = (S.videoTags[c.key] || []).filter((id) => tagById(id));
    if (setVideoTags(c.key, TagPicker.applyChange(prev, c), prev)) toast(`标签已更新${UNDO}`);
  } else if (changes.length) {
    const prevs = {};
    for (const c of changes) {
      prevs[c.key] = (S.videoTags[c.key] || []).filter((id) => tagById(id));
      writeVideoTags(c.key, TagPicker.applyChange(prevs[c.key], c));
    }
    saveVideoTags();
    const n = Object.keys(prevs).length;
    pushUndo(
      pageStep("tagsMany", n, "tags", () => {
        for (const [b, prev] of Object.entries(prevs)) writeVideoTags(b, prev);
        saveVideoTags();
        return `已撤销：${n} 个视频的标签修改`;
      })
    );
    toast(`${changes.length} 个视频的标签已更新${UNDO}`);
  }
  render();
  setFocus(S.focused, true);
}

// The viewer's 「视频标签」 line: the playing video's tags and 「+ 标签 T」; a tag opens the picker too. 关注 then draws
// its 「UP 标签」 line under it (viewerHook).
// In 关注 too, for a video that is in a chosen folder; T there stays on the UP line.
function renderViewerTags() {
  const v = S.viewer;
  el.viewerTags.hidden = !v;
  if (!v) el.viewerTags.innerHTML = "";
  else {
    const edit = Boolean(v.folders?.length);
    const chips = (S.videoTags[v.item.bvid] || [])
      .map(tagById)
      .filter((t) => t && (!v.folders || v.folders.includes(t.folder)))
      .map((t) => `<span class="chip" style="--c:${esc(t.color)}"${edit ? " data-vtag" : ""}>${esc(t.name)}</span>`)
      .join("");
    el.viewerTags.innerHTML = UI.viewerLine({ label: MdgErrors.LABEL.videoTags, chips, plus: edit && { attrs: "data-vtag", label: "打视频标签" } });
  }
  viewerHook?.();
}
const tagPlaying = () => S.viewer?.folders?.length && openPicker(S.viewing, "#viewerTags .tag-plus", S.viewer);

// ---------- 判断标准 ----------
function openCriteria() {
  el.criteriaTitle.textContent = `判断标准 ·「${folderTitle()}」`;
  el.criteriaInput.value = criteria();
  el.criteriaDialog.returnValue = "";
  el.criteriaDialog.showModal();
  el.criteriaInput.focus();
}

// One folder's 判断标准; empty removes it. The caller stores S.folderCriteria.
function setCriteria(id, text) {
  text = text.trim();
  if (text) S.folderCriteria[id] = text;
  else delete S.folderCriteria[id];
}

async function saveCriteria() {
  const changed = el.criteriaInput.value.trim() !== criteria();
  setCriteria(S.mediaId, el.criteriaInput.value);
  storeSet(K.folderCriteria, S.folderCriteria);
  render();
  // Asked whenever 粗看完成 has stale ones, filters or not. Its button is row 3's 按新标准重新粗看 (listed ones, the
  // selection first, one batch), disabled with the same why when that has none. While an AI step runs it could not
  // start, so a toast says what to do once it ends instead of a dialog that can only be cancelled.
  const stale = staleCoarse().length;
  if (!changed || !stale) return;
  if (aiBusyStep()) return toast(`有 ${stale} 个视频是按旧标准粗看的，等${aiBusyStep()}跑完，点「按新标准重新粗看」就能更新`);
  const open = redoCoarseOpen();
  const { batch, label, why } = redoOf("coarse");
  const shown = open.length < stale ? `（当前筛选下列出 ${open.length} 个）` : "";
  const ok = await askConfirm(
    "判断标准改了",
    `<p>「粗看完成」里有 ${stale} 个视频是按旧标准粗看的${shown}，要按新标准重新粗看吗？</p><p>已细看和已处理的视频不动；细看完成页可以另外按新标准重新细看。</p>`,
    label,
    { reason: why }
  );
  if (ok) runStage1(batch, true);
}

// 所有收藏夹 has no one 判断标准: before a 粗看 or 细看 run it lists each folder the run touches, with its videos and its
// 判断标准 to edit (saved as in the 判断标准 dialog). false on 取消.
async function askAllCriteria(title, verb, items) {
  const n = new Map();
  for (const it of items) n.set(homeOf(it), (n.get(homeOf(it)) || 0) + 1);
  const rows = S.folders
    .map((f) => String(f.id))
    .filter((id) => n.has(id))
    .map((id, i) => `<div class="crit-row"><label for="critAll${i}">「${esc(folderName(id))}」· ${n.get(id)} 个</label><textarea id="critAll${i}" rows="2" data-crit="${esc(id)}" placeholder="还没写判断标准，AI 按收藏夹名和简介推测">${esc(criteriaFor(id))}</textarea></div>`)
    .join("");
  const ok = await askConfirm(title, `<p>每个视频按它所在收藏夹的判断标准判断。</p><p>重复收藏的视频，按收藏夹列表里排最前的那个。</p>${rows}`, `开始${verb} ${items.length} 个`);
  if (!ok) return false;
  for (const box of el.confirmBody.querySelectorAll("[data-crit]")) setCriteria(box.dataset.crit, box.value);
  storeSet(K.folderCriteria, S.folderCriteria);
  render();
  return true;
}
// A 粗看 / 细看 button: in 所有收藏夹 after askAllCriteria, elsewhere at once.
async function startJudging(title, verb, items, start) {
  if (S.mediaId === ALL && !(await askAllCriteria(title, verb, items))) return;
  start();
}

// ---------- 标签管理 (tag-dialogs.js): the open folder's tags ----------
const tagCounts = () => {
  const counts = {};
  for (const ids of Object.values(S.videoTags)) for (const id of ids) counts[id] = (counts[id] || 0) + 1;
  return counts;
};
const manageTags = {
  who: "视频",
  hint: () => `这里是这个收藏夹的标签，最多 ${tagLimit()} 个（在${SETTINGS_NAME}里改）。`,
  reason: () => (inFolderView() ? "" : FOLDER_ONLY),
  tags: () => (inFolderView() ? viewTags() : []),
  count: (id) => tagCounts()[id] || 0,
  addReason: (value) => tagCapReason() || UI.tagNameError(cleanTagName(value), viewTags()),
  add(value) {
    const t = createTag(value);
    if (t) render();
    return t;
  },
  edit: (t, field, value) => saveTagEdit(t, field, value),
  remove: (t) => deleteTag(t.id)
};
const openManage = () => TagDialogs.manage.open(manageTags);

// A rename, rule or color edit from 标签管理 (shared.js editedTag); false (and nothing saved) for an empty or duplicate name.
function saveTagEdit(t, field, value) {
  const { tag, why } = UI.editedTag(t, field, value, S.tags.filter((x) => x !== t && x.folder === t.folder));
  if (why) toast(why, true);
  if (!tag) return false;
  delete t.rule;
  Object.assign(t, tag);
  saveTags();
  render();
  return true;
}

async function deleteTag(id) {
  const t = tagById(id);
  const n = Object.values(S.videoTags).filter((ids) => ids.includes(id)).length;
  const ok = await askConfirm(...UI.deleteTagAsk(t, n, "视频"), "删除", { danger: true });
  if (!ok) return;
  S.tags = S.tags.filter((x) => x.id !== id);
  S.videoTags = UI.withoutTag(S.videoTags, id);
  S.tagFilter.delete(id);
  // A tag step undone now would put the deleted tag's id back on its videos.
  S.undo = S.undo.filter((e) => e.kind !== "tags" && e.kind !== "tagsMany" && e.kind !== "aiApply");
  saveTags();
  saveVideoTags();
  pruneAiProposals();
  render();
}

const saveAiProposals = () => storeSet(K.aiProposals, S.ai.proposals);
// A proposal naming a deleted tag no longer fits; it is dropped rather than applied.
function pruneAiProposals() {
  const fits = Object.entries(S.ai.proposals).filter(([, p]) => UI.aiProposalOk(p, (id) => Boolean(tagById(id))));
  if (fits.length === Object.keys(S.ai.proposals).length) return;
  S.ai.proposals = Object.fromEntries(fits);
  saveAiProposals();
}

// ---------- AI stage 1: titles ----------
function aiItem(it) {
  return { bvid: it.bvid, title: it.title, upper: it.upper, duration: it.duration, pubdate: it.pubdate, intro: it.intro };
}


// Titles one 粗看 request carries (TriageUi, so the settings page's hint reads the same number).
const { TITLES_PER_REQUEST } = TriageUi;

// What 标题粗看 counts and sends: the first coarseBatchSize() 未分析 videos listed now (search and filters applied),
// not the hidden ones. A selection wins, like 细看's nextBatch.
const coarseOpen = () => S.items.filter((it) => stageOf(it) === "none" && !S.coarseFailed.has(it.bvid) && passFilter(it));
const stage1Pending = () => pickBatch(coarseOpen(), coarseBatchSize(), "none");

// list: 未分析 by default; 重新粗看 passes the cards whose 粗看 used an older 判断标准. Their old results stay on the
// cards until new ones replace them, so a stopped or failed run loses nothing.
// redo: 按新标准重新粗看, which only changes the pill's words.
async function runStage1(list = stage1Pending(), redo = false) {
  if (runs.get("stage1")) return;
  // Everything the run needs is taken now: it keeps going after another folder opens. Sending a card again drops its
  // old failure; a failure in this run keeps it from being sent twice.
  for (const it of list) S.coarseFailed.delete(it.bvid);
  const folder = String(S.mediaId);
  const judge = new Map(list.map((it) => [it.bvid, judgeOf(it)]));
  // Due: no 粗看 yet, or one made under another 判断标准.
  const due = (it) => {
    const r = S.titleRes[it.bvid];
    return !VERDICTS[r?.verdict] || isStale(r, judge.get(it.bvid).crit);
  };
  // In its own folder the live step decides (a card may have been sorted meanwhile); elsewhere only the result does.
  const pending = () =>
    list.filter((it) => !S.coarseFailed.has(it.bvid) && !it.invalid && due(it) && (S.mediaId !== folder || ["none", "coarse"].includes(stageOf(it))));
  const run = (S.stage1 = { mediaId: folder });
  const name = runName("coarse", redo);
  const running = runs.run("stage1", {
    total: pending().length,
    gap: S.settings.triageIntervalSec * 1000,
    // In its folder the line says when it will pause; elsewhere it names its folder. Its finished line shows only there.
    line(d, t, stopping) {
      const where = runWhere(run);
      return !where && stopping ? PILL_BTN.stage1[3] : `${redo ? name : `${name}中`} ${d}/${t}${where}`;
    },
    finished: (d) => (d && !runWhere(run) ? `${name}完成 ${d} 个` : ""),
    next() {
      // One request carries one 判断标准: in 所有收藏夹 a batch is the first pending video's folder only.
      const left = pending();
      if (!left.length) return null;
      const { home, crit, ctx } = judge.get(left[0].bvid);
      const batch = left.filter((it) => judge.get(it.bvid).home === home).slice(0, TITLES_PER_REQUEST);
      return { batch, crit, ctx, n: batch.length };
    },
    async act({ batch, crit, ctx }) {
      for (const it of batch) S.analyzing.add(it.bvid);
      render();
      const r = await send({ type: "triage-classify-titles", items: batch.map(aiItem), criteria: crit, folder: ctx });
      for (const it of batch) S.analyzing.delete(it.bvid);
      return r;
    },
    // An error every later request would get too ends the run and leaves the cards as they were; one about this batch
    // (a reply in the wrong format, too long) fails its cards and the run goes on, as in 细看.
    judge: aiJudge(),
    done({ batch, crit }, r) {
      const results = r.data?.results || {};
      for (const it of batch) {
        if (results[it.bvid]) S.titleRes[it.bvid] = { criteria: crit, ...results[it.bvid] };
        else S.coarseFailed.set(it.bvid, r.ok ? "AI 回复里没有这个视频" : MdgErrors.text(r));
      }
      // A redone card keeps its old 粗看, as a redone 细看 keeps its old result.
      if (!r.ok && batch.some((it) => VERDICTS[S.titleRes[it.bvid]?.verdict])) toast(`重新粗看失败，保留原来的结果：${r.error}`, true);
      if (r.code === "AI_TRUNCATED") handleAiError(r.error, r.code);
      render();
    }
  });
  render();
  const r = await running;
  if (r.error) handleAiError(r.error, r.code);
  // As 细看: a paused run keeps the banner; only a finished one clears it.
  else if (!r.stopped) clearAiBanner();
  otherFolderToast(run, name, r);
  render();
}

// A run that ends in another folder says so there: how many it did, and whether it paused or stopped on an error.
function otherFolderToast(run, name, r) {
  if (!runWhere(run) || r.busy || !(r.done || r.stopped || r.error)) return;
  toast(`「${folderName(run.mediaId)}」${name}${r.error ? "出错停下，" : r.stopped ? "已暂停，" : ""}完成 ${r.done - r.failed} 个`);
}

// ---------- AI stage 2: subtitle group ----------
// group: a 细看 run, which judges by its own items (the open folder's list is empty while a folder loads, and may be
// another folder's); 已处理 is read only in its own folder.
const needsAnalysis = (b, group = null) => {
  const own = !group || group.mediaId === String(S.mediaId);
  const it = group ? group.items.get(b) : S.itemMap.get(b);
  const a = S.analyses[b];
  return it && !it.invalid && !(own && isProcessed(b)) && a?.status !== "done" && a?.status !== "error";
};

// redo: 细看 these again under the current criteria; each keeps its old result until the new one arrives.
function startGroup(bvids, redo = false) {
  if (!bvids.length || S.group) return;
  S.group = {
    bvids,
    redo: redo ? new Set(bvids) : null,
    mediaId: String(S.mediaId),
    items: new Map(bvids.map((b) => [b, S.itemMap.get(b)])),
    judge: new Map(bvids.map((b) => [b, judgeOf(S.itemMap.get(b))]))
  };
  runGroup();
}

const groupPending = (group, b) => (group.redo ? group.redo.has(b) : needsAnalysis(b, group));

async function analyzeOne(bvid, force, { crit, ctx }) {
  S.analyzing.add(bvid);
  render();
  const r = await send({ type: "triage-analyze", bvid, force, criteria: crit, folder: ctx });
  S.analyzing.delete(bvid);
  render();
  return r;
}

async function runGroup() {
  const group = S.group;
  const name = runName("fine", Boolean(group.redo));
  const running = runs.run("group", {
    total: group.bvids.filter((b) => groupPending(group, b)).length,
    gap: S.settings.triageIntervalSec * 1000,
    line(d, t, stopping) {
      const where = runWhere(group);
      return !where && stopping ? PILL_BTN.group[3] : `${group.redo ? name : `${name}中`} ${d}/${t}${where}`;
    },
    finished: (d) => (d && !runWhere(group) ? `${name}完成 ${d} 个` : ""),
    next() {
      const b = group.bvids.find((x) => groupPending(group, x));
      return b ? { b, judge: group.judge.get(b) } : null;
    },
    act: ({ b, judge }) => analyzeOne(b, Boolean(group.redo), judge),
    // An error that is not this video's ends the run and leaves the card as it was.
    judge: aiJudge(),
    done({ b, judge }, r) {
      group.redo?.delete(b);
      const keepOld = !r.ok && group.redo && S.analyses[b]?.status === "done";
      if (keepOld) toast(`重新细看失败，保留原来的结果：${r.error}`, true);
      else S.analyses[b] = r.ok ? { criteria: judge.crit, ...r.data } : { bvid: b, status: "error", error: MdgErrors.text(r) };
      if (r.code === "AI_TRUNCATED") handleAiError(r.error, r.code, "细看");
      render();
    }
  });
  render();
  const r = await running;
  if (r.error) handleAiError(r.error, r.code, "细看");
  // A run that stopped on a setup error keeps its banner, and a paused one; any other finished batch clears it.
  const ended = r.error || r.stopped;
  if (!ended) clearAiBanner();
  S.group = null;
  otherFolderToast(group, name, r);
  render();
}


// Failed results live only on this page. 重试 sends the failed cards of the open tab like the step's own button: the
// selected ones first, one batch, through startJudging; dropping a failed 细看 puts its card back in the batch runner.
// failed: the open tab's failed cards listed now. label is the group head's button, and the 所有收藏夹 dialog's title.
function retryState(failed) {
  const batch = pickBatch(failed, S.tab === "none" ? coarseBatchSize() : fineBatchSize(), S.tab);
  const label = !picking(S.tab) && batch.length === failed.length ? "全部重试" : batchLabel(MdgErrors.LABEL.retry, batch, failed, S.tab);
  return { batch, label, why: aiBusyReason() || pickReason("选中的都不能重试", batch, S.tab) };
}
const failedHeadHtml = (failed) => {
  const { label, why } = retryState(failed);
  return `<div class="group-head">${ANALYSIS_FAILED} ${failed.length} · <button type="button" data-retry-failed aria-label="${label}"${UI.reasonAttrs(why)}>${AI_SPARK}${label}</button></div>`;
};
function retryFailed() {
  const { batch, label, why } = retryState(visibleItems().filter((it) => failedIn(S.tab, it)));
  if (!batch.length || why) return;
  if (S.tab === "none") return startJudging(label, "粗看", batch, () => runStage1(batch));
  startJudging(label, "细看", batch, () => {
    for (const it of batch) delete S.analyses[it.bvid];
    startGroup(batch.map((it) => it.bvid));
  });
}

// A card's 重试 is a run of one through the step's own runner (pill, finish line, banner), 粗看 or 细看 alike; the
// button is disabled while another AI run goes (the guard covers the keyboard).
function retry(bvid) {
  const it = S.itemMap.get(bvid);
  if (!it || aiBusyReason()) return;
  // In 所有收藏夹 it asks for the folder's 判断标准 first, as 全部重试 does, titled like the button.
  if (failedCoarse(it)) return startJudging(MdgErrors.LABEL.retry, "粗看", [it], () => runStage1([it]));
  startJudging(MdgErrors.LABEL.retry, "细看", [it], () => {
    delete S.analyses[bvid];
    startGroup([bvid]);
  });
}

// ---------- AI 打标签 (tag-dialogs.js) ----------
// The scopes of ✦ AI 打标签 and 摘录或笔记, drawn 「名字 · N 个」 in both.
const SCOPE_LABEL = { ...UI.scopeLabel, analyzed: "细看过的", all: "整个收藏夹" };
const EMPTY_SCOPE = "作用范围里没有视频";
const isAnalyzed = (it) => S.analyses[it.bvid]?.status === "done";

function aiScopeItems(scope) {
  if (scope === "selected") return visibleSelected();
  if (scope === "analyzed") return visibleItems().filter(isAnalyzed);
  return visibleItems();
}

// folder: the one this request tags in; excluded: tag names the AI may not see.
function aiCommandItem(it, folder, excluded) {
  const out = aiItem(it);
  const a = S.analyses[it.bvid];
  if (isAnalyzed(it)) {
    out.oneLiner = a.oneLiner || "";
    out.points = a.points || [];
  }
  const names = tagIdsOf(it.bvid).map(tagById).filter((t) => t.folder === folder && !excluded.has(t.name)).map((t) => t.name);
  if (names.length) out.currentTags = names;
  return out;
}

// The AI 打标签 batch size (shared.js SET_ROWS aiBatch).
const aiBatchSize = () => UI.numSetting("aiBatch", S.settings.triageAiBatchSize);

// AI 打标签 tags each folder with its own tags: one part per folder, in 所有收藏夹 every chosen folder the items are in
// (a video in several folders is in each of their parts).
function aiParts(items) {
  if (S.mediaId !== ALL) return [{ folder: String(S.mediaId), items }];
  return S.folders.map((f) => String(f.id)).map((folder) => ({ folder, items: items.filter((it) => it.folders?.includes(folder)) })).filter((p) => p.items.length);
}

function aiScopeText(scope) {
  const items = aiScopeItems(scope);
  const n = items.length;
  const done = items.filter(isAnalyzed).length;
  const size = aiBatchSize();
  const parts = [done && `${done} 个细看过（按 AI 总结和要点判断）`, n - done && `${n - done} 个只有标题和简介，标签可能不准`].filter(Boolean);
  if (!n) return EMPTY_SCOPE;
  if (S.mediaId !== ALL) return `${n} 个视频：${parts.join("，")}${UI.batchesText(Math.ceil(n / size))}`;
  const folders = aiParts(items);
  const batches = folders.reduce((sum, p) => sum + Math.ceil(p.items.length / size), 0);
  return `${n} 个视频：${parts.join("，")}。按收藏夹分开打，各用各的标签（重复收藏的视频在每个收藏夹各打一次），${folders.length} 个收藏夹共 ${batches} 批发送`;
}

// The most new tags one run may make: in 所有收藏夹, the roomiest folder's.
const aiRoom = () => (S.mediaId === ALL ? Math.max(0, ...S.folders.map((f) => aiNewTagRoom(f.id))) : aiNewTagRoom());
function aiRoomHint() {
  const tags = aiTags.tags();
  const room = aiRoom();
  const all = S.mediaId === ALL;
  // In 所有收藏夹 room is the roomiest folder's: each folder makes at most what it has left.
  return UI.aiRoomHint({
    tags,
    excluded: S.ai.excluded,
    room,
    most: all ? `每个收藏夹最多 ${room} 个，不超过它剩下的名额` : undefined,
    made: all ? `这次在每个收藏夹最多新建 ${room} 个（不超过它剩下的名额）` : `这次最多新建 ${room} 个（这个收藏夹还剩 ${tagLimit() - tags.length} 个名额）`,
    full: `${all ? "各收藏夹" : ""}名额已满`
  });
}

const aiTags = {
  who: "视频",
  sees: "标题和简介（细看过的还看 AI 总结和要点），不改 AI 判断",
  example: "把这些按技术深度分成 入门/进阶/硬核 三个标签",
  excluded: S.ai.excluded,
  manage: manageTags,
  // 所有收藏夹: one chip per name, as in row 4; turning it off keeps that name from the AI in every folder.
  tags: () => viewTags().filter((t, i, all) => all.findIndex((x) => x.name === t.name) === i),
  // Every folder's own, for the review to find a new tag's same-name tag in its folder.
  allTags: viewTags,
  scopes: () => [
    { value: "filter", label: SCOPE_LABEL.filter, n: visibleItems().length },
    { value: "selected", label: SCOPE_LABEL.selected, n: S.selected.size, shown: visibleSelected().length },
    { value: "analyzed", label: SCOPE_LABEL.analyzed, n: visibleItems().filter(isAnalyzed).length }
  ],
  scopeText: aiScopeText,
  room: aiRoom,
  roomHint: aiRoomHint,
  blocked: () =>
    S.mediaId === REMOVED ? `${FOLDER_ONLY}再让 AI 打标签。` : aiRunning() && S.ai.mediaId !== String(S.mediaId) ? `正在处理「${folderName(S.ai.mediaId)}」的视频，完成后可点进度胶囊上的「${VIEW}」确认` : "",
  history: () => S.aiHistory,
  allowRemove: () => S.settings.triageAiRemoveTags === true,
  // The same switch as in 收藏夹设置, saved as soon as it flips.
  async setAllowRemove(on) {
    const r = await send({ type: "triage-settings-save", triageAiRemoveTags: on });
    if (!r.ok) return toast(`${MdgErrors.TEXT.settingsSaveFailed}：${r.error}`, true), false;
    S.settings.triageAiRemoveTags = on;
    return true;
  },
  // A run in another folder leaves this one's form and proposal be (blocked says why it cannot run here).
  running: () => aiRunning() && S.ai.mediaId === String(S.mediaId),
  proposal: () => S.ai.proposal,
  run: runAiCommand,
  stop: () => runs.stop("ai"),
  stopping: () => Boolean(runs.get("ai")?.stopping),
  discard() {
    S.ai.proposal = null;
    renderTop();
  },
  apply: () => applyAiProposal(),
  map: () => S.videoTags,
  live: () => S.itemMap,
  tagName: (id) => tagById(id)?.name,
  where: () => String(S.mediaId)
};
const openAi = () => TagDialogs.ai.open(aiTags);

// One AI 打标签 run, for both modes, as job on the mode's runs (R): request(i, p) is batch i's message, merge(p, data)
// folds an answer in. An AI 429 or timeout sends the same batch again, up to AI_THROTTLE_WAITS / AI_TIMEOUT_TRIES in a
// row; an error that fails every batch alike (aiEnds) ends the run. Returns
// { proposal, errors }: proposal is null when no batch got through, so there is nothing to confirm (the progress line says why).
// name(i), when given, says which batch in the progress line and errors (所有收藏夹 names the folder); where() follows
// the pill's line (another folder's run). progress(text) is the dialog's line, counting down with the pill.
async function runAiBatches({ R = runs, job, total, request, merge, intervalMs, progress, name = null, where = () => "" }) {
  const which = (i, full = false) => (name ? name(i) : full ? `第 ${i + 1} / ${total} 批` : `第 ${i + 1} 批`);
  const p = { newTags: [], rows: [], notes: [], errors: [] };
  let answered = 0;
  let i = 0;
  const r = await R.run(job, {
    total,
    tick: () => R.get(job)?.wait && progress(`${R.get(job).wait}${which(i - 1)}…`),
    gap: intervalMs,
    line: (d, t) => `AI 打标签 ${d}/${t} 批${where()}`,
    next: () => (i < total ? { i: i++ } : null),
    act: ({ i }) => (progress(`AI 正在处理${which(i, true)}…`), send(request(i, p))),
    judge: aiJudge(),
    done({ i }, x) {
      if (x.ok) return answered++, merge(p, x.data, i);
      p.errors.push(`${which(i)}失败：${x.error}`);
      // 截断 is reported with what to change.
      if (x.code === "AI_TRUNCATED") handleAiError(x.error, x.code);
    }
  });

  if (r.error) {
    p.errors.push(`${which(i - 1)}失败：${r.error}`);
    handleAiError(r.error, r.code);
  }
  if (r.stopped) p.errors.push(answered ? "已手动停止，这里只有已完成批次的建议" : "已手动停止，还没有批次完成");
  for (const t of p.newTags) t.checked = p.rows.some((r) => r.add.includes(UI.aiRef.new(t.key)));
  progress(answered ? "" : p.errors.join("；"));
  return { proposal: answered ? p : null, errors: p.errors };
}

// instruction, scope and allowRemove come from the dialog, which has checked that there is an instruction and items.
async function runAiCommand({ instruction, scope, allowRemove }) {
  if (aiRunning() || S.mediaId === REMOVED) return;
  const items = aiScopeItems(scope);
  if (!items.length) return;
  // Everything the run sends is taken now: the run outlives a folder switch, and the page then holds another folder.
  // The proposal is kept under the open view (所有收藏夹 too); each part tags in its own folder.
  const folder = String(S.mediaId);
  const all = folder === ALL;
  const excluded = new Set(viewTags().filter((t) => S.ai.excluded.has(t.id)).map((t) => t.name));
  const size = aiBatchSize();
  let from = 0;
  const parts = aiParts(items).map(({ folder: f, items: list }) => {
    const own = S.tags.filter((t) => t.folder === f);
    const part = {
      folder: f,
      from,
      n: Math.ceil(list.length / size),
      payload: list.map((it) => aiCommandItem(it, f, excluded)),
      tags: own.filter((t) => !excluded.has(t.name)).map((t) => ({ name: t.name, rule: t.rule || "" })),
      // newTagFolder keeps same-name new tags of two folders apart in the one proposal.
      opts: { maxNewTags: aiNewTagRoom(f), allowRemove, excluded, newTagFolder: all ? f : undefined, scope: new Set(list.map((it) => it.bvid)) }
    };
    from += part.n;
    return part;
  });
  // In 所有收藏夹 a video in no chosen folder has no part: nothing may be left to send.
  if (!from) return;
  S.aiHistory = UI.aiHistoryAdd(S.aiHistory, instruction);
  storeSet(K.aiHistory, S.aiHistory);
  const partOf = (i) => {
    const part = parts.findLast((x) => x.from <= i);
    return [part, i - part.from];
  };
  S.ai.mediaId = folder;
  const running = runAiBatches({
    job: "ai",
    total: from,
    // Each batch gets what is left of its folder's new-tag cap (mergeAiBatch drops new tags past it).
    request: (i, p) => {
      const [part, j] = partOf(i);
      const maxNewTags = Math.max(0, part.opts.maxNewTags - p.newTags.filter((t) => t.folder === part.opts.newTagFolder).length);
      return { type: "triage-ai-command", instruction, items: part.payload.slice(j * size, (j + 1) * size), tags: part.tags, maxNewTags, allowRemove };
    },
    // not tagIdsOf: the open folder may have changed since the run started
    merge: (p, data, i) => {
      const [part] = partOf(i);
      UI.mergeAiBatch(p, data, { ...part.opts, tags: S.tags.filter((t) => t.folder === part.folder), map: S.videoTags });
    },
    name: all ? (i) => {
      const [part, j] = partOf(i);
      return `「${folderName(part.folder)}」第 ${j + 1}/${part.n} 批`;
    } : undefined,
    where: () => (S.ai.mediaId === String(S.mediaId) ? "" : `（${folderName(S.ai.mediaId)}）`),
    intervalMs: S.settings.triageIntervalSec * 1000,
    progress: (text) => (TagDialogs.ai.progress(aiTags, text, folder), renderStatus())
  });
  renderTop();
  let { proposal: p, errors } = await running;
  // A tag deleted during the run is still named by the batches before it: dropped like a saved proposal (pruneAiProposals).
  if (p && !UI.aiProposalOk(p, (id) => Boolean(tagById(id)))) {
    p = null;
    errors.push("运行期间删除了建议用到的标签，请重新运行");
    TagDialogs.ai.progress(aiTags, errors.at(-1), folder);
  }
  if (p) {
    for (const t of p.newTags) if (t.folder) t.where = folderName(t.folder);
    S.ai.proposals[folder] = p;
    saveAiProposals();
  }
  renderTop();
  // Open, the dialog turns to the proposal (or, in another folder, back to its form).
  const open = TagDialogs.ai.isOpen(aiTags);
  if (open) TagDialogs.ai.render(aiTags);
  if (!p) {
    if (!open) toast(UI.aiTagsFailed(errors.at(-1)), true);
    return;
  }
  if (folder !== String(S.mediaId)) toast(`「${folderName(folder)}」的标签建议已完成，点进度胶囊上的「${VIEW}」确认`);
  else if (!open) toast(UI.AI_TAGS_DONE);
}

// What a proposal changes (shared.js); a video that left the folder since keeps its tags.

function applyAiProposal() {
  const p = S.ai.proposal;
  if (!p) return;
  const hadTags = new Set(S.tags.map((t) => t.id));
  const idFor = {};
  for (const t of p.newTags) {
    if (t.checked && cleanTagName(t.name)) idFor[t.key] = createTag(t.name, t.folder || S.mediaId)?.id;
  }
  const changes = []; // [{ bvid, before }]: what U puts back
  for (const [bvid, before, after] of UI.aiChanges(p, S.videoTags, S.itemMap, (key) => idFor[key])) {
    writeVideoTags(bvid, after);
    changes.push({ bvid, before });
  }
  saveTags();
  saveVideoTags();
  const folder = String(S.mediaId);
  const created = S.tags.filter((t) => !hadTags.has(t.id)).map((t) => t.id);
  S.ai.proposal = null;
  // This batch replaces the folder's last one; the list shows it to look over. U ends it only while it is still this one.
  const at = changes.length ? Date.now() : 0;
  if (at) {
    S.aiRecent[folder] = { at, bvids: changes.map((c) => c.bvid) };
    S.aiRecentFilter = true;
    saveAiRecent();
  }
  if (at || created.length)
    pushUndo(
      pageStep("aiApply", changes.length, "ai", () => {
        // Every video the batch changed goes back to before it, edits made since included; a tag deleted since stays gone.
        for (const c of changes) writeVideoTags(c.bvid, c.before.filter((id) => tagById(id)));
        const used = new Set(Object.values(S.videoTags).flat());
        S.tags = S.tags.filter((t) => !created.includes(t.id) || used.has(t.id));
        for (const id of [...S.tagFilter]) if (!tagById(id)) S.tagFilter.delete(id);
        saveTags();
        saveVideoTags();
        // Another tab, or a later batch here, may have replaced the folder's 「AI 刚打的」 since.
        if (S.aiRecent[folder]?.at === at) endAiRecent(folder);
        return `已撤销：AI 打标签（${changes.length} 个视频）`;
      })
    );
  render();
  // A new tag past the folder's cap is not made (createTag's toast is replaced by this one): say which, and that the
  // videos asking for it went without.
  const lost = p.newTags.filter((t) => t.checked && cleanTagName(t.name) && !idFor[t.key]).map((t) => t.name);
  const applied = UI.aiApplied(changes.length, "视频", created.length);
  toast(lost.length ? `${applied}；新标签「${lost.join("」「")}」没建成（标签已到上限），用到它的视频没打上` : applied, lost.length > 0);
}

// ---------- 待播 ----------
// triage_basket is the 待播 in order: [{ bvid, title, cover?, upper?, duration?, opened? }]; the copied
// fields show videos outside the open folder (entries from before they were copied have only the title).
const saveBasket = () => storeSet(K.basket, S.basket);

function toggleBasket(bvid) {
  const i = S.basket.findIndex((x) => x.bvid === bvid);
  const it = S.itemMap.get(bvid);
  if (i >= 0) {
    removeBasketItems([i]);
    toast(BASKET_REMOVED);
    return;
  }
  if (it) {
    S.basket.push({ bvid, title: it.title, cover: it.cover, upper: it.upper, duration: it.duration });
    toast(`已加入待播《${shortTitle(it)}》`);
    el.basket.classList.remove("bump");
    void el.basket.offsetWidth;
    el.basket.classList.add("bump");
  }
  saveBasket();
  render();
}

// The list keeps the order videos were added in. Opening one only marks it; only 移除 removes it —
// opening a video isn't watching it.
function openBasketItem(i) {
  const x = S.basket[i];
  if (!x) return;
  x.opened = true;
  saveBasket();
  openViewer(x);
}

// 移除 and 清空 take videos out of the list, nothing else; favorites and decisions are untouched. U puts them back
// (basketStep), each at its place.
function basketStep(removed) {
  return pageStep("basket", 0, "", () => {
    for (const { i, x } of removed) if (!S.basket.some((y) => y.bvid === x.bvid)) S.basket.splice(i, 0, x);
    saveBasket();
    return `已撤销：放回待播 ${removed.length} 个`;
  });
}
function removeBasketItems(indexes) {
  const removed = indexes.filter((i) => S.basket[i]).sort((a, b) => a - b).map((i) => ({ i, x: S.basket[i] }));
  if (!removed.length) return;
  const gone = new Set(removed.map((r) => r.x.bvid));
  S.basket = S.basket.filter((x) => !gone.has(x.bvid));
  saveBasket();
  pushUndo(basketStep(removed));
  render();
}

function clearBasket() {
  const n = S.basket.length;
  removeBasketItems(S.basket.map((_, i) => i));
  toast(`已清空待播 ${n} 个${UNDO}`);
}

function renderBasket() {
  el.basket.hidden = !S.basket.length;
  el.basketCount.textContent = S.basket.length;
  el.basketList.innerHTML = S.basket
    .map((x, i) => {
      const it = S.itemMap.get(x.bvid) || x;
      const title = esc(it.title || x.bvid);
      const meta = [it.upper, it.duration && fmtDuration(it.duration)].filter(Boolean).map(esc).join(" · ");
      const note = S.notes[x.bvid]?.text?.trim();
      return `<div class="basket-item${x.opened ? " opened" : ""}${x.bvid === S.viewing ? " playing" : ""}" data-i="${i}">
      <button type="button" class="basket-open" data-basket="open" aria-label="打开视频 ${title}">
        ${it.cover ? `<img class="basket-cover" src="${esc(img(it.cover, "160w_90h_1c"))}" alt="" loading="lazy" referrerpolicy="no-referrer" />` : ""}
        <span class="basket-text"><span class="basket-title">${title}</span>${meta || x.opened ? `<span class="muted">${[meta, x.opened && "已打开"].filter(Boolean).join(" · ")}</span>` : ""}</span>
      </button>
      <div class="basket-actions">
        <button type="button" data-basket="remove" aria-label="${BASKET_REMOVE} ${title}" title="${BASKET_REMOVE}">移除</button>
      </div>
      ${note ? `<div class="muted basket-note">${esc(note)}</div>` : ""}
    </div>`;
    })
    .join("");
}

// 一篇摘录: one Markdown file with each video's link, AI summary, tags and note.
function buildMarkdown(items, now = new Date()) {
  const lines = [
    "---",
    `title: B站摘录 ${fmtTime(now)}`,
    `created: ${stamp(now, false)}`,
    "tags:",
    "  - B站摘录",
    "---",
    ""
  ];
  for (const it of items) {
    const a = S.analyses[it.bvid];
    const done = a?.status === "done";
    lines.push(`## [${mdLinkText(it.title)}](${videoUrl(it.bvid)})`, "");
    if (it.upper || it.invalid) lines.push([it.upper && `UP 主：${it.upper}`, it.invalid && KIND_NAME.invalid].filter(Boolean).join(" · "), "");
    if (done && a.oneLiner) lines.push(`> ${a.oneLiner}`, "");
    if (done && a.points?.length) lines.push(...a.points.map((p) => `- ${p}`), "");
    const names = tagIdsOf(it.bvid).map((id) => tagById(id).name);
    if (names.length) lines.push(`标签：${names.join("、")}`, "");
    const note = S.notes[it.bvid]?.text?.trim();
    if (note) lines.push(`备注：${note}`, "");
  }
  return lines.join("\n");
}

// ---------- 摘录或笔记 (导出) ----------
// 逐个视频笔记 leaves out invalid videos (no subtitle to fetch); 一篇摘录 keeps them, marked, so their notes and tags
// still go out. 待播 is a list to watch from, not an export scope.
function writeScopeItems(scope = el.writeScope.value, notes = el.writeFormat?.value === "notes") {
  const list =
    scope === "all" ? S.items
    : scope === "selected" ? visibleSelected()
    : visibleItems();
  return notes ? list.filter((it) => !it.invalid) : list;
}

// The 阅览 tab opens it preset; a running notes export keeps its own choice.
function openWrite({ scope, format } = {}) {
  if (!writeRunning() && scope) [el.writeScope.value, el.writeFormat.value] = [scope, format];
  // A notes run, running, finished or stopped by Obsidian, keeps its progress and failures here until the next export.
  if (!writeRunning() && !S.write.text && !S.write.obsidian) clearWriteResult();
  renderWriteScope();
  el.writeDialog.showModal();
}

function stopWrite() {
  runs.stop("write");
  renderWriteScope();
  renderStatus();
}

function clearWriteResult() {
  S.write.text = "";
  S.write.obsidian = false;
  el.writeProgress.textContent = "";
  el.writeProgress.classList.remove("fail-text");
  el.writeSettingsBtn.hidden = true;
  el.writeFailed.hidden = true;
  el.writeFailed.innerHTML = "";
}

function renderWriteScope() {
  for (const o of el.writeScope.options) {
    const c = writeScopeItems(o.value).length;
    o.textContent = `${SCOPE_LABEL[o.value]} · ${c} 个`;
    o.disabled = !c;
  }
  if (el.writeScope.selectedOptions[0]?.disabled) el.writeScope.value = [...el.writeScope.options].find((o) => !o.disabled)?.value || "filter";
  const busy = runs.get("write");
  const n = busy ? busy.total : writeScopeItems().length;
  const notes = el.writeFormat.value === "notes";
  const obsidianOff = document.body.classList.contains("obsidian-off");
  el.writeScopeCount.textContent = notes
    ? `共 ${n} 个视频，逐个抓字幕，间隔 ${S.settings.triageIntervalSec} 秒。下载 .zip 每个视频一篇，另附索引${obsidianOff ? "" : "；写入 Obsidian 每个视频一篇，另写一篇以收藏夹命名的索引"}。`
    : `共 ${n} 个视频，合成一篇：链接、AI 总结、标签和你的备注。`;
  el.writeOverwriteRow.hidden = !notes;
  el.writeMdBtn.textContent = notes ? "下载 .zip" : MdgErrors.LABEL.downloadMd;
  el.writeMdBtn.setAttribute("aria-label", el.writeMdBtn.textContent);
  el.writeCopyBtn.hidden = notes || busy;
  el.writeRunBtn.hidden = el.writeMdBtn.hidden = busy;
  el.writeStopBtn.hidden = !busy;
  // The pill's 停止 and this one are the same button: 停止中, off, with the pill's reason.
  el.writeStopBtn.textContent = busy?.stopping ? PILL_BTN.write[2] : PILL_BTN.write[1];
  UI.setReason(el.writeStopBtn, busy?.stopping ? stopWhy("write") : "");
  // A button busy writing (setBusy: 摘录 into Obsidian) stays off until its write ends, whatever the scope says now.
  for (const b of [el.writeCopyBtn, el.writeRunBtn, el.writeMdBtn]) if (b.dataset.idle == null) UI.setReason(b, n ? "" : `${EMPTY_SCOPE}${notes ? "（已失效的不写笔记）" : ""}`);
  el.writeScope.disabled = el.writeFormat.disabled = el.writeOverwrite.disabled = busy;
}

// Every scope is the open folder's videos, whose summaries loadResults has already read.
const digestMarkdown = () => buildMarkdown(writeScopeItems());

// how: copy | download | obsidian
async function exportDigest(how) {
  clearWriteResult();
  const filename = `B站摘录-${stamp()}.md`;
  if (how === "obsidian") {
    setBusy(el.writeRunBtn, MdgErrors.TEXT.writing);
    el.writeProgress.textContent = MdgErrors.TEXT.obsidianWriting;
  }
  const markdown = await digestMarkdown();
  if (how === "copy") {
    await navigator.clipboard.writeText(markdown).then(
      () => (el.writeProgress.textContent = MdgErrors.TEXT.copied),
      (err) => {
        el.writeProgress.textContent = `${MdgErrors.TEXT.copyFailed}：${err.message}`;
        el.writeProgress.classList.add("fail-text");
      }
    );
  } else if (how === "download") {
    MdgDownload.text(filename, markdown);
    el.writeProgress.textContent = `已下载 ${filename}`;
  } else {
    const r = await send({ type: "triage-export", filename, markdown });
    setBusy(el.writeRunBtn, false);
    el.writeProgress.textContent = r.ok ? r.data.text : `${MdgErrors.TEXT.obsidianFailed}：${r.error}`;
    el.writeProgress.classList.toggle("fail-text", !r.ok);
    el.writeSettingsBtn.hidden = MdgErrors.action(r.code) !== "settings";
  }
}

// The 逐个视频笔记 index, the same in the vault and in the zip; only the link form differs. title: the run's folder.
function indexMarkdown(written, link, title) {
  const lines = [`# ${title}`, "", `${stamp(new Date(), false)} · ${written.length} 篇`, ""];
  for (const w of written) {
    lines.push(`- ${link(w.path, w.title)}${w.oneLiner ? ` ${oneLine(w.oneLiner)}` : ""}`);
  }
  return lines.join("\n");
}

// The zip's files: the index named after the folder, then each note under its vault filename (a repeat gets " (2)").
// Repeats are found ignoring case: macOS and Windows unzip 「A.md」 and 「a.md」 onto one file.
function zipNotes(base, written, title) {
  const used = new Set([`${base}.md`.toLowerCase()]);
  const notes = written.map((w) => {
    let path = w.filename;
    for (let i = 2; used.has(path.toLowerCase()); i++) path = w.filename.replace(/\.md$/, ` (${i}).md`);
    used.add(path.toLowerCase());
    return { ...w, path };
  });
  return [{ name: `${base}.md`, text: indexMarkdown(notes, mdLink, title) }, ...notes.map((w) => ({ name: w.path, text: w.markdown }))];
}

// Obsidian itself unusable (obsidian.js obsidianError): every later note would fail alike, so the run stops.
const OBSIDIAN_CODES = new Set(["OBSIDIAN", "OBSIDIAN_DOWN"]);
// md: build the same notes but download them as a zip (one note each plus the index) instead of writing to the vault.
// The run keeps going with the dialog closed or another folder open: the activity pill shows it, the dialog reopens on it.
async function runWrite(md = false) {
  const items = writeScopeItems();
  const overwrite = el.writeOverwrite.checked;
  // Taken now: the index is named after this folder and lists these one-liners wherever the page is by then.
  const title = folderTitle();
  const oneLiners = Object.fromEntries(items.map((it) => [it.bvid, S.analyses[it.bvid]?.oneLiner]));
  clearWriteResult();
  if (el.banner.dataset.kind === "obsidian") el.banner.hidden = true;
  S.write = { md, mediaId: String(S.mediaId), text: "" };
  const written = [];
  const failed = [];
  // Notes written without their subtitle (字幕抓取失败) or with one that may not match the video: amber, like any
  // reminder that does not stop the run (DESIGN.md 琥珀), under the red failures.
  const warned = [];
  const showFailed = () => {
    el.writeFailed.innerHTML = [...failed.map((f) => `<li>${esc(f)}</li>`), ...warned.map((w) => `<li class="warn">${esc(w)}</li>`)].join("");
    el.writeFailed.hidden = !failed.length && !warned.length;
  };
  let obsidian = null; // the reply that showed Obsidian itself is unusable
  let indexPath = "";
  let indexError = ""; // the vault's index failed: said apart, not counted as a failed note
  let i = 0;
  let index = false;
  const verb = md ? "生成" : "写入";
  const running = runs.run("write", {
    total: items.length,
    gap: S.settings.triageIntervalSec * 1000,
    line: (d, t) => `${verb}笔记 ${d}/${t}${runWhere(S.write)}`,
    finished: () => S.write.text && `${S.write.text}${runWhere(S.write)}`,
    // Obsidian closed, not set up or refusing the key fails every note alike: checked first, and such a failure ends the run.
    async plan() {
      if (md) return {};
      el.writeProgress.textContent = "正在检查 Obsidian…";
      const r = await send({ type: "triage-obsidian-check" });
      return r.ok ? {} : void (obsidian = r);
    },
    // Each video, then the vault's index (no gap before it) once every video is done.
    next() {
      if (i < items.length) return { it: items[i], i: i++ };
      if (md || index || !written.length) return null;
      return (index = { index: true, n: 0, gap: 0 });
    },
    act(s) {
      if (s.index) return send({ type: "triage-export", filename: `${MdgCommon.fileName(title, "收藏夹")}.md`, markdown: indexMarkdown(written, wikiLink, title) });
      el.writeProgress.textContent = `${verb} ${s.i + 1}/${items.length}：${s.it.title}`;
      return send(md ? { type: "triage-build-note", bvid: s.it.bvid } : { type: "triage-write-note", bvid: s.it.bvid, title: s.it.title, overwrite });
    },
    // B站 risk control: wait as 粗看 / 细看 do, then the same video again.
    judge(r) {
      if (runs.hold(r)) {
        el.writeProgress.textContent = `${runs.hold(r).label}，等待后重试：${items[i - 1].title}`;
        return "wait";
      }
      return r.ok ? "ok" : OBSIDIAN_CODES.has(r.code) ? "stop" : "item";
    },
    done(s, r) {
      if (s.index) indexPath = r.ok ? r.data?.path || "" : ((indexError = r.error), "");
      else if (r.ok) {
        written.push({ ...r.data, bvid: s.it.bvid, oneLiner: oneLiners[s.it.bvid] });
        if (r.data?.subtitleWarning) warned.push(`${s.it.title}：${r.data.subtitleWarning}`), showFailed();
      }
      else {
        failed.push(`${s.it.title}：${r.error}`);
        showFailed();
      }
    }
  });
  renderWriteScope();
  const run = await running;
  if (run.error) obsidian = { error: run.error, code: run.code };
  if (md && written.length) {
    const base = MdgCommon.fileName(title, "收藏夹");
    indexPath = `${base}.zip`;
    MdgDownload.text(indexPath, zipStored(zipNotes(base, written, title)), "application/zip");
  }
  const skipped = written.filter((w) => w.skipped).length;
  const aiUpdated = written.filter((w) => w.aiUpdated).length;
  const counts = [
    `${md ? "下载" : "写入"} ${written.length - skipped} 篇`,
    skipped ? `已存在跳过 ${skipped} 篇` : "",
    aiUpdated ? `其中更新 AI 问答 ${aiUpdated} 篇` : "",
    failed.length ? `失败 ${failed.length} 篇` : "",
    indexError ? `索引写入失败：${indexError}` : ""
  ].filter(Boolean);
  el.writeProgress.textContent = [
    obsidian ? `${MdgErrors.TEXT.obsidianFailed}：${obsidian.error}。已停止` : run.stopped ? "已停止。" : "完成。",
    ...counts,
    indexPath ? `${md ? "文件" : "索引"}：${indexPath}` : ""
  ].filter(Boolean).join(" · ");
  el.writeProgress.classList.toggle("fail-text", Boolean(obsidian));
  const toSettings = MdgErrors.action(obsidian?.code) === "settings";
  el.writeSettingsBtn.hidden = !toSettings;
  showFailed();
  // The pill's green line; an Obsidian failure goes to the red banner instead, with 去设置 unless Obsidian is just not running.
  if (obsidian) {
    S.write.obsidian = true;
    showBanner(`${MdgErrors.TEXT.obsidianFailed}：${obsidian.error}`, toSettings ? MdgErrors.LABEL.toSettings : "", openOptions, "obsidian");
  } else S.write.text = `逐个视频笔记${run.stopped ? MdgErrors.LABEL.stopped : "完成"}：${counts.join(" · ")}`;

  renderWriteScope();
  renderStatus();
}

// ---------- data export ----------
// 待播 stays out: a list to watch from, not something to keep.
const { triageSnapshotPrefix: SNAPSHOT, triageTitlePrefix: TITLE, triageAnalysisPrefix: ANALYSIS, triageDecisionsPrefix: DECISIONS } = KEYS;
const BACKUP_PREFIXES = [K.kept, K.removed, K.left, K.tags, K.folderCriteria, K.videoTags, K.notes, SNAPSHOT, DECISIONS, TITLE, ANALYSIS];

async function buildBackup() {
  const all = await chrome.storage.local.get(null);
  const out = {
    app: "moondigest",
    schemaVersion: 3,
    exportedAt: new Date().toISOString(),
    extensionVersion: chrome.runtime.getManifest?.().version || "",
    settings: {
      triageIntervalSec: S.settings.triageIntervalSec,
      triageCoarseBatchSize: coarseBatchSize(),
      triageFineBatchSize: fineBatchSize(),
      triageAiBatchSize: aiBatchSize()
    },
    tags: [],
    folderCriteria: {}, // mediaId → 判断标准
    videoTags: {},
    notes: {},
    folders: {},
    titleResults: {},
    analyses: {}
  };
  const folder = (id) =>
    (out.folders[id] ||= { title: S.allFolders.find((f) => String(f.id) === id)?.title || "", snapshot: null, decisions: {} });
  for (const [k, v] of Object.entries(all || {})) {
    if (!BACKUP_PREFIXES.some((p) => k.startsWith(p))) continue;
    if (k === K.tags) out.tags = v;
    else if (k === K.kept) out.kept = v;
    else if (k === K.removed) out.removed = v;
    else if (k === K.left) out.left = v;
    else if (k === K.folderCriteria) out.folderCriteria = v;
    else if (k === K.videoTags) out.videoTags = v;
    else if (k === K.notes) out.notes = v;
    else if (k.startsWith(SNAPSHOT)) folder(k.slice(SNAPSHOT.length)).snapshot = v;
    else if (k.startsWith(DECISIONS)) folder(k.slice(DECISIONS.length)).decisions = v;
    else if (k.startsWith(TITLE)) out.titleResults[k.slice(TITLE.length)] = v;
    else if (k.startsWith(ANALYSIS)) out.analyses[k.slice(ANALYSIS.length)] = v;
  }
  // ✦ AI 打标签's recent instructions, as 关注's follow_ai_history below.
  if (all?.[K.aiHistory] !== undefined) out.aiHistory = all[K.aiHistory];
  // 关注's own data (UP tags, who has which, 已取消关注, the last AI batch); its copies of B站 data come back on 刷新.
  out.follow = {};
  const fw = MdgLimits.followShort(all);
  for (const k of ["tags", "tag_map", "unfollowed", "ai_recent", "ai_history"]) if (fw[k] !== undefined) out.follow[k] = fw[k];
  return out;
}


function buildCsv() {
  const title = folderTitle();
  const header = ["收藏夹", "BV 号", "标题", "UP 主", "时长", "链接", "封面", "发布时间", "收藏时间", "简介", MdgErrors.LABEL.aiVerdict, "判断来源", "理由", "一句话", "要点", "标签", "备注", "我的处理", "处理时间", "是否失效", "原在", "离开原因"];
  const rows = [header];
  for (const it of S.items) {
    const v = verdictOf(it);
    const a = S.analyses[it.bvid];
    const done = a?.status === "done";
    const d = S.decisions[it.bvid];
    rows.push([
      it.folders ? folderNames(it) : title,
      it.bvid,
      it.title,
      it.upper,
      fmtDuration(it.duration),
      videoUrl(it.bvid),
      it.cover || "",
      fmtDate(it.pubdate),
      fmtDate(it.favTime),
      it.intro || "",
      v.verdict === "none" ? "" : verdictLabel(v.verdict),
      [KIND_NAME.invalid, STEP_NAME.coarse, STEP_NAME.fine][v.stage] || "", // stage 0: judged by being invalid (tag-core verdictOf)
      v.reason,
      done ? a.oneLiner || "" : "",
      done ? (a.points || []).join(" | ") : "",
      tagIdsOf(it.bvid).map((id) => tagById(id).name).join("、"),
      S.notes[it.bvid]?.text?.trim() || "",
      d ? (d.action === "unfav" ? "取消收藏" : "保留") : "",
      d ? fmtTime(d.at) : "",
      it.invalid || it.hidden ? "是" : "否", // as kindOf: hidden by B站 is 已失效 too
      (it.from || []).map((f) => f.title).join("、"),
      it.removedAt ? leftText(it) : ""
    ]);
  }
  return UI.toCsv(rows);
}

// ---------- events ----------
function bindEvents() {
  el.sortBox.addEventListener("change", (e) => {
    if (e.target.matches("[data-sort]")) setSort(e.target.value, SORT_DIR[e.target.value]);
  });
  el.sortBox.addEventListener("click", (e) => {
    if (!e.target.closest("[data-sort-dir]")) return;
    const { sort, dir } = sortOf();
    setSort(sort, dir === "asc" ? "desc" : "asc");
  });
  el.folderSelect.addEventListener("change", () => openFolder(el.folderSelect.value));
  // A cover that fails to load leaves the colored tint behind it.
  for (const box of [el.folderList, el.folderHead]) box.addEventListener("error", (e) => e.target.remove?.(), true);
  el.folderList.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-folder]");
    if (btn && btn.dataset.folder !== String(S.mediaId)) openFolder(btn.dataset.folder);
  });
  el.refreshBtn.addEventListener("click", () => {
    if (S.seenCfg.on) seenSync(true);
    if (inFolderView() && fav.state().writing(S.mediaId)) toast("这个收藏夹正在批量修改，结束后自动刷新");
    S.mediaId === ALL ? refreshAll() : S.mediaId === REMOVED ? openFolder(REMOVED) : S.mediaId && syncFolder({ force: true });
  });
  const autoSync = () => {
    if (S.mediaId && S.mediaId !== ALL && S.mediaId !== REMOVED && document.visibilityState === "visible") quickSync();
  };
  window.addEventListener("focus", autoSync);
  document.addEventListener("visibilitychange", autoSync);

  const showTab = (tab) => {
    if (tab !== S.tab) S.selected.clear();
    S.tab = tab;
    S.focused = "";
    el.list.scrollTop = 0;
    render();
  };
  el.tabs.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-tab]");
    if (btn) showTab(btn.dataset.tab);
    const kind = e.target.closest("[data-kindtab]");
    if (kind) {
      S.kindFilter = kind.dataset.kindtab;
      S.selected.clear(); // a selection belongs to its tab
      render();
    }
  });
  UI.bindSearch(el.searchInput, (q) => {
    S.query = q;
    // A search that hides the focused card starts the focus at the top.
    const f = S.itemMap.get(S.focused);
    if (!f || !passFilter(f)) S.focused = "";
    render();
  });
  // Row 3: one pick per group, a second click clears it; 全部 clears the whole row (not row 4's tags).
  el.classFilter.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    e.stopPropagation();
    if (b.matches("[data-airecent-done]")) endAiRecent();
    else if (b.matches("[data-states-all]")) pickState("all");
    else if (b.dataset.classFilter) pickState("class", b.dataset.classFilter);
    else if (b.matches("[data-finishedfilter]")) pickState("seen");
    else if (b.matches("[data-dupfilter]")) pickState("dup");
    else if (b.dataset.kindfilter) pickState("kind", b.dataset.kindfilter);
    else if (b.matches("[data-airecent]")) pickState("recent");
    else return;
    render();
  });
  el.tagFilter.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-tagfilter]");
    if (!btn) return;
    const ids = btn.dataset.tagfilter.split(",");
    const on = ids.some((id) => S.tagFilter.has(id));
    for (const id of ids) on ? S.tagFilter.delete(id) : S.tagFilter.add(id);
    render();
  });

  const onHeadClick = (e) => {
    const btn = e.target.closest("[data-head]");
    if (!btn) return;
    const act = btn.dataset.head;
    if (act === "tags") openAi();
    else if (act === "aiOther") openFolder(otherAiFolder()).then(openAi);
    else if (act === "stage1") {
      if (!runs.get("stage1")) {
        const list = stage1Pending();
        return startJudging(stage1Label(list), "粗看", list, () => runStage1(list));
      }
      runs.stop("stage1");
      render();
    } else if (act === "group") {
      if (S.group) {
        runs.stop("group");
        return render();
      }
      // The batch stays selected, as with 标题粗看; its cards leave the selection when they leave the tab.
      const batch = nextBatch();
      const items = batch.map((b) => S.itemMap.get(b));
      startJudging(groupLabel(items), "细看", items, () => startGroup(batch));
    } else if (act === "batch-unfav") fav.unfavMany(batchList(btn.dataset.verdict || null));
    else if (act === "batch-keep") batchKeep(batchList(btn.dataset.verdict || null));
    else if (act === "criteria") openCriteria();
    else if (act === "write") stopWrite();
    else if (act === "fav") W.stop();
    else if (act === "redo-coarse") {
      const { batch, label } = redoOf("coarse");
      startJudging(label, "重新粗看", batch, () => runStage1(batch, true));
    } else if (act === "redo-fine") {
      const { batch, label } = redoOf("fine");
      startJudging(label, "重新细看", batch, () => startGroup(batch.map((it) => it.bvid), true));
    }
    else if (act === "sel-tags") openPicker(visibleSelected().map((it) => it.bvid));
    else if (act === "all-pause") {
      S.loadAll.paused = true;
      render();
    } else if (act === "all-resume") {
      S.loadAll.paused = false;
      runLoadAll(S.folderToken);
    }
    else if (act === "clean-removed") cleanRemoved(visibleItems());
    else if (act === "clean-selected") cleanRemoved(selectedIn(visibleItems()));
    else if (act === "transfer") fav.transfer(transferList());
    else if (act === "select-all") {
      UI.toggleAll(visibleItems().map((it) => it.bvid), S.selected);
      render();
    } else if (act === "clear-selected") {
      S.selected.clear();
      render();
    }
  };
  // listHeader is inside stagebar; binding both would handle one bubbling click twice.
  el.stagebar.addEventListener("click", onHeadClick);
  el.favSel.addEventListener("click", onHeadClick);
  el.activity.addEventListener("click", onHeadClick);

  el.list.addEventListener("click", (e) => {
    if (e.target.closest("[data-pick-folders]")) return openSettings(false, true);
    if (e.target.closest("[data-refresh]")) return el.refreshBtn.click();
    const refav = e.target.closest("[data-refav]");
    if (refav) return fav.refav(refav.dataset.refav);
    const refavAll = e.target.closest("[data-refav-batch]");
    if (refavAll) return fav.refavBatch(Number(refavAll.dataset.refavBatch));
    const picked = e.target.closest(".card[data-bvid]");
    if (picked && UI.cardPickClick(e)) {
      e.preventDefault();
      if (e.shiftKey) getSelection().removeAllRanges();
      setFocus(picked.dataset.bvid, false);
      pickAnchor = UI.pickCard(S.selected, visibleItems().map((it) => it.bvid), picked.dataset.bvid, pickAnchor, e.shiftKey);
      return showPicks();
    }
    const clean = e.target.closest("[data-clean]");
    if (clean) return cleanRemoved([S.itemMap.get(clean.dataset.clean)].filter(Boolean));
    if (e.target.closest("[data-retry-failed]")) return retryFailed();
    const card = e.target.closest(".card");
    if (!card) return;
    if (e.target.closest("a[href]")) {
      if (!plainClick(e)) return;
      e.preventDefault();
    }
    const bvid = card.dataset.bvid;
    const untag = e.target.closest("[data-untag]");
    if (untag) return removeVideoTag(bvid, untag.dataset.untag);
    const act = e.target.closest("[data-act]")?.dataset.act;
    setFocus(bvid, false);
    if (act) cardAction(act, bvid);
    else if (UI.cardPlayClick(e)) cardAction("open", bvid);
  });

  // The pointer makes a card current only when the hand moves it. A mousemove at the same position comes from the
  // list scrolling (J/K, wheel) or re-rendering under a still pointer and must not steal the keyboard's current card.
  let pointerAt = null;
  el.list.addEventListener("mousemove", (e) => {
    if (!pointerMoved(pointerAt, e.clientX, e.clientY)) return;
    pointerAt = { x: e.clientX, y: e.clientY };
    const bvid = e.target.closest(".card")?.dataset.bvid;
    if (bvid && bvid !== S.focused) setFocus(bvid, false);
  });

  // A note saves 400 ms after typing stops, but never mid-IME: compositionend saves the committed text.
  const noteEdit = (e) => {
    if (!e.target.matches("[data-note]")) return;
    const b = e.target.closest(".card").dataset.bvid;
    const text = e.target.value.trim();
    if (text) S.notes[b] = { text: e.target.value, updatedAt: Date.now() };
    else delete S.notes[b];
    notePending.add(b);
    clearTimeout(noteTimer);
    noteTimer = setTimeout(flushNotes, 400);
  };
  el.list.addEventListener("input", (e) => !e.isComposing && noteEdit(e));
  el.list.addEventListener("compositionend", (e) => {
    noteEdit(e);
    if (listDeferred) setTimeout(renderList);
  });
  // Enter (or Esc) saves now and leaves the note so card keys work again; Shift+Enter is a newline. Never mid-IME.
  el.list.addEventListener("keydown", (e) => {
    if (composing(e) || !e.target.matches("[data-note]")) return;
    if (!(e.key === "Escape" || (e.key === "Enter" && !e.shiftKey))) return;
    e.preventDefault();
    if (noteTimer) void flushNotes();
    e.target.blur();
  });
  // An emptied note folds back to 「+ 备注」.
  el.list.addEventListener("focusout", (e) => {
    if (!e.target.matches("[data-note]") || e.target.value.trim()) return;
    S.noteOpen.delete(e.target.closest(".card").dataset.bvid);
    setTimeout(renderList);
  });

  document.addEventListener("keydown", onKey);
  el.viewerCloseBtn.addEventListener("click", closeViewer);
  // The open folder's own Bilibili page; 所有收藏夹 and 已出分拣范围 have none, so they go to the space page.
  el.biliBtn.addEventListener("click", () =>
    openTab(
      S.mediaId === TOVIEW
        ? "https://www.bilibili.com/watchlater/list"
        : `https://space.bilibili.com/${S.mid}${inFolderView() ? `/favlist?fid=${S.mediaId}&ftype=create` : ""}`
    )
  );

  el.settingsBtn.addEventListener("click", () => openSettings());
  for (const input of [el.thinkingInput, el.titleMaxInput, el.analyzeMaxInput]) {
    input.addEventListener("input", renderTokenHints);
  }
  el.settingsDialog.addEventListener("click", (e) => {
    const all = e.target.closest("[data-folders-all]");
    if (!all && !e.target.closest("[data-folders-none]")) return;
    for (const box of el.folderToggles.querySelectorAll("input")) box.checked = Boolean(all);
  });
  el.settingsDialog.addEventListener("close", async () => {
    if (el.settingsDialog.returnValue !== "save") return;
    const patch = {
      ...Object.fromEntries(NUM_FIELDS.map(([key, kind, input]) => [key, UI.numSetting(kind, el[input].value)])),
      triageThinking: el.thinkingInput.checked,
      triageAiRemoveTags: el.aiRemoveTagsInput.checked
    };
    const r = await send({ type: "triage-settings-save", ...patch });
    if (!r.ok) {
      toast(`${MdgErrors.TEXT.settingsSaveFailed}：${r.error}`, true);
      return;
    }
    Object.assign(S.settings, patch);
    renderTagLimit();
    render(); // the batch sizes are on row 3's buttons and 粗看完成's 下一批 marks
    toast(MdgErrors.TEXT.settingsSaved);
    const included = [...el.folderToggles.querySelectorAll("input:checked")].map((x) => x.value);
    // 稍后再看 had no checkbox (its read failed): its choice stays as it was.
    if (S.toviewUnread && S.included.includes(TOVIEW)) included.push(TOVIEW);
    const same = included.length === S.included.length && included.every((id) => S.included.includes(id));
    if (S.allFolders.length && !same) {
      await storeSet(K.included, included);
      await applyIncluded(included);
    }
  });
  el.writeBtn.addEventListener("click", () => openWrite());
  el.writeScope.addEventListener("change", renderWriteScope);
  el.writeFormat.addEventListener("change", renderWriteScope);
  const digest = () => el.writeFormat.value === "digest";
  el.writeCopyBtn.addEventListener("click", () => exportDigest("copy"));
  el.writeRunBtn.addEventListener("click", () => (digest() ? exportDigest("obsidian") : runWrite()));
  el.writeMdBtn.addEventListener("click", () => (digest() ? exportDigest("download") : runWrite(true)));
  el.writeStopBtn.addEventListener("click", stopWrite);
  el.writeSettingsBtn.addEventListener("click", openOptions);
  el.openOptionsBtn.addEventListener("click", openOptions);
  // Both modes' 导出 menus carry the same 完整备份 item.
  document.addEventListener("click", async (e) => {
    if (!e.target.closest("[data-backup]")) return;
    try {
      MdgDownload.text(`MoonDigest备份-${stamp()}.json`, JSON.stringify(await buildBackup(), null, 2), "application/json");
    } catch (err) {
      toast(`导出备份失败：${err.message}`, true);
    }
  });
  el.csvBtn.addEventListener("click", () => {
    MdgDownload.text(`MoonDigest-${MdgCommon.fileName(folderTitle())}-${stamp(new Date(), false)}.csv`, buildCsv(), "text/csv;charset=utf-8");
  });
  el.helpBtn.addEventListener("click", () => el.helpDialog.showModal());
  // A download leaves the page as it was, so the 导出 menu would stay open over it.
  el.tools.addEventListener("click", (e) => e.target.closest("button") && el.tools.hidePopover());
  document.querySelector("[data-open-settings]")?.addEventListener("click", () => openSettings());
  el.toast.addEventListener("click", () => (el.toast.hidden = true));

  UI.bindSync(syncEls());
  el.bannerClose.addEventListener("click", () => (el.banner.hidden = true));

  el.viewerTags.addEventListener("click", (e) => e.target.closest("[data-vtag]") && tagPlaying());
  // T / Esc pressed while focus is in the player (viewer-frame.js): the one listener for both modes, as onKey is. 关注 takes
  // them through modeKeys; in 收藏夹, T tags the playing video and Esc closes the player, unless a dialog is open.
  // The same listener takes the video the player shows now: B站's autoplay may have moved on (viewer-frame.js).
  window.addEventListener("message", (e) => {
    const b = e.source === el.viewerFrame.contentWindow && e.origin === "https://www.bilibili.com" && e.data?.type === "mdg-viewer-video" && e.data.bvid;
    if (b) {
      if (!S.viewing || typeof b !== "string" || !/^BV\w+$/.test(b) || b === S.viewing) return;
      viewerPast = [...viewerPast, ...(S.viewer?.folders || [])];
      return showViewing(b);
    }
    const key = UI.viewerKeyFrom(e, el.viewerFrame.contentWindow);
    if (!key || modeKeys?.(key, e) != null || document.querySelector("dialog[open]")) return;
    if (key === "Escape") closeViewer();
    else tagPlaying();
  });

  el.criteriaInput.addEventListener("keydown", (e) => {
    if (composing(e) || e.key !== "Enter" || e.shiftKey) return;
    e.preventDefault();
    el.criteriaDialog.close("save");
  });
  el.criteriaDialog.addEventListener("close", () => {
    if (el.criteriaDialog.returnValue === "save") saveCriteria();
  });
  el.aiTagSlot.addEventListener("click", (e) => {
    if (e.target.closest("[data-tags-manage]")) openManage();
    else if (e.target.closest("[data-ai-tag]")) openAi();
  });

  // basket
  el.basketToggle.addEventListener("click", () => setBasketOpen(el.basket.classList.contains("collapsed")));
  el.basketClearBtn.addEventListener("click", clearBasket);
  el.basketList.addEventListener("click", (e) => {
    const act = e.target.closest("[data-basket]")?.dataset.basket;
    if (!act) return;
    const i = Number(e.target.closest(".basket-item").dataset.i);
    if (act === "open") openBasketItem(i);
    else if (act === "remove") {
      removeBasketItems([i]);
      toast(BASKET_REMOVED);
    }
  });
}

// The tag caps are written into the help dialog's static hints.
function renderTagLimit() {
  for (const node of document.querySelectorAll("[data-tag-limit]")) node.textContent = tagLimit();
  for (const node of document.querySelectorAll("[data-ai-new-tag-max]")) node.textContent = S.settings.triageAiNewTagMax;
}

function renderTokenHints() {
  const on = el.thinkingInput.checked;
  // ✦ AI 打标签 takes a number set here; left empty it has its own 自动 per batch (autoMaxTokens "command").
  el.titleMaxHint.textContent = `留空 = 自动（${UI.autoMaxTokens("title", TITLES_PER_REQUEST, on)}；✦ AI 打标签按每批数量另算），被截断时再调大。填了数时 ✦ AI 打标签也用它。`;
  el.analyzeMaxHint.textContent = `留空 = 自动（${UI.autoMaxTokens("analyze", 1, on)}）`;
}

// firstRun: the first open, before any folder is chosen, asks only for folders.
function openSettings(scrollToLimits = false, firstRun = false) {
  // Named like the button that opened it: the first run's 选择收藏夹, otherwise ⚙ 收藏夹设置 (the dialog is labelled by it).
  el.settingsHeading.textContent = firstRun ? PICK_FOLDERS : SETTINGS_NAME;
  el.settingsAi.hidden = firstRun;
  el.settingsFoldersHeading.hidden = firstRun;
  el.settingsFirstRunHint.hidden = !firstRun;
  el.folderToggles.innerHTML = S.allFolders
    .map((f) => `<label class="toggle"><input type="checkbox" name="includedFolder" value="${esc(f.id)}"${S.included.includes(String(f.id)) ? " checked" : ""} /> ${esc(f.title)} <span class="muted">${esc(f.count)}</span></label>`)
    .join("") || `<p class="dialog-hint">${esc(S.foldersRead == null ? "收藏夹列表还没加载" : S.foldersRead ? `读取收藏夹失败：${S.foldersRead}` : NO_FOLDERS)}</p>`;
  el.thinkingRow.hidden = !hasThinkingToggle();
  // The side panel may have switched platform since this page loaded: ask again which one the requests go to.
  send({ type: "triage-settings-get" }).then((r) => {
    if (!r.ok) return;
    S.settings.thinkingToggle = r.data.thinkingToggle;
    el.thinkingRow.hidden = !hasThinkingToggle();
  });
  el.intervalInput.value = S.settings.triageIntervalSec;
  el.coarseBatchInput.value = coarseBatchSize();
  el.fineBatchInput.value = fineBatchSize();
  el.aiBatchInput.value = aiBatchSize();
  el.thinkingInput.checked = Boolean(S.settings.triageThinking);
  el.titleMaxInput.value = S.settings.triageTitleMaxTokens || "";
  el.analyzeMaxInput.value = S.settings.triageAnalyzeMaxTokens || "";
  el.tagLimitInput.value = tagLimit();
  el.aiNewTagMaxInput.value = S.settings.triageAiNewTagMax;
  el.aiRemoveTagsInput.checked = S.settings.triageAiRemoveTags === true;
  renderTokenHints();
  el.settingsDialog.returnValue = "";
  el.settingsDialog.showModal();
  if (scrollToLimits) el.titleMaxInput.scrollIntoView({ block: "center" });
}

// it.url: another B站 page in its place (an UP's space, with bvid its own key).
function openViewer(it) {
  // Another video opened over a playing one: its folders are re-read on close too (it may have been faved meanwhile).
  viewerPast = S.viewing ? [...viewerPast, ...(S.viewer?.folders || [])] : [];
  el.viewerFrame.src = it.url || videoUrl(it.bvid);
  el.viewer.hidden = false;
  el.main.classList.add("viewing");
  showViewing(it.bvid);
}

// The folders of videos played earlier in this viewer (B站's autoplay moved on): closing refreshes them too.
let viewerPast = [];

// The viewer now shows b: the pink card, its tag lines and T follow it. A video in no chosen folder has no lines.
function showViewing(b) {
  S.viewing = b;
  const own = viewerOf(b);
  S.viewer = own;
  render();
  // A 待播 video from a folder not open (or one played in 关注): its folders are the chosen ones whose cached list holds it.
  if (!own) {
    viewerHome(b).then((v) => {
      if (S.viewing !== b || !v) return;
      S.viewer = v;
      renderViewerTags();
    });
  }
}

// S.viewer for a video of the open view; null when it is not in it.
function viewerOf(b) {
  return S.itemMap.has(b) ? { item: S.itemMap.get(b), folders: S.mediaId === REMOVED ? null : pickerFolders(b) } : null;
}
async function viewerHome(bvid) {
  const ids = S.folders.map((f) => String(f.id));
  const got = await chrome.storage.local.get(ids.map(K.snapshot));
  const folders = ids.filter((id) => got[K.snapshot(id)]?.items?.some((x) => x.bvid === bvid));
  return folders.length ? { item: got[K.snapshot(folders[0])].items.find((x) => x.bvid === bvid), folders } : null;
}

function setBasketOpen(open) {
  el.basket.classList.toggle("collapsed", !open);
  el.basketToggle.setAttribute("aria-expanded", String(open));
}

// Likes, coins and favorites happen on Bilibili's own page, so the folder is re-read once the viewer closes.
// Only the video's own folder, when it is the one open; another folder checks its list when it is opened.
function closeViewer() {
  if (!S.viewing) return;
  const home = [...(S.viewer?.folders || []), ...viewerPast];
  S.viewing = "";
  S.viewer = null;
  el.viewerFrame.src = "about:blank";
  el.viewer.hidden = true;
  el.main.classList.remove("viewing");
  render();
  if (inFolderView() && !followMode() && home.includes(String(S.mediaId))) quickSync({ force: true });
}

function cardAction(act, bvid) {
  const it = S.itemMap.get(bvid);
  if (!it) return;
  if (act === "open") openViewer(it);
  else if (act === "ask") askAi(it);
  else if (act === "unfav") fav.unfav(bvid);
  else if (act === "keep") keepOne(bvid);
  else if (act === "tag") openPicker(bvid);
  else if (act === "basket") toggleBasket(bvid);
  else if (act === "retry") retry(bvid);
  else if (act === "note") {
    S.noteOpen.add(bvid);
    renderList();
    el.list.querySelector(`.card[data-bvid="${CSS.escape(bvid)}"] [data-note]`)?.focus();
  }
  else if (act === "select") {
    pickAnchor = UI.pickCard(S.selected, [], bvid);
    showPicks();
  }
}

// A pick changes only the cards' blue marks, the selection bar and the failed group's 重试, so the list is not rebuilt;
// in 粗看完成 the selection is the next batch (its order and labels), so that tab draws everything again.
function showPicks() {
  if (S.tab === "coarse") return render();
  for (const card of el.list.querySelectorAll(".card[data-bvid]")) card.classList.toggle("selected", S.selected.has(card.dataset.bvid));
  const list = visibleItems();
  const head = el.list.querySelector(".group-head");
  if (head) head.outerHTML = failedHeadHtml(list.filter((it) => failedIn(S.tab, it)));
  renderListHeader(list);
}

function onKey(e) {
  if (composing(e) || typingIn(e) || e.metaKey || e.ctrlKey || e.altKey) return;
  const t = e.target;
  if ((e.key === "Enter" || e.key === " ") && t.closest?.("button, a")) return;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  // Before the open-dialog check: the mode decides which of its dialogs own the keys.
  const used = modeKeys?.(key, e);
  if (used != null) return used && e.preventDefault();
  if (document.querySelector("dialog[open]")) return;
  const map = {
    "?": () => el.helpDialog.showModal(),
    "/": () => el.searchInput.focus(),
    i: () => (aiTagReason() ? toast(aiTagReason()) : openAi())
  };
  const nav = { j: 1, ArrowDown: 1, k: -1, ArrowUp: -1 };
  const cardKeys = { d: "unfav", s: "keep", t: "tag", e: "basket", q: "ask", x: "select", o: "open", Enter: "open" };
  if (key === "Escape" && S.viewing) closeViewer();
  // Esc with nothing else open clears the selection.
  else if (key === "Escape" && S.selected.size && !document.querySelector(":popover-open")) {
    S.selected.clear();
    render();
  } else if (map[key]) map[key]();
  else if (nav[key]) moveFocus(nav[key]);
  else if (key === "u") undo();
  // 已出分拣范围 has no 保留 / 取消收藏 / 标签; 待播, 问 AI, X, O / Enter (play, like a title click) and U work there
  // (X picks for 清理 and 收藏到).
  else if (S.mediaId === REMOVED && !["e", "q", "x", "o", "Enter"].includes(key)) return;
  else if (cardKeys[key] && S.focused) cardAction(cardKeys[key], S.focused);
  else return;
  e.preventDefault();
}
