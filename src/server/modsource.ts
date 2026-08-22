import type { SourceLink } from "./forge";
import { retryDelayMs, USER_AGENT } from "./http";
import type { ModFile } from "./modscan";

export interface RepoRef {
    owner: string;
    repo: string;
    ref: string;
    refKind: "tag" | "branch" | "commit";
    sha?: string;
}

export interface TreeEntry {
    path: string;
    type: string;
    size?: number;
}

export type PathSkipReason = "too-large" | "over-budget";

export interface ModTree {
    ref: RepoRef;
    files: ModFile[];
    truncated: boolean;
    skipped: { path: string; reason: PathSkipReason }[];
}

export interface RepoSource {
    listTags(owner: string, repo: string): Promise<string[]>;
    resolveCommit(owner: string, repo: string, ref: string): Promise<string | null>;
    defaultBranch(owner: string, repo: string): Promise<string | null>;
    tree(ref: RepoRef): Promise<{ entries: TreeEntry[]; truncated: boolean }>;
    read(ref: RepoRef, path: string): Promise<string>;
}

export interface FileLimits {
    maxFileBytes: number;
    maxTotalBytes: number;
    maxFiles: number;
}

export const DEFAULT_LIMITS: FileLimits = {
    maxFileBytes: 4_000_000,
    maxTotalBytes: 64_000_000,
    maxFiles: 3000,
};

const SCANNABLE = /\.(jsonc?|cs)$/i;
const IGNORED_DIRS =
    /(^|\/)(node_modules|\.git|\.github|\.vs|\.vscode|obj|bin|packages|Properties)\//i;

// A repo name may contain dots but never ends in one, so a sentence period is not eaten.
const REPO_NAME = "[A-Za-z0-9_-](?:[A-Za-z0-9_.-]*[A-Za-z0-9_-])?";
const REPO_URL = new RegExp(
    `(?:https?://)?(?:www\\.)?github\\.com/(${REPO_NAME})/(${REPO_NAME})(?=$|[^A-Za-z0-9_-])`,
    "g",
);

function repoName(match: string): string {
    return match.replace(/\.git$/, "");
}

