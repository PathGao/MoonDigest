// node extension/triage/triage-bg.selftest.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const ctx = vm.createContext({ TextEncoder, URL, URLSearchParams, console, setTimeout, clearTimeout, AbortController });
// Browser order: background.js imports limits.js and sites.js before triage-bg.js.
for (const file of ["../limits.js", "../sites.js", "../note.js", "triage-bg.js"]) vm.runInContext(fs.readFileSync(path.join(__dirname, file), "utf8"), ctx);
const t = ctx;
const plain = (x) => JSON.parse(JSON.stringify(x));

// subtitle validation
const body = (to) => [{ from: 0, to: 1 }, { from: 1, to }];
assert.strictEqual(t.triageSubtitleValid(body(272.8), 273), true);
assert.strictEqual(t.triageSubtitleValid(body(283), 273), true);
assert.strictEqual(t.triageSubtitleValid(body(283.1), 273), false);
assert.strictEqual(t.triageSubtitleValid(body(136.5), 273), true);
assert.strictEqual(t.triageSubtitleValid(body(100), 273), false);
assert.strictEqual(t.triageSubtitleValid([], 273), false);
assert.strictEqual(t.triageSubtitleValid(null, 273), false);

// clip
assert.strictEqual(t.triageClip("a".repeat(12000)).length, 12000);
const clipped = t.triageClip("a".repeat(8000) + "b".repeat(5000) + "c".repeat(4000));
assert.strictEqual(clipped.length, 8000 + 2 + 4000);
assert.ok(clipped.startsWith("a".repeat(8000) + "……c"));

// The default scheme's tiers: ids keep/drop/unsure so results cached before schemes still resolve.
const DEF = [
  { id: "keep", name: "留", description: "有具体、可复用的知识", route: "keep" },
  { id: "drop", name: "可以删", description: "标题党", route: "unfav" },
  { id: "unsure", name: "待定", description: "其他", route: "deep" }
];

// LLM parse
const good = t.triageParseLlm('```json\n{"one_liner":"讲 X","points":["1","2","3"],"verdict":"keep","reason":"有方法"}\n```', [], true, DEF);
assert.deepStrictEqual(JSON.parse(JSON.stringify(good)), { oneLiner: "讲 X", points: ["1", "2", "3"], verdict: "keep", reason: "有方法", suggestedTags: [] });
const dirty = t.triageParseLlm('好的，结果如下：{"one_liner":"含 } 括号","points":["a","b","c","d"],"verdict":"DROP","reason":"r"} 以上', [], true, DEF);
assert.strictEqual(dirty.oneLiner, "含 } 括号");
assert.strictEqual(dirty.points.length, 3);
assert.strictEqual(dirty.verdict, "drop");
const thin = t.triageParseLlm('{"one_liner":"x","points":["only"],"verdict":"maybe"}', [], true, DEF);
assert.deepStrictEqual([...thin.points], ["only", "", ""]);
assert.strictEqual(thin.verdict, "unsure");
assert.strictEqual(thin.reason, "");
assert.strictEqual(t.triageParseLlm('{"one_liner":"x","verdict":"可以删"}', [], true, DEF).verdict, "drop", "the tier name maps to its id");
assert.throws(() => t.triageParseLlm('{"one_liner":"x","points":["a"'), /不完整/);
assert.throws(() => t.triageParseLlm("没有 JSON"), /不是 JSON/);
assert.throws(() => t.triageParseLlm('{"points":[]}'), /one_liner/);

// stage-2 tags
const tagList = ["AI", "编程", "理财"];
const withTags = t.triageParseLlm('{"one_liner":"x","points":["a","b","c"],"verdict":"keep","tags":["AI","不存在","新:数学","新:物理","编程","理财"]}', tagList, true, DEF);
assert.deepStrictEqual([...withTags.suggestedTags], ["AI", "新:数学", "编程"]);
assert.deepStrictEqual([...t.triageParseLlm('{"one_liner":"x","points":[]}', tagList).suggestedTags], []);

