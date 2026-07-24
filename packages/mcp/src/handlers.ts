import * as fs from "fs";
import * as path from "path";
import { Context, COLLECTION_LIMIT_MESSAGE, FileSynchronizer, IndexAbortError, getRepoIdentity, getDevFingerprint, getDevRepoIdentity, getBranchIdentity, isGitRepo, getCurrentBranch, envManager } from "@seeway/claude-context-core";
import { SnapshotManager } from "./snapshot.js";
import type { CodebaseIndexOptions, CodebaseInfoIndexFailed, CodebaseInfoIndexing, CodebaseInfoIndexed, RequestSplitterType } from "./config.js";
import { createRequestSplitter, isRequestSplitterType } from "./splitter.js";
import { resolveCodebasePath, truncateContent, trackCodebasePath } from "./utils.js";
import type { GraphToolHandlers } from "./graph-handlers.js";

export class ToolHandlers {
    private context: Context;
    private snapshotManager: SnapshotManager;
    private currentWorkspace: string;
    /**
     * Tracks active background indexing tasks per absolute codebase path so
     * clear_index can cancel and await them before dropping the collection.
     * Without this, a clear_index call returns "successfully cleared" while
     * the background task keeps embedding chunks and writing them into the
     * just-cleared collection (issue #199).
     */
    private graphToolHandlers: GraphToolHandlers | null = null;
    private indexingTasks: Map<string, { controller: AbortController; promise: Promise<void> }> = new Map();
    private lastCollectionSyncMs: number = 0;
    private static readonly COLLECTION_SYNC_THROTTLE_MS = 60_000;
    /**
     * Projects for which we've already kicked off an automatic local graph
     * build this session. The vector index is shared via the cloud, but the
     * knowledge graph is local — so a repo indexed by a teammate arrives with
     * an empty local graph. We lazily build it on first use; this set prevents
     * re-triggering on every subsequent search.
     */
    private autoGraphBuildTriggered: Set<string> = new Set();
    /**
     * Projects whose architecture summary has already been appended to a search
     * result this session. The architecture block (entry points + clusters) is
     * repo-level and stable — repeating it on every search in the same session
     * is pure token waste. We emit it once per project per session; subsequent
     * searches skip it. Cleared naturally on server restart.
     */
    private architectureEmitted: Set<string> = new Set();

    constructor(context: Context, snapshotManager: SnapshotManager, graphToolHandlers?: GraphToolHandlers) {
        this.context = context;
        this.snapshotManager = snapshotManager;
        this.graphToolHandlers = graphToolHandlers || null;
        this.currentWorkspace = process.cwd();
        console.log(`[WORKSPACE] Current workspace: ${this.currentWorkspace}`);
    }

    /**
     * Search precision / token knobs, read from env so operators can tune the
     * read-vs-search tradeoff without a rebuild. Defaults favor precise,
     * token-lean context over exhaustive recall:
     *  - SEARCH_DEFAULT_LIMIT   fallback result count when caller omits `limit` (default 10)
     *  - SEARCH_THRESHOLD       min cosine score, dense (non-hybrid) path only (default 0.3)
     *  - SEARCH_SNIPPET_MAX_CHARS  per-snippet char cap (default 4000 ≈ 1000 tokens)
     *  - SEARCH_SCORE_RATIO     relative tail cutoff in [0,1]; drop results scoring
     *                           below ratio×topScore. 0 disables. Works in both
     *                           dense and hybrid/RRF modes since it's relative. (default 0)
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
            threshold: num('SEARCH_THRESHOLD', 0.3),
            snippetMaxChars: Math.max(200, num('SEARCH_SNIPPET_MAX_CHARS', 4000)),
            scoreRatio: Math.max(0, Math.min(1, num('SEARCH_SCORE_RATIO', 0))),
        };
    }

    /**
     * Query Milvus for the real row count of a codebase's collection.
     * Returns null if the count cannot be determined — callers must NOT write a
     * snapshot entry in that case. Writing { indexedFiles: 0, totalChunks: 0,
     * status: 'completed' } for an unknown-state collection poisons the client:
     * the client treats 0/0 as "not indexed" and triggers force reindex, which
     * deletes real data and rewrites 0/0 — an infinite loop. See Issue #295.
     */
    private async queryCollectionStats(codebasePath: string): Promise<{ indexedFiles: number; totalChunks: number } | null> {
        try {
            const collectionName = this.context.getCollectionName(codebasePath);
            const rowCount = await this.context.getVectorDatabase().getCollectionRowCount(collectionName);
            if (rowCount < 0) {
                console.warn(`[SNAPSHOT-RECOVERY] Row count unknown for '${codebasePath}', skipping recovery write`);
                return null;
            }
            if (rowCount === 0) {
                console.warn(`[SNAPSHOT-RECOVERY] Collection '${collectionName}' truly empty — NOT writing recovered entry (would poison client)`);
                return null;
            }
            // rowCount is chunk count, not file count. IndexedFiles is marked -1
            // to signal "unknown" — corrected on the next full index. TotalChunks
            // gets the real rowCount to distinguish empty vs non-empty collections.
            return { indexedFiles: -1, totalChunks: rowCount };
        } catch (error) {
            console.warn(`[SNAPSHOT-RECOVERY] Failed to query stats for '${codebasePath}':`, error);
            return null;
        }
    }

    /**
     * One-shot startup validation: find any legacy 0/0+completed entries on disk
     * (left over from old MCP versions, v1 snapshot migrations, or pre-fix recovery
     * paths) and either heal them with the real Milvus row count or remove them
     * if the underlying collection is empty/missing. See Issue #295.
     *
     * Safe to call multiple times but intended to run once per server start after
     * loadCodebaseSnapshot(). Errors are caught and logged; never throws.
     */
    public async validateLegacyZeroEntries(): Promise<void> {
        try {
            const indexedCodebases = this.snapshotManager.getIndexedCodebases();
            let healed = 0, removed = 0, skipped = 0, checked = 0;

            for (const codebasePath of indexedCodebases) {
                const info = this.snapshotManager.getCodebaseInfo(codebasePath);
                if (!info || info.status !== 'indexed') continue;
                // Only validate suspiciously-zero entries
                if (info.indexedFiles !== 0 || info.totalChunks !== 0) continue;

                checked++;
                const collectionName = this.context.getCollectionName(codebasePath);
                const vdb = this.context.getVectorDatabase();

                // First probe: does the collection even exist? A "no" here is
                // authoritative (permanent orphan), while a throw is most likely
                // transient (Milvus unreachable) — keep those two cases distinct
                // so we don't destroy real state on a network blip.
                let collectionExists: boolean;
                try {
                    collectionExists = await vdb.hasCollection(collectionName);
                } catch (err) {
                    console.warn(`[SNAPSHOT-VALIDATE] hasCollection failed for '${codebasePath}' (likely transient), skipping:`, err);
                    skipped++;
                    continue;
                }

                if (!collectionExists) {
                    // Permanent orphan — no matching Milvus collection, so the
                    // 0/0+completed snapshot entry is a pure phantom. Remove it.
                    this.snapshotManager.removeCodebaseCompletely(codebasePath);
                    removed++;
                    console.warn(`[SNAPSHOT-VALIDATE] Removed orphan 0/0 entry '${codebasePath}' — no matching Milvus collection`);
                    continue;
                }

                // Collection exists — get an accurate row count.
                let rowCount: number;
                try {
                    rowCount = await vdb.getCollectionRowCount(collectionName);
                } catch (err) {
                    console.warn(`[SNAPSHOT-VALIDATE] getCollectionRowCount failed for '${codebasePath}', skipping:`, err);
                    skipped++;
                    continue;
                }

                if (rowCount > 0) {
                    // Heal: rewrite with real row count. rowCount is chunk count;
                    // without a cheap file-count query we reuse it for both fields.
                    // Imprecise but keeps the state non-zero and will be corrected
                    // on the next full index.
                    this.snapshotManager.setCodebaseIndexed(codebasePath, {
                        indexedFiles: rowCount,
                        totalChunks: rowCount,
                        status: 'completed' as const,
                    });
                    healed++;
                    console.log(`[SNAPSHOT-VALIDATE] Healed legacy 0/0 entry '${codebasePath}' → rows=${rowCount}`);
                } else if (rowCount === 0) {
                    // Collection exists but truly empty — the 0/0+completed entry
                    // is a phantom. Remove so the user must explicitly reindex.
                    this.snapshotManager.removeCodebaseCompletely(codebasePath);
                    removed++;
                    console.warn(`[SNAPSHOT-VALIDATE] Removed phantom 0/0 entry '${codebasePath}' — collection exists but empty`);
                } else {
                    // rowCount === -1 despite the collection existing: the count
                    // query failed after the existence probe succeeded. Treat as
                    // transient and leave the entry alone.
                    skipped++;
                    console.warn(`[SNAPSHOT-VALIDATE] Row count unavailable for existing collection '${codebasePath}', skipping`);
                }
            }

            if (healed > 0 || removed > 0) {
                await this.snapshotManager.saveCodebaseSnapshot();
            }
            if (checked > 0) {
                console.log(`[SNAPSHOT-VALIDATE] Done — checked=${checked} healed=${healed} removed=${removed} skipped=${skipped}`);
            }
        } catch (error) {
            console.warn(`[SNAPSHOT-VALIDATE] Unexpected error during legacy 0/0 validation (non-fatal):`, error);
        }
    }

