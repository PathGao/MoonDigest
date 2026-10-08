if (!globalThis.chrome?.runtime?.id) await import("./dev/mock-chrome.js");
// Read up front: sidePanel.open must run inside the click's user gesture, before any await.
const OWN_TAB = await chrome.tabs.getCurrent();

const KEY = BocLimits.KEYS.aiConversations;
const NOTE_PATHS_KEY = BocLimits.KEYS.obsidianNotePaths;
const $ = (id) => document.getElementById(id);
const els = { list: $("list"), search: $("search"), count: $("count"), selectAll: $("selectAll"), bulkMd: $("bulkMd"), bulkDelete: $("bulkDelete"), clearAll: $("clearAll"), status: $("status") };

let conversations = [];
let analyses = {}; // bvid → done triage analysis
let notes = {}; // video id (bvid / YouTube videoId) → { text, updatedAt }, non-empty only
let triageTitles = {}; // bvid → title from the triage folder snapshots
let obsidianEnabled = false;
const selected = new Set();
const writing = new Set(); // entry keys with a 写入 Obsidian in flight
const unfolded = new Set(); // entry keys whose one-line AI summary is shown in full
let reloadTimer = 0;
let editing = null; // { id, draft } while a 备注 is open; storage reloads wait until it closes
let reloadPending = false;
let rendering = false;

const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
const formatTime = (value) => new Date(Number(value) || 0).toLocaleString("zh-CN", { hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });

// One entry per video: the side panel's contextKey (site|videoId|cid) is how it ties a conversation to a video.
function groupByVideo(items) {
  const byKey = new Map();
  for (const item of items) {
    const key = item.contextKey || item.id;
    byKey.set(key, [...(byKey.get(key) || []), item]);
  }
  const groups = [...byKey].map(([key, convs]) => {
    convs.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    const latest = convs.reduce((a, b) => ((b.updatedAt || 0) > (a.updatedAt || 0) ? b : a));
    const ref = latest.contextRef || {};
    const context = { ...ref, title: ref.title || latest.contextTitle || latest.title, url: latest.contextUrl || ref.url || "" };
    return { key, convs, context, title: latest.title || context.title || "历史对话", updatedAt: latest.updatedAt || 0 };
  });
  // The triage analysis and note are per video (the analysis summarizes P1), so they join only the P1 entry;
  // without one they are their own entry. Note ids are bvids or YouTube videoIds; only bvids start with BV.
  for (const bvid of new Set([...Object.keys(analyses), ...Object.keys(notes)])) {
    const analysis = analyses[bvid];
    const note = notes[bvid];
    const site = /^BV/i.test(bvid) ? "bilibili" : "youtube";
    const context = { site, videoId: bvid, title: triageTitles[bvid] || bvid, url: BocSites.SITES[site].canonicalUrl(bvid, 1), isVideoContext: true };
    const key = BocSites.buildContextKey(context);
    const host = groups.find((g) => BocSites.buildContextKey({ ...g.context, cid: "" }) === key && (Number(g.context.pageIndex) || 1) === 1);
    if (host) Object.assign(host, { analysis, note });
    else groups.push({ key, convs: [], context, title: context.title, updatedAt: Math.max(analysis?.analyzedAt || 0, note?.updatedAt || 0), analysis, note });
  }
  return groups.sort((a, b) => b.updatedAt - a.updatedAt);
}

// Same note the side panel's export menu (导出对话 → 写入 Obsidian) writes, with every conversation of the video in order.
function buildNote(group, sourcePath = "") {
  const turns = group.convs.flatMap((conv) => BocNote.buildConversationTurns(conv.messages));
  const filename = BocNote.buildAiConversationFilename(group.context);
  return { filename, content: BocNote.withTriageSummary(BocNote.buildAiConversationMarkdown({ context: group.context, turns, filename, sourcePath }), group.analysis, group.note?.text) };
}

function visibleGroups() {
  const query = els.search.value.trim().toLowerCase();
  const groups = groupByVideo(conversations);
  if (!query) return groups;
  return groups.filter((g) =>
    [g.title, g.context.title, BocNote.buildTriageSummary(g.analysis), g.note?.text, ...g.convs.flatMap((c) => (c.messages || []).map((m) => m.content))].some((text) => String(text || "").toLowerCase().includes(query))
  );
}

