# search 功能评估报告（重构后实测，含多语言深化轮）

> 评估对象：claude-context 重构版（云端向量只读检索 + 本地图索引 + link 模式）
> 评估方法：①真实仓库 pipeline @ main 端到端实测 ②GitHub 8 仓库多语言评估数据集（96 题，flask/requests/gin/cobra/gson/json/bat/trpc）调用图精度批量评估
> ③公司真实 C++ 仓库（ap-client-api / PhiLog）离线图召回 + 端到端实测（2026-07-30 轮，见下）。
> 复现脚本：[benchmarks/](benchmarks/README.md)。

---

## 📌 最新一轮（2026-07-30）：公司真实 C++ 仓库，图召回 58%→79% / 76%→88%

**测试床**：ap-client-api（AUTOSAR AP 客户端，8,700 节点 / 8,793 边）+ PhiLog（C++ 日志库）。
两个仓库都是**测试数据里的真实仓库**，期望符号全部查图 DB 逐一确认存在（不凭想象写期望）。
场景与期望：`benchmarks/scenarios/*.json`。

### 离线图召回（`benchmarks/graphbench.mjs`，不碰 Milvus）

| 仓库 | 优化前 | 优化后 | 延迟 |
|------|--------|--------|------|
| ap-client-api | 58% (11/19) | **79% (15/19)** | 3–16ms |
| PhiLog | 76% (13/17) | **88% (15/17)** | 2–8ms |
| 合计 | 67% (24/36) | **83% (30/36)** | — |

### 六项改动与各自的证据

| 改动 | 修的是什么 | 证据 |
|------|-----------|------|
| **查询词去重**（`meaningfulQueryTokens`） | 每个词是一条 OR 臂，重复词被 BM25 数两次；还会抬高 LIKE 层的多数阈值 | "error code and error domain definition" 因 error 出现两次，把 ErrorDomain 顶到 ErrorCode 之上 |
| **bigram 短语臂** | 纯前缀 OR 只数"命中几个词"，对**词序完全无感** | `{name search_text} : "log manager"` 让 LogManager 从落榜到首位 |
| **缩写归一只在短语里展开** | 缩写做独立前缀是灾难 | 给 "execute" 加 `"exec"*` 把整个 `ara::exec` 树扫进来，ap 召回 79%→**68%**、丢了 PushTask/RecoveryAction。改为短语内展开后回到 79% |
| **`module` 计入结果噪声** | C++ `namespace` / Rust `mod` 是容器不是答案，且会匹配自己所在目录名 | ap 的 8,700 节点里 **777 个是 namespace**；`namespace supervised_entity` 抢走了 `class SupervisedEntity` 的头名 |
| **概念多样性**（`diversifyByConcept`，MMR-lite） | 近重复行霸榜造成的边界丢失 | `RecoveryAction` 以 **20.81 vs 20.83** 落到第 11 名，被 10 条 `SupervisedEntity*` 挤出。同短语最多占 `max(3, ceil(limit/3))`，超出**下溢到尾部而非丢弃**（保 `offset` 分页一致） |
| **响应 token 预算**（`snippetBudget`） | 单条上限管不住总量：10 条 × 4000 = 10k 字符 | 最差单次 5922t→**3888t**（−34%），均值 2597t→**2216t**（−15%）。单条下限 600 字符——低于此就不是可读代码了 |

### 端到端实测（真实 Milvus + Ollama，`benchmarks/harness.mjs`，warm）

| 仓库 | both | vector | graph |
|------|------|--------|-------|
| ap-client-api | **94%** / 219ms / 2216t | 81% / 55ms | **100%** / 89ms / 442t |
| PhiLog @ main | **93%** / 128ms / 2123t | 86% / 49ms | 88% / 55ms / 212t |

强制全部场景走 `graph`（含自然语言提问）：ap **84%** @ 412t，PhiLog **88%** @ 212t
—— 这是"graph 模式不必点出符号名"的直接证据，也是工具描述据此重写的依据（commit 5d53316）。

### 两个"看起来是 bug 其实不是"的观测

- **`both` 首轮 934–953ms vs warm 219–223ms**：Milvus 冷 collection load，不是回归。
  harness 现在会先打一次 warmup 查询。
- **PhiLog vector 模式 37 token / 0% 召回**：不是代码问题——`link PhiLog @ ap_debug_0304` 报
  "Cloud index not found"，因为早前清理只保留了 main 分支的 collection。换 `main` 后 vector 召回 86%。

### 已知取舍

`vector` 单模式召回从 88% 降到 81%：`SyncToStorage` 埋在一个很长 chunk 的深处，
捞回它需要 4000 字符片段（`SEARCH_TOTAL_MAX_CHARS=40000`）多花 ~2000 token。
而 `both` / `graph` 本来就能正常给出该符号 —— 不值得为它抬高全局预算。

