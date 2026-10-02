// Site registry shared by content.js (manifest js list), background.js
// (importScripts) and the extension pages (<script>). Idempotent so a
// re-injected content script does not redeclare it.
//
// VideoRef { site, id, part: { index, cid? } | null, url }
// Meta     { title, author, authorUrl, uploadDate, description, duration, cover,
//            tags, chapters, pageCount, pageIndex, pageTitle, cid?, aid?, pages? }
// Track    { id, lang, label, url, kind: "manual" | "auto" | "ai", isDefault }
// Segment  { from, to, content } in seconds
// io       { fetchJson(url), fetchText?(url), postJson?(url, body), doc? }
(() => {
  if (globalThis.BocSites) {
    return;
  }

  function formatLocalDate(value) {
    const date = new Date(value);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  }

  function parseUrl(url) {
    try {
      return new URL(String(url || ""));
    } catch {
      return null;
    }
  }

  function positiveInt(value, fallback = 0) {
    const num = Number(value);
    return Number.isFinite(num) && num > 0 ? Math.floor(num) : fallback;
  }

  function httpsUrl(url) {
    const text = String(url || "").trim();
    if (!text) {
      return "";
    }
    if (text.startsWith("//")) {
      return `https:${text}`;
    }
    return text.replace(/^http:\/\//, "https://");
  }

  function parseTimestamp(text) {
    const parts = String(text).split(":").map((item) => Number(item));
    if (parts.some((item) => !Number.isFinite(item))) {
      return -1;
    }
    return parts.reduce((total, item) => total * 60 + item, 0);
  }

  // "00:00 Intro" / "1:02:03 - Topic" lines in a description become chapters.
  function parseChaptersFromDescription(description) {
    const lines = String(description || "").split(/\r?\n/);
    const chapters = [];
    lines.forEach((line) => {
      const match = line.match(/^\s*[\[(]?((?:\d{1,2}:)?\d{1,2}:\d{2})[\])]?\s*[-–—:|]?\s*(.+?)\s*$/);
      if (!match) {
        return;
      }
      const from = parseTimestamp(match[1]);
      const title = match[2].replace(/^[-–—:|\s]+/, "").trim();
      if (from < 0 || !title) {
        return;
      }
      chapters.push({ title, from, to: 0 });
    });
    if (chapters.length < 2 || chapters[0].from !== 0) {
      return [];
    }
    return normalizeChapters(chapters);
  }

  function normalizeChapters(chapters) {
    const normalized = (chapters || [])
      .map((item) => ({
        title: String(item?.title || "").trim(),
        from: Number(item?.from || 0) || 0,
        to: Number(item?.to || 0) || 0
      }))
      .filter((item) => item.title && item.from >= 0)
      .sort((a, b) => a.from - b.from);
    const seen = new Set();
    return normalized.filter((item) => {
      const key = `${Math.floor(item.from * 10)}|${item.title.toLowerCase()}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  }

  function trackLanguagePriority(track) {
    const lang = String(track?.lang || "").toLowerCase();
    const label = String(track?.label || "").toLowerCase();
    if (lang === "zh-cn" || lang === "zh-hans") return 0;
    if (lang === "zh") return 1;
    if (lang.includes("zh")) return 2;
    if (label.includes("中文")) return 3;
    if (lang === "en" || lang === "en-us" || lang === "en-gb") return 10;
    if (lang.includes("en")) return 11;
    if (label.includes("英文") || label.includes("英语") || label.includes("english")) return 12;
    return 50;
  }

  const KIND_ORDER = { manual: 0, auto: 1, ai: 1 };

  // Chinese, then English, then the rest; within a language the site's
  // default track and human-made tracks first.
  function rankTracks(tracks) {
    return [...(tracks || [])].sort((a, b) => {
      const gap = trackLanguagePriority(a) - trackLanguagePriority(b);
      if (gap !== 0) return gap;
      const defaultGap = Number(Boolean(b.isDefault)) - Number(Boolean(a.isDefault));
      if (defaultGap !== 0) return defaultGap;
      const kindGap = (KIND_ORDER[a.kind] ?? 1) - (KIND_ORDER[b.kind] ?? 1);
      if (kindGap !== 0) return kindGap;
      const labelGap = String(a.label || a.lang || "").toLowerCase().localeCompare(String(b.label || b.lang || "").toLowerCase());
      if (labelGap !== 0) return labelGap;
      const idA = Number.parseInt(String(a.id || ""), 10);
      const idB = Number.parseInt(String(b.id || ""), 10);
      if (Number.isFinite(idA) && Number.isFinite(idB) && idA !== idB) return idA - idB;
      return String(a.url || "").localeCompare(String(b.url || ""));
    });
  }

  // Signed subtitle URLs rotate their query string; the path identifies the track.
  function trackUrlKey(url) {
    const text = String(url || "").trim();
    if (!text) {
      return "";
    }
    const parsed = parseUrl(text);
    if (!parsed) {
      return text.replace(/[^\w/.-]+/g, "_");
    }
    return `${parsed.hostname}${parsed.pathname.replace(/[^\w/.-]+/g, "_")}`;
  }

  function pickPreferredTrack(tracks, { previousId = "", previousUrl = "", previousLang = "" } = {}) {
    const list = tracks || [];
    if (!list.length) {
      return null;
    }
    if (previousId) {
      const byId = list.find((item) => String(item.id || "") === String(previousId));
      if (byId) return byId;
    }
    const urlKey = trackUrlKey(previousUrl);
    if (urlKey) {
      const byUrl = list.find((item) => trackUrlKey(item.url) === urlKey);
      if (byUrl) return byUrl;
    }
    const lang = String(previousLang || "").trim().toLowerCase();
    if (lang) {
      const byLang = list.find((item) => String(item.label || item.lang || "").trim().toLowerCase() === lang);
      if (byLang) return byLang;
    }
    return list[0];
  }

  function normalizeSegments(items) {
    return (items || [])
      .map((item) => ({
        from: Number(item?.from) || 0,
        to: Number(item?.to) || 0,
        content: String(item?.content || "").trim()
      }))
      .filter((item) => item.content);
  }

  function readMetaContent(doc, selector) {
    return String(doc?.querySelector?.(selector)?.getAttribute?.("content") || "").trim();
  }

  function readText(doc, selector) {
    return String(doc?.querySelector?.(selector)?.textContent || "").trim();
  }

  // ---------------------------------------------------------------- Bilibili

  const BILI_API = "https://api.bilibili.com";

  function biliApiError(payload, fallback) {
    const error = new Error(String(payload?.message || fallback));
    error.code = payload?.code;
    // -509 rate limit, -3 bad param; other negatives are usually transient.
    error.retryable = typeof payload?.code === "number" && payload.code < 0;
    return error;
  }

  function biliExtractBvid(url) {
    const text = String(url || "");
    const fromPath = text.match(/\/video\/(BV[0-9A-Za-z]+)/)?.[1];
    if (fromPath) {
      return fromPath;
    }
    const fromQuery = String(parseUrl(text)?.searchParams.get("bvid") || "").trim();
    return /^BV[0-9A-Za-z]+$/.test(fromQuery) ? fromQuery : "";
  }

  function biliPickPage(pages, index) {
    const list = Array.isArray(pages) ? pages : [];
    return list[index - 1]?.cid ? list[index - 1] : list.find((item) => Number(item.page) === index) || null;
  }

  const bilibili = {
    id: "bilibili",
    label: "B 站",
    domain: "bilibili.com",
    hosts: ["www.bilibili.com", "api.bilibili.com", "hdslb.com"],
    match(url) {
      const parsed = parseUrl(url);
      if (!parsed || parsed.hostname !== "www.bilibili.com") {
        return false;
      }
      const path = parsed.pathname.replace(/\/+$/, "");
      return path.startsWith("/video/") || path === "/list/watchlater";
    },
    parseRef(url) {
      const id = biliExtractBvid(url);
      if (!id) {
        return null;
      }
      const parsed = parseUrl(url);
      const index = positiveInt(parsed?.searchParams.get("p"), 1);
      const part = {
        index,
        explicit: Boolean(parsed?.searchParams.has("p")),
        // Watch-later pages identify the current part by oid (= cid), not ?p=.
        oid: String(parsed?.searchParams.get("oid") || "").trim()
      };
      return { site: "bilibili", id, part, url: bilibili.canonicalUrl(id, index) };
    },
    canonicalUrl(id, partIndex = 1) {
      const suffix = positiveInt(partIndex, 1) > 1 ? `?p=${positiveInt(partIndex, 1)}` : "";
      return `https://www.bilibili.com/video/${id}/${suffix}`;
    },
    async fetchMeta(ref, io) {
      let payload = await io.fetchJson(`${BILI_API}/x/web-interface/view/detail?bvid=${encodeURIComponent(ref.id)}`).catch(() => null);
      let view = payload?.code === 0 ? payload.data?.View : null;
      let tags = payload?.code === 0 ? payload.data?.Tags : [];
      if (!view) {
        payload = await io.fetchJson(`${BILI_API}/x/web-interface/view?bvid=${encodeURIComponent(ref.id)}`);
        if (payload?.code !== 0) {
          throw biliApiError(payload, "无法获取视频信息");
        }
        view = payload.data || {};
        tags = [];
      }
      const pages = (Array.isArray(view.pages) ? view.pages : []).map((item) => ({
        cid: String(item?.cid || ""),
        page: Number(item?.page || 0) || 0,
        part: String(item?.part || "").trim(),
        duration: Number(item?.duration || 0) || 0
      }));

      let pageIndex = positiveInt(ref.part?.index, 1);
      if (ref.part?.cid) {
        pageIndex = pages.find((item) => item.cid === String(ref.part.cid))?.page || pageIndex;
      } else if (pages.length > 1 && !ref.part?.explicit) {
        // P1 is usually served without ?p=; fall back to it unless oid names a part.
        pageIndex = pages.find((item) => item.cid === ref.part?.oid)?.page || 1;
      }
      const page = biliPickPage(pages, pageIndex) || pages[0] || null;
      const cid = String(page?.cid || view.cid || "");
      if (!cid) {
        throw new Error("没有找到当前分P的 CID。");
      }
      const pubdate = Number(view.pubdate || 0);
      return {
        title: String(view.title || ""),
        author: String(view.owner?.name || ""),
        authorUrl: view.owner?.mid ? `https://space.bilibili.com/${view.owner.mid}` : "",
        uploadDate: pubdate > 0 ? formatLocalDate(pubdate * 1000) : "",
        description: String(view.desc || ""),
        duration: Number(page?.duration || view.duration || 0) || 0,
        cover: httpsUrl(view.pic),
        tags: (Array.isArray(tags) ? tags : []).map((item) => String(item?.tag_name || "").trim()).filter(Boolean),
        chapters: [],
        pageCount: pages.length,
        pageIndex: Number(page?.page) || pageIndex,
        pageTitle: String(page?.part || ""),
        cid,
        aid: view.aid ? String(view.aid) : "",
        pages
      };
    },
    // Resolves { tracks, chapters }. The wbi endpoint is primary; player/v2
    // is tried only when the primary request fails (not when it has no tracks).
    async fetchTracks(ref, meta, io) {
      const cid = encodeURIComponent(String(meta?.cid || ref.part?.cid || ""));
      const aid = encodeURIComponent(String(meta?.aid || ""));
      const bvid = encodeURIComponent(ref.id);
      const requests = [];
      if (meta?.aid) {
        requests.push(`${BILI_API}/x/player/wbi/v2?aid=${aid}&cid=${cid}&bvid=${bvid}`);
      }
      requests.push(`${BILI_API}/x/player/v2?bvid=${bvid}&cid=${cid}${meta?.aid ? `&aid=${aid}` : ""}`);

      const load = async (url) => {
        const payload = await io.fetchJson(url);
        if (payload?.code !== 0) {
          throw biliApiError(payload, "无法获取字幕列表");
        }
        const data = payload.data || {};
        const tracks = (data.subtitle?.subtitles || [])
          .map((item) => {
            const lang = String(item?.lan || "");
            return {
              id: item?.id === undefined || item?.id === null ? "" : String(item.id),
              lang,
              label: String(item?.lan_doc || ""),
              url: httpsUrl(item?.subtitle_url),
              kind: lang.toLowerCase().startsWith("ai-") ? "ai" : "manual",
              isDefault: false
            };
          })
          .filter((item) => item.url);
        const chapters = normalizeChapters(
          (Array.isArray(data.view_points) ? data.view_points : []).map((item) => ({
            title: String(item?.content || item?.title || "").trim(),
            from: biliChapterTime(item?.from ?? item?.start),
            to: biliChapterTime(item?.to ?? item?.end)
          }))
        );
        return { tracks, chapters };
      };

      try {
        return await load(requests[0]);
      } catch (primaryError) {
        if (requests.length < 2) {
          throw primaryError;
        }
        return load(requests[1]);
      }
    },
    async fetchSegments(track, io) {
      const payload = await io.fetchJson(track.url);
      return normalizeSegments(payload?.body);
    },
    async fetchComments(ref, meta, io, count = 20) {
      const aid = Number(meta?.aid || 0) || 0;
      if (!aid || !count) {
        return [];
      }
      const payload = await io.fetchJson(`${BILI_API}/x/v2/reply/main?type=1&oid=${aid}&mode=3&ps=${count}&pn=1`);
      const replies = Array.isArray(payload?.data?.replies) ? payload.data.replies : [];
      return replies.slice(0, count).map((item) => ({
        uname: String(item?.member?.uname || "匿名").trim() || "匿名",
        like: Number(item?.like || 0) || 0,
        message: String(item?.content?.message || "").trim().slice(0, 500)
      })).filter((item) => item.message);
    },
    embedHtml(ref, meta) {
      const aid = encodeURIComponent(String(meta?.aid || ""));
      const bvid = encodeURIComponent(ref.id);
      const cid = encodeURIComponent(String(meta?.cid || ""));
      const page = positiveInt(meta?.pageIndex, 1);
      return `<iframe src="https://player.bilibili.com/player.html?aid=${aid}&bvid=${bvid}&cid=${cid}&page=${page}&autoplay=0" scrolling="no" border="0" frameborder="no" framespacing="0" allow="fullscreen; picture-in-picture" allowfullscreen="true" style="height:100%;width:100%; aspect-ratio: 16 / 9;"> </iframe>`;
    },
    readDom(doc) {
      return {
        title:
          readText(doc, "h1.video-title") ||
          readMetaContent(doc, 'meta[property="og:title"]') ||
          String(doc?.title || "").replace(/_哔哩哔哩_bilibili/i, "").trim(),
        author: readText(doc, ".up-name") || readMetaContent(doc, 'meta[name="author"]'),
        description: readText(doc, ".desc-info-text, .video-desc .desc-info-text, .video-info-detail .text, .basic-desc-info"),
        uploadDate: readMetaContent(doc, 'meta[itemprop="uploadDate"]') || readText(doc, ".pubdate-ip-text")
      };
    },
    reader: {
      playerHost: [".bpx-player-container", ".bpx-player-video-area", "#bilibili-player"],
      playerLayout: [".bpx-player-container", ".bpx-docker", ".bpx-player-video-area", ".bpx-player-primary-area", ".bpx-player-inner", ".scroll-sticky", "#bilibili-player", "#playerWrap", ".player-wrap"],
      playerWrap: ["#playerWrap", ".player-wrap"],
      miniPlayer: [".bpx-player-mini-warp", ".bpx-player-mini-close"],
      miniClose: [".bpx-player-mini-close"],
      endingPanel: [".bpx-player-ending-panel", ".bpx-player-ending-related"],
      controls: [".bpx-player-control-wrap", ".bpx-player-control-mask", ".bpx-player-control-entity"],
      noCursorClass: "bpx-state-no-cursor",
      sendingBar: ".bpx-player-sending-bar",
      title: ["h1.video-title"],
      metaContainer: [".video-data", ".video-info-detail", ".video-info-meta"],
      keepRoots: ["#bilibili-player", ".bpx-player-container", ".bpx-player-video-area", ".bpx-player-primary-area", "h1.video-title", ".video-info-detail", ".video-info-meta", ".video-data"],
      noise: [".strip-ad-inner", ".inside-wrp", ".inside-bg", ".hinter-msg", ".slide", ".cover.b-img", ".cover.b-img.sleepy", ".b-img.clickable", "[class*='activity']", "[class*='adcard']"],
      cards: ["article", "li", ".card-box", ".video-page-card-small", ".video-page-special-card-small", ".feed-card", ".bili-video-card"],
      ignoredVideo: [".ad-report", "[class*='ad-report']", ".video-page-card-small", ".video-page-special-card-small", ".feed-card", ".bili-video-card"],
      subtitleControlRoots: ["#bilibili-player .bpx-player-control-wrap", "#playerWrap .bpx-player-control-wrap", ".bpx-player-container .bpx-player-control-wrap", "#bilibili-player", "#playerWrap", ".bpx-player-container"],
      aiQuickActionHosts: [".bpx-player-container", ".bpx-player-video-area", "#bilibili-player", "#playerWrap"]
    }
  };

  function biliChapterTime(value) {
    const num = Number(value);
    if (!Number.isFinite(num) || num < 0) {
      return 0;
    }
    // Some responses carry milliseconds.
    return num > 60 * 60 * 24 ? num / 1000 : num;
  }

  // ----------------------------------------------------------------- registry

  const SITES = { bilibili };

  function matchSite(url) {
    return Object.values(SITES).find((site) => site.match(url)) || null;
  }

  function parseRef(url) {
    return matchSite(url)?.parseRef(url) || null;
  }

  function cleanUrl(url) {
    return parseRef(url)?.url || String(url || "");
  }

  function isAllowedFetchUrl(url) {
    const parsed = parseUrl(url);
    if (!parsed || parsed.protocol !== "https:") {
      return false;
    }
    return Object.values(SITES).some((site) =>
      site.hosts.some((host) => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`))
    );
  }

  function buildContextKey({ site = "", videoId = "", cid = "" } = {}) {
    return videoId ? `video:${site}:${videoId}|${cid || ""}` : "";
  }

  globalThis.BocSites = {
    SITES,
    matchSite,
    parseRef,
    cleanUrl,
    isAllowedFetchUrl,
    buildContextKey,
    rankTracks,
    pickPreferredTrack,
    trackUrlKey,
    normalizeChapters,
    parseChaptersFromDescription,
    normalizeSegments
  };
})();
