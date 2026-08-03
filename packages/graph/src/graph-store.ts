/**
 * SQLite-backed graph store for code knowledge graphs.
 *
 * v2 — per-project storage, enhanced schema.
 * DB lives at <projectDir>/.context/graph/knowledge-graph.db
 *
 * Stores nodes, edges, unresolved references, and files with FTS5 for BM25 search.
 */
import * as path from 'path';
import * as fs from 'fs';
import {
  GraphStore,
  GraphNode,
  GraphEdge,
  GraphNodeKind,
  GraphEdgeKind,
  GraphLanguage,
  GraphSearchOptions,
  GraphSearchResponse,
  GraphSearchResult,
  UnresolvedReference,
} from './types';

// ── Path helpers ────────────────────────────────────────────────────

function ensureGraphDir(projectDir: string): string {
  const dir = path.join(projectDir, '.context', 'graph');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function getGraphDbPath(projectDir: string): string {
  return path.join(ensureGraphDir(projectDir), 'knowledge-graph.db');
}

// ── SQL schema v2 ───────────────────────────────────────────────────

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS nodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project TEXT NOT NULL,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    /*
     * Last dotted segment of the name (Foo.bar -> bar; no dot -> the name).
     *
     * Reference resolution asks "which nodes are called bar, whatever they hang
     * off" thousands of times per index, and the only way to express that in SQL
     * was  name LIKE '%.' || ?  — a leading wildcard, so a full table scan per
     * lookup. It was 4.8s of an 8.7s index of a 353-file repo (55%), more than
     * parsing and storing combined. Denormalised here so the lookup is an index
     * seek. Filled by upsertNode; there is no other writer.
     */
    suffix_name TEXT,
    /*
     * The name split into words: CreateProxy -> "create proxy".
     *
     * The FTS tokenizer splits on punctuation, so createProxy is one token and a
     * query term "proxy" cannot match it — FTS5 prefix search only matches from
     * the start, which is why "handle*" found HandleEventMessage while "proxy*"
     * never found CreateProxy. Splitting has to happen before the tokenizer sees
     * the text, and a custom tokenizer needs the C API, so the split text is
     * stored as its own column and indexed alongside name. Filled by upsertNode;
     * there is no other writer.
     */
    search_text TEXT,
    qualified_name TEXT NOT NULL,
    file_path TEXT NOT NULL,
    language TEXT,
    start_line INTEGER NOT NULL DEFAULT 0,
    end_line INTEGER NOT NULL DEFAULT 0,
    signature TEXT,
    visibility TEXT,
    is_exported INTEGER NOT NULL DEFAULT 0,
    is_async INTEGER NOT NULL DEFAULT 0,
    is_static INTEGER NOT NULL DEFAULT 0,
    is_abstract INTEGER NOT NULL DEFAULT 0,
    decorators_json TEXT,
    type_parameters_json TEXT,
    return_type TEXT,
    docstring TEXT,
    properties_json TEXT NOT NULL DEFAULT '{}',
    updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    UNIQUE(project, qualified_name)
);

CREATE INDEX IF NOT EXISTS idx_nodes_project ON nodes(project);
CREATE INDEX IF NOT EXISTS idx_nodes_kind ON nodes(project, kind);
CREATE INDEX IF NOT EXISTS idx_nodes_file ON nodes(project, file_path);
CREATE INDEX IF NOT EXISTS idx_nodes_qn ON nodes(project, qualified_name);
CREATE INDEX IF NOT EXISTS idx_nodes_name ON nodes(project, name);
CREATE INDEX IF NOT EXISTS idx_nodes_lower_name ON nodes(project, LOWER(name));
-- idx_nodes_suffix is created by _ensureSuffixName: on a pre-existing graph the
-- column is added by ALTER TABLE, which has to happen before the index.

CREATE TABLE IF NOT EXISTS edges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project TEXT NOT NULL,
    source_id INTEGER NOT NULL,
    target_id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    line INTEGER NOT NULL DEFAULT -1,
    col INTEGER NOT NULL DEFAULT -1,
    provenance TEXT DEFAULT 'tree-sitter',
    metadata_json TEXT,
    properties_json TEXT NOT NULL DEFAULT '{}',
    UNIQUE(source_id, target_id, kind, line, col)
);

CREATE INDEX IF NOT EXISTS idx_edges_project ON edges(project);
CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(project, source_id);
CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(project, target_id);
CREATE INDEX IF NOT EXISTS idx_edges_kind ON edges(project, kind);

CREATE TABLE IF NOT EXISTS unresolved_refs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project TEXT NOT NULL,
    from_node_id INTEGER NOT NULL,
    reference_name TEXT NOT NULL,
    reference_kind TEXT NOT NULL,
    line INTEGER NOT NULL DEFAULT 0,
    col INTEGER NOT NULL DEFAULT 0,
    file_path TEXT,
    language TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_urefs_project_status ON unresolved_refs(project, status);
CREATE INDEX IF NOT EXISTS idx_urefs_from_node ON unresolved_refs(project, from_node_id);

CREATE TABLE IF NOT EXISTS files (
    path TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    language TEXT NOT NULL,
    size INTEGER NOT NULL DEFAULT 0,
    modified_at INTEGER NOT NULL DEFAULT 0,
    indexed_at INTEGER NOT NULL DEFAULT (unixepoch()),
    node_count INTEGER NOT NULL DEFAULT 0,
    errors_json TEXT,
    PRIMARY KEY (path)
);

`;

/**
 * FTS5 index over the identifier, its word-split form (see nodes.search_text),
 * the qualified name and the path.
 *
 * Kept out of SCHEMA_SQL because an FTS5 table's columns and tokenizer are fixed
 * at creation: changing either on an existing graph means dropping and
 * recreating this table, so _ensureFtsIndex has to be able to re-run it — and it
 * compares this exact text against sqlite_master to decide whether to.
 * External-content table — the text lives in `nodes`, so every column here must
 * exist there.
 *
 * The porter stemmer is what makes a question match code: an agent types "how
 * are logs uploaded", the identifier is UploadLogFile, and only stemming gets
 * uploaded → upload. Without it the query term had to be a literal prefix of the
 * stored token, which matched by accident more than by meaning — "created"
 * pulled in CreateDirectoryIfNotExists and createData (both start with
 * "created") while never reaching CreateProxy.
 */
const NODES_FTS_SQL = `
CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
    name,
    search_text,
    qualified_name,
    file_path,
    content='nodes',
    content_rowid='id',
    tokenize='porter unicode61 remove_diacritics 1'
);
`;

const FTS_TRIGGERS_SQL = `
CREATE TRIGGER IF NOT EXISTS nodes_ai AFTER INSERT ON nodes BEGIN
    INSERT INTO nodes_fts(rowid, name, search_text, qualified_name, file_path)
    VALUES (new.id, new.name, new.search_text, new.qualified_name, new.file_path);
END;

CREATE TRIGGER IF NOT EXISTS nodes_ad AFTER DELETE ON nodes BEGIN
    INSERT INTO nodes_fts(nodes_fts, rowid, name, search_text, qualified_name, file_path)
    VALUES ('delete', old.id, old.name, old.search_text, old.qualified_name, old.file_path);
END;

CREATE TRIGGER IF NOT EXISTS nodes_au AFTER UPDATE ON nodes BEGIN
    INSERT INTO nodes_fts(nodes_fts, rowid, name, search_text, qualified_name, file_path)
    VALUES ('delete', old.id, old.name, old.search_text, old.qualified_name, old.file_path);
    INSERT INTO nodes_fts(rowid, name, search_text, qualified_name, file_path)
    VALUES (new.id, new.name, new.search_text, new.qualified_name, new.file_path);
