"use strict";
// 收藏夹's AI steps: 标题粗看, 字幕细看 and ✦ AI 打标签.

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
        else S.coarseFailed.set(it.bvid, r.ok ? r.data?.failed?.[it.bvid] || "AI 回复里没有这个视频" : MdgErrors.text(r));
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
