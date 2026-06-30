/**
 * SQLite-backed graph store for code knowledge graphs.
 * Stores nodes and edges with full-text search (FTS5) for BM25 ranking.
 */
import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import {
    GraphStore,
    GraphNode,
    GraphEdge,
    GraphNodeLabel,
    GraphEdgeType,
    GraphSearchOptions,
    GraphSearchResult,
    GraphSearchResponse,
} from './types';

// ── SQL schema ────────────────────────────────────────────────────

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS nodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project TEXT NOT NULL,
    label TEXT NOT NULL,
    name TEXT NOT NULL,
    qualified_name TEXT NOT NULL,
    file_path TEXT NOT NULL,
    start_line INTEGER NOT NULL DEFAULT 0,
    end_line INTEGER NOT NULL DEFAULT 0,
    properties_json TEXT NOT NULL DEFAULT '{}',
    UNIQUE(project, qualified_name)
);

CREATE INDEX IF NOT EXISTS idx_nodes_project ON nodes(project);
CREATE INDEX IF NOT EXISTS idx_nodes_label ON nodes(project, label);
CREATE INDEX IF NOT EXISTS idx_nodes_file ON nodes(project, file_path);
CREATE INDEX IF NOT EXISTS idx_nodes_qn ON nodes(project, qualified_name);

CREATE TABLE IF NOT EXISTS edges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project TEXT NOT NULL,
    source_id INTEGER NOT NULL,
    target_id INTEGER NOT NULL,
    type TEXT NOT NULL,
    properties_json TEXT NOT NULL DEFAULT '{}',
    FOREIGN KEY (source_id) REFERENCES nodes(id) ON DELETE CASCADE,
    FOREIGN KEY (target_id) REFERENCES nodes(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_edges_project ON edges(project);
CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(project, source_id);
CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(project, target_id);
CREATE INDEX IF NOT EXISTS idx_edges_type ON edges(project, type);

-- FTS5 index for BM25 full-text search on node names and qualified names
CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
    name,
    qualified_name,
    file_path,
    content='nodes',
    content_rowid='id',
    tokenize='unicode61 remove_diacritics 1'
);

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

// ── Implementation ────────────────────────────────────────────────

export class SqliteGraphStore implements GraphStore {
    private db: Database.Database;
    private dbPath: string;
    /** Cached prepared statements to avoid re-compiling SQL on every call. */
    private upsertNodeStmt!: Database.Statement;
    private upsertEdgeSelectStmt!: Database.Statement;
    private upsertEdgeInsertStmt!: Database.Statement;
    private deleteNodesByFileStmt!: Database.Statement;
    private deleteEdgesByFileStmt!: Database.Statement;
    private deleteProjectNodesStmt!: Database.Statement;
    private deleteProjectEdgesStmt!: Database.Statement;
    private deleteNodesByFilePathStmt!: Database.Statement;
    private updateNodeFileStmt!: Database.Statement;
    private deleteNodeEdgesStmt!: Database.Statement;

    constructor(dbPath?: string) {
        if (dbPath) {
            this.dbPath = dbPath;
        } else {
            const graphDir = path.join(os.homedir(), '.context', 'graph');
            fs.mkdirSync(graphDir, { recursive: true });
            this.dbPath = path.join(graphDir, 'knowledge-graph.db');
        }
        this.db = new Database(this.dbPath);
        this._prepareStatements();
    }

    /** Pre-compile all hot-path statements once. */
    private _prepareStatements(): void {
        this.upsertNodeStmt = this.db.prepare(`
            INSERT INTO nodes (project, label, name, qualified_name, file_path, start_line, end_line, properties_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(project, qualified_name) DO UPDATE SET
                label = excluded.label,
                name = excluded.name,
                file_path = excluded.file_path,
                start_line = excluded.start_line,
                end_line = excluded.end_line,
                properties_json = excluded.properties_json
        `);
        this.upsertEdgeSelectStmt = this.db.prepare(
            'SELECT id FROM edges WHERE project = ? AND source_id = ? AND target_id = ? AND type = ?'
        );
        this.upsertEdgeInsertStmt = this.db.prepare(`
            INSERT INTO edges (project, source_id, target_id, type, properties_json)
            VALUES (?, ?, ?, ?, ?)
        `);
        this.deleteNodesByFileStmt = this.db.prepare(
            'SELECT id FROM nodes WHERE project = ? AND file_path = ?'
        );
        this.deleteEdgesByFileStmt = this.db.prepare(
            `DELETE FROM edges WHERE project = ? AND (
                source_id IN (SELECT id FROM nodes WHERE project = ? AND file_path = ?)
                OR target_id IN (SELECT id FROM nodes WHERE project = ? AND file_path = ?)
            )`
        );
        this.deleteProjectNodesStmt = this.db.prepare(
            'DELETE FROM nodes WHERE project = ?'
        );
        this.deleteProjectEdgesStmt = this.db.prepare(
            'DELETE FROM edges WHERE project = ?'
        );
        this.deleteNodesByFilePathStmt = this.db.prepare(
            'DELETE FROM nodes WHERE project = ? AND file_path = ?'
        );
        this.updateNodeFileStmt = this.db.prepare(
            'UPDATE nodes SET file_path = ? WHERE project = ? AND qualified_name = ?'
        );
        this.deleteNodeEdgesStmt = this.db.prepare(
            'DELETE FROM edges WHERE project = ? AND source_id = ?'
        );
    }

