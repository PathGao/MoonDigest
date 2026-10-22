"use strict";
// 收藏夹's drawing: the sidebar, the folder head, tabs, row 3, the card list and focus.

// ---------- render ----------
function render() {
  renderTop();
  renderTabs();
  renderList();
  renderBasket();
  renderViewerTags();
}

function renderTop() {
  // 已出分拣范围 has no Bilibili page of its own; the link would land on the homepage under that title.
  el.biliBtn.hidden = !S.mid || S.mediaId === REMOVED;
  el.biliBtn.title = S.mediaId === TOVIEW ? "B站稍后再看" : inFolderView() ? "B站收藏夹" : "B站主页";
  setBusy(el.refreshBtn, (ownSync() || S.loadAll?.running) && `${UI.REFRESHING}…${ownSync() ? pageText(S.mediaId) : ""}`);
  const allOpt = el.folderSelect.querySelector(`option[value="${ALL}"]`);
  if (allOpt) {
    allOpt.hidden = !S.folders.length;
    allOpt.textContent = `所有收藏夹 (${S.folders.reduce((n, f) => n + (Number(f.count) || 0), 0)})`;
  }
  const removedOpt = el.folderSelect.querySelector(`option[value="${REMOVED}"]`);
  const showRemoved = Boolean(S.removedCount) || S.mediaId === REMOVED;
  if (removedOpt) {
    removedOpt.textContent = `${REMOVED_NAME} (${S.removedCount})`;
    removedOpt.hidden = !showRemoved;
  }
  renderFolderList();
  renderFolderHead();
  renderTagButtons();
  renderStatus();
}

// The sidebar is the folder select drawn as a list: same options, same order, same hidden ones; a click sets the select.
function renderFolderList() {
  const opts = el.folderSelect.options;
  if (!opts?.length) return;
  el.folderList.innerHTML = [...opts]
    .filter((o) => !o.hidden)
    .map((o) => {
      const on = o.value === String(S.mediaId);
      const m = /^(.*?)(?: \((\d+)\))?$/.exec(o.textContent);
      const real = o.value !== ALL && o.value !== REMOVED;
      const thumb = real ? folderThumb(o.value, o.dataset.cover) : "";
      return UI.sideItem({ attrs: `data-folder="${esc(o.value)}"${o.title ? ` title="${esc(o.title)}"` : ""}`, label: m[1], count: m[2] == null ? null : Number(m[2]), on, pre: thumb });
    })
    .join("");
}

