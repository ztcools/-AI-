import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { getRepoIdentity } from "@zilliz/claude-context-core";
import {
    CodebaseSnapshot,
    CodebaseSnapshotV1,
    CodebaseSnapshotV2,
    CodebaseInfo,
    CodebaseIndexOptions,
    CodebaseInfoIndexing,
    CodebaseInfoIndexed,
    CodebaseInfoIndexFailed
} from "./config.js";

export class SnapshotManager {
    private snapshotFilePath: string;
    private indexedCodebases: string[] = [];         // identities (url:branch)
    private indexingCodebases: Map<string, number> = new Map(); // identity -> progress
    private codebaseFileCount: Map<string, number> = new Map(); // identity -> file count
    private codebaseInfoMap: Map<string, CodebaseInfo> = new Map(); // identity -> CodebaseInfo
    private recentlyRemoved: Set<string> = new Set(); // identities removed since last save
    private identityCache: Map<string, string> = new Map(); // codebasePath -> identity

    constructor() {
        // Initialize snapshot file path
        this.snapshotFilePath = path.join(os.homedir(), '.context', 'mcp-codebase-snapshot.json');
    }

    /**
     * Resolve identity from codebase path. All internal state is keyed by identity.
     * Results are cached per path to avoid repeated git calls.
     */
    private toIdentity(codebasePath: string): string {
        // If the input already looks like an identity (contains URI scheme or git@),
        // return it directly instead of trying to resolve it as a filesystem path.
        if (codebasePath.includes('://') || codebasePath.startsWith('git@')) {
            return codebasePath;
        }
        const resolved = path.resolve(codebasePath);
        if (!this.identityCache.has(resolved)) {
            this.identityCache.set(resolved, getRepoIdentity(resolved));
        }
        return this.identityCache.get(resolved)!;
    }

    /**
     * Check if snapshot is v2 format
     */
    private isV2Format(snapshot: any): snapshot is CodebaseSnapshotV2 {
        return snapshot && snapshot.formatVersion === 'v2';
    }

    /**
     * Convert v1 format to internal state
     */
    private loadV1Format(snapshot: CodebaseSnapshotV1): void {
        console.log('[SNAPSHOT-DEBUG] Loading v1 format snapshot');

        // Validate that the codebases still exist and convert to identity-based keys
        const validCodebases: string[] = [];
        for (const codebasePath of snapshot.indexedCodebases) {
            if (fs.existsSync(codebasePath)) {
                const identity = this.toIdentity(codebasePath);
                validCodebases.push(identity);
                console.log(`[SNAPSHOT-DEBUG] Validated codebase: ${codebasePath} → ${identity}`);
            } else {
                console.warn(`[SNAPSHOT-DEBUG] Codebase no longer exists, removing: ${codebasePath}`);
                this.recentlyRemoved.add(this.toIdentity(codebasePath));
            }
        }

        // Handle indexing codebases - treat them as not indexed since they were interrupted
        let indexingCodebasesList: string[] = [];
        if (Array.isArray(snapshot.indexingCodebases)) {
            indexingCodebasesList = snapshot.indexingCodebases;
            console.log(`[SNAPSHOT-DEBUG] Found legacy indexingCodebases array format with ${indexingCodebasesList.length} entries`);
        } else if (snapshot.indexingCodebases && typeof snapshot.indexingCodebases === 'object') {
            indexingCodebasesList = Object.keys(snapshot.indexingCodebases);
            console.log(`[SNAPSHOT-DEBUG] Found new indexingCodebases object format with ${indexingCodebasesList.length} entries`);
        }

        for (const codebasePath of indexingCodebasesList) {
            if (fs.existsSync(codebasePath)) {
                console.warn(`[SNAPSHOT-DEBUG] Found interrupted indexing codebase: ${codebasePath}. Treating as not indexed.`);
            } else {
                console.warn(`[SNAPSHOT-DEBUG] Interrupted indexing codebase no longer exists: ${codebasePath}`);
                this.recentlyRemoved.add(this.toIdentity(codebasePath));
            }
        }

        // Restore state - only fully indexed codebases (keyed by identity)
        this.indexedCodebases = validCodebases;
        this.indexingCodebases = new Map();
        this.codebaseFileCount = new Map();

        // Populate codebaseInfoMap for v1 indexed codebases (with minimal info)
        this.codebaseInfoMap = new Map();
        const now = new Date().toISOString();
        for (const codebasePath of snapshot.indexedCodebases) {
            if (!fs.existsSync(codebasePath)) continue;
            const identity = this.toIdentity(codebasePath);
            const info: CodebaseInfoIndexed = {
                status: 'indexed',
                localPath: codebasePath,
                indexedFiles: 0,
                totalChunks: 0,
                indexStatus: 'completed',
                lastUpdated: now
            };
            this.codebaseInfoMap.set(identity, info);
        }
    }

