/**
 * @seeway/claude-context-graph
 * Knowledge graph engine for structured code analysis.
 *
 * v2 — refactored with reference resolution, multi-threaded parsing,
 * per-project storage, and enhanced graph algorithms.
 */
import * as path from 'path';

export * from './types';
export * from './graph-store';
export * from './graph-buffer';
export * from './registry';
export * from './extractor';
export * from './tracer';
export * from './searcher';
export * from './architecture';
export * from './resolution/index';
export * from './utils';
export * from './vendor-detect';

// v2 new modules
export { GraphTraverser, CallTracer } from './traversal';
export { GraphQueryManager } from './queries';
export { GraphIndexer, INDEXER_VERSION } from './indexer';
export type { GraphIndexerOptions } from './indexer';

// Multi-threading infrastructure (v2)
export { ParseWorkerPool, resolveParsePoolSize, resolveParseTimeoutMs, readGrammarWasmBytes } from './parse-pool';
export type { ParseTask, ParseWorkerResult, ParseWorkerPoolOptions } from './parse-pool';

/** Path to the parse-worker-v2 script for Worker Thread-based parallel parsing. */
export const parseWorkerPath = path.join(__dirname, 'parse-worker-v2.js');
