/**
 * Name-matching strategies for resolving UnresolvedReferences when import
 * resolution does not apply or produces ambiguous results.
 *
 * Multi-strategy pipeline (ordered by confidence):
 *   1. Same-file match  (0.90) — search for a definition in the same file
 *   2. Unique-name match (0.75) — exactly one node across the project
 *   3. Qualified suffix  (0.55) — callee contains dots/::, try tail matching
 *   4. Fuzzy match       (0.40) — case-insensitive, partial prefix, etc.
 *
 * Also includes built-in blacklists per language to prevent resolving
 * standard library / runtime builtins that should never become edges.
 */
import {
  GraphNode,
  GraphNodeKind,
  GraphLanguage,
  GraphEdgeKind,
  UnresolvedReference,
  ResolvedRef,
  isCallableKind,
} from '../types';
import { ResolutionContext } from './import-resolver';

// ── Language built-in blacklists ─────────────────────────────────────────
// These names are NEVER resolved into graph edges — they represent
// language runtime / standard library / global scope identifiers.

const JS_BUILTINS = new Set([
  // Globals
  'console', 'window', 'document', 'global', 'globalThis', 'self', 'top',
  'navigator', 'location', 'history', 'localStorage', 'sessionStorage',
  'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource',
  'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
  'requestAnimationFrame', 'cancelAnimationFrame',
  'queueMicrotask', 'structuredClone',
  // Core types
  'Promise', 'Array', 'Object', 'String', 'Number', 'Boolean', 'Symbol',
  'BigInt', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Date', 'RegExp',
  'Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError',
  'EvalError', 'URIError', 'AggregateError',
  'ArrayBuffer', 'DataView', 'Int8Array', 'Uint8Array', 'Uint8ClampedArray',
  'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array',
  'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array',
  'SharedArrayBuffer', 'Atomics',
  'Intl', 'JSON', 'Math',
  'Proxy', 'Reflect',
  'Function', 'Generator', 'AsyncFunction', 'AsyncGenerator',
  'Iterator', 'AsyncIterator', 'GeneratorFunction',
  // Crypto / Encoding
  'crypto', 'Crypto', 'SubtleCrypto', 'TextEncoder', 'TextDecoder',
  'atob', 'btoa',
  // Node.js-specific
  'require', 'module', 'exports', '__dirname', '__filename',
  'process', 'Buffer', 'setImmediate', 'clearImmediate',
  // Common libraries (populated set can be extended)
  'React', 'useState', 'useEffect', 'useCallback', 'useMemo', 'useRef',
  'useContext', 'useReducer', 'useLayoutEffect', 'useImperativeHandle',
  'useDebugValue', 'useTransition', 'useDeferredValue', 'useId',
  'createContext', 'createElement', 'cloneElement', 'isValidElement',
  'forwardRef', 'lazy', 'memo', 'startTransition', 'Suspense',
  'Component', 'PureComponent', 'Fragment',
]);

const PYTHON_BUILTINS = new Set([
  // Builtins
  'print', 'len', 'range', 'str', 'int', 'float', 'list', 'dict', 'set',
  'tuple', 'bool', 'bytes', 'bytearray', 'memoryview', 'complex',
  'object', 'type', 'super', 'self', 'cls',
  'isinstance', 'issubclass', 'hasattr', 'getattr', 'setattr', 'delattr',
  'dir', 'vars', 'locals', 'globals', 'callable',
  'id', 'hash', 'repr', 'chr', 'ord', 'bin', 'oct', 'hex',
  'input', 'open', 'iter', 'next', 'enumerate', 'zip', 'map', 'filter',
  'reversed', 'sorted', 'all', 'any', 'min', 'max', 'sum', 'abs', 'round',
  'pow', 'divmod', 'format',
  'slice', 'staticmethod', 'classmethod', 'property',
  '__import__', '__builtins__', '__name__', '__file__', '__doc__',
  'Exception', 'ValueError', 'TypeError', 'KeyError', 'IndexError',
  'AttributeError', 'RuntimeError', 'StopIteration', 'OSError',
  'NotImplementedError',
  'True', 'False', 'None',
  'io', 'os', 'sys', 're', 'json',
  // Common lib
  'logging', 'datetime', 'collections', 'itertools', 'functools',
  'pathlib', 'typing', 'dataclasses', 'enum', 'abc',
  'Any', 'Optional', 'Union', 'Callable', 'List', 'Dict', 'Tuple', 'Set',
  'Literal', 'TypeVar', 'Generic', 'Protocol',
  'self',
]);

