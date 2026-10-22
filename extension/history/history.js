if (!globalThis.chrome?.runtime?.id) await import("./dev/mock-chrome.js");
// Read up front: sidePanel.open must run inside the click's user gesture, before any await.
const OWN_TAB = await chrome.tabs.getCurrent();

// Before the first read of the AI platform picked in the side panel: 3.5 and older kept it under the old key prefix, and
// this page may open first after the update (as 收藏夹 and the side panel do).
try {
  MdgLimits.migrateRenamedLocalStorage(localStorage);
} catch {}
const KEY = MdgLimits.KEYS.aiConversations;
const { triageNotes: NOTES_KEY, triageAnalysisPrefix: ANALYSIS, triageSnapshotPrefix: SNAPSHOT, readingMarks: MARKS_KEY, triageTags: TRIAGE_TAGS, triageVideoTags: TRIAGE_VIDEO_TAGS } = MdgLimits.KEYS;
const $ = (id) => document.getElementById(id);
const { setReason } = MdgErrors;
$("searchSlot").outerHTML = TriageUi.searchBox("search", "searchCount", TriageUi.searchScope(MdgErrors.LABEL.history));
const els = { list: $("list"), search: $("search"), searchCount: $("searchCount"), count: $("count"), filters: $("filters"), stateRow: $("stateRow"), selectAllSlot: $("selectAllSlot"), tagRow: $("tagRow"), tagActs: $("tagActs"), selbar: $("selbar"), clearAll: $("clearAll"), status: $("status") };
els.search.title = "搜索标题、作者、标签、AI 总结、备注和对话内容";

let conversations = [];
let analyses = {}; // bvid → done triage analysis
let notes = {}; // video id (bvid / YouTube videoId) → { text, updatedAt }, non-empty only
let triageTitles = {}; // bvid → title from the triage folder snapshots
let obsidianEnabled = false;
let stored = {}; // all of local storage as last read: MdgNote.triageExtras reads a record's tags and 星标 from it
let marks = { tags: [], items: {} }; // 星标 and tags by record key (MdgNote.readingKey)
let triageTagById = new Map(); // the 分拣台's tags, shown read-only on B站 videos
let triageVideoTags = {}; // bvid → 分拣台 tag ids
// Records unmarked here that have nothing else left: kept on the list until the page reloads, so a row does not
// vanish under the cursor (record key → its last mark).
const unmarked = new Map();
// Records whose 星标 changed here: the 星标 filter keeps showing them until the page reloads, for the same reason (星标
// has no U). A tag edit leaves the tag filters at once, as on the 分拣台; U brings the record back.
const starEdited = new Set();
let starFilter = false;
let tagState = ""; // 第 2 行 "" | "untagged" | "tagged", on the record's own tags (the tag row's), as the 分拣台's
const tagFilter = new Set();
const selected = new Set();
const writing = new Set(); // entry keys with a 写入 Obsidian in flight
const unfolded = new Set(); // entry keys whose one-line AI summary is shown in full
const expanded = new Set(); // entry keys whose 问答 are open, kept while a search hides the entry
let reloadTimer = 0;
let editing = null; // { id, draft } while a 备注 is open; storage reloads wait until it closes
let reloadPending = false;
let rendering = false;
let pressing = false; // a pointer is down: redrawing now would replace the control it is pressing
document.addEventListener("pointerdown", () => (pressing = true), true);
for (const type of ["pointerup", "pointercancel"]) document.addEventListener(type, () => (pressing = false), true);

const esc = MdgErrors.escapeHtml;
const UI = TriageUi;
const formatTime = (value) => new Date(Number(value) || 0).toLocaleString("zh-CN", { hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });

// One entry per video or web page: the side panel's contextKey (MdgSites.buildContextKey) ties a conversation to it.
function groupByVideo(items) {
  const byKey = new Map();
  for (const item of items) {
    const key = item.contextKey || item.id;
    byKey.set(key, [...(byKey.get(key) || []), item]);
  }
  const groups = [...byKey].map(([key, convs]) => {
    convs.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    const latest = convs.reduce((a, b) => ((b.updatedAt || 0) > (a.updatedAt || 0) ? b : a));
    // Read as the side panel reads a saved conversation: an old one keeps its video from contextSnapshot or its own fields.
    const ref = MdgSites.contextRef(latest.contextRef || latest.contextSnapshot || { ...latest, title: latest.contextTitle });
    const context = { ...ref, title: ref.title || latest.contextTitle || latest.title, url: latest.contextUrl || ref.url || "" };
    return { key, convs, context, title: latest.title || context.title || MdgErrors.TEXT.untitledVideo, updatedAt: latest.updatedAt || 0 };
  });
  // The note is per video, so it joins every part's entry, as the side panel shows it on every part; the analysis
  // summarizes P1, so it joins only the P1 entry. Without a P1 entry the analysis is its own entry, and so is a note
  // without any entry. Note ids are bvids (BV and 10 more, 12 in all) or YouTube videoIds (11).
  for (const bvid of new Set([...Object.keys(analyses), ...Object.keys(notes)])) {
    const analysis = analyses[bvid];
    const note = notes[bvid];
    const site = /^BV[0-9A-Za-z]{10}$/.test(bvid) ? "bilibili" : "youtube";
    const context = { site, videoId: bvid, title: triageTitles[bvid] || bvid, url: MdgSites.SITES[site].canonicalUrl(bvid, 1), isVideoContext: true };
    const key = MdgSites.buildContextKey(context);
    const parts = groups.filter((g) => MdgSites.buildContextKey({ ...g.context, cid: "" }) === key);
    for (const g of parts) g.note = note;
    const host = parts.find((g) => (Number(g.context.pageIndex) || 1) === 1);
    if (host) host.analysis = analysis;
    else if (analysis || !parts.length) groups.push({ key, convs: [], context, title: context.title, updatedAt: Math.max(analysis?.analyzedAt || 0, note?.updatedAt || 0), analysis, note });
  }
  // Marks are per record, every part alike, as 备注 are; a marked record with nothing else left is its own entry, from
  // the title and address kept when it was marked.
  for (const key of new Set([...unmarked.keys(), ...Object.keys(marks.items)])) {
    const mark = marks.items[key] || unmarked.get(key);
    const parts = groups.filter((g) => readingKey(g) === key);
    for (const g of parts) g.mark = marks.items[key];
    if (parts.length) continue;
    const context = { ...MdgSites.contextRef(mark.ref), isVideoContext: Boolean(mark.ref?.videoId) };
    const title = context.title || triageTitles[context.videoId] || context.videoId || context.url;
    // By when it was first marked: a 星标 click does not move it to the top.
    groups.push({ key, convs: [], context, title, updatedAt: mark.at || mark.updatedAt || 0, mark: marks.items[key] });
  }
  return groups.sort((a, b) => b.updatedAt - a.updatedAt);
}

const readingKey = (g) => MdgNote.readingKey(g.context);
const siteOf = (g) => MdgSites.SITES[g.context.site]?.label || "网页";

// The record's AI 笔记 with every conversation in order, its tags and 星标: what the zip holds for a record whose note
// export-note could not build.
function buildNote(group) {
  const turns = group.convs.flatMap((conv) => MdgNote.buildConversationTurns(conv.messages));
  const filename = MdgNote.buildAiConversationFilename(group.context);
  const extras = MdgNote.triageExtras(stored, group.context);
  return { filename, content: MdgNote.withTriageSummary(MdgNote.buildAiConversationMarkdown({ context: group.context, turns, filename, extras }), group.analysis, group.note?.text) };
}

