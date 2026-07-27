# Graph 模块重构计划

## 目标

对标 CodeGraph 的设计理念，将 claude-context 的知识图谱从"向量搜索的辅助增强"升级为"精确的代码结构理解引擎"。

## 核心变更概览

```
当前架构                              目标架构
─────────────────────────          ─────────────────────────
graph-handlers.ts (单体)           GraphIndexer (编排器)
  ├── 一次性 Worker                  ├── ParseWorkerPool (持久池)
  ├── InMemoryGraphBuffer            ├── InMemoryGraphBuffer (增强)
  ├── FunctionRegistry               ├── ReferenceResolver (新增)
  └── SqliteGraphStore (全局)        ├── StoreWriter (专用写线程)
                                     └── SqliteGraphStore (项目内)

graph/                              graph/
  ├── graph-store.ts                  ├── graph-store.ts (增强)
  ├── extractor.ts                    ├── extractor.ts (增强)
  ├── graph-buffer.ts                 ├── graph-buffer.ts (保持)
  ├── registry.ts                     ├── registry.ts → resolution/
  ├── tracer.ts                       ├── traversal.ts (重写)
  ├── searcher.ts                     ├── searcher.ts (增强)
  ├── architecture.ts                 ├── architecture.ts (保持)
  ├── parse-worker.ts                 ├── parse-worker.ts → parse-pool.ts
  └── types.ts                        ├── types.ts (增强)
                                      └── resolution/ (新增)
                                          ├── import-resolver.ts
                                          ├── name-matcher.ts
                                          └── index.ts
```

## 分阶段实施

### Phase 1: 类型系统增强

**文件**: `packages/graph/src/types.ts`

- [ ] Node/Edge 增加 `language`、`provenance`、`line`/`column` 等字段
- [ ] `GraphNode` 增加 `signature`、`visibility`、`isExported`、`docstring` 字段
- [ ] `GraphEdge` 增加 `line`、`column`、`provenance`、`metadata` 字段
- [ ] 新增 `UnresolvedReference` 类型
- [ ] 新增 `ResolutionResult` / `ResolvedRef` 类型
- [ ] 保持向后兼容 — 新字段均为 optional

### Phase 2: 存储层重构

**文件**: `packages/graph/src/graph-store.ts`

- [ ] 支持按项目路径构造 DB（`new SqliteGraphStore(projectDir)`）
- [ ] DB 文件: `<projectDir>/.context/graph/knowledge-graph.db`
- [ ] 自动创建 `.context/graph/` 目录
- [ ] Schema 升级：新增 `unresolved_refs` 表
- [ ] Schema 升级：nodes 表新增 `language`、`signature`、`visibility`、`is_exported`、`docstring`
- [ ] Schema 升级：edges 表新增 `line`、`column`、`provenance`、`metadata_json`
- [ ] 新增方法：`getUnresolvedRefs`、`deleteUnresolvedRefs`、`insertUnresolvedRefs`
- [ ] 增加 WAL 阀门控制（借鉴 CodeGraph 的 `wal-valve.ts`）
- [ ] `deleteNodesByFile` 级联删除关联的 unresolved_refs

### Phase 3: 提取层增强

**文件**: `packages/graph/src/extractor.ts`

- [ ] `extract()` 返回增加 `unresolvedRefs: UnresolvedReference[]`
- [ ] 为每个 `call_expression` 创建 unresolved ref（而非当前在 Phase 2 才处理）
- [ ] 节点元数据增强：提取 `signature`、`visibility`、`docstring`
- [ ] 边元数据增强：记录 `line`、`column`、`provenance: 'tree-sitter'`

**文件**: `packages/graph/src/parse-pool.ts` (新文件)

- [ ] `ParseWorkerPool` 类：
  - 持久 Worker Threads（不复用则回收，定期 recycle 防 WASM 内存泄漏）
  - 默认 `max(1, os.cpus().length - 2)` workers
  - `requestParse(file)` → Promise<ExtractionResult>
  - 每个 Worker 预加载所有语言 grammar
  - Grammar WASM bytes 在主线程读取一次，传给每个 Worker
  - 支持 `CODEGRAPH_PARSE_WORKERS` 环境变量覆盖
- [ ] 超时处理：单文件解析超时 `CODEGRAPH_PARSE_TIMEOUT_MS` (默认 30s)

