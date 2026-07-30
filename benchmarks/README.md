# 检索质量基准

调检索排序时的两个回归工具。CLAUDE.md「搜索质量基准」和 SEARCH-EVALUATION.md 的数字都出自这里。

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
