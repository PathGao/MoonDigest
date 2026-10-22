// node extension/note.selftest.js
// Goldens were captured from content.js buildMarkdown before it moved here (commit 45df77d);
// a diff means the note format changed, which every existing vault note would notice.
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");
const PS = require("./page-sources.selftest.js");

const ctx = vm.createContext({ URL, URLSearchParams, console });
vm.runInContext(fs.readFileSync(path.join(__dirname, "common.js"), "utf8"), ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, "limits.js"), "utf8"), ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, "errors.js"), "utf8"), ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, "settings.js"), "utf8"), ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, "sites.js"), "utf8"), ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, "tag-core.js"), "utf8"), ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, "note.js"), "utf8"), ctx);
const N = ctx.MdgNote;
const CREATED = "2026-10-02";

const baseSettings = {
  tags: "clippings, 视频",
  includeDateInFilename: true,
  includeHotCommentsInNote: false,
  includeCoverInNote: true,
  includeTimestampInBody: true,
  frontmatterFields: ["title","url","site","video_id","cid","author","author_url","upload_date","duration","cover","subtitle_lang","created","tags","video_tags"],
  fixedFrontmatterProperties: [{ key: "source", type: "text", value: "{{site}}/{{video_id}}" }, { key: "rating", type: "number", value: "5" }],
  notePlaceholderSections: [{ title: "我的笔记", position: "before_intro", content: "来自 {{author}}" }, { title: "待办", position: "before_subtitle", content: "" }],
  noteFolder: "Clippings/{{site}}/{{created}}"
};
const body = [
  { from: 0, to: 4.5, content: "大家好，欢迎来到本期视频" },
  { from: 4.5, to: 9, content: "今天讲三件事" },
  { from: 65, to: 70, content: "第一件事是" },
  { from: 130, to: 140, content: "最后总结一下" }
];
const comments = [
  { uname: "观众A", like: 120, message: "讲得很清楚" },
  { uname: "", like: 3, message: "mark" },
  { uname: "观众C", like: 0, message: "" }
];
const bili = {
  site: "bilibili", videoId: "BV1GJ411x7h7", cid: "123456", aid: "98765", pageIndex: 1, pageCount: 1, pageTitle: "",
  title: "测试视频：引号\"与反斜杠\\", author: "UP主", authorUrl: "https://space.bilibili.com/1", uploadDate: "2026-09-30",
  videoDuration: 150, cover: "https://i0.hdslb.com/bfs/archive/abc.jpg", videoTags: ["科技", "AI"], selectedSubtitleLang: "zh-CN",
  description: "这是简介\n第二行", chapters: [{ from: 0, to: 60, title: "开场" }, { from: 60, to: 130, title: "正文" }], hotComments: comments
};
const cases = {
    biliSingle: { meta: bili, body, settings: baseSettings },
    biliMultiP: { meta: { ...bili, pageIndex: 2, pageCount: 3, pageTitle: "第二集" }, body, settings: baseSettings },
    youtube: {
      meta: { ...bili, site: "youtube", videoId: "dQw4w9WgXcQ", cid: "", aid: "", videoDuration: 4000, chapters: [], videoTags: [], cover: "https://i.ytimg.com/vi/x/hq.jpg", authorUrl: "https://www.youtube.com/@x" },
      body: body.map((s) => ({ ...s, from: s.from + 3600, to: s.to + 3600 })),
      settings: { ...baseSettings, includeTimestampInBody: false, includeHotCommentsInNote: true, fixedFrontmatterProperties: [], notePlaceholderSections: [] }
    },
    noSubtitle: { meta: { ...bili, chapters: [] }, body: [], settings: baseSettings }
};

const refOf = (meta) => {
  const site = ctx.MdgSites.SITES[meta.site];
  const page = meta.pageCount > 1 ? meta.pageIndex : 1;
  return { site: meta.site, id: meta.videoId, part: { index: page, cid: meta.cid }, url: site.canonicalUrl(meta.videoId, page) };
};

