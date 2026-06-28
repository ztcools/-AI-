/**
 * Graph MCP tool handlers. Extends claude-context with knowledge graph
 * capabilities: search_graph, trace_path, query_graph, get_code_snippet,
 * get_graph_schema, get_architecture, search_code_graph, detect_changes,
 * list_projects, delete_project, index_status, manage_adr.
 */
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { execSync } from 'child_process';
import {
    SqliteGraphStore,
    GraphExtractor,
    CallTracer,
    GraphSearcher,
    ArchitectureAnalyzer,
    GraphNode,
    GraphSearchOptions,
    GraphSearchResponse,
    TraceOptions,
    escapeRegex,
} from '@zilliz/claude-context-graph';
import { getRepoIdentity } from '@zilliz/claude-context-core';

export class GraphToolHandlers {
    private store: SqliteGraphStore;
    private extractor: GraphExtractor;
    private tracer: CallTracer;
    private searcher: GraphSearcher;
    private architecture: ArchitectureAnalyzer;

    constructor(dbPath?: string) {
        this.store = new SqliteGraphStore(dbPath);
        this.store.initialize();
        this.extractor = new GraphExtractor();
        this.tracer = new CallTracer(this.store);
        this.searcher = new GraphSearcher(this.store);
        this.architecture = new ArchitectureAnalyzer(this.store);
    }

    getStore(): SqliteGraphStore {
        return this.store;
    }

    close(): void {
        this.store.close();
    }

    // ── Tool: index_repository (graph-enhanced) ──────────────────

    async handleIndexRepository(args: Record<string, unknown>): Promise<{ content: Array<{ type: string; text: string }> }> {
        const repoPath = args.repo_path as string;
        const mode = (args.mode as string) || 'full';
        const specificFiles = args.files as string[] | undefined;

        if (!repoPath || !fs.existsSync(repoPath)) {
            return { content: [{ type: 'text', text: `Error: Path '${repoPath}' does not exist.` }] };
        }

        const project = getRepoIdentity(repoPath);
        const startTime = Date.now();

        try {
            const supportedExts = this.extractor.getSupportedLanguages()
                .flatMap((lang: string) => this.langToExts(lang));

            let files: string[];

            if (specificFiles && specificFiles.length > 0) {
                // Incremental: re-index only specified files
                files = specificFiles.map(f => path.resolve(repoPath, f)).filter(f => fs.existsSync(f));
                console.log(`[GraphIndex] Incremental indexing ${files.length} specified files for '${project}'`);
            } else if (mode === 'incremental') {
                // Auto-detect changed files via git diff
                files = this.detectChangedFiles(repoPath, supportedExts);
                console.log(`[GraphIndex] Incremental indexing ${files.length} detected changed files for '${project}'`);
            } else {
                // Full scan
                files = this.scanFiles(repoPath, supportedExts);
                console.log(`[GraphIndex] Full indexing ${files.length} files for '${project}'`);
            }

            let nodeCount = 0;
            let edgeCount = 0;

            this.store.beginTransaction();

            for (const filePath of files) {
                const ext = path.extname(filePath);
                const lang = GraphExtractor.extToLanguage(ext);
                if (!lang) continue;

                const relPath = path.relative(repoPath, filePath);
                const source = fs.readFileSync(filePath, 'utf-8');

                const result = this.extractor.extract(source, {
                    project,
                    filePath: relPath,
                    language: lang,
                });

                // Insert nodes and build temp-index → real-ID mapping
                const idMap = new Map<number, number>();
                for (const node of result.nodes) {
                    const realId = this.store.upsertNode(node);
                    idMap.set(nodeCount + idMap.size, realId);
                }
                nodeCount += result.nodes.length;

                // Resolve edges with real IDs
                for (const edge of result.edges) {
                    const sourceId = idMap.get(edge.sourceId);
                    const targetId = idMap.get(edge.targetId);
                    if (sourceId !== undefined && targetId !== undefined) {
                        this.store.upsertEdge({
                            ...edge,
                            sourceId,
                            targetId,
                        });
                        edgeCount++;
                    }
                }
            }

            // ── Cross-file call resolution ────────────────────────
            const crossEdges = this.resolveCrossFileCalls(project);
            edgeCount += crossEdges;

            this.store.commitTransaction();

            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
            const stats = this.store.getProjectStats(project);

            return {
                content: [{
                    type: 'text',
                    text: `Indexed repository '${project}': ${stats.nodes} nodes, ${stats.edges} edges in ${elapsed}s`,
                }],
            };
        } catch (error: any) {
            this.store.rollbackTransaction();
            return {
                content: [{ type: 'text', text: `Error indexing repository: ${error.message}` }],
            };
        }
    }

