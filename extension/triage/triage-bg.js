// MoonDigest 收藏夹分拣台 background 层。classic script，由 background.js 末尾 importScripts 加载，
// 与 background.js 共享全局作用域，所以顶层名字统一带 triage / TRIAGE_ 前缀。
// 纯函数放顶部（selftest 用 vm 加载，chrome 为 undefined）。日期、时长、标签名用页面同一份的 TriageUi（shared.js，在本文件前加载）。

// ===== 纯函数 =====

// 从模型输出里取第一个完整的 {...} 或 [...]（去掉 ``` 围栏，跳过字符串里的括号）
function triageExtractJson(content, open) {
  const close = open === "[" ? "]" : "}";
  const s = String(content || "").replace(/```(?:json)?/gi, "");
  const start = s.indexOf(open);
  if (start < 0) throw new Error("AI 回复格式不对");
  let depth = 0, inStr = false, esc = false, end = -1;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close && --depth === 0) { end = i; break; }
  }
  if (end < 0) throw new Error("AI 回复不完整");
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch {
    throw new Error("AI 回复格式不对");
  }
}

// AI 判断固定三档。模型答 id（不分大小写）或中文名（含改名前的旧名）都认，其他一律算拿不准。
const TRIAGE_VERDICT_ALIASES = { 留: "keep", 可以删: "drop", 待定: "unsure" };
function triageVerdict(v) {
  const s = String(v ?? "").trim();
  const id = s.toLowerCase();
  const names = MdgTagCore.VERDICTS;
  if (names[id]) return id;
  return Object.keys(names).find((k) => names[k] === s) || TRIAGE_VERDICT_ALIASES[s] || "unsure";
}

// tags 是标签名列表，或 [{ name, rule }]
function triageTagNames(tags) {
  return (Array.isArray(tags) ? tags : []).map((t) => String((t && typeof t === "object" ? t.name : t) ?? "").trim()).filter(Boolean);
}

// 提示词里的标签：有说明写「名称：说明」，没有只写名称
function triageTagLines(tags) {
  return (Array.isArray(tags) ? tags : [])
    .map((t) => {
      const name = triageTagNames([t])[0];
      const rule = t && typeof t === "object" ? String(t.rule ?? "").replace(/\s+/g, " ").trim().slice(0, 80) : "";
      return name && (rule ? `${name}：${rule}` : name);
    })
    .filter(Boolean);
}

function triageParseLlm(content) {
  const obj = triageExtractJson(content, "{");
  const oneLiner = String(obj.one_liner ?? obj.oneLiner ?? "").trim();
  if (!oneLiner) throw new Error("AI 回复缺少一句话总结");
  const points = (Array.isArray(obj.points) ? obj.points : [])
    .map((p) => String(p ?? "").trim())
    .filter(Boolean)
    .slice(0, 3);
  while (points.length < 3) points.push("");
  return { oneLiner, points, verdict: triageVerdict(obj.verdict), reason: String(obj.reason ?? "").trim() };
}

// items 与发给模型的序号一一对应（序号从 1 开始）
function triageParseTitleBatch(content, items) {
  const arr = triageExtractJson(content, "[");
  const byIndex = new Map();
  for (const r of Array.isArray(arr) ? arr : []) {
    const i = Number(r?.i);
    if (Number.isInteger(i) && !byIndex.has(i)) byIndex.set(i, r);
  }
  const results = {};
  items.forEach((item, idx) => {
    const r = byIndex.get(idx + 1);
    results[item.bvid] = r
      ? {
          verdict: triageVerdict(r.verdict),
          reason: String(r.reason ?? "").trim(),
          confidence: String(r.confidence || "").trim().toLowerCase() === "high" ? "high" : "low"
        }
      : { verdict: "unsure", reason: "AI 未返回", confidence: "low" };
  });
  return results;
}

function triageTitleLine(item, n) {
  const clean = (s) => String(s ?? "").replace(/[|\r\n]+/g, " ").trim();
  return `${n}|${clean(item.title)}|${clean(item.upper)}|${TriageUi.fmtDuration(item.duration)}|${TriageUi.fmtDate(item.pubdate)}|${clean(item.intro).slice(0, TriageUi.INTRO_CHARS)}`;
}

// 序号|标题|UP|时长|简介前 INTRO_CHARS 字|现有标签|一句话|要点1；要点2；要点3（没有的字段留空）
function triageCommandLine(item, n) {
  const clean = (s) => String(s ?? "").replace(/[|\r\n]+/g, " ").trim();
  const list = (a) => (Array.isArray(a) ? a.map(clean).filter(Boolean) : []);
  return [n, clean(item.title), clean(item.upper), Number(item.duration) ? TriageUi.fmtDuration(item.duration) : "", clean(item.intro).slice(0, TriageUi.INTRO_CHARS), list(item.currentTags).join("、"), clean(item.oneLiner), list(item.points).join("；")].join("|");
}

// 批量打标签的提案只改标签：add 只留已有标签或本次新建的标签（至多 maxNewTags 个），remove 只留视频现有标签且要 allowRemove；
// 其他字段（如 verdict）一律丢弃，无改动的视频不返回
function triageParseCommand(content, items, tags, { maxNewTags = 5, allowRemove = false } = {}) {
  const obj = triageExtractJson(content, "{");
  const existing = new Set(triageTagNames(tags));
  const newTags = [];
  for (const t of Array.isArray(obj.new_tags) ? obj.new_tags : []) {
    if (newTags.length >= maxNewTags) break;
    const name = TriageUi.cleanTagName(t && typeof t === "object" ? t.name : t);
    if (name && !existing.has(name) && !newTags.includes(name)) newTags.push(name);
  }
  const valid = new Set([...existing, ...newTags]);
  const byIndex = new Map();
  for (const r of Array.isArray(obj.items) ? obj.items : []) {
    const i = Number(r?.i);
    if (Number.isInteger(i) && !byIndex.has(i)) byIndex.set(i, r);
  }
  const assignments = {};
  items.forEach((item, idx) => {
    const r = byIndex.get(idx + 1);
    if (!r || !item?.bvid) return;
    const current = new Set(triageTagNames(item.currentTags));
    const pick = (arr, ok) => [...new Set((Array.isArray(arr) ? arr : []).map((x) => TriageUi.cleanTagName(x)))].filter((x) => x && ok(x));
    const a = {
      add: pick(r.add, (x) => valid.has(x) && !current.has(x)),
      remove: allowRemove ? pick(r.remove, (x) => current.has(x)) : []
    };
    if (a.add.length || a.remove.length) assignments[item.bvid] = a;
  });
  return { newTags, assignments, note: String(obj.note ?? "").trim() };
}

function triageForm(obj) {
  return new URLSearchParams(Object.entries(obj).map(([k, v]) => [k, String(v)])).toString();
}

// 判断都相对这个收藏夹的用途：娱乐收藏夹里的好段子是「值得留」，不是「可清理」。
const TRIAGE_VERDICT_TEXT = [
  "verdict 只能是下面三个之一，都按这个收藏夹的用途判断：",
  "- keep：值得留。符合这个收藏夹的用途，以后还会想看或用到。",
  "- drop：可清理。和收藏夹用途不符、内容过时、标题党、空洞，或主要是广告。",
  "- unsure：拿不准。信息太少，判断不了。"
].join("\n");

const TRIAGE_SYSTEM_PROMPT = [
  "你是 B站收藏夹分拣助手。根据给出的视频信息总结视频，并按这个收藏夹的用途判断值得留还是可清理。",
  "只输出严格 JSON，不要任何其他文字、不要代码块：",
  '{"one_liner": "一句话说清视频讲了什么，≤40字", "points": ["要点1", "要点2", "要点3"], "verdict": "keep|drop|unsure", "reason": "判断理由，≤30字"}',
  TRIAGE_VERDICT_TEXT,
  "信息太少无法判断时（只有标题简介且简介很短）选 unsure。"
].join("\n");

const TRIAGE_TITLE_PROMPT = [
  "你是 B站收藏夹分拣助手。下面每行是一个收藏的视频，格式：序号|标题|UP主|时长|发布日期|简介前120字。",
  "只根据这些信息做初筛。标题是很弱的证据：看不出实际内容时，verdict 用 unsure，confidence 用 low，不要猜。",
  TRIAGE_VERDICT_TEXT,
  "confidence：只有标题和简介足以判断时才用 high，否则用 low。",
  "只输出严格 JSON 数组，每个视频一项，不要任何其他文字、不要代码块：",
  '[{"i": 序号, "verdict": "keep|drop|unsure", "reason": "≤20字", "confidence": "high|low"}]'
].join("\n");

// folder 是 { title, intro }，criteria 是这个收藏夹的判断标准；都可以为空
function triageWithCriteria(system, criteria, folder) {
  const text = String(criteria ?? "").trim();
  const title = String(folder?.title ?? "").trim();
  const intro = String(folder?.intro ?? "").trim();
  const parts = [system];
  if (title) {
    parts.push(`这个收藏夹叫「${title}」${intro ? `，简介：${intro}` : ""}。${text ? "" : "用户没写判断标准，从收藏夹名和简介推测它的用途；推测不出时，按「以后还会不会想看」判断。"}`);
  }
  if (text) parts.push(`用户的判断标准（优先于上面的说明）：\n${text}`);
  return parts.join("\n\n");
}

// subtitle is "" when the video has none; then comments (the hot comments, numbered) stand in for it.
function triageBuildMessages(meta, subtitle, comments, criteria, folder) {
  const user = [
    `标题：${meta.title}`,
    `UP主：${meta.upper}`,
    `分区：${meta.tname || "未知"}`,
    `时长：${Math.round((meta.duration || 0) / 60)} 分钟`,
    `发布：${meta.pubdate || "未知"}`,
    `标签：${meta.tags.join("、") || "无"}`,
    `简介：${meta.desc || "无"}`,
    subtitle ? `\n字幕：\n${subtitle}` : `\n（无可用字幕）\n热门评论：\n${comments || "无"}`
  ].join("\n");
  return [
    { role: "system", content: triageWithCriteria(TRIAGE_SYSTEM_PROMPT, criteria, folder) },
    { role: "user", content: user }
  ];
}

// 批量打标签的提示词：收藏夹给视频打，关注（follow-bg.js 的 FOLLOW_AI_UNIT）给 UP 主打，规则同一份。unit 说明对象是谁
// （noun 前后的空格按中文排版给）、主要看什么（basis）、列表每行的格式（header、line）。
const TRIAGE_AI_UNIT = {
  intro: "你是 B站收藏整理助手，按用户指令给视频打标签、做分类。",
  noun: "视频",
  basis: "- 有“一句话”和“要点”的视频以它们为主要依据，它们比标题可靠得多。",
  header: "视频列表，每行格式：序号|标题|UP主|时长|简介前120字|现有标签|一句话|要点1；要点2；要点3（没有的字段留空）：",
  line: triageCommandLine
};
function triageBuildCommandMessages({ instruction, tags, items, maxNewTags = 5, allowRemove = false, unit = TRIAGE_AI_UNIT }) {
  const lines = triageTagLines(tags);
  const { noun } = unit;
  const example = `{"new_tags": ["标签名"], "items": [{"i": 序号, "add": ["标签"], "remove": ["标签"]}], "note": "≤60字"}`;
  const system = [
    unit.intro,
    "用户指令写在 <<<指令>>> 和 <<<指令结束>>> 之间，它就是本次任务的要求。",
    "规则：",
    "- add 只能用已有标签名，或本次 new_tags 里列出的新标签名。",
    maxNewTags > 0
      ? `- 可以新建标签，至多 ${maxNewTags} 个，名称 ≤12字、不含逗号；已有标签能用就先用，不要重复造。`
      : "- 这次不能新建标签，new_tags 留空，只用已有标签。",
    allowRemove ? `- remove 只能填该${noun}“现有标签”里的名称。` : `- 这次不能去掉${noun}已有的标签，remove 留空，只加标签。`,
    `- 标签带说明（冒号后）的，按说明决定给${noun}加上还是去掉这个标签。`,
    `- 一个${noun}可以加多个标签，也可以一个都不加；指令或标签说明要求只选一个时（比如分档：入门 / 进阶 / 硬核），每个${noun}只加其中一个。`,
    `- 指令不适用的${noun}不要放进 items。`,
    "- note ≤60字，总结做了什么，或者为什么没有合适的。",
    unit.basis,
    "只输出严格 JSON，不要任何其他文字、不要代码块：",
    example,
    "",
    "已有标签（每行一个，格式：名称：说明，没有说明只写名称）：",
    ...(lines.length ? lines : ["（无）"])
  ].join("\n");
  const user = ["<<<指令>>>", String(instruction ?? "").trim(), "<<<指令结束>>>", "", unit.header, ...items.map((it, idx) => unit.line(it, idx + 1))].join("\n");
  return [
    { role: "system", content: system },
    { role: "user", content: user }
  ];
}

// ===== chrome 相关 =====

function triageError(error, code) {
  return Object.assign(new Error(error), code ? { code } : {});
}

// Risk control answers HTTP 412 with an HTML page, or one of these codes in JSON; both mean back off.
// follow-bg.js and the video page (content.js) use the same set.
const BILI_RISK_CODES = MdgSites.BILI_RISK_CODES;
async function triageBiliJson(res) {
  if (!res.ok) throw Object.assign(triageError(`B站请求失败 HTTP ${res.status}`, res.status === 412 ? "THROTTLED" : undefined), { status: res.status });
  try {
    return await res.json();
  } catch {
    throw triageError("B站返回的不是 JSON（可能被风控拦截或需要重新登录）");
  }
}

// -101 (and a missing bili_jct or nav's isLogin) is NOT_LOGGED_IN, which the page answers with its 去登录 banner.
// follow-bg.js maps its -101 with it too.
const triageNotLoggedIn = () => triageError(MdgErrors.TEXT.biliLogin, "NOT_LOGGED_IN");
function triageBiliData(json) {
  if (json.code === -101) throw triageNotLoggedIn();
  if (json.code !== 0) throw triageError(`B站返回 ${json.code}：${json.message}`, BILI_RISK_CODES.has(json.code) ? "THROTTLED" : undefined);
  return json.data;
}

// The one B站 channel of both modes (GET and POST) and the video page's fetch-json. No answer in
// TRIAGE_BILI_CFG.timeoutMs (MdgErrors.NET_TIMEOUT_MS, the video page's own fetches use it too), or a dropped
// connection, is NETWORK.
const TRIAGE_BILI_CFG = { timeoutMs: MdgErrors.NET_TIMEOUT_MS };
async function triageBiliFetch(url, init = {}) {
  const ctl = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(MdgErrors.netTimeout(TRIAGE_BILI_CFG.timeoutMs)), { timedOut: true })), TRIAGE_BILI_CFG.timeoutMs);
  });
  try {
    return await Promise.race([fetch(url, { ...init, credentials: "include", signal: ctl.signal }), timeout]);
  } catch (e) {
    ctl.abort();
    // A dropped connection is fetch's TypeError, whose English text the user does not need.
    throw triageError(e?.timedOut ? e.message : e?.name === "TypeError" ? MdgErrors.TEXT.netDown : `${MdgErrors.TEXT.netDown}：${e?.message || e}`, "NETWORK");
  } finally {
    clearTimeout(timer);
  }
}

// What a B站 page's own requests send; from the worker fetch would send no referrer.
const TRIAGE_BILI_GET = { cache: "no-store", referrer: "https://www.bilibili.com/", referrerPolicy: "strict-origin-when-cross-origin" };

// GET → the whole JSON, whatever its code. url may be an async function (WBI: signed again on every try).
// Without pace (收藏夹) it is one try; the caller backs off on THROTTLED. pace (关注's long syncs) =
// { slot, hold, cfg: { strikes, backoffMs, netRetry } }: every try waits for slot(); a dropped connection holds the
// queue netRetry[i] ms and tries again; risk control holds it backoffMs (and drops the WBI key, a stale one answers
// -352 too) and gives up with THROTTLED on the strikes-th time.
async function triageBiliGetJson(url, pace) {
  let net = 0;
  for (let strike = 1; ; strike++) {
    const u = typeof url === "function" ? await url() : url;
    await pace?.slot();
    let json = null;
    try {
      json = await triageBiliJson(await triageBiliFetch(u, TRIAGE_BILI_GET));
    } catch (e) {
      if (!pace) throw e;
      if (e.code === "NETWORK" && net < pace.cfg.netRetry.length) {
        pace.hold(pace.cfg.netRetry[net++], "network");
        strike--;
        continue;
      }
      if (e.code !== "THROTTLED") throw e;
    }
    if (json && !(pace && BILI_RISK_CODES.has(json.code))) return json;
    if (strike >= pace.cfg.strikes) throw triageError(MdgErrors.TEXT.biliThrottled, "THROTTLED");
    if (typeof url === "function") MdgSites.biliWbiReset();
    pace.hold(pace.cfg.backoffMs, "throttled");
  }
}

async function triageBiliGet(url) {
  return triageBiliData(await triageBiliGetJson(url));
}

async function triageBiliPost(path, fields) {
  const cookie = await chrome.cookies.get({ url: "https://www.bilibili.com", name: "bili_jct" });
  if (!cookie?.value) throw triageNotLoggedIn();
  // A write is tried once. Without an answer B站 may or may not have done it, so callers keep their state as before
  // (no count change, no undo step) and the message says to look.
  const res = await triageBiliFetch(`https://api.bilibili.com${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: triageForm({ ...fields, csrf: cookie.value })
  }).catch((e) => {
    throw e.code === "NETWORK" ? triageError("网络超时或断开：不确定 B站 是否已改，刷新后看一下", "NETWORK") : e;
  });
  return triageBiliData(await triageBiliJson(res));
}

