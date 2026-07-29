---
description: Seeway · 查看链接状态与图索引状态
argument-hint: "[仓库相对/绝对路径，缺省为当前工作区]"
allowed-tools: mcp__claude-context__status
---
调用 `mcp__claude-context__status` 工具查看当前仓库的链接与索引状态。

- path 参数：$ARGUMENTS（为空则省略，默认当前工作区）。
- 汇报：是否已链接云端（repo@branch + collection）、云端 collection 连通性、本地图索引规模（节点/边数）。
- 未链接时提示可用 `/seeway-link` 建立链接。
