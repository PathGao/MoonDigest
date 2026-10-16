// /usr/local/bin/node extension/wording.selftest.js
// Convention check (reads the shipped source; not a behavior test): user-facing words against MdgErrors' text table.
// It reads what the user can see — string literals (comments and regexes skipped), the text between tags in them and
// in the pages, and the title / aria-label / placeholder / alt / data-idle values — and checks:
//   (a) every MdgErrors.TEXT / LABEL entry is used (TEXT.key, LABEL.key, or data-text="key" in a page);
//   (b) no entry is written out elsewhere: a TEXT sentence anywhere inside a literal, a LABEL name as a whole literal,
//       text or attribute. A page's static copy is marked data-text="key" on its element and must equal the entry;
//   (c) DESIGN's wording rules on the table and every remaining literal: no position words, 「选中的 N 个」 never
//       「选中 N 个」, and notes say states, never instructions;
//   (d) a named sentence (a string constant of TriageUi or MdgLimits, e.g. TriageUi.BILI_STUCK) is not written out
//       outside its file, like a TEXT sentence;
//   (e) no text is written on two pages: a literal, page text or attribute (two or more 汉字; four in a template piece)
//       that two pages (or a page and a shared file) both write fails, unless DUPLICATES below gives the reason;
//   (f) no word DESIGN's 术语表 lists under 不用, for the words that can be told apart from plain text (TERMS below).
// --report lists every finding instead of failing on the first kind.
if (process.versions.bun) (console.error("This selftest needs Node: it fails or hangs under bun (see 自检 in README.md)."), process.exit(1));
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const read = (f) => fs.readFileSync(path.join(__dirname, f), "utf8");
const ctx = vm.createContext({});
ctx.globalThis = ctx;
vm.runInContext(read("errors.js"), ctx);
const { TEXT, LABEL } = ctx.MdgErrors;
const TABLE = { ...TEXT, ...LABEL };
for (const f of ["limits.js", "settings.js", "tag-core.js", "typing.js", "triage/shared.js"]) vm.runInContext(read(f), ctx);
assert.strictEqual(Object.keys(TABLE).length, Object.keys(TEXT).length + Object.keys(LABEL).length, "TEXT and LABEL keys overlap");

const files = [];
const walk = (dir) => {
  for (const e of fs.readdirSync(path.join(__dirname, dir), { withFileTypes: true })) {
    const rel = path.join(dir, e.name).split(path.sep).join("/");
    if (e.isDirectory()) e.name !== "dev" && e.name !== "dev-sidepanel" && walk(rel);
    else if (/\.(js|html)$/.test(e.name) && !e.name.endsWith(".selftest.js")) files.push(rel);
  }
};
walk(".");
assert.ok(files.includes("content.js") && files.includes("triage/triage.html"), `found ${files.length} files`);

// The string literals of a script: each quoted string, and each static piece of a template (split at ${…}).
// Comments and regex literals are skipped; a / starts a regex after an operator, an opening bracket or a keyword.
function literals(src) {
  const out = [];
  const stack = []; // open ${ in templates: brace depth inside each
  let i = 0;
  let prev = "";
  const lineAt = (at) => src.slice(0, at).split("\n").length;
  // whole: the piece is a whole template (no ${…} in it); a piece next to a ${…} is part of a longer text.
  const template = () => {
    let s = "";
    const at = i;
    const opened = src[i] === "`";
    for (i++; i < src.length; i++) {
      const c = src[i];
      if (c === "\\") s += src[++i];
      else if (c === "`") return i++, out.push({ s, line: lineAt(at), whole: opened });
      else if (c === "$" && src[i + 1] === "{") return out.push({ s, line: lineAt(at), whole: false }), (i += 2), stack.push(0);
      else s += c;
    }
  };
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) i++;
    else if (c === "/" && src[i + 1] === "/") i = src.indexOf("\n", i) < 0 ? src.length : src.indexOf("\n", i);
    else if (c === "/" && src[i + 1] === "*") i = src.indexOf("*/", i + 2) + 2;
    else if (c === "/" && (prev === "" || /[(,=:[!&|?{};+\-*%<>~^]$/.test(prev) || /^(return|typeof|case|in|of|void|delete)$/.test(prev))) {
      let cls = false;
      for (i++; i < src.length; i++) {
        if (src[i] === "\\") i++;
        else if (src[i] === "[") cls = true;
        else if (src[i] === "]") cls = false;
        else if (src[i] === "/" && !cls) break;
      }
      i++;
      while (/\w/.test(src[i])) i++;
      prev = "regex";
    } else if (c === '"' || c === "'") {
      let s = "";
      const at = i;
      for (i++; i < src.length && src[i] !== c; i++) s += src[i] === "\\" ? src[++i] : src[i];
      i++;
      out.push({ s, line: lineAt(at), whole: true });
      prev = "str";
    } else if (c === "`") {
      template();
      prev = "str";
    } else if (c === "{") {
      if (stack.length) stack[stack.length - 1]++;
      i++;
      prev = c;
    } else if (c === "}" && stack.length && stack.at(-1) === 0) {
      stack.pop();
      template(); // steps over the } as over an opening backtick
      prev = "str";
    } else if (/[\w$]/.test(c)) {
      const m = /^[\w$]+/.exec(src.slice(i, i + 64))[0];
      i += m.length;
      prev = m;
    } else {
      if (c === "}" && stack.length) stack[stack.length - 1]--;
      i++;
      prev = c;
    }
  }
  return out;
}

