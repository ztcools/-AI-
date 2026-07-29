/**
 * InMemoryGraphBuffer — In-memory graph buffer for pipeline indexing.
 *
 * TS port of codebase-memory-mcp's graph_buffer.c.
 * Accumulates nodes and edges in RAM, then batch-dumps to SQLite.
 * Provides O(1) node lookup by qualified name and edge dedup by key.
 *
 * Design mirrors the C implementation:
 * - nodes: Map<qualifiedName, GraphNode> (primary index)
 * - nodeById: Map<id, GraphNode> (ID lookup)
 * - nodesByLabel: Map<label, GraphNode[]> (secondary index)
 * - nodesByName: Map<name, GraphNode[]> (secondary index)
 * - edges: Map<edgeKey, GraphEdge> (dedup)
 * - edgesBySourceType: Map<"srcId:type", GraphEdge[]> (secondary)
 * - stringIntern: Map<string, string> (dedup common strings)
 */
import {
    GraphNode,
    GraphEdge,
    GraphNodeKind,
    GraphNodeLabel,
    GraphEdgeKind,
    GraphEdgeType,
    GraphSearchResult,
} from './types';

// ── Internal helpers ──────────────────────────────────────────────

/** Identifies a lazily-built secondary index. */
type SecondaryIndexKind = 'label' | 'name' | 'srcType' | 'tgtType' | 'type';

/** Composite edge key for dedup, matching C's "srcID:tgtID:type" format. */
function makeEdgeKey(srcId: number, tgtId: number, type: string): string {
    return `${srcId}:${tgtId}:${type}`;
}

/** Composite key for source-type secondary index. */
function makeSrcTypeKey(srcId: number, type: string): string {
    return `${srcId}:${type}`;
}

/** Composite key for target-type secondary index. */
function makeTgtTypeKey(tgtId: number, type: string): string {
    return `${tgtId}:${type}`;
}

// ── InMemoryGraphBuffer ───────────────────────────────────────────

export class InMemoryGraphBuffer {
    private project: string;
    private nextId: number;

    // ── Node storage ──────────────────────────────────────────────

    /** Primary index: qualifiedName → GraphNode */
    private nodeByQN: Map<string, GraphNode> = new Map();
    /** Primary index: id → GraphNode */
    private nodeById: Map<number, GraphNode> = new Map();

    /** Secondary index: label → GraphNode[] */
    private nodesByLabel: Map<string, GraphNode[]> = new Map();
    /** Secondary index: name → GraphNode[] */
    private nodesByName: Map<string, GraphNode[]> = new Map();

    // ── Edge storage ──────────────────────────────────────────────

    /** Edge dedup index: "srcId:tgtId:type" → GraphEdge */
    private edgeByKey: Map<string, GraphEdge> = new Map();

    /** Secondary: "srcId:type" → GraphEdge[] */
    private edgesBySourceType: Map<string, GraphEdge[]> = new Map();
    /** Secondary: "tgtId:type" → GraphEdge[] */
    private edgesByTargetType: Map<string, GraphEdge[]> = new Map();
    /** Secondary: "type" → GraphEdge[] */
    private edgesByType: Map<string, GraphEdge[]> = new Map();

    /**
     * Which secondary indexes are currently materialized. Secondary indexes are
     * built lazily on first query and dropped on the next mutation, so the
     * insert-heavy indexing path (which never queries them) pays nothing to
     * maintain them — a large win in both CPU and memory at scale.
     */
    private builtIndexes: Set<SecondaryIndexKind> = new Set();

    // ── String intern pool ────────────────────────────────────────

    /**
     * Collapses highly-repetitive fields (label, file_path, edge type)
     * to a single shared copy. Mirrors cbm_gbuf's intern_pool.
     */
    private internPool: Map<string, string> = new Map();

    constructor(project: string) {
        this.project = project;
        this.nextId = 1;
    }

    // ── String interning ──────────────────────────────────────────

