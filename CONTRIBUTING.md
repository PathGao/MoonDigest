# 参与开发

一个 PR 只做一件可审阅的事。较大的功能方向请先开 issue 讨论。说明问题、改后的行为和相关取舍；
写出跑过的命令、结果，以及没能验证的部分。

提 PR 前请先跑一遍自检。界面和用词规则见 [设计规范](docs/DESIGN.md)，
改界面的 PR 要同步改它。

完成 issue 的 PR 写 `Closes #123` 或 `Fixes #123`，合并时自动关闭。只完成一部分时写
`Related to #123` 并说明剩下什么。没有发版确认或超时关闭机器人。

提交信息和 PR 用中文或英文都可以。仓库设置和 label 约定见 [仓库治理](.github/GOVERNANCE.md)。

贡献的代码按本仓库的 GPL-3.0 许可证发布，不需要签 CLA。

## 代码结构

不需要构建，`extension/` 就是可以直接加载的扩展目录。

```
extension/
├── manifest.json
├── sites.js        B站和 YouTube 的视频信息、字幕、评论抓取
├── note.js         笔记生成：Markdown、frontmatter、SRT、TXT
├── content.js      视频页：字幕抓取、专注模式、播放器 ✦ AI 总结按钮
├── background.js   后台：AI 请求、权限、旧数据清理
├── obsidian.js     后台：写入 Obsidian（唯一的写入者）
├── sidepanel.*     AI 侧边栏
├── popup.*         插件弹窗
├── options.*       设置页
├── badges.*        B站页面上的标记：分拣结论、标签、观看进度
├── hydration.js    在 B站页面自己的环境里跑：Vue 3 页面接管（水合）完之前给 <html> 打上 data-mdg-ssr，标记等它
├── bili-surfaces.js 每种 B站页面显示哪些标记，观看进度的读法和文案（标记和分拣台共用）
├── tag-core.js     标签规则和 AI 结论，分拣台、B站页面、笔记共用
├── typing.js       输入法组字和输入框里的按键判断，各页面共用
├── download.js     扩展页面的下载文件、「该笔记已存在」选择
├── common.js       处处都用的纯函数和常量（日期、文件名、时间和计数解析、页面路径），每处最先加载
├── limits.js       各类数据的上限，和设置页「数据与存储」共用
├── errors.js       页面怎么显示错误：共用的错误文案、错误码对应的按钮
├── settings.js     设置的默认值，和几个页面共用的设置整理函数
├── tokens.css      共享的颜色、字号、间距（含深色主题）
├── triage/         B站分拣台：收藏夹（fav-*.js，由 triage.js 启动，纯函数在 triage-core.js）、关注（follow.js，纯函数在 follow-core.js），后台接口 triage-bg.js、follow-bg.js
├── history/        摘读记录页
├── vendor/         第三方代码：defuddle.js（网页正文提取，`scripts/update-defuddle.sh <版本>` 更新，要 bash）
├── dev-sidepanel/  侧边栏的开发预览
└── dev/            设置页的开发用假数据
```

## 自检

自检（用 Node 24，Mac、Windows、Linux 同一条命令；`node` 指向 bun 套壳或 v26 时有几个会卡住或报错，本机的 Node 24 在 `/usr/local/bin/node`）：

`load-order.selftest.js` 检查每个页面、每组内容脚本和后台 `importScripts` 的加载顺序：定义全局对象的文件要排在用到它的文件前面，引用的脚本都要存在，`common.js` 排第一。运行环境和各自加载的脚本由 `page-sources.selftest.js` 列出；按页面查代码的测试和约定检查从它取文件清单，不按文件名读，代码换到同一页面的另一个文件也照样查得到。

`conventions.selftest.js` 检查开关取值、存储键名、灰掉写原因、回复的错误经 `MdgErrors.text` 显示、共享记录经各自的串行写入函数读改写这几条约定；`wording.selftest.js` 检查界面文字：文字表里的话别处不再写一份、同一句话不在两个页面各写一份、不用术语表里「不用」的词；`messages.selftest.js` 核对消息清单 `messages.js`（每条消息谁发、谁接、带哪些字段）和代码一致。这几个是读源码的约定检查，不是行为测试。规则和允许清单怎么加见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

```bash
node scripts/selftest.mjs
```

## 冒烟测试

自检在 vm 里跑页面，会去掉启动代码，页面一打开就崩它查不出来。`/usr/local/bin/node scripts/smoke.mjs` 用真 Chrome（无头、临时配置）装扩展，打开每个页面（没配和配了 AI 平台各一次）、后台和 B站、YouTube 视频页，扩展有未捕获错误或 `console.error` 就失败。B站视频页、`/list/` 播放页和搜索页（`BILI_PAGES`）按 `SEEDS` 里的每份存储各开一次（空的；关注了该 UP 且有 UP 标签的；和把 AI 判断、保留/取消收藏、视频标签、推荐卡片的 UP 标签、观看进度都点亮的），每次都要看到种子该画的标记、不该画的地方没画（搜索卡片、`/list/` 播放页列表顶上「UP主的全部视频」的 UP 标签，`/list/` 大标题上的标记），B站自己的内容还在，播放页的评论区加载出来、网页全屏铺满窗口；B站自己也不能多出同页空存储那次没有的未捕获异常，不能把页面整个重画（Vue 2 换掉 `#app`、Vue 3 报接管不一致）。B站不给页面（海外机器上常见）时跳过该页的种子检查。之后分拣台、摘读记录和侧边栏带着存储里的数据再开一次，要画出数据（`?demo` 只在开发预览里生效，扩展里不起作用）。页面脚本查找的每个 id 都要在打开的页面、html 或脚本模板里找得到（页面自检的假 DOM 什么 id 都给元素，查不出 id 改名或删掉）。每个 PR 和发版前 GitHub Actions 都会跑自检和这一项（`.github/workflows/check.yml`）。

## 不装插件预览页面

不装插件预览页面：在 `extension/` 下起静态服务（`python3 -m http.server 8000`），打开 `/triage/triage.html` 或 `/history/history.html`，会自动加载各自 `dev/mock-chrome.js` 里的假数据。侧边栏先运行 `/usr/local/bin/node extension/dev-sidepanel/build.mjs`，再打开 `/dev-sidepanel/index.html`；生成的 `index.html` 也提交，改了 `sidepanel.html` 要重新生成，自检会核对。设置页要在页面脚本运行前注入 `dev/options-mock.js`（比如用 CDP 的 `Page.addScriptToEvaluateOnNewDocument`），再打开 `/options.html`。分拣台、摘读记录和侧边栏的地址加 `?demo`，换成 README 截图用的演示数据（设置页的假数据本身就是）。

## 打包

打包：`python3 scripts/build_release.py`，产物在 `release/` 下，开发用的假数据和自检不会打进去。README 的版本徽章和 `manifest.json` 的版本不一致时打包会失败。推送 `v` 开头的标签会由 GitHub Actions 自动打包、发布 Release，并上传 Chrome 应用商店提交审核。已有的标签也可以在 Actions 里手动重新发布。

## YouTube 字幕

YouTube 字幕的取法参照 yt-dlp：读页面播放器的字幕轨。需要校验参数（PO token）时，从播放器已发出的字幕请求里取。拿不到时依次退回安卓客户端、嵌入式播放器和转写文稿接口。这依赖播放器的内部实现，YouTube 改版后需要跟进。
