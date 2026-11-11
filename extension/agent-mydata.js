// MoonDigest's agent interface, docs/AGENT.md §2: the user's own Bilibili data (favorites, 稍后再看, follows, watch
// history) for the MCP server, read only. Only GETs, through triage-bg.js's B站 channel (triageBiliGet), one call at a
// time, one page per call (稍后再看 and the 分拣台's local copies are read whole, then paged).
// The worker loads it after triage-bg.js and follow-core.js, whose helpers it uses.
(() => {
  const K = MdgLimits.KEYS;
  const API = "https://api.bilibili.com";
  const FAV_PAGE = TriageUi.FAV_PAGE_SIZE; // 40: B站's own favorites page; local lists page the same
  const FOLLOW_PAGE = 50;
  const HISTORY_PAGE = 30;
  const MAX_PAGE = 1000;

  const fail = (message, code) => Object.assign(new Error(message), code ? { code } : {});
  const pageOf = (page) => (Number.isInteger(page) && page >= 1 ? Math.min(page, MAX_PAGE) : 1);
  const slice = (list, page, size) => ({ total: list.length, page, hasMore: page * size < list.length, items: list.slice((page - 1) * size, page * size) });
  // Every word of the query in one of the fields (case-insensitive).
  const matches = (query, fields) => {
    const hay = fields.filter(Boolean).join("\n").toLowerCase();
    return String(query).toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
  };

  // The 分拣台's data on each video: tags (and 摘读记录's), 备注, the AI verdict and one-line summary, 保留.
  async function withTriage(items, staged = false) {
    const bvids = items.map((it) => it.bvid);
    const keys = [K.triageNotes, K.triageTags, K.triageVideoTags, K.readingMarks, K.triageKept, K.triageZones, ...bvids.flatMap((b) => [K.triageAnalysis(b), K.triageTitle(b)])];
    const got = await chrome.storage.local.get(keys);
    return items.map((it) => {
      const x = MdgNote.triageExtras(got, { site: "bilibili", videoId: it.bvid });
      const v = MdgTagCore.verdictOf({ title: got[K.triageTitle(it.bvid)], analysis: x.analysis, invalid: it.invalid });
      const summary = x.analysis?.status === "done" ? String(x.analysis.oneLiner || "") : "";
      return {
        bvid: it.bvid,
        url: TriageUi.videoUrl(it.bvid),
        title: it.title || "",
        author: it.upper || "",
        duration: Number(it.duration) || 0,
        favTime: Number(it.favTime) || 0,
        ...(it.invalid && { invalid: true }),
        ...(it.seen != null && it.seen !== 0 && { progress: it.seen }),
        ...(x.userTags.length && { tags: x.userTags }),
        ...(x.note && { note: x.note }),
        ...(v.verdict !== "none" && { verdict: v.verdict }),
        // B站's 分区, where the 分拣台 has read it: coarse, but a hint for sorting.
        ...(staged && { stage: v.stage === 2 ? "fine" : v.stage === 1 ? "coarse" : "none", ...(TriageCore.zoneName(got[K.triageZones]?.[it.bvid]) && { zone: TriageCore.zoneName(got[K.triageZones][it.bvid]) }) }),
        ...(summary && { summary }),
        ...(got[K.triageKept]?.[it.bvid] && { kept: true })
      };
    });
  }

  const ALL_PAGE = 300; // all: one line a video, so a page still fits an AI tool's result
  // The chosen folders' cached lists as one list, a video once with every folder it is in (the 分拣台's 所有收藏夹): what
  // was 取消收藏 since the list was read is left out.
  async function allItems(only) {
    const chosen = ((await chrome.storage.local.get(K.triageIncludedFolders))[K.triageIncludedFolders] || []).map(String).filter((id) => !only || id === only);
    const got = await chrome.storage.local.get(chosen.flatMap((id) => [K.triageSnapshot(id), K.triageDecisions(id)]));
    const lists = chosen.filter((id) => got[K.triageSnapshot(id)]).map((id) => ({ id, items: got[K.triageSnapshot(id)].items || [], decisions: got[K.triageDecisions(id)] }));
    return { items: TriageCore.mergeFolderItems(lists), unsynced: chosen.filter((id) => !got[K.triageSnapshot(id)]) };
  }

  // No folderId: the folders, 稍后再看 first (id "toview"). A folder the 分拣台 has (ticked, so a local copy) and
  // 稍后再看 (one request for all of it) are searched by query on every field; another folder is read a page at a time
  // from B站, which searches its own titles. all: the local copies only, every chosen folder as one compact list (or
  // the one named), filtered by verdict, stage, tag and invalid, without a B站 request.
  async function favorites({ folderId, page, query, all, verdict, stage, tag, invalid }) {
    const pn = pageOf(page);
    const q = typeof query === "string" ? query.trim() : "";
    if (all === true) {
      if (folderId != null && !triageFolderId(String(folderId))) throw fail("folderId must be a folder id from the folder list, or toview.", "BAD_PARAMS");
      for (const [name, v, ok] of [["verdict", verdict, ["none", "keep", "drop", "unsure"]], ["stage", stage, ["none", "coarse", "fine"]]]) {
        if (v != null && !ok.includes(v)) throw fail(`${name} must be one of ${ok.join(", ")}.`, "BAD_PARAMS");
      }
      const { items, unsynced } = await allItems(folderId == null ? null : String(folderId));
      const rows = (await withTriage(items, true)).map((r, i) => ({ ...r, folders: items[i].folders }));
      const hit = rows.filter((r) =>
        (verdict == null || (r.verdict || "none") === verdict)
        && (stage == null || r.stage === stage)
        && (tag == null || (r.tags || []).includes(String(tag)))
        && (invalid == null || Boolean(r.invalid) === Boolean(invalid))
        && (!q || matches(q, [r.title, r.author, r.note, r.summary, ...(r.tags || [])])));
      return { all: true, source: "local", ...(unsynced.length && { unsynced }), ...slice(hit, pn, ALL_PAGE) };
    }
    if (folderId == null || folderId === "") {
      const { folders } = await triageCreatedFolders();
      const got = await chrome.storage.local.get([K.triageIncludedFolders, ...folders.map((f) => K.triageSnapshot(f.id))]);
      const ticked = new Set((got[K.triageIncludedFolders] || []).map(String));
      return {
        folders: folders.map((f) => {
          const snap = got[K.triageSnapshot(f.id)];
          return { id: String(f.id), title: f.title || "", count: Number(f.count) || 0, ...(f.private && { private: true }), ...(ticked.has(String(f.id)) && { included: true, ...(snap && { synced: snap.bvids?.length || 0 }) }) };
        })
      };
    }
    const id = String(folderId);
    if (!triageFolderId(id)) throw fail("folderId must be a folder id from the folder list, or toview.", "BAD_PARAMS");
    let list = null;
    let source = "local";
    if (id === TRIAGE_TOVIEW) {
      list = (await triageToviewList()).map(triageToviewItem);
      source = "bilibili";
    } else {
      const got = await chrome.storage.local.get([K.triageIncludedFolders, K.triageSnapshot(id), K.triageDecisions(id)]);
      const ticked = (got[K.triageIncludedFolders] || []).some((f) => String(f) === id);
      // Without what was 取消收藏 since the list was read (the list keeps those until its next read).
      const snap = ticked && got[K.triageSnapshot(id)];
      list = snap ? TriageCore.mergeFolderItems([{ id, items: snap.items || [], decisions: got[K.triageDecisions(id)] }]).map(({ folders, ...it }) => it) : null;
    }
    if (list) {
      if (!q) {
        const one = slice(list, pn, FAV_PAGE);
        return { folderId: id, source, ...one, items: await withTriage(one.items) };
      }
      const rows = await withTriage(list);
      const hit = rows.filter((r) => matches(q, [r.title, r.author, r.note, r.summary, ...(r.tags || [])]));
      return { folderId: id, source, ...slice(hit, pn, FAV_PAGE) };
    }
    const kw = q ? `&keyword=${encodeURIComponent(q)}&order=mtime&type=0` : "";
    const data = await triageBiliGet(`${API}/x/v3/fav/resource/list?media_id=${id}&ps=${FAV_PAGE}&pn=${pn}&platform=web${kw}`);
    const items = await withTriage((data?.medias || []).map(triageFavItem).filter(Boolean));
    // With a keyword, media_count is still the whole folder's, not the hits: leave total out.
    return { folderId: id, source: "bilibili", ...(!q && { total: Number(data?.info?.media_count) || 0 }), page: pn, hasMore: Boolean(data?.has_more), items };
  }

  const upRow = (mid, person, D) => ({
    mid: String(mid),
    name: person?.name || "",
    sign: person?.sign || "",
    groups: FollowCore.groupNames(FollowCore.groupsOf(String(mid), D), D)
  });

  // The 关注 the 分拣台 synced (with UP 标签; query searches name, sign, groups and tags), else B站's list a page at a time.
  async function follows({ page, query }) {
    const pn = pageOf(page);
    const q = typeof query === "string" ? query.trim() : "";
    const D = await MdgLimits.followGet(["list", "people", "groups", "tags", "tag_map"]);
    if (D.list?.list?.length && !D.list.partial) {
      const names = new Map((D.tags || []).map((t) => [t.id, t.name]));
      const rows = D.list.list.map((mid) => {
        const tags = FollowCore.liveTags(mid, { map: D.tag_map, tags: D.tags || [] }).map((t) => names.get(t)).filter(Boolean);
        return { ...upRow(mid, D.people?.[mid], D), ...(tags.length && { tags }) };
      });
      const hit = q ? rows.filter((r) => matches(q, [r.name, r.sign, ...r.groups, ...(r.tags || [])])) : rows;
      return { source: "local", ...slice(hit, pn, FOLLOW_PAGE) };
    }
    const mid = await triageMid();
    const data = await triageBiliGet(`${API}/x/relation/followings?vmid=${mid}&pn=${pn}&ps=${FOLLOW_PAGE}&order=desc`);
    const tags = await triageBiliGet(`${API}/x/relation/tags`);
    const list = data?.list || [];
    const B = {
      list: {
        special: Object.fromEntries(list.filter((x) => x.special === 1 || (x.tag || []).includes(TriageUi.FOLLOW_SPECIAL)).map((x) => [String(x.mid), 1])),
        groups: Object.fromEntries(list.map((x) => [String(x.mid), (x.tag || []).filter((t) => t > 0)]))
      },
      groups: (Array.isArray(tags) ? tags : []).filter((g) => g.tagid > 0).map((g) => ({ id: g.tagid, name: String(g.name || "") }))
    };
    const total = Number(data?.total) || 0;
    return {
      source: "bilibili",
      ...(q && { queryIgnored: true }),
      total,
      page: pn,
      hasMore: pn * FOLLOW_PAGE < total,
      items: list.map((x) => upRow(x.mid, { name: x.uname, sign: String(x.sign || "").slice(0, 60) }, B))
    };
  }

  // B站's watch history, newest first, HISTORY_PAGE a page; cursor is the previous page's, "" at the end.
  async function history({ cursor }) {
    let at = "";
    if (cursor) {
      const m = /^(\d+):(\d+):([a-z-]*)$/.exec(String(cursor));
      if (!m) throw fail("cursor must be the cursor a previous get_history returned.", "BAD_PARAMS");
      at = `&max=${m[1]}&view_at=${m[2]}&business=${m[3]}`;
    }
    const data = await triageBiliGet(`${API}/x/web-interface/history/cursor?ps=${HISTORY_PAGE}${at}`);
    const list = data?.list || [];
    const c = data?.cursor;
    return {
      items: list.map((it) => {
        const bvid = it.history?.business === "archive" ? it.history.bvid || "" : "";
        return {
          ...(bvid && { bvid }),
          url: bvid ? TriageUi.videoUrl(bvid) : String(it.uri || ""),
          title: [it.title, it.show_title].filter(Boolean).join(" "),
          author: it.author_name || "",
          viewAt: Number(it.view_at) || 0,
          progress: Number(it.progress) || 0,
          duration: Number(it.duration) || 0,
          kind: it.history?.business || ""
        };
      }),
      cursor: list.length && c?.max ? `${c.max}:${c.view_at}:${c.business || ""}` : ""
    };
  }

  const METHODS = { favorites, follows, history };
  // One call at a time, GAP_MS apart: B站 rate-limits bursts. deadline: as agent-bridge.js handle.
  const GAP_MS = 1000;
  let queue = Promise.resolve();
  let lastAt = 0;
  function run(fn, params, deadline) {
    const call = queue.then(async () => {
      const wait = lastAt + GAP_MS - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      if (Date.now() > deadline) throw fail("The call waited too long behind earlier ones.", "TIMEOUT");
      try {
        return await fn(params && typeof params === "object" ? params : {});
      } finally {
        lastAt = Date.now();
      }
    });
    queue = call.catch(() => {});
    return call.then(
      (data) => ({ ok: true, data }),
      (e) => ({ ok: false, error: String(e?.message || e), ...(e?.code ? { code: String(e.code) } : {}) })
    );
  }

  MdgAgentBridge.addMethods(Object.fromEntries(Object.entries(METHODS).map(([name, fn]) => [name, (params, deadline) => run(fn, params, deadline)])));
})();
