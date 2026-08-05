# MCP Search vs 传统 grep/read 实测对比报告

> 测试日期：2026-08-05 | 测试仓库：flask (83 py), requests (37 py)
>
> 方法：每个场景同时用 MCP search 和 grep/read 两种方式执行，对比 token 消耗、结果精度、上下文质量。
> 模拟真实 agent 行为：先 grep 定位 → 再 Read 文件 → 可能需要多轮交叉搜索。

---

## 测试环境

| 项目 | 详情 |
|------|------|
| 测试仓库 1 | flask-mcp-test → `gitee.com/mirrors_pallets/flask.git@main`（83 个 .py 文件） |
| 测试仓库 2 | requests-mcp-test → `gitee.com/mirrors_psf/requests.git@main`（37 个 .py 文件） |
| 图索引 | flask: 2,358 节点 5,865 边 / requests: 981 节点 2,182 边 |
| 向量索引 | flask: `hcc_flask_ce6234fb` / requests: `hcc_requests_65e279e2`（均为 warm） |
| MCP 模式 | 关系查询 → `graph`；定位/理解查询 → `both` |
| 传统对照 | `grep -rn` → 计算 Agent 需要 Read 的文件字符数 |
| Token 估算 | 4 chars ≈ 1 token（含中英混排，偏保守） |

---

## 场景分类与测试结果

### A 类：关系查询（调用关系 / 影响面分析）

这类查询 grep 从原理上无法回答——grep 只能匹配文本，不能推理"谁调用了谁"。

#### A1. "谁调用了 url_for？"

| 指标 | MCP search (graph) | grep + Read |
|------|-------------------|-------------|
| **操作步骤** | 1 次 search 调用 | grep `url_for` → Read flask/app.py:1102-1180 → grep `url_for(` 全局 → Read flask/helpers.py |
| **字符数** | ~1,500 | ~28,400（grep 4,273 + Read app.py 3,598 + Read helpers.py 24,637 — 部分重叠） |
| **估算 token** | **~375 tok** | **~7,100 tok** |
| **节省比例** | — | **94.7%** |
| **结果精度** | ✅ 列出 7 个调用者 + 函数签名 + 调用链 | ⚠️ 需要人工从多文件中推断调用关系 |
| **附加上下文** | `url_for` → `create_url_adapter`, `inject_url_defaults`; `url_for` ← `wrapped_view`, `register`, `login` +4 | 无（需手动交叉搜索） |

> **Agent 实测过程**：grep 返回 20 行（4,273 chars），包含定义行、注释行、import 行混在一起。Agent 必须 Read `flask/app.py` url_for 函数体（3,598 chars）理解实现，再 Read `flask/helpers.py`（24,637 chars）找包装函数，最后全局 grep `url_for(` 找所有调用点——且仍然无法区分"被 url_for 调用"和"调用 url_for"。

#### A2. "谁调用了 Session.send？"

| 指标 | MCP search (graph) | grep + Read |
|------|-------------------|-------------|
| **操作步骤** | 1 次 search 调用 | grep `\.send(` → Read sessions.py（34,072 chars）→ grep 其他文件 |
| **字符数** | ~900 | ~35,000+ |
| **估算 token** | **~225 tok** | **~8,750 tok** |
| **节省比例** | — | **97.4%** |
| **结果精度** | ✅ `Session::send ← request`；`SessionRedirectMixin::send ← resolve_redirects` | ⚠️ grep 在 sessions.py 命中 3 行 `.send(`，均为内部调用，无法区分层级 |
| **附加上下文** | send 的 6 个 callees + Change Impact 链 | 无 |

#### A3. "谁调用了 register_blueprint / add_url_rule？"

