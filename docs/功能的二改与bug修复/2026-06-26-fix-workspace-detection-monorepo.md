# 2026-06-26 | 工作区检测monorepo误判 & 工具描述补全

## 问题
1. `detectWorkspaceRoot()` 向上遍历目录时，每一层只要发现任意marker就返回，在monorepo场景下会停在子包的`package.json`，无法正确识别真正的仓库根目录
2. `get_indexing_status`工具的description没有说明path参数支持相对路径/工作区、默认值，与其他三个工具不一致，可能导致LLM在查询状态时强制要求用户传路径

## 修改内容

**`packages/mcp/src/utils.ts`**
- `detectWorkspaceRoot()`改为两遍扫描：
  - 第一遍：从cwd向上走到根，只找`.git`（`.git`是仓库根最可靠的唯一标记，子目录不会有）
  - 第二遍：如果找不到`.git`，再向上走找`package.json`/`pnpm-workspace.yaml`/`.vscode`作为fallback
- 彻底解决monorepo下在子目录启动时停在子包的问题

**`packages/mcp/src/index.ts`**
- 补全`get_indexing_status`工具的description，添加和其他三个工具一致的⚠️IMPORTANT段落，明确：
  - path支持绝对/相对/"."工作区路径
  - 不提供默认用当前工作区
  - 索引身份由git url+branch决定
