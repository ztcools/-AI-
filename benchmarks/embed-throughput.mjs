#!/usr/bin/env node
/**
 * 测 Ollama embedding 吞吐随并发流数的变化，用来定 GIT_INDEX_CONCURRENCY。
 *
 *   OLLAMA_HOST=http://<host>:11435 node benchmarks/embed-throughput.mjs
 *
 * GIT_INDEX_CONCURRENCY 决定同时有几个仓库在向量化，每个仓库是一条串行的 embed 流
 * —— 所以"N 条并发流的总吞吐"就是把并发调到 N 的收益上限。找吞吐曲线拐平的那一点，
 * 再往上只增加单流延迟。**这个值由 embedding 服务的能力决定，不是由核数决定**。
 *
 * 实测（2026-07-30，本栈 ollama：32g / 16cpu、4 卡共享，nomic-embed-text）：
 *   1 流 27 embed/s · 3 流 75(2.74×) · 6 流 136(4.98×) · 8 流 140(5.16×) · 12 流 142(5.22×)
 * 6 是饱和点，单流延迟 44ms；12 流时单流延迟涨到 84ms 而吞吐只多 4%。
 *
 * 换机器、换模型或改了 OLLAMA_NUM_PARALLEL 之后重跑，别照抄上面的数。
 */
const HOST = process.env.OLLAMA_HOST || 'http://10.50.4.149:11435';
const MODEL = process.env.EMBEDDING_MODEL || 'nomic-embed-text';
/** 每档测多少秒。太短会被抖动主导，12s 已经能稳到 ±2%。 */
const SECONDS = Number(process.env.SECONDS || 12);
const LEVELS = (process.env.LEVELS || '1,3,6,8,12').split(',').map(Number);
// 用真实代码片段做输入，长度接近实际 chunk（~800 字符）
const SAMPLE = `
static ara::core::Result<void> SyncToStorage(const InstanceSpecifier& spec,
                                            const std::vector<uint8_t>& payload) {
  auto handle = KeyValueStorage::Open(spec);
  if (!handle.HasValue()) { return MakeErrorCode(PerErrc::kStorageNotFound); }
  auto& kvs = handle.Value();
  for (std::size_t off = 0; off < payload.size(); off += kChunkSize) {
    const auto len = std::min(kChunkSize, payload.size() - off);
    auto res = kvs.SetValue(MakeChunkKey(spec, off), Span(payload.data() + off, len));
    if (!res.HasValue()) { return res.Error(); }
  }
  return kvs.SyncToStorage();
}`.repeat(2);

async function embedOnce() {
  const r = await fetch(`${HOST}/api/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, prompt: SAMPLE }),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  if (!Array.isArray(j.embedding)) throw new Error('no embedding');
}

async function stream(deadline) {   // 一条串行流，跑到截止时间，返回完成数
  let n = 0;
  while (Date.now() < deadline) { await embedOnce(); n++; }
  return n;
}

async function measure(streams, seconds) {
  const deadline = Date.now() + seconds * 1000;
  const t0 = Date.now();
  const counts = await Promise.all(Array.from({ length: streams }, () => stream(deadline)));
  const elapsed = (Date.now() - t0) / 1000;
  const total = counts.reduce((a, b) => a + b, 0);
  return { streams, total, qps: total / elapsed, perStreamMs: (elapsed * 1000) / (total / streams) };
}

await embedOnce();   // 预热，别把首次模型加载算进第一档
console.log(`host=${HOST} model=${MODEL} 输入长度=${SAMPLE.length} 字符 每档 ${SECONDS}s\n`);
console.log('并发流   总完成   吞吐(embed/s)   单流平均延迟   相对1流加速');
let base = null;
let best = null;
for (const s of LEVELS) {
  const r = await measure(s, SECONDS);
  base ??= r.qps;
  console.log(`  ${String(r.streams).padStart(2)}    ${String(r.total).padStart(5)}      ${r.qps.toFixed(1).padStart(6)}         ${r.perStreamMs.toFixed(0).padStart(5)}ms       ${(r.qps / base).toFixed(2)}×`);
  // 饱和判据：相比上一档吞吐提升不足 10% 就认为拐平了，取上一档
  if (best && r.qps < best.qps * 1.1) {
    console.log(`\n→ 饱和点 ${best.streams} 流（下一档只多 ${((r.qps / best.qps - 1) * 100).toFixed(0)}% 吞吐，` +
                `单流延迟 ${best.perStreamMs.toFixed(0)}→${r.perStreamMs.toFixed(0)}ms）`);
    console.log(`  建议 GIT_INDEX_CONCURRENCY=${best.streams}`);
    break;
  }
  best = r;
}
