# search 功能评估报告（2026-07-29 实测）

> 评估对象：claude-context 重构版（云端向量只读 + 本地图索引 + link 模式）
> 评估方法：① 直连 MCP（stdio→HTTP 桥）对 flask / requests 实测 link/search 三种模式
>           ② 与「不装 MCP」的 Read/Grep 基线 agent 做受控对照（8 个真实开发场景）
> 测试仓库：flask@main（Python，2360 节点/5868 边）、requests@main（Python，981 节点/2130 边）

---

## 一、核心结论（先说定位）

**search 是一个「定位 + 结构导航」的第一跳工具，不是 Read/Grep 的替代品。**
它的价值高度依赖**代码库规模与熟悉度**，本次在**小型、组织良好**的 Python 库上，
基线（Read/Grep）在**全部 8 个场景**里都以**更少 token、更高答案质量**胜出。

| 场景类别 | search 命中 | search token | 基线 token | 基线调用 | 谁赢 |
|---------|------------|-------------|-----------|---------|------|
| flow（wsgi_app / Session.send） | 5/8 符号 | 6491 | ~4500 | 8 | **基线**（答案更完整） |
| impact（open_session / prepare_auth） | 3/4 符号 | 3525 | ~1350 | 2 | **基线**（大幅领先） |
| bug（ctx push/pop / redirects） | 5/5 符号 | 5888 | ~2100 | 2.5 | **基线** |
| exact / pattern | 2/2 符号 | 4685 | ~1050 | 2 | **基线**（大幅领先） |
| **合计/平均** | **17/18** | **~5100** | **~2250** | **~3.6** | 基线全胜 |

> 注：search 符号命中率其实很高（17/18），**它不是找不到，而是"返回的上下文太贵、
> 且在富化阶段把关键符号弄丢了"**（见三.2）。基线胜在"小库 grep 一次就到、答案还更连贯"。

**search 真正有优势的场景（本评估未充分覆盖、但逻辑+既往数据支持）：**
1. **大型/陌生代码库**（成千上万文件）：grep 返回上千命中需人工逐个 read，search 一次定位。
2. **"关系/结构"问题**：谁调用它、调用链、改动影响面、死代码、入口 —— grep 无法直接回答，
   图索引的 `↖in ↗out`、`[unused]`、`[entry]` 标记是**唯一**能答的。
3. **不知道确切关键词**：只记得功能不记得名字时，语义向量比 grep 的关键词匹配容错高。

> ⚠️ 本次 eval 用的是 flask/requests（中小型、命名规范、目录清晰），恰恰是 grep 最舒服的
> 场景。**这是本评估的主要局限** —— 在 Lune 这类业务全栈项目或 trpc（24K 节点）大库上，
> 天平会明显倒向 search。**结论应按"代码库规模"分档使用，而非全局定论。**

---

## 二、成本画像（token 分解）

三种模式的 token 消耗（8 场景平均）：

| mode | 平均 token | 构成 | 用途 |
|------|-----------|------|------|
| `graph` | **~105** | 仅符号清单 | 极省，快速探活 |
| `vector` | ~4985 | 10 个完整代码块 | 看实现 |
| `both` | ~5100 | vector + ~400 富化 | 看实现 + 调用链 |

- 富化（Call Graph + Change Impact + Architecture）只比 vector 多 ~400t，**很便宜**。
- token 大头在 **10 个完整代码块**（每个 ~500t）。`style:"compact"` 可降到 ~1/10。
- graph 模式 token 极低，但**不含调用链**（见三.2），当前只能当"符号存在性探测"用。

---

## 三、发现的缺陷与噪声（按修复优先级排序）

### P0 — 富化阶段丢失关键符号（直接影响"impact/flow"场景的有效性）
**现象**：requests 查 `Session.send get_adapter` 时，图符号**正确**找到
`send`(↖2↗8)、`get_adapter`(↖12↗2)，但 `### Call Graph` 里**全是 cookies.py 的噪声**
（`__getitem__ → _find_no_duplicates`、`MockRequest impacts ...`），**send/get_adapter 一行都没有**。

**根因**（`handlers.ts enrichWithGraphContextDeep`）：
1. 富化只对**向量 top5 命中的文件**取符号，而向量 top5 混入了 `docs/*.rst`、`cookies.py`，
   真正含 `send` 的 `sessions.py` 没进 seenFiles 或排在后面。
2. 相关性用**子串匹配** `queryWords.some(w => name.includes(w))`：查询词 "Session.send
   get_adapter prepare_request" 拆成 `session/send/get/adapter/prepare/request`，
   `__getitem__` 因含 `get` 被误判相关，而真正的 `send` 节点可能因文件未入选被跳过。

**修复方向**：富化的符号来源应**以图符号（findNodes 命中）为主**、向量命中文件为辅；
相关性匹配改为**词边界/驼峰切分**而非裸子串。

