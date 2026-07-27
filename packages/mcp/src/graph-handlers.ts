/**
 * Graph MCP tool handlers — v2.
 *
 * Uses the new GraphIndexer, GraphTraverser, and ReferenceResolver
 * for precise code structure understanding.
 */
import * as path from 'path';
import * as fs from 'fs';
import { execSync } from 'child_process';
import {
  SqliteGraphStore,
  GraphIndexer,
  GraphTraverser,
  GraphSearcher,
  ArchitectureAnalyzer,
  GraphNode,
  GraphSearchOptions,
  IndexProgress,
  TraceOptions,
  type GraphIndexerOptions,
} from '@seeway/claude-context-graph';
import { getRepoIdentity } from '@seeway/claude-context-core';

export class GraphToolHandlers {
  private store: SqliteGraphStore;
  private traverser: GraphTraverser;
  private searcher: GraphSearcher;
  private architecture: ArchitectureAnalyzer;
  private indexer: GraphIndexer | null = null;
  private projectDir: string | null = null;
  private project: string | null = null;

  /** Track in-progress indexing per project */
  private indexingProgress: Map<string, { total: number; current: number; startTime: number }> = new Map();
  private activeIndexing: Set<string> = new Set();

  /**
   * Create handlers. If projectDir is provided, the graph DB is stored
   * at `<projectDir>/.context/graph/knowledge-graph.db`.
   * Otherwise falls back to a global DB (backward compat for tests).
   */
  constructor(projectDir?: string) {
    this.store = new SqliteGraphStore(projectDir || process.cwd());
    this.store.initialize();
    this.traverser = new GraphTraverser(this.store);
    this.searcher = new GraphSearcher(this.store);
    this.architecture = new ArchitectureAnalyzer(this.store);

    if (projectDir) {
      this.projectDir = projectDir;
      this.project = getRepoIdentity(projectDir);
    }
  }

  /** Set/update the active project directory. Re-opens the store at the new project. */
  setProject(projectDir: string): void {
    if (this.projectDir === projectDir) return;
    // Close old store, open new one at project's .context/graph/
    this.store.close();
    this.store = new SqliteGraphStore(projectDir);
    this.store.initialize();
    this.traverser = new GraphTraverser(this.store);
    this.searcher = new GraphSearcher(this.store);
    this.architecture = new ArchitectureAnalyzer(this.store);
    this.projectDir = projectDir;
    this.project = getRepoIdentity(projectDir);
  }

  getStore(): SqliteGraphStore {
    return this.store;
  }

