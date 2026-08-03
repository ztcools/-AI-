/**
 * 自适应 mode 的收益/风险度量。
 *
 * 对同一批查询各跑两次：一次不传 mode（服务端自选），一次显式 both（旧默认行为）。
 * 要证明的两件事：
 *   1. 关系型/标识符查询自选到 graph，token 大幅下降，而期望符号仍在结果里
 *   2. 语义型查询没被误判成 graph —— 那会让 agent 拿到位置却没有代码
 *
 * Usage: node benchmarks/automode.mjs <repoPath> <branch>
 */
import { ToolHandlers } from '../packages/mcp/dist/handlers.js';
import { GraphToolHandlers } from '../packages/mcp/dist/graph-handlers.js';
import { Context, MilvusVectorDatabase, OllamaEmbedding, envManager } from '../packages/core/dist/index.js';

const repoPath = process.argv[2];
const branch = process.argv[3];
if (!repoPath || !branch) {
    console.error('usage: node benchmarks/automode.mjs <repoPath> <branch>');
    process.exit(2);
}

const embedding = new OllamaEmbedding({
    model: envManager.get('EMBEDDING_MODEL') || 'nomic-embed-text',
    host: envManager.get('OLLAMA_HOST') || 'http://127.0.0.1:11434',
    dimension: Number(envManager.get('EMBEDDING_DIMENSION') || 768),
});
const context = new Context({ embedding, vectorDatabase: new MilvusVectorDatabase({ address: envManager.get('MILVUS_ADDRESS') }) });
const handlers = new ToolHandlers(context, new GraphToolHandlers());

const textOf = (r) => (r?.content || []).map(c => c.text || '').join('\n');
const tok = (s) => Math.round(s.length / 4);

const CASES = [
    { q: 'who calls SetValue', expect: ['SetValue'], shape: 'relation' },
    { q: 'callers of ThrowAsException', expect: ['ThrowAsException'], shape: 'relation' },
    { q: 'what breaks if I change ErrorDomain', expect: ['ErrorDomain'], shape: 'relation' },
    { q: 'implementations of EventBase', expect: ['Event'], shape: 'relation' },
    { q: '谁调用 CreateProxy', expect: ['CreateProxy'], shape: 'relation' },
    { q: 'ProxyFactory', expect: ['ProxyFactory'], shape: 'identifier' },
    { q: 'KeyValueStorage', expect: ['KeyValueStorage'], shape: 'identifier' },
    { q: 'how does the proxy get created for a service handle', expect: ['Proxy'], shape: 'semantic' },
    { q: 'parse manifest configuration json for instance specifier', expect: ['Manifest'], shape: 'semantic' },
    { q: 'persist key value pairs and sync to storage', expect: ['SyncToStorage', 'KeyValueStorage'], shape: 'semantic' },
];

await handlers.handleLink({ path: repoPath, branch });
await handlers.handleSearchCode({ path: repoPath, query: 'warmup', mode: 'vector', limit: 1 });

const rows = [];
for (const c of CASES) {
    const auto = textOf(await handlers.handleSearchCode({ path: repoPath, query: c.q, limit: 10 }));
    const base = textOf(await handlers.handleSearchCode({ path: repoPath, query: c.q, mode: 'both', limit: 10 }));
    const picked = /\[auto: graph→both/.test(auto) ? 'graph→both' : /\[auto: graph\]/.test(auto) ? 'graph' : 'both';
    const hitAuto = c.expect.some(e => auto.includes(e));
    const hitBase = c.expect.some(e => base.includes(e));
    rows.push({ shape: c.shape, q: c.q, picked, ta: tok(auto), tb: tok(base), hitAuto, hitBase });
}

console.log('\n=== 自适应 mode vs 固定 both ===');
console.log('shape      picked      auto_t  both_t   saved   hit_auto  hit_both  query');
for (const r of rows) {
    const saved = r.tb > 0 ? Math.round((1 - r.ta / r.tb) * 100) : 0;
    console.log(
        r.shape.padEnd(10),
        r.picked.padEnd(11),
        String(r.ta).padStart(6),
        String(r.tb).padStart(7),
        (saved + '%').padStart(7),
        (r.hitAuto ? 'yes' : 'NO').padStart(9),
        (r.hitBase ? 'yes' : 'NO').padStart(9),
        ' ' + r.q,
    );
}
const sum = (f) => rows.reduce((a, r) => a + f(r), 0);
const regress = rows.filter(r => r.hitBase && !r.hitAuto);
console.log(`\n总 token: auto ${sum(r => r.ta)} vs both ${sum(r => r.tb)} (省 ${Math.round((1 - sum(r => r.ta) / sum(r => r.tb)) * 100)}%)`);
console.log(`命中: auto ${sum(r => r.hitAuto ? 1 : 0)}/${rows.length}, both ${sum(r => r.hitBase ? 1 : 0)}/${rows.length}`);
console.log(regress.length === 0 ? '无召回回归' : `召回回归 ${regress.length} 条: ${regress.map(r => r.q).join(' | ')}`);
process.exit(0);
