# claude-context — Seeway 代码索引 MCP 服务

> 代码智能索引工具，为 Claude Code 提供语义搜索 + 知识图谱双引擎。

## 项目概述

claude-context 是一套代码索引与检索系统，核心价值：
1. **语义搜索**：按意图搜代码（稠密向量 + BM25 混合检索，RRF 融合排序）
2. **知识图谱**：tree-sitter AST 解析 → 构建调用图（CALLS/IMPORTS/INHERITS/HTTP_CALLS…），提供调用链追踪、死代码标记、架构分析
3. **开发者私有索引**：每人独立的 per-branch collection，Merkle 内容追踪代替 git commit diff，对 reset/rebase/stash 等操作免疫
4. **MCP 集成**：通过 MCP 协议暴露 `index/search/clear/status` 四个工具，Claude Code 一键接入

发布为 MCP server，通过 `node packages/mcp/dist/index.js` 启动，在**任意项目**中 `index` → `search`，无需该项目的开发依赖。

## 双引擎架构总览

```
                    ┌─────────────────────────┐
                    │     MCP search API       │
                    │  (both/vector/graph)     │
                    └───────────┬─────────────┘
                                │
            ┌───────────────────┴───────────────────┐
            │                                       │
    ┌───────▼────────┐                    ┌────────▼─────────┐
    │  向量索引 (Milvus)│                    │  图索引 (SQLite)   │
    │  语义搜索        │                    │  结构查询          │
    │  dev ⊕ root     │                    │  调用图/影响面     │
    │  RRF 融合       │                    │  跨文件引用解析    │
    └───────┬────────┘                    └────────┬─────────┘
            │                                       │
    ┌───────▼────────┐                    ┌────────▼─────────┐
    │ Milvus Server   │                    │ .context/graph/   │
    │ 10.50.4.149     │                    │ <project> 本地    │
    │ (团队共享)       │                    │ (开发者本地)      │
    └────────────────┘                    └──────────────────┘
```

**搜索合并流程**（`search mode=both`）：
1. 向量 + 图搜索**并行**执行（Promise.all）
2. 向量结果标注匹配的图符号名称和出入度
3. 未匹配的图符号独立展示
4. 图上下文富化（4 层）：调用图 → 影响面 → 文件依赖 → 架构摘要

## 各 git 操作场景下的索引行为

### 图索引（SQLite, 随项目存储）

图索引直接绑定工作树文件内容，通过 Merkle 内容哈希检测变更：

| 操作 | 行为 | 性能 |
|------|------|------|
| **修改文件** | Merkle 检测 → 增量重建（仅变更文件） | 变更文件数 × ~10ms/文件 |
| **git reset --hard** | 文件内容变化 → Merkle 检测变化 → 重建变化文件 | 与 reset 范围成正比 |
| **git rebase** | 文件可能变化 → Merkle 检测 → 重建 + 重新计算 merge-base | 合并后增量 |
| **git stash / pop** | 内容变化 → Merkle 检测 → embedding cache 100% 命中 → 极快 | < 1s |
| **git checkout 分支** | 不同分支 = 不同 DB 内容。Merkle 检测 → 增量重建 | 分支差异文件数 × ~10ms |
| **克隆新仓库** | 无 DB 文件 → 首次 `search` 触发自动构建 | 全量文件 × ~10ms |
| **git merge** | 新文件被索引，未变文件跳过 | 仅新/改文件 |

**git 操作正确性保证**：
- 基于**文件内容哈希**，不是 git commit SHA，对 `reset --hard`/`rebase` 免疫
- dirty flag 防护：索引中断后下次强制全量重建
- merge-base 追踪：rebase 后自动重新计算 `devChangedFiles`

### 向量索引（Milvus, 网络服务）

向量索引使用 **dev ⊕ root 双层架构**，每层在不同场景下行为不同。

**核心机制**：
```
identity = gitRemote:branch:devFingerprint
collection = hcc_<md5(identity)>
merkle snapshot = ~/.context/merkle/<md5(identity)>.json
devChangedFiles = git diff --name-only merge-base HEAD  (首次计算)
```

| 操作 | 行为 | 说明 |
|------|------|------|
| **首次 index** | delta 模式：`git diff merge-base HEAD` → 计算 devChangedFiles → 只索引与 root 不同的文件 | 未变文件由 root 层提供 |
| **修改文件** | Merkle 检测变化 → 增量索引变更文件 → devChangedFiles 增量更新 | 仅修改的文件重索引 |
| **git checkout 分支** | 不同分支 = 不同 identity = 不同 collection + 不同 Merkle 快照。切回时 Merkle 匹配 → 零成本 | 每分支独立 collection |
| **git reset --hard** | 文件变化 → Merkle 检测 → 批量删除旧 chunks + 嵌入新 chunks | 变更文件数 × ~50ms/文件 |
| **git rebase** | 文件可能变化 + merge-base 变化 → rebase reconciliation 自动触发 → `git diff` 重新计算 devChangedFiles → 旧 dev 文件中与 root 相同的移除、新分叉文件加入 | 自动修正 |
| **git stash / pop** | 内容变化 → Merkle 检测 → embedding cache 100% 命中 → 极快（仅写 Milvus） | < 2s |
| **git merge** | 新文件被索引 → devChangedFiles 扩展 | 仅新文件 |

