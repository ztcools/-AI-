/**
 * Graph Query Functions
 *
 * Higher-level query functions built on top of traversal algorithms.
 * Ported from CodeGraph's graph/queries.ts patterns.
 */
import { GraphNode, GraphEdge, GraphEdgeKind, Subgraph } from './types';
import { SqliteGraphStore } from './graph-store';
import { GraphTraverser } from './traversal';

/**
 * Graph query manager for complex queries.
 */
export class GraphQueryManager {
  private store: SqliteGraphStore;
  private traverser: GraphTraverser;

  constructor(store: SqliteGraphStore) {
    this.store = store;
    this.traverser = new GraphTraverser(store);
  }

  /**
   * Get full context for a node: ancestors, children, incoming/outgoing refs, types, imports.
   */
  getContext(nodeId: number): {
    focal: GraphNode;
    ancestors: GraphNode[];
    children: GraphNode[];
    incomingRefs: Array<{ node: GraphNode; edge: GraphEdge }>;
    outgoingRefs: Array<{ node: GraphNode; edge: GraphEdge }>;
    types: GraphNode[];
    imports: GraphNode[];
  } {
    const focal = this.store.getNodeById(nodeId);
    if (!focal) throw new Error(`Node not found: ${nodeId}`);

    const ancestors = this.traverser.getAncestors(nodeId);
    const children = this.traverser.getChildren(nodeId);

    // Incoming refs (exclude contains — already in ancestors)
    const incomingEdges = this.store.getEdgesByTarget(nodeId).filter(e => e.kind !== 'contains');
    const incomingRefs: Array<{ node: GraphNode; edge: GraphEdge }> = [];
    const inSourceIds = incomingEdges.map(e => e.sourceId);
    if (inSourceIds.length > 0) {
      const inNodes = this.store.getNodesById(inSourceIds);
      for (const edge of incomingEdges) {
        const node = inNodes.get(edge.sourceId);
        if (node) incomingRefs.push({ node, edge });
      }
    }

    // Outgoing refs (exclude contains — already in children)
    const outgoingEdges = this.store.getEdgesBySource(nodeId).filter(e => e.kind !== 'contains');
    const outgoingRefs: Array<{ node: GraphNode; edge: GraphEdge }> = [];
    const outTargetIds = outgoingEdges.map(e => e.targetId);
    if (outTargetIds.length > 0) {
      const outNodes = this.store.getNodesById(outTargetIds);
      for (const edge of outgoingEdges) {
        const node = outNodes.get(edge.targetId);
        if (node) outgoingRefs.push({ node, edge });
      }
    }

    // Type info
    const typeEdgeKinds: GraphEdgeKind[] = ['type_of', 'returns'];
    const types: GraphNode[] = [];
    const seenTypes = new Set<number>();
    for (const kind of typeEdgeKinds) {
      const typeEdges = this.store.getEdgesBySource(nodeId, kind);
      const typeNodeIds = typeEdges.map(e => e.targetId);
      if (typeNodeIds.length > 0) {
        const typeNodes = this.store.getNodesById(typeNodeIds);
        for (const id of typeNodeIds) {
          const tn = typeNodes.get(id);
          if (tn && !seenTypes.has(tn.id)) {
            seenTypes.add(tn.id);
            types.push(tn);
          }
        }
      }
    }

    // Imports from ancestor file
    const imports: GraphNode[] = [];
    const fileNode = ancestors.find(a => a.kind === 'file');
    if (fileNode) {
      const importEdges = this.store.getEdgesBySource(fileNode.id, 'imports');
      const importNodeIds = importEdges.map(e => e.targetId);
      if (importNodeIds.length > 0) {
        const importNodes = this.store.getNodesById(importNodeIds);
        for (const id of importNodeIds) {
          const n = importNodes.get(id);
          if (n) imports.push(n);
        }
      }
    }

    return { focal, ancestors, children, incomingRefs, outgoingRefs, types, imports };
  }

  /**
   * Get files that this file depends on (via resolved symbol edges).
   */
  getFileDependencies(filePath: string): string[] {
    const deps = new Set<string>();
    const nodes = this.store.getNodesByFile('', filePath);
    for (const node of nodes) {
      const outgoing = this.store.getEdgesBySource(node.id);
      for (const edge of outgoing) {
        if (edge.kind === 'contains') continue;
        const target = this.store.getNodeById(edge.targetId);
        if (target && target.filePath !== filePath) {
          deps.add(target.filePath);
        }
      }
    }
    return Array.from(deps);
  }

  /**
   * Get files that depend on this file.
   */
  getFileDependents(filePath: string): string[] {
    const deps = new Set<string>();
    const nodes = this.store.getNodesByFile('', filePath);
    for (const node of nodes) {
      const incoming = this.store.getEdgesByTarget(node.id);
      for (const edge of incoming) {
        if (edge.kind === 'contains') continue;
        const source = this.store.getNodeById(edge.sourceId);
        if (source && source.filePath !== filePath) {
          deps.add(source.filePath);
        }
      }
    }
    return Array.from(deps);
  }