const GO_BUILTINS = new Set([
  // Builtins
  'make', 'len', 'cap', 'append', 'copy', 'delete', 'close',
  'panic', 'recover', 'print', 'println',
  'new', 'complex', 'real', 'imag',
  'true', 'false', 'nil', 'iota',
  // Common standard library short names
  'fmt', 'os', 'io', 'net', 'http', 'sync', 'time', 'context',
  'errors', 'strings', 'strconv', 'bytes', 'json', 'yaml',
  'sort', 'math', 'rand', 'regexp', 'testing',
  'runtime', 'reflect', 'unsafe',
  'File', 'Reader', 'Writer', 'ReadWriter', 'Closer',
  'string', 'int', 'int64', 'int32', 'float64', 'float32',
  'uint', 'uint64', 'uint32', 'byte', 'rune',
  'bool', 'error', 'interface', 'map', 'chan', 'struct',
]);

const C_CPP_BUILTINS = new Set([
  // C standard library
  'printf', 'scanf', 'fprintf', 'sprintf', 'snprintf',
  'fopen', 'fclose', 'fread', 'fwrite', 'fseek', 'ftell', 'rewind',
  'malloc', 'calloc', 'realloc', 'free',
  'memcpy', 'memmove', 'memset', 'memcmp', 'memchr',
  'strcpy', 'strncpy', 'strcat', 'strncat', 'strcmp', 'strncmp',
  'strlen', 'strchr', 'strrchr', 'strstr', 'strtok',
  'atoi', 'atol', 'atoll', 'atof',
  'qsort', 'bsearch', 'abs', 'labs', 'llabs',
  'rand', 'srand', 'time', 'clock',
  'exit', 'abort', 'atexit', 'system', 'getenv',
  'signal', 'raise',
  'assert',
  // C++ standard library
  'std', 'cout', 'cin', 'cerr', 'clog', 'endl',
  'vector', 'map', 'set', 'list', 'deque', 'queue', 'stack',
  'string', 'wstring', 'stringstream', 'ostringstream', 'istringstream',
  'unique_ptr', 'shared_ptr', 'weak_ptr', 'make_unique', 'make_shared',
  'thread', 'mutex', 'lock_guard', 'unique_lock', 'condition_variable',
  'function', 'bind', 'move', 'forward',
  'pair', 'tuple', 'optional', 'variant', 'any',
  'ifstream', 'ofstream', 'fstream',
  'chrono', 'filesystem',
  'nullptr', 'NULL', 'size_t', 'ptrdiff_t',
]);

const JAVA_BUILTINS = new Set([
  // java.lang.* (auto-imported)
  'System', 'String', 'Integer', 'Long', 'Double', 'Float', 'Boolean',
  'Byte', 'Short', 'Character', 'Math', 'StrictMath',
  'Object', 'Class', 'Thread', 'Runnable', 'Throwable',
  'Exception', 'RuntimeException', 'Error',
  'StringBuilder', 'StringBuffer',
  'Override', 'SuppressWarnings', 'Deprecated',
  // java.util.* commonly used
  'List', 'Map', 'Set', 'Queue', 'Deque', 'Stack', 'Vector',
  'ArrayList', 'LinkedList', 'HashMap', 'TreeMap', 'HashSet', 'TreeSet',
  'Collections', 'Arrays', 'Optional', 'OptionalInt', 'OptionalDouble',
  'Objects', 'Comparator', 'Comparable', 'Iterator', 'Iterable',
  'Stream', 'Collectors',
  // Common
  'this', 'super', 'null', 'enum',
]);

