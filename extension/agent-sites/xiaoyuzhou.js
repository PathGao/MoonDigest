// 小宇宙 (Xiaoyuzhou) podcast episodes for the agent interface (docs/AGENT.md §5), read from the page's __NEXT_DATA__.
// The transcript is not in the page (the app serves it to logged-in users only), so get says so and gives the audio URL.
MdgAgentSites.register({
  id: "xiaoyuzhou",
  origins: ["*://*.xiaoyuzhoufm.com/*"],
  key(u) {
    const m = /^\/episode\/([0-9A-Za-z]+)\/?$/.exec(u.pathname);
    return u.hostname.replace(/^www\./, "") === "xiaoyuzhoufm.com" && m ? `${m[1]}:` : null;
  },
  read: (url) => {
    const p = window.__NEXT_DATA__?.props?.pageProps;
    const e = p?.episode;
    // Another episode's data (a client-side navigation) counts as not ready.
    if (!e || new URL(url).pathname.replace(/\/$/, "") !== `/episode/${e.eid}`) return null;
    const audio = e.enclosure?.url || e.media?.source?.url || "";
    return {
      url,
      videoId: e.eid,
      title: e.title || "",
      author: [e.podcast?.title, e.podcast?.author].filter(Boolean).join(" / "),
      uploadDate: (e.pubDate || "").slice(0, 10),
      duration: e.duration || 0,
      description: e.description || "",
      part: { index: 1, count: 0, title: "" },
      chapters: [],
      subtitle: {
        segments: [], lang: "", warning: "",
        missing: "Xiaoyuzhou shows transcripts only to logged-in app users." + (audio ? ` Audio to transcribe: ${audio}` : "")
      },
      comments: (p.comments || []).map((c) => ({ uname: c.author?.nickname, like: c.likeCount, message: c.text }))
    };
  }
});
