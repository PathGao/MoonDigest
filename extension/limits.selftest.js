// node extension/limits.selftest.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const ctx = vm.createContext({ console });
vm.runInContext(fs.readFileSync(path.join(__dirname, "limits.js"), "utf8"), ctx);
const L = ctx.MdgLimits;

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
    mdg_subtitle_cache_a: {}, mdg_subtitle_cache_b: {}, mdg_ai_conversations_v1: [{}, {}, {}],
    triage_analysis_BV1: {}, triage_title_BV1: {}, triage_title_BV2: {}, other: 1,
    triage_snapshot_7: { bvids: [] }, triage_removed: { BV1: {}, BV2: {} }, triage_notes: { BV3: {} }
  }))),
  {
    subtitleCache: 2, aiConversations: 3, triageResults: 3,
    folderSnapshots: 1, folderSnapshotSize: "triage_snapshot_7".length + '{"bvids":[]}'.length,
    triageRemoved: 2, triageNotes: 1, totalSize: 224
  }
);

// Storage key names: each KEYS name is written only in limits.js. Selftests and dev mocks may seed their own.
// badges.js does not load limits.js and keeps copies of the names it reads; they must stay KEYS names.
const names = Object.values(L.KEYS).filter((v) => typeof v === "string");
// Renaming one loses the data stored under it.
assert.deepStrictEqual([...names].sort(), [
  "mdg_ai_conversations_v1", "mdg_obsidian_note_paths_v1", "mdg_player_ai_quick_action_v1", "mdg_subtitle_cache_",
  "triage_analysis_", "triage_basket", "triage_folder_criteria", "triage_included_folders", "triage_notes", "triage_removed",
  "triage_seen_meta", "triage_simplified_v1", "triage_snapshot_", "triage_tags", "triage_title_", "triage_video_tags"
]);
assert.strictEqual(L.KEYS.triageAnalysis("BV1"), "triage_analysis_BV1");
assert.strictEqual(L.KEYS.triageTitle("BV1"), "triage_title_BV1");
assert.strictEqual(L.KEYS.triageSnapshot(7), "triage_snapshot_7");
const badgesCopies = ["triage_tags", "triage_video_tags", "triage_title_", "triage_analysis_", "triage_snapshot_"];
for (const name of badgesCopies) assert.ok(names.includes(name), `badges.js reads ${name}, which KEYS no longer has`);
const sources = [];
const walk = (dir) => {
  for (const entry of fs.readdirSync(path.join(__dirname, dir), { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!/^dev/.test(entry.name)) walk(rel);
    } else if (entry.name.endsWith(".js") && !entry.name.endsWith(".selftest.js") && !["limits.js", "badges.js"].includes(rel)) sources.push(rel);
  }
};
walk(".");
assert.ok(sources.includes("triage/triage.js") && sources.length > 15, `scanned ${sources.length} files`);
for (const file of sources) {
  const text = fs.readFileSync(path.join(__dirname, file), "utf8");
  for (const name of names) {
    // A string literal ("name", `name${id}`), a property read (x.name) or an object key ({ name: ... }).
    const written = new RegExp(`["'\`]${name}(?:["'\`]|\\$\\{)|\\.${name}\\b|[{,]\\s*${name}\\s*:`);
    assert.ok(!written.test(text), `${file} writes the storage key ${name} itself; use MdgLimits.KEYS`);
  }
}
for (const name of badgesCopies) assert.ok(fs.readFileSync(path.join(__dirname, "badges.js"), "utf8").includes(name));

console.log("limits selftest ok");
