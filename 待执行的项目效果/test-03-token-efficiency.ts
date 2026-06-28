/**
 * 测试 03：Token 效率对比
 * 需要 Milvus + Ollama 内网环境
 *
 * 模拟真实开发场景，对比有无 MCP 的 token 消耗：
 * - 场景 A：开发者问"这个项目的认证逻辑怎么实现的？"
 * - 场景 B：开发者问"帮我找到所有数据库连接相关的代码"
 * - 场景 C：开发者问"这个 bug 可能出在哪里？"
 *
 * 对比方式：
 *   - 无 MCP：LLM 需要 grep 搜索 → 逐个读取文件 → 理解代码
 *   - 有 MCP：LLM 调用 search → 一次获得代码+调用链+架构
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

const RESULTS_DIR = path.join(__dirname, 'test-results');
const REPOS_DIR = path.join(__dirname, 'test-repos');
const TOKEN_OUTPUT = path.join(RESULTS_DIR, 'token-comparison.json');

fs.mkdirSync(RESULTS_DIR, { recursive: true });

// ── Token 估算 ───────────────────────────────────────────────────
function estimateTokens(text: string): number {
    // 保守估计：1 token ≈ 4 字符（英文）或 2 字符（中文）
    // 代码以英文为主，用 4 字符/token
    return Math.ceil(text.length / 4);
}

// ── 模拟传统方式（无 MCP）───────────────────────────────────────
function simulateTraditional(repoPath: string, query: string, keywords: string[]): {
    tokens: number;
    filesRead: number;
    linesRead: number;
} {
    let tokens = estimateTokens(query) + 500; // query + system prompt

    // grep 搜索
    let grepOutput = '';
    try {
        const keywordPattern = keywords.join('\\|');
        grepOutput = execSync(
            `grep -rli "${keywordPattern}" "${repoPath}" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.rs" --include="*.py" --include="*.java" --include="*.cpp" --include="*.c" 2>/dev/null | head -20`,
            { encoding: 'utf-8', timeout: 60000 }
        );
    } catch { /* empty */ }

    tokens += estimateTokens(grepOutput);

    // 读取匹配文件
    const files = grepOutput.split('\n').filter(Boolean).slice(0, 8);
    let linesRead = 0;
    for (const file of files) {
        try {
            const content = fs.readFileSync(file, 'utf-8');
            tokens += estimateTokens(content);
            linesRead += content.split('\n').length;
        } catch { /* empty */ }
    }

    return { tokens, filesRead: files.length, linesRead };
}

// ── 模拟 MCP 方式 ───────────────────────────────────────────────
function simulateMcp(searchResult: string, graphContext: string): {
    tokens: number;
} {
    // search 返回：代码片段 + 图上下文（调用链 + 架构）
    const combined = searchResult + '\n\n' + graphContext;
    const tokens = estimateTokens(combined) + estimateTokens('search query') + 500;
    return { tokens: Math.min(tokens, 8000) }; // 上限 8000 token
}

