import { execSync } from 'child_process';
import * as path from 'path';
import { normalizeGitUrl } from './git-identity';

/**
 * Git commit / diff helpers powering Git-based incremental indexing.
 *
 * This is the pure "Git Index Service" core logic described in the team-version
 * PRD: it knows how to read the current HEAD commit and compute exactly which
 * files changed between two commits, so the indexer never has to rescan an
 * entire repository. All functions are best-effort and never throw — a repo
 * without git, a detached state, or an unreachable base commit simply yields a
 * result that callers interpret as "fall back to a full index".
 */

export interface ChangedFiles {
    /** Files that exist at `toCommit` but not at `fromCommit` (status A). */
    added: string[];
    /** Files present in both but with different content (status M/R). */
    modified: string[];
    /** Files that existed at `fromCommit` but were removed at `toCommit` (status D). */
    deleted: string[];
}

const GIT_TIMEOUT_MS = 10_000;

function runGit(args: string, cwd: string): string {
    return execSync(`git ${args}`, {
        cwd,
        encoding: 'utf-8',
        timeout: GIT_TIMEOUT_MS,
        stdio: ['pipe', 'pipe', 'pipe'],
        maxBuffer: 10 * 1024 * 1024,
    }).trim();
}

/**
 * Whether `codebasePath` is inside a git working tree.
 */
export function isGitRepo(codebasePath: string): boolean {
    try {
        const resolved = path.resolve(codebasePath);
        return runGit('rev-parse --is-inside-work-tree', resolved) === 'true';
    } catch {
        return false;
    }
}

/**
 * Absolute path to the repository's top-level working directory, or null.
 * Used to map git's repo-root-relative diff paths onto an index root that may
 * be a subdirectory of the repo.
 */
export function getRepoRoot(codebasePath: string): string | null {
    try {
        const resolved = path.resolve(codebasePath);
        const root = runGit('rev-parse --show-toplevel', resolved);
        return root.length > 0 ? root : null;
    } catch {
        return null;
    }
}

/**
 * Current HEAD commit SHA, or null if unavailable (no git / empty repo).
 */
export function getHeadCommit(codebasePath: string): string | null {
    try {
        const resolved = path.resolve(codebasePath);
        const sha = runGit('rev-parse HEAD', resolved);
        return sha.length > 0 ? sha : null;
    } catch {
        return null;
    }
}

/**
 * Whether `ancestor` is reachable from `descendant` (i.e. a real ancestor in
 * the commit DAG). Used to decide if we can compute a meaningful diff from a
 * previously-indexed commit to HEAD; if not, callers do a full reindex.
 */
export function isAncestor(codebasePath: string, ancestor: string, descendant: string): boolean {
    if (!ancestor || !descendant) return false;
    try {
        const resolved = path.resolve(codebasePath);
        // Exit code 0 => ancestor; non-zero => not (execSync throws on non-zero).
        runGit(`merge-base --is-ancestor ${ancestor} ${descendant}`, resolved);
        return true;
    } catch {
        return false;
    }
}

/**
 * origin remote URL, or null. Used as the repository key for grouping branches.
 */
export function getRemoteUrl(codebasePath: string): string | null {
    try {
        const url = runGit('remote get-url origin', path.resolve(codebasePath));
        return url.length > 0 ? normalizeGitUrl(url) : null;
    } catch {
        return null;
    }
}

/**
 * Current branch name, or null if detached / unavailable.
 *
 * Reads the full symbolic ref and strips `refs/heads/` — neither
 * `rev-parse --abbrev-ref` nor `symbolic-ref --short` is safe, both return
 * `heads/<branch>` when a same-named tag exists. See getCheckedOutBranch.
 */
export function getCurrentBranch(codebasePath: string): string | null {
    try {
        const ref = runGit('symbolic-ref -q HEAD', path.resolve(codebasePath));
        return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : null;
    } catch {
        return null;
    }
}

