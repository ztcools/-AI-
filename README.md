# claude-context — Seeway 代码索引 MCP 服务

给 AI 编码 agent 用的代码检索工具。双引擎：**向量语义检索**（云端 Milvus，只读）+ **调用图**（本地 SQLite）。
一次 `search` 同时回答"代码在哪"和"谁在调用它"——这是 grep 做不到的部分。

## 它解决什么问题

agent 在陌生仓库里读代码，默认只有 grep/read：知道确切符号名时很好用，不知道时要么关键词命中上百处，
要么根本猜不到该 grep 什么。而"谁调用了它 / 改它会波及谁 / 这段是死代码吗"这类结构问题，grep 从原理上无法回答。

`search` 补的正是这两块：

| 能力 | grep/read | search |
|------|-----------|--------|
| 已知确切字符串/符号/路径 | ✅ 即时、零成本 | ❌ 更慢，别用 |
| 只知道意图，不知道叫什么 | ❌ 噪声淹没 | ✅ 语义 + 词干 + 缩写归一 |
| 谁调用它 / 调用链 / 影响面 | ❌ 无法判断 | ✅ 调用图直接给出 |
| 死代码 `[unused]` / 入口 `[entry]` | ❌ | ✅ 标记在结果里 |
| 要逐字完整文件 | ✅ | ❌ 用 Read |

**用法定位：search 是"定位第一跳"，不是 Read 的替代品。** 先 search 拿到 `file:line` + 调用链，
再用 Read 的 offset/limit 定点读那几行——这才是省 token 的关键动作。

## Quick Start

```
link                                   # 会话内一次，绑定云端向量索引 + 建本地图（后台自动）
  ↓
search(query="how does auth work")     # 拿到 file:line + 签名 + 调用关系
  ↓
Read(file, offset, limit)              # 只读需要的那几行，不要通读
```

`link` 之后图索引会随你改代码自动增量更新，**不需要任何手动 index**（本地向量写入按设计禁用，
向量只由云端按保护分支每日索引）。

## 三种 search 模式（2026-07-30 双 C++ 真实仓库实测，36 个期望符号）

| mode | 召回 | token | 延迟 | 需要 link | 什么时候用 |
|------|------|-------|------|-----------|-----------|
| `graph` | **86%** | ~300 | 60–105ms | 否 | 关系问题（谁调用 X / 影响面 / 死代码 / 入口）；只要位置和调用链、不要代码时的默认选择 |
| `both`（默认） | **93%** | ~2200 | 128–220ms | 是（向量部分） | 需要代码片段本身；或要找的东西**没有**被任何标识符拼出来（底层库、"零拷贝共享内存"这类概念） |
| `vector` | **83%** | ~1700 | ~50ms | 是 | 语义找实现，不需要调用图 |

`graph` 模式接受**自然语言**，不必点出符号名：标识符按词切分并做了词干化，
所以 "initialize logging and create the log manager" 能命中 `InitLogging` / `LogManager`，
"supervised entity recovery action" 能同时命中两个类。

**省 token 开关**：`style:"compact"`（只给 file:line，约 1/10 token）、`limit:5`、`enrich:false`（不带调用图）。
片段共享一个整体响应预算，`limit` 越大每条越短——想要完整片段就少要几条。

## 什么时候**不要**用

- **小仓库（< ~300 文件）**：实测在 flask/requests 上 grep 基线 8 个场景全胜。grep 更便宜且给的更全。
- **已知精确 token/符号/路径** → 直接 Grep/Read。
- **非 AST 语言**（图不生效，只剩弱语义）：Ruby、PHP、Kotlin、Swift、Vue 模板，以及配置/YAML/JSON/锁文件/Markdown。
  - AST/图**支持**：JS/TS、Python、Java、C/C++、Go、Rust、C#、Scala。
- **要逐字完整内容**（编辑整文件、格式敏感）→ Read。

## MCP 工具

