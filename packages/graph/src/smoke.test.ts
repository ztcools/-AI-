/**
 * Smoke tests for the graph module v2.
 * Tests: store CRUD, node/edge operations, search, traversal.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  SqliteGraphStore,
  InMemoryGraphBuffer,
  GraphExtractor,
  GraphTraverser,
  GraphQueryManager,
} from './index';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-test-'));

describe('SqliteGraphStore (v2)', () => {
  const dbPath = path.join(tmpDir, 'test-graph.db');

  it('creates DB and initializes schema', () => {
    const store = new SqliteGraphStore(dbPath);
    const schema = store.getSchema();
    assert.ok(schema.nodeKinds.length >= 0);
    assert.ok(schema.edgeKinds.length >= 0);
    store.close();
  });

  it('upserts and retrieves a node', () => {
    const store = new SqliteGraphStore(dbPath);
    const id = store.upsertNode({
      project: 'test',
      kind: 'function',
      label: 'function',
      name: 'hello',
      qualifiedName: 'src/test.ts::hello',
      filePath: 'src/test.ts',
      language: 'typescript',
      startLine: 10,
      endLine: 15,
      signature: '(name: string): string',
      visibility: 'public',
      isExported: true,
      properties: {},
    });
    assert.ok(id > 0);

    const node = store.getNodeById(id);
    assert.ok(node);
    assert.equal(node!.kind, 'function');
    assert.equal(node!.name, 'hello');
    assert.equal(node!.qualifiedName, 'src/test.ts::hello');
    assert.equal(node!.language, 'typescript');
    assert.equal(node!.signature, '(name: string): string');
    assert.equal(node!.isExported, true);
    store.close();
  });

  it('upserts and retrieves edges', () => {
    const store = new SqliteGraphStore(dbPath);
    store.deleteProject('test');

    const n1 = store.upsertNode({
      project: 'test', kind: 'function', label: 'function',
      name: 'caller', qualifiedName: 'a.ts::caller',
      filePath: 'a.ts', startLine: 1, endLine: 5, properties: {},
    });
    const n2 = store.upsertNode({
      project: 'test', kind: 'function', label: 'function',
      name: 'callee', qualifiedName: 'b.ts::callee',
      filePath: 'b.ts', startLine: 1, endLine: 5, properties: {},
    });

    store.upsertEdge({
      project: 'test', sourceId: n1, targetId: n2,
      kind: 'calls', type: 'calls',
      line: 3, column: 5, provenance: 'tree-sitter',
      properties: {},
    });

    const edges = store.getEdgesBySource(n1);
    assert.equal(edges.length, 1);
    assert.equal(edges[0].kind, 'calls');
    assert.equal(edges[0].line, 3);
    store.close();
  });

  it('search with FTS works', () => {
    const store = new SqliteGraphStore(dbPath);
    store.deleteProject('test');

    store.upsertNode({
      project: 'test', kind: 'function', label: 'function',
      name: 'calculateTotal', qualifiedName: 'src/calc.ts::calculateTotal',
      filePath: 'src/calc.ts', startLine: 1, endLine: 10, properties: {},
    });
    store.upsertNode({
      project: 'test', kind: 'class', label: 'class',
      name: 'OrderProcessor', qualifiedName: 'src/order.ts::OrderProcessor',
      filePath: 'src/order.ts', startLine: 1, endLine: 20, properties: {},
    });

    // Name pattern search
    const nameResult = store.findNodes({ project: 'test', namePattern: 'calculate', limit: 10 });
    assert.ok(nameResult.results.length >= 1, `Name pattern found ${nameResult.results.length} results`);
    assert.equal(nameResult.results[0].node.name, 'calculateTotal');

    // Exact file path search
    const fileResult = store.findNodes({ project: 'test', exactFilePath: 'src/calc.ts', limit: 10 });
    assert.equal(fileResult.results.length, 1);
    assert.equal(fileResult.results[0].node.name, 'calculateTotal');
    store.close();
  });
});

describe('GraphExtractor (v2)', () => {
  it('extracts functions from TypeScript', () => {
    const extractor = new GraphExtractor();
    const source = `
export function hello(name: string): string {
  return "Hello " + name;
}

class Greeter {
  greet() {
    hello("world");
  }
}`;
    const result = extractor.extract(source, {
      project: 'test',
      filePath: 'src/test.ts',
      language: 'typescript',
    });

    assert.ok(result.nodes.length >= 2); // hello + Greeter + greet
    // Check that nodes use lowercase kind
    const funcNode = result.nodes.find(n => n.kind === 'function');
    assert.ok(funcNode);
    assert.equal(funcNode!.name, 'hello');

    // Check unresolved refs exist for call expressions
    assert.ok(result.unresolvedRefs.length >= 1);
    const callRef = result.unresolvedRefs.find(r => r.referenceName === 'hello');
    assert.ok(callRef);
  });

  it('names C++ definitions after the declarator, not the return type', () => {
    // C++ puts the return type before the name, so a generic "first identifier
    // descendant" name lookup picks the type: this whole file used to index as a
    // function called `shared_ptr`, making the real methods unfindable.
    const extractor = new GraphExtractor();
    const source = `
class ThreadPool {
 public:
  explicit ThreadPool(size_t n);
  ~ThreadPool();
  virtual ara::core::Result<void> SyncToStorage() noexcept = 0;
  bool Has(int k) const;
  int count_;
};
std::shared_ptr<ProxyBase> ProxyFactory::CreateProxy(HandleType const &h) { return nullptr; }
char* getBuf(int n);
static int g_flag = 0;
template <typename T> Result<T> Wrap(T v) { return v; }
`;
    const { nodes } = extractor.extract(source, {
      project: 'test',
      filePath: 'src/pool.cpp',
      language: 'cpp',
    });
    // `ThreadPool` is deliberately both a class and a ctor, so index by
    // (name, kind) presence rather than a name→kind map.
    const byName = new Map(
      nodes.filter(n => n.kind !== 'constructor').map(n => [n.name, n.kind]),
    );

    assert.equal(byName.get('CreateProxy'), 'function'); // was `shared_ptr`
    assert.equal(byName.get('Wrap'), 'function'); // templated return type
    assert.equal(byName.get('getBuf'), 'function'); // pointer_declarator wrapper
    assert.equal(byName.get('SyncToStorage'), 'function'); // pure virtual
    assert.equal(byName.get('Has'), 'method'); // in-class declaration
    assert.equal(byName.get('ThreadPool'), 'class');
    assert.equal(byName.get('g_flag'), 'variable'); // file-scope data still data

    // ctor/dtor are told apart by having no return type, and hidden from search
    // results rather than crowding out the class they belong to.
    assert.ok(nodes.some(n => n.name === 'ThreadPool' && n.kind === 'constructor'));
    assert.ok(nodes.some(n => n.name === '~ThreadPool' && n.kind === 'constructor'));

    // Data members carry no query path and are not worth a row.
    assert.ok(!byName.has('count_'));
    // No node is named after a return type.
    for (const t of ['shared_ptr', 'Result', 'ara', 'size_t']) {
      assert.ok(!nodes.some(n => n.name === t && n.kind !== 'module'), `leaked type name: ${t}`);
    }
  });
});

describe('GraphTraverser (v2)', () => {
  it('finds callers and callees', () => {
    const dbPath2 = path.join(tmpDir, 'test-traversal.db');
    const store = new SqliteGraphStore(dbPath2);

    const main = store.upsertNode({
      project: 'test', kind: 'function', label: 'function',
      name: 'main', qualifiedName: 'main.ts::main',
      filePath: 'main.ts', startLine: 1, endLine: 10, properties: {},
    });
    const helper = store.upsertNode({
      project: 'test', kind: 'function', label: 'function',
      name: 'helper', qualifiedName: 'util.ts::helper',
      filePath: 'util.ts', startLine: 1, endLine: 5, properties: {},
    });
    const log = store.upsertNode({
      project: 'test', kind: 'function', label: 'function',
      name: 'log', qualifiedName: 'util.ts::log',
      filePath: 'util.ts', startLine: 6, endLine: 8, properties: {},
    });

    store.upsertEdge({
      project: 'test', sourceId: main, targetId: helper,
      kind: 'calls', type: 'calls', properties: {},
    });
    store.upsertEdge({
      project: 'test', sourceId: helper, targetId: log,
      kind: 'calls', type: 'calls', properties: {},
    });

    const traverser = new GraphTraverser(store);

    const callees = traverser.getCallees(main, 2);
    assert.ok(callees.length >= 2);
    const helperCallee = callees.find(c => c.node.name === 'helper');
    assert.ok(helperCallee);

    const callers = traverser.getCallers(log, 2);
    assert.ok(callers.length >= 1);
    const helperCaller = callers.find(c => c.node.name === 'helper');
    assert.ok(helperCaller);

    store.close();
  });
});

// Cleanup
process.on('exit', () => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});
