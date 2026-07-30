/**
 * ParseWorkerPool — manages persistent Worker Threads for parallel tree-sitter
 * parsing across all available cores.
 *
 * Why this exists: the single-worker path bottlenecks large-repo indexing
 * (hundreds of files) on one CPU core while the rest sit idle. A pool of N
 * persistent workers — each owning its own tree-sitter WASM heap — spreads the
 * parse workload across N cores. Results arrive in whatever order they finish
 * and the caller stores them as they land.
 *
 * Design mirrors CodeGraph's parse-pool (idle-list dispatch, lazy growth,
 * worker recycling for WASM memory, timeout/respawn for hung parses), adapted
 * for the claude-context graph module's Extractor interface:
 *
 *   - Per-worker recycle: tree-sitter WASM linear memory grows but never
 *     shrinks. After `recycleInterval` parses, the worker is torn down and
 *     replaced to reclaim heap.
 *   - Timeout handling: if a parse exceeds its budget with no result, the
 *     worker is terminated and the parse is rejected so the caller can retry.
 *   - Crash recovery: a dead worker is replaced (within a budget); in-flight
 *     parses are rejected so the caller re-queues them.
 *   - Grammar WASM preload: grammars read once from disk, forwarded to each
 *     worker on spawn so per-worker cold-start avoids repeated disk I/O.
 *
 * Memory: peak scales with pool size (size x per-worker pre-recycle heap).
 * The default is conservative (cores - 2) and can be overridden via env var.
 */

import { Worker } from 'worker_threads';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import type { ExtractionResult } from './extractor';

// ── Configuration defaults ───────────────────────────────────────────────

/** Default upper bound on pool size derived from core count. */
const DEFAULT_PARSE_POOL_CAP = 8;
/** Hard ceiling on pool size regardless of env override. */
const MAX_PARSE_POOL_SIZE = 16;
/** Parses a worker performs before being recycled to reclaim WASM heap. */
const DEFAULT_RECYCLE_INTERVAL = 250;
/** Base per-parse timeout in milliseconds. */
const DEFAULT_PARSE_TIMEOUT_MS = 10_000;
/**
 * A worker is only killed once a parse has gone this many times its budget
 * with no result. The base timer firing is NOT proof the parse is still
 * running — after a long synchronous main-thread stretch, Node runs the
 * timers phase before the poll phase, so an already-delivered result may be
 * queued behind the timer callback. Instead the base timer marks the job
 * late; a result that arrives before this backstop is accepted, and only a
 * worker that stays silent the whole window is treated as hung.
 */
const HARD_KILL_MULTIPLIER = 3;
/**
 * Max workers cold-starting at once. Cold start is heavy (module load +
 * grammar WASM compile); starting the whole pool simultaneously thrashes CPU.
 */
const MAX_CONCURRENT_SPAWN = 2;
/**
 * Total worker deaths before the pool stops respawning and fails outstanding
 * work, so a systematically-broken worker platform degrades instead of
 * respawning forever.
 */
const CRASH_BUDGET = 100;

// ── Pool size resolution ─────────────────────────────────────────────────

/**
 * Resolve parse pool size from env override and machine core count.
 *   - explicit `0` or `1` → 1 worker (single-worker path)
 *   - explicit `N` → N, clamped to [1, 16]
 *   - unset / blank / non-numeric → `clamp(cores - 2, 1, 8)`
 */
export function resolveParsePoolSize(envVal: string | undefined, cpuCount: number): number {
    if (envVal !== undefined && envVal !== '') {
        const n = Number(envVal);
        if (Number.isFinite(n) && n >= 0) {
            return Math.max(1, Math.min(Math.floor(n), MAX_PARSE_POOL_SIZE));
        }
    }
    return Math.max(1, Math.min(cpuCount - 2, DEFAULT_PARSE_POOL_CAP));
}

/**
 * Resolve the base per-parse timeout from env override.
 * Non-numeric / non-positive values fall back to the default (10s).
 */
export function resolveParseTimeoutMs(envVal: string | undefined): number {
    if (envVal !== undefined && envVal !== '') {
        const n = Number(envVal);
        if (Number.isFinite(n) && n > 0) return Math.floor(n);
    }
    return DEFAULT_PARSE_TIMEOUT_MS;
}