    // ── Tool: search_graph ───────────────────────────────────────

    handleSearchGraph(args: Record<string, unknown>): { content: Array<{ type: string; text: string }> } {
        const project = args.project as string;
        const query = args.query as string | undefined;
        const label = args.label as string | undefined;
        const namePattern = args.name_pattern as string | undefined;
        const qnPattern = args.qn_pattern as string | undefined;
        const filePattern = args.file_pattern as string | undefined;
        const minDegree = args.min_degree as number | undefined;
        const maxDegree = args.max_degree as number | undefined;
        const limit = (args.limit as number) || 200;
        const offset = (args.offset as number) || 0;

        if (!project) {
            return { content: [{ type: 'text', text: 'Error: "project" is required.' }] };
        }

        const options: GraphSearchOptions = {
            project,
            query,
            label: label as any,
            namePattern,
            qnPattern,
            filePattern,
            minDegree,
            maxDegree,
            limit,
            offset,
        };

        const result = this.searcher.searchGraph(options);

        const lines: string[] = [];
        lines.push(`Found ${result.total} results${result.hasMore ? ' (more available)' : ''}:`);
        lines.push('');

        for (const r of result.results) {
            lines.push(`- ${r.node.label}: ${r.node.name} (${r.node.qualifiedName})`);
            lines.push(`  File: ${r.node.filePath}:${r.node.startLine}-${r.node.endLine}`);
            lines.push(`  Degree: in=${r.inDegree}, out=${r.outDegree}`);
            if (r.score > 0) lines.push(`  Score: ${r.score.toFixed(2)}`);
            lines.push('');
        }

        return { content: [{ type: 'text', text: lines.join('\n') }] };
    }

    // ── Tool: trace_path ─────────────────────────────────────────

    handleTracePath(args: Record<string, unknown>): { content: Array<{ type: string; text: string }> } {
        const project = args.project as string;
        const functionName = args.function_name as string;
        const direction = (args.direction as string) || 'both';
        const depth = (args.depth as number) || 3;
        const mode = (args.mode as string) || 'calls';
        const includeTests = (args.include_tests as boolean) || false;

        if (!project || !functionName) {
            return { content: [{ type: 'text', text: 'Error: "project" and "function_name" are required.' }] };
        }

        try {
            const result = this.tracer.trace({
                project,
                functionName,
                direction: direction as TraceOptions['direction'],
                depth,
                mode: mode as TraceOptions['mode'],
                includeTests,
            });

            const lines: string[] = [];
            lines.push(`Trace for: ${result.root.name} (${result.root.qualifiedName})`);
            lines.push(`File: ${result.root.filePath}:${result.root.startLine}-${result.root.endLine}`);
            lines.push('');

            if (result.callers.length > 0) {
                lines.push(`Callers (${result.callers.length}):`);
                for (const c of result.callers) {
                    lines.push(`  [depth=${c.depth}] ${c.node.name} (${c.node.qualifiedName})`);
                    lines.push(`    ${c.node.filePath}:${c.node.startLine} (${c.edgeType})`);
                }
                lines.push('');
            }

            if (result.callees.length > 0) {
                lines.push(`Callees (${result.callees.length}):`);
                for (const c of result.callees) {
                    lines.push(`  [depth=${c.depth}] ${c.node.name} (${c.node.qualifiedName})`);
                    lines.push(`    ${c.node.filePath}:${c.node.startLine} (${c.edgeType})`);
                }
                lines.push('');
            }

            return { content: [{ type: 'text', text: lines.join('\n') }] };
        } catch (error: any) {
            return { content: [{ type: 'text', text: `Error tracing path: ${error.message}` }] };
        }
    }