    /**
 * Convert v2 format to internal state
 */
    private loadV2Format(snapshot: CodebaseSnapshotV2): void {
        console.log('[SNAPSHOT-DEBUG] Loading v2 format snapshot');

        const validIndexedCodebases: string[] = [];
        const validFileCount = new Map<string, number>();
        const validCodebaseInfoMap = new Map<string, CodebaseInfo>();

        for (const [diskKey, info] of Object.entries(snapshot.codebases)) {
            // Determine the identity and localPath.
            // New format: diskKey is identity (url:branch), info.localPath has the checkout path.
            // Old format: diskKey is filesystem path, info.localPath may be missing.
            const isOldFormat = diskKey.startsWith('/') || diskKey.startsWith('\\');
            const identity = isOldFormat ? this.toIdentity(diskKey) : diskKey;
            const localPath = info.localPath || (isOldFormat ? diskKey : identity);

            // Validate the local checkout still exists
            if (!fs.existsSync(localPath)) {
                console.warn(`[SNAPSHOT-DEBUG] Codebase no longer exists, removing: ${localPath} (identity: ${identity})`);
                this.recentlyRemoved.add(identity);
                continue;
            }

            // Ensure localPath is set on the info
            const infoWithPath = { ...info, localPath } as CodebaseInfo;
            validCodebaseInfoMap.set(identity, infoWithPath);

            if (info.status === 'indexed') {
                validIndexedCodebases.push(identity);
                if ('indexedFiles' in info) {
                    validFileCount.set(identity, info.indexedFiles);
                }
                console.log(`[SNAPSHOT-DEBUG] Validated indexed codebase: ${identity} (${info.indexedFiles || 'unknown'} files, ${info.totalChunks || 'unknown'} chunks)`);
            } else if (info.status === 'indexing') {
                console.warn(`[SNAPSHOT] Found interrupted indexing for '${identity}', resetting to failed`);
                const failedInfo: CodebaseInfoIndexFailed = {
                    status: 'indexfailed',
                    localPath,
                    errorMessage: 'Indexing was interrupted (MCP server restarted)',
                    lastAttemptedPercentage: info.indexingPercentage,
                    ...this.getIndexOptions(info),
                    lastUpdated: new Date().toISOString()
                };
                validCodebaseInfoMap.set(identity, failedInfo);
            } else if (info.status === 'indexfailed') {
                console.warn(`[SNAPSHOT-DEBUG] Found failed indexing codebase: ${identity}. Error: ${info.errorMessage}`);
            }
        }

        // Restore state (keyed by identity)
        this.indexedCodebases = validIndexedCodebases;
        this.indexingCodebases = new Map();
        this.codebaseFileCount = validFileCount;
        this.codebaseInfoMap = validCodebaseInfoMap;
    }

    public getIndexedCodebases(): string[] {
        // Read from JSON file to ensure consistency and persistence.
        // Convert old-format keys (filesystem paths) to identities on the fly.
        try {
            if (!fs.existsSync(this.snapshotFilePath)) {
                return [];
            }

            const snapshotData = fs.readFileSync(this.snapshotFilePath, 'utf8');
            const snapshot: CodebaseSnapshot = JSON.parse(snapshotData);

            if (this.isV2Format(snapshot)) {
                return Object.entries(snapshot.codebases)
                    .filter(([_, info]) => info.status === 'indexed')
                    .map(([key, _]) => (key.startsWith('/') || key.startsWith('\\')) ? this.toIdentity(key) : key);
            } else {
                // V1 format: keys are filesystem paths, convert to identities
                const indexed = snapshot.indexedCodebases || [];
                return indexed.map((p: string) => this.toIdentity(p));
            }
        } catch (error) {
            console.warn(`[SNAPSHOT-DEBUG] Error reading indexed codebases from file:`, error);
            return [...this.indexedCodebases];
        }
    }

