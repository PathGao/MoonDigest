// /usr/local/bin/node extension/conventions.selftest.js
// Conventions the audits kept finding broken, as checks over the shipped source (AGENTS「用检查代替反复扫描」).
// It matches public contracts: setting keys (MdgSettings.DEFAULTS), storage key names (MdgLimits.KEYS), the disabled
// attribute and the reason helpers' names, a reply's error field, and the serial writers (MdgLimits.saveVideoNote,
// follow-bg.js's followUpdate).
//   1. Switches (DEFAULTS' booleans) take their value only through MdgSettings.normalizeSwitches / DEFAULTS.
//   2. Storage key names are written once, in MdgLimits.KEYS (ARCHITECTURE: 存储键名只写一份).
//   3. A disabled control says why (DESIGN: 按钮灰掉要写原因), through MdgErrors.setReason / TriageUi.reasonAttrs / actBtn.
//   4. A reply's words reach the page through MdgErrors.text / fromResp (a. no `x.error || "兜底"` of its own), and a
//      thrown Error has Chinese words (b. no English-only Error that e.message would show).
//   5. A shared record is read-modified-written through its module's serial writer: 视频备注 only through
//      MdgLimits.saveVideoNote (a), follow-bg.js's follow_* keys only through followUpdate (b), the pages' tags only
//      through MdgTagStore (c).
//   6. Page paths and the file-name rule are MdgCommon's (ARCHITECTURE: common.js).
//   7. Tab matching, conversation picking and Chrome's messaging errors are answered once (MdgSites, MdgErrors).
// Fails on any hit of 1, 2a, 2b, 3c, 3d, 5c, 6 and 7. 3a, 3b, 4 and 5 fail on a hit that is not in ALLOW below, and on an ALLOW
// line that matches no hit (its reason no longer holds). Sections marked (允许) only list.
// Scanned: extension/**/*.js and *.html. Not scanned: *.selftest.js, vendor/ (third-party code), every dev/ folder and dev-sidepanel/ (mocks, the
// build script and its generated index.html), *.mjs, messages.js (the message list, messages.selftest.js), and per check
// the file that owns the convention (settings.js, limits.js, errors.js, the helpers' own bodies).
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = __dirname;
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const files = require("./page-sources.selftest.js").walk(".", (d) => /^(dev|vendor$)/.test(d)).filter((f) => /\.(js|html)$/.test(f) && !f.endsWith(".selftest.js") && f !== "messages.js");
const lines = Object.fromEntries(files.map((f) => [f, read(f).split("\n")]));
const isComment = (line) => /^\s*(\/\/|\*|\/\*|<!--)/.test(line);
const at = (f, i) => `${f}:${i + 1}  ${lines[f][i].trim().slice(0, 160)}`;
const hitAt = (f, i, tag = "") => ({ f, i, text: at(f, i) + tag });
// The index of the bracket that closes the one at i (strings skipped). Set in 2b, used by 4 and 5.
let closeOf;

const load = (file, name) => {
  const ctx = vm.createContext({ console });
  ctx.globalThis = ctx;
  vm.runInContext(read(file), ctx);
  return ctx[name];
};
const S = load("settings.js", "MdgSettings");
const L = load("limits.js", "MdgLimits");