const golden = {
  "biliSingle": {
    "file": "2026-10-02-测试视频：引号_与反斜杠_.md",
    "folder": "Clippings/bilibili/2026-10-02",
    "md": [
      "---",
      "title: \"测试视频：引号\\\"与反斜杠\\\\\"",
      "url: \"https://www.bilibili.com/video/BV1GJ411x7h7/\"",
      "site: \"bilibili\"",
      "video_id: \"BV1GJ411x7h7\"",
      "cid: \"123456\"",
      "author: \"UP主\"",
      "author_url: \"https://space.bilibili.com/1\"",
      "upload_date: \"2026-09-30\"",
      "duration: 150",
      "cover: \"https://i0.hdslb.com/bfs/archive/abc.jpg\"",
      "subtitle_lang: \"zh-CN\"",
      "created: \"2026-10-02\"",
      "tags: [\"clippings\", \"视频\"]",
      "video_tags: [\"科技\", \"AI\"]",
      "source: \"bilibili/BV1GJ411x7h7\"",
      "rating: 5",
      "---",
      "",
      "![cover](https://i0.hdslb.com/bfs/archive/abc.jpg)",
      "",
      "<iframe src=\"https://player.bilibili.com/player.html?aid=98765&bvid=BV1GJ411x7h7&cid=123456&page=1&autoplay=0\" scrolling=\"no\" border=\"0\" frameborder=\"no\" framespacing=\"0\" allow=\"fullscreen; picture-in-picture\" allowfullscreen=\"true\" style=\"height:100%;width:100%; aspect-ratio: 16 / 9;\"> </iframe>",
      "",
      "## 我的笔记",
      "",
      "来自 UP主",
      "",
      "## 简介",
      "",
      "这是简介",
      "第二行",
      "",
      "## 章节",
      "",
      "- `00:00` 开场",
      "- `01:00` 正文",
      "",
      "## 待办",
      "",
      "## 字幕",
      "",
      "### 开场 `00:00`",
      "",
      "`00:00` 大家好，欢迎来到本期视频",
      "`00:04` 今天讲三件事",
      "",
      "### 正文 `01:00`",
      "",
      "`01:05` 第一件事是",
      "",
      "### 其他片段",
      "",
      "`02:10` 最后总结一下"
    ]
  },
  "biliMultiP": {
    "file": "2026-10-02-测试视频：引号_与反斜杠_-P2-第二集.md",
    "folder": "Clippings/bilibili/2026-10-02",
    "md": [
      "---",
      "title: \"测试视频：引号\\\"与反斜杠\\\\\"",
      "url: \"https://www.bilibili.com/video/BV1GJ411x7h7/?p=2\"",
      "site: \"bilibili\"",
      "video_id: \"BV1GJ411x7h7\"",
      "cid: \"123456\"",
      "author: \"UP主\"",
      "author_url: \"https://space.bilibili.com/1\"",
      "upload_date: \"2026-09-30\"",
      "duration: 150",
      "cover: \"https://i0.hdslb.com/bfs/archive/abc.jpg\"",
      "subtitle_lang: \"zh-CN\"",
      "created: \"2026-10-02\"",
      "tags: [\"clippings\", \"视频\"]",
      "video_tags: [\"科技\", \"AI\"]",
      "source: \"bilibili/BV1GJ411x7h7\"",
      "rating: 5",
      "---",
      "",
      "![cover](https://i0.hdslb.com/bfs/archive/abc.jpg)",
      "",
      "<iframe src=\"https://player.bilibili.com/player.html?aid=98765&bvid=BV1GJ411x7h7&cid=123456&page=2&autoplay=0\" scrolling=\"no\" border=\"0\" frameborder=\"no\" framespacing=\"0\" allow=\"fullscreen; picture-in-picture\" allowfullscreen=\"true\" style=\"height:100%;width:100%; aspect-ratio: 16 / 9;\"> </iframe>",
      "",
      "## 我的笔记",
      "",
      "来自 UP主",
      "",
      "## 简介",
      "",
      "这是简介",
      "第二行",
      "",
      "## 章节",
      "",
      "- `00:00` 开场",
      "- `01:00` 正文",
      "",
      "## 待办",
      "",
      "## 字幕",
      "",
      "### 开场 `00:00`",
      "",
      "`00:00` 大家好，欢迎来到本期视频",
      "`00:04` 今天讲三件事",
      "",
      "### 正文 `01:00`",
      "",
      "`01:05` 第一件事是",
      "",
      "### 其他片段",
      "",
      "`02:10` 最后总结一下"
    ]
  },
  "youtube": {
    "file": "2026-10-02-测试视频：引号_与反斜杠_.md",
    "folder": "Clippings/youtube/2026-10-02",
    "md": [
      "---",
      "title: \"测试视频：引号\\\"与反斜杠\\\\\"",
      "url: \"https://www.youtube.com/watch?v=dQw4w9WgXcQ\"",
      "site: \"youtube\"",
      "video_id: \"dQw4w9WgXcQ\"",
      "author: \"UP主\"",
      "author_url: \"https://www.youtube.com/@x\"",
      "upload_date: \"2026-09-30\"",
      "duration: 4000",
      "cover: \"https://i.ytimg.com/vi/x/hq.jpg\"",
      "subtitle_lang: \"zh-CN\"",
      "created: \"2026-10-02\"",
      "tags: [\"clippings\", \"视频\"]",
      "---",
      "",
      "![cover](https://i.ytimg.com/vi/x/hq.jpg)",
      "",
      "<iframe src=\"https://www.youtube.com/embed/dQw4w9WgXcQ\" title=\"YouTube video player\" frameborder=\"0\" allow=\"accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share\" allowfullscreen style=\"height:100%;width:100%; aspect-ratio: 16 / 9;\"></iframe>",
      "",
      "## 简介",
      "",
      "这是简介",
      "第二行",
      "",
      "## 字幕",
      "",
      "大家好，欢迎来到本期视频",
      "今天讲三件事",
      "第一件事是",
      "最后总结一下",
      "",
      "## 热门评论",
      "",
      "1. 观众A（赞 120）",
      "   讲得很清楚",
      "",
      "2. 匿名（赞 3）",
      "   mark"
    ]
  },
  "noSubtitle": {
    "file": "2026-10-02-测试视频：引号_与反斜杠_.md",
    "folder": "Clippings/bilibili/2026-10-02",
    "md": [
      "---",
      "title: \"测试视频：引号\\\"与反斜杠\\\\\"",
      "url: \"https://www.bilibili.com/video/BV1GJ411x7h7/\"",
      "site: \"bilibili\"",
      "video_id: \"BV1GJ411x7h7\"",
      "cid: \"123456\"",
      "author: \"UP主\"",
      "author_url: \"https://space.bilibili.com/1\"",
      "upload_date: \"2026-09-30\"",
      "duration: 150",
      "cover: \"https://i0.hdslb.com/bfs/archive/abc.jpg\"",
      "subtitle_lang: \"zh-CN\"",
      "created: \"2026-10-02\"",
      "tags: [\"clippings\", \"视频\"]",
      "video_tags: [\"科技\", \"AI\"]",
      "source: \"bilibili/BV1GJ411x7h7\"",
      "rating: 5",
      "---",
      "",
      "![cover](https://i0.hdslb.com/bfs/archive/abc.jpg)",
      "",
      "<iframe src=\"https://player.bilibili.com/player.html?aid=98765&bvid=BV1GJ411x7h7&cid=123456&page=1&autoplay=0\" scrolling=\"no\" border=\"0\" frameborder=\"no\" framespacing=\"0\" allow=\"fullscreen; picture-in-picture\" allowfullscreen=\"true\" style=\"height:100%;width:100%; aspect-ratio: 16 / 9;\"> </iframe>",
      "",
      "> 视频没有字幕，以下为简介与热门评论。",
      "",
      "## 我的笔记",
      "",
      "来自 UP主",
      "",
      "## 简介",
      "",
      "这是简介",
      "第二行",
      "",
      "## 待办",
      "",
      "## 热门评论",
      "",
      "1. 观众A（赞 120）",
      "   讲得很清楚",
      "",
      "2. 匿名（赞 3）",
      "   mark"
    ]
  }
};

