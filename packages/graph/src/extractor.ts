/**
 * AST-based graph extractor. Uses tree-sitter to extract structured
 * code information: functions, classes, methods, imports, and calls.
 *
 * Three-pass extraction:
 *   Pass 1: Collect all definitions (nodes + CONTAINS edges) into a registry
 *   Pass 2: Produce UnresolvedReference objects for calls (resolved later)
 *   Pass 3: Collect HTTP routes (structural edges created directly)
 */
import Parser from 'tree-sitter';
import {
  GraphNode,
  GraphNodeLabel,
  GraphNodeKind,
  GraphEdge,
  GraphEdgeType,
  GraphEdgeKind,
  GraphLanguage,
  UnresolvedReference,
  isCallableKind,
} from './types';

// Lazy-load language parsers with fallback — any single parser failure
// won't prevent the module from loading other languages.
// tree-sitter 0.25+ exports {name, language, nodeTypeInfo} wrapper module;
// setLanguage() accepts the wrapper directly (both 0.21.x and 0.25.x paths work).
// TypeScript has two grammars — extract the .typescript sub-grammar.
function loadParser(name: string): any {
  try {
    switch (name) {
      case 'javascript':
        return require('tree-sitter-javascript');
      case 'typescript':
        return require('tree-sitter-typescript').typescript;
      case 'python':
        return require('tree-sitter-python');
      case 'java':
        return require('tree-sitter-java');
      case 'cpp':
        return require('tree-sitter-cpp');
      case 'go':
        return require('tree-sitter-go');
      case 'rust':
        return require('tree-sitter-rust');
      case 'csharp':
        return require('tree-sitter-c-sharp');
      default:
        return null;
    }
  } catch (e: any) {
    console.warn(
      `[GraphExtractor] Failed to load tree-sitter parser for '${name}': ${e.message}`,
    );
    return null;
  }
}

// ── Language configuration ─────────────────────────────────────────

interface LanguageConfig {
  parser: any; // tree-sitter Language (v0.21.x doesn't export Language type)
  nodeTypes: Record<string, GraphNodeKind>;
  importNodeTypes: string[];
  callNodeTypes: string[];
  /** Fields to extract the name from for definitions */
  nameFields?: string[];
  /** Types that are nested definitions (must be parent-aware) */
  nestedDefTypes?: string[];
  /**
   * C/C++ declarator grammar: the name sits at the end of a `declarator` chain,
   * after the return type, and function-vs-data is a property of that chain
   * rather than of the node type. See extractCDeclaratorName.
   */
  declaratorNames?: boolean;
}

const LANGUAGE_CONFIGS: Record<string, LanguageConfig> = {
  javascript: {
    parser: loadParser('javascript'),
    nodeTypes: {
      function_declaration: 'function',
      arrow_function: 'function',
      class_declaration: 'class',
      method_definition: 'method',
      variable_declarator: 'variable',
    },
    importNodeTypes: ['import_statement', 'require_call_expression'],
    callNodeTypes: ['call_expression', 'new_expression'],
    nameFields: ['name'],
    nestedDefTypes: ['method_definition'],
  },
  typescript: {
    parser: loadParser('typescript'),
    nodeTypes: {
      function_declaration: 'function',
      arrow_function: 'function',
      class_declaration: 'class',
      method_definition: 'method',
      interface_declaration: 'interface',
      type_alias_declaration: 'interface',
      variable_declarator: 'variable',
    },
    importNodeTypes: ['import_statement'],
    callNodeTypes: ['call_expression', 'new_expression'],
    nameFields: ['name'],
    nestedDefTypes: ['method_definition'],
  },
  python: {
    parser: loadParser('python'),
    nodeTypes: {
      function_definition: 'function',
      class_definition: 'class',
      decorated_definition: 'function',
      async_function_definition: 'function',
    },
    importNodeTypes: ['import_statement', 'import_from_statement'],
    callNodeTypes: ['call'],
    nameFields: ['name'],
    nestedDefTypes: [],
  },
  java: {
    parser: loadParser('java'),
    nodeTypes: {
      method_declaration: 'method',
      class_declaration: 'class',
      interface_declaration: 'interface',
      constructor_declaration: 'method',
      field_declaration: 'variable',
    },
    importNodeTypes: ['import_declaration'],
    callNodeTypes: ['method_invocation', 'object_creation_expression'],
    nameFields: ['name'],
    nestedDefTypes: ['method_declaration', 'constructor_declaration'],
  },
  cpp: {
    parser: loadParser('cpp'),
    nodeTypes: {
      function_definition: 'function',
      class_specifier: 'class',
      struct_specifier: 'struct',
      namespace_definition: 'module',
      declaration: 'variable',
      // In-class declarations: `bool Has(int) const;` and every non-virtual
      // member API. Without this the declared half of a C++ interface is
      // invisible — refineKind below drops the data members.
      field_declaration: 'variable',
    },
    importNodeTypes: ['preproc_include'],
    callNodeTypes: ['call_expression'],
    nameFields: ['name'],
    nestedDefTypes: [],
    declaratorNames: true,
  },
  go: {
    parser: loadParser('go'),
    nodeTypes: {
      function_declaration: 'function',
      method_declaration: 'method',
      type_declaration: 'class',
      var_declaration: 'variable',
      const_declaration: 'variable',
    },
    importNodeTypes: ['import_declaration'],
    callNodeTypes: ['call_expression'],
    nameFields: ['name'],
    nestedDefTypes: ['method_declaration'],
  },
  rust: {
    parser: loadParser('rust'),
    nodeTypes: {
      function_item: 'function',
      impl_item: 'class',
      struct_item: 'struct',
      enum_item: 'enum',
      trait_item: 'interface',
      mod_item: 'module',
      let_declaration: 'variable',
    },
    importNodeTypes: ['use_declaration'],
    callNodeTypes: ['call_expression'],
    nameFields: ['name'],
    nestedDefTypes: [],
  },
  csharp: {
    parser: loadParser('csharp'),
    nodeTypes: {
      method_declaration: 'method',
      class_declaration: 'class',
      interface_declaration: 'interface',
      struct_declaration: 'struct',
      enum_declaration: 'enum',
      constructor_declaration: 'method',
    },
    importNodeTypes: ['using_directive'],
    callNodeTypes: ['invocation_expression', 'object_creation_expression'],
    nameFields: ['name'],
    nestedDefTypes: ['method_declaration', 'constructor_declaration'],
  },
};

// ── Method-name blacklist ─────────────────────────────────────────────
// These prototype / built-in method names should never generate
// unresolved cross-file references.  Skipping them at the extractor
// level cuts >60 % of noise refs and keeps resolution fast.

/**
 * 类型系统里 `extends` / `implements` 边从一开始就定义了，提取层却从没产出过 ——
 * 于是图里根本没有继承关系，"改这个基类会影响谁"只能答出显式调用它的地方，
 * 所有子类看不见；"这个接口有哪些实现"直接无解。影响面查询在 OO 代码库上因此是漏的。
 *
 * 各语言的父类在 AST 里挂法不同：Python/Java/Rust 是命名 field，
 * JS/TS/C++/C# 是特定子节点类型。两条都走，谁先命中算谁。
 */
const HERITAGE_FIELDS: Partial<Record<GraphLanguage, Array<{ field: string; kind: 'extends' | 'implements' }>>> = {
  python: [{ field: 'superclasses', kind: 'extends' }],
  java: [{ field: 'superclass', kind: 'extends' }, { field: 'interfaces', kind: 'implements' }],
  rust: [{ field: 'trait', kind: 'implements' }],
};

const HERITAGE_TYPES: Partial<Record<GraphLanguage, Array<{ type: string; kind: 'extends' | 'implements' }>>> = {
  javascript: [{ type: 'class_heritage', kind: 'extends' }],
  typescript: [{ type: 'extends_clause', kind: 'extends' }, { type: 'implements_clause', kind: 'implements' }, { type: 'extends_type_clause', kind: 'extends' }],
  cpp: [{ type: 'base_class_clause', kind: 'extends' }],
  csharp: [{ type: 'base_list', kind: 'extends' }],
  scala: [{ type: 'extends_clause', kind: 'extends' }],
};

