// node extension/limits.selftest.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const ctx = vm.createContext({ console });
for (const f of ["errors.js", "limits.js"]) vm.runInContext(fs.readFileSync(path.join(__dirname, f), "utf8"), ctx);
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
assert.strictEqual(L.describe({ folderSnapshots: 0, folderSnapshotSize: 0 }).find((row) => row.label === "收藏夹列表缓存").usage, "0 个收藏夹，约 0 KB", "nothing stored is 0 KB, not 1");
// 观看进度: the caps triage-bg.js applies, in the row and in the options page's hint (filled from SEEN_LIMITS_TEXT).
assert.strictEqual(L.describe({ seen: 8 }).find((row) => row.label === "观看进度").usage, `8 / ${L.SEEN_MAX} 个视频`);
assert.strictEqual(L.SEEN_LIMITS_TEXT, "最多 10 分钟一次，留最近 1 年、最多 5000 个");
assert.ok(byLabel["观看进度"].rule.includes(L.SEEN_LIMITS_TEXT));
const triageBg = fs.readFileSync(path.join(__dirname, "triage/triage-bg.js"), "utf8");
for (const name of ["SEEN_GAP_MS", "SEEN_KEEP_DAYS", "SEEN_MAX"]) assert.ok(triageBg.includes(`MdgLimits.${name}`), `triage-bg.js reads MdgLimits.${name}`);
const optionsHtml = fs.readFileSync(path.join(__dirname, "options.html"), "utf8");
assert.ok(optionsHtml.includes("<span data-seen-limits></span>") && !/分钟一次|最多 \d+ 个/.test(optionsHtml), "options.html states 观看进度's caps only through data-seen-limits");
assert.ok(fs.readFileSync(path.join(__dirname, "options.js"), "utf8").includes("node.textContent = MdgLimits.SEEN_LIMITS_TEXT"), "options.js fills data-seen-limits");
assert.strictEqual(byLabel["收藏夹列表缓存"].usage, "– 个收藏夹，约 –", "unknown sizes render as a dash");
assert.strictEqual(L.describe()[0].usage, `– / ${L.SUBTITLE_CACHE_ENTRIES} 条`, "unknown usage renders as a dash");
assert.ok(rows.every((row) => row.label && row.usage && row.rule));
// vm objects carry another realm's prototypes, so compare through JSON.
assert.deepStrictEqual(
  JSON.parse(JSON.stringify(L.storageUsage({
    mdg_subtitle_cache_a: {}, mdg_subtitle_cache_b: {}, mdg_ai_conversations_v1: [{}, {}, {}],
    triage_analysis_BV1: {}, triage_title_BV1: {}, triage_title_BV2: {}, other: 1,
    triage_snapshot_7: { bvids: [] }, triage_removed: { BV1: {}, BV2: {} }, triage_notes: { BV3: {} }, seen_BV1: [80, 1]
  }))),
  {
    subtitleCache: 2, aiConversations: 3, triageResults: 3,
    folderSnapshots: 1, folderSnapshotSize: "triage_snapshot_7".length + '{"bvids":[]}'.length,
    triageRemoved: 2, triageNotes: 1, seen: 1, totalSize: 224 + "seen_BV1".length + "[80,1]".length
  }
);

