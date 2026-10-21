if (!globalThis.chrome?.runtime?.id) await import("./dev/mock-chrome.js");
// Read up front: sidePanel.open must run inside the click's user gesture, before any await.
const OWN_TAB = await chrome.tabs.getCurrent();

const KEY = MdgLimits.KEYS.aiConversations;
const { triageNotes: NOTES_KEY, triageAnalysisPrefix: ANALYSIS, triageSnapshotPrefix: SNAPSHOT } = MdgLimits.KEYS;
const $ = (id) => document.getElementById(id);
const { setReason } = MdgErrors;
const els = { list: $("list"), search: $("search"), count: $("count"), selectAll: $("selectAll"), selectAllLabel: $("selectAllLabel"), bulkMd: $("bulkMd"), bulkDelete: $("bulkDelete"), clearAll: $("clearAll"), status: $("status") };

let conversations = [];
let analyses = {}; // bvid → done triage analysis
let notes = {}; // video id (bvid / YouTube videoId) → { text, updatedAt }, non-empty only
let triageTitles = {}; // bvid → title from the triage folder snapshots
let obsidianEnabled = false;
const selected = new Set();
const writing = new Set(); // entry keys with a 写入 Obsidian in flight
const unfolded = new Set(); // entry keys whose one-line AI summary is shown in full
const expanded = new Set(); // entry keys whose 问答 are open, kept while a search hides the entry
let reloadTimer = 0;
let editing = null; // { id, draft } while a 备注 is open; storage reloads wait until it closes
let reloadPending = false;
let rendering = false;
let pressing = false; // a pointer is down: redrawing now would replace the control it is pressing
document.addEventListener("pointerdown", () => (pressing = true), true);
for (const type of ["pointerup", "pointercancel"]) document.addEventListener(type, () => (pressing = false), true);

const esc = MdgErrors.escapeHtml;
const formatTime = (value) => new Date(Number(value) || 0).toLocaleString("zh-CN", { hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });

// One entry per video or web page: the side panel's contextKey (MdgSites.buildContextKey) ties a conversation to it.
function groupByVideo(items) {
  const byKey = new Map();
  for (const item of items) {
    const key = item.contextKey || item.id;
    byKey.set(key, [...(byKey.get(key) || []), item]);
  }
  const groups = [...byKey].map(([key, convs]) => {
    convs.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    const latest = convs.reduce((a, b) => ((b.updatedAt || 0) > (a.updatedAt || 0) ? b : a));
    // Read as the side panel reads a saved conversation: an old one keeps its video from contextSnapshot or its own fields.
    const ref = MdgSites.contextRef(latest.contextRef || latest.contextSnapshot || { ...latest, title: latest.contextTitle });
    const context = { ...ref, title: ref.title || latest.contextTitle || latest.title, url: latest.contextUrl || ref.url || "" };
    return { key, convs, context, title: latest.title || context.title || MdgErrors.TEXT.untitledVideo, updatedAt: latest.updatedAt || 0 };
  });
  // The note is per video, so it joins every part's entry, as the side panel shows it on every part; the analysis
  // summarizes P1, so it joins only the P1 entry. Without a P1 entry the analysis is its own entry, and so is a note
  // without any entry. Note ids are bvids (BV and 10 more, 12 in all) or YouTube videoIds (11).
  for (const bvid of new Set([...Object.keys(analyses), ...Object.keys(notes)])) {
    const analysis = analyses[bvid];
    const note = notes[bvid];
    const site = /^BV[0-9A-Za-z]{10}$/.test(bvid) ? "bilibili" : "youtube";
    const context = { site, videoId: bvid, title: triageTitles[bvid] || bvid, url: MdgSites.SITES[site].canonicalUrl(bvid, 1), isVideoContext: true };
    const key = MdgSites.buildContextKey(context);
    const parts = groups.filter((g) => MdgSites.buildContextKey({ ...g.context, cid: "" }) === key);
    for (const g of parts) g.note = note;
    const host = parts.find((g) => (Number(g.context.pageIndex) || 1) === 1);
    if (host) host.analysis = analysis;
    else if (analysis || !parts.length) groups.push({ key, convs: [], context, title: context.title, updatedAt: Math.max(analysis?.analyzedAt || 0, note?.updatedAt || 0), analysis, note });
  }
  return groups.sort((a, b) => b.updatedAt - a.updatedAt);
}

