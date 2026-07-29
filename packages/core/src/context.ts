import {
    Splitter,
    CodeChunk,
    AstCodeSplitter
} from './splitter';
import {
    Embedding,
    EmbeddingVector,
    OpenAIEmbedding
} from './embedding';
import {
    VectorDatabase,
    VectorDocument,
    VectorSearchResult,
    HybridSearchRequest,
    HybridSearchOptions,
    HybridSearchResult
} from './vectordb';
import { SemanticSearchResult } from './types';
import { envManager } from './utils/env-manager';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { execSync } from 'child_process';
import { getRepoIdentity } from './utils/git-identity';
import { IgnorePatternManager } from './utils/ignore-patterns';
import {
    isGitRepo,
    getHeadCommit,
    getRepoRoot,
    getRemoteUrl,
    getCommitTimestamp,
    getMergeBase,
    getRefCommit,
    commitExists,
    isAncestor,
    diffChangedFiles,
    ChangedFiles,
} from './utils/git-history';
import { EmbeddingCache, NoopEmbeddingCache, MilvusEmbeddingCache, hashChunk } from './cache';
import { CommitIndexState, CommitState } from './index-state';

/**
 * Thrown by indexCodebase / processFileList when an AbortSignal fires
 * mid-indexing. Callers (e.g. the MCP server's clear_index handler) use
 * this to detect a cooperative cancel vs. a real failure.
 */
export class IndexAbortError extends Error {
    constructor(message: string = 'Indexing aborted') {
        super(message);
        this.name = 'IndexAbortError';
    }
}

/**
 * Thrown when the embedding API fails (quota exhausted, auth failure,
 * network error, etc.). Propagates through processFileList so callers
 * can distinguish a critical embedding failure from a per-file skip.
 *
 * Unlike a per-file read/parse error (which is logged and skipped),
 * an EmbeddingError is always re-thrown so that the entire indexing
 * pipeline stops. This prevents silent partial indexing: Milvus would
 * otherwise receive zero vectors while the snapshot marks files as done.
 */
export class EmbeddingError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'EmbeddingError';
    }
}

const DEFAULT_SUPPORTED_EXTENSIONS = [
    // C / C++ / CUDA (core stack for perception / planning / control)
    '.c', '.h', '.cpp', '.cc', '.cxx', '.hpp', '.hh', '.hxx', '.inl', '.ipp',
    '.tpp', '.cu', '.cuh',
    // Python (incl. Cython)
    '.py', '.pyi', '.pyx', '.pxd',
    // Other programming languages
    '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.java', '.cs', '.go', '.rs',
    '.php', '.rb', '.swift', '.kt', '.kts', '.scala', '.m', '.mm', '.dart', '.sol',
    '.lua', '.pl', '.pm', '.r', '.jl', '.ex', '.exs', '.erl', '.hs', '.clj',
    '.cljs', '.groovy', '.vue', '.svelte', '.astro', '.zig', '.nim', '.gd', '.vb',
    // Shell & scripting
    '.sh', '.bash', '.zsh', '.fish', '.ps1', '.psm1', '.bat', '.cmd',
    // CI / build / infra
    '.jenkinsfile', '.gradle', '.tf', '.tfvars', '.hcl', '.cmake', '.mk', '.bazel',
    '.bzl', '.dockerfile',
    // ROS / robotics description
    '.msg', '.srv', '.action', '.launch', '.urdf', '.xacro', '.sdf',
    // Config & data
    '.json', '.jsonc', '.json5', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf',
    '.properties', '.xml', '.proto', '.graphql', '.gql',
    // Web & styles
    '.html', '.htm', '.css', '.scss', '.less', '.sass',
    // Database
    '.sql',
    // Text and markup files (markdown excluded — doc noise in search results)
    '.rst', '.adoc', '.txt', '.ipynb',
];

// Well-known extensionless files that should be indexed as code/config.
const DEFAULT_SUPPORTED_FILENAMES = [
    'Dockerfile', 'Containerfile', 'Jenkinsfile', 'Makefile', 'GNUmakefile',
    'Rakefile', 'Gemfile', 'Vagrantfile', 'Procfile', 'Brewfile', 'Justfile',
    'Taskfile', 'CMakeLists.txt', 'Berksfile',
];

const DEFAULT_IGNORE_PATTERNS = [
    // Common build output and dependency directories
    'node_modules/**',
    'dist/**',
    'build/**',
    'out/**',
    'target/**',
    'coverage/**',
    '.nyc_output/**',

    // IDE and editor files
    '.vscode/**',
    '.idea/**',
    '*.swp',
    '*.swo',

    // Version control
    '.git/**',
    '.svn/**',
    '.hg/**',

    // Cache directories
    '.cache/**',
    '__pycache__/**',
    '.pytest_cache/**',
    '.mypy_cache/**',
    '.ruff_cache/**',
    '.next/**',
    '.nuxt/**',
    '.turbo/**',
    '.parcel-cache/**',
    '.terraform/**',

    // Dependency directories
    'vendor/**',
    'bower_components/**',
    // Python pip packages (site-packages in any virtualenv or system path)
    '**/site-packages/**',
    // Node.js alternative package managers
    '.pnpm-store/**',

    // ---- Java / Kotlin / Scala ----
    '.gradle/**',
    '.mvn/**',
    '.kotlin/**',
    'classes/**',
    '**/*.class',
    '**/*.jar',
    '**/*.war',
    '**/*.ear',

    // ---- Python (additional) ----
    '**/*.egg',
    '**/*.whl',
    '.python-version',

    // ---- C/C++ & CMake build trees ----
    'cmake-build-*/**',
    'CMakeFiles/**',
    '_build/**',
    '**/*.o', '**/*.obj', '**/*.a', '**/*.lib', '**/*.so', '**/*.so.*',
    '**/*.dylib', '**/*.dll', '**/*.exe', '**/*.out', '**/*.d',
    '**/*.lo', '**/*.la',  // libtool objects / archives
    // Bazel
    'bazel-*/**',
    // CMake FetchContent / vcpkg / conan / CPM
    '_deps/**',
    '.conan/**',
    // Vendored third-party libraries (common in C/C++/protobuf-grpc projects)
    'third_party/**',
    'external/**',  // Bazel external repositories
    // ROS / catkin / colcon workspaces (generated)
    'devel/**',
    'install/**',
    'devel_isolated/**',
    'build_isolated/**',
    '.catkin_tools/**',
    'log/**',
    // Generated sources (protobuf / gRPC / Qt moc)
    '**/*.pb.cc', '**/*.pb.h', '**/*_pb2.py', '**/*_pb2_grpc.py',
    '**/moc_*.cpp', '**/ui_*.h', '**/qrc_*.cpp',
    // Python envs & packaging
    '*.egg-info/**',
    '.tox/**',
    'venv/**',
    '.venv/**',
    '**/*.pyc', '**/*.pyo', '**/*.pyd',

    // ---- Ruby ----
    '.bundle/**',
    'vendor/bundle/**',

    // ---- Elixir ----
    'deps/**',
    '.elixir_ls/**',

    // ---- Go (additional) ----
    // 'vendor/**' already covered above; Go workspace:
    'go.work.sum',

    // ---- Rust (additional) ----
    // 'target/**' already covered above

    // ---- Dart / Flutter ----
    '.dart_tool/**',
    '.flutter-plugins*',
    '.packages',

    // ---- JavaScript / TypeScript (additional) ----
    '*.tsbuildinfo',
    '__snapshots__/**',
    '.storybook-static/**',
    'storybook-static/**',
    // Code generation output dirs (various ecosystems)
    'generated/**',
    '_generated/**',
    '**/*.generated.*',
    // Static site generators
    '_site/**',
    '.docusaurus/**',
    // Serverless deployment artifacts
    '.serverless/**',
    '.wrangler/**',

    // ---- Embedded / IoT ----
    '.pio/**',        // PlatformIO
    '.pioenvs/**',

    // ---- Game engines ----
    // Unity
    'Library/**',
    'Temp/**',
    'Obj/**',
    'Logs/**',
    // Unreal Engine
    'Intermediate/**',
    'Saved/**',
    'DerivedDataCache/**',
    // Godot
    '.godot/**',
    '.import/**',

    // ---- OS junk files ----
    '.DS_Store',
    'Thumbs.db',
    'desktop.ini',

    // Models / weights / serialized graphs (large binaries)
    '**/*.onnx', '**/*.pt', '**/*.pth', '**/*.pb', '**/*.h5', '**/*.hdf5',
    '**/*.ckpt', '**/*.caffemodel', '**/*.weights', '**/*.engine', '**/*.plan',
    '**/*.trt', '**/*.tlt', '**/*.safetensors', '**/*.mlmodel',
    // Datasets / recordings / point clouds / media (huge in AD repos)
    '**/*.bag', '**/*.mcap', '**/*.pcd', '**/*.ply', '**/*.las', '**/*.laz',
    '**/*.npy', '**/*.npz', '**/*.mat', '**/*.parquet', '**/*.tfrecord',
    '**/*.jpg', '**/*.jpeg', '**/*.png', '**/*.bmp', '**/*.tiff', '**/*.gif',
    '**/*.ico', '**/*.mp4', '**/*.avi', '**/*.mov', '**/*.mkv',
    '**/*.bin', '**/*.dat', '**/*.raw',
    // Archives & docs (binary)
    '**/*.zip', '**/*.tar', '**/*.tar.gz', '**/*.tgz', '**/*.gz', '**/*.bz2',
    '**/*.xz', '**/*.7z', '**/*.rar',
    '**/*.pdf', '**/*.docx', '**/*.xlsx', '**/*.pptx',
    // Fonts
    '**/*.woff', '**/*.woff2', '**/*.ttf', '**/*.eot', '**/*.otf',

    // Logs and temporary files
    'logs/**',
    'tmp/**',
    'temp/**',
    '*.log',

    // Environment and config files
    '.env',
    '.env.*',
    '*.local',

    // Minified and bundled files
    '*.min.js',
    '*.min.css',
    '*.min.map',
    '*.bundle.js',
    '*.bundle.css',
    '*.chunk.js',
    '*.vendor.js',
    '*.polyfills.js',
    '*.runtime.js',
    '*.map', // source map files

    // Lock files (large, generated, low semantic value)
    'package-lock.json',
    'yarn.lock',
    'pnpm-lock.yaml',
    'Cargo.lock',
    'composer.lock',
    'poetry.lock',
    'Gemfile.lock',
    'go.sum',
    '*.lock',

    'node_modules', '.git', '.svn', '.hg', 'build', 'dist', 'out',
    'target', '.vscode', '.idea', '__pycache__', '.pytest_cache',
    'coverage', '.nyc_output', 'logs', 'tmp', 'temp'
];

export interface ContextConfig {
    embedding?: Embedding;
    vectorDatabase?: VectorDatabase;
    codeSplitter?: Splitter;
    supportedExtensions?: string[];
    ignorePatterns?: string[];
    customExtensions?: string[]; // New: custom extensions from MCP
    customIgnorePatterns?: string[]; // New: custom ignore patterns from MCP
    collectionNameOverride?: string; // Optional: custom collection name suffix
}

export class Context {
    private static readonly MAX_COLLECTION_NAME_LENGTH = 255;

    private embedding: Embedding;
    private vectorDatabase: VectorDatabase;
    private codeSplitter: Splitter;
    private supportedExtensions: string[];
    private supportedFilenames: string[] = DEFAULT_SUPPORTED_FILENAMES;
    private ignorePatternManager: IgnorePatternManager;
    private collectionNameOverride?: string;
    private warnedOverrideSanitization = new Set<string>();

    /** Cache for getRepoIdentity to avoid repeated git execSync calls in the hot path. */
    private repoIdentityCache: Map<string, string> = new Map();

