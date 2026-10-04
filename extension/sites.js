// Site registry shared by content.js (manifest js list), background.js
// (importScripts) and the extension pages (<script>). Idempotent so a
// re-injected content script does not redeclare it.
//
// VideoRef { site, id, part: { index, explicit?, oid?, cid? } | null, url }
// Meta     { title, author, authorUrl, uploadDate, description, duration, cover,
//            tags, chapters, pageCount, pageIndex, pageTitle, cid?, aid?, pages? }
// Track    { id, lang, label, url, kind: "manual" | "auto" | "ai" | "translated" | "transcript", isDefault }
// Segment  { from, to, content } in seconds
// io       { fetchJson(url), fetchText?(url), postJson?(url, body, headers?), doc?, subtitleLang?,
//            readPlayer?() -> the page player's own response, capturePot?(videoId) -> { pot, client } }
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

  const KIND_ORDER = { manual: 0, auto: 1, ai: 1, translated: 2 };

  // Targets of the youtubeSubtitleLang setting besides "auto".
  const SUBTITLE_LANG_NAMES = { "zh-Hans": "简体中文", "zh-Hant": "繁體中文", en: "English", ja: "日本語" };

  function normalizeSubtitleLang(value) {
    return SUBTITLE_LANG_NAMES[value] ? value : "auto";
  }

  function langMatches(lang, target) {
    const code = String(lang || "").toLowerCase();
    const hant = /^zh-(hant|tw|hk|mo)\b/.test(code);
    if (target === "zh-Hans") return code.startsWith("zh") && !hant;
    if (target === "zh-Hant") return hant;
    const want = target.toLowerCase();
    return code === want || code.startsWith(`${want}-`);
  }

  // Chinese, then English, then the rest; within a language the site's
  // default track and human-made tracks first. A target other than "auto"
  // moves its language to the front.
  function rankTracks(tracks, target = "auto") {
    // Under "auto" a machine translation is only offered, never the default.
    const misses = (track) => Number(SUBTITLE_LANG_NAMES[target] ? !langMatches(track.lang, target) : track.kind === "translated");
    return [...(tracks || [])].sort((a, b) => {
      const targetGap = misses(a) - misses(b);
      if (targetGap !== 0) return targetGap;
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

  // Old av links (/video/av170001) still open without redirecting; the BV id is a fixed transform of the aid.
  function biliAvToBv(aid) {
    const table = "FcwAPNKTMug3GV5Lj7EJnHpWsx4tb8haYeviqBz6rkCy12mUSDQX9RdoZf";
    const out = [..."BV1000000000"];
    let n = ((1n << 51n) | BigInt(aid)) ^ 23442827791579n;
    for (let i = 11; n > 0n; i--, n /= 58n) out[i] = table[Number(n % 58n)];
    [out[3], out[9]] = [out[9], out[3]];
    [out[4], out[7]] = [out[7], out[4]];
    return out.join("");
  }

  function biliExtractBvid(url) {
    const text = String(url || "");
    const fromPath = text.match(/\/video\/(BV[0-9A-Za-z]+)/)?.[1];
    if (fromPath) {
      return fromPath;
    }
    const av = text.match(/\/video\/av(\d+)/i)?.[1];
    if (av) {
      return biliAvToBv(av);
    }
    const fromQuery = String(parseUrl(text)?.searchParams.get("bvid") || "").trim();
    return /^BV[0-9A-Za-z]+$/.test(fromQuery) ? fromQuery : "";
  }

  function biliPickPage(pages, index) {
    const list = Array.isArray(pages) ? pages : [];
    return list[index - 1]?.cid ? list[index - 1] : list.find((item) => Number(item.page) === index) || null;
  }

  function biliMd5(str) {
    const bytes = new TextEncoder().encode(String(str));
    const len = bytes.length;
    const blocks = ((len + 8) >> 6) + 1;
    const m = new Uint32Array(blocks * 16);
    for (let i = 0; i < len; i++) m[i >> 2] |= bytes[i] << ((i % 4) * 8);
    m[len >> 2] |= 0x80 << ((len % 4) * 8);
    m[blocks * 16 - 2] = (len * 8) >>> 0;
    m[blocks * 16 - 1] = Math.floor((len * 8) / 4294967296);
    const S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
    const K = [];
    for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0;
    let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
    for (let off = 0; off < m.length; off += 16) {
      let A = a0, B = b0, C = c0, D = d0;
      for (let i = 0; i < 64; i++) {
        let F, g;
        if (i < 16) { F = (B & C) | (~B & D); g = i; }
        else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
        else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
        else { F = C ^ (B | ~D); g = (7 * i) % 16; }
        const s = S[(i >> 4) * 4 + (i % 4)];
        F = (F + A + K[i] + m[off + g]) >>> 0;
        A = D; D = C; C = B;
        B = (B + ((F << s) | (F >>> (32 - s)))) >>> 0;
      }
      a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
    }
    let hex = "";
    for (const w of [a0, b0, c0, d0]) {
      for (let i = 0; i < 4; i++) hex += ((w >>> (i * 8)) & 0xff).toString(16).padStart(2, "0");
    }
    return hex;
  }

  const BILI_MIXIN_TAB = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52];

  function biliMixinKey(imgUrl, subUrl) {
    const key = (u) => String(u).split("/").pop().split(".")[0];
    const raw = key(imgUrl) + key(subUrl);
    return BILI_MIXIN_TAB.map((i) => raw[i]).join("").slice(0, 32);
  }

  function biliWbiSign(params, mixinKey, wts) {
    const all = { ...params, wts };
    const query = Object.keys(all)
      .sort()
      .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(all[k]).replace(/[!'()*]/g, ""))}`)
      .join("&");
    return `${query}&w_rid=${biliMd5(query + mixinKey)}`;
  }

  // The wbi endpoints want a w_rid signature keyed by nav's wbi_img (present even when logged out,
  // code -101). Without a key the request goes unsigned.
  let biliWbiKey = { key: "", at: 0 };
  async function biliWbiQuery(params, io) {
    try {
      if (!biliWbiKey.key || Date.now() - biliWbiKey.at > 10 * 60 * 1000) {
        const img = (await io.fetchJson(`${BILI_API}/x/web-interface/nav`))?.data?.wbi_img;
        if (!img?.img_url || !img?.sub_url) throw new Error("no wbi_img");
        biliWbiKey = { key: biliMixinKey(img.img_url, img.sub_url), at: Date.now() };
      }
      return biliWbiSign(params, biliWbiKey.key, Math.floor(Date.now() / 1000));
    } catch {
      return Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join("&");
    }
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
        tname: String(view.tname || ""),
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
        // Only callers that opt in sign (triage); the video page keeps its unsigned request and skips nav.
        const query = io.signWbi
          ? await biliWbiQuery({ aid: String(meta.aid), cid: String(meta?.cid || ref.part?.cid || ""), bvid: ref.id }, io)
          : `aid=${aid}&cid=${cid}&bvid=${bvid}`;
        requests.push(`${BILI_API}/x/player/wbi/v2?${query}`);
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
              // id_str keeps ids past 2^53 exact; id is the fallback.
              id: String(item?.id_str || (item?.id ?? "")),
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
        // A stale wbi key answers -352, so the next signed call refetches nav.
        if (io.signWbi) {
          biliWbiKey = { key: "", at: 0 };
        }
        // Throttling must reach the caller: under risk control player/v2 tends to answer with no tracks.
        if (requests.length < 2 || primaryError?.code === "THROTTLED") {
          throw primaryError;
        }
        return load(requests[1]);
      }
    },
    // Raw responses are what the subtitle cache stores; parseSegments runs on
    // every read so a parser fix reaches cached entries.
    async fetchRaw(track, io) {
      return io.fetchJson(track.url);
    },
    parseSegments(raw) {
      return normalizeSegments(raw?.body);
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

  // ----------------------------------------------------------------- YouTube

  // Innertube clients, versions from yt-dlp (2026-07). WEB takes the page's
  // own version. fetch() cannot set User-Agent, so the ANDROID call goes out
  // with the browser's UA; the context fields have been enough so far.
  const YT_CLIENTS = {
    WEB: { id: "1", client: { clientName: "WEB" } },
    WEB_EMBEDDED_PLAYER: { id: "56", client: { clientName: "WEB_EMBEDDED_PLAYER", clientVersion: "2.20260708.00.00" } },
    ANDROID: { id: "3", client: { clientName: "ANDROID", clientVersion: "21.26.364", androidSdkVersion: 30, osName: "Android", osVersion: "11" } }
  };
  const YT_HOSTS = new Set(["www.youtube.com", "youtube.com", "m.youtube.com", "music.youtube.com", "www.youtube-nocookie.com"]);
  const YT_WEB_CLIENT_VERSION_FALLBACK = "2.20250101.00.00";
  let ytPageConfig = null;

  function ytExtractVideoId(url) {
    const parsed = parseUrl(url);
    if (!parsed) {
      return "";
    }
    const idPattern = /^[A-Za-z0-9_-]{11}$/;
    if (parsed.hostname === "youtu.be") {
      const id = parsed.pathname.slice(1).split("/")[0];
      return idPattern.test(id) ? id : "";
    }
    if (!YT_HOSTS.has(parsed.hostname)) {
      return "";
    }
    const fromQuery = String(parsed.searchParams.get("v") || "");
    if (idPattern.test(fromQuery)) {
      return fromQuery;
    }
    const fromPath = parsed.pathname.match(/^\/(?:shorts|embed|live|v)\/([A-Za-z0-9_-]{11})(?:[/?]|$)/)?.[1] || "";
    return idPattern.test(fromPath) ? fromPath : "";
  }

  // Both values are constant for the page's lifetime, so they are read once.
  function ytReadPageConfig(doc) {
    if (ytPageConfig) {
      return ytPageConfig;
    }
    for (const script of doc?.querySelectorAll?.("script") || []) {
      const text = String(script.textContent || "");
      const apiKey = text.match(/"INNERTUBE_API_KEY"\s*:\s*"([^"]+)"/)?.[1];
      if (apiKey) {
        ytPageConfig = {
          apiKey,
          webClientVersion: text.match(/"INNERTUBE_CLIENT_VERSION"\s*:\s*"([^"]+)"/)?.[1] || YT_WEB_CLIENT_VERSION_FALLBACK,
          visitorData: text.match(/"VISITOR_DATA"\s*:\s*"([^"]+)"/)?.[1] || ""
        };
        return ytPageConfig;
      }
    }
    return { apiKey: "", webClientVersion: YT_WEB_CLIENT_VERSION_FALLBACK, visitorData: "" };
  }

  // Innertube call from the page, with the user's cookies and the headers the
  // watch page itself sends. hl is pinned to English so counts arrive as
  // "1.2K", which ytParseCount reads exactly.
  function ytPost(io, endpoint, { context = {}, ...body }, clientName = "WEB") {
    const config = ytReadPageConfig(io.doc);
    const { id, client } = YT_CLIENTS[clientName];
    const clientVersion = client.clientVersion || config.webClientVersion;
    return io.postJson(
      `https://www.youtube.com/youtubei/v1/${endpoint}?prettyPrint=false${config.apiKey ? `&key=${config.apiKey}` : ""}`,
      { context: { client: { ...client, clientVersion, hl: "en" }, ...context }, ...body },
      {
        "X-Youtube-Client-Name": id,
        "X-Youtube-Client-Version": clientVersion,
        ...(config.visitorData ? { "X-Goog-Visitor-Id": config.visitorData } : {})
      }
    );
  }

  // One /next per load, shared by chapters, comments and the transcript
  // fallback. fetchTracks refreshes it (SPA navigation changes the video and
  // continuation tokens age); the others reuse it.
  let ytNext = { id: "", response: null };

  async function ytNextResponse(ref, io, fresh = false) {
    if (!fresh && ytNext.id === ref.id && ytNext.response) {
      return ytNext.response;
    }
    const response = await ytPost(io, "next", { videoId: ref.id });
    ytNext = { id: ref.id, response };
    return response;
  }

  // Player responses by client and the subtitle PO token of the current
  // load. The token is bound to the video id only, so one serves every
  // client. fetchMeta starts a load and clears it.
  let ytPlayer = { id: "", responses: {}, pot: null, resolved: false };

  function ytPlayerCache(ref, fresh = false) {
    if (fresh || ytPlayer.id !== ref.id) {
      ytPlayer = { id: ref.id, responses: {}, pot: null, resolved: false };
    }
    return ytPlayer;
  }

  // WEB prefers the page player's own response: signed in and already loaded.
  // After SPA navigation it may still describe the previous video, so a
  // response naming another video is never used.
  async function ytPlayerResponse(ref, io, clientName) {
    const cache = ytPlayerCache(ref);
    if (cache.responses[clientName]) {
      return cache.responses[clientName];
    }
    let response = null;
    if (clientName === "WEB" && io.readPlayer) {
      const live = await io.readPlayer().catch(() => null);
      response = live?.videoDetails?.videoId === ref.id ? live : null;
    }
    if (!response) {
      const body = { videoId: ref.id };
      if (clientName === "WEB_EMBEDDED_PLAYER") {
        body.context = { thirdParty: { embedUrl: `https://www.youtube.com/embed/${ref.id}` } };
      }
      response = await ytPost(io, "player", body, clientName);
      if (response?.videoDetails?.videoId && response.videoDetails.videoId !== ref.id) {
        throw new Error("播放器返回的是另一个视频，请刷新页面重试");
      }
    }
    cache.responses[clientName] = response || {};
    return cache.responses[clientName];
  }

  function ytGateReason(response) {
    const status = String(response?.playabilityStatus?.status || "");
    return status === "LOGIN_REQUIRED" || /^AGE_/.test(status) ? String(response.playabilityStatus.reason || status) : "";
  }

  // pot and c of the newest timedtext request the page player made for this video.
  function ytPotFromUrls(urls, videoId) {
    for (const text of [...(urls || [])].reverse()) {
      const parsed = parseUrl(text);
      if (!parsed || parsed.hostname !== "www.youtube.com" || parsed.pathname !== "/api/timedtext") continue;
      const params = parsed.searchParams;
      if (params.get("v") !== videoId || !params.get("pot")) continue;
      return { pot: params.get("pot"), client: params.get("c") || "WEB" };
    }
    return null;
  }

  // Caption URL as yt-dlp builds it: baseUrl params kept, xosf dropped (it
  // adds position data), fmt set, pot/potc/c appended, tlang only when it
  // differs from the source language (tlang=lang returns damaged subtitles).
  function ytCaptionUrl(baseUrl, { pot = null, fmt = "json3", tlang = "" } = {}) {
    const url = new URL(baseUrl, "https://www.youtube.com");
    url.searchParams.delete("xosf");
    url.searchParams.set("fmt", fmt);
    if (tlang && tlang !== url.searchParams.get("lang")) {
      url.searchParams.set("tlang", tlang);
    }
    if (pot?.pot) {
      url.searchParams.set("pot", pot.pot);
      url.searchParams.set("potc", "1");
      url.searchParams.set("c", pot.client || "WEB");
    }
    return url.toString();
  }

  function ytNeedsPot(baseUrl) {
    return /^(xpe|xpv)$/.test(parseUrl(baseUrl)?.searchParams.get("exp") || "");
  }

  // Caption tracks of a player response, URLs left as baseUrl.
  function ytCaptionTracks(response, source) {
    const renderer = response?.captions?.playerCaptionsTracklistRenderer || {};
    const audio = (renderer.audioTracks || [])[Number(renderer.defaultAudioTrackIndex) || 0];
    const defaultIndex = Number(audio?.defaultCaptionTrackIndex);
    return (renderer.captionTracks || [])
      .map((track, index) => ({
        id: String(track?.vssId || `${track?.languageCode || ""}#${index}`),
        lang: String(track?.languageCode || ""),
        label: ytTrackName(track) || String(track?.languageCode || ""),
        url: String(track?.baseUrl || ""),
        kind: track?.kind === "asr" || String(track?.vssId || "").startsWith("a.") ? "auto" : "manual",
        isDefault: index === defaultIndex,
        translatable: track?.isTranslatable === true,
        source
      }))
      .filter((track) => track.url);
  }

  // Tracks of one client with final URLs. The PO token is captured from the
  // page player only when a track's URL demands one (exp=xpe/xpv); such
  // tracks are dropped when no token can be had, as yt-dlp does.
  async function ytClientTracks(ref, io, clientName) {
    const cache = ytPlayerCache(ref);
    const tracks = ytCaptionTracks(await ytPlayerResponse(ref, io, clientName), clientName);
    if (!cache.pot && io.capturePot && tracks.some((track) => ytNeedsPot(track.url))) {
      cache.pot = (await io.capturePot(ref.id).catch(() => null)) || null;
    }
    return tracks
      .filter((track) => cache.pot || !ytNeedsPot(track.url))
      .map((track) => ({ ...track, url: ytCaptionUrl(track.url, { pot: cache.pot }) }));
  }

  // Signed-in page player first, ANDROID when it yields nothing, and for a
  // gated video the embedded player, which YouTube lets through for
  // embeddable age-gated videos. Resolves [] when every source is dry.
  async function ytResolveTracks(ref, io) {
    for (const clientName of ["WEB", "ANDROID"]) {
      const tracks = await ytClientTracks(ref, io, clientName).catch(() => []);
      if (tracks.length) return tracks;
    }
    const cache = ytPlayerCache(ref);
    if (Object.values(cache.responses).some(ytGateReason)) {
      return ytClientTracks(ref, io, "WEB_EMBEDDED_PLAYER").catch(() => []);
    }
    // The video has captions, but every track needs a PO token and the page player gave none.
    if (ytCaptionTracks(cache.responses.WEB).length) {
      throw new Error("没拿到 YouTube 字幕令牌，请稍后重试");
    }
    return [];
  }

  function ytIsoDate(value) {
    const text = String(value || "");
    return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : "";
  }

  function xmlAttr(attrs, name) {
    return new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)?.[1] ?? "";
  }

  const XML_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

  // One pass, so "&amp;lt;" decodes to the literal "&lt;".
  function decodeXmlEntities(text) {
    return String(text).replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (whole, body) => {
      if (body[0] === "#") {
        const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
      }
      return XML_ENTITIES[body.toLowerCase()] ?? whole;
    });
  }

  const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}　-〿＀-￯]/u;

  // Line breaks inside a caption become one space, except between two CJK
  // characters, where no separator belongs (machine-translated zh showed "我也 懂").
  function joinCaptionLines(text) {
    return String(text)
      .replace(/\s*\n\s*/g, (match, offset, whole) =>
        CJK.test(whole[offset - 1] || "") && CJK.test(whole[offset + match.length] || "") ? "" : " "
      )
      .replace(/\s+/g, " ");
  }

  // srv3: <p t="ms" d="ms"><s>word</s><s t="offset"> next</s></p>. Tags are
  // stripped, not trimmed, because the space between words lives inside <s>.
  function parseSrv3(xml) {
    const items = [];
    for (const match of String(xml).matchAll(/<p\b([^>]*)>([\s\S]*?)<\/p>/g)) {
      const from = Number(xmlAttr(match[1], "t"));
      const duration = Number(xmlAttr(match[1], "d")) || 0;
      const content = joinCaptionLines(
        decodeXmlEntities(match[2].replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, ""))
      ).trim();
      if (!Number.isFinite(from) || !content) {
        continue;
      }
      items.push({ from: from / 1000, to: (from + duration) / 1000, content });
    }
    return items;
  }

  function parseJson3(data) {
    const events = Array.isArray(data?.events) ? data.events : [];
    return normalizeSegments(
      events
        // aAppend events re-time words of an earlier line; the line itself already carries them.
        .filter((event) => Number.isFinite(event?.tStartMs) && Array.isArray(event.segs) && !event.aAppend)
        .map((event) => ({
          from: event.tStartMs / 1000,
          to: (event.tStartMs + (Number(event.dDurationMs) || 0)) / 1000,
          content: joinCaptionLines(event.segs.map((seg) => String(seg?.utf8 || "")).join(""))
        }))
    );
  }

  function parseYoutubeSubtitle(text) {
    const body = String(text || "").trim();
    if (!body) {
      return [];
    }
    return body.startsWith("{") ? parseJson3(JSON.parse(body)) : parseSrv3(body);
  }

  function ytText(value) {
    const text =
      typeof value === "string"
        ? value
        : value?.simpleText ?? (typeof value?.content === "string" ? value.content : value?.runs?.map((run) => run.text).join(""));
    return String(text ?? "").trim();
  }

  function ytTrackName(track) {
    return ytText(track?.name);
  }

  // Without a native track in the target language, YouTube machine-translates
  // any translatable track when its URL gets tlang. translationLanguages is
  // not consulted: it never lists zh-Hans, which works. Manual sources first.
  // Under "auto" a video without any Chinese track is offered zh-Hans.
  function ytWithTranslation(tracks, target) {
    const auto = !SUBTITLE_LANG_NAMES[target];
    const lang = auto ? "zh-Hans" : target;
    if (tracks.some((track) => langMatches(track.lang, lang) || (auto && langMatches(track.lang, "zh-Hant")))) {
      return tracks;
    }
    const source = rankTracks(tracks.filter((track) => track.translatable)).sort(
      (a, b) => Number(a.kind !== "manual") - Number(b.kind !== "manual")
    )[0];
    if (!source) {
      return tracks;
    }
    return [
      ...tracks,
      {
        id: `${source.id}>${lang}`,
        lang,
        label: `${SUBTITLE_LANG_NAMES[lang]}（机器翻译，自${source.label}）`,
        url: ytCaptionUrl(source.url, { tlang: lang }),
        kind: "translated",
        isDefault: false
      }
    ];
  }

  const YT_COUNT_UNITS = { k: 1e3, m: 1e6, b: 1e9, 千: 1e3, 万: 1e4, 萬: 1e4, 亿: 1e8, 億: 1e8 };

  // "322K", "1.2M", "1,234", "1.2万" -> number; anything else -> 0.
  function ytParseCount(text) {
    const match = String(text || "").replace(/,/g, "").match(/(\d+(?:\.\d+)?)\s*([kmb千万萬亿億])?/i);
    return match ? Math.round(Number(match[1]) * (YT_COUNT_UNITS[String(match[2] || "").toLowerCase()] || 1)) : 0;
  }

  function ytWalk(node, visit) {
    if (node && typeof node === "object") {
      visit(node);
      Object.values(node).forEach((child) => ytWalk(child, visit));
    }
  }

  function ytFind(node, key) {
    const found = [];
    ytWalk(node, (item) => {
      if (item[key]) found.push(item[key]);
    });
    return found;
  }

  // Creator chapters and auto-chapters both arrive as chapterRenderer in the
  // player bar's markersMap; the engagement panel repeats them as
  // macroMarkersListItemRenderer, which is only consulted when the bar is absent.
  function ytChapters(nextResponse) {
    const fromBar = ytFind(nextResponse, "chapterRenderer").map((item) => ({
      title: ytText(item.title),
      from: (Number(item.timeRangeStartMillis) || 0) / 1000,
      to: 0
    }));
    if (fromBar.length) {
      return normalizeChapters(fromBar);
    }
    return normalizeChapters(
      ytFind(nextResponse, "macroMarkersListItemRenderer").map((item) => ({
        title: ytText(item.title),
        from: Number(item.onTap?.watchEndpoint?.startTimeSeconds ?? parseTimestamp(ytText(item.timeDescription))),
        to: 0
      }))
    );
  }

  const YT_TRANSCRIPT_URL = "https://www.youtube.com/youtubei/v1/get_transcript";
  const YT_TRANSCRIPT_MAX_PAGES = 5;

  function ytTranscriptParams(nextResponse) {
    return String(ytFind(nextResponse, "getTranscriptEndpoint")[0]?.params || "");
  }

  // Current responses list transcriptSegmentRenderer (ms as strings); the
  // view-model and cue-group shapes are older or regional variants.
  function ytParseTranscript(response) {
    const items = [];
    ytWalk(response, (node) => {
      const segment = node.transcriptSegmentRenderer || node.transcriptSegmentViewModel;
      if (segment) {
        const from = Number(segment.startMs ?? segment.startTimeMs ?? segment.startOffsetMs);
        const to = Number(segment.endMs ?? segment.endTimeMs);
        items.push({ from: from / 1000, to: (Number.isFinite(to) ? to : from) / 1000, content: ytText(segment.snippet ?? segment.content ?? segment.text) });
      }
      for (const cue of node.transcriptCueGroupRenderer?.cues || []) {
        const item = cue.transcriptCueRenderer || cue;
        const from = Number(item.startOffsetMs ?? item.startMs) || 0;
        items.push({ from: from / 1000, to: (from + (Number(item.durationMs) || 0)) / 1000, content: ytText(item.cue ?? item.snippet) });
      }
    });
    return normalizeSegments(items.filter((item) => Number.isFinite(item.from)));
  }

  // Language-menu entries carry reloadContinuationData (a language switch);
  // only continuationItemRenderer continues the same transcript.
  function ytTranscriptContinuation(response) {
    return String(ytFind(response, "continuationItemRenderer")[0]?.continuationEndpoint?.continuationCommand?.token || "");
  }

  function ytTranscriptLanguage(response) {
    const items = ytFind(response, "transcriptFooterRenderer")[0]?.languageMenu?.sortFilterSubMenuRenderer?.subMenuItems || [];
    return ytText(items.find((item) => item.selected)?.title);
  }

  // Resolves { responses, language }: every transcript page as fetched;
  // language is "" when the footer is absent.
  async function ytFetchTranscript(params, io) {
    let response = await ytPost(io, "get_transcript", { params });
    const language = ytTranscriptLanguage(response);
    const responses = [response];
    for (let page = 1; page < YT_TRANSCRIPT_MAX_PAGES; page += 1) {
      const continuation = ytTranscriptContinuation(response);
      if (!continuation) break;
      response = await ytPost(io, "get_transcript", { continuation });
      responses.push(response);
    }
    return { responses, language };
  }

  function ytIsTranscriptUrl(url) {
    return String(url || "").startsWith(`${YT_TRANSCRIPT_URL}?`);
  }

  function ytCommentsToken(nextResponse) {
    let token = "";
    ytWalk(nextResponse, (node) => {
      if (!token && node.itemSectionRenderer?.sectionIdentifier === "comment-item-section") {
        ytWalk(node.itemSectionRenderer, (child) => {
          token ||= child.continuationCommand?.token || "";
        });
      }
    });
    return token;
  }

  function ytCommentItems(response) {
    return (response?.onResponseReceivedEndpoints || []).flatMap(
      (item) => (item.reloadContinuationItemsCommand || item.appendContinuationItemsAction)?.continuationItems || []
    );
  }

  // Token of the "Top" sort when the response is sorted otherwise, else "".
  function ytTopSortToken(response) {
    const header = ytCommentItems(response).find((item) => item.commentsHeaderRenderer)?.commentsHeaderRenderer;
    const top = header?.sortMenu?.sortFilterSubMenuRenderer?.subMenuItems?.[0];
    return top && !top.selected ? top.serviceEndpoint?.continuationCommand?.token || "" : "";
  }

  // Threads keep their order in continuationItems; current responses put the
  // comment body in an entity keyed by commentViewModel.commentKey, older ones
  // inline a commentRenderer.
  function ytParseComments(response) {
    const entities = new Map();
    for (const mutation of response?.frameworkUpdates?.entityBatchUpdate?.mutations || []) {
      const payload = mutation?.payload?.commentEntityPayload;
      if (payload) {
        entities.set(payload.key || mutation.entityKey, payload);
      }
    }
    return ytCommentItems(response)
      .map((item) => item.commentThreadRenderer)
      .filter(Boolean)
      .map((thread) => {
        const entity = entities.get(thread.commentViewModel?.commentViewModel?.commentKey);
        if (entity) {
          return {
            uname: ytText(entity.author?.displayName),
            like: ytParseCount(entity.toolbar?.likeCountNotliked || entity.toolbar?.likeCountA11y),
            message: ytText(entity.properties?.content?.content)
          };
        }
        const legacy = thread.comment?.commentRenderer;
        return {
          uname: ytText(legacy?.authorText),
          like: ytParseCount(ytText(legacy?.voteCount)),
          message: ytText(legacy?.contentText)
        };
      })
      .map((item) => ({ uname: item.uname || "匿名", like: item.like, message: item.message.slice(0, 500) }))
      .filter((item) => item.message);
  }

  const youtube = {
    id: "youtube",
    label: "YouTube",
    domain: "youtube.com",
    hosts: ["www.youtube.com", "youtu.be", "i.ytimg.com"],
    // The player API answers 403 to requests carrying a chrome-extension://
    // Origin, so meta/tracks are fetched from inside the page only.
    pageOnly: true,
    match(url) {
      return Boolean(ytExtractVideoId(url));
    },
    parseRef(url) {
      const id = ytExtractVideoId(url);
      return id ? { site: "youtube", id, part: null, url: youtube.canonicalUrl(id) } : null;
    },
    canonicalUrl(id) {
      return `https://www.youtube.com/watch?v=${id}`;
    },
    // Meta comes from the page player's own response (signed in), or the
    // ANDROID player when that one has no videoDetails. A sign-in or age gate
    // is reported, not thrown, while videoDetails are present: fetchTracks
    // still has the embedded player and content.js the transcript to try.
    async fetchMeta(ref, io) {
      if (!io.postJson) {
        throw new Error("YouTube 视频信息只能在视频页内获取");
      }
      ytPlayerCache(ref, true);
      let data = await ytPlayerResponse(ref, io, "WEB");
      if (!data.videoDetails?.title) {
        data = await ytPlayerResponse(ref, io, "ANDROID");
      }
      const status = data?.playabilityStatus?.status;
      const reason = data?.playabilityStatus?.reason || status || "unknown";
      const gate = ytGateReason(data) ? `该视频需要登录或年龄验证，暂不支持（${reason}）` : "";
      if (gate && !data.videoDetails?.title) {
        throw new Error(gate);
      }
      if (!gate && status !== "OK") {
        throw new Error(`视频不可播放：${reason}`);
      }
      const details = data.videoDetails || {};
      const micro = data.microformat?.playerMicroformatRenderer;
      const thumbnails = [...(details.thumbnail?.thumbnails || [])].sort((a, b) => (Number(b.width) || 0) - (Number(a.width) || 0));
      return {
        title: String(details.title || ""),
        author: String(details.author || ""),
        authorUrl: details.channelId ? `https://www.youtube.com/channel/${details.channelId}` : "",
        uploadDate: ytIsoDate(micro?.publishDate || micro?.uploadDate),
        description: String(details.shortDescription || ""),
        duration: Number(details.lengthSeconds) || 0,
        cover: httpsUrl(thumbnails[0]?.url),
        tags: (Array.isArray(details.keywords) ? details.keywords : []).map((item) => String(item).trim()).filter(Boolean),
        chapters: [],
        pageCount: 0,
        pageIndex: 1,
        pageTitle: "",
        gate
      };
    },
    // The first call reuses fetchMeta's player response; a later one (signed
    // URLs expire) refetches the responses. A failed /next only costs the chapters.
    async fetchTracks(ref, meta, io) {
      const cache = ytPlayerCache(ref);
      if (cache.resolved) cache.responses = {};
      cache.resolved = true;
      const tracks = await ytResolveTracks(ref, io);
      const next = io.postJson ? await ytNextResponse(ref, io, true).catch(() => null) : null;
      return { tracks: ytWithTranslation(tracks, io.subtitleLang), chapters: ytChapters(next) };
    },
    // Raw is the timedtext body text, or the transcript pages as fetched.
    async fetchRaw(track, io) {
      if (ytIsTranscriptUrl(track.url)) {
        return (await ytFetchTranscript(parseUrl(track.url).searchParams.get("params"), io)).responses;
      }
      return io.fetchText(track.url);
    },
    parseSegments(raw) {
      return Array.isArray(raw) ? raw.flatMap(ytParseTranscript) : normalizeSegments(parseYoutubeSubtitle(raw));
    },
    // The watch page's own transcript panel, fetched with the user's cookies.
    // Only a fallback: it is the same endpoint family as timedtext for rate
    // limiting, and its language is whatever YouTube picks. Resolves
    // { track, raw }; the track re-selects through fetchRaw.
    async fetchTranscript(ref, io) {
      const params = ytTranscriptParams(await ytNextResponse(ref, io));
      if (!params) {
        throw new Error("该视频没有文字稿");
      }
      const { responses, language } = await ytFetchTranscript(params, io);
      if (!responses.flatMap(ytParseTranscript).length) {
        throw new Error("文字稿为空");
      }
      return {
        track: {
          id: "transcript",
          lang: "",
          label: language ? `${language}（文字稿）` : "文字稿（默认语言）",
          url: `${YT_TRANSCRIPT_URL}?params=${encodeURIComponent(params)}`,
          kind: "transcript",
          isDefault: false
        },
        raw: responses
      };
    },
    // Same two /next calls the watch page makes, the first shared with fetchTracks.
    async fetchComments(ref, meta, io, count = 20) {
      if (!io.postJson || !count) {
        return [];
      }
      const token = ytCommentsToken(await ytNextResponse(ref, io));
      if (!token) {
        return [];
      }
      let response = await ytPost(io, "next", { continuation: token });
      const topToken = ytTopSortToken(response);
      if (topToken) {
        response = await ytPost(io, "next", { continuation: topToken });
      }
      return ytParseComments(response).slice(0, count);
    },
    embedHtml(ref) {
      return `<iframe src="https://www.youtube.com/embed/${encodeURIComponent(ref.id)}" title="YouTube video player" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen style="height:100%;width:100%; aspect-ratio: 16 / 9;"></iframe>`;
    },
    readDom(doc) {
      return {
        title:
          readMetaContent(doc, 'meta[property="og:title"]') ||
          readText(doc, "h1.ytd-watch-metadata") ||
          String(doc?.title || "").replace(/ - YouTube$/, "").trim(),
        author: readMetaContent(doc, 'meta[itemprop="author"]') || readText(doc, "ytd-watch-metadata #channel-name a"),
        description: readMetaContent(doc, 'meta[property="og:description"]'),
        uploadDate: ""
      };
    },
    reader: {
      playerHost: ["#movie_player", ".html5-video-player"],
      playerLayout: ["#movie_player", ".html5-video-container", "ytd-player", "#player-container-inner", "#player-container", "#player"],
      // Theater mode and small windows (ytd-watch-flexy[full-bleed-player]) move
      // the player into #full-bleed-container, a flex row, and leave #player
      // empty; the transcript host goes after the row, not inside it, or it
      // takes the row's width from the player.
      playerWrap: ["#player-container-outer", "#full-bleed-container", "#player"],
      miniPlayer: ["ytd-miniplayer[active]"],
      miniClose: [".ytp-miniplayer-close-button"],
      endingPanel: [],
      controls: [],
      noCursorClass: "",
      sendingBar: "",
      title: ["h1.ytd-watch-metadata"],
      keepRoots: ["#movie_player", "#player", "ytd-watch-metadata", "h1.ytd-watch-metadata"],
      noise: ["#secondary", "#comments", "ytd-merch-shelf-renderer", "#masthead-ad", "ytd-ad-slot-renderer"],
      cards: ["ytd-compact-video-renderer", "ytd-rich-item-renderer"],
      ignoredVideo: ["ytd-compact-video-renderer", "ytd-rich-item-renderer", "#inline-preview-player", "ytd-video-preview"],
      subtitleControlRoots: ["#movie_player .ytp-chrome-bottom", "#movie_player"],
      aiQuickActionHosts: ["#movie_player", "#player"]
    }
  };

  // Loose duration guard shared by the video page and the side panel: rejects a body that runs past the
  // video or covers too little of a long one (another video's subtitle). Triage keeps its stricter check.
  function validateSubtitleByDuration(body, videoDuration) {
    const duration = Number(videoDuration || 0);
    if (!Array.isArray(body) || body.length === 0) {
      return { ok: false, reason: "empty", videoDuration: duration, maxTo: 0 };
    }

    let maxTo = 0;
    for (const item of body) {
      const to = Number(item?.to);
      const from = Number(item?.from);
      if (Number.isFinite(to) && to > maxTo) {
        maxTo = to;
      }
      if (Number.isFinite(from) && from > maxTo) {
        maxTo = from;
      }
    }

    if (!(duration > 0)) {
      return { ok: true, reason: "skip-no-video-duration", videoDuration: duration, maxTo };
    }

    const upperTolerance = Math.max(12, duration * 0.15);
    if (maxTo > duration + upperTolerance) {
      return { ok: false, reason: "too-long", videoDuration: duration, maxTo };
    }

    let minCoverageRatio = 0;
    if (duration >= 600) {
      minCoverageRatio = 0.18;
    } else if (duration >= 300) {
      minCoverageRatio = 0.22;
    } else if (duration >= 180) {
      minCoverageRatio = 0.25;
    }

    if (minCoverageRatio > 0 && maxTo < duration * minCoverageRatio) {
      return { ok: false, reason: "too-short", videoDuration: duration, maxTo };
    }

    return { ok: true, reason: "ok", videoDuration: duration, maxTo };
  }

  // ----------------------------------------------------------- subtitle cache

  // chrome.storage.local entries { raw, timestamp } shared by the video page, side panel and triage.
  // They hold the raw response and are parsed on read, so a parser fix applies to them; entries
  // written before that (parsed body, no raw) miss.
  function subtitleCacheKey({ videoId, cid, subtitleId = "", subtitleUrl = "", lang = "" }) {
    const id = String(subtitleId || "").trim();
    const urlKey = trackUrlKey(subtitleUrl);
    const source = id ? `id_${id}` : urlKey ? `url_${urlKey}` : `lang_${String(lang || "").trim().toLowerCase() || "unknown"}`;
    return `${BocLimits.KEYS.subtitleCachePrefix}${videoId}_${cid}_${source}`;
  }

  async function loadSubtitleCache(key) {
    try {
      return (await chrome.storage.local.get(key))[key]?.raw ?? null;
    } catch {
      return null;
    }
  }

  // Keeps only recent entries; the caps live in limits.js.
  async function saveSubtitleCache(key, raw) {
    try {
      const now = Date.now();
      await chrome.storage.local.set({ [key]: { raw, timestamp: now } });
      // getKeys (Chrome 130+) avoids reading every stored value just to find the cache keys.
      const keys = chrome.storage.local.getKeys
        ? (await chrome.storage.local.getKeys()).filter((k) => k.startsWith(BocLimits.KEYS.subtitleCachePrefix))
        : null;
      const all = await chrome.storage.local.get(keys);
      const stale = Object.entries(all)
        .filter(([k]) => k.startsWith(BocLimits.KEYS.subtitleCachePrefix))
        .sort(([, a], [, b]) => (Number(b?.timestamp) || 0) - (Number(a?.timestamp) || 0))
        .filter(([, value], index) => index >= BocLimits.SUBTITLE_CACHE_ENTRIES || now - (Number(value?.timestamp) || 0) > BocLimits.SUBTITLE_CACHE_DAYS * 86400000)
        .map(([k]) => k);
      if (stale.length) {
        await chrome.storage.local.remove(stale);
      }
    } catch (error) {
      console.warn("[BOC] failed to save subtitle cache", error);
    }
  }

  async function removeSubtitleCache(key) {
    try {
      await chrome.storage.local.remove(key);
    } catch {}
  }

  // A cached body that accept() rejects is fetched again; only an accepted body is cached.
  async function fetchRawCached(site, track, { videoId, cid }, io, accept = (body) => body.length > 0) {
    const key = subtitleCacheKey({ videoId, cid, subtitleId: track.id, subtitleUrl: track.url, lang: track.lang });
    const cached = await loadSubtitleCache(key);
    if (cached !== null && accept(site.parseSegments(cached))) {
      return cached;
    }
    const raw = await site.fetchRaw(track, io);
    if (accept(site.parseSegments(raw))) {
      await saveSubtitleCache(key, raw);
    }
    return raw;
  }

  // ----------------------------------------------------------------- registry

  const SITES = { bilibili, youtube };

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
    normalizeSubtitleLang,
    pickPreferredTrack,
    trackUrlKey,
    subtitleCache: { key: subtitleCacheKey, load: loadSubtitleCache, save: saveSubtitleCache, remove: removeSubtitleCache },
    validateSubtitleByDuration,
    fetchRawCached,
    biliMixinKey,
    biliWbiSign,
    normalizeChapters,
    parseChaptersFromDescription,
    decodeXmlEntities,
    parseSrv3,
    parseJson3,
    ytChapters,
    ytTranscriptParams,
    ytParseTranscript,
    ytPotFromUrls,
    ytCaptionUrl
  };
})();