// The triage summary is markdown (> one-liner, - points, AI 判断 line); shown as one line, verdict first,
// cut off with an ellipsis until clicked.
function renderSummary(g) {
  const lines = BocNote.buildTriageSummary(g.analysis).split("\n").filter(Boolean);
  const verdict = lines.find((l) => l.startsWith("AI 判断："));
  const rest = lines.filter((l) => l !== verdict).map((l) => esc(l.replace(/^(> |- )/, ""))).join(" · ");
  const head = verdict ? `<b>AI 判断</b> ${esc(verdict.slice(6))}` : "";
  const open = unfolded.has(g.key);
  return `<button type="button" class="entry-summary${open ? " open" : ""}" data-act="summary" aria-expanded="${open}">${head}${head && rest ? " · " : ""}<span class="entry-points">${rest}</span></button>`;
}

// The 备注 belongs to the video and shows on its P1 entry, like grouping joins it.
const noteIdOf = (g) => (g.context.videoId && (Number(g.context.pageIndex) || 1) === 1 ? g.context.videoId : "");

function renderNote(g) {
  const id = noteIdOf(g);
  if (id && editing?.id === id) return `<textarea class="entry-note-edit" data-note rows="2" placeholder="一句话备注，回车保存" aria-label="备注">${esc(editing.draft)}</textarea>`;
  if (!g.note) return id ? `<button type="button" class="note-add" data-act="note">✎ 备注</button>` : "";
  const body = `<b>备注</b> ${esc(g.note.text.trim())}`;
  return id ? `<button type="button" class="entry-note" data-act="note" title="点击编辑备注">${body}</button>` : `<div class="entry-note">${body}</div>`;
}

// Same rule as the triage card: an unchanged note is not rewritten, an emptied one is deleted.
async function closeNote() {
  if (!editing) return;
  const { id, draft } = editing;
  editing = null;
  const text = draft.trim() ? draft : "";
  if (text !== (notes[id]?.text || "")) {
    if (text) notes[id] = { text, updatedAt: Date.now() };
    else delete notes[id];
    const stored = (await chrome.storage.local.get("triage_notes")).triage_notes || {};
    if (text) stored[id] = notes[id];
    else delete stored[id];
    await chrome.storage.local.set({ triage_notes: stored });
    setStatus(text ? "备注已保存" : "备注已删除");
  }
  if (reloadPending) {
    reloadPending = false;
    await load();
  } else render();
}

function renderConversation(conv, index, total) {
  const turns = BocNote.buildConversationTurns(conv.messages, 0)
    .map((t) => `<p class="turn-q">问：${esc(t.prompt)}</p><div class="turn-a">${BocNote.renderMarkdown(t.answer)}</div>`)
    .join("");
  return `${total > 1 ? `<p class="conv-sep">对话 ${index + 1} · ${esc(formatTime(conv.updatedAt))}</p>` : ""}${turns}`;
}