    // ── Tool: get_code_snippet ───────────────────────────────────

    handleGetCodeSnippet(args: Record<string, unknown>): { content: Array<{ type: string; text: string }> } {
        const project = args.project as string;
        const qualifiedName = args.qualified_name as string;
        const includeNeighbors = (args.include_neighbors as boolean) || false;

        if (!project || !qualifiedName) {
            return { content: [{ type: 'text', text: 'Error: "project" and "qualified_name" are required.' }] };
        }

        const result = this.searcher.getCodeSnippet(project, qualifiedName, includeNeighbors);
        if (!result) {
            return { content: [{ type: 'text', text: `Node not found: ${qualifiedName}` }] };
        }

        const lines: string[] = [];
        lines.push(`${result.node.label}: ${result.node.name}`);
        lines.push(`File: ${result.node.filePath}:${result.node.startLine}-${result.node.endLine}`);
        lines.push('```');
        lines.push(result.source);
        lines.push('```');

        if (result.callers && result.callers.length > 0) {
            lines.push(`\nCallers (${result.callers.length}):`);
            for (const c of result.callers) lines.push(`  - ${c}`);
        }
        if (result.callees && result.callees.length > 0) {
            lines.push(`\nCallees (${result.callees.length}):`);
            for (const c of result.callees) lines.push(`  - ${c}`);
        }

        return { content: [{ type: 'text', text: lines.join('\n') }] };
    }

    // ── Tool: get_graph_schema ───────────────────────────────────

    handleGetGraphSchema(args: Record<string, unknown>): { content: Array<{ type: string; text: string }> } {
        const project = args.project as string;
        if (!project) {
            return { content: [{ type: 'text', text: 'Error: "project" is required.' }] };
        }

        const schema = this.store.getSchema();
        const stats = this.store.getProjectStats(project);

        const lines: string[] = [];
        lines.push(`Graph Schema for project '${project}':`);
        lines.push(`Total nodes: ${stats.nodes}, Total edges: ${stats.edges}`);
        lines.push('');
        lines.push(`Node labels (${schema.nodeLabels.length}):`);
        for (const l of schema.nodeLabels) lines.push(`  - ${l}`);
        lines.push('');
        lines.push(`Edge types (${schema.edgeTypes.length}):`);
        for (const t of schema.edgeTypes) lines.push(`  - ${t}`);

        return { content: [{ type: 'text', text: lines.join('\n') }] };
    }

    // ── Tool: get_architecture ───────────────────────────────────

    handleGetArchitecture(args: Record<string, unknown>): { content: Array<{ type: string; text: string }> } {
        const project = args.project as string;
        const pathFilter = args.path as string | undefined;

        if (!project) {
            return { content: [{ type: 'text', text: 'Error: "project" is required.' }] };
        }

        const arch = this.architecture.getArchitecture(project, pathFilter);

        const lines: string[] = [];
        lines.push(`Architecture: ${arch.project}`);
        lines.push(`Nodes: ${arch.totalNodes}, Edges: ${arch.totalEdges}`);
        lines.push('');

        lines.push('Node types:');
        for (const [type, count] of Object.entries(arch.nodeTypes)) {
            lines.push(`  ${type}: ${count}`);
        }
        lines.push('');

        if (arch.entryPoints.length > 0) {
            lines.push(`Entry points (${arch.entryPoints.length}):`);
            for (const ep of arch.entryPoints) {
                lines.push(`  - ${ep.name} (${ep.qualifiedName})`);
            }
            lines.push('');
        }

        if (arch.clusters.length > 0) {
            lines.push(`Clusters (${arch.clusters.length}):`);
            for (const c of arch.clusters.slice(0, 10)) {
                lines.push(`  ${c.label}: ${c.memberCount} nodes, cohesion=${c.cohesionScore.toFixed(2)}`);
            }
        }

        return { content: [{ type: 'text', text: lines.join('\n') }] };
    }

