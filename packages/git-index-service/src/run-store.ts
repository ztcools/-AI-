import * as fs from 'fs';
import * as path from 'path';
import { RepoRunStatus } from './indexer.js';

/**
 * Durable per-branch last-run status.
 *
 * Run status used to live only in the indexer's memory, so every restart (deploy,
 * crash, host reboot) blanked the console: every branch showed "未索引" even though
 * the collections were there, and an operator's only way to tell whether the
 * nightly pass had succeeded was to re-run it. It is kept in its own file rather
 * than in git-index-config.json so a failed status write can never damage the repo
 * list, which is the authoritative config.
 *
 * Writes are coalesced: a pass over hundreds of branches would otherwise rewrite
 * the whole file once per branch.
 */
export class RunStore {
    private runs: Record<string, RepoRunStatus> = {};
    private flushTimer: NodeJS.Timeout | null = null;
    private dirty = false;

    constructor(private readonly file: string, private readonly flushDelayMs = 2000) {
        this.load();
    }

    private load(): void {
        try {
            if (!fs.existsSync(this.file)) return;
            const raw = JSON.parse(fs.readFileSync(this.file, 'utf-8'));
            if (raw && typeof raw.runs === 'object' && raw.runs) this.runs = raw.runs;
        } catch (e: any) {
            console.warn(`[RunStore] Failed to read ${this.file}, starting empty: ${e?.message || e}`);
        }
    }

    all(): Record<string, RepoRunStatus> {
        return this.runs;
    }

    get(key: string): RepoRunStatus | undefined {
        return this.runs[key];
    }

    set(key: string, status: RepoRunStatus): void {
        this.runs[key] = status;
        this.schedule();
    }

    /** Drop statuses whose repo is no longer configured, so the file can't grow forever. */
    retainRepos(names: Set<string>): void {
        let changed = false;
        for (const [k, v] of Object.entries(this.runs)) {
            if (!names.has(v.repo)) {
                delete this.runs[k];
                changed = true;
            }
        }
        if (changed) this.schedule();
    }

    private schedule(): void {
        this.dirty = true;
        if (this.flushTimer) return;
        this.flushTimer = setTimeout(() => {
            this.flushTimer = null;
            this.flush();
        }, this.flushDelayMs);
        // A pending status write must never hold the process open (runOnce mode).
        this.flushTimer.unref?.();
    }

    /** Write immediately (called at the end of a pass and on shutdown). */
    flush(): void {
        if (!this.dirty) return;
        this.dirty = false;
        try {
            fs.mkdirSync(path.dirname(this.file), { recursive: true });
            // Write-then-rename so a crash mid-write can't leave a truncated file
            // that would be discarded on the next start.
            const tmp = `${this.file}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify({ runs: this.runs, updatedAt: Date.now() }, null, 2), 'utf-8');
            fs.renameSync(tmp, this.file);
        } catch (e: any) {
            console.warn(`[RunStore] Failed to write ${this.file}: ${e?.message || e}`);
        }
    }
}
