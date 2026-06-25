import * as path from "path";
import * as fs from "fs";

/**
 * Truncate content to specified length
 */
export function truncateContent(content: string, maxLength: number): string {
    if (content.length <= maxLength) {
        return content;
    }
    return content.substring(0, maxLength) + '...';
}

/**
 * Detect IDE workspace root by walking up from cwd to find common
 * workspace markers. Priority: .git (most reliable, only exists at repo root)
 * > package.json/pnpm-workspace.yaml/.vscode (fallback).
 *
 * Two-pass approach: first walk all the way up to find .git (guaranteed repo root),
 * if no .git found, walk up again and return the first directory with any other marker.
 * This prevents stopping prematurely at sub-package package.json in monorepos.
 */
export function detectWorkspaceRoot(): string | null {
    let current = process.cwd();
    const root = path.parse(current).root;

    // Pass 1: Find .git (definitive repo root marker)
    let cursor = current;
    while (cursor !== root) {
        if (fs.existsSync(path.join(cursor, '.git'))) {
            return cursor;
        }
        cursor = path.dirname(cursor);
    }

    // Pass 2: Fallback to other common workspace markers
    const fallbackMarkers = ['package.json', 'pnpm-workspace.yaml', '.vscode'];
    cursor = current;
    while (cursor !== root) {
        for (const marker of fallbackMarkers) {
            if (fs.existsSync(path.join(cursor, marker))) {
                return cursor;
            }
        }
        cursor = path.dirname(cursor);
    }

    return null;
}

/**
 * Resolve a user-provided path to an absolute codebase path.
 * Supports:
 * - Absolute paths (returned as-is)
 * - Relative paths (resolved against cwd)
 * - "." or "workspace" (auto-detect IDE workspace root)
 * - "~" or "home" (user home directory)
 */
export function resolveCodebasePath(inputPath: string): string {
    const trimmed = inputPath.trim();

    // Auto-detect workspace
    if (trimmed === '.' || trimmed === './' || trimmed.toLowerCase() === 'workspace') {
        const workspaceRoot = detectWorkspaceRoot();
        if (workspaceRoot) {
            console.log(`[PATH] Auto-detected workspace root: ${workspaceRoot}`);
            return workspaceRoot;
        }
        // Fallback to cwd
        console.log(`[PATH] Could not detect workspace root, falling back to cwd`);
        return process.cwd();
    }

    // Home directory
    if (trimmed === '~' || trimmed === 'home' || trimmed.startsWith('~/')) {
        const homeDir = require('os').homedir();
        const resolved = trimmed === '~' || trimmed === 'home'
            ? homeDir
            : path.join(homeDir, trimmed.slice(2));
        console.log(`[PATH] Resolved home path: ${trimmed} → ${resolved}`);
        return resolved;
    }

    // Already absolute
    if (path.isAbsolute(trimmed)) {
        return trimmed;
    }

    // Relative path - resolve against cwd
    const resolved = path.resolve(trimmed);
    console.log(`[PATH] Resolved relative path: ${trimmed} → ${resolved}`);
    return resolved;
}

/**
 * Ensure path is absolute. If relative path is provided, resolve it properly.
 * @deprecated Use resolveCodebasePath() instead for better workspace detection
 */
export function ensureAbsolutePath(inputPath: string): string {
    return resolveCodebasePath(inputPath);
}

export function trackCodebasePath(codebasePath: string): void {
    const absolutePath = ensureAbsolutePath(codebasePath);
    console.log(`[TRACKING] Tracked codebase path: ${absolutePath} (not marked as indexed)`);
} 