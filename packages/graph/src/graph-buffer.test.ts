/**
 * InMemoryGraphBuffer unit tests.
 * Run with: pnpm test
 *
 * Mirrors the test patterns from codebase-memory-mcp's graph_buffer tests.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { InMemoryGraphBuffer } from './graph-buffer';

describe('InMemoryGraphBuffer', () => {
    it('should start empty', () => {
        const gb = new InMemoryGraphBuffer('test');
        assert.strictEqual(gb.nodeCount(), 0);
        assert.strictEqual(gb.edgeCount(), 0);
    });

    it('should upsert nodes and retrieve by QN', () => {
        const gb = new InMemoryGraphBuffer('test');
        const id = gb.upsertNode(
            'Function', 'main', 'test.main.main', 'src/main.ts', 1, 10, { language: 'ts' },
        );
        assert.ok(id > 0);

        const node = gb.findNodeByQN('test.main.main');
        assert.ok(node);
        assert.strictEqual(node!.name, 'main');
        assert.strictEqual(node!.label, 'Function');
        assert.strictEqual(node!.filePath, 'src/main.ts');
        assert.strictEqual(node!.startLine, 1);
        assert.strictEqual(node!.endLine, 10);
    });

    it('should retrieve node by ID', () => {
        const gb = new InMemoryGraphBuffer('test');
        const id = gb.upsertNode('Function', 'foo', 'test.foo', 'src/foo.ts', 1, 5);
        const node = gb.findNodeById(id);
        assert.ok(node);
        assert.strictEqual(node!.name, 'foo');
    });

    it('should update existing node on QN collision (src wins)', () => {
        const gb = new InMemoryGraphBuffer('test');
        const id1 = gb.upsertNode('Function', 'old', 'test.func', 'src/old.ts', 1, 5);
        const id2 = gb.upsertNode('Function', 'new', 'test.func', 'src/new.ts', 10, 20);
        assert.strictEqual(id1, id2); // Same ID returned

        const node = gb.findNodeByQN('test.func');
        assert.ok(node);
        assert.strictEqual(node!.name, 'new'); // Updated
        assert.strictEqual(node!.filePath, 'src/new.ts');
        assert.strictEqual(gb.nodeCount(), 1); // Not duplicated
    });

    it('should find nodes by label', () => {
        const gb = new InMemoryGraphBuffer('test');
        gb.upsertNode('Function', 'a', 'test.a', 'src/a.ts', 1, 5);
        gb.upsertNode('Function', 'b', 'test.b', 'src/b.ts', 1, 5);
        gb.upsertNode('Class', 'C', 'test.C', 'src/c.ts', 1, 5);

        const funcs = gb.findNodesByLabel('Function');
        assert.strictEqual(funcs.length, 2);

        const classes = gb.findNodesByLabel('Class');
        assert.strictEqual(classes.length, 1);
    });

    it('should find nodes by name', () => {
        const gb = new InMemoryGraphBuffer('test');
        gb.upsertNode('Function', 'authenticate', 'test.pkg.authenticate', 'src/auth.ts', 1, 5);
        gb.upsertNode('Method', 'authenticate', 'test.cls.authenticate', 'src/auth.ts', 10, 15);

        const found = gb.findNodesByName('authenticate');
        assert.strictEqual(found.length, 2);
    });

    it('should insert edges and deduplicate by key', () => {
        const gb = new InMemoryGraphBuffer('test');
        const srcId = gb.upsertNode('Function', 'caller', 'test.caller', 'src/a.ts', 1, 5);
        const tgtId = gb.upsertNode('Function', 'callee', 'test.callee', 'src/b.ts', 1, 5);

        const edgeId1 = gb.insertEdge(srcId, tgtId, 'CALLS', { line: 3 });
        const edgeId2 = gb.insertEdge(srcId, tgtId, 'CALLS', { line: 5 });
        assert.strictEqual(edgeId1, edgeId2); // Dedup: same key
        assert.strictEqual(gb.edgeCount(), 1); // Only one edge

        // Different type → different edge
        gb.insertEdge(srcId, tgtId, 'IMPORTS');
        assert.strictEqual(gb.edgeCount(), 2);
    });

    it('should find edges by source and type', () => {
        const gb = new InMemoryGraphBuffer('test');
        const srcId = gb.upsertNode('Function', 'a', 'test.a', 'src/a.ts', 1, 5);
        const tgtId1 = gb.upsertNode('Function', 'b', 'test.b', 'src/b.ts', 1, 5);
        const tgtId2 = gb.upsertNode('Function', 'c', 'test.c', 'src/c.ts', 1, 5);

        gb.insertEdge(srcId, tgtId1, 'CALLS');
        gb.insertEdge(srcId, tgtId2, 'CALLS');
        gb.insertEdge(srcId, tgtId1, 'IMPORTS');

        const calls = gb.findEdgesBySourceType(srcId, 'CALLS');
        assert.strictEqual(calls.length, 2);

        const imports = gb.findEdgesBySourceType(srcId, 'IMPORTS');
        assert.strictEqual(imports.length, 1);
    });

    it('should find edges by target and type', () => {
        const gb = new InMemoryGraphBuffer('test');
        const src1 = gb.upsertNode('Function', 'a', 'test.a', 'src/a.ts', 1, 5);
        const src2 = gb.upsertNode('Function', 'b', 'test.b', 'src/b.ts', 1, 5);
        const tgt = gb.upsertNode('Function', 'c', 'test.c', 'src/c.ts', 1, 5);

        gb.insertEdge(src1, tgt, 'CALLS');
        gb.insertEdge(src2, tgt, 'CALLS');

        const callers = gb.findEdgesByTargetType(tgt, 'CALLS');
        assert.strictEqual(callers.length, 2); // Both a and b call c
    });

    it('should find edges by type', () => {
        const gb = new InMemoryGraphBuffer('test');
        const a = gb.upsertNode('Function', 'a', 'test.a', 'src/a.ts', 1, 5);
        const b = gb.upsertNode('Function', 'b', 'test.b', 'src/b.ts', 1, 5);
        const c = gb.upsertNode('Function', 'c', 'test.c', 'src/c.ts', 1, 5);

        gb.insertEdge(a, b, 'CALLS');
        gb.insertEdge(b, c, 'CALLS');
        gb.insertEdge(a, c, 'IMPORTS');

        const calls = gb.findEdgesByType('CALLS');
        assert.strictEqual(calls.length, 2);

        const imports = gb.findEdgesByType('IMPORTS');
        assert.strictEqual(imports.length, 1);
    });

    it('should delete nodes by label and cascade edges', () => {
        const gb = new InMemoryGraphBuffer('test');
        const a = gb.upsertNode('Function', 'a', 'test.a', 'src/a.ts', 1, 5);
        const b = gb.upsertNode('Function', 'b', 'test.b', 'src/b.ts', 1, 5);
        gb.insertEdge(a, b, 'CALLS');

        gb.deleteByLabel('Function');
        assert.strictEqual(gb.nodeCount(), 0);
        assert.strictEqual(gb.edgeCount(), 0); // Edge cascade-deleted
    });

    it('should delete nodes by file path', () => {
        const gb = new InMemoryGraphBuffer('test');
        gb.upsertNode('Function', 'a', 'test.a', 'src/a.ts', 1, 5);
        gb.upsertNode('Function', 'b', 'test.b', 'src/b.ts', 1, 5);
        gb.upsertNode('Class', 'C', 'test.C', 'src/a.ts', 10, 20);

        gb.deleteByFile('src/a.ts');
        assert.strictEqual(gb.nodeCount(), 1); // Only b remains
        assert.ok(gb.findNodeByQN('test.b'));
        assert.strictEqual(gb.findNodeByQN('test.a'), null);
        assert.strictEqual(gb.findNodeByQN('test.C'), null);
    });

    it('should clear project', () => {
        const gb = new InMemoryGraphBuffer('test');
        gb.upsertNode('Function', 'a', 'test.a', 'src/a.ts', 1, 5);
        gb.upsertNode('Function', 'b', 'test.b', 'src/b.ts', 1, 5);
        const a = gb.findNodeByQN('test.a')!;
        const b = gb.findNodeByQN('test.b')!;
        gb.insertEdge(a.id, b.id, 'CALLS');

        gb.clearProject();
        assert.strictEqual(gb.nodeCount(), 0);
        assert.strictEqual(gb.edgeCount(), 0);
    });

    it('should return null for non-existent QN', () => {
        const gb = new InMemoryGraphBuffer('test');
        assert.strictEqual(gb.findNodeByQN('nonexistent'), null);
    });

    it('should return null for non-existent ID', () => {
        const gb = new InMemoryGraphBuffer('test');
        assert.strictEqual(gb.findNodeById(999), null);
    });

    it('should count edges by type', () => {
        const gb = new InMemoryGraphBuffer('test');
        const a = gb.upsertNode('Function', 'a', 'test.a', 'src/a.ts', 1, 5);
        const b = gb.upsertNode('Function', 'b', 'test.b', 'src/b.ts', 1, 5);
        const c = gb.upsertNode('Function', 'c', 'test.c', 'src/c.ts', 1, 5);

        gb.insertEdge(a, b, 'CALLS');
        gb.insertEdge(b, c, 'CALLS');
        gb.insertEdge(a, c, 'IMPORTS');

        assert.strictEqual(gb.edgeCountByType('CALLS'), 2);
        assert.strictEqual(gb.edgeCountByType('IMPORTS'), 1);
        assert.strictEqual(gb.edgeCountByType('INHERITS'), 0);
    });

    it('should iterate all nodes', () => {
        const gb = new InMemoryGraphBuffer('test');
        gb.upsertNode('Function', 'a', 'test.a', 'src/a.ts', 1, 5);
        gb.upsertNode('Function', 'b', 'test.b', 'src/b.ts', 1, 5);

        const names: string[] = [];
        gb.forEachNode((n) => names.push(n.name));
        assert.strictEqual(names.length, 2);
        assert.ok(names.includes('a'));
        assert.ok(names.includes('b'));
    });

    it('should iterate all edges', () => {
        const gb = new InMemoryGraphBuffer('test');
        const a = gb.upsertNode('Function', 'a', 'test.a', 'src/a.ts', 1, 5);
        const b = gb.upsertNode('Function', 'b', 'test.b', 'src/b.ts', 1, 5);
        gb.insertEdge(a, b, 'CALLS');

        const types: string[] = [];
        gb.forEachEdge((e) => types.push(e.type));
        assert.strictEqual(types.length, 1);
        assert.strictEqual(types[0], 'CALLS');
    });

    it('should intern strings to reduce memory', () => {
        const gb = new InMemoryGraphBuffer('test');
        // Create many nodes with same label and file path
        for (let i = 0; i < 100; i++) {
            gb.upsertNode('Function', `func${i}`, `test.func${i}`, 'src/module.ts', i, i + 5);
        }

        const nodes = gb.getAllNodes();
        // All nodes should share the same label and filePath references
        const firstLabel = nodes[0].label;
        const firstPath = nodes[0].filePath;
        for (const node of nodes) {
            assert.strictEqual(node.label, firstLabel);
            assert.strictEqual(node.filePath, firstPath);
        }
    });
});