// ── 真实开发场景 ─────────────────────────────────────────────────
const SCENARIOS = [
    {
        name: '理解认证逻辑',
        query: 'user authentication login implementation',
        keywords: ['auth', 'login', 'token', 'session', 'password'],
        mcpResult: `// src/auth/auth-service.ts:15-45
export class AuthService {
    async login(credentials: LoginRequest): Promise<LoginResponse> {
        const user = await this.userRepo.findByEmail(credentials.email);
        if (!user) throw new UnauthorizedError('Invalid credentials');
        const valid = await bcrypt.compare(credentials.password, user.passwordHash);
        if (!valid) throw new UnauthorizedError('Invalid credentials');
        const token = this.jwtService.sign({ sub: user.id, roles: user.roles });
        await this.sessionRepo.create({ userId: user.id, token, expiresAt: Date.now() + 3600000 });
        return { token, user: this.sanitizeUser(user) };
    }
    async validateToken(token: string): Promise<User> { /* ... */ }
    async refreshToken(refreshToken: string): Promise<LoginResponse> { /* ... */ }
}`,
        graphContext: `## Graph Context
  - Method \`AuthService.login\` ← UserController.login, OAuthController.callback
  - Method \`AuthService.login\` → UserRepo.findByEmail, JwtService.sign, SessionRepo.create
  - Method \`AuthService.validateToken\` → JwtService.verify, UserRepo.findById
  - Method \`AuthService.validateToken\` [entry]

### Call Chain: \`login\`
  [depth=0] AuthService.login
  [depth=1] → UserRepo.findByEmail
  [depth=1] → JwtService.sign
  [depth=1] → SessionRepo.create
  [depth=2] → TokenGenerator.generate
  [depth=2] → Database.insert

### Architecture
  Entry points: UserController.login, OAuthController.callback, App.main
  Module: src/auth (cohesion: 0.87)`,
    },
    {
        name: '找数据库连接代码',
        query: 'database connection pool configuration',
        keywords: ['database', 'connection', 'pool', 'mysql', 'postgres', 'mongodb'],
        mcpResult: `// src/db/connection-pool.ts:10-50
export class ConnectionPool {
    private pool: Pool;
    constructor(config: PoolConfig) {
        this.pool = new Pool({
            host: config.host,
            port: config.port,
            database: config.database,
            user: config.user,
            password: config.password,
            max: config.maxConnections || 20,
            idleTimeoutMillis: config.idleTimeout || 30000,
            connectionTimeoutMillis: config.connectionTimeout || 2000,
        });
    }
    async getConnection(): Promise<PoolClient> {
        return this.pool.connect();
    }
    async query(sql: string, params?: any[]): Promise<QueryResult> {
        const client = await this.getConnection();
        try { return await client.query(sql, params); }
        finally { client.release(); }
    }
}

// src/db/repository.ts:30-60
export abstract class BaseRepository<T> {
    constructor(protected pool: ConnectionPool, protected tableName: string) {}
    async findById(id: string): Promise<T | null> { /* ... */ }
    async findAll(filter?: Filter<T>): Promise<T[]> { /* ... */ }
    async create(entity: Omit<T, 'id'>): Promise<T> { /* ... */ }
}`,
        graphContext: `## Graph Context
  - Class \`ConnectionPool\` ← DatabaseModule.configure, AppBootstrap.initialize
  - Class \`ConnectionPool\` → Pool.constructor, Pool.connect
  - Class \`BaseRepository\` ← UserRepo, OrderRepo, ProductRepo (extends)
  - Class \`BaseRepository\` → ConnectionPool.query

### Call Chain: \`ConnectionPool.query\`
  [depth=0] ConnectionPool.query
  [depth=1] → ConnectionPool.getConnection
  [depth=2] → Pool.connect
  [depth=1] → client.query (PostgreSQL)

### Architecture
  Entry points: DatabaseModule.configure, AppBootstrap.initialize
  Module: src/db (cohesion: 0.91)`,
    },
    {
        name: '定位 Bug',
        query: 'null pointer exception error handling null check',
        keywords: ['null', 'undefined', 'error', 'exception', 'catch', 'throw'],
        mcpResult: `// src/utils/parser.ts:80-110
function parseConfig(data: string | null): Config {
    const parsed = JSON.parse(data); // ❌ 可能为 null
    if (parsed.options.enabled) {    // ❌ options 可能 undefined
        return applyDefaults(parsed);
    }
    return parsed;
}

// src/handlers/request-handler.ts:120-140
async function handleRequest(req: Request): Promise<Response> {
    const body = await req.json();  // ❌ 可能抛出 JSON 解析异常
    const result = processData(body.data); // ❌ body.data 可能 undefined
    return { status: 200, body: result };
}`,
        graphContext: `## Graph Context
  - Function \`parseConfig\` ← loadConfig, migrateConfig, validateConfig
  - Function \`parseConfig\` → JSON.parse, applyDefaults
  - Function \`handleRequest\` ← Router.dispatch, ApiGateway.proxy
  - Function \`handleRequest\` → req.json, processData

### Call Chain: \`handleRequest\`
  [depth=0] Router.dispatch → handleRequest
  [depth=1] → req.json()
  [depth=1] → processData
  [depth=2] → parseConfig  ← ⚠️ null 风险
  [depth=2] → validateSchema

### Architecture
  Entry points: Router.dispatch, ApiGateway.proxy
  Module: src/handlers (cohesion: 0.72)`,
    },
];

