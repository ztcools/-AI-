import * as path from 'path';
import { loadServiceConfig, buildContextPool, indexConcurrency, releaseAfterIndex } from './config.js';
import { createRepoProvider, StoreRepoProvider } from './repo-provider.js';
import { RepoManager } from './repo-manager.js';
import { GitIndexer } from './indexer.js';
import { Scheduler } from './scheduler.js';
import { startHttpServer } from './server.js';
import { ConfigStore } from './config-store.js';
import { RunStore } from './run-store.js';
import { SshKeyManager } from './ssh-key.js';

async function main(): Promise<void> {
    const config = loadServiceConfig();
    const concurrency = indexConcurrency();
    console.log('[GitIndexService] Starting with config:', {
        source: config.source,
        workdir: config.workdir,
        configFile: config.configFile,
        seedRepos: config.repos.length,
        runOnce: config.runOnce,
        dailyHour: config.dailyHour,
        intervalMs: config.intervalMs,
        httpPort: config.httpPort,
        concurrency,
        releaseAfterIndex: releaseAfterIndex(),
    });

    const contexts = buildContextPool(concurrency);
    const sshKeys = new SshKeyManager(config.sshDir);
    sshKeys.ensureKeyPair();
    const repoManager = new RepoManager(config.workdir, sshKeys);

    // Hot config store: repos + schedule persisted to a JSON file, seeded from env
    // on first run. Management API edits are written back and take effect live.
    const store = new ConfigStore(config.configFile, {
        repos: config.repos,
        schedule: { dailyHour: config.dailyHour, intervalMs: config.intervalMs },
        updatedAt: 0,
    });

    // Per-branch run status, in its own file so a status write can never corrupt
    // the repo list. Without it every restart blanks the console's index history.
    const runStore = new RunStore(path.join(path.dirname(config.configFile), 'git-index-runs.json'));

    // GitLab-source keeps API auto-discovery; otherwise repos come live from the store.
    const repoProvider = config.source === 'gitlab'
        ? createRepoProvider(config)
        : new StoreRepoProvider(store);
    const indexer = new GitIndexer({
        contexts,
        repoManager,
        repoProvider,
        store,
        runStore,
        releaseAfterIndex: releaseAfterIndex(),
    });

    if (config.runOnce) {
        const results = await indexer.indexAll();
        runStore.flush();
        const failed = results.filter(r => !r.ok).length;
        process.exit(failed > 0 ? 1 : 0);
    }

    const schedule = store.getSchedule();
    const scheduler = new Scheduler(() => indexer.indexAll(), {
        intervalMs: schedule.intervalMs,
        dailyHour: schedule.dailyHour,
    });

    if (config.httpPort) {
        startHttpServer(config.httpPort, indexer, store, scheduler, sshKeys, repoManager);
    }

    if (config.runOnStart) {
        void indexer.indexAll();
    }

    scheduler.start();

    const shutdown = () => {
        console.log('[GitIndexService] Shutting down...');
        scheduler.stop();
        // Flush any status coalesced but not yet written, so a redeploy mid-pass
        // doesn't lose the branches that already finished.
        runStore.flush();
        process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    console.log('[GitIndexService] Running. Waiting for scheduled passes.');
}

main().catch(err => {
    console.error('[GitIndexService] Fatal:', err?.message || err);
    process.exit(1);
});
