/**
 * ReferenceResolver — orchestrator for the multi-strategy reference
 * resolution pipeline.
 *
 * Lifecycle:
 *   1. Constructor: bind to a GraphStore + project root.
 *   2. initialize(): detect framework patterns, set up knownNames Set.
 *   3. warmCaches(): pre-load known names and file lists.
 *   4. resolveAndPersistBatched(): main entry point — fetch unresolved
 *      refs from the store in batches, resolve each via the multi-strategy
 *      pipeline, create edges, and persist results.
 *
 * Multi-strategy pipeline (per ref, short-circuit on first hit):
 *   Pre-filter (knownNames) → Import resolution → JVM import resolution
 *   → Method-call inference → Same-file match → Unique-name match
 *   → Qualified-suffix match → Fuzzy match
 *
 * Caches (LRU, 5000 entries each):
 *   fileContent, importMappings, nodesByFile, nodesByName.
 */
import * as path from 'path';
import * as fs from 'fs';
import { execSync } from 'child_process';

import {
  GraphStore,
  GraphNode,
  GraphEdge,
  GraphEdgeKind,
  GraphLanguage,
  UnresolvedReference,
  ResolvedRef,
  ResolutionResult,
} from '../types';
import {
  extractImportMappings,
  resolveViaImport,
  resolveJvmImport,
  ImportMapping,
  ResolutionContext,
} from './import-resolver';
import {
  matchReference,
  matchMethodCall,
  isBlacklistedBuiltin,
} from './name-matcher';

// ── LRU cache ─────────────────────────────────────────────────────────────

class LRUCache<K, V> {
  private map = new Map<K, V>();
  private maxSize: number;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }

  get(key: K): V | undefined {
    if (!this.map.has(key)) return undefined;
    const value = this.map.get(key)!;
    // Move to end (most recently used)
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.maxSize) {
      // Delete least recently used (first key)
      const firstKey = this.map.keys().next().value!;
      this.map.delete(firstKey);
    }
    this.map.set(key, value);
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}

// ── Store-backed ResolutionContext ───────────────────────────────────────

class StoreResolutionContext implements ResolutionContext {
  private store: GraphStore;
  private project: string;
  private projectRoot: string;
  private fileContentCache: LRUCache<string, string | null>;
  private nodesInFileCache: LRUCache<string, GraphNode[]>;
  private allFilesCache: string[] | null = null;

  constructor(
    store: GraphStore,
    project: string,
    projectRoot: string,
    fileContentCache: LRUCache<string, string | null>,
    nodesInFileCache: LRUCache<string, GraphNode[]>,
  ) {
    this.store = store;
    this.project = project;
    this.projectRoot = projectRoot;
    this.fileContentCache = fileContentCache;
    this.nodesInFileCache = nodesInFileCache;
  }

  getNodesInFile(filePath: string): GraphNode[] {
    let cached = this.nodesInFileCache.get(filePath);
    if (cached) return cached;
    const nodes = this.store.getNodesByFile(this.project, filePath);
    this.nodesInFileCache.set(filePath, nodes);
    return nodes;
  }

  getNodesByName(name: string): GraphNode[] {
    return this.store.getNodesByName(this.project, name);
  }

  getNodesBySuffix(name: string): GraphNode[] {
    return this.store.getNodesBySuffix(this.project, name);
  }

  getNodesByQualifiedName(qn: string): GraphNode[] {
    return this.store.getNodesByQualifiedNameExact(this.project, qn);
  }

  getAllFiles(): string[] {
    if (this.allFilesCache === null) {
      this.allFilesCache = this.store.getAllFilePaths(this.project);
    }
    return this.allFilesCache;
  }

  getProjectRoot(): string {
    return this.projectRoot;
  }

  fileExists(filePath: string): boolean {
    try {
      return fs.existsSync(filePath);
    } catch {
      return false;
    }
  }

  readFile(filePath: string): string | null {
    let cached = this.fileContentCache.get(filePath);
    if (cached !== undefined) return cached;

    const absolutePath = path.isAbsolute(filePath)
      ? filePath
      : path.join(this.projectRoot, filePath);

    try {
      const content = fs.readFileSync(absolutePath, 'utf-8');
      this.fileContentCache.set(filePath, content);
      return content;
    } catch {
      this.fileContentCache.set(filePath, null);
      return null;
    }
  }

