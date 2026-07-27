/**
 * StoreWriter — main-thread client for a dedicated Worker Thread that handles
 * all SQLite writes during graph indexing.
 *
 * Why this exists: the main thread's event loop can be blocked by synchronous
 * SQLite writes (better-sqlite3 is synchronous by design). For large repos
 * (100K+ nodes), the Phase 3 bulk insert can freeze the event loop for seconds
 * at a time, preventing the Milvus index's async I/O from making progress.
 *
 * Offloading writes to a dedicated Worker Thread decouples the two workloads:
 *   - Main thread: file scanning, vector embedding (async I/O), parse result
 *     collection, and backpressure coordination.
 *   - Store worker: SQLite inserts in transactions, one bundle at a time, with
 *     ack replies so the main thread tracks queue depth.
 *
 * The store worker opens its own better-sqlite3 connection (WAL mode, same DB
 * file), so reads on the main thread (via SqliteGraphStore's RO connection)
 * see committed writes immediately.
 *
 * Bundles are delivered in order and applied in order, so rowid assignment
 * (and therefore the resolution pipeline's insertion-order disambiguation) is
 * deterministic.
 */

import { Worker } from 'worker_threads';
import type { GraphNode, GraphEdge, UnresolvedReference } from './types';

// ── StoreBundle type ─────────────────────────────────────────────────────

/**
 * One file's complete store payload. Posted from the main thread to the
 * store worker for transactional write.
 */
export interface StoreBundle {
    /** Project identity (gitRemote:branch). */
    project: string;
    /** File path relative to project root (denormalized for clarity). */
    filePath?: string;
    /** Nodes extracted from this file (without auto-increment id). */
    nodes: Array<Omit<GraphNode, 'id'>>;
    /** Edges extracted from this file (without auto-increment id). */
    edges: Array<Omit<GraphEdge, 'id'>>;
    /** Unresolved references from this file. */
    unresolvedRefs: UnresolvedReference[];
    /** If true, delete existing nodes/edges for this file before inserting. */
    clearFile?: boolean;
}

// ── Worker message protocol ──────────────────────────────────────────────

type StoreWorkerOutgoing =
    | { type: 'open'; dbPath: string }
    | { type: 'bundle'; bundle: StoreBundle }
    | { type: 'drain'; id: number }
    | { type: 'close' };

type StoreWorkerIncoming =
    | { type: 'ready' }
    | { type: 'ack' }
    | { type: 'drained'; id: number }
    | { type: 'error'; message: string };

// ── StoreWriter (main-thread client) ─────────────────────────────────────

export class StoreWriter {
    private worker: Worker;
    private readyPromise: Promise<void>;
    private firstError: Error | null = null;
    private drainWaiters = new Map<
        number,
        { resolve: () => void; reject: (e: Error) => void }
    >();
    private nextDrainId = 0;
    private exited = false;
    /** Bundles posted but not yet acked — the queue-depth backpressure signal. */
    private outstanding = 0;
    private belowWaiters: Array<{ limit: number; resolve: () => void }> = [];