function render() {
  const groups = visibleGroups();
  const allGroups = groupByVideo(conversations);
  els.count.textContent = `${allGroups.length} 个视频 · 对话 ${conversations.length}/${BocLimits.AI_CONVERSATIONS}`;
  for (const key of [...selected]) if (!groups.some((g) => g.key === key)) selected.delete(key);
  // Storage changes re-render the list while the user reads it: keep expanded entries and the scroll.
  const open = new Set([...els.list.querySelectorAll(".entry details[open]")].map((d) => d.closest(".entry").dataset.key));
  const scrollY = window.scrollY;
  const active = document.activeElement?.matches?.("[data-note]") ? document.activeElement : null;
  const caret = active ? [active.selectionStart, active.selectionEnd] : null;
  rendering = true;
  els.list.innerHTML = groups.length
    ? groups.map((g) => {
        const site = BocSites.SITES[g.context.site]?.label || "网页";
        const turnCount = g.convs.reduce((n, c) => n + BocNote.buildConversationTurns(c.messages).length, 0);
        // A video whose title never arrived falls back to its id; show that as 未获取标题 with the id in the meta line.
        const untitled = g.title === g.context.videoId;
        const label = untitled ? "未获取标题" : g.title;
        const title = g.context.url ? `<a class="entry-title" href="${esc(g.context.url)}" target="_blank" rel="noopener">${esc(label)}</a>` : `<span class="entry-title">${esc(label)}</span>`;
        const kind = g.convs.length ? (g.convs.length > 1 ? `${g.convs.length} 段对话` : "") : `仅${[g.analysis && "分拣台 AI 总结", g.note && "备注"].filter(Boolean).join("和")}，没有 AI 对话`;
        return `<article class="entry" data-key="${esc(g.key)}">
          <input type="checkbox" data-act="pick" aria-label="选择" ${selected.has(g.key) ? "checked" : ""} />
          <div class="entry-head">
            ${title}
            <div class="entry-meta">${[site, formatTime(g.updatedAt), untitled && g.context.videoId, kind].filter(Boolean).map(esc).join(" · ")}</div>
          </div>
          <div class="entry-actions">
            <button type="button" class="ask" data-act="ask" ${g.context.videoId ? "" : "disabled title=\"不是视频，不能问\""}><span class="ai-spark" aria-hidden="true"></span>继续问</button>
            <button type="button" data-act="md">下载 .md</button>
            ${!obsidianEnabled ? "" : `<button type="button" data-act="obsidian"${writing.has(g.key) ? " disabled" : ""}><img class="obsidian-mark" src="/icons/obsidian.svg" alt=""> <span class="write-label" data-idle="写入 Obsidian">${writing.has(g.key) ? '<span aria-busy="true">写入中…</span>' : "<span>写入 Obsidian</span>"}</span></button>`}
            ${g.convs.length ? `<button type="button" data-act="delete" class="danger">删除</button>` : `<button type="button" class="danger slot" tabindex="-1" aria-hidden="true" disabled>删除</button>`}
          </div>
          <div class="entry-body">
            ${g.analysis ? renderSummary(g) : ""}
            ${renderNote(g)}
            ${g.convs.length ? `<details${open.has(g.key) ? " open" : ""}><summary>查看 ${turnCount} 轮问答</summary>${g.convs.map((c, i) => renderConversation(c, i, g.convs.length)).join("")}</details>` : ""}
          </div>
        </article>`;
      }).join("")
    : `<p class="empty">${allGroups.length ? "没有匹配的视频" : "还没有视频记录。在侧边栏提问，或在分拣台总结、写备注后，会按视频记在这里。"}</p>`;
  rendering = false;
  const textarea = editing && els.list.querySelector("[data-note]");
  if (textarea) {
    textarea.focus();
    textarea.setSelectionRange(...(caret || [textarea.value.length, textarea.value.length]));
  }
  window.scrollTo(0, scrollY);
  syncBulk(groups);
}

function syncBulk(groups = visibleGroups()) {
  els.selectAll.checked = groups.length > 0 && groups.every((g) => selected.has(g.key));
  els.bulkMd.disabled = selected.size === 0;
  els.bulkDelete.disabled = !deletableKeys([...selected]).length;
  els.clearAll.disabled = !conversations.length;
}

// 「正在…」 lines are in progress: aria-busy grays them (tokens.css) until the result replaces them.
function setStatus(text) {
  els.status.textContent = text;
  if (text.startsWith("正在")) els.status.setAttribute("aria-busy", "true");
  else els.status.removeAttribute("aria-busy");
}

async function load() {
  // ponytail: reads all of storage (subtitle caches included) to find the triage keys; getKeys() first if that gets slow.
  const all = await chrome.storage.local.get(null);
  conversations = (all[KEY] || []).filter((c) => c?.id && Array.isArray(c.messages));
  analyses = {};
  notes = Object.fromEntries(Object.entries(all.triage_notes || {}).filter(([, n]) => String(n?.text || "").trim()));
  triageTitles = {};
  for (const [k, v] of Object.entries(all)) {
    if (k.startsWith("triage_analysis_") && v?.status === "done") analyses[k.slice(16)] = v;
    else if (k.startsWith("triage_snapshot_")) Object.assign(triageTitles, v?.titles);
  }
  render();
}

// Triage-summary-only and note-only entries have no conversations to delete, so they are left out.
function deletableKeys(keys) {
  const withConvs = new Set(conversations.map((c) => c.contextKey || c.id));
  return keys.filter((key) => withConvs.has(key));
}

// Reads storage again before writing so a reply the side panel saved meanwhile is kept.
async function deleteGroups(keys) {
  keys = deletableKeys(keys);
  if (!keys.length || !confirm(`删除 ${keys.length} 个视频的全部 AI 对话？删除后不能恢复。`)) return;
  const current = (await chrome.storage.local.get(KEY))[KEY] || [];
  await chrome.storage.local.set({ [KEY]: current.filter((c) => !keys.includes(c?.contextKey || c?.id)) });
  keys.forEach((key) => selected.delete(key));
  setStatus(`已删除 ${keys.length} 个视频的对话`);
}