// 下载 .md: the conversation note the side panel downloads, with every conversation of the video in order.
function buildNote(group) {
  const turns = group.convs.flatMap((conv) => MdgNote.buildConversationTurns(conv.messages));
  const filename = MdgNote.buildAiConversationFilename(group.context);
  return { filename, content: MdgNote.withTriageSummary(MdgNote.buildAiConversationMarkdown({ context: group.context, turns, filename }), group.analysis, group.note?.text) };
}

function visibleGroups() {
  const query = els.search.value.trim().toLowerCase();
  const groups = groupByVideo(conversations);
  if (!query) return groups;
  return groups.filter((g) =>
    [g.title, g.context.title, MdgNote.buildTriageSummary(g.analysis), g.note?.text, ...g.convs.flatMap((c) => (c.messages || []).map((m) => m.content))].some((text) => String(text || "").toLowerCase().includes(query))
  );
}

// The triage summary is markdown (> one-liner, - points, AI 判断 line); shown as one line, verdict first,
// cut off with an ellipsis until clicked.
function renderSummary(g) {
  const lines = MdgNote.buildTriageSummary(g.analysis).split("\n").filter(Boolean);
  const verdict = lines.find((l) => l.startsWith(MdgNote.VERDICT_LINE));
  const rest = lines.filter((l) => l !== verdict).map((l) => esc(l.replace(/^(> |- )/, ""))).join(" · ");
  const head = verdict ? `<b>${MdgErrors.LABEL.aiVerdict}</b> ${esc(verdict.slice(MdgNote.VERDICT_LINE.length))}` : "";
  const open = unfolded.has(g.key);
  return `<button type="button" class="entry-summary${open ? " open" : ""}" data-act="summary" aria-expanded="${open}">${head}${head && rest ? " · " : ""}<span class="entry-points">${rest}</span></button>`;
}

// A web page's record (not a video, with an http(s) address): 继续问 goes on in the page's own tab.
const isWebPage = (g) => !g.context.videoId && /^https?:\/\//i.test(g.context.url || "");

// 继续问 on a web page: the side panel reads the page from its tab, so it opens on this window inside the click
// (sidePanel.open needs the gesture), then the page's tab in this window is focused, or opened, and the panel asked for
// the conversation as a video's is (askSidepanel).
function askAboutPage(group) {
  const opening = chrome.sidePanel.open({ windowId: OWN_TAB?.windowId });
  setStatus(MdgErrors.TEXT.sidepanelOpening);
  void (async () => {
    try {
      await opening;
      const key = MdgSites.buildContextKey({ url: group.context.url });
      const found = (await chrome.tabs.query({ windowId: OWN_TAB?.windowId })).find((t) => t.url && MdgSites.buildContextKey({ url: t.url }) === key);
      const tab = found ? await chrome.tabs.update(found.id, { active: true }) : await chrome.tabs.create({ url: group.context.url, windowId: OWN_TAB?.windowId });
      await MdgLimits.askSidepanel({ tabId: tab.id, contextRef: group.context });
      setStatus("");
    } catch (error) {
      setStatus(`${MdgErrors.TEXT.sidepanelOpenFailed}：${error.message}`, true);
    }
  })();
}

// The 备注 belongs to the video: every part's entry shows and edits the same one, like grouping joins it.
const noteIdOf = (g) => g.context.videoId || "";

function renderNote(g) {
  const id = noteIdOf(g);
  if (id && editing?.id === id) return `<textarea class="entry-note-edit" name="entryNote" data-note rows="2" placeholder="${MdgErrors.TEXT.notePlaceholder}" aria-label="备注">${esc(editing.draft)}</textarea>`;
  if (!g.note) return id ? `<button type="button" class="note-add" data-act="note">${MdgErrors.LABEL.noteAdd}</button>` : "";
  const body = `<b>备注</b> ${esc(g.note.text.trim())}`;
  return id ? `<button type="button" class="entry-note" data-act="note" title="点击编辑备注">${body}</button>` : `<div class="entry-note">${body}</div>`;
}

// MdgLimits.saveVideoNote, like the side panel and 分拣台: an unchanged note is not rewritten, an emptied one is deleted.
async function closeNote() {
  if (!editing) return;
  const { id, draft } = editing;
  editing = null;
  try {
    if (await MdgLimits.saveVideoNote(id, draft)) {
      if (draft.trim()) notes[id] = { text: draft, updatedAt: Date.now() };
      else delete notes[id];
      setStatus(draft.trim() ? "备注已保存" : "备注已删除");
    }
  } catch (error) {
    setStatus(`保存备注失败：${error?.message || MdgErrors.TEXT.unknown}`, true);
  }
  const redraw = reloadPending ? load : render;
  reloadPending = false;
  // Closed by pressing another control (focusout on pointerdown): redraw after its click, which a new list would swallow.
  if (pressing) document.addEventListener("pointerup", () => setTimeout(redraw), { once: true });
  else await redraw();
}