    /**
     * @param dbPath Absolute path to the SQLite database file. The store
     *   worker opens its own connection to this file.
     */
    constructor(dbPath: string) {
        // The worker runs in the same file — see the isMainThread guard at the
        // bottom of this module.
        this.worker = new Worker(__filename);

        let readyResolve!: () => void;
        let readyReject!: (e: Error) => void;
        this.readyPromise = new Promise<void>((resolve, reject) => {
            readyResolve = resolve;
            readyReject = reject;
        });

        this.worker.on(
            'message',
            (msg: StoreWorkerIncoming) => {
                if (msg.type === 'ready') {
                    readyResolve();
                } else if (msg.type === 'ack') {
                    this.settleOne();
                } else if (msg.type === 'drained' && msg.id !== undefined) {
                    const waiter = this.drainWaiters.get(msg.id);
                    this.drainWaiters.delete(msg.id);
                    if (!waiter) return;
                    if (this.firstError) waiter.reject(this.firstError);
                    else waiter.resolve();
                } else if (msg.type === 'error') {
                    if (!this.firstError)
                        this.firstError = new Error(`store worker: ${msg.message}`);
                    this.settleOne(); // the error reply is also the failed bundle's ack
                }
            },
        );

        this.worker.on('error', (err) => {
            this.failAll(err instanceof Error ? err : new Error(String(err)));
            readyReject(this.firstError!);
        });

        this.worker.on('exit', (code) => {
            this.exited = true;
            if (code !== 0) {
                this.failAll(new Error(`store worker exited with code ${code}`));
                readyReject(this.firstError!);
            } else if (this.drainWaiters.size > 0 || this.belowWaiters.length > 0) {
                // A clean exit with waiters pending is a protocol violation
                // (only close() should end the worker) — settle the waiters
                // instead of hanging the index forever.
                this.failAll(new Error('store worker exited before drain completed'));
            }
        });

        // Instruct the worker to open the database.
        this.worker.postMessage({ type: 'open', dbPath } satisfies StoreWorkerOutgoing);
        // The worker holds the event loop open only until close(); don't
        // unref — bundles must never be dropped because main ran out of work.
    }

    // ── Internal helpers ─────────────────────────────────────────────────

    private failAll(err: Error): void {
        if (!this.firstError) this.firstError = err;
        for (const [, waiter] of this.drainWaiters) waiter.reject(this.firstError);
        this.drainWaiters.clear();
        this.outstanding = 0;
        const waiters = this.belowWaiters;
        this.belowWaiters = [];
        for (const w of waiters) w.resolve(); // send() will surface firstError
    }

    private settleOne(): void {
        if (this.outstanding > 0) this.outstanding--;
        if (this.belowWaiters.length === 0) return;
        const still: typeof this.belowWaiters = [];
        for (const w of this.belowWaiters) {
            if (this.outstanding < w.limit) w.resolve();
            else still.push(w);
        }
        this.belowWaiters = still;
    }

    // ── Public API ───────────────────────────────────────────────────────

    /**
     * Resolves when the store worker has opened its DB connection and is
     * ready to accept bundles. Callers should `await` this before sending
     * the first bundle.
     */
    ready(): Promise<void> {
        return this.readyPromise;
    }

    /**
     * Post one file's bundle to the store worker. Throws immediately if the
     * writer has already failed. Bundles are applied in order; the worker
     * acks each bundle after its transaction commits.
     */
    send(bundle: StoreBundle): void {
        if (this.firstError) throw this.firstError;
        if (this.exited) throw new Error('store worker already exited');
        this.outstanding++;
        this.worker.postMessage({ type: 'bundle', bundle } satisfies StoreWorkerOutgoing);
    }

    /**
     * Backpressure: resolves once fewer than `maxPending` bundles are
     * un-acked. Use this to prevent the main thread from flooding the
     * worker with more work than it can process, keeping memory bounded.
     */
    waitBelow(maxPending: number): Promise<void> {
        if (this.firstError || this.exited || this.outstanding < maxPending) {
            return Promise.resolve();
        }
        return new Promise<void>((resolve) => {
            this.belowWaiters.push({ limit: maxPending, resolve });
        });
    }

    /**
     * Resolves when every bundle posted before this call has been committed.
     * The worker processes all queued bundles and only replies 'drained'
     * once its internal queue is empty.
     */
    drain(): Promise<void> {
        if (this.firstError) return Promise.reject(this.firstError);
        if (this.exited) return Promise.reject(new Error('store worker already exited'));
        const id = this.nextDrainId++;
        const p = new Promise<void>((resolve, reject) => {
            this.drainWaiters.set(id, { resolve, reject });
        });
        this.worker.postMessage({ type: 'drain', id } satisfies StoreWorkerOutgoing);
        return p;
    }

