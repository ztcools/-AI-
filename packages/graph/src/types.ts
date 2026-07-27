/**
 * Knowledge Graph types for structured code analysis.
 *
 * Refactored v2 — aligned with CodeGraph's type model:
 * - Richer node/edge metadata (language, signature, visibility, provenance, etc.)
 * - UnresolvedReference / ResolutionResult for the reference resolver pipeline
 * - Traversal types (Subgraph, TraversalOptions, etc.) for graph algorithms
 */

// ── Node kind ────────────────────────────────────────────────────────

export type GraphNodeKind =
  | 'file'
  | 'module'
  | 'class'
  | 'struct'
  | 'interface'
  | 'trait'
  | 'protocol'
  | 'function'
  | 'method'
  | 'property'
  | 'field'
  | 'variable'
  | 'constant'
  | 'enum'
  | 'enum_member'
  | 'type_alias'
  | 'namespace'
  | 'parameter'
  | 'import'
  | 'export'
  | 'route'
  | 'component';

/** Legacy label type — kept for DB compatibility during transition. */
export type GraphNodeLabel = GraphNodeKind;

// ── Edge kind ────────────────────────────────────────────────────────

export type GraphEdgeKind =
  | 'contains'        // parent contains child (file → class, class → method)
  | 'calls'           // function/method calls another
  | 'imports'         // file imports from another
  | 'exports'         // file exports a symbol
  | 'extends'         // class/interface extends another
  | 'implements'      // class implements interface
  | 'references'      // generic reference to another symbol
  | 'type_of'         // variable/parameter has type
  | 'returns'         // function returns type
  | 'instantiates'    // creates instance of class
  | 'overrides'       // method overrides parent method
  | 'decorates'       // decorator applied to symbol
  // Legacy edge kinds (preserved for backward compat)
  | 'DATA_FLOWS'
  | 'http_calls' | 'async_calls'
  | 'cross_http_calls' | 'cross_async_calls' | 'cross_channel'
  | 'handles' | 'configures';

/** Legacy edge type — kept for DB compatibility during transition. */
export type GraphEdgeType = GraphEdgeKind;

// ── Language ─────────────────────────────────────────────────────────

export type GraphLanguage =
  | 'javascript'
  | 'typescript'
  | 'python'
  | 'java'
  | 'cpp'
  | 'go'
  | 'rust'
  | 'csharp'
  | 'scala';

// ── Node ─────────────────────────────────────────────────────────────

export interface GraphNode {
  /** Unique identifier (auto-increment integer) */
  id: number;

  /** Project identity (gitRemote:branch) */
  project: string;

  /** Type of code element */
  kind: GraphNodeKind;

  /** Simple name (e.g. "calculateTotal") */
  name: string;

  /** Fully qualified name (e.g. "src/utils.ts::MathHelper.calculateTotal") */
  qualifiedName: string;

  /** File path relative to project root */
  filePath: string;

  /** Programming language */
  language?: GraphLanguage;

  /** Starting line number (1-indexed) */
  startLine: number;

  /** Ending line number (1-indexed) */
  endLine: number;

  /** Function/method signature (e.g. "(a: number, b: string): boolean") */
  signature?: string;

  /** Documentation string if present */
  docstring?: string;

  /** Visibility modifier */
  visibility?: 'public' | 'private' | 'protected' | 'internal';

  /** Whether symbol is exported */
  isExported?: boolean;

  /** Whether symbol is async */
  isAsync?: boolean;

  /** Whether symbol is static */
  isStatic?: boolean;

  /** Whether symbol is abstract */
  isAbstract?: boolean;

  /** Decorators/annotations applied to this symbol */
  decorators?: string[];

  /** Generic type parameters */
  typeParameters?: string[];

  /** Normalized return type name (bare class name) */
  returnType?: string;

  /** When the node was last updated (epoch ms) */
  updatedAt?: number;

  // ── Legacy fields for backward compat ──────────────────────────────

  /** @deprecated Use `kind` instead. */
  label: GraphNodeLabel;

  /** Extensible properties bag */
  properties: Record<string, unknown>;
}

// ── Edge ─────────────────────────────────────────────────────────────

export interface GraphEdge {
  /** Unique identifier (auto-increment integer) */
  id: number;

  /** Project identity */
  project: string;

  /** Source node ID */
  sourceId: number;

  /** Target node ID */
  targetId: number;

  /** Type of relationship */
  kind: GraphEdgeKind;

  /** Line number where relationship occurs (e.g., call site) */
  line?: number;

  /** Column number where relationship occurs */
  column?: number;

  /** How this edge was created */
  provenance?: 'tree-sitter' | 'heuristic' | 'scip';

  /** Additional structured metadata */
  metadata?: Record<string, unknown>;

  // ── Legacy fields for backward compat ──────────────────────────────

  /** @deprecated Use `kind` instead. */
  type: GraphEdgeType;

