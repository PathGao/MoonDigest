// Every retention cap the extension enforces, in one place so the options page tells the user
// the same numbers the code applies. Loaded by the content script (manifest), background
// (importScripts) and every page. Idempotent like sites.js.
(() => {
  if (globalThis.BocLimits) {
    return;
  }

  const SUBTITLE_CACHE_ENTRIES = 50;
  const SUBTITLE_CACHE_DAYS = 30;
  const AI_CONVERSATIONS = 500;
  const AI_SUBTITLE_MAX_CHARS = 60000;
  const AI_HISTORY_MAX_CHARS = 40000;
  const TRIAGE_RECENT_UNFAV = 50;
  const TRIAGE_UNDO_STEPS = 20;

  // chrome.storage.local keys of the capped data, so usage can be counted where the caps are stated.
  const KEYS = Object.freeze({
    subtitleCachePrefix: "boc_subtitle_cache_",
    aiConversations: "boc_ai_conversations_v1",
    // videoKey → { path, lastSyncedAt } for notes the user saved; auto-sync only touches these.
    obsidianNotePaths: "boc_obsidian_note_paths_v1",
    triageResultPrefixes: ["triage_analysis_", "triage_title_"]
  });

  // Counts from a chrome.storage.local.get(null) snapshot, in the shape describe() takes.
  function storageUsage(all = {}) {
    const keys = Object.keys(all);
    return {
      subtitleCache: keys.filter((key) => key.startsWith(KEYS.subtitleCachePrefix)).length,
      aiConversations: Array.isArray(all[KEYS.aiConversations]) ? all[KEYS.aiConversations].length : 0,
      triageResults: keys.filter((key) => KEYS.triageResultPrefixes.some((prefix) => key.startsWith(prefix))).length
    };
  }

  const count = (value) => (value == null ? "–" : String(value));
  const chars = (value) => `${value.toLocaleString("en-US")} 字`;

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
        usage: `${count(usage.aiConversations)} / ${AI_CONVERSATIONS} 段`,
        rule: `超过 ${AI_CONVERSATIONS} 段自动删最旧的。在「视频记录」页按视频查看、下载或删除。`
      },
      {
        label: "AI 每次请求读的字幕",
        usage: `最多 ${chars(AI_SUBTITLE_MAX_CHARS)}`,
        rule: "更长的字幕按行均匀抽样，侧边栏会提示。"
      },
      {
        label: "AI 每次请求带的历史",
        usage: `最多 ${chars(AI_HISTORY_MAX_CHARS)}`,
        rule: "超出时丢掉最早的几轮，侧边栏会提示。"
      },
      {
        label: "分拣结果（粗分 + 细看）",
        usage: `${count(usage.triageResults)} 条`,
        rule: "不自动删。视频离开所有收藏夹后进分拣台的「已取消收藏」，在那里查看、导出和清理。"
      },
      {
        label: "分拣台最近取消收藏",
        usage: `最多 ${TRIAGE_RECENT_UNFAV} 条`,
        rule: "只列最近的，更早的不再显示。"
      },
      {
        label: "分拣台撤销",
        usage: `最多 ${TRIAGE_UNDO_STEPS} 步`,
        rule: "更早的操作不能撤销。"
      }
    ];
  }

  globalThis.BocLimits = Object.freeze({
    SUBTITLE_CACHE_ENTRIES,
    SUBTITLE_CACHE_DAYS,
    AI_CONVERSATIONS,
    AI_SUBTITLE_MAX_CHARS,
    AI_HISTORY_MAX_CHARS,
    TRIAGE_RECENT_UNFAV,
    TRIAGE_UNDO_STEPS,
    KEYS,
    storageUsage,
    describe
  });
})();