// The folder's cover, or a fixed colored tint (never gray) when it has none or the image fails (the error listener drops it).
// Pink means 「where you are」 and blue 「next step」 here, so a generated tint never lands on them.
const thumbHue = (id) => {
  let h = Math.round((Number(id) || [...String(id)].reduce((s, ch) => s + ch.charCodeAt(0), 0)) * 137.5) % 360;
  while ((h >= 180 && h <= 240) || h >= 300 || h <= 10) h = (h + 47) % 360;
  return h;
};
const TOVIEW_ICON = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>`;
function folderThumb(id, cover) {
  const img = cover ? `<img src="${esc(cover)}" alt="" loading="lazy" referrerpolicy="no-referrer" />` : "";
  // An empty 稍后再看 shows a gray clock, like Bilibili's own icon for it.
  if (String(id) === TOVIEW) return `<span class="folder-thumb toview-thumb" aria-hidden="true">${img || TOVIEW_ICON}</span>`;
  return `<span class="folder-thumb" style="--h:${thumbHue(id)}" aria-hidden="true">${img}</span>`;
}

function renderFolderHead() {
  if (!S.mediaId) return (el.folderHead.innerHTML = "");
  const invalid = S.items.filter((it) => it.invalid || it.hidden).length;
  const explain = S.mediaId === REMOVED && `离开了你勾选的所有收藏夹，AI 判断、AI 总结、备注和标签都还留着，${UI.CLEAN_BACKUP.meta}`;
  const meta = UI.headMeta([inFolderView() && UI.syncedText(S.readAt[S.mediaId]), invalid && `${invalid} 个已失效`, explain], S.syncError);
  const thumb = inFolderView() && S.mediaId !== TOVIEW ? folderThumb(S.mediaId, el.folderSelect.querySelector?.(`option[value="${S.mediaId}"]`)?.dataset.cover) : "";
  el.folderHead.innerHTML = `${thumb}<div class="folder-text"><h1 class="folder-title">${UI.titleHtml(folderTitle(), S.items.length)}</h1><div class="folder-meta">${meta}</div></div>`;
}

// What is running, in one place on every tab: runs' pill (PILL's order). done/total draws a bar, act puts a button on
// it (handled like the step bar's buttons), stuck turns it amber, finished green.
function activityState() {
  const { job, stopping, ...a } = runs.pill(PILL) || {};
  const btn = !a.finished && a.text && PILL_BTN[job];
  if (!btn) return a.text ? a : null;
  return btn[2] ? { ...a, act: btn[0], actLabel: stopping ? btn[2] : btn[1], stopping } : { ...a, act: btn[0], actLabel: btn[1] };
}

function renderStatus() {
  const a = activityState();
  UI.setActivity(el.activity, a && { ...a, btn: a.act && { attrs: `data-head="${a.act}"`, label: a.actLabel, reason: a.stopping ? stopWhy(a.act) : "" } });
}

// 观看进度's countdown each second (runs' own waits redraw themselves).
function tick() {
  if (!S.seenRead.until) return;

  renderStatus();
  // The wait is over: read again, as the pill said.
  if (Date.now() >= S.seenRead.until) {
    S.seenRead.until = 0;
    if (S.seenCfg.on) seenSync(false);
  }
}

function renderTabs() {
  const c = stageCounts();
  // 处理完成 says what 保留 and 取消收藏 did (one only marks the video here, the other changed B站): in its tooltip, with
  // the dot while it is open.
  const tip = (key) => (key === "done" ? DONE_TIP : "");
  const tab = (key, label, cls, n) =>
    `<button type="button" role="tab" class="${cls}" data-tab="${key}" aria-selected="${S.tab === key}" aria-label="${label} ${n}"${tip(key) ? ` title="${esc(tip(key))}" aria-description="${esc(tip(key))}"` : ""}>${label}${tip(key) && S.tab === key ? UI.WARN_DOT : ""}<span class="count">${n}</span></button>`;
  const steps = STAGES.map(([key, label]) => tab(key, label, c[key] ? "step" : "step zero", c[key]));
  // Say what the box searches: the open folder (or 所有收藏夹 / 已出分拣范围) and the tab you are on.
  const tabName = Object.fromEntries([...STAGES, ["read", READ_TAB]])[S.tab];
  UI.setSearchScope(el.searchInput, folderTitle(), tabName);
  // 已出分拣范围 has no steps; its tabs are why the videos left (kindOf), 全部 first for the ones not checked yet.
  const kindTabs = () => UI.kindTabs("data-kindtab", [["", "全部"], ...KINDS].map(([kind, label]) => [kind, label, kind ? S.items.filter((it) => kindOf(it) === kind).length : S.items.length]), S.kindFilter);
  el.tabs.innerHTML = S.mediaId === REMOVED ? kindTabs() :
    steps.join(`<span class="arrow" aria-hidden="true">→</span>`) + `<span class="tab-sep" aria-hidden="true"></span>` + tab("read", READ_TAB, "read-tab", c.read);

  // Row 4: only the tags the tab on screen has (or a filter that is on, so it can be turned off), each with how many
  // videos listed here carry it (row 3 and search applied, row 4's own picks left out).
  const here = S.mediaId === REMOVED || S.tab === "read" ? S.items : S.items.filter((it) => stageOf(it) === S.tab);
  const hereTags = new Set(here.flatMap((it) => tagIdsOf(it.bvid)));
  const chips = tagChips().filter((c) => c.ids.some((id) => hereTags.has(id) || S.tagFilter.has(id)));
  const counted = here.filter((it) => inTab(it, S.tab) && passFilter(it, "tags")).map((it) => tagIdsOf(it.bvid));
  el.tagFilter.innerHTML = UI.labeledRow("标签", chips
    .map((c) => UI.tagFilterChip(`data-tagfilter="${esc(c.ids.join(","))}"`, { name: c.name, color: c.color, on: c.ids.some((id) => S.tagFilter.has(id)), n: counted.filter((ids) => c.ids.some((id) => ids.includes(id))).length, what: "视频" }))
    .join(""));
  renderTagButtons();
  renderSort();
}

// 标签管理 and ✦ AI 打标签 at the right end of the tags they act on, as in 关注; AI 打标签 says when a run or a proposal is
// pending, so renderTop draws them too (a run ends without a list render). Without tags 标签管理 has the warn dot (the
// new-tag box says what to do).
let shownPicked = 0; // the selected videos listed (all of them when none is; renderListHeader); ✦ AI 打标签 says how many
function renderTagButtons() {
  el.aiTagSlot.innerHTML = UI.tagButtons({
    picked: shownPicked,
    manageAttrs: "data-tags-manage",
    aiAttrs: "data-ai-tag",
    running: aiRunning(),
    pending: Boolean(S.ai.proposal),
    manageReason: inFolderView() ? "" : FOLDER_ONLY,
    aiReason: aiTagReason(),
    noTags: !viewTags().length,
    who: "视频"
  });
}

const AI_SPARK = UI.AI_SPARK;

// reason: why it is disabled ("" = enabled); it then replaces title as the tooltip.
const headBtn = (act, label, cls = "", reason = "", verdict = "", title = "", busy = false, ai = false) =>
  UI.actBtn(`data-head="${act}"${verdict ? ` data-verdict="${verdict}"` : ""}${busy ? ' aria-busy="true"' : ""}`, label, { reason, cls, title, pre: ai ? AI_SPARK : "" });

// Why ✦ AI 打标签 cannot open: not in one folder, or nothing to tag and nothing pending.
const aiTagReason = () => (S.mediaId === REMOVED ? FOLDER_ONLY : !S.items.length && !aiRunning() && !S.ai.proposal ? noVideosText() : "");

// Why 粗看 / 细看 cannot start: another AI run goes first.
const aiBusyStep = () => (runs.get("stage1") ? STEP_NAME.coarse : S.group ? STEP_NAME.fine : "");
const aiBusyReason = () => UI.busyText(aiBusyStep());
// Why 清理 cannot start: it drops the 取消收藏 records a running B站 batch writes.
const favBusyReason = () => UI.busyText(fav.state().busy);


// The folder's 判断标准, before the 粗看/细看 button it is for. Written: the text in the tooltip. Not written: the warn
// dot (the AI then guesses from the folder name; the editor's placeholder says so).
function criteriaBtn() {
  const text = criteria();
  const pen = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4"/></svg>';
  return `<button type="button" class="act-btn" data-head="criteria" title="${esc(text ? `判断标准：${text}` : "还没写判断标准")}" aria-label="${text ? "判断标准" : "判断标准（还没写）"}">${pen}判断标准${text ? "" : UI.WARN_DOT}</button>`;
}

// Whether anything in row 3 is on (全部 is pressed when not).
const statesOn = (t = S.tab) => (S.classFilter[t] && S.classFilter[t] !== "all") || Boolean(S.tagState || S.finishedFilter || S.dupFilter || S.aiRecentFilter || (S.mediaId !== REMOVED && S.kindFilter));
// Row 3: what the system knows about each video, in groups split by a thin rule. One pick per group (a second click
// clears it), groups AND together, and each group counts with its own pick left out. 全部 clears row 3 only. The fixed
// groups come first (a 0 stays, dimmed); the chips that exist only sometimes (看完了, 已失效, AI 刚打的) go last and
// leave at 0, so their coming and going moves nothing else.
function stateRowHtml(t = S.tab) {
  const removed = S.mediaId === REMOVED;
  const base = removed || t === "read" ? S.items : S.items.filter((it) => stageOf(it) === t);
  const cf = S.classFilter[t];
  const inClass = (it) => !cf || cf === "all" || classOf(it) === cf;
  const cnt = (skip, fn) => base.filter((it) => (skip === "class" || skip === "states" || inClass(it)) && passFilter(it, skip) && fn(it)).length;
  const group = UI.stateGroup;
  const groups = [group("全部", UI.filterBtn("data-states-all", "全部", cnt("states", () => true), !statesOn(t)))];
  // 所有收藏夹 only, right after 全部 (asked for there); like 已失效 it leaves at 0 unless on.
  const dupN = S.mediaId === ALL ? cnt("dup", isDup) : 0;
  if (dupN || S.dupFilter) groups.push(group("重复收藏", UI.filterBtn('data-dupfilter title="只看同时在两个以上收藏夹里的视频"', "重复收藏", dupN, S.dupFilter)));
  // 未分析 has no AI verdict to filter by. 阅览 also holds decided videos: they leave the AI classes for 已保留.
  if (t !== "none") {
    const classes = [...Object.entries(VERDICTS), ...(t === "read" ? [["kept", ACTION_LABEL.keep]] : [])];
    groups.push(group("按 AI 判断筛选", classes.map(([k, label]) => UI.filterBtn(`data-class-filter="${k}"`, label, cnt("class", (it) => classOf(it) === k), cf === k)).join("")));
  }
  groups.push(UI.tagStateGroup((k) => `data-tagstate="${k}"`, (k) => cnt("tagged", (it) => (tagIdsOf(it.bvid).length > 0) === (k === "tagged")), S.tagState));
  const seenN = cnt("seen", isFinished);
  if ((S.seenCfg.mark && seenN) || S.finishedFilter) groups.push(group("看完了", UI.filterBtn('data-finishedfilter title="只看 B站历史记录里看完了的视频"', "看完了", seenN, S.finishedFilter)));
  // 已出分拣范围 has 已失效 as a tab instead.
  const invalidN = cnt("kind", (it) => kindOf(it) === "invalid");
  const invalidOn = S.kindFilter === "invalid";
  if (!removed && (invalidN || invalidOn)) groups.push(group(KIND_NAME.invalid, UI.filterBtn(`data-kindfilter="invalid" class="st-danger" title="只看${KIND_NAME.invalid}的视频"`, KIND_NAME.invalid, invalidN, invalidOn)));
  const recentN = cnt("recent", (it) => aiRecentSet().has(it.bvid));
  groups.push(UI.aiRecentChip({ attrs: "data-airecent", xAttrs: "data-airecent-done", n: recentN, on: S.aiRecentFilter, who: "视频" }));
  return groups.join("");
}

// A row-3 click: the pick, or clearing it when it is on already; "all" clears the row (row 4's tags stay).
function pickState(group, value = "") {
  const t = S.tab;
  if (group === "all") {
    S.classFilter[t] = "all";
    S.finishedFilter = S.dupFilter = S.aiRecentFilter = false;
    S.tagState = "";
    if (S.mediaId !== REMOVED) S.kindFilter = "";
  } else if (group === "class") S.classFilter[t] = S.classFilter[t] === value ? "all" : value;
  else if (group === "kind") S.kindFilter = S.kindFilter === value ? "" : value;
  else if (group === "seen") S.finishedFilter = !S.finishedFilter;
  else if (group === "dup") S.dupFilter = !S.dupFilter;
  else if (group === "tagged") S.tagState = S.tagState === value ? "" : value;
  else if (group === "recent") S.aiRecentFilter = !S.aiRecentFilter;
}

function renderListHeader(list) {
  const t = S.tab;
  // The selection belongs to the tab: only a video that left it (保留, 取消收藏, a run moved it on) leaves the selection;
  // running a step or a batch keeps the rest selected, so you see what you just ran (DESIGN 筛选和计数).
  for (const b of [...S.selected]) {
    const it = S.itemMap.get(b);
    if (!it || (t !== "read" && stageOf(it) !== t)) S.selected.delete(b);
  }
  const all = S.mediaId === ALL;
  // Search, row 3 or row 4 on: how many the tab lists.
  el.searchCount.textContent = UI.resultCount(S.query.trim() || statesOn(t) || S.tagFilter.size, list.length);
  const { run: favRun, busy: favBusy } = fav.state();
  // none: why the selection's buttons are off (UI.selbar: filters hide the whole selection); they count all of it then.
  const batchBtn = (route, verdict = "", none = "") => {
    const run = favRun?.job === "unfav" ? favRun : null;
    if (route === "unfav" && run && !runWhere(run)) return headBtn("batch-unfav", runLine(run), "danger", "正在取消收藏", "", "", true);
    // A selection none of which this can take still counts the selection (as 粗看's), disabled with the reason.
    const can = none ? S.selected.size : batchList(verdict || null).length;
    const n = can || (verdict ? 0 : selectedIn(visibleItems()).length);
    const verb = route === "unfav" ? "取消收藏" : "保留";
    // One batch 取消收藏 at a time: while another folder's runs, this one waits.
    const reason = none || (!can ? (verdict ? `这里没有 AI 判断为${VERDICTS[verdict]}、还没处理的视频` : "选中的都已经处理过了")
      : route === "unfav" && run ? UI.busyText(`「${folderName(run.mediaId)}」的${UNFAV_MANY}`)
      : route === "unfav" ? UI.busyText(favBusy) : "");
    return headBtn(`batch-${route}`, verdict ? `${verb}（AI：${VERDICTS[verdict]}）${n} 个` : `${verb}选中的 ${n} 个`, route === "unfav" ? "danger" : "", reason, verdict, route === "keep" ? KEEP_TIP : "");
  };
  const transferBtn = (none) => {
    const run = favRun?.job === "transfer" ? favRun : null;
    if (run) return headBtn("transfer", runLine(run), "", `正在${run.verb}`, "", "", true);
    const can = none ? S.selected.size : transferList().length;
    const n = can || selectedIn(visibleItems()).length;
    // 已出分拣范围 holds no 取消收藏 decisions (S.decisions is 保留 only there): only a missing aid keeps one out.
    const reason = none || (!can ? (S.mediaId === REMOVED ? "选中的视频缺少视频编号" : "选中的视频已取消收藏，或缺少视频编号") : UI.busyText(favBusy));
    return headBtn("transfer", S.mediaId === REMOVED ? `收藏选中的 ${n} 个到…` : `移动/复制选中的 ${n} 个…`, "", reason);
  };
  const groupBtn = (cls) => {
    const g = ownGroup() && runs.get("group");
    if (g) return headBtn("group", `${PILL_BTN.group[g.stopping ? 2 : 1]} ${g.done}/${g.total}`, "primary", g.stopping ? PILL_BTN.group[3] : "");
    const batch = pickBatch(fineOpen(), fineBatchSize(), "coarse");
    const label = groupLabel(batch);
    // inTab applies the AI-class chip, which is a filter too.
    const none = S.items.some((it) => stageOf(it) === "coarse" && needsAnalysis(it.bvid)) ? "当前筛选下没有要细看的视频" : "没有要细看的视频";
    return headBtn("group", label, cls, aiBusyReason() || pickReason("选中的都不能字幕细看", batch, "coarse") || (batch.length ? "" : none), "", "", false, true);
  };
  // Pausing waits for the current batch or video; until then the button says so and takes no second click.
  const stage1Pause = (g = runs.get("stage1")) => headBtn("stage1", `${PILL_BTN.stage1[g.stopping ? 2 : 1]} ${g.done}/${g.total}`, "primary", g.stopping ? PILL_BTN.stage1[3] : "");

  // Results made under an older 判断标准 can be redone, only those listed, one batch at a time and the selection first
  // like the step's own button. all: how many the folder has, so the button stays (disabled) while filters hide them.
  const redoBtn = (act, step, all) => {
    const { label, why, verb } = redoOf(step);
    return all ? headBtn(act, label, "", why, "", `这些视频是按旧的判断标准${verb}的`, false, true) : "";
  };
  const sel = selectedIn(list).length;
  // A selection, listed or not, decides alone: no AI-verdict batches beside it (all hidden: its buttons say why).
  const picked = S.selected.size;
  const f = S.classFilter[t];
  // html is what this step does; the selection's buttons go to its floating bar (selActs).
  let html = "";
  // 所有收藏夹 has no one 判断标准 to show: its runs ask for each folder's first (askAllCriteria).
  const critBtn = all ? "" : criteriaBtn();
  if (t === "none") {
    // The criteria the AI reads sits just before the button that sends it.
    html = critBtn;
    if (ownStage1()) html += stage1Pause();
    else {
      const pending = stage1Pending();
      const none = S.items.some((it) => stageOf(it) === "none" && !S.coarseFailed.has(it.bvid)) ? "当前筛选下没有要粗看的视频" : "没有要粗看的视频";
      html += headBtn("stage1", stage1Label(pending), "primary", aiBusyReason() || pickReason("选中的都不能标题粗看", pending, "none") || (pending.length ? "" : none), "", "", false, true);
    }
  } else if (t === "coarse") {
    // 细看 stays in row 3 like 标题粗看 and takes the selection; 可清理 / 值得留 lead with their batch button, 细看 stays secondary.
    html = critBtn + redoBtn("redo-coarse", "coarse", staleCoarse().length);
    if (picked) html += groupBtn("primary");
    else if (f === "drop") html += batchBtn("unfav", "drop") + groupBtn("");
    else if (f === "keep") html += batchBtn("keep", "keep") + groupBtn("");
    else html += groupBtn("primary");
  } else if (t === "fine") {
    // A selection gets both buttons; without one 值得留 and 可清理 each get a button, 拿不准 none.
    html = "";
    const staleN = staleFine().length;
    if (staleN) html += critBtn + redoBtn("redo-fine", "fine", staleN);
    if (!picked) {
      if (f === "all" || f === "drop") html += batchBtn("unfav", "drop");
      if (f === "all" || f === "keep") html += batchBtn("keep", "keep");
    }
  } else if (t === "read" && S.mediaId === REMOVED) {
    const c = S.removedCheck;
    html = "";
    // Its progress is in the pill (activityState); a failure stays here.
    if (c?.error) html += `<span class="fail-text">${esc(c.error)}</span>`;
    html += UI.cleanBtn(`data-head="${picked ? "clean-selected" : "clean-removed"}"`, { picked, shown: sel, n: picked ? sel || picked : list.length, busy: favBusyReason(), why: list.length ? "" : MdgErrors.TEXT.noVideosListed });
  } else if (t === "read") {
    // 阅览 mixes 粗看 guesses with 细看 conclusions, so no class-wide batch here: only the selection.
    html = "";
  }
  // 保留 in every tab but 已出分拣范围; 标签… and 移动/复制 in any tab of a single folder (in 已出分拣范围 移动 is 收藏到).
  // 取消收藏 goes last, set apart. A selection the filters hide keeps them, disabled (none).
  const selActs = (none) =>
    (S.mediaId !== REMOVED ? batchBtn("keep", "", none) : "") +
    (inFolderView() ? headBtn("sel-tags", "标签…", "", none) : "") +
    (S.mediaId !== ALL ? transferBtn(none) : "") +
    (S.mediaId !== REMOVED ? batchBtn("unfav", "", none) : "");
  // 全选 heads the right-hand buttons, so row 3's chips coming and going never move it. It acts on what is listed, in
  // 所有收藏夹 too (across its folders).
  html = UI.selectAllBox('data-head="select-all"', list.length, sel, MdgErrors.TEXT.noVideosListed) + (all ? loadAllLine() : "") + html;
  el.classFilter.innerHTML = UI.labeledRow("状态", stateRowHtml(t));
  el.listHeader.innerHTML = `<div class="step-actions">${html}</div>`;
  // Its own slot outside the header's rows, so a folded header never hides it.
  el.favSel.innerHTML = S.selected.size ? UI.selbar({ label: "选中的视频", n: sel, hidden: S.selected.size - sel, clearAttrs: 'data-head="clear-selected"', acts: selActs }) : "";
  shownPicked = sel || picked;
  renderTagButtons();
}

function recentUnfavs() {
  return Object.entries(S.decisions)
    .filter(([b, d]) => d.action === "unfav" && d.aid && !S.itemMap.has(b))
    .sort((x, y) => y[1].at - x[1].at)
    .slice(0, MdgLimits.TRIAGE_RECENT_UNFAV);
}

function recentUnfavHtml() {
  const list = recentUnfavs();
  if (!list.length) return "";
  const { busy, pending } = fav.state();
  const wait = UI.busyText(busy);
  const rows = list
    .map(([b, d]) => {
      const title = esc(d.title || b);
      return `<li><span class="recent-title">${title}</span><span class="muted">${esc(fmtTime(d.at))}</span>
        ${pending(b) ? `<button type="button" aria-busy="true" disabled>${REFAVING}</button>` : `<button type="button" data-refav="${esc(b)}" aria-label="${REFAV} ${title}"${UI.reasonAttrs(wait)}>${REFAV}</button>`}</li>`;
    })
    .join("");
  // One line per batch 取消收藏 of two or more still listed, newest first.
  const batches = [...new Set(list.map(([, d]) => d.batch).filter(Boolean))]
    .map((batch) => ({ batch, n: unfavBatchItems(batch).length }))
    .filter((x) => x.n > 1);
  const batchRows = batches
    .map(({ batch, n }) => {
      const going = unfavBatchItems(batch).some((it) => pending(it.bvid));
      return `<p class="recent-batch"><span>${esc(fmtTime(batch))} ${UNFAV_MANY} ${n} 个</span>${going ? `<button type="button" aria-busy="true" disabled>${REFAVING}</button>` : `<button type="button" data-refav-batch="${batch}" aria-label="这批 ${n} 个全部重新收藏"${UI.reasonAttrs(wait)}>这批全部重新收藏</button>`}</p>`;
    })
    .join("");
  return `<section class="recent-unfav" aria-label="${RECENT_UNFAV}"><h3>${RECENT_UNFAV} <span class="muted">${list.length}</span></h3>${batchRows}<ul>${rows}</ul></section>`;
}

// Closing or reloading the page stops a batch write halfway and loses a notes export: the browser asks first.
window.addEventListener("beforeunload", (e) => {
  if (!writeRunning() && !fav.state().busy) return;
  e.preventDefault();
  e.returnValue = true;
});

// The records one batch 取消收藏 left in the open folder, all of them (the list shows only the latest).
const unfavBatchItems = (batch) =>
  Object.entries(S.decisions)
    .filter(([b, d]) => d.action === "unfav" && d.batch === batch && d.aid && !S.itemMap.has(b))
    .map(([bvid, d]) => ({ bvid, aid: d.aid }));

let listDeferred = false;
// The card a Shift+click picks from: the last one picked by click or X.
let pickAnchor = "";
function renderList() {
  // Rebuilding the list mid-IME in a note would drop the composition and leave the raw pinyin; compositionend renders.
  if (MdgTyping.isComposing() && document.activeElement?.closest?.("[data-note]")) return void (listDeferred = true);
  listDeferred = false;
  const list = visibleItems();
  renderListHeader(list);
  const recent = S.tab === "done" ? recentUnfavHtml() : "";
  if (!S.items.length) {
    const empty = S.mediaId === REMOVED ? `<p class="empty">${noVideosText()}</p>` : S.loadAll?.queue.length ? loadingHtml()
      : S.readError ? UI.emptyState("无法读取这个收藏夹", S.readError, REFRESH_EMPTY)
      : UI.emptyState(noVideosText(), "在 B站收藏视频后，点「刷新」读取。", REFRESH_EMPTY);
    el.list.innerHTML = `${empty}${recent}`;
    return;
  }
  if (!list.length) {
    const empty = { none: "没有未分析的视频", coarse: "没有粗看完成的视频", fine: "没有细看完成的视频", done: "还没有处理过的视频" };
    // 已出分拣范围's kind is its tab (statesOn leaves it out), not a filter.
    const kind = S.mediaId === REMOVED && KINDS.find(([k]) => k === S.kindFilter)?.[1];
    const text = UI.noMatch(S.query, statesOn() || S.tagFilter.size, "视频") || (kind ? `没有${kind}的视频` : empty[S.tab]) || "这里没有视频";
    el.list.innerHTML = `<p class="empty">${text}</p>${recent}`;
    return;
  }
  // The focused card left the list: the card now in its place takes the focus (its place read before the rebuild).
  if (!list.some((it) => it.bvid === S.focused)) {
    const was = [...el.list.querySelectorAll(".card")].findIndex((c) => c.dataset.bvid === S.focused);
    S.focused = list[Math.min(Math.max(was, 0), list.length - 1)].bvid;
  }
  // 粗看完成 shows which cards the button will send (or is sending) before anything runs.
  // Those cards get a label before the title.
  let marked = new Set();
  let word = "";
  if (S.tab === "coarse") {
    const bvids = ownGroup()?.bvids || nextBatch();
    marked = new Set(bvids);
    word = ownGroup() ? "本批" : bvids.some((b) => S.selected.has(b)) ? "已选中" : NEXT_BATCH;
  }
  const expanded = S.tab === "fine" || S.tab === "read" || S.tab === "done";
  const failedList = list.filter((it) => failedIn(S.tab, it));
  const failed = failedList.length;
  const failedHead = failedHeadHtml(failedList);
  // Background progress re-renders the list; keep a note being typed in focus.
  const typing = document.activeElement?.closest?.("[data-note]");
  const caret = typing && [typing.closest(".card").dataset.bvid, typing.selectionStart, typing.selectionEnd];
  const restore = UI.keepScroll(el.list, ".card[data-bvid]");
  el.list.innerHTML =
    list
      .map((it, i) => {
        const head = failed && i === list.length - failed ? failedHead : "";
        return head + cardHtml(it, expanded, marked.has(it.bvid) ? word : "");
      })
      .join("") + recent;
  restore();
  if (caret) {
    const box = el.list.querySelector(`.card[data-bvid="${CSS.escape(caret[0])}"] [data-note]`);
    box?.focus();
    box?.setSelectionRange(caret[1], caret[2]);
  }
}

// The badge shows 「AI」 + the class name, colored by it (keep green, drop red, unsure yellow).
const verdictLabel = (v) => VERDICTS[v] || STAGES[0][1];
const verdictBadge = (b, v, low = v.low) =>
  S.analyzing.has(b)
    ? `<span class="badge running">${ANALYZING}</span>`
    : `<span class="badge ${VERDICTS[v.verdict] ? v.verdict : "none"}${low ? " low" : ""}">${VERDICTS[v.verdict] ? `<span class="ai-mark">AI</span>` : ""}${esc(verdictLabel(v.verdict))}${low ? " · 低置信" : ""}</span>`;
const KEEP_TIP = "保留标记只存在 MoonDigest 里，B站收藏夹不变";
const DONE_TIP = `已保留：${KEEP_TIP}。\n已取消收藏：已从 B站收藏夹移走，最近的操作可按 U 撤销。`;

// What a 细看 judged from, on the card's meta line, in the video page's words: no subtitle (and why), or a subtitle
// whose time range may not match the video. Nothing for a matching subtitle.
function basisText(a) {
  if (a.source !== "meta") return a.subtitleWarning ? esc(a.subtitleWarning.replace(/。$/, "")) : "";
  return esc(`${MdgErrors.subtitleMissing({ subtitleNeedLogin: a.needLogin, subtitleFailure: a.subtitleFailure })}，按简介和评论判断`);
}
function cardHtml(it, expanded, mark) {
  const b = it.bvid;
  const v = verdictOf(it);
  const a = S.analyses[b];
  const done = a?.status === "done";
  const decision = S.decisions[b];
  const inBasket = S.basket.some((x) => x.bvid === b);
  const cls = ["card"];
  if (b === S.focused) cls.push("focused");
  if (S.selected.has(b)) cls.push("selected");
  if (mark) cls.push("in-batch");
  if (b === S.viewing) cls.push("playing");

  const removed = S.mediaId === REMOVED;
  const basketBtn = inBasket
    ? `<button type="button" data-act="basket" class="on" aria-label="已在待播，点一下移除 (E)" title="已在待播，点一下移除">✓ 待播</button>`
    : `<button type="button" data-act="basket" aria-label="加入待播 (E)" title="加入待播">+ 待播<kbd class="key">E</kbd></button>`;
  const askBtn = `<button type="button" data-act="ask" aria-label="问 AI (Q)">${AI_SPARK}问 AI<kbd class="key">Q</kbd></button>`;
  // The 发布时间 is relative, the date on hover; the rest is text.
  const meta = [esc(it.upper), it.pubdate && UI.agoHtml(it.pubdate), Number.isFinite(it.play) && esc(`▶ ${fmtCount(it.play)}`), ["", "粗看", "细看"][v.stage], done && basisText(a), esc(seenText(it)), it.invalid && KIND_NAME.invalid, it.folders?.length && esc(`收藏夹：${folderNames(it)}`)].filter(Boolean);
  const left = removed && [originHtml(it), it.removedAt && `<span>${esc(leftText(it))}</span>`].filter(Boolean).join("");

  const verdict = decision ? "" : verdictBadge(b, v);
  // The button matching the AI's verdict leads; the other stays plain.
  const keepCls = !decision && v.verdict === "keep" ? "ok solid" : "";
  const unfavCls = !decision && v.verdict === "drop" ? "danger solid" : "";
  const waiting = waitingWhy(b); // the B站 write it waits for
  const note = S.notes[b]?.text || "";
  const noteHtml =
    note || S.noteOpen.has(b)
      ? `<textarea class="note" name="videoNote" data-note rows="1" placeholder="${MdgErrors.TEXT.notePlaceholder}" aria-label="备注">${esc(note)}</textarea>`
      : "";
  const failed = v.failed
    ? `<span class="fail-text">${ANALYSIS_FAILED}：${esc(v.failed)}</span><button type="button" data-act="retry" aria-label="重试分析"${UI.reasonAttrs(aiBusyReason())}>${AI_SPARK}${MdgErrors.LABEL.retry}</button>`
    : "";

  const chips = tagIdsOf(b)
    .map((id) => tagById(id))
    .map((t) => UI.cardTagChip(t))
    .join("");

  const body = [];
  if (done && a.oneLiner) body.push(`<p class="oneliner">${esc(a.oneLiner)}</p>`);
  if (done && expanded && a.points?.length) body.push(`<ol class="points">${a.points.map((p) => `<li>${esc(p)}</li>`).join("")}</ol>`);

  return `<article class="${cls.join(" ")}" data-bvid="${esc(b)}" aria-label="${esc(it.title)}">
    ${coverHtml(it)}
    <div class="card-body">
      <div class="title-row">${mark ? `<span class="batch-tag">${mark}</span>` : ""}<a class="title" href="${esc(videoUrl(b))}" data-act="open" aria-label="打开视频 ${esc(it.title)}">${esc(it.title)}</a></div>
      ${left ? `<div class="left-row">${left}</div>` : ""}
      <div class="meta">${meta.join(" · ")}</div>
      ${body.join("")}
      <div class="card-foot verdict-row">${verdict}<span class="reason">${esc(v.reason)}</span>${failed}</div>
      ${chips ? `<div class="chips">${chips}</div>` : ""}
      ${noteHtml}
      <div class="card-foot">
        ${decision ? `<span class="badge ${decision.action === "keep" ? "keep" : "drop"}">${ACTION_LABEL[decision.action]}</span>` : ""}
        ${noteHtml ? "" : `<button type="button" class="quiet note-add" data-act="note" aria-label="添加备注">${MdgErrors.LABEL.noteAdd}</button>`}
        <span class="spacer"></span>
        <div class="actions">
          ${removed ? `<span class="pair">
            ${UI.cardCleanBtn(b, it.title, favBusyReason())}
          </span>
          <span class="more">${basketBtn}${askBtn}</span>` : `<span class="pair">
            <button type="button" data-act="keep" class="${keepCls}" aria-label="保留 (S)"${UI.reasonAttrs(decision ? (decision.action === "keep" ? "已经保留了" : KEEP_UNFAVED) : waiting, KEEP_TIP)}>保留<kbd class="key">S</kbd></button>
            ${waiting ? `<button type="button" aria-busy="true" disabled>${waiting}</button>` : `<button type="button" data-act="unfav" class="${unfavCls}" aria-label="取消收藏 (D)"${UI.reasonAttrs(decision?.action === "unfav" ? UNFAVED : "")}>取消收藏<kbd class="key">D</kbd></button>`}
          </span>
          <span class="more">
            <button type="button" data-act="tag" aria-label="打标签 (T)">+ 标签<kbd class="key">T</kbd></button>
            ${basketBtn}${askBtn}
          </span>`}
        </div>
      </div>
    </div>
  </article>`;
}

// 已出分拣范围: when (the shared day text: 「今天 17:25」, 「10月5日 17:25」, 「2025年10月5日」) and why the video left.
function leftText(it) {
  const when = UI.dayText(it.removedAt);
  const kind = kindOf(it);
  const at = it.inFolder || it.movedTo;
  const why = it.hidden ? "已失效（B站已隐藏）"
    : kind === "out" ? `${it.movedTo?.id === at.id ? "移到" : "在"}「${at.title}」（未勾选）`
    : kind === "unfav" ? KIND_NAME.unfav : "离开收藏夹";
  return `${when} ${why}`;
}
// 原在「A」「B」, or 原在「A」「B」等 N 个 with the whole list in the title; nothing for records from before the origin was kept.
const originHtml = (it) => UI.originChip("原在", (it.from || []).map((f) => f.title));

const folderTitle = (id = S.mediaId) => folderName(id);

function setFocus(bvid, scroll = true) {
  S.focused = bvid;
  for (const node of el.list.querySelectorAll(".card.focused")) node.classList.remove("focused");
  const card = el.list.querySelector(`.card[data-bvid="${CSS.escape(bvid)}"]`);
  if (card) {
    card.classList.add("focused");
    if (scroll) card.scrollIntoView({ block: "nearest" });
  }
}

const pointerMoved = (at, x, y) => !at || at.x !== x || at.y !== y;

function moveFocus(delta) {
  const cards = [...el.list.querySelectorAll(".card")];
  if (!cards.length) return;
  const i = cards.findIndex((c) => c.dataset.bvid === S.focused);
  const next = Math.max(0, Math.min(cards.length - 1, (i < 0 ? 0 : i + delta)));
  setFocus(cards[next].dataset.bvid);
}

// Focus the next unprocessed card after `bvid` in the given pre-change list.
function advanceFrom(bvid, before) {
  const i = before.findIndex((it) => it.bvid === bvid);
  const now = new Set(visibleItems().map((it) => it.bvid));
  const next =
    before.slice(i + 1).find((it) => now.has(it.bvid) && !isProcessed(it.bvid)) ||
    visibleItems().find((it) => !isProcessed(it.bvid));
  if (next) setFocus(next.bvid);
  else setFocus(S.focused, true);
}
