/**
 * 测试 01：图引擎离线基准测试
 * 无需 Milvus/Ollama，纯 SQLite + tree-sitter 离线运行
 *
 * 验证：
 * 1. 图索引速度（节点/边提取性能）
 * 2. 调用链追踪准确性
 * 3. 架构分析质量（聚类、内聚度）
 * 4. 死代码检测
 * 5. 搜索质量
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';

// ── 动态加载 graph 模块 ──────────────────────────────────────────
const graphDist = path.resolve(__dirname, '../../packages/graph/dist');
const { SqliteGraphStore } = await import(path.join(graphDist, 'graph-store.js'));
const { GraphExtractor } = await import(path.join(graphDist, 'extractor.js'));
const { CallTracer } = await import(path.join(graphDist, 'tracer.js'));
const { GraphSearcher } = await import(path.join(graphDist, 'searcher.js'));
const { ArchitectureAnalyzer } = await import(path.join(graphDist, 'architecture.js'));

// ── 配置 ─────────────────────────────────────────────────────────
const REPOS_DIR = path.join(__dirname, 'test-repos');
const RESULTS_DIR = path.join(__dirname, 'test-results');
const DB_PATH = path.join(RESULTS_DIR, 'graph-benchmark.db');
const BENCHMARK_OUTPUT = path.join(RESULTS_DIR, 'graph-benchmark.json');

fs.mkdirSync(RESULTS_DIR, { recursive: true });

// ── 工具函数 ─────────────────────────────────────────────────────
function formatMs(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${(ms / 60000).toFixed(1)}min`;
}

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

// ── 主测试 ───────────────────────────────────────────────────────
async function main() {
    console.log('图引擎离线基准测试\n');

    const results: any = {
        timestamp: new Date().toISOString(),
        repos: {},
        summary: {},
    };

    // 清理旧数据库
    try { fs.unlinkSync(DB_PATH); } catch { }
    try { fs.unlinkSync(DB_PATH + '-wal'); } catch { }
    try { fs.unlinkSync(DB_PATH + '-shm'); } catch { }

    const store = new SqliteGraphStore(DB_PATH);
    store.initialize();
    const extractor = new GraphExtractor();
    const tracer = new CallTracer(store);
    const searcher = new GraphSearcher(store);
    const archAnalyzer = new ArchitectureAnalyzer(store);

    // 获取可用的测试仓库
    const repos = fs.readdirSync(REPOS_DIR)
        .filter(d => {
            const p = path.join(REPOS_DIR, d);
            return fs.statSync(p).isDirectory() && fs.existsSync(path.join(p, '.git'));
        })
        .slice(0, 3); // 测试前 3 个仓库

    if (repos.length === 0) {
        console.log('⚠️  未找到测试仓库，请先运行 run-all.sh 克隆仓库');
        console.log('   手动克隆示例: git clone --depth 1 https://github.com/microsoft/vscode test-repos/vscode');
        return;
    }

    console.log(`测试仓库: ${repos.join(', ')}\n`);

    for (const repoName of repos) {
        const repoPath = path.join(REPOS_DIR, repoName);
        const project = repoName;
        console.log(`── ${repoName} ──`);

        // ── 1. 图索引基准 ─────────────────────────────────────
        const indexStart = Date.now();
        const files = collectFiles(repoPath, 500);
        const fileCount = files.length;

        let totalNodes = 0;
        let totalEdges = 0;
        let totalLines = 0;

        for (const file of files) {
            const content = fs.readFileSync(file, 'utf-8');
            totalLines += content.split('\n').length;
            const relPath = path.relative(repoPath, file);
            const result = extractor.extract(content, {
                project,
                filePath: relPath,
                language: detectLanguage(file),
            });
            for (const node of result.nodes) {
                store.upsertNode(node);
                totalNodes++;
            }
            for (const edge of result.edges) {
                try { store.upsertEdge(edge); } catch { /* 重复边忽略 */ }
                totalEdges++;
            }
        }

        const indexTime = Date.now() - indexStart;
        const stats = store.getProjectStats(project);
        console.log(`  索引: ${fileCount} 文件, ${totalLines} 行, ${stats.nodes} 节点, ${stats.edges} 边`);
        console.log(`  耗时: ${formatMs(indexTime)} (${(fileCount / (indexTime / 1000)).toFixed(1)} 文件/秒)`);

        // ── 2. 调用链追踪 ─────────────────────────────────────
        let traceCount = 0;
        let traceTime = 0;
        let maxDepth = 0;

        // 找前 10 个函数节点做追踪
        const nodeResult = store.findNodes({ project, label: 'Function', limit: 10 });
        for (const r of nodeResult.results) {
            const tStart = Date.now();
            const path = tracer.traceCalls(r.node.id, 'both', 5);
            traceTime += Date.now() - tStart;
            traceCount++;
            const depth = path.nodes.length;
            if (depth > maxDepth) maxDepth = depth;
        }

        console.log(`  调用链: ${traceCount} 条追踪, 最深 ${maxDepth} 层, 平均 ${formatMs(traceTime / traceCount)}/条`);

        // ── 3. 架构分析 ──────────────────────────────────────
        const archStart = Date.now();
        const arch = archAnalyzer.analyze(project);
        const archTime = Date.now() - archStart;

        console.log(`  架构: ${arch.clusters?.length || 0} 个模块, ${arch.entryPoints?.length || 0} 个入口点`);
        console.log(`  耗时: ${formatMs(archTime)}`);

        // ── 4. 图搜索质量 ─────────────────────────────────────
        const searchQueries = ['main', 'init', 'error', 'config', 'handle'];
        let searchHits = 0;
        const searchStart = Date.now();
        for (const q of searchQueries) {
            const result = searcher.search({ project, query: q, limit: 5 });
            searchHits += result.total;
        }
        const searchTime = Date.now() - searchStart;
        console.log(`  搜索: 5 个查询, 平均 ${searchHits / 5} 命中, ${formatMs(searchTime)}`);

        // ── 5. 死代码检测 ─────────────────────────────────────
        const deadCodeStart = Date.now();
        const allNodes = store.findNodes({ project, limit: 1000 });
        let deadCount = 0;
        for (const r of allNodes.results) {
            if (r.node.label === 'Function' || r.node.label === 'Method') {
                const { inDegree, outDegree } = store.getNodeDegree(r.node.id);
                if (inDegree === 0 && outDegree === 0) deadCount++;
            }
        }
        const deadCodeTime = Date.now() - deadCodeStart;
        console.log(`  死代码: ${deadCount} 个孤立函数 (${formatMs(deadCodeTime)})`);

        results.repos[repoName] = {
            files: fileCount,
            lines: totalLines,
            nodes: stats.nodes,
            edges: stats.edges,
            indexTimeMs: indexTime,
            traceDepth: maxDepth,
            clusters: arch.clusters?.length || 0,
            entryPoints: arch.entryPoints?.length || 0,
            deadCode: deadCount,
            searchHits: searchHits / 5,
        };

        console.log('');
    }

    // ── 汇总 ─────────────────────────────────────────────────────
    const repoCount = Object.keys(results.repos).length;
    const totalNodes = Object.values(results.repos).reduce((s: number, r: any) => s + r.nodes, 0);
    const totalEdges = Object.values(results.repos).reduce((s: number, r: any) => s + r.edges, 0);
    const totalTime = Object.values(results.repos).reduce((s: number, r: any) => s + r.indexTimeMs, 0);

    results.summary = {
        repoCount,
        totalNodes,
        totalEdges,
        totalIndexTimeMs: totalTime,
        avgNodesPerRepo: Math.round(totalNodes / repoCount),
        avgEdgesPerRepo: Math.round(totalEdges / repoCount),
    };

    fs.writeFileSync(BENCHMARK_OUTPUT, JSON.stringify(results, null, 2));
    console.log(`✓ 结果已写入: ${BENCHMARK_OUTPUT}`);

    store.close();
    console.log('✓ 测试 01 完成');
}

