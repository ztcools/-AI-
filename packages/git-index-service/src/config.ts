import * as os from 'os';
import * as path from 'path';
import {
    envManager,
    Context,
    MilvusVectorDatabase,
    Embedding,
    OpenAIEmbedding,
    VoyageAIEmbedding,
    GeminiEmbedding,
    OllamaEmbedding,
} from '@seeway/claude-context-core';

export interface RepoSpec {
    name: string;
    url: string;      // canonical origin URL — MUST match what developers use so the shared index lines up
    branch: string;   // main branch to keep authoritative (default resolved by RepoManager)
    /** Extra protected branches to index alongside main (main itself not included). */
    protectedBranches?: string[];
    token?: string;   // optional access token for private clone/fetch
}

/** Normalize a protectedBranches input (array | csv string) into a deduped array. */
export function normalizeProtectedBranches(input: unknown, mainBranch: string): string[] {
    let list: string[] = [];
    if (Array.isArray(input)) list = input.map(s => String(s));
    else if (typeof input === 'string') list = input.split(',');
    const main = String(mainBranch || '').trim();
    const seen = new Set<string>();
    for (const raw of list) {
        const b = raw.trim();
        if (!b || b === main || seen.has(b)) continue;
        seen.add(b);
    }
    return Array.from(seen);
}

export interface ServiceConfig {
    repos: RepoSpec[];
    source: 'config' | 'gitlab';
    workdir: string;
    sshDir: string;
    configFile: string;
    runOnStart: boolean;
    runOnce: boolean;
    intervalMs: number;
    dailyHour: number | null;
    httpPort: number | null;
    gitlab: {
        baseUrl?: string;
        token?: string;
        group?: string;
        projectIds: string[];
        defaultBranch: string;
    };
}

function num(name: string, fallback: number): number {
    const raw = envManager.get(name);
    if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
    const v = Number(raw);
    return Number.isFinite(v) ? v : fallback;
}

function bool(name: string, fallback: boolean): boolean {
    const raw = envManager.get(name);
    if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
    const v = String(raw).trim().toLowerCase();
    return v === 'true' || v === '1' || v === 'yes';
}

function parseReposEnv(): RepoSpec[] {
    const raw = envManager.get('GIT_INDEX_REPOS');
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed
            .filter((r: any) => r && r.url)
            .map((r: any) => {
                const branch = r.branch || 'main';
                return {
                    name: r.name || r.url,
                    url: r.url,
                    branch,
                    protectedBranches: normalizeProtectedBranches(r.protectedBranches, branch),
                    token: r.token,
                };
            });
    } catch (e) {
        console.error('[Config] Failed to parse GIT_INDEX_REPOS JSON:', e);
        return [];
    }
}

export function loadServiceConfig(): ServiceConfig {
    const source = (envManager.get('GIT_INDEX_SOURCE') as 'config' | 'gitlab') || 'config';
    const workdir = envManager.get('GIT_INDEX_WORKDIR')
        || path.join(os.homedir(), '.claude-context', 'git-index-repos');
    const configFile = envManager.get('GIT_INDEX_CONFIG_FILE')
        || path.join(path.dirname(workdir), 'git-index-config.json');
    const sshDir = envManager.get('GIT_INDEX_SSH_DIR')
        || path.join(path.dirname(workdir), 'ssh');
    const httpPortRaw = envManager.get('GIT_INDEX_HTTP_PORT');
    const dailyHourRaw = envManager.get('GIT_INDEX_DAILY_HOUR');
    const projectIdsRaw = envManager.get('GITLAB_PROJECT_IDS') || '';

    return {
        repos: parseReposEnv(),
        source,
        workdir,
        sshDir,
        configFile,
        runOnStart: bool('GIT_INDEX_RUN_ON_START', true),
        runOnce: bool('GIT_INDEX_RUN_ONCE', false),
        intervalMs: num('GIT_INDEX_INTERVAL_MS', 24 * 60 * 60 * 1000),
        dailyHour: dailyHourRaw !== undefined && dailyHourRaw !== null && String(dailyHourRaw).trim() !== ''
            ? num('GIT_INDEX_DAILY_HOUR', 3)
            : null,
        httpPort: httpPortRaw ? num('GIT_INDEX_HTTP_PORT', 8790) : null,
        gitlab: {
            baseUrl: envManager.get('GITLAB_BASE_URL'),
            token: envManager.get('GITLAB_TOKEN'),
            group: envManager.get('GITLAB_GROUP'),
            projectIds: projectIdsRaw.split(',').map(s => s.trim()).filter(Boolean),
            defaultBranch: envManager.get('GITLAB_DEFAULT_BRANCH') || 'main',
        },
    };
}

function createEmbedding(): Embedding {
    const provider = envManager.get('EMBEDDING_PROVIDER') || 'OpenAI';
    const model = envManager.get('EMBEDDING_MODEL');
    switch (provider) {
        case 'Ollama':
            return new OllamaEmbedding({
                model: model || 'nomic-embed-text',
                host: envManager.get('OLLAMA_HOST') || 'http://127.0.0.1:11434',
                ...(envManager.get('EMBEDDING_DIMENSION') && { dimension: Number(envManager.get('EMBEDDING_DIMENSION')) }),
            });
        case 'VoyageAI':
            return new VoyageAIEmbedding({
                apiKey: envManager.get('VOYAGEAI_API_KEY') || '',
                model: model || 'voyage-code-3',
            });
        case 'Gemini':
            return new GeminiEmbedding({
                apiKey: envManager.get('GEMINI_API_KEY') || '',
                model: model || 'gemini-embedding-001',
                ...(envManager.get('GEMINI_BASE_URL') && { baseURL: envManager.get('GEMINI_BASE_URL') }),
            });
        case 'OpenRouter':
            return new OpenAIEmbedding({
                apiKey: envManager.get('OPENROUTER_API_KEY') || '',
                model: model || 'text-embedding-3-small',
                baseURL: 'https://openrouter.ai/api/v1',
            });
        case 'OpenAI':
        default:
            return new OpenAIEmbedding({
                apiKey: envManager.get('OPENAI_API_KEY') || '',
                model: model || 'text-embedding-3-small',
                ...(envManager.get('OPENAI_BASE_URL') && { baseURL: envManager.get('OPENAI_BASE_URL') }),
            });
    }
}

export function buildContext(): Context {
    const embedding = createEmbedding();
    const vectorDatabase = new MilvusVectorDatabase({
        address: envManager.get('MILVUS_ADDRESS'),
        ...(envManager.get('MILVUS_TOKEN') && { token: envManager.get('MILVUS_TOKEN') }),
    });
    return new Context({ embedding, vectorDatabase });
}