// ── Grammar WASM bytes ───────────────────────────────────────────────────

/**
 * Mapping from language key to the npm package name that provides the
 * tree-sitter grammar.
 */
const GRAMMAR_PACKAGE_MAP: Record<string, string> = {
    javascript: 'tree-sitter-javascript',
    typescript: 'tree-sitter-typescript',
    python: 'tree-sitter-python',
    java: 'tree-sitter-java',
    cpp: 'tree-sitter-cpp',
    go: 'tree-sitter-go',
    rust: 'tree-sitter-rust',
    csharp: 'tree-sitter-c-sharp',
};

/**
 * Pre-read tree-sitter grammar WASM bytes for a set of languages.
 *
 * Tree-sitter 0.21.x languages are loaded via `require()` (the language
 * object is the module export, not a raw WASM file). This function is a
 * best-effort convenience: when WASM files are available on disk they are
 * read into memory so per-worker cold-start avoids repeated disk I/O. When
 * WASM files are absent (the common case for v0.21.x require()-based
 * grammars), an empty record is returned and each worker loads grammars via
 * its own `require()` — which is already fast thanks to Node's module cache.
 */
export function readGrammarWasmBytes(languages: string[]): Record<string, Uint8Array> {
    const result: Record<string, Uint8Array> = {};

    for (const lang of languages) {
        const pkgName = GRAMMAR_PACKAGE_MAP[lang];
        if (!pkgName) continue;

        try {
            // Attempt to resolve the WASM file that some tree-sitter packages
            // ship alongside their JS grammar.
            const candidates = [
                `${pkgName}/tree-sitter-${lang}.wasm`,
                `${pkgName}/grammar.wasm`,
                `${pkgName}/dist/tree-sitter-${lang}.wasm`,
                `${pkgName}/target/release/tree-sitter-${lang}.wasm`,
            ];
            for (const candidate of candidates) {
                try {
                    const resolvedPath = require.resolve(candidate, { paths: [process.cwd()] });
                    result[lang] = fs.readFileSync(resolvedPath);
                    break;
                } catch {
                    // This candidate doesn't exist, try the next
                }
            }
        } catch {
            // Package not installed or not resolvable — worker will load from
            // its own require().
        }
    }

    return result;
}

// ── Types ────────────────────────────────────────────────────────────────

/** A single file to parse. Language is resolved by the caller. */
export interface ParseTask {
    filePath: string;
    content: string;
    language: string;
    /**
     * Repo identity. Node `qualifiedName`s are built as
     * `<project>.<path>.<name>`, so a worker that doesn't know the project
     * produces keys the resolver and the store can't match against.
     */
    project?: string;
}

/**
 * Result posted back from a parse worker for a single file.
 * Augments ExtractionResult with parse timing, unresolved references,
 * and any errors encountered.
 */
export interface ParseWorkerResult {
    filePath: string;
    nodes: ExtractionResult['nodes'];
    edges: ExtractionResult['edges'];
    unresolvedRefs: Array<{
        fromNodeId: number;
        referenceName: string;
        referenceKind: string;
        line: number;
        column: number;
        filePath?: string;
        language?: string;
    }>;
    errors: string[];
}

interface ParseJob {
    id: number;
    task: ParseTask;
    resolve: (r: ParseWorkerResult) => void;
    reject: (e: Error) => void;
    settled: boolean;
    timer?: ReturnType<typeof setTimeout>;
    /** Full budget for this parse (base timeout + size scaling). */
    budgetMs?: number;
    /** The base timer fired with no result yet — accept a late result. */
    timerExpired?: boolean;
    hardKillTimer?: ReturnType<typeof setTimeout>;
}

/** Shape of a message a worker posts back. */
interface ParseWorkerMessage {
    type?: string;
    id?: number;
    filePath?: string;
    parseMs?: number;
    nodes?: ExtractionResult['nodes'];
    edges?: ExtractionResult['edges'];
    unresolvedRefs?: ParseWorkerResult['unresolvedRefs'];
    errors?: string[];
    message?: string;
}

// ── Options ──────────────────────────────────────────────────────────────

