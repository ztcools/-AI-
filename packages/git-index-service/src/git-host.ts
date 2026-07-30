/**
 * Git hosting platform detection.
 *
 * A personal access token is passed to git as HTTP basic auth, and every host
 * wants a different *username* alongside it. Guess wrong and git fails with
 * `HTTP Basic: Access denied`, which looks like a bad token rather than a bad
 * username — so this is worth getting right rather than probing:
 *
 *   GitLab (incl. self-hosted) / Gitee   → `oauth2`
 *   Huawei CodeHub (DevCloud)            → `private-token`
 *   GitHub                               → `x-access-token`
 *   Bitbucket                            → `x-token-auth`
 *
 * The management console shows the detected platform and the matching hint while
 * the URL is being typed, and the fetch path uses the same table to pick which
 * basic-auth username to try first. Keep the two in sync: the console's copy
 * lives in PhiGent at `client/src/pages/gitlab/gitHost.ts`.
 */

export type GitPlatform =
    | 'huawei-codehub'
    | 'gitlab'
    | 'github'
    | 'gitee'
    | 'bitbucket'
    | 'generic';

/** How the URL authenticates: https + token, or scp/ssh + deploy key. */
export type GitUrlScheme = 'https' | 'ssh' | 'unknown';

export interface GitHostInfo {
    platform: GitPlatform;
    /** Human-readable platform name for the console. */
    label: string;
    /** Basic-auth username that pairs with a token on this platform. */
    tokenUser: string;
    scheme: GitUrlScheme;
    /** Hostname without port, lowercased. Empty when the URL doesn't parse. */
    host: string;
}

const PLATFORM_LABEL: Record<GitPlatform, string> = {
    'huawei-codehub': '华为云 CodeHub',
    gitlab: 'GitLab',
    github: 'GitHub',
    gitee: 'Gitee',
    bitbucket: 'Bitbucket',
    generic: '通用 Git',
};

const PLATFORM_TOKEN_USER: Record<GitPlatform, string> = {
    'huawei-codehub': 'private-token',
    gitlab: 'oauth2',
    github: 'x-access-token',
    gitee: 'oauth2',
    bitbucket: 'x-token-auth',
    // Unknown host: GitLab's convention is the most common for self-hosted Git.
    generic: 'oauth2',
};

/**
 * Pull the host out of either URL form. `new URL()` only handles the scheme form,
 * so scp syntax (`git@host:group/repo.git`) is matched separately.
 */
export function parseGitUrl(raw: string): { host: string; scheme: GitUrlScheme } {
    const url = (raw || '').trim();
    if (!url) return { host: '', scheme: 'unknown' };

    if (/^(https?|git|ssh):\/\//i.test(url)) {
        try {
            const u = new URL(url);
            const scheme: GitUrlScheme =
                u.protocol === 'http:' || u.protocol === 'https:' ? 'https' : 'ssh';
            return { host: u.hostname.toLowerCase(), scheme };
        } catch {
            return { host: '', scheme: 'unknown' };
        }
    }

    // scp-like: [user@]host:path
    const scp = url.match(/^(?:[A-Za-z0-9._-]+@)?([^:/\s]+):(?!\/)(.+)$/);
    if (scp) return { host: scp[1].toLowerCase(), scheme: 'ssh' };

    return { host: '', scheme: 'unknown' };
}

/** Classify a host into a known platform. */
export function platformOfHost(host: string): GitPlatform {
    const h = (host || '').toLowerCase();
    if (!h) return 'generic';
    // Huawei DevCloud/CodeArts repos live on codehub.devcloud.*.huaweicloud.com
    // and the newer *.codearts.* domains.
    if (h.includes('codehub') || h.includes('devcloud') || h.includes('codearts')) {
        return 'huawei-codehub';
    }
    if (h === 'github.com' || h.endsWith('.github.com')) return 'github';
    if (h === 'gitee.com' || h.endsWith('.gitee.com')) return 'gitee';
    if (h === 'bitbucket.org' || h.endsWith('.bitbucket.org')) return 'bitbucket';
    // Self-hosted GitLab almost always keeps `gitlab` in the hostname.
    if (h.includes('gitlab')) return 'gitlab';
    return 'generic';
}

/** Detect platform + auth flavor from a repository URL. */
export function detectGitHost(url: string): GitHostInfo {
    const { host, scheme } = parseGitUrl(url);
    const platform = platformOfHost(host);
    return {
        platform,
        label: PLATFORM_LABEL[platform],
        tokenUser: PLATFORM_TOKEN_USER[platform],
        scheme,
        host,
    };
}

/**
 * Basic-auth usernames to try for this host, best guess first. The rest stay as
 * fallbacks: self-hosted installs behind a proxy, or a platform not listed above,
 * may still accept one of them, and probing costs one failed ls-remote.
 */
export function tokenUserCandidates(host: string): string[] {
    const first = PLATFORM_TOKEN_USER[platformOfHost(host)];
    const all = ['oauth2', 'private-token', 'x-access-token', 'x-token-auth'];
    return [first, ...all.filter(u => u !== first)];
}
