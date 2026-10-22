// The only writer to Obsidian (Local REST API): every page asks the background, which decides the path, the body and
// what to say. Loaded by background.js (importScripts) before triage/triage-bg.js; at call time it uses background.js
// (getMergedSettings, fetchWithTimeout) and triage-bg.js (triageBuildNote).
const OBSIDIAN_TIMEOUT_MS = 30000;

const obsidianCoded = (text, code) => Object.assign(new Error(text), { code });
// What every entry shows after a write (writeVideoNote, 一篇摘录 via triage-export).
const obsidianWritten = (path) => `已写入 Obsidian：${path}`;
// After only the AI 问答 section was replaced (writeVideoNote's ai mode, syncVideoNoteAi); the side panel shows it.
// updated false: the section was already the same, nothing was written.
const aiSectionResult = (path, updated) => (updated ? `已更新 AI 问答：${path}` : `AI 问答没有变化：${path}`);
// Why a conversation went to its own note, after the path.
const OWN_NOTE = "（单独的 AI 笔记）";
// A recorded note without its open page (a video's, a web page's) cannot be rebuilt whole: the dialog disables 整篇覆盖
// with this.
const needsPage = (ref) => (ref.isVideoContext ? "整篇覆盖要先打开视频页" : "整篇覆盖要先打开这个网页");

