/**
 * Import resolution strategies for different programming languages.
 *
 * Responsible for:
 *   1. Parsing import/require/include statements from source text into
 *      ImportMapping records (localName → modulePath → resolvedFile).
 *   2. Resolving UnresolvedReferences by finding the imported module's
 *      file on disk, then matching the reference name to a node exported
 *      from that module.
 *
 * ResolutionContext is a lightweight facade over the GraphStore + fs
 * that the resolver uses for cross-file lookups.
 */
import * as path from 'path';
import * as fs from 'fs';
import {
  GraphNode,
  GraphLanguage,
  GraphEdgeKind,
  UnresolvedReference,
  ResolvedRef,
} from '../types';

// ── Types ────────────────────────────────────────────────────────────────

export interface ImportMapping {
  /** Local name the import is bound to (e.g. "foo" in `import { foo }`). */
  localName: string;
  /** The raw module path as written in source (e.g. "./bar", "lodash"). */
  modulePath: string;
  /** Absolute filesystem path to the resolved module file, if resolvable. */
  resolvedFile?: string;
}

export interface ResolutionContext {
  getNodesInFile(filePath: string): GraphNode[];
  getNodesByName(name: string): GraphNode[];
  getNodesByQualifiedName(qn: string): GraphNode[];
  getAllFiles(): string[];
  getProjectRoot(): string;
  fileExists(filePath: string): boolean;
  readFile(filePath: string): string | null;
}

// ── Constants ────────────────────────────────────────────────────────────

/** Extensions tried in order when resolving a bare module path to a file. */
const RESOLVE_EXTENSIONS: Record<string, string[]> = {
  javascript: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'],
  typescript: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'],
  python: ['.py'],
  java: ['.java'],
  go: ['.go'],
  rust: ['.rs'],
  cpp: ['.cpp', '.c', '.h', '.hpp', '.cc', '.cxx'],
  csharp: ['.cs'],
  scala: ['.scala'],
};

/** Index-file candidates tried in a directory (e.g. "import ./foo" → "./foo/index.ts"). */
const INDEX_FILES: Record<string, string[]> = {
  javascript: ['index.ts', 'index.tsx', 'index.js', 'index.jsx', 'index.mjs'],
  typescript: ['index.ts', 'index.tsx', 'index.js', 'index.jsx'],
  python: ['__init__.py'],
  go: ['index.go', 'main.go'],
  rust: ['mod.rs', 'lib.rs'],
};

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Parse import/require/include statements from source content.
 *
 * Covers JS/TS, Python, Java, Go, Rust, C/C++, and C#.
 * Returns an array of ImportMapping records keyed by local name.
 */
export function extractImportMappings(
  filePath: string,
  content: string,
  language: GraphLanguage,
): ImportMapping[] {
  switch (language) {
    case 'javascript':
    case 'typescript':
      return extractJsTsImports(filePath, content, language);
    case 'python':
      return extractPythonImports(filePath, content, language);
    case 'java':
    case 'scala':
      return extractJavaImports(filePath, content, language);
    case 'go':
      return extractGoImports(filePath, content, language);
    case 'rust':
      return extractRustImports(filePath, content, language);
    case 'cpp':
      return extractCppImports(filePath, content, language);
    case 'csharp':
      return extractCSharpImports(filePath, content, language);
    default:
      return [];
  }
}

/**
 * Resolve an UnresolvedReference by matching its name against known
 * import mappings for the containing file, then looking for a matching
 * node in the imported file.
 */
export function resolveViaImport(
  ref: UnresolvedReference,
  context: ResolutionContext,
  importMappings?: ImportMapping[],
): ResolvedRef | null {
  const language = ref.language || 'javascript';
  const refFile = ref.filePath;
  if (!refFile) return null;

  // Build import mappings for the ref's file if not provided
  const mappings =
    importMappings ?? buildImportMappingsForFile(refFile, language, context);

  const refName = ref.referenceName;

  // Handle dotted/qualified calls: e.g. "os.path.join" → resolve "os" first
  const dotIndex = refName.indexOf('.');
  const baseName = dotIndex > 0 ? refName.slice(0, dotIndex) : refName;

  // Try exact local name match against imports
  const matchedImport = mappings.find((m) => m.localName === baseName);
  if (matchedImport && matchedImport.resolvedFile) {
    // Resolve file path relative to project root for store lookup
    const relativeResolved = path.relative(
      context.getProjectRoot(),
      matchedImport.resolvedFile,
    );

    // Search for the full reference name in the imported file's nodes
    let nodes = context.getNodesInFile(relativeResolved);
    if (dotIndex > 0) {
      // For qualified references, try the full suffix
      nodes = context.getNodesByName(refName);
      // Filter to the resolved file if we got global results
      if (nodes.length === 0) {
        nodes = context.getNodesInFile(relativeResolved).filter(
          (n) => n.name === refName.slice(dotIndex + 1),
        );
      }
    }

    if (nodes.length === 1) {
      return {
        original: ref,
        targetNodeId: nodes[0].id,
        resolvedBy: 'import-mapping',
        confidence: 0.95,
      };
    }

    if (nodes.length > 1) {
      // Ambiguous but in importing file — prefer exported/public nodes
      const exported = nodes.filter((n) => n.isExported);
      const candidate = exported.length === 1 ? exported[0] : nodes[0];
      return {
        original: ref,
        targetNodeId: candidate.id,
        resolvedBy: 'import-mapping-ambiguous',
        confidence: exported.length === 1 ? 0.90 : 0.70,
      };
    }
  }

  return null;
}