// tag coercion
assert.deepStrictEqual([...t.triageCoerceTags(["新：数学", "AI", "AI"], tagList, 2)], ["新:数学", "AI"]);
assert.deepStrictEqual([...t.triageCoerceTags(["新:", "乱写"], tagList, 2)], []);
// 只用我的标签: no 新: suggestions and no new-tag clause in the prompts.
assert.deepStrictEqual([...t.triageCoerceTags(["新:数学", "AI"], tagList, 2, false)], ["AI"]);
for (const p of [t.triageSystemPrompt(DEF), t.triageTitlePrompt(DEF), t.triageSystemPrompt(null), t.triageTitlePrompt(null)]) {
  assert.ok(p.includes("新:标签名") && !t.triageOwnTagsPrompt(p, true).includes("新:"), "own-only prompt drops the new-tag clause");
  assert.strictEqual(t.triageOwnTagsPrompt(p, false), p);
}

// title line
assert.strictEqual(
  t.triageTitleLine({ title: "a|b\nc", upper: "UP", duration: 125, intro: "简".repeat(80) }, 3),
  `3|a b c|UP|2:05|${"简".repeat(60)}`
);

// stage-1 title batch
const items = [{ bvid: "BV1" }, { bvid: "BV2" }, { bvid: "BV3" }];
const batch = JSON.parse(JSON.stringify(t.triageParseTitleBatch(
  '好的：\n```json\n[{"i":2,"verdict":"KEEP","reason":"教程 [实用]","tags":["编程","新:算法","新:数据结构","AI"],"confidence":"high"},' +
    '{"i":1,"verdict":"what","reason":"看不出","tags":["不存在"],"confidence":"medium"},{"i":9,"verdict":"drop"}]\n```',
  items,
  tagList,
  true,
  DEF
)));
assert.deepStrictEqual(batch.BV2, { verdict: "keep", reason: "教程 [实用]", suggestedTags: ["编程", "新:算法"], confidence: "high" });
assert.deepStrictEqual(batch.BV1, { verdict: "unsure", reason: "看不出", suggestedTags: [], confidence: "low" });
assert.deepStrictEqual(batch.BV3, { verdict: "unsure", reason: "AI 未返回", suggestedTags: [], confidence: "low" });
assert.throws(() => t.triageParseTitleBatch('[{"i":1,"verdict":"keep"', items, tagList, true, DEF), /不完整/);

// Custom tiers: the prompt lists them by name with descriptions; answers map to ids, unknown ones to the first 要细看 tier.
const CUSTOM = [
  { id: "t_must", name: "必看", description: "这周就要用", route: "keep" },
  { id: "t_later", name: "有空看", description: "", route: "keep" },
  { id: "t_ref", name: "参考", description: "查资料用", route: "keep" },
  { id: "t_del", name: "删", description: "过时或重复", route: "unfav" },
  { id: "t_again", name: "再看看", description: "拿不准", route: "deep" }
];
const scheme = { criteria: "只留 Rust 相关", tags: [{ name: "Rust", description: "讲 Rust" }], onlyMyTags: true, tiers: CUSTOM };
const titleSys = t.triageSchemeSystem(t.triageTitlePrompt(CUSTOM), scheme, "这次只看 2024 年以后的");
for (const part of ["- 必看：这周就要用", "- 有空看\n", "- 再看看：拿不准", '"verdict": "必看|有空看|参考|删|再看看"', "verdict 用「再看看」", "用户补充的判断标准：\n只留 Rust 相关", "本次临时补充（优先于上面的标准）：\n这次只看 2024 年以后的", "- Rust：讲 Rust", "不要新建标签"]) {
  assert.ok(titleSys.includes(part), part);
}
assert.ok(!/keep|drop|unsure|新:标签名/.test(titleSys), "no default tier words or new-tag clause leak into a custom scheme");
const custom = plain(t.triageParseTitleBatch('[{"i":1,"verdict":"有空看","confidence":"high"},{"i":2,"verdict":"留"},{"i":3,"verdict":"T_DEL"}]', items, [], true, CUSTOM));
assert.deepStrictEqual([custom.BV1.verdict, custom.BV2.verdict, custom.BV3.verdict], ["t_later", "t_again", "t_del"]);
assert.strictEqual(t.triageVerdict("乱写", CUSTOM.filter((x) => x.route !== "deep")), "", "no deep tier → no tier");
const msgs = t.triageBuildMessages({ title: "T", upper: "U", tags: [] }, "meta", "", scheme);
assert.ok(msgs[0].content.includes('"verdict": "必看|有空看|参考|删|再看看"') && msgs[0].content.includes("选「再看看」"));
assert.strictEqual(t.triageParseLlm('{"one_liner":"x","verdict":"必看"}', [], true, CUSTOM).verdict, "t_must");

