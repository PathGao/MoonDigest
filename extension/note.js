// Note builder shared by content.js (manifest js list), background.js (importScripts)
// and the extension pages (<script>). Pure: everything it reads arrives as arguments.
// Needs MdgLimits (limits.js), MdgSites (sites.js) and MdgSettings (settings.js) loaded first. Idempotent like sites.js.
//
// meta     the content-script state shape: title, site, videoId, cid, aid, author, authorUrl,
//          uploadDate, videoDuration, cover, videoTags, selectedSubtitleLang, description,
//          chapters, hotComments, pageIndex, pageCount, pageTitle
// body     Segment[] { from, to, content }
// ref      VideoRef from sites.js, or null; ref.url is the note's canonical URL
// settings the merged user settings (tags, frontmatterFields, include* flags, ...)
// meta.aiTurns  optional [{ prompt, answer }] from buildConversationTurns; written as the AI 问答 section
(() => {
  if (globalThis.MdgNote) {
    return;
  }

  const S = globalThis.MdgSettings;
  const { escapeHtml } = globalThis.MdgErrors;
  const DEFAULT_FRONTMATTER_FIELDS = S.DEFAULTS.frontmatterFields;
  // Every field a note can carry; DEFAULT_FRONTMATTER_FIELDS is the subset on by default.
  const FRONTMATTER_FIELDS = [...DEFAULT_FRONTMATTER_FIELDS, "video_tags"];

  const { localDate, fileName } = MdgCommon;

  function normalizeHotComments(comments) {
    return Array.isArray(comments) ? comments.map(MdgSites.cleanComment).filter((item) => item.message).slice(0, MdgLimits.HOT_COMMENTS) : [];
  }



  // The tags a note carries: the 笔记标签 setting, then meta.userTags (the 分拣台 tags; Obsidian tags take letters,
  // digits, _ - / only, so anything else becomes _). The popup's 详情 shows these, not the setting.
  function noteTags(meta, settings) {
    return [
      ...new Set([
        ...parseFrontmatterArrayItems(settings?.tags),
        ...(meta?.userTags || []).map((name) => String(name).trim().replace(/[^\p{L}\p{N}_\-/]+/gu, "_"))
      ])
    ].filter(Boolean);
  }

  function buildMarkdown(meta, body, settings, ref, created = localDate()) {
    // The on/off settings as MdgSettings reads them (a missing one is its default).
    const on = MdgSettings.normalizeSwitches(settings);
    const url = String(ref?.url || "");
    const tags = noteTags(meta, settings);
    const tagsCsv = tags.join(", ");
    const tagsYaml = yamlList(tags);

    const compactWithHours = shouldShowHoursInNote(meta, body);
    const chapterLines = buildChapterLines(meta.chapters || [], compactWithHours);
    const subtitleSectionLines = buildSubtitleSectionLines(
      body,
      meta.chapters || [],
      settings,
      compactWithHours
    );
    const frontMatter = buildFrontMatter(meta, settings, url, created, tagsCsv, tagsYaml);

    const embedIframe = (settings.playerEmbed !== false && ref && MdgSites.SITES[ref.site]?.embedHtml(ref, meta)) || "";
    const intro = String(meta.description || "").trim();
    const noteSectionContext = buildNotePlaceholderTemplateContext(meta, url, intro);
    const noteSections = groupNotePlaceholderSections(settings, noteSectionContext);

    const lines = [];
    if (frontMatter) {
      lines.push(frontMatter, "");
    }
    if (on.includeCoverInNote && meta.cover) {
      lines.push(`![cover](${meta.cover})`, "");
    }
    if (embedIframe) {
      lines.push(embedIframe, "");
    }
    const hasSubtitles = subtitleSectionLines.length > 0;
    const hotCommentLines = buildHotCommentLines(
      on.includeHotCommentsInNote || !hasSubtitles ? meta?.hotComments || [] : []
    );
    if (!hasSubtitles) {
      // Names only what the note goes on to show.
      const follows = [intro && "简介", hotCommentLines.length && "热门评论"].filter(Boolean).join("与");
      lines.push(`> ${MdgErrors.subtitleMissing(meta)}${follows ? `，以下为${follows}` : ""}。`, "");
    }
    lines.push(...noteSections.before_intro);

    if (intro) {
      lines.push("## 简介", "", intro, "");
    }

    lines.push(...noteSections.before_chapters);

    if (chapterLines.length > 0) {
      lines.push("## 章节", "", ...chapterLines, "");
    }

    lines.push(...noteSections.before_subtitle);
    if (hasSubtitles) {
      lines.push("## 字幕", "", ...subtitleSectionLines, "");
    }

    if (hotCommentLines.length > 0) {
      lines.push("## 热门评论", "", ...hotCommentLines);
    }

    const markdown = lines.join("\n").trimEnd();
    const aiSection = on.includeAiChatInNote ? buildAiSection(meta.aiTurns) : "";
    return aiSection ? `${markdown}\n\n${aiSection}` : markdown;
  }

  // ---- AI 问答 section: the side panel conversation inside the video note ----
  // The markers let a later save replace just this section; Obsidian's reading view hides them.
  const AI_SECTION_START = "<!-- moondigest:ai-start -->";
  const AI_SECTION_END = "<!-- moondigest:ai-end -->";

  function stripThinkBlocks(text) {
    return String(text || "")
      .replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, "")
      // An unclosed block only when the answer starts with it (still thinking); a <think> mentioned mid-answer stays.
      .replace(/^\s*<think\b[^>]*>[\s\S]*$/i, "")
      .replace(/<\/think>/gi, "")
      .replace(/^\s*<\/?think\b[^>]*>\s*$/gim, "")
      .trim();
  }

  const TIMESTAMP_PATTERN = /\b\d{1,3}:\d{2}(?::\d{2})?\b/g;
  const TIMESTAMP_INLINE_CODE_REST_PATTERN = /^[\s,，、;；:：\-–—~～至到]+$/;

  function isTimestampOnlyInlineCode(value) {
    const text = String(value || "").trim();
    if (!text) {
      return false;
    }
    TIMESTAMP_PATTERN.lastIndex = 0;
    const hasTimestamp = TIMESTAMP_PATTERN.test(text);
    TIMESTAMP_PATTERN.lastIndex = 0;
    if (!hasTimestamp) {
      return false;
    }
    const rest = text.replace(TIMESTAMP_PATTERN, "").trim();
    TIMESTAMP_PATTERN.lastIndex = 0;
    return !rest || TIMESTAMP_INLINE_CODE_REST_PATTERN.test(rest);
  }

  function unwrapTimestampInlineCode(text) {
    return String(text || "").replace(/`([^`\n]+)`/g, (_, content) =>
      isTimestampOnlyInlineCode(content) ? content : `\`${content}\``
    );
  }

  // Shifts headings down so an answer pasted under a "## " section keeps its outline, and
  // unwraps `09:15` so the timestamps stay plain text like the rest of the note.
  function normalizeMarkdownForSectionPaste(raw, baseLevel = 2) {
    const shift = Math.max(0, Number(baseLevel) || 0);
    const normalized = [];
    let inFence = false;

    String(raw || "").split("\n").forEach((line) => {
      if (/^\s*```/.test(line)) {
        inFence = !inFence;
        normalized.push(line);
        return;
      }
      if (inFence) {
        normalized.push(line);
        return;
      }
      const pasteLine = unwrapTimestampInlineCode(line);
      const headingMatch = pasteLine.match(/^(\s*)(#{1,6})(\s+.*)$/);
      if (!headingMatch) {
        normalized.push(pasteLine);
        return;
      }
      const [, indent, hashes, suffix] = headingMatch;
      // Markdown stops at six levels: deeper ones stay at six, under their parent.
      normalized.push(`${indent}${"#".repeat(Math.min(6, hashes.length + shift))}${suffix}`);
    });

    return normalized.join("\n");
  }

  // Pairs each user message with the assistant reply that follows it. Stored conversations hold
  // only user/assistant turns; the system prompt and video context never reach them.
  // baseLevel: heading shift for pasting under a note's ## heading; 0 keeps the answer's own headings.
  function buildConversationTurns(messages, baseLevel = 2) {
    const turns = [];
    let pendingPrompt = "";
    (Array.isArray(messages) ? messages : []).forEach((message) => {
      if (!message || typeof message.content !== "string") {
        return;
      }
      if (message.role === "user") {
        pendingPrompt = message.content.trim();
        return;
      }
      if (message.role === "assistant" && pendingPrompt) {
        const answer = normalizeMarkdownForSectionPaste(stripThinkBlocks(message.content), baseLevel).trim();
        if (answer) {
          turns.push({ prompt: pendingPrompt, answer });
        }
        pendingPrompt = "";
      }
    });
    return turns;
  }

  // The newest saved conversation of this video part or web page, as the side panel restores it (MdgSites.isConversationOf).
  function pickConversation(conversations, ref = {}) {
    const mine = (Array.isArray(conversations) ? conversations : []).filter((item) => MdgSites.isConversationOf(item, ref));
    return mine.sort((a, b) => (Number(b?.updatedAt) || 0) - (Number(a?.updatedAt) || 0))[0] || null;
  }

  function sanitizeMarkdownHeadingText(value) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .replace(/^#+\s*/, "")
      .trim() || "AI 问答";
  }

  function buildAiTurnLines(turns) {
    // The answers came shifted for a ## section; under the ### question they go one level deeper.
    return (Array.isArray(turns) ? turns : []).flatMap((turn) => [`### 问：${sanitizeMarkdownHeadingText(turn.prompt)}`, "", normalizeMarkdownForSectionPaste(String(turn.answer || "").trim(), 1), ""]);
  }

  // "" when there is nothing to write, so callers can test for a section.
  function buildAiSection(turns) {
    const body = buildAiTurnLines(turns);
    if (!body.length) {
      return "";
    }
    return [AI_SECTION_START, "## AI 问答", "", ...body, AI_SECTION_END].join("\n");
  }

  // Replaces the marked section of an existing note, or appends one; bytes outside the markers
  // are untouched, and running it twice with the same section yields the same note. The section is the first end after
  // the first start, paired with the nearest start before it: a start left behind by a deleted end must not swallow the
  // user's text up to the next end, and an end left behind by a deleted start is skipped, so the section appended once
  // is the one replaced from then on.
  function upsertAiSection(note, section) {
    const text = String(note || "");
    const end = text.indexOf(AI_SECTION_END, text.indexOf(AI_SECTION_START));
    const start = end >= 0 ? text.lastIndexOf(AI_SECTION_START, end) : -1;
    if (start >= 0 && end >= 0) {
      return `${text.slice(0, start)}${section}${text.slice(end + AI_SECTION_END.length)}`;
    }
    if (!section) {
      return text;
    }
    return `${text}${text.endsWith("\n") ? "" : "\n"}\n${section}\n`;
  }

  // Standalone AI notes from side panel conversations. context: a conversation's video ref
  // ({ title, url, site, videoId, author }). sourcePath: the video note's vault path, or "" when unknown.
  // Without a title: 无标题视频 and the id, so two untitled videos' AI 笔记 get two files (DESIGN 术语表).
  function aiSourceTitle(context) {
    return String(context?.title || "").trim() || [MdgErrors.TEXT.untitledVideo, context?.videoId].filter(Boolean).join(" ");
  }

  // Multi-P videos: each part's conversation is its own note, named and linked by part.
  function aiPartIndex(context) {
    return Number(context?.pageIndex) > 0 ? Number(context.pageIndex) : 1;
  }

  function buildAiConversationFilename(context) {
    const part = aiPartIndex(context);
    const partSuffix = part > 1 || Number(context?.pageCount) > 1 ? ` P${part}` : "";
    return `${fileName(`【AI笔记】${aiSourceTitle(context)}${partSuffix}`)}.md`;
  }

  // A wiki link's shown text: Obsidian has no escape inside [[…]], so brackets become their full-width forms. The
  // target is a vault path, whose names never hold them (fileName, sanitizeFolderTemplateValue).
  const wikiLinkText = (value) => String(value || "").replace(/\[/g, "［").replace(/\]/g, "］");

  // source: a wiki link to the video note (path without .md), so the AI note sits under it in the graph.
  // Body line: link the real video note when its path is known, else name the video without a dangling link.
  function sourceBodyLine(sourcePath, sourceTitle) {
    const target = String(sourcePath || "").replace(/\.md$/i, "");
    return target
      ? `来源：[[${target}|${wikiLinkText(sourceTitle)}]]`
      : `来源：${sourceTitle}`;
  }

  function sourceFrontmatterLine(sourcePath) {
    const target = String(sourcePath || "").replace(/\.md$/i, "");
    return target ? `source: "[[${escapeYaml(target)}]]"` : "";
  }

  // extras: triageExtras' userTags and starred (摘读记录's tags and 星标 go into the AI 笔记 too).
  function buildAiNoteFrontmatter({ context, filename, sourcePath, extras }) {
    const tags = noteTags(extras, {});
    return [
      "---",
      `title: "${escapeYaml(filename.replace(/\.md$/i, ""))}"`,
      `source_title: "${escapeYaml(aiSourceTitle(context))}"`,
      sourceFrontmatterLine(sourcePath),
      `url: "${escapeYaml(MdgSites.videoUrl(context || {}))}"`,
      context?.author ? `author: "${escapeYaml(context.author)}"` : "",
      `created: "${localDate()}"`,
      `tags: ${tags.length ? yamlList(["ai_note", ...tags]) : "[ai_note]"}`,
      extras?.starred ? "starred: true" : "",
      "---"
    ].filter(Boolean);
  }

  // A whole conversation; turns from buildConversationTurns.
  function buildAiConversationMarkdown({ context, turns, filename, sourcePath = "", extras }) {
    const lines = [...buildAiNoteFrontmatter({ context, filename, sourcePath, extras }), "", sourceBodyLine(sourcePath, aiSourceTitle(context))];
    turns.forEach((turn) => {
      lines.push("", `## ${sanitizeMarkdownHeadingText(turn.prompt)}`, "", turn.answer);
    });
    return `${lines.join("\n").trim()}\n`;
  }

  // The triage page's per-video analysis (triage_analysis_<bvid>) as Markdown; "" until it is done.
  const VERDICT_LINE = "AI 判断：";
  function buildTriageSummary(analysis) {
    if (analysis?.status !== "done") {
      return "";
    }
    const lines = [];
    if (analysis.oneLiner) lines.push(`> ${analysis.oneLiner}`, "");
    const points = (analysis.points || []).filter(Boolean);
    if (points.length) lines.push(...points.map((p) => `- ${p}`), "");
    // A done analysis always has a verdict: one left from the old custom tiers reads 拿不准, as on 分拣台 and B站 pages.
    const { verdict } = MdgTagCore.verdictOf({ analysis });
    lines.push(`${VERDICT_LINE}${MdgTagCore.VERDICTS[verdict]}${analysis.reason ? `，${analysis.reason}` : ""}`);
    return lines.join("\n").trim();
  }

  // The 分拣台 data a video's note carries, read the same way by every note writer: the AI 总结 (per bvid; it
  // summarizes P1, so B站 P1 only), 备注 (per video id, any site) and the 分拣 tags (B站, every part).
  // triageExtrasKeys names the storage keys to read; triageExtras picks from what was read. 摘读记录's tags join the 分拣
  // tags and its 星标 is starred, for videos and web pages (url) alike.
  const isBiliP1 = ({ site, pageIndex }) => site === "bilibili" && !(Number(pageIndex) > 1);
  // A record's key in 摘读记录's marks: a video's, every part alike (no cid), or a web page's address.
  const readingKey = ({ site, videoId, url } = {}) => MdgLimits.readingKeyOf(MdgSites.buildContextKey({ site, videoId, url }));
  function triageExtrasKeys({ site, videoId, pageIndex, url }) {
    const { triageNotes, triageTags, triageVideoTags, triageAnalysis, readingMarks } = MdgLimits.KEYS;
    const marks = readingKey({ site, videoId, url }) ? [readingMarks] : [];
    if (!videoId) {
      return marks;
    }
    return [
      triageNotes,
      ...(site === "bilibili" ? [triageTags, triageVideoTags] : []),
      ...(isBiliP1({ site, pageIndex }) ? [triageAnalysis(videoId)] : []),
      ...marks
    ];
  }
  function triageExtras(stored, { site, videoId, pageIndex, url }) {
    const { triageNotes, triageTags, triageVideoTags, triageAnalysis, readingMarks } = MdgLimits.KEYS;
    const all = stored || {};
    const names = new Map((all[triageTags] || []).map((tag) => [tag.id, tag.name]));
    const tagIds = site === "bilibili" ? all[triageVideoTags]?.[videoId] || [] : [];
    const marks = all[readingMarks];
    const mark = marks?.items?.[readingKey({ site, videoId, url })];
    const markNames = new Map((marks?.tags || []).map((tag) => [tag.id, tag.name]));
    return {
      analysis: (isBiliP1({ site, pageIndex }) && all[triageAnalysis(videoId)]) || null,
      note: String(all[triageNotes]?.[videoId]?.text || ""),
      userTags: [...new Set([...tagIds.map((id) => names.get(id)), ...(mark?.tags || []).map((id) => markNames.get(id))].filter(Boolean))],
      starred: Boolean(mark?.star)
    };
  }

  // The summary and the user's basket note go right after the frontmatter so they are read first.
  function withTriageSummary(markdown, analysis, note) {
    const summary = buildTriageSummary(analysis);
    const mine = String(note || "").trim();
    const block = [summary && `## AI 总结\n\n${summary}`, mine && `## 备注\n\n${mine}`].filter(Boolean).join("\n\n");
    if (!block) {
      return markdown;
    }
    const front = /^---\n[\s\S]*?\n---\n\n?/.exec(markdown)?.[0] || "";
    return `${front}${block}\n\n${markdown.slice(front.length)}`;
  }

  function buildHotCommentLines(comments) {
    const items = normalizeHotComments(comments);
    if (items.length === 0) {
      return [];
    }

    // The comment is indented into its list item, so its own lines (「- 」「# 」, blank lines) stay its text.
    return items.flatMap((item, index) => [
      `${index + 1}. ${item.uname}（赞 ${item.like}）`,
      ...item.message.split("\n").map((line) => (line.trim() ? `   ${line}` : "")),
      ""
    ]).slice(0, -1);
  }

  function buildFrontMatter(meta, settings, url, created, tagsCsv, tagsYaml) {
    const enabled = getEnabledFrontmatterFields(settings);
    const fixedPropertyLines = getFixedFrontmatterPropertyLines(
      settings,
      buildFrontmatterTemplateContext(meta, url, created, tagsCsv, tagsYaml)
    );
    if (enabled.length === 0 && fixedPropertyLines.length === 0) {
      return "";
    }

    const quoted = (key, value) => (value ? `${key}: "${escapeYaml(value)}"` : "");
    const fieldLines = {
      title: quoted("title", meta.title),
      url: quoted("url", url),
      site: quoted("site", meta.site),
      video_id: quoted("video_id", meta.videoId),
      cid: quoted("cid", meta.cid),
      author: quoted("author", meta.author || "unknown"),
      author_url: quoted("author_url", meta.authorUrl),
      upload_date: quoted("upload_date", meta.uploadDate || "unknown"),
      duration: Number(meta.videoDuration) > 0 ? `duration: ${Math.round(Number(meta.videoDuration))}` : "",
      cover: quoted("cover", meta.cover),
      video_tags: meta.videoTags?.length ? `video_tags: ${yamlList(meta.videoTags)}` : "",
      subtitle_lang: quoted("subtitle_lang", meta.selectedSubtitleLang || "unknown"),
      created: quoted("created", created),
      tags: `tags: ${tagsYaml}`
    };

    const lines = enabled.map((field) => fieldLines[field]).filter(Boolean);
    if (meta.starred) lines.push("starred: true");
    lines.push(...fixedPropertyLines);
    if (lines.length === 0) {
      return "";
    }

    return ["---", ...lines, "---"].join("\n");
  }

  function yamlList(items) {
    return `[${items.map((item) => `"${escapeYaml(item)}"`).join(", ")}]`;
  }

  function getEnabledFrontmatterFields(settings) {
    const raw = Array.isArray(settings?.frontmatterFields) ? settings.frontmatterFields : DEFAULT_FRONTMATTER_FIELDS;
    return [...new Set(raw.map(S.normalizeFrontmatterField))].filter((key) => FRONTMATTER_FIELDS.includes(key));
  }

  function getFixedFrontmatterPropertyLines(settings, templateContext = {}) {
    const rows = Array.isArray(settings?.fixedFrontmatterProperties) ? settings.fixedFrontmatterProperties : [];
    const seenKeys = new Set();
    const lines = [];

    rows.forEach((item) => {
      const key = String(item?.key || "").trim();
      const type = S.normalizeFixedPropertyType(item?.type);
      const value = item?.value;
      const lowerKey = key.toLowerCase();
      if (!key || S.isFixedPropertyRowEffectivelyEmpty(type, value)) {
        return;
      }
      if (!S.FIXED_PROPERTY_KEY_RE.test(key)) {
        return;
      }
      if (S.RESERVED_PROPERTY_KEYS.includes(lowerKey) || seenKeys.has(lowerKey)) {
        return;
      }
      seenKeys.add(lowerKey);
      const yamlLine = formatFixedPropertyYamlLine(key, type, value, templateContext);
      if (yamlLine) {
        lines.push(yamlLine);
      }
    });

    return lines;
  }

  function buildFrontmatterTemplateContext(meta, url, created, tagsCsv, tagsYaml) {
    return {
      title: String(meta?.title || "").trim(),
      url: String(url || "").trim(),
      site: String(meta?.site || "").trim(),
      video_id: String(meta?.videoId || "").trim(),
      bvid: String(meta?.site === "bilibili" ? meta?.videoId || "" : "").trim(),
      cid: String(meta?.cid || "").trim(),
      author: String(meta?.author || "unknown").trim(),
      author_url: String(meta?.authorUrl || "").trim(),
      cover: String(meta?.cover || "").trim(),
      duration: Number(meta?.videoDuration) > 0 ? String(Math.round(Number(meta.videoDuration))) : "",
      upload_date: String(meta?.uploadDate || "unknown").trim(),
      subtitle_lang: String(meta?.selectedSubtitleLang || "unknown").trim(),
      created: String(created || "").trim(),
      tags: String(tagsCsv || "").trim(),
      tags_csv: String(tagsCsv || "").trim(),
      tags_yaml: String(tagsYaml || "").trim(),
      video_tags: (meta?.videoTags || []).map((tag) => String(tag).trim()).filter(Boolean).join(", ")
    };
  }

  function sanitizeFolderTemplateValue(value) {
    return String(value || "")
      // The characters fileName drops, so a folder never breaks the wiki links to its notes.
      .replace(/[\/\\:*?"<>|#^[\]]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function buildFolderTemplateContext(meta, created = localDate()) {
    return {
      created: sanitizeFolderTemplateValue(created),
      upload_date: sanitizeFolderTemplateValue(meta?.uploadDate || ""),
      author: sanitizeFolderTemplateValue(meta?.author || ""),
      // A web page has no video site: its notes go under 网页.
      site: sanitizeFolderTemplateValue(meta?.site || (meta?.isVideoContext === false ? "网页" : "")),
      id: sanitizeFolderTemplateValue(meta?.videoId || ""),
      video_id: sanitizeFolderTemplateValue(meta?.videoId || "")
    };
  }

  function resolveFolderTemplate(template, meta, created = localDate()) {
    const normalized = normalizeFolder(template);
    if (!normalized) {
      return "";
    }

    const resolved = fillTemplate(normalized, buildFolderTemplateContext(meta, created));

    // No folder starts with a dot: Obsidian skips it, and . and .. would climb out of the vault folder the user named.
    return resolved
      .split("/")
      .map((segment) => sanitizeFolderTemplateValue(segment).replace(/^[\s.]+/, ""))
      .filter(Boolean)
      .join("/");
  }

  function buildNotePlaceholderTemplateContext(meta, url, description) {
    return {
      title: String(meta?.title || "").trim(),
      author: String(meta?.author || "").trim(),
      url: String(url || "").trim(),
      site: String(meta?.site || "").trim(),
      video_id: String(meta?.videoId || "").trim(),
      author_url: String(meta?.authorUrl || "").trim(),
      cover: String(meta?.cover || "").trim(),
      upload_date: String(meta?.uploadDate || "").trim(),
      description: String(description || "").trim()
    };
  }

  function groupNotePlaceholderSections(settings, templateContext = {}) {
    const groups = {
      before_intro: [],
      before_chapters: [],
      before_subtitle: []
    };
    const rows = S.normalizeNotePlaceholderSections(settings?.notePlaceholderSections);
    rows.forEach((item) => {
      const renderedLines = buildNotePlaceholderLines(item, templateContext);
      if (!renderedLines.length) {
        return;
      }
      groups[item.position].push(...renderedLines);
    });
    return groups;
  }

  function buildNotePlaceholderLines(item, templateContext = {}) {
    const title = String(item?.title || "").trim();
    if (!title) {
      return [];
    }
    const content = fillTemplate(item?.content, templateContext).trim();
    const lines = [`## ${title}`, ""];
    if (content) {
      lines.push(content, "");
    }
    return lines;
  }

  // {{key}} → the context's own value ({{constructor}} is no key); an unknown key is "".
  function fillTemplate(value, context = {}) {
    return String(value || "").replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, rawKey) => {
      const key = rawKey.toLowerCase();
      return Object.hasOwn(context, key) ? String(context[key] ?? "") : "";
    });
  }

  function isYamlDateValue(value) {
    return /^\d{4}-\d{2}-\d{2}$/.test(String(value || "").trim());
  }

  function parseFrontmatterArrayItems(value) {
    return String(value || "")
      .split(/[，,]/)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  function formatFixedPropertyYamlLine(key, type, value, templateContext = {}) {
    const normalizedType = S.normalizeFixedPropertyType(type);
    const resolvedValue = fillTemplate(value, templateContext).trim();

    if (!resolvedValue) {
      return "";
    }

    if (normalizedType === "number") {
      const num = Number(resolvedValue);
      if (!Number.isFinite(num)) {
        return "";
      }
      return `${key}: ${resolvedValue}`;
    }

    if (normalizedType === "checkbox") {
      const normalizedValue = resolvedValue.toLowerCase();
      if (normalizedValue !== "true" && normalizedValue !== "false") {
        return "";
      }
      return `${key}: ${normalizedValue}`;
    }

    if (normalizedType === "list") {
      return `${key}: ${yamlList(parseFrontmatterArrayItems(resolvedValue))}`;
    }

    if (normalizedType === "date") {
      if (!isYamlDateValue(resolvedValue)) {
        return "";
      }
      return `${key}: ${resolvedValue}`;
    }

    return `${key}: "${escapeYaml(resolvedValue)}"`;
  }

  function buildSubtitleSectionLines(body, chapters, settings, withHours) {
    const subtitleItems = (body || [])
      .map((item, index) => ({
        ...item,
        _index: index,
        text: String(item?.content || "").trim()
      }))
      .filter((item) => item.text);
    if (subtitleItems.length === 0) {
      return [];
    }

    const chapterItems = MdgSites.chapterRanges(chapters);
    if (chapterItems.length === 0) {
      return subtitleItems.map((item) => formatSubtitleLine(item, settings, withHours));
    }

    const lines = [];
    const usedIndexes = new Set();

    // Subtitles before the first chapter open the section, in time order, under no chapter heading.
    const firstStart = Number(chapterItems[0].from || 0) || 0;
    subtitleItems.filter((item) => (Number(item.from || 0) || 0) + 0.001 < firstStart).forEach((item) => {
      usedIndexes.add(item._index);
      lines.push(formatSubtitleLine(item, settings, withHours));
    });
    if (lines.length) {
      lines.push("");
    }

    chapterItems.forEach((chapter) => {
      // Chapters that start together share a range; usedIndexes puts each subtitle in the first of them.
      const { from: start, to: end } = chapter;

      const sectionItems = subtitleItems.filter((item) => {
        if (usedIndexes.has(item._index)) {
          return false;
        }
        const from = Number(item.from || 0) || 0;
        return from + 0.001 >= start && from < end;
      });

      if (sectionItems.length === 0) {
        return;
      }

      const chapterStamp = settings.includeTimestampInBody
        ? ` \`${formatCompactTimestamp(start, withHours)}\``
        : "";
      lines.push(`### ${chapter.title}${chapterStamp}`, "");
      sectionItems.forEach((item) => {
        usedIndexes.add(item._index);
        lines.push(formatSubtitleLine(item, settings, withHours));
      });
      lines.push("");
    });

    const remaining = subtitleItems.filter((item) => !usedIndexes.has(item._index));
    if (remaining.length > 0) {
      lines.push("### 其他片段", "");
      remaining.forEach((item) => {
        lines.push(formatSubtitleLine(item, settings, withHours));
      });
      lines.push("");
    }

    while (lines.length > 0 && !lines[lines.length - 1]) {
      lines.pop();
    }
    return lines;
  }

  function formatSubtitleLine(item, settings, withHours) {
    const text = String(item?.content || "").trim();
    if (!text) {
      return "";
    }
    if (!settings.includeTimestampInBody) {
      return text;
    }
    return `\`${formatCompactTimestamp(item.from, withHours)}\` ${text}`;
  }

  function buildChapterLines(chapters, withHours = false) {
    const chapterItems = MdgSites.normalizeChapters(chapters);
    if (chapterItems.length === 0) {
      return [];
    }

    return chapterItems.map((item) => {
      const fromText = formatCompactTimestamp(item.from, withHours);
      return `- \`${fromText}\` ${item.title}`;
    });
  }

  function buildSrt(body) {
    return body
      .map((item, index) => {
        const from = formatTimestamp(item.from);
        const to = formatTimestamp(item.to);
        const text = (item.content || "").trim();
        return `${index + 1}\n${from} --> ${to}\n${text}`;
      })
      .join("\n\n");
  }

  function buildTxt(body, settings) {
    const withHours = shouldShowHoursInSubtitle(body);
    return (body || [])
      .map((item) => {
        const text = String(item?.content || "").trim();
        if (!text) {
          return "";
        }
        if (!settings?.includeTimestampInBody) {
          return text;
        }
        return `${formatCompactTimestamp(item.from, withHours)} ${text}`;
      })
      .filter(Boolean)
      .join("\n");
  }

  // The last subtitle's end, in seconds.
  const maxTo = (body) => (body || []).reduce((max, item) => {
    const to = Number(item?.to || 0);
    return Number.isFinite(to) && to > max ? to : max;
  }, 0);

  function shouldShowHoursInSubtitle(body) {
    return maxTo(body) >= 3600;
  }

  function shouldShowHoursInNote(meta, body) {
    const chapterMaxTo = MdgSites.normalizeChapters(meta?.chapters || []).reduce((max, item) => {
      const from = Number(item?.from || 0) || 0;
      const to = Number(item?.to || 0) || 0;
      return Math.max(max, from, to);
    }, 0);
    const duration = Number(meta?.videoDuration || 0) || 0;
    return Math.max(maxTo(body), chapterMaxTo, duration) >= 3600;
  }

  function formatCompactTimestamp(seconds, withHours) {
    const safe = Math.max(0, Math.floor(Number(seconds) || 0));
    const hour = Math.floor(safe / 3600);
    const minute = Math.floor((safe % 3600) / 60);
    const second = safe % 60;

    if (withHours) {
      return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(
        second
      ).padStart(2, "0")}`;
    }

    const totalMinutes = Math.floor(safe / 60);
    return `${String(totalMinutes).padStart(2, "0")}:${String(second).padStart(2, "0")}`;
  }

  // SRT's 00:01:02,500.
  function formatTimestamp(seconds) {
    const safe = Number(seconds) || 0;
    // Rounded: 1.001 * 1000 is 1000.9999999999999, which floor would make a millisecond early.
    const msTotal = Math.max(0, Math.round(safe * 1000));
    const hour = Math.floor(msTotal / 3600000);
    const minute = Math.floor((msTotal % 3600000) / 60000);
    const second = Math.floor((msTotal % 60000) / 1000);
    const ms = msTotal % 1000;

    const pad2 = (n) => String(n).padStart(2, "0");
    return `${pad2(hour)}:${pad2(minute)}:${pad2(second)},${String(ms).padStart(3, "0")}`;
  }



  function buildNoteFilename(meta, settings, created = localDate()) {
    const baseParts = [];

    if (MdgSettings.normalizeSwitches(settings).includeDateInFilename) {
      baseParts.push(created);
    }

    const fallback = meta.videoId || "video-subtitle";
    baseParts.push(String(meta.title || "").trim() || fallback);

    if (Number(meta.pageCount) > 1) {
      baseParts.push(`P${Number(meta.pageIndex) > 0 ? Number(meta.pageIndex) : 1}`);
      const pageTitle = String(meta.pageTitle || "").trim();
      if (pageTitle) {
        baseParts.push(pageTitle);
      }
    }

    // A title of dots alone leaves nothing (fileName drops leading dots).
    return `${fileName(baseParts.filter(Boolean).join("-"), fallback)}.md`;
  }

  // Where a video's note and a conversation's own note go when no path is recorded (obsidian.js): the folder template,
  // then the file name.
  function inNoteFolder(meta, settings, filename) {
    const folder = resolveFolderTemplate(settings?.noteFolder || "", meta);
    return folder ? `${folder}/${filename}` : filename;
  }
  const videoNotePath = (meta, settings) => inNoteFolder(meta, settings, buildNoteFilename(meta, settings || {}));
  // 下载 .md and the 逐个视频笔记 .zip: the name of the note a write recorded under key (obsidian.js
  // rememberObsidianNotePath, KEYS.obsidianNotePaths), so a dated note downloads under its own date; else filename.
  function recordedFilename(paths, key, filename) {
    const path = String((key && paths?.[key]?.path) || "");
    return path ? path.split("/").pop() : filename;
  }
  // 一篇摘录 and the 逐个视频笔记 index cover many videos: their folder is the template's folders before the first one
  // that names a single video, resolved for B站. A template without one gives the notes' own folder.
  const PER_VIDEO_FOLDER = /\{\{\s*(author|upload_date|id|video_id|created)\s*\}\}/i;
  function sharedNoteFolder(template) {
    const segments = normalizeFolder(template).split("/");
    const cut = segments.findIndex((segment) => PER_VIDEO_FOLDER.test(segment));
    return resolveFolderTemplate((cut < 0 ? segments : segments.slice(0, cut)).join("/"), { site: "bilibili" });
  }
  const conversationNotePath = (context, settings) => inNoteFolder(context, settings, buildAiConversationFilename(context));

  function normalizeFolder(input) {
    return String(input || "").trim().replace(/^\/+|\/+$/g, "");
  }


  function escapeYaml(value) {
    // YAML's double-quoted scalars take no raw control characters: the others become \xNN.
    return String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n").replaceAll("\r", "\\r").replaceAll("\t", "\\t")
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`);
  }

  // Chat-answer Markdown to HTML for the side panel and the history page. HTML is escaped first,
  // so only the tags built here reach the page.
  function renderMarkdown(text) {
    let escaped = escapeHtml(stripThinkBlocks(text));
    const codeBlocks = [];
    escaped = escaped.replace(/```([\s\S]*?)```/g, (_, code) => {
      // The fence's first line is its language (```python), not code.
      codeBlocks.push(code.includes("\n") ? code.replace(/^[^\n]*\n/, "") : code);
      return `\u0001MDG_CODE_${codeBlocks.length - 1}\u0001`;
    });

    const lines = escaped.split("\n");
    const out = [];
    let listType = "";
    let paraBuf = [];

    const flushPara = () => {
      if (paraBuf.length) {
        out.push(`<p>${renderInline(paraBuf.join(" "))}</p>`);
        paraBuf = [];
      }
    };
    const closeList = () => {
      if (!listType) {
        return;
      }
      out.push(listType === "ul" ? "</ul>" : "</ol>");
      listType = "";
    };
    // As in CommonMark, only an ordered list's first number counts: later items continue it whatever they say.
    const openList = (nextType, startNumber = 1) => {
      if (listType === nextType) {
        return;
      }
      closeList();
      listType = nextType;
      if (nextType === "ul") {
        out.push("<ul>");
        return;
      }
      out.push(startNumber > 1 ? `<ol start="${startNumber}">` : "<ol>");
    };
    const getNextListType = (startIndex) => {
      for (let index = startIndex; index < lines.length; index += 1) {
        const nextLine = lines[index].trim();
        if (!nextLine) {
          continue;
        }
        if (/^[-*+]\s+(.+)$/.test(nextLine)) {
          return "ul";
        }
        if (/^\d+\.\s+(.+)$/.test(nextLine)) {
          return "ol";
        }
        break;
      }
      return "";
    };
    const isTableSeparatorLine = (value) => /^\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?$/.test(value);
    const isTableRowLine = (value) => /^\|.+\|$/.test(value);
    const splitTableCells = (value) =>
      value
        .trim()
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|")
        .map((cell) => renderInline(cell.trim()));

    for (let index = 0; index < lines.length; index += 1) {
      const rawLine = lines[index];
      const line = rawLine.trim();

      const codeMatch = line.match(/^\u0001MDG_CODE_(\d+)\u0001$/);
      if (codeMatch) {
        flushPara();
        closeList();
        out.push(`<pre><code>${codeBlocks[Number(codeMatch[1])]}</code></pre>`);
        continue;
      }

      const heading = line.match(/^(#{1,6})\s+(.+)$/);
      if (heading) {
        flushPara();
        closeList();
        const level = Math.min(6, heading[1].length + 2);
        out.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
        continue;
      }

      if (
        isTableRowLine(line) &&
        index + 1 < lines.length &&
        isTableSeparatorLine(lines[index + 1].trim())
      ) {
        flushPara();
        closeList();
        const headers = splitTableCells(line);
        const bodyRows = [];
        index += 2;
        while (index < lines.length) {
          const tableLine = lines[index].trim();
          if (!isTableRowLine(tableLine)) {
            index -= 1;
            break;
          }
          bodyRows.push(splitTableCells(tableLine));
          index += 1;
        }
        out.push(
          `<table><thead><tr>${headers.map((cell) => `<th>${cell}</th>`).join("")}</tr></thead><tbody>${
            bodyRows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("")
          }</tbody></table>`
        );
        continue;
      }

      const ul = line.match(/^[-*+]\s+(.+)$/);
      if (ul) {
        flushPara();
        openList("ul");
        out.push(`<li>${renderInline(ul[1])}</li>`);
        continue;
      }

      const ol = line.match(/^(\d+)\.\s+(.+)$/);
      if (ol) {
        flushPara();
        const orderNumber = Number(ol[1]) || 1;
        openList("ol", orderNumber);
        out.push(`<li>${renderInline(ol[2])}</li>`);
        continue;
      }

      if (!line) {
        flushPara();
        if (listType && getNextListType(index + 1) === listType) {
          continue;
        }
        closeList();
        continue;
      }

      paraBuf.push(line);
    }

    flushPara();
    closeList();
    // A code block that shares its line with text is shown inline.
    return out.join("").replace(/\u0001MDG_CODE_(\d+)\u0001/g, (_, n) => `<code>${codeBlocks[Number(n)]}</code>`);
  }

  // Code spans are set aside first, so the bold, italic and link rules never reach inside them.
  function renderInline(text) {
    const spans = [];
    return text
      .replace(/`([^`]+)`/g, (_, c) => (isTimestampOnlyInlineCode(c) ? c : `\u0002${spans.push(`<code>${c}</code>`) - 1}\u0002`))
      .replace(/\*\*([^*\n]+)\*\*/g, (_, c) => `<strong>${c}</strong>`)
      .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, (_, pre, c) => `${pre}<em>${c}</em>`)
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, u) => {
        const safeUrl = /^(https?:|mailto:|#)/i.test(u) ? u : "#";
        return `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${t}</a>`;
      })
      .replace(/\u0002(\d+)\u0002/g, (_, n) => spans[Number(n)]);
  }

  // The warning shown with a subtitle whose time range does not match the video (validateSubtitleByDuration's result).
  function subtitleMismatchWarning({ maxTo, videoDuration }) {
    const withHours = Math.max(maxTo, videoDuration) >= 3600;
    return `字幕时间轴到 ${formatCompactTimestamp(maxTo, withHours)}，视频长 ${formatCompactTimestamp(videoDuration, withHours)}，字幕时间可能对不上。`;
  }

  // The sentence a written note's result starts with, wherever the note was built (the video page, triageBuildNote):
  // the mismatch warning (mismatchWarning, from subtitleMismatchWarning), or why there is no subtitle.
  const noteSubtitleWarning = (mismatchWarning, { subtitleFailure = "", subtitleNeedLogin = false } = {}) =>
    mismatchWarning || (subtitleFailure || subtitleNeedLogin ? `${MdgErrors.subtitleMissing({ subtitleFailure, subtitleNeedLogin })}。` : "");

  // The note fields the background readers (side panel follow-up, 分拣台 notes) take from the sites.js fetchers;
  // the video page's state already carries them. Chapters fall back to the description, as on the video page.
  function noteMetaOf({ site, videoId, meta, bundle, track }) {
    const chapters = bundle?.chapters?.length ? bundle.chapters : MdgSites.parseChaptersFromDescription(meta.description);
    return {
      ...meta,
      site,
      videoId,
      videoDuration: meta.duration,
      videoTags: meta.tags || [],
      chapters: MdgSites.normalizeChapters(chapters),
      selectedSubtitleLang: String(track?.label || track?.lang || "").trim()
    };
  }

  // A web page's note (the side panel's page context once read): its own frontmatter, the main text Defuddle read and
  // the AI 问答 section between the video note's markers, so 只更新 AI 问答 and auto-sync work the same. Its path is
  // videoNotePath of the page's context ({{site}} is 网页).
  function buildPageNote(page, settings, turns = [], created = localDate()) {
    const url = String(page?.url || "").trim();
    let host = "";
    try {
      host = new URL(url).hostname;
    } catch {}
    const quoted = (key, value) => (value ? `${key}: "${escapeYaml(value)}"` : "");
    const tags = noteTags({ userTags: page?.userTags }, settings);
    // The user's 自定属性, by the video note's function. {{site}} is 网页 as in the folder template (one variable, one
    // value everywhere; the host is the built-in site field), {{upload_date}} the published date.
    const meta = { title: page?.title, site: "网页", author: page?.author, uploadDate: page?.published };
    const own = getFixedFrontmatterPropertyLines(settings, buildFrontmatterTemplateContext(meta, url, created, tags.join(", "), yamlList(tags)));
    const front = ["---", quoted("title", page?.title), quoted("url", url), quoted("site", host), quoted("author", page?.author), quoted("published", page?.published), quoted("created", created), `tags: ${yamlList(tags)}`, page?.starred ? "starred: true" : "", ...own, "---"];
    const markdown = `${front.filter(Boolean).join("\n")}\n\n${String(page?.pageMarkdown || "").trim()}`;
    const ai = MdgSettings.normalizeSwitches(settings).includeAiChatInNote ? buildAiSection(turns) : "";
    return `${ai ? `${markdown}\n\n${ai}` : markdown}\n`;
  }

  // A web page's note file, the one the side panel and the popup copy, download and write to Obsidian. stored:
  // chrome.storage.local with triageExtrasKeys({ url }), for its 标签 and 星标, and KEYS.obsidianNotePaths when read, so
  // a page written to Obsidian downloads under that note's name (recordedFilename).
  function buildPageNoteFile(page, settings, turns, stored) {
    const { userTags, starred } = triageExtras(stored, { url: page.url });
    const filename = recordedFilename(stored?.[MdgLimits.KEYS.obsidianNotePaths], MdgSites.buildContextKey({ url: page.url }), buildNoteFilename(page, settings));
    return { filename, content: buildPageNote({ ...page, userTags, starred }, settings, turns) };
  }

  // The note as the AI reads it (video page and background): no hot comments, and no player embed, which is for
  // Obsidian only; the note written or downloaded keeps it. The note switches that are about the file only do not reach
  // it: timestamps always (the AI cites them and its replies jump by them), and never the AI 问答 section (the
  // conversation is sent as the conversation, and the video page's state carries it while the background's does not).
  const buildAiContext = (meta, body, settings, ref) =>
    buildMarkdown(meta, body, { ...settings, includeHotCommentsInNote: false, playerEmbed: false, includeTimestampInBody: true, includeAiChatInNote: false }, ref);

  globalThis.MdgNote = {
    buildMarkdown,
    noteTags,
    buildAiContext,
    buildPageNote,
    buildPageNoteFile,
    noteMetaOf,
    subtitleMismatchWarning,
    noteSubtitleWarning,
    AI_SECTION_START,
    AI_SECTION_END,
    TIMESTAMP_PATTERN,
    stripThinkBlocks,
    renderMarkdown,
    normalizeMarkdownForSectionPaste,
    buildConversationTurns,
    pickConversation,
    buildAiSection,
    upsertAiSection,
    buildAiConversationFilename,
    buildAiConversationMarkdown,
    buildTriageSummary,
    withTriageSummary,
    triageExtras,
    triageExtrasKeys,
    readingKey,
    buildNoteFilename,
    resolveFolderTemplate,
    sharedNoteFolder,
    videoNotePath,
    recordedFilename,
    conversationNotePath,
    // The popup's subtitle box shows the TXT the user downloads.
    buildSubtitlePreview: buildTxt,
    buildSrt,
    buildTxt,
    shouldShowHoursInNote,
    formatCompactTimestamp,
    formatTimestamp,
    escapeYaml
  };
})();
