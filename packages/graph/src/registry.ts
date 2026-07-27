/**
 * FunctionRegistry — O(1) function resolution for cross-file call analysis.
 *
 * TS port of codebase-memory-mcp's registry.c.
 * Provides a 4-step strategy chain for resolving callee names to
 * qualified names, using an in-memory hash table.
 *
 * Strategy chain (exact mirror of cbm_registry_resolve):
 *   1. import_map: find prefix in import map → build candidate QN → exact match
 *   2. same_module: moduleQN.calleeName → exact match
 *   3.5. qualified_suffix: multi-candidate disambiguation by full tail
 *   3. unique_name: single candidate by simple name
 *   4. suffix_match: multiple candidates, filtered by import reachability
 *
 * Confidence values match the C implementation exactly.
 */
import { GraphNodeLabel } from './types';

// ── Confidence constants (matching registry.c) ────────────────────

const CONF_IMPORT_MAP = 0.95;
const CONF_IMPORT_MAP_SUFFIX = 0.85;
const CONF_SAME_MODULE = 0.90;
const CONF_QUALIFIED_SUFFIX = 0.90;
const CONF_UNIQUE_NAME = 0.75;
const CONF_SUFFIX_MATCH = 0.55;
const CONF_FUZZY_SINGLE = 0.40;
const CONF_FUZZY_MULTI = 0.30;

// ── Other constants ────────────────────────────────────────────────

const REG_MAX_CANDIDATES = 256;
const TEST_PENALTY = 1000;
const CANDIDATE_PENALTY_CAP = 5.0;

// ── Types ─────────────────────────────────────────────────────────

export interface RegistryEntry {
    name: string;
    qualifiedName: string;
    label: GraphNodeLabel;
}

export interface RegistryResolutionResult {
    qualifiedName: string;
    strategy: string;
    confidence: number;
    candidateCount: number;
}

export interface FuzzyResult {
    qualifiedName: string;
    confidence: number;
    resolved: boolean;
}

// ── Helpers ────────────────────────────────────────────────────────

/** Extract the simple name (last segment after the last dot or ::). */
function simpleName(qn: string): string {
    const dotIdx = qn.lastIndexOf('.');
    const colonIdx = qn.lastIndexOf('::');
    const idx = Math.max(dotIdx, colonIdx);
    if (idx >= 0) {
        return qn.slice(idx + (colonIdx > dotIdx ? 2 : 1));
    }
    return qn;
}

/** Count common dot-separated prefix segments. */
function commonPrefixLen(a: string, b: string): number {
    if (!a || !b) return 0;
    const aParts = a.split('.');
    const bParts = b.split('.');
    let count = 0;
    const minLen = Math.min(aParts.length, bParts.length);
    for (let i = 0; i < minLen; i++) {
        if (aParts[i] !== bParts[i]) break;
        count++;
    }
    return count;
}

/** Check if a qualified name looks like a test/mock path. */
function isTestQN(qn: string): boolean {
    return /[Tt]est|[Mm]ock|[Ss]tub|[Ff]ake|[Ff]ixture|spec/.test(qn);
}

/** Score a candidate for tiebreaking. Higher = better.
 *  Layer 1: Non-test code preferred (+1000)
 *  Layer 2: Namespace proximity via common prefix length */
function candidateScore(candidateQN: string, moduleQN: string): number {
    let score = 0;
    if (!isTestQN(candidateQN)) {
        score += TEST_PENALTY;
    }
    score += commonPrefixLen(candidateQN, moduleQN);
    return score;
}

/** Pick candidate with highest composite score. */
function bestByImportDistance(
    candidates: string[],
    moduleQN: string,
): string | null {
    let best: string | null = null;
    let bestScore = -1;
    for (const c of candidates) {
        const score = candidateScore(c, moduleQN);
        if (score > bestScore) {
            bestScore = score;
            best = c;
        }
    }
    return best;
}

/** Check if a candidate QN is reachable via any import value.
 *  A candidate is reachable if its module prefix is a substring of
 *  any import value, or vice versa. */
