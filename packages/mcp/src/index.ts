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
        //
        // readOnly: true —— 本地 MCP 只做查询向量化 + 云端只读检索，向量写入全部由
        // 云端 git-index-service 负责。这不是"约定"而是硬闸门：core 把 VectorDatabase
        // 换成只读视图（写方法抛错），indexCodebase/syncIndexByGit/clearIndex/
        // getPreparedCollection 入口直接拒绝。否则本地一次误调就能往团队共享的 Milvus
        // 写脏向量、甚至 drop 掉别人的 collection。
        this.context = new Context({
            embedding,
            vectorDatabase,
            collectionNameOverride: config.collectionNameOverride,
            readOnly: true
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
Semantic + call-graph search over the linked codebase. Returns file:line + snippet + who-calls-it. It is a first-hop LOCATOR, not a replacement for Read/Grep.

Two kinds of question, two different rules:

A. RELATIONSHIP questions — "who calls X", "callers of Y", "what breaks if I change Z", dead code, entry points, follow a bug from symptom to root cause across files. Grep cannot answer these at all: it finds the string, not the edges. Use mode "graph", at ANY repo size, including small ones. This is the highest-value case and the cheapest (~330 tok).

B. LOCATION questions — "how does auth work", "where is the request handled", "which class owns retries". Here grep is a real competitor and repo size decides:
- The output header reads [repo: <own>/<total> own files, <tier>...]. Judge by OWN files (vendored + generated code is not code you have to understand) and by the noise ratio it reports. You only see this after the first call, so on an unfamiliar repo open with mode "graph" — it is the cheapest mode and its header tells you which rule applies from then on.
- >= ~2000 own files, or the header says grep gets drowned here → search, mode "both". A concept word in a repo that is half vendored returns pages of upstream hits under grep; the ranking here demotes vendored/generated code instead.
- ~300-2000 own files → either works. Prefer search when you cannot name a file or symbol to grep for; prefer grep once you can.
- < ~300 own files with a low noise ratio → Grep/Read is cheaper and gives fuller answers. Measured: grep beat search in all 8 scenarios on flask/requests.

Never worth a search:
- Exact string, symbol, or file path already known → Grep/Read directly (instant, zero cost).
- A verbatim whole file, or config/YAML/markdown → Read a located line range.
- Something not written down in this repo at all. Retrieval only surfaces what the code says; if no file mentions the concept, no mode will invent the link (a query about "zero copy shared memory" will not find the IPC library whose source never uses those words). One reformulation, then fall back to Grep.
Ranking scores identifiers, so describe the ARTIFACT you expect to exist, not the outcome you want: "proxy factory create instance" finds ProxyFactory where "how is a proxy created for a service" ranks its four sibling Create* methods above it, and "set value kvs" finds SetValue where "persist key value pairs" does not.

Picking a mode — measured on 76 expected symbols across two real C++ repos (warm):
- "graph" — 23/23 on the questions it is meant for, ~500 tok, 70-110ms, no link needed (89% across a wider set that includes location questions better served by "both"). Prose is fine, not just symbol names: identifiers are indexed word-by-word and stemmed, so "initialize logging and create the log manager" finds InitLogging/LogManager. Returns locations + call chains, no code — start here whenever that is enough.
- "both" — 97%, ~2800 tok (6x graph), 150-260ms. Buys the code snippets plus the call chains. Default when you need to read what the code does, not just where it is.
- "vector" — 91%, ~2400 tok, 65-110ms. Semantic reach without call graphs; use when you want snippets and already know how the pieces connect. Requires link.

After search locates a spot, Read that exact line range to understand/edit. Cost control: style:"compact" for file:line only (~10x fewer tokens), limit:5 to cap snippets, enrich:false to skip the call-graph. Snippets share a whole-response budget, so a large limit shortens each one — ask for fewer hits when you want them complete. Pass vendor:true only when the answer genuinely lives in an upstream library, tests:true / docs:true likewise for test or prose files — all three are demoted by default. Markdown is deliberately not indexed (prose embeds nearer an NL query than the code implementing it, so it crowds out the answer), so a README is a Read/Grep job, never a search. Needs link for vector; without link returns graph-only.
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
                                    description: "Search mode. OMIT THIS to let the server pick by query shape — relationship questions ('who calls X', 'impact of changing Y') and bare identifiers auto-route to 'graph' (~500 tok instead of ~2800), and if the graph comes back thin the server adds the vector pass in the same call. Set it explicitly only to override: 'graph' (symbols + call relationships, cheapest, no link needed), 'vector' (semantic snippets, needs link), 'both' (vector snippets + graph context).",
                                },
                                enrich: {
                                    type: "boolean",
                                    description: "Attach graph call-relationship context to results (both mode only, default true). Set false for lean output.",
                                    default: true,
                                },
                                docs: {
                                    type: "boolean",
                                    description: "Stop down-ranking prose files (default false: docs keep half score so code wins). Covers .rst/.adoc/.txt only — markdown is not indexed at all, so this will never surface a README.md. Set true for reStructuredText/AsciiDoc docs, e.g. Python projects' docs/ trees.",
                                    default: false,
                                },
                                tests: {
                                    type: "boolean",
                                    description: "Include test files without score penalty (default false: tests are down-ranked so production code wins). Set true when searching for test examples/usage in tests.",
                                    default: false,
                                },
                                vendor: {
                                    type: "boolean",
                                    description: "Include vendored/third-party subtrees without score penalty (default false: code under third_party/, node_modules/, git submodules, or a subtree named by a root LICENSE-<lib> file is down-ranked so this repo's own code wins). Set true only when you deliberately want to read the upstream library.",
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