    initialize(): void {
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('foreign_keys = ON');
        this.db.exec(SCHEMA_SQL);
    }

    close(): void {
        if (this.db) {
            this.db.close();
        }
    }

    /** Flush the WAL to the main database file and release space. */
    checkpoint(): void {
        this.db.pragma('wal_checkpoint(TRUNCATE)');
    }

    // ── Node operations ──────────────────────────────────────────

    upsertNode(node: Omit<GraphNode, 'id'>): number {
        const result = this.upsertNodeStmt.run(
            node.project,
            node.label,
            node.name,
            node.qualifiedName,
            node.filePath,
            node.startLine,
            node.endLine,
            JSON.stringify(node.properties),
        );
        return Number(result.lastInsertRowid);
    }

    getNodeById(id: number): GraphNode | null {
        const row = this.db.prepare('SELECT * FROM nodes WHERE id = ?').get(id) as Record<string, unknown> | undefined;
        return row ? this.rowToNode(row) : null;
    }

    getNodesById(ids: number[]): Map<number, GraphNode> {
        const result = new Map<number, GraphNode>();
        if (ids.length === 0) return result;

        const placeholders = ids.map(() => '?').join(',');
        const rows = this.db.prepare(
            `SELECT * FROM nodes WHERE id IN (${placeholders})`
        ).all(...ids) as Array<Record<string, unknown>>;

        for (const row of rows) {
            const node = this.rowToNode(row);
            result.set(node.id, node);
        }
        return result;
    }

    getNodeByQN(project: string, qualifiedName: string): GraphNode | null {
        const row = this.db.prepare(
            'SELECT * FROM nodes WHERE project = ? AND qualified_name = ?'
        ).get(project, qualifiedName) as Record<string, unknown> | undefined;
        return row ? this.rowToNode(row) : null;
    }

    findNodes(options: GraphSearchOptions): GraphSearchResponse {
        const { conditions, params: conditionParams } = this.buildFindConditions(options);
        const whereClause = conditions.length > 0 ? conditions.join(' AND ') : '1=1';
        const limit = options.limit ?? 200;
        const offset = options.offset ?? 0;

        // Build query with optional FTS ranking
        let query: string;
        let countQuery: string;
        let countRow: { total: number };

        if (options.query && options.query.trim().length > 0) {
            // BM25 full-text search via FTS5
            const ftsQuery = this.buildFtsQuery(options.query);
            query = `
                SELECT n.*, bm25(nodes_fts, 1.0, 2.0, 0.5) AS score
                FROM nodes n
                JOIN nodes_fts fts ON n.id = fts.rowid
                WHERE nodes_fts MATCH ? AND ${whereClause}
                ORDER BY score
                LIMIT ? OFFSET ?
            `;
            countQuery = `
                SELECT COUNT(*) as total
                FROM nodes n
                JOIN nodes_fts fts ON n.id = fts.rowid
                WHERE nodes_fts MATCH ? AND ${whereClause}
            `;

            const rows = this.db.prepare(query).all(ftsQuery, ...conditionParams, limit, offset) as Array<Record<string, unknown>>;
            countRow = this.db.prepare(countQuery).get(ftsQuery, ...conditionParams) as { total: number };
            return this.buildNodeResults(rows, countRow, options, offset);
        } else {
            query = `
                SELECT n.*, 0 AS score
                FROM nodes n
                WHERE ${whereClause}
                ORDER BY n.name
                LIMIT ? OFFSET ?
            `;
            countQuery = `
                SELECT COUNT(*) as total
                FROM nodes n
                WHERE ${whereClause}
            `;

            const rows = this.db.prepare(query).all(...conditionParams, limit, offset) as Array<Record<string, unknown>>;
            countRow = this.db.prepare(countQuery).get(...conditionParams) as { total: number };
            return this.buildNodeResults(rows, countRow, options, offset);
        }
    }

