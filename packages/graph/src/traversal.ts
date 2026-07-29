/**
 * Graph Traversal Algorithms
 *
 * BFS and DFS traversal for the code knowledge graph.
 * Ported from CodeGraph's graph/traversal.ts patterns.
 */
import {
  GraphNode,
  GraphEdge,
  GraphEdgeKind,
  Subgraph,
  TraversalOptions,
} from './types';
import { SqliteGraphStore } from './graph-store';

// ── Defaults ─────────────────────────────────────────────────────────

const DEFAULT_TRAVERSAL_OPTIONS: Required<TraversalOptions> = {
  maxDepth: Infinity,
  edgeKinds: [],
  nodeKinds: [],
  direction: 'outgoing',
  limit: 1000,
  includeStart: true,
};

// ── Priority ─────────────────────────────────────────────────────────

/** Edge priority for BFS ordering: structural edges before reference edges. */
function edgePriority(kind: GraphEdgeKind): number {
  switch (kind) {
    case 'contains': return 0;
    case 'calls': return 1;
    case 'instantiates': return 2;
    case 'imports': return 3;
    case 'exports': return 3;
    case 'extends': return 4;
    case 'implements': return 4;
    case 'references': return 5;
    default: return 6;
  }
}

// ── Traversal step ──────────────────────────────────────────────────

interface TraversalStep {
  node: GraphNode;
  edge: GraphEdge | null;
  depth: number;
}

// ── GraphTraverser ──────────────────────────────────────────────────

export class GraphTraverser {
  private store: SqliteGraphStore;
  /** Node kinds to exclude from traversal results (noise). */
  private static NOISE_KINDS = new Set(['import', 'variable', 'parameter', 'file', 'enum_member']);

  private isNoise(node: GraphNode): boolean {
    return GraphTraverser.NOISE_KINDS.has(node.kind);
  }

  constructor(store: SqliteGraphStore) {
    this.store = store;
  }

  // ── BFS ──────────────────────────────────────────────────────────

  /**
   * Traverse the graph using breadth-first search.
   * Edges are prioritized: contains > calls > instantiates > references.
   */
  traverseBFS(startId: number, options: TraversalOptions = {}): Subgraph {
    const opts = { ...DEFAULT_TRAVERSAL_OPTIONS, ...options };
    const startNode = this.store.getNodeById(startId);

    if (!startNode) {
      return { nodes: new Map(), edges: [], roots: [] };
    }

    const nodes = new Map<number, GraphNode>();
    const edges: GraphEdge[] = [];
    const visited = new Set<number>();
    const enqueued = new Set<number>([startNode.id]);
    const seenEdges = new Set<string>();
    const edgeKey = (e: GraphEdge) =>
      `${e.sourceId}|${e.targetId}|${e.kind}|${e.line ?? -1}|${e.column ?? -1}`;

    const queue: TraversalStep[] = [{ node: startNode, edge: null, depth: 0 }];

    if (opts.includeStart) {
      nodes.set(startNode.id, startNode);
    }

    while (queue.length > 0 && nodes.size < opts.limit) {
      const step = queue.shift()!;
      const { node, depth } = step;

      if (visited.has(node.id)) continue;
      visited.add(node.id);

      if (depth >= opts.maxDepth) continue;

      // Get adjacent edges, sort by priority
      const adjacentEdges = this.getAdjacentEdges(node.id, opts.direction, opts.edgeKinds);
      adjacentEdges.sort((a, b) => edgePriority(a.kind) - edgePriority(b.kind));

      // Batch-fetch unvisited neighbors
      const wantIds = adjacentEdges
        .map(e => (e.sourceId === node.id ? e.targetId : e.sourceId))
        .filter(id => !visited.has(id) && !enqueued.has(id));
      const neighborNodes = wantIds.length > 0 ? this.store.getNodesById(wantIds) : new Map();

      for (const adjEdge of adjacentEdges) {
        const nextNodeId = adjEdge.sourceId === node.id ? adjEdge.targetId : adjEdge.sourceId;
        const nextNode = neighborNodes.get(nextNodeId) ?? nodes.get(nextNodeId);
        if (!nextNode) continue;

        // Node kind filter
        if (opts.nodeKinds.length > 0 && !opts.nodeKinds.includes(nextNode.kind)) continue;

        // Enqueue each neighbor once
        if (!visited.has(nextNodeId) && !enqueued.has(nextNodeId)) {
          if (nodes.size >= opts.limit) continue;
          enqueued.add(nextNodeId);
          nodes.set(nextNode.id, nextNode);
          queue.push({ node: nextNode, edge: adjEdge, depth: depth + 1 });
        }

        // Record every distinct edge
        const ek = edgeKey(adjEdge);
        if (!seenEdges.has(ek)) {
          seenEdges.add(ek);
          edges.push(adjEdge);
        }
      }
    }

    return { nodes, edges, roots: [startId] };
  }

