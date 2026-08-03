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

/**
 * Is this path one of our own on-disk artifacts rather than user code?
 *
 * The graph database lives at `<project>/.context/graph/`, and most repos do not
 * gitignore `.context/` — so `git ls-files --others` reports the database (plus its
 * -wal/-shm siblings) as "changed" every time. Without this filter every search
 * saw pending changes and kicked off an incremental re-index of the graph's own
 * storage: work that can never converge, because writing the graph re-dirties the
 * very files that triggered it. The graph package's own change detection already
 * excludes them (graph/src/indexer.ts); this is the same rule on the MCP path.
 */
function isOwnArtifact(file: string): boolean {
  return /^\.context\//.test(file.replace(/\\/g, '/'));
}

/**
 * A node's qualified name with the repo-identity prefix removed.
 *
 * Nodes are keyed `<identity>.<path>.<name>`, and the identity is a full clone
 * URL plus branch — so printing it raw spent ~110 characters per line restating
 * the repo the agent is already asking about. An architecture block with ten
 * entry points burned over a kilobyte of context on the same URL.
 */
function displayQualifiedName(node: { qualifiedName: string; project?: string }): string {
  const { qualifiedName, project } = node;
  return project && qualifiedName.startsWith(`${project}.`)
    ? qualifiedName.slice(project.length + 1)
    : qualifiedName;
}

/** 一个仓库的图访问器集合（同一个 store 上的四个视图）。 */
interface GraphBundle {
  store: SqliteGraphStore;
  traverser: GraphTraverser;
  searcher: GraphSearcher;
  architecture: ArchitectureAnalyzer;
}

/**
 * 同时打开的仓库图上限。超出后关掉最久未用的那个。
 *
 * 一个会话里通常只有 1–3 个仓库；给到 8 是为了 monorepo 里跨若干子仓库跳转的情形。
 * 无上限的话长会话会一直累积 SQLite 连接（每个约 3 个 fd）。
 */
const MAX_OPEN_GRAPHS = 8;

