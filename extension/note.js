// Note builder shared by content.js (manifest js list), background.js (importScripts)
// and the extension pages (<script>). Pure: everything it reads arrives as arguments.
// Needs BocSites (sites.js) loaded first. Idempotent like sites.js.
//
// meta     the content-script state shape: title, site, videoId, cid, aid, author, authorUrl,
//          uploadDate, videoDuration, cover, videoTags, selectedSubtitleLang, description,
//          chapters, hotComments, pageIndex, pageCount, pageTitle
// body     Segment[] { from, to, content }
// ref      VideoRef from sites.js, or null; ref.url is the note's canonical URL
// settings the merged user settings (tags, frontmatterFields, include* flags, ...)
// meta.aiTurns  optional [{ prompt, answer }] from buildConversationTurns; written as the AI 问答 section
(() => {
  if (globalThis.BocNote) {
    return;
  }

  const DEFAULT_FRONTMATTER_FIELDS = [
    "title",
    "url",
    "site",
    "video_id",
    "cid",
    "author",
    "author_url",
    "upload_date",
    "duration",
    "cover",
    "subtitle_lang",
    "created",
    "tags"
  ];
  // Every field a note can carry; DEFAULT_FRONTMATTER_FIELDS is the subset on by default.
  const FRONTMATTER_FIELDS = [...DEFAULT_FRONTMATTER_FIELDS, "video_tags"];

  function formatLocalDate(value = Date.now()) {
    const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  }

  function normalizeHotComments(comments, limit = 20) {
    if (!Array.isArray(comments)) {
      return [];
    }

    return comments
      .map((item) => ({
        uname: String(item?.uname || "匿名").trim() || "匿名",
        like: Number(item?.like || 0) || 0,
        message: String(item?.message || "").trim().slice(0, 500)
      }))
      .filter((item) => item.message)
      .slice(0, limit);
  }



  function buildSubtitlePreview(body, settings) {
    const compactWithHours = shouldShowHoursInSubtitle(body);
    return (body || [])
      .map((item) => {
        const text = String(item?.content || "").trim();
        if (!text) {
          return "";
        }
        if (settings.includeTimestampInBody) {
          return `\`${formatCompactTimestamp(item.from, compactWithHours)}\` ${text}`;
        }
        return text;
      })
      .filter(Boolean)
      .join("\n");
  }

  function buildMarkdown(meta, body, settings, ref, created = formatLocalDate()) {
    const url = String(ref?.url || "");
    const tags = (settings.tags || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    const tagsCsv = tags.join(", ");
    const tagsYaml =
      tags.length === 0 ? "[]" : `[${tags.map((tag) => `"${escapeYaml(tag)}"`).join(", ")}]`;

    const compactWithHours = shouldShowHoursInNote(meta, body);
    const chapterLines = buildChapterLines(meta.chapters || [], compactWithHours);
    const subtitleSectionLines = buildSubtitleSectionLines(
      body,
      meta.chapters || [],
      settings,
      compactWithHours
    );
    const frontMatter = buildFrontMatter(meta, settings, url, created, tagsCsv, tagsYaml);

    const embedIframe = (ref && BocSites.SITES[ref.site]?.embedHtml(ref, meta)) || "";
    const intro = String(meta.description || "").trim();
    const noteSectionContext = buildNotePlaceholderTemplateContext(meta, url, intro);
    const noteSections = groupNotePlaceholderSections(settings, noteSectionContext);

    const lines = [];
    if (frontMatter) {
      lines.push(frontMatter, "");
    }
    if (settings.includeCoverInNote !== false && meta.cover) {
      lines.push(`![cover](${meta.cover})`, "");
    }
    if (embedIframe) {
      lines.push(embedIframe, "");
    }
    const hasSubtitles = subtitleSectionLines.length > 0;
    if (!hasSubtitles) {
      lines.push(
        meta.subtitleFailure
          ? `> 字幕抓取失败（${meta.subtitleFailure}），以下为简介与热门评论。`
          : "> 本视频无字幕，以下为简介与热门评论。",
        ""
      );
    }
    pushOptionalLines(lines, noteSections.before_intro);

    if (intro) {
      lines.push("## 简介", "", intro, "");
    }

    pushOptionalLines(lines, noteSections.before_chapters);

    if (chapterLines.length > 0) {
      lines.push("## 章节", "", ...chapterLines, "");
    }

    pushOptionalLines(lines, noteSections.before_subtitle);
    if (hasSubtitles) {
      lines.push("## 字幕", "", ...subtitleSectionLines, "");
    }

    const hotCommentLines = buildHotCommentLines(
      settings?.includeHotCommentsInNote || !hasSubtitles ? meta?.hotComments || [] : []
    );
    if (hotCommentLines.length > 0) {
      lines.push("## 评论", "", ...hotCommentLines);
    }

    const markdown = lines.join("\n").trimEnd();
    const aiSection = settings?.includeAiChatInNote === false ? "" : buildAiSection(meta.aiTurns);
    return aiSection ? `${markdown}\n\n${aiSection}` : markdown;
  }

  // ---- AI 问答 section: the side panel conversation inside the video note ----
  // The markers let a later save replace just this section; Obsidian's reading view hides them.
  const AI_SECTION_START = "<!-- moondigest:ai-start -->";
  const AI_SECTION_END = "<!-- moondigest:ai-end -->";

  function stripThinkBlocks(text) {
    return String(text || "")
      .replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, "")
      .replace(/<think\b[^>]*>[\s\S]*$/gi, "")
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
      const headingMatch = pasteLine.match(/^(\s*)(#{1,3})(\s+.*)$/);
      if (!headingMatch) {
        normalized.push(pasteLine);
        return;
      }
      const [, indent, hashes, suffix] = headingMatch;
      normalized.push(`${indent}${"#".repeat(hashes.length + shift)}${suffix}`);
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

  // The newest saved conversation for this video. Bilibili parts have their own cid; a conversation
  // without one (saved before cid was recorded) still matches the video.
  function pickConversation(conversations, { site = "", videoId = "", cid = "" } = {}) {
    const key = BocSites.buildContextKey({ site, videoId, cid });
    if (!key) {
      return null;
    }
    const prefix = key.slice(0, key.indexOf("|") + 1);
    const candidates = (Array.isArray(conversations) ? conversations : [])
      .filter((item) => item?.contextKey === key || (cid && item?.contextKey === prefix) || (!cid && String(item?.contextKey || "").startsWith(prefix)))
      .sort((a, b) => (Number(b?.updatedAt) || 0) - (Number(a?.updatedAt) || 0));
    return candidates[0] || null;
  }

  function sanitizeMarkdownHeadingText(value) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .replace(/^#+\s*/, "")
      .trim() || "AI问答";
  }

  function buildAiTurnLines(turns) {
    return (Array.isArray(turns) ? turns : []).flatMap((turn) => [`### 问：${sanitizeMarkdownHeadingText(turn.prompt)}`, "", String(turn.answer || "").trim(), ""]);
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
  // are untouched, and running it twice with the same section yields the same note.
  function upsertAiSection(note, section) {
    const text = String(note || "");
    const start = text.indexOf(AI_SECTION_START);
    const end = start >= 0 ? text.indexOf(AI_SECTION_END, start + AI_SECTION_START.length) : -1;
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
  function aiSourceTitle(context) {
    return String(context?.title || "当前视频").trim() || "当前视频";
  }

  // Multi-P videos: each part's conversation is its own note, named and linked by part.
  function aiPartIndex(context) {
    return Number(context?.pageIndex) > 0 ? Number(context.pageIndex) : 1;
  }

  function buildAiConversationFilename(context) {
    const part = aiPartIndex(context);
    const partSuffix = part > 1 || Number(context?.pageCount) > 1 ? ` P${part}` : "";
    const baseName = sanitizeFileName(`【AI笔记】${aiSourceTitle(context)}${partSuffix}`);
    return `${baseName || "【AI笔记】当前视频"}.md`;
  }

  function escapeWikiLinkTarget(value) {
    return String(value || "").replace(/\]/g, "\\]");
  }

  // source: a wiki link to the video note (path without .md), so the AI note sits under it in the graph.
  // Body line: link the real video note when its path is known, else name the video without a dangling link.
  function sourceBodyLine(sourcePath, sourceTitle) {
    const target = String(sourcePath || "").replace(/\.md$/i, "");
    return target
      ? `来源：[[${escapeWikiLinkTarget(target)}|${escapeWikiLinkTarget(sourceTitle)}]]`
      : `来源：${sourceTitle}`;
  }

  function sourceFrontmatterLine(sourcePath) {
    const target = String(sourcePath || "").replace(/\.md$/i, "");
    return target ? `source: "[[${escapeYaml(target)}]]"` : "";
  }

  function cleanVideoUrl(context) {
    const url = String(context?.url || "").trim();
    const site = BocSites.SITES[context?.site] || BocSites.matchSite(url);
    const videoId = String(context?.videoId || BocSites.parseRef(url)?.id || "").trim();
    if (site && videoId) {
      return site.canonicalUrl(videoId, aiPartIndex(context));
    }
    return url;
  }

  function buildAiNoteFrontmatter({ context, filename, sourcePath }) {
    return [
      "---",
      `title: "${escapeYaml(filename.replace(/\.md$/i, ""))}"`,
      `source_title: "${escapeYaml(aiSourceTitle(context))}"`,
      sourceFrontmatterLine(sourcePath),
      `url: "${escapeYaml(cleanVideoUrl(context))}"`,
      context?.author ? `author: "${escapeYaml(context.author)}"` : "",
      `created: "${formatLocalDate()}"`,
      `tags: [ai_note]`,
      "---"
    ].filter(Boolean);
  }

  // A whole conversation; turns from buildConversationTurns.
  function buildAiConversationMarkdown({ context, turns, filename, sourcePath = "" }) {
    const lines = [...buildAiNoteFrontmatter({ context, filename, sourcePath }), "", sourceBodyLine(sourcePath, aiSourceTitle(context))];
    turns.forEach((turn) => {
      lines.push("", `## ${sanitizeMarkdownHeadingText(turn.prompt)}`, "", turn.answer);
    });
    return `${lines.join("\n").trim()}\n`;
  }

  // The triage page's per-video analysis (triage_analysis_<bvid>) as Markdown; "" until it is done.
  function buildTriageSummary(analysis) {
    if (analysis?.status !== "done") {
      return "";
    }
    const lines = [];
    if (analysis.oneLiner) lines.push(`> ${analysis.oneLiner}`, "");
    const points = (analysis.points || []).filter(Boolean);
    if (points.length) lines.push(...points.map((p) => `- ${p}`), "");
    const verdict = { keep: "值得留", drop: "可清理", unsure: "拿不准" }[analysis.verdict];
    if (verdict) lines.push(`AI 判断：${verdict}${analysis.reason ? `，${analysis.reason}` : ""}`);
    return lines.join("\n").trim();
  }

  // The summary and the user's basket note go right after the frontmatter so they are read first.
  function withTriageSummary(markdown, analysis, note) {
    const summary = buildTriageSummary(analysis);
    const mine = String(note || "").trim();
    const block = [summary && `## AI 总结\n\n${summary}`, mine && `## 我的备注\n\n${mine}`].filter(Boolean).join("\n\n");
    if (!block) {
      return markdown;
    }
    const front = /^---\n[\s\S]*?\n---\n\n?/.exec(markdown)?.[0] || "";
    return `${front}${block}\n\n${markdown.slice(front.length)}`;
  }

  function buildHotCommentLines(comments) {
    const items = normalizeHotComments(comments, 20);
    if (items.length === 0) {
      return [];
    }

    return items.flatMap((item, index) => [
      `${index + 1}. ${item.uname}（赞 ${item.like}）`,
      item.message,
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
    const allowed = new Set(FRONTMATTER_FIELDS);
    const unique = [];
    raw.forEach((item) => {
      // "bvid" was the field name before the site registry.
      const key = String(item || "").trim().replace(/^bvid$/, "video_id");
      if (!key || !allowed.has(key) || unique.includes(key)) {
        return;
      }
      unique.push(key);
    });
    return unique;
  }

  function getFixedFrontmatterPropertyLines(settings, templateContext = {}) {
    const customPropertyKeyPattern = /^[\p{L}\p{N}_\-\s]+$/u;
    const systemFields = new Set(FRONTMATTER_FIELDS);
    const rows = Array.isArray(settings?.fixedFrontmatterProperties) ? settings.fixedFrontmatterProperties : [];
    const seenKeys = new Set();
    const lines = [];

    rows.forEach((item) => {
      const key = String(item?.key || "").trim();
      const type = normalizeFixedPropertyType(item?.type);
      const value = item?.value;
      const lowerKey = key.toLowerCase();
      if (!key || isFixedPropertyRowEffectivelyEmpty(type, value)) {
        return;
      }
      if (!customPropertyKeyPattern.test(key)) {
        return;
      }
      if (systemFields.has(lowerKey) || seenKeys.has(lowerKey)) {
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

  function normalizeFixedPropertyType(value) {
    const type = String(value || "").trim().toLowerCase();
    return type === "number" || type === "checkbox" || type === "list" || type === "date" ? type : "text";
  }

  function isFixedPropertyRowEffectivelyEmpty(type, value) {
    return !String(value || "").trim();
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
      tags_yaml: String(tagsYaml || "").trim()
    };
  }

  function sanitizeFolderTemplateValue(value) {
    return String(value || "")
      .replace(/[\/\\:*?"<>|]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function buildFolderTemplateContext(meta, created = formatLocalDate()) {
    return {
      created: sanitizeFolderTemplateValue(created),
      upload_date: sanitizeFolderTemplateValue(meta?.uploadDate || ""),
      author: sanitizeFolderTemplateValue(meta?.author || ""),
      site: sanitizeFolderTemplateValue(meta?.site || ""),
      id: sanitizeFolderTemplateValue(meta?.videoId || ""),
      video_id: sanitizeFolderTemplateValue(meta?.videoId || "")
    };
  }

  function resolveFolderTemplate(template, meta, created = formatLocalDate()) {
    const normalized = normalizeFolder(template);
    if (!normalized) {
      return "";
    }

    const allowedKeys = new Set(["created", "upload_date", "author", "site", "id", "video_id"]);
    const context = buildFolderTemplateContext(meta, created);
    const resolved = String(normalized).replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, rawKey) => {
      const key = String(rawKey || "").trim().toLowerCase();
      if (!allowedKeys.has(key)) {
        return "";
      }
      return context[key] || "";
    });

    return resolved
      .split("/")
      .map((segment) => sanitizeFolderTemplateValue(segment))
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
    const rows = normalizeNotePlaceholderSections(settings?.notePlaceholderSections);
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
    const content = resolveFrontmatterTemplateValue(item?.content, templateContext).trim();
    const lines = [`## ${title}`, ""];
    if (content) {
      lines.push(content, "");
    }
    return lines;
  }

  function pushOptionalLines(targetLines, extraLines) {
    if (!Array.isArray(extraLines) || !extraLines.length) {
      return;
    }
    targetLines.push(...extraLines);
  }

  function resolveFrontmatterTemplateValue(value, templateContext = {}) {
    return String(value || "").replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, rawKey) => {
      const key = String(rawKey || "").trim().toLowerCase();
      if (!key) {
        return "";
      }
      const resolved = templateContext[key];
      return resolved == null ? "" : String(resolved);
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
    const normalizedType = normalizeFixedPropertyType(type);
    const resolvedValue = resolveFrontmatterTemplateValue(value, templateContext).trim();

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
      const items = parseFrontmatterArrayItems(resolvedValue);
      return `${key}: [${items.map((item) => `"${escapeYaml(item)}"`).join(", ")}]`;
    }

    if (normalizedType === "date") {
      if (!isYamlDateValue(resolvedValue)) {
        return "";
      }
      return `${key}: ${resolvedValue}`;
    }

    return `${key}: "${escapeYaml(resolvedValue)}"`;
  }

  function normalizeNotePlaceholderSections(items) {
    const allowedPositions = new Set(["before_intro", "before_chapters", "before_subtitle"]);
    if (!Array.isArray(items)) {
      return [];
    }
    return items
      .map((item) => {
        const title = String(item?.title || "").trim();
        const position = allowedPositions.has(String(item?.position || "").trim())
          ? String(item?.position || "").trim()
          : "before_intro";
        const content = String(item?.content || "").trim();
        return {
          title,
          position,
          content
        };
      })
      .filter((item) => item.title)
      .slice(0, 5);
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

    const chapterItems = BocSites.normalizeChapters(chapters);
    if (chapterItems.length === 0) {
      return subtitleItems.map((item) => formatSubtitleLine(item, settings, withHours));
    }

    const lines = [];
    const usedIndexes = new Set();

    chapterItems.forEach((chapter, idx) => {
      const start = Number(chapter.from || 0) || 0;
      const next = chapterItems[idx + 1];
      const chapterTo = Number(chapter.to || 0) || 0;
      let end = Infinity;
      if (next && Number(next.from) > start) {
        end = Number(next.from);
      } else if (chapterTo > start) {
        end = chapterTo;
      }

      const sectionItems = subtitleItems.filter((item) => {
        const from = Number(item.from || 0) || 0;
        const inStart = from + 0.001 >= start;
        const inEnd = end === Infinity ? true : from < end;
        return inStart && inEnd;
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
    const chapterItems = BocSites.normalizeChapters(chapters);
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
        const from = formatTimestamp(item.from, true);
        const to = formatTimestamp(item.to, true);
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

  function shouldShowHoursInSubtitle(body) {
    const maxTo = (body || []).reduce((max, item) => {
      const to = Number(item?.to || 0);
      return Number.isFinite(to) && to > max ? to : max;
    }, 0);
    return maxTo >= 3600;
  }

  function shouldShowHoursInNote(meta, body) {
    const subtitleMaxTo = (body || []).reduce((max, item) => {
      const to = Number(item?.to || 0);
      return Number.isFinite(to) && to > max ? to : max;
    }, 0);
    const chapterMaxTo = BocSites.normalizeChapters(meta?.chapters || []).reduce((max, item) => {
      const from = Number(item?.from || 0) || 0;
      const to = Number(item?.to || 0) || 0;
      return Math.max(max, from, to);
    }, 0);
    const duration = Number(meta?.videoDuration || 0) || 0;
    return Math.max(subtitleMaxTo, chapterMaxTo, duration) >= 3600;
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

  function formatTimestamp(seconds, forSrt = false) {
    const safe = Number(seconds) || 0;
    const msTotal = Math.max(0, Math.floor(safe * 1000));
    const hour = Math.floor(msTotal / 3600000);
    const minute = Math.floor((msTotal % 3600000) / 60000);
    const second = Math.floor((msTotal % 60000) / 1000);
    const ms = msTotal % 1000;

    const hh = String(hour).padStart(2, "0");
    const mm = String(minute).padStart(2, "0");
    const ss = String(second).padStart(2, "0");
    if (!forSrt) {
      return `${hh}:${mm}:${ss}.${String(ms).padStart(3, "0")}`;
    }

    return `${hh}:${mm}:${ss},${String(ms).padStart(3, "0")}`;
  }

  function sanitizeFileName(value) {
    // Same forbidden set as Obsidian, so wiki links to the note resolve.
    return value.replace(/[\\/:*?"<>|#^[\]]/g, "_").replace(/\s+/g, " ").trim().slice(0, 120);
  }


  function buildNoteFilename(meta, settings, created = formatLocalDate()) {
    const baseParts = [];

    if (settings?.includeDateInFilename !== false) {
      baseParts.push(created);
    }

    baseParts.push(meta.title || meta.videoId || "video-subtitle");

    if (Number(meta.pageCount) > 1) {
      baseParts.push(`P${Number(meta.pageIndex) > 0 ? Number(meta.pageIndex) : 1}`);
      const pageTitle = String(meta.pageTitle || "").trim();
      if (pageTitle) {
        baseParts.push(pageTitle);
      }
    }

    const baseName = sanitizeFileName(baseParts.filter(Boolean).join("-"));
    return `${baseName || "video-subtitle"}.md`;
  }

  function normalizeFolder(input) {
    return String(input || "").trim().replace(/^\/+|\/+$/g, "");
  }


  function escapeYaml(value) {
    return String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n").replaceAll("\r", "\\r").replaceAll("\t", "\\t");
  }

  // Chat-answer Markdown to HTML for the side panel and the history page. HTML is escaped first,
  // so only the tags built here reach the page.
  function renderMarkdown(text) {
    let escaped = escapeHtml(stripThinkBlocks(text));
    const codeBlocks = [];
    escaped = escaped.replace(/```([\s\S]*?)```/g, (_, code) => {
      codeBlocks.push(code);
      return `\u0001BOC_CODE_${codeBlocks.length - 1}\u0001`;
    });

    const lines = escaped.split("\n");
    const out = [];
    let listType = "";
    let listStartNumber = 1;
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
      listStartNumber = 1;
    };
    const openList = (nextType, startNumber = 1) => {
      if (listType === nextType && (nextType !== "ol" || listStartNumber === startNumber)) {
        return;
      }
      closeList();
      listType = nextType;
      listStartNumber = nextType === "ol" ? startNumber : 1;
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

      const codeMatch = line.match(/^\u0001BOC_CODE_(\d+)\u0001$/);
      if (codeMatch) {
        flushPara();
        closeList();
        out.push(`<pre><code>${codeBlocks[Number(codeMatch[1])]}</code></pre>`);
        continue;
      }

      const heading = line.match(/^(#{1,3})\s+(.+)$/);
      if (heading) {
        flushPara();
        closeList();
        const level = heading[1].length + 2;
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
    return out.join("");
  }

  function renderInline(text) {
    return text
      .replace(/`([^`]+)`/g, (_, c) => (isTimestampOnlyInlineCode(c) ? c : `<code>${c}</code>`))
      .replace(/\*\*([^*\n]+)\*\*/g, (_, c) => `<strong>${c}</strong>`)
      .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, (_, pre, c) => `${pre}<em>${c}</em>`)
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, u) => {
        const safeUrl = /^(https?:|mailto:|#)/i.test(u) ? u : "#";
        return `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${t}</a>`;
      });
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  globalThis.BocNote = {
    DEFAULT_FRONTMATTER_FIELDS,
    buildMarkdown,
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
    buildNoteFilename,
    resolveFolderTemplate,
    buildSubtitlePreview,
    buildSrt,
    buildTxt,
    shouldShowHoursInNote,
    formatLocalDate,
    formatCompactTimestamp,
    formatTimestamp,
    sanitizeFileName,
    escapeYaml
  };
})();