// Storage key names: each KEYS name is written only in limits.js. Selftests and dev mocks may seed their own.
const names = Object.values(L.KEYS).filter((v) => typeof v === "string");
// Renaming one loses the data stored under it.
assert.deepStrictEqual([...names].sort(), [
  "aiProviderKeys", "mdg_ai_conversations_v1", "mdg_ai_selected_provider", "mdg_obsidian_note_paths_v1", "mdg_player_ai_quick_action_v1", "mdg_subtitle_cache_",
  "seen_", "triage_analysis_", "triage_basket", "triage_decisions_", "triage_folder_criteria", "triage_included_folders", "triage_kept", "triage_notes", "triage_removed",
  "triage_seen_meta", "triage_simplified_v1", "triage_snapshot_", "triage_tags", "triage_title_", "triage_video_tags"
]);
assert.strictEqual(L.KEYS.triageDecisions(7), "triage_decisions_7");
assert.strictEqual(L.KEYS.triageAnalysis("BV1"), "triage_analysis_BV1");
assert.strictEqual(L.KEYS.triageTitle("BV1"), "triage_title_BV1");
assert.strictEqual(L.KEYS.triageSnapshot(7), "triage_snapshot_7");
assert.strictEqual(L.KEYS.seen("BV1"), "seen_BV1");
const sources = [];
const walk = (dir) => {
  for (const entry of fs.readdirSync(path.join(__dirname, dir), { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!/^dev/.test(entry.name)) walk(rel);
    } else if (entry.name.endsWith(".js") && !entry.name.endsWith(".selftest.js") && rel !== "limits.js") sources.push(rel);
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

// The boc_* → mdg_* rename: copy, never overwrite newer data, keep the old key when the write fails, rerun is a no-op.
(async () => {
  const fakeArea = (data, failOn = "") => ({
    data,
    getKeys: async () => Object.keys(data),
    get: async (k) => (k in data ? { [k]: data[k] } : {}),
    set: async (o) => {
      if (Object.keys(o).includes(failOn)) throw new Error("QUOTA_BYTES");
      Object.assign(data, o);
    },
    remove: async (k) => void delete data[k]
  });
  const local = fakeArea({
    boc_ai_conversations_v1: [{ id: "old" }], boc_subtitle_cache_BV1_9_id_7: { raw: 1 },
    boc_obsidian_note_paths_v1: { a: 1 }, mdg_obsidian_note_paths_v1: { a: 2 }, boc_player_ai_quick_action_v1: { q: 1 }, triage_tags: []
  }, "mdg_player_ai_quick_action_v1");
  await L.migrateRenamedKeys(local);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(local.data)), {
    triage_tags: [], mdg_ai_conversations_v1: [{ id: "old" }], mdg_subtitle_cache_BV1_9_id_7: { raw: 1 },
    mdg_obsidian_note_paths_v1: { a: 2 }, boc_player_ai_quick_action_v1: { q: 1 }
  }, "copied, the newer mdg_ value kept, the failed one left under its old name");
  assert.deepStrictEqual([...(await L.storageKeys({ get: async (k) => (k === null ? { a: 1, b: 2 } : {}) }))], ["a", "b"], "no getKeys (Chrome < 130): every key from get(null)");
  const after = JSON.stringify(local.data);
  local.set = async (o) => Object.assign(local.data, o);
  await L.migrateRenamedKeys(local);
  assert.deepStrictEqual(local.data.mdg_player_ai_quick_action_v1, { q: 1 }, "the next run moves what failed");
  assert.ok(!("boc_player_ai_quick_action_v1" in local.data));
  const settled = JSON.stringify(local.data);
  await L.migrateRenamedKeys(local);
  assert.strictEqual(JSON.stringify(local.data), settled, "idempotent");
  assert.notStrictEqual(after, settled);

  const ls = (data, fail = false) => ({
    data,
    get length() { return Object.keys(data).length; },
    key: (i) => Object.keys(data)[i] ?? null,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { if (fail) throw new Error("QuotaExceededError"); data[k] = String(v); },
    removeItem: (k) => void delete data[k]
  });
  const page = ls({ boc_ai_selected_provider: "b", other: "x" });
  L.migrateRenamedLocalStorage(page);
  L.migrateRenamedLocalStorage(page);
  assert.deepStrictEqual(page.data, { other: "x", mdg_ai_selected_provider: "b" });
  const newer = ls({ boc_ai_selected_provider: "old", mdg_ai_selected_provider: "new" });
  L.migrateRenamedLocalStorage(newer);
  assert.deepStrictEqual(newer.data, { mdg_ai_selected_provider: "new" });
  const full = ls({ boc_ai_selected_provider: "b" }, true);
  L.migrateRenamedLocalStorage(full);
  assert.deepStrictEqual(full.data, { boc_ai_selected_provider: "b" });

  // 视频备注: one read-modify-write of one entry for every page; a note saved elsewhere meanwhile stays.
  const area = fakeArea({ triage_notes: { BV1: { text: "a", updatedAt: 1 }, BV2: { text: "别处的", updatedAt: 1 } } });
  ctx.chrome = { storage: { local: area } };
  assert.strictEqual(await L.saveVideoNote("BV1", "a"), false, "unchanged text writes nothing");
  assert.strictEqual(await L.saveVideoNote("BV3", "新的"), true);
  assert.strictEqual(await L.saveVideoNote("BV1", "  "), true);
  assert.deepStrictEqual(Object.fromEntries(Object.entries(area.data.triage_notes).map(([b, n]) => [b, n.text])), { BV2: "别处的", BV3: "新的" });
  // Two saves at once (two cards' notes) each read after the other wrote: both notes stay.
  const slowSet = area.set;
  area.set = async (o) => (await new Promise((r) => setTimeout(r, 5)), slowSet(o));
  await Promise.all([L.saveVideoNote("BV4", "四"), L.saveVideoNote("BV5", "五")]);
  area.set = slowSet;
  assert.deepStrictEqual([area.data.triage_notes.BV4?.text, area.data.triage_notes.BV5?.text], ["四", "五"], "concurrent saves keep both");
  for (const f of ["sidepanel.js", "history/history.js", "triage/triage.js"]) {
    const src = fs.readFileSync(path.join(__dirname, f), "utf8");
    assert.ok(src.includes("MdgLimits.saveVideoNote(") && !/set\(\{ \[(NOTES_STORAGE_KEY|NOTES_KEY)\]|storeSet\(K\.notes, S\.notes\)/.test(src), `${f} saves a note its own way`);
  }

  // The side panel's request slot has one constructor: every request carries createdAt (the panel drops stale ones).
  await L.askSidepanel({ tabId: 3, contextRef: { videoId: "BV1" } });
  const req = area.data.mdg_player_ai_quick_action_v1;
  assert.ok(req.id && req.tabId === 3 && req.prompt === "" && req.createdAt > 0 && req.contextRef.videoId === "BV1" && req.frameId === 0);
  for (const f of sources) assert.ok(!/KEYS\.playerAiQuickAction\]:/.test(fs.readFileSync(path.join(__dirname, f), "utf8")), `${f} builds the side panel request itself`);
  const offText = "✦ AI 总结按钮未开启";
  assert.deepStrictEqual(sources.filter((f) => fs.readFileSync(path.join(__dirname, f), "utf8").includes(offText)), ["background.js"], "the ✦ setting is checked once");

  console.log("limits selftest ok");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
