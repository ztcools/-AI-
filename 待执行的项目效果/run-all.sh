#!/usr/bin/env bash
set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RESULTS_DIR="$SCRIPT_DIR/test-results"
mkdir -p "$RESULTS_DIR"

# ── 可配置：测试仓库列表 ──────────────────────────────────────────
REPOS=(
    "https://github.com/torvalds/linux"
    "https://github.com/microsoft/vscode"
    "https://github.com/tensorflow/tensorflow"
    "https://github.com/openjdk/jdk"
    "https://github.com/chromium/chromium"
    "https://github.com/llvm/llvm-project"
)
REPOS_DIR="$SCRIPT_DIR/test-repos"

# ── 环境检查 ──────────────────────────────────────────────────────
echo -e "${CYAN}============================================${NC}"
echo -e "${CYAN}  项目效果验证测试套件${NC}"
echo -e "${CYAN}============================================${NC}"
echo ""

echo -e "${YELLOW}[环境检查]${NC}"

# Node.js
if ! command -v node &>/dev/null; then
    echo -e "${RED}  ✗ Node.js 未安装${NC}"
    exit 1
fi
NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 20 ]; then
    echo -e "${RED}  ✗ Node.js >= 20 需要 (当前: $(node -v))${NC}"
    exit 1
fi
echo -e "${GREEN}  ✓ Node.js $(node -v)${NC}"

# pnpm
if ! command -v pnpm &>/dev/null; then
    echo -e "${RED}  ✗ pnpm 未安装${NC}"
    exit 1
fi
echo -e "${GREEN}  ✓ pnpm $(pnpm --version)${NC}"

# MCP 环境变量检查
HAS_MCP=true
if [ -z "$MILVUS_ADDRESS" ] || [ -z "$EMBEDDING_PROVIDER" ]; then
    HAS_MCP=false
    echo -e "${YELLOW}  ⚠ MCP 环境变量未设置，将跳过在线测试 (02-06)${NC}"
    echo -e "${YELLOW}    请设置: MILVUS_ADDRESS, EMBEDDING_PROVIDER, EMBEDDING_MODEL 等${NC}"
else
    echo -e "${GREEN}  ✓ MCP 环境变量已配置${NC}"
fi

echo ""

# ── 安装依赖 ──────────────────────────────────────────────────────
echo -e "${YELLOW}[安装依赖]${NC}"
cd "$SCRIPT_DIR"
if [ ! -f "package.json" ]; then
    cat > package.json << 'PKGJSON'
{
    "name": "claude-context-tests",
    "private": true,
    "scripts": {
        "test": "npx tsx"
    },
    "dependencies": {
        "better-sqlite3": "^11.0.0"
    },
    "devDependencies": {
        "@types/better-sqlite3": "^7.6.0",
        "@types/node": "^20.0.0",
        "tsx": "^4.19.4",
        "typescript": "^5.0.0"
    }
}
PKGJSON
fi
pnpm install --no-frozen-lockfile 2>&1 | tail -3
echo -e "${GREEN}  ✓ 依赖就绪${NC}"
echo ""

# ── 克隆测试仓库 ──────────────────────────────────────────────────
echo -e "${YELLOW}[克隆测试仓库]${NC}"
mkdir -p "$REPOS_DIR"
for repo_url in "${REPOS[@]}"; do
    repo_name=$(basename "$repo_url" .git)
    repo_path="$REPOS_DIR/$repo_name"
    if [ -d "$repo_path/.git" ]; then
        echo -e "  ${GREEN}✓${NC} $repo_name (已存在)"
    else
        echo -e "  ${YELLOW}↓${NC} 正在克隆 $repo_name (--depth 1)..."
        git clone --depth 1 "$repo_url" "$repo_path" 2>&1 | tail -1
    fi
done
echo ""

# ── 运行测试 ──────────────────────────────────────────────────────
PASS=0
FAIL=0
TOTAL=0

run_test() {
    local name="$1"
    local file="$2"
    local needs_mcp="$3"
    TOTAL=$((TOTAL + 1))

    echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${CYAN}[测试 $TOTAL] $name${NC}"
    echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

    if [ "$needs_mcp" = "true" ] && [ "$HAS_MCP" = "false" ]; then
        echo -e "${YELLOW}  ⏭ 跳过 (需要 MCP 环境)${NC}"
        return
    fi

    if npx tsx "$SCRIPT_DIR/$file" 2>&1; then
        echo -e "${GREEN}  ✓ 通过${NC}"
        PASS=$((PASS + 1))
    else
        echo -e "${RED}  ✗ 失败${NC}"
        FAIL=$((FAIL + 1))
    fi
    echo ""
}

# 测试 01：图引擎离线基准（无需 MCP）
run_test "图引擎离线基准测试" "test-01-graph-engine-offline.ts" "false"

# 测试 02-06：需要 MCP 环境
run_test "MCP 完整集成测试" "test-02-mcp-full-integration.ts" "true"
run_test "Token 效率对比" "test-03-token-efficiency.ts" "true"
run_test "多仓库隔离测试" "test-04-multi-repo-isolation.ts" "true"
run_test "代码质量对比" "test-05-code-quality.ts" "true"
run_test "增量索引测试" "test-06-incremental-index.ts" "true"

# ── 汇总 ──────────────────────────────────────────────────────────
echo -e "${CYAN}============================================${NC}"
echo -e "${CYAN}  测试汇总${NC}"
echo -e "${CYAN}============================================${NC}"
echo -e "  总计: $TOTAL | ${GREEN}通过: $PASS${NC} | ${RED}失败: $FAIL${NC}"

if [ $FAIL -eq 0 ]; then
    echo -e "\n${GREEN}  全部测试通过！项目效果验证成功。${NC}"
else
    echo -e "\n${RED}  有 $FAIL 项测试失败，请检查日志。${NC}"
fi

echo ""
echo "  结果目录: $RESULTS_DIR"
echo "  测试仓库: $REPOS_DIR"