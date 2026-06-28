# 2026-06-28 | Phase 3: 跨文件调用 + 跨服务追踪

## 目标
突破同文件调用限制，支持跨文件调用解析和跨服务 HTTP 追踪。

## 修改内容

### 跨文件调用解析
- **resolveCrossFileCalls**: 构建全局函数注册表 (name→qualifiedName→nodeId)
- 扫描所有 IMPORTS 边，匹配 importedName → 全局定义 → 创建跨文件 CALLS 边
- **findEdges**: 新增按类型/项目查询边的方法

### 增量索引
- handleIndexRepository 支持 `mode: 'incremental'` (git diff 自动检测变更)
- 支持 `files` 参数指定特定文件重新索引
- **detectChangedFiles**: git diff --name-only 检测变更 + 扩展名过滤

### 跨服务追踪
- **ingest_traces**: 接收 HTTP/gRPC/Event 追踪数据
- 自动创建 Resource 节点和 CROSS_HTTP_CALLS/CROSS_CHANNEL 边
- 支持 method/path/statusCode/durationMs 属性记录

### 新增 MCP 工具
ingest_traces

## 测试
28/28 PASS (新增 findEdges、跨文件边查询用例)