for (const [name, c] of Object.entries(cases)) {
  const md = N.buildMarkdown(c.meta, c.body, c.settings, refOf(c.meta), CREATED);
  assert.strictEqual(md, golden[name].md.join("\n"), name + " markdown");
  assert.strictEqual(N.buildNoteFilename(c.meta, c.settings, CREATED), golden[name].file, name + " filename");
  assert.strictEqual(N.resolveFolderTemplate(c.settings.noteFolder, c.meta, CREATED), golden[name].folder, name + " folder");
}
{
  const viaVideoId = N.resolveFolderTemplate("Notes/{{video_id}}", cases.biliSingle.meta, CREATED);
  assert.ok(cases.biliSingle.meta.videoId && viaVideoId.endsWith(cases.biliSingle.meta.videoId), "{{video_id}} resolves in the folder");
  assert.strictEqual(viaVideoId, N.resolveFolderTemplate("Notes/{{id}}", cases.biliSingle.meta, CREATED), "{{video_id}} and {{id}} resolve the same");
}
assert.strictEqual(N.buildNoteFilename(cases.biliSingle.meta, { includeDateInFilename: false }, CREATED), "测试视频：引号_与反斜杠_.md");
assert.strictEqual(N.buildMarkdown(cases.biliSingle.meta, body, baseSettings, null, CREATED).includes('\nurl: "'), false, "no ref means no url");
// 分拣台 tags join the fixed ones; characters Obsidian tags cannot hold become _, and repeats go.
assert.ok(N.buildMarkdown({ ...cases.biliSingle.meta, userTags: ["入门 教程", "视频", "C++"] }, body, baseSettings, null, CREATED).includes('\ntags: ["clippings", "视频", "入门_教程", "C_"]\n'));
assert.ok(N.buildMarkdown({ ...cases.biliSingle.meta, starred: true }, body, baseSettings, null, CREATED).includes('\nstarred: true\n'));
assert.ok(!N.buildMarkdown(cases.biliSingle.meta, body, baseSettings, null, CREATED).includes("starred"));
{
  const c = cases.noSubtitle;
  const md = N.buildMarkdown({ ...c.meta, subtitleFailure: "网络断了" }, c.body, c.settings, refOf(c.meta), CREATED);
  assert.ok(md.includes("> 字幕抓取失败：网络断了，以下为简介与热门评论。"), "failed fetch is not reported as no subtitles");
  assert.ok(!md.includes("视频没有字幕"), "failed fetch drops the no-subtitle line");
  // Not logged in is its own state, and a note carries no instruction to log in.
  const loggedOut = N.buildMarkdown({ ...c.meta, subtitleNeedLogin: true }, c.body, c.settings, refOf(c.meta), CREATED);
  assert.ok(loggedOut.includes("> 未登录 B站，拿不到字幕，以下为简介与热门评论。") && !/刷新|请登录/.test(loggedOut), loggedOut);
  // The sentence a written note's result starts with, the same from the video page and triageBuildNote.
  assert.deepStrictEqual(
    [N.noteSubtitleWarning("", { subtitleFailure: "网络断了" }), N.noteSubtitleWarning("", { subtitleNeedLogin: true }), N.noteSubtitleWarning("对不上。", { subtitleFailure: "x" }), N.noteSubtitleWarning("", {})],
    ["字幕抓取失败：网络断了。", "未登录 B站，拿不到字幕。", "对不上。", ""]
  );
}
assert.strictEqual(N.formatCompactTimestamp(3661, true), "01:01:01");
assert.strictEqual(N.formatCompactTimestamp(3661, false), "61:01");
assert.strictEqual(N.formatTimestamp(1.5, true), "00:00:01,500");
assert.strictEqual(N.buildSrt(body.slice(0, 1)), "1\n00:00:00,000 --> 00:00:04,500\n大家好，欢迎来到本期视频");
assert.strictEqual(N.buildTxt(body.slice(0, 2), { includeTimestampInBody: true }), "00:00 大家好，欢迎来到本期视频\n00:04 今天讲三件事");
// A newline inside a double-quoted YAML value must stay escaped or the frontmatter breaks.
assert.strictEqual(N.escapeYaml('a"b\\c\nd\r\te'), 'a\\"b\\\\c\\nd\\r\\te');