    /**
     * Sync indexed codebases from collection collections
     * This method fetches all collections from the vector database,
     * extracts codebasePath from collection description (preferred) or falls back
     * to querying document metadata for old collections,
     * and updates the snapshot with discovered codebases.
     *
     * Logic: Compare mcp-codebase-snapshot.json with collection collections
     * - If local snapshot has extra directories (not in collections), remove them
     * - If local snapshot is missing directories (exist in cloud), ignore them
     */

    /**
     * Extract the codebase path from a single collection. Tries description first,
     * falls back to querying metadata. Returns null if extraction fails.
     * Designed for parallel execution — catches all errors internally.
     */
    private async extractCodebaseFromCollection(
        collectionName: string,
        vectorDb: any,
    ): Promise<{ codebasePath: string } | null> {
        try {
            console.log(`[COLLECTION-SYNC] 🔍 Checking collection: ${collectionName}`);

            // Try to extract codebasePath from collection description first (new format)
            try {
                const description = await vectorDb.getCollectionDescription(collectionName);
                if (description && description.startsWith('codebasePath:')) {
                    // Description format: `codebasePath:<identity>` optionally followed by
                    // `|parent:<parentIdentity>` (Git-DAG tree). Take the identity part.
                    const rawPath = description.substring('codebasePath:'.length);
                    const codebasePath = rawPath.split('|')[0];
                    if (codebasePath.length > 0) {
                        console.log(`[COLLECTION-SYNC] 📍 Found codebase path from description: ${codebasePath} in collection: ${collectionName}`);
                        return { codebasePath };
                    }
                }
            } catch (descError: any) {
                console.warn(`[COLLECTION-SYNC] ⚠️  Failed to get description for collection ${collectionName}:`, descError.message || descError);
            }

            // Fallback: query document metadata for old collections without new description format
            console.log(`[COLLECTION-SYNC] 🔄 Falling back to query-based extraction for collection: ${collectionName}`);
            try {
                const results = await vectorDb.query(
                    collectionName,
                    undefined,
                    ['metadata'],
                    1
                );

                if (results && results.length > 0) {
                    const firstResult = results[0];
                    const metadataStr = firstResult.metadata;

                    if (metadataStr) {
                        const metadata = JSON.parse(metadataStr);
                        const codebasePath = metadata.codebasePath;

                        if (codebasePath && typeof codebasePath === 'string') {
                            console.log(`[COLLECTION-SYNC] 📍 Found codebase path from query: ${codebasePath} in collection: ${collectionName}`);
                            return { codebasePath };
                        } else {
                            console.warn(`[COLLECTION-SYNC] ⚠️  No codebasePath found in metadata for collection: ${collectionName}`);
                        }
                    } else {
                        console.warn(`[COLLECTION-SYNC] ⚠️  No metadata found in collection: ${collectionName}`);
                    }
                } else {
                    console.log(`[COLLECTION-SYNC] ℹ️  Collection ${collectionName} is empty`);
                }
            } catch (queryError: any) {
                console.warn(`[COLLECTION-SYNC] ⚠️  Fallback query failed for collection ${collectionName}:`, queryError.message || queryError);
            }

            return null;
        } catch (collectionError: any) {
            console.warn(`[COLLECTION-SYNC] ⚠️  Error checking collection ${collectionName}:`, collectionError.message || collectionError);
            return null;
        }
    }

    private async syncCollectionState(): Promise<void> {
        this.lastCollectionSyncMs = Date.now();
    }

    // ── Unified Index: Vector + Graph ─────────────────────────────
    /**
     * Single entry point for indexing. Runs vector index (Milvus) and
     * graph index (SQLite). Vector index runs first and returns immediately;
     * graph index runs in background to avoid blocking MCP response.
     */
    public async handleIndex(args: any) {
        const { path: codebasePath = ".", mode: graphMode = "full" } = args;
        const absolutePath = resolveCodebasePath(codebasePath);

        // 1. Run vector indexing (same as handleIndexCodebase)
        const vectorResult = await this.handleIndexCodebase(args);

        // If vector indexing returned a real error (not "already indexed"), skip graph indexing
        const vectorText = vectorResult.content[0]?.text || '';
        const isAlreadyIndexed = vectorResult.isError && vectorText.includes('already indexed');
        if (vectorResult.isError && !isAlreadyIndexed) {
            return vectorResult;
        }

        // 2. Graph indexing — always attempt, even if vector indicates "already indexed"
        if (this.graphToolHandlers) {
            const project = getRepoIdentity(absolutePath);
            const stats = this.graphToolHandlers.getStore().getProjectStats(project);
            const alreadyGraphIndexed = stats.nodes > 0;

            // Defer graph indexing to background to avoid blocking MCP response
            setImmediate(async () => {
                try {
                    let graphResult: { content: Array<{ type: string; text: string }> } | undefined;
                    if (alreadyGraphIndexed && !args.force) {
                        console.log(`[INDEX] Graph already indexed for '${project}' (${stats.nodes} nodes), checking for changes...`);

                        let changedFiles: string[] = [];
                        try {
                            const detectResult = this.graphToolHandlers!.detectChangedFiles({ project });
                            if (detectResult) {
                                changedFiles = detectResult.changedFiles;
                            }
                        } catch {
                            // change detection failure shouldn't block
                        }

                        if (changedFiles.length > 0) {
                            console.log(`[INDEX] Detected ${changedFiles.length} changed files, running incremental graph index`);
                            graphResult = await this.graphToolHandlers!.handleIndexRepository({
                                repo_path: absolutePath,
                                mode: 'incremental',
                                files: changedFiles,
                            });
                        } else {
                            console.log(`[INDEX] No changes detected for '${project}', skipping graph indexing`);
                        }
                    } else {
                        graphResult = await this.graphToolHandlers!.handleIndexRepository({
                            repo_path: absolutePath,
                            mode: graphMode,
                        });
                    }

                    // Check for errors in the returned content (handleIndexRepository
                    // returns errors as text, not by throwing)
                    if (graphResult) {
                        const text = graphResult.content[0]?.text || '';
                        if (text.startsWith('Error')) {
                            console.error(`[INDEX] Graph indexing error: ${text}`);
                        } else {
                            console.log(`[INDEX] Graph indexing completed for '${project}'`);
                        }
                    }
                } catch (e: any) {
                    console.warn(`[INDEX] Graph indexing failed (non-fatal): ${e.message}`);
                }
            });

            const graphNote = alreadyGraphIndexed && !args.force
                ? `\n\n[Graph] Already indexed: ${stats.nodes} nodes, ${stats.edges} edges (checking for changes in background)`
                : `\n\n[Graph] Indexing in background...`;
            const responseText = vectorText + graphNote;
            return {
                ...vectorResult,
                isError: false, // Don't block on "already indexed" — graph is still processing
                content: [{ type: 'text', text: responseText }],
            };
        }

        return vectorResult;
    }

