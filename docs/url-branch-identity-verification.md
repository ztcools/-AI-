# url+branch 团队共享索引 — 验证报告

## 问题

索引系统原本使用**绝对路径**作为项目标识，导致：
- 同一仓库 checkout 到不同路径时，被识别为不同项目，重复建索引
- 团队 A 成员索引后，B 成员需要重新索引，无法共享

## 解决方案

将索引标识从**绝对路径**改为 **url+branch**（仓库地址+分支名）。

### 核心改动

| 文件 | 改动 |
|------|------|
| `packages/core/src/utils/git-identity.ts` | `getRepoIdentity()` 提取 `git remote get-url origin` + `git rev-parse --abbrev-ref HEAD` → `url:branch` |
| `packages/core/src/context.ts` | 集合名和描述基于 `getRepoIdentity` 而不是绝对路径 |
| `packages/mcp/src/snapshot.ts` | 所有内部状态 map 的 key 从绝对路径改为 identity；`localPath` 作为 info 属性存储 |
| `packages/mcp/src/handlers.ts` | 索引/搜索/状态查询全部基于 identity 比较；云同步对比 identity |
| `packages/mcp/src/config.ts` | `CodebaseInfoBase` 新增 `localPath` 字段 |

### 完整流程

```
用户调用 index_codebase /home/bob/ponytail
  │
  ├─ 1. syncIndexedCodebasesFromCloud()
  ├─ 2. getRepoIdentity(path) → "https://...ponytail.git:main"
  ├─ 3. getIndexingCodebases().includes(identity)  ← identity 比较
  ├─ 4. getIndexedCodebases().includes(identity)   ← identity 比较
  ├─ 5. context.hasIndex(path) → 查 Milvus (collection 名基于 identity)
  │     └─ 团队其他人已索引 → 自动恢复本地快照 → 跳过
  └─ 6. 都不满足 → 真正开始索引
```

## 测试结果

使用真实项目 `/home/zt/code-study-record`（`https://github.com/ztcools/code-study-record.git:master`）验证。

### 测试覆盖

**git-identity 测试 (6 项)**
- 真实 repo 返回 `url:branch`
- 同一 repo clone 到不同路径 → 相同 identity
- 非 git 目录 → 返回路径本身（fallback）
- 不存在的路径 → 返回路径本身
- 不同分支 → 不同 identity
- 相对路径 → 正确解析

**snapshot 测试 (12 项)**
- 同一 repo 不同路径 → 单一 identity 条目
- `getIndexedCodebases()` 返回 identity 而非路径
- `setCodebaseIndexing` → identity 为 key
- 完整生命周期（indexing → indexed → failed）→ identity 驱动
- 快照 save/load 往返 → identity key 持久化
- 多分支不同 identity → 独立条目
- `getCodebaseInfo/Status` 直接接受 identity 字符串
- `removeCodebaseCompletely` 通过 identity 删除
- `findTrackedCodebasePath` 返回 localPath
- `getFailedCodebases` 返回 identity 列表
- `getCodebaseInfoFromDisk` 通过 identity 查找
- 0/0+completed 防护（Issue #295）

### 结果

```
18/18 全部通过
```

## 测试代码位置

- `/home/zt/claude-context/test/git-identity.test.ts`
- `/home/zt/claude-context/test/snapshot-identity.test.ts`

运行方式：
```bash
cd packages/mcp && npx tsx --test ../../test/git-identity.test.ts ../../test/snapshot-identity.test.ts
```