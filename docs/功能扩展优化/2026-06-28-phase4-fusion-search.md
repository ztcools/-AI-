# 2026-06-28 | Phase 4: 向量+图融合搜索

## 目标
结合向量语义搜索 (Milvus) 和知识图谱搜索 (SQLite)，一次查询返回两种结果并融合排序。

## 修改内容

### fusion_search 工具
- 同时执行 `context.semanticSearch()` 和 `handleSearchGraph()`
- 按 `filePath:startLine` 合并去重
- 分数归一化: vector 和 graph 分数统一到 0-1 范围
- 加权融合: both 匹配 0.4*vec + 0.6*graph，单侧匹配降权 (vector-only 0.6, graph-only 0.5)

### parseGraphSearchResults
- 解析 handleSearchGraph 文本输出格式
- 提取 label/name/qualifiedName/filePath/score/degree

### 结果展示
- 三种匹配类型: both (⚡) / vector (🔍) / graph (📊)
- 图结果增强: label, qualifiedName, degree
- 向量结果: 代码片段预览
- 底部统计: Vector/Graph/Merged 计数

### 新增 MCP 工具
fusion_search (第 15 个图工具)

## 测试
29/29 PASS (新增 FusionSearchParser 测试)