**文件**: `packages/graph/src/store-writer.ts` (新文件)

- [ ] `StoreWriter` 类：
  - 专用 Worker Thread 执行 SQLite 写入
  - 主线程发 `StoreBundle` 消息，Worker 线程批量写入
  - 窗口 backpressure：`waitBelow(maxPending)` 防止内存爆炸
  - 支持 `drain()` 等待所有写入完成
  - 支持 `close()` 优雅关闭

### Phase 4: 引用解析层 (核心新增)

**文件**: `packages/graph/src/resolution/import-resolver.ts` (新文件)

- [ ] `extractImportMappings(filePath, content, language)`:
  - JS/TS: `import { foo } from './bar'` → `{localName: 'foo', modulePath: './bar'}`
  - Python: `from foo import bar` / `import foo.bar`
  - Java: `import com.example.Foo`
  - Go: `import "pkg/path"`
  - Rust: `use crate::foo::bar`
  - C/C++: `#include "foo.h"`
  - C#: `using Foo.Bar`
- [ ] `resolveViaImport(ref, context)`: 通过 import 映射解析引用
- [ ] 支持 re-export 追踪 (JS/TS barrel files)
- [ ] 路径别名解析 (tsconfig paths, Cargo workspace)

**文件**: `packages/graph/src/resolution/name-matcher.ts` (新文件)

- [ ] `matchReference(ref, context)`:
  - 同文件优先：先在当前文件查找
  - 跨文件唯一名：全局唯一符号直接匹配
  - 多候选消歧：按命名空间距离排序
  - 置信度计算：0.3-0.95 范围
- [ ] `matchMethodCall(ref, context)`: 方法调用接收者类型推断
- [ ] 语言内置函数黑名单（JS/Python/Go/C/C++/Java 等）

**文件**: `packages/graph/src/resolution/index.ts` (新文件)

- [ ] `ReferenceResolver` 类：
  - `resolveAll(refs)` → `ResolutionResult`
  - 多策略管线：import → framework → name-match
  - 分批处理（batchSize=5000），防止 OOM
  - 协作式 yield，防止事件循环卡死
  - `createEdges(resolved)` → `Edge[]`
  - 边类型提升：calls→instantiates（目标为 class 时）
  - LRU 缓存所有查找（node/file/import/name/reExport）
  - `knownNames` Set 预过滤（O(1) 跳过不可解析引用）
- [ ] 方法所有者索引 (method owner index)：`Type::method` O(1) 查找
- [ ] 超类型一致性遍历（待 Phase 5 实现）

### Phase 5: 图算法增强

**文件**: `packages/graph/src/traversal.ts` (重写 tracer.ts)

- [ ] `GraphTraverser` 类（对标 CodeGraph）:
  - `traverseBFS(startId, options)` — BFS 遍历
  - `traverseDFS(startId, options)` — DFS 遍历
  - `getCallers(nodeId, depth)` — 调用者追踪
  - `getCallees(nodeId, depth)` — 被调用者追踪
  - `getCallGraph(nodeId, depth)` — 双向调用图
  - `getTypeHierarchy(nodeId)` — 类型层级
  - `findUsages(nodeId)` — 所有引用
  - `getImpactRadius(nodeId, depth)` — 影响面分析
  - `findPath(fromId, toId)` — 最短路径
  - `getAncestors(nodeId)` — 容器层级
  - `getChildren(nodeId)` — 直接子节点
- [ ] 边优先级排序（contains > calls > references）
- [ ] 批量节点获取防 N+1
- [ ] 并行边去重（#1090 模式）

**文件**: `packages/graph/src/queries.ts` (新文件，对标 CodeGraph)

- [ ] `GraphQueryManager` 类：
  - `getContext(nodeId)` → 完整上下文
  - `getFileDependencies(filePath)` → 文件依赖
  - `getFileDependents(filePath)` → 反向依赖
  - `findDeadCode()` → 死代码检测
  - `findCircularDependencies()` → 循环依赖
  - `getNodeMetrics(nodeId)` → 复杂度指标

### Phase 6: 编排器重构

**文件**: `packages/graph/src/indexer.ts` (新文件，替代 graph-handlers.ts 中的索引逻辑)

