/**
 * Test: getRepoIdentity — verifies that identity is computed as url:branch,
 * not absolute path. This is the foundation for team-shared indexing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync } from "node:child_process";

// Import directly from the core package source
import { getRepoIdentity } from "../packages/core/src/utils/git-identity.js";

const REAL_REPO = "/home/zt/code-study-record";
const EXPECTED_URL = "https://github.com/ztcools/code-study-record.git";
const EXPECTED_BRANCH = "master";

// ─── Real repo tests ────────────────────────────────────────────────

test("getRepoIdentity: real repo returns url:branch", () => {
    const identity = getRepoIdentity(REAL_REPO);
    console.log(`  identity = ${identity}`);
    assert.equal(identity, `${EXPECTED_URL}:${EXPECTED_BRANCH}`);
});

test("getRepoIdentity: same repo cloned to different path returns same identity", () => {
    const cloneDir = path.join(os.tmpdir(), "code-study-record-clone-test");
    try {
        fs.rmSync(cloneDir, { recursive: true, force: true });
        // Clone from the remote URL, not local path, to get the real remote origin
        execSync(`git clone ${EXPECTED_URL} ${cloneDir}`, { stdio: "pipe" });

        const identity1 = getRepoIdentity(REAL_REPO);
        const identity2 = getRepoIdentity(cloneDir);

        console.log(`  original: ${identity1}`);
        console.log(`  clone:    ${identity2}`);
        assert.equal(identity1, identity2);
        assert.ok(identity1.includes("://"), "identity should contain URL scheme");
        assert.ok(!identity1.startsWith("/"), "identity must NOT be an absolute path");
    } finally {
        fs.rmSync(cloneDir, { recursive: true, force: true });
    }
});

// ─── Non-git directory tests ─────────────────────────────────────────

test("getRepoIdentity: non-git directory returns resolved path (fallback)", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "non-git-"));
    try {
        const identity = getRepoIdentity(tmpDir);
        console.log(`  identity = ${identity}`);
        assert.equal(identity, path.resolve(tmpDir));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test("getRepoIdentity: non-existent path returns resolved path", () => {
    const fakePath = "/tmp/does-not-exist-xyz123";
    const identity = getRepoIdentity(fakePath);
    assert.equal(identity, path.resolve(fakePath));
});

// ─── Different branch test ───────────────────────────────────────────

test("getRepoIdentity: different branch produces different identity", () => {
    const cloneDir = path.join(os.tmpdir(), "code-study-record-branch-test");
    try {
        fs.rmSync(cloneDir, { recursive: true, force: true });
        execSync(`git clone -b master ${EXPECTED_URL} ${cloneDir}`, { stdio: "pipe" });

        const identityMaster = getRepoIdentity(cloneDir);

        // Create and switch to a test branch
        execSync("git checkout -b test-branch-for-identity", { cwd: cloneDir, stdio: "pipe" });
        const identityTest = getRepoIdentity(cloneDir);

        console.log(`  master: ${identityMaster}`);
        console.log(`  test:   ${identityTest}`);
        assert.notEqual(identityMaster, identityTest);
        assert.ok(identityTest.endsWith(":test-branch-for-identity"));
    } finally {
        fs.rmSync(cloneDir, { recursive: true, force: true });
    }
});

// ─── Edge case: relative path ────────────────────────────────────────

test("getRepoIdentity: relative path resolves correctly", () => {
    const identity1 = getRepoIdentity(REAL_REPO);
    const cwd = process.cwd();
    const relPath = path.relative(cwd, REAL_REPO);
    const identity2 = getRepoIdentity(relPath);

    console.log(`  absolute: ${identity1}`);
    console.log(`  relative: ${identity2}`);
    assert.equal(identity1, identity2);
});