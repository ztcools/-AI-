# claude-context — Seeway 代码索引 MCP 服务

> 代码智能索引工具，双引擎：向量语义搜索 (Milvus) + 知识图谱 (SQLite)。

## Quick Start — 最简使用

```
首次使用:  index   →   搜索: search(query="how does auth work")
                          ↓
              拿到 file:line + 签名 + 调用关系
                          ↓
              必要时 Read 定点区间（不要通读文件！）
```

**search 工具 3 种模式**：

| mode | 适用场景 | 示例 prompt |
|------|---------|-------------|
| `both` (默认) | 探索流程、理解子系统 | "how does auth work" |
| `vector` | 找具体实现、搜概念 | "find the User model" |
| `graph` | 追踪调用关系、影响面 | "who calls sendEmail" |

**search vs Read 对比**（实测数据）：
- search 平均 **节省 77% token**（只用 Read 的 23%）
- 覆盖率 **83%**（期望的符号被找到）
- search 告诉你**在哪 + 谁在用 + 调用链**，Read 只有原始代码
- **先 search 定位 → 再 Read 定点行区间**，不要从头通读文件

---

## 项目概述

双引擎架构：

```
                    ┌─────────────────────────┐
                    │     MCP search API       │
                    │  mode: both/vector/graph │
                    └───────────┬─────────────┘
                                │
            ┌───────────────────┴───────────────────┐
            │                                       │
    ┌───────▼────────┐                    ┌────────▼─────────┐
    │  向量索引 (Milvus)│                    │  图索引 (SQLite)   │
    │  云端只读检索     │                    │  结构查询          │
    │  按 repo:branch  │                    │  调用图/影响面     │
    │  hybrid RRF 融合 │                    │  跨文件引用解析    │
    └───────┬────────┘                    └────────┬─────────┘
            │                                       │
    ┌───────▼────────┐                    ┌────────▼─────────┐
    │ Milvus Server   │                    │ .context/graph/   │
    │ 10.50.4.149     │                    │ <project> 本地    │
    │ (团队共享)       │                    │ (开发者本地,已    │
    └────────────────┘                    │  gitignore)       │
                                          └──────────────────┘
```

**搜索合并流程**（`mode=both`）：
1. 向量 + 图搜索**并行**执行
2. 向量结果标注匹配的图符号名称和出入度
3. 图符号独立展示未匹配项
4. 图上下文富化（4 层）：调用图 → 影响面 → 架构摘要

---

## 索引架构

### 向量索引（Milvus, 云端统一管理 + 本地只读检索）

本地【不做】任何向量索引写入。向量统一由云端 git-index-service 按 `仓库:保护分支`
预先索引到 Milvus；本地 MCP 只做 ①查询向量化 ②直连云端 Milvus 只读检索。

```
identity    = normalizeGitUrl(gitRemote) + ':' + branch     # 云端保护分支
collection  = (hcc|cc)_<slug32>_<md5(identity)[:8]>
寻址        = getCollectionNameForIdentity(identity)
```

- **link**：`/seeway-link` 把当前仓库绑定到云端某保护分支的 collection（会话级，进程内存不落盘）。
- **搜索**：单层云端 collection 只读检索（dense + BM25 sparse，RRF 融合）。
- **管理**：仓库/保护分支的增删与索引全在 PhiGent 控制台（云端）手动管理。

### 图索引（SQLite, 随项目存储）

- DB 位置：`<project>/.context/graph/knowledge-graph.db`（已 `.gitignore`）
- 每开发者本地运行 `index` 重建，不与 git 耦合
- 首次 `search` 时自动触发图索引构建
- Merkle 内容哈希检测变更，对 git reset/rebase/stash 免疫

### git 操作场景行为

| 操作 | 图索引（本地） | 向量索引（云端） |
|------|--------|---------|
| 修改文件 | git diff → 真增量重建 | 无关（云端每日定时更新） |
| git reset/rebase/checkout | 内容变化 → 增量/全量重建 | 无关 |
| 索引器升级 | INDEXER_VERSION 版本戳 → 自动识别旧图重建 | 无关 |