// ---------- 星标 and tags ----------
const tagOf = (id) => marks.tags.find((t) => t.id === id);
const tagsOf = (g) => (g.mark?.tags || []).map(tagOf).filter(Boolean);
// The 分拣台's tags of a B站 video, one per name (each 收藏夹 has its own tags).
function triageTagsOf(g) {
  if (g.context.site !== "bilibili") return [];
  const tags = (triageVideoTags[g.context.videoId] || []).map((id) => triageTagById.get(id)).filter(Boolean);
  return tags.filter((t, i) => tags.findIndex((x) => x.name === t.name) === i);
}
const fullReason = () => (marks.tags.length >= MdgLimits.READING_TAGS ? `已经有 ${marks.tags.length} 个标签了，先在「${UI.tagManage}」里删掉不用的` : "");
// What a mark keeps of its record, refreshed at each write: enough to list it after its conversations are gone.
const refOf = (g) => ({ site: g.context.site || "", videoId: g.context.videoId || "", url: g.context.url || "", title: g.title === g.context.videoId ? "" : g.title });

// Every write goes through MdgLimits.updateReadingMarks; the list is drawn from what was written.
async function saveMarks(edit) {
  try {
    marks = await MdgLimits.updateReadingMarks(edit);
    stored[MARKS_KEY] = marks;
    dropStaleProposal();
    return true;
  } catch (error) {
    setStatus(`保存失败：${error?.message || MdgErrors.TEXT.unknown}`, true);
    return false;
  } finally {
    render();
  }
}
// Changes the marks of records (refs: record key → ref); a record left with no 星标 and no tag is dropped from storage.
function editItems(m, refs, change) {
  const items = { ...m.items };
  for (const [key, ref] of Object.entries(refs)) {
    const item = change({ star: 0, tags: [], ...(items[key] || unmarked.get(key)) }, key);
    if (item.star || item.tags.length) items[key] = { ...item, ref, at: item.at || Date.now(), updatedAt: Date.now() };
    else {
      if (items[key]) unmarked.set(key, { ...items[key], ...item, ref });
      delete items[key];
    }
  }
  return { ...m, items };
}
const toggleStar = (g) => {
  const on = !g.mark?.star;
  starEdited.add(readingKey(g));
  return saveMarks((m) => editItems(m, { [readingKey(g)]: refOf(g) }, (item) => ({ ...item, star: on ? Date.now() : 0 })));
};

// A card's tag chip: a click takes the tag off that record, one U step, as on the 分拣台.
async function untag(g, id) {
  const key = readingKey(g);
  const name = tagOf(id)?.name || "";
  const refs = { [key]: refOf(g) };
  let before = {};
  const saved = await saveMarks((m) => ((before = tagsBefore(m, [key])), editItems(m, refs, (item) => ({ ...item, tags: item.tags.filter((t) => t !== id) }))));
  if (!saved) return;
  pushTagUndo(before, refs, UI.untagStep(name));
  setStatus(UI.untagged(name));
}

// A tag by name: the one that has it, or a new one while there is room; null (and why, in red) otherwise.
async function createTag(value) {
  const name = MdgTagCore.cleanTagName(value);
  let tag = null;
  const why = UI.tagNameError(name, []) || (!marks.tags.some((t) => t.name === name) && fullReason());
  if (why) return setStatus(why, true), null;
  await saveMarks((m) => {
    tag = m.tags.find((t) => t.name === name);
    if (tag || m.tags.length >= MdgLimits.READING_TAGS) return m;
    tag = { id: MdgTagCore.newTagId("rt"), name, color: MdgTagCore.nextTagColor(m.tags) };
    return { ...m, tags: [...m.tags, tag] };
  });
  return tag;
}

// The shared picker (tag-picker.js) for one record (under its 「+ 标签」) or the selected ones (a modal). Closing saves.
function openPicker(groups, anchor = "") {
  const refs = Object.fromEntries(groups.map((g) => [readingKey(g), refOf(g)]).filter(([key]) => key));
  const targets = Object.keys(refs);
  if (!targets.length) return;
  TagPicker.open({
    title: UI.pickTitle(groups.length, groups[0].title, ""),
    targets,
    idsOf: (key) => (marks.items[key]?.tags || []).filter(tagOf),
    tags: () => marks.tags,
    get canCreate() {
      return !fullReason();
    },
    create: createTag,
    get empty() {
      return fullReason();
    },
    anchor,
    async onClose(changes) {
      if (!changes.length) return;
      const changed = Object.fromEntries(changes.map((c) => [c.key, refs[c.key]]));
      let before = {};
      const saved = await saveMarks((m) => {
        before = tagsBefore(m, Object.keys(changed));
        return editItems(m, changed, (item, key) => ({ ...item, tags: TagPicker.applyChange(item.tags, changes.find((c) => c.key === key)) }));
      });
      if (saved) pushTagUndo(before, changed, MdgErrors.LABEL.tagEdit, { ask: changes.length > 1 ? UI.undoAsk("tags", changes.length, "记录") : null });
    }
  });
}

// 标签管理 (tag-dialogs.js): one list for every record, videos and web pages alike.
const tagCount = (id) => Object.values(marks.items).filter((item) => item.tags?.includes(id)).length;
const manageTags = {
  who: "记录",
  hint: () => `摘读记录的标签，视频和网页共用，最多 ${MdgLimits.READING_TAGS} 个。`,
  tags: () => marks.tags,
  count: tagCount,
  addReason: (value) => fullReason() || UI.tagNameError(MdgTagCore.cleanTagName(value), marks.tags),
  add: createTag,
  edit(t, field, value) {
    const { tag, why } = UI.editedTag(t, field, value, marks.tags.filter((x) => x.id !== t.id));
    if (why) setStatus(why, true);
    return Boolean(tag) && saveMarks((m) => ({ ...m, tags: m.tags.map((x) => (x.id === t.id ? tag : x)) }));
  },
  async remove(t) {
    // As the 分拣台's: the confirm dialog is a second modal over 标签管理.
    if (!(await UI.askConfirm(...UI.deleteTagAsk(t, tagCount(t.id), "记录"), "删除", { danger: true }))) return;
    tagFilter.delete(t.id);
    // As the 分拣台: deleting a tag drops the tag steps, which cannot bring it back.
    undoSteps.length = 0;
    await saveMarks((m) => {
      const carrying = Object.fromEntries(Object.entries(m.items).filter(([, item]) => item.tags?.includes(t.id)).map(([key, item]) => [key, item.ref]));
      return editItems({ ...m, tags: m.tags.filter((x) => x.id !== t.id) }, carrying, (item) => ({ ...item, tags: item.tags.filter((id) => id !== t.id) }));
    });
  }
};