    // ── Team-version incremental indexing state ──────────────────────
    /** Shared commit-level index state (identity → last-indexed HEAD commit). */
    private commitIndexState: CommitIndexState;
    /** Whether the content-hash embedding cache is enabled (EMBEDDING_CACHE_ENABLED). */
    private embeddingCacheEnabled: boolean;
    /** Lazily-built embedding cache, rebuilt when model/dimension changes. */
    private embeddingCacheInstance: EmbeddingCache | null = null;
    private embeddingCacheKey: string | null = null;
    /** Resolved embedding dimension, cached to avoid repeated detectDimension calls. */
    private knownDimension: number | null = null;
    /**
     * HEAD commit stamped onto chunk metadata for the in-flight index run.
     * Set at the start of indexCodebase/syncIndexByGit; used by processChunkBatch.
     */
    private currentIndexCommit: string | null = null;

    constructor(config: ContextConfig = {}) {
        // Initialize services
        this.embedding = config.embedding || new OpenAIEmbedding({
            apiKey: envManager.get('OPENAI_API_KEY') || 'missing-openai-api-key',
            model: 'text-embedding-3-small',
            ...(envManager.get('OPENAI_BASE_URL') && { baseURL: envManager.get('OPENAI_BASE_URL') })
        });

        if (!config.embedding && !envManager.get('OPENAI_API_KEY')) {
            console.warn('[Context] No OPENAI_API_KEY found in environment. Embedding operations will fail.');
        }

        if (!config.vectorDatabase) {
            throw new Error('VectorDatabase is required. Please provide a vectorDatabase instance in the config.');
        }
        this.vectorDatabase = config.vectorDatabase;

        this.codeSplitter = config.codeSplitter || new AstCodeSplitter(4000, 500);

        // Load custom extensions from environment variables
        const envCustomExtensions = this.getCustomExtensionsFromEnv();

        // Combine default extensions with config extensions and env extensions
        const allSupportedExtensions = [
            ...DEFAULT_SUPPORTED_EXTENSIONS,
            ...(config.supportedExtensions || []),
            ...(config.customExtensions || []),
            ...envCustomExtensions
        ];
        // Remove duplicates
        this.supportedExtensions = [...new Set(allSupportedExtensions)];

        // Load custom ignore patterns from environment variables
        const envCustomIgnorePatterns = this.getCustomIgnorePatternsFromEnv();

        // Start with default ignore patterns and persistent config/env patterns.
        const allIgnorePatterns = [
            ...DEFAULT_IGNORE_PATTERNS,
            ...(config.ignorePatterns || []),
            ...(config.customIgnorePatterns || []),
            ...envCustomIgnorePatterns
        ];
        this.ignorePatternManager = new IgnorePatternManager(allIgnorePatterns);
        this.collectionNameOverride = config.collectionNameOverride;

        // Team-version: shared commit state + content-hash embedding cache.
        this.commitIndexState = new CommitIndexState(this.vectorDatabase);
        this.embeddingCacheEnabled = this.readBoolEnv('EMBEDDING_CACHE_ENABLED', true);

        console.log(`[Context] 🔧 Initialized with ${this.supportedExtensions.length} supported extensions and ${this.ignorePatternManager.getPatterns().length} ignore patterns`);
        if (envCustomExtensions.length > 0) {
            console.log(`[Context] 📎 Loaded ${envCustomExtensions.length} custom extensions from environment: ${envCustomExtensions.join(', ')}`);
        }
        if (envCustomIgnorePatterns.length > 0) {
            console.log(`[Context] 🚫 Loaded ${envCustomIgnorePatterns.length} custom ignore patterns from environment: ${envCustomIgnorePatterns.join(', ')}`);
        }
    }

    /**
     * Get embedding instance
     */
    getEmbedding(): Embedding {
        return this.embedding;
    }

    /**
     * Get vector database instance
     */
    getVectorDatabase(): VectorDatabase {
        return this.vectorDatabase;
    }

    /**
     * Get code splitter instance
     */
    getCodeSplitter(): Splitter {
        return this.codeSplitter;
    }

    /**
     * Get supported extensions
     */
    getSupportedExtensions(): string[] {
        return [...this.supportedExtensions];
    }

    /**
     * Get supported extensions for the current operation without mutating
     * the Context's persistent extension list.
     */
    /** Cached base supported extensions (no additional extensions). */
    private effectiveExtensionsBase: string[] = [];

    getEffectiveSupportedExtensions(additionalExtensions: string[] = []): string[] {
        // Cache the common case (no additional extensions).
        if (additionalExtensions.length === 0) {
            if (this.effectiveExtensionsBase.length === 0) {
                this.effectiveExtensionsBase = [...this.supportedExtensions];
            }
            return this.effectiveExtensionsBase;
        }
        const normalizedExtensions = this.normalizeExtensions(additionalExtensions);
        return [...new Set([...this.supportedExtensions, ...normalizedExtensions])];
    }

    getSupportedFilenames(): string[] {
        return [...this.supportedFilenames];
    }

    /** A file is indexable if its extension OR its basename (e.g. Dockerfile) is supported. */
    private isSupportedFile(relOrPath: string, supportedExtensions: string[] = this.supportedExtensions): boolean {
        const ext = path.extname(relOrPath);
        if (ext && supportedExtensions.includes(ext)) return true;
        return this.supportedFilenames.includes(path.basename(relOrPath));
    }

    /**
     * Get ignore patterns
     */
    getIgnorePatterns(): string[] {
        return this.ignorePatternManager.getPatterns();
    }


    async getLoadedIgnorePatterns(codebasePath: string): Promise<void> {
        await this.ignorePatternManager.loadForCodebase(codebasePath);
    }

    /**
     * Get the effective ignore patterns for a codebase without relying on
     * codebase-specific patterns already stored on this Context instance.
     */
    async getEffectiveIgnorePatterns(codebasePath: string, additionalIgnorePatterns: string[] = []): Promise<string[]> {
        return this.ignorePatternManager.loadForCodebase(codebasePath, additionalIgnorePatterns);
    }

    /**
     * Public wrapper for prepareCollection private method
     */
    async getPreparedCollection(codebasePath: string): Promise<void> {
        return this.prepareCollection(codebasePath);
    }

    /**
     * Get isHybrid setting from environment variable with default true
     */
    private getIsHybrid(): boolean {
        const isHybridEnv = envManager.get('HYBRID_MODE');
        if (isHybridEnv === undefined || isHybridEnv === null) {
            return true; // Default to true
        }
        return isHybridEnv.toLowerCase() === 'true';
    }

    /**
     * Read a boolean env flag with a default. Accepts true/false/1/0 (case-insensitive).
     */
    private readBoolEnv(name: string, defaultValue: boolean): boolean {
        const raw = envManager.get(name);
        if (raw === undefined || raw === null || String(raw).trim() === '') {
            return defaultValue;
        }
        const v = String(raw).trim().toLowerCase();
        return v === 'true' || v === '1' || v === 'yes';
    }

    /**
     * Resolve the embedding dimension once and cache it. Prefers the provider's
     * declared dimension, falling back to a live detectDimension() call.
     */
    private async resolveDimension(): Promise<number> {
        if (this.knownDimension && this.knownDimension > 0) {
            return this.knownDimension;
        }
        const declared = this.embedding.getDimension();
        if (declared && declared > 0) {
            this.knownDimension = declared;
            return declared;
        }
        const detected = await this.embedding.detectDimension();
        this.knownDimension = detected;
        return detected;
    }

    /**
     * Get the content-hash embedding cache for the current model + dimension.
     * Returns a no-op cache when caching is disabled. The instance is rebuilt
     * whenever the model identifier or dimension changes so vectors never mix
     * across models.
     */
    private getEmbeddingCache(dimension: number): EmbeddingCache {
        if (!this.embeddingCacheEnabled) {
            return new NoopEmbeddingCache();
        }
        const modelId = this.embedding.getModelIdentifier();
        const key = `${modelId}#${dimension}`;
        if (this.embeddingCacheInstance && this.embeddingCacheKey === key) {
            return this.embeddingCacheInstance;
        }
        this.embeddingCacheInstance = new MilvusEmbeddingCache(this.vectorDatabase, modelId, dimension);
        this.embeddingCacheKey = key;
        return this.embeddingCacheInstance;
    }

    /**
     * Cached getRepoIdentity — avoids repeated git execSync calls in the
     * hot path (processChunkBatch is called once per embedding batch,
     * each call to getRepoIdentity runs 2 git commands).
     */
    private getRepoIdentityCached(codebasePath: string): string {
        const resolved = path.resolve(codebasePath);
        const cached = this.repoIdentityCache.get(resolved);
        if (cached !== undefined) {
            return cached;
        }
        const identity = getRepoIdentity(resolved);
        this.repoIdentityCache.set(resolved, identity);
        return identity;
    }

    /**
     * Generate collection name based on codebase path and hybrid mode
     */
    public getCollectionName(codebasePath: string): string {
        return this.getCollectionNameForIdentity(this.getRepoIdentityCached(codebasePath));
    }

    /**
     * Collection name for an arbitrary repo identity (url:branch). Lets the
     * layered query walk ancestor branches' collections without a checkout path.
     */
    public getCollectionNameForIdentity(identity: string): string {
        const isHybrid = this.getIsHybrid();
        const prefix = isHybrid === true ? 'hcc' : 'cc';
        const pathHash = crypto.createHash('md5').update(identity).digest('hex').substring(0, 8);

        // Overrides always keep the per-codebase `_<pathHash>` suffix so that multiple
        // codebases indexed by the same MCP server can't collapse into one collection.
        const configOverride = this.getValidOverrideValue(this.collectionNameOverride);
        if (configOverride) {
            const suffix = this.sanitizeCollectionNameSuffix(configOverride, prefix, pathHash, 'Context config');
            return `${prefix}_${suffix}`;
        }

        const envOverride = this.getValidOverrideValue(envManager.get('CODE_CHUNKS_COLLECTION_NAME_OVERRIDE'));
        if (envOverride) {
            const suffix = this.sanitizeCollectionNameSuffix(envOverride, prefix, pathHash, 'CODE_CHUNKS_COLLECTION_NAME_OVERRIDE');
            return `${prefix}_${suffix}`;
        }

        // Collection naming: <prefix>_<repo>_<hash>. The repo slug makes it human-
        // readable; the branch is intentionally NOT in the name so a repo's main
        // and all its branches read as the same repo. The branch hierarchy is shown
        // in the collection description. The hash keeps names unique and
        // deterministic per identity (index-time and search-time agree).
        const slug = this.slugForIdentity(identity);
        return `${prefix}_${slug}_${pathHash}`;
    }

