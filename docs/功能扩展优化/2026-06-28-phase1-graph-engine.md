# 2026-06-28 | Phase 1: 知识图谱引擎

## 目标
对标 codebase-memory-mcp 的知识图谱能力，为 claude-context 新增结构化代码分析。

## 修改内容

### 新建 packages/graph 包
- **types.ts**: GraphNode/GraphEdge/GraphStore 等核心类型定义，支持 Function/Class/Method/Route 等 14 种节点标签，CALLS/IMPORTS/HTTP_CALLS 等 12 种边类型
- **graph-store.ts**: 基于 SQLite + better-sqlite3 的图存储，支持 FTS5 全文搜索、WAL 模式、事务管理
- **extractor.ts**: 基于 tree-sitter 的 AST 提取器，支持 8 语言 (TS/JS/Python/Java/C++/Go/Rust/C#)
- **tracer.ts**: BFS 调用链追踪，支持入向/出向/双向，深度限制
- **searcher.ts**: 图增强代码搜索，BM25 排序 + 度过滤
- **architecture.ts**: 架构分析，入口点检测、目录聚类、内聚度

### 扩展 MCP Server
- 新增 **graph-handlers.ts**，实现 11 个图工具处理器
- 修改 **index.ts**，添加工具定义和 dispatch case
- 新增 MCP 工具: index_repository, search_graph, trace_path, get_code_snippet, get_graph_schema, get_architecture, search_code_graph, list_projects, delete_project, index_status, detect_changes

## 兼容性
- 原有 4 个向量工具 (index_codebase/search_code/clear_index/get_indexing_status) 完全不变
- packages/core 零修改，Milvus 和 Embedding 接口不受影响
- pnpm-workspace.yaml 添加 better-sqlite3 构建允许

## 测试
19/19 PASS (graph-store, extractor, tracer, searcher, architecture)