export function parseRepoUrl(url: string): RepoRef | null {
    const release = url.match(
        /github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/releases\/download\/([^/]+)\//,
    );
    if (release) {
        return {
            owner: release[1]!,
            repo: release[2]!,
            ref: decodeURIComponent(release[3]!),
            refKind: "tag",
        };
    }
    const tree = url.match(
        /github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/(?:tree|blob)\/([^/?#]+)/,
    );
    if (tree) {
        return {
            owner: tree[1]!,
            repo: tree[2]!,
            ref: decodeURIComponent(tree[3]!),
            refKind: "branch",
        };
    }
    REPO_URL.lastIndex = 0;
    const plain = REPO_URL.exec(url);
    if (!plain) return null;
    return { owner: plain[1]!, repo: repoName(plain[2]!), ref: "", refKind: "branch" };
}

export function matchTag(version: string, tags: string[]): string | null {
    const wanted = version.trim();
    if (tags.includes(wanted)) return wanted;

    const normalise = (value: string) => value.toLowerCase().replace(/[^0-9a-z.]/g, "");
    const target = normalise(wanted);
    const exact = tags.filter((tag) => normalise(tag) === target);
    if (exact.length > 0) return shortest(exact);

    const stripPrefix = tags.filter((tag) => normalise(tag).replace(/^v/, "") === target);
    if (stripPrefix.length > 0) return shortest(stripPrefix);

    // Bounded by non-digits so 1.0.0 does not match the tag 11.0.0, but does match v1.0.0-fix.
    const bounded = new RegExp(`(?:^|[^0-9])${target.replace(/\./g, "\\.")}(?:$|[^0-9])`);
    const contains = tags.filter((tag) => bounded.test(normalise(tag)));
    return contains.length > 0 ? shortest(contains) : null;
}

function shortest(values: string[]): string {
    return values.reduce((best, value) => (value.length < best.length ? value : best));
}

export function selectPaths(
    entries: TreeEntry[],
    limits: FileLimits = DEFAULT_LIMITS,
): { paths: string[]; skipped: { path: string; reason: PathSkipReason }[] } {
    const paths: string[] = [];
    const skipped: { path: string; reason: PathSkipReason }[] = [];
    let total = 0;

    for (const entry of entries) {
        if (entry.type !== "blob") continue;
        if (!SCANNABLE.test(entry.path) || IGNORED_DIRS.test(entry.path)) continue;

        const size = entry.size ?? 0;
        if (size > limits.maxFileBytes) {
            skipped.push({ path: entry.path, reason: "too-large" });
            continue;
        }
        if (paths.length >= limits.maxFiles || total + size > limits.maxTotalBytes) {
            skipped.push({ path: entry.path, reason: "over-budget" });
            continue;
        }
        paths.push(entry.path);
        total += size;
    }
    return { paths, skipped };
}

export function discoverRepo(sourceLinks: SourceLink[], sptVersion?: string): RepoRef | null {
    const parsed = sourceLinks.flatMap((link) => {
        const ref = parseRepoUrl(link.url);
        return ref ? [{ ref, score: labelScore(link.label, sptVersion) }] : [];
    });
    if (parsed.length === 0) return null;
    return parsed.reduce((best, entry) => (entry.score < best.score ? entry : best)).ref;
}

// Labels are not always versions: "C#" vs "Node", "Current" vs "OG".
const CURRENT_LABEL = /^(c#|csharp|current)$/i;
const LEGACY_LABEL = /^(node|js|ts|typescript|og|original|legacy|old)$/i;

function labelScore(label: string, sptVersion?: string): number {
    if (!label) return 2;
    if (CURRENT_LABEL.test(label)) return 0;
    if (LEGACY_LABEL.test(label)) return 4;
    if (!sptVersion) return 1;
    if (label === sptVersion) return 0;
    return major(label) === major(sptVersion) ? 1 : 3;
}

function major(value: string): string {
    return value.split(".")[0] ?? "";
}

export async function resolveRef(
    source: RepoSource,
    ref: RepoRef,
    version: string,
): Promise<RepoRef | null> {
    const pinned = await pin(source, ref, version);
    if (!pinned) return null;
    return {
        ...pinned,
        sha: (await source.resolveCommit(ref.owner, ref.repo, pinned.ref)) ?? undefined,
    };
}

async function pin(source: RepoSource, ref: RepoRef, version: string): Promise<RepoRef | null> {
    if (ref.refKind === "tag" && ref.ref) return ref;

    const tag = matchTag(version, await source.listTags(ref.owner, ref.repo));
    if (tag) return { ...ref, ref: tag, refKind: "tag" };

    const branch = ref.ref || (await source.defaultBranch(ref.owner, ref.repo));
    return branch ? { ...ref, ref: branch, refKind: "branch" } : null;
}

export async function openMod(
    source: RepoSource,
    ref: RepoRef,
    limits: FileLimits = DEFAULT_LIMITS,
): Promise<ModTree> {
    const { entries, truncated } = await source.tree(ref);
    const { paths, skipped } = selectPaths(entries, limits);
    return {
        ref,
        truncated,
        skipped,
        files: paths.map((path) => ({ path, text: () => source.read(ref, path) })),
    };
}

const API = "https://api.github.com";
const RAW = "https://raw.githubusercontent.com";

export class GitHubRepoSource implements RepoSource {
    constructor(
        private token: string | null,
        private userAgent = USER_AGENT,
    ) {}

    async listTags(owner: string, repo: string): Promise<string[]> {
        const tags: string[] = [];
        for (let page = 1; page <= 5; page++) {
            const batch = await this.api<{ name?: string }[]>(
                `/repos/${owner}/${repo}/tags?per_page=100&page=${page}`,
            );
            if (!batch || batch.length === 0) break;
            for (const tag of batch) if (tag.name) tags.push(tag.name);
            if (batch.length < 100) break;
        }
        return tags;
    }

    async resolveCommit(owner: string, repo: string, ref: string): Promise<string | null> {
        const res = await fetch(
            `${API}/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`,
            { headers: { ...this.headers(), Accept: "application/vnd.github.sha" } },
        );
        if (!res.ok) return null;
        const sha = (await res.text()).trim();
        return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
    }

    private headers(): Record<string, string> {
        const headers: Record<string, string> = {
            Accept: "application/vnd.github+json",
            "User-Agent": this.userAgent,
        };
        if (this.token) headers.Authorization = `Bearer ${this.token}`;
        return headers;
    }

    async defaultBranch(owner: string, repo: string): Promise<string | null> {
        const repoInfo = await this.api<{ default_branch?: string }>(`/repos/${owner}/${repo}`);
        return repoInfo?.default_branch ?? null;
    }

    async tree(ref: RepoRef): Promise<{ entries: TreeEntry[]; truncated: boolean }> {
        const at = encodeURIComponent(ref.sha ?? ref.ref);
        const path = `/repos/${ref.owner}/${ref.repo}/git/trees/${at}?recursive=1`;
        const body = await this.api<{ tree?: TreeEntry[]; truncated?: boolean }>(path);
        return { entries: body?.tree ?? [], truncated: body?.truncated === true };
    }

    async read(ref: RepoRef, path: string): Promise<string> {
        const at = encodeURIComponent(ref.sha ?? ref.ref);
        const url = `${RAW}/${ref.owner}/${ref.repo}/${at}/${encodePath(path)}`;
        const res = await fetch(url, { headers: { "User-Agent": this.userAgent } });
        if (!res.ok) throw new Error(`GET ${url} failed: HTTP ${res.status}`);
        return res.text();
    }

    private async api<T>(path: string, retry = true): Promise<T | null> {
        const res = await fetch(`${API}${path}`, { headers: this.headers() });
        if (res.ok) return (await res.json()) as T;

        const wait = retryDelayMs(res);
        if (retry && wait !== null && wait <= 120_000) {
            await Bun.sleep(wait);
            return this.api<T>(path, false);
        }
        return null;
    }
}

function encodePath(path: string): string {
    return path.split("/").map(encodeURIComponent).join("/");
}
