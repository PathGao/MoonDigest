// The only writer to Obsidian (Local REST API): every page asks the background, which decides the path, the body and
// what to say. Loaded by background.js (importScripts) before triage/triage-bg.js; at call time it uses background.js
// (getMergedSettings, normalizeAiContextRef, fetchWithTimeout) and triage-bg.js (triageBuildNote).
const OBSIDIAN_TIMEOUT_MS = 30000;

const obsidianCoded = (text, code) => Object.assign(new Error(text), { code });
// What every entry shows after a write (writeVideoNote, 一篇摘录 via triage-export).
const obsidianWritten = (path) => `已写入 Obsidian：${path}`;
// After only the AI 问答 section was replaced (writeVideoNote's ai mode, syncVideoNoteAi); the side panel shows it.
const aiSectionUpdated = (path) => `已更新 AI 问答：${path}`;

// Every Obsidian failure in the user's words. Code OBSIDIAN (not enabled, not set up, wrong key, an address that
// answers 404) or OBSIDIAN_DOWN (closed, plugin off, nothing listening; 408 is fetchWithTimeout's timeout) fails every
// write alike (MdgErrors.CODES says what pages show). Any other HTTP error of one note shows the status, never the
// response body. Errors it already made pass through.
function obsidianError(e) {
  if (e?.status === 401 || e?.status === 403) return obsidianCoded(MdgErrors.TEXT.obsidianKey, "OBSIDIAN");
  if (e?.status === 404) return obsidianCoded(MdgErrors.TEXT.obsidianNotFound, "OBSIDIAN");
  if (e?.status === 408 || e?.name === "TypeError") return obsidianCoded(MdgErrors.TEXT.obsidianDown, "OBSIDIAN_DOWN");
  return e?.status ? new Error(`Obsidian 返回 HTTP ${e.status}`) : e;
}

// { baseUrl, apiKey }, or code OBSIDIAN: not enabled or not set up, so every write fails the same way.
function obsidianConfig(settings) {
  if (!settings.obsidianEnabled) throw obsidianCoded(MdgErrors.TEXT.obsidianOff, "OBSIDIAN");
  const baseUrl = String(settings.obsidianApiBaseUrl || "").trim();
  const apiKey = String(settings.obsidianApiKey || "").trim();
  if (!baseUrl || !apiKey) throw obsidianCoded(MdgErrors.TEXT.obsidianUnset, "OBSIDIAN");
  return { baseUrl, apiKey };
}

function vaultEndpoint({ baseUrl }, filepath) {
  const encodedPath = filepath.split("/").filter(Boolean).map((segment) => encodeURIComponent(segment)).join("/");
  return `${baseUrl.replace(/\/+$/g, "")}/vault/${encodedPath}`;
}

async function vaultFetch(vault, filepath, options) {
  try {
    const response = await fetchWithTimeout(vaultEndpoint(vault, filepath), { ...options, headers: { Authorization: `Bearer ${vault.apiKey}`, ...options.headers } }, OBSIDIAN_TIMEOUT_MS);
    if (!response.ok && response.status !== 404) throw { status: response.status };
    return response;
  } catch (e) {
    throw obsidianError(e);
  }
}

async function readVaultNote(vault, filepath) {
  const response = await vaultFetch(vault, filepath, { method: "GET", headers: { Accept: "text/markdown, text/plain, */*" }, cache: "no-store" });
  return response.status === 404 ? { exists: false, content: "" } : { exists: true, content: await response.text() };
}

async function putVaultNote(vault, filepath, body) {
  const response = await vaultFetch(vault, filepath, { method: "PUT", headers: { "Content-Type": "text/markdown; charset=utf-8" }, body });
  if (response.status === 404) throw obsidianError({ status: 404 });
}