function isImportReachable(
    candidateQN: string,
    importVals: string[],
): boolean {
    if (importVals.length === 0) return false;

    // Extract module prefix (everything before last dot)
    const lastDot = candidateQN.lastIndexOf('.');
    const candMod = lastDot >= 0 ? candidateQN.slice(0, lastDot) : candidateQN;

    for (const imp of importVals) {
        if (candMod.includes(imp) || imp.includes(candMod)) {
            return true;
        }
    }
    return false;
}

/** Scale confidence inversely with candidate count. */
function candidateCountPenalty(base: number, count: number): number {
    if (count <= 1) return base;
    return base * Math.min(1.0, CANDIDATE_PENALTY_CAP / count);
}

/** Empty resolution result. */
function emptyResult(): RegistryResolutionResult {
    return { qualifiedName: '', strategy: '', confidence: 0, candidateCount: 0 };
}

// ── FunctionRegistry ───────────────────────────────────────────────

export class FunctionRegistry {
    /** Exact match: qualifiedName → RegistryEntry */
    private exact: Map<string, RegistryEntry> = new Map();
    /** Name index: simpleName → qualifiedName[] */
    private byName: Map<string, string[]> = new Map();

    // ── Registration ──────────────────────────────────────────────

    /** Register a function/method/class. */
    add(name: string, qualifiedName: string, label: GraphNodeLabel): void {
        this.exact.set(qualifiedName, { name, qualifiedName, label });

        const sn = simpleName(qualifiedName);
        let arr = this.byName.get(sn);
        if (!arr) {
            arr = [];
            this.byName.set(sn, arr);
        }
        // Avoid duplicates
        if (!arr.includes(qualifiedName)) {
            arr.push(qualifiedName);
        }
    }

    /** Check if a qualified name exists in the registry. */
    exists(qn: string): boolean {
        return this.exact.has(qn);
    }

    /** Get the label of a qualified name, or null if not found. */
    labelOf(qn: string): GraphNodeLabel | null {
        const entry = this.exact.get(qn);
        return entry ? entry.label : null;
    }

    /** Find all qualified names with a given simple name. */
    findByName(name: string): string[] {
        return [...(this.byName.get(name) ?? [])];
    }

    /** Return total number of entries. */
    size(): number {
        return this.exact.size;
    }

    // ── Core resolution ───────────────────────────────────────────

    /**
     * Resolve a callee name to a qualified name.
     *
     * Strategy chain (mirrors cbm_registry_resolve):
     *   1. import_map: find prefix in import map → build candidate QN
     *   2. same_module: moduleQN.calleeName → exact match
     *   3.5. qualified_suffix: disambiguate by full tail
     *   3. unique_name: single candidate
     *   4. suffix_match: multiple candidates, filtered by import reachability
     *
     * @param calleeName - The callee name (e.g., "pkg.Func", "handleRequest")
     * @param moduleQN - The module qualified name of the calling file
     * @param importMapKeys - Keys from the import map (local names)
     * @param importMapVals - Values from the import map (resolved module QNs)
     */
    resolve(
        calleeName: string,
        moduleQN: string,
        importMapKeys: string[] = [],
        importMapVals: string[] = [],
    ): RegistryResolutionResult {
        // Split callee at the first path separator: "pkg.Func" → prefix="pkg", suffix="Func"
        // Rust/C++ use "::" rather than ".", honor whichever appears first
        let prefix = calleeName;
        let suffix = '';

        const dotIdx = calleeName.indexOf('.');
        const colonIdx = calleeName.indexOf('::');
        let sepIdx = dotIdx;
        let sepLen = 1;

        if (colonIdx >= 0 && (sepIdx < 0 || colonIdx < sepIdx)) {
            sepIdx = colonIdx;
            sepLen = 2;
        }

        if (sepIdx >= 0) {
            prefix = calleeName.slice(0, sepIdx);
            suffix = calleeName.slice(sepIdx + sepLen);
        }

        // Strategy 1: import_map
        let result = this.resolveImportMap(
            prefix, suffix, importMapKeys, importMapVals,
        );
        if (result.qualifiedName) return result;

        // Strategy 2: same_module
        result = this.resolveSameModule(calleeName, suffix, moduleQN);
        if (result.qualifiedName) return result;

        // Strategy 3+4: name lookup
        return this.resolveNameLookup(calleeName, moduleQN, importMapVals);
    }

