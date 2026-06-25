#!/usr/bin/env bash 
set -e 

RED='\033[0;31m' 
GREEN='\033[0;32m' 
YELLOW='\033[1;33m' 
NC='\033[0m' 

INSTALL_DIR="$HOME/.claude-context" 
REPO_URL="https://github.com/ztcools/-AI-.git" 

echo -e "${GREEN}============================================${NC}" 
echo -e "${GREEN}  Claude Context 安装脚本${NC}" 
echo -e "${GREEN}============================================${NC}" 
echo "" 

echo -e "${YELLOW}[1/5] 检查 Node.js...${NC}" 
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
    exit 1 
fi 

echo -e "${YELLOW}[2/5] 检查 pnpm...${NC}" 
if command -v pnpm &> /dev/null; then 
    echo -e "${GREEN}  ✓ pnpm $(pnpm --version)${NC}" 
    PNPM_CMD="pnpm"
else 
    echo "  正在安装 pnpm..." 
    curl -fsSL https://get.pnpm.io/install.sh | env PNPM_VERSION=10.12.1 sh -
    export PNPM_HOME="$HOME/.local/share/pnpm"
    export PATH="$PNPM_HOME:$PATH"
    if command -v pnpm &> /dev/null; then
        echo -e "${GREEN}  ✓ pnpm 安装完成${NC}"
        PNPM_CMD="pnpm"
    else
        echo "  官方脚本安装失败，使用 npx 模式运行 pnpm..."
        PNPM_CMD="npx pnpm"
    fi
fi 

echo -e "${YELLOW}[3/5] 克隆仓库...${NC}" 
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
echo -e "${GREEN}  ✓ 仓库就绪${NC}" 

echo -e "${YELLOW}[4/5] 安装依赖 (可能需要几分钟)...${NC}" 
cd "$INSTALL_DIR" 
export CI=true
$PNPM_CMD install 
echo -e "${GREEN}  ✓ 依赖安装完成${NC}" 

echo -e "${YELLOW}[5/5] 构建项目...${NC}" 
$PNPM_CMD build 
echo -e "${GREEN}  ✓ 构建完成${NC}" 

echo "" 
echo -e "${GREEN}============================================${NC}" 
echo -e "${GREEN}  环境已就绪！${NC}" 
echo -e "${GREEN}============================================${NC}" 
echo "" 
echo "  安装位置: $INSTALL_DIR" 
echo "  请按教程继续完成 MCP 配置。"