**rebase 后的精确行为**：
1. `syncIndexByMerkle` 检测 `merge-base` 是否变化（对比 `lastMergeBase` 快照字段）
2. 变化后执行 `git diff --name-only <new-merge-base>` 获取新的变更文件集合
3. 旧 dev 文件中与 root 相同的 → 从 `removed` 列表加入（后续从 Milvus 删除）
4. 新分叉文件 → 加入 `modified` 列表（后续重新索引）
5. `devChangedFiles` 更新为新的集合
6. 搜索时 `buildMaskFilter(devChangedFiles)` 在 root 层正确排除 dev 版本

**版本污染防护**：
- 每个开发者独立 collection（`<identity>` = `<remote>:<branch>:<devFingerprint>`）
- devChangedFiles 通过 `relativePath not in [...]` 在 root 层 mask
- 两层全局 RRF 融合 + 去重：dev 层优先，root 层兜底
- **不会被其他开发者的修改污染**

```
┌──────────────────────────────────────────────────────────┐
│  Milvus (共享)                                            │
│  ├── hcc_repo_main            ← 服务端定时索引（只读）      │
│  ├── hcc_repo_featA_alice     ← Alice: 变更文件（delta）    │
│  ├── hcc_repo_featA_bob       ← Bob: 变更文件（delta）      │
│  ├── hcc_repo_featB_alice     ← Alice: 变更文件（delta）    │
│  └── embedding_cache_xxx      ← 全局共享向量缓存            │
│                                                           │
│  搜索: dev ⊕ root(masked by devChangedFiles)               │
│  本地 (~/.context/merkle/)                                 │
│  └── <identity>.json          ← devChangedFiles + 内容哈希  │
└──────────────────────────────────────────────────────────┘
```

### 索引身份 = `gitRemote:branch:devFingerprint`

开发者指纹（[dev-fingerprint.ts](packages/core/src/utils/dev-fingerprint.ts)），**零配置自动生效**：

```
1. CLAUDE_CONTEXT_DEV_ID env       （可选覆盖，团队统一标识时使用）
2. git config user.email           （默认，自动获取 — git 团队开发必须配置）
3. hostname                        （兜底）
4. /etc/machine-id                 （终极兜底）
```

指纹格式为 `<slug>_<hash>`（12 字符 slug + 4 字符 MD5），防相似 email 碰撞。第一次计算后缓存到 `~/.claude-context/dev-id`，持久稳定。

### 索引流程（Merkle 内容追踪 + Delta）

```
1. 扫描工作树 → 计算每个文件的 SHA256 内容哈希（>10MB 文件流式 hash，防 OOM）
2. 对比上次 Merkle 快照（status: clean/dirty）→ 检测增/删/改
   - 快照标记 dirty 且索引未完成 → 全量重索引（防"幽灵 up-to-date"）
   - 干净快照 → 增量对比上次哈希
3. ── Delta 判定（首次索引时）──
   云端 root collection 存在? → git diff --name-only origin/main
     → 只索引与 main 不同的文件（delta），跳过与 main 相同的文件
     → 相同文件由 root 层在搜索时提供
   云端 root 不存在? → 全量索引所有文件（full）
4. 先批量删除 removed + modified 文件的旧 chunks（deleteFileChunksBatch）
5. 变化文件 → 切 chunk → 查 embedding cache → 嵌入 miss 部分
   - Embedding API 指数退避重试 3 次（auth/quota 等 fatal 错误不重试）
   - 失败 chunk 进入 retryBuffer，批次结束时重试一次
6. 写入 dev 个人 collection (Milvus)
7. devChangedFiles 持久化到 Merkle 快照（用于搜索时 mask root 层）
8. 索引成功 → markClean() 保存 Merkle 快照（status: clean）
```

**后续增量**（非首次）：
- Merkle hash 对比自己的上次快照，不重新跟 main diff
- delta 模式自动维护 devChangedFiles：新增文件加入、删除文件移除、修改文件保持

**关键**：不依赖 git commit SHA。git reset/rebase/merge 导致的文件变化被 Merkle 自然检测，内容相同的文件零成本跳过。快照的 `status: clean/dirty` 标记防止进程崩溃后误报"up-to-date"。