// The sites.js fetchers (细看, notes, the side panel follow-up) through the same channel, one try. sites.js's B站
// reads turn risk control into THROTTLED themselves, as for the video page.
const TRIAGE_BILI_IO = { signWbi: true, fetchJson: (url) => triageBiliGetJson(url) };

// nav 未登录时 code=-101，triageBiliGet 会当错误抛出，所以只查 HTTP 与 JSON，由 triageMid 判断登录
async function triageNav() {
  return (await triageBiliGetJson("https://api.bilibili.com/x/web-interface/nav")).data || {};
}

async function triageMid() {
  const nav = await triageNav();
  if (!nav.isLogin || !nav.mid) throw triageNotLoggedIn();
  return nav.mid;
}

// 稍后再看 is listed as one more folder with this id; its own endpoints stand in for the favorites ones.
const TRIAGE_TOVIEW = "toview";

// The whole 稍后再看 list in one request (the paged toview/web endpoint is only for the site's own page).
async function triageToviewList() {
  const data = await triageBiliGet("https://api.bilibili.com/x/v2/history/toview");
  return data?.list || [];
}

// ---------- 看过 (from the Bilibili watch history; read only while 设置页「封面显示」is not 关) ----------
// Bilibili keeps about three months of history. Only what is new since the last read is fetched, at most every
// SEEN_GAP_MS and only when a page asks (the triage page or a Bilibili page opening), so it reads no more than the user
// browsing their own history page would. Each video keeps two numbers under seen_<bvid>: [best percent, last view_at].
const SEEN_GAP_MS = MdgLimits.SEEN_GAP_MS;
const SEEN_BACKOFF_MS = 30 * 60 * 1000;
const SEEN_PAGE_GAP_MS = 5000;
const SEEN_MAX_PAGES = 60;
const SEEN_KEEP_S = MdgLimits.SEEN_KEEP_DAYS * 86400;
const SEEN_MAX = MdgLimits.SEEN_MAX;
const SEEN_PRUNE_GAP_MS = 86400 * 1000;
const SEEN_PREFIX = MdgLimits.KEYS.seenPrefix;
const SEEN_META = MdgLimits.KEYS.triageSeenMeta; // { newest: view_at s, syncedAt, prunedAt, backoffUntil, resume }

