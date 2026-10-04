// Static-server preview only: load the fake chrome.* before anything reads it. Never fetched inside the extension.
if (!globalThis.chrome?.runtime?.id) await import("./dev/mock-chrome.js");

// ---------- constants ----------
const THROTTLE_MS = globalThis.__TRIAGE_THROTTLE_MS || 10 * 60 * 1000;
// Error code -> [backoff ms, status label]. AI 429s clear far sooner than B站 risk control.
const THROTTLES = { THROTTLED: [THROTTLE_MS, "B站限流"], AI_THROTTLED: [60 * 1000, "AI 平台限流"] };
const GROUP_SIZE = 8;
const SELECT_CAP = 10;
const SYNC_MIN_GAP_MS = 60 * 1000;
// Catppuccin Latte accents (desaturated); chips keep --text on top, so these are only borders and tints.
// Mauve, blue, green, red and yellow are left out: they mean where-you-are, next step, keep, delete and pending.
const TAG_COLORS = ["#da86c3", "#298287", "#dc6d2d", "#3590a0", "#8595ea", "#cf5c66", "#2497c6", "#cf8686", "#ce9386"];
// Progress tabs in pipeline order; 阅览 sits apart after them.
const STAGES = [
  ["none", "未分析"],
  ["deep", "待细看"],
  ["act", "待处理"],
  ["done", "已处理"]
];
const STAGE_EMPTY = { none: "已全部粗分，下一步：细看", deep: "没有要细看的了，下一步：处理", act: "都处理完了，去看已处理" };
const K = {
  lastFolder: "triage_last_folder",
  schemes: "triage_schemes",
  folderScheme: "triage_folder_scheme", // { [mediaId]: schemeId }, missing = default
  schemesMigrated: "triage_schemes_migrated",
  videoTags: "triage_video_tags",
  basket: "triage_basket",
  notes: "triage_notes", // { [bvid]: { text, updatedAt } }, shared with the history page and note export
  decisions: (id) => `triage_decisions_${id}`,
  snapshot: (id) => `triage_snapshot_${id}`,
  aiHistory: "triage_ai_command_history",
  override: (bvid) => `triage_verdict_override_${bvid}`
};
const OVERRIDE_PREFIX = "triage_verdict_override_";
// A tier's route is all the pipeline reads: keep / unfav go to 待处理, deep to 待细看.
// The default ids keep/drop/unsure are the verdicts stored before schemes existed.
const DEFAULT_TIERS = [
  { id: "keep", name: "留", description: "有具体、可复用的知识、方法或数据。", route: "keep" },
  { id: "drop", name: "可以删", description: "标题党、空谈、纯娱乐、过时新闻，或内容主要是广告。", route: "unfav" },
  { id: "unsure", name: "待定", description: "其他情况，或信息太少无法判断。", route: "deep" }
];
const ROUTES = [["keep", "保留"], ["unfav", "取消收藏"], ["deep", "要细看"]];
const ROUTE_CLASS = { keep: "keep", unfav: "drop", deep: "unsure" };
// Seeded as schemes for anyone who never saved tag presets (the old page created these two).
const BUILTIN_PRESETS = [
  {
    id: "preset-topic",
    name: "学习主题",
    tags: [
      { name: "AI工程", description: "大模型、Agent、RAG、AI 编程等技术实践" },
      { name: "产品设计", description: "产品思路、交互设计、用户研究" },
      { name: "创业商业", description: "创业经验、商业模式、行业分析" },
      { name: "个人成长", description: "学习方法、效率、职业发展" },
      { name: "娱乐放松", description: "搞笑、闲聊、纯娱乐内容" }
    ]
  },
  {
    id: "preset-priority",
    name: "处理优先级",
    tags: [
      { name: "马上看", description: "和我当前工作直接相关，这周就要用" },
      { name: "有空看", description: "有价值但不急" },
      { name: "存档参考", description: "以后查资料时有用，不必现在看" },
      { name: "可以删", description: "过时、重复或价值低" }
    ]
  }
];

const defaultScheme = (patch = {}) => ({ id: "default", name: "默认方案", criteria: "", tags: [], onlyMyTags: false, grading: { tiers: structuredClone(DEFAULT_TIERS) }, ...patch });

// One-time move of the global criteria, tags, 只用我的标签 and tag presets into schemes (pure; the caller sets the flag).
// The default scheme keeps the old tag ids, so triage_video_tags needs no change; preset tag ids are derived, so two tabs migrating at once agree.
function migrateSchemes({ tags, presets, criteria, ownTagsOnly }) {
  const fromPresets = (Array.isArray(presets) ? presets : BUILTIN_PRESETS).map((p, i) => ({
    ...defaultScheme(),
    id: `s-${p.id || i}`,
    name: String(p.name || `方案 ${i + 2}`),
    tags: (p.tags || []).map((t, j) => ({ id: `${p.id || i}-t${j}`, name: t.name, description: t.description || "", color: TAG_COLORS[j % TAG_COLORS.length] }))
  }));
  return [defaultScheme({ criteria: String(criteria || ""), tags: Array.isArray(tags) ? tags : [], onlyMyTags: ownTagsOnly === true }), ...fromPresets];
}

// ---------- state ----------
const S = {
  folders: [],
  mediaId: "",
  folderToken: 0,
  items: [],
  itemMap: new Map(),
  titleRes: {},
  analyses: {},
  decisions: {},
  schemes: [defaultScheme()],
  folderScheme: {},
  videoTags: {},
  basket: [],
  notes: {},
  noteOpen: new Set(), // empty notes the user opened for editing
  settings: {
    triageIntervalSec: 8,
    triageExportFolder: "raw/01-articles",
    triageTitleBatchSize: 30,
    triageThinking: false,
    triageTitleMaxTokens: 0,
    triageAnalyzeMaxTokens: 0,
    deepseek: false
  },
  tab: "none",
  readStage: "all",
  actFilter: "all",
  tagFilter: new Set(),
  focused: "",
  focusIndex: 0,
  selected: new Set(),
  group: null, // the running 细看 batch: { bvids: [], stop: bool }
  write: { running: false, stop: false },
  stage1: { running: false, stop: false, done: 0, total: 0 },
  stage1Skip: new Set(),
  analyzing: new Set(),
  throttleUntil: 0,
  throttleLabel: "",
  status: "",
  undo: [],
  lastSyncAt: 0,
  syncing: false,
  overrides: {}, // bvid -> { verdict, reason, by, at }
  aiHistory: [],
  ai: { running: false, stop: false, proposal: null },
  extra: "", // 临时补充 being typed; only the next 粗分/细看 run gets it
  extraOpen: false,
  runExtra: "" // what the running batch was started with
};

// The open folder's scheme; S.tags reads and writes its tags so the tag code needs no scheme plumbing.
const scheme = () => S.schemes.find((x) => x.id === S.folderScheme[S.mediaId]) || S.schemes.find((x) => x.id === "default") || S.schemes[0];
Object.defineProperty(S, "tags", { get: () => scheme().tags, set: (v) => (scheme().tags = v) });
const tiers = () => scheme().grading?.tiers || null;
const tierOf = (id) => tiers()?.find((x) => x.id === id);

const $ = (id) => document.getElementById(id);
const el = {};
[
  "folderSelect", "refreshBtn", "progress", "queueStatus", "settingsBtn", "helpBtn",
  "banner", "bannerText", "bannerBtn", "bannerClose", "syncNotice", "syncText", "syncViewBtn", "syncCloseBtn", "syncDetail",
  "tabs", "tagFilter", "manageTagsBtn", "listHeader", "list", "basket", "basketToggle", "basketCount",
  "basketList", "copyMdBtn", "downloadMdBtn", "exportBtn", "toast", "settingsDialog", "thinkingRow", "intervalInput",
  "batchSizeInput", "exportFolderInput", "openOptionsBtn", "thinkingInput", "titleMaxInput",
  "titleMaxHint", "analyzeMaxInput", "analyzeMaxHint", "settingsError", "backupBtn", "csvBtn", "cleanCacheBtn", "confirmDialog",
  "confirmTitle", "confirmBody", "confirmOk", "pickerDialog", "pickerTitle", "pickerInput", "pickerList",
  "schemeSelect", "schemeDialog", "schemeName", "schemeCriteria", "schemeTagsHead", "gradingInput", "tierRows", "addTierBtn", "deleteSchemeBtn",
  "tagsRows", "newTagInput", "addTagBtn", "ownTagsInput", "helpDialog",
  "aiBtn", "aiDialog", "aiForm", "aiScope", "aiScopeCount", "aiInstruction", "aiHistory",
  "aiTagsLabel", "aiTagsPreview", "aiTagRule", "aiAllowVerdict", "aiAllowVerdictRow", "aiProgress", "aiCloseBtn", "aiStopBtn", "aiRunBtn",
  "aiReview", "aiReviewSummary", "aiNotes", "aiNewTags", "aiAllBtn", "aiNoneBtn", "aiRows", "aiDiscardBtn", "aiApplyBtn",
  "writeBtn", "writeDialog", "writeScope", "writeScopeCount", "writeOverwrite", "writeProgress", "writeFailed", "writeStopBtn", "writeRunBtn", "writeMdBtn"
].forEach((id) => (el[id] = $(id)));

// ---------- utils ----------
function send(msg) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (resp) => {
        const err = chrome.runtime.lastError;
        if (err) resolve({ ok: false, error: err.message });
        else resolve(resp || { ok: false, error: "后台无响应" });
      });
    } catch (e) {
      resolve({ ok: false, error: e?.message || String(e) });
    }
  });
}

async function storeGet(key, fallback) {
  const r = await chrome.storage.local.get(key);
  return r?.[key] ?? fallback;
}
let storeFailShown = false;
function storeSet(key, value) {
  return chrome.storage.local.set({ [key]: value }).catch((e) => {
    console.error("[triage] storage write failed", key, e);
    if (storeFailShown) return;
    storeFailShown = true;
    toast(`保存失败，本地存储可能已满：${e?.message || e}`, true);
  });
}

function esc(v) {
  return String(v ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const pad = (n) => String(n).padStart(2, "0");
function fmtDuration(sec) {
  sec = Math.max(0, Number(sec) || 0);
  return `${pad(Math.floor(sec / 60))}:${pad(Math.floor(sec % 60))}`;
}
function stamp(d = new Date(), withTime = true) {
  const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return withTime ? `${day}-${pad(d.getHours())}${pad(d.getMinutes())}` : day;
}
function fmtTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  return `${stamp(d, false)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
const videoUrl = (bvid) => `https://www.bilibili.com/video/${bvid}`;
const stripNew = (name) => String(name).replace(/^新[:：]\s*/, "").trim();

// Waits ms, returning early when keepGoing() turns false.
async function sleepWhile(ms, keepGoing) {
  const end = Date.now() + ms;
  while (Date.now() < end && keepGoing()) {
    await new Promise((r) => setTimeout(r, Math.min(200, end - Date.now())));
  }
}

function openTab(url) {
  chrome.tabs.create({ url });
}

let ownTabId;
// Opens the side panel on this tab with the video as its context; the panel takes the request
// the same way as the player's AI 总结 button.
function askAi(it) {
  const contextRef = { site: "bilibili", videoId: it.bvid, title: it.title, author: it.upper, url: videoUrl(it.bvid) };
  chrome.storage.local.set({ boc_player_ai_quick_action_v1: { id: `triage-${Date.now()}`, tabId: ownTabId, prompt: "", contextRef } });
  chrome.sidePanel.open({ tabId: ownTabId }).catch((err) => toast(`打开侧边栏失败：${err.message}`, true));
}

let toastTimer = 0;
let noteTimer = 0;
function toast(text, error = false) {
  el.toast.textContent = text;
  el.toast.classList.toggle("error", error);
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.toast.hidden = true), 6000);
}

function askConfirm(title, bodyHtml, okText) {
  el.confirmTitle.textContent = title;
  el.confirmBody.innerHTML = bodyHtml;
  el.confirmOk.textContent = okText;
  el.confirmOk.setAttribute("aria-label", okText);
  el.confirmDialog.returnValue = "";
  el.confirmDialog.showModal();
  return new Promise((resolve) => {
    el.confirmDialog.addEventListener("close", () => resolve(el.confirmDialog.returnValue === "ok"), { once: true });
  });
}

function showBanner(text, btnText, onClick) {
  el.bannerText.textContent = text;
  el.bannerBtn.textContent = btnText;
  el.bannerBtn.setAttribute("aria-label", btnText);
  el.bannerBtn.onclick = onClick;
  el.banner.hidden = false;
}

function handleAiError(error) {
  const text = String(error || "AI 调用失败");
  const origin = /未授权访问 (https?:\/\/[^\s，]+)/.exec(text)?.[1];
  if (origin) {
    // The click is the user gesture permissions.request needs; the service worker cannot ask.
    showBanner(text, `授权访问 ${origin}`, async () => {
      if (await chrome.permissions.request({ origins: [`${origin}/*`] }).catch(() => false)) {
        el.banner.hidden = true;
        toast("已授权，请重试");
      }
    });
  } else if (text.includes("配置 AI")) {
    showBanner(`还没有可用的 AI 服务：${text}`, "去配置", () => send({ type: "open-options" }));
  } else if (text.includes("截断")) {
    showBanner(`${text}。建议调大输出上限或关闭思考`, "打开分拣设置", () => openSettings(true));
  } else toast(text, true);
}

// ---------- derived ----------
const tagById = (id) => S.tags.find((t) => t.id === id);
// Tags of other schemes stay on the video and show gray; filters and AI use only the current scheme's.
const anyTagById = (id) => tagById(id) || S.schemes.flatMap((x) => x.tags).find((t) => t.id === id);
const tagIdsOf = (bvid) => (S.videoTags[bvid] || []).filter((id) => tagById(id));
// Only 取消收藏 / 保留 finish a video; tags and notes never do.
const isProcessed = (bvid) => Boolean(S.decisions[bvid]);

// verdict is a tier id of the current scheme, "" for no tier, or "none" before 粗分.
// A 粗分 tier the scheme doesn't have (another scheme's, or a deleted tier) counts as not classified, so 粗分 can run again.
function verdictOf(it) {
  const a = S.analyses[it.bvid];
  const failed = a?.status === "error" ? a.error || "分析失败" : "";
  const graded = Boolean(tiers());
  const known = (v) => !graded || !v || Boolean(tierOf(v));
  if (it.invalid) return { verdict: tiers()?.find((x) => x.route === "unfav")?.id || "", reason: "视频已失效", stage: 0, failed: "" };
  const o = S.overrides[it.bvid];
  if (o && graded && tierOf(o.verdict)) return { verdict: o.verdict, reason: o.reason, stage: 3, failed: "" };
  if (a?.status === "done") return { verdict: graded && tierOf(a.verdict) ? a.verdict : "", reason: a.reason, stage: 2, failed: "" };
  const t = S.titleRes[it.bvid];
  if (t && known(t.verdict)) return { verdict: graded ? t.verdict || "" : "", reason: t.reason, stage: 1, low: t.confidence === "low", failed };
  return { verdict: "none", reason: "", stage: -1, failed };
}

