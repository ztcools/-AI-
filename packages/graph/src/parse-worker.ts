/**
 * Worker thread for parallel tree-sitter parsing.
 * Receives a batch of file paths, reads and parses them,
 * returns the extracted nodes and edges to the main thread.
 *
 * Eliminates the main-thread CPU bottleneck during Phase 1
 * of graph indexing — the main thread's event loop stays
 * free for the vector index's async I/O.
 */
import { parentPort } from 'worker_threads';
import * as fs from 'fs';
import { GraphExtractor } from './extractor';

const extractor = new GraphExtractor();

interface WorkerMessage {
    files: Array<{ filePath: string; project: string }>;
    repoPath: string;
}

interface WorkerResult {
    filePath: string;
    relPath: string;
    nodes: Array<{
        label: string;
        name: string;
        qualifiedName: string;
        filePath: string;
        startLine: number;
        endLine: number;
        properties: Record<string, unknown>;
    }>;
    edges: Array<{
        sourceId: number;
        targetId: number;
        type: string;
        properties: Record<string, unknown>;
    }>;
}

parentPort?.on('message', (msg: WorkerMessage) => {
    const results: WorkerResult[] = [];

    for (const file of msg.files) {
        const dotIdx = file.filePath.lastIndexOf('.');
        if (dotIdx < 0) continue;
        const ext = file.filePath.slice(dotIdx);
        const lang = GraphExtractor.extToLanguage(ext);
        if (!lang) continue;

        try {
            const source = fs.readFileSync(file.filePath, 'utf-8');
            const relPath = file.filePath.startsWith(msg.repoPath + '/')
                ? file.filePath.slice(msg.repoPath.length + 1)
                : file.filePath;

            const result = extractor.extract(source, {
                project: file.project,
                filePath: relPath,
                language: lang,
            });
            results.push({
                filePath: file.filePath,
                relPath,
                nodes: result.nodes as WorkerResult['nodes'],
                edges: result.edges as WorkerResult['edges'],
            });
        } catch {
            // Skip unreadable or unparseable files
        }
    }
    parentPort?.postMessage(results);
});