import { mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "../config";
import { USER_AGENT } from "./http";
import { compareVersions, targetsSptVersion } from "./semver";

export interface LfsPointer {
    oid: string;
    size: number;
}

export interface SnapshotMeta {
    sha: string;
    branch: string;
    repo: string;
    fetchedAt: string;
    localeFiles: string[];
    /** SPT release sptVersion this snapshot is for, and the tag it was pinned to. */
    sptVersion?: string;
    ref?: string;
}

/** Raw upstream file contents; parsed lazily by the catalog. */
export interface Snapshot {
    meta: SnapshotMeta;
    items: string;
    customization: string;
    handbook: string;
    locales: Record<string, string>;
    /** ItemTpl.cs, so a mod's `ItemTpl.SOME_GUN` resolves against this sptVersion's own table. */
    itemTpl: string;
}

export interface UpstreamSource {
    latestSha(ref?: string): Promise<string | null>;
    fetchFile(relPath: string, ref: string): Promise<string>;
    listLocaleFiles(ref: string): Promise<string[]>;
    listTags(): Promise<string[]>;
    fetchItemTpl(ref: string): Promise<string>;
}

export const FALLBACK_LOCALE_FILES = [
    "ch",
    "cz",
    "en",
    "es-mx",
    "es",
    "fr",
    "ge",
    "hu",
    "it",
    "jp",
    "kr",
    "pl",
    "po",
    "ro",
    "ru",
    "sk",
    "tu",
].map((code) => `${code}.json`);

const LFS_POINTER_PREFIX = "version https://git-lfs.github.com/spec/v1";

export function parseLfsPointer(text: string): LfsPointer | null {
    if (text.length > 1024 || !text.startsWith(LFS_POINTER_PREFIX)) return null;
    const oid = text.match(/^oid sha256:([0-9a-f]{64})$/m)?.[1];
    const size = text.match(/^size (\d+)$/m)?.[1];
    if (!oid || !size) return null;
    return { oid, size: Number.parseInt(size, 10) };
}

export function lfsBatchBody(pointer: LfsPointer): object {
    return {
        operation: "download",
        transfers: ["basic"],
        objects: [{ oid: pointer.oid, size: pointer.size }],
    };
}

export class Upstream implements UpstreamSource {
    private dbPathByRef = new Map<string, string>();

    constructor(private cfg: Config) {}

    /** Probes the candidates once per ref; items.json is an LFS pointer, so this is cheap. */
    private async dbPath(ref: string): Promise<string> {
        const cached = this.dbPathByRef.get(ref);
        if (cached) return cached;
        for (const candidate of this.cfg.dbPaths) {
            const url = `https://raw.githubusercontent.com/${this.cfg.repo}/${ref}/${candidate}/templates/items.json`;
            const res = await fetch(url, { method: "HEAD" });
            if (res.ok) {
                this.dbPathByRef.set(ref, candidate);
                return candidate;
            }
        }
        return this.cfg.dbPaths[0]!;
    }

    async listTags(): Promise<string[]> {
        try {
            const res = await fetch(
                `https://api.github.com/repos/${this.cfg.repo}/tags?per_page=100`,
                {
                    headers: {
                        Accept: "application/vnd.github+json",
                        "User-Agent": USER_AGENT,
                    },
                },
            );
            if (!res.ok) return [];
            const tags = (await res.json()) as { name?: string }[];
            return tags.map((tag) => tag.name).filter((name): name is string => !!name);
        } catch {
            return [];
        }
    }

    async latestSha(ref = this.cfg.branch): Promise<string | null> {
        try {
            const res = await fetch(
                `https://api.github.com/repos/${this.cfg.repo}/commits/${ref}`,
                {
                    headers: {
                        Accept: "application/vnd.github.sha",
                        "User-Agent": USER_AGENT,
                    },
                },
            );
            if (!res.ok) return null;
            const sha = (await res.text()).trim();
            return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
        } catch {
            return null;
        }
    }

    /** Lives outside the database directory, and the fork renames that directory per sptVersion. */
    async fetchItemTpl(ref: string): Promise<string> {
        for (const candidate of this.cfg.enumPaths) {
            try {
                return await this.getText(
                    `https://raw.githubusercontent.com/${this.cfg.repo}/${ref}/${candidate}`,
                );
            } catch {
                continue;
            }
        }
        return "";
    }

    async fetchFile(relPath: string, ref: string): Promise<string> {
        const dbPath = await this.dbPath(ref);
        const body = await this.getText(
            `https://raw.githubusercontent.com/${this.cfg.repo}/${ref}/${dbPath}/${relPath}`,
        );
        const pointer = parseLfsPointer(body);
        return pointer ? this.fetchLfsObject(pointer) : body;
    }

    async listLocaleFiles(ref: string): Promise<string[]> {
        try {
            const res = await fetch(
                `https://api.github.com/repos/${this.cfg.repo}/contents/${await this.dbPath(ref)}/locales/global?ref=${ref}`,
                {
                    headers: {
                        Accept: "application/vnd.github+json",
                        "User-Agent": USER_AGENT,
                    },
                },
            );
            if (!res.ok) return FALLBACK_LOCALE_FILES;
            const entries = (await res.json()) as { name?: string }[];
            const files = entries
                .map((entry) => entry.name)
                .filter(
                    (name): name is string => typeof name === "string" && name.endsWith(".json"),
                );
            return files.length > 0 ? files : FALLBACK_LOCALE_FILES;
        } catch {
            return FALLBACK_LOCALE_FILES;
        }
    }

    private async fetchLfsObject(pointer: LfsPointer): Promise<string> {
        const res = await fetch(`${this.cfg.lfsBaseUrl}/objects/batch`, {
            method: "POST",
            headers: {
                Accept: "application/vnd.git-lfs+json",
                "Content-Type": "application/vnd.git-lfs+json",
            },
            body: JSON.stringify(lfsBatchBody(pointer)),
        });
        if (!res.ok) throw new Error(`LFS batch request failed: HTTP ${res.status}`);
        const batch = (await res.json()) as {
            objects?: { actions?: { download?: { href?: string } } }[];
        };
        const href = batch.objects?.[0]?.actions?.download?.href;
        if (typeof href !== "string")
            throw new Error(`LFS batch response has no download href for ${pointer.oid}`);
        return this.getText(href);
    }

    private async getText(url: string): Promise<string> {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`GET ${url} failed: HTTP ${res.status}`);
        return res.text();
    }
}