const RUST_BUILTINS = new Set([
  // Prelude
  'Vec', 'String', 'Option', 'Result', 'Some', 'None', 'Ok', 'Err',
  'println', 'print', 'eprintln', 'eprint',
  'format', 'write', 'writeln',
  'Box', 'Rc', 'Arc', 'Cell', 'RefCell', 'Mutex', 'RwLock',
  'HashMap', 'HashSet', 'BTreeMap', 'BTreeSet',
  'VecDeque', 'LinkedList', 'BinaryHeap',
  'Drop', 'Copy', 'Clone', 'Debug', 'Display', 'PartialEq', 'Eq',
  'PartialOrd', 'Ord', 'Hash', 'Default', 'From', 'Into', 'TryFrom',
  'TryInto', 'AsRef', 'AsMut', 'Deref', 'DerefMut',
  'Iterator', 'IntoIterator', 'ExactSizeIterator', 'DoubleEndedIterator',
  'Fn', 'FnMut', 'FnOnce',
  'self', 'Self', 'super', 'crate',
  'std', 'core', 'alloc',
  'i8', 'i16', 'i32', 'i64', 'i128', 'isize',
  'u8', 'u16', 'u32', 'u64', 'u128', 'usize',
  'f32', 'f64', 'bool', 'char', 'str',
  'true', 'false',
  'panic', 'assert', 'assert_eq', 'assert_ne', 'dbg', 'todo', 'unimplemented',
  'unreachable',
]);

const CSHARP_BUILTINS = new Set([
  // System namespace (auto-imported with implicit usings in modern .NET)
  'System', 'Console', 'String', 'Int32', 'Int64', 'Double', 'Single',
  'Boolean', 'Byte', 'Char', 'Decimal', 'DateTime', 'TimeSpan',
  'Guid', 'Uri', 'Exception', 'ApplicationException',
  'List', 'Dictionary', 'HashSet', 'Queue', 'Stack', 'LinkedList',
  'IEnumerable', 'ICollection', 'IList', 'IDictionary',
  'Enumerable', 'Array', 'Math', 'Random',
  'Task', 'Task`1', 'ValueTask', 'CancellationToken',
  'Func', 'Action', 'Predicate', 'EventHandler',
  'LINQ', 'Queryable',
  'null', 'this', 'base',
  'var', 'object', 'dynamic', 'typeof', 'nameof', 'sizeof',
  'async', 'await',
  // ASP.NET Core
  'Controller', 'ControllerBase', 'ApiController',
  'HttpGet', 'HttpPost', 'HttpPut', 'HttpDelete', 'HttpPatch',
  'FromBody', 'FromQuery', 'FromRoute', 'FromHeader', 'FromServices',
]);

/** Master blacklist map by language. */
const BUILTIN_BLACKLISTS: Record<string, Set<string>> = {
  javascript: JS_BUILTINS,
  typescript: JS_BUILTINS,
  python: PYTHON_BUILTINS,
  go: GO_BUILTINS,
  cpp: C_CPP_BUILTINS,
  java: JAVA_BUILTINS,
  rust: RUST_BUILTINS,
  csharp: CSHARP_BUILTINS,
  scala: JAVA_BUILTINS, // Java + Scala share many common types
};

/**
 * Above this many same-named candidates, a suffix match with nothing to
 * disambiguate it is treated as unresolvable rather than resolved to an
 * arbitrary one. See matchSuffixName for the measured rationale.
 */
const SUFFIX_AMBIGUITY_CAP = 12;

/** Node kinds that are considered "definition" targets for CALLS edges. */
const DEFINITION_KINDS = new Set<GraphNodeKind>([
  'function',
  'method',
  'class',
  'struct',
  'interface',
  'trait',
  'enum',
  'type_alias',
  'module',
  'variable',
  'constant',
]);

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Resolve a reference by matching its name against known symbols.
 *
 * Multi-strategy pipeline executed in confidence order.
 * Returns the first successful match, or null if unresolvable.
 */
