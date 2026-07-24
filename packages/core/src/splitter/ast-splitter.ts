import Parser from 'tree-sitter';
import { Splitter, CodeChunk } from './index';

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
            case 'scala':
                return require('tree-sitter-scala');
            default:
                return null;
        }
    } catch (e: any) {
        console.warn(`[ASTSplitter] Failed to load tree-sitter parser for '${name}': ${e.message}`);
        return null;
    }
}

// Node types that represent logical code units.
// Note: interface_declaration and type_alias_declaration are intentionally
// EXCLUDED — they contain zero implementation logic. Splitting them out as
// independent chunks poisons search results with type-only noise (e.g. a
// "search" query matching SearchCodeResult's interface declaration).
// They fall through to the parent's traversal and are only indexed as part
// of a larger implementation chunk when no better split points exist.
const SPLITTABLE_NODE_TYPES = {
    javascript: ['function_declaration', 'arrow_function', 'class_declaration', 'method_definition'],
    typescript: ['function_declaration', 'arrow_function', 'class_declaration', 'method_definition'],
    python: ['function_definition', 'class_definition', 'decorated_definition', 'async_function_definition'],
    java: ['method_declaration', 'class_declaration', 'constructor_declaration'],
    cpp: ['function_definition', 'class_specifier', 'namespace_definition'],
    go: ['function_declaration', 'method_declaration', 'type_declaration', 'var_declaration', 'const_declaration'],
    rust: ['function_item', 'impl_item', 'struct_item', 'enum_item', 'trait_item', 'mod_item'],
    csharp: ['method_declaration', 'class_declaration', 'struct_declaration', 'enum_declaration'],
    scala: ['method_declaration', 'class_declaration', 'constructor_declaration']
};

export class AstCodeSplitter implements Splitter {
    private chunkSize: number = 4000;
    private chunkOverlap: number = 500;
    private parser: Parser;
    private langchainFallback: any; // LangChainCodeSplitter for fallback

    constructor(chunkSize?: number, chunkOverlap?: number) {
        if (chunkSize) this.chunkSize = chunkSize;
        if (chunkOverlap) this.chunkOverlap = chunkOverlap;
        this.parser = new Parser();

        // Initialize fallback splitter
        const { LangChainCodeSplitter } = require('./langchain-splitter');
        this.langchainFallback = new LangChainCodeSplitter(chunkSize, chunkOverlap);
    }

    async split(code: string, language: string, filePath?: string): Promise<CodeChunk[]> {
        // Check if language is supported by AST splitter
        const langConfig = this.getLanguageConfig(language);
        if (!langConfig) {
            console.log(`📝 Language ${language} not supported by AST, using LangChain splitter for: ${filePath || 'unknown'}`);
            return await this.langchainFallback.split(code, language, filePath);
        }

        try {
            console.log(`🌳 Using AST splitter for ${language} file: ${filePath || 'unknown'}`);

            this.parser.setLanguage(langConfig.parser);
            const tree = this.parser.parse(code);

            if (!tree.rootNode) {
                console.warn(`[ASTSplitter] ⚠️  Failed to parse AST for ${language}, falling back to LangChain: ${filePath || 'unknown'}`);
                return await this.langchainFallback.split(code, language, filePath);
            }

            // Extract chunks based on AST nodes
            const chunks = this.extractChunks(tree.rootNode, code, langConfig.nodeTypes, language, filePath);

            // AST-extracted chunks are semantic units (functions/methods/classes).
            // Character-splitting them destroys the boundary between "real code" and
            // "embedded string literal" (e.g. MCP tool description templates), causing
            // noise chunks like `"search" keyword → index.ts:90 search_description string`.
            // Each unit stays whole; overlap provides cross-chunk continuity without
            // breaking semantics.
            const refinedChunks = this.addOverlap(chunks);

            return refinedChunks;
        } catch (error) {
            console.warn(`[ASTSplitter] ⚠️  AST splitter failed for ${language}, falling back to LangChain: ${error}`);
            return await this.langchainFallback.split(code, language, filePath);
        }
    }

    setChunkSize(chunkSize: number): void {
        this.chunkSize = chunkSize;
        this.langchainFallback.setChunkSize(chunkSize);
    }

    setChunkOverlap(chunkOverlap: number): void {
        this.chunkOverlap = chunkOverlap;
        this.langchainFallback.setChunkOverlap(chunkOverlap);
    }