    /**
     * Build WHERE conditions and params from search options.
     * Extracted as a shared method to ensure count query and main query
     * use the same parameter binding order.
     */
    private buildFindConditions(options: GraphSearchOptions): { conditions: string[]; params: unknown[] } {
        const conditions: string[] = [];
        const params: unknown[] = [];

        if (options.project) {
            conditions.push('n.project = ?');
            params.push(options.project);
        }
        if (options.label) {
            conditions.push('n.label = ?');
            params.push(options.label);
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

        // Batch-load degrees for all result nodes to avoid N+1 queries
        const nodeIds = rows.map(row => row.id as number);
        const degreeMap = this.getNodeDegreesBatch(nodeIds);

        for (const row of rows) {
            const node = this.rowToNode(row);
            const { inDegree, outDegree } = degreeMap.get(node.id) || { inDegree: 0, outDegree: 0 };

            // Apply degree filters
            if (options.minDegree !== undefined && (inDegree + outDegree) < options.minDegree) continue;
            if (options.maxDegree !== undefined && (inDegree + outDegree) > options.maxDegree) continue;

            results.push({
                node,
                score: (row.score as number) ?? 0,
                inDegree,
                outDegree,
            });
        }

        // Adjust total to reflect degree-filtered results
        const hasDegreeFilter = options.minDegree !== undefined || options.maxDegree !== undefined;
        const effectiveTotal = hasDegreeFilter ? results.length : countRow.total;

        return {
            results,
            total: effectiveTotal,
            hasMore: offset + results.length < effectiveTotal,
        };
    }

    getNodeDegree(nodeId: number): { inDegree: number; outDegree: number } {
        const inRow = this.db.prepare(
            'SELECT COUNT(*) as cnt FROM edges WHERE target_id = ?'
        ).get(nodeId) as { cnt: number };
        const outRow = this.db.prepare(
            'SELECT COUNT(*) as cnt FROM edges WHERE source_id = ?'
        ).get(nodeId) as { cnt: number };
        return { inDegree: inRow.cnt, outDegree: outRow.cnt };
    }

    getNodeDegreesBatch(nodeIds: number[]): Map<number, { inDegree: number; outDegree: number }> {
        const degreeMap = new Map<number, { inDegree: number; outDegree: number }>();
        if (nodeIds.length === 0) return degreeMap;

        // Initialize all nodes with 0 degrees
        for (const id of nodeIds) degreeMap.set(id, { inDegree: 0, outDegree: 0 });

        const placeholders = nodeIds.map(() => '?').join(',');
        // Single UNION ALL query instead of two separate queries
        const rows = this.db.prepare(`
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

    // ── Edge operations ──────────────────────────────────────────

    upsertEdge(edge: Omit<GraphEdge, 'id'>): number {
        // Check for duplicate using cached statement
        const existing = this.upsertEdgeSelectStmt.get(
            edge.project, edge.sourceId, edge.targetId, edge.type
        ) as { id: number } | undefined;

        if (existing) {
            return existing.id;
        }

        const result = this.upsertEdgeInsertStmt.run(
            edge.project,
            edge.sourceId,
            edge.targetId,
            edge.type,
            JSON.stringify(edge.properties),
        );
        return Number(result.lastInsertRowid);
    }

    getEdgesBySource(sourceId: number, type?: GraphEdgeType): GraphEdge[] {
        let query = 'SELECT * FROM edges WHERE source_id = ?';
        const params: unknown[] = [sourceId];
        if (type) {
            query += ' AND type = ?';
            params.push(type);
        }
        const rows = this.db.prepare(query).all(...params) as Array<Record<string, unknown>>;
        return rows.map(r => this.rowToEdge(r));
    }

    getEdgesBySourceBatch(sourceIds: number[]): Map<number, GraphEdge[]> {
        const resultMap = new Map<number, GraphEdge[]>();
        if (sourceIds.length === 0) return resultMap;

        for (const id of sourceIds) resultMap.set(id, []);

        const placeholders = sourceIds.map(() => '?').join(',');
        const rows = this.db.prepare(
            `SELECT * FROM edges WHERE source_id IN (${placeholders})`
        ).all(...sourceIds) as Array<Record<string, unknown>>;

        for (const row of rows) {
            const edge = this.rowToEdge(row);
            const list = resultMap.get(edge.sourceId);
            if (list) list.push(edge);
        }
        return resultMap;
    }

    getEdgesByTargetBatch(targetIds: number[], type?: GraphEdgeType): Map<number, GraphEdge[]> {
        const resultMap = new Map<number, GraphEdge[]>();
        if (targetIds.length === 0) return resultMap;

        for (const id of targetIds) resultMap.set(id, []);

        const placeholders = targetIds.map(() => '?').join(',');
        let query = `SELECT * FROM edges WHERE target_id IN (${placeholders})`;
        const params: unknown[] = [...targetIds];
        if (type) {
            query += ' AND type = ?';
            params.push(type);
        }
        const rows = this.db.prepare(query).all(...params) as Array<Record<string, unknown>>;

        for (const row of rows) {
            const edge = this.rowToEdge(row);
            const list = resultMap.get(edge.targetId);
            if (list) list.push(edge);
        }
        return resultMap;
    }

    getEdgesByTarget(targetId: number, type?: GraphEdgeType): GraphEdge[] {
        let query = 'SELECT * FROM edges WHERE target_id = ?';
        const params: unknown[] = [targetId];
        if (type) {
            query += ' AND type = ?';
            params.push(type);
        }
        const rows = this.db.prepare(query).all(...params) as Array<Record<string, unknown>>;
        return rows.map(r => this.rowToEdge(r));
    }

    findEdges(project: string, types?: GraphEdgeType[], limit?: number): GraphEdge[] {
        const conditions: string[] = ['e.project = ?'];
        const params: unknown[] = [project];

        if (types && types.length > 0) {
            conditions.push(`e.type IN (${types.map(() => '?').join(',')})`);
            params.push(...types);
        }

        const sql = `SELECT * FROM edges e WHERE ${conditions.join(' AND ')} LIMIT ?`;
        params.push(limit ?? 1000);

        const rows = this.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
        return rows.map(r => this.rowToEdge(r));
    }

    // ── Project operations ───────────────────────────────────────

    listProjects(): string[] {
        const rows = this.db.prepare(
            'SELECT DISTINCT project FROM nodes ORDER BY project'
        ).all() as Array<{ project: string }>;
        return rows.map(r => r.project);
    }

    getProjectStats(project: string): { nodes: number; edges: number } {
        const nodeRow = this.db.prepare(
            'SELECT COUNT(*) as cnt FROM nodes WHERE project = ?'
        ).get(project) as { cnt: number };
        const edgeRow = this.db.prepare(
            'SELECT COUNT(*) as cnt FROM edges WHERE project = ?'
        ).get(project) as { cnt: number };
        return { nodes: nodeRow.cnt, edges: edgeRow.cnt };
    }

    deleteProject(project: string): void {
        this.deleteProjectEdgesStmt.run(project);
        this.deleteProjectNodesStmt.run(project);
    }

    deleteNodesByFile(project: string, filePath: string): void {
        // Delete edges connected to nodes in this file first (bidirectional: source + target)
        this.deleteEdgesByFileStmt.run(project, project, filePath, project, filePath);
        this.deleteNodesByFilePathStmt.run(project, filePath);
    }

    // ── Batch operations ─────────────────────────────────────────

    beginTransaction(): void {
        this.db.exec('BEGIN TRANSACTION');
    }

    commitTransaction(): void {
        this.db.exec('COMMIT');
    }

    rollbackTransaction(): void {
        this.db.exec('ROLLBACK');
    }

    // ── Schema ───────────────────────────────────────────────────

    getSchema(): { nodeLabels: string[]; edgeTypes: string[] } {
        const labels = this.db.prepare(
            'SELECT DISTINCT label FROM nodes ORDER BY label'
        ).all() as Array<{ label: string }>;
        const types = this.db.prepare(
            'SELECT DISTINCT type FROM edges ORDER BY type'
        ).all() as Array<{ type: string }>;
        return {
            nodeLabels: labels.map(r => r.label),
            edgeTypes: types.map(r => r.type),
        };
    }

    getNodeTypeCounts(project: string): Record<string, number> {
        const rows = this.db.prepare(
            'SELECT label, COUNT(*) as cnt FROM nodes WHERE project = ? GROUP BY label'
        ).all(project) as Array<{ label: string; cnt: number }>;
        const result: Record<string, number> = {};
        for (const row of rows) {
            result[row.label] = row.cnt;
        }
        return result;
    }

    getEdgeTypeCounts(project: string): Record<string, number> {
        const rows = this.db.prepare(
            'SELECT type, COUNT(*) as cnt FROM edges WHERE project = ? GROUP BY type'
        ).all(project) as Array<{ type: string; cnt: number }>;
        const result: Record<string, number> = {};
        for (const row of rows) {
            result[row.type] = row.cnt;
        }
        return result;
    }

    // ── Helpers ──────────────────────────────────────────────────

    private rowToNode(row: Record<string, unknown>): GraphNode {
        return {
            id: row.id as number,
            project: row.project as string,
            label: row.label as GraphNodeLabel,
            name: row.name as string,
            qualifiedName: row.qualified_name as string,
            filePath: row.file_path as string,
            startLine: row.start_line as number,
            endLine: row.end_line as number,
            properties: JSON.parse((row.properties_json as string) || '{}'),
        };
    }

    private rowToEdge(row: Record<string, unknown>): GraphEdge {
        return {
            id: row.id as number,
            project: row.project as string,
            sourceId: row.source_id as number,
            targetId: row.target_id as number,
            type: row.type as GraphEdgeType,
            properties: JSON.parse((row.properties_json as string) || '{}'),
        };
    }

    // ── Query execution ──────────────────────────────────────────

    executeQuery(project: string, query: string): { rows: Array<Record<string, unknown>> } {
        // Simple Cypher-like query parser
        // Supports: MATCH (n) WHERE n.name = 'X' RETURN n
        const matchMatch = query.match(/MATCH\s*\((\w+)\)\s*(?:WHERE\s+(.+?))?\s*RETURN\s+(.+)/i);
        if (matchMatch) {
            const varName = matchMatch[1];
            const whereClause = matchMatch[2];
            const returnClause = matchMatch[3];

            const conditions: string[] = ['n.project = ?'];
            const params: unknown[] = [project];

            if (whereClause) {
                // Parse: n.name = 'X' or n.label = 'Function'
                const eqMatches = whereClause.matchAll(/(\w+)\.(\w+)\s*=\s*'([^']+)'/g);
                for (const m of eqMatches) {
                    const field = m[2];
                    const value = m[3];
                    if (field === 'name') {
                        conditions.push('n.name = ?');
                        params.push(value);
                    } else if (field === 'label') {
                        conditions.push('n.label = ?');
                        params.push(value);
                    } else if (field === 'qualifiedName' || field === 'qualified_name') {
                        conditions.push('n.qualified_name = ?');
                        params.push(value);
                    }
                }

                // Parse: n.name CONTAINS 'X'
                const containsMatch = whereClause.match(new RegExp(`(\\w+)\\.(\\w+)\\s+CONTAINS\\s+'([^']+)'`));
                if (containsMatch) {
                    const field = containsMatch[2];
                    const value = containsMatch[3];
                    if (field === 'name') {
                        conditions.push('n.name LIKE ?');
                        params.push(`%${value}%`);
                    }
                }
            }

