/**
 * @zilliz/claude-context-graph
 * Knowledge graph engine for structured code analysis.
 * Complementary to the existing vector-based semantic search in claude-context-core.
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
export * from './utils';

/** Path to the parse-worker script for Worker Thread-based parallel parsing. */
export const parseWorkerPath = path.join(__dirname, 'parse-worker.js');