// Grading off: prompts ask only for summary/tags, results carry no tier.
for (const p of [t.triageSystemPrompt(null), t.triageTitlePrompt(null)]) assert.ok(!/verdict|confidence|档/.test(p), p);
assert.ok(t.triageSystemPrompt(null).includes('"one_liner"') && t.triageTitlePrompt(null).includes('"reason"'));
assert.strictEqual(t.triageParseLlm('{"one_liner":"x","verdict":"keep"}', [], true, null).verdict, "");
assert.strictEqual(plain(t.triageParseTitleBatch('[{"i":1,"reason":"讲 Rust","tags":[]}]', items, [], true, null)).BV1.verdict, "");

// form
assert.strictEqual(t.triageForm({ resources: "1:2,3:2", csrf: "x y", privacy: 1 }), "resources=1%3A2%2C3%3A2&csrf=x+y&privacy=1");

// output limits: custom wins, else auto by thinking
const off = { triageThinking: false, triageTitleMaxTokens: 0, triageAnalyzeMaxTokens: 0 };
const on = { ...off, triageThinking: true };
assert.strictEqual(t.triageMaxTokens("title", 30, off), 2000);
assert.strictEqual(t.triageMaxTokens("title", 30, on), 8500);
assert.strictEqual(t.triageMaxTokens("analyze", 1, off), 1000);
assert.strictEqual(t.triageMaxTokens("analyze", 1, on), 8000);
assert.strictEqual(t.triageMaxTokens("title", 30, { ...on, triageTitleMaxTokens: 5000 }), 5000);
assert.strictEqual(t.triageMaxTokens("analyze", 1, { ...off, triageAnalyzeMaxTokens: 2500.7 }), 2500);

assert.strictEqual(t.triageMaxTokens("command", 30, off), 2800);
assert.strictEqual(t.triageMaxTokens("command", 30, on), 9400);
assert.strictEqual(t.triageMaxTokens("command", 30, { ...off, triageTitleMaxTokens: 5000 }), 5000);


// tags with descriptions: names, rendering, coercion by name
assert.deepStrictEqual(plain(t.triageTagNames(["AI", { name: " 编程 ", description: "写代码" }, { name: "" }, null])), ["AI", "编程"]);
assert.strictEqual(t.triageTagListText([]), "可选标签：（无）");
const rendered = t.triageTagListText([{ name: "AI", description: "讲大模型的" }, { name: "编程", description: "" }, "理财"]);
assert.ok(rendered.endsWith("\n- AI：讲大模型的\n- 编程\n- 理财"), rendered);
assert.ok(rendered.includes("说明是用户规定"));
assert.deepStrictEqual(plain(t.triageCoerceTags(["AI", "编程"], [{ name: "AI", description: "x" }], 3)), ["AI"]);
assert.strictEqual(t.triageCleanTagName(" 一二三四五六七八九十甲乙丙 "), "一二三四五六七八九十甲乙");
assert.strictEqual(t.triageCleanTagName("a，b、c,d"), "abcd");

// command line + messages
assert.strictEqual(
  t.triageCommandLine({ title: "T|x", upper: "U", duration: 61, currentTags: ["AI", "编程"], oneLiner: "一句", points: ["p1", "p2", "p3"] }, 2),
  "2|T x|U|1:01|AI、编程|一句|p1；p2；p3"
);
assert.strictEqual(t.triageCommandLine({ title: "T" }, 1), "1|T|||||");
const cmdMsgs = t.triageBuildCommandMessages({
  instruction: "把讲 AI 的都标上",
  tags: [{ name: "AI", description: "讲大模型" }],
  items: [{ bvid: "BV1", title: "T" }],
  allowNewTags: false,
  maxNewTags: 5,
  allowVerdict: false
});
assert.ok(cmdMsgs[0].content.includes("new_tags 必须是 []"));
assert.ok(cmdMsgs[0].content.includes("- AI：讲大模型"));
assert.ok(!cmdMsgs[0].content.includes('"verdict"'));
assert.ok(cmdMsgs[1].content.includes("<<<指令>>>\n把讲 AI 的都标上\n<<<指令结束>>>"));
assert.ok(cmdMsgs[1].content.endsWith("\n1|T|||||"));