// ── 辅助函数 ─────────────────────────────────────────────────────
function collectFiles(dir: string, maxFiles: number): string[] {
    const files: string[] = [];
    const walk = (d: string) => {
        if (files.length >= maxFiles) return;
        try {
            for (const entry of fs.readdirSync(d)) {
                if (files.length >= maxFiles) return;
                const full = path.join(d, entry);
                if (entry.startsWith('.') || entry === 'node_modules' || entry === '.git') continue;
                const stat = fs.statSync(full);
                if (stat.isDirectory()) {
                    walk(full);
                } else if (isSourceFile(entry)) {
                    files.push(full);
                }
            }
        } catch { /* 权限不足跳过 */ }
    };
    walk(dir);
    return files;
}

function isSourceFile(name: string): boolean {
    const exts = ['.ts', '.tsx', '.js', '.jsx', '.py', '.rs', '.c', '.cpp', '.h', '.hpp',
        '.java', '.go', '.cs', '.rb', '.swift', '.kt', '.scala', '.sh', '.bash'];
    return exts.some(e => name.endsWith(e));
}

function detectLanguage(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    const map: Record<string, string> = {
        '.ts': 'typescript', '.tsx': 'typescript',
        '.js': 'javascript', '.jsx': 'javascript',
        '.py': 'python', '.rs': 'rust',
        '.c': 'c', '.h': 'c',
        '.cpp': 'cpp', '.hpp': 'cpp', '.cc': 'cpp',
        '.java': 'java', '.go': 'go',
        '.cs': 'csharp', '.rb': 'ruby',
        '.swift': 'swift', '.kt': 'kotlin',
        '.scala': 'scala',
    };
    return map[ext] || 'unknown';
}

main().catch(err => {
    console.error('测试 01 失败:', err);
    process.exit(1);
});