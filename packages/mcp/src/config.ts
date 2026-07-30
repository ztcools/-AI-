import { envManager } from "@seeway/claude-context-core";

export interface ContextMcpConfig {
    name: string;
    version: string;
    // Embedding provider configuration
    embeddingProvider: 'OpenAI' | 'VoyageAI' | 'Gemini' | 'Ollama' | 'OpenRouter';
    embeddingModel: string;
    // Provider-specific API keys
    openaiApiKey?: string;
    openaiBaseUrl?: string;
    voyageaiApiKey?: string;
    geminiApiKey?: string;
    geminiBaseUrl?: string;
    // OpenRouter configuration
    openrouterApiKey?: string;
    // Ollama configuration
    ollamaModel?: string;
    ollamaHost?: string;
    ollamaDimension?: number;
    // Vector database configuration (cloud Milvus, read-only)
    milvusAddress?: string;
    milvusToken?: string;
    collectionNameOverride?: string;
    // Cloud git-index-service base URL (for branch discovery)
    gitIndexServiceUrl?: string;
}

// Helper function to get default model for each provider
export function getDefaultModelForProvider(provider: string): string {
    switch (provider) {
        case 'OpenAI':
            return 'text-embedding-3-small';
        case 'VoyageAI':
            return 'voyage-code-3';
        case 'Gemini':
            return 'gemini-embedding-001';
        case 'OpenRouter':
            return 'openai/text-embedding-3-small';
        case 'Ollama':
            return 'nomic-embed-text';
        default:
            return 'text-embedding-3-small';
    }
}

// Helper function to get embedding model with provider-specific environment variable priority
export function getEmbeddingModelForProvider(provider: string): string {
    switch (provider) {
        case 'Ollama':
            const ollamaModel = envManager.get('OLLAMA_MODEL') || envManager.get('EMBEDDING_MODEL') || getDefaultModelForProvider(provider);
            console.log(`[DEBUG] 🎯 Ollama model selection: OLLAMA_MODEL=${envManager.get('OLLAMA_MODEL') || 'NOT SET'}, EMBEDDING_MODEL=${envManager.get('EMBEDDING_MODEL') || 'NOT SET'}, selected=${ollamaModel}`);
            return ollamaModel;
        case 'OpenAI':
        case 'VoyageAI':
        case 'Gemini':
        case 'OpenRouter':
        default:
            const selectedModel = envManager.get('EMBEDDING_MODEL') || getDefaultModelForProvider(provider);
            console.log(`[DEBUG] 🎯 ${provider} model selection: EMBEDDING_MODEL=${envManager.get('EMBEDDING_MODEL') || 'NOT SET'}, selected=${selectedModel}`);
            return selectedModel;
    }
}

function getPositiveIntegerFromEnv(name: string): number | undefined {
    const rawValue = envManager.get(name);
    if (!rawValue) {
        return undefined;
    }

    const parsedValue = Number(rawValue);
    if (Number.isInteger(parsedValue) && parsedValue > 0) {
        return parsedValue;
    }

    console.warn(`[DEBUG] ⚠️  Ignoring invalid ${name}: ${rawValue}. Expected a positive integer.`);
    return undefined;
}

