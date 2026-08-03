import * as crypto from 'crypto';

/**
 * Collection 命名规则的**唯一实现**。
 *
 *   collection = <prefix>_<slug>_<md5(identity)[:8]>
 *   prefix     = hybrid ? 'hcc' : 'cc'
 *   identity   = normalizeGitUrl(repoUrl) + ':' + branch
 *
 * 抽成纯函数是因为有两个调用方需要它，而它们手上的东西不一样：
 *   - `Context`（索引/检索）有 checkout 路径，从 git remote 推出 identity；
 *   - git-index-service 的管理 API 只有仓库配置（url + 分支列表），没有 checkout ——
 *     控制台要知道"某仓库某分支对应哪个 collection"才能把分支名标到列表行上，
 *     而分支名并不在 collection 名里（故意的，见下）。
 *
 * 两处各写一份 md5 是迟早要漂的：一边改了 slug 规则，另一边算出的名字就指向一个
 * 不存在的 collection，且症状是"索引明明有、搜出来是空" —— 所以只留这一份。
 *
 * 分支**故意不进** collection 名：一个仓库的 main 和它各个分支要能一眼看出是同一个
 * 仓库。分支归属放在 collection 的 description 里（`codebasePath:<identity>`）。
 */

/** 从 repo identity（`<url>:<branch>` 或本地路径）取可读的仓库 slug。 */
export function slugForRepoIdentity(identity: string): string {
    const isGitUrl = /:\/\//.test(identity) || /^git@/.test(identity);
    let repoPart = identity;
    if (isGitUrl) {
        // Git ref 不能含 ':'，所以分支一定在最后一个冒号之后。
        const i = identity.lastIndexOf(':');
        if (i > 0) repoPart = identity.slice(0, i);
    }
    repoPart = repoPart.replace(/\.git$/i, '');
    const seg = repoPart.split(/[/:]/).filter(Boolean).pop() || 'repo';
    const repo = seg.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32);
    return repo || 'repo';
}

/** identity 的 8 位内容哈希 —— collection 名的唯一性来源。 */
export function hashForRepoIdentity(identity: string): string {
    return crypto.createHash('md5').update(identity).digest('hex').substring(0, 8);
}

/**
 * 默认命名规则下某 identity 的 collection 名。
 *
 * 注意这里**不处理** `CODE_CHUNKS_COLLECTION_NAME_OVERRIDE` 之类的覆盖 —— 覆盖是
 * 单机开发者的逃生舱，服务端与控制台都不该假设它存在。带覆盖的那条路径留在
 * `Context.getCollectionNameForIdentity` 里。
 *
 * @param hybrid 是否 hybrid 索引（dense + BM25 sparse）。团队索引一律 hybrid=true。
 */
export function collectionNameForIdentity(identity: string, hybrid: boolean = true): string {
    const prefix = hybrid ? 'hcc' : 'cc';
    return `${prefix}_${slugForRepoIdentity(identity)}_${hashForRepoIdentity(identity)}`;
}