    // ── Tool: search_code (graph-enhanced) ───────────────────────

    handleSearchCode(args: Record<string, unknown>): { content: Array<{ type: string; text: string }> } {
        const project = args.project as string;
        const pattern = args.pattern as string;
        const filePattern = args.file_pattern as string | undefined;
        const pathFilter = args.path_filter as string | undefined;
        const mode = (args.mode as string) || 'compact';
        const context = args.context as number | undefined;
        const regex = (args.regex as boolean) || false;
        const limit = (args.limit as number) || 10;

        if (!project || !pattern) {
            return { content: [{ type: 'text', text: 'Error: "project" and "pattern" are required.' }] };
        }

        const result = this.searcher.searchCode({
            project,
            pattern,
            filePattern,
            pathFilter,
            mode: mode as any,
            context,
            regex,
            limit,
        });

        const lines: string[] = [];
        lines.push(`Graph-enhanced search: "${pattern}"`);
        lines.push(`Total grep matches: ${result.totalGrepMatches}, Enriched results: ${result.totalResults}`);
        lines.push('');

        for (const r of result.results) {
            lines.push(`- ${r.node.label}: ${r.node.name}`);
            lines.push(`  File: ${r.node.filePath}:${r.matchLine}`);
            lines.push(`  ${r.snippet}`);
            lines.push('');
        }

        return { content: [{ type: 'text', text: lines.join('\n') }] };
    }

    // ── Tool: detect_changes ─────────────────────────────────────

    handleDetectChanges(args: Record<string, unknown>): { content: Array<{ type: string; text: string }> } {
        const project = args.project as string;
        const baseBranch = (args.base_branch as string) || 'main';

        if (!project) {
            return { content: [{ type: 'text', text: 'Error: "project" is required.' }] };
        }

        const lines: string[] = [];
        lines.push(`Change detection for project '${project}':`);
        lines.push('');

        try {
            // Find the repo path by looking up the project in the graph
            const nodes = this.store.findNodes({ project, limit: 1 });
            if (nodes.results.length === 0) {
                return { content: [{ type: 'text', text: `Project '${project}' not found in graph index.` }] };
            }

            // Try to find the repo on disk
            const repoPath = this.findRepoPath(project);
            if (!repoPath) {
                lines.push('Repository not found on disk. Use index_repository to re-index.');
                return { content: [{ type: 'text', text: lines.join('\n') }] };
            }

            // Run git diff to find changed files
            let diffOutput: string;
            try {
                diffOutput = execSync(`git diff --name-only ${baseBranch}...HEAD`, {
                    cwd: repoPath,
                    encoding: 'utf-8',
                    timeout: 10000,
                });
            } catch {
                // Try diff against working tree
                diffOutput = execSync('git diff --name-only HEAD', {
                    cwd: repoPath,
                    encoding: 'utf-8',
                    timeout: 10000,
                });
            }

            const changedFiles = diffOutput.trim().split('\n').filter(Boolean);

            if (changedFiles.length === 0) {
                lines.push('No changes detected.');
                return { content: [{ type: 'text', text: lines.join('\n') }] };
            }

            lines.push(`Changed files: ${changedFiles.length}`);
            for (const file of changedFiles) {
                lines.push(`  ${file}`);
            }
            lines.push('');

            // Find impacted nodes
            const result = this.store.findNodes({
                project,
                filePattern: changedFiles.map(f => escapeRegex(f)).join('|'),
                limit: 1000,
            });

            if (result.results.length > 0) {
                lines.push(`Impacted graph nodes: ${result.results.length}`);
                for (const r of result.results) {
                    lines.push(`  ${r.node.label} ${r.node.name} (${r.node.filePath}:${r.node.startLine})`);
                }
            } else {
                lines.push('No graph nodes directly impacted by changes.');
            }

            lines.push('');
            lines.push('Use index_repository with the changed files to update the graph.');
        } catch (error: any) {
            lines.push(`Error: ${error.message}`);
        }

        return { content: [{ type: 'text', text: lines.join('\n') }] };
    }

