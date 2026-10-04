// MoonDigest 收藏夹分拣台 background 层。classic script，由 background.js 末尾 importScripts 加载，
// 与 background.js 共享全局作用域，所以顶层名字统一带 triage / TRIAGE_ 前缀。
// 纯函数放顶部（selftest 用 vm 加载，chrome 为 undefined）。

// ===== 纯函数 =====

// 防止拿到别的视频的字幕：最后一句结束时间要落在 [dur*0.5, dur+10]
function triageSubtitleValid(body, dur) {
  if (!Array.isArray(body) || !body.length || !(dur > 0)) return false;
  const lastTo = Number(body[body.length - 1].to);
  return lastTo <= dur + 10 && lastTo >= dur * 0.5;
}

function triageClip(text) {
  const s = String(text || "");
  return s.length > 12000 ? `${s.slice(0, 8000)}……${s.slice(-4000)}` : s;
}

// 从模型输出里取第一个完整的 {...} 或 [...]（去掉 ``` 围栏，跳过字符串里的括号）
function triageExtractJson(content, open) {
  const close = open === "[" ? "]" : "}";
  const s = String(content || "").replace(/```(?:json)?/gi, "");
  const start = s.indexOf(open);
  if (start < 0) throw new Error("AI 返回内容不是 JSON");
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
  if (end < 0) throw new Error("AI 返回的 JSON 不完整");
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch {
    throw new Error("AI 返回的 JSON 无法解析");
  }
}

// AI 判断固定三档。模型答 id（不分大小写）或中文名（含改名前的旧名）都认，其他一律算拿不准。
const TRIAGE_VERDICTS = { keep: "值得留", drop: "可清理", unsure: "拿不准" };
const TRIAGE_VERDICT_ALIASES = { 留: "keep", 可以删: "drop", 待定: "unsure" };
function triageVerdict(v) {
  const s = String(v ?? "").trim();
  const id = s.toLowerCase();
  if (TRIAGE_VERDICTS[id]) return id;
  return Object.keys(TRIAGE_VERDICTS).find((k) => TRIAGE_VERDICTS[k] === s) || TRIAGE_VERDICT_ALIASES[s] || "unsure";
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

// 新标签名：去掉逗号顿号和首尾空白，≤12 字
function triageCleanTagName(name) {
  return String(name ?? "").replace(/[,，、]/g, "").trim().slice(0, 12);
}

function triageParseLlm(content) {
  const obj = triageExtractJson(content, "{");
  const oneLiner = String(obj.one_liner ?? obj.oneLiner ?? "").trim();
  if (!oneLiner) throw new Error("AI 返回缺少 one_liner");
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
  const d = Number(item.duration) || 0;
  const dur = `${Math.floor(d / 60)}:${String(d % 60).padStart(2, "0")}`;
  return `${n}|${clean(item.title)}|${clean(item.upper)}|${dur}|${clean(item.intro).slice(0, 60)}`;
}

// 序号|标题|UP|时长|现有标签|一句话|要点1；要点2；要点3（没有的字段留空）
function triageCommandLine(item, n) {
  const clean = (s) => String(s ?? "").replace(/[|\r\n]+/g, " ").trim();
  const list = (a) => (Array.isArray(a) ? a.map(clean).filter(Boolean) : []);
  const d = Number(item.duration) || 0;
  const dur = d ? `${Math.floor(d / 60)}:${String(d % 60).padStart(2, "0")}` : "";
  return [n, clean(item.title), clean(item.upper), dur, list(item.currentTags).join("、"), clean(item.oneLiner), list(item.points).join("；")].join("|");
}

// 批量打标签的提案只改标签：add 只留已有标签或本次新建的标签（至多 maxNewTags 个），remove 只留视频现有标签；
// 其他字段（如 verdict）一律丢弃，无改动的视频不返回
function triageParseCommand(content, items, tags, { maxNewTags = 5 } = {}) {
  const obj = triageExtractJson(content, "{");
  const existing = new Set(triageTagNames(tags));
  const newTags = [];
  for (const t of Array.isArray(obj.new_tags) ? obj.new_tags : []) {
    if (newTags.length >= maxNewTags) break;
    const name = triageCleanTagName(t && typeof t === "object" ? t.name : t);
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
    const pick = (arr, ok) => [...new Set((Array.isArray(arr) ? arr : []).map((x) => triageCleanTagName(x)))].filter((x) => x && ok(x));
    const a = {
      add: pick(r.add, (x) => valid.has(x) && !current.has(x)),
      remove: pick(r.remove, (x) => current.has(x)),
      reason: String(r.reason ?? "").trim()
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
  "你是 B 站收藏夹分拣助手。根据给出的视频信息总结视频，并按这个收藏夹的用途判断值得留还是可清理。",
  "只输出严格 JSON，不要任何其他文字、不要代码块：",
  '{"one_liner": "一句话说清视频讲了什么，≤40字", "points": ["要点1", "要点2", "要点3"], "verdict": "keep|drop|unsure", "reason": "判断理由，≤30字"}',
  TRIAGE_VERDICT_TEXT,
  "信息太少无法判断时（只有标题简介且简介很短）选 unsure。"
].join("\n");

const TRIAGE_TITLE_PROMPT = [
  "你是 B 站收藏夹分拣助手。下面每行是一个收藏的视频，格式：序号|标题|UP主|时长|简介前60字。",
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

function triageBuildMessages(meta, source, text, criteria, folder) {
  const user = [
    `标题：${meta.title}`,
    `UP主：${meta.upper}`,
    `分区：${meta.tname || "未知"}`,
    `时长：${Math.round((meta.duration || 0) / 60)} 分钟`,
    `标签：${meta.tags.join("、") || "无"}`,
    `简介：${meta.desc || "无"}`,
    source === "subtitle" ? `\n字幕：\n${text}` : `\n（无可用字幕）\n热门评论：\n${text || "无"}`
  ].join("\n");
  return [
    { role: "system", content: triageWithCriteria(TRIAGE_SYSTEM_PROMPT, criteria, folder) },
    { role: "user", content: user }
  ];
}

function triageBuildCommandMessages({ instruction, tags, items, maxNewTags = 5 }) {
  const lines = triageTagLines(tags);
  const example = `{"new_tags": ["标签名"], "items": [{"i": 序号, "add": ["标签"], "remove": ["标签"], "reason": "≤20字"}], "note": "≤60字"}`;
  const system = [
    "你是 B站收藏整理助手，按用户指令给视频打标签、做分类。",
    "用户指令写在 <<<指令>>> 和 <<<指令结束>>> 之间，它就是本次任务的要求。",
    "规则：",
    "- add 只能用已有标签名，或本次 new_tags 里列出的新标签名。",
    `- 可以新建标签，至多 ${maxNewTags} 个，名称 ≤12字、不含逗号；已有标签能用就先用，不要重复造。`,
    "- remove 只能填该视频“现有标签”里的名称。",
    "- 标签带说明（冒号后）的，按说明决定给视频加上还是去掉这个标签。",
    "- reason ≤20字。",
    "- 指令不适用的视频不要放进 items。",
    "- note ≤60字，总结做了什么，或者为什么没有合适的。",
    "- 有“一句话”和“要点”的视频以它们为主要依据，它们比标题可靠得多。",
    "只输出严格 JSON，不要任何其他文字、不要代码块：",
    example,
    "",
    "已有标签（每行一个，格式：名称：说明，没有说明只写名称）：",
    ...(lines.length ? lines : ["（无）"])
  ].join("\n");
  const user = [
    "<<<指令>>>",
    String(instruction ?? "").trim(),
    "<<<指令结束>>>",
    "",
    "视频列表，每行格式：序号|标题|UP主|时长|现有标签|一句话|要点1；要点2；要点3（没有的字段留空）：",
    ...items.map((it, idx) => triageCommandLine(it, idx + 1))
  ].join("\n");
  return [
    { role: "system", content: system },
    { role: "user", content: user }
  ];
}

// ===== chrome 相关 =====

function triageError(error, code) {
  return Object.assign(new Error(error), code ? { code } : {});
}

// Risk control answers HTTP 412 with an HTML page, or code -352/-412 in JSON; both mean back off.
async function triageBiliJson(res) {
  if (!res.ok) throw triageError(`B站请求失败 HTTP ${res.status}`, res.status === 412 ? "THROTTLED" : undefined);
  try {
    return await res.json();
  } catch {
    throw triageError("B站返回的不是 JSON（可能被风控拦截或需要重新登录）");
  }
}

function triageBiliData(json) {
  if (json.code !== 0) throw triageError(`B站返回 ${json.code}: ${json.message}`, json.code === -352 || json.code === -412 ? "THROTTLED" : undefined);
  return json.data;
}

async function triageBiliGet(url) {
  return triageBiliData(await triageBiliJson(await fetch(url, { credentials: "include" })));
}

async function triageBiliPost(path, fields) {
  const cookie = await chrome.cookies.get({ url: "https://www.bilibili.com", name: "bili_jct" });
  if (!cookie?.value) throw triageError("未登录 B 站（缺少 csrf）");
  const res = await fetch(`https://api.bilibili.com${path}`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: triageForm({ ...fields, csrf: cookie.value })
  });
  return triageBiliData(await triageBiliJson(res));
}

