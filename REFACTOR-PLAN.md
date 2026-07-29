# claude-context 云端向量索引重构方案

> 目标：本地零向量索引，向量全部云端；本地仅保留图索引；通过 /seeway-link 进入"链接远程向量 + 本地图"工作模式。

## 核心决策（已与用户确认）
1. **向量搜索**：本地轻量 embedding（Ollama 客户端，把 query 转向量）+ HTTP 直连云端 Milvus hybridSearch。向量化模型与向量库都在云端，本地零资源占用。
2. **链接状态**：进程内存 Map，MCP 进程退出即失效。不落盘，避免跨项目混乱。
3. **core 瘦身**：激进。删全部索引写入代码，只留只读搜索子集。
4. **控制台**：双页各司其职。GitLabRepos（配置态，浏览器直连 8795）二级分层；IndexTree（索引态，读 code_index_state）保持。
5. **图索引**：保留本地增量。/seeway-link 时首次全量建图、后续增量更新图。
6. **未链接**：本地有图用图搜索，无图则 search 提示并返回空（不报错中断）。

## 架构变化
```
Before:  本地 dev⊕root 双层 collection + merkle 增量 + 本地 embedding + 本地写 Milvus
After:   云端单 collection(按 repo:protectedBranch) + 本地只读检索 + 本地图(SQLite)
```

## collection 命名（关键兼容点 —— 不变）
```
identity      = normalizeGitUrl(remoteUrl) + ':' + branch        # 云端保护分支
collection    = (HYBRID_MODE?'hcc':'cc') + '_' + slug32 + '_' + md5(identity)[:8]
寻址函数       = getCollectionNameForIdentity(identity)           # core 保留
```

## core 包裁剪（packages/core/src）
### 删除（文件级）
- sync/synchronizer.ts, sync/merkle.ts          # merkle 增量索引
- index-state/index-state.ts                     # CommitIndexState(写产物)
- cache/embedding-cache.ts                       # MilvusEmbeddingCache(写产物)
- splitter/ (ast-splitter.ts, langchain-splitter.ts)  # 本地不再分块
- utils/dev-fingerprint.ts                       # dev 身份概念失效

### context.ts 删除方法
indexCodebase / syncIndexByGit / syncIndexByMerkle / indexBranchDelta /
prepareCollection / prepareDevCollection / processFileList / processChunkBuffer /
processChunkBatch / validateEmbeddings / getCodeFiles / deleteFileChunks(Batch) /
resolveLineage / computeLayerMeta / clearIndex / hasIndex / getPreparedCollection /
getSynchronizers / setSynchronizer / invalidateSynchronizer / IndexAbortError

### context.ts 保留方法（只读搜索子集）
searchWithLayers / searchLayer / globalHybridFusion / deduplicateResults /
applyScoreCutoff / combineFilters / getQueryEmbedding /
getCollectionNameForIdentity / getRootCollectionName(→主寻址) /
semanticSearch(若无依赖可删，倾向删)

### 保留工具（不动）
utils/git-identity.ts (getRepoIdentity/normalizeGitUrl)
utils/env-manager.ts / utils/git-history.ts(仅只读原语) / utils/glob-matcher.ts(若被搜索引用)

### vectordb 保留只读子集
VectorDatabase 接口保留；MilvusVectorDatabase/MilvusRestfulVectorDatabase 保留
hasCollection/search/sparseSearch/hybridSearch/query/getCollectionRowCount，
写路径 createCollection/dropCollection/insert/delete 保留（云端 service 仍用 core 写！）

> 注意：git-index-service 依赖 core 做写入，所以 core 的写路径（insert/createCollection）不能删，
> 只删"本地索引编排"（synchronizer/merkle/splitter/indexCodebase 等本地文件扫描与切块）。
> 修正：splitter 与 indexCodebase 是 git-index-service 写入依赖 → 保留，移到 service 侧评估。