### 搜索流程（dev ⊕ root 两层，带 masking）

```
search 时：
  layer 1: dev collection (hcc_repo_branch_devId)  ← 开发者变更的文件（delta）
  layer 2: root collection (hcc_repo_main)          ← 共享仓库基线

  masking 保证正确性:
    dev collection 中的文件 → 记录在 devChangedFiles（Merkle 快照中）
    搜索 root 层时: buildMaskFilter(devChangedFiles) → "relativePath not in [...]"
    → dev 改过的文件从 root 层硬排除，dev 版本强制优先

  两层始终同时搜索（不是二选一）：
    - globalHybridFusion 跨层 RRF 融合：dense 全局排名 + sparse 层内排名 → 统一重排序
    - deduplicateResults（>50% 行重叠去重）作为安全网
    - masking 是防线，RRF+dedup 是兜底
```

查询嵌入向量缓存（LRU, 64 条, TTL=5min），相同 query 不重复调用 embedding API。

### 团队场景行为

| 场景 | 行为 |
|------|------|
| git reset --hard | 文件变化→Merkle 检测→重索引变化的文件（cache 命中） |
| git rebase | 代码不变则零成本；冲突解决后增量索引 |
| git merge | 新文件被索引，未变文件跳过 |
| git stash / pop | Merkle 检测变化→增量索引（cache 100% 命中） |
| 两人同分支改不同文件 | 各自写各自 collection，互不干扰 |
| 未提交修改 | 索引个人 collection，不影响其他开发者 |
| 切换分支后切回 | Merkle 匹配上次快照→零成本 |
| force push 后同步 | Merkle 检测文件变化→增量索引 |

## 架构总览

```
claude-context (monorepo, pnpm workspace)
├── packages/core          @seeway/claude-context-core     # 核心索引引擎
├── packages/graph         @seeway/claude-context-graph    # 知识图谱引擎
├── packages/mcp           @seeway/claude-context-mcp      # MCP 服务端（对外入口）
└── packages/git-index-service  @seeway/claude-context-git-index-service  # 定时云端索引
```

### 依赖关系

```
mcp ──→ core, graph     （mcp 是唯一面向用户的包，聚合 core + graph）
git-index-service ──→ core
graph ──→ 独立（better-sqlite3 + tree-sitter*）
core ──→ 独立（Milvus SDK + embedding providers）
```

## 关键数据流

### 索引流程 (index)
```
开发者工作树
  → FileSynchronizer (Merkle 内容哈希对比) → 增/删/改文件列表
    → git ls-files 获取文件列表 → JS 侧过滤扩展名 + ignore 规则
    → 流式 SHA256 hash（50MB maxBuffer 防大仓库降级）
  → Splitter (AST 语法感知 / LangChain 字符) → CodeChunk[]
  → Embedding API (OpenAI/VoyageAI/Gemini/Ollama) → 向量
    → 优先查 embedding_cache (全局共享，内容哈希匹配)
  → Milvus insert to dev collection (hybrid: dense + sparse/BM25)
  → 保存本地 Merkle 快照
  → GraphExtractor (tree-sitter Worker Threads) 3 阶段:
    Phase 1: Worker 并行解析 AST → InMemoryGraphBuffer
    Phase 2: FunctionRegistry 解析跨文件 CALLS
    Phase 3: 批量写入 SQLite（每 10K 行 yield 事件循环）
```

### 搜索流程 (search)
```
用户查询
  → Embedding → 查询向量
  → dev collection (优先) → searchWithLayers
     root collection (fallback，dev 未索引时)
  → Milvus hybridSearch (dense + sparse, RRF 融合)
  → GraphSearcher (SQLite FTS + 调用图上下文)
  → 结果合并：dev 结果优先 + root 结果补充
  → 片段 + 调用者/被调用者/调用链/架构摘要
```

### 索引模式选择 (syncIndexByMerkle)
```
if 快照 status=dirty（上次索引被中断）:
  → 全量重索引（修复 > 增量覆盖）
elif 首次索引（无 Merkle 快照）:
  if 云端 root collection 存在:
    → git diff --name-only origin/main → delta 模式，只索引变更文件
  else:
    → 所有文件都是 "new" → full 模式，全量索引到 dev collection
elif Merkle 对比无变化:
  → up-to-date，零操作
else:
  → 只处理增/删/改文件 → 批量删旧 + 增量索引到 dev collection
  → delta 模式自动维护 devChangedFiles（用于搜索 masking）
  → 索引成功 → markClean() 保存 clean 快照
```

## 技术栈

