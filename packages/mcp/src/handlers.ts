import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import {
    Context,
    COLLECTION_LIMIT_MESSAGE,
    getRepoIdentity,
    normalizeGitUrl,
    getRemoteUrl,
    getCurrentBranch,
    envManager,
} from "@seeway/claude-context-core";
import { resolveCodebasePath, focusSnippet, trackCodebasePath } from "./utils.js";
import type { GraphToolHandlers } from "./graph-handlers.js";
import { INDEXER_VERSION, detectVendorSegments, isTestPath as isTestFilePath, GENERATED_FILE_RE } from "@seeway/claude-context-graph";
import { linkState, LinkInfo } from "./link-state.js";

/**
 * ToolHandlers — MCP 工具处理器（重构版）。
 *
 * 与旧版本的区别：
 *  - 本地不再做向量索引。向量数据全部在云端 git-index-service 预先建好。
 *  - 本地只做两件事：link（绑定云端 collection） + search（直连云端 Milvus + 本地图富化）。
 *  - 本地图索引仍然按需构建（SQLite），与云端向量索引并行工作。
 */
/**
 * `Owner::name` when the symbol belongs to a type, else the bare name.
 *
 * `::` rather than `.` because every language whose grammar nests methods this
 * way here (C++, C#) writes it that way, and it reads as one copy-pasteable
 * symbol.
 */
function symbolLabel(s: { name: string; owner?: string }): string {
    return s.owner && s.owner !== s.name ? `${s.owner}::${s.name}` : s.name;
}

/**
 * 关系型提问的形态。命中就走 `graph`：这类问题的答案是调用链和位置，
 * 向量片段一条都用不上，却要占掉整次响应约 85% 的 token。
 */
const RELATION_QUERY_RE: RegExp[] = [
    /\b(who|what|which)\s+\w*\s*(calls?|uses?|invokes?|references?|reads?|writes?|depends)/i,
    /\bcallers?\s+(of|for)\b/i,
    /\bcall(ed|ers|ees)?\s+(by|graph|chain|hierarchy|path|tree|site)/i,
    /\bcall\s*(graph|chain|path|hierarchy)\b/i,
    /\bimpact\s+(of|radius|analysis)\b/i,
    /\b(affected|impacted|broken)\s+(by|if)\b/i,
    /\bwhat\s+(breaks|else\s+changes)\b/i,
    /\b(dead|unused|unreachable|orphan)\s+(code|functions?|symbols?)\b/i,
    /\bentry\s*-?\s*points?\b/i,
    /\b(implementations?|implementors?|subclasses|subtypes|overrides?)\s+of\b/i,
    /\b(who|what)\s+(implements?|extends?|overrides?|subclasses)\b/i,
    /\bdependen(ts|cies)\s+of\b/i,
    /\bwhere\s+is\s+\w+\s+(defined|declared|implemented)\b/i,
    /\bif\s+I\s+(change|rename|remove|delete)\b/i,
    /谁(在)?(调用|使用|引用|实现|继承|覆盖)/,
    /调用(链|图|者|方|路径|关系)/,
    /影响(面|范围|了谁|哪些)/,
    /(死|无用|未使用)代码/,
    /入口(点|函数)/,
    /(子类|实现类|派生类|基类)(有哪些|是谁|列表)?/,
    /(改|修改|删除|重命名).{0,8}(影响|波及)/,
    /在哪(里)?(定义|声明|实现)/,
];

/** 自适应选 graph 后，图命中少于这个数就在同一次调用里补向量段。 */
const AUTO_UPGRADE_MIN_HITS = 3;

const ARCH_INTENT = /(architect|overview|structure|module|layout|entry\s*-?\s*point|entrypoint|entry|startup|start\s*up|bootstrap|main\s*function|top\s*level|dead\s*code|call\s*flow|架构|结构|总览|概览|入口|启动|模块划分|死代码)/i;

