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
    HybridSearchResult,
    readOnlyVectorDatabase,
    ReadOnlyVectorDatabaseError
} from './vectordb';
import { SemanticSearchResult } from './types';
import { envManager } from './utils/env-manager';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { execSync } from 'child_process';
import { getRepoIdentity, readHeadRef } from './utils/git-identity';
import { collectionNameForIdentity } from './utils/collection-name';
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

/**
 * 机器生成的文件名（protobuf / flatbuffers / Qt moc）。与 vendored 第三方同一档降权：
 * 都不是本仓库开发者手写的代码。与 graph 包的 `GENERATED_FILE_RE` 是同一套规则 ——
 * core 不依赖 graph，所以两边各留一份，改一处要改两处。
 */
const GENERATED_FILE_RE =
    /(\.pb\.(cc|h|go)|_pb2(_grpc)?\.py|[._-]generated\.[^./]+|\.g\.dart)$|(^|\/)(moc_|ui_|qrc_)[^/]*$/i;

/**
 * 代码写一种拼法、自然语言写另一种拼法的词对。与 graph 包的 `ABBREVIATION_PAIRS`
 * 同一张表（core 不依赖 graph，各留一份）。
 */
const SPARSE_ABBREVIATION_PAIRS: Array<[string, string]> = [
    ['config', 'configuration'], ['cfg', 'configuration'], ['init', 'initialize'],
    ['init', 'initialization'], ['impl', 'implementation'], ['msg', 'message'],
    ['mgr', 'manager'], ['ctx', 'context'], ['db', 'database'],
    ['auth', 'authentication'], ['err', 'error'], ['req', 'request'],
    ['res', 'response'], ['resp', 'response'], ['buf', 'buffer'],
    ['addr', 'address'], ['dir', 'directory'], ['num', 'number'],
    ['len', 'length'], ['util', 'utility'], ['exec', 'execute'],
    ['calc', 'calculate'], ['sync', 'synchronize'], ['async', 'asynchronous'],
    ['temp', 'temporary'], ['spec', 'specification'], ['proc', 'process'],
    ['stats', 'statistics'], ['env', 'environment'], ['repo', 'repository'],
];

const SPARSE_ABBREVIATION_MAP: Map<string, string[]> = (() => {
    const m = new Map<string, string[]>();
    const add = (from: string, to: string) => {
        const list = m.get(from);
        if (list) list.push(to); else m.set(from, [to]);
    };
    for (const [short, long] of SPARSE_ABBREVIATION_PAIRS) { add(short, long); add(long, short); }
    return m;
})();

const SPARSE_QUERY_STOP_WORDS = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'and', 'or', 'not',
    'of', 'in', 'on', 'at', 'to', 'for', 'from', 'by', 'with', 'as', 'that', 'this',
    'these', 'those', 'it', 'its', 'how', 'what', 'where', 'when', 'which', 'who',
    'why', 'does', 'do', 'did', 'can', 'could', 'should', 'would', 'will', 'there',
    'here', 'we', 'i', 'you', 'they',
]);

const MAX_SPARSE_EXTRA_TOKENS = 16;

/**
 * 给 BM25 稀疏臂补上「代码里那个拼法」的 token。dense 臂用原查询，不受影响。
 *
 * Milvus 的 BM25 用 standard tokenizer，按词边界切分后**不再拆驼峰** —— `LogConfig`
 * 在索引里就是一个 token `logconfig`。于是查询 "log configuration structure" 的
 * sparse 侧一个词都对不上：`log` 命中一堆、`configuration` 与 `logconfig` 毫无关系。
 * 实测这正是 PhiLog 上 `LogConfig` 在 vector 模式漏掉的根因（`both`/`graph` 能给出，
 * 因为图侧的 FTS 建索引时就把标识符按驼峰切开了）。
 *
 * 这里做两件事：把缩写按 `SPARSE_ABBREVIATION_PAIRS` 归一，再把相邻词双向拼接
 * （`log`+`config` → `logconfig`/`configlog`，覆盖 "configuration for logging" 这种词序）。
 * 纯追加：BM25 对文档中不存在的查询词贡献 0 分，命中不了的扩展 token 不会扣原词的分，
 * 而拼出来的标识符 IDF 极高，一旦命中就是强信号。
 */