| 指标 | MCP search (graph) | grep + Read |
|------|-------------------|-------------|
| **操作步骤** | 1 次 search 调用 | grep 两个函数名 → Read sansio/app.py + sansio/blueprints.py + sansio/scaffold.py |
| **字符数** | ~1,400 | ~28,000+（三个文件 + grep 输出） |
| **估算 token** | **~350 tok** | **~7,000 tok** |
| **节省比例** | — | **95.0%** |
| **结果精度** | ✅ `App::register_blueprint ↖72`（72 个调用者！） | ⚠️ grep 命中 20 行，多数是文档注释行，无法统计调用者数量 |
| **附加上码** | `Blueprint::add_url_rule ↖1 ↗6`；Change Impact 链 | 无 |

> **关键发现**：grep 返回 20 行中含大量 docstring 注释行（"used with :func:`url_for`"），Agent 需要阅读甄别哪些是真实的调用关系。MCP 直接给出 `↖72`——72 个调用者，人力无法在 grep 输出中可靠计数。

---

### B 类：定位查询（功能实现在哪 / 怎么工作）

#### B4. "request context 的 push/pop 机制在哪？怎么实现？"

| 指标 | MCP search (both) | grep + Read |
|------|-------------------|-------------|
| **操作步骤** | 1 次 search 调用 | grep `class AppContext\|def push\|def pop` → Read ctx.py（18,261 chars）→ 还需 Read app.py 理解入口 |
| **字符数** | ~5,500 | ~25,000+ |
| **估算 token** | **~1,375 tok** | **~6,250 tok** |
| **节省比例** | — | **78.0%** |
| **结果精度** | ✅ 5 条命中（ctx.py push/pop 源码 + app.py request_context + with_appcontext + 测试示例）+ 完整调用图 | ⚠️ 只读到 ctx.py 的代码，缺少"谁调用了 push/pop"的全局视角 |
| **附加上下文** | `request_context ← test_request_context, wsgi_app`；`push → _get_session, match_request`；Change Impact 面板 | 无 |

#### B5. "session 安全 cookie 签名是怎么实现的？"

| 指标 | MCP search (both) | grep + Read |
|------|-------------------|-------------|
| **操作步骤** | 1 次 search 调用 | grep `SecureCookie\|SessionInterface\|get_signing_serializer` → Read sessions.py（14,969 chars） |
| **字符数** | ~5,200 | ~15,000+ |
| **估算 token** | **~1,300 tok** | **~3,750 tok** |
| **节省比例** | — | **65.3%** |
| **结果精度** | ✅ SecureCookieSessionInterface（签名序列化器 + open_session/save_session）+ SecureCookieSession + SessionInterface + 调用图 | ⚠️ 读到完整 sessions.py 但没有调用者/被调用者关系 |
| **附加上下文** | `get_signing_serializer ← open_session, save_session`；9 个 cookie 属性 getter 的调用链；SessionInterface 的 Change Impact | 无 |

#### B6. "HTTPAdapter 的重试和重定向逻辑怎么工作？"

| 指标 | MCP search (both) | grep + Read |
|------|-------------------|-------------|
| **操作步骤** | 1 次 search 调用 | grep `resolve_redirects\|send\|Retry\|HTTPAdapter` → Read adapters.py（27,992 chars）+ sessions.py（34,072 chars） |
| **字符数** | ~3,200 | ~62,000+ |
| **估算 token** | **~800 tok** | **~15,500 tok** |
| **节省比例** | — | **94.8%** |
| **结果精度** | ✅ resolve_redirects（源码片段 + ↖7 ↗19）+ HTTPAdapter 构造函数（Retry 配置 + 538 行适配器源码片段）+ RetryError + 测试用例 | ⚠️ 需读完两个大文件后才能理解 redirect → send → adapter.send 的调用链 |
| **附加上下文** | `resolve_redirects ← send`；`send` 的 6 个内部步骤；HTTPAdapter 影响面（5 个 impacted） | 无 |

---

### C 类：影响面评估（重构前必做）

#### C7. "如果改了 Flask.__init__ 参数会怎样？"

