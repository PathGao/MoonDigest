// /usr/local/bin/node extension/conventions.selftest.js
// Three conventions the audits kept finding broken, as checks over the shipped source (AGENTS「用检查代替反复扫描」).
// It matches public contracts: setting keys (MdgSettings.DEFAULTS), storage key names (MdgLimits.KEYS), the disabled
// attribute and the reason helpers' names.
//   1. Switches (DEFAULTS' booleans) take their value only through MdgSettings.normalizeSwitches / DEFAULTS.
//   2. Storage key names are written once, in MdgLimits.KEYS (ARCHITECTURE: 存储键名只写一份).
//   3. A disabled control says why (DESIGN: 按钮灰掉要写原因), through MdgErrors.setReason / TriageUi.reasonAttrs / actBtn.
// Fails on any hit of 1, 2a, 2b, 3c and 3d. 3a and 3b fail on a hit that is not in ALLOW below, and on an ALLOW line that
// matches no hit (its reason no longer holds). Sections marked (允许) only list.
// Scanned: extension/**/*.js and *.html. Not scanned: *.selftest.js, every dev/ folder and dev-sidepanel/ (mocks, the
// build script and its generated index.html), *.mjs, messages.js (the message list, messages.selftest.js), and per check
// the file that owns the convention (settings.js, limits.js, the helpers' own bodies).
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
    } else if (/\.(js|html)$/.test(e.name) && !e.name.endsWith(".selftest.js") && rel !== "messages.js") files.push(rel);
  }
})(".");
const lines = Object.fromEntries(files.map((f) => [f, read(f).split("\n")]));
const isComment = (line) => /^\s*(\/\/|\*|\/\*|<!--)/.test(line);
const at = (f, i) => `${f}:${i + 1}  ${lines[f][i].trim().slice(0, 160)}`;
const hitAt = (f, i, tag = "") => ({ f, i, text: at(f, i) + tag });

const load = (file, name) => {
  const ctx = vm.createContext({ console });
  ctx.globalThis = ctx;
  vm.runInContext(read(file), ctx);
  return ctx[name];
};
const S = load("settings.js", "MdgSettings");
const L = load("limits.js", "MdgLimits");

// 3a / 3b: a control turned off without setReason, and why that one is right. file + a snippet of its line.
const ALLOW = [
  // The control itself says why: its only option is the reason.
  ["content.js", "select.disabled = true;", "专注模式的字幕下拉框：唯一一项就是 noTrackText() 的原因（写在同一行）"],
  ["popup.js", "el.subtitleSelect.disabled = true;", "弹窗字幕下拉框：唯一一项就是 subtitleMissing 的原因"],
  ["sidepanel.js", "els.modelSelect.disabled = true;", "侧边栏平台下拉框：唯一一项就是 TEXT.aiNone"],
  ["sidepanel.js", "els.contextChip.disabled = true;", "上下文胶囊读取失败：胶囊上写着「读取失败」"],
  ["sidepanel.js", "els.contextChip.disabled = !String(context.url", "上下文胶囊只是跳到视频地址：没有地址时胶囊上写着「加载中…」或「未知视频」"],
  ["triage/triage.js", "o.disabled = !c;", "<option>：选项文字写着「· 0 个」"],
  // In flight: the control shows it is busy (busy words / aria-busy) and turns back on when the request ends.
  ["options.js", "button.disabled = Boolean(active);", "保存和测试连接互等：在跑的那个写「保存中…」「测试中…」并 aria-busy"],
  ["options.js", "testBtn.disabled = true;", "AI 平台测试中：同一行写「正在测试…」并 aria-busy，完了 setReason 接手"],
  ["popup.js", "button.disabled = busy;", "弹窗按钮在跑：按钮文字换成在做什么，aria-busy"],
  ["triage/triage.js", "btn.disabled = Boolean(text);", "分拣台按钮在跑：按钮文字换成在做什么，aria-busy"],
  ["triage/follow.js", "btn.disabled = Boolean(j.running);", "关注刷新在跑：aria-busy，进度胶囊写进度"],
  ["triage/follow.js", "refresh.disabled = true;", "点了刷新、后台还没回：回来后 renderSync 接手（aria-busy）或失败时打开"],
  ["triage/follow.js", 't.closest("button").disabled = true;', "空状态的刷新，同上：后台回来前防连点"],
  ["triage/triage.js", "el.writeScope.disabled = el.writeFormat.disabled = el.writeOverwrite.disabled = busy;", "逐个视频笔记在跑：进度胶囊和「停止」写着在跑什么，范围和格式跑完才能改"],
  ["content.js", "button.disabled = true;", "播放器 ✦ 点下到侧边栏打开之间防连点，finally 打开"],
  ["sidepanel.js", "copyBtn.disabled = true;", "复制后 0.5 秒的「已复制」反馈"],
  // 3b
  ["history/history.js", 'aria-hidden="true" disabled>删除 AI 对话', "看不见的占位（aria-hidden、tabindex=-1），只为对齐，不是控件"]
];
// Each line covers exactly one hit: a second line like it is a new case and needs its own reason.
const used = ALLOW.map(() => 0);
const allowed = (hit) => {
  const i = ALLOW.findIndex(([f, snippet]) => hit.f === f && lines[f][hit.i].includes(snippet));
  if (i >= 0) used[i]++;
  return i >= 0 && used[i] === 1;
};