function suggestionsOf(bvid) {
  const a = S.analyses[bvid];
  const list = (a?.status === "done" && a.suggestedTags) || S.titleRes[bvid]?.suggestedTags || [];
  const have = new Set(tagIdsOf(bvid).map((id) => tagById(id).name));
  // Results cached before 只用我的标签 was turned on may still carry 新: names.
  const own = scheme().onlyMyTags;
  return [...new Set(list)].filter((n) => stripNew(n) && !have.has(stripNew(n)) && !(own && n !== stripNew(n)));
}

function passTagFilter(bvid) {
  return S.tagFilter.size === 0 || tagIdsOf(bvid).some((id) => S.tagFilter.has(id));
}

// The tier's route decides: 要细看 or low confidence → 待细看, keep/unfav → 待处理. Without grading, 粗分 done → 待处理.
// Invalid videos count as the first 取消收藏 tier (verdictOf).
function stageOf(it) {
  const b = it.bvid;
  if (isProcessed(b)) return "done";
  if (it.invalid || S.analyses[b]?.status === "done") return "act";
  const v = verdictOf(it);
  if (v.verdict === "none") return "none";
  if (!tiers()) return "act";
  const route = tierOf(v.verdict)?.route;
  return !route || route === "deep" || v.low ? "deep" : "act";
}

function inTab(it, tab) {
  if (tab === "read") return S.readStage === "all" || stageOf(it) === S.readStage;
  if (stageOf(it) !== tab) return false;
  return tab !== "act" || S.actFilter === "all" || verdictOf(it).verdict === S.actFilter;
}

const failedAnalysis = (b) => S.analyses[b]?.status === "error";

// 待细看 lists the batch the button will send (or is sending) first and failed cards last.
function visibleItems() {
  const list = S.items.filter((it) => inTab(it, S.tab) && passTagFilter(it.bvid));
  if (S.tab !== "deep") return list;
  const batch = new Set(S.group ? S.group.bvids : nextBatch());
  const rank = ({ bvid }) => (failedAnalysis(bvid) ? 2 : batch.has(bvid) ? 0 : 1);
  return list.sort((x, y) => rank(x) - rank(y));
}
const selectedIn = (list) => list.filter((it) => S.selected.has(it.bvid));

function stageCounts() {
  const c = { none: 0, deep: 0, act: 0, done: 0, read: 0 };
  for (const it of S.items) {
    if (!passTagFilter(it.bvid)) continue;
    c[stageOf(it)]++;
    c.read++;
  }
  return c;
}
// The earliest step that still has videos.
const currentStage = (c) => STAGES.find(([k]) => c[k])?.[0] || "none";

// The 待细看 batch: the selected cards of that tab, otherwise its first GROUP_SIZE.
function nextBatch() {
  const open = S.items.filter((it) => inTab(it, "deep") && passTagFilter(it.bvid) && needsAnalysis(it.bvid));
  const sel = selectedIn(open);
  return (sel.length ? sel : open.slice(0, GROUP_SIZE)).map((it) => it.bvid);
}

// ---------- init ----------
init();

async function init() {
  bindEvents();
  // Read up front: sidePanel.open must run inside the click's user gesture, before any await.
  chrome.tabs.getCurrent().then((tab) => (ownTabId = tab?.id));
  const [{ schemes, folderScheme }, videoTags, basket, notes, settingsResp] = await Promise.all([
    loadSchemes(),
    storeGet(K.videoTags, {}),
    storeGet(K.basket, []),
    storeGet(K.notes, {}),
    send({ type: "triage-settings-get" })
  ]);
  S.schemes = schemes;
  S.folderScheme = folderScheme;
  S.videoTags = videoTags;
  S.basket = basket;
  S.notes = notes;
  // getKeys (Chrome 130+) lets us read only override keys instead of every cached title/analysis.
  const keys = await chrome.storage.local.getKeys?.();
  const wanted = keys && [K.aiHistory, ...keys.filter((k) => k.startsWith(OVERRIDE_PREFIX))];
  const all = (await chrome.storage.local.get(wanted ?? null)) || {};
  S.aiHistory = all[K.aiHistory] || [];
  for (const [k, v] of Object.entries(all)) {
    if (k.startsWith(OVERRIDE_PREFIX)) S.overrides[k.slice(OVERRIDE_PREFIX.length)] = v;
  }
  if (settingsResp.ok) Object.assign(S.settings, settingsResp.data);
  const syncObsidian = ({ obsidianEnabled }) => document.body.classList.toggle("obsidian-off", obsidianEnabled !== true);
  syncObsidian(await chrome.storage.sync.get({ obsidianEnabled: false }));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && changes.obsidianEnabled) syncObsidian({ obsidianEnabled: changes.obsidianEnabled.newValue });
    // The history page edits the same notes; a pending local save is newer than any echo.
    if (area === "local" && changes[K.notes] && !noteTimer) S.notes = changes[K.notes].newValue || {};
  });
  renderBasket();
  await loadFolders();
  setInterval(tick, 1000);
}

// Runs the scheme migration once (flag key), then returns { schemes, folderScheme }.
// An existing triage_schemes is never rebuilt; the old global keys stay for rollback and are not read after this.
async function loadSchemes() {
  const got = await chrome.storage.local.get([K.schemes, K.folderScheme, K.schemesMigrated]);
  let schemes = got[K.schemes];
  if (!got[K.schemesMigrated]) {
    if (!Array.isArray(schemes)) {
      const old = await chrome.storage.local.get(["triage_tags", "triage_tag_presets"]);
      const sync = await chrome.storage.sync.get({ triageCriteria: "", triageOwnTagsOnly: false });
      schemes = migrateSchemes({ tags: old.triage_tags, presets: old.triage_tag_presets, criteria: sync.triageCriteria, ownTagsOnly: sync.triageOwnTagsOnly });
    }
    await chrome.storage.local.set({ [K.schemes]: schemes, [K.schemesMigrated]: true });
  }
  if (Array.isArray(schemes) && renameDefaultDrop(schemes)) await chrome.storage.local.set({ [K.schemes]: schemes });
  return { schemes: Array.isArray(schemes) && schemes.length ? schemes : [defaultScheme()], folderScheme: got[K.folderScheme] || {} };
}

// The default 「删」 tier became 「可以删」; a tier the user renamed keeps its name. Mutates, returns whether anything changed.
function renameDefaultDrop(schemes) {
  let changed = false;
  for (const t of schemes.flatMap((x) => x?.grading?.tiers || [])) {
    if (t.id !== "drop" || t.name !== "删") continue;
    t.name = "可以删";
    changed = true;
  }
  return changed;
}

async function loadFolders() {
  el.banner.hidden = true;
  const r = await send({ type: "triage-folders" });
  if (!r.ok) {
    const needLogin = r.code === "NOT_LOGGED_IN" || /登录/.test(r.error || "");
    if (needLogin) showBanner(`未登录 B 站：${r.error}`, "去登录", () => openTab("https://passport.bilibili.com/login"));
    else showBanner(`读取收藏夹失败：${r.error}`, "重试", loadFolders);
    el.list.innerHTML = `<p class="empty">无法读取收藏夹</p>`;
    return;
  }
  S.folders = r.data.folders || [];
  el.folderSelect.innerHTML = S.folders
    .map((f) => `<option value="${esc(f.id)}">${esc(f.title)} (${esc(f.count)})</option>`)
    .join("");
  if (!S.folders.length) {
    el.list.innerHTML = `<p class="empty">没有找到收藏夹</p>`;
    return;
  }
  const last = String(await storeGet(K.lastFolder, ""));
  const pick = S.folders.find((f) => String(f.id) === last) || S.folders[0];
  el.folderSelect.value = String(pick.id);
  await openFolder(String(pick.id));
}

async function openFolder(mediaId) {
  // Loaded before any state changes so S.mediaId and S.decisions always belong to the same folder.
  const decisions = await storeGet(K.decisions(mediaId), {});
  S.folderToken++;
  // The old stage-1 loop exits on the token change without touching state, so reset it here.
  S.stage1 = { running: false, stop: true };
  if (S.group) S.group.stop = true;
  S.mediaId = mediaId;
  S.decisions = decisions;
  S.items = [];
  S.itemMap = new Map();
  S.group = null;
  S.selected.clear();
  S.undo = [];
  S.stage1Skip.clear();
  S.focused = "";
  S.focusIndex = 0;
  S.throttleUntil = 0;
  S.status = "";
  Object.assign(S, { extra: "", extraOpen: false, runExtra: "" });
  el.syncNotice.hidden = true;
  storeSet(K.lastFolder, mediaId);
  el.list.innerHTML = `<p class="empty">加载中…</p>`;
  const ok = await syncFolder({ force: true });
  if (!ok) return;
  S.tab = currentStage(stageCounts());
  S.readStage = "all";
  S.actFilter = "all";
  S.focused = visibleItems()[0]?.bvid || "";
  render();
}

// ---------- sync with bilibili ----------
async function syncFolder({ force = false } = {}) {
  // S.syncing holds the token of the running sync, so a forced sync for a newly opened folder is not blocked by the old one.
  if (S.syncing === S.folderToken || (!force && Date.now() - S.lastSyncAt < SYNC_MIN_GAP_MS)) return false;
  const token = S.folderToken;
  S.syncing = token;
  const mediaId = S.mediaId;
  try {
    const r = await send({ type: "triage-folder-items", mediaId });
    if (token !== S.folderToken) return false;
    if (!r.ok) {
      const needLogin = r.code === "NOT_LOGGED_IN" || /登录/.test(r.error || "");
      if (needLogin) showBanner(`未登录 B 站：${r.error}`, "去登录", () => openTab("https://passport.bilibili.com/login"));
      else toast(`刷新收藏夹失败：${r.error}`, true);
      if (!S.items.length) el.list.innerHTML = `<p class="empty">无法读取这个收藏夹</p>`;
      return false;
    }
    S.lastSyncAt = Date.now();
    const remote = r.data.items || [];
    // A partial list proves what exists, never what was removed, so it skips the removed diff and the snapshot.
    const partial = r.data.partial ? { ...r.data.partial, count: remote.length } : null;
    const remoteSet = new Set(remote.map((it) => it.bvid));
    const snap = await storeGet(K.snapshot(mediaId), null);
    const diff = { added: [], removed: [], invalid: [], restored: [] };
    const restored = new Set();

    for (const it of remote) {
      if (S.decisions[it.bvid]?.action === "unfav") {
        delete S.decisions[it.bvid];
        restored.add(it.bvid);
        diff.restored.push(it.title);
      }
    }
    if (snap) {
      const snapSet = new Set(snap.bvids);
      const snapInvalid = new Set(snap.invalid || []);
      for (const it of remote) {
        if (!snapSet.has(it.bvid) && !restored.has(it.bvid)) diff.added.push(it);
        if (it.invalid && snapSet.has(it.bvid) && !snapInvalid.has(it.bvid)) diff.invalid.push(it.title);
      }
      for (const b of partial ? [] : snap.bvids) {
        if (!remoteSet.has(b) && S.decisions[b]?.action !== "unfav") diff.removed.push(snap.titles?.[b] || b);
      }
    }
    if (restored.size) storeSet(K.decisions(mediaId), S.decisions);

    // Remote order, newly added first; keep items we unfavorited this session so undo stays possible,
    // and after a partial load keep everything the missing pages may still hold.
    const addedSet = new Set(diff.added.map((it) => it.bvid));
    const next = [...remote.filter((it) => addedSet.has(it.bvid)), ...remote.filter((it) => !addedSet.has(it.bvid))];
    for (const it of S.items) {
      if (!remoteSet.has(it.bvid) && (partial || S.decisions[it.bvid]?.action === "unfav")) next.push(it);
    }
    S.items = next;
    S.itemMap = new Map(next.map((it) => [it.bvid, it]));
    if (S.group) S.group.bvids = S.group.bvids.filter((b) => S.itemMap.has(b));
    for (const b of [...S.selected]) if (!S.itemMap.has(b)) S.selected.delete(b);

    if (!partial) {
      storeSet(K.snapshot(mediaId), {
        bvids: remote.map((it) => it.bvid),
        invalid: remote.filter((it) => it.invalid).map((it) => it.bvid),
        titles: Object.fromEntries(remote.map((it) => [it.bvid, it.title])),
        at: Date.now()
      });
    }

    const missing = next.map((it) => it.bvid).filter((b) => !(b in S.titleRes) && !(b in S.analyses));
    if (missing.length) {
      const [t, a] = await Promise.all([
        send({ type: "triage-title-get", bvids: missing }),
        send({ type: "triage-analysis-get", bvids: missing })
      ]);
      if (token !== S.folderToken) return false;
      for (const b of missing) {
        if (t.ok && t.data?.[b]) S.titleRes[b] = t.data[b];
        if (a.ok && a.data?.[b]) S.analyses[b] = a.data[b];
      }
    }
    showSyncNotice(diff, partial);
    render();
    return true;
  } finally {
    if (S.syncing === token) S.syncing = false;
  }
}

function showSyncNotice(diff, partial) {
  const { added, removed, invalid, restored } = diff;
  if (!partial && !added.length && !removed.length && !invalid.length && !restored.length) {
    if (el.syncNotice.dataset.partial) el.syncNotice.hidden = true;
    return;
  }
  el.syncNotice.dataset.partial = partial ? "1" : "";
  const parts = [`新增 ${added.length}`, ...(partial ? [] : [`已在B站移除 ${removed.length}`]), `已失效 ${invalid.length}`];
  if (restored.length) parts.push(`恢复 ${restored.length}`);
  const head = partial ? `只加载了前 ${partial.count} 个（第 ${partial.page} 页失败：${partial.error}），可稍后重试同步。` : "";
  el.syncText.textContent = `${head}B站同步：${parts.join(" · ")}`;
  const section = (label, titles) =>
    titles.length ? `<div><strong>${label}</strong><ul>${titles.map((t) => `<li>${esc(t)}</li>`).join("")}</ul></div>` : "";
  el.syncDetail.innerHTML =
    section("新增", added.map((it) => it.title)) +
    section("已在B站移除", removed) +
    section("已失效", invalid) +
    section("恢复（在B站重新收藏）", restored);
  el.syncDetail.hidden = true;
  el.syncNotice.hidden = false;
}

// ---------- render ----------
function render() {
  renderTop();
  renderTabs();
  renderList();
}

function renderTop() {
  renderSchemeSelect();
  const total = S.items.length;
  const classified = S.items.filter((it) => it.invalid || S.titleRes[it.bvid]).length;
  const deep = S.items.filter((it) => S.analyses[it.bvid]?.status === "done").length;
  const processed = S.items.filter((it) => isProcessed(it.bvid)).length;
  el.progress.textContent = `已粗分 ${classified} / ${total} · 已细看 ${deep} · 已处理 ${processed}`;
  el.aiBtn.textContent = S.ai.running ? "AI 指令 · 运行中" : S.ai.proposal ? "AI 指令 · 待确认" : "AI 指令";
  renderStatus();
}

