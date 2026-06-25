/**
 * 综合验证：使用 LSMKV 仓库全面验证 url+branch 团队共享索引。
 *
 * 验证场景：
 * 1. getRepoIdentity 正确提取 LSMKV 的 url:branch
 * 2. 同一 LSMKV 仓库 clone 到两个不同路径 → 相同 identity
 * 3. 路径 A 索引后，路径 B 查询显示已索引
 * 4. 模拟 handler 的真实流程：identity 检查 → 跳过重复索引
 * 5. 快照持久化后重新加载，identity 不变
 * 6. 不同仓库（code-study-record vs LSMKV）→ 不同 identity
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync } from "node:child_process";

import { SnapshotManager } from "../packages/mcp/src/snapshot.js";
import { getRepoIdentity } from "../packages/core/src/utils/git-identity.js";

const LSMKV_URL = "https://github.com/ztcools/LSMKV.git";
const LSMKV_EXPECTED_IDENTITY = `${LSMKV_URL}:master`;

const CODE_STUDY_URL = "https://github.com/ztcools/code-study-record.git";
const CODE_STUDY_EXPECTED_IDENTITY = `${CODE_STUDY_URL}:master`;

async function withTempHome(run: (tempRoot: string) => Promise<void>): Promise<void> {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cc-lsmkv-"));
    const homeDir = path.join(tempRoot, "home");
    const originalHome = process.env.HOME;
    process.env.HOME = homeDir;
    try {
        fs.mkdirSync(path.join(homeDir, ".context"), { recursive: true });
        await run(tempRoot);
    } finally {
        if (originalHome === undefined) delete process.env.HOME;
        else process.env.HOME = originalHome;
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
}

function cloneRepo(tempRoot: string, url: string, suffix: string): string {
    const dir = path.join(tempRoot, `cc-${suffix}`);
    fs.rmSync(dir, { recursive: true, force: true });
    execSync(`git clone ${url} ${dir}`, { stdio: "pipe" });
    return dir;
}

// ── 1. 基础 identity 验证 ──────────────────────────────────────────

test("LSMKV: getRepoIdentity returns correct url:branch", () => {
    const repo = "/tmp/LSMKV-test";
    const identity = getRepoIdentity(repo);
    console.log(`  identity: ${identity}`);
    assert.equal(identity, LSMKV_EXPECTED_IDENTITY);
});

test("LSMKV: clone to two paths → same identity", () => {
    const dir1 = path.join(os.tmpdir(), "lsmkv-clone-a");
    const dir2 = path.join(os.tmpdir(), "lsmkv-clone-b");
    try {
        fs.rmSync(dir1, { recursive: true, force: true });
        fs.rmSync(dir2, { recursive: true, force: true });
        execSync(`git clone ${LSMKV_URL} ${dir1}`, { stdio: "pipe" });
        execSync(`git clone ${LSMKV_URL} ${dir2}`, { stdio: "pipe" });

        const id1 = getRepoIdentity(dir1);
        const id2 = getRepoIdentity(dir2);
        console.log(`  path A: ${id1}`);
        console.log(`  path B: ${id2}`);
        assert.equal(id1, id2);
        assert.equal(id1, LSMKV_EXPECTED_IDENTITY);
    } finally {
        fs.rmSync(dir1, { recursive: true, force: true });
        fs.rmSync(dir2, { recursive: true, force: true });
    }
});

// ── 2. 模拟 handler 真实流程 ────────────────────────────────────────

test("LSMKV: 模拟 handler — 路径A索引后，路径B检测已索引", async () => {
    await withTempHome(async (tempRoot) => {
        const repoA = cloneRepo(tempRoot, LSMKV_URL, "handler-a");
        const repoB = cloneRepo(tempRoot, LSMKV_URL, "handler-b");
        const sm = new SnapshotManager();

        // 步骤1: 团队成员 Alice 在路径 A 上索引
        const identityA = getRepoIdentity(repoA);
        console.log(`  Alice identity: ${identityA}`);

        // 检查是否已索引（handler 第一步）
        let alreadyIndexed = sm.getIndexedCodebases().includes(identityA);
        assert.equal(alreadyIndexed, false, "Alice 首次索引，不应已存在");

        // 执行索引
        sm.setCodebaseIndexed(repoA, { indexedFiles: 42, totalChunks: 270, status: "completed" });
        sm.saveCodebaseSnapshot();

        // 验证 Alice 端状态
        assert.equal(sm.getIndexedCodebases().length, 1);
        assert.ok(sm.getIndexedCodebases()[0].includes("://"));
        assert.equal(sm.getCodebaseStatus(repoA), "indexed");

        // 步骤2: 团队成员 Bob 在路径 B 上查询
        const identityB = getRepoIdentity(repoB);
        console.log(`  Bob identity:   ${identityB}`);
        assert.equal(identityA, identityB, "Alice 和 Bob 的 identity 应该相同");

        // 模拟 handler 中的检查逻辑
        alreadyIndexed = sm.getIndexedCodebases().includes(identityB);
        console.log(`  handler check: getIndexedCodebases().includes(identityB) = ${alreadyIndexed}`);
        assert.ok(alreadyIndexed, "Bob 端检测到已索引，不应重复建立");

        // getCodebaseStatus 也应该返回 indexed
        const bobStatus = sm.getCodebaseStatus(repoB);
        assert.equal(bobStatus, "indexed");

        // getCodebaseInfo 也应该能查到
        const bobInfo = sm.getCodebaseInfo(repoB);
        assert.ok(bobInfo);
        assert.equal(bobInfo!.status, "indexed");
        assert.equal(bobInfo!.localPath, repoA); // localPath 是 Alice 的路径
    });
});

// ── 3. 两个不同仓库不冲突 ──────────────────────────────────────────

test("LSMKV: 两个不同仓库 → 不同 identity，互不干扰", async () => {
    await withTempHome(async (tempRoot) => {
        const lsmkv = cloneRepo(tempRoot, LSMKV_URL, "lsmkv");
        const csr = cloneRepo(tempRoot, CODE_STUDY_URL, "csr");
        const sm = new SnapshotManager();

        const id1 = getRepoIdentity(lsmkv);
        const id2 = getRepoIdentity(csr);
        console.log(`  LSMKV identity:           ${id1}`);
        console.log(`  code-study-record identity: ${id2}`);
        assert.notEqual(id1, id2, "不同仓库应有不同 identity");

        // 索引 LSMKV
        sm.setCodebaseIndexed(lsmkv, { indexedFiles: 10, totalChunks: 100, status: "completed" });
        sm.saveCodebaseSnapshot();
        assert.equal(sm.getIndexedCodebases().length, 1);

        // 索引 code-study-record
        sm.setCodebaseIndexed(csr, { indexedFiles: 20, totalChunks: 200, status: "completed" });
        sm.saveCodebaseSnapshot();
        assert.equal(sm.getIndexedCodebases().length, 2, "两个不同仓库应各自独立");

        // 两个都能查到
        assert.equal(sm.getCodebaseStatus(lsmkv), "indexed");
        assert.equal(sm.getCodebaseStatus(csr), "indexed");

        // 删除 LSMKV，不影响 code-study-record
        sm.removeCodebaseCompletely(lsmkv);
        sm.saveCodebaseSnapshot();
        assert.equal(sm.getIndexedCodebases().length, 1);
        assert.equal(sm.getCodebaseStatus(lsmkv), "not_found");
        assert.equal(sm.getCodebaseStatus(csr), "indexed", "删除 LSMKV 不应影响 code-study-record");
    });
});

// ── 4. 快照持久化往返 ──────────────────────────────────────────────

test("LSMKV: snapshot save/load — identity 持久化正确", async () => {
    await withTempHome(async (tempRoot) => {
        const repo = cloneRepo(tempRoot, LSMKV_URL, "persist");
        const sm1 = new SnapshotManager();

        sm1.setCodebaseIndexed(repo, {
            indexedFiles: 15, totalChunks: 270, status: "completed"
        });
        sm1.saveCodebaseSnapshot();

        // 新实例加载
        const sm2 = new SnapshotManager();
        sm2.loadCodebaseSnapshot();

        const indexed = sm2.getIndexedCodebases();
        console.log(`  reloaded: ${JSON.stringify(indexed)}`);
        assert.equal(indexed.length, 1);
        assert.equal(indexed[0], LSMKV_EXPECTED_IDENTITY);
        assert.ok(indexed[0].includes("://"), "持久化后的 identity 应是 url 格式");

        const info = sm2.getCodebaseInfo(repo);
        assert.ok(info);
        assert.equal(info!.status, "indexed");
        if (info!.status === "indexed") {
            assert.equal(info!.indexedFiles, 15);
            assert.equal(info!.totalChunks, 270);
        }
    });
});

// ── 5. indexing → indexed 状态转换 ─────────────────────────────────

test("LSMKV: 完整状态转换 (indexing → indexed → failed)", async () => {
    await withTempHome(async (tempRoot) => {
        const repo = cloneRepo(tempRoot, LSMKV_URL, "lifecycle");
        const sm = new SnapshotManager();

        // indexing
        sm.setCodebaseIndexing(repo, 0);
        sm.saveCodebaseSnapshot();
        assert.equal(sm.getCodebaseStatus(repo), "indexing");
        const indexingList = sm.getIndexingCodebases();
        assert.ok(indexingList[0].includes("://"), "indexing 列表中的条目应为 identity");

        // 更新进度
        sm.setCodebaseIndexing(repo, 75);
        const info = sm.getCodebaseInfo(repo);
        if (info?.status === "indexing") {
            assert.equal(info.indexingPercentage, 75);
        }

        // indexed
        sm.setCodebaseIndexed(repo, {
            indexedFiles: 30, totalChunks: 270, status: "completed"
        });
        sm.saveCodebaseSnapshot();
        assert.equal(sm.getCodebaseStatus(repo), "indexed");
        assert.equal(sm.getIndexingCodebases().length, 0);
        assert.equal(sm.getIndexedCodebases().length, 1);

        // failed
        sm.setCodebaseIndexFailed(repo, "simulated failure", 50);
        sm.saveCodebaseSnapshot();
        assert.equal(sm.getCodebaseStatus(repo), "indexfailed");
        const failedList = sm.getFailedCodebases();
        assert.ok(failedList[0].includes("://"), "failed 列表中的条目应为 identity");
    });
});

// ── 6. findIndexedCodebasePath / findTrackedCodebasePath ────────────

test("LSMKV: findIndexedCodebasePath 通过 identity 查找", async () => {
    await withTempHome(async (tempRoot) => {
        const repoA = cloneRepo(tempRoot, LSMKV_URL, "find-a");
        const repoB = cloneRepo(tempRoot, LSMKV_URL, "find-b");
        const sm = new SnapshotManager();

        sm.setCodebaseIndexed(repoA, { indexedFiles: 1, totalChunks: 1, status: "completed" });
        sm.saveCodebaseSnapshot();

        const foundA = sm.findIndexedCodebasePath(repoA);
        const foundB = sm.findIndexedCodebasePath(repoB);
        console.log(`  findIndexedCodebasePath(A) = ${foundA}`);
        console.log(`  findIndexedCodebasePath(B) = ${foundB}`);
        assert.ok(foundA);
        assert.ok(foundB, "路径B也应通过 identity 找到");
        assert.equal(foundA, repoA);
        assert.equal(foundB, repoA);

        const trackedA = sm.findTrackedCodebasePath(repoA);
        const trackedB = sm.findTrackedCodebasePath(repoB);
        assert.equal(trackedA, repoA);
        assert.equal(trackedB, repoA);
    });
});

// ── 7. getCodebaseInfoFromDisk ─────────────────────────────────────

test("LSMKV: getCodebaseInfoFromDisk 通过 identity 从磁盘读取", async () => {
    await withTempHome(async (tempRoot) => {
        const repo = cloneRepo(tempRoot, LSMKV_URL, "disk");
        const sm = new SnapshotManager();

        sm.setCodebaseIndexed(repo, {
            indexedFiles: 8, totalChunks: 100, status: "completed"
        });
        sm.saveCodebaseSnapshot();

        // 新实例，不加载，直接从磁盘读
        const sm2 = new SnapshotManager();
        const info = sm2.getCodebaseInfoFromDisk(repo);
        console.log(`  from disk: ${JSON.stringify(info)}`);
        assert.ok(info, "应从磁盘通过 identity 找到");
        assert.equal(info!.status, "indexed");
        assert.equal(info!.localPath, repo);
    });
});

// ── 8. 边界情况：非 git 目录 ───────────────────────────────────────

test("LSMKV: 边界 — 非 git 目录 fallback 到路径，不污染 git 仓库的 identity", async () => {
    await withTempHome(async (tempRoot) => {
        const lsmkv = cloneRepo(tempRoot, LSMKV_URL, "edge-lsmkv");
        const nonGit = path.join(tempRoot, "non-git-dir");
        fs.mkdirSync(nonGit);

        const sm = new SnapshotManager();

        // 索引真实 git 仓库
        sm.setCodebaseIndexed(lsmkv, { indexedFiles: 1, totalChunks: 1, status: "completed" });
        sm.saveCodebaseSnapshot();

        const gitIdentity = getRepoIdentity(lsmkv);
        assert.ok(gitIdentity.includes("://"), "git 仓库 identity 应为 url 格式");

        // 非 git 目录的 identity 是路径本身
        const nonGitIdentity = getRepoIdentity(nonGit);
        assert.ok(nonGitIdentity.startsWith("/"), "非 git 目录 identity 应为路径");

        assert.notEqual(gitIdentity, nonGitIdentity, "git 和非 git 的 identity 不应相同");
    });
});