## mcp 包重构（packages/mcp/src）
### 工具集
- link(repo?, branch?, path?)   — 建立会话链接：检测仓库 → 选保护分支 → 云端 collection 寻址 + 本地图(首次全量/增量)
- unlink(path?)                  — 断开链接(清会话状态)
- search(query, path?, mode?, limit?) — 链接后向量+图; 未链接仅图; 无图提示
- clear(path?)                   — 仅清本地图索引
- status(path?)                  — 链接状态 + 图状态 + 云端 collection 连通性

### 删除
- index/index_codebase 工具 + handleIndex + handleIndexCodebase
- sync.ts 后台同步（SyncManager）
- snapshot.ts 中向量快照部分

### 新增
- link-state.ts：进程内 Map<repoIdentity, {branch, collectionName, linkedAt}>
- 会话级 architectureEmitted 保留

## 图索引 bug 修复（packages/graph）— 已完成
1. ✅ indexer.ts: indexAll 消费 options.files → 真增量（按文件级 deleteNodesByFile 替换）
2. ✅ indexer.ts: Phase3 resolveAndPersistBatched 改为 await + resetFailedRefs 增量重试
3. ✅ graph-store.ts: 新增 getGraphVersion/setGraphVersion（PRAGMA user_version）+ INDEXER_VERSION 版本戳，旧图自动识别重建
4. ✅ traversal.ts: callLikeEdges —— calls 优先、回退 references/instantiates、永不取 imports（调用图去噪）
5. ✅ getImpactRadius 改用 callLikeEdges（影响面去噪）

## 多语言调用解析修复（extractor/resolution）— 深化轮已完成
1. ✅ extractMethodCall 支持 Python `attribute`、Go `selector_expression`、C/C++ `field_expression`、Java `name` 字段（method_invocation）
2. ✅ extractCallName 支持 Java `name` 字段
3. ✅ isLikelyCrossFileReference 放宽：camelCase/PascalCase 必追踪，全小写 ≥4 字符也追踪（修复 toJson/write 被滤）
4. ✅ 重载消歧：registry 命中自身时也建 ref；matchSuffixName 多重载取同文件第一个（suffix-name-overload）
5. ✅ graph-buffer upsertNode QN 冲突按 file:line 消歧（修复重载方法被吞）
6. ✅ findNodes Pass 0 精确名/后缀优先层（score=1000），修复查 toJson 召回 toString
7. ✅ 调用图精度批量评估 80%（flask/gin/gson/requests 关键符号）

## search 算法优化（packages/mcp/handlers.ts + core）— 已完成
1. ✅ 调用图去 import 边噪声（callLikeEdges）
2. ✅ enrich 的 getEdgesBySourceBatch 加 'calls' kind 过滤（修复 "→ num, name, raw" 噪声）
3. ✅ 内容近重复去重（dedupNearDuplicateContent 结构骨架前缀签名）+ 文件多样性约束（applyFileDiversity）
4. ✅ 图身份一致性（统一当前工作区分支 identity）

## 语言特性 ignore（packages/graph indexer + core ignore-patterns）
按语言补充索引忽略：node_modules/vendor/dist/build/锁文件/min.js/生成代码/二进制资源等，
避免污染图与向量。

## git-index-service（packages/git-index-service）
- config.ts: RepoSpec + protectedBranches?: string[]
- server.ts: maskRepo 透传 + POST/PUT 解析 + POST /index/:name/:branch
- indexer.ts: 循环 [main, ...protectedBranches] 各 checkout+索引
- 新增 GET /branches?name= → git ls-remote 列远程分支(供 /seeway-link 提示)
- 可选 GET /search-verify 探活

## PhiGent（/home/zt/PhiGent）
- service.ts: GitRepo + protectedBranches; lastRun → per-branch
- GitLabRepos.tsx: 扁平表 → 仓库行(可展开) + 保护分支子行；添加/编辑对话框加保护分支输入
- 复用 IndexTree.tsx 的分组/缩进模式

## 部署/脚本
- install.sh 重写：去掉本地 core 索引构建，改为 link 模式说明
- 失效 env 清理（~30 个），保留 SEARCH_* + CLAUDE_CONTEXT_DEV_ID + 云端 endpoint/token
- pnpm-workspace.yaml 清理孤儿 allowBuilds
- scripts/build-benchmark.js 引用已删 build:vscode → 修或删
