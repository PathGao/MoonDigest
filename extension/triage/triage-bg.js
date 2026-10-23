// MoonDigest 收藏夹分拣台 background 层。classic script，由 background.js 末尾 importScripts 加载，
// 与 background.js 共享全局作用域，所以顶层名字统一带 triage / TRIAGE_ 前缀。
// 纯函数放顶部（selftest 用 vm 加载，chrome 为 undefined）。日期、时长、标签名用页面同一份的 TriageUi（shared.js，在本文件前加载）。

// ===== 纯函数 =====

const TRIAGE_BAD_REPLY = "AI 回复格式不对";
// 从模型输出里取第一个完整的 {...} 或 [...]（先去掉 <think> 思考段和 ``` 围栏，跳过字符串里的括号）
function triageExtractJson(content, open) {
  const close = open === "[" ? "]" : "}";
  const s = MdgNote.stripThinkBlocks(content).replace(/```(?:json)?/gi, "");
  const start = s.indexOf(open);
  if (start < 0) throw new Error(TRIAGE_BAD_REPLY);
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
    throw new Error(TRIAGE_BAD_REPLY);
  }
}

// AI 判断固定三档。模型答 id（不分大小写）或中文名（含改名前的旧名）都认；别的不当成拿不准，返回 ""，
// 这个视频算分析失败（可重试），不进入下一步。
const TRIAGE_VERDICT_ALIASES = { 留: "keep", 可以删: "drop", 待定: "unsure" };
function triageVerdict(v) {
  const s = String(v ?? "").trim();
  const id = s.toLowerCase();
  const names = MdgTagCore.VERDICTS;
  if (names[id]) return id;
  return Object.keys(names).find((k) => names[k] === s) || TRIAGE_VERDICT_ALIASES[s] || "";
}
const triageBadVerdict = (v) => (String(v ?? "").trim() ? `AI 给的判断看不懂：「${String(v).trim()}」` : "AI 回复缺少判断");

// tags 是标签名列表，或 [{ name, rule }]
function triageTagNames(tags) {
  return (Array.isArray(tags) ? tags : []).map((t) => String((t && typeof t === "object" ? t.name : t) ?? "").trim()).filter(Boolean);
}

// 提示词里的标签：有说明写「名称：说明」，没有只写名称
function triageTagLines(tags) {
  return (Array.isArray(tags) ? tags : [])
    .map((t) => {
      const name = triageTagNames([t])[0];
      const rule = t && typeof t === "object" ? String(t.rule ?? "").replace(/\s+/g, " ").trim().slice(0, TriageUi.TAG_RULE_MAX) : "";
      return name && (rule ? `${name}：${rule}` : name);
    })
    .filter(Boolean);
}

// 细看的要点数：提示词里的格式和解析出的条数都按它。
const TRIAGE_POINTS = 3;
const triagePointNames = Array.from({ length: TRIAGE_POINTS }, (_, i) => `要点${i + 1}`);
function triageParseLlm(content) {
  const obj = triageExtractJson(content, "{");
  const oneLiner = String(obj.one_liner ?? obj.oneLiner ?? "").trim();
  if (!oneLiner) throw new Error("AI 回复缺少一句话总结");
  const points = (Array.isArray(obj.points) ? obj.points : [])
    .map((p) => String(p ?? "").trim())
    .filter(Boolean)
    .slice(0, TRIAGE_POINTS);
  while (points.length < TRIAGE_POINTS) points.push("");
  const verdict = triageVerdict(obj.verdict);
  if (!verdict) throw new Error(triageBadVerdict(obj.verdict));
  return { oneLiner, points, verdict, reason: String(obj.reason ?? "").trim() };
}

// items 与发给模型的序号一一对应（序号从 1 开始）。AI 漏掉的视频不在结果里，判断看不懂的在 failed 里写原因，
// 页面都按分析失败处理（可重试）
function triageParseTitleBatch(content, items) {
  const arr = triageExtractJson(content, "[");
  const byIndex = new Map();
  for (const r of Array.isArray(arr) ? arr : []) {
    const i = Number(r?.i);
    if (Number.isInteger(i) && !byIndex.has(i)) byIndex.set(i, r);
  }
  const results = {};
  const failed = {};
  items.forEach((item, idx) => {
    const r = byIndex.get(idx + 1);
    if (!r) return;
    const verdict = triageVerdict(r.verdict);
    if (!verdict) return void (failed[item.bvid] = triageBadVerdict(r.verdict));
    results[item.bvid] = {
      verdict,
      reason: String(r.reason ?? "").trim(),
      confidence: String(r.confidence || "").trim().toLowerCase() === "high" ? "high" : "low"
    };
  });
  return { results, failed };
}

// One cell of a prompt's 序号|… line: no | or line break inside (triage-bg.js and follow-bg.js lines).
const triageCell = (s) => String(s ?? "").replace(/[|\r\n]+/g, " ").trim();

function triageTitleLine(item, n) {
  return `${n}|${triageCell(item.title)}|${triageCell(item.upper)}|${Number(item.duration) ? TriageUi.fmtDuration(item.duration) : ""}|${TriageUi.fmtDate(item.pubdate)}|${triageCell(item.intro).slice(0, TriageUi.INTRO_CHARS)}`;
}

// 序号|标题|UP|时长|简介前 INTRO_CHARS 字|现有标签|一句话|要点（；分隔）（没有的字段留空）
function triageCommandLine(item, n) {
  const list = (a) => (Array.isArray(a) ? a.map(triageCell).filter(Boolean) : []);
  return [n, triageCell(item.title), triageCell(item.upper), Number(item.duration) ? TriageUi.fmtDuration(item.duration) : "", triageCell(item.intro).slice(0, TriageUi.INTRO_CHARS), list(item.currentTags).join("、"), triageCell(item.oneLiner), list(item.points).join("；")].join("|");
}

// 批量打标签的提案只改标签：add 只留已有标签或本次新建的标签，remove 只留视频现有标签且要 allowRemove；
// 其他字段（如 verdict）一律丢弃，无改动的视频不返回。新建个数不在这里砍：超出上限的由检查页提示，用户自己取舍
// An item by its id (摘读记录's record key), else its bvid (收藏夹's video, 关注's mid).
const triageItemId = (item) => item?.id || item?.bvid;
function triageParseCommand(content, items, tags, { allowRemove = false } = {}) {
  const obj = triageExtractJson(content, "{");
  const existing = new Set(triageTagNames(tags));
  const newTags = [];
  for (const t of Array.isArray(obj.new_tags) ? obj.new_tags : []) {
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
    if (!r || !triageItemId(item)) return;
    const current = new Set(triageTagNames(item.currentTags));
    const pick = (arr, ok) => [...new Set((Array.isArray(arr) ? arr : []).map((x) => TriageUi.cleanTagName(x)))].filter((x) => x && ok(x));
    const a = {
      add: pick(r.add, (x) => valid.has(x) && !current.has(x)),
      remove: allowRemove ? pick(r.remove, (x) => current.has(x)) : []
    };
    if (a.add.length || a.remove.length) assignments[triageItemId(item)] = a;
  });
  return { newTags, assignments, note: String(obj.note ?? "").trim() };
}

// URLSearchParams turns every value into its string.
function triageForm(obj) {
  return new URLSearchParams(obj).toString();
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
  `{"one_liner": "一句话说清视频讲了什么，≤40字", "points": [${triagePointNames.map((p) => `"${p}"`).join(", ")}], "verdict": "keep|drop|unsure", "reason": "判断理由，≤30字"}`,
  TRIAGE_VERDICT_TEXT,
  "信息太少无法判断时（只有标题简介且简介很短）选 unsure。"
].join("\n");

const TRIAGE_TITLE_PROMPT = [
  `你是 B站收藏夹分拣助手。下面每行是一个收藏的视频，格式：序号|标题|UP主|时长|发布日期|简介前${TriageUi.INTRO_CHARS}字。`,
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

// Why the AI gets no subtitle, in the sentence every entry shows (MdgErrors.subtitleMissing). Not logged in or a failed
// fetch adds that the video may have subtitles, so the AI never says it has none (细看 and the side panel's buildAiMessages).
function aiSubtitleMissing({ subtitleNeedLogin = false, subtitleFailure = "" } = {}) {
  const missing = MdgErrors.subtitleMissing({ subtitleNeedLogin, subtitleFailure });
  return subtitleNeedLogin || subtitleFailure ? `${missing}。视频本身可能有字幕，不要说视频没有字幕。` : `${missing}。`;
}

// subtitle is "" when the video has none; then comments (the hot comments, numbered) stand in for it, and meta's
// subtitleNeedLogin / subtitleFailure say why (aiSubtitleMissing).
function triageBuildMessages(meta, subtitle, comments, criteria, folder) {
  const user = [
    `标题：${meta.title}`,
    `UP主：${meta.upper}`,
    `分区：${meta.tname || "未知"}`,
    `时长：${Math.round((meta.duration || 0) / 60)} 分钟`,
    `发布：${meta.pubdate || "未知"}`,
    `标签：${meta.tags.join("、") || "无"}`,
    `简介：${meta.desc || "无"}`,
    subtitle ? `\n字幕：\n${subtitle}` : `\n${aiSubtitleMissing(meta)}\n热门评论：\n${comments || "无"}`
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
  header: `视频列表，每行格式：序号|标题|UP主|时长|简介前${TriageUi.INTRO_CHARS}字|现有标签|一句话|${triagePointNames.join("；")}（没有的字段留空）：`,
  line: triageCommandLine
};
// One record per line: n|title|type|tags|conversation (问：… 答：…, cut by the page to TriageUi.READING_AI_CHARS)|分拣台 AI
// 总结|备注 (first INTRO_CHARS). A record with a conversation has no 总结 or 备注, one without has only those.
function readingAiLine(item, n) {
  const list = (a) => (Array.isArray(a) ? a : []);
  const talk = list(item.turns).map((t) => `问：${triageCell(t?.q)}${triageCell(t?.a) ? ` 答：${triageCell(t.a)}` : ""}`).join(" ");
  return [n, triageCell(item.title), triageCell(item.site), list(item.currentTags).map(triageCell).filter(Boolean).join("、"), talk, triageCell(item.oneLiner), triageCell(item.note).slice(0, TriageUi.INTRO_CHARS)].join("|");
}
// 摘读记录 (history.js): videos and web pages, by record key (id).
const READING_AI_UNIT = {
  intro: "你是摘读记录整理助手，按用户指令给用户看过、问过 AI 的视频和网页打标签、做分类。",
  noun: "记录",
  basis: "- 有“对话”的记录以它为主要依据：问是用户问 AI 的问题，说明用户关心什么；答是 AI 的回答，说明内容讲了什么（太长的答已截断）。没有对话的记录看“AI 总结”和“备注”。",
  header: `记录列表，每行格式：序号|标题|类型|现有标签|对话（按时间先后，问：… 答：…）|AI 总结|备注前${TriageUi.INTRO_CHARS}字（没有的字段留空）：`,
  line: readingAiLine
};
// The user's instruction sits between these two lines; the system prompt names them.
const TRIAGE_INSTRUCTION_MARKS = ["<<<指令>>>", "<<<指令结束>>>"];
function triageBuildCommandMessages({ instruction, tags, items, maxNewTags = TriageUi.numSetting("newTagMax"), allowRemove = false, unit = TRIAGE_AI_UNIT }) {
  const lines = triageTagLines(tags);
  const { noun } = unit;
  const example = `{"new_tags": ["标签名"], "items": [{"i": 序号, "add": ["标签"], "remove": ["标签"]}], "note": "≤60字"}`;
  const system = [
    unit.intro,
    `用户指令写在 ${TRIAGE_INSTRUCTION_MARKS.join(" 和 ")} 之间，它就是本次任务的要求。`,
    "规则：",
    "- add 只能用已有标签名，或本次 new_tags 里列出的新标签名。",
    maxNewTags > 0
      ? `- 可以新建标签，至多 ${maxNewTags} 个，名称 ≤${MdgTagCore.TAG_NAME_MAX}字、不含逗号；已有标签能用就先用，不要重复造。`
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
  const [open, close] = TRIAGE_INSTRUCTION_MARKS;
  const user = [open, String(instruction ?? "").trim(), close, "", unit.header, ...items.map((it, idx) => unit.line(it, idx + 1))].join("\n");
  return [
    { role: "system", content: system },
    { role: "user", content: user }
  ];
}

// ===== chrome 相关 =====

function triageError(error, code) {
  return Object.assign(new Error(error), code ? { code } : {});
}

// Risk control answers HTTP 412 with an HTML page, or one of these codes in JSON; both mean back off, and so does
// HTTP 429 (sites.js biliJson, the video page's channel, reads them the same). follow-bg.js uses the same set.
const BILI_RISK_CODES = MdgSites.BILI_RISK_CODES;
async function triageBiliJson(res) {
  const throttled = res.status === 412 || res.status === 429;
  if (!res.ok) throw Object.assign(throttled ? triageError(MdgErrors.TEXT.biliThrottled, MdgErrors.CODE.THROTTLED) : triageError(`B站请求失败 HTTP ${res.status}`), { status: res.status });
  try {
    return await res.json();
  } catch {
    throw triageError("B站返回的不是 JSON（可能被风控拦截或需要重新登录）");
  }
}

// -101 (and a missing bili_jct or nav's isLogin) is NOT_LOGGED_IN, which the page answers with its 去登录 banner.
const triageNotLoggedIn = () => triageError(MdgErrors.TEXT.biliLogin, "NOT_LOGGED_IN");
// A B站 answer whose code is not 0, as the error both modes throw: -101 NOT_LOGGED_IN, risk control THROTTLED, any other
// 「what code：message」. keep (关注's reads, follow-bg.js followCodeError) keeps B站's number as the code, which tells a
// closed account from a passing failure; 收藏夹's leave it off (a write refused for one item is no stop).
function triageCodeError(json, what = "B站返回 ", keep = false) {
  if (json.code === -101) return triageNotLoggedIn();
  if (BILI_RISK_CODES.has(json.code)) return triageError(MdgErrors.TEXT.biliThrottled, MdgErrors.CODE.THROTTLED);
  return triageError(`${what}${json.code}：${json.message || ""}`, keep ? json.code : undefined);
}
function triageBiliData(json) {
  if (json.code !== 0) throw triageCodeError(json);
  return json.data;
}

// The one B站 channel of both modes (GET and POST) and the video page's fetch-json; returns the answer's JSON
// (triageBiliJson). No whole answer, body included, in TRIAGE_BILI_CFG.timeoutMs (MdgErrors.NET_TIMEOUT_MS, the video
// page's own fetches use it too) aborts the request; that and a dropped connection are NETWORK.
const TRIAGE_BILI_CFG = { timeoutMs: MdgErrors.NET_TIMEOUT_MS };
async function triageBiliFetch(url, init = {}) {
  const ms = TRIAGE_BILI_CFG.timeoutMs;
  return triageRace(ms, () => triageError(MdgErrors.netTimeout(ms), "NETWORK"), async (signal) => {
    const res = await fetch(url, { ...init, credentials: "include", signal }).catch((e) => {
      // A dropped connection is fetch's TypeError, whose English text the user does not need.
      throw triageError(e?.name === "TypeError" ? MdgErrors.TEXT.netDown : `${MdgErrors.TEXT.netDown}：${e?.message || e}`, "NETWORK");
    });
    return triageBiliJson(res);
  });
}

// run(signal) with a deadline: past ms the signal aborts and the call rejects with timeoutError(). Racing the timer
// (not just aborting) also ends a fetch or body read that ignores the abort.
async function triageRace(ms, timeoutError, run) {
  const ctl = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      ctl.abort();
      reject(timeoutError());
    }, ms);
  });
  try {
    return await Promise.race([run(ctl.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// B站's site and API origins, for the worker's requests, their Referer and the cookie.
const TRIAGE_BILI_WEB = "https://www.bilibili.com";
const TRIAGE_BILI_API = "https://api.bilibili.com";
// What a B站 page's own requests send; from the worker fetch would send no referrer.
const TRIAGE_BILI_GET = { cache: "no-store", referrer: `${TRIAGE_BILI_WEB}/`, referrerPolicy: "strict-origin-when-cross-origin" };

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
      json = await triageBiliFetch(u, TRIAGE_BILI_GET);
    } catch (e) {
      if (!pace) throw e;
      if (e.code === "NETWORK" && net < pace.cfg.netRetry.length) {
        pace.hold(pace.cfg.netRetry[net++], "network");
        strike--;
        continue;
      }
      if (e.code !== MdgErrors.CODE.THROTTLED) throw e;
    }
    if (json && !(pace && BILI_RISK_CODES.has(json.code))) return json;
    if (strike >= pace.cfg.strikes) throw triageError(MdgErrors.TEXT.biliThrottled, MdgErrors.CODE.THROTTLED);
    if (typeof url === "function") MdgSites.biliWbiReset();
    pace.hold(pace.cfg.backoffMs, "throttled");
  }
}

async function triageBiliGet(url) {
  return triageBiliData(await triageBiliGetJson(url));
}

async function triageBiliPost(path, fields) {
  const cookie = await chrome.cookies.get({ url: TRIAGE_BILI_WEB, name: "bili_jct" });
  if (!cookie?.value) throw triageNotLoggedIn();
  // A write is tried once. Without an answer B站 may or may not have done it, so callers keep their state as before
  // (no count change, no undo step) and the message says to look.
  const json = await triageBiliFetch(`${TRIAGE_BILI_API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: triageForm({ ...fields, csrf: cookie.value })
  }).catch((e) => {
    throw e.code === "NETWORK" ? triageError(`${e.message}：不确定 B站 是否已改，刷新后看一下`, "NETWORK") : e;
  });
  return triageBiliData(json);
}