// What markup shows: text between tags and the attributes a reader hears or sees. mark is the data-text key of the
// element the text or attribute belongs to (text: the first text inside the marked element). whole: false when markup
// is a template piece next to a ${…}; then its first and last text are parts of a longer text.
const SHOWN_ATTRS = /\s(title|aria-label|placeholder|alt|data-idle|data-name|aria-description)="([^"]*)"/g;
function shown(markup, line0, out, marks, whole = true) {
  let open = null; // the marked element whose text has not come yet
  let last = 0;
  const lineAt = (at) => line0 + markup.slice(0, at).split("\n").length - 1;
  const text = (s, at, edge) => {
    const t = s.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").trim();
    if (t) out.push({ s: t, line: lineAt(at), mark: open?.key, whole: whole || !edge }), (open = null);
  };
  for (const m of markup.matchAll(/<(\/?)([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>])*)>/g)) {
    text(markup.slice(last, m.index), last, last === 0);
    last = m.index + m[0].length;
    if (m[1] && m[2] === open?.tag) open = null;
    const key = /\sdata-text="([^"]*)"/.exec(m[3])?.[1];
    if (key) marks.push((open = { key, tag: m[2], line: lineAt(m.index) }));
    for (const a of m[3].matchAll(SHOWN_ATTRS)) a[2].trim() && out.push({ s: a[2].trim(), line: lineAt(m.index), mark: key, whole: true });
  }
  text(markup.slice(last), last, true);
}

const segments = {}; // file → [{ s, line, mark }]
const marks = []; // [{ file, key, tag, line }]
for (const f of files) {
  const out = (segments[f] = []);
  const fileMarks = [];
  if (f.endsWith(".html")) {
    const src = read(f).replace(/<!--[\s\S]*?-->|<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, (m) => m.replace(/[^\n]/g, ""));
    shown(src, 1, out, fileMarks);
  } else {
    for (const { s, line, whole } of literals(read(f))) s.includes("<") ? shown(s, line, out, fileMarks, whole) : s.trim() && out.push({ s: s.trim(), line, whole });
  }
  for (const m of fileMarks) marks.push({ file: f, ...m });
}