> 本地改动与云端索引的短暂不一致是设计接受的：改动的文件在当前 agent 上下文里，
> 无需对它们做增量向量索引。

---

## 项目结构

```
claude-context (pnpm monorepo)
├── packages/core          @seeway/claude-context-core     # 向量索引引擎
├── packages/graph         @seeway/claude-context-graph    # 知识图谱引擎 (v2)
├── packages/mcp           @seeway/claude-context-mcp      # MCP 服务（对外入口）
└── packages/git-index-service                              # 服务端定时索引
```

**依赖关系**：`mcp → core + graph`，`graph → 独立`，`core → 独立`

---

## 图索引 v2 核心模块（7,200 行，2026-07 重构）

v2 对标 CodeGraph，核心变化：项目内存储、跨文件引用解析、完整图算法。

### 索引流程（4 阶段）

```
扫描 (git ls-files)
  → 解析 (GraphExtractor → InMemoryGraphBuffer + unresolved refs)
  → 存储 (批量 flush SQLite, 每 10K 行 yield)
  → 解析 (ReferenceResolver → 跨文件 CALLS 边 + 边类型提升)
```

### 核心文件

| 文件 | 行数 | 职责 |
|------|------|------|
| [graph-store.ts](packages/graph/src/graph-store.ts) | 1195 | SQLite 存储、FTS5 全文搜索、3 阶段搜索（FTS→LIKE→前缀） |
| [extractor.ts](packages/graph/src/extractor.ts) | 1598 | tree-sitter 3 遍提取：定义→unresolvedRef→路由 |
| [traversal.ts](packages/graph/src/traversal.ts) | 589 | BFS/DFS/getCallers/getCallees/impactRadius/findPath |
| [indexer.ts](packages/graph/src/indexer.ts) | 527 | 4 阶段编排、48 种语言目录 ignore、增量同步 |
| [queries.ts](packages/graph/src/queries.ts) | 320 | 文件依赖/死代码/循环依赖/上下文查询 |
| [resolution/index.ts](packages/graph/src/resolution/index.ts) | 859 | 多策略引用解析：pre-filter→import→name→suffix→fuzzy |
| [resolution/import-resolver.ts](packages/graph/src/resolution/import-resolver.ts) | 24K | JS/TS/Python/Java/Go/Rust/C++/C# import 解析 |
| [resolution/name-matcher.ts](packages/graph/src/resolution/name-matcher.ts) | 23K | 同名/唯一名/后缀/模糊匹配 + 语言内置黑名单 |
| [types.ts](packages/graph/src/types.ts) | 520 | GraphNode/GraphEdge/UnresolvedReference/Subgraph/ResolutionResult 等 |

### 搜索算法

`findNodes` 三层回退策略：
1. **FTS5** — BM25 全文搜索（`-bm25()` 正向评分, `ORDER BY score DESC`）
2. **LIKE 多数匹配** — FTS 结果 < limit 时补充。≤3 个有意义词用 OR，4+ 词用 `ceil(N/2)` 多数
3. **前缀回退** — LIKE 仍无结果时，长词（>4 chars）用 60% 前缀 + OR 语义

**噪声过滤**：`buildNodeResults` 统一排除 `import | variable | parameter | file | enum_member | constructor`

**调用图遍历噪声过滤**：`GraphTraverser.isNoise` 排除上述种类

### MCP handler

| 文件 | 职责 |
|------|------|
| [handlers.ts](packages/mcp/src/handlers.ts) | `handleIndex`(向量+图), `handleSearchCode`(3 mode), `handleClearIndex`, `handleStatus` |
| [graph-handlers.ts](packages/mcp/src/graph-handlers.ts) | `GraphToolHandlers` — 图索引编排 + graph search/trace/architecture |
| [index.ts](packages/mcp/src/index.ts) | MCP server 启动 + 工具注册 + 工具描述 |
| [sync.ts](packages/mcp/src/sync.ts) | 后台自动同步（5min 间隔）+ 文件变更触发 |

