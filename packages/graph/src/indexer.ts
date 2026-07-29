/**
 * GraphIndexer — orchestrates the full graph indexing pipeline.
 *
 * Pipeline:
 *   1. Scan files (git ls-files or filesystem walk)
 *   2. Phase 1: Parse → InMemoryGraphBuffer + unresolved refs
 *   3. Phase 2: Flush to SQLite (batched, yielding)
 *   4. Phase 3: Reference resolution → cross-file edges
 *   5. Phase 4: Edge kind promotion (calls → instantiates, etc.)
 */
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import {
  GraphNode,
  GraphEdge,
  GraphNodeKind,
  GraphEdgeKind,
  GraphLanguage,
  UnresolvedReference,
  IndexProgress,
  IndexResult,
  SyncResult,
} from './types';
import { SqliteGraphStore, getGraphDbPath } from './graph-store';
import { InMemoryGraphBuffer } from './graph-buffer';
import { GraphExtractor } from './extractor';
import { ReferenceResolver } from './resolution/index';

// ── Constants ───────────────────────────────────────────────────────

const DEFAULT_PARSE_WORKERS = Math.max(1, os.availableParallelism() - 2);

/**
 * Indexer version. Bump when extractor/resolver/edge-kind logic changes so that
 * graphs built by an older indexer are detected as outdated and rebuilt (git-diff
 * incremental sync can't see "the indexer itself changed"). v2 = call-edge import
 * denoise + true-incremental + awaited phase-3.
 */
export const INDEXER_VERSION = 3;

/** Directory names excluded from file scanning. Keep in sync with core DEFAULT_IGNORE_PATTERNS. */
const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '__pycache__',
  '.venv', 'venv', 'vendor', 'target', 'coverage', '.nyc_output', '.cache',
  '.idea', '.vscode', '.circleci', 'obj', 'out', 'tmp', 'temp',
  '.tox', '.mypy_cache', '.pytest_cache', '.turbo', '.angular', '.nuxt',
  '.svn', '.hg', 'bower_components', '.terraform', '.parcel-cache',
  '.context',  // our own data dir
  // Python
  '.pixi', '.pdm-build', '.ruff_cache', '.nox', '.hypothesis', '.eggs',
  // JVM
  '.gradle', '.mvn', '.kotlin', 'classes', '.bloop', '.metals',
  // C/C++ / Rust
  'CMakeFiles', '_build', 'third_party', 'external', '_deps',
  '.conan',
  // .NET
  '.vs',
  // JS/TS bundler artifacts
  '.parcel-cache', '.svelte-kit', '.vinxi', '.nitro', 'out-tsc', '.vercel', '.netlify',
  // iOS/Swift
  'Pods', 'Carthage', 'DerivedData', '.swiftpm',
  // Dart/Flutter
  '.dart_tool', '.pub-cache',
  // Lua
  'lua_modules', '.luarocks',
  // Delphi
  '__history', '__recovery',
]);

/**
 * File-level noise patterns excluded from indexing (matched against the
 * basename or a trailing extension). These are generated / minified / bundled
 * artifacts that pollute the graph with thousands of junk symbols and drown
 * real definitions. Mirrors the file-level entries in core DEFAULT_IGNORE_PATTERNS.
 */
const IGNORE_FILE_SUFFIXES = [
  '.min.js', '.min.css', '.min.map',
  '.bundle.js', '.bundle.css', '.chunk.js',
  '.vendor.js', '.polyfills.js', '.runtime.js',
  '.generated.ts', '.generated.tsx', '.generated.js',
  '.pb.go', '.pb.cc', '.pb.h', '_pb2.py', '_pb2_grpc.py',
  '.g.dart', '.freezed.dart', '.gen.dart',
  '.designer.cs', '.Designer.cs',
  '.d.ts',           // type-declaration files duplicate the real symbols
  '.tsbuildinfo',
];
const IGNORE_FILE_NAMES = new Set([
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
  'Cargo.lock', 'composer.lock', 'poetry.lock', 'Gemfile.lock', 'go.sum',
]);

