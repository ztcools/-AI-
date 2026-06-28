#!/usr/bin/env node

// CRITICAL: Redirect console outputs to stderr IMMEDIATELY to avoid interfering with MCP JSON protocol
// Only MCP protocol messages should go to stdout
const originalConsoleLog = console.log;
const originalConsoleWarn = console.warn;

console.log = (...args: any[]) => {
    process.stderr.write('[LOG] ' + args.join(' ') + '\n');
};

console.warn = (...args: any[]) => {
    process.stderr.write('[WARN] ' + args.join(' ') + '\n');
};

// console.error already goes to stderr by default

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    ListToolsRequestSchema,
    CallToolRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import { Context } from "@zilliz/claude-context-core";
import { MilvusVectorDatabase } from "@zilliz/claude-context-core";

// Import our modular components
import { createMcpConfig, logConfigurationSummary, showHelpMessage, ContextMcpConfig } from "./config.js";
import { createEmbeddingInstance, logEmbeddingProviderInfo } from "./embedding.js";
import { SnapshotManager } from "./snapshot.js";
import { SyncManager } from "./sync.js";
import { ToolHandlers } from "./handlers.js";
import { GraphToolHandlers } from "./graph-handlers.js";

class ContextMcpServer {
    private server: Server;
    private context: Context;
    private snapshotManager: SnapshotManager;
    private syncManager: SyncManager;
    private toolHandlers: ToolHandlers;
    private graphToolHandlers: GraphToolHandlers;

    constructor(config: ContextMcpConfig) {
        // Initialize MCP server
        this.server = new Server(
            {
                name: config.name,
                version: config.version
            },
            {
                capabilities: {
                    tools: {}
                }
            }
        );

        // Initialize embedding provider
        console.log(`[EMBEDDING] Initializing embedding provider: ${config.embeddingProvider}`);
        console.log(`[EMBEDDING] Using model: ${config.embeddingModel}`);

        const embedding = createEmbeddingInstance(config);
        logEmbeddingProviderInfo(config, embedding);

        // Initialize vector database
        const vectorDatabase = new MilvusVectorDatabase({
            address: config.milvusAddress,
            ...(config.milvusToken && { token: config.milvusToken })
        });

        // Initialize Claude Context
        this.context = new Context({
            embedding,
            vectorDatabase,
            collectionNameOverride: config.collectionNameOverride
        });

        // Initialize managers
        this.snapshotManager = new SnapshotManager();
        this.syncManager = new SyncManager(this.context, this.snapshotManager);
        this.toolHandlers = new ToolHandlers(this.context, this.snapshotManager);
        this.graphToolHandlers = new GraphToolHandlers();

        // Load existing codebase snapshot on startup
        this.snapshotManager.loadCodebaseSnapshot();

        this.setupTools();
    }

