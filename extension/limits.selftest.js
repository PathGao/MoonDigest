// node extension/limits.selftest.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const ctx = vm.createContext({ console });
vm.runInContext(fs.readFileSync(path.join(__dirname, "limits.js"), "utf8"), ctx);
const L = ctx.BocLimits;

// The options page renders describe(); each cap it states must be the one the code enforces.
const rows = L.describe({ subtitleCache: 12, aiConversations: 23, triageResults: 7 });
const byLabel = Object.fromEntries(rows.map((row) => [row.label, row]));
assert.strictEqual(byLabel["字幕缓存"].usage, `12 / ${L.SUBTITLE_CACHE_ENTRIES} 条`);
assert.ok(byLabel["字幕缓存"].rule.includes(`${L.SUBTITLE_CACHE_DAYS} 天`));
assert.strictEqual(byLabel["AI 对话"].usage, `23 / ${L.AI_CONVERSATIONS} 段`);
assert.strictEqual(byLabel["分拣结果（粗分 + 细看）"].usage, "7 条");
assert.ok(byLabel["AI 每次请求读的字幕"].usage.includes("60,000"));
assert.ok(byLabel["AI 每次请求带的历史"].usage.includes("40,000"));
assert.ok(byLabel["分拣台最近取消收藏"].usage.includes(String(L.TRIAGE_RECENT_UNFAV)));
assert.ok(byLabel["分拣台撤销"].usage.includes(String(L.TRIAGE_UNDO_STEPS)));
assert.strictEqual(L.describe()[0].usage, `– / ${L.SUBTITLE_CACHE_ENTRIES} 条`, "unknown usage renders as a dash");
assert.ok(rows.every((row) => row.label && row.usage && row.rule));
assert.deepStrictEqual(
  L.storageUsage({
    boc_subtitle_cache_a: {}, boc_subtitle_cache_b: {}, boc_ai_conversations_v1: [{}, {}, {}],
    triage_analysis_BV1: {}, triage_title_BV1: {}, triage_title_BV2: {}, other: 1
  }),
  { subtitleCache: 2, aiConversations: 3, triageResults: 3 }
);

// Every context that enforces a cap loads limits.js first: content script, pages, background.
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "manifest.json"), "utf8"));
const contentJs = manifest.content_scripts.find((entry) => entry.js.includes("content.js")).js;
assert.ok(contentJs.indexOf("limits.js") < contentJs.indexOf("content.js"), "content script gets limits.js first");
for (const page of ["sidepanel.html", "options.html", "triage/triage.html"]) {
  const html = fs.readFileSync(path.join(__dirname, page), "utf8");
  const limitsAt = html.search(/<script src="[./]*limits\.js"><\/script>/);
  const pageScriptAt = html.search(/<script[^>]*src="[./]*(?:sidepanel|options|triage)\.js"/);
  assert.ok(limitsAt >= 0 && limitsAt < pageScriptAt, `${page} loads limits.js before its own script`);
}

console.log("limits selftest ok");
