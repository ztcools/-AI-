import * as http from 'http';
import { GitIndexer } from './indexer.js';
import { ConfigStore } from './config-store.js';
import { Scheduler } from './scheduler.js';
import { RepoSpec, normalizeProtectedBranches } from './config.js';
import { SshKeyManager } from './ssh-key.js';
import { RepoManager } from './repo-manager.js';
import { detectGitHost } from './git-host.js';

/**
 * Management HTTP API for the git index service. Framework-free. Enables CORS so
 * the PhiGent web UI can call it directly. Endpoints:
 *   GET  /health
 *   GET  /status                 overall status (schedule, repos, per-branch last runs)
 *   GET  /repos                  list repos (tokens masked)
 *   GET  /branches?name=<repo>   list remote branches of a repo (for /seeway-link pick-list)
 *   GET  /detect?url=<repoUrl>   detect hosting platform + expected token flavor
 *   GET  /ssh-key                the service SSH deploy public key
 *   POST /repos                  add/replace a repo {name,url,branch,protectedBranches?,token?}
 *   PUT  /repos/:name            update a repo (protectedBranches: omitted = keep, [] = clear)
 *   DELETE /repos/:name          remove a repo
 *   PUT  /schedule               {dailyHour|null, intervalMs}
 *   POST /index                  index all now (main + protected branches)
 *   POST /index/:name            index one repo now (all its branches)
 *   POST /index/:name/:branch    index one branch of one repo now
 */