// 3a, 3b, 4, 5: a hit that stays, and why: file + a snippet of its line + the reason (例外, or 待修 with the scan's id).
const ALLOW = [
  // The control itself says why: its only option is the reason.
  ["content.js", "select.disabled = true;", "专注模式的字幕下拉框：唯一一项就是 noTrackText() 的原因（写在同一行）"],
  ["popup.js", "el.subtitleSelect.disabled = true;", "弹窗字幕下拉框：唯一一项就是 subtitleMissing 的原因"],
  ["sidepanel.js", "els.modelSelect.disabled = true;", "侧边栏平台下拉框：唯一一项就是 TEXT.aiNone"],
  ["sidepanel.js", "els.contextChip.disabled = true;", "上下文胶囊读取失败：胶囊上写着「读取失败」"],
  ["sidepanel.js", "els.contextChip.disabled = !String(context.url", "上下文胶囊只是跳到视频地址：没有地址时胶囊上写着「正在加载…」或「未知视频」"],
  ["triage/fav-export.js", "o.disabled = !c;", "<option>：选项文字写着「· 0 个」"],
  // In flight: the control shows it is busy (busy words / aria-busy) and turns back on when the request ends.
  ["options.js", "button.disabled = Boolean(active);", "保存和测试连接互等：在跑的那个写「保存中…」「测试中…」并 aria-busy"],
  ["options.js", "testBtn.disabled = true;", "AI 平台测试中：同一行写「正在测试…」并 aria-busy，完了 setReason 接手"],
  ["popup.js", "button.disabled = busy;", "弹窗按钮在跑：按钮文字换成在做什么，aria-busy"],
  ["triage/fav-base.js", "btn.disabled = Boolean(text);", "分拣台按钮在跑：按钮文字换成在做什么，aria-busy"],
  ["triage/follow.js", "btn.disabled = Boolean(j.running);", "关注刷新在跑：aria-busy，进度胶囊写进度"],
  ["triage/follow.js", "btn.disabled = true;", "点了刷新（第 2 行、空状态或提示里的）、后台还没回：回来后 renderSync 接手（aria-busy）或失败时打开"],
  ["triage/fav-export.js", "el.writeScope.disabled = el.writeFormat.disabled = el.writeOverwrite.disabled = busy;", "逐个视频笔记在跑：进度胶囊和「停止」写着在跑什么，范围和格式跑完才能改"],
  ["content.js", "button.disabled = true;", "播放器 ✦ 点下到侧边栏打开之间防连点，finally 打开"],
  // 4a. 待修 lines wait for their fix (Cn / An: the 2026-10-16 scan); new ones fail.
  // 4b
  ["content.js", "new Error(`Missing node: ${id}`)", "例外：页面少了 id 是代码错，不是用户能遇到的（冒烟核对页面脚本查找的 id）"],
  ["common.js", 'new Error("Superseded run")', "例外：作废信号，带 code STALE_RUN，MdgCommon.isStale 认出后丢掉，不显示"],
  ["content.js", 'new Error("Unknown retry error")', "例外：到不了，retryAsync 的循环每条路都 return 或 throw"],
  ["obsidian.js", "new Error(`cover HTTP ${image.status}`)", "例外：同一函数 catch 住，只 console.warn，笔记保留远程封面地址"],
  ["sidepanel-state.js", "new Error(`unknown event ${event.type}`)", "例外：未知事件类型是代码错，不是用户能遇到的"],
  ["sites.js", 'new Error("no wbi_img")', "例外：biliWbiQuery 吞掉它，follow-bg.js 的 followWbiData 换成「拿不到 WBI 签名密钥」"],
  // 5a
  ["triage/triage-bg.js", "[triageNotes]: notes, triage_notes_migrated: true", "例外：一次性迁移（triage_notes_migrated），扩展更新时跑一次，只补还没有的条目"],
  // 5b
  ["triage/follow-bg.js", "chrome.storage.local.set(MdgLimits.followFull({ hold }))", "例外：只写不读，follow_hold 只由 followHold 整个换掉，不依赖读到的旧值"]
];
// Each line covers exactly one hit: a second line like it is a new case and needs its own reason.
const used = ALLOW.map(() => 0);
const allowed = (hit) => {
  const fits = ([f, snippet]) => hit.f === f && lines[f][hit.i].includes(snippet);
  // Two hits with the same line take two ALLOW lines: each takes the first one not used yet.
  let i = ALLOW.findIndex((a, j) => fits(a) && !used[j]);
  if (i < 0) i = ALLOW.findIndex(fits);
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
      new RegExp(`(?:^|\\{\\s*|,\\s*(?<!\\.\\.\\.[\\w$.]+,[^{}]*))(${alt})\\s*:\\s*(?:true|false)\\b`) // { k: true }: the default written again (not an override after ...spread, first or later)
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
  // A quoted literal's leading word, up to its closing quote or a ${.
  const literals = (text) => [...text.matchAll(/(["'`])([A-Za-z0-9_]+)(?=\1|\$\{)/g)].map((m) => m[2]);
  const inKeys = (s) => values.includes(s) || prefixes.some((p) => s.startsWith(p));
  const hits = [];
  for (const f of files.filter((f) => f !== "limits.js")) {
    lines[f].forEach((line, i) => {
      if (isComment(line)) return;
      for (const s of literals(line)) {
        if (inKeys(s)) hits.push(at(f, i));
      }
    });
  }
  section("2a. KEYS 里的键名在 limits.js 以外又写成字符串", hits, "any");

  // 2b looks only where a string is a storage key: the arguments of chrome.storage.*.get / set / remove and startsWith.
  closeOf = (t, i) => {
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
  const shared = [...loose].filter(([, e]) => e.files.size > 1);
  section(
    "2b. 不在 KEYS、却有不止一个文件读写的存储键",
    shared.flatMap(([s, e]) => [`「${s}」 ${[...e.files].join(", ")}`, ...e.at.map((x) => `    ${x}`)]),
    "any"
  );
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

// 4. A background reply's words on a page: through MdgErrors.text / fromResp (ARCHITECTURE: 页面怎么显示一个错误只写一份),
// which turn a code into the user's words (NOT_LOGGED_IN, THROTTLED, 62004) before the reply's own error.
{
  const CJK = /[一-鿿]/;
  const shownFallback = /\.error\s*(?:\|\||\?\?)\s*(?:(["'`])(?:(?!\1).)*[一-鿿]|(?:MdgErrors\.)?TEXT\.\w|[A-Z][A-Z0-9_]{2,}\b)/;
  const raw = [];
  const english = [];
  for (const f of files.filter((f) => f.endsWith(".js") && f !== "errors.js")) {
    const text = lines[f].map((l) => (isComment(l) ? "" : l)).join("\n");
    lines[f].forEach((line, i) => {
      if (!isComment(line) && shownFallback.test(line)) raw.push(hitAt(f, i));
    });
    // 4b. Words in a thrown Error that has no 汉字: Chrome's or a library's English reaches the page through e.message.
    for (const m of text.matchAll(/new Error\(/g)) {
      const open = m.index + m[0].length - 1;
      const args = text.slice(open, closeOf(text, open) + 1);
      const words = [...args.matchAll(/(["'`])((?:(?!\1)[^\\]|\\.)*)\1/g)].map((x) => x[2]);
      if (words.some((w) => /[A-Za-z]{2}/.test(w) && !CJK.test(w))) english.push(hitAt(f, text.slice(0, m.index).split("\n").length - 1));
    }
  }
  section("4a. 回复的 error 自己兜底显示（该用 MdgErrors.text(resp, 兜底)）", raw, "allow");
  section("4b. 抛出的 Error 只有英文（会经 e.message 显示给用户）", english, "allow");
}

// 5. Read-modify-writes of a shared record go through the module's one serial writer, or a write made in between is lost.
{
  // 5a. 视频备注 (MdgLimits.KEYS.triageNotes) is written only by MdgLimits.saveVideoNote (ARCHITECTURE). A file's names for
  // the key: X = …KEYS.triageNotes, { triageNotes: X } or { triageNotes } from KEYS, and obj.p where p: …KEYS.triageNotes.
  const hits = [];
  for (const f of files.filter((f) => f.endsWith(".js") && f !== "limits.js")) {
    const text = lines[f].map((l) => (isComment(l) ? "" : l)).join("\n");
    const names = ["(?:MdgLimits\\.)?KEYS\\.triageNotes"];
    for (const m of text.matchAll(/(?:const|let|var)\s+([\w$]+)\s*=\s*(?:MdgLimits\.)?KEYS\.triageNotes\b/g)) names.push(`\\b${m[1]}`);
    for (const m of text.matchAll(/\{([^{}]*)\}\s*=\s*(?:MdgLimits\.)?KEYS\b/g)) {
      const own = /\btriageNotes\b(?:\s*:\s*([\w$]+))?/.exec(m[1]);
      if (own) names.push(`\\b${own[1] || "triageNotes"}`);
    }
    for (const m of text.matchAll(/([\w$]+)\s*:\s*(?:MdgLimits\.)?KEYS\.triageNotes\b/g)) names.push(`[\\w$]+\\.${m[1]}`);
    const write = new RegExp(`\\[\\s*(?:${names.join("|")})\\s*\\]\\s*:`);
    lines[f].forEach((line, i) => {
      if (!isComment(line) && write.test(line)) hits.push(hitAt(f, i));
    });
  }
  section("5a. 整份写视频备注（该用 MdgLimits.saveVideoNote）", hits, "allow");

  // 5b. follow-bg.js writes its follow_* keys through followUpdate (MdgLimits.updateFollow, under the Web Lock the
  // 分拣台 takes too; ARCHITECTURE). A write names them through MdgLimits (KEYS.follow, followFull, followPrefix); a
  // follow_ literal is 2a's.
  const f = "triage/follow-bg.js";
  const text = lines[f].join("\n");
  const def = text.indexOf("const followUpdate = (names, fn) => MdgLimits.updateFollow(");
  if (def < 0) throw new Error(`${f} has no followUpdate: update check 5b`);
  const body = [def, text.indexOf("\n", def)];
  const raw = [];
  for (const m of text.matchAll(/chrome\.storage\.local\.(?:set|remove)\(/g)) {
    const open = m.index + m[0].length - 1;
    if ((m.index > body[0] && m.index < body[1]) || !/\bfollowFull\(|KEYS\.follow(Prefix\b|\()|follow_/.test(text.slice(open, closeOf(text, open)))) continue;
    raw.push(hitAt(f, text.slice(0, m.index).split("\n").length - 1));
  }
  section("5b. follow-bg.js 不经 followUpdate 写 follow_* 键", raw, "allow");

  // 5c. The pages' tags go through MdgTagStore (triage/tag-store.js, the one allowed module: its backends are the only
  // page code that writes a tag key, and its steps the only tag U steps). A page file (triage/ and history/ but the
  // worker's *-bg.js) may not write the tag list or the item → tags map: KEYS.triageTags / triageVideoTags under any
  // name, KEYS.readingMarks (MdgLimits.updateReadingMarks), follow_tags / follow_tag_map (MdgLimits.updateFollow names,
  // followFull keys; updateFollow's names must be a list of literals); nor cap an undo stack of its own (MdgLimits.TRIAGE_UNDO_STEPS).
  const tagHits = [];
  const pageFiles = files.filter((f) => /^(triage|history)\/[^/]+\.js$/.test(f) && f !== "triage/tag-store.js" && !f.endsWith("-bg.js"));
  const textOf = (f) => lines[f].map((l) => (isComment(l) ? "" : l)).join("\n");
  // The key's names, from every page file: 收藏夹's fav-*.js share one global scope (K.tags is fav-base.js's).
  const all = pageFiles.map(textOf).join("\n");
  const names = ["(?:MdgLimits\\.)?KEYS\\.(?:triageTags|triageVideoTags|readingMarks)"];
  for (const m of all.matchAll(/(?:const|let|var)\s+([\w$]+)\s*=\s*(?:MdgLimits\.)?KEYS\.(?:triageTags|triageVideoTags|readingMarks)\b/g)) names.push(`\\b${m[1]}`);
  for (const m of all.matchAll(/\{([^{}]*)\}\s*=\s*(?:MdgLimits\.)?KEYS\b/g)) {
    for (const own of m[1].matchAll(/\b(triageTags|triageVideoTags|readingMarks)\b(?:\s*:\s*([\w$]+))?/g)) names.push(`\\b${own[2] || own[1]}`);
  }
  // A field of a key table (const K = { tags: KEYS.triageTags }) as K.tags.
  for (const m of all.matchAll(/([\w$]+)\s*:\s*(?:MdgLimits\.)?KEYS\.(?:triageTags|triageVideoTags|readingMarks)\b/g)) {
    const table = [...all.slice(0, m.index).matchAll(/(?:const|let|var)\s+([\w$]+)\s*=\s*\{/g)].at(-1);
    if (table) names.push(`\\b${table[1]}\\.${m[1]}\\b`);
  }
  for (const f of pageFiles) {
    const key = `(?:${names.join("|")})`;
    // An object key ({ [K.tags]: … }) or a key-and-value call (storeSet(K.tags, …); a get's fallback is a read).
    const write = new RegExp(`\\[\\s*${key}\\s*\\]\\s*:|(?<![gG]et)\\(\\s*${key}\\s*,`);
    lines[f].forEach((line, i) => {
      if (isComment(line)) return;
      if (write.test(line)) tagHits.push(hitAt(f, i, "  （标签键）"));
      if (/\bupdateReadingMarks\(/.test(line)) tagHits.push(hitAt(f, i, "  （摘读记录的标签和星标）"));
      // updateFollow's names as a list of literals, so this can read them.
      const follow = /\bupdateFollow\(\s*(\[[^\]]*\])?/.exec(line);
      if ((follow && !/^\[\s*(["'][\w]+["']\s*,?\s*)*\]$/.test(follow[1] || "")) || /\bupdateFollow\(\s*\[[^\]]*["'](?:tags|tag_map)["']/.test(line) || /followFull\(\{[^}]*\b(?:tags|tag_map)\s*:/.test(line)) tagHits.push(hitAt(f, i, "  （follow_tags / follow_tag_map）"));
      if (/\bTRIAGE_UNDO_STEPS\b/.test(line)) tagHits.push(hitAt(f, i, "  （自己的撤销栈）"));
    });
  }
  section("5c. 页面不经 MdgTagStore 写标签键或自建撤销栈", tagHits, "any");
}

// 6. What common.js holds is not written again: an extension page's path for getURL (MdgCommon.PAGES; a page's own
// <a href> is relative to it) and the file-name rule (MdgCommon.fileName: a replace of Obsidian's characters by _).
{
  const hits = [];
  for (const f of files.filter((f) => f.endsWith(".js") && f !== "common.js")) {
    lines[f].forEach((line, i) => {
      if (isComment(line)) return;
      if (/["'`](triage\/triage|history\/history)\.html["'`]/.test(line)) hits.push(at(f, i) + "  （MdgCommon.PAGES）");
      if (/\.replace\(\/\[[^\]]*:\*\?"<>\|[^/]*\/g,\s*"_"\)/.test(line)) hits.push(at(f, i) + "  （MdgCommon.fileName）");
    });
  }
  section("6. common.js 里有的又写一份", hits, "any");
}

// 7. A rule two or more entries answer lives once (AGENTS 抽象), and no entry keeps a private copy of it:
//   a. whether a tab shows a record (a part number, a watch-later oid or a URL without # compared): MdgSites.sameContext;
//   b. which saved conversation belongs to a video part or page (a filter on contextKey): MdgSites.isConversationOf;
//   c. Chrome's English messaging errors ("Receiving end does not exist", …): MdgErrors.noReceiver / pageSilent.
{
  const hits = [];
  const compares = (line, part) => new RegExp(`[!=]==[^;]*${part}|${part}[^;]*[!=]==`).test(line);
  for (const f of files.filter((f) => f.endsWith(".js"))) {
    lines[f].forEach((line, i) => {
      if (isComment(line)) return;
      if (f !== "sites.js" && (compares(line, "\\.part\\??\\.(?:index|oid)\\b") || compares(line, "replace\\(\\/#\\.\\*\\$\\/"))) hits.push(at(f, i) + "  （MdgSites.sameContext）");
      if (f !== "sites.js" && /\.(?:filter|find|findIndex|some|every)\(.*\bcontextKey\b/.test(line)) hits.push(at(f, i) + "  （MdgSites.isConversationOf）");
      if (f !== "errors.js" && /Receiving end|establish connection|message port closed|No tab with id|No frame with id/i.test(line)) hits.push(at(f, i) + "  （MdgErrors.noReceiver / pageSilent）");
    });
  }
  section("7. 判断标签页、对话归属、页面没回应又写一份", hits, "any");
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