// ---- AI 问答 section ----
const messages = [
  { role: "user", content: "总结一下" },
  { role: "assistant", content: "<think>想一想</think>## 要点\n\n- `01:09` 第一点\n\n```\n# not a heading\n```" },
  { role: "user", content: "没有回答的问题" },
  { role: "user", content: "# 第二问\n换行" },
  { role: "assistant", content: "第二答" }
];
// vm objects have another realm's prototypes, so compare through JSON.
const turns = JSON.parse(JSON.stringify(N.buildConversationTurns(messages)));
assert.deepStrictEqual(turns, [
  { prompt: "总结一下", answer: "## 要点\n\n- `01:09` 第一点\n\n```\n# not a heading\n```".replace("## 要点", "#### 要点").replace("`01:09`", "01:09") },
  { prompt: "# 第二问\n换行", answer: "第二答" }
]);
const section = N.buildAiSection(turns);
assert.deepStrictEqual(section.split("\n"), [
  "<!-- moondigest:ai-start -->",
  "## AI 问答",
  "",
  "### 问：总结一下",
  "",
  "##### 要点",
  "",
  "- 01:09 第一点",
  "",
  "```",
  "# not a heading",
  "```",
  "",
  "### 问：第二问 换行",
  "",
  "第二答",
  "",
  "<!-- moondigest:ai-end -->"
]);
assert.strictEqual(N.buildAiSection([]), "");
assert.strictEqual(N.buildAiSection(undefined), "");

// The video note carries the section when turns exist and the toggle is on; the body above it is unchanged.
const plain = N.buildMarkdown(cases.biliSingle.meta, body, baseSettings, refOf(bili), CREATED);
const withAi = N.buildMarkdown({ ...cases.biliSingle.meta, aiTurns: turns }, body, baseSettings, refOf(bili), CREATED);
assert.strictEqual(withAi, `${plain}\n\n${section}`);
assert.strictEqual(N.buildMarkdown({ ...cases.biliSingle.meta, aiTurns: turns }, body, { ...baseSettings, includeAiChatInNote: false }, refOf(bili), CREATED), plain);

// The AI context is the note without the player embed (Obsidian's only) and hot comments; the note keeps the embed.
for (const c of [cases.biliSingle, cases.youtube]) {
  const note = N.buildMarkdown(c.meta, c.body, { ...c.settings, includeHotCommentsInNote: false, includeTimestampInBody: true }, refOf(c.meta));
  const ai = N.buildAiContext(c.meta, c.body, { ...c.settings, includeHotCommentsInNote: true }, refOf(c.meta));
  assert.ok(!ai.includes("## 热门评论"), "no hot comments");
  assert.ok(note.includes("<iframe") && !ai.includes("<iframe"), c.meta.title);
  assert.strictEqual(ai, note.replace(/<iframe[^\n]*\n\n/, ""), "nothing else differs");
}
// The file-only switches do not reach the AI: timestamps stay with 正文保留时间戳 off, and the AI 问答 section (the video
// page's state carries aiTurns) is never in it, whatever 附带 AI 问答 says.
{
  const c = cases.biliSingle;
  const stamped = N.buildAiContext(c.meta, c.body, { ...c.settings, includeTimestampInBody: true }, refOf(c.meta));
  assert.strictEqual(N.buildAiContext(c.meta, c.body, { ...c.settings, includeTimestampInBody: false }, refOf(c.meta)), stamped);
  assert.ok(/`\d+:\d\d`/.test(stamped), stamped);
  assert.strictEqual(N.buildAiContext({ ...c.meta, aiTurns: turns }, c.body, { ...c.settings, includeAiChatInNote: true }, refOf(c.meta)), stamped);
}

// upsert: present → replaced, absent → appended, outside bytes identical, idempotent, empty section leaves the note alone.
const userNote = "---\ntitle: x\n---\n\n## 字幕\n\n正文  \n\n我的批注\n";
const appended = N.upsertAiSection(userNote, section);
assert.strictEqual(appended, `${userNote}\n${section}\n`);
assert.strictEqual(N.upsertAiSection(appended, section), appended, "idempotent");
const edited = `${appended}\n后记（标记之后的文字）\n`;
const newSection = N.buildAiSection([{ prompt: "追问", answer: "新答案" }]);
const replaced = N.upsertAiSection(edited, newSection);
assert.strictEqual(replaced, `${userNote}\n${newSection}\n\n后记（标记之后的文字）\n`);
assert.strictEqual(N.upsertAiSection(replaced, newSection), replaced, "idempotent after replace");
assert.strictEqual(N.upsertAiSection(userNote, ""), userNote, "no conversation → unchanged");
assert.strictEqual(N.upsertAiSection(appended, ""), `${userNote}\n\n`, "empty section removes the marked block only");
assert.strictEqual(N.upsertAiSection("no trailing newline", section), `no trailing newline\n\n${section}\n`);
// A note with only the start marker (user deleted the end) gets a fresh section appended rather than a truncated note.
const halfMarked = `${userNote}${N.AI_SECTION_START}\n## AI 问答\n`;
assert.strictEqual(N.upsertAiSection(halfMarked, newSection), `${halfMarked}\n${newSection}\n`);
// A23: the next sync replaces only that appended section; the text after the stray start marker stays.
assert.strictEqual(N.upsertAiSection(`${halfMarked}\n${newSection}\n`, section), `${halfMarked}\n${section}\n`);
// R5: a note whose start marker the user deleted gets one section appended, and later syncs replace that one.
const endOnly = `${userNote}${section.replace(`${N.AI_SECTION_START}\n`, "")}\n\n后记\n`;
const once = N.upsertAiSection(endOnly, newSection);
assert.strictEqual(once, `${endOnly}\n${newSection}\n`);
assert.strictEqual(N.upsertAiSection(N.upsertAiSection(once, newSection), newSection), once, "no second section");
assert.strictEqual(N.upsertAiSection(once, section), `${endOnly}\n${section}\n`);