    // ── Strategy implementations ──────────────────────────────────

    /**
     * Strategy 1: Find prefix in import map, build candidate QN.
     * On failure, try import_map_suffix (match any QN under the import
     * that ends with .suffix).
     */
    private resolveImportMap(
        prefix: string,
        suffix: string,
        keys: string[],
        vals: string[],
    ): RegistryResolutionResult {
        if (!keys.length || !vals.length) return emptyResult();

        // Find prefix in import map keys
        let resolved = '';
        for (let i = 0; i < keys.length; i++) {
            if (keys[i] === prefix) {
                resolved = vals[i];
                break;
            }
        }
        if (!resolved) return emptyResult();

        // Build candidate: resolved.suffix or resolved.prefix
        const candidate = suffix
            ? `${resolved}.${suffix}`
            : `${resolved}.${prefix}`;

        if (this.exact.has(candidate)) {
            return {
                qualifiedName: candidate,
                strategy: 'import_map',
                confidence: CONF_IMPORT_MAP,
                candidateCount: 1,
            };
        }

        // import_map_suffix fallback: find QN starting with resolved+"."
        // and ending with "."+suffix
        if (suffix) {
            const resolvedDot = `${resolved}.`;
            const dotSuffix = `.${suffix}`;
            const arr = this.byName.get(simpleName(suffix));
            if (arr) {
                for (const qn of arr) {
                    if (qn.startsWith(resolvedDot) && qn.endsWith(dotSuffix)) {
                        return {
                            qualifiedName: qn,
                            strategy: 'import_map_suffix',
                            confidence: CONF_IMPORT_MAP_SUFFIX,
                            candidateCount: 1,
                        };
                    }
                }
            }
        }

        return emptyResult();
    }

    /**
     * Strategy 2: moduleQN.calleeName → exact match.
     */
    private resolveSameModule(
        calleeName: string,
        suffix: string,
        moduleQN: string,
    ): RegistryResolutionResult {
        const candidate = `${moduleQN}.${calleeName}`;
        if (this.exact.has(candidate)) {
            return {
                qualifiedName: candidate,
                strategy: 'same_module',
                confidence: CONF_SAME_MODULE,
                candidateCount: 1,
            };
        }
        // Also try moduleQN.suffix
        if (suffix) {
            const candidate2 = `${moduleQN}.${suffix}`;
            if (this.exact.has(candidate2)) {
                return {
                    qualifiedName: candidate2,
                    strategy: 'same_module',
                    confidence: CONF_SAME_MODULE,
                    candidateCount: 1,
                };
            }
        }
        return emptyResult();
    }

    /**
     * Strategy 3.5: A qualified callee disambiguates among multiple
     * same-name candidates by full qualified tail.
     */
    private qualifiedSuffixMatch(
        arr: string[],
        calleeName: string,
    ): string | null {
        const dotted = `.${calleeName}`;
        // Find the sole candidate whose QN equals or ends with ".calleeName"
        let match: string | null = null;
        for (const qn of arr) {
            if (qn === calleeName || qn.endsWith(dotted)) {
                if (match) return null; // Multiple matches → ambiguous
                match = qn;
            }
        }
        return match;
    }

    /**
     * Strategy 3+4: name lookup.
     *   - qualified_suffix: disambiguate by full tail
     *   - unique_name: single candidate
     *   - suffix_match: multiple candidates, filtered by reachability
     */
    private resolveNameLookup(
        calleeName: string,
        moduleQN: string,
        importVals: string[],
    ): RegistryResolutionResult {
        const lookup = simpleName(calleeName);
        const arr = this.byName.get(lookup);
        if (!arr || arr.length === 0) return emptyResult();
        if (arr.length > REG_MAX_CANDIDATES) return emptyResult();

        // Strategy 3.5: qualified suffix
        if (arr.length > 1) {
            const q = this.qualifiedSuffixMatch(arr, calleeName);
            if (q) {
                return {
                    qualifiedName: q,
                    strategy: 'qualified_suffix',
                    confidence: CONF_QUALIFIED_SUFFIX,
                    candidateCount: 1,
                };
            }
        }

        // Strategy 3: unique name
        if (arr.length === 1) {
            let conf = CONF_UNIQUE_NAME;
            if (importVals.length > 0 && !isImportReachable(arr[0], importVals)) {
                conf *= 0.5;
            }
            return {
                qualifiedName: arr[0],
                strategy: 'unique_name',
                confidence: conf,
                candidateCount: 1,
            };
        }

        // Strategy 4: multiple candidates
        return this.resolveMultiWithImports(arr, moduleQN, importVals);
    }