    /** Intern a string: identical content shares a single heap copy. */
    private intern(s: string): string {
        const found = this.internPool.get(s);
        if (found !== undefined) return found;
        this.internPool.set(s, s);
        return s;
    }

    // ── Node operations ───────────────────────────────────────────

    /**
     * Upsert a node by qualified name. Returns the temp ID.
     * On QN collision, updates the existing node (src wins semantics).
     * Mirrors cbm_gbuf_upsert_node.
     */
    upsertNode(
        label: GraphNodeLabel,
        name: string,
        qualifiedName: string,
        filePath: string,
        startLine: number,
        endLine: number,
        properties: Record<string, unknown> = {},
        meta?: {
          language?: string;
          signature?: string;
          visibility?: string;
          isExported?: boolean;
          isAsync?: boolean;
          isStatic?: boolean;
          isAbstract?: boolean;
          decorators?: string[];
          typeParameters?: string[];
          returnType?: string;
          docstring?: string;
        },
    ): number {
        let qn = qualifiedName;
        const existing = this.nodeByQN.get(qn);
        if (existing) {
          // Same qualified name. If it's actually the SAME definition (same file,
          // same start line — e.g. a node re-emitted by another pass), update in
          // place ("src wins"). But if it's a DIFFERENT definition that merely
          // shares the qualified name — method overloads (Gson.toJson ×8) or a
          // same-named symbol in another file — overwriting would silently swallow
          // nodes. Disambiguate the QN so both survive.
          const sameDef = existing.filePath === filePath && existing.startLine === startLine;
          if (sameDef) {
            existing.label = this.intern(label) as GraphNodeLabel;
            existing.name = name;
            existing.filePath = this.intern(filePath);
            existing.startLine = startLine;
            existing.endLine = endLine;
            existing.properties = properties;
            if (meta) {
              existing.signature = meta.signature;
              existing.visibility = meta.visibility as any;
              existing.isExported = meta.isExported;
              existing.isAsync = meta.isAsync;
              existing.isStatic = meta.isStatic;
              existing.isAbstract = meta.isAbstract;
              existing.decorators = meta.decorators;
              existing.typeParameters = meta.typeParameters;
              existing.returnType = meta.returnType;
              existing.docstring = meta.docstring;
              if (meta.language) existing.language = meta.language as any;
              if (!existing.properties) existing.properties = {};
              if (meta.language) existing.properties.language = meta.language;
            }
            this.invalidateSecondaryIndexes();
            return existing.id;
          }
          // Different definition sharing the QN — make this one unique.
          qn = `${qualifiedName}@${filePath}:${startLine}`;
        }

        const id = this.nextId++;
        const kind = this.intern(label) as GraphNodeKind;
        const node: GraphNode = {
            id,
            project: this.intern(this.project),
            kind,
            label: kind,
            name,
            qualifiedName: qn,
            filePath: this.intern(filePath),
            startLine,
            endLine,
            language: meta?.language as any,
            signature: meta?.signature,
            visibility: meta?.visibility as any,
            isExported: meta?.isExported,
            isAsync: meta?.isAsync,
            isStatic: meta?.isStatic,
            isAbstract: meta?.isAbstract,
            decorators: meta?.decorators,
            typeParameters: meta?.typeParameters,
            returnType: meta?.returnType,
            docstring: meta?.docstring,
            properties: { ...properties, ...(meta?.language ? { language: meta.language } : {}) },
        };

        this.nodeByQN.set(node.qualifiedName, node);
        this.nodeById.set(id, node);
        this.invalidateSecondaryIndexes();
        return id;
    }

    // ── Lazy secondary index management ───────────────────────────

    /** Drop all materialized secondary indexes (called on any mutation). */
    private invalidateSecondaryIndexes(): void {
        if (this.builtIndexes.size === 0) return;
        this.nodesByLabel.clear();
        this.nodesByName.clear();
        this.edgesBySourceType.clear();
        this.edgesByTargetType.clear();
        this.edgesByType.clear();
        this.builtIndexes.clear();
    }