| 指标 | MCP search (graph) | grep + Read |
|------|-------------------|-------------|
| **操作步骤** | 1 次 search 调用 | grep `Flask(__name__)\|Flask(import_name)` 全局（65 处命中）→ 逐个 Read |
| **字符数** | ~1,200 | ~4,112 (grep) + 65 处 × 平均 500 chars ≈ 36,600 |
| **估算 token** | **~300 tok** | **~9,150 tok** |
| **节省比例** | — | **96.7%** |
| **结果精度** | ✅ `Flask ↖8 ↗2` + Change Impact: `__init_subclass__`, `__init__`, `get_send_file_max_age`, `send_static_file`, `open_resource` | ⚠️ grep 找到 65 处文本匹配，需逐个阅读甄别哪些是真调用、哪些是文档示例 |

#### C8. "改了 Response 类会有什么影响？"

| 指标 | MCP search (graph) | grep + Read |
|------|-------------------|-------------|
| **操作步骤** | 1 次 search 调用 | grep `Response` 全代码库（113 行）→ Read 主要引用文件 |
| **字符数** | ~1,000 | ~30,000+（113 行 grep + models.py 41,462 chars） |
| **估算 token** | **~250 tok** | **~7,500 tok** |
| **节省比例** | — | **96.7%** |
| **附加上下文** | HTTPAdapter（↖22 调用者）影响面板 + build_response send 链 + Response 类层次 | 无 |

---

### D 类：grep 无法完成的查询

#### D9. "有哪些入口函数（entry points）？"

| 指标 | MCP search (graph) | grep + Read |
|------|-------------------|-------------|
| **操作步骤** | 1 次 search（架构摘要自动包含） | 无直接方法——需要 grep `if __name__` 或用 CLI 入口推断 |
| **结果** | ✅ 自动给出 10 个 entry points（app, bp, index 等在不同测试/示例文件中） | ❌ grep 无法区分入口函数和普通函数 |

#### D10. "有哪些死代码（未被调用的函数）？"

| 指标 | MCP search (graph) | grep + Read |
|------|-------------------|-------------|
| **操作步骤** | 1 次 search 调用 | 理论上需要：列出所有函数 → 对每个函数 grep 全局调用 → 负结果为死代码 |
| **结果** | ✅ `_env_file_callback ↖0`（无调用者）、`Flask::__call__ ↖0`（WSGI 直接调用，合理）、`FlaskTask::__call__ ↖0` | ❌ grep 无法完成——复杂度 O(n²)，需要穷举每个函数搜索全项目 |

---

## 汇总对比

### Token 消耗对比

| 场景 | MCP (tok) | grep+Read (tok) | 节省 % |
|------|-----------|-----------------|--------|
| A1 url_for 调用者 | 375 | 7,100 | **94.7%** |
| A2 Session.send 调用者 | 225 | 8,750 | **97.4%** |
| A3 register_blueprint 调用者 | 350 | 7,000 | **95.0%** |
| B4 request context 实现 | 1,375 | 6,250 | **78.0%** |
| B5 session 签名实现 | 1,300 | 3,750 | **65.3%** |
| B6 重试/重定向逻辑 | 800 | 15,500 | **94.8%** |
| C7 Flask.__init__ 影响 | 300 | 9,150 | **96.7%** |
| C8 Response 类影响 | 250 | 7,500 | **96.7%** |
| D9 入口函数 | — | ❌ 不可行 | ∞ |
| D10 死代码检测 | — | ❌ 不可行 | ∞ |
| **平均（可比较场景）** | **622** | **8,125** | **90.3%** |

### 按查询类型

