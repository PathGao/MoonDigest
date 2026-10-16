// 收藏夹's pure functions (triage.js is the page): the stored records' shapes (已出分拣范围, 所有收藏夹, the cached
// lists) and the 摘录 / zip export helpers. They compute only from their arguments: no DOM, chrome.*, page state or
// timers. triage.html loads this before triage.js; triage.selftest.js loads it from there.
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
        if (m) m.folders.push(id);
        else map.set(it.bvid, { ...it, folders: [id] });
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

  const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
    for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
    return n >>> 0;
  });
  function crc32(bytes) {
    let c = ~0;
    for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
    return ~c >>> 0;
  }

  // files: [{ name, text }] → zip bytes. Stored (no compression); flag bit 11 marks the names as UTF-8.
  // "Made by" Unix with mode 0644: made by DOS, Info-ZIP unzip (macOS's) reads the names as a DOS code page and mangles them.
  function zipStored(files, now = new Date()) {
    const enc = new TextEncoder();
    const entries = files.map((f) => ({ name: enc.encode(f.name), data: enc.encode(f.text) }));
    const localSize = entries.reduce((n, e) => n + 30 + e.name.length + e.data.length, 0);
    const centralSize = entries.reduce((n, e) => n + 46 + e.name.length, 0);
    const out = new Uint8Array(localSize + centralSize + 22);
    const view = new DataView(out.buffer);
    const put = (at, fields) => fields.reduce((p, [size, value]) => (size === 2 ? view.setUint16(p, value, true) : view.setUint32(p, value, true), p + size), at);
    const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    let local = 0;
    let central = localSize;
    for (const e of entries) {
      const common = [[2, 20], [2, 0x0800], [2, 0], [2, time], [2, date], [4, crc32(e.data)], [4, e.data.length], [4, e.data.length], [2, e.name.length], [2, 0]];
      out.set(e.name, put(local, [[4, 0x04034b50], ...common]));
      out.set(e.data, local + 30 + e.name.length);
      out.set(e.name, put(central, [[4, 0x02014b50], [2, 0x0314], ...common, [2, 0], [2, 0], [2, 0], [4, 0x81a40000], [4, local]]));
      local += 30 + e.name.length + e.data.length;
      central += 46 + e.name.length;
    }
    put(central, [[4, 0x06054b50], [2, 0], [2, 0], [2, entries.length], [2, entries.length], [4, centralSize], [4, localSize], [2, 0]]);
    return out;
  }

  globalThis.TriageCore = { refavorited, mergeFolderItems, updateRemoved, moveToRemoved, inferFrom, forgetLeft, noteLeft, keepInvalidInfo, idsChanged, mergeHead, unfavOnly, mdLinkText, oneLine, mdLink, wikiLink, zipStored };
})();
