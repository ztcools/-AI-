import { Context } from '@seeway/claude-context-core';
import { RepoManager } from './repo-manager.js';
import { RepoProvider } from './repo-provider.js';
import { ConfigStore } from './config-store.js';
import { RunStore } from './run-store.js';
import { RepoSpec } from './config.js';

export interface RepoIndexResult {
    repo: string;
    branch?: string;
    ok: boolean;
    mode?: string;
    indexedFiles?: number;
    added?: number;
    modified?: number;
    removed?: number;
    error?: string;
}

export interface RepoRunStatus extends RepoIndexResult {
    at: number;
    durationMs: number;
}

export interface CurrentProgress {
    repo: string;
    branch?: string;
    phase: string;
    percentage: number;
}

/** Map key used to track per-branch run status. */
function keyOf(name: string, branch: string): string {
    return `${name}@${branch}`;
}

export interface GitIndexerOptions {
    /** Contexts to hand out to workers — pool size caps how many repos index at once. */
    contexts: Context[];
    repoManager: RepoManager;
    repoProvider: RepoProvider;
    store?: ConfigStore;
    /** Durable per-branch run status. Memory-only when omitted. */
    runStore?: RunStore;
    /** Release each collection from Milvus memory after writing it. */
    releaseAfterIndex?: boolean;
}

/**
 * Orchestrates one indexing pass over all main repositories: fetch each to its
 * branch tip (RepoManager), then let the core Context apply only the git delta
 * with embedding-cache dedup (Context.syncIndexByGit). Main stays authoritative
 * and independent of any developer's local environment.
 *
 * Repositories are processed by a bounded worker pool (one Context each, see
 * config.buildContextPool); the branches *within* one repo stay sequential because
 * they share a checkout directory. Per-branch run status is written through to a
 * RunStore so it survives a restart, and every collection is released from Milvus
 * memory after being written — a pass touches every collection, and keeping them
 * all loaded is what would run the shared server out of RAM.
 */
export class GitIndexer {
    private running = false;
    // In-flight progress per repo. A pass indexes several repos at once, so a
    // single "current" slot would flicker between workers.
    private inFlight: Map<string, CurrentProgress> = new Map();
    // Per-branch last-run status, keyed by `${repoName}@${branch}`.
    private lastRun: Map<string, RepoRunStatus> = new Map();
    private lastPassAt: number | null = null;

    private readonly contexts: Context[];
    private readonly repoManager: RepoManager;
    private readonly repoProvider: RepoProvider;
    private readonly store?: ConfigStore;
    private readonly runStore?: RunStore;
    private readonly releaseAfterIndex: boolean;

    constructor(opts: GitIndexerOptions) {
        this.contexts = opts.contexts.length ? opts.contexts : [];
        if (!this.contexts.length) throw new Error('GitIndexer requires at least one Context');
        this.repoManager = opts.repoManager;
        this.repoProvider = opts.repoProvider;
        this.store = opts.store;
        this.runStore = opts.runStore;
        this.releaseAfterIndex = opts.releaseAfterIndex !== false;

        // Seed from the durable store so the console shows real history right after
        // a restart instead of "never indexed" for everything.
        if (this.runStore) {
            for (const [k, v] of Object.entries(this.runStore.all())) this.lastRun.set(k, v);
        }
    }

    isRunning(): boolean {
        return this.running;
    }

    getLastPassAt(): number | null {
        return this.lastPassAt;
    }

    /** How many repos may index concurrently (= pool size). */
    getConcurrency(): number {
        return this.contexts.length;
    }

    /** All branch statuses for one repo, keyed by branch name. */
    getStatus(name: string): Record<string, RepoRunStatus> {
        const out: Record<string, RepoRunStatus> = {};
        for (const v of this.lastRun.values()) {
            if (v.repo === name && v.branch) out[v.branch] = v;
        }
        return out;
    }

    /**
     * Progress of the repo indexed longest ago in this pass. Kept for the existing
     * `status.current` field so older console builds keep working; `getCurrentAll`
     * is the complete picture.
     */
    getCurrent(): CurrentProgress | null {
        const first = this.inFlight.values().next();
        return first.done ? null : first.value;
    }

