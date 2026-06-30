/**
 * Graph MCP tool handlers. Extends claude-context with knowledge graph
 * capabilities: search_graph, trace_path, get_code_snippet,
 * get_graph_schema, get_architecture, detect_changes, list_projects,
 * delete_project, index_status.
 *
 * These are internal handlers used by the unified 4-tool interface
 * (index/search/clear/status) in handlers.ts.
 */
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import { execSync } from 'child_process';
import {
    SqliteGraphStore,
    InMemoryGraphBuffer,
    FunctionRegistry,
    GraphExtractor,
    CallTracer,
    GraphSearcher,
    ArchitectureAnalyzer,
    GraphNode,
    GraphNodeLabel,
    GraphSearchOptions,
    TraceOptions,
} from '@zilliz/claude-context-graph';
import { getRepoIdentity } from '@zilliz/claude-context-core';

// Shared directory ignore set for both code and IaC file scanning
// Keep in sync with core's DEFAULT_IGNORE_PATTERNS in context.ts
const IGNORE_DIRS = new Set([
    'node_modules', '.git', 'dist', 'build', '.next', '__pycache__',
    '.venv', 'vendor', 'target', 'coverage', '.nyc_output', '.cache',
    '.idea', '.vscode', '.circleci', 'bin', 'obj', 'out', 'tmp', 'temp',
    '.tox', '.mypy_cache', '.pytest_cache', '.turbo', '.angular', '.nuxt',
    '.svn', '.hg', 'bower_components', '.terraform', '.parcel-cache',
]);

export class GraphToolHandlers {
    private store: SqliteGraphStore;
    private extractor: GraphExtractor;
    private tracer: CallTracer;
    private searcher: GraphSearcher;
    private architecture: ArchitectureAnalyzer;
    /** Track in-progress graph indexing per project (project → {total, current, startTime}) */
    private indexingProgress: Map<string, { total: number; current: number; startTime: number }> = new Map();

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

    /** Get graph indexing progress for a project. Returns null if not indexing. */
    getIndexingProgress(project: string): { total: number; current: number; elapsed: number } | null {
        const progress = this.indexingProgress.get(project);
        if (!progress) return null;
        return {
            total: progress.total,
            current: progress.current,
            elapsed: (Date.now() - progress.startTime) / 1000,
        };
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
                const resolvedFiles = specificFiles.map(f => path.resolve(repoPath, f));
                const existingFiles = resolvedFiles.filter(f => fs.existsSync(f));
                const skippedCount = resolvedFiles.length - existingFiles.length;
                if (skippedCount > 0) {
                    console.warn(`[GraphIndex] ${skippedCount} specified file(s) not found on disk, skipping`);
                }
                files = existingFiles;
                console.log(`[GraphIndex] Incremental indexing ${files.length} specified files for '${project}'`);
            } else if (mode === 'incremental') {
                files = this.detectChangedFilesByExt(repoPath, supportedExts);
                console.log(`[GraphIndex] Incremental indexing ${files.length} detected changed files for '${project}'`);
            } else {
                files = this.scanFiles(repoPath, supportedExts);
                files.push(...this.scanIaCFiles(repoPath));
                console.log(`[GraphIndex] Full indexing ${files.length} files for '${project}'`);
            }

            // ── Phase 1: Extract into InMemoryGraphBuffer ─────────
            const graphBuffer = new InMemoryGraphBuffer(project);
            this.indexingProgress.set(project, { total: files.length, current: 0, startTime });

            let nodeCount = 0;
            let edgeCount = 0;