export function startHttpServer(
    port: number,
    indexer: GitIndexer,
    store: ConfigStore,
    scheduler: Scheduler,
    sshKeys: SshKeyManager,
    repoManager: RepoManager,
): http.Server {
    const maskRepo = (r: RepoSpec) => {
        const host = detectGitHost(r.url);
        return {
            name: r.name,
            url: r.url,
            branch: r.branch,
            protectedBranches: r.protectedBranches || [],
            hasToken: !!r.token,
            // token → https clone/pull; no token → ssh with the service deploy key
            auth: r.token ? 'https' : 'ssh',
            // Detected hosting platform. The console displays it and uses it to
            // tell the operator which token flavor this host expects — the same
            // table the fetch path uses to pick a basic-auth username.
            platform: host.platform,
            platformLabel: host.label,
            tokenUser: host.tokenUser,
            urlScheme: host.scheme,
        };
    };

    const send = (res: http.ServerResponse, code: number, body: unknown) => {
        res.writeHead(code, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
        });
        res.end(JSON.stringify(body));
    };

    const readBody = (req: http.IncomingMessage): Promise<any> =>
        new Promise(resolve => {
            let raw = '';
            req.on('data', c => (raw += c));
            req.on('end', () => {
                if (!raw) return resolve({});
                try { resolve(JSON.parse(raw)); } catch { resolve(null); }
            });
            req.on('error', () => resolve(null));
        });

    const buildStatus = () => {
        const sched = scheduler.getSchedule();
        return {
            running: indexer.isRunning(),
            // `current` is the first in-flight repo — kept for console builds that
            // predate parallel passes. `currentAll` is every repo being indexed now.
            current: indexer.getCurrent(),
            currentAll: indexer.getCurrentAll(),
            concurrency: indexer.getConcurrency(),
            lastPassAt: indexer.getLastPassAt(),
            schedule: {
                dailyHour: sched.dailyHour,
                intervalMs: sched.intervalMs,
                nextRunAt: scheduler.getNextRunAt(),
            },
            repos: store.getRepos().map(r => ({
                ...maskRepo(r),
                // Per-branch last-run map: { "<branch>": RepoRunStatus, ... }
                lastRuns: indexer.getStatus(r.name),
            })),
        };
    };

    const server = http.createServer(async (req, res) => {
        const method = req.method || 'GET';
        const rawUrl = req.url || '/';
        const url = rawUrl.split('?')[0];
        const query = new URLSearchParams(rawUrl.includes('?') ? rawUrl.split('?')[1] : '');

        if (method === 'OPTIONS') return send(res, 204, {});

        try {
            if (method === 'GET' && url === '/health') {
                return send(res, 200, { status: 'ok', running: indexer.isRunning() });
            }
            if (method === 'GET' && url === '/status') {
                return send(res, 200, buildStatus());
            }
            if (method === 'GET' && url === '/repos') {
                return send(res, 200, { repos: store.getRepos().map(maskRepo) });
            }
            if (method === 'GET' && url === '/branches') {
                const name = query.get('name') || '';
                if (!name) return send(res, 400, { error: 'name query param is required' });
                const repo = store.getRepo(name);
                if (!repo) return send(res, 404, { error: `repo '${name}' not found` });
                try {
                    const branches = await repoManager.listRemoteBranches(repo);
                    return send(res, 200, { repo: name, branches: branches.map(b => ({ name: b })) });
                } catch (e: any) {
                    const msg = e?.message || String(e);
                    console.warn(`[Server] ls-remote failed for '${name}': ${msg}`);
                    return send(res, 502, { error: 'failed to list remote branches', message: msg });
                }
            }
            if (method === 'GET' && url === '/detect') {
                // Platform detection for a URL the operator is about to add. The
                // console previews the result (which token flavor, https vs ssh)
                // before the repo is saved, so a wrong paste is caught up front
                // rather than as an opaque "Access denied" at index time.
                const target = query.get('url') || '';
                if (!target) return send(res, 400, { error: 'url query param is required' });
                return send(res, 200, detectGitHost(target));
            }
            if (method === 'GET' && url === '/ssh-key') {
                return send(res, 200, { publicKey: sshKeys.getPublicKey() });
            }
            if (method === 'POST' && url === '/repos') {
                const body = await readBody(req);
                if (!body || !body.url || !body.name) {
                    return send(res, 400, { error: 'name and url are required' });
                }
                const branch = body.branch ? String(body.branch) : 'main';
                const repo: RepoSpec = {
                    name: String(body.name),
                    url: String(body.url),
                    branch,
                    protectedBranches: normalizeProtectedBranches(body.protectedBranches, branch),
                    token: body.token ? String(body.token) : undefined,
                };
                store.upsertRepo(repo);
                return send(res, 200, { ok: true, repo: maskRepo(repo) });
            }
            const repoMatch = url.match(/^\/repos\/(.+)$/);
            if (repoMatch) {
                const name = decodeURIComponent(repoMatch[1]);
                if (method === 'PUT') {
                    const existing = store.getRepo(name);
                    if (!existing) return send(res, 404, { error: 'repo not found' });
                    const body = await readBody(req);
                    if (!body) return send(res, 400, { error: 'invalid body' });
                    const newBranch = body.branch ? String(body.branch) : existing.branch;
                    const updated: RepoSpec = {
                        name: existing.name,
                        url: body.url ? String(body.url) : existing.url,
                        branch: newBranch,
                        // Omitted → keep; explicit (array or csv) → replace (may be empty).
                        protectedBranches: body.protectedBranches === undefined
                            ? (existing.protectedBranches || [])
                            : normalizeProtectedBranches(body.protectedBranches, newBranch),
                        // Empty string clears the token; omitted keeps the old one.
                        token: body.token === undefined ? existing.token : (body.token ? String(body.token) : undefined),
                    };
                    store.upsertRepo(updated);
                    return send(res, 200, { ok: true, repo: maskRepo(updated) });
                }
                if (method === 'DELETE') {
                    const removed = store.removeRepo(name);
                    return send(res, removed ? 200 : 404, { ok: removed });
                }
            }
            if (method === 'PUT' && url === '/schedule') {
                const body = await readBody(req);
                if (!body) return send(res, 400, { error: 'invalid body' });
                const current = scheduler.getSchedule();
                const dailyHour =
                    body.dailyHour === null ? null
                        : body.dailyHour !== undefined ? Math.max(0, Math.min(23, Number(body.dailyHour))) : current.dailyHour;
                const intervalMs =
                    body.intervalMs !== undefined ? Math.max(60000, Number(body.intervalMs)) : current.intervalMs;
                const next = { dailyHour, intervalMs };
                store.setSchedule(next);
                scheduler.reschedule(next);
                return send(res, 200, { ok: true, schedule: { ...next, nextRunAt: scheduler.getNextRunAt() } });
            }
            if (method === 'POST' && url === '/index') {
                if (indexer.isRunning()) return send(res, 409, { error: 'indexing already in progress' });
                void indexer.indexAll();
                return send(res, 202, { status: 'started' });
            }
            // /index/:name or /index/:name/:branch
            // Branch names may contain slashes (release/1.0, feature/x) — split on
            // the FIRST slash only: everything before it is the repo name, the rest
            // is the branch. Decode each segment after splitting.
            const indexMatch = url.match(/^\/index\/(.+)$/);
            if (method === 'POST' && indexMatch) {
                const rest = indexMatch[1];
                const firstSlash = rest.indexOf('/');
                const name = decodeURIComponent(firstSlash === -1 ? rest : rest.slice(0, firstSlash));
                const branch = firstSlash === -1 ? undefined : decodeURIComponent(rest.slice(firstSlash + 1));
                if (indexer.isRunning()) return send(res, 409, { error: 'indexing already in progress' });
                if (branch) {
                    void indexer.indexOneBranch(name, branch).then(r => {
                        if (r === null) console.warn(`[Server] index-now: repo '${name}' not found`);
                    });
                    return send(res, 202, { status: 'started', repo: name, branch });
                }
                void indexer.indexOneByName(name).then(r => {
                    if (r === null) console.warn(`[Server] index-now: repo '${name}' not found`);
                });
                return send(res, 202, { status: 'started', repo: name });
            }
            return send(res, 404, { error: 'not found' });
        } catch (e: any) {
            return send(res, 500, { error: e?.message || String(e) });
        }
    });
    server.listen(port, () => console.log(`[Server] Management API on :${port}`));
    return server;
}
