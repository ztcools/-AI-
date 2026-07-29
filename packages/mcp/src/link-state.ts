import * as path from "path";

/**
 * 会话级链接状态 — 记录"本地仓库 → 云端 collection"的绑定关系。
 *
 * 进程内单例，进程退出即失效，不落盘。
 * key = path.resolve(repoRoot)。
 */

export interface LinkInfo {
    /** 完整 identity: normalizeGitUrl(remoteUrl) + ':' + branch */
    identity: string;
    /** 云端保护分支名（如 main / master / develop） */
    branch: string;
    /** 云端 Milvus collection 名 */
    collectionName: string;
    /** 链接建立时间戳（ms） */
    linkedAt: number;
    /** 本地仓库根目录（绝对路径） */
    repoRoot: string;
    /** 远端 URL（已 normalize） */
    remoteUrl: string;
}

class LinkState {
    private links = new Map<string, LinkInfo>();

    /** 链接一个本地仓库根目录到云端 collection */
    set(repoRoot: string, info: LinkInfo): void {
        this.links.set(path.resolve(repoRoot), info);
    }

    /** 通过仓库根目录取链接信息 */
    get(repoRoot: string): LinkInfo | undefined {
        return this.links.get(path.resolve(repoRoot));
    }

    /**
     * 通过任意 codebase 路径取链接信息。
     * 若传入路径在已链接仓库的子目录内，同样命中（向上匹配最长的已链接根）。
     */
    getByPath(codebasePath: string): LinkInfo | undefined {
        const resolved = path.resolve(codebasePath);
        // 先精确命中
        const direct = this.links.get(resolved);
        if (direct) return direct;
        // 再向上找已链接的根
        let cursor = resolved;
        const root = path.parse(cursor).root;
        while (cursor !== root) {
            cursor = path.dirname(cursor);
            const hit = this.links.get(cursor);
            if (hit) return hit;
        }
        return undefined;
    }

    /** 是否存在该仓库的链接 */
    has(repoRoot: string): boolean {
        return this.links.has(path.resolve(repoRoot));
    }

    /** 取消链接 */
    delete(repoRoot: string): boolean {
        return this.links.delete(path.resolve(repoRoot));
    }

    /** 列出所有已链接仓库 */
    list(): LinkInfo[] {
        return Array.from(this.links.values());
    }
}

export const linkState = new LinkState();
