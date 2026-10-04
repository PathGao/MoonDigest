// node extension/note.selftest.js
// Goldens were captured from content.js buildMarkdown before it moved here (commit 45df77d);
// a diff means the note format changed, which every existing vault note would notice.
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const ctx = vm.createContext({ URL, URLSearchParams, console });
vm.runInContext(fs.readFileSync(path.join(__dirname, "sites.js"), "utf8"), ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, "note.js"), "utf8"), ctx);
const N = ctx.BocNote;
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
  const site = ctx.BocSites.SITES[meta.site];
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
      "## 评论",
      "",
      "1. 观众A（赞 120）",
      "讲得很清楚",
      "",
      "2. 匿名（赞 3）",
      "mark"
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
      "> 本视频无字幕，以下为简介与热门评论。",
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
      "## 评论",
      "",
      "1. 观众A（赞 120）",
      "讲得很清楚",
      "",
      "2. 匿名（赞 3）",
      "mark"
    ]
  }
};

for (const [name, c] of Object.entries(cases)) {
  const md = N.buildMarkdown(c.meta, c.body, c.settings, refOf(c.meta), CREATED);
  assert.strictEqual(md, golden[name].md.join("\n"), name + " markdown");
  assert.strictEqual(N.buildNoteFilename(c.meta, c.settings, CREATED), golden[name].file, name + " filename");
  assert.strictEqual(N.resolveFolderTemplate(c.settings.noteFolder, c.meta, CREATED), golden[name].folder, name + " folder");
}
assert.strictEqual(N.buildNoteFilename(cases.biliSingle.meta, { includeDateInFilename: false }, CREATED), "测试视频：引号_与反斜杠_.md");
assert.strictEqual(N.buildMarkdown(cases.biliSingle.meta, body, baseSettings, null, CREATED).includes('\nurl: "'), false, "no ref means no url");
{
  const c = cases.noSubtitle;
  const md = N.buildMarkdown({ ...c.meta, subtitleFailure: "字幕接口限流（429），稍后再试" }, c.body, c.settings, refOf(c.meta), CREATED);
  assert.ok(md.includes("> 字幕抓取失败（字幕接口限流（429），稍后再试），以下为简介与热门评论。"), "failed fetch is not reported as no subtitles");
  assert.ok(!md.includes("本视频无字幕"), "failed fetch drops the no-subtitle line");
}
assert.strictEqual(N.formatCompactTimestamp(3661, true), "01:01:01");
assert.strictEqual(N.formatCompactTimestamp(3661, false), "61:01");
assert.strictEqual(N.formatTimestamp(1.5, true), "00:00:01,500");
assert.strictEqual(N.buildSrt(body.slice(0, 1)), "1\n00:00:00,000 --> 00:00:04,500\n大家好，欢迎来到本期视频");
assert.strictEqual(N.buildTxt(body.slice(0, 2), { includeTimestampInBody: true }), "00:00 大家好，欢迎来到本期视频\n00:04 今天讲三件事");
// A newline inside a double-quoted YAML value must stay escaped or the frontmatter breaks.
assert.strictEqual(N.escapeYaml('a"b\\c\nd\r\te'), 'a\\"b\\\\c\\nd\\r\\te');
assert.strictEqual(N.sanitizeFileName("第1集 #AI [合集] ^x|y"), "第1集 _AI _合集_ _x_y");

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
  "#### 要点",
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

