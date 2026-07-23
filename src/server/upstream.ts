import { mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "../config";

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
}

/** Raw upstream file contents; parsed lazily by the catalog. */
export interface Snapshot {
    meta: SnapshotMeta;
    items: string;
    customization: string;
    handbook: string;
    locales: Record<string, string>;
}

export interface UpstreamSource {
    latestSha(): Promise<string | null>;
    fetchFile(relPath: string, ref: string): Promise<string>;
    listLocaleFiles(ref: string): Promise<string[]>;
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
    constructor(private cfg: Config) {}

    async latestSha(): Promise<string | null> {
        try {
            const res = await fetch(
                `https://api.github.com/repos/${this.cfg.repo}/commits/${this.cfg.branch}`,
                {
                    headers: { Accept: "application/vnd.github.sha", "User-Agent": "sp-tarkov-db" },
                },
            );
            if (!res.ok) return null;
            const sha = (await res.text()).trim();
            return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
        } catch {
            return null;
        }
    }

    async fetchFile(relPath: string, ref: string): Promise<string> {
        const body = await this.getText(
            `https://raw.githubusercontent.com/${this.cfg.repo}/${ref}/${this.cfg.dbPath}/${relPath}`,
        );
        const pointer = parseLfsPointer(body);
        return pointer ? this.fetchLfsObject(pointer) : body;
    }

    async listLocaleFiles(ref: string): Promise<string[]> {
        try {
            const res = await fetch(
                `https://api.github.com/repos/${this.cfg.repo}/contents/${this.cfg.dbPath}/locales/global?ref=${ref}`,
                {
                    headers: {
                        Accept: "application/vnd.github+json",
                        "User-Agent": "sp-tarkov-db",
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

export async function downloadSnapshot(
    source: UpstreamSource,
    cfg: Config,
    log: (message: string) => void = () => {},
): Promise<Snapshot> {
    const sha = (await source.latestSha()) ?? cfg.branch;
    const localeFiles = await source.listLocaleFiles(sha);
    log(`fetching upstream snapshot of ${cfg.repo} at ${sha}`);

    const fetchOne = async (relPath: string): Promise<string> => {
        const content = await source.fetchFile(relPath, sha);
        log(`  ${relPath} (${(content.length / 1024).toFixed(0)}KB)`);
        return content;
    };

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
        },
        items,
        customization,
        handbook,
        locales,
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
        return { meta, items, customization, handbook, locales };
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
    for (const [code, content] of Object.entries(snapshot.locales)) {
        await writeAtomic(join("locales", `${code}.json`), content);
    }
    // Last: its presence certifies every file above landed.
    await writeAtomic("meta.json", JSON.stringify(snapshot.meta, null, 2));
}