    public getIndexingCodebases(): string[] {
        try {
            if (!fs.existsSync(this.snapshotFilePath)) {
                return [];
            }

            const snapshotData = fs.readFileSync(this.snapshotFilePath, 'utf8');
            const snapshot: CodebaseSnapshot = JSON.parse(snapshotData);

            if (this.isV2Format(snapshot)) {
                return Object.entries(snapshot.codebases)
                    .filter(([_, info]) => info.status === 'indexing')
                    .map(([key, _]) => (key.startsWith('/') || key.startsWith('\\')) ? this.toIdentity(key) : key);
            } else {
                if (Array.isArray(snapshot.indexingCodebases)) {
                    return snapshot.indexingCodebases.map((p: string) => this.toIdentity(p));
                } else if (snapshot.indexingCodebases && typeof snapshot.indexingCodebases === 'object') {
                    return Object.keys(snapshot.indexingCodebases).map((p: string) => this.toIdentity(p));
                }
            }

            return [];
        } catch (error) {
            console.warn(`[SNAPSHOT-DEBUG] Error reading indexing codebases from file:`, error);
            return Array.from(this.indexingCodebases.keys());
        }
    }

    /**
     * Find a tracked codebase by identity. Computes the identity for the given
     * codebasePath and looks it up in the internal identity-keyed maps.
     * Returns the localPath (filesystem checkout path) if found.
     */
    private findByIdentity(codebasePath: string, candidates: string[]): string | undefined {
        const identity = this.toIdentity(codebasePath);
        if (candidates.includes(identity)) {
            const info = this.codebaseInfoMap.get(identity);
            return info?.localPath;
        }
        return undefined;
    }

    public findIndexedCodebasePath(codebasePath: string): string | undefined {
        return this.findByIdentity(codebasePath, this.getIndexedCodebases());
    }

    public findIndexingCodebasePath(codebasePath: string): string | undefined {
        return this.findByIdentity(codebasePath, this.getIndexingCodebases());
    }

    public findTrackedCodebasePath(codebasePath: string): string | undefined {
        const identity = this.toIdentity(codebasePath);
        if (this.codebaseInfoMap.has(identity)) {
            return this.codebaseInfoMap.get(identity)!.localPath;
        }
        return undefined;
    }

    private getIndexOptions(options?: CodebaseIndexOptions): CodebaseIndexOptions {
        const indexOptions: CodebaseIndexOptions = {};
        if (options?.requestSplitter === 'ast' || options?.requestSplitter === 'langchain') {
            indexOptions.requestSplitter = options.requestSplitter;
        }
        if (options?.requestCustomExtensions?.length) {
            indexOptions.requestCustomExtensions = options.requestCustomExtensions;
        }
        if (options?.requestIgnorePatterns?.length) {
            indexOptions.requestIgnorePatterns = options.requestIgnorePatterns;
        }
        return indexOptions;
    }

    private resolveIndexOptions(codebasePath: string, options?: CodebaseIndexOptions): CodebaseIndexOptions {
        const identity = this.toIdentity(codebasePath);
        return this.getIndexOptions(options ?? this.codebaseInfoMap.get(identity));
    }

    /**
     * @deprecated Use getCodebaseInfo() for individual codebases or iterate through codebases for v2 format support
     */
    public getIndexingCodebasesWithProgress(): Map<string, number> {
        return new Map(this.indexingCodebases);
    }

