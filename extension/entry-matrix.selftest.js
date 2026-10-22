// /usr/local/bin/node extension/entry-matrix.selftest.js
// The same error gets the same remedy on every entry (DESIGN: 同一种情况每个入口一样). The rule is data in one place,
// MdgErrors.remedies (errors.js CODES); the entries render what it says. This checks:
//   1. the table against DESIGN's rules (RULES below);
//   2. the entry list: every page or content script that loads errors.js is an entry here or exempt with a reason;
//   3. the entries decide nothing of their own: (a) the settings page opens only from a click (去设置 / ⚙), never on an
//      error path; (b) no remedy branch on a code of their own ("AI_…", CODE.THROTTLED…); (c) isBiliVideoGone only
//      picks a sentence (retry is remedies'); (d) 去设置 / 授权 stand next to remedies / action / grantOrigin;
//   4. a note's 复制 / 下载 / 写入 Obsidian go through MdgNoteActions: only NOTE_FLOW's files name its messages or dialogs.
// 3b and 3c fail on a hit not in ALLOW, and on an ALLOW line that matches no hit (its reason no longer holds).
// Per entry, the page's own selftest drives its renderer with each code (sidepanel appendStreamError, 分拣台
// handleAiError, 摘读记录 aiRemedy, 专注模式 readingRetryShown).
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const root = __dirname;
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const ctx = vm.createContext({});
ctx.globalThis = ctx;
vm.runInContext(read("errors.js"), ctx);
const E = ctx.MdgErrors;

// 1. DESIGN's rules, written out: code or situation → remedies (button order), and the sentence where the table sets one.
// 「去设置」 for the AI errors that fail every request and for Obsidian not set up; 授权 for a missing origin; a closed
// Obsidian only red text (its write button is the retry); B站限流 「B站限流，请稍后再试」 with 重试; a gone video nothing.
const AI_SETTINGS = ["settings", "retry"];
const RULES = {
  AI_AUTH: AI_SETTINGS,
  AI_QUOTA: AI_SETTINGS,
  AI_SETUP: AI_SETTINGS, // also 没有启用的 AI 平台
  AI_NETWORK: AI_SETTINGS,
  AI_TIMEOUT: AI_SETTINGS,
  AI_GAVE_UP: AI_SETTINGS,
  AI_ACCESS: ["grant", "retry"],
  AI_THROTTLED: ["retry"], // a run waits instead
  AI_STALLED: ["retry"], // 重试 only: the platform did answer
  AI_TRUNCATED: ["retry"], // 分拣台 adds 打开收藏夹设置
  OBSIDIAN: ["settings", "retry"],
  OBSIDIAN_DOWN: ["retry"],
  NOTE_EMPTY: [], // 没有可复制 / 下载 / 写入 Obsidian 的内容: a second try finds nothing either
  THROTTLED: ["retry"],
  NOT_LOGGED_IN: ["login", "retry"],
  [-101]: ["login", "retry"],
  62004: ["retry"],
  [-404]: [],
  62002: [],
  62012: [],
  PAGE_FAILED: ["retry"],
  PAGE_GRANT: ["grantPage"],
  PAGE_UNSUPPORTED: [],
  SUBTITLE_FAILED: ["retry"],
  SUBTITLE_LOGIN: ["retry"],
  SUBTITLE_NONE: []
};
const failures = [];
const check = (ok, msg) => ok || failures.push(msg);
for (const [code, want] of Object.entries(RULES)) {
  const key = /^-?\d+$/.test(code) ? Number(code) : code;
  check(JSON.stringify(E.remedies(key)) === JSON.stringify(want), `1. remedies(${code}) = ${JSON.stringify(E.remedies(key))}, DESIGN says ${JSON.stringify(want)}`);
}
// Every named code of the table has a rule here (a new one states what it offers).
for (const code of Object.keys(E.CODE)) check(code in RULES, `1. MdgErrors.CODE.${code} has no rule in RULES`);
check(E.text({ code: "THROTTLED", error: "HTTP 412" }) === "B站限流，请稍后再试", "1. THROTTLED's sentence");
check(E.text({ code: "NOT_LOGGED_IN", error: "x" }) === E.TEXT.biliLogin, "1. NOT_LOGGED_IN's sentence");
// The gone codes are MdgSites.isBiliVideoGone's, both ways.
const gone = /BILI_GONE_CODES = new Set\(\[([^\]]*)\]\)/.exec(read("sites.js"))[1].split(",").map(Number);
check(JSON.stringify(gone.filter((c) => E.remedies(c).length)) === "[]", "1. a gone video gets no remedy");
check(JSON.stringify(Object.keys(RULES).map(Number).filter((c) => Number.isInteger(c) && !E.remedies(c).length).sort()) === JSON.stringify([...gone].sort()), `1. the table's no-remedy B站 codes are sites.js's gone codes (${gone})`);
// 授权 only for the code whose remedy is grant: words an AI platform returns choose no origin.
check(!E.grantOrigin("未授权访问 https://evil.example，授权后重试", "AI_AUTH") && !E.grantOrigin("未授权访问 https://evil.example，授权后重试"), "1. grantOrigin without AI_ACCESS");
check(E.grantOrigin(E.noAccess("https://a.test"), "AI_ACCESS")?.origin === "https://a.test", "1. grantOrigin with AI_ACCESS");
check(["failed", "needPermission", "unsupported", "ready"].map(E.pageCode).join() === "PAGE_FAILED,PAGE_GRANT,PAGE_UNSUPPORTED,", "1. pageCode");
check([{ subtitleFailure: "超时" }, { subtitleNeedLogin: true, subtitleFailure: "x" }, {}].map(E.subtitleCode).join() === "SUBTITLE_FAILED,SUBTITLE_LOGIN,SUBTITLE_NONE", "1. subtitleCode");