export function matchReference(
  ref: UnresolvedReference,
  context: ResolutionContext,
): ResolvedRef | null {
  const language = ref.language || 'javascript';

  // 内置黑名单挡的是"名字撞上标准库"的猜测式匹配。只对继承边放开：基类/接口名不可能
  // 是内置函数，真正的标准库基类在提取层的 BASE_TYPE_BLACKLIST 已经过滤过。
  // 不放开的后果是通用性缺口而非 Go 特有：GO_BUILTINS 里有 Reader/Writer/File/Closer，
  // 任何自己定义 `type Reader interface` 的 Go 仓库都拿不到嵌入继承边。
  // 调用边不放开 —— 试过，是负收益：Python 的 `set(kwargs)` 会被同文件另一个测试里的
  // `def set()` 接住，flask/requests 各多 3 条边，只有 1 条（`self.set`）是对的。
  const blacklisted = isBlacklistedBuiltin(ref.referenceName, language);
  const isHeritage = ref.referenceKind === 'extends' || ref.referenceKind === 'implements';
  if (blacklisted && !isHeritage) return null;

  // Strategy 1: Same-file match
  const sameFile = matchSameFile(ref, context);
  if (sameFile) return sameFile;

  // Strategy 2: Unique name across project
  const uniqueName = matchUniqueName(ref, context);
  if (uniqueName) return uniqueName;

  if (blacklisted) return null;

  // Strategy 2.5: Suffix name match — for intra-class calls like `this.calculateOrderTotal()`
  // The node is stored as "OrderService.calculateOrderTotal" but the ref has "calculateOrderTotal"
  const suffixName = matchSuffixName(ref, context);
  if (suffixName) return suffixName;

  // Strategy 3: Qualified suffix match
  const suffixMatch = matchQualifiedSuffix(ref, context);
  if (suffixMatch) return suffixMatch;

  // Strategy 4: Fuzzy match — O(n²) full-scan of all files in JS.
  // Only enabled when prior strategies returned nothing. For TS/JS projecs
  // the suffix-name strategy already handles class-qualified method lookups.
  // Re-enable when case-insensitive matching adds value (PHP, SQL dialects).
  // const fuzzy = matchFuzzy(ref, context);
  // if (fuzzy) return fuzzy;

  return null;
}

/**
 * Resolve a method call (obj.method()) by receiver type inference.
 *
 * Strategy:
 *   1. Identify the receiver (obj).
 *   2. Find the type/class of the receiver in the same file.
 *   3. Look for a method definition within that class across the project.
 */
export function matchMethodCall(
  ref: UnresolvedReference,
  context: ResolutionContext,
): ResolvedRef | null {
  const refName = ref.referenceName;
  const language = ref.language || 'javascript';

  // Method calls are typically dotted: obj.method
  const dotIndex = refName.indexOf('.');
  if (dotIndex <= 0) return null;

  const receiverName = refName.slice(0, dotIndex);
  const methodName = refName.slice(dotIndex + 1);

  if (isBlacklistedBuiltin(receiverName, language)) return null;
  if (isBlacklistedBuiltin(methodName, language)) return null;

  // Find the receiver type in the same file first
  const refFile = ref.filePath;
  if (!refFile) return null;

  const fileNodes = context.getNodesInFile(refFile);

  // Try to find receiver as a variable or parameter
  const receiverNode = fileNodes.find(
    (n) =>
      n.name === receiverName &&
      (n.kind === 'variable' || n.kind === 'parameter' || n.kind === 'field' || n.kind === 'property'),
  );

  let receiverType: string | undefined;

  if (receiverNode) {
    // If the receiver has a returnType annotation, use it
    receiverType = receiverNode.returnType || undefined;

    // Try to infer type from the variable's qualified name or signature
    if (!receiverType && receiverNode.signature) {
      // JS/TS: const x: Foo = ...
      // Python: x: Foo
      const typeHints = receiverNode.signature.match(/:\s*(\w+)/);
      if (typeHints) {
        receiverType = typeHints[1];
      }
    }
  } else {
    // Receiver might be a class name used as a constructor
    receiverType = receiverName;
  }

  if (!receiverType) return null;

  // Search for a method on the receiver type across all files
  const allFiles = context.getAllFiles();
  for (const file of allFiles) {
    const nodes = context.getNodesInFile(file);
    for (const node of nodes) {
      if (
        node.name === methodName &&
        isCallableKind(node.kind) &&
        node.qualifiedName.includes(receiverType)
      ) {
        return {
          original: ref,
          targetNodeId: node.id,
          resolvedBy: 'method-call-inference',
          confidence: 0.80,
        };
      }
    }
  }

  // Looser match: just find the method name within a class definition
  // that matches the receiver type
  const methodCandidates = context.getNodesByName(methodName);
  for (const cand of methodCandidates) {
    if (
      isCallableKind(cand.kind) &&
      cand.qualifiedName.includes(receiverType)
    ) {
      return {
        original: ref,
        targetNodeId: cand.id,
        resolvedBy: 'method-call-loose',
        confidence: 0.65,
      };
    }
  }

  return null;
}