export function createMcpConfig(): ContextMcpConfig {
    console.log(`[DEBUG] 🔍 Environment Variables Debug:`);
    console.log(`[DEBUG]   EMBEDDING_PROVIDER: ${envManager.get('EMBEDDING_PROVIDER') || 'NOT SET'}`);
    console.log(`[DEBUG]   EMBEDDING_MODEL: ${envManager.get('EMBEDDING_MODEL') || 'NOT SET'}`);
    console.log(`[DEBUG]   EMBEDDING_DIMENSION: ${envManager.get('EMBEDDING_DIMENSION') || 'NOT SET'}`);
    console.log(`[DEBUG]   OLLAMA_MODEL: ${envManager.get('OLLAMA_MODEL') || 'NOT SET'}`);
    console.log(`[DEBUG]   GEMINI_API_KEY: ${envManager.get('GEMINI_API_KEY') ? 'SET (length: ' + envManager.get('GEMINI_API_KEY')!.length + ')' : 'NOT SET'}`);
    console.log(`[DEBUG]   OPENAI_API_KEY: ${envManager.get('OPENAI_API_KEY') ? 'SET (length: ' + envManager.get('OPENAI_API_KEY')!.length + ')' : 'NOT SET'}`);
    console.log(`[DEBUG]   MILVUS_ADDRESS: ${envManager.get('MILVUS_ADDRESS') || 'NOT SET'}`);
    console.log(`[DEBUG]   CODE_CHUNKS_COLLECTION_NAME_OVERRIDE: ${envManager.get('CODE_CHUNKS_COLLECTION_NAME_OVERRIDE') || 'NOT SET'}`);
    console.log(`[DEBUG]   GIT_INDEX_SERVICE_URL: ${envManager.get('GIT_INDEX_SERVICE_URL') || 'NOT SET'}`);
    console.log(`[DEBUG]   NODE_ENV: ${envManager.get('NODE_ENV') || 'NOT SET'}`);

    const config: ContextMcpConfig = {
        name: envManager.get('MCP_SERVER_NAME') || "Context MCP Server",
        version: envManager.get('MCP_SERVER_VERSION') || "1.0.0",
        // Embedding provider configuration
        embeddingProvider: (envManager.get('EMBEDDING_PROVIDER') as 'OpenAI' | 'VoyageAI' | 'Gemini' | 'Ollama' | 'OpenRouter') || 'OpenAI',
        embeddingModel: getEmbeddingModelForProvider(envManager.get('EMBEDDING_PROVIDER') || 'OpenAI'),
        // Provider-specific API keys
        openaiApiKey: envManager.get('OPENAI_API_KEY'),
        openaiBaseUrl: envManager.get('OPENAI_BASE_URL'),
        voyageaiApiKey: envManager.get('VOYAGEAI_API_KEY'),
        geminiApiKey: envManager.get('GEMINI_API_KEY'),
        geminiBaseUrl: envManager.get('GEMINI_BASE_URL'),
        // OpenRouter configuration
        openrouterApiKey: envManager.get('OPENROUTER_API_KEY'),
        // Ollama configuration
        ollamaModel: envManager.get('OLLAMA_MODEL'),
        ollamaHost: envManager.get('OLLAMA_HOST'),
        ollamaDimension: getPositiveIntegerFromEnv('EMBEDDING_DIMENSION'),
        // Vector database configuration (cloud Milvus, read-only)
        milvusAddress: envManager.get('MILVUS_ADDRESS'),
        milvusToken: envManager.get('MILVUS_TOKEN'),
        collectionNameOverride: envManager.get('CODE_CHUNKS_COLLECTION_NAME_OVERRIDE'),
        // Cloud git-index-service base URL
        gitIndexServiceUrl: envManager.get('GIT_INDEX_SERVICE_URL') || 'http://10.50.4.149:8795',
    };

    return config;
}

export function logConfigurationSummary(config: ContextMcpConfig): void {
    console.log(`[MCP] 🚀 Starting Context MCP Server`);
    console.log(`[MCP] Configuration Summary:`);
    console.log(`[MCP]   Server: ${config.name} v${config.version}`);
    console.log(`[MCP]   Embedding Provider: ${config.embeddingProvider}`);
    console.log(`[MCP]   Embedding Model: ${config.embeddingModel}`);
    console.log(`[MCP]   Milvus Address: ${config.milvusAddress || (config.milvusToken ? '[Auto-resolve from token]' : '[Not configured]')}`);
    console.log(`[MCP]   Git Index Service: ${config.gitIndexServiceUrl}`);
    if (config.collectionNameOverride) {
        console.log(`[MCP]   Collection Name Override: ✅ Configured`);
    }

    switch (config.embeddingProvider) {
        case 'OpenAI':
            console.log(`[MCP]   OpenAI API Key: ${config.openaiApiKey ? '✅ Configured' : '❌ Missing'}`);
            if (config.openaiBaseUrl) {
                console.log(`[MCP]   OpenAI Base URL: ${config.openaiBaseUrl}`);
            }
            break;
        case 'VoyageAI':
            console.log(`[MCP]   VoyageAI API Key: ${config.voyageaiApiKey ? '✅ Configured' : '❌ Missing'}`);
            break;
        case 'Gemini':
            console.log(`[MCP]   Gemini API Key: ${config.geminiApiKey ? '✅ Configured' : '❌ Missing'}`);
            if (config.geminiBaseUrl) {
                console.log(`[MCP]   Gemini Base URL: ${config.geminiBaseUrl}`);
            }
            break;
        case 'OpenRouter':
            console.log(`[MCP]   OpenRouter API Key: ${config.openrouterApiKey ? '✅ Configured' : '❌ Missing'}`);
            break;
        case 'Ollama':
            console.log(`[MCP]   Ollama Host: ${config.ollamaHost || 'http://127.0.0.1:11434'}`);
            console.log(`[MCP]   Ollama Model: ${config.embeddingModel}`);
            if (config.ollamaDimension) {
                console.log(`[MCP]   Ollama Embedding Dimension: ${config.ollamaDimension}`);
            }
            break;
    }

    console.log(`[MCP] 🔧 Initializing server components...`);
}

