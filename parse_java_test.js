const Parser = require('tree-sitter');
const Java = require('tree-sitter-java');

const parser = new Parser();
parser.setLanguage(Java);

const code = `
class Test {
  void foo() {
    HashMap<String, Integer> m = new HashMap<>();
    Foo f = new Foo(1, 2);
    this.getAdapter(c);
    obj.field.method();
  }
}
`;

const tree = parser.parse(code);

function walk(node, depth=0) {
  if (node.type === 'object_creation_expression' || node.type === 'method_invocation') {
    console.log('---');
    console.log('type:', node.type);
    console.log('text:', node.text.slice(0, 80));
    console.log('named fieldNames via children:');
    for (let i = 0; i < node.namedChildCount; i++) {
      const c = node.namedChild(i);
      console.log('  child[' + i + '] type=' + c.type + ' fieldName=' + node.fieldNameForNamedChild(i));
    }
    const nameChild = node.childForFieldName && node.childForFieldName('name');
    const typeChild = node.childForFieldName && node.childForFieldName('type');
    console.log('childForFieldName("name"):', nameChild ? nameChild.text : null);
    console.log('childForFieldName("type"):', typeChild ? typeChild.text : null);
  }
  for (let i = 0; i < node.namedChildCount; i++) {
    walk(node.namedChild(i), depth+1);
  }
}
walk(tree.rootNode);
