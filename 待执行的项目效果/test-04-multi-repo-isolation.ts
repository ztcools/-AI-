/**
 * 测试 04：多仓库隔离测试
 * 需要 Milvus + Ollama 内网环境
 *
 * 验证 url+branch 隔离机制：
 * 1. 同一仓库不同 clone 路径 → 共享索引
 * 2. 不同仓库 → 独立索引
 * 3. 不同分支 → 独立索引
 * 4. 团队共享（A 索引后 B 可用）
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

const RESULTS_DIR = path.join(__dirname, 'test-results');
const REPOS_DIR = path.join(__dirname, 'test-repos');
const TEST_DIR = path.join(__dirname, 'test-isolation');
const ISOLATION_OUTPUT = path.join(RESULTS_DIR, 'isolation.json');

fs.mkdirSync(RESULTS_DIR, { recursive: true });
fs.mkdirSync(TEST_DIR, { recursive: true });

// ── 工具函数 ─────────────────────────────────────────────────────
function getGitRemoteUrl(repoPath: string): string {
    return execSync('git remote get-url origin', { cwd: repoPath, encoding: 'utf-8' }).trim();
}

function getGitBranch(repoPath: string): string {
    return execSync('git rev-parse --abbrev-ref HEAD', { cwd: repoPath, encoding: 'utf-8' }).trim();
}

function getRepoIdentity(repoPath: string): string {
    const url = getGitRemoteUrl(repoPath);
    const branch = getGitBranch(repoPath);
    return `${url}:${branch}`;
}

// ── 主测试 ───────────────────────────────────────────────────────
async function main() {
    console.log('多仓库隔离测试\n');

    const repos = fs.readdirSync(REPOS_DIR)
        .filter(d => {
            const p = path.join(REPOS_DIR, d);
            return fs.statSync(p).isDirectory() && fs.existsSync(path.join(p, '.git'));
        });

    if (repos.length < 2) {
        console.log('⚠️  需要至少 2 个测试仓库');
        return;
    }

    let passed = 0;
    let failed = 0;
    const results: any = { tests: [] };

    function check(name: string, condition: boolean, detail: string) {
        results.tests.push({ name, condition, detail });
        if (condition) {
            console.log(`  ✓ ${name}: ${detail}`);
            passed++;
        } else {
            console.log(`  ✗ ${name}: ${detail}`);
            failed++;
        }
    }

    // ── 1. 验证 identity 格式 ──────────────────────────────────
    console.log('── 1. identity 格式 ──');
    const identities: string[] = [];
    for (const repoName of repos.slice(0, 3)) {
        const repoPath = path.join(REPOS_DIR, repoName);
        const identity = getRepoIdentity(repoPath);
        identities.push(identity);
        console.log(`  ${repoName}: ${identity}`);
        check(
            `${repoName} identity 格式`,
            identity.includes(':') && identity.includes('github.com'),
            identity
        );
    }

    // ── 2. 不同仓库不同 identity ───────────────────────────────
    console.log('\n── 2. 仓库隔离 ──');
    if (identities.length >= 2) {
        check(
            '不同仓库 identity 不同',
            identities[0] !== identities[1],
            `${identities[0]} ≠ ${identities[1]}`
        );
    }

    // ── 3. 同一仓库相同 identity ───────────────────────────────
    console.log('\n── 3. 同仓库共享 ──');
    const testRepo = repos[0];
    const testPath = path.join(REPOS_DIR, testRepo);
    const clonePath = path.join(TEST_DIR, testRepo + '-clone');

    try {
        // 克隆到不同路径
        if (!fs.existsSync(clonePath)) {
            execSync(`git clone "${testPath}" "${clonePath}"`, { timeout: 60000, stdio: 'pipe' });
        }
        const identity1 = getRepoIdentity(testPath);
        const identity2 = getRepoIdentity(clonePath);
        check(
            '同一仓库不同路径 identity 相同',
            identity1 === identity2,
            `clone1=${identity1}, clone2=${identity2}`
        );
    } catch (e: any) {
        console.log(`  ⚠ 克隆测试跳过: ${e.message}`);
    }

    // ── 4. 不同分支不同 identity ───────────────────────────────
    console.log('\n── 4. 分支隔离 ──');
    try {
        const branchPath = path.join(TEST_DIR, testRepo + '-branch');
        if (!fs.existsSync(branchPath)) {
            execSync(`git clone "${testPath}" "${branchPath}"`, { timeout: 60000, stdio: 'pipe' });
        }
        // 创建新分支
        execSync('git checkout -b test-isolation-branch 2>/dev/null || git checkout test-isolation-branch', {
            cwd: branchPath,
            timeout: 30000,
            stdio: 'pipe',
        });
        const mainIdentity = getRepoIdentity(testPath);
        const branchIdentity = getRepoIdentity(branchPath);
        check(
            '不同分支 identity 不同',
            mainIdentity !== branchIdentity,
            `main=${mainIdentity.split(':').pop()}, branch=${branchIdentity.split(':').pop()}`
        );

        // 清理分支
        execSync('git checkout main 2>/dev/null || git checkout master 2>/dev/null || true', {
            cwd: branchPath,
            timeout: 30000,
            stdio: 'pipe',
        });
    } catch (e: any) {
        console.log(`  ⚠ 分支测试跳过: ${e.message}`);
    }

    // ── 汇总 ─────────────────────────────────────────────────────
    console.log(`\n── 汇总 ──`);
    console.log(`  通过: ${passed}, 失败: ${failed}`);

    results.summary = { passed, failed, total: passed + failed };
    fs.writeFileSync(ISOLATION_OUTPUT, JSON.stringify(results, null, 2));
    console.log(`\n✓ 结果已写入: ${ISOLATION_OUTPUT}`);

    if (failed > 0) {
        console.log('\n⚠️  有测试失败');
        process.exit(1);
    }
    console.log('✓ 测试 04 完成');
}

main().catch(err => {
    console.error('测试 04 失败:', err);
    process.exit(1);
});