    /** Build a single secondary index from the primary maps if not present. */
    private ensureIndex(kind: SecondaryIndexKind): void {
        if (this.builtIndexes.has(kind)) return;

        if (kind === 'label' || kind === 'name') {
            const map = kind === 'label' ? this.nodesByLabel : this.nodesByName;
            for (const [, node] of this.nodeByQN) {
                const key = kind === 'label' ? node.kind : node.name;
                let arr = map.get(key);
                if (!arr) { arr = []; map.set(key, arr); }
                arr.push(node);
            }
        } else {
            const map = kind === 'srcType' ? this.edgesBySourceType
                : kind === 'tgtType' ? this.edgesByTargetType
                    : this.edgesByType;
            for (const [, edge] of this.edgeByKey) {
                const edgeKind = edge.kind || edge.type;
                const key = kind === 'srcType' ? makeSrcTypeKey(edge.sourceId, edgeKind)
                    : kind === 'tgtType' ? makeTgtTypeKey(edge.targetId, edgeKind)
                        : edgeKind;
                let arr = map.get(key);
                if (!arr) { arr = []; map.set(key, arr); }
                arr.push(edge);
            }
        }
        this.builtIndexes.add(kind);
    }

    /** Find a node by qualified name. O(1). */
    findNodeByQN(qn: string): GraphNode | null {
        return this.nodeByQN.get(qn) ?? null;
    }

    /** Find a node by temp ID. O(1). */
    findNodeById(id: number): GraphNode | null {
        return this.nodeById.get(id) ?? null;
    }

    /** Find nodes by label. Returns borrowed array. */
    findNodesByLabel(label: string): GraphNode[] {
        this.ensureIndex('label');
        return this.nodesByLabel.get(label) ?? [];
    }

    /** Find nodes by name (exact). Returns borrowed array. */
    findNodesByName(name: string): GraphNode[] {
        this.ensureIndex('name');
        return this.nodesByName.get(name) ?? [];
    }

    /** Count total nodes. */
    nodeCount(): number {
        return this.nodeByQN.size;
    }

    /** Get the next ID (for shared atomic counter in parallel mode). */
    getNextId(): number {
        return this.nextId;
    }

    /** Set the next ID counter (after merging worker gbufs). */
    setNextId(nextId: number): void {
        this.nextId = nextId;
    }

    /**
     * Delete all nodes with a given label. Cascade-deletes referencing edges.
     * Mirrors cbm_gbuf_delete_by_label.
     */
    deleteByLabel(label: string): void {
        // Copy: deleteNodeAndEdges splices the same array, so iterate a snapshot
        const nodes = [...this.findNodesByLabel(label)];
        for (const node of nodes) {
            this.deleteNodeAndEdges(node.id);
        }
    }

    /**
     * Delete all nodes for a given file path. Cascade-deletes edges.
     * Used by incremental indexing to remove stale nodes.
     * Mirrors cbm_gbuf_delete_by_file.
     */
    deleteByFile(filePath: string): void {
        const toDelete: number[] = [];
        for (const [, node] of this.nodeByQN) {
            if (node.filePath === filePath) {
                toDelete.push(node.id);
            }
        }
        for (const id of toDelete) {
            this.deleteNodeAndEdges(id);
        }
    }

    /** Delete a single node and all its referencing edges. */
    private deleteNodeAndEdges(nodeId: number): void {
        const node = this.nodeById.get(nodeId);
        if (!node) return;

        // Remove from primary indexes
        this.nodeByQN.delete(node.qualifiedName);
        this.nodeById.delete(nodeId);

        // Cascade-delete edges referencing this node
        const edgesToDelete: string[] = [];
        for (const [key, edge] of this.edgeByKey) {
            if (edge.sourceId === nodeId || edge.targetId === nodeId) {
                edgesToDelete.push(key);
            }
        }
        for (const key of edgesToDelete) {
            this.edgeByKey.delete(key);
        }

        // Secondary indexes now stale — drop them (rebuilt lazily on next query).
        this.invalidateSecondaryIndexes();
    }