const found = { use: [], copy: [], word: [] };
// (a) every entry is used.
const code = files.filter((f) => f.endsWith(".js")).map((f) => read(f).replace(/\/\*[\s\S]*?\*\/|(^|[^:"'`\\])\/\/.*$/gm, "$1")).join("\n");
for (const [table, name] of [[TEXT, "TEXT"], [LABEL, "LABEL"]]) {
  for (const key of Object.keys(table)) {
    if (!new RegExp(`\\b${name}\\.${key}\\b`).test(code) && !marks.some((m) => m.key === key)) found.use.push(`${name}.${key} 「${table[key]}」 is used nowhere`);
  }
}
for (const m of marks) if (!(m.key in TABLE)) found.use.push(`${m.file}:${m.line} data-text="${m.key}" is not in MdgErrors.TEXT / LABEL`);

// (b) written once.
for (const f of files.filter((f) => f !== "errors.js")) {
  for (const { s, line, mark } of segments[f]) {
    for (const [key, value] of Object.entries(TABLE)) {
      const hit = key in TEXT ? s.includes(value) : s === value;
      if (!hit) continue;
      if (mark === key && s === value) continue;
      found.copy.push(`${f}:${line} writes 「${value}」 itself; use ${key in TEXT ? "TEXT" : "LABEL"}.${key}${f.endsWith(".html") ? ` or data-text="${key}"` : ""}`);
    }
  }
}
for (const m of marks) {
  if (m.key in TABLE && !segments[m.file].some((x) => x.mark === m.key && x.s === TABLE[m.key])) found.copy.push(`${m.file}:${m.line} data-text="${m.key}" no longer says 「${TABLE[m.key]}」`);
}

// (c) wording rules, on the table and on every literal that has Chinese in it.
const CJK = /[一-鿿]/;
const all = [...Object.entries(TABLE).map(([k, s]) => ({ where: `errors.js ${k}`, s })), ...files.flatMap((f) => segments[f].filter((x) => CJK.test(x.s)).map((x) => ({ where: `${f}:${x.line}`, s: x.s })))];
// J13: name the control, never where it sits (the layout moves with the width).
const POSITION = /左边|右边|左下角|右下角|左上角|右上角|左侧|右侧|上面的|下面的|上方|下方|旁|第 ?[0-9一二三四] ?行/;
// 选中的 N 个 (DESIGN 术语表, 2026-10-14); 已选中 N 个 and 选中 · N 个 are the selection bar's and the dialog's counts.
const PICKED = /(?<![已的])选中 ?(\d+|\$\{|N) ?个/;
// Words the user never reads: AI prompts may point within the prompt itself.
const NOT_SHOWN = [
  ["background.js", "只能依据下面的简介和评论回答"], // the side panel's prompt; 下面 is the next part of the prompt
  ["triage/triage-bg.js", "优先于上面的说明"] // 分拣台's prompt; 上面 is the instructions before it
];
for (const { where, s } of all) {
  if (NOT_SHOWN.some(([f, part]) => where.startsWith(`${f}:`) && s.includes(part))) continue;
  const hit = s.match(POSITION)?.[0] || s.match(PICKED)?.[0];
  if (hit) found.word.push(`${where} 「${s}」 says 「${hit}」`);
}
// Notes stay in the vault: they say a state, never what to do (DESIGN: 笔记只写状态，不写怎么操作).
const ORDER = /请|稍后|刷新|点「|点击|去设置|去登录|重试/;
for (const { s, line } of segments["note.js"]) if (CJK.test(s) && ORDER.test(s)) found.word.push(`note.js:${line} 「${s}」 tells the reader what to do`);
for (const s of [ctx.MdgErrors.subtitleMissing(), ctx.MdgErrors.subtitleMissing({ subtitleFailure: "x" }), ctx.MdgErrors.subtitleMissing({ subtitleNeedLogin: true })]) assert.ok(!ORDER.test(s), `subtitleMissing goes into notes: 「${s}」`);

// (d) named sentences: the string constants (UPPER_CASE, or the strings in an UPPER_CASE array or plain object) that
// TriageUi and MdgLimits export for text with 汉字, outside the file that defines them.
const NAMED = [];
for (const [owner, file] of [["TriageUi", "triage/shared.js"], ["MdgLimits", "limits.js"]]) {
  for (const [name, value] of Object.entries(ctx[owner]).filter(([k]) => /^[A-Z][A-Z0-9_]+$/.test(k))) {
    const leaves = typeof value === "string" ? [[name, value]] : Object.entries(value && typeof value === "object" ? value : {}).map(([k, v]) => [`${name}.${k}`, v]);
    for (const [key, text] of leaves) if (typeof text === "string" && CJK.test(text) && !text.includes("<") && !Object.values(TABLE).includes(text)) NAMED.push({ owner, file, key, text });
  }
}
assert.ok(["BILI_STUCK", "SEEN_LIMITS_TEXT", "CLEAN_BACKUP.ask", "AI_RECENT_RULES.0"].every((k) => NAMED.some((n) => n.key === k)), `named sentences: ${NAMED.map((n) => n.key)}`);
for (const f of files) {
  for (const { s, line } of segments[f]) {
    for (const n of NAMED) if (f !== n.file && s.includes(n.text)) found.copy.push(`${f}:${line} writes 「${n.text}」 itself; use ${n.owner}.${n.key}`);
  }
}

// (e) one text, one copy. DESIGN: text two pages show lives in MdgErrors.TEXT / LABEL (分拣台's own in TriageUi).
// A page is its html, its scripts and its state module; a shared file (sites.js, note.js, download.js, …) is its own.
// Words of one 汉字, or fewer than three characters, are parts of many texts (标题、取消、UP 主), not one text twice. A
// piece of a template next to a ${…} counts from four 汉字 on (「初始化失败：」), shorter ones are joints (「 个视频」).
const PAGES = [
  [/^popup\./, "弹窗"],
  [/^sidepanel/, "侧边栏"],
  [/^(content|badges|bili-surfaces)\.js$/, "B站 / YouTube 页面"],
  [/^history\//, "视频记录"],
  [/^options\./, "设置页"],
  [/^(background|obsidian)\.js$|^triage\/(triage|follow)-bg\.js$/, "后台"],
  [/^triage\//, "分拣台"]
];
const pageOf = (f) => PAGES.find(([re]) => re.test(f))?.[1] || f;
// Each existing copy: the text, the files that write it, and why it stays: 待修 (a real breach waiting for its fix; Cn is
// the id in the 2026-10-16 scan) or 例外. Another file writing it fails, and so does a line whose text is no longer on
// two pages (drop it).
const DUPLICATES = [
  ["优先输出：主题与核心观点、关键数据与事实、逻辑链路与重要结论、可执行建议。", "background.js settings.js", "例外：background.js 的 LEGACY_DEFAULT_AI_SYSTEM_PROMPT 是旧的默认提示词原文，用来认出没改过的旧设置，必须和当年一字不差"],
  ["信息不足时明确说明，不得猜测或编造；涉及专业内容时，区分事实、数据、推测与作者观点。", "background.js settings.js", "例外：同上，旧默认提示词原文"],
  ["输出时间戳时请使用普通正文格式，如 09:15、01:09:15，不要使用反引号、代码块或表格代码格式包裹时间戳。", "background.js settings.js", "例外：同上，旧默认提示词原文"],
  ["该笔记已存在", "content.js download.js", "例外：视频页用不了扩展页面的 dialog，content.js 自己画一份，download.selftest.js 核对一字不差（ARCHITECTURE）"],
  ["只更新 AI 问答：保留原笔记，只替换标记之间的「AI 问答」。整篇覆盖：替换全部内容。", "content.js download.js", "例外：同上，「该笔记已存在」确认框的两份"],
  ["整篇覆盖", "content.js download.js", "例外：同上，「该笔记已存在」确认框的两份"],
  ["只更新 AI 问答", "content.js download.js", "例外：同上，「该笔记已存在」确认框的两份"],
  ["账号已注销", "triage/follow-bg.js triage/follow.js", "例外：follow-bg.js 里的是 B站 给注销账号的占位名（接口数据，按它认人），follow.js 显示的状态名恰好同字"],
  ["标题粗看", "badges.js triage/fav-base.js", "待修：C34（badges.js 同一张 STAGE 表）"],
  ["字幕细看", "badges.js triage/fav-base.js", "待修：C34（badges.js 同一张 STAGE 表）"],
  ["UP 标签", "bili-surfaces.js triage/follow.js triage/shared.js", "待修：C55"],
];
{
  const where = new Map(); // text → [file:line]
  for (const f of files.filter((f) => f !== "errors.js" && f !== "messages.js")) {
    for (const { s, line, whole } of segments[f]) {
      const han = (s.match(/[一-鿿]/g) || []).length;
      if (han < (whole ? 2 : 4) || s.replace(/\s/g, "").length < 3 || Object.values(TABLE).includes(s)) continue;
      where.set(s, [...(where.get(s) || []), `${f}:${line}`]);
    }
  }
  const twice = [...where].filter(([, at]) => new Set(at.map((x) => pageOf(x.split(":")[0]))).size > 1);
  const known = (s, at) => DUPLICATES.some(([t, list]) => t === s && at.every((x) => list.split(" ").includes(x.split(":")[0])));
  found.twice = twice.filter(([s, at]) => !known(s, at)).map(([s, at]) => `「${s}」 is written on more than one page: ${at.join(" ")}; put it in MdgErrors.TEXT / LABEL`);
  for (const [s] of DUPLICATES) if (!twice.some(([t]) => t === s)) found.twice.push(`DUPLICATES 「${s}」 is no longer on two pages; drop the line`);
  if (process.argv.includes("--report")) console.log(`twice (allowed in DUPLICATES): ${twice.length - found.twice.length}`);
}

// (f) the 术语表's 不用 words that never are plain text: [pattern, the 概念 cell of its row, the word in its 不用 cell].
// Not here (they need the context a person reads): 同步 / 更新 (Obsidian sync is 同步), 设置 / 标准 / 规则 / 追问 /
// 复制 / 总结 alone, 已取消收藏 / 已取消关注 as a tab name, UP 主 in the reader's bar, 播放器, 找回 (a video back from
// 已出分拣范围 is 找回 too), 播放列表 (B站's own lists).
const TERMS = [
  [/管理标签/, "管理自定义标签的弹窗", "管理标签"],
  [/批量打(?!标签)/, "让 AI 批量打标签", "批量打"],
  [/去 ?B站/, "去 B站 的链接", "去 B站"],
  [/打开原视频/, "去 B站 的链接", "打开原视频"],
  [/分拣设置/, "两种模式各自的设置弹窗", "分拣设置"],
  [/批量导出/, "导出入口", "批量导出"],
  [/收藏夹分拣台/, "分拣台页面", "收藏夹分拣台"],
  [/优先看/, "临时的待看清单", "优先看"],
  [/可以删|待定/, "AI 判断的三类", "可以删 / 待定"],
  [/已封禁/, "关注里离开分拣范围的 UP 主那一页", "已封禁"],
  [/又有投稿/, "投稿已清空的 UP 主又能看到视频", "又有投稿"],
  [/看过 ?(\d|\$\{|N)/, "封面上标出的观看位置", "看过 N%"],
  [/我的笔记/, "你自己在卡片上写的文字", "我的笔记"],
  [/阅读视图/, "保留播放器、藏起网站其他部分的模式", "阅读视图"],
  [/AI 对话历史/, "按视频列出总结、备注和对话的页面", "AI 对话历史"],
  [/取关(?!注)/, "不再关注一个 UP 主", "取关"],
  [/侧栏/, "分拣台左边的收藏夹列表或分组列表（只在文档里出现）", "侧栏"],
  [/BiliDigest/, "扩展的名字", "BiliDigest"]
];
{
  const design = fs.readFileSync(path.join(__dirname, "../docs/DESIGN.md"), "utf8");
  const rows = new Map(design.split("\n").filter((l) => l.startsWith("| ")).map((l) => l.split("|").map((c) => c.trim())).map((c) => [c[1], c[3]]));
  for (const [, concept, word] of TERMS) {
    for (const w of word.split(" / ")) assert.ok(rows.get(concept)?.includes(w.replace(" N%", "")), `DESIGN 术语表 has no row 「${concept}」 that says 不用 「${w}」: update TERMS`);
  }
  found.term = [];
  const shownText = [...Object.entries(TABLE).map(([k, s]) => ({ where: `errors.js ${k}`, s })), ...files.filter((f) => f !== "messages.js").flatMap((f) => segments[f].map((x) => ({ where: `${f}:${x.line}`, s: x.s })))];
  for (const { where, s } of shownText) {
    for (const [re, concept] of TERMS) if (re.test(s)) found.term.push(`${where} 「${s.slice(0, 60)}」 says 「${s.match(re)[0]}」; DESIGN 术语表 「${concept}」`);
  }
}

const report = process.argv.includes("--report");
for (const [kind, list] of Object.entries(found)) {
  if (report) console.log(`${kind}: ${list.length}\n  ${list.join("\n  ")}`);
  else assert.deepStrictEqual(list, [], `${kind}:\n${list.join("\n")}`);
}
console.log(`wording selftest ok: ${files.length} files, ${Object.keys(TABLE).length} table entries, ${marks.length} page copies`);