    private async handleIndexCodebase(args: any) {
        const { path: codebasePath = ".", force, splitter, customExtensions, ignorePatterns } = args;
        const forceReindex = force || false;
        const requestedSplitter = splitter || 'ast'; // Default to AST
        const customFileExtensions = customExtensions || [];
        const customIgnorePatterns = ignorePatterns || [];

        try {

            // Validate splitter parameter
            if (!isRequestSplitterType(requestedSplitter)) {
                return {
                    content: [{
                        type: "text",
                        text: `Error: Invalid splitter type '${requestedSplitter}'. Must be 'ast' or 'langchain'.`
                    }],
                    isError: true
                };
            }
            const splitterType = requestedSplitter; // narrowed by isRequestSplitterType above
            const indexOptions: CodebaseIndexOptions = {
                requestSplitter: splitterType,
                requestCustomExtensions: customFileExtensions,
                requestIgnorePatterns: customIgnorePatterns
            };
            // Resolve path: supports absolute, relative, and "." for workspace auto-detection
            const absolutePath = resolveCodebasePath(codebasePath);

            // Compute identity (url:branch) for comparison with snapshot lists and vector DB
            const codebaseIdentity = getRepoIdentity(absolutePath);
            console.log(`[IDENTITY] Codebase identity: ${codebaseIdentity} (path: ${absolutePath})`);

            // Dev-aware indexing: each developer gets their own per-branch collection.
            // No root-branch guard needed — dev collections are always personal.
            // Merkle-based change detection handles all git operations correctly.
            const devIdentity = getDevRepoIdentity(absolutePath);
            const devCollectionName = this.context.getCollectionNameForIdentity(devIdentity);

            console.log(`[DEV-IDENTITY] Dev identity: ${devIdentity} (fingerprint: ${getDevFingerprint()})`);

            // Validate path exists
            if (!fs.existsSync(absolutePath)) {
                return {
                    content: [{
                        type: "text",
                        text: `Error: Path '${absolutePath}' does not exist. Original input: '${codebasePath}'`
                    }],
                    isError: true
                };
            }

            // Check if it's a directory
            const stat = fs.statSync(absolutePath);
            if (!stat.isDirectory()) {
                return {
                    content: [{
                        type: "text",
                        text: `Error: Path '${absolutePath}' is not a directory`
                    }],
                    isError: true
                };
            }

            // Check if already indexing (dev-aware: uses absolute path, not identity).
            let alreadyCleared = false;
            if (this.indexingTasks.has(absolutePath)) {
                if (forceReindex) {
                    console.log(`[FORCE-REINDEX] Cancelling existing indexing task for '${absolutePath}'`);
                    const oldTask = this.indexingTasks.get(absolutePath)!;
                    oldTask.controller.abort();
                    try { await oldTask.promise; } catch { /* aborted */ }
                    this.indexingTasks.delete(absolutePath);
                    alreadyCleared = true;
                } else {
                    return {
                        content: [{
                            type: "text",
                            text: `Codebase '${absolutePath}' is already being indexed in the background. Please wait for completion.`
                        }],
                        isError: true
                    };
                }
            }

            // If force reindex, clear the dev collection.
            if (forceReindex && !alreadyCleared) {
                if (await this.context.getVectorDatabase().hasCollection(devCollectionName).catch(() => false)) {
                    console.log(`[FORCE-REINDEX] 🔄 Clearing dev collection '${devCollectionName}'`);
                    await this.context.getVectorDatabase().dropCollection(devCollectionName);
                    // Also delete the Merkle snapshot for this dev+branch.
                    await FileSynchronizer.deleteSnapshot(absolutePath, devIdentity);
                }
            }

            // CRITICAL: Pre-index collection creation validation
            // NOTE: Skipping checkCollectionLimit on self-hosted Milvus
            // (it creates/drops a dummy collection, with 15s timeout).
            // Re-enable only when using collection with collection limits.
            // try {
            //     console.log(`[INDEX-VALIDATION] 🔍 Validating collection creation capability`);
            //     const canCreateCollection = await this.context.getVectorDatabase().checkCollectionLimit();
            // ...
            console.log(`[INDEX-VALIDATION] ✅  Collection creation validation skipped (self-hosted Milvus)`);

            if (customFileExtensions.length > 0) {
                console.log(`[CUSTOM-EXTENSIONS] Using ${customFileExtensions.length} request-scoped custom extensions: ${customFileExtensions.join(', ')}`);
            }

            // Check current status and log if retrying after failure
            const currentStatus = this.snapshotManager.getCodebaseStatus(absolutePath);
            if (currentStatus === 'indexfailed') {
                const failedInfo = this.snapshotManager.getCodebaseInfo(absolutePath) as CodebaseInfoIndexFailed;
                console.log(`[BACKGROUND-INDEX] Retrying indexing for previously failed codebase. Previous error: ${failedInfo?.errorMessage || 'Unknown error'}`);
            }

            // Set to indexing status and save snapshot immediately
            this.snapshotManager.setCodebaseIndexing(absolutePath, 0, indexOptions);
            await this.snapshotManager.saveCodebaseSnapshot();

            // Track the codebase path for syncing
            trackCodebasePath(absolutePath);

            // Start background indexing - now safe to proceed.
            // Track the controller + promise so clear_index can cancel and
            // await us before dropping the underlying collection.
            const controller = new AbortController();
            const promise = this.startBackgroundIndexing(
                absolutePath,
                forceReindex,
                splitterType,
                customIgnorePatterns,
                customFileExtensions,
                indexOptions,
                controller.signal
            ).finally(() => {
                // Only clear the entry if it still points at this run — a
                // concurrent re-index may have replaced us.
                const current = this.indexingTasks.get(absolutePath);
                if (current && current.controller === controller) {
                    this.indexingTasks.delete(absolutePath);
                }
            });
            this.indexingTasks.set(absolutePath, { controller, promise });

            const pathInfo = codebasePath !== absolutePath
                ? `\nNote: Input path '${codebasePath}' was resolved to absolute path '${absolutePath}'`
                : '';

            const extensionInfo = customFileExtensions.length > 0
                ? `\nUsing ${customFileExtensions.length} custom extensions: ${customFileExtensions.join(', ')}`
                : '';

            const ignoreInfo = customIgnorePatterns.length > 0
                ? `\nUsing ${customIgnorePatterns.length} custom ignore patterns: ${customIgnorePatterns.join(', ')}`
                : '';

            return {
                content: [{
                    type: "text",
                    text: `Started background indexing for codebase '${absolutePath}' using ${splitterType.toUpperCase()} splitter.${pathInfo}${extensionInfo}${ignoreInfo}\n\nIndexing is running in the background. You can search the codebase while indexing is in progress, but results may be incomplete until indexing completes.`
                }]
            };

        } catch (error: any) {
            // Enhanced error handling to prevent MCP service crash
            console.error('Error in handleIndexCodebase:', error);

            // Ensure we always return a proper MCP response, never throw
            return {
                content: [{
                    type: "text",
                    text: `Error starting indexing: ${error.message || error}`
                }],
                isError: true
            };
        }
    }