---

## 开发命令

```bash
pnpm install
pnpm build                        # 全量构建
pnpm test                         # = pnpm --filter @seeway/claude-context-graph test
cd packages/mcp && pnpm dev       # 本地启动 MCP 服务
```

## 测试方法

本地验证（不依赖 Milvus）：
```bash
# 图索引端到端测试 — 验证 index/search/traversal/dependencies
node -e "
const { GraphIndexer, GraphTraverser } = require('./packages/graph/dist/index.js');
const ix = new GraphIndexer('/path/to/project', 'test:main');
await ix.indexAll();
// test search, traversal...
"
```

---

## 关键环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `SEARCH_THRESHOLD` | 0.4 | 相对分数截断（`topScore * threshold` 以上保留） |
| `SEARCH_DEFAULT_LIMIT` | 10 | 每次 search 返回最大条数 |
| `SEARCH_SCORE_RATIO` | 0 | 尾部截断（0=禁用） |
| `SEARCH_SNIPPET_MAX_CHARS` | 4000 | 每条结果最大字符数 |
| `CODEGRAPH_PARSE_WORKERS` | cores-2 | 图解析 Worker 池大小 |
| `RRF_K` | 100 | RRF 融合 k 参数 |
| `LOCAL_FULL_INDEX_ENABLED` | false | 允许无 root 时的本地全量索引 |
| `CLAUDE_CONTEXT_DEV_ID` | git email | 开发者身份覆盖 |

---

## 代码约定

- TypeScript commonjs（mcp 和 git-index-service 用 ESM）
- 环境变量通过 `envManager` 读取（不直读 `process.env`）
- repo identity: `normalizeGitUrl(<gitRemote>):<branch>`（云端保护分支寻址与本地图 project 共用）
- 图节点/边: `kind` 为主字段（`label`/`type` 为 deprecated 向后兼容）
- 分支: `main`，所有开发在此直接进行

## 部署

- MCP 启动：`node packages/mcp/dist/index.js`
- 基础设施：Milvus `10.50.4.149:19530` + Ollama `http://10.50.4.149:11434`
- 环境变量配置：`~/.context/.env`

---

## 搜索质量基准（2026-07 实测, 12 个真实开发场景, 243 节点项目）

| 指标 | 值 | 说明 |
|------|-----|------|
| Token 节省 | **77%** | search 1163t vs Read 5116t |
| 符号覆盖率 | **83%** | 期望的 30 个符号中命中 25 个 |
| 调用图精度 | **register 7/7, login 5/5** | 跨文件调用链完整 |
| FTS 搜索延迟 | **0.6ms** | 单次 BM25 搜索 |
| 索引性能 | **0.9ms/文件** | 200 文件 182ms |
| 并发吞吐 | **2,273 qps** | 50 searches in 22ms |

## 最近重构历史（2026-07）

```
e086529 feat: search 工具描述增强 — 显式 mode 选择指南
d8e2082 fix: LIKE 回退智能去噪 + 短查询 OR 语义 — 召回率 77%→83%
9c5463c fix: search 召回率 + 遍历噪声 — 3 项核心修复
88d4d83 fix: 跨类方法调用解析 — pre-filter suffix 匹配 + matchSuffixName
954b6cb fix: buildNodeResults 噪声过滤失效 + constructor 过滤
4852551 fix: search 上下文质量 — 去噪 + 类节点遍历修正
04cfdf4 fix: BM25 排序修复 + 搜索精度策略重设计
8e903f4 fix: rebase/reset 后自动重新计算 devChangedFiles
b86bf64 fix: 跨文件引用解析修复 — extractor import 调用 → unresolved ref
1d39335 fix: 修复关键 Bug — edges 跳过/DB schema/元数据传播/异步I/O
2bc7e7f refactor: 提取 IgnorePatternManager 解耦 context.ts
```
