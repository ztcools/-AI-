/**
 * End-to-end link + search exercise against the live cloud index.
 *
 * Drives the real MCP handlers (not a reimplementation) so what is measured here
 * is what an agent actually gets: link → wait for the local graph → run a set of
 * realistic developer questions in all three modes, and report latency plus the
 * response size that would land in the model's context.
 *
 * Needs a reachable Milvus + Ollama (reads ~/.context/.env via envManager) and a
 * cloud collection for <repoPath>@<branch> — run with a protected branch that is
 * actually indexed, otherwise vector mode comes back empty.
 *
 * Usage: node benchmarks/harness.mjs <repoPath> <branch> [scenarioFile]
 *        DUMP=1 node benchmarks/harness.mjs ...   # also print response text
 */
import { ToolHandlers } from '../packages/mcp/dist/handlers.js';
import { GraphToolHandlers } from '../packages/mcp/dist/graph-handlers.js';
import { Context, MilvusVectorDatabase, OllamaEmbedding, envManager } from '../packages/core/dist/index.js';

const repoPath = process.argv[2];
const branch = process.argv[3];
const scenarioFile = process.argv[4];
if (!repoPath || !branch) {
    console.error('usage: node benchmarks/harness.mjs <repoPath> <branch> [scenarioFile]');
    process.exit(2);
}

const embedding = new OllamaEmbedding({
    model: envManager.get('EMBEDDING_MODEL') || 'nomic-embed-text',
    host: envManager.get('OLLAMA_HOST') || 'http://127.0.0.1:11434',
    dimension: Number(envManager.get('EMBEDDING_DIMENSION') || 768),
});
const vectorDatabase = new MilvusVectorDatabase({ address: envManager.get('MILVUS_ADDRESS') });
const context = new Context({ embedding, vectorDatabase });
const graph = new GraphToolHandlers();
const handlers = new ToolHandlers(context, graph);

const textOf = (r) => (r?.content || []).map(c => c.text || '').join('\n');
const approxTokens = (s) => Math.round(s.length / 4);

const timed = async (fn) => {
    const t0 = process.hrtime.bigint();
    const out = await fn();
    return { out, ms: Number(process.hrtime.bigint() - t0) / 1e6 };
};

console.log(`\n=== link ${repoPath} @ ${branch} ===`);
const linked = await timed(() => handlers.handleLink({ path: repoPath, branch }));
console.log(`link: ${linked.ms.toFixed(0)}ms`);
console.log(textOf(linked.out).split('\n').slice(0, 12).join('\n'));

// The graph builds in the background; a real session's first search races it, so
// wait until a graph-mode search actually returns symbols before measuring —
// otherwise the numbers describe a half-built graph, not steady state.
process.stdout.write('waiting for local graph');
for (let i = 0; i < 90; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const probe = await handlers.handleSearchCode({ path: repoPath, query: 'main', mode: 'graph', limit: 3 });
    const t = textOf(probe);
    if (!/No results|not indexed|empty/i.test(t) && t.trim().length > 40) { console.log(` ready after ${(i + 1) * 2}s`); break; }
    process.stdout.write('.');
    if (i === 89) console.log(' graph not ready after 180s; measuring anyway');
}

// A first search against a released collection pays a Milvus load (~900ms vs
// ~220ms warm). Warm it once so the per-scenario numbers describe steady state.
await handlers.handleSearchCode({ path: repoPath, query: 'warmup', mode: 'vector', limit: 1 });

const scenarios = scenarioFile
    ? JSON.parse(await import('fs').then(m => m.promises.readFile(scenarioFile, 'utf-8')))
    : [];

const rows = [];
for (const s of scenarios) {
    for (const mode of s.modes || ['both']) {
        const r = await timed(() => handlers.handleSearchCode({
            path: repoPath, query: s.query, mode, limit: s.limit || 10,
        }));
        const text = textOf(r.out);
        const files = new Set([...text.matchAll(/([\w./\-]+\.(?:ts|js|py|java|cpp|cc|hpp|h|go|rs|cs|scala))(?::|\s)/g)].map(m => m[1]));
        const hit = (s.expect || []).filter(e => text.includes(e));
        rows.push({
            scenario: s.name, mode, ms: Math.round(r.ms),
            tokens: approxTokens(text), files: files.size,
            expect: (s.expect || []).length, hit: hit.length,
            miss: (s.expect || []).filter(e => !text.includes(e)),
            empty: /No results found|no matching|not indexed/i.test(text),
        });
        console.log(`  ${s.name.padEnd(34)} ${mode.padEnd(7)} ${String(Math.round(r.ms)).padStart(6)}ms  ${String(approxTokens(text)).padStart(5)}t  hit ${hit.length}/${(s.expect || []).length}${rows[rows.length - 1].empty ? '  [EMPTY]' : ''}`);
        if (process.env.DUMP === '1') console.log(text.slice(0, 3000), '\n---');
    }
}

console.log('\n=== summary ===');
const byMode = {};
for (const r of rows) {
    const m = (byMode[r.mode] ||= { n: 0, ms: 0, tokens: 0, hit: 0, expect: 0, empty: 0 });
    m.n++; m.ms += r.ms; m.tokens += r.tokens; m.hit += r.hit; m.expect += r.expect; m.empty += r.empty ? 1 : 0;
}
for (const [mode, m] of Object.entries(byMode)) {
    console.log(`${mode.padEnd(7)} n=${m.n} avg ${Math.round(m.ms / m.n)}ms  avg ${Math.round(m.tokens / m.n)}t  recall ${m.hit}/${m.expect} (${Math.round(100 * m.hit / Math.max(1, m.expect))}%)  empty=${m.empty}`);
}
const misses = rows.filter(r => r.miss.length);
if (misses.length) {
    console.log('\n=== misses ===');
    for (const r of misses) console.log(`${r.scenario} [${r.mode}]: ${r.miss.join(', ')}`);
}
process.exit(0);
