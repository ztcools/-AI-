# 基准与容量测量

前两个是**检索质量**回归工具（改排序时跑），后两个是**容量/资源**测量工具（定部署参数时跑）。
CLAUDE.md「搜索质量基准」、SEARCH-EVALUATION.md、以及 local-stack 的 `.env.example`／README
里的数字都出自这里。

## graphbench.mjs — 离线图召回（秒级）

不碰 Milvus、不需要 link、不联网。直接打 `SqliteGraphStore.findNodes`，
按 graph 模式同样的方式给命中列表打分。**改 `buildFtsQuery` / `diversifyByConcept` 时用这个循环。**

```bash
pnpm build:graph
node benchmarks/graphbench.mjs <repoPath> benchmarks/scenarios/ap-client-api.graph.json
DUMP=1 node benchmarks/graphbench.mjs <repoPath> benchmarks/scenarios/philog.graph.json   # 打印排名细节
```

前提：目标仓库已有图（`<repo>/.context/graph/knowledge-graph.db`），即先对它 `link` 过一次。
`DUMP=1` 会逐条打印 `kind / name / file:line / score` —— 定位"为什么第 11 名"这类边界问题靠它。

## harness.mjs — 端到端实测（需要真实基础设施）

跑**真实 MCP handler**（不是重实现），所以量到的就是 agent 实际拿到的东西：
link → 等后台图建完 → 每个场景跑各模式 → 报延迟 + 落进上下文的响应大小。

```bash
pnpm build
node benchmarks/harness.mjs <repoPath> main benchmarks/scenarios/ap-client-api.json
```

前提：`~/.context/.env` 里的 Milvus + Ollama 可达，且 `<repo>@<branch>` 在云端**已被索引**
（分支没索引则 vector 模式全空 —— 那不是代码 bug）。

harness 会先等图就绪、再打一次 warmup 查询：collection 被 release 后首查要付 Milvus load
（~900ms vs warm ~220ms），不预热量出来的是冷启动而不是稳态。

## embed-throughput.mjs — 定 `GIT_INDEX_CONCURRENCY`

`GIT_INDEX_CONCURRENCY` 该由 embedding 服务的吞吐决定，**不是由核数决定** ——
索引侧每个仓库是一条串行的 embed 流，所以"N 条并发流的总吞吐"就是把并发调到 N 的收益上限。

```bash
OLLAMA_HOST=http://10.50.4.149:11435 node benchmarks/embed-throughput.mjs
LEVELS=1,2,4,8,16 SECONDS=20 node benchmarks/embed-throughput.mjs   # 自定义档位
```

逐档加压，吞吐相比上一档提升不足 10% 就判为饱和并给出建议值。实测本栈
（ollama 32g / 16cpu、4 卡共享）：1/3/6/8/12 流 → 27/75/136/140/142 embed/s，
**饱和点 6**；12 流时单流延迟从 44ms 涨到 84ms 而吞吐只多 4%。

> 只读操作（纯 embedding API 调用），但会给 embedding 服务施加满载压力约
> `档位数 × SECONDS` 秒。共享机器上别在别人的高峰期跑。

## worker-mem.mjs — 定 `GIT_INDEX_MEM_LIMIT`

复现单个索引 worker 的内存主导项（文件列表 + AST 切分 + `EMBEDDING_BATCH_SIZE` 缓冲），
不连 Milvus / Ollama。git-index 的 worker 跑在**同一个 Node 进程**里
（[indexer.ts:273](../packages/git-index-service/src/indexer.ts#L273) 是 `Promise.all`），
所以要分清两种上限：V8 old-space 与容器 cgroup。

```bash
pnpm build
node benchmarks/worker-mem.mjs /path/to/repo 2>&1 | grep -v '^🌳' | tail -10
```

实测 ap-client-api（28.7K chunks）：峰值 RSS ~1 GiB，其中 **956 MiB 在堆外**
（tree-sitter 原生 buffer），V8 `heapUsed` 峰值只有 55 MiB。结论是约束为 cgroup 上限
而非 old-space（4.1 GiB），**不需要设 `NODE_OPTIONS`**；并发 6 最坏约 6 GiB。

## 场景文件

| 文件 | 用途 |
|------|------|
| `scenarios/ap-client-api.json` | ap-client-api（8.7K 节点 C++），both/vector/graph 混合 |
| `scenarios/philog.json` | PhiLog（C++ 日志库），both/vector/graph 混合 |
| `scenarios/*.graph.json` | 同样的问题全部强制 `graph` 模式 —— 用于 graphbench |

格式：

```json
{
  "name": "场景名",
  "query": "自然语言提问",
  "modes": ["both", "vector", "graph"],
  "expect": ["期望出现的符号名", "或文件名片段"]
}
```

`expect` 是**子串**匹配整个渲染后的响应文本，所以既能写符号名也能写文件名。
`expect: []` 的场景只测延迟/token，不计入召回。

> 期望值必须来自真实仓库（查图 DB 或读代码确认符号确实存在）。凭想象写期望，
> 量出来的就是想象的召回率。