    public getIndexingProgress(codebasePath: string): number | undefined {
        const identity = this.toIdentity(codebasePath);
        try {
            if (!fs.existsSync(this.snapshotFilePath)) {
                return undefined;
            }

            const snapshotData = fs.readFileSync(this.snapshotFilePath, 'utf8');
            const snapshot: CodebaseSnapshot = JSON.parse(snapshotData);

            if (this.isV2Format(snapshot)) {
                // Try identity key first (new format), then raw path (old format)
                const info = snapshot.codebases[identity] || snapshot.codebases[codebasePath];
                if (info && info.status === 'indexing') {
                    return info.indexingPercentage || 0;
                }
                return undefined;
            } else {
                if (Array.isArray(snapshot.indexingCodebases)) {
                    return snapshot.indexingCodebases.includes(codebasePath) ? 0 : undefined;
                } else if (snapshot.indexingCodebases && typeof snapshot.indexingCodebases === 'object') {
                    return snapshot.indexingCodebases[codebasePath];
                }
            }

            return undefined;
        } catch (error) {
            console.warn(`[SNAPSHOT-DEBUG] Error reading progress from file for ${codebasePath}:`, error);
            return this.indexingCodebases.get(identity);
        }
    }

    /**
     * @deprecated Use setCodebaseIndexing() instead for v2 format support
     */
    public addIndexingCodebase(codebasePath: string, progress: number = 0): void {
        const identity = this.toIdentity(codebasePath);
        this.indexingCodebases.set(identity, progress);

        const info: CodebaseInfoIndexing = {
            status: 'indexing',
            localPath: codebasePath,
            indexingPercentage: progress,
            lastUpdated: new Date().toISOString()
        };
        this.codebaseInfoMap.set(identity, info);
    }

    /**
     * @deprecated Use setCodebaseIndexing() instead for v2 format support
     */
    public updateIndexingProgress(codebasePath: string, progress: number): void {
        const identity = this.toIdentity(codebasePath);
        if (this.indexingCodebases.has(identity)) {
            this.indexingCodebases.set(identity, progress);

            const info: CodebaseInfoIndexing = {
                status: 'indexing',
                localPath: codebasePath,
                indexingPercentage: progress,
                lastUpdated: new Date().toISOString()
            };
            this.codebaseInfoMap.set(identity, info);
        }
    }

    /**
     * @deprecated Use removeCodebaseCompletely() or state-specific methods instead for v2 format support
     */
    public removeIndexingCodebase(codebasePath: string): void {
        const identity = this.toIdentity(codebasePath);
        this.indexingCodebases.delete(identity);
        this.codebaseInfoMap.delete(identity);
    }

    /**
     * @deprecated Use setCodebaseIndexed() instead for v2 format support
     */
    public addIndexedCodebase(codebasePath: string, fileCount?: number): void {
        const identity = this.toIdentity(codebasePath);
        if (!this.indexedCodebases.includes(identity)) {
            this.indexedCodebases.push(identity);
        }
        if (fileCount !== undefined) {
            this.codebaseFileCount.set(identity, fileCount);
        }

        const info: CodebaseInfoIndexed = {
            status: 'indexed',
            localPath: codebasePath,
            indexedFiles: fileCount || 0,
            totalChunks: 0,
            indexStatus: 'completed',
            lastUpdated: new Date().toISOString()
        };
        this.codebaseInfoMap.set(identity, info);
    }

    /**
     * @deprecated Use removeCodebaseCompletely() or state-specific methods instead for v2 format support
     */
    public removeIndexedCodebase(codebasePath: string): void {
        const identity = this.toIdentity(codebasePath);
        this.indexedCodebases = this.indexedCodebases.filter(id => id !== identity);
        this.codebaseFileCount.delete(identity);
        this.codebaseInfoMap.delete(identity);
    }

    /**
     * @deprecated Use setCodebaseIndexed() instead for v2 format support
     */
    public moveFromIndexingToIndexed(codebasePath: string, fileCount?: number): void {
        this.removeIndexingCodebase(codebasePath);
        this.addIndexedCodebase(codebasePath, fileCount);
    }

    /**
     * @deprecated Use getCodebaseInfo() and check indexedFiles property instead for v2 format support
     */
    public getIndexedFileCount(codebasePath: string): number | undefined {
        return this.codebaseFileCount.get(this.toIdentity(codebasePath));
    }

    /**
     * @deprecated Use setCodebaseIndexed() with complete stats instead for v2 format support
     */
    public setIndexedFileCount(codebasePath: string, fileCount: number): void {
        this.codebaseFileCount.set(this.toIdentity(codebasePath), fileCount);
    }

