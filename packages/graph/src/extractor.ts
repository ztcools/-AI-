/**
 * AST-based graph extractor. Uses tree-sitter to extract structured
 * code information: functions, classes, methods, imports, and calls.
 *
 * Two-pass extraction:
 *   Pass 1: Collect all definitions (nodes) into a registry
 *   Pass 2: Resolve call expressions into CALLS edges
 */
import Parser from 'tree-sitter';
import { GraphNode, GraphNodeLabel, GraphEdge, GraphEdgeType } from './types';

// Lazy-load language parsers with fallback — any single parser failure
// won't prevent the module from loading other languages.
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
        console.warn(`[GraphExtractor] Failed to load tree-sitter parser for '${name}': ${e.message}`);
        return null;
    }
}

// ── Language configuration ─────────────────────────────────────────

interface LanguageConfig {
    parser: any; // tree-sitter Language (v0.21.x doesn't export Language type)
    nodeTypes: Record<string, GraphNodeLabel>;
    importNodeTypes: string[];
    callNodeTypes: string[];
    /** Fields to extract the name from for definitions */
    nameFields?: string[];
    /** Types that are nested definitions (must be parent-aware) */
    nestedDefTypes?: string[];
}

const LANGUAGE_CONFIGS: Record<string, LanguageConfig> = {
    javascript: {
        parser: loadParser('javascript'),
        nodeTypes: {
            function_declaration: 'Function',
            arrow_function: 'Function',
            class_declaration: 'Class',
            method_definition: 'Method',
            variable_declarator: 'Variable',
        },
        importNodeTypes: ['import_statement', 'require_call_expression'],
        callNodeTypes: ['call_expression', 'new_expression'],
        nameFields: ['name'],
        nestedDefTypes: ['method_definition'],
    },
    typescript: {
        parser: loadParser('typescript'),
        nodeTypes: {
            function_declaration: 'Function',
            arrow_function: 'Function',
            class_declaration: 'Class',
            method_definition: 'Method',
            interface_declaration: 'Interface',
            type_alias_declaration: 'Interface',
            variable_declarator: 'Variable',
        },
        importNodeTypes: ['import_statement'],
        callNodeTypes: ['call_expression', 'new_expression'],
        nameFields: ['name'],
        nestedDefTypes: ['method_definition'],
    },
    python: {
        parser: loadParser('python'),
        nodeTypes: {
            function_definition: 'Function',
            class_definition: 'Class',
            decorated_definition: 'Function',
            async_function_definition: 'Function',
        },
        importNodeTypes: ['import_statement', 'import_from_statement'],
        callNodeTypes: ['call'],
        nameFields: ['name'],
        nestedDefTypes: [],
    },
    java: {
        parser: loadParser('java'),
        nodeTypes: {
            method_declaration: 'Method',
            class_declaration: 'Class',
            interface_declaration: 'Interface',
            constructor_declaration: 'Method',
            field_declaration: 'Variable',
        },
        importNodeTypes: ['import_declaration'],
        callNodeTypes: ['method_invocation', 'object_creation_expression'],
        nameFields: ['name'],
        nestedDefTypes: ['method_declaration', 'constructor_declaration'],
    },
    cpp: {
        parser: loadParser('cpp'),
        nodeTypes: {
            function_definition: 'Function',
            class_specifier: 'Class',
            struct_specifier: 'Struct',
            namespace_definition: 'Module',
            declaration: 'Variable',
        },
        importNodeTypes: ['preproc_include'],
        callNodeTypes: ['call_expression'],
        nameFields: ['name'],
        nestedDefTypes: [],
    },
    go: {
        parser: loadParser('go'),
        nodeTypes: {
            function_declaration: 'Function',
            method_declaration: 'Method',
            type_declaration: 'Class',
            var_declaration: 'Variable',
            const_declaration: 'Variable',
        },
        importNodeTypes: ['import_declaration'],
        callNodeTypes: ['call_expression'],
        nameFields: ['name'],
        nestedDefTypes: ['method_declaration'],
    },
    rust: {
        parser: loadParser('rust'),
        nodeTypes: {
            function_item: 'Function',
            impl_item: 'Class',
            struct_item: 'Struct',
            enum_item: 'Enum',
            trait_item: 'Interface',
            mod_item: 'Module',
            let_declaration: 'Variable',
        },
        importNodeTypes: ['use_declaration'],
        callNodeTypes: ['call_expression'],
        nameFields: ['name'],
        nestedDefTypes: [],
    },
    csharp: {
        parser: loadParser('csharp'),
        nodeTypes: {
            method_declaration: 'Method',
            class_declaration: 'Class',
            interface_declaration: 'Interface',
            struct_declaration: 'Struct',
            enum_declaration: 'Enum',
            constructor_declaration: 'Method',
        },
        importNodeTypes: ['using_directive'],
        callNodeTypes: ['invocation_expression', 'object_creation_expression'],
        nameFields: ['name'],
        nestedDefTypes: ['method_declaration', 'constructor_declaration'],
    },
};