function renderConversation(conv, index, total) {
  const turns = MdgNote.buildConversationTurns(conv.messages, 0)
    .map((t) => `<p class="turn-q">问：${esc(t.prompt)}</p><div class="turn-a">${MdgNote.renderMarkdown(t.answer)}</div>`)
    .join("");
  return `${total > 1 ? `<p class="conv-sep">对话 ${index + 1} · ${esc(formatTime(conv.updatedAt))}</p>` : ""}${turns}`;
}

// An entry by its key, without building a selector from the key (it is a contextKey or a saved id).
const entryOf = (key) => [...els.list.querySelectorAll(".entry")].find((e) => e.dataset.key === key);

function render() {
  const groups = visibleGroups();
  const allGroups = groupByVideo(conversations);
  // Records of web pages are not videos: counted on their own.
  const videos = allGroups.filter((g) => g.context.videoId).length;
  const pages = allGroups.length - videos;
  els.count.textContent = `${videos} 个视频${pages ? `、${pages} 个网页` : ""} · 对话 ${conversations.length}/${MdgLimits.AI_CONVERSATIONS}`;
  // A search keeps hidden selections, like the 分拣台; only a video that is gone leaves the selection.
  for (const key of [...selected]) if (!allGroups.some((g) => g.key === key)) selected.delete(key);
  // Storage changes re-render the list while the user reads it: keep expanded entries (expanded) and the scroll.
  // New entries land above the one being read, so the first entry in view keeps its offset (by its key, not scrollY).
  const scrollY = window.scrollY;
  const top = [...els.list.querySelectorAll(".entry")].find((e) => e.getBoundingClientRect().bottom > 0);
  const anchor = top && { key: top.dataset.key, offset: top.getBoundingClientRect().top };
  const active = document.activeElement?.matches?.("[data-note]") ? document.activeElement : null;
  const caret = active ? [active.selectionStart, active.selectionEnd] : null;
  // A focused control is replaced too: the new list gives focus back to the same entry's same control.
  const act = document.activeElement?.dataset?.act;
  const actKey = act && document.activeElement.closest(".entry")?.dataset.key;
  rendering = true;
  els.list.innerHTML = groups.length
    ? groups.map((g) => {
        const site = MdgSites.SITES[g.context.site]?.label || "网页";
        const turnCount = g.convs.reduce((n, c) => n + MdgNote.buildConversationTurns(c.messages).length, 0);
        // A video whose title never arrived falls back to its id; show that as 未获取标题 with the id in the meta line.
        const untitled = g.title === g.context.videoId;
        const label = untitled ? "未获取标题" : g.title;
        // Only web links: a saved context URL is shown as a link, never as a javascript: or other scheme.
        const title = /^https?:\/\//i.test(g.context.url || "") ? `<a class="entry-title" href="${esc(g.context.url)}" target="_blank" rel="noopener">${esc(label)}</a>` : `<span class="entry-title">${esc(label)}</span>`;
        const kind = g.convs.length ? (g.convs.length > 1 ? `${g.convs.length} 段对话` : "") : `仅${[g.analysis && "分拣台 AI 总结", g.note && "备注"].filter(Boolean).join("和")}，没有 AI 对话`;
        return `<article class="entry" data-key="${esc(g.key)}">
          <input type="checkbox" name="selectedConversation" data-act="pick" aria-label="选择" ${selected.has(g.key) ? "checked" : ""} />
          <div class="entry-head">
            ${title}
            <div class="entry-meta">${[site, formatTime(g.updatedAt), untitled && g.context.videoId, kind].filter(Boolean).map(esc).join(" · ")}</div>
          </div>
          <div class="entry-actions">
            <button type="button" class="ask" data-act="ask"${g.context.videoId || isWebPage(g) ? "" : " data-no-video"}><span class="ai-spark" aria-hidden="true"></span>继续问</button>
            <button type="button" data-act="copy">${MdgErrors.LABEL.copyMd}</button>
            <button type="button" data-act="md">${MdgErrors.LABEL.downloadMd}</button>
            ${!obsidianEnabled ? "" : `<button type="button" data-act="obsidian"${writing.has(g.key) ? " disabled" : ""}><img class="obsidian-mark" src="/icons/obsidian.svg" alt=""> <span class="write-label" data-idle="${MdgErrors.LABEL.writeObsidian}">${writing.has(g.key) ? `<span aria-busy="true">${MdgErrors.TEXT.writing}</span>` : `<span>${MdgErrors.LABEL.writeObsidian}</span>`}</span></button>`}
            ${g.convs.length ? `<button type="button" data-act="delete" class="danger">删除 AI 对话</button>` : `<button type="button" class="danger slot" tabindex="-1" aria-hidden="true" disabled>删除 AI 对话</button>`}
          </div>
          <div class="entry-body">
            ${g.analysis ? renderSummary(g) : ""}
            ${renderNote(g)}
            ${g.convs.length ? `<details${expanded.has(g.key) ? " open" : ""}><summary>查看 ${turnCount} 轮问答</summary>${g.convs.map((c, i) => renderConversation(c, i, g.convs.length)).join("")}</details>` : ""}
          </div>
        </article>`;
      }).join("")
    : `<p class="empty">${allGroups.length ? "没有匹配的视频或网页" : "还没有摘读记录。在侧边栏提问，或在分拣台细看、写备注后，会按视频和网页记在这里。"}</p>`;
  rendering = false;
  // 继续问 on a record that is not a video: off with why, the page's one way (setReason).
  for (const b of els.list.querySelectorAll("[data-no-video]")) setReason(b, MdgErrors.TEXT.notVideo);
  const textarea = editing && els.list.querySelector("[data-note]");
  if (textarea) {
    textarea.focus();
    textarea.setSelectionRange(...(caret || [textarea.value.length, textarea.value.length]));
  } else if (actKey) entryOf(actKey)?.querySelector(`[data-act="${act}"]`)?.focus({ preventScroll: true });
  const again = anchor && entryOf(anchor.key);
  if (again) window.scrollBy(0, again.getBoundingClientRect().top - anchor.offset);
  else window.scrollTo(0, scrollY);
  syncBulk(groups);
}