// ---------- ✦ AI 打标签 (tag-dialogs.js), as 关注's: the proposal waits in memory until 应用 writes it in one marks write ----------
const { readingAiHistory: AI_HISTORY, readingAiSettings: AI_SETTINGS, readingAiProposal: AI_PROPOSAL, readingAiRecent: AI_RECENT } = MdgLimits.KEYS;
const { normAi, followAiSettings, withAllowRemove, searchWords, hasWords } = FollowCore;
// run: { stopping } while a run goes; recent: 「AI 刚打的」, { at, keys } of the records the last 应用 changed.
const AI = { excluded: new Set(), history: [], proposal: null, run: null, settings: normAi(), recent: null };
let recentFilter = false;
// The proposal waits for 应用 in storage too, so a reload keeps it (as 关注's).
function setAiProposal(p) {
  AI.proposal = p;
  (p ? chrome.storage.local.set({ [AI_PROPOSAL]: p }) : chrome.storage.local.remove(AI_PROPOSAL)).catch(() => {});
}
async function clearRecent() {
  AI.recent = null;
  recentFilter = false;
  await chrome.storage.local.remove(AI_RECENT).catch(() => {});
  render();
}
// 摘读记录设置 (AI_SETTINGS), as 关注's follow_ai_settings: seeded from the 收藏夹 values on first use and stored then,
// independent of them afterwards.
async function aiSettings() {
  const own = (await chrome.storage.sync.get(AI_SETTINGS))[AI_SETTINGS];
  const triage = own ? null : await chrome.runtime.sendMessage({ type: "triage-settings-get" }).catch(() => null);
  const { value, seed } = followAiSettings(own, triage?.ok ? triage.data : null);
  // Not stored (sync quota, …): the copied values still work this time, and the next use tries again.
  if (seed) await saveAiSettings(seed);
  return (AI.settings = value);
}
async function saveAiSettings(next) {
  try {
    await chrome.storage.sync.set({ [AI_SETTINGS]: next });
  } catch (e) {
    setStatus(`${MdgErrors.TEXT.settingsSaveFailed}：${e.message}`, true);
    return false;
  }
  AI.settings = next;
  return true;
}
// Entries by record (a video's parts are one record), each record's entries in list order.
function recordsOf(groups) {
  const out = new Map();
  for (const g of groups) if (readingKey(g)) out.set(readingKey(g), [...(out.get(readingKey(g)) || []), g]);
  return out;
}
// 选中 counts the selected records the search and filters hide too, as the selection bar does.
const aiRecords = (scope) => recordsOf(visibleGroups().filter((g) => scope !== "selected" || selected.has(g.key)));
// A record's 问/答 within budget characters: answers are cut, all to the same length, before any question is; questions
// past the budget are dropped.
function aiExcerpt(turns, budget = UI.READING_AI_CHARS) {
  const flat = (s) => s.replace(/\s+/g, " ").trim();
  const qs = turns.map((t) => flat(t.prompt));
  const as = turns.map((t) => flat(t.answer));
  const left = budget - qs.reduce((n, q) => n + q.length, 0);
  if (left <= 0) {
    const out = [];
    let room = budget;
    for (const q of qs) {
      if (room <= 0) break;
      out.push({ q: q.slice(0, room), a: "" });
      room -= q.length;
    }
    return out;
  }
  let cap = Math.max(0, ...as.map((a) => a.length));
  while (as.reduce((n, a) => n + Math.min(a.length, cap), 0) > left) cap--;
  return qs.map((q, i) => ({ q, a: as[i].slice(0, cap) }));
}
// What the AI reads of a record (its line in triage-bg.js readingAiLine): every conversation's 问/答, oldest first; a
// record without one sends the 分拣台's one-liner (P1's) and the 备注 instead.
function aiItem(key, parts, excluded) {
  const g = parts[0];
  const turns = parts.flatMap((x) => x.convs).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)).flatMap((c) => MdgNote.buildConversationTurns(c.messages));
  const item = { id: key, title: g.title, site: siteOf(g), currentTags: tagsOf(g).map((t) => t.name).filter((name) => !excluded.has(name)) };
  return turns.length ? { ...item, turns: aiExcerpt(turns) } : { ...item, oneLiner: parts.find((x) => x.analysis)?.analysis.oneLiner || "", note: g.note?.text || "" };
}
const aiRoom = () => Math.min(AI.settings.newTagMax, Math.max(0, MdgLimits.READING_TAGS - marks.tags.length));
// Records that exist now (live), with what their marks keep (refOf).
const aiLive = () => new Map(groupByVideo(conversations).filter(readingKey).map((g) => [readingKey(g), refOf(g)]));
// A proposal naming a deleted tag no longer fits: dropped, not applied.
function dropStaleProposal() {
  if (AI.proposal && !UI.aiProposalOk(AI.proposal, tagOf)) setAiProposal(null);
}
function aiProviderId() {
  try {
    return localStorage.getItem(MdgLimits.KEYS.aiSelectedProvider) || "";
  } catch {
    return "";
  }
}
const RECENT_CHECK = "在记录上逐个看，不对的点「+ 标签」改";
const aiProgress = (text) => (TagDialogs.ai.progress(aiTags, text), setStatus(text));
const aiTags = {
  who: "记录",
  sees: `标题、是视频还是网页、现有标签和你与 AI 的对话（问和答，每条记录最多 ${UI.READING_AI_CHARS} 字）；没有对话的记录看分拣台的 AI 总结和备注`,
  example: "按主题分成 编程、设计、生活，每条只打一个",
  excluded: AI.excluded,
  manage: manageTags,
  tags: () => marks.tags,
  scopes: () => [
    { value: "filter", label: UI.scopeLabel.filter, n: aiRecords("filter").size },
    { value: "selected", label: UI.scopeLabel.selected, n: recordsOf(groupByVideo(conversations).filter((g) => selected.has(g.key))).size, shown: aiRecords("selected").size }
  ],
  scopeText(scope) {
    const n = aiRecords(scope).size;
    return n ? `${n} 个记录${UI.batchesText(Math.ceil(n / AI.settings.batchSize))}` : "作用范围里没有记录";
  },
  room: aiRoom,
  roomHint: () => UI.aiRoomHint({ tags: marks.tags, excluded: AI.excluded, room: aiRoom(), full: `摘读记录的标签已满 ${MdgLimits.READING_TAGS} 个` }) + "<br>每批数量、间隔和新建上限在「摘读记录设置」里改。",
  blocked: () => "",
  history: () => AI.history,
  allowRemove: () => AI.settings.allowRemove,
  // As 关注: the switch is a setting, kept for the next run.
  setAllowRemove: async (on) => saveAiSettings(withAllowRemove(await aiSettings(), on)),
  running: () => Boolean(AI.run),
  proposal: () => AI.proposal,
  run: runAi,
  stop() {
    if (AI.run) AI.run.stopping = true;
  },
  stopping: () => Boolean(AI.run?.stopping),
  discard() {
    setAiProposal(null);
    render();
  },
  apply: applyAi,
  map: () => Object.fromEntries(Object.entries(marks.items).map(([key, item]) => [key, item.tags || []])),
  live: aiLive,
  tagName: (id) => tagOf(id)?.name,
  check: RECENT_CHECK,
  // READING_TAGS is a hard limit: the review says up front which ticked new tags 应用 will not create (newTagPlan).
  notMade: (p) => ({ keys: new Set(newTagPlan(p.newTags, marks.tags).skipped), why: `摘读记录的标签最多 ${MdgLimits.READING_TAGS} 个` })
};
// Why ✦ AI 打标签 cannot open: no record to tag and nothing running or pending, as 收藏夹's in an empty folder.
const aiReason = (all = groupByVideo(conversations)) => (AI.run || AI.proposal || all.some(readingKey) ? "" : NO_RECORDS);
async function openAi() {
  if (aiReason()) return setStatus(aiReason());
  if (!AI.run) AI.history = (await chrome.storage.local.get(AI_HISTORY))[AI_HISTORY] || [];
  await aiSettings();
  TagDialogs.ai.open(aiTags);
}