// The sites.js fetchers (细看, notes, the side panel follow-up) through the same channel, one try. sites.js's B站
// reads turn risk control into THROTTLED themselves, as for the video page.
const TRIAGE_BILI_IO = { signWbi: true, fetchJson: (url) => triageBiliGetJson(url) };

// nav 未登录时 code=-101，triageBiliGet 会当错误抛出，所以只查 HTTP 与 JSON，由这里判断登录；风控码是限流，不是未登录。
async function triageMid() {
  const json = await triageBiliGetJson(`${TRIAGE_BILI_API}/x/web-interface/nav`);
  if (BILI_RISK_CODES.has(json.code)) throw triageCodeError(json);
  const nav = json.data || {};
  if (!nav.isLogin || !nav.mid) throw triageNotLoggedIn();
  return nav.mid;
}

// 稍后再看 is listed as one more folder with this id; its own endpoints stand in for the favorites ones.
const TRIAGE_TOVIEW = "toview";

// The whole 稍后再看 list in one request (the paged toview/web endpoint is only for the site's own page).
async function triageToviewList() {
  const data = await triageBiliGet(`${TRIAGE_BILI_API}/x/v2/history/toview`);
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
// counted: entries SEEN_MAX counts, as of the last prune plus every new one written since (an upper bound).
const SEEN_META = MdgLimits.KEYS.triageSeenMeta; // { newest: view_at s, syncedAt, prunedAt, counted, backoffUntil, resume }
// Set when the ticked folders or their snapshots change (triageStorageChanged): a video `counted` left out as exempt may
// count now, so the next read prunes in full. A key of its own: a read in flight writes the meta it holds.
const SEEN_RECOUNT = "triage_seen_recount";

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

// Which seen_ entries to drop: older than SEEN_KEEP_S, or past the newest SEEN_MAX. Videos in a chosen folder stay and
// take no place in SEEN_MAX, as starred records' AI conversations (MdgLimits.capConversations). Pure.
function seenPrune(entries, keep, nowS) {
  const sorted = Object.entries(entries).filter(([b]) => !keep.has(b)).sort((x, y) => y[1][1] - x[1][1]);
  return sorted.filter(([, [, at]], i) => nowS - at > SEEN_KEEP_S || i >= SEEN_MAX).map(([b]) => b);
}

// A first read takes minutes. The answer does not wait for it: Chrome kills a worker whose event stays open 5 minutes,
// and everything else it was running with it. A skip answers at once, a read answers { reading: true } as it starts (or
// is already running) and goes on by itself; pages follow it through triage_seen_meta and hear triage-seen-done, which
// carries the error that ended it (B站限流 shows as the meta's backoffUntil instead).
let seenRun = null;
function seenSync({ force }) {
  if (seenRun) return Promise.resolve({ reading: true });
  let started;
  const start = new Promise((r) => (started = () => r({ reading: true })));
  let error = "";
  seenRun = seenSyncOnce(force, started).catch((e) => {
    if (e.code !== "THROTTLED") error = e.message;
    throw e;
  }).finally(() => {
    seenRun = null;
    globalThis.chrome?.runtime?.sendMessage?.({ type: "triage-seen-done", ...(error && { error }) })?.catch?.(() => {});
  });
  return Promise.race([start, seenRun]);
}

// 关 drops the stored history (up to SEEN_MAX keys) once any read in flight has written; turning it back on reads afresh:
// a read that starts while the history is being dropped waits for it (seenSyncOnce), so it never writes back the old
// `newest` and skips what was dropped.
let seenClearing = null;
function seenClear() {
  seenClearing ||= (async () => {
    await seenRun?.catch(() => {});
    const keys = (await MdgLimits.storageKeys(chrome.storage.local)).filter((k) => k.startsWith(SEEN_PREFIX));
    await chrome.storage.local.remove([...keys, SEEN_META]);
  })().finally(() => (seenClearing = null));
  return seenClearing;
}

// 封面显示 is on: the history is read only then, checked again before every page (MdgSettings.seenOn, which every reader
// of seenShow uses).
const seenOn = async () => MdgSettings.seenOn((await chrome.storage.sync.get({ seenShow: MdgSettings.DEFAULTS.seenShow })).seenShow);

async function seenSyncOnce(force, started) {
  await seenClearing?.catch(() => {});
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
      const data = await triageBiliGet(`${TRIAGE_BILI_API}/x/web-interface/history/cursor?ps=30&max=${cursor.max}&view_at=${cursor.view_at}&business=${cursor.business}`);
      ran++;
      pages++;
      const list = data?.list || [];
      for (const it of list) top = Math.max(top, it.view_at || 0);
      const found = {};
      // A read also ends at SEEN_MAX_PAGES: older history is left out.
      const end = seenFold(found, list, meta.newest || 0) || !list.length || !data?.cursor?.max || pages >= SEEN_MAX_PAGES;
      const stored = await chrome.storage.local.get(Object.keys(found).map(MdgLimits.KEYS.seen));
      const write = {};
      let added = 0;
      for (const [b, [pct, at]] of Object.entries(found)) {
        const old = stored[MdgLimits.KEYS.seen(b)];
        if (!old) added++;
        write[MdgLimits.KEYS.seen(b)] = [Math.max(old?.[0] || 0, pct), Math.max(old?.[1] || 0, at)];
      }
      if (typeof meta.counted === "number") meta = { ...meta, counted: meta.counted + added };
      meta = end ? { ...meta, newest: top, syncedAt: now, backoffUntil: 0, resume: null } : { ...meta, resume: { cursor: data.cursor, top, pages } };
      await chrome.storage.local.set({ ...write, [SEEN_META]: meta });
      if (!end) cursor = data.cursor;
      else if (resumed) [resumed, cursor, pages] = [false, START, 0];
      else break;
    }
  } catch (e) {
    // Risk control: stop and stay away for SEEN_BACKOFF_MS from now (not from the start of a read that ran minutes);
    // never retry in a loop. What was read stays, `resume` too.
    if (e.code === MdgErrors.CODE.THROTTLED) await chrome.storage.local.set({ [SEEN_META]: { ...meta, backoffUntil: Date.now() + SEEN_BACKOFF_MS } });
    throw e;
  }
  // Pruned once a day (entries age out, folders get unticked) and as soon as the count may be over SEEN_MAX: meta.counted
  // is kept up to date by the writes above, so no read of every entry is needed to know.
  let dropped = 0;
  const recount = (await chrome.storage.local.get(SEEN_RECOUNT))[SEEN_RECOUNT];
  if (recount || now - (meta.prunedAt || 0) > SEEN_PRUNE_GAP_MS || !(typeof meta.counted === "number" && meta.counted <= SEEN_MAX)) {
    // Dropped before the folders are read: a change during the prune sets it again for the next read.
    if (recount) await chrome.storage.local.remove(SEEN_RECOUNT);
    const all = (await MdgLimits.storageKeys(chrome.storage.local)).filter((k) => k.startsWith(SEEN_PREFIX));
    const got = await chrome.storage.local.get([...all, MdgLimits.KEYS.triageIncludedFolders]);
    const snaps = await chrome.storage.local.get((got[MdgLimits.KEYS.triageIncludedFolders] || []).map(MdgLimits.KEYS.triageSnapshot));
    const keep = MdgLimits.seenExempt({ ...got, ...snaps });
    const entries = Object.fromEntries(all.map((k) => [k.slice(SEEN_PREFIX.length), got[k]]));
    const drop = seenPrune(entries, keep, Math.floor(now / 1000));
    if (drop.length) await chrome.storage.local.remove(drop.map(MdgLimits.KEYS.seen));
    dropped = drop.length;
    const counted = Object.keys(entries).filter((b) => !keep.has(b)).length - drop.length;
    await chrome.storage.local.set({ [SEEN_META]: { ...meta, prunedAt: now, counted } });
  }
  return { pages: ran, dropped };
}