/** True if a file (by relative path) is generated/minified noise. */
function isIgnoredFile(relPath: string): boolean {
  const base = relPath.slice(relPath.lastIndexOf('/') + 1);
  if (IGNORE_FILE_NAMES.has(base)) return true;
  for (const suffix of IGNORE_FILE_SUFFIXES) {
    if (base.endsWith(suffix)) return true;
  }
  return false;
}

// ── Types ───────────────────────────────────────────────────────────

export interface GraphIndexerOptions {
  /** Number of parse workers (default: max(1, cores-2)) */
  workerCount?: number;
  /** Force full reindex even if graph already exists */
  force?: boolean;
  /** Progress callback */
  onProgress?: (progress: IndexProgress) => void;
  /** Abort signal */
  signal?: AbortSignal;
  /** Specific files to index (incremental mode) */
  files?: string[];
}

interface FileToIndex {
  absolutePath: string;
  relativePath: string;
  language: string;
}

// ── GraphIndexer ────────────────────────────────────────────────────

export class GraphIndexer {
  private projectDir: string;
  private project: string; // identity
  private store: SqliteGraphStore;
  private extractor: GraphExtractor;

  constructor(projectDir: string, project: string) {
    this.projectDir = projectDir;
    this.project = project;
    this.store = new SqliteGraphStore(projectDir);
    this.extractor = new GraphExtractor();
  }

  getStore(): SqliteGraphStore {
    return this.store;
  }

  getDbPath(): string {
    return getGraphDbPath(this.projectDir);
  }

  close(): void {
    this.store.close();
  }

  /**
   * True when the on-disk graph was built by an older indexer version (or has no
   * version stamp at all) and should be rebuilt — git-diff sync can't detect that
   * the indexer itself changed, only file-content changes.
   */
  isOutdated(): boolean {
    return this.store.getGraphVersion() < INDEXER_VERSION;
  }

  // ── Full index ───────────────────────────────────────────────────