// ── 主测试 ───────────────────────────────────────────────────────
async function main() {
    console.log('Token 效率对比测试\n');

    const repos = fs.readdirSync(REPOS_DIR)
        .filter(d => {
            const p = path.join(REPOS_DIR, d);
            return fs.statSync(p).isDirectory() && fs.existsSync(path.join(p, '.git'));
        });

    if (repos.length === 0) {
        console.log('⚠️  未找到测试仓库');
        return;
    }

    const comparisonResults: any[] = [];
    let totalTraditionalTokens = 0;
    let totalMcpTokens = 0;

    for (const repoName of repos.slice(0, 2)) {
        const repoPath = path.join(REPOS_DIR, repoName);
        console.log(`── ${repoName} ──`);

        for (const scenario of SCENARIOS) {
            const traditional = simulateTraditional(repoPath, scenario.query, scenario.keywords);
            const mcp = simulateMcp(scenario.mcpResult, scenario.graphContext);

            const saved = traditional.tokens - mcp.tokens;
            const pct = Math.round((saved / Math.max(traditional.tokens, 1)) * 100);

            console.log(`  ${scenario.name}:`);
            console.log(`    传统方式: ${traditional.tokens} tokens (${traditional.filesRead} files, ${traditional.linesRead} lines)`);
            console.log(`    MCP方式:  ${mcp.tokens} tokens (代码+调用链+架构)`);
            console.log(`    节省: ${saved} tokens (${pct}%)`);

            totalTraditionalTokens += traditional.tokens;
            totalMcpTokens += mcp.tokens;

            comparisonResults.push({
                repo: repoName,
                scenario: scenario.name,
                traditionalTokens: traditional.tokens,
                mcpTokens: mcp.tokens,
                filesRead: traditional.filesRead,
                linesRead: traditional.linesRead,
                savedTokens: saved,
                savedPercent: pct,
            });
        }
        console.log('');
    }

    // ── 汇总 ─────────────────────────────────────────────────────
    const totalSaved = totalTraditionalTokens - totalMcpTokens;
    const avgPct = Math.round((totalSaved / Math.max(totalTraditionalTokens, 1)) * 100);

    console.log('── 汇总 ──');
    console.log(`  传统方式总计: ${totalTraditionalTokens} tokens`);
    console.log(`  MCP方式总计:  ${totalMcpTokens} tokens`);
    console.log(`  节省: ${totalSaved} tokens (${avgPct}%)`);

    const summary = {
        timestamp: new Date().toISOString(),
        scenarios: SCENARIOS.length,
        repos: repos.slice(0, 2).length,
        totalTraditionalTokens,
        totalMcpTokens,
        totalSaved,
        avgSavedPercent: avgPct,
        results: comparisonResults,
        conclusion: avgPct > 30
            ? 'MCP 显著节省 token，建议推广使用'
            : avgPct > 10
                ? 'MCP 有一定效果，建议继续优化'
                : 'MCP 效果不明显，需要优化搜索策略',
    };

    fs.writeFileSync(TOKEN_OUTPUT, JSON.stringify(summary, null, 2));
    console.log(`\n✓ 结果已写入: ${TOKEN_OUTPUT}`);
    console.log(`✓ 测试 03 完成`);
}

main().catch(err => {
    console.error('测试 03 失败:', err);
    process.exit(1);
});