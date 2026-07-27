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

-- FTS5 index for BM25 full-text search on node names and qualified names
CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
    name,
    qualified_name,
    file_path,
    content='nodes',
    content_rowid='id',
    tokenize='unicode61 remove_diacritics 1'
);
`;

const FTS_TRIGGERS_SQL = `
CREATE TRIGGER IF NOT EXISTS nodes_ai AFTER INSERT ON nodes BEGIN
    INSERT INTO nodes_fts(rowid, name, qualified_name, file_path)
    VALUES (new.id, new.name, new.qualified_name, new.file_path);
END;

CREATE TRIGGER IF NOT EXISTS nodes_ad AFTER DELETE ON nodes BEGIN
    INSERT INTO nodes_fts(nodes_fts, rowid, name, qualified_name, file_path)
    VALUES ('delete', old.id, old.name, old.qualified_name, old.file_path);
END;

CREATE TRIGGER IF NOT EXISTS nodes_au AFTER UPDATE ON nodes BEGIN
    INSERT INTO nodes_fts(nodes_fts, rowid, name, qualified_name, file_path)
    VALUES ('delete', old.id, old.name, old.qualified_name, old.file_path);
    INSERT INTO nodes_fts(rowid, name, qualified_name, file_path)
    VALUES (new.id, new.name, new.qualified_name, new.file_path);