export function expandSparseQuery(query: string): string {
    const words = (query.match(/[A-Za-z][A-Za-z0-9]*/g) || [])
        .map(w => w.toLowerCase())
        .filter(w => w.length > 1 && !SPARSE_QUERY_STOP_WORDS.has(w));
    if (words.length === 0) return query;

    const variants = words.map(w => {
        const alt = SPARSE_ABBREVIATION_MAP.get(w);
        return alt ? [w, ...alt] : [w];
    });

    const extra = new Set<string>();
    for (const vs of variants) for (const v of vs.slice(1)) extra.add(v);
    for (let i = 0; i + 1 < variants.length; i++) {
        for (const a of variants[i]) {
            for (const b of variants[i + 1]) {
                if (a === b) continue;
                extra.add(a + b);
                extra.add(b + a);
            }
        }
    }
    for (const w of words) extra.delete(w);
    if (extra.size === 0) return query;
    return `${query} ${[...extra].slice(0, MAX_SPARSE_EXTRA_TOKENS).join(' ')}`;
}

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

    // 测试工具的自动生成套件。图索引器早就在 ignore 列表里挡掉它们，向量侧却没有 ——
    // ap-client-api 1360 个文件里 881 个是 parasoft C++test 生成的 TestSuite_*.cpp，
    // 等于 65% 的 embedding 预算和 Milvus 存储花在没人会去搜的桩代码上，还要在
    // 检索结果里占槽位。只挡"工具产物"这种无歧义的目录，`generated/` 这类可能装着
    // 开发者真会去搜的 protobuf/接口代码的目录仍然入索引，只在排序时降权。
    'parasoft/**',
    '**/autogenerated/**',
    '**/auto_generated/**',

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

/**
 * 单次查询的排序覆盖项。
 *
 * 之前 MCP 是写 `process.env.SEARCH_DOC_PENALTY = '0'` 再靠 core 在末尾 delete 掉 ——
 * 进程级全局态被用来传单次调用的参数：并发的两次 search 会互相污染（A 的 docs:true
 * 让 B 也不降权），任一路径提前 return/抛错就把覆盖永久留在进程里，
 * 且它同时压掉了用户在 .env 里配的真实值。改成显式入参。
 */
export interface SearchRankingOptions {
    /** 文档降权系数；0 = 不降权（search 的 docs:true）。省略则用 SEARCH_DOC_PENALTY。 */
    docPenalty?: number;
    /** 测试降权系数；0 = 不降权（search 的 tests:true）。省略则用 SEARCH_TEST_PENALTY。 */
    testPenalty?: number;
    /**
     * vendored/第三方子树的目录段（如 `third_party`、`spdlog`）。命中的结果按
     * `vendorPenalty` 降权。空/省略 = 不降权 —— 调用方负责探测（见 graph 包的
     * `detectVendorSegments`），core 不去碰文件系统。
     */
    vendorSegments?: string[];
    /** vendored 降权系数；0 = 不降权（search 的 vendor:true）。省略则用 SEARCH_VENDOR_PENALTY。 */
    vendorPenalty?: number;
}

export interface ContextConfig {
    embedding?: Embedding;
    vectorDatabase?: VectorDatabase;
    codeSplitter?: Splitter;
    supportedExtensions?: string[];
    ignorePatterns?: string[];
    customExtensions?: string[]; // New: custom extensions from MCP
    customIgnorePatterns?: string[]; // New: custom ignore patterns from MCP
    collectionNameOverride?: string; // Optional: custom collection name suffix
    /**
     * 只读模式：拒绝一切向量写入（建/删 collection、insert/delete、索引编排）。
     *
     * 本地 MCP 必须开着它 —— 向量索引由云端 git-index-service 统一写入，本地只做只读
     * 检索。不开的话这条架构约束就只靠"没人调用写方法"维持：写入入口全是 public，
     * getVectorDatabase() 交出的也是可写句柄，一次改动就能往团队共享 Milvus 写脏数据
     * 且无人察觉。云端索引服务不要开（它就是那个写入方）。
     *
     * 也可用环境变量 `VECTOR_READONLY=true` 强制打开（config 显式给值时以 config 为准）。
     */
    readOnly?: boolean;
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
    /** 只读模式（见 ContextConfig.readOnly）。true 时所有写入入口直接抛错。 */
    private readonly readOnly: boolean;

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
        // 只读模式下换成只读视图：写方法在最底层就抛错，getVectorDatabase() 交出去的
        // 句柄也是这一份，所以"本地不写向量"不再依赖调用纪律。
        this.readOnly = config.readOnly ?? this.readBoolEnv('VECTOR_READONLY', false);
        this.vectorDatabase = this.readOnly
            ? readOnlyVectorDatabase(config.vectorDatabase)
            : config.vectorDatabase;
        if (this.readOnly) {
            console.log('[Context] 🔒 只读模式：向量写入已在 core 层封堵（索引由云端 git-index-service 负责）');
        }

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
        // prepareCollection 会建 collection —— 这是写操作。
        this.assertWritable('getPreparedCollection');
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