function syncBulk(groups = visibleGroups()) {
  // 全选 is three-state over the listed videos: none, some (indeterminate) or all of them selected.
  const picked = groups.filter((g) => selected.has(g.key)).length;
  els.selectAll.checked = groups.length > 0 && picked === groups.length;
  els.selectAll.indeterminate = picked > 0 && picked < groups.length;
  els.selectAllLabel.textContent = groups.length ? `${MdgErrors.LABEL.selectAll} ${groups.length} 个` : MdgErrors.LABEL.selectAll;
  setReason(els.selectAll, groups.length ? "" : MdgErrors.TEXT.noVideosListed);
  // The bulk buttons act on the listed selected videos and say how many (「选中的 N 个」); when every selected one is
  // hidden by the search they say all of them and are disabled with HIDDEN_ALL, as on the 分拣台.
  const shown = shownPicks(groups);
  const n = shown.length || selected.size;
  const none = !selected.size ? "先勾选视频" : !shown.length ? MdgErrors.TEXT.hiddenAll : "";
  els.bulkMd.textContent = n ? `下载选中的 ${n} 个 .md` : "下载选中的 .md";
  // 删除 removes AI conversations only, so its N counts the selected videos that have one and says when that is fewer.
  const del = deletableKeys(shown.length ? shown : [...selected]).length;
  els.bulkDelete.textContent = del ? `删除选中的 ${del} 个的 AI 对话` : "删除选中的 AI 对话";
  setReason(els.bulkMd, none);
  // Only AI conversations are deleted here. A YouTube video's 备注 is not on the 分拣台 (B站 收藏夹 only),
  // so the reason names no other place.
  setReason(els.bulkDelete, none || (del ? "" : "选中的视频没有 AI 对话"), del < n ? `选中的 ${n} 个里，${n - del} 个没有 AI 对话，删除后会留下` : "");
  setReason(els.clearAll, conversations.length ? "" : "还没有 AI 对话");
}

// 「正在…」 lines are in progress: aria-busy grays them (tokens.css) until the result replaces them.
// error: a failure the user must handle (red).
function setStatus(text, error = false) {
  els.status.textContent = text;
  els.status.classList.toggle("is-error", error);
  if (text.startsWith("正在")) els.status.setAttribute("aria-busy", "true");
  else els.status.removeAttribute("aria-busy");
}