// ── Extraction result ──────────────────────────────────────────────

export interface ExtractionResult {
    nodes: Omit<GraphNode, 'id'>[];
    edges: Omit<GraphEdge, 'id'>[];
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
}

// ── Extractor class ────────────────────────────────────────────────

export class GraphExtractor {
    private parser: Parser;

    constructor() {
        this.parser = new Parser();
    }

    /**
     * Extract graph nodes and edges from source code.
     * Two-pass: collect definitions, then resolve calls.
     */
    extract(source: string, ctx: ExtractionContext): ExtractionResult {
        const config = this.getLanguageConfig(ctx.language);
        if (!config) {
            return { nodes: [], edges: [] };
        }

        if (!config.parser) {
            console.warn(`[GraphExtractor] Parser not available for ${ctx.language}, skipping ${ctx.filePath}`);
            return { nodes: [], edges: [] };
        }

        try {
            this.parser.setLanguage(config.parser);
            const tree = this.parser.parse(source);

            const nodes: Omit<GraphNode, 'id'>[] = [];
            const edges: Omit<GraphEdge, 'id'>[] = [];
            const registry = new Map<string, NameEntry>();

            // ── Pass 1: Collect all definitions ──────────────────────
            this.collectDefinitions(tree.rootNode, source, ctx, config, nodes, registry);

            // ── Pass 2: Resolve calls and create edges ──────────────
            this.resolveCalls(tree.rootNode, source, ctx, config, nodes, registry, edges);

            return { nodes, edges };
        } catch (error) {
            console.warn(`[GraphExtractor] Failed to parse ${ctx.filePath}:`, error);
            return { nodes: [], edges: [] };
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
            '.js': 'javascript', '.jsx': 'javascript',
            '.ts': 'typescript', '.tsx': 'typescript',
            '.py': 'python',
            '.java': 'java',
            '.cpp': 'cpp', '.c': 'cpp', '.h': 'cpp', '.hpp': 'cpp', '.cc': 'cpp',
            '.go': 'go',
            '.rs': 'rust',
            '.cs': 'csharp',
        };
        return map[ext] || '';
    }