  // ── DFS ──────────────────────────────────────────────────────────

  traverseDFS(startId: number, options: TraversalOptions = {}): Subgraph {
    const opts = { ...DEFAULT_TRAVERSAL_OPTIONS, ...options };
    const startNode = this.store.getNodeById(startId);

    if (!startNode) {
      return { nodes: new Map(), edges: [], roots: [] };
    }

    const nodes = new Map<number, GraphNode>();
    const edges: GraphEdge[] = [];
    const visited = new Set<number>();

    if (opts.includeStart) {
      nodes.set(startNode.id, startNode);
    }

    this.dfsRecursive(startNode, 0, opts, nodes, edges, visited);

    return { nodes, edges, roots: [startId] };
  }

  private dfsRecursive(
    node: GraphNode,
    depth: number,
    opts: Required<TraversalOptions>,
    nodes: Map<number, GraphNode>,
    edges: GraphEdge[],
    visited: Set<number>,
  ): void {
    if (visited.has(node.id) || nodes.size >= opts.limit || depth >= opts.maxDepth) return;
    visited.add(node.id);

    const adjacentEdges = this.getAdjacentEdges(node.id, opts.direction, opts.edgeKinds);
    const wantIds = adjacentEdges
      .map(e => (e.sourceId === node.id ? e.targetId : e.sourceId))
      .filter(id => !visited.has(id));
    const neighborNodes = wantIds.length > 0 ? this.store.getNodesById(wantIds) : new Map();

    for (const edge of adjacentEdges) {
      if (nodes.size >= opts.limit) break;

      const nextNodeId = edge.sourceId === node.id ? edge.targetId : edge.sourceId;
      if (visited.has(nextNodeId)) continue;

      const nextNode = neighborNodes.get(nextNodeId);
      if (!nextNode) continue;

      if (opts.nodeKinds.length > 0 && !opts.nodeKinds.includes(nextNode.kind)) continue;

      nodes.set(nextNode.id, nextNode);
      edges.push(edge);
      this.dfsRecursive(nextNode, depth + 1, opts, nodes, edges, visited);
    }
  }

  // ── Callers / Callees ───────────────────────────────────────────

  /**
   * Call-like edges for caller/callee traversal.
   * True `calls` edges always win. Only when a node has NO calls edges in this
   * direction do we fall back to `references`/`instantiates` (still a usage
   * relationship). `imports` are never treated as calls — an import is a static
   * module dependency, not an invocation, and including it flooded the call
   * graph with `./module.js` module-node noise.
   */
  private callLikeEdges(nodeId: number, direction: 'incoming' | 'outgoing'): GraphEdge[] {
    const calls = this.getAdjacentEdges(nodeId, direction, ['calls']);
    if (calls.length > 0) return calls;
    return this.getAdjacentEdges(nodeId, direction, ['references', 'instantiates']);
  }

  getCallers(nodeId: number, maxDepth: number = 1): Array<{ node: GraphNode; edge: GraphEdge }> {
    const result: Array<{ node: GraphNode; edge: GraphEdge }> = [];
    const visited = new Set<number>();
    this.getCallersRecursive(nodeId, maxDepth, 0, result, visited);
    return result;
  }

  private getCallersRecursive(
    nodeId: number,
    maxDepth: number,
    currentDepth: number,
    result: Array<{ node: GraphNode; edge: GraphEdge }>,
    visited: Set<number>,
  ): void {
    if (visited.has(nodeId)) return;
    visited.add(nodeId);
    if (currentDepth >= maxDepth) return;

    const incoming = this.callLikeEdges(nodeId, 'incoming');
    if (incoming.length === 0) return;

    const sourceIds = incoming.map(e => e.sourceId);
    const callerNodes = this.store.getNodesById(sourceIds);

    for (const edge of incoming) {
      const callerNode = callerNodes.get(edge.sourceId);
      if (callerNode && !visited.has(callerNode.id) && !this.isNoise(callerNode)) {
        result.push({ node: callerNode, edge });
        this.getCallersRecursive(callerNode.id, maxDepth, currentDepth + 1, result, visited);
      }
    }
  }