    /**
     * Set codebase to indexing status
     */
    public setCodebaseIndexing(codebasePath: string, progress: number = 0, indexOptions?: CodebaseIndexOptions): void {
        const identity = this.toIdentity(codebasePath);
        this.indexingCodebases.set(identity, progress);

        this.indexedCodebases = this.indexedCodebases.filter(id => id !== identity);
        this.codebaseFileCount.delete(identity);

        const resolvedIndexOptions = this.resolveIndexOptions(codebasePath, indexOptions);

        const info: CodebaseInfoIndexing = {
            status: 'indexing',
            localPath: codebasePath,
            indexingPercentage: progress,
            ...resolvedIndexOptions,
            lastUpdated: new Date().toISOString()
        };
        this.codebaseInfoMap.set(identity, info);
    }

    /**
     * Set codebase to indexed status with complete statistics
     */
    public setCodebaseIndexed(
        codebasePath: string,
        stats: { indexedFiles: number; totalChunks: number; status: 'completed' | 'limit_reached' },
        indexOptions?: CodebaseIndexOptions
    ): void {
        if (stats.indexedFiles === 0 && stats.totalChunks === 0 && stats.status === 'completed') {
            console.error(`[SNAPSHOT] Refusing to write 0/0+completed for '${codebasePath}' — invalid state. Stack trace:`);
            console.trace();
            return;
        }

        const identity = this.toIdentity(codebasePath);

        if (!this.indexedCodebases.includes(identity)) {
            this.indexedCodebases.push(identity);
        }

        this.indexingCodebases.delete(identity);
        this.codebaseFileCount.set(identity, stats.indexedFiles);

        const resolvedIndexOptions = this.resolveIndexOptions(codebasePath, indexOptions);

        const info: CodebaseInfoIndexed = {
            status: 'indexed',
            localPath: codebasePath,
            indexedFiles: stats.indexedFiles,
            totalChunks: stats.totalChunks,
            indexStatus: stats.status,
            ...resolvedIndexOptions,
            lastUpdated: new Date().toISOString()
        };
        this.codebaseInfoMap.set(identity, info);
    }

    /**
     * Set codebase to failed status
     */
    public setCodebaseIndexFailed(
        codebasePath: string,
        errorMessage: string,
        lastAttemptedPercentage?: number,
        indexOptions?: CodebaseIndexOptions
    ): void {
        const identity = this.toIdentity(codebasePath);
        this.indexedCodebases = this.indexedCodebases.filter(id => id !== identity);
        this.indexingCodebases.delete(identity);
        this.codebaseFileCount.delete(identity);

        const resolvedIndexOptions = this.resolveIndexOptions(codebasePath, indexOptions);

        const info: CodebaseInfoIndexFailed = {
            status: 'indexfailed',
            localPath: codebasePath,
            errorMessage: errorMessage,
            lastAttemptedPercentage: lastAttemptedPercentage,
            ...resolvedIndexOptions,
            lastUpdated: new Date().toISOString()
        };
        this.codebaseInfoMap.set(identity, info);
    }

    /**
     * Get codebase status
     */
    public getCodebaseStatus(codebasePath: string): 'indexed' | 'indexing' | 'indexfailed' | 'not_found' {
        const info = this.codebaseInfoMap.get(this.toIdentity(codebasePath));
        if (!info) return 'not_found';
        return info.status;
    }

    /**
     * Get complete codebase information
     */
    public getCodebaseInfo(codebasePath: string): CodebaseInfo | undefined {
        return this.codebaseInfoMap.get(this.toIdentity(codebasePath));
    }

