---
description: Seeway · 语义 + 调用图检索代码库
argument-hint: "<自然语言查询>（在当前工作区检索）"
allowed-tools: mcp__claude-context__search
---
调用 `mcp__claude-context__search` 工具检索代码库。

- query 参数：$ARGUMENTS
- path **省略**（默认当前工作区）。若查询里明确带了某个仓库路径，则把该路径作为 path、其余作为 query。
- mode 默认为 `both`（向量+图）。需要时显式指定：`mode: "vector"`（纯语义）、`mode: "graph"`（纯调用图分析）
- 拿到结果后：**先 search 定位 → 再 Read 定点行区间**。search 已返回签名/出入度/调用链，能判断"在哪"和"谁在用"后再读代码。**不要通读文件**。
- 结果不理想就换更聚焦的 query 再搜一次，或切换 mode。
- 若提示未索引，提示用户先执行 `/seeway-index`。
