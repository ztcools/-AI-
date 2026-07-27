/**
 * Shared dotfile / dot-directory path filtering.
 *
 * Used by both FileSynchronizer (file discovery) and Context (index filtering)
 * to keep dot-file handling consistent. Dot-directories are skipped unless
 * they are well-known CI/config directories; dot-files (e.g. .eslintrc.js)
 * are always allowed since they contain meaningful configuration/code.
 */

/** Dot-directories that should NOT be automatically skipped (CI, config). */
export const ALLOWED_DOT_DIRS: ReadonlySet<string> = new Set([
    '.github', '.circleci', '.devcontainer',
]);

/**
 * Check whether a repo-relative path should be skipped because it contains
 * a dot-directory segment (other than the well-known allowed ones).
 *
 * Dot-files (last segment has a dot followed by at least one character,
 * e.g. `.eslintrc.js`) are always kept.
 *
 * @returns true if the path should be excluded due to a dot-directory.
 */
export function shouldSkipDotPath(relativePath: string): boolean {
    // Use '/' for splitting — both Windows and POSIX paths are normalized
    // to forward slashes before calling this function.
    const parts = relativePath.replace(/\\/g, '/').split('/');
    return parts.some(part => {
        if (!part.startsWith('.')) return false;
        // Last segment: allow dot-files (has extension after the dot),
        // but still skip non-whitelisted dot-directories.
        if (part === parts[parts.length - 1]) {
            const hasExtension = part.includes('.', 1);
            if (hasExtension) return false; // dot-file → keep
        }
        // It's a directory segment → skip unless whitelisted.
        return !ALLOWED_DOT_DIRS.has(part);
    });
}
