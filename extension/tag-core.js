// Tag rules shared by 分拣台 (triage/shared.js, follow.js) and the 「+」 picker on B站 pages (badges.js), and the AI
// verdict (分拣台, B站 pages, the background and every note with a triage summary). Pure functions, no DOM: badges.js
// runs in a closed shadow root that cannot use triage's UI, so this is the one copy all of them load first.
(() => {
  // Catppuccin Latte accents (desaturated); chips keep --text on top, so these are only borders and tints.
  // Mauve, blue, green, red and yellow are left out: they mean where-you-are, next step, keep, delete and pending.
  const TAG_COLORS = ["#da86c3", "#298287", "#dc6d2d", "#3590a0", "#8595ea", "#cf5c66", "#2497c6", "#cf8686", "#ce9386"];
  // A tag name as both modes and the AI keep it: no commas or 顿号 (the CSV joins names with 、), trimmed, at most
  // TAG_NAME_MAX characters (every tag name box's maxlength). The background worker loads this file too (background.js),
  // so its AI suggestions are cleaned alike.
  const TAG_NAME_MAX = 12;
  const cleanTagName = (s) => String(s ?? "").replace(/[,，、]/g, "").trim().slice(0, TAG_NAME_MAX);
  // A new tag's color: the first one no tag in the list has, so deleting a tag frees its color.
  const nextTagColor = (tags) => TAG_COLORS.find((c) => !tags.some((t) => t.color === c)) || TAG_COLORS[tags.length % TAG_COLORS.length];
  // 管理's color button: the next color in the palette.
  const cycleTagColor = (color) => TAG_COLORS[(TAG_COLORS.indexOf(color) + 1) % TAG_COLORS.length];
  // A new tag's id; 关注's (UP) tags use the prefix "ft".
  const newTagId = (prefix) => `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  // A new UP tag (关注's follow_tags; B站 pages' 「+ UP 标签」 makes the same).
  const newUpTag = (name, tags) => ({ id: newTagId("ft"), name, color: nextTagColor(tags), rule: "" });
  // Why no new UP tag can be made: there are MdgLimits.UP_TAGS already ("" while there is room).
  const upTagsFull = (tags) => (tags.length >= MdgLimits.UP_TAGS ? `已经有 ${tags.length} 个 UP 标签了，先在分拣台「关注」的「标签管理」里删掉不用的` : "");
  // One change to one UP's tags (B站 pages' 「+ UP 标签」, written by the background): { toggle: tagId }, or
  // { create: name } which reuses a tag of that name, else makes one while upTagsFull allows, and switches it on.
  // { tags, map, id } to write; { why } when the tag cannot be made; null when nothing changes.
  function applyUpTag(tags, map, mid, op) {
    tags = Array.isArray(tags) ? tags : [];
    map = { ...(map || {}) };
    let id = op.toggle;
    const create = op.create != null;
    if (create) {
      const name = cleanTagName(op.create);
      if (!name) return null;
      let t = tags.find((x) => x.name === name);
      if (!t) {
        const why = upTagsFull(tags);
        if (why) return { why };
        t = newUpTag(name, tags);
        tags = [...tags, t];
      }
      id = t.id;
    } else if (!tags.some((x) => x.id === id)) return null;
    const ids = map[mid] || [];
    const next = ids.includes(id) ? (create ? ids : ids.filter((x) => x !== id)) : [...ids, id];
    if (next.length) map[mid] = next;
    else delete map[mid];
    return { tags, map, id };
  }

  // The AI's three fixed classes; the ids are also CSS color classes.
  const VERDICTS = Object.freeze({ keep: "值得留", drop: "可清理", unsure: "拿不准" });
  // The reason an invalid video is 可清理, and B站 pages' name for that step.
  const INVALID = MdgErrors.LABEL.videoGone;
  // A video's verdict, the same on 分拣台 and B站 pages: a done 细看 (an unknown verdict counts as 拿不准) over the 粗看
  // result (one with an unknown verdict, left from the old custom tiers, counts as not classified, so 粗看 can run
  // again). An invalid video is 可清理 whatever the AI said, but keeps the AI's reason and step after the 已失效 note.
  // verdict: keep / drop / unsure, or "none"; stage: 2 细看, 1 粗看, 0 only invalid, -1 none.
  function verdictOf({ title, analysis, invalid } = {}) {
    let v = { verdict: "none", reason: "", stage: -1 };
    if (analysis?.status === "done") v = { verdict: VERDICTS[analysis.verdict] ? analysis.verdict : "unsure", reason: analysis.reason, stage: 2 };
    else if (VERDICTS[title?.verdict]) v = { verdict: title.verdict, reason: title.reason, stage: 1, low: title.confidence === "low" };
    if (!invalid) return v;
    return { verdict: "drop", reason: v.reason ? `${INVALID}。AI 原理由：${v.reason}` : INVALID, stage: Math.max(v.stage, 0) };
  }

  globalThis.MdgTagCore = { TAG_COLORS, TAG_NAME_MAX, cleanTagName, nextTagColor, cycleTagColor, newTagId, newUpTag, upTagsFull, applyUpTag, VERDICTS, INVALID, verdictOf };
})();
