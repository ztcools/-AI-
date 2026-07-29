#!/usr/bin/env bash
set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

if [ -n "$SUDO_USER" ]; then
    REAL_USER="$SUDO_USER"
    REAL_HOME=$(eval echo ~"$SUDO_USER")
    echo -e "${YELLOW}  检测到通过 sudo 运行，将使用用户 '$REAL_USER' ($REAL_HOME) 进行安装${NC}"
elif [ "$(id -u)" -eq 0 ]; then
    echo -e "${RED}  请勿使用 root 用户或 sudo 直接运行此脚本！${NC}"
    echo "  请切换到普通用户执行: bash install.sh"
    echo "  Node.js/pnpm 安装需要 sudo 的部分会单独提示。"
    exit 1
else
    REAL_USER="$(whoami)"
    REAL_HOME="$HOME"
fi

INSTALL_DIR="$REAL_HOME/.claude-context"
REPO_URL="https://github.com/ztcools/context.git"

# 向量后端地址(默认指向公司服务器,开箱即用;如需改用其它后端,先 export 覆盖再运行)
# 本地只做"查询向量化 + 直连云端 Milvus 只读检索 + 本地图索引"，不做任何向量写入。
OLLAMA_HOST="${OLLAMA_HOST:-http://10.50.4.149:11435}"
MILVUS_ADDRESS="${MILVUS_ADDRESS:-http://10.50.4.149:19530}"
EMBEDDING_MODEL="${EMBEDDING_MODEL:-nomic-embed-text}"
EMBEDDING_DIMENSION="${EMBEDDING_DIMENSION:-768}"
# 云端索引服务（保护分支列表 / 索引进度），供 /seeway-link 列出可链接分支
GIT_INDEX_SERVICE_URL="${GIT_INDEX_SERVICE_URL:-http://10.50.4.149:8795}"

echo -e "${GREEN}============================================${NC}"
echo -e "${GREEN}  Seeway Claude Context 安装脚本${NC}"
echo -e "${GREEN}============================================${NC}"
echo ""

echo -e "${YELLOW}[1/7] 检查 Node.js...${NC}"
if command -v node &> /dev/null; then
    NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
    if [ "$NODE_VERSION" -ge 18 ]; then
        echo -e "${GREEN}  ✓ Node.js $(node -v)${NC}"
    else
        echo -e "${RED}  Node.js 版本过低 (需要 >= 18)${NC}"
        exit 1
    fi
else
    echo -e "${RED}  未检测到 Node.js${NC}"
    echo "  请先执行教程前两步安装 Node.js 22:"
    echo "  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -"
    echo "  sudo apt-get install -y nodejs"
    exit 1
fi

echo -e "${YELLOW}[2/7] 检查 pnpm...${NC}"
if command -v pnpm &> /dev/null; then
    echo -e "${GREEN}  ✓ pnpm $(pnpm --version)${NC}"
else
    echo "  正在安装 pnpm（需要 sudo 权限）..."
    sudo npm install -g pnpm
    echo -e "${GREEN}  ✓ pnpm 安装完成${NC}"
fi

