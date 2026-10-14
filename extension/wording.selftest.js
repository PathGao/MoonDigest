// /usr/local/bin/node extension/wording.selftest.js
// Convention check (reads the shipped source; not a behavior test): user-facing words against MdgErrors' text table.
// It reads what the user can see — string literals (comments and regexes skipped), the text between tags in them and
// in the pages, and the title / aria-label / placeholder / alt / data-idle values — and checks:
//   (a) every MdgErrors.TEXT / LABEL entry is used (TEXT.key, LABEL.key, or data-text="key" in a page);
//   (b) no entry is written out elsewhere: a TEXT sentence anywhere inside a literal, a LABEL name as a whole literal,
//       text or attribute. A page's static copy is marked data-text="key" on its element and must equal the entry;
//   (c) DESIGN's wording rules on the table and every remaining literal: no position words, 「选中的 N 个」 never
//       「选中 N 个」, and notes say states, never instructions.
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
  const template = () => {
    let s = "";
    const at = i;
    for (i++; i < src.length; i++) {
      const c = src[i];
      if (c === "\\") s += src[++i];
      else if (c === "`") return i++, out.push({ s, line: lineAt(at) });
      else if (c === "$" && src[i + 1] === "{") return out.push({ s, line: lineAt(at) }), (i += 2), stack.push(0);
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
      out.push({ s, line: lineAt(at) });
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
// element the text or attribute belongs to (text: the first text inside the marked element).
const SHOWN_ATTRS = /\s(title|aria-label|placeholder|alt|data-idle|data-name|aria-description)="([^"]*)"/g;
function shown(markup, line0, out, marks) {
  let open = null; // the marked element whose text has not come yet
  let last = 0;
  const lineAt = (at) => line0 + markup.slice(0, at).split("\n").length - 1;
  const text = (s, at) => {
    const t = s.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").trim();
    if (t) out.push({ s: t, line: lineAt(at), mark: open?.key }), (open = null);
  };
  for (const m of markup.matchAll(/<(\/?)([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>])*)>/g)) {
    text(markup.slice(last, m.index), last);
    last = m.index + m[0].length;
    if (m[1] && m[2] === open?.tag) open = null;
    const key = /\sdata-text="([^"]*)"/.exec(m[3])?.[1];
    if (key) marks.push((open = { key, tag: m[2], line: lineAt(m.index) }));
    for (const a of m[3].matchAll(SHOWN_ATTRS)) a[2].trim() && out.push({ s: a[2].trim(), line: lineAt(m.index), mark: key });
  }
  text(markup.slice(last), last);
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
    for (const { s, line } of literals(read(f))) s.includes("<") ? shown(s, line, out, fileMarks) : s.trim() && out.push({ s: s.trim(), line });
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

// (b) written once. badges.js runs on B站 pages without errors.js, so it keeps word-for-word copies of these.
const BADGES_COPIES = ["reloaded"];
for (const key of BADGES_COPIES) assert.ok(segments["badges.js"].some((x) => x.s === TABLE[key]), `badges.js no longer shows TEXT.${key} word for word`);
for (const f of files.filter((f) => f !== "errors.js")) {
  for (const { s, line, mark } of segments[f]) {
    for (const [key, value] of Object.entries(TABLE)) {
      const hit = key in TEXT ? s.includes(value) : s === value;
      if (!hit || (f === "badges.js" && BADGES_COPIES.includes(key))) continue;
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

const report = process.argv.includes("--report");
for (const [kind, list] of Object.entries(found)) {
  if (report) console.log(`${kind}: ${list.length}\n  ${list.join("\n  ")}`);
  else assert.deepStrictEqual(list, [], `${kind}:\n${list.join("\n")}`);
}
console.log(`wording selftest ok: ${files.length} files, ${Object.keys(TABLE).length} table entries, ${marks.length} page copies`);
