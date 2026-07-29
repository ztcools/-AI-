import * as fs from "fs";
import * as path from "path";
import {
    Context,
    COLLECTION_LIMIT_MESSAGE,
    getRepoIdentity,
    normalizeGitUrl,
    getRemoteUrl,
    getCurrentBranch,
    envManager,
} from "@seeway/claude-context-core";
import { resolveCodebasePath, truncateContent, trackCodebasePath } from "./utils.js";
import type { GraphToolHandlers } from "./graph-handlers.js";
import { INDEXER_VERSION } from "@seeway/claude-context-graph";
import { linkState, LinkInfo } from "./link-state.js";

/**
 * ToolHandlers — MCP 工具处理器（重构版）。
 *
 * 与旧版本的区别：
 *  - 本地不再做向量索引。向量数据全部在云端 git-index-service 预先建好。
 *  - 本地只做两件事：link（绑定云端 collection） + search（直连云端 Milvus + 本地图富化）。
 *  - 本地图索引仍然按需构建（SQLite），与云端向量索引并行工作。
 */
export class ToolHandlers {
    private context: Context;
    private currentWorkspace: string;
    private graphToolHandlers: GraphToolHandlers | null = null;
    /**
     * 本次会话已触发后台图构建的项目集合。
     * 本地图是 SQLite，云端向量索引是 Milvus —— 两者独立。
     * 已链接的仓库若图为空，第一次 search/link 会触发后台全量建图；
     * 此集合防止每次 search 都重复触发。
     */
    private autoGraphBuildTriggered: Set<string> = new Set();
    private lastGraphSyncCheck: Map<string, number> = new Map();
    /**
     * 架构摘要已输出的项目集合（每会话每项目只输出一次，避免 token 浪费）。
     */
    private architectureEmitted: Set<string> = new Set();

    constructor(context: Context, graphToolHandlers?: GraphToolHandlers) {
        this.context = context;
        this.graphToolHandlers = graphToolHandlers || null;
        this.currentWorkspace = process.cwd();
        console.log(`[WORKSPACE] Current workspace: ${this.currentWorkspace}`);
    }

    /**
     * Search precision / token knobs, read from env so operators can tune the
     * read-vs-search tradeoff without a rebuild.
     */
    private getSearchTuning(): { defaultLimit: number; threshold: number; snippetMaxChars: number; scoreRatio: number } {
        const num = (name: string, fallback: number): number => {
            const raw = envManager.get(name);
            if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
            const v = Number(raw);
            return Number.isFinite(v) ? v : fallback;
        };
        return {
            defaultLimit: Math.max(1, Math.min(50, num('SEARCH_DEFAULT_LIMIT', 10))),
            threshold: num('SEARCH_THRESHOLD', 0.4),
            snippetMaxChars: Math.max(200, num('SEARCH_SNIPPET_MAX_CHARS', 4000)),
            scoreRatio: Math.max(0, Math.min(1, num('SEARCH_SCORE_RATIO', 0))),
        };
    }

    /** 云端 git-index-service 基础 URL */
    private getGitIndexServiceUrl(): string {
        return envManager.get('GIT_INDEX_SERVICE_URL') || 'http://10.50.4.149:8795';
    }

