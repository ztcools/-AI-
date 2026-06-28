# 开发交接文档

**日期**: 2026-06-28  
**分支**: `feature/graph-engine` （28 commits ahead of main）  
**状态**: 开发中，主线功能完成，排查修复阶段

---

## 一、项目概述

在 claude-context 基础上扩展知识图谱能力，对标 [codebase-memory-mcp](https://github.com/ztcools/codebase-memory-mcp)。

**核心目标**: 开发者只需 `index` 一次，LLM 自动获得向量搜索 + 知识图谱增强上下文，无需学习任何工具用法。

**架构原则**:
- 不修改原 claude-context 的向量/embedding/Milvus 接口
- 新增独立包 `@zilliz/claude-context-graph`
- 工具面简化为 4 个核心工具，其余能力内部自动编排

---

## 二、分支情况

```
main (aab75b2) ← 原始项目，未修改
    |
    └── feature/graph-engine (7889e07) ← 28 commits，当前开发分支
```

**重要**: 所有修改仅在 `feature/graph-engine` 上，`main` 分支完全未动。

---

## 三、新增内容

### 3.1 新增包: `packages/graph` (`@zilliz/claude-context-graph`)

| 模块 | 文件 | 功能 |
|------|------|------|
| 类型定义 | `src/types.ts` | GraphNode, GraphEdge, GraphSearchOptions 等 |
| 存储层 | `src/graph-store.ts` | SQLite FTS5 + 事务管理，节点/边 CRUD |
| AST 提取器 | `src/extractor.ts` | tree-sitter: TS/TSX/Python/Java/C++/Go/Rust/C# |
| 调用追踪 | `src/tracer.ts` | BFS 入站/出站/双向调用链 |
| 图搜索 | `src/searcher.ts` | BM25 + 正则 + 图增强 |
| 架构分析 | `src/architecture.ts` | 包/目录/依赖分析 |
| 工具函数 | `src/utils.ts` | escapeRegex, 语言映射 |

### 3.2 新增文件: `packages/mcp/src/graph-handlers.ts`

14 个知识图谱 MCP 方法（内部保留，不对外暴露）：

```
handleIndexRepository  handleSearchGraph     handleTracePath
handleGetCodeSnippet   handleGetGraphSchema  handleGetArchitecture
handleSearchCodeGraph  handleDetectChanges   handleListProjects
handleDeleteProject    handleIndexStatus     handleQueryGraph
handleManageAdr        handleIngestTraces
```

### 3.3 核心变更: `packages/mcp/src/index.ts`

- 工具注册从 20 个简化为 4 个（`index`, `search`, `clear`, `status`）
- 旧名称保留为别名（`index_codebase`, `search_code`, `clear_index`, `get_indexing_status`）
- 删除了 `handleFusionSearch` / `parseGraphSearchResults` 死代码

### 3.4 核心变更: `packages/mcp/src/handlers.ts`

新增 3 个方法：

| 方法 | 功能 |
|------|------|
| `handleIndex` | 统一入口：向量索引 + 图索引，已索引跳过，结果合并 |
| `handleStatus` | 合并向量状态 + 图状态 |
| `handleSearchCode` 增强 | 搜索后自动注入图上下文（Related Graph Context） |

---

## 四、对外工具（4 个）

开发者只需掌握这 4 个：

```
index    — 一次调用完成向量 + 图索引
search   — 向量搜索 + 自动图上下文增强
clear    — 清理向量 + 图索引
status   — 向量 + 图状态合并查询
```

**使用流程**: `index` → 开始开发 → `search` 自动获取增强上下文

---

## 五、排查修复历史（22 轮）

| 轮次 | 修复数 | 主要内容 |
|------|--------|----------|
| 1 | 8 | 上线审查：事务边界、forceReindex 冗余、跨文件调用异常 |
| 2 | 10 | 同步间隔、N+1 查询、忽略列表、重试机制 |
| 3 | 7 | 跨 provider 重试一致性、FTS5 注入、LIKE 通配符转义 |
| 4 | 4 | 维度检测、集合限制检查 |
| 5 | 6 | 快照一致性、并发索引、错误处理 |
| 6 | 7 | 幂等性、缓存清理、日志优化 |
| 7 | 7 | 事务粒度、错误分类、资源清理 |
| 8 | 4 | 空值检查、类型安全、边界条件 |
| 9 | 5 | 内存泄漏、锁竞争、异步取消 |
| 10 | 3 | 配置验证、超时处理 |
| 11 | 4 | 路径解析、编码问题 |
| 12 | 3 | 性能优化、缓存策略 |
| 13 | 3 | 错误消息、状态恢复 |
| 14 | 3 | 日志级别、监控指标 |
| 15 | 1 | 死代码清理 |
| 16 | 3 | 扩展映射一致性、注释完善 |
| 17 | 1 | langToExts 死代码 |
| 18 | 2 | clearIndex 遗漏图索引、searcher context 参数 |
| 19 | 1 | extToLanguage 遗漏 .mjs |
| 20 | 2 | regexToLike 损坏文件路径 |
| 21 | 0 | graph-handlers 全量审计（零问题） |
| 22 | 5 | 工具面简化后连锁反应修复 |

**累计**: 89 项修复，29/29 单元测试通过，0 个 P0 问题遗留。

---

## 六、当前状态 & 待办

### 已完成
- [x] 知识图谱引擎（SQLite + tree-sitter）
- [x] 14 个图查询方法（内部保留）
- [x] 工具面简化（20 → 4）
- [x] 22 轮排查修复（89 项）
- [x] 图索引同步到 clear + index + status
- [x] search 自动图上下文增强
- [x] 变更文档已交付排查人员

### 待办
- [ ] P3 遗留问题（3 项）：preprocessText 近似、git diff 语义、debug log
- [ ] 排查人员反馈修复
- [ ] 性能测试（大项目索引/搜索延迟）
- [ ] 集成测试（vector + graph 联合搜索端到端）
- [ ] 合并到 main（需评审通过后）

### 已知风险点
1. `handleIndex` 图索引失败时不阻断，但结果可能不完整
2. `handleSearchCode` 图增强每次额外查询 3 次 SQLite
3. `exactFilePath` 的 countQuery 未同步处理（仅影响分页计数）
4. 旧的图工具名不再暴露，需确认无调用方依赖

---

## 七、技术栈

```
运行时:     Node.js + TypeScript
向量数据库:  Milvus (REST API)
图数据库:   SQLite (better-sqlite3 + FTS5)
AST 解析:   tree-sitter (8 种语言)
嵌入模型:   OpenAI / Gemini / VoyageAI / Ollama
MCP 协议:   @modelcontextprotocol/sdk
构建:       pnpm workspace + tsc
```

---

## 八、快速上手（另一台电脑）

```bash
# 1. 克隆仓库
git clone https://github.com/ztcools/-AI-.git
cd claude-context

# 2. 切换到开发分支
git checkout feature/graph-engine

# 3. 安装依赖
pnpm install

# 4. 构建
pnpm build

# 5. 运行测试
cd packages/graph && pnpm test
# 预期: 29/29 通过

# 6. 继续开发
# 所有修改在 feature/graph-engine 上
# 永远不要动 main 分支
```

---

## 九、对话上下文总结

**背景**: 企业开发了 claude-context（向量搜索 + Milvus + 团队协作），竞品 codebase-memory-mcp 有更强大的知识图谱能力（代码调用链、架构分析）。用户希望结合两者优势。

**决策**: 扩展 claude-context（而非 codebase-memory-mcp），因为 claude-context 已有团队协作基础设施（Milvus 云存储、git URL+branch 隔离），扩展图能力更可行。

**开发过程**:
1. Phase 1: 创建 `packages/graph` 独立包，SQLite 存储 + tree-sitter 提取
2. Phase 2: 增强调用边解析 + 增量索引 + query_graph + ADR
3. Phase 3: 跨文件调用解析 + ingest_traces
4. Phase 4: 向量+图融合搜索 fusion_search
5. 排查阶段: 22 轮审查修复，89 项问题
6. 简化阶段: 工具面 20→4，图能力退居幕后

**最终形态**: 开发者只需 `index` + `search`，系统自动编排向量搜索 + 知识图谱增强，无需学习任何工具。

**用户反复强调**: 不要改 main，不要改原接口，只专注能力扩展。