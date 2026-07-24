import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { execSync } from 'child_process';
import { MerkleDAG } from './merkle';
import * as os from 'os';
import { getRepoIdentity } from '../utils/git-identity';
import { matchGlob } from '../utils/glob-matcher';

export class FileSynchronizer {
    private fileHashes: Map<string, string>;
    private merkleDAG: MerkleDAG;
    private rootDir: string;
    private snapshotPath: string;
    private ignorePatterns: string[];
    private supportedExtensions: string[];
    private supportedFilenames: string[];
    /** Explicit identity override for dev-aware snapshots (url:branch:devId). */
    private identityOverride?: string;
    /** Whether the snapshot is in a "dirty" state (indexing not yet completed). */
    private dirty: boolean = false;
    /**
     * Files this dev has changed relative to the root (main) branch.
     * Used for search-time masking: root layer excludes these paths so the
     * dev's version always wins. Empty when operating in full-index mode
     * (no root available), meaning all files are in dev collection.
     */
    private devChangedFiles: Set<string> = new Set();

    constructor(
        rootDir: string,
        ignorePatterns: string[] = [],
        supportedExtensions: string[] = [],
        supportedFilenames: string[] = [],
        identityOverride?: string,
    ) {
        this.rootDir = rootDir;
        this.identityOverride = identityOverride;
        this.snapshotPath = this.getSnapshotPath(rootDir);
        this.fileHashes = new Map();
        this.merkleDAG = new MerkleDAG();
        this.ignorePatterns = ignorePatterns;
        this.supportedExtensions = supportedExtensions;
        this.supportedFilenames = supportedFilenames;
    }

    private isSupported(name: string): boolean {
        const ext = path.extname(name);
        if (ext && this.supportedExtensions.includes(ext)) return true;
        return this.supportedFilenames.includes(path.basename(name));
    }

    private getSnapshotPath(codebasePath: string): string {
        const homeDir = os.homedir();
        const merkleDir = path.join(homeDir, '.context', 'merkle');
        let identity: string;
        try {
            // Use explicit identity override if provided (dev-aware),
            // otherwise fall back to auto-detected repo identity.
            if (this.identityOverride) {
                identity = this.identityOverride;
            } else {
                identity = getRepoIdentity(codebasePath);
            }
        } catch {
            // Fallback to path-based identity if git is not available
            const hash = crypto.createHash('md5').update(codebasePath).digest('hex');
            identity = `path:${hash}`;
            console.warn(`[Synchronizer] Git identity unavailable, using path-based fallback: ${identity}`);
        }
        const hash = crypto.createHash('md5').update(identity).digest('hex');
        return path.join(merkleDir, `${hash}.json`);
    }

    private async hashFile(filePath: string): Promise<string> {
        const stat = await fs.stat(filePath);
        if (stat.isDirectory()) {
            throw new Error(`Attempted to hash a directory: ${filePath}`);
        }
        // Stream large files (> 10MB) to avoid OOM.
        if (stat.size > 10 * 1024 * 1024) {
            return new Promise<string>((resolve, reject) => {
                const hash = crypto.createHash('sha256');
                const stream = fsSync.createReadStream(filePath);
                stream.on('data', (chunk: string | Buffer) => hash.update(chunk));
                stream.on('end', () => resolve(hash.digest('hex')));
                stream.on('error', reject);
            });
        }
        const content = await fs.readFile(filePath, 'utf-8');
        return crypto.createHash('sha256').update(content).digest('hex');
    }

    private async generateFileHashes(
        dir: string,
        onProgress?: (current: number, total: number) => void,
    ): Promise<Map<string, string>> {
        const fileHashes = new Map<string, string>();

        // Try git ls-files first — respects .gitignore and is much faster.
        // Filter in JS to avoid command-line length limits with many extensions.
        let files: string[] = [];
        try {
            if (this.supportedExtensions.length === 0) {
                return fileHashes;
            }
            const extSet = new Set(this.supportedExtensions);
            const nameSet = new Set(this.supportedFilenames);
            // 50MB buffer to handle very large repos without falling back to
            // the slower filesystem walk (10MB was too small for 100K+ files).
            const output = execSync(
                `git -C "${dir}" ls-files --cached --others --exclude-standard`,
                { encoding: 'utf-8', timeout: 15_000, maxBuffer: 50 * 1024 * 1024 }
            );
            files = output.trim().split('\n').filter(Boolean)
                .filter(f => extSet.has(path.extname(f)) || nameSet.has(path.basename(f)))
                .map(f => path.join(dir, f));
        } catch {
            // Fallback: filesystem walk
            return await this.generateFileHashesFromFS(dir, onProgress);
        }

        const total = files.length;
        let processed = 0;
        // Report every N files to avoid callback overhead dominating the hot loop.
        const reportInterval = Math.max(1, Math.floor(total / 100));
        for (const fullPath of files) {
            processed++;
            if (onProgress && processed % reportInterval === 0) {
                onProgress(processed, total);
            }
            if (!fsSync.existsSync(fullPath)) continue;
            const relativePath = path.relative(this.rootDir, fullPath).replace(/\\/g, '/');
            if (this.shouldIgnore(relativePath)) continue;
            try {
                const hash = await this.hashFile(fullPath);
                fileHashes.set(relativePath, hash);
            } catch (error: any) {
                console.warn(`[Synchronizer] Cannot hash file ${relativePath}: ${error.message}`);
            }
        }
        if (onProgress) onProgress(total, total);
        return fileHashes;
    }

