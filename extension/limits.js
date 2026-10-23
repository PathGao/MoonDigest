// Every retention cap the extension enforces, in one place so the options page tells the user
// the same numbers the code applies, and the storage key names shared between files. Loaded by the
// content script (manifest), background (importScripts) and every page. Idempotent like sites.js.
(() => {
  if (globalThis.MdgLimits) {
    return;
  }

  const SUBTITLE_CACHE_ENTRIES = 50;
  const SUBTITLE_CACHE_DAYS = 30;
  const AI_CONVERSATIONS = 500;
  // 摘读记录's own tags (one list for videos and web pages).
  const READING_TAGS = 50;
  // 关注's UP 标签 (follow_tags), as many: 标签管理 and B站 pages' 「+ UP 标签」 make no more (MdgTagCore.upTagsFull).
  const UP_TAGS = 50;
  const AI_SUBTITLE_MAX_CHARS = 60000;
  const AI_HISTORY_MAX_CHARS = 40000;
  // Hot comments a note or the side panel's AI gets (fetchComments' default). 分拣台细看 reads TriageUi.DEEP_COMMENTS.
  const HOT_COMMENTS = 20;
  const TRIAGE_RECENT_UNFAV = 50;
  const TRIAGE_UNDO_STEPS = 20;
  // 观看进度 (triage-bg.js): B站 history read at most every SEEN_GAP_MS; seen_<bvid> kept SEEN_KEEP_DAYS, at most SEEN_MAX.
  const SEEN_GAP_MS = 10 * 60 * 1000;
  const SEEN_KEEP_DAYS = 365;
  const SEEN_MAX = 5000;
  // The same caps in words: the 数据与存储 row and the 观看进度 hint on the options page.
  const SEEN_LIMITS_TEXT = `最多 ${SEEN_GAP_MS / 60000} 分钟一次，留最近 ${SEEN_KEEP_DAYS % 365 ? `${SEEN_KEEP_DAYS} 天` : `${SEEN_KEEP_DAYS / 365} 年`}、最多 ${SEEN_MAX} 个`;

  // chrome.storage key names more than one file uses (local unless marked sync), written only here; storageUsage counts
  // the capped ones.
  // Never change a value: the user's data is stored under it (the one rename, in 3.6, ships with migrateRenamedKeys below). A key built at run time has a function beside its prefix.
  // limits.selftest.js fails when a name here is written in another file.
  const ANALYSIS = "triage_analysis_";
  const TITLE = "triage_title_";
  const SNAPSHOT = "triage_snapshot_";
  const SEEN = "seen_";
  const DECISIONS = "triage_decisions_";
  const FOLLOW = "follow_";
  const KEYS = Object.freeze({
    subtitleCachePrefix: "mdg_subtitle_cache_",
    aiConversations: "mdg_ai_conversations_v1",
    // videoKey → { path, lastSyncedAt, pageIndex? } for notes the user saved; auto-sync only touches these.
    obsidianNotePaths: "mdg_obsidian_note_paths_v1",
    // The side panel's request slot: the player button, popup, 分拣台 and 摘读记录 ask it to open a video's AI chat.
    playerAiQuickAction: "mdg_player_ai_quick_action_v1",
    triageAnalysisPrefix: ANALYSIS,
    triageAnalysis: (bvid) => `${ANALYSIS}${bvid}`,
    triageTitlePrefix: TITLE,
    triageTitle: (bvid) => `${TITLE}${bvid}`,
    triageSnapshotPrefix: SNAPSHOT,
    triageSnapshot: (mediaId) => `${SNAPSHOT}${mediaId}`,
    triageRemoved: "triage_removed",
    // 分拣台's 取消收藏 records per folder, and 保留 (one list for every folder): the B站 pages show them too.
    triageDecisionsPrefix: DECISIONS,
    triageDecisions: (mediaId) => `${DECISIONS}${mediaId}`,
    triageKept: "triage_kept",
    // { [bvid]: { text, updatedAt } }: the side panel, 分拣台, 摘读记录 and note export share it.
    triageNotes: "triage_notes",
    triageTags: "triage_tags",
    triageVideoTags: "triage_video_tags",
    triageBasket: "triage_basket",
    // 摘读记录's 星标 and tags: { tags: [{ id, name, color, rule }], items: { [record key]: { star, tags, ref, updatedAt } } }.
    // The record key is MdgNote.readingKey; ref keeps the title and address, so a record stays after its conversations go.
    readingMarks: "mdg_reading_marks_v1",
    // 摘读记录's ✦ AI 打标签 instructions, newest first (TriageUi.aiHistoryAdd).
    readingAiHistory: "mdg_reading_ai_history_v1",
    // 摘读记录's own ✦ AI 打标签 settings (sync), as 关注's follow_ai_settings: { batchSize, intervalSec, newTagMax, allowRemove }.
    readingAiSettings: "mdg_reading_ai_settings_v1",
    // Its proposal waiting for 应用 (TriageUi.mergeAiBatch's shape) and 「AI 刚打的」 ({ at, keys }: the records the last 应用
    // changed), as 关注's follow_ai_proposal and follow_ai_recent.
    readingAiProposal: "mdg_reading_ai_proposal_v1",
    readingAiRecent: "mdg_reading_ai_recent_v1",
    triageSeenMeta: "triage_seen_meta",
    // The 分拣台's folder choice and 判断标准: settings kept in local, carried by the settings file.
    triageIncludedFolders: "triage_included_folders",
    triageFolderCriteria: "triage_folder_criteria",
    // 关注 (follow-bg.js writes most of them; the 分拣台, the B站 page's UP tags and the 分拣台 backup read them): follow_<name>
    // for list, people, last, last_wip, content, tags, tag_map, unfollowed, jobs, hold, stats, groups, ai_recent, ai_proposal,
    // ai_history, view (local) and ai_settings (sync). Code names them by the short name; followGet / followFull /
    // followShort convert.
    followPrefix: FOLLOW,
    follow: (name) => `${FOLLOW}${name}`,
    // The AI platforms (chrome.storage.sync, without keys): the background writes them, the video page and side panel follow.
    aiProviderList: "aiProviders",
    // The AI platforms' API keys (local, never in sync or the settings file): the background, the side panel follows it.
    aiApiKeys: "aiProviderKeys",
    // 观看进度: seen_<bvid> → [percent, view_at s], written by the background's history read.
    seenPrefix: SEEN,
    seen: (bvid) => `${SEEN}${bvid}`,
    // The AI platform picked at the top of the side panel, in the extension pages' localStorage (not chrome.storage):
    // the side panel writes it, the 分拣台 sends it with every request.
    aiSelectedProvider: "mdg_ai_selected_provider"
  });

  // 3.6 renamed every boc_* key (local, session and the extension pages' localStorage) to mdg_*. Old name → new name, or "".
  const OLD_PREFIX = "boc_";
  const renamedKey = (key) => (key.startsWith(OLD_PREFIX) ? `mdg_${key.slice(OLD_PREFIX.length)}` : "");

  // Every key of a chrome.storage area: getKeys is Chrome 130+, the manifest sets no minimum, so older ones read it all.
  const storageKeys = async (area) => (await area.getKeys?.()) ?? Object.keys((await area.get(null)) || {});

  // Moves each old key to its new name, one key at a time: copy only when the new key is absent (newer data wins),
  // remove the old key only after the copy is written. A failed write leaves the old key for the next run. Idempotent.
  async function migrateRenamedKeys(area) {
    const keys = await storageKeys(area);
    const present = new Set(keys);
    for (const old of keys.filter(renamedKey)) {
      try {
        if (!present.has(renamedKey(old))) {
          const value = (await area.get(old))[old];
          if (value !== undefined) await area.set({ [renamedKey(old)]: value });
        }
        await area.remove(old);
      } catch (error) {
        console.warn("[MDG] storage key not migrated", old, error);
      }
    }
  }

  // The same for a page's localStorage (Storage API), run before the page's first read.
  function migrateRenamedLocalStorage(ls) {
    const keys = Array.from({ length: ls.length }, (_, i) => ls.key(i));
    for (const old of keys.filter(renamedKey)) {
      try {
        if (ls.getItem(renamedKey(old)) === null) ls.setItem(renamedKey(old), ls.getItem(old));
        ls.removeItem(old);
      } catch (error) {
        console.warn("[MDG] localStorage key not migrated", old, error);
      }
    }
  }

  // Runs fn alone under name: one at a time across the extension's pages and the background (one origin, so one Web Lock),
  // in call order within a page. Two read-modify-writes of a key would otherwise read the same value and the later write
  // drop the other's change.
  const lockQueues = new Map();
  function locked(name, fn) {
    const once = () => (globalThis.navigator?.locks ? navigator.locks.request(name, fn) : fn());
    const done = (lockQueues.get(name) || Promise.resolve()).then(once);
    lockQueues.set(name, done.catch(() => {}));
    return done;
  }
  const keyLock = (key) => `mdg-key:${key}`;
  // A chrome.storage.local key changed by read-modify-write under its lock: edit(the stored value) returns the value to
  // write, or undefined to write nothing. Resolves what edit returned. 关注's keys go through updateFollow, whose one
  // lock covers all of them.
  function update(key, edit) {
    return locked(keyLock(key), async () => {
      const next = await edit((await chrome.storage.local.get(key))[key]);
      if (next !== undefined) await chrome.storage.local.set({ [key]: next });
      return next;
    });
  }

  // One 视频备注 saved by read-modify-write (the side panel, 摘读记录 and 分拣台): a fresh read, only this entry changed,
  // written back, so a note another page saved meanwhile is kept. Blank text deletes it; the stored text writes nothing.
  // set writes the whole map (the 分拣台 passes its own, to know the echo). Resolves true when it wrote.
  function saveVideoNote(id, text, set = (notes) => chrome.storage.local.set({ [KEYS.triageNotes]: notes })) {
    return locked(keyLock(KEYS.triageNotes), async () => {
      const notes = { ...(await chrome.storage.local.get(KEYS.triageNotes))[KEYS.triageNotes] };
      const next = String(text ?? "").trim() ? String(text) : "";
      if ((notes[id]?.text || "") === next) return false;
      if (next) notes[id] = { text: next, updatedAt: Date.now() };
      else delete notes[id];
      await set(notes);
      return true;
    });
  }

  // The AI conversation list (KEYS.aiConversations) changed by read-modify-write, one change at a time across pages like
  // saveVideoNote: the side panel and 摘读记录 both write it, and a whole list written from an older read would bring back
  // what the other deleted. edit(stored list) returns the list to write.
  // A 摘读记录 record's key (KEYS.readingMarks) from a context key (MdgSites.buildContextKey): a video's without its cid,
  // so every part shares it, as 备注 do; a web page's as it is.
  const readingKeyOf = (contextKey) => {
    const key = String(contextKey || "");
    return key.startsWith("video:") ? key.replace(/\|[^|]*$/, "|") : key;
  };
  // Whether a conversation belongs to a record with a 星标 in 摘读记录's marks; such conversations are not counted
  // against AI_CONVERSATIONS by the cap, 摘读记录 or the options page.
  const starredConv = (marks) => {
    const starred = new Set(Object.entries(marks?.items || {}).filter(([, item]) => item?.star).map(([key]) => key));
    return (c) => starred.has(readingKeyOf(c?.contextKey));
  };
  // { counted, starred }: what 摘读记录 and the options page show as「counted / AI_CONVERSATIONS，星标 starred 段不计」.
  function conversationCounts(list, marks) {
    const isStarred = starredConv(marks);
    const starred = (Array.isArray(list) ? list : []).filter(isStarred).length;
    return { counted: (Array.isArray(list) ? list.length : 0) - starred, starred };
  }
  // The cap is applied here, the one writer: AI_CONVERSATIONS counts only conversations of records without a 星标,
  // newest kept; a starred record keeps all of its.
  function capConversations(list, marks) {
    const isStarred = starredConv(marks);
    let room = AI_CONVERSATIONS;
    return [...list].sort((a, b) => (b?.updatedAt || 0) - (a?.updatedAt || 0)).filter((c) => isStarred(c) || room-- > 0);
  }

  // 观看进度 entries that SEEN_MAX does not count and are never pruned: videos in a ticked 收藏夹. `got` holds
  // KEYS.triageIncludedFolders and those folders' snapshots (a get(null) snapshot works too).
  const seenExempt = (got) =>
    new Set((got?.[KEYS.triageIncludedFolders] || []).flatMap((id) => got[KEYS.triageSnapshot(id)]?.bvids || []));
  function updateConversations(edit) {
    return locked(keyLock(KEYS.aiConversations), async () => {
      const got = await chrome.storage.local.get([KEYS.aiConversations, KEYS.readingMarks]);
      const list = got[KEYS.aiConversations];
      await chrome.storage.local.set({ [KEYS.aiConversations]: capConversations(edit(Array.isArray(list) ? list : []), got[KEYS.readingMarks]) });
    });
  }

  // 摘读记录's marks (KEYS.readingMarks) changed by read-modify-write, one change at a time across pages like
  // updateConversations. edit({ tags, items }) returns the marks to write. Resolves the marks written.
  function updateReadingMarks(edit) {
    return update(KEYS.readingMarks, (stored) => edit({ tags: Array.isArray(stored?.tags) ? stored.tags : [], items: { ...stored?.items } }));
  }

  // Asks the side panel to open a video's AI chat (KEYS.playerAiQuickAction): the one shape every sender writes (the
  // player ✦ and popup via the background, 分拣台 and 摘读记录). The side panel drops a request older than 15 s by createdAt.
  function askSidepanel({ tabId, prompt = "", contextRef = null, frameId = 0 }) {
    const createdAt = Date.now();
    const request = { id: `ai-${createdAt}-${Math.random().toString(36).slice(2, 8)}`, tabId: Number(tabId) || 0, prompt, createdAt };
    if (contextRef) Object.assign(request, { contextRef, frameId: Number(frameId) || 0 });
    return chrome.storage.local.set({ [KEYS.playerAiQuickAction]: request });
  }

  // 关注's keys by short name: followFull({ list: v }) is { follow_list: v }; followShort is the reverse and keeps only
  // follow_* keys (a storage.onChanged changes object or a get(null) snapshot works too).
  const followFull = (o) => Object.fromEntries(Object.entries(o || {}).map(([k, v]) => [KEYS.follow(k), v]));
  const followShort = (o) => Object.fromEntries(Object.entries(o || {}).filter(([k]) => k.startsWith(FOLLOW)).map(([k, v]) => [k.slice(FOLLOW.length), v]));
  // followGet(["list", "tags"]) reads follow_list and follow_tags as { list, tags }.
  const followGet = async (names, area = chrome.storage.local) => followShort(await area.get(names.map(KEYS.follow)));
  // 关注's keys changed by read-modify-write, one change at a time across the 分拣台 and the background, like
  // updateReadingMarks: fn(the stored values by short name) returns a patch by short name (a key set to undefined is
  // removed) or nothing. B站 pages are another origin, outside the lock: badges.js sends its writes to the background
  // (follow-up-tag). set writes the patch (the 分拣台 passes its own, which toasts a failure). Resolves the patch.
  function updateFollow(names, fn, set = (o) => chrome.storage.local.set(o)) {
    return locked("mdg-follow", async () => {
      const patch = await fn(await followGet(names));
      if (patch) {
        const full = followFull(patch);
        const put = Object.fromEntries(Object.entries(full).filter(([, v]) => v !== undefined));
        const gone = Object.keys(full).filter((k) => full[k] === undefined);
        if (Object.keys(put).length) await set(put);
        if (gone.length) await chrome.storage.local.remove(gone);
      }
      return patch;
    });
  }

  // Approximate stored size: JSON length of key + value, as chrome.storage counts it (characters, not UTF-8 bytes).
  const sizeOf = (entries) => entries.reduce((sum, [key, value]) => sum + key.length + JSON.stringify(value ?? null).length, 0);

  // Counts from a chrome.storage.local.get(null) snapshot, in the shape describe() takes.
  function storageUsage(all = {}) {
    const keys = Object.keys(all);
    const snapshots = Object.entries(all).filter(([key]) => key.startsWith(KEYS.triageSnapshotPrefix));
    const conversations = conversationCounts(all[KEYS.aiConversations], all[KEYS.readingMarks]);
    const exempt = seenExempt(all);
    const seen = keys.filter((key) => key.startsWith(SEEN));
    const seenExemptCount = seen.filter((key) => exempt.has(key.slice(SEEN.length))).length;
    return {
      subtitleCache: keys.filter((key) => key.startsWith(KEYS.subtitleCachePrefix)).length,
      aiConversations: conversations.counted,
      aiConversationsStarred: conversations.starred,
      triageResults: keys.filter((key) => key.startsWith(ANALYSIS) || key.startsWith(TITLE)).length,
      folderSnapshots: snapshots.length,
      folderSnapshotSize: sizeOf(snapshots),
      triageRemoved: Object.keys(all[KEYS.triageRemoved] || {}).length,
      triageNotes: Object.keys(all[KEYS.triageNotes] || {}).length,
      seen: seen.length - seenExemptCount,
      seenExempt: seenExemptCount,
      totalSize: sizeOf(Object.entries(all))
    };
  }

  // Long videos overflow small context windows. Even sampling keeps every part of the video and each kept line's timestamp.
  // Shared by the side panel and 分拣台细看. ponytail: samples by line count, assumes similar line lengths; the final slice is the hard cap.
  function sampleAiSubtitle(markdown) {
    const text = String(markdown || "");
    if (text.length <= AI_SUBTITLE_MAX_CHARS) {
      return { text, step: 1 };
    }
    const step = Math.ceil(text.length / AI_SUBTITLE_MAX_CHARS);
    let index = 0;
    const sampled = text
      .split("\n")
      .filter((line) => /^#|^\s*$/.test(line) || index++ % step === 0)
      .join("\n")
      .slice(0, AI_SUBTITLE_MAX_CHARS);
    return { text: sampled, step };
  }

  const count = (value) => (value == null ? "–" : String(value));
  const chars = (value) => `${value.toLocaleString("en-US")} 字`;
  const size = (value) => {
    if (value == null) return "–";
    if (value < 1024 * 1024) return `${value && Math.max(1, Math.round(value / 1024))} KB`;
    return `${(value / 1024 / 1024).toFixed(1)} MB`;
  };

  // Rows for the options page "数据与存储" section. usage carries the counts read from storage;
  // a missing count renders as "–".
  function describe(usage = {}) {
    return [
      {
        label: "字幕缓存",
        usage: `${count(usage.subtitleCache)} / ${SUBTITLE_CACHE_ENTRIES} 条`,
        rule: `只留最近 ${SUBTITLE_CACHE_DAYS} 天内最新的 ${SUBTITLE_CACHE_ENTRIES} 条，多出来的自动删最旧的。`
      },
      {
        label: "AI 对话",
        usage: `${count(usage.aiConversations)} / ${AI_CONVERSATIONS} 段${usage.aiConversationsStarred ? `，星标 ${usage.aiConversationsStarred} 段不计` : ""}`,
        rule: `超过 ${AI_CONVERSATIONS} 段自动删最旧的，加了星标的记录的对话不算在内、不删。在「摘读记录」页按视频和网页查看、下载或删除。`
      },
      {
        label: "AI 每次请求读的字幕或网页正文",
        usage: `最多 ${chars(AI_SUBTITLE_MAX_CHARS)}`,
        rule: "侧边栏和分拣台细看都按这个上限读。更长的字幕或网页正文按行均匀抽取，侧边栏会提示。"
      },
      {
        label: "AI 每次请求带的历史",
        usage: `最多 ${chars(AI_HISTORY_MAX_CHARS)}`,
        rule: "超出时丢掉最早的几轮，侧边栏会提示。"
      },
      {
        label: "分拣结果（粗看 + 细看）",
        usage: `${count(usage.triageResults)} 条`,
        rule: "不自动删。视频离开你勾选的所有收藏夹后进分拣台的「已出分拣范围」，在那里查看、导出和清理。"
      },
      {
        label: "收藏夹快照",
        usage: `${count(usage.folderSnapshots)} 个收藏夹，约 ${size(usage.folderSnapshotSize)}`,
        rule: "每次刷新自动更新，取消勾选或在 B站删掉的收藏夹会被移除。"
      },
      {
        label: MdgErrors.LABEL.removed,
        usage: `${count(usage.triageRemoved)} 个视频`,
        rule: "收藏夹里离开分拣范围的视频，不含关注的 UP 主。不自动删。在分拣台的「已出分拣范围」里查看、导出和清理。"
      },
      {
        label: "备注",
        usage: `${count(usage.triageNotes)} 条`,
        rule: "不自动删。在侧边栏、分拣台或摘读记录页里修改。"
      },
      {
        label: MdgErrors.LABEL.seen,
        usage: `${count(usage.seen)} / ${SEEN_MAX} 个视频${usage.seenExempt ? `，勾选收藏夹里的 ${usage.seenExempt} 个不计` : ""}`,
        rule: `「封面显示」不是「关」时读 B站历史记录，${SEEN_LIMITS_TEXT}，勾选收藏夹里的视频不算在内、不删。选「关」时全部删掉。`
      },
      {
        label: "本地数据合计",
        usage: `约 ${size(usage.totalSize)}`,
        rule: "这些数据和其他记录都存在这台电脑的浏览器里。设置存在 Chrome 的同步存储里，不算在内。"
      }
    ];
  }

  globalThis.MdgLimits = Object.freeze({
    SUBTITLE_CACHE_ENTRIES,
    SUBTITLE_CACHE_DAYS,
    AI_CONVERSATIONS,
    READING_TAGS,
    UP_TAGS,
    AI_SUBTITLE_MAX_CHARS,
    AI_HISTORY_MAX_CHARS,
    HOT_COMMENTS,
    TRIAGE_RECENT_UNFAV,
    TRIAGE_UNDO_STEPS,
    SEEN_GAP_MS,
    SEEN_KEEP_DAYS,
    SEEN_MAX,
    SEEN_LIMITS_TEXT,
    KEYS,
    storageUsage,
    describe,
    sampleAiSubtitle,
    migrateRenamedKeys,
    storageKeys,
    migrateRenamedLocalStorage,
    locked,
    update,
    saveVideoNote,
    updateConversations,
    capConversations,
    conversationCounts,
    seenExempt,
    readingKeyOf,
    updateReadingMarks,
    askSidepanel,
    followFull,
    followShort,
    followGet,
    updateFollow
  });
})();
