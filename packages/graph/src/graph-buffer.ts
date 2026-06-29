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
    GraphNodeLabel,
    GraphEdgeType,
    GraphSearchResult,
} from './types';

// ── Internal helpers ──────────────────────────────────────────────

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
    ): number {
        const existing = this.nodeByQN.get(qualifiedName);
        if (existing) {
            // Update existing node fields (src wins)
            existing.label = label;
            existing.name = name;
            existing.filePath = filePath;
            existing.startLine = startLine;
            existing.endLine = endLine;
            existing.properties = properties;
            // Update secondary indexes
            this.removeFromSecondaryIndexes(existing);
            this.addToSecondaryIndexes(existing);
            return existing.id;
        }

        const id = this.nextId++;
        const node: GraphNode = {
            id,
            project: this.intern(this.project),
            label,
            name: this.intern(name),
            qualifiedName: this.intern(qualifiedName),
            filePath: this.intern(filePath),
            startLine,
            endLine,
            properties,
        };

        this.nodeByQN.set(node.qualifiedName, node);
        this.nodeById.set(id, node);
        this.addToSecondaryIndexes(node);
        return id;
    }

    private addToSecondaryIndexes(node: GraphNode): void {
        // By label
        let labelArr = this.nodesByLabel.get(node.label);
        if (!labelArr) {
            labelArr = [];
            this.nodesByLabel.set(node.label, labelArr);
        }
        labelArr.push(node);

        // By name
        let nameArr = this.nodesByName.get(node.name);
        if (!nameArr) {
            nameArr = [];
            this.nodesByName.set(node.name, nameArr);
        }
        nameArr.push(node);
    }

    private removeFromSecondaryIndexes(node: GraphNode): void {
        const labelArr = this.nodesByLabel.get(node.label);
        if (labelArr) {
            const idx = labelArr.findIndex((n) => n.id === node.id);
            if (idx !== -1) labelArr.splice(idx, 1);
        }

        const nameArr = this.nodesByName.get(node.name);
        if (nameArr) {
            const idx = nameArr.findIndex((n) => n.id === node.id);
            if (idx !== -1) nameArr.splice(idx, 1);
        }
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
        return this.nodesByLabel.get(label) ?? [];
    }

    /** Find nodes by name (exact). Returns borrowed array. */
    findNodesByName(name: string): GraphNode[] {
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

        // Remove from secondary indexes
        this.removeFromSecondaryIndexes(node);

        // Cascade-delete edges
        const edgesToDelete: string[] = [];
        for (const [key, edge] of this.edgeByKey) {
            if (edge.sourceId === nodeId || edge.targetId === nodeId) {
                edgesToDelete.push(key);
            }
        }
        for (const key of edgesToDelete) {
            const edge = this.edgeByKey.get(key);
            if (edge) {
                this.removeEdgeFromSecondaryIndexes(edge);
                this.edgeByKey.delete(key);
            }
        }
    }

    // ── Edge operations ───────────────────────────────────────────

    /**
     * Insert an edge. Deduplicates by (sourceId, targetId, type).
     * On duplicate, merges properties (later wins).
     * Returns the edge temp ID.
     * Mirrors cbm_gbuf_insert_edge.
     */
    insertEdge(
        sourceId: number,
        targetId: number,
        type: GraphEdgeType,
        properties: Record<string, unknown> = {},
    ): number {
        const key = makeEdgeKey(sourceId, targetId, type);

        // Check dedup
        const existing = this.edgeByKey.get(key);
        if (existing) {
            // Merge properties (later wins)
            existing.properties = { ...existing.properties, ...properties };
            return existing.id;
        }

        const id = this.nextId++;
        const edge: GraphEdge = {
            id,
            project: this.intern(this.project),
            sourceId,
            targetId,
            type,
            properties,
        };

        this.edgeByKey.set(key, edge);
        this.addEdgeToSecondaryIndexes(edge);
        return id;
    }

    private addEdgeToSecondaryIndexes(edge: GraphEdge): void {
        // By source+type
        const srcTypeKey = makeSrcTypeKey(edge.sourceId, edge.type);
        let arr = this.edgesBySourceType.get(srcTypeKey);
        if (!arr) {
            arr = [];
            this.edgesBySourceType.set(srcTypeKey, arr);
        }
        arr.push(edge);

        // By target+type
        const tgtTypeKey = makeTgtTypeKey(edge.targetId, edge.type);
        arr = this.edgesByTargetType.get(tgtTypeKey);
        if (!arr) {
            arr = [];
            this.edgesByTargetType.set(tgtTypeKey, arr);
        }
        arr.push(edge);

        // By type
        arr = this.edgesByType.get(edge.type);
        if (!arr) {
            arr = [];
            this.edgesByType.set(edge.type, arr);
        }
        arr.push(edge);
    }

    private removeEdgeFromSecondaryIndexes(edge: GraphEdge): void {
        const removeFrom = (map: Map<string, GraphEdge[]>, key: string) => {
            const arr = map.get(key);
            if (arr) {
                const idx = arr.findIndex((e) => e.id === edge.id);
                if (idx !== -1) arr.splice(idx, 1);
            }
        };

        removeFrom(this.edgesBySourceType, makeSrcTypeKey(edge.sourceId, edge.type));
        removeFrom(this.edgesByTargetType, makeTgtTypeKey(edge.targetId, edge.type));
        removeFrom(this.edgesByType, edge.type);
    }

    /** Find edges from sourceId with given type. */
    findEdgesBySourceType(sourceId: number, type: string): GraphEdge[] {
        return this.edgesBySourceType.get(makeSrcTypeKey(sourceId, type)) ?? [];
    }

    /** Find edges to targetId with given type. */
    findEdgesByTargetType(targetId: number, type: string): GraphEdge[] {
        return this.edgesByTargetType.get(makeTgtTypeKey(targetId, type)) ?? [];
    }

    /** Find all edges of a given type. */
    findEdgesByType(type: string): GraphEdge[] {
        return this.edgesByType.get(type) ?? [];
    }

    /** Count total edges. */
    edgeCount(): number {
        return this.edgeByKey.size;
    }

    /** Count edges of a given type. */
    edgeCountByType(type: string): number {
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
                    label: node.label,
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
                    type: edge.type,
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
            counts[node.label] = (counts[node.label] ?? 0) + 1;
        }
        return counts;
    }

    /** Get distinct edge types and their counts. */
    getEdgeTypeCounts(): Record<string, number> {
        const counts: Record<string, number> = {};
        for (const [, edge] of this.edgeByKey) {
            counts[edge.type] = (counts[edge.type] ?? 0) + 1;
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