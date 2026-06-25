# 修复:`get_indexing_status` 误报"未索引"

## 问题

一个仓库明明已经索引完成(`search` 能正常返回结果),调用 `get_indexing_status`
却返回:

```
❌ Codebase '/home/zt/ponytail' is not indexed. Please use the index_codebase tool to index it first.
```

而磁盘上的快照文件 `~/.context/mcp-codebase-snapshot.json` 里,该仓库的状态其实是
`indexed`(348 文件 / 348 chunks)。即:**磁盘是对的,只有 `get_indexing_status` 报错。**

## 根因

`search` 和 `get_indexing_status` 读的是**两个不同的数据源**:

| 工具 | 读取来源 | 结果 |
|------|----------|------|
| `search_code` | **磁盘 JSON**(`getIndexedCodebases()` → `findIndexedCodebasePath`) | ✅ 正常 |
| `get_indexing_status` | **内存** `codebaseInfoMap`(`findTrackedCodebasePath` / `getCodebaseStatus` / `getCodebaseInfo`) | ❌ 误报 |

内存里的 `codebaseInfoMap` 只在两种时机更新:

1. 服务启动时 `loadCodebaseSnapshot()` 从磁盘加载;
2. 本进程内发生写操作(`setCodebaseIndexed` 等)。

因此,当出现以下任一情况时,内存就会与磁盘脱节:

- 仓库是被**另一个进程 / 另一个 MCP client** 索引的;
- 本进程在条目被写入磁盘**之前**就加载了内存 map,之后没有再刷新。

此时内存 map 里没有该仓库 → `getCodebaseStatus` 返回 `not_found` → 报"未索引"。

> 之前那次提交加的 "Milvus 兜底" 没能解决此问题:它只在 `not_found` 时触发,且依赖一次
> 实时的 Milvus 行数探测,在这种内存/磁盘漂移的场景下没能兜住。

## 解决方案

让 `get_indexing_status` 与 `search` 读取**同一个数据源(磁盘快照)**,内存缺失时从磁盘自愈,
磁盘也没有时才落到 Milvus 兜底。

涉及文件:`packages/mcp/src/`

### 1. `snapshot.ts`

- 新增 `getCodebaseInfoFromDisk(codebasePath)`:直接读磁盘 JSON 快照,返回该仓库的 info
  (与 `getIndexedCodebases()` 同源),绕过可能过期的内存 map。
- 新增 `refreshCodebaseFromDisk(codebasePath, info)`:用磁盘数据**覆盖**内存条目(自愈),
  同时同步 `indexedCodebases` / `indexingCodebases` / `codebaseFileCount`。

### 2. `handlers.ts` — `handleGetIndexingStatus`

- 路径解析改用与 `search` 一致的磁盘版查找:
  `findIndexedCodebasePath` → `findIndexingCodebasePath` → `findTrackedCodebasePath` → `absolutePath`。
- 当内存判定为 `not_found` 或缺少 info 时,先用 `getCodebaseInfoFromDisk` 从磁盘读取并
  `refreshCodebaseFromDisk` 回写内存。
- **之后**才进入原有的 Milvus 兜底(磁盘也没有时的最后手段)。

## 验证

```bash
cd packages/mcp
pnpm typecheck   # ✅
pnpm test        # ✅ 5/5,含新增回归测试
pnpm build       # 编译进 dist
```

新增回归测试(`handlers.get-indexing-status.test.ts`):磁盘快照里有 `indexed` 条目、
内存为空时,`get_indexing_status` 必须报告 indexed —— 没有此修复时该测试会失败。

## 注意

修改已编入 `dist`,但**正在运行的 MCP server 进程加载的仍是旧代码**。
需要**重启 MCP server(或重启 Claude Code)** 后,`get_indexing_status` 才会用上新逻辑。




对,但我把适用范围讲清楚,避免你误判。

  已解决的核心场景(你遇到的这个):
  同一台机器上,不同客户端 / 不同进程共享同一个磁盘快照文件 ~/.context/mcp-codebase-snapshot.json。
  只要某个客户端把仓库索引状态写进了这个共享快照,现在任何客户端调用 get_indexing_status
  都会去读磁盘(和 search 同源),内存过期也会自动从磁盘自愈 →
  不再误报。这一类"换个客户端就报未索引"的问题已经解决。

  两个前提条件:
  1. 必须先重启 MCP server / Claude Code,让新代码生效。在那之前,运行中的旧进程还是老行为。
  2. 这些客户端要共享同一个快照文件(默认都在 ~/.context/,同机即满足)。

  没有被这次改动直接覆盖的场景:
  -
  如果是不同机器上的客户端,它们各自有独立的本地快照文件,不共享磁盘。这种跨机一致性靠的是另一条路径
  —— 云端同步(syncIndexedCodebasesFromCloud)+ Milvus
  兜底,不是我这次改的逻辑。它能不能恢复,取决于云端 collection 的 codebasePath
  元数据能否被正确提取。

  所以:同机、多客户端/多进程 → 已彻底解决(重启后);跨机的情况走的是另一套机制,我这次没动它。

  要不要我顺手把跨机/云同步那条路径也验证一下,确保它在你的部署里也没问题?