/**
 * Resolve JVM-family (Java/Kotlin/Scala) fully-qualified-name imports.
 *
 * Java import example: `import com.example.Foo;`
 * A call to `Foo` resolves to `com.example.Foo` (qualified name lookup).
 */
export function resolveJvmImport(
  ref: UnresolvedReference,
  context: ResolutionContext,
  importMappings?: ImportMapping[],
): ResolvedRef | null {
  const refFile = ref.filePath;
  if (!refFile) return null;
  const language = ref.language || 'java';

  // Standard JVM import resolution (fall through to resolveViaImport for most cases)
  const viaImport = resolveViaImport(ref, context, importMappings);
  if (viaImport) return viaImport;

  // JVM-specific: try to match by fully qualified name suffix
  const refName = ref.referenceName;
  if (refName.includes('.')) {
    // Already qualified (e.g. "com.example.Foo.bar") — try qualified name lookup
    const nodes = context.getNodesByQualifiedName(refName);
    if (nodes.length === 1) {
      return {
        original: ref,
        targetNodeId: nodes[0].id,
        resolvedBy: 'jvm-fqn',
        confidence: 0.95,
      };
    }

    // Try suffix match: last component of qualified name
    const lastPart = refName.split('.').pop()!;
    const suffixNodes = context.getNodesByName(lastPart);
    if (suffixNodes.length === 1) {
      return {
        original: ref,
        targetNodeId: suffixNodes[0].id,
        resolvedBy: 'jvm-fqn-suffix',
        confidence: 0.55,
      };
    }
  }

  return null;
}

// ── Helpers ──────────────────────────────────────────────────────────────

function buildImportMappingsForFile(
  filePath: string,
  language: GraphLanguage,
  context: ResolutionContext,
): ImportMapping[] {
  let content = context.readFile(filePath);
  if (content === null) {
    // Fallback: try reading directly
    const absolutePath = path.join(context.getProjectRoot(), filePath);
    try {
      content = fs.readFileSync(absolutePath, 'utf-8');
    } catch {
      return [];
    }
  }
  const mappings = extractImportMappings(filePath, content, language);

  // Resolve module paths to filesystem paths
  const projectRoot = context.getProjectRoot();
  for (const mapping of mappings) {
    if (!mapping.resolvedFile) {
      mapping.resolvedFile = resolveModuleToFile(
        filePath,
        mapping.modulePath,
        language,
        context,
      );
    }
  }

  return mappings;
}

/**
 * Resolve a module path (relative or bare) to an absolute filesystem path.
 */
function resolveModuleToFile(
  fromFile: string,
  modulePath: string,
  language: GraphLanguage,
  context: ResolutionContext,
): string | undefined {
  const projectRoot = context.getProjectRoot();

  // Relative imports: start from the importing file's directory
  if (modulePath.startsWith('./') || modulePath.startsWith('../')) {
    const fromDir = path.dirname(path.join(projectRoot, fromFile));
    const candidate = path.resolve(fromDir, modulePath);
    return resolveFileCandidate(candidate, language, context);
  }

  // Absolute project-relative (e.g. "src/foo/bar")
  const absoluteCandidate = path.join(projectRoot, modulePath);
  const resolved = resolveFileCandidate(absoluteCandidate, language, context);
  if (resolved) return resolved;

  // Bare module name: try common roots (node_modules, src, lib, pkg, etc.)
  const searchRoots = [
    path.join(projectRoot, 'node_modules', modulePath),
    path.join(projectRoot, 'src', modulePath),
    path.join(projectRoot, 'lib', modulePath),
    path.join(projectRoot, 'packages', modulePath),
    path.join(projectRoot, 'pkg', modulePath),
    path.join(projectRoot, 'internal', modulePath),
    // Cargo workspace
    path.join(projectRoot, 'crates', modulePath),
    // Go module
    path.join(projectRoot, modulePath),
  ];

  for (const root of searchRoots) {
    const found = resolveFileCandidate(root, language, context);
    if (found) return found;
  }

  return undefined;
}

