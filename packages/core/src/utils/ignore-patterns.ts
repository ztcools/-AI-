/**
 * Ignore-pattern loading and matching — extracted from Context for independent
 * testability and to reduce Context's coupling surface.
 *
 * Owns the per-instance pattern state (base + effective patterns) and provides
 * methods to load ignore files from a codebase, match individual paths, and
 * mutate the pattern list.
 *
 * Does NOT depend on Context, Embedding, VectorDatabase, or any other
 * subsystem — its only dependencies are fs and glob-matching.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { matchGlob } from './glob-matcher';
import { shouldSkipDotPath } from './path-filter';

export class IgnorePatternManager {
    /** Immutable base patterns (DEFAULT_IGNORE_PATTERNS + config/env patterns). */
    private baseIgnorePatterns: string[];
    /** Effective patterns = base + file-based + request-level. */
    private ignorePatterns: string[];

    constructor(basePatterns: string[]) {
        this.baseIgnorePatterns = IgnorePatternManager.dedupe(basePatterns);
        this.ignorePatterns = [...this.baseIgnorePatterns];
    }

    // ── Accessors ─────────────────────────────────────────────

    /** Effective ignore patterns (read-only copy). */
    getPatterns(): string[] {
        return [...this.ignorePatterns];
    }

    /** Base patterns (read-only copy). */
    getBasePatterns(): string[] {
        return [...this.baseIgnorePatterns];
    }

    // ── Loading ───────────────────────────────────────────────

    /**
     * Load ignore patterns from various ignore files in the codebase,
     * combining them with base + request-level patterns.
     * Returns the effective patterns for the current codebase/request.
     */
    async loadForCodebase(
        codebasePath: string,
        additionalPatterns: string[] = [],
    ): Promise<string[]> {
        try {
            let fileBasedPatterns: string[] = [];

            // Load all .xxxignore files in codebase directory.
            const ignoreFiles = await this.findIgnoreFiles(codebasePath);
            for (const ignoreFile of ignoreFiles) {
                const patterns = await this.loadIgnoreFile(ignoreFile, path.basename(ignoreFile));
                fileBasedPatterns.push(...patterns);
            }

            // Load global ~/.context/.contextignore.
            const globalPatterns = await this.loadGlobalIgnoreFile();
            fileBasedPatterns.push(...globalPatterns);

            const effective = IgnorePatternManager.dedupe([
                ...this.baseIgnorePatterns,
                ...additionalPatterns,
                ...fileBasedPatterns,
            ]);
            this.ignorePatterns = effective;

            if (fileBasedPatterns.length > 0 || additionalPatterns.length > 0) {
                console.log(
                    `[IgnorePatterns] 🚫 Loaded ${fileBasedPatterns.length} from ignore files ` +
                    `+ ${additionalPatterns.length} from request`
                );
            } else {
                console.log('[IgnorePatterns] 📄 No ignore files found, using base patterns');
            }
            return effective;
        } catch (error) {
            console.warn(`[IgnorePatterns] ⚠️ Failed to load: ${error}`);
            const fallback = IgnorePatternManager.dedupe([
                ...this.baseIgnorePatterns,
                ...additionalPatterns,
            ]);
            this.ignorePatterns = fallback;
            return fallback;
        }
    }

    // ── Matching ──────────────────────────────────────────────

    /**
     * Check if a file path matches any ignore pattern.
     * @param filePath  Absolute path to the file
     * @param basePath  Root directory to compute relative path from
     * @param patterns  Patterns to match against (defaults to effective set)
     */
    matches(filePath: string, basePath: string, patterns?: string[]): boolean {
        const relativePath = path.relative(basePath, filePath);

        // Dot-directory / dot-file filtering.
        if (shouldSkipDotPath(relativePath)) return true;

        const effectivePatterns = patterns ?? this.ignorePatterns;
        if (effectivePatterns.length === 0) return false;

        const normalizedPath = relativePath.replace(/\\/g, '/');

        for (const pattern of effectivePatterns) {
            if (matchGlob(normalizedPath, pattern)) {
                return true;
            }
        }

        return false;
    }

    // ── Mutation ──────────────────────────────────────────────

    /** Replace all base patterns with a new set. */
    updatePatterns(newPatterns: string[], defaultCount: number): void {
        this.baseIgnorePatterns = IgnorePatternManager.dedupe(newPatterns);
        this.ignorePatterns = [...this.baseIgnorePatterns];
        console.log(
            `[IgnorePatterns] 🚫 Updated patterns: ` +
            `${newPatterns.length - defaultCount} new + ${defaultCount} default = ${this.ignorePatterns.length} total`
        );
    }

    /** Add patterns without replacing existing ones. */
    addCustomPatterns(customPatterns: string[]): void {
        if (customPatterns.length === 0) return;
        const merged = IgnorePatternManager.dedupe([
            ...this.baseIgnorePatterns,
            ...customPatterns,
        ]);
        this.baseIgnorePatterns = merged;
        this.ignorePatterns = [...this.baseIgnorePatterns];
        console.log(
            `[IgnorePatterns] 🚫 Added ${customPatterns.length} custom patterns. ` +
            `Total: ${this.ignorePatterns.length}`
        );
    }

    /** Reset effective patterns to defaults only. */
    resetToDefaults(defaultPatterns: string[]): void {
        this.baseIgnorePatterns = [...defaultPatterns];
        this.ignorePatterns = [...this.baseIgnorePatterns];
        console.log(
            `[IgnorePatterns] 🔄 Reset to defaults: ${this.ignorePatterns.length} patterns`
        );
    }

    // ── Static helpers ────────────────────────────────────────

    /**
     * Parse ignore patterns from a file on disk.
     * Returns empty array when the file cannot be read.
     */
    static async fromFile(filePath: string): Promise<string[]> {
        try {
            const content = await fs.readFile(filePath, 'utf-8');
            return content
                .split('\n')
                .map(line => line.trim())
                .filter(line => line && !line.startsWith('#'));
        } catch (error) {
            console.warn(`[IgnorePatterns] ⚠️  Could not read ${filePath}: ${error}`);
            return [];
        }
    }

    /** Remove duplicate patterns from a list. */
    static dedupe(patterns: string[]): string[] {
        return [...new Set(patterns)];
    }

    // ── Private file-loading helpers ──────────────────────────

    private async findIgnoreFiles(codebasePath: string): Promise<string[]> {
        try {
            const entries = await fs.readdir(codebasePath, { withFileTypes: true });
            const ignoreFiles: string[] = [];

            for (const entry of entries) {
                if (
                    entry.isFile() &&
                    entry.name.startsWith('.') &&
                    entry.name.endsWith('ignore')
                ) {
                    ignoreFiles.push(path.join(codebasePath, entry.name));
                }
            }

            if (ignoreFiles.length > 0) {
                console.log(
                    `[IgnorePatterns] 📄 Found ignore files: ` +
                    ignoreFiles.map(f => path.basename(f)).join(', ')
                );
            }

            return ignoreFiles;
        } catch (error) {
            console.warn(`[IgnorePatterns] ⚠️ Failed to scan for ignore files: ${error}`);
            return [];
        }
    }

    private async loadGlobalIgnoreFile(): Promise<string[]> {
        try {
            const homeDir = os.homedir();
            const globalIgnorePath = path.join(homeDir, '.context', '.contextignore');
            return await this.loadIgnoreFile(globalIgnorePath, 'global .contextignore');
        } catch {
            return [];
        }
    }

    private async loadIgnoreFile(filePath: string, fileName: string): Promise<string[]> {
        // Single read — access() + readFile() is redundant I/O.
        const patterns = await IgnorePatternManager.fromFile(filePath);
        if (patterns.length > 0) {
            console.log(
                `[IgnorePatterns] 🚫 Loaded ${patterns.length} patterns from ${fileName}`
            );
            return patterns;
        }
        if (fileName.includes('global')) {
            console.log(`[IgnorePatterns] 📄 No ${fileName} file found`);
        }
        return [];
    }
}
