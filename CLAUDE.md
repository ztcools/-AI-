# claude-context — Seeway 代码索引 MCP 服务

> 代码智能索引工具，双引擎：向量语义搜索 (Milvus) + 知识图谱 (SQLite)。

## Quick Start — 最简使用

```
首次使用:  link   →   搜索: search(query="how does auth work")
                          ↓
              拿到 file:line + 签名 + 调用关系
                          ↓
              必要时 Read 定点区间（不要通读文件！）
```

> 没有 `index` 工具：本地向量写入按设计禁用，`link` 会在后台自动建/更新本地图索引。

**search 工具 3 种模式**（2026-07-30 双 C++ 真实仓库实测，36 个期望符号）：

| mode | 召回 | token | 延迟 | 需要 link | 适用场景 |
|------|------|-------|------|-----------|---------|
| `graph` | 86% | ~300 | 60–105ms | 否 | 关系/影响面/死代码/入口；只要位置+调用链时的首选 |
| `both` (默认) | 93% | ~2200 | 128–220ms | 是（向量部分） | 需要代码片段本身；或目标概念未被任何标识符拼出 |
| `vector` | 83% | ~1700 | ~50ms | 是 | 语义找实现，不需要调用图 |

`graph` 模式接受自然语言，不必点出符号名：标识符按词切分 + 词干化，
"initialize logging and create the log manager" 可命中 `InitLogging`/`LogManager`。

**search vs Read 对比**（实测数据）：
- search 平均 **节省 77% token**（只用 Read 的 23%）
- search 告诉你**在哪 + 谁在用 + 调用链**，Read 只有原始代码
- **先 search 定位 → 再 Read 定点行区间**，不要从头通读文件
- 小仓库（< ~300 文件）grep 基线更优，实测 flask/requests 8 场景全胜 — search 是"定位第一跳"，不是替代品

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
  连不上 Milvus 与"云端没建这个索引"是两种不同的报错：前者带上 gRPC 的真实原因提示查
  `MILVUS_ADDRESS`/网络，后者提示去控制台加保护分支 —— 别把网络故障说成"索引不存在"。
- **搜索**：单层云端 collection 只读检索（dense + BM25 sparse，RRF 融合）。
- **管理**：仓库/保护分支的增删与索引全在 PhiGent 控制台（云端）手动管理。