    /**
     * 从云端 git-index-service 拉取该仓库的可链接分支列表。
     * 返回 null 表示云端服务不可达。
     */
    private async fetchCloudBranches(remoteUrl: string): Promise<{ branches: string[]; source: 'name' | 'url' } | null> {
        const base = this.getGitIndexServiceUrl();
        const normalized = normalizeGitUrl(remoteUrl);
        // 从 URL 推导仓库名（最后一段去掉 .git）
        const repoName = normalized.split('/').pop()?.replace(/\.git$/, '') || '';

        // 优先按 name 查询（更精确），其次按 url
        const candidates: Array<{ url: string; source: 'name' | 'url' }> = [];
        if (repoName) candidates.push({ url: `${base}/branches?name=${encodeURIComponent(repoName)}`, source: 'name' });
        candidates.push({ url: `${base}/branches?url=${encodeURIComponent(normalized)}`, source: 'url' });

        for (const { url, source } of candidates) {
            try {
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), 5000);
                const resp = await fetch(url, { signal: controller.signal });
                clearTimeout(timer);
                if (!resp.ok) continue;
                const data: any = await resp.json();
                // 期望结构: { branches: string[] } 或 { data: { branches: string[] } } 或数组
                const branches: string[] = Array.isArray(data) ? data
                    : Array.isArray(data?.branches) ? data.branches
                    : Array.isArray(data?.data?.branches) ? data.data.branches
                    : [];
                if (branches.length > 0) return { branches, source };
            } catch (e: any) {
                // 网络失败/超时 → 尝试下一个候选
                continue;
            }
        }
        return null;
    }

    /**
     * 解析 link 参数 → 选定远程 URL + 分支。
     * 优先 args.repo / args.branch，缺省从 cwd 的 git 仓库推导。
     */
    private async resolveLinkTarget(args: any): Promise<{
        absolutePath: string;
        remoteUrl: string;
        branch: string | null;         // null 表示未指定，需用户选
        suggestedBranches?: string[];  // 云端返回的候选分支
        cloudUnreachable?: boolean;
        error?: string;
    }> {
        const codebasePath = args.path || '.';
        const absolutePath = resolveCodebasePath(codebasePath);

        // 路径校验
        if (!fs.existsSync(absolutePath)) {
            return { absolutePath, remoteUrl: '', branch: null, error: `Path '${absolutePath}' does not exist. Original input: '${codebasePath}'` };
        }
        const stat = fs.statSync(absolutePath);
        if (!stat.isDirectory()) {
            return { absolutePath, remoteUrl: '', branch: null, error: `Path '${absolutePath}' is not a directory` };
        }

        // 优先使用 args.repo 显式指定的远程 URL（支持非 git 目录）
        let remoteUrl: string | null = null;
        let currentBranch: string | null = null;
        if (typeof args.repo === 'string' && args.repo.trim().length > 0) {
            remoteUrl = normalizeGitUrl(args.repo.trim());
        } else {
            remoteUrl = getRemoteUrl(absolutePath);
            currentBranch = getCurrentBranch(absolutePath);
        }

        if (!remoteUrl) {
            return {
                absolutePath,
                remoteUrl: '',
                branch: null,
                error: `Path '${absolutePath}' is not a git repository and no 'repo' argument was provided.\n` +
                    `Please either run inside a git repo, or pass the repo URL explicitly, e.g.\n` +
                    `  link { path: "${absolutePath}", repo: "git@github.com:org/repo.git", branch: "main" }`,
            };
        }

        // 分支优先级：args.branch > 当前分支 > null（需要用户/上层 agent 选）
        let branch: string | null = null;
        let suggestedBranches: string[] | undefined;
        let cloudUnreachable = false;

        if (typeof args.branch === 'string' && args.branch.trim().length > 0) {
            branch = args.branch.trim();
        } else if (currentBranch) {
            // 优先用当前分支；若云端无该分支的索引，hasCollection 会失败并提示
            branch = currentBranch;
        } else {
            // 未指定且不在 git 仓库（例如 bare 调用） → 询问云端
            const cloud = await this.fetchCloudBranches(remoteUrl);
            if (cloud && cloud.branches.length > 0) {
                suggestedBranches = cloud.branches;
            } else {
                cloudUnreachable = true;
            }
        }

        return { absolutePath, remoteUrl, branch, suggestedBranches, cloudUnreachable };
    }

    // ── Tool: link ──────────────────────────────────────────────────
    /**
     * 链接当前仓库到云端保护分支的向量索引。
     * 同时首次/增量构建本地图索引。
     */
    public async handleLink(args: any) {
        try {
            const target = await this.resolveLinkTarget(args);
            if (target.error) {
                return { content: [{ type: 'text', text: `Error: ${target.error}` }], isError: true };
            }

            const { absolutePath, remoteUrl } = target;

            // 未指定分支且云端有候选 → 列出候选让用户/上层 agent 选
            if (!target.branch) {
                if (target.suggestedBranches && target.suggestedBranches.length > 0) {
                    return {
                        content: [{
                            type: 'text',
                            text: `Multiple protected branches found for '${remoteUrl}'. Please pick one and re-run link with the branch parameter:\n` +
                                target.suggestedBranches.map(b => `  - ${b}`).join('\n') +
                                `\n\nExample: link { path: "${absolutePath}", branch: "${target.suggestedBranches[0]}" }`,
                        }],
                    };
                }
                if (target.cloudUnreachable) {
                    return {
                        content: [{
                            type: 'text',
                            text: `Could not reach git-index-service to list branches for '${remoteUrl}'.\n` +
                                `Please specify the protected branch explicitly, e.g.\n` +
                                `  link { path: "${absolutePath}", branch: "main" }`,
                        }],
                        isError: true,
                    };
                }
                return {
                    content: [{
                        type: 'text',
                        text: `No branch specified and no protected branches discovered for '${remoteUrl}'.\n` +
                            `Please pass the branch explicitly, e.g. link { path: "${absolutePath}", branch: "main" }`,
                    }],
                    isError: true,
                };
            }

            const branch = target.branch;
            const identity = `${normalizeGitUrl(remoteUrl)}:${branch}`;
            const collectionName = this.context.getCollectionNameForIdentity(identity);

            // 验证云端 collection 存在
            const vdb = this.context.getVectorDatabase();
            const exists = await vdb.hasCollection(collectionName).catch(() => false);
            if (!exists) {
                return {
                    content: [{
                        type: 'text',
                        text: `Error: Cloud index not found for '${identity}' (collection: ${collectionName}).\n` +
                            `Please confirm the git-index-service has indexed this repo@branch, or pick another protected branch.`,
                    }],
                    isError: true,
                };
            }

            // 写入会话链接状态
            const linkInfo: LinkInfo = {
                identity,
                branch,
                collectionName,
                linkedAt: Date.now(),
                repoRoot: absolutePath,
                remoteUrl,
            };
            linkState.set(absolutePath, linkInfo);
            console.log(`[LINK] Linked '${absolutePath}' → ${identity} (collection: ${collectionName})`);

            // 触发本地图：图不存在 → 后台全量；否则 → 后台增量。
            // 图的 project 用【当前工作区分支】（getRepoIdentity），与 search 的图查询保持一致——
            // 图反映本地磁盘代码（当前 checkout 的分支），与向量寻址用的链接分支是两回事。
            let graphNote = '';
            if (this.graphToolHandlers) {
                const graphProject = (() => { try { return getRepoIdentity(absolutePath); } catch { return identity; } })();
                this.graphToolHandlers.setProject(absolutePath);
                const stats = this.graphToolHandlers.getStore().getProjectStats(graphProject);
                const alreadyGraphIndexed = stats.nodes > 0;

                setImmediate(async () => {
                    try {
                        if (alreadyGraphIndexed) {
                            // 增量更新
                            let changedFiles: string[] = [];
                            try {
                                const detectResult = this.graphToolHandlers!.detectChangedFiles({ project: graphProject });
                                if (detectResult) changedFiles = detectResult.changedFiles;
                            } catch { /* 忽略，走全量 */ }

                            if (changedFiles.length > 0) {
                                console.log(`[LINK] Detected ${changedFiles.length} changed files, running incremental graph index`);
                                await this.graphToolHandlers!.handleIndexRepository({
                                    repo_path: absolutePath,
                                    mode: 'incremental',
                                    files: changedFiles,
                                });
                            } else {
                                console.log(`[LINK] No changes detected for '${graphProject}', skipping graph re-index`);
                            }
                        } else {
                            console.log(`[LINK] Local graph empty for '${graphProject}', building in background...`);
                            await this.graphToolHandlers!.handleIndexRepository({
                                repo_path: absolutePath,
                                mode: 'full',
                            });
                            console.log(`[LINK] Background graph build complete for '${graphProject}'`);
                        }
                    } catch (e: any) {
                        console.warn(`[LINK] Background graph build failed for '${graphProject}': ${e?.message || e}`);
                    }
                });

                graphNote = alreadyGraphIndexed
                    ? `\n[Graph] Already indexed: ${stats.nodes} nodes, ${stats.edges} edges (incremental check in background)`
                    : `\n[Graph] Building in background...`;
            }

            trackCodebasePath(absolutePath);

            return {
                content: [{
                    type: 'text',
                    text: `Linked '${absolutePath}' to cloud index '${identity}'.\n` +
                        `Collection: ${collectionName}${graphNote}\n\n` +
                        `You can now use the search tool. Vector results will be served from the cloud index; graph enrichment from the local SQLite graph.`,
                }],
            };
        } catch (error: any) {
            console.error('Error in handleLink:', error);
            return {
                content: [{ type: 'text', text: `Error linking repository: ${error.message || error}` }],
                isError: true,
            };
        }
    }

    // ── Tool: unlink ────────────────────────────────────────────────
    public async handleUnlink(args: any) {
        const codebasePath = args.path || '.';
        const absolutePath = resolveCodebasePath(codebasePath);
        const removed = linkState.delete(absolutePath);
        if (removed) {
            return { content: [{ type: 'text', text: `Unlinked '${absolutePath}'.` }] };
        }
        return { content: [{ type: 'text', text: `'${absolutePath}' was not linked.` }] };
    }

    // ── Tool: search ────────────────────────────────────────────────
    public async handleSearchCode(args: any) {
        const tuning = this.getSearchTuning();
        const { path: codebasePath = ".", query, limit, extensionFilter, mode, enrich, style } = args;
        const searchMode: 'vector' | 'graph' | 'both' = (mode === 'graph') ? 'graph' : (mode === 'vector') ? 'vector' : 'both';
        const doEnrich = searchMode === 'both' && enrich !== false;
        const compactStyle = style === 'compact';
        const resultLimit = limit || tuning.defaultLimit;

        try {
            const absolutePath = resolveCodebasePath(codebasePath);

            if (!fs.existsSync(absolutePath)) {
                return {
                    content: [{ type: 'text', text: `Error: Path '${absolutePath}' does not exist. Original input: '${codebasePath}'` }],
                    isError: true,
                };
            }
            const stat = fs.statSync(absolutePath);
            if (!stat.isDirectory()) {
                return { content: [{ type: 'text', text: `Error: Path '${absolutePath}' is not a directory` }], isError: true };
            }

            trackCodebasePath(absolutePath);

            // 取链接信息（未链接 → 走 graph-only 路径）
            const link = linkState.getByPath(absolutePath);
            const project = (() => { try { return getRepoIdentity(absolutePath); } catch { return absolutePath; } })();

            // 已链接 → 触发图自动构建（若图为空）
            if (link) {
                this.maybeAutoBuildGraphIndex(absolutePath);
            }

            // 图索引实时性：图非空时做 Merkle 变更检测，文件变了立即后台增量重建，
            // 使后续 search 能看到当前工作区代码（向量按设计不实时，仅保护分支每日更新）。
            if (this.graphToolHandlers) {
                this.maybeIncrementalGraphSync(absolutePath);
            }

            // 图状态
            let graphHasNodes = false;
            if (this.graphToolHandlers) {
                try {
                    this.graphToolHandlers.setProject(absolutePath);
                    const stats = this.graphToolHandlers.getStore().getProjectStats(project);
                    graphHasNodes = stats.nodes > 0;
                } catch { /* ignore */ }
            }

            // 未链接且无图 → 提示先 link
            if (!link && !graphHasNodes) {
                return {
                    content: [{
                        type: 'text',
                        text: `Error: '${absolutePath}' is not linked to a cloud index and has no local graph index.\n` +
                            `Please run the link tool first to bind this repo to a cloud-indexed protected branch.`,
                    }],
                    isError: true,
                };
            }

            // 构建向量层（单层，无 mask）
            const layers: Array<{ collectionName: string }> = [];
            if (link) layers.push({ collectionName: link.collectionName });

            // 扩展名过滤
            let filterExpr: string | undefined = undefined;
            if (Array.isArray(extensionFilter) && extensionFilter.length > 0) {
                const cleaned = extensionFilter
                    .filter((v: any) => typeof v === 'string')
                    .map((v: string) => v.trim())
                    .filter((v: string) => v.length > 0);
                const invalid = cleaned.filter((e: string) => !(e.startsWith('.') && e.length > 1 && !/\s/.test(e)));
                if (invalid.length > 0) {
                    return {
                        content: [{ type: 'text', text: `Error: Invalid file extensions in extensionFilter: ${JSON.stringify(invalid)}. Extensions must start with '.' (e.g., '.ts', '.py', '.java').` }],
                        isError: true,
                    };
                }
                const quoted = cleaned.map((e: string) => `'${e}'`).join(', ');
                filterExpr = `fileExtension in [${quoted}]`;
            }

            // ── 并行执行向量 + 图搜索 ──
            let vectorResults: any[] = [];
            let graphSymbols: Array<{ name: string; kind: string; filePath: string; line: number; inDegree: number; outDegree: number }> = [];
            let searchSourceNote = link ? ` (cloud: ${link.branch})` : ' (graph-only)';

            const vectorPromise = (searchMode !== 'graph' && layers.length > 0)
                ? (async () => {
                    const searchResults = await this.context.searchWithLayers(
                        layers, query, Math.min(resultLimit, 50), tuning.threshold, filterExpr,
                    );
                    let scored = searchResults;
                    if (tuning.scoreRatio > 0 && scored.length > 1) {
                        const topScore = Number(scored[0]?.score) || 0;
                        if (topScore > 0) {
                            const floor = topScore * tuning.scoreRatio;
                            scored = scored.filter((r: any, i: number) => i === 0 || (Number(r.score) || 0) >= floor);
                        }
                    }
                    vectorResults = scored;
                })()
                : Promise.resolve();

            const graphPromise = (searchMode !== 'vector' && this.graphToolHandlers)
                ? (async () => {
                    try {
                        this.graphToolHandlers!.setProject(absolutePath);
                        const store = this.graphToolHandlers!.getStore();
                        const gr = store.findNodes({ project, query, limit: Math.min(resultLimit, 10) });
                        if (gr.results.length > 0) {
                            graphSymbols = gr.results.map(r => ({
                                name: r.node.name,
                                kind: r.node.kind,
                                filePath: r.node.filePath,
                                line: r.node.startLine,
                                inDegree: r.inDegree,
                                outDegree: r.outDegree,
                            }));
                        }
                    } catch { /* ignore */ }
                })()
                : Promise.resolve();

            await Promise.all([vectorPromise, graphPromise]);

            // ── 无结果 ──
            if (vectorResults.length === 0 && graphSymbols.length === 0) {
                let noMsg = `No results for "${query}" in '${absolutePath}'${searchSourceNote}`;
                if (!link) noMsg += `\nTip: run link to enable cloud vector search.`;
                return { content: [{ type: 'text', text: noMsg }] };
            }

            // ── 格式化结果 ──
            const parts: string[] = [];
            const linkHeader = link
                ? `[linked: ${link.remoteUrl}@${link.branch}]`
                : `[not linked — graph-only]`;
            parts.push(linkHeader);

            if (vectorResults.length > 0) {
                const modeTag = searchMode === 'both' && graphSymbols.length > 0 ? ' vector+graph' : '';
                parts.push(`${vectorResults.length}${modeTag} hits for "${query}"${searchSourceNote}`);

                for (let i = 0; i < vectorResults.length; i++) {
                    const r = vectorResults[i];
                    const loc = `${r.relativePath}:${r.startLine}-${r.endLine}`;
                    if (compactStyle) {
                        const graphMatch = graphSymbols.filter(s => s.filePath === r.relativePath);
                        const graphNote = graphMatch.length > 0 ? ` [graph: ${graphMatch.map(s => s.name).join(', ')}]` : '';
                        parts.push(`[${i + 1}] ${loc} ${r.language} s=${Number(r.score || 0).toFixed(5)}${graphNote}`);
                    } else {
                        const code = truncateContent(r.content, tuning.snippetMaxChars);
                        const graphMatch = graphSymbols.filter(s =>
                            s.filePath === r.relativePath &&
                            s.line >= r.startLine &&
                            s.line <= r.endLine
                        );
                        const graphNote = graphMatch.length > 0
                            ? `  graph: ${graphMatch.map(s => `${s.kind} \`${s.name}\` (↖${s.inDegree} ↗${s.outDegree})`).join(' | ')}\n`
                            : '';
                        parts.push(`[${i + 1}] ${loc} ${r.language} s=${Number(r.score || 0).toFixed(5)}\n${graphNote}\`\`\`${r.language}\n${code}\n\`\`\``);
                    }
                }
            }

            // ── 图符号（未被向量命中）──
            const unmatchedSymbols = graphSymbols.filter(s => !vectorResults.some(r =>
                r.relativePath === s.filePath && r.startLine <= s.line && r.endLine >= s.line
            ));
            if (unmatchedSymbols.length > 0 && searchMode !== 'vector') {
                parts.push('');
                parts.push('### Graph symbols');
                for (const s of unmatchedSymbols.slice(0, 5)) {
                    parts.push(`- ${s.kind} \`${s.name}\` (${s.filePath}:${s.line}) ↖${s.inDegree} ↗${s.outDegree}`);
                }
            }

            let resultMessage = parts.join('\n');

            // ── 图富化 ──
            if (doEnrich && this.graphToolHandlers && vectorResults.length > 0) {
                try {
                    const enrich = this.enrichWithGraphContextDeep(
                        vectorResults.slice(0, 5), absolutePath, query,
                    );
                    if (enrich) resultMessage += enrich;
                } catch (graphErr: any) {
                    console.warn(`[SEARCH] Graph enrichment failed: ${graphErr.message}`);
                }
            }

            return { content: [{ type: 'text', text: resultMessage }] };
        } catch (error) {
            const errorMessage = typeof error === 'string' ? error : (error instanceof Error ? error.message : String(error));
            if (errorMessage === COLLECTION_LIMIT_MESSAGE || errorMessage.includes(COLLECTION_LIMIT_MESSAGE)) {
                return { content: [{ type: 'text', text: COLLECTION_LIMIT_MESSAGE }] };
            }
            return {
                content: [{ type: 'text', text: `Error searching code: ${errorMessage}` }],
                isError: true,
            };
        }
    }

    // ── Tool: clear ─────────────────────────────────────────────────
    /**
     * 只清本地图索引（deleteProject）。不再碰 Milvus。
     */
    public async handleClearIndex(args: any) {
        const codebasePath = args.path || '.';
        try {
            const absolutePath = resolveCodebasePath(codebasePath);

            if (!fs.existsSync(absolutePath)) {
                return {
                    content: [{ type: 'text', text: `Error: Path '${absolutePath}' does not exist. Original input: '${codebasePath}'` }],
                    isError: true,
                };
            }
            const stat = fs.statSync(absolutePath);
            if (!stat.isDirectory()) {
                return { content: [{ type: 'text', text: `Error: Path '${absolutePath}' is not a directory` }], isError: true };
            }

            let cleared: string[] = [];

            // 清链接状态
            if (linkState.delete(absolutePath)) {
                cleared.push('link');
            }

            // 清本地图
            if (this.graphToolHandlers) {
                const project = (() => { try { return getRepoIdentity(absolutePath); } catch { return absolutePath; } })();
                try {
                    this.graphToolHandlers.setProject(absolutePath);
                    this.graphToolHandlers.getStore().beginTransaction();
                    this.graphToolHandlers.getStore().deleteProject(project);
                    this.graphToolHandlers.getStore().commitTransaction();
                    cleared.push('graph');
                    console.log(`[CLEAR] Cleared graph index for: ${project}`);
                } catch (graphError: any) {
                    console.warn(`[CLEAR] Failed to clear graph index for '${project}': ${graphError.message}`);
                }
            }

            const msg = cleared.length > 0
                ? `Cleared local state for '${absolutePath}': ${cleared.join(', ')}`
                : `Nothing to clear for '${absolutePath}'.`;
            return { content: [{ type: 'text', text: msg }] };
        } catch (error: any) {
            return { content: [{ type: 'text', text: `Error clearing index: ${error.message || error}` }], isError: true };
        }
    }

    // ── Tool: status ────────────────────────────────────────────────
    public async handleStatus(args: any) {
        const { path: codebasePath = "." } = args;
        const lines: string[] = [];

        try {
            const absolutePath = resolveCodebasePath(codebasePath);
            const project = (() => { try { return getRepoIdentity(absolutePath); } catch { return absolutePath; } })();

            // ── 链接状态 ──
            lines.push('## Cloud Link');
            const link = linkState.getByPath(absolutePath);
            if (link) {
                lines.push(`  Repo: ${link.remoteUrl}`);
                lines.push(`  Branch: ${link.branch}`);
                lines.push(`  Collection: ${link.collectionName}`);
                // 探测云端连通性
                const vdb = this.context.getVectorDatabase();
                const reachable = await vdb.hasCollection(link.collectionName).catch(() => false);
                lines.push(`  Cloud: ${reachable ? '✅ reachable' : '❌ unreachable'}`);
            } else {
                lines.push('  (not linked — run link to enable cloud vector search)');
            }
            lines.push('');

            // ── 图状态 ──
            if (this.graphToolHandlers) {
                try {
                    this.graphToolHandlers.setProject(absolutePath);
                    const store = this.graphToolHandlers.getStore();
                    const stats = store.getProjectStats(project);

                    // 已链接但图为空 → 触发后台建图
                    if (link) this.maybeAutoBuildGraphIndex(absolutePath);

                    lines.push('## Graph Index (SQLite)');
                    lines.push(`  Nodes: ${stats.nodes} | Edges: ${stats.edges}`);
                    if (stats.nodes === 0) {
                        lines.push(link
                            ? '  (empty — building in background; check again shortly)'
                            : '  (empty — run link to build)');
                    }

                    const graphProgress = this.graphToolHandlers.getIndexingProgress(project);
                    if (graphProgress) {
                        const pct = graphProgress.total > 0
                            ? Math.round((graphProgress.current / graphProgress.total) * 100)
                            : 0;
                        lines.push(`  Indexing: ${pct}% (${graphProgress.current}/${graphProgress.total} files, ${graphProgress.elapsed.toFixed(1)}s elapsed)`);
                    }

                    const nodeTypeCounts = store.getNodeTypeCounts(project);
                    const typeEntries = Object.entries(nodeTypeCounts);
                    if (typeEntries.length > 0) {
                        lines.push(`  Types: ${typeEntries.map(([k, v]) => `${k}: ${v}`).join(', ')}`);
                    }

                    const edgeTypeCounts = store.getEdgeTypeCounts(project);
                    const edgeEntries = Object.entries(edgeTypeCounts);
                    if (edgeEntries.length > 0) {
                        lines.push(`  Relationships: ${edgeEntries.map(([k, v]) => `${k}: ${v}`).join(', ')}`);
                    }

                    const routeResult = store.findNodes({ project, kind: 'route', limit: 100 });
                    if (routeResult.total > 0) {
                        lines.push(`  Routes: ${routeResult.total}`);
                        for (const r of routeResult.results.slice(0, 5)) {
                            lines.push(`    ${r.node.name} (${r.node.filePath}:${r.node.startLine})`);
                        }
                        if (routeResult.total > 5) lines.push(`    ... +${routeResult.total - 5} more`);
                    }

                    lines.push('');

                    // 架构摘要
                    try {
                        const archResult = this.graphToolHandlers.handleGetArchitecture({ project });
                        const archText = archResult.content[0]?.text || '';
                        lines.push('## Architecture');
                        lines.push(archText);
                    } catch (e: any) {
                        lines.push(`Architecture analysis failed: ${e.message}`);
                    }
                } catch (e: any) {
                    lines.push('## Graph Index (SQLite)');
                    lines.push(`Error: ${e.message}`);
                }
            }

            return { content: [{ type: 'text', text: lines.join('\n') }] };
        } catch (error: any) {
            return { content: [{ type: 'text', text: `Error getting status: ${error.message || error}` }], isError: true };
        }
    }

    // ── 内部：图自动构建 + 富化 ─────────────────────────────────────

    /**
     * 已链接的仓库若本地图为空，触发后台全量建图。
     * 每会话每项目只触发一次，避免重复。
     */
    private maybeAutoBuildGraphIndex(codebasePath: string): void {
        if (!this.graphToolHandlers) return;

        let project: string;
        try {
            project = getRepoIdentity(codebasePath);
        } catch {
            return;
        }

        if (this.autoGraphBuildTriggered.has(project)) return;
        if (this.graphToolHandlers.getIndexingProgress(project)) return;

        let stats: { nodes: number; edges: number };
        try {
            stats = this.graphToolHandlers.getStore().getProjectStats(project);
        } catch {
            return;
        }

        // 图为空 → 全量建；图过时（索引器版本升级）→ 强制全量重建
        const outdated = stats.nodes > 0 && this.isGraphOutdated(codebasePath);
        if (stats.nodes > 0 && !outdated) return;

        this.autoGraphBuildTriggered.add(project);
        const reason = stats.nodes === 0 ? 'empty' : 'outdated indexer';
        console.log(`[GRAPH-AUTO] Local graph ${reason} for '${project}', building in background...`);
        setImmediate(async () => {
            try {
                await this.graphToolHandlers!.handleIndexRepository({
                    repo_path: codebasePath,
                    mode: 'full',
                    force: outdated,
                });
                console.log(`[GRAPH-AUTO] Background graph build complete for '${project}'`);
            } catch (e: any) {
                console.warn(`[GRAPH-AUTO] Background graph build failed for '${project}': ${e?.message || e}`);
            }
        });
    }

    /** 图是否由旧版索引器构建（需重建）。无版本戳或版本落后即视为过时。 */
    private isGraphOutdated(_codebasePath: string): boolean {
        try {
            // 复用 getStore() 的现有 SQLite 连接（不为每次检查新开连接）。
            // 注意：mcp 是 ESM，不能用 require() —— 之前 require 写法在 ESM 下
            // 抛 ReferenceError 被 catch 吞掉，导致版本检测永远返回 false。
            return this.graphToolHandlers!.getStore().getGraphVersion() < INDEXER_VERSION;
        } catch {
            return false;
        }
    }

    /**
     * 图索引实时性保障：Merkle 变更检测（~每 8s 每项目至多一次），发现文件变更
     * 即后台增量重建图。向量索引按设计不实时（仅保护分支每日全量/增量），
     * 但图必须反映当前工作区代码 —— 用户改完代码后 search 应立即能看到新符号。
     * 由 CLAUDE_CONTEXT_GRAPH_REALTIME 控制（默认 true）。
     */
    private maybeIncrementalGraphSync(codebasePath: string): void {
        if ((process.env.CLAUDE_CONTEXT_GRAPH_REALTIME || 'true') === 'false') return;
        if (!this.graphToolHandlers) return;

        let project: string;
        try {
            project = getRepoIdentity(codebasePath);
        } catch {
            return;
        }

        // 节流：每项目 8s 内至多检测一次，避免高频 search 触发重复 Merkle 扫描。
        const now = Date.now();
        const last = this.lastGraphSyncCheck.get(project) || 0;
        if (now - last < 8000) return;
        this.lastGraphSyncCheck.set(project, now);

        // 图已在构建/增量中则跳过。
        if (this.graphToolHandlers.getIndexingProgress(project)) return;

        let stats: { nodes: number };
        try {
            this.graphToolHandlers.setProject(codebasePath);
            stats = this.graphToolHandlers.getStore().getProjectStats(project);
        } catch {
            return;
        }
        if (stats.nodes === 0) return;   // 空图由 maybeAutoBuildGraphIndex 全量处理

        setImmediate(async () => {
            try {
                const det = this.graphToolHandlers!.detectChangedFiles({ project });
                if (!det || det.changedFiles.length === 0) return;
                console.log(`[GRAPH-SYNC] ${det.changedFiles.length} file(s) changed for '${project}', incremental re-index`);
                await this.graphToolHandlers!.handleIndexRepository({
                    repo_path: codebasePath,
                    mode: 'incremental',
                    files: det.changedFiles,
                });
                console.log(`[GRAPH-SYNC] Incremental re-index complete for '${project}'`);
            } catch (e: any) {
                console.warn(`[GRAPH-SYNC] Incremental re-index failed for '${project}': ${e?.message || e}`);
            }
        });
    }

    private enrichWithGraphContextDeep(
        searchResults: any[],
        codebasePath: string,
        query: string,
    ): string {
        const store = this.graphToolHandlers!.getStore();
        const traverser = this.graphToolHandlers!.getTraverser();
        const project = getRepoIdentity(codebasePath);
        const lines: string[] = [];
        const seenSymbols = new Set<string>();

        const queryWords = query.toLowerCase().split(/[\s_\-.,:;!?/\\()\[\]{}]+/).filter((w: string) => w.length > 1);
        // 测试文件降权/排除（富化阶段）：tests/、test_*.py、*_test.go 等
        const isTestPath = (p: string) => /(^|\/)(tests?|__tests__|spec)\//i.test(p) || /(^|\/)(test_[^/]*|[^/]*_test|[^/]*\.(test|spec))\.[a-z]+$/i.test(p);
        // 相关性：词边界匹配（含驼峰/下划线切分），避免裸子串把 `get` 误判命中 `__getitem__`。
        const nameTokens = (name: string): string[] =>
            name.toLowerCase().split(/[^a-z0-9]+|(?<=[a-z0-9])(?=[A-Z])/).filter(Boolean);
        const relevant = (name: string): boolean => {
            if (queryWords.length === 0) return true;
            const toks = new Set(nameTokens(name));
            return queryWords.some(w => toks.has(w));
        };

        const allNodeIds = new Set<number>();
        const fileNodes: Array<{ node: any; filePath: string }> = [];
        const seenNodeIds = new Set<number>();

        // ① 主源：图符号命中（findNodes）——调用链应围绕"用户实际找的符号"展开，
        //    而不是只围绕向量 top5 文件。这正是此前 send/get_adapter 被富化丢弃的根因。
        const graphHitNodes: any[] = [];
        try {
            const gr = store.findNodes({ project, query, limit: 12 });
            for (const r of gr.results) {
                const n = r.node;
                if (n.kind !== 'function' && n.kind !== 'method' && n.kind !== 'class') continue;
                if (isTestPath(n.filePath)) continue;
                graphHitNodes.push(n);
                if (!seenNodeIds.has(n.id)) {
                    seenNodeIds.add(n.id);
                    fileNodes.push({ node: n, filePath: n.filePath });
                    allNodeIds.add(n.id);
                }
            }
        } catch { /* graph symbols optional */ }

        // ② 辅源：向量命中文件里的相关符号（补充图符号未覆盖、但向量认为相关的文件）。
        const maxFiles = 5;
        const perFileLimit = 12;
        const seenFiles = new Set<string>();
        for (const result of searchResults.slice(0, maxFiles)) {
            seenFiles.add(result.relativePath);
        }
        for (const filePath of seenFiles) {
            const normalizedPath = filePath.replace(/^\/+/, '');
            if (isTestPath(normalizedPath)) continue;
            const nodeResult = store.findNodes({ project, exactFilePath: normalizedPath, limit: perFileLimit });
            for (const r of nodeResult.results) {
                const kind = r.node.kind;
                if (kind !== 'function' && kind !== 'method' && kind !== 'class') continue;
                if (!relevant(r.node.name)) continue;
                if (seenNodeIds.has(r.node.id)) continue;
                seenNodeIds.add(r.node.id);
                fileNodes.push({ node: r.node, filePath: normalizedPath });
                allNodeIds.add(r.node.id);
            }
        }

        if (fileNodes.length === 0) return '';

        const nodeIdsArr = fileNodes.map(f => f.node.id);
        // 调用关系只取真 CALLS 边：不传 kind 会把 contains/imports 边也拉进来，
        // 导致 callee 列表出现模块/属性噪声（之前实测 "→ num, name, raw" 的来源）。
        const allCallerEdges = store.getEdgesByTargetBatch(nodeIdsArr, 'calls');
        const allCalleeEdges = store.getEdgesBySourceBatch(nodeIdsArr, 'calls');

        for (const { node } of fileNodes) {
            for (const e of allCallerEdges.get(node.id) || []) allNodeIds.add(e.sourceId);
            for (const e of allCalleeEdges.get(node.id) || []) allNodeIds.add(e.targetId);
        }

        const nodeMap = store.getNodesById(Array.from(allNodeIds));

        const directRelations: string[] = [];
        for (const { node } of fileNodes) {
            const key = node.qualifiedName;
            if (seenSymbols.has(key)) continue;
            seenSymbols.add(key);

            const callerEdges = allCallerEdges.get(node.id) || [];
            const calleeEdges = allCalleeEdges.get(node.id) || [];

            if (callerEdges.length === 0 && calleeEdges.length === 0) continue;

            // 去噪：自指调用（`app ← app`）、同名互调、测试文件调用者；并按名去重。
            const isTestP = (p: string) => /(^|\/)(tests?|__tests__|spec)\//i.test(p) || /(^|\/)(test_[^/]*|[^/]*_test|[^/]*\.(test|spec))\.[a-z]+$/i.test(p);
            const pick = (edges: any[], getId: (e: any) => number, isCaller: boolean): string[] => {
                const seen = new Set<string>();
                const out: string[] = [];
                for (const e of edges) {
                    const c = nodeMap.get(getId(e));
                    if (!c || c.id === node.id || c.name === node.name) continue;
                    if (isCaller && isTestP(c.filePath)) continue;   // 测试调用者噪声大，隐藏
                    if (seen.has(c.name)) continue;
                    seen.add(c.name);
                    out.push(`\`${c.name}\``);
                    if (out.length >= 3) break;
                }
                return out;
            };
            const callerFiltered = pick(callerEdges, (e) => e.sourceId, true);
            const calleeFiltered = pick(calleeEdges, (e) => e.targetId, false);

            // 签名折叠为单行（多行签名会把调用链撑成几十行）。
            const sig = node.signature ? String(node.signature).replace(/\s+/g, ' ').trim() : '';
            let line = `\`${node.name}\``;
            if (sig) line += sig;
            if (callerFiltered.length > 0) line += ` ← ${callerFiltered.join(', ')}`;
            if (calleeFiltered.length > 0) line += ` → ${calleeFiltered.join(', ')}`;
            line += `  (${node.filePath}:${node.startLine})`;
            directRelations.push(line);
        }

        if (directRelations.length > 0) {
            lines.push('### Call Graph');
            lines.push(...directRelations.slice(0, 15).map(l => `- ${l}`));
            if (directRelations.length > 15) {
                lines.push(`- ... and ${directRelations.length - 15} more`);
            }
            lines.push('');
        }

        const topNodes = fileNodes.slice(0, 3);
        const impactEntries: string[] = [];
        for (const { node } of topNodes) {
            try {
                const impact = traverser.getImpactRadius(node.id, 2);
                if (impact.nodes.size > 1) {
                    const impactedNames = Array.from(impact.nodes.values())
                        .filter(n => n.id !== node.id)
                        .slice(0, 5)
                        .map(n => `\`${n.name}\``);
                    if (impactedNames.length > 0) {
                        impactEntries.push(`- \`${node.name}\` impacts: ${impactedNames.join(', ')}`);
                    }
                }
            } catch { /* non-critical */ }
        }
        if (impactEntries.length > 0) {
            lines.push('### Change Impact');
            lines.push(...impactEntries);
            lines.push('');
        }

        if (!this.architectureEmitted.has(project)) {
            try {
                const archResult = this.graphToolHandlers!.handleGetArchitecture({ project });
                const archText = archResult.content[0]?.text || '';
                const archLines = archText.split('\n');
                const summary: string[] = [];
                let inEntry = false, entryCount = 0;
                for (const line of archLines) {
                    if (line.startsWith('Entry points')) { inEntry = true; summary.push(line); continue; }
                    if (inEntry && line.startsWith('  -') && entryCount < 5) { summary.push(line); entryCount++; continue; }
                    if (inEntry && !line.startsWith('  -')) inEntry = false;
                }
                if (summary.length > 0) {
                    lines.push('### Architecture');
                    lines.push(...summary);
                    lines.push('');
                }
                this.architectureEmitted.add(project);
            } catch { /* ignore */ }
        }

        return lines.length > 0 ? '\n' + lines.join('\n') : '';
    }
}
