// node extension/triage/triage-bg.selftest.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");
const PS = require("../page-sources.selftest.js");

const ctx = vm.createContext({ TextEncoder, URL, URLSearchParams, console, setTimeout, clearTimeout, AbortController });
// The worker's own load order: every file background.js importScripts, up to triage-bg.js.
const bg = fs.readFileSync(path.join(__dirname, "../background.js"), "utf8");
const order = [...bg.matchAll(/importScripts\(([^)]*)\)/g)].flatMap((m) => m[1].match(/"[^"]+"/g).map((f) => JSON.parse(f)));
for (const file of order.slice(0, order.indexOf("triage/triage-bg.js") + 1)) vm.runInContext(fs.readFileSync(path.join(__dirname, "..", file), "utf8"), ctx);
// background.js owns supportsThinkingToggle and postChat; lift just those.
for (const name of ["supportsThinkingToggle", "postChat"]) {
  const at = bg.indexOf(`function ${name}(`);
  vm.runInContext(bg.slice(at, bg.indexOf("\n}\n", at) + 2), ctx);
}
const t = ctx;
const plain = (x) => JSON.parse(JSON.stringify(x));

// Obsidian itself unusable carries code OBSIDIAN, or OBSIDIAN_DOWN when it is not running (both end a 逐个视频笔记 run);
// one note's own error passes through.
assert.strictEqual(t.obsidianError(vm.runInContext('new TypeError("Failed to fetch")', ctx)).code, "OBSIDIAN_DOWN");
assert.strictEqual(t.obsidianError({ status: 408 }).code, "OBSIDIAN_DOWN");
assert.strictEqual(t.obsidianError({ status: 401 }).code, "OBSIDIAN");
// 404 is one thing on every path (a note's write, 一篇摘录, 测试连接, the pre-run check): a wrong address, 去设置.
assert.deepStrictEqual([t.obsidianError({ status: 404 }).code, t.obsidianError({ status: 404 }).message], ["OBSIDIAN", t.MdgErrors.TEXT.obsidianNotFound]);
assert.throws(() => t.obsidianConfig({ obsidianEnabled: false }), (e) => e.code === "OBSIDIAN" && e.message === t.MdgErrors.TEXT.obsidianOff);
// An HTTP failure of one note shows the status, never the response body.
assert.strictEqual(t.obsidianError({ status: 500, message: 'HTTP 500. {"errorCode":50000}' }).message, "Obsidian 返回 HTTP 500");
const noteErr = new Error("生成笔记失败");
assert.strictEqual(t.obsidianError(noteErr), noteErr);
assert.throws(() => t.obsidianConfig({ obsidianEnabled: true, obsidianApiBaseUrl: "http://127.0.0.1:27123" }), (e) => e.code === "OBSIDIAN");
// The pre-run check: a wrong key or address is OBSIDIAN (去设置); Obsidian's own HTTP 500 is a plain error.
{
  t.getMergedSettings = async () => ({ obsidianEnabled: true, obsidianApiBaseUrl: "http://127.0.0.1:27123", obsidianApiKey: "k" });
  t.OBSIDIAN_TIMEOUT_MS = 1000;
  const check = (status) => ((t.fetchWithTimeout = async () => ({ ok: status < 300, status, json: async () => ({ service: "Obsidian Local REST API" }) })), t.triageObsidianCheck().then(() => "ok", (e) => e.code ?? e.message));
  (async () => {
    const codes = [];
    for (const status of [401, 403, 404, 500, 200]) codes.push(await check(status));
    assert.deepStrictEqual(codes, ["OBSIDIAN", "OBSIDIAN", "OBSIDIAN", "Obsidian 返回 HTTP 500", "ok"]);
  })().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}


// LLM parse: fixed three classes; ids in any case or the Chinese names; anything else fails the video, not 拿不准.
const good = t.triageParseLlm('```json\n{"one_liner":"讲 X","points":["1","2","3"],"verdict":"keep","reason":"有方法","tags":["AI"]}\n```');
assert.deepStrictEqual(plain(good), { oneLiner: "讲 X", points: ["1", "2", "3"], verdict: "keep", reason: "有方法" }, "tags in the answer are ignored");
const dirty = t.triageParseLlm('好的，结果如下：{"one_liner":"含 } 括号","points":["a","b","c","d"],"verdict":"DROP","reason":"r"} 以上');
assert.strictEqual(dirty.oneLiner, "含 } 括号");
assert.strictEqual(dirty.points.length, 3);
assert.strictEqual(dirty.verdict, "drop");
const thin = t.triageParseLlm('{"one_liner":"x","points":["only"],"verdict":"unsure"}');
assert.deepStrictEqual([...thin.points], ["only", "", ""]);
assert.strictEqual(thin.reason, "");
assert.throws(() => t.triageParseLlm('{"one_liner":"x","verdict":"maybe"}'), /AI 给的判断看不懂：「maybe」/);
assert.strictEqual(t.triageParseLlm('{"one_liner":"x","verdict":"可清理"}').verdict, "drop", "the Chinese name maps to its id");
assert.strictEqual(t.triageParseLlm('{"one_liner":"x","verdict":"可以删"}').verdict, "drop", "the old name still maps");
assert.throws(() => t.triageParseLlm('{"one_liner":"x"}'), /AI 回复缺少判断/);
assert.throws(() => t.triageParseLlm('{"one_liner":"x","points":["a"'), /回复不完整/);
assert.throws(() => t.triageParseLlm("没有 JSON"), /格式不对/);
assert.throws(() => t.triageParseLlm('{"points":[]}'), /缺少一句话总结/);

// title line
assert.strictEqual(
  t.triageTitleLine({ title: "a|b\nc", upper: "UP", duration: 125, pubdate: new Date(2024, 4, 30, 12).getTime() / 1000, intro: "简".repeat(300) }, 3),
  `3|a b c|UP|2:05|2024-05-30|${"简".repeat(255)}`
);
assert.strictEqual(t.triageTitleLine({ title: "T", upper: "U", duration: 0, intro: "" }, 1), "1|T|U|||", "no publish date or duration leaves its field empty, not 0:00");
// An hour and up reads 1:15:00, as on the cards (the old copy here wrote 75:00).
assert.strictEqual(t.triageTitleLine({ title: "T", upper: "U", duration: 75 * 60 }, 1).split("|")[3], "1:15:00");
assert.strictEqual(t.triageCommandLine({ title: "T", duration: 75 * 60 + 5 }, 1).split("|")[3], "1:15:05");
// Dates, durations and tag names come from shared.js's TriageUi only: no background copy to drift.
{
  const src = fs.readFileSync(path.join(__dirname, "triage-bg.js"), "utf8") + fs.readFileSync(path.join(__dirname, "follow-bg.js"), "utf8");
  assert.ok(!/padStart|getFullYear|% 60|\[,，、\]/.test(src), "a hand-written date, duration or tag-name rule in the background");
}

// stage-1 title batch
const items = [{ bvid: "BV1" }, { bvid: "BV2" }, { bvid: "BV3" }];
const batch = plain(t.triageParseTitleBatch(
  '好的：\n```json\n[{"i":2,"verdict":"KEEP","reason":"教程 [实用]","tags":["编程"],"confidence":"high"},' +
    '{"i":1,"verdict":"what","reason":"看不出","confidence":"medium"},{"i":9,"verdict":"drop"}]\n```',
  items
));
assert.deepStrictEqual(batch.results.BV2, { verdict: "keep", reason: "教程 [实用]", confidence: "high" });
assert.deepStrictEqual(batch.failed, { BV1: "AI 给的判断看不懂：「what」" }, "an unknown verdict fails the video with why, not 拿不准");
assert.ok(!("BV1" in batch.results) && !("BV3" in batch.results), "a video the AI left out has no result, so the page fails it (可重试) instead of 拿不准");
assert.throws(() => t.triageParseTitleBatch('[{"i":1,"verdict":"keep"', items), /回复不完整/);
// R33: a model that writes its thinking into the reply: the brackets in <think> are not the answer.
{
  const reply = '[{"i":1,"verdict":"keep","reason":"x","confidence":"high"}]';
  assert.strictEqual(t.triageParseTitleBatch(`<think>第[1]个像教程</think>\n${reply}`, items).results[items[0].bvid].verdict, "keep");
  assert.strictEqual(t.triageParseLlm('<think>先想 {"verdict":"keep"}</think>{"one_liner":"讲X","points":["a"],"verdict":"keep"}').oneLiner, "讲X");
}

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
// K7: 自动 is written once, TriageUi.autoMaxTokens; the settings dialog's hints show the same numbers.
for (const [f, src] of [["triage-bg.js", PS.read("triage/triage-bg.js")], ["收藏夹", PS.text(PS.favorites)]]) {
  assert.ok(/autoMaxTokens\(/.test(src) && !/\d+ \* \w+ \+ \d+|\? 8000 : 1000/.test(src), `${f} writes the output limit's 自动 itself`);
}


// tag names
assert.deepStrictEqual(plain(t.triageTagNames(["AI", " 编程 ", "", null])), ["AI", "编程"]);

// command line + messages
assert.strictEqual(
  t.triageCommandLine({ title: "T|x", upper: "U", duration: 61, intro: "简介|第二行\n" + "长".repeat(300), currentTags: ["AI", "编程"], oneLiner: "一句", points: ["p1", "p2", "p3"] }, 2),
  `2|T x|U|1:01|${("简介 第二行 " + "长".repeat(300)).slice(0, 255)}|AI、编程|一句|p1；p2；p3`
);
assert.strictEqual(t.triageCommandLine({ title: "T" }, 1), "1|T||||||");
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
assert.ok(cmdMsgs[1].content.endsWith("\n1|T||||||"));
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
  newTags: ["数学", "物理力学", "化学"],
  assignments: {
    BV2: { add: ["数学", "编程"], remove: [] },
    BV1: { add: ["物理力学"], remove: ["旧"] },
    BV3: { add: ["化学"], remove: [] }
  },
  note: "已打标签"
}, "verdict and reason fields in the reply (the old shape) are dropped");
assert.deepStrictEqual(plain(t.triageParseCommand('{"items":[{"i":2,"verdict":"keep","reason":"x"}]}', cmdItems, cmdTags)).assignments, {}, "a verdict-only item is no change");
// Taking tags off is a 分拣设置 switch, off by default: the prompt says so and the parser drops removals.
assert.ok(Object.values(plain(t.triageParseCommand(cmdOut, cmdItems, cmdTags)).assignments).every((a) => !a.remove.length), "removals dropped by default");
assert.ok(cmdMsgs[0].content.includes("不能去掉视频已有的标签"), "the default prompt forbids removals");
assert.ok(t.triageBuildCommandMessages({ instruction: "x", tags: [], items: [], allowRemove: true })[0].content.includes("remove 只能填该视频"), "allowRemove lets it remove");
assert.deepStrictEqual(plain(t.triageParseCommand('{"items":[]}', cmdItems, cmdTags, {})), { newTags: [], assignments: {}, note: "" });
assert.throws(() => t.triageParseCommand("抱歉，没法处理", cmdItems, cmdTags, {}), /格式不对/);
assert.throws(() => t.triageParseCommand('{"new_tags":[', cmdItems, cmdTags, {}), /回复不完整/);