const HERITAGE_DEF_KINDS = new Set<GraphNodeKind>(['class', 'struct', 'interface', 'trait', 'protocol']);

/** 父类名叶子。`generic_type` 整体取文本后剥掉 `<...>`，所以 `Base<T>` 得到 `Base`。 */
const BASE_TYPE_NODE_TYPES = new Set([
  'identifier', 'type_identifier', 'qualified_identifier', 'scoped_type_identifier',
  'qualified_type', 'generic_type', 'attribute', 'member_expression', 'dotted_name',
  'template_type', 'constrained_type_parameter',
]);

/**
 * heritage 子树里那些不是父类名的东西：C++ 的访问修饰符、Python 的
 * `metaclass=` 关键字实参、以及各语言的通用根类型 —— 把 `object` 当基类记下来，
 * 只会让每个 Python 类都连到同一个节点上，既没信息又污染影响面。
 */
const BASE_TYPE_BLACKLIST = new Set([
  'public', 'private', 'protected', 'virtual', 'internal', 'sealed', 'abstract',
  'object', 'Object', 'metaclass', 'ABC', 'ABCMeta', 'Enum', 'IntEnum', 'StrEnum',
  'Exception', 'BaseException', 'RuntimeError', 'ValueError', 'TypeError',
  'NamedTuple', 'TypedDict', 'Protocol', 'Generic', 'Any',
  'std', 'System', 'T', 'K', 'V', 'E',
]);