// pickConversation: the newest conversation of the part or page, by the side panel's rule (MdgSites.isConversationOf;
// sidepanel-state.selftest.js M2 checks both pick the same over stored shapes). Other videos and parts never match.
const conv = (contextKey, updatedAt, contextRef) => ({ contextKey, updatedAt, messages, contextRef });
const bv = (cid, pageIndex = 1) => ({ site: "bilibili", videoId: "BV1", cid, pageIndex });
const convs = [conv("video:bilibili:BV1|", 1, bv("")), conv("video:bilibili:BV1|c2", 5, bv("c2", 2)), conv("video:bilibili:BV1|c1", 3, bv("c1")), conv("video:youtube:BV1|", 9, { site: "youtube", videoId: "BV1" })];
assert.strictEqual(N.pickConversation(convs, { site: "bilibili", videoId: "BV1", cid: "c1" }).updatedAt, 3);
assert.strictEqual(N.pickConversation(convs, { site: "bilibili", videoId: "BV1", cid: "c9" }).updatedAt, 3, "a part whose cid changed keeps its conversations");
// C191: a ref without the cid takes its own part's newest, never P2's.
assert.strictEqual(N.pickConversation(convs, { site: "bilibili", videoId: "BV1" }).updatedAt, 3, "no cid → newest of the same part");
assert.strictEqual(N.pickConversation(convs, { site: "bilibili", videoId: "BV1", pageIndex: 2 }).updatedAt, 5);
// M2 (was C192): the newest of the part, as the side panel shows it, also when it was saved without the cid.
assert.strictEqual(N.pickConversation([...convs, conv("video:bilibili:BV1|", 8, bv(""))], { site: "bilibili", videoId: "BV1", cid: "c1" }).updatedAt, 8);
assert.strictEqual(N.pickConversation(convs, { site: "bilibili", videoId: "BV2" }), null);
assert.strictEqual(N.pickConversation(convs, { site: "youtube", videoId: "" }), null);
// A web page: its page: key (its URL without #), newest; a video's URL-less ref still finds nothing.
const page = (url, updatedAt) => conv(`page:${url}`, updatedAt, { url, isVideoContext: false });
const pages = [...convs, page("https://example.com/a", 2), page("https://example.com/a", 4), page("https://example.com/a?x", 7)];
assert.strictEqual(N.pickConversation(pages, { url: "https://example.com/a#top" }).updatedAt, 4);
assert.strictEqual(N.pickConversation(pages, { url: "https://example.com/b" }), null);
assert.strictEqual(N.pickConversation(pages, { site: "bilibili", videoId: "BV1", url: "https://example.com/a" }).updatedAt, 3, "a video keeps its own key");
// AI conversation note (side panel 保存对话 / history page): moved out of sidepanel.js byte for byte.
const aiContext = { title: "视频]标题", url: "https://www.bilibili.com/video/BV1GJ411x7h7/?p=2", site: "bilibili", videoId: "BV1GJ411x7h7", author: "UP主" };
const aiFile = N.buildAiConversationFilename(aiContext);
assert.strictEqual(aiFile, "【AI笔记】视频_标题.md");
assert.strictEqual(
  N.buildAiConversationMarkdown({ context: aiContext, turns: [{ prompt: "# 问一", answer: "答一" }, { prompt: "问二", answer: "答二" }], filename: aiFile, sourcePath: "Clip/视频.md" }),
  `---\ntitle: "【AI笔记】视频_标题"\nsource_title: "视频]标题"\nsource: "[[Clip/视频]]"\nurl: "https://www.bilibili.com/video/BV1GJ411x7h7/"\nauthor: "UP主"\ncreated: "${ctx.MdgCommon.localDate()}"\ntags: [ai_note]\n---\n\n来源：[[Clip/视频|视频］标题]]\n\n## 问一\n\n答一\n\n## 问二\n\n答二\n`
);
assert.ok(N.buildAiConversationMarkdown({ context: {}, turns: [], filename: "x.md" }).includes("来源：无标题视频"), "no source path → no dangling link");
// K19: an untitled video's AI 笔记 is named as 摘读记录 names it, with its id: two untitled videos, two files.
assert.deepStrictEqual(["BV1xx411c7mD", "BV1yy411c7mD"].map((videoId) => N.buildAiConversationFilename({ videoId })), ["【AI笔记】无标题视频 BV1xx411c7mD.md", "【AI笔记】无标题视频 BV1yy411c7mD.md"]);
// 摘读记录's tags (cleaned as note tags) and 星标 go into the AI 笔记 after ai_note.
assert.ok(N.buildAiConversationMarkdown({ context: {}, turns: [], filename: "x.md", extras: { userTags: ["学 习"], starred: true } }).includes('\ntags: ["ai_note", "学_习"]\nstarred: true\n---'));
// Triage summary block (triage notes and history-page notes)
const front = "---\ntitle: \"x\"\n---\n\n![cover](u)\n\n## 简介\n\nhi";
const done = { status: "done", oneLiner: "一句话", points: ["a", "b"], verdict: "keep", reason: "有用" };
assert.strictEqual(
  N.withTriageSummary(front, done),
  "---\ntitle: \"x\"\n---\n\n## AI 总结\n\n> 一句话\n\n- a\n- b\n\nAI 判断：值得留，有用\n\n![cover](u)\n\n## 简介\n\nhi"
);
assert.strictEqual(N.withTriageSummary("## 简介\n\nhi", { status: "done", verdict: "drop" }), "## AI 总结\n\nAI 判断：可清理\n\n## 简介\n\nhi");
assert.strictEqual(N.withTriageSummary(front, { status: "error" }), front);
assert.strictEqual(N.withTriageSummary(front, undefined), front);
assert.strictEqual(N.withTriageSummary("## 简介", { status: "done", verdict: "drop" }, " 我的话 "), "## AI 总结\n\nAI 判断：可清理\n\n## 备注\n\n我的话\n\n## 简介");
assert.strictEqual(N.withTriageSummary(front, undefined, "n"), "---\ntitle: \"x\"\n---\n\n## 备注\n\nn\n\n![cover](u)\n\n## 简介\n\nhi");
assert.strictEqual(N.withTriageSummary(front, undefined, "  "), front);

