# search 功能评估报告（重构后实测，含多语言深化轮）

> 评估对象：claude-context 重构版（云端向量只读检索 + 本地图索引 + link 模式）
> 评估方法：①真实仓库 pipeline @ main 端到端实测 ②GitHub 8 仓库多语言评估数据集（96 题，flask/requests/gin/cobra/gson/json/bat/trpc）调用图精度批量评估。

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
