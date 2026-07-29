---
description: Seeway · 链接云端向量索引 + 建立本地图索引（进入代码检索模式）
argument-hint: "[保护分支名] [仓库路径] — 缺省则检测当前仓库并列出可链接分支"
allowed-tools: mcp__claude-context__link
---

调用 `mcp__claude-context__link` 工具，把当前仓库链接到云端的保护分支向量索引，并建立/增量更新本地图索引。这是使用 search 向量能力的前提（会话级，重新进入需重新 link）。

- 参数：$ARGUMENTS
- **缺省（无参数）**：省略所有参数调用 link。它会检测当前 git 仓库，列出该仓库在云端的可链接保护分支。检测到后把分支清单交给用户选择，再用选定的分支调用一次 `link { branch: "<分支>" }` 完成链接。
- **已带分支**：把第一个参数作为 branch 调用 `link { branch: "<分支>" }`；若还带第二个参数且是路径，作为 path。
- **检测不出仓库**（非 git 目录/无 remote）：提示用户告知项目名称或路径（绝对/相对均可）。拿到后用 `link { path: "<解析出的路径>" }` 重试；若该目录仍无 git remote，请用户提供仓库的 git 地址，用 `link { path, repo: "<git地址>", branch }`。
- 链接成功会返回：绑定的 repo@branch、云端 collection、本地图索引是首次全量还是增量更新。用一两句话汇报。
- 若提示云端无该分支索引：说明该仓库的保护分支尚未在控制台配置/索引，引导用户先到 PhiGent 控制台为该仓库添加该保护分支并触发索引，再来 link。