// The sites.js fetchers through background fetch, with risk control mapped to THROTTLED like triageBiliGet.
// A player answer without a subtitle object is risk control too.
const TRIAGE_BILI_IO = {
  signWbi: true,
  async fetchJson(url) {
    const json = await fetchJsonForAi(url).catch((e) => {
      throw e.status === 412 ? triageError("B站请求失败 HTTP 412", "THROTTLED") : e;
    });
    if (json?.code === -352 || json?.code === -412) throw triageError(`B站返回 ${json.code}: ${json.message}`, "THROTTLED");
    if (json?.code === 0 && /\/x\/player\//.test(url) && !json.data?.subtitle) throw triageError("B站字幕接口限流，稍后重试", "THROTTLED");
    return json;
  }
};

// nav 未登录时 code=-101，triageBiliGet 会当错误抛出，所以只查 HTTP 与 JSON，由 triageMid 判断登录
async function triageNav() {
  const res = await fetch("https://api.bilibili.com/x/web-interface/nav", { credentials: "include" });
  return (await triageBiliJson(res)).data || {};
}

async function triageMid() {
  const nav = await triageNav();
  if (!nav.isLogin || !nav.mid) throw triageError("未登录 B 站");
  return nav.mid;
}

// type 2 = video, the only type triage-folder-items keeps.
async function triageFolderIds(mediaId) {
  const data = await triageBiliGet(`https://api.bilibili.com/x/v3/fav/resource/ids?media_id=${mediaId}&platform=web`);
  return (data || []).filter((m) => m.type === 2).map((m) => m.bvid || m.bv_id);
}

async function triageCreatedFolders() {
  const mid = await triageMid();
  const data = await triageBiliGet(`https://api.bilibili.com/x/v3/fav/folder/created/list-all?up_mid=${mid}`);
  return { mid, folders: (data?.list || []).map((f) => ({ id: f.id, title: f.title, count: f.media_count })) };
}

// The folder's 判断标准 and the tag names come with each request from the page.
const TRIAGE_SETTINGS_DEFAULTS = {
  triageIntervalSec: 8,
  triageTitleBatchSize: 30,
  triageThinking: false,
  triageTitleMaxTokens: 0,
  triageAnalyzeMaxTokens: 0
};

// 输出上限：用户填了正数就用用户的，否则按是否思考自动（思考 token 计入 max_tokens）
function triageMaxTokens(kind, itemCount, { triageThinking, triageTitleMaxTokens, triageAnalyzeMaxTokens }) {
  // command 与 title 共用 triageTitleMaxTokens
  const custom = Number(kind === "analyze" ? triageAnalyzeMaxTokens : triageTitleMaxTokens);
  if (custom > 0) return Math.floor(custom);
  if (kind === "title") return triageThinking ? 150 * itemCount + 4000 : 60 * itemCount + 200;
  if (kind === "command") return triageThinking ? 180 * itemCount + 4000 : 80 * itemCount + 400;
  return triageThinking ? 8000 : 1000;
}

async function triageAiSettings() {
  const s = await chrome.storage.sync.get({ triageThinking: false, triageTitleMaxTokens: 0, triageAnalyzeMaxTokens: 0 });
  return {
    triageThinking: s.triageThinking === true,
    triageTitleMaxTokens: Number(s.triageTitleMaxTokens) || 0,
    triageAnalyzeMaxTokens: Number(s.triageAnalyzeMaxTokens) || 0
  };
}

async function triageAnalyze({ bvid, force, criteria, folder }) {
  if (!bvid) throw triageError("缺少 bvid");
  const cacheKey = `triage_analysis_${bvid}`;
  if (!force) {
    const cached = (await chrome.storage.local.get(cacheKey))[cacheKey];
    if (cached) return cached;
  }

  const site = BocSites.SITES.bilibili;
  const ref = { site: "bilibili", id: bvid, part: null, url: "" };
  const m = await site.fetchMeta(ref, TRIAGE_BILI_IO);
  const meta = { title: m.title, desc: m.description, upper: m.author, duration: m.duration, tname: m.tname, tags: m.tags };

  let source = "meta";
  let text = "";
  const track = BocSites.pickPreferredTrack(BocSites.rankTracks((await site.fetchTracks(ref, m, TRIAGE_BILI_IO)).tracks), {});
  if (track) {
    const valid = (body) => triageSubtitleValid(body, m.duration);
    const raw = await BocSites.fetchRawCached(site, track, { videoId: bvid, cid: m.cid }, TRIAGE_BILI_IO, valid).catch((e) => {
      // Throttling must reach the page so it backs off; other failures fall back to comments as before.
      if (e?.code === "THROTTLED") throw e;
      return null;
    });
    const body = raw ? site.parseSegments(raw) : [];
    if (valid(body)) {
      source = "subtitle";
      text = triageClip(body.map((l) => l.content).join("\n"));
    }
  }
  if (source === "meta") {
    const comments = await site.fetchComments(ref, m, TRIAGE_BILI_IO, 10).catch(() => []);
    text = triageClip(comments.map((c, i) => `${i + 1}. ${c.message}`).join("\n"));
  }

  const ai = await triageAiSettings();
  const { content, model } = await triageChat(triageBuildMessages(meta, source, text, criteria, folder), triageMaxTokens("analyze", 1, ai), ai.triageThinking);
  const analysis = {
    bvid,
    status: "done",
    source,
    ...triageParseLlm(content),
    model,
    analyzedAt: Date.now()
  };
  await chrome.storage.local.set({ [cacheKey]: analysis });
  return analysis;
}

// 单次 AI 请求的超时（毫秒）。思考模式慢得多；两档都要短于 MV3 单个消息事件约 5 分钟的上限
const TRIAGE_AI_TIMEOUT_MS = { normal: 120000, thinking: 240000 };

// 非流式 chat/completions，只取 message.content（忽略 reasoning_content）
async function triageChat(messages, maxTokens, thinking = false) {
  const provider = (await loadAiProviders()).find((p) => p.enabled !== false);
  if (!provider) throw triageError("请先在设置页配置 AI 平台");
  const apiKey = (await loadAiProviderKeys())[provider.id];
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const baseUrl = String(provider.baseUrl || "").replace(/\/+$/, "");
  const body = { model: provider.model, stream: false, temperature: 0.3, max_tokens: maxTokens, messages };
  // DeepSeek 思考 token 计入 max_tokens；默认关（实测 30 标题 3s/815 token，开则约 19s/4579 token）。其他平台不发该参数
  if (/api\.deepseek\.com/.test(baseUrl)) body.thinking = { type: thinking ? "enabled" : "disabled" };

  const ms = TRIAGE_AI_TIMEOUT_MS[thinking ? "thinking" : "normal"];
  const controller = new AbortController();
  let timer;
  // Racing the timer (not just aborting) also ends a fetch or body read that ignores the abort.
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(triageError(`AI 超时（${ms / 1000} 秒），已跳过，可重试`, "AI_TIMEOUT"));
    }, ms);
  });
  const request = async () => {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal
    }).catch(async (e) => {
      throw triageError((await hostPermissionError(baseUrl)) || e?.message || String(e));
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw triageError(`HTTP ${res.status}: ${detail.slice(0, 200)}`, res.status === 429 ? "AI_THROTTLED" : undefined);
    }
    const json = await res.json();
    const choice = json.choices?.[0];
    if (!choice?.message?.content && choice?.finish_reason === "length") {
      throw triageError("模型输出被截断（思考可能用光了额度），请调大输出上限或关闭思考");
    }
    return { content: choice?.message?.content, model: provider.model };
  };
  try {
    return await Promise.race([request(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function triageClassifyTitles({ items, criteria, folder }) {
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
    ai.triageThinking
  );
  const results = triageParseTitleBatch(content, list);
  const analyzedAt = Date.now();
  // "AI 未返回" 的不缓存，方便下次重试
  const toStore = {};
  for (const [bvid, r] of Object.entries(results)) {
    if (r.reason !== "AI 未返回") toStore[`triage_title_${bvid}`] = { ...r, model, analyzedAt };
  }
  await chrome.storage.local.set(toStore);
  return { results };
}

// 协作打标签：只返回提案，不缓存。新建标签至多 5 个
async function triageAiCommand({ instruction, items, tags }) {
  const text = String(instruction ?? "").trim();
  if (!text) throw triageError("缺少指令");
  const list = (Array.isArray(items) ? items : []).filter((it) => it && it.bvid);
  if (!list.length) throw triageError("缺少 items");
  const ai = await triageAiSettings();
  const opts = { maxNewTags: 5 };
  const { content } = await triageChat(
    triageBuildCommandMessages({ instruction: text, tags, items: list, ...opts }),
    triageMaxTokens("command", list.length, ai),
    ai.triageThinking
  );
  return triageParseCommand(content, list, tags, opts);
}

// One video → one note built the same way the popup's 写入 Obsidian does, plus the stage-2 summary.
async function triageBuildNote(bvid, settings) {
  if (!bvid) throw triageError("缺少 bvid");
  const site = BocSites.SITES.bilibili;
  const io = TRIAGE_BILI_IO;
  const ref = { site: "bilibili", id: bvid, part: null, url: "" };
  const meta = await site.fetchMeta(ref, io);
  ref.url = site.canonicalUrl(bvid, meta.pageCount > 1 ? meta.pageIndex : 1);
  // Throttling and fetch failures reject so no subtitle-less note is written; another video's subtitle is dropped.
  const bundle = await site.fetchTracks(ref, meta, io);
  const track = BocSites.pickPreferredTrack(BocSites.rankTracks(bundle.tracks || []), {});
  const valid = (segments) => triageSubtitleValid(segments, meta.duration);
  const fetched = track ? site.parseSegments(await BocSites.fetchRawCached(site, track, { videoId: bvid, cid: meta.cid }, io, valid)) : [];
  const body = valid(fetched) ? fetched : [];
  const hotComments =
    settings.includeHotCommentsInNote || !body.length ? await site.fetchComments(ref, meta, io, 20).catch(() => []) : [];
  const noteMeta = {
    site: "bilibili",
    videoId: bvid,
    cid: meta.cid,
    aid: meta.aid,
    title: meta.title,
    author: meta.author,
    authorUrl: meta.authorUrl,
    uploadDate: meta.uploadDate,
    description: meta.description,
    videoDuration: meta.duration,
    cover: meta.cover,
    videoTags: meta.tags,
    selectedSubtitleLang: track ? track.label || track.lang : "",
    chapters: bundle.chapters || [],
    hotComments,
    pageIndex: meta.pageIndex,
    pageCount: meta.pageCount,
    pageTitle: meta.pageTitle
  };
  const cacheKey = `triage_analysis_${bvid}`;
  const conversationsKey = BocLimits.KEYS.aiConversations;
  const stored = await chrome.storage.local.get([cacheKey, conversationsKey, "triage_notes"]);
  const analysis = stored[cacheKey];
  noteMeta.aiTurns = BocNote.buildConversationTurns(BocNote.pickConversation(stored[conversationsKey], noteMeta)?.messages);
  const markdown = BocNote.withTriageSummary(BocNote.buildMarkdown(noteMeta, body, settings, ref), analysis, stored.triage_notes?.[bvid]?.text);
  return { meta, noteMeta, body, markdown };
}

// Returns { path, skipped, aiUpdated, title, source }; skipped means the note existed and overwrite was off,
// aiUpdated that its AI 问答 section was rewritten anyway.
async function triageWriteNote({ bvid, overwrite }) {
  const settings = await getMergedSettings();
  if (!settings.obsidianEnabled) throw triageError("Obsidian 写入未启用");
  const baseUrl = String(settings.obsidianApiBaseUrl || "").trim();
  const apiKey = String(settings.obsidianApiKey || "").trim();
  if (!baseUrl || !apiKey) throw triageError("缺少 Local REST API 参数");
  const { meta, noteMeta, body, markdown } = await triageBuildNote(bvid, settings);

  const folder = BocNote.resolveFolderTemplate(settings.noteFolder, noteMeta);
  const filename = BocNote.buildNoteFilename(noteMeta, settings);
  const path = folder ? `${folder}/${filename}` : filename;
  const noteKey = BocSites.buildContextKey(noteMeta);
  if (!overwrite) {
    // An existing note keeps its body; only its marked AI 问答 section follows the conversation.
    const section = settings.includeAiChatInNote === false ? "" : BocNote.buildAiSection(noteMeta.aiTurns);
    const existing = section
      ? await updateAiSectionInVault({ baseUrl, apiKey, filepath: path, section, noteKey })
      : await readVaultNote(baseUrl, apiKey, path);
    if (existing.exists) return { path, skipped: true, aiUpdated: existing.updated === true, title: meta.title };
  }
  const content = await linkCoverInVault(markdown, { url: meta.cover, name: `bilibili-${bvid}` }, { baseUrl, apiKey, filepath: path });
  await putVaultNote(baseUrl, apiKey, path, content);
  await rememberObsidianNotePath(noteKey, path);
  return { path, skipped: false, title: meta.title, source: body.length ? "subtitle" : "meta" };
}

// Notes used to live on basket items; they now belong to the video (triage_notes, bvid → { text, updatedAt }).
// Copies each basket note once, never over an existing entry; the basket items keep theirs.
async function triageMigrateNotes() {
  const stored = await chrome.storage.local.get(["triage_notes_migrated", "triage_basket", "triage_notes"]);
  if (stored.triage_notes_migrated) return;
  const notes = { ...stored.triage_notes };
  for (const item of stored.triage_basket || []) {
    if (item?.bvid && String(item.note || "").trim() && !String(notes[item.bvid]?.text || "").trim()) {
      notes[item.bvid] = { text: item.note, updatedAt: Date.now() };
    }
  }
  await chrome.storage.local.set({ triage_notes: notes, triage_notes_migrated: true });
}

const TRIAGE_HANDLERS = {
  "triage-write-note": (msg) => triageWriteNote(msg),
  "triage-build-note": async ({ bvid }) => {
    const { meta, markdown } = await triageBuildNote(bvid, await getMergedSettings());
    return { title: meta.title, markdown };
  },
  "triage-folders": () => triageCreatedFolders(),

  "triage-folder-items": async ({ mediaId }) => {
    if (!mediaId) throw triageError("缺少 mediaId");
    const items = [];
    let info = null;
    for (let pn = 1; ; pn++) {
      if (pn > 1) await new Promise((r) => setTimeout(r, 300));
      let data;
      try {
        data = await triageBiliGet(`https://api.bilibili.com/x/v3/fav/resource/list?media_id=${mediaId}&ps=20&pn=${pn}`);
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
          duration: m.duration,
          pubdate: m.pubtime,
          favTime: m.fav_time,
          intro: m.intro,
          invalid: m.attr !== 0
        });
      }
      if (!data?.has_more || !data?.medias?.length) break;
      // Page progress for the triage page's loading line; no open page to receive it is fine.
      globalThis.chrome?.runtime?.sendMessage?.({ type: "triage-folder-page", mediaId: String(mediaId), page: pn })?.catch?.(() => {});
    }
    // The id list is what 所有收藏夹 later checks against: it can hold entries the paged list leaves out, so comparing
    // it with the items would flag the folder every time. null when it fails; the check then falls back to the items.
    const ids = await triageFolderIds(mediaId).catch(() => null);
    return { items, ids, info };
  },

  // Every video id of a folder in one request, no paging; 所有收藏夹 compares it with the cached list.
  "triage-folder-ids": async ({ mediaId }) => {
    if (!mediaId) throw triageError("缺少 mediaId");
    return { bvids: await triageFolderIds(mediaId) };
  },

  "triage-analysis-get": async ({ bvids }) => {
    const list = Array.isArray(bvids) ? bvids : [];
    const stored = await chrome.storage.local.get(list.map((b) => `triage_analysis_${b}`));
    return Object.fromEntries(list.map((b) => [b, stored[`triage_analysis_${b}`] || null]));
  },

  "triage-analyze": (msg) => triageAnalyze(msg),

  "triage-classify-titles": (msg) => triageClassifyTitles(msg),

  "triage-ai-command": (msg) => triageAiCommand(msg),

  "triage-title-get": async ({ bvids }) => {
    const list = Array.isArray(bvids) ? bvids : [];
    const stored = await chrome.storage.local.get(list.map((b) => `triage_title_${b}`));
    return Object.fromEntries(list.map((b) => [b, stored[`triage_title_${b}`] || null]));
  },

  "triage-unfav": async ({ mediaId, aids }) => {
    const list = Array.isArray(aids) ? aids : [];
    if (!mediaId || !list.length) throw triageError("缺少 mediaId 或 aids");
    await triageBiliPost("/x/v3/fav/resource/batch-del", {
      media_id: mediaId,
      resources: list.map((a) => `${a}:2`).join(","),
      platform: "web"
    });
    return { done: list.length };
  },

  "triage-refav": async ({ mediaId, aid }) => {
    if (!mediaId || !aid) throw triageError("缺少 mediaId 或 aid");
    await triageBiliPost("/x/v3/fav/resource/deal", { rid: aid, type: 2, add_media_ids: mediaId, del_media_ids: "" });
    return {};
  },

  "triage-settings-get": async () => {
    const s = await chrome.storage.sync.get(TRIAGE_SETTINGS_DEFAULTS);
    const provider = typeof loadAiProviders === "function" ? (await loadAiProviders().catch(() => [])).find((p) => p.enabled !== false) : null;
    return {
      triageIntervalSec: Number(s.triageIntervalSec) >= 0 ? Number(s.triageIntervalSec) : TRIAGE_SETTINGS_DEFAULTS.triageIntervalSec,
      triageTitleBatchSize: Number(s.triageTitleBatchSize) > 0 ? Number(s.triageTitleBatchSize) : 30,
      triageThinking: s.triageThinking === true,
      triageTitleMaxTokens: Number(s.triageTitleMaxTokens) > 0 ? Number(s.triageTitleMaxTokens) : 0,
      triageAnalyzeMaxTokens: Number(s.triageAnalyzeMaxTokens) > 0 ? Number(s.triageAnalyzeMaxTokens) : 0,
      // 开启思考 only reaches DeepSeek (triageChat), so the page shows the switch only for it.
      deepseek: /api\.deepseek\.com/.test(String(provider?.baseUrl || ""))
    };
  },

  "triage-settings-save": async (msg) => {
    const patch = {};
    for (const k of Object.keys(TRIAGE_SETTINGS_DEFAULTS)) if (msg[k] !== undefined) patch[k] = msg[k];
    await chrome.storage.sync.set(patch);
    return {};
  },

  // 与 background.js 的 write-obsidian-note 同一机制：Local REST API PUT /vault/<path>
  // 合并文件写进 B 站视频笔记所在的目录（笔记目录按 site=bilibili 解析）。
  "triage-export": async ({ filename, markdown }) => {
    const name = String(filename || "").trim();
    if (!name) throw triageError("缺少文件名");
    const settings = await getMergedSettings();
    const folder = BocNote.resolveFolderTemplate(settings.noteFolder, { site: "bilibili" });
    const baseUrl = String(settings.obsidianApiBaseUrl || "").trim();
    const apiKey = String(settings.obsidianApiKey || "").trim();
    if (!baseUrl || !apiKey) throw triageError("缺少 Local REST API 参数");
    const path = folder ? `${folder}/${name}` : name;
    const encodedPath = path.split("/").filter(Boolean).map((s) => encodeURIComponent(s)).join("/");
    const res = await fetch(`${baseUrl.replace(/\/+$/g, "")}/vault/${encodedPath}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "text/markdown; charset=utf-8" },
      body: typeof markdown === "string" ? markdown : ""
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw triageError(`HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
    }
    return { path };
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

if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
  triageRegisterDnr();
  triageMigrateNotes().catch((e) => console.warn("[triage] 笔记迁移失败", e));
  chrome.runtime.onInstalled.addListener(triageRegisterDnr);
  chrome.runtime.onStartup.addListener(triageRegisterDnr);

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const type = message?.type;
    if (typeof type !== "string" || !type.startsWith("triage-")) return false;
    const handler = TRIAGE_HANDLERS[type];
    if (!handler) {
      sendResponse({ ok: false, error: `未知消息类型 ${type}` });
      return false;
    }
    Promise.resolve()
      .then(() => handler(message))
      .then((data) => sendResponse({ ok: true, data }))
      .catch((e) => sendResponse({ ok: false, error: e?.message || String(e), ...(e?.code ? { code: e.code } : {}) }));
    return true;
  });
}