  getCallees(nodeId: number, maxDepth: number = 1): Array<{ node: GraphNode; edge: GraphEdge }> {
    const result: Array<{ node: GraphNode; edge: GraphEdge }> = [];
    const visited = new Set<number>();
    this.getCalleesRecursive(nodeId, maxDepth, 0, result, visited);
    return result;
  }

  private getCalleesRecursive(
    nodeId: number,
    maxDepth: number,
    currentDepth: number,
    result: Array<{ node: GraphNode; edge: GraphEdge }>,
    visited: Set<number>,
  ): void {
    if (visited.has(nodeId)) return;
    visited.add(nodeId);
    if (currentDepth >= maxDepth) return;

    const outgoing = this.callLikeEdges(nodeId, 'outgoing');
    if (outgoing.length === 0) return;

    const targetIds = outgoing.map(e => e.targetId);
    const calleeNodes = this.store.getNodesById(targetIds);

    for (const edge of outgoing) {
      const calleeNode = calleeNodes.get(edge.targetId);
      if (calleeNode && !visited.has(calleeNode.id) && !this.isNoise(calleeNode)) {
        result.push({ node: calleeNode, edge });
        this.getCalleesRecursive(calleeNode.id, maxDepth, currentDepth + 1, result, visited);
      }
    }
  }

  // ── Call graph ──────────────────────────────────────────────────

  getCallGraph(nodeId: number, depth: number = 2): Subgraph {
    const focalNode = this.store.getNodeById(nodeId);
    if (!focalNode) {
      return { nodes: new Map(), edges: [], roots: [] };
    }

    const nodes = new Map<number, GraphNode>();
    const edges: GraphEdge[] = [];
    nodes.set(focalNode.id, focalNode);

    const callers = this.getCallers(nodeId, depth);
    for (const { node, edge } of callers) {
      nodes.set(node.id, node);
      edges.push(edge);
    }

    const callees = this.getCallees(nodeId, depth);
    for (const { node, edge } of callees) {
      nodes.set(node.id, node);
      edges.push(edge);
    }

    return { nodes, edges, roots: [nodeId] };
  }

  // ── Type hierarchy ──────────────────────────────────────────────

  getTypeHierarchy(nodeId: number): Subgraph {
    const focalNode = this.store.getNodeById(nodeId);
    if (!focalNode) {
      return { nodes: new Map(), edges: [], roots: [] };
    }

    const nodes = new Map<number, GraphNode>();
    const edges: GraphEdge[] = [];
    const visited = new Set<number>();
    nodes.set(focalNode.id, focalNode);

    this.getTypeAncestors(nodeId, nodes, edges, visited);
    this.getTypeDescendants(nodeId, nodes, edges, visited);

    return { nodes, edges, roots: [nodeId] };
  }

  private getTypeAncestors(
    nodeId: number,
    nodes: Map<number, GraphNode>,
    edges: GraphEdge[],
    visited: Set<number>,
  ): void {
    if (visited.has(nodeId)) return;
    visited.add(nodeId);

    const outgoing = this.getAdjacentEdges(nodeId, 'outgoing', ['extends', 'implements']);
    if (outgoing.length === 0) return;
    const parents = this.store.getNodesById(outgoing.map(e => e.targetId));

    for (const edge of outgoing) {
      const parentNode = parents.get(edge.targetId);
      if (parentNode && !nodes.has(parentNode.id)) {
        nodes.set(parentNode.id, parentNode);
        edges.push(edge);
        this.getTypeAncestors(parentNode.id, nodes, edges, visited);
      }
    }
  }

  private getTypeDescendants(
    nodeId: number,
    nodes: Map<number, GraphNode>,
    edges: GraphEdge[],
    visited: Set<number>,
  ): void {
    if (visited.has(nodeId)) return;
    visited.add(nodeId);

    const incoming = this.getAdjacentEdges(nodeId, 'incoming', ['extends', 'implements']);
    if (incoming.length === 0) return;
    const children = this.store.getNodesById(incoming.map(e => e.sourceId));

    for (const edge of incoming) {
      const childNode = children.get(edge.sourceId);
      if (childNode && !nodes.has(childNode.id)) {
        nodes.set(childNode.id, childNode);
        edges.push(edge);
        this.getTypeDescendants(childNode.id, nodes, edges, visited);
      }
    }
  }