// Several videos go into one file like the triage batch export: one save prompt, frontmatter
// turned into yaml blocks so the merged file still renders.
function downloadGroups(groups) {
  const notes = groups.map((g) => buildNote(g));
  if (notes.length === 1) {
    BocDownload.text(notes[0].filename, notes[0].content);
  } else {
    const body = notes.map((n) => `# ${n.filename.replace(/\.md$/i, "")}\n\n${n.content.replace(/^---\n([\s\S]*?)\n---\n/, "```yaml\n$1\n```\n")}`);
    BocDownload.text(`MoonDigest视频记录-${new Date().toISOString().slice(0, 10)}.md`, body.join("\n\n"));
  }
  setStatus(`已下载 ${groups.length} 个视频的对话`);
}

// A video already written to Obsidian gets the conversation in its note's AI 问答 section, like the side panel's
// 导出对话 → 写入 Obsidian (newest conversation, as auto-sync does). Without a video note, a B 站 video (P1: the
// background builds only that) first gets the full note triage builds, at the path triage writes it to and
// recorded for it. YouTube, other parts and web pages get the standalone AI note.
async function saveToObsidian(group) {
  writing.add(group.key);
  setStatus("正在写入 Obsidian…");
  render();
  try {
    const settings = (await chrome.runtime.sendMessage({ type: "get-settings" }))?.settings || {};
    const baseUrl = String(settings.obsidianApiBaseUrl || "").trim();
    const apiKey = String(settings.obsidianApiKey || "").trim();
    if (!baseUrl || !apiKey) {
      setStatus("请先在设置页填写 Obsidian Local REST API 地址和 API Key");
      chrome.runtime.openOptionsPage();
      return;
    }
    const noteKey = BocSites.buildContextKey(group.context);
    let boundPath = noteKey ? ((await chrome.storage.local.get(NOTE_PATHS_KEY))[NOTE_PATHS_KEY] || {})[noteKey]?.path : "";
    const newest = group.convs.reduce((a, b) => ((b.updatedAt || 0) > (a.updatedAt || 0) ? b : a), group.convs[0]);
    const section = newest ? BocNote.buildAiSection(BocNote.buildConversationTurns(newest.messages)) : "";
    if (section && boundPath) {
      const resp = await chrome.runtime.sendMessage({ type: "update-obsidian-ai-section", baseUrl, apiKey, filepath: boundPath, section, noteKey });
      if (!resp?.ok) throw new Error(resp?.error || "Local API 写入失败");
      if (resp.exists !== false) {
        setStatus(`已更新 AI 问答：${boundPath}`);
        return;
      }
      boundPath = "";
    }
    // A deleted or hidden video has no note to build; its conversation is written as its own note below.
    let built = null;
    if (!boundPath && group.context.site === "bilibili" && (Number(group.context.pageIndex) || 1) === 1) {
      setStatus("正在生成视频笔记…");
      built = await chrome.runtime.sendMessage({ type: "triage-build-note", bvid: group.context.videoId });
      if (!built?.ok && !BocSites.isBiliVideoGone(built?.code)) throw new Error(built?.code === 62004 ? "视频审核中，过后再试" : built?.error || "生成视频笔记失败");
    }
    if (built?.ok) {
      setStatus("正在写入…");
      const { path: filepath, cover } = built.data;
      const exists = await chrome.runtime.sendMessage({ type: "obsidian-note-exists", baseUrl, apiKey, filepath });
      if (!exists?.ok) throw new Error(exists?.error || "Local API 检查失败");
      const choice = exists.exists ? await BocOverwriteDialog.choose(filepath, { hasAiSection: Boolean(section) }) : "full";
      if (!choice) return;
      const overwrite = choice === "full";
      if (overwrite) {
        const written = await chrome.runtime.sendMessage({ type: "write-obsidian-note", baseUrl, apiKey, filepath, content: built.data.markdown, cover, noteKey });
        if (!written?.ok) throw new Error(written?.error || "Local API 写入失败");
      }
      if (section) {
        const resp = await chrome.runtime.sendMessage({ type: "update-obsidian-ai-section", baseUrl, apiKey, filepath, section, noteKey });
        if (!resp?.ok) throw new Error(resp?.error || "Local API 写入失败");
      }
      setStatus(overwrite ? `已写入 Obsidian：${filepath}` : `已更新 AI 问答：${filepath}`);
      return;
    }
    const videoFolder = BocNote.resolveFolderTemplate(settings.noteFolder || "", group.context);
    const videoFile = BocNote.buildNoteFilename(group.context, settings);
    const sourcePath = boundPath || (videoFolder ? `${videoFolder}/${videoFile}` : videoFile);
    const note = buildNote(group, sourcePath);
    const filepath = videoFolder ? `${videoFolder}/${note.filename}` : note.filename;
    const exists = await chrome.runtime.sendMessage({ type: "obsidian-note-exists", baseUrl, apiKey, filepath });
    if (!exists?.ok) throw new Error(exists?.error || "Local API 检查失败");
    if (exists.exists && !confirm(`该笔记已存在，继续会覆盖原内容：${filepath}`)) return;
    const written = await chrome.runtime.sendMessage({ type: "write-obsidian-note", baseUrl, apiKey, filepath, content: note.content });
    if (!written?.ok) throw new Error(written?.error || "Local API 写入失败");
    if (built) setStatus(`已写入 Obsidian：${filepath}（视频已失效，只写了对话）`);
    else setStatus(group.context.videoId ? `已写入 Obsidian：${filepath}（单独的对话笔记）` : `已写入 Obsidian：${filepath}`);
  } catch (error) {
    setStatus(`写入 Obsidian 失败：${error?.message || error}`);
  } finally {
    // A declined overwrite returns without a result line; drop the in-progress one.
    if (els.status.textContent.startsWith("正在")) setStatus("");
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
  else if (act === "ask" && group) {
    // The side panel continues the video's latest conversation, the same request triage's 问 AI sends.
    chrome.storage.local.set({ boc_player_ai_quick_action_v1: { id: `history-${Date.now()}`, tabId: OWN_TAB?.id, prompt: "", contextRef: group.context } });
    setStatus("正在打开侧边栏…");
    chrome.sidePanel.open({ tabId: OWN_TAB?.id }).then(
      () => els.status.textContent === "正在打开侧边栏…" && setStatus(""),
      (error) => setStatus(`打开侧边栏失败：${error.message}`)
    );
  }
});
els.list.addEventListener("input", (event) => {
  if (editing && event.target.matches("[data-note]")) editing.draft = event.target.value;
});
// Enter (or Esc) saves and closes; Shift+Enter is a newline. Never mid-IME.
els.list.addEventListener("keydown", (event) => {
  if (BocTyping.composing(event) || !event.target.matches("[data-note]")) return;
  if (!(event.key === "Escape" || (event.key === "Enter" && !event.shiftKey))) return;
  event.preventDefault();
  void closeNote();
});
els.list.addEventListener("focusout", (event) => {
  if (!rendering && event.target.matches("[data-note]")) void closeNote();
});
BocTyping.bindLive(els.search, () => render());
els.selectAll.addEventListener("change", () => {
  visibleGroups().forEach((g) => (els.selectAll.checked ? selected.add(g.key) : selected.delete(g.key)));
  render();
});
els.bulkMd.addEventListener("click", () => downloadGroups(groupByVideo(conversations).filter((g) => selected.has(g.key))));
els.bulkDelete.addEventListener("click", () => void deleteGroups([...selected]));
// AI conversations only: triage analyses and notes are other features' data and stay.
els.clearAll.addEventListener("click", async () => {
  if (!confirm("清空全部 AI 对话？删除后不能恢复。")) return;
  await chrome.storage.local.set({ [KEY]: [] });
  selected.clear();
  setStatus("已清空全部 AI 对话");
});
chrome.storage.onChanged.addListener((changes, area) => {
  // Triage analyses arrive in bursts; one reload per burst.
  if (area === "local" && Object.keys(changes).some((k) => k === KEY || k === "triage_notes" || k.startsWith("triage_analysis_") || k.startsWith("triage_snapshot_"))) {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => (editing ? (reloadPending = true) : load()), 300);
  }
  if (area === "sync" && changes.obsidianEnabled) {
    obsidianEnabled = changes.obsidianEnabled.newValue === true;
    render();
  }
});

obsidianEnabled = (await chrome.runtime.sendMessage({ type: "get-settings" }).catch(() => null))?.settings?.obsidianEnabled === true;
await load();