// instruction, scope and allowRemove come from the dialog, which has checked that there is an instruction and records.
// The 分拣台's run rules (MdgRuns.aiJudge): an AI 429 waits and a timeout sends the batch again; a setup or access error
// ends the run with 去设置 or 授权 on the status line; any other fails its batch.
const runs = MdgRuns.create({ hold: (r) => (r.code === "AI_THROTTLED" ? MdgRuns.AI_HOLD : null) });
async function runAi({ instruction, scope, allowRemove }) {
  const records = aiRecords(scope);
  if (AI.run || !records.size) return;
  const run = (AI.run = { stopping: false });
  render();
  const cfg = await aiSettings();
  AI.history = UI.aiHistoryAdd(AI.history, instruction);
  chrome.storage.local.set({ [AI_HISTORY]: AI.history }).catch(() => {});
  const excluded = new Set(marks.tags.filter((t) => AI.excluded.has(t.id)).map((t) => t.name));
  const tags = marks.tags.filter((t) => !excluded.has(t.name)).map((t) => ({ name: t.name, rule: t.rule || "" }));
  const items = [...records].map(([key, parts]) => aiItem(key, parts, excluded));
  const opts = { tags: marks.tags, map: aiTags.map(), maxNewTags: aiRoom(), excluded, scope: new Set(records.keys()) };
  const total = Math.ceil(items.length / cfg.batchSize);
  const p = { newTags: [], rows: [], notes: [], errors: [] };
  let answered = 0;
  let i = 0;
  const res = await runs.run("ai", {
    total,
    gap: cfg.intervalSec * 1000,
    alive: () => !run.stopping,
    tick: () => runs.get("ai")?.wait && aiProgress(`${runs.get("ai").wait}第 ${i} 批…`),
    next: () => (i < total ? { i: i++ } : null),
    act: ({ i }) => {
      aiProgress(`AI 正在处理第 ${i + 1} / ${total} 批…`);
      const request = { type: "triage-reading-ai-tag", instruction, items: items.slice(i * cfg.batchSize, (i + 1) * cfg.batchSize), tags, maxNewTags: Math.max(0, opts.maxNewTags - p.newTags.length), allowRemove, aiProviderId: aiProviderId() };
      return chrome.runtime.sendMessage(request).catch((error) => ({ ok: false, error: error.message }));
    },
    judge: MdgRuns.aiJudge(),
    done({ i }, x) {
      if (x.ok) return answered++, UI.mergeAiBatch(p, x.data, opts);
      p.errors.push(`第 ${i + 1} 批失败：${MdgErrors.text(x, MdgErrors.TEXT.unknown)}`);
    }
  });
  if (res.error) p.errors.push(`第 ${i} 批失败：${res.error}`);
  if (run.stopping) p.errors.push(MdgErrors.LABEL.stopped);
  // A new tag no record uses starts unticked, as on the 分拣台.
  for (const t of p.newTags) t.checked = p.rows.some((r) => r.add.includes(UI.aiRef.new(t.key)));
  // A tag deleted during the run is still named by the batches before it.
  if (answered && !UI.aiProposalOk(p, tagOf)) {
    answered = 0;
    p.errors.push(UI.AI_TAG_GONE);
  }
  setAiProposal(answered ? p : null);
  AI.run = null;
  render();
  aiProgress(answered ? "" : p.errors.join("；"));
  const open = TagDialogs.ai.isOpen(aiTags);
  if (open) TagDialogs.ai.render(aiTags);
  // A stop for a setup or access error says so with its remedy, the dialog open or not, as the 分拣台's banner.
  if (res.error) setStatus(answered ? p.errors.at(-1) : UI.aiTagsFailed(p.errors.at(-1)), true, aiRemedy(res));
  else if (open) return;
  else if (answered) setStatus("AI 打标签已完成，按 I 或点「✦ AI 打标签」确认建议");
  else setStatus(UI.aiTagsFailed(p.errors.at(-1)), true);
}

// What a run's stop offers, as the 分拣台's banner: 授权 for a missing access permission, 去设置 for a setup error.
function aiRemedy({ error, code }) {
  const access = MdgErrors.grantOrigin(error, code);
  if (access) return { label: MdgErrors.LABEL.grant, run: async () => (await access.request()) && setStatus(MdgErrors.TEXT.granted) };
  return MdgRuns.aiSettingsCode(code) ? { label: MdgErrors.LABEL.toSettings, run: () => chrome.runtime.openOptionsPage() } : null;
}

// The ticked new tags against the tags there are, in the proposal's order: a name a tag has is that tag; the others are
// created while READING_TAGS has room, and the keys of the rest are skipped. 应用 and the review both go by it.
function newTagPlan(newTags, existing) {
  const tags = [...existing];
  const idFor = {};
  const created = [];
  const skipped = [];
  for (const t of newTags) {
    const name = MdgTagCore.cleanTagName(t.name);
    if (!t.checked || !name) continue;
    let tag = tags.find((x) => x.name === name);
    if (!tag && tags.length < MdgLimits.READING_TAGS) {
      tag = { id: MdgTagCore.newTagId("rt"), name, color: MdgTagCore.nextTagColor(tags) };
      tags.push(tag);
      created.push(tag.id);
    }
    if (tag) idFor[t.key] = tag.id;
    else skipped.push(t.key);
  }
  return { tags, idFor, created, skipped };
}

// 应用: the checked new tags (within READING_TAGS, newTagPlan) and every listed record's change, in one marks write. A
// failed write keeps the proposal.
async function applyAi() {
  const p = AI.proposal;
  if (!p) return;
  setAiProposal(null);
  const live = aiLive();
  let changes = [];
  let created = [];
  let full = 0;
  let before = {};
  const saved = await saveMarks((m) => {
    const plan = newTagPlan(p.newTags, m.tags);
    const { tags, idFor } = plan;
    created = plan.created;
    full = plan.skipped.length;
    const map = Object.fromEntries(Object.entries(m.items).map(([key, item]) => [key, item.tags || []]));
    changes = UI.aiChanges(p, map, live, (key) => idFor[key]);
    const after = new Map(changes.map(([key, , ids]) => [key, ids.filter((id) => tags.some((t) => t.id === id))]));
    before = tagsBefore(m, changes.map(([key]) => key));
    return editItems({ ...m, tags }, Object.fromEntries(changes.map(([key]) => [key, live.get(key)])), (item, key) => ({ ...item, tags: after.get(key) }));
  });
  if (!saved) return setAiProposal(p);
  const n = changes.length;
  // This batch replaces the last one; the list shows it to look over.
  recentFilter = n > 0;
  if (n) {
    AI.recent = { at: Date.now(), keys: changes.map(([key]) => key) };
    await chrome.storage.local.set({ [AI_RECENT]: AI.recent }).catch(() => {});
  }
  if (n || created.length) pushTagUndo(before, Object.fromEntries(changes.map(([key]) => [key, live.get(key)])), `AI 打标签（${n} 个记录）`, { ask: n > 1 ? UI.undoAsk("ai", n, "记录") : null, created, recentAt: n ? AI.recent.at : 0 });
  render();
  setStatus(`${UI.aiApplied(n, "记录", created.length)}${full ? `；${full} 个新标签没有建：${fullReason()}` : ""}`);
}

// ---------- U 撤销, as the 分拣台's tag steps: one per tag save (the tag picker, AI 打标签's 应用), kept on this page ----------
// A step puts its records' tags back as they were (tags deleted since stay off) and deletes the tags it created that no
// record carries any more, in one marks write.
const undoSteps = [];
// The tags of keys in the marks m, before a write changes them.
const tagsBefore = (m, keys) => Object.fromEntries(keys.map((key) => [key, [...(m.items[key]?.tags || [])]]));
function pushTagUndo(before, refs, label, { ask = null, created = [], recentAt = 0 } = {}) {
  undoSteps.push({ before, refs, label, ask, created, recentAt });
  if (undoSteps.length > MdgLimits.TRIAGE_UNDO_STEPS) undoSteps.shift();
}
async function undo() {
  const top = undoSteps.at(-1);
  if (!top) return setStatus(MdgErrors.TEXT.noUndo);
  if (top.ask && !(await UI.askConfirm(...top.ask))) return;
  undoSteps.pop();
  const saved = await saveMarks((m) => {
    const live = new Set(m.tags.map((t) => t.id));
    const out = editItems(m, top.refs, (item, key) => ({ ...item, tags: top.before[key].filter((id) => live.has(id)) }));
    const used = new Set(Object.values(out.items).flatMap((item) => item.tags || []));
    return { ...out, tags: out.tags.filter((t) => !top.created.includes(t.id) || used.has(t.id)) };
  });
  if (!saved) return void undoSteps.push(top);
  if (top.recentAt && AI.recent?.at === top.recentAt) await clearRecent();
  setStatus(`已撤销：${top.label}`);
}

// Own tags come off with a click (U puts them back); the 分拣台's are read-only here, dashed. 「+ 标签」 ends the line.
function renderTags(g) {
  const own = tagsOf(g).map(UI.cardTagChip);
  const triage = triageTagsOf(g).map((t) => `<span class="chip triage-tag" style="--c:${esc(t.color)}" title="分拣台的标签，在分拣台里改">${esc(t.name)}</span>`);
  const plus = readingKey(g) ? UI.tagPlusBtn('data-act="tags"', UI.pickTitle(1, g.title, ""), false) : "";
  return own.length || triage.length || plus ? `<div class="chips">${[...own, ...triage].join("")}${plus}</div>` : "";
}