    private async startBackgroundIndexing(
        codebasePath: string,
        forceReindex: boolean,
        splitterType: RequestSplitterType,
        customIgnorePatterns: string[] = [],
        customFileExtensions: string[] = [],
        indexOptions?: CodebaseIndexOptions,
        signal?: AbortSignal
    ): Promise<void> {
        const absolutePath = codebasePath;
        let lastSaveTime = 0; // Track last save timestamp

        try {
            console.log(`[BACKGROUND-INDEX] Starting background indexing for: ${absolutePath}`);

            // Note: If force reindex, collection was already cleared during validation phase
            if (forceReindex) {
                console.log(`[BACKGROUND-INDEX] ℹ️  Force reindex mode - collection was already cleared during validation`);
            }

            const requestSplitter = createRequestSplitter(splitterType);

            // Load ignore patterns from files first (including .ignore, .gitignore, etc.)
            // and merge them with this request's custom ignore patterns without
            // relying on shared Context state for this background indexing task.
            const ignorePatterns = await this.context.getEffectiveIgnorePatterns(absolutePath, customIgnorePatterns);
            const supportedExtensions = this.context.getEffectiveSupportedExtensions(customFileExtensions);

            console.log(`[BACKGROUND-INDEX] 🚀 Beginning Merkle-based indexing process (dev: ${getDevFingerprint()})...`);
            const stats = await this.context.syncIndexByMerkle(absolutePath, async (progress) => {
                // Update progress in snapshot manager using new method
                this.snapshotManager.setCodebaseIndexing(absolutePath, progress.percentage);

                // Save snapshot periodically (every 2 seconds to avoid too frequent saves)
                const currentTime = Date.now();
                if (currentTime - lastSaveTime >= 2000) { // 2 seconds = 2000ms
                    await this.snapshotManager.saveCodebaseSnapshot();
                    lastSaveTime = currentTime;
                    console.log(`[BACKGROUND-INDEX] 💾 Saved progress snapshot at ${progress.percentage.toFixed(1)}%`);
                }

                console.log(`[BACKGROUND-INDEX] Progress: ${progress.phase} - ${progress.percentage}% (${progress.current}/${progress.total})`);
            }, customIgnorePatterns, customFileExtensions, requestSplitter, signal);
            console.log(`[BACKGROUND-INDEX] ✅ Indexing completed (${stats.mode})! Files: ${stats.indexedFiles}, Chunks: ${stats.totalChunks}, Δ +${stats.added}/~${stats.modified}/-${stats.removed}`);

            // Set codebase to indexed status with complete statistics
            this.snapshotManager.setCodebaseIndexed(absolutePath, stats, indexOptions);

            // Save snapshot after updating codebase lists
            await this.snapshotManager.saveCodebaseSnapshot();

            let message = `Background indexing completed for '${absolutePath}' using ${splitterType.toUpperCase()} splitter (${stats.mode} mode).`;
            if (stats.mode === 'delta') {
                message += `\nDelta index (dev ⊕ root): ${stats.indexedFiles} changed files indexed, ${stats.totalChunks} chunks. Unchanged files served from root collection.`;
            } else if (stats.mode === 'incremental') {
                message += `\nGit incremental: ${stats.added} added, ${stats.modified} modified, ${stats.removed} removed. Indexed ${stats.indexedFiles} files, ${stats.totalChunks} chunks.`;
            } else if (stats.mode === 'up-to-date') {
                message += `\nAlready up to date — no changes since last indexed commit.`;
            } else {
                message += `\nIndexed ${stats.indexedFiles} files, ${stats.totalChunks} chunks.`;
            }
            if (stats.status === 'limit_reached') {
                message += `\n⚠️  Warning: Indexing stopped because the chunk limit (450,000) was reached. The index may be incomplete.`;
            }

            console.log(`[BACKGROUND-INDEX] ${message}`);

        } catch (error: any) {
            // Cooperative cancel from clear_index — clear_index is responsible
            // for tearing down the snapshot/collection right after, so do not
            // overwrite the snapshot with an "indexfailed" entry that would
            // race the clear and leave a tombstone behind.
            if (error instanceof IndexAbortError) {
                console.log(`[BACKGROUND-INDEX] Indexing for ${absolutePath} was cancelled: ${error.message}`);
                return;
            }

            console.error(`[BACKGROUND-INDEX] Error during indexing for ${absolutePath}:`, error);

            // Get the last attempted progress
            const lastProgress = this.snapshotManager.getIndexingProgress(absolutePath);

            // Set codebase to failed status with error information
            const errorMessage = error.message || String(error);
            this.snapshotManager.setCodebaseIndexFailed(absolutePath, errorMessage, lastProgress, indexOptions);
            await this.snapshotManager.saveCodebaseSnapshot();

            // Log error but don't crash MCP service - indexing errors are handled gracefully
            console.error(`[BACKGROUND-INDEX] Indexing failed for ${absolutePath}: ${errorMessage}`);
        }
    }