// command parse
const cmdItems = [
  { bvid: "BV1", currentTags: ["AI", "旧"] },
  { bvid: "BV2", currentTags: [] },
  { bvid: "BV3" },
  { bvid: "BV4", currentTags: ["编程"] }
];
const cmdTags = [{ name: "AI", description: "" }, "编程", "旧"];
const cmdOut =
  '好的，提案如下：\n```json\n{"new_tags":[{"name":" 数学 ","description":"讲数学的"},{"name":"AI"},{"name":"物理,力学","description":"d"},{"name":"数学"},{"name":"化学"}],' +
  '"items":[{"i":2,"add":["数学","不存在","编程","编程"],"remove":["AI"],"verdict":"KEEP","reason":"讲 {数学}"},' +
  '{"i":1,"add":["AI","物理力学"],"remove":["旧","不在"],"verdict":"drop","reason":"r1"},' +
  '{"i":3,"add":["化学"],"remove":[]},{"i":4,"add":[],"remove":[],"reason":"无"},{"i":9,"add":["AI"]},{"i":2,"add":["旧"]}],"note":"已打标签"}\n``` 以上';
assert.deepStrictEqual(plain(t.triageParseCommand(cmdOut, cmdItems, cmdTags, { allowNewTags: true, maxNewTags: 2, allowVerdict: true, tiers: DEF })), {
  newTags: [{ name: "数学", description: "讲数学的" }, { name: "物理力学", description: "d" }],
  assignments: {
    BV2: { add: ["数学", "编程"], remove: [], verdict: "keep", reason: "讲 {数学}" },
    BV1: { add: ["物理力学"], remove: ["旧"], verdict: "drop", reason: "r1" }
  },
  note: "已打标签"
});
const noNew = {
  newTags: [],
  assignments: {
    BV2: { add: ["编程"], remove: [], reason: "讲 {数学}" },
    BV1: { add: [], remove: ["旧"], reason: "r1" }
  },
  note: "已打标签"
};
assert.deepStrictEqual(plain(t.triageParseCommand(cmdOut, cmdItems, cmdTags, { allowNewTags: false, maxNewTags: 5, allowVerdict: false })), noNew);
assert.deepStrictEqual(plain(t.triageParseCommand(cmdOut, cmdItems, cmdTags, { allowNewTags: true, maxNewTags: 0, allowVerdict: false })), noNew);
assert.deepStrictEqual(plain(t.triageParseCommand('{"items":[]}', cmdItems, cmdTags, {})), { newTags: [], assignments: {}, note: "" });
assert.throws(() => t.triageParseCommand("抱歉，没法处理", cmdItems, cmdTags, {}), /不是 JSON/);
// Command verdicts use the scheme's tier names; an unknown one is dropped, not guessed.
const cmdCustom = plain(t.triageParseCommand('{"items":[{"i":1,"verdict":"必看"},{"i":2,"verdict":"keep","add":["编程"]}]}', cmdItems, cmdTags, { allowVerdict: true, tiers: CUSTOM }));
assert.deepStrictEqual([cmdCustom.assignments.BV1.verdict, cmdCustom.assignments.BV2.verdict], ["t_must", undefined]);
const cmdTierMsgs = t.triageBuildCommandMessages({ instruction: "x", tags: [], items: [{ bvid: "BV1", title: "T" }], allowNewTags: true, maxNewTags: 5, allowVerdict: true, tiers: CUSTOM });
assert.ok(cmdTierMsgs[0].content.includes("- 必看：这周就要用") && cmdTierMsgs[0].content.includes('"verdict": "必看|'));
assert.ok(!t.triageBuildCommandMessages({ instruction: "x", tags: [], items: [], allowVerdict: true, tiers: null })[0].content.includes('"verdict"'), "grading off never asks for a tier");
assert.throws(() => t.triageParseCommand('{"new_tags":[', cmdItems, cmdTags, {}), /不完整/);


