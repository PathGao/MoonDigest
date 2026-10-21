"use strict";
// 收藏夹's 导出: 摘录或笔记, the CSV and 完整备份.

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
const BACKUP_PREFIXES = [K.kept, K.removed, K.left, K.tags, K.folderCriteria, K.videoTags, K.notes, KEYS.readingMarks, SNAPSHOT, DECISIONS, TITLE, ANALYSIS];

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