const report = [];
// fail: "any" (every hit fails), "allow" (hits not in ALLOW fail), or "" (only listed).
const section = (title, hits, fail = "") => report.push({ title, hits, fail });

// 1. Switch coercions: a DEFAULTS boolean key read with its own default or Boolean() outside settings.js.
// content.js keeps the reader's switch in state under its own name (state.readingChapterVisible for readerChapterVisible):
// ALIASES adds those names for that file, and an alias the file no longer has fails, so the map cannot go stale quietly.
const ALIASES = { "content.js": { readingChapterVisible: "readerChapterVisible" } };
{
  const keys = Object.keys(S.DEFAULTS).filter((k) => typeof S.DEFAULTS[k] === "boolean");
  const patternsFor = (names) => {
    const alt = names.join("|");
    return [
      new RegExp(`\\b(${alt})\\b(?:\\.newValue)?\\s*(?:[!=]==?)\\s*(?:true|false|undefined)\\b`), // x.k !== false, === true, changes.k.newValue === true
      new RegExp(`\\b(${alt})\\b(?:\\.newValue)?\\s*(?:\\?\\?|\\|\\|)\\s*(?:true|false)\\b`), // x.k ?? true, || false
      new RegExp(`Boolean\\(\\s*[\\w$.?\\[\\]"']*\\b(${alt})\\b(?:\\.newValue)?\\s*\\)`), // Boolean(settings.k)
      new RegExp(`!!\\s*[\\w$.?]*\\b(${alt})\\b`), // !!settings.k
      new RegExp(`(?:^|\\{\\s*|,\\s*(?<!\\.\\.\\.[\\w$.]+,\\s*))(${alt})\\s*:\\s*(?:true|false)\\b`) // { k: true }: the default written again (not an override after ...spread)
    ];
  };
  const hits = [];
  for (const [f, map] of Object.entries(ALIASES)) {
    for (const [alias, key] of Object.entries(map)) {
      if (!keys.includes(key)) hits.push(`ALIASES: ${key} is not a switch in DEFAULTS`);
      if (!new RegExp(`\\b${alias}\\b`).test(read(f))) hits.push(`ALIASES: ${f} no longer has ${alias}; drop it from the map`);
    }
  }
  for (const f of files.filter((f) => f !== "settings.js")) {
    const patterns = patternsFor([...keys, ...Object.keys(ALIASES[f] || {})]);
    lines[f].forEach((line, i) => {
      if (!isComment(line) && patterns.some((re) => re.test(line))) hits.push(at(f, i));
    });
  }
  section(`1. 开关自己取值（${keys.length} 个开关，settings.js 以外）`, hits, "any");
}