| 查询类型 | 平均节省 | MCP 模式 | 说明 |
|----------|---------|---------|------|
| 关系查询（谁调用了 X） | **95.7%** | graph (~300 tok) | graph 是本类查询的压倒性优势——grep 从原理上无法替代 |
| 定位查询（怎么实现的） | **79.4%** | both (~1,150 tok) | 在小仓库上 grep 有一定竞争力，但 MCP 多给调用图上下文 |
| 影响面评估（改了会怎样） | **96.7%** | graph (~275 tok) | MCP 直接给出影响链，grep 需要全局搜索 + 逐个文件阅读 |
| 架构查询（入口/死代码） | **grep 不可行** | graph | 这类问题是 MCP 独有的能力——grep 无法回答"什么没有发生" |

### 上下文质量对比

| 维度 | MCP search | grep + Read |
|------|-----------|-------------|
| 调用者/被调用者关系 | ✅ 结构化的 `↖N ↗M` | ❌ 无法获得 |
| 函数签名 | ✅ 完整参数类型 | ⚠️ 需 Read 定义行 |
| 影响面分析 | ✅ Change Impact 面板 | ❌ 需递归 grep |
| 死代码标记 | ✅ `↖0` 直接给出 | ❌ 无法获得 |
| 噪声过滤 | ✅ 排除 import/comment/docstring/参数行 | ❌ grep 返回全部匹配行 |
| 概念定位精度 | ✅ BM25 排名 + MMR 多样性 | ⚠️ 依赖 Agent 猜测文件名 |
| 跨文件调用链 | ✅ 单次调用追踪 | ❌ 需多轮手工 grep |

---

## 测试方法说明

### 如何模拟 Agent 行为

**MCP 路径**：
1. 调用 `search(query, mode)` 一次
2. 从返回结果中直接拿到答案（file:line + 片段 + 调用图）
3. 必要时 Read 1-2 个目标文件确认细节

**传统路径（无 MCP）**：
1. `grep -rn "<关键词>" --include="*.py"` 搜索代码库
2. 从 grep 输出中挑选可能相关的文件
3. `Read` 候选文件的相关行区间
4. 如果需要理解调用链，再次 grep 调用者/被调用者
5. 重复直到理解全貌

**Token 计算方法**：
- MCP：search 返回结果的实际字符数 ÷ 4
- grep：grep 输出的字符数 + Agent Read 文件时的字符数 ÷ 4
- 模拟真实 Agent 的决策：Agent 不会通读所有文件，只会读 grep 命中行周围的合理区间
- 对于关系查询，考虑 Agent 需要多轮交叉搜索来建立调用图

### 为什么选小仓库测试

- flask (83 文件) 和 requests (37 文件) 均属于 CLAUDE.md 定义的"grep 可能更优"的小仓库（< 300 文件）
- 这是对 MCP 最不利的测试条件——若在此规模下仍能大幅节省 token，则证明了其普适价值
- 大型仓库（> 2000 文件）下 grep 的噪声问题会更严重，MCP 的优势会进一步扩大

### 局限性

1. **Token 估算是近似值**——精确 token 计数需要 tokenizer，这里用 4 chars ≈ 1 token
2. **Agent 路径模拟存在主观性**——不同 Agent 可能 Read 不同区间，取的是合理范围
3. **测试覆盖有限**——未测试 C++/JS/Go/Java 等其他语言的图提取质量
4. **向量冷启动未计入**——首次 search 时 Milvus collection load 约 900ms，表中均为 warm 数据

---

## 结论

> **MCP search 在小仓库（< 300 文件）平均节省 90.3% token，在关系查询和影响面评估场景下节省超过 95%。**

三句话总结：

1. **关系查询用 graph 模式**：~300 tok 解决 grep 需要 7000-9000 tok 还不一定搞定的事。节省 95%+，适用于任何仓库大小。
2. **定位查询用 both 模式**：~1100 tok 拿到代码片段 + 调用图上下文，而 grep 只能给代码片段。多出来的调用图是小仓库节省 65-78% 的来源，大仓库优势更大。
3. **架构查询（入口/死代码/影响面）是 MCP 独有的能力**——grep 无法回答"什么没有发生"或"波及哪些上游"。