async function load() {
  // ponytail: reads all of storage (subtitle caches included) to find the triage keys; getKeys() first if that gets slow.
  const all = await chrome.storage.local.get(null);
  conversations = (all[KEY] || []).filter((c) => c?.id && Array.isArray(c.messages));
  analyses = {};
  notes = Object.fromEntries(Object.entries(all[NOTES_KEY] || {}).filter(([, n]) => String(n?.text || "").trim()));
  triageTitles = {};
  for (const [k, v] of Object.entries(all)) {
    if (k.startsWith(ANALYSIS) && v?.status === "done") analyses[k.slice(ANALYSIS.length)] = v;
    else if (k.startsWith(SNAPSHOT)) Object.assign(triageTitles, v?.titles);
  }
  render();
}

// The selected videos the search lists: what the bulk buttons act on.
const shownPicks = (groups = visibleGroups()) => groups.filter((g) => selected.has(g.key)).map((g) => g.key);

// Triage-summary-only and note-only entries have no conversations to delete, so they are left out.
function deletableKeys(keys) {
  const withConvs = new Set(conversations.map((c) => c.contextKey || c.id));
  return keys.filter((key) => withConvs.has(key));
}

// Drops the conversations from the list at once, then writes. The write reads storage again so a reply the side panel
// saved meanwhile is kept; if it fails, the list (and the selection) is read back from storage and the line says so.
async function removeConversations(keep, done, unselect = []) {
  const picked = new Set(selected);
  unselect.forEach((key) => selected.delete(key));
  conversations = conversations.filter(keep);
  render();
  try {
    await MdgLimits.updateConversations((current) => current.filter(keep));
  } catch (error) {
    picked.forEach((key) => selected.add(key));
    await load();
    return setStatus(`${MdgErrors.TEXT.deleteFailed}：${error?.message || MdgErrors.TEXT.unknown}`, true);
  }
  setStatus(done);
}

async function deleteGroups(keys) {
  keys = deletableKeys(keys);
  if (!keys.length || !confirm(`删除 ${keys.length} 个视频的全部 AI 对话？删除后不能恢复。`)) return;
  await removeConversations((c) => !keys.includes(c?.contextKey || c?.id), `已删除 ${keys.length} 个视频的 AI 对话`, keys);
}

// Several videos go into one file like the triage batch export: one save prompt, frontmatter
// turned into yaml blocks so the merged file still renders.
function downloadGroups(groups) {
  const notes = groups.map((g) => buildNote(g));
  if (notes.length === 1) {
    MdgDownload.text(notes[0].filename, notes[0].content);
  } else {
    const body = notes.map((n) => `# ${n.filename.replace(/\.md$/i, "")}\n\n${n.content.replace(/^---\n([\s\S]*?)\n---\n/, "```yaml\n$1\n```\n")}`);
    MdgDownload.text(`MoonDigest摘读记录-${MdgCommon.localDate()}.md`, body.join("\n\n"));
  }
  setStatus(`已下载 ${groups.length} 个视频的记录`);
}

// The background (write-video-note) decides where it goes, as for the side panel's 写入 Obsidian: the video note with
// the newest conversation in its AI 问答 section (the one auto-sync keeps current), or the conversation's own note.
// This page asks before an existing note is touched.
async function saveToObsidian(group) {
  writing.add(group.key);
  setStatus(MdgErrors.TEXT.obsidianWriting);
  render();
  try {
    // Built again after the dialog: a reply saved while it was open goes in too.
    const request = () => {
      const g = groupByVideo(conversations).find((x) => x.key === group.key) || group;
      const newest = g.convs.reduce((a, b) => ((b.updatedAt || 0) > (a.updatedAt || 0) ? b : a), g.convs[0]);
      return { type: "write-video-note", ref: g.context, conversation: { messages: newest?.messages || [] } };
    };
    let resp = await chrome.runtime.sendMessage(request());
    if (resp?.ok && resp.ask) {
      const mode = await MdgOverwriteDialog.choose(resp.path, { hasAiSection: resp.hasAiSection, fullReason: resp.fullReason });
      if (!mode) return setStatus(MdgErrors.TEXT.obsidianCancelled);
      resp = await chrome.runtime.sendMessage({ ...request(), mode });
    }
    if (!resp?.ok) throw MdgErrors.fromResp(resp, MdgErrors.TEXT.obsidianWriteFailed);
    setStatus(resp.text);
  } catch (error) {
    setStatus(`${MdgErrors.TEXT.obsidianFailed}：${error?.message || error}`, true);
    // Not set up or a wrong key: the settings page. A closed Obsidian only gets the red line.
    if (error?.action === "settings") chrome.runtime.openOptionsPage();
  } finally {
    writing.delete(group.key);
    render();
  }
}