export interface ParseWorkerPoolOptions {
    /** Languages to load grammars for in every worker at spawn. */
    languages: string[];
    /** Number of worker threads (>=1). Clamp via resolveParsePoolSize before passing. */
    size: number;
    /** Compiled parse-worker-v2.js path. */
    workerScriptPath: string;
    /** Parses per worker before recycle. Default 250. */
    recycleInterval?: number;
    /** Base per-parse timeout in ms; scaled by file size per parse. Default 10s. */
    parseTimeoutMs?: number;
}

// ── Pool implementation ──────────────────────────────────────────────────

export class ParseWorkerPool {
    private idle: Worker[] = [];
    private queue: ParseJob[] = [];
    private inflight = new Map<Worker, ParseJob>();
    private workers = new Set<Worker>();
    /** Spawned but not yet 'grammars-loaded'. */
    private pending = new Set<Worker>();
    private parseCounts = new Map<Worker, number>();
    private nextId = 1;
    private totalCrashes = 0;
    private destroyed = false;

    private readonly languages: string[];
    private readonly maxSize: number;
    private readonly recycleInterval: number;
    private readonly parseTimeoutMs: number;
    private readonly workerScriptPath: string;
    /** Pre-read grammar WASM buffers, forwarded to each worker on spawn. */
    private readonly grammarBuffers: Record<string, Uint8Array>;

    constructor(opts: ParseWorkerPoolOptions) {
        this.languages = opts.languages;
        this.grammarBuffers = readGrammarWasmBytes(opts.languages);
        this.maxSize = Math.max(1, Math.min(opts.size, MAX_PARSE_POOL_SIZE));
        this.recycleInterval = opts.recycleInterval ?? DEFAULT_RECYCLE_INTERVAL;
        this.parseTimeoutMs = opts.parseTimeoutMs ?? DEFAULT_PARSE_TIMEOUT_MS;
        this.workerScriptPath = opts.workerScriptPath;
        this.spawnOne(); // one eager warm worker, ready for the first parse
    }

    /** Pool size cap. */
    get size(): number {
        return this.maxSize;
    }

    /** Live worker count. */
    get liveWorkers(): number {
        return this.workers.size;
    }

    /** False once the crash budget is exhausted (or after destroy). */
    get healthy(): boolean {
        return !this.destroyed && this.totalCrashes < CRASH_BUDGET;
    }

    // ── Public API ───────────────────────────────────────────────────────

    /**
     * Spawn the whole pool up front. The default demand-driven growth avoids
     * paying worker boot for small jobs, but a bulk index KNOWS every core
     * will be needed — prewarming avoids the one-by-one ramp-up.
     */
    prewarm(): void {
        while (this.workers.size < this.maxSize) {
            const before = this.workers.size;
            this.spawnOne();
            if (this.workers.size === before) break; // spawn failed / breaker tripped
        }
    }

    /**
     * Parse one file on the pool. Resolves with the extraction result, or
     * REJECTS if the parse times out or its worker crashes — the caller
     * should retry the file.
     */
    requestParse(task: ParseTask): Promise<ParseWorkerResult> {
        if (this.destroyed) return Promise.reject(new Error('Parse pool destroyed'));
        return new Promise<ParseWorkerResult>((resolve, reject) => {
            this.queue.push({ id: this.nextId++, task, resolve, reject, settled: false });
            this.drain();
        });
    }

    /**
     * Recycle every idle worker now (fresh WASM heaps). The caller invokes
     * this before a retry pass so crash-prone files get the cleanest heap.
     */
    recycleAll(): void {
        for (const w of [...this.idle]) this.recycle(w);
    }

    /**
     * Terminate all workers and reject any outstanding parses.
     */
    async destroy(): Promise<void> {
        if (this.destroyed) return;
        this.destroyed = true;
        const ws = [...this.workers];
        this.workers.clear();
        this.pending.clear();
        this.parseCounts.clear();
        this.idle = [];
        for (const job of [...this.inflight.values(), ...this.queue]) {
            this.settle(job, undefined, new Error('parse pool destroyed'));
        }
        this.inflight.clear();
        this.queue = [];
        await Promise.all(
            ws.map((w) =>
                Promise.resolve(w.terminate()).catch(() => {
                    /* already gone */
                }),
            ),
        );
    }