END;
`;

/** `Foo.bar` → `bar`; a name with no dot is its own last segment. */
function lastNameSegment(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? name : name.slice(dot + 1);
}

/**
 * Identifier → space-separated lowercase words, for nodes.search_text.
 *
 * `CreateProxy` → `create proxy`, `key_value_storage` → `key value storage`,
 * `HTTPServer` → `http server` (an acronym run keeps its last capital for the
 * word that follows it), `Gson.toJson` → `gson to json`. Returns '' when the
 * split adds nothing over the name itself, so single-word identifiers don't
 * double their weight in the index.
 */
function splitIdentifier(name: string): string {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map(w => w.toLowerCase());
  if (words.length < 2) return '';
  return words.join(' ');
}

/**
 * Kinds never worth returning as a search hit: import pseudo-nodes, data,
 * file/parameter/enum-member scaffolding, and constructors (an agent gains
 * nothing from `OrderService.constructor` alongside `OrderService`).
 *
 * `constructor` is a kind for languages whose grammar marks ctors/dtors
 * structurally — C++ tells them by having no return type — while JS/TS needs the
 * `.constructor` name check in buildNodeResults. Filtered from results only:
 * the nodes stay in the graph so "who instantiates X" traversals keep the edge.
 */
const RESULT_NOISE_KINDS = new Set([
  'import',
  'variable',
  'parameter',
  'file',
  'enum_member',
  'constructor',
  // C++ `namespace foo {` and Rust `mod foo {` — a container, not an answer, and
  // one that matches whatever its own directory is called. 777 of ap-client-api's
  // 8,700 nodes are namespaces, and `namespace supervised_entity` took the top
  // slot away from `class SupervisedEntity` in the same header tree.
  'module',
]);

/** 结构边：表达"谁装着谁"，不表达"谁用谁"，不计入出入度。 */
const STRUCTURAL_EDGE_KINDS = ['contains', 'imports', 'exports'];
const STRUCTURAL_EDGE_PLACEHOLDERS = STRUCTURAL_EDGE_KINDS.map(() => '?').join(',');

/**
 * Directory segments that hold somebody else's code.
 *
 * 这不是洁癖，是实测：PhiLog 223 个文件里 104 个是 vendored 进来的 spdlog（root 有
 * `LICENSE-spdlog`），于是问"这个项目的 sink 怎么注册/什么时候刷盘"，返回的图符号
 * 清一色是 `include/spdlog/**` 的 `register_logger` / `log_msg_buffer` / `flush_on`
 * ——全是 ↖1 ↗0 的孤立节点，而真正的答案 `LogManager::InitLogging` 一条没进前 5。
 * 上游库的标识符命名比业务代码更"标准"，正好更容易命中自然语言查询，所以它不是偶尔
 * 掺杂，而是系统性地把本仓库的答案挤光。
 *
 * 按 docs/tests 的先例**降权而非排除**：追调用链追进第三方库是正当需求（`↖` 从业务
 * 代码指进 spdlog 是真实信息），只是默认不该由它占据前排。
 */
const DEFAULT_VENDOR_SEGMENTS = [
  'third_party', 'thirdparty', '3rdparty', 'third-party',
  'vendor', 'vendors', 'vendored',
  'external', 'externals', 'extern',
  'deps', 'dependencies', 'contrib', 'submodules',
  'node_modules', 'site-packages', 'dist-packages', 'bower_components', 'Pods',
  // 机器生成的代码：跟第三方库同一档 —— 都不是本仓库开发者手写的，都不该是答案。
  // 实测 ap-client-api 881/1360 个文件是 parasoft C++test 自动生成的测试套件，
  // PhiLog 的 `parasoft/philog/stubs/autogenerated/` 又不匹配测试目录正则
  // （段名是 stubs/autogenerated，不含 test），于是白占了 vector 前 10 的 4 个槽位。
  'autogenerated', 'auto_generated', 'generated', '__generated__', 'parasoft',
];

/**
 * 机器生成的**文件名**（目录段认不出来的那部分）：protobuf / flatbuffers / Qt moc。
 * 与目录段同一档降权。
 */
export const GENERATED_FILE_RE =
  /(\.pb\.(cc|h|go)|_pb2(_grpc)?\.py|[._-]generated\.[^./]+|\.g\.dart)$|(^|\/)(moc_|ui_|qrc_)[^/]*$/i;

/** 把目录段列表编成一个"路径里出现该段"的正则。段名按字面量转义。 */
export function vendorSegmentsToRegExp(segments: string[]): RegExp | null {
  const cleaned = [...new Set(segments.map(s => s.trim()).filter(Boolean))];
  if (cleaned.length === 0) return null;
  const alt = cleaned.map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return new RegExp(`(^|/)(${alt})(/|$)`, 'i');
}

/** 默认 vendored 目录段（约定名）。调用方可在此基础上追加仓库自己的。 */
export function defaultVendorSegments(): string[] {
  return [...DEFAULT_VENDOR_SEGMENTS];
}

/**
 * Words that carry no locating power in a code query.
 *
 * Both the FTS pass and the LIKE fallback expand every token to a prefix-OR, so
 * one function word is enough to swamp the real term: `how is a proxy created
 * for a service handle` matched on `service`/`create` and put a Python codegen
 * script above `ProxyFactory::CreateProxy`, which never ranked at all. The
 * interrogatives matter specifically because an agent asking a relationship
 * question phrases it as a question ("who calls X", "where is Y handled").
 *
 * Filtering is best-effort: a query made entirely of these words keeps them,
 * since an empty MATCH is worse than a vague one.
 */
/**
 * Vocabulary that describes code in general rather than naming anything in it.
 *
 * Dropped as standalone search terms — but NOT when it sits next to another word
 * (see queryPhrases): "code" alone matches half the repo, while "error code" is
 * the identifier the question was about.
 */
const QUERY_GENERIC_WORDS = new Set([
  'class', 'function', 'method', 'type', 'interface', 'object',
  'string', 'number', 'data', 'import', 'export', 'module', 'file',
  'code', 'use', 'get', 'set', 'add', 'new',
]);

/** Grammar words: they never name anything, alone or in a phrase. */
const QUERY_STOP_WORDS = new Set([
  // interrogatives / relationship phrasing
  'how', 'what', 'where', 'when', 'why', 'who', 'whom', 'which',
  'does', 'did', 'do', 'is', 'are', 'was', 'were', 'be', 'been', 'can',
  // articles, prepositions, conjunctions, pronouns
  'the', 'and', 'for', 'an', 'of', 'to', 'in', 'on', 'at', 'by', 'or',
  'with', 'from', 'into', 'that', 'this', 'these', 'those', 'it', 'its',
  'as', 'via', 'any', 'all',
]);

const QUERY_NOISE_WORDS = new Set([...QUERY_GENERIC_WORDS, ...QUERY_STOP_WORDS]);

/** Query split into words, camelCase and punctuation both treated as breaks. */
function queryWords(query: string): string[] {
  return query
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(/[\s_\-.:/]+/)
    .filter(t => t.length > 1);
}

/**
 * Query tokens worth searching for: noise words dropped where something remains,
 * and each remaining word kept once.
 *
 * De-duplication is not cosmetic. Every token becomes another OR arm, so a word
 * the user happened to repeat was counted twice by BM25: "error code and error
 * domain definition" scored the ErrorDomain classes above the ErrorCode class
 * the question was about, purely because "error" appeared twice. It also inflates
 * the LIKE pass's majority threshold, which counts distinct arms.
 */
function meaningfulQueryTokens(query: string): string[] {
  const raw = queryWords(query);
  const meaningful = raw.filter(t => !QUERY_NOISE_WORDS.has(t.toLowerCase()));
  const kept = meaningful.length > 0 ? meaningful : raw;
  const seen = new Set<string>();
  return kept.filter(t => {
    const k = t.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * Word pairs where code writes one and prose writes the other.
 *
 * The stemmer cannot bridge these — "configuration" stems to `configur` and
 * `config` stems to itself, so a prefix search for one never reaches the other.
 * That is not a corner case: an agent asks "initialize logging and create the log
 * manager" and the symbol is `InitLogging`, or asks about "configuration" and the
 * struct is `LogConfig`. Both were misses until each query word also searched for
 * its counterpart. Kept deliberately short — only shortenings so standard that
 * both spellings mean the same thing in code.
 */
const ABBREVIATION_PAIRS: Array<[string, string]> = [
  ['config', 'configuration'],
  ['cfg', 'configuration'],
  ['init', 'initialize'],
  ['init', 'initialization'],
  ['impl', 'implementation'],
  ['msg', 'message'],
  ['mgr', 'manager'],
  ['ctx', 'context'],
  ['db', 'database'],
  ['auth', 'authentication'],
  ['err', 'error'],
  ['req', 'request'],
  ['res', 'response'],
  ['resp', 'response'],
  ['buf', 'buffer'],
  ['addr', 'address'],
  ['dir', 'directory'],
  ['num', 'number'],
  ['len', 'length'],
  ['util', 'utility'],
  ['exec', 'execute'],
  ['calc', 'calculate'],
  ['sync', 'synchronize'],
  ['async', 'asynchronous'],
  ['temp', 'temporary'],
  ['spec', 'specification'],
  ['proc', 'process'],
  ['stats', 'statistics'],
  ['env', 'environment'],
  ['repo', 'repository'],
];

/** Both directions of ABBREVIATION_PAIRS, keyed by lowercase word. */
const ABBREVIATION_MAP: Map<string, string[]> = (() => {
  const m = new Map<string, string[]>();
  const add = (from: string, to: string) => {
    const list = m.get(from);
    if (list) list.push(to);
    else m.set(from, [to]);
  };
  for (const [short, long] of ABBREVIATION_PAIRS) {
    add(short, long);
    add(long, short);
  }
  return m;
})();

/** A word plus the spellings code might use instead, the word itself first. */
function wordVariants(word: string): string[] {
  const alt = ABBREVIATION_MAP.get(word.toLowerCase());
  return alt ? [word, ...alt] : [word];
}

/**
 * 查询把一个符号的名字整个念了出来时，别让"只蹭到几个泛词"的行压过它。
 *
 * BM25 按**命中的不同词数**累加，所以查询越长越偏向"沾到更多词"的文档：
 * "monitor log directory for file changes" 里 `FileMonitor` 只对上 2 个词 —— 却是
 * 它名字的全部 —— 而 `log_dir_`（log+dir）、`DirectoryExists`（directory）各自沾到
 * 别的词，把它挤出前十。短语臂也救不了：它按查询里的**相邻**词对构造，而
 * "monitor…file" 在查询里既不相邻、顺序还是反的。
 *
 * 覆盖率 = 符号名切出来的词有多少落在查询词集合里（含缩写对，`dir`↔`directory`）。
 * 分母是**符号的**词数而不是查询的词数：这衡量的是"这个名字有多大比例被念到"，
 * 长查询不会因为多带了几个词就稀释它。单词名不参与 —— 名字只有一个词时覆盖率
 * 必然是 0 或 1，全覆盖的那批已经被 exact-name 段接住了。
 */
const FULL_NAME_COVERAGE_BOOST = 1.8;
const PARTIAL_NAME_COVERAGE_BOOST = 1.3;
const PARTIAL_NAME_COVERAGE_MIN = 2 / 3;

function boostNameCoverage(rows: Array<Record<string, unknown>>, query: string): void {
  const qTokens = new Set<string>();
  for (const t of meaningfulQueryTokens(query)) {
    for (const v of wordVariants(t.toLowerCase())) qTokens.add(v.toLowerCase());
  }
  if (qTokens.size === 0) return;
  for (const row of rows) {
    const name = lastNameSegment(String(row.name || ''));
    const split = splitIdentifier(name);
    if (!split) continue;
    const parts = split.split(' ').filter(w => w.length > 1);
    if (parts.length < 2) continue;
    let hit = 0;
    for (const p of parts) {
      if (wordVariants(p).some(v => qTokens.has(v.toLowerCase()))) hit++;
    }
    const coverage = hit / parts.length;
    const factor = coverage >= 1
      ? FULL_NAME_COVERAGE_BOOST
      : coverage >= PARTIAL_NAME_COVERAGE_MIN ? PARTIAL_NAME_COVERAGE_BOOST : 0;
    if (factor) row.score = (Number(row.score) || 0) * factor;
  }
}

/** Bound on phrase arms per query, so a long sentence can't balloon the MATCH. */
const MAX_QUERY_PHRASES = 8;

/** Bound on total MATCH arms, once abbreviation variants have multiplied them. */
const MAX_FTS_ARMS = 28;

/**
 * Re-order scored rows so one concept in the query can't take every slot.
 *
 * A question naming two things — "supervised entity health monitoring recovery
 * action" — scores every `SupervisedEntity*` symbol in the tree just above
 * `RecoveryAction`, which landed 11th of 10 by 0.02 points. Ten near-identical
 * names from one header tree teach an agent less than four of them plus the other
 * half of what it asked about.
 *
 * A row's concept is the first query word-pair its identifier spells out (the
 * same pairs buildFtsQuery searches for, abbreviations included), so this only
 * engages where a phrase actually matched: single-concept queries leave every row
 * unkeyed and the order untouched. Rows past the per-concept cap are moved to the
 * back rather than dropped, which keeps paging with `offset` consistent.
 */
/**
 * 同一个符号名最多占几条。C++ 一个方法天然有 2 条（声明 + 定义），再加上
 * consumer/impl 这种同接口多实现，一个名字就能吃掉半个结果页：问"键值存储读写"，
 * 第 5 到第 9 名全是 `SyncToStorage`（header、impl、consumer 各一份），而查询真正
 * 还问了的 `SetValue` 排在十名之外。声明+定义这一对是有用的（一个给签名、一个给
 * 实现），所以留 2 条，多出来的下溢到尾部而不是丢掉 —— 和概念多样性同一套做法，
 * `offset` 分页仍然一致。
 */
const MAX_ROWS_PER_NAME = 2;

/**
 * FTS 段要取多深。
 *
 * 只取 `limit * 2` 时，一页十条里能被真正拿去看的常常只有六条：噪声 kind 被过滤、
 * 同名的声明/实现被 capPerName 下溢，剩下的空位由 LIKE 兜底段（score 0.1）的边角
 * 符号填掉 —— 而 BM25 排在第 21 位的行明明比它们相关。实测"键值存储读写"那一页
 * 第 7 到第 10 名全是 0.1 分的 `DeleteKvstype`/`DiscardPendingChanges`。
 *
 * 取深一点纯粹是拿 SQLite 的 top-N 换质量：bm25 排序在索引里做，多取 140 行的
 * 代价在毫秒级（实测单查询 3–16ms 没有可测变化），而过滤和去重之后一页才是满的。
 */
const FTS_CANDIDATE_FACTOR = 8;
const FTS_CANDIDATE_MAX = 200;

function ftsCandidateLimit(limit: number): number {
  return Math.min(FTS_CANDIDATE_MAX, Math.max(limit * 2, limit * FTS_CANDIDATE_FACTOR));
}

function capPerName(
  rows: Array<Record<string, unknown>>,
  limit: number,
): Array<Record<string, unknown>> {
  if (rows.length <= limit) return rows;
  const counts = new Map<string, number>();
  const kept: Array<Record<string, unknown>> = [];
  const spilled: Array<Record<string, unknown>> = [];
  for (const row of rows) {
    const key = lastNameSegment(String(row.name || '')).toLowerCase();
    if (!key) {
      kept.push(row);
      continue;
    }
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    if (n <= MAX_ROWS_PER_NAME) kept.push(row);
    else spilled.push(row);
  }
  return spilled.length === 0 ? rows : [...kept, ...spilled];
}

function diversifyByConcept(
  rows: Array<Record<string, unknown>>,
  query: string,
  limit: number,
): Array<Record<string, unknown>> {
  if (rows.length <= limit) return rows;
  const phrases: string[] = [];
  for (const phrase of queryPhrases(query)) {
    const [a, b] = phrase.split(' ');
    for (const va of wordVariants(a)) {
      for (const vb of wordVariants(b)) phrases.push(`${va} ${vb}`);
    }
  }
  if (phrases.length < 2) return rows;

  const perConcept = Math.max(3, Math.ceil(limit / 3));
  const counts = new Map<string, number>();
  const kept: Array<Record<string, unknown>> = [];
  const spilled: Array<Record<string, unknown>> = [];
  for (const row of rows) {
    const text = String(row.search_text || row.name || '').toLowerCase();
    const concept = phrases.find(p => text.includes(p));
    if (!concept) {
      kept.push(row);
      continue;
    }
    const n = (counts.get(concept) ?? 0) + 1;
    counts.set(concept, n);
    if (n <= perConcept) kept.push(row);
    else spilled.push(row);
  }
  return spilled.length === 0 ? rows : [...kept, ...spilled];
}

/**
 * Sink rows from "not this repo's answer" subtrees behind the repo's own code.
 *
 * 两类都在这里降权，因为它们的失效方式一模一样 —— 都是"文件数占比大、命名又比业务
 * 代码更规整，于是系统性地把答案挤光"：
 *   1. **vendored 第三方**：PhiLog 104/223 个文件是拷进来的 spdlog。
 *   2. **测试**：测试镜像被测接口，天然高度匹配"X 怎么用/什么时候被调"这类查询。
 * vector 侧早就有测试降权（core 的 `penalizeTestResults`），图侧之前没有，于是同一次
 * `both` 搜索里向量结果是干净的、图符号块却被测试刷屏。实测 flask + requests 的真实
 * 场景：top10 里测试行 45/80 → 17/80（56%→21%），召回 68%→74%（requests 75%→88%
 * —— 测试让位后真正的实现才排进前 10）。
 *
 * 注意**自动生成**的测试不靠这里：`parasoft/`、`autogenerated/` 这类目录在索引阶段
 * 就被 indexer 的 ignore 列表挡掉了（ap-client-api 的 881 个生成 .cpp 从来没进图），
 * 这里管的是正常写在 `tests/`、`*_test.go`、`src/test/` 里的手写测试。
 *
 * 用**稳定分区**而不是"乘完系数重排"：`allRows` 是按 pass 顺序拼起来的（exact=1000 →
 * FTS 的 -bm25 → LIKE → prefix=0.05），四段分数不同量纲，全局按 score 排序会把
 * exact/prefix 的关系搞乱。按惩罚档分区保住各段内部次序，同时把 score 乘上系数，让
 * 报出去的分数和实际排位一致（否则调用方看到"分数更高却排在后面"）。
 *
 * penalty 不在 (0,1) 时该档不降权 —— 上层传 `vendor:true` / `tests:true` 就是这条
 * 路径（明确要看第三方库或测试用例时不该降权）。
 */
const DEMOTED = Symbol('demoted');

/**
 * 给降权行在首页尾部留几个槽。
 *
 * `demoteRows` 是稳定分区，候选池一深，降权段就整段落到 40 名以后 —— "降权"事实上
 * 变成了"排除"。而有些查询的正确答案本来就在 vendored 子树里：PhiLog 自己的
 * `pg_rotating_file_sink` 是按大小轮转，问"按天切分日志文件"的答案只能是 spdlog 的
 * `daily_file_sink`；一页十条全是本仓库的 sink，看着干净，其实答错了。
 *
 * 只换最后 `q` 个槽，且只在降权后的分数仍然高于被换掉的那一行时才换 —— 实测那一页
 * 被换掉的是 8.96 分的 `rename_file_`，换上来的是罚过 0.35 之后仍有 33.73 分的
 * `daily_filename_calculator`。前排仍然属于本仓库代码，这是分层要保的东西。
 */
const DEMOTED_PAGE_QUOTA = 2;

function reserveDemotedSlots(
  rows: Array<Record<string, unknown>>,
  limit: number,
): Array<Record<string, unknown>> {
  const q = Math.min(DEMOTED_PAGE_QUOTA, Math.floor(limit / 4));
  if (q < 1 || rows.length <= limit) return rows;
  const head = rows.slice(0, limit);
  if (head.some(r => (r as never)[DEMOTED])) return rows;

  const tail = rows.slice(limit);
  const cands = tail
    .filter(r => (r as never)[DEMOTED])
    .sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0))
    .slice(0, q);
  if (cands.length === 0) return rows;

  const promoted = new Set<Record<string, unknown>>();
  const displaced: Array<Record<string, unknown>> = [];
  for (let i = 0; i < cands.length; i++) {
    const slot = limit - cands.length + i;
    if ((Number(cands[i].score) || 0) <= (Number(head[slot].score) || 0)) continue;
    promoted.add(cands[i]);
    displaced.push(head[slot]);
    head[slot] = cands[i];
  }
  if (promoted.size === 0) return rows;
  return [...head, ...displaced, ...tail.filter(r => !promoted.has(r))];
}

/**
 * 一页里挤满同一个类的成员时，把那个类本身带进来。
 *
 * BM25 数的是"命中了几个词"，所以查 "how is a proxy created for a service handle"
 * 时 `CreateProxy`/`CreateEvent`/`CreateMethod`/`CreateField` 各自命中 create+proxy
 * 稳占前排，而它们的宿主 `class ProxyFactory` 只命中 proxy —— 一页十条全是兄弟方法，
 * 唯独缺了回答"这套东西属于谁"的那个符号。agent 拿到四个 Create* 还得再读一次文件
 * 才知道它们同属一个工厂类，而那一次 Read 本来是可以省掉的。
 *
 * 判据是 contains 边而不是 qualified_name：qualified_name 存的是"路径点分 + 符号名"
 * （`…proxy.proxy_factory.CreateProxy`），剥掉最后一段得到的是文件，不是类。
 *
 * 容器插在它第一个成员之前 —— 先说清是哪个类再列成员，这才是阅读顺序。被挤出首页的
 * 行下溢到尾部而不是丢弃，`offset` 分页才不会跳行。
 */
const CONTAINER_HOIST_QUOTA = 2;
const CONTAINER_HOIST_MIN_MEMBERS = 2;

function hoistParentContainers(
  rows: Array<Record<string, unknown>>,
  limit: number,
  lookupParents: (memberIds: number[]) => Map<number, Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const quota = Math.min(CONTAINER_HOIST_QUOTA, Math.floor(limit / 5));
  if (quota < 1 || rows.length === 0) return rows;

  const head = rows.slice(0, limit);
  const ids = head.map(r => Number(r.id)).filter(Number.isFinite);
  const parents = lookupParents(ids);
  if (parents.size === 0) return rows;

  const inHead = new Set(ids);
  const groups = new Map<number, { node: Record<string, unknown>; count: number; first: number; score: number }>();
  head.forEach((row, i) => {
    const parent = parents.get(Number(row.id));
    if (!parent) return;
    const pid = Number(parent.id);
    if (inHead.has(pid)) return;
    const g = groups.get(pid);
    const score = Number(row.score) || 0;
    if (g) { g.count++; if (score > g.score) g.score = score; }
    else groups.set(pid, { node: parent, count: 1, first: i, score });
  });

  const picked = Array.from(groups.values())
    .filter(g => g.count >= CONTAINER_HOIST_MIN_MEMBERS)
    .sort((a, b) => b.count - a.count || a.first - b.first)
    .slice(0, quota);
  if (picked.length === 0) return rows;

  // 从后往前插：先插靠前的位置会把后面记下的下标推走。
  const hoisted = new Set(picked.map(g => Number(g.node.id)));
  for (const g of picked.slice().sort((a, b) => b.first - a.first)) {
    head.splice(g.first, 0, { ...g.node, score: g.score });
  }
  const displaced = head.splice(limit);
  return [...head, ...displaced, ...rows.slice(limit).filter(r => !hoisted.has(Number(r.id)))];
}

function demoteRows(
  rows: Array<Record<string, unknown>>,
  segments: string[] | undefined,
  vendorPenalty: number | undefined,
  testPenalty: number | undefined,
): Array<Record<string, unknown>> {
  const vp = vendorPenalty ?? 0.35;
  const tp = testPenalty ?? 0.55;
  const vre = (segments && segments.length && vp > 0 && vp < 1) ? vendorSegmentsToRegExp(segments) : null;
  const testOn = tp > 0 && tp < 1;
  if (!vre && !testOn) return rows;

  // 惩罚档 → 该档的行（Map 保插入序，所以先出现的档排在前面）。
  const tiers = new Map<number, Array<Record<string, unknown>>>([[1, []]]);
  let demotedCount = 0;
  for (const row of rows) {
    const fp = String(row.file_path || '');
    let factor = 1;
    if (vre && (vre.test(fp) || GENERATED_FILE_RE.test(fp))) factor *= vp;
    if (testOn && isTestPath(fp)) factor *= tp;
    if (factor === 1) {
      tiers.get(1)!.push(row);
      continue;
    }
    demotedCount++;
    const bucket = tiers.get(factor);
    const scored = { ...row, score: (Number(row.score) || 0) * factor, [DEMOTED]: true };
    if (bucket) bucket.push(scored);
    else tiers.set(factor, [scored]);
  }
  if (demotedCount === 0) return rows;
  // 档间按系数降序（罚得越轻越靠前），档内保持原次序。
  const ordered = [...tiers.entries()].sort((a, b) => b[0] - a[0]);
  return ordered.flatMap(([, bucket]) => bucket);
}

/**
 * 测试/桩代码的路径判定。与 core 的 `penalizeTestResults` 保持同一套规则，
 * 两侧对"什么算测试"的看法不一致比不降权更难排查。
 */
export function isTestPath(filePath: string): boolean {
  const fp = filePath.replace(/\\/g, '/');
  const base = fp.split('/').pop() || '';
  if (/(^|\/)(tests?|testing|__tests__|spec|specs|testdata|test_fixtures|fixtures|mocks?|__mocks__)(\/|$)/i.test(fp)) return true;
  if (/^(test_|conftest)/i.test(base)) return true;
  if (/(_test|_spec|\.test|\.spec)\.[^.]+$/i.test(base)) return true;
  if (/(Test|Tests|Spec|TestCase)\.[^.]+$/.test(base)) return true;
  return false;
}

/**
 * Adjacent word pairs from the query, as identifiers spell them.
 *
 * A prefix-OR over single words ranks by how many query words a row matches, and
 * is blind to their order — so "error code and error domain definition" put ten
 * *ErrorDomain* classes above `ErrorCode` (which matches "error" and nothing
 * else, "code" being generic), and "supervised entity health monitoring recovery
 * action" never reached `SupervisedEntity` because rows in recovery_action.cpp
 * matched three words via their path. Searching the pairs as FTS phrases against
 * the identifier columns restores what the word split threw away: `ErrorCode`'s
 * search_text is literally "error code", so the phrase hits it and nothing whose
 * name merely shares one word.
 *
 * Built from a stop-word-only filter, since it is exactly the generic half of the
 * vocabulary ("code", "file", "get") that carries meaning once paired.
 */
function queryPhrases(query: string): string[] {
  const words = queryWords(query)
    .map(t => t.toLowerCase())
    .filter(t => !QUERY_STOP_WORDS.has(t));
  const out: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i + 1 < words.length && out.length < MAX_QUERY_PHRASES; i++) {
    if (words[i] === words[i + 1]) continue;
    const phrase = `${words[i]} ${words[i + 1]}`;
    if (seen.has(phrase)) continue;
    seen.add(phrase);
    out.push(phrase);
  }
  return out;
}

// ── Edge dedup: handled by UNIQUE constraint on (source_id, target_id, kind, line, col) ──

// ── Implementation ──────────────────────────────────────────────────

type Database = any; // better-sqlite3 Database type

export class SqliteGraphStore implements GraphStore {
  private db!: Database;
  private dbRO: Database | null = null;
  private dbPath: string;
  private _initialized = false;
  /** close() 之后为 true：读路径不再懒重开连接，而是抛错。 */
  private _closed = false;

  /** Connection for read queries: uses RO when available (non-blocking in WAL mode). */
  private get readDB(): Database {
    // close() 之后必须硬失败。以前 close() 只把 dbRO 置 null，这个 getter 又会
    // 懒重开一条只读连接 —— 于是"已关闭"的 store 读起来一切正常：
    // getProjectStats() 返回 {nodes:0}，调用方据此判定"图是空的"并触发全量重建，
    // 而 LRU 淘汰关掉的 fd 也会被这样悄悄开回来，上限形同失效。
    if (this._closed) {
      throw new Error(`[GraphStore] store for '${this.dbPath}' is closed`);
    }
    if (!this.dbRO) {
      try {
        const BetterSqlite3 = require('better-sqlite3');
        this.dbRO = new BetterSqlite3(this.dbPath, { readonly: true });
        this.dbRO.pragma('journal_mode = WAL');
      } catch {
        return this.db;
      }
    }
    return this.dbRO;
  }

  // ── Prepared statement cache ──────────────────────────────────────

  private _stmts: Record<string, any> = {};

  private stmt(sql: string): any {
    if (!this._stmts[sql]) {
      this._stmts[sql] = this.db.prepare(sql);
    }
    return this._stmts[sql];
  }

  private _roStmts = new Map<string, any>();
  /** Connection the cached read statements belong to. */
  private _roStmtConn: Database | null = null;

  /**
   * Every call site is a fixed template with `?` placeholders, so the real
   * population is a few dozen — a few hundred only if some future caller starts
   * building SQL per query. Dropping the whole cache at that point costs one
   * re-prepare each and keeps an MCP process that lives for days from growing a
   * statement per query it ever answered.
   */
  private static readonly RO_STMT_CACHE_MAX = 256;

  /**
   * Cached prepared statement on the read connection.
   *
   * The read path used to call prepare() per query, which a bulk index does tens
   * of thousands of times (~120ms of a 3.5s index, all of it re-parsing the same
   * dozen statements). Cache is tied to the connection object: readDB falls back
   * to the write handle if the RO open fails, and close() drops the RO one, so a
   * statement must never outlive the connection it was prepared on.
   */
  private roStmt(sql: string): any {
    const conn = this.readDB;
    if (this._roStmtConn !== conn) {
      this._roStmts.clear();
      this._roStmtConn = conn;
    }
    let st = this._roStmts.get(sql);
    if (!st) {
      if (this._roStmts.size >= SqliteGraphStore.RO_STMT_CACHE_MAX) this._roStmts.clear();
      st = conn.prepare(sql);
      this._roStmts.set(sql, st);
    }
    return st;
  }

  /**
   * @param projectDirOrPath — if a directory, DB goes to `<dir>/.context/graph/`.
   *   If it ends with `.db`, treated as a direct DB path (for tests / backward compat).
   */
  constructor(projectDirOrPath?: string) {
    if (projectDirOrPath && projectDirOrPath.endsWith('.db')) {
      this.dbPath = projectDirOrPath;
      // Ensure parent dir exists
      fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    } else {
      const dir = projectDirOrPath || process.cwd();
      this.dbPath = getGraphDbPath(dir);
    }
    const BetterSqlite3 = require('better-sqlite3');
    this.db = new BetterSqlite3(this.dbPath);
    this._ensureSchema();
    this._initialized = true;
  }

  /** Path to the underlying DB file. */
  get path(): string {
    return this.dbPath;
  }

  /**
   * Indexer/schema version stamped on the graph (via PRAGMA user_version).
   * Bump INDEXER_VERSION whenever the extractor/resolver/traversal logic changes
   * in a way that makes graphs built by an older version stale or wrong. On open,
   * a graph whose stored version differs is treated as outdated so the caller can
   * rebuild — git-diff incremental sync can't detect "the indexer itself changed".
   */
  getGraphVersion(): number {
    try {
      const row = this.readDB.pragma('user_version', { simple: true });
      return typeof row === 'number' ? row : 0;
    } catch {
      return 0;
    }
  }

  /** Stamp the graph with the indexer version that built it. */
  setGraphVersion(v: number): void {
    this.db.pragma(`user_version = ${Math.floor(v)}`);
  }

  // ── Schema ────────────────────────────────────────────────────────

  private _ensureSchema(): void {
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    // Use a larger page size and cache for better write throughput
    this.db.pragma('page_size = 4096');
    this.db.pragma('cache_size = -64000'); // 64MB
    this.db.exec(SCHEMA_SQL);
    this._ensureSuffixName();
    // Order matters: search_text has to exist on `nodes` before an FTS table can
    // index it, and both must precede the triggers — _ensureFtsIndex drops the
    // triggers along with the table it replaces.
    this._ensureSearchText();
    this._ensureFtsIndex();
    this.db.exec(FTS_TRIGGERS_SQL);
  }

  /**
   * Guarantee `nodes.suffix_name` exists, is indexed, and is filled.
   *
   * CREATE TABLE IF NOT EXISTS leaves a pre-existing table alone, so a graph
   * built before this column would keep answering suffix lookups against a
   * column that isn't there. Backfilling is cheaper than the full rebuild the
   * version stamp would otherwise force, and only dotted names need a row visit.
   */
  private _ensureSuffixName(): void {
    const cols = this.db.pragma('table_info(nodes)') as Array<{ name: string }>;
    if (!cols.some(c => c.name === 'suffix_name')) {
      this.db.exec('ALTER TABLE nodes ADD COLUMN suffix_name TEXT');
      // Undotted names are their own suffix — one set-based UPDATE covers them.
      this.db.exec("UPDATE nodes SET suffix_name = name WHERE instr(name, '.') = 0");
      const dotted = this.db
        .prepare("SELECT id, name FROM nodes WHERE instr(name, '.') > 0")
        .all() as Array<{ id: number; name: string }>;
      if (dotted.length > 0) {
        const upd = this.db.prepare('UPDATE nodes SET suffix_name = ? WHERE id = ?');
        this.db.transaction(() => {
          for (const row of dotted) upd.run(lastNameSegment(row.name), row.id);
        })();
      }
    }
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_nodes_suffix ON nodes(project, suffix_name)');
  }

  /**
   * Guarantee `nodes.search_text` exists and is filled, backfilling from the
   * names already stored rather than forcing a reindex of the whole repo.
   */
  private _ensureSearchText(): void {
    const cols = this.db.pragma('table_info(nodes)') as Array<{ name: string }>;
    if (cols.some(c => c.name === 'search_text')) return;
    this.db.exec('ALTER TABLE nodes ADD COLUMN search_text TEXT');
    const rows = this.db.prepare('SELECT id, name FROM nodes').all() as Array<{ id: number; name: string }>;
    if (rows.length === 0) return;
    const upd = this.db.prepare('UPDATE nodes SET search_text = ? WHERE id = ?');
    this.db.transaction(() => {
      for (const r of rows) upd.run(splitIdentifier(r.name), r.id);
    })();
  }

  /**
   * Guarantee nodes_fts matches NODES_FTS_SQL, recreating it if it doesn't.
   *
   * Compares against the definition SQLite stored rather than probing for one
   * known difference, because an FTS5 table's columns *and* its tokenizer are
   * both fixed at creation: a graph on disk can be stale in either way, and
   * a mismatched tokenizer is invisible — queries keep working and quietly stop
   * matching. Rebuilding reads the text back out of `nodes`, so it costs one
   * table scan and never touches the graph.
   */
  private _ensureFtsIndex(): void {
    const norm = (s: string) =>
      s.replace(/if\s+not\s+exists\s+/i, '').replace(/\s+/g, ' ').trim().toLowerCase();
    const row = this.db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'nodes_fts'")
      .get() as { sql?: string } | undefined;
    if (row?.sql && norm(row.sql) === norm(NODES_FTS_SQL.replace(/;\s*$/, ''))) return;

    this.db.exec(`
      DROP TRIGGER IF EXISTS nodes_ai;
      DROP TRIGGER IF EXISTS nodes_ad;
      DROP TRIGGER IF EXISTS nodes_au;
      DROP TABLE IF EXISTS nodes_fts;
    `);
    this.db.exec(NODES_FTS_SQL);
    this.db.exec("INSERT INTO nodes_fts(nodes_fts) VALUES('rebuild')");
  }

  initialize(): void {
    if (!this._initialized) {
      this._ensureSchema();
      this._initialized = true;
    }
  }

  close(): void {
    this._closed = true;
    // Drop the statement caches first: a cached statement holds its connection
    // alive, and reusing one after close() is a hard crash rather than an error.
    this._stmts = {};
    this._roStmts.clear();
    this._roStmtConn = null;
    if (this.db) {
      try { this.db.close(); } catch { /* ignore */ }
    }
    if (this.dbRO) {
      try { this.dbRO.close(); } catch { /* ignore */ }
      this.dbRO = null;
    }
  }

  getReadonlyDB(): Database {
    if (this._closed) {
      throw new Error(`[GraphStore] store for '${this.dbPath}' is closed`);
    }
    if (!this.dbRO) {
      const BetterSqlite3 = require('better-sqlite3');
      this.dbRO = new BetterSqlite3(this.dbPath, { readonly: true });
      this.dbRO.pragma('journal_mode = WAL');
    }
    return this.dbRO;
  }

  checkpoint(): void {
    this.db.pragma('wal_checkpoint(TRUNCATE)');
  }

  // ── Bulk-load mode ───────────────────────────────────────────────

  beginBulkLoad(): void {
    this.db.pragma('foreign_keys = OFF');
    this.db.exec(`
      DROP TRIGGER IF EXISTS nodes_ai;
      DROP TRIGGER IF EXISTS nodes_ad;
      DROP TRIGGER IF EXISTS nodes_au;
    `);
  }

  endBulkLoad(): void {
    // Rebuild FTS index from the content table. FTS5 'rebuild' command
    // repopulates from nodes columns exactly as they are stored.
    // CamelCase matching is handled by the LIKE fallback in findNodes.
    this.db.exec(`INSERT INTO nodes_fts(nodes_fts) VALUES('rebuild')`);
    this.db.exec(FTS_TRIGGERS_SQL);
    this.db.pragma('foreign_keys = ON');
  }

  // ── Node operations ───────────────────────────────────────────────

  /**
   * 插入或更新一个节点，返回**该节点**的 id。
   *
   * 必须用 `RETURNING id` 而不是 `lastInsertRowid`：`ON CONFLICT DO UPDATE` 走 UPDATE
   * 分支时 SQLite 不更新 lastInsertRowid，拿到的是这条连接上*上一次成功插入*的 id ——
   * 于是调用方把边挂到别的节点上。实测（sqlite 3.49.2）：插 A(id=1)、插 B(id=2)、再
   * upsert A，lastInsertRowid 报 2，而 A 的真实 id 是 1。
   *
   * 目前索引主路径撞不到 UPDATE 分支（全量重建先清表，增量按文件删完再插，且 buffer
   * 先按 qualifiedName 去重 —— PhiLog 全量 5328 次 upsert / 增量 107 次，实测 0 次冲突），
   * 但 `createADR` 同标题重复调用就直接走这条分支。留着就是等某次去重逻辑变动引爆。
   */
  upsertNode(node: Omit<GraphNode, 'id'>): number {
    const result = this.stmt(`
      INSERT INTO nodes (project, kind, name, suffix_name, search_text, qualified_name, file_path,
        language, start_line, end_line,
        signature, visibility, is_exported, is_async, is_static, is_abstract,
        decorators_json, type_parameters_json, return_type, docstring,
        properties_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project, qualified_name) DO UPDATE SET
        kind = excluded.kind, name = excluded.name,
        suffix_name = excluded.suffix_name, search_text = excluded.search_text,
        file_path = excluded.file_path, language = excluded.language,
        start_line = excluded.start_line, end_line = excluded.end_line,
        signature = excluded.signature, visibility = excluded.visibility,
        is_exported = excluded.is_exported, is_async = excluded.is_async,
        is_static = excluded.is_static, is_abstract = excluded.is_abstract,
        decorators_json = excluded.decorators_json,
        type_parameters_json = excluded.type_parameters_json,
        return_type = excluded.return_type, docstring = excluded.docstring,
        properties_json = excluded.properties_json, updated_at = excluded.updated_at
      RETURNING id
    `).get(
      node.project,
      node.kind || node.label,
      node.name,
      lastNameSegment(node.name),
      splitIdentifier(node.name),
      node.qualifiedName,
      node.filePath,
      node.language || null,
      node.startLine,
      node.endLine,
      node.signature || null,
      node.visibility || null,
      node.isExported ? 1 : 0,
      node.isAsync ? 1 : 0,
      node.isStatic ? 1 : 0,
      node.isAbstract ? 1 : 0,
      node.decorators ? JSON.stringify(node.decorators) : null,
      node.typeParameters ? JSON.stringify(node.typeParameters) : null,
      node.returnType || null,
      node.docstring || null,
      JSON.stringify(node.properties || {}),
      node.updatedAt || Date.now(),
    ) as { id: number } | undefined;
    if (!result) throw new Error(`upsertNode returned no row for ${node.qualifiedName}`);
    return Number(result.id);
  }

  getNodeById(id: number): GraphNode | null {
    const row = this.roStmt('SELECT * FROM nodes WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToNode(row) : null;
  }

  getNodesById(ids: number[]): Map<number, GraphNode> {
    const result = new Map<number, GraphNode>();
    if (ids.length === 0) return result;
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.roStmt(
      `SELECT * FROM nodes WHERE id IN (${placeholders})`
    ).all(...ids) as Array<Record<string, unknown>>;
    for (const row of rows) {
      const node = this.rowToNode(row);
      result.set(node.id, node);
    }
    return result;
  }

  getNodeByQN(project: string, qualifiedName: string): GraphNode | null {
    const row = this.roStmt(
      'SELECT * FROM nodes WHERE project = ? AND qualified_name = ?'
    ).get(project, qualifiedName) as Record<string, unknown> | undefined;
    return row ? this.rowToNode(row) : null;
  }

  getNodesByFile(project: string, filePath: string): GraphNode[] {
    const rows = this.roStmt(
      'SELECT * FROM nodes WHERE project = ? AND file_path = ?'
    ).all(project, filePath) as Array<Record<string, unknown>>;
    return rows.map(r => this.rowToNode(r));
  }

  getNodesByName(project: string, name: string): GraphNode[] {
    const rows = this.roStmt(
      'SELECT * FROM nodes WHERE project = ? AND name = ?'
    ).all(project, name) as Array<Record<string, unknown>>;
    return rows.map(r => this.rowToNode(r));
  }

  /**
   * Suffix-aware name lookup. Matches both exact name AND names ending
   * with `.<name>` (e.g. "getNodesById" matches "SqliteGraphStore.getNodesById").
   * Uses a UNION of two indexed lookups — no full-table scan.
   */
  /**
   * Nodes named `name`, plus nodes whose name ends in `.name` (`Widget.render`
   * for a `render` call). Index seek on suffix_name — see the column comment
   * for why the obvious `LIKE '%.' || ?` had to go.
   */
  getNodesBySuffix(project: string, name: string): GraphNode[] {
    const rows = this.roStmt(`
      SELECT * FROM nodes WHERE project = ? AND name = ?
      UNION ALL
      SELECT * FROM nodes
        WHERE project = ? AND suffix_name = ? AND name <> ?
    `).all(project, name, project, name, name) as Array<Record<string, unknown>>;
    return rows.map(r => this.rowToNode(r));
  }

  getNodesByLowerName(project: string, lowerName: string): GraphNode[] {
    const rows = this.roStmt(
      'SELECT * FROM nodes WHERE project = ? AND LOWER(name) = ?'
    ).all(project, lowerName) as Array<Record<string, unknown>>;
    return rows.map(r => this.rowToNode(r));
  }

  getNodesByQualifiedNameExact(project: string, qn: string): GraphNode[] {
    const rows = this.roStmt(
      'SELECT * FROM nodes WHERE project = ? AND qualified_name = ?'
    ).all(project, qn) as Array<Record<string, unknown>>;
    return rows.map(r => this.rowToNode(r));
  }

  getNodesByKind(project: string, kind: GraphNodeKind): GraphNode[] {
    const rows = this.roStmt(
      'SELECT * FROM nodes WHERE project = ? AND kind = ?'
    ).all(project, kind) as Array<Record<string, unknown>>;
    return rows.map(r => this.rowToNode(r));
  }

  /** Streaming iterator — avoids materializing a giant array for whole-kind scans. */
  iterateNodesByKind(project: string, kind: GraphNodeKind): Iterable<GraphNode> {
    const stmt = this.roStmt('SELECT * FROM nodes WHERE project = ? AND kind = ?');
    return {
      [Symbol.iterator]: () => {
        const iter = stmt.iterate(project, kind);
        return {
          next: (): IteratorResult<GraphNode> => {
            const { value, done } = iter.next();
            return done ? { value: undefined as any, done: true } : { value: this.rowToNode(value as Record<string, unknown>), done: false };
          },
        };
      },
    };
  }

  updateNode(node: GraphNode): void {
    this.stmt(`
      UPDATE nodes SET
        kind = ?, name = ?, qualified_name = ?, file_path = ?,
        language = ?, start_line = ?, end_line = ?,
        signature = ?, visibility = ?, is_exported = ?, is_async = ?,
        is_static = ?, is_abstract = ?, docstring = ?,
        properties_json = ?, updated_at = ?
      WHERE id = ?
    `).run(
      node.kind, node.name, node.qualifiedName, node.filePath,
      node.language || null, node.startLine, node.endLine,
      node.signature || null, node.visibility || null,
      node.isExported ? 1 : 0, node.isAsync ? 1 : 0,
      node.isStatic ? 1 : 0, node.isAbstract ? 1 : 0,
      node.docstring || null,
      JSON.stringify(node.properties || {}), Date.now(),
      node.id,
    );
  }

  getNodesByIds(ids: number[]): Map<number, GraphNode> {
    return this.getNodesById(ids);
  }

  // ── Node search ───────────────────────────────────────────────────

  /**
   * 成员 id → 它的类/结构体宿主。file 与 namespace 宿主不算：那是"在哪个文件里"，
   * 不是"属于哪个东西"，而且 module 本身就在 RESULT_NOISE_KINDS 里。
   */
  private lookupContainerParents(memberIds: number[]): Map<number, Record<string, unknown>> {
    const out = new Map<number, Record<string, unknown>>();
    if (memberIds.length === 0) return out;
    try {
      const ph = memberIds.map(() => '?').join(',');
      const rows = this.readDB.prepare(
        `SELECT e.target_id AS member_ref, p.* FROM edges e JOIN nodes p ON p.id = e.source_id
         WHERE e.kind = 'contains' AND e.target_id IN (${ph})
           AND p.kind IN ('class', 'struct', 'interface', 'trait', 'object')`
      ).all(...memberIds) as Array<Record<string, unknown>>;
      for (const row of rows) {
        const member = Number(row.member_ref);
        if (out.has(member)) continue;
        const { member_ref, ...node } = row;
        out.set(member, node);
      }
    } catch { /* 没有 contains 边就不提升 */ }
    return out;
  }

  findNodes(options: GraphSearchOptions): GraphSearchResponse {
    const { conditions, params } = this.buildFindConditions(options);
    const whereClause = conditions.length > 0 ? conditions.join(' AND ') : '1=1';
    const limit = options.limit ?? 200;
    const offset = options.offset ?? 0;

    const rdb = this.readDB;

    if (options.query && options.query.trim().length > 0) {
      const ftsQuery = this.buildFtsQuery(options.query);
      const seenIds = new Set<number>();
      const allRows: Array<Record<string, unknown>> = [];

      // Pass 0: EXACT-name match. A query that is itself a symbol name ("toJson",
      // "dispatch_request") should rank the node literally named that above any
      // fuzzy/substring hit ("toString", "ToNumberStrategy"). FTS tokenizes and
      // stems, so it can't express "this exact name". Exact hits get the top score.
      const exactName = options.query.trim();
      if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(exactName)) {
        try {
          // Match the bare name OR the trailing segment of a qualified name —
          // extractors store method names qualified ("Gson.toJson"), so a query
          // for "toJson" must hit name="Gson.toJson" via suffix match, not just
          // name="toJson". Both bare and qualified-suffix forms are covered.
          const exactRows = rdb.prepare(
            `SELECT n.*, 1000.0 AS score FROM nodes n
             WHERE (n.name = ? OR n.qualified_name = ? OR n.name LIKE ? OR n.qualified_name LIKE ?) AND ${whereClause}
             ORDER BY n.kind LIMIT ?`
          ).all(exactName, exactName, `%.${exactName}`, `%.${exactName}`, ...params, limit) as Array<Record<string, unknown>>;
          for (const row of exactRows) {
            if (!seenIds.has(row.id as number)) {
              seenIds.add(row.id as number);
              allRows.push(row);
            }
          }
        } catch {
          // exact match failed — continue to FTS
        }
      }

      // First pass: FTS (BM25 ranked). bm25() returns negative values
      // (closer to 0 = better), so we use -bm25() for a positive descending score.
      //
      // Weights (name, search_text, qualified_name, file_path): a hit on the
      // symbol's own name is what the caller asked for; a hit on the path only
      // says "somewhere in this directory". qualified_name is deliberately the
      // lowest — it is project + path + name concatenated, so weighting it would
      // count every name and path match a second time. Under the old
      // (1.0, 2.0, 0.5) split a path match scored 2.5 against a name match's 3.0,
      // which is how "how is a proxy created for a service handle" filled its top
      // ten with diag-api's Handle*Message functions and never returned
      // ProxyFactory::CreateProxy at all.
      try {
        const ftsRows = rdb.prepare(`
          SELECT n.*, -bm25(nodes_fts, 3.0, 3.0, 0.5, 1.0) AS score
          FROM nodes n JOIN nodes_fts fts ON n.id = fts.rowid
          WHERE nodes_fts MATCH ? AND ${whereClause}
          ORDER BY score DESC LIMIT ?
        `).all(ftsQuery, ...params, ftsCandidateLimit(limit)) as Array<Record<string, unknown>>;
        // 名字覆盖率加权只在 FTS 段内重排：allRows 是按段拼起来的（exact=1000 →
        // FTS → LIKE=0.1 → prefix=0.05），四段量纲不同，跨段重排会废掉分层。
        boostNameCoverage(ftsRows, options.query);
        ftsRows.sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0));
        for (const row of ftsRows) {
          if (!seenIds.has(row.id as number)) {
            seenIds.add(row.id as number);
            allRows.push(row);
          }
        }
        // No COUNT(*) companion here on purpose. The reported total is the
        // number of merged, de-noised rows (see mergedCount below), so the count
        // this used to run was written and never read — and once the noise kinds
        // moved into the WHERE clause it stopped being free: counting every one
        // of 8,770 FTS matches against nodes took 1,235ms of a 1,285ms search,
        // where fetching the top 20 takes 5ms.
      } catch {
        // FTS failed — skip
      }

      // Second pass: LIKE substring (supplements, not replaces, FTS).
      // For short queries (≤3 meaningful words) use OR semantics; for longer
      // ones require a majority match. See QUERY_NOISE_WORDS.
      const words = meaningfulQueryTokens(options.query || '');
      if (words.length > 0) {
        const useOr = words.length <= 3;
        const likeParams = words.flatMap((t: string) => [`%${t}%`, `%${t}%`]);
        const { conditions: baseConds, params: baseParams } = this.buildFindConditions(options);
        let whereSQL: string;
        let allP: unknown[];

        if (useOr) {
          const likeConds = words.map(() => '(n.name LIKE ? OR n.qualified_name LIKE ?)');
          const allConds = [...baseConds, ...likeConds.map(c => `(${c})`),
            `(n.kind IN ('function','method','class'))`];
          allP = [...baseParams, ...likeParams];
          whereSQL = allConds.join(' AND ');
        } else {
          const minMatch = Math.ceil(words.length / 2);
          const likeExprs = words.map(() => `(CASE WHEN n.name LIKE ? OR n.qualified_name LIKE ? THEN 1 ELSE 0 END)`);
          const allConds = [...baseConds,
            `(n.kind IN ('function','method','class'))`,
            `(${likeExprs.join(' + ')}) >= ${minMatch}`];
          allP = [...baseParams, ...likeParams];
          whereSQL = allConds.filter(c => c).join(' AND ');
        }

        try {
          const likeRows = rdb.prepare(
            `SELECT n.*, 0.1 AS score FROM nodes n WHERE ${whereSQL} ORDER BY n.name LIMIT ?`
          ).all(...allP, limit * 2) as Array<Record<string, unknown>>;
          for (const row of likeRows) {
            if (!seenIds.has(row.id as number)) {
              seenIds.add(row.id as number);
              allRows.push(row);
            }
          }
        } catch {
          // LIKE failed — skip
        }
      }

      // Third pass (last resort): prefix matching for words that were too
      // long to match anything. "passwords" → %pass% → matches "hashPassword".
      // Only runs when the first LIKE pass returned nothing and we have words > 4 chars.
      if (allRows.length === 0 && words.filter(w => w.length > 4).length > 0) {
        const longWords = words.filter(w => w.length > 4);
        const shortWords = words.filter(w => w.length <= 4);
        // For long words, use min-4-char prefix
        const prefixParams: string[] = [];
        const prefixConds: string[] = [];
        for (const w of longWords) {
          const prefix = w.slice(0, Math.max(4, Math.floor(w.length * 0.6)));
          prefixConds.push('(n.name LIKE ? OR n.qualified_name LIKE ?)');
          prefixParams.push(`%${prefix}%`, `%${prefix}%`);
        }
        // For short words, keep exact match
        for (const w of shortWords) {
          prefixConds.push('(n.name LIKE ? OR n.qualified_name LIKE ?)');
          prefixParams.push(`%${w}%`, `%${w}%`);
        }
        const { conditions: baseConds3, params: baseParams3 } = this.buildFindConditions(options);
        // OR between prefix groups, NOT AND — "how" should not block "passwords" match
        const prefixOrCond = prefixConds.map(c => `(${c})`).join(' OR ');
        const allConds3 = [...baseConds3, `(${prefixOrCond})`,
          `(n.kind IN ('function','method','class'))`];
        const allP3 = [...baseParams3, ...prefixParams];
        const whereSQL3 = allConds3.join(' AND ');
        try {
          const prefixRows = rdb.prepare(
            `SELECT n.*, 0.05 AS score FROM nodes n WHERE ${whereSQL3} ORDER BY n.name LIMIT ?`
          ).all(...allP3, limit * 2) as Array<Record<string, unknown>>;
          for (const row of prefixRows) {
            if (!seenIds.has(row.id as number)) {
              seenIds.add(row.id as number);
              allRows.push(row);
            }
          }
        } catch { /* skip */ }
      }

      // Apply offset/limit after merging, excluding noise kinds
      const filtered = allRows.filter(row =>
        !RESULT_NOISE_KINDS.has(row.kind as string) && !RESULT_NOISE_KINDS.has(row.label as string)
      );
      const demoted = demoteRows(filtered, options.vendorSegments, options.vendorPenalty, options.testPenalty);
      const start = offset || 0;
      const ranked = reserveDemotedSlots(
        hoistParentContainers(
          capPerName(diversifyByConcept(demoted, options.query || '', limit), limit),
          limit,
          (memberIds) => this.lookupContainerParents(memberIds),
        ),
        limit,
      );
      const sliced = ranked.slice(start, start + limit);
      const mergedCount = { total: filtered.length };
      return this.buildNodeResults(sliced, mergedCount, options, offset);
    } else {
      const query = `
        SELECT n.*, 0 AS score
        FROM nodes n
        WHERE ${whereClause}
        ORDER BY n.name
        LIMIT ? OFFSET ?
      `;
      const countQuery = `
        SELECT COUNT(*) as total
        FROM nodes n
        WHERE ${whereClause}
      `;
      const rows = rdb.prepare(query).all(...params, limit, offset) as Array<Record<string, unknown>>;
      const countRow = rdb.prepare(countQuery).get(...params) as { total: number };
      return this.buildNodeResults(rows, countRow, options, offset);
    }
  }

  private buildFindConditions(options: GraphSearchOptions): { conditions: string[]; params: unknown[] } {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (options.project) {
      conditions.push('n.project = ?');
      params.push(options.project);
    }
    const kind = options.kind || options.label;
    if (kind) {
      conditions.push('n.kind = ?');
      params.push(kind);
    } else {
      /*
       * Drop noise kinds in SQL, not after the fact.
       *
       * Every pass ends in LIMIT, and the post-query filter used to run on what
       * came back — so on a C++ repo, where most of the top-ranked FTS rows are
       * variables and parameters, a limit of 10 fetched 20 rows, threw away 12 of
       * them, and returned 8: the functions ranked 21st onward were never
       * fetched. "supervised entity health monitoring recovery action" returned 9
       * rows and CreateSupervisedEntity was not among them. An explicit
       * options.kind means the caller asked for that kind — even a noisy one — so
       * the exclusion only applies when they didn't.
       */
      conditions.push(
        `n.kind NOT IN (${[...RESULT_NOISE_KINDS].map(() => '?').join(', ')})`,
      );
      params.push(...RESULT_NOISE_KINDS);
      // JS/TS constructors are methods named `<Class>.constructor`; C++ ones are
      // caught by the kind list above.
      conditions.push(`NOT (n.kind = 'method' AND n.name LIKE '%.constructor')`);
    }
    if (options.namePattern) {
      conditions.push('n.name LIKE ?');
      params.push(this.regexToLike(options.namePattern));
    }
    if (options.qnPattern) {
      conditions.push('n.qualified_name LIKE ?');
      params.push(this.regexToLike(options.qnPattern));
    }
    if (options.filePattern) {
      conditions.push('n.file_path LIKE ?');
      params.push(this.regexToLike(options.filePattern));
    }
    if (options.exactFilePath) {
      conditions.push('n.file_path = ?');
      params.push(options.exactFilePath);
    }

    return { conditions, params };
  }

  private buildNodeResults(
    rows: Array<Record<string, unknown>>,
    countRow: { total: number },
    options: GraphSearchOptions,
    offset: number,
  ): GraphSearchResponse {
    const filteredRows = rows.filter(row => {
      const k = (row.kind || row.label) as string;
      const name = (row.name as string) || '';
      // Exclude by kind — see RESULT_NOISE_KINDS
      if (RESULT_NOISE_KINDS.has(k)) return false;
      // Exclude constructor methods
      if (k === 'method' && name.endsWith('.constructor')) return false;
      return true;
    });

    const results: GraphSearchResult[] = [];
    const nodeIds = filteredRows.map(row => row.id as number);
    const degreeMap = this.getNodeDegreesBatch(nodeIds);

    for (const row of filteredRows) {
      const node = this.rowToNode(row);
      const { inDegree, outDegree } = degreeMap.get(node.id) || { inDegree: 0, outDegree: 0 };

      if (options.minDegree !== undefined && (inDegree + outDegree) < options.minDegree) continue;
      if (options.maxDegree !== undefined && (inDegree + outDegree) > options.maxDegree) continue;

      results.push({
        node,
        score: (row.score as number) ?? 0,
        inDegree,
        outDegree,
      });
    }

    // 这里**不再重排**。入参顺序已经是最终顺序：查询路径是"多趟合并(exact→FTS→LIKE
    // →prefix) → demoteRows 分层 → diversifyByConcept"，非查询路径是 SQL 的
    // ORDER BY name。按 score 全局重排会把这两件事一起打碎 —— 四趟的分数量纲互不
    // 可比（1000 / -bm25 / 0.1 / 0.05），而 demoteRows 的"降权后排到本仓库代码之后"
    // 是分层保证，不是分数保证：vendored 行 bm25 30×0.35=10.5 一重排就又压过自有
    // 代码的 8。测试降权同样只留 demoteRows 那一处（乘 0.55，且 tests:true 时系数 0
    // 就是真的关掉）；原来这里额外减 100，等于 tests:true 说了也不算。
    const hasDegreeFilter = options.minDegree !== undefined || options.maxDegree !== undefined;
    const effectiveTotal = hasDegreeFilter ? results.length : countRow.total;

    return {
      results,
      total: effectiveTotal,
      hasMore: offset + results.length < effectiveTotal,
    };
  }

  getNodeDegree(nodeId: number): { inDegree: number; outDegree: number } {
    const inRow = this.roStmt(`SELECT COUNT(*) as cnt FROM edges WHERE target_id = ? AND kind NOT IN (${STRUCTURAL_EDGE_PLACEHOLDERS})`)
      .get(nodeId, ...STRUCTURAL_EDGE_KINDS) as { cnt: number };
    const outRow = this.roStmt(`SELECT COUNT(*) as cnt FROM edges WHERE source_id = ? AND kind NOT IN (${STRUCTURAL_EDGE_PLACEHOLDERS})`)
      .get(nodeId, ...STRUCTURAL_EDGE_KINDS) as { cnt: number };
    return { inDegree: inRow.cnt, outDegree: outRow.cnt };
  }

  /**
   * 出入度**只数使用关系**（calls/references/instantiates/extends/…），不数
   * contains/imports/exports。
   *
   * 每个节点都被它的 file/class 用一条 contains 边指着，所以带上结构边时 `inDegree`
   * 恒 ≥1 —— search 输出里的 `↖1` 看着像"有一个调用者"，实测（ap-client-api /
   * PhiLog）绝大多数是纯 contains，真实调用者 0 个；"↖0 = 死代码"这个信号因此从来
   * 不成立。入口点判定（architecture.findEntryPoints 的 out - in*2）同样被压死：
   * 一个没人调、调了 2 个函数的真入口算出 2-2=0，直接被过滤掉。
   */
  getNodeDegreesBatch(nodeIds: number[]): Map<number, { inDegree: number; outDegree: number }> {
    const degreeMap = new Map<number, { inDegree: number; outDegree: number }>();
    if (nodeIds.length === 0) return degreeMap;

    for (const id of nodeIds) degreeMap.set(id, { inDegree: 0, outDegree: 0 });

    const placeholders = nodeIds.map(() => '?').join(',');
    const rows = this.roStmt(`
      SELECT target_id as id, COUNT(*) as in_deg, 0 as out_deg FROM edges
      WHERE target_id IN (${placeholders}) AND kind NOT IN (${STRUCTURAL_EDGE_PLACEHOLDERS})
      GROUP BY target_id
      UNION ALL
      SELECT source_id as id, 0 as in_deg, COUNT(*) as out_deg FROM edges
      WHERE source_id IN (${placeholders}) AND kind NOT IN (${STRUCTURAL_EDGE_PLACEHOLDERS})
      GROUP BY source_id
    `).all(...nodeIds, ...STRUCTURAL_EDGE_KINDS, ...nodeIds, ...STRUCTURAL_EDGE_KINDS) as Array<{ id: number; in_deg: number; out_deg: number }>;

    for (const row of rows) {
      const entry = degreeMap.get(row.id);
      if (entry) {
        entry.inDegree += row.in_deg;
        entry.outDegree += row.out_deg;
      }
    }
    return degreeMap;
  }

  // ── Edge operations ───────────────────────────────────────────────

  upsertEdge(edge: Omit<GraphEdge, 'id'>): number {
    const kind = edge.kind || edge.type;
    const line = edge.line ?? -1;
    const col = edge.column ?? -1;
    const result = this.stmt(`
      INSERT OR IGNORE INTO edges (project, source_id, target_id, kind, line, col, provenance, metadata_json, properties_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      edge.project,
      edge.sourceId,
      edge.targetId,
      kind,
      line,
      col,
      edge.provenance ?? 'tree-sitter',
      edge.metadata ? JSON.stringify(edge.metadata) : null,
      JSON.stringify(edge.properties || {}),
    );
    if (result.changes > 0) return Number(result.lastInsertRowid);
    // On conflict, return existing ID (line/col now have -1 defaults)
    const existing = this.roStmt(
      'SELECT id FROM edges WHERE source_id = ? AND target_id = ? AND kind = ? AND line = ? AND col = ?'
    ).get(edge.sourceId, edge.targetId, kind, line, col) as { id: number } | undefined;
    return existing ? existing.id : 0;
  }

  getEdgesBySource(sourceId: number, kind?: GraphEdgeKind): GraphEdge[] {
    let sql = 'SELECT * FROM edges WHERE source_id = ?';
    const params: unknown[] = [sourceId];
    if (kind) { sql += ' AND kind = ?'; params.push(kind); }
    const rows = this.roStmt(sql).all(...params) as Array<Record<string, unknown>>;
    return rows.map(r => this.rowToEdge(r));
  }

  getEdgesBySourceKinds(sourceId: number, kinds?: GraphEdgeKind[]): GraphEdge[] {
    if (!kinds || kinds.length === 0) {
      return this.getEdgesBySource(sourceId);
    }
    const placeholders = kinds.map(() => '?').join(',');
    const sql = `SELECT * FROM edges WHERE source_id = ? AND kind IN (${placeholders})`;
    const rows = this.roStmt(sql).all(sourceId, ...kinds) as Array<Record<string, unknown>>;
    return rows.map(r => this.rowToEdge(r));
  }

  getEdgesByTargetKinds(targetId: number, kinds?: GraphEdgeKind[]): GraphEdge[] {
    if (!kinds || kinds.length === 0) {
      return this.getEdgesByTarget(targetId);
    }
    const placeholders = kinds.map(() => '?').join(',');
    const sql = `SELECT * FROM edges WHERE target_id = ? AND kind IN (${placeholders})`;
    const rows = this.roStmt(sql).all(targetId, ...kinds) as Array<Record<string, unknown>>;
    return rows.map(r => this.rowToEdge(r));
  }

  getEdgesBySourceBatch(sourceIds: number[], kind?: GraphEdgeKind): Map<number, GraphEdge[]> {
    const resultMap = new Map<number, GraphEdge[]>();
    if (sourceIds.length === 0) return resultMap;
    for (const id of sourceIds) resultMap.set(id, []);

    const placeholders = sourceIds.map(() => '?').join(',');
    let sql = `SELECT * FROM edges WHERE source_id IN (${placeholders})`;
    const params: unknown[] = [...sourceIds];
    if (kind) { sql += ' AND kind = ?'; params.push(kind); }
    const rows = this.roStmt(sql).all(...params) as Array<Record<string, unknown>>;
    for (const row of rows) {
      const edge = this.rowToEdge(row);
      resultMap.get(edge.sourceId)?.push(edge);
    }
    return resultMap;
  }

  getEdgesByTarget(targetId: number, kind?: GraphEdgeKind): GraphEdge[] {
    let sql = 'SELECT * FROM edges WHERE target_id = ?';
    const params: unknown[] = [targetId];
    if (kind) { sql += ' AND kind = ?'; params.push(kind); }
    const rows = this.roStmt(sql).all(...params) as Array<Record<string, unknown>>;
    return rows.map(r => this.rowToEdge(r));
  }

  getEdgesByTargetBatch(targetIds: number[], kind?: GraphEdgeKind): Map<number, GraphEdge[]> {
    const resultMap = new Map<number, GraphEdge[]>();
    if (targetIds.length === 0) return resultMap;
    for (const id of targetIds) resultMap.set(id, []);

    const placeholders = targetIds.map(() => '?').join(',');
    let sql = `SELECT * FROM edges WHERE target_id IN (${placeholders})`;
    const params: unknown[] = [...targetIds];
    if (kind) { sql += ' AND kind = ?'; params.push(kind); }
    const rows = this.roStmt(sql).all(...params) as Array<Record<string, unknown>>;
    for (const row of rows) {
      const edge = this.rowToEdge(row);
      resultMap.get(edge.targetId)?.push(edge);
    }
    return resultMap;
  }

  findEdges(project: string, kinds?: GraphEdgeKind[], limit?: number): GraphEdge[] {
    const conditions: string[] = ['e.project = ?'];
    const params: unknown[] = [project];
    if (kinds && kinds.length > 0) {
      conditions.push(`e.kind IN (${kinds.map(() => '?').join(',')})`);
      params.push(...kinds);
    }
    const sql = `SELECT * FROM edges e WHERE ${conditions.join(' AND ')} LIMIT ?`;
    params.push(limit ?? 1000);
    const rows = this.roStmt(sql).all(...params) as Array<Record<string, unknown>>;
    return rows.map(r => this.rowToEdge(r));
  }

  insertEdges(edges: GraphEdge[]): void {
    const stmt = this.stmt(`
      INSERT OR IGNORE INTO edges (project, source_id, target_id, kind, line, col, provenance, metadata_json, properties_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const edge of edges) {
      stmt.run(
        edge.project,
        edge.sourceId,
        edge.targetId,
        edge.kind || edge.type,
        edge.line ?? null,
        edge.column ?? null,
        edge.provenance ?? 'tree-sitter',
        edge.metadata ? JSON.stringify(edge.metadata) : null,
        JSON.stringify(edge.properties || {}),
      );
    }
  }

  // ── Unresolved reference operations ────────────────────────────────

  getUnresolvedRefsCount(project: string): number {
    const row = this.roStmt(
      "SELECT COUNT(*) as cnt FROM unresolved_refs WHERE project = ? AND status = 'pending'"
    ).get(project) as { cnt: number };
    return row.cnt;
  }

  getUnresolvedRefsBatch(project: string, limit: number, afterRowId?: number): UnresolvedReference[] {
    let sql = "SELECT * FROM unresolved_refs WHERE project = ? AND status = 'pending'";
    const params: unknown[] = [project];
    if (afterRowId != null) {
      sql += ' AND id > ?';
      params.push(afterRowId);
    }
    sql += ' ORDER BY id LIMIT ?';
    params.push(limit);
    const rows = this.roStmt(sql).all(...params) as Array<Record<string, unknown>>;
    return rows.map(r => ({
      fromNodeId: r.from_node_id as number,
      referenceName: r.reference_name as string,
      referenceKind: r.reference_kind as GraphEdgeKind,
      line: r.line as number,
      column: r.col as number,
      filePath: r.file_path as string | undefined,
      language: r.language as GraphLanguage | undefined,
      rowId: r.id as number,
    }));
  }

  insertUnresolvedRefs(project: string, refs: UnresolvedReference[]): void {
    const stmt = this.stmt(`
      INSERT INTO unresolved_refs (project, from_node_id, reference_name, reference_kind, line, col, file_path, language, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')
    `);
    for (const ref of refs) {
      stmt.run(
        project,
        ref.fromNodeId,
        ref.referenceName,
        ref.referenceKind,
        ref.line,
        ref.column,
        ref.filePath || null,
        ref.language || null,
      );
    }
  }

  deleteResolvedRefsByRowIds(rowIds: number[]): number {
    if (rowIds.length === 0) return 0;
    const placeholders = rowIds.map(() => '?').join(',');
    return this.db.prepare(`DELETE FROM unresolved_refs WHERE id IN (${placeholders})`).run(...rowIds).changes;
  }

  markRefsFailedByRowIds(rows: Array<{ rowId: number; referenceName: string }> | number[]): number {
    if (rows.length === 0) return 0;
    const ids: number[] = typeof rows[0] === 'number'
      ? (rows as number[])
      : (rows as Array<{ rowId: number; referenceName: string }>).map(r => r.rowId);
    const placeholders = ids.map(() => '?').join(',');
    return this.db.prepare(`UPDATE unresolved_refs SET status = 'failed' WHERE id IN (${placeholders})`).run(...ids).changes;
  }

  deleteReferencesByRowIds(rowIds: number[]): number {
    return this.deleteResolvedRefsByRowIds(rowIds);
  }

  deleteSpecificResolvedReferences(keys: Array<{ fromNodeId: number; referenceName: string; referenceKind: string }>): number {
    if (keys.length === 0) return 0;
    const stmt = this.db.prepare(
      "DELETE FROM unresolved_refs WHERE from_node_id = ? AND reference_name = ? AND reference_kind = ? AND status = 'pending'"
    );
    let total = 0;
    for (const key of keys) {
      total += stmt.run(key.fromNodeId, key.referenceName, key.referenceKind).changes;
    }
    return total;
  }

  markReferencesFailed(keys: Array<{ fromNodeId: number; referenceName: string; referenceKind: string }>): number {
    if (keys.length === 0) return 0;
    const stmt = this.db.prepare(
      "UPDATE unresolved_refs SET status = 'failed' WHERE from_node_id = ? AND reference_name = ? AND reference_kind = ? AND status = 'pending'"
    );
    let total = 0;
    for (const key of keys) {
      total += stmt.run(key.fromNodeId, key.referenceName, key.referenceKind).changes;
    }
    return total;
  }

  markReferencesFailedByRowIds(rows: Array<{ rowId: number; referenceName: string }> | number[]): number {
    return this.markRefsFailedByRowIds(rows);
  }

  /**
   * Reset failed refs back to pending so a later pass can retry them.
   * Used by incremental sync: refs that failed in a prior full index (target
   * file not yet parsed, or target added later) become resolvable once the
   * target file is (re)indexed. Returns how many refs were re-armed.
   */
  resetFailedRefs(project: string): number {
    return this.db.prepare(
      "UPDATE unresolved_refs SET status = 'pending' WHERE project = ? AND status = 'failed'"
    ).run(project).changes;
  }

  // ── File-level operations ─────────────────────────────────────────

  deleteNodesByFile(project: string, filePath: string): void {
    // Re-arm cross-file CALLS refs that point INTO this file BEFORE deleting.
    // The resolved ref rows for these edges were consumed long ago; if we just
    // cascade-delete the edges, the callers (in OTHER files) permanently lose
    // their CALLS edges into this file because there's no pending ref left to
    // re-resolve after re-indexing. Recreate them as pending refs keyed on the
    // caller (source) node, which survives the delete.
    this.db.prepare(`
      INSERT INTO unresolved_refs (project, from_node_id, reference_name, reference_kind, line, col, file_path, language, status)
      SELECT e.project, e.source_id, tn.name, e.kind, e.line, e.col, sn.file_path, sn.language, 'pending'
      FROM edges e
      JOIN nodes tn ON tn.id = e.target_id AND tn.project = e.project AND tn.file_path = ?
      JOIN nodes sn ON sn.id = e.source_id AND sn.project = e.project
      WHERE e.project = ? AND e.kind = 'calls' AND sn.file_path != ?
    `).run(filePath, project, filePath);

    // Delete edges + unresolved refs first (cascade manually since FK is off during bulk load)
    this.db.prepare(`
      DELETE FROM edges WHERE project = ? AND (
        source_id IN (SELECT id FROM nodes WHERE project = ? AND file_path = ?)
        OR target_id IN (SELECT id FROM nodes WHERE project = ? AND file_path = ?)
      )
    `).run(project, project, filePath, project, filePath);
    this.db.prepare(`
      DELETE FROM unresolved_refs WHERE project = ? AND
        from_node_id IN (SELECT id FROM nodes WHERE project = ? AND file_path = ?)
    `).run(project, project, filePath);
    this.db.prepare('DELETE FROM nodes WHERE project = ? AND file_path = ?').run(project, filePath);
  }

  // ── Project operations ────────────────────────────────────────────

  listProjects(): string[] {
    const rows = this.roStmt('SELECT DISTINCT project FROM nodes ORDER BY project').all() as Array<{ project: string }>;
    return rows.map(r => r.project);
  }

  getProjectStats(project: string): { nodes: number; edges: number } {
    const nodeRow = this.roStmt('SELECT COUNT(*) as cnt FROM nodes WHERE project = ?').get(project) as { cnt: number };
    const edgeRow = this.roStmt('SELECT COUNT(*) as cnt FROM edges WHERE project = ?').get(project) as { cnt: number };
    return { nodes: nodeRow.cnt, edges: edgeRow.cnt };
  }

  deleteProject(project: string): void {
    this.db.prepare('DELETE FROM edges WHERE project = ?').run(project);
    this.db.prepare('DELETE FROM unresolved_refs WHERE project = ?').run(project);
    this.db.prepare('DELETE FROM nodes WHERE project = ?').run(project);
  }

  /**
   * 清掉不属于 `keep` 的 identity。
   *
   * 一个 db 文件绑一个仓库目录，同一时刻只服务一个 identity。但 identity 会变：
   * remote 从 ssh 换成 https、link 到另一个分支、或早期版本用目录名当 project。
   * 增量同步按**文件内容哈希**判断要不要重建，文件没变就不重建，于是新 identity
   * 的节点整批插入、旧的一行不删 —— flask 的图因此有 4721 个节点，其中 2360 个是
   * `flask:main` 的僵尸、2361 个是现 identity 的真节点，每个符号两份。
   *
   * 后果不止是体积翻倍：跨 identity 的 CALLS 边会把调用者指到僵尸副本上，
   * `add_url_rule ↖43` 里数进了不存在的引用，而 Call Graph 只列 3 个调用者 ——
   * agent 拿到的"谁依赖你"因此是错的。删完靠 deleteDanglingEdges 收尾。
   */
  pruneForeignProjects(keep: string): number {
    const foreign = this.listProjects().filter(p => p !== keep);
    let removed = 0;
    const countStmt = this.db.prepare('SELECT COUNT(*) as cnt FROM nodes WHERE project = ?');
    for (const p of foreign) {
      removed += (countStmt.get(p) as { cnt: number }).cnt;
      this.deleteProject(p);
    }
    return removed;
  }

  deleteProjectEdgesChunk(project: string, limit: number): number {
    return this.db.prepare(
      'DELETE FROM edges WHERE id IN (SELECT id FROM edges WHERE project = ? LIMIT ?)'
    ).run(project, limit).changes;
  }

  deleteProjectNodesChunk(project: string, limit: number): number {
    return this.db.prepare(
      'DELETE FROM nodes WHERE id IN (SELECT id FROM nodes WHERE project = ? LIMIT ?)'
    ).run(project, limit).changes;
  }

  /**
   * 全量重建时清 unresolved_refs —— 和 nodes/edges 一样分块，避免一次删几万行的长事务。
   *
   * 漏掉这一步的后果不是"多留点垃圾"：重建后节点 id 从新序列开始，而残留 ref 的
   * from_node_id 还指向已删除的旧 id。下一次增量的 resetFailedRefs 会把它们重新置为
   * pending，解析器给它们造出 source 不存在的边，而出入度统计（getNodeDegreesBatch）
   * 不 join nodes —— 于是 search 结果里出现凭空多出来的调用者数量。
   */
  deleteProjectUnresolvedRefsChunk(project: string, limit: number): number {
    return this.db.prepare(
      'DELETE FROM unresolved_refs WHERE id IN (SELECT id FROM unresolved_refs WHERE project = ? LIMIT ?)'
    ).run(project, limit).changes;
  }

  /**
   * 删除 from_node_id 已经不存在的 ref（自愈）。历史上被上面那个漏删污染过的图库，
   * 靠这一条在下一次增量里把陈旧 ref 清掉，不必等版本号触发全量重建。
   */
  deleteStaleUnresolvedRefs(project: string): number {
    return this.db.prepare(`
      DELETE FROM unresolved_refs WHERE project = ? AND from_node_id NOT IN (
        SELECT id FROM nodes WHERE project = ?
      )
    `).run(project, project).changes;
  }

  /**
   * 删除端点已不存在的边（自愈）。与 deleteStaleUnresolvedRefs 配对：ref 清掉之后，
   * 之前已经由它造出来的孤儿边也要一起清，否则出入度还是虚高。
   */
  deleteDanglingEdges(project: string): number {
    return this.db.prepare(`
      DELETE FROM edges WHERE project = ? AND (
        source_id NOT IN (SELECT id FROM nodes WHERE project = ?)
        OR target_id NOT IN (SELECT id FROM nodes WHERE project = ?)
      )
    `).run(project, project, project).changes;
  }

  /**
   * 把提取阶段没接上的方法接回接收者类型：`contains` 边 + 带类名的显示名。
   *
   * 只有 Go 会走到这里。别的语言方法词法嵌套在类体内，提取时就有父亲；Go 的
   * `func (r *Router) Use(...)` 是顶层声明，而接收者类型常常在同一个包的另一个
   * 文件里（gorilla/mux：`Router` 在 mux.go，`Use` 在 middleware.go），提取器的
   * registry 是按文件的，接不上。没有这条 contains 边，"Router 有哪些方法"、
   * 以及 buildOverrideEdges 的同名成员对齐都会漏掉这些方法。
   *
   * 同名类型有多个就跳过（那个 HAVING）：`receiverType` 只是个裸名字，撞名时
   * 挂错类型比不挂更坏。改名走 UPDATE 是安全的 —— nodes_au 触发器会同步 FTS，
   * 且 suffix_name 保持裸名，检索与 overrides 推导都按它来。
   */
  attachReceiverContains(project: string): number {
    const rows = this.db.prepare(`
      SELECT m.id AS mid, m.name AS mname, m.qualified_name AS mqn,
             json_extract(m.properties_json, '$.receiverType') AS recv,
             MIN(t.id) AS tid
      FROM nodes m
      JOIN nodes t ON t.project = m.project
        AND t.name = json_extract(m.properties_json, '$.receiverType')
        AND t.kind IN ('class', 'struct', 'interface', 'trait', 'type_alias')
      WHERE m.project = ? AND m.kind = 'method'
        AND json_extract(m.properties_json, '$.receiverType') IS NOT NULL
        AND instr(m.name, '.') = 0
      GROUP BY m.id
      HAVING COUNT(DISTINCT t.id) = 1
    `).all(project) as Array<{ mid: number; mname: string; mqn: string; recv: string; tid: number }>;
    if (rows.length === 0) return 0;

    const link = this.db.prepare(`
      INSERT OR IGNORE INTO edges (project, source_id, target_id, kind, provenance)
      VALUES (?, ?, ?, 'contains', 'receiver')
    `);
    const rename = this.db.prepare(
      'UPDATE nodes SET name = ?, qualified_name = ? WHERE id = ?'
    );
    let n = 0;
    this.db.transaction(() => {
      for (const r of rows) {
        link.run(project, r.tid, r.mid);
        rename.run(
          `${r.recv}.${r.mname}`,
          r.mqn.replace(/[^.]+$/, `${r.recv}.${r.mname}`),
          r.mid,
        );
        n++;
      }
    })();
    return n;
  }

  /**
   * 由继承边推导 overrides 边：C extends P 且两边有同名方法 → C.m overrides P.m。
   *
   * 需要它是因为调用边落在声明处。flask 的 `route` 装饰器在 Scaffold 里调
   * `self.add_url_rule`，而 Scaffold 那个方法体只有 `raise NotImplementedError`——
   * 真实现在 App/Blueprint 里。于是问"谁调用 App.add_url_rule"答案是空的，
   * 尽管每一个 @app.route 都会走到它。
   *
   * 纯图计算，不碰各语言 AST：extends 边已经有了，同名成员用 contains 边对齐即可。
   * is_abstract 靠不住（提取层对 Python 的 NotImplementedError 一律给 0），
   * 所以不筛"基类方法是否抽象"—— 普通的方法覆盖同样需要这条边。
   *
   * 同名成员在一侧出现多份就整组跳过（那个 HAVING）：光按名字配对是 N×M 笛卡尔积。
   * flask 的 `@setupmethod` 装饰器在 App 里留下 21 个同名节点、Scaffold 里若干，
   * 一条继承边就能生出 432 条边 —— 而这种情况下"哪个覆盖哪个"本来就无从判定。
   * 代价是 C++ 重载方法不产出 overrides 边，那本来也不是名字能定的关系。
   *
   * 比的是 suffix_name 而不是 name：一部分语言的方法显示名带类名前缀
   * （Go 的 `Service.Describe`），拿全名比永远不相等。
   */
  buildOverrideEdges(project: string): number {
    return this.db.prepare(`
      INSERT OR IGNORE INTO edges (project, source_id, target_id, kind, provenance)
      SELECT ?, MIN(cn.id), MIN(pn.id), 'overrides', 'inheritance'
      FROM edges h
      JOIN edges cm ON cm.project = h.project AND cm.kind = 'contains' AND cm.source_id = h.source_id
      JOIN edges pm ON pm.project = h.project AND pm.kind = 'contains' AND pm.source_id = h.target_id
      JOIN nodes cn ON cn.id = cm.target_id
      JOIN nodes pn ON pn.id = pm.target_id
      WHERE h.project = ? AND h.kind IN ('extends', 'implements')
        AND cn.suffix_name = pn.suffix_name AND cn.id != pn.id
        AND cn.kind IN ('method', 'function')
        AND pn.kind IN ('method', 'function')
      GROUP BY h.source_id, h.target_id, cn.suffix_name
      HAVING COUNT(DISTINCT cn.id) = 1 AND COUNT(DISTINCT pn.id) = 1
    `).run(project, project).changes;
  }

  // ── Transaction helpers ────────────────────────────────────────────

  beginTransaction(): void {
    this.db.exec('BEGIN TRANSACTION');
  }

  commitTransaction(): void {
    this.db.exec('COMMIT');
  }

  rollbackTransaction(): void {
    try { this.db.exec('ROLLBACK'); } catch { /* ignore */ }
  }

  // ── Schema ─────────────────────────────────────────────────────────

  getSchema(): { nodeKinds: string[]; edgeKinds: string[] } {
    const kinds = this.roStmt('SELECT DISTINCT kind FROM nodes ORDER BY kind').all() as Array<{ kind: string }>;
    const types = this.roStmt('SELECT DISTINCT kind FROM edges ORDER BY kind').all() as Array<{ kind: string }>;
    return {
      nodeKinds: kinds.map(r => r.kind),
      edgeKinds: types.map(r => r.kind),
    };
  }

  getNodeKindCounts(project: string): Record<string, number> {
    const rows = this.roStmt(
      'SELECT kind, COUNT(*) as cnt FROM nodes WHERE project = ? GROUP BY kind'
    ).all(project) as Array<{ kind: string; cnt: number }>;
    const result: Record<string, number> = {};
    for (const row of rows) result[row.kind] = row.cnt;
    return result;
  }

  getEdgeKindCounts(project: string): Record<string, number> {
    const rows = this.roStmt(
      'SELECT kind, COUNT(*) as cnt FROM edges WHERE project = ? GROUP BY kind'
    ).all(project) as Array<{ kind: string; cnt: number }>;
    const result: Record<string, number> = {};
    for (const row of rows) result[row.kind] = row.cnt;
    return result;
  }

  getNodeTypeCounts(project: string): Record<string, number> {
    return this.getNodeKindCounts(project);
  }

  getEdgeTypeCounts(project: string): Record<string, number> {
    return this.getEdgeKindCounts(project);
  }

  // ── Raw queries ────────────────────────────────────────────────────

  executeQuery(project: string, query: string): { rows: Array<Record<string, unknown>> } {
    const matchMatch = query.match(/MATCH\s*\((\w+)\)\s*(?:WHERE\s+(.+?))?\s*RETURN\s+(.+)/i);
    if (matchMatch) {
      const whereClause = matchMatch[2];
      const returnClause = matchMatch[3];
      const conditions: string[] = ['n.project = ?'];
      const params: unknown[] = [project];

      if (whereClause) {
        const eqMatches = whereClause.matchAll(/(\w+)\.(\w+)\s*=\s*'([^']+)'/g);
        for (const m of eqMatches) {
          const field = m[2];
          const value = m[3];
          switch (field) {
            case 'name': conditions.push('n.name = ?'); params.push(value); break;
            case 'kind': case 'label': conditions.push('n.kind = ?'); params.push(value); break;
            case 'qualifiedName': case 'qualified_name': conditions.push('n.qualified_name = ?'); params.push(value); break;
          }
        }
      }

      const whereSQL = conditions.join(' AND ');
      if (returnClause.includes('*') || returnClause.includes(matchMatch[1])) {
        const rows = this.roStmt(`SELECT * FROM nodes n WHERE ${whereSQL}`).all(...params) as Array<Record<string, unknown>>;
        return { rows };
      }
    }
    throw new Error(`Unsupported query format. Use Cypher-like syntax: MATCH (n) WHERE n.name = 'X' RETURN n`);
  }

  // ── ADR ────────────────────────────────────────────────────────────

  getADRs(project?: string): Array<{ id: number; project: string; title: string; status: string; content: string; created: string }> {
    const options: GraphSearchOptions = { kind: 'ADR' as any, limit: 1000 };
    if (project) options.project = project;
    const result = this.findNodes(options);
    return result.results.map(r => ({
      id: r.node.id,
      project: r.node.project,
      title: r.node.name,
      status: (r.node.properties.status as string) || 'unknown',
      content: (r.node.properties.content as string) || '',
      created: (r.node.properties.created as string) || new Date().toISOString(),
    }));
  }

  createADR(adr: { project: string; title: string; content: string; status: string }): number {
    return this.upsertNode({
      project: adr.project,
      kind: 'ADR' as any,
      label: 'ADR' as any,
      name: adr.title,
      qualifiedName: `${adr.project}.adr.${adr.title.replace(/\s+/g, '-').toLowerCase()}`,
      filePath: 'adr://',
      startLine: 0,
      endLine: 0,
      properties: {
        content: adr.content,
        status: adr.status,
        created: new Date().toISOString(),
      },
    });
  }

  updateADR(id: number, updates: { status?: string; content?: string }): void {
    const node = this.getNodeById(id);
    if (!node) return;
    const props = { ...node.properties, ...updates };
    this.db.prepare('UPDATE nodes SET properties_json = ? WHERE id = ?').run(JSON.stringify(props), id);
  }

  // ── File path helpers ──────────────────────────────────────────────

  getAllFilePaths(project: string): string[] {
    const rows = this.roStmt(
      'SELECT DISTINCT file_path FROM nodes WHERE project = ?'
    ).all(project) as Array<{ file_path: string }>;
    return rows.map(r => r.file_path);
  }

  getAllNodeNames(project: string): string[] {
    const rows = this.roStmt(
      'SELECT DISTINCT name FROM nodes WHERE project = ?'
    ).all(project) as Array<{ name: string }>;
    return rows.map(r => r.name);
  }

  iterateNodeNames(project: string): Iterable<string> {
    const stmt = this.roStmt('SELECT DISTINCT name FROM nodes WHERE project = ?');
    return {
      [Symbol.iterator]: () => {
        const iter = stmt.iterate(project);
        return {
          next: (): IteratorResult<string> => {
            const { value, done } = iter.next();
            return done
              ? { value: undefined as any, done: true }
              : { value: (value as { name: string }).name, done: false };
          },
        };
      },
    };
  }

  // ── Row mapping ────────────────────────────────────────────────────

  private rowToNode(row: Record<string, unknown>): GraphNode {
    const kind = (row.kind as GraphNodeKind) || (row.label as GraphNodeKind) || 'function';
    return {
      id: row.id as number,
      project: row.project as string,
      kind,
      label: kind, // backward compat
      name: row.name as string,
      qualifiedName: row.qualified_name as string,
      filePath: row.file_path as string,
      language: (row.language as GraphLanguage) || undefined,
      startLine: row.start_line as number,
      endLine: row.end_line as number,
      signature: (row.signature as string) || undefined,
      docstring: (row.docstring as string) || undefined,
      visibility: (row.visibility as any) || undefined,
      isExported: (row.is_exported as number) === 1,
      isAsync: (row.is_async as number) === 1,
      isStatic: (row.is_static as number) === 1,
      isAbstract: (row.is_abstract as number) === 1,
      decorators: row.decorators_json ? JSON.parse(row.decorators_json as string) : undefined,
      typeParameters: row.type_parameters_json ? JSON.parse(row.type_parameters_json as string) : undefined,
      returnType: (row.return_type as string) || undefined,
      updatedAt: row.updated_at as number,
      properties: JSON.parse((row.properties_json as string) || '{}'),
    };
  }

  private rowToEdge(row: Record<string, unknown>): GraphEdge {
    const kind = (row.kind as GraphEdgeKind) || (row.type as GraphEdgeKind) || 'calls';
    return {
      id: row.id as number,
      project: row.project as string,
      sourceId: row.source_id as number,
      targetId: row.target_id as number,
      kind,
      type: kind, // backward compat
      line: (row.line as number) >= 0 ? (row.line as number) : undefined,
      column: (row.col as number) >= 0 ? (row.col as number) : undefined,
      provenance: (row.provenance as any) ?? 'tree-sitter',
      metadata: row.metadata_json ? JSON.parse(row.metadata_json as string) : undefined,
      properties: JSON.parse((row.properties_json as string) || '{}'),
    };
  }

  // ── Helpers ────────────────────────────────────────────────────────

  private buildFtsQuery(query: string): string {
    const esc = (s: string) => s.replace(/"/g, '""');
    const arms: string[] = [];
    const seen = new Set<string>();
    const push = (arm: string) => {
      if (seen.has(arm) || arms.length >= MAX_FTS_ARMS) return;
      seen.add(arm);
      arms.push(arm);
    };
    // Prefix matching: "ord"* matches "OrderService" stored as single token.
    for (const token of meaningfulQueryTokens(query)) push(`"${esc(token)}"*`);
    // ...plus the query's word pairs as phrases against the identifier columns
    // only (see queryPhrases). A phrase arm scores like any other matched term,
    // so a row whose name spells out two adjacent query words outranks one that
    // happens to share a word with the path — no extra query, no second pass.
    //
    // Abbreviations (ABBREVIATION_PAIRS) are expanded HERE and not on the single
    // words above, because a short form is a terrible prefix on its own: adding
    // "exec"* for the word "execute" swept in every ara::exec symbol in the repo
    // and pushed the thread-pool query's actual answer out of the top ten. Inside
    // a phrase the short form is precise — "init logging" hits InitLogging and
    // essentially nothing else.
    for (const phrase of queryPhrases(query)) {
      const [a, b] = phrase.split(' ');
      for (const va of wordVariants(a)) {
        for (const vb of wordVariants(b)) push(`{name search_text} : "${esc(va)} ${esc(vb)}"`);
      }
    }
    // 泛词（file/data/type/get…）作为无限定前缀臂是灾难 —— "file"* 会命中每一条
    // 路径里带 file 的行。但它们照样在**给符号起名**：FileMonitor、DataStore、
    // TypeRegistry。所以给它们一条只打标识符列的前缀臂：能对上名字，碰不到
    // file_path。补在短语臂之后，只用剩下的臂位，不挤掉已被证明有效的那些。
    //
    // 需要它是因为短语臂只覆盖查询里**相邻**的词对：问 "monitor log directory for
    // file changes"，FileMonitor 的两个词在查询里既不相邻、顺序还是反的，
    // 于是它连候选池都进不去（实测该查询前 200 个候选里没有它）。
    const meaningful = new Set(meaningfulQueryTokens(query).map(t => t.toLowerCase()));
    for (const word of queryWords(query).map(t => t.toLowerCase())) {
      if (meaningful.has(word) || QUERY_STOP_WORDS.has(word)) continue;
      push(`{name search_text} : "${esc(word)}"*`);
    }
    return arms.join(' OR ');
  }

  private regexToLike(pattern: string): string {
    const escaped = pattern
      .replace(/[*?^${}()[\]]/g, '')
      .replace(/%/g, '\\%')
      .replace(/_/g, '\\_');
    return '%' + escaped + '%';
  }
}