const NO_RECORDS = "还没有摘读记录";
const SETTINGS_BTN = UI.gearBtn('data-f="settings"', "摘读记录设置");
// Rows 2 and 3 of the head, 全选 and the selection bar; a focused control there gets focus back after the redraw.
function renderHead(all, groups) {
  const focused = els.filters.contains(document.activeElement) && document.activeElement.dataset?.f;
  const stars = visibleGroups({ star: false }, all).filter((g) => g.mark?.star).length;
  const recentKeys = new Set(AI.recent?.keys);
  const recent = UI.aiRecentChip({ attrs: 'data-f="recent"', xAttrs: 'data-f="recent-done"', n: visibleGroups({ recent: false }, all).filter((g) => recentKeys.has(readingKey(g))).length, on: recentFilter, who: "记录", check: RECENT_CHECK });
  const anyTag = visibleGroups({ tags: [] }, all);
  const tagN = visibleGroups({ tagged: "" }, all);
  els.stateRow.innerHTML = UI.labeledRow("状态", UI.stateGroup("全部", UI.filterBtn('data-f="all"', "全部", visibleGroups({ star: false, recent: false, tagged: "" }, all).length, !starFilter && !recentFilter && !tagState)) + UI.stateGroup("星标", UI.filterBtn('data-f="star"', "★ 星标", stars, starFilter)) + UI.tagStateGroup((k) => `data-f="tagstate:${k}"`, (k) => tagN.filter((g) => (g.mark?.tags?.length > 0) === (k === "tagged")).length, tagState) + recent);
  // As the 分拣台's row 4: only the tags the listed records carry, and the ones turned on (so they can be turned off).
  const carrying = (id) => anyTag.filter((g) => g.mark?.tags?.includes(id)).length;
  els.tagRow.innerHTML = UI.labeledRow("标签", marks.tags.filter((t) => carrying(t.id) || tagFilter.has(t.id)).map((t) => UI.tagFilterChip(`data-f="tag:${esc(t.id)}"`, { name: t.name, color: t.color, n: carrying(t.id), on: tagFilter.has(t.id), what: "记录" })).join(""));
  // 「选中的 N 个」 counts records, as the dialog's 选中 does.
  const picked = aiRecords("selected").size || recordsOf(all.filter((g) => selected.has(g.key))).size;
  els.tagActs.innerHTML = UI.tagButtons({ manageAttrs: 'data-f="manage"', aiAttrs: 'data-f="ai"', who: "记录", running: Boolean(AI.run), pending: Boolean(AI.proposal), picked, aiReason: aiReason(all) }) + SETTINGS_BTN;
  const filtered = filtersOn();
  UI.setSearchScope(els.search, MdgErrors.LABEL.history, [starFilter && "星标", recentFilter && UI.AI_RECENT, ...[...tagFilter].map((id) => tagOf(id)?.name)].filter(Boolean).join(" · "));
  els.searchCount.textContent = UI.resultCount(els.search.value.trim() || filtered, groups.length);
  const shown = shownPicks(groups);
  els.selectAllSlot.innerHTML = UI.selectAllBox('data-f="select-all"', groups.length, shown.length, "这里没有列出记录");
  // The bar's buttons act on the listed selected records and say how many; when the search and filters hide every
  // selected one they count all of them, off with selbar's none, as on the 分拣台.
  const n = shown.length || selected.size;
  // 删除 removes AI conversations only, so its N counts the selected records that have one and says when that is fewer.
  // A YouTube video's 备注 is not on the 分拣台 (B站 收藏夹 only), so the reason names no other place.
  const del = deletableKeys(shown.length ? shown : [...selected]).length;
  const acts = (none) =>
    UI.actBtn('data-sel="md"', n > 1 ? `打包下载选中的 ${n} 个 .md` : "下载选中的 1 个 .md", { reason: none }) +
    UI.actBtn('data-sel="tags"', "打标签", { reason: none }) +
    UI.actBtn('data-sel="delete"', del ? `删除选中的 ${del} 个的 AI 对话` : "删除选中的 AI 对话", { cls: "danger", reason: none || (del ? "" : "选中的记录没有 AI 对话"), title: del < n ? `选中的 ${n} 个里，${n - del} 个没有 AI 对话，删除后会留下` : "" });
  els.selbar.innerHTML = selected.size ? UI.selbar({ label: "选中的记录", n: shown.length, hidden: selected.size - shown.length, clearAttrs: 'data-sel="clear"', acts }) : "";
  setReason(els.clearAll, !conversations.length ? "还没有 AI 对话" : conversations.every(isStarredConv) ? "只剩加了星标的记录的 AI 对话" : "");
  if (focused) [...els.filters.querySelectorAll("[data-f]")].find((b) => b.dataset.f === focused)?.focus();
}

// A filter narrows the list (the search aside): the head's result count and the empty list's words go by it.
const filtersOn = () => Boolean(starFilter || recentFilter || tagState || tagFilter.size);

// The listed records. A count leaves out its own group's choice (star, tagged, recent or tags) and keeps the rest, the search
// too, as the 分拣台's counts do (DESIGN 筛选和计数).
function visibleGroups({ star = starFilter, recent = recentFilter, tagged = tagState, tags = tagFilter } = {}, all = groupByVideo(conversations)) {
  const words = searchWords(els.search.value);
  // 星标 and the tag chips narrow the list; several tags are ANDed, as on the 分拣台.
  const recentKeys = new Set(recent ? AI.recent?.keys : []);
  const groups = all.filter((g) => (!recent || recentKeys.has(readingKey(g))) && (!star || g.mark?.star || starEdited.has(readingKey(g))) && (!tagged || (g.mark?.tags?.length > 0) === (tagged === "tagged")) && [...tags].every((id) => g.mark?.tags?.includes(id)));
  if (!words.length) return groups;
  // As the 分拣台's search: every word somewhere in the record, any case.
  return groups.filter((g) =>
    hasWords([g.title, g.context.title, g.context.author, MdgNote.buildTriageSummary(g.analysis), g.note?.text, ...[...tagsOf(g), ...triageTagsOf(g)].map((t) => t.name), ...g.convs.flatMap((c) => (c.messages || []).map((m) => m.content))].filter(Boolean).join("\n"), words)
  );
}

// The 分拣台's AI 总结 as on its cards: the verdict badge and the one-liner on one line, cut off with an ellipsis; a click
// shows it whole with the points and the reason.
function renderSummary(g) {
  const a = g.analysis;
  const { verdict } = MdgTagCore.verdictOf({ analysis: a });
  const open = unfolded.has(g.key);
  const points = (a.points || []).filter(Boolean);
  const more = open ? `${points.length ? `<ol class="points">${points.map((p) => `<li>${esc(p)}</li>`).join("")}</ol>` : ""}${a.oneLiner && a.reason ? `<p class="summary-reason">${esc(a.reason)}</p>` : ""}` : "";
  return `<button type="button" class="entry-summary${open ? " open" : ""}" data-act="summary" aria-expanded="${open}"><span class="badge ${verdict}"><span class="ai-mark">AI</span>${MdgTagCore.VERDICTS[verdict]}</span> ${esc(a.oneLiner || a.reason || "")}</button>${more}`;
}

// A web page's record (not a video, with an http(s) address): 继续问 goes on in the page's own tab.
const isWebPage = (g) => !g.context.videoId && /^https?:\/\//i.test(g.context.url || "");
// A video the background reads only from its open page (YouTube: MdgSites pageOnly): 继续问 goes on in its tab too.
const readsFromPage = (g) => isWebPage(g) || Boolean(g.context.videoId && MdgSites.SITES[g.context.site]?.pageOnly);
// The tab showing the record: a video by site and id (any time or list parameter), a page by its URL without #.
function showsRecord(g, url) {
  if (!url) return false;
  if (!g.context.videoId) return MdgSites.buildContextKey({ url }) === MdgSites.buildContextKey({ url: g.context.url });
  const ref = MdgSites.parseRef(url);
  return ref?.site === g.context.site && ref.id === g.context.videoId;
}