function renderStatus() {
  const left = S.throttleUntil - Date.now();
  if (left > 0) {
    el.queueStatus.textContent = `${S.throttleLabel}，${fmtDuration(Math.ceil(left / 1000))} 后重试`;
    el.queueStatus.classList.add("warn");
  } else {
    el.queueStatus.textContent = S.status;
    el.queueStatus.classList.remove("warn");
  }
}

function tick() {
  if (S.throttleUntil) renderStatus();
}

function renderTabs() {
  const c = stageCounts();
  const cur = currentStage(c);
  // The selected tab is solid; the step to work on next only gets a dot.
  const tab = (key, label, cls, mark, n) =>
    `<button type="button" role="tab" class="${cls}" data-tab="${key}" aria-selected="${S.tab === key}" aria-label="${label} ${n}${key === cur ? "，当前这一步" : ""}">${mark}${label}<span class="count">${n}</span>${key === cur ? `<span class="now" aria-hidden="true"></span>` : ""}</button>`;
  const steps = STAGES.map(([key, label], i) => {
    const n = c[key];
    // A finished step (nothing left in it) reads as done; 已处理 has no step after it to be done with.
    const clear = !n && key !== "done";
    const cls = n ? "step" : "step zero";
    return tab(key, label, cls, `<span class="num" aria-hidden="true">${clear ? "✓" : "①②③④"[i]}</span>`, n);
  });
  el.tabs.innerHTML =
    steps.join(`<span class="arrow" aria-hidden="true">→</span>`) + `<span class="tab-sep" aria-hidden="true"></span>` + tab("read", "阅览", "read-tab", "", c.read);

  el.tagFilter.innerHTML = S.tags.length
    ? S.tags
        .map(
          (t) =>
            `<button type="button" class="chip${S.tagFilter.has(t.id) ? " on" : ""}" style="--c:${esc(t.color)}" data-tagfilter="${esc(t.id)}" aria-pressed="${S.tagFilter.has(t.id)}" aria-label="按标签筛选 ${esc(t.name)}">${esc(t.name)}</button>`
        )
        .join("")
    : `<span class="muted">还没有标签</span> · <button type="button" class="link" data-tags-open="new" aria-label="新建标签">新建标签</button>`;
}

const headBtn = (act, label, cls = "", disabled = false, tier = "") =>
  `<button type="button"${cls ? ` class="${cls}"` : ""} data-head="${act}"${tier ? ` data-tier="${esc(tier)}"` : ""} aria-label="${esc(label)}"${disabled ? " disabled" : ""}>${esc(label)}</button>`;

// 「按『方案』· 临时补充 ▸」 next to the 粗分/细看 button; the extra text goes to the next run only.
function runLine(busy) {
  const x = scheme();
  const criteria = x.criteria.trim() ? "" : ` · <span class="muted">未设判断标准</span> <button type="button" class="link" data-head="edit-scheme" aria-label="编辑判断标准">编辑</button>`;
  const extra = busy
    ? S.runExtra ? ` · 临时补充：${esc(S.runExtra)}` : ""
    : S.extraOpen || S.extra
      ? ` · <input data-extra value="${esc(S.extra)}" placeholder="临时补充，只对这一次生效" aria-label="临时补充，只对这一次生效" />`
      : ` · <button type="button" class="link" data-head="extra" aria-label="临时补充">临时补充 ▸</button>`;
  return `<span class="run-line">按「${esc(x.name)}」${criteria}${extra}</span>`;
}

function renderListHeader(list) {
  const t = S.tab;
  const next = STAGES[STAGES.findIndex(([k]) => k === t) + 1];
  const busy = S.stage1.running || Boolean(S.group);
  let html = "";
  if (t === "none") {
    if (S.stage1.running) html = headBtn("stage1", `暂停粗分 ${S.stage1.done}/${S.stage1.total}`, "primary");
    else {
      const n = stage1Pending().length;
      html = headBtn("stage1", n ? `标题粗分这 ${n} 个` : "标题粗分", "primary", !n || busy);
    }
    html += runLine(busy);
  } else if (t === "deep") {
    if (S.group) {
      const done = S.group.bvids.filter((b) => !needsAnalysis(b)).length;
      html = headBtn("group", `暂停细看 ${done}/${S.group.bvids.length}`, "primary");
    } else {
      const batch = nextBatch();
      const label = batch.some((b) => S.selected.has(b)) ? `细看选中 ${batch.length} 个` : batch.length ? `细看下一批 ${batch.length} 个` : "细看";
      html = headBtn("group", label, "primary", !batch.length || busy);
    }
    html += runLine(busy);
  } else if (t === "act") {
    // Filters and batch buttons come from the scheme's tiers. A selection gets both buttons whatever the tier;
    // without one each keep/unfav tier gets its own button, and 要细看 tiers (or no grading) have none.
    const ts = tiers() || [];
    if (ts.length) {
      html = `<span class="seg" role="group" aria-label="按档位筛选">${[["all", "全部"], ...ts.map((x) => [x.id, x.name])]
        .map(([k, label]) => `<button type="button" data-act-filter="${esc(k)}" aria-pressed="${S.actFilter === k}">${esc(label)}</button>`)
        .join("")}</span>`;
    }
    const sel = selectedIn(list).length;
    const f = S.actFilter;
    const batchBtn = (route, x) => {
      const n = batchList(x?.id ?? null).length;
      const verb = route === "unfav" ? "取消收藏" : "保留";
      return headBtn(`batch-${route}`, x ? `${verb}（AI：${x.name}）${n} 个` : `${verb}选中的 ${n} 个`, route === "unfav" ? "danger" : "", !n, x?.id);
    };
    if (sel || !ts.length) html += batchBtn("unfav") + batchBtn("keep");
    else for (const route of ["unfav", "keep"]) for (const x of ts) if (x.route === route && (f === "all" || f === x.id)) html += batchBtn(route, x);
    if (!sel && list.length && (!ts.length || routeOf(f) === "deep")) html += `<span class="muted">按 X 选中后可批量保留或取消收藏</span>`;
  } else if (t === "read") {
    const options = [["all", "全部"], ...STAGES]
      .map(([key, label]) => `<option value="${key}"${S.readStage === key ? " selected" : ""}>${label}</option>`)
      .join("");
    html = `<select data-read-stage aria-label="按进度筛选阅览">${options}</select><span class="muted">${list.length} 个</span>
      ${headBtn("copy-read", "复制 Markdown", "", !list.length)}
      ${headBtn("download-read", "下载 .md", "", !list.length)}`;
  }
  if (STAGE_EMPTY[t] && !stageCounts()[t]) {
    html += `<button type="button" data-goto="${next[0]}">${STAGE_EMPTY[t]} →</button>`;
  }
  if (S.selected.size) {
    html += `<span class="muted">已选中 ${S.selected.size} 个</span><button type="button" class="link" data-head="clear-selected" aria-label="清空选中">清空选中</button>`;
  }
  // Background progress re-renders the header; keep the 临时补充 being typed in focus.
  const typing = document.activeElement?.matches?.("[data-extra]");
  el.listHeader.innerHTML = html;
  el.listHeader.hidden = !html;
  if (typing) el.listHeader.querySelector("[data-extra]")?.focus();
}

function recentUnfavs() {
  return Object.entries(S.decisions)
    .filter(([b, d]) => d.action === "unfav" && d.aid && !S.itemMap.has(b))
    .sort((x, y) => y[1].at - x[1].at)
    .slice(0, BocLimits.TRIAGE_RECENT_UNFAV);
}

function recentUnfavHtml() {
  const list = recentUnfavs();
  if (!list.length) return "";
  const rows = list
    .map(([b, d]) => {
      const title = esc(d.title || b);
      return `<li><span class="recent-title">${title}</span><span class="muted">${esc(fmtTime(d.at))}</span>
        <button type="button" data-refav="${esc(b)}" aria-label="重新收藏 ${title}">重新收藏</button></li>`;
    })
    .join("");
  return `<section class="recent-unfav" aria-label="最近取消收藏"><h3>最近取消收藏 <span class="muted">${list.length}</span></h3><ul>${rows}</ul></section>`;
}

const refaving = new Set();
async function refavRecent(bvid) {
  const d = S.decisions[bvid];
  if (!d?.aid || refaving.has(bvid)) return;
  const mediaId = S.mediaId;
  refaving.add(bvid);
  const r = await send({ type: "triage-refav", mediaId, aid: d.aid });
  refaving.delete(bvid);
  if (!r.ok) {
    toast(`重新收藏失败：${r.error}`, true);
    return;
  }
  await patchDecisions(mediaId, { [bvid]: null });
  if (mediaId !== S.mediaId) return;
  toast(`已重新收藏《${d.title || bvid}》`);
  render();
  syncFolder({ force: true });
}

function renderList() {
  const list = visibleItems();
  renderListHeader(list);
  const recent = S.tab === "done" ? recentUnfavHtml() : "";
  if (!S.items.length) {
    el.list.innerHTML = `<p class="empty">这个收藏夹是空的</p>${recent}`;
    return;
  }
  if (!list.length) {
    const empty = { none: "没有未分析的视频", deep: "没有要细看的视频", act: "没有待处理的视频", done: "还没有处理过的视频" };
    el.list.innerHTML = `<p class="empty">${empty[S.tab] || "这里没有视频"}</p>${recent}`;
    return;
  }
  el.list.classList.toggle("reading", S.tab === "read");
  if (S.tab === "read") {
    el.list.innerHTML = list.map(readHtml).join("");
    return;
  }
  if (!list.some((it) => it.bvid === S.focused)) {
    S.focused = list[Math.min(S.focusIndex, list.length - 1)].bvid;
  }
  S.focusIndex = list.findIndex((it) => it.bvid === S.focused);
  // 待细看 shows which cards the button will send (or is sending) before anything runs.
  // Those cards get a left bar and a label before the title.
  let marked = new Set();
  let word = "";
  if (S.tab === "deep") {
    const bvids = S.group ? S.group.bvids : nextBatch();
    marked = new Set(bvids);
    word = S.group ? "本批" : bvids.some((b) => S.selected.has(b)) ? "已选中" : "下一批";
  }
  const expanded = S.tab === "act";
  const failed = S.tab === "deep" ? list.filter((it) => failedAnalysis(it.bvid)).length : 0;
  const failedHead = `<div class="group-head">分析失败 ${failed} · <button type="button" class="link" data-retry-failed aria-label="全部重试"${S.group || S.stage1.running ? " disabled" : ""}>全部重试</button></div>`;
  // Background progress re-renders the list; keep a note being typed in focus.
  const typing = document.activeElement?.closest?.("[data-note]");
  const caret = typing && [typing.closest(".card").dataset.bvid, typing.selectionStart, typing.selectionEnd];
  const scroll = el.list.scrollTop;
  el.list.innerHTML =
    list
      .map((it, i) => {
        const head = failed && i === list.length - failed ? failedHead : "";
        return head + cardHtml(it, expanded, marked.has(it.bvid) ? word : "");
      })
      .join("") + recent;
  el.list.scrollTop = scroll;
  if (caret) {
    const box = el.list.querySelector(`.card[data-bvid="${CSS.escape(caret[0])}"] [data-note]`);
    box?.focus();
    box?.setSelectionRange(caret[1], caret[2]);
  }
}

// The badge shows 「AI」 + the tier name, colored by its route (keep green, unfav red, deep yellow).
const verdictLabel = (v) => (v === "none" ? "未分析" : tierOf(v)?.name || "未分级");
const routeOf = (v) => tierOf(v)?.route || "";
// In 待细看 every card is there for low confidence or a 要细看 tier, so the marker would only repeat the tab.
// Without grading only 未分析 gets a badge.
const verdictBadge = (b, v, low = v.low && S.tab !== "deep" && Boolean(tiers())) =>
  S.analyzing.has(b)
    ? `<span class="badge running">分析中…</span>`
    : v.verdict !== "none" && !tiers()
      ? ""
      : `<span class="badge ${ROUTE_CLASS[routeOf(v.verdict)] || "none"}${low ? " low" : ""}">${tierOf(v.verdict) ? `<span class="ai-mark">AI</span>` : ""}${esc(verdictLabel(v.verdict))}${low ? " · 低置信" : ""}</span>`;
const ACTION_LABEL = { unfav: "已取消收藏", keep: "已保留" };

function cardHtml(it, expanded, mark) {
  const b = it.bvid;
  const v = verdictOf(it);
  const a = S.analyses[b];
  const done = a?.status === "done";
  const decision = S.decisions[b];
  const inBasket = S.basket.some((x) => x.bvid === b);
  const cls = ["card"];
  if (b === S.focused) cls.push("focused");
  if (isProcessed(b)) cls.push("decided");
  if (S.selected.has(b)) cls.push("selected");
  if (mark) cls.push("in-batch");

  // Where the verdict came from, as one muted meta item.
  const source = [["", "粗分", "细看", "AI 指令"][v.stage], done && (a.source === "subtitle" ? "字幕" : "简介")].filter(Boolean).join("·");
  const meta = [it.upper, fmtDuration(it.duration), source, it.invalid && "已失效"].filter(Boolean);

  const verdict = verdictBadge(b, v);
  // The button matching the AI's verdict leads; the other stays plain.
  const keepCls = !decision && routeOf(v.verdict) === "keep" ? "ok solid" : "";
  const unfavCls = !decision && routeOf(v.verdict) === "unfav" ? "danger solid" : "";
  const note = S.notes[b]?.text || "";
  const noteHtml =
    note || S.noteOpen.has(b)
      ? `<textarea class="note" data-note rows="1" placeholder="一句话备注，只有你自己看" aria-label="备注">${esc(note)}</textarea>`
      : "";
  const failed = v.failed
    ? `<span class="fail-text">分析失败：${esc(v.failed)}</span><button type="button" data-act="retry" aria-label="重试分析">重试</button>`
    : "";

  // Tags from another scheme stay visible, gray.
  const chips = (S.videoTags[b] || [])
    .map((id) => {
      const t = anyTagById(id);
      if (!t) return "";
      return tagById(id)
        ? `<span class="chip on" style="--c:${esc(t.color)}">${esc(t.name)}</span>`
        : `<span class="chip other" title="来自其他方案">${esc(t.name)}</span>`;
    })
    .join("");
  const sugg = suggestionsOf(b);
  const suggHtml = sugg.length
    ? `<button type="button" class="chip suggest" data-act="accept" aria-label="采纳建议标签 ${esc(sugg.join("、"))}">建议 ${sugg
        .map((n) => esc(n))
        .join(" · ")}</button>`
    : "";

  const body = [];
  if (done && a.oneLiner) body.push(`<p class="oneliner">${esc(a.oneLiner)}</p>`);
  if (done && expanded && a.points?.length) body.push(`<ol class="points">${a.points.map((p) => `<li>${esc(p)}</li>`).join("")}</ol>`);

  return `<article class="${cls.join(" ")}" data-bvid="${esc(b)}" aria-label="${esc(it.title)}">
    <img class="cover" src="${esc(it.cover)}" alt="" loading="lazy" referrerpolicy="no-referrer" />
    <div class="card-body">
      <div class="title-row">${mark ? `<span class="batch-tag">${mark}</span>` : ""}<button type="button" class="title" data-act="open" aria-label="打开视频 ${esc(it.title)}">${esc(it.title)}</button></div>
      <div class="meta">${meta.map(esc).join(" · ")}</div>
      ${body.join("")}
      <div class="card-foot">${verdict}<span class="reason">${esc(v.reason)}</span>${failed}</div>
      ${chips || suggHtml ? `<div class="chips">${chips}${suggHtml}</div>` : ""}
      ${noteHtml}
      <div class="card-foot">
        ${decision ? `<span class="badge ${decision.action === "keep" ? "keep" : "drop"}">${ACTION_LABEL[decision.action]}</span>` : ""}
        ${noteHtml ? "" : `<button type="button" class="link note-add" data-act="note" aria-label="添加备注">+ 备注</button>`}
        <span class="spacer"></span>
        <div class="actions">
          <span class="more">
            <button type="button" data-act="tag" aria-label="打标签 (T)">标签<kbd class="key">T</kbd></button>
            <button type="button" data-act="basket" class="${inBasket ? "on" : ""}" aria-pressed="${inBasket}" aria-label="摘录篮 (E)">摘录<kbd class="key">E</kbd></button>
            <button type="button" data-act="ask" aria-label="问 AI (Q)">问 AI<kbd class="key">Q</kbd></button>
            <button type="button" data-act="select" class="${S.selected.has(b) ? "on" : ""}" aria-pressed="${S.selected.has(b)}" aria-label="选中 (X)">选中<kbd class="key">X</kbd></button>
          </span>
          <button type="button" data-act="keep" class="${keepCls}" aria-label="保留 (S)"${decision ? " disabled" : ""}>保留<kbd class="key">S</kbd></button>
          <button type="button" data-act="unfav" class="${unfavCls}" aria-label="取消收藏 (D)"${decision?.action === "unfav" ? " disabled" : ""}>取消收藏<kbd class="key">D</kbd></button>
        </div>
      </div>
    </div>
  </article>`;
}