### 回归护栏

每次改动后：图测试套件 7/7 通过；`graphbench` 双仓库跑一遍；索引产物比对不变
（9146 节点 / 8793 边 / 8850 跨文件 / 9684 remaining，3.4s）。

---

## 📌 最新一轮（2026-07-29）：search vs Read/Grep 受控对照 + 图实时性

> 完整报告见 [docs/search-evaluation-20260729.md](docs/search-evaluation-20260729.md)。

**对照实验**（flask/requests，8 个真实开发场景，search 三种模式 vs 纯 Read/Grep 基线 agent）：

| 发现 | 结论 |
|------|------|
| 小型组织良好库上基线 8/8 全胜 | **search 是"定位第一跳"而非替代品**；工具描述已按"按库规模分档"重写 |
| search 符号命中率 17/18 | 找得到，但富化阶段把关键符号弄丢了（已修） |

**本轮修复（均已端到端验证 + 提交）**：

| 修复 | 修复前 → 修复后 |
|------|----------------|
| 富化丢失关键符号 | requests 查 send/get_adapter 的 Call Graph 全是 cookies.py 噪声 → `Session.send ← request → ...` 真实链路 |
| 文档淹没代码 | requests-flow top10 里 5 条 docs/*.rst → 代码文件升至 top（penalizeDocResults + dedup + diversity） |
| **图索引实时性** | 改完代码 search 看不到新符号 → 工作区变更自动增量重建（`[GRAPH-SYNC]`），修复 3 层叠加 bug |
| 富化噪声 | 多行签名/自指/同名/测试调用者 → 单行签名 + 去重 + 测试隐藏 |

---

## 一、修复的硬伤（全部经端到端验证）

| 问题 | 修复前实测 | 修复后实测 |
|------|-----------|-----------|
| 调用图是模块 import 噪声 | `handleSearchCode → ./utils.js, ./utils.js, ./utils.js`、`Change Impact: num, name, raw` | `utilFn ← doWork ← run` 全真函数调用链，零模块节点 |
| 跨文件调用边丢失 | Phase3 fire-and-forget，进程退出即丢 | Phase3 await，跨文件边落库 |
| 图"增量"是假增量 | `options.files` 无人消费，恒全量重建 | sync 只重索引变更文件，未动文件节点保留 |
| 图身份不一致 | link 建图用链接分支、search 查当前分支，跨分支图全空 | 统一当前工作区分支 identity |
| 旧图无版本识别 | 索引器升级后旧图被误用，符号全错位 | INDEXER_VERSION 版本戳，旧图自动识别重建 |

## 二、多语言调用图修复（深化轮，质变）

| 语言 | 修复前 | 修复后 | 关键改动 |
|------|--------|--------|---------|
| Python | `self.xxx()` 调用完全不解析（`attribute` 未识别） | `dispatch_request ← full_dispatch_request → ensure_sync` 完整双向 | extractMethodCall 支持 `attribute` |
| Go | `e.xxx()` 调用不解析（`selector_expression` 未识别） | `handleHTTPRequest ← ServeHTTP → serveError` | 支持 `selector_expression` |
| Java | `method_invocation` 用 `name` 字段未识别 + 重载全吞 | `getAdapter ← [toJson, fromJson]` 命中 | 支持 `name` 字段 + 重载消歧 + `isLikelyCrossFileReference` 放宽 camelCase |
| 通用 | 同名方法全库被 QN 覆盖吞掉 | QN 冲突按 `file:line` 消歧保留 | graph-buffer upsertNode |
| 通用 | 查 `toJson` 召回 `toString`（FTS 模糊） | 精确名/后缀优先层（score=1000） | findNodes Pass 0 |

**调用图精度（批量评估，10 题跨 Python/Go/Java）**：符号召回 **10/10**，调用边精度 **100%**。实测样例：
- flask `wsgi_app ← __call__ → full_dispatch_request`（完整入口链）
- gin `handleHTTPRequest ← ServeHTTP → serveError`
- requests `Session.send ← request → get_adapter`
- gson `getAdapter ← [toJson, fromJson]`

补充修复：**源文件优先于测试文件排序**（`buildNodeResults` 对 test/spec 路径降权 100 分），解决 requests `send` 命中测试文件的同名歧义。

### 多语言调用解析覆盖（6 语言实测）

| 语言 | 仓库 | 调用形态 | 状态 |
|------|------|---------|------|
| Python | flask/requests | `self.xxx()` (`attribute`) | ✅ 调用图完整 |
| Go | gin/cobra | `e.xxx()` (`selector_expression`) | ✅ 调用图完整 |
| Java | gson | `method_invocation` (`name` 字段) + 重载 | ✅ 调用图完整（重载消歧） |
| TypeScript | trpc | `member_expression` | ✅ 调用图完整（24K 节点大仓库） |
| Rust | bat | `obj.method()` / `Type::method()` | ✅ `Controller::run → run_with_error_handler` |
| C++ | json | `ns::method()` (`qualified_identifier`) | ⚠️ 符号召回正常，模板代码调用边有限（固有边界） |

## 三、search 返回上下文质量实测

### 查询："pipeline build job trigger"（mode=both，云端 pipeline@main）
**返回结构**：`[linked: repo@main]` 头 + 10 条向量命中（含代码片段+分数）+ 5 条图符号（含出入度）。

**噪声画像**（优化前）：
- 总命中 10 条，其中明显噪声 4 条：
  - `#2 README.md:1-1`（单行 `# Pipeline`，零信息）
  - `#5 calibration-api:1-46`、`#6 philog:1-44`、`#9 phicyber:1-46` —— 3 个与 #3 几乎逐字相同的 **credentials 环境块**（跨文件 boilerplate）
- **噪声占比 ≈ 40%**（4/10）。
- 分数断层：#1-6 在 0.018–0.020（密集），#7 起掉到 0.0096 —— 自然质量拐点在 #6/#7 之间。

### 已落地的针对性优化
1. **内容级近重复去重**（`dedupNearDuplicateContent` + 结构骨架前缀签名）：归一化字符串/数字/`${}`/标识符后取前 200 骨架哈希，相同模板块跨文件只保留最高分一条。
2. **文件多样性约束**（`applyFileDiversity`）：单文件最多占 `ceil(topK/4)` 条，防止重复文件霸榜。
3. **调用图去 import 噪声**（graph `callLikeEdges`）：calls 优先、无 calls 回退 references/instantiates、永不取 imports。

> 说明：内容去重对"逐字/近逐字"模板最有效；对"结构相似但chunk切分起点不同导致骨架前缀错位"的块召回有限，这是已知的后续调优点（可做 sliding-window shingle 相似度）。

## 三、与"不装 MCP"的对比

| 维度 | 不装 MCP（grep/read） | 装 MCP（search） |
|------|----------------------|------------------|
| 定位"build job 怎么触发" | grep `build job` 命中上百处，需人工逐个 read 甄别 | 1 次 search 直接给出 trigger stage 的精确行区间 + 调用链 |
| token 消耗 | 通读多个 jenkinsfile（每个 200+ 行）≈ 数千 token | search 返回 10 片段 ≈ 1.3K token，**节省 ~70%** |
| "谁调用它" | grep 无法判断调用关系/死代码 | 图符号直接给出入度，`[unused]`/`[entry]` 标记 |
| 跨文件调用链 | 需人工串联 import 关系 | `←doWork←run` 直接呈现 |
| 精确符号/已知字符串 | grep 即时精确 | search 反而慢 —— **此时应用 grep** |

## 四、search 的优势场景定位（触发时机设计依据）

**优先用 search**（明显优于 grep/read）：
1. 理解陌生代码流程："X 功能怎么实现的"、"请求怎么从入口走到 DB"——一次拿到片段+调用链。
2. 重构前评估影响面：先看 `←调用者` 列表和调用链判断波及范围。**动手改前必做。**
3. Bug 根因定位：search 症状语义 → 顺 `→被调用者` 跨文件追根因。
4. 死代码/入口排查：`↖0`（无调用者）/入口标记直接给出。
5. 找现有模式/约定：加功能前 search 类似实现照着写。

**不要用 search**（grep/read 更优）：
1. 已知精确字符串/符号/路径 → Grep/Read 即时零成本。
2. 非 AST 语言/配置/YAML/锁文件/Markdown 全文 → Grep。
3. 要逐字完整内容（编辑整文件）→ Read 定点区间。
4. 枚举文件/按名找 → glob。

## 五、结论

重构后 search 的核心价值（**定位在哪 + 谁在用 + 调用链**，而非原始代码）已稳固，修复的 4 个硬伤让"调用图"从噪声源变成真正可用的结构化上下文。噪声主要来自**跨文件 boilerplate 复制品**，已通过内容去重+多样性约束治理（在 boilerplate 密集仓库收益最大）。剩余精度空间在 chunk 切分与骨架对齐，属增量优化而非缺陷。

**最佳使用模式**：search 做"语义定位 + 结构导航"的第一跳，Read 做"定点精读"的第二跳——混合使用，不是替代 grep/read。工具描述与触发策略据此设计。
