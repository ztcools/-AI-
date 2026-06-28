/**
 * Knowledge Graph types for structured code analysis.
 * Complementary to the existing vector-based semantic search.
 */

// ── Node types ────────────────────────────────────────────────────

export type GraphNodeLabel =
    | 'Function'
    | 'Method'
    | 'Class'
    | 'Interface'
    | 'Struct'
    | 'Enum'
    | 'Variable'
    | 'Module'
    | 'File'
    | 'Folder'
    | 'Package'
    | 'Route'
    | 'Resource';  // K8s / Infra resources

export interface GraphNode {
    id: number;
    project: string;
    label: GraphNodeLabel;
    name: string;
    qualifiedName: string;
    filePath: string;
    startLine: number;
    endLine: number;
    properties: Record<string, unknown>;
}

// ── Edge types ────────────────────────────────────────────────────

export type GraphEdgeType =
    | 'CALLS'
    | 'IMPORTS'
    | 'INHERITS'
    | 'IMPLEMENTS'
    | 'DECORATES'
    | 'HTTP_CALLS'
    | 'ASYNC_CALLS'
    | 'DATA_FLOWS'
    | 'TYPE_REF'
    | 'CONTAINS'
    | 'CONFIGURES'
    | 'CROSS_HTTP_CALLS'
    | 'CROSS_ASYNC_CALLS'
    | 'CROSS_CHANNEL';

export interface GraphEdge {
    id: number;
    project: string;
    sourceId: number;
    targetId: number;
    type: GraphEdgeType;
    properties: Record<string, unknown>;
}

// ── Search types ──────────────────────────────────────────────────

export interface GraphSearchOptions {
    project?: string;
    query?: string;           // BM25 full-text search
    label?: GraphNodeLabel;
    namePattern?: string;     // Regex pattern on name
    qnPattern?: string;       // Regex pattern on qualified name
    filePattern?: string;     // Regex pattern on file path
    minDegree?: number;
    maxDegree?: number;
    limit?: number;
    offset?: number;
}

export interface GraphSearchResult {
    node: GraphNode;
    score: number;
    inDegree: number;
    outDegree: number;
}

export interface GraphSearchResponse {
    results: GraphSearchResult[];
    total: number;
    hasMore: boolean;
}

// ── Trace types ───────────────────────────────────────────────────

export type TraceDirection = 'inbound' | 'outbound' | 'both';
export type TraceMode = 'calls' | 'data_flow' | 'cross_service';

export interface TraceOptions {
    project: string;
    functionName: string;
    direction?: TraceDirection;
    depth?: number;
    mode?: TraceMode;
    edgeTypes?: GraphEdgeType[];
    includeTests?: boolean;
}

export interface TraceNode {
    node: GraphNode;
    depth: number;
    edgeType: GraphEdgeType;
    isTest: boolean;
}

export interface TraceResult {
    root: GraphNode;
    callers: TraceNode[];
    callees: TraceNode[];
    paths: GraphNode[][];
}

// ── Architecture types ────────────────────────────────────────────

export interface ArchitectureCluster {
    label: string;
    memberCount: number;
    cohesionScore: number;
    topNodes: GraphNode[];
    dominantPackages: string[];
    dominantEdgeTypes: GraphEdgeType[];
}

export interface ArchitectureOverview {
    project: string;
    totalNodes: number;
    totalEdges: number;
    nodeTypes: Record<string, number>;
    edgeTypes: Record<string, number>;
    entryPoints: GraphNode[];
    clusters: ArchitectureCluster[];
    packageTree: PackageTreeNode;
}

export interface PackageTreeNode {
    name: string;
    children: PackageTreeNode[];
    nodeCount: number;
}

// ── Graph Store interface ─────────────────────────────────────────

export interface GraphStore {
    // Lifecycle
    initialize(): void;
    close(): void;

    // Node operations
    upsertNode(node: Omit<GraphNode, 'id'>): number;
    getNodeById(id: number): GraphNode | null;
    getNodeByQN(project: string, qualifiedName: string): GraphNode | null;
    findNodes(options: GraphSearchOptions): GraphSearchResponse;
    getNodeDegree(nodeId: number): { inDegree: number; outDegree: number };

    // Edge operations
    upsertEdge(edge: Omit<GraphEdge, 'id'>): number;
    getEdgesBySource(sourceId: number, type?: GraphEdgeType): GraphEdge[];
    getEdgesByTarget(targetId: number, type?: GraphEdgeType): GraphEdge[];
    findEdges(project: string, types?: GraphEdgeType[], limit?: number): GraphEdge[];

    // Project operations
    listProjects(): string[];
    getProjectStats(project: string): { nodes: number; edges: number };
    deleteProject(project: string): void;

    // Batch operations
    beginTransaction(): void;
    commitTransaction(): void;
    rollbackTransaction(): void;

    // Schema
    getSchema(): { nodeLabels: string[]; edgeTypes: string[] };
}