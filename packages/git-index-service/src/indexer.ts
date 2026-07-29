import { Context } from '@seeway/claude-context-core';
import { RepoManager } from './repo-manager.js';
import { RepoProvider } from './repo-provider.js';
import { ConfigStore } from './config-store.js';
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

/**
 * Orchestrates one indexing pass over all main repositories: fetch each to its
 * branch tip (RepoManager), then let the core Context apply only the git delta
 * with embedding-cache dedup (Context.syncIndexByGit). Main stays authoritative
 * and independent of any developer's local environment. Per-branch last-run
 * status is retained in memory for the management UI.
 */
export class GitIndexer {
    private running = false;
    // Per-branch last-run status, keyed by `${repoName}@${branch}`.
    private lastRun: Map<string, RepoRunStatus> = new Map();
    private lastPassAt: number | null = null;
    private current: CurrentProgress | null = null;

    constructor(
        private context: Context,
        private repoManager: RepoManager,
        private repoProvider: RepoProvider,
        private store?: ConfigStore,
    ) {}

    isRunning(): boolean {
        return this.running;
    }

    getLastPassAt(): number | null {
        return this.lastPassAt;
    }

    /** All branch statuses for one repo, keyed by branch name. */
    getStatus(name: string): Record<string, RepoRunStatus> {
        const out: Record<string, RepoRunStatus> = {};
        for (const [k, v] of this.lastRun.entries()) {
            if (v.repo === name && v.branch) out[v.branch] = v;
        }
        return out;
    }

    getCurrent(): CurrentProgress | null {
        return this.current;
    }

    /**
     * Index one specific branch of a repo. Checks out a dedicated per-branch
     * directory (RepoManager.dirFor hashes url#branch so branches never share a
     * working tree) and syncs the vector index for url:branch.
     */
    private async indexBranch(repo: RepoSpec, requestedBranch: string): Promise<RepoIndexResult> {
        const startedAt = this.now();
        const spec: RepoSpec = { ...repo, branch: requestedBranch };
        try {
            this.current = { repo: repo.name, branch: requestedBranch, phase: '拉取仓库', percentage: 0 };
            const { dir: localPath, branch } = this.repoManager.ensureCheckout(spec);
            // Persist the branch actually indexed when the main branch fell back to the
            // remote default. Only applies to the canonical main slot, not protected branches.
            if (branch !== spec.branch && requestedBranch === repo.branch) {
                this.store?.setRepoBranch(repo.name, branch);
            }
            const stats = await this.context.syncIndexByGit(localPath, p => {
                this.current = {
                    repo: repo.name,
                    branch,
                    phase: p.phase,
                    percentage: Math.round(p.percentage),
                };
            });
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

    /** Index main + every configured protected branch for one repo. */
    async indexOne(repo: RepoSpec): Promise<RepoIndexResult[]> {
        const branches: string[] = [repo.branch, ...(repo.protectedBranches || [])];
        const results: RepoIndexResult[] = [];
        this.current = { repo: repo.name, phase: '准备中', percentage: 0 };
        try {
            for (const b of branches) {
                results.push(await this.indexBranch(repo, b));
            }
        } finally {
            this.current = null;
        }
        return results;
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
            const results = await this.indexBranch(repo, branch);
            return results;
        } finally {
            this.running = false;
            this.current = null;
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
            console.log(`[GitIndexer] 🔄 Starting pass over ${repos.length} repositories`);
            for (const repo of repos) {
                const branchResults = await this.indexOne(repo);
                results.push(...branchResults);
            }
            const ok = results.filter(r => r.ok).length;
            console.log(`[GitIndexer] 🏁 Pass complete: ${ok}/${results.length} branch-indexes succeeded`);
        } finally {
            this.running = false;
            this.lastPassAt = this.now();
        }
        return results;
    }

    private now(): number {
        return new Date().getTime();
    }

    private record(name: string, branch: string, result: RepoIndexResult, startedAt: number): void {
        const at = this.now();
        this.lastRun.set(keyOf(name, branch), { ...result, at, durationMs: at - startedAt });
    }
}
