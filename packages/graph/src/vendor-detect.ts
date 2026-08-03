/**
 * 判定一个仓库里哪些子树装的是别人的代码。
 *
 * 为什么需要它：约定目录名（third_party/、vendor/、external/…）只覆盖一半现实。
 * 实测 PhiLog 把 spdlog 整个**拷贝**进了 `include/spdlog/`（104/223 个文件，占 47%），
 * 目录名一点提示都没有 —— 结果自然语言查询返回的图符号被上游库刷屏，本仓库的答案
 * 一条都进不了前排。所以除了约定名，还要认两个更硬的证据：
 *
 * 1. **`.gitmodules` 里的 path** —— submodule 就是定义上的第三方代码。
 * 2. **根目录的第三方许可证文件** —— 拷贝式 vendoring 有许可证义务，仓库根上会留下
 *    `LICENSE-spdlog` / `LICENSE.fmt` / `COPYING-zlib` 这类文件。文件名里的那个词
 *    就是被 vendored 的库名，拿它去匹配同名目录段（`include/spdlog/` 命中）。
 *
 * 都是只读、只看仓库根一层，成本是一次 readdir + 可能一次小文件读。
 */
import * as fs from 'fs';
import * as path from 'path';
import { defaultVendorSegments } from './graph-store';

/** 根目录许可证文件名 → 被 vendored 的库名。 */
function segmentsFromLicenseFiles(entries: string[]): string[] {
    const out: string[] = [];
    for (const entry of entries) {
        // 先剥文档后缀再匹配。否则 `LICENSE.txt`（最常见的许可证文件名）会被读成
        // "vendored 了一个叫 txt 的库"，于是任何带 `txt/` 目录段的子树被无声降权 ——
        // flask 就是这样多出一个 `txt` 段的。`LICENSE.fmt` 这种真库名不受影响。
        const name = entry.replace(/\.(?:txt|md|rst|html?|text|asc)$/i, '');
        // LICENSE-spdlog / LICENSE.fmt / LICENSE_zlib / COPYING-openssl / spdlog-LICENSE
        const m = /^(?:LICEN[CS]E|COPYING|NOTICE)[-_.]([A-Za-z0-9][\w.+-]*)$/i.exec(name)
            || /^([A-Za-z0-9][\w.+-]*)[-_.](?:LICEN[CS]E|COPYING)$/i.exec(name);
        if (!m) continue;
        const lib = m[1];
        // 排除 "LICENSE-APACHE" 这类**协议名**——它说的是本项目用什么协议，不是 vendoring。
        if (/^(apache|mit|bsd|bsd2|bsd3|gpl|lgpl|agpl|mpl|isc|unlicense|zlib|cc0|epl|apache2|apache-2\.0|gpl2|gpl3)$/i.test(lib)) continue;
        if (lib.length < 2) continue;
        out.push(lib);
    }
    return out;
}

/** `.gitmodules` 里声明的 submodule 路径（取每段目录名）。 */
function segmentsFromGitmodules(repoRoot: string): string[] {
    const file = path.join(repoRoot, '.gitmodules');
    let text: string;
    try {
        text = fs.readFileSync(file, 'utf8');
    } catch {
        return [];
    }
    const out: string[] = [];
    for (const m of text.matchAll(/^\s*path\s*=\s*(.+)$/gim)) {
        const p = m[1].trim().replace(/^\.\//, '').replace(/\/+$/, '');
        if (!p) continue;
        // 用最后一段做匹配键：段匹配对 `libs/spdlog` 和 `spdlog` 都有效。
        const seg = p.split('/').filter(Boolean).pop();
        if (seg) out.push(seg);
    }
    return out;
}

const cache = new Map<string, string[]>();

/**
 * 仓库的 vendored 目录段列表 = 约定名 + submodule 路径 + 根许可证指名的库。
 * 结果按 repoRoot 缓存（进程内）：仓库根的这几个文件在一个会话里不会变。
 * 探测失败（路径不存在/无权限）只退化成约定名，不抛错 —— 排序辅助信息不该让搜索失败。
 */
export function detectVendorSegments(repoRoot: string): string[] {
    const hit = cache.get(repoRoot);
    if (hit) return hit;

    const segments = defaultVendorSegments();
    let entries: string[] = [];
    try {
        entries = fs.readdirSync(repoRoot);
    } catch {
        cache.set(repoRoot, segments);
        return segments;
    }
    segments.push(...segmentsFromLicenseFiles(entries));
    if (entries.includes('.gitmodules')) segments.push(...segmentsFromGitmodules(repoRoot));

    const unique = [...new Set(segments)];
    cache.set(repoRoot, unique);
    return unique;
}

/** 测试/长驻进程用：清掉探测缓存。 */
export function clearVendorSegmentCache(): void {
    cache.clear();
}