/**
 * Try to resolve a path candidate to an actual file.
 * Tries extensions, then directory index files.
 */
function resolveFileCandidate(
  candidate: string,
  language: GraphLanguage,
  context: ResolutionContext,
): string | undefined {
  const extensions = RESOLVE_EXTENSIONS[language] || [];
  const projectRoot = context.getProjectRoot();

  // 1. Direct extension match
  for (const ext of extensions) {
    const fullPath = candidate + ext;
    if (context.fileExists(fullPath)) return fullPath;
  }

  // 2. Directory → index file
  const indexFiles = INDEX_FILES[language] || [];
  for (const idx of indexFiles) {
    const fullPath = path.join(candidate, idx);
    if (context.fileExists(fullPath)) return fullPath;
  }

  // 3. Try the candidate itself (no extension) — some languages like Python allow this
  if (context.fileExists(candidate)) return candidate;

  return undefined;
}

// ── Language-specific import parsers ─────────────────────────────────────

// ── JS/TS ───────────────────────────────────────────────────────────────

function extractJsTsImports(
  _filePath: string,
  content: string,
  _language: GraphLanguage,
): ImportMapping[] {
  const mappings: ImportMapping[] = [];

  // ES6 imports: import { foo, bar } from './module'
  //              import * as ns from './module'
  //              import defaultExport from './module'
  //              import defaultExport, { foo } from './module'
  const esImportRe =
    /import\s+(?:type\s+)?(?:(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s*,?\s*)*\s*from\s*['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = esImportRe.exec(content)) !== null) {
    const modulePath = match[1];
    // Extract local names from the import specifiers
    const importClause = match[0];
    const specifierBlock = importClause.match(/\{([^}]*)\}/);
    if (specifierBlock) {
      // import { foo, bar } from ...
      const names = specifierBlock[1].split(',').map((s) => {
        const trimmed = s.trim();
        // Handle "foo as bar" aliased imports
        const asMatch = trimmed.match(/(\w+)\s+as\s+(\w+)/);
        if (asMatch) return asMatch[2];
        return trimmed;
      }).filter((n) => n.length > 0);
      for (const name of names) {
        mappings.push({ localName: name, modulePath });
      }
    } else {
      // Namespace import: import * as ns from ...
      const nsMatch = importClause.match(/\*\s+as\s+(\w+)/);
      if (nsMatch) {
        mappings.push({ localName: nsMatch[1], modulePath });
      } else {
        // Default import: import foo from ...
        const defaultMatch = importClause.match(/import\s+(\w+)/);
        if (defaultMatch) {
          mappings.push({ localName: defaultMatch[1], modulePath });
        }
      }
    }
  }

  // Side-effect import: import './module'  — register no names, but record module

  // Dynamic imports: import('./module')
  const dynamicImportRe = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((match = dynamicImportRe.exec(content)) !== null) {
    // Dynamic imports resolve at runtime; record module but can't bind names statically
  }

  // CommonJS: const x = require('./module')
  //           const { foo, bar } = require('./module')
  const requireRe =
    /(?:const|let|var)\s+(?:\{([^}]*)\}|(\w+))\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((match = requireRe.exec(content)) !== null) {
    const modulePath = match[3];
    const destructured = match[1];
    const simpleName = match[2];
    if (destructured) {
      const names = destructured.split(',').map((s) => {
        const trimmed = s.trim();
        const asMatch = trimmed.match(/(\w+)\s*:\s*(\w+)/);
        return asMatch ? asMatch[2] : trimmed;
      }).filter((n) => n.length > 0);
      for (const name of names) {
        mappings.push({ localName: name, modulePath });
      }
    } else if (simpleName) {
      mappings.push({ localName: simpleName, modulePath });
    }
  }

  return mappings;
}

// ── Python ──────────────────────────────────────────────────────────────