// pickConversation: exact part first, then the video without a part; newest wins; other videos never match.
const conv = (contextKey, updatedAt) => ({ contextKey, updatedAt, messages });
const convs = [conv("video:bilibili:BV1|", 1), conv("video:bilibili:BV1|c2", 5), conv("video:bilibili:BV1|c1", 3), conv("video:youtube:BV1|", 9)];
assert.strictEqual(N.pickConversation(convs, { site: "bilibili", videoId: "BV1", cid: "c1" }).updatedAt, 3);
assert.strictEqual(N.pickConversation(convs, { site: "bilibili", videoId: "BV1", cid: "c9" }).updatedAt, 1, "unknown part falls back to the partless conversation");
assert.strictEqual(N.pickConversation(convs, { site: "bilibili", videoId: "BV1" }).updatedAt, 5, "no part → newest of any part");
assert.strictEqual(N.pickConversation(convs, { site: "bilibili", videoId: "BV2" }), null);
assert.strictEqual(N.pickConversation(convs, { site: "youtube", videoId: "" }), null);
// AI conversation note (side panel 保存对话 / history page): moved out of sidepanel.js byte for byte.
const aiContext = { title: "视频]标题", url: "https://www.bilibili.com/video/BV1GJ411x7h7/?p=2", site: "bilibili", videoId: "BV1GJ411x7h7", author: "UP主" };
const aiFile = N.buildAiConversationFilename(aiContext);
assert.strictEqual(aiFile, "【AI笔记】视频_标题.md");
assert.strictEqual(
  N.buildAiConversationMarkdown({ context: aiContext, turns: [{ prompt: "# 问一", answer: "答一" }, { prompt: "问二", answer: "答二" }], filename: aiFile, sourcePath: "Clip/视频.md" }),
  `---\ntitle: "【AI笔记】视频_标题"\nsource_title: "视频]标题"\nsource: "[[Clip/视频]]"\nurl: "https://www.bilibili.com/video/BV1GJ411x7h7/"\nauthor: "UP主"\ncreated: "${N.formatLocalDate()}"\ntags: [ai_note]\n---\n\n来源：[[Clip/视频|视频\\]标题]]\n\n## 问一\n\n答一\n\n## 问二\n\n答二\n`
);
assert.ok(N.buildAiConversationMarkdown({ context: {}, turns: [], filename: "x.md" }).includes("来源：当前视频"), "no source path → no dangling link");
// Triage summary block (triage notes and history-page notes)
const front = "---\ntitle: \"x\"\n---\n\n![cover](u)\n\n## 简介\n\nhi";
const done = { status: "done", oneLiner: "一句话", points: ["a", "b"], verdict: "keep", reason: "有用" };
assert.strictEqual(
  N.withTriageSummary(front, done),
  "---\ntitle: \"x\"\n---\n\n## AI 总结\n\n> 一句话\n\n- a\n- b\n\nAI 分类：值得留，有用\n\n![cover](u)\n\n## 简介\n\nhi"
);
assert.strictEqual(N.withTriageSummary("## 简介\n\nhi", { status: "done", verdict: "drop" }), "## AI 总结\n\nAI 分类：可清理\n\n## 简介\n\nhi");
assert.strictEqual(N.withTriageSummary(front, { status: "error" }), front);
assert.strictEqual(N.withTriageSummary(front, undefined), front);
assert.strictEqual(N.withTriageSummary("## 简介", { status: "done", verdict: "drop" }, " 我的话 "), "## AI 总结\n\nAI 分类：可清理\n\n## 我的备注\n\n我的话\n\n## 简介");
assert.strictEqual(N.withTriageSummary(front, undefined, "n"), "---\ntitle: \"x\"\n---\n\n## 我的备注\n\nn\n\n![cover](u)\n\n## 简介\n\nhi");
assert.strictEqual(N.withTriageSummary(front, undefined, "  "), front);
assert.strictEqual(N.buildTriageSummary({ status: "done", verdict: "unsure", reason: "核心" }), "AI 分类：拿不准，核心");

assert.strictEqual(N.buildTriageSummary({ status: "done", oneLiner: "一句话", points: ["a", "", ""] }), "> 一句话\n\n- a", "padded empty points are dropped");
assert.strictEqual(
  N.renderMarkdown("<think>x</think>## 标题\n\n**粗** <b>\n\n- a\n- b"),
  "<h4>标题</h4><p><strong>粗</strong> &lt;b&gt;</p><ul><li>a</li><li>b</li></ul>",
  "markdown renders, raw HTML is escaped, think is stripped"
);
{
  const p2 = { title: "合集", site: "bilibili", videoId: "BV1GJ411x7h7", url: "https://www.bilibili.com/video/BV1GJ411x7h7/?p=2&t=5", pageIndex: 2, pageCount: 3 };
  assert.strictEqual(N.buildAiConversationFilename(p2), "【AI笔记】合集 P2.md");
  assert.strictEqual(N.buildAiConversationFilename({ ...p2, pageIndex: 1 }), "【AI笔记】合集 P1.md", "P1 of a multi-P video is named too");
  assert.strictEqual(N.buildAiConversationFilename({ ...p2, pageIndex: 1, pageCount: 1 }), "【AI笔记】合集.md");
  const md = N.buildAiConversationMarkdown({ context: p2, turns: [], filename: "x.md" });
  assert.ok(md.includes('url: "https://www.bilibili.com/video/BV1GJ411x7h7/?p=2"'), "P2's url points at P2");
}
console.log("note selftest ok");
