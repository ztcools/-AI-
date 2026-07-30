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
 *        DUMP=1 node benchmarks/graphbench.mjs ...   # also print ranked lists
 */
import { SqliteGraphStore } from '../packages/graph/dist/index.js';
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

let hit = 0, exp = 0;
const misses = [];
for (const s of scenarios) {
  const t0 = process.hrtime.bigint();
  const r = store.findNodes({ project, query: s.query, limit });
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