  async indexAll(options: GraphIndexerOptions = {}): Promise<IndexResult> {
    const startTime = Date.now();
    const errors: string[] = [];
    let filesIndexed = 0;
    let filesSkipped = 0;
    let filesErrored = 0;
    let totalNodes = 0;
    let totalEdges = 0;

    // Phase 0: Scan files
    // When options.files is provided we run in incremental mode: only those
    // files are (re)indexed and their existing graph data is replaced
    // file-by-file, leaving every other file's nodes/edges untouched. With no
    // files option this is a full rebuild that wipes the project first.
    const incremental = Array.isArray(options.files) && options.files.length > 0;
    options.onProgress?.({ phase: 'scanning', current: 0, total: 0 });
    const files = incremental
      ? this.resolveRequestedFiles(this.projectDir, options.files!)
      : this.scanFiles(this.projectDir);
    const total = files.length;

    if (options.signal?.aborted) {
      return { success: false, filesIndexed: 0, filesSkipped: 0, filesErrored: 0,
        filesDiscovered: total, nodesCreated: 0, edgesCreated: 0, errors: ['Aborted'], durationMs: Date.now() - startTime };
    }

    // Phase 1: Parse files
    options.onProgress?.({ phase: 'parsing', current: 0, total });
    const graphBuffer = new InMemoryGraphBuffer(this.project);
    const allUnresolvedRefs: UnresolvedReference[] = [];

    const workerCount = options.workerCount ?? DEFAULT_PARSE_WORKERS;
    const chunkSize = Math.ceil(files.length / Math.min(workerCount, files.length));
    const chunks: FileToIndex[][] = [];

    for (let i = 0; i < files.length; i += chunkSize) {
      chunks.push(files.slice(i, i + chunkSize));
    }

    let processed = 0;

    // Process files in parallel batches
    const parseChunk = async (chunk: FileToIndex[]): Promise<void> => {
      for (const file of chunk) {
        if (options.signal?.aborted) return;

        try {
          const absPath = file.absolutePath;
          if (!fs.existsSync(absPath)) continue;

          const content = await fsp.readFile(absPath, 'utf-8');
          const result = this.extractor.extract(content, {
            project: this.project,
            filePath: file.relativePath,
            language: file.language,
          });

          if (result.nodes.length === 0 && result.unresolvedRefs.length === 0) {
            filesSkipped++;
            processed++;
            continue;
          }

          // Add nodes to buffer, remapping temp indices
          const idMap = new Map<number, number>();
          for (let i = 0; i < result.nodes.length; i++) {
            const n = result.nodes[i];
            const realId = graphBuffer.upsertNode(
              n.kind || n.label,
              n.name,
              n.qualifiedName,
              n.filePath,
              n.startLine,
              n.endLine,
              n.properties || {},
              {
                language: file.language,
                signature: n.signature,
                visibility: n.visibility,
                isExported: n.isExported,
                isAsync: n.isAsync,
                isStatic: n.isStatic,
                isAbstract: n.isAbstract,
                decorators: n.decorators,
                docstring: n.docstring,
              }
            );
            idMap.set(i, realId);
          }

          // Add structural edges (CONTAINS, IMPORTS) with remapped IDs
          for (const e of result.edges) {
            // Edges from extractor use temp array indices
            const srcId = idMap.get(e.sourceId as unknown as number);
            const tgtId = idMap.get(e.targetId as unknown as number);
            if (srcId != null && tgtId != null) {
              graphBuffer.insertEdge(srcId, tgtId, e.kind || e.type, e.properties || {}, {
                line: e.line,
                column: e.column,
                provenance: e.provenance || 'tree-sitter',
                metadata: e.metadata,
              });
            }
          }

          // Collect unresolved refs (remap fromNodeId through idMap)
          for (const ref of result.unresolvedRefs) {
            const realFromId = idMap.get(ref.fromNodeId);
            if (realFromId != null) {
              allUnresolvedRefs.push({
                ...ref,
                fromNodeId: realFromId,
              });
            }
          }

          filesIndexed++;
          totalNodes += result.nodes.length;
        } catch (err: any) {
          filesErrored++;
          errors.push(`${file.relativePath}: ${err.message}`);
        }

        processed++;
        if (processed % 100 === 0) {
          options.onProgress?.({ phase: 'parsing', current: processed, total, currentFile: file.relativePath });
          await new Promise<void>(r => setImmediate(r));
        }
      }
    };

    // Process chunks in parallel batches
    for (let i = 0; i < chunks.length; i += workerCount) {
      const batch = chunks.slice(i, i + workerCount);
      await Promise.all(batch.map(c => parseChunk(c)));
    }

    options.onProgress?.({ phase: 'parsing', current: total, total });

    const intraFileEdges = graphBuffer.edgeCount();
    totalEdges += intraFileEdges;

    console.log(`[GraphIndexer] Phase 1 done: ${totalNodes} nodes, ${intraFileEdges} intra-file edges, ${allUnresolvedRefs.length} unresolved refs`);

    if (options.signal?.aborted) {
      return { success: false, filesIndexed, filesSkipped, filesErrored,
        filesDiscovered: total, nodesCreated: totalNodes, edgesCreated: totalEdges,
        errors: ['Aborted'], durationMs: Date.now() - startTime };
    }

    // Phase 2: Flush nodes and edges to SQLite
    options.onProgress?.({ phase: 'storing', current: 0, total: 1 });

    const BATCH_SIZE = 10000;
    this.store.beginBulkLoad();
    try {
      if (incremental) {
        // Incremental: replace only the touched files' graph data. Nodes deleted
        // from a file vanish; new nodes are added below; untouched files keep
        // their data. Cross-file edges pointing INTO these files are dropped
        // (deleteNodesByFile cascades edges) and re-created by Phase 3.
        for (const file of files) {
          this.store.deleteNodesByFile(this.project, file.relativePath);
        }
      } else {
        // Full rebuild: clear existing project data
        while (this.store.deleteProjectEdgesChunk(this.project, BATCH_SIZE) > 0) {
          await new Promise<void>(r => setImmediate(r));
        }
        while (this.store.deleteProjectNodesChunk(this.project, BATCH_SIZE) > 0) {
          await new Promise<void>(r => setImmediate(r));
        }
      }

      // Flush nodes
      const allNodes = graphBuffer.getAllNodes();
      const allEdges = graphBuffer.getAllEdges();
      const idMap = new Map<number, number>();

      this.store.beginTransaction();
      try {
        let writtenNodes = 0;
        for (const node of allNodes) {
          if (writtenNodes > 0 && writtenNodes % BATCH_SIZE === 0) {
            this.store.commitTransaction();
            await new Promise<void>(r => setImmediate(r));
            this.store.beginTransaction();
          }
          const realId = this.store.upsertNode({
            project: node.project,
            kind: node.kind || node.label,
            label: node.kind || node.label,
            name: node.name,
            qualifiedName: node.qualifiedName,
            filePath: node.filePath,
            language: node.language as any || node.properties?.language as any,
            startLine: node.startLine,
            endLine: node.endLine,
            signature: node.signature,
            visibility: node.visibility,
            isExported: node.isExported,
            isAsync: node.isAsync,
            isStatic: node.isStatic,
            isAbstract: node.isAbstract,
            decorators: node.decorators,
            typeParameters: node.typeParameters,
            returnType: node.returnType,
            docstring: node.docstring,
            properties: node.properties || {},
          });
          idMap.set(node.id, realId);
          writtenNodes++;
        }
        this.store.commitTransaction();
      } catch (e) {
        try { this.store.rollbackTransaction(); } catch { /* ignore */ }
        throw e;
      }

      await new Promise<void>(r => setImmediate(r));

      // Flush edges (remap IDs)
      this.store.beginTransaction();
      try {
        let writtenEdges = 0;
        for (const edge of allEdges) {
          if (writtenEdges > 0 && writtenEdges % BATCH_SIZE === 0) {
            this.store.commitTransaction();
            await new Promise<void>(r => setImmediate(r));
            this.store.beginTransaction();
          }
          const realSourceId = idMap.get(edge.sourceId);
          const realTargetId = idMap.get(edge.targetId);
          if (realSourceId == null || realTargetId == null) continue;

          this.store.upsertEdge({
            project: edge.project,
            sourceId: realSourceId,
            targetId: realTargetId,
            kind: edge.kind || edge.type,
            type: edge.kind || edge.type,
            line: edge.line,
            column: edge.column,
            provenance: edge.provenance || 'tree-sitter',
            metadata: edge.metadata,
            properties: edge.properties || {},
          });
          writtenEdges++;
        }
        this.store.commitTransaction();
      } catch (e) {
        try { this.store.rollbackTransaction(); } catch { /* ignore */ }
        throw e;
      }

      // Also remap and insert unresolved refs
      const remappedRefs = allUnresolvedRefs
        .map(ref => ({
          ...ref,
          fromNodeId: idMap.get(ref.fromNodeId) ?? ref.fromNodeId,
        }))
        .filter(ref => ref.fromNodeId != null && ref.fromNodeId > 0);
      if (remappedRefs.length > 0) {
        this.store.insertUnresolvedRefs(this.project, remappedRefs);
      }
    } finally {
      this.store.endBulkLoad();
    }

    options.onProgress?.({ phase: 'storing', current: 1, total: 1 });
    console.log(`[GraphIndexer] Phase 2 done: nodes/edges flushed to SQLite`);

    // Phase 3: Reference resolution → cross-file CALLS edges.
    // AWAITED: fire-and-forget meant the process could exit (or MCP restart)
    // before cross-file edges persisted, permanently losing call-graph edges.
    options.onProgress?.({ phase: 'resolving', current: 0, total: 1 });

    if (incremental) {
      // Re-arm refs that failed earlier (their target may live in a file we
      // just re-indexed, or one added since) so they get retried this pass.
      this.store.resetFailedRefs(this.project);
    }

    const refCount = this.store.getUnresolvedRefsCount(this.project);
    if (refCount > 0) {
      const resolver = new ReferenceResolver(this.projectDir, this.store, this.project);
      resolver.warmCaches();
      try {
        const result = await resolver.resolveAndPersistBatched(
          (resolved, totalRefs) => {
            options.onProgress?.({ phase: 'resolving', current: resolved, total: totalRefs });
          },
        );
        console.log(`[GraphIndexer] Phase 3 done: ${result.resolved} cross-file edges resolved, ${result.unresolved} remaining`);
      } catch (err: any) {
        console.warn(`[GraphIndexer] Phase 3 error (non-fatal): ${err.message}`);
      }
    } else {
      options.onProgress?.({ phase: 'resolving', current: 1, total: 1 });
    }

    // Stamp the indexer version that produced this graph so future opens can
    // detect an outdated graph (indexer upgraded) and rebuild.
    if (!incremental) {
      this.store.setGraphVersion(INDEXER_VERSION);
    }

    // Checkpoint WAL
    try { this.store.checkpoint(); } catch { /* non-critical */ }

    const elapsed = Date.now() - startTime;
    console.log(`[GraphIndexer] Index complete: ${totalNodes} nodes, ${totalEdges} edges in ${(elapsed / 1000).toFixed(1)}s`);

    return {
      success: true,
      filesIndexed,
      filesSkipped,
      filesErrored,
      filesDiscovered: total,
      nodesCreated: totalNodes,
      edgesCreated: totalEdges,
      errors,
      durationMs: elapsed,
    };
  }

