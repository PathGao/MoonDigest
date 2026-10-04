if (!globalThis.chrome?.runtime?.id) await import("./dev/mock-chrome.js");
// Read up front: sidePanel.open must run inside the click's user gesture, before any await.
const OWN_TAB = await chrome.tabs.getCurrent();

const KEY = BocLimits.KEYS.aiConversations;
const NOTE_PATHS_KEY = BocLimits.KEYS.obsidianNotePaths;
const $ = (id) => document.getElementById(id);
const els = { list: $("list"), search: $("search"), count: $("count"), selectAll: $("selectAll"), bulkMd: $("bulkMd"), bulkDelete: $("bulkDelete"), clearAll: $("clearAll"), status: $("status") };

let conversations = [];
let analyses = {}; // bvid → done triage analysis
let notes = {}; // bvid → { text, updatedAt } from the triage page, non-empty only
let triageTitles = {}; // bvid → title from the triage folder snapshots
let obsidianEnabled = false;
const selected = new Set();

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
  // The triage analysis and note are per bvid (the analysis summarizes P1), so they join only the P1 entry;
  // without one they are their own entry.
  for (const bvid of new Set([...Object.keys(analyses), ...Object.keys(notes)])) {
    const analysis = analyses[bvid];
    const note = notes[bvid];
    const context = { site: "bilibili", videoId: bvid, title: triageTitles[bvid] || bvid, url: BocSites.SITES.bilibili.canonicalUrl(bvid, 1), isVideoContext: true };
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

// The triage summary is markdown (> one-liner, - points, 判断 line); shown as a paragraph, a list and a line.
function renderSummary(analysis) {
  const lines = BocNote.buildTriageSummary(analysis).split("\n").filter(Boolean);
  const points = lines.filter((l) => l.startsWith("- ")).map((l) => `<li>${esc(l.slice(2))}</li>`).join("");
  const rest = lines.filter((l) => !l.startsWith("- ")).map((l) => esc(l.replace(/^> /, "")));
  return `<div class="entry-summary">${rest[0] && !rest[0].startsWith("判断") ? `<p>${rest.shift()}</p>` : ""}${points ? `<ul>${points}</ul>` : ""}${rest.map((l) => `<p>${l}</p>`).join("")}</div>`;
}

function renderConversation(conv, index, total) {
  const turns = BocNote.buildConversationTurns(conv.messages)
    .map((t) => `<p class="turn-q">问：${esc(t.prompt)}</p><div class="turn-a">${esc(t.answer)}</div>`)
    .join("");
  return `${total > 1 ? `<p class="conv-sep">对话 ${index + 1} · ${esc(formatTime(conv.updatedAt))}</p>` : ""}${turns}`;
}

function render() {
  const groups = visibleGroups();
  const allGroups = groupByVideo(conversations);
  els.count.textContent = `${allGroups.length} 个视频 · 已存 ${conversations.length} 段（上限 ${BocLimits.AI_CONVERSATIONS}）`;
  for (const key of [...selected]) if (!groups.some((g) => g.key === key)) selected.delete(key);
  els.list.innerHTML = groups.length
    ? groups.map((g) => {
        const site = BocSites.SITES[g.context.site]?.label || "网页";
        const turnCount = g.convs.reduce((n, c) => n + BocNote.buildConversationTurns(c.messages).length, 0);
        const title = g.context.url ? `<a class="entry-title" href="${esc(g.context.url)}" target="_blank" rel="noopener">${esc(g.title)}</a>` : `<span class="entry-title">${esc(g.title)}</span>`;
        return `<article class="entry" data-key="${esc(g.key)}">
          <input type="checkbox" data-act="pick" aria-label="选择" ${selected.has(g.key) ? "checked" : ""} />
          <div>
            ${title}
            <div class="entry-meta">${esc(site)} · ${esc(formatTime(g.updatedAt))} · ${g.convs.length ? `${g.convs.length} 段对话 · ${turnCount} 轮问答` : `仅${[g.analysis && "分拣台 AI 总结", g.note && "备注"].filter(Boolean).join("和")}`}</div>
            ${g.analysis ? renderSummary(g.analysis) : ""}
            ${g.note ? `<div class="entry-note"><b>备注</b> ${esc(g.note.text.trim())}</div>` : ""}
            ${g.convs.length ? `<details><summary>查看对话</summary>${g.convs.map((c, i) => renderConversation(c, i, g.convs.length)).join("")}</details>` : ""}
          </div>
          <div class="entry-actions">
            <button type="button" data-act="ask" ${g.context.videoId ? "" : "disabled title=\"只有视频能继续问\""}>继续问</button>
            <button type="button" data-act="md">下载 .md</button>
            ${obsidianEnabled ? '<button type="button" data-act="obsidian"><img class="obsidian-mark" src="/icons/obsidian.svg" alt=""> 写入 Obsidian</button>' : ""}
            <button type="button" data-act="delete" class="danger" ${g.convs.length ? "" : "disabled title=\"没有 AI 对话可删\""}>删除</button>
          </div>
        </article>`;
      }).join("")
    : `<p class="empty">${allGroups.length ? "没有匹配的对话" : "还没有 AI 对话。在视频页打开侧边栏提问后，会按视频记在这里。"}</p>`;
  syncBulk(groups);
}

function syncBulk(groups = visibleGroups()) {
  els.selectAll.checked = groups.length > 0 && groups.every((g) => selected.has(g.key));
  els.bulkMd.disabled = selected.size === 0;
  els.bulkDelete.disabled = !deletableKeys([...selected]).length;
  els.clearAll.disabled = !conversations.length;
}

function setStatus(text) {
  els.status.textContent = text;
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
    BocDownload.text(`MoonDigest历史-${new Date().toISOString().slice(0, 10)}.md`, body.join("\n\n"));
  }
  setStatus(`已下载 ${groups.length} 个视频的对话`);
}

