# 项目效果验证测试套件

## 概述

本测试套件模拟真实开发场景，验证 Claude Context MCP 在实际开发中的作用：
- 是否提高开发效率
- 是否节省 token
- 是否让 LLM 更理解项目
- 图引擎（调用链）是否提供有价值的上下文

## 测试环境要求

| 条件 | 测试01 | 测试02-06 |
|------|--------|-----------|
| Node.js >= 20 | ✓ | ✓ |
| pnpm >= 10 | ✓ | ✓ |
| 内网 Milvus (10.50.4.149:19530) | ✗ | ✓ |
| 内网 Ollama (10.50.4.149:11435) | ✗ | ✓ |
| 磁盘空间 (建议 >= 50GB) | 1GB | 50GB |

## 快速开始

```bash
# 1. 进入测试目录
cd /home/zt/-AI-/待执行的项目效果

# 2. 安装依赖（仅首次）
pnpm install

# 3. 运行全部测试
bash run-all.sh

# 或单独运行某个测试
npx tsx test-01-graph-engine-offline.ts
npx tsx test-02-mcp-full-integration.ts
```

## 测试清单

| 编号 | 测试 | 需要 MCP 环境 | 预计耗时 | 说明 |
|------|------|:---:|---------|------|
| 01 | 图引擎离线基准测试 | ✗ | 5min | 图索引速度、调用链准确性、架构分析质量 |
| 02 | MCP 完整集成测试 | ✓ | 10min | 索引→搜索→图增强完整链路 |
| 03 | Token 效率对比 | ✓ | 15min | 模拟真实开发场景，对比有无 MCP 的 token 消耗 |
| 04 | 多仓库隔离测试 | ✓ | 10min | url+branch 隔离、团队共享 |
| 05 | 代码质量对比 | ✓ | 20min | 同需求下有无 MCP 的 Agent 输出质量对比 |
| 06 | 增量索引测试 | ✓ | 10min | 代码变更后增量更新正确性 |

## 测试仓库

默认使用以下 6 个大型开源仓库（shallow clone, --depth 1）：

| 仓库 | 语言 | 用途 |
|------|------|------|
| torvalds/linux | C | 超大型项目，测试索引性能 |
| microsoft/vscode | TypeScript | IDE 项目，测试调用链 |
| tensorflow/tensorflow | Python/C++ | ML 框架，测试跨语言 |
| openjdk/jdk | Java | 大型 Java 项目 |
| chromium/chromium | C++ | 超大型项目，测试极限 |
| llvm/llvm-project | C++ | 编译器项目，测试架构分析 |

> 可通过修改 `run-all.sh` 中的 `REPOS` 变量调整测试仓库列表。

## 输出

测试完成后生成 `test-results/` 目录：

```
test-results/
├── summary.json          # 汇总结果（通过/失败/指标）
├── graph-benchmark.json  # 图引擎基准数据
├── token-comparison.json # Token 对比数据
├── isolation.json        # 隔离测试结果
├── quality.json          # 代码质量对比
└── incremental.json      # 增量索引结果
```