function wantsArchitecture(query: string): boolean {
    return ARCH_INTENT.test(query || '');
}

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
    private repoSizeCache: Map<string, { files: number; own: number; at: number }> = new Map();

    /**
     * 仓库规模分档（缓存 5min）：用 git ls-files 计数，但**按自有文件数**分档 ——
     * 上游库和生成代码不构成"agent 要理解的代码量"。
     *
     * 分档同时给出噪声占比，因为噪声本身就是 search 的价值来源：PhiLog 223 个文件
     * 里 111 个是拷进来的 spdlog，按总数它是"小库、grep 更省"，可实际上 grep 一个
     * 概念词会被 spdlog 淹没 —— 实测 search 在这个仓库上 100% 召回。反过来 ap-client-api
     * 1360 个文件里 881 个是 parasoft 生成的桩，规模看着大，自有代码只有 479。
     * 两个方向的失真都会把 agent 引到错的第一跳上。
     */
    private getRepoSizeTier(codebasePath: string): string {
        const cached = this.repoSizeCache.get(codebasePath);
        if (cached && Date.now() - cached.at < 300_000) return this.formatSizeTier(cached.files, cached.own);
        let files = 0;
        let own = 0;
        try {
            const out = execSync('git ls-files', { cwd: codebasePath, encoding: 'utf-8', timeout: 8000 });
            const list = out.trim() ? out.trim().split('\n') : [];
            files = list.length;
            const segs = new Set(detectVendorSegments(codebasePath).map(s => s.toLowerCase()));
            own = list.filter(p =>
                !GENERATED_FILE_RE.test(p) && !p.split('/').some(s => segs.has(s.toLowerCase())),
            ).length;
        } catch { /* non-git */ }
        this.repoSizeCache.set(codebasePath, { files, own, at: Date.now() });
        return this.formatSizeTier(files, own);
    }

    private formatSizeTier(files: number, own: number): string {
        if (files <= 0) return '';
        const tier = own < 300 ? 'small' : own < 2000 ? 'medium' : 'large';
        const noiseRatio = 1 - own / files;
        const hint = noiseRatio >= 0.3
            ? ` — ${Math.round(noiseRatio * 100)}% vendored/generated, grep gets drowned here`
            : own < 300 ? ' — grep/read likely cheaper'
                : own >= 2000 ? ' — search favored' : '';
        return `[repo: ${own}/${files} own files, ${tier}${hint}]`;
    }

    /**
     * 调用方没点名 mode 时按查询形态选一个。
     *
     * 之前默认一律 `both`，于是关系型问题（"谁调用 X"、"改 Y 影响谁"）也要付向量段的
     * ~2300 token —— 而实测那类问题 `graph` 单独就 23/23，向量片段一条都用不上。
     * 反过来，纯语义描述走 graph 会拿到位置但没有代码，agent 还得再 Read 一次。
     * 所以这里只做形态判别，不做"值不值得搜"的判断：后者是 agent 拿着规模提示自己定的事。
     *
     * 显式传了 mode 就一概不干预 —— 调用方点名要什么就给什么。
     */
    private pickMode(query: string): 'graph' | 'both' {
        const q = query.trim();
        if (RELATION_QUERY_RE.some(re => re.test(q))) return 'graph';
        // 单个标识符（含 `A::b` / `a.b` 限定名）：要的是"它在哪"，不是语义近邻。
        // `$` 是 JS/TS 的合法标识符字符，不带上它 `$scope` 这类查询会白付向量段的钱。
        if (!/\s/.test(q) && q.length >= 3 && /^[A-Za-z_$][A-Za-z0-9_$]*([:.]{1,2}[A-Za-z_$][A-Za-z0-9_$]*)*$/.test(q)) {
            return 'graph';
        }
        return 'both';
    }
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
    private getSearchTuning(): {
        defaultLimit: number;
        threshold: number;
        snippetMaxChars: number;
        totalMaxChars: number;
        scoreRatio: number;
    } {
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
            // 8000 是实测的召回悬崖之上一档：ap-client-api + PhiLog 两个仓库 31 个期望符号，
            // 20000→8000 召回一条不掉（both 94%/100%、vector 88%/100%）而 both 均值 3.1k→2.1k token
            // （−33%）；6000 时 ap 开始掉（both 94%→88%，vector 88%→81%）。别再往下调。
            totalMaxChars: Math.max(2000, num('SEARCH_TOTAL_MAX_CHARS', 8000)),
            scoreRatio: Math.max(0, Math.min(1, num('SEARCH_SCORE_RATIO', 0))),
        };
    }

    /**
     * Per-snippet character allowance for one response.
     *
     * The per-snippet cap alone bounds nothing that matters: ten hits of 4,000
     * chars is a 10k-char answer, and a search over a repo with long functions
     * really did come back at ~5,900 tokens — more than the file it was meant to
     * save reading. Dividing a whole-response budget across the hits keeps a
     * small result set at full length (2 hits still get 4,000 chars each) and
     * only tightens when the count is what makes the answer big. The floor
     * matters more than the budget: a snippet cut below it stops being readable
     * code, and at that point the caller is better served by fewer, whole hits.
     */
    private snippetBudget(resultCount: number, tuning: { snippetMaxChars: number; totalMaxChars: number }): number {
        if (resultCount <= 1) return tuning.snippetMaxChars;
        const share = Math.floor(tuning.totalMaxChars / resultCount);
        return Math.max(600, Math.min(tuning.snippetMaxChars, share));
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

            // 验证云端 collection 存在。
            // 连不上 Milvus 与"这个分支没被索引过"是两种完全不同的故障，处置手段也不同
            // （查网络/服务 vs 换分支或去控制台加索引）。以前 catch(() => false) 把前者
            // 报成后者，用户会照着提示去挨个换分支试，而问题其实在连不上。
            const vdb = this.context.getVectorDatabase();
            let exists = false;
            let probeError: string | null = null;
            try {
                exists = await vdb.hasCollection(collectionName);
            } catch (e: any) {
                probeError = e?.message || String(e);
            }
            if (probeError) {
                return {
                    content: [{
                        type: 'text',
                        text: `Error: Could not reach the cloud vector database to verify '${identity}'.\n` +
                            `  Collection: ${collectionName}\n` +
                            `  Reason: ${probeError}\n` +
                            `Check MILVUS_ADDRESS / network connectivity, then re-run link.`,
                    }],
                    isError: true,
                };
            }
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

            // 验证 collection 已加载到内存（UNLOADED → 无法搜索，告知用户去 PhiGent Load）。
            if (vdb.isCollectionLoaded) {
                let loaded = false;
                try {
                    loaded = await vdb.isCollectionLoaded(collectionName);
                } catch (e: any) {
                    // getLoadState 偶发失败（网络瞬断等）不应阻断 link —— 搜索链路会
                    // 在首次 search 时自动 load。这里只做友好提示。
                    console.warn(`[LINK] Could not check load state for '${collectionName}': ${e?.message || e}`);
                    loaded = true; // proceed
                }
                if (!loaded) {
                    return {
                        content: [{
                            type: 'text',
                            text: `Error: Collection '${collectionName}' for '${identity}' is not loaded into Milvus memory.\n` +
                                `Please load it via the PhiGent console first:\n` +
                                `  1. Open PhiGent → Collections\n` +
                                `  2. Find "${collectionName}" (${identity})\n` +
                                `  3. Click Load\n` +
                                `Then re-run link.`,
                        }],
                        isError: true,
                    };
                }
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
                const stats = this.graphToolHandlers.getStore(absolutePath).getProjectStats(graphProject);
                const alreadyGraphIndexed = stats.nodes > 0;

                // 与 maybeAutoBuildGraphIndex 共用一个去重 Set，避免 link + 后续 search
                // 各触发一次后台建图。失败时移除，允许后续重试（之前失败后永不重试）。
                if (!this.autoGraphBuildTriggered.has(graphProject)) {
                    this.autoGraphBuildTriggered.add(graphProject);
                    setImmediate(async () => {
                        try {
                            if (alreadyGraphIndexed) {
                                // 增量更新
                                let changedFiles: string[] = [];
                                try {
                                    const detectResult = this.graphToolHandlers!.detectChangedFiles({ project: graphProject, repoPath: absolutePath });
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
                            // 失败移除标记，允许下次 search/link 重试
                            this.autoGraphBuildTriggered.delete(graphProject);
                            console.warn(`[LINK] Background graph build failed for '${graphProject}': ${e?.message || e}`);
                        }
                    });
                }

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
        const { path: codebasePath = ".", query, limit, extensionFilter, mode, enrich, style, docs, tests, vendor } = args;
        const explicitMode: 'vector' | 'graph' | 'both' | null =
            (mode === 'graph' || mode === 'vector' || mode === 'both') ? mode : null;
        const autoPicked = explicitMode === null;
        let searchMode: 'vector' | 'graph' | 'both' = explicitMode ?? this.pickMode(query || '');
        let autoNote = '';
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

            // docs:true / tests:true / vendor:true → 本次查询不做对应降权。
            // 显式入参而不是写 process.env：全局态传单次参数会让并发的两次 search 互相污染，
            // 也会压掉用户 .env 里配的真实值。
            // vendorSegments 得等 absolutePath 定下来才能探测（约定名 + submodule + 根许可证）。
            const vendorSegments = vendor === true ? [] : detectVendorSegments(absolutePath);
            const ranking = {
                ...(docs === true ? { docPenalty: 0 } : {}),
                ...(tests === true ? { testPenalty: 0 } : {}),
                vendorSegments,
            };
            // 图侧要用同一套降权：vector 侧一直有测试降权、图侧之前没有，于是同一次 `both`
            // 里向量结果干净、图符号块被测试刷屏（实测 flask+requests：top10 测试行 56%→21%）。
            const graphRanking = { vendorSegments, ...(tests === true ? { testPenalty: 0 } : {}) };

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
                    const stats = this.graphToolHandlers.getStore(absolutePath).getProjectStats(project);
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
            let graphSymbols: Array<{ name: string; kind: string; owner?: string; filePath: string; line: number; inDegree: number; outDegree: number }> = [];
            let searchSourceNote = link ? ` (cloud: ${link.branch})` : ' (graph-only)';

            let vectorError: string | null = null;
            const runVectorSearch = async () => {
                    try {
                        const searchResults = await this.context.searchWithLayers(
                            layers, query, Math.min(resultLimit, 50), tuning.threshold, filterExpr, ranking,
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
                    } catch (e: any) {
                        // 向量失败不能拖垮图结果 —— 记录错误，继续返回图部分
                        vectorError = e?.message || String(e);
                        console.warn(`[SEARCH] Vector search failed (falling back to graph-only): ${vectorError}`);
                    }
            };
            const vectorPromise = (searchMode !== 'graph' && layers.length > 0)
                ? runVectorSearch()
                : Promise.resolve();

            const graphPromise = (searchMode !== 'vector' && this.graphToolHandlers)
                ? (async () => {
                    try {
                        // 显式按路径取 store：并发搜两个仓库时，"当前项目"指针会被对方改掉。
                        const store = this.graphToolHandlers!.getStore(absolutePath);
                        const gr = store.findNodes({
                            project, query, limit: Math.min(resultLimit, 10), ...graphRanking,
                        });
                        if (gr.results.length > 0) {
                            // Owning type, from the CONTAINS edge that already exists.
                            // Without it a hit reads `method CreateProxy` twice over
                            // (declaration + definition) with nothing to say one is
                            // ProxyFactory's — the single most common C++ shape, and the
                            // thing that tells overloads apart. Two batched queries.
                            const ids = gr.results.map(r => r.node.id);
                            const owners = new Map<number, string>();
                            try {
                                const containsEdges = store.getEdgesByTargetBatch(ids, 'contains');
                                const parentIds = [...new Set(
                                    [...containsEdges.values()].flat().map(e => e.sourceId),
                                )];
                                const parents = store.getNodesById(parentIds);
                                for (const [childId, edges] of containsEdges) {
                                    for (const e of edges) {
                                        const p = parents.get(e.sourceId);
                                        // `file` containers repeat the path already printed.
                                        if (p && p.kind !== 'file' && p.kind !== 'module') {
                                            owners.set(childId, p.name);
                                            break;
                                        }
                                    }
                                }
                            } catch { /* owner is decoration — never fail the search for it */ }

                            graphSymbols = gr.results.map(r => ({
                                name: r.node.name,
                                kind: r.node.kind,
                                owner: owners.get(r.node.id),
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

            // 自适应选了 graph 但图没给出足够答案 → 本次调用内补向量段，而不是让 agent
            // 空手而归再问一遍。猜错的代价必须留在服务端：一次白跑的 search 比多花的
            // 2000 token 更贵（agent 还要多一轮往返）。显式传 mode 的调用不做这件事。
            if (autoPicked && searchMode === 'graph' && graphSymbols.length < AUTO_UPGRADE_MIN_HITS && layers.length > 0) {
                await runVectorSearch();
                if (vectorResults.length > 0) {
                    searchMode = 'both';
                    autoNote = ' [auto: graph→both, thin graph hits]';
                }
            } else if (autoPicked && searchMode === 'graph') {
                autoNote = ' [auto: graph]';
            }

            const doEnrich = searchMode === 'both' && enrich !== false;

            // ── 无结果 ──
            if (vectorResults.length === 0 && graphSymbols.length === 0) {
                let noMsg = `No results for "${query}" in '${absolutePath}'${searchSourceNote}`;
                if (vectorError) noMsg += `\nVector search error: ${vectorError}`;
                if (!link) noMsg += `\nTip: run link to enable cloud vector search.`;
                return { content: [{ type: 'text', text: noMsg }] };
            }

            // ── 格式化结果 ──
            const parts: string[] = [];
            const linkHeader = link
                ? `[linked: ${link.remoteUrl}@${link.branch}]`
                : `[not linked — graph-only]`;
            // 仓库规模分档：让 agent 判断 search 是否划算（小库 grep/read 更省）。
            const sizeTier = this.getRepoSizeTier(absolutePath);
            parts.push(`${linkHeader} ${sizeTier}${autoNote}`);
            if (vectorError) {
                parts.push(`[vector search failed: ${vectorError} — showing graph-only results]`);
            }

            if (vectorResults.length > 0) {
                const modeTag = searchMode === 'both' && graphSymbols.length > 0 ? ' vector+graph' : '';
                parts.push(`${vectorResults.length}${modeTag} hits for "${query}"${searchSourceNote}`);

                const perSnippetChars = this.snippetBudget(vectorResults.length, tuning);
                for (let i = 0; i < vectorResults.length; i++) {
                    const r = vectorResults[i];
                    const loc = `${r.relativePath}:${r.startLine}-${r.endLine}`;
                    if (compactStyle) {
                        const graphMatch = graphSymbols.filter(s => s.filePath === r.relativePath);
                        const graphNote = graphMatch.length > 0 ? ` [graph: ${graphMatch.map(s => s.name).join(', ')}]` : '';
                        parts.push(`[${i + 1}] ${loc} ${r.language} s=${Number(r.score || 0).toFixed(5)}${graphNote}`);
                    } else {
                        const code = focusSnippet(r.content, perSnippetChars, query);
                        const graphMatch = graphSymbols.filter(s =>
                            s.filePath === r.relativePath &&
                            s.line >= r.startLine &&
                            s.line <= r.endLine
                        );
                        const graphNote = graphMatch.length > 0
                            ? `  graph: ${graphMatch.map(s => `${s.kind} \`${symbolLabel(s)}\` (↖${s.inDegree} ↗${s.outDegree})`).join(' | ')}\n`
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
                // graph 模式下这一块就是全部答案，截到 5 条等于把已经算完、过滤完、
                // 去重完的后半页扔掉：实测 "daily file sink filename calculator" 的
                // 正确答案排在第 8、9 名，被 "... and 5 more" 吞了，端到端召回因此
                // 从 100% 掉到 65%。补齐 5 行约 60 token，graph 仍是 both 的 1/6。
                // both 模式保留 5 条上限 —— 那里向量片段才是主体，符号块是补充。
                const symbolCap = searchMode === 'graph' ? unmatchedSymbols.length : 5;
                for (const s of unmatchedSymbols.slice(0, symbolCap)) {
                    parts.push(`- ${s.kind} \`${symbolLabel(s)}\` (${s.filePath}:${s.line}) ↖${s.inDegree} ↗${s.outDegree}`);
                }
                if (unmatchedSymbols.length > symbolCap) {
                    parts.push(`- ... and ${unmatchedSymbols.length - symbolCap} more`);
                }
            }

            let resultMessage = parts.join('\n');

            // ── 图富化 ──
            // both 模式：向量命中文件 + 图符号一起富化；graph 模式（无向量结果）：
            // 调用链往往比裸符号清单更有用（impact/flow 场景），同样产出富化。
            const wantEnrich = doEnrich || (searchMode === 'graph' && graphSymbols.length > 0);
            if (wantEnrich && this.graphToolHandlers) {
                try {
                    const enrich = this.enrichWithGraphContextDeep(
                        vectorResults.slice(0, 5), absolutePath, query, graphRanking,
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
            let graphError: string | null = null;

            // 清链接状态
            if (linkState.delete(absolutePath)) {
                cleared.push('link');
            }

            // 清本地图
            if (this.graphToolHandlers) {
                const project = (() => { try { return getRepoIdentity(absolutePath); } catch { return absolutePath; } })();
                // 先切当前项目，再按同一路径取 store —— 顺序反了会拿到别的仓库（或已淘汰）的连接，
                // 于是 deleteProject 在错误的库上执行，报"已清除"而目标图一行未动。
                this.graphToolHandlers.setProject(absolutePath);
                const store = this.graphToolHandlers.getStore(absolutePath);
                try {
                    store.beginTransaction();
                    store.deleteProject(project);
                    store.commitTransaction();
                    cleared.push('graph');
                    console.log(`[CLEAR] Cleared graph index for: ${project}`);
                } catch (e: any) {
                    // 事务失败必须 rollback，否则连接一直处于打开事务状态被锁死
                    try { store.rollbackTransaction(); } catch { /* ignore */ }
                    graphError = e?.message || String(e);
                    console.warn(`[CLEAR] Failed to clear graph index for '${project}': ${graphError}`);
                }
            }

            // 清图失败必须报错返回：以前失败被咽掉，用户看到的是"Nothing to clear"，
            // 会以为图已经干净了，实际上脏图还在，重建也不会发生。
            if (graphError) {
                return {
                    content: [{
                        type: 'text',
                        text: `Failed to clear graph index for '${absolutePath}': ${graphError}` +
                            (cleared.length > 0 ? `\n(cleared: ${cleared.join(', ')})` : ''),
                    }],
                    isError: true,
                };
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
                    const store = this.graphToolHandlers.getStore(absolutePath);
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
                        const archResult = this.graphToolHandlers.handleGetArchitecture({ project, repo_path: absolutePath });
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
            // 显式按仓库路径取 store。以前这里用无参 getStore()，在 setProject 之前执行 ——
            // 拿的是上一个仓库的库，本仓库的图被读成 0 节点，于是每次都判定"图为空"走全量重建。
            stats = this.graphToolHandlers.getStore(codebasePath).getProjectStats(project);
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
                // 失败移除标记，允许下次 search/status 重试（之前失败后标记残留，永不重试）
                this.autoGraphBuildTriggered.delete(project);
                console.warn(`[GRAPH-AUTO] Background graph build failed for '${project}': ${e?.message || e}`);
            }
        });
    }

    /** 图是否由旧版索引器构建（需重建）。无版本戳或版本落后即视为过时。 */
    private isGraphOutdated(codebasePath: string): boolean {
        try {
            // 复用该仓库已打开的 SQLite 连接（不为每次检查新开连接）。
            // 注意：mcp 是 ESM，不能用 require() —— 之前 require 写法在 ESM 下
            // 抛 ReferenceError 被 catch 吞掉，导致版本检测永远返回 false。
            return this.graphToolHandlers!.getStore(codebasePath).getGraphVersion() < INDEXER_VERSION;
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
            stats = this.graphToolHandlers.getStore(codebasePath).getProjectStats(project);
        } catch {
            return;
        }
        if (stats.nodes === 0) return;   // 空图由 maybeAutoBuildGraphIndex 全量处理

        setImmediate(async () => {
            try {
                const det = this.graphToolHandlers!.detectChangedFiles({ project, repoPath: codebasePath });
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
        graphRanking?: { vendorSegments?: string[]; testPenalty?: number },
    ): string {
        // 调用链富化必须用【本次搜索仓库】的 store：无参取值会跟着"当前项目"跑，
        // 并发搜两个仓库时后到者把指针改掉，前者查到 0 行 —— 整段 Call Graph 静默消失。
        const store = this.graphToolHandlers!.getStore(codebasePath);
        const traverser = this.graphToolHandlers!.getTraverser(codebasePath);
        const project = getRepoIdentity(codebasePath);
        const lines: string[] = [];
        const seenSymbols = new Set<string>();

        const queryWords = query.toLowerCase().split(/[\s_\-.,:;!?/\\()\[\]{}]+/).filter((w: string) => w.length > 1);
        // 富化阶段对测试是**硬排除**（不是降权）：调用链要的是"业务代码怎么串起来"，
        // 测试作为调用者只会告出一堆 `TestFoo → Foo`。但 `tests:true` 明确说要看测试，
        // 那时不能还偷偷排除 —— 判定复用 graph 导出的那份，两侧对"什么算测试"必须一致。
        const skipTests = graphRanking?.testPenalty !== 0;
        const isTestPath = (p: string) => skipTests && isTestFilePath(p);
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
            const gr = store.findNodes({ project, query, limit: 12, ...graphRanking });
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

        // 去噪：自指调用（`app ← app`）、同名互调、测试文件调用者；并按名去重。
        const isTestP = (p: string) => /(^|\/)(tests?|__tests__|spec)\//i.test(p) || /(^|\/)(test_[^/]*|[^/]*_test|[^/]*\.(test|spec))\.[a-z]+$/i.test(p);
        // examples/ 里的调用者答的是"怎么用"，src/ 里的调用者答的才是"谁依赖你"。
        // 只列 3 个时这个区别就是全部信息：flask 的 `add_url_rule ↖43` 原来列出的是
        // examples/tutorial 的 `create_app` 和 `__init__`，而真正触发它的 route 装饰器
        // 被挤进 `+N` —— 等于让边的插入顺序决定 agent 看到哪条依赖。排序而不是过滤：
        // 一个只被示例调用的函数仍然要给出调用者，只是不许它挤掉真实调用方。
        const isDemoP = (p: string) => /(^|\/)(examples?|samples?|demos?|benchmarks?|fixtures?)\//i.test(p);

        const directRelations: string[] = [];
        for (const { node } of fileNodes) {
            const key = node.qualifiedName;
            if (seenSymbols.has(key)) continue;
            seenSymbols.add(key);

            const callerEdges = allCallerEdges.get(node.id) || [];
            const calleeEdges = allCalleeEdges.get(node.id) || [];

            if (callerEdges.length === 0 && calleeEdges.length === 0) continue;

            // 截断必须出声：只列 3 个而 `↖11`，agent 会把这 3 个当成全部调用者去
            // 判影响面。`+N` 给出"还有多少个不同的名字被省了"。
            const pick = (edges: any[], getId: (e: any) => number, isCaller: boolean): { names: string[]; more: number } => {
                const seen = new Set<string>();
                const names: string[] = [];
                const ordered = edges.slice().sort((a, b) =>
                    (isDemoP(nodeMap.get(getId(a))?.filePath || '') ? 1 : 0) -
                    (isDemoP(nodeMap.get(getId(b))?.filePath || '') ? 1 : 0));
                for (const e of ordered) {
                    const c = nodeMap.get(getId(e));
                    if (!c || c.id === node.id || c.name === node.name) continue;
                    if (isCaller && isTestP(c.filePath)) continue;   // 测试调用者噪声大，隐藏
                    if (seen.has(c.name)) continue;
                    seen.add(c.name);
                    if (names.length < 3) names.push(`\`${c.name}\``);
                }
                return { names, more: seen.size - names.length };
            };
            const render = (r: { names: string[]; more: number }): string =>
                r.names.join(', ') + (r.more > 0 ? ` +${r.more}` : '');
            const callerFiltered = pick(callerEdges, (e) => e.sourceId, true);
            const calleeFiltered = pick(calleeEdges, (e) => e.targetId, false);

            // 去噪后可能两头都空（自指、同名重载互调、调用者全在测试里）。
            // 那样的行在 "Call Graph" 里没有调用关系可言，只是把符号清单
            // 又抄了一遍：spdlog 的 `log` 重载让 6 行里有 3 行是这种空行。
            if (callerFiltered.names.length === 0 && calleeFiltered.names.length === 0) continue;

            // 签名折叠为单行（多行签名会把调用链撑成几十行）。
            const sig = node.signature ? String(node.signature).replace(/\s+/g, ' ').trim() : '';
            let line = `\`${node.name}\``;
            if (sig) line += sig;
            if (callerFiltered.names.length > 0) line += ` ← ${render(callerFiltered)}`;
            if (calleeFiltered.names.length > 0) line += ` → ${render(calleeFiltered)}`;
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
                    // 同一条理由：`add_url_rule impacts:` 原来是 3 个 test_* 加一个
                    // examples 的 create_app。测试确实会被波及，但"改这个会影响谁"
                    // 首先要答的是生产代码 —— 5 个名额被测试占满等于没答。
                    const impactedNames = Array.from(impact.nodes.values())
                        .filter(n => n.id !== node.id)
                        .sort((a, b) =>
                            ((isTestP(a.filePath) || isDemoP(a.filePath)) ? 1 : 0) -
                            ((isTestP(b.filePath) || isDemoP(b.filePath)) ? 1 : 0))
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

        // 架构/入口点只在**查询确实在问结构**时给。它不随查询变化，跟具体问题无关时
        // 就是每次固定 100–150 token 的噪声，还会让 agent 顺着无关入口点乱读。
        if (!this.architectureEmitted.has(project) && wantsArchitecture(query)) {
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
