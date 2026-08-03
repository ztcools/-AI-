import { VectorDatabase } from './types';

/**
 * 只读包装：把 VectorDatabase 的写方法换成"直接抛错"，检索方法原样透传。
 *
 * 为什么需要它 —— 本设计里向量索引**只**由云端 git-index-service 按「仓库:保护分支」
 * 统一写入，本地 MCP 只做查询向量化 + 直连云端只读检索。但此前这条约束的保证方式是
 * "恰好没有人调用写方法"：Context 把可写的 VectorDatabase 原样交出去
 * （getVectorDatabase），而 MCP 已经持有这个句柄在用它做存在性/连通性探测。
 * 任何一次改动只要写一句 `vdb.insert(...)`，编译通过、运行时无阻拦，就会往团队共享的
 * Milvus 里写脏向量，而且没有任何测试能发现。
 *
 * 用 Proxy 而不是 class implements：VectorDatabase 有可选方法
 * （sparseSearch / flush / release），只有底层实现真的提供时才应该"存在" ——
 * class 无法表达"这个方法可能不存在"，而 Context 会用 `typeof db.sparseSearch === 'function'`
 * 判断能力。方法用 bind(target) 取出，让实现内部的 this 仍指向真实对象。
 */

/**
 * 会改变云端状态的方法。
 * - 建/删 collection、insert/delete：直接改数据
 * - flush：seal growing segment，属写路径
 * - release：把 collection 从 query node 卸载 —— 不改数据，但会让别人正在跑的搜索
 *   重新 load（团队共享实例，本地进程不该替所有人做这个决定）
 */
const WRITE_METHODS = new Set([
    'createCollection',
    'createHybridCollection',
    'dropCollection',
    'insert',
    'insertHybrid',
    'delete',
    'flush',
    'release',
]);

export const READONLY_VECTORDB_MESSAGE =
    '本地向量写入按设计禁用：向量索引由云端 git-index-service 按「仓库:保护分支」统一写入，' +
    '本地 MCP 只做只读检索。若确实需要写入，请在云端控制台触发索引。';

/** 被只读包装拦下的写操作。带上方法名，便于定位是谁调的。 */
export class ReadOnlyVectorDatabaseError extends Error {
    constructor(public readonly method: string) {
        super(`[ReadOnly] ${method}() 被拒绝 —— ${READONLY_VECTORDB_MESSAGE}`);
        this.name = 'ReadOnlyVectorDatabaseError';
    }
}

/** 只读视图的自我标记，用于幂等包装与断言。 */
const READONLY_MARK = '__seewayReadOnlyVectorDb';

/** 判断一个实例是否已经是只读视图。 */
export function isReadOnlyVectorDatabase(db: VectorDatabase): boolean {
    return (db as any)?.[READONLY_MARK] === true;
}

/**
 * 包一层只读视图。写方法抛 ReadOnlyVectorDatabaseError（同步抛，栈里能直接看到调用点，
 * `await` 一样能捕获）；底层没有的可选方法保持"不存在"。重复包装是幂等的。
 */
export function readOnlyVectorDatabase(db: VectorDatabase): VectorDatabase {
    if (isReadOnlyVectorDatabase(db)) return db;
    return new Proxy(db, {
        get(target, prop, receiver) {
            if (prop === READONLY_MARK) return true;
            const value = Reflect.get(target, prop, receiver);
            if (typeof prop === 'string' && WRITE_METHODS.has(prop)) {
                // 底层本来就没实现这个可选方法 → 继续"不存在"，别凭空造出一个会抛错的方法：
                // 调用方的能力探测（typeof x.flush === 'function'）要能得到正确答案。
                if (typeof value !== 'function') return value;
                return () => { throw new ReadOnlyVectorDatabaseError(prop); };
            }
            // bind 到真实对象：实现内部的 this 不能是 Proxy，否则它自己调用自己的
            // 写方法（比如 insertHybrid 内部重试）会被这层拦掉。
            return typeof value === 'function' ? value.bind(target) : value;
        },
    }) as VectorDatabase;
}