    /** Derive a readable repo slug from a repo identity (`<url>:<branch>` or a path). */
    private slugForIdentity(identity: string): string {
        const isGitUrl = /:\/\//.test(identity) || /^git@/.test(identity);
        let repoPart = identity;
        if (isGitUrl) {
            // Git refs cannot contain ':', so the branch is always after the last colon.
            const i = identity.lastIndexOf(':');
            if (i > 0) repoPart = identity.slice(0, i);
        }
        repoPart = repoPart.replace(/\.git$/i, '');
        const seg = repoPart.split(/[/:]/).filter(Boolean).pop() || 'repo';
        const repo = seg.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32);
        return repo || 'repo';
    }

    private getValidOverrideValue(value?: string): string | undefined {
        if (!value) {
            return undefined;
        }
        const trimmed = value.trim();
        return trimmed.length > 0 ? trimmed : undefined;
    }

    private sanitizeCollectionNameSuffix(value: string, prefix: string, pathHash: string, source: string): string {
        const hashSuffix = `_${pathHash}`;
        // Leave room for both the prefix and the trailing `_<pathHash>` disambiguator.
        const maxReadableLength = Context.MAX_COLLECTION_NAME_LENGTH - `${prefix}_`.length - hashSuffix.length;
        const normalized = value.trim();
        let sanitized = normalized.replace(/[^A-Za-z0-9_]/g, '_');
        sanitized = sanitized.slice(0, Math.max(0, maxReadableLength));

        if (sanitized.length === 0) {
            sanitized = 'custom';
        }

        const full = `${sanitized}${hashSuffix}`;

        if (sanitized !== normalized) {
            const warningKey = `${source}:${normalized}:${sanitized}`;
            if (!this.warnedOverrideSanitization.has(warningKey)) {
                console.warn(`[Context] ⚠️ Sanitized collection name override from "${normalized}" to "${sanitized}" (${source}); final suffix "${full}"`);
                this.warnedOverrideSanitization.add(warningKey);
            }
        }

        return full;
    }

    /**
     * Index a codebase for semantic search
     * @param codebasePath Codebase root path
     * @param progressCallback Optional progress callback function
     * @param forceReindex Whether to recreate the collection even if it exists
     * @param additionalIgnorePatterns Request-scoped ignore patterns
     * @param additionalSupportedExtensions Request-scoped file extensions
     * @param requestSplitter Request-scoped splitter for this indexing run
     * @returns Indexing statistics
     */
    async indexCodebase(
        codebasePath: string,
        progressCallback?: (progress: { phase: string; current: number; total: number; percentage: number }) => void | Promise<void>,
        forceReindex: boolean = false,
        additionalIgnorePatterns: string[] = [],
        additionalSupportedExtensions: string[] = [],
        requestSplitter?: Splitter,
        signal?: AbortSignal
    ): Promise<{ indexedFiles: number; totalChunks: number; status: 'completed' | 'limit_reached' }> {
        const isHybrid = this.getIsHybrid();
        const searchType = isHybrid === true ? 'hybrid search' : 'semantic search';
        console.log(`[Context] 🚀 Starting to index codebase with ${searchType}: ${codebasePath}`);
        const splitter = requestSplitter || this.codeSplitter;

        // Stamp the HEAD commit for this run so chunk metadata records the commit
        // it was indexed at (and so the commit-state record below is accurate).
        this.currentIndexCommit = getHeadCommit(codebasePath);

        // 1. Compute ignore patterns for this codebase/request without
        // retaining file-based patterns from previous codebases.
        const ignorePatterns = await this.ignorePatternManager.loadForCodebase(codebasePath, additionalIgnorePatterns);

        // 2. Check and prepare vector collection
        progressCallback?.({ phase: 'Preparing collection...', current: 0, total: 100, percentage: 0 });
        console.log(`Debug2: Preparing vector collection for codebase${forceReindex ? ' (FORCE REINDEX)' : ''}`);
        await this.prepareCollection(codebasePath, forceReindex);

        // 3. Recursively traverse codebase to get all supported files
        progressCallback?.({ phase: 'Scanning files...', current: 5, total: 100, percentage: 5 });
        const supportedExtensions = this.getEffectiveSupportedExtensions(additionalSupportedExtensions);
        const codeFiles = await this.getCodeFiles(codebasePath, ignorePatterns, supportedExtensions);
        console.log(`[Context] 📁 Found ${codeFiles.length} code files`);

        if (codeFiles.length === 0) {
            progressCallback?.({ phase: 'No files to index', current: 100, total: 100, percentage: 100 });
            return { indexedFiles: 0, totalChunks: 0, status: 'completed' };
        }

        // 3. Process each file with streaming chunk processing
        // Reserve 10% for preparation, 90% for actual indexing
        const indexingStartPercentage = 10;
        const indexingEndPercentage = 100;
        const indexingRange = indexingEndPercentage - indexingStartPercentage;

        const result = await this.processFileList(
            codeFiles,
            codebasePath,
            (filePath, fileIndex, totalFiles) => {
                // Calculate progress percentage
                const progressPercentage = indexingStartPercentage + (fileIndex / totalFiles) * indexingRange;

                console.log(`[Context] 📊 Processed ${fileIndex}/${totalFiles} files`);
                progressCallback?.({
                    phase: `Processing files (${fileIndex}/${totalFiles})...`,
                    current: fileIndex,
                    total: totalFiles,
                    percentage: Math.round(progressPercentage)
                });
            },
            splitter,
            signal
        );

        console.log(`[Context] ✅ Codebase indexing completed! Processed ${result.processedFiles} files in total, generated ${result.totalChunks} code chunks`);

        // Record the commit this full index brought the shared vector index up to,
        // so subsequent indexing (this dev or a teammate) can go incremental.
        // A full index is a root layer in the Git-DAG (base = null).
        if (this.currentIndexCommit && result.status === 'completed') {
            const identity = this.getRepoIdentityCached(codebasePath);
            const dimension = await this.resolveDimension();
            await this.commitIndexState.set(identity, this.currentIndexCommit, dimension, {
                repoUrl: getRemoteUrl(codebasePath) || undefined,
                baseIdentity: null,
                overridePaths: [],
                collectionName: this.getCollectionName(codebasePath),
            });
        }

        progressCallback?.({
            phase: 'Indexing complete!',
            current: result.processedFiles,
            total: codeFiles.length,
            percentage: 100
        });

        return {
            indexedFiles: result.processedFiles,
            totalChunks: result.totalChunks,
            status: result.status
        };
    }

    private readIntEnv(name: string, fallback: number): number {
        const raw = envManager.get(name);
        if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
        const v = parseInt(String(raw), 10);
        return Number.isFinite(v) ? v : fallback;
    }

    /** Map a git repo-root-relative path onto the index root; null if outside it. */
    private mapRepoPathToIndex(codebasePath: string, repoRoot: string, gitFile: string): { abs: string; rel: string } | null {
        const abs = path.resolve(repoRoot, gitFile);
        const rel = path.relative(codebasePath, abs);
        if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
        return { abs, rel: rel.replace(/\\/g, '/') };
    }

    /**
     * Resolve a branch's lineage against the repository's indexed branches:
     *   - root   = the search BASE (the repo's main/root branch). Every branch's
     *              index is stored + queried as `root ⊕ own-diff`, so search only
     *              ever touches two layers regardless of how deep the branch tree is.
     *   - parent = the immediate ancestor branch (e.g. C's parent is B). Tracked
     *              purely for the branch tree; it does NOT affect search.
     *   - diff / overridePaths = what this branch changed relative to the root
     *              (since the fork point), used to store the delta and mask the root.
     * Returns root=null when no indexed ancestor exists → this branch is a root.
     */
    private async resolveLineage(
        codebasePath: string, identity: string, head: string, repoUrl: string,
    ): Promise<{
        root: { identity: string; headCommit: string } | null;
        parentIdentity: string | null;
        diff: ChangedFiles | null;
        overridePaths: string[];
    }> {
        const empty = { root: null, parentIdentity: null, diff: null, overridePaths: [] as string[] };
        if (!this.readBoolEnv('GIT_LAYERED_ENABLED', true)) return empty;

        // main/master (configurable) is ALWAYS the repo root — it is never a delta
        // of another branch, so a feature branch indexed before main can't displace
        // it. Indexing a root branch => full index, base=null.
        const rootBranches = String(envManager.get('GIT_ROOT_BRANCHES') ?? 'main,master')
            .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
        if (rootBranches.includes(this.branchOf(identity, repoUrl).toLowerCase())) return empty;

        const others = (await this.commitIndexState.getByRepo(repoUrl)).filter(c => c.identity !== identity && !!c.headCommit);
        if (others.length === 0) return empty;

        // Search root = the indexed main/master branch BY NAME (the canonical root),
        // regardless of how it was recorded; else an indexed base=null root; else any.
        // This is the shared base every branch composes with.
        let root = others.find(c => rootBranches.includes(this.branchOf(c.identity, repoUrl).toLowerCase()))
            || others.find(c => !c.baseIdentity)
            || others[0];

        // Resolve the diff base commit against the developer's LOCAL view of the
        // root branch (origin/<main> or <main>), so a branch still diffs correctly
        // even when the exact cloud-indexed commit isn't present locally. Fall back
        // to the recorded root commit if that exists locally.
        const rootBranch = this.branchOf(root.identity, repoUrl);
        let baseCommit: string | null = rootBranch
            ? (getRefCommit(codebasePath, `origin/${rootBranch}`) || getRefCommit(codebasePath, rootBranch))
            : null;
        if (!baseCommit && commitExists(codebasePath, root.headCommit)) baseCommit = root.headCommit;
        if (!baseCommit) return empty; // can't locate the root locally → index as a full root

        // Diff vs root since the fork point (merge-base) = this branch's own work.
        const mergeBase = getMergeBase(codebasePath, baseCommit, head) || baseCommit;
        const diff = diffChangedFiles(codebasePath, mergeBase, head);
        const repoRoot = getRepoRoot(codebasePath) || codebasePath;
        const overridePaths: string[] = [];
        if (diff) {
            for (const f of [...diff.modified, ...diff.deleted]) {
                const m = this.mapRepoPathToIndex(codebasePath, repoRoot, f);
                if (m) overridePaths.push(m.rel);
            }
        }

        // Immediate parent for the branch tree = the DEEPEST indexed ancestor whose
        // commit is present locally (best-effort; falls back to the root).
        const localAncestors = others.filter(c =>
            c.headCommit !== head && commitExists(codebasePath, c.headCommit) && isAncestor(codebasePath, c.headCommit, head),
        );
        let parentIdentity = root.identity;
        if (localAncestors.length > 0) {
            let parent = localAncestors[0];
            for (let i = 1; i < localAncestors.length; i++) {
                const c = localAncestors[i];
                if (isAncestor(codebasePath, parent.headCommit, c.headCommit)) parent = c;
                else if (!isAncestor(codebasePath, c.headCommit, parent.headCommit)) {
                    if ((getCommitTimestamp(codebasePath, c.headCommit) ?? 0) > (getCommitTimestamp(codebasePath, parent.headCommit) ?? 0)) parent = c;
                }
            }
            parentIdentity = parent.identity;
        }

        return {
            root: { identity: root.identity, headCommit: baseCommit },
            parentIdentity,
            diff,
            overridePaths,
        };
    }

    /** Extract the branch name from a `url:branch` identity, given the repo URL. */
    private branchOf(identity: string, repoUrl: string): string {
        if (repoUrl && identity.startsWith(repoUrl + ':')) return identity.slice(repoUrl.length + 1);
        const idx = identity.lastIndexOf(':');
        return idx >= 0 ? identity.slice(idx + 1) : identity;
    }

    /** Recompute lineage metadata (base=root, parent, override paths) for state. */
    private async computeLayerMeta(
        codebasePath: string, identity: string, head: string, repoUrl: string | null,
    ): Promise<{ baseIdentity: string | null; parentIdentity: string | null; overridePaths: string[] }> {
        if (!repoUrl) return { baseIdentity: null, parentIdentity: null, overridePaths: [] };
        const lineage = await this.resolveLineage(codebasePath, identity, head, repoUrl);
        return {
            baseIdentity: lineage.root?.identity ?? null,
            parentIdentity: lineage.parentIdentity,
            overridePaths: lineage.overridePaths,
        };
    }

    /**
     * Query layer chain: always at most two layers — [current branch (delta), root
     * (main)]. The root layer is masked by the files the current branch changed vs
     * root, so search reflects exactly `main ⊕ this branch's diff`.
     */
    private async resolveLayerChain(identity: string): Promise<Array<{ identity: string; collectionName: string; mask: string[] }>> {
        const self = { identity, collectionName: this.getCollectionNameForIdentity(identity), mask: [] as string[] };
        const st: CommitState | null = await this.commitIndexState.get(identity);
        if (!st || !st.baseIdentity || st.baseIdentity === identity) {
            return [self];
        }
        return [
            self,
            {
                identity: st.baseIdentity,
                collectionName: this.getCollectionNameForIdentity(st.baseIdentity),
                mask: st.overridePaths || [],
            },
        ];
    }

    /**
     * First-time index of a branch that has an indexed ancestor: store ONLY the
     * files changed relative to the base (added + modified), and record the base
     * pointer + override paths so queries compose base ⊕ delta. The base's copies
     * of unchanged files are reused as-is; identical chunks hit the embedding cache.
     */
    private async indexBranchDelta(
        codebasePath: string,
        identity: string,
        head: string,
        repoUrl: string,
        lineage: { root: { identity: string; headCommit: string } | null; parentIdentity: string | null; diff: ChangedFiles | null; overridePaths: string[] },
        progressCallback?: (progress: { phase: string; current: number; total: number; percentage: number }) => void | Promise<void>,
        additionalIgnorePatterns: string[] = [],
        additionalSupportedExtensions: string[] = [],
        requestSplitter?: Splitter,
        signal?: AbortSignal,
    ): Promise<{
        mode: 'delta';
        indexedFiles: number;
        totalChunks: number;
        added: number;
        modified: number;
        removed: number;
        baseIdentity: string;
        status: 'completed' | 'limit_reached';
    }> {
        const root = lineage.root!;
        const diff = lineage.diff!;
        const repoRoot = getRepoRoot(codebasePath) || codebasePath;
        const ignorePatterns = await this.ignorePatternManager.loadForCodebase(codebasePath, additionalIgnorePatterns);
        const supportedExtensions = this.getEffectiveSupportedExtensions(additionalSupportedExtensions);

        // Files this branch changed vs root (main) → mask root's versions at query time.
        const overridePaths = lineage.overridePaths;

        // Files to actually embed for this branch: added + modified (existing, indexable).
        // This is the branch's full diff vs main, so C (cut from B) stores B's changes
        // plus its own — cumulative, but identical chunks hit the embedding cache.
        const indexAbsPaths: string[] = [];
        for (const f of [...diff.added, ...diff.modified]) {
            const m = this.mapRepoPathToIndex(codebasePath, repoRoot, f);
            if (!m) continue;
            if (!fs.existsSync(m.abs)) continue;
            if (!this.isSupportedFile(m.rel, supportedExtensions)) continue;
            if (this.ignorePatternManager.matches(m.abs, codebasePath, ignorePatterns)) continue;
            indexAbsPaths.push(m.abs);
        }

        console.log(`[Context] 🌿 Branch delta index for ${identity}: base(root)=${root.identity}, parent=${lineage.parentIdentity} (+${diff.added.length}/~${diff.modified.length}/-${diff.deleted.length})`);

        // Fresh delta collection (parent pointer embedded in description for branch tracking).
        await this.prepareCollection(codebasePath, false, lineage.parentIdentity);
        this.currentIndexCommit = head;

        let processed = { processedFiles: 0, totalChunks: 0, status: 'completed' as 'completed' | 'limit_reached' };
        if (indexAbsPaths.length > 0) {
            processed = await this.processFileList(
                indexAbsPaths,
                codebasePath,
                (filePath, fileIndex, totalFiles) => {
                    progressCallback?.({
                        phase: `Indexing branch delta (${fileIndex}/${totalFiles})...`,
                        current: fileIndex,
                        total: totalFiles,
                        percentage: Math.round((fileIndex / totalFiles) * 100),
                    });
                },
                requestSplitter || this.codeSplitter,
                signal,
            );
        }

        const dim = await this.resolveDimension();
        await this.commitIndexState.set(identity, head, dim, {
            repoUrl,
            baseIdentity: root.identity,
            parentIdentity: lineage.parentIdentity,
            overridePaths,
            collectionName: this.getCollectionName(codebasePath),
        });
        progressCallback?.({ phase: 'Branch delta indexing complete!', current: 100, total: 100, percentage: 100 });

        return {
            mode: 'delta',
            indexedFiles: processed.processedFiles,
            totalChunks: processed.totalChunks,
            added: diff.added.length,
            modified: diff.modified.length,
            removed: diff.deleted.length,
            baseIdentity: root.identity,
            status: processed.status,
        };
    }

    /**
     * Git-driven incremental indexing (team-version core).
     *
     * Instead of always rescanning the whole repository, this compares the
     * commit the shared index is currently at (from CommitIndexState) with the
     * working tree's HEAD and processes only the changed files. First-time
     * indexing of a branch that has an indexed ancestor stores only the delta
     * relative to that base (Git-DAG layering); a branch with no ancestor is a
     * root and is fully indexed.
     *
     * Non-git repositories transparently fall back to a full `indexCodebase`.
     */
    async syncIndexByGit(
        codebasePath: string,
        progressCallback?: (progress: { phase: string; current: number; total: number; percentage: number }) => void | Promise<void>,
        additionalIgnorePatterns: string[] = [],
        additionalSupportedExtensions: string[] = [],
        requestSplitter?: Splitter,
        signal?: AbortSignal
    ): Promise<{
        mode: 'full' | 'delta' | 'incremental' | 'up-to-date';
        indexedFiles: number;
        totalChunks: number;
        added: number;
        modified: number;
        removed: number;
        baseIdentity?: string | null;
        status: 'completed' | 'limit_reached';
    }> {
        const gitEnabled = this.readBoolEnv('GIT_INCREMENTAL_ENABLED', true) && isGitRepo(codebasePath);
        const layeredEnabled = this.readBoolEnv('GIT_LAYERED_ENABLED', true);
        const head = gitEnabled ? getHeadCommit(codebasePath) : null;
        const identity = this.getRepoIdentityCached(codebasePath);
        const repoUrl = gitEnabled ? getRemoteUrl(codebasePath) : null;

        const doFull = async (force: boolean) => {
            const stats = await this.indexCodebase(
                codebasePath, progressCallback, force,
                additionalIgnorePatterns, additionalSupportedExtensions, requestSplitter, signal
            );
            return {
                mode: 'full' as const,
                indexedFiles: stats.indexedFiles,
                totalChunks: stats.totalChunks,
                added: stats.indexedFiles,
                modified: 0,
                removed: 0,
                baseIdentity: null,
                status: stats.status,
            };
        };

        // Not a git repo (or git unavailable) → preserve existing full-index behavior.
        if (!gitEnabled || !head) {
            console.log(`[Context] Git incremental unavailable for ${codebasePath}; running full index.`);
            return doFull(false);
        }

        const collectionExists = await this.hasIndex(codebasePath);
        const state = await this.commitIndexState.get(identity);

        // First index of this branch: if it has an indexed ancestor, store only the
        // delta relative to that base (Git-DAG layering); otherwise it is a root and
        // is fully indexed.
        if (!collectionExists || !state || !state.headCommit) {
            if (layeredEnabled && repoUrl) {
                const lineage = await this.resolveLineage(codebasePath, identity, head, repoUrl);
                const maxDelta = Math.max(1, this.readIntEnv('GIT_DELTA_MAX_FILES', 2000));
                if (lineage.root && lineage.diff) {
                    const diff = lineage.diff;
                    const changedCount = diff.added.length + diff.modified.length + diff.deleted.length;
                    if (changedCount <= maxDelta) {
                        return await this.indexBranchDelta(
                            codebasePath, identity, head, repoUrl, lineage,
                            progressCallback, additionalIgnorePatterns, additionalSupportedExtensions, requestSplitter, signal,
                        );
                    }
                    console.log(`[Context] Delta vs root ${lineage.root.identity} too large (${changedCount} > ${maxDelta}); indexing as full root.`);
                }
            }
            return doFull(false);
        }

        const diff = diffChangedFiles(codebasePath, state.headCommit, head);
        if (!diff) {
            // Base commit unreachable (history rewrite / shallow clone) → safe full reindex.
            console.warn(`[Context] Cannot diff ${state.headCommit.slice(0, 8)}..${head.slice(0, 8)}; doing a full reindex.`);
            return doFull(true);
        }

        // Map git's repo-root-relative paths onto the (possibly nested) index root.
        const repoRoot = getRepoRoot(codebasePath) || codebasePath;
        const ignorePatterns = await this.ignorePatternManager.loadForCodebase(codebasePath, additionalIgnorePatterns);
        const supportedExtensions = this.getEffectiveSupportedExtensions(additionalSupportedExtensions);

        const toIndexPath = (gitFile: string): { abs: string; rel: string } | null => {
            const abs = path.resolve(repoRoot, gitFile);
            const rel = path.relative(codebasePath, abs);
            if (rel.startsWith('..') || path.isAbsolute(rel)) return null; // outside index root
            return { abs, rel: rel.replace(/\\/g, '/') };
        };

        // Chunks for modified + deleted files must be removed first.
        const deletePaths = new Set<string>();
        for (const f of [...diff.modified, ...diff.deleted]) {
            const m = toIndexPath(f);
            if (m) deletePaths.add(m.rel);
        }

        // Added + modified files that still exist and pass ext/ignore filters get (re)indexed.
        const indexAbsPaths: string[] = [];
        for (const f of [...diff.added, ...diff.modified]) {
            const m = toIndexPath(f);
            if (!m) continue;
            if (!fs.existsSync(m.abs)) continue;
            if (!this.isSupportedFile(m.rel, supportedExtensions)) continue;
            if (this.ignorePatternManager.matches(m.abs, codebasePath, ignorePatterns)) continue;
            indexAbsPaths.push(m.abs);
        }

        // Nothing changed within the index root → fast-forward state, no work.
        if (deletePaths.size === 0 && indexAbsPaths.length === 0) {
            console.log(`[Context] ✅ Index already up to date for ${identity} @ ${head.slice(0, 8)}`);
            progressCallback?.({ phase: 'Already up to date', current: 100, total: 100, percentage: 100 });
            const dim = await this.resolveDimension();
            const meta = await this.computeLayerMeta(codebasePath, identity, head, repoUrl);
            await this.commitIndexState.set(identity, head, dim, { repoUrl: repoUrl || undefined, ...meta, collectionName: this.getCollectionName(codebasePath) });
            return { mode: 'up-to-date', indexedFiles: 0, totalChunks: 0, added: 0, modified: 0, removed: 0, baseIdentity: meta.baseIdentity, status: 'completed' };
        }

        console.log(`[Context] 🔄 Git incremental: ${diff.added.length} added, ${diff.modified.length} modified, ${diff.deleted.length} deleted (base ${state.headCommit.slice(0, 8)} → ${head.slice(0, 8)})`);

        // Collection should already exist; ensure it in case of drift (no force).
        await this.prepareCollection(codebasePath, false);
        this.currentIndexCommit = head;

        const collectionName = this.getCollectionName(codebasePath);
        progressCallback?.({ phase: 'Removing changed/deleted file chunks...', current: 0, total: 100, percentage: 0 });
        for (const rel of deletePaths) {
            await this.deleteFileChunks(collectionName, rel);
        }

        let processed = { processedFiles: 0, totalChunks: 0, status: 'completed' as 'completed' | 'limit_reached' };
        if (indexAbsPaths.length > 0) {
            processed = await this.processFileList(
                indexAbsPaths,
                codebasePath,
                (filePath, fileIndex, totalFiles) => {
                    progressCallback?.({
                        phase: `Indexing changed files (${fileIndex}/${totalFiles})...`,
                        current: fileIndex,
                        total: totalFiles,
                        percentage: Math.round((fileIndex / totalFiles) * 100),
                    });
                },
                requestSplitter || this.codeSplitter,
                signal
            );
        }

        // Advance the shared state to HEAD only after the delta is applied, and
        // refresh the base pointer + override paths for the layered query.
        const dim = await this.resolveDimension();
        const meta = await this.computeLayerMeta(codebasePath, identity, head, repoUrl);
        await this.commitIndexState.set(identity, head, dim, { repoUrl: repoUrl || undefined, ...meta, collectionName: this.getCollectionName(codebasePath) });
        progressCallback?.({ phase: 'Incremental indexing complete!', current: 100, total: 100, percentage: 100 });

        return {
            mode: 'incremental',
            indexedFiles: processed.processedFiles,
            totalChunks: processed.totalChunks,
            added: diff.added.length,
            modified: diff.modified.length,
            removed: diff.deleted.length,
            baseIdentity: meta.baseIdentity,
            status: processed.status,
        };
    }


    private async deleteFileChunks(collectionName: string, relativePath: string): Promise<void> {
        // Escape backslashes for Milvus query expression (Windows path compatibility)
        const escapedPath = relativePath.replace(/\\/g, '\\\\');
        const results = await this.vectorDatabase.query(
            collectionName,
            `relativePath == "${escapedPath}"`,
            ['id']
        );

        if (results.length > 0) {
            const ids = results.map(r => r.id as string).filter(id => id);
            if (ids.length > 0) {
                await this.vectorDatabase.delete(collectionName, ids);
                console.log(`[Context] Deleted ${ids.length} chunks for file ${relativePath}`);
            }
        }
    }

    /** Batch delete chunks for many files — single query + bulk delete. */
    private async deleteFileChunksBatch(collectionName: string, files: string[], signal?: AbortSignal): Promise<void> {
        if (files.length === 0) return;
        const escaped = files.map(f => `"${f.replace(/\\/g, '\\\\')}"`).join(', ');
        const BATCH_SIZE = 16384;

        try {
            // Single query — 16K chunks covers even very large repos. The
            // theoretical edge case (same set of files yields >16K chunks)
            // would require ~250 files each with 65+ chunks, which is
            // effectively impossible (such files would be filtered out by
            // size limits or the chunk cap long before).
            const results = await this.vectorDatabase.query(
                collectionName,
                `relativePath in [${escaped}]`,
                ['id'],
                BATCH_SIZE,
            );

            const allIds: string[] = [];
            if (results && results.length > 0) {
                for (const r of results) {
                    const id = r.id as string;
                    if (id) allIds.push(id);
                }
            }

            if (allIds.length > 0) {
                // Delete in batches to avoid oversized delete requests.
                for (let i = 0; i < allIds.length; i += BATCH_SIZE) {
                    if (signal?.aborted) break;
                    const batch = allIds.slice(i, i + BATCH_SIZE);
                    await this.vectorDatabase.delete(collectionName, batch);
                }
                console.log(`[Context] Batch deleted ${allIds.length} chunks for ${files.length} files`);
            }
        } catch (error: any) {
            // Fall back to per-file delete on batch failure.
            console.warn(`[Context] Batch delete failed, falling back to per-file: ${error.message}`);
            for (const file of files) {
                if (signal?.aborted) break;
                await this.deleteFileChunks(collectionName, file);
            }
        }
    }

    /**
     * Semantic search with unified implementation
     * @param codebasePath Codebase path to search in
     * @param query Search query
     * @param topK Number of results to return
     * @param threshold Similarity threshold
     */
    async semanticSearch(codebasePath: string, query: string, topK: number = 5, threshold: number = 0.5, filterExpr?: string): Promise<SemanticSearchResult[]> {
        const isHybrid = this.getIsHybrid();
        const searchType = isHybrid === true ? 'hybrid search' : 'semantic search';
        console.log(`[Context] 🔍 Executing ${searchType}: "${query}" in ${codebasePath}`);

        // Resolve the Git-DAG layer chain from CommitIndexState, then
        // delegate to searchWithLayers for the actual multi-layer search.
        const identity = this.getRepoIdentityCached(codebasePath);
        let chain = await this.resolveLayerChain(identity);
        if (chain.length === 0) {
            chain = [{ identity, collectionName: this.getCollectionName(codebasePath), mask: [] }];
        }

        const layers = chain.map(l => ({ collectionName: l.collectionName, mask: l.mask }));
        return this.searchWithLayers(layers, query, topK, threshold, filterExpr);
    }

    /** Execute one collection's search (hybrid or dense) → normalized results. */
    private async searchLayer(
        collectionName: string,
        queryVector: number[],
        queryText: string,
        topK: number,
        threshold: number,
        filterExpr: string | undefined,
        isHybrid: boolean,
    ): Promise<SemanticSearchResult[]> {
        const toResult = (document: VectorDocument, score: number): SemanticSearchResult => ({
            content: document.content,
            relativePath: document.relativePath,
            startLine: document.startLine,
            endLine: document.endLine,
            language: document.metadata.language || 'unknown',
            score,
        });

        if (isHybrid === true) {
            const searchRequests: HybridSearchRequest[] = [
                { data: queryVector, anns_field: 'vector', param: { nprobe: 10 }, limit: topK },
                { data: queryText, anns_field: 'sparse_vector', param: { drop_ratio_search: 0.2 }, limit: topK },
            ];
            const searchResults: HybridSearchResult[] = await this.vectorDatabase.hybridSearch(
                collectionName,
                searchRequests,
                { rerank: { strategy: 'rrf', params: { k: this.getRRF_K() } }, limit: topK, filterExpr },
            );
            return searchResults.map(r => toResult(r.document, r.score));
        }
        const searchResults: VectorSearchResult[] = await this.vectorDatabase.search(
            collectionName, queryVector, { topK, threshold, filterExpr },
        );
        return searchResults.map(r => toResult(r.document, r.score));
    }

    /**
     * Cross-layer global hybrid fusion. Pulls raw dense (cosine) and raw sparse
     * (BM25) hits from every layer, then fuses with one unified RRF:
     *   - dense: ranked GLOBALLY across all layers (cosine is comparable in one
     *     embedding space), so a strong branch hit and a strong main hit compete
     *     on equal footing.
     *   - sparse: ranked WITHIN each layer (BM25 scores are corpus-relative and
     *     not comparable across collections), contributed as independent RRF lists.
     * A document lives in exactly one layer (branch overrides main via masking),
     * so its final score = 1/(k+globalDenseRank) + 1/(k+layerSparseRank).
     */
    private async globalHybridFusion(
        activeLayers: Array<{ identity: string; collectionName: string; mask: string[] }>,
        queryVector: number[],
        queryText: string,
        topK: number,
        filterExpr?: string,
        threshold: number = 0,
    ): Promise<SemanticSearchResult[]> {
        const sparseSearch = this.vectorDatabase.sparseSearch!.bind(this.vectorDatabase);
        const RRF_K = this.getRRF_K();

        const perLayer = await Promise.all(activeLayers.map(async layer => {
            const f = this.combineFilters(filterExpr, this.buildMaskFilter(layer.mask));
            const [dense, sparse] = await Promise.all([
                this.vectorDatabase.search(layer.collectionName, queryVector, { topK, filterExpr: f })
                    .catch(e => { console.warn(`[Context] ⚠️  Dense search failed for '${layer.collectionName}': ${e}`); return [] as VectorSearchResult[]; }),
                sparseSearch(layer.collectionName, queryText, { topK, filterExpr: f })
                    .catch(e => { console.warn(`[Context] ⚠️  Sparse search failed for '${layer.collectionName}': ${e}`); return [] as VectorSearchResult[]; }),
            ]);
            return { dense, sparse };
        }));

        // Global dense ranking (cosine desc, comparable across layers).
        const denseRank = new Map<string, number>();
        perLayer.flatMap(p => p.dense)
            .sort((a, b) => b.score - a.score)
            .forEach((r, i) => { if (!denseRank.has(r.document.id)) denseRank.set(r.document.id, i + 1); });

        // Per-layer sparse ranking (rank within the layer that produced the hit).
        const sparseRank = new Map<string, number>();
        for (const p of perLayer) {
            p.sparse.forEach((r, i) => { if (!sparseRank.has(r.document.id)) sparseRank.set(r.document.id, i + 1); });
        }

        // Collect each candidate document once (a doc exists in a single layer).
        const docs = new Map<string, VectorDocument>();
        for (const p of perLayer) {
            for (const r of p.dense) if (!docs.has(r.document.id)) docs.set(r.document.id, r.document);
            for (const r of p.sparse) if (!docs.has(r.document.id)) docs.set(r.document.id, r.document);
        }

        const scored: SemanticSearchResult[] = [];
        for (const [id, doc] of docs) {
            let score = 0;
            const dr = denseRank.get(id);
            if (dr !== undefined) score += 1 / (RRF_K + dr);
            const sr = sparseRank.get(id);
            if (sr !== undefined) score += 1 / (RRF_K + sr);
            scored.push({
                content: doc.content,
                relativePath: doc.relativePath,
                startLine: doc.startLine,
                endLine: doc.endLine,
                language: doc.metadata.language || 'unknown',
                score,
            });
        }

        scored.sort((a, b) => b.score - a.score);
        const deduped = this.deduplicateResults(scored);
        deduped.sort((a, b) => b.score - a.score);
        // Apply score cutoff (RRF scores are in ~0.001-0.01 range;
        // threshold is treated as a relative ratio against the top score).
        const filtered = this.applyScoreCutoff(deduped, threshold);
        const contentDeduped = this.dedupNearDuplicateContent(filtered);
        return this.applyFileDiversity(contentDeduped, topK);
    }

    /**
     * Drop near-duplicate chunks across DIFFERENT files. Identical boilerplate
     * (shared credential blocks, license headers, generated stubs) often ranks
     * high in many files at once and crowds out genuinely distinct results.
     * We fingerprint each chunk by its normalized content (whitespace/identifier
     * collapsed) and keep only the highest-scored occurrence of each fingerprint.
     */
    private dedupNearDuplicateContent(results: SemanticSearchResult[]): SemanticSearchResult[] {
        const seen = new Set<string>();
        const kept: SemanticSearchResult[] = [];
        for (const r of results) {
            const fp = this.contentFingerprint(r.content);
            if (fp !== null && seen.has(fp)) continue;
            if (fp !== null) seen.add(fp);
            kept.push(r);
        }
        return kept;
    }

    /**
     * Normalize a chunk to a dedup fingerprint: lowercase, collapse whitespace,
     * strip digits/quoted values so trivially-templated blocks (env/credentials)
     * hash together. Returns null for very short content (don't dedup snippets
     * that are too small to be meaningful — avoids collapsing legitimate hits).
     */
    private contentFingerprint(content: string): string | null {
        if (!content) return null;
        // Normalize to a structural skeleton, then hash only the FIRST portion.
        // Boilerplate blocks (credential/env headers, license stubs, generated
        // prologues) share an identical opening; hashing a prefix lets us catch
        // them even when the tail differs, without collapsing legitimately
        // distinct chunks that merely end alike.
        const skeleton = content
            .replace(/"[^"]*"|'[^']*'/g, 'S')     // string literals → S
            .replace(/\$\{[^}]*\}/g, 'V')          // ${...} interpolations → V
            .replace(/\d+/g, 'N')                  // numbers → N
            .replace(/[A-Za-z_$][A-Za-z0-9_$-]*/g, 'I') // identifiers → I
            .replace(/\s+/g, '')                   // drop ALL whitespace
            .toLowerCase();
        if (skeleton.length < 60) return null;     // too small to safely dedup
        const prefix = skeleton.slice(0, 200);     // shared-opening signature
        return crypto.createHash('md5').update(prefix).digest('hex');
    }

    /**
     * Cap how many chunks a single file can contribute, so one repetitive file
     * (or several near-identical files) can't fill the whole topK. Keeps the
     * result set diverse across the codebase.
     */
    private applyFileDiversity(results: SemanticSearchResult[], topK: number): SemanticSearchResult[] {
        const perFileCap = Math.max(1, Math.ceil(topK / 4));
        const perFile = new Map<string, number>();
        const kept: SemanticSearchResult[] = [];
        for (const r of results) {
            const n = perFile.get(r.relativePath) || 0;
            if (n >= perFileCap) continue;
            perFile.set(r.relativePath, n + 1);
            kept.push(r);
            if (kept.length >= topK) break;
        }
        return kept;
    }

    /** Build a `relativePath not in [...]` expression to mask base-layer files. */
    private buildMaskFilter(mask: string[]): string | undefined {
        if (!mask || mask.length === 0) return undefined;
        const quoted = mask.map(p => `"${p.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(', ');
        return `relativePath not in [${quoted}]`;
    }

    /** AND-combine two optional Milvus filter expressions. */
    private combineFilters(a?: string, b?: string): string | undefined {
        const parts = [a, b].filter((x): x is string => !!x && x.trim().length > 0);
        if (parts.length === 0) return undefined;
        if (parts.length === 1) return parts[0];
        return parts.map(p => `(${p})`).join(' and ');
    }

    /** Shared RRF k-parameter (environment-configurable, default 100). */
    private getRRF_K(): number {
        return parseInt(envManager.get('RRF_K') || '100', 10) || 100;
    }

    /**
     * Apply a score cutoff to ranked results. In dense (cosine) mode the
     * threshold is an absolute minimum score. In hybrid/RRF mode the scores
     * are small reciprocal-rank values — the threshold is treated as a
     * relative ratio against the top score (0 disables filtering).
     */
    private applyScoreCutoff(results: SemanticSearchResult[], threshold: number): SemanticSearchResult[] {
        if (threshold <= 0 || results.length <= 1) return results;
        const top = results[0].score;
        if (top <= 0) return results;
        // RRF scores are ~0.001-0.01; cosine scores are 0-1. Use relative cutoff
        // in all modes so the same threshold value works consistently.
        const floor = top * threshold;
        return results.filter(r => r.score >= floor);
    }

    /**
     * Deduplicate search results by file + line range overlap.
     * Groups by filePath, sorts by startLine, then keeps only the first result
     * when two chunks from the same file overlap >50%. O(n log n) — one sort
     * per file instead of O(n²) pairwise comparison.
     */
    private deduplicateResults(results: SemanticSearchResult[]): SemanticSearchResult[] {
        // Group by filePath so overlap checks only happen within the same file.
        const byFile = new Map<string, SemanticSearchResult[]>();
        for (const r of results) {
            const list = byFile.get(r.relativePath);
            if (list) {
                list.push(r);
            } else {
                byFile.set(r.relativePath, [r]);
            }
        }

        const kept: SemanticSearchResult[] = [];
        for (const [, fileResults] of byFile) {
            // Sort by startLine ascending — higher scored results come first
            // when startLine ties (stable sort keeps insertion order).
            fileResults.sort((a, b) => a.startLine - b.startLine || b.score - a.score);

            for (const result of fileResults) {
                // Only need to check against the last kept result for this file
                // (the one with the highest startLine among kept). Since both
                // `fileResults` and `kept` are ordered by startLine, if this
                // result doesn't overlap the last one, it won't overlap any
                // earlier one either.
                const last = kept.length > 0 ? kept[kept.length - 1] : null;
                if (last && last.relativePath === result.relativePath) {
                    const overlapStart = Math.max(last.startLine, result.startLine);
                    const overlapEnd = Math.min(last.endLine, result.endLine);
                    if (overlapStart <= overlapEnd) {
                        const overlapSize = overlapEnd - overlapStart + 1;
                        const resultSize = result.endLine - result.startLine + 1;
                        if (resultSize > 0 && overlapSize / resultSize > 0.5) {
                            continue; // this result is subsumed → skip
                        }
                    }
                }
                kept.push(result);
            }
        }

        return kept;
    }

    /**
     * Check if index exists for codebase
     * @param codebasePath Codebase path to check
     * @returns Whether index exists
     */
    async hasIndex(codebasePath: string): Promise<boolean> {
        const collectionName = this.getCollectionName(codebasePath);
        return await this.vectorDatabase.hasCollection(collectionName);
    }

    /**
     * Clear index
     * @param codebasePath Codebase path to clear index for
     * @param progressCallback Optional progress callback function
     */
    async clearIndex(
        codebasePath: string,
        progressCallback?: (progress: { phase: string; current: number; total: number; percentage: number }) => void
    ): Promise<void> {
        console.log(`[Context] 🧹 Cleaning index data for ${codebasePath}...`);

        progressCallback?.({ phase: 'Checking existing index...', current: 0, total: 100, percentage: 0 });

        const collectionName = this.getCollectionName(codebasePath);
        const collectionExists = await this.vectorDatabase.hasCollection(collectionName);

        progressCallback?.({ phase: 'Removing index data...', current: 50, total: 100, percentage: 50 });

        if (collectionExists) {
            await this.vectorDatabase.dropCollection(collectionName);
        }

        // Remove the shared commit-state record so a later index starts fresh
        // (full) rather than trying to diff against a now-dropped collection.
        try {
            const identity = this.getRepoIdentityCached(codebasePath);
            await this.commitIndexState.remove(identity);
        } catch (error) {
            console.warn(`[Context] ⚠️ Failed to remove commit state during clear (non-fatal): ${error}`);
        }

        progressCallback?.({ phase: 'Index cleared', current: 100, total: 100, percentage: 100 });
        console.log('[Context] ✅ Index data cleaned');
    }

    /**
     * Update ignore patterns (merges with default patterns and existing patterns)
     * @param ignorePatterns Array of ignore patterns to add to defaults
     */
    updateIgnorePatterns(ignorePatterns: string[]): void {
        this.ignorePatternManager.updatePatterns(
            [...DEFAULT_IGNORE_PATTERNS, ...ignorePatterns],
            DEFAULT_IGNORE_PATTERNS.length,
        );
    }

    /**
     * Add custom ignore patterns (from MCP or other sources) without replacing existing ones
     * @param customPatterns Array of custom ignore patterns to add
     */
    addCustomIgnorePatterns(customPatterns: string[]): void {
        this.ignorePatternManager.addCustomPatterns(customPatterns);
    }

    /**
     * Reset ignore patterns to defaults only
     */
    resetIgnorePatternsToDefaults(): void {
        this.ignorePatternManager.resetToDefaults(DEFAULT_IGNORE_PATTERNS);
    }

    /**
     * Update embedding instance
     * @param embedding New embedding instance
     */
    updateEmbedding(embedding: Embedding): void {
        this.embedding = embedding;
        // Model changed → invalidate cached dimension and embedding-cache instance
        // so we never key vectors under the wrong model/dimension.
        this.knownDimension = null;
        this.embeddingCacheInstance = null;
        this.embeddingCacheKey = null;
        console.log(`[Context] 🔄 Updated embedding provider: ${embedding.getProvider()}`);
    }

    /**
     * Update vector database instance
     * @param vectorDatabase New vector database instance
     */
    updateVectorDatabase(vectorDatabase: VectorDatabase): void {
        this.vectorDatabase = vectorDatabase;
        // Rebind team-version state to the new backend.
        this.commitIndexState = new CommitIndexState(vectorDatabase);
        this.embeddingCacheInstance = null;
        this.embeddingCacheKey = null;
        console.log(`[Context] 🔄 Updated vector database`);
    }

    /**
     * Update splitter instance
     * @param splitter New splitter instance
     */
    updateSplitter(splitter: Splitter): void {
        this.codeSplitter = splitter;
        console.log(`[Context] 🔄 Updated splitter instance`);
    }

    /**
     * Prepare vector collection
     */
    private async prepareCollection(codebasePath: string, forceReindex: boolean = false, parentIdentity?: string | null): Promise<void> {
        const isHybrid = this.getIsHybrid();
        const collectionType = isHybrid === true ? 'hybrid vector' : 'vector';
        console.log(`[Context] 🔧 Preparing ${collectionType} collection for codebase: ${codebasePath}${forceReindex ? ' (FORCE REINDEX)' : ''}`);
        const collectionName = this.getCollectionName(codebasePath);

        // Check if collection already exists
        const collectionExists = await this.vectorDatabase.hasCollection(collectionName);

        if (collectionExists && !forceReindex) {
            console.log(`📋 Collection ${collectionName} already exists, skipping creation`);
            return;
        }

        // Detect dimension BEFORE dropping the old collection to avoid data loss
        // if dimension detection fails (e.g. invalid API key, network error)
        console.log(`[Context] 🔍 Detecting embedding dimension for ${this.embedding.getProvider()} provider...`);
        const dimension = await this.embedding.detectDimension();
        // Cache the detected dimension so the embedding cache collection is keyed
        // with the exact same dimension as the code collection.
        this.knownDimension = dimension;
        console.log(`[Context] 📏 Detected dimension: ${dimension} for ${this.embedding.getProvider()}`);

        if (collectionExists && forceReindex) {
            console.log(`[Context] 🗑️  Dropping existing collection ${collectionName} for force reindex...`);
            await this.vectorDatabase.dropCollection(collectionName);
            console.log(`[Context] ✅ Collection ${collectionName} dropped successfully`);
        }
        const repoIdentity = this.getRepoIdentityCached(codebasePath);
        // Description = `codebasePath:<identity>` for a root branch, plus `|tracks:<branch>`
        // for a sub-branch naming the branch it tracks (its immediate parent). Lets the
        // index-tree UI reconstruct the branch-tracking chain (A ← B ← C). Keeps the
        // `codebasePath:` prefix for collection description parse (everything before first `|`).
        const repoUrl = getRemoteUrl(codebasePath);
        const trackedBranch = parentIdentity && repoUrl ? this.branchOf(parentIdentity, repoUrl) : '';
        const description = trackedBranch
            ? `codebasePath:${repoIdentity}|tracks:${trackedBranch}`
            : `codebasePath:${repoIdentity}`;

        if (isHybrid === true) {
            await this.vectorDatabase.createHybridCollection(collectionName, dimension, description);
        } else {
            await this.vectorDatabase.createCollection(collectionName, dimension, description);
        }

        console.log(`[Context] ✅ Collection ${collectionName} created successfully (dimension: ${dimension})`);
    }

    /**
     * Recursively get all code files in the codebase
     */
    private async getCodeFiles(
        codebasePath: string,
        ignorePatterns: string[] = this.ignorePatternManager.getPatterns(),
        supportedExtensions: string[] = this.supportedExtensions
    ): Promise<string[]> {
        const files: string[] = [];

        // Try git ls-files first — respects .gitignore and is much faster.
        // Filter in JS to avoid command-line length limits with many extensions.
        try {
            const extSet = new Set(supportedExtensions);
            const nameSet = new Set(this.supportedFilenames);
            const output = execSync(`git -C "${codebasePath}" ls-files --cached --others --exclude-standard`, {
                encoding: 'utf-8',
                timeout: 10_000,
                maxBuffer: 10 * 1024 * 1024,
            });
            const lines = output.trim().split('\n').filter(Boolean)
                .filter(f => extSet.has(path.extname(f)) || nameSet.has(path.basename(f)));
            for (const line of lines) {
                const fullPath = path.join(codebasePath, line);
                if (fs.existsSync(fullPath)) {
                    files.push(fullPath);
                }
            }
            return files;
        } catch {
            // Fallback: filesystem walk with ignore patterns
        }

        // Fallback filesystem walk
        const traverseDirectory = async (currentPath: string) => {
            const entries = await fs.promises.readdir(currentPath, { withFileTypes: true });

            for (const entry of entries) {
                const fullPath = path.join(currentPath, entry.name);

                // Check if path matches ignore patterns
                if (this.ignorePatternManager.matches(fullPath, codebasePath, ignorePatterns)) {
                    continue;
                }

                if (entry.isDirectory()) {
                    await traverseDirectory(fullPath);
                } else if (entry.isFile()) {
                    if (this.isSupportedFile(entry.name, supportedExtensions)) {
                        files.push(fullPath);
                    }
                }
            }
        };

        await traverseDirectory(codebasePath);
        return files;
    }

    /**
 * Process a list of files with streaming chunk processing
 * @param filePaths Array of file paths to process
 * @param codebasePath Base path for the codebase
 * @param onFileProcessed Callback called when each file is processed
 * @returns Object with processed file count and total chunk count
 */
    private async processFileList(
        filePaths: string[],
        codebasePath: string,
        onFileProcessed?: (filePath: string, fileIndex: number, totalFiles: number) => void,
        splitter: Splitter = this.codeSplitter,
        signal?: AbortSignal,
        collectionNameOverride?: string,
    ): Promise<{ processedFiles: number; totalChunks: number; status: 'completed' | 'limit_reached' }> {
        const isHybrid = this.getIsHybrid();
        const EMBEDDING_BATCH_SIZE = Math.max(1, parseInt(envManager.get('EMBEDDING_BATCH_SIZE') || '100', 10));
        const CHUNK_LIMIT = Math.max(1, parseInt(envManager.get('INDEX_CHUNK_LIMIT') || '450000', 10));
        console.log(`[Context] 🔧 Using EMBEDDING_BATCH_SIZE: ${EMBEDDING_BATCH_SIZE}`);

        let chunkBuffer: Array<{ chunk: CodeChunk; codebasePath: string }> = [];
        /** Chunks that failed to embed and will be retried at the end. */
        let retryBuffer: Array<{ chunk: CodeChunk; codebasePath: string }> = [];
        let processedFiles = 0;
        let totalChunks = 0;
        let limitReached = false;

        for (let i = 0; i < filePaths.length; i++) {
            // Cooperative cancellation: bail out at the next file boundary so the
            // caller (e.g. clear_index) can rely on no further inserts/snapshot
            // writes happening once it has signalled abort. See issue #199.
            if (signal?.aborted) {
                throw new IndexAbortError(`Indexing aborted after processing ${processedFiles}/${filePaths.length} files`);
            }

            const filePath = filePaths[i];

            try {
                const content = await fs.promises.readFile(filePath, 'utf-8');
                const language = this.getLanguageFromExtension(path.extname(filePath));
                const chunks = await splitter.split(content, language, filePath);

                // Log files with many chunks or large content
                if (chunks.length > 50) {
                    console.warn(`[Context] ⚠️  File ${filePath} generated ${chunks.length} chunks (${Math.round(content.length / 1024)}KB)`);
                } else if (content.length > 100000) {
                    console.log(`📄 Large file ${filePath}: ${Math.round(content.length / 1024)}KB -> ${chunks.length} chunks`);
                }

                // Add chunks to buffer
                for (const chunk of chunks) {
                    chunkBuffer.push({ chunk, codebasePath });
                    totalChunks++;

                    // Process batch when buffer reaches EMBEDDING_BATCH_SIZE
                    if (chunkBuffer.length >= EMBEDDING_BATCH_SIZE) {
                        // Check abort before each batch (not just at file boundaries).
                        if (signal?.aborted) {
                            throw new IndexAbortError(`Indexing aborted at chunk ${totalChunks}`);
                        }
                        try {
                            await this.processChunkBuffer(chunkBuffer, signal, collectionNameOverride);
                            chunkBuffer = []; // Clear on success
                        } catch (error) {
                            if (error instanceof EmbeddingError) {
                                throw error;
                            }
                            const searchType = isHybrid === true ? 'hybrid' : 'regular';
                            console.error(`[Context] ❌ Failed to process chunk batch for ${searchType}:`, error);
                            // Move failed chunks to retry buffer instead of discarding.
                            if (chunkBuffer.length > 0) {
                                console.warn(`[Context] Scheduling ${chunkBuffer.length} chunks for retry`);
                                retryBuffer.push(...chunkBuffer);
                            }
                            chunkBuffer = [];
                        }
                    }

                    // Check if chunk limit is reached
                    if (totalChunks >= CHUNK_LIMIT) {
                        console.warn(`[Context] ⚠️  Chunk limit of ${CHUNK_LIMIT} reached. Stopping indexing.`);
                        limitReached = true;
                        break; // Exit the inner loop (over chunks)
                    }
                }

                processedFiles++;
                onFileProcessed?.(filePath, i + 1, filePaths.length);

                if (limitReached) {
                    break; // Exit the outer loop (over files)
                }

            } catch (error) {
                if (error instanceof EmbeddingError) {
                    throw error;
                }
                console.warn(`[Context] ⚠️  Skipping file ${filePath}: ${error}`);
            }
        }

        // Process any remaining chunks in the buffer (skip if cancelled).
        if (chunkBuffer.length > 0 && !signal?.aborted) {
            const searchType = isHybrid === true ? 'hybrid' : 'regular';
            console.log(`📝 Processing final batch of ${chunkBuffer.length} chunks for ${searchType}`);
            try {
                await this.processChunkBuffer(chunkBuffer, signal, collectionNameOverride);
            } catch (error) {
                if (error instanceof EmbeddingError) { throw error; }
                retryBuffer.push(...chunkBuffer);
                console.error(`[Context] ❌ Failed final batch; ${chunkBuffer.length} chunks queued for retry`);
            }
        }

        // Retry failed chunks once (non-fatal: log failures but don't stop).
        if (retryBuffer.length > 0 && !signal?.aborted) {
            console.warn(`[Context] 🔄 Retrying ${retryBuffer.length} previously failed chunks...`);
            try {
                await this.processChunkBuffer(retryBuffer, signal, collectionNameOverride);
            } catch (error: any) {
                if (error instanceof EmbeddingError) { throw error; }
                console.warn(`[Context] ⚠️  ${retryBuffer.length} chunks could not be indexed after retry — these files may have incomplete search coverage. Next Merkle sync will retry. Error: ${error.message}`);
            }
        }

        if (signal?.aborted) {
            throw new IndexAbortError(`Indexing aborted after processing ${processedFiles}/${filePaths.length} files`);
        }

        return {
            processedFiles,
            totalChunks,
            status: limitReached ? 'limit_reached' : 'completed'
        };
    }

    /**
 * Process accumulated chunk buffer
 */
    private async processChunkBuffer(
        chunkBuffer: Array<{ chunk: CodeChunk; codebasePath: string }>,
        signal?: AbortSignal,
        collectionNameOverride?: string,
    ): Promise<void> {
        if (chunkBuffer.length === 0) return;
        if (signal?.aborted) return;

        // Extract chunks and ensure they all have the same codebasePath
        const chunks = chunkBuffer.map(item => item.chunk);
        const codebasePath = chunkBuffer[0].codebasePath;

        // Estimate tokens (rough estimation: 1 token ≈ 4 characters)
        const estimatedTokens = chunks.reduce((sum, chunk) => sum + Math.ceil(chunk.content.length / 4), 0);

        const isHybrid = this.getIsHybrid();
        const searchType = isHybrid === true ? 'hybrid' : 'regular';
        console.log(`[Context] 🔄 Processing batch of ${chunks.length} chunks (~${estimatedTokens} tokens) for ${searchType}`);
        await this.processChunkBatch(chunks, codebasePath, collectionNameOverride);
    }

    /**
     * Process a batch of chunks
     */
    private async processChunkBatch(chunks: CodeChunk[], codebasePath: string, collectionNameOverride?: string): Promise<void> {
        const isHybrid = this.getIsHybrid();
        const repoIdentity = this.getRepoIdentityCached(codebasePath);
        const commit = this.currentIndexCommit || '';
        const targetCollection = collectionNameOverride || this.getCollectionName(codebasePath);

        // ── Content-hash embedding cache ──────────────────────────────
        // Hash every chunk, reuse any vectors already computed (by this repo,
        // another branch, or a teammate), and only call the embedding model for
        // genuine cache misses. This is the PRD's Embedding Deduplication: the
        // expensive vectorization runs once per unique chunk content.
        const hashes = chunks.map(chunk => hashChunk(chunk.content));
        const dimension = await this.resolveDimension();
        const cache = this.getEmbeddingCache(dimension);
        const cached = await cache.getMany(hashes);

        const vectors: number[][] = new Array(chunks.length);
        const missIndices: number[] = [];
        for (let i = 0; i < chunks.length; i++) {
            const hit = cached.get(hashes[i]);
            if (hit) {
                vectors[i] = hit;
            } else {
                missIndices.push(i);
            }
        }

        if (missIndices.length > 0) {
            const missContents = missIndices.map(i => chunks[i].content);
            let missEmbeddings: EmbeddingVector[] = [];
            // Exponential backoff retry for embedding API (transient errors only).
            const RETRY_MAX = 3;
            const RETRY_BASE_MS = 500;
            let lastError: Error | null = null;
            let success = false;
            for (let attempt = 0; attempt < RETRY_MAX; attempt++) {
                try {
                    if (attempt > 0) {
                        const delay = RETRY_BASE_MS * Math.pow(2, attempt - 1);
                        console.warn(`[Context] 🔄 Embedding API retry ${attempt}/${RETRY_MAX - 1} after ${delay}ms...`);
                        await new Promise(r => setTimeout(r, delay));
                    }
                    missEmbeddings = await this.embedding.embedBatch(missContents);
                    success = true;
                    break;
                } catch (error: any) {
                    lastError = error;
                    const msg = error?.message || String(error);
                    // Fatal errors (auth, quota) should not be retried.
                    if (msg.includes('401') || msg.includes('403') || msg.includes('quota') ||
                        msg.includes('invalid') || msg.includes('Unauthorized')) {
                        break;
                    }
                }
            }
            if (!success) {
                const errorMessage = lastError instanceof Error ? lastError.message : String(lastError);
                throw new EmbeddingError(`Embedding API error (batch size: ${missContents.length}): ${errorMessage}`);
            }
            this.validateEmbeddings(missEmbeddings, missIndices.length);

            const toCache: Array<{ hash: string; vector: number[] }> = [];
            for (let k = 0; k < missIndices.length; k++) {
                const idx = missIndices[k];
                vectors[idx] = missEmbeddings[k].vector;
                toCache.push({ hash: hashes[idx], vector: missEmbeddings[k].vector });
            }
            // Persist freshly-computed vectors for future reuse (non-fatal on failure).
            await cache.setMany(toCache);
        }

        console.log(`[Context] 🧠 Embedding cache: ${cached.size} hit / ${missIndices.length} miss (batch of ${chunks.length})`);

        if (isHybrid === true) {
            // Create hybrid vector documents
            const documents: VectorDocument[] = chunks.map((chunk, index) => {
                if (!chunk.metadata.filePath) {
                    throw new Error(`Missing filePath in chunk metadata at index ${index}`);
                }

                const relativePath = path.relative(codebasePath, chunk.metadata.filePath);
                const fileExtension = path.extname(chunk.metadata.filePath);
                const { filePath, startLine, endLine, ...restMetadata } = chunk.metadata;

                return {
                    id: this.generateId(relativePath, chunk.metadata.startLine || 0, chunk.metadata.endLine || 0, chunk.content),
                    content: chunk.content, // Full text content for BM25 and storage
                    vector: vectors[index], // Dense vector (cached or freshly embedded)
                    relativePath,
                    startLine: chunk.metadata.startLine || 0,
                    endLine: chunk.metadata.endLine || 0,
                    fileExtension,
                    metadata: {
                        ...restMetadata,
                        codebasePath: repoIdentity, // 这里替换成 url:branch
                        language: chunk.metadata.language || 'unknown',
                        chunkIndex: index,
                        chunkHash: hashes[index], // content hash for dedup / cache
                        commit // HEAD commit this chunk was indexed at
                    }
                };
            });

            // Store to vector database
            await this.vectorDatabase.insertHybrid(targetCollection, documents);
        } else {
            // Create regular vector documents
            const documents: VectorDocument[] = chunks.map((chunk, index) => {
                if (!chunk.metadata.filePath) {
                    throw new Error(`Missing filePath in chunk metadata at index ${index}`);
                }

                const relativePath = path.relative(codebasePath, chunk.metadata.filePath);
                const fileExtension = path.extname(chunk.metadata.filePath);
                const { filePath, startLine, endLine, ...restMetadata } = chunk.metadata;

                return {
                    id: this.generateId(relativePath, chunk.metadata.startLine || 0, chunk.metadata.endLine || 0, chunk.content),
                    vector: vectors[index],
                    content: chunk.content,
                    relativePath,
                    startLine: chunk.metadata.startLine || 0,
                    endLine: chunk.metadata.endLine || 0,
                    fileExtension,
                    metadata: {
                        ...restMetadata,
                        codebasePath: repoIdentity,
                        language: chunk.metadata.language || 'unknown',
                        chunkIndex: index,
                        chunkHash: hashes[index],
                        commit
                    }
                };
            });

            await this.vectorDatabase.insert(targetCollection, documents);
        }
    }

    /**
     * Validate that the embedding batch response is well-formed before writing
     * any vectors to Milvus. Throwing EmbeddingError here aborts the entire
     * indexing run so that no partial / empty vectors are persisted.
     *
     * @param embeddings   - Array of embedding vectors returned by the API.
     * @param expectedCount - Number of chunks submitted in the batch request.
     * @throws EmbeddingError if the response is missing, mismatched, or contains
     *         any empty vector.
     * @returns void
     */
    private validateEmbeddings(embeddings: EmbeddingVector[], expectedCount: number): void {
        // Guard against non-array return values (e.g. API returning null or an
        // error object instead of throwing).
        if (!Array.isArray(embeddings)) {
            throw new EmbeddingError('Embedding API returned invalid embedding batch response');
        }

        // A partial response would silently mis-align embeddings[i] with chunks[i],
        // producing wrong vectors in Milvus — treat it as a hard failure.
        if (embeddings.length !== expectedCount) {
            throw new EmbeddingError(`Embedding API returned ${embeddings.length} embeddings for ${expectedCount} chunks`);
        }

        // Check each vector; an empty vector inserted into Milvus
        // would corrupt search results for that chunk's file.
        embeddings.forEach((embedding, index) => {
            if (!embedding || !Array.isArray(embedding.vector) || embedding.vector.length === 0) {
                throw new EmbeddingError(`Embedding API returned empty embedding vector at index ${index}`);
            }
        });
    }

    /**
     * Get programming language based on file extension
     */
    private getLanguageFromExtension(ext: string): string {
        const languageMap: Record<string, string> = {
            '.ts': 'typescript',
            '.tsx': 'typescript',
            '.js': 'javascript',
            '.jsx': 'javascript',
            '.py': 'python',
            '.java': 'java',
            '.cpp': 'cpp',
            '.c': 'c',
            '.h': 'c',
            '.hpp': 'cpp',
            '.cs': 'csharp',
            '.go': 'go',
            '.rs': 'rust',
            '.php': 'php',
            '.rb': 'ruby',
            '.swift': 'swift',
            '.kt': 'kotlin',
            '.scala': 'scala',
            '.m': 'objective-c',
            '.mm': 'objective-c',
            '.dart': 'dart',
            '.sol': 'solidity',
            '.ipynb': 'jupyter',
            '.md': 'markdown',
            '.markdown': 'markdown',
        };
        return languageMap[ext] || 'text';
    }

    /**
     * Generate unique ID from chunk location. The combination of relativePath,
     * startLine, and endLine uniquely identifies a chunk — no need for content hashing.
     * Special characters are replaced with safe alternatives.
     */
    private generateId(relativePath: string, startLine: number, endLine: number, _content: string): string {
        const safe = relativePath.replace(/[^a-zA-Z0-9._-]/g, '_');
        return `chunk_${safe}:${startLine}:${endLine}`;
    }

    /**
     * Read ignore patterns from file (e.g., .gitignore)
     * @param filePath Path to the ignore file
     * @returns Array of ignore patterns
     */
    static async getIgnorePatternsFromFile(filePath: string): Promise<string[]> {
        return IgnorePatternManager.fromFile(filePath);
    }

    /**
     * Get custom extensions from environment variables
     * Supports CUSTOM_EXTENSIONS as comma-separated list
     * @returns Array of custom extensions
     */
    private getCustomExtensionsFromEnv(): string[] {
        const envExtensions = envManager.get('CUSTOM_EXTENSIONS');
        if (!envExtensions) {
            return [];
        }

        try {
            const extensions = envExtensions
                .split(',')
                .map(ext => ext.trim())
                .filter(ext => ext.length > 0)
                .map(ext => ext.startsWith('.') ? ext : `.${ext}`); // Ensure extensions start with dot

            return extensions;
        } catch (error) {
            console.warn(`[Context] ⚠️  Failed to parse CUSTOM_EXTENSIONS: ${error}`);
            return [];
        }
    }

    /**
     * Get custom ignore patterns from environment variables  
     * Supports CUSTOM_IGNORE_PATTERNS as comma-separated list
     * @returns Array of custom ignore patterns
     */
    private getCustomIgnorePatternsFromEnv(): string[] {
        const envIgnorePatterns = envManager.get('CUSTOM_IGNORE_PATTERNS');
        if (!envIgnorePatterns) {
            return [];
        }

        try {
            const patterns = envIgnorePatterns
                .split(',')
                .map(pattern => pattern.trim())
                .filter(pattern => pattern.length > 0);

            return patterns;
        } catch (error) {
            console.warn(`[Context] ⚠️  Failed to parse CUSTOM_IGNORE_PATTERNS: ${error}`);
            return [];
        }
    }

    private normalizeExtensions(extensions: string[]): string[] {
        return extensions
            .map(ext => ext.trim())
            .filter(ext => ext.length > 0)
            .map(ext => ext.startsWith('.') ? ext : `.${ext}`);
    }

    /**
     * Add custom extensions (from MCP or other sources) without replacing existing ones
     * @param customExtensions Array of custom extensions to add
     */
    addCustomExtensions(customExtensions: string[]): void {
        if (customExtensions.length === 0) return;

        const normalizedExtensions = this.normalizeExtensions(customExtensions);

        // Merge current extensions with new custom extensions, avoiding duplicates
        const mergedExtensions = [...this.supportedExtensions, ...normalizedExtensions];
        const uniqueExtensions: string[] = [...new Set(mergedExtensions)];
        this.supportedExtensions = uniqueExtensions;
        console.log(`[Context] 📎 Added ${customExtensions.length} custom extensions. Total: ${this.supportedExtensions.length} extensions`);
    }

    /**
     * Get current splitter information
     */
    getSplitterInfo(): { type: string; hasBuiltinFallback: boolean; supportedLanguages?: string[] } {
        const splitterName = this.codeSplitter.constructor.name;

        if (splitterName === 'AstCodeSplitter') {
            return {
                type: 'ast',
                hasBuiltinFallback: true,
                supportedLanguages: AstCodeSplitter.getSupportedLanguages()
            };
        } else {
            return {
                type: 'langchain',
                hasBuiltinFallback: false
            };
        }
    }

    /**
     * Check if current splitter supports a specific language
     * @param language Programming language
     */
    isLanguageSupported(language: string): boolean {
        const splitterName = this.codeSplitter.constructor.name;

        if (splitterName === 'AstCodeSplitter') {
            return AstCodeSplitter.isLanguageSupported(language);
        }

        // LangChain splitter supports most languages
        return true;
    }

    /**
     * Get which strategy would be used for a specific language
     * @param language Programming language
     */
    getSplitterStrategyForLanguage(language: string): { strategy: 'ast' | 'langchain'; reason: string } {
        const splitterName = this.codeSplitter.constructor.name;

        if (splitterName === 'AstCodeSplitter') {
            const isSupported = AstCodeSplitter.isLanguageSupported(language);

            return {
                strategy: isSupported ? 'ast' : 'langchain',
                reason: isSupported
                    ? 'Language supported by AST parser'
                    : 'Language not supported by AST, will fallback to LangChain'
            };
        } else {
            return {
                strategy: 'langchain',
                reason: 'Using LangChain splitter directly'
            };
        }
    }

    // ── Dev-aware indexing (team development) ──────────────────────────

    /** LRU cache for query embeddings to avoid repeated API calls for common queries. */
    private queryEmbeddingCache: Map<string, { vector: number[]; ts: number }> = new Map();
    private static readonly QUERY_CACHE_MAX = 64;
    private static readonly QUERY_CACHE_TTL_MS = 5 * 60 * 1000;

    /** Get or compute a query embedding, with LRU caching. */
    private async getQueryEmbedding(query: string): Promise<EmbeddingVector> {
        const now = Date.now();
        const cached = this.queryEmbeddingCache.get(query);
        if (cached && (now - cached.ts) < Context.QUERY_CACHE_TTL_MS) {
            return { vector: cached.vector, dimension: cached.vector.length };
        }
        const embedding = await this.embedding.embed(query);
        if (this.queryEmbeddingCache.size >= Context.QUERY_CACHE_MAX) {
            let oldestKey = '';
            let oldestTs = Infinity;
            for (const [k, v] of this.queryEmbeddingCache) {
                if (v.ts < oldestTs) { oldestTs = v.ts; oldestKey = k; }
            }
            if (oldestKey) this.queryEmbeddingCache.delete(oldestKey);
        }
        this.queryEmbeddingCache.set(query, { vector: embedding.vector, ts: now });
        return embedding;
    }


    /**
     * Collection name for the shared root (main/master) branch.
     * The root is indexed by the server-side git-index-service; the
     * developer MCP never writes to it. Identity = `url:main`.
     */
    getRootCollectionName(codebasePath: string): string {
        const repoUrl = getRemoteUrl(codebasePath);
        if (!repoUrl) return this.getCollectionName(codebasePath);
        const rootBranchesStr = envManager.get('GIT_ROOT_BRANCHES') || 'main,master';
        const rootBranch = rootBranchesStr.split(',')[0].trim();
        const rootIdentity = `${repoUrl}:${rootBranch}`;
        return this.getCollectionNameForIdentity(rootIdentity);
    }

    /**
     * Search across explicit layers. Each layer is `{ collectionName, mask? }`.
     * The mask excludes base-layer files already overridden by a nearer layer.
     * Results are globally re-ranked and deduped.
     *
     * This is the dev-aware equivalent of `resolveLayerChain` + `semanticSearch`;
     * it does NOT depend on CommitIndexState.
     */
    async searchWithLayers(
        layers: Array<{ collectionName: string; mask?: string[] }>,
        query: string,
        topK: number = 5,
        threshold: number = 0.5,
        filterExpr?: string,
    ): Promise<SemanticSearchResult[]> {
        const isHybrid = this.getIsHybrid();
        const searchType = isHybrid === true ? 'hybrid' : 'semantic';
        console.log(`[Context] 🔍 Dev-aware ${searchType} over ${layers.length} layer(s): "${query}"`);

        if (layers.length === 0) return [];

        // Only search layers whose collection exists.
        const existence = await Promise.all(
            layers.map(l => this.vectorDatabase.hasCollection(l.collectionName).catch(() => false)),
        );
        const activeLayers = layers.filter((_, i) => existence[i]);
        if (activeLayers.length === 0) {
            console.warn('[Context] ⚠️  None of the requested layer collections exist.');
            return [];
        }

        // Embed query once.
        const queryEmbedding: EmbeddingVector = await this.getQueryEmbedding(query);
        // Multi-layer hybrid → global RRF.
        if (isHybrid && activeLayers.length > 1 && typeof this.vectorDatabase.sparseSearch === 'function') {
            const layerObjs = activeLayers.map(l => ({
                identity: l.collectionName,
                collectionName: l.collectionName,
                mask: l.mask || [],
            }));
            const fused = await this.globalHybridFusion(layerObjs, queryEmbedding.vector, query, topK, filterExpr, threshold);
            console.log(`[Context] ✅ Dev-aware RRF → ${fused.length} results`);
            return fused;
        }

        // Per-layer search + mask.
        const perLayer = await Promise.all(
            activeLayers.map(layer => {
                const layerFilter = this.combineFilters(filterExpr, this.buildMaskFilter(layer.mask || []));
                return this.searchLayer(
                    layer.collectionName, queryEmbedding.vector, query, topK, threshold, layerFilter, isHybrid,
                ).catch(error => {
                    console.warn(`[Context] ⚠️  Layer search '${layer.collectionName}' failed: ${error}`);
                    return [] as SemanticSearchResult[];
                });
            }),
        );

        // Global re-rank + dedup.
        const all: SemanticSearchResult[] = perLayer.flat();
        all.sort((a, b) => b.score - a.score);
        const deduped = this.deduplicateResults(all);
        deduped.sort((a, b) => b.score - a.score);
        // 文档降权：自然语言查询时 .md/.rst 等文档散文与查询语义更接近，
        // 容易把真正的代码实现压出 topK（实测 requests-flow top5 全是 docs）。
        const codeWeighted = this.penalizeDocResults(deduped);
        const filtered = this.applyScoreCutoff(codeWeighted, threshold);
        const contentDeduped = this.dedupNearDuplicateContent(filtered);
        const finalResults = this.applyFileDiversity(contentDeduped, topK);
        console.log(`[Context] ✅ Dev-aware search: ${all.length} raw → ${finalResults.length} results`);
        return finalResults;
    }

    /**
     * Down-rank prose/documentation files so natural-language queries surface
     * code over docs. Docs often embed nearer to an NL query than the code that
     * actually implements it, crowding the implementation out of topK.
     * Controlled by SEARCH_DOC_PENALTY (0 disables; default 0.5 = docs keep half score).
     */
    private penalizeDocResults(results: SemanticSearchResult[]): SemanticSearchResult[] {
        const penalty = parseFloat(envManager.get('SEARCH_DOC_PENALTY') || '0.5');
        if (penalty <= 0 || penalty >= 1) return results;
        const isDoc = (r: SemanticSearchResult): boolean => {
            const lang = (r.language || '').toLowerCase();
            if (['markdown', 'text', 'rst', 'asciidoc', 'adoc', 'tex', 'org'].includes(lang)) return true;
            return /\.(md|markdown|rst|adoc|asciidoc|txt|tex|org)$/i.test(r.relativePath);
        };
        const weighted = results.map(r =>
            isDoc(r) ? { ...r, score: r.score * penalty } : r,
        );
        weighted.sort((a, b) => b.score - a.score);
        return weighted;
    }
}