// Percent watched from a history item: progress -1 means finished.
function seenPercent(progress, duration) {
  if (progress === -1) return 100;
  if (!(progress > 0) || !(duration > 0)) return 0;
  return Math.min(100, Math.round((progress / duration) * 100));
}

// Folds history items newer than `newest` into { bvid: [percent, view_at] }; done once an older item shows up (pure).
function seenFold(found, list, newest) {
  for (const it of list) {
    if (it.view_at <= newest) return true;
    const b = it.history?.business === "archive" && it.history.bvid;
    const pct = b ? seenPercent(it.progress, it.duration) : 0;
    if (!pct) continue; // autoplay and hover previews leave 0
    const prev = found[b];
    found[b] = [Math.max(prev?.[0] || 0, pct), Math.max(prev?.[1] || 0, it.view_at)];
  }
  return false;
}

// Which seen_ entries to drop: older than SEEN_KEEP_S, or past the newest SEEN_MAX; videos in a chosen folder stay (pure).
function seenPrune(entries, keep, nowS) {
  const sorted = Object.entries(entries).sort((x, y) => y[1][1] - x[1][1]);
  return sorted.filter(([b, [, at]], i) => !keep.has(b) && (nowS - at > SEEN_KEEP_S || i >= SEEN_MAX)).map(([b]) => b);
}

// A first read takes minutes. The answer does not wait for it: Chrome kills a worker whose event stays open 5 minutes,
// and everything else it was running with it. A skip answers at once, a read answers { reading: true } as it starts (or
// is already running) and goes on by itself; pages follow it through triage_seen_meta and hear triage-seen-done.
let seenRun = null;
function seenSync({ force }) {
  if (seenRun) return Promise.resolve({ reading: true });
  let started;
  const start = new Promise((r) => (started = () => r({ reading: true })));
  seenRun = seenSyncOnce(force, started).finally(() => {
    seenRun = null;
    globalThis.chrome?.runtime?.sendMessage?.({ type: "triage-seen-done" })?.catch?.(() => {});
  });
  return Promise.race([start, seenRun]);
}

// 关 drops the stored history (up to SEEN_MAX keys) once any read in flight has written; turning it back on reads afresh.
async function seenClear() {
  await seenRun?.catch(() => {});
  const keys = (await chrome.storage.local.getKeys()).filter((k) => k.startsWith(SEEN_PREFIX));
  await chrome.storage.local.remove([...keys, SEEN_META]);
}

// 封面显示 is on: the history is read only then, checked again before every page (MdgSettings.seenOn, which every reader
// of seenShow uses).
const seenOn = async () => MdgSettings.seenOn((await chrome.storage.sync.get({ seenShow: MdgSettings.DEFAULTS.seenShow })).seenShow);