    /** Progress of every repo currently being indexed. */
    getCurrentAll(): CurrentProgress[] {
        return Array.from(this.inFlight.values());
    }

    /**
     * Index one specific branch of a repo. All branches of a repo share one
     * checkout directory (RepoManager.dirFor keys on the repo, not the branch), so
     * this must not run concurrently for two branches of the same repo.
     */
    private async indexBranch(ctx: Context, repo: RepoSpec, requestedBranch: string): Promise<RepoIndexResult> {
        const startedAt = this.now();
        const spec: RepoSpec = { ...repo, branch: requestedBranch };
        try {
            this.inFlight.set(repo.name, { repo: repo.name, branch: requestedBranch, phase: '拉取仓库', percentage: 0 });
            const { dir: localPath, branch } = await this.repoManager.ensureCheckout(spec);
            // 保护分支被删除/改名后，ensureCheckout 会静默回落到默认分支(main)。
            // 若继续索引并把结果记到"被请求的保护分支"名下，状态就错乱了（显示
            // dev 已索引，实际是 main）。显式报错，让管理员知道该保护分支已失效。
            if (branch !== requestedBranch && requestedBranch !== repo.branch) {
                throw new Error(
                    `protected branch '${requestedBranch}' not found on remote (fell back to '${branch}'). ` +
                    `Remove it from protectedBranches or fix the branch name.`
                );
            }
            // Persist the branch actually indexed when the main branch fell back to the
            // remote default. Only applies to the canonical main slot, not protected branches.
            if (branch !== spec.branch && requestedBranch === repo.branch) {
                this.store?.setRepoBranch(repo.name, branch);
            }
            const stats = await ctx.syncIndexByGit(localPath, p => {
                this.inFlight.set(repo.name, {
                    repo: repo.name,
                    branch,
                    phase: p.phase,
                    percentage: Math.round(p.percentage),
                });
            });
            const collectionName = ctx.getCollectionName(localPath);
            const vdb = ctx.getVectorDatabase();
            // 刚写入的行还在 growing segment 里，getCollectionStatistics 读不到，
            // PhiGent 控制台的"行数"列会显示 0（看起来像索引失败）。索引完主动 flush
            // 一次，让统计口径立刻对得上。失败只影响行数显示，不影响本轮索引结果。
            await vdb.flush?.(collectionName);
            // 写完就从 query node 内存里放掉：一轮 pass 会碰到每一个 collection，
            // 而 Milvus 只在搜索时才需要它常驻。不放的话几百仓库×多分支会把共享
            // 服务器的内存吃光（实测约 10 KB/行）。搜索侧遇到未加载会自动重载。
            if (this.releaseAfterIndex) await vdb.release?.(collectionName);
            console.log(`[GitIndexer] ✅ ${repo.name} [${branch}] → ${stats.mode} (+${stats.added}/~${stats.modified}/-${stats.removed}, files=${stats.indexedFiles})`);
            const result: RepoIndexResult = {
                repo: repo.name,
                branch,
                ok: true,
                mode: stats.mode,
                indexedFiles: stats.indexedFiles,
                added: stats.added,
                modified: stats.modified,
                removed: stats.removed,
            };
            this.record(repo.name, branch, result, startedAt);
            return result;
        } catch (error: any) {
            const msg = error?.message || String(error);
            console.error(`[GitIndexer] ❌ ${repo.name} [${requestedBranch}] failed: ${msg}`);
            const result: RepoIndexResult = { repo: repo.name, branch: requestedBranch, ok: false, error: msg };
            this.record(repo.name, requestedBranch, result, startedAt);
            return result;
        }
    }

    /** Index main + every configured protected branch for one repo, sequentially. */
    private async indexRepo(ctx: Context, repo: RepoSpec): Promise<RepoIndexResult[]> {
        const branches: string[] = [repo.branch, ...(repo.protectedBranches || [])];
        const results: RepoIndexResult[] = [];
        try {
            for (const b of branches) {
                results.push(await this.indexBranch(ctx, repo, b));
            }
        } finally {
            this.inFlight.delete(repo.name);
        }
        return results;
    }