  // ── Incremental sync ─────────────────────────────────────────────

  async sync(options: GraphIndexerOptions = {}): Promise<SyncResult> {
    const startTime = Date.now();
    const changedFiles = this.detectChangedFiles();

    if (changedFiles.length === 0) {
      return {
        filesChecked: 0, filesAdded: 0, filesModified: 0, filesRemoved: 0,
        nodesUpdated: 0, durationMs: Date.now() - startTime,
      };
    }

    // Purge graph rows for files that were deleted (present in the diff but no
    // longer on disk) — they can't be re-indexed, so remove their stale data.
    const deletedFiles = changedFiles.filter(f => !fs.existsSync(path.join(this.projectDir, f)));
    for (const f of deletedFiles) {
      this.store.deleteNodesByFile(this.project, f.replace(/\\/g, '/'));
    }

    // True incremental: re-index only the changed files that still exist.
    const result = await this.indexAll({
      ...options,
      files: changedFiles,
    });

    return {
      filesChecked: changedFiles.length,
      filesAdded: result.filesIndexed,
      filesModified: 0,
      filesRemoved: deletedFiles.length,
      nodesUpdated: result.nodesCreated,
      durationMs: result.durationMs,
      changedFilePaths: changedFiles,
    };
  }

  // ── File scanning ────────────────────────────────────────────────