async function seenSyncOnce(force, started) {
  if (!(await seenOn())) return { skipped: "off" };
  let meta = (await chrome.storage.local.get(SEEN_META))[SEEN_META] || {};
  const now = Date.now();
  if (now < (meta.backoffUntil || 0)) return { skipped: "throttled", until: meta.backoffUntil };
  if (!force && now - (meta.syncedAt || 0) < SEEN_GAP_MS) return { skipped: "recent" };
  // Each page is written as soon as it is read, so the marks show up during a long first read. `newest` moves only when
  // a read gets down to it: one that stops midway (risk control, the worker killed) leaves `resume` (the next page, the
  // newest view_at it saw, pages so far), and the next run reads on from there, then what came in since from the top.
  const START = { max: 0, view_at: 0, business: "" };
  let resumed = Boolean(meta.resume);
  let { cursor = START, top = meta.newest || 0, pages = 0 } = meta.resume || {};
  let ran = 0;
  started();
  try {
    for (;;) {
      if (ran) {
        await new Promise((r) => setTimeout(r, SEEN_PAGE_GAP_MS));
        await chrome.runtime.getPlatformInfo(); // an extension API call keeps the worker alive through a ~5 min first read
        // Turned 关 mid-read: stop before the next page (seenClear is waiting for this run to drop what was read).
        if (!(await seenOn())) return { stopped: "off", pages: ran };
      }
      const data = await triageBiliGet(`https://api.bilibili.com/x/web-interface/history/cursor?ps=30&max=${cursor.max}&view_at=${cursor.view_at}&business=${cursor.business}`);
      ran++;
      pages++;
      const list = data?.list || [];
      for (const it of list) top = Math.max(top, it.view_at || 0);
      const found = {};
      // A read also ends at SEEN_MAX_PAGES: older history is left out.
      const end = seenFold(found, list, meta.newest || 0) || !list.length || !data?.cursor?.max || pages >= SEEN_MAX_PAGES;
      const stored = await chrome.storage.local.get(Object.keys(found).map(MdgLimits.KEYS.seen));
      const write = {};
      for (const [b, [pct, at]] of Object.entries(found)) {
        const old = stored[MdgLimits.KEYS.seen(b)];
        write[MdgLimits.KEYS.seen(b)] = [Math.max(old?.[0] || 0, pct), Math.max(old?.[1] || 0, at)];
      }
      meta = end ? { ...meta, newest: top, syncedAt: now, backoffUntil: 0, resume: null } : { ...meta, resume: { cursor: data.cursor, top, pages } };
      await chrome.storage.local.set({ ...write, [SEEN_META]: meta });
      if (!end) cursor = data.cursor;
      else if (resumed) [resumed, cursor, pages] = [false, START, 0];
      else break;
    }
  } catch (e) {
    // Risk control: stop and stay away for SEEN_BACKOFF_MS from now (not from the start of a read that ran minutes);
    // never retry in a loop. What was read stays, `resume` too.
    if (e.code === "THROTTLED") await chrome.storage.local.set({ [SEEN_META]: { ...meta, backoffUntil: Date.now() + SEEN_BACKOFF_MS } });
    throw e;
  }
  let dropped = 0;
  if (now - (meta.prunedAt || 0) > SEEN_PRUNE_GAP_MS) {
    const all = (await chrome.storage.local.getKeys()).filter((k) => k.startsWith(SEEN_PREFIX));
    const got = await chrome.storage.local.get([...all, MdgLimits.KEYS.triageIncludedFolders]);
    const snaps = await chrome.storage.local.get((got[MdgLimits.KEYS.triageIncludedFolders] || []).map(MdgLimits.KEYS.triageSnapshot));
    const keep = new Set(Object.values(snaps).flatMap((s) => s?.bvids || []));
    const drop = seenPrune(Object.fromEntries(all.map((k) => [k.slice(SEEN_PREFIX.length), got[k]])), keep, Math.floor(now / 1000));
    if (drop.length) await chrome.storage.local.remove(drop.map(MdgLimits.KEYS.seen));
    dropped = drop.length;
    await chrome.storage.local.set({ [SEEN_META]: { ...meta, prunedAt: now } });
  }
  return { pages: ran, dropped };
}

// type 2 = video, the only type triage-folder-items keeps.
async function triageFolderIds(mediaId) {
  if (mediaId === TRIAGE_TOVIEW) return (await triageToviewList()).map((m) => m.bvid);
  const data = await triageBiliGet(`https://api.bilibili.com/x/v3/fav/resource/ids?media_id=${mediaId}&platform=web`);
  return (data || []).filter((m) => m.type === 2).map((m) => m.bvid || m.bv_id);
}

