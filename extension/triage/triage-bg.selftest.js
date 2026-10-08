// node extension/triage/triage-bg.selftest.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const ctx = vm.createContext({ TextEncoder, URL, URLSearchParams, console, setTimeout, clearTimeout, AbortController });
// Browser order: background.js imports limits.js and sites.js before triage-bg.js.
for (const file of ["../limits.js", "../sites.js", "../note.js", "triage-bg.js"]) vm.runInContext(fs.readFileSync(path.join(__dirname, file), "utf8"), ctx);
// background.js owns supportsThinkingToggle; lift just that function.
const bg = fs.readFileSync(path.join(__dirname, "../background.js"), "utf8");
const at = bg.indexOf("function supportsThinkingToggle(");
vm.runInContext(bg.slice(at, bg.indexOf("\n}\n", at) + 2), ctx);
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


// LLM parse: fixed three classes; ids in any case or the Chinese names; anything else is unsure.
const good = t.triageParseLlm('```json\n{"one_liner":"讲 X","points":["1","2","3"],"verdict":"keep","reason":"有方法","tags":["AI"]}\n```');
assert.deepStrictEqual(plain(good), { oneLiner: "讲 X", points: ["1", "2", "3"], verdict: "keep", reason: "有方法" }, "tags in the answer are ignored");
const dirty = t.triageParseLlm('好的，结果如下：{"one_liner":"含 } 括号","points":["a","b","c","d"],"verdict":"DROP","reason":"r"} 以上');
assert.strictEqual(dirty.oneLiner, "含 } 括号");
assert.strictEqual(dirty.points.length, 3);
assert.strictEqual(dirty.verdict, "drop");
const thin = t.triageParseLlm('{"one_liner":"x","points":["only"],"verdict":"maybe"}');
assert.deepStrictEqual([...thin.points], ["only", "", ""]);
assert.strictEqual(thin.verdict, "unsure");
assert.strictEqual(thin.reason, "");
assert.strictEqual(t.triageParseLlm('{"one_liner":"x","verdict":"可清理"}').verdict, "drop", "the Chinese name maps to its id");
assert.strictEqual(t.triageParseLlm('{"one_liner":"x","verdict":"可以删"}').verdict, "drop", "the old name still maps");
assert.strictEqual(t.triageParseLlm('{"one_liner":"x"}').verdict, "unsure");
assert.throws(() => t.triageParseLlm('{"one_liner":"x","points":["a"'), /回复不完整/);
assert.throws(() => t.triageParseLlm("没有 JSON"), /格式不对/);
assert.throws(() => t.triageParseLlm('{"points":[]}'), /缺少总结/);

// title line
assert.strictEqual(
  t.triageTitleLine({ title: "a|b\nc", upper: "UP", duration: 125, pubdate: new Date(2024, 4, 30, 12).getTime() / 1000, intro: "简".repeat(150) }, 3),
  `3|a b c|UP|2:05|2024-05-30|${"简".repeat(120)}`
);
assert.strictEqual(t.triageTitleLine({ title: "T", upper: "U", duration: 0, intro: "" }, 1), "1|T|U|0:00||", "no publish date leaves its field empty");

// stage-1 title batch
const items = [{ bvid: "BV1" }, { bvid: "BV2" }, { bvid: "BV3" }];
const batch = plain(t.triageParseTitleBatch(
  '好的：\n```json\n[{"i":2,"verdict":"KEEP","reason":"教程 [实用]","tags":["编程"],"confidence":"high"},' +
    '{"i":1,"verdict":"what","reason":"看不出","confidence":"medium"},{"i":9,"verdict":"drop"}]\n```',
  items
));
assert.deepStrictEqual(batch.BV2, { verdict: "keep", reason: "教程 [实用]", confidence: "high" });
assert.deepStrictEqual(batch.BV1, { verdict: "unsure", reason: "看不出", confidence: "low" });
assert.deepStrictEqual(batch.BV3, { verdict: "unsure", reason: "AI 未返回", confidence: "low" });
assert.throws(() => t.triageParseTitleBatch('[{"i":1,"verdict":"keep"', items), /回复不完整/);

