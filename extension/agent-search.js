// MoonDigest's agent interface, docs/AGENT.md §2 method `search`: a video search on Bilibili or YouTube, run in the
// service worker with the user's cookies (no tab). agent-bridge.js dispatches to MdgAgentSearch.search.
// Bilibili goes through triage-bg.js's channel (triageBiliGet, TRIAGE_BILI_IO for the WBI key), YouTube through
// background.js's fetchWithTimeout; the worker loads those after this file, so they are read only when a search runs.
(() => {
  const { parseTimestamp, parseCount, localDate } = MdgCommon;
  const GAP_MS = 2_000;
  const DESCRIPTION_MAX = 200;

  // Bilibili's highlight tags (<em class="keyword">) and entities, whitespace runs as one space.
  const plain = (s) => MdgSites.decodeXmlEntities(String(s ?? "").replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
  const short = (s) => (s.length > DESCRIPTION_MAX ? `${s.slice(0, DESCRIPTION_MAX)}…` : s);
  const seconds = (s) => Math.max(0, parseTimestamp(s));

  // data of x/web-interface/wbi/search/type?search_type=video → items.
  function biliItems(data) {
    return (data?.result || [])
      .filter((r) => r?.type === "video" && r.bvid)
      .map((r) => ({
        site: "bilibili",
        videoId: r.bvid,
        url: `https://www.bilibili.com/video/${r.bvid}`,
        title: plain(r.title),
        author: plain(r.author),
        duration: seconds(r.duration),
        views: Number.isFinite(r.play) ? r.play : null,
        uploadDate: r.pubdate > 0 ? localDate(r.pubdate * 1000) : "",
        description: short(plain(r.description))
      }));
  }

  const ytText = (t) => t?.simpleText ?? (t?.runs || []).map((r) => r.text).join("");

  // A youtube.com/results page's HTML → items, or null when it carries no ytInitialData (a consent or error page).
  // Only the result list's own videoRenderer items: shorts shelves, ads, channels, playlists and "people also watched"
  // shelves use other renderers or sit inside shelves.
  function ytItems(html) {
    const m = /ytInitialData"?\]?\s*=\s*(\{.+?\});\s*<\/script>/s.exec(html);
    if (!m) return null;
    let data;
    try { data = JSON.parse(m[1]); } catch { return null; }
    const sections = data?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents || [];
    return sections
      .flatMap((s) => s.itemSectionRenderer?.contents || [])
      .map((c) => c.videoRenderer)
      .filter((v) => v?.videoId)
      .map((v) => {
        const views = ytText(v.viewCountText);
        return {
          site: "youtube",
          videoId: v.videoId,
          url: `https://www.youtube.com/watch?v=${v.videoId}`,
          title: plain(ytText(v.title)),
          author: plain(ytText(v.ownerText || v.longBylineText)),
          duration: seconds(ytText(v.lengthText)), // a live stream has none: 0
          views: /\d/.test(views) ? parseCount(views) : null,
          uploadDate: ytText(v.publishedTimeText),
          description: short(plain(ytText(v.detailedMetadataSnippets?.[0]?.snippetText) || ytText(v.descriptionSnippet)))
        };
      });
  }

  const fail = (error, code) => Object.assign(new Error(error), code ? { code } : {});

  async function searchBili(query, page) {
    const params = { search_type: "video", keyword: query, page };
    try {
      // A function: the channel signs it again if it retries.
      const data = await triageBiliGet(async () => `${TRIAGE_BILI_API}/x/web-interface/wbi/search/type?${await MdgSites.biliWbiSigned(params, TRIAGE_BILI_IO)}`);
      return biliItems(data);
    } catch (e) {
      // A stale WBI key answers -352 like risk control: the next search fetches a fresh one.
      if (e.code === MdgErrors.CODE.THROTTLED) MdgSites.biliWbiReset();
      throw e;
    }
  }

  async function searchYt(query, page) {
    // ponytail: the results page is YouTube's first page only; later pages need the youtubei continuation API.
    if (page > 1) throw fail("YouTube search returns its first page only (about 20 videos): use page 1.");
    const res = await fetchWithTimeout(`https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`, { credentials: "include" }).catch((e) => {
      throw fail(e?.status ? e.message : MdgErrors.TEXT.netDown);
    });
    if (res.status === 429) throw fail(MdgErrors.TEXT.ytThrottled, MdgErrors.CODE.THROTTLED);
    if (!res.ok) throw fail(`YouTube answered HTTP ${res.status}.`);
    const items = ytItems(await res.text());
    if (!items) throw fail("YouTube did not return a search results page (a consent or sign-in page?). Open youtube.com in that browser once.");
    return items;
  }

  // ponytail: one global queue with a fixed gap; per-site queues if Bilibili and YouTube searches should overlap.
  let queue = Promise.resolve();
  let lastAt = 0;

  // params { site, query, page? } → { ok, data: { site, query, page, items } } or { ok: false, error, code? }.
  // deadline: as agent-bridge.js handle; a search still queued then is dropped with TIMEOUT.
  function search(params, deadline) {
    const site = params?.site;
    const query = typeof params?.query === "string" ? params.query.trim() : "";
    const page = params?.page ?? 1;
    if (site !== "bilibili" && site !== "youtube") return Promise.resolve({ ok: false, error: 'site must be "bilibili" or "youtube".' });
    if (!query) return Promise.resolve({ ok: false, error: "query is required." });
    if (!Number.isInteger(page) || page < 1) return Promise.resolve({ ok: false, error: "page must be an integer ≥ 1." });
    const run = queue.then(async () => {
      const wait = lastAt + GAP_MS - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      if (Date.now() > deadline) return { ok: false, code: "TIMEOUT", error: "The search waited too long behind earlier ones." };
      try {
        const items = await (site === "bilibili" ? searchBili : searchYt)(query, page);
        return { ok: true, data: { site, query, page, items } };
      } catch (e) {
        return { ok: false, error: e.message, ...(e.code === MdgErrors.CODE.THROTTLED && { code: e.code }) };
      } finally {
        lastAt = Date.now();
      }
    });
    queue = run.catch(() => {});
    return run;
  }

  globalThis.MdgAgentSearch = { search, biliItems, ytItems };
})();
