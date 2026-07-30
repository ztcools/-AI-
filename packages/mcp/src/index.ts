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
import { Context } from "@seeway/claude-context-core";
import { MilvusVectorDatabase } from "@seeway/claude-context-core";

// Import our modular components
import { createMcpConfig, logConfigurationSummary, showHelpMessage, ContextMcpConfig } from "./config.js";
import { createEmbeddingInstance, logEmbeddingProviderInfo } from "./embedding.js";
import { ToolHandlers } from "./handlers.js";
import { GraphToolHandlers } from "./graph-handlers.js";

class ContextMcpServer {
    private server: Server;
    private context: Context;
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

        // Initialize vector database (read-only against cloud Milvus)
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

        // Initialize graph handlers
        this.graphToolHandlers = new GraphToolHandlers();
        this.toolHandlers = new ToolHandlers(this.context, this.graphToolHandlers);

        this.setupTools();
    }

    private setupTools() {
        // NOTE: descriptions are the primary lever for how often the model
        // reaches for each tool. Keep them compact and verifiable.
        const link_description = `
Bind this repo to its cloud vector index (pre-built per protected branch) and build/incrementally update the local knowledge graph. Prerequisite for search to return vector results. Once per session per repo. Omit branch to list cloud candidates.

link also builds the local call-graph index automatically in the background (no separate index step needed — users must NOT run any manual indexing; local vector indexing is disabled by design, only protected branches are indexed on the server daily). The graph then stays fresh automatically as you edit files.
`;

        const unlink_description = `
Unbind this repo from its cloud vector index. Local graph is kept; re-run link to re-bind.
`;

        const search_description = `
Semantic + call-graph search over the linked codebase. Returns file:line + snippet + who-calls-it. It is a first-hop LOCATOR, not a replacement for Read/Grep. The output header shows a repo size tier (small/medium/large) — use it to decide.

DEFAULT = Grep/Read. Reach for search ONLY in these cases:
1. RELATIONSHIP questions grep CANNOT answer — "who calls X", "callers of Y", "impact of changing Z", dead code, entry points → mode "graph" (cheapest, ~200 tok, returns the call chain). Works at ANY repo size. The query MUST name the symbol ("who calls CreateProxy", or just "CreateProxy"): graph mode matches identifiers, so a prose question with no symbol in it ("how is a proxy created") ranks by incidental word overlap and returns unrelated code. Ask that as "both" instead.
2. LARGE/UNFAMILIAR repo (> ~2000 files) AND you don't know where something lives — "how does auth work", "where is request handled" → mode "both". Grep would drown in hits here.
3. You know the CONCEPT but not the exact identifier (semantic recall beats keyword grep) → mode "vector".

Do NOT use it when:
- SMALL repo (< ~300 files): Grep/Read is cheaper AND gives fuller answers. Measured: grep beat search in all 8 scenarios on flask/requests.
- Exact string/symbol/file path already known → Grep/Read directly (instant, zero cost).
- Need a verbatim whole file or config/YAML/markdown → Grep / Read a located line range.

After search locates a spot, Read that exact line range to understand/edit. Phrase the query to match the mode: "vector"/"both" take natural language (intent, no identifier needed); "graph" takes a symbol name. Cost control: mode "graph" (~200 tok) << "vector"/"both"; add style:"compact" for file:line only (~10x fewer tokens), limit:5 to cap snippets, enrich:false to skip the call-graph. Needs link for vector; without link returns graph-only.
`;

        const clear_description = `
Clear the local graph index for a codebase. Cloud vector index is not affected. Re-run link to rebuild.
`;

        const status_description = `
Show link state (cloud repo@branch + connectivity) and local graph index stats (nodes/edges/types/routes).
`;

        this.server.setRequestHandler(ListToolsRequestSchema, async () => {
            return {
                tools: [
                    {
                        name: "link",
                        description: link_description,
                        inputSchema: {
                            type: "object",
                            properties: {
                                path: {
                                    type: "string",
                                    description: "Path to the codebase directory. Defaults to current workspace.",
                                },
                                repo: {
                                    type: "string",
                                    description: "Remote repo URL (e.g. git@github.com:org/repo.git). Defaults to git remote of path.",
                                },
                                branch: {
                                    type: "string",
                                    description: "Protected branch name (e.g. main). Defaults to current branch; omit to list candidates from cloud.",
                                },
                            },
                        },
                    },
                    {
                        name: "unlink",
                        description: unlink_description,
                        inputSchema: {
                            type: "object",
                            properties: {
                                path: {
                                    type: "string",
                                    description: "Path to the codebase directory. Defaults to current workspace.",
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
                                mode: {
                                    type: "string",
                                    enum: ["vector", "graph", "both"],
                                    description: "Search mode: 'vector' (semantic — natural-language intent), 'graph' (symbol/relationship — query must name a symbol), 'both' (default).",
                                    default: "both",
                                },
                                enrich: {
                                    type: "boolean",
                                    description: "Attach graph call-relationship context to results (both mode only, default true). Set false for lean output.",
                                    default: true,
                                },
                                docs: {
                                    type: "boolean",
                                    description: "Include documentation/markdown without score penalty (default false: docs are down-ranked so code wins). Set true when searching for guides/README/concepts.",
                                    default: false,
                                },
                                tests: {
                                    type: "boolean",
                                    description: "Include test files without score penalty (default false: tests are down-ranked so production code wins). Set true when searching for test examples/usage in tests.",
                                    default: false,
                                },
                                style: {
                                    type: "string",
                                    enum: ["full", "compact"],
                                    description: "'full' (default) returns code snippets; 'compact' returns only file:line locations.",
                                    default: "full",
                                },
                            },
                            required: ["query"],
                        },
                    },
                    {
                        name: "clear",
                        description: clear_description,
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
                        description: status_description,
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
                case "link":
                    return await this.toolHandlers.handleLink(safeArgs);
                case "unlink":
                    return await this.toolHandlers.handleUnlink(safeArgs);
                case "search":
                case "search_code":
                    return await this.toolHandlers.handleSearchCode(safeArgs);
                case "clear":
                case "clear_index":
                    return await this.toolHandlers.handleClearIndex(safeArgs);
                case "status":
                    return await this.toolHandlers.handleStatus(safeArgs);

                default:
                    throw new Error(`Unknown tool: ${name}`);
            }
        });
    }

    async start() {
        console.log('Starting Context MCP server...');

        const transport = new StdioServerTransport();
        await this.server.connect(transport);
        console.log("MCP server started and listening on stdio.");
    }

    /** Gracefully shut down: close graph store. */
    shutdown(): void {
        console.error('[SHUTDOWN] Closing graph store...');
        try { this.graphToolHandlers.close(); } catch { /* best effort */ }
        console.error('[SHUTDOWN] Shutdown complete.');
    }
}

// Main execution
async function main() {
    const args = process.argv.slice(2);

    if (args.includes('--help') || args.includes('-h')) {
        showHelpMessage();
        process.exit(0);
    }

    const config = createMcpConfig();
    logConfigurationSummary(config);

    const server = new ContextMcpServer(config);
    await server.start();
    return server;
}

// Reference to the running server for graceful shutdown.
let runningServer: ContextMcpServer | null = null;

function gracefulShutdown(signal: string) {
    console.error(`Received ${signal}, shutting down gracefully...`);
    if (runningServer) {
        try { runningServer.shutdown(); } catch { /* best effort */ }
    }
    process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

main().then(server => { runningServer = server; }).catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
});