    /**
     * Read a codebase's info directly from the on-disk snapshot, bypassing the
     * in-memory codebaseInfoMap. Looks up by identity (computed from codebasePath)
     * and also tries the raw path for backward compatibility with old-format snapshots.
     */
    public getCodebaseInfoFromDisk(codebasePath: string): CodebaseInfo | undefined {
        try {
            if (!fs.existsSync(this.snapshotFilePath)) return undefined;

            const snapshot: CodebaseSnapshot = JSON.parse(fs.readFileSync(this.snapshotFilePath, 'utf8'));
            const identity = this.toIdentity(codebasePath);

            if (this.isV2Format(snapshot)) {
                // Try identity key first (new format), then raw path (old format)
                const byIdentity = snapshot.codebases[identity];
                if (byIdentity) return byIdentity;
                const byPath = snapshot.codebases[codebasePath];
                if (byPath) return byPath;
                return undefined;
            }

            // V1 format only records indexed codebases
            const indexed = Array.isArray(snapshot.indexedCodebases) ? snapshot.indexedCodebases : [];
            const v1Identity = indexed.map((p: string) => this.toIdentity(p));
            if (v1Identity.includes(identity)) {
                const info: CodebaseInfoIndexed = {
                    status: 'indexed',
                    localPath: codebasePath,
                    indexedFiles: 0,
                    totalChunks: 0,
                    indexStatus: 'completed',
                    lastUpdated: snapshot.lastUpdated || new Date().toISOString()
                };
                return info;
            }
            return undefined;
        } catch (error) {
            console.warn(`[SNAPSHOT-DEBUG] Error reading codebase info from disk for '${codebasePath}':`, error);
            return undefined;
        }
    }

    /**
     * Refresh the in-memory state for a single codebase from a known info entry
     * (e.g. one just read off disk via getCodebaseInfoFromDisk).
     */
    public refreshCodebaseFromDisk(codebasePath: string, info: CodebaseInfo): void {
        const identity = this.toIdentity(codebasePath);
        if (this.recentlyRemoved.has(identity)) return;
        this.codebaseInfoMap.set(identity, info);

        this.indexedCodebases = this.indexedCodebases.filter(id => id !== identity);
        this.indexingCodebases.delete(identity);
        this.codebaseFileCount.delete(identity);

        if (info.status === 'indexed') {
            this.indexedCodebases.push(identity);
            if ('indexedFiles' in info && info.indexedFiles !== undefined) {
                this.codebaseFileCount.set(identity, info.indexedFiles);
            }
        } else if (info.status === 'indexing') {
            this.indexingCodebases.set(identity, info.indexingPercentage || 0);
        }
    }

    /**
     * Get all failed codebases
     */
    public getFailedCodebases(): string[] {
        return Array.from(this.codebaseInfoMap.entries())
            .filter(([_, info]) => info.status === 'indexfailed')
            .map(([identity, _]) => identity);
    }

    /**
     * Completely remove a codebase from all tracking (for clear_index operation)
     */
    public removeCodebaseCompletely(codebasePath: string): void {
        const identity = this.toIdentity(codebasePath);
        this.indexedCodebases = this.indexedCodebases.filter(id => id !== identity);
        this.indexingCodebases.delete(identity);
        this.codebaseFileCount.delete(identity);
        this.codebaseInfoMap.delete(identity);
        this.recentlyRemoved.add(identity);

        console.log(`[SNAPSHOT-DEBUG] Completely removed codebase from snapshot: ${codebasePath} (identity: ${identity})`);
    }

    public loadCodebaseSnapshot(): void {
        console.log('[SNAPSHOT-DEBUG] Loading codebase snapshot from:', this.snapshotFilePath);

        try {
            if (!fs.existsSync(this.snapshotFilePath)) {
                console.log('[SNAPSHOT-DEBUG] Snapshot file does not exist. Starting with empty codebase list.');
                return;
            }

            const snapshotData = fs.readFileSync(this.snapshotFilePath, 'utf8');
            const snapshot: CodebaseSnapshot = JSON.parse(snapshotData);

            console.log('[SNAPSHOT-DEBUG] Loaded snapshot:', snapshot);

            if (this.isV2Format(snapshot)) {
                this.loadV2Format(snapshot);
            } else {
                this.loadV1Format(snapshot);
            }

            // Always save in v2 format after loading (migration)
            this.saveCodebaseSnapshot();

        } catch (error: any) {
            console.error('[SNAPSHOT-DEBUG] Error loading snapshot:', error);
            console.log('[SNAPSHOT-DEBUG] Starting with empty codebase list due to snapshot error.');
        }
    }