  getTraverser(): GraphTraverser {
    return this.traverser;
  }

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
    this.indexer?.close();
  }

  // ── Tool: index_repository ───────────────────────────────────────

  async handleIndexRepository(args: Record<string, unknown>): Promise<{ content: Array<{ type: string; text: string }> }> {
    const repoPath = (args.repo_path as string) || this.projectDir || process.cwd();
    const mode = (args.mode as string) || 'full';
    const specificFiles = args.files as string[] | undefined;

    if (!fs.existsSync(repoPath)) {
      return { content: [{ type: 'text', text: `Error: Path '${repoPath}' does not exist.` }] };
    }

    const project = getRepoIdentity(repoPath);
    this.setProject(repoPath);

    if (this.activeIndexing.has(project)) {
      return { content: [{ type: 'text', text: `Graph indexing already in progress for '${project}', skipping.` }] };
    }
    this.activeIndexing.add(project);

    try {
      const indexer = new GraphIndexer(repoPath, project);
      this.indexer = indexer;

      const options: GraphIndexerOptions = {
        force: (args.force as boolean) || false,
        signal: undefined,
        onProgress: (progress: IndexProgress) => {
          this.indexingProgress.set(project, {
            total: progress.total,
            current: progress.current,
            startTime: Date.now(),
          });
        },
      };

      if (specificFiles && specificFiles.length > 0) {
        options.files = specificFiles;
      }

      const result = await indexer.indexAll(options);
      this.indexingProgress.delete(project);

      if (result.success) {
        const elapsed = (result.durationMs / 1000).toFixed(1);
        return {
          content: [{
            type: 'text',
            text: `Indexed '${project}': ${result.nodesCreated} nodes, ${result.edgesCreated} edges in ${elapsed}s (${result.filesIndexed} files)`,
          }],
        };
      } else {
        return {
          content: [{
            type: 'text',
            text: `Indexing '${project}' completed with errors: ${result.errors.slice(0, 5).join('; ')}`,
          }],
        };
      }
    } catch (error: any) {
      console.error(`[GraphIndex] Error: ${error.message}`, error);
      this.indexingProgress.delete(project);
      return {
        content: [{ type: 'text', text: `Error indexing repository: ${error.message}` }],
      };
    } finally {
      this.activeIndexing.delete(project);
    }
  }

  // ── Tool: search_graph ───────────────────────────────────────────

  handleSearchGraph(args: Record<string, unknown>): { content: Array<{ type: string; text: string }> } {
    const project = (args.project as string) || this.project;
    const query = args.query as string | undefined;
    const kind = args.kind as string || args.label as string | undefined;
    const namePattern = args.name_pattern as string | undefined;
    const qnPattern = args.qn_pattern as string | undefined;
    const filePattern = args.file_pattern as string | undefined;
    const limit = (args.limit as number) || 200;
    const offset = (args.offset as number) || 0;

    if (!project) {
      return { content: [{ type: 'text', text: 'Error: "project" is required.' }] };
    }

    const options: GraphSearchOptions = {
      project,
      query,
      kind: kind as any,
      label: kind as any,
      namePattern,
      qnPattern,
      filePattern,
      limit,
      offset,
    };

    const result = this.searcher.searchGraph(options);

    const lines: string[] = [];
    lines.push(`Found ${result.total} results${result.hasMore ? ' (more available)' : ''}:`);
    lines.push('');

    for (const r of result.results) {
      const n = r.node;
      lines.push(`- ${n.kind}: ${n.name} (${n.qualifiedName})`);
      lines.push(`  File: ${n.filePath}:${n.startLine}-${n.endLine}`);
      if (n.signature) lines.push(`  Sig: ${n.signature}`);
      lines.push(`  Degree: in=${r.inDegree}, out=${r.outDegree}`);
      if (r.score > 0) lines.push(`  Score: ${r.score.toFixed(2)}`);
      lines.push('');
    }

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }

  // ── Tool: trace_path ─────────────────────────────────────────────

  handleTracePath(args: Record<string, unknown>): { content: Array<{ type: string; text: string }> } {
    const project = (args.project as string) || this.project;
    const functionName = args.function_name as string;
    const direction = (args.direction as string) || 'both';
    const depth = (args.depth as number) || 3;

    if (!project || !functionName) {
      return { content: [{ type: 'text', text: 'Error: "project" and "function_name" are required.' }] };
    }

    // Find the node
    const nodeResult = this.store.findNodes({
      project,
      namePattern: functionName,
      limit: 1,
    });

    let root: GraphNode | null = null;
    if (nodeResult.results.length > 0) {
      root = nodeResult.results[0].node;
    } else {
      // Try qualified name
      const qnResult = this.store.findNodes({ project, qnPattern: functionName, limit: 1 });
      if (qnResult.results.length > 0) {
        root = qnResult.results[0].node;
      }
    }

    if (!root) {
      return { content: [{ type: 'text', text: `Function not found: ${functionName}` }] };
    }

    // Use GraphTraverser for richer output
    try {
      const callers = direction !== 'outbound' ? this.traverser.getCallers(root.id, depth) : [];
      const callees = direction !== 'inbound' ? this.traverser.getCallees(root.id, depth) : [];

      const lines: string[] = [];
      lines.push(`Trace for: ${root.name} (${root.qualifiedName})`);
      lines.push(`File: ${root.filePath}:${root.startLine}-${root.endLine}`);
      if (root.signature) lines.push(`Signature: ${root.signature}`);
      lines.push('');

      if (callers.length > 0) {
        lines.push(`Callers (${callers.length}):`);
        for (const c of callers) {
          lines.push(`  [depth=${root.kind}] ${c.node.name} (${c.node.qualifiedName})`);
          lines.push(`    ${c.node.filePath}:${c.node.startLine} (${c.edge.kind})`);
        }
        lines.push('');
      }

      if (callees.length > 0) {
        lines.push(`Callees (${callees.length}):`);
        for (const c of callees) {
          lines.push(`  [depth=${root.kind}] ${c.node.name} (${c.node.qualifiedName})`);
          lines.push(`    ${c.node.filePath}:${c.node.startLine} (${c.edge.kind})`);
        }
        lines.push('');
      }

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    } catch (error: any) {
      return { content: [{ type: 'text', text: `Error tracing path: ${error.message}` }] };
    }
  }

  // ── Tool: get_code_snippet ───────────────────────────────────────

  handleGetCodeSnippet(args: Record<string, unknown>): { content: Array<{ type: string; text: string }> } {
    const project = (args.project as string) || this.project;
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
    lines.push(`${result.node.kind}: ${result.node.name}`);
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

  // ── Tool: get_graph_schema ───────────────────────────────────────

  handleGetGraphSchema(args: Record<string, unknown>): { content: Array<{ type: string; text: string }> } {
    const project = (args.project as string) || this.project;
    if (!project) {
      return { content: [{ type: 'text', text: 'Error: "project" is required.' }] };
    }

    const schema = this.store.getSchema();
    const stats = this.store.getProjectStats(project);

    const lines: string[] = [];
    lines.push(`Graph Schema for project '${project}':`);
    lines.push(`Total nodes: ${stats.nodes}, Total edges: ${stats.edges}`);
    lines.push('');
    lines.push(`Node kinds (${schema.nodeKinds.length}):`);
    for (const k of schema.nodeKinds) lines.push(`  - ${k}`);
    lines.push('');
    lines.push(`Edge kinds (${schema.edgeKinds.length}):`);
    for (const k of schema.edgeKinds) lines.push(`  - ${k}`);

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }

  // ── Tool: get_architecture ───────────────────────────────────────

  handleGetArchitecture(args: Record<string, unknown>): { content: Array<{ type: string; text: string }> } {
    const project = (args.project as string) || this.project;
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

  // ── Tool: detect_changes ─────────────────────────────────────────

  detectChangedFiles(args: { project: string; baseBranch?: string }): { changedFiles: string[]; diffBranch: string } | null {
    const { project, baseBranch: baseBranchArg } = args;
    const baseBranch = baseBranchArg || 'main';

    try {
      const nodes = this.store.findNodes({ project, limit: 1 });
      if (nodes.results.length === 0) return null;

      const repoPath = this.projectDir;
      if (!repoPath) return null;

      let diffBranch = baseBranch;
      try {
        const refHead = execSync('git symbolic-ref refs/remotes/origin/HEAD', {
          cwd: repoPath, encoding: 'utf-8', timeout: 5000,
        }).trim();
        diffBranch = refHead.split('/').pop() || 'main';
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

  handleDetectChanges(args: Record<string, unknown>): { content: Array<{ type: string; text: string }> } {
    const project = (args.project as string) || this.project;
    const baseBranch = (args.base_branch as string) || 'main';

    if (!project) {
      return { content: [{ type: 'text', text: 'Error: "project" is required.' }] };
    }

    const lines: string[] = [];
    lines.push(`Change detection for project '${project}':`);
    lines.push('');

    try {
      const detectResult = this.detectChangedFiles({ project, baseBranch });
      if (!detectResult) {
        lines.push('Repository not found on disk. Use index_repository to re-index.');
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      const { changedFiles, diffBranch } = detectResult;

      if (diffBranch === 'HEAD' && diffBranch !== baseBranch) {
        lines.push(`Warning: Could not diff against '${baseBranch}', falling back to uncommitted changes.`);
        lines.push('');
      }

      if (changedFiles.length === 0) {
        lines.push('No changes detected.');
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      lines.push(`Changed files: ${changedFiles.length}`);
      for (const file of changedFiles) lines.push(`  ${file}`);
      lines.push('');

      // Find impacted nodes
      const impactedNodes: GraphNode[] = [];
      const seenNodeIds = new Set<number>();
      for (const file of changedFiles) {
        const fileResult = this.store.findNodes({ project, filePattern: file, limit: 100 });
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
          lines.push(`  ${r.kind} ${r.name} (${r.filePath}:${r.startLine})`);
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

  // ── Tool: list_projects ──────────────────────────────────────────

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

  // ── Tool: delete_project ─────────────────────────────────────────

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
      try { this.store.rollbackTransaction(); } catch { /* ignore */ }
      return { content: [{ type: 'text', text: `Error deleting project '${project}': ${error.message}` }] };
    }
  }

  // ── Tool: index_status ───────────────────────────────────────────

  handleIndexStatus(args: Record<string, unknown>): { content: Array<{ type: string; text: string }> } {
    const project = (args.project as string) || this.project;
    if (!project) {
      return { content: [{ type: 'text', text: 'Error: "project" is required.' }] };
    }

    const stats = this.store.getProjectStats(project);
    const schema = this.store.getSchema();

    const lines: string[] = [];
    lines.push(`Index status for '${project}':`);
    lines.push(`  Nodes: ${stats.nodes}`);
    lines.push(`  Edges: ${stats.edges}`);
    lines.push(`  Node kinds: ${schema.nodeKinds.join(', ') || 'none'}`);
    lines.push(`  Edge kinds: ${schema.edgeKinds.join(', ') || 'none'}`);

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }
}