const TITLE_PROMPT = vm.runInContext("TRIAGE_TITLE_PROMPT", ctx);
// Prompts: the three classes, the folder's 判断标准 when set, and no tag lists.
const titleSys = t.triageWithCriteria(TITLE_PROMPT, " 只留 Rust 相关 ");
for (const part of ["- keep：值得留。", "- drop：可清理。", "- unsure：拿不准。", '"verdict": "keep|drop|unsure"', "verdict 用 unsure", "用户的判断标准（优先于上面的说明）：\n只留 Rust 相关"]) {
  assert.ok(titleSys.includes(part), part);
}
assert.strictEqual(t.triageWithCriteria(TITLE_PROMPT, "  "), TITLE_PROMPT, "no criteria, no block");
assert.ok(!TITLE_PROMPT.includes("纯娱乐"), "entertainment is not a reason to clean up by default");
// The folder name tells the AI what the folder is for; without criteria it is asked to infer the purpose.
const named = t.triageWithCriteria(TITLE_PROMPT, "", { title: "纯娱乐", intro: "下饭" });
assert.ok(named.includes("这个收藏夹叫「纯娱乐」，简介：下饭。") && named.includes("推测它的用途"));
const both = t.triageWithCriteria(TITLE_PROMPT, "只留段子", { title: "纯娱乐" });
assert.ok(both.includes("这个收藏夹叫「纯娱乐」。") && !both.includes("推测") && both.endsWith("只留段子"));
const msgs = t.triageBuildMessages({ title: "T", upper: "U", tags: [] }, "", "", "只留干货");
assert.ok(msgs[0].content.includes('"verdict": "keep|drop|unsure"') && msgs[0].content.endsWith("只留干货"));
for (const p of [TITLE_PROMPT, msgs[0].content]) assert.ok(!/标签|tags|新:/.test(p), "粗分/细看 prompts carry no tags");

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


// tag names
assert.deepStrictEqual(plain(t.triageTagNames(["AI", " 编程 ", "", null])), ["AI", "编程"]);
assert.strictEqual(t.triageCleanTagName(" 一二三四五六七八九十甲乙丙 "), "一二三四五六七八九十甲乙");
assert.strictEqual(t.triageCleanTagName("a，b、c,d"), "abcd");

// command line + messages
assert.strictEqual(
  t.triageCommandLine({ title: "T|x", upper: "U", duration: 61, currentTags: ["AI", "编程"], oneLiner: "一句", points: ["p1", "p2", "p3"] }, 2),
  "2|T x|U|1:01|AI、编程|一句|p1；p2；p3"
);
assert.strictEqual(t.triageCommandLine({ title: "T" }, 1), "1|T|||||");
const cmdMsgs = t.triageBuildCommandMessages({ instruction: "把讲 AI 的都标上", tags: ["AI", "编程"], items: [{ bvid: "BV1", title: "T" }] });
assert.ok(cmdMsgs[0].content.includes("至多 5 个"));
assert.ok(cmdMsgs[0].content.endsWith("没有说明只写名称）：\nAI\n编程"));
const ruleMsgs = t.triageBuildCommandMessages({ instruction: "x", tags: [{ name: "AI", rule: " 讲大模型\n的 " }, { name: "编程", rule: "" }], items: [{ bvid: "BV1", title: "T" }] });
assert.ok(ruleMsgs[0].content.endsWith("\nAI：讲大模型 的\n编程"), "a tag with a rule is 名称：说明, without one name only");
assert.ok(ruleMsgs[0].content.includes("按说明决定"));
assert.ok(ruleMsgs[0].content.includes("一个视频可以加多个标签"));
// The folder's room: 批量打 tells the model how many new tags it may make, none at 0.
const roomMsg = (n) => t.triageBuildCommandMessages({ instruction: "x", tags: [], items: [], maxNewTags: n })[0].content;
assert.ok(roomMsg(3).includes("至多 3 个") && !roomMsg(0).includes("至多") && roomMsg(0).includes("这次不能新建标签"));
assert.deepStrictEqual(plain(t.triageParseCommand('{"items":[{"i":1,"add":["AI","AI：讲大模型 的"]}]}', [{ bvid: "BV1" }], [{ name: "AI", rule: "讲大模型" }])).assignments, { BV1: { add: ["AI"], remove: [] } }, "tag objects validate by name only");
assert.ok(t.triageBuildCommandMessages({ instruction: "x", tags: [], items: [] })[0].content.endsWith("：\n（无）"));
assert.ok(!cmdMsgs[0].content.includes('"verdict"'));
assert.ok(cmdMsgs[1].content.includes("<<<指令>>>\n把讲 AI 的都标上\n<<<指令结束>>>"));
assert.ok(cmdMsgs[1].content.endsWith("\n1|T|||||"));
assert.ok(!/verdict|值得留|可清理|拿不准/.test(cmdMsgs[0].content), "the command prompt never asks for a verdict");

