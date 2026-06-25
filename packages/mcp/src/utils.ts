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
 * workspace markers (.git, package.json, .vscode, etc.)
 */
export function detectWorkspaceRoot(): string | null {
    let current = process.cwd();
    const root = path.parse(current).root;

    while (current !== root) {
        // Check for common workspace markers
        const markers = ['.git', 'package.json', 'pnpm-workspace.yaml', '.vscode'];
        for (const marker of markers) {
            if (fs.existsSync(path.join(current, marker))) {
                return current;
            }
        }
        current = path.dirname(current);
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