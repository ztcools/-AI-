/**
 * Shared glob pattern matching utilities.
 * Used by both context.ts (vector indexing file traversal) and
 * synchronizer.ts (Merkle DAG change detection file traversal).
 */
import * as path from 'path';

/**
 * Match a file path against a glob pattern.
 * Supports: * wildcard, / root anchoring, / directory patterns
 */
export function matchGlob(filePath: string, pattern: string): boolean {
    const cleanPath = filePath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    const normalizedPattern = pattern.replace(/\\/g, '/');
    const cleanPattern = normalizedPattern.replace(/^\/+|\/+$/g, '');
    const isRootAnchored = normalizedPattern.startsWith('/');
    const isDirectoryPattern = normalizedPattern.endsWith('/');

    if (!cleanPath || !cleanPattern) {
        return false;
    }

    // Handle directory patterns (ending with /)
    if (isDirectoryPattern) {
        if (isRootAnchored) {
            return simpleGlobMatch(cleanPath, cleanPattern) ||
                cleanPath.startsWith(`${cleanPattern}/`);
        }
        return matchesDirectoryPattern(cleanPath, cleanPattern);
    }

    if (isRootAnchored) {
        return simpleGlobMatch(cleanPath, cleanPattern);
    }

    // Handle file patterns
    if (cleanPattern.includes('/')) {
        return simpleGlobMatch(cleanPath, cleanPattern);
    }

    // Pattern without path separator - match filename in any directory
    const fileName = path.basename(cleanPath);
    return simpleGlobMatch(fileName, cleanPattern);
}

/**
 * Check if a file path matches a directory pattern at any depth.
 */
function matchesDirectoryPattern(filePath: string, dirPattern: string): boolean {
    const pathParts = filePath.split('/');
    const dirPartCount = dirPattern.split('/').length;

    for (let i = 0; i <= pathParts.length - dirPartCount; i++) {
        const candidate = pathParts.slice(i, i + dirPartCount).join('/');
        if (simpleGlobMatch(candidate, dirPattern)) {
            return true;
        }
    }
    return false;
}

/**
 * Simple glob matching supporting * wildcard.
 */
function simpleGlobMatch(text: string, pattern: string): boolean {
    if (!text || !pattern) return false;

    const regexPattern = pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*');

    const regex = new RegExp(`^${regexPattern}$`);
    return regex.test(text);
}