    // ── Tool: list_projects ──────────────────────────────────────

    handleListProjects(): { content: Array<{ type: string; text: string }> } {
        const projects = this.store.listProjects();
        const lines: string[] = [];

        if (projects.length === 0) {
            lines.push('No indexed projects found.');
        } else {
            lines.push(`Indexed projects (${projects.length}):`);
            for (const p of projects) {
                const stats = this.store.getProjectStats(p);
                lines.push(`  - ${p}: ${stats.nodes} nodes, ${stats.edges} edges`);
            }
        }

        return { content: [{ type: 'text', text: lines.join('\n') }] };
    }

    // ── Tool: delete_project ─────────────────────────────────────

    handleDeleteProject(args: Record<string, unknown>): { content: Array<{ type: string; text: string }> } {
        const project = args.project as string;
        if (!project) {
            return { content: [{ type: 'text', text: 'Error: "project" is required.' }] };
        }

        this.store.deleteProject(project);
        return { content: [{ type: 'text', text: `Project '${project}' deleted.` }] };
    }

    // ── Tool: index_status ───────────────────────────────────────

    handleIndexStatus(args: Record<string, unknown>): { content: Array<{ type: string; text: string }> } {
        const project = args.project as string;
        if (!project) {
            return { content: [{ type: 'text', text: 'Error: "project" is required.' }] };
        }

        const stats = this.store.getProjectStats(project);
        const schema = this.store.getSchema();

        const lines: string[] = [];
        lines.push(`Index status for '${project}':`);
        lines.push(`  Nodes: ${stats.nodes}`);
        lines.push(`  Edges: ${stats.edges}`);
        lines.push(`  Node labels: ${schema.nodeLabels.join(', ') || 'none'}`);
        lines.push(`  Edge types: ${schema.edgeTypes.join(', ') || 'none'}`);

        return { content: [{ type: 'text', text: lines.join('\n') }] };
    }

    // ── Tool: query_graph ────────────────────────────────────────

    handleQueryGraph(args: Record<string, unknown>): { content: Array<{ type: string; text: string }> } {
        const project = args.project as string;
        const query = args.query as string;

        if (!project || !query) {
            return { content: [{ type: 'text', text: 'Error: "project" and "query" are required.' }] };
        }

        try {
            const result = this.store.executeQuery(project, query);
            const lines: string[] = [];

            if (result.rows.length === 0) {
                lines.push('Query returned no results.');
            } else {
                lines.push(`Query results (${result.rows.length} rows):`);
                for (const row of result.rows) {
                    lines.push(`  ${JSON.stringify(row)}`);
                }
            }

            return { content: [{ type: 'text', text: lines.join('\n') }] };
        } catch (error: any) {
            return { content: [{ type: 'text', text: `Query error: ${error.message}` }] };
        }
    }

    // ── Tool: manage_adr ─────────────────────────────────────────

    handleManageAdr(args: Record<string, unknown>): { content: Array<{ type: string; text: string }> } {
        const action = (args.action as string) || 'list';
        const project = args.project as string;
        const title = args.title as string;
        const content = args.content as string;

        const lines: string[] = [];

        switch (action) {
            case 'list': {
                const adrs = this.store.getADRs(project);
                if (adrs.length === 0) {
                    lines.push(project ? `No ADRs for project '${project}'.` : 'No ADRs found.');
                } else {
                    lines.push(`ADRs (${adrs.length}):`);
                    for (const adr of adrs) {
                        lines.push(`  [${adr.id}] ${adr.title} (${adr.status}, ${adr.created})`);
                    }
                }
                break;
            }
            case 'create': {
                if (!project || !title) {
                    return { content: [{ type: 'text', text: 'Error: "project" and "title" are required for create.' }] };
                }
                const id = this.store.createADR({
                    project,
                    title,
                    content: content || '',
                    status: 'proposed',
                });
                lines.push(`ADR created: id=${id}, title="${title}"`);
                break;
            }
            case 'update': {
                const adrId = args.id as number;
                const status = args.status as string;
                if (!adrId) {
                    return { content: [{ type: 'text', text: 'Error: "id" is required for update.' }] };
                }
                this.store.updateADR(adrId, { status, content });
                lines.push(`ADR ${adrId} updated.`);
                break;
            }
            default:
                return { content: [{ type: 'text', text: `Unknown action: ${action}. Use "list", "create", or "update".` }] };
        }

        return { content: [{ type: 'text', text: lines.join('\n') }] };
    }