    // ── Internal: worker lifecycle ───────────────────────────────────────

    private spawnOne(): void {
        if (this.destroyed || this.workers.size >= this.maxSize || !this.healthy) return;
        let w: Worker;
        try {
            w = new Worker(this.workerScriptPath);
        } catch {
            this.totalCrashes++; // counts toward the circuit breaker
            return;
        }
        this.workers.add(w);
        this.pending.add(w);
        this.parseCounts.set(w, 0);
        w.on('message', (m) => this.onMessage(w, (m ?? {}) as ParseWorkerMessage));
        w.on('error', (e) =>
            this.onWorkerGone(w, `Worker error: ${e?.message ?? 'unknown'}`),
        );
        w.on('exit', (code) => {
            if (code !== 0) this.onWorkerGone(w, `Worker exited with code ${code}`);
        });
        // Load grammars. Pre-read WASM bytes make this a memory load instead
        // of a per-spawn disk read.
        w.postMessage({
            type: 'load-grammars',
            languages: this.languages,
            grammarBuffers: this.grammarBuffers,
        });
    }

    // ── Internal: message dispatch ───────────────────────────────────────

    private onMessage(w: Worker, m: ParseWorkerMessage): void {
        if (m.type === 'grammars-loaded') {
            if (!this.workers.has(w)) return; // recycled/destroyed before ready
            this.pending.delete(w);
            this.idle.push(w);
            this.drain();
            return;
        }

        if (m.type === 'parse-result') {
            const job = this.inflight.get(w);
            if (!job || (m.id !== undefined && m.id !== job.id)) return; // stale (post-recycle)
            this.inflight.delete(w);

            if (job.timerExpired) {
                // The base timer fired before this result was processed. That
                // almost always means the MAIN THREAD was stalled (e.g. SQLite
                // writes on slow disks) while the parse finished long ago —
                // the worker's own clock (parseMs) tells the two apart.
                const parseMs = typeof m.parseMs === 'number' ? Math.round(m.parseMs) : undefined;
                const detail =
                    parseMs === undefined
                        ? ''
                        : parseMs < (job.budgetMs ?? this.parseTimeoutMs)
                          ? ` (parse took ${parseMs}ms in-worker — the main thread was stalled, not the parse)`
                          : ` (parse genuinely took ${parseMs}ms)`;
                console.debug(
                    `[ParseWorkerPool] Late parse-result accepted: ${job.task.filePath}${detail}`,
                );
            }

            // Recycle the worker once it has done enough parses to have grown
            // its WASM heap; otherwise return it to the idle set.
            if ((this.parseCounts.get(w) ?? 0) >= this.recycleInterval) {
                this.recycle(w);
            } else {
                this.idle.push(w);
            }

            this.settle(job, {
                filePath: m.filePath ?? job.task.filePath,
                nodes: m.nodes ?? [],
                edges: m.edges ?? [],
                unresolvedRefs: m.unresolvedRefs ?? [],
                errors: m.errors ?? [],
            });
            this.drain();
        }
    }

    // ── Internal: failure handling ───────────────────────────────────────

    /**
     * A worker died (crash / OOM exit / spawn error). Reject its in-flight
     * parse so the caller can retry, then respawn.
     */
    private onWorkerGone(w: Worker, message: string): void {
        if (!this.workers.has(w)) return; // already handled (error+exit both fire), or recycled
        this.removeWorker(w);
        this.totalCrashes++;
        const job = this.inflight.get(w);
        this.inflight.delete(w);
        try {
            void w.terminate();
        } catch {
            /* already gone */
        }
        if (job) this.settle(job, undefined, new Error(message));
        if (this.healthy) this.spawnOne(); // keep capacity
        this.drain();
    }

    /** Tear down a worker that has hit its recycle threshold and replace it. */
    private recycle(w: Worker): void {
        console.debug(
            `[ParseWorkerPool] Recycling worker after ${this.parseCounts.get(w)} parses`,
        );
        this.removeWorker(w);
        try {
            void w.terminate();
        } catch {
            /* already gone */
        }
        if (this.healthy && !this.destroyed) this.spawnOne();
    }

    private removeWorker(w: Worker): void {
        this.workers.delete(w);
        this.pending.delete(w);
        this.parseCounts.delete(w);
        this.idle = this.idle.filter((x) => x !== w);
    }