    /** Index main + every configured protected branch for one repo (single-repo entry point). */
    async indexOne(repo: RepoSpec): Promise<RepoIndexResult[]> {
        return this.indexRepo(this.contexts[0], repo);
    }

    /** Index a single repo by name (management "index now" for one repo). */
    async indexOneByName(name: string): Promise<RepoIndexResult[] | null> {
        const repos = await this.repoProvider.listRepos();
        const repo = repos.find(r => r.name === name);
        if (!repo) return null;
        if (this.running) return [{ repo: name, ok: false, error: 'a pass is already running' }];
        this.running = true;
        try {
            return await this.indexOne(repo);
        } finally {
            this.running = false;
            this.runStore?.flush();
        }
    }

    /** Index a single (repo, branch) pair on demand (management API). */
    async indexOneBranch(name: string, branch: string): Promise<RepoIndexResult | null> {
        const repos = await this.repoProvider.listRepos();
        const repo = repos.find(r => r.name === name);
        if (!repo) return null;
        if (this.running) return { repo: name, branch, ok: false, error: 'a pass is already running' };
        this.running = true;
        try {
            return await this.indexBranch(this.contexts[0], repo, branch);
        } finally {
            this.running = false;
            this.inFlight.delete(name);
            this.runStore?.flush();
        }
    }

    async indexAll(): Promise<RepoIndexResult[]> {
        if (this.running) {
            console.warn('[GitIndexer] Pass already in progress; skipping.');
            return [{ repo: '*', ok: false, error: 'already running' }];
        }
        this.running = true;
        const results: RepoIndexResult[] = [];
        try {
            const repos = await this.repoProvider.listRepos();
            const workers = Math.min(this.contexts.length, Math.max(1, repos.length));
            console.log(`[GitIndexer] 🔄 Starting pass over ${repos.length} repositories (${workers} in parallel)`);

            // Reclaim checkouts of repos that were removed from the config, and the
            // per-branch directories left by the pre-shared-checkout layout.
            this.pruneWorkdir(repos);

            // Bounded worker pool: each worker owns one Context and pulls the next
            // repo off a shared cursor. One repo is never handled by two workers, so
            // the shared per-repo checkout stays safe.
            let cursor = 0;
            const runWorker = async (ctx: Context): Promise<void> => {
                for (;;) {
                    const i = cursor++;
                    if (i >= repos.length) return;
                    results.push(...await this.indexRepo(ctx, repos[i]));
                }
            };
            await Promise.all(this.contexts.slice(0, workers).map(ctx => runWorker(ctx)));

            const ok = results.filter(r => r.ok).length;
            console.log(`[GitIndexer] 🏁 Pass complete: ${ok}/${results.length} branch-indexes succeeded`);
        } finally {
            this.running = false;
            this.inFlight.clear();
            this.lastPassAt = this.now();
            this.runStore?.flush();
        }
        return results;
    }

    /** Drop checkouts and run statuses that no longer belong to a configured repo. */
    private pruneWorkdir(repos: RepoSpec[]): void {
        try {
            const { removed, freedBytes } = this.repoManager.pruneStale(repos);
            if (removed.length) {
                const mb = Math.round(freedBytes / (1024 * 1024));
                console.log(`[GitIndexer] 🧹 Pruned ${removed.length} stale checkout(s), freed ~${mb} MB: ${removed.join(', ')}`);
            }
        } catch (e: any) {
            console.warn(`[GitIndexer] prune failed: ${e?.message || e}`);
        }
        const names = new Set(repos.map(r => r.name));
        for (const [k, v] of this.lastRun.entries()) {
            if (!names.has(v.repo)) this.lastRun.delete(k);
        }
        this.runStore?.retainRepos(names);
    }

    private now(): number {
        return new Date().getTime();
    }

    private record(name: string, branch: string, result: RepoIndexResult, startedAt: number): void {
        const at = this.now();
        const status: RepoRunStatus = { ...result, at, durationMs: at - startedAt };
        const key = keyOf(name, branch);
        this.lastRun.set(key, status);
        this.runStore?.set(key, status);
    }
}