// command parse
const cmdItems = [
  { bvid: "BV1", currentTags: ["AI", "旧"] },
  { bvid: "BV2", currentTags: [] },
  { bvid: "BV3" },
  { bvid: "BV4", currentTags: ["编程"] }
];
const cmdTags = ["AI", "编程", "旧"];
const cmdOut =
  '好的，提案如下：\n```json\n{"new_tags":[" 数学 ",{"name":"AI"},{"name":"物理,力学"},"数学","化学"],' +
  '"items":[{"i":2,"add":["数学","不存在","编程","编程"],"remove":["AI"],"verdict":"KEEP","reason":"讲 {数学}"},' +
  '{"i":1,"add":["AI","物理力学"],"remove":["旧","不在"],"verdict":"必看","reason":"r1"},' +
  '{"i":3,"add":["化学"],"remove":[]},{"i":4,"add":[],"remove":[],"reason":"无"},{"i":9,"add":["AI"]},{"i":2,"add":["旧"]}],"note":"已打标签"}\n``` 以上';
assert.deepStrictEqual(plain(t.triageParseCommand(cmdOut, cmdItems, cmdTags, { maxNewTags: 2, allowRemove: true })), {
  newTags: ["数学", "物理力学"],
  assignments: {
    BV2: { add: ["数学", "编程"], remove: [] },
    BV1: { add: ["物理力学"], remove: ["旧"] }
  },
  note: "已打标签"
}, "verdict and reason fields in the reply (the old shape) are dropped");
assert.deepStrictEqual(plain(t.triageParseCommand('{"items":[{"i":2,"verdict":"keep","reason":"x"}]}', cmdItems, cmdTags)).assignments, {}, "a verdict-only item is no change");
assert.deepStrictEqual(plain(t.triageParseCommand(cmdOut, cmdItems, cmdTags, { maxNewTags: 0, allowRemove: true })), {
  newTags: [],
  assignments: {
    BV2: { add: ["编程"], remove: [] },
    BV1: { add: [], remove: ["旧"] }
  },
  note: "已打标签"
});
assert.strictEqual(plain(t.triageParseCommand(cmdOut, cmdItems, cmdTags)).newTags.length, 3, "up to 5 new tags by default");
// Taking tags off is a 分拣设置 switch, off by default: the prompt says so and the parser drops removals.
assert.ok(Object.values(plain(t.triageParseCommand(cmdOut, cmdItems, cmdTags)).assignments).every((a) => !a.remove.length), "removals dropped by default");
assert.ok(cmdMsgs[0].content.includes("不能去掉视频已有的标签"), "the default prompt forbids removals");
assert.ok(t.triageBuildCommandMessages({ instruction: "x", tags: [], items: [], allowRemove: true })[0].content.includes("remove 只能填该视频"), "allowRemove lets it remove");
assert.deepStrictEqual(plain(t.triageParseCommand('{"items":[]}', cmdItems, cmdTags, {})), { newTags: [], assignments: {}, note: "" });
assert.throws(() => t.triageParseCommand("抱歉，没法处理", cmdItems, cmdTags, {}), /格式不对/);
assert.throws(() => t.triageParseCommand('{"new_tags":[', cmdItems, cmdTags, {}), /回复不完整/);