// ---------- reading view ----------
function readHtml(it) {
  const b = it.bvid;
  const v = verdictOf(it);
  const a = S.analyses[b];
  const done = a?.status === "done";
  const verdict = verdictBadge(b, v);
  const names = tagIdsOf(b).map((id) => tagById(id));
  const suggested = suggestionsOf(b);
  const body = [];
  if (done && a.oneLiner) body.push(`<p class="oneliner">${esc(a.oneLiner)}</p>`);
  if (done && a.points?.length) body.push(`<ol class="points">${a.points.map((p) => `<li>${esc(p)}</li>`).join("")}</ol>`);
  if (suggested.length) body.push(`<p class="muted">建议标签：${suggested.map(esc).join("、")}</p>`);
  if (names.length) body.push(`<div class="chips">${names.map((t) => `<span class="chip on" style="--c:${esc(t.color)}">${esc(t.name)}</span>`).join("")}</div>`);
  return `<article class="read-item${isProcessed(b) ? " decided" : ""}" data-bvid="${esc(b)}">
    <h3><a href="${videoUrl(b)}" target="_blank" rel="noopener">${esc(it.title)}</a></h3>
    <div class="meta">${esc(it.upper)} · ${fmtDuration(it.duration)} · ${verdict}${v.reason ? ` <span class="reason">${esc(v.reason)}</span>` : ""}</div>
    ${body.join("")}
  </article>`;
}

function folderTitle() {
  return S.folders.find((f) => String(f.id) === String(S.mediaId))?.title || "收藏夹";
}

function buildReadMarkdown(list, now = new Date()) {
  const lines = [`# ${folderTitle()}`, "", `${stamp(now, false)} · ${list.length} 个视频`, ""];
  for (const it of list) {
    const v = verdictOf(it);
    const a = S.analyses[it.bvid];
    const done = a?.status === "done";
    lines.push(`## [${mdLinkText(it.title)}](${videoUrl(it.bvid)})`, "");
    const judged = v.verdict === "none" ? "未分析" : tiers() ? `${verdictLabel(v.verdict)}${v.low ? "（低置信）" : ""}${v.reason ? `：${v.reason}` : ""}` : v.reason;
    lines.push([it.upper, fmtDuration(it.duration), judged].filter(Boolean).join(" · "), "");
    if (done && a.oneLiner) lines.push(`> ${a.oneLiner}`, "");
    if (done && a.points?.length) lines.push(...a.points.map((p) => `- ${p}`), "");
    const suggested = suggestionsOf(it.bvid);
    if (suggested.length) lines.push(`建议标签：${suggested.join("、")}`, "");
    const names = tagIdsOf(it.bvid).map((id) => tagById(id).name);
    if (names.length) lines.push(`标签：${names.join("、")}`, "");
  }
  return lines.join("\n");
}

function setFocus(bvid, scroll = true) {
  S.focused = bvid;
  const list = visibleItems();
  S.focusIndex = Math.max(0, list.findIndex((it) => it.bvid === bvid));
  for (const node of el.list.querySelectorAll(".card.focused")) node.classList.remove("focused");
  const card = el.list.querySelector(`.card[data-bvid="${CSS.escape(bvid)}"]`);
  if (card) {
    card.classList.add("focused");
    if (scroll) card.scrollIntoView({ block: "nearest" });
  }
}