            const whereSQL = conditions.join(' AND ');

            if (returnClause.includes('*') || returnClause.includes(varName)) {
                const rows = this.db.prepare(`SELECT * FROM nodes n WHERE ${whereSQL}`).all(...params) as Array<Record<string, unknown>>;
                return { rows };
            }
        }

        // Fallback: reject raw SQL for security. Only parameterized Cypher queries are supported.
        throw new Error(`Unsupported query format. Use Cypher-like syntax: MATCH (n) WHERE n.name = 'X' RETURN n`);
    }

    // ── ADR (Architecture Decision Records) ──────────────────────

    getADRs(project?: string): Array<{ id: number; project: string; title: string; status: string; content: string; created: string }> {
        // ADRs are stored as nodes with label 'ADR'
        const options: GraphSearchOptions = { label: 'ADR', limit: 1000 };
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
            label: 'ADR',
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

    private buildFtsQuery(query: string): string {
        // Split camelCase and tokenize for FTS5
        const tokens = query
            .replace(/([a-z])([A-Z])/g, '$1 $2')
            .split(/[\s_\-.:/]+/)
            .filter(t => t.length > 0);
        return tokens.map(t => `"${t.replace(/"/g, '""')}"`).join(' OR ');
    }

    private regexToLike(pattern: string): string {
        // Convert regex-like patterns to SQL LIKE patterns.
        // Strip regex metacharacters that are meaningless in file paths/names.
        // Preserve \ (path separator) and | (alternation) for file path patterns.
        const escaped = pattern
            .replace(/[*?^${}()[\]]/g, '')
            .replace(/%/g, '\\%')
            .replace(/_/g, '\\_');
        return '%' + escaped + '%';
    }
}