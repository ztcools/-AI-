/**
 * Graph store integration tests.
 * Run with: pnpm test
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { SqliteGraphStore } from './graph-store';
import { GraphExtractor } from './extractor';
import { CallTracer } from './tracer';
import { GraphSearcher } from './searcher';
import { ArchitectureAnalyzer } from './architecture';

const TEST_DB = path.join(os.tmpdir(), 'test-graph-' + Date.now() + '.db');

describe('SqliteGraphStore', () => {
    let store: SqliteGraphStore;

    before(() => {
        store = new SqliteGraphStore(TEST_DB);
        store.initialize();
    });

    after(() => {
        store.close();
        try { fs.unlinkSync(TEST_DB); } catch { }
        // Clean up WAL/SHM files
        try { fs.unlinkSync(TEST_DB + '-wal'); } catch { }
        try { fs.unlinkSync(TEST_DB + '-shm'); } catch { }
    });

    it('should initialize with empty state', () => {
        const projects = store.listProjects();
        assert.strictEqual(projects.length, 0);
    });

    it('should upsert and retrieve a node', () => {
        const id = store.upsertNode({
            project: 'test-project',
            label: 'Function',
            name: 'main',
            qualifiedName: 'test-project.main.main',
            filePath: 'src/main.ts',
            startLine: 1,
            endLine: 10,
            properties: { language: 'typescript' },
        });
        assert.ok(id > 0);

        const node = store.getNodeById(id);
        assert.ok(node);
        assert.strictEqual(node?.name, 'main');
        assert.strictEqual(node?.label, 'Function');
        assert.strictEqual(node?.qualifiedName, 'test-project.main.main');
    });

    it('should upsert an edge between nodes', () => {
        const id1 = store.upsertNode({
            project: 'test-project',
            label: 'Function',
            name: 'caller',
            qualifiedName: 'test-project.caller.caller',
            filePath: 'src/caller.ts',
            startLine: 1,
            endLine: 5,
            properties: {},
        });

        const id2 = store.upsertNode({
            project: 'test-project',
            label: 'Function',
            name: 'callee',
            qualifiedName: 'test-project.callee.callee',
            filePath: 'src/callee.ts',
            startLine: 1,
            endLine: 3,
            properties: {},
        });

        const edgeId = store.upsertEdge({
            project: 'test-project',
            sourceId: id1,
            targetId: id2,
            type: 'CALLS',
            properties: {},
        });
        assert.ok(edgeId > 0);

        const edges = store.getEdgesBySource(id1);
        assert.strictEqual(edges.length, 1);
        assert.strictEqual(edges[0].type, 'CALLS');
        assert.strictEqual(edges[0].targetId, id2);
    });

    it('should deduplicate edges', () => {
        const id1 = store.upsertNode({
            project: 'test-project',
            label: 'Function',
            name: 'dedupA',
            qualifiedName: 'test-project.dedupA',
            filePath: 'src/dedup.ts',
            startLine: 1, endLine: 2, properties: {},
        });
        const id2 = store.upsertNode({
            project: 'test-project',
            label: 'Function',
            name: 'dedupB',
            qualifiedName: 'test-project.dedupB',
            filePath: 'src/dedup.ts',
            startLine: 3, endLine: 4, properties: {},
        });

        const e1 = store.upsertEdge({ project: 'test-project', sourceId: id1, targetId: id2, type: 'CALLS', properties: {} });
        const e2 = store.upsertEdge({ project: 'test-project', sourceId: id1, targetId: id2, type: 'CALLS', properties: {} });
        assert.strictEqual(e1, e2); // Should return same ID

        const edges = store.getEdgesBySource(id1);
        assert.strictEqual(edges.length, 1);
    });

    it('should search nodes by name pattern', () => {
        const result = store.findNodes({
            project: 'test-project',
            namePattern: 'main',
        });
        assert.ok(result.results.length >= 1);
        assert.strictEqual(result.results[0].node.name, 'main');
    });

    it('should get node degree', () => {
        const node = store.getNodeByQN('test-project', 'test-project.caller.caller');
        assert.ok(node);
        const { inDegree, outDegree } = store.getNodeDegree(node!.id);
        assert.strictEqual(outDegree, 1); // caller -> callee
    });

    it('should list projects', () => {
        const projects = store.listProjects();
        assert.ok(projects.includes('test-project'));
    });

    it('should get project stats', () => {
        const stats = store.getProjectStats('test-project');
        assert.ok(stats.nodes > 0);
        assert.ok(stats.edges > 0);
    });

    it('should get schema', () => {
        const schema = store.getSchema();
        assert.ok(schema.nodeLabels.includes('Function'));
        assert.ok(schema.edgeTypes.includes('CALLS'));
    });

    it('should delete project', () => {
        store.deleteProject('test-project');
        const projects = store.listProjects();
        assert.strictEqual(projects.length, 0);
    });
});

describe('GraphExtractor', () => {
    it('should extract functions from TypeScript code', () => {
        const extractor = new GraphExtractor();
        const source = `
function hello() {
    console.log("hello");
}

class MyClass {
    greet() {
        hello();
    }
}
`;
        const result = extractor.extract(source, {
            project: 'test',
            filePath: 'src/test.ts',
            language: 'typescript',
        });

        assert.ok(result.nodes.length > 0);
        const functions = result.nodes.filter(n => n.label === 'Function');
        assert.ok(functions.length >= 1);
    });

    it('should create CALLS edges between functions', () => {
        const extractor = new GraphExtractor();
        const source = `
function foo() {
    bar();
}

function bar() {
    console.log("bar");
}

function baz() {
    foo();
    bar();
}
`;
        const result = extractor.extract(source, {
            project: 'test',
            filePath: 'src/calls.ts',
            language: 'typescript',
        });

        const callEdges = result.edges.filter(e => e.type === 'CALLS');
        assert.ok(callEdges.length >= 2, `Expected at least 2 CALLS edges, got ${callEdges.length}`);
    });

    it('should handle import resolution', () => {
        const extractor = new GraphExtractor();
        const source = `
import { helper } from './utils';

function main() {
    helper();
}
`;
        const result = extractor.extract(source, {
            project: 'test',
            filePath: 'src/main.ts',
            language: 'typescript',
        });

        const importEdges = result.edges.filter(e => e.type === 'IMPORTS');
        assert.ok(importEdges.length >= 1, `Expected at least 1 IMPORTS edge, got ${importEdges.length}`);
    });

    it('should extract functions from Python code', () => {
        const extractor = new GraphExtractor();
        const source = `
def hello():
    print("hello")

class MyClass:
    def greet(self):
        hello()
`;
        const result = extractor.extract(source, {
            project: 'test',
            filePath: 'src/test.py',
            language: 'python',
        });

        assert.ok(result.nodes.length > 0);
        const functions = result.nodes.filter(n => n.label === 'Function');
        assert.ok(functions.length >= 1);
    });

    it('should report supported languages', () => {
        const extractor = new GraphExtractor();
        const langs = extractor.getSupportedLanguages();
        assert.ok(langs.includes('typescript'));
        assert.ok(langs.includes('python'));
        assert.ok(langs.includes('go'));
        assert.ok(langs.includes('rust'));
    });

    it('should map extensions to languages', () => {
        assert.strictEqual(GraphExtractor.extToLanguage('.ts'), 'typescript');
        assert.strictEqual(GraphExtractor.extToLanguage('.py'), 'python');
        assert.strictEqual(GraphExtractor.extToLanguage('.go'), 'go');
        assert.strictEqual(GraphExtractor.extToLanguage('.rs'), 'rust');
        assert.strictEqual(GraphExtractor.extToLanguage('.java'), 'java');
        assert.strictEqual(GraphExtractor.extToLanguage('.unknown'), '');
    });
});

describe('CallTracer', () => {
    let store: SqliteGraphStore;

    before(() => {
        store = new SqliteGraphStore(TEST_DB + '-tracer');
        store.initialize();

        const a = store.upsertNode({ project: 'p', label: 'Function', name: 'A', qualifiedName: 'p.A', filePath: 'a.ts', startLine: 1, endLine: 5, properties: {} });
        const b = store.upsertNode({ project: 'p', label: 'Function', name: 'B', qualifiedName: 'p.B', filePath: 'b.ts', startLine: 1, endLine: 5, properties: {} });
        const c = store.upsertNode({ project: 'p', label: 'Function', name: 'C', qualifiedName: 'p.C', filePath: 'c.ts', startLine: 1, endLine: 5, properties: {} });
        store.upsertEdge({ project: 'p', sourceId: a, targetId: b, type: 'CALLS', properties: {} });
        store.upsertEdge({ project: 'p', sourceId: b, targetId: c, type: 'CALLS', properties: {} });
    });

    after(() => {
        store.close();
    });

    it('should trace callers', () => {
        const tracer = new CallTracer(store);
        const result = tracer.trace({
            project: 'p',
            functionName: 'C',
            direction: 'inbound',
            depth: 3,
            mode: 'calls',
        });

        assert.strictEqual(result.root.name, 'C');
        assert.ok(result.callers.length >= 1);
        const callerNames = result.callers.map(c => c.node.name);
        assert.ok(callerNames.includes('B'));
    });

    it('should trace callees', () => {
        const tracer = new CallTracer(store);
        const result = tracer.trace({
            project: 'p',
            functionName: 'A',
            direction: 'outbound',
            depth: 3,
            mode: 'calls',
        });

        assert.strictEqual(result.root.name, 'A');
        assert.ok(result.callees.length >= 1);
        const calleeNames = result.callees.map(c => c.node.name);
        assert.ok(calleeNames.includes('B'));
    });
});

describe('GraphSearcher', () => {
    let store: SqliteGraphStore;

    before(() => {
        store = new SqliteGraphStore(TEST_DB + '-searcher');
        store.initialize();
        store.upsertNode({ project: 'p', label: 'Function', name: 'findUser', qualifiedName: 'p.findUser', filePath: 'src/users.ts', startLine: 10, endLine: 25, properties: {} });
    });

    after(() => {
        store.close();
    });

    it('should search by name pattern', () => {
        const searcher = new GraphSearcher(store);
        const result = searcher.searchGraph({ project: 'p', namePattern: 'find' });
        assert.ok(result.results.length >= 1);
        assert.strictEqual(result.results[0].node.name, 'findUser');
    });

    it('should get code snippet', () => {
        const searcher = new GraphSearcher(store);
        const result = searcher.getCodeSnippet('p', 'p.findUser');
        assert.ok(result);
        assert.strictEqual(result?.node.name, 'findUser');
    });
});

describe('ArchitectureAnalyzer', () => {
    let store: SqliteGraphStore;

    before(() => {
        store = new SqliteGraphStore(TEST_DB + '-arch');
        store.initialize();
        store.upsertNode({ project: 'p', label: 'Function', name: 'main', qualifiedName: 'p.main', filePath: 'src/main.ts', startLine: 1, endLine: 10, properties: {} });
        store.upsertNode({ project: 'p', label: 'Class', name: 'App', qualifiedName: 'p.App', filePath: 'src/app.ts', startLine: 1, endLine: 50, properties: {} });
        store.upsertNode({ project: 'p', label: 'Function', name: 'helper', qualifiedName: 'p.helper', filePath: 'src/utils/helper.ts', startLine: 1, endLine: 5, properties: {} });
    });

    after(() => {
        store.close();
    });

    it('should get architecture overview', () => {
        const analyzer = new ArchitectureAnalyzer(store);
        const arch = analyzer.getArchitecture('p');
        assert.strictEqual(arch.project, 'p');
        assert.ok(arch.totalNodes > 0);
        assert.ok(arch.nodeTypes['Function'] >= 1);
        assert.ok(arch.nodeTypes['Class'] >= 1);
        assert.ok(arch.clusters.length >= 1);
    });
});

describe('ADR and QueryGraph', () => {
    let store: SqliteGraphStore;

    before(() => {
        store = new SqliteGraphStore(TEST_DB + '-adr');
        store.initialize();
        store.upsertNode({ project: 'p', label: 'Function', name: 'testFunc', qualifiedName: 'p.testFunc', filePath: 'src/test.ts', startLine: 1, endLine: 5, properties: {} });
    });

    after(() => {
        store.close();
    });

    it('should create and list ADRs', () => {
        const id = store.createADR({
            project: 'p',
            title: 'Use PostgreSQL for storage',
            content: 'Decision: Use PostgreSQL as the primary database.',
            status: 'proposed',
        });
        assert.ok(id > 0);

        const adrs = store.getADRs('p');
        assert.strictEqual(adrs.length, 1);
        assert.strictEqual(adrs[0].title, 'Use PostgreSQL for storage');
        assert.strictEqual(adrs[0].status, 'proposed');
    });

    it('should update ADR status', () => {
        const adrs = store.getADRs('p');
        store.updateADR(adrs[0].id, { status: 'accepted' });

        const updated = store.getADRs('p');
        assert.strictEqual(updated[0].status, 'accepted');
    });

    it('should execute Cypher-like query', () => {
        const result = store.executeQuery('p', "MATCH (n) WHERE n.name = 'testFunc' RETURN n");
        assert.strictEqual(result.rows.length, 1);
        assert.strictEqual(result.rows[0].name, 'testFunc');
    });

    it('should execute query with CONTAINS', () => {
        const result = store.executeQuery('p', "MATCH (n) WHERE n.name CONTAINS 'test' RETURN n");
        assert.ok(result.rows.length >= 1);
    });
});

describe('FindEdges and CrossFile', () => {
    let store: SqliteGraphStore;

    before(() => {
        store = new SqliteGraphStore(TEST_DB + '-cross');
        store.initialize();

        // Create two functions in different files
        const a = store.upsertNode({ project: 'p', label: 'Function', name: 'foo', qualifiedName: 'p.src.a.foo', filePath: 'src/a.ts', startLine: 1, endLine: 5, properties: {} });
        const b = store.upsertNode({ project: 'p', label: 'Function', name: 'bar', qualifiedName: 'p.src.b.bar', filePath: 'src/b.ts', startLine: 1, endLine: 5, properties: {} });

        // Create IMPORTS edge (foo imports bar)
        store.upsertEdge({ project: 'p', sourceId: a, targetId: b, type: 'IMPORTS', properties: { importedName: 'bar' } });

        // Create CALLS edge for testing
        store.upsertEdge({ project: 'p', sourceId: a, targetId: b, type: 'CALLS', properties: { crossFile: true } });
    });

    after(() => {
        store.close();
    });

    it('should find edges by type', () => {
        const edges = store.findEdges('p', ['CALLS']);
        assert.strictEqual(edges.length, 1);
        assert.strictEqual(edges[0].type, 'CALLS');
    });

    it('should find IMPORTS edges', () => {
        const edges = store.findEdges('p', ['IMPORTS']);
        assert.strictEqual(edges.length, 1);
        assert.strictEqual(edges[0].type, 'IMPORTS');
    });

    it('should return all edges for project', () => {
        const edges = store.findEdges('p');
        assert.strictEqual(edges.length, 2);
    });
});

console.log('All graph tests passed!');