  /** Extensible properties bag */
  properties: Record<string, unknown>;
}

// ── File tracking ────────────────────────────────────────────────────

export interface GraphFileRecord {
  /** File path relative to project root */
  path: string;

  /** Content hash for change detection */
  contentHash: string;

  /** Detected language */
  language: GraphLanguage;

  /** File size in bytes */
  size: number;

  /** Last modification timestamp */
  modifiedAt: number;

  /** When last indexed */
  indexedAt: number;

  /** Number of nodes extracted */
  nodeCount: number;

  /** Any extraction errors */
  errors?: string[];
}

// ── Unresolved Reference (for the resolution pipeline) ───────────────

export interface UnresolvedReference {
  /** ID of the node containing the reference */
  fromNodeId: number;

  /** Name being referenced (e.g. "calculateTotal", "pkg.Func") */
  referenceName: string;

  /** Type of reference */
  referenceKind: GraphEdgeKind;

  /** Location of the reference */
  line: number;
  column: number;

  /** File path where reference occurs (denormalized for perf) */
  filePath?: string;

  /** Language of the source file (denormalized for perf) */
  language?: GraphLanguage;

  /** Database row ID for targeted delete/mark (when loaded from DB) */
  rowId?: number;
}

// ── Resolution result ────────────────────────────────────────────────

export interface ResolvedRef {
  /** The original unresolved reference */
  original: UnresolvedReference;

  /** ID of the resolved target node */
  targetNodeId: number;

  /** How the reference was resolved */
  resolvedBy: string;

  /** Confidence score (0-1) */
  confidence: number;
}

export interface ResolutionResult {
  resolved: ResolvedRef[];
  unresolved: UnresolvedReference[];
  deferredChainRefs: UnresolvedReference[];
  stats: {
    total: number;
    resolved: number;
    unresolved: number;
    byMethod: Record<string, number>;
  };
}

// ── Subgraph ─────────────────────────────────────────────────────────

export interface Subgraph {
  /** Nodes in this subgraph */
  nodes: Map<number, GraphNode>;

  /** Edges in this subgraph */
  edges: GraphEdge[];

  /** Root node IDs (entry points) */
  roots: number[];

  /** Retrieval confidence */
  confidence?: 'high' | 'low';
}

// ── Traversal ────────────────────────────────────────────────────────

export interface TraversalOptions {
  /** Maximum depth to traverse (default: Infinity) */
  maxDepth?: number;

  /** Edge kinds to follow (default: all) */
  edgeKinds?: GraphEdgeKind[];

  /** Node kinds to include (default: all) */
  nodeKinds?: GraphNodeKind[];

  /** Direction of traversal */
  direction?: 'outgoing' | 'incoming' | 'both';

  /** Maximum nodes to return */
  limit?: number;

  /** Whether to include the starting node */
  includeStart?: boolean;
}

// ── Search ───────────────────────────────────────────────────────────

export interface GraphSearchOptions {
  project?: string;
  query?: string;           // BM25 full-text search
  kind?: GraphNodeKind;
  namePattern?: string;     // LIKE pattern on name
  qnPattern?: string;       // LIKE pattern on qualified name
  filePattern?: string;     // LIKE pattern on file path
  exactFilePath?: string;   // Exact file path match (overrides filePattern)
  minDegree?: number;
  maxDegree?: number;
  limit?: number;
  offset?: number;
  // Legacy
  label?: GraphNodeLabel;
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

// ── Trace ────────────────────────────────────────────────────────────

export type TraceDirection = 'inbound' | 'outbound' | 'both';
export type TraceMode = 'calls' | 'data_flow' | 'cross_service';

export interface TraceOptions {
  project: string;
  functionName: string;
  direction?: TraceDirection;
  depth?: number;
  mode?: TraceMode;
  edgeTypes?: GraphEdgeKind[];
  includeTests?: boolean;
}

export interface TraceNode {
  node: GraphNode;
  depth: number;
  edgeKind: GraphEdgeKind;
  isTest: boolean;
}

export interface TraceResult {
  root: GraphNode;
  callers: TraceNode[];
  callees: TraceNode[];
  paths: GraphNode[][];
}

// ── Architecture ─────────────────────────────────────────────────────

export interface ArchitectureCluster {
  label: string;
  memberCount: number;
  cohesionScore: number;
  topNodes: GraphNode[];
  dominantPackages: string[];
  dominantEdgeTypes: GraphEdgeKind[];
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

// ── Graph Store interface ────────────────────────────────────────────

export interface GraphStore {
  // Lifecycle
  initialize(): void;
  close(): void;
  checkpoint(): void;

  // Node operations
  upsertNode(node: Omit<GraphNode, 'id'>): number;
  getNodeById(id: number): GraphNode | null;
  getNodesById(ids: number[]): Map<number, GraphNode>;
  getNodeByQN(project: string, qualifiedName: string): GraphNode | null;
  findNodes(options: GraphSearchOptions): GraphSearchResponse;
  getNodeDegree(nodeId: number): { inDegree: number; outDegree: number };
  getNodeDegreesBatch(nodeIds: number[]): Map<number, { inDegree: number; outDegree: number }>;

