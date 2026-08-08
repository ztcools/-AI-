# claude-context — Seeway Code Index MCP Service

A code retrieval tool for AI coding agents. Dual-engine: **vector semantic search** (cloud Milvus, read-only) + **call graph** (local SQLite).
A single `search` answers both "where is the code" and "who calls it" — which is exactly what grep can't do.

## What problem it solves

An agent reading code in an unfamiliar repo defaults to grep/read: great when you know the exact symbol name, but when you don't, a keyword match either lands on hundreds of hits,
or you can't even guess what to grep for. And structural questions like "who calls it / what breaks if I change it / is this dead code" are fundamentally unanswerable with grep.

`search` fills precisely those two gaps:

| Capability | grep/read | search |
|------|-----------|--------|
| Known exact string/symbol/path | ✅ Instant, zero cost | ❌ Slower, don't use |
| Only know the intent, not the name | ❌ Drowned in noise | ✅ Semantic + stemming + abbreviation normalization |
| Who calls it / call chain / impact scope | ❌ Impossible to determine | ✅ Call graph gives it directly |
| Dead code `[unused]` / entry points `[entry]` | ❌ | ✅ Marked in the results |
| Need a verbatim complete file | ✅ | ❌ Use Read |

**Positioning: search is "the first hop for locating," not a replacement for Read.** Search first to get `file:line` + call chain,
then use Read with offset/limit to read exactly those lines — that's the key move that saves tokens.

## Quick Start

```
link                                   # Once per session, binds the cloud vector index + builds the local graph (background)
  ↓
search(query="how does auth work")     # Get file:line + signature + call relationships
  ↓
Read(file, offset, limit)              # Read only the lines you need, don't read the whole file
```

After `link`, the graph index auto-updates incrementally as you change code, **no manual index required** (local vector writes are disabled by design;
vectors are indexed daily from the cloud against protected branches).

## Three search modes (tested 2026-07-30 on two real C++ repos, 36 expected symbols)

| mode | recall | token | latency | needs link | when to use |
|------|------|-------|------|-----------|-----------|
| `graph` | **86%** | ~300 | 60–105ms | No | Relational questions (who calls X / impact scope / dead code / entry points); the default when you only want location and call chain, not code |
| `both` (default) | **93%** | ~2200 | 128–220ms | Yes (for the vector part) | When you need the code snippet itself; or what you're looking for is **not** spelled out by any identifier (concepts like underlying libraries or "zero-copy shared memory") |
| `vector` | **83%** | ~1700 | ~50ms | Yes | Semantic lookup of an implementation, no call graph needed |

`graph` mode accepts **natural language**, no need to name the symbol: identifiers are split into words and stemmed,
so "initialize logging and create the log manager" hits `InitLogging` / `LogManager`,
and "supervised entity recovery action" hits two classes at once.

**Token-saving switches**: `style:"compact"` (only file:line, ~1/10 the tokens), `limit:5`, `enrich:false` (no call graph).
Snippets share one overall response budget, so the larger the `limit`, the shorter each one — if you want full snippets, ask for fewer.

## When **not** to use