    /**
     * Strategy 4: multiple candidates with import filtering.
     */
    private resolveMultiWithImports(
        arr: string[],
        moduleQN: string,
        importVals: string[],
    ): RegistryResolutionResult {
        if (importVals.length > 0) {
            // Filter by import reachability
            const filtered = arr.filter((qn) => isImportReachable(qn, importVals));
            if (filtered.length === 1) {
                const conf = candidateCountPenalty(CONF_SUFFIX_MATCH, arr.length);
                return {
                    qualifiedName: filtered[0],
                    strategy: 'suffix_match',
                    confidence: conf,
                    candidateCount: arr.length,
                };
            }
            if (filtered.length > 1) {
                const best = bestByImportDistance(filtered, moduleQN);
                if (best) {
                    const conf = candidateCountPenalty(CONF_SUFFIX_MATCH, filtered.length);
                    return {
                        qualifiedName: best,
                        strategy: 'suffix_match',
                        confidence: conf,
                        candidateCount: filtered.length,
                    };
                }
            }
        }

        // No import reachable — use all candidates with penalty
        const best = bestByImportDistance(arr, moduleQN);
        if (best) {
            const conf = candidateCountPenalty(
                CONF_SUFFIX_MATCH * 0.5,
                arr.length,
            );
            return {
                qualifiedName: best,
                strategy: 'suffix_match',
                confidence: conf,
                candidateCount: arr.length,
            };
        }

        return emptyResult();
    }

    // ── Fuzzy resolve ─────────────────────────────────────────────

    /**
     * Fuzzy resolve: try to find the best match when exact resolution fails.
     * Uses the same strategy chain but returns a simpler result.
     */
    fuzzyResolve(
        calleeName: string,
        moduleQN: string,
        importMapKeys: string[] = [],
        importMapVals: string[] = [],
    ): FuzzyResult {
        const lookup = simpleName(calleeName);
        const arr = this.byName.get(lookup);
        if (!arr || arr.length === 0) {
            return { qualifiedName: '', confidence: 0, resolved: false };
        }
        if (arr.length > REG_MAX_CANDIDATES) {
            return { qualifiedName: '', confidence: 0, resolved: false };
        }

        const haveImports = importMapVals.length > 0;

        // Single candidate
        if (arr.length === 1) {
            let conf = CONF_FUZZY_SINGLE;
            if (haveImports && !isImportReachable(arr[0], importMapVals)) {
                conf *= 0.5;
            }
            return { qualifiedName: arr[0], confidence: conf, resolved: true };
        }

        // Multiple candidates: filter by import reachability
        if (haveImports) {
            const filtered = arr.filter((qn) => isImportReachable(qn, importMapVals));
            if (filtered.length === 1) {
                return {
                    qualifiedName: filtered[0],
                    confidence: CONF_FUZZY_MULTI,
                    resolved: true,
                };
            }
            if (filtered.length > 1) {
                const best = bestByImportDistance(filtered, moduleQN);
                if (best) {
                    return {
                        qualifiedName: best,
                        confidence: CONF_FUZZY_MULTI,
                        resolved: true,
                    };
                }
            }
        }

        const best = bestByImportDistance(arr, moduleQN);
        if (best) {
            return {
                qualifiedName: best,
                confidence: CONF_FUZZY_MULTI * 0.5,
                resolved: true,
            };
        }

        return { qualifiedName: '', confidence: 0, resolved: false };
    }

    // ── Bulk operations ───────────────────────────────────────────

    /** Clear all entries. */
    clear(): void {
        this.exact.clear();
        this.byName.clear();
    }

    /** Get all entries (for debugging). */
    getAllEntries(): RegistryEntry[] {
        return Array.from(this.exact.values());
    }
}