### P0 — 自然语言查询时文档淹没代码（requests-flow-send 实测）
**现象**：查 "Trace how an HTTP request is sent..."，top10 里 **5 条是 docs/*.rst**
（advanced.rst、api.rst、index.rst、install.rst），真正的 `Session.send` 排到 #9。

**根因**：自然语言 prompt 的语义与文档散文比与代码更相似（embedding 固有特性）。
且 `searchWithLayers` 管道**只有** `deduplicateResults + applyScoreCutoff`，
**缺** `searchCodebase` 里的 `dedupNearDuplicateContent + applyFileDiversity + 文档降权`。

**修复方向**：① 给 `searchWithLayers` 补齐 content-dedup + file-diversity（函数已存在，
只是没接进这条管道）；② 对 `.md/.rst/.txt` 等文档类文件**降权**（如 score×0.5）或
默认排除、提供 `includeDocs:true` 开关。

### P1 — graph-only 模式不返回调用链
图-only 时只输出符号清单（`↖in ↗out`），**没有 `### Call Graph` 富化**。
而图查询恰恰是最该给调用链的（impact 场景）。当前要拿调用链必须走 both（付 5000t）。
**修复方向**：graph 模式也应产出 callers/callees 链（数据就在图里，成本极低）。

### P1 — 测试文件噪声未有效降权
`test_request_dispatching`、`test_wsgi_errors_stream`、`MockRequest` 频繁出现在图符号
和富化里。虽然 `buildNodeResults` 声称对 test/spec 降权 100 分，但富化阶段没生效。
**修复方向**：富化和图符号排序统一对 `tests/`、`test_*.py`、`*_test.go` 降权。

### P2 — 富化 Call Graph 混入了 `self` 调用与同名混淆
`app ← app → app, app, route`（tests/test_logging.py）这类自指/同名行是噪声。

### P2 — 未 link 时 search 直接拒绝，无法离线评估图引擎
`maybeAutoBuildGraphIndex` 被 `if (link)` 门控，纯本地项目（无云端 collection）时
search 返回 "not linked... run link first"。**图引擎本可离线工作**，这个耦合让
本地评估/演示变难。修复方向：图构建与 link 解耦，未 link 时至少允许 graph-only。

---

## 四、search 工具描述 / 触发策略评估

当前 `search_description` 写得**已经不错**（明确 3 模式 + 何时不用），但基于实测有两处可强化：

1. **"exact string/symbol already known → 用 Grep"** 这条，实测在**小库**里应扩展为
   "**小型/熟悉的代码库一律先 Grep**"。建议把"代码库规模"写进判定：
   - 文件 < ~1000 且结构清晰 → 先 Grep/Read，search 仅作补充；
   - 大库/陌生库/跨服务 → 先 search 定位。
2. 描述宣称 "~70% fewer tokens than reading files blindly" —— 本次小库实测**不成立**
   （search 5100t vs 基线 2250t）。建议改为强调**"大库/关系问题"**场景，避免过度承诺。

---

## 五、客户端资源占用（用户侧内存分析）

| 项 | 实测 | 说明 |
|----|------|------|
| MCP server RSS | **~130 MB / 实例** | Node + tree-sitter + 图缓存 |
| MCP server 实例数 | **每个 Claude 会话 1 个**（观察到 5+ 常驻） | **多开项目时叠加**，主内存消耗点 |
| 图索引 DB | 1.6 MB（cobra）~ 69 MB（gson）/ repo | SQLite，存于 `<repo>/.context/graph/` |
| 查询 embedding | **0 本地资源** | 走云端 Ollama HTTP，符合"本地零向量负担" |
| graph 建索引耗时 | flask 3.6s / requests 1.6s / gson 30s | 一次性，增量秒级 |

**结论**：单实例 ~130MB 可接受；**多会话多实例叠加**是隐患。建议：
- 图缓存设上限/LRU；或同主机多会话共享一个图 store 进程（架构改动，成本较高）。
- embedding 走云端的方案**值得保留**（本地零 GPU/CPU 开销，响应 ~120-430ms 可接受）。

---

## 六、搜索延迟（实测）

| mode | 平均延迟 | 说明 |
|------|---------|------|
| graph | 124 ms | 纯本地 SQLite，最快 |
| vector | 125 ms | 云端 Ollama embed + Milvus，已很快 |
| both | 337 ms | 向量 + 图并行 + 富化，仍亚秒 |

延迟不是瓶颈，**token 成本与上下文质量**才是。

---

## 七、优化清单（落地优先级）

| 优先级 | 项 | 文件 | 预期收益 |
|--------|----|------|---------|
| P0 | 富化符号来源改为"图符号为主"，相关性改词边界匹配 | `mcp/src/handlers.ts` | impact/flow 场景从"无效"变"有效" |
| P0 | searchWithLayers 接入 content-dedup + file-diversity + 文档降权 | `core/src/context.ts` | 文档噪声 ↓，代码召回 ↑ |
| P1 | graph 模式也输出 Call Graph 链 | `mcp/src/handlers.ts` | graph 从"探测"变"可用"，省 token |
| P1 | 图符号/富化统一降权测试文件 | `graph/src/graph-store.ts` 等 | 噪声 ↓ |
| P2 | 图构建与 link 解耦，支持纯本地 graph-only | `mcp/src/handlers.ts` | 离线评估/演示可用 |
| P2 | search 描述补"按库规模分档"，修正 token 承诺 | `mcp/src/index.ts` | 触发更准 |
| P2 | 富化自指/同名调用去噪 | `mcp/src/handlers.ts` | 噪声 ↓ |
| 观察 | MCP 多实例内存共享/LRU | 架构级 | 多开项目内存 ↓ |

---

## 八、本次评估的局限（诚实声明）

1. **只用了 2 个中小型 Python 库**（flask/requests），未覆盖大库（trpc 24K 节点）、
   业务全栈项目（Lune）、多语言（Go/Java）。**"基线全胜"的结论不能外推到大库。**
2. 基线 token 是 agent 自报估算（~2250t），非精确计量。
3. gin/gson/trpc/cobra 因 Gitee 镜像限流未完成云端向量索引，仅 flask/requests 走通全链路。
4. search 命中判定用"符号名是否出现在返回文本"的启发式，可能高估（符号出现≠上下文有用）。

**后续建议**：在 1 个大库（trpc）+ 1 个业务项目（Lune）上复测，验证"大库 search 占优"的假设，
并接入精确 token 计量（tiktoken）。