// Only plain release tags: the repo also carries build tags (4.1.3-BEM-20260816) whose trees
// have no database, and fork release tags (v4.2.0) that are not SPT versions at all.
const RELEASE_TAG = /^\d+\.\d+(\.\d+)?$/;

/** Newest tag on a release sptVersion, e.g. 4.0.13 for "4.0". Falls back to the configured branch. */
export function refForSptVersion(tags: string[], sptVersion: string, fallback: string): string {
    const onLine = tags.filter(
        (tag) => RELEASE_TAG.test(tag) && targetsSptVersion(tag, sptVersion),
    );
    if (onLine.length === 0) return fallback;
    return onLine.reduce((best, tag) => (compareVersions(tag, best) > 0 ? tag : best));
}

export async function downloadSnapshot(
    source: UpstreamSource,
    cfg: Config,
    sptVersion?: string,
    log: (message: string) => void = () => {},
): Promise<Snapshot> {
    const ref = sptVersion
        ? refForSptVersion(await source.listTags(), sptVersion, cfg.branch)
        : cfg.branch;
    const sha = (await source.latestSha(ref)) ?? ref;
    const localeFiles = await source.listLocaleFiles(sha);
    log(`fetching upstream snapshot of ${cfg.repo} at ${ref} (${sha.slice(0, 8)})`);

    const fetchOne = async (relPath: string): Promise<string> => {
        const content = await source.fetchFile(relPath, sha);
        log(`  ${relPath} (${(content.length / 1024).toFixed(0)}KB)`);
        return content;
    };

    const itemTpl = await source.fetchItemTpl(sha);
    log(`  ItemTpl.cs (${(itemTpl.length / 1024).toFixed(0)}KB)`);
    const items = await fetchOne("templates/items.json");
    const customization = await fetchOne("templates/customization.json");
    const handbook = await fetchOne("templates/handbook.json");
    const locales: Record<string, string> = {};
    const localeContents = await Promise.all(
        localeFiles.map((file) => fetchOne(`locales/global/${file}`)),
    );
    localeFiles.forEach((file, i) => {
        locales[file.replace(/\.json$/, "")] = localeContents[i]!;
    });

    return {
        meta: {
            sha,
            branch: cfg.branch,
            repo: cfg.repo,
            fetchedAt: new Date().toISOString(),
            localeFiles,
            sptVersion,
            ref,
        },
        items,
        customization,
        handbook,
        locales,
        itemTpl,
    };
}

/** Returns null when no complete snapshot exists (meta.json is written last, so it certifies one). */
export async function loadSnapshot(dataDir: string): Promise<Snapshot | null> {
    try {
        const meta = (await Bun.file(join(dataDir, "meta.json")).json()) as SnapshotMeta;
        const [items, customization, handbook] = await Promise.all([
            Bun.file(join(dataDir, "items.json")).text(),
            Bun.file(join(dataDir, "customization.json")).text(),
            Bun.file(join(dataDir, "handbook.json")).text(),
        ]);
        const locales: Record<string, string> = {};
        for (const file of meta.localeFiles) {
            locales[file.replace(/\.json$/, "")] = await Bun.file(
                join(dataDir, "locales", file),
            ).text();
        }
        const itemTpl = await Bun.file(join(dataDir, "ItemTpl.cs"))
            .text()
            .catch(() => "");
        return { meta, items, customization, handbook, locales, itemTpl };
    } catch {
        return null;
    }
}

export async function saveSnapshot(dataDir: string, snapshot: Snapshot): Promise<void> {
    await mkdir(join(dataDir, "locales"), { recursive: true });
    const writeAtomic = async (relPath: string, content: string) => {
        const path = join(dataDir, relPath);
        await Bun.write(`${path}.tmp`, content);
        await rename(`${path}.tmp`, path);
    };
    await writeAtomic("items.json", snapshot.items);
    await writeAtomic("customization.json", snapshot.customization);
    await writeAtomic("handbook.json", snapshot.handbook);
    if (snapshot.itemTpl) await writeAtomic("ItemTpl.cs", snapshot.itemTpl);
    for (const [code, content] of Object.entries(snapshot.locales)) {
        await writeAtomic(join("locales", `${code}.json`), content);
    }
    // Last: its presence certifies every file above landed.
    await writeAtomic("meta.json", JSON.stringify(snapshot.meta, null, 2));
}
