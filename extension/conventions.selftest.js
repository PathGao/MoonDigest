// /usr/local/bin/node extension/conventions.selftest.js
// Three conventions the audits keep finding broken, as scans over the shipped source. Report only for now (exit 0);
// it turns into a failing check with an allowlist once the fixes land.
//   1. Switches (DEFAULTS' booleans) take their value only through MdgSettings.normalizeSwitches / DEFAULTS.
//   2. Storage key names are written once, in MdgLimits.KEYS (ARCHITECTURE: 存储键名只写一份).
//   3. A disabled control says why (DESIGN: 按钮灰掉要写原因), through MdgErrors.setReason / TriageUi.reasonAttrs / actBtn.
// Scanned: extension/**/*.js and *.html. Not scanned: *.selftest.js, every dev/ folder and dev-sidepanel/ (mocks, the
// build script and its generated index.html), *.mjs, and per check the file that owns the convention (settings.js,
// limits.js, the helpers' own bodies).
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = __dirname;
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!/^dev/.test(e.name)) walk(rel);
    } else if (/\.(js|html)$/.test(e.name) && !e.name.endsWith(".selftest.js")) files.push(rel);
  }
})(".");
const lines = Object.fromEntries(files.map((f) => [f, read(f).split("\n")]));
const isComment = (line) => /^\s*(\/\/|\*|\/\*|<!--)/.test(line);
const at = (f, i) => `${f}:${i + 1}  ${lines[f][i].trim().slice(0, 160)}`;

const load = (file, name) => {
  const ctx = vm.createContext({ console });
  ctx.globalThis = ctx;
  vm.runInContext(read(file), ctx);
  return ctx[name];
};
const S = load("settings.js", "MdgSettings");
const L = load("limits.js", "MdgLimits");

const report = [];
const section = (title, hits, note = "") => report.push({ title, hits, note });

// 1. Switch coercions: a DEFAULTS boolean key read with its own default or Boolean() outside settings.js.
{
  const keys = Object.keys(S.DEFAULTS).filter((k) => typeof S.DEFAULTS[k] === "boolean");
  const alt = keys.join("|");
  const patterns = [
    new RegExp(`\\b(${alt})\\b\\s*(?:[!=]==?)\\s*(?:true|false|undefined)\\b`), // x.k !== false, === true, !== undefined
    new RegExp(`\\b(${alt})\\b\\s*(?:\\?\\?|\\|\\|)\\s*(?:true|false)\\b`), // x.k ?? true, || false
    new RegExp(`Boolean\\(\\s*[\\w$.?\\[\\]"']*\\b(${alt})\\b\\s*\\)`), // Boolean(settings.k)
    new RegExp(`!!\\s*[\\w$.?]*\\b(${alt})\\b`), // !!settings.k
    new RegExp(`(?:^|\\{\\s*|,\\s*(?<!\\.\\.\\.[\\w$.]+,\\s*))(${alt})\\s*:\\s*(?:true|false)\\b`) // { k: true }: the default written again (not an override after ...spread)
  ];
  const hits = [];
  for (const f of files.filter((f) => f !== "settings.js")) {
    lines[f].forEach((line, i) => {
      if (!isComment(line) && patterns.some((re) => re.test(line))) hits.push(at(f, i));
    });
  }
  section(`1. 开关自己取值（${keys.length} 个开关，settings.js 以外）`, hits);
}

