// Bilibili for the agent interface (docs/AGENT.md §5). The content script (agent-page.js) reads its pages; its search
// stays in agent-search.js with YouTube's, which share the text helpers.
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
  search: (query, page) => MdgAgentSearch.searchBili(query, page)
});