(async () => {
  // 摘读记录's AI 打标签 (triage-reading-ai-tag): records by id (a video's and a web page's record key), one line each of
  // what the page read, the 收藏夹 rules, and assignments keyed by id.
  {
    const was = { chat: t.triageChat, settings: t.triageAiSettings };
    let sent;
    t.triageAiSettings = async () => ({ triageThinking: false });
    t.triageChat = async (messages, maxTokens, thinking, providerId) => ((sent = { messages, providerId }), { content: '{"new_tags":["编程"],"items":[{"i":1,"add":["编程"]},{"i":2,"add":["读过"],"remove":["旧"]}],"note":"好"}' });
    const video = { id: "video:bilibili:BV1a|", title: "讲|Transformer", site: "B站", turns: [{ q: "第一问", a: "答|一" }, { q: "第二问", a: "" }], currentTags: [] };
    const page = { id: "page:https://example.com/post", title: "一篇文章", site: "网页", oneLiner: "注意力机制", note: "值得\n再看", currentTags: ["旧"] };
    const r = plain(await vm.runInContext("TRIAGE_HANDLERS", ctx)["triage-reading-ai-tag"]({ instruction: "按主题分", items: [video, page], tags: [{ name: "读过" }, { name: "旧" }], maxNewTags: 5, allowRemove: true, aiProviderId: "p" }));
    const user = sent.messages[1].content;
    assert.ok(user.includes("1|讲 Transformer|B站||问：第一问 答：答 一 问：第二问||\n2|一篇文章|网页|旧||注意力机制|值得 再看"), user);
    assert.ok(sent.messages[0].content.includes("摘读记录整理助手") && sent.messages[0].content.includes("remove 只能填该记录") && sent.providerId === "p", sent.messages[0].content);
    // 收藏夹设置's 开启思考 and 粗看输出上限 are its own: 摘读记录 and 关注 run thinking off with the automatic cap.
    {
      const runs = [];
      t.triageAiSettings = async () => ({ triageThinking: true, triageTitleMaxTokens: 777 });
      t.triageChat = async (messages, maxTokens, thinking) => (runs.push([maxTokens, thinking]), { content: '{"new_tags":[],"items":[]}' });
      const H = vm.runInContext("TRIAGE_HANDLERS", ctx);
      await H["triage-reading-ai-tag"]({ instruction: "x", items: [video], tags: [], maxNewTags: 0 });
      await H["triage-ai-command"]({ instruction: "x", items: [{ bvid: "BV1", title: "t" }], tags: [], maxNewTags: 0 });
      assert.deepStrictEqual(runs, [[t.TriageUi.autoMaxTokens("command", 1, false), false], [777, true]]);
      t.triageAiSettings = async () => ({ triageThinking: false });
    }
    assert.deepStrictEqual(r, { newTags: ["编程"], assignments: { [video.id]: { add: ["编程"], remove: [] }, [page.id]: { add: ["读过"], remove: ["旧"] } }, note: "好" });
    await assert.rejects(vm.runInContext("TRIAGE_HANDLERS", ctx)["triage-reading-ai-tag"]({ instruction: "x", items: [{ title: "没有 id" }], tags: [] }), /缺少 items/);
    Object.assign(t, { triageChat: was.chat, triageAiSettings: was.settings });
  }
  // AI errors get one code each: a 429 that says the balance or quota ran out is AI_QUOTA, not a throttle to wait out;
  // 5xx carries none (that request only). The body never reaches the message.
  t.loadAiProviders = async () => [{ id: "p", baseUrl: "https://ai.test", model: "m" }];
  t.loadAiProviderKeys = async () => ({ p: "k", a: "k", b: "k" });
  // F4: 接口地址 / 模型名 / API Key missing is one code that stops 分拣台 (去设置) before any request, in aiProviderProblem's
  // words, the same the side panel and 测试连接 say.
  {
    let asked = 0;
    t.fetch = async () => (asked++, { ok: true, json: async () => ({ choices: [{ message: { content: "x" } }] }) });
    const fails = async (provider, keys = { p: "k" }) => {
      t.loadAiProviders = async () => [{ id: "p", baseUrl: "https://ai.test", model: "m", ...provider }];
      t.loadAiProviderKeys = async () => keys;
      return t.triageChat([], 100).then(() => null, (e) => [e.message, e.code]);
    };
    assert.deepStrictEqual(
      [await fails({ model: "" }), await fails({ baseUrl: " " }), await fails({}, {}), await fails({ requiresKey: false }, {})],
      [["AI 平台的模型名没填", "AI_SETUP"], ["AI 平台的接口地址没填", "AI_SETUP"], ["AI 平台的 API Key 没填", "AI_AUTH"], null]
    );
    assert.strictEqual(asked, 1, "only the platform that needs no key was asked");
    t.loadAiProviders = async () => [{ id: "p", baseUrl: "https://ai.test", model: "m" }];
    t.loadAiProviderKeys = async () => ({ p: "k", a: "k", b: "k" });
  }
  for (const [status, body, code] of [
    [429, "slow down", "AI_THROTTLED"],
    [429, '{"error":{"message":"Rate limit reached for gpt-4o on requests per min (RPM)"}}', "AI_THROTTLED"],
    [429, '{"error":{"message":"Quota exceeded for metric generate_content_requests per minute"}}', "AI_THROTTLED"],
    [429, '{"error":{"message":"You exceeded your current quota, please check your plan and billing details.","type":"insufficient_quota"}}', "AI_QUOTA"],
    [429, '{"error":{"code":"1113","message":"余额不足或无可用资源包,请充值。"}}', "AI_QUOTA"],
    [402, '{"error":{"message":"Insufficient Balance"}}', "AI_QUOTA"],
    [401, '{"error":{"message":"Incorrect API key provided"}}', "AI_AUTH"],
    [403, "", "AI_AUTH"],
    [404, '{"error":{"code":"model_not_found"}}', "AI_SETUP"],
    [500, "", undefined]
  ]) {
    t.fetch = async () => ({ ok: false, status, text: async () => body });
    await assert.rejects(t.triageChat([], 100), (e) => e.code === code && !/error|\{/.test(e.message), `${status} ${body}`);
  }
  t.hostPermissionError = async () => "";
  t.fetch = async () => {
    throw new TypeError("Failed to fetch");
  };
  await assert.rejects(t.triageChat([], 100), (e) => e.code === "AI_NETWORK" && e.message === "连不上 AI 平台，请检查网络和接口地址");
  t.hostPermissionError = async () => "未授权访问 https://ai.test，授权后重试";
  await assert.rejects(t.triageChat([], 100), (e) => e.code === "AI_ACCESS" && /未授权访问/.test(e.message), "a missing permission keeps its own text, with its code");
  // K7: an answer cut at the output limit has its own code; 分拣台 matches the code, not the words.
  t.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: "" }, finish_reason: "length" }] }), json: async () => ({ choices: [{ message: { content: "" }, finish_reason: "length" }] }) });
  await assert.rejects(t.triageChat([], 100), (e) => e.code === "AI_TRUNCATED" && e.message === "模型输出被截断");
  // A partial answer cut at the limit is AI_TRUNCATED too (调大输出上限), not 回复不完整.
  t.fetch = async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '[{"i":1,"verdict":"keep"' }, finish_reason: "length" }] }) });
  await assert.rejects(t.triageChat([], 100), (e) => e.code === "AI_TRUNCATED");
  assert.ok(!/截断\/\.test|includes\("截断"\)/.test(PS.text(PS.triage)), "分拣台 matches 截断 by its words; use the code AI_TRUNCATED");
  // A dropped B站 connection says 网络断了, without fetch's English.
  t.fetch = async () => {
    throw new TypeError("Failed to fetch");
  };
  await assert.rejects(t.triageBiliFetch("https://api.bilibili.com/x"), (e) => e.code === "NETWORK" && e.message === "网络断了");

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
  // The platform picked in the side panel (aiProviderId from the page) answers; a missing or disabled pick falls back to the
  // first enabled one, as the side panel does.
  {
    t.loadAiProviders = async () => [
      { id: "off", baseUrl: "https://off.test", model: "o", enabled: false },
      { id: "a", baseUrl: "https://a.test", model: "ma" },
      { id: "b", baseUrl: "https://b.test", model: "mb" }
    ];
    t.fetch = async (url) => ({ ok: true, json: async () => ({ choices: [{ message: { content: url } }] }) });
    const host = async (id) => (await t.triageChat([], 100, false, id)).content.split("/")[2];
    assert.deepStrictEqual([await host("b"), await host(""), await host("gone"), await host("off")], ["b.test", "a.test", "a.test", "a.test"]);
    // C6: 开启思考 shows by the platform the requests go to, not by the first one.
    t.loadAiProviders = async () => [{ id: "a", baseUrl: "https://api.openai.com/v1" }, { id: "b", baseUrl: "https://api.deepseek.com/v1" }];
    const toggle = async (msg) => (await vm.runInContext("TRIAGE_HANDLERS", ctx)["triage-settings-get"](msg)).thinkingToggle;
    assert.deepStrictEqual([await toggle({ aiProviderId: "b" }), await toggle({}), await toggle({ aiProviderId: "gone" })], [true, false, false]);
  }
  t.loadAiProviders = async () => [{ id: "p", baseUrl: "https://ai.test", model: "m" }];

  // An error inside an HTTP 200 reply is recognized as in the side panel's stream; a reply that is not JSON fails this
  // request in Chinese, not with JSON.parse's SyntaxError.
  t.fetch = async () => ({ ok: true, json: async () => ({ error: { message: "You exceeded your current quota" } }) });
  await assert.rejects(t.triageChat([], 100), (e) => e.code === "AI_QUOTA");
  t.fetch = async () => ({ ok: true, json: async () => ({ error: { message: "Rate limit reached" } }) });
  await assert.rejects(t.triageChat([], 100), (e) => e.code === "AI_THROTTLED");
  t.fetch = async () => ({ ok: true, json: async () => JSON.parse("<html>") });
  await assert.rejects(t.triageChat([], 100), (e) => e.code === undefined && e.message === "AI 平台的回复不是 JSON");

  // A request that never settles, even on abort, still ends with the retryable timeout code.
  vm.runInContext("TRIAGE_AI_TIMEOUT_MS.normal = 30; TRIAGE_AI_TIMEOUT_MS.thinking = 60;", ctx);
  let aborted = false;
  t.fetch = (url, { signal }) => {
    signal.addEventListener("abort", () => (aborted = true));
    return new Promise(() => {});
  };
  await assert.rejects(t.triageChat([], 100), (e) => e.code === "AI_TIMEOUT" && e.message === "AI 平台 0.03 秒没有回应");
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
  assert.strictEqual(await settingsWith({ triageIntervalSec: -1 }), 8, "below 0 is the default");
  assert.strictEqual(await settingsWith({ triageIntervalSec: 900 }), 600);
  assert.strictEqual(await settingsWith({ triageIntervalSec: "x" }), 8);
  assert.strictEqual(await settingsWith({}), 8);
  // F7: the batch sizes are whole numbers (rounded) within their range, empty is the default; 每次请求的标题数 is no setting.
  const sizesWith = async (stored) => {
    t.chrome = { storage: { sync: { get: async (d) => ({ ...d, ...stored }) } } };
    const r = await vm.runInContext("TRIAGE_HANDLERS", ctx)["triage-settings-get"]();
    return [r.triageCoarseBatchSize, r.triageFineBatchSize, "triageTitleBatchSize" in r];
  };
  assert.deepStrictEqual(await sizesWith({ triageCoarseBatchSize: 7.9, triageFineBatchSize: 99, triageTitleBatchSize: 5 }), [8, 50, false]);
  assert.deepStrictEqual(await sizesWith({ triageCoarseBatchSize: "", triageFineBatchSize: -3 }), [100, 10, false]);
  assert.deepStrictEqual(await sizesWith({ triageCoarseBatchSize: 0, triageFineBatchSize: 0.4 }), [100, 10, false], "below 1 is the default");
  // AI 打标签每批数量 goes through the settings messages like the others: read clamped, saved by triage-settings-save.
  const aiBatchWith = async (stored) => {
    t.chrome = { storage: { sync: { get: async (d) => ({ ...d, ...stored }) } } };
    return (await vm.runInContext("TRIAGE_HANDLERS", ctx)["triage-settings-get"]()).triageAiBatchSize;
  };
  assert.deepStrictEqual([await aiBatchWith({ triageAiBatchSize: 7.9 }), await aiBatchWith({ triageAiBatchSize: 500 }), await aiBatchWith({})], [8, 100, 30]);
  let savedPatch;
  t.chrome = { storage: { sync: { set: async (p) => void (savedPatch = p) } } };
  await vm.runInContext("TRIAGE_HANDLERS", ctx)["triage-settings-save"]({ type: "triage-settings-save", triageAiBatchSize: 12 });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(savedPatch)), { triageAiBatchSize: 12 });
  // The pages read and write it only through these messages.
  for (const file of PS.triage) assert.ok(!/storage\.sync\.(get|set)\([^)]*triageAiBatchSize/.test(PS.read(file)), `${file} reads or writes triageAiBatchSize itself`);
  // 输出上限: 200–32000, and 0 (自动) is the default, so empty, negative and below 200 are 自动.
  const capsWith = async (v) => {
    t.chrome = { storage: { sync: { get: async (d) => ({ ...d, triageTitleMaxTokens: v, triageAnalyzeMaxTokens: v }) } } };
    const r = await vm.runInContext("TRIAGE_HANDLERS", ctx)["triage-settings-get"]();
    const a = await t.triageAiSettings();
    return [r.triageTitleMaxTokens, r.triageAnalyzeMaxTokens, a.triageTitleMaxTokens, a.triageAnalyzeMaxTokens];
  };
  for (const [v, want] of [["", 0], [-5, 0], [50, 0], [1000.4, 1000], [40000, 32000]]) assert.deepStrictEqual(await capsWith(v), [want, want, want, want], String(v));

  // B站 risk control maps to THROTTLED on writes as well as reads; non-JSON answers get a clear error.
  t.chrome = { cookies: { get: async () => ({ value: "csrf" }) } };
  const jsonRes = (body) => async () => ({ ok: true, status: 200, json: async () => body });
  t.fetch = jsonRes({ code: -352, message: "风控" });
  await assert.rejects(t.triageBiliPost("/x", {}), (e) => e.code === "THROTTLED");
  t.fetch = jsonRes({ code: -412, message: "请求被拦截" });
  await assert.rejects(t.triageBiliGet("https://api.test"), (e) => e.code === "THROTTLED");
  // -799 / -509 too, as 关注 has always treated them (one BILI_RISK_CODES for both).
  for (const code of [-799, -509]) {
    t.fetch = jsonRes({ code, message: "请求过于频繁" });
    await assert.rejects(t.triageBiliGet("https://api.test"), (e) => e.code === "THROTTLED", String(code));
  }
  t.fetch = async () => ({ ok: false, status: 412, json: async () => ({}) });
  await assert.rejects(t.triageBiliPost("/x", {}), (e) => e.code === "THROTTLED" && e.message === t.MdgErrors.TEXT.biliThrottled, "a write's 412 says 限流, not HTTP 412");
  // nav under risk control is 限流, not 未登录.
  t.fetch = jsonRes({ code: -352, message: "风控" });
  await assert.rejects(t.triageMid(), (e) => e.code === "THROTTLED");
  // HTTP 429 is risk control too, as in sites.js biliJson.
  t.fetch = async () => ({ ok: false, status: 429, json: async () => ({}) });
  await assert.rejects(t.triageBiliGet("https://api.test"), (e) => e.code === "THROTTLED" && e.status === 429);
  // N5: a write after the login expired is NOT_LOGGED_IN (the page shows 去登录), with a plain message.
  t.fetch = jsonRes({ code: -101, message: "账号未登录" });
  await assert.rejects(t.triageBiliPost("/x", {}), (e) => e.code === "NOT_LOGGED_IN" && e.message === t.MdgErrors.TEXT.biliLogin);
  t.fetch = jsonRes({ code: 11010, message: "内容不存在" });
  await assert.rejects(t.triageBiliPost("/x", {}), (e) => e.code === undefined);
  t.fetch = async () => ({ ok: true, status: 200, json: async () => JSON.parse("<html>") });
  await assert.rejects(t.triageMid(), /不是 JSON/);
  t.fetch = async () => ({ ok: false, status: 502, json: async () => ({}) });
  await assert.rejects(t.triageMid(), /HTTP 502/);
  // 收藏夹 reads use 关注's channel: no answer in time is NETWORK instead of hanging forever.
  vm.runInContext("TRIAGE_BILI_CFG.timeoutMs = 20", ctx);
  t.fetch = () => new Promise(() => {});
  const within = (p) => Promise.race([p, new Promise((_, reject) => setTimeout(() => reject(new Error("hangs")), 500))]);
  await assert.rejects(within(t.triageBiliGet("https://api.test")), (e) => e.code === "NETWORK" && /没有回应/.test(e.message));
  await assert.rejects(within(t.triageMid()), (e) => e.code === "NETWORK");
  // Headers in, body never: the same timeout ends it and aborts the request.
  let signal = null;
  t.fetch = async (url, init) => ((signal = init.signal), { ok: true, status: 200, json: () => new Promise(() => {}) });
  await assert.rejects(within(t.triageBiliGet("https://api.test")), (e) => e.code === "NETWORK" && /没有回应/.test(e.message));
  assert.ok(signal.aborted, "the request is aborted");
  // A write that gets no answer is not tried again and says the outcome is unknown.
  let posts = 0;
  t.fetch = () => (posts++, new Promise(() => {}));
  await assert.rejects(within(t.triageBiliPost("/x", {})), (e) => e.code === "NETWORK" && /^网络断了：[0-9.]+ 秒没有回应：不确定 B站 是否已改/.test(e.message), "says which: no answer in time");
  assert.strictEqual(posts, 1, "a write is sent once");
  vm.runInContext("TRIAGE_BILI_CFG.timeoutMs = 30000", ctx);

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
  assert.strictEqual(partial.partial.error, t.MdgErrors.TEXT.biliThrottled, "risk control in a B站 answer says 限流, not 「B站返回 -352」");
  // R4: an empty page that says there is more is partial too: the videos after it were not read, not removed.
  t.fetch = async (url) => jsonRes({ code: 0, data: { medias: new URL(url).searchParams.get("pn") === "1" ? [media(1)] : [], has_more: true } })();
  const empty = await folderItems({ mediaId: 1 });
  assert.deepStrictEqual([empty.items.length, empty.partial?.page, empty.ids], [1, 2, undefined]);
  t.fetch = jsonRes({ code: -352, message: "风控" });
  await assert.rejects(folderItems({ mediaId: 1 }), (e) => e.code === "THROTTLED");
  t.fetch = jsonRes({ code: 0, data: { medias: [media(3)], has_more: false } });
  assert.strictEqual((await folderItems({ mediaId: 1 })).partial, undefined);
  // 播放量 is mapped from the list itself: cnt_info.play for a folder, stat.view for 稍后再看; none stays undefined.
  t.fetch = jsonRes({ code: 0, data: { medias: [{ ...media(4), cnt_info: { play: 1234 } }, media(5)], has_more: false } });
  assert.deepStrictEqual([...(await folderItems({ mediaId: 1 })).items.map((it) => it.play)], [1234, undefined]);
  t.fetch = jsonRes({ code: 0, data: { list: [{ bvid: "BV6", aid: 6, title: "t6", state: 0, stat: { view: 77 } }, { bvid: "BV7", aid: 7, title: "t7", state: 0 }] } });
  assert.deepStrictEqual([...(await folderItems({ mediaId: "toview" })).items.map((it) => it.play)], [77, undefined]);
  // The UP's mid is kept (as a string) for the player's UP 标签 line; none when B站 gives none.
  t.fetch = jsonRes({ code: 0, data: { medias: [{ ...media(4), upper: { mid: 42, name: "甲" } }, media(5)], has_more: false } });
  assert.deepStrictEqual([...(await folderItems({ mediaId: 1 })).items.map((it) => it.upperMid)], ["42", undefined]);
  t.fetch = jsonRes({ code: 0, data: { list: [{ bvid: "BV6", aid: 6, title: "t6", state: 0, owner: { mid: 43, name: "乙" } }] } });
  assert.strictEqual((await folderItems({ mediaId: "toview" })).items[0].upperMid, "43");
  // With known, loading stops after the first page that is all known and returns just those pages as head.
  const pages = [];
  t.fetch = async (url) => {
    const pn = Number(new URL(url).searchParams.get("pn"));
    pages.push(pn);
    return jsonRes({ code: 0, data: { medias: pn === 1 ? [media(9), media(1)] : [media(2), media(3)], has_more: true } })();
  };
  const head = await folderItems({ mediaId: 1, known: ["BV1", "BV2", "BV3"] });
  assert.deepStrictEqual(JSON.parse(JSON.stringify([pages, head.items.map((it) => it.bvid), head.head])), [[1, 2], ["BV9", "BV1", "BV2", "BV3"], true]);
  // A 番剧 episode (type 24) is listed only with platform=web. Its id is the episode id; its aid is the archive's, from the
  // list's bvid (BV14X4y1G7C7 is av714816118), and it is marked ogv. ids keys it by "id:type", not the BV id it
  // miscomputes from the episode id. Audio (12) stays out.
  const urls = [];
  t.fetch = async (url) => {
    urls.push(url);
    return /resource\/ids/.test(url)
      ? jsonRes({ code: 0, data: [{ id: 1, type: 2, bvid: "BV1" }, { id: 397236, type: 24, bvid: "BV11x411F7Tx" }, { id: 5, type: 12, bvid: "BVa" }] })()
      : jsonRes({ code: 0, data: { medias: [media(1), { id: 397236, type: 24, bvid: "BV14X4y1G7C7", title: "造物说", intro: "第1集 另一个我", attr: 0, cnt_info: { play: 0 }, ogv: { season_id: 38374 } }, { ...media(5), type: 12 }], has_more: false } })();
  };
  const ogv = await folderItems({ mediaId: 1 });
  assert.match(urls[0], /resource\/list\?.*&platform=web/);
  assert.deepStrictEqual(plain(ogv.items.map(({ bvid, aid, ogv, title, intro, play }) => ({ bvid, aid, ogv, title, intro, play }))), [
    { bvid: "BV1", aid: 1, title: "t1" },
    { bvid: "BV14X4y1G7C7", aid: "714816118", ogv: true, title: "造物说 第1集 另一个我", intro: "" }
  ]);
  assert.deepStrictEqual(plain(ogv.ids), ["BV1", "397236:24"]);
  assert.deepStrictEqual(["BV1GJ411x7h7", "BV17x411w7KC", "x"].map(vm.runInContext("triageBvToAv", ctx)), ["80433022", "170001", ""]);

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
  const aiAnswer = { ok: true, json: async () => ({ choices: [{ message: { content: '{"one_liner":"x","points":["a"],"verdict":"keep","reason":"r"}' } }] }) };
  const subUrl = "https://aisubtitle.hdslb.com/bfs/ai_subtitle/BVa.json";
  const subtitleKey = "mdg_subtitle_cache_BVa_11_id_5";
  const subtitleRaw = (to) => ({ body: [{ from: 0, to: 1, content: "第一句" }, { from: 1, to, content: "最后一句" }] });
  let routes;
  const calls = [];
  const inits = [];
  // B站 reads go through triageBiliFetch (fetch); a route's Error with a status is that HTTP answer, without one a
  // dropped connection. Anything else is the AI.
  t.fetch = async (url, init) => {
    if (!/bilibili\.com|hdslb\.com/.test(url)) return (prompt = JSON.parse(init.body).messages[1].content), aiAnswer;
    calls.push(url);
    inits.push(init);
    const answer = routes[Object.keys(routes).find((part) => url.includes(part))];
    if (answer === "hang") return new Promise(() => {});
    if (answer instanceof Error && !answer.status) throw answer;
    return answer instanceof Error ? { ok: false, status: answer.status } : { ok: true, status: 200, json: async () => answer };
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
  // X5: one B站 channel: 细看 reads carry the B站 referrer, uncached, with the cookies.
  assert.ok(inits.length && inits.every((i) => i.referrer === "https://www.bilibili.com/" && i.referrerPolicy === "strict-origin-when-cross-origin" && i.cache === "no-store" && i.credentials === "include"), JSON.stringify(inits[0]));
  assert.ok(prompt.includes("分区：知识") && prompt.includes("标签：标签") && prompt.includes("发布：2024-05-30") && prompt.includes("第一句\n最后一句"));
  assert.ok(prompt.includes("字幕：\n第一句") && !prompt.includes("热门评论") && !calls.some((u) => u.includes("/reply/main")), "with subtitles no comments are fetched or sent");

  // A fetched subtitle that passes the duration guard is cached for the video page.
  delete store[subtitleKey];
  assert.strictEqual((await analyze()).source, "subtitle");
  assert.deepStrictEqual(store[subtitleKey].raw, subtitleRaw(272));

  // A subtitle that does not match the video's length is used with the video page's warning, and is not cached.
  delete store[subtitleKey];
  routes = { ...baseRoutes(), [subUrl]: subtitleRaw(400) };
  const mismatched = await analyze();
  assert.deepStrictEqual([mismatched.source, mismatched.subtitleWarning], ["subtitle", "字幕时间轴到 06:40，视频长 04:33，字幕时间可能对不上。"]);
  assert.strictEqual(subtitleKey in store, false);
  // Without a duration to check against it is used as is, like on the video page.
  routes = baseRoutes();
  routes["/view/detail"].data.View.duration = 0;
  routes["/view/detail"].data.View.pages[0].duration = 0;
  routes[subUrl] = subtitleRaw(400);
  const unchecked = await analyze();
  assert.deepStrictEqual([unchecked.source, unchecked.subtitleWarning], ["subtitle", undefined]);
  delete store[subtitleKey];

  // Without subtitles the comments are sent.
  const emptyList = { code: 0, data: { subtitle: { subtitles: [] } } };
  routes = { ...baseRoutes(), "/x/player/wbi/v2": emptyList };
  assert.strictEqual((await analyze()).source, "meta");
  assert.ok(prompt.includes("视频没有字幕。\n热门评论：\n1. 评论一"));

  // Without subtitles, a comment fetch failure does not fail the analysis.
  routes = { ...baseRoutes(), "/x/player/wbi/v2": emptyList, "/reply/main": new Error("network") };
  assert.strictEqual((await analyze()).source, "meta");
  assert.ok(prompt.includes("视频没有字幕。\n热门评论：\n无"));

  // Subtitles hidden from a logged-out user: judged without them, and the result says why (the card shows it).
  routes = { ...baseRoutes(), "/x/player/wbi/v2": { code: 0, data: { subtitle: { subtitles: [] }, need_login_subtitle: true } } };
  assert.deepStrictEqual([(await analyze()).source, (await analyze()).needLogin], ["meta", true]);
  // L1: the AI hears why, as in the side panel, and that the video may have subtitles after all.
  assert.ok(prompt.includes("未登录 B站，拿不到字幕。视频本身可能有字幕，不要说视频没有字幕。\n热门评论："), prompt);
  routes = { ...baseRoutes(), [subUrl]: { body: [] } };
  assert.strictEqual((await analyze()).needLogin, undefined, "a bad subtitle is not a login problem");
  assert.ok(prompt.includes("字幕抓取失败：字幕文件为空。视频本身可能有字幕，不要说视频没有字幕。"));
  assert.strictEqual(["../background.js", "triage-bg.js"].map((f) => fs.readFileSync(path.join(__dirname, f), "utf8").split("视频本身可能有字幕").length - 1).join(), "0,1", "the reminder is written once (aiSubtitleMissing)");

  // A subtitle up to the cap goes in whole; a longer one is sampled down to the cap.
  const line = "一句字幕".repeat(10);
  const longRaw = (n) => ({ body: Array.from({ length: n }, (_, i) => ({ from: i, to: i === n - 1 ? 272 : i + 1, content: line })) });
  const whole = Math.floor(t.MdgLimits.AI_SUBTITLE_MAX_CHARS / (line.length + 1));
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
  // X5: no answer in TRIAGE_BILI_CFG.timeoutMs (30 s) is NETWORK, in Chinese.
  vm.runInContext("TRIAGE_BILI_CFG.timeoutMs = 30;", ctx);
  routes = { ...baseRoutes(), "/view/detail": "hang", "/view": "hang" };
  await assert.rejects(analyze(), (e) => e.code === "NETWORK" && e.message.startsWith("网络断了"));
  vm.runInContext("TRIAGE_BILI_CFG.timeoutMs = 30000;", ctx);
  routes = { ...baseRoutes(), "/x/player/wbi/v2": { code: -352, message: "风控" }, "/x/player/v2": { code: -352, message: "风控" } };
  await assert.rejects(analyze(), (e) => e.code === "THROTTLED");
  routes = { ...baseRoutes(), "/x/player/wbi/v2": { code: -799, message: "请求过于频繁" }, "/x/player/v2": { code: -799, message: "请求过于频繁" } };
  await assert.rejects(analyze(), (e) => e.code === "THROTTLED", "-799 through the sites.js fetchers");
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
  // A failed download: judged on the description and comments, and the card says 字幕抓取失败 with the reason.
  routes = { ...baseRoutes(), [subUrl]: new TypeError("Failed to fetch") };
  const failedSub = await analyze();
  assert.deepStrictEqual([failedSub.source, failedSub.subtitleFailure], ["meta", "网络断了"]);
  assert.strictEqual((await (routes = { ...baseRoutes(), "/x/player/wbi/v2": emptyList }, analyze())).subtitleFailure, undefined, "no subtitles is not a failure");
  // So does a track list that cannot be read (the player API drops the connection), as on the video page.
  const listDown = () => ({ ...baseRoutes(), "/x/player/wbi/v2": new TypeError("Failed to fetch"), "/x/player/v2": new TypeError("Failed to fetch") });
  routes = listDown();
  const listFailed = await analyze();
  assert.deepStrictEqual([listFailed.source, listFailed.subtitleFailure], ["meta", "网络断了"]);

  // Notes: throttling writes nothing (the caller waits and retries); a failed subtitle download writes the note without
  // it, saying so like the video page's note; another video's subtitle is dropped, not cached.
  const buildNote = () => t.triageBuildNote("BVa", {});
  routes = { ...baseRoutes(), "/x/player/wbi/v2": { code: -352, message: "风控" }, "/x/player/v2": { code: -352, message: "风控" } };
  await assert.rejects(buildNote(), (e) => e.code === "THROTTLED");
  // A deleted video rejects with Bilibili's code, which the pages read as gone, in the project's words (C369); a
  // throttled view does not.
  routes = { ...baseRoutes(), "/view/detail": { code: -404, message: "啥都木有" }, "/web-interface/view?": { code: -404, message: "啥都木有" } };
  await assert.rejects(buildNote(), (e) => e.code === -404 && e.message === "视频已失效" && t.MdgSites.isBiliVideoGone(e.code));
  routes = { ...baseRoutes(), "/view/detail": { code: -352, message: "风控" }, "/web-interface/view?": { code: -352, message: "风控" } };
  await assert.rejects(buildNote(), (e) => e.code === "THROTTLED" && !t.MdgSites.isBiliVideoGone(e.code));
  routes = { ...baseRoutes(), [subUrl]: Object.assign(new Error("HTTP 403"), { status: 403 }) };
  const noSub = await buildNote();
  assert.deepStrictEqual([noSub.body.length, noSub.subtitleWarning], [0, "字幕抓取失败：B站请求失败 HTTP 403。"]);
  assert.ok(noSub.markdown.includes("> 字幕抓取失败：B站请求失败 HTTP 403，以下为简介与热门评论。"), noSub.markdown);
  routes = listDown();
  assert.deepStrictEqual([(await buildNote()).body.length, (await buildNote()).subtitleWarning], [0, "字幕抓取失败：网络断了。"]);
  // Not logged in: its own sentence on the result list and in the note, which says no more than that.
  routes = { ...baseRoutes(), "/x/player/wbi/v2": { code: 0, data: { subtitle: { subtitles: [] }, need_login_subtitle: true } } };
  const loggedOut = await buildNote();
  assert.strictEqual(loggedOut.subtitleWarning, "未登录 B站，拿不到字幕。");
  assert.ok(loggedOut.markdown.includes("> 未登录 B站，拿不到字幕，以下为简介与热门评论。") && !/请登录|刷新网页/.test(loggedOut.markdown), loggedOut.markdown);
  // A subtitle that does not match the video's length is kept with the video page's warning, and is not cached.
  routes = { ...baseRoutes(), [subUrl]: subtitleRaw(400) };
  const keptNote = await buildNote();
  assert.deepStrictEqual([keptNote.body.length, keptNote.subtitleWarning], [2, "字幕时间轴到 06:40，视频长 04:33，字幕时间可能对不上。"]);
  assert.strictEqual(subtitleKey in store, false);
  routes = { ...baseRoutes(), "/x/player/wbi/v2": noTracks };
  assert.strictEqual((await buildNote()).body.length, 0);
  routes = baseRoutes();
  assert.strictEqual((await buildNote()).body.length, 2);
  // Like the video page, the next track is tried when the first does not match the video's length (or fails to load).
  const enUrl = "https://aisubtitle.hdslb.com/bfs/ai_subtitle/BVa-en.json";
  const twoTracks = { code: 0, data: { subtitle: { subtitles: [...withTracks.data.subtitle.subtitles, { id: 6, lan: "ai-en", lan_doc: "English", subtitle_url: enUrl }] } } };
  delete store[subtitleKey];
  for (const first of [subtitleRaw(400), new Error("network")]) {
    routes = { ...baseRoutes(), "/x/player/wbi/v2": twoTracks, [subUrl]: first, [enUrl]: subtitleRaw(272) };
    const built = await buildNote();
    assert.deepStrictEqual([built.body.length, built.noteMeta.selectedSubtitleLang], [2, "English"]);
  }
  // Without chapters from the player, the description's timestamps give them, as on the video page.
  routes = baseRoutes();
  routes["/view/detail"].data.View.desc = "00:00 开场\n01:30 正题";
  assert.match((await buildNote()).markdown, /## 章节\n\n[^\n]*开场[\s\S]*正题/);

  // The built note's path and cover (obsidian.js writes with them): {{author}} and {{upload_date}} need the API meta,
  // and the cover is downloaded into the vault.
  routes = baseRoutes();
  routes["/view/detail"].data.View.pic = "http://i0.hdslb.com/bfs/archive/a.jpg";
  t.getMergedSettings = async () => ({ noteFolder: "B站/{{author}}/{{upload_date}}" });
  const builtNote = await vm.runInContext("TRIAGE_HANDLERS", ctx)["triage-build-note"]({ bvid: "BVa" });
  assert.strictEqual(builtNote.path, `B站/UP/2024-05-30/${builtNote.filename}`);
  assert.deepStrictEqual(plain(builtNote.cover), { url: "https://i0.hdslb.com/bfs/archive/a.jpg", name: "bilibili-BVa" });
  delete t.getMergedSettings;
  // The .zip names a note a write recorded after its file in the vault (dated the day it was first written), as 下载 .md.
  const fresh = await buildNote();
  const pathsKey = t.MdgLimits.KEYS.obsidianNotePaths;
  store[pathsKey] = { [t.MdgSites.buildContextKey(fresh.noteMeta)]: { path: "B站/UP/2026-01-01-旧名.md" } };
  assert.deepStrictEqual([fresh.filename, (await buildNote()).filename], [t.MdgNote.buildNoteFilename(fresh.noteMeta, {}), "2026-01-01-旧名.md"]);
  delete store[pathsKey];

  // The note section comes from triage_notes (per video), not from the basket item.
  store.triage_basket = [{ bvid: "BVa", note: "篮子里的旧笔记" }];
  store.triage_notes = { BVa: { text: "视频笔记", updatedAt: 1 } };
  const noted = (await buildNote()).markdown;
  assert.ok(noted.includes("## 备注\n\n视频笔记") && !noted.includes("篮子里的旧笔记"));
  // The 分拣 tags go into the note's tags, read the same way as on the video page (MdgNote.triageExtras).
  store.triage_tags = [{ id: "t1", name: "好看" }];
  store.triage_video_tags = { BVa: ["t1", "t1"] };
  assert.match((await buildNote()).markdown, /\ntags: \["好看"\]\n/);

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
  // A UP tag chip's deep link: a new tab opens on it, an open tab gets it as its new hash; anything else opens the plain page.
  tabCalls.length = 0;
  t.chrome = fakeTabs([]);
  await vm.runInContext("TRIAGE_HANDLERS", ctx)["triage-open"]({ hash: "follow&tag=t%E5%AD%A61" });
  await vm.runInContext("TRIAGE_HANDLERS", ctx)["triage-open"]({ hash: "javascript:alert(1)" });
  await vm.runInContext("TRIAGE_HANDLERS", ctx)["triage-open"]({ hash: "follow&up=546195" });
  await vm.runInContext("TRIAGE_HANDLERS", ctx)["triage-open"]({ hash: "follow&up=1&tag=x" });
  t.chrome = fakeTabs([{ tabId: 4, windowId: 2, documentUrl: "chrome-extension://id/triage/triage.html#favorites" }]);
  t.chrome.tabs.update = async (id, o) => tabCalls.push(["update", id, o.url]);
  await vm.runInContext("TRIAGE_HANDLERS", ctx)["triage-open"]({ hash: "follow&tag=abc" });
  assert.deepStrictEqual(tabCalls, [
    ["create", "chrome-extension://id/triage/triage.html#follow&tag=t%E5%AD%A61"],
    ["create", "chrome-extension://id/triage/triage.html"],
    ["create", "chrome-extension://id/triage/triage.html#follow&up=546195"],
    ["create", "chrome-extension://id/triage/triage.html"],
    ["update", 4, "chrome-extension://id/triage/triage.html#follow&tag=abc"],
    ["window", 2, true]
  ]);
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
    // R34: a limited removal is thrown as it is (the run waits and sends the same video again; the add is idempotent);
    // any other failed removal answers the video as stayed, with the reason: it is in the target and still in 稍后再看.
    const realFetch = t.fetch;
    t.fetch = async (url, opts) => (/toview\/del/.test(url) ? { ok: true, status: 200, json: async () => ({ code: -352, message: "风控" }) } : realFetch(url, opts));
    await assert.rejects(H["triage-transfer"]({ from: "toview", to: "2", aids: [10], move: true }), (e) => e.code === "THROTTLED");
    t.fetch = async (url, opts) => (/toview\/del/.test(url) ? { ok: true, status: 200, json: async () => ({ code: 90001, message: "不在稍后再看里" }) } : realFetch(url, opts));
    assert.deepStrictEqual(plain(await H["triage-transfer"]({ from: "toview", to: "2", aids: [10, 11], move: true })), { done: 2, stayed: [10, 11], stayedError: "B站返回 90001：不在稍后再看里" });
    t.fetch = realFetch;
    calls.length = 0;
    await H["triage-transfer"]({ from: "", to: "2", aids: [10, 11], move: false });
    assert.deepStrictEqual(calls.splice(0).map((c) => c[0]), ["/x/v3/fav/resource/deal", "/x/v3/fav/resource/deal"]);
    await assert.rejects(H["triage-transfer"]({ from: "1", to: "toview", aids: [10], move: true }), /缺少目标/);
    await assert.rejects(H["triage-transfer"]({ from: "1", to: "1", aids: [10], move: true }), /缺少目标/);
    // C528: an id that is not digits never reaches B站's form fields (an aid "10:2,99" would add a resource).
    const sentBefore = calls.length;
    await assert.rejects(H["triage-transfer"]({ from: "1", to: "2", aids: ["10:2,99"], move: false }), /缺少目标/);
    await assert.rejects(H["triage-transfer"]({ from: { x: 1 }, to: "2", aids: [10], move: false }), /缺少目标/);
    await assert.rejects(H["triage-unfav"]({ mediaId: "1", aids: [10, "11,12"] }), /缺少 mediaId 或 aids/);
    await assert.rejects(H["triage-unfav"]({ mediaId: ["1"], aids: [10] }), /缺少 mediaId 或 aids/);
    await assert.rejects(H["triage-refav"]({ mediaId: "1", aid: "10&x=1" }), /缺少 mediaId 或 aid/);
    await assert.rejects(H["triage-fav-where"]({ aid: true }), /缺少 aid/);
    assert.strictEqual(calls.length, sentBefore, "nothing was sent");
    assert.deepStrictEqual(plain(await H["triage-folder-create"]({ title: " 新夹 ", privacy: true })), { id: 42, title: "新夹" });
    assert.deepStrictEqual(calls.pop(), ["/x/v3/fav/folder/add", { title: "新夹", intro: "", privacy: "1", cover: "", csrf: "csrf" }]);
    await assert.rejects(H["triage-folder-create"]({ title: "  " }), /不能为空/);
    // G6: a known mid skips nav; the answer carries the mid for the next call.
    const urls = [];
    t.fetch = async (url) => (urls.push(new URL(url).pathname), { ok: true, status: 200, json: async () => ({ code: 0, data: /nav/.test(url) ? { isLogin: true, mid: 7 } : { list: [{ id: 3, title: "甲", fav_state: 1 }] } }) });
    assert.deepStrictEqual(plain(await H["triage-fav-where"]({ aid: 1 })), { mid: 7, folders: [{ id: "3", title: "甲" }] });
    await H["triage-fav-where"]({ aid: 2, mid: 7 });
    assert.deepStrictEqual(urls.filter((u) => /nav/.test(u)).length, 1);
    // A 番剧 favorite comes as "aid:42" (fav-base.js favRes): folder writes and lookups name it so, the form B站 takes for
    // it; 稍后再看 gets the bare aid. A video's stays "aid:2" and its bare aid.
    t.fetch = async (url, opts) => {
      if (/web-interface\/nav/.test(url)) return { ok: true, status: 200, json: async () => ({ code: 0, data: { isLogin: true, mid: 7 } }) };
      const u = new URL(url);
      calls.push([u.pathname, Object.fromEntries(opts?.body ? new URLSearchParams(opts.body) : u.searchParams)]);
      return { ok: true, status: 200, json: async () => ({ code: 0, data: { list: [] } }) };
    };
    calls.length = 0;
    const O = "714816118:42";
    await H["triage-unfav"]({ mediaId: "1", aids: [10, O] });
    await H["triage-transfer"]({ from: "1", to: "2", aids: [O, 11], move: true });
    await H["triage-transfer"]({ from: "1", to: "2", aids: [O], move: false });
    await H["triage-refav"]({ mediaId: "1", aid: O });
    await H["triage-refav"]({ mediaId: "1", aid: 10 });
    await H["triage-transfer"]({ from: "", to: "2", aids: [O], move: false });
    await H["triage-fav-where"]({ aid: O, mid: 7 });
    await H["triage-fav-where"]({ aid: 10, mid: 7 });
    await H["triage-unfav"]({ mediaId: "toview", aids: [O, 10] });
    await H["triage-refav"]({ mediaId: "toview", aid: O });
    await H["triage-transfer"]({ from: "toview", to: "2", aids: [O], move: true });
    assert.deepStrictEqual(plain(calls.splice(0).map(([p, f]) => [p, f.resources || (f.rid ? `${f.rid}:${f.type}` : f.aid)])), [
      ["/x/v3/fav/resource/batch-del", "10:2,714816118:42"],
      ["/x/v3/fav/resource/move", "714816118:42,11:2"],
      ["/x/v3/fav/resource/copy", "714816118:42"],
      ["/x/v3/fav/resource/deal", "714816118:42"],
      ["/x/v3/fav/resource/deal", "10:2"],
      ["/x/v3/fav/resource/deal", "714816118:42"],
      ["/x/v3/fav/folder/created/list-all", "714816118:42"],
      ["/x/v3/fav/folder/created/list-all", "10:2"],
      ["/x/v2/history/toview/del", "714816118"],
      ["/x/v2/history/toview/del", "10"],
      ["/x/v2/history/toview/add", "714816118"],
      ["/x/v3/fav/resource/deal", "714816118:42"],
      ["/x/v2/history/toview/del", "714816118"]
    ]);
    // Only 42 rides along: an episode id ("397236:24") or any other type never reaches B站.
    await assert.rejects(H["triage-unfav"]({ mediaId: "1", aids: ["397236:24"] }), /缺少 mediaId 或 aids/);
    await assert.rejects(H["triage-refav"]({ mediaId: "1", aid: "10:12" }), /缺少 mediaId 或 aid/);
    assert.strictEqual(calls.length, 0, "nothing was sent");
  }

  // The folder list pages through created/list (which carries the cover) until has_more is false; covers are https.
  {
    const H = vm.runInContext("TRIAGE_HANDLERS", ctx);
    const pages = [];
    t.fetch = async (url) => {
      const u = new URL(url);
      if (/web-interface\/nav/.test(url)) return { ok: true, status: 200, json: async () => ({ code: 0, data: { isLogin: true, mid: 7 } }) };
      if (/toview/.test(url)) return { ok: true, status: 200, json: async () => ({ code: 0, data: { count: 3, list: [{ pic: "http://i1.hdslb.com/t.jpg" }] } }) };
      assert.strictEqual(u.pathname, "/x/v3/fav/folder/created/list");
      const pn = Number(u.searchParams.get("pn"));
      pages.push(pn);
      const list = pn === 1 ? [{ id: 1, title: "甲", media_count: 4, cover: "//i0.hdslb.com/a.jpg" }] : [{ id: 2, title: "乙", media_count: 1, cover: "" }];
      return { ok: true, status: 200, json: async () => ({ code: 0, data: { list, has_more: pn === 1 } }) };
    };
    const r = plain(await H["triage-folders"]());
    assert.deepStrictEqual(pages, [1, 2]);
    assert.deepStrictEqual(r.folders, [
      { id: "toview", title: "稍后再看", count: 3, cover: "https://i1.hdslb.com/t.jpg" },
      { id: 1, title: "甲", count: 4, cover: "https://i0.hdslb.com/a.jpg" },
      { id: 2, title: "乙", count: 1, cover: "" }
    ]);    assert.ok(!("toviewUnread" in r));
    // R12: a failed 稍后再看 read says so instead of leaving it out as if deleted.
    const realFetch = t.fetch;
    t.fetch = async (url) => (/toview/.test(url) ? { ok: true, status: 200, json: async () => ({ code: -101, message: "账号未登录" }) } : realFetch(url));
    const failed = plain(await H["triage-folders"]());
    assert.deepStrictEqual([failed.toviewUnread, failed.folders.map((f) => f.id)], [true, [1, 2]]);
    t.fetch = realFetch;
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
    // J20: a chosen folder's videos take no place in the newest 5000.
    const full = Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [`BV${i}`, [80, nowS - 100 - i]]));
    assert.deepStrictEqual(plain(t.seenPrune({ ...full, BVfav: [80, nowS] }, new Set(["BVfav"]), nowS)), [], "5000 others plus one in a folder: none dropped");
    assert.deepStrictEqual(plain(t.seenPrune({ ...full, BVx: [80, nowS] }, new Set(), nowS)), ["BV4999"]);

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
          get: async (k) => (k === null ? structuredClone(st) : Object.fromEntries([].concat(k).filter((x) => x in st).map((x) => [x, structuredClone(st[x])]))),
          set: async (o) => Object.assign(st, structuredClone(o)),
          remove: async (keys) => [].concat(keys).forEach((x) => delete st[x])
          // No getKeys: Chrome before 130 has none, reading every key by get(null).
        }
      }
    };
    t.fetch = async (url) => {
      urls.push(url);
      const body = pages.shift() || { code: 0, data: { list: [], cursor: { max: 0 } } };
      return { ok: true, status: 200, json: async () => body };
    };
    const H = vm.runInContext("TRIAGE_HANDLERS", ctx);
    // The message answers as a read starts; read() waits for the read itself (or the skip).
    const read = async (m) => {
      const reply = H["triage-seen-sync"](m);
      const run = vm.runInContext("seenRun", ctx);
      return run ? (await reply, run) : reply;
    };
    // The message listener only routes triage-* types: a handler named otherwise is never reached.
    assert.deepStrictEqual(Object.keys(H).filter((k) => !k.startsWith("triage-")), []);
    assert.deepStrictEqual(plain(await read()), { skipped: "off" });
    assert.strictEqual(urls.length, 0, "nothing is read with both switches off");
    sync = { seenShow: "bar" };
    const T = Math.floor(Date.now() / 1000) - 1000; // view_at in seconds, recent enough to survive the prune
    const page = (list, max) => ({ code: 0, data: { list, cursor: { max, view_at: 1, business: "archive" } } });
    st.seen_BVa = [95, T - 500];
    pages = [page([h("BVa", T + 300, 50), h("BVb", T + 290, 100)], 7), page([h("BVc", T + 280, -1)], 0)];
    const first = await read();
    assert.strictEqual(first.pages, 2);
    assert.deepStrictEqual([plain(st.seen_BVa), plain(st.seen_BVb), plain(st.seen_BVc)], [[95, T + 300], [100, T + 290], [100, T + 280]], "keeps the higher stored percent");
    assert.strictEqual(st.triage_seen_meta.newest, T + 300);
    assert.deepStrictEqual(plain(await read()), { skipped: "recent" });
    pages = [page([h("BVd", T + 310, 30), h("BVa", T + 300, 50)], 9)];
    const again = await read({ force: true });
    assert.strictEqual(again.pages, 1, "a later read stops at what it already has");
    assert.deepStrictEqual(plain(st.seen_BVd), [30, T + 310]);
    // Risk control on page 2: page 1 is already written and the read resumes there; `newest` stays until a read gets down to it.
    const realTimeout = t.setTimeout;
    // skip the 5 s page gap, and let each gap pass 5 minutes on the worker's clock: the pause counts from the risk control.
    const WorkerDate = vm.runInContext("Date", t);
    const realNow = WorkerDate.now;
    let skew = 0;
    WorkerDate.now = () => realNow() + skew;
    t.setTimeout = (f, ms) => (ms === 5000 && (skew += 5 * 60000), realTimeout(f, ms === 5000 ? 0 : ms));
    pages = [page([h("BVe", T + 330, 40)], 5), { code: -412, message: "请求被拦截" }];
    await assert.rejects(read({ force: true }), (e) => e.code === "THROTTLED");
    assert.ok(skew > 0 && st.triage_seen_meta.backoffUntil >= WorkerDate.now() + 30 * 60000 - 5000, "risk control backs off 30 minutes from now");
    WorkerDate.now = realNow;
    assert.deepStrictEqual(plain(st.seen_BVe), [40, T + 330], "pages read before risk control are kept");
    assert.deepStrictEqual([st.triage_seen_meta.newest, st.triage_seen_meta.resume.cursor.max], [T + 310, 5]);
    const before = urls.length;
    const held = await read({ force: true });
    assert.deepStrictEqual(plain(held), { skipped: "throttled", until: st.triage_seen_meta.backoffUntil }, "says until when, for the page to show");
    assert.strictEqual(urls.length, before, "no request while backing off");
    // After the wait: the older pages it did not reach first (down to the old `newest`), then what is new since.
    st.triage_seen_meta.backoffUntil = 0;
    pages = [page([h("BVf", T + 320, 60), h("BVd", T + 310, 30)], 3), page([h("BVg", T + 340, 20), h("BVe", T + 330, 40)], 2)];
    const resumed = await read({ force: true });
    t.setTimeout = realTimeout;
    assert.strictEqual(resumed.pages, 2);
    assert.match(urls[before], /max=5&/, "picks up where the stopped read was");
    assert.match(urls[before + 1], /max=0&/);
    assert.deepStrictEqual([plain(st.seen_BVf), plain(st.seen_BVg)], [[60, T + 320], [20, T + 340]]);
    assert.deepStrictEqual([st.triage_seen_meta.newest, st.triage_seen_meta.resume], [T + 340, null]);
    // The message does not stay open for the read: it answers while the first page is still on its way, and a second
    // message during the read answers the same without starting another.
    let release;
    const realFetch = t.fetch;
    t.fetch = (url) => new Promise((r) => (release = () => r(realFetch(url))));
    const ended = [];
    t.chrome.runtime.sendMessage = async (m) => ended.push(m);
    pages = [page([h("BVh", T + 350, 10)], 0)];
    assert.deepStrictEqual(plain(await H["triage-seen-sync"]({ force: true })), { reading: true });
    assert.deepStrictEqual(plain(await H["triage-seen-sync"]({ force: true })), { reading: true });
    assert.strictEqual(st.seen_BVh, undefined);
    const run = vm.runInContext("seenRun", ctx);
    release();
    await run;
    assert.deepStrictEqual([plain(st.seen_BVh), ended.map((m) => m.type)], [[10, T + 350], ["triage-seen-done"]]);
    // C518: a read that fails (not on B站限流) tells the page why.
    ended.length = 0;
    t.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
    st.triage_seen_meta.syncedAt = 0;
    await H["triage-seen-sync"]({ force: true });
    await vm.runInContext("seenRun", ctx)?.catch(() => {});
    assert.ok(ended.length === 1 && ended[0].error, JSON.stringify(ended));
    t.fetch = realFetch;
    // J20: pruned as soon as a read takes the count over 5000, not only once a day; meta.counted counts new entries.
    const seenCount = () => Object.keys(st).filter((k) => k.startsWith("seen_")).length;
    assert.strictEqual(st.triage_seen_meta.counted, seenCount(), "a prune leaves the count it kept");
    st.seen_BVancient = [50, 1];
    st.triage_seen_meta = { ...st.triage_seen_meta, prunedAt: Date.now(), counted: 4998 };
    pages = [page([h("BVi", T + 360, 10), h("BVh", T + 350, 10)], 0)];
    await read({ force: true });
    assert.deepStrictEqual([plain(st.seen_BVancient), st.triage_seen_meta.counted], [[50, 1], 4999], "under the cap: no prune until the day is up");
    pages = [page([h("BVj", T + 370, 10), h("BVi", T + 360, 10)], 0)];
    st.triage_seen_meta.counted = 5000;
    await read({ force: true });
    assert.deepStrictEqual([st.seen_BVancient, st.triage_seen_meta.counted], [undefined, seenCount()], "over the cap: pruned at once");
    // 关 drops every seen_ key, on a Chrome without getKeys too.
    const keep = { ...st };
    await t.seenClear();
    assert.ok(!Object.keys(st).some((k) => k.startsWith("seen_")) && Object.keys(keep).some((k) => k.startsWith("seen_")), "seenClear drops the history");
    Object.assign(st, keep);
    // C14: 观看进度 turned 关 mid-read stops it before the next page (README: 选「关」就不读).
    t.setTimeout = (f, ms) => realTimeout(f, ms === 5000 ? 0 : ms);
    const n = urls.length;
    pages = [page([h("BVi", T + 380, 10)], 30), page([h("BVj", T + 370, 10)], 20), page([h("BVk", T + 360, 10)], 0)];
    t.fetch = async (url) => ((sync = { seenShow: "off" }), realFetch(url));
    const stopped = await read({ force: true });
    t.fetch = realFetch;
    t.setTimeout = realTimeout;
    assert.strictEqual(urls.length - n, 1, "no page is read after the switch went off");
    assert.deepStrictEqual(plain(stopped), { stopped: "off", pages: 1 });
    sync = { seenShow: "bar" };
    // R31: unticking a folder (or its snapshot changing) makes the next read prune in full, as the count it kept left
    // that folder's videos out.
    {
      const nowS = Math.floor(Date.now() / 1000);
      for (const k of Object.keys(st)) if (k.startsWith("seen_")) delete st[k];
      for (let i = 0; i < 5003; i++) st[`seen_BVf${i}`] = [50, nowS - 100 - i];
      st.triage_included_folders = ["F"];
      st.triage_snapshot_F = { bvids: ["BVf0", "BVf1", "BVf2", "BVf3", "BVf4"] };
      st.triage_seen_meta = { ...st.triage_seen_meta, syncedAt: 0, prunedAt: 0 };
      await read({ force: true });
      assert.deepStrictEqual([seenCount(), st.triage_seen_meta.counted], [5003, 4998], "the ticked folder's five are exempt");
      st.triage_included_folders = [];
      t.triageStorageChanged({ triage_included_folders: { newValue: [] } }, "local");
      await new Promise((r) => setTimeout(r, 0));
      await read({ force: true });
      assert.deepStrictEqual([seenCount(), st.triage_seen_meta.counted, "triage_seen_recount" in st], [5000, 5000, false]);
      t.triageStorageChanged({ other: {} }, "local");
      await new Promise((r) => setTimeout(r, 0));
      assert.ok(!("triage_seen_recount" in st), "only the folder choice and snapshots");
    }
    // R35: 关 then 开 at once: the read that starts while the history is dropped waits, and never writes the old
    // `newest` back.
    {
      st.triage_seen_meta = { ...st.triage_seen_meta, newest: T + 999, syncedAt: 0 };
      const clearing = t.seenClear();
      pages = [page([h("BVnew", T + 1, 10)], 0)];
      const again = read({ force: true });
      await clearing;
      await again;
      assert.deepStrictEqual([plain(st.seen_BVnew), st.triage_seen_meta.newest], [[10, T + 1], T + 1]);
    }
  }

  // triageListen: its prefix only; unknown types and handler errors answer { ok: false }, the code passed through.
  {
    let listener = null;
    const realChrome = t.chrome;
    t.chrome = { runtime: { onMessage: { addListener: (f) => (listener = f) } } };
    const L = t.triageListen("x-", { "x-ok": (m) => ({ got: m.n }), "x-web": () => "web", "x-fail": () => Promise.reject(t.triageError("坏了", "THROTTLED")) }, ["x-web"]);
    t.chrome = { ...realChrome, runtime: { ...realChrome?.runtime, getURL: (p) => `chrome-extension://me/${p}` } };
    assert.strictEqual(L, listener, "registers the listener it returns");
    const ask = (message, url = "chrome-extension://me/triage/triage.html") => new Promise((resolve) => {
      const kept = L(message, { id: "me", url }, resolve);
      if (kept === false) setTimeout(() => resolve("unanswered"), 0);
    });
    assert.deepStrictEqual(plain(await ask({ type: "x-ok", n: 3 })), { ok: true, data: { got: 3 } });
    assert.deepStrictEqual(plain(await ask({ type: "x-fail" })), { ok: false, error: "坏了", code: "THROTTLED" });
    assert.deepStrictEqual(plain(await ask({ type: "x-none" })), { ok: false, error: "未知消息类型 x-none" });
    assert.strictEqual(await ask({ type: "y-ok" }), "unanswered", "other prefixes are left to other listeners");
    assert.strictEqual(await ask({}), "unanswered");
    // A content script in a web page gets only its own types (A53).
    const web = "https://www.bilibili.com/video/BV1";
    assert.deepStrictEqual(plain(await ask({ type: "x-ok", n: 1 }, web)), { ok: false, error: "网页不能发送 x-ok" });
    assert.deepStrictEqual(plain(await ask({ type: "x-web" }, web)), { ok: true, data: "web" });
    // Without a prefix (background.js): only the table's own types, its reply as is; a triage- type is left alone.
    t.chrome.runtime.onMessage = { addListener() {} };
    const B = t.triageListen(null, { "y-ok": () => ({ ok: true, x: 1 }) }, [], (r) => r);
    const askB = (message) => new Promise((resolve) => (B(message, { url: "chrome-extension://me/options.html" }, resolve) === false ? resolve("unanswered") : 0));
    assert.deepStrictEqual(plain(await askB({ type: "y-ok" })), { ok: true, x: 1 });
    assert.strictEqual(await askB({ type: "x-ok" }), "unanswered");
    assert.strictEqual(await askB({ type: "constructor" }), "unanswered");
    t.chrome = realChrome;
  }

console.log("triage-bg selftest: all passed");
})();
