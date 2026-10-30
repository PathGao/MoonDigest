"use strict";
// 收藏夹's tags (where they live and what a folder allows; tag-store.js does the rest), 判断标准 and 标签管理.

// ---------- tags (tag-store.js) ----------
// A tag belongs to one folder: made only there, at most tagLimit() per folder (收藏夹设置); an AI 打标签 the user
// confirmed may go past it, and 标签管理 then says to delete some.
const tagsDb = MdgTagStore.local({
  keys: { tags: K.tags, map: K.videoTags },
  get: () => ({ tags: S.tags, map: S.videoTags }),
  put({ tags, map }) {
    if (tags) S.tags = tags;
    if (map) S.videoTags = map;
  },
  save: (patch) => (noteOwnWrites(patch), store(patch))
});
// A tag deleted (here, by U, or in another tab): off the filter, and a proposal naming it is dropped.
function tagGone(id) {
  S.tagFilter.delete(id);
  pruneAiProposals();
}
const tagStore = MdgTagStore.create({
  ...tagsDb,
  who: "视频",
  idPrefix: "t",
  scoped: true,
  scopeWhy: (folder) => (!folder || folder === ALL || folder === REMOVED ? FOLDER_ONLY : ""),
  cap: () => tagLimit(),
  full: (n) => `这个收藏夹已经有 ${n} 个标签了，先删掉不用的，或在${SETTINGS_NAME}里调高上限`,
  fullShort: (folder) => `${folder === ALL ? "各收藏夹" : ""}名额已满`,
  newTagMax: () => S.settings.triageAiNewTagMax,
  steps: { push: (step) => pushUndo({ kind: "tags", ...step }), drop: (pred) => (S.undo = S.undo.filter((e) => !pred(e))) },
  confirm: (...a) => askConfirm(...a),
  say: (text, error) => toast(text, error),
  changed: () => render(),
  undone(bvids) {
    if (bvids.length === 1) S.focused = bvids[0];
    render();
    setFocus(S.focused);
  },
  tagGone,
  setProposal: (p) => (S.ai.proposal = p),
  live: () => S.itemMap,
  // This batch replaces the folder's last one; the list shows it to look over.
  markRecent(bvids, at) {
    S.aiRecentFilter = true;
    return editAiRecent(String(S.mediaId), { at, bvids });
  },
  // Another tab, or a later batch here, may have replaced the folder's 「AI 刚打的」 since.
  endRecent(at) {
    for (const [folder, r] of Object.entries(S.aiRecent)) if (r.at === at) endAiRecent(folder, at);
  }
});

// 「AI 刚打的」 of the open folder (a Set of bvids); empty in 所有收藏夹 and 已出分拣范围.
// Asked per video while filtering, so the set is built once per list (lists are replaced, never changed in place).
let aiRecentMemo = [null, new Set()];
const aiRecentSet = () => {
  const bvids = S.aiRecent[String(S.mediaId)]?.bvids;
  if (aiRecentMemo[0] !== bvids) aiRecentMemo = [bvids, new Set(bvids || [])];
  return aiRecentMemo[1];
};
// One folder's 「AI 刚打的」 set (r) or ended (null), on the page's copy at once and on the stored map by read-modify-write,
// so another tab's folder keeps its own; the page then takes what was written. Ending one batch (at) leaves a newer one
// another tab stored for the folder meanwhile.
function editAiRecent(folder, r, at) {
  const apply = (m) => {
    if (r) m[folder] = r;
    else if (at === undefined || m[folder]?.at === at) delete m[folder];
    return m;
  };
  apply(S.aiRecent);
  return storeEdit(K.aiRecent, {}, apply).then((m) => {
    if (m) S.aiRecent = m;
  });
}
// × and U end the folder's 「AI 刚打的」; × leaves the tags as they are.
function endAiRecent(folder = String(S.mediaId), at) {
  if (folder === String(S.mediaId)) S.aiRecentFilter = false;
  return editAiRecent(folder, null, at);
}