    private acquireLock(maxRetries = 5, retryInterval = 100): boolean {
        const lockPath = this.snapshotFilePath + '.lock';
        for (let i = 0; i < maxRetries; i++) {
            try {
                fs.mkdirSync(lockPath);
                return true;
            } catch {
                try {
                    const stat = fs.statSync(lockPath);
                    if (Date.now() - stat.mtimeMs > 10000) {
                        fs.rmSync(lockPath, { recursive: true });
                        continue;
                    }
                } catch { }
                const waitUntil = Date.now() + retryInterval;
                while (Date.now() < waitUntil) { /* busy wait */ }
            }
        }
        return false;
    }

    private releaseLock(): void {
        try {
            fs.rmSync(this.snapshotFilePath + '.lock', { recursive: true });
        } catch { }
    }

    private mergeExternalEntry(diskKey: string, info: CodebaseInfo): void {
        // diskKey may be identity (new format) or filesystem path (old format)
        const isOldFormat = diskKey.startsWith('/') || diskKey.startsWith('\\');
        const identity = isOldFormat ? this.toIdentity(diskKey) : diskKey;
        if (this.codebaseInfoMap.has(identity)) return;
        if (this.recentlyRemoved.has(identity)) return;

        this.codebaseInfoMap.set(identity, info);
        if (info.status === 'indexed') {
            if (!this.indexedCodebases.includes(identity)) {
                this.indexedCodebases.push(identity);
            }
            if (info.indexedFiles !== undefined) {
                this.codebaseFileCount.set(identity, info.indexedFiles);
            }
        } else if (info.status === 'indexing') {
            if (!this.indexingCodebases.has(identity)) {
                this.indexingCodebases.set(identity, info.indexingPercentage || 0);
            }
        }
    }

    public saveCodebaseSnapshot(): void {
        console.log('[SNAPSHOT-DEBUG] Saving codebase snapshot to:', this.snapshotFilePath);

        const locked = this.acquireLock();
        if (!locked) {
            console.warn('[SNAPSHOT-DEBUG] Failed to acquire lock, saving without lock');
        }

        try {
            const snapshotDir = path.dirname(this.snapshotFilePath);
            if (!fs.existsSync(snapshotDir)) {
                fs.mkdirSync(snapshotDir, { recursive: true });
                console.log('[SNAPSHOT-DEBUG] Created snapshot directory:', snapshotDir);
            }

            // Read-merge: merge entries from disk that we don't have in memory
            try {
                if (fs.existsSync(this.snapshotFilePath)) {
                    const diskData = fs.readFileSync(this.snapshotFilePath, 'utf8');
                    const diskSnapshot = JSON.parse(diskData);
                    if (this.isV2Format(diskSnapshot)) {
                        for (const [diskKey, diskInfo] of Object.entries(diskSnapshot.codebases)) {
                            this.mergeExternalEntry(diskKey, diskInfo as CodebaseInfo);
                        }
                    }
                }
            } catch (mergeError) {
                console.warn('[SNAPSHOT-DEBUG] Error reading disk snapshot for merge, continuing with in-memory state:', mergeError);
            }

            // Build v2 format snapshot keyed by identity (url:branch)
            const codebases: Record<string, CodebaseInfo> = {};

            for (const [identity, info] of this.codebaseInfoMap) {
                codebases[identity] = info;
            }

            const snapshot: CodebaseSnapshotV2 = {
                formatVersion: 'v2',
                codebases: codebases,
                lastUpdated: new Date().toISOString()
            };

            fs.writeFileSync(this.snapshotFilePath, JSON.stringify(snapshot, null, 2));

            this.recentlyRemoved.clear();

            const indexedCount = this.indexedCodebases.length;
            const indexingCount = this.indexingCodebases.size;
            const failedCount = this.getFailedCodebases().length;

            console.log(`[SNAPSHOT-DEBUG] Snapshot saved successfully in v2 format. Indexed: ${indexedCount}, Indexing: ${indexingCount}, Failed: ${failedCount}`);

        } catch (error: any) {
            console.error('[SNAPSHOT-DEBUG] Error saving snapshot:', error);
        } finally {
            if (locked) {
                this.releaseLock();
            }
        }
    }
}
