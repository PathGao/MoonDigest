# 仓库治理

采用基线：**2026-09-16, Markpad labels**，来自 [PathGao/governance](https://github.com/PathGao/PathGao/tree/main/governance)。
采用的 [源快照](https://github.com/PathGao/PathGao/tree/670df34/governance)。更新靠人工比对后复制，没有自动继承。

## 流程

用简短的 PR 模板。`Closes #123` 或 `Fixes #123` 在合并时关闭完成的 issue。部分完成用
`Related to #123` 并写明剩下什么。没有发版确认或超时关闭自动化。

十个共用 label 与 Markpad 的名称、颜色、说明一致。`question` 是使用问题；`needs info` 等报告者补充；
`awaiting decision` 等维护者决定；`planned` 表示已接受。`Final_Check_Request` 是手动标记，
表示待确认或未完成，这类 issue 保持打开直到完成，不由机器人处理。完整列表见 [labels.json](labels.json)。

## 维护

[settings.json](settings.json) 和 [rulesets/](rulesets/) 是期望的 GitHub 配置，需按基线指南通过 API 应用，
只提交这些文件不会改变仓库设置。main 要求走 PR，只允许 squash 合并，合并后自动删除分支，禁止删除和强推，
管理员保留恢复用的绕过权限。`v*` 发版标签不可更新或删除，`v*-test*` 除外。

在仓库根目录预览 label 变更：

```sh
./scripts/sync-labels.sh PathGao/MoonDigest
```

加 `--apply` 创建或更新声明的 label。清单外的 label 会保留。采用时已确认无人使用后，显式删除了默认的
`wontfix`、`good first issue`、`help wanted`、`invalid`、`duplicate`。

## 与基线的差异

- 保留 `accessibility`：采用前就有的项目 label。
- main 不要求 CI 检查：仓库只有发版流水线，PR 上没有 CI。自检在本地跑，见 README 的开发。
- 模板与文档用中文。label 脚本放在 `scripts/`，与仓库现有脚本一致。