    /** 只读模式开着吗（见 ContextConfig.readOnly）。 */
    isReadOnly(): boolean {
        return this.readOnly;
    }

    /**
     * 写入入口的统一闸门。只读模式下抛 ReadOnlyVectorDatabaseError。
     *
     * 底层的只读 VectorDatabase 视图已经能拦住写方法，这层是为了**更早、更清楚地**失败：
     * 否则 indexCodebase 会先把整个仓库切片、跑完 embedding（几十秒到几分钟、真花钱），
     * 到最后一步 insert 才抛错。
     */
    private assertWritable(operation: string): void {
        if (this.readOnly) throw new ReadOnlyVectorDatabaseError(operation);
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
     *
     * 缓存 key 必须带上 HEAD：云端索引服务对一个仓库的**所有分支共用一个 checkout
     * 目录**（RepoManager.dirFor 按 repo 而非 branch），并且 indexRepo 对这些分支
     * 复用同一个 Context 串行跑。只按路径缓存的话，第二个分支拿到的是第一个分支的
     * identity —— 保护分支的 chunk 会写进 main 的 collection，自己的 collection 永远
     * 建不出来。HEAD 是文件读，比 spawn 便宜几个数量级，热路径照样不掉速。
     */
    private getRepoIdentityCached(codebasePath: string): string {
        const resolved = path.resolve(codebasePath);
        const key = `${resolved} ${readHeadRef(resolved) ?? ''}`;
        const cached = this.repoIdentityCache.get(key);
        if (cached !== undefined) {
            return cached;
        }
        const identity = getRepoIdentity(resolved);
        if (this.repoIdentityCache.size >= 256) {
            this.repoIdentityCache.clear();
        }
        this.repoIdentityCache.set(key, identity);
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

        // 默认命名规则（<prefix>_<slug>_<hash>）在 utils/collection-name.ts 里，
        // git-index-service 的管理 API 也用同一份 —— 它只有仓库配置、没有 checkout，
        // 却要算出"某仓库某分支 → 哪个 collection"。两处各写一份 md5 迟早会漂，
        // 而症状是"索引明明有、搜出来是空"，极难查。
        return collectionNameForIdentity(identity, isHybrid);
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
        // 只读模式下立刻失败：切片 + embedding 是几十秒到几分钟的真实开销，
        // 不该跑完才在 insert 那一步被拦。
        this.assertWritable('indexCodebase');
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
        this.assertWritable('syncIndexByGit');
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
        // 云端 collection 是团队共享的，本地一次误调就会删掉所有人的索引。
        this.assertWritable('clearIndex');
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
        // Model changed → invalidate cached dimension, embedding-cache instance,
        // AND the query-embedding cache (its keys are bare query strings with no
        // model identity, so stale old-model vectors would otherwise be reused
        // against a collection built in a different embedding space).
        this.knownDimension = null;
        this.embeddingCacheInstance = null;
        this.embeddingCacheKey = null;
        this.queryEmbeddingCache.clear();
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
        this.queryEmbeddingCache.clear();
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
                // ignorePatterns 必须在这条路径上也生效。git ls-files 只帮我们挡掉
                // .gitignore 里的东西，**被 track 的**目录一个不少 —— 而
                // DEFAULT_IGNORE_PATTERNS 要挡的正是这类：parasoft/ 的 C++test
                // 自动生成套件、autogenerated/、vendor 里的 .metadata。原来只有
                // 文件系统遍历那条 fallback 分支过滤，而 git 仓库永远走不到那儿，
                // 于是整个 ignore 列表对全量索引形同虚设：ap-client-api 1341 个文件
                // 里 888 个是这类噪声，65% 的 embedding 预算和 Milvus 存储都花在
                // 没人会去搜的桩代码上。syncIndexByGit 的增量路径一直是过滤的，
                // 两边不一致才让它藏了这么久 —— 增量不会删除本来就不该进来的行。
                if (this.ignorePatternManager.matches(fullPath, codebasePath, ignorePatterns)) {
                    continue;
                }
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
        options?: SearchRankingOptions,
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
        // 向库里多要一些候选：降权/去重/文件多样性都发生在取回之后，只取 topK 等于
        // 让这些后处理"只会删不会补" —— vendored 占 47% 的仓库里，10 条里 5 条被降权
        // 就真的只剩 5 条，而第 11~30 名的自有代码根本没被取回来。
        const fetchK = Math.min(Math.max(topK * 3, topK), 100);
        // 只给 BM25 稀疏臂用的查询文本。dense 臂仍用原查询 —— 拼接出来的标识符对
        // embedding 是噪声，对 BM25 是唯一能对上驼峰 token 的办法。
        const sparseText = isHybrid ? expandSparseQuery(query) : query;
        // Multi-layer hybrid → global RRF.
        if (isHybrid && activeLayers.length > 1 && typeof this.vectorDatabase.sparseSearch === 'function') {
            const layerObjs = activeLayers.map(l => ({
                identity: l.collectionName,
                collectionName: l.collectionName,
                mask: l.mask || [],
            }));
            const fused = await this.globalHybridFusion(layerObjs, queryEmbedding.vector, sparseText, fetchK, filterExpr, threshold);
            // 这条分支以前直接 return，把降权/截断/近重复去重/文件多样性全跳过了 ——
            // 同一个 query 走单层和走多层会得到语义不同的结果集（docs:true 在多层下静默失效）。
            // 云端目前每个 repo:branch 一个 collection，所以这里实际只有单层，但那不是
            // 让两条路径行为分叉的理由。
            const post = this.postRankResults(fused, threshold, topK, options);
            console.log(`[Context] ✅ Dev-aware RRF → ${post.length} results`);
            return post;
        }

        // Per-layer search + mask.
        const perLayer = await Promise.all(
            activeLayers.map(layer => {
                const layerFilter = this.combineFilters(filterExpr, this.buildMaskFilter(layer.mask || []));
                return this.searchLayer(
                    layer.collectionName, queryEmbedding.vector, sparseText, fetchK, threshold, layerFilter, isHybrid,
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
        const finalResults = this.postRankResults(deduped, threshold, topK, options);
        console.log(`[Context] ✅ Dev-aware search: ${all.length} raw → ${finalResults.length} results`);
        return finalResults;
    }

    /**
     * 排序后处理：降权 → 截断 → 近重复去重 → 文件多样性。
     * 单层和多层 RRF 两条检索路径共用，保证同一个 query 不因层数不同而语义不同。
     */
    private postRankResults(
        ranked: SemanticSearchResult[],
        threshold: number,
        topK: number,
        options?: SearchRankingOptions,
    ): SemanticSearchResult[] {
        // 截断在降权**之前**：截断问的是"这条够不够相关"，降权问的是"同样相关时我更想先看哪条"。
        // 反过来就把降权变成了删除 —— vendorPenalty 默认 0.35 低于 SEARCH_THRESHOLD 的
        // 0.4 相对线，任何 vendored 命中乘完系数必然掉到线下，于是 PhiLog 这种答案本来
        // 就在 spdlog 里的仓库，vector 模式直接一条不返回。
        const relevant = this.applyScoreCutoff(ranked, threshold);
        // 文档降权：自然语言查询时 .md/.rst 等文档散文与查询语义更接近，
        // 容易把真正的代码实现压出 topK（实测 requests-flow top5 全是 docs）。
        const codeWeighted = this.penalizeDocResults(relevant, options?.docPenalty);
        // 测试文件降权：测试代码与"X 怎么用/X 怎么实现"的查询语义也接近，
        // 会挤占生产实现的位置（实测 requests-flow top2 是 tests/test_adapters.py）。
        const prodWeighted = this.penalizeTestResults(codeWeighted, options?.testPenalty);
        // vendored 第三方代码降权：上游库的命名比业务代码更规整，命中自然语言查询的
        // 概率反而更高（PhiLog 47% 的文件是拷进来的 spdlog，问自己项目的刷盘策略
        // 返回的全是 spdlog 的 flush_on）。
        const ownWeighted = this.penalizeVendorResults(prodWeighted, options?.vendorSegments, options?.vendorPenalty);
        const contentDeduped = this.dedupNearDuplicateContent(ownWeighted);
        return this.applyFileDiversity(contentDeduped, topK);
    }

    /**
     * Down-rank test/spec files so production implementations outrank test doubles.
     * Tests mirror the API under test and embed near "how do I use X" queries,
     * but the production implementation is almost always the intended answer.
     * Controlled by SEARCH_TEST_PENALTY (0 disables; default 0.55 = tests keep ~half score),
     * 单次查询可通过 override 覆盖（search 工具的 tests:true）。
     */
    private penalizeTestResults(results: SemanticSearchResult[], override?: number): SemanticSearchResult[] {
        const penalty = override ?? parseFloat(envManager.get('SEARCH_TEST_PENALTY') ?? '0.55');
        if (penalty <= 0 || penalty >= 1) return results;
        const isTest = (r: SemanticSearchResult): boolean => {
            const fp = r.relativePath || '';
            const base = fp.slice(fp.lastIndexOf('/') + 1);
            // test directories: tests/, test/, testing/, __tests__/, spec/, testdata/
            if (/(^|\/)(tests?|testing|__tests__|spec|specs|testdata|test_fixtures|fixtures)(\/|$)/i.test(fp)) return true;
            // test file names: test_*, *_test.*, *_spec.*, *.test.*, *.spec.*, conftest.*
            if (/^(test_|conftest)/i.test(base)) return true;
            if (/(_test|_spec|\.test|\.spec)\.[^.]+$/i.test(base)) return true;
            // Java/TS style: FooTest.java, FooTests.java, FooSpec.ts
            if (/(Test|Tests|Spec|TestCase)\.[^.]+$/.test(base)) return true;
            return false;
        };
        const weighted = results.map(r =>
            isTest(r) ? { ...r, score: r.score * penalty } : r,
        );
        weighted.sort((a, b) => b.score - a.score);
        return weighted;
    }

    /**
     * Down-rank prose/documentation files so natural-language queries surface
     * code over docs. Docs often embed nearer to an NL query than the code that
     * actually implements it, crowding the implementation out of topK.
     * Controlled by SEARCH_DOC_PENALTY (0 disables; default 0.5 = docs keep half score),
     * 单次查询可通过 override 覆盖（search 工具的 docs:true）。
     */
    private penalizeDocResults(results: SemanticSearchResult[], override?: number): SemanticSearchResult[] {
        const penalty = override ?? parseFloat(envManager.get('SEARCH_DOC_PENALTY') ?? '0.5');
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

    /**
     * Down-rank code that belongs to a vendored third-party subtree.
     *
     * `segments` 是目录段名（`third_party`、`node_modules`，以及探测出来的库名如
     * `spdlog`），由调用方给出 —— core 不读文件系统。系数走 SEARCH_VENDOR_PENALTY
     * （默认 0.35，比 test/doc 更狠：别人的库比自己的测试更不可能是答案），
     * 单次查询可用 override 关掉（search 的 vendor:true）。
     */
    private penalizeVendorResults(
        results: SemanticSearchResult[],
        segments?: string[],
        override?: number,
    ): SemanticSearchResult[] {
        const penalty = override ?? parseFloat(envManager.get('SEARCH_VENDOR_PENALTY') ?? '0.35');
        if (penalty <= 0 || penalty >= 1) return results;
        const cleaned = [...new Set((segments || []).map(s => s.trim()).filter(Boolean))];
        if (cleaned.length === 0) return results;
        const alt = cleaned.map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
        const re = new RegExp(`(^|/)(${alt})(/|$)`, 'i');
        const weighted = results.map(r =>
            (re.test(r.relativePath || '') || GENERATED_FILE_RE.test(r.relativePath || ''))
                ? { ...r, score: r.score * penalty } : r,
        );
        weighted.sort((a, b) => b.score - a.score);
        return weighted;
    }
}
