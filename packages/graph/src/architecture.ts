/**
 * Architecture analyzer. Provides high-level architecture overview
 * including package structure, entry points, and simple clustering.
 */
import { GraphStore, GraphNode, GraphEdge, ArchitectureOverview, ArchitectureCluster, PackageTreeNode, GraphEdgeType } from './types';

export class ArchitectureAnalyzer {
    private store: GraphStore;

    constructor(store: GraphStore) {
        this.store = store;
    }

    /**
     * Get architecture overview for a project.
     */
    getArchitecture(project: string, pathFilter?: string): ArchitectureOverview {
        const searchResult = this.store.findNodes({
            project,
            filePattern: pathFilter,
            limit: 10000,
        });

        const nodes = searchResult.results.map(r => r.node);
        const stats = this.store.getProjectStats(project);

        if (nodes.length === 0) {
            return {
                project,
                totalNodes: stats.nodes,
                totalEdges: stats.edges,
                nodeTypes: {},
                edgeTypes: {},
                entryPoints: [],
                clusters: [],
                packageTree: { name: project, children: [], nodeCount: 0 },
            };
        }

        // Count node types
        const nodeTypes: Record<string, number> = {};
        for (const node of nodes) {
            nodeTypes[node.label] = (nodeTypes[node.label] || 0) + 1;
        }

        // Count edge types (single pass)
        const schema = this.store.getSchema();
        const edgeTypes: Record<string, number> = {};
        for (const etype of schema.edgeTypes) {
            edgeTypes[etype] = 0;
        }
        const allEdges = this.store.findEdges(project);
        for (const edge of allEdges) {
            edgeTypes[edge.type] = (edgeTypes[edge.type] || 0) + 1;
        }

        // Find entry points: high out-degree, low in-degree nodes
        const entryPoints = this.findEntryPoints(nodes);

        // Build package tree
        const packageTree = this.buildPackageTree(nodes);

        // Simple clustering by directory
        const clusters = this.clusterByDirectory(nodes);

        return {
            project,
            totalNodes: stats.nodes,
            totalEdges: stats.edges,
            nodeTypes,
            edgeTypes,
            entryPoints,
            clusters,
            packageTree,
        };
    }

    // ── Private methods ──────────────────────────────────────────

    private findEntryPoints(nodes: GraphNode[]): GraphNode[] {
        const candidates: Array<{ node: GraphNode; score: number }> = [];

        // Filter to Function/Method nodes first
        const funcNodes = nodes.filter(n => n.label === 'Function' || n.label === 'Method');

        // Batch-load degrees for all candidate nodes to avoid N+1 queries
        const degreeMap = this.store.getNodeDegreesBatch(funcNodes.map(n => n.id));

        for (const node of funcNodes) {
            const { inDegree, outDegree } = degreeMap.get(node.id) || { inDegree: 0, outDegree: 0 };
            const score = outDegree - inDegree * 2;
            if (score > 0) {
                candidates.push({ node, score });
            }
        }

        candidates.sort((a, b) => b.score - a.score);
        return candidates.slice(0, 10).map(c => c.node);
    }

    private buildPackageTree(nodes: GraphNode[]): PackageTreeNode {
        const root: PackageTreeNode = { name: 'root', children: [], nodeCount: 0 };
        const dirMap = new Map<string, PackageTreeNode>();

        for (const node of nodes) {
            const parts = node.filePath.split('/');
            let currentPath = '';

            for (let i = 0; i < parts.length - 1; i++) {
                const prevPath = currentPath;
                currentPath = currentPath ? `${currentPath}/${parts[i]}` : parts[i];

                if (!dirMap.has(currentPath)) {
                    const child: PackageTreeNode = {
                        name: parts[i],
                        children: [],
                        nodeCount: 0,
                    };
                    dirMap.set(currentPath, child);

                    const parent = prevPath ? dirMap.get(prevPath) : root;
                    if (parent) {
                        parent.children.push(child);
                    }
                }

                const dir = dirMap.get(currentPath)!;
                dir.nodeCount++;
            }
        }

        return root;
    }

    private clusterByDirectory(nodes: GraphNode[]): ArchitectureCluster[] {
        const dirGroups = new Map<string, GraphNode[]>();

        for (const node of nodes) {
            const dir = node.filePath.substring(0, node.filePath.lastIndexOf('/')) || 'root';
            if (!dirGroups.has(dir)) {
                dirGroups.set(dir, []);
            }
            dirGroups.get(dir)!.push(node);
        }

        const clusters: ArchitectureCluster[] = [];
        for (const [dir, dirNodes] of dirGroups) {
            if (dirNodes.length < 2) continue; // Skip single-node directories

            // Batch-load edges for all nodes in this cluster to avoid N+1 queries
            const nodeIds = dirNodes.map(n => n.id);
            const edgesBatch = this.store.getEdgesBySourceBatch(nodeIds);

            const edgeTypes = new Set<GraphEdgeType>();
            for (const node of dirNodes) {
                const outEdges = edgesBatch.get(node.id) || [];
                for (const e of outEdges) {
                    edgeTypes.add(e.type);
                }
            }

            clusters.push({
                label: dir,
                memberCount: dirNodes.length,
                cohesionScore: this.calculateCohesion(dirNodes, edgesBatch),
                topNodes: dirNodes.slice(0, 5),
                dominantPackages: [dir],
                dominantEdgeTypes: Array.from(edgeTypes),
            });
        }

        clusters.sort((a, b) => b.memberCount - a.memberCount);
        return clusters.slice(0, 20);
    }

    private calculateCohesion(nodes: GraphNode[], edgesBatch: Map<number, GraphEdge[]>): number {
        if (nodes.length <= 1) return 1.0;

        const nodeIds = new Set(nodes.map(n => n.id));
        let internalEdges = 0;
        let totalEdges = 0;

        for (const node of nodes) {
            const outEdges = edgesBatch.get(node.id) || [];
            for (const edge of outEdges) {
                totalEdges++;
                if (nodeIds.has(edge.targetId)) {
                    internalEdges++;
                }
            }
        }

        return totalEdges > 0 ? internalEdges / totalEdges : 0;
    }
}