// 2. The entries, and the pages and content scripts that load them. A new page that loads errors.js joins here or is
// exempt with its reason.
const ENTRIES = {
  "content.js": "视频页、专注模式",
  "popup.js": "弹窗",
  "sidepanel.js": "侧边栏",
  "history/history.js": "摘读记录",
  "triage/fav-ai.js": "分拣台 收藏夹",
  "triage/fav-base.js": "分拣台 收藏夹",
  "triage/fav-export.js": "分拣台 收藏夹",
  "triage/fav-folders.js": "分拣台 收藏夹",
  "triage/fav-page.js": "分拣台 收藏夹",
  "triage/fav-render.js": "分拣台 收藏夹",
  "triage/fav-tags.js": "分拣台 收藏夹",
  "triage/fav-writes.js": "分拣台 收藏夹",
  "triage/follow.js": "关注",
  "triage/tag-store.js": "分拣台和摘读记录的 AI 打标签"
};
const PAGES = {
  "popup.html": ["popup.js"],
  "sidepanel.html": ["sidepanel.js"],
  "history/history.html": ["history/history.js", "triage/tag-store.js"],
  "triage/triage.html": Object.keys(ENTRIES).filter((f) => f.startsWith("triage/")),
  "manifest:content.js": ["content.js"]
};
const EXEMPT = {
  "options.html": "设置页：错误就写在要改的那一项旁边，没有「去设置」；测试连接的「授权」也经 grantOrigin 按 code 给",
  "dev-sidepanel/index.html": "开发用的 mock 页，加载的就是 sidepanel.js",
  "manifest:badges.js": "B站页面封面上的标记：不显示这些错误，也没有补救按钮"
};
const htmls = [];
(function walk(dir) {
  for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) e.name !== "vendor" && walk(rel);
    else if (e.name.endsWith(".html")) htmls.push(rel);
  }
})(".");
const loads = {};
for (const html of htmls) {
  const srcs = [...read(html).matchAll(/<script[^>]*\bsrc="([^"]+)"/g)].map((m) => path.normalize(path.join(path.dirname(html), m[1])));
  if (srcs.includes("errors.js")) loads[html] = srcs;
}
for (const group of JSON.parse(read("manifest.json")).content_scripts) {
  if (group.js.includes("errors.js")) loads[`manifest:${group.js.at(-1)}`] = group.js;
}
for (const [where, srcs] of Object.entries(loads)) {
  if (EXEMPT[where]) continue;
  if (!PAGES[where]) check(false, `2. ${where} loads errors.js: list its entry scripts in PAGES (and ENTRIES), or EXEMPT it with a reason`);
  else for (const f of PAGES[where]) check(srcs.includes(f), `2. ${where} no longer loads ${f}`);
}
for (const where of [...Object.keys(PAGES), ...Object.keys(EXEMPT)]) check(where in loads, `2. ${where} is listed but loads no errors.js`);
for (const f of Object.keys(ENTRIES)) check(Object.values(PAGES).flat().includes(f), `2. ${f} is in no page of PAGES`);