// 2. Storage key names outside limits.js.
{
  const values = Object.values(L.KEYS).filter((v) => typeof v === "string");
  const prefixes = values.filter((v) => v.endsWith("_"));
  const badgesCopies = JSON.parse(
    /const badgesCopies = (\[[^\]]*\])/.exec(read("limits.selftest.js"))[1].replace(/'/g, '"')
  );
  // A quoted literal's leading word, up to its closing quote or a ${.
  const literals = (text) => [...text.matchAll(/(["'`])([A-Za-z0-9_]+)(?=\1|\$\{)/g)].map((m) => m[2]);
  const inKeys = (s) => values.includes(s) || prefixes.some((p) => s.startsWith(p));
  const hits = [];
  const copies = [];
  for (const f of files.filter((f) => f !== "limits.js")) {
    lines[f].forEach((line, i) => {
      if (isComment(line)) return;
      for (const s of literals(line)) {
        if (!inKeys(s)) continue;
        (f === "badges.js" && badgesCopies.some((c) => s === c || (c.endsWith("_") && s.startsWith(c))) ? copies : hits).push(at(f, i));
      }
    });
  }
  section("2a. KEYS 里的键名在 limits.js 以外又写成字符串", hits, "any");
  section("2a'. 允许的拷贝（badges.js，limits.selftest 的 badgesCopies 核对）", copies);

  // 2b looks only where a string is a storage key: the arguments of chrome.storage.*.get / set / remove and startsWith.
  const closeOf = (t, i) => {
    let depth = 0;
    for (let j = i; j < t.length; j++) {
      const c = t[j];
      if (c === '"' || c === "'" || c === "`") {
        for (j++; j < t.length && t[j] !== c; j++) if (t[j] === "\\") j++;
      } else if ("{([".includes(c)) depth++;
      else if ("})]".includes(c) && --depth === 0) return j;
    }
    return t.length;
  };
  const loose = new Map(); // a storage key not in KEYS → { files, at }
  for (const f of files.filter((f) => f !== "limits.js" && f.endsWith(".js"))) {
    const text = lines[f].map((l) => (isComment(l) ? "" : l)).join("\n");
    for (const m of text.matchAll(/chrome\.storage\.(?:local|sync|session)\.(?:get|set|remove)\(|\.startsWith\(/g)) {
      const open = m.index + m[0].length - 1;
      const args = text.slice(open, closeOf(text, open) + 1);
      const i = text.slice(0, m.index).split("\n").length - 1;
      for (const s of literals(args)) {
        if (inKeys(s) || !/^(triage|follow|seen|mdg|ai)_[A-Za-z0-9_]*$/.test(s)) continue;
        const e = loose.get(s) || { files: new Set(), at: [] };
        e.files.add(f);
        e.at.push(at(f, i));
        loose.set(s, e);
      }
    }
  }
  const shared = [...loose].filter(([s, e]) => e.files.size > 1 && !s.startsWith("follow_"));
  section(
    "2b. 不在 KEYS、却有不止一个文件读写的存储键",
    shared.flatMap(([s, e]) => [`「${s}」 ${[...e.files].join(", ")}`, ...e.at.map((x) => `    ${x}`)]),
    "any"
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
  // An HTML control that starts off and whose id a page hands to setReason (setReason(els.<id>, …)) says why once the
  // page runs: the id is the contract between the two files.
  const reasonIds = new Set(
    files.filter((f) => f.endsWith(".js")).flatMap((f) => [...read(f).matchAll(/setReason\(\s*[\w$]+\.([\w$]+)\s*,/g)].map((m) => m[1]))
  );
  const raw = [];
  const bare = [];
  const handRolled = [];
  const titleOnly = [];
  for (const f of files) {
    lines[f].forEach((line, i) => {
      if (isComment(line) || inHelper(f, i)) return;
      // A property write that turns it off: = true, = Boolean(x), = !x, = busy … (= false only turns it back on).
      if (/\.disabled\s*=(?!=)(?!\s*false\b)/.test(line) || /(?:setAttribute|toggleAttribute)\(\s*["']disabled["']/.test(line)) {
        raw.push(hitAt(f, i));
      }
      // A disabled attribute in markup or a template string (not .disabled, :disabled, [disabled] or a word in prose).
      if (/(?:^|[\s`])disabled(?=[\s"'`>/=]|$)/.test(line) && !/[.:[]disabled\b/.test(line.replace(/\.disabled\s*=.*/, ""))) {
        if (/reasonAttrs\(|actBtn\(/.test(line)) return;
        // <option>: its text is the reason. aria-busy: in flight, the control says what it is doing.
        if (/<option\b/.test(line) || /aria-busy="true"/.test(line)) return;
        const id = f.endsWith(".html") && /\bid="([\w-]+)"/.exec(line)?.[1];
        if (id && reasonIds.has(id)) return;
        const hasTitle = /title=/.test(line);
        const hasDesc = /aria-description=/.test(line);
        (hasTitle && hasDesc ? handRolled : hasTitle ? titleOnly : bare).push(hitAt(f, i));
      }
    });
  }
  section("3a. 直接写 .disabled（不经 setReason）", raw, "allow");
  section("3b. 模板 / HTML 里的 disabled 没写 title", bare, "allow");
  section("3c. 手写 title + aria-description（该用 reasonAttrs / setReason）", handRolled, "any");
  section("3d. 只写了 title、没写 aria-description", titleOnly, "any");
}

let failed = 0;
console.log(`conventions selftest, scanned ${files.length} files`);
for (const { title, hits, fail } of report) {
  const n = title.startsWith("2b''") ? (hits[0] ? hits[0].split("  ").length : 0) : hits.filter((h) => !String(h.text ?? h).startsWith("    ")).length;
  const bad = fail === "any" ? hits.filter((h) => !String(h.text ?? h).startsWith("    ")) : fail === "allow" ? hits.filter((h) => !allowed(h)) : [];
  failed += bad.length;
  if (!n) continue;
  console.log(`== ${title}: ${n}${fail ? `（${bad.length} 条不通过）` : ""}`);
  // Listed-only sections and allowed hits are counted, not printed: a green run stays short.
  for (const h of fail === "any" ? hits : bad) console.log(`  ✗ ${h.text ?? h}`);
}
const stale = ALLOW.filter((_, i) => used[i] !== 1);
for (const [f, snippet] of stale) console.log(`✗ ALLOW 里这一行没有正好对应一处命中（理由过期或有了新的同样写法）：${f}  ${snippet}`);
failed += stale.length;
if (failed) {
  console.error(`\nconventions selftest: ${failed} problem(s)`);
  process.exit(1);
}
console.log("conventions selftest ok");