(async () => {
  // AI HTTP 429 is its own throttle code; other HTTP errors carry none.
  t.loadAiProviders = async () => [{ id: "p", baseUrl: "https://ai.test", model: "m" }];
  t.loadAiProviderKeys = async () => ({});
  t.fetch = async () => ({ ok: false, status: 429, text: async () => "slow down" });
  await assert.rejects(t.triageChat([], 100), (e) => e.code === "AI_THROTTLED");
  t.fetch = async () => ({ ok: false, status: 500, text: async () => "" });
  await assert.rejects(t.triageChat([], 100), (e) => e.code === undefined);

  // A request that never settles, even on abort, still ends with the retryable timeout code.
  vm.runInContext("TRIAGE_AI_TIMEOUT_MS.normal = 30; TRIAGE_AI_TIMEOUT_MS.thinking = 60;", ctx);
  let aborted = false;
  t.fetch = (url, { signal }) => {
    signal.addEventListener("abort", () => (aborted = true));
    return new Promise(() => {});
  };
  await assert.rejects(t.triageChat([], 100), (e) => e.code === "AI_TIMEOUT" && e.message === "AI 超时（0.03 秒），已跳过，可重试");
  assert.strictEqual(aborted, true);
  const started = Date.now();
  await assert.rejects(t.triageChat([], 100, true), (e) => e.code === "AI_TIMEOUT");
  assert.ok(Date.now() - started >= 55, "thinking uses the longer timeout");

  // Interval 0 is a valid user choice; only invalid values fall back to the default.
  const settingsWith = async (stored) => {
    t.chrome = { storage: { sync: { get: async (d) => ({ ...d, ...stored }) } } };
    return (await vm.runInContext("TRIAGE_HANDLERS", ctx)["triage-settings-get"]()).triageIntervalSec;
  };
  assert.strictEqual(await settingsWith({ triageIntervalSec: 0 }), 0);
  assert.strictEqual(await settingsWith({ triageIntervalSec: 5 }), 5);
  assert.strictEqual(await settingsWith({ triageIntervalSec: -1 }), 8);
  assert.strictEqual(await settingsWith({ triageIntervalSec: "x" }), 8);
  assert.strictEqual(await settingsWith({}), 8);

  // B站 risk control maps to THROTTLED on writes as well as reads; non-JSON answers get a clear error.
  t.chrome = { cookies: { get: async () => ({ value: "csrf" }) } };
  const jsonRes = (body) => async () => ({ ok: true, status: 200, json: async () => body });
  t.fetch = jsonRes({ code: -352, message: "风控" });
  await assert.rejects(t.triageBiliPost("/x", {}), (e) => e.code === "THROTTLED");
  t.fetch = jsonRes({ code: -412, message: "请求被拦截" });
  await assert.rejects(t.triageBiliGet("https://api.test"), (e) => e.code === "THROTTLED");
  t.fetch = async () => ({ ok: false, status: 412, json: async () => ({}) });
  await assert.rejects(t.triageBiliPost("/x", {}), (e) => e.code === "THROTTLED");
  t.fetch = jsonRes({ code: 11010, message: "内容不存在" });
  await assert.rejects(t.triageBiliPost("/x", {}), (e) => e.code === undefined);
  t.fetch = async () => ({ ok: true, status: 200, json: async () => JSON.parse("<html>") });
  await assert.rejects(t.triageNav(), /不是 JSON/);
  t.fetch = async () => ({ ok: false, status: 502, json: async () => ({}) });
  await assert.rejects(t.triageNav(), /HTTP 502/);

  // A folder load that fails after page 1 keeps the fetched items and says so; a page-1 failure still throws.
  const media = (n) => ({ type: 2, bvid: `BV${n}`, id: n, title: `t${n}`, attr: 0 });
  const folderItems = vm.runInContext("TRIAGE_HANDLERS", ctx)["triage-folder-items"];
  t.fetch = async (url) => {
    const pn = Number(new URL(url).searchParams.get("pn"));
    return pn === 1 ? jsonRes({ code: 0, data: { medias: [media(1), media(2)], has_more: true } })() : jsonRes({ code: -352, message: "风控" })();
  };
  const partial = await folderItems({ mediaId: 1 });
  assert.deepStrictEqual([...partial.items.map((it) => it.bvid)], ["BV1", "BV2"]);
  assert.strictEqual(partial.partial.page, 2);
  assert.match(partial.partial.error, /-352/);
  t.fetch = jsonRes({ code: -352, message: "风控" });
  await assert.rejects(folderItems({ mediaId: 1 }), (e) => e.code === "THROTTLED");
  t.fetch = jsonRes({ code: 0, data: { medias: [media(3)], has_more: false } });
  assert.strictEqual((await folderItems({ mediaId: 1 })).partial, undefined);

  // Analysis reads B站 through sites.js and shares the video page's subtitle cache.
  const store = {};
  t.chrome = {
    storage: {
      sync: { get: async (d) => d },
      local: {
        get: async (key) => (key === null ? { ...store } : Object.fromEntries([].concat(key).filter((k) => k in store).map((k) => [k, store[k]]))),
        set: async (items) => Object.assign(store, items),
        remove: async (keys) => [].concat(keys).forEach((k) => delete store[k])
      }
    }
  };
  let prompt = "";
  t.fetch = async (url, { body }) => {
    prompt = JSON.parse(body).messages[1].content;
    return { ok: true, json: async () => ({ choices: [{ message: { content: '{"one_liner":"x","points":["a"],"verdict":"keep","reason":"r"}' } }] }) };
  };
  const subUrl = "https://aisubtitle.hdslb.com/bfs/ai_subtitle/BVa.json";
  const subtitleKey = "boc_subtitle_cache_BVa_11_id_5";
  const subtitleRaw = (to) => ({ body: [{ from: 0, to: 1, content: "第一句" }, { from: 1, to, content: "最后一句" }] });
  let routes;
  const calls = [];
  t.fetchJsonForAi = async (url) => {
    calls.push(url);
    const hit = Object.keys(routes).find((part) => url.includes(part));
    const answer = routes[hit];
    if (answer instanceof Error) throw answer;
    return answer;
  };
  const withTracks = { code: 0, data: { subtitle: { subtitles: [{ id: 5, lan: "ai-zh", lan_doc: "中文", subtitle_url: subUrl }] } } };
  const baseRoutes = () => ({
    "/view/detail": { code: 0, data: { View: { title: "标题", desc: "简介", tname: "知识", aid: 22, cid: 11, duration: 273, owner: { name: "UP" }, pages: [{ cid: 11, page: 1, duration: 273 }] }, Tags: [{ tag_name: "标签" }] } },
    "/nav": { code: -101, data: { wbi_img: { img_url: "https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png", sub_url: "https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png" } } },
    "/x/player/wbi/v2": withTracks,
    [subUrl]: subtitleRaw(272),
    "/reply/main": { code: 0, data: { replies: [{ content: { message: "评论一" } }] } }
  });
  const analyze = () => t.triageAnalyze({ bvid: "BVa", force: true, scheme: { tags: [], tiers: DEF } });

  // A subtitle the video page cached is used without fetching it again.
  routes = baseRoutes();
  store[subtitleKey] = { raw: subtitleRaw(270), timestamp: Date.now() };
  assert.strictEqual((await analyze()).source, "subtitle");
  assert.ok(!calls.includes(subUrl), "cached subtitle is not refetched");
  assert.ok(prompt.includes("分区：知识") && prompt.includes("标签：标签") && prompt.includes("最后一句"));

  // A fetched subtitle that passes the duration guard is cached for the video page.
  delete store[subtitleKey];
  assert.strictEqual((await analyze()).source, "subtitle");
  assert.deepStrictEqual(store[subtitleKey].raw, subtitleRaw(272));

  // Another video's subtitle (ends far too early) falls back to comments and is not cached.
  delete store[subtitleKey];
  routes = { ...baseRoutes(), [subUrl]: subtitleRaw(100) };
  assert.strictEqual((await analyze()).source, "meta");
  assert.strictEqual(subtitleKey in store, false);
  assert.ok(prompt.includes("1. 评论一"));

  // Risk control still reaches the page as THROTTLED: player answers without subtitles, HTTP 412, -352.
  routes = { ...baseRoutes(), "/x/player/wbi/v2": { code: 0, data: {} }, "/x/player/v2": { code: 0, data: {} } };
  await assert.rejects(analyze(), (e) => e.code === "THROTTLED");
  const http412 = Object.assign(new Error("HTTP 412"), { status: 412 });
  routes = { ...baseRoutes(), "/view/detail": http412, "/view": http412 };
  await assert.rejects(analyze(), (e) => e.code === "THROTTLED");
  routes = { ...baseRoutes(), "/x/player/wbi/v2": { code: -352, message: "风控" }, "/x/player/v2": { code: -352, message: "风控" } };
  await assert.rejects(analyze(), (e) => e.code === "THROTTLED");
  // A throttled wbi/v2 is not turned into "no subtitles" by an empty player/v2 answer, so nothing is cached.
  const noTracks = { code: 0, data: { subtitle: { subtitles: [] } } };
  delete store.triage_analysis_BVa;
  routes = { ...baseRoutes(), "/x/player/wbi/v2": { code: -352, message: "风控" }, "/x/player/v2": noTracks };
  await assert.rejects(analyze(), (e) => e.code === "THROTTLED");
  assert.strictEqual("triage_analysis_BVa" in store, false);
  // A 412 on the subtitle file itself is throttling too; any other subtitle failure still falls back to comments.
  delete store[subtitleKey];
  routes = { ...baseRoutes(), [subUrl]: http412 };
  await assert.rejects(analyze(), (e) => e.code === "THROTTLED");
  assert.strictEqual("triage_analysis_BVa" in store, false);
  routes = { ...baseRoutes(), [subUrl]: new Error("network") };
  assert.strictEqual((await analyze()).source, "meta");

  // Notes: throttling or a failed subtitle fetch writes nothing; another video's subtitle is dropped, not cached.
  const buildNote = () => t.triageBuildNote("BVa", {});
  routes = { ...baseRoutes(), "/x/player/wbi/v2": { code: -352, message: "风控" }, "/x/player/v2": { code: -352, message: "风控" } };
  await assert.rejects(buildNote(), (e) => e.code === "THROTTLED");
  routes = { ...baseRoutes(), [subUrl]: new Error("network") };
  await assert.rejects(buildNote(), /network/);
  routes = { ...baseRoutes(), [subUrl]: subtitleRaw(100) };
  assert.strictEqual((await buildNote()).body.length, 0);
  assert.strictEqual(subtitleKey in store, false);
  routes = { ...baseRoutes(), "/x/player/wbi/v2": noTracks };
  assert.strictEqual((await buildNote()).body.length, 0);
  routes = baseRoutes();
  assert.strictEqual((await buildNote()).body.length, 2);

  // The note section comes from triage_notes (per video), not from the basket item.
  store.triage_basket = [{ bvid: "BVa", note: "篮子里的旧笔记" }];
  store.triage_notes = { BVa: { text: "视频笔记", updatedAt: 1 } };
  const noted = (await buildNote()).markdown;
  assert.ok(noted.includes("## 我的笔记\n\n视频笔记") && !noted.includes("篮子里的旧笔记"));

  // Migration: copies non-empty basket notes, never overwrites, keeps the basket, runs once.
  for (const k of Object.keys(store)) delete store[k];
  store.triage_basket = [{ bvid: "BV1", note: "旧1" }, { bvid: "BV2", note: "旧2" }, { bvid: "BV3", note: "  " }, { bvid: "BV4" }];
  store.triage_notes = { BV2: { text: "已有", updatedAt: 5 } };
  await t.triageMigrateNotes();
  assert.deepStrictEqual(Object.keys(store.triage_notes).sort(), ["BV1", "BV2"]);
  assert.strictEqual(store.triage_notes.BV1.text, "旧1");
  assert.deepStrictEqual(store.triage_notes.BV2, { text: "已有", updatedAt: 5 });
  assert.strictEqual(store.triage_basket[0].note, "旧1");
  assert.strictEqual(store.triage_notes_migrated, true);
  store.triage_basket.push({ bvid: "BV5", note: "后加" });
  delete store.triage_notes.BV1;
  await t.triageMigrateNotes();
  assert.deepStrictEqual(Object.keys(store.triage_notes), ["BV2"], "second run is a no-op");

console.log("triage-bg selftest: all passed");
})();
