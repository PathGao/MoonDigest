// 关注's pure functions (follow.js is the page): 更新状态, the UP 主 rows and their filters, groups, sorting, the feed,
// tags and the AI settings. They compute only from their arguments and TriageUi: no DOM, chrome.*, page state or timers.
// triage.html loads this before follow.js; the worker loads it before follow-bg.js (groupsOf).
(() => {
  const UI = globalThis.TriageUi;
  const DAY = 86400;
  const ALL = "全部"; // row 3's first button, the sidebar's first item and 已出分拣范围's first tab
  const STATUS = [["", ALL], ["active", "活跃"], ["slow", "慢更"], ["dead", "断更"], ["stale", "待查"], ["none", "没投过稿"], ["unchecked", "未查"]];

  // The newest post we know of, in seconds: the video feed (re-read on every sync) first, then the UP's own videos
  // (follow_content, fetched once for people the feed did not show). 0 = none known.
  function lastPostOf(mid, D) {
    const c = D.content?.[mid];
    const own = c?.code === 0 ? (c.v || []).map((v) => v.c || 0) : [];
    const feed = (D.last?.v?.[mid] || []).map((v) => v.c || 0);
    return Math.max(0, D.last?.map?.[mid] || 0, ...own, ...feed);
  }

  // 更新状态: active | slow | dead by the newest post; none = 没投过稿 (or the account is gone); stale = the feed reached
  // back past slowDays without them and their videos were not read yet (慢更还是断更待查); unchecked = 未查.
  function followStatus(mid, D, now, slowDays = UI.numSetting("slowDays"), deadDays = UI.numSetting("deadDays")) {
    const last = lastPostOf(mid, D);
    if (last) {
      const days = (now - last) / DAY;
      return days >= deadDays ? "dead" : days >= slowDays ? "slow" : "active";
    }
    const c = D.content?.[mid];
    if (c && (c.code === 0 || UI.UP_GONE_CODES.has(c.code))) return "none";
    if (D.last?.since && D.last.since <= now - slowDays * DAY) return "stale";
    return "unchecked";
  }

  // The feed read still going over the last finished one, so 更新状态 change as it goes (shared.js, as the AI 打标签 reads it).
  const withFeedInProgress = (last, wip) => UI.withFeedInProgress(last, wip);

  // The newest titles from both sources, as the AI 打标签 gets them (shared.js upTitles).
  const recentTitles = (mid, D) => UI.upTitles(D.last?.v?.[mid], D.content?.[mid]);

  const liveTags = (mid, D) => (D.map?.[mid] || []).filter((id) => D.tags.some((t) => t.id === id));

  function upRow(mid, D, now, cfg) {
    const p = D.people?.[mid] || {};
    const c = D.content?.[mid];
    const gone = D.gone?.[mid] || null;
    return {
      mid,
      name: p.name || `未获取名字（${mid}）`,
      face: p.face || "",
      sign: p.sign || "",
      ov: p.ov || "",
      status: followStatus(mid, D, now, cfg.slowDays, cfg.deadDays),
      last: lastPostOf(mid, D),
      count: c?.code === 0 ? c.count || 0 : 0,
      closed: Boolean(p.gone) || UI.UP_GONE_CODES.has(c?.code),
      // No videos now, but they have been watched: 投稿已清空 (banned, taken down or deleted; B站 does not say which).
      cleared: c?.code === 0 && !c.count && c.views > 0 && !lastPostOf(mid, D),
      zone: Object.entries(c?.tlist || {}).sort((a, b) => b[1] - a[1])[0]?.[0] || "",
      titles: recentTitles(mid, D),
      followed: D.list?.followTime?.[mid] || 0,
      fans: Number.isFinite(D.stats?.[mid]?.follower) ? D.stats[mid].follower : null,
      special: Boolean(D.list?.special?.[mid]),
      gone,
      // An unfollowed UP keeps the tags it had, to put back on 重新关注.
      tagIds: gone ? (gone.tagIds || []).filter((id) => D.tags.some((t) => t.id === id)) : liveTags(mid, D)
    };
  }

  // B站's 关注分组 are left-column items "g:<tagid>": its fixed 0 默认分组 and -10 特别关注, then your own (follow_groups).
  // An UP's groups are follow_list.special (-10) and follow_list.groups; 默认分组 = in none of your own.
  const SPECIAL = globalThis.TriageUi.FOLLOW_SPECIAL;
  const groupId = (side) => (/^g:-?\d+$/.test(side) ? Number(side.slice(2)) : null);
  const groupsOf = (mid, D) => [...(D.list?.special?.[mid] ? [SPECIAL] : []), ...(D.list?.groups?.[mid] || []).filter((id) => id > 0)];
  const inGroupId = (mid, D, id) => (id === 0 ? !groupsOf(mid, D).some((x) => x > 0) : groupsOf(mid, D).includes(id));
  const inGroup = (mid, D, side) => inGroupId(mid, D, groupId(side));
  const groupName = (id, D) => (id === 0 ? "默认分组" : id === SPECIAL ? "特别关注" : (D.groups || []).find((g) => g.id === id)?.name || "");
  // An UP's 关注分组 by name, as its card says them: ★ 特别关注 is a flag on top of the groups, so with none of your own it
  // is in 默认分组 too. Groups deleted since are left out.
  const groupNames = (gids, D) => [...gids.filter((id) => id === SPECIAL), ...(gids.some((id) => id > 0) ? gids.filter((id) => id > 0) : [0])].map((id) => groupName(id, D)).filter(Boolean);
  // How many followed UP 主 a group has on B站, the 已注销 and 投稿已清空 too (the sidebar's count leaves them out).
  const groupMembers = (D, id) => (D.list?.list || []).filter((m) => inGroupId(m, D, id)).length;
  // Every left-column id: the sidebar is scope only (tags are row 3 and row 4).
  const sideIds = (D) => ["all", "g:0", `g:${SPECIAL}`, ...(D.groups || []).map((g) => `g:${g.id}`), "out"];

  // 已出分拣范围, as 收藏夹's: why an UP left the list, its row-2 tab. gone = 已取消关注 (a record, no longer followed);
  // closed and cleared are still followed on B站 but have nothing to sort: the account is gone, or no video is left.
  // Where an UP was unfollowed (follow_unfollowed's source): row 3's buttons, its card and the 刷新 result.
  const SOURCE = { bili: "在 B站取消关注", app: "在分拣台取消关注" };
  const OUT_KINDS = [["gone", "已取消关注"], ["closed", "已注销"], ["cleared", "投稿已清空"]];
  const outKind = (u) => (u.gone ? "gone" : u.closed ? "closed" : u.cleared ? "cleared" : "");

  // 移到 / 复制到 in the toast and U. 特别关注 is a flag on top of the groups (B站): from 默认分组 into it is an add, the UP stays.
  const groupMoveLabel = (from, to, move, D) => `${move && from === 0 && to === SPECIAL ? "加进" : move ? "移到" : "复制到"}「${groupName(to, D)}」`;
  // An UP's groups after leaving from (null: nothing, a copy) and joining to (0: none).
  const regrouped = (ids, from, to) => [...ids.filter((id) => id !== from), ...(to !== 0 && !ids.includes(to) ? [to] : [])];
  // The follow-group-move requests that take mids from cur(mid) to want(mid): one per (from, to), at most size UP 主 each.
  // Only joining is a copy (from []); leaving moves to what joins, else to what is left, else to 默认分组 (0).
  function groupCalls(mids, cur, want, size = 20) {
    const ops = new Map();
    for (const m of mids) {
      const c = cur(m);
      const w = want(m);
      const from = c.filter((id) => !w.includes(id));
      const add = w.filter((id) => !c.includes(id));
      const to = add.length ? add : from.length ? (w.length ? w : [0]) : [];
      if (!to.length) continue;
      const key = `${from}|${to}`;
      if (!ops.has(key)) ops.set(key, { from, to, mids: [] });
      ops.get(key).mids.push(m);
    }
    return [...ops.values()].flatMap(({ from, to, mids: list }) => {
      const out = [];
      for (let i = 0; i < list.length; i += size) out.push({ type: "follow-group-move", mids: list.slice(i, i + size), from, to });
      return out;
    });
  }
  // Where 移动 / 复制到分组 can go from the sidebar item's group (from; null in 全部): every group but that one, 默认分组
  // only for a move. [[id, name]].
  const groupTargets = (D, from, how) =>
    [...(how === "move" ? [0] : []), SPECIAL, ...(D.groups || []).map((g) => g.id)].filter((id) => id !== from).map((id) => [id, groupName(id, D)]);
  // Row 3's 未打标签 / 已打标签 (f.tagState) and row 4's tags (f.tags, AND) on an UP's tag ids. skip leaves one out
  // ("tagged" or "tags"), for that group's own counts.
  const tagPass = (ids, f, skip = "") =>
    (skip === "tagged" || !f.tagState || (ids.length > 0) === (f.tagState === "tagged")) && (skip === "tags" || [...(f.tags || [])].every((id) => ids.includes(id)));

  // The UPs of a left-column item, before 更新状态 / search: the follow list without 已出分拣范围; that item is the
  // unfollowed (newest first), then the followed that are closed or cleared.
  function sideMids(D, rows, side) {
    const followed = (D.list?.list || []).filter((m) => rows.has(m));
    if (side === "out") return [...Object.keys(D.gone || {}).sort((a, b) => (D.gone[b].at || 0) - (D.gone[a].at || 0)), ...followed.filter((m) => outKind(rows.get(m)))];
    const list = followed.filter((m) => !outKind(rows.get(m)));
    if (groupId(side) != null) return list.filter((m) => inGroup(m, D, side));
    return list;
  }

  // Search as 收藏夹's: the words between spaces, each somewhere in the text, any case.
  const searchWords = (q) => String(q || "").toLowerCase().split(/\s+/).filter(Boolean);
  const hasWords = (text, words) => {
    const t = text.toLowerCase();
    return words.every((w) => t.includes(w));
  };

  // What the list shows: f = { side, q, sort, dir, kind (已出分拣范围's tab), source: "" | "bili" | "app" (已取消关注), and row 3: status,
  // tagState, recent (Set while 「AI 刚打的」 is on), recentAll (the whole batch, for its count); row 4: tags }.
  // Row 3's groups AND together and each counts with its own pick left out: counts[status], tagged / untagged, recent,
  // source[bili | app] (已取消关注's row 3 group), "" (row 3 cleared) and tags[id] (row 4's picks left out). Search and the
  // sidebar apply to all.
  function visibleUps(D, rows, f) {
    const words = searchWords(f.q);
    const base = sideMids(D, rows, f.side).filter((m) => {
      const u = rows.get(m);
      return hasWords(`${u.name}\n${u.sign}\n${u.zone}`, words) && (!f.kind || outKind(u) === f.kind);
    });
    const pass = (m, skip = "") => {
      const u = rows.get(m);
      return (skip === "status" || !f.status || u.status === f.status) && (skip === "source" || !f.source || u.gone?.source === f.source) && (skip === "recent" || !f.recent || f.recent.has(m)) && tagPass(u.tagIds, f, skip);
    };
    const counts = { "": base.filter((m) => tagPass(rows.get(m).tagIds, { tags: f.tags })).length, tagged: 0, untagged: 0, recent: 0, source: { bili: 0, app: 0 }, tags: {} };
    for (const m of base) {
      const u = rows.get(m);
      if (pass(m, "status")) counts[u.status] = (counts[u.status] || 0) + 1;
      if (pass(m, "tagged")) counts[u.tagIds.length ? "tagged" : "untagged"]++;
      if (pass(m, "recent") && f.recentAll?.has(m)) counts.recent++;
      if (pass(m, "source") && u.gone?.source in counts.source) counts.source[u.gone.source]++;
      if (pass(m, "tags")) for (const id of u.tagIds) counts.tags[id] = (counts.tags[id] || 0) + 1;
    }
    let list = base.filter((m) => pass(m));
    if (f.sort) {
      const cmp = sortCmp(f.sort, f.dir);
      list = [...list].sort((a, b) => cmp(rows.get(a), rows.get(b)));
    }
    return { list, counts };
  }

  // UP 主 sort: 最后投稿, 关注时间, 粉丝数, 名字; dir "desc" = big / new first. An UP with no value (never
  // posted or unknown, no follow time, 粉丝数未查) sinks to the bottom in both directions; ties keep the list order.
  const SORTS = { last: "最后投稿", follow: "关注时间", fans: "粉丝数", name: "名字" };
  // 已出分拣范围 sorts on its own, 离开时间 (when unfollowed; the still followed have none) first, as 收藏夹's.
  const OUT_SORTS = { left: "离开时间", ...SORTS };
  const SORT_DIR = { left: "desc", last: "desc", follow: "desc", fans: "desc", name: "asc" }; // each sort's default direction
  function sortCmp(sort, dir = SORT_DIR[sort] || "desc") {
    const val = { left: (u) => u.gone?.at || null, last: (u) => u.last || null, follow: (u) => u.followed || null, fans: (u) => u.fans ?? null, name: (u) => u.name }[sort] || ((u) => u.last || null);
    return UI.byValue(val, dir);
  }
  const dirLabel = (sort, dir) => UI.dirWords({ name: "name", fans: "count" }[sort], dir);

  // Adds a feed page to the loaded videos without repeats, newest first (B站 pages overlap and come slightly out of
  // order); ties keep their order. add = the videos that were new.
  function mergeFeed(items, page) {
    const seen = new Set(items.map((it) => it.bvid));
    const add = page.filter((it) => it?.bvid && !seen.has(it.bvid) && seen.add(it.bvid));
    return { items: [...items, ...add].sort((a, b) => (b.at || 0) - (a.at || 0)), add };
  }

  // 视频投稿's sort: 更新时间 is B站's order, newest first (the feed has no end, so no direction), or 随机.
  const FEED_SORTS = { time: "更新时间", random: "随机" };
  function shuffled(arr, rnd = Math.random) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
  // The loaded videos in the picked sort. 随机 keeps its order (bvids) and puts the videos not in it yet, shuffled among
  // themselves, at the bottom, so a new page never moves the cards shown; order null shuffles everything.
  function feedOrdered(items, sort, order, rnd = Math.random) {
    if (sort !== "random") return { items, order: null };
    const have = new Set(order || []);
    const next = [...(order || []), ...shuffled(items.map((it) => it.bvid).filter((b) => !have.has(b)), rnd)];
    const by = new Map(items.map((it) => [it.bvid, it]));
    return { items: next.map((b) => by.get(b)).filter(Boolean), order: next };
  }

  // Whether a feed video belongs to the picked left-column item.
  function feedMatch(it, D, side) {
    if (side === "all") return true;
    if (side === "out") return false;
    if (groupId(side) != null) return inGroup(it.mid, D, side);
    return true;
  }
  // A feed video under f = { side, q, tagState, tags } (rows 3 and 4 go by the video's UP); skip as in tagPass.
  const feedPass = (it, D, f, skip = "") => feedMatch(it, D, f.side) && hasWords(`${it.title}\n${it.name}`, searchWords(f.q)) && tagPass(liveTags(it.mid, D), f, skip);
  // Row 3's counts for 视频投稿, as visibleUps's: "" (row 3 cleared), tagged / untagged (by the UP), tags[id].
  function feedCounts(items, D, f) {
    const c = { "": 0, tagged: 0, untagged: 0, tags: {} };
    for (const it of items) {
      const ids = liveTags(it.mid, D);
      if (feedPass(it, D, { ...f, tagState: "" })) c[""]++;
      if (feedPass(it, D, f, "tagged")) c[ids.length ? "tagged" : "untagged"]++;
      if (feedPass(it, D, f, "tags")) for (const id of ids) c.tags[id] = (c.tags[id] || 0) + 1;
    }
    return c;
  }

  // The 视频投稿 list: what f lets through, plus keep (bvids): the cards showing when the tag picker opened stay until
  // it closes, so ticking a tag never pulls a card out from under it. feedLeaving = the kept cards that go on close.
  const feedList = (items, D, f, keep) => items.filter((it) => feedPass(it, D, f) || keep?.has(it.bvid));
  const feedLeaving = (items, D, f, keep) => items.filter((it) => keep?.has(it.bvid) && !feedPass(it, D, f));

  // The tag map after adding / removing tags on mids; an UP left with none drops out of the map.
  function withTags(map, mids, add, remove) {
    const out = { ...map };
    for (const m of mids) {
      const ids = [...new Set([...(out[m] || []).filter((id) => !remove.includes(id)), ...add])];
      if (ids.length) out[m] = ids;
      else delete out[m];
    }
    return out;
  }
  // J / K: the card after or before the current one; with none current (or it left the list) the first.
  function stepIn(list, cur, delta) {
    if (!list.length) return "";
    const i = list.indexOf(cur);
    return list[i < 0 ? 0 : Math.max(0, Math.min(list.length - 1, i + delta))];
  }
  // U: the UPs one change touched get their tags back, edits to other UPs since stay; tags deleted since stay gone.
  // UPs unfollowed since are left out (followed: the mids still followed): their tags went into the 已取消关注 record.
  const tagsOf = (map, mids) => Object.fromEntries(mids.map((m) => [m, [...(map[m] || [])]]));
  function restoreTags(map, before, live, followed) {
    const out = { ...map };
    for (const [mid, ids] of Object.entries(before)) {
      if (!followed.has(mid)) continue;
      const keep = ids.filter((id) => live.has(id));
      if (keep.length) out[mid] = keep;
      else delete out[mid];
    }
    return out;
  }


  // 关注's own AI 打标签 settings (chrome.storage.sync follow_ai_settings), clamped like the 分拣设置 fields.
  function normAi(s = {}) {
    const num = UI.numSetting;
    return { batchSize: num("aiBatch", s.batchSize), intervalSec: num("interval", s.intervalSec), newTagMax: num("newTagMax", s.newTagMax), allowRemove: s.allowRemove === true };
  }
  // The first use copies the 收藏夹 values (triage-settings-get, or the defaults); seed is what to store then. After that the
  // two are independent: a stored value always wins.
  function followAiSettings(own, triage) {
    if (own && typeof own === "object") return { value: normAi(own), seed: null };
    const t = triage || {};
    const value = normAi({ batchSize: t.triageAiBatchSize, intervalSec: t.triageIntervalSec, newTagMax: t.triageAiNewTagMax, allowRemove: t.triageAiRemoveTags });
    return { value, seed: value };
  }
  // The follow-ai-tag requests of one run: mids in batches of cfg.batchSize; maxNewTags is the run's cap (each batch gets
  // what is left of it), allowRemove the dialog's switch.
  function aiRequests(mids, cfg, instruction, tags, allowRemove) {
    const out = [];
    for (let i = 0; i < mids.length; i += cfg.batchSize) out.push({ type: "follow-ai-tag", instruction, mids: mids.slice(i, i + cfg.batchSize), tags, maxNewTags: cfg.newTagMax, allowRemove });
    return { batches: out, intervalMs: cfg.intervalSec * 1000 };
  }
  // Why the days cannot be saved, or "" (empty or invalid boxes fall back to the defaults, as everywhere).
  function settingsProblem(slow, dead) {
    return UI.numSetting("deadDays", dead) > UI.numSetting("slowDays", slow) ? "" : "断更的天数要比慢更的天数大";
  }
  // 断更 is at least a day more than 慢更.
  function normDays(slow, dead) {
    const followSlowDays = UI.numSetting("slowDays", slow);
    return { followSlowDays, followDeadDays: Math.max(followSlowDays + 1, UI.numSetting("deadDays", dead)) };
  }

  // A 刷新 finished between two follow_jobs: the 视频投稿 already loaded is older than what it read.
  const syncFinished = (was, now) => Boolean(now?.finishedAt && now.finishedAt !== was?.finishedAt);

  // What 关注 remembers across reloads (follow_view): mode, tab, both tabs' sorts and the sidebar item.
  // 已出分拣范围 is not remembered, as 收藏夹's: a reload opens 全部.
  const viewRecord = (F) => ({ mode: F.mode, tab: F.tab, sort: F.sort, dir: F.dir, fsort: F.fsort, side: F.side === "out" ? "all" : F.side });
  // O / Enter on an UP card: its newest video that can play here (one with a bvid), or "".
  const latestBvid = (u) => u?.titles.find((v) => v.bvid)?.bvid || "";
  // Why ✦ AI 打标签 cannot run here (it tags UP 主 that are followed), or "".
  const aiBlocked = (tab, side) => (tab === "feed" ? "AI 打标签只用于 UP 主，请在「UP 主」页签使用" : side === "out" ? "已出分拣范围的 UP 主不打标签" : "");
  // The AI dialog's 「允许 AI 去掉已有标签」, stored with the rest of follow_ai_settings.
  const withAllowRemove = (settings, on) => normAi({ ...settings, allowRemove: on });
  // The 收藏夹 player's UP ({ mid, name }) among 关注's rows: by mid; items saved before mids were stored match by name
  // until the folder's next refresh. "" for an UP never followed.
  function favUpMid(up, rows) {
    if (!up) return "";
    if (up.mid) return rows.has(up.mid) ? up.mid : "";
    return (up.name && [...rows.values()].find((u) => u.name === up.name)?.mid) || "";
  }
  // The UP of a video 关注 plays: from 视频投稿 (feed items), else an UP card's recent titles; "" when neither lists it.
  const playingMid = (bvid, feed, rows) => feed?.find((x) => x.bvid === bvid)?.mid || [...rows.values()].find((u) => u.titles.some((v) => v.bvid === bvid))?.mid || "";
  // The 更新状态 刷新 fills in: the UP 主 of all of 关注 (刷新 checks them all, whatever is searched or filtered) whose last
  // post is not known yet.
  function unknownLast(D, rows) {
    const c = { unchecked: 0, stale: 0 };
    for (const m of sideMids(D, rows, "all")) if (rows.get(m).status in c) c[rows.get(m).status]++;
    return c;
  }
  // The UP 主 among mids whose videos were not read yet (an UP read with none, 没投过稿, was), for AI 打标签's scope line.
  const aiBare = (mids, rows) => mids.filter((m) => ["unchecked", "stale"].includes(rows.get(m)?.status)).length;
  // As 收藏夹's aiRoomHint: what the AI may use and make this run, by the tags it may use (not switched off) and room.
  const aiRoomHint = (tags, excluded, room) => UI.aiRoomHint({ tags, excluded, room, full: "新建上限是 0" });
  // The 「已刷新」 pill (shared.js setSync) for a refresh's changes (followDiff) and posted (UP 回归); null hides it.
  // A partial read (c.partial) says so in amber, as 收藏夹's: no 取消关注 count, the UP 主 not read are not taken as gone.
  function syncView(c, posted, names) {
    const part = c.partial;
    if (!part && !c.added.length && !c.removed.length && !posted.length) return null;
    return {
      label: [`已刷新${part ? "（部分）" : ""} +${c.added.length}${part ? "" : ` −${c.removed.length}`}`, posted.length && `UP 回归 +${posted.length}`].filter(Boolean).join(" · "),
      text: [`${part ? `只读到 ${part.read}/${part.total} 个关注，没读到的不算取消关注，可稍后再刷新。` : ""}刷新结果：新关注 ${c.added.length}${part ? "" : ` · ${SOURCE.bili} ${c.removed.length}`}`, posted.length && `UP 回归 ${posted.length}`].filter(Boolean).join(" · "),
      warn: Boolean(part),
      sections: [["新关注", names(c.added)], [SOURCE.bili, names(c.removed)], ...(posted.length ? [["UP 回归：原本投稿已清空、现在又能看到视频", names(posted)]] : [])]
    };
  }

  globalThis.FollowCore = { DAY, ALL, STATUS, lastPostOf, followStatus, withFeedInProgress, recentTitles, liveTags, upRow, SPECIAL, groupId, groupsOf, inGroupId, inGroup, groupName, groupNames, groupMembers, sideIds, SOURCE, OUT_KINDS, outKind, groupMoveLabel, regrouped, groupCalls, groupTargets, tagPass, sideMids, searchWords, hasWords, visibleUps, SORTS, OUT_SORTS, SORT_DIR, sortCmp, dirLabel, mergeFeed, FEED_SORTS, shuffled, feedOrdered, feedMatch, feedPass, feedCounts, feedList, feedLeaving, withTags, stepIn, tagsOf, restoreTags, normAi, followAiSettings, aiRequests, settingsProblem, normDays, syncFinished, viewRecord, latestBvid, aiBlocked, withAllowRemove, favUpMid, playingMid, unknownLast, aiBare, aiRoomHint, syncView };
})();
