// Interface definitions
export interface VectorDocument {
    id: string;
    vector: number[];
    content: string;
    relativePath: string;
    startLine: number;
    endLine: number;
    fileExtension: string;
    metadata: Record<string, any>;
}

export interface SearchOptions {
    topK?: number;
    filter?: Record<string, any>;
    threshold?: number;
    filterExpr?: string;
}

// New interfaces for hybrid search
export interface HybridSearchRequest {
    data: number[] | string; // Query vector or text
    anns_field: string; // Vector field name (vector or sparse_vector)
    param: Record<string, any>; // Search parameters
    limit: number;
}

export interface HybridSearchOptions {
    rerank?: RerankStrategy;
    limit?: number;
    filterExpr?: string;
}

export interface RerankStrategy {
    strategy: 'rrf' | 'weighted';
    params?: Record<string, any>;
}

export interface VectorSearchResult {
    document: VectorDocument;
    score: number;
}

export interface HybridSearchResult {
    document: VectorDocument;
    score: number;
}

export interface VectorDatabase {
    /**
     * Create collection
     * @param collectionName Collection name
     * @param dimension Vector dimension
     * @param description Collection description
     */
    createCollection(collectionName: string, dimension: number, description?: string): Promise<void>;

    /**
     * Create collection with hybrid search support
     * @param collectionName Collection name
     * @param dimension Dense vector dimension
     * @param description Collection description
     */
    createHybridCollection(collectionName: string, dimension: number, description?: string): Promise<void>;

    /**
     * Drop collection
     * @param collectionName Collection name
     */
    dropCollection(collectionName: string): Promise<void>;

    /**
     * Check if collection exists
     * @param collectionName Collection name
     */
    hasCollection(collectionName: string): Promise<boolean>;

    /**
     * List all collections
     */
    listCollections(): Promise<string[]>;

    /**
     * Insert vector documents
     * @param collectionName Collection name
     * @param documents Document array
     */
    insert(collectionName: string, documents: VectorDocument[]): Promise<void>;

    /**
     * Insert hybrid vector documents
     * @param collectionName Collection name
     * @param documents Document array
     */
    insertHybrid(collectionName: string, documents: VectorDocument[]): Promise<void>;

    /**
     * Search similar vectors
     * @param collectionName Collection name
     * @param queryVector Query vector
     * @param options Search options
     */
    search(collectionName: string, queryVector: number[], options?: SearchOptions): Promise<VectorSearchResult[]>;

    /**
     * Hybrid search with multiple vector fields
     * @param collectionName Collection name
     * @param searchRequests Array of search requests for different fields
     * @param options Hybrid search options including reranking
     */
    hybridSearch(collectionName: string, searchRequests: HybridSearchRequest[], options?: HybridSearchOptions): Promise<HybridSearchResult[]>;

    /**
     * BM25-only (sparse) search over the text query, ranked by lexical score.
     * Optional: implementations without a sparse field may omit it; callers that
     * need per-modality rankings (e.g. cross-layer global RRF fusion) fall back
     * to hybridSearch when this is absent.
     */
    sparseSearch?(collectionName: string, queryText: string, options?: SearchOptions): Promise<VectorSearchResult[]>;

    /**
     * Seal the collection's growing segments so freshly inserted rows become
     * visible to segment-statistics readers (getCollectionStatistics).
     *
     * Search paths don't need this — they read the live state. It exists for
     * external consumers that report row counts from stats (the PhiGent
     * console's collection list, Attu's row-count column), which otherwise show
     * 0 for a just-indexed collection until Milvus auto-seals.
     *
     * Optional: implementations without segment semantics may omit it.
     */
    flush?(collectionName: string): Promise<void>;

    /**
     * Drop the collection's loaded segments from query-node memory.
     *
     * Searching a collection requires it to be loaded, and nothing ever unloads it
     * again — so a writer that touches every collection (the nightly indexing pass)
     * would keep the union of all of them resident. At a few hundred repos with
     * several branches each that is hundreds of GB on a shared server. Releasing
     * right after a write bounds the resident set to what is actively *searched*:
     * the next search re-loads on demand, and the search path already retries once
     * on a load-state error.
     *
     * Optional: implementations without load/release semantics may omit it.
     */
    release?(collectionName: string): Promise<void>;

    /**
     * Delete documents
     * @param collectionName Collection name
     * @param ids Document ID array
     */
    delete(collectionName: string, ids: string[]): Promise<void>;

    /**
     * Query documents with filter conditions
     * @param collectionName Collection name
     * @param filter Filter expression
     * @param outputFields Fields to return
     * @param limit Maximum number of results
     */
    query(collectionName: string, filter?: string, outputFields?: string[], limit?: number): Promise<Record<string, any>[]>;

    /**
     * Get collection description
     * @param collectionName Collection name
     * @returns Collection description string
     */
    getCollectionDescription(collectionName: string): Promise<string>;

    /**
     * Check collection limit
     * Returns true if collection can be created, false if limit exceeded
     */
    checkCollectionLimit(): Promise<boolean>;

    /**
     * Get the number of entities (rows) in a collection.
     * Returns -1 if the count cannot be determined (query failed, collection missing, etc).
     * Callers should treat -1 as "unknown" and NOT as "empty".
     */
    getCollectionRowCount(collectionName: string): Promise<number>;
}

/**
 * Special error message for collection limit exceeded
 * This allows us to distinguish it from other errors across all Milvus implementations
 */
export const COLLECTION_LIMIT_MESSAGE = "[Error]: Collection limit reached. Unable to create additional collections.";