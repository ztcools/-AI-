# 向量索引优化与重构计划

## 前置确认

- **图谱文件未被修改**：上次分析的 9 个核心文件 md5 未变
- **图谱重构只改动了**：`packages/graph/` + `packages/mcp/src/graph-handlers.ts` + `packages/mcp/src/handlers.ts`（图谱集成部分），与向量索引核心无交叉
- **本次改动范围**：仅 `packages/core/src/` 下的向量索引相关文件，不动图

---

## Phase 1：移除确认的死代码

### 1.1 `reindexByChange` 方法（context.ts:1192-1266）
- **75 行**，零调用者（全仓库搜索结果：仅定义，无调用）
- 已被 `syncIndexByMerkle` 完全替代
- 移除后连带移除其对 `deleteFileChunks` 的 2 次逐文件调用（1238、1244行）

### 1.2 `deleteFileChunksBatch` 假分页循环骨架
- 第 1585-1607 行的 `while(true)` 循环永远只执行一次（最后 `break` 无条件跳出）
- 方案：移除外层死循环，保留单次批量查询 + 批量删除逻辑（功能不变，去误导性骨架）

---

## Phase 2：消除重复代码

### 2.1 抽取共享的 dotfile/dotdir 过滤逻辑
**现状**：两处独立维护相同的过滤规则
- `FileSynchronizer.shouldIgnore`（synchronizer.ts:218-235）— `ALLOWED_DOT_DIRS` 为 `static readonly`
- `Context.matchesIgnorePattern`（context.ts:2644-2660）— `ALLOWED_DOT_DIRS` 为内联 `new Set`

**方案**：
1. 创建 `packages/core/src/utils/path-filter.ts`
2. 导出 `ALLOWED_DOT_DIRS` 常量 + `shouldSkipDotPath(relativePath)` 函数
3. 两处都改为调用共享函数，删除各自的内联实现

### 2.2 `semanticSearch` → `searchWithLayers` 薄包装
**现状**：两个方法核心逻辑 90% 相同，区别仅在于 layer 来源
- `semanticSearch`：通过 `resolveLayerChain` 从 CommitIndexState 构建 layers
- `searchWithLayers`：调用方显式传入 layers

**方案**：`semanticSearch` 改为委托给 `searchWithLayers`（向后兼容，公开 API 签名不变）

---

## Phase 3：修复实际 Bug

### 3.1 消除 `deleteFileChunksBatch` 假分页（Phase 1.2）

### 3.2 `generateFileHashes` execSync → exec（异步化）
**现状**：`execSync` 对大仓库（100K+ 文件）阻塞主线程数秒

**方案**：`FileSynchronizer.generateFileHashes` 使用 `util.promisify(exec)` 替代 `execSync`
- 声明已经是 `async`，调用方全为 `await`，零破坏

### 3.3 `deduplicateResults` 同文件内 O(n*m) 优化
**现状**：按文件分组后，同文件内 `kept.some()` 逐次增长

**方案**：同文件内 results 按 startLine 排序后，只与最近一个 kept 比较（相邻 overlap 检查即可，因为排序保证区间有序）

---

## Phase 4：小优化

### 4.1 `getEffectiveSupportedExtensions` 增缓存
- 每次调用创建新 Set，调用频繁
- 增加 `this.effectiveExtensionsCache` 缓存

### 4.2 `loadIgnorePatterns` 中 `findIgnoreFiles` 用 `opendir` 代替 `readdir`
- `readdir` 一次加载全部条目到内存

---

## 不改动的范围

| 项目 | 原因 |
|------|------|
| `syncIndexByGit` 重构 | 服务端依赖，风险高 |
| `semanticSearch` 移除 | 公开 API，保持兼容 |
| `context.ts` 拆分为多个文件 | 影响面太大，需专项重构 |
| 图相关代码 | 用户明确不动 |
| `CommitIndexState` | 服务端使用 |
| `syncCollectionState()` | handlers.ts 中仍被调用 |

## 验证

每次 phase 后执行：
```bash
cd /home/zt/context
pnpm typecheck && pnpm lint && pnpm build:core && pnpm build:mcp
```

## 风险控制

1. 每 phase 独立提交，方便回滚
2. 不改动公开 API 签名
3. 不改动核心数据流
4. 共享逻辑语义完全等价