    private getLanguageConfig(language: string): { parser: any; nodeTypes: string[] } | null {
        const langMap: Record<string, () => { parser: any; nodeTypes: string[] }> = {
            'javascript': () => ({ parser: loadParser('javascript'), nodeTypes: SPLITTABLE_NODE_TYPES.javascript }),
            'js': () => ({ parser: loadParser('javascript'), nodeTypes: SPLITTABLE_NODE_TYPES.javascript }),
            'typescript': () => ({ parser: loadParser('typescript'), nodeTypes: SPLITTABLE_NODE_TYPES.typescript }),
            'ts': () => ({ parser: loadParser('typescript'), nodeTypes: SPLITTABLE_NODE_TYPES.typescript }),
            'python': () => ({ parser: loadParser('python'), nodeTypes: SPLITTABLE_NODE_TYPES.python }),
            'py': () => ({ parser: loadParser('python'), nodeTypes: SPLITTABLE_NODE_TYPES.python }),
            'java': () => ({ parser: loadParser('java'), nodeTypes: SPLITTABLE_NODE_TYPES.java }),
            'cpp': () => ({ parser: loadParser('cpp'), nodeTypes: SPLITTABLE_NODE_TYPES.cpp }),
            'c++': () => ({ parser: loadParser('cpp'), nodeTypes: SPLITTABLE_NODE_TYPES.cpp }),
            'c': () => ({ parser: loadParser('cpp'), nodeTypes: SPLITTABLE_NODE_TYPES.cpp }),
            'go': () => ({ parser: loadParser('go'), nodeTypes: SPLITTABLE_NODE_TYPES.go }),
            'rust': () => ({ parser: loadParser('rust'), nodeTypes: SPLITTABLE_NODE_TYPES.rust }),
            'rs': () => ({ parser: loadParser('rust'), nodeTypes: SPLITTABLE_NODE_TYPES.rust }),
            'cs': () => ({ parser: loadParser('csharp'), nodeTypes: SPLITTABLE_NODE_TYPES.csharp }),
            'csharp': () => ({ parser: loadParser('csharp'), nodeTypes: SPLITTABLE_NODE_TYPES.csharp }),
            'scala': () => ({ parser: loadParser('scala'), nodeTypes: SPLITTABLE_NODE_TYPES.scala })
        };

        const factory = langMap[language.toLowerCase()];
        if (!factory) return null;
        const config = factory();
        if (!config.parser) return null;
        return config;
    }

    private extractChunks(
        node: Parser.SyntaxNode,
        code: string,
        splittableTypes: string[],
        language: string,
        filePath?: string
    ): CodeChunk[] {
        const chunks: CodeChunk[] = [];

        const traverse = (currentNode: Parser.SyntaxNode) => {
            // Check if this node type should be split into a chunk
            if (splittableTypes.includes(currentNode.type)) {
                const startLine = currentNode.startPosition.row + 1;
                const endLine = currentNode.endPosition.row + 1;
                const nodeText = code.slice(currentNode.startIndex, currentNode.endIndex);

                // Only create chunk if it has meaningful content
                if (nodeText.trim().length > 0) {
                    chunks.push({
                        content: nodeText,
                        metadata: {
                            startLine,
                            endLine,
                            language,
                            filePath,
                        }
                    });
                }
            }

            // Continue traversing child nodes
            for (const child of currentNode.children) {
                traverse(child);
            }
        };

        traverse(node);

        return chunks;
    }

    private addOverlap(chunks: CodeChunk[]): CodeChunk[] {
        if (chunks.length <= 1 || this.chunkOverlap <= 0) {
            return chunks;
        }

        const overlappedChunks: CodeChunk[] = [];

        for (let i = 0; i < chunks.length; i++) {
            let content = chunks[i].content;
            const metadata = { ...chunks[i].metadata };

            // Add overlap from previous chunk
            if (i > 0 && this.chunkOverlap > 0) {
                const prevChunk = chunks[i - 1];
                const overlapText = prevChunk.content.slice(-this.chunkOverlap);
                content = overlapText + '\n' + content;
                metadata.startLine = Math.max(1, metadata.startLine - this.getLineCount(overlapText));
            }

            overlappedChunks.push({
                content,
                metadata
            });
        }

        return overlappedChunks;
    }

    private getLineCount(text: string): number {
        return text.split('\n').length;
    }

    /**
     * Check if AST splitting is supported for the given language
     */
    static isLanguageSupported(language: string): boolean {
        const supportedLanguages = [
            'javascript', 'js', 'typescript', 'ts', 'python', 'py',
            'java', 'cpp', 'c++', 'c', 'go', 'rust', 'rs', 'cs', 'csharp', 'scala'
        ];
        return supportedLanguages.includes(language.toLowerCase());
    }

    /**
     * Get list of supported languages
     */
    static getSupportedLanguages(): string[] {
        return [
            'javascript', 'js', 'typescript', 'ts', 'python', 'py',
            'java', 'cpp', 'c++', 'c', 'go', 'rust', 'rs', 'cs', 'csharp', 'scala'
        ];
    }
}
