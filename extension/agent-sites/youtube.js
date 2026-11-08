// YouTube for the agent interface (docs/AGENT.md §5). The content script (agent-page.js) reads its watch pages; the
// user's collections (list / has / write) are youtubei calls made in the bridge's own tab, in a youtube.com page's own
// world, the way YouTube's web client makes them (ytApi). A service worker fetch cannot: it sends the extension's Origin,
// and Origin cannot be set from fetch.
(() => {
  const HOME = "https://www.youtube.com/";
  const VIDEO_ID = /^[\w-]{11}$/;
  const PLAYLIST_ID = /^[\w-]{2,64}$/;
  const fail = (message, code) => Object.assign(new Error(message), code ? { code } : {});

  // --- in the page (serialized by chrome.scripting: no closures, no extension globals) --------------------------------

  const ytReady = () => (window.ytcfg?.get?.("INNERTUBE_CONTEXT") ? { ok: true } : undefined);

  // One youtubei POST with the headers yt-dlp's generate_api_headers and _get_sid_authorization_header build:
  // SAPISIDHASH = `${ts}_${sha1(`${userSessionId} ${ts} ${SAPISID} ${origin}`)}_u` ("u" parts only with a user session id).
  // → { status, url, json } or { status: 0, error }; { status: 401, loggedOut } without a login.
  async function ytApi(endpoint, body, ms = 10_000) {
    try {
      const cfg = window.ytcfg;
      const cookie = (n) => document.cookie.split("; ").find((c) => c.startsWith(`${n}=`))?.slice(n.length + 1);
      const sids = [["SAPISIDHASH", cookie("SAPISID") || cookie("__Secure-3PAPISID")], ["SAPISID1PHASH", cookie("__Secure-1PAPISID")], ["SAPISID3PHASH", cookie("__Secure-3PAPISID")]];
      if (!cfg.get("LOGGED_IN") || !sids.some(([, sid]) => sid)) return { status: 401, loggedOut: true };
      // DATASYNC_ID is "DELEGATED||USER", or "USER||" without a brand account.
      const [a = "", b = ""] = String(cfg.get("DATASYNC_ID") || "").split("||");
      const user = cfg.get("USER_SESSION_ID") || b || a;
      const delegated = cfg.get("DELEGATED_SESSION_ID") || (b ? a : "");
      const ts = String(Math.round(Date.now() / 1000));
      const auth = [];
      for (const [scheme, sid] of sids) {
        if (!sid) continue;
        const bytes = await crypto.subtle.digest("SHA-1", new TextEncoder().encode([...(user ? [user] : []), ts, sid, location.origin].join(" ")));
        const hash = Array.from(new Uint8Array(bytes), (x) => x.toString(16).padStart(2, "0")).join("");
        auth.push(`${scheme} ${[ts, hash, ...(user ? ["u"] : [])].join("_")}`);
      }
      const context = cfg.get("INNERTUBE_CONTEXT");
      const headers = {
        "Content-Type": "application/json",
        Authorization: auth.join(" "),
        "X-Origin": location.origin,
        "X-Goog-AuthUser": String(cfg.get("SESSION_INDEX") ?? 0),
        "X-Youtube-Client-Name": String(cfg.get("INNERTUBE_CONTEXT_CLIENT_NAME") ?? 1),
        "X-Youtube-Client-Version": String(context.client?.clientVersion || ""),
        "X-Youtube-Bootstrap-Logged-In": "true"
      };
      if (delegated) headers["X-Goog-PageId"] = delegated;
      if (context.client?.visitorData) headers["X-Goog-Visitor-Id"] = context.client.visitorData;
      const res = await fetch(`${location.origin}/youtubei/v1/${endpoint}?prettyPrint=false`, {
        method: "POST", credentials: "include", headers, body: JSON.stringify({ context, ...body }), signal: AbortSignal.timeout(ms)
      });
      let json = null;
      try { json = JSON.parse(await res.text()); } catch {}
      return { status: res.status, url: res.url, json };
    } catch (e) {
      return { status: 0, error: String(e?.message || e) };
    }
  }

  // --- in the worker -------------------------------------------------------------------------------------------------

  // ytApi's answer → its JSON, or a coded error: 429, Google's /sorry/ captcha page and 403 are THROTTLED (stop).
  function checked(d) {
    if (!d || d.status === 0) throw fail(`YouTube did not answer${d?.error ? `: ${d.error}` : ""}.`, "NETWORK");
    if (d.status === 429 || d.status === 403 || /\/sorry\//.test(d.url || "")) throw fail(`${MdgErrors.TEXT.ytThrottled} (HTTP ${d.status}).`, MdgErrors.CODE.THROTTLED);
    if (d.status === 401 || d.loggedOut) throw fail("Not logged in to YouTube in that browser.", MdgErrors.CODE.NOT_LOGGED_IN);
    if (d.status < 200 || d.status >= 300 || !d.json) throw fail(`YouTube answered HTTP ${d.status}.`);
    return d.json;
  }

  async function api(endpoint, body, deadline) {
    // Each request ends by the call's deadline (at most 10 s), so the server never gives up first.
    const ms = Math.max(1000, Math.min(10_000, deadline - Date.now()));
    const r = await MdgAgentBridge.inSitePage(MdgAgentSites.get("youtube"), HOME, ytReady, ytApi, [endpoint, body, ms], deadline);
    if (!r.ok) throw fail(r.error, r.code);
    return checked(r.data);
  }

  const text = (t) => t?.simpleText ?? t?.content ?? (t?.runs || []).map((r) => r.text).join("");

  // Every object under one of these keys, in document order, not looking inside a hit. Walking the whole answer
  // instead of a fixed path survives YouTube moving its shelves and tabs around.
  function find(node, keys, out = []) {
    if (Array.isArray(node)) for (const x of node) find(x, keys, out);
    else if (node && typeof node === "object") {
      for (const [k, v] of Object.entries(node)) {
        if (keys.includes(k) && v && typeof v === "object") out.push([k, v]);
        else find(v, keys, out);
      }
    }
    return out;
  }

  const lockupMeta = (v) => v.metadata?.lockupMetadataViewModel || {};
  const lockupParts = (v) => (lockupMeta(v).metadata?.contentMetadataViewModel?.metadataRows || []).flatMap((r) => r.metadataParts || []).map((p) => text(p.text));

  // Videos of a playlist (playlistVideoRenderer), history (videoRenderer, lockupViewModel).
  function videos(json) {
    return find(json, ["playlistVideoRenderer", "videoRenderer", "lockupViewModel"]).flatMap(([k, v]) => {
      if (k === "lockupViewModel") {
        if (v.contentType !== "LOCKUP_CONTENT_TYPE_VIDEO" || !v.contentId) return [];
        return [{ videoId: v.contentId, url: `https://www.youtube.com/watch?v=${v.contentId}`, title: text(lockupMeta(v).title), author: lockupParts(v)[0] || "", duration: 0 }];
      }
      if (!v.videoId) return [];
      return [{
        videoId: v.videoId,
        url: `https://www.youtube.com/watch?v=${v.videoId}`,
        title: text(v.title),
        author: text(v.shortBylineText || v.ownerText || v.longBylineText),
        duration: Number(v.lengthSeconds) || Math.max(0, MdgCommon.parseTimestamp(text(v.lengthText))) || 0,
        ...(v.isPlayable === false && { unavailable: true })
      }];
    });
  }

  function playlists(json) {
    return find(json, ["gridPlaylistRenderer", "playlistRenderer", "lockupViewModel"]).flatMap(([k, v]) => {
      if (k === "lockupViewModel") {
        return v.contentType === "LOCKUP_CONTENT_TYPE_PLAYLIST" && v.contentId ? [{ id: v.contentId, title: text(lockupMeta(v).title) }] : [];
      }
      const count = parseInt(String(v.videoCount ?? text(v.videoCountShortText || v.videoCountText)).replace(/\D/g, ""), 10);
      return v.playlistId ? [{ id: v.playlistId, title: text(v.title), ...(Number.isFinite(count) && { count }) }] : [];
    });
  }

  const channels = (json) =>
    find(json, ["channelRenderer"]).flatMap(([, v]) => (v.channelId ? [{ channelId: v.channelId, url: `https://www.youtube.com/channel/${v.channelId}`, title: text(v.title) }] : []));

  // The next page's token: the continuationItemRenderer's continuationCommand, "" at the end.
  const cursorOf = (json) => find(find(json, ["continuationItemRenderer"]), ["continuationCommand"])[0]?.[1].token || "";

  // The Save dialog's list (playlist/get_add_to_playlist): the user's own playlists, Watch later (WL) included, and
  // whether each holds the video.
  const saved = (json) => new Map(find(json, ["playlistAddToOptionRenderer"]).map(([, v]) => [v.playlistId, v.containsSelectedVideos === "ALL"]));

  // kind → browseId and parser; "playlist" takes the id.
  const LISTS = {
    watch_later: ["VLWL", videos],
    playlist: [null, videos],
    likes: ["VLLL", videos],
    playlists: ["FEplaylist_aggregation", playlists],
    subscriptions: ["FEchannels", channels],
    history: ["FEhistory", videos]
  };

  const playlistOf = (kind, id) => {
    if (kind === "watch_later") return "WL";
    const p = String(id ?? "").replace(/^VL/, "");
    if (!PLAYLIST_ID.test(p)) throw fail("id must be a playlist id (from list_collection kind playlists).");
    return p;
  };

  async function list({ kind, id, cursor }, deadline) {
    const [browseId, parse] = LISTS[kind];
    const body = cursor ? { continuation: cursor } : { browseId: browseId || `VL${playlistOf(kind, id)}` };
    const json = await api("browse", body, deadline);
    return { items: parse(json), cursor: cursorOf(json) };
  }

  async function has({ kind, id, item }, deadline) {
    if (!VIDEO_ID.test(item)) throw fail(`${item} is not a YouTube video id.`);
    const pl = playlistOf(kind, id);
    const map = saved(await api("playlist/get_add_to_playlist", { videoIds: [item], excludeWatchLater: false }, deadline));
    if (!map.has(pl)) throw fail(`${pl} is not one of the user's own playlists.`);
    return map.get(pl);
  }

  async function write({ op, kind, id, item }, deadline) {
    const action = op === "add" ? { action: "ACTION_ADD_VIDEO", addedVideoId: item } : { action: "ACTION_REMOVE_VIDEO_BY_VIDEO_ID", removedVideoId: item };
    await api("browse/edit_playlist", { playlistId: playlistOf(kind, id), actions: [action] }, deadline);
  }

  MdgAgentSites.register({
    id: "youtube",
    origins: ["*://*.youtube.com/*"],
    key(u) {
      const v = u.searchParams.get("v");
      return u.hostname.replace(/^www\./, "") === "youtube.com" && u.pathname === "/watch" && v ? `${v}:` : null;
    },
    // youtu.be, /shorts/, /live/, m. and music.youtube.com: the watch page, where the content script runs.
    canonical(u) {
      const h = u.hostname.replace(/^(www|m|music)\./, "");
      const v = h === "youtu.be" ? u.pathname.split("/")[1]
        : h !== "youtube.com" ? null
        : u.pathname === "/watch" ? (u.hostname === "www.youtube.com" ? null : u.searchParams.get("v"))
        : /^\/(?:shorts|live)\/([\w-]{11})\/?$/.exec(u.pathname)?.[1];
      return v ? `https://www.youtube.com/watch?v=${encodeURIComponent(v)}` : null;
    },
    read: "content",
    search: (query, page) => MdgAgentSearch.searchYt(query, page),
    // Likes and subscriptions are read only: like/removelike and subscribe are other endpoints, not built.
    collections: { watch_later: ["add", "remove"], playlist: ["add", "remove"], playlists: [], likes: [], subscriptions: [], history: [] },
    list,
    has,
    write,
    test: { ytApi, ytReady, checked, videos, playlists, channels, cursorOf, saved }
  });
})();