function extractPythonImports(
  _filePath: string,
  content: string,
  _language: GraphLanguage,
): ImportMapping[] {
  const mappings: ImportMapping[] = [];

  // from X import a, b, c
  const fromImportRe = /from\s+([\w.]+)\s+import\s+(.+?)(?:\s*#.*)?$/gm;
  let match: RegExpExecArray | null;
  while ((match = fromImportRe.exec(content)) !== null) {
    const modulePath = match[1];
    const namesClause = match[2];
    // Handle parenthesized multi-line imports
    const cleanClause = namesClause.replace(/[\(\)]/g, '').trim();
    const names = cleanClause.split(',').map((s) => {
      const trimmed = s.trim();
      // Handle "foo as bar" aliases
      const asMatch = trimmed.match(/(\w+)\s+as\s+(\w+)/);
      if (asMatch) return asMatch[2];
      // Handle wildcard: from X import * — can't bind specific names
      if (trimmed === '*') return '';
      return trimmed;
    }).filter((n) => n.length > 0);
    for (const name of names) {
      mappings.push({ localName: name, modulePath: modulePath.replace(/\./g, '/') });
    }
  }

  // import X / import X.Y
  const importRe = /^import\s+(.+?)(?:\s*#.*)?$/gm;
  while ((match = importRe.exec(content)) !== null) {
    const namesClause = match[1];
    const cleanClause = namesClause.replace(/[\(\)]/g, '').trim();
    const names = cleanClause.split(',').map((s) => {
      const trimmed = s.trim();
      const asMatch = trimmed.match(/([\w.]+)\s+as\s+(\w+)/);
      if (asMatch) {
        return { modulePath: asMatch[1].replace(/\./g, '/'), localName: asMatch[2] };
      }
      return { modulePath: trimmed.replace(/\./g, '/'), localName: trimmed.split('.').pop()! };
    });
    for (const name of names) {
      mappings.push(name);
    }
  }

  return mappings;
}

// ── Java / Scala ────────────────────────────────────────────────────────

function extractJavaImports(
  _filePath: string,
  content: string,
  _language: GraphLanguage,
): ImportMapping[] {
  const mappings: ImportMapping[] = [];

  // import com.example.Foo;
  // import static com.example.Foo.bar;
  // import com.example.*;
  const importRe =
    /^import\s+(static\s+)?([\w.*]+)\s*;?$/gm;
  let match: RegExpExecArray | null;
  while ((match = importRe.exec(content)) !== null) {
    const fqn = match[2];
    const isWildcard = fqn.endsWith('.*');
    const parts = fqn.replace(/\.\*$/, '').split('.');
    const lastName = parts[parts.length - 1];

    if (isWildcard) {
      // import com.example.* — any class from that package
      // We register the package root for wildcard resolution
      mappings.push({
        localName: lastName + '.*',
        modulePath: fqn.replace(/\.\*$/, ''),
      });
    } else {
      // import com.example.Foo; — local name is the final class name
      mappings.push({
        localName: lastName,
        modulePath: fqn,
      });
    }
  }

  return mappings;
}

// ── Go ──────────────────────────────────────────────────────────────────

function extractGoImports(
  _filePath: string,
  content: string,
  _language: GraphLanguage,
): ImportMapping[] {
  const mappings: ImportMapping[] = [];

  // Handle two forms:
  //   import "pkg/path"
  //   import ( "pkg1" \n "pkg2" )
  const importBlockRe = /import\s*\(\s*([\s\S]*?)\)/g;
  const singleImportRe = /import\s+("[\w./-]+")(?:\s+\/\/(.*))?/g;
  const importPathRe = /"([\w./-]+)"/g;

  // Single-line imports
  let match: RegExpExecArray | null;
  while ((match = singleImportRe.exec(content)) !== null) {
    const rawPath = match[1].replace(/"/g, '');
    const parts = rawPath.split('/');
    const lastName = parts[parts.length - 1];
    mappings.push({ localName: lastName, modulePath: rawPath });

    // Aliased import: import alias "pkg/path"
    const aliasMatch = new RegExp(
      `import\\s+(\\w+)\\s+"${rawPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`,
    ).exec(content);
    if (aliasMatch) {
      // Update the existing mapping with alias
      const existing = mappings.find((m) => m.modulePath === rawPath);
      if (existing) {
        existing.localName = aliasMatch[1];
      }
    }
  }

  // Block imports
  while ((match = importBlockRe.exec(content)) !== null) {
    const block = match[1];
    let pathMatch: RegExpExecArray | null;

    // Aliased line: alias "pkg/path"
    const aliasLineRe = /(\w+)\s+"([\w./-]+)"/g;
    while ((pathMatch = aliasLineRe.exec(block)) !== null) {
      mappings.push({ localName: pathMatch[1], modulePath: pathMatch[2] });
    }

    // Simple line: "pkg/path"
    const pathOnlyRe = /^\s*"([\w./-]+)"/gm;
    while ((pathMatch = pathOnlyRe.exec(block)) !== null) {
      const rawPath = pathMatch[1];
      const parts = rawPath.split('/');
      const lastName = parts[parts.length - 1];
      // Don't overwrite aliased entries
      if (!mappings.find((m) => m.modulePath === rawPath)) {
        mappings.push({ localName: lastName, modulePath: rawPath });
      }
    }
  }

  return mappings;
}

// ── Rust ────────────────────────────────────────────────────────────────

function extractRustImports(
  _filePath: string,
  content: string,
  _language: GraphLanguage,
): ImportMapping[] {
  const mappings: ImportMapping[] = [];

  // use crate::foo::bar;
  // use std::collections::HashMap;
  // use std::collections::*;
  // use std::collections::{HashMap, HashSet};
  // use super::foo::bar;
  // use self::foo::bar;

  // Handle grouped imports: use path::{A, B, C}
  const groupRe = /use\s+([\w:]+(?:::[\w:]+)*)::\{([^}]+)\}/g;
  let match: RegExpExecArray | null;
  while ((match = groupRe.exec(content)) !== null) {
    const basePath = match[1];
    const body = match[2];
    const names = body.split(',').map((s) => s.trim()).filter((n) => n.length > 0 && n !== '*');
    for (const name of names) {
      // Handle "self" in group: use std::collections::{self, HashMap}
      let localName = name;
      if (name === 'self') {
        localName = basePath.split('::').pop()!;
      }
      mappings.push({
        localName,
        modulePath: `${basePath}::${name}`,
      });
    }
  }

  // Simple use statements
  const useRe = /use\s+([\w:]+(?:::[\w:]+)*)(?:\s+as\s+(\w+))?\s*;/g;
  while ((match = useRe.exec(content)) !== null) {
    const fullPath = match[1];
    const alias = match[2];
    const parts = fullPath.split('::');

    // Handle wildcard: use std::collections::*
    if (parts[parts.length - 1] === '*') {
      mappings.push({
        localName: parts[parts.length - 2] + '.*',
        modulePath: parts.slice(0, -1).join('::'),
      });
    } else {
      const lastName = alias || parts[parts.length - 1];
      mappings.push({
        localName: lastName,
        modulePath: fullPath,
      });
    }
  }

  // Map Rust crate paths to filesystem paths
  for (const mapping of mappings) {
    mapping.modulePath = mapping.modulePath.replace(/^crate::/, 'src/');
    mapping.modulePath = mapping.modulePath.replace(/^super::/, '../');
    mapping.modulePath = mapping.modulePath.replace(/^self::/, './');
    mapping.modulePath = mapping.modulePath.replace(/::/g, '/');
  }

  return mappings;
}

// ── C/C++ ───────────────────────────────────────────────────────────────

function extractCppImports(
  _filePath: string,
  content: string,
  _language: GraphLanguage,
): ImportMapping[] {
  const mappings: ImportMapping[] = [];

  // #include "foo.h"
  // #include <bar>
  const includeRe = /#include\s+[<"]([^>"]+)[>"]/g;
  let match: RegExpExecArray | null;
  while ((match = includeRe.exec(content)) !== null) {
    const includePath = match[1];
    // Extract a local name from the header filename
    const basename = path.basename(includePath, path.extname(includePath));
    // Normalize: foo/bar → the module provides bar
    const localName = basename.replace(/[-.]/g, '_');

    mappings.push({ localName, modulePath: includePath });
  }

  return mappings;
}

// ── C# ──────────────────────────────────────────────────────────────────

function extractCSharpImports(
  _filePath: string,
  content: string,
  _language: GraphLanguage,
): ImportMapping[] {
  const mappings: ImportMapping[] = [];

  // using Foo.Bar;
  // using static Foo.Bar.Baz;
  // using Foo = System.Foo.Bar;  (alias directive)
  const usingRe = /using\s+(static\s+)?([\w.]+)(?:\s*=\s*([\w.]+))?\s*;/g;
  let match: RegExpExecArray | null;
  while ((match = usingRe.exec(content)) !== null) {
    const fullNamespace = match[2];
    const aliasTarget = match[3];
    const parts = fullNamespace.split('.');
    const lastName = parts[parts.length - 1];

    if (aliasTarget) {
      // using alias = fully.qualified.name;
      mappings.push({
        localName: lastName,
        modulePath: aliasTarget,
      });
    } else {
      mappings.push({
        localName: lastName,
        modulePath: fullNamespace,
      });
    }
  }

  return mappings;
}
