---
description: Seeway · 断开当前仓库与云端向量索引的链接
argument-hint: "[仓库相对/绝对路径，缺省为当前工作区]"
allowed-tools: mcp__claude-context__unlink
---
调用 `mcp__claude-context__unlink` 工具断开当前仓库的云端索引链接。

- path 参数：$ARGUMENTS（为空则省略，默认当前工作区）。
- 断开后 search 退化为仅用本地图（向量检索不可用）；本地图索引仍保留，如需清除用 `/seeway-clear`。
- 完成后用一句话汇报；如需重新链接，提示 `/seeway-link`。
