// Douyin (抖音) for the agent interface (docs/AGENT.md §5). The page's server render carries no video data, so read asks
// the page's own API, /aweme/v1/web/aweme/detail/, by XHR from inside the page: the page's security SDK signs it
// (a_bogus, x-secsdk-web-signature) as it signs the page's own calls. Most videos have no subtitle track; read returns
// the play URL for transcription instead.
MdgAgentSites.register({
  id: "douyin",
  origins: ["https://www.douyin.com/*"],
  key(u) {
    if (u.hostname !== "www.douyin.com") return null;
    // /video/<id>, or a video opened over another page (/jingxuan, /user/…, /discover) as ?modal_id=<id>.
    const id = /^\/video\/(\d+)\/?$/.exec(u.pathname)?.[1] || u.searchParams.get("modal_id");
    return /^\d+$/.test(id || "") ? `${id}:` : null;
  },
  // An arrow, not a method: executeScript serializes it as "(" + source + ")", which a method's source is not.
  read: async (url) => {
    const u = new URL(url);
    const id = /^\/video\/(\d+)/.exec(u.pathname)?.[1] || u.searchParams.get("modal_id");
    const throttled = (why) => ({ error: `Douyin ${why}: stop, do not retry soon.`, code: "THROTTLED" });
    if (document.getElementById("captcha_container") || /验证码/.test(document.title)) return throttled("asks for a verification (captcha)");
    // Ready once the app has made its own API calls (the SDK that signs them is loaded); before that the anti-bot
    // challenge page (no RENDER_DATA) may still be reloading itself.
    const booted = document.getElementById("RENDER_DATA") && performance.getEntriesByType("resource").some((e) => e.name.includes("/aweme/v1/web/"));
    if (!booted) return null;
    // read is asked every 0.5 s while it returns null: at most 3 requests per page, 3 s apart.
    const st = (window.__mdgDouyinRead ||= { tries: 0, at: 0 });
    if (Date.now() - st.at < 3000) return null;
    if (st.tries >= 3) return throttled("answers empty (anti-bot)");
    st.tries++;
    st.at = Date.now();
    const r = await new Promise((res) => {
      const x = new XMLHttpRequest();
      x.open("GET", `/aweme/v1/web/aweme/detail/?device_platform=webapp&aid=6383&channel=channel_pc_web&aweme_id=${id}`);
      x.timeout = 15000;
      x.onload = () => res({ status: x.status, text: x.responseText });
      x.onerror = x.ontimeout = () => res({ status: 0, text: "" });
      x.send();
    });
    if (r.status === 403 || r.status === 412 || r.status === 429) return throttled(`answered ${r.status}`);
    if (!r.text) return null; // empty 200: the SDK had not signed it; asked again
    let j;
    try { j = JSON.parse(r.text); } catch { return throttled("answered a verify page"); }
    if (j.verify_ticket) return throttled("asks for a verification (verify_ticket)");
    const d = j.aweme_detail;
    if (!d) {
      const why = j.filter_detail?.filter_reason || j.filter_detail?.detail_msg || j.status_msg || j.status_code;
      return { error: `Douyin does not show this video${why ? ` (${why})` : ""}.` };
    }

    const v = d.video || {};
    const t = new Date(Number(d.create_time) * 1000);
    const p = (n) => String(n).padStart(2, "0");
    const s = d.statistics || {};
    const n = (x) => (typeof x === "number" ? x : null);
    const text = (x) => (typeof x === "string" ? x.trim() : "");
    const desc = text(d.desc);
    // caption and the OCR'd on-screen text, when Douyin has them, say what the video says; desc is often hashtags.
    const extra = [text(d.caption) !== desc && text(d.caption), text(d.seo_info?.ocr_content) && `画面文字: ${text(d.seo_info.ocr_content)}`];
    const playUrl = v.play_addr?.url_list?.[0] || "";
    return {
      url,
      videoId: String(d.aweme_id || id),
      title: text(d.item_title) || text(d.preview_title) || desc.split("\n")[0].slice(0, 100),
      author: d.author?.nickname || "",
      uploadDate: Number(d.create_time) > 0 ? `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}` : "",
      description: [desc, ...extra].filter(Boolean).join("\n\n"),
      duration: Math.round((Number(v.duration) || Number(d.duration) || 0) / 1000),
      part: { index: 1, count: 0, title: "" },
      chapters: [],
      subtitle: {
        segments: [], lang: "", warning: "",
        missing: playUrl ? "Douyin has no subtitle for this video; transcribe playUrl (raw JSON; send Referer https://www.douyin.com/, it expires)" : "Douyin has no subtitle for this video"
      },
      // The detail's comment_list is null (logged out, 2026-11) and read makes no comment API call.
      comments: [],
      // play_count is 0 on the web (hidden), so it reads as unknown.
      stats: { views: s.play_count || null, likes: n(s.digg_count), comments: n(s.comment_count), shares: n(s.share_count), saves: n(s.collect_count) },
      playUrl
    };
  }
});