// 继续问 on a web page or a page-only video: the side panel reads it from its tab, so it opens on this window inside the
// click (sidePanel.open needs the gesture), then its tab in this window is focused, or opened, and the panel asked for
// the conversation as a video's is (askSidepanel).
function askAboutPage(group) {
  const opening = chrome.sidePanel.open({ windowId: OWN_TAB?.windowId });
  setStatus(MdgErrors.TEXT.sidepanelOpening);
  void (async () => {
    try {
      await opening;
      const found = (await chrome.tabs.query({ windowId: OWN_TAB?.windowId })).find((t) => showsRecord(group, t.url));
      const url = group.context.videoId ? MdgSites.videoUrl(group.context) : group.context.url;
      const tab = found ? await chrome.tabs.update(found.id, { active: true }) : await chrome.tabs.create({ url, windowId: OWN_TAB?.windowId });
      await MdgLimits.askSidepanel({ tabId: tab.id, contextRef: group.context });
      setStatus("");
    } catch (error) {
      setStatus(`${MdgErrors.TEXT.sidepanelOpenFailed}：${error.message}`, true);
    }
  })();
}

// The 备注 belongs to the video: every part's entry shows and edits the same one, like grouping joins it.
const noteIdOf = (g) => g.context.videoId || "";

function renderNote(g) {
  const id = noteIdOf(g);
  if (id && editing?.id === id) return `<textarea class="note" name="entryNote" data-note rows="2" placeholder="${MdgErrors.TEXT.notePlaceholder}" aria-label="备注">${esc(editing.draft)}</textarea>`;
  if (!g.note) return id ? `<button type="button" class="quiet note-add" data-act="note">${MdgErrors.LABEL.noteAdd}</button>` : "";
  const body = `<b>备注</b> ${esc(g.note.text.trim())}`;
  return id ? `<button type="button" class="note" data-act="note" title="点击编辑备注">${body}</button>` : `<div class="note">${body}</div>`;
}

// MdgLimits.saveVideoNote, like the side panel and 分拣台: an unchanged note is not rewritten, an emptied one is deleted.
async function closeNote() {
  if (!editing) return;
  const { id, draft } = editing;
  editing = null;
  try {
    if (await MdgLimits.saveVideoNote(id, draft)) {
      if (draft.trim()) notes[id] = { text: draft, updatedAt: Date.now() };
      else delete notes[id];
      setStatus(draft.trim() ? "备注已保存" : "备注已删除");
    }
  } catch (error) {
    setStatus(`保存备注失败：${error?.message || MdgErrors.TEXT.unknown}`, true);
  }
  const redraw = reloadPending ? load : render;
  reloadPending = false;
  // Closed by pressing another control (focusout on pointerdown): redraw after its click, which a new list would swallow.
  if (pressing) document.addEventListener("pointerup", () => setTimeout(redraw), { once: true });
  else await redraw();
}

function renderConversation(conv, index, total) {
  const turns = MdgNote.buildConversationTurns(conv.messages, 0)
    .map((t) => `<p class="turn-q">问：${esc(t.prompt)}</p><div class="turn-a">${MdgNote.renderMarkdown(t.answer)}</div>`)
    .join("");
  return `${total > 1 ? `<p class="conv-sep">对话 ${index + 1} · ${esc(formatTime(conv.updatedAt))}</p>` : ""}${turns}`;
}

// An entry by its key, without building a selector from the key (it is a contextKey or a saved id).
const entryOf = (key) => [...els.list.querySelectorAll(".entry")].find((e) => e.dataset.key === key);

function render() {
  const groups = visibleGroups();
  const allGroups = groupByVideo(conversations);
  // Records of web pages are not videos: counted on their own. A video's parts are one video, as for 星标, tags and 备注.
  const videos = new Set(allGroups.filter((g) => g.context.videoId).map((g) => readingKey(g) || g.key)).size;
  const pages = allGroups.filter((g) => !g.context.videoId).length;
  const { counted, starred } = MdgLimits.conversationCounts(conversations, marks);
  els.count.textContent = `${videos} 个视频${pages ? `、${pages} 个网页` : ""} · 对话 ${counted}/${MdgLimits.AI_CONVERSATIONS}${starred ? `，星标 ${starred} 段不计` : ""}`;
  // A search keeps hidden selections, like the 分拣台; only a video that is gone leaves the selection.
  for (const key of [...selected]) if (!allGroups.some((g) => g.key === key)) selected.delete(key);
  // Storage changes re-render the list while the user reads it: keep expanded entries (expanded) and the scroll.
  // New entries land above the one being read, so the first entry in view keeps its offset (by its key, not scrollY).
  const scrollY = window.scrollY;
  const top = [...els.list.querySelectorAll(".entry")].find((e) => e.getBoundingClientRect().bottom > 0);
  const anchor = top && { key: top.dataset.key, offset: top.getBoundingClientRect().top };
  const active = document.activeElement?.matches?.("[data-note]") ? document.activeElement : null;
  const caret = active ? [active.selectionStart, active.selectionEnd] : null;
  // A focused control is replaced too: the new list gives focus back to the same entry's same control.
  const act = document.activeElement?.dataset?.act;
  const actKey = act && document.activeElement.closest(".entry")?.dataset.key;
  rendering = true;
  els.list.innerHTML = groups.length
    ? groups.map((g) => {
        const site = siteOf(g);
        const turnCount = g.convs.reduce((n, c) => n + MdgNote.buildConversationTurns(c.messages).length, 0);
        // A video whose title never arrived falls back to its id; show that as 未获取标题 with the id in the meta line.
        const untitled = g.title === g.context.videoId;
        const label = untitled ? "未获取标题" : g.title;
        // Only web links: a saved context URL is shown as a link, never as a javascript: or other scheme.
        const title = /^https?:\/\//i.test(g.context.url || "") ? `<a class="title" href="${esc(g.context.url)}" target="_blank" rel="noopener">${esc(label)}</a>` : `<span class="title">${esc(label)}</span>`;
        const only = [g.analysis && "分拣台 AI 总结", g.note && "备注", g.mark?.star && "星标", g.mark?.tags?.length && "标签"].filter(Boolean);
        const kind = g.convs.length ? (g.convs.length > 1 ? `${g.convs.length} 段对话` : "") : only.length ? `仅${only.length > 1 ? `${only.slice(0, -1).join("、")}和${only.at(-1)}` : only[0]}，没有 AI 对话` : "没有 AI 对话";
        const starred = Boolean(g.mark?.star);
        const star = readingKey(g) ? `<button type="button" class="star" data-act="star" aria-pressed="${starred}" aria-label="${starred ? "取消星标" : "加星标"}" title="${starred ? "取消星标" : "加星标"}">${starred ? "★" : "☆"}</button>` : "";
        const obsidian = obsidianEnabled ? `<button type="button" data-act="obsidian"${writing.has(g.key) ? " disabled" : ""}><img class="obsidian-mark" src="/icons/obsidian.svg" alt=""> <span class="write-label" data-idle="${MdgErrors.LABEL.writeObsidian}">${writing.has(g.key) ? `<span aria-busy="true">${MdgErrors.TEXT.writing}</span>` : `<span>${MdgErrors.LABEL.writeObsidian}</span>`}</span></button>` : "";
        // Top right, two rows of equal columns: 继续问 and the exports in their order. The 问答 line runs under the body and
        // the buttons, with 删除 AI 对话 at its right end: it reads as deleting those, not the record.
        return `<article class="card entry${selected.has(g.key) ? " selected" : ""}" data-key="${esc(g.key)}">
          <input type="checkbox" name="selectedConversation" data-act="pick" aria-label="选择" ${selected.has(g.key) ? "checked" : ""} />
          ${star}
          <div class="card-body">
            ${title}
            <div class="meta">${[site, formatTime(g.updatedAt), untitled && g.context.videoId, kind].filter(Boolean).map(esc).join(" · ")}</div>
            ${g.analysis ? renderSummary(g) : ""}
            ${renderTags(g)}
            ${renderNote(g)}
          </div>
          <div class="entry-acts"><button type="button" class="ask" data-act="ask"${g.context.videoId || isWebPage(g) ? "" : " data-no-video"}>${UI.AI_SPARK}继续问</button><button type="button" data-act="copy">${MdgErrors.LABEL.copyMd}</button><button type="button" data-act="md">${MdgErrors.LABEL.downloadMd}</button>${obsidian}</div>
          ${g.convs.length ? `<div class="qa"><details${expanded.has(g.key) ? " open" : ""}><summary>查看 ${turnCount} 轮问答</summary>${g.convs.map((c, i) => renderConversation(c, i, g.convs.length)).join("")}</details><button type="button" data-act="delete" class="quiet danger">删除 AI 对话</button></div>` : ""}
        </article>`;
      }).join("")
    : allGroups.length ? `<p class="empty">${UI.noMatch(els.search.value, filtersOn(), "记录")}</p>`
    : UI.emptyState(NO_RECORDS, "在侧边栏提问，或在分拣台细看、写备注后，会按视频和网页记在这里。");
  rendering = false;
  // 继续问 on a record that is not a video: off with why, the page's one way (setReason).
  for (const b of els.list.querySelectorAll("[data-no-video]")) setReason(b, MdgErrors.TEXT.notVideo);
  const textarea = editing && els.list.querySelector("[data-note]");
  if (textarea) {
    textarea.focus();
    textarea.setSelectionRange(...(caret || [textarea.value.length, textarea.value.length]));
  } else if (actKey) entryOf(actKey)?.querySelector(`[data-act="${act}"]`)?.focus({ preventScroll: true });
  const again = anchor && entryOf(anchor.key);
  if (again) window.scrollBy(0, again.getBoundingClientRect().top - anchor.offset);
  else window.scrollTo(0, scrollY);
  renderHead(allGroups, groups);
}


