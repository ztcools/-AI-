/**
 * Test: SnapshotManager identity-based operations.
 * Verifies that all internal state uses identity (url:branch) as keys,
 * NOT absolute paths. This is the core of team-shared indexing.
 *
 * Strategy:
 * 1. Create two git repos in temp dirs (same remote, different paths)
 * 2. Simulate "indexing" on path A
 * 3. Verify path B is recognized as "already indexed" (same identity)
 * 4. Verify all public APIs return identities
 * 5. Verify snapshot save/load round-trip preserves identity keys
 * 6. Verify different branch → different identity → different entry
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync } from "node:child_process";

// Import directly from MCP package source
import { SnapshotManager } from "../packages/mcp/src/snapshot.js";
import { getRepoIdentity } from "../packages/core/src/utils/git-identity.js";

const REAL_REPO = "/home/zt/code-study-record";
const EXPECTED_URL = "https://github.com/ztcools/code-study-record.git";

/**
 * Each test gets an isolated HOME so snapshot files don't leak between tests.
 * This is critical because getIndexedCodebases() reads from the JSON file.
 */
async function withTempHome(run: (tempRoot: string) => Promise<void>): Promise<void> {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cc-snapshot-id-"));
    const homeDir = path.join(tempRoot, "home");
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;

    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;

    try {
        fs.mkdirSync(path.join(homeDir, ".context"), { recursive: true });
        await run(tempRoot);
    } finally {
        if (originalHome === undefined) {
            delete process.env.HOME;
        } else {
            process.env.HOME = originalHome;
        }
        if (originalUserProfile === undefined) {
            delete process.env.USERPROFILE;
        } else {
            process.env.USERPROFILE = originalUserProfile;
        }
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
}

/**
 * Creates a temp git repo by cloning the real repo, so getRepoIdentity
 * returns a real url:branch. Returns the path.
 */
function cloneTempRepo(tempRoot: string, suffix: string): string {
    const dir = path.join(tempRoot, `cc-test-${suffix}`);
    fs.rmSync(dir, { recursive: true, force: true });
    execSync(`git clone ${EXPECTED_URL} ${dir}`, { stdio: "pipe" });
    return dir;
}

// ─── Core identity tests ─────────────────────────────────────────────

test("SnapshotManager: same repo, different paths → same identity, single entry", async () => {
    await withTempHome(async (tempRoot) => {
        const repoA = cloneTempRepo(tempRoot, "repo-a");
        const repoB = cloneTempRepo(tempRoot, "repo-b");
        const sm = new SnapshotManager();

        // Index repo A
        sm.setCodebaseIndexed(repoA, { indexedFiles: 10, totalChunks: 50, status: "completed" });
        sm.saveCodebaseSnapshot();

        // Verify repoA is indexed
        const indexed = sm.getIndexedCodebases();
        console.log(`  indexed after A: ${JSON.stringify(indexed)}`);
        assert.equal(indexed.length, 1);
        assert.ok(indexed[0].includes("://"), `indexed entry should be identity, got: ${indexed[0]}`);
        assert.ok(!indexed[0].startsWith("/"), `indexed entry must NOT be absolute path, got: ${indexed[0]}`);

        // Verify identity is the same for both paths
        const identityB = getRepoIdentity(repoB);
        const identityA = getRepoIdentity(repoA);
        console.log(`  identity A: ${identityA}`);
        console.log(`  identity B: ${identityB}`);
        assert.equal(identityA, identityB, "same repo should have same identity");
        assert.ok(sm.getIndexedCodebases().includes(identityB), "identity of repoB should be in indexed list");

        // Verify getCodebaseInfo works with both paths
        const infoA = sm.getCodebaseInfo(repoA);
        const infoB = sm.getCodebaseInfo(repoB);
        assert.ok(infoA, "repoA should have info");
        assert.ok(infoB, "repoB should have info (same identity)");
        assert.equal(infoA!.localPath, repoA);
        assert.equal(infoB!.localPath, repoA);

        // Verify findIndexedCodebasePath works
        const foundA = sm.findIndexedCodebasePath(repoA);
        const foundB = sm.findIndexedCodebasePath(repoB);
        console.log(`  findIndexedCodebasePath(A) = ${foundA}`);
        console.log(`  findIndexedCodebasePath(B) = ${foundB}`);
        assert.ok(foundA, "should find repoA");
        assert.ok(foundB, "should find repoB via identity");
        assert.equal(foundA, repoA);
        assert.equal(foundB, repoA);

        // Verify getCodebaseStatus
        assert.equal(sm.getCodebaseStatus(repoA), "indexed");
        assert.equal(sm.getCodebaseStatus(repoB), "indexed");
    });
});

test("SnapshotManager: getIndexedCodebases returns identities, not paths", async () => {
    await withTempHome(async (tempRoot) => {
        const repoA = cloneTempRepo(tempRoot, "identity-format");
        const sm = new SnapshotManager();

        sm.setCodebaseIndexed(repoA, { indexedFiles: 5, totalChunks: 25, status: "completed" });
        sm.saveCodebaseSnapshot();
        const indexed = sm.getIndexedCodebases();
        console.log(`  indexed: ${JSON.stringify(indexed)}`);

        assert.equal(indexed.length, 1);
        assert.ok(indexed[0].includes("://"), `Expected url-based identity, got: ${indexed[0]}`);
        assert.ok(indexed[0].includes(":master"), `Expected branch suffix, got: ${indexed[0]}`);
        assert.ok(!indexed[0].includes("/tmp/"), "identity should not contain tmp path");
    });
});

// ─── State transition tests ──────────────────────────────────────────

test("SnapshotManager: setCodebaseIndexing → identity keyed", async () => {
    await withTempHome(async (tempRoot) => {
        const repo = cloneTempRepo(tempRoot, "indexing-test");
        const sm = new SnapshotManager();

        sm.setCodebaseIndexing(repo, 42);
        sm.saveCodebaseSnapshot();
        const indexing = sm.getIndexingCodebases();
        console.log(`  indexing: ${JSON.stringify(indexing)}`);

        assert.equal(indexing.length, 1);
        assert.ok(indexing[0].includes("://"), `indexing entry should be identity, got: ${indexing[0]}`);

        const info = sm.getCodebaseInfo(repo);
        assert.ok(info);
        assert.equal(info!.status, "indexing");
        assert.equal(info!.localPath, repo);
        if (info!.status === "indexing") {
            assert.equal(info!.indexingPercentage, 42);
        }
    });
});

test("SnapshotManager: full lifecycle (indexing → indexed → failed) via identity", async () => {
    await withTempHome(async (tempRoot) => {
        const repo = cloneTempRepo(tempRoot, "lifecycle");
        const sm = new SnapshotManager();

        // 1. Set to indexing
        sm.setCodebaseIndexing(repo, 0);
        sm.saveCodebaseSnapshot();
        assert.equal(sm.getCodebaseStatus(repo), "indexing");
        const indexing = sm.getIndexingCodebases();
        assert.ok(indexing.length === 1 && indexing[0].includes("://"));

        // 2. Progress update
        sm.setCodebaseIndexing(repo, 50);
        const infoIdx = sm.getCodebaseInfo(repo);
        if (infoIdx?.status === "indexing") {
            assert.equal(infoIdx.indexingPercentage, 50);
        }

        // 3. Set to indexed
        sm.setCodebaseIndexed(repo, { indexedFiles: 100, totalChunks: 500, status: "completed" });
        sm.saveCodebaseSnapshot();
        assert.equal(sm.getCodebaseStatus(repo), "indexed");
        assert.equal(sm.getIndexingCodebases().length, 0, "indexing list should be empty");
        assert.equal(sm.getIndexedCodebases().length, 1, "should be in indexed list");

        const infoDone = sm.getCodebaseInfo(repo);
        assert.ok(infoDone);
        assert.equal(infoDone!.status, "indexed");
        assert.equal(infoDone!.localPath, repo);
        if (infoDone!.status === "indexed") {
            assert.equal(infoDone!.indexedFiles, 100);
            assert.equal(infoDone!.totalChunks, 500);
        }

        // 4. Set to failed (simulating retry)
        sm.setCodebaseIndexFailed(repo, "test failure", 42);
        sm.saveCodebaseSnapshot();
        assert.equal(sm.getCodebaseStatus(repo), "indexfailed");
        assert.equal(sm.getIndexedCodebases().length, 0, "should be removed from indexed");

        const infoFailed = sm.getCodebaseInfo(repo);
        assert.ok(infoFailed);
        assert.equal(infoFailed!.status, "indexfailed");
        assert.equal(infoFailed!.localPath, repo);
        if (infoFailed!.status === "indexfailed") {
            assert.equal(infoFailed!.errorMessage, "test failure");
        }
    });
});

// ─── Snapshot persistence tests ──────────────────────────────────────

test("SnapshotManager: save/load round-trip preserves identity keys", async () => {
    await withTempHome(async (tempRoot) => {
        const repo = cloneTempRepo(tempRoot, "persist");
        const sm1 = new SnapshotManager();

        sm1.setCodebaseIndexed(repo, { indexedFiles: 7, totalChunks: 35, status: "completed" });
        sm1.saveCodebaseSnapshot();

        // Load in a new instance
        const sm2 = new SnapshotManager();
        sm2.loadCodebaseSnapshot();

        const indexed = sm2.getIndexedCodebases();
        console.log(`  after reload: ${JSON.stringify(indexed)}`);
        assert.equal(indexed.length, 1);
        assert.ok(indexed[0].includes("://"), "reloaded identity should be url-based");

        // Verify full info recovery
        const info = sm2.getCodebaseInfo(repo);
        assert.ok(info);
        assert.equal(info!.status, "indexed");
        assert.equal(info!.localPath, repo);
        if (info!.status === "indexed") {
            assert.equal(info!.indexedFiles, 7);
            assert.equal(info!.totalChunks, 35);
        }
    });
});

test("SnapshotManager: save/load preserves multiple codebases with different identities", async () => {
    await withTempHome(async (tempRoot) => {
        const repo1 = cloneTempRepo(tempRoot, "multi-1");
        const sm = new SnapshotManager();

        // Index repo1 on master branch
        sm.setCodebaseIndexed(repo1, { indexedFiles: 10, totalChunks: 50, status: "completed" });

        // Create a second repo with different branch
        const repo2 = path.join(tempRoot, "cc-test-multi-2");
        fs.rmSync(repo2, { recursive: true, force: true });
        execSync(`git clone -b master ${EXPECTED_URL} ${repo2}`, { stdio: "pipe" });
        execSync("git checkout -b test-branch-multi", { cwd: repo2, stdio: "pipe" });
        sm.setCodebaseIndexed(repo2, { indexedFiles: 5, totalChunks: 25, status: "completed" });

        sm.saveCodebaseSnapshot();

        const sm2 = new SnapshotManager();
        sm2.loadCodebaseSnapshot();

        const indexed = sm2.getIndexedCodebases();
        console.log(`  after reload: ${JSON.stringify(indexed)}`);
        assert.equal(indexed.length, 2, "should have 2 entries for 2 different branches");

        for (const entry of indexed) {
            assert.ok(entry.includes("://"), `entry should be identity, got: ${entry}`);
        }
        assert.notEqual(indexed[0], indexed[1], "different branches should have different identities");
        assert.ok(indexed.some(e => e.includes(":master")), "should have master entry");
        assert.ok(indexed.some(e => e.includes(":test-branch-multi")), "should have test branch entry");
    });
});

// ─── toIdentity passthrough test ─────────────────────────────────────

test("SnapshotManager: getCodebaseInfo/Status accept identity string directly", async () => {
    await withTempHome(async (tempRoot) => {
        const repo = cloneTempRepo(tempRoot, "passthrough");
        const sm = new SnapshotManager();

        sm.setCodebaseIndexed(repo, { indexedFiles: 1, totalChunks: 1, status: "completed" });
        sm.saveCodebaseSnapshot();
        const identity = sm.getIndexedCodebases()[0];
        console.log(`  identity from disk: ${identity}`);

        // getCodebaseInfo should work with the identity directly
        const info = sm.getCodebaseInfo(identity);
        assert.ok(info, "getCodebaseInfo should accept identity string directly");
        assert.equal(info!.status, "indexed");
        assert.equal(info!.localPath, repo);

        // getCodebaseStatus should also work
        const status = sm.getCodebaseStatus(identity);
        assert.equal(status, "indexed");
    });
});

// ─── removeCodebaseCompletely test ───────────────────────────────────

test("SnapshotManager: removeCodebaseCompletely removes by identity", async () => {
    await withTempHome(async (tempRoot) => {
        const repo = cloneTempRepo(tempRoot, "remove");
        const sm = new SnapshotManager();

        sm.setCodebaseIndexed(repo, { indexedFiles: 1, totalChunks: 1, status: "completed" });
        sm.saveCodebaseSnapshot();
        assert.equal(sm.getIndexedCodebases().length, 1);

        // Remove via a different path (same repo clone)
        const repo2 = cloneTempRepo(tempRoot, "remove-clone");
        sm.removeCodebaseCompletely(repo2);
        sm.saveCodebaseSnapshot();
        assert.equal(sm.getIndexedCodebases().length, 0, "should be removed via identity");
        assert.equal(sm.getCodebaseStatus(repo), "not_found");
    });
});

// ─── findTrackedCodebasePath test ────────────────────────────────────

test("SnapshotManager: findTrackedCodebasePath returns localPath", async () => {
    await withTempHome(async (tempRoot) => {
        const repo = cloneTempRepo(tempRoot, "tracked");
        const sm = new SnapshotManager();

        sm.setCodebaseIndexed(repo, { indexedFiles: 1, totalChunks: 1, status: "completed" });
        sm.saveCodebaseSnapshot();

        const tracked = sm.findTrackedCodebasePath(repo);
        console.log(`  tracked: ${tracked}`);
        assert.ok(tracked, "should find tracked codebase");
        assert.equal(tracked, repo);

        // Also findable via clone
        const repo2 = cloneTempRepo(tempRoot, "tracked-clone");
        const tracked2 = sm.findTrackedCodebasePath(repo2);
        assert.ok(tracked2, "should find via clone's identity");
        assert.equal(tracked2, repo, "should return original localPath");
    });
});

// ─── getFailedCodebases test ─────────────────────────────────────────

test("SnapshotManager: getFailedCodebases returns identities", async () => {
    await withTempHome(async (tempRoot) => {
        const repo = cloneTempRepo(tempRoot, "failed");
        const sm = new SnapshotManager();

        sm.setCodebaseIndexFailed(repo, "test error", 30);
        sm.saveCodebaseSnapshot();
        const failed = sm.getFailedCodebases();
        console.log(`  failed: ${JSON.stringify(failed)}`);

        assert.equal(failed.length, 1);
        assert.ok(failed[0].includes("://"), `failed entry should be identity, got: ${failed[0]}`);
    });
});

// ─── getCodebaseInfoFromDisk test ────────────────────────────────────

test("SnapshotManager: getCodebaseInfoFromDisk works with identity lookup", async () => {
    await withTempHome(async (tempRoot) => {
        const repo = cloneTempRepo(tempRoot, "disk");
        const sm = new SnapshotManager();

        sm.setCodebaseIndexed(repo, { indexedFiles: 3, totalChunks: 15, status: "completed" });
        sm.saveCodebaseSnapshot();

        const sm2 = new SnapshotManager();
        // Don't load from disk, query directly from the file
        const info = sm2.getCodebaseInfoFromDisk(repo);
        console.log(`  from disk: ${JSON.stringify(info)}`);

        assert.ok(info, "should find info from disk via identity");
        assert.equal(info!.status, "indexed");
        assert.equal(info!.localPath, repo);
    });
});

// ─── 0/0 guard test ──────────────────────────────────────────────────

test("SnapshotManager: refuses 0/0+completed state (Issue #295)", async () => {
    await withTempHome(async (tempRoot) => {
        const repo = cloneTempRepo(tempRoot, "zero-guard");
        const sm = new SnapshotManager();

        sm.setCodebaseIndexed(repo, { indexedFiles: 0, totalChunks: 0, status: "completed" });
        sm.saveCodebaseSnapshot();
        assert.equal(sm.getIndexedCodebases().length, 0, "0/0+completed should be rejected");
        assert.equal(sm.getCodebaseStatus(repo), "not_found");
    });
});