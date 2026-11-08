// TikTok for the agent interface (docs/AGENT.md §5). read runs in the video page and reads the server-rendered
// __UNIVERSAL_DATA_FOR_REHYDRATION__ (field names as in yt-dlp's tiktok extractor), plus one WebVTT subtitle file.
MdgAgentSites.register({
  id: "tiktok",
  origins: ["https://www.tiktok.com/*"],
  key(u) {
    const m = /^\/@[^/]*\/video\/(\d+)\/?$/.exec(u.pathname);
    return u.hostname === "www.tiktok.com" && m ? `${m[1]}:` : null;
  },
  read: async (url) => {
    const id = /\/video\/(\d+)/.exec(new URL(url).pathname)[1];
    if (document.querySelector("#captcha_container, #captcha-verify-container-main-page, .captcha_verify_container")) {
      return { error: "TikTok asks for a verification (captcha): stop, do not retry soon.", code: "THROTTLED" };
    }
    const el = document.getElementById("__UNIVERSAL_DATA_FOR_REHYDRATION__");
    const detail = el && JSON.parse(el.textContent).__DEFAULT_SCOPE__?.["webapp.video-detail"];
    if (!detail) return null; // a challenge page that reloads itself, or not loaded yet
    const it = detail.itemInfo?.itemStruct;
    if (!it || it.id !== id) {
      // 10204 is a deleted, private or geo-fenced video (statusMsg says which).
      return detail.statusCode ? { error: `TikTok does not show this video (${detail.statusMsg || detail.statusCode}).` } : null;
    }

    const v = it.video || {};
    // WebVTT only (creator_caption is TikTok's own JSON); the video's own language first, machine translations last.
    const orig = v.claInfo?.originalLanguageInfo?.language;
    const rank = (s) => (s.Source === "MT" ? 2 : 0) + (s.LanguageCodeName === orig ? 0 : 1);
    const track = (v.subtitleInfos || []).filter((s) => s.Url && s.Format === "webvtt").sort((a, b) => rank(a) - rank(b))[0];
    const subtitle = { segments: [], lang: "", warning: "", missing: "" };
    if (track) {
      const res = await fetch(track.Url).catch(() => null);
      const text = res && res.ok ? await res.text() : "";
      const sec = (t) => t.split(":").reduce((a, x) => a * 60 + parseFloat(x), 0);
      for (const block of text.replace(/\r/g, "").split(/\n{2,}/)) {
        const lines = block.split("\n");
        const i = lines.findIndex((l) => l.includes("-->"));
        if (i < 0) continue;
        const [from, to] = lines[i].split("-->").map((s) => sec(s.trim().split(/\s/)[0]));
        const content = lines.slice(i + 1).join(" ").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
        if (content) subtitle.segments.push({ from, to, content });
      }
      subtitle.lang = track.LanguageCodeName || "";
      if (!subtitle.segments.length) subtitle.missing = `the ${subtitle.lang} subtitle file did not load`;
    } else {
      subtitle.missing = "TikTok has no subtitle for this video; transcribe the media URL (playUrl) instead";
    }

    const t = new Date(Number(it.createTime) * 1000);
    const p = (n) => String(n).padStart(2, "0");
    const s = it.stats || {};
    const n = (x) => (x == null || x === "" ? null : Number(x));
    return {
      url,
      videoId: id,
      title: String(it.desc || "").split("\n")[0].slice(0, 100),
      author: it.author?.nickname || it.author?.uniqueId || "",
      uploadDate: Number(it.createTime) > 0 ? `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}` : "",
      description: it.desc || "",
      duration: Number(v.duration) || 0,
      part: { index: 1, count: 0, title: "" },
      chapters: [],
      subtitle,
      comments: [],
      stats: { views: n(s.playCount), likes: n(s.diggCount), comments: n(s.commentCount), shares: n(s.shareCount), saves: n(s.collectCount) },
      playUrl: v.playAddr || ""
    };
  }
});