    private async generateFileHashesFromFS(
        dir: string,
        onProgress?: (current: number, total: number) => void,
    ): Promise<Map<string, string>> {
        const fileHashes = new Map<string, string>();

        let entries;
        try {
            entries = await fs.readdir(dir, { withFileTypes: true });
        } catch (error: any) {
            console.warn(`[Synchronizer] Cannot read directory ${dir}: ${error.message}`);
            return fileHashes;
        }

        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            const relativePath = path.relative(this.rootDir, fullPath);

            // Check if this path should be ignored BEFORE any file system operations
            if (this.shouldIgnore(relativePath)) {
                continue; // Skip completely - no access at all
            }

            // Double-check with fs.stat to be absolutely sure about file type
            let stat;
            try {
                stat = await fs.stat(fullPath);
            } catch (error: any) {
                console.warn(`[Synchronizer] Cannot stat ${fullPath}: ${error.message}`);
                continue;
            }

            if (stat.isDirectory()) {
                // Verify it's really a directory and not ignored
                if (!this.shouldIgnore(relativePath)) {
                    // Recurse with generateFileHashesFromFS directly — calling
                    // generateFileHashes would try git ls-files from the subdirectory,
                    // which returns repo-root-relative paths that produce wrong
                    // absolute paths when joined with the subdirectory (double-prefix).
                    const subHashes = await this.generateFileHashesFromFS(fullPath, onProgress);
                    const entries = Array.from(subHashes.entries());
                    for (let i = 0; i < entries.length; i++) {
                        const [p, h] = entries[i];
                        fileHashes.set(p, h);
                    }
                }
            } else if (stat.isFile()) {
                // Verify it's really a file and not ignored
                if (!this.shouldIgnore(relativePath)) {
                    if (this.supportedExtensions.length > 0 && !this.isSupported(entry.name)) {
                        continue;
                    }
                    try {
                        const hash = await this.hashFile(fullPath);
                        fileHashes.set(relativePath, hash);
                    } catch (error: any) {
                        console.warn(`[Synchronizer] Cannot hash file ${fullPath}: ${error.message}`);
                        continue;
                    }
                }
            }
            // Skip other types (symlinks, etc.)
        }
        return fileHashes;
    }

    /** Dot-directories that should NOT be automatically skipped (CI, config). */
    private static readonly ALLOWED_DOT_DIRS = new Set([
        '.github', '.circleci', '.devcontainer',
    ]);

    private shouldIgnore(relativePath: string): boolean {
        // Skip hidden files and directories (starting with "."), unless
        // the directory is a well-known CI/config directory.
        const pathParts = relativePath.split(path.sep);
        const hasDot = pathParts.some(part => {
            if (!part.startsWith('.')) return false;
            // Allow non-directory dotfiles (like .eslintrc.js, .env.example)
            // and well-known dot-directories (like .github/, .circleci/).
            if (part === pathParts[pathParts.length - 1]) {
                // It's the last segment (could be a file or directory).
                // Allow dot-files (but dot-directories need whitelist).
                const ext = part.includes('.', 1); // has extension after the dot?
                if (ext) return false; // dot-file like .eslintrc.js → allow
            }
            // It's a directory segment → only allow whitelisted ones.
            return !FileSynchronizer.ALLOWED_DOT_DIRS.has(part);
        });
        if (hasDot) return true;

        if (this.ignorePatterns.length === 0) {
            return false;
        }

        // Normalize path separators and remove leading/trailing slashes
        const normalizedPath = relativePath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');

        if (!normalizedPath) {
            return false; // Don't ignore root
        }

        // Check direct pattern matches first
        for (const pattern of this.ignorePatterns) {
            if (matchGlob(normalizedPath, pattern)) {
                return true;
            }
        }

        // Check if any parent directory is ignored
        const normalizedPathParts = normalizedPath.split('/');
        for (let i = 0; i < normalizedPathParts.length; i++) {
            const partialPath = normalizedPathParts.slice(0, i + 1).join('/');
            for (const pattern of this.ignorePatterns) {
                if (matchGlob(partialPath, pattern)) {
                    return true;
                }
            }
        }

        return false;
    }

    private buildMerkleDAG(fileHashes: Map<string, string>): MerkleDAG {
        const dag = new MerkleDAG();
        if (fileHashes.size === 0) return dag;

        const sortedPaths = Array.from(fileHashes.keys()).slice().sort();

        // Incremental streaming hash — avoids creating a 20MB+ root data
        // string (O(paths × avg-path-len)) which bloated memory, slowed
        // JSON serialization, and could cause the event loop to stall.
        const rootHasher = crypto.createHash('sha256');
        rootHasher.update('root:');
        for (const p of sortedPaths) {
            rootHasher.update(p);
            rootHasher.update(':');
            rootHasher.update(fileHashes.get(p)!);
            rootHasher.update(',');
        }
        const rootHash = rootHasher.digest('hex');

        // Compact root node — the leaf nodes were never used individually;
        // only the root hash matters for the "anything changed?" quick check
        // in MerkleDAG.compare. Individual file diffs come from compareStates.
        dag.addNode(`root:v2:${fileHashes.size}:${rootHash}`);

        return dag;
    }

    public async initialize() {
        console.log(`Initializing file synchronizer for ${this.rootDir}`);
        await this.loadSnapshot();
        this.merkleDAG = this.buildMerkleDAG(this.fileHashes);
        console.log(`[Synchronizer] File synchronizer initialized. Loaded ${this.fileHashes.size} file hashes.`);
    }

    public async checkForChanges(
        onProgress?: (phase: string, current: number, total: number) => void,
    ): Promise<{ added: string[], removed: string[], modified: string[] }> {
        console.log('[Synchronizer] Checking for file changes...');

        onProgress?.('Scanning files', 0, 1);
        const newFileHashes = await this.generateFileHashes(this.rootDir,
            (current, total) => onProgress?.('Hashing files', current, total),
        );

        onProgress?.('Building Merkle tree', 0, 1);
        const newMerkleDAG = this.buildMerkleDAG(newFileHashes);

        // Compare the DAGs
        const changes = MerkleDAG.compare(this.merkleDAG, newMerkleDAG);

        // If there are any changes in the DAG, do a file-level comparison
        if (changes.added.length > 0 || changes.removed.length > 0) {
            console.log('[Synchronizer] Merkle DAG has changed. Comparing file states...');
            const fileChanges = this.compareStates(this.fileHashes, newFileHashes);

            this.fileHashes = newFileHashes;
            this.merkleDAG = newMerkleDAG;
            this.dirty = true; // mark dirty — caller must call markClean() after successful indexing
            await this.saveSnapshot();

            console.log(`[Synchronizer] Found changes: ${fileChanges.added.length} added, ${fileChanges.removed.length} removed, ${fileChanges.modified.length} modified.`);
            return fileChanges;
        }

        console.log('[Synchronizer] No changes detected based on Merkle DAG comparison.');
        return { added: [], removed: [], modified: [] };
    }

    private compareStates(oldHashes: Map<string, string>, newHashes: Map<string, string>): { added: string[], removed: string[], modified: string[] } {
        const added: string[] = [];
        const removed: string[] = [];
        const modified: string[] = [];

        const newEntries = Array.from(newHashes.entries());
        for (let i = 0; i < newEntries.length; i++) {
            const [file, hash] = newEntries[i];
            if (!oldHashes.has(file)) {
                added.push(file);
            } else if (oldHashes.get(file) !== hash) {
                modified.push(file);
            }
        }

        const oldKeys = Array.from(oldHashes.keys());
        for (let i = 0; i < oldKeys.length; i++) {
            const file = oldKeys[i];
            if (!newHashes.has(file)) {
                removed.push(file);
            }
        }

        return { added, removed, modified };
    }

    public getFileHash(filePath: string): string | undefined {
        return this.fileHashes.get(filePath);
    }

    /** Get the list of files this dev has changed relative to root (for search masking). */
    getDevChangedFiles(): string[] {
        return Array.from(this.devChangedFiles);
    }

    /**
     * Set the list of files this dev has changed relative to root.
     * Called after a delta index completes. When root is unavailable
     * (full-index mode), this is empty — root layer is fully masked.
     */
    setDevChangedFiles(files: string[]): void {
        this.devChangedFiles = new Set(files);
    }

    /** Mark the snapshot as clean after successful indexing. */
    async markClean(): Promise<void> {
        if (!this.dirty) return;
        this.dirty = false;
        await this.saveSnapshot();
        console.log('[Synchronizer] Marked snapshot as clean — indexing completed successfully.');
    }

    /** Returns true if the snapshot is in a dirty (in-progress) state. */
    isDirty(): boolean {
        return this.dirty;
    }

    private async saveSnapshot(): Promise<void> {
        const merkleDir = path.dirname(this.snapshotPath);
        await fs.mkdir(merkleDir, { recursive: true });

        // Convert Map to array without using iterator
        const fileHashesArray: [string, string][] = [];
        const keys = Array.from(this.fileHashes.keys());
        keys.forEach(key => {
            fileHashesArray.push([key, this.fileHashes.get(key)!]);
        });

        const devChangedFilesArray = Array.from(this.devChangedFiles);
        const data = JSON.stringify({
            fileHashes: fileHashesArray,
            merkleDAG: this.merkleDAG.serialize(),
            status: this.dirty ? 'dirty' : 'clean',
            devChangedFiles: devChangedFilesArray,
        });
        await fs.writeFile(this.snapshotPath, data, 'utf-8');
        console.log(`Saved snapshot to ${this.snapshotPath} (status: ${this.dirty ? 'dirty' : 'clean'})`);
    }

    private async loadSnapshot(): Promise<void> {
        try {
            const data = await fs.readFile(this.snapshotPath, 'utf-8');
            const obj = JSON.parse(data);

            // Dirty snapshot → previous indexing was interrupted.
            // Reset to empty so the next sync treats all files as "added"
            // instead of falsely reporting "up-to-date".
            if (obj.status === 'dirty') {
                console.warn(`[Synchronizer] Snapshot is dirty (previous indexing interrupted). Resetting to empty state.`);
                this.fileHashes = new Map();
                this.merkleDAG = new MerkleDAG();
                this.dirty = true;
                return;
            }

            // Reconstruct Map without using constructor with iterator
            this.fileHashes = new Map();
            for (const [key, value] of obj.fileHashes) {
                this.fileHashes.set(key, value);
            }

            // Restore dev-changed file list
            if (obj.devChangedFiles && Array.isArray(obj.devChangedFiles)) {
                this.devChangedFiles = new Set(obj.devChangedFiles);
            }

            if (obj.merkleDAG) {
                this.merkleDAG = MerkleDAG.deserialize(obj.merkleDAG);
            }
            console.log(`Loaded snapshot from ${this.snapshotPath}`);
        } catch (error: any) {
            if (error.code === 'ENOENT') {
                // Snapshot missing — start with empty state. Do NOT save
                // an empty snapshot here (creates a "ghost up-to-date" bug).
                // The dirty flag will be set by checkForChanges and cleared
                // by markClean after successful indexing.
                console.log(`Snapshot file not found at ${this.snapshotPath}. Starting with empty state.`);
                this.fileHashes = new Map();
                this.merkleDAG = new MerkleDAG();
                this.dirty = true;
            } else {
                throw error;
            }
        }
    }

    /**
     * Delete snapshot file for a given codebase path.
     * @param codebasePath Path to the codebase
     * @param identityOverride Optional dev-aware identity for the snapshot file
     */
    static async deleteSnapshot(codebasePath: string, identityOverride?: string): Promise<void> {
        const homeDir = os.homedir();
        const merkleDir = path.join(homeDir, '.context', 'merkle');
        let identity: string;
        if (identityOverride) {
            identity = identityOverride;
        } else {
            identity = getRepoIdentity(codebasePath);
        }
        const hash = crypto.createHash('md5').update(identity).digest('hex');
        const snapshotPath = path.join(merkleDir, `${hash}.json`);

        try {
            await fs.unlink(snapshotPath);
            console.log(`Deleted snapshot file: ${snapshotPath}`);
        } catch (error: any) {
            if (error.code === 'ENOENT') {
                console.log(`Snapshot file not found (already deleted): ${snapshotPath}`);
            } else {
                console.error(`[Synchronizer] Failed to delete snapshot file ${snapshotPath}:`, error.message);
                throw error; // Re-throw non-ENOENT errors
            }
        }
    }
}