END;
`;

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

  // ── Schema ────────────────────────────────────────────────────────

  private _ensureSchema(): void {
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    // Use a larger page size and cache for better write throughput
    this.db.pragma('page_size = 4096');
    this.db.pragma('cache_size = -64000'); // 64MB
    this.db.exec(SCHEMA_SQL);
    this.db.exec(FTS_TRIGGERS_SQL);
  }

  initialize(): void {
    if (!this._initialized) {
      this._ensureSchema();
      this._initialized = true;
    }
  }

  close(): void {
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
    this.db.exec(`INSERT INTO nodes_fts(nodes_fts) VALUES('rebuild')`);
    this.db.exec(FTS_TRIGGERS_SQL);
    this.db.pragma('foreign_keys = ON');
  }

  // ── Node operations ───────────────────────────────────────────────

  upsertNode(node: Omit<GraphNode, 'id'>): number {
    const result = this.stmt(`
      INSERT INTO nodes (project, kind, name, qualified_name, file_path,
        language, start_line, end_line,
        signature, visibility, is_exported, is_async, is_static, is_abstract,
        decorators_json, type_parameters_json, return_type, docstring,
        properties_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project, qualified_name) DO UPDATE SET
        kind = excluded.kind, name = excluded.name,
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
    const row = this.readDB.prepare('SELECT * FROM nodes WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToNode(row) : null;
  }

  getNodesById(ids: number[]): Map<number, GraphNode> {
    const result = new Map<number, GraphNode>();
    if (ids.length === 0) return result;
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.readDB.prepare(
      `SELECT * FROM nodes WHERE id IN (${placeholders})`
    ).all(...ids) as Array<Record<string, unknown>>;
    for (const row of rows) {
      const node = this.rowToNode(row);
      result.set(node.id, node);
    }
    return result;
  }

  getNodeByQN(project: string, qualifiedName: string): GraphNode | null {
    const row = this.readDB.prepare(
      'SELECT * FROM nodes WHERE project = ? AND qualified_name = ?'
    ).get(project, qualifiedName) as Record<string, unknown> | undefined;
    return row ? this.rowToNode(row) : null;
  }

  getNodesByFile(project: string, filePath: string): GraphNode[] {
    const rows = this.readDB.prepare(
      'SELECT * FROM nodes WHERE project = ? AND file_path = ?'
    ).all(project, filePath) as Array<Record<string, unknown>>;
    return rows.map(r => this.rowToNode(r));
  }

  getNodesByName(project: string, name: string): GraphNode[] {
    const rows = this.readDB.prepare(
      'SELECT * FROM nodes WHERE project = ? AND name = ?'
    ).all(project, name) as Array<Record<string, unknown>>;
    return rows.map(r => this.rowToNode(r));
  }

  getNodesByLowerName(project: string, lowerName: string): GraphNode[] {
    const rows = this.readDB.prepare(
      'SELECT * FROM nodes WHERE project = ? AND LOWER(name) = ?'
    ).all(project, lowerName) as Array<Record<string, unknown>>;
    return rows.map(r => this.rowToNode(r));
  }

  getNodesByQualifiedNameExact(project: string, qn: string): GraphNode[] {
    const rows = this.readDB.prepare(
      'SELECT * FROM nodes WHERE project = ? AND qualified_name = ?'
    ).all(project, qn) as Array<Record<string, unknown>>;
    return rows.map(r => this.rowToNode(r));
  }

  getNodesByKind(project: string, kind: GraphNodeKind): GraphNode[] {
    const rows = this.readDB.prepare(
      'SELECT * FROM nodes WHERE project = ? AND kind = ?'
    ).all(project, kind) as Array<Record<string, unknown>>;
    return rows.map(r => this.rowToNode(r));
  }

  /** Streaming iterator — avoids materializing a giant array for whole-kind scans. */
  iterateNodesByKind(project: string, kind: GraphNodeKind): Iterable<GraphNode> {
    const stmt = this.readDB.prepare('SELECT * FROM nodes WHERE project = ? AND kind = ?');
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
      const query = `
        SELECT n.*, bm25(nodes_fts, 1.0, 2.0, 0.5) AS score
        FROM nodes n
        JOIN nodes_fts fts ON n.id = fts.rowid
        WHERE nodes_fts MATCH ? AND ${whereClause}
        ORDER BY score
        LIMIT ? OFFSET ?
      `;
      const countQuery = `
        SELECT COUNT(*) as total
        FROM nodes n
        JOIN nodes_fts fts ON n.id = fts.rowid
        WHERE nodes_fts MATCH ? AND ${whereClause}
      `;
      const rows = rdb.prepare(query).all(ftsQuery, ...params, limit, offset) as Array<Record<string, unknown>>;
      const countRow = rdb.prepare(countQuery).get(ftsQuery, ...params) as { total: number };
      return this.buildNodeResults(rows, countRow, options, offset);
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
    const results: GraphSearchResult[] = [];
    const nodeIds = rows.map(row => row.id as number);
    const degreeMap = this.getNodeDegreesBatch(nodeIds);

    for (const row of rows) {
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

    const hasDegreeFilter = options.minDegree !== undefined || options.maxDegree !== undefined;
    const effectiveTotal = hasDegreeFilter ? results.length : countRow.total;

    return {
      results,
      total: effectiveTotal,
      hasMore: offset + results.length < effectiveTotal,
    };
  }

  getNodeDegree(nodeId: number): { inDegree: number; outDegree: number } {
    const inRow = this.readDB.prepare('SELECT COUNT(*) as cnt FROM edges WHERE target_id = ?').get(nodeId) as { cnt: number };
    const outRow = this.readDB.prepare('SELECT COUNT(*) as cnt FROM edges WHERE source_id = ?').get(nodeId) as { cnt: number };
    return { inDegree: inRow.cnt, outDegree: outRow.cnt };
  }

  getNodeDegreesBatch(nodeIds: number[]): Map<number, { inDegree: number; outDegree: number }> {
    const degreeMap = new Map<number, { inDegree: number; outDegree: number }>();
    if (nodeIds.length === 0) return degreeMap;

    for (const id of nodeIds) degreeMap.set(id, { inDegree: 0, outDegree: 0 });

    const placeholders = nodeIds.map(() => '?').join(',');
    const rows = this.readDB.prepare(`
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
    const existing = this.readDB.prepare(
      'SELECT id FROM edges WHERE source_id = ? AND target_id = ? AND kind = ? AND line = ? AND col = ?'
    ).get(edge.sourceId, edge.targetId, kind, line, col) as { id: number } | undefined;
    return existing ? existing.id : 0;
  }

  getEdgesBySource(sourceId: number, kind?: GraphEdgeKind): GraphEdge[] {
    let sql = 'SELECT * FROM edges WHERE source_id = ?';
    const params: unknown[] = [sourceId];
    if (kind) { sql += ' AND kind = ?'; params.push(kind); }
    const rows = this.readDB.prepare(sql).all(...params) as Array<Record<string, unknown>>;
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
    const rows = this.readDB.prepare(sql).all(...params) as Array<Record<string, unknown>>;
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
    const rows = this.readDB.prepare(sql).all(...params) as Array<Record<string, unknown>>;
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
    const rows = this.readDB.prepare(sql).all(...params) as Array<Record<string, unknown>>;
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
    const rows = this.readDB.prepare(sql).all(...params) as Array<Record<string, unknown>>;
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
    const row = this.readDB.prepare(
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
    const rows = this.readDB.prepare(sql).all(...params) as Array<Record<string, unknown>>;
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

  // ── File-level operations ─────────────────────────────────────────

  deleteNodesByFile(project: string, filePath: string): void {
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
    const rows = this.readDB.prepare('SELECT DISTINCT project FROM nodes ORDER BY project').all() as Array<{ project: string }>;
    return rows.map(r => r.project);
  }

  getProjectStats(project: string): { nodes: number; edges: number } {
    const nodeRow = this.readDB.prepare('SELECT COUNT(*) as cnt FROM nodes WHERE project = ?').get(project) as { cnt: number };
    const edgeRow = this.readDB.prepare('SELECT COUNT(*) as cnt FROM edges WHERE project = ?').get(project) as { cnt: number };
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
    const kinds = this.readDB.prepare('SELECT DISTINCT kind FROM nodes ORDER BY kind').all() as Array<{ kind: string }>;
    const types = this.readDB.prepare('SELECT DISTINCT kind FROM edges ORDER BY kind').all() as Array<{ kind: string }>;
    return {
      nodeKinds: kinds.map(r => r.kind),
      edgeKinds: types.map(r => r.kind),
    };
  }

  getNodeKindCounts(project: string): Record<string, number> {
    const rows = this.readDB.prepare(
      'SELECT kind, COUNT(*) as cnt FROM nodes WHERE project = ? GROUP BY kind'
    ).all(project) as Array<{ kind: string; cnt: number }>;
    const result: Record<string, number> = {};
    for (const row of rows) result[row.kind] = row.cnt;
    return result;
  }

  getEdgeKindCounts(project: string): Record<string, number> {
    const rows = this.readDB.prepare(
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
        const rows = this.readDB.prepare(`SELECT * FROM nodes n WHERE ${whereSQL}`).all(...params) as Array<Record<string, unknown>>;
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
    const rows = this.readDB.prepare(
      'SELECT DISTINCT file_path FROM nodes WHERE project = ?'
    ).all(project) as Array<{ file_path: string }>;
    return rows.map(r => r.file_path);
  }

  getAllNodeNames(project: string): string[] {
    const rows = this.readDB.prepare(
      'SELECT DISTINCT name FROM nodes WHERE project = ?'
    ).all(project) as Array<{ name: string }>;
    return rows.map(r => r.name);
  }

  iterateNodeNames(project: string): Iterable<string> {
    const stmt = this.readDB.prepare('SELECT DISTINCT name FROM nodes WHERE project = ?');
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
    const tokens = query
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .split(/[\s_\-.:/]+/)
      .filter(t => t.length > 0);
    return tokens.map(t => `"${t.replace(/"/g, '""')}"`).join(' OR ');
  }

  private regexToLike(pattern: string): string {
    const escaped = pattern
      .replace(/[*?^${}()[\]]/g, '')
      .replace(/%/g, '\\%')
      .replace(/_/g, '\\_');
    return '%' + escaped + '%';
  }
}
