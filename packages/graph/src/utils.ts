/**
 * Shared utility functions for the graph package.
 */

/** Escape special regex characters in a string. */
export function escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}