(async () => {
  // AI HTTP 429 is its own throttle code; other HTTP errors carry none.
  t.loadAiProviders = async () => [{ id: "p", baseUrl: "https://ai.test", model: "m" }];
  t.loadAiProviderKeys = async () => ({});
  t.fetch = async () => ({ ok: false, status: 429, text: async () => "slow down" });
  await assert.rejects(t.triageChat([], 100), (e) => e.code === "AI_THROTTLED");
  t.fetch = async () => ({ ok: false, status: 500, text: async () => "" });
  await assert.rejects(t.triageChat([], 100), (e) => e.code === undefined);

  // 开启思考 reaches DeepSeek, 智谱 and Kimi only; other platforms get no thinking field.
  for (const [url, on] of [
    ["https://api.deepseek.com/v1", true], ["https://open.bigmodel.cn/api/paas/v4", true], ["https://api.z.ai/api/paas/v4", true],
    ["https://api.moonshot.cn/v1", true], ["https://api.moonshot.ai/v1", true],
    ["https://api.openai.com/v1", false], ["https://openrouter.ai/api/v1", false], ["http://127.0.0.1:11434/v1", false], ["https://api.minimaxi.com/v1", false]
  ]) {
    assert.strictEqual(t.supportsThinkingToggle(url), on, url);
    t.loadAiProviders = async () => [{ id: "p", baseUrl: url, model: "m" }];
    let sent;
    t.fetch = async (_, init) => ((sent = JSON.parse(init.body)), { ok: true, json: async () => ({ choices: [{ message: { content: "x" } }] }) });
    await t.triageChat([], 100, false);
    assert.deepStrictEqual(sent.thinking, on ? { type: "disabled" } : undefined, url);
    t.chrome = { storage: { sync: { get: async (d) => d } } };
    assert.strictEqual((await vm.runInContext("TRIAGE_HANDLERS", ctx)["triage-settings-get"]()).thinkingToggle, on, url);
  }
  t.loadAiProviders = async () => [{ id: "p", baseUrl: "https://ai.test", model: "m" }];

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
  // With known, loading stops after the first page that is all known and returns just those pages as head.
  const pages = [];
  t.fetch = async (url) => {
    const pn = Number(new URL(url).searchParams.get("pn"));
    pages.push(pn);
    return jsonRes({ code: 0, data: { medias: pn === 1 ? [media(9), media(1)] : [media(2), media(3)], has_more: true } })();
  };
  const head = await folderItems({ mediaId: 1, known: ["BV1", "BV2", "BV3"] });
  assert.deepStrictEqual(JSON.parse(JSON.stringify([pages, head.items.map((it) => it.bvid), head.head])), [[1, 2], ["BV9", "BV1", "BV2", "BV3"], true]);

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
    "/view/detail": { code: 0, data: { View: { title: "标题", desc: "简介", tname: "知识", aid: 22, pubdate: new Date(2024, 4, 30, 12).getTime() / 1000, cid: 11, duration: 273, owner: { name: "UP" }, pages: [{ cid: 11, page: 1, duration: 273 }] }, Tags: [{ tag_name: "标签" }] } },
    "/nav": { code: -101, data: { wbi_img: { img_url: "https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png", sub_url: "https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png" } } },
    "/x/player/wbi/v2": withTracks,
    [subUrl]: subtitleRaw(272),
    "/reply/main": { code: 0, data: { replies: [{ content: { message: "评论一" } }] } }
  });
  const analyze = () => t.triageAnalyze({ bvid: "BVa", force: true, criteria: "" });

  // A subtitle the video page cached is used without fetching it again.
  routes = baseRoutes();
  store[subtitleKey] = { raw: subtitleRaw(270), timestamp: Date.now() };
  assert.strictEqual((await analyze()).source, "subtitle");
  assert.ok(!calls.includes(subUrl), "cached subtitle is not refetched");
  assert.ok(prompt.includes("分区：知识") && prompt.includes("标签：标签") && prompt.includes("发布：2024-05-30") && prompt.includes("第一句\n最后一句"));
  assert.ok(prompt.includes("字幕：\n第一句") && !prompt.includes("热门评论") && !calls.some((u) => u.includes("/reply/main")), "with subtitles no comments are fetched or sent");

  // A fetched subtitle that passes the duration guard is cached for the video page.
  delete store[subtitleKey];
  assert.strictEqual((await analyze()).source, "subtitle");
  assert.deepStrictEqual(store[subtitleKey].raw, subtitleRaw(272));

  // Another video's subtitle (ends far too early) falls back to comments and is not cached.
  delete store[subtitleKey];
  routes = { ...baseRoutes(), [subUrl]: subtitleRaw(100) };
  assert.strictEqual((await analyze()).source, "meta");
  assert.strictEqual(subtitleKey in store, false);
  assert.ok(prompt.includes("（无可用字幕）\n热门评论：\n1. 评论一"));

  // Without subtitles, a comment fetch failure does not fail the analysis.
  routes = { ...baseRoutes(), [subUrl]: subtitleRaw(100), "/reply/main": new Error("network") };
  assert.strictEqual((await analyze()).source, "meta");
  assert.ok(prompt.includes("（无可用字幕）\n热门评论：\n无"));

  // A subtitle up to the cap goes in whole; a longer one is sampled down to the cap.
  const line = "一句字幕".repeat(10);
  const longRaw = (n) => ({ body: Array.from({ length: n }, (_, i) => ({ from: i, to: i === n - 1 ? 272 : i + 1, content: line })) });
  const whole = Math.floor(t.BocLimits.AI_SUBTITLE_MAX_CHARS / (line.length + 1));
  routes = { ...baseRoutes(), [subUrl]: longRaw(whole) };
  delete store[subtitleKey];
  await analyze();
  assert.strictEqual(prompt.split(line).length - 1, whole, "a subtitle under the cap is not cut");
  routes = { ...baseRoutes(), [subUrl]: longRaw(whole * 3) };
  delete store[subtitleKey];
  await analyze();
  const kept = prompt.split(line).length - 1;
  assert.ok(kept < whole * 3 && kept >= whole - 1, `an over-cap subtitle is sampled to the cap (${kept} lines)`);

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
  // A deleted video rejects with Bilibili's code, which the pages read as gone; a throttled view does not.
  routes = { ...baseRoutes(), "/view/detail": { code: -404, message: "啥都木有" }, "/web-interface/view?": { code: -404, message: "啥都木有" } };
  await assert.rejects(buildNote(), (e) => e.code === -404 && e.message === "啥都木有" && t.BocSites.isBiliVideoGone(e.code));
  routes = { ...baseRoutes(), "/view/detail": { code: -352, message: "风控" }, "/web-interface/view?": { code: -352, message: "风控" } };
  await assert.rejects(buildNote(), (e) => e.code === "THROTTLED" && !t.BocSites.isBiliVideoGone(e.code));
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
  assert.ok(noted.includes("## 我的备注\n\n视频笔记") && !noted.includes("篮子里的旧笔记"));

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

  // R1: the triage page opens once; a second open focuses the tab already showing it.
  const tabCalls = [];
  const fakeTabs = (contexts) => ({
    runtime: { getURL: (p) => `chrome-extension://id/${p}`, getContexts: async () => contexts },
    tabs: { create: async (o) => tabCalls.push(["create", o.url]), update: async (id, o) => tabCalls.push(["update", id, o.active]) },
    windows: { update: async (id, o) => tabCalls.push(["window", id, o.focused]) }
  });
  t.chrome = fakeTabs([{ tabId: 3, windowId: 1, documentUrl: "chrome-extension://id/history/history.html" }]);
  await vm.runInContext("TRIAGE_HANDLERS", ctx)["triage-open"]();
  t.chrome = fakeTabs([{ tabId: 4, windowId: 2, documentUrl: "chrome-extension://id/triage/triage.html" }]);
  await vm.runInContext("TRIAGE_HANDLERS", ctx)["triage-open"]();
  assert.deepStrictEqual(tabCalls, [["create", "chrome-extension://id/triage/triage.html"], ["update", 4, true], ["window", 2, true]]);
  // 移动/复制 is one batch request; from 稍后再看 or with no source (已取消收藏) one add per video, 稍后再看 removed only on a
  // move. 稍后再看 is never a target. A new folder answers with its id.
  {
    const H = vm.runInContext("TRIAGE_HANDLERS", ctx);
    const calls = [];
    t.chrome = { cookies: { get: async () => ({ value: "csrf" }) } };
    t.fetch = async (url, opts) => {
      if (/web-interface\/nav/.test(url)) return { ok: true, status: 200, json: async () => ({ code: 0, data: { isLogin: true, mid: 7 } }) };
      calls.push([new URL(url).pathname, Object.fromEntries(new URLSearchParams(opts.body))]);
      return { ok: true, status: 200, json: async () => ({ code: 0, data: { id: 42, title: "新夹" } }) };
    };
    await H["triage-transfer"]({ from: "1", to: "2", aids: [10, 11], move: true });
    assert.deepStrictEqual(calls.pop(), ["/x/v3/fav/resource/move", { src_media_id: "1", tar_media_id: "2", mid: "7", resources: "10:2,11:2", platform: "web", csrf: "csrf" }]);
    await H["triage-transfer"]({ from: "1", to: "2", aids: [10], move: false });
    assert.strictEqual(calls.pop()[0], "/x/v3/fav/resource/copy");
    await H["triage-transfer"]({ from: "toview", to: "2", aids: [10], move: true });
    assert.deepStrictEqual(calls.splice(0).map((c) => c[0]), ["/x/v3/fav/resource/deal", "/x/v2/history/toview/del"]);
    await H["triage-transfer"]({ from: "", to: "2", aids: [10, 11], move: false });
    assert.deepStrictEqual(calls.splice(0).map((c) => c[0]), ["/x/v3/fav/resource/deal", "/x/v3/fav/resource/deal"]);
    await assert.rejects(H["triage-transfer"]({ from: "1", to: "toview", aids: [10], move: true }), /缺少目标/);
    await assert.rejects(H["triage-transfer"]({ from: "1", to: "1", aids: [10], move: true }), /缺少目标/);
    assert.deepStrictEqual(plain(await H["triage-folder-create"]({ title: " 新夹 ", privacy: true })), { id: 42, title: "新夹" });
    assert.deepStrictEqual(calls.pop(), ["/x/v3/fav/folder/add", { title: "新夹", intro: "", privacy: "1", cover: "", csrf: "csrf" }]);
    await assert.rejects(H["triage-folder-create"]({ title: "  " }), /不能为空/);
  }

  // The folder list pages through created/list (which carries the cover) until has_more is false; covers are https.
  {
    const H = vm.runInContext("TRIAGE_HANDLERS", ctx);
    const pages = [];
    t.fetch = async (url) => {
      const u = new URL(url);
      if (/web-interface\/nav/.test(url)) return { ok: true, status: 200, json: async () => ({ code: 0, data: { isLogin: true, mid: 7 } }) };
      if (/toview/.test(url)) return { ok: true, status: 200, json: async () => ({ code: 0, data: { count: 3 } }) };
      assert.strictEqual(u.pathname, "/x/v3/fav/folder/created/list");
      const pn = Number(u.searchParams.get("pn"));
      pages.push(pn);
      const list = pn === 1 ? [{ id: 1, title: "甲", media_count: 4, cover: "http://i0.hdslb.com/a.jpg" }] : [{ id: 2, title: "乙", media_count: 1, cover: "" }];
      return { ok: true, status: 200, json: async () => ({ code: 0, data: { list, has_more: pn === 1 } }) };
    };
    const r = plain(await H["triage-folders"]());
    assert.deepStrictEqual(pages, [1, 2]);
    assert.deepStrictEqual(r.folders, [
      { id: "toview", title: "稍后再看", count: 3 },
      { id: 1, title: "甲", count: 4, cover: "https://i0.hdslb.com/a.jpg" },
      { id: 2, title: "乙", count: 1, cover: "" }
    ]);
  }

  // 看过: percent is progress over duration, -1 = finished, capped at 100; 0 is not stored.
  {
    assert.deepStrictEqual([t.seenPercent(-1, 0), t.seenPercent(30, 60), t.seenPercent(70, 60), t.seenPercent(0, 60), t.seenPercent(5, 0)], [100, 50, 100, 0, 0]);
    const h = (bvid, view_at, progress, duration = 100, business = "archive") => ({ view_at, progress, duration, history: { business, bvid } });
    const found = {};
    const done = t.seenFold(found, [h("BVa", 50, 40), h("BVb", 40, 0), h("BVc", 30, 10, 100, "live"), h("BVa", 20, 90), h("BVd", 10, 100)], 15);
    assert.strictEqual(done, true, "stops at the first item not newer than the last read");
    assert.deepStrictEqual(plain(found), { BVa: [90, 50] }, "best percent, latest view; 0 progress and non-videos skipped");
    // Prune: older than a year or past the newest 5000 go, unless the video is in a chosen folder.
    const nowS = 400 * 86400;
    const entries = { BVold: [80, 10], BVkeep: [80, 10], BVnew: [80, nowS - 5] };
    assert.deepStrictEqual(plain(t.seenPrune(entries, new Set(["BVkeep"]), nowS)), ["BVold"]);

    // seen-sync: off by default; reads only what is new, merges with what is stored, waits 10 minutes between reads,
    // and backs off on risk control.
    const st = {};
    let sync = {};
    const urls = [];
    let pages = [];
    t.chrome = {
      runtime: { getPlatformInfo: async () => ({}) },
      cookies: { get: async () => ({ value: "csrf" }) },
      storage: {
        sync: { get: async (d) => ({ ...d, ...sync }) },
        local: {
          get: async (k) => Object.fromEntries([].concat(k).filter((x) => x in st).map((x) => [x, structuredClone(st[x])])),
          set: async (o) => Object.assign(st, structuredClone(o)),
          remove: async (keys) => [].concat(keys).forEach((x) => delete st[x]),
          getKeys: async () => Object.keys(st)
        }
      }
    };
    t.fetch = async (url) => {
      urls.push(url);
      const body = pages.shift() || { code: 0, data: { list: [], cursor: { max: 0 } } };
      return { ok: true, status: 200, json: async () => body };
    };
    const H = vm.runInContext("TRIAGE_HANDLERS", ctx);
    // The message listener only routes triage-* types: a handler named otherwise is never reached.
    assert.deepStrictEqual(Object.keys(H).filter((k) => !k.startsWith("triage-")), []);
    assert.deepStrictEqual(plain(await H["triage-seen-sync"]()), { skipped: "off" });
    assert.strictEqual(urls.length, 0, "nothing is read with both switches off");
    sync = { seenShow: "bar" };
    const T = Math.floor(Date.now() / 1000) - 1000; // view_at in seconds, recent enough to survive the prune
    const page = (list, max) => ({ code: 0, data: { list, cursor: { max, view_at: 1, business: "archive" } } });
    st.seen_BVa = [95, T - 500];
    pages = [page([h("BVa", T + 300, 50), h("BVb", T + 290, 100)], 7), page([h("BVc", T + 280, -1)], 0)];
    const first = await H["triage-seen-sync"]();
    assert.strictEqual(first.pages, 2);
    assert.deepStrictEqual([plain(st.seen_BVa), plain(st.seen_BVb), plain(st.seen_BVc)], [[95, T + 300], [100, T + 290], [100, T + 280]], "keeps the higher stored percent");
    assert.strictEqual(st.triage_seen_meta.newest, T + 300);
    assert.deepStrictEqual(plain(await H["triage-seen-sync"]()), { skipped: "recent" });
    pages = [page([h("BVd", T + 310, 30), h("BVa", T + 300, 50)], 9)];
    const again = await H["triage-seen-sync"]({ force: true });
    assert.strictEqual(again.pages, 1, "a later read stops at what it already has");
    assert.deepStrictEqual(plain(st.seen_BVd), [30, T + 310]);
    pages = [{ code: -412, message: "请求被拦截" }];
    await assert.rejects(H["triage-seen-sync"]({ force: true }), (e) => e.code === "THROTTLED");
    assert.ok(st.triage_seen_meta.backoffUntil > Date.now(), "risk control backs off");
    const before = urls.length;
    assert.deepStrictEqual(plain(await H["triage-seen-sync"]({ force: true })), { skipped: "throttled" });
    assert.strictEqual(urls.length, before, "no request while backing off");
  }

console.log("triage-bg selftest: all passed");
})();
