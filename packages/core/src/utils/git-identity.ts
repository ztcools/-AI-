import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Canonicalize a git remote URL so the same repository maps to one identity
 * regardless of access protocol. All of these converge to the same string:
 *   https://host/group/repo.git
 *   http://host/group/repo
 *   https://oauth2:token@host/group/repo.git   (auth stripped)
 *   git@host:group/repo.git                     (scp form → https)
 *   ssh://git@host:2222/group/repo.git          (port dropped)
 * This lets a server that fetches over SSH and a developer who clones over
 * HTTPS share the same index, which is the whole point of the layered model.
 */
export function normalizeGitUrl(raw: string): string {
    let url = (raw || '').trim();
    if (!url) return url;

    // scp-like syntax: user@host:path (no scheme). Convert to a parseable https URL.
    if (!/:\/\//.test(url)) {
        const scp = url.match(/^[A-Za-z0-9._-]+@([^:/]+):(.+)$/);
        if (scp) url = `https://${scp[1]}/${scp[2]}`;
    }

    try {
        const u = new URL(url);
        const host = u.hostname.toLowerCase(); // hostname drops any :port
        let p = u.pathname.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/i, '');
        return `https://${host}/${p}.git`;
    } catch {
        return url.replace(/\/+$/, '').replace(/\.git$/i, '') + '.git';
    }
}

/**
 * Short name of the checked-out branch, or '' when HEAD is detached.
 *
 * Reads the FULL symbolic ref and strips `refs/heads/` ourselves. Both
 * `git rev-parse --abbrev-ref HEAD` and `git symbolic-ref --short HEAD` share
 * git's shorten_unambiguous_ref(), which abbreviates only as far as stays
 * unambiguous: a repo that also has a *tag* named like the branch yields
 * `heads/<branch>`. Real repos do this (a release process that tags a branch
 * name — verified on PhiLog's ap_debug_0304), and the fallout is silent: the
 * identity becomes `<url>:heads/main`, addressing a different collection than
 * the `<url>:main` everyone else uses, so the index just looks empty.
 */
export function getCheckedOutBranch(cwd: string): string {
    try {
        const ref = execSync('git symbolic-ref -q HEAD', {
            cwd,
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();
        return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : '';
    } catch {
        return ''; // detached HEAD, or not a git repo
    }
}

/**
 * HEAD 的原始内容（`ref: refs/heads/x` 或 detached 时的 sha），读不到返回 null。
 * 纯文件读，没有 spawn —— 用来给按路径缓存的 identity 做失效判定：同一个 checkout
 * 目录被 `git checkout` 换过分支后，缓存 key 必须跟着变。
 */
export function readHeadRef(codebasePath: string): string | null {
    try {
        const resolved = path.resolve(codebasePath);
        let gitDir = path.join(resolved, '.git');
        const st = fs.statSync(gitDir);
        if (st.isFile()) {
            const m = fs.readFileSync(gitDir, 'utf-8').match(/^gitdir:\s*(.+)$/m);
            if (!m) return null;
            gitDir = path.resolve(resolved, m[1].trim());
        }
        return fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf-8').trim() || null;
    } catch {
        return null;
    }
}

export function getRepoIdentity(codebasePath: string): string {
    const resolvedPath = path.resolve(codebasePath);

    try {
        const url = execSync('git remote get-url origin', {
            cwd: resolvedPath,
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe']
        }).trim();

        const branch = getCheckedOutBranch(resolvedPath);

        if (url && branch) {
            return `${normalizeGitUrl(url)}:${branch}`;
        }
    } catch {
    }

    return resolvedPath;
}