| 工具 | 作用 |
|------|------|
| `link` | 绑定当前仓库到云端某保护分支的 collection（会话级，不落盘）+ 后台建/更新本地图。省略 `branch` 则列出云端候选分支 |
| `search` | 检索。参数：`query`、`mode`、`limit`、`style`、`enrich`、`extensionFilter`、`docs`、`tests`、`path` |
| `status` | link 状态（云端 repo@branch + 连通性）+ 本地图统计（节点/边/类型/路由） |
| `clear` | 清空本地图索引（云端向量不受影响） |
| `unlink` | 解绑云端索引，本地图保留 |

`docs` / `tests` 默认 `false`：文档与测试文件被降权，让生产代码胜出；找 README/用例时显式打开。

## 架构

```
                    ┌─────────────────────────┐
                    │     MCP search API       │
                    │  mode: both/vector/graph │
                    └───────────┬─────────────┘
            ┌───────────────────┴───────────────────┐
    ┌───────▼────────┐                    ┌────────▼─────────┐
    │ 向量索引 (Milvus)│  并行执行          │  图索引 (SQLite)  │
    │ 云端只读检索     │                    │  调用图/影响面     │
    │ 按 repo:branch   │                    │  跨文件引用解析    │
    │ dense+BM25 RRF   │                    │  FTS5 全文        │
    └───────┬────────┘                    └────────┬─────────┘
    ┌───────▼────────┐                    ┌────────▼─────────┐
    │ Milvus Server    │                    │ .context/graph/   │
    │ 10.50.4.149      │                    │ <project> 本地    │
    │ (团队共享)        │                    │ (已 gitignore)    │
    └────────────────┘                    └──────────────────┘
```

- **向量**：本地不做任何写入 —— MCP 构造引擎时硬编码 `readOnly: true`，建/删 collection、
  insert/delete、索引编排一律拒绝，这是代码级保证不是约定。云端 `git-index-service` 按
  `仓库:保护分支` 每日增量索引到 Milvus；本地只做 ①query 向量化 ②直连云端只读检索。
- **图**：`<project>/.context/graph/knowledge-graph.db`，每开发者本地构建，与 git 不耦合。
  Merkle 内容哈希检测变更，对 `git reset/rebase/stash` 免疫。
  一个 MCP 进程可同时持有多个仓库的图（LRU 上限 8），并发搜多个仓库互不干扰。

详细模块划分与算法见 [CLAUDE.md](CLAUDE.md)。

## 安装

```bash
# 1. 全局配置（不要放进代码仓库目录）
cp .env.example ~/.context/.env    # 按需改 MILVUS_ADDRESS / OLLAMA_HOST

# 2. 安装并注册 MCP
./install.sh
```

`install.sh` 会构建各 package、把 MCP 装到 `~/.claude-context/`、注册到 Claude Code，
并安装 `commands/`（`/seeway-link` 等斜杠命令）与 `rules/code-context-policy.md`（触发策略）。

## 开发

```bash
pnpm install
pnpm build                        # 全量构建
pnpm test                         # = pnpm --filter @seeway/claude-context-graph test
pnpm typecheck
cd packages/mcp && pnpm dev       # 本地启动 MCP
```

包结构（pnpm monorepo）：

| 包 | 职责 |
|----|------|
| `packages/core` | 向量索引引擎 + Milvus 客户端 + embedding provider |
| `packages/graph` | 知识图谱引擎（tree-sitter 提取、SQLite/FTS5、跨文件解析、遍历） |
| `packages/mcp` | MCP 服务（对外入口，工具注册与 handler） |
| `packages/git-index-service` | 服务端定时索引（云端，不在开发者机器跑） |

依赖方向：`mcp → core + graph`；`core`、`graph` 各自独立。

## 部署

- 本地 MCP：`node packages/mcp/dist/index.js`
- 云端基础设施与容器编排：见 [DEPLOY.md](DEPLOY.md)
- 检索质量历次实测：见 [SEARCH-EVALUATION.md](SEARCH-EVALUATION.md)

## 许可

见 [LICENSE](LICENSE)。
