/**
 * Graph-enhanced code searcher. Combines text search with graph enrichment.
 */
import * as fs from 'fs';
import { GraphStore, GraphNode, GraphSearchOptions, GraphSearchResponse } from './types';
import { escapeRegex } from './utils';

export interface SearchCodeOptions {
    project: string;
    pattern: string;
    filePattern?: string;
    pathFilter?: string;
    mode?: 'compact' | 'full' | 'files';
    context?: number;
    regex?: boolean;
    limit?: number;
}

export interface SearchCodeResult {
    node: GraphNode;
    snippet: string;
    matchLine: number;
    matchContent: string;
}

export interface SearchCodeResponse {
    results: SearchCodeResult[];
    totalGrepMatches: number;
    totalResults: number;
}

export class GraphSearcher {
    private store: GraphStore;

    constructor(store: GraphStore) {
        this.store = store;
    }

    /**
     * Graph-aware code search. Uses grep for text matching, then enriches
     * results with graph structure (deduplication, ranking by importance).
     */
    searchCode(options: SearchCodeOptions): SearchCodeResponse {
        const {
            project,
            pattern,
            filePattern,
            pathFilter,
            mode = 'compact',
            context = 0,
            regex = false,
            limit = 10,
        } = options;

        // 1. Find candidate files from the graph
        const fileOptions: GraphSearchOptions = {
            project,
            limit: 10000,
        };
        if (filePattern) {
            fileOptions.filePattern = filePattern;
        }

        const fileResult = this.store.findNodes(fileOptions);
        const uniqueFiles = new Set<string>();
        for (const r of fileResult.results) {
            uniqueFiles.add(r.node.filePath);
        }

        // 2. Grep through files
        const matches: Array<{ filePath: string; line: number; content: string }> = [];
        for (const filePath of uniqueFiles) {
            if (pathFilter && !new RegExp(pathFilter).test(filePath)) continue;

            try {
                const content = fs.readFileSync(filePath, 'utf-8');
                const lines = content.split('\n');
                const searchRegex = regex ? new RegExp(pattern, 'g') : new RegExp(escapeRegex(pattern), 'gi');

                for (let i = 0; i < lines.length; i++) {
                    // Reset lastIndex — g flag requires it for new strings per ECMAScript
                    searchRegex.lastIndex = 0;
                    if (searchRegex.test(lines[i])) {
                        matches.push({ filePath, line: i + 1, content: lines[i].trim() });
                    }
                }
            } catch {
                // Skip unreadable files
            }
        }

        // 3. Enrich with graph: deduplicate matches into containing functions
        const enriched = this.enrichMatches(matches, project, limit);

        return {
            results: enriched.slice(0, limit),
            totalGrepMatches: matches.length,
            totalResults: enriched.length,
        };
    }

    /**
     * Search the graph for nodes matching criteria.
     */
    searchGraph(options: GraphSearchOptions): GraphSearchResponse {
        return this.store.findNodes(options);
    }

    /**
     * Get source code for a node by qualified name.
     */
    getCodeSnippet(project: string, qualifiedName: string, includeNeighbors: boolean = false): {
        node: GraphNode;
        source: string;
        callers?: string[];
        callees?: string[];
    } | null {
        const node = this.store.getNodeByQN(project, qualifiedName);
        if (!node) return null;

        let source = '';
        try {
            const content = fs.readFileSync(node.filePath, 'utf-8');
            const lines = content.split('\n');
            source = lines.slice(node.startLine - 1, node.endLine).join('\n');
        } catch {
            source = `// Source not available: ${node.filePath}`;
        }

        const result: {
            node: GraphNode;
            source: string;
            callers?: string[];
            callees?: string[];
        } = { node, source };

        if (includeNeighbors) {
            const callerEdges = this.store.getEdgesByTarget(node.id, 'CALLS');
            const calleeEdges = this.store.getEdgesBySource(node.id, 'CALLS');

            result.callers = callerEdges.map(e => {
                const n = this.store.getNodeById(e.sourceId);
                return n ? n.qualifiedName : `id:${e.sourceId}`;
            });
            result.callees = calleeEdges.map(e => {
                const n = this.store.getNodeById(e.targetId);
                return n ? n.qualifiedName : `id:${e.targetId}`;
            });
        }

        return result;
    }

    // ── Private helpers ──────────────────────────────────────────

    private enrichMatches(
        matches: Array<{ filePath: string; line: number; content: string }>,
        project: string,
        limit: number,
    ): SearchCodeResult[] {
        const results: SearchCodeResult[] = [];
        const seenNodes = new Set<number>();

        for (const match of matches) {
            // Find containing function/class for this match
            const nodeResult = this.store.findNodes({
                project,
                filePattern: escapeRegex(match.filePath),
                limit: 100,
            });

            // Find the smallest node that contains this line
            let containingNode: GraphNode | null = null;
            let minSize = Infinity;

            for (const r of nodeResult.results) {
                if (r.node.startLine <= match.line && r.node.endLine >= match.line) {
                    const size = r.node.endLine - r.node.startLine;
                    if (size < minSize && !seenNodes.has(r.node.id)) {
                        containingNode = r.node;
                        minSize = size;
                    }
                }
            }

            if (containingNode) {
                seenNodes.add(containingNode.id);
                results.push({
                    node: containingNode,
                    snippet: match.content,
                    matchLine: match.line,
                    matchContent: match.content,
                });
            } else if (results.length < limit) {
                // Pseudo-node for file-level matches without a known containing node.
                // id: -1 signals this is not a real graph node — must not be passed to
                // graph operations like getNodeDegree() or trace_path().
                results.push({
                    node: {
                        id: -1,
                        project,
                        label: 'File',
                        name: match.filePath.split('/').pop() || match.filePath,
                        qualifiedName: match.filePath,
                        filePath: match.filePath,
                        startLine: match.line,
                        endLine: match.line,
                        properties: {},
                    },
                    snippet: match.content,
                    matchLine: match.line,
                    matchContent: match.content,
                });
            }
        }

        return results;
    }
}