function extractBaseTypes(
  node: Parser.SyntaxNode,
  source: string,
  language: GraphLanguage,
): Array<{ name: string; kind: 'extends' | 'implements' }> {
  const out: Array<{ name: string; kind: 'extends' | 'implements' }> = [];
  const seen = new Set<string>();

  const push = (raw: string, kind: 'extends' | 'implements'): void => {
    const bare = raw.replace(/<[\s\S]*$/, '').split(/::|\./).pop()?.trim();
    if (!bare || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(bare)) return;
    if (BASE_TYPE_BLACKLIST.has(bare)) return;
    const key = `${bare}\0${kind}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ name: bare, kind });
  };

  const collect = (container: Parser.SyntaxNode, kind: 'extends' | 'implements', depth = 0): void => {
    if (depth > 3) return;
    for (let i = 0; i < container.namedChildCount; i++) {
      const child = container.namedChild(i);
      if (!child) continue;
      // `class C(Base, metaclass=Meta)` —— 关键字实参不是父类。
      if (child.type === 'keyword_argument' || child.type === 'type_arguments' || child.type === 'type_parameters') continue;
      if (BASE_TYPE_NODE_TYPES.has(child.type)) {
        push(source.slice(child.startIndex, child.endIndex), kind);
        continue;
      }
      collect(child, kind, depth + 1);
    }
  };

  for (const { field, kind } of HERITAGE_FIELDS[language] || []) {
    const container = node.childForFieldName(field);
    if (!container) continue;
    if (BASE_TYPE_NODE_TYPES.has(container.type)) push(source.slice(container.startIndex, container.endIndex), kind);
    else collect(container, kind);
  }

  const byType = HERITAGE_TYPES[language];
  if (byType) {
    // TS 把 extends_clause/implements_clause 包在 class_heritage 里，多下探一层。
    const scopes = [node];
    for (let i = 0; i < node.namedChildCount; i++) {
      const c = node.namedChild(i);
      if (c && c.type === 'class_heritage') scopes.push(c);
    }
    for (const scope of scopes) {
      for (let i = 0; i < scope.namedChildCount; i++) {
        const child = scope.namedChild(i);
        if (!child) continue;
        const hit = byType.find(h => h.type === child.type);
        if (hit) collect(child, hit.kind);
      }
    }
  }

  return out;
}

const METHOD_BLACKLIST = new Set([
  // String.prototype
  'substring', 'substr', 'trim', 'trimStart', 'trimEnd', 'trimLeft', 'trimRight',
  'startsWith', 'endsWith', 'includes', 'indexOf', 'lastIndexOf',
  'toLowerCase', 'toUpperCase', 'toLocaleLowerCase', 'toLocaleUpperCase',
  'charAt', 'charCodeAt', 'codePointAt', 'at',
  'padStart', 'padEnd', 'repeat', 'replace', 'replaceAll',
  'slice', 'split', 'concat', 'match', 'matchAll', 'search',
  'localeCompare', 'normalize',
  // Array.prototype
  'push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse',
  'map', 'filter', 'reduce', 'reduceRight', 'forEach', 'every', 'some',
  'find', 'findIndex', 'findLast', 'findLastIndex',
  'flat', 'flatMap', 'join', 'fill', 'copyWithin',
  'entries', 'keys', 'values',
  // Object.prototype
  'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable',
  'toString', 'valueOf', 'toLocaleString',
  // Number.prototype
  'toFixed', 'toExponential', 'toPrecision',
  // Promise.prototype
  'then', 'catch', 'finally',
  // RegExp.prototype
  'test', 'exec', 'compile',
]);

/**
 * Heuristic to decide whether a method-call name is worth tracking as an
 * unresolved cross-file reference.  Single-word verbs and common property
 * names (add, get, set, queue, nodes, …) are almost always local-variable
 * or prototype calls that will never resolve; tracking them accounts for
 * ~60 % of unresolved refs and the bulk of resolution wall time.
 *
 * Keep: multi-word camelCase / PascalCase identifiers that are more likely
 * to match a real cross-file definition (getNodesById, findFiles, …).
 */
function isLikelyCrossFileReference(name: string): boolean {
  // Already blacklisted prototype/builtin methods — never track
  if (METHOD_BLACKLIST.has(name)) return false;
  // camelCase or PascalCase with an internal capital → almost certainly a real
  // user symbol (toJson, getAdapter, handleHTTPRequest, ServeHTTP). Always track
  // these regardless of length — the earlier length rule was dropping toJson,
  // read, write etc. and silently losing Java/Go call edges.
  if (/[a-z][A-Z]/.test(name) || /^[A-Z][a-z]+[A-Z]/.test(name)) return true;
  // Single-word all-lowercase — usually a local/builtin, but methods in many
  // languages are lowercase (Go write/read, Python helpers). Track if ≥4 chars.
  if (/^[a-z]+$/.test(name)) return name.length >= 4;
  // Single uppercase word (Set, Map, Promise) — built-in
  if (/^[A-Z][a-z]*$/.test(name)) return false;
  return true;
}

// ── Extraction result ──────────────────────────────────────────────

/** Legacy shape — kept for backward compatibility. Newly added unresolvedRefs. */
export interface ExtractionResult {
  nodes: Omit<GraphNode, 'id'>[];
  edges: Omit<GraphEdge, 'id'>[];
  unresolvedRefs: UnresolvedReference[];
}

export interface ExtractionContext {
  project: string;
  filePath: string;
  language: string;
}

// ── Internal: name registry ────────────────────────────────────────

interface NameEntry {
  name: string;
  qualifiedName: string;
  nodeIndex: number;
  /** For imports: the resolved module qualified name */
  importModule?: string;
  /**
   * 同名的那个类/结构体定义。C++ 里构造函数与类同名且在类体内后遍历，
   * `registry.set(name, …)` 后写覆盖，于是查 `ComErrorDomain` 拿到的是它的构造函数 ——
   * 实测 65 条继承边里 49 条的起点因此错成 constructor 节点，反查"ErrorDomain
   * 有哪些子类"得到的是一串构造函数。
   */
  typeNodeIndex?: number;
}

// ── Extractor class ────────────────────────────────────────────────

export class GraphExtractor {
  private parser: Parser;

  constructor() {
    this.parser = new Parser();
  }

  /**
   * Extract graph nodes, edges, and unresolved call references from source code.
   * Three-pass: collect definitions + CONTAINS edges, produce unresolved refs,
   * then collect routes (structural edges).
   * Supports 8 tree-sitter languages + Dockerfile/K8s YAML.
   */
  extract(source: string, ctx: ExtractionContext): ExtractionResult {
    // Infrastructure-as-code: Dockerfile and K8s manifests
    if (ctx.language === 'dockerfile') {
      return this.extractDockerfile(source, ctx);
    }
    if (ctx.language === 'yaml') {
      return this.extractK8sManifest(source, ctx);
    }

    const config = this.getLanguageConfig(ctx.language);
    if (!config) {
      return { nodes: [], edges: [], unresolvedRefs: [] };
    }

    if (!config.parser) {
      console.warn(
        `[GraphExtractor] Parser not available for ${ctx.language}, skipping ${ctx.filePath}`,
      );
      return { nodes: [], edges: [], unresolvedRefs: [] };
    }

    // Try parse with shared parser; retry with fresh instance on WASM memory error
    let tree: Parser.Tree;
    try {
      this.parser.setLanguage(config.parser);
      tree = this.parser.parse(source);
    } catch (parseError: any) {
      // tree-sitter WASM may exhaust memory on large files or under concurrency.
      // A fresh Parser gets a clean WASM heap — retry once before giving up.
      try {
        const freshParser = new Parser();
        freshParser.setLanguage(config.parser);
        tree = freshParser.parse(source);
      } catch (retryError: any) {
        console.warn(
          `[GraphExtractor] Failed to parse ${ctx.filePath} (${(source.length / 1024).toFixed(0)}KB): ${retryError.message}`,
        );
        return { nodes: [], edges: [], unresolvedRefs: [] };
      }
    }

    try {
      const nodes: Omit<GraphNode, 'id'>[] = [];
      const edges: Omit<GraphEdge, 'id'>[] = [];
      const registry = new Map<string, NameEntry>();

      // ── Create file node (index 0) for CONTAINS edges ────────────
      const lang = ctx.language as GraphLanguage;
      const fileQN = `${ctx.project}.file.${ctx.filePath.replace(/\//g, '.').replace(/\.[^.]+$/, '')}`;
      nodes.push({
        project: ctx.project,
        kind: 'file',
        label: 'file' as GraphNodeLabel,
        name: ctx.filePath,
        qualifiedName: fileQN,
        filePath: ctx.filePath,
        language: lang,
        startLine: 1,
        endLine: source.split('\n').length,
        properties: { language: ctx.language, nodeType: 'file' },
      });
      const fileNodeIndex = 0;

      // ── Pass 1: Collect all definitions + CONTAINS edges ─────────
      this.collectDefinitions(
        tree.rootNode,
        source,
        ctx,
        config,
        nodes,
        registry,
        edges,
        lang,
        fileNodeIndex,
      );

      // ── Pass 2: Resolve calls, produce unresolved refs ───────────
      const unresolvedRefs: UnresolvedReference[] = [];
      this.resolveCalls(
        tree.rootNode,
        source,
        ctx,
        config,
        nodes,
        registry,
        unresolvedRefs,
        edges,
        lang,
      );

      // ── Pass 3: Collect HTTP routes (structural edges) ───────────
      this.collectRoutes(tree.rootNode, source, ctx, nodes, registry, edges);

      return { nodes, edges, unresolvedRefs };
    } catch (error) {
      console.debug(
        `[GraphExtractor] Failed to parse ${ctx.filePath}:`,
        error,
      );
      return { nodes: [], edges: [], unresolvedRefs: [] };
    }
  }

  /**
   * Check if a language is supported by the graph extractor.
   */
  isLanguageSupported(language: string): boolean {
    return language in LANGUAGE_CONFIGS;
  }

  /**
   * Get supported languages.
   */
  getSupportedLanguages(): string[] {
    return Object.keys(LANGUAGE_CONFIGS);
  }

  /**
   * Map file extension to language for the extractor.
   */
  static extToLanguage(ext: string): string {
    const map: Record<string, string> = {
      '.js': 'javascript',
      '.jsx': 'javascript',
      '.mjs': 'javascript',
      '.cjs': 'javascript',
      '.ts': 'typescript',
      '.tsx': 'typescript',
      '.py': 'python',
      '.java': 'java',
      '.cpp': 'cpp',
      '.c': 'cpp',
      '.h': 'cpp',
      '.hpp': 'cpp',
      '.hh': 'cpp',
      '.cc': 'cpp',
      '.cxx': 'cpp',
      '.hxx': 'cpp',
      '.inl': 'cpp',
      '.go': 'go',
      '.rs': 'rust',
      '.cs': 'csharp',
      '.yaml': 'yaml',
      '.yml': 'yaml',
    };
    // Dockerfile has no extension, detected by filename
    return map[ext] || '';
  }

  /**
   * Check if a filename is a Dockerfile (case-insensitive).
   */
  static isDockerfile(filename: string): boolean {
    const base = filename.split('/').pop()?.toLowerCase() || '';
    return base === 'dockerfile' || base.startsWith('dockerfile.');
  }

  // ── Private: Pass 1 - Collect definitions + CONTAINS edges ───────

  private getLanguageConfig(language: string): LanguageConfig | null {
    const config = LANGUAGE_CONFIGS[language];
    if (!config || !config.parser) return null;
    return config;
  }

  private collectDefinitions(
    node: Parser.SyntaxNode,
    source: string,
    ctx: ExtractionContext,
    config: LanguageConfig,
    nodes: Omit<GraphNode, 'id'>[],
    registry: Map<string, NameEntry>,
    edges: Omit<GraphEdge, 'id'>[],
    language: GraphLanguage,
    parentNodeIndex?: number,
  ): void {
    const nodeKind = this.resolveKind(node, source, config);

    if (nodeKind) {
      const name = this.extractName(node, source, config);
      if (name) {
        const startLine = node.startPosition.row + 1;
        const endLine = node.endPosition.row + 1;
        const startCol = node.startPosition.column + 1;

        // Build qualified name: include parent for nested definitions
        let displayName: string;
        let qualifiedName: string;
        if (parentNodeIndex !== undefined &&
            parentNodeIndex !== 0 && // file node doesn't count as a naming parent
            config.nestedDefTypes?.includes(node.type)) {
          const parentNode = nodes[parentNodeIndex];
          displayName = `${parentNode!.name}.${name}`;
          qualifiedName = `${ctx.project}.${ctx.filePath.replace(/\//g, '.').replace(/\.[^.]+$/, '')}.${displayName}`;
        } else {
          displayName = name;
          qualifiedName = `${ctx.project}.${ctx.filePath.replace(/\//g, '.').replace(/\.[^.]+$/, '')}.${name}`;
        }

        const nodeIndex = nodes.length;

        // Extract signature for functions/methods
        const signature =
          isCallableKind(nodeKind)
            ? this.extractSignature(node, source, ctx.language)
            : undefined;

        // Extract visibility for class methods
        const visibility =
          isCallableKind(nodeKind) || nodeKind === 'class'
            ? this.extractVisibility(node, source, ctx.language)
            : undefined;

        // Detect export: walk up parent chain (max 3 levels) to find export_statement
        let isExported = node.type.startsWith('export_');
        if (!isExported) {
          let p: any = node;
          for (let i = 0; i < 3 && p; i++) {
            p = p.parent;
            if (p && p.type === 'export_statement') { isExported = true; break; }
          }
        }

        nodes.push({
          project: ctx.project,
          kind: nodeKind,
          label: nodeKind as GraphNodeLabel,
          name: displayName,
          qualifiedName,
          filePath: ctx.filePath,
          language,
          startLine,
          endLine,
          signature,
          visibility,
          isExported,
          properties: {
            language: ctx.language,
            nodeType: node.type,
            isExported,
          },
        });

        // Register the name for call resolution
        const prevEntry = registry.get(name);
        registry.set(name, {
          name, qualifiedName, nodeIndex,
          typeNodeIndex: HERITAGE_DEF_KINDS.has(nodeKind) ? nodeIndex : prevEntry?.typeNodeIndex,
        });

        // Create CONTAINS edge: parent → this node
        if (parentNodeIndex !== undefined) {
          edges.push({
            project: ctx.project,
            sourceId: parentNodeIndex,
            targetId: nodeIndex,
            kind: 'contains',
            type: 'contains' as GraphEdgeType,
            line: startLine,
            column: startCol,
            provenance: 'tree-sitter',
            properties: {},
          });
        }

        // If this is a class/struct/interface, recurse for nested methods
        if (
          nodeKind === 'class' ||
          nodeKind === 'struct' ||
          nodeKind === 'interface'
        ) {
          for (let i = 0; i < node.childCount; i++) {
            this.collectDefinitions(
              node.child(i)!,
              source,
              ctx,
              config,
              nodes,
              registry,
              edges,
              language,
              nodeIndex,
            );
          }
          return; // Don't recurse again below
        }
      }
    }

    // Handle imports
    if (config.importNodeTypes.includes(node.type)) {
      this.collectImport(node, source, ctx, config, nodes, registry, edges);
    }

    // Recurse into children (skip if already handled by class recursion)
    if (
      !(
        nodeKind === 'class' ||
        nodeKind === 'struct' ||
        nodeKind === 'interface'
      )
    ) {
      for (let i = 0; i < node.childCount; i++) {
        this.collectDefinitions(
          node.child(i)!,
          source,
          ctx,
          config,
          nodes,
          registry,
          edges,
          language,
          parentNodeIndex,
        );
      }
    }
  }

  private collectImport(
    node: Parser.SyntaxNode,
    source: string,
    _ctx: ExtractionContext,
    config: LanguageConfig,
    nodes: Omit<GraphNode, 'id'>[],
    registry: Map<string, NameEntry>,
    edges: Omit<GraphEdge, 'id'>[],
  ): void {
    // Extract imported names and their module paths
    const imports = this.extractImportNames(node, source, config);
    const startLine = node.startPosition.row + 1;
    const startCol = node.startPosition.column + 1;

    for (const imp of imports) {
      // Register imported name so calls can resolve to it
      const moduleQN = imp.modulePath;
      if (!registry.has(imp.name)) {
        // We don't have the target node yet, but we record the import reference
        // The actual resolution happens at graph-build time (cross-file)
        const nodeIndex = nodes.length;
        nodes.push({
          project: _ctx.project,
          kind: 'import',
          label: 'import' as GraphNodeLabel,
          name: imp.modulePath,
          qualifiedName: moduleQN,
          filePath: _ctx.filePath,
          language: _ctx.language as GraphLanguage,
          startLine,
          endLine: node.endPosition.row + 1,
          properties: {
            importedName: imp.name,
            importPath: imp.modulePath,
            language: _ctx.language,
            nodeType: node.type,
          },
        });
        registry.set(imp.name, {
          name: imp.name,
          qualifiedName: moduleQN,
          nodeIndex,
          importModule: moduleQN,
        });

        // Create IMPORTS edge from file to import module node
        edges.push({
          project: _ctx.project,
          sourceId: 0, // file node
          targetId: nodeIndex,
          kind: 'imports',
          type: 'imports' as GraphEdgeType,
          line: startLine,
          column: startCol,
          provenance: 'tree-sitter',
          properties: { importPath: imp.modulePath },
        });
      }
    }
  }

  private extractImportNames(
    node: Parser.SyntaxNode,
    source: string,
    config: LanguageConfig,
  ): Array<{ name: string; modulePath: string }> {
    const results: Array<{ name: string; modulePath: string }> = [];

    // Extract the module path (string literal)
    const modulePath = this.extractImportPath(node, source);

    if (!modulePath) return results;

    // For JS/TS: import { foo, bar } from './module'
    const specifiers = this.findChildrenByType(node, 'import_specifier');
    for (const spec of specifiers) {
      const nameNode = this.findChildByType(spec, 'identifier');
      if (nameNode) {
        results.push({
          name: source.slice(nameNode.startIndex, nameNode.endIndex),
          modulePath,
        });
      }
    }

    // For JS/TS: import * as namespace from './module'
    const namespace = this.findChildByType(node, 'namespace_import');
    if (namespace) {
      const nameNode = this.findChildByType(namespace, 'identifier');
      if (nameNode) {
        results.push({
          name: source.slice(nameNode.startIndex, nameNode.endIndex),
          modulePath,
        });
      }
    }

    // For Python: import foo, bar
    if (modulePath && results.length === 0) {
      const dottedNames = this.findChildrenByType(node, 'dotted_name');
      for (const dn of dottedNames) {
        const name = source.slice(dn.startIndex, dn.endIndex);
        results.push({ name, modulePath: name });
      }
      // Python: from module import foo, bar
      const aliasedImports = this.findChildrenByType(node, 'aliased_import');
      for (const ai of aliasedImports) {
        const nameNode = this.findChildByType(
          ai,
          'identifier',
          'dotted_name',
        );
        if (nameNode) {
          results.push({
            name: source.slice(nameNode.startIndex, nameNode.endIndex),
            modulePath: `${modulePath}.${source.slice(nameNode.startIndex, nameNode.endIndex)}`,
          });
        }
      }
    }

    // For Rust: use crate::foo::bar;
    // For Java: import java.util.List;
    if (results.length === 0 && modulePath) {
      const parts = modulePath.split(/[.:]/);
      const lastName = parts[parts.length - 1];
      if (lastName) {
        results.push({ name: lastName, modulePath });
      }
    }

    return results;
  }

  // ── Private: Pass 2 - Resolve calls → UnresolvedReference[] ─────

  private resolveCalls(
    node: Parser.SyntaxNode,
    source: string,
    ctx: ExtractionContext,
    config: LanguageConfig,
    nodes: Omit<GraphNode, 'id'>[],
    registry: Map<string, NameEntry>,
    unresolvedRefs: UnresolvedReference[],
    edges: Omit<GraphEdge, 'id'>[],
    language: GraphLanguage,
    parentDefIdx?: number,
  ): void {
    const nodeKind = this.resolveKind(node, source, config);

    // Track current parent definition for scoping calls.
    // Only function/method/class nodes create scope — variable declarations
    // (e.g. const sum = add(x,y)) must NOT shadow the parent scope.
    let currentDefIdx: number | undefined = parentDefIdx;

    if (nodeKind) {
      const name = this.extractName(node, source, config);
      if (name) {
        const entry = registry.get(name);
        if (entry && (isCallableKind(nodeKind) || nodeKind === 'class')) {
          currentDefIdx = entry.nodeIndex;
        }
      }
    }

    // 继承/实现：父类名要跨文件解析，所以走 unresolvedRef 而不是直接建边。
    // 起点取 typeNodeIndex 而不是 currentDefIdx —— 见 NameEntry.typeNodeIndex。
    const heritageFrom = nodeKind && HERITAGE_DEF_KINDS.has(nodeKind)
      ? (registry.get(this.extractName(node, source, config) || '')?.typeNodeIndex ?? currentDefIdx)
      : undefined;
    if (heritageFrom !== undefined) {
      for (const base of extractBaseTypes(node, source, language)) {
        unresolvedRefs.push({
          fromNodeId: heritageFrom,
          referenceName: base.name,
          referenceKind: base.kind as GraphEdgeKind,
          line: node.startPosition.row + 1,
          column: node.startPosition.column + 1,
          filePath: ctx.filePath,
          language,
        });
      }
    }

    // Check if this is a call expression
    if (config.callNodeTypes.includes(node.type) && currentDefIdx !== undefined) {
      const callLine = node.startPosition.row + 1;
      const callCol = node.startPosition.column + 1;

      // Direct calls
      const callName = this.extractCallName(node, source, config);
      if (callName) {
        const entry = registry.get(callName);
        if (entry) {
          // Overloads share one registry name (toJson ×8). If the single registry
          // entry happens to be THIS definition, we'd skip the call entirely and
          // lose the edge to the sibling overload. Emit a ref unless the entry is
          // a DIFFERENT node we already handle below — the resolver's name-matcher
          // will pick the right overload.
          const isSelf = entry.nodeIndex === currentDefIdx;
          if (!isSelf && entry.importModule) {
            // Imported function call: keep the IMPORTS edge, AND also produce
            // an unresolved ref so the reference resolver can create a CALLS
            // edge to the actual target function in the imported file.
            edges.push({
              project: ctx.project,
              sourceId: currentDefIdx,
              targetId: entry.nodeIndex,
              kind: 'imports',
              type: 'imports' as GraphEdgeType,
              line: callLine,
              column: callCol,
              provenance: 'tree-sitter',
              properties: { importModule: entry.importModule },
            });
          }
          // Always create unresolved reference for cross-file/overload resolution
          unresolvedRefs.push({
            fromNodeId: currentDefIdx,
            referenceName: callName,
            referenceKind: 'calls' as GraphEdgeKind,
            line: callLine,
            column: callCol,
            filePath: ctx.filePath,
            language,
          });
        } else if (isLikelyCrossFileReference(callName)) {
          // Call to something not in this file — only track if likely cross-file
          unresolvedRefs.push({
            fromNodeId: currentDefIdx,
            referenceName: callName,
            referenceKind: 'calls' as GraphEdgeKind,
            line: callLine,
            column: callCol,
            filePath: ctx.filePath,
            language,
          });
        }
      }

      // Handle method calls (obj.method())
      const methodCall = this.extractMethodCall(node, source, config);
      if (methodCall && currentDefIdx !== undefined && !METHOD_BLACKLIST.has(methodCall)) {
        const entry = registry.get(methodCall);
        if (entry) {
          if (entry.importModule) {
            // Imported method call → IMPORTS edge
            if (entry.nodeIndex !== currentDefIdx) {
              edges.push({
                project: ctx.project,
                sourceId: currentDefIdx,
                targetId: entry.nodeIndex,
                kind: 'imports',
                type: 'imports' as GraphEdgeType,
                line: callLine,
                column: callCol,
                provenance: 'tree-sitter',
                properties: { callType: 'method', importModule: entry.importModule },
              });
            }
          } else if (entry.nodeIndex !== currentDefIdx) {
            // Method call matching a local symbol → unresolved reference
            unresolvedRefs.push({
              fromNodeId: currentDefIdx,
              referenceName: methodCall,
              referenceKind: 'calls' as GraphEdgeKind,
              line: callLine,
              column: callCol,
              filePath: ctx.filePath,
              language,
            });
          }
        } else if (isLikelyCrossFileReference(methodCall)) {
          // Method call not in local registry. Only track as unresolved ref
          // if the name looks like a real cross-file candidate.
          unresolvedRefs.push({
            fromNodeId: currentDefIdx,
            referenceName: methodCall,
            referenceKind: 'calls' as GraphEdgeKind,
            line: callLine,
            column: callCol,
            filePath: ctx.filePath,
            language,
          });
        }
      }
    }

    // Recurse into children
    for (let i = 0; i < node.childCount; i++) {
      this.resolveCalls(
        node.child(i)!,
        source,
        ctx,
        config,
        nodes,
        registry,
        unresolvedRefs,
        edges,
        language,
        currentDefIdx,
      );
    }
  }

  // ── Private: Name extraction helpers ───────────────────────────

  /**
   * Name of a C/C++ declaration, read off the end of its `declarator` chain.
   *
   * C++ writes the return type *before* the name, so extractName's generic
   * "first identifier descendant" fallback picks up the type instead:
   * `std::shared_ptr<ProxyBase> ProxyFactory::CreateProxy(...)` was indexed as a
   * function literally named `shared_ptr`. Measured on a 1.3k-file AUTOSAR repo,
   * that turned the C++ half of the graph into type names (`basic_string`,
   * `unique_ptr`, `bool`, `size_t` were among the most common "functions") and
   * left the real methods unreachable by both search and the call graph.
   *
   * Every declaration shape — out-of-line definition, prototype, member, pure
   * virtual, method on a template, destructor, operator — nests the name at the
   * bottom of `declarator`, under pointer/reference/array/parenthesized/init
   * wrappers. Walk to that leaf. Whether the walk passed through a
   * `function_declarator` is also the only thing that distinguishes a function
   * from data: `char* buf;` and `char* getBuf(int);` are both `declaration`.
   */
  private extractCDeclaratorName(
    node: Parser.SyntaxNode,
    source: string,
  ): { name: string; isFunction: boolean } | null {
    let cur: Parser.SyntaxNode | null =
      node.childForFieldName?.('declarator') ?? null;
    let isFunction = false;
    // Declarator nesting is shallow in real code; the cap only guards against a
    // cycle in a malformed tree.
    for (let depth = 0; cur && depth < 16; depth++) {
      switch (cur.type) {
        case 'function_declarator':
          isFunction = true;
          cur = cur.childForFieldName?.('declarator') ?? null;
          break;
        case 'pointer_declarator':
        case 'reference_declarator':
        case 'array_declarator':
        case 'parenthesized_declarator':
        case 'init_declarator':
        case 'attributed_declarator':
          // reference/parenthesized declarators carry no `declarator` field.
          cur = cur.childForFieldName?.('declarator') ?? cur.namedChild(0);
          break;
        case 'qualified_identifier': // ProxyFactory::CreateProxy, ara::core::X
        case 'template_function': // Wrap<T>(...)
        case 'template_type':
          cur = cur.childForFieldName?.('name') ?? null;
          break;
        case 'identifier':
        case 'field_identifier':
        case 'type_identifier':
        case 'destructor_name': // ~Foo
        case 'operator_name': // operator==
          return {
            name: source.slice(cur.startIndex, cur.endIndex),
            isFunction,
          };
        default:
          // structured_binding_declarator (auto [a,b]) and anything else with no
          // single name: nothing useful to index.
          return null;
      }
    }
    return null;
  }

  /**
   * Node kind, refined by grammar shape where the node type alone is ambiguous.
   * Returning undefined skips the definition (children are still visited).
   */
  private resolveKind(
    node: Parser.SyntaxNode,
    source: string,
    config: LanguageConfig,
  ): GraphNodeKind | undefined {
    const kind = config.nodeTypes[node.type];
    if (!kind || !config.declaratorNames) return kind;

    // C++ constructors and destructors have no return type at all, which is
    // exactly what distinguishes them: `ThreadPool(size_t)` vs `void Run()`.
    // Naming them after the declarator (correct) makes every class match its own
    // ctors, so a search for `ThreadPool` returned the class plus three
    // `function ThreadPool` rows. buildNodeResults already drops `constructor`.
    if (!node.childForFieldName?.('type')) {
      const ctor = this.extractCDeclaratorName(node, source);
      if (ctor?.isFunction) return 'constructor';
    }

    if (node.type !== 'declaration' && node.type !== 'field_declaration') {
      return kind;
    }
    const decl = this.extractCDeclaratorName(node, source);
    if (!decl) return undefined;
    if (decl.isFunction) {
      return node.type === 'field_declaration' ? 'method' : 'function';
    }
    // Data members: `variable` is filtered out by buildNodeResults and by
    // GraphTraverser.isNoise alike, so indexing every struct field only costs
    // rows. File-scope globals keep their existing behaviour.
    return node.type === 'field_declaration' ? undefined : kind;
  }

  private extractName(
    node: Parser.SyntaxNode,
    source: string,
    config: LanguageConfig,
  ): string | null {
    if (config.declaratorNames) {
      const decl = this.extractCDeclaratorName(node, source);
      if (decl) return decl.name;
      // class/struct/namespace have a `name` field and no declarator — fall
      // through to the generic path below.
    }
    // Try named fields first
    if (config.nameFields) {
      for (const field of config.nameFields) {
        const child = node.childForFieldName?.(field);
        if (child) {
          return source.slice(child.startIndex, child.endIndex);
        }
      }
    }
    // Fallback: find identifier child
    const nameChild = this.findChildByType(
      node,
      'identifier',
      'property_identifier',
      'type_identifier',
    );
    if (nameChild) {
      return source.slice(nameChild.startIndex, nameChild.endIndex);
    }
    return null;
  }

  private extractCallName(
    node: Parser.SyntaxNode,
    source: string,
    _config: LanguageConfig,
  ): string | null {
    // Java: method_invocation / object_creation_expression expose the callee in a
    // `name` field (no `function` field) — prefer it over the identifier fallback.
    const nameChild = node.childForFieldName?.('name');
    if (nameChild && (node.type === 'method_invocation' || node.type === 'object_creation_expression')) {
      return source.slice(nameChild.startIndex, nameChild.endIndex);
    }

    // Try 'function' field first
    const funcChild = node.childForFieldName?.('function');
    if (funcChild) {
      // For simple calls: just the identifier
      if (funcChild.type === 'identifier') {
        return source.slice(funcChild.startIndex, funcChild.endIndex);
      }
      // For member expressions: prefer the method/property name.
      // tree-sitter 0.25: children are 'this'/'super'/'property_identifier',
      // not plain 'identifier'. Search property_identifier first.
      const propId = this.findChildByType(funcChild, 'property_identifier');
      if (propId) {
        return source.slice(propId.startIndex, propId.endIndex);
      }
      const id = this.findChildByType(funcChild, 'identifier');
      if (id) {
        return source.slice(id.startIndex, id.endIndex);
      }
      return null;
    }

    // Fallback: no function field — search for first identifier child
    // (handles languages where call_expression has no named 'function' field)
    const id = this.findChildByType(node, 'identifier');
    return id ? source.slice(id.startIndex, id.endIndex) : null;
  }

  private extractMethodCall(
    node: Parser.SyntaxNode,
    source: string,
    config: LanguageConfig,
  ): string | null {
    // Java: method_invocation carries the callee in a `name` field (no `function`
    // field). `this.getAdapter(c)` / `obj.write(w)` / `toJson(s,t)` all expose
    // `name` — use it directly.
    const nameChild = node.childForFieldName?.('name');
    if (nameChild && (node.type === 'method_invocation' || node.type === 'object_creation_expression')) {
      return source.slice(nameChild.startIndex, nameChild.endIndex);
    }

    const funcChild = node.childForFieldName?.('function');
    if (!funcChild) return null;

    // JS/TS / Java / C# etc.: call's function is a member_expression → take its property.
    if (funcChild.type === 'member_expression') {
      const property = funcChild.childForFieldName?.('property');
      if (property) {
        return source.slice(property.startIndex, property.endIndex);
      }
    }

    // Python (`attribute`: self.x), Go (`selector_expression`: e.x),
    // C/C++ (`field_expression`: ptr->x), C++/Java (`scoped_identifier`) —
    // all "receiver.method" shapes. Take the method name: the explicit
    // attribute/field/name field, else the last identifier-ish child.
    if (
      funcChild.type === 'attribute' ||
      funcChild.type === 'selector_expression' ||
      funcChild.type === 'field_expression' ||
      funcChild.type === 'scoped_identifier' ||
      funcChild.type === 'qualified_identifier' // C++ ns::method
    ) {
      const attrField =
        funcChild.childForFieldName?.('attribute') ||
        funcChild.childForFieldName?.('field') ||
        funcChild.childForFieldName?.('name');
      if (attrField) {
        return source.slice(attrField.startIndex, attrField.endIndex);
      }
      // Fallback: last identifier-ish child of the receiver.method node.
      for (let i = funcChild.childCount - 1; i >= 0; i--) {
        const c = funcChild.child(i)!;
        if (c.type === 'identifier' || c.type === 'property_identifier' || c.type === 'field_identifier') {
          return source.slice(c.startIndex, c.endIndex);
        }
      }
    }
    return null;
  }

  private extractImportPath(
    node: Parser.SyntaxNode,
    source: string,
  ): string | null {
    // Find the string literal containing the import path
    const stringChild = this.findChildByType(
      node,
      'string',
      'string_fragment',
      'string_literal',
    );
    if (stringChild) {
      const raw = source.slice(stringChild.startIndex, stringChild.endIndex);
      return raw.replace(/^['"]|['"]$/g, '');
    }
    return null;
  }

  // ── Signature extraction ────────────────────────────────────────

  /**
   * Extract a basic function/method signature from the parameters subtree.
   * Returns something like "(a: number, b: string): void" or just "(a, b)".
   */
  private extractSignature(
    node: Parser.SyntaxNode,
    source: string,
    language: string,
  ): string | undefined {
    // Look for parameters/arguments child by common tree-sitter field names
    const paramFieldNames = [
      'parameters',
      'formal_parameters',
      'type_parameters',
    ];
    for (const fieldName of paramFieldNames) {
      const paramsNode = node.childForFieldName?.(fieldName);
      if (paramsNode) {
        return source.slice(paramsNode.startIndex, paramsNode.endIndex);
      }
    }
    return undefined;
  }

  // ── Visibility extraction ───────────────────────────────────────

  /**
   * Detect visibility modifiers (public/private/protected) from keywords
   * preceding the definition node. Checks siblings at the same level or
   * keyword tokens in the node's own children.
   */
  private extractVisibility(
    node: Parser.SyntaxNode,
    source: string,
    language: string,
  ): 'public' | 'private' | 'protected' | 'internal' | undefined {
    const textBefore = source.slice(
      Math.max(0, node.startIndex - 40),
      node.startIndex,
    );

    // Check for access modifier keywords in preceding text (Java, C#, C++, TypeScript)
    if (/\bprivate\b/.test(textBefore)) return 'private';
    if (/\bprotected\b/.test(textBefore)) return 'protected';
    if (/\bpublic\b/.test(textBefore)) return 'public';
    if (/\binternal\b/.test(textBefore)) return 'internal';

    // Check children for modifier nodes (some parsers have dedicated nodes)
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i)!;
      if (
        child.type === 'access_modifier' ||
        child.type === 'modifier' ||
        child.type === 'visibility_modifier' ||
        child.type === 'access_specifier'
      ) {
        const modText = source
          .slice(child.startIndex, child.endIndex)
          .toLowerCase();
        if (modText === 'private') return 'private';
        if (modText === 'protected') return 'protected';
        if (modText === 'public') return 'public';
        if (modText === 'internal') return 'internal';
      }
    }

    return undefined;
  }

  // ── Infrastructure-as-code extraction ────────────────────────────

  /**
   * Extract Dockerfile instructions as graph nodes.
   * FROM, RUN, COPY, ENV, EXPOSE, CMD, ENTRYPOINT, etc.
   */
  private extractDockerfile(
    source: string,
    ctx: ExtractionContext,
  ): ExtractionResult {
    const nodes: Omit<GraphNode, 'id'>[] = [];
    const edges: Omit<GraphEdge, 'id'>[] = [];
    const lines = source.split('\n');
    let prevNodeIdx = -1;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!.trim();
      if (!line || line.startsWith('#')) continue;

      const match = line.match(/^(\w+)\s+(.+)/);
      if (!match) continue;

      const [, instruction, args] = match;
      const instr = instruction!.toUpperCase();
      const nodeIdx = nodes.length;

      nodes.push({
        project: ctx.project,
        kind: 'resource' as GraphNodeKind,
        label: 'resource' as GraphNodeLabel,
        name: `${instr} ${args!.substring(0, 60)}`,
        qualifiedName: `${ctx.project}.dockerfile.${ctx.filePath}.L${i + 1}.${instr}`,
        filePath: ctx.filePath,
        language: 'dockerfile' as GraphLanguage,
        startLine: i + 1,
        endLine: i + 1,
        properties: {
          instruction: instr,
          args: args,
          language: 'dockerfile',
          baseImage: instr === 'FROM' ? args!.split(':')[0] : undefined,
          port: instr === 'EXPOSE' ? args : undefined,
          envVar: instr === 'ENV' ? args!.split('=')[0] : undefined,
        },
      });

      // Link sequential instructions
      if (prevNodeIdx >= 0) {
        edges.push({
          project: ctx.project,
          sourceId: prevNodeIdx,
          targetId: nodeIdx,
          kind: 'references' as GraphEdgeKind,
          type: 'references' as GraphEdgeType,
          line: i + 1,
          column: 1,
          provenance: 'tree-sitter',
          properties: { order: i },
        });
      }
      prevNodeIdx = nodeIdx;
    }

    return { nodes, edges, unresolvedRefs: [] };
  }

  /**
   * Extract Kubernetes manifest resources as graph nodes.
   * Detects Deployments, Services, ConfigMaps, etc.
   */
  private extractK8sManifest(
    source: string,
    ctx: ExtractionContext,
  ): ExtractionResult {
    const nodes: Omit<GraphNode, 'id'>[] = [];
    const edges: Omit<GraphEdge, 'id'>[] = [];

    // Simple line-based K8s manifest parser
    const lines = source.split('\n');
    let currentKind = '';
    let currentName = '';
    let currentNamespace = '';
    let inMetadata = false;
    let kindStartLine = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const trimmed = line.trim();

      // Detect kind
      const kindMatch = trimmed.match(/^kind:\s+(.+)/i);
      if (kindMatch) {
        currentKind = kindMatch[1]!.trim();
        kindStartLine = i + 1;
        inMetadata = false;
        currentName = '';
        currentNamespace = 'default';
        continue;
      }

      // Detect metadata section
      if (trimmed === 'metadata:' && currentKind) {
        inMetadata = true;
        continue;
      }

      // In metadata: extract name
      if (inMetadata && trimmed.startsWith('name:')) {
        currentName = trimmed.replace(/^name:\s*/, '').trim();
        // Remove quotes
        currentName = currentName.replace(/^['"]|['"]$/g, '');
      }

      // In metadata: extract namespace
      if (inMetadata && trimmed.startsWith('namespace:')) {
        currentNamespace = trimmed
          .replace(/^namespace:\s*/, '')
          .trim();
        currentNamespace = currentNamespace.replace(/^['"]|['"]$/g, '');
      }

      // End of metadata section
      if (
        inMetadata &&
        !trimmed.startsWith(' ') &&
        !trimmed.startsWith('name:') &&
        !trimmed.startsWith('namespace:') &&
        !trimmed.startsWith('labels:') &&
        !trimmed.startsWith('annotations:')
      ) {
        inMetadata = false;
      }

      // End of a resource (--- or next document)
      if (
        (trimmed === '---' || i === lines.length - 1) &&
        currentKind &&
        currentName
      ) {
        const qn = `${ctx.project}.k8s.${currentNamespace}.${currentKind}.${currentName}`;
        nodes.push({
          project: ctx.project,
          kind: 'resource' as GraphNodeKind,
          label: 'resource' as GraphNodeLabel,
          name: `${currentKind}/${currentName}`,
          qualifiedName: qn,
          filePath: ctx.filePath,
          language: 'yaml' as GraphLanguage,
          startLine: kindStartLine,
          endLine: i + 1,
          properties: {
            kind: currentKind,
            name: currentName,
            namespace: currentNamespace,
            language: 'yaml',
            manifestType: 'kubernetes',
          },
        });

        currentKind = '';
        currentName = '';
      }
    }

    return { nodes, edges, unresolvedRefs: [] };
  }

  // ── Private: Route extraction ───────────────────────────────────

  /**
   * Pass 3: Collect HTTP route definitions from source code.
   * Detects common patterns: Express, FastAPI, Flask, Spring, Gin, ASP.NET, etc.
   */
  private collectRoutes(
    node: Parser.SyntaxNode,
    source: string,
    ctx: ExtractionContext,
    nodes: Omit<GraphNode, 'id'>[],
    registry: Map<string, NameEntry>,
    edges: Omit<GraphEdge, 'id'>[],
  ): void {
    const routeInfo = this.tryExtractRoute(node, source, ctx.language);
    if (routeInfo) {
      const { method, path: routePath, handlerName } = routeInfo;
      const routeQN = `${ctx.project}.route.${ctx.filePath.replace(/\//g, '.')}.${method}:${routePath}`;
      const routeIdx = nodes.length;
      const routeLine = node.startPosition.row + 1;
      const routeCol = node.startPosition.column + 1;
      nodes.push({
        project: ctx.project,
        kind: 'route',
        label: 'route' as GraphNodeLabel,
        name: `${method} ${routePath}`,
        qualifiedName: routeQN,
        filePath: ctx.filePath,
        language: ctx.language as GraphLanguage,
        startLine: routeLine,
        endLine: node.endPosition.row + 1,
        properties: {
          method,
          path: routePath,
          handlerName,
          language: ctx.language,
        },
      });

      // Link route to handler function if found in registry
      if (handlerName) {
        const entry = registry.get(handlerName);
        if (entry) {
          edges.push({
            project: ctx.project,
            sourceId: routeIdx,
            targetId: entry.nodeIndex,
            kind: 'references' as GraphEdgeKind,
            type: 'references' as GraphEdgeType,
            line: routeLine,
            column: routeCol,
            provenance: 'tree-sitter',
            properties: { method, path: routePath },
          });
        }
      }
      return;
    }

    // Recurse into children
    for (let i = 0; i < node.childCount; i++) {
      this.collectRoutes(
        node.child(i)!,
        source,
        ctx,
        nodes,
        registry,
        edges,
      );
    }
  }

  /**
   * Try to extract an HTTP route definition from a node.
   * Returns { method, path, handlerName } or null.
   */
  private tryExtractRoute(
    node: Parser.SyntaxNode,
    source: string,
    language: string,
  ): { method: string; path: string; handlerName: string } | null {
    switch (language) {
      case 'javascript':
      case 'typescript':
        return this.tryExtractJsTsRoute(node, source);
      case 'python':
        return this.tryExtractPythonRoute(node, source);
      case 'java':
        return this.tryExtractJavaRoute(node, source);
      case 'go':
        return this.tryExtractGoRoute(node, source);
      case 'csharp':
        return this.tryExtractCSharpRoute(node, source);
      default:
        return null;
    }
  }

  // ── JS/TS route detection ──────────────────────────────────
  private tryExtractJsTsRoute(
    node: Parser.SyntaxNode,
    source: string,
  ): { method: string; path: string; handlerName: string } | null {
    // Pattern: app.get('/path', handler) or router.post('/path', handler)
    if (node.type === 'call_expression') {
      const funcNode = node.childForFieldName?.('function');
      if (funcNode?.type === 'member_expression') {
        const obj = funcNode.childForFieldName?.('object');
        const prop = funcNode.childForFieldName?.('property');
        if (obj && prop) {
          const methodName = source.slice(prop.startIndex, prop.endIndex);
          const knownMethods = [
            'get', 'post', 'put', 'delete', 'patch',
            'head', 'options', 'all', 'use',
          ];
          if (knownMethods.includes(methodName.toLowerCase())) {
            const args = this.findChildrenByType(node, 'arguments');
            const argNodes =
              args.length > 0 ? this.getDirectChildren(args[0]!) : [];
            // First argument should be the path string
            if (argNodes.length >= 1) {
              const pathNode = argNodes[0]!;
              const routePath = this.extractStringValue(pathNode, source);
              if (routePath) {
                let handlerName = '';
                if (argNodes.length >= 2) {
                  handlerName = this.extractIdentifierName(
                    argNodes[1]!,
                    source,
                  );
                }
                return {
                  method: methodName.toUpperCase(),
                  path: routePath,
                  handlerName,
                };
              }
            }
          }
        }
      }
    }

    // Pattern: @Get('/path') decorator
    if (node.type === 'decorator') {
      const callNode = this.findChildByType(node, 'call_expression');
      if (callNode) {
        const funcNode = callNode.childForFieldName?.('function');
        if (funcNode?.type === 'identifier') {
          const decoratorName = source.slice(
            funcNode.startIndex,
            funcNode.endIndex,
          );
          // Map decorator to HTTP method
          const decoratorMap: Record<string, string> = {
            Get: 'GET',
            Post: 'POST',
            Put: 'PUT',
            Delete: 'DELETE',
            Patch: 'PATCH',
            Head: 'HEAD',
            Options: 'OPTIONS',
            All: 'ALL',
          };
          const method = decoratorMap[decoratorName];
          if (method) {
            const args = this.findChildrenByType(callNode, 'arguments');
            const argNodes =
              args.length > 0 ? this.getDirectChildren(args[0]!) : [];
            if (argNodes.length >= 1) {
              const routePath = this.extractStringValue(argNodes[0]!, source);
              if (routePath) {
                return { method, path: routePath, handlerName: '' };
              }
            }
          }
        }
      }
    }

    return null;
  }

  // ── Python route detection ─────────────────────────────────
  private tryExtractPythonRoute(
    node: Parser.SyntaxNode,
    source: string,
  ): { method: string; path: string; handlerName: string } | null {
    // Pattern: @app.route('/path', methods=['GET'])
    // Pattern: @router.get('/path') (FastAPI)
    // Pattern: @bp.get('/path') (Flask Blueprint)
    if (node.type === 'decorator') {
      const callNode = this.findChildByType(node, 'call');
      if (callNode) {
        const funcNode = callNode.childForFieldName?.('function');
        if (funcNode) {
          const funcName = source.slice(
            funcNode.startIndex,
            funcNode.endIndex,
          );
          // @app.route('/path')
          if (funcName === 'route') {
            const args = this.findChildrenByType(callNode, 'argument_list');
            if (args.length > 0) {
              const argNodes = this.getDirectChildren(args[0]!);
              if (argNodes.length >= 1) {
                const routePath = this.extractStringValue(
                  argNodes[0]!,
                  source,
                );
                if (routePath) {
                  let method = 'GET';
                  // Check for methods=['POST'] keyword argument
                  for (const arg of argNodes) {
                    const kwText = source.slice(
                      arg.startIndex,
                      arg.endIndex,
                    );
                    const methodsMatch = kwText.match(
                      /methods\s*=\s*\[['"]([^'"]+)['"]\]/,
                    );
                    if (methodsMatch) {
                      method = methodsMatch[1]!.toUpperCase();
                      break;
                    }
                  }
                  return { method, path: routePath, handlerName: '' };
                }
              }
            }
          }
          // FastAPI: @router.get('/path'), @app.post('/path')
          const httpMethods = [
            'get', 'post', 'put', 'delete', 'patch', 'head', 'options',
          ];
          if (httpMethods.includes(funcName)) {
            const args = this.findChildrenByType(callNode, 'argument_list');
            if (args.length > 0) {
              const argNodes = this.getDirectChildren(args[0]!);
              if (argNodes.length >= 1) {
                const routePath = this.extractStringValue(
                  argNodes[0]!,
                  source,
                );
                if (routePath) {
                  return {
                    method: funcName.toUpperCase(),
                    path: routePath,
                    handlerName: '',
                  };
                }
              }
            }
          }
        }
      }
    }
    return null;
  }

  // ── Java route detection ───────────────────────────────────
  private tryExtractJavaRoute(
    node: Parser.SyntaxNode,
    source: string,
  ): { method: string; path: string; handlerName: string } | null {
    // Pattern: @GetMapping("/path"), @PostMapping("/path"), @RequestMapping("/path")
    if (node.type === 'marker_annotation' || node.type === 'annotation') {
      const nameNode = this.findChildByType(
        node,
        'identifier',
        'type_identifier',
      );
      if (nameNode) {
        const annoName = source.slice(
          nameNode.startIndex,
          nameNode.endIndex,
        );
        const annoMap: Record<string, string> = {
          GetMapping: 'GET',
          PostMapping: 'POST',
          PutMapping: 'PUT',
          DeleteMapping: 'DELETE',
          PatchMapping: 'PATCH',
          RequestMapping: 'ALL',
        };
        const method = annoMap[annoName];
        if (method) {
          const strNode = this.findChildByType(node, 'string_literal');
          if (strNode) {
            const routePath = source.slice(
              strNode.startIndex + 1,
              strNode.endIndex - 1,
            );
            return { method, path: routePath, handlerName: '' };
          }
        }
      }
    }
    return null;
  }

  // ── Go route detection ─────────────────────────────────────
  private tryExtractGoRoute(
    node: Parser.SyntaxNode,
    source: string,
  ): { method: string; path: string; handlerName: string } | null {
    // Pattern: r.GET("/path", handler)
    if (node.type === 'call_expression') {
      const funcNode = node.childForFieldName?.('function');
      if (funcNode?.type === 'selector_expression') {
        const prop = funcNode.childForFieldName?.('field');
        if (prop) {
          const methodName = source.slice(prop.startIndex, prop.endIndex);
          const knownMethods = [
            'GET', 'POST', 'PUT', 'DELETE', 'PATCH',
            'HEAD', 'OPTIONS', 'HandleFunc',
          ];
          if (knownMethods.includes(methodName)) {
            const args = this.findChildrenByType(node, 'argument_list');
            if (args.length > 0) {
              const argNodes = this.getDirectChildren(args[0]!);
              if (argNodes.length >= 1) {
                const routePath = this.extractStringValue(
                  argNodes[0]!,
                  source,
                );
                if (routePath) {
                  let handlerName = '';
                  if (argNodes.length >= 2) {
                    handlerName = this.extractIdentifierName(
                      argNodes[1]!,
                      source,
                    );
                  }
                  const method =
                    methodName === 'HandleFunc'
                      ? 'ALL'
                      : methodName.toUpperCase();
                  return { method, path: routePath, handlerName };
                }
              }
            }
          }
        }
      }
    }
    return null;
  }

  // ── C# route detection ─────────────────────────────────────
  private tryExtractCSharpRoute(
    node: Parser.SyntaxNode,
    source: string,
  ): { method: string; path: string; handlerName: string } | null {
    // Pattern: [HttpGet("/path")], [HttpPost("/path")], [Route("/path")]
    if (node.type === 'attribute') {
      const nameNode = this.findChildByType(
        node,
        'identifier',
        'type_identifier',
      );
      if (nameNode) {
        const attrName = source.slice(
          nameNode.startIndex,
          nameNode.endIndex,
        );
        const attrMap: Record<string, string> = {
          HttpGet: 'GET',
          HttpPost: 'POST',
          HttpPut: 'PUT',
          HttpDelete: 'DELETE',
          HttpPatch: 'PATCH',
          Route: 'ALL',
        };
        const method = attrMap[attrName];
        if (method) {
          const strNode = this.findChildByType(node, 'string_literal');
          if (strNode) {
            const routePath = source.slice(
              strNode.startIndex + 1,
              strNode.endIndex - 1,
            );
            // Handle [Route("[controller]")] template
            return { method, path: routePath, handlerName: '' };
          }
        }
      }
    }
    return null;
  }

  // ── AST value extraction helpers ───────────────────────────────

  private extractStringValue(
    node: Parser.SyntaxNode,
    source: string,
  ): string | null {
    if (node.type === 'string' || node.type === 'string_literal') {
      return source.slice(node.startIndex + 1, node.endIndex - 1);
    }
    if (node.type === 'string_fragment') {
      return source.slice(node.startIndex, node.endIndex);
    }
    // Template literal (JS/TS)
    if (node.type === 'template_string') {
      return source
        .slice(node.startIndex + 1, node.endIndex - 1)
        .replace(/\$\{[^}]*\}/g, ':param');
    }
    return null;
  }

  private extractIdentifierName(
    node: Parser.SyntaxNode,
    source: string,
  ): string {
    if (node.type === 'identifier') {
      return source.slice(node.startIndex, node.endIndex);
    }
    if (
      node.type === 'arrow_function' ||
      node.type === 'function_expression'
    ) {
      return '';
    }
    const id = this.findChildByType(node, 'identifier');
    return id ? source.slice(id.startIndex, id.endIndex) : '';
  }

  private getDirectChildren(node: Parser.SyntaxNode): Parser.SyntaxNode[] {
    const children: Parser.SyntaxNode[] = [];
    for (let i = 0; i < node.childCount; i++) {
      children.push(node.child(i)!);
    }
    return children;
  }

  // ── Private: AST navigation helpers ────────────────────────────

  private findChildByType(
    node: Parser.SyntaxNode,
    ...types: string[]
  ): Parser.SyntaxNode | null {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i)!;
      if (types.includes(child.type)) {
        return child;
      }
      const found = this.findChildByType(child, ...types);
      if (found) return found;
    }
    return null;
  }

  private findChildrenByType(
    node: Parser.SyntaxNode,
    type: string,
  ): Parser.SyntaxNode[] {
    const results: Parser.SyntaxNode[] = [];
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i)!;
      if (child.type === type) {
        results.push(child);
      }
      results.push(...this.findChildrenByType(child, type));
    }
    return results;
  }
}