    // ── Tool: ingest_traces ─────────────────────────────────────

    handleIngestTraces(args: Record<string, unknown>): { content: Array<{ type: string; text: string }> } {
        const project = args.project as string;
        const traces = args.traces as Array<Record<string, unknown>>;

        if (!project || !traces || traces.length === 0) {
            return { content: [{ type: 'text', text: 'Error: "project" and "traces" are required.' }] };
        }

        let count = 0;
        const lines: string[] = [];
        lines.push(`Ingesting ${traces.length} traces for project '${project}':`);

        for (const trace of traces) {
            const sourceService = trace.source_service as string;
            const targetService = trace.target_service as string;
            const method = trace.method as string;
            const path = trace.path as string;
            const statusCode = trace.status_code as number;
            const durationMs = trace.duration_ms as number;

            if (!sourceService || !targetService) continue;

            // Create service nodes
            const sourceQN = `${project}.${sourceService}`;
            const targetQN = `${project}.${targetService}`;

            const sourceId = this.store.upsertNode({
                project,
                label: 'Resource',
                name: sourceService,
                qualifiedName: sourceQN,
                filePath: `service://${sourceService}`,
                startLine: 0,
                endLine: 0,
                properties: { type: 'service' },
            });

            const targetId = this.store.upsertNode({
                project,
                label: 'Resource',
                name: targetService,
                qualifiedName: targetQN,
                filePath: `service://${targetService}`,
                startLine: 0,
                endLine: 0,
                properties: { type: 'service' },
            });

            // Create CROSS_HTTP_CALLS edge
            const edgeType = method === 'GRPC' ? 'CROSS_CHANNEL' as const
                : method === 'MESSAGE' || method === 'EVENT' ? 'CROSS_ASYNC_CALLS' as const
                    : 'CROSS_HTTP_CALLS' as const;

            this.store.upsertEdge({
                project,
                sourceId,
                targetId,
                type: edgeType,
                properties: {
                    method,
                    path,
                    statusCode,
                    durationMs,
                    timestamp: trace.timestamp,
                },
            });

            count++;
            lines.push(`  ${sourceService} --> ${method} ${path} --> ${targetService} (${statusCode || 'n/a'})`);
        }

        lines.push('');
        lines.push(`Ingested ${count} cross-service traces.`);

        return { content: [{ type: 'text', text: lines.join('\n') }] };
    }

    // ── Helpers ──────────────────────────────────────────────────