    // ── Edge operations ───────────────────────────────────────────

    /**
     * Insert an edge. Deduplicates by (sourceId, targetId, kind, line, col).
     * On duplicate, merges properties (later wins).
     * Returns the edge temp ID.
     */
    insertEdge(
        sourceId: number,
        targetId: number,
        kind: GraphEdgeKind,
        properties: Record<string, unknown> = {},
        meta?: {
          line?: number;
          column?: number;
          provenance?: string;
          metadata?: Record<string, unknown>;
        },
    ): number {
        const kindStr = this.intern(kind) as GraphEdgeKind;
        const line = meta?.line ?? -1;
        const col = meta?.column ?? -1;
        const key = `${sourceId}:${targetId}:${kindStr}:${line}:${col}`;

        // Check dedup
        const existing = this.edgeByKey.get(key);
        if (existing) {
            existing.properties = { ...existing.properties, ...properties };
            if (meta?.metadata) existing.metadata = { ...existing.metadata, ...meta.metadata };
            return existing.id;
        }

        const id = this.nextId++;
        const edge: GraphEdge = {
            id,
            project: this.intern(this.project),
            sourceId,
            targetId,
            kind: kindStr,
            type: kindStr,
            line: meta?.line,
            column: meta?.column,
            provenance: (meta?.provenance as any) || 'tree-sitter',
            metadata: meta?.metadata,
            properties,
        };

        this.edgeByKey.set(key, edge);
        this.invalidateSecondaryIndexes();
        return id;
    }

    /** Find edges from sourceId with given type. */
    findEdgesBySourceType(sourceId: number, type: string): GraphEdge[] {
        this.ensureIndex('srcType');
        return this.edgesBySourceType.get(makeSrcTypeKey(sourceId, type)) ?? [];
    }

    /** Find edges to targetId with given type. */
    findEdgesByTargetType(targetId: number, type: string): GraphEdge[] {
        this.ensureIndex('tgtType');
        return this.edgesByTargetType.get(makeTgtTypeKey(targetId, type)) ?? [];
    }

    /** Find all edges of a given type. */
    findEdgesByType(type: string): GraphEdge[] {
        this.ensureIndex('type');
        return this.edgesByType.get(type) ?? [];
    }

    /** Count total edges. */
    edgeCount(): number {
        return this.edgeByKey.size;
    }

    /** Count edges of a given type. */
    edgeCountByType(type: string): number {
        this.ensureIndex('type');
        return this.edgesByType.get(type)?.length ?? 0;
    }

    // ── Project-level operations ──────────────────────────────────

    /**
     * Delete all nodes and edges for the current project.
     * Mirrors cbm_gbuf project clear.
     */
    clearProject(): void {
        this.nodeByQN.clear();
        this.nodeById.clear();
        this.nodesByLabel.clear();
        this.nodesByName.clear();
        this.edgeByKey.clear();
        this.edgesBySourceType.clear();
        this.edgesByTargetType.clear();
        this.edgesByType.clear();
        this.builtIndexes.clear();
        this.nextId = 1;
    }

    // ── Iteration ─────────────────────────────────────────────────

    /** Iterate all live nodes. */
    forEachNode(fn: (node: GraphNode) => void): void {
        for (const [, node] of this.nodeByQN) {
            fn(node);
        }
    }

    /** Iterate all edges. */
    forEachEdge(fn: (edge: GraphEdge) => void): void {
        for (const [, edge] of this.edgeByKey) {
            fn(edge);
        }
    }

    /** Get all unique file paths of nodes in the buffer. */
    getAllFiles(): string[] {
        const files = new Set<string>();
        for (const [, node] of this.nodeByQN) {
            files.add(node.filePath);
        }
        return Array.from(files);
    }

