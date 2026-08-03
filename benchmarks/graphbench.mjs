/**
 * Graph-engine-only recall bench (no Milvus, no link, no network).
 *
 * Runs every scenario query through SqliteGraphStore.findNodes and scores the
 * rendered hit list the same way harness.mjs scores a graph-mode response, so a
 * ranking change can be measured in seconds instead of a full live run. This is
 * the loop to use while tuning buildFtsQuery / diversifyByConcept.
 *
 * The repo under test must already have a built graph
 * (<repo>/.context/graph/knowledge-graph.db) — run `link` on it once first.
 *
 * Usage: node benchmarks/graphbench.mjs <repoPath> <scenarioFile> [limit]
 *        DUMP=1 node benchmarks/graphbench.mjs ...      # also print ranked lists
 *        NO_VENDOR=1 node benchmarks/graphbench.mjs ... # 关掉 vendored 降权做 A/B
 *
 * 默认**带上** vendored 子树降权（和 MCP handler 一致）：不带的话这个离线循环量的就不是
 * 产品实际排序 —— PhiLog 47% 的文件是拷进来的 spdlog，两条路径的排名会明显不同。
 */
import { SqliteGraphStore, detectVendorSegments } from '../packages/graph/dist/index.js';
import * as fs from 'fs';

const repo = process.argv[2];
const scenarioFile = process.argv[3];
const limit = Number(process.argv[4] || 10);

if (!repo || !scenarioFile) {
  console.error('usage: node benchmarks/graphbench.mjs <repoPath> <scenarioFile> [limit]');
  process.exit(2);
}

const store = new SqliteGraphStore(repo);
const project = store.listProjects()[0];
if (!project) {
  console.error(`no graph found for ${repo} — run link on it first`);
  process.exit(1);
}
const scenarios = JSON.parse(fs.readFileSync(scenarioFile, 'utf-8')).filter(s => (s.expect || []).length);
const vendorSegments = process.env.NO_VENDOR === '1' ? undefined : detectVendorSegments(repo);
// NO_TEST=1 关掉测试降权（系数 0 = 关闭，和 search 的 tests:true 同一条路径）。
const testPenalty = process.env.NO_TEST === '1' ? 0 : undefined;
console.log(`[demote] vendor=${vendorSegments ? vendorSegments.length + ' segs' : 'off'} test=${testPenalty === 0 ? 'off' : 'on(0.55)'}`);

let hit = 0, exp = 0;
const misses = [];
for (const s of scenarios) {
  const t0 = process.hrtime.bigint();
  const r = store.findNodes({ project, query: s.query, limit, vendorSegments, testPenalty });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const text = r.results
    .map(x => `${x.node.kind}: ${x.node.name} (${x.node.qualifiedName}) ${x.node.filePath}:${x.node.startLine}`)
    .join('\n');
  const got = s.expect.filter(e => text.includes(e));
  hit += got.length; exp += s.expect.length;
  const miss = s.expect.filter(e => !text.includes(e));
  if (miss.length) misses.push(`${s.name}: ${miss.join(', ')}`);
  console.log(`${s.name.padEnd(30)} ${ms.toFixed(1).padStart(6)}ms  ${String(r.results.length).padStart(3)} rows  hit ${got.length}/${s.expect.length}`);
  if (process.env.DUMP === '1') {
    r.results.slice(0, limit).forEach((x, i) =>
      console.log(`    ${i + 1}. ${x.node.kind} ${x.node.name} | ${x.node.filePath}:${x.node.startLine} | ${(x.score || 0).toFixed(2)}`));
  }
}
console.log(`\nrecall ${hit}/${exp} (${Math.round(100 * hit / exp)}%)`);
if (misses.length) { console.log('misses:'); misses.forEach(m => console.log('  ' + m)); }
store.close();