            for (let i = 0; i < files.length; i++) {
                const filePath = files[i];
                const ext = path.extname(filePath);
                const lang = GraphExtractor.extToLanguage(ext);
                if (!lang) continue;

                const relPath = path.relative(repoPath, filePath);
                // Use async read to avoid blocking the event loop — the vector
                // index runs concurrently and needs the event loop to process
                // Milvus/Embedding network callbacks. sync readFileSync would
                // starve those callbacks for the entire 9000+-file loop.
                const source = await fsPromises.readFile(filePath, 'utf-8');

                const result = this.extractor.extract(source, {
                    project,
                    filePath: relPath,
                    language: lang,
                });

                // Insert nodes into graph buffer, mapping by array index (extractor uses
                // nodes.length as nodeIndex, which is 0-based sequential)
                const idMap = new Map<number, number>();
                for (let nodeIndex = 0; nodeIndex < result.nodes.length; nodeIndex++) {
                    const node = result.nodes[nodeIndex];
                    const realId = graphBuffer.upsertNode(
                        node.label,
                        node.name,
                        node.qualifiedName,
                        node.filePath,
                        node.startLine,
                        node.endLine,
                        node.properties,
                    );
                    idMap.set(nodeIndex, realId);
                }
                nodeCount += result.nodes.length;

                // Insert edges into graph buffer
                for (const edge of result.edges) {
                    const sourceId = idMap.get(edge.sourceId);
                    const targetId = idMap.get(edge.targetId);
                    if (sourceId !== undefined && targetId !== undefined) {
                        graphBuffer.insertEdge(sourceId, targetId, edge.type, edge.properties);
                        edgeCount++;
                    }
                }

                // Update progress (every 10 files)
                if (i % 10 === 0) {
                    this.indexingProgress.set(project, { total: files.length, current: i + 1, startTime });
                }

                // Yield the event loop every 50 files so the vector index
                // (Milvus/Embedding async callbacks) gets CPU time between
                // batches of CPU-bound tree-sitter parsing.
                if (i % 50 === 0) {
                    await new Promise<void>(resolve => setImmediate(resolve));
                }
            }

            console.log(`[GraphIndex] Phase 1 done: ${nodeCount} nodes, ${edgeCount} intra-file edges for '${project}'`);

            // ── Phase 2: Build FunctionRegistry & resolve cross-file calls ──
            const registry = new FunctionRegistry();
            graphBuffer.forEachNode((node: GraphNode) => {
                if (node.label === 'Function' || node.label === 'Method') {
                    registry.add(node.name, node.qualifiedName, node.label);
                }
            });
            console.log(`[GraphIndex] Registry built: ${registry.size()} functions/methods registered`);

            // Build per-file import map from IMPORTS edges
            const crossEdges = this.resolveCrossFileCallsWithRegistry(
                graphBuffer, registry, project,
            );
            edgeCount += crossEdges;

            console.log(`[GraphIndex] Phase 2 done: ${crossEdges} cross-file call edges resolved`);

            // ── Phase 3: Flush to SQLite ──────────────────────────
            console.log(`[GraphIndex] Phase 3: flushing ${nodeCount} nodes, ${edgeCount} edges to SQLite...`);

