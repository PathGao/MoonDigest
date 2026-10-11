// Tag rules shared by 分拣台 (triage/shared.js, follow.js) and the 「+」 picker on B站 pages (badges.js), and the AI
// verdict (分拣台, B站 pages, the background and every note with a triage summary). Pure functions, no DOM: badges.js
// runs in a closed shadow root that cannot use triage's UI, so this is the one copy all of them load first.
(() => {
  // Catppuccin Latte accents (desaturated); chips keep --text on top, so these are only borders and tints.
  // Mauve, blue, green, red and yellow are left out: they mean where-you-are, next step, keep, delete and pending.
  const TAG_COLORS = ["#da86c3", "#298287", "#dc6d2d", "#3590a0", "#8595ea", "#cf5c66", "#2497c6", "#cf8686", "#ce9386"];
  // A tag name as both modes and the AI keep it: no commas or 顿号 (the CSV joins names with 、), trimmed, at most 12
  // characters. The background worker loads this file too (background.js), so its AI suggestions are cleaned alike.
  const cleanTagName = (s) => String(s ?? "").replace(/[,，、]/g, "").trim().slice(0, 12);
  // A new tag's color: the first one no tag in the list has, so deleting a tag frees its color.
  const nextTagColor = (tags) => TAG_COLORS.find((c) => !tags.some((t) => t.color === c)) || TAG_COLORS[tags.length % TAG_COLORS.length];
  // 管理's color button: the next color in the palette.
  const cycleTagColor = (color) => TAG_COLORS[(TAG_COLORS.indexOf(color) + 1) % TAG_COLORS.length];
  // A new tag's id; 关注's (UP) tags use the prefix "ft".
  const newTagId = (prefix) => `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  // The AI's three fixed classes; the ids are also CSS color classes.
  const VERDICTS = Object.freeze({ keep: "值得留", drop: "可清理", unsure: "拿不准" });
  // A video's verdict, the same on 分拣台 and B站 pages: a done 细看 (an unknown verdict counts as 拿不准) over the 粗分
  // result (one with an unknown verdict, left from the old custom tiers, counts as not classified, so 粗分 can run
  // again). An invalid video is 可清理 whatever the AI said, but keeps the AI's reason and step after the 已失效 note.
  // verdict: keep / drop / unsure, or "none"; stage: 2 细看, 1 粗分, 0 only invalid, -1 none.
  function verdictOf({ title, analysis, invalid } = {}) {
    let v = { verdict: "none", reason: "", stage: -1 };
    if (analysis?.status === "done") v = { verdict: VERDICTS[analysis.verdict] ? analysis.verdict : "unsure", reason: analysis.reason, stage: 2 };
    else if (VERDICTS[title?.verdict]) v = { verdict: title.verdict, reason: title.reason, stage: 1, low: title.confidence === "low" };
    if (!invalid) return v;
    return { verdict: "drop", reason: v.reason ? `视频已失效。AI 原理由：${v.reason}` : "视频已失效", stage: Math.max(v.stage, 0) };
  }

  globalThis.MdgTagCore = { TAG_COLORS, cleanTagName, nextTagColor, cycleTagColor, newTagId, VERDICTS, verdictOf };
})();
