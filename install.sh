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
REPO_URL="https://github.com/ztcools/-AI-.git"

echo -e "${GREEN}============================================${NC}"
echo -e "${GREEN}  Claude Context 安装脚本${NC}"
echo -e "${GREEN}============================================${NC}"
echo ""

echo -e "${YELLOW}[1/6] 检查 Node.js...${NC}"
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

echo -e "${YELLOW}[2/6] 检查 pnpm...${NC}"
if command -v pnpm &> /dev/null; then
    echo -e "${GREEN}  ✓ pnpm $(pnpm --version)${NC}"
else
    echo "  正在安装 pnpm（需要 sudo 权限）..."
    sudo npm install -g pnpm
    echo -e "${GREEN}  ✓ pnpm 安装完成${NC}"
fi

echo -e "${YELLOW}[3/6] 克隆仓库...${NC}"
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

echo -e "${YELLOW}[4/6] 安装依赖 (可能需要几分钟)...${NC}"
cd "$INSTALL_DIR"
if [ -n "$SUDO_USER" ]; then
    sudo -u "$SUDO_USER" pnpm install
else
    pnpm install
fi
echo -e "${GREEN}  ✓ 依赖安装完成${NC}"

echo -e "${YELLOW}[5/6] 构建项目...${NC}"
if [ -n "$SUDO_USER" ]; then
    sudo -u "$SUDO_USER" pnpm build
else
    pnpm build
fi
echo -e "${GREEN}  ✓ 构建完成${NC}"

echo -e "${YELLOW}[6/6] 配置 MCP...${NC}"
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
        'EMBEDDING_MODEL': 'nomic-embed-text',
        'OLLAMA_HOST': 'http://10.50.4.149:11435',
        'EMBEDDING_DIMENSION': '768',
        'MILVUS_ADDRESS': 'http://10.50.4.149:19530',
        'EMBEDDING_BATCH_SIZE': '256'
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
        sudo -u "$SUDO_USER" claude mcp add claude-context -s user \
            -e EMBEDDING_PROVIDER=Ollama \
            -e EMBEDDING_MODEL=nomic-embed-text \
            -e OLLAMA_HOST=http://10.50.4.149:11435 \
            -e EMBEDDING_DIMENSION=768 \
            -e MILVUS_ADDRESS=http://10.50.4.149:19530 \
            -e EMBEDDING_BATCH_SIZE=256 \
            -- node "$MCP_ENTRY" && echo -e "${GREEN}  ✓ MCP 已配置到用户级${NC}" || {
                echo "  CLI 配置失败，尝试直接写入配置文件..."
                add_mcp_to_json "$CLAUDE_JSON" && echo -e "${GREEN}  ✓ MCP 已写入 $CLAUDE_JSON${NC}"
            }
    else
        claude mcp add claude-context -s user \
            -e EMBEDDING_PROVIDER=Ollama \
            -e EMBEDDING_MODEL=nomic-embed-text \
            -e OLLAMA_HOST=http://10.50.4.149:11435 \
            -e EMBEDDING_DIMENSION=768 \
            -e MILVUS_ADDRESS=http://10.50.4.149:19530 \
            -e EMBEDDING_BATCH_SIZE=256 \
            -- node "$MCP_ENTRY" && echo -e "${GREEN}  ✓ MCP 已配置到用户级${NC}" || {
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

echo ""
echo -e "${GREEN}============================================${NC}"
echo -e "${GREEN}  安装完成！${NC}"
echo -e "${GREEN}============================================${NC}"
echo ""
echo "  安装位置: $INSTALL_DIR"
echo "  配置文件: $CLAUDE_JSON"
echo ""
echo -e "${YELLOW}  下一步: 重启 Claude Code，输入 /mcp 确认 claude-context 已连接。${NC}"
echo -e "${YELLOW}  然后在对话框说"索引当前项目"即可开始使用。${NC}"
