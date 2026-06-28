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

---

## AI Agent 操作手册（重要）

以下是你需要知道的全部关键上下文，按顺序执行即可。

### 执行前检查

1. **确认项目已构建**：先执行 `cd /home/zt/-AI- && pnpm build`，确保 `packages/graph/dist/` 和 `packages/mcp/dist/` 存在
2. **确认内网可达**：`curl -s http://10.50.4.149:19530` 和 `curl -s http://10.50.4.149:11435` 有响应
3. **确认环境变量**：`MILVUS_ADDRESS`、`EMBEDDING_PROVIDER`、`EMBEDDING_MODEL`、`OLLAMA_HOST`、`EMBEDDING_DIMENSION` 已设置
4. **确认磁盘空间**：`df -h /home/zt` 至少有 50GB 可用（6 个仓库 shallow clone 约 30-40GB）

### 执行步骤

```bash
# 第一步：构建项目
cd /home/zt/-AI- && pnpm build

# 第二步：进入测试目录
cd /home/zt/-AI-/待执行的项目效果

# 第三步：安装依赖
pnpm install

# 第四步：运行全部测试
bash run-all.sh
```

### 仓库克隆说明

- 6 个仓库都是 `--depth 1`（只拉最新一次提交），大幅减少下载量
- 如果某个仓库克隆失败（网络问题），脚本会跳过，不影响其他测试
- 如果磁盘空间不足，可以修改 `run-all.sh` 中的 `REPOS` 数组，只保留 2-3 个

### 测试预期结果

| 测试 | 成功标志 | 失败时做什么 |
|------|---------|-------------|
| 01 图引擎 | 输出节点数/边数/调用链深度 | 检查 `packages/graph/dist/` 是否存在 |
| 02 MCP 集成 | 4 个工具全部调用成功 | 检查 Milvus/Ollama 是否可达 |
| 03 Token 效率 | MCP 方式 token 显著少于传统方式 | 调大传统方式的文件读取数 |
| 04 仓库隔离 | 不同仓库 identity 不同，同仓库相同 | 检查 git remote 是否正确 |
| 05 代码质量 | 平均评分 >= 60 | 评分是模拟的，实际看 LLM 输出 |
| 06 增量索引 | git diff 可用，增量逻辑正确 | 检查仓库是否有 .git 目录 |

### 关键注意事项

- **测试 01 可以离线运行**，不依赖 MCP，可以立即跑
- **测试 02-06 必须在内网**，否则 `run-all.sh` 会自动跳过
- **测试 02 的 MCP 调用方式**是通过 `child_process` 模拟的，实际需要手动验证 MCP 工具是否正常工作
- **测试 05 的代码质量评分**是模拟的（基于项目结构分析），不是真实 LLM 输出。真实效果需要人肉评估
- 如果某个测试失败，不影响其他测试继续执行
- 所有结果写入 `test-results/` 目录，JSON 格式

### 最终交付

测试完成后，Agent 应该：
1. 读取 `test-results/` 下的所有 JSON 文件
2. 汇总成一个简洁的测试报告
3. 给出结论：项目效果是否达标，是否建议上线