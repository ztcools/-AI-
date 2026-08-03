import * as path from "path";
import * as fs from "fs";
import * as os from "os";

/**
 * Truncate a code snippet to `maxLength`, cutting on a line boundary.
 *
 * Cutting mid-line hands the caller a half-written statement it may well try to
 * read as code; ending on the last complete line inside the budget costs at most
 * one line and says plainly how many were dropped. Falls back to a hard cut when
 * the first line alone is longer than the budget (minified or generated files).
 */
export function truncateContent(content: string, maxLength: number): string {
    if (content.length <= maxLength) {
        return content;
    }
    const head = content.substring(0, maxLength);
    const lastNewline = head.lastIndexOf('\n');
    const kept = lastNewline > 0 ? head.substring(0, lastNewline) : head;
    const droppedLines = content.substring(kept.length).split('\n').length - (lastNewline > 0 ? 1 : 0);
    return `${kept}\n// ... ${droppedLines} more line(s) truncated — Read the file for the rest`;
}

const SNIPPET_STOP_WORDS = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'how', 'what', 'where', 'when', 'why', 'which', 'who',
    'does', 'do', 'did', 'to', 'of', 'in', 'on', 'for', 'and', 'or', 'with', 'by', 'from', 'this',
    'that', 'it', 'its', 'be', 'been', 'get', 'set', 'code', 'function', 'class', 'method', 'file',
]);

const COMMENT_LINE = /^\s*(\/\/|\/\*|\*|#|--|;|<!--)/;

/**
 * 把片段窗口对到**查询相关的那几行**，而不是永远取 chunk 头部。
 *
 * AST 切分出的 chunk 可以远大于单条预算（实测 ap-client-api 一条命中 11KB，预算
 * 2000 字符），而 C++/Java 文件头部是几十行版权头 + include —— 取头部等于把近一半
 * token 花在"Copyright (c) …"上，真正命中的那个函数一个字都没进上下文。
 *
 * 打分只用行内是否出现查询词 + 是否像定义行，够用且不引入依赖；找不到锚点时退回
 * 原来的头部截断（短 chunk 走不到这里）。
 */
export function focusSnippet(content: string, maxLength: number, query: string): string {
    if (content.length <= maxLength) return content;

    const tokens = query
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(w => w.length > 2 && !SNIPPET_STOP_WORDS.has(w));
    if (tokens.length === 0) return truncateContent(content, maxLength);

    const lines = content.split('\n');
    // 代码行优先，注释行只作兜底。AUTOSAR / Java 这类文档注释极长的代码库里，一段
    // Doxygen 里塞着 5 个查询词是常态，纯按命中数打分会把窗口锚在注释中间，声明行
    // （`SetValue(...)`）反倒落在窗口之外 —— 实测 ap-client-api 的 SetValue 就是这么丢的。
    let bestLine = -1, bestScore = 0;
    let bestComment = -1, bestCommentScore = 0;
    for (let i = 0; i < lines.length; i++) {
        const lower = lines[i].toLowerCase();
        let score = 0;
        for (const t of tokens) if (lower.includes(t)) score++;
        if (score === 0) continue;
        if (COMMENT_LINE.test(lines[i])) {
            if (score > bestCommentScore) { bestCommentScore = score; bestComment = i; }
            continue;
        }
        if (/[({]\s*$|\)\s*(const|noexcept|override|;)?\s*\{?\s*$/.test(lines[i])) score += 0.5;
        if (score > bestScore) { bestScore = score; bestLine = i; }
    }
    if (bestLine < 0 && bestComment >= 0) bestLine = bestComment;
    if (bestLine < 0) {
        // 没有锚点：至少跳过开头的纯注释块（版权头），别把预算喂给它。
        let firstCode = 0;
        while (firstCode < lines.length && (COMMENT_LINE.test(lines[firstCode]) || lines[firstCode].trim() === '')) firstCode++;
        if (firstCode === 0 || firstCode >= lines.length) return truncateContent(content, maxLength);
        return renderWindow(lines, firstCode, maxLength);
    }
    return renderWindow(lines, Math.max(0, bestLine - 4), maxLength);
}

function renderWindow(lines: string[], start: number, maxLength: number): string {
    const out: string[] = [];
    let used = 0;
    let end = start;
    for (; end < lines.length; end++) {
        const cost = lines[end].length + 1;
        if (used + cost > maxLength && out.length > 0) break;
        out.push(lines[end]);
        used += cost;
    }
    const head = start > 0 ? `// ... ${start} line(s) above skipped\n` : '';
    const tail = end < lines.length ? `\n// ... ${lines.length - end} more line(s) truncated — Read the file for the rest` : '';
    return `${head}${out.join('\n')}${tail}`;
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
        const homeDir = os.homedir();
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
 */
export function ensureAbsolutePath(inputPath: string): string {
    return resolveCodebasePath(inputPath);
}

export function trackCodebasePath(codebasePath: string): void {
    const absolutePath = ensureAbsolutePath(codebasePath);
    console.log(`[TRACKING] Tracked codebase path: ${absolutePath} (not marked as indexed)`);
} 