// 「正在…」 lines are in progress: aria-busy grays them (tokens.css) until the result replaces them.
// error: a failure the user must handle (red); action: { label, run }, its remedy button after the text.
function setStatus(text, error = false, action = null) {
  els.status.textContent = text;
  if (action) {
    const btn = Object.assign(document.createElement("button"), { type: "button", className: "act-btn", textContent: action.label, onclick: action.run });
    els.status.append(" ", btn);
  }
  els.status.classList.toggle("is-error", error);
  if (text.startsWith("正在")) els.status.setAttribute("aria-busy", "true");
  else els.status.removeAttribute("aria-busy");
}

async function load() {
  // ponytail: reads all of storage (subtitle caches included) to find the triage keys; getKeys() first if that gets slow.
  const all = await chrome.storage.local.get(null);
  stored = all;
  marks = { tags: all[MARKS_KEY]?.tags || [], items: all[MARKS_KEY]?.items || {} };
  triageTagById = new Map((all[TRIAGE_TAGS] || []).map((t) => [t.id, t]));
  triageVideoTags = all[TRIAGE_VIDEO_TAGS] || {};
  for (const id of [...tagFilter]) if (!tagOf(id)) tagFilter.delete(id);
  AI.recent = all[AI_RECENT] || null;
  if (!AI.recent?.keys?.length) recentFilter = false;
  // The proposal in memory (maybe edited in the review) wins over the stored one.
  if (!AI.proposal && !AI.run) AI.proposal = all[AI_PROPOSAL] || null;
  dropStaleProposal();
  conversations = (all[KEY] || []).filter((c) => c?.id && Array.isArray(c.messages));
  analyses = {};
  notes = Object.fromEntries(Object.entries(all[NOTES_KEY] || {}).filter(([, n]) => String(n?.text || "").trim()));
  triageTitles = {};
  for (const [k, v] of Object.entries(all)) {
    if (k.startsWith(ANALYSIS) && v?.status === "done") analyses[k.slice(ANALYSIS.length)] = v;
    else if (k.startsWith(SNAPSHOT)) Object.assign(triageTitles, v?.titles);
  }
  render();
}

// The selected records the search and filters list: what the selection bar acts on.
const shownPicks = (groups) => groups.filter((g) => selected.has(g.key)).map((g) => g.key);

// Triage-summary-only and note-only entries have no conversations to delete, so they are left out.
function deletableKeys(keys) {
  const withConvs = new Set(conversations.map((c) => c.contextKey || c.id));
  return keys.filter((key) => withConvs.has(key));
}

// Drops the conversations from the list at once, then writes. The write reads storage again so a reply the side panel
// saved meanwhile is kept; if it fails, the list (and the selection) is read back from storage and the line says so.
async function removeConversations(keep, done, unselect = []) {
  const picked = new Set(selected);
  unselect.forEach((key) => selected.delete(key));
  conversations = conversations.filter(keep);
  render();
  try {
    await MdgLimits.updateConversations((current) => current.filter(keep));
  } catch (error) {
    picked.forEach((key) => selected.add(key));
    await load();
    return setStatus(`${MdgErrors.TEXT.deleteFailed}：${error?.message || MdgErrors.TEXT.unknown}`, true);
  }
  setStatus(done);
}

async function deleteGroups(keys) {
  keys = deletableKeys(keys);
  if (!keys.length || !confirm(`删除 ${keys.length} 条记录的全部 AI 对话？删除后不能恢复。`)) return;
  await removeConversations((c) => !keys.includes(c?.contextKey || c?.id), `已删除 ${keys.length} 条记录的 AI 对话`, keys);
}

// What a record's three buttons send: the record and its newest conversation (the one auto-sync keeps in the note),
// read again at each send so a reply saved while a dialog was open goes in too.
function noteRequest(group) {
  const g = groupByVideo(conversations).find((x) => x.key === group.key) || group;
  const newest = g.convs.reduce((a, b) => ((b.updatedAt || 0) > (a.updatedAt || 0) ? b : a), g.convs[0]);
  return { ref: g.context, conversation: { messages: newest?.messages || [] } };
}

// 复制, 下载 and 写入 Obsidian of one record (kind copy / download / write) through MdgNoteActions: the note 写入
// Obsidian writes, asked about the same way when its page is not open. The status line says the result; not set up or
// a wrong key adds 去设置, opened only on its click (a closed Obsidian only gets the red line).
async function runNoteAction(group, kind) {
  const r = await MdgNoteActions.run(kind, { request: () => noteRequest(group) });
  const settings = r.remedies.includes("settings") ? { label: MdgErrors.LABEL.toSettings, run: () => chrome.runtime.openOptionsPage() } : null;
  setStatus(r.text, !r.ok, settings);
}

const copyGroup = (group) => runNoteAction(group, "copy");

// One record: its note, asked about as 复制. Several go into one zip without a dialog or a tab opened: a record whose note
// needs its page that no tab shows gets its AI 笔记 (pageChoice own), and the status line counts them.
async function downloadGroups(groups) {
  try {
    if (groups.length === 1) return await runNoteAction(groups[0], "download");
    setStatus(`正在打包 ${groups.length} 条记录…`);
    const notes = [];
    let noPage = 0;
    let failed = 0;
    for (const g of groups) {
      const resp = await MdgNoteActions.build({ ...noteRequest(g), pageChoice: "own" }).catch(() => null);
      if (resp?.ok && resp.markdown) {
        notes.push(resp);
        if (resp.noPage) noPage++;
      } else {
        // No note to build (B站 unreachable, nothing recorded): the AI 笔记 still keeps the record.
        failed++;
        const { filename, content } = buildNote(g);
        notes.push({ filename, markdown: content });
      }
    }
    const used = new Set();
    const files = notes.map((n) => ({ name: MdgDownload.uniqueName(used, n.filename), text: n.markdown }));
    MdgDownload.text(`MoonDigest摘读记录-${MdgCommon.localDate(new Date(), true)}.zip`, MdgDownload.zipStored(files), "application/zip");
    setStatus([`已下载 ${groups.length} 条记录`, noPage && `${noPage} 条没打开页面，放的是 AI 笔记`, failed && `${failed} 条生成不了笔记，放的是 AI 笔记`].filter(Boolean).join("，"));
  } catch (error) {
    setStatus(`${MdgErrors.TEXT.downloadFailed}：${error?.message || MdgErrors.TEXT.unknown}`, true);
  }
}

