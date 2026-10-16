"use strict";
// 收藏夹's tags, 判断标准 and 标签管理.

// ---------- tags ----------
const saveTags = () => storeSet(K.tags, S.tags);

// Why the folder takes no new tag: it has tagLimit() already ("" while it has room).
function tagCapReason(folder = S.mediaId) {
  const n = S.tags.filter((t) => t.folder === String(folder)).length;
  return n >= tagLimit() ? `这个收藏夹已经有 ${n} 个标签了，先删掉不用的，或在${SETTINGS_NAME}里调高上限` : "";
}

// Returns the folder's tag with this name, creating it if needed; the color comes from the palette in turn.
// null (with a toast) outside a folder or when the folder already has tagLimit() tags, unless overCap: an AI 打标签 the
// user confirmed may go past the cap, and 标签管理 then says to delete some.
function createTag(name, folder = S.mediaId, { overCap = false } = {}) {
  name = cleanTagName(name);
  if (!name) return toast(UI.tagNameError(name, []), true), null;
  if (folder === ALL || folder === REMOVED || !folder) return toast(FOLDER_ONLY, true), null;
  const own = S.tags.filter((t) => t.folder === String(folder));
  const existing = own.find((t) => t.name === name);
  if (existing) return existing;
  const full = !overCap && tagCapReason(folder);
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
