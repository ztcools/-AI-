# 2026-06-25 | MCP路径默认工作区 & 一键安装脚本

## 改动一：MCP工具路径体验优化

### 问题
- 工具描述强制要求绝对路径，LLM无法理解相对路径或工作区
- 用户未指定路径时无默认值，必须手动传入路径
- 所有工具的path参数都标记为required，不传就报错

### 修改内容

**`packages/mcp/src/utils.ts`**
- 新增 `detectWorkspaceRoot()`：从cwd向上遍历，自动检测IDE工作区根目录（识别.git、package.json、.vscode等标记）
- 新增 `resolveCodebasePath()`：统一路径解析，支持
  - `"."` / `"workspace"` → 自动检测工作区
  - `~` / `~/xxx` → home目录
  - 绝对路径 → 原样返回
  - 相对路径 → 基于cwd解析

**`packages/mcp/src/index.ts`**
- 更新四个工具（index_codebase、search_code、clear_index、get_indexing_status）的path参数描述，明确支持绝对/相对/工作区路径
- 移除所有工具path参数的`required: ["path"]`，改为可选
- 增加"Defaults to the current workspace if not provided"说明
- 更新工具描述，明确path仅用于定位项目磁盘位置，索引身份由git url+branch决定

**`packages/mcp/src/handlers.ts`**
- 所有handler中`path`参数默认值改为`"."`
- `handleIndexCodebase`：增加索引前基于url+branch的向量数据库预检查，已存在索引直接返回，避免重复索引
- `handleClearIndex`：改为用codebaseIdentity匹配而非绝对路径

### 效果
- 用户说"帮我索引工作区"、"index this"、"search for auth"等省略路径的说法，LLM直接调用工具不需要问路径
- 支持`"."`自动检测IDE工作区，Claude Code CLI场景下cwd就是项目目录，直接可用
- 同一仓库克隆到不同位置共享同一个索引（url+branch隔离）

---

## 改动二：一键安装脚本 install.sh

### 问题
- 原install.sh丢失（从未提交到git），用户无法通过curl一键部署
- 新环境第一次装pnpm存在权限和PATH问题
- 更新时残留node_modules触发交互提示导致安装中止

### 修改内容

新建根目录 `install.sh`，push到main分支：
- 还原原版5步彩色输出风格（检查Node→检查pnpm→克隆仓库→安装依赖→构建）
- pnpm安装使用sudo（与教程前置步骤一致，小白用户环境兼容）
- 更新前清理旧node_modules，`pnpm install --force` 跳过交互提示
- 未检测到Node时输出安装指引

### 使用方式
```bash
curl -fsSL https://raw.githubusercontent.com/ztcools/-AI-/main/install.sh | bash
```