// ── Strategy implementations ─────────────────────────────────────────────

/**
 * Strategy 1: Same-file match.
 *
 * Search for a definition of the referenced name within the same file.
 * This is the most reliable and lowest-cost strategy.
 */
function matchSameFile(
  ref: UnresolvedReference,
  context: ResolutionContext,
): ResolvedRef | null {
  const refFile = ref.filePath;
  if (!refFile) return null;

  const fileNodes = context.getNodesInFile(refFile);
  if (fileNodes.length === 0) return null;

  const refName = ref.referenceName;

  // Strip receiver prefix for method calls
  const searchName = stripReceiver(refName);

  // Exact name match in the same file
  const exactMatches = fileNodes.filter(
    (n) => n.name === searchName && DEFINITION_KINDS.has(n.kind),
  );

  if (exactMatches.length === 1) {
    return {
      original: ref,
      targetNodeId: exactMatches[0].id,
      resolvedBy: 'same-file-exact',
      confidence: 0.90,
    };
  }

  if (exactMatches.length > 1) {
    // Multiple definitions with same name in same file — prefer the one
    // that's closest in scope (closest line number)
    const sorted = exactMatches.sort(
      (a, b) => Math.abs(a.startLine - ref.line) - Math.abs(b.startLine - ref.line),
    );
    return {
      original: ref,
      targetNodeId: sorted[0].id,
      resolvedBy: 'same-file-closest-scope',
      confidence: 0.85,
    };
  }

  // Try matching simple name without scope
  // JavaScript: caller `foo()` might match function `foo` or const `foo`
  const broadMatches = fileNodes.filter(
    (n) => n.name === searchName,
  );

  if (broadMatches.length === 1) {
    return {
      original: ref,
      targetNodeId: broadMatches[0].id,
      resolvedBy: 'same-file-broad',
      confidence: 0.80,
    };
  }

  return null;
}

/**
 * Strategy 2: Unique name across project.
 *
 * If exactly one node in the entire project has the referenced name
 * (and it's a definition kind), match it.
 */
function matchUniqueName(
  ref: UnresolvedReference,
  context: ResolutionContext,
): ResolvedRef | null {
  const refName = stripReceiver(ref.referenceName);

  const candidates = context.getNodesByName(refName);
  const definitionCandidates = candidates.filter((n) => DEFINITION_KINDS.has(n.kind));

  if (definitionCandidates.length === 1) {
    return {
      original: ref,
      targetNodeId: definitionCandidates[0].id,
      resolvedBy: 'unique-name',
      confidence: 0.75,
    };
  }

  // If there is exactly one node total (any kind), still match but lower confidence
  if (definitionCandidates.length === 0 && candidates.length === 1) {
    return {
      original: ref,
      targetNodeId: candidates[0].id,
      resolvedBy: 'unique-name-any-kind',
      confidence: 0.60,
    };
  }

  return null;
}

/**
 * Strategy 2.5: Suffix name match for intra-class method calls.
 *
 * `this.calculateOrderTotal()` → ref name "calculateOrderTotal"
 * DB stores "OrderService.calculateOrderTotal" → try suffix match.
 * Only for simple names (no dots / ::).
 */
