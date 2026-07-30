#!/usr/bin/env node
/**
 * 测单个索引 worker 的内存占用，用来定 GIT_INDEX_CONCURRENCY 与 GIT_INDEX_MEM_LIMIT。
 *
 *   node benchmarks/worker-mem.mjs <repoPath>
 *
 * git-index 的 worker 在**同一个 Node 进程**里跑（indexer.ts 是 Promise.all，
 * 不是子进程），所以 N 个并发 worker 的内存是叠加在一个进程上的 —— 需要分清
 * 两种上限：V8 old-space（约 4 GiB 默认）与容器 cgroup 上限。
 *
 * 本脚本复现 worker 内存的主导项：git ls-files 文件列表 + AST 切分 +
 * EMBEDDING_BATCH_SIZE(100) 条 chunk 的缓冲。不连 Milvus / Ollama，纯本地。
 *
 * 实测结论（2026-07-30，ap-client-api 28.7K chunks）：峰值 RSS ~1 GiB，其中
 * 956 MiB 在**堆外**（tree-sitter 的原生 buffer），V8 heapUsed 峰值只有 55 MiB。
 * 所以约束是 cgroup 上限而不是 old-space，不需要设 NODE_OPTIONS。
 *
 * 输出噪声较多（切分器逐文件打日志），只看结尾的汇总即可：
 *   node benchmarks/worker-mem.mjs <repo> 2>&1 | grep -v '^🌳' | tail -10
 */
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import cp from 'child_process';
import v8 from 'v8';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const { AstCodeSplitter } = require(path.join(here, '../packages/core/dist/index.js'));

const repo = process.argv[2];
if (!repo) {
  console.error('用法: node benchmarks/worker-mem.mjs <repoPath>');
  process.exit(1);
}

/** EMBEDDING_BATCH_SIZE 默认值，见 packages/core/src/context.ts */
const BATCH = Number(process.env.EMBEDDING_BATCH_SIZE || 100);
const rss = () => process.memoryUsage().rss / 1048576;
const heap = () => process.memoryUsage().heapUsed / 1048576;

const CODE_EXT = /\.(c|cc|cpp|cxx|h|hpp|hxx|ts|tsx|js|jsx|py|go|rs|java|cs|rb|php|kt|swift|scala)$/i;
const EXT_LANG = {
  '.cpp': 'cpp', '.cc': 'cpp', '.cxx': 'cpp', '.c': 'c',
  '.h': 'cpp', '.hpp': 'cpp', '.hxx': 'cpp',
  '.ts': 'typescript', '.tsx': 'typescript', '.js': 'javascript', '.jsx': 'javascript',
  '.py': 'python', '.go': 'go', '.rs': 'rust', '.java': 'java', '.cs': 'csharp',
};

const base = rss();
const files = cp.execSync('git ls-files', { cwd: repo, maxBuffer: 1 << 28 })
  .toString().split('\n').filter(Boolean)
  .filter(f => CODE_EXT.test(f))
  .map(f => path.join(repo, f));

console.log(`仓库 ${path.basename(repo)}：${files.length} 个代码文件，batch=${BATCH}`);
console.log(`  基线 RSS                 ${base.toFixed(0)} MiB`);
console.log(`  + 文件列表驻留            ${rss().toFixed(0)} MiB  (heap ${heap().toFixed(0)})`);

const splitter = new AstCodeSplitter();
let buffer = [];
let totalChunks = 0, flushes = 0, biggestFile = 0;
let peak = rss(), peakHeap = heap();

for (const f of files) {
  let content;
  try { content = fs.readFileSync(f, 'utf-8'); } catch { continue; }
  biggestFile = Math.max(biggestFile, content.length);
  const lang = EXT_LANG[path.extname(f).toLowerCase()] || 'text';
  const chunks = await splitter.split(content, lang, f);
  for (const chunk of chunks) {
    buffer.push({ chunk, codebasePath: repo });
    totalChunks++;
    if (buffer.length >= BATCH) {
      buffer = [];        // 模拟 processChunkBuffer 成功后的清空
      flushes++;
    }
  }
  peak = Math.max(peak, rss());
  peakHeap = Math.max(peakHeap, heap());
}

const heapLimit = v8.getHeapStatistics().heap_size_limit / 1048576;
console.log(`  切分完 ${totalChunks} chunks / ${flushes} 次 flush`);
console.log(`  峰值 RSS                 ${peak.toFixed(0)} MiB`);
console.log(`  峰值 heapUsed(V8)        ${peakHeap.toFixed(0)} MiB`);
console.log(`  堆外(tree-sitter 等)     ${(peak - peakHeap).toFixed(0)} MiB`);
console.log(`  V8 堆上限                ${heapLimit.toFixed(0)} MiB`);
console.log(`  最大单文件               ${(biggestFile / 1024).toFixed(0)} KiB`);
console.log(`\n  → 单 worker 峰值增量约 ${(peak - base).toFixed(0)} MiB`);
console.log(`  → 并发 N 时 GIT_INDEX_MEM_LIMIT 至少留 N × ${((peak - base) / 1024).toFixed(1)} GiB + 基线`);
