import * as fs from "fs";
import * as path from "path";
import { Context, COLLECTION_LIMIT_MESSAGE, FileSynchronizer, IndexAbortError, getRepoIdentity } from "@zilliz/claude-context-core";
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

    constructor(context: Context, snapshotManager: SnapshotManager, graphToolHandlers?: GraphToolHandlers) {
        this.context = context;
        this.snapshotManager = snapshotManager;
        this.graphToolHandlers = graphToolHandlers || null;
        this.currentWorkspace = process.cwd();
        console.log(`[WORKSPACE] Current workspace: ${this.currentWorkspace}`);
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
            // rowCount is chunk count, not file count (typically 10-100x larger).
            // Without a metadata query we don't have the real file count;
            // the snapshot will be corrected on the next full index.
            // Using rowCount for both is imprecise but keeps the state
            // non-zero so the client doesn't misread it as empty.
            return { indexedFiles: rowCount, totalChunks: rowCount };
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
                this.snapshotManager.saveCodebaseSnapshot();
            }
            if (checked > 0) {
                console.log(`[SNAPSHOT-VALIDATE] Done — checked=${checked} healed=${healed} removed=${removed} skipped=${skipped}`);
            }
        } catch (error) {
            console.warn(`[SNAPSHOT-VALIDATE] Unexpected error during legacy 0/0 validation (non-fatal):`, error);
        }
    }

    /**
     * Sync indexed codebases from Zilliz Cloud collections
     * This method fetches all collections from the vector database,
     * extracts codebasePath from collection description (preferred) or falls back
     * to querying document metadata for old collections,
     * and updates the snapshot with discovered codebases.
     *
     * Logic: Compare mcp-codebase-snapshot.json with zilliz cloud collections
     * - If local snapshot has extra directories (not in cloud), remove them
     * - If local snapshot is missing directories (exist in cloud), ignore them
     */
    private async syncIndexedCodebasesFromCloud(): Promise<void> {
        try {
            // Clear stale identity cache before syncing (handles remote URL/branch changes)
            this.snapshotManager.clearIdentityCache();
            console.log(`[SYNC-CLOUD] 🔄 Syncing indexed codebases from Zilliz Cloud...`);

            // Get all collections using the interface method
            const vectorDb = this.context.getVectorDatabase();

            // Use the new listCollections method from the interface
            const collections = await vectorDb.listCollections();

            console.log(`[SYNC-CLOUD] 📋 Found ${collections.length} collections in Zilliz Cloud`);

            if (collections.length === 0) {
                console.log(`[SYNC-CLOUD] ✅ No collections found in cloud. Skipping deletion of local codebases to avoid data loss from transient errors.`);
                return;
            }

            const cloudCodebases = new Set<string>();
            let codeCollectionsChecked = 0;
            let successfulExtractions = 0;

            // Check each collection for codebase path
            for (const collectionName of collections) {
                try {
                    // Skip collections that don't match the code_chunks pattern (support both legacy and new collections)
                    if (!collectionName.startsWith('code_chunks_') && !collectionName.startsWith('hybrid_code_chunks_')) {
                        console.log(`[SYNC-CLOUD] ⏭️  Skipping non-code collection: ${collectionName}`);
                        continue;
                    }

                    codeCollectionsChecked++;
                    console.log(`[SYNC-CLOUD] 🔍 Checking collection: ${collectionName}`);

                    // Try to extract codebasePath from collection description first (new format)
                    let extracted = false;
                    try {
                        const description = await vectorDb.getCollectionDescription(collectionName);
                        if (description && description.startsWith('codebasePath:')) {
                            const codebasePath = description.substring('codebasePath:'.length);
                            if (codebasePath.length > 0) {
                                console.log(`[SYNC-CLOUD] 📍 Found codebase path from description: ${codebasePath} in collection: ${collectionName}`);
                                cloudCodebases.add(codebasePath);
                                successfulExtractions++;
                                extracted = true;
                            }
                        }
                    } catch (descError: any) {
                        console.warn(`[SYNC-CLOUD] ⚠️  Failed to get description for collection ${collectionName}:`, descError.message || descError);
                    }

                    // Fallback: query document metadata for old collections without new description format
                    if (!extracted) {
                        console.log(`[SYNC-CLOUD] 🔄 Falling back to query-based extraction for collection: ${collectionName}`);
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
                                        console.log(`[SYNC-CLOUD] 📍 Found codebase path from query: ${codebasePath} in collection: ${collectionName}`);
                                        cloudCodebases.add(codebasePath);
                                        successfulExtractions++;
                                    } else {
                                        console.warn(`[SYNC-CLOUD] ⚠️  No codebasePath found in metadata for collection: ${collectionName}`);
                                    }
                                } else {
                                    console.warn(`[SYNC-CLOUD] ⚠️  No metadata found in collection: ${collectionName}`);
                                }
                            } else {
                                console.log(`[SYNC-CLOUD] ℹ️  Collection ${collectionName} is empty`);
                            }
                        } catch (queryError: any) {
                            console.warn(`[SYNC-CLOUD] ⚠️  Fallback query failed for collection ${collectionName}:`, queryError.message || queryError);
                        }
                    }
                } catch (collectionError: any) {
                    console.warn(`[SYNC-CLOUD] ⚠️  Error checking collection ${collectionName}:`, collectionError.message || collectionError);
                    // Continue with next collection
                }
            }

            console.log(`[SYNC-CLOUD] 📊 Found ${cloudCodebases.size} valid codebases in cloud (checked ${codeCollectionsChecked} code collections, ${successfulExtractions} successfully extracted)`);

            // Safety guard: if we checked code collections but none returned results,
            // treat this as an extraction failure rather than "cloud is empty".
            // This prevents deleting all local codebases due to transient errors.
            if (codeCollectionsChecked > 0 && successfulExtractions === 0) {
                console.warn(`[SYNC-CLOUD] ⚠️  All ${codeCollectionsChecked} code collection extractions failed. Skipping sync to avoid accidental deletion of local codebases.`);
                return;
            }

            // Get current local codebases with their identities.
            // getIndexedCodebases() now returns identities (url:branch).
            const localIdentities = this.snapshotManager.getIndexedCodebases();
            const localIdentityMap = new Map<string, string>(); // identity -> localPath
            for (const identity of localIdentities) {
                const info = this.snapshotManager.getCodebaseInfo(identity);
                if (info?.localPath) {
                    localIdentityMap.set(identity, info.localPath);
                }
            }
            console.log(`[SYNC-CLOUD] 📊 Found ${localIdentities.length} local codebases in snapshot`);

            let hasChanges = false;

            // Remove local codebases whose identity is not in the cloud set.
            // Compare by identity (url:branch) rather than raw filesystem path,
            // so team members sharing the same repo+branch are recognized.
            for (const [identity, localPath] of localIdentityMap) {
                if (!cloudCodebases.has(identity)) {
                    this.snapshotManager.removeCodebaseCompletely(localPath);
                    hasChanges = true;

                    try {
                        await FileSynchronizer.deleteSnapshot(localPath);
                    } catch (error: any) {
                        console.warn(`[SYNC-CLOUD] ⚠️  Failed to delete local merkle snapshot for removed codebase '${localPath}':`, error?.message || error);
                    }

                    console.log(`[SYNC-CLOUD] ➖ Removed local codebase (not in cloud): ${localPath} (identity: ${identity})`);
                }
            }

            // Add cloud codebases that are missing from local snapshot (recovery).
            // We can only recover if the cloud identity maps to a local checkout.
            // Otherwise we rely on the Milvus fallback in search/status handlers.
            for (const cloudIdentity of cloudCodebases) {
                if (!localIdentityMap.has(cloudIdentity)) {
                    console.log(`[SYNC-CLOUD] ⏭️  Cloud codebase '${cloudIdentity}' has no local checkout — will be resolved via Milvus fallback on demand`);
                    continue;
                }

                const localPath = localIdentityMap.get(cloudIdentity)!;
                const stats = await this.queryCollectionStats(localPath);
                if (stats) {
                    this.snapshotManager.setCodebaseIndexed(localPath, {
                        ...stats,
                        status: 'completed' as const
                    });
                    hasChanges = true;
                    console.log(`[SYNC-CLOUD] ➕ Recovered codebase from cloud: ${localPath} (identity: ${cloudIdentity}, rows=${stats.totalChunks})`);
                } else {
                    console.log(`[SYNC-CLOUD] ⏭️  Skipped recovery for ${localPath} (row count unknown or zero)`);
                }
            }

            if (hasChanges) {
                this.snapshotManager.saveCodebaseSnapshot();
                console.log(`[SYNC-CLOUD] 💾 Updated snapshot to match cloud state`);
            } else {
                console.log(`[SYNC-CLOUD] ✅ Local snapshot already matches cloud state`);
            }

            console.log(`[SYNC-CLOUD] ✅ Cloud sync completed successfully`);
        } catch (error: any) {
            console.error(`[SYNC-CLOUD] ❌ Error syncing codebases from cloud:`, error.message || error);
            // Don't throw - this is not critical for the main functionality
        }
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

        // If vector indexing returned an error, skip graph indexing
        if (vectorResult.isError) {
            return vectorResult;
        }

        // 2. Graph indexing — run in background after response
        if (this.graphToolHandlers) {
            const project = getRepoIdentity(absolutePath);
            const stats = this.graphToolHandlers.getStore().getProjectStats(project);
            const alreadyGraphIndexed = stats.nodes > 0;

            // Defer graph indexing to background to avoid blocking MCP response
            setImmediate(async () => {
                try {
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
                            await this.graphToolHandlers!.handleIndexRepository({
                                repo_path: absolutePath,
                                mode: 'incremental',
                                files: changedFiles,
                            });
                            console.log(`[INDEX] Incremental graph index complete (${changedFiles.length} files)`);
                        } else {
                            console.log(`[INDEX] No changes detected for '${project}', skipping graph indexing`);
                        }
                    } else {
                        await this.graphToolHandlers!.handleIndexRepository({
                            repo_path: absolutePath,
                            mode: graphMode,
                        });
                        console.log(`[INDEX] Graph indexing completed for '${project}'`);
                    }
                } catch (e: any) {
                    console.warn(`[INDEX] Graph indexing failed (non-fatal): ${e.message}`);
                }
            });

            const vectorText = vectorResult.content[0]?.text || '';
            const graphNote = alreadyGraphIndexed && !args.force
                ? `\n\n[Graph] Already indexed: ${stats.nodes} nodes, ${stats.edges} edges (checking for changes in background)`
                : `\n\n[Graph] Indexing in background...`;
            return {
                ...vectorResult,
                content: [{ type: 'text', text: vectorText + graphNote }],
            };
        }

        return vectorResult;
    }

    public async handleIndexCodebase(args: any) {
        const { path: codebasePath = ".", force, splitter, customExtensions, ignorePatterns } = args;
        const forceReindex = force || false;
        const requestedSplitter = splitter || 'ast'; // Default to AST
        const customFileExtensions = customExtensions || [];
        const customIgnorePatterns = ignorePatterns || [];

        try {
            // Sync indexed codebases from cloud first
            await this.syncIndexedCodebasesFromCloud();

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

            // === CRITICAL: Pre-check identity in vector database ===
            // The index is isolated by url+branch, not by filesystem path.
            // Check if this identity already has a collection in Milvus before
            // proceeding. If it does, recover the local snapshot and inform the user.
            if (!forceReindex) {
                const identityAlreadyIndexed = await this.context.hasIndex(absolutePath);
                if (identityAlreadyIndexed) {
                    // The identity-based collection exists in Milvus.
                    // Check if the local snapshot knows about it.
                    const snapshotHasIdentity = this.snapshotManager.getIndexedCodebases().includes(codebaseIdentity);
                    if (!snapshotHasIdentity) {
                        // Recover snapshot from Milvus
                        const stats = await this.queryCollectionStats(absolutePath);
                        if (stats) {
                            console.warn(`[IDENTITY-CHECK] Identity '${codebaseIdentity}' already indexed in Milvus but missing from local snapshot. Recovering snapshot.`);
                            this.snapshotManager.setCodebaseIndexed(absolutePath, { ...stats, status: 'completed' as const });
                            this.snapshotManager.saveCodebaseSnapshot();
                        }
                    }

                    // Check if this is a different local path for the same identity
                    const existingInfo = this.snapshotManager.getCodebaseInfo(codebaseIdentity);
                    const existingLocalPath = existingInfo?.localPath;
                    const isSameLocalPath = existingLocalPath && path.resolve(existingLocalPath) === path.resolve(absolutePath);

                    let alreadyMessage = `Repository '${codebaseIdentity}' is already indexed.`;
                    if (!isSameLocalPath && existingLocalPath) {
                        alreadyMessage += `\nExisting index is for local checkout at: ${existingLocalPath}`;
                        alreadyMessage += `\nCurrent path: ${absolutePath}`;
                        alreadyMessage += `\n\nBoth paths map to the same repository (url+branch), so the index is shared. Use force=true to re-index.`;
                    } else {
                        alreadyMessage += ` Use force=true to re-index.`;
                    }
                    return {
                        content: [{
                            type: "text",
                            text: alreadyMessage
                        }],
                        isError: true
                    };
                }
            }

            // Check if already indexing (compare by identity: url:branch)
            let alreadyCleared = false;
            if (this.snapshotManager.getIndexingCodebases().includes(codebaseIdentity)) {
                if (forceReindex) {
                    console.log(`[FORCE-REINDEX] Clearing stale indexing state for '${absolutePath}'`);
                    // Cancel the old indexing task and wait for it to finish
                    const oldTask = this.indexingTasks.get(absolutePath);
                    if (oldTask) {
                        oldTask.controller.abort();
                        try { await oldTask.promise; } catch { /* aborted */ }
                        this.indexingTasks.delete(absolutePath);
                    }
                    this.snapshotManager.removeCodebaseCompletely(absolutePath);
                    this.snapshotManager.saveCodebaseSnapshot();
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

            //Check if the snapshot and cloud index are in sync (compare by identity)
            // Skip consistency check when forceReindex already cleared the snapshot
            if (!alreadyCleared) {
                const snapshotHasIndex = this.snapshotManager.getIndexedCodebases().includes(codebaseIdentity);
                const vectorDbHasIndex = await this.context.hasIndex(absolutePath);
                if (snapshotHasIndex !== vectorDbHasIndex) {
                    if (vectorDbHasIndex && !snapshotHasIndex) {
                        // Query Milvus for real row count. If unknown/empty, log and move on
                        // without writing 0/0+completed (which would trigger the force-reindex
                        // loop in Issue #295). The user is about to (re)index anyway.
                        const stats = await this.queryCollectionStats(absolutePath);
                        if (stats) {
                            console.warn(`[INDEX-VALIDATION] Recovering missing snapshot for '${absolutePath}' (rows=${stats.totalChunks})`);
                            this.snapshotManager.setCodebaseIndexed(absolutePath, { ...stats, status: 'completed' as const });
                            this.snapshotManager.saveCodebaseSnapshot();
                        } else {
                            console.warn(`[INDEX-VALIDATION] VectorDB reports index for '${absolutePath}' but row count unknown/zero — not writing snapshot entry`);
                        }
                    } else if (!vectorDbHasIndex && snapshotHasIndex) {
                        console.warn(`[INDEX-VALIDATION] Clearing stale snapshot for '${absolutePath}'`);
                        this.snapshotManager.removeCodebaseCompletely(absolutePath);
                        this.snapshotManager.saveCodebaseSnapshot();
                    }
                }
            }

            // Check if already indexed (compare by identity, unless force is true)
            if (!forceReindex && this.snapshotManager.getIndexedCodebases().includes(codebaseIdentity)) {
                return {
                    content: [{
                        type: "text",
                        text: `Codebase '${absolutePath}' is already indexed. Use force=true to re-index.`
                    }],
                    isError: true
                };
            }

            // If force reindex and codebase is already indexed, remove it
            if (forceReindex) {
                if (!alreadyCleared) {
                    this.snapshotManager.removeCodebaseCompletely(absolutePath);
                    this.snapshotManager.saveCodebaseSnapshot();
                }
                if (await this.context.hasIndex(absolutePath)) {
                    console.log(`[FORCE-REINDEX] 🔄 Clearing index for '${absolutePath}'`);
                    await this.context.clearIndex(absolutePath);
                }
            }

            // CRITICAL: Pre-index collection creation validation
            try {
                console.log(`[INDEX-VALIDATION] 🔍 Validating collection creation capability`);
                const canCreateCollection = await this.context.getVectorDatabase().checkCollectionLimit();

                if (!canCreateCollection) {
                    console.error(`[INDEX-VALIDATION] ❌ Collection limit validation failed: ${absolutePath}`);

                    // CRITICAL: Immediately return the COLLECTION_LIMIT_MESSAGE to MCP client
                    return {
                        content: [{
                            type: "text",
                            text: COLLECTION_LIMIT_MESSAGE
                        }],
                        isError: true
                    };
                }

                console.log(`[INDEX-VALIDATION] ✅  Collection creation validation completed`);
            } catch (validationError: any) {
                // Handle other collection creation errors
                console.error(`[INDEX-VALIDATION] ❌ Collection creation validation failed:`, validationError);
                return {
                    content: [{
                        type: "text",
                        text: `Error validating collection creation: ${validationError.message || validationError}`
                    }],
                    isError: true
                };
            }

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
            this.snapshotManager.saveCodebaseSnapshot();

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

            // Initialize file synchronizer with proper ignore patterns (including project-specific patterns)
            console.log(`[BACKGROUND-INDEX] Using ignore patterns: ${ignorePatterns.join(', ')}`);
            if (customFileExtensions.length > 0) {
                console.log(`[BACKGROUND-INDEX] Using ${customFileExtensions.length} request-scoped custom extensions: ${customFileExtensions.join(', ')}`);
            }
            const synchronizer = new FileSynchronizer(absolutePath, ignorePatterns, supportedExtensions);
            await synchronizer.initialize();

            // Store synchronizer in the context (let context manage collection names)
            await this.context.getPreparedCollection(absolutePath);
            const collectionName = this.context.getCollectionName(absolutePath);
            this.context.setSynchronizer(collectionName, synchronizer);

            console.log(`[BACKGROUND-INDEX] Starting indexing with ${splitterType} splitter for: ${absolutePath}`);

            // Log embedding provider information before indexing
            const embeddingProvider = this.context.getEmbedding();
            console.log(`[BACKGROUND-INDEX] 🧠 Using embedding provider: ${embeddingProvider.getProvider()} with dimension: ${embeddingProvider.getDimension()}`);

            // Start indexing with the appropriate context and progress tracking
            console.log(`[BACKGROUND-INDEX] 🚀 Beginning codebase indexing process...`);
            const stats = await this.context.indexCodebase(absolutePath, (progress) => {
                // Update progress in snapshot manager using new method
                this.snapshotManager.setCodebaseIndexing(absolutePath, progress.percentage);

                // Save snapshot periodically (every 2 seconds to avoid too frequent saves)
                const currentTime = Date.now();
                if (currentTime - lastSaveTime >= 2000) { // 2 seconds = 2000ms
                    this.snapshotManager.saveCodebaseSnapshot();
                    lastSaveTime = currentTime;
                    console.log(`[BACKGROUND-INDEX] 💾 Saved progress snapshot at ${progress.percentage.toFixed(1)}%`);
                }

                console.log(`[BACKGROUND-INDEX] Progress: ${progress.phase} - ${progress.percentage}% (${progress.current}/${progress.total})`);
            }, forceReindex, customIgnorePatterns, customFileExtensions, requestSplitter, signal);
            console.log(`[BACKGROUND-INDEX] ✅ Indexing completed successfully! Files: ${stats.indexedFiles}, Chunks: ${stats.totalChunks}`);

            // Set codebase to indexed status with complete statistics
            this.snapshotManager.setCodebaseIndexed(absolutePath, stats, indexOptions);

            // Save snapshot after updating codebase lists
            this.snapshotManager.saveCodebaseSnapshot();

            let message = `Background indexing completed for '${absolutePath}' using ${splitterType.toUpperCase()} splitter.\nIndexed ${stats.indexedFiles} files, ${stats.totalChunks} chunks.`;
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
            this.snapshotManager.saveCodebaseSnapshot();

            // Log error but don't crash MCP service - indexing errors are handled gracefully
            console.error(`[BACKGROUND-INDEX] Indexing failed for ${absolutePath}: ${errorMessage}`);
        }
    }

    public async handleSearchCode(args: any) {
        const { path: codebasePath = ".", query, limit = 10, extensionFilter } = args;
        const resultLimit = limit || 10;

        try {
            // Sync indexed codebases from cloud first
            await this.syncIndexedCodebasesFromCloud();

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

            // Check if this codebase is indexed or being indexed
            const indexedCodebasePath = this.snapshotManager.findIndexedCodebasePath(absolutePath);
            const indexingCodebasePath = this.snapshotManager.findIndexingCodebasePath(absolutePath);
            // Prefer indexed over indexing (identity-based lookup, no need for path length sort)
            const matchedCodebase = indexedCodebasePath || indexingCodebasePath;
            let searchCodebasePath = matchedCodebase || absolutePath;
            let isIndexed = indexedCodebasePath === searchCodebasePath;
            const isIndexing = indexingCodebasePath === searchCodebasePath;

            if (!isIndexed && !isIndexing) {
                // Fallback: check VectorDB directly in case snapshot is out of sync.
                // Only recover the snapshot when we can confirm a real row count —
                // writing 0/0+completed for an unverifiable collection poisons the
                // client into a force-reindex loop (Issue #295).
                const hasVectorIndex = await this.context.hasIndex(absolutePath);
                if (hasVectorIndex) {
                    const stats = await this.queryCollectionStats(absolutePath);
                    if (stats) {
                        console.warn(`[SEARCH] Snapshot missing but VectorDB has index for '${absolutePath}', recovering snapshot (rows=${stats.totalChunks})`);
                        this.snapshotManager.setCodebaseIndexed(absolutePath, { ...stats, status: 'completed' as const });
                        this.snapshotManager.saveCodebaseSnapshot();
                        searchCodebasePath = absolutePath;
                        isIndexed = true;
                        // Continue with search (don't return error)
                    } else {
                        return {
                            content: [{
                                type: "text",
                                text: `Error: Codebase '${absolutePath}' is not indexed. Please index it first using the index_codebase tool.`
                            }],
                            isError: true
                        };
                    }
                } else {
                    return {
                        content: [{
                            type: "text",
                            text: `Error: Codebase '${absolutePath}' is not indexed. Please index it first using the index_codebase tool.`
                        }],
                        isError: true
                    };
                }
            }

            // Show indexing status if codebase is being indexed
            let indexingStatusMessage = '';
            if (isIndexing) {
                indexingStatusMessage = `\n⚠️  **Indexing in Progress**: This codebase is currently being indexed in the background. Search results may be incomplete until indexing completes.`;
            }

            console.log(`[SEARCH] Searching in codebase: ${searchCodebasePath}`);
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

            // Search in the specified codebase
            const searchResults = await this.context.semanticSearch(
                searchCodebasePath,
                query,
                Math.min(resultLimit, 50),
                0.3,
                filterExpr
            );

            console.log(`[SEARCH] ✅ Search completed! Found ${searchResults.length} results using ${embeddingProvider.getProvider()} embeddings`);

            if (searchResults.length === 0) {
                // Fallback: try graph search when vector search returns nothing
                if (this.graphToolHandlers && query.trim().length > 0) {
                    try {
                        const project = getRepoIdentity(searchCodebasePath);
                        const graphResult = this.graphToolHandlers.handleSearchGraph({
                            project,
                            query: query,
                            limit: 10,
                        });
                        const graphText = graphResult.content[0]?.text || '';
                        if (!graphText.includes('Found 0 results')) {
                            return {
                                content: [{
                                    type: 'text', text:
                                        `No vector search results. Found graph matches:\n\n${graphText}`
                                }]
                            };
                        }
                    } catch { }
                }

                // Check if collection was lost (indexed locally but missing in Milvus)
                if (isIndexed && !isIndexing) {
                    const collectionName = this.context.getCollectionName(searchCodebasePath);
                    const hasCollection = await this.context.getVectorDatabase().hasCollection(collectionName);
                    if (!hasCollection) {
                        return {
                            content: [{ type: "text", text: `Error: Index data for '${searchCodebasePath}' has been lost (collection not found in Milvus). Please re-index using index_codebase with force=true.` }],
                            isError: true
                        };
                    }
                }

                let noResultsMessage = `No results found for query: "${query}" in codebase '${searchCodebasePath}'`;
                if (searchCodebasePath !== absolutePath) {
                    noResultsMessage += `\nRequested path '${absolutePath}' is covered by indexed codebase '${searchCodebasePath}'.`;
                }
                if (isIndexing) {
                    noResultsMessage += `\n\nNote: This codebase is still being indexed. Try searching again after indexing completes, or the query may not match any indexed content.`;
                }
                return {
                    content: [{
                        type: "text",
                        text: noResultsMessage
                    }]
                };
            }

            // Format results
            const formattedResults = searchResults.map((result: any, index: number) => {
                const location = `${result.relativePath}:${result.startLine}-${result.endLine}`;
                const context = truncateContent(result.content, 5000);
                const codebaseInfo = path.basename(searchCodebasePath);

                return `${index + 1}. Code snippet (${result.language}) [${codebaseInfo}]\n` +
                    `   Location: ${location}\n` +
                    `   Rank: ${index + 1}\n` +
                    `   Context: \n\`\`\`${result.language}\n${context}\n\`\`\`\n`;
            }).join('\n');

            let resultMessage = `Found ${searchResults.length} results for query: "${query}" in codebase '${searchCodebasePath}'${indexingStatusMessage}`;
            if (searchCodebasePath !== absolutePath) {
                resultMessage += `\nRequested path '${absolutePath}' is covered by indexed codebase '${searchCodebasePath}'.`;
            }
            resultMessage += `\n\n${formattedResults}`;

            // ── Graph Context Enrichment (deep 3-layer) ──────────────────
            if (this.graphToolHandlers) {
                try {
                    resultMessage += this.enrichWithGraphContextDeep(
                        searchResults,
                        searchCodebasePath,
                    );
                } catch (graphErr: any) {
                    console.warn(`[SEARCH] Graph enrichment failed: ${graphErr.message}`);
                }
            }

            if (isIndexing) {
                resultMessage += `\n\n💡 **Tip**: This codebase is still being indexed. More results may become available as indexing progresses.`;
            }

            return {
                content: [{
                    type: "text",
                    text: resultMessage
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

            // Compare by identity (url:branch), not by absolute path
            const codebaseIdentity = getRepoIdentity(absolutePath);
            const isIndexed = this.snapshotManager.getIndexedCodebases().includes(codebaseIdentity);
            const isIndexing = this.snapshotManager.getIndexingCodebases().includes(codebaseIdentity);

            if (!isIndexed && !isIndexing) {
                return {
                    content: [{
                        type: "text",
                        text: `Error: Codebase '${absolutePath}' (identity: ${codebaseIdentity}) is not indexed or being indexed.`
                    }],
                    isError: true
                };
            }

            console.log(`[CLEAR] Clearing codebase: ${absolutePath}`);

            // Cancel any in-flight background indexing for this codebase and
            // wait for it to wind down before we drop the collection.
            // Otherwise the background task keeps embedding chunks and writes
            // them into the just-cleared collection (issue #199).
            const activeTask = this.indexingTasks.get(absolutePath);
            if (activeTask) {
                console.log(`[CLEAR] Cancelling in-flight background indexing for: ${absolutePath}`);
                activeTask.controller.abort();
                try {
                    await activeTask.promise;
                } catch (waitError: any) {
                    // startBackgroundIndexing already logs and never re-throws,
                    // so this catch only guards against future refactors.
                    console.warn(`[CLEAR] Background indexing wind-down reported: ${waitError?.message || waitError}`);
                }
                this.indexingTasks.delete(absolutePath);
            }

            try {
                await this.context.clearIndex(absolutePath);
                console.log(`[CLEAR] Successfully cleared vector index for: ${absolutePath}`);
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

            // Also clear the graph index to keep vector + graph in sync
            if (this.graphToolHandlers) {
                try {
                    this.graphToolHandlers.getStore().beginTransaction();
                    this.graphToolHandlers.getStore().deleteProject(codebaseIdentity);
                    this.graphToolHandlers.getStore().commitTransaction();
                    console.log(`[CLEAR] Successfully cleared graph index for: ${codebaseIdentity}`);
                } catch (graphError: any) {
                    console.warn(`[CLEAR] Failed to clear graph index for '${codebaseIdentity}': ${graphError.message}`);
                    // Non-fatal: vector index is already cleared, graph data can be cleaned up later
                }
            }

            // Completely remove the cleared codebase from snapshot
            this.snapshotManager.removeCodebaseCompletely(absolutePath);

            // Save snapshot after clearing index
            this.snapshotManager.saveCodebaseSnapshot();

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

                lines.push('## Graph Index (SQLite)');
                lines.push(`  Nodes: ${stats.nodes} | Edges: ${stats.edges}`);

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

            await this.syncIndexedCodebasesFromCloud();

            // Check indexing status using new status system.
            //
            // Resolve the tracked path with the same disk-backed lookups that
            // search uses (findIndexedCodebasePath/findIndexingCodebasePath read
            // the JSON file), falling back to the in-memory tracked path. This
            // matters because getCodebaseStatus/getCodebaseInfo read the in-memory
            // codebaseInfoMap, which can lag behind the on-disk snapshot when the
            // repo was indexed by another process/MCP client, or when this process
            // loaded its map before the entry was written — exactly the case where
            // search succeeds but status falsely reports "not indexed".
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

            // Fallback: the snapshot is keyed by filesystem path, but the Milvus
            // collection is keyed by url+branch identity. When neither the in-memory
            // map nor the on-disk snapshot has an entry we must still consult the
            // VectorDB — the same recovery handleSearchCode does — so the status
            // stays consistent with the actual url+branch-isolated collection.
            if (status === 'not_found') {
                const hasVectorIndex = await this.context.hasIndex(absolutePath);
                if (hasVectorIndex) {
                    const stats = await this.queryCollectionStats(absolutePath);
                    if (stats) {
                        console.warn(`[STATUS] Snapshot missing but VectorDB has index for '${absolutePath}', recovering snapshot (rows=${stats.totalChunks})`);
                        this.snapshotManager.setCodebaseIndexed(absolutePath, { ...stats, status: 'completed' as const });
                        this.snapshotManager.saveCodebaseSnapshot();
                        statusCodebasePath = absolutePath;
                        status = this.snapshotManager.getCodebaseStatus(statusCodebasePath);
                        info = this.snapshotManager.getCodebaseInfo(statusCodebasePath);
                    }
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
    private enrichWithGraphContextDeep(
        searchResults: any[],
        codebasePath: string,
        maxContextFiles: number = 10,
    ): string {
        const store = this.graphToolHandlers!.getStore();
        const project = getRepoIdentity(codebasePath);
        const lines: string[] = [];
        const seenSymbols = new Set<string>();

        // Collect all unique file paths from search results
        const seenFiles = new Set<string>();
        for (const result of searchResults.slice(0, maxContextFiles)) {
            seenFiles.add(result.relativePath);
        }

        // === Layer 1: Direct call relationships (original logic) ===
        const directRelations: string[] = [];
        for (const filePath of seenFiles) {
            const normalizedPath = filePath.replace(/^\/+/, '');
            let nodeResult = store.findNodes({
                project,
                exactFilePath: normalizedPath,
                limit: 20,
            });
            if (nodeResult.results.length === 0 && normalizedPath !== filePath) {
                nodeResult = store.findNodes({
                    project,
                    exactFilePath: filePath,
                    limit: 20,
                });
            }
            if (nodeResult.results.length === 0) continue;

            for (const r of nodeResult.results) {
                const n = r.node;
                const key = n.qualifiedName;
                if (seenSymbols.has(key)) continue;
                seenSymbols.add(key);

                const callerEdges = store.getEdgesByTarget(n.id, 'CALLS');
                const calleeEdges = store.getEdgesBySource(n.id, 'CALLS');

                const callerNames = callerEdges.slice(0, 3).map((e: { sourceId: number; targetId: number; type: string }) => {
                    const caller = store.getNodeById(e.sourceId);
                    return caller ? caller.name : '?';
                });
                const calleeNames = calleeEdges.slice(0, 3).map((e: { sourceId: number; targetId: number; type: string }) => {
                    const callee = store.getNodeById(e.targetId);
                    return callee ? callee.name : '?';
                });

                let line = `${n.label} \`${n.name}\``;
                if (callerNames.length > 0) {
                    line += ` ← ${callerNames.join(', ')}`;
                    if (callerEdges.length > 3) line += ` +${callerEdges.length - 3}`;
                }
                if (calleeNames.length > 0) {
                    line += ` → ${calleeNames.join(', ')}`;
                    if (calleeEdges.length > 3) line += ` +${calleeEdges.length - 3}`;
                }
                if (callerEdges.length === 0 && calleeEdges.length === 0) {
                    line += ` [unused]`;
                } else if (callerEdges.length === 0 && n.label === 'Function') {
                    line += ` [entry]`;
                }
                line += ` (${n.filePath}:${n.startLine})`;
                directRelations.push(line);
            }
        }

        if (directRelations.length > 0) {
            lines.push('## Graph Context');
            lines.push(...directRelations.map(l => `  - ${l}`));
            lines.push('');
        }

        // === Layer 2: Call chain trace (for top-ranked function) ===
        for (const result of searchResults.slice(0, 3)) {
            const normalizedPath = result.relativePath.replace(/^\/+/, '');
            const nodeResult = store.findNodes({
                project,
                exactFilePath: normalizedPath,
                limit: 5,
            });
            for (const r of nodeResult.results) {
                if (r.node.label !== 'Function' && r.node.label !== 'Method') continue;
                try {
                    const traceResult = this.graphToolHandlers!.handleTracePath({
                        project,
                        function_name: r.node.qualifiedName,
                        direction: 'both',
                        depth: 3,
                        mode: 'calls',
                    });
                    const traceText = traceResult.content[0]?.text || '';
                    const traceLines = traceText.split('\n');
                    const filtered = traceLines.filter((l: string) =>
                        l.startsWith('  [depth=') || l.startsWith('Callers') || l.startsWith('Callees')
                    );
                    if (filtered.length > 0) {
                        lines.push(`### Call Chain: \`${r.node.name}\``);
                        lines.push(...filtered);
                        lines.push('');
                    }
                } catch {
                    // trace failure shouldn't affect main flow
                }
                break;
            }
            break;
        }

        // === Layer 3: Architecture summary ===
        try {
            const archResult = this.graphToolHandlers!.handleGetArchitecture({
                project,
            });
            const archText = archResult.content[0]?.text || '';
            const archLines = archText.split('\n');
            const summary: string[] = [];
            let inEntryPoints = false;
            let inClusters = false;
            let clusterCount = 0;
            for (const line of archLines) {
                if (line.startsWith('Entry points')) {
                    inEntryPoints = true;
                    summary.push(line);
                    continue;
                }
                if (inEntryPoints && line.startsWith('  -')) {
                    summary.push(line);
                    continue;
                }
                if (inEntryPoints && !line.startsWith('  -')) {
                    inEntryPoints = false;
                }
                if (line.startsWith('Clusters')) {
                    inClusters = true;
                    summary.push(line);
                    continue;
                }
                if (inClusters && line.startsWith('  ') && clusterCount < 5) {
                    summary.push(line);
                    clusterCount++;
                    continue;
                }
                if (inClusters && clusterCount >= 5) {
                    inClusters = false;
                }
            }
            if (summary.length > 0) {
                lines.push('### Architecture');
                lines.push(...summary);
                lines.push('');
            }
        } catch {
            // architecture failure shouldn't affect main flow
        }

        return lines.length > 0 ? '\n\n' + lines.join('\n') : '';
    }

    /**
     * @deprecated Use enrichWithGraphContextDeep for 3-layer enhancement.
     * Kept for backward compatibility.
     */
    private enrichWithGraphContext(
        searchResults: any[],
        codebasePath: string,
        _existingMessage: string,
        maxContextFiles: number = 10,
    ): string {
        const store = this.graphToolHandlers!.getStore();
        const project = getRepoIdentity(codebasePath);
        const lines: string[] = [];
        const seenSymbols = new Set<string>();

        // Collect all unique file paths from search results
        const seenFiles = new Set<string>();
        for (const result of searchResults.slice(0, maxContextFiles)) {
            seenFiles.add(result.relativePath);
        }

        // For each file, find containing functions and enrich
        for (const filePath of seenFiles) {
            // Normalize path: strip leading slash and prefix for exact match
            const normalizedPath = filePath.replace(/^\/+/, '');
            let nodeResult = store.findNodes({
                project,
                exactFilePath: normalizedPath,
                limit: 20,
            });

            // Fallback: try without exact path match if nothing found
            if (nodeResult.results.length === 0 && normalizedPath !== filePath) {
                nodeResult = store.findNodes({
                    project,
                    exactFilePath: filePath,
                    limit: 20,
                });
            }

            if (nodeResult.results.length === 0) continue;

            for (const r of nodeResult.results) {
                const n = r.node;
                const key = n.qualifiedName;
                if (seenSymbols.has(key)) continue;
                seenSymbols.add(key);

                // Get callers and callees
                const callerEdges = store.getEdgesByTarget(n.id, 'CALLS');
                const calleeEdges = store.getEdgesBySource(n.id, 'CALLS');

                const callerNames = callerEdges.slice(0, 3).map((e: { sourceId: number; targetId: number; type: string }) => {
                    const caller = store.getNodeById(e.sourceId);
                    return caller ? caller.name : '?';
                });
                const calleeNames = calleeEdges.slice(0, 3).map((e: { sourceId: number; targetId: number; type: string }) => {
                    const callee = store.getNodeById(e.targetId);
                    return callee ? callee.name : '?';
                });

                // Build a compact line
                let line = `${n.label} \`${n.name}\``;
                if (callerNames.length > 0) {
                    line += ` ← ${callerNames.join(', ')}`;
                    if (callerEdges.length > 3) line += ` +${callerEdges.length - 3}`;
                }
                if (calleeNames.length > 0) {
                    line += ` → ${calleeNames.join(', ')}`;
                    if (calleeEdges.length > 3) line += ` +${calleeEdges.length - 3}`;
                }
                // Dead code detection
                if (callerEdges.length === 0 && calleeEdges.length === 0) {
                    line += ` [unused]`;
                } else if (callerEdges.length === 0 && n.label === 'Function') {
                    line += ` [entry]`;
                }
                line += ` (${n.filePath}:${n.startLine})`;

                lines.push(line);
            }
        }

        if (lines.length === 0) return '';

        return `\n\n## Related Graph Context\n` + lines.map(l => `  - ${l}`).join('\n');
    }
} 