- [ ] `GraphIndexer` 类：
  - `indexAll(rootDir, options)`:
    1. 扫描文件（git ls-files 或 filesystem walk）
    2. Phase 1: 解析（ParseWorkerPool + InMemoryGraphBuffer + 提取 unresolvedRefs）
    3. Phase 2: 引用解析（ReferenceResolver + 创建边 + 持久化）
    4. Phase 3: 边类型提升（calls→instantiates 等）
    5. Yield 事件循环确保 MCP 响应和向量索引不阻塞
  - `sync(rootDir)` — 增量同步（检测变更文件 + 只重建受影响部分）
  - `indexFiles(rootDir, files)` — 指定文件索引
- [ ] Store Writer 集成：Phase 1 结果通过 StoreWriter 写入 SQLite
- [ ] 进度回调：`onProgress(phase, current, total, file)`

### Phase 7: MCP 集成更新

**文件**: `packages/mcp/src/graph-handlers.ts`

- [ ] `GraphToolHandlers` 改为使用 `GraphIndexer`
- [ ] DB 路径改为项目内（`<project>/.context/graph/`）
- [ ] `handleIndexRepository` 调用 `graphIndexer.indexAll()`
- [ ] 增量索引：`graphIndexer.sync()`
- [ ] 移除全局 DB 逻辑

**文件**: `packages/mcp/src/handlers.ts`

- [ ] `enrichWithGraphContextDeep` 更新为使用新的遍历 API
- [ ] 图搜索集成保持不变（search_graph 工具）

**文件**: `packages/mcp/src/index.ts`

- [ ] `GraphToolHandlers` 初始化不再传全局 DB 路径
- [ ] 改为传项目路径

### Phase 8: 清理和优化

- [ ] 移除旧的 `parse-worker.ts`（被 `parse-pool.ts` 替代）
- [ ] 移除 `FunctionRegistry` 中的旧引用解析逻辑（被 `ReferenceResolver` 替代）
- [ ] 移除 graph-handlers.ts 中的 `resolveCrossFileCallsWithRegistry`
- [ ] 全局 DB 文件不再创建
- [ ] 添加 `.context/graph/` 到 `.gitignore` 建议
- [ ] 向量 + 图索引资源平衡调优

### Phase 9: 测试和验证

- [ ] 更新现有测试以适配新 API
- [ ] 新增 `resolution.test.ts` — 引用解析测试
- [ ] 新增 `traversal.test.ts` — 图遍历测试
- [ ] 新增 `parse-pool.test.ts` — Worker 池测试
- [ ] 新增 `store-writer.test.ts` — Store Writer 测试
- [ ] 端到端测试：index → search → trace → impact

## 性能目标

| 场景 | 目标 |
|------|------|
| 小项目 (<500 文件) | 图索引 <10s |
| 中项目 (500-5000 文件) | 图索引 <60s |
| 大项目 (5000+ 文件) | 图索引 <5min |
| 增量同步 (<10 文件变更) | <5s |
| 内存峰值 (大项目) | <2GB |
| 事件循环不阻塞 | 每个 batch 后 yield |

## 资源平衡策略

- Parse Workers: `max(1, cores-2)`，为 Milvus gRPC 和 Store Writer 留核
- Store Writer: 1 个专用线程
- 解析窗口大小: `max(4, pool.size * 2)`，平衡吞吐和内存
- 批量提交大小: 1000 edges/批次
- LRU 缓存限制: 5000 entries（防 20K+ 文件仓库 OOM）
- WAL 反压阀: 当 WAL 超过 2GB 时暂停写入

## 不变项

- 保持现有 9 种语言支持（JS/TS/Python/Java/C++/Go/Rust/C#/Scala）
- 保持 `GraphStore` 接口模式（测试友好）
- 保持 MCP 4 工具接口（index/search/clear/status）
- 保持向量搜索 + 图搜索双引擎架构
- 保持 `ArchitectureAnalyzer` 模块

## 风险与缓解

| 风险 | 缓解 |
|------|------|
| 大重构引入回归 | 分 Phase 实施，每个 Phase 独立可测 |
| 多线程竞争 | Store Writer 单线程顺序写入 |
| 内存泄漏 | Worker 定期回收 + LRU 有界缓存 |
| 向量索引资源争抢 | 保守 Worker 数 + 协作式 yield |
| 项目内 DB 被 git 追踪 | 文档建议加入 .gitignore |