// The bvids of a folder, as the page compares them with its lists. The types triage-folder-items keeps: 2 = video,
// TRIAGE_OGV = 番剧 episodes. ids gives a type-24 番剧 episode a BV id computed from its episode id as if that were an
// aid, another video's: a 番剧 entry is mapped to its bvid by its "id:type", which list items carry as ep (fresh: the
// list just read; then the folder's cached list and 已出分拣范围, where one hidden from the list still is). One no list
// knows stays "id:type", which never matches a BV id.
async function triageFolderIds(mediaId, fresh = []) {
  if (mediaId === TRIAGE_TOVIEW) return (await triageToviewList()).map((m) => m.bvid);
  const data = await triageBiliGet(`${TRIAGE_BILI_API}/x/v3/fav/resource/ids?media_id=${mediaId}&platform=web`);
  const list = (data || []).filter((m) => m.type === 2 || TRIAGE_OGV.includes(m.type));
  if (list.every((m) => m.type === 2)) return list.map((m) => m.bvid || m.bv_id);
  const K = MdgLimits.KEYS;
  let got = {};
  try {
    got = await chrome.storage.local.get([K.triageSnapshot(mediaId), K.triageRemoved]);
  } catch {} // unread caches only leave the 番剧 unmapped
  const known = [...fresh, ...(got[K.triageSnapshot(mediaId)]?.items || []), ...Object.values(got[K.triageRemoved] || {}).map((r) => r?.item)];
  const byEp = new Map(known.filter((it) => it?.ep).map((it) => [it.ep, it.bvid]));
  return list.map((m) => (m.type === 2 ? m.bvid || m.bv_id : byEp.get(`${m.id}:${m.type}`) || `${m.id}:${m.type}`));
}

