import { exec } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { RepoSpec } from './config.js';
import { SshKeyManager } from './ssh-key.js';
import { tokenUserCandidates } from './git-host.js';

/**
 * Owns local mirrors of the main repositories and keeps them at the tip of their
 * main branch. This is the "Git only" half of the PRD's Git Index Service: it
 * fetches from GitLab and produces a clean checkout; it never chunks, embeds, or
 * touches Milvus (that is delegated to the core Context by the Indexer).
 */
export class RepoManager {
    /** host → basic-auth username that authenticated successfully (see authUrls). */
    private hostTokenUser = new Map<string, string>();

    constructor(private workdir: string, private ssh: SshKeyManager) {}

    /**
     * One checkout per *repository*, not per branch. A per-branch directory meant a
     * full clone of the same objects for every protected branch — measured 6 × 30 MB
     * for one 6-branch repo, which at the planned scale (hundreds of repos × several
     * branches) becomes the binding constraint on a shared data partition. Branches
     * of one repo are indexed sequentially in the same directory instead, so their
     * objects are stored once and only the working tree is switched.
     *
     * Keyed by name + url so two configs pointing at the same remote stay isolated:
     * a worker owns a whole repo, which is what makes cross-repo concurrency safe.
     */
    private dirFor(repo: RepoSpec): string {
        const hash = crypto.createHash('md5').update(`${repo.name}#${repo.url}`).digest('hex').slice(0, 12);
        const safe = repo.name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 60);
        return path.join(this.workdir, `${safe}_${hash}`);
    }

    /**
     * Delete checkout directories that no longer belong to any configured repo —
     * repos removed from the console, and the per-branch directories left behind by
     * the older layout. Without this the workdir only ever grows: stale clones of
     * deleted repos are never reclaimed. Called at the start of each indexing pass.
     */
    pruneStale(repos: RepoSpec[]): { removed: string[]; freedBytes: number } {
        const removed: string[] = [];
        let freedBytes = 0;
        if (!fs.existsSync(this.workdir)) return { removed, freedBytes };

        const keep = new Set(repos.map(r => path.basename(this.dirFor(r))));
        for (const entry of fs.readdirSync(this.workdir, { withFileTypes: true })) {
            if (!entry.isDirectory() || keep.has(entry.name)) continue;
            const full = path.join(this.workdir, entry.name);
            // Only ever remove something that is itself a git checkout — never an
            // unrelated directory that happens to share the workdir.
            if (!fs.existsSync(path.join(full, '.git'))) continue;
            try {
                freedBytes += dirSize(full);
                fs.rmSync(full, { recursive: true, force: true });
                removed.push(entry.name);
            } catch (e: any) {
                console.warn(`[RepoManager] failed to prune '${entry.name}': ${e?.message || e}`);
            }
        }
        return { removed, freedBytes };
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
     * A token may be given as `<basicAuthUser>:<secret>` to pin the basic-auth
     * username explicitly (e.g. `private-token:abc123`), or as a bare secret and
     * let the host flavor decide it.
     */
    private splitToken(token: string): { user?: string; secret: string } {
        const i = token.indexOf(':');
        if (i > 0) return { user: token.slice(0, i), secret: token.slice(i + 1) };
        return { secret: token };
    }

    /**
     * Convert an scp-style or ssh:// URL to https form, so a token can be attached
     * to it. Pasting a repo's SSH clone URL together with a token is a natural
     * thing to do, and silently dropping the token would fail on a missing deploy
     * key instead — an error that points nowhere near the real cause.
     */
    private toHttpsUrl(url: string): string {
        if (/^https?:\/\//i.test(url)) return url;
        const ssh = url.match(/^(?:ssh|git):\/\/(?:[^@/]+@)?([^:/]+)(?::\d+)?\/(.+)$/i);
        if (ssh) return `https://${ssh[1]}/${ssh[2]}`;
        const scp = url.match(/^(?:[A-Za-z0-9._-]+@)?([^:/\s]+):(?!\/)(.+)$/);
        if (scp) return `https://${scp[1]}/${scp[2]}`;
        return url;
    }

    /**
     * Authentication candidates git may fetch from, tried in order.
     *
     * Each entry carries its own `useSsh` flag — no global "this repo is SSH or
     * HTTPS" switch. The strategy per repo config:
     *
     *   token present → HTTPS basic auth only (one URL per credential flavor).
     *   no token      → anonymous HTTPS first (public repos), then SSH deploy key.
     *
     * The canonical `origin` remote always holds the token-free URL so the index
     * identity matches developer checkouts regardless of the auth path that won.
     */
    private authUrls(repo: RepoSpec): { url: string; useSsh: boolean }[] {
        if (!repo.token) {
            const out: { url: string; useSsh: boolean }[] = [];
            if (/^https?:\/\//i.test(repo.url)) {
                out.push({ url: repo.url, useSsh: false });
            }
            out.push({ url: this.toSshUrl(repo.url), useSsh: true });
            return out;
        }

        // A token only travels over https basic auth — normalize SSH forms first.
        const httpsUrl = this.toHttpsUrl(repo.url);
        let parsed: URL;
        try {
            parsed = new URL(httpsUrl);
        } catch {
            return [{ url: repo.url, useSsh: false }];
        }
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
            return [{ url: repo.url, useSsh: false }];
        }

        const { user, secret } = this.splitToken(repo.token);
        const cached = this.hostTokenUser.get(parsed.host);
        const users = user ? [user] : cached ? [cached] : tokenUserCandidates(parsed.hostname);

        return users.map(name => {
            const withAuth = new URL(httpsUrl);
            withAuth.username = name;
            withAuth.password = secret;
            return { url: withAuth.toString(), useSsh: false };
        });
    }

    /** Remember which basic-auth username worked, so later commands skip the probing. */
    private rememberTokenUser(url: string): void {
        try {
            const u = new URL(url);
            if (u.username && u.password) this.hostTokenUser.set(u.host, u.username);
        } catch { /* ssh form — nothing to remember */ }
    }

    /** Credential rejection (worth retrying with another username) vs any other failure. */
    private isAuthError(err: any): boolean {
        const m = String(err?.message || err).toLowerCase();
        return m.includes('authentication failed')
            || m.includes('access denied')
            || m.includes('401')
            || m.includes('403')
            || m.includes('could not read username');
    }

    /**
     * Run a git command that talks to the remote, trying each candidate credential
     * URL until one authenticates. `build` receives the fetch URL and returns the
     * git argument string. Non-auth failures propagate immediately.
     */
    private async gitRemote(
        dir: string,
        build: (fetchUrl: string) => string,
        repo: RepoSpec,
        timeoutMs?: number,
    ): Promise<string> {
        const candidates = this.authUrls(repo);
        let lastErr: any;
        for (let i = 0; i < candidates.length; i++) {
            const { url, useSsh } = candidates[i];
            try {
                const args = build(url);
                const out = timeoutMs === undefined
                    ? await this.git(dir, args, useSsh)
                    : await this.gitWithTimeout(dir, args, useSsh, timeoutMs);
                this.rememberTokenUser(url);
                return out;
            } catch (e: any) {
                lastErr = e;
                const more = i < candidates.length - 1;
                if (!this.isAuthError(e) || !more) throw e;
                if (useSsh) {
                    // Anonymous HTTPS failed; fall back to SSH deploy key.
                    console.warn(`[RepoManager] '${repo.name}': anonymous HTTPS failed, retrying with SSH deploy key.`);
                } else {
                    console.warn(`[RepoManager] '${repo.name}': credentials rejected, retrying with a different token username.`);
                }
            }
        }
        throw lastErr;
    }

    /** Strip the secret from any credentials embedded in a git error message before
     *  it reaches logs or an HTTP response (private-token:<token>@host →
     *  private-token:***@host). The username survives — it tells an admin which
     *  credential flavor was rejected. */
    private sanitizeError(err: any): Error {
        const msg = String(err?.message || err);
        const cleaned = msg
            .replace(/(https?:\/\/)([^/\s:@]+):[^@\s]+(@)/gi, '$1$2:***$3');
        const e = new Error(cleaned);
        (e as any).code = (err as any)?.code;
        return e;
    }

    /** Async git — never blocks the event loop, so /health /status stay responsive
     *  while a long fetch/reset is running (execSync froze the whole process). */
    private git(dir: string, args: string, useSsh = false): Promise<string> {
        // Internal GitLab with a self-signed cert → set GIT_SSL_NO_VERIFY=true to skip TLS verify.
        const noVerify = String(process.env.GIT_SSL_NO_VERIFY || '').toLowerCase();
        const sslOpt = (noVerify === 'true' || noVerify === '1') ? '-c http.sslVerify=false ' : '';
        const env = { ...process.env };
        if (useSsh) env.GIT_SSH_COMMAND = this.ssh.sshCommand();
        return new Promise((resolve, reject) => {
            exec(`git ${sslOpt}${args}`, {
                cwd: dir,
                env,
                encoding: 'utf-8',
                stdio: ['pipe', 'pipe', 'pipe'],
                timeout: 300_000,
                maxBuffer: 64 * 1024 * 1024,
            } as any, (err, stdout) => {
                if (err) return reject(this.sanitizeError(err));
                resolve(String(stdout).trim());
            });
        });
    }

    /**
     * Resolve the branch to actually fetch. Tries in order:
     *   1. The requested branch itself — if it exists on the remote, use it.
     *   2. `main` — canonical default branch on modern repos.
     *   3. `master` — legacy default.
     *   4. The remote's HEAD (symref) — last-resort fallback.
     *
     * This means a repo configured with an unusual branch still gets sorted when the
     * remote has main or master, keeping mature repos' branches at the top of the UI
     * even when the operator hasn't set main explicitly.
     */
    private async resolveBranch(cwd: string, repo: RepoSpec, requested: string): Promise<string> {
        try {
            const heads = await this.gitRemote(cwd, u => `ls-remote --heads "${u}" "${requested}"`, repo);
            if (heads.trim()) return requested;
        } catch { /* fall through */ }
        // Prefer main/master over whatever HEAD happens to point at — many real-world
        // repos never had their default branch set and HEAD points at a random dev branch.
        for (const canonical of ['main', 'master']) {
            if (canonical === requested) continue; // already tried above
            try {
                const heads = await this.gitRemote(cwd, u => `ls-remote --heads "${u}" "${canonical}"`, repo);
                if (heads.trim()) {
                    console.warn(`[RepoManager] Branch '${requested}' not found on remote; using '${canonical}' instead.`);
                    return canonical;
                }
            } catch { /* try next */ }
        }
        try {
            const symref = await this.gitRemote(cwd, u => `ls-remote --symref "${u}" HEAD`, repo);
            const m = symref.match(/^ref:\s+refs\/heads\/(\S+)\s+HEAD/m);
            if (m && m[1]) {
                console.warn(`[RepoManager] Branch '${requested}' not found on remote; using remote HEAD '${m[1]}'.`);
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
    async ensureCheckout(repo: RepoSpec): Promise<{ dir: string; branch: string }> {
        fs.mkdirSync(this.workdir, { recursive: true });

        const branch = await this.resolveBranch(this.workdir, repo, repo.branch);
        const dir = this.dirFor({ ...repo, branch });

        if (!fs.existsSync(path.join(dir, '.git'))) {
            fs.mkdirSync(dir, { recursive: true });
            await this.git(dir, 'init -q');
            await this.git(dir, `remote add origin "${repo.url}"`);
        } else {
            // Keep origin canonical in case config changed.
            try { await this.git(dir, `remote set-url origin "${repo.url}"`); } catch { /* ignore */ }
        }

        // Fetch full history (needed for commit-to-commit diffs) from the auth URL.
        await this.gitRemote(dir, u => `fetch --prune "${u}" "${branch}"`, repo);

        // The directory is shared by every branch of this repo, so the previous
        // branch's working tree has to be cleared before switching: `git ls-files
        // --others` (how the indexer enumerates files) counts untracked leftovers,
        // which would otherwise index a file from branch A into branch B.
        try { await this.git(dir, 'reset -q --hard'); } catch { /* unborn HEAD on a fresh init */ }
        try { await this.git(dir, 'clean -fdq'); } catch { /* nothing to clean */ }
        // Point a named local branch at the fetched tip so identity resolves to url:branch.
        await this.git(dir, `checkout -q -B "${branch}" FETCH_HEAD`);
        await this.git(dir, 'reset -q --hard FETCH_HEAD');
        try { await this.git(dir, 'clean -fdq'); } catch { /* nothing to clean */ }

        return { dir, branch };
    }

    /**
     * List remote branches of a repo via `git ls-remote --heads`. Used by the
     * management API so clients (e.g. /seeway-link) can offer a pick-list of
     * branches to link/index. Throws on auth/network failure.
     */
    async listRemoteBranches(repo: RepoSpec, timeoutMs = 30_000): Promise<string[]> {
        fs.mkdirSync(this.workdir, { recursive: true });
        const out = await this.gitRemote(this.workdir, u => `ls-remote --heads "${u}"`, repo, timeoutMs);
        const branches: string[] = [];
        for (const line of out.split('\n')) {
            const m = line.match(/refs\/heads\/(\S+)\s*$/);
            if (m && m[1]) branches.push(m[1]);
        }
        return branches.sort();
    }

    /** git() variant with a caller-supplied timeout (for ls-remote listing). */
    private gitWithTimeout(dir: string, args: string, useSsh: boolean, timeoutMs: number): Promise<string> {
        const noVerify = String(process.env.GIT_SSL_NO_VERIFY || '').toLowerCase();
        const sslOpt = (noVerify === 'true' || noVerify === '1') ? '-c http.sslVerify=false ' : '';
        const env = { ...process.env };
        if (useSsh) env.GIT_SSH_COMMAND = this.ssh.sshCommand();
        return new Promise((resolve, reject) => {
            exec(`git ${sslOpt}${args}`, {
                cwd: dir,
                env,
                encoding: 'utf-8',
                stdio: ['pipe', 'pipe', 'pipe'],
                timeout: timeoutMs,
                maxBuffer: 64 * 1024 * 1024,
            } as any, (err, stdout) => {
                if (err) return reject(this.sanitizeError(err));
                resolve(String(stdout).trim());
            });
        });
    }
}

/** Recursive size of a directory, best-effort (only used to report freed space). */
function dirSize(dir: string): number {
    let total = 0;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
    for (const e of entries) {
        const full = path.join(dir, e.name);
        try {
            if (e.isDirectory()) total += dirSize(full);
            else if (e.isFile()) total += fs.statSync(full).size;
        } catch { /* raced with deletion */ }
    }
    return total;
}
