// YouTube for the agent interface (docs/AGENT.md §5). The content script (agent-page.js) reads its watch pages.
MdgAgentSites.register({
  id: "youtube",
  origins: ["*://*.youtube.com/*"],
  key(u) {
    const v = u.searchParams.get("v");
    return u.hostname.replace(/^www\./, "") === "youtube.com" && u.pathname === "/watch" && v ? `${v}:` : null;
  },
  read: "content",
  search: (query, page) => MdgAgentSearch.searchYt(query, page)
});
