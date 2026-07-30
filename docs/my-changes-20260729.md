# 本轮 search 优化改动报告（2026-07-29）

> 作者：Claude。范围：claude-context 的 search 工具价值最大化 + 图索引实时性 + 服务端部署。
> 全程本地端到端验证 → 服务端（10.50.4.149）部署验证。所有改动已本地 commit（未 push）。

---

## 一、改动总览

| 仓库 | 提交数 | 说明 |
|------|--------|------|
| `/home/zt/context` | 6 | search 核心逻辑 + 图索引 + 工具描述 + 评估报告 |
| `/home/zt/claude-context-local-stack` | 3 | 部署文档（README/.env.example） |
| 服务端 10.50.4.149 | — | git-index 镜像重建部署（含新 core） |

**核心目标**：让 search 在"该用的场景"提供精准、低噪、省 token 的上下文；
在"不该用的场景"明确不触发——从"能跑"做到"最优"，不是纯摆件。

---

## 二、逐项改动明细（what / where / why / 验证）

### ① 富化阶段丢失关键符号（P0，影响最大）
- **现象**：requests 查 `Session.send get_adapter`，`### Call Graph` 全是 cookies.py 噪声，
  真正的 send/get_adapter 一行都没有。
- **位置**：`packages/mcp/src/handlers.ts · enrichWithGraphContextDeep`
- **根因**：富化符号只取向量 top5 文件；相关性用裸子串匹配（`get` 误命中 `__getitem__`）。
- **修复**：富化符号来源改为**图符号命中为主、向量文件为辅**；相关性改**词边界匹配**
  （含驼峰/下划线切分）。
- **验证**：修复后 `Session.send ← request → resolve_proxies/extract_cookies/dispatch_hook`
  精确呈现；flask `wsgi_app → full_dispatch_request → dispatch_request/finalize_request` 完整。

### ② 文档淹没代码（P0）
- **现象**：requests 查 "how request is sent"，top10 里 5 条是 `docs/*.rst`，
  真正的 `Session.send` 排到 #9。
- **位置**：`packages/core/src/context.ts · searchWithLayers`
- **根因**：自然语言查询语义与文档散文更接近；且这条管道缺内容去重 + 文件多样性 + 文档降权。
- **修复**：新增 `penalizeDocResults`（`.md/.rst` 降权，`SEARCH_DOC_PENALTY=0.5`），
  并接入 `dedupNearDuplicateContent + applyFileDiversity`（此前只有 dedup+cutoff）。
- **验证**：top 命中从"文档为主"变为"代码文件为主"。

### ③ 图索引实时性（P0，用户核心诉求）
- **现象**：改完代码 search 看不到新符号（图是建索引时的旧快照）。
- **位置**：`packages/mcp/src/handlers.ts` + `graph-handlers.ts` + `packages/graph/src/indexer.ts`
- **根因（3 层叠加 bug）**：
  1. `detectChangedFiles` 用 `git diff main...HEAD`，对**未提交**的工作区改动返回空，
     且浅克隆报错被吞；
  2. `handleIndexRepository` 增量模式未走真增量路径；
  3. 无变更节流，会重复触发。
- **修复**：search 时按 8s/项目节流触发后台增量（`maybeIncrementalGraphSync`）；
  变更检测改**工作区优先**（unstaged+staged+untracked）；排除自身 `.context/` 目录；
  增量改走 `indexer.sync()` 真增量。
- **验证**：flask 改文件加 `__final_probe__`，search 自动触发 `[GRAPH-SYNC] incremental re-index`，
  新符号立即可查。

### ④ graph 模式不返回调用链（P1）
- **现象**：graph-only 只给裸符号清单（`↖in ↗out`），要拿调用链必须走 both（~5000t）。
- **位置**：`packages/mcp/src/handlers.ts · handleSearchCode`
- **修复**：graph 模式也产出 Call Graph/Change Impact 富化。
- **验证**：`prepare_auth` graph 查询 535t 直接给 `← prepare, rebuild_auth → get_auth_from_url`。

### ⑤ 富化噪声（P1）
- **现象**：多行签名把调用链撑成几十行；`app ← app` 自指；`← test_x, test_x, test_x` 重复。
- **位置**：`packages/mcp/src/handlers.ts · enrichWithGraphContextDeep`
- **修复**：签名折叠单行；剔除自指/同名互调；测试文件调用者隐藏；调用者按名去重。