els.list.addEventListener("click", (event) => {
  const target = event.target.closest("[data-act]");
  const entry = target?.closest(".entry");
  if (!entry) return;
  const key = entry.dataset.key;
  const group = groupByVideo(conversations).find((g) => g.key === key);
  const act = target.dataset.act;
  if (act === "pick") {
    target.checked ? selected.add(key) : selected.delete(key);
    syncBulk();
  } else if (act === "copy" && group) {
    navigator.clipboard.writeText(buildNote(group).content).then(
      () => setStatus(MdgErrors.TEXT.copied),
      (error) => setStatus(`${MdgErrors.TEXT.copyFailed}：${error?.message || MdgErrors.TEXT.noClipboard}`, true)
    );
  } else if (act === "md" && group) downloadGroups([group]);
  else if (act === "obsidian" && group) void saveToObsidian(group);
  else if (act === "delete") void deleteGroups([key]);
  else if (act === "summary") {
    unfolded.has(key) ? unfolded.delete(key) : unfolded.add(key);
    render();
  }
  else if (act === "note" && group) {
    editing = { id: noteIdOf(group), draft: group.note?.text || "" };
    render();
  }
  else if (act === "ask" && group && isWebPage(group)) askAboutPage(group);
  else if (act === "ask" && group) {
    // The side panel continues the video's latest conversation, the same request triage's 问 AI sends.
    MdgLimits.askSidepanel({ tabId: OWN_TAB?.id, contextRef: group.context });
    const opening = MdgErrors.TEXT.sidepanelOpening;
    setStatus(opening);
    chrome.sidePanel.open({ tabId: OWN_TAB?.id }).then(
      () => els.status.textContent === opening && setStatus(""),
      (error) => setStatus(`${MdgErrors.TEXT.sidepanelOpenFailed}：${error.message}`, true)
    );
  }
});
// toggle does not bubble: caught on the way down.
els.list.addEventListener("toggle", (event) => {
  const key = event.target.closest?.(".entry")?.dataset.key;
  if (key) event.target.open ? expanded.add(key) : expanded.delete(key);
}, true);
els.list.addEventListener("input", (event) => {
  if (editing && event.target.matches("[data-note]")) editing.draft = event.target.value;
});
// Enter (or Esc) saves and closes; Shift+Enter is a newline. Never mid-IME.
els.list.addEventListener("keydown", (event) => {
  if (MdgTyping.composing(event) || !event.target.matches("[data-note]")) return;
  if (!(event.key === "Escape" || (event.key === "Enter" && !event.shiftKey))) return;
  event.preventDefault();
  void closeNote();
});
els.list.addEventListener("focusout", (event) => {
  if (!rendering && event.target.matches("[data-note]")) void closeNote();
});
MdgTyping.bindLive(els.search, () => render());
els.selectAll.addEventListener("change", () => {
  visibleGroups().forEach((g) => (els.selectAll.checked ? selected.add(g.key) : selected.delete(g.key)));
  render();
});
els.bulkMd.addEventListener("click", () => downloadGroups(visibleGroups().filter((g) => selected.has(g.key))));
els.bulkDelete.addEventListener("click", () => void deleteGroups(shownPicks()));
// AI conversations only: triage analyses and notes are other features' data and stay.
els.clearAll.addEventListener("click", async () => {
  if (!confirm("清空全部 AI 对话？删除后不能恢复。")) return;
  // Entries left with an AI 总结 or a 备注 stay selected; render drops the ones that left the list.
  await removeConversations(() => false, "已清空全部 AI 对话");
});
chrome.storage.onChanged.addListener((changes, area) => {
  // Triage analyses arrive in bursts; one reload per burst.
  if (area === "local" && Object.keys(changes).some((k) => k === KEY || k === NOTES_KEY || k.startsWith(ANALYSIS) || k.startsWith(SNAPSHOT))) {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => (editing ? (reloadPending = true) : load()), 300);
  }
  if (area === "sync" && changes.obsidianEnabled) {
    obsidianEnabled = MdgSettings.normalizeSwitches({ obsidianEnabled: changes.obsidianEnabled.newValue }).obsidianEnabled;
    render();
  }
});

obsidianEnabled = (await chrome.runtime.sendMessage({ type: "get-settings" }).catch(() => null))?.settings?.obsidianEnabled ?? MdgSettings.DEFAULTS.obsidianEnabled;
await load();