// created/list (paged) is used instead of list-all because only it returns each folder's cover.
async function triageCreatedFolders() {
  const mid = await triageMid();
  const list = [];
  for (let pn = 1; pn <= 20; pn++) {
    const data = await triageBiliGet(`${TRIAGE_BILI_API}/x/v3/fav/folder/created/list?up_mid=${mid}&pn=${pn}&ps=50`);
    list.push(...(data?.list || []));
    if (!data?.has_more || !data.list?.length) break;
  }
  // A failed read is not a deleted 稍后再看: toviewUnread tells the page to keep its data and read it next time.
  const toview = await triageBiliGet(`${TRIAGE_BILI_API}/x/v2/history/toview/web?pn=1&ps=1&viewed=0`).catch(() => null);
  return {
    mid,
    ...(toview ? {} : { toviewUnread: true }),
    folders: [
      // 稍后再看 has no folder cover of its own: use the newest unwatched video's cover, like a folder's first video.
      ...(toview ? [{ id: TRIAGE_TOVIEW, title: MdgErrors.LABEL.watchLater, count: toview.count || 0, ...(toview.list?.[0]?.pic ? { cover: TriageUi.https(toview.list[0].pic) } : {}) }] : []),
      ...list.map((f) => ({ id: f.id, title: f.title, count: f.media_count, cover: TriageUi.https(f.cover) }))
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
  const { content, model } = await triageChat(triageBuildMessages({ ...meta, subtitleNeedLogin: got.needLogin, subtitleFailure: got.failure }, subtitle, comments, criteria, folder), triageMaxTokens("analyze", 1, ai), ai.triageThinking, aiProviderId);
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
  if (status === 404) return triageError("AI 平台找不到这个接口或模型，请检查接口地址和模型名", MdgErrors.CODE.AI_SETUP);
  if (status === 429) return triageError("AI 平台限流", "AI_THROTTLED");
  return triageError(`AI 平台出错（HTTP ${status}）`);
}
const AI_NETWORK_TEXT = "连不上 AI 平台，请检查网络和接口地址";
// A request to the AI platform that never got an answer (fetch rejected): a missing host permission (background.js
// hostPermissionError) is AI_ACCESS (授权), anything else AI_NETWORK. The side panel, 测试连接 and triageChat all use it.
async function aiFetchError(baseUrl) {
  const denied = await hostPermissionError(baseUrl);
  return denied ? triageError(denied, "AI_ACCESS") : triageError(AI_NETWORK_TEXT, "AI_NETWORK");
}

// Some platforms report quota, rate and moderation failures inside an HTTP 200 body (a stream chunk for the side panel's
// parseOpenAISSE, the whole reply for triageChat). A quota or rate message is classified as an HTTP 429 (a per-minute
// quota is 限流, not 余额不足); otherwise only a Chinese message is shown. null when the body carries no error.
function triageAiBodyError(json) {
  if (!json?.error) return null;
  const detail = typeof json.error === "string" ? json.error : json.error.message || JSON.stringify(json.error);
  if (AI_QUOTA_RE.test(detail) || AI_RATE_RE.test(detail)) return triageAiHttpError(429, detail);
  return triageError(/[\u4e00-\u9fff]/.test(detail) ? `AI 平台出错：${detail}` : "AI 平台出错");
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
  if (!String(provider?.baseUrl || "").trim()) return { code: MdgErrors.CODE.AI_SETUP, text: "AI 平台的接口地址没填" };
  if (!String(provider?.model || "").trim()) return { code: MdgErrors.CODE.AI_SETUP, text: "AI 平台的模型名没填" };
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
// providerId: the platform picked at the top of the side panel, which the pages send as aiProviderId (收藏夹's sendRaw, fav-*.js);
// unset or no longer enabled, the first enabled one, as in the side panel.
async function triageChat(messages, maxTokens, thinking = false, providerId = "") {
  const provider = await triageProvider(providerId);
  if (!provider) throw triageError(MdgErrors.TEXT.aiNone, MdgErrors.CODE.AI_SETUP);
  const apiKey = (await loadAiProviderKeys())[provider.id];
  const problem = aiProviderProblem(provider, apiKey);
  if (problem) throw triageError(problem.text, problem.code);
  const { baseUrl } = provider; // normalized by loadAiProviders
  const body = { model: provider.model, stream: false, temperature: 0.3, max_tokens: maxTokens, messages };

  const ms = TRIAGE_AI_TIMEOUT_MS[thinking ? "thinking" : "normal"];
  return triageRace(ms, () => triageError(MdgErrors.aiTimeout(ms), "AI_TIMEOUT"), async (signal) => {
    // 思考 token 计入 max_tokens；默认关（DeepSeek 实测 30 标题 3s/815 token，开则约 19s/4579 token）
    const res = await postChat({ baseUrl, apiKey, signal, thinking }, body).catch(async () => {
      throw await aiFetchError(baseUrl);
    });
    if (!res.ok) throw triageAiHttpError(res.status, await res.text().catch(() => ""));
    // A body that is not JSON is this request's failure.
    const json = await triageAiJson(res);
    const choice = json.choices?.[0];
    // Cut at the output limit, with or without a partial answer: the page offers 调大输出上限.
    if (choice?.finish_reason === "length") throw triageError(MdgErrors.TEXT.aiTruncated, "AI_TRUNCATED");
    return { content: choice?.message?.content, model: provider.model };
  });
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
  const { results: parsed, failed } = triageParseTitleBatch(content, list);
  const analyzedAt = Date.now();
  // 结果记下当时的判断标准，标准改了页面才认得出哪些要重新粗看
  const results = {};
  const toStore = {};
  for (const [bvid, r] of Object.entries(parsed)) {
    results[bvid] = { ...r, criteria: String(criteria ?? "").trim() };
    toStore[MdgLimits.KEYS.triageTitle(bvid)] = { ...results[bvid], model, analyzedAt };
  }
  await chrome.storage.local.set(toStore);
  return { results, failed };
}

// 协作打标签：只返回提案，不缓存。提示里让 AI 新建至多 maxNewTags 个（收藏夹剩余名额与分拣设置里 AI 新建上限取小），多出的照样返回
// 关注 (follow-bg.js) calls it too, with UP 主 as items (mid in bvid) and its own unit, and so does 摘读记录. 开启思考 and
// 粗看输出上限 are 收藏夹设置's: 关注设置 and 摘读记录设置 have neither, so their runs think off with the automatic cap.
async function triageAiCommand({ instruction, items, tags, maxNewTags, allowRemove = false, aiProviderId }, unit = TRIAGE_AI_UNIT) {
  const text = String(instruction ?? "").trim();
  if (!text) throw triageError("缺少指令");
  const list = (Array.isArray(items) ? items : []).filter(triageItemId);
  if (!list.length) throw triageError("缺少 items");
  const ai = unit === TRIAGE_AI_UNIT ? await triageAiSettings() : { triageThinking: false, triageTitleMaxTokens: null };
  const opts = { maxNewTags: TriageUi.numSetting("newTagMax", maxNewTags), allowRemove: allowRemove === true };
  const { content } = await triageChat(
    triageBuildCommandMessages({ instruction: text, tags, items: list, ...opts, unit }),
    triageMaxTokens("command", list.length, ai),
    ai.triageThinking,
    aiProviderId
  );
  return triageParseCommand(content, list, tags, { allowRemove: opts.allowRemove });
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
  const { aiConversations, obsidianNotePaths } = MdgLimits.KEYS;
  // 分拣台 notes always summarize the video's P1 (the analysis is per bvid).
  const extrasRef = { site: "bilibili", videoId: bvid, pageIndex: 1 };
  const stored = await chrome.storage.local.get([aiConversations, obsidianNotePaths, ...MdgNote.triageExtrasKeys(extrasRef)]);
  const { analysis, note, userTags, starred } = MdgNote.triageExtras(stored, extrasRef);
  // The user's 分拣 tags, every folder's, go into the note's tags next to the fixed ones from the settings page.
  Object.assign(noteMeta, { userTags, starred });
  noteMeta.aiTurns = MdgNote.buildConversationTurns(MdgNote.pickConversation(stored[aiConversations], noteMeta)?.messages);
  const markdown = MdgNote.withTriageSummary(MdgNote.buildMarkdown(noteMeta, body, settings, ref), analysis, note);
  // The computed path for this video's note (obsidian.js prefers a recorded one); the cover goes into the vault there
  // (hdslb links 403 in Obsidian). filename, the .zip's: the recorded note's name, as 下载 .md.
  const filename = MdgNote.recordedFilename(stored[obsidianNotePaths], MdgSites.buildContextKey(noteMeta), MdgNote.buildNoteFilename(noteMeta, settings));
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
  const page = chrome.runtime.getURL(MdgCommon.PAGES.triage);
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

// The ids a page's message carries, as B站 takes them: digits (a number or a string), or 稍后再看 for a folder. Nothing
// else reaches a write's form fields (resources joins aids into "aid:2,…") or a URL.
const triageNumId = (v) => (typeof v === "number" || typeof v === "string") && /^\d+$/.test(String(v));
const triageFolderId = (v) => v === TRIAGE_TOVIEW || triageNumId(v);
// A page's message names a favorite by its archive aid; a 番剧 episode's carries ":42" (fav-base.js favRes). Folder writes
// send "aid:2" or "aid:42": B站 takes 42 + aid for a 番剧 episode it stores as "episode id:24" too, the form its own
// 番剧 page favorites with. 稍后再看 takes the bare aid of either. triageRes is the one place that turns it into B站's form.
const TRIAGE_OGV = [24, 42];
const triageResOk = (v) => triageNumId(v) || (typeof v === "string" && /^\d+:42$/.test(v));
const triageRes = (v) => {
  const [rid, type = "2"] = String(v).split(":");
  return { rid, type: Number(type), resource: `${rid}:${type}` };
};
const triageAids = (v) => (Array.isArray(v) && v.every(triageResOk) ? v : []);
// The inverse of sites.js biliAvToBv; "" for anything that is not a BV id. A type-24 favorite's id is its episode id,
// so its archive aid comes from the list's (correct) bvid.
function triageBvToAv(bvid) {
  if (!/^BV1[0-9A-Za-z]{9}$/.test(bvid || "")) return "";
  const table = "FcwAPNKTMug3GV5Lj7EJnHpWsx4tb8haYeviqBz6rkCy12mUSDQX9RdoZf";
  const c = [...bvid];
  [c[3], c[9]] = [c[9], c[3]];
  [c[4], c[7]] = [c[7], c[4]];
  let n = 0n;
  for (const ch of c.slice(3)) n = n * 58n + BigInt(table.indexOf(ch));
  return String((n ^ 23442827791579n) & ((1n << 51n) - 1n));
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
    if (!triageFolderId(mediaId)) throw triageError("缺少 mediaId");
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
        play: Number.isFinite(m.stat?.view) ? m.stat.view : undefined,
        // A 番剧 episode redirects to its /bangumi/ page and has a pgc_label (season_id can be 0 on a video): marked so a
        // write into a folder sends aid:42; B站 would store aid:2 as an odd video entry.
        ...((/\/bangumi\//.test(m.redirect_url || "") || m.pgc_label) && { ogv: true })
      }));
      return { items, ids: items.map((it) => it.bvid), info: { title: MdgErrors.LABEL.watchLater, intro: "" } };
    }
    const items = [];
    let info = null;
    const knownSet = known ? new Set(known) : null;
    for (let pn = 1; ; pn++) {
      if (pn > 1) await new Promise((r) => setTimeout(r, 300));
      let data;
      try {
        // Without platform=web the list leaves 番剧 episodes out.
        data = await triageBiliGet(`${TRIAGE_BILI_API}/x/v3/fav/resource/list?media_id=${mediaId}&ps=${TriageUi.FAV_PAGE_SIZE}&pn=${pn}&platform=web`);
      } catch (e) {
        // Keep what earlier pages returned; the page must not treat a partial list as the whole folder.
        if (pn === 1) throw e;
        return { items, info, partial: { page: pn, error: e.message } };
      }
      info ||= data?.info ? { title: data.info.title || "", intro: data.info.intro || "" } : null;
      for (const m of data?.medias || []) {
        const ogv = TRIAGE_OGV.includes(m.type);
        if (m.type !== 2 && !ogv) continue;
        items.push({
          bvid: m.bvid || m.bv_id,
          aid: ogv ? triageBvToAv(m.bvid || m.bv_id) : m.id,
          ...(ogv && { ogv: true, ep: `${m.id}:${m.type}` }),
          // A 番剧 episode: title is the season's, intro the episode's (第1集 …); its counts are all 0.
          title: ogv && m.intro ? `${m.title} ${m.intro}` : m.title,
          cover: m.cover,
          upper: m.upper?.name || "",
          // The UP's mid finds its 关注 UP 标签 in the player; snapshots saved before have none (matched by name).
          upperMid: m.upper?.mid ? String(m.upper.mid) : undefined,
          duration: m.duration,
          pubdate: m.pubtime,
          favTime: m.fav_time,
          intro: ogv ? "" : m.intro,
          invalid: m.attr !== 0,
          play: !ogv && Number.isFinite(m.cnt_info?.play) ? m.cnt_info.play : undefined
        });
      }
      if (!data?.has_more) break;
      // More to come but nothing on this page (seen under risk control): what follows is unread, not gone.
      if (!data?.medias?.length) return { items, info, partial: { page: pn, error: "B站 返回了空的一页" } };
      if (knownSet && (data.medias || []).every((m) => knownSet.has(m.bvid || m.bv_id))) return { items, info, head: true };
      // Page progress for the triage page's loading line; no open page to receive it is fine.
      globalThis.chrome?.runtime?.sendMessage?.({ type: "triage-folder-page", mediaId: String(mediaId), page: pn })?.catch?.(() => {});
    }
    // The id list is what 所有收藏夹 later checks against: it can hold entries the paged list leaves out, so comparing
    // it with the items would flag the folder every time. null when it fails; the check then falls back to the items.
    const ids = await triageFolderIds(mediaId, items).catch(() => null);
    return { items, ids, info };
  },

  "triage-seen-sync": ({ force } = {}) => seenSync({ force: force === true }),

  // Every video id of a folder in one request, no paging; 所有收藏夹 compares it with the cached list.
  "triage-folder-ids": async ({ mediaId }) => {
    if (!triageFolderId(mediaId)) throw triageError("缺少 mediaId");
    return { bvids: await triageFolderIds(mediaId) };
  },

  // Which of the user's folders hold this video (Bilibili's own 收藏 dialog asks the same): one request per video, no
  // folder's contents are read. The page passes back the mid of its first answer, so one check asks nav once.
  "triage-fav-where": async ({ aid, mid: known }) => {
    if (!triageResOk(aid)) throw triageError("缺少 aid");
    const mid = triageNumId(known) ? known : await triageMid();
    const { rid, type } = triageRes(aid);
    const data = await triageBiliGet(`${TRIAGE_BILI_API}/x/v3/fav/folder/created/list-all?up_mid=${mid}&type=${type}&rid=${rid}`);
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
  "triage-reading-ai-tag": (msg) => triageAiCommand(msg, READING_AI_UNIT),

  "triage-title-get": async ({ bvids }) => {
    const list = Array.isArray(bvids) ? bvids : [];
    const stored = await chrome.storage.local.get(list.map(MdgLimits.KEYS.triageTitle));
    return Object.fromEntries(list.map((b) => [b, stored[MdgLimits.KEYS.triageTitle(b)] || null]));
  },

  "triage-unfav": async ({ mediaId, aids }) => {
    const list = triageAids(aids);
    if (!triageFolderId(mediaId) || !list.length) throw triageError("缺少 mediaId 或 aids");
    if (mediaId === TRIAGE_TOVIEW) {
      for (const a of list) await triageBiliPost("/x/v2/history/toview/del", { aid: triageRes(a).rid });
      return { done: list.length };
    }
    await triageBiliPost("/x/v3/fav/resource/batch-del", {
      media_id: mediaId,
      resources: list.map((a) => triageRes(a).resource).join(","),
      platform: "web"
    });
    return { done: list.length };
  },

  "triage-refav": async ({ mediaId, aid }) => {
    if (!triageFolderId(mediaId) || !triageResOk(aid)) throw triageError("缺少 mediaId 或 aid");
    if (mediaId === TRIAGE_TOVIEW) {
      await triageBiliPost("/x/v2/history/toview/add", { aid: triageRes(aid).rid });
      return {};
    }
    const { rid, type } = triageRes(aid);
    await triageBiliPost("/x/v3/fav/resource/deal", { rid, type, add_media_ids: mediaId, del_media_ids: "" });
    return {};
  },

  // 移动 / 复制 to another folder (never 稍后再看); without from, just 收藏 into it (videos from 已出分拣范围).
  // From 稍后再看 or nowhere there is no batch endpoint: add one by one, then remove. The page sends one video per
  // request from 稍后再看. A removal that B站 limits is thrown as it is: the run waits and sends the same video again (the
  // add is idempotent). Any other failed removal is not undone and not a failure: the video is in the target and still
  // in 稍后再看, answered as stayed (its aids) with the reason, so the page shows it copied rather than moved.
  "triage-transfer": async ({ from, to, aids, move }) => {
    const list = triageAids(aids);
    if (!triageNumId(to) || (from && !triageFolderId(from)) || String(from) === String(to) || !list.length) throw triageError("缺少目标或 aids");
    if (!from || from === TRIAGE_TOVIEW) {
      const stayed = [];
      let stayedError = "";
      for (const aid of list) {
        const { rid, type } = triageRes(aid);
        await triageBiliPost("/x/v3/fav/resource/deal", { rid, type, add_media_ids: to, del_media_ids: "" });
        if (move && from) {
          await triageBiliPost("/x/v2/history/toview/del", { aid: rid }).catch((e) => {
            if (e.code === MdgErrors.CODE.THROTTLED) throw e;
            stayed.push(aid);
            stayedError = e.message;
          });
        }
      }
      return stayed.length ? { done: list.length, stayed, stayedError } : { done: list.length };
    }
    await triageBiliPost(`/x/v3/fav/resource/${move ? "move" : "copy"}`, {
      src_media_id: from,
      tar_media_id: to,
      mid: await triageMid(),
      resources: list.map((a) => triageRes(a).resource).join(","),
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

  // 一篇摘录 and the 逐个视频笔记 index: one file into the B站 notes' folder, up to its first per-video folder
  // (MdgNote.sharedNoteFolder).
  "triage-export": async ({ filename, markdown }) => {
    const name = String(filename || "").trim();
    if (!name) throw triageError("缺少文件名");
    const settings = await getMergedSettings();
    const folder = MdgNote.sharedNoteFolder(settings.noteFolder);
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
              { header: "Referer", operation: "set", value: `${TRIAGE_BILI_WEB}/` },
              { header: "Origin", operation: "set", value: TRIAGE_BILI_WEB }
            ]
          },
          condition: {
            requestDomains: [new URL(TRIAGE_BILI_API).host],
            tabIds: [chrome.tabs.TAB_ID_NONE],
            resourceTypes: ["xmlhttprequest", "other"]
          }
        }
      ]
    })
    .catch((e) => console.warn("[triage] DNR 规则注册失败", e));
}