  // ── Usages ──────────────────────────────────────────────────────

  findUsages(nodeId: number): Array<{ node: GraphNode; edge: GraphEdge }> {
    const incoming = this.getAdjacentEdges(nodeId, 'incoming');
    if (incoming.length === 0) return [];

    const sources = this.store.getNodesById(incoming.map(e => e.sourceId));
    const result: Array<{ node: GraphNode; edge: GraphEdge }> = [];
    for (const edge of incoming) {
      const sourceNode = sources.get(edge.sourceId);
      if (sourceNode) result.push({ node: sourceNode, edge });
    }
    return result;
  }

  // ── Impact radius ───────────────────────────────────────────────

  /**
   * Calculate the impact radius of a node.
   * Returns all nodes that could be affected by changes to this node.
   */
  getImpactRadius(nodeId: number, maxDepth: number = 3): Subgraph {
    const focalNode = this.store.getNodeById(nodeId);
    if (!focalNode) {
      return { nodes: new Map(), edges: [], roots: [] };
    }

    const nodes = new Map<number, GraphNode>();
    const edges: GraphEdge[] = [];
    const visited = new Set<number>();
    nodes.set(focalNode.id, focalNode);

    this.getImpactRecursive(nodeId, maxDepth, 0, nodes, edges, visited);

    return { nodes, edges, roots: [nodeId] };
  }

  private getImpactRecursive(
    nodeId: number,
    maxDepth: number,
    currentDepth: number,
    nodes: Map<number, GraphNode>,
    edges: GraphEdge[],
    visited: Set<number>,
  ): void {
    if (visited.has(nodeId)) return;
    visited.add(nodeId);
    if (currentDepth >= maxDepth) return;

    // For container nodes, also traverse into children
    const focalNode = this.store.getNodeById(nodeId);
    if (focalNode) {
      const containerKinds = new Set(['class', 'struct', 'interface', 'trait', 'protocol', 'module', 'enum']);
      if (containerKinds.has(focalNode.kind)) {
        // Use edge batch for contains edges
        const containsEdges = this.store.getEdgesBySource(nodeId, 'contains' as any);
        if (containsEdges.length > 0) {
          const children = this.store.getNodesById(containsEdges.map(e => e.targetId));
          for (const edge of containsEdges) {
            const childNode = children.get(edge.targetId);
            if (childNode && !visited.has(childNode.id)) {
              nodes.set(childNode.id, childNode);
              edges.push(edge);
              this.getImpactRecursive(childNode.id, maxDepth, currentDepth, nodes, edges, visited);
            }
          }
        }
      }
    }

    // Impact = things that truly depend on this node. Use call-like edges
    // (calls, falling back to references/instantiates) — NOT imports, which are
    // static module deps and would inflate the impact radius with module noise.
    const incoming = this.callLikeEdges(nodeId, 'incoming');
    if (incoming.length === 0) return;

    const sources = this.store.getNodesById(incoming.map(e => e.sourceId));

    for (const edge of incoming) {
      const sourceNode = sources.get(edge.sourceId);
      if (!sourceNode) continue;
      edges.push(edge);
      if (!visited.has(sourceNode.id)) {
        nodes.set(sourceNode.id, sourceNode);
        this.getImpactRecursive(sourceNode.id, maxDepth, currentDepth + 1, nodes, edges, visited);
      }
    }
  }

  // ── Path finding ────────────────────────────────────────────────