/**
 * Resolve a ref (branch name, origin/<branch>, tag, sha) to a commit SHA, or null.
 * Used to diff a developer branch against their LOCAL view of main rather than
 * requiring the exact cloud-indexed commit to be present locally.
 */
export function getRefCommit(codebasePath: string, ref: string): string | null {
    if (!ref) return null;
    try {
        const sha = runGit(`rev-parse --verify --quiet ${ref}^{commit}`, path.resolve(codebasePath));
        return sha.length > 0 ? sha : null;
    } catch {
        return null;
    }
}

/**
 * Merge-base (closest common ancestor) of two commits, or null.
 */
export function getMergeBase(codebasePath: string, a: string, b: string): string | null {
    if (!a || !b) return null;
    try {
        const mb = runGit(`merge-base ${a} ${b}`, path.resolve(codebasePath));
        return mb.length > 0 ? mb : null;
    } catch {
        return null;
    }
}

/**
 * Committer timestamp (unix seconds) of a commit, or null. Used to pick the
 * "closest" (most recent) ancestor branch when resolving a base.
 */
export function getCommitTimestamp(codebasePath: string, commit: string): number | null {
    if (!commit) return null;
    try {
        const ts = runGit(`show -s --format=%ct ${commit}`, path.resolve(codebasePath));
        const n = Number(ts);
        return Number.isFinite(n) ? n : null;
    } catch {
        return null;
    }
}

/**
 * Whether a commit object exists in this repository.
 */
export function commitExists(codebasePath: string, commit: string): boolean {
    if (!commit) return false;
    try {
        const resolved = path.resolve(codebasePath);
        runGit(`cat-file -e ${commit}^{commit}`, resolved);
        return true;
    } catch {
        return false;
    }
}

/**
 * Compute the set of files that changed between two commits, classified into
 * added / modified / deleted. Also folds the working-tree diff (uncommitted
 * edits) against `toCommit` into the result, so an incremental index picks up
 * changes that have not been committed yet — matching the previous
 * Merkle-based behavior which hashed the working tree.
 *
 * Paths are repo-root-relative (git's native form). When the index root is a
 * subdirectory of the repo, callers filter/normalize via `repoRelativePrefix`.
 *
 * Returns null when the diff cannot be computed (missing/unreachable base
 * commit, non-git repo, etc.) so the caller can fall back to a full index.
 */
export function diffChangedFiles(
    codebasePath: string,
    fromCommit: string,
    toCommit: string = 'HEAD',
): ChangedFiles | null {
    try {
        const resolved = path.resolve(codebasePath);
        if (!commitExists(resolved, fromCommit)) {
            return null;
        }

        const result: ChangedFiles = { added: [], modified: [], deleted: [] };
        const seen = new Set<string>();

        const apply = (raw: string) => {
            const lines = raw.split('\n').filter(Boolean);
            for (const line of lines) {
                // Format: "<STATUS>\t<path>" or "R<score>\t<old>\t<new>"
                const parts = line.split('\t');
                const status = parts[0]?.[0]; // first char: A/M/D/R/C/T
                if (!status) continue;
                const file = parts[parts.length - 1];
                if (!file || seen.has(file)) continue;
                seen.add(file);
                if (status === 'A') {
                    result.added.push(file);
                } else if (status === 'D') {
                    result.deleted.push(file);
                } else {
                    // M, R, C, T → treat as modified (delete old chunks + re-embed)
                    result.modified.push(file);
                }
            }
        };

        // Committed changes between the two commits.
        apply(runGit(`diff --name-status ${fromCommit} ${toCommit}`, resolved));

        // Uncommitted working-tree + staged changes on top of toCommit, so we
        // don't miss edits that haven't been committed. `-M` detects renames.
        try {
            apply(runGit(`diff --name-status -M HEAD`, resolved));
        } catch {
            // Working-tree diff is best-effort.
        }

        return result;
    } catch {
        return null;
    }
}