    /**
     * Resolve cross-file calls by matching imported names to actual
     * function definitions across the project.
     * Returns the number of cross-file CALLS edges created.
     */
    private resolveCrossFileCalls(project: string): number {
        let count = 0;

        // 1. Build global function registry: name → qualifiedName → nodeId
        const allNodes = this.store.findNodes({ project, limit: 100000 });
        const globalRegistry = new Map<string, Array<{ qualifiedName: string; nodeId: number; filePath: string }>>();

        for (const result of allNodes.results) {
            const node = result.node;
            if (node.label === 'Function' || node.label === 'Method') {
                if (!globalRegistry.has(node.name)) {
                    globalRegistry.set(node.name, []);
                }
                globalRegistry.get(node.name)!.push({
                    qualifiedName: node.qualifiedName,
                    nodeId: node.id,
                    filePath: node.filePath,
                });
            }
        }

        // 2. Find all IMPORTS edges
        const importEdges = this.store.findEdges(project, ['IMPORTS'], 100000);

        for (const edge of importEdges) {
            const sourceNode = this.store.getNodeById(edge.sourceId);
            const targetNode = this.store.getNodeById(edge.targetId);
            if (!sourceNode || !targetNode) continue;

            // The target node is a Module node with importedName in properties
            const importedName = targetNode.properties.importedName as string;
            if (!importedName) continue;

            // 3. Resolve imported name to global function definitions
            const candidates = globalRegistry.get(importedName);
            if (!candidates || candidates.length === 0) continue;

            for (const candidate of candidates) {
                // Skip self-references
                if (candidate.nodeId === sourceNode.id) continue;

                // Create CALLS edge: source function → imported function
                try {
                    this.store.upsertEdge({
                        project,
                        sourceId: sourceNode.id,
                        targetId: candidate.nodeId,
                        type: 'CALLS',
                        properties: {
                            crossFile: true,
                            importedName,
                            sourceFile: sourceNode.filePath,
                            targetFile: candidate.filePath,
                        },
                    });
                    count++;
                } catch {
                    // Skip duplicate or invalid edges
                }
            }
        }

        console.log(`[GraphIndex] Resolved ${count} cross-file calls for project '${project}'`);
        return count;
    }

    private langToExts(lang: string): string[] {
        const map: Record<string, string[]> = {
            javascript: ['.js', '.jsx', '.mjs'],
            typescript: ['.ts', '.tsx'],
            python: ['.py'],
            java: ['.java'],
            cpp: ['.cpp', '.c', '.h', '.hpp', '.cc'],
            go: ['.go'],
            rust: ['.rs'],
            csharp: ['.cs'],
        };
        return map[lang] || [];
    }

    private findRepoPath(project: string): string | null {
        // Try to find the repo on disk by scanning common locations
        const searchPaths = [
            process.cwd(),
            path.join(process.env.HOME || '/home', 'deploy'),
            '/home/zt',
        ];

        for (const searchPath of searchPaths) {
            try {
                if (!fs.existsSync(searchPath)) continue;
                const entries = fs.readdirSync(searchPath, { withFileTypes: true });
                for (const entry of entries) {
                    if (!entry.isDirectory()) continue;
                    const fullPath = path.join(searchPath, entry.name);
                    const gitDir = path.join(fullPath, '.git');
                    if (!fs.existsSync(gitDir)) continue;

                    // Check if this repo's identity matches the project
                    const identity = getRepoIdentity(fullPath);
                    if (identity === project) {
                        return fullPath;
                    }
                }
            } catch {
                // Skip
            }
        }
        return null;
    }

    private detectChangedFiles(repoPath: string, extensions: string[]): string[] {
        const extSet = new Set(extensions);
        try {
            const diffOutput = execSync('git diff --name-only HEAD', {
                cwd: repoPath,
                encoding: 'utf-8',
                timeout: 10000,
            }).trim();

            return diffOutput.split('\n')
                .filter((f: string) => Boolean(f))
                .map((f: string) => path.resolve(repoPath, f))
                .filter((f: string) => fs.existsSync(f) && extSet.has(path.extname(f)));
        } catch {
            return [];
        }
    }

    private scanFiles(dir: string, extensions: string[]): string[] {
        const results: string[] = [];
        const extSet = new Set(extensions);
        const ignoreSet = new Set(['node_modules', '.git', 'dist', 'build', '.next', '__pycache__']);

        function walk(current: string) {
            const entries = fs.readdirSync(current, { withFileTypes: true });
            for (const entry of entries) {
                if (ignoreSet.has(entry.name)) continue;
                const fullPath = path.join(current, entry.name);
                if (entry.isDirectory()) {
                    walk(fullPath);
                } else if (entry.isFile() && extSet.has(path.extname(entry.name))) {
                    results.push(fullPath);
                }
            }
        }

        walk(dir);
        return results;
    }
}