    /**
     * Close the worker's DB connection and join the thread. No further
     * bundles can be sent after calling this.
     */
    async close(): Promise<void> {
        if (this.exited) return;
        this.worker.postMessage({ type: 'close' } satisfies StoreWorkerOutgoing);
        await new Promise<void>((resolve) => {
            const t = setTimeout(() => {
                void this.worker.terminate().then(() => resolve());
            }, 5000);
            this.worker.once('exit', () => {
                clearTimeout(t);
                resolve();
            });
        });
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Store Worker (runs when this file is loaded as a Worker Thread)
// ═══════════════════════════════════════════════════════════════════════════

import { isMainThread, parentPort } from 'worker_threads';

if (!isMainThread) {
    // ── Worker initialization ────────────────────────────────────────────

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let db: any = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let insertNodeStmt: any = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let insertEdgeStmt: any = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let insertRefStmt: any = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let deleteFileNodesStmt: any = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let deleteFileEdgesStmt: any = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let deleteFileRefsStmt: any = null;

    /** Pending drain requests (id → callback). Processed when the write queue is empty. */
    const drainQueue: Array<{ id: number }> = [];
    /** Bundles queued for write. */
    const writeQueue: StoreBundle[] = [];
    /** Whether the worker is actively processing the write queue. */
    let writing = false;

    function postMessage(msg: StoreWorkerIncoming): void {
        parentPort?.postMessage(msg);
    }

    // ── Prepared statements ──────────────────────────────────────────────

    function prepareStatements(): void {
        if (!db) return;

        // Node upsert: ON CONFLICT on (project, qualified_name) updates all fields
        insertNodeStmt = db.prepare(`
            INSERT INTO nodes (
                project, kind, name, qualified_name, file_path,
                language, start_line, end_line,
                signature, visibility, is_exported, is_async, is_static, is_abstract,
                decorators_json, type_parameters_json, return_type, docstring,
                properties_json, updated_at
            ) VALUES (
                @project, @kind, @name, @qualifiedName, @filePath,
                @language, @startLine, @endLine,
                @signature, @visibility, @isExported, @isAsync, @isStatic, @isAbstract,
                @decoratorsJson, @typeParametersJson, @returnType, @docstring,
                @propertiesJson, @updatedAt
            ) ON CONFLICT(project, qualified_name) DO UPDATE SET
                kind = excluded.kind, name = excluded.name,
                file_path = excluded.file_path, language = excluded.language,
                start_line = excluded.start_line, end_line = excluded.end_line,
                signature = excluded.signature, visibility = excluded.visibility,
                is_exported = excluded.is_exported, is_async = excluded.is_async,
                is_static = excluded.is_static, is_abstract = excluded.is_abstract,
                decorators_json = excluded.decorators_json,
                type_parameters_json = excluded.type_parameters_json,
                return_type = excluded.return_type, docstring = excluded.docstring,
                properties_json = excluded.properties_json, updated_at = excluded.updated_at
        `);

        // Edge insert: OR IGNORE deduplicates on the unique identity index
        insertEdgeStmt = db.prepare(`
            INSERT OR IGNORE INTO edges (
                project, source_id, target_id, kind, line, col, provenance, metadata_json, properties_json
            ) VALUES (
                @project, @sourceId, @targetId, @kind, @line, @col, @provenance, @metadataJson, @propertiesJson
            )
        `);

        // Unresolved reference insert
        insertRefStmt = db.prepare(`
            INSERT INTO unresolved_refs (
                project, from_node_id, reference_name, reference_kind,
                line, col, file_path, language, status
            ) VALUES (
                @project, @fromNodeId, @referenceName, @referenceKind,
                @line, @col, @filePath, @language, 'pending'
            )
        `);

        // Delete nodes by file (CASCADE: triggers delete edges and FTS entries)
        deleteFileNodesStmt = db.prepare(
            'DELETE FROM nodes WHERE project = @project AND file_path = @filePath',
        );
        // Delete edges referencing nodes in this file (edges where source or
        // target node belonged to the deleted file). better-sqlite3 doesn't do
        // CASCADE automatically unless PRAGMA foreign_keys is ON with FK
        // definitions, so we delete edges explicitly.
        deleteFileEdgesStmt = db.prepare(`
            DELETE FROM edges WHERE project = @project AND (
                source_id IN (SELECT id FROM nodes WHERE project = @project AND file_path = @filePath)
                OR target_id IN (SELECT id FROM nodes WHERE project = @project AND file_path = @filePath)
            )
        `);
        deleteFileRefsStmt = db.prepare(`
            DELETE FROM unresolved_refs WHERE project = @project AND file_path = @filePath
        `);
    }

    // ── Bundle write ─────────────────────────────────────────────────────

    function writeBundle(bundle: StoreBundle): void {
        if (!db || !insertNodeStmt || !insertEdgeStmt || !insertRefStmt) return;

        const project = bundle.project;
        const filePath = bundle.filePath;

        // ── Clear file first (incremental re-index) ──────────────────────
        if (bundle.clearFile && filePath) {
            // Delete edges that reference nodes in this file first (FK safety)
            if (deleteFileEdgesStmt) {
                deleteFileEdgesStmt.run({ project, filePath });
            }
            // Delete unresolved refs for this file
            if (deleteFileRefsStmt) {
                deleteFileRefsStmt.run({ project, filePath });
            }
            // Delete nodes for this file (triggers FTS cascade)
            if (deleteFileNodesStmt) {
                deleteFileNodesStmt.run({ project, filePath });
            }
        }

        // ── Insert nodes ─────────────────────────────────────────────────
        const now = Date.now();
        for (const node of bundle.nodes) {
            insertNodeStmt!.run({
                project: node.project || project,
                kind: node.kind || (node as any).label || 'function',
                name: node.name,
                qualifiedName: node.qualifiedName,
                filePath: node.filePath,
                language: node.language || null,
                startLine: node.startLine,
                endLine: node.endLine,
                signature: node.signature || null,
                visibility: node.visibility || null,
                isExported: node.isExported ? 1 : 0,
                isAsync: node.isAsync ? 1 : 0,
                isStatic: node.isStatic ? 1 : 0,
                isAbstract: node.isAbstract ? 1 : 0,
                decoratorsJson: node.decorators ? JSON.stringify(node.decorators) : null,
                typeParametersJson: node.typeParameters
                    ? JSON.stringify(node.typeParameters)
                    : null,
                returnType: node.returnType || null,
                docstring: node.docstring || null,
                propertiesJson: JSON.stringify(node.properties || {}),
                updatedAt: node.updatedAt || now,
            });
        }

        // ── Insert edges ─────────────────────────────────────────────────
        for (const edge of bundle.edges) {
            insertEdgeStmt!.run({
                project: edge.project || project,
                sourceId: edge.sourceId,
                targetId: edge.targetId,
                kind: edge.kind || (edge as any).type || 'calls',
                line: edge.line ?? null,
                col: edge.column ?? null,
                provenance: edge.provenance || 'tree-sitter',
                metadataJson: edge.metadata ? JSON.stringify(edge.metadata) : null,
                propertiesJson: JSON.stringify(edge.properties || {}),
            });
        }

        // ── Insert unresolved references ─────────────────────────────────
        for (const ref of bundle.unresolvedRefs) {
            insertRefStmt!.run({
                project,
                fromNodeId: ref.fromNodeId,
                referenceName: ref.referenceName,
                referenceKind: ref.referenceKind,
                line: ref.line,
                col: ref.column,
                filePath: ref.filePath || filePath || null,
                language: ref.language || null,
            });
        }
    }

    // ── Write loop ───────────────────────────────────────────────────────

    function processWriteQueue(): void {
        if (writing) return;
        writing = true;

        // Process bundles in batches within a single transaction for throughput.
        // Each batch is up to 50 bundles to keep transaction size bounded.
        while (writeQueue.length > 0) {
            const batchSize = Math.min(writeQueue.length, 50);
            const batch = writeQueue.splice(0, batchSize);

            try {
                db!.pragma('BEGIN IMMEDIATE');
                for (const bundle of batch) {
                    writeBundle(bundle);
                    // Ack after each bundle so the main thread can track progress
                    postMessage({ type: 'ack' });
                }
                db!.pragma('COMMIT');
            } catch (e: any) {
                try {
                    db!.pragma('ROLLBACK');
                } catch {
                    /* best effort */
                }
                const message = e?.message ?? String(e);
                postMessage({ type: 'error', message });
                // Ack the failed batch bundles so backpressure doesn't deadlock
                for (let i = 0; i < batch.length; i++) {
                    if (i > 0) postMessage({ type: 'ack' });
                }
            }

            // Yield the event loop periodically so drain/close messages can
            // be received even during large writes.
            if (writeQueue.length > 0) {
                setImmediate(() => processWriteQueue());
                writing = false;
                return;
            }
        }

        writing = false;

        // After all queued writes are done, process any drain requests.
        while (drainQueue.length > 0) {
            const req = drainQueue.shift()!;
            postMessage({ type: 'drained', id: req.id });
        }
    }

    function enqueueBundle(bundle: StoreBundle): void {
        writeQueue.push(bundle);
        processWriteQueue();
    }

    // ── Message handler ──────────────────────────────────────────────────

    parentPort?.on('message', (msg: StoreWorkerOutgoing) => {
        if (msg.type === 'open') {
            try {
                const BetterSqlite3 = require('better-sqlite3');
                db = new BetterSqlite3(msg.dbPath);
                db.pragma('journal_mode = WAL');
                db.pragma('foreign_keys = ON');
                db.pragma('synchronous = NORMAL');
                db.pragma('cache_size = -64000'); // 64MB
                prepareStatements();
                postMessage({ type: 'ready' });
            } catch (e: any) {
                postMessage({ type: 'error', message: e?.message ?? String(e) });
                // Exit so the main thread's exit handler fires
                setImmediate(() => process.exit(1));
            }
        } else if (msg.type === 'bundle') {
            enqueueBundle(msg.bundle);
        } else if (msg.type === 'drain') {
            if (writeQueue.length === 0 && !writing) {
                // Queue is already empty — reply immediately
                postMessage({ type: 'drained', id: msg.id });
            } else {
                drainQueue.push({ id: msg.id });
            }
        } else if (msg.type === 'close') {
            // Process any remaining bundles first, then close
            if (writeQueue.length > 0 || writing) {
                // Enqueue a final drain-and-close step
                const closeAfterDrain = () => {
                    const check = () => {
                        if (writeQueue.length === 0 && !writing) {
                            try {
                                db?.close();
                            } catch {
                                /* ignore */
                            }
                            db = null;
                            process.exit(0);
                        } else {
                            setImmediate(check);
                        }
                    };
                    check();
                };
                drainQueue.push({
                    id: -1,
                });
                // Override the drain handler for this special case
                const origDrainLength = drainQueue.length;
                const origProcess = processWriteQueue;
                // Schedule close after current writes finish
                setImmediate(() => {
                    if (writeQueue.length === 0 && !writing) {
                        closeAfterDrain();
                    } else {
                        // Wait for writes to complete, then close
                        const interval = setInterval(() => {
                            if (writeQueue.length === 0 && !writing) {
                                clearInterval(interval);
                                closeAfterDrain();
                            }
                        }, 10);
                        // Safety timeout: force close after 10s
                        setTimeout(() => {
                            clearInterval(interval);
                            closeAfterDrain();
                        }, 10000).unref?.();
                    }
                });
            } else {
                try {
                    db?.close();
                } catch {
                    /* ignore */
                }
                db = null;
                process.exit(0);
            }
        }
    });
}