function matchSuffixName(
  ref: UnresolvedReference,
  context: ResolutionContext,
): ResolvedRef | null {
  const refName = ref.referenceName;
  if (refName.includes('.') || refName.includes('::')) return null;

  // Try ref's own file first (intra-class calls are always same-file)
  let matches: GraphNode[] = [];
  if (ref.filePath) {
    const ownNodes = context.getNodesInFile(ref.filePath);
    for (const node of ownNodes) {
      if (
        DEFINITION_KINDS.has(node.kind) &&
        (node.name === refName || node.name.endsWith('.' + refName))
      ) {
        matches.push(node);
      }
    }
  }

  // Fallback: indexed suffix lookup — finds "ClassName.methodName"
  // from refName "methodName" without scanning all files in JS.
  if (matches.length === 0) {
    matches = context.getNodesBySuffix(refName).filter((n) =>
      DEFINITION_KINDS.has(n.kind),
    );
  }

  if (matches.length === 1) {
    return {
      original: ref,
      targetNodeId: matches[0].id,
      resolvedBy: 'suffix-name',
      confidence: 0.70,
    };
  }

  // Overloads: multiple same-named definitions (toJson ×8). Without parameter
  // type info we can't pick the exact overload, but resolving to ONE of them is
  // far better than no edge at all — it anchors the call into the right class/
  // file so call-graph traversal stays useful. Prefer a same-file match, then
  // the first by id. Lower confidence reflects the ambiguity.
  if (matches.length > 1) {
    const sameFile = ref.filePath ? matches.filter(n => n.filePath === ref.filePath) : [];
    // Past a point "one of N" stops anchoring anything. A C++ repo yields names
    // with hundreds of same-named definitions (measured: basic_string ×15611,
    // CPPTEST_TEST ×10680); picking the lowest id there invents an edge into an
    // arbitrary unrelated file, and scoring the whole pool on every one of
    // thousands of references is what made resolution the slowest phase. With no
    // same-file candidate to disambiguate, no edge beats a fabricated one.
    if (sameFile.length === 0 && matches.length > SUFFIX_AMBIGUITY_CAP) return null;
    const pool = sameFile.length > 0 ? sameFile : matches;
    const target = pool.reduce((a, b) => (a.id < b.id ? a : b));
    return {
      original: ref,
      targetNodeId: target.id,
      resolvedBy: 'suffix-name-overload',
      confidence: 0.55,
    };
  }

  return null;
}

/**
 * Strategy 3: Qualified suffix match.
 *
 * If the reference name contains dots (Python/JS) or ::(Rust/C++),
 * try to match by the last component against qualified names.
 *
 * Example: ref "os.path.join" — suffix match for nodes whose
 * qualified name ends with ".path.join" or ".os.path.join".
 */
function matchQualifiedSuffix(
  ref: UnresolvedReference,
  context: ResolutionContext,
): ResolvedRef | null {
  const refName = ref.referenceName;

  // Detect qualified references
  const hasDots = refName.includes('.');
  const hasColons = refName.includes('::');

  if (!hasDots && !hasColons) return null;

  const separator = hasColons ? '::' : '.';
  const parts = refName.split(separator);
  const lastName = parts[parts.length - 1];

  // Search by the last component name
  const candidates = context.getNodesByName(lastName);
  const defCandidates = candidates.filter((n) => DEFINITION_KINDS.has(n.kind));

  if (defCandidates.length === 0) return null;

  // Try full suffix match: e.g. ref "a.b.c" matches qualifiedName "...a.b.c"
  const normalizedRefPath = parts.join('.'); // Normalize :: to .
  const fullSuffixMatches = defCandidates.filter((n) => {
    const normalizedQN = n.qualifiedName.replace(/::/g, '.');
    return normalizedQN.endsWith(normalizedRefPath);
  });

  if (fullSuffixMatches.length === 1) {
    return {
      original: ref,
      targetNodeId: fullSuffixMatches[0].id,
      resolvedBy: 'qualified-suffix-full',
      confidence: 0.70,
    };
  }

  if (fullSuffixMatches.length > 1) {
    // Prefer exported or public nodes
    const exported = fullSuffixMatches.filter((n) => n.isExported);
    if (exported.length === 1) {
      return {
        original: ref,
        targetNodeId: exported[0].id,
        resolvedBy: 'qualified-suffix-exported',
        confidence: 0.65,
      };
    }
  }

  // Partial suffix: match last 2 components
  if (parts.length >= 2) {
    const penult = parts[parts.length - 2];
    const partialSuffix = `${penult}.${lastName}`;
    const partialMatches = defCandidates.filter((n) => {
      const normalizedQN = n.qualifiedName.replace(/::/g, '.');
      return normalizedQN.endsWith(partialSuffix);
    });

    if (partialMatches.length === 1) {
      return {
        original: ref,
        targetNodeId: partialMatches[0].id,
        resolvedBy: 'qualified-suffix-partial',
        confidence: 0.55,
      };
    }
  }

  return null;
}

