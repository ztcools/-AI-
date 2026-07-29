---
description: Seeway · 清除本地图索引（云端向量索引不受此命令影响，在控制台管理）
argument-hint: "[仓库相对/绝对路径，缺省为当前工作区]"
allowed-tools: mcp__claude-context__clear
---
调用 `mcp__claude-context__clear` 工具清除**本地图索引**（SQLite）。

- path 参数：$ARGUMENTS（为空则省略，默认当前工作区）。
- 只清本地图，**不会动云端向量索引**——云端索引的统一管理（增删仓库/保护分支）都在 PhiGent 控制台手动进行。
- 这是破坏性操作，但图索引可通过重新 `/seeway-link` 重建。执行前先用一句话说明将要清除的目标路径，然后直接调用。
- 完成后汇报清除结果；如需重新使用，提示重新 `/seeway-link`。