// created/list (paged) is used instead of list-all because only it returns each folder's cover.
async function triageCreatedFolders() {
  const mid = await triageMid();
  const list = [];
  for (let pn = 1; pn <= 20; pn++) {
    const data = await triageBiliGet(`https://api.bilibili.com/x/v3/fav/folder/created/list?up_mid=${mid}&pn=${pn}&ps=50`);
    list.push(...(data?.list || []));
    if (!data?.has_more || !data.list?.length) break;
  }
  // A failed read is not a deleted 稍后再看: toviewUnread tells the page to keep its data and read it next time.
  const toview = await triageBiliGet("https://api.bilibili.com/x/v2/history/toview/web?pn=1&ps=1&viewed=0").catch(() => null);
  return {
    mid,
    ...(toview ? {} : { toviewUnread: true }),
    folders: [
      // 稍后再看 has no folder cover of its own: use the newest unwatched video's cover, like a folder's first video.
      ...(toview ? [{ id: TRIAGE_TOVIEW, title: "稍后再看", count: toview.count || 0, ...(toview.list?.[0]?.pic ? { cover: String(toview.list[0].pic).replace(/^http:\/\//, "https://") } : {}) }] : []),
      ...list.map((f) => ({ id: f.id, title: f.title, count: f.media_count, cover: String(f.cover || "").replace(/^http:\/\//, "https://") }))
    ]
  };
}

// The folder's 判断标准 and the tag names come with each request from the page.
// The numbers' defaults are TriageUi.NUM_SETTINGS (numSetting); null here only lists the key.
const TRIAGE_SETTINGS_DEFAULTS = {
  triageIntervalSec: null,
  triageFineBatchSize: null,
  triageCoarseBatchSize: null,
  triageThinking: false,
  triageTitleMaxTokens: null,
  triageAnalyzeMaxTokens: null,
  triageTagLimit: null,
  triageAiNewTagMax: null,
  triageAiRemoveTags: false,
  triageAiBatchSize: null
};

// 输出上限：用户填了正数就用用户的，否则按是否思考自动（思考 token 计入 max_tokens）
function triageMaxTokens(kind, itemCount, { triageThinking, triageTitleMaxTokens, triageAnalyzeMaxTokens }) {
  // command 与 title 共用 triageTitleMaxTokens
  const custom = Number(kind === "analyze" ? triageAnalyzeMaxTokens : triageTitleMaxTokens);
  if (custom > 0) return Math.floor(custom);
  return TriageUi.autoMaxTokens(kind, itemCount, triageThinking);
}

async function triageAiSettings() {
  const s = await chrome.storage.sync.get({ triageThinking: false, triageTitleMaxTokens: null, triageAnalyzeMaxTokens: null });
  return {
    triageThinking: s.triageThinking === true,
    triageTitleMaxTokens: TriageUi.numSetting("maxTokens", s.triageTitleMaxTokens),
    triageAnalyzeMaxTokens: TriageUi.numSetting("maxTokens", s.triageAnalyzeMaxTokens)
  };
}

async function triageAnalyze({ bvid, force, criteria, folder, aiProviderId }) {
  if (!bvid) throw triageError("缺少 bvid");
  const cacheKey = MdgLimits.KEYS.triageAnalysis(bvid);
  if (!force) {
    const cached = (await chrome.storage.local.get(cacheKey))[cacheKey];
    if (cached) return cached;
  }

  const site = MdgSites.SITES.bilibili;
  const ref = { site: "bilibili", id: bvid, part: null, url: "" };
  const m = await site.fetchMeta(ref, TRIAGE_BILI_IO);
  const meta = { title: m.title, desc: m.description, upper: m.author, duration: m.duration, pubdate: m.uploadDate, tname: m.tname, tags: m.tags };

  let source = "meta";
  let subtitle = "";
  // Throttling reaches the page so it backs off; a failed track list or download falls back to comments and the card
  // says 字幕抓取失败 with the reason. A subtitle that does not match the video's length is used with the video page's warning.
  const got = await MdgSites.loadSubtitle(site, ref, m, TRIAGE_BILI_IO);
  if (got.body.length) {
    source = "subtitle";
    subtitle = MdgLimits.sampleAiSubtitle(got.body.map((l) => l.content).join("\n")).text;
  }
  const comments = subtitle ? "" : (await site.fetchComments(ref, m, TRIAGE_BILI_IO, TriageUi.DEEP_COMMENTS).catch(() => [])).map((c, i) => `${i + 1}. ${c.message}`).join("\n");

  const ai = await triageAiSettings();
  const { content, model } = await triageChat(triageBuildMessages(meta, subtitle, comments, criteria, folder), triageMaxTokens("analyze", 1, ai), ai.triageThinking, aiProviderId);
  const analysis = {
    bvid,
    status: "done",
    source,
    // Bilibili hides subtitles from a logged-out user; the card says so.
    ...(got.needLogin ? { needLogin: true } : {}),
    ...(got.failure ? { subtitleFailure: got.failure } : {}),
    ...(got.mismatch ? { subtitleWarning: MdgNote.subtitleMismatchWarning(got.mismatch) } : {}),
    ...triageParseLlm(content),
    model,
    analyzedAt: Date.now(),
    criteria: String(criteria ?? "").trim()
  };
  await chrome.storage.local.set({ [cacheKey]: analysis });
  return analysis;
}

// AI 平台的 HTTP 错误，粗看 / 细看 / AI 打标签和侧边栏（background.js streamChat）共用这一份分类。
// AI_AUTH、AI_QUOTA、AI_SETUP 之后每个请求都会一样失败，分拣台第一次遇到就停；AI_THROTTLED 等一会儿重试；
// 其余（5xx、400）只算这一个视频或这一批。很多平台余额不足也回 429（OpenAI insufficient_quota、Moonshot
// exceeded_current_quota_error、智谱「余额不足」「欠费」），所以 429 看返回内容；写着限流或「每分钟」的仍算限流
// （Gemini 的每分钟配额也叫 quota）。
const AI_QUOTA_RE = /quota|balance|billing|余额|欠费|额度/i;
const AI_RATE_RE = /rate.?limit|per.?minute|频率|并发/i;
function triageAiHttpError(status, detail = "") {
  const text = String(detail);
  if (status === 401 || status === 403) return triageError("AI 平台的 API Key 无效或没有权限", "AI_AUTH");
  if (status === 402 || (status === 429 && AI_QUOTA_RE.test(text) && !AI_RATE_RE.test(text))) {
    return triageError("AI 平台余额不足或额度已用完，请充值或换一个平台", "AI_QUOTA");
  }
  if (status === 404) return triageError("AI 平台找不到这个接口或模型，请检查接口地址和模型名", "AI_SETUP");
  if (status === 429) return triageError("AI 平台限流", "AI_THROTTLED");
  return triageError(`AI 平台出错（HTTP ${status}）`);
}
const AI_NETWORK_TEXT = "连不上 AI 平台，请检查网络和接口地址";

// Some platforms report quota, rate and moderation failures inside an HTTP 200 body (a stream chunk for the side panel's
// parseOpenAISSE, the whole reply for triageChat). A quota or rate message is classified as an HTTP 429 (a per-minute
// quota is 限流, not 余额不足); otherwise only a Chinese message is shown. null when the body carries no error.
function triageAiBodyError(json) {
  if (!json?.error) return null;
  const detail = typeof json.error === "string" ? json.error : json.error.message || JSON.stringify(json.error);
  if (AI_QUOTA_RE.test(detail) || AI_RATE_RE.test(detail)) return triageAiHttpError(429, detail);
  return triageError(/[\u4e00-\u9fff]/.test(detail) ? `AI 平台返回错误：${detail}` : "AI 平台返回错误");
}

// A non-stream reply's JSON (triageChat, 测试连接's probeAiChatCompletion): not JSON, or an error in the body, throws.
async function triageAiJson(res) {
  // In Chinese, not JSON.parse's SyntaxError.
  const json = await res.json().catch(() => {
    throw triageError("AI 平台的回复不是 JSON");
  });
  const bodyError = triageAiBodyError(json);
  if (bodyError) throw bodyError;
  return json;
}

// 接口地址、模型名、API Key 没填 (an imported settings file carries no keys): the side panel (background.js's chat port),
// 测试连接 (testAiConnection) and 分拣台 (triageChat) check only here, in one set of words. The codes offer 去设置, and
// 分拣台 stops at the first one instead of failing every video. null when the platform can be asked.
function aiProviderProblem(provider, apiKey) {
  if (!String(provider?.baseUrl || "").trim()) return { code: "AI_SETUP", text: "AI 平台的接口地址没填" };
  if (!String(provider?.model || "").trim()) return { code: "AI_SETUP", text: "AI 平台的模型名没填" };
  if (provider.requiresKey !== false && !String(apiKey || "").trim()) return { code: "AI_AUTH", text: "AI 平台的 API Key 没填" };
  return null;
}

// The platform 分拣台's AI requests go to: the side panel's pick (aiProviderId), else the first enabled one. 开启思考
// (triage-settings-get) asks the same, so the switch shows exactly when the requests would carry it.
async function triageProvider(providerId = "") {
  const enabled = (await loadAiProviders()).filter((p) => p.enabled !== false);
  return enabled.find((p) => p.id === providerId) || enabled[0] || null;
}

// 单次 AI 请求的超时（毫秒）。思考模式慢得多；两档都要短于 MV3 单个消息事件约 5 分钟的上限
const TRIAGE_AI_TIMEOUT_MS = { normal: 120000, thinking: 240000 };

// 非流式 chat/completions，只取 message.content（忽略 reasoning_content）
// providerId: the platform picked at the top of the side panel, which the pages send as aiProviderId (triage.js sendRaw);
// unset or no longer enabled, the first enabled one, as in the side panel.
async function triageChat(messages, maxTokens, thinking = false, providerId = "") {
  const provider = await triageProvider(providerId);
  if (!provider) throw triageError(MdgErrors.TEXT.aiNone, "AI_SETUP");
  const apiKey = (await loadAiProviderKeys())[provider.id];
  const problem = aiProviderProblem(provider, apiKey);
  if (problem) throw triageError(problem.text, problem.code);
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const baseUrl = String(provider.baseUrl || "").replace(/\/+$/, "");
  const body = { model: provider.model, stream: false, temperature: 0.3, max_tokens: maxTokens, messages };
  // 思考 token 计入 max_tokens；默认关（DeepSeek 实测 30 标题 3s/815 token，开则约 19s/4579 token）
  if (supportsThinkingToggle(baseUrl)) body.thinking = { type: thinking ? "enabled" : "disabled" };

  const ms = TRIAGE_AI_TIMEOUT_MS[thinking ? "thinking" : "normal"];
  const controller = new AbortController();
  let timer;
  // Racing the timer (not just aborting) also ends a fetch or body read that ignores the abort.
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(triageError(MdgErrors.aiTimeout(ms), "AI_TIMEOUT"));
    }, ms);
  });
  const request = async () => {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal
    }).catch(async () => {
      const denied = await hostPermissionError(baseUrl);
      throw denied ? triageError(denied) : triageError(AI_NETWORK_TEXT, "AI_NETWORK");
    });
    if (!res.ok) throw triageAiHttpError(res.status, await res.text().catch(() => ""));
    // A body that is not JSON is this request's failure.
    const json = await triageAiJson(res);
    const choice = json.choices?.[0];
    if (!choice?.message?.content && choice?.finish_reason === "length") {
      throw triageError("模型输出被截断");
    }
    return { content: choice?.message?.content, model: provider.model };
  };
  try {
    return await Promise.race([request(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function triageClassifyTitles({ items, criteria, folder, aiProviderId }) {
  const list = (Array.isArray(items) ? items : []).filter((it) => it && it.bvid);
  if (!list.length) throw triageError("缺少 items");
  const ai = await triageAiSettings();
  const system = triageWithCriteria(TRIAGE_TITLE_PROMPT, criteria, folder);
  const user = list.map((it, idx) => triageTitleLine(it, idx + 1)).join("\n");
  const { content, model } = await triageChat(
    [
      { role: "system", content: system },
      { role: "user", content: user }
    ],
    triageMaxTokens("title", list.length, ai),
    ai.triageThinking,
    aiProviderId
  );
  const parsed = triageParseTitleBatch(content, list);
  const analyzedAt = Date.now();
  // 结果记下当时的判断标准，标准改了页面才认得出哪些要重新粗看。"AI 未返回" 的不缓存，方便下次重试
  const results = {};
  const toStore = {};
  for (const [bvid, r] of Object.entries(parsed)) {
    results[bvid] = { ...r, criteria: String(criteria ?? "").trim() };
    if (r.reason !== "AI 未返回") toStore[MdgLimits.KEYS.triageTitle(bvid)] = { ...results[bvid], model, analyzedAt };
  }
  await chrome.storage.local.set(toStore);
  return { results };
}

// 协作打标签：只返回提案，不缓存。新建标签至多 maxNewTags 个（收藏夹剩余名额与分拣设置里 AI 新建上限取小）
// 关注 (follow-bg.js) calls it too, with UP 主 as items (mid in bvid) and its own unit.
async function triageAiCommand({ instruction, items, tags, maxNewTags, allowRemove = false, aiProviderId }, unit = TRIAGE_AI_UNIT) {
  const text = String(instruction ?? "").trim();
  if (!text) throw triageError("缺少指令");
  const list = (Array.isArray(items) ? items : []).filter((it) => it && it.bvid);
  if (!list.length) throw triageError("缺少 items");
  const ai = await triageAiSettings();
  const opts = { maxNewTags: TriageUi.numSetting("newTagMax", maxNewTags), allowRemove: allowRemove === true };
  const { content } = await triageChat(
    triageBuildCommandMessages({ instruction: text, tags, items: list, ...opts, unit }),
    triageMaxTokens("command", list.length, ai),
    ai.triageThinking,
    aiProviderId
  );
  return triageParseCommand(content, list, tags, opts);
}

// One video → one note built the same way the popup's 写入 Obsidian does, plus the stage-2 summary.
async function triageBuildNote(bvid, settings) {
  if (!bvid) throw triageError("缺少 bvid");
  const site = MdgSites.SITES.bilibili;
  const io = TRIAGE_BILI_IO;
  const ref = { site: "bilibili", id: bvid, part: null, url: "" };
  const meta = await site.fetchMeta(ref, io);
  ref.url = site.canonicalUrl(bvid, meta.pageCount > 1 ? meta.pageIndex : 1);
  // Tracks are tried in order like on the video page (MdgSites.loadSubtitle). Throttling rejects, so the caller waits
  // and tries again. A failed track list or download writes the note without subtitles, as the video page does: the
  // note opens with 字幕抓取失败（原因）. subtitleWarning, which the callers show, is the video page's sentence for that
  // or for a subtitle that does not match the video's length (kept, not cached).
  const found = await MdgSites.loadSubtitle(site, ref, meta, io);
  const { track, body, bundle } = found;
  const subtitleFailure = found.failure;
  const subtitleNeedLogin = found.needLogin;
  const subtitleWarning = MdgNote.noteSubtitleWarning(found.mismatch ? MdgNote.subtitleMismatchWarning(found.mismatch) : "", { subtitleFailure, subtitleNeedLogin });
  const hotComments =
    settings.includeHotCommentsInNote || !body.length ? await site.fetchComments(ref, meta, io).catch(() => []) : [];
  const noteMeta = { ...MdgNote.noteMetaOf({ site: "bilibili", videoId: bvid, meta, bundle, track }), hotComments, subtitleFailure, subtitleNeedLogin };
  const { aiConversations } = MdgLimits.KEYS;
  // 分拣台 notes always summarize the video's P1 (the analysis is per bvid).
  const extrasRef = { site: "bilibili", videoId: bvid, pageIndex: 1 };
  const stored = await chrome.storage.local.get([aiConversations, ...MdgNote.triageExtrasKeys(extrasRef)]);
  const { analysis, note, userTags } = MdgNote.triageExtras(stored, extrasRef);
  // The user's 分拣 tags, every folder's, go into the note's tags next to the fixed ones from the settings page.
  noteMeta.userTags = userTags;
  noteMeta.aiTurns = MdgNote.buildConversationTurns(MdgNote.pickConversation(stored[aiConversations], noteMeta)?.messages);
  const markdown = MdgNote.withTriageSummary(MdgNote.buildMarkdown(noteMeta, body, settings, ref), analysis, note);
  // The computed path for this video's note (obsidian.js prefers a recorded one); the cover goes into the vault there
  // (hdslb links 403 in Obsidian).
  const filename = MdgNote.buildNoteFilename(noteMeta, settings);
  const path = MdgNote.videoNotePath(noteMeta, settings);
  const cover = { url: meta.cover, name: `bilibili-${bvid}` };
  return { meta, noteMeta, body, markdown, filename, path, cover, subtitleWarning };
}

// Before a 逐个视频笔记 run: the settings and the settings page's 测试连接 request (obsidian.js probeObsidian).
async function triageObsidianCheck() {
  const { baseUrl, apiKey } = obsidianConfig(await getMergedSettings());
  await probeObsidian(baseUrl, apiKey);
}

// 逐个视频笔记: obsidian.js writeVideoNote without a conversation, so it never asks. overwrite rewrites the note; without
// it an existing note keeps its body and only its AI 问答 section follows the conversation.
// Returns { path, title, skipped, aiUpdated, subtitleWarning? }.
// No cid here (分拣台 lists only BVs): writeVideoNote finds the note recorded for P1 by the BV and 分 P, so without
// overwrite the AI 问答 is updated without reading B站. title: the card's, for the index when nothing was built.
async function triageWriteNote({ bvid, title, overwrite }) {
  if (!bvid) throw triageError("缺少 bvid");
  const done = await writeVideoNote({ ref: { site: "bilibili", videoId: bvid, pageIndex: 1, title }, mode: overwrite ? "full" : "ai" });
  return { path: done.path, title: done.title, skipped: done.kind !== "full", aiUpdated: done.kind === "ai", ...(done.subtitleWarning && { subtitleWarning: done.subtitleWarning }) };
}

// Notes used to live on basket items; they now belong to the video (triage_notes, bvid → { text, updatedAt }).
// Copies each basket note once, never over an existing entry; the basket items keep theirs.
async function triageMigrateNotes() {
  const { triageNotes, triageBasket } = MdgLimits.KEYS;
  const stored = await chrome.storage.local.get(["triage_notes_migrated", triageBasket, triageNotes]);
  if (stored.triage_notes_migrated) return;
  const notes = { ...stored[triageNotes] };
  for (const item of stored[triageBasket] || []) {
    if (item?.bvid && String(item.note || "").trim() && !String(notes[item.bvid]?.text || "").trim()) {
      notes[item.bvid] = { text: item.note, updatedAt: Date.now() };
    }
  }
  await chrome.storage.local.set({ [triageNotes]: notes, triage_notes_migrated: true });
}

// One triage tab: each holds its own copy of 保留, tags and the rest, so a second one is focused instead of opened.
// hash: a deep link into 关注, `follow&tag=<id>` (on that tag) or `follow&up=<mid>` (on that UP's card, what a Bilibili
// page's UP tag picker sends); an open triage tab gets it as a hash change.
async function triageOpenPage(hash) {
  const page = chrome.runtime.getURL("triage/triage.html");
  const url = /^follow(?:&tag=[\w%.~-]+|&up=\d+)?$/.test(hash || "") ? `${page}#${hash}` : page;
  return focusOrOpenPage(page, url);
}

// An extension page's open tab is focused (and sent to url when that differs) instead of opening a second one.
async function focusOrOpenPage(page, url = page) {
  const tabs = (await chrome.runtime.getContexts?.({ contextTypes: ["TAB"] })) || [];
  const open = tabs.find((c) => c.documentUrl?.startsWith(page) && c.tabId >= 0);
  if (!open) return void (await chrome.tabs.create({ url }));
  await chrome.tabs.update(open.tabId, url === page ? { active: true } : { active: true, url });
  await chrome.windows.update(open.windowId, { focused: true });
}

const TRIAGE_HANDLERS = {
  "triage-open": (msg) => triageOpenPage(msg?.hash),
  "triage-write-note": (msg) => triageWriteNote(msg),
  "triage-obsidian-check": () => triageObsidianCheck(),
  "triage-build-note": async ({ bvid }) => {
    const settings = await getMergedSettings();
    const { meta, markdown, filename, path, cover, subtitleWarning } = await triageBuildNote(bvid, settings);
    return { title: meta.title, markdown, filename, path, cover, subtitleWarning };
  },
  "triage-folders": () => triageCreatedFolders(),

  // With known (the cached bvids), it stops after the first page with nothing new and returns only those pages as head:
  // the list is newest first, so a page of known videos means the rest is in the cache too.
  "triage-folder-items": async ({ mediaId, known }) => {
    if (!mediaId) throw triageError("缺少 mediaId");
    if (mediaId === TRIAGE_TOVIEW) {
      const items = (await triageToviewList()).map((m) => ({
        bvid: m.bvid,
        aid: m.aid,
        title: m.title,
        cover: m.pic,
        upper: m.owner?.name || "",
        upperMid: m.owner?.mid ? String(m.owner.mid) : undefined,
        duration: m.duration,
        pubdate: m.pubdate,
        favTime: m.add_at,
        intro: m.desc,
        invalid: m.state !== 0,
        // Seconds watched on Bilibili, -1 once finished; the card shows it as 看到 N% or 已看完.
        seen: m.progress,
        // 播放量 comes with the list; no extra request.
        play: Number.isFinite(m.stat?.view) ? m.stat.view : undefined
      }));
      return { items, ids: items.map((it) => it.bvid), info: { title: "稍后再看", intro: "" } };
    }
    const items = [];
    let info = null;
    const knownSet = known ? new Set(known) : null;
    for (let pn = 1; ; pn++) {
      if (pn > 1) await new Promise((r) => setTimeout(r, 300));
      let data;
      try {
        data = await triageBiliGet(`https://api.bilibili.com/x/v3/fav/resource/list?media_id=${mediaId}&ps=40&pn=${pn}`);
      } catch (e) {
        // Keep what earlier pages returned; the page must not treat a partial list as the whole folder.
        if (pn === 1) throw e;
        return { items, info, partial: { page: pn, error: e.message } };
      }
      info ||= data?.info ? { title: data.info.title || "", intro: data.info.intro || "" } : null;
      for (const m of data?.medias || []) {
        if (m.type !== 2) continue;
        items.push({
          bvid: m.bvid || m.bv_id,
          aid: m.id,
          title: m.title,
          cover: m.cover,
          upper: m.upper?.name || "",
          // The UP's mid finds its 关注 UP 标签 in the player; snapshots saved before have none (matched by name).
          upperMid: m.upper?.mid ? String(m.upper.mid) : undefined,
          duration: m.duration,
          pubdate: m.pubtime,
          favTime: m.fav_time,
          intro: m.intro,
          invalid: m.attr !== 0,
          play: Number.isFinite(m.cnt_info?.play) ? m.cnt_info.play : undefined
        });
      }
      if (!data?.has_more || !data?.medias?.length) break;
      if (knownSet && (data.medias || []).every((m) => knownSet.has(m.bvid || m.bv_id))) return { items, info, head: true };
      // Page progress for the triage page's loading line; no open page to receive it is fine.
      globalThis.chrome?.runtime?.sendMessage?.({ type: "triage-folder-page", mediaId: String(mediaId), page: pn })?.catch?.(() => {});
    }
    // The id list is what 所有收藏夹 later checks against: it can hold entries the paged list leaves out, so comparing
    // it with the items would flag the folder every time. null when it fails; the check then falls back to the items.
    const ids = await triageFolderIds(mediaId).catch(() => null);
    return { items, ids, info };
  },

  "triage-seen-sync": ({ force } = {}) => seenSync({ force: force === true }),

  // Every video id of a folder in one request, no paging; 所有收藏夹 compares it with the cached list.
  "triage-folder-ids": async ({ mediaId }) => {
    if (!mediaId) throw triageError("缺少 mediaId");
    return { bvids: await triageFolderIds(mediaId) };
  },

  // Which of the user's folders hold this video (Bilibili's own 收藏 dialog asks the same): one request per video, no
  // folder's contents are read. The page passes back the mid of its first answer, so one check asks nav once.
  "triage-fav-where": async ({ aid, mid: known }) => {
    if (!aid) throw triageError("缺少 aid");
    const mid = known || (await triageMid());
    const data = await triageBiliGet(`https://api.bilibili.com/x/v3/fav/folder/created/list-all?up_mid=${mid}&type=2&rid=${aid}`);
    return { mid, folders: (data?.list || []).filter((f) => f.fav_state === 1).map((f) => ({ id: String(f.id), title: f.title })) };
  },

  "triage-analysis-get": async ({ bvids }) => {
    const list = Array.isArray(bvids) ? bvids : [];
    const stored = await chrome.storage.local.get(list.map(MdgLimits.KEYS.triageAnalysis));
    return Object.fromEntries(list.map((b) => [b, stored[MdgLimits.KEYS.triageAnalysis(b)] || null]));
  },

  "triage-analyze": (msg) => triageAnalyze(msg),

  "triage-classify-titles": (msg) => triageClassifyTitles(msg),

  "triage-ai-command": (msg) => triageAiCommand(msg),

  "triage-title-get": async ({ bvids }) => {
    const list = Array.isArray(bvids) ? bvids : [];
    const stored = await chrome.storage.local.get(list.map(MdgLimits.KEYS.triageTitle));
    return Object.fromEntries(list.map((b) => [b, stored[MdgLimits.KEYS.triageTitle(b)] || null]));
  },

  "triage-unfav": async ({ mediaId, aids }) => {
    const list = Array.isArray(aids) ? aids : [];
    if (!mediaId || !list.length) throw triageError("缺少 mediaId 或 aids");
    if (mediaId === TRIAGE_TOVIEW) {
      for (const aid of list) await triageBiliPost("/x/v2/history/toview/del", { aid });
      return { done: list.length };
    }
    await triageBiliPost("/x/v3/fav/resource/batch-del", {
      media_id: mediaId,
      resources: list.map((a) => `${a}:2`).join(","),
      platform: "web"
    });
    return { done: list.length };
  },

  "triage-refav": async ({ mediaId, aid }) => {
    if (!mediaId || !aid) throw triageError("缺少 mediaId 或 aid");
    if (mediaId === TRIAGE_TOVIEW) {
      await triageBiliPost("/x/v2/history/toview/add", { aid });
      return {};
    }
    await triageBiliPost("/x/v3/fav/resource/deal", { rid: aid, type: 2, add_media_ids: mediaId, del_media_ids: "" });
    return {};
  },

  // 移动 / 复制 to another folder (never 稍后再看); without from, just 收藏 into it (videos from 已出分拣范围).
  // From 稍后再看 or nowhere there is no batch endpoint: add one by one, then remove.
  "triage-transfer": async ({ from, to, aids, move }) => {
    const list = Array.isArray(aids) ? aids : [];
    if (!to || to === TRIAGE_TOVIEW || String(from) === String(to) || !list.length) throw triageError("缺少目标或 aids");
    if (!from || from === TRIAGE_TOVIEW) {
      for (const aid of list) {
        await triageBiliPost("/x/v3/fav/resource/deal", { rid: aid, type: 2, add_media_ids: to, del_media_ids: "" });
        if (move && from) await triageBiliPost("/x/v2/history/toview/del", { aid });
      }
      return { done: list.length };
    }
    await triageBiliPost(`/x/v3/fav/resource/${move ? "move" : "copy"}`, {
      src_media_id: from,
      tar_media_id: to,
      mid: await triageMid(),
      resources: list.map((a) => `${a}:2`).join(","),
      platform: "web"
    });
    return { done: list.length };
  },

  "triage-folder-create": async ({ title, privacy }) => {
    const name = String(title || "").trim();
    if (!name) throw triageError("收藏夹名不能为空");
    const data = await triageBiliPost("/x/v3/fav/folder/add", { title: name, intro: "", privacy: privacy ? 1 : 0, cover: "" });
    return { id: data.id, title: data.title || name };
  },

  "triage-settings-get": async ({ aiProviderId } = {}) => {
    const s = await chrome.storage.sync.get(TRIAGE_SETTINGS_DEFAULTS);
    const provider = typeof loadAiProviders === "function" ? await triageProvider(aiProviderId).catch(() => null) : null;
    return {
      triageIntervalSec: TriageUi.numSetting("interval", s.triageIntervalSec),
      triageFineBatchSize: TriageUi.numSetting("fineBatch", s.triageFineBatchSize),
      triageCoarseBatchSize: TriageUi.numSetting("coarseBatch", s.triageCoarseBatchSize),
      triageThinking: s.triageThinking === true,
      triageTitleMaxTokens: TriageUi.numSetting("maxTokens", s.triageTitleMaxTokens),
      triageAnalyzeMaxTokens: TriageUi.numSetting("maxTokens", s.triageAnalyzeMaxTokens),
      triageTagLimit: TriageUi.numSetting("tagLimit", s.triageTagLimit),
      triageAiNewTagMax: TriageUi.numSetting("newTagMax", s.triageAiNewTagMax),
      triageAiRemoveTags: s.triageAiRemoveTags === true,
      triageAiBatchSize: TriageUi.numSetting("aiBatch", s.triageAiBatchSize),
      // 开启思考 only reaches these platforms (triageChat), so the page shows the switch only when the platform the
      // requests go to (triageProvider) is one of them.
      thinkingToggle: supportsThinkingToggle(provider?.baseUrl)
    };
  },

  "triage-settings-save": async (msg) => {
    const patch = {};
    for (const k of Object.keys(TRIAGE_SETTINGS_DEFAULTS)) if (msg[k] !== undefined) patch[k] = msg[k];
    await chrome.storage.sync.set(patch);
    return {};
  },

  // 一篇摘录 and the 逐个视频笔记 index: one file into the B站 notes' folder (the folder template with site=bilibili).
  "triage-export": async ({ filename, markdown }) => {
    const name = String(filename || "").trim();
    if (!name) throw triageError("缺少文件名");
    const settings = await getMergedSettings();
    const folder = MdgNote.resolveFolderTemplate(settings.noteFolder, { site: "bilibili" });
    const path = folder ? `${folder}/${name}` : name;
    // putVaultNote gives up after OBSIDIAN_TIMEOUT_MS, so a hung Obsidian ends 写入中….
    await putVaultNote(obsidianConfig(settings), path, typeof markdown === "string" ? markdown : "");
    return { path, text: obsidianWritten(path) };
  }
};

const TRIAGE_DNR_RULE_ID = 91001;
function triageRegisterDnr() {
  chrome.declarativeNetRequest
    .updateSessionRules({
      removeRuleIds: [TRIAGE_DNR_RULE_ID],
      addRules: [
        {
          id: TRIAGE_DNR_RULE_ID,
          priority: 1,
          action: {
            type: "modifyHeaders",
            requestHeaders: [
              { header: "Referer", operation: "set", value: "https://www.bilibili.com/" },
              { header: "Origin", operation: "set", value: "https://www.bilibili.com" }
            ]
          },
          condition: {
            requestDomains: ["api.bilibili.com"],
            tabIds: [chrome.tabs.TAB_ID_NONE],
            resourceTypes: ["xmlhttprequest", "other"]
          }
        }
      ]
    })
    .catch((e) => console.warn("[triage] DNR 规则注册失败", e));
}

// Answers the messages whose type starts with prefix from handlers[type](message): { ok: true, data } or
// { ok: false, error, code? }. Other types are left to the other listeners. Returns the listener.
function triageListen(prefix, handlers) {
  const listener = (message, sender, sendResponse) => {
    const type = message?.type;
    if (typeof type !== "string" || !type.startsWith(prefix)) return false;
    const handler = handlers[type];
    if (!handler) {
      sendResponse({ ok: false, error: `未知消息类型 ${type}` });
      return false;
    }
    Promise.resolve()
      .then(() => handler(message))
      .then((data) => sendResponse({ ok: true, data }))
      .catch((e) => sendResponse({ ok: false, error: e?.message || String(e), ...(e?.code ? { code: e.code } : {}) }));
    return true;
  };
  chrome.runtime.onMessage.addListener(listener);
  return listener;
}

if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
  triageRegisterDnr();
  triageMigrateNotes().catch((e) => console.warn("[triage] 笔记迁移失败", e));
  chrome.runtime.onInstalled.addListener(triageRegisterDnr);
  chrome.runtime.onStartup.addListener(triageRegisterDnr);
  chrome.storage.onChanged.addListener((changes, area) => {
    const c = area === "sync" && changes.seenShow;
    if (c && MdgSettings.seenOn(c.oldValue) && !MdgSettings.seenOn(c.newValue)) seenClear().catch((e) => console.warn("[triage] 清除观看进度失败", e));
  });

  triageListen("triage-", TRIAGE_HANDLERS);
}