    // ── Internal: dispatch + scheduling ──────────────────────────────────

    private dispatch(w: Worker, job: ParseJob): void {
        this.inflight.set(w, job);
        this.parseCounts.set(w, (this.parseCounts.get(w) ?? 0) + 1);
        // Scale the timeout for large files: base + 10s per 100KB
        const timeoutMs =
            this.parseTimeoutMs + Math.floor(job.task.content.length / 100_000) * 10_000;
        job.budgetMs = timeoutMs;
        job.timer = setTimeout(() => this.onTimeout(w, job, timeoutMs), timeoutMs);
        job.timer.unref?.();
        w.postMessage({
            type: 'parse',
            id: job.id,
            filePath: job.task.filePath,
            content: job.task.content,
            language: job.task.language,
            project: job.task.project,
        });
    }

    /**
     * The base timer fired with no result processed yet. Do NOT kill the
     * worker immediately — the timer firing doesn't prove the parse is still
     * running (main-thread stalls can cause this). Mark the job late and arm
     * the hard-kill backstop for genuinely hung workers.
     */
    private onTimeout(w: Worker, job: ParseJob, ms: number): void {
        if (job.settled || !this.workers.has(w)) return;
        const graceMs = ms * (HARD_KILL_MULTIPLIER - 1);
        console.debug(
            `[ParseWorkerPool] TIMEOUT: ${job.task.filePath} exceeded ${ms}ms — waiting up to ${graceMs}ms more for a late result`,
        );
        job.timerExpired = true;
        job.hardKillTimer = setTimeout(
            () => this.onHardTimeout(w, job, ms * HARD_KILL_MULTIPLIER),
            graceMs,
        );
        job.hardKillTimer.unref?.();
    }

    /** No result after the full hard-kill window — the worker really is hung. */
    private onHardTimeout(w: Worker, job: ParseJob, totalMs: number): void {
        if (job.settled || !this.workers.has(w)) return;
        console.debug(
            `[ParseWorkerPool] TIMEOUT: ${job.task.filePath} got no result after ${totalMs}ms — killing worker`,
        );
        this.removeWorker(w);
        this.inflight.delete(w);
        try {
            void w.terminate();
        } catch {
            /* already gone */
        }
        this.settle(job, undefined, new Error(`Parse timed out after ${totalMs}ms`));
        if (this.healthy) this.spawnOne();
        this.drain();
    }

    // ── Internal: queue drain loop ───────────────────────────────────────

    private drain(): void {
        // Grow toward maxSize while queued work outstrips workers that are
        // idle OR already on their way up — throttled so we never cold-start
        // the whole pool at once.
        while (
            this.queue.length > this.idle.length + this.pending.size &&
            this.workers.size < this.maxSize &&
            this.pending.size < MAX_CONCURRENT_SPAWN &&
            !this.destroyed &&
            this.healthy
        ) {
            this.spawnOne();
        }

        // Dispatch queued jobs to idle workers.
        while (this.idle.length && this.queue.length) {
            let job: ParseJob | undefined;
            while (this.queue.length && (job = this.queue.shift()) && job.settled) {
                job = undefined;
            }
            if (!job || job.settled) break;
            const w = this.idle.pop()!;
            this.dispatch(w, job);
        }

        // Hang-prevention: if there's queued work but nothing can ever run it
        // (no idle workers, none spawning, none alive), fail it instead of
        // hanging forever.
        if (
            this.queue.length &&
            this.idle.length === 0 &&
            this.pending.size === 0 &&
            this.workers.size === 0
        ) {
            const reason = this.destroyed
                ? 'parse pool destroyed'
                : 'parse pool exhausted its worker crash budget';
            for (const job of this.queue.splice(0))
                this.settle(job, undefined, new Error(reason));
        }
    }

    private settle(
        job: ParseJob,
        result?: ParseWorkerResult,
        err?: Error,
    ): void {
        if (job.settled) return;
        job.settled = true;
        if (job.timer) clearTimeout(job.timer);
        if (job.hardKillTimer) clearTimeout(job.hardKillTimer);
        if (err) job.reject(err);
        else job.resolve(result!);
    }
}
