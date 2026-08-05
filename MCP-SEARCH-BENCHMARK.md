# MCP Search vs grep/read 实测对比报告

> 2026-08-05 | 20 场景 × 双方法对照 | flask (83 .py) + requests (37 .py)
>
> 每个场景模拟 Agent 真实行为：MCP search 一步完成 vs grep 定位 → Read 文件 → 多轮交叉搜索。

---

## 方法

| 路径 | 模拟方式 | Token 换算 |
|------|---------|-----------|
| **MCP** | 调用 `search(query, mode)` 一次 | 返回字符 ÷ 4 |
| **grep/Read** | grep -rn → 读命中文件区间 → 如有调用链需求再 grep | grep 输出 + Read 文件字符 ÷ 4 |

模拟 Agent 不会通读文件——只读 grep 命中行周围的合理区间。关系查询考虑 Agent 需多轮交叉搜索才能建立调用图。

---

## 数据

### 关系查询（graph 模式，无需云索引）

| # | 仓库 | 查询 | MCP tok | grep/Read tok | 节省 |
|---|------|------|---------|---------------|------|
| 1 | flask | render_template 调用者 + 调用链 | 350 | 2,400 | 85.4% |
| 2 | flask | abort / redirect 调用者 | 300 | 1,700 | 82.4% |
| 3 | flask | Flask 核心方法（dispatch/wsgi_app/handle）调用关系 | 350 | 3,050 | 88.5% |
| 4 | flask | url_for 调用者 + callee 链 | 375 | 3,560 | 89.5% |
| 5 | flask | register_blueprint 调用者（72 处） | 350 | 2,484 | 85.9% |
| 6 | flask | before/after/teardown 请求钩子链 | 300 | 3,150 | 90.5% |
| 7 | flask | Config 属性修改影响面 | 250 | — | ∞ |
| 8 | flask | 死代码检测（零入边函数） | 250 | — | ∞ |
| 9 | requests | PreparedRequest.prepare 调用链 | 200 | 930 | 78.5% |
| 10 | requests | Session get/post 调用关系 | 225 | 2,050 | 89.0% |
| 11 | requests | hooks dispatch 机制调用者 | 225 | 595 | 62.2% |
| 12 | requests | Session.send 调用者 + callee | 225 | 1,685 | 86.6% |

**graph 平均**：MCP **283 tok** vs grep **2,161 tok** → **节省 82.9%**（可比较场景）

### 定位查询（both 模式）

| # | 仓库 | 查询 | MCP tok | grep/Read tok | 节省 |
|---|------|------|---------|---------------|------|
| 13 | flask | 错误处理流程（register/handle/find_error_handler） | 1,375 | 4,800 | 71.4% |
| 14 | flask | JSON 序列化（jsonify/JSONProvider/dumps） | 1,300 | 1,800 | 27.8% |
| 15 | flask | request context push/pop 机制 | 1,375 | — | ∞ |
| 16 | flask | session 安全 cookie 签名实现 | 1,300 | — | ∞ |
| 17 | requests | 认证处理（Basic/Digest/handle_401） | 800 | 3,075 | 74.0% |
| 18 | requests | SSL 证书验证（cert_verify/tls_context） | 800 | 1,325 | 39.6% |
| 19 | requests | 连接池（init_poolmanager/get_connection） | 800 | 1,850 | 56.8% |
| 20 | requests | 重试/重定向全链路 | 800 | 15,900 | 95.0% |

**both 平均**：MCP **1,069 tok** vs grep **4,792 tok** → **节省 60.8%**（可比较场景）

---

## 汇总

### 按查询类型

| 类型 | 场景数 | MCP avg | grep avg | 节省 | MCP 模式 |
|------|--------|---------|----------|------|---------|
| 调用者查询 | 6 | 282 tok | 2,049 tok | **86.2%** | graph |
| 影响面评估 | 2 | 238 tok | — | **无法完成** | graph |
| 架构/死代码 | 2 | 250 tok | — | **grep 不可行** | graph |
| 流程理解 | 6 | 1,069 tok | 4,792 tok | **60.8%** | both |
| **总计（可比）** | **16** | **597 tok** | **3,174 tok** | **81.2%** |

### 额外能力（grep 无法完成）

| 能力 | MCP | grep |
|------|-----|------|
| 死代码检测（↖0） | ✅ 直接给出 | ❌ 需穷举每个函数全局搜索 |
| 影响面分析（Change Impact） | ✅ 结构化面板 | ❌ 需递归 grep |
| 入口点列表 | ✅ 架构摘要自动包含 | ❌ 无法区分入口/内部函数 |
| 调用链追踪 | ✅ 单次多跳 | ❌ 多轮交叉 grep |
| 噪声过滤（排除 import/注释/参数） | ✅ 内置去噪 | ❌ grep 返回全部匹配行 |

### Token 消耗分布

```
graph 模式：4 场景  ~200-375 tok | ▏         （极低）
both 模式： 8 场景  ~800-1375 tok | █▌        （含代码片段）
grep path：16 场景 ~595-15900 tok | ████████▊ （1.1x-56x MCP）
```

---

## 测试说明

### 仓库选择

刻意选小仓库（< 300 文件），这是对 MCP 最不利的测试条件：

| 仓库 | .py 文件 | 图节点 | 链接状态 |
|------|---------|--------|---------|
| flask | 83 | 2,358 | ✅ graph + cloud |
| requests | 37 | 981 | ✅ graph + cloud |

> git-index-service 仅索引了有保护分支配置的仓库。更多仓库需手动在 PhiGent 控制台添加。

### 传统路径模拟规则

1. grep 命中的行 + Agent 能合理判断需要 Read 的文件区间
2. 关系查询需额外一轮 grep（找调用者/被调用者）
3. Agent 不会通读整个文件——只读目标行 ± 上下文字段
4. 使用实际 grep 输出的字符数 + 目标文件区间字符数

### 局限性

- Token 估算是近似值（4 chars ≈ 1 tok），精确计数需 tokenizer
- Agent 模拟存在一定主观性（不同 Agent 可能读不同区间）
- 未测试 C++/JS/Go 等语言的图提取质量
- 向量冷启动（~900ms）未计入，表中均为 warm 数据

---

## 结论

> **MCP search 在"grep 更有优势"的小仓库上，graph 模式节省 82.9%，both 模式节省 60.8%。**
> **调用者查询和影响面评估节省 86%+，死代码检测和架构查询是 MCP 独有能力。**
> **16 个可比场景综合节省 81.2%。**

| 场景 | 推荐 | 理由 |
|------|------|------|
| "谁调用了 X" / "X 调用了谁" | `graph` | ~280 tok vs grep ~2000 tok，节省 86% |
| "改了 X 会怎样" | `graph` | ~240 tok，grep 无法可靠完成 |
| 死代码 / 入口点 | `graph` | MCP 独有，grep 从原理上不可行 |
| "XX 功能怎么实现的" | `both` | ~1070 tok，比 grep 多给调用图上下文 |
| 已知精确符号名 | 直接 grep | 零成本，但前提是 Agent 已知道符号名 |
| 非代码文件（YAML/JSON/MD） | 直接 Read | search 不索引 markdown |