// The background (write-video-note) decides where it goes, as for the side panel's 写入 Obsidian: the video note with
// the newest conversation in its AI 问答 section (the one auto-sync keeps current), or the conversation's own note.
// This page asks before an existing note is touched.
async function saveToObsidian(group) {
  writing.add(group.key);
  setStatus(MdgErrors.TEXT.obsidianWriting);
  render();
  try {
    await runNoteAction(group, "write");
  } finally {
    writing.delete(group.key);
    render();
  }
}

els.list.addEventListener("click", (event) => {
  const target = event.target.closest("[data-act], [data-untag]");
  const entry = target?.closest(".entry");
  if (!entry) return;
  const key = entry.dataset.key;
  const group = groupByVideo(conversations).find((g) => g.key === key);
  const act = target.dataset.act;
  if (target.dataset.untag && group) void untag(group, target.dataset.untag);
  else if (act === "pick") {
    target.checked ? selected.add(key) : selected.delete(key);
    render();
  } else if (act === "copy" && group) void copyGroup(group);
  else if (act === "md" && group) void downloadGroups([group]);
  else if (act === "obsidian" && group) void saveToObsidian(group);
  else if (act === "delete") void deleteGroups([key]);
  else if (act === "summary") {
    unfolded.has(key) ? unfolded.delete(key) : unfolded.add(key);
    render();
  }
  else if (act === "note" && group) {
    editing = { id: noteIdOf(group), draft: group.note?.text || "" };
    render();
  }
  else if (act === "star" && group) void toggleStar(group);
  else if (act === "tags" && group) openPicker([group], `.entry[data-key="${CSS.escape(key)}"] .tag-plus`);
  else if (act === "ask" && group && readsFromPage(group)) askAboutPage(group);
  else if (act === "ask" && group) {
    // The side panel continues the video's latest conversation, the same request triage's 问 AI sends.
    MdgLimits.askSidepanel({ tabId: OWN_TAB?.id, contextRef: group.context });
    const opening = MdgErrors.TEXT.sidepanelOpening;
    setStatus(opening);
    chrome.sidePanel.open({ tabId: OWN_TAB?.id }).then(
      () => els.status.textContent === opening && setStatus(""),
      (error) => setStatus(`${MdgErrors.TEXT.sidepanelOpenFailed}：${error.message}`, true)
    );
  }
});
// toggle does not bubble: caught on the way down.
els.list.addEventListener("toggle", (event) => {
  const key = event.target.closest?.(".entry")?.dataset.key;
  if (key) event.target.open ? expanded.add(key) : expanded.delete(key);
}, true);
els.list.addEventListener("input", (event) => {
  if (editing && event.target.matches("[data-note]")) editing.draft = event.target.value;
});
// Enter (or Esc) saves and closes; Shift+Enter is a newline. Never mid-IME.
els.list.addEventListener("keydown", (event) => {
  if (MdgTyping.composing(event) || !event.target.matches("[data-note]")) return;
  if (!(event.key === "Escape" || (event.key === "Enter" && !event.shiftKey))) return;
  event.preventDefault();
  void closeNote();
});
els.list.addEventListener("focusout", (event) => {
  if (!rendering && event.target.matches("[data-note]")) void closeNote();
});
UI.bindSearch(els.search, () => render());
els.selbar.addEventListener("click", (event) => {
  const act = event.target.closest("[data-sel]")?.dataset.sel;
  const picks = visibleGroups().filter((g) => selected.has(g.key));
  if (act === "md") void downloadGroups(picks);
  else if (act === "tags") openPicker(picks);
  else if (act === "delete") void deleteGroups(picks.map((g) => g.key));
  else if (act === "clear") {
    selected.clear();
    render();
  }
});
els.filters.addEventListener("click", (event) => {
  const f = event.target.closest("[data-f]")?.dataset.f;
  if (f === "manage") return TagDialogs.manage.open(manageTags);
  if (f === "ai") return void openAi();
  if (f === "settings") return void openSettings();
  if (f === "recent-done") return void clearRecent();
  if (f === "select-all") UI.toggleAll(visibleGroups().map((g) => g.key), selected);
  else if (f === "all") {
    starFilter = recentFilter = false;
    tagState = "";
  } else if (f?.startsWith("tagstate:")) tagState = tagState === f.slice(9) ? "" : f.slice(9);
  else if (f === "recent") recentFilter = !recentFilter;
  else if (f === "star") starFilter = !starFilter;
  else if (f?.startsWith("tag:")) {
    const id = f.slice(4);
    tagFilter.has(id) ? tagFilter.delete(id) : tagFilter.add(id);
  } else return;
  render();
});
// I, U and / as on the 分拣台: not while typing or with a dialog open.
document.addEventListener("keydown", (e) => {
  if (MdgTyping.composing(e) || MdgTyping.typingIn(e) || e.metaKey || e.ctrlKey || e.altKey || document.querySelector("dialog[open]")) return;
  const run = { i: openAi, u: undo, "/": () => els.search.focus() }[e.key.toLowerCase()];
  if (!run) return;
  e.preventDefault();
  void run();
});
const settingsDialog = $("readingSettingsDialog");
UI.fillSetRows(settingsDialog);
UI.clampNumbers(settingsDialog);
settingsDialog.querySelector("[data-open-options]").addEventListener("click", () => chrome.runtime.openOptionsPage());
// 摘读记录设置's fields as the values they store; settingsShown is what they held when the dialog opened (as 收藏夹设置's).
const settingsFields = () => normAi({ batchSize: $("rsBatchInput").value, intervalSec: $("rsIntervalInput").value, newTagMax: $("rsNewMaxInput").value, allowRemove: $("rsRemoveInput").checked });
let settingsShown = {};
async function openSettings() {
  const s = await aiSettings();
  $("rsBatchInput").value = s.batchSize;
  $("rsIntervalInput").value = s.intervalSec;
  $("rsNewMaxInput").value = s.newTagMax;
  $("rsRemoveInput").checked = s.allowRemove;
  settingsShown = settingsFields();
  settingsDialog.returnValue = "";
  settingsDialog.showModal();
}
settingsDialog.addEventListener("close", async () => {
  if (settingsDialog.returnValue !== "save") return;
  // Only the fields changed since the dialog opened, over what is stored now: a setting imported meanwhile keeps its value.
  const patch = UI.changedFields(settingsFields(), settingsShown);
  if (!Object.keys(patch).length || (await saveAiSettings({ ...(await aiSettings()), ...patch }))) setStatus(MdgErrors.TEXT.settingsSaved);
});
// AI conversations only: triage analyses and notes are other features' data and stay. A starred record's are kept too
// (星标 keeps a record with its conversations); its own 删除 AI 对话 still deletes them.
const isStarredConv = (c) => Boolean(marks.items[MdgLimits.readingKeyOf(c.contextKey)]?.star);
els.clearAll.addEventListener("click", async () => {
  const kept = conversations.filter(isStarredConv).length;
  if (!confirm(`清空全部 AI 对话？${kept ? `加了星标的记录的 ${kept} 段不删。` : ""}删除后不能恢复。`)) return;
  // Entries left with an AI 总结 or a 备注 stay selected; render drops the ones that left the list.
  await removeConversations(isStarredConv, kept ? "已清空没有星标的 AI 对话" : "已清空全部 AI 对话");
});
chrome.storage.onChanged.addListener((changes, area) => {
  // Triage analyses arrive in bursts; one reload per burst.
  if (area === "local" && Object.keys(changes).some((k) => [KEY, NOTES_KEY, MARKS_KEY, TRIAGE_TAGS, TRIAGE_VIDEO_TAGS].includes(k) || k.startsWith(ANALYSIS) || k.startsWith(SNAPSHOT))) {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => (editing ? (reloadPending = true) : load()), 300);
  }
  if (area === "sync" && changes.obsidianEnabled) {
    obsidianEnabled = MdgSettings.normalizeSwitches({ obsidianEnabled: changes.obsidianEnabled.newValue }).obsidianEnabled;
    render();
  }
});

obsidianEnabled = (await chrome.runtime.sendMessage({ type: "get-settings" }).catch(() => null))?.settings?.obsidianEnabled ?? MdgSettings.DEFAULTS.obsidianEnabled;
await load();