/**
 * Strategy 4: Fuzzy match.
 *
 * Last-resort strategy. Case-insensitive matching, prefix matching,
 * and name similarity heuristics.
 */
function matchFuzzy(
  ref: UnresolvedReference,
  context: ResolutionContext,
): ResolvedRef | null {
  const refName = stripReceiver(ref.referenceName).toLowerCase();

  // Case-insensitive match across all files
  // (getNodesByName is case-sensitive, so we iterate files)
  const allFiles = context.getAllFiles();
  const caseInsensitiveMatches: GraphNode[] = [];

  for (const file of allFiles) {
    const nodes = context.getNodesInFile(file);
    for (const node of nodes) {
      if (
        node.name.toLowerCase() === refName &&
        DEFINITION_KINDS.has(node.kind)
      ) {
        caseInsensitiveMatches.push(node);
      }
    }
    // Early exit if we have too many candidates
    if (caseInsensitiveMatches.length > 10) break;
  }

  if (caseInsensitiveMatches.length === 1) {
    return {
      original: ref,
      targetNodeId: caseInsensitiveMatches[0].id,
      resolvedBy: 'fuzzy-case-insensitive',
      confidence: 0.40,
    };
  }

  // Prefix match: ref "getUser" matches node "getUserName" or "getUserProfile"
  if (refName.length >= 5) {
    // Only try prefix matching for reasonably long names to avoid noise
    const prefixMatches: GraphNode[] = [];
    for (const file of allFiles) {
      const nodes = context.getNodesInFile(file);
      for (const node of nodes) {
        if (
          node.name.toLowerCase().startsWith(refName) &&
          node.name.length > refName.length &&
          DEFINITION_KINDS.has(node.kind)
        ) {
          prefixMatches.push(node);
        }
      }
      if (prefixMatches.length > 10) break;
    }

    if (prefixMatches.length === 1) {
      return {
        original: ref,
        targetNodeId: prefixMatches[0].id,
        resolvedBy: 'fuzzy-prefix',
        confidence: 0.35,
      };
    }
  }

  return null;
}

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * Check if a name is a built-in that should never be resolved.
 */
export function isBlacklistedBuiltin(
  name: string,
  language: GraphLanguage,
): boolean {
  const blacklist = BUILTIN_BLACKLISTS[language];
  if (!blacklist) return false;

  if (blacklist.has(name)) return true;

  // Also check the last component of dotted names
  if (name.includes('.')) {
    const lastPart = name.split('.').pop()!;
    if (blacklist.has(lastPart)) return true;
  }

  return false;
}

/**
 * Strip the receiver prefix from a method call reference name.
 *
 * E.g. "obj.method" → "method", but "simpleFunc" → "simpleFunc"
 * Also handles :: separators (Rust, C++).
 */
function stripReceiver(name: string): string {
  // Don't strip if the dotted name looks like a module path (e.g. "os.path.join")
  // Only strip if the first part looks like a variable/instance name
  const dotIndex = name.indexOf('.');
  if (dotIndex > 0) {
    const firstPart = name.slice(0, dotIndex);
    // If the first part starts with lowercase and the rest looks like a method call,
    // strip the receiver
    if (/^[a-z_]\w*$/.test(firstPart)) {
      return name.slice(dotIndex + 1);
    }
  }
  return name;
}