  /**
   * Find the shortest path between two nodes using BFS.
   * Returns null if no path exists.
   */
  findPath(
    fromId: number,
    toId: number,
    edgeKinds: GraphEdgeKind[] = [],
  ): Array<{ node: GraphNode; edge: GraphEdge | null }> | null {
    const fromNode = this.store.getNodeById(fromId);
    const toNode = this.store.getNodeById(toId);
    if (!fromNode || !toNode) return null;

    // Use bidirectional BFS with contains edges so sibling functions
    // in the same file are reachable (up to file node, down to sibling)
    const kinds = edgeKinds.length > 0 ? edgeKinds : undefined;

    const visited = new Set<number>();
    const queue: Array<{ nodeId: number; path: Array<{ node: GraphNode; edge: GraphEdge | null }> }> = [
      { nodeId: fromId, path: [{ node: fromNode, edge: null }] },
    ];

    while (queue.length > 0) {
      const { nodeId, path } = queue.shift()!;
      if (nodeId === toId) return path;
      if (visited.has(nodeId)) continue;
      visited.add(nodeId);

      const adjacent = this.getAdjacentEdges(nodeId, 'both', kinds || []);
      if (adjacent.length === 0) continue;

      // Deduplicate neighbor IDs
      const neighborIds = new Set<number>();
      for (const e of adjacent) {
        neighborIds.add(e.sourceId === nodeId ? e.targetId : e.sourceId);
      }
      const wantIds = [...neighborIds].filter(id => !visited.has(id));
      const nextNodes = wantIds.length > 0 ? this.store.getNodesById(wantIds) : new Map();

      for (const edge of adjacent) {
        const nextId = edge.sourceId === nodeId ? edge.targetId : edge.sourceId;
        if (visited.has(nextId)) continue;
        const nextNode = nextNodes.get(nextId);
        if (nextNode) {
          queue.push({ nodeId: nextId, path: [...path, { node: nextNode, edge }] });
        }
      }
    }

    return null;
  }

  // ── Containment hierarchy ───────────────────────────────────────

  getAncestors(nodeId: number): GraphNode[] {
    const ancestors: GraphNode[] = [];
    const visited = new Set<number>();
    let currentId = nodeId;

    while (true) {
      if (visited.has(currentId)) break;
      visited.add(currentId);

      const containingEdges = this.store.getEdgesByTarget(currentId, 'contains' as any);
      const firstEdge = containingEdges[0];
      if (!firstEdge) break;

      const parentNode = this.store.getNodeById(firstEdge.sourceId);
      if (parentNode) {
        ancestors.push(parentNode);
        currentId = parentNode.id;
      } else {
        break;
      }
    }

    return ancestors;
  }

  getChildren(nodeId: number): GraphNode[] {
    const containsEdges = this.store.getEdgesBySource(nodeId, 'contains' as any);
    if (containsEdges.length === 0) return [];

    const childNodes = this.store.getNodesById(containsEdges.map(e => e.targetId));
    const children: GraphNode[] = [];
    for (const edge of containsEdges) {
      const childNode = childNodes.get(edge.targetId);
      if (childNode) children.push(childNode);
    }
    return children;
  }

  // ── Adjacent edges helper ───────────────────────────────────────

  private getAdjacentEdges(
    nodeId: number,
    direction: 'outgoing' | 'incoming' | 'both',
    edgeKinds: GraphEdgeKind[] = [],
  ): GraphEdge[] {
    const filter = edgeKinds.length > 0 ? edgeKinds : undefined;

    if (direction === 'outgoing') {
      return (this.store as any).getEdgesBySourceKinds?.(nodeId, filter)
        ?? this.getAdjacentEdgesLegacy(nodeId, direction, filter);
    }
    if (direction === 'incoming') {
      return (this.store as any).getEdgesByTargetKinds?.(nodeId, filter)
        ?? this.getAdjacentEdgesLegacy(nodeId, direction, filter);
    }

    return [
      ...this.getAdjacentEdges(nodeId, 'outgoing', edgeKinds),
      ...this.getAdjacentEdges(nodeId, 'incoming', edgeKinds),
    ];
  }

  /** Fallback for stores without getEdgesBySourceKinds/getEdgesByTargetKinds. */
  private getAdjacentEdgesLegacy(
    nodeId: number,
    direction: 'outgoing' | 'incoming',
    kinds?: GraphEdgeKind[],
  ): GraphEdge[] {
    if (!kinds || kinds.length === 0) {
      return direction === 'outgoing'
        ? this.store.getEdgesBySource(nodeId)
        : this.store.getEdgesByTarget(nodeId);
    }
    const all: GraphEdge[] = [];
    for (const k of kinds) {
      const edges = direction === 'outgoing'
        ? this.store.getEdgesBySource(nodeId, k)
        : this.store.getEdgesByTarget(nodeId, k);
      all.push(...edges);
    }
    return all;
  }
}

// ── Legacy CallTracer (backward compat) ─────────────────────────────

export { GraphTraverser as CallTracer };