export class GraphToolHandlers {
  /**
   * 按仓库目录缓存图访问器。
   *
   * 之前是单槽位 + setProject() 里 close-and-reopen，这在并发下会互相踩：两个仓库的
   * search 同时在跑时，后到者的 setProject 把前者的 store 换掉（甚至 close 掉），
   * 前者随后取 store 做调用链富化就查到 0 行 —— 响应里整段 Call Graph 静默消失，
   * 没有任何报错。改成按目录缓存后，谁的查询用谁的 store。
   */
  private bundles = new Map<string, GraphBundle>();
  /** LRU 顺序（末尾 = 最近使用）。 */
  private lru: string[] = [];
  /** 按 project 复用 GraphIndexer：每次 new 都带一套 SQLite 连接 + tree-sitter，从不 close 就是 fd 泄漏。 */
  private indexers = new Map<string, GraphIndexer>();
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
    const dir = projectDir || process.cwd();
    this.bundleFor(dir);
    if (projectDir) {
      this.projectDir = projectDir;
      this.project = getRepoIdentity(projectDir);
    } else {
      // 兼容旧行为：没给目录时以 cwd 为"当前项目"，但不去算 identity（可能不是 git 仓库）。
      this.projectDir = dir;
    }
  }

  /** 取（必要时打开）某个仓库目录的图访问器。 */
  private bundleFor(projectDir: string): GraphBundle {
    let bundle = this.bundles.get(projectDir);
    if (!bundle) {
      const store = new SqliteGraphStore(projectDir);
      store.initialize();
      bundle = {
        store,
        traverser: new GraphTraverser(store),
        searcher: new GraphSearcher(store),
        architecture: new ArchitectureAnalyzer(store),
      };
      this.bundles.set(projectDir, bundle);
    }
    // LRU 触碰 + 淘汰
    const i = this.lru.indexOf(projectDir);
    if (i >= 0) this.lru.splice(i, 1);
    this.lru.push(projectDir);
    while (this.lru.length > MAX_OPEN_GRAPHS) {
      // 跳过当前项目（它随时会被用到）。这里不能"遇到当前项目就 break" ——
      // 当前项目一旦排到队首，后面所有该淘汰的都会被永久跳过，上限形同失效。
      const idx = this.lru.findIndex(p => p !== this.projectDir);
      if (idx < 0) break;   // 只剩当前项目
      const evict = this.lru.splice(idx, 1)[0];
      const b = this.bundles.get(evict);
      this.bundles.delete(evict);
      try { b?.store.close(); } catch { /* ignore */ }
    }
    return bundle;
  }

  /**
   * 设置"当前项目"（未显式传路径的调用的默认值）。
   *
   * 不再 close 旧 store —— 那是并发踩踏的根源。这里只是移动默认值指针。
   */
  setProject(projectDir: string): void {
    this.bundleFor(projectDir);
    if (this.projectDir === projectDir) return;
    this.projectDir = projectDir;
    this.project = getRepoIdentity(projectDir);
  }

  /**
   * 取图存储。**并发场景下务必显式传 projectDir** —— 不传就用"当前项目"，
   * 而当前项目会被另一个仓库的 setProject 改掉。
   */
  getStore(projectDir?: string): SqliteGraphStore {
    return this.bundleFor(projectDir || this.projectDir || process.cwd()).store;
  }

  getTraverser(projectDir?: string): GraphTraverser {
    return this.bundleFor(projectDir || this.projectDir || process.cwd()).traverser;
  }

  /**
   * 从工具入参里解出该用哪个仓库的图。
   *
   * 优先 args.repo_path / args.path —— 这样并发的两个 tool call 各查各的库，
   * 不受"当前项目"指针被对方改掉的影响。
   */
  private bundleFromArgs(args: Record<string, unknown>): GraphBundle {
    // 只认 repo_path：有的工具把 args.path 当路径过滤器（get_architecture），不能拿来当仓库目录。
    const dir = (args.repo_path as string) || this.projectDir || process.cwd();
    return this.bundleFor(dir);
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
    for (const b of this.bundles.values()) {
      try { b.store.close(); } catch { /* best effort */ }
    }
    this.bundles.clear();
    this.lru = [];
    for (const ix of this.indexers.values()) {
      try { ix.close(); } catch { /* best effort */ }
    }
    this.indexers.clear();
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
      // 复用同一 project 的 indexer：每个 GraphIndexer 自带 SQLite 连接 + tree-sitter parser，
      // 之前每次索引都 new 一个且只有最后一个被 close()，一个长会话里反复触发增量就是稳定的 fd 泄漏。
      let indexer = this.indexers.get(project);
      if (!indexer) {
        indexer = new GraphIndexer(repoPath, project);
        this.indexers.set(project, indexer);
      }

      const options: GraphIndexerOptions = {
        force: (args.force as boolean) || false,
        signal: undefined,
        onProgress: (progress: IndexProgress) => {
          // 保留首次回调的 startTime —— 之前每次都重置成 now，
          // 导致 elapsed = now - startTime 永远 ~0，进度时间显示失效。
          const existing = this.indexingProgress.get(project);
          this.indexingProgress.set(project, {
            total: progress.total,
            current: progress.current,
            startTime: existing?.startTime ?? Date.now(),
          });
        },
      };

      if (specificFiles && specificFiles.length > 0) {
        options.files = specificFiles;
      }

      // 增量（带 files 或 mode=incremental）走 sync()：它内部做真增量 —
      // 只重索引变更文件、删除已删文件的节点。修复此前 options.files 被
      // 传入却仍跑全量（大仓库上"增量"其实是全量，巨慢且每次 search 重复触发）。
      const isIncremental = (specificFiles && specificFiles.length > 0) || mode === 'incremental';
      const result = isIncremental
        ? await (async () => {
            const r = await indexer.sync(options);
            return {
              success: true,
              nodesCreated: r.nodesUpdated,
              edgesCreated: 0,
              filesIndexed: r.filesAdded,
              durationMs: r.durationMs,
              errors: [] as string[],
            };
          })()
        : await indexer.indexAll(options);
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

    const result = this.bundleFromArgs(args).searcher.searchGraph(options);

    const lines: string[] = [];
    lines.push(`Found ${result.total} results${result.hasMore ? ' (more available)' : ''}:`);
    lines.push('');

    for (const r of result.results) {
      const n = r.node;
      lines.push(`- ${n.kind}: ${n.name} (${displayQualifiedName(n)})`);
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

    const { store, traverser } = this.bundleFromArgs(args);

    // Find the node
    const nodeResult = store.findNodes({
      project,
      namePattern: functionName,
      limit: 1,
    });

    let root: GraphNode | null = null;
    if (nodeResult.results.length > 0) {
      root = nodeResult.results[0].node;
    } else {
      // Try qualified name
      const qnResult = store.findNodes({ project, qnPattern: functionName, limit: 1 });
      if (qnResult.results.length > 0) {
        root = qnResult.results[0].node;
      }
    }

    if (!root) {
      return { content: [{ type: 'text', text: `Function not found: ${functionName}` }] };
    }

    // Use GraphTraverser for richer output
    try {
      const callers = direction !== 'outbound' ? traverser.getCallers(root.id, depth) : [];
      const callees = direction !== 'inbound' ? traverser.getCallees(root.id, depth) : [];

      const lines: string[] = [];
      lines.push(`Trace for: ${root.name} (${displayQualifiedName(root)})`);
      lines.push(`File: ${root.filePath}:${root.startLine}-${root.endLine}`);
      if (root.signature) lines.push(`Signature: ${root.signature}`);
      lines.push('');

      if (callers.length > 0) {
        lines.push(`Callers (${callers.length}):`);
        for (const c of callers) {
          lines.push(`  ${c.node.name} (${displayQualifiedName(c.node)})`);
          lines.push(`    ${c.node.filePath}:${c.node.startLine} —${c.edge.kind}→ ${root.name}`);
        }
        lines.push('');
      }

      if (callees.length > 0) {
        lines.push(`Callees (${callees.length}):`);
        for (const c of callees) {
          lines.push(`  ${c.node.name} (${displayQualifiedName(c.node)})`);
          lines.push(`    ${c.node.filePath}:${c.node.startLine} ${root.name} —${c.edge.kind}→`);
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

    const result = this.bundleFromArgs(args).searcher.getCodeSnippet(project, qualifiedName, includeNeighbors);
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

    const { store } = this.bundleFromArgs(args);
    const schema = store.getSchema();
    const stats = store.getProjectStats(project);

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

    const arch = this.bundleFromArgs(args).architecture.getArchitecture(project, pathFilter);

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
        lines.push(`  - ${ep.name} (${displayQualifiedName(ep)})`);
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

  detectChangedFiles(args: { project: string; baseBranch?: string; repoPath?: string }): { changedFiles: string[]; diffBranch: string } | null {
    const { project, baseBranch: baseBranchArg } = args;
    const baseBranch = baseBranchArg || 'main';

    // 仓库目录必须显式传（或退回当前项目）：并发时"当前项目"可能已经是别人的仓库，
    // 那样就会拿 A 仓库的 git diff 去判断 B 仓库的变更文件。
    const repoPath = args.repoPath || this.projectDir;
    if (!repoPath) return null;

    try {
      const nodes = this.bundleFor(repoPath).store.findNodes({ project, limit: 1 });
      if (nodes.results.length === 0) return null;

      let diffBranch = baseBranch;
      try {
        const refHead = execSync('git symbolic-ref refs/remotes/origin/HEAD', {
          cwd: repoPath, encoding: 'utf-8', timeout: 5000,
        }).trim();
        // refs/remotes/origin/<branch> — strip the prefix, don't split on '/':
        // a default branch like `release/2.0` would become just `2.0`.
        const prefix = 'refs/remotes/origin/';
        diffBranch = refHead.startsWith(prefix) ? refHead.slice(prefix.length) : (refHead.split('/').pop() || 'main');
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

      // 工作区实时性：未提交的改动（未暂存 + 已暂存 + 未跟踪）是图索引必须
      // 实时反映的 —— 用户改完代码（未必 commit）search 就应看到新符号。
      let worktreeFiles: string[] = [];
      try {
        const unstaged = execSync('git diff --name-only', { cwd: repoPath, encoding: 'utf-8', timeout: 10000 });
        const staged = execSync('git diff --name-only --cached', { cwd: repoPath, encoding: 'utf-8', timeout: 10000 });
        const untracked = execSync('git ls-files --others --exclude-standard', { cwd: repoPath, encoding: 'utf-8', timeout: 10000 });
        worktreeFiles = (unstaged + '\n' + staged + '\n' + untracked)
          .trim().split('\n').filter(Boolean).filter(f => !isOwnArtifact(f));
      } catch { /* non-git or read error */ }

      // 未提交改动优先返回：这是"图实时性"的核心，与分支分叉检测解耦，
      // 避免 `git diff main...HEAD` 在浅克隆/单提交仓库报错把工作区改动也吞掉。
      if (worktreeFiles.length > 0) {
        return { changedFiles: Array.from(new Set(worktreeFiles)), diffBranch: 'worktree' };
      }

      let branchFiles: string[] = [];
      try {
        branchFiles = execSync(`git diff --name-only ${diffBranch}...HEAD`, {
          cwd: repoPath, encoding: 'utf-8', timeout: 10000,
        }).trim().split('\n').filter(Boolean);
      } catch {
        try {
          branchFiles = execSync('git diff --name-only HEAD', {
            cwd: repoPath, encoding: 'utf-8', timeout: 10000,
          }).trim().split('\n').filter(Boolean);
          diffBranch = 'HEAD';
        } catch { /* ignore */ }
      }

      const changedFiles = Array.from(new Set(branchFiles.filter(f => !isOwnArtifact(f))));
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

    const { store } = this.bundleFromArgs(args);

    try {
      const detectResult = this.detectChangedFiles({ project, baseBranch, repoPath: args.repo_path as string | undefined });
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
        const fileResult = store.findNodes({ project, filePattern: file, limit: 100 });
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

  handleListProjects(args: Record<string, unknown> = {}): { content: Array<{ type: string; text: string }> } {
    const { store } = this.bundleFromArgs(args);
    const projects = store.listProjects();
    const lines: string[] = [];

    if (projects.length === 0) {
      lines.push('No indexed projects found.');
    } else {
      lines.push(`Indexed projects (${projects.length}):`);
      for (const p of projects) {
        const stats = store.getProjectStats(p);
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

    const { store } = this.bundleFromArgs(args);
    try {
      store.beginTransaction();
      store.deleteProject(project);
      store.commitTransaction();
      return { content: [{ type: 'text', text: `Project '${project}' deleted.` }] };
    } catch (error: any) {
      try { store.rollbackTransaction(); } catch { /* ignore */ }
      return { content: [{ type: 'text', text: `Error deleting project '${project}': ${error.message}` }] };
    }
  }

  // ── Tool: index_status ───────────────────────────────────────────

  handleIndexStatus(args: Record<string, unknown>): { content: Array<{ type: string; text: string }> } {
    const project = (args.project as string) || this.project;
    if (!project) {
      return { content: [{ type: 'text', text: 'Error: "project" is required.' }] };
    }

    const { store } = this.bundleFromArgs(args);
    const stats = store.getProjectStats(project);
    const schema = store.getSchema();

    const lines: string[] = [];
    lines.push(`Index status for '${project}':`);
    lines.push(`  Nodes: ${stats.nodes}`);
    lines.push(`  Edges: ${stats.edges}`);
    lines.push(`  Node kinds: ${schema.nodeKinds.join(', ') || 'none'}`);
    lines.push(`  Edge kinds: ${schema.edgeKinds.join(', ') || 'none'}`);

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }
}