            // For incremental: delete old nodes for specific files before flushing
            // For full: delete the entire project
            const isIncremental = !!(specificFiles || mode === 'incremental');
            const { nodes: writtenNodes, edges: writtenEdges } = graphBuffer.flushToStore(this.store, {
                clearProject: !isIncremental,
                deleteFiles: isIncremental ? [...new Set(graphBuffer.getAllFiles())] : undefined,
            });
            console.log(`[GraphIndex] Phase 3 done: ${writtenNodes} nodes, ${writtenEdges} edges written`);
            this.indexingProgress.delete(project);

            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
            return {
                content: [{
                    type: 'text',
                    text: `Indexed repository '${project}': ${writtenNodes} nodes, ${writtenEdges} edges in ${elapsed}s`,
                }],
            };
        } catch (error: any) {
            console.error(`[GraphIndex] Error: ${error.message}`, error);
            try {
                this.store.rollbackTransaction();
            } catch {
                // Transaction may already be rolled back by flushToStore
            }
            this.indexingProgress.delete(project);
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
            label: label as GraphNodeLabel,
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

    // ── Structured change detection (for internal use) ───────────

    /** Returns changed files as structured data, avoiding text parsing. */
    detectChangedFiles(args: { project: string; baseBranch?: string }): { changedFiles: string[]; diffBranch: string } | null {
        const { project, baseBranch: baseBranchArg } = args;
        const baseBranch = baseBranchArg || 'main';

        try {
            const nodes = this.store.findNodes({ project, limit: 1 });
            if (nodes.results.length === 0) return null;

            const repoPath = this.findRepoPath(project);
            if (!repoPath) return null;

            let diffBranch = baseBranch;
            try {
                const refHead = execSync('git symbolic-ref refs/remotes/origin/HEAD', {
                    cwd: repoPath, encoding: 'utf-8', timeout: 5000,
                }).trim();
                const detected = refHead.split('/').pop() || 'main';
                diffBranch = detected;
            } catch {
                for (const candidate of ['main', 'master', 'develop']) {
                    try {
                        execSync(`git rev-parse --verify ${candidate}`, {
                            cwd: repoPath, encoding: 'utf-8', timeout: 5000,
                        });
                        diffBranch = candidate;
                        break;
                    } catch { /* try next */ }
                }
            }

            let diffOutput: string;
            try {
                diffOutput = execSync(`git diff --name-only ${diffBranch}...HEAD`, {
                    cwd: repoPath, encoding: 'utf-8', timeout: 10000,
                });
            } catch {
                diffOutput = execSync('git diff --name-only HEAD', {
                    cwd: repoPath, encoding: 'utf-8', timeout: 10000,
                });
                diffBranch = 'HEAD';
            }

            const changedFiles = diffOutput.trim().split('\n').filter(Boolean);
            return { changedFiles, diffBranch };
        } catch {
            return null;
        }
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
            // Use structured detectChangedFiles to avoid code duplication
            const detectResult = this.detectChangedFiles({ project, baseBranch });
            if (!detectResult) {
                const nodes = this.store.findNodes({ project, limit: 1 });
                if (nodes.results.length === 0) {
                    return { content: [{ type: 'text', text: `Project '${project}' not found in graph index.` }] };
                }
                lines.push('Repository not found on disk. Use index_repository to re-index.');
                return { content: [{ type: 'text', text: lines.join('\n') }] };
            }

            const { changedFiles, diffBranch: diffBranchUsed } = detectResult;

            if (diffBranchUsed === 'HEAD' && diffBranchUsed !== baseBranch) {
                lines.push(`Warning: Could not diff against '${baseBranch}', falling back to uncommitted changes only.`);
                lines.push('');
            }

            if (changedFiles.length === 0) {
                lines.push('No changes detected.');
                return { content: [{ type: 'text', text: lines.join('\n') }] };
            }

            lines.push(`Changed files: ${changedFiles.length}`);
            for (const file of changedFiles) {
                lines.push(`  ${file}`);
            }
            lines.push('');

            // Find impacted nodes — query per file since regexToLike strips | separator
            const impactedNodes: GraphNode[] = [];
            const seenNodeIds = new Set<number>();
            for (const file of changedFiles) {
                const fileResult = this.store.findNodes({
                    project,
                    filePattern: file,
                    limit: 100,
                });
                for (const r of fileResult.results) {
                    if (!seenNodeIds.has(r.node.id)) {
                        seenNodeIds.add(r.node.id);
                        impactedNodes.push(r.node);
                    }
                }
            }

            if (impactedNodes.length > 0) {
                lines.push(`Impacted graph nodes: ${impactedNodes.length}`);
                for (const r of impactedNodes) {
                    lines.push(`  ${r.label} ${r.name} (${r.filePath}:${r.startLine})`);
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

        try {
            this.store.beginTransaction();
            this.store.deleteProject(project);
            this.store.commitTransaction();
            return { content: [{ type: 'text', text: `Project '${project}' deleted.` }] };
        } catch (error: any) {
            this.store.rollbackTransaction();
            return { content: [{ type: 'text', text: `Error deleting project '${project}': ${error.message}` }] };
        }
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

    // ── Helpers ──────────────────────────────────────────────────

    /**
     * Resolve cross-file calls using the FunctionRegistry for O(1) lookups.
     * Mirrors codebase-memory-mcp's pass_calls.c resolution strategy.
     */
    private resolveCrossFileCallsWithRegistry(
        graphBuffer: InMemoryGraphBuffer,
        registry: FunctionRegistry,
        project: string,
    ): number {
        let count = 0;

        // Find all IMPORTS edges
        const importEdges = graphBuffer.findEdgesByType('IMPORTS');

        for (const edge of importEdges) {
            const sourceNode = graphBuffer.findNodeById(edge.sourceId);
            const targetNode = graphBuffer.findNodeById(edge.targetId);
            if (!sourceNode || !targetNode) continue;

            // The target node is a Module node with importedName in properties
            const importedName = targetNode.properties.importedName as string;
            if (!importedName) continue;

            // Compute module QN for the source file
            const moduleQN = this.computeModuleQN(project, sourceNode.filePath);

            // Build import map for this file from all IMPORTS edges of the source
            const importMap: Array<{ key: string; val: string }> = [];
            const sourceImports = graphBuffer.findEdgesBySourceType(sourceNode.id, 'IMPORTS');
            for (const impEdge of sourceImports) {
                const impTarget = graphBuffer.findNodeById(impEdge.targetId);
                if (!impTarget) continue;
                const localName = impTarget.properties.importedName as string;
                if (!localName) continue;
                // Resolve the module qn from the import target
                const impModuleQN = this.computeModuleQN(project, impTarget.filePath);
                importMap.push({ key: localName, val: impModuleQN });
            }

            const importKeys = importMap.map((m) => m.key);
            const importVals = importMap.map((m) => m.val);

            // Resolve using the 4-step strategy chain
            const resolution = registry.resolve(
                importedName,
                moduleQN,
                importKeys,
                importVals,
            );

            if (!resolution.qualifiedName) continue;

            // Find the resolved target node in the graph buffer
            const resolvedNode = graphBuffer.findNodeByQN(resolution.qualifiedName);
            if (!resolvedNode || resolvedNode.id === sourceNode.id) continue;

            // Create CALLS edge with cross-file metadata
            graphBuffer.insertEdge(sourceNode.id, resolvedNode.id, 'CALLS', {
                crossFile: true,
                importedName,
                strategy: resolution.strategy,
                confidence: resolution.confidence,
                sourceFile: sourceNode.filePath,
                targetFile: resolvedNode.filePath,
            });
            count++;
        }

        console.log(`[GraphIndex] Resolved ${count} cross-file calls for project '${project}' via registry`);
        return count;
    }

    /** Compute module QN from project and file path. */
    private computeModuleQN(project: string, filePath: string): string {
        // Strip extension and convert / to .
        const noExt = filePath.replace(/\.[^.]+$/, '');
        const parts = noExt.split('/').filter(Boolean);
        // Drop __init__ and index
        const filtered = parts.filter((p) => p !== '__init__' && p !== 'index');
        return [project, ...filtered].join('.');
    }

    private langToExts(lang: string): string[] {
        // Only includes languages supported by GraphExtractor (LANGUAGE_CONFIGS).
        // Adding a language here without adding a parser to extractor.ts is dead code.
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
        // Cache by project identity to avoid repeated O(n) scans
        if (this._repoPathCache.has(project)) {
            return this._repoPathCache.get(project)!;
        }

        // Try to find the repo on disk by scanning common locations
        const homeDir = os.homedir();
        const searchPaths = [
            process.cwd(),
            homeDir,
            path.join(homeDir, 'deploy'),
            path.join(homeDir, 'projects'),
            path.join(homeDir, 'code'),
            path.join(homeDir, 'src'),
            path.join(homeDir, 'work'),
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
                        this._repoPathCache.set(project, fullPath);
                        return fullPath;
                    }
                }
            } catch {
                // Skip
            }
        }
        return null;
    }

    private _repoPathCache: Map<string, string> = new Map();

    private detectChangedFilesByExt(repoPath: string, extensions: string[]): string[] {
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
        } catch (err: any) {
            console.warn(`[Graph] detectChangedFiles failed for ${repoPath}: ${err.message}`);
            return [];
        }
    }

    /**
     * Scan source files using git ls-files. Respects .gitignore automatically
     * and avoids scanning untracked / ignored directories (e.g. test fixtures).
     * Falls back to filesystem walk if git is not available.
     */
    private scanFiles(dir: string, extensions: string[]): string[] {
        const extSet = new Set(extensions);
        const results: string[] = [];

        // Try git ls-files first — respects .gitignore and is much faster
        try {
            const extPatterns = extensions.map((e) => `"*${e}"`).join(' ');
            const output = execSync(`git -C "${dir}" ls-files --cached --others --exclude-standard -- ${extPatterns}`, {
                encoding: 'utf-8',
                timeout: 10_000,
                maxBuffer: 10 * 1024 * 1024,
            });
            const lines = output.trim().split('\n').filter(Boolean);
            for (const line of lines) {
                const fullPath = path.join(dir, line);
                // Only include files that actually exist (--others may list deleted files)
                if (fs.existsSync(fullPath)) {
                    results.push(fullPath);
                }
            }
            return results;
        } catch {
            // Fallback: filesystem walk with IGNORE_DIRS filter
        }

        // Fallback filesystem walk
        const stack: string[] = [dir];
        while (stack.length > 0) {
            const current = stack.pop()!;
            let entries: fs.Dirent[];
            try {
                entries = fs.readdirSync(current, { withFileTypes: true });
            } catch {
                continue;
            }
            for (const entry of entries) {
                if (IGNORE_DIRS.has(entry.name)) continue;
                const fullPath = path.join(current, entry.name);
                if (entry.isDirectory()) {
                    stack.push(fullPath);
                } else if (entry.isFile() && extSet.has(path.extname(entry.name))) {
                    results.push(fullPath);
                }
            }
        }

        return results;
    }

    /**
     * Scan for infrastructure-as-code files: Dockerfiles and K8s manifests.
     * Uses git ls-files when available, falls back to filesystem walk.
     */
    private scanIaCFiles(dir: string): string[] {
        const results: string[] = [];

        try {
            const output = execSync(`git -C "${dir}" ls-files --cached --others --exclude-standard`, {
                encoding: 'utf-8',
                timeout: 10_000,
                maxBuffer: 10 * 1024 * 1024,
            });
            const lines = output.trim().split('\n').filter(Boolean);
            for (const line of lines) {
                const fullPath = path.join(dir, line);
                if (!fs.existsSync(fullPath)) continue;
                const entryName = path.basename(line);
                if (GraphExtractor.isDockerfile(entryName)) {
                    results.push(fullPath);
                }
                const ext = path.extname(entryName);
                if ((ext === '.yaml' || ext === '.yml') && this.isK8sPath(path.dirname(fullPath))) {
                    results.push(fullPath);
                }
            }
            return results;
        } catch {
            // Fallback
        }

        // Fallback filesystem walk
        const stack: string[] = [dir];
        while (stack.length > 0) {
            const current = stack.pop()!;
            let entries: fs.Dirent[];
            try {
                entries = fs.readdirSync(current, { withFileTypes: true });
            } catch {
                continue;
            }
            for (const entry of entries) {
                if (IGNORE_DIRS.has(entry.name)) continue;
                const fullPath = path.join(current, entry.name);
                if (entry.isDirectory()) {
                    stack.push(fullPath);
                } else if (entry.isFile()) {
                    if (GraphExtractor.isDockerfile(entry.name)) {
                        results.push(fullPath);
                    }
                    const ext = path.extname(entry.name);
                    if ((ext === '.yaml' || ext === '.yml') && this.isK8sPath(current)) {
                        results.push(fullPath);
                    }
                }
            }
        }

        return results;
    }

    /**
     * Check if a directory path is likely to contain K8s manifests.
     */
    private isK8sPath(dirPath: string): boolean {
        const k8sKeywords = ['k8s', 'kubernetes', 'deploy', 'deployment', 'infra', 'manifests', 'helm', 'charts'];
        const lower = dirPath.toLowerCase();
        return k8sKeywords.some(kw => lower.includes(kw));
    }
}