// 观看进度 turned 关 drops its history; the ticked folders or their snapshots changed make the next read recount.
function triageStorageChanged(changes, area) {
  const c = area === "sync" && changes.seenShow;
  if (c && MdgSettings.seenOn(c.oldValue) && !MdgSettings.seenOn(c.newValue)) seenClear().catch((e) => console.warn("[triage] 清除观看进度失败", e));
  const snapshot = MdgLimits.KEYS.triageSnapshot("");
  if (area === "local" && Object.keys(changes).some((k) => k === MdgLimits.KEYS.triageIncludedFolders || k.startsWith(snapshot))) {
    chrome.storage.local.set({ [SEEN_RECOUNT]: true }).catch(() => {});
  }
}

// A message from one of the extension's own pages (not a content script in a B站 or YouTube page).
const fromExtensionPage = (sender) => String(sender?.url || "").startsWith(chrome.runtime.getURL(""));

// Answers the types in handlers: handlers[type](message, sender), called at once (sidePanel.open needs the click), its
// result as reply(result) ({ ok: true, data } by default), a throw as { ok: false, error, code? }. Other types are left
// to the other listeners; one under prefix (triage-, follow-) without a handler is answered as unknown. Returns the listener.
// Only the extension's own pages are answered, so a script in a B站 or YouTube page cannot write to the account, spend
// AI tokens, send a key elsewhere or save settings; webTypes are the ones its content scripts send (messages.selftest.js
// checks them against messages.js and the manifest).
function triageListen(prefix, handlers, webTypes = [], reply = (data) => ({ ok: true, data })) {
  const listener = (message, sender, sendResponse) => {
    const type = message?.type;
    if (typeof type !== "string") return false;
    if (!Object.hasOwn(handlers, type)) {
      if (prefix && type.startsWith(prefix)) sendResponse({ ok: false, error: `未知消息类型 ${type}` });
      return false;
    }
    if (!webTypes.includes(type) && !fromExtensionPage(sender)) {
      sendResponse({ ok: false, error: `网页不能发送 ${type}` });
      return false;
    }
    new Promise((resolve) => resolve(handlers[type](message, sender)))
      .then((r) => sendResponse(reply(r)))
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
  chrome.storage.onChanged.addListener(triageStorageChanged);

  triageListen("triage-", TRIAGE_HANDLERS, ["triage-open", "triage-seen-sync"]);
}