    private setupTools() {
        const index_description = `
Index a codebase directory to enable semantic search. The codebase is identified by its git remote URL + branch name (not by filesystem path), so the same repository cloned to different locations shares a single index.

⚠️ **IMPORTANT**:
- The 'path' parameter accepts paths, relative paths (resolved against the current working directory), or "." to auto-detect the IDE workspace root.
- Before indexing, the system checks if the repository (identified by git URL + branch) is already indexed in the vector database. If already indexed, indexing is skipped unless force=true.

✨ **Usage Guidance**:
- Use this tool when the user wants to index a project for semantic search.
- If the user does not specify a path, default to "." (current workspace).
- If the user says "index this project", "index the current workspace", or "index /path/to/project", call this tool.
- The system isolates indexes by git URL + branch, so team members sharing the same repo+branch can reuse each other's indexes.
`;


        const search_description = `
Search the indexed codebase using natural language queries. The codebase is identified by its git remote URL + branch, so searches work across different local checkouts of the same repository.

⚠️ **IMPORTANT**:
- The 'path' parameter accepts paths, relative paths, or "." for the IDE workspace. Defaults to the current workspace if not provided.
- If the codebase is not yet indexed, the tool returns an error - use index_codebase first.

🎯 **When to Use**:
This tool is versatile and can be used before completing various tasks to retrieve relevant context:
- **Code search**: Find specific functions, classes, or implementations
- **Context-aware assistance**: Gather relevant code context before making changes
- **Issue identification**: Locate problematic code sections or bugs
- **Code review**: Understand existing implementations and patterns
- **Refactoring**: Find all related code pieces that need to be updated
- **Feature development**: Understand existing architecture and similar implementations
- **Duplicate detection**: Identify redundant or duplicated code patterns across the codebase

✨ **Usage Guidance**:
- If the codebase is not indexed, this tool will return a clear error message indicating that indexing is required first.
- You can then use the index_codebase tool to index the codebase before searching again.
`;

        // Define available tools
        this.server.setRequestHandler(ListToolsRequestSchema, async () => {
            return {
                tools: [
                    {
                        name: "index_codebase",
                        description: index_description,
                        inputSchema: {
                            type: "object",
                            properties: {
                                path: {
                                    type: "string",
                                    description: `Path to the codebase directory to index. Accepts paths, relative paths, or "." for the IDE workspace. Defaults to the current workspace if not provided. The path is only used to locate the project on disk; the index is identified by git URL + branch.`
                                },
                                force: {
                                    type: "boolean",
                                    description: "Force re-indexing even if already indexed",
                                    default: false
                                },
                                splitter: {
                                    type: "string",
                                    description: "Code splitter to use: 'ast' for syntax-aware splitting with automatic fallback, 'langchain' for character-based splitting",
                                    enum: ["ast", "langchain"],
                                    default: "ast"
                                },
                                customExtensions: {
                                    type: "array",
                                    items: {
                                        type: "string"
                                    },
                                    description: "Optional: Additional file extensions to include beyond defaults (e.g., ['.vue', '.svelte', '.astro']). Extensions should include the dot prefix or will be automatically added",
                                    default: []
                                },
                                ignorePatterns: {
                                    type: "array",
                                    items: {
                                        type: "string"
                                    },
                                    description: "Optional: Additional ignore patterns to exclude specific files/directories beyond defaults. Only include this parameter if the user explicitly requests custom ignore patterns (e.g., ['static/**', '*.tmp', 'private/**'])",
                                    default: []
                                }
                            }
                        }
                    },
                    {
                        name: "search_code",
                        description: search_description,
                        inputSchema: {
                            type: "object",
                            properties: {
                                path: {
                                    type: "string",
                                    description: `Path to the codebase directory to search in. Accepts paths, relative paths, or "." for the IDE workspace. Defaults to the current workspace if not provided.`,
                                },
                                query: {
                                    type: "string",
                                    description: "Natural language query to search for in the codebase"
                                },
                                limit: {
                                    type: "number",
                                    description: "Maximum number of results to return",
                                    default: 10,
                                    maximum: 50
                                },
                                extensionFilter: {
                                    type: "array",
                                    items: {
                                        type: "string"
                                    },
                                    description: "Optional: List of file extensions to filter results. (e.g., ['.ts','.py']).",
                                    default: []
                                }
                            },
                            required: ["query"]
                        }
                    },
                    {
                        name: "clear_index",
                        description: `Clear the search index. The 'path' parameter accepts paths, relative paths, or "." for the IDE workspace. Defaults to the current workspace if not provided.`,
                        inputSchema: {
                            type: "object",
                            properties: {
                                path: {
                                    type: "string",
                                    description: `Path to the codebase directory to clear. Accepts paths, relative paths, or "." for the IDE workspace. Defaults to the current workspace if not provided.`
                                }
                            }
                        }
                    },
                    {
                        name: "get_indexing_status",
                        description: `Get the current indexing status of a codebase. Shows progress percentage for actively indexing codebases and completion status for indexed codebases. The codebase is identified by its git remote URL + branch, so status works across different local checkouts of the same repository.

⚠️ **IMPORTANT**:
- The 'path' parameter accepts paths, relative paths, or "." for the IDE workspace. Defaults to the current workspace if not provided.`,
                        inputSchema: {
                            type: "object",
                            properties: {
                                path: {
                                    type: "string",
                                    description: `Path to the codebase directory to check status for. Accepts paths, relative paths, or "." for the IDE workspace. Defaults to the current workspace if not provided.`
                                }
                            }
                        }
                    },
                    // ── Graph Knowledge Tools ───────────────────────────
                    {
                        name: "index_repository",
                        description: `Index a repository into the knowledge graph for structured code analysis. This is complementary to index_codebase (vector index) — it builds a graph of functions, classes, methods, imports, and calls. Use this to enable structured queries like call tracing, architecture analysis, and graph search.`,
                        inputSchema: {
                            type: "object",
                            properties: {
                                repo_path: {
                                    type: "string",
                                    description: "Path to the repository to index"
                                },
                                mode: {
                                    type: "string",
                                    enum: ["full", "incremental"],
                                    default: "full",
                                    description: "Indexing mode: full (all files), incremental (git diff changed files only)"
                                },
                                files: {
                                    type: "array",
                                    items: { type: "string" },
                                    description: "Specific files to re-index (relative paths). Overrides mode."
                                }
                            },
                            required: ["repo_path"]
                        }
                    },
                    {
                        name: "search_graph",
                        description: `Search the code knowledge graph for functions, classes, methods, and variables. Use INSTEAD of grep/glob when finding code definitions, implementations, or relationships. Supports BM25 full-text search, regex patterns, and degree filtering.`,
                        inputSchema: {
                            type: "object",
                            properties: {
                                project: { type: "string", description: "Project identifier (git URL + branch)" },
                                query: { type: "string", description: "Natural-language or keyword full-text search" },
                                label: { type: "string", description: "Filter by node label (Function, Class, Method, etc.)" },
                                name_pattern: { type: "string", description: "Regex pattern on node name" },
                                qn_pattern: { type: "string", description: "Regex pattern on qualified name" },
                                file_pattern: { type: "string", description: "Regex pattern on file path" },
                                min_degree: { type: "integer", description: "Minimum degree (in+out edges)" },
                                max_degree: { type: "integer", description: "Maximum degree (in+out edges)" },
                                limit: { type: "integer", default: 200, description: "Max results per call" },
                                offset: { type: "integer", default: 0, description: "Pagination offset" }
                            },
                            required: ["project"]
                        }
                    },
                    {
                        name: "trace_path",
                        description: `Trace call paths through the code graph. Modes: calls (callers/callees), data_flow (value propagation), cross_service (HTTP/async). Use INSTEAD OF grep for callers, dependencies, impact analysis.`,
                        inputSchema: {
                            type: "object",
                            properties: {
                                project: { type: "string", description: "Project identifier" },
                                function_name: { type: "string", description: "Function name to trace from" },
                                direction: { type: "string", enum: ["inbound", "outbound", "both"], default: "both" },
                                depth: { type: "integer", default: 3, description: "Max traversal depth" },
                                mode: { type: "string", enum: ["calls", "data_flow", "cross_service"], default: "calls" },
                                include_tests: { type: "boolean", default: false }
                            },
                            required: ["project", "function_name"]
                        }
                    },
                    {
                        name: "get_code_snippet",
                        description: `Read source code for a function/class/symbol by qualified name. First call search_graph to find the exact qualified_name, then pass it here.`,
                        inputSchema: {
                            type: "object",
                            properties: {
                                project: { type: "string", description: "Project identifier" },
                                qualified_name: { type: "string", description: "Full qualified_name from search_graph" },
                                include_neighbors: { type: "boolean", default: false, description: "Include caller/callee names" }
                            },
                            required: ["project", "qualified_name"]
                        }
                    },
                    {
                        name: "get_graph_schema",
                        description: `Get the schema of the knowledge graph (node labels, edge types).`,
                        inputSchema: {
                            type: "object",
                            properties: {
                                project: { type: "string", description: "Project identifier" }
                            },
                            required: ["project"]
                        }
                    },
                    {
                        name: "get_architecture",
                        description: `Get high-level architecture overview — packages, services, dependencies, entry points, and directory clusters.`,
                        inputSchema: {
                            type: "object",
                            properties: {
                                project: { type: "string", description: "Project identifier" },
                                path: { type: "string", description: "Optional directory prefix to scope analysis" }
                            },
                            required: ["project"]
                        }
                    },
                    {
                        name: "search_code_graph",
                        description: `Graph-augmented code search. Finds text patterns via grep, then enriches results with the knowledge graph — deduplicates matches into containing functions. Modes: compact (default), full, files.`,
                        inputSchema: {
                            type: "object",
                            properties: {
                                project: { type: "string", description: "Project identifier" },
                                pattern: { type: "string", description: "Text pattern to search for" },
                                file_pattern: { type: "string", description: "Glob for file filtering (e.g. *.go)" },
                                path_filter: { type: "string", description: "Regex filter on result file paths" },
                                mode: { type: "string", enum: ["compact", "full", "files"], default: "compact" },
                                regex: { type: "boolean", default: false },
                                limit: { type: "integer", default: 10, description: "Max enriched results" }
                            },
                            required: ["project", "pattern"]
                        }
                    },
                    {
                        name: "list_projects",
                        description: `List all graph-indexed projects.`,
                        inputSchema: { type: "object", properties: {} }
                    },
                    {
                        name: "delete_project",
                        description: `Delete a project from the graph index.`,
                        inputSchema: {
                            type: "object",
                            properties: {
                                project: { type: "string", description: "Project identifier to delete" }
                            },
                            required: ["project"]
                        }
                    },
                    {
                        name: "index_status",
                        description: `Get the graph indexing status of a project.`,
                        inputSchema: {
                            type: "object",
                            properties: {
                                project: { type: "string", description: "Project identifier" }
                            },
                            required: ["project"]
                        }
                    },
                    {
                        name: "detect_changes",
                        description: `Detect code changes and their potential impact on the graph.`,
                        inputSchema: {
                            type: "object",
                            properties: {
                                project: { type: "string", description: "Project identifier" },
                                base_branch: { type: "string", default: "main" }
                            },
                            required: ["project"]
                        }
                    },
                    {
                        name: "query_graph",
                        description: `Execute a Cypher-like query on the knowledge graph. Supports: MATCH (n) WHERE n.name = 'X' RETURN n`,
                        inputSchema: {
                            type: "object",
                            properties: {
                                project: { type: "string", description: "Project identifier" },
                                query: { type: "string", description: "Cypher-like query: MATCH (n) WHERE n.name = 'X' RETURN n" }
                            },
                            required: ["project", "query"]
                        }
                    },
                    {
                        name: "manage_adr",
                        description: `Manage Architecture Decision Records (ADRs). Actions: list, create, update.`,
                        inputSchema: {
                            type: "object",
                            properties: {
                                action: { type: "string", enum: ["list", "create", "update"], default: "list" },
                                project: { type: "string", description: "Project identifier" },
                                title: { type: "string", description: "ADR title (for create)" },
                                content: { type: "string", description: "ADR content (for create/update)" },
                                id: { type: "integer", description: "ADR id (for update)" },
                                status: { type: "string", enum: ["proposed", "accepted", "deprecated", "superseded"], description: "ADR status" }
                            },
                            required: ["action"]
                        }
                    },
                    {
                        name: "ingest_traces",
                        description: `Ingest HTTP/async trace data for cross-service call analysis. Accepts trace records with source service, target service, HTTP method, path, and status code.`,
                        inputSchema: {
                            type: "object",
                            properties: {
                                project: { type: "string", description: "Project identifier" },
                                traces: {
                                    type: "array",
                                    description: "Array of trace records",
                                    items: {
                                        type: "object",
                                        properties: {
                                            source_service: { type: "string", description: "Source service name" },
                                            target_service: { type: "string", description: "Target service name" },
                                            method: { type: "string", enum: ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS", "GRPC", "MESSAGE", "EVENT"] },
                                            path: { type: "string", description: "HTTP path or RPC method" },
                                            status_code: { type: "integer", description: "HTTP status code" },
                                            duration_ms: { type: "number", description: "Request duration in milliseconds" },
                                            timestamp: { type: "string", description: "ISO timestamp" }
                                        },
                                        required: ["source_service", "target_service", "method", "path"]
                                    }
                                }
                            },
                            required: ["project", "traces"]
                        }
                    },
                ]
            };
        });

        // Handle tool execution
        this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
            const { name, arguments: args } = request.params;
            const safeArgs = args || {};

            switch (name) {
                case "index_codebase":
                    return await this.toolHandlers.handleIndexCodebase(args);
                case "search_code":
                    return await this.toolHandlers.handleSearchCode(args);
                case "clear_index":
                    return await this.toolHandlers.handleClearIndex(args);
                case "get_indexing_status":
                    return await this.toolHandlers.handleGetIndexingStatus(args);

                // ── Graph Knowledge Tools ───────────────────────────
                case "index_repository":
                    return await this.graphToolHandlers.handleIndexRepository(safeArgs);
                case "search_graph":
                    return this.graphToolHandlers.handleSearchGraph(safeArgs);
                case "trace_path":
                    return this.graphToolHandlers.handleTracePath(safeArgs);
                case "get_code_snippet":
                    return this.graphToolHandlers.handleGetCodeSnippet(safeArgs);
                case "get_graph_schema":
                    return this.graphToolHandlers.handleGetGraphSchema(safeArgs);
                case "get_architecture":
                    return this.graphToolHandlers.handleGetArchitecture(safeArgs);
                case "search_code_graph":
                    return this.graphToolHandlers.handleSearchCode(safeArgs);
                case "list_projects":
                    return this.graphToolHandlers.handleListProjects();
                case "delete_project":
                    return this.graphToolHandlers.handleDeleteProject(safeArgs);
                case "index_status":
                    return this.graphToolHandlers.handleIndexStatus(safeArgs);
                case "detect_changes":
                    return this.graphToolHandlers.handleDetectChanges(safeArgs);
                case "query_graph":
                    return this.graphToolHandlers.handleQueryGraph(safeArgs);
                case "manage_adr":
                    return this.graphToolHandlers.handleManageAdr(safeArgs);
                case "ingest_traces":
                    return this.graphToolHandlers.handleIngestTraces(safeArgs);

                default:
                    throw new Error(`Unknown tool: ${name}`);
            }
        });
    }

    async start() {
        console.log('[SYNC-DEBUG] MCP server start() method called');
        console.log('Starting Context MCP server...');

        // One-shot startup healing for legacy 0/0+completed snapshot entries
        // left over from pre-fix MCP versions. Runs before the transport accepts
        // requests so clients never observe the poisoning state. See Issue #295.
        await this.toolHandlers.validateLegacyZeroEntries();

        const transport = new StdioServerTransport();
        console.log('[SYNC-DEBUG] StdioServerTransport created, attempting server connection...');

        await this.server.connect(transport);
        console.log("MCP server started and listening on stdio.");
        console.log('[SYNC-DEBUG] Server connection established successfully');

        // Start background sync after server is connected
        console.log('[SYNC-DEBUG] Initializing background sync...');
        this.syncManager.startBackgroundSync();
        console.log('[SYNC-DEBUG] MCP server initialization complete');
    }
}

// Main execution
async function main() {
    // Parse command line arguments
    const args = process.argv.slice(2);

    // Show help if requested
    if (args.includes('--help') || args.includes('-h')) {
        showHelpMessage();
        process.exit(0);
    }

    // Create configuration
    const config = createMcpConfig();
    logConfigurationSummary(config);

    const server = new ContextMcpServer(config);
    await server.start();
}

// Handle graceful shutdown
process.on('SIGINT', () => {
    console.error("Received SIGINT, shutting down gracefully...");
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.error("Received SIGTERM, shutting down gracefully...");
    process.exit(0);
});

// Always start the server - this is designed to be the main entry point
main().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
});