    public async handleSearchCode(args: any) {
        const tuning = this.getSearchTuning();
        const { path: codebasePath = ".", query, limit, extensionFilter, mode, enrich, style } = args;
        const searchMode: 'vector' | 'graph' | 'both' = (mode === 'graph') ? 'graph' : (mode === 'vector') ? 'vector' : 'both';
        const doEnrich = searchMode === 'both' && enrich !== false;
        const compactStyle = style === 'compact';
        const resultLimit = limit || tuning.defaultLimit;

        try {
            // Sync collection state in background — don't block indexing
            void this.syncCollectionState().catch(err =>
                console.warn('[COLLECTION-SYNC] Background sync failed:', err?.message || err)
            );

            // Resolve path: supports absolute, relative, and "." for workspace auto-detection
            const absolutePath = resolveCodebasePath(codebasePath);

            // Validate path exists
            if (!fs.existsSync(absolutePath)) {
                return {
                    content: [{
                        type: "text",
                        text: `Error: Path '${absolutePath}' does not exist. Original input: '${codebasePath}'`
                    }],
                    isError: true
                };
            }

            // Check if it's a directory
            const stat = fs.statSync(absolutePath);
            if (!stat.isDirectory()) {
                return {
                    content: [{
                        type: "text",
                        text: `Error: Path '${absolutePath}' is not a directory`
                    }],
                    isError: true
                };
            }

            trackCodebasePath(absolutePath);

            // Dev-aware search: check if dev collection exists, fall back to root.
            const devColl = this.context.getDevCollectionName(absolutePath);
            const rootColl = this.context.getRootCollectionName(absolutePath);
            const vdbSearch = this.context.getVectorDatabase();
            const devExistsPre = await vdbSearch.hasCollection(devColl).catch(() => false);
            const rootExistsPre = await vdbSearch.hasCollection(rootColl).catch(() => false);

            if (!devExistsPre && !rootExistsPre) {
                return {
                    content: [{
                        type: "text",
                        text: `Error: Codebase '${absolutePath}' is not indexed. Neither a personal dev index nor a shared root index was found. Please index it first using the index tool.`
                    }],
                    isError: true
                };
            }

            // Check if currently indexing
            const indexingCodebasePath = this.snapshotManager.findIndexingCodebasePath(absolutePath);
            const isIndexing = !!indexingCodebasePath;

            // The vector index exists; make sure the local graph is being built too.
            this.maybeAutoBuildGraphIndex(absolutePath);

            // Show indexing status if codebase is being indexed
            let indexingStatusMessage = '';
            if (isIndexing) {
                indexingStatusMessage = `\n⚠️  **Indexing in Progress**: This codebase is currently being indexed in the background. Search results may be incomplete until indexing completes.`;
            }

            console.log(`[SEARCH] Searching in codebase: ${absolutePath} (dev=${devExistsPre}, root=${rootExistsPre})`);
            console.log(`[SEARCH] Query: "${query}"`);
            console.log(`[SEARCH] Indexing status: ${isIndexing ? 'In Progress' : 'Completed'}`);

            // Log embedding provider information before search
            const embeddingProvider = this.context.getEmbedding();
            console.log(`[SEARCH] 🧠 Using embedding provider: ${embeddingProvider.getProvider()} for search`);
            console.log(`[SEARCH] 🔍 Generating embeddings for query using ${embeddingProvider.getProvider()}...`);

            // Build filter expression from extensionFilter list
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
                        isError: true
                    };
                }
                const quoted = cleaned.map((e: string) => `'${e}'`).join(', ');
                filterExpr = `fileExtension in [${quoted}]`;
            }

            // ── Dev-aware search: dev collection (changed files) ⊕ root collection (masked) ──
            const devCollectionName = this.context.getDevCollectionName(absolutePath);
            const rootCollectionName = this.context.getRootCollectionName(absolutePath);
            const vdb = this.context.getVectorDatabase();

            // Determine which layers to search.
            const devExists = await vdb.hasCollection(devCollectionName).catch(() => false);
            const rootExists = await vdb.hasCollection(rootCollectionName).catch(() => false);

            let searchResults: Awaited<ReturnType<typeof this.context.searchWithLayers>>;
            let searchSourceNote = '';
            let resultMessage = '';

            // Build the layer chain with masking.
            // Dev collection holds files changed vs root (or all files if no root).
            // Root layer is masked by the dev-owned file list so stale root copies
            // of changed files never surface — the dev's version always wins.
            const layers: Array<{ collectionName: string; mask?: string[] }> = [];

            if (devExists) {
                layers.push({ collectionName: devCollectionName });
            }
            if (rootExists) {
                // Compute mask: files the dev collection owns → exclude from root layer.
                // RRF + dedup handle overlaps as a safety net, but the mask guarantees
                // correctness: a dev-changed file that scores lower than its root copy
                // won't be displaced by the stale version.
                let devOwnedFiles: string[] = [];
                if (devExists) {
                    const synchronizers = this.context.getSynchronizers();
                    const synchronizer = synchronizers.get(devCollectionName);
                    if (synchronizer) {
                        devOwnedFiles = synchronizer.getDevChangedFiles();
                    }
                }
                layers.push({
                    collectionName: rootCollectionName,
                    mask: devOwnedFiles.length > 0 ? devOwnedFiles : undefined,
                });
            }

            if (layers.length === 0) {
                return {
                    content: [{
                        type: "text",
                        text: `Error: Codebase '${absolutePath}' is not indexed. Neither a personal dev index nor a shared root index was found. Please index first using the index tool.`
                    }],
                    isError: true
                };
            }

            // ── Dual-mode search: vector + graph, or single-mode ──
            let vectorResults: any[] = [];
            let graphResultText = '';

            if (searchMode !== 'graph') {
                searchResults = await this.context.searchWithLayers(
                    layers,
                    query,
                    Math.min(resultLimit, 50),
                    tuning.threshold,
                    filterExpr,
                );

                if (layers.length > 1) {
                    searchSourceNote = ' (dev ⊕ root)';
                } else if (devExists) {
                    searchSourceNote = ' (dev index)';
                } else {
                    searchSourceNote = ' (root fallback — run index for your dev copy)';
                }

                // Score cutoff
                let scored = searchResults;
                if (tuning.scoreRatio > 0 && scored.length > 1) {
                    const topScore = Number(scored[0]?.score) || 0;
                    if (topScore > 0) {
                        const floor = topScore * tuning.scoreRatio;
                        scored = scored.filter((r: any, i: number) =>
                            i === 0 || (Number(r.score) || 0) >= floor
                        );
                    }
                }
                vectorResults = scored;
            }

            // Append graph results if mode=graph or mode=both and graph handlers exist
            if (searchMode !== 'vector' && this.graphToolHandlers && query.trim().length > 0) {
                try {
                    const project = getRepoIdentity(absolutePath);
                    const gr = this.graphToolHandlers.handleSearchGraph({
                        project,
                        query,
                        limit: Math.min(resultLimit, 10),
                    });
                    const gText = gr.content[0]?.text || '';
                    if (gText && !gText.startsWith('Found 0 results')) {
                        graphResultText = gText;
                    }
                } catch {}
            }

            // ── No results found ──
            if (vectorResults.length === 0 && !graphResultText) {
                let noMsg = `No results for "${query}" in '${absolutePath}'${searchSourceNote}`;
                if (isIndexing) noMsg += `\nIndexing in progress — retry later.`;
                if (!devExists) noMsg += `\nTip: run index tool first.`;
                return { content: [{ type: "text", text: noMsg }] };
            }

            // ── Format vector results ──
            if (vectorResults.length > 0) {
                const items = vectorResults.map((r: any, i: number) => {
                    const loc = `${r.relativePath}:${r.startLine}-${r.endLine}`;
                    if (compactStyle) {
                        return `[${i + 1}] ${loc} ${r.language} s=${Number(r.score || 0).toFixed(5)}`;
                    }
                    const code = truncateContent(r.content, tuning.snippetMaxChars);
                    return `[${i + 1}] ${loc} ${r.language} s=${Number(r.score || 0).toFixed(5)}\n\`\`\`${r.language}\n${code}\n\`\`\``;
                }).join(compactStyle ? '\n' : '\n\n');

                const modeTag = searchMode === 'both' ? ' vector+graph' : '';
                resultMessage = `${vectorResults.length}${modeTag} hits for "${query}"${searchSourceNote}${indexingStatusMessage}\n${items}\n`;
            }

            // ── Graph enrichment (both mode only, when enrich !== false) ──
            if (doEnrich && this.graphToolHandlers && vectorResults.length > 0) {
                try {
                    resultMessage += this.enrichWithGraphContextDeep(
                        vectorResults.slice(0, 5),
                        absolutePath,
                        query,
                    );
                } catch (graphErr: any) {
                    console.warn(`[SEARCH] Graph enrichment failed: ${graphErr.message}`);
                }
            }

            // ── Graph-only mode: standalone graph results ──
            if (graphResultText && searchMode === 'graph') {
                resultMessage = `Graph hits for "${query}" in '${absolutePath}'${indexingStatusMessage}\n\n${graphResultText}`;
            } else if (graphResultText && vectorResults.length === 0) {
                resultMessage = `Graph-only hits for "${query}" (no vector matches)${indexingStatusMessage}\n\n${graphResultText}`;
            }

            if (isIndexing) {
                resultMessage += `\n⚠️ Indexing in progress — results may be incomplete.`;
            }

            return { content: [{ type: "text", text: resultMessage }] };
        } catch (error) {
            // Check if this is the collection limit error
            // Handle both direct string throws and Error objects containing the message
            const errorMessage = typeof error === 'string' ? error : (error instanceof Error ? error.message : String(error));

            if (errorMessage === COLLECTION_LIMIT_MESSAGE || errorMessage.includes(COLLECTION_LIMIT_MESSAGE)) {
                // Return the collection limit message as a successful response
                // This ensures LLM treats it as final answer, not as retryable error
                return {
                    content: [{
                        type: "text",
                        text: COLLECTION_LIMIT_MESSAGE
                    }]
                };
            }

            return {
                content: [{
                    type: "text",
                    text: `Error searching code: ${errorMessage} Please check if the codebase has been indexed first.`
                }],
                isError: true
            };
        }
    }

    public async handleClearIndex(args: any) {
        const { path: codebasePath = "." } = args;

        if (this.snapshotManager.getIndexedCodebases().length === 0 && this.snapshotManager.getIndexingCodebases().length === 0) {
            return {
                content: [{
                    type: "text",
                    text: "No codebases are currently indexed or being indexed."
                }]
            };
        }

        try {
            // Resolve path: supports absolute, relative, and "." for workspace auto-detection
            const absolutePath = resolveCodebasePath(codebasePath);

            // Validate path exists
            if (!fs.existsSync(absolutePath)) {
                return {
                    content: [{
                        type: "text",
                        text: `Error: Path '${absolutePath}' does not exist. Original input: '${codebasePath}'`
                    }],
                    isError: true
                };
            }

            // Check if it's a directory
            const stat = fs.statSync(absolutePath);
            if (!stat.isDirectory()) {
                return {
                    content: [{
                        type: "text",
                        text: `Error: Path '${absolutePath}' is not a directory`
                    }],
                    isError: true
                };
            }

            // Dev-aware clearing: clear the developer's personal collection and Merkle snapshot.
            const devIdentity = getDevRepoIdentity(absolutePath);
            const devCollectionName = this.context.getCollectionNameForIdentity(devIdentity);

            console.log(`[CLEAR] Clearing dev collection: ${devCollectionName} (dev: ${getDevFingerprint()})`);

            // Cancel any in-flight background indexing for this codebase.
            const activeTask = this.indexingTasks.get(absolutePath);
            if (activeTask) {
                console.log(`[CLEAR] Cancelling in-flight background indexing for: ${absolutePath}`);
                activeTask.controller.abort();
                try {
                    await activeTask.promise;
                } catch (waitError: any) {
                    console.warn(`[CLEAR] Background indexing wind-down reported: ${waitError?.message || waitError}`);
                }
                this.indexingTasks.delete(absolutePath);
            }

            // Drop the dev collection from Milvus.
            try {
                const vdb = this.context.getVectorDatabase();
                if (await vdb.hasCollection(devCollectionName).catch(() => false)) {
                    await vdb.dropCollection(devCollectionName);
                    console.log(`[CLEAR] Successfully cleared dev collection: ${devCollectionName}`);
                } else {
                    console.log(`[CLEAR] Dev collection '${devCollectionName}' does not exist — nothing to clear.`);
                }
            } catch (error: any) {
                const errorMsg = `Failed to clear ${absolutePath}: ${error.message}`;
                console.error(`[CLEAR] ${errorMsg}`);
                return {
                    content: [{
                        type: "text",
                        text: errorMsg
                    }],
                    isError: true
                };
            }

            // Delete the dev-aware Merkle snapshot.
            try {
                await FileSynchronizer.deleteSnapshot(absolutePath, devIdentity);
                console.log(`[CLEAR] Deleted Merkle snapshot for dev identity: ${devIdentity}`);
            } catch (snapErr: any) {
                console.warn(`[CLEAR] Failed to delete Merkle snapshot (non-fatal): ${snapErr.message}`);
            }

            // Also clear the graph index to keep vector + graph in sync
            // Also clear the graph index.
            if (this.graphToolHandlers) {
                const branchIdentity = getBranchIdentity(absolutePath);
                try {
                    this.graphToolHandlers.getStore().beginTransaction();
                    this.graphToolHandlers.getStore().deleteProject(branchIdentity);
                    this.graphToolHandlers.getStore().commitTransaction();
                    console.log(`[CLEAR] Successfully cleared graph index for: ${branchIdentity}`);
                } catch (graphError: any) {
                    console.warn(`[CLEAR] Failed to clear graph index for '${branchIdentity}': ${graphError.message}`);
                }
            }

            // Completely remove the cleared codebase from snapshot
            this.snapshotManager.removeCodebaseCompletely(absolutePath);

            // Save snapshot after clearing index
            await this.snapshotManager.saveCodebaseSnapshot();

            let resultText = `Successfully cleared codebase '${absolutePath}'`;

            const remainingIndexed = this.snapshotManager.getIndexedCodebases().length;
            const remainingIndexing = this.snapshotManager.getIndexingCodebases().length;

            if (remainingIndexed > 0 || remainingIndexing > 0) {
                resultText += `\n${remainingIndexed} other indexed codebase(s) and ${remainingIndexing} indexing codebase(s) remain`;
            }

            return {
                content: [{
                    type: "text",
                    text: resultText
                }]
            };
        } catch (error) {
            // Check if this is the collection limit error
            // Handle both direct string throws and Error objects containing the message
            const errorMessage = typeof error === 'string' ? error : (error instanceof Error ? error.message : String(error));

            if (errorMessage === COLLECTION_LIMIT_MESSAGE || errorMessage.includes(COLLECTION_LIMIT_MESSAGE)) {
                // Return the collection limit message as a successful response
                // This ensures LLM treats it as final answer, not as retryable error
                return {
                    content: [{
                        type: "text",
                        text: COLLECTION_LIMIT_MESSAGE
                    }]
                };
            }

            return {
                content: [{
                    type: "text",
                    text: `Error clearing index: ${errorMessage}`
                }],
                isError: true
            };
        }
    }

    // ── Unified Status: Vector + Graph ─────────────────────────────
    /**
     * Single entry point for status. Merges vector index status (Milvus)
     * and graph index status (SQLite) into one response.
     */
    public async handleStatus(args: any) {
        const { path: codebasePath = "." } = args;
        const lines: string[] = [];

        // 1. Vector index status
        const vectorResult = await this.handleGetIndexingStatus(args);
        const vectorText = vectorResult.content[0]?.text || '';
        lines.push('## Vector Index (Milvus)');
        lines.push(vectorText);
        lines.push('');

        // 2. Graph index status
        if (this.graphToolHandlers) {
            try {
                const absolutePath = resolveCodebasePath(codebasePath);
                const project = getRepoIdentity(absolutePath);
                const store = this.graphToolHandlers.getStore();
                const stats = store.getProjectStats(project);

                // If the graph is empty (e.g. repo vector-indexed by a teammate),
                // start a background build so it catches up to the vector index.
                this.maybeAutoBuildGraphIndex(absolutePath);

                lines.push('## Graph Index (SQLite)');
                lines.push(`  Nodes: ${stats.nodes} | Edges: ${stats.edges}`);
                if (stats.nodes === 0) {
                    lines.push('  (empty — building in background to match the shared vector index; check again shortly)');
                }

                // Graph indexing progress (if in progress)
                const graphProgress = this.graphToolHandlers.getIndexingProgress(project);
                if (graphProgress) {
                    const pct = graphProgress.total > 0
                        ? Math.round((graphProgress.current / graphProgress.total) * 100)
                        : 0;
                    lines.push(`  Indexing: ${pct}% (${graphProgress.current}/${graphProgress.total} files, ${graphProgress.elapsed.toFixed(1)}s elapsed)`);
                }

                // Node type breakdown (single aggregate query)
                const nodeTypeCounts = store.getNodeTypeCounts(project);
                const typeEntries = Object.entries(nodeTypeCounts);
                if (typeEntries.length > 0) {
                    lines.push(`  Types: ${typeEntries.map(([k, v]) => `${k}: ${v}`).join(', ')}`);
                }

                // Edge type breakdown (single aggregate query)
                const edgeTypeCounts = store.getEdgeTypeCounts(project);
                const edgeEntries = Object.entries(edgeTypeCounts);
                if (edgeEntries.length > 0) {
                    lines.push(`  Relationships: ${edgeEntries.map(([k, v]) => `${k}: ${v}`).join(', ')}`);
                }

                // Routes summary
                const routeResult = store.findNodes({ project, label: 'Route', limit: 100 });
                if (routeResult.total > 0) {
                    lines.push(`  Routes: ${routeResult.total}`);
                    for (const r of routeResult.results.slice(0, 5)) {
                        lines.push(`    ${r.node.name} (${r.node.filePath}:${r.node.startLine})`);
                    }
                    if (routeResult.total > 5) lines.push(`    ... +${routeResult.total - 5} more`);
                }

                lines.push('');

                // === Architecture overview ===
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

        return {
            content: [{ type: 'text', text: lines.join('\n') }]
        };
    }

    public async handleGetIndexingStatus(args: any) {
        const { path: codebasePath = "." } = args;

        try {
            // Resolve path: supports absolute, relative, and "." for workspace auto-detection
            const absolutePath = resolveCodebasePath(codebasePath);

            // Validate path exists
            if (!fs.existsSync(absolutePath)) {
                return {
                    content: [{
                        type: "text",
                        text: `Error: Path '${absolutePath}' does not exist. Original input: '${codebasePath}'`
                    }],
                    isError: true
                };
            }

            // Check if it's a directory
            const stat = fs.statSync(absolutePath);
            if (!stat.isDirectory()) {
                return {
                    content: [{
                        type: "text",
                        text: `Error: Path '${absolutePath}' is not a directory`
                    }],
                    isError: true
                };
            }

            // Check snapshot first, then fall back to Milvus.
            // No syncCollectionState — it was designed for Zilliz Cloud multi-user
            // collection discovery and corrupts local state in self-hosted Milvus.
            let statusCodebasePath =
                this.snapshotManager.findIndexedCodebasePath(absolutePath)
                || this.snapshotManager.findIndexingCodebasePath(absolutePath)
                || this.snapshotManager.findTrackedCodebasePath(absolutePath)
                || absolutePath;
            let status = this.snapshotManager.getCodebaseStatus(statusCodebasePath);
            let info = this.snapshotManager.getCodebaseInfo(statusCodebasePath);

            // Self-heal stale in-memory state: if memory doesn't know this codebase
            // (or has no info for it) but the on-disk snapshot does, trust disk —
            // it's the source of truth search reads from — and refresh memory.
            if (status === 'not_found' || !info) {
                const diskInfo = this.snapshotManager.getCodebaseInfoFromDisk(statusCodebasePath);
                if (diskInfo) {
                    console.warn(`[STATUS] In-memory snapshot stale for '${statusCodebasePath}', healing from disk (status=${diskInfo.status})`);
                    this.snapshotManager.refreshCodebaseFromDisk(statusCodebasePath, diskInfo);
                    status = diskInfo.status;
                    info = diskInfo;
                }
            }

            // Dev-aware fallback: when the snapshot says not_found or indexfailed,
            // check the real Milvus state. The collection may have been indexed
            // successfully but the snapshot was corrupted by a race.
            if (status === 'not_found' || status === 'indexfailed') {
                const devCol = this.context.getDevCollectionName(absolutePath);
                const rootCol = this.context.getRootCollectionName(absolutePath);
                const vdbStatus = this.context.getVectorDatabase();
                const [devExists, rootExists] = await Promise.all([
                    vdbStatus.hasCollection(devCol).catch(() => false),
                    vdbStatus.hasCollection(rootCol).catch(() => false),
                ]);
                if (devExists) {
                    const stats = await this.queryCollectionStats(absolutePath);
                    if (stats) {
                        console.warn(`[STATUS] Found dev collection '${devCol}', recovering snapshot`);
                        this.snapshotManager.setCodebaseIndexed(absolutePath, { ...stats, status: 'completed' as const });
                        await this.snapshotManager.saveCodebaseSnapshot();
                        statusCodebasePath = absolutePath;
                        status = this.snapshotManager.getCodebaseStatus(statusCodebasePath);
                        info = this.snapshotManager.getCodebaseInfo(statusCodebasePath);
                    } else if (rootExists) {
                        info = { status: 'indexed', localPath: absolutePath, indexedFiles: 0, totalChunks: 0, indexStatus: 'completed', lastUpdated: new Date().toISOString() } as any;
                        status = 'indexed';
                    }
                } else if (rootExists) {
                    info = { status: 'indexed', localPath: absolutePath, indexedFiles: 0, totalChunks: 0, indexStatus: 'completed', lastUpdated: new Date().toISOString() } as any;
                    status = 'indexed';
                }
            }

            let statusMessage = '';

            switch (status) {
                case 'indexed':
                    if (info && info.status === 'indexed') {
                        const indexedInfo = info as CodebaseInfoIndexed;
                        statusMessage = `✅ Codebase '${statusCodebasePath}' is fully indexed and ready for search.`;
                        statusMessage += `\n📊 Statistics: ${indexedInfo.indexedFiles} files, ${indexedInfo.totalChunks} chunks`;
                        statusMessage += `\n📅 Status: ${indexedInfo.indexStatus}`;
                        statusMessage += `\n🕐 Last updated: ${new Date(indexedInfo.lastUpdated).toLocaleString()}`;
                    } else {
                        statusMessage = `✅ Codebase '${statusCodebasePath}' is fully indexed and ready for search.`;
                    }
                    break;

                case 'indexing':
                    if (info && info.status === 'indexing') {
                        const indexingInfo = info as CodebaseInfoIndexing;
                        const progressPercentage = indexingInfo.indexingPercentage || 0;
                        statusMessage = `🔄 Codebase '${statusCodebasePath}' is currently being indexed. Progress: ${progressPercentage.toFixed(1)}%`;

                        // Add more detailed status based on progress
                        if (progressPercentage < 10) {
                            statusMessage += ' (Preparing and scanning files...)';
                        } else if (progressPercentage < 100) {
                            statusMessage += ' (Processing files and generating embeddings...)';
                        }
                        statusMessage += `\n🕐 Last updated: ${new Date(indexingInfo.lastUpdated).toLocaleString()}`;
                    } else {
                        statusMessage = `🔄 Codebase '${statusCodebasePath}' is currently being indexed.`;
                    }
                    break;

                case 'indexfailed':
                    if (info && info.status === 'indexfailed') {
                        const failedInfo = info as CodebaseInfoIndexFailed;
                        statusMessage = `❌ Codebase '${statusCodebasePath}' indexing failed.`;
                        statusMessage += `\n🚨 Error: ${failedInfo.errorMessage}`;
                        if (failedInfo.lastAttemptedPercentage !== undefined) {
                            statusMessage += `\n📊 Failed at: ${failedInfo.lastAttemptedPercentage.toFixed(1)}% progress`;
                        }
                        statusMessage += `\n🕐 Failed at: ${new Date(failedInfo.lastUpdated).toLocaleString()}`;
                        statusMessage += `\n💡 You can retry indexing by running the index_codebase command again.`;
                    } else {
                        statusMessage = `❌ Codebase '${statusCodebasePath}' indexing failed. You can retry indexing.`;
                    }
                    break;

                case 'not_found':
                default:
                    statusMessage = `❌ Codebase '${absolutePath}' is not indexed. Please use the index_codebase tool to index it first.`;
                    break;
            }

            const pathInfo = codebasePath !== absolutePath
                ? `\nNote: Input path '${codebasePath}' was resolved to absolute path '${absolutePath}'`
                : '';
            const matchedPathInfo = statusCodebasePath !== absolutePath
                ? `\nRequested path '${absolutePath}' is covered by tracked codebase '${statusCodebasePath}'.`
                : '';

            return {
                content: [{
                    type: "text",
                    text: statusMessage + pathInfo + matchedPathInfo
                }]
            };

        } catch (error: any) {
            return {
                content: [{
                    type: "text",
                    text: `Error getting indexing status: ${error.message || error}`
                }],
                isError: true
            };
        }
    }

    // ── Graph Context Enrichment ──────────────────────────────────
    /**
     * Enrich vector search results with knowledge graph context:
     * callers, callees, architectural position, and dead code detection.
     * Returns a formatted string to append to the result message.
     */
    /**
     * Lazily bring the LOCAL knowledge graph up to date with the SHARED cloud
     * vector index. The vector index is reused across the team (keyed by repo
     * URL+branch), but the graph lives in local SQLite — so a repo indexed by a
     * teammate (or on another machine) shows up here with an empty graph and no
     * graph enrichment. When we detect that, we fire a background full graph
     * build. Non-blocking; guarded to run at most once per project per session
     * and skipped if a build is already in progress or the graph already exists.
     */
    private maybeAutoBuildGraphIndex(codebasePath: string): void {
        if (!this.graphToolHandlers) return;

        let project: string;
        try {
            project = getRepoIdentity(codebasePath);
        } catch {
            return; // Not a resolvable repo — nothing to key a graph on.
        }

        if (this.autoGraphBuildTriggered.has(project)) return;
        // A build is already running (via handleIndex or an earlier trigger).
        if (this.graphToolHandlers.getIndexingProgress(project)) return;

        let stats: { nodes: number; edges: number };
        try {
            stats = this.graphToolHandlers.getStore().getProjectStats(project);
        } catch {
            return;
        }
        if (stats.nodes > 0) return; // Local graph already present.

        // Mark before firing so concurrent searches never double-trigger. We
        // intentionally keep it marked even on failure: retrying every search
        // would hammer a genuinely unindexable repo. A new session retries.
        this.autoGraphBuildTriggered.add(project);
        console.log(`[GRAPH-AUTO] Local graph empty for '${project}', building in background to match the shared vector index...`);
        setImmediate(async () => {
            try {
                await this.graphToolHandlers!.handleIndexRepository({
                    repo_path: codebasePath,
                    mode: 'full',
                });
                console.log(`[GRAPH-AUTO] Background graph build complete for '${project}'`);
            } catch (e: any) {
                console.warn(`[GRAPH-AUTO] Background graph build failed for '${project}': ${e?.message || e}`);
            }
        });
    }

    private enrichWithGraphContextDeep(
        searchResults: any[],
        codebasePath: string,
        query: string,
    ): string {
        const store = this.graphToolHandlers!.getStore();
        const project = getRepoIdentity(codebasePath);
        const lines: string[] = [];
        const seenSymbols = new Set<string>();

        // Extract query keywords for symbol relevance filtering.
        const queryWords = query.toLowerCase().split(/[\s_\-.,:;!?/\\()\[\]{}]+/).filter((w: string) => w.length > 1);
        // heuristics for the top N matched files (reduced from 10 to avoid noise)
        const maxFiles = 5;
        const perFileLimit = 12;

        // Collect unique file paths
        const seenFiles = new Set<string>();
        for (const result of searchResults.slice(0, maxFiles)) {
            seenFiles.add(result.relativePath);
        }

        // === Layer 1: Direct call relationships (query-keyword filtered) ===
        const allNodeIds = new Set<number>();
        const fileNodes: Array<{ node: any; filePath: string }> = [];

        for (const filePath of seenFiles) {
            const normalizedPath = filePath.replace(/^\/+/, '');
            let nodeResult = store.findNodes({
                project,
                exactFilePath: normalizedPath,
                limit: perFileLimit,
            });
            if (nodeResult.results.length === 0 && normalizedPath !== filePath) {
                nodeResult = store.findNodes({
                    project,
                    exactFilePath: filePath,
                    limit: perFileLimit,
                });
            }
            for (const r of nodeResult.results) {
                const label = r.node.label;
                // Drop noise: interfaces, types, variables — only keep callable symbols
                if (label !== 'Function' && label !== 'Method' && label !== 'Class') continue;
                // Drop unused symbols entirely
                const nodeId = r.node.id;
                // Quick check: if the symbol name contains any query keyword, or if
                // it's in a hit file from search (always top-N results context)
                const nameLower = r.node.name.toLowerCase();
                const relevant = queryWords.length === 0 || queryWords.some((w: string) => nameLower.includes(w));
                if (relevant) {
                    fileNodes.push({ node: r.node, filePath: normalizedPath });
                    allNodeIds.add(nodeId);
                }
            }
        }

        if (fileNodes.length === 0) return '';

        // Batch edges
        const nodeIdsArr = fileNodes.map(f => f.node.id);
        const allCallerEdges = store.getEdgesByTargetBatch(nodeIdsArr, 'CALLS');
        const allCalleeEdges = store.getEdgesBySourceBatch(nodeIdsArr);

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

            const callerNames = callerEdges.slice(0, 2).map((e) => {
                const caller = nodeMap.get(e.sourceId);
                return caller ? caller.name : '?';
            });
            const calleeNames = calleeEdges.slice(0, 2).map((e) => {
                const callee = nodeMap.get(e.targetId);
                return callee ? callee.name : '?';
            });

            let line = `\`${node.name}\``;
            if (callerNames.length > 0) line += ` ← ${callerNames.join(', ')}`;
            if (calleeNames.length > 0) line += ` → ${calleeNames.join(', ')}`;
            if (callerEdges.length === 0 && calleeEdges.length === 0) continue; // skip truly isolated
            line += `  (${node.filePath}:${node.startLine})`;
            directRelations.push(line);
        }

        if (directRelations.length > 0) {
            lines.push('### Calls');
            lines.push(...directRelations.map(l => `- ${l}`));
            lines.push('');
        }

        // === Layer 2: Architecture (compact, once per session) ===
        if (!this.architectureEmitted.has(project)) {
          try {
            const archResult = this.graphToolHandlers!.handleGetArchitecture({ project });
            const archText = archResult.content[0]?.text || '';
            const archLines = archText.split('\n');
            const summary: string[] = [];
            let inEntry = false, inCluster = false, entryCount = 0, clusterCount = 0;
            for (const line of archLines) {
                if (line.startsWith('Entry points')) { inEntry = true; summary.push(line); continue; }
                if (inEntry && line.startsWith('  -') && entryCount < 5) { summary.push(line); entryCount++; continue; }
                if (inEntry && !line.startsWith('  -')) inEntry = false;
                if (line.startsWith('Clusters')) { inCluster = true; summary.push(line); continue; }
                if (inCluster && line.startsWith('  ') && clusterCount < 3) { summary.push(line); clusterCount++; continue; }
                if (inCluster && clusterCount >= 3) inCluster = false;
            }
            if (summary.length > 0) {
                lines.push('### Architecture');
                lines.push(...summary);
                lines.push('');
            }
            this.architectureEmitted.add(project);
          } catch {}
        }

        return lines.length > 0 ? '\n' + lines.join('\n') : '';
    }
} 