// Every Obsidian failure in the user's words. Code OBSIDIAN (not enabled, not set up, wrong key, an address that
// answers 404) or OBSIDIAN_DOWN (closed, plugin off, nothing listening; 408 is fetchWithTimeout's timeout) fails every
// write alike (MdgErrors.CODES says what pages show). Any other HTTP error of one note shows the status, never the
// response body. Errors it already made pass through.
function obsidianError(e) {
  if (e?.status === 401 || e?.status === 403) return obsidianCoded(MdgErrors.TEXT.obsidianKey, "OBSIDIAN");
  if (e?.status === 404) return obsidianCoded(MdgErrors.TEXT.obsidianNotFound, "OBSIDIAN");
  if (e?.status === MdgErrors.TIMEOUT_STATUS || e?.name === "TypeError") return obsidianCoded(MdgErrors.TEXT.obsidianDown, "OBSIDIAN_DOWN");
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

// . and .. are dropped: the URL would resolve them out of the vault folder.
function vaultEndpoint({ baseUrl }, filepath) {
  const encodedPath = filepath.split("/").filter((segment) => segment && segment !== "." && segment !== "..").map((segment) => encodeURIComponent(segment)).join("/");
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
// write, or obsidianNotApi when the answer is not the API's JSON with its service name (another service on that
// address); returns the service name.
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
  if (typeof data?.service !== "string") throw obsidianCoded(MdgErrors.TEXT.obsidianNotApi, "OBSIDIAN");
  return data.service;
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
    // Every path 404s at a wrong address: forget the note only once the API itself answers.
    await probeObsidian(vault.baseUrl, vault.apiKey);
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
  const name = MdgCommon.fileName(cover?.name);
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

// write-video-note: the one write of a video's note, from the video page, the side panel, 摘读记录 and 逐个视频笔记.
// ref: the video (or a web page's context). conversation: { messages } for the AI 问答 section; left out, the video's
// latest saved conversation. page: { markdown, cover, warning } from the open video page (warning: its
// MdgNote.noteSubtitleWarning, which the result starts with as for a note built here). mode: left out, an existing note is
// not touched and the answer is ask; "full" writes the whole note; "ai" replaces only the AI 问答 section of an existing
// note and writes a missing one whole. A web page or a video whose note cannot be built here (YouTube, 分 P) sent without
// its page is read from a tab that shows it; with none and no note of it yet, the answer is askPage (writing the
// conversation alone would leave a second note once the page's note is written), and the caller sends again with
// pageChoice "open" (open the page, then write its note) or "own" (the conversation as its own note).
// Resolves { ask: true, path, hasAiSection, fullReason? } (fullReason: why 整篇覆盖 is off), { askPage: true, url, video?, own? } (own false: 「附带 AI 问答」 is off, so 只写 AI 笔记 is not offered)
// or { path, kind: full | ai | unchanged | conversation, text, title }.
async function writeVideoNote({ ref: input, mode, conversation, page, pageChoice }) {
  const settings = await getMergedSettings();
  const vault = obsidianConfig(settings);
  let ref = MdgSites.contextRef(input);
  const builds = ref.site === "bilibili" && ref.pageIndex === 1;
  if (!page && !builds && (ref.isVideoContext ? ref.videoId : ref.url)) {
    const read = await tabNote(ref, pageChoice === "open");
    page = read?.page;
    // The part as the video page names it (cid, 分 P title, author): the same path and key as its own write.
    if (read?.ref) ref = MdgSites.contextRef(read.ref);
  }
  // A web page's key too (page:<url>), so its note is remembered like a video's.
  let key = MdgSites.buildContextKey(ref);
  const { aiConversations } = MdgLimits.KEYS;
  const extrasRef = { site: ref.site, videoId: key ? ref.videoId : "", pageIndex: ref.pageIndex, url: ref.url };
  const stored = await chrome.storage.local.get([aiConversations, ...MdgNote.triageExtrasKeys(extrasRef)]);
  const turns = MdgNote.buildConversationTurns(conversation ? conversation.messages : MdgNote.pickConversation(stored[aiConversations], ref)?.messages);
  const aiOn = settings.includeAiChatInNote;
  const section = aiOn ? MdgNote.buildAiSection(turns) : "";
  const paths = await notePaths();
  key = recordedNoteKey(paths, key, ref);
  const computedPath = () => paths[key]?.path || MdgNote.videoNotePath(ref, settings);

  // The conversation as its own note, linking the video note (sourcePath) when there is one.
  const standalone = (why, sourcePath) => {
    const extras = MdgNote.triageExtras(stored, extrasRef);
    const { analysis, note } = extras;
    if (!turns.length && !analysis && !note.trim()) throw new Error("没有可写入 Obsidian 的内容");
    const filename = MdgNote.buildAiConversationFilename(ref);
    const markdown = MdgNote.buildAiConversationMarkdown({ context: ref, turns, filename, sourcePath, extras });
    return { path: MdgNote.conversationNotePath(ref, settings), why, body: async () => ({ markdown: MdgNote.withTriageSummary(markdown, analysis, note) }) };
  };
  let target;
  let built = null;
  if (!key) {
    target = standalone("", "");
  } else if (page?.markdown) {
    target = { video: true, path: computedPath(), body: async () => ({ markdown: page.markdown, cover: { url: page.cover, name: `${ref.site}-${ref.videoId}` }, warning: String(page.warning || "") }) };
  } else if (ref.site === "bilibili" && ref.pageIndex === 1) {
    // Without the page only a B站 P1 note can be built (triageBuildNote). A recorded note that is only asked about or
    // gets its AI 问答 is not built; otherwise the API meta names the path ({{author}}, {{upload_date}}) and the cid the key.
    const build = async () => {
      built ||= await triageBuildNote(ref.videoId, settings);
      return { markdown: built.markdown, cover: built.cover, warning: built.subtitleWarning };
    };
    const recorded = paths[key] ? await readVaultNote(vault, paths[key].path) : null;
    if (recorded?.exists && mode !== "full") {
      target = { video: true, path: paths[key].path, note: recorded, body: build };
    } else {
      try {
        await build();
        if (!recorded) key = MdgSites.buildContextKey({ ...ref, cid: ref.cid || built.noteMeta.cid });
        target = { video: true, path: paths[key]?.path || built.path, ...(recorded && { note: recorded }), body: build };
      } catch (e) {
        // A deleted or hidden video has no note to build, recorded or not: a conversation the user writes goes in its
        // own note.
        if (!conversation || !aiOn || !MdgSites.isBiliVideoGone(e.code)) throw e;
        target = standalone("（视频已失效，只写了对话）", "");
      }
    }
  } else {
    // A recorded note without its page (YouTube, 分 P, a web page, no tab showing it): asked about like any other, but
    // only its AI 问答 can change. Without one it asks first (askPage); 只写 AI 笔记 makes the conversation its own note.
    const recorded = paths[key]?.path;
    const note = recorded ? await readVaultNote(vault, recorded) : null;
    const why = needsPage(ref);
    // 「附带 AI 问答」 off: the recorded note has nothing that can change without its page.
    if (note?.exists && !section) return { path: recorded, kind: "unchanged", text: aiSectionResult(recorded, false), title: ref.title };
    if (!note?.exists && (pageChoice !== "own" || !aiOn)) return { askPage: true, url: ref.isVideoContext ? MdgSites.videoUrl(ref) : ref.url, ...(ref.isVideoContext && { video: true }), ...(!aiOn && { own: false }) };
    target = note?.exists
      ? { video: true, path: recorded, note, fullReason: why, body: async () => { throw new Error(why); } }
      : ref.isVideoContext ? standalone(OWN_NOTE, computedPath()) : standalone("", "");
  }

  const { path } = target;
  // After body(): a recorded note is built only when it is written whole.
  const title = () => built?.meta.title || ref.title;
  const existing = target.note || (await readVaultNote(vault, path));
  if (existing.exists && !mode) {
    return { ask: true, path, ...(target.video && { hasAiSection: Boolean(section) }), ...(target.fullReason && { fullReason: target.fullReason }) };
  }
  if (target.video && existing.exists && mode === "ai") {
    // Only the AI 问答 section changes: the rest of the note, subtitle warning included, stays as written before.
    const { updated } = section ? await updateAiSectionInVault(vault, path, section, key, existing, ref.pageIndex) : { updated: false };
    return { path, kind: updated ? "ai" : "unchanged", text: aiSectionResult(path, updated), title: title() };
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
// Never creates a note. Resolves { path: "" } when there is nothing to do, else { path, exists, updated, text }: text,
// what the side panel shows (the note updated, or gone and left alone).
async function syncVideoNoteAi({ ref: input, conversation }) {
  const ref = MdgSites.contextRef(input);
  const key = MdgSites.buildContextKey(ref);
  const path = key ? (await notePaths())[key]?.path : "";
  const section = MdgNote.buildAiSection(MdgNote.buildConversationTurns(conversation?.messages));
  if (!path || !section) return { path: "" };
  const settings = await getMergedSettings();
  // Turned off is the user's choice; enabled but not set up fails as a manual write does.
  if (!settings.includeAiChatInNote || !settings.obsidianEnabled) return { path: "" };
  const done = await updateAiSectionInVault(obsidianConfig(settings), path, section, key);
  return { path, ...done, text: done.exists ? aiSectionResult(path, done.updated) : `Obsidian 里的${ref.isVideoContext ? "视频" : "网页"}笔记已不存在，未写入` };
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
