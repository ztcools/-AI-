---
description: Seeway · 链接云端向量索引至当前仓库（会话级，重进需重 link）
argument-hint: "[分支名] [路径] — 缺省则列出可链接分支供选"
allowed-tools: mcp__claude-context__link
---

调用 `link` 绑定当前仓库到云端保护分支的向量索引，link 后即可用 search 语义搜索。

## 流程

**有参数**：`/seeway-link main` → `link { branch: "main" }`。第二个参数若为路径则加 path。

**无参数（默认）**：调用 `link {}` → 返回该仓库的云端保护分支列表（★ 为推荐分支）。
用 **AskUserQuestion** 单选呈现让用户选择，用户确认后再 `link { branch: "<所选>" }`。
**禁止自动替用户选分支**。除非用户明确说"随便帮我选个最优的"或"直接用推荐的"。

**非 git 目录**：`link {}` 返回 "Not in a git repository" → 用 AskUserQuestion 让用户输入仓库名或 URL。
- 仓库名（如 "flask"）：`link { repo: "flask" }`
- 完整 URL：`link { repo: "https://github.com/org/repo.git" }`
拿到后自动触发分支列表 → 回到无参数流程。

**云端不可达**：告知用户 git-index-service 不可达，需手动指定分支。

## 成功汇报

一行：`已链接 <repo>@<branch> → <collection>（图: N 节点）`

## 错误处理

- "Cloud index not found" → 该分支未索引，引导到 PhiGent 控制台添加
- "not loaded into Milvus memory" → 引导到 PhiGent Load