export function showHelpMessage(): void {
    console.log(`
Context MCP Server (cloud-link mode)

Usage: node ~/.claude-context/packages/mcp/dist/index.js [options]

Options:
  --help, -h                          Show this help message

Environment Variables:
  MCP_SERVER_NAME         Server name
  MCP_SERVER_VERSION      Server version

  Embedding Provider Configuration (required for search query embedding):
  EMBEDDING_PROVIDER      Embedding provider: OpenAI, VoyageAI, Gemini, Ollama, OpenRouter (default: OpenAI)
  EMBEDDING_MODEL         Embedding model name (works for all providers)
  EMBEDDING_DIMENSION     Optional embedding dimension override for Ollama

  Provider-specific API Keys:
  OPENAI_API_KEY          OpenAI API key (required for OpenAI provider)
  OPENAI_BASE_URL         OpenAI API base URL (optional, for custom endpoints)
  VOYAGEAI_API_KEY        VoyageAI API key (required for VoyageAI provider)
  GEMINI_API_KEY          Google AI API key (required for Gemini provider)
  GEMINI_BASE_URL         Gemini API base URL (optional, for custom endpoints)
  OPENROUTER_API_KEY      OpenRouter API key (required for OpenRouter provider)

  Ollama Configuration:
  OLLAMA_HOST             Ollama server host (default: http://127.0.0.1:11434)
  OLLAMA_MODEL            Ollama model name (alternative to EMBEDDING_MODEL for Ollama)

  Vector Database (cloud Milvus, read-only):
  MILVUS_ADDRESS          Milvus address
  MILVUS_TOKEN            Milvus token (optional)
  CODE_CHUNKS_COLLECTION_NAME_OVERRIDE
                          Optional readable prefix for collection names.

  Cloud Index Service:
  GIT_INDEX_SERVICE_URL   Base URL of git-index-service for branch discovery
                          (default: http://10.50.4.149:8795)

  Search tuning:
  SEARCH_THRESHOLD        Relative score cutoff (default: 0.4)
  SEARCH_DEFAULT_LIMIT    Default max results (default: 10)
  SEARCH_SNIPPET_MAX_CHARS  Per-snippet character cap (default: 4000)
  SEARCH_TOTAL_MAX_CHARS  Whole-response snippet budget, split across hits
                          (default: 20000; per-snippet floor 600)
  SEARCH_SCORE_RATIO      Relative tail cutoff ratio in [0,1] (default: 0 = disabled)

Examples:
  # Start with OpenAI against cloud Milvus
  OPENAI_API_KEY=sk-xxx MILVUS_ADDRESS=10.50.4.149:19530 node ~/.claude-context/packages/mcp/dist/index.js

  # Start with Ollama
  EMBEDDING_PROVIDER=Ollama OLLAMA_MODEL=nomic-embed-text MILVUS_ADDRESS=10.50.4.149:19530 node ~/.claude-context/packages/mcp/dist/index.js
        `);
}