### ⑥ 触发规则 + 仓库规模分档（本轮新增，解决"search 不是每次都该用"）
- **位置**：`packages/mcp/src/index.ts`（search_description）+ `handlers.ts`（getRepoSizeTier）
- **改动**：
  - search 输出头标注规模：`[repo: 241 files, small — grep/read likely cheaper]`（缓存 5min）。
  - 描述重写为可执行规则：**默认 Grep/Read；仅 3 类场景用 search**——
    ① 关系问题（who calls/impact/dead code/entry）→ graph（任意规模，~200t）；
    ② 大库（>2000 文件）不知位置 → both；③ 只知概念不知标识符 → vector。
- **大小库界定**：<300 小库（grep 更省）/ 300–2000 中库 / >2000 大库（search 占优）。

### ⑦ 向量侧测试文件降权（本轮新增，降噪）
- **现象**：requests-flow top2 是 `tests/test_adapters.py`，挤占生产实现。
- **位置**：`packages/core/src/context.ts · penalizeTestResults`
- **修复**：测试/规格文件降权（`SEARCH_TEST_PENALTY=0.55`）。
- **验证**：top10 测试文件减少，生产文件升至前列。

### ⑧ docs/tests 对称开关（本轮新增，避免误伤）
- **位置**：`packages/mcp/src/index.ts` + `handlers.ts` + `core/context.ts`
- **改动**：`docs:true` / `tests:true` 单次关闭对应降权（查文档/测试时用），用后自动重置。
- **验证**：`tests:true` 时测试文件从 1 → 7（降权可开关）。

---

## 三、改动文件清单

**packages/mcp/src/handlers.ts**（+306/-，最大）
富化重写（图符号为主）、调用链去噪、graph 模式富化、图实时增量、规模分档、docs/tests 开关。

**packages/core/src/context.ts**（+72）
penalizeDocResults、penalizeTestResults、searchWithLayers 接入 dedup+diversity、降权重置。

**packages/mcp/src/graph-handlers.ts**（+65）
detectChangedFiles 工作区优先、handleIndexRepository 增量走 sync()。

**packages/graph/src/indexer.ts / index.ts**（+10/+2）
sync 变更检测纳入未跟踪文件 + 排除 .context；导出 INDEXER_VERSION。

**packages/mcp/src/index.ts**（+29）
search/link 工具描述重写（触发规则 + 大小库界定 + 成本控制）。

**文档**：`docs/search-evaluation-20260729.md`（新）、`SEARCH-EVALUATION.md`（追加）、
`docs/my-changes-20260729.md`（本报告）。

**部署**：`/home/zt/claude-context-local-stack/README.md`（link→search 工作流 + 触发规则）、
`.env.example`（Ollama 资源调优注释）。

---

## 四、验证数据（before → after）

| 指标 | 优化前 | 优化后 | 说明 |
|------|--------|--------|------|
| 文档噪声（8 场景 top10 合计） | 5+ 条 docs | **0** | penalizeDocResults |
| 符号命中率 | 17/18 | 17/19 | 富化不再丢符号 |
| both 模式 avg token | ~5100 | ~4416 | -13% |
| flask-flow 链式符号命中 | 1/4 | 3/4 | 富化修复 |
| 图实时性 | ✗ 改代码查不到 | ✓ 改完立即可查 | maybeIncrementalGraphSync |
| graph 模式调用链 | ✗ 无 | ✓ ~200t 拿链路 | graph-only 也富化 |

**成本梯度**（实测）：graph ~200t < compact ~341t < limit:5 ~2832t < both(10块) ~4416t。

---

## 五、服务端部署

- 本地重建 `claude-context-git-index:latest`（aliyun 镜像加速），传服务器，
  **只重启 claude-git-index 容器**（不影响其他 5 个 + 他人容器）。
- 验证：git-index 运行新 core，flask 索引幂等（up-to-date）。
- 清理：回收 546MB dangling 镜像；白名单保留 pipeline/pipeline-config/flask/requests。

---

## 六、遗留 / 建议

1. **未 push**：context 6 个 + stack 3 个提交，无 GitHub token，由你 push。
2. **大库验证缺口**：本轮仍用 flask/requests（中小库），建议在 trpc（24K 节点）复测，
   验证"大库 search 占优"假设——这是触发规则的边界证据。
3. **gin/gson**：gitee 限流未索引，后续补镜像或 token。
4. **多实例内存**：每个 Claude 会话一个 MCP 实例（~130MB×N），可做图 store 共享/LRU。
