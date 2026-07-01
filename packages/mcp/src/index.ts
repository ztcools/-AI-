#!/usr/bin/env node

// CRITICAL: Redirect console outputs to stderr IMMEDIATELY to avoid interfering with MCP JSON protocol
// Only MCP protocol messages should go to stdout
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
        this.graphToolHandlers = new GraphToolHandlers();
        this.toolHandlers = new ToolHandlers(this.context, this.snapshotManager, this.graphToolHandlers);

        // Load existing codebase snapshot on startup (fire-and-forget in constructor,
        // will be fully loaded before server starts handling requests)
        void this.snapshotManager.loadCodebaseSnapshot();

        this.setupTools();
    }

    private setupTools() {
        const index_description = `
Index a codebase for intelligent code search. One call builds both the vector index (Milvus, shared with your team via git remote URL + branch) and the local knowledge graph (SQLite). Team members on the same repo+branch reuse each other's vector index.

⚠️ **First-time setup**: call this once per project. Afterwards, incremental updates happen automatically, and the local graph auto-builds on your first \`search\` if a teammate already indexed the repo.
`;

        // NOTE: this description is the primary lever for how often the model
        // reaches for search instead of falling back to manual file reads. It is
        // deliberately directive. Keep the guidance honest — every claim here is
        // backed by the handler (hybrid vector+BM25 ranking, graph enrichment).
        const search_description = `
Semantic + knowledge-graph search over the indexed codebase. This is the FASTEST and most reliable way to understand THIS project — prefer it over reading files, grepping, or guessing. A single call returns the most relevant code snippets ranked across the whole repo, each enriched with graph context: callers, callees, call chains, architectural role, and dead-code flags.

🎯 **Call this FIRST — before reading files — whenever you need to:**
- Locate where something is implemented, or how a feature/flow works
- Understand code BEFORE editing it (find existing patterns, conventions, related logic to stay consistent)
- Trace a bug to its root cause (you get the full call chain, not a single file)
- Judge blast radius before refactoring (who calls this? what does it call?)
- Answer any "where / how / why" question about the codebase

💡 **Why prefer it:** one search replaces many file reads. It ranks by *meaning* across the entire repository (not just filename or exact-token matches) and attaches the call graph, so you get the code AND how it connects — context that would otherwise take many tool calls to reconstruct. Reach for it liberally; a quick search at the start of a task keeps your edits grounded in how the project actually works.

Use natural-language queries describing intent (e.g. "how are auth tokens refreshed", "where is the vector DB connection configured"), not bare keywords. Run several focused searches for a multi-part task.
`;

        this.server.setRequestHandler(ListToolsRequestSchema, async () => {
            return {
                tools: [
                    {
                        name: "index",
                        description: index_description,
                        inputSchema: {
                            type: "object",
                            properties: {
                                path: {
                                    type: "string",
                                    description: "Path to the codebase directory to index. Defaults to current workspace.",
                                },
                                force: {
                                    type: "boolean",
                                    description: "Force re-indexing even if already indexed",
                                    default: false,
                                },
                                splitter: {
                                    type: "string",
                                    description: "Code splitter: 'ast' (syntax-aware) or 'langchain' (character-based)",
                                    enum: ["ast", "langchain"],
                                    default: "ast",
                                },
                                customExtensions: {
                                    type: "array",
                                    items: { type: "string" },
                                    description: "Additional file extensions beyond defaults",
                                    default: [],
                                },
                                ignorePatterns: {
                                    type: "array",
                                    items: { type: "string" },
                                    description: "Additional ignore patterns beyond defaults",
                                    default: [],
                                },
                            },
                        },
                    },
                    {
                        name: "search",
                        description: search_description,
                        inputSchema: {
                            type: "object",
                            properties: {
                                path: {
                                    type: "string",
                                    description: "Codebase path to search in. Defaults to current workspace.",
                                },
                                query: {
                                    type: "string",
                                    description: "Natural language query",
                                },
                                limit: {
                                    type: "number",
                                    description: "Max results (default 10, max 50)",
                                    default: 10,
                                    maximum: 50,
                                },
                                extensionFilter: {
                                    type: "array",
                                    items: { type: "string" },
                                    description: "Filter by file extensions (e.g. ['.ts', '.py'])",
                                    default: [],
                                },
                            },
                            required: ["query"],
                        },
                    },
                    {
                        name: "clear",
                        description: "Clear all indexes (vector + graph) for a codebase.",
                        inputSchema: {
                            type: "object",
                            properties: {
                                path: {
                                    type: "string",
                                    description: "Codebase path to clear. Defaults to current workspace.",
                                },
                            },
                        },
                    },
                    {
                        name: "status",
                        description: "Get indexing status — vector index (Milvus) and graph index (SQLite) combined.",
                        inputSchema: {
                            type: "object",
                            properties: {
                                path: {
                                    type: "string",
                                    description: "Codebase path to check. Defaults to current workspace.",
                                },
                            },
                        },
                    },
                ],
            };
        });

        this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
            const { name, arguments: args } = request.params;
            const safeArgs = args || {};

            switch (name) {
                case "index":
                case "index_codebase":
                    return await this.toolHandlers.handleIndex(args);
                case "search":
                case "search_code":
                    return await this.toolHandlers.handleSearchCode(args);
                case "clear":
                case "clear_index":
                    return await this.toolHandlers.handleClearIndex(args);
                case "status":
                case "get_indexing_status":
                    return await this.toolHandlers.handleStatus(args);

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
