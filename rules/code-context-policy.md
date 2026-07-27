# 代码上下文策略 · claude-context (search / index / status)

**适用守卫**：本节仅在当前会话可用 `search` / `index` / `status` / `clear` 这组 MCP 工具时生效。若工具列表中没有它们，**完全忽略本节**。

## search 不是"另一个 grep"

`search` 做两件 grep/read 做不到的事：
1. **语义检索**：按*意图*找代码（稠密向量 + BM25 混合），不知道确切函数名也能命中。
2. **调用图上下文**：每个命中附带 `↖谁调用` / `↗调用谁` + 函数签名 + 文件位置。

**实测：search 平均节省 77% token**（只用 Read 的 23%），覆盖率 83%。

## 三种模式，各司其职

| mode | 何时用 | 示例 |
|------|-------|------|
| `both`（默认） | 探索流程、理解子系统 | "how does auth work" |
| `vector` | 找具体实现、搜概念 | "find the User model" |
| `graph` | 追踪调用关系、影响面 | "who calls sendEmail" |

默认使用 `both`。若只关心"谁调用 X"这类结构问题，切到 `graph` 更快更省 token。

## 优先用 search 的场景
- **理解陌生代码/流程**：search 拿到 file:line + 调用链，替代十几次盲读
- **重构前评估影响面**：search 目标符号 → 看调用者列表 → 判断波及谁。**动手改之前必做**
- **Bug 根因定位**：search 症状/报错 → 顺调用链跨文件追到根因
- **找现有模式/约定**：加功能前 search 类似实现，照着写

## 不要用 search 的场景
- **已知精确文件路径** → 直接 Read 定点区间
- **已知精确符号名** → grep（更快、零成本）
- **非代码文件**（YAML/JSON/Markdown/配置）→ Read/grep
- **要完整文件内容** → 直接 Read

## 关键用法

1. `search "<自然语言描述>"` 定位 → 拿到 file:line + 调用关系
2. **只 Read 真正需要的区间**（offset/limit），不要整文件通读
3. 首轮不准就换更聚焦的 query 再搜；一个概念一条 query
4. search 无结果 → **立刻回退** grep/read，不要死循环
5. 未索引 → `index` 一次（之后增量自动更新）

## 规模参考
- 大仓库：优先 search（grep 噪声太多，向量检索更精准）
- 小模块（<50 文件）：直接 read/grep 也可能更快
- 判定依据是**问题性质**，不是项目大小