    /**
     * Flush all buffered nodes and edges to a SQLite store.
     * Uses a single transaction for maximum throughput.
     * Mirrors the dump phase in cbm_write_db.
     *
     * @param store - The target SQLite store (must implement GraphStore interface)
     * @param options - clearProject: if false, skips DELETE (for incremental). deleteFiles: file paths to delete before insert.
     */
    flushToStore(store: {
        upsertNode(node: Omit<GraphNode, 'id'>): number;
        upsertEdge(edge: Omit<GraphEdge, 'id'>): number;
        beginTransaction(): void;
        commitTransaction(): void;
        rollbackTransaction(): void;
        deleteProject(project: string): void;
        deleteNodesByFile(project: string, filePath: string): void;
    }, options?: { clearProject?: boolean; deleteFiles?: string[] }): { nodes: number; edges: number } {
        let nodeCount = 0;
        let edgeCount = 0;

        // Map buffer-internal IDs → SQLite assigned IDs (for foreign key resolution)
        const idMap = new Map<number, number>();

        store.beginTransaction();
        try {
            if (options?.clearProject !== false) {
                // Full mode: clear all project data
                store.deleteProject(this.project);
            } else if (options?.deleteFiles) {
                // Incremental mode: delete only nodes for specific files
                for (const filePath of options.deleteFiles) {
                    store.deleteNodesByFile(this.project, filePath);
                }
            }

            // Insert all nodes, capturing SQLite IDs
            for (const [, node] of this.nodeByQN) {
                const realId = store.upsertNode({
                    project: node.project,
                    kind: node.kind,
                    label: node.kind,
                    name: node.name,
                    qualifiedName: node.qualifiedName,
                    filePath: node.filePath,
                    startLine: node.startLine,
                    endLine: node.endLine,
                    properties: node.properties,
                });
                idMap.set(node.id, realId);
                nodeCount++;
            }

            // Insert all edges using mapped SQLite IDs
            for (const [, edge] of this.edgeByKey) {
                const realSourceId = idMap.get(edge.sourceId);
                const realTargetId = idMap.get(edge.targetId);
                if (realSourceId === undefined || realTargetId === undefined) {
                    console.warn(`[GraphBuffer] Skipping edge ${edge.id}: source/target node not found`);
                    continue;
                }
                store.upsertEdge({
                    project: edge.project,
                    sourceId: realSourceId,
                    targetId: realTargetId,
                    kind: edge.kind,
                    type: edge.kind,
                    properties: edge.properties,
                });
                edgeCount++;
            }

            store.commitTransaction();
        } catch (e) {
            console.error('[GraphBuffer] flushToStore error:', e);
            try {
                store.rollbackTransaction();
            } catch {
                // Best effort
            }
            throw e;
        }

        return { nodes: nodeCount, edges: edgeCount };
    }

    // ── Schema helpers ────────────────────────────────────────────

    /** Get distinct labels and their counts. */
    getLabelCounts(): Record<string, number> {
        const counts: Record<string, number> = {};
        for (const [, node] of this.nodeByQN) {
            const k = node.kind || node.label;
            counts[k] = (counts[k] ?? 0) + 1;
        }
        return counts;
    }

    /** Get distinct edge kinds and their counts. */
    getEdgeTypeCounts(): Record<string, number> {
        const counts: Record<string, number> = {};
        for (const [, edge] of this.edgeByKey) {
            const k = edge.kind || edge.type;
            counts[k] = (counts[k] ?? 0) + 1;
        }
        return counts;
    }

    // ── For testing ───────────────────────────────────────────────

    /** Get all nodes (for test assertions). */
    getAllNodes(): GraphNode[] {
        return Array.from(this.nodeByQN.values());
    }

    /** Get all edges (for test assertions). */
    getAllEdges(): GraphEdge[] {
        return Array.from(this.edgeByKey.values());
    }
}