// 2b. Every script that reads an error's words or code, names a remedy or opens the settings page is an entry above or
// listed here with why it is not one (the PR lists the graphify inventory this came from).
const NOT_ENTRIES = {
  "errors.js": "the table itself",
  "background.js": "classifies (streamChat AI_STALLED, aiProviderProblem) and answers open-options; shows no error",
  "obsidian.js": "classifies Obsidian errors (OBSIDIAN / OBSIDIAN_DOWN); shows none",
  "sites.js": "classifies B站 / YouTube reads (THROTTLED, the gone codes); shows none",
  "triage/triage-bg.js": "classifies AI and B站 errors for 分拣台 and 关注; shows none",
  "triage/runs.js": "the run judge: waits on AI_THROTTLED, stops on aiEnds (MdgErrors.action); shows none",
  "note.js": "writes subtitleMissing into a note (text, no remedy)",
  "messages.js": "the message list",
  "note-actions.js": "the shared 复制 / 下载 / 写入 Obsidian flow (MdgNoteActions): returns the words and remedies; the entries show them",
  "options.js": "设置页 (EXEMPT above): 测试连接's 授权 goes through grantOrigin(message, code)"
};
const INVENTORY = /MdgErrors\.(action|text|fromResp|grantOrigin|subtitleMissing|remedies|messageOf)\(|["'](AI_[A-Z_]+|OBSIDIAN(?:_DOWN)?|THROTTLED|NOT_LOGGED_IN)["']|\bCODE\.[A-Z_]+|openOptionsPage|"open-options"|LABEL\.retry|isBiliVideoGone|aiSettingsCode|aiEnds/;
(function walk(dir) {
  for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) !/^(dev|vendor$)/.test(e.name) && walk(rel);
    else if (rel.endsWith(".js") && !rel.endsWith(".selftest.js") && !(rel in ENTRIES) && !(rel in NOT_ENTRIES)) {
      const hit = read(rel).split("\n").find((l) => !/^\s*\/\//.test(l) && INVENTORY.test(l));
      check(!hit, `2b. ${rel} handles errors (${hit?.trim().slice(0, 80)}): add it to ENTRIES or NOT_ENTRIES with a reason`);
    }
  }
})(".");
for (const f of Object.keys(NOT_ENTRIES)) check(fs.existsSync(path.join(root, f)), `2b. NOT_ENTRIES lists ${f}, which is gone`);

// 3. Static checks over the entries.
const lines = Object.fromEntries(Object.keys(ENTRIES).map((f) => [f, read(f).split("\n")]));
const isComment = (line) => /^\s*(\/\/|\*|\/\*)/.test(line);
const at = (f, i) => `${f}:${i + 1}  ${lines[f][i].trim().slice(0, 160)}`;

// 3b, 3c: a hit that stays, and why: file + a snippet of its line + the reason.
const ALLOW = [
  // 3b: codes a run waits or stops on (runs.js's judge), not a remedy.
  ["history/history.js", 'r.code === "AI_THROTTLED" ? MdgRuns.AI_HOLD', "AI 平台限流时运行等待（倒计时），不是补救按钮"],
  ["triage/fav-export.js", 'new Set(["OBSIDIAN", "OBSIDIAN_DOWN"])', "Obsidian 不能用时逐个视频笔记整批停下；横幅的按钮按 action 给"],
  ["triage/follow.js", "runs.hold({ code: MdgErrors.CODE.THROTTLED })", "B站限流时关注的动态等待倒计时"],
  ["triage/follow.js", "r.code === MdgErrors.CODE.THROTTLED) waitFeed(f)", "B站限流时关注的动态等待倒计时"],
  ["triage/follow.js", "r.code === MdgErrors.CODE.THROTTLED ? { ms: UI.BILI_HOLD_MS", "B站限流时关注的运行等待倒计时"],
  ["content.js", "error.code !== MdgErrors.CODE.THROTTLED ?", "字幕接口自己的 429 换成它的说法，不是补救按钮"],
  // 3b: AI_TRUNCATED is 分拣台's own (打开收藏夹设置 for its 输出上限); the table says 重试 like any other.
  ["triage/fav-ai.js", 'if (r.code === "AI_TRUNCATED") handleAiError(r.error, r.code);', "截断只在分拣台：横幅给「打开收藏夹设置」调输出上限"],
  ["triage/fav-ai.js", 'if (r.code === "AI_TRUNCATED") handleAiError(r.error, r.code, "细看");', "同上，细看"],
  ["triage/tag-store.js", 'if (x.code === "AI_TRUNCATED" && limitHint)', "同上，AI 打标签（只有收藏夹给 limitHint）"],
  ["triage/fav-base.js", '} else if (code === "AI_TRUNCATED") {', "同上，横幅本身"],
  // 3d: a situation without a code.
  ["sidepanel.js", "showConversationContextNotice(MdgErrors.TEXT.aiNone, 0, { error: true, action: { label: MdgErrors.LABEL.toSettings", "没有启用的 AI 平台（发送前就知道，即 AI_SETUP）：只给「去设置」，输入框留着原文，改好后再按发送"],
  // 3c: the gone video's sentence; whether 重试 shows is remedies'.
  ["content.js", "MdgSites.isBiliVideoGone(state.readCode) ? MdgErrors.LABEL.videoGone", "说法：视频已失效"],
  ["sidepanel.js", "MdgSites.isBiliVideoGone(resp?.code) ? MdgErrors.LABEL.videoGone", "说法：视频已失效"],
  ["sidepanel.js", "const gone = !ok && MdgSites.isBiliVideoGone(response?.code);", "说法：VIDEO_GONE（只能查看，不能继续提问）"],
  ["sidepanel.js", "MdgSites.isBiliVideoGone(response?.code) ? null : undefined", "已失效的视频补全标题时不再重查，不显示错误"]
];
const used = ALLOW.map(() => 0);
const allowed = (f, i) => {
  const j = ALLOW.findIndex(([af, snippet], k) => af === f && lines[f][i].includes(snippet) && !used[k]);
  if (j >= 0) used[j]++;
  return j >= 0;
};

// 3a. The settings page opens only from a click: an opener (chrome.runtime.openOptionsPage, or the page's own wrapper
// that sends open-options) is called only as the body of a handler arrow on a click / run / banner line, or passed as one.
const OPENERS = ["chrome.runtime.openOptionsPage", "requestOpenOptions", "openOptions", "T.openOptions"];
const HANDLER = /addEventListener\("click"|\brun:\s|showBanner\(|\.onclick\s*=|\? \(\) =>/;
for (const [f, ls] of Object.entries(lines)) {
  let opener = "";
  ls.forEach((line, i) => {
    if (isComment(line)) return;
    const def = /(?:function\s+|const\s+)(requestOpenOptions|openOptions)\b/.exec(line);
    if (def) opener = def[1];
    if (/"open-options"/.test(line) && !opener) check(false, `3a. open-options sent outside an opener: ${at(f, i)}`);
    if (def || /^\s*[\w,\s:()=>|[\].]+,\s*$/.test(line) && /\bopenOptions,/.test(line)) return; // its definition, or an export list
    for (const m of line.matchAll(new RegExp(`(?<![\\w.])(${OPENERS.map((o) => o.replace(".", "\\.")).join("|")})\\b(\\()?`, "g"))) {
      const before = line.slice(0, m.index);
      const handler = HANDLER.test(before);
      const ok = m[2] ? /=>\s*$/.test(before) && handler : handler;
      check(ok, `3a. the settings page opens outside a click: ${at(f, i)}`);
    }
  });
}

// 3b. A code compared or looked up by name in an entry (one of RULES' names quoted, or MdgErrors.CODE.X).
const names = Object.keys(RULES).filter((k) => /^[A-Z_]+$/.test(k)).join("|");
const CODE_RE = new RegExp(`["'](${names})["']|\\bCODE\\.[A-Z_]+`);
// 3c. isBiliVideoGone in an entry.
const GONE_RE = /isBiliVideoGone\(/;
// 3d. 去设置 / 授权 decided next to the shared rule (the line or the 6 before it).
const REMEDY_RE = /LABEL\.(toSettings|grant)\b|"去设置"/;
const DECIDED = /remedies\(|\.action\b|action\(|aiSettingsCode\(|grantOrigin\(|includes\("(settings|grant)"\)/;
for (const [f, ls] of Object.entries(lines)) {
  ls.forEach((line, i) => {
    if (isComment(line)) return;
    if (CODE_RE.test(line) && !allowed(f, i)) check(false, `3b. an entry decides on a code itself (use MdgErrors.remedies): ${at(f, i)}`);
    if (GONE_RE.test(line) && !allowed(f, i)) check(false, `3c. isBiliVideoGone in an entry (retry is MdgErrors.remedies'): ${at(f, i)}`);
    if (REMEDY_RE.test(line) && !ls.slice(Math.max(0, i - 6), i + 1).some((l) => DECIDED.test(l)) && !allowed(f, i)) check(false, `3d. 去设置 / 授权 not decided by MdgErrors: ${at(f, i)}`);
  });
}
ALLOW.forEach(([f, snippet], j) => check(used[j] === 1, `ALLOW: ${f} 「${snippet}」 matches ${used[j]} hits; drop or fix the line`));

// 4. 复制 Markdown / 下载 .md / 写入 Obsidian go through MdgNoteActions (note-actions.js) on every entry: no other
// shipped file sends write-video-note or export-note, or opens MdgOverwriteDialog's dialogs itself. Only these may.
const NOTE_FLOW = {
  "note-actions.js": "the flow: sends both, asks both dialogs",
  "obsidian.js": "answers both",
  "messages.js": "the message list"
};
const NOTE_FLOW_RE = /["'](write-video-note|export-note)["']|MdgOverwriteDialog\.choose/;
(function walk(dir) {
  for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) !/^(dev|vendor$)/.test(e.name) && walk(rel);
    else if (rel.endsWith(".js") && !rel.endsWith(".selftest.js") && !(rel in NOTE_FLOW)) {
      read(rel).split("\n").forEach((l, i) => !isComment(l) && NOTE_FLOW_RE.test(l) && check(false, `4. ${rel}:${i + 1} sends a note request or opens its dialog itself (use MdgNoteActions.run): ${l.trim().slice(0, 120)}`));
    }
  }
})(".");
for (const f of Object.keys(NOTE_FLOW)) check(NOTE_FLOW_RE.test(read(f)), `4. NOTE_FLOW lists ${f}, which no longer names them`);

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(`entry-matrix ok: ${Object.keys(RULES).length} codes, ${Object.keys(ENTRIES).length} entry files, ${Object.keys(loads).length} pages`);
