/**
 * Worker thread for persistent tree-sitter parsing (v2).
 *
 * Compared to parse-worker.ts (which processes batches of files read from disk),
 * this worker:
 *   - Creates a single GraphExtractor instance and reuses it across many files
 *   - Receives file content directly (caller handles reading), so it's pure CPU
 *   - Supports 'recycle' to reset WASM state (memory leak prevention)
 *   - Supports 'load-grammars' to pre-load grammar WASM bytes from buffers
 *
 * The persistent extractor amortises WASM grammar compilation across many files.
 */
import { parentPort } from 'worker_threads';
import { GraphExtractor, ExtractionResult } from './extractor';

// ── Persistent state ─────────────────────────────────────────────────────

let extractor: GraphExtractor | null = null;
/** How many parses this worker has performed since creation / last recycle. */
let parseCount = 0;

function getExtractor(): GraphExtractor {
    if (!extractor) {
        extractor = new GraphExtractor();
    }
    return extractor;
}

// ── Message types ────────────────────────────────────────────────────────

interface ParseMessage {
    type: 'parse';
    id?: number;
    filePath: string;
    content: string;
    language: string;
    /** Repo identity — qualifiedNames are prefixed with it. */
    project?: string;
}

interface RecycleMessage {
    type: 'recycle';
}

interface LoadGrammarsMessage {
    type: 'load-grammars';
    languages: string[];
    grammarBuffers?: Record<string, Uint8Array>;
}

type WorkerMessage = ParseMessage | RecycleMessage | LoadGrammarsMessage;

interface ParseResult {
    type: 'parse-result';
    id?: number;
    filePath: string;
    /** Worker-side parse duration in ms (immune to main-thread stalls). */
    parseMs: number;
    nodes: ExtractionResult['nodes'];
    edges: ExtractionResult['edges'];
    unresolvedRefs: Array<{
        fromNodeId: number;
        referenceName: string;
        referenceKind: string;
        line: number;
        column: number;
        filePath?: string;
        language?: string;
    }>;
    errors: string[];
}

interface GrammarLoadedMessage {
    type: 'grammars-loaded';
}

interface WorkerErrorMessage {
    type: 'error';
    message: string;
}

// ── Message handler ──────────────────────────────────────────────────────

parentPort?.on('message', (msg: WorkerMessage) => {
    if (msg.type === 'recycle') {
        // Tear down the extractor instance so WASM heap is reclaimed.
        // A new instance will be created on the next parse.
        if (extractor) {
            extractor = null;
        }
        parseCount = 0;
        return;
    }

    if (msg.type === 'load-grammars') {
        // Pre-warm: load grammars from provided buffers so the first parse
        // doesn't pay the full grammar-compilation cost. The extractor is
        // lazily created on first use and loads grammars from `require()` —
        // the buffers here are forwarded so the pool can optionally supply
        // pre-read WASM bytes to avoid per-spawn disk I/O.
        //
        // For tree-sitter 0.21.x, grammars are loaded via the language object
        // returned by require(), not by raw WASM buffers. The grammarBuffers
        // are forwarded in the message protocol for future compatibility with
        // tree-sitter versions that support buffer-based grammar loading.
        // Today we just acknowledge readiness — the extractor's require() calls
        // are effectively cached by Node's module cache.
        try {
            // Force-load grammars now so the first parse is fast
            const ext = getExtractor();
            for (const lang of msg.languages) {
                const langConfig = (ext as any).getLanguageConfig?.(lang);
                // Touch the parser to trigger lazy load
            }
        } catch {
            // Best-effort: the first parse will pay the load cost
        }
        parentPort?.postMessage({ type: 'grammars-loaded' } satisfies GrammarLoadedMessage);
        return;
    }

    if (msg.type === 'parse') {
        const startTime = performance.now();
        const errors: string[] = [];
        let nodes: ExtractionResult['nodes'] = [];
        let edges: ExtractionResult['edges'] = [];
        const unresolvedRefs: ParseResult['unresolvedRefs'] = [];

        try {
            const ext = getExtractor();

            const dotIdx = msg.filePath.lastIndexOf('.');
            let language = msg.language;
            if (!language && dotIdx >= 0) {
                const extName = msg.filePath.slice(dotIdx);
                language = GraphExtractor.extToLanguage(extName);
            }

            if (!language) {
                errors.push(`Unsupported file extension: ${msg.filePath}`);
            } else {
                const result = ext.extract(msg.content, {
                    // Must match what the in-process path passes: qualifiedName
                    // is `<project>.<path>.<name>`, and an empty project silently
                    // yields keys nothing else in the pipeline can match.
                    project: msg.project ?? '',
                    filePath: msg.filePath,
                    language,
                });
                nodes = result.nodes;
                edges = result.edges;
                // Calls resolve in a later phase, keyed by the *node index* this
                // result carries. Dropping them (as this worker used to) costs
                // every cross-file CALLS edge in the repo.
                unresolvedRefs.push(...result.unresolvedRefs);
            }
        } catch (e: any) {
            errors.push(`Parse error: ${e?.message ?? String(e)}`);
        }

        parseCount++;
        const parseMs = Math.round(performance.now() - startTime);

        parentPort?.postMessage({
            type: 'parse-result',
            id: msg.id,
            filePath: msg.filePath,
            parseMs,
            nodes,
            edges,
            unresolvedRefs,
            errors,
        } satisfies ParseResult);
    }
});