| 层面 | 技术 |
|------|------|
| 语言 | TypeScript (ES2020, commonjs) |
| 运行时 | Node.js ≥ 20 |
| 包管理 | pnpm ≥ 10 (workspace monorepo) |
| 向量数据库 | Milvus (支持 hybrid: dense + sparse/BM25) |
| 图数据库 | SQLite (better-sqlite3, FTS5 全文搜索) |
| AST 解析 | tree-sitter (JS/TS/Python/Java/C++/Go/Rust/C#/Scala) |
| Embedding | OpenAI / VoyageAI / Gemini / Ollama / OpenRouter |
| MCP 协议 | @modelcontextprotocol/sdk |

## 核心模块速查

### core — src/context.ts (核心类, ~2700行)
- `Context` 类：一切的总入口。构造函数接受 `embedding` + `vectorDatabase` + `splitter`
- `indexCodebase()` — 全量索引（服务端使用）
- `syncIndexByGit()` — Git 增量索引（**服务端 git-index-service 使用**，基于 commit diff）
- `syncIndexByMerkle()` — **开发者 Merkle 索引**（MCP 端使用，内容哈希追踪，对 reset/rebase 免疫）
  - **首次索引 delta 模式**：云端 root collection 存在时自动判定，`git diff --name-only origin/main` 只索引变更文件
  - **devChangedFiles 维护**：持久化到 Merkle 快照，用于搜索时 mask root 层
- `semanticSearch()` — 多层 hybrid 搜索，跨 layer global RRF 融合
- `searchWithLayers()` — **显式层搜索**，调用方提供 collection 列表（不依赖 CommitIndexState）
- `getDevCollectionName()` / `getRootCollectionName()` — dev-aware 集合命名
- `getQueryEmbedding()` — 查询嵌入 LRU 缓存（64 条, TTL=5min），避免重复 API 调用
- `deleteFileChunksBatch()` — 批量删除（收集多文件 ID → 一次 delete），fallback 到逐文件
- `getRRF_K()` — 统一读取 RRF k 参数（环境变量 `RRF_K`，默认 100）
- `applyScoreCutoff()` — 统一阈值过滤（相对比率，dense 和 hybrid/RRF 模式均生效）
- `processChunkBatch()` — 嵌入缓存：先查 Milvus 缓存 → embedding 指数退避重试（3次）→ 写入
- `prepareDevCollection()` — 创建 dev 专用 collection
- `collectionNamePattern`: `hcc_<repo>_<md5hash>` （identity = `gitUrl:branch:devFingerprint`）
- `DEFAULT_IGNORE_PATTERNS` — 覆盖 JS/TS/Python/Java/Kotlin/C++/Go/Rust/Ruby/Elixir/Dart/Flutter/Unity/Unreal/Godot 等生态的构建产物和依赖目录

关键环境变量（通过 `envManager` 读取）：
- `EMBEDDING_PROVIDER`, `EMBEDDING_MODEL`, `EMBEDDING_DIMENSION`
- `MILVUS_ADDRESS`, `MILVUS_TOKEN`
- `HYBRID_MODE` (默认 true), `EMBEDDING_BATCH_SIZE` (默认 100)
- `EMBEDDING_CACHE_ENABLED` (默认 true)
- `CUSTOM_EXTENSIONS`, `CUSTOM_IGNORE_PATTERNS`
- `CLAUDE_CONTEXT_DEV_ID` — **可选**，显式设置开发者身份（未设置时自动使用 git email）
- `RRF_K` — RRF 融合 k 参数（默认 100）
- `INDEX_CHUNK_LIMIT` — 单次索引 chunk 上限（默认 450000）
- `LOCAL_FULL_INDEX_ENABLED` — 允许无服务端 root collection 时本地全量索引（默认 false，设为 `true` 仅管理员/测试）
- `SEARCH_DEFAULT_LIMIT`, `SEARCH_THRESHOLD`, `SEARCH_SNIPPET_MAX_CHARS`, `SEARCH_SCORE_RATIO` — 搜索调优
- `GIT_ROOT_BRANCHES` — root 分支名（默认 main,master，仅服务端使用）
- `GIT_INCREMENTAL_ENABLED`, `GIT_LAYERED_ENABLED` — 服务端索引开关

### core/src/splitter/ — 代码分割
- `AstCodeSplitter` — tree-sitter 语法感知（按函数/类边界切分），支持 10 种语言，不支持的语言自动 fallback 到 LangChain
- `langchain-splitter.ts` — 字符级 RecursiveCharacterTextSplitter

### core/src/embedding/ — Embedding 提供商
- 统一接口 `Embedding`，实现：`OpenAIEmbedding`, `VoyageAIEmbedding`, `GeminiEmbedding`, `OllamaEmbedding`

### core/src/vectordb/ — 向量数据库
- `MilvusVectorDatabase`（gRPC）— dense + sparse (BM25) hybrid 搜索
  - `withLoadRetry()` — 检测 Milvus 重启/卸载等瞬态错误，自动清除 load 缓存并重试一次
- `MilvusRestfulVectorDatabase`（REST）— 完整实现 sparseSearch，支持跨层 global RRF
- `ClusterManager` ([cluster-utils.ts](packages/core/src/vectordb/cluster-utils.ts)) — Milvus 集群管理（地址解析、免密集群创建）

### core/src/sync/ — 文件同步
- `FileSynchronizer` ([synchronizer.ts](packages/core/src/sync/synchronizer.ts)) — 基于 Merkle 树的文件变更检测
  - 每开发者每分支独立 Merkle 快照（`~/.context/merkle/<identity-hash>.json`）
  - 快照含 `status: clean/dirty` 标记：dirty 表示上次索引被中断，下次全量重索引
  - **devChangedFiles**：持久化 dev 相对 root 的变更文件列表，搜索时 mask root 层
  - `getDevChangedFiles()` / `setDevChangedFiles()` — 搜索 masking 的数据源
  - MerkleDAG 使用增量流式 SHA256 hash（不再拼接全量字符串），内存友好
  - 允许 dot-dirs（`.github`, `.circleci`, `.devcontainer`）和 dot-files（`.eslintrc.js` 等）
  - 大文件（>10MB）使用流式 SHA256 hash，防 OOM
  - `git ls-files` 获取文件列表（50MB maxBuffer），JS 侧过滤扩展名和 ignore 规则
  - `markClean()` / `isDirty()` — 索引完成后标记快照干净
  - `checkForChanges()` / `generateFileHashes()` 支持 `onProgress` 回调
- `MerkleDAG` ([merkle.ts](packages/core/src/sync/merkle.ts)) — 内容哈希 DAG，紧凑型根节点哈希

### core/src/cache/ — 嵌入缓存
- `EmbeddingCache` 接口 → `MilvusEmbeddingCache` / `NoopEmbeddingCache`
- 内容哈希去重：相同内容的 chunk 不重复调 embedding API

### core/src/index-state/ — 提交级索引状态
- `CommitIndexState` — 记录每个 identity(branch) 的 last-indexed-commit（仅服务端使用）
- 开发者端不再写入 CommitIndexState，改用本地 Merkle 快照

### core/src/utils/ — 工具
- `git-identity.ts` — `getRepoIdentity()`: `gitRemote:branch`
- `dev-fingerprint.ts` — **开发者身份标识**：`getDevFingerprint()` / `getDevRepoIdentity()` / `getBranchIdentity()`
  - 三级解析：`CLAUDE_CONTEXT_DEV_ID` env → `git config user.email` → `hostname` → `/etc/machine-id`
  - 指纹格式 `<slug>_<hash>`（12 字符 + 4 字符 MD5），防相似 email 碰撞
  - 缓存到 `~/.claude-context/dev-id`，持久稳定
- `git-history.ts` — git 历史操作：diff changed files、commit 查询（服务端使用）
- `glob-matcher.ts` — glob 模式匹配
- `env-manager.ts` — 环境变量管理
  - 缓存 `.env` 文件内容（30s TTL），避免热路径磁盘 I/O
  - 支持 dotenv 标准语法：引号、注释（`#`/`//`）、`export` 前缀
  - 优先级：`process.env` > `.env` 文件

### graph — 知识图谱（v2 — 2026-07 重构）

v2 对标 CodeGraph 进行重构，核心变化：

| 维度 | v1 (旧) | v2 (新) |
|------|---------|---------|
| 存储位置 | `~/.context/graph/` 全局 DB | `<project>/.context/graph/knowledge-graph.db` 随项目存储 |
| 提取 | 2 遍（定义 + 调用） | 3 遍（定义 + unresolved ref + 路由） |
| 解析 | FunctionRegistry（同文件内） | ReferenceResolver（跨文件 import 追踪 + 名称匹配） |
| 遍历 | CallTracer（BFS only） | GraphTraverser（BFS/DFS/影响面/最短路径/类型层级） |
| 解析 | 单 Worker，用完即弃 | ParseWorkerPool 持久池 + StoreWriter 专用写线程 |
| 节点元数据 | label + properties | kind/language/signature/visibility/isExported/provenance |
| 边元数据 | type + properties | kind/line/column/provenance/metadata |
| 引用解析 | 无 | import 解析 → 跨文件 CALLS 边 |

#### graph v2 核心模块

- `SqliteGraphStore` ([graph-store.ts](packages/graph/src/graph-store.ts)) — 项目内 SQLite 存储（WAL 模式, FTS5）
  - `beginBulkLoad()`/`endBulkLoad()` — 批量写入模式（禁用 FTS 触发器 + FK）
  - `getReadonlyDB()` — 只读副本连接，搜索不阻塞写入
  - **unresolved_refs 表** — 待解析引用的行级追踪（pending/failed 状态）
  - `getEdgesBySourceKinds()`/`getEdgesByTargetKinds()` — SQL IN 批量查询替代 N 次单查
  - Schema: nodes（19 列）+ edges（10 列）+ unresolved_refs（9 列）+ files + nodes_fts
- `GraphIndexer` ([indexer.ts](packages/graph/src/indexer.ts)) — 4 阶段编排器
  1. **扫描**（git ls-files 或 filesystem walk）
  2. **解析**（GraphExtractor → InMemoryGraphBuffer + unresolved refs）
  3. **存储**（批量 flush 到 SQLite，每 10K 行 yield 事件循环）
  4. **解析**（ReferenceResolver → 跨文件 CALLS 边 + 边类型提升）
- `GraphExtractor` ([extractor.ts](packages/graph/src/extractor.ts)) — 3 遍 tree-sitter 提取
  - Pass 1: 收集定义 → nodes + CONTAINS 边
  - Pass 2: 调用表达式 → unresolvedRefs（不直接创建 CALLS 边）
  - Pass 3: HTTP 路由收集
  - **作用域修复**（2026-07）：`const sum = add(x,y)` 中 add 调用的父节点正确为函数而非变量
- `ReferenceResolver` ([resolution/index.ts](packages/graph/src/resolution/index.ts)) — 多策略引用解析管线
  - `resolveOne` 策略链: pre-filter → import-mapping → name-match → jvm-fqn → razor-using
  - `resolveViaImport` — 解析 import 语句 → 在导入文件中按 kind+name 匹配目标节点
  - `knownNames` Set O(1) 预过滤（跳过不存在的符号）
  - LRU 缓存（5000 entries）: 文件内容/import 映射/节点查找
  - `resolveAndPersistBatched` — 分批解析（500/batch），yield 事件循环
  - 边类型提升: calls→instantiates（target 为 class）、extends→implements（target 为 interface）
- `GraphTraverser` ([traversal.ts](packages/graph/src/traversal.ts)) — 图遍历算法
  - BFS/DFS（含边优先级排序 contains > calls > instantiates > references）
  - `getCallers`/`getCallees` — 调用者/被调用者追踪（含 instantiates 边）
  - `getCallGraph` — 双向调用图
  - `getTypeHierarchy` — 类型层级（extends/implements 祖先+后代）
  - `getImpactRadius` — 变更影响面分析（排除 contains 防爆炸）
  - `findPath` — 两节点最短路径（BFS）
  - `getAncestors`/`getChildren` — 容器层级
- `GraphQueryManager` ([queries.ts](packages/graph/src/queries.ts)) — 高级查询
  - `getContext` — 节点完整上下文（祖先、子、入/出引用、类型、导入）
  - `getFileDependencies`/`getFileDependents` — 跨文件依赖分析
  - `findDeadCode` — 死代码检测
  - `findCircularDependencies` — 循环依赖检测
  - `getNodeMetrics` — 复杂度指标
- `GraphSearcher` ([searcher.ts](packages/graph/src/searcher.ts)) — 图搜索（FTS5 BM25 + grep + 图富化）
- `ArchitectureAnalyzer` ([architecture.ts](packages/graph/src/architecture.ts)) — 入口点检测、模块聚类、内聚度计算
- `InMemoryGraphBuffer` ([graph-buffer.ts](packages/graph/src/graph-buffer.ts)) — Phase 1 内存图缓冲（惰性二级索引、字符串驻留）

#### graph v2 多线程基础设施

- `ParseWorkerPool` ([parse-pool.ts](packages/graph/src/parse-pool.ts))
  - 持久 Worker Threads（默认 `max(1, cores-2)`），为 Milvus 留核
  - 每 250 文件回收 Worker（WASM 内存泄漏防护）
  - 超时处理（30s 基础 + 3x 硬杀）
  - Grammar WASM 一次性加载 → 传递给每个 Worker
- `StoreWriter` ([store-writer.ts](packages/graph/src/store-writer.ts))
  - 专用 Worker Thread 处理 SQLite 写入
  - 窗口 backpressure（64 个未确认 bundle）
  - `drain()` 等待所有写入完成

#### 图索引共享模型

图索引 DB 存储在 `<project>/.context/graph/knowledge-graph.db`，已加入 `.gitignore`：
- **Git 跟踪方案评估**：SQLite 二进制文件不适合 git。多个开发者同时修改代码会导致 DB 文件冲突无法合并；DB 重建速度快（<5s 本项目）。DB 文件随工作树通过 Merkle 同步自动维护，始终与当前文件内容一致。
- **团队共享**：每个开发者本地运行 `index` 重建自己的图索引。图索引与当前工作树文件内容严格一致（Merkle 内容哈希），不依赖 git 历史。
- **克隆新项目**：搜索触发自动图索引构建（`maybeAutoBuildGraphIndex`），首次搜索时自动初始化。

#### 图索引关键环境变量

- `CODEGRAPH_PARSE_WORKERS` — Worker 池大小覆盖（默认 `cores-2`）
- `CODEGRAPH_PARSE_TIMEOUT_MS` — 单文件解析超时（默认 30s）

### mcp — MCP 服务（唯一对外入口）
- `src/index.ts` — 入口，`ContextMcpServer` 类
  - 关键：`console.log` 重定向到 stderr，stdout 只走 MCP JSON 协议
  - `shutdown()` — 优雅退出：停止后台同步、释放全局锁、关闭 graph store
  - SIGINT/SIGTERM 信号处理调用 shutdown
- `src/handlers.ts` — MCP Tool handler：
  - `handleIndex` — 向量 + 图联合索引（使用 `syncIndexByMerkle` 到 dev collection，背景执行）
  - `handleSearchCode` — `searchWithLayers` 搜 dev ⊕ root 两层，**root 层带 masking**（devChangedFiles 排除），保证 dev 版本强制优先
  - `handleClearIndex` — 取消在途索引 → 清除 dev collection + Merkle 快照 + graph index
  - `handleStatus` — 检查 dev + root 两层索引状态
  - `syncCollectionState()` — 从 Milvus collections 同步本地快照状态
  - `enrichWithGraphContextDeep()` — **4 层图增强**：
  1. **Call Graph**：直接调用关系（callers/callees + 函数签名，含出入度）
  2. **Change Impact**：top 3 匹配符号的变更影响面（impact radius）
  3. **File Dependencies**：通过 graph symbols 标注的文件依赖链
  4. **Architecture**：入口点摘要（首次搜索时 emitted）
- `src/graph-handlers.ts` — 图操作 handler：`handleIndexRepository`（3 阶段）、`handleSearchGraph`、`handleTracePath`、`handleGetArchitecture`等
- `src/sync.ts` — 后台自动同步（默认每 5 分钟，使用 `syncIndexByMerkle`）
  - 全局锁 stale 阈值 2 分钟（兜底回收），可通过 `CLAUDE_CONTEXT_SYNC_LOCK_STALE_MS` 调整
  - 文件变更触发器（`~/.context/.sync-trigger`）+ 2s 消抖
- `src/config.ts` — MCP 配置解析（环境变量 → `ContextMcpConfig`）
- `src/snapshot.ts` — 代码库快照管理（v2 格式）

### git-index-service — 定时云端索引
- 从 GitLab/配置文件获取 repo 列表 → clone → index → 定期重索引
- **只索引 root 分支**（main/master），使用 `syncIndexByGit`（git commit diff）
- 开发者不写 root collection，只读取
- 支持 SSH Key、HTTP 管理 API、热配置

## 开发命令

```bash
# 安装依赖
pnpm install

# 构建
pnpm build:core && pnpm build:graph && pnpm build:mcp

# 或全量构建
pnpm build

# 类型检查
pnpm typecheck

# lint（eslint flat config）
pnpm lint
pnpm lint:fix

# 运行 MCP 服务 (开发)
cd packages/mcp && pnpm dev

# 测试
pnpm --filter @seeway/claude-context-core test
pnpm --filter @seeway/claude-context-graph test
pnpm --filter @seeway/claude-context-mcp test
```

## MCP 工具接口（对外暴露）

| 工具 | 参数 | 说明 |
|------|------|------|
| `index` | path?, force?, splitter?, customExtensions?, ignorePatterns? | 索引代码库（向量+图谱） |
| `search` | query*, path?, limit?, extensionFilter? | 语义+图谱搜索 |
| `clear` | path? | 清除向量和图索引 |
| `status` | path? | 索引状态查询 |

## 部署

- 启动 MCP 服务：`node packages/mcp/dist/index.js`
- 基础设施依赖：Milvus（向量库） + Ollama（Embedding），部署在公司服务器 10.50.4.149
  - Milvus: `10.50.4.149:19530`
  - Ollama: `http://10.50.4.149:11434`
- 可通过环境变量覆盖：`OLLAMA_HOST`, `MILVUS_ADDRESS`, `EMBEDDING_MODEL`, `EMBEDDING_DIMENSION`
- 环境变量配置参考：`~/.context/.env`

## 代码约定

- TypeScript commonjs 模块（`packages/mcp` 和 `git-index-service` 例外使用 ESM）
- 命名风格：camelCase 变量/函数，PascalCase 类/接口
- 核心类 `Context` 是状态ful 的，通过构造函数注入依赖
- 环境变量统一通过 `envManager` 访问（不做 `process.env` 直读）
- repo identity 格式：
  - 分支 identity：`<git-remote-url>:<branch>`（用于 root collection、graph）
  - 开发者 identity：`<git-remote-url>:<branch>:<devFingerprint>`（用于 dev collection）

## 分支说明

- `main` — 主分支，所有开发直接在此进行

## 最近开发重点（2026-07）

- **本地全量索引禁用**（2026-07-24）：
  - 本地 MCP 端不再允许无服务端 root collection 时的全量索引（防止团队成员占用公司 Milvus 资源索引私人项目）
  - `syncIndexByMerkle()` 无 root 时抛错（不再回退到全量模式）
  - `handleIndexCodebase()` 增加 root collection 前置检查，提前拦截
  - 新增环境变量 `LOCAL_FULL_INDEX_ENABLED`（默认 false），设为 `true` 可恢复全量索引能力（管理员/测试）
  - git reset/rebase 后的增量索引更新已确认正常：Merkle 内容哈希追踪与 git commit SHA 解耦
- **Delta 索引 + 搜索 masking**（2026-07-24）：
  - 首次索引：云端 root 集合存在 → `git diff --name-only origin/main` → 只索引变更文件
  - dev 集合从全量副本改为 delta（仅存变更文件），root 层补充未修改文件
  - 搜索 root 层硬 masking：`buildMaskFilter(devChangedFiles)` → dev 版本强制优先（不再靠 RRF 概率争胜）
  - devChangedFiles 持久化到 Merkle 快照 + 后续增量自动维护
  - FileSynchronizer 新增 `getDevChangedFiles()` / `setDevChangedFiles()`
- **项目精简**（2026-07-24）：
  - 移除 packages/vscode-extension 和 packages/chrome-extension（不再需要）
  - 品牌统一：移除 Zilliz/Attu 引用，日志前缀 `[SYNC-CLOUD]` → `[COLLECTION-SYNC]`
  - `zilliz-utils.ts` → `cluster-utils.ts`，`ZillizConfig` → `ClusterConfig`
  - `syncIndexedCodebasesFromCloud` → `syncCollectionState`
  - `COLLECTION_LIMIT_MESSAGE` 文本去 Zilliz 品牌
- **索引可靠性修复**（2026-07-24）：
  - `generateFileHashesFromFS` 子目录递归路径拼接 bug 修复（fallback 模式下子目录文件全部漏索引）
  - `buildMerkleDAG` 增量流式 SHA256 hash（不再拼接全量路径字符串，大仓库内存友好）
  - `git ls-files maxBuffer`: 10MB → 50MB（防大仓库降级到慢速文件系统遍历）
  - `generateFileHashes` / `checkForChanges` 支持 `onProgress` 可选回调
- **忽略规则完善**（2026-07-24）：
  - `DEFAULT_IGNORE_PATTERNS` 新增 ~50 条覆盖：Java/Kotlin/Scala、Python site-packages、C/C++ third_party/external/_deps、Ruby、Elixir、Dart/Flutter、游戏引擎（Unity/Unreal/Godot）、PlatformIO、OS junk files 等
- **P0 审计修复**（2026-07-23）：
  - 真正的 dev ⊕ root 两层搜索（不再二选一）
  - Merkle 快照 dirty/clean 标记 → 防"幽灵 up-to-date"
  - `syncIndexByMerkle` 移除 monkey-patching → `collectionNameOverride` 参数传递
  - Milvus load 缓存自动失效 + 重试（防重启后搜索失败）
  - Embedding API 指数退避重试（3次）+ fatal 错误跳过
  - Embedding 缓存错误分类处理（维度/主键/其他）
  - 全局 dotfiles 跳过 → 允许 `.github/.circleci/.devcontainer` 和 dot-files
  - DevFingerprint 追加 4 字符 hash 防碰撞
  - 优雅退出释放锁 + 关闭 store
- **P1 优化**：chunk 失败 retryBuffer、batch delete、abort 每 batch 检查、threshold 全模式生效
- **P2 性能**：envManager 缓存、query embedding LRU、RRF_K 可配、INDEX_CHUNK_LIMIT 可配
- **Dev-aware 索引架构**：开发者私有索引 + Merkle 内容追踪，对 git reset/rebase/stash 免疫
- **DevFingerprint**：稳定开发者身份标识（env/git-email/hostname/machine-id 四级）
- **embedding cache**：全局共享向量缓存，跨开发者/跨分支复用
- 性能优化：Worker Threads 并行解析、批量 SQL、事件循环不阻塞
- 知识图谱自动构建（首次 search 触发）