  /** Invalidate all caches (called after batch processing). */
  invalidateAllFilesCache(): void {
    this.allFilesCache = null;
  }
}

// ── Edge-kind promotion ──────────────────────────────────────────────────

/** Node kinds considered class-like for edge promotion. */
const CLASS_LIKE_KINDS = new Set([
  'class',
  'struct',
  'interface',
  'trait',
  'protocol',
  'enum',
]);

/**
 * Promote `calls` edges to `instantiates` when the target is a class/struct.
 * Also promote when the calling context looks like a constructor invocation.
 */
function promoteEdgeKind(
  kind: GraphEdgeKind,
  targetNode: GraphNode,
): GraphEdgeKind {
  if (kind === 'calls' && CLASS_LIKE_KINDS.has(targetNode.kind)) {
    return 'instantiates';
  }
  return kind;
}

// ── Git identity helper ──────────────────────────────────────────────────

function getRepoIdentity(projectRoot: string): string {
  const resolvedPath = path.resolve(projectRoot);
  try {
    const url = execSync('git remote get-url origin', {
      cwd: resolvedPath,
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
    // Full symbolic ref + manual strip: both `rev-parse --abbrev-ref` and
    // `symbolic-ref --short` return `heads/<branch>` when a tag shares the
    // branch's name, which would silently split one project's graph across two
    // project ids. Mirrors core/src/utils/git-identity.ts:getCheckedOutBranch
    // (graph has no core dep).
    const ref = execSync('git symbolic-ref -q HEAD', {
      cwd: resolvedPath,
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
    const branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : '';
    if (!branch) return path.basename(resolvedPath);
    const normalizedUrl = normalizeGitUrl(url);
    return `${normalizedUrl}:${branch}`;
  } catch {
    // Fallback: use directory name
    return path.basename(resolvedPath);
  }
}

function normalizeGitUrl(raw: string): string {
  let url = (raw || '').trim();
  if (!url) return url;
  if (!/:\/\//.test(url)) {
    const scp = url.match(/^[A-Za-z0-9._-]+@([^:/]+):(.+)$/);
    if (scp) url = `https://${scp[1]}/${scp[2]}`;
  }
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    let p = u.pathname.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/i, '');
    return `https://${host}/${p}.git`;
  } catch {
    return url.replace(/\/+$/, '').replace(/\.git$/i, '') + '.git';
  }
}

// ── ReferenceResolver ────────────────────────────────────────────────────

export class ReferenceResolver {
  private store: GraphStore;
  private projectRoot: string;
  private project: string;

  // Caches
  private fileContentCache: LRUCache<string, string | null>;
  private importMappingsCache: LRUCache<string, ImportMapping[]>;
  private nodesByNameCache: LRUCache<string, GraphNode[]>;
  private knownNames: Set<string> | null = null;
  /** Suffix-clean names: "Calc.multiply" → we add "multiply" for O(1) intra-class call check. */
  private knownSuffixNames: Set<string> | null = null;
  /** Multi-segment suffixes for dotted refs: "os.path.join" → "path.join". */
  private knownDottedSuffixes: Set<string> | null = null;

  // Tracking for batch operations
  private nodeCache: Map<number, GraphNode> = new Map();
  /** Names that failed all strategies — persist across batches. */
  private unresolvableCache: Set<string> = new Set();
  /**
   * Positive-outcome memo, scoped to one (file, referenceKind, name) triple.
   *
   * Every input the strategy chain reads is that triple plus immutable graph
   * state, so the same triple always resolves to the same target — yet without
   * this each repetition re-ran the full chain. Measured on a 1360-file AUTOSAR
   * repo: 52,405 refs collapse to 7,610 distinct triples, so 85% of the work was
   * recomputation (`_cpptest_TestObject` alone appeared 5,781 times, each time
   * re-scoring ~886 same-named candidates).
   *
   * Reset per file group in resolveAll. `same-file-closest-scope` outcomes are
   * deliberately NOT memoized: that strategy reads ref.startLine, so two refs to
   * one name in one file can legitimately resolve to different enclosing scopes.
   */
  private perFileResolutionMemo: Map<string, { targetNodeId: number; resolvedBy: string; confidence: number }> = new Map();
  private stats: ResolutionResult['stats'] = {
    total: 0,
    resolved: 0,
    unresolved: 0,
    byMethod: {},
  };

  /** Default batch size for resolveAndPersistBatched. */
  private static DEFAULT_BATCH_SIZE = 50;

  constructor(projectRoot: string, store: GraphStore, project?: string) {
    this.projectRoot = path.resolve(projectRoot);
    this.store = store;
    this.project = project || getRepoIdentity(this.projectRoot);

    // LRU caches — 5000 entries each
    this.fileContentCache = new LRUCache(5000);
    this.importMappingsCache = new LRUCache(5000);
    this.nodesByNameCache = new LRUCache(5000);
  }

  // ── Lifecycle ────────────────────────────────────────────────────────

  /**
   * Initialize the resolver. Detects framework patterns if needed
   * and pre-loads the knownNames Set for O(1) pre-filtering.
   */
  initialize(): void {
    this.knownNames = new Set(this.store.getAllNodeNames(this.project));
    this._buildSuffixIndex();
    this.detectFrameworkPatterns();
  }

  private _buildSuffixIndex(): void {
    if (!this.knownNames) return;
    this.knownSuffixNames = new Set();
    this.knownDottedSuffixes = new Set();
    for (const name of this.knownNames) {
      // "OrderService.createOrder" → suffixName: "createOrder"
      const dotIdx = name.lastIndexOf('.');
      if (dotIdx > 0) {
        this.knownSuffixNames.add(name.slice(dotIdx + 1));
        // Also add trailing multi-segment: "OrderService.createOrder" → "OrderService.createOrder"
        // but we need the 2-segment tail: "Foo.bar" in "a.b.c.Foo.bar" → "Foo.bar"
        let prevDot = name.lastIndexOf('.', dotIdx - 1);
        if (prevDot < 0) prevDot = -1;
        this.knownDottedSuffixes.add(name.slice(prevDot + 1));
      }
    }
  }

  /** Pre-load caches for all known files and names. */
  warmCaches(): void {
    if (!this.knownNames) {
      this.knownNames = new Set(this.store.getAllNodeNames(this.project));
      this._buildSuffixIndex();
    }

    // Pre-fetch all file paths
    const allFiles = this.store.getAllFilePaths(this.project);
    // We don't need to load all file contents into cache upfront —
    // just the file list. Contents are loaded on-demand.
  }

  /**
   * Drop all caches. Call between runs or when memory is tight.
   */
  clearCaches(): void {
    this.fileContentCache.clear();
    this.importMappingsCache.clear();
    this.nodesByNameCache.clear();
    this.nodeCache.clear();
    this.knownNames = null;
    this.knownSuffixNames = null;
    this.knownDottedSuffixes = null;
  }

  // ── Resolution ───────────────────────────────────────────────────────

  /**
   * Resolve a batch of UnresolvedReferences.
   *
   * Multi-strategy pipeline per ref (short-circuits on first hit):
   *   1. Pre-filter: skip if name not in knownNames (O(1) Set lookup)
   *   2. Import resolution
   *   3. JVM import resolution
   *   4. Method-call inference
   *   5. Name matching (same-file → unique → suffix → fuzzy)
   */
  resolveAll(refs: UnresolvedReference[]): ResolutionResult {
    const resolved: ResolvedRef[] = [];
    const unresolved: UnresolvedReference[] = [];
    const deferredChainRefs: UnresolvedReference[] = [];
    const byMethod: Record<string, number> = {};

    // Build ResolutionContext for this batch
    const ctx = new StoreResolutionContext(
      this.store,
      this.project,
      this.projectRoot,
      this.fileContentCache,
      new LRUCache(500), // Per-batch file node cache
    );

    // Pre-load known names if not already loaded
    if (!this.knownNames) {
      this.knownNames = new Set(this.store.getAllNodeNames(this.project));
      this._buildSuffixIndex();
    }

    // Group refs by file to batch import extraction
    const refsByFile = new Map<string, UnresolvedReference[]>();
    for (const ref of refs) {
      const file = ref.filePath || '';
      if (!refsByFile.has(file)) refsByFile.set(file, []);
      refsByFile.get(file)!.push(ref);
    }

    // Process each file's refs
    for (const [filePath, fileRefs] of refsByFile) {
      // Pre-extract import mappings for this file
      let importMappings: ImportMapping[] | null = null;
      let importMappingsLoaded = false;
      // Memo is (file, kind, name)-scoped — a new file starts fresh.
      this.perFileResolutionMemo.clear();

      for (const ref of fileRefs) {
        const refName = ref.referenceName;
        const language = ref.language || 'javascript';

        // Step 0: Unresolvable cache — skip names already known to fail
        if (this.unresolvableCache.has(refName)) {
          unresolved.push(ref);
          incrementStat(byMethod, 'unresolvable-cache');
          continue;
        }

        // Step 0b: Positive memo — this exact (file, kind, name) already resolved.
        const memoKey = `${ref.referenceKind || ''} ${refName}`;
        const memoized = this.perFileResolutionMemo.get(memoKey);
        if (memoized) {
          resolved.push({ original: ref, ...memoized });
          incrementStat(byMethod, memoized.resolvedBy);
          continue;
        }

        // Step 1: Pre-filter — skip if name doesn't exist at all
        if (this.knownNames && !this.knownNames.has(refName)) {
          // For dotted names, try the base name/member
          const dotIndex = refName.indexOf('.');
          if (dotIndex > 0) {
            const baseName = refName.slice(0, dotIndex);
            const memberName = refName.slice(dotIndex + 1);
            if (!this.knownNames.has(baseName) && !this.knownNames.has(memberName)) {
              // O(1) suffix/dotted check
              if (!this.knownSuffixNames?.has(refName) &&
                  !this.knownSuffixNames?.has(baseName) &&
                  !this.knownDottedSuffixes?.has(refName)) {
                unresolved.push(ref);
                incrementStat(byMethod, 'pre-filter');
                continue;
              }
            }
          } else {
            // Simple name — O(1) suffix check: "multiply" → Calc.multiply
            if (!this.knownSuffixNames || !this.knownSuffixNames.has(refName)) {
              unresolved.push(ref);
              incrementStat(byMethod, 'pre-filter');
              continue;
            }
          }
        }

        // Step 2: Import resolution
        if (!importMappingsLoaded && filePath) {
          importMappings = this.getImportMappings(filePath, language, ctx);
          importMappingsLoaded = true;
        }

        // Record a hit so the file's remaining refs to this name skip the chain.
        // Line-sensitive strategies must stay per-ref, so they are not memoized.
        const accept = (r: ResolvedRef): void => {
          resolved.push(r);
          incrementStat(byMethod, r.resolvedBy);
          if (r.resolvedBy !== 'same-file-closest-scope') {
            this.perFileResolutionMemo.set(memoKey, {
              targetNodeId: r.targetNodeId,
              resolvedBy: r.resolvedBy,
              confidence: r.confidence,
            });
          }
        };

        if (importMappings && importMappings.length > 0) {
          // Try standard import resolution
          const importResolved = resolveViaImport(ref, ctx, importMappings);
          if (importResolved) {
            accept(importResolved);
            continue;
          }

          // Try JVM-specific FQN resolution
          if (language === 'java' || language === 'scala') {
            const jvmResolved = resolveJvmImport(ref, ctx, importMappings);
            if (jvmResolved) {
              accept(jvmResolved);
              continue;
            }
          }
        }

        // Step 3: Method-call inference
        if (refName.includes('.') && ref.referenceKind === 'calls') {
          const methodResolved = matchMethodCall(ref, ctx);
          if (methodResolved) {
            accept(methodResolved);
            continue;
          }
        }

        // Step 4: Name matching pipeline
        const nameResolved = matchReference(ref, ctx);
        if (nameResolved) {
          accept(nameResolved);
          continue;
        }

        // Unresolved after all strategies — cache name to skip peers
        this.unresolvableCache.add(refName);
        unresolved.push(ref);
        incrementStat(byMethod, 'unresolved');
      }
    }

    return {
      resolved,
      unresolved,
      deferredChainRefs,
      stats: {
        total: refs.length,
        resolved: resolved.length,
        unresolved: unresolved.length,
        byMethod,
      },
    };
  }

  /**
   * Resolve references, create edges, and persist results to the store.
   *
   * Steps:
   *   1. resolveAll() — run the multi-strategy pipeline
   *   2. createEdges() — convert ResolvedRef[] to GraphEdge[]
   *   3. Persist edges (batch insert)
   *   4. Delete resolved refs from unresolved_refs table
   *   5. Mark unresolvable refs as 'failed'
   *
   * Returns the ResolutionResult for reporting.
   */
  resolveAndPersist(
    refs: UnresolvedReference[],
    onProgress?: (resolved: number, total: number) => void,
  ): ResolutionResult {
    const result = this.resolveAll(refs);

    // Create edges from resolved references
    const edges = this.createEdges(result.resolved);

    // Persist edges
    if (edges.length > 0) {
      this.store.insertEdges(edges);
    }

    // Delete resolved refs
    const resolvedRowIds = result.resolved
      .map((r) => r.original.rowId)
      .filter((id): id is number => id !== undefined);
    if (resolvedRowIds.length > 0) {
      this.store.deleteResolvedRefsByRowIds(resolvedRowIds);
    }

    // Mark unresolved refs as failed
    const failedRefs = result.unresolved
      .filter((r) => r.rowId !== undefined)
      .map((r) => ({ rowId: r.rowId!, referenceName: r.referenceName }));
    if (failedRefs.length > 0) {
      this.store.markRefsFailedByRowIds(failedRefs);
    }

    // Accumulate stats
    this.stats.total += result.stats.total;
    this.stats.resolved += result.stats.resolved;
    this.stats.unresolved += result.stats.unresolved;
    for (const [method, count] of Object.entries(result.stats.byMethod)) {
      this.stats.byMethod[method] = (this.stats.byMethod[method] || 0) + count;
    }

    if (onProgress) {
      onProgress(result.resolved.length, result.stats.total);
    }

    return result;
  }

  /**
   * Process unresolved references in batches from the store.
   *
   * 1. Query unresolved refs in batches (limit per batch).
   * 2. For each batch: resolve, create edges, persist.
   * 3. Yield between batches to keep the event loop responsive.
   * 4. Returns aggregate stats.
   */
  async resolveAndPersistBatched(
    onProgress?: (resolved: number, total: number, batch: number) => void,
    batchSize: number = ReferenceResolver.DEFAULT_BATCH_SIZE,
  ): Promise<ResolutionResult['stats']> {
    if (!this.knownNames) {
      this.knownNames = new Set(this.store.getAllNodeNames(this.project));
      this._buildSuffixIndex();
    }

    // Reset stats
    this.resetStats();

    let batch = 0;
    let totalProcessed = 0;
    const totalPending = this.store.getUnresolvedRefsCount(this.project);

    if (totalPending === 0) {
      return { ...this.stats };
    }

    let afterRowId: number | undefined;

    while (totalProcessed < totalPending) {
      const batchRefs = this.store.getUnresolvedRefsBatch(
        this.project,
        batchSize,
        afterRowId,
      );

      if (batchRefs.length === 0) break;

      batch++;
      await this.processBatch(batchRefs, batch);

      totalProcessed += batchRefs.length;
      afterRowId = batchRefs[batchRefs.length - 1].rowId;

      if (onProgress) {
        onProgress(this.stats.resolved, totalPending, batch);
      }

      // Yield to the event loop between batches
      await yieldToEventLoop();
    }

    // Clear node cache after batch run
    this.nodeCache.clear();

    return { ...this.stats };
  }

  /**
   * Convert an array of ResolvedRef to GraphEdge[].
   * Includes edge kind promotion (calls→instantiates for class targets).
   */
  createEdges(resolved: ResolvedRef[]): GraphEdge[] {
    const edges: GraphEdge[] = [];

    for (const r of resolved) {
      const targetNode = this.getNodeById(r.targetNodeId);
      if (!targetNode) continue;

      let kind = r.original.referenceKind;
      kind = promoteEdgeKind(kind, targetNode);

      edges.push({
        id: 0, // placeholder — real id assigned by SQLite
        project: this.project,
        sourceId: r.original.fromNodeId,
        targetId: r.targetNodeId,
        kind,
        type: kind, // backward compat
        line: r.original.line,
        column: r.original.column,
        provenance: 'heuristic',
        metadata: {
          resolvedBy: r.resolvedBy,
          confidence: r.confidence,
        },
        properties: {
          resolvedBy: r.resolvedBy,
          confidence: r.confidence,
        },
      });
    }

    return edges;
  }

  // ── Stats ───────────────────────────────────────────────────────────

  /** Get accumulated stats from the last resolveAndPersistBatched run. */
  getStats(): ResolutionResult['stats'] {
    return { ...this.stats };
  }

  /** Reset accumulated stats. */
  resetStats(): void {
    this.stats = {
      total: 0,
      resolved: 0,
      unresolved: 0,
      byMethod: {},
    };
    this.unresolvableCache.clear();
  }

  // ── Private helpers ──────────────────────────────────────────────────

  /**
   * Get import mappings for a file, with caching.
   * Prefers store-resident import nodes (fast, already extracted in Phase 1);
   * falls back to regex-based source parsing only when the store has no
   * import nodes for the file (e.g. cold start or non-AST languages).
   */
  private getImportMappings(
    filePath: string,
    language: GraphLanguage,
    ctx: StoreResolutionContext,
  ): ImportMapping[] {
    const cacheKey = `${filePath}:${language}`;
    let cached = this.importMappingsCache.get(cacheKey);
    if (cached) return cached;

    // Fast path: build mappings from store-resident import nodes.
    // Avoids re-reading + re-parsing the source (~99 % of cases).
    const fileNodes = ctx.getNodesInFile(filePath);
    const importNodes = fileNodes.filter((n) => n.kind === 'import');
    if (importNodes.length > 0) {
      const mappings: ImportMapping[] = [];
      for (const node of importNodes) {
        const importPath = (node.properties?.importPath as string) || node.name;
        const importedName = node.properties?.importedName as string | undefined;
        if (importedName) {
          const mapping: ImportMapping = {
            localName: importedName,
            modulePath: importPath,
          };
          mapping.resolvedFile = this.resolveModuleToFile(
            filePath, importPath, language, ctx,
          );
          mappings.push(mapping);
        }
      }
      this.importMappingsCache.set(cacheKey, mappings);
      return mappings;
    }

    // Slow path: regex-based extraction (cold start, non-AST languages).
    const content = ctx.readFile(filePath);
    if (!content) {
      this.importMappingsCache.set(cacheKey, []);
      return [];
    }

    const mappings = extractImportMappings(filePath, content, language);
    for (const mapping of mappings) {
      if (!mapping.resolvedFile) {
        mapping.resolvedFile = this.resolveModuleToFile(
          filePath, mapping.modulePath, language, ctx,
        );
      }
    }

    this.importMappingsCache.set(cacheKey, mappings);
    return mappings;
  }

  /**
   * Resolve a module path to an absolute filesystem path.
   */
  private resolveModuleToFile(
    fromFile: string,
    modulePath: string,
    language: GraphLanguage,
    ctx: StoreResolutionContext,
  ): string | undefined {
    const projectRoot = this.projectRoot;

    // Relative imports
    if (modulePath.startsWith('./') || modulePath.startsWith('../')) {
      const fromDir = path.dirname(path.join(projectRoot, fromFile));
      const candidate = path.resolve(fromDir, modulePath);
      return this.resolveFileCandidate(candidate, language, ctx);
    }

    // Absolute project-relative
    const absoluteCandidate = path.join(projectRoot, modulePath);
    const resolved = this.resolveFileCandidate(absoluteCandidate, language, ctx);
    if (resolved) return resolved;

    // Bare module name: try common roots
    const searchRoots = [
      path.join(projectRoot, 'node_modules', modulePath),
      path.join(projectRoot, 'src', modulePath),
      path.join(projectRoot, 'lib', modulePath),
      path.join(projectRoot, 'packages', modulePath),
      path.join(projectRoot, 'pkg', modulePath),
      path.join(projectRoot, 'internal', modulePath),
      path.join(projectRoot, 'crates', modulePath),
      path.join(projectRoot, modulePath),
    ];

    for (const root of searchRoots) {
      const found = this.resolveFileCandidate(root, language, ctx);
      if (found) return found;
    }

    return undefined;
  }

  private resolveFileCandidate(
    candidate: string,
    language: GraphLanguage,
    ctx: StoreResolutionContext,
  ): string | undefined {
    const extensions = RESOLVE_EXTENSIONS[language] || [];
    const indexFiles = INDEX_FILES[language] || [];

    // Direct extension match
    for (const ext of extensions) {
      const fullPath = candidate + ext;
      if (ctx.fileExists(fullPath)) return fullPath;
    }

    // Directory index files
    for (const idx of indexFiles) {
      const fullPath = path.join(candidate, idx);
      if (ctx.fileExists(fullPath)) return fullPath;
    }

    if (ctx.fileExists(candidate)) return candidate;

    return undefined;
  }

  /**
   * Process a single batch: resolve, create edges, persist, update state.
   */
  private async processBatch(
    refs: UnresolvedReference[],
    batchNumber: number,
  ): Promise<void> {
    const result = this.resolveAll(refs);

    // Create and persist edges
    const edges = this.createEdges(result.resolved);
    if (edges.length > 0) {
      this.store.insertEdges(edges);
    }

    // Delete resolved refs
    const resolvedRowIds = result.resolved
      .map((r) => r.original.rowId)
      .filter((id): id is number => id !== undefined);
    if (resolvedRowIds.length > 0) {
      this.store.deleteResolvedRefsByRowIds(resolvedRowIds);
    }

    // Mark failed refs
    if (result.unresolved.length > 0) {
      const failedRefs = result.unresolved
        .filter((r) => r.rowId !== undefined)
        .map((r) => ({ rowId: r.rowId!, referenceName: r.referenceName }));
      if (failedRefs.length > 0) {
        this.store.markRefsFailedByRowIds(failedRefs);
      }
    }

    // Accumulate stats
    this.stats.total += result.stats.total;
    this.stats.resolved += result.stats.resolved;
    this.stats.unresolved += result.stats.unresolved;
    for (const [method, count] of Object.entries(result.stats.byMethod)) {
      this.stats.byMethod[method] = (this.stats.byMethod[method] || 0) + count;
    }

    // Clear per-batch cache to prevent unbounded growth
    this.nodeCache.clear();

    // Yield every N batches
    if (batchNumber % 4 === 0) {
      await yieldToEventLoop();
    }
  }

  /**
   * Get a node by ID, with in-memory caching.
   */
  private getNodeById(id: number): GraphNode | null {
    if (this.nodeCache.has(id)) return this.nodeCache.get(id)!;
    const node = this.store.getNodeById(id);
    if (node) {
      this.nodeCache.set(id, node);
    }
    return node;
  }

  /**
   * Detect framework patterns in the project.
   *
   * Placeholder for future enhancement — can detect:
   *   - Web framework routing patterns (Express, Flask, Spring)
   *   - Dependency injection conventions
   *   - ORM model patterns
   *   - Pub/sub event patterns
   */
  private detectFrameworkPatterns(): void {
    // Placeholder — can be extended to:
    // 1. Check for framework-specific config files (package.json deps, requirements.txt)
    // 2. Pre-populate known patterns for that framework
    // 3. Adjust resolution strategies based on framework conventions
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

const RESOLVE_EXTENSIONS: Record<string, string[]> = {
  javascript: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'],
  typescript: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'],
  python: ['.py'],
  java: ['.java'],
  go: ['.go'],
  rust: ['.rs'],
  cpp: ['.cpp', '.c', '.h', '.hpp', '.cc', '.cxx'],
  csharp: ['.cs'],
  scala: ['.scala'],
};

const INDEX_FILES: Record<string, string[]> = {
  javascript: ['index.ts', 'index.tsx', 'index.js', 'index.jsx', 'index.mjs'],
  typescript: ['index.ts', 'index.tsx', 'index.js', 'index.jsx'],
  python: ['__init__.py'],
  go: ['index.go', 'main.go'],
  rust: ['mod.rs', 'lib.rs'],
};

function incrementStat(byMethod: Record<string, number>, method: string): void {
  byMethod[method] = (byMethod[method] || 0) + 1;
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}