    // ── Private: Pass 1 - Collect definitions ─────────────────────

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
        parentName?: string,
    ): void {
        const label = config.nodeTypes[node.type];

        if (label) {
            const name = this.extractName(node, source, config);
            if (name) {
                const startLine = node.startPosition.row + 1;
                const endLine = node.endPosition.row + 1;

                // Build qualified name: include parent for nested definitions
                let qualifiedName: string;
                let displayName: string;
                if (parentName && config.nestedDefTypes?.includes(node.type)) {
                    displayName = `${parentName}.${name}`;
                    qualifiedName = `${ctx.project}.${ctx.filePath.replace(/\//g, '.').replace(/\.[^.]+$/, '')}.${displayName}`;
                } else {
                    displayName = name;
                    qualifiedName = `${ctx.project}.${ctx.filePath.replace(/\//g, '.').replace(/\.[^.]+$/, '')}.${name}`;
                }

                const nodeIndex = nodes.length;
                nodes.push({
                    project: ctx.project,
                    label,
                    name: displayName,
                    qualifiedName,
                    filePath: ctx.filePath,
                    startLine,
                    endLine,
                    properties: {
                        language: ctx.language,
                        nodeType: node.type,
                    },
                });

                // Register the name for call resolution
                registry.set(name, { name, qualifiedName, nodeIndex });

                // If this is a class/struct, recurse for nested methods
                if (label === 'Class' || label === 'Struct' || label === 'Interface') {
                    for (let i = 0; i < node.childCount; i++) {
                        this.collectDefinitions(node.child(i)!, source, ctx, config, nodes, registry, name);
                    }
                    return; // Don't recurse again below
                }
            }
        }

        // Handle imports
        if (config.importNodeTypes.includes(node.type)) {
            this.collectImport(node, source, ctx, config, nodes, registry);
        }

        // Recurse into children (skip if already handled by class recursion)
        if (!(label && (label === 'Class' || label === 'Struct' || label === 'Interface'))) {
            for (let i = 0; i < node.childCount; i++) {
                this.collectDefinitions(node.child(i)!, source, ctx, config, nodes, registry, parentName);
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
    ): void {
        // Extract imported names and their module paths
        const imports = this.extractImportNames(node, source, config);
        for (const imp of imports) {
            // Register imported name so calls can resolve to it
            const moduleQN = imp.modulePath;
            if (!registry.has(imp.name)) {
                // We don't have the target node yet, but we record the import reference
                // The actual resolution happens at graph-build time (cross-file)
                const nodeIndex = nodes.length;
                nodes.push({
                    project: _ctx.project,
                    label: 'Module',
                    name: imp.modulePath,
                    qualifiedName: moduleQN,
                    filePath: _ctx.filePath,
                    startLine: node.startPosition.row + 1,
                    endLine: node.endPosition.row + 1,
                    properties: { importedName: imp.name, importPath: imp.modulePath },
                });
                registry.set(imp.name, {
                    name: imp.name,
                    qualifiedName: moduleQN,
                    nodeIndex,
                    importModule: moduleQN,
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
                const nameNode = this.findChildByType(ai, 'identifier', 'dotted_name');
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

    // ── Private: Pass 2 - Resolve calls ───────────────────────────

    private resolveCalls(
        node: Parser.SyntaxNode,
        source: string,
        ctx: ExtractionContext,
        config: LanguageConfig,
        nodes: Omit<GraphNode, 'id'>[],
        registry: Map<string, NameEntry>,
        edges: Omit<GraphEdge, 'id'>[],
        parentDefIdx?: number,
    ): void {
        const label = config.nodeTypes[node.type];

        // Track current parent definition for scoping calls
        let currentDefIdx: number | undefined = parentDefIdx;

        if (label) {
            const name = this.extractName(node, source, config);
            if (name) {
                const entry = registry.get(name);
                if (entry) {
                    currentDefIdx = entry.nodeIndex;
                }
            }
        }

        // Check if this is a call expression
        if (config.callNodeTypes.includes(node.type) && currentDefIdx !== undefined) {
            const callName = this.extractCallName(node, source, config);
            if (callName) {
                const entry = registry.get(callName);
                if (entry && entry.nodeIndex !== currentDefIdx) {
                    // Don't create self-referencing edges
                    edges.push({
                        project: ctx.project,
                        sourceId: currentDefIdx, // temp index, will be resolved
                        targetId: entry.nodeIndex,
                        type: entry.importModule ? 'IMPORTS' : 'CALLS',
                        properties: {
                            line: node.startPosition.row + 1,
                            importModule: entry.importModule,
                        },
                    });
                }
            }

            // Handle method calls (obj.method())
            const methodCall = this.extractMethodCall(node, source, config);
            if (methodCall && currentDefIdx !== undefined) {
                const entry = registry.get(methodCall);
                if (entry && entry.nodeIndex !== currentDefIdx) {
                    edges.push({
                        project: ctx.project,
                        sourceId: currentDefIdx,
                        targetId: entry.nodeIndex,
                        type: 'CALLS',
                        properties: {
                            line: node.startPosition.row + 1,
                            callType: 'method',
                        },
                    });
                }
            }
        }

        // Recurse into children
        for (let i = 0; i < node.childCount; i++) {
            this.resolveCalls(node.child(i)!, source, ctx, config, nodes, registry, edges, currentDefIdx);
        }
    }

    // ── Private: Name extraction helpers ───────────────────────────

    private extractName(node: Parser.SyntaxNode, source: string, config: LanguageConfig): string | null {
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
        const nameChild = this.findChildByType(node, 'identifier', 'property_identifier', 'type_identifier');
        if (nameChild) {
            return source.slice(nameChild.startIndex, nameChild.endIndex);
        }
        return null;
    }

    private extractCallName(node: Parser.SyntaxNode, source: string, config: LanguageConfig): string | null {
        // Try 'function' field first
        const funcChild = node.childForFieldName?.('function');
        if (funcChild) {
            // For simple calls: just the identifier
            if (funcChild.type === 'identifier') {
                return source.slice(funcChild.startIndex, funcChild.endIndex);
            }
            // For member expressions: obj.method
            const id = this.findChildByType(funcChild, 'identifier');
            if (id) {
                return source.slice(id.startIndex, id.endIndex);
            }
        }

        // Fallback: first identifier child
        const id = this.findChildByType(node, 'identifier');
        if (id) {
            return source.slice(id.startIndex, id.endIndex);
        }

        return null;
    }

    private extractMethodCall(node: Parser.SyntaxNode, source: string, config: LanguageConfig): string | null {
        // Look for member_expression where the call is on a method
        const funcChild = node.childForFieldName?.('function');
        if (funcChild && funcChild.type === 'member_expression') {
            const property = funcChild.childForFieldName?.('property');
            if (property) {
                return source.slice(property.startIndex, property.endIndex);
            }
        }
        return null;
    }

    private extractImportPath(node: Parser.SyntaxNode, source: string): string | null {
        // Find the string literal containing the import path
        const stringChild = this.findChildByType(node, 'string', 'string_fragment', 'string_literal');
        if (stringChild) {
            const raw = source.slice(stringChild.startIndex, stringChild.endIndex);
            return raw.replace(/^['"]|['"]$/g, '');
        }
        return null;
    }

    // ── Private: AST navigation helpers ────────────────────────────

    private findChildByType(node: Parser.SyntaxNode, ...types: string[]): Parser.SyntaxNode | null {
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

    private findChildrenByType(node: Parser.SyntaxNode, type: string): Parser.SyntaxNode[] {
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