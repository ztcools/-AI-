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

  /** Connection for read queries: uses RO when available (non-blocking in WAL mode). */
  private get readDB(): Database {
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
    `).run(
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
    );
    return Number(result.lastInsertRowid);
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
        `).all(ftsQuery, ...params, limit * 2) as Array<Record<string, unknown>>;
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
      const start = offset || 0;
      const sliced = diversifyByConcept(filtered, options.query || '', limit).slice(
        start,
        start + limit,
      );
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

    // Source-over-test ranking: when several definitions share a name ("send" in
    // sessions.py vs test_sessions.py), the production definition is almost
    // always the intended answer, not the test double. Demote test/spec files by
    // a large score margin so they rank after real definitions, without being
    // filtered out entirely (tests are still searchable when asked for).
    const isTestFile = (fp: string): boolean => {
      const lower = fp.toLowerCase();
      const base = lower.slice(lower.lastIndexOf('/') + 1);
      const stem = base.replace(/\.[^.]+$/, '');
      // test directories: tests/, test/, testing/, __tests__/, spec/ anywhere in path
      if (/(^|\/)(tests?|testing|__tests__|spec|specs|testdata|test_fixtures)(\/|$)/i.test(fp)) return true;
      // test file names: test_*, *_test, *_spec, *.test.*, *.spec.*, conftest, *Test, *Tests, *Spec (exact-ish)
      if (/^(test_|conftest)/.test(base)) return true;
      if (/(_test|_spec|\.test|\.spec)\.[^.]+$/.test(base)) return true;
      if (/(Test|Tests|Spec|Tests?Case)\.[^.]+$/.test(base.slice(base.lastIndexOf('/') + 1)) && /[A-Z]/.test(fp.slice(fp.lastIndexOf('/') + 1))) return true;
      void stem;
      return false;
    };
    for (const r of results) {
      if (isTestFile(r.node.filePath || '')) r.score -= 100;
    }
    results.sort((a, b) => b.score - a.score);

    const hasDegreeFilter = options.minDegree !== undefined || options.maxDegree !== undefined;
    const effectiveTotal = hasDegreeFilter ? results.length : countRow.total;

    return {
      results,
      total: effectiveTotal,
      hasMore: offset + results.length < effectiveTotal,
    };
  }

  getNodeDegree(nodeId: number): { inDegree: number; outDegree: number } {
    const inRow = this.roStmt('SELECT COUNT(*) as cnt FROM edges WHERE target_id = ?').get(nodeId) as { cnt: number };
    const outRow = this.roStmt('SELECT COUNT(*) as cnt FROM edges WHERE source_id = ?').get(nodeId) as { cnt: number };
    return { inDegree: inRow.cnt, outDegree: outRow.cnt };
  }

  getNodeDegreesBatch(nodeIds: number[]): Map<number, { inDegree: number; outDegree: number }> {
    const degreeMap = new Map<number, { inDegree: number; outDegree: number }>();
    if (nodeIds.length === 0) return degreeMap;

    for (const id of nodeIds) degreeMap.set(id, { inDegree: 0, outDegree: 0 });

    const placeholders = nodeIds.map(() => '?').join(',');
    const rows = this.roStmt(`
      SELECT target_id as id, COUNT(*) as in_deg, 0 as out_deg FROM edges
      WHERE target_id IN (${placeholders})
      GROUP BY target_id
      UNION ALL
      SELECT source_id as id, 0 as in_deg, COUNT(*) as out_deg FROM edges
      WHERE source_id IN (${placeholders})
      GROUP BY source_id
    `).all(...nodeIds, ...nodeIds) as Array<{ id: number; in_deg: number; out_deg: number }>;

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
