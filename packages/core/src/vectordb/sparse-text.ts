/**
 * 给 BM25 的文档侧补上「标识符按词切开」的 token。
 *
 * Milvus 的 standard tokenizer 按非字母数字切词，**不拆驼峰**：`SyncToStorage` 在
 * 索引里就是一个 token `synctostorage`，于是查询 "sync to storage" 的 sparse 侧一个
 * 词都对不上。图侧的 FTS5 是在建索引时就把标识符切开的（`search_text` 列），两边这个
 * 不对称正是同一次 `both` 搜索里图能给出、vector 给不出同一个符号的根因。
 *
 * 查询侧的 `expandSparseQuery` 只能补相邻词对的拼接，修不了三段以上的名字
 * （`SyncToStorage` 的 `to` 是停用词，拼出来的是 `syncstorage`）也修不了词在问句里
 * 隔得很远的情况（"monitor log directory for file changes" 里 file 和 monitor 隔了
 * 四个词，拼不出 `FileMonitor`）。在文档侧切一次，这三类一起解决，查询侧不用再猜。
 *
 * 纯追加，`content` 字段原样保留：原 token 还在，所以直接搜 `SyncToStorage` 照旧命中；
 * 反向的 `sync_to_storage` 被驼峰查询命中则靠拼接形式（snake 本来就被 tokenizer 切开，
 * 缺的是合起来那一个 token）。
 */

/** 驼峰 + 下划线切分。数字不切开：`sqlite3` 拆成 `sqlite` 会白丢一个有用 token。 */
function splitIdentifier(id: string): string[] {
  return id
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/_+/g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * search_text 字段的上限。Milvus VarChar 按 UTF-8 字节算，中文注释一个字符 3 字节，
 * 超了整批 insert 会失败 —— 宁可少扩展几个 token，不能让一个大 chunk 打挂一次索引。
 */
const SEARCH_TEXT_MAX_BYTES = 60000;

export function sparseDocExpansion(content: string): string {
  const ids = content.match(/[A-Za-z][A-Za-z0-9_]*/g);
  if (!ids) return '';
  const extra = new Set<string>();
  for (const id of ids) {
    if (id.length < 4) continue;
    const parts = splitIdentifier(id);
    if (parts.length < 2) continue;
    for (const p of parts) if (p.length > 1) extra.add(p);
    extra.add(parts.join(''));
  }
  return [...extra].join(' ');
}

/**
 * 按 UTF-8 字节截断，不切断多字节字符。`slice(0, N)` 是按**字符**切的：
 * 60000 个中文字符是 180000 字节，照样把 VarChar 撑爆，等于这个上限白设。
 */
function truncateBytes(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= maxBytes) return s;
  return new TextDecoder('utf-8', { fatal: false }).decode(buf.subarray(0, maxBytes)).replace(/�+$/, '');
}

export function buildSearchText(content: string): string {
  const budget = SEARCH_TEXT_MAX_BYTES - Buffer.byteLength(content, 'utf8') - 1;
  if (budget <= 0) return truncateBytes(content, SEARCH_TEXT_MAX_BYTES);
  const expansion = sparseDocExpansion(content);
  if (!expansion) return content;
  return expansion.length <= budget
    ? `${content}\n${expansion}`
    : `${content}\n${expansion.slice(0, expansion.lastIndexOf(' ', budget) + 1 || budget)}`;
}