// One read of the 分拣台 extras for every note writer: the summary only on B站 P1, the note on any site and part,
// the 分拣 tags on every B站 part (ids → names, unknown ids dropped, duplicate names once).
{
  const stored = {
    triage_analysis_BVa: { status: "done" },
    triage_notes: { BVa: { text: "备注" }, yt1: { text: "yt 备注" } },
    triage_tags: [{ id: "t1", name: "甲" }, { id: "t2", name: "甲" }, { id: "t3", name: "乙" }],
    triage_video_tags: { BVa: ["t1", "t2", "t3", "gone"], yt1: ["t3"] }
  };
  const plain = (v) => JSON.parse(JSON.stringify(v));
  assert.deepStrictEqual(plain(N.triageExtras(stored, { site: "bilibili", videoId: "BVa", pageIndex: 1 })), { analysis: { status: "done" }, note: "备注", userTags: ["甲", "乙"], starred: false });
  assert.deepStrictEqual(plain(N.triageExtras(stored, { site: "bilibili", videoId: "BVa", pageIndex: 2 })), { analysis: null, note: "备注", userTags: ["甲", "乙"], starred: false });
  assert.deepStrictEqual(plain(N.triageExtras(stored, { site: "youtube", videoId: "yt1" })), { analysis: null, note: "yt 备注", userTags: [], starred: false });
  assert.deepStrictEqual(plain(N.triageExtrasKeys({ site: "bilibili", videoId: "BVa" })), ["triage_notes", "triage_tags", "triage_video_tags", "triage_analysis_BVa", "mdg_reading_marks_v1"]);
  assert.deepStrictEqual(plain(N.triageExtrasKeys({ site: "bilibili", videoId: "BVa", pageIndex: 2 })), ["triage_notes", "triage_tags", "triage_video_tags", "mdg_reading_marks_v1"]);
  assert.deepStrictEqual(plain(N.triageExtrasKeys({ site: "youtube", videoId: "yt1" })), ["triage_notes", "mdg_reading_marks_v1"]);
  assert.deepStrictEqual(plain(N.triageExtrasKeys({ site: "bilibili", videoId: "" })), []);
  // 摘读记录's marks: a video's tags join the 分拣 tags on every part (one record key, no cid); a web page's by its
  // address without the #fragment, with no 分拣台 data.
  const marks = {
    tags: [{ id: "r1", name: "乙" }, { id: "r2", name: "读" }],
    items: { [N.readingKey({ site: "bilibili", videoId: "BVa" })]: { star: 1, tags: ["r1", "r2", "gone"] }, "page:https://a.com/p": { star: 0, tags: ["r2"] } }
  };
  const withMarks = { ...stored, mdg_reading_marks_v1: marks };
  assert.deepStrictEqual(plain(N.triageExtras(withMarks, { site: "bilibili", videoId: "BVa", pageIndex: 2 })), { analysis: null, note: "备注", userTags: ["甲", "乙", "读"], starred: true });
  assert.deepStrictEqual(plain(N.triageExtras(withMarks, { url: "https://a.com/p#s" })), { analysis: null, note: "", userTags: ["读"], starred: false });
  assert.deepStrictEqual(plain(N.triageExtrasKeys({ url: "https://a.com/p" })), ["mdg_reading_marks_v1"]);
}
assert.strictEqual(N.buildTriageSummary({ status: "done", verdict: "unsure", reason: "核心" }), "AI 判断：拿不准，核心");
// A verdict left from the old custom tiers reads 拿不准, as MdgTagCore.verdictOf says on 分拣台 and B站 pages.
assert.strictEqual(N.buildTriageSummary({ status: "done", verdict: "must", reason: "旧档" }), "AI 判断：拿不准，旧档");

