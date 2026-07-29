const Parser = require('tree-sitter');
const Java = require('tree-sitter-java');
const parser = new Parser();
parser.setLanguage(Java);

const code = `class Test { void foo() { Foo f = new Foo(1, 2); HashMap<String,Integer> m = new HashMap<>(); } }`;
const tree = parser.parse(code);

// Simulate extractCallName fallback behavior
function findChildByType(node, ...types) {
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (types.includes(c.type)) return c;
  }
  return null;
}

function extractCallName(node, source) {
  const nameChild = node.childForFieldName('name');
  if (nameChild && (node.type === 'method_invocation' || node.type === 'object_creation_expression')) {
    return source.slice(nameChild.startIndex, nameChild.endIndex);
  }
  const funcChild = node.childForFieldName('function');
  if (funcChild) { return null; /* simplified */ }
  const id = findChildByType(node, 'identifier');
  return id ? source.slice(id.startIndex, id.endIndex) : null;
}

function extractMethodCall(node, source) {
  const nameChild = node.childForFieldName('name');
  if (nameChild && (node.type === 'method_invocation' || node.type === 'object_creation_expression')) {
    return source.slice(nameChild.startIndex, nameChild.endIndex);
  }
  const funcChild = node.childForFieldName('function');
  if (!funcChild) return null;
  return null;
}

function walk(node) {
  if (node.type === 'object_creation_expression') {
    console.log('---');
    console.log('node:', node.text);
    console.log('extractCallName result:', extractCallName(node, code));
    console.log('extractMethodCall result:', extractMethodCall(node, code));
  }
  for (let i = 0; i < node.namedChildCount; i++) walk(node.namedChild(i));
}
walk(tree.rootNode);