// A video already written to Obsidian gets the conversation in its note's AI 问答 section, like the side panel's
// 导出对话 → 写入 Obsidian (newest conversation, as auto-sync does). Without a video note — this page can't read the
// video's subtitles to create one — or for web pages, it writes the standalone AI note.
async function saveToObsidian(group, button) {
  button.disabled = true;
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
    const boundPath = noteKey ? ((await chrome.storage.local.get(NOTE_PATHS_KEY))[NOTE_PATHS_KEY] || {})[noteKey]?.path : "";
    const newest = group.convs.reduce((a, b) => ((b.updatedAt || 0) > (a.updatedAt || 0) ? b : a), group.convs[0]);
    const section = boundPath && newest ? BocNote.buildAiSection(BocNote.buildConversationTurns(newest.messages)) : "";
    if (section) {
      const resp = await chrome.runtime.sendMessage({ type: "update-obsidian-ai-section", baseUrl, apiKey, filepath: boundPath, section, noteKey });
      if (!resp?.ok) throw new Error(resp?.error || "Local API 写入失败");
      if (resp.exists !== false) {
        setStatus(`已写入 Obsidian：${boundPath}（AI 问答段）`);
        return;
      }
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
    setStatus(group.context.videoId ? `已写入 Obsidian：${filepath}（这个视频还没有视频笔记，写成了单独的对话笔记）` : `已写入 Obsidian：${filepath}`);
  } catch (error) {
    setStatus(`写入 Obsidian 失败：${error?.message || error}`);
  } finally {
    button.disabled = false;
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
  else if (act === "obsidian" && group) void saveToObsidian(group, target);
  else if (act === "delete") void deleteGroups([key]);
  else if (act === "ask" && group) {
    // The side panel continues the video's latest conversation, the same request triage's 问 AI sends.
    chrome.storage.local.set({ boc_player_ai_quick_action_v1: { id: `history-${Date.now()}`, tabId: OWN_TAB?.id, prompt: "", contextRef: group.context } });
    chrome.sidePanel.open({ tabId: OWN_TAB?.id }).catch((error) => setStatus(`打开侧边栏失败：${error.message}`));
  }
});
els.search.addEventListener("input", render);
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
  if (area === "local" && Object.keys(changes).some((k) => k === KEY || k === "triage_notes" || k.startsWith("triage_analysis_") || k.startsWith("triage_snapshot_"))) void load();
  if (area === "sync" && changes.obsidianEnabled) {
    obsidianEnabled = changes.obsidianEnabled.newValue === true;
    render();
  }
});

obsidianEnabled = (await chrome.runtime.sendMessage({ type: "get-settings" }).catch(() => null))?.settings?.obsidianEnabled === true;
await load();