// 2. Storage key names outside limits.js.
{
  const values = Object.values(L.KEYS).filter((v) => typeof v === "string");
  const prefixes = values.filter((v) => v.endsWith("_"));
  const badgesCopies = JSON.parse(
    /const badgesCopies = (\[[^\]]*\])/.exec(read("limits.selftest.js"))[1].replace(/'/g, '"')
  );
  // A quoted literal's leading word, up to its closing quote or a ${.
  const literals = (line) => [...line.matchAll(/(["'`])([A-Za-z0-9_]+)(?=\1|\$\{)/g)].map((m) => m[2]);
  const inKeys = (s) => values.includes(s) || prefixes.some((p) => s.startsWith(p));
  const hits = [];
  const allowed = [];
  const loose = new Map(); // storage-looking literal not in KEYS → { files, at }
  for (const f of files.filter((f) => f !== "limits.js")) {
    lines[f].forEach((line, i) => {
      if (isComment(line)) return;
      for (const s of literals(line)) {
        if (inKeys(s)) {
          (f === "badges.js" && badgesCopies.some((c) => s === c || (c.endsWith("_") && s.startsWith(c))) ? allowed : hits).push(at(f, i));
        } else if (/^(triage|follow|seen|mdg|ai)_[A-Za-z0-9_]*$/.test(s)) {
          const e = loose.get(s) || { files: new Set(), at: [] };
          e.files.add(f);
          e.at.push(at(f, i));
          loose.set(s, e);
        }
      }
    });
  }
  section("2a. KEYS 里的键名在 limits.js 以外又写成字符串", hits);
  section("2a'. 允许的拷贝（badges.js，limits.selftest 的 badgesCopies 核对）", allowed);
  const shared = [...loose].filter(([s, e]) => e.files.size > 1 && !s.startsWith("follow_"));
  section(
    "2b. 不在 KEYS、却有不止一个文件写的存储键",
    shared.flatMap(([s, e]) => [`「${s}」 ${[...e.files].join(", ")}`, ...e.at.map((x) => `    ${x}`)])
  );
  const follow = [...loose].filter(([s, e]) => e.files.size > 1 && s.startsWith("follow_"));
  section("2b'. 已知例外 follow_*（ARCHITECTURE：拆 follow 时再收）", follow.map(([s, e]) => `「${s}」 ${[...e.files].join(", ")}`));
  const single = [...loose].filter(([, e]) => e.files.size === 1).map(([s, e]) => `${s} (${[...e.files][0]})`);
  section("2b''. 只一个文件用的键（允许，只列名字）", [single.join("  ")].filter(Boolean));
}

// 3. Disabled without a reason.
{
  // The helpers that write the reason themselves: their bodies are the convention, not a breach of it.
  const helperDef = /function setReason\b|const reasonAttrs =/;
  const inHelper = (f, i) => lines[f].slice(Math.max(0, i - 2), i + 1).some((l) => helperDef.test(l));
  const near = (f, i) => lines[f].slice(Math.max(0, i - 3), i + 4).join("\n");
  const raw = [];
  const bare = [];
  const handRolled = [];
  const titleOnly = [];
  for (const f of files) {
    lines[f].forEach((line, i) => {
      if (isComment(line) || inHelper(f, i)) return;
      // A property write that turns it off: = true, = Boolean(x), = !x, = busy … (= false only turns it back on).
      if (/\.disabled\s*=(?!=)(?!\s*false\b)/.test(line) || /(?:setAttribute|toggleAttribute)\(\s*["']disabled["']/.test(line)) {
        const why = /aria-busy|\.title\s*=|aria-description|setReason/.test(near(f, i)) ? "  [附近有 title/aria-busy]" : "";
        raw.push(at(f, i) + why);
      }
      // A disabled attribute in markup or a template string (not .disabled, :disabled, [disabled] or a word in prose).
      if (/(?:^|[\s`])disabled(?=[\s"'`>/=]|$)/.test(line) && !/[.:[]disabled\b/.test(line.replace(/\.disabled\s*=.*/, ""))) {
        if (/reasonAttrs\(|actBtn\(/.test(line)) return;
        const hasTitle = /title=/.test(line);
        const hasDesc = /aria-description=/.test(line);
        const tag = /aria-hidden="true"\s+disabled/.test(line) ? "  [aria-hidden 占位]" : "";
        (hasTitle && hasDesc ? handRolled : hasTitle ? titleOnly : bare).push(at(f, i) + tag);
      }
    });
  }
  section("3a. 直接写 .disabled（不经 setReason），人工判断", raw);
  section("3b. 模板 / HTML 里的 disabled 没写 title", bare);
  section("3c. 手写 title + aria-description（该用 reasonAttrs / setReason）", handRolled);
  section("3d. 只写了 title、没写 aria-description", titleOnly);
}

console.log(`conventions selftest (report only), scanned ${files.length} files\n`);
for (const { title, hits } of report) {
  const n = title.startsWith("2b''") ? (hits[0] ? hits[0].split("  ").length : 0) : hits.filter((h) => !h.startsWith("    ")).length;
  console.log(`== ${title}: ${n}`);
  for (const h of hits) console.log(`  ${h}`);
  console.log("");
}
console.log("conventions selftest ok (report only)");
