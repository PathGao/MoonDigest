# MoonDigest 工程约定

这里记的是代码怎么组织、哪些东西只写一份。界面和交互的规则看 [DESIGN.md](DESIGN.md)。

B站 页面上的颜色是 `tokens.css` 的第三份拷贝：`content.css` 里的 `--boc-*`（`content-tokens.selftest.js` 会核对）和 `badges.css` 里直接写的色值（也由 `content-tokens.selftest.js` 核对，新写死的色值要加进它的 `BADGE_TOKENS` 表）。改 token 时，在同一个 PR 里把这两处一起改。

## 代码怎么共用

- 两种模式都画的东西，只在 `extension/triage/shared.js`（`TriageUi`）里写一份：标题行、排序、搜索框、筛选片、第 3/4 行的行名（`labeledRow`）、「AI 刚打的」片（`aiRecentChip`）、选中栏（`selbar`）、移动 / 复制弹窗（`askTransfer`：收藏夹传收藏夹，关注传分组）、左栏项（`sideItem`）、刷新和导出按钮、进度胶囊、空状态和里面的刷新（`refreshEmpty`）、头部随滚动收起（`headroom`）、列表为空的原因（`noMatch`）、撤销前的确认（`undoAsk`）、设置行（`fillSetRows`，包括「AI 打标签每批数量」）、格式化函数、AI 建议的合并（标签名清洗和标签颜色在 `extension/tag-core.js`）。「收藏夹设置」和「关注设置」两个弹窗的结构都写在 `triage.html` 里。发现两边各写了一份，就合并进去。
- 打标签面板只有一个：`extension/triage/tag-picker.js`。例外：B站 页面上的「+」标签面板（`badges.js`）在封闭的 shadow DOM 里，暂时用不了 tag-picker.js，标签的纯函数（颜色、标签名清洗、新标签 id、下一个颜色）放在 `extension/tag-core.js`（`BocTagCore`）里，`badges.js`、`shared.js`、`follow.js` 和 `triage.js` 都用它，manifest 和 `triage.html` 都在它们之前加载。`tag-core.selftest.js` 会查别处有没有再写一份。面板本身以后再迁到 tag-picker.js。「标签管理」和「✦ AI 打标签」弹窗也各只有一个：`extension/triage/tag-dialogs.js`；关注的「分组管理」也用「标签管理」这个弹窗，adapter 换掉标题、文字和每行的样子。模式打开它们时只传一个 adapter，里面是单位（视频 / UP 主）、上限和数据，文字、布局和确认页的计数（改动数、按标签汇总、「用在 N 个」）都在弹窗里。
- 所有输入框和快捷键都要走 `extension/typing.js`（`BocTyping`）：
  - 回车和 Esc 的处理函数，开头先写 `if (BocTyping.composing(e)) return;`。
  - 全局快捷键，开头写 `if (composing(e) || typingIn(e)) return;`。
  - 实时过滤的输入框用 `bindLive`。列表的搜索框用 `TriageUi.bindSearch`：Esc 清空，空框再按 Esc 移出焦点。
  - 这样以后新加的输入框，用输入法打字也不会出问题。
- 键盘只有一个全局处理函数，在 `triage.js` 的 `onKey` 里。内置播放框里按的 T / Esc 也只有一个 message 监听，同在 `triage.js`。关注模式用 `MoonTriage.setModeKeys` 注册自己的按键，两处都先问它。
- 内置播放框的 × 不放在 `#viewer` 里，而是紧跟在它后面的同一个格子（grid-area `viewer`）里，因为 `#viewer` 要 `overflow: hidden` 裁出圆角；`#viewer[hidden]` 时 CSS 把它一起藏起来。
- B站 页面上画什么只在 `badges.js` 写一份：`surfaceOf` 认出是哪种页面（首页和搜索、收藏夹、稍后再看和历史、动态、UP 空间、视频页、分拣台内置播放框），`SURFACES` 写每种页面显示哪些东西，顶栏弹窗按元素认（`.bew-popover`、`.v-popover`）。标签放得下多少只有一个函数：`fitCount` 算个数，`fitBoxes` 量宽度、藏掉放不下的、写「+N」，`ResizeObserver` 在容器变宽变窄时重量。
- 内置播放框下的标签行只有一种写法：`TriageUi.viewerLine`，行名用第 3/4 行的 `labeledRow`。收藏夹的「视频标签」行在 `triage.js`，「UP 标签」行在 `follow.js`，收藏夹每次画完自己那行就通过 `MoonTriage.setViewerHook` 让关注重画 UP 那行。
- 后台（`background.js` 的 service worker）也加载 `tag-core.js` 和 `shared.js`，日期、时长、标签名清洗直接用 `TriageUi`，不在 `triage-bg.js` 里另写。加载顺序以 `background.js` 的 `importScripts` 为准，后台的 selftest 照它读。
- 「✦ AI 打标签」的后台只有一份：`triage-bg.js` 的 `triageAiCommand`（指令检查、新建上限 0–50、解析）。关注只把 UP 主整理成条目，带上自己的 unit 调它。
- B站 的 GET 只有一个通道：`triage-bg.js` 的 `triageBiliGetJson`，30 秒没回应算断网。收藏夹每次只试一次，限流由页面退避；关注传入自己的队列（间隔、断网重试、风控整队暂停）。写操作 `triageBiliPost` 也有这 30 秒超时，但只发一次、从不自动重试；超时报「不确定 B站 是否已改」，调用方按失败处理，不改计数、不记撤销。风控码统一用 `BILI_RISK_CODES`，WBI 签名用 `sites.js`。
