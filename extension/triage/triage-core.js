// 收藏夹's pure functions (fav-*.js are the page): the stored records' shapes (已出分拣范围, 所有收藏夹, the cached
// lists) and the 摘录 export helpers. They compute only from their arguments: no DOM, chrome.*, page state or
// timers. triage.html loads this before fav-*.js; triage.selftest.js loads it from there.
(() => {
  // A listed video counts as favorited again after our 取消收藏 only when Bilibili's favorite time (seconds) is not older
  // than it: a list fetched before the 取消收藏, or lagging behind it, still holds the video with its old time. No favTime
  // keeps the 取消收藏.
  const refavorited = (it, dec) => (it.favTime || 0) * 1000 >= dec.at;

  // 所有收藏夹 (pure): lists = [{ id, items, decisions }] in folder order. A video in several folders appears once with
  // every folder id in .folders. A folder the video was unfavorited from no longer counts unless it was favorited there
  // again since; a video left in no folder is dropped.
  function mergeFolderItems(lists) {
    const map = new Map();
    for (const { id, items, decisions: d = {} } of lists) {
      for (const it of items) {
        const dec = d[it.bvid];
        if (dec?.action === "unfav" && !refavorited(it, dec)) continue;
        const m = map.get(it.bvid);
        // One list marking an episode 番剧 (a 稍后再看 snapshot from before it did may not) marks it for every write.
        if (m) {
          m.folders.push(id);
          if (it.ogv) m.ogv = true;
        } else map.set(it.bvid, { ...it, folders: [id] });
      }
    }
    return [...map.values()];
  }

  // 已出分拣范围 (pure): a folder's full new list replaces its old one. A video that left it and is in no other folder's
  // list is recorded with its last known item and where it had been (its trail, then this folder); a video listed again
  // is dropped from the record and this folder from its trail. One that left but is still in another chosen folder only
  // gets this folder on its trail. One still in the folder's id list (ids) only stopped being listed: Bilibili hides a
  // video that became invalid, so it is marked hidden.
  function updateRemoved(removed, left, oldItems, newItems, otherBvids, at, ids, folder) {
    const next = { ...removed };
    const trail = { ...left };
    const now = new Set(newItems.map((it) => it.bvid));
    const stillThere = new Set(ids || []);
    for (const b of now) {
      delete next[b];
      forgetLeft(trail, b, folder.id);
    }
    for (const it of oldItems) {
      const b = it.bvid;
      if (now.has(b) || next[b]) continue;
      if (otherBvids.has(b)) {
        noteLeft(trail, b, folder, at);
        continue;
      }
      next[b] = { item: it, at, from: originOf(trail, b, folder, at) };
      if (stillThere.has(b)) next[b].hidden = true;
      delete trail[b];
    }
    // A hidden one this folder recorded that has left its id list too is plainly gone now (ids null: not read, no news).
    for (const [b, r] of Object.entries(next)) {
      if (ids && r.hidden && r.from?.at(-1)?.id === folder.id && !stillThere.has(b)) {
        const { hidden: _, ...rest } = r;
        next[b] = rest;
      }
    }
    return { removed: next, left: trail };
  }
  // 移动 to a folder outside triage (pure): like updateRemoved for the moved videos, with where they went. From 已出分拣范围
  // itself (from null) the record keeps the origin it had.
  function moveToRemoved(removed, left, items, otherBvids, from, at, movedTo) {
    const next = { ...removed };
    const trail = { ...left };
    for (const it of items) {
      if (otherBvids.has(it.bvid)) continue;
      next[it.bvid] = { item: it, at, movedTo, from: from ? originOf(trail, it.bvid, from, at) : removed[it.bvid]?.from };
      delete trail[it.bvid];
    }
    return { removed: next, left: trail };
  }
  // The folders a video left before (its trail), then the one it leaves now.
  function originOf(left, bvid, folder, at) {
    const before = Object.entries(left[bvid] || {}).filter(([id]) => id !== folder.id).map(([id, e]) => ({ id, title: e.title, at: e.at }));
    return [...before, { id: folder.id, title: folder.title, at }];
  }
  // Records from before `from` existed: a 取消收藏 done here in folder X is a fact that the video was in X (pure).
  function inferFrom(decisionsByFolder, bvid, titleOf) {
    const ids = Object.entries(decisionsByFolder).filter(([, d]) => d?.[bvid]?.action === "unfav").map(([id]) => id);
    return ids.length ? ids.map((id) => ({ id, title: titleOf(id) })) : undefined;
  }
  // Left this folder but is still in another chosen one: the folder goes on its trail (mutates trail).
  function noteLeft(trail, bvid, folder, at) {
    trail[bvid] = { ...trail[bvid], [folder.id]: { title: folder.title, at } };
  }
  // Listed in this folder again: it never left it (mutates trail).
  function forgetLeft(trail, bvid, folderId) {
    if (!trail[bvid]?.[folderId]) return;
    const { [folderId]: _, ...rest } = trail[bvid];
    if (Object.keys(rest).length) trail[bvid] = rest;
    else delete trail[bvid];
  }

  // A video that turns invalid comes back as Bilibili's placeholder; keep what was known about it before (pure).
  function keepInvalidInfo(items, oldItems) {
    const old = new Map((oldItems || []).map((it) => [it.bvid, it]));
    return items.map((it) => {
      const o = it.invalid && old.get(it.bvid);
      return o ? { ...it, title: o.title || it.title, cover: o.cover || it.cover, upper: o.upper || it.upper, upperMid: o.upperMid || it.upperMid, intro: o.intro || it.intro, duration: o.duration || it.duration } : it;
    });
  }

  // 所有收藏夹 (pure): a cached list is stale when the folder's current video ids differ from it as a set.
  function idsChanged(cached, ids) {
    const have = new Set(cached);
    const now = new Set(ids);
    return have.size !== now.size || [...now].some((b) => !have.has(b));
  }
  // 切换收藏夹 (pure): the fetched newest pages, then the cached rest still in the folder's id list. null when an added id
  // is in neither (moved in from deep in the list), so the caller loads the whole folder.
  function mergeHead(head, cachedItems, oldIds, ids) {
    const now = new Set(ids);
    const inHead = new Set(head.map((it) => it.bvid));
    const items = [...head, ...cachedItems.filter((it) => now.has(it.bvid) && !inHead.has(it.bvid))];
    const got = new Set(items.map((it) => it.bvid));
    const old = new Set(oldIds);
    return ids.every((b) => old.has(b) || got.has(b)) ? items : null;
  }
  // bvid → { item, from } for the videos MoonDigest already holds (pure): the other chosen folders' cached lists
  // ([[folderId, items]], from: its id), then 已出分拣范围's records (from: removedFrom).
  function heldItems(lists, removed, removedFrom) {
    const local = new Map();
    for (const [id, items] of lists) for (const item of items || []) if (!local.has(item.bvid)) local.set(item.bvid, { item, from: id });
    for (const [bvid, rec] of Object.entries(removed || {})) if (!local.has(bvid)) local.set(bvid, { item: rec.item, from: removedFrom });
    return local;
  }
  // Changed ids without the full load, for the 分拣台 page and the Agent's sync (agent-sync.js): removed videos leave the
  // cached list (snap), added ones come from local (heldItems) when MoonDigest already holds them, and only truly new
  // ones are read from the newest part of the list: readHead(known) answers like the triage-folder-items message with
  // known, { ok, data: { items, head?, info } } or a failure. That answer is returned as it is when it is not a head
  // (a failure, or the whole folder read); null when an added id is found nowhere (a new favorite deep in the list), so
  // the caller loads the whole folder.
  async function cachedRead(snap, ids, local, readHead) {
    const old = snap.ids || snap.bvids;
    const oldSet = new Set(old);
    const added = ids.filter((b) => !oldSet.has(b));
    const moved = added.filter((b) => local.has(b)).map((b) => local.get(b).item);
    let head = [];
    let info = { intro: snap.intro };
    if (moved.length < added.length) {
      const r = await readHead([...snap.bvids, ...moved.map((it) => it.bvid)]);
      if (!r.ok || !r.data.head) return r;
      head = r.data.items;
      info = r.data.info || info;
    }
    const items = mergeHead(head, [...moved, ...snap.items], old, ids);
    return items && { ok: true, data: { items, ids, info } };
  }
  // A 取消收藏's elsewhere (pure): still in a chosen folder other than its own. lists = { folderId: bvids, or null while
  // the folder has no full list cached }, the chosen folders but 稍后再看; byFolder = { folderId: decisions }. Returns
  // { folderId: { bvid: record } } of the records whose elsewhere changes. A video in no known list stays as recorded
  // while some other folder's list is unknown: only full lists prove it left.
  function refreshElsewhere(byFolder, lists) {
    const sets = Object.entries(lists).map(([id, bvids]) => [id, bvids && new Set(bvids)]);
    const out = {};
    for (const [f, d] of Object.entries(byFolder)) {
      for (const [b, rec] of Object.entries(d || {})) {
        if (rec?.action !== "unfav") continue;
        const others = sets.filter(([id]) => id !== f);
        const now = others.some(([, s]) => s?.has(b)) ? true : others.every(([, s]) => s) ? false : Boolean(rec.elsewhere);
        if (now === Boolean(rec.elsewhere)) continue;
        const next = { ...rec, elsewhere: true };
        if (!now) delete next.elsewhere;
        (out[f] ||= {})[b] = next;
      }
    }
    return out;
  }
  const unfavOnly = (d) => Object.fromEntries(Object.entries(d).filter(([, v]) => v?.action === "unfav"));

  function mdLinkText(s) {
    return String(s).replace(/[[\]\\]/g, "\\$&");
  }

  const oneLine = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
  // A relative link inside the zip; <> keeps spaces in the filename (note filenames never hold < or >).
  const mdLink = (path, title) => `[${oneLine(title).replace(/[[\]\\]/g, "\\$&") || path}](<${path}>)`;
  // | [ ] or a newline in the alias would end the link early; the path is already a safe note filename.
  function wikiLink(path, title) {
    const target = String(path).replace(/\.md$/, "");
    return `[[${target}|${oneLine(String(title ?? "").replace(/[|[\]]/g, " ")) || target}]]`;
  }

  // 分区 (pure): B站's top-level zone of an old sub-zone number (tid, from resource/infos; triage-bg.js triage-zones), ""
  // for none or one not here. The old numbers are frozen, so the table is static: from app.bilibili.com/x/v2/region/index.
  const ZONE_TIDS = {
    动画: [1, 24, 25, 27, 47, 86, 210, 253, 257],
    音乐: [3, 28, 29, 30, 31, 59, 130, 193, 243, 244, 265, 266, 267],
    游戏: [4, 17, 19, 65, 121, 136, 171, 172, 173],
    娱乐: [5, 71, 137, 241, 242, 262, 263, 264],
    电视剧: [11, 185, 187],
    番剧: [13, 32, 33, 51, 152],
    舞蹈: [20, 129, 154, 156, 198, 199, 200, 255],
    生活: [21, 138, 160, 161, 162, 239, 250, 251, 254],
    鬼畜: [22, 26, 119, 126, 127, 216],
    电影: [23, 83, 145, 146, 147],
    知识: [36, 122, 124, 201, 207, 208, 209, 228, 229],
    纪录片: [37, 177, 178, 179, 180],
    动物圈: [75, 217, 218, 219, 220, 221, 222],
    美食: [76, 211, 212, 213, 214, 215],
    剧情: [85],
    科技: [95, 188, 230, 231, 232, 233],
    国创: [153, 167, 169, 170, 195],
    时尚: [155, 157, 158, 159, 252],
    运动: [164, 234, 235, 236, 237, 238, 249],
    国创相关: [168],
    汽车: [176, 223, 227, 240, 245, 246, 247, 248, 258],
    影视: [181, 182, 183, 184, 256, 259, 260, 261],
    资讯: [202, 203, 204, 205, 206]
  };
  const ZONES = new Map(Object.entries(ZONE_TIDS).flatMap(([name, tids]) => tids.map((tid) => [tid, name])));
  const zoneName = (tid) => ZONES.get(Number(tid)) || "";

  globalThis.TriageCore = { refavorited, mergeFolderItems, updateRemoved, moveToRemoved, inferFrom, forgetLeft, noteLeft, keepInvalidInfo, idsChanged, mergeHead, heldItems, cachedRead, refreshElsewhere, unfavOnly, mdLinkText, oneLine, mdLink, wikiLink, zoneName };
})();
