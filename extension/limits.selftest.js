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
assert.strictEqual(byLabel["分拣结果（粗看 + 细看）"].usage, "7 条");
assert.ok(byLabel["AI 每次请求读的字幕"].usage.includes("60,000"));
assert.ok(byLabel["AI 每次请求带的历史"].usage.includes("40,000"));
assert.ok(!byLabel["分拣台最近取消收藏"] && !byLabel["分拣台撤销"], "display counts are not storage rows");
const sized = Object.fromEntries(L.describe({ folderSnapshots: 3, folderSnapshotSize: 2.8 * 1024 * 1024, triageRemoved: 4, triageNotes: 5, totalSize: 300 })
  .map((row) => [row.label, row.usage]));
assert.strictEqual(sized["收藏夹列表缓存"], "3 个收藏夹，约 2.8 MB");
assert.strictEqual(sized["已出分拣范围"], "4 个视频");
assert.strictEqual(sized["备注"], "5 条");
assert.strictEqual(sized["本地数据合计"], "约 1 KB");
assert.strictEqual(byLabel["收藏夹列表缓存"].usage, "– 个收藏夹，约 –", "unknown sizes render as a dash");
assert.strictEqual(L.describe()[0].usage, `– / ${L.SUBTITLE_CACHE_ENTRIES} 条`, "unknown usage renders as a dash");
assert.ok(rows.every((row) => row.label && row.usage && row.rule));
// vm objects carry another realm's prototypes, so compare through JSON.
assert.deepStrictEqual(
  JSON.parse(JSON.stringify(L.storageUsage({
    boc_subtitle_cache_a: {}, boc_subtitle_cache_b: {}, boc_ai_conversations_v1: [{}, {}, {}],
    triage_analysis_BV1: {}, triage_title_BV1: {}, triage_title_BV2: {}, other: 1,
    triage_snapshot_7: { bvids: [] }, triage_removed: { BV1: {}, BV2: {} }, triage_notes: { BV3: {} }
  }))),
  {
    subtitleCache: 2, aiConversations: 3, triageResults: 3,
    folderSnapshots: 1, folderSnapshotSize: "triage_snapshot_7".length + '{"bvids":[]}'.length,
    triageRemoved: 2, triageNotes: 1, totalSize: 224
  }
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