// One request to the API root, which answers authenticated: false to a wrong key: the settings page's 测试连接 and the
// check before a 逐个视频笔记 run (triage-bg.js triageObsidianCheck). Throws obsidianError's errors, the words of every
// write; returns the service name.
async function probeObsidian(baseUrl, apiKey) {
  let response;
  try {
    response = await fetchWithTimeout(`${baseUrl.replace(/\/+$/g, "")}/`, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json, text/plain, */*" },
      cache: "no-store"
    }, OBSIDIAN_TIMEOUT_MS);
  } catch (e) {
    throw obsidianError(e);
  }
  const data = await response.json().catch(() => null);
  if (data?.authenticated === false) throw obsidianError({ status: 401 });
  if (!response.ok) throw obsidianError({ status: response.status });
  return typeof data?.service === "string" ? data.service : "Obsidian Local REST API";
}

async function testObsidianConnection(baseUrl, apiKey) {
  try {
    return { ok: true, service: await probeObsidian(baseUrl, apiKey) };
  } catch (error) {
    const { message, code } = obsidianError(error);
    return { ok: false, error: code === "OBSIDIAN_DOWN" ? `${message}；也检查地址、HTTP/HTTPS 和证书信任` : String(message || error), ...(code && { code }) };
  }
}

// The note a write recorded for a video (MdgSites.buildContextKey) wins over the computed path, which carries the
// date when includeDateInFilename is on. ponytail: read-modify-write on one storage key; writes are seconds apart.
async function notePaths() {
  const key = MdgLimits.KEYS.obsidianNotePaths;
  return (await chrome.storage.local.get(key))[key] || {};
}
// pageIndex: which 分 P the note is, so a ref without the cid (逐个视频笔记 knows only the BV) finds its P1 note
// (recordedNoteKey). An entry written before it was recorded keeps none until its next write.
async function rememberObsidianNotePath(noteKey, filepath, pageIndex) {
  if (!noteKey) return;
  const paths = await notePaths();
  const page = pageIndex || paths[noteKey]?.pageIndex;
  await chrome.storage.local.set({ [MdgLimits.KEYS.obsidianNotePaths]: { ...paths, [noteKey]: { path: filepath, lastSyncedAt: Date.now(), ...(page && { pageIndex: page }) } } });
}
// The recorded key of the ref's note. Keys carry the cid (MdgSites.buildContextKey); without it, the entry recorded for
// the same BV and 分 P. Prefix alone is not enough: P2's note has the same BV.
function recordedNoteKey(paths, key, ref) {
  if (!key || paths[key] || ref.cid) return key;
  return Object.keys(paths).find((k) => k.startsWith(key) && paths[k].pageIndex === ref.pageIndex) || key;
}
async function forgetObsidianNotePath(noteKey) {
  const { [noteKey]: removed, ...rest } = await notePaths();
  if (removed) await chrome.storage.local.set({ [MdgLimits.KEYS.obsidianNotePaths]: rest });
}

// Rewrites only the marked AI 问答 block of an existing note (MdgNote.upsertAiSection); a missing note is reported and
// forgotten, never created. existing: the note already read, if any. Returns { exists, updated }.
async function updateAiSectionInVault(vault, filepath, section, noteKey, existing, pageIndex) {
  const note = existing || (await readVaultNote(vault, filepath));
  if (!note.exists) {
    await forgetObsidianNotePath(noteKey);
    return { exists: false, updated: false };
  }
  const next = MdgNote.upsertAiSection(note.content, section);
  if (next !== note.content) await putVaultNote(vault, filepath, next);
  await rememberObsidianNotePath(noteKey, filepath, pageIndex);
  return { exists: true, updated: next !== note.content };
}

// Obsidian requests remote images with an app://obsidian.md Referer, which hdslb.com answers with 403,
// so the cover goes into the vault next to the note and the note links it. Any failure keeps the remote URL.
// The two rewritten forms mirror note.js buildFrontMatter ("cover") and buildMarkdown (cover image line).
async function linkCoverInVault(vault, filepath, content, cover) {
  const url = String(cover?.url || "");
  const name = cover?.name ? MdgSites.sanitizeFileName(cover.name) : "";
  if (!url || !name || !content.includes(url)) {
    return content;
  }
  try {
    const ext = /\.(jpe?g|png|webp|gif)$/i.exec(new URL(url).pathname)?.[1].toLowerCase() || "jpg";
    const folder = filepath.split("/").slice(0, -1).join("/");
    const path = `${folder ? `${folder}/` : ""}attachments/${name}.${ext}`;
    const existing = await vaultFetch(vault, path, { method: "GET", cache: "no-store" });
    if (existing.status === 404) {
      const image = await fetchWithTimeout(url, { referrerPolicy: "no-referrer" });
      if (!image.ok) {
        throw new Error(`cover HTTP ${image.status}`);
      }
      // A non-text Content-Type makes the plugin store the body as binary.
      await vaultFetch(vault, path, { method: "PUT", headers: { "Content-Type": image.headers.get("Content-Type") || "application/octet-stream" }, body: await image.arrayBuffer() });
    }
    const link = `[[${path}]]`;
    return content.replace(`cover: "${url}"`, () => `cover: "${link}"`).replace(`![cover](${url})`, () => `!${link}`);
  } catch (error) {
    console.warn("[mdg] cover not stored in vault, keeping the remote URL", error);
    return content;
  }
}

// write-video-note: the one write of a video's note, from the video page, the side panel, 视频记录 and 逐个视频笔记.
// ref: the video (or a web page's context). conversation: { messages } for the AI 问答 section; left out, the video's
// latest saved conversation. page: { markdown, cover, warning } from the open video page (warning: its
// MdgNote.noteSubtitleWarning, which the result starts with as for a note built here). mode: left out, an existing note is
// not touched and the answer is ask; "full" writes the whole note; "ai" replaces only the AI 问答 section of an existing
// note and writes a missing one whole.
// Resolves { ask: true, path, hasAiSection } or { path, kind: full | ai | unchanged | conversation, text, title }.
async function writeVideoNote({ ref: input, mode, conversation, page }) {
  const settings = await getMergedSettings();
  const vault = obsidianConfig(settings);
  const ref = normalizeAiContextRef(input || {});
  let key = ref.isVideoContext ? MdgSites.buildContextKey(ref) : "";
  const { aiConversations } = MdgLimits.KEYS;
  const extrasRef = { site: ref.site, videoId: key ? ref.videoId : "", pageIndex: ref.pageIndex };
  const stored = await chrome.storage.local.get([aiConversations, ...MdgNote.triageExtrasKeys(extrasRef)]);
  const turns = MdgNote.buildConversationTurns(conversation ? conversation.messages : MdgNote.pickConversation(stored[aiConversations], ref)?.messages);
  const aiOn = settings.includeAiChatInNote !== false;
  const section = aiOn ? MdgNote.buildAiSection(turns) : "";
  const paths = await notePaths();
  key = recordedNoteKey(paths, key, ref);
  const computedPath = () => paths[key]?.path || MdgNote.videoNotePath(ref, settings);

  // The conversation as its own note, linking the video note (sourcePath) when there is one.
  const standalone = (why, sourcePath) => {
    const { analysis, note } = MdgNote.triageExtras(stored, extrasRef);
    if (!turns.length && !analysis && !note.trim()) throw new Error("没有可写入 Obsidian 的内容");
    const filename = MdgNote.buildAiConversationFilename(ref);
    const markdown = MdgNote.buildAiConversationMarkdown({ context: ref, turns, filename, sourcePath });
    return { path: MdgNote.conversationNotePath(ref, settings), why, body: async () => ({ markdown: MdgNote.withTriageSummary(markdown, analysis, note) }) };
  };
  let target;
  let built = null;
  if (!key) {
    target = standalone("", "");
  } else if (conversation && turns.length && !aiOn) {
    // 「附带 AI 问答」 off: a conversation the user writes still reaches Obsidian, beside the note.
    target = standalone("（单独的对话笔记）", computedPath());
  } else if (page?.markdown) {
    target = { video: true, path: computedPath(), body: async () => ({ markdown: page.markdown, cover: { url: page.cover, name: `${ref.site}-${ref.videoId}` }, warning: String(page.warning || "") }) };
  } else if (ref.site === "bilibili" && ref.pageIndex === 1) {
    // Without the page only a B站 P1 note can be built (triageBuildNote). A known path skips the build until the
    // body is needed; otherwise the API meta names the path ({{author}}, {{upload_date}}) and the cid the key.
    const build = async () => {
      built ||= await triageBuildNote(ref.videoId, settings);
      return { markdown: built.markdown, cover: built.cover, warning: built.subtitleWarning };
    };
    if (paths[key]) {
      target = { video: true, path: paths[key].path, body: build };
    } else {
      try {
        await build();
        key = MdgSites.buildContextKey({ ...ref, cid: ref.cid || built.noteMeta.cid });
        target = { video: true, path: paths[key]?.path || built.path, body: build };
      } catch (e) {
        // A deleted or hidden video has no note to build: a conversation the user writes goes in its own note.
        if (!conversation || !MdgSites.isBiliVideoGone(e.code)) throw e;
        target = standalone("（视频已失效，只写了对话）", "");
      }
    }
  } else {
    target = standalone("（单独的对话笔记）", computedPath());
  }

  const { path } = target;
  // After body(): a recorded note is built only when it is written whole.
  const title = () => built?.meta.title || ref.title;
  const existing = await readVaultNote(vault, path);
  if (existing.exists && !mode) {
    return { ask: true, path, ...(target.video && { hasAiSection: Boolean(section) }) };
  }
  if (target.video && existing.exists && mode === "ai") {
    // Only the AI 问答 section changes: the rest of the note, subtitle warning included, stays as written before.
    const { updated } = section ? await updateAiSectionInVault(vault, path, section, key, existing, ref.pageIndex) : { updated: false };
    return { path, kind: updated ? "ai" : "unchanged", text: aiSectionUpdated(path), title: title() };
  }
  const { markdown, cover, warning = "" } = await target.body();
  if (!target.video) {
    await putVaultNote(vault, path, markdown);
    return { path, kind: "conversation", text: `${obsidianWritten(path)}${target.why}`, title: title() };
  }
  const content = aiOn ? MdgNote.upsertAiSection(markdown, section) : markdown;
  // Last guard: no writer means to empty a note, so an empty body is a caller's bug (a video that changed mid-write).
  if (!content.trim()) throw new Error("笔记内容为空");
  await putVaultNote(vault, path, await linkCoverInVault(vault, path, content, cover));
  await rememberObsidianNotePath(key, path, ref.pageIndex);
  return { path, kind: "full", text: `${warning}${obsidianWritten(path)}`, title: title(), ...(warning && { subtitleWarning: warning }) };
}

// sync-video-note-ai: after a write recorded the video's note, each finished answer replaces its AI 问答 section.
// Never creates a note. Resolves { path: "" } when there is nothing to do, else { path, exists, updated, text? }: text,
// what the side panel shows, when the note is still there.
async function syncVideoNoteAi({ ref: input, conversation }) {
  const ref = normalizeAiContextRef(input || {});
  const key = ref.isVideoContext ? MdgSites.buildContextKey(ref) : "";
  const path = key ? (await notePaths())[key]?.path : "";
  const section = MdgNote.buildAiSection(MdgNote.buildConversationTurns(conversation?.messages));
  if (!path || !section) return { path: "" };
  const settings = await getMergedSettings();
  if (settings.includeAiChatInNote === false) return { path: "" };
  let vault;
  try {
    vault = obsidianConfig(settings);
  } catch {
    return { path: "" };
  }
  const done = await updateAiSectionInVault(vault, path, section, key);
  return { path, ...done, ...(done.exists && { text: aiSectionUpdated(path) }) };
}

if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
  const handlers = { "write-video-note": writeVideoNote, "sync-video-note-ai": syncVideoNoteAi };
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const handler = handlers[message?.type];
    if (!handler) return false;
    handler(message).then(
      (result) => sendResponse({ ok: true, ...result }),
      (e) => sendResponse({ ok: false, error: e?.message || String(e), ...(e?.code && { code: e.code }) })
    );
    return true;
  });
}