  /**
   * Get all symbols exported by a file.
   */
  getExportedSymbols(filePath: string): GraphNode[] {
    const nodes = this.store.getNodesByFile('', filePath);
    return nodes.filter(n => n.isExported);
  }

  /**
   * Find symbols by qualified name pattern (* wildcard supported).
   */
  findByQualifiedName(pattern: string): GraphNode[] {
    const regexPattern = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.');
    const regex = new RegExp(`^${regexPattern}$`);

    const kinds: GraphNode['kind'][] = [
      'class', 'function', 'method', 'interface', 'type_alias', 'variable', 'constant',
    ];

    const allNodes: GraphNode[] = [];
    for (const kind of kinds) {
      const nodes = this.store.getNodesByKind('', kind);
      for (const node of nodes) {
        if (regex.test(node.qualifiedName)) allNodes.push(node);
      }
    }
    return allNodes;
  }

  /**
   * Get module/package structure as a directory tree.
   */
  getModuleStructure(): Map<string, string[]> {
    const filePaths = this.store.getAllFilePaths('');
    const structure = new Map<string, string[]>();
    for (const fp of filePaths) {
      const parts = fp.split('/');
      const dir = parts.slice(0, -1).join('/') || '.';
      if (!structure.has(dir)) structure.set(dir, []);
      structure.get(dir)!.push(fp);
    }
    return structure;
  }

  /**
   * Find circular dependencies between files.
   */
  findCircularDependencies(filePaths: string[]): string[][] {
    const cycles: string[][] = [];
    const visited = new Set<string>();
    const recursionStack = new Set<string>();

    const dfs = (filePath: string, path: string[]): void => {
      if (recursionStack.has(filePath)) {
        const cycleStart = path.indexOf(filePath);
        if (cycleStart !== -1) cycles.push(path.slice(cycleStart));
        return;
      }
      if (visited.has(filePath)) return;

      visited.add(filePath);
      recursionStack.add(filePath);

      const deps = this.getFileDependencies(filePath);
      for (const dep of deps) {
        dfs(dep, [...path, filePath]);
      }

      recursionStack.delete(filePath);
    };

    for (const fp of filePaths) {
      if (!visited.has(fp)) dfs(fp, []);
    }
    return cycles;
  }

  /**
   * Get complexity metrics for a node.
   */
  getNodeMetrics(nodeId: number): {
    incomingEdgeCount: number;
    outgoingEdgeCount: number;
    callCount: number;
    callerCount: number;
    childCount: number;
    depth: number;
  } {
    const incomingEdges = this.store.getEdgesByTarget(nodeId);
    const outgoingEdges = this.store.getEdgesBySource(nodeId);

    const callEdges = outgoingEdges.filter(e => e.kind === 'calls');
    const callerEdges = incomingEdges.filter(e => e.kind === 'calls');
    const containsEdges = outgoingEdges.filter(e => e.kind === 'contains');

    const ancestors = this.traverser.getAncestors(nodeId);

    return {
      incomingEdgeCount: incomingEdges.length,
      outgoingEdgeCount: outgoingEdges.length,
      callCount: callEdges.length,
      callerCount: callerEdges.length,
      childCount: containsEdges.length,
      depth: ancestors.length,
    };
  }

  /**
   * Find dead code: nodes with no incoming references (excluding contains).
   */
  findDeadCode(kinds?: GraphNode['kind'][]): GraphNode[] {
    const targetKinds = kinds || ['function', 'method', 'class'];
    const deadCode: GraphNode[] = [];

    for (const kind of targetKinds) {
      const nodes = this.store.getNodesByKind('', kind);
      for (const node of nodes) {
        if (node.isExported) continue;

        const incomingEdges = this.store.getEdgesByTarget(node.id);
        const references = incomingEdges.filter(e => e.kind !== 'contains');
        if (references.length === 0) deadCode.push(node);
      }
    }

    return deadCode;
  }

  /**
   * Get subgraph containing nodes matching a filter.
   */
  getFilteredSubgraph(
    filter: (node: GraphNode) => boolean,
    includeEdges: boolean = true,
  ): Subgraph {
    const nodes = new Map<number, GraphNode>();
    const edges: GraphEdge[] = [];

    const kinds: GraphNode['kind'][] = [
      'file', 'module', 'class', 'struct', 'interface', 'trait',
      'function', 'method', 'variable', 'constant', 'enum', 'type_alias',
    ];

    for (const kind of kinds) {
      const kindNodes = this.store.getNodesByKind('', kind);
      for (const node of kindNodes) {
        if (filter(node)) nodes.set(node.id, node);
      }
    }

    if (includeEdges) {
      for (const nodeId of nodes.keys()) {
        const outgoing = this.store.getEdgesBySource(nodeId);
        for (const edge of outgoing) {
          if (nodes.has(edge.targetId)) edges.push(edge);
        }
      }
    }

    return { nodes, edges, roots: [] };
  }

  /** Access the underlying traverser. */
  getTraverser(): GraphTraverser {
    return this.traverser;
  }
}