// T or 「+ 标签」 on a card opens the shared picker (tag-picker.js) under that button; T in the player or 「+ 标签」 on the
// viewer line opens it under that line. The selection bar's 标签… opens it as a modal for the selected videos (one folder). Closing saves once, as
// one undo step. home ({ item, folders }, the viewer's) tags that video in its own folders, whatever is open.
function openPicker(bvids, anchor = "", home = null) {
  bvids = [].concat(bvids).filter((b) => home || S.itemMap.has(b));
  if (!bvids.length || (!home && S.mediaId === REMOVED)) return;
  tagStore.openPicker({
    title: UI.pickTitle(bvids.length, shortTitle(home?.item || S.itemMap.get(bvids[0])), "视频"),
    targets: bvids,
    scopes: home?.folders || pickerFolders(bvids[0]),
    anchor,
    async done(saving) {
      const n = await saving;
      if (n) toast(tagStore.updatedText(n));
      render();
      setFocus(S.focused, true);
    }
  });
}

// The picker's tags: the open folder's; in 所有收藏夹 those of the folders the video is in. New tags need one folder.
function pickerFolders(bvid) {
  return inFolderView() ? [String(S.mediaId)] : (S.itemMap.get(bvid)?.folders || []).map(String);
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
  el.criteriaTitle.textContent = `判断标准 ·「${folderName(S.mediaId)}」`;
  el.criteriaInput.value = criteria();
  el.criteriaDialog.returnValue = "";
  el.criteriaDialog.showModal();
  el.criteriaInput.focus();
}

// These folders' 判断标准 ([[id, text]]; an empty text removes it), on the page's copy at once and on the stored map by
// read-modify-write, so a 判断标准 another tab wrote for its folder stays; the page then takes what was written.
function setCriteria(pairs) {
  const apply = (c) => {
    for (const [id, text] of pairs) {
      if (text.trim()) c[id] = text.trim();
      else delete c[id];
    }
    return c;
  };
  apply(S.folderCriteria);
  return storeEdit(K.folderCriteria, {}, apply).then((c) => {
    if (c) S.folderCriteria = c;
  });
}

async function saveCriteria() {
  const changed = el.criteriaInput.value.trim() !== criteria();
  await setCriteria([[S.mediaId, el.criteriaInput.value]]);
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
  await setCriteria([...el.confirmBody.querySelectorAll("[data-crit]")].map((box) => [box.dataset.crit, box.value]));
  render();
  return true;
}
// A 粗看 / 细看 button: in 所有收藏夹 after askAllCriteria, elsewhere at once.
async function startJudging(title, verb, items, start) {
  if (S.mediaId === ALL && !(await askAllCriteria(title, verb, items))) return;
  start();
}

// ---------- 标签管理 (tag-dialogs.js): the open folder's tags ----------
const manageTags = tagStore.manage({
  hint: () => `这里是这个收藏夹的标签，最多 ${tagLimit()} 个（在${SETTINGS_NAME}里改）。`,
  reason: () => (inFolderView() ? "" : FOLDER_ONLY),
  tags: () => (inFolderView() ? viewTags() : []),
  scope: () => String(S.mediaId)
});
const openManage = () => TagDialogs.manage.open(manageTags);

// The AI proposals, one per folder, changed on the page's copy at once and on the stored map by read-modify-write, so a
// proposal another tab holds for its folder stays; the page then takes what was written. edit(map) → the next map.
function editAiProposalsWith(edit) {
  S.ai.proposals = edit(S.ai.proposals);
  return storeEdit(K.aiProposals, {}, edit).then((m) => {
    if (m) S.ai.proposals = m;
  });
}
// One folder's proposal set (p) or dropped (null).
function editAiProposals(folder, p) {
  return editAiProposalsWith((m) => {
    if (p) m[folder] = p;
    else delete m[folder];
    return m;
  });
}
// A proposal naming a deleted tag no longer fits; it is dropped rather than applied.
function pruneAiProposals() {
  if (Object.values(S.ai.proposals).every((p) => tagStore.fits(p))) return;
  return editAiProposalsWith((m) => Object.fromEntries(Object.entries(m).filter(([, p]) => tagStore.fits(p))));
}
