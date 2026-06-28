# 2026-06-28 | Phase 2: 调用边解析 + 增量索引

## 目标
增强 AST 提取器生成 CALLS 边，实现增量变更检测。

## 修改内容

### extractor.ts 重写
- **两遍提取**: Pass 1 收集所有定义到注册表 → Pass 2 遍历调用表达式创建 CALLS 边
- **嵌套定义**: 类内方法使用 parent.method 命名 (如 `MyClass.greet`)
- **导入感知**: 解析 import/require 语句，提取 importedName → 创建 IMPORTS 边
- **方法调用**: 支持 `obj.method()` 模式的方法调用解析

### graph-store.ts 增强
- **executeQuery**: Cypher 风格查询 (MATCH (n) WHERE n.name = 'X' RETURN n)
- **ADR 管理**: createADR/getADRs/updateADR，存为 ADR 标签节点
- **project 参数可选**: findNodes 支持跨项目查询

### graph-handlers.ts 增强
- **detect_changes**: 使用 git diff 检测变更文件 + 影响节点分析
- **query_graph**: Cypher 查询支持
- **manage_adr**: 架构决策记录 CRUD (list/create/update)
- **findRepoPath**: 自动定位仓库路径
- **handleIndexRepository**: 边插入时解析临时索引→DB 真实 ID

### 新增 MCP 工具
query_graph, manage_adr

## 测试
25/25 PASS (新增 CALLS 边、导入解析、ADR、Cypher 查询用例)