echo -e "${YELLOW}[3/7] 克隆仓库...${NC}"
if [ -d "$INSTALL_DIR" ]; then
    echo "  目录已存在，正在更新..."
    cd "$INSTALL_DIR"
    rm -rf node_modules packages/*/node_modules
    git fetch origin
    git reset --hard origin/main
else
    git clone "$REPO_URL" "$INSTALL_DIR"
    cd "$INSTALL_DIR"
fi
if [ -n "$SUDO_USER" ]; then
    chown -R "$SUDO_USER":"$SUDO_USER" "$INSTALL_DIR"
fi
echo -e "${GREEN}  ✓ 仓库就绪 ($INSTALL_DIR)${NC}"

echo -e "${YELLOW}[4/7] 安装依赖 (可能需要几分钟)...${NC}"
cd "$INSTALL_DIR"
# 只安装 MCP 子图(core + graph + mcp)的依赖,避开无关包的
# keytar(需 libsecret)、faiss 等原生依赖在用户机上编译失败。
INSTALL_FILTER='--filter @seeway/claude-context-mcp...'
if [ -n "$SUDO_USER" ]; then
    sudo -u "$SUDO_USER" pnpm install $INSTALL_FILTER --force
else
    pnpm install $INSTALL_FILTER --force
fi
echo -e "${GREEN}  ✓ 依赖安装完成${NC}"

echo -e "${YELLOW}[5/7] 构建项目...${NC}"
if [ -n "$SUDO_USER" ]; then
    sudo -u "$SUDO_USER" bash -c "pnpm build:core && pnpm build:graph && pnpm build:mcp"
else
    pnpm build:core && pnpm build:graph && pnpm build:mcp
fi
echo -e "${GREEN}  ✓ 构建完成${NC}"

echo -e "${YELLOW}[6/7] 配置 MCP...${NC}"
MCP_ENTRY="$INSTALL_DIR/packages/mcp/dist/index.js"
CLAUDE_JSON="$REAL_HOME/.claude.json"

add_mcp_to_json() {
    local json_file="$1"
    local node_cmd
    node_cmd=$(command -v node)

    if [ ! -f "$json_file" ]; then
        echo '{"mcpServers":{}}' > "$json_file"
    fi

    if command -v python3 &> /dev/null; then
        python3 -c "
import json, sys
try:
    with open('$json_file', 'r') as f:
        data = json.load(f)
except:
    data = {}
if 'mcpServers' not in data:
    data['mcpServers'] = {}
data['mcpServers']['claude-context'] = {
    'type': 'stdio',
    'command': '$node_cmd',
    'args': ['$MCP_ENTRY'],
    'env': {
        'EMBEDDING_PROVIDER': 'Ollama',
        'EMBEDDING_MODEL': '$EMBEDDING_MODEL',
        'OLLAMA_HOST': '$OLLAMA_HOST',
        'EMBEDDING_DIMENSION': '$EMBEDDING_DIMENSION',
        'MILVUS_ADDRESS': '$MILVUS_ADDRESS',
        'GIT_INDEX_SERVICE_URL': '$GIT_INDEX_SERVICE_URL'
    }
}
with open('$json_file', 'w') as f:
    json.dump(data, f, indent=2)
print('OK')
"
    else
        echo -e "${YELLOW}  未检测到 python3，请手动配置 MCP（见教程方式 A）${NC}"
        return 1
    fi
}

if command -v claude &> /dev/null; then
    echo "  检测到 Claude Code，通过 claude CLI 配置..."
    if [ -n "$SUDO_USER" ]; then
        # 幂等:先移除已存在的同名配置,避免 "already exists" 报错
        sudo -u "$SUDO_USER" claude mcp remove claude-context -s user 2>/dev/null || true
        sudo -u "$SUDO_USER" claude mcp add claude-context -s user \
            -e EMBEDDING_PROVIDER=Ollama \
            -e EMBEDDING_MODEL="$EMBEDDING_MODEL" \
            -e OLLAMA_HOST="$OLLAMA_HOST" \
            -e EMBEDDING_DIMENSION="$EMBEDDING_DIMENSION" \
            -e MILVUS_ADDRESS="$MILVUS_ADDRESS" \
            -e GIT_INDEX_SERVICE_URL="$GIT_INDEX_SERVICE_URL" \
-- node "$MCP_ENTRY" 2>/dev/null && echo -e "${GREEN}  ✓ MCP 已配置到用户级${NC}" || {
                echo "  CLI 配置失败，尝试直接写入配置文件..."
                add_mcp_to_json "$CLAUDE_JSON" && echo -e "${GREEN}  ✓ MCP 已写入 $CLAUDE_JSON${NC}"
            }
    else
        # 幂等:先移除已存在的同名配置,避免 "already exists" 报错
        claude mcp remove claude-context -s user 2>/dev/null || true
        claude mcp add claude-context -s user \
            -e EMBEDDING_PROVIDER=Ollama \
            -e EMBEDDING_MODEL="$EMBEDDING_MODEL" \
            -e OLLAMA_HOST="$OLLAMA_HOST" \
            -e EMBEDDING_DIMENSION="$EMBEDDING_DIMENSION" \
            -e MILVUS_ADDRESS="$MILVUS_ADDRESS" \
            -e GIT_INDEX_SERVICE_URL="$GIT_INDEX_SERVICE_URL" \
-- node "$MCP_ENTRY" 2>/dev/null && echo -e "${GREEN}  ✓ MCP 已配置到用户级${NC}" || {
                echo "  CLI 配置失败，尝试直接写入配置文件..."
                add_mcp_to_json "$CLAUDE_JSON" && echo -e "${GREEN}  ✓ MCP 已写入 $CLAUDE_JSON${NC}"
            }
    fi
else
    echo "  未检测到 claude 命令，直接写入配置文件..."
    add_mcp_to_json "$CLAUDE_JSON" && echo -e "${GREEN}  ✓ MCP 已写入 $CLAUDE_JSON${NC}"
fi

if [ -n "$SUDO_USER" ]; then
    chown "$SUDO_USER":"$SUDO_USER" "$CLAUDE_JSON" 2>/dev/null || true
fi

echo -e "${YELLOW}[7/7] 安装上下文策略与 /seeway 命令到用户级...${NC}"
RULES_SRC="$INSTALL_DIR/rules/code-context-policy.md"
CLAUDE_MD="$REAL_HOME/.claude/CLAUDE.md"
BEGIN_MARK="<!-- BEGIN claude-context policy (managed by install.sh — do not edit inside) -->"
END_MARK="<!-- END claude-context policy -->"

if [ -f "$RULES_SRC" ]; then
    mkdir -p "$REAL_HOME/.claude"
    [ -f "$CLAUDE_MD" ] || touch "$CLAUDE_MD"

    # 幂等：先剥离旧的托管块（若存在），再追加最新内容
    TMP_MD="$(mktemp)"
    awk -v b="$BEGIN_MARK" -v e="$END_MARK" '
        $0==b {skip=1; next}
        $0==e {skip=0; next}
        skip!=1 {print}
    ' "$CLAUDE_MD" > "$TMP_MD"

    # 去掉剥离后可能残留的尾部空行
    printf '%s\n' "$(cat "$TMP_MD")" > "$TMP_MD"

    {
        echo ""
        echo "$BEGIN_MARK"
        cat "$RULES_SRC"
        echo "$END_MARK"
    } >> "$TMP_MD"

    mv "$TMP_MD" "$CLAUDE_MD"
    if [ -n "$SUDO_USER" ]; then
        chown "$SUDO_USER":"$SUDO_USER" "$CLAUDE_MD" 2>/dev/null || true
    fi
    echo -e "${GREEN}  ✓ 策略已写入 $CLAUDE_MD（托管块，重复安装自动更新）${NC}"
else
    echo -e "${YELLOW}  未找到 $RULES_SRC，跳过策略安装${NC}"
fi

# 安装 /seeway-* 自定义 Slash 命令到用户级 commands 目录
COMMANDS_SRC="$INSTALL_DIR/commands"
COMMANDS_DST="$REAL_HOME/.claude/commands"
if [ -d "$COMMANDS_SRC" ]; then
    mkdir -p "$COMMANDS_DST"
    cp -f "$COMMANDS_SRC"/seeway-*.md "$COMMANDS_DST"/ 2>/dev/null || true
    if [ -n "$SUDO_USER" ]; then
        chown -R "$SUDO_USER":"$SUDO_USER" "$COMMANDS_DST" 2>/dev/null || true
    fi
    echo -e "${GREEN}  ✓ 已安装命令: /seeway-link /seeway-unlink /seeway-search /seeway-clear /seeway-status${NC}"
else
    echo -e "${YELLOW}  未找到 $COMMANDS_SRC，跳过 /seeway 命令安装${NC}"
fi

echo ""
echo -e "${GREEN}============================================${NC}"
echo -e "${GREEN}  安装完成！${NC}"
echo -e "${GREEN}============================================${NC}"
echo ""
echo "  安装位置: $INSTALL_DIR"
echo "  配置文件: $CLAUDE_JSON"
echo "  上下文策略: $CLAUDE_MD（仅在 claude-context 工具可用的会话生效）"
echo "  自定义命令: $COMMANDS_DST/seeway-*.md"
echo ""
echo -e "${YELLOW}  下一步: 重启 Claude Code，输入 /mcp 确认 claude-context 已连接。${NC}"
echo -e "${YELLOW}  然后 /seeway-link 链接云端索引（建本地图），再用 /seeway-search <查询> 检索。${NC}"