  /** Check whether a relative path (from git ls-files) lives under an ignored directory. */
  private isIgnoredPath(relPath: string): boolean {
    const parts = relPath.replace(/\\/g, '/').split('/');
    for (const part of parts) {
      if (IGNORE_DIRS.has(part)) return true;
    }
    return false;
  }

  private scanFiles(dir: string): FileToIndex[] {
    const results: FileToIndex[] = [];
    const exts = new Set([
      '.js', '.jsx', '.mjs', '.cjs',
      '.ts', '.tsx',
      '.py', '.pyi', '.pyx',
      '.java', '.kt', '.kts', '.scala',
      '.cpp', '.c', '.h', '.hpp', '.hh', '.cc', '.cxx', '.hxx', '.inl',
      '.go', '.rs', '.cs',
      '.php', '.rb', '.swift', '.m', '.mm', '.dart', '.sol',
      '.lua', '.r', '.ex', '.exs', '.erl', '.hs',
      '.vue', '.svelte', '.astro',
      '.zig', '.nim', '.vb',
    ]);

    // Try git ls-files first
    try {
      const output = execSync(
        `git -C "${dir}" ls-files --cached --others --exclude-standard`,
        { encoding: 'utf-8', timeout: 10000, maxBuffer: 10 * 1024 * 1024 },
      );
      for (const line of output.trim().split('\n').filter(Boolean)) {
        // Skip paths under ignored directories
        if (this.isIgnoredPath(line)) continue;
        // Skip generated / minified / lock-file noise
        if (isIgnoredFile(line)) continue;
        const ext = path.extname(line);
        if (!exts.has(ext)) continue;
        const abs = path.join(dir, line);
        if (!fs.existsSync(abs)) continue;
        results.push({
          absolutePath: abs,
          relativePath: line,
          language: GraphExtractor.extToLanguage(ext) || 'javascript',
        });
      }
      return results;
    } catch {
      // Fall through to filesystem walk
    }

    // Filesystem walk
    const stack: string[] = [dir];
    while (stack.length > 0) {
      const current = stack.pop()!;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch { continue; }
      for (const entry of entries) {
        if (IGNORE_DIRS.has(entry.name)) continue;
        const fullPath = path.join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(fullPath);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name);
          if (exts.has(ext)) {
            const relPath = path.relative(dir, fullPath);
            if (isIgnoredFile(relPath.replace(/\\/g, '/'))) continue;
            results.push({
              absolutePath: fullPath,
              relativePath: relPath,
              language: GraphExtractor.extToLanguage(ext) || 'javascript',
            });
          }
        }
      }
    }
    return results;
  }

  private detectChangedFiles(): string[] {
    // 工作区实时性：未提交（未暂存+已暂存）与未跟踪的新文件都要纳入，
    // 否则用户改了代码未 commit 时图无法实时反映。排除自身数据目录 .context。
    const isOurs = (f: string) => /^\.context\//.test(f.replace(/\\/g, '/'));
    try {
      const tracked = execSync('git diff --name-only HEAD', {
        cwd: this.projectDir, encoding: 'utf-8', timeout: 10000,
      }).trim();
      const untracked = execSync('git ls-files --others --exclude-standard', {
        cwd: this.projectDir, encoding: 'utf-8', timeout: 10000,
      }).trim();
      return (tracked + '\n' + untracked).split('\n').map(s => s.trim()).filter(f => f && !isOurs(f));
    } catch {
      return [];
    }
  }

  /**
   * Map a list of changed file paths (git-relative, may include deletions) to
   * indexable FileToIndex entries: keeps only supported extensions, skips
   * ignored dirs, drops files that no longer exist on disk (deletions — their
   * graph rows are removed by the caller via deleteNodesByFile).
   */
  private resolveRequestedFiles(dir: string, files: string[]): FileToIndex[] {
    const exts = new Set([
      '.js', '.jsx', '.mjs', '.cjs',
      '.ts', '.tsx',
      '.py', '.pyi', '.pyx',
      '.java', '.kt', '.kts', '.scala',
      '.cpp', '.c', '.h', '.hpp', '.hh', '.cc', '.cxx', '.hxx', '.inl',
      '.go', '.rs', '.cs',
      '.php', '.rb', '.swift', '.m', '.mm', '.dart', '.sol',
      '.lua', '.r', '.ex', '.exs', '.erl', '.hs',
      '.vue', '.svelte', '.astro',
      '.zig', '.nim', '.vb',
    ]);
    const results: FileToIndex[] = [];
    for (const rel of files) {
      const norm = rel.replace(/\\/g, '/');
      if (this.isIgnoredPath(norm)) continue;
      if (isIgnoredFile(norm)) continue;
      const ext = path.extname(norm);
      if (!exts.has(ext)) continue;
      const abs = path.join(dir, norm);
      if (!fs.existsSync(abs)) continue; // deleted file — stale rows purged by caller
      results.push({
        absolutePath: abs,
        relativePath: norm,
        language: GraphExtractor.extToLanguage(ext) || 'javascript',
      });
    }
    return results;
  }
}
