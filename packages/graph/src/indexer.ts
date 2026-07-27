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
import { FunctionRegistry } from './registry';
import { ReferenceResolver } from './resolution/index';

// ── Constants ───────────────────────────────────────────────────────

const DEFAULT_PARSE_WORKERS = Math.max(1, os.availableParallelism() - 2);

/** Directory names excluded from file scanning. */
const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '__pycache__',
  '.venv', 'vendor', 'target', 'coverage', '.nyc_output', '.cache',
  '.idea', '.vscode', '.circleci', 'bin', 'obj', 'out', 'tmp', 'temp',
  '.tox', '.mypy_cache', '.pytest_cache', '.turbo', '.angular', '.nuxt',
  '.svn', '.hg', 'bower_components', '.terraform', '.parcel-cache',
  '.context',  // our own data dir
]);

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
    options.onProgress?.({ phase: 'scanning', current: 0, total: 0 });
    const files = this.scanFiles(this.projectDir);
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
      // Clear existing project data
      while (this.store.deleteProjectEdgesChunk(this.project, BATCH_SIZE) > 0) {
        await new Promise<void>(r => setImmediate(r));
      }
      while (this.store.deleteProjectNodesChunk(this.project, BATCH_SIZE) > 0) {
        await new Promise<void>(r => setImmediate(r));
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
            language: node.properties?.language as any,
            startLine: node.startLine,
            endLine: node.endLine,
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

    // Phase 3: Reference resolution
    options.onProgress?.({ phase: 'resolving', current: 0, total: 1 });

    const resolver = new ReferenceResolver(this.projectDir, this.store);
    resolver.warmCaches();

    const refCount = this.store.getUnresolvedRefsCount(this.project);
    if (refCount > 0) {
      const result = await resolver.resolveAndPersistBatched(
        (current, total) => {
          options.onProgress?.({ phase: 'resolving', current, total });
        },
      );
      totalEdges += result.resolved;
      console.log(`[GraphIndexer] Phase 3 done: ${result.resolved} cross-file edges resolved, ${result.unresolved} remaining`);
    }

    options.onProgress?.({ phase: 'resolving', current: 1, total: 1 });

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

    // For now, re-index changed files
    // Full incremental sync will be added in a follow-up
    const result = await this.indexAll({
      ...options,
      files: changedFiles,
    });

    return {
      filesChecked: changedFiles.length,
      filesAdded: result.filesIndexed,
      filesModified: 0,
      filesRemoved: 0,
      nodesUpdated: result.nodesCreated,
      durationMs: result.durationMs,
      changedFilePaths: changedFiles,
    };
  }

  // ── File scanning ────────────────────────────────────────────────

  private scanFiles(dir: string): FileToIndex[] {
    const results: FileToIndex[] = [];
    const exts = new Set([
      '.js', '.jsx', '.mjs', '.ts', '.tsx',
      '.py', '.java', '.cpp', '.c', '.h', '.hpp', '.cc',
      '.go', '.rs', '.cs',
    ]);

    // Try git ls-files first
    try {
      const output = execSync(
        `git -C "${dir}" ls-files --cached --others --exclude-standard`,
        { encoding: 'utf-8', timeout: 10000, maxBuffer: 10 * 1024 * 1024 },
      );
      for (const line of output.trim().split('\n').filter(Boolean)) {
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
            results.push({
              absolutePath: fullPath,
              relativePath: path.relative(dir, fullPath),
              language: GraphExtractor.extToLanguage(ext) || 'javascript',
            });
          }
        }
      }
    }
    return results;
  }

  private detectChangedFiles(): string[] {
    try {
      const output = execSync('git diff --name-only HEAD', {
        cwd: this.projectDir, encoding: 'utf-8', timeout: 10000,
      }).trim();
      return output.split('\n').filter(Boolean);
    } catch {
      return [];
    }
  }
}