assert.strictEqual(N.buildTriageSummary({ status: "done", oneLiner: "一句话", points: ["a", "", ""] }), "> 一句话\n\n- a\n\nAI 判断：拿不准", "padded empty points are dropped");
assert.strictEqual(
  N.renderMarkdown("<think>x</think>## 标题\n\n**粗** <b>\n\n- a\n- b"),
  "<h4>标题</h4><p><strong>粗</strong> &lt;b&gt;</p><ul><li>a</li><li>b</li></ul>",
  "markdown renders, raw HTML is escaped, think is stripped"
);
// A24, A25: a fence's language line is not code; numbered items are one list.
assert.strictEqual(N.renderMarkdown("```python\nprint(1)\n```"), "<pre><code>print(1)\n</code></pre>");
assert.strictEqual(N.renderMarkdown("1. a\n2. b\n\n3. c"), "<ol><li>a</li><li>b</li><li>c</li></ol>");
assert.strictEqual(N.renderMarkdown("1. a\n1. b"), "<ol><li>a</li><li>b</li></ol>");
{
  const p2 = { title: "合集", site: "bilibili", videoId: "BV1GJ411x7h7", url: "https://www.bilibili.com/video/BV1GJ411x7h7/?p=2&t=5", pageIndex: 2, pageCount: 3 };
  assert.strictEqual(N.buildAiConversationFilename(p2), "【AI笔记】合集 P2.md");
  assert.strictEqual(N.buildAiConversationFilename({ ...p2, pageIndex: 1 }), "【AI笔记】合集 P1.md", "P1 of a multi-P video is named too");
  assert.strictEqual(N.buildAiConversationFilename({ ...p2, pageIndex: 1, pageCount: 1 }), "【AI笔记】合集.md");
  const md = N.buildAiConversationMarkdown({ context: p2, turns: [], filename: "x.md" });
  assert.ok(md.includes('url: "https://www.bilibili.com/video/BV1GJ411x7h7/?p=2"'), "P2's url points at P2");
}
// Untrusted text (titles, UP names, comments, AI replies, tag names, paths) stays text: no tag of its own, no way out of
// a quoted attribute.
const XSS = ["<img src=x onerror=alert(1)>", `"'><script>alert(1)</script>`];
const assertInert = (html, where) => assert.ok(!/<img src=x|<script|"'>/i.test(html) && /&lt;|&#60;/.test(html), `${where}: ${html}`);
for (const bad of XSS) assertInert(N.renderMarkdown(`${bad}\n\n- **${bad}**\n\n\`${bad}\``), "renderMarkdown");
assert.ok(N.renderMarkdown("[x](javascript:alert(1))").includes('href="#"'), "only http, mailto and # links");
// 详情 › 笔记标签 shows the tags the note gets: none when the setting is cleared, plus the 分拣台 tags, from one function.
assert.deepStrictEqual([...N.noteTags({ userTags: ["学 习"] }, { tags: "" })], ["学_习"]);
assert.deepStrictEqual([...N.noteTags({}, { tags: "MoonDigest, a" })], ["MoonDigest", "a"]);
assert.ok(/tags: MdgNote\.noteTags\(/.test(fs.readFileSync(path.join(__dirname, "content.js"), "utf8")), "the popup payload's tags are the note's");
assert.ok(!/payload\.tags \|\| "MoonDigest"/.test(PS.text(PS.own("popup.html"))), "the popup shows no default of its own");
// ---- 2026-10-16 scan, group c7 ----
{
  const md = (meta, b, settings = baseSettings) => N.buildMarkdown(meta, b, settings, null, CREATED);
  const timed = [{ from: 1.001, to: 3, content: "一" }, { from: 65, to: 70, content: "二" }];
  // C186: the popup's subtitle box shows the TXT, not the note's `00:00` code spans.
  assert.strictEqual(N.buildSubtitlePreview(timed, { includeTimestampInBody: true }), "00:01 一\n01:05 二");
  // C187: 笔记标签 splits at a Chinese comma too.
  assert.deepStrictEqual([...N.noteTags({}, { tags: "学习，视频, AI" })], ["学习", "视频", "AI"]);
  // C188: without subtitles the note names only what follows.
  const bare = { ...bili, chapters: [], description: "", hotComments: [] };
  assert.ok(md(bare, []).includes("> 视频没有字幕。\n"), md(bare, []));
  assert.ok(md({ ...bare, description: "简介" }, []).includes("> 视频没有字幕，以下为简介。"));
  assert.ok(md({ ...bare, hotComments: comments }, []).includes("> 视频没有字幕，以下为热门评论。"));
  // C189: a <think> mentioned mid-answer keeps the rest; an answer still thinking shows nothing.
  assert.deepStrictEqual([N.stripThinkBlocks("用 <think> 标签包住推理，后面照常"), N.stripThinkBlocks("<think>还在想")], ["用 <think> 标签包住推理，后面照常", ""]);
  // C190, C195: every heading level moves down, capped at six; an answer's # sits under its ### question.
  assert.strictEqual(N.normalizeMarkdownForSectionPaste("## a\n#### b\n###### c"), "#### a\n###### b\n###### c");
  const deep = N.buildAiSection([{ prompt: "问", answer: N.buildConversationTurns([{ role: "user", content: "问" }, { role: "assistant", content: "# 大\n## 小" }])[0].answer }]);
  assert.ok(deep.includes("### 问：问\n\n#### 大\n##### 小"), deep);
  // C193: the empty-prompt heading is spelled like the section.
  assert.ok(N.buildAiSection([{ prompt: " ", answer: "x" }]).includes("### 问：AI 问答"));
  // C201: a comment's own lines stay inside its list item.
  assert.ok(md({ ...bili, hotComments: [{ uname: "甲", like: 1, message: "第一行\n- 不是列表\n\n# 不是标题" }] }, [], baseSettings).includes("1. 甲（赞 1）\n   第一行\n   - 不是列表\n\n   # 不是标题"));
  // C202: a key that YAML would read as a list item is left out.
  const props = (key) => md(bili, body, { ...baseSettings, fixedFrontmatterProperties: [{ key, type: "text", value: "5" }] });
  assert.deepStrictEqual([props("- 评分").includes("评分"), props("评分").includes('\n评分: "5"\n')], [false, true]);
  // C203: {{video_tags}}, offered beside the fields, has the video's tags.
  assert.ok(md(bili, body, { ...baseSettings, fixedFrontmatterProperties: [{ key: "标签", type: "list", value: "{{video_tags}}" }] }).includes('\n标签: ["科技", "AI"]\n'));
  // C204, C217: a folder drops what a file name drops, and never climbs out with . or ..
  assert.strictEqual(N.resolveFolderTemplate("../a/./{{author}}", { author: "UP#[1]^" }, CREATED), "a/UP 1");
  // R36: no folder or file starts with a dot (Obsidian skips it); a title of dots alone falls back to the id.
  assert.strictEqual(N.resolveFolderTemplate(".hidden/{{author}}/b", { author: ".x" }, CREATED), "hidden/x/b");
  assert.deepStrictEqual([N.buildNoteFilename({ title: ".NET 入门" }, { includeDateInFilename: false }), N.buildNoteFilename({ title: "...", videoId: "BV1" }, { includeDateInFilename: false })], ["NET 入门.md", "BV1.md"]);
  // R39: {{key}} reads the context's own keys only, in 自定属性, 正文附加段落 and folders alike.
  const proto = md(bili, body, { ...baseSettings, fixedFrontmatterProperties: [{ key: "x", type: "text", value: "a{{constructor}}b" }], notePlaceholderSections: [{ title: "段", position: "before_intro", content: "c{{toString}}d" }] });
  assert.ok(proto.includes('\nx: "ab"\n') && proto.includes("## 段\n\ncd\n") && !/function|native/.test(proto));
  assert.strictEqual(N.resolveFolderTemplate("A/{{constructor}}/B", {}, CREATED), "A/B");
  // R38: a 自定属性 named like a key the note writes itself (星标's starred, a field) is left out, not written twice.
  const starredProp = md({ ...bili, starred: true }, body, { ...baseSettings, fixedFrontmatterProperties: [{ key: "Starred", type: "checkbox", value: "false" }, { key: "video_tags", type: "text", value: "x" }] });
  assert.deepStrictEqual([starredProp.match(/^starred:/gim).length, /^video_tags: "x"/m.test(starredProp)], [1, false]);
  const pageProp = N.buildPageNote({ url: "https://a.b/c", title: "t", published: "2026-01-01" }, { fixedFrontmatterProperties: [{ key: "published", type: "text", value: "x" }] }, [], CREATED);
  assert.strictEqual(pageProp.match(/^published:/gm).length, 1);
  // C206, C207: subtitles before the first chapter open the section; two chapters starting together share no line.
  const chap = (chapters) => md({ ...bili, chapters }, [{ from: 0, to: 5, content: "开头" }, ...body.slice(2)]);
  const one = chap([{ from: 60, to: 0, title: "甲" }, { from: 60, to: 0, title: "乙" }, { from: 100, to: 0, title: "丙" }]);
  assert.ok(one.includes("## 字幕\n\n`00:00` 开头\n\n### 甲 `01:00`\n\n`01:05` 第一件事是\n\n### 丙 `01:40`\n\n`02:10` 最后总结一下") && !one.includes("其他片段"), one);
  // C210: SRT milliseconds are rounded, not floored.
  assert.strictEqual(N.formatTimestamp(1.001, true), "00:00:01,001");
  // C211: a blank title falls back to the video id.
  assert.strictEqual(N.buildNoteFilename({ title: " ", videoId: "BV9" }, { includeDateInFilename: false }), "BV9.md");
  // C212: other control characters become \xNN in YAML.
  assert.strictEqual(N.escapeYaml("a\u0007b"), "a\\x07b");
  // C213-C215: inline code blocks keep their text, #### is a heading, and code spans are left unformatted.
  assert.strictEqual(N.renderMarkdown("看 ```x = 1``` 这里"), "<p>看 <code>x = 1</code> 这里</p>");
  assert.strictEqual(N.renderMarkdown("#### 四级\n##### 五级"), "<h6>四级</h6><h6>五级</h6>");
  assert.strictEqual(N.renderMarkdown("`**a** [b](https://x)` **c**"), "<p><code>**a** [b](https://x)</code> <strong>c</strong></p>");
}
// A web page's note: its own frontmatter, the body Defuddle read, the AI 问答 between the markers; under {{site}} = 网页.
{
  const page = { url: "https://example.com/post", title: "一篇\"文章\"", author: "作者", published: "2026-01-02", pageMarkdown: "## 小标题\n\n正文", isVideoContext: false };
  const turns = N.buildConversationTurns([{ role: "user", content: "问" }, { role: "assistant", content: "答" }]);
  const note = N.buildPageNote(page, { tags: "clippings", includeAiChatInNote: true }, turns, CREATED);
  assert.strictEqual(note, [
    "---", 'title: "一篇\\"文章\\""', 'url: "https://example.com/post"', 'site: "example.com"', 'author: "作者"', 'published: "2026-01-02"', `created: "${CREATED}"`, 'tags: ["clippings"]', "---",
    "", "## 小标题", "", "正文", "", N.AI_SECTION_START, "## AI 问答", "", "### 问：问", "", "答", "", N.AI_SECTION_END, ""
  ].join("\n"));
  // The user's 自定属性 too, rendered as on a video note, their {{…}} from the page: {{site}} is 网页, as in the folder.
  const withOwn = N.buildPageNote(page, { tags: "", fixedFrontmatterProperties: [{ key: "来源", type: "text", value: "{{site}}" }, { key: "评分", type: "number", value: "4" }] }, [], CREATED);
  assert.ok(withOwn.startsWith('---\ntitle: "一篇\\"文章\\""') && withOwn.includes('tags: []\n来源: "网页"\n评分: 4\n---\n'), withOwn);
  // Turned off, no AI 问答; 只更新 AI 问答 (upsertAiSection) replaces only the marked block of one that has it.
  assert.ok(!N.buildPageNote(page, { includeAiChatInNote: false }, turns, CREATED).includes(N.AI_SECTION_START));
  assert.ok(N.buildPageNote({ ...page, userTags: ["读"], starred: true }, { tags: "clippings" }, [], CREATED).includes('\ntags: ["clippings", "读"]\nstarred: true\n'));
  assert.ok(N.upsertAiSection(note, N.buildAiSection(N.buildConversationTurns([{ role: "user", content: "新" }, { role: "assistant", content: "新答" }]))).includes("正文\n\n<!-- moondigest:ai-start -->\n## AI 问答\n\n### 问：新"));
  assert.strictEqual(N.videoNotePath(page, { noteFolder: "MoonDigest/{{site}}", includeDateInFilename: false }), "MoonDigest/网页/一篇_文章_.md");
  assert.strictEqual(N.buildNoteFilename(page, { includeDateInFilename: true }, CREATED), `${CREATED}-一篇_文章_.md`, "文件名带日期 applies to pages too");
  assert.strictEqual(N.videoNotePath({ site: "youtube", videoId: "v", title: "T" }, { noteFolder: "MoonDigest/{{site}}", includeDateInFilename: false }), "MoonDigest/youtube/T.md");
}
console.log("note selftest ok");