function moveFocus(delta) {
  const list = visibleItems();
  if (!list.length) return;
  const i = list.findIndex((it) => it.bvid === S.focused);
  const next = Math.max(0, Math.min(list.length - 1, (i < 0 ? 0 : i + delta)));
  setFocus(list[next].bvid);
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

// ---------- decisions ----------
function pushUndo(entry) {
  S.undo.push(entry);
  if (S.undo.length > BocLimits.TRIAGE_UNDO_STEPS) S.undo.shift();
}
const saveDecisions = () => storeSet(K.decisions(S.mediaId), S.decisions);
// Patch one folder's decisions even after the user switched away from it; a null value deletes.
async function patchDecisions(mediaId, patch) {
  const d = mediaId === S.mediaId ? S.decisions : await storeGet(K.decisions(mediaId), {});
  for (const [b, v] of Object.entries(patch)) {
    if (v) d[b] = v;
    else delete d[b];
  }
  await storeSet(K.decisions(mediaId), d);
}
// aid and title let 最近取消收藏 re-favorite the video after it has left the folder list.
const unfavRecord = (it, at) => ({ action: "unfav", at, aid: it.aid, title: it.title });
const saveVideoTags = () => storeSet(K.videoTags, S.videoTags);
const shortTitle = (it) => (it.title.length > 24 ? `${it.title.slice(0, 24)}…` : it.title);

const deciding = new Set(); // bvids with an unfav request in flight
async function decide(bvid, action) {
  const it = S.itemMap.get(bvid);
  if (!it || deciding.has(bvid)) return;
  const prev = S.decisions[bvid] || null;
  if (prev?.action === action) return;
  if (prev?.action === "unfav") {
    toast("这个视频已取消收藏，按 U 撤销后再改", true);
    return;
  }
  const before = visibleItems();
  if (action === "unfav") {
    deciding.add(bvid);
    const r = await send({ type: "triage-unfav", mediaId: S.mediaId, aids: [it.aid] });
    deciding.delete(bvid);
    if (!r.ok) {
      toast(`取消收藏失败：${r.error}`, true);
      return;
    }
  }
  S.decisions[bvid] = action === "unfav" ? unfavRecord(it, Date.now()) : { action, at: Date.now() };
  saveDecisions();
  pushUndo({ kind: "decision", bvid, action, prev });
  toast(`${action === "unfav" ? "已取消收藏" : "已保留"}《${shortTitle(it)}》 · U 撤销`);
  render();
  advanceFrom(bvid, before);
}

async function undo() {
  const entry = S.undo.pop();
  if (!entry) {
    toast("没有可撤销的操作");
    return;
  }
  if (entry.kind === "decision") {
    const it = S.itemMap.get(entry.bvid);
    const { mediaId, folderToken: token } = S;
    if (entry.action === "unfav") {
      const r = await send({ type: "triage-refav", mediaId, aid: it.aid });
      if (!r.ok) {
        if (token === S.folderToken) toast(`撤销失败：${r.error}。可到 B 站手动重新收藏`, true);
        return;
      }
    }
    await patchDecisions(mediaId, { [entry.bvid]: entry.prev });
    if (token !== S.folderToken) return;
    toast(`已撤销：${entry.action === "unfav" ? "重新收藏" : "取消保留"}《${shortTitle(it)}》`);
    S.focused = entry.bvid;
  } else if (entry.kind === "unfavMany") {
    const { mediaId, folderToken: token } = S;
    const rest = entry.items.slice();
    let n = 0;
    let error = "";
    while (rest.length && token === S.folderToken) {
      if (n) await new Promise((r) => setTimeout(r, 300));
      if (token !== S.folderToken) break;
      const r = await send({ type: "triage-refav", mediaId, aid: rest[0].aid });
      if (!r.ok) {
        error = r.error;
        break;
      }
      await patchDecisions(mediaId, { [rest.shift().bvid]: null });
      n++;
    }
    // After a folder switch the rest stay listed under that folder's 最近取消收藏.
    if (token !== S.folderToken) return;
    if (error) {
      pushUndo({ kind: "unfavMany", items: rest });
      toast(`撤销中断（已重新收藏 ${n} 个，剩余 ${rest.length} 个可再按 U 重试）：${error}`, true);
    } else toast(`已重新收藏 ${n} 个`);
  } else if (entry.kind === "keepMany") {
    for (const b of entry.bvids) delete S.decisions[b];
    saveDecisions();
    toast(`已撤销批量保留 ${entry.bvids.length} 个`);
  } else if (entry.kind === "tags") {
    writeVideoTags(entry.bvid, entry.prev.filter((id) => tagById(id)));
    saveVideoTags();
    toast("已撤销标签修改");
    S.focused = entry.bvid;
  } else if (entry.kind === "aiApply") {
    S.tags = entry.prevTags;
    S.videoTags = entry.prevVideoTags;
    for (const [b, o] of Object.entries(entry.prevOverrides)) {
      if (o) {
        S.overrides[b] = o;
        storeSet(K.override(b), o);
      } else {
        delete S.overrides[b];
        chrome.storage.local.remove(K.override(b));
      }
    }
    for (const id of [...S.tagFilter]) if (!tagById(id)) S.tagFilter.delete(id);
    saveTags();
    saveVideoTags();
    toast(`已撤销 AI 指令对 ${entry.count} 个视频的改动`);
  }
  render();
  setFocus(S.focused);
}

// 待处理 batch buttons act on the selected cards of the tab, otherwise on every card of this tier (none without one).
function batchList(tier) {
  const list = visibleItems().filter((it) => !isProcessed(it.bvid));
  const sel = selectedIn(list);
  return sel.length ? sel : tier == null ? [] : list.filter((it) => verdictOf(it).verdict === tier);
}

async function batchUnfav(btn, list) {
  if (!list.length) return;
  const titles = list.slice(0, 10).map((it) => `<li>${esc(it.title)}</li>`).join("");
  const more = list.length > 10 ? `<p>等 ${list.length} 个</p>` : "";
  const ok = await askConfirm(`取消收藏这 ${list.length} 个视频？`, `<ul>${titles}</ul>${more}`, `取消收藏 ${list.length} 个`);
  if (!ok) return;
  const { mediaId, folderToken: token } = S;
  let done = 0;
  btn.disabled = true;
  for (let i = 0; i < list.length && token === S.folderToken; i += 20) {
    const chunk = list.slice(i, i + 20);
    btn.textContent = `取消收藏中 ${done}/${list.length}`;
    const r = await send({ type: "triage-unfav", mediaId, aids: chunk.map((it) => it.aid) });
    if (!r.ok) {
      if (token === S.folderToken) toast(`批量取消收藏失败（已完成 ${done} 个）：${r.error}`, true);
      break;
    }
    const at = Date.now();
    await patchDecisions(mediaId, Object.fromEntries(chunk.map((it) => [it.bvid, unfavRecord(it, at)])));
    done += chunk.length;
    if (i + 20 < list.length && token === S.folderToken) await new Promise((r2) => setTimeout(r2, 1000));
  }
  // After a folder switch the finished chunks are saved under their folder and listed in its 最近取消收藏.
  if (token !== S.folderToken) return;
  if (done) {
    pushUndo({ kind: "unfavMany", items: list.slice(0, done).map(({ bvid, aid }) => ({ bvid, aid })) });
    for (const it of list.slice(0, done)) S.selected.delete(it.bvid);
    toast(`已取消收藏 ${done} 个 · 撤销(U)`);
  }
  render();
}

function batchKeep(list) {
  if (!list.length) return;
  const at = Date.now();
  for (const it of list) {
    S.decisions[it.bvid] = { action: "keep", at };
    S.selected.delete(it.bvid);
  }
  saveDecisions();
  pushUndo({ kind: "keepMany", bvids: list.map((it) => it.bvid) });
  toast(`已标记保留 ${list.length} 个 · 撤销(U)`);
  render();
}

// ---------- tags ----------
const saveSchemes = () => storeSet(K.schemes, S.schemes);
const saveTags = saveSchemes;

const tagPayload = () => S.tags.map((t) => ({ name: t.name, description: t.description || "" }));
// What the background builds prompts from; tiers null = grading off.
const schemePayload = () => {
  const x = scheme();
  return { criteria: x.criteria, tags: tagPayload(), onlyMyTags: x.onlyMyTags, tiers: tiers()?.map(({ id, name, description, route }) => ({ id, name, description, route })) || null };
};

// Returns the tag with this name, creating it if needed; fills an empty description.
function createTag(name, description = "") {
  name = stripNew(name);
  const existing = S.tags.find((t) => t.name === name);
  if (existing) {
    if (!existing.description && description) {
      existing.description = description;
      saveTags();
    }
    return existing;
  }
  const tag = {
    id: `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    name,
    description,
    color: TAG_COLORS[S.tags.length % TAG_COLORS.length]
  };
  S.tags.push(tag);
  saveTags();
  return tag;
}

// ids and prev are the current scheme's tags; other schemes' tags on the video are kept.
function writeVideoTags(bvid, ids) {
  const all = [...(S.videoTags[bvid] || []).filter((id) => !tagById(id)), ...ids];
  if (all.length) S.videoTags[bvid] = all;
  else delete S.videoTags[bvid];
}
function setVideoTags(bvid, ids, prev) {
  const same = ids.length === prev.length && ids.every((id) => prev.includes(id));
  if (same) return false;
  writeVideoTags(bvid, ids);
  saveVideoTags();
  pushUndo({ kind: "tags", bvid, prev });
  return true;
}

function acceptSuggestions(bvid) {
  const sugg = suggestionsOf(bvid);
  if (!sugg.length) {
    toast("这个视频没有待采纳的建议标签");
    return;
  }
  const prev = tagIdsOf(bvid);
  const ids = [...prev];
  for (const name of sugg) {
    const t = createTag(name);
    if (!ids.includes(t.id)) ids.push(t.id);
  }
  setVideoTags(bvid, ids, prev);
  toast(`已添加标签：${sugg.map(stripNew).join("、")} · 撤销(U)`);
  render();
}

const picker = { bvid: "", prev: [], ids: [], index: 0, options: [] };

function openPicker(bvid) {
  const it = S.itemMap.get(bvid);
  if (!it) return;
  picker.bvid = bvid;
  picker.prev = tagIdsOf(bvid);
  picker.ids = [...picker.prev];
  picker.index = 0;
  el.pickerTitle.textContent = `打标签 ·《${shortTitle(it)}》`;
  el.pickerInput.value = "";
  renderPicker();
  el.pickerDialog.showModal();
  el.pickerInput.focus();
}

function renderPicker() {
  const q = el.pickerInput.value.trim();
  const opts = S.tags.filter((t) => !q || t.name.toLowerCase().includes(q.toLowerCase())).map((t) => ({ tag: t }));
  if (q && !S.tags.some((t) => t.name === stripNew(q))) opts.unshift({ create: stripNew(q) });
  picker.options = opts;
  picker.index = Math.min(picker.index, Math.max(0, opts.length - 1));
  el.pickerList.innerHTML = opts.length
    ? opts
        .map((o, i) => {
          const active = i === picker.index ? " active" : "";
          if (o.create) return `<li role="option" class="picker-opt${active}" data-i="${i}" aria-selected="${i === picker.index}">新建「${esc(o.create)}」</li>`;
          const on = picker.ids.includes(o.tag.id);
          return `<li role="option" class="picker-opt${active}" data-i="${i}" aria-selected="${i === picker.index}" aria-checked="${on}"><span class="check">${on ? "✓" : ""}</span><span class="dot" style="--c:${esc(o.tag.color)}"></span>${esc(o.tag.name)}</li>`;
        })
        .join("")
    : `<li class="muted">输入名称后回车新建标签</li>`;
  el.pickerList.querySelector(".active")?.scrollIntoView({ block: "nearest" });
}

function pickOption(i) {
  const o = picker.options[i];
  if (!o) return;
  if (o.create) {
    const t = createTag(o.create);
    picker.ids.push(t.id);
    el.pickerInput.value = "";
    picker.index = 0;
  } else if (picker.ids.includes(o.tag.id)) {
    picker.ids = picker.ids.filter((id) => id !== o.tag.id);
  } else {
    picker.ids.push(o.tag.id);
  }
  renderPicker();
}

function closePicker() {
  const changed = setVideoTags(picker.bvid, picker.ids, picker.prev);
  render();
  if (changed) toast("标签已更新 · 撤销(U)");
  setFocus(S.focused, true);
}

// ---------- schemes ----------
let schemeSelectHtml = "";
function renderSchemeSelect() {
  const cur = scheme();
  const html =
    S.schemes.map((x) => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join("") +
    `<option disabled>──────</option><option value="__edit">编辑「${esc(cur.name)}」…</option><option value="__new">新建方案…</option>`;
  // Rebuilding the options while the menu is open would close it.
  if (html !== schemeSelectHtml) el.schemeSelect.innerHTML = schemeSelectHtml = html;
  el.schemeSelect.value = cur.id;
  el.schemeSelect.disabled = S.stage1.running || Boolean(S.group);
}

// Missing entries mean the default scheme. Tag filters and the 待处理 filter belong to the old scheme, so they reset.
function setFolderScheme(id) {
  if (id === "default") delete S.folderScheme[S.mediaId];
  else S.folderScheme[S.mediaId] = id;
  storeSet(K.folderScheme, S.folderScheme);
  S.tagFilter.clear();
  S.actFilter = "all";
  S.tab = currentStage(stageCounts());
  S.focused = "";
  render();
}

function newScheme() {
  const x = { ...defaultScheme(), id: `s${Date.now().toString(36)}`, name: `新方案 ${S.schemes.length + 1}` };
  S.schemes.push(x);
  saveSchemes();
  setFolderScheme(x.id);
  openSchemeEditor("name");
}

function openSchemeEditor(focus) {
  const x = scheme();
  el.schemeName.value = x.name;
  el.schemeCriteria.value = x.criteria;
  el.ownTagsInput.checked = x.onlyMyTags;
  el.deleteSchemeBtn.hidden = x.id === "default";
  renderTagManager();
  renderTiers();
  el.schemeDialog.showModal();
  if (focus === "name") el.schemeName.select();
  if (focus === "criteria") el.schemeCriteria.focus();
  if (focus === "new") el.newTagInput.focus();
  if (focus === "tags") el.schemeTagsHead.scrollIntoView({ block: "start" });
}

function renderTiers() {
  const ts = tiers();
  el.gradingInput.checked = Boolean(ts);
  el.tierRows.hidden = el.addTierBtn.hidden = !ts;
  el.tierRows.innerHTML = (ts || [])
    .map(
      (t) => `<div class="tier-row" data-id="${esc(t.id)}">
      <input type="text" value="${esc(t.name)}" data-tier="name" aria-label="档位名称" />
      <select data-tier="route" aria-label="去向 ${esc(t.name)}">${ROUTES.map(([k, label]) => `<option value="${k}"${t.route === k ? " selected" : ""}>${label}</option>`).join("")}</select>
      <button type="button" class="danger" data-tier="delete" aria-label="删除档位 ${esc(t.name)}">删除</button>
      <input type="text" value="${esc(t.description)}" data-tier="description" placeholder="说明：什么样的视频归这一档（AI 会参考）" aria-label="档位说明 ${esc(t.name)}" />
    </div>`
    )
    .join("");
}

async function deleteTier(id) {
  const ts = tiers();
  const t = ts.find((x) => x.id === id);
  if (ts.length === 1) return toast("至少留一档；不想分级就关掉「让 AI 分级」", true);
  const ok = await askConfirm(`删除档位「${t.name}」？`, "<p>已判为这一档的视频回到未分析，可以重新粗分；细看过的显示「未分级」。</p>", "删除");
  if (!ok) return;
  scheme().grading.tiers = ts.filter((x) => x !== t);
  S.actFilter = "all";
  saveSchemes();
  renderTiers();
  render();
}

async function deleteScheme() {
  const x = scheme();
  if (x.id === "default") return;
  const folders = Object.values(S.folderScheme).filter((id) => id === x.id).length;
  const ok = await askConfirm(`删除方案「${x.name}」？`, `<p>用它的 ${folders} 个收藏夹改用默认方案。这个方案的标签会从视频上消失，无法撤销。</p>`, "删除");
  if (!ok) return;
  S.schemes = S.schemes.filter((s2) => s2 !== x);
  for (const [m, id] of Object.entries(S.folderScheme)) if (id === x.id) delete S.folderScheme[m];
  saveSchemes();
  el.schemeDialog.close();
  setFolderScheme("default");
}

function renderTagManager() {
  const counts = {};
  for (const ids of Object.values(S.videoTags)) for (const id of ids) counts[id] = (counts[id] || 0) + 1;
  el.tagsRows.innerHTML = S.tags.length
    ? S.tags
        .map(
          (t) => `<div class="tag-row" data-id="${esc(t.id)}">
      <input type="color" value="${esc(t.color)}" data-field="color" aria-label="标签颜色 ${esc(t.name)}" />
      <input type="text" value="${esc(t.name)}" data-field="name" aria-label="标签名称" />
      <input type="text" value="${esc(t.description)}" data-field="description" placeholder="说明：什么时候用这个标签（AI 会参考）" aria-label="标签说明 ${esc(t.name)}" />
      <span class="muted">${counts[t.id] || 0} 个视频</span>
      <button type="button" class="danger" data-field="delete" aria-label="删除标签 ${esc(t.name)}">删除</button>
    </div>`
        )
        .join("")
    : `<p class="muted">还没有标签</p>`;
}

async function deleteTag(id) {
  const t = tagById(id);
  const n = Object.values(S.videoTags).filter((ids) => ids.includes(id)).length;
  const ok = await askConfirm(`删除标签「${t.name}」？`, `<p>将从 ${n} 个视频上移除这个标签，无法撤销。</p>`, "删除");
  if (!ok) return;
  S.tags = S.tags.filter((x) => x.id !== id);
  for (const [b, ids] of Object.entries(S.videoTags)) {
    const rest = ids.filter((x) => x !== id);
    if (rest.length) S.videoTags[b] = rest;
    else delete S.videoTags[b];
  }
  S.tagFilter.delete(id);
  S.undo = S.undo.filter((e) => e.kind !== "tags" && e.kind !== "aiApply");
  saveTags();
  saveVideoTags();
  renderTagManager();
  render();
}

// ---------- AI stage 1: titles ----------
function aiItem(it) {
  return { bvid: it.bvid, title: it.title, upper: it.upper, duration: it.duration, intro: it.intro };
}

async function throttleWait(code, keepGoing) {
  const [ms, label] = THROTTLES[code];
  S.throttleUntil = Date.now() + ms;
  S.throttleLabel = label;
  renderStatus();
  await sleepWhile(ms, keepGoing);
  S.throttleUntil = 0;
  renderStatus();
}

// 临时补充 is taken when a run starts and cleared when it ends, unless it was edited meanwhile.
function beginRun() {
  S.runExtra = S.extra.trim();
}
function endRun() {
  if (S.extra.trim() === S.runExtra) Object.assign(S, { extra: "", extraOpen: false });
  S.runExtra = "";
}

const stage1Pending = () => S.items.filter((it) => stageOf(it) === "none" && !S.stage1Skip.has(it.bvid));

async function runStage1() {
  const token = S.folderToken;
  // Timed-out batches are skipped for this run only, so clicking 标题粗分 again retries them.
  const timedOut = new Set();
  const pending = () => stage1Pending().filter((it) => !timedOut.has(it.bvid));
  const total = pending().length;
  S.stage1 = { running: true, stop: false, done: 0, total };
  beginRun();
  const keepGoing = () => !S.stage1.stop && token === S.folderToken;
  const size = Math.max(1, Number(S.settings.triageTitleBatchSize) || 30);
  let done = 0;
  let retried = false;
  let failedOut = false;
  render();
  while (keepGoing()) {
    const batch = pending().slice(0, size);
    if (!batch.length) break;
    S.status = `标题粗分中 ${done}/${total}`;
    for (const it of batch) S.analyzing.add(it.bvid);
    render();
    const r = await send({ type: "triage-classify-titles", items: batch.map(aiItem), scheme: schemePayload(), extra: S.runExtra });
    for (const it of batch) S.analyzing.delete(it.bvid);
    if (token !== S.folderToken) break;
    if (!r.ok) {
      if (THROTTLES[r.code]) {
        await throttleWait(r.code, keepGoing);
        continue;
      }
      if (r.code === "AI_TIMEOUT") {
        // First timeout retries the same batch; a second one skips it and moves on.
        retried = !retried;
        if (retried) continue;
        batch.forEach((it) => timedOut.add(it.bvid));
        toast(r.error, true);
        continue;
      }
      handleAiError(r.error);
      failedOut = true;
      break;
    }
    retried = false;
    const results = r.data?.results || {};
    for (const it of batch) {
      if (results[it.bvid]) S.titleRes[it.bvid] = results[it.bvid];
      else S.stage1Skip.add(it.bvid);
    }
    done += batch.length;
    S.stage1.done = done;
    render();
    if (pending().length) await sleepWhile(S.settings.triageIntervalSec * 1000, keepGoing);
  }
  if (token !== S.folderToken) return;
  S.stage1.running = false;
  endRun();
  if (!failedOut) el.banner.hidden = true;
  S.status = timedOut.size
    ? `标题粗分完成 ${done} 个，${timedOut.size} 个因 AI 超时跳过，再点标题粗分可重试`
    : done ? `标题粗分完成 ${done} 个` : "";
  render();
}

// ---------- AI stage 2: subtitle group ----------
const needsAnalysis = (b) => {
  const it = S.itemMap.get(b);
  const a = S.analyses[b];
  return it && !it.invalid && !isProcessed(b) && a?.status !== "done" && a?.status !== "error";
};

function startGroup(bvids) {
  if (!bvids.length || S.group) return;
  S.group = { bvids, stop: false };
  beginRun();
  runGroup();
}

async function analyzeOne(bvid, force = false) {
  S.analyzing.add(bvid);
  render();
  const r = await send({ type: "triage-analyze", bvid, force, scheme: schemePayload(), extra: S.runExtra });
  S.analyzing.delete(bvid);
  return r;
}

async function runGroup() {
  const group = S.group;
  const token = S.folderToken;
  const keepGoing = () => !group.stop && S.group === group && token === S.folderToken;
  render();
  while (keepGoing()) {
    const b = group.bvids.find(needsAnalysis);
    if (!b) break;
    const idx = group.bvids.filter((x) => !needsAnalysis(x)).length + 1;
    S.status = `字幕细看 ${idx}/${group.bvids.length}`;
    const r = await analyzeOne(b);
    if (token !== S.folderToken) return;
    if (!r.ok && THROTTLES[r.code]) {
      render();
      await throttleWait(r.code, keepGoing);
      continue;
    }
    S.analyses[b] = r.ok ? r.data : { bvid: b, status: "error", error: r.error };
    const err = S.analyses[b].status === "error" ? String(S.analyses[b].error || "") : "";
    if (/配置 AI|截断|未授权访问/.test(err)) handleAiError(err);
    if (/配置 AI|未授权访问/.test(err)) group.stop = true;
    render();
    if (group.bvids.some(needsAnalysis)) await sleepWhile(S.settings.triageIntervalSec * 1000, keepGoing);
  }
  if (S.group !== group) return;
  // A run that stopped on a setup error keeps its banner; any other finished batch clears it.
  if (!group.stop) el.banner.hidden = true;
  S.group = null;
  endRun();
  S.status = "";
  render();
}

// Failed results live only on this page; dropping them puts the cards back in the batch runner.
function retryFailed() {
  const failed = visibleItems().filter((it) => failedAnalysis(it.bvid)).map((it) => it.bvid);
  for (const b of failed) delete S.analyses[b];
  startGroup(failed);
}

async function retry(bvid) {
  const r = await analyzeOne(bvid, true);
  if (!r.ok) {
    S.analyses[bvid] = { bvid, status: "error", error: r.error };
    if (THROTTLES[r.code]) toast(`${THROTTLES[r.code][1]}，请稍后再试`, true);
    else handleAiError(r.error);
  } else {
    S.analyses[bvid] = r.data;
  }
  render();
}

// ---------- AI command ----------
function aiScopeItems() {
  const scope = el.aiScope.value;
  if (scope === "selected") return [...S.selected].map((b) => S.itemMap.get(b)).filter(Boolean);
  return visibleItems();
}

function aiCommandItem(it) {
  const out = aiItem(it);
  const a = S.analyses[it.bvid];
  if (a?.status === "done") {
    out.oneLiner = a.oneLiner || "";
    out.points = a.points || [];
  }
  const v = verdictOf(it);
  if (v.verdict !== "none") out.verdict = v.verdict;
  const names = tagIdsOf(it.bvid).map((id) => tagById(id).name);
  if (names.length) out.currentTags = names;
  return out;
}

function openAi() {
  if (S.ai.proposal && !S.ai.running) showAiReview();
  else showAiForm();
  el.aiDialog.showModal();
}

function showAiForm() {
  el.aiForm.hidden = false;
  el.aiReview.hidden = true;
  renderAiForm();
}

function showAiReview() {
  el.aiForm.hidden = true;
  el.aiReview.hidden = false;
  renderAiReview();
}

function renderAiForm() {
  const counts = { filter: visibleItems().length, selected: S.selected.size };
  const labels = { filter: "当前筛选结果", selected: "已选中 (X)" };
  for (const o of el.aiScope.options) {
    o.textContent = `${labels[o.value]} · ${counts[o.value]} 个`;
    o.disabled = !counts[o.value];
  }
  if (el.aiScope.selectedOptions[0]?.disabled) el.aiScope.value = "filter";
  const n = aiScopeItems().length;
  const size = Math.max(1, Number(S.settings.triageTitleBatchSize) || 30);
  el.aiScopeCount.textContent = n ? `将发送 ${n} 个视频，分 ${Math.ceil(n / size)} 批` : "作用范围里没有视频";
  const x = scheme();
  el.aiTagsLabel.textContent = `「${x.name}」的标签`;
  el.aiTagsPreview.innerHTML = x.tags.length
    ? x.tags.map((t) => `<span class="chip" title="${esc(t.description)}">${esc(t.name)}</span>`).join("")
    : `<span class="muted">还没有标签</span>`;
  // New tags follow the scheme's 只用我的标签; the limit is fixed.
  el.aiTagRule.textContent = x.onlyMyTags ? "方案开着「只用我的标签」，AI 只从这些标签里选。" : "AI 可以新建至多 5 个标签，你确认后才会创建。";
  el.aiAllowVerdictRow.hidden = !tiers();
  el.aiHistory.innerHTML = S.aiHistory.length
    ? `<span class="muted">最近：</span>` +
      S.aiHistory
        .map((h, i) => `<button type="button" class="chip" data-h="${i}" title="${esc(h)}" aria-label="使用指令 ${esc(h)}">${esc(h.length > 18 ? `${h.slice(0, 18)}…` : h)}</button>`)
        .join("")
    : "";
  el.aiRunBtn.disabled = S.ai.running;
  el.aiStopBtn.hidden = !S.ai.running;
}

async function runAiCommand() {
  if (S.ai.running) return;
  const instruction = el.aiInstruction.value.trim();
  const items = aiScopeItems();
  if (!instruction) {
    el.aiProgress.textContent = "请先写指令";
    el.aiInstruction.focus();
    return;
  }
  if (!items.length) {
    el.aiProgress.textContent = "作用范围里没有视频";
    return;
  }
  S.aiHistory = [instruction, ...S.aiHistory.filter((x) => x !== instruction)].slice(0, 5);
  storeSet(K.aiHistory, S.aiHistory);
  const opts = { allowNewTags: !scheme().onlyMyTags, maxNewTags: 5, allowVerdict: el.aiAllowVerdict.checked && Boolean(tiers()) };
  const payload = schemePayload();
  const size = Math.max(1, Number(S.settings.triageTitleBatchSize) || 30);
  const scopeSet = new Set(items.map((it) => it.bvid));
  const total = Math.ceil(items.length / size);
  const p = { newTags: [], rows: [], notes: [], errors: [] };
  const token = S.folderToken;
  const keepGoing = () => !S.ai.stop && token === S.folderToken;
  S.ai.running = true;
  S.ai.stop = false;
  renderAiForm();
  renderTop();
  for (let i = 0; i < total && keepGoing(); i++) {
    el.aiProgress.textContent = `正在处理第 ${i + 1} / ${total} 批…`;
    const batch = items.slice(i * size, (i + 1) * size);
    const r = await send({ type: "triage-ai-command", instruction, items: batch.map(aiCommandItem), scheme: payload, allowVerdict: opts.allowVerdict });
    if (!r.ok) {
      p.errors.push(`第 ${i + 1} 批失败：${r.error}`);
      if (/截断|配置 AI|未授权访问/.test(r.error || "")) handleAiError(r.error);
    } else {
      mergeAiBatch(p, r.data, opts, scopeSet);
    }
    if (i + 1 < total) await sleepWhile(S.settings.triageIntervalSec * 1000, keepGoing);
  }
  S.ai.running = false;
  el.aiProgress.textContent = "";
  if (token !== S.folderToken) {
    renderTop();
    return;
  }
  if (S.ai.stop) p.errors.push("已手动停止，这里只有已完成批次的建议");
  S.ai.proposal = p;
  renderTop();
  if (el.aiDialog.open) showAiReview();
  else toast("AI 指令已完成，按 I 查看建议");
}

function mergeAiBatch(p, data, opts, scopeSet) {
  const existing = (name) => S.tags.find((t) => t.name === name);
  const proposed = (name) => p.newTags.find((t) => t.key === name);
  const addNew = (name, description) => {
    if (!opts.allowNewTags || p.newTags.length >= opts.maxNewTags) return null;
    const t = { key: name, name, description: description || "", checked: true };
    p.newTags.push(t);
    return t;
  };

  for (const nt of data?.newTags || []) {
    const name = stripNew(nt?.name || "");
    if (!name || existing(name) || proposed(name)) continue;
    addNew(name, nt.description);
  }
  if (data?.note) p.notes.push(String(data.note));

  for (const [bvid, a] of Object.entries(data?.assignments || {})) {
    if (!scopeSet.has(bvid)) continue;
    const current = tagIdsOf(bvid);
    const add = [];
    for (const raw of a?.add || []) {
      const name = stripNew(raw);
      if (!name) continue;
      const t = existing(name);
      if (t) {
        if (!current.includes(t.id)) add.push(`id:${t.id}`);
        continue;
      }
      const nt = proposed(name) || addNew(name);
      if (nt) add.push(`new:${nt.key}`);
    }
    const remove = (a?.remove || [])
      .map((n) => existing(stripNew(n)))
      .filter((t) => t && current.includes(t.id))
      .map((t) => t.id);
    const oldVerdict = verdictOf(S.itemMap.get(bvid)).verdict;
    const verdict = opts.allowVerdict && tierOf(a?.verdict) && a.verdict !== oldVerdict ? a.verdict : "";
    if (!add.length && !remove.length && !verdict) continue;
    const row = p.rows.find((r) => r.bvid === bvid);
    if (row) {
      row.add = [...new Set([...row.add, ...add])];
      row.remove = [...new Set([...row.remove, ...remove])];
      row.verdict = verdict || row.verdict;
      row.reason = a?.reason || row.reason;
    } else {
      p.rows.push({ bvid, add, remove, verdict, oldVerdict, reason: a?.reason || "", checked: true });
    }
  }
}

// Row changes after dropping adds of unchecked new tags.
function effectiveRow(p, row) {
  const add = row.add.filter((ref) => !ref.startsWith("new:") || p.newTags.find((t) => t.key === ref.slice(4))?.checked);
  return { add, empty: !add.length && !row.remove.length && !row.verdict };
}

function refName(p, ref) {
  return ref.startsWith("id:") ? tagById(ref.slice(3))?.name || "" : p.newTags.find((t) => t.key === ref.slice(4))?.name || "";
}

function renderAiReview() {
  const p = S.ai.proposal;
  el.aiNotes.innerHTML =
    p.errors.map((e) => `<p class="fail-text">${esc(e)}</p>`).join("") +
    p.notes.map((n) => `<p class="muted">AI 说明：${esc(n)}</p>`).join("");
  el.aiNewTags.innerHTML = p.newTags.length
    ? p.newTags
        .map(
          (t, i) => `<div class="ai-newtag" data-i="${i}">
      <input type="checkbox" data-nt="checked"${t.checked ? " checked" : ""} aria-label="创建标签 ${esc(t.name)}" />
      <input type="text" data-nt="name" value="${esc(t.name)}" aria-label="新标签名称" />
      <input type="text" data-nt="description" value="${esc(t.description)}" placeholder="说明：什么时候用这个标签" aria-label="新标签说明" />
    </div>`
        )
        .join("")
    : `<p class="muted">没有新标签</p>`;
  renderAiRows();
}

function renderAiRows() {
  const p = S.ai.proposal;
  const rows = p.rows.map((r) => ({ r, e: effectiveRow(p, r) })).filter((x) => !x.e.empty);
  const checked = rows.filter((x) => x.r.checked).length;
  el.aiReviewSummary.textContent = `${rows.length} 个视频有改动 · 新标签 ${p.newTags.filter((t) => t.checked).length} 个 · 点「应用选中」前不会改动任何东西`;
  el.aiRows.innerHTML = rows.length
    ? rows
        .map(({ r, e }) => {
          const it = S.itemMap.get(r.bvid);
          const chips =
            e.add.map((ref) => `<span class="chip add">+ ${esc(refName(p, ref))}</span>`).join("") +
            r.remove.map((id) => `<span class="chip remove">− ${esc(tagById(id)?.name)}</span>`).join("") +
            (r.verdict ? `<span class="verdict-change">${esc(verdictLabel(r.oldVerdict))} → ${esc(verdictLabel(r.verdict))}</span>` : "");
          return `<div class="ai-row${r.checked ? "" : " off"}" data-bvid="${esc(r.bvid)}">
        <input type="checkbox" data-row${r.checked ? " checked" : ""} aria-label="应用到 ${esc(it?.title)}" />
        <div class="ai-row-body">
          <div class="ai-row-title">${esc(it?.title || r.bvid)}</div>
          <div class="chips">${chips}</div>
          ${r.reason ? `<div class="muted">${esc(r.reason)}</div>` : ""}
        </div>
      </div>`;
        })
        .join("")
    : `<p class="empty">AI 没有提出改动</p>`;
  el.aiApplyBtn.textContent = `应用选中 (${checked})`;
  el.aiApplyBtn.setAttribute("aria-label", el.aiApplyBtn.textContent);
  el.aiApplyBtn.disabled = !checked && !p.newTags.some((t) => t.checked);
}

function applyAiProposal() {
  const p = S.ai.proposal;
  if (!p) return;
  const rows = p.rows.filter((r) => r.checked).map((r) => ({ r, e: effectiveRow(p, r) })).filter((x) => !x.e.empty);
  const prevTags = structuredClone(S.tags);
  const prevVideoTags = structuredClone(S.videoTags);
  const prevOverrides = {};
  const idFor = {};
  for (const t of p.newTags) {
    const name = stripNew(t.name);
    if (t.checked && name) idFor[t.key] = createTag(name, t.description.trim()).id;
  }
  const at = Date.now();
  for (const { r, e } of rows) {
    const ids = new Set(S.videoTags[r.bvid] || []);
    for (const ref of e.add) {
      const id = ref.startsWith("id:") ? ref.slice(3) : idFor[ref.slice(4)];
      if (id) ids.add(id);
    }
    for (const id of r.remove) ids.delete(id);
    if (ids.size) S.videoTags[r.bvid] = [...ids];
    else delete S.videoTags[r.bvid];
    if (r.verdict) {
      prevOverrides[r.bvid] = S.overrides[r.bvid] || null;
      S.overrides[r.bvid] = { verdict: r.verdict, reason: r.reason, by: "ai-command", at };
      storeSet(K.override(r.bvid), S.overrides[r.bvid]);
    }
  }
  saveTags();
  saveVideoTags();
  pushUndo({ kind: "aiApply", prevTags, prevVideoTags, prevOverrides, count: rows.length });
  S.ai.proposal = null;
  el.aiDialog.close();
  render();
  toast(`已应用 AI 建议：${rows.length} 个视频 · 撤销(U)`);
}

// ---------- basket ----------
const saveBasket = () => storeSet(K.basket, S.basket);

function toggleBasket(bvid) {
  const i = S.basket.findIndex((x) => x.bvid === bvid);
  const it = S.itemMap.get(bvid);
  if (i >= 0) {
    S.basket.splice(i, 1);
    toast("已移出摘录篮");
  } else if (it) {
    const a = S.analyses[bvid];
    const done = a?.status === "done";
    S.basket.push({
      bvid,
      title: it.title,
      url: videoUrl(bvid),
      upper: it.upper,
      oneLiner: done ? a.oneLiner || "" : "",
      points: done ? a.points || [] : []
    });
    toast(`已加入摘录篮《${shortTitle(it)}》`);
  }
  saveBasket();
  renderBasket();
  render();
}

function renderBasket() {
  el.basketCount.textContent = S.basket.length;
  el.basketList.innerHTML = S.basket.length
    ? S.basket
        .map(
          (x, i) => `<div class="basket-item" data-i="${i}">
      <div class="row"><strong>${esc(x.title)}</strong><button type="button" data-basket="remove" aria-label="从摘录篮移除 ${esc(x.title)}">移除</button></div>
      ${x.oneLiner ? `<div class="muted">${esc(x.oneLiner)}</div>` : ""}
    </div>`
        )
        .join("")
    : `<p class="empty">按 E 把视频加入摘录篮</p>`;
  el.copyMdBtn.disabled = el.downloadMdBtn.disabled = el.exportBtn.disabled = !S.basket.length;
}

function mdLinkText(s) {
  return String(s).replace(/([\[\]])/g, "\\$1");
}

function buildMarkdown(now = new Date()) {
  const lines = [
    "---",
    `title: B站摘录 ${stamp(now, false)} ${pad(now.getHours())}:${pad(now.getMinutes())}`,
    `created: ${stamp(now, false)}`,
    "tags:",
    "  - B站摘录",
    "---",
    ""
  ];
  for (const x of S.basket) {
    lines.push(`## [${mdLinkText(x.title)}](${x.url})`, "");
    if (x.upper) lines.push(`UP：${x.upper}`, "");
    if (x.oneLiner) lines.push(`> ${x.oneLiner}`, "");
    if (x.points?.length) lines.push(...x.points.map((p) => `- ${p}`), "");
    const names = tagIdsOf(x.bvid).map((id) => tagById(id).name);
    if (names.length) lines.push(`标签：${names.join("、")}`, "");
    const note = S.notes[x.bvid]?.text.trim();
    if (note) lines.push(`笔记：${note}`, "");
  }
  return lines.join("\n");
}

async function exportBasket() {
  el.exportBtn.disabled = true;
  const filename = `B站摘录-${stamp()}.md`;
  const r = await send({ type: "triage-export", filename, markdown: buildMarkdown() });
  el.exportBtn.disabled = false;
  if (!r.ok) {
    toast(`写入 Obsidian 失败：${r.error}`, true);
    return;
  }
  await offerClearBasket(`已写入 ${r.data?.path || filename}`);
}

async function downloadBasket() {
  const filename = `B站摘录-${stamp()}.md`;
  BocDownload.text(filename, buildMarkdown());
  await offerClearBasket(`已下载 ${filename}`);
}

// Only offered once the basket is saved somewhere; copying alone never clears it.
async function offerClearBasket(saved) {
  toast(saved);
  if (await askConfirm("清空摘录篮？", `<p>${esc(saved)}</p>`, "清空")) {
    S.basket = [];
    saveBasket();
    renderBasket();
    render();
  }
}

// ---------- batch Obsidian write ----------
function writeScopeItems() {
  const scope = el.writeScope.value;
  const list = scope === "all" ? S.items : scope === "selected" ? [...S.selected].map((b) => S.itemMap.get(b)).filter(Boolean) : visibleItems();
  return list.filter((it) => !it.invalid);
}

function openWrite() {
  el.writeProgress.textContent = "";
  el.writeFailed.hidden = true;
  el.writeFailed.innerHTML = "";
  renderWriteScope();
  el.writeDialog.showModal();
}

function renderWriteScope() {
  const n = writeScopeItems().length;
  el.writeScopeCount.textContent = `共 ${n} 个视频，间隔 ${S.settings.triageIntervalSec} 秒`;
  el.writeRunBtn.hidden = el.writeMdBtn.hidden = S.write.running;
  el.writeStopBtn.hidden = !S.write.running;
  el.writeRunBtn.disabled = el.writeMdBtn.disabled = !n;
  el.writeScope.disabled = el.writeOverwrite.disabled = S.write.running;
}

function safeNoteName(name) {
  return String(name).replace(/[\\/:*?"<>|#^[\]]/g, "_").trim() || "收藏夹";
}

const oneLine = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
// | [ ] or a newline in the alias would end the link early; the path is already a safe note filename.
function wikiLink(path, title) {
  const target = String(path).replace(/\.md$/, "");
  return `[[${target}|${oneLine(String(title ?? "").replace(/[|[\]]/g, " ")) || target}]]`;
}

// md: build the same notes but download them as one file instead of writing to the vault.
async function runWrite(md = false) {
  const items = writeScopeItems();
  const overwrite = el.writeOverwrite.checked;
  const token = S.folderToken;
  S.write = { running: true, stop: false };
  const keepGoing = () => !S.write.stop && token === S.folderToken;
  renderWriteScope();
  el.writeFailed.hidden = true;
  const written = [];
  const failed = [];
  for (let i = 0; i < items.length && keepGoing(); i++) {
    const it = items[i];
    el.writeProgress.textContent = `${md ? "生成" : "写入"} ${i + 1}/${items.length}：${it.title}`;
    const r = await send(md ? { type: "triage-build-note", bvid: it.bvid } : { type: "triage-write-note", bvid: it.bvid, overwrite });
    if (r.ok) written.push({ ...r.data, bvid: it.bvid });
    else failed.push(`${it.title}：${r.error}`);
    if (i + 1 < items.length) await sleepWhile(S.settings.triageIntervalSec * 1000, keepGoing);
  }
  let indexPath = "";
  if (md && written.length && token === S.folderToken) {
    indexPath = `${safeNoteName(folderTitle())}.md`;
    const notes = written.map((w) => `# ${w.title}\n\n${w.markdown.replace(/^---\n([\s\S]*?)\n---\n/, "```yaml\n$1\n```\n")}`);
    BocDownload.text(indexPath, [`# ${folderTitle()}`, `${stamp(new Date(), false)} · ${written.length} 篇`, ...notes].join("\n\n"));
  } else if (written.length && keepGoing()) {
    const lines = [`# ${folderTitle()}`, "", `${stamp(new Date(), false)} · ${written.length} 篇`, ""];
    for (const w of written) {
      const oneLiner = S.analyses[w.bvid]?.oneLiner;
      lines.push(`- ${wikiLink(w.path, w.title)}${oneLiner ? ` ${oneLine(oneLiner)}` : ""}`);
    }
    const r = await send({ type: "triage-export", filename: `${safeNoteName(folderTitle())}.md`, markdown: lines.join("\n") });
    if (r.ok) indexPath = r.data?.path || "";
    else failed.push(`索引：${r.error}`);
  }
  S.write.running = false;
  const skipped = written.filter((w) => w.skipped).length;
  const aiUpdated = written.filter((w) => w.aiUpdated).length;
  el.writeProgress.textContent = [
    S.write.stop ? "已停止。" : "完成。",
    `${md ? "下载" : "写入"} ${written.length - skipped} 篇`,
    skipped ? `已存在跳过 ${skipped} 篇` : "",
    aiUpdated ? `其中更新 AI 问答 ${aiUpdated} 篇` : "",
    failed.length ? `失败 ${failed.length} 篇` : "",
    indexPath ? `${md ? "文件" : "索引"}：${indexPath}` : ""
  ].filter(Boolean).join(" · ");
  el.writeFailed.innerHTML = failed.map((f) => `<li>${esc(f)}</li>`).join("");
  el.writeFailed.hidden = !failed.length;
  renderWriteScope();
}

// ---------- data export ----------
const BACKUP_PREFIXES = [K.schemes, K.folderScheme, "triage_video_tags", "triage_basket", K.notes, "triage_snapshot_", "triage_decisions_", "triage_title_", "triage_analysis_", OVERRIDE_PREFIX];
const isSecretKey = (k) => /key|token/i.test(k) || k === "aiProviderKeys" || k === "obsidianApiKey";

async function buildBackup() {
  const all = await chrome.storage.local.get(null);
  const out = {
    app: "moondigest",
    schemaVersion: 2,
    exportedAt: new Date().toISOString(),
    extensionVersion: chrome.runtime.getManifest?.().version || "",
    settings: {
      triageIntervalSec: S.settings.triageIntervalSec,
      triageExportFolder: S.settings.triageExportFolder,
      triageTitleBatchSize: S.settings.triageTitleBatchSize
    },
    schemes: [], // criteria, tags, 只用我的标签 and tiers per scheme
    folderScheme: {}, // mediaId → scheme id; missing = default
    videoTags: {},
    basket: [],
    notes: {},
    folders: {},
    titleResults: {},
    analyses: {},
    verdictOverrides: {}
  };
  const folder = (id) =>
    (out.folders[id] ||= { title: S.folders.find((f) => String(f.id) === id)?.title || "", snapshot: null, decisions: {} });
  for (const [k, v] of Object.entries(all || {})) {
    if (!BACKUP_PREFIXES.some((p) => k.startsWith(p))) continue;
    if (isSecretKey(k)) continue; // defensive: triage keys never contain these words
    if (k === K.schemes) out.schemes = v;
    else if (k === K.folderScheme) out.folderScheme = v;
    else if (k.startsWith(OVERRIDE_PREFIX)) out.verdictOverrides[k.slice(OVERRIDE_PREFIX.length)] = v;
    else if (k === "triage_video_tags") out.videoTags = v;
    else if (k === "triage_basket") out.basket = v;
    else if (k === K.notes) out.notes = v;
    else if (k.startsWith("triage_snapshot_")) folder(k.slice(16)).snapshot = v;
    else if (k.startsWith("triage_decisions_")) folder(k.slice(17)).decisions = v;
    else if (k.startsWith("triage_title_")) out.titleResults[k.slice(13)] = v;
    else if (k.startsWith("triage_analysis_")) out.analyses[k.slice(16)] = v;
  }
  return out;
}

// Per-video AI caches for videos in no live folder's snapshot, the open list or the basket,
// plus snapshot/decision records of folders that no longer exist. Tags, videoTags and the basket are never touched.
function staleCacheKeys(all, folderIds, openBvids) {
  const live = new Set(folderIds.map(String));
  const keep = new Set([...openBvids, ...(all[K.basket] || []).map((x) => x.bvid)]);
  for (const id of live) for (const b of all[K.snapshot(id)]?.bvids || []) keep.add(b);
  const plan = { keys: [], videos: new Set(), title: 0, analysis: 0, override: 0, folders: new Set() };
  for (const k of Object.keys(all)) {
    const v = /^triage_(title|analysis|verdict_override)_(.+)$/.exec(k);
    const f = /^triage_(snapshot|decisions)_(.+)$/.exec(k);
    if (v && !keep.has(v[2])) {
      plan.keys.push(k);
      plan.videos.add(v[2]);
      plan[v[1] === "verdict_override" ? "override" : v[1]]++;
    } else if (f && !live.has(f[2])) {
      plan.keys.push(k);
      plan.folders.add(f[2]);
    }
  }
  return { ...plan, videos: plan.videos.size, folders: plan.folders.size };
}

async function cleanCache() {
  if (!S.folders.length) {
    toast("收藏夹列表还没加载，无法判断哪些缓存已失效", true);
    return;
  }
  const plan = staleCacheKeys(await chrome.storage.local.get(null), S.folders.map((f) => f.id), S.items.map((it) => it.bvid));
  if (!plan.keys.length) {
    toast("没有可清理的缓存");
    return;
  }
  const folders = plan.folders ? `，以及 ${plan.folders} 个已删除收藏夹的同步与处理记录` : "";
  const body = `<p>将删除 ${plan.videos} 个已不在任何收藏夹里的视频的缓存（标题粗分 ${plan.title} 条、细看分析 ${plan.analysis} 条、AI 改判 ${plan.override} 条）${folders}。</p>
    <p>这些视频的 AI 判断和摘要会一并删除，无法撤销；需要保留请先导出完整备份。标签、视频标签和摘录篮不受影响。</p>`;
  if (!(await askConfirm("清理缓存？", body, `删除 ${plan.keys.length} 条缓存`))) return;
  await chrome.storage.local.remove(plan.keys);
  toast(`已清理 ${plan.keys.length} 条缓存`);
}

function csvField(v) {
  let s = String(v ?? "");
  // Spreadsheets run a cell that starts with = + - @ (or tab/CR) as a formula; a leading ' keeps it text.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

function buildCsv() {
  const folderTitle = S.folders.find((f) => String(f.id) === S.mediaId)?.title || "";
  const header = ["收藏夹", "BV号", "标题", "UP主", "时长", "链接", "AI判断", "判断来源", "理由", "一句话", "要点", "标签", "我的处理", "处理时间", "是否失效"];
  const rows = [header];
  for (const it of S.items) {
    const v = verdictOf(it);
    const a = S.analyses[it.bvid];
    const done = a?.status === "done";
    const d = S.decisions[it.bvid];
    rows.push([
      folderTitle,
      it.bvid,
      it.title,
      it.upper,
      fmtDuration(it.duration),
      videoUrl(it.bvid),
      v.verdict === "none" || !tiers() ? "" : verdictLabel(v.verdict),
      ["", "标题粗分", "字幕细看", "AI 指令"][v.stage] || "",
      v.reason,
      done ? a.oneLiner || "" : "",
      done ? (a.points || []).join(" | ") : "",
      tagIdsOf(it.bvid).map((id) => tagById(id).name).join("、"),
      d ? (d.action === "unfav" ? "取消收藏" : "保留") : "",
      d ? fmtTime(d.at) : "",
      it.invalid ? "是" : "否"
    ]);
  }
  return "﻿" + rows.map((r) => r.map(csvField).join(",")).join("\r\n") + "\r\n";
}

// ---------- events ----------
function bindEvents() {
  el.folderSelect.addEventListener("change", () => openFolder(el.folderSelect.value));
  el.refreshBtn.addEventListener("click", () => S.mediaId && syncFolder({ force: true }));
  const autoSync = () => {
    if (S.mediaId && document.visibilityState === "visible") syncFolder();
  };
  window.addEventListener("focus", autoSync);
  document.addEventListener("visibilitychange", autoSync);

  const showTab = (tab) => {
    S.tab = tab;
    S.focusIndex = 0;
    S.focused = "";
    el.list.scrollTop = 0;
    render();
  };
  el.tabs.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-tab]");
    if (btn) showTab(btn.dataset.tab);
  });
  el.tagFilter.addEventListener("click", (e) => {
    const open = e.target.closest("[data-tags-open]")?.dataset.tagsOpen;
    if (open) return openSchemeEditor(open);
    const btn = e.target.closest("[data-tagfilter]");
    if (!btn) return;
    const id = btn.dataset.tagfilter;
    if (S.tagFilter.has(id)) S.tagFilter.delete(id);
    else S.tagFilter.add(id);
    render();
  });

  el.listHeader.addEventListener("click", (e) => {
    const go = e.target.closest("[data-goto]");
    if (go) return showTab(go.dataset.goto);
    const filter = e.target.closest("[data-act-filter]");
    if (filter) {
      S.actFilter = filter.dataset.actFilter;
      return render();
    }
    const btn = e.target.closest("[data-head]");
    if (!btn) return;
    const act = btn.dataset.head;
    if (act === "stage1") {
      if (!S.stage1.running) return runStage1();
      S.stage1.stop = true;
      S.status = "粗分将在当前批次后暂停";
      renderStatus();
    } else if (act === "group") {
      if (S.group) {
        S.group.stop = true;
        S.status = "细看将在当前视频后暂停";
        return renderStatus();
      }
      const batch = nextBatch();
      for (const b of batch) S.selected.delete(b);
      startGroup(batch);
    } else if (act === "batch-unfav") batchUnfav(btn, batchList(btn.dataset.tier || null));
    else if (act === "batch-keep") batchKeep(batchList(btn.dataset.tier || null));
    else if (act === "edit-scheme") openSchemeEditor("criteria");
    else if (act === "extra") {
      S.extraOpen = true;
      renderListHeader(visibleItems());
      el.listHeader.querySelector("[data-extra]")?.focus();
    } else if (act === "copy-read") {
      navigator.clipboard.writeText(buildReadMarkdown(visibleItems())).then(
        () => toast("已复制 Markdown"),
        (err) => toast(`复制失败：${err.message}`, true)
      );
    } else if (act === "download-read") {
      const filename = `MoonDigest-${safeNoteName(folderTitle())}-${stamp(new Date(), false)}.md`;
      BocDownload.text(filename, buildReadMarkdown(visibleItems()));
      toast("已下载 .md");
    } else if (act === "clear-selected") {
      S.selected.clear();
      render();
    }
  });

  el.listHeader.addEventListener("input", (e) => {
    if (e.target.matches("[data-extra]")) S.extra = e.target.value;
  });
  el.listHeader.addEventListener("change", (e) => {
    if (!e.target.matches("[data-read-stage]")) return;
    S.readStage = e.target.value;
    render();
  });

  el.list.addEventListener("click", (e) => {
    const refav = e.target.closest("[data-refav]");
    if (refav) return refavRecent(refav.dataset.refav);
    if (e.target.closest("[data-retry-failed]")) return retryFailed();
    const card = e.target.closest(".card");
    if (!card) return;
    const bvid = card.dataset.bvid;
    const act = e.target.closest("[data-act]")?.dataset.act;
    setFocus(bvid, false);
    if (act) cardAction(act, bvid);
  });

  el.list.addEventListener("input", (e) => {
    if (!e.target.matches("[data-note]")) return;
    const b = e.target.closest(".card").dataset.bvid;
    const text = e.target.value.trim();
    if (text) S.notes[b] = { text: e.target.value, updatedAt: Date.now() };
    else delete S.notes[b];
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => {
      noteTimer = 0;
      storeSet(K.notes, S.notes);
    }, 400);
  });
  // An emptied note folds back to 「+ 备注」.
  el.list.addEventListener("focusout", (e) => {
    if (!e.target.matches("[data-note]") || e.target.value.trim()) return;
    S.noteOpen.delete(e.target.closest(".card").dataset.bvid);
    setTimeout(renderList);
  });

  document.addEventListener("keydown", onKey);

  el.settingsBtn.addEventListener("click", () => openSettings());
  for (const input of [el.thinkingInput, el.batchSizeInput, el.titleMaxInput, el.analyzeMaxInput]) {
    input.addEventListener("input", renderTokenHints);
  }
  el.settingsDialog.querySelector("form").addEventListener("submit", (e) => {
    if (e.submitter?.value !== "save") return;
    const bad = [el.titleMaxInput, el.analyzeMaxInput].filter((input) => parseMaxTokens(input.value) === null);
    el.settingsError.hidden = !bad.length;
    if (bad.length) {
      e.preventDefault();
      el.settingsError.textContent = "输出上限需为整数：0 或留空表示自动，否则在 200–32000 之间";
      bad[0].focus();
    }
  });
  el.settingsDialog.addEventListener("close", async () => {
    if (el.settingsDialog.returnValue !== "save") return;
    const patch = {
      triageIntervalSec: Math.max(0, Number(el.intervalInput.value) || 0),
      triageTitleBatchSize: Math.max(1, Math.min(100, Number(el.batchSizeInput.value) || 30)),
      triageExportFolder: el.exportFolderInput.value.trim(),
      triageThinking: el.thinkingInput.checked,
      triageTitleMaxTokens: parseMaxTokens(el.titleMaxInput.value),
      triageAnalyzeMaxTokens: parseMaxTokens(el.analyzeMaxInput.value)
    };
    const r = await send({ type: "triage-settings-save", ...patch });
    if (!r.ok) {
      toast(`保存设置失败：${r.error}`, true);
      return;
    }
    Object.assign(S.settings, patch);
    toast("设置已保存");
  });
  el.writeBtn.addEventListener("click", openWrite);
  el.writeScope.addEventListener("change", renderWriteScope);
  el.writeRunBtn.addEventListener("click", () => runWrite());
  el.writeMdBtn.addEventListener("click", () => runWrite(true));
  el.writeStopBtn.addEventListener("click", () => {
    S.write.stop = true;
    el.writeProgress.textContent = "将在当前视频后停止…";
  });
  el.writeDialog.addEventListener("close", () => {
    if (S.write.running) S.write.stop = true;
  });
  el.openOptionsBtn.addEventListener("click", () => send({ type: "open-options" }));
  el.backupBtn.addEventListener("click", async () => {
    try {
      BocDownload.text(`MoonDigest备份-${stamp()}.json`, JSON.stringify(await buildBackup(), null, 2), "application/json");
    } catch (err) {
      toast(`导出备份失败：${err.message}`, true);
    }
  });
  el.csvBtn.addEventListener("click", () => {
    if (!S.items.length) {
      toast("当前收藏夹没有视频可导出", true);
      return;
    }
    const title = (S.folders.find((f) => String(f.id) === S.mediaId)?.title || S.mediaId).replace(/[\\/:*?"<>|]/g, "_");
    BocDownload.text(`MoonDigest-${title}-${stamp(new Date(), false)}.csv`, buildCsv(), "text/csv;charset=utf-8");
  });
  el.cleanCacheBtn.addEventListener("click", cleanCache);
  el.helpBtn.addEventListener("click", () => el.helpDialog.showModal());

  el.syncViewBtn.addEventListener("click", () => (el.syncDetail.hidden = !el.syncDetail.hidden));
  el.syncCloseBtn.addEventListener("click", () => (el.syncNotice.hidden = true));
  el.bannerClose.addEventListener("click", () => (el.banner.hidden = true));

  // tag picker
  el.pickerInput.addEventListener("input", () => {
    picker.index = 0;
    renderPicker();
  });
  el.pickerInput.addEventListener("keydown", (e) => {
    if (e.isComposing) return; // Enter confirms the IME candidate, not the tag
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const n = picker.options.length;
      if (n) picker.index = (picker.index + (e.key === "ArrowDown" ? 1 : n - 1)) % n;
      renderPicker();
    } else if (e.key === "Enter") {
      e.preventDefault();
      pickOption(picker.index);
    }
  });
  el.pickerList.addEventListener("mousedown", (e) => {
    const li = e.target.closest("[data-i]");
    if (!li) return;
    e.preventDefault();
    picker.index = Number(li.dataset.i);
    pickOption(picker.index);
    el.pickerInput.focus();
  });
  el.pickerDialog.addEventListener("close", closePicker);
  // A backdrop click closes and saves like Esc. The dialog's own padding is also the dialog element, so check the point too.
  el.pickerDialog.addEventListener("click", (e) => {
    if (e.target !== el.pickerDialog) return;
    const r = el.pickerDialog.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) el.pickerDialog.close();
  });

  // schemes: edits apply and save as they happen, like the tag rows
  el.schemeSelect.addEventListener("change", () => {
    const v = el.schemeSelect.value;
    el.schemeSelect.value = scheme().id;
    if (v === "__edit") openSchemeEditor();
    else if (v === "__new") newScheme();
    else setFolderScheme(v);
  });
  el.manageTagsBtn.addEventListener("click", () => openSchemeEditor("tags"));
  el.schemeName.addEventListener("change", () => {
    const name = el.schemeName.value.trim();
    if (!name || S.schemes.some((x) => x !== scheme() && x.name === name)) {
      toast(name ? "已有同名方案" : "方案名不能为空", true);
      el.schemeName.value = scheme().name;
      return;
    }
    scheme().name = name;
    saveSchemes();
    render();
  });
  el.schemeCriteria.addEventListener("change", () => {
    scheme().criteria = el.schemeCriteria.value.trim();
    saveSchemes();
    render();
  });
  el.ownTagsInput.addEventListener("change", () => {
    scheme().onlyMyTags = el.ownTagsInput.checked;
    saveSchemes();
    render();
  });
  el.gradingInput.addEventListener("change", () => {
    const x = scheme();
    // savedTiers keeps the tiers while grading is off, so switching it back on restores them.
    if (el.gradingInput.checked) {
      x.grading = { tiers: x.savedTiers || structuredClone(DEFAULT_TIERS) };
      delete x.savedTiers;
    } else {
      x.savedTiers = x.grading?.tiers;
      x.grading = null;
    }
    S.actFilter = "all";
    saveSchemes();
    renderTiers();
    render();
  });
  el.addTierBtn.addEventListener("click", () => {
    const ts = tiers();
    ts.push({ id: `tier-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, name: `档位 ${ts.length + 1}`, description: "", route: "keep" });
    saveSchemes();
    renderTiers();
    render();
    el.tierRows.querySelector(".tier-row:last-child [data-tier=name]")?.select();
  });
  el.tierRows.addEventListener("change", (e) => {
    const t = tiers()?.find((x) => x.id === e.target.closest(".tier-row")?.dataset.id);
    const field = e.target.dataset.tier;
    if (!t) return;
    if (field === "name") {
      const name = e.target.value.trim();
      if (!name || tiers().some((x) => x !== t && x.name === name)) {
        toast(name ? "已有同名档位" : "档位名不能为空", true);
        e.target.value = t.name;
        return;
      }
      t.name = name;
    } else if (field === "description") t.description = e.target.value.trim();
    else if (field === "route") t.route = e.target.value;
    saveSchemes();
    render();
  });
  el.tierRows.addEventListener("click", (e) => {
    if (e.target.dataset.tier === "delete") deleteTier(e.target.closest(".tier-row").dataset.id);
  });
  el.deleteSchemeBtn.addEventListener("click", deleteScheme);
  el.tagsRows.addEventListener("change", (e) => {
    const row = e.target.closest(".tag-row");
    const t = row && tagById(row.dataset.id);
    if (!t) return;
    if (e.target.dataset.field === "color") t.color = e.target.value;
    if (e.target.dataset.field === "description") t.description = e.target.value.trim();
    if (e.target.dataset.field === "name") {
      const name = e.target.value.trim();
      if (!name || S.tags.some((x) => x !== t && x.name === name)) {
        toast(name ? "已有同名标签" : "标签名不能为空", true);
        e.target.value = t.name;
        return;
      }
      t.name = name;
    }
    saveTags();
    render();
  });
  el.tagsRows.addEventListener("click", (e) => {
    const btn = e.target.closest('[data-field="delete"]');
    if (btn) deleteTag(btn.closest(".tag-row").dataset.id);
  });
  const addTag = () => {
    const name = el.newTagInput.value.trim();
    if (!name) return;
    createTag(name);
    el.newTagInput.value = "";
    renderTagManager();
    render();
  };
  el.addTagBtn.addEventListener("click", addTag);
  el.newTagInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addTag();
    }
  });

  // AI command
  el.aiBtn.addEventListener("click", openAi);
  el.aiScope.addEventListener("change", renderAiForm);
  el.aiHistory.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-h]");
    if (btn) el.aiInstruction.value = S.aiHistory[Number(btn.dataset.h)];
  });
  el.aiRunBtn.addEventListener("click", runAiCommand);
  el.aiStopBtn.addEventListener("click", () => {
    S.ai.stop = true;
    el.aiProgress.textContent = "将在当前批次完成后停止…";
  });
  el.aiCloseBtn.addEventListener("click", () => el.aiDialog.close());
  el.aiNewTags.addEventListener("change", (e) => {
    const t = S.ai.proposal?.newTags[Number(e.target.closest(".ai-newtag")?.dataset.i)];
    if (t && e.target.dataset.nt === "checked") {
      t.checked = e.target.checked;
      renderAiRows();
    }
  });
  el.aiNewTags.addEventListener("input", (e) => {
    const t = S.ai.proposal?.newTags[Number(e.target.closest(".ai-newtag")?.dataset.i)];
    const field = e.target.dataset.nt;
    if (!t || (field !== "name" && field !== "description")) return;
    t[field] = e.target.value;
    if (field === "name") renderAiRows();
  });
  el.aiRows.addEventListener("change", (e) => {
    if (!e.target.matches("[data-row]")) return;
    const row = S.ai.proposal?.rows.find((r) => r.bvid === e.target.closest(".ai-row").dataset.bvid);
    if (row) row.checked = e.target.checked;
    renderAiRows();
  });
  const setAllRows = (checked) => {
    for (const r of S.ai.proposal?.rows || []) r.checked = checked;
    renderAiRows();
  };
  el.aiAllBtn.addEventListener("click", () => setAllRows(true));
  el.aiNoneBtn.addEventListener("click", () => setAllRows(false));
  el.aiDiscardBtn.addEventListener("click", () => {
    S.ai.proposal = null;
    showAiForm();
    renderTop();
  });
  el.aiApplyBtn.addEventListener("click", applyAiProposal);

  // basket
  el.basketToggle.addEventListener("click", () => {
    const collapsed = el.basket.classList.toggle("collapsed");
    el.basketToggle.setAttribute("aria-expanded", String(!collapsed));
  });
  if (matchMedia("(max-width: 899px)").matches) {
    el.basket.classList.add("collapsed");
    el.basketToggle.setAttribute("aria-expanded", "false");
  }
  el.basketList.addEventListener("click", (e) => {
    if (e.target.dataset.basket !== "remove") return;
    const i = Number(e.target.closest(".basket-item").dataset.i);
    S.basket.splice(i, 1);
    saveBasket();
    renderBasket();
    render();
  });
  el.copyMdBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(buildMarkdown());
      toast("已复制 Markdown");
    } catch (err) {
      toast(`复制失败：${err.message}`, true);
    }
  });
  el.downloadMdBtn.addEventListener("click", downloadBasket);
  el.exportBtn.addEventListener("click", exportBasket);
}

// Returns 0 for auto, the integer for 200–32000, or null when invalid.
function parseMaxTokens(value) {
  const s = String(value ?? "").trim();
  if (!s) return 0;
  const n = Number(s);
  if (!Number.isInteger(n)) return null;
  return n === 0 || (n >= 200 && n <= 32000) ? n : null;
}

function renderTokenHints() {
  const batch = Math.max(1, Number(el.batchSizeInput.value) || 30);
  const on = el.thinkingInput.checked;
  const titleAuto = on ? 150 * batch + 4000 : 60 * batch + 200;
  const analyzeAuto = on ? 8000 : 1000;
  el.titleMaxHint.textContent = `留空为自动 = ${titleAuto}（每批 ${batch} 个，思考${on ? "开" : "关"}）。只有提示“输出被截断”时才需要调大。`;
  el.analyzeMaxHint.textContent = `留空为自动 = ${analyzeAuto}（思考${on ? "开" : "关"}）`;
}

function openSettings(scrollToLimits = false) {
  el.thinkingRow.hidden = !S.settings.deepseek;
  el.intervalInput.value = S.settings.triageIntervalSec ?? 8;
  el.batchSizeInput.value = S.settings.triageTitleBatchSize ?? 30;
  el.exportFolderInput.value = S.settings.triageExportFolder || "";
  el.thinkingInput.checked = Boolean(S.settings.triageThinking);
  el.titleMaxInput.value = S.settings.triageTitleMaxTokens || "";
  el.analyzeMaxInput.value = S.settings.triageAnalyzeMaxTokens || "";
  el.settingsError.hidden = true;
  renderTokenHints();
  el.settingsDialog.returnValue = "";
  el.settingsDialog.showModal();
  if (scrollToLimits) el.titleMaxInput.scrollIntoView({ block: "center" });
}

function cardAction(act, bvid) {
  const it = S.itemMap.get(bvid);
  if (!it) return;
  if (act === "open") openTab(videoUrl(bvid));
  else if (act === "ask") askAi(it);
  else if (act === "unfav") decide(bvid, "unfav");
  else if (act === "keep") decide(bvid, "keep");
  else if (act === "tag") openPicker(bvid);
  else if (act === "accept") acceptSuggestions(bvid);
  else if (act === "basket") toggleBasket(bvid);
  else if (act === "retry") retry(bvid);
  else if (act === "note") {
    S.noteOpen.add(bvid);
    renderList();
    el.list.querySelector(`.card[data-bvid="${CSS.escape(bvid)}"] [data-note]`)?.focus();
  }
  else if (act === "select") {
    if (S.selected.has(bvid)) S.selected.delete(bvid);
    else if (S.selected.size >= SELECT_CAP) {
      toast(`一次最多选中 ${SELECT_CAP} 个`, true);
      return;
    } else S.selected.add(bvid);
    render();
  }
}

function onKey(e) {
  if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
  if (document.querySelector("dialog[open]")) return;
  const t = e.target;
  if (t.closest?.("input, textarea, select, [contenteditable]")) return;
  if ((e.key === "Enter" || e.key === " ") && t.closest?.("button, a")) return;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const map = {
    "?": () => el.helpDialog.showModal(),
    i: () => openAi()
  };
  const nav = { j: 1, ArrowDown: 1, k: -1, ArrowUp: -1 };
  const cardKeys = { d: "unfav", s: "keep", t: "tag", a: "accept", e: "basket", q: "ask", x: "select", o: "open", Enter: "open" };
  if (map[key]) map[key]();
  else if (S.tab === "read") return;
  else if (nav[key]) moveFocus(nav[key]);
  else if (key === "u") undo();
  else if (cardKeys[key] && S.focused) cardAction(cardKeys[key], S.focused);
  else return;
  e.preventDefault();
}