- **Small repos (< ~300 files)**: tested against the grep baseline on flask/requests and won all 8 scenarios. grep is cheaper and gives more complete results.
- **Known exact token/symbol/path** → just Grep/Read.
- **Non-AST languages** (the graph doesn't work, only weak semantics remain): Ruby, PHP, Kotlin, Swift, Vue templates, and config/YAML/JSON/lock files/Markdown.
  - AST/graph **supported**: JS/TS, Python, Java, C/C++, Go, Rust, C#, Scala.
- **Need verbatim complete content** (editing a whole file, format-sensitive) → Read.

## MCP tools

| Tool | Purpose |
|------|------|
| `link` | Binds the current repo to a protected branch's collection on the cloud (session-level, nothing written to disk) + builds/updates the local graph in the background. Omit `branch` to list candidate cloud branches |
| `search` | Retrieval. Params: `query`, `mode`, `limit`, `style`, `enrich`, `extensionFilter`, `docs`, `tests`, `path` |
| `status` | link status (cloud repo@branch + connectivity) + local graph stats (nodes/edges/types/routes) |
| `clear` | Clears the local graph index (cloud vectors are unaffected) |
| `unlink` | Unbinds the cloud index, keeps the local graph |

`docs` / `tests` default to `false`: documentation and test files are down-weighted so production code wins; turn them on explicitly when looking for READMEs/usage examples.

## Architecture

```
                    ┌─────────────────────────┐
                    │     MCP search API       │
                    │  mode: both/vector/graph │
                    └───────────┬─────────────┘
            ┌───────────────────┴───────────────────┐
    ┌───────▼────────┐                    ┌────────▼─────────┐
    │Vector index    │                    │Graph index       │
    │(Milvus)        │                    │(SQLite)          │
    │cloud read-only │                    │call graph /      │
    │search          │                    │blast radius      │
    │per repo:branch │                    │cross-file refs   │
    │dense+BM25 RRF  │                    │FTS5 full-text    │
    └───────┬────────┘                    └────────┬─────────┘
    ┌───────▼────────┐                    ┌────────▼─────────┐
    │Milvus Server   │                    │.context/graph/   │
    │10.50.4.149     │                    │<project> local   │
    │(team-shared)   │                    │(gitignored)      │
    └────────────────┘                    └──────────────────┘
```

- **Vector**: no writes locally at all — the MCP hardcodes `readOnly: true` when constructing the engine, and creating/deleting collections,
  insert/delete, and index orchestration are all rejected; this is a code-level guarantee, not a convention. The cloud `git-index-service` incrementally indexes
  `repo:protected branch` into Milvus daily; locally it only does ①query vectorization ②direct read-only retrieval from the cloud.
- **Graph**: `<project>/.context/graph/knowledge-graph.db`, built locally per developer, decoupled from git.
  Merkle content hashes detect changes and make it immune to `git reset/rebase/stash`.
  A single MCP process can hold graphs for multiple repos at once (LRU cap of 8), and searching multiple repos concurrently doesn't interfere.

See [CLAUDE.md](CLAUDE.md) for the detailed module breakdown and algorithms.

## Install

```bash
# 1. Global config (don't put it inside the repo directory)
cp .env.example ~/.context/.env    # edit MILVUS_ADDRESS / OLLAMA_HOST as needed

# 2. Install and register the MCP
./install.sh
```

`install.sh` builds each package, installs the MCP to `~/.claude-context/`, registers it with Claude Code,
and installs `commands/` (slash commands like `/seeway-link`) and `rules/code-context-policy.md` (trigger policy).

## Development

```bash
pnpm install
pnpm build                        # full build
pnpm test                         # = pnpm --filter @seeway/claude-context-graph test
pnpm typecheck
cd packages/mcp && pnpm dev       # start the MCP locally
```

Package structure (pnpm monorepo):

| Package | Responsibility |
|----|------|
| `packages/core` | Vector index engine + Milvus client + embedding provider |
| `packages/graph` | Knowledge graph engine (tree-sitter extraction, SQLite/FTS5, cross-file resolution, traversal) |
| `packages/mcp` | MCP service (external entry point, tool registration and handlers) |
| `packages/git-index-service` | Server-side scheduled indexing (cloud, not run on the developer's machine) |

Dependency direction: `mcp → core + graph`; `core` and `graph` are each independent.

## Deployment

- Local MCP: `node packages/mcp/dist/index.js`
- Cloud infrastructure and container orchestration: see [DEPLOY.md](DEPLOY.md)
- Measured retrieval quality over time: see [SEARCH-EVALUATION.md](SEARCH-EVALUATION.md)

## License

See [LICENSE](LICENSE).