**只读闸门**：本地 MCP 构造 core 时硬编码 `readOnly: true`
（[mcp/src/index.ts:74](packages/mcp/src/index.ts#L74)），建/删 collection、insert/delete、
索引编排一律拒绝 —— 本地"不做向量索引"是代码级保证，不靠约定。直接调 core 的脚本可另加
`VECTOR_READONLY=true` 兜底；云端 git-index-service【不要】设它，它就是写入方。

> **SDK 陷阱**：`@zilliz/milvus2-sdk-node` 在 `MilvusClient` **构造函数里**就发起 `connect()`，
> 把 promise 挂在 client 上，没人 await。Milvus 连不上时它是一个 unhandledRejection——
> Node 默认**直接终止进程**，把整个 MCP server（以及用同一个类的云端索引服务）打挂，而不是
> 让那一次调用报错。`MilvusVectorDatabase` 现在把它接住并在 `ensureInitialized()` 里 await
> （见 [milvus-vectordb.ts](packages/core/src/vectordb/milvus-vectordb.ts)）。换 SDK 版本后
> 这个字段名若变了要跟着改，否则退化成静默的进程猝死。

### 图索引（SQLite, 随项目存储）

- DB 位置：`<project>/.context/graph/knowledge-graph.db`（已 `.gitignore`）
- 每开发者本地构建，不与 git 耦合；`link` 后台自动建图，`search` 兜底触发
- Merkle 内容哈希检测变更，对 git reset/rebase/stash 免疫
- 解析走 worker 池（`CODEGRAPH_PARSE_WORKERS`，默认 cores-2），单文件超 `CODEGRAPH_PARSE_TIMEOUT_MS` 跳过

**多仓库并发**：`GraphToolHandlers` 按仓库目录缓存 bundle（store/traverser/searcher/architecture），
LRU 上限 `MAX_OPEN_GRAPHS = 8`（[graph-handlers.ts:68](packages/mcp/src/graph-handlers.ts#L68)）。
所有 handler 用**显式路径**取 store（`getStore(projectDir)` / `bundleFromArgs(args)` 只认
`repo_path`），不再依赖一个可变的"当前项目"指针 —— 旧实现里 `setProject(B)` 会 close 掉 A 的
store，同一轮里并发搜 A、B 会互相踩踏（A 丢调用链富化，甚至读到空图后触发全量重建）。
淘汰时跳过当前项目，但**继续往后找可淘汰项**而不是 break，否则当前项目一排到队首上限就形同虚设。
`SqliteGraphStore.close()` 之后读路径直接抛错，不再懒重开连接 —— 悄悄开回来会同时废掉 fd 上限
和"图是空的"判定。

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

## 图索引 v2 核心模块（11,600 行，2026-07 重构）

v2 对标 CodeGraph，核心变化：项目内存储、跨文件引用解析、完整图算法。

### 索引流程（4 阶段）

```
扫描 (git ls-files)
  → 解析 (worker 池 → GraphExtractor → InMemoryGraphBuffer + unresolved refs)
  → 存储 (批量 flush SQLite, 每 10K 行 yield)
  → 解析 (ReferenceResolver → 跨文件 CALLS 边 + 边类型提升)
```

`INDEXER_VERSION = 5`（[indexer.ts:58](packages/graph/src/indexer.ts#L58)）——
提取/解析/遍历逻辑变更时必须 +1，旧图会被自动识别并重建。

### 核心文件

| 文件 | 行数 | 职责 |
|------|------|------|
| [extractor.ts](packages/graph/src/extractor.ts) | 1850 | tree-sitter 3 遍提取：定义→unresolvedRef→路由 |
| [graph-store.ts](packages/graph/src/graph-store.ts) | 1790 | SQLite 存储、FTS5 全文搜索、查询构造与去噪、读语句缓存 |
| [resolution/index.ts](packages/graph/src/resolution/index.ts) | 944 | 多策略引用解析：pre-filter→import→name→suffix→fuzzy |
| [resolution/name-matcher.ts](packages/graph/src/resolution/name-matcher.ts) | 750 | 同名/唯一名/后缀/模糊匹配 + 语言内置黑名单 |
| [indexer.ts](packages/graph/src/indexer.ts) | 742 | 4 阶段编排、48 种语言目录 ignore、增量同步 |
| [resolution/import-resolver.ts](packages/graph/src/resolution/import-resolver.ts) | 707 | JS/TS/Python/Java/Go/Rust/C++/C# import 解析 |
| [traversal.ts](packages/graph/src/traversal.ts) | 612 | BFS/DFS/getCallers/getCallees/impactRadius/findPath |
| [parse-pool.ts](packages/graph/src/parse-pool.ts) | 585 | 解析 worker 池（共享 checkout、超时跳过、背压） |
| [types.ts](packages/graph/src/types.ts) | 540 | GraphNode/GraphEdge/UnresolvedReference/Subgraph/ResolutionResult 等 |
| [queries.ts](packages/graph/src/queries.ts) | 320 | 文件依赖/死代码/循环依赖/上下文查询 |

### 搜索算法（`findNodes`）

**索引层**：FTS5 external-content 表覆盖 `nodes`，tokenizer `porter unicode61 remove_diacritics 1`
（标识符按 camelCase/下划线切词后再做词干化，所以自然语言能命中符号名）。
BM25 列权重 `(name, search_text, qualified_name, file_path) = (3.0, 3.0, 0.5, 1.0)`。

**查询构造**（`buildFtsQuery`）：
1. **unigram 前缀臂** — 每个有意义词一条 `"ord"*`（能命中整体存储的 `OrderService`）
2. **bigram 短语臂** — 相邻词对限定到标识符列：`{name search_text} : "log manager"`。
   纯前缀 OR 只数"命中几个词"、对词序完全无感；短语臂在不加第二次查询的前提下补回邻接性
3. **缩写归一** — 30 组双向对（`config↔configuration`、`init↔initialize`、`mgr↔manager`…）
   **只在短语臂里展开**：缩写作为独立前缀是灾难（给 "execute" 加 `"exec"*` 会把整个 `ara::exec` 树扫进来，
   实测召回 79%→68%）
4. 臂去重，上限 `MAX_FTS_ARMS=28` / `MAX_QUERY_PHRASES=8`

**词表分层**：`QUERY_STOP_WORDS`（语法词，任何位置都丢）与 `QUERY_GENERIC_WORDS`
（`class/function/code/module`… 单独出现时丢，但在短语里保留 —— "error code" 正是问题要找的标识符）。
`meaningfulQueryTokens` 还做**去重**：重复词会被 BM25 数两次（"error code and error domain" 曾因 error 出现两次
把 ErrorDomain 顶到 ErrorCode 之上）。

**回退层**：FTS 结果不足时 → LIKE 多数匹配（≤3 词 OR，4+ 词 `ceil(N/2)`）→ 长词 60% 前缀。

**结果去噪**：`RESULT_NOISE_KINDS` 排除
`import | variable | parameter | file | enum_member | constructor | module`。
`module` = C++ `namespace` + Rust `mod`：容器而非答案，且会匹配自己所在目录名
（ap-client-api 8,700 节点里 777 个是 namespace，`namespace supervised_entity` 曾抢走 `class SupervisedEntity` 的头名）。

**概念多样性**（`diversifyByConcept`，MMR-lite）：同一查询短语命中的行最多占 `max(3, ceil(limit/3))` 条，
超出的**下溢到尾部而非丢弃**（保证 `offset` 分页一致）。修的是 0.02 分的边界丢失：
`RecoveryAction` 曾以 20.81 vs 20.83 落到第 11 名，被 10 条近重复的 `SupervisedEntity*` 挤出。

**调用图遍历噪声过滤**：`GraphTraverser.isNoise` 排除同一批种类。

### 响应 token 预算

`SEARCH_SNIPPET_MAX_CHARS` 单条上限管不住总量（10 条 × 4000 = 10k 字符）。
`snippetBudget()` 把 `SEARCH_TOTAL_MAX_CHARS`（默认 20000）按命中数均分，**下限 600 字符**
（低于此片段不再是可读代码）。`truncateContent` 按行边界截断并写明丢了几行。
实测最差单次 5922t→3888t（−34%），均值 2597t→2216t（−15%）。

### MCP handler

| 文件 | 职责 |
|------|------|
| [handlers.ts](packages/mcp/src/handlers.ts) | `handleLink`/`handleUnlink`, `handleSearchCode`(3 mode + token 预算), `handleClearIndex`, `handleStatus` |
| [graph-handlers.ts](packages/mcp/src/graph-handlers.ts) | `GraphToolHandlers` — 按仓库的 bundle 缓存(LRU 8) + 图索引编排 + graph search/trace/architecture |
| [index.ts](packages/mcp/src/index.ts) | MCP server 启动 + 工具注册 + 工具描述（core 构造处的 `readOnly: true` 在这里） |

**改这一层时的两条硬约束**：
1. **取 store 一定带路径**（`getStore(codebasePath)`），别依赖调用顺序。`maybeAutoBuildGraphIndex`
   曾在 `setProject` 之前读 stats，读到别的仓库的空图 → 判定"图是空的" → 删光重建。
2. **失败要出声**。`handleClearIndex` 原来吞掉异常后回一句"Nothing to clear"，现在返回
   `isError: true` + 真实原因。静默失败在这条链路上的代价是"用户以为清了，其实没清"。

`GraphIndexer` 按 project 复用并在 `close()` 里全部关闭 —— 每次 index 都 new 一个会漏 fd。

---

## 开发命令

```bash
pnpm install
pnpm build                        # 全量构建
pnpm test                         # = pnpm --filter @seeway/claude-context-graph test
pnpm typecheck
cd packages/mcp && pnpm dev       # 本地启动 MCP 服务
```

## 测试方法

**改检索排序时的必跑回归**（详见 [benchmarks/README.md](benchmarks/README.md)）：

```bash
# 1. 离线图召回（秒级，不碰 Milvus/不联网）—— 调 buildFtsQuery/diversifyByConcept 的主循环
pnpm build:graph
node benchmarks/graphbench.mjs <repoPath> benchmarks/scenarios/ap-client-api.graph.json
DUMP=1 node benchmarks/graphbench.mjs <repoPath> ...   # 打印排名细节，查"为什么第 11 名"

# 2. 图测试套件（每次改动后都要 7/7）
pnpm test

# 3. 端到端（需真实 Milvus + Ollama，跑真实 MCP handler）
node benchmarks/harness.mjs <repoPath> main benchmarks/scenarios/ap-client-api.json

# 4. 容量参数测量（定部署参数用，不是回归）
OLLAMA_HOST=http://10.50.4.149:11435 node benchmarks/embed-throughput.mjs   # → GIT_INDEX_CONCURRENCY
node benchmarks/worker-mem.mjs <repoPath>                                   # → GIT_INDEX_MEM_LIMIT
```

图索引单点验证（不依赖 Milvus）：
```bash
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
| `SEARCH_SNIPPET_MAX_CHARS` | 4000 | **单条**片段字符上限 |
| `SEARCH_TOTAL_MAX_CHARS` | 20000 | **整个响应**的片段预算，按命中数均分（单条下限 600） |
| `SEARCH_TEST_PENALTY` | 0.55 | 测试文件分数系数**默认值**（见下） |
| `SEARCH_DOC_PENALTY` | 0.5 | 文档/markdown 分数系数**默认值**（见下） |
| `CODEGRAPH_PARSE_WORKERS` | cores-2 | 图解析 worker 池大小（< 120 文件不启池，起池成本 ~250ms/worker） |
| `CODEGRAPH_PARSE_TIMEOUT_MS` | 10000 | 单文件解析超时，超时跳过该文件 |
| `RRF_K` | 100 | RRF 融合 k 参数 |
| `HYBRID_MODE` | true | dense + BM25 sparse 混合检索（团队索引均按 hybrid 建立） |
| `GIT_ROOT_BRANCHES` | main,master | 视为根分支的分支名 |
| `INDEX_CHUNK_LIMIT` | 450000 | 单次索引 chunk 上限（服务端） |

> `docs:true` / `tests:true` 走的是 `searchWithLayers` 的 `SearchRankingOptions` 显式入参
> （该次调用把对应系数当 0 用），**不改写 `process.env`**。旧实现是写
> `process.env.SEARCH_DOC_PENALTY='0'` 再在末尾 `delete` —— 用进程级全局态传单次调用的参数：
> 并发的两次 search 互相污染、任一提前 return/抛错就把覆盖永久留在进程里、`delete` 还会把
> 用户 `.env` 里配的真实值一起抹掉。加新的按次排序开关时照 `SearchRankingOptions` 加字段。

> 完整清单（含云端 git-index-service 的服务端变量）见 [.env.example](.env.example)。

---

## 代码约定

- TypeScript commonjs（mcp 和 git-index-service 用 ESM）
- 环境变量通过 `envManager` 读取（不直读 `process.env`）
- repo identity: `normalizeGitUrl(<gitRemote>):<branch>`（云端保护分支寻址与本地图 project 共用）
- 图节点/边: `kind` 为主字段（`label`/`type` 为 deprecated 向后兼容）
- 分支: `main`，所有开发在此直接进行

## 部署

- MCP 启动：`node packages/mcp/dist/index.js`
- 基础设施：Milvus `10.50.4.149:19530` + Ollama `http://10.50.4.149:11435`
- 环境变量配置：`~/.context/.env`（模板见 [.env.example](.env.example)）
- 云端栈（Milvus/MinIO/etcd/Ollama/git-index/PhiGent）编排在 `/home/zt/claude-context-local-stack`，
  部署步骤见 [DEPLOY.md](DEPLOY.md)

---

## 搜索质量基准（2026-07-30 实测，ap-client-api + PhiLog 两个真实 C++ 仓库，36 个期望符号）

**图检索召回（离线 graphbench，同一批场景）**：

| 仓库 | 优化前 | 优化后 | 延迟 |
|------|--------|--------|------|
| ap-client-api（8.7K 节点） | 58% | **79%** | 3–16ms |
| PhiLog | 76% | **88%** | 3–16ms |
| 合计 | — | **83%**（30/36） | — |

**端到端实测（真实 Milvus + Ollama，warm）**：

| 仓库 | both | vector | graph |
|------|------|--------|-------|
| ap-client-api | 94% / 219ms / 2216t | 81% / 55ms | 100% / 89ms / 442t |
| PhiLog @ main | 93% / 128ms / 2123t | 86% / 49ms | 88% / 55ms / 212t |

> Milvus 冷 collection 首查约 900ms（load），warm 后 ~220ms —— 不是回归。

**其他指标**：

| 指标 | 值 | 说明 |
|------|-----|------|
| 索引全链路 | **9.62s → 3.29s**（2.9×） | ap-client-api；其中 resolve 阶段 6.1s → 0.96s |
| 响应 token | 均值 2597t → **2216t**（−15%） | 最差单次 5922t → 3888t（−34%） |
| FTS 搜索延迟 | **0.6ms** | 单次 BM25 搜索 |
| 并发吞吐 | **2,273 qps** | 50 searches in 22ms |
| 云端索引并发 | 3 → **6**（吞吐 +82%） | Ollama embedding 饱和点，见下 |
| 单索引 worker 内存 | **~1 GiB** 峰值 RSS | 956 MiB 在 tree-sitter 堆外，V8 heap 仅 55 MiB |

**云端索引并发的定法**（`GIT_INDEX_CONCURRENCY`）：这个值由 embedding 吞吐决定，不是由核数决定 ——
索引侧每个仓库是一条串行 embed 流。实测（`benchmarks/embed-throughput.mjs`，本栈 ollama 32g/16cpu、4 卡）：

| 并发流 | 1 | 3 | 6 | 8 | 12 |
|--------|---|---|---|---|----|
| 吞吐 (embed/s) | 27 | 75 | **136** | 140 | 142 |
| 相对 1 流 | 1.00× | 2.74× | **4.98×** | 5.16× | 5.22× |
| 单流延迟 | 37ms | 40ms | 44ms | 57ms | 84ms |

6 之后吞吐不动、单流延迟翻倍 —— 纯排队。原默认 3 只用到约 55% 的向量化能力。
内存侧不必跟着线性上调：单 worker 峰值 ~1 GiB 且绝大部分在堆外，约束是 cgroup 上限
而非 V8 old-space（4.1 GiB），并发 6 最坏 ~6 GiB，`GIT_INDEX_MEM_LIMIT=16g` 留 2.5×。

> 已知取舍：`vector` 单模式召回从 88% 降到 81%，因为 `SyncToStorage` 埋在一个很长的 chunk 深处，
> 要捞回它需要 4000 字符片段（预算 40000）多花 ~2000 token —— 而 `both`/`graph` 本来就能正常给出该符号，
> 不值得为它抬高全局预算。

历次评估细节见 [SEARCH-EVALUATION.md](SEARCH-EVALUATION.md)。

## 最近重构历史（2026-07）

```
5d53316 docs(mcp): search 工具描述按实测重写 — graph 模式不再要求"必须点出符号名"
123016c feat: 图检索召回 58%→83% + 响应 token 上限 — 短语/缩写/概念多样性
f235d49 perf(graph): 索引全链路 2.9× — 接通 worker 池 + suffix_name 索引 + 读语句缓存
a83204b fix: C++ 提取按 declarator 命名 + 索引服务多平台认证/并发
51e9f9f fix: 审查驱动的 39 项 bug/耗时修复（6 critical + 14 high + 关键 medium）
1f89301 feat: search 触发规则 + 精度/成本优化 — 价值最大化轮
7d675fa feat: graph 模式也产出调用链富化 — 低成本拿核心链路
d4f301c feat: 图索引实时性 — 工作区变更自动增量重建（修复 3 层叠加 bug）
e2d7d44 refactor: 云端向量索引架构 — 本地零索引 + link 模式 + 多语言调用图质变
d8e2082 fix: LIKE 回退智能去噪 + 短查询 OR 语义 — 召回率 77%→83%
88d4d83 fix: 跨类方法调用解析 — pre-filter suffix 匹配 + matchSuffixName
04cfdf4 fix: BM25 排序修复 + 搜索精度策略重设计
b86bf64 fix: 跨文件引用解析修复 — extractor import 调用 → unresolved ref
```