  // Edge operations
  upsertEdge(edge: Omit<GraphEdge, 'id'>): number;
  getEdgesBySource(sourceId: number, kind?: GraphEdgeKind): GraphEdge[];
  getEdgesBySourceBatch(sourceIds: number[]): Map<number, GraphEdge[]>;
  getEdgesByTarget(targetId: number, kind?: GraphEdgeKind): GraphEdge[];
  getEdgesByTargetBatch(targetIds: number[], kind?: GraphEdgeKind): Map<number, GraphEdge[]>;
  findEdges(project: string, kinds?: GraphEdgeKind[], limit?: number): GraphEdge[];

  // Unresolved reference operations
  getUnresolvedRefsCount(project: string): number;
  getUnresolvedRefsBatch(project: string, limit: number, afterRowId?: number): UnresolvedReference[];
  insertUnresolvedRefs(project: string, refs: UnresolvedReference[]): void;
  deleteResolvedRefsByRowIds(rowIds: number[]): number;
  markRefsFailedByRowIds(rowIds: number[] | Array<{ rowId: number; referenceName: string }>): number;

  // File-level operations
  deleteNodesByFile(project: string, filePath: string): void;

  // Project operations
  listProjects(): string[];
  getProjectStats(project: string): { nodes: number; edges: number };
  deleteProject(project: string): void;

  // Batch operations
  beginTransaction(): void;
  commitTransaction(): void;
  rollbackTransaction(): void;

  // Bulk load mode
  beginBulkLoad(): void;
  endBulkLoad(): void;

  // Chunked deletes
  deleteProjectEdgesChunk(project: string, limit: number): number;
  deleteProjectNodesChunk(project: string, limit: number): number;

  // Schema
  getSchema(): { nodeKinds: string[]; edgeKinds: string[] };
  getNodeKindCounts(project: string): Record<string, number>;
  getEdgeKindCounts(project: string): Record<string, number>;

  // Raw queries
  executeQuery(project: string, query: string): { rows: Array<Record<string, unknown>> };

  // ADR
  getADRs(project?: string): Array<{ id: number; project: string; title: string; status: string; content: string; created: string }>;
  createADR(adr: { project: string; title: string; content: string; status: string }): number;
  updateADR(id: number, updates: { status?: string; content?: string }): void;

  // File path helpers
  getAllFilePaths(project: string): string[];
  getAllNodeNames(project: string): string[];
  iterateNodeNames(project: string): Iterable<string>;
  getNodesByKind(project: string, kind: GraphNodeKind): GraphNode[];
  iterateNodesByKind(project: string, kind: GraphNodeKind): Iterable<GraphNode>;
  getNodesByFile(project: string, filePath: string): GraphNode[];
  getNodesByName(project: string, name: string): GraphNode[];
  getNodesByLowerName(project: string, lowerName: string): GraphNode[];
  getNodesByQualifiedNameExact(project: string, qn: string): GraphNode[];
  getNodesByIds(ids: number[]): Map<number, GraphNode>;
  updateNode(node: GraphNode): void;
  insertEdges(edges: GraphEdge[]): void;
  deleteReferencesByRowIds(rowIds: number[]): number;
  deleteSpecificResolvedReferences(keys: Array<{ fromNodeId: number; referenceName: string; referenceKind: string }>): number;
  markReferencesFailed(keys: Array<{ fromNodeId: number; referenceName: string; referenceKind: string }>): number;
  markReferencesFailedByRowIds(rows: Array<{ rowId: number; referenceName: string }> | number[]): number;
}

// ── Extraction result ────────────────────────────────────────────────

export interface GraphExtractionResult {
  nodes: Array<Omit<GraphNode, 'id' | 'project'>>;
  edges: Array<Omit<GraphEdge, 'id' | 'project'>>;
  unresolvedRefs: UnresolvedReference[];
  errors: Array<{ message: string; severity: 'error' | 'warning'; line?: number }>;
  durationMs: number;
}

// ── Indexing progress ────────────────────────────────────────────────

export interface IndexProgress {
  phase: 'scanning' | 'parsing' | 'storing' | 'resolving' | 'linking';
  current: number;
  total: number;
  currentFile?: string;
}

export interface IndexResult {
  success: boolean;
  filesIndexed: number;
  filesSkipped: number;
  filesErrored: number;
  filesDiscovered?: number;
  nodesCreated: number;
  edgesCreated: number;
  errors: string[];
  durationMs: number;
}

export interface SyncResult {
  filesChecked: number;
  filesAdded: number;
  filesModified: number;
  filesRemoved: number;
  nodesUpdated: number;
  durationMs: number;
  changedFilePaths?: string[];
}
