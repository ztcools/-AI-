// Re-export types and interfaces
export {
    VectorDocument,
    SearchOptions,
    VectorSearchResult,
    VectorDatabase,
    HybridSearchRequest,
    HybridSearchOptions,
    HybridSearchResult,
    RerankStrategy,
    COLLECTION_LIMIT_MESSAGE
} from './types';

// 只读包装：本地 MCP 用它把云端 Milvus 句柄变成"写方法一律抛错"
export {
    readOnlyVectorDatabase,
    isReadOnlyVectorDatabase,
    ReadOnlyVectorDatabaseError,
    READONLY_VECTORDB_MESSAGE
} from './readonly-vectordb';

// Implementation class exports
export { MilvusRestfulVectorDatabase, MilvusRestfulConfig } from './milvus-restful-vectordb';
export { MilvusVectorDatabase, MilvusConfig } from './milvus-vectordb';
export {
    ClusterManager,
    ClusterConfig,
    Project,
    Cluster,
    CreateFreeClusterRequest,
    CreateFreeClusterResponse,
    CreateFreeClusterWithDetailsResponse,
    DescribeClusterResponse
} from './cluster-utils';