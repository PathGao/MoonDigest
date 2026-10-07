// Dev-only fake chrome.* for opening triage.html from a static server. No-op inside the real extension.
(() => {
  if (globalThis.chrome?.runtime?.id) return;

  globalThis.__TRIAGE_THROTTLE_MS = 5000; // real page waits 10 min
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const clone = (v) => (v === undefined ? v : structuredClone(v));

  // ----- storage -----
  const store = {
    aiProviderKeys: { openai: "sk-should-never-export" },
    obsidianApiKey: "secret-token",
    // Per-video notes (triage_notes): one seeded so a filled note shows without typing.
    triage_notes: { BV1mock0001: { text: "第 3 节的重构步骤可以直接套到自己的项目", updatedAt: Date.now() } },
    // Old scheme data, so the page's one-time migration has something to fold: 稍后-AI (seen, unmapped) gets the
    // default criteria, 学习 its scheme's; tags become AI工程 + 工具 + 数学, s-ai merges into t-ai, s-unused is dropped.
    triage_schemes: [
      { id: "default", name: "默认方案", criteria: "只留 AI 工程实践的深度内容，资讯可清理", tags: [{ id: "t-ai", name: "AI工程", description: "大模型实践", color: "#da86c3" }, { id: "t-tool", name: "工具", color: "#298287" }] },
      { id: "s-study", name: "学习", criteria: "只留系统课程", tags: [{ id: "s-math", name: "数学", color: "#dc6d2d" }, { id: "s-ai", name: "AI工程", color: "#3590a0" }, { id: "s-unused", name: "没用到", color: "#8595ea" }] }
    ],
    triage_folder_scheme: { 1002: "s-study" },
    triage_decisions_1001: {},
    triage_video_tags: { BV1mock0001: ["t-ai"], BV1mock0040: ["s-math", "s-ai"] }
  };
  function makeArea(data) {
    return {
      async get(keys) {
        await wait(5);
        if (keys == null) return clone(data);
        const list = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
        const out = {};
        for (const k of list) {
          if (k in data) out[k] = clone(data[k]);
          else if (typeof keys === "object" && !Array.isArray(keys)) out[k] = keys[k];
        }
        return out;
      },
      async set(obj) {
        Object.assign(data, clone(obj));
      },
      async remove(keys) {
        for (const k of [].concat(keys)) delete data[k];
      }
    };
  }

  // ----- fake data -----
  const titles = [
    "从零实现一个 Transformer：逐行代码讲解", "Claude Code 实战：用 Agent 重构遗留项目", "【合集】吴恩达机器学习 2024 中文字幕",
    "RAG 到底怎么做才靠谱？踩坑三个月的总结", "大模型推理加速：vLLM 原理解析", "一口气看完 AI 圈本周新闻",
    "LoRA 微调手把手：8G 显存也能跑", "已失效视频", "Prompt 工程已死？聊聊上下文工程",
    "用 Cursor 写一个完整的记账 App", "深度学习数学基础：矩阵求导速通", "【直播回放】AI 创业者圆桌讨论 3 小时",
    "MCP 协议是什么？10 分钟讲清楚", "开源模型横评：Qwen / Llama / DeepSeek", "我用 AI 做了 100 天自媒体的真实收入",
    "Diffusion 模型原理图解", "Obsidian + AI 打造第二大脑", "搞笑配音：当 ChatGPT 学会了东北话",
    "向量数据库选型对比", "已失效视频", "强化学习入门：从多臂老虎机到 PPO",
    "AI Agent 设计模式 12 讲（第 1 讲）", "三分钟看懂 Sora 技术报告", "程序员会被 AI 取代吗？",
    "LangGraph 构建多智能体工作流", "【教程】本地部署 DeepSeek R1", "AI 绘画商业变现全攻略",
    "评测：十款 AI 编程助手哪家强", "注意力机制可视化讲解", "Kaggle 金牌方案复盘",
    "我的 AI 工作流分享（2025 版）", "模型量化 GPTQ / AWQ 对比", "闲聊：做 AI 产品的一年",
    "已失效视频", "Embedding 模型怎么选", "神经网络反向传播手推",
    "AI 写论文靠谱吗？实测", "如何评估大模型：Benchmark 的坑", "Function Calling 实战", "年度 AI 回顾"
  ];
  const uppers = "ABCDEFGH".split("").map((c) => `示例UP主${c}`);
  const cover = (i) =>
    "data:image/svg+xml," +
    encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90"><rect width="160" height="90" fill="hsl(${(i * 47) % 360},45%,60%)"/><text x="80" y="54" font-size="22" text-anchor="middle" fill="white">${i + 1}</text></svg>`);
  let seq = 0;
  function makeItem(title) {
    const i = seq++;
    const invalid = title === "已失效视频";
    return {
      bvid: `BV1mock${String(i).padStart(4, "0")}`,
      aid: 900000 + i,
      title,
      cover: cover(i),
      upper: invalid ? "" : uppers[i % uppers.length],
      duration: 120 + ((i * 397) % 3600),
      pubdate: 1717000000 + i * 86400,
      favTime: 1720000000 + i * 3600,
      intro: invalid ? "" : `这是《${title}》的简介。`,
      invalid,
      _i: i
    };
  }

  const ai = titles.map(makeItem);
  const study = ["线性代数的本质 01", "费曼学习法", "如何高效读论文", "统计学习方法导读", "英语听力训练"].map(makeItem);
  // 默认收藏夹 overlaps both others (same videos), for the 所有收藏夹 view.
  const folders = [
    { id: 1001, title: "稍后-AI", items: ai },
    { id: 1002, title: "学习", items: study },
    { id: 1003, title: "默认收藏夹", items: [ai[1], ai[12], study[0], ...["家常红烧肉的做法", "十分钟早餐：葱油拌面"].map(makeItem)] }
  ];
  // ?fresh shows the first-run folder picker; otherwise every folder is chosen and 已出分拣范围 has records of each kind:
  // one old record without an origin, one hidden, one moved, one that left one folder, one that left two, one that left three.
  if (!/[?&]fresh\b/.test(location.search)) {
    store.triage_included_folders = ["1001", "1002", "1003"];
    const gone = ["老记录：没有来源信息", "被 B 站隐藏的视频", "移到了没勾选的收藏夹", "只离开了一个收藏夹", "先离开 A 再离开 B 的视频", "离开了三个收藏夹的视频"].map(makeItem);
    const day = 86400000;
    const now = Date.now();
    const f = (id, title, at) => ({ id, title, at });
    store.triage_removed = {
      [gone[0].bvid]: { item: gone[0], at: now - 9 * day },
      [gone[1].bvid]: { item: gone[1], at: now - 5 * day, hidden: true, from: [f("1001", "稍后-AI", now - 5 * day)] },
      [gone[2].bvid]: { item: gone[2], at: now - 3 * day, movedTo: { id: "1004", title: "美食" }, from: [f("1003", "默认收藏夹", now - 3 * day)] },
      [gone[3].bvid]: { item: gone[3], at: now - 2 * day, from: [f("1002", "学习", now - 2 * day)] },
      [gone[4].bvid]: { item: gone[4], at: now - day, from: [f("1001", "稍后-AI", now - 6 * day), f("1002", "学习", now - day)] },
      [gone[5].bvid]: { item: gone[5], at: now - 3600000, from: [f("1001", "稍后-AI", now - 8 * day), f("1002", "学习", now - 4 * day), f("1003", "默认收藏夹", now - 3600000)] }
    };
  }

  // ?demo swaps in the README screenshot data: B站-style titles and covers, every step filled, tags, 优先看, notes and
  // watch progress (seenShow 进度条和看完了标记). Nothing here is a real account's data.
  const demoSync = {};
  if (/[?&]demo\b/.test(location.search)) {
    const day = 86400000;
    const now = Date.now();
    const art = (title, sub, [a, b]) =>
      "data:image/svg+xml," +
      encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="320" height="180" fill="url(#g)"/><circle cx="268" cy="40" r="70" fill="#fff" opacity=".12"/><text x="22" y="86" font-family="PingFang SC, sans-serif" font-size="34" font-weight="800" fill="#fff">${title}</text><text x="22" y="126" font-family="PingFang SC, sans-serif" font-size="20" font-weight="600" fill="#fff" opacity=".9">${sub}</text></svg>`);
    // [title, upper, seconds, cover big, cover small, colors]
    const rows = [
      ["Excel 数据透视表从入门到精通，看这一个就够了", "表格研究社", 1475, "数据透视表", "从入门到精通", ["#1d8f5a", "#0d5c3a"]],
      ["零基础学 Python：用 30 行代码批量重命名文件", "码农阿杰", 728, "30 行 Python", "批量重命名文件", ["#3a6fd8", "#22408a"]],
      ["手机摄影构图的 9 个技巧，随手拍出电影感", "慢慢学摄影", 906, "9 个构图技巧", "手机也能拍出电影感", ["#d9822b", "#8a3d12"]],
      ["Git 原理图解：commit、branch 到底是什么", "量子土豆", 1141, "Git 原理图解", "commit / branch", ["#e2553f", "#7d2418"]],
      ["2026 年最值得买的 5 款降噪耳机（文末抽奖）", "木子说数码", 587, "降噪耳机横评", "5 款怎么选", ["#4b4f63", "#1f2230"]],
      ["一口气看完日本战国史：从应仁之乱到关原合战", "阿北的书房", 2530, "日本战国史", "一口气看完", ["#8a5a3c", "#3f2617"]],
      ["【干货】PPT 配色只需要记住这三条", "设计小周", 492, "PPT 配色", "只记这三条", ["#b04fc1", "#5b2370"]],
      ["震惊！这个方法让我一周背完 3000 个单词", "英语每日一练", 371, "一周 3000 词", "真的假的？", ["#e8b21f", "#a3640b"]],
      ["从零搭建个人博客：域名、服务器、部署全流程", "小周爱折腾", 1863, "搭建个人博客", "域名到部署", ["#2a9d8f", "#145049"]],
      ["Photoshop 抠图 6 种方法对比，头发丝也能抠干净", "设计小周", 1022, "PS 抠图对比", "6 种方法", ["#3d7fb8", "#1c3f5e"]],
      ["SQL 窗口函数一次讲透：排名、累计、同比", "表格研究社", 1388, "SQL 窗口函数", "一次讲透", ["#5b6ee1", "#2b3590"]],
      ["家用 NAS 入门：买什么、怎么装、装什么", "木子说数码", 1540, "家用 NAS 入门", "买什么 · 怎么装", ["#46526b", "#1c2333"]],
      ["Markdown 十分钟上手，写笔记再也不乱", "码农阿杰", 615, "Markdown", "十分钟上手", ["#6b7280", "#30343c"]],
      ["Linux 常用命令 50 个，收藏起来慢慢看", "量子土豆", 2210, "Linux 命令", "常用 50 个", ["#1f2937", "#0b0f17"]]
    ];
    const items = rows.map(([title, upper, duration, big, small, colors], i) => ({
      bvid: `BV1demo${String(i + 1).padStart(5, "0")}`,
      aid: 700000 + i,
      title,
      cover: art(big, small, colors),
      upper,
      duration,
      pubdate: Math.floor((now - (40 - i) * day) / 1000),
      favTime: Math.floor((now - (20 - i) * day) / 1000),
      intro: `${title}。`,
      invalid: false,
      _i: i
    }));
    const [pivot, py, photo, git, earbuds, history, ppt, words, blog, ps] = items;
    const folder = (id, title, list) => ({ id, title, items: list });
    folders.splice(0, folders.length, folder(2001, "想学的技能", items), folder(2002, "做饭合集", []), folder(2003, "默认收藏夹", [items[0], items[5]]));
    folders[0].cover = items[3].cover;
    folders[1].cover = art("家常菜", "", ["#e07a3f", "#8f3a14"]);
    folders[2].cover = items[0].cover;
    for (const k of Object.keys(store)) delete store[k];
    const analysis = (it, verdict, reason, oneLiner, points, source = "subtitle") => {
      store[`triage_title_${it.bvid}`] = { verdict, reason, confidence: "high" };
      store[`triage_analysis_${it.bvid}`] = { bvid: it.bvid, status: "done", source, oneLiner, points, verdict, reason, model: "deepseek-flash", analyzedAt: now - day };
    };
    analysis(pivot, "keep", "跟着做就能学会，符合收藏夹用途", "用一份销售表演示数据透视表的建表、分组、筛选和切片器。", ["拖字段建表：行、列、值三个区域各放什么", "按月和按季度分组，一键出同比", "切片器联动多张表，做出简单看板"]);
    analysis(py, "keep", "能直接上手的教程", "从读取文件夹开始，一步步写出批量重命名脚本。", ["os 和 pathlib 遍历文件夹", "用正则提取编号并补零", "先打印预览再真正改名，避免改错"]);
    analysis(photo, "unsure", "技巧实用，但和收藏夹的学习方向关系不大", "九种常见构图，每种配一组手机实拍对比。", ["三分法和引导线最容易上手", "低角度和框架构图让画面有层次", "后期只调曝光和色温就够了"]);
    analysis(git, "keep", "讲透原理，正是这个收藏夹要的", "用画图的方式讲清 commit、branch 和 HEAD 的关系。", ["commit 是快照，不是差异", "branch 只是指向 commit 的指针", "rebase 和 merge 的区别在历史长什么样"]);
    analysis(earbuds, "drop", "带货测评，时效性强", "五款降噪耳机的音质、降噪和续航对比。", ["降噪最强的价格也最高", "通勤场景推荐中端款", "文末抽奖和购买链接"], "meta");
    analysis(history, "unsure", "内容扎实但偏兴趣，不是技能教程", "按时间线串起日本战国时代的主要人物和战役。", ["应仁之乱开启战国时代", "织田、丰臣、德川三人的接力", "关原合战奠定江户幕府"]);
    const title = (it, verdict, reason) => (store[`triage_title_${it.bvid}`] = { verdict, reason, confidence: "high" });
    title(ppt, "keep", "标题显示为实操教程");
    title(words, "drop", "标题党，信息量低");
    title(blog, "keep", "完整的搭建教程");
    title(ps, "unsure", "标题信息不足，需要读字幕");
    const tag = (id, name, color) => ({ id, name, color, folder: "2001" });
    Object.assign(store, {
      triage_simplified_v1: true,
      triage_tags_by_folder_v1: true,
      triage_kept_v1: true,
      triage_included_folders: ["2001", "2002", "2003"],
      triage_last_folder: 2001,
      triage_folder_criteria: { 2001: "只留能跟着做的教程和讲透原理的内容；资讯、带货、标题党可清理" },
      triage_tags: [tag("t-basic", "入门", "#da86c3"), tag("t-adv", "进阶", "#298287"), tag("t-tool", "办公", "#dc6d2d")],
      triage_video_tags: { [pivot.bvid]: ["t-basic", "t-tool"], [py.bvid]: ["t-basic"], [git.bvid]: ["t-adv"], [items[12].bvid]: ["t-basic"], [items[13].bvid]: ["t-adv"] },
      triage_kept: { [items[12].bvid]: { action: "keep", at: now - 2 * day }, [items[13].bvid]: { action: "keep", at: now - 2 * day } },
      triage_watched: { [py.bvid]: now - day },
      triage_basket: [pivot, git, blog].map(({ bvid, title, cover, upper, duration }) => ({ bvid, title, cover, upper, duration })),
      triage_notes: { [git.bvid]: { text: "周末配合官方文档一起看，第 3 节的图要截下来", updatedAt: now - 3 * day } },
      triage_removed: {},
      [`seen_${pivot.bvid}`]: [83, now - 2 * day],
      [`seen_${py.bvid}`]: [100, now - day],
      [`seen_${photo.bvid}`]: [16, now - 4 * day],
      [`seen_${history.bvid}`]: [40, now - 6 * day]
    });
    Object.assign(demoSync, { seenShow: "both", seenThreshold: 80, seenStyle: "badge", obsidianEnabled: true });
  }

  const removed = new Map(); // "mediaId:aid" -> { folder, item, index }
  const throttledOnce = new Set();
  let lastMediaId = 1001;
  let aiCommandCalls = 0;

  const findItem = (bvid) => folders.flatMap((f) => f.items).find((it) => it.bvid === bvid) || [...removed.values()].find((r) => r.item.bvid === bvid)?.item;
  const pub = ({ _i, ...rest }) => rest;
  const noAi = () => ({ ok: false, error: "还没有可用的模型，请先配置 AI 服务" });

  // ----- handlers -----
  const handlers = {
    // 默认收藏夹 has no cover, so the hue block fallback shows too.
    "triage-folders": () => ({ ok: true, data: { mid: 12345, folders: folders.map((f, i) => ({ id: f.id, title: f.title, count: f.items.length, cover: f.cover ?? (i < 2 ? cover(i * 9 + 3) : "") })) } }),
    "triage-folder-items": ({ mediaId }) => {
      const f = folders.find((x) => String(x.id) === String(mediaId));
      if (!f) return { ok: false, error: "收藏夹不存在" };
      lastMediaId = f.id;
      // Like the background: one triage-folder-page broadcast per finished page while more pages follow.
      for (let page = 1; page * 20 < f.items.length; page++) msgListeners.forEach((fn) => fn({ type: "triage-folder-page", mediaId: String(f.id), page }));
      // __mockPartial = true simulates page 2 failing: only the first 20 items come back.
      if (globalThis.__mockPartial && f.items.length > 20) {
        return { ok: true, data: { items: f.items.slice(0, 20).map(pub), partial: { page: 2, error: "B站返回 -352: 风控校验失败" } } };
      }
      return { ok: true, data: { items: f.items.map(pub) } };
    },
    "triage-folder-ids": ({ mediaId }) => {
      const f = folders.find((x) => String(x.id) === String(mediaId));
      return f ? { ok: true, data: { bvids: f.items.map((it) => it.bvid) } } : { ok: false, error: "收藏夹不存在" };
    },
    // Of the 已出分拣范围 records, the moved one and 「只离开了一个收藏夹」 are still in the unchosen 美食; the rest are in none.
    "triage-fav-where": ({ aid }) => {
      const title = Object.values(store.triage_removed || {}).find((r) => r.item.aid === aid)?.item.title || "";
      return { ok: true, data: { folders: /移到了没勾选|只离开了一个/.test(title) ? [{ id: "1004", title: "美食" }] : [] } };
    },
    "triage-title-get": ({ bvids }) => ({ ok: true, data: Object.fromEntries(bvids.map((b) => [b, store[`triage_title_${b}`] || null])) }),
    "triage-analysis-get": ({ bvids }) => ({ ok: true, data: Object.fromEntries(bvids.map((b) => [b, store[`triage_analysis_${b}`] || null])) }),
    // Requests carry the folder's 判断标准; the AI answers one of keep / drop / unsure.
    "triage-classify-titles": async ({ items }) => {
      await wait(400);
      if (globalThis.__mockNoAI) return noAi();
      if (globalThis.__mockHostDenied) return { ok: false, error: "未授权访问 https://api.example.com，授权后重试" };
      const results = {};
      for (const { bvid } of items) {
        const i = findItem(bvid)._i;
        const verdict = ["keep", "drop", "unsure", "unsure", "keep"][i % 5];
        const reason = { keep: "标题显示为系统教程", drop: "资讯/娱乐类，时效性强", unsure: "标题信息不足" }[verdict];
        const r = { verdict, reason, confidence: i % 7 === 0 ? "low" : "high" };
        results[bvid] = r;
        store[`triage_title_${bvid}`] = r;
      }
      return { ok: true, data: { results } };
    },
    "triage-analyze": async ({ bvid }) => {
      await wait(300);
      if (globalThis.__mockNoAI) return noAi();
      const it = findItem(bvid);
      if (it._i === 2) return { ok: false, error: "字幕获取失败：网络超时" };
      if (it._i === 8 && !throttledOnce.has("truncate")) {
        throttledOnce.add("truncate");
        return { ok: false, error: "模型输出被截断（max_tokens 不足）" };
      }
      if (it._i === 3 && !throttledOnce.has(bvid)) {
        throttledOnce.add(bvid);
        return { ok: false, error: "请求过于频繁", code: "THROTTLED" };
      }
      const verdict = ["keep", "drop", "unsure"][it._i % 3];
      const a = {
        bvid,
        status: "done",
        source: it._i % 2 ? "subtitle" : "meta",
        oneLiner: `${it.title.slice(0, 12)}：核心观点是先理解原理再动手。`,
        points: ["讲清了基本概念和适用场景", "给出了一个可运行的完整示例", "最后总结了常见误区"],
        verdict,
        reason: { keep: "有可复用的方法论", drop: "内容浅，信息量低", unsure: "部分有用，需要自己判断" }[verdict],
        model: "mock-model",
        analyzedAt: Date.now()
      };
      store[`triage_analysis_${bvid}`] = a;
      return { ok: true, data: a };
    },
    "triage-ai-command": async ({ items, tags: tagList }) => {
      await wait(300);
      const tags = tagList.map((t) => t.name);
      aiCommandCalls++;
      if (aiCommandCalls === 2) return { ok: false, error: "模型返回的 JSON 无法解析" };
      const depth = (title) => (/入门|手把手|速通|三分钟|10 分钟|是什么/.test(title) ? "入门" : /原理|数学|手推|推导|解析|可视化/.test(title) ? "硬核" : "");
      const newTags = ["入门", "硬核"].filter((name) => !tags.includes(name));
      const allowed = new Set([...tags, ...newTags]);
      const assignments = {};
      items.forEach((it, i) => {
        const add = [];
        const d = depth(it.title);
        if (d && allowed.has(d)) add.push(d);
        if (tags.length && i % 3 === 0) add.push(tags[i % tags.length]);
        const remove = it.currentTags && i % 4 === 0 ? [it.currentTags[0]] : [];
        const a = { add, remove, reason: d ? `标题显示为${d}内容` : "按指令归类" };
        if (add.length || remove.length) assignments[it.bvid] = a;
      });
      return { ok: true, data: { newTags, assignments, note: `按指令处理了 ${items.length} 个视频` } };
    },
    "triage-unfav": ({ mediaId, aids }) => {
      const f = folders.find((x) => String(x.id) === String(mediaId));
      for (const aid of aids) {
        const index = f.items.findIndex((it) => it.aid === aid);
        if (index >= 0) removed.set(`${f.id}:${aid}`, { folder: f, item: f.items.splice(index, 1)[0], index });
      }
      return { ok: true, data: { done: aids.length } };
    },
    "triage-refav": ({ mediaId, aid }) => {
      const r = removed.get(`${mediaId}:${aid}`);
      if (!r) return { ok: false, error: "找不到要恢复的视频" };
      r.folder.items.splice(Math.min(r.index, r.folder.items.length), 0, r.item);
      removed.delete(`${mediaId}:${aid}`);
      return { ok: true, data: { done: 1 } };
    },
    "triage-settings-get": () => ({
      ok: true,
      data: { thinkingToggle: true, triageIntervalSec: 1, triageTitleBatchSize: 15, triageThinking: false, triageTitleMaxTokens: 0, triageAnalyzeMaxTokens: 0, ...store.__settings }
    }),
    "triage-settings-save": ({ type, ...patch }) => {
      store.__settings = { ...store.__settings, ...patch };
      return { ok: true, data: store.__settings };
    },
    "triage-export": ({ filename, markdown }) => {
      globalThis.__mockExported = { filename, markdown };
      return { ok: true, data: { path: `B站摘录/${filename}` } };
    },
    "triage-build-note": ({ bvid }) => ({
      ok: true,
      data: { title: `视频 ${bvid}`, filename: `2026-10-08-视频 ${bvid}.md`, markdown: `---\ntitle: "视频 ${bvid}"\nurl: "https://www.bilibili.com/video/${bvid}/"\n---\n\n## 字幕\n\n（mock）\n` }
    }),
    "triage-write-note": ({ bvid }) => ({ ok: true, data: { path: `B站摘录/${bvid}.md`, title: `视频 ${bvid}`, source: "subtitle" } }),
    "open-options": () => {
      console.info("[mock] open-options");
      return { ok: true };
    }
  };

  // Simulates changes made directly on Bilibili: remove 2, add 3, re-favorite 1 unfavorited, 1 newly invalid.
  globalThis.__mockSimulateBiliChange = () => {
    const f = folders.find((x) => x.id === lastMediaId);
    const victims = f.items.filter((it) => !it.invalid).slice(-2);
    f.items = f.items.filter((it) => !victims.includes(it));
    f.items.unshift(...["新收藏：Agent 记忆系统设计", "新收藏：AI 播客剪辑技巧", "新收藏：多模态模型综述"].map(makeItem));
    const back = [...removed.entries()].find(([, r]) => r.folder === f);
    if (back) handlers["triage-refav"]({ mediaId: f.id, aid: back[1].item.aid });
    const flip = f.items.find((it) => !it.invalid && it._i > 30 && it._i < titles.length);
    if (flip) {
      flip.invalid = true;
      flip.title = "已失效视频";
    }
    return { removed: victims.map((it) => it.title), reAdded: back?.[1].item.title || null };
  };

  const msgListeners = [];
  const prev = globalThis.chrome || {};
  globalThis.chrome = Object.assign(prev, {
    runtime: {
      id: undefined,
      lastError: undefined,
      getManifest: () => ({ version: "dev" }),
      getURL: (p) => new URL(`../${p}`, location.href).href,
      onMessage: { addListener: (fn) => msgListeners.push(fn) },
      sendMessage(msg, cb) {
        (async () => {
          await wait(150);
          const h = handlers[msg?.type];
          const resp = h ? await h(clone(msg)) : { ok: false, error: `mock: 未知消息 ${msg?.type}` };
          cb?.(clone(resp));
        })();
      }
    },
    tabs: {
      getCurrent: async () => ({ id: 1, windowId: 1 }),
      create({ url }) {
        (globalThis.__mockOpened ||= []).push(url);
        console.info("[mock] tabs.create", url);
      }
    },
    sidePanel: {
      async open(opts) {
        (globalThis.__mockSidePanel ||= []).push(opts);
        console.info("[mock] sidePanel.open", opts);
      }
    },
    storage: { local: makeArea(store), sync: makeArea(demoSync), onChanged: { addListener() {} } },
    permissions: {
      async request(req) {
        (globalThis.__mockPermissionRequests ||= []).push(req);
        globalThis.__mockHostDenied = false;
        return true;
      }
    }
  });
  console.info("[mock] chrome API mocked for triage dev");
})();
