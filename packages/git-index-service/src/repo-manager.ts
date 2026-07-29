import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { RepoSpec } from './config.js';
import { SshKeyManager } from './ssh-key.js';

/**
 * Owns local mirrors of the main repositories and keeps them at the tip of their
 * main branch. This is the "Git only" half of the PRD's Git Index Service: it
 * fetches from GitLab and produces a clean checkout; it never chunks, embeds, or
 * touches Milvus (that is delegated to the core Context by the Indexer).
 */
export class RepoManager {
    constructor(private workdir: string, private ssh: SshKeyManager) {}

    private dirFor(repo: RepoSpec): string {
        const hash = crypto.createHash('md5').update(`${repo.url}#${repo.branch}`).digest('hex').slice(0, 12);
        const safe = repo.name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 60);
        return path.join(this.workdir, `${safe}_${hash}`);
    }

    /** A repo authenticates over SSH whenever no token is configured. */
    private useSsh(repo: RepoSpec): boolean {
        return !repo.token;
    }

    /** Convert an https(s) URL to scp-style SSH form: git@host:group/repo.git */
    private toSshUrl(url: string): string {
        try {
            const u = new URL(url);
            if (u.protocol === 'https:' || u.protocol === 'http:') {
                const repoPath = u.pathname.replace(/^\/+/, '');
                return `git@${u.host}:${repoPath}`;
            }
        } catch { /* already scp/ssh form — use as-is */ }
        return url;
    }

    /**
     * The URL git actually fetches from: token → https with oauth2 basic auth;
     * no token → SSH (using the service deploy key). `origin` always stays the
     * canonical token-free URL so the index identity matches developer checkouts.
     */
    private fetchUrl(repo: RepoSpec): string {
        if (repo.token) {
            try {
                const u = new URL(repo.url);
                if (u.protocol === 'https:') {
                    u.username = 'oauth2';
                    u.password = repo.token;
                    return u.toString();
                }
            } catch { /* not an http url — use as-is */ }
            return repo.url;
        }
        return this.toSshUrl(repo.url);
    }

    private git(dir: string, args: string, useSsh = false): string {
        // Internal GitLab with a self-signed cert → set GIT_SSL_NO_VERIFY=true to skip TLS verify.
        const noVerify = String(process.env.GIT_SSL_NO_VERIFY || '').toLowerCase();
        const sslOpt = (noVerify === 'true' || noVerify === '1') ? '-c http.sslVerify=false ' : '';
        const env = { ...process.env };
        if (useSsh) env.GIT_SSH_COMMAND = this.ssh.sshCommand();
        return execSync(`git ${sslOpt}${args}`, {
            cwd: dir,
            env,
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
            timeout: 300_000,
            maxBuffer: 64 * 1024 * 1024,
        }).trim();
    }

    /**
     * Resolve the branch to actually fetch. If the configured branch exists on the
     * remote, use it; otherwise fall back to the remote's default branch (HEAD).
     * This makes "add repo, leave branch as main" work for repos whose default is
     * master/dev/etc., instead of failing with "couldn't find remote ref".
     */
    private resolveBranch(cwd: string, fetchUrl: string, requested: string, useSsh: boolean): string {
        try {
            const heads = this.git(cwd, `ls-remote --heads "${fetchUrl}" "${requested}"`, useSsh);
            if (heads.trim()) return requested;
        } catch { /* fall through to default */ }
        try {
            const symref = this.git(cwd, `ls-remote --symref "${fetchUrl}" HEAD`, useSsh);
            const m = symref.match(/^ref:\s+refs\/heads\/(\S+)\s+HEAD/m);
            if (m && m[1]) {
                console.warn(`[RepoManager] Branch '${requested}' not found on remote; using default '${m[1]}'.`);
                return m[1];
            }
        } catch { /* ignore — let the fetch fail with the original error */ }
        return requested;
    }

    /**
     * Ensure a local checkout of `repo` exists and is hard-reset to the tip of its
     * branch (falling back to the remote default branch when the configured one is
     * missing). The stored `origin` is the canonical URL (token-free) so the index
     * identity matches developer checkouts. Returns the local path and the branch
     * actually checked out.
     */
    ensureCheckout(repo: RepoSpec): { dir: string; branch: string } {
        fs.mkdirSync(this.workdir, { recursive: true });
        const fetchUrl = this.fetchUrl(repo);
        const useSsh = this.useSsh(repo);

        const branch = this.resolveBranch(this.workdir, fetchUrl, repo.branch, useSsh);
        const dir = this.dirFor({ ...repo, branch });

        if (!fs.existsSync(path.join(dir, '.git'))) {
            fs.mkdirSync(dir, { recursive: true });
            this.git(dir, 'init -q');
            this.git(dir, `remote add origin "${repo.url}"`);
        } else {
            // Keep origin canonical in case config changed.
            try { this.git(dir, `remote set-url origin "${repo.url}"`); } catch { /* ignore */ }
        }

        // Fetch full history (needed for commit-to-commit diffs) from the auth URL.
        this.git(dir, `fetch --prune "${fetchUrl}" "${branch}"`, useSsh);
        // Point a named local branch at the fetched tip so identity resolves to url:branch.
        this.git(dir, `checkout -B "${branch}" FETCH_HEAD`);
        this.git(dir, 'reset --hard FETCH_HEAD');

        return { dir, branch };
    }

    /**
     * List remote branches of a repo via `git ls-remote --heads`. Used by the
     * management API so clients (e.g. /seeway-link) can offer a pick-list of
     * branches to link/index. Throws on auth/network failure.
     */
    listRemoteBranches(repo: RepoSpec, timeoutMs = 30_000): string[] {
        const fetchUrl = this.fetchUrl(repo);
        const useSsh = this.useSsh(repo);
        const out = this.gitWithTimeout(this.workdir, `ls-remote --heads "${fetchUrl}"`, useSsh, timeoutMs);
        const branches: string[] = [];
        for (const line of out.split('\n')) {
            const m = line.match(/refs\/heads\/(\S+)\s*$/);
            if (m && m[1]) branches.push(m[1]);
        }
        return branches.sort();
    }

    /** git() variant with a caller-supplied timeout (for ls-remote listing). */
    private gitWithTimeout(dir: string, args: string, useSsh: boolean, timeoutMs: number): string {
        const noVerify = String(process.env.GIT_SSL_NO_VERIFY || '').toLowerCase();
        const sslOpt = (noVerify === 'true' || noVerify === '1') ? '-c http.sslVerify=false ' : '';
        const env = { ...process.env };
        if (useSsh) env.GIT_SSH_COMMAND = this.ssh.sshCommand();
        return execSync(`git ${sslOpt}${args}`, {
            cwd: dir,
            env,
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
            timeout: timeoutMs,
            maxBuffer: 64 * 1024 * 1024,
        }).trim();
    }
}
