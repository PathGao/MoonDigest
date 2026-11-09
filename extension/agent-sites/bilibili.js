// Bilibili for the agent interface (docs/AGENT.md §5). The content script (agent-page.js) reads its pages; its search
// stays in agent-search.js with YouTube's, which share the text helpers. 稍后再看 goes through the 分拣台's own requests
// (triage/triage-bg.js, loaded later in the service worker: looked up when called): its cookies, pacing and risk codes.
(() => {
  const PAGE = 20;
  const BVID = /^BV[0-9A-Za-z]{10}$/;
  const fail = (message) => Object.assign(new Error(message), { code: "BAD_PARAMS" });
  const toview = async () => (await triageToviewList()).map(triageToviewItem);
  const bvidOf = (item) => {
    if (!BVID.test(item)) throw fail(`${item} is not a BV id.`);
    return item;
  };

  // The whole list is one request; the agent gets it PAGE at a time, the cursor being the offset.
  async function list({ cursor }) {
    if (cursor && !/^\d+$/.test(cursor)) throw fail("cursor must be the cursor a previous list_collection returned.");
    const all = await toview();
    const from = Number(cursor || 0);
    const items = all.slice(from, from + PAGE).map((v) => ({
      videoId: v.bvid, url: `https://www.bilibili.com/video/${v.bvid}`, title: v.title, author: v.upper, duration: v.duration || 0,
      ...(v.invalid && { unavailable: true })
    }));
    return { items, cursor: from + PAGE < all.length ? String(from + PAGE) : "" };
  }

  const has = async ({ item }) => (await toview()).some((v) => v.bvid === bvidOf(item));

  // 稍后再看 takes the aid: from the list for a removal, from the video's own page data for an add.
  async function write({ op, item }) {
    const bvid = bvidOf(item);
    const aid = op === "remove"
      ? (await toview()).find((v) => v.bvid === bvid)?.aid
      : (await triageBiliGet(`${TRIAGE_BILI_API}/x/web-interface/view?bvid=${bvid}`))?.aid;
    if (!aid) throw fail(`${bvid} was not found on Bilibili.`);
    await triageBiliPost(`/x/v2/history/toview/${op === "add" ? "add" : "del"}`, { aid });
  }

  MdgAgentSites.register({
    id: "bilibili",
    origins: ["*://*.bilibili.com/*"],
    key(u) {
      if (u.hostname.replace(/^www\./, "") !== "bilibili.com") return null;
      const q = u.searchParams;
      let m = /^\/video\/((?:BV|bv)[0-9A-Za-z]+|av\d+)\/?$/.exec(u.pathname);
      if (m) return `${m[1]}:${q.get("p") || "1"}`;
      m = /^\/bangumi\/play\/((?:ep|ss)\d+)\/?$/.exec(u.pathname);
      if (m) return `${m[1]}:`;
      // These pages play q.bvid; without it the page itself is the only identity.
      if (/^\/(list|festival)\/[^/]+/.test(u.pathname)) return `${q.get("bvid") || u.pathname}:${q.get("p") || "1"}`;
      return null;
    },
    // m.bilibili.com and bilibili.com: the same path on www, where the content script runs. b23.tv short links are not
    // followed (the id is behind a redirect).
    canonical: (u) => (/^(m\.)?bilibili\.com$/.test(u.hostname) ? `https://www.bilibili.com${u.pathname}${u.search}` : null),
    read: "content",
    search: (query, page) => MdgAgentSearch.searchBili(query, page),
    // Favorites, follows and history stay in agent-mydata.js (get_favorites…); here only what the agent may change.
    collections: { watch_later: ["add", "remove"] },
    list,
    has,
    write
  });
})();
