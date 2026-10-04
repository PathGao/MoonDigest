if (!globalThis.chrome?.runtime?.id) await import("./dev/mock-chrome.js");

const KEY = BocLimits.KEYS.aiConversations;
const NOTE_PATHS_KEY = BocLimits.KEYS.obsidianNotePaths;
const $ = (id) => document.getElementById(id);
const els = { list: $("list"), search: $("search"), count: $("count"), selectAll: $("selectAll"), bulkMd: $("bulkMd"), bulkDelete: $("bulkDelete"), status: $("status") };

let conversations = [];
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
  return [...byKey].map(([key, convs]) => {
    convs.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    const latest = convs.reduce((a, b) => ((b.updatedAt || 0) > (a.updatedAt || 0) ? b : a));
    const ref = latest.contextRef || {};
    const context = { ...ref, title: ref.title || latest.contextTitle || latest.title, url: latest.contextUrl || ref.url || "" };
    return { key, convs, context, title: latest.title || context.title || "历史对话", updatedAt: latest.updatedAt || 0 };
  }).sort((a, b) => b.updatedAt - a.updatedAt);
}

// Same note the side panel's 保存对话 writes, with every conversation of the video in order.
function buildNote(group, sourcePath = "") {
  const turns = group.convs.flatMap((conv) => BocNote.buildConversationTurns(conv.messages));
  const filename = BocNote.buildAiConversationFilename(group.context);
  return { filename, content: BocNote.buildAiConversationMarkdown({ context: group.context, turns, filename, sourcePath }) };
}

function visibleGroups() {
  const query = els.search.value.trim().toLowerCase();
  const groups = groupByVideo(conversations);
  if (!query) return groups;
  return groups.filter((g) =>
    [g.title, g.context.title, ...g.convs.flatMap((c) => (c.messages || []).map((m) => m.content))].some((text) => String(text || "").toLowerCase().includes(query))
  );
}

function renderConversation(conv, index, total) {
  const turns = BocNote.buildConversationTurns(conv.messages)
    .map((t) => `<p class="turn-q">问：${esc(t.prompt)}</p><div class="turn-a">${esc(t.answer)}</div>`)
    .join("");
  return `${total > 1 ? `<p class="conv-sep">对话 ${index + 1} · ${esc(formatTime(conv.updatedAt))}</p>` : ""}${turns}`;
}

function render() {
  const groups = visibleGroups();
  const videoCount = groupByVideo(conversations).length;
  els.count.textContent = `${videoCount} 个视频 · ${conversations.length} / ${BocLimits.AI_CONVERSATIONS} 段对话`;
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
            <div class="entry-meta">${esc(site)} · ${esc(formatTime(g.updatedAt))} · ${g.convs.length} 段对话 · ${turnCount} 轮问答</div>
            <details><summary>查看对话</summary>${g.convs.map((c, i) => renderConversation(c, i, g.convs.length)).join("")}</details>
          </div>
          <div class="entry-actions">
            <button type="button" data-act="md">下载 .md</button>
            ${obsidianEnabled ? '<button type="button" data-act="obsidian">存 Obsidian</button>' : ""}
            <button type="button" data-act="delete" class="danger">删除</button>
          </div>
        </article>`;
      }).join("")
    : `<p class="empty">${conversations.length ? "没有匹配的对话" : "还没有 AI 对话。在视频页打开侧边栏提问后，会按视频记在这里。"}</p>`;
  syncBulk(groups);
}

function syncBulk(groups = visibleGroups()) {
  els.selectAll.checked = groups.length > 0 && groups.every((g) => selected.has(g.key));
  els.bulkMd.disabled = els.bulkDelete.disabled = selected.size === 0;
}

function setStatus(text) {
  els.status.textContent = text;
}

async function load() {
  conversations = ((await chrome.storage.local.get(KEY))[KEY] || []).filter((c) => c?.id && Array.isArray(c.messages));
  render();
}

// Reads storage again before writing so a reply the side panel saved meanwhile is kept.
async function deleteGroups(keys) {
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

// Writes the standalone AI note like the side panel's 保存对话. The video note's AI 问答 section is
// left to the side panel's auto-sync, which follows the newest conversation rather than all of them.
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
    const videoFolder = BocNote.resolveFolderTemplate(settings.noteFolder || "", group.context);
    const videoFile = BocNote.buildNoteFilename(group.context, settings);
    const sourcePath = boundPath || (videoFolder ? `${videoFolder}/${videoFile}` : videoFile);
    const note = buildNote(group, sourcePath);
    const filepath = videoFolder ? `${videoFolder}/${note.filename}` : note.filename;
    const exists = await chrome.runtime.sendMessage({ type: "obsidian-note-exists", baseUrl, apiKey, filepath });
    if (!exists?.ok) throw new Error(exists?.error || "Local API 检查失败");
    if (exists.exists && !confirm(`Obsidian 里已有 ${filepath}，覆盖它？`)) return;
    const written = await chrome.runtime.sendMessage({ type: "write-obsidian-note", baseUrl, apiKey, filepath, content: note.content });
    if (!written?.ok) throw new Error(written?.error || "Local API 写入失败");
    setStatus(`已写入 Obsidian：${filepath}`);
  } catch (error) {
    setStatus(`写入失败：${error?.message || error}`);
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
});
els.search.addEventListener("input", render);
els.selectAll.addEventListener("change", () => {
  visibleGroups().forEach((g) => (els.selectAll.checked ? selected.add(g.key) : selected.delete(g.key)));
  render();
});
els.bulkMd.addEventListener("click", () => downloadGroups(groupByVideo(conversations).filter((g) => selected.has(g.key))));
els.bulkDelete.addEventListener("click", () => void deleteGroups([...selected]));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[KEY]) void load();
});

obsidianEnabled = (await chrome.runtime.sendMessage({ type: "get-settings" }).catch(() => null))?.settings?.obsidianEnabled === true;
await load();
