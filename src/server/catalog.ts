import type { Config } from "../config";
import type {
    HandbookEntry,
    HierarchyNode,
    Item,
    ItemDetail,
    LocaleEntry,
    RefreshResponse,
    SearchResult,
} from "../shared/types";
import {
    downloadSnapshot,
    loadSnapshot,
    saveSnapshot,
    type Snapshot,
    type SnapshotMeta,
    type UpstreamSource,
} from "./upstream";

interface SearchRow {
    id: string;
    idLower: string;
    internalLower: string;
}

const MAX_HIERARCHY_DEPTH = 32;

export class Catalog {
    private items: Record<string, Item> = {};
    private locales: Record<string, Record<string, LocaleEntry>> = {};
    private handbook: Record<string, HandbookEntry> = {};
    private rows: SearchRow[] = [];
    /** locale code → item id → [lowercased Name, lowercased ShortName]; built lazily per locale. */
    private localeIndex = new Map<string, Map<string, [string, string]>>();
    private refreshing: Promise<RefreshResponse> | null = null;
    private autoRefreshTimer: ReturnType<typeof setInterval> | null = null;
    meta!: SnapshotMeta;

    private constructor(
        private cfg: Config,
        private source: UpstreamSource,
        private log: (message: string) => void,
    ) {}

    static async init(
        cfg: Config,
        source: UpstreamSource,
        log: (message: string) => void = console.log,
    ): Promise<Catalog> {
        const catalog = new Catalog(cfg, source, log);
        const existing = await loadSnapshot(cfg.dataDir);
        if (existing) {
            catalog.build(existing);
            log(
                `catalog: loaded snapshot ${existing.meta.sha.slice(0, 8)} from disk (fetched ${existing.meta.fetchedAt})`,
            );
        } else {
            log(
                `catalog: no snapshot in ${cfg.dataDir}; downloading (first boot, may take a minute)`,
            );
            const snapshot = await downloadSnapshot(source, cfg, log);
            await saveSnapshot(cfg.dataDir, snapshot);
            catalog.build(snapshot);
        }
        return catalog;
    }

    search(
        query: string,
        locale: string,
        limit = 50,
    ): { results: SearchResult[]; truncated: boolean } {
        const q = query.trim().toLowerCase();
        const entries = this.locales[locale] ?? {};
        const index = this.localeIndexFor(locale);
        const matches: { score: number; nameLower: string; result: SearchResult }[] = [];

        for (const row of this.rows) {
            const names = index.get(row.id);
            let score: number | null = null;
            if (names && (names[0] === q || names[1] === q)) {
                score = 0;
            } else if (
                (names && (names[0].startsWith(q) || names[1].startsWith(q))) ||
                row.internalLower.startsWith(q)
            ) {
                score = 1;
            } else if (
                (names && (names[0].includes(q) || names[1].includes(q))) ||
                row.internalLower.includes(q) ||
                row.idLower.includes(q)
            ) {
                score = 2;
            }
            if (score === null) continue;

            const entry = entries[row.id];
            const item = this.items[row.id]!;
            matches.push({
                score,
                nameLower: names?.[0] ?? row.internalLower,
                result: {
                    id: row.id,
                    name: entry?.Name ?? item._name,
                    shortName: entry?.ShortName ?? null,
                    description: entry?.Description ?? null,
                },
            });
        }

        matches.sort((a, b) => a.score - b.score || a.nameLower.localeCompare(b.nameLower));
        return {
            results: matches.slice(0, limit).map((m) => m.result),
            truncated: matches.length > limit,
        };
    }

    getItem(id: string, locale: string): ItemDetail | null {
        const item = this.items[id];
        if (!item) return null;
        return {
            item,
            locale: this.locales[locale]?.[id] ?? null,
            handbook: this.handbook[id] ?? null,
        };
    }

    hierarchy(id: string, locale: string): HierarchyNode[] | null {
        let current = this.items[id];
        if (!current) return null;
        const entries = this.locales[locale] ?? {};
        const chain: HierarchyNode[] = [];
        const seen = new Set<string>();

        while (current && chain.length < MAX_HIERARCHY_DEPTH && !seen.has(current._id)) {
            seen.add(current._id);
            chain.push({
                id: current._id,
                name: entries[current._id]?.Name ?? current._name,
                parent: current._parent,
            });
            if (!current._parent) break;
            current = this.items[current._parent]; // undefined (dangling parent) ends the walk
        }
        return chain.reverse();
    }

    itemIds(): string[] {
        return this.rows.map((row) => row.id);
    }

    localeCodes(): string[] {
        return Object.keys(this.locales).sort();
    }

    hasLocale(code: string): boolean {
        return code in this.locales;
    }

    /** Concurrent calls coalesce onto one in-flight refresh. */
    refresh(force = false): Promise<RefreshResponse> {
        this.refreshing ??= this.doRefresh(force).finally(() => {
            this.refreshing = null;
        });
        return this.refreshing;
    }

    startAutoRefresh(): void {
        if (this.autoRefreshTimer || this.cfg.refreshIntervalHours <= 0) return;
        this.autoRefreshTimer = setInterval(
            () => {
                this.refresh().catch((err) => this.log(`catalog: auto-refresh failed: ${err}`));
            },
            this.cfg.refreshIntervalHours * 60 * 60 * 1000,
        );
    }

    private async doRefresh(force: boolean): Promise<RefreshResponse> {
        const latest = await this.source.latestSha();
        if (!force && latest !== null && latest === this.meta.sha) {
            return { refreshed: false, sha: this.meta.sha };
        }
        const snapshot = await downloadSnapshot(this.source, this.cfg, this.log);
        await saveSnapshot(this.cfg.dataDir, snapshot);
        this.build(snapshot);
        return {
            refreshed: true,
            sha: this.meta.sha,
            fetchedAt: this.meta.fetchedAt,
            counts: { items: this.rows.length, locales: Object.keys(this.locales).length },
        };
    }

    private build(snapshot: Snapshot): void {
        const items: Record<string, Item> = {
            ...(JSON.parse(snapshot.items) as Record<string, Item>),
            ...(JSON.parse(snapshot.customization) as Record<string, Item>),
        };

        const locales: Record<string, Record<string, LocaleEntry>> = {};
        const itemList = Object.values(items);
        for (const [code, content] of Object.entries(snapshot.locales)) {
            const flat = JSON.parse(content) as Record<string, string>;
            const entries: Record<string, LocaleEntry> = {};
            for (const item of itemList) {
                if (item._type === "Node") continue;
                const name = flat[`${item._id} Name`];
                if (name === undefined) continue;
                entries[item._id] = {
                    Name: name,
                    ShortName: flat[`${item._id} ShortName`] ?? "",
                    Description: flat[`${item._id} Description`] ?? "",
                };
            }
            locales[code] = entries;
        }

        const handbook: Record<string, HandbookEntry> = {};
        const handbookJson = JSON.parse(snapshot.handbook) as {
            Items?: { Id: string; ParentId: string; Price: number }[];
        };
        for (const entry of handbookJson.Items ?? []) {
            handbook[entry.Id] = { ParentId: entry.ParentId, Price: entry.Price };
        }

        this.items = items;
        this.locales = locales;
        this.handbook = handbook;
        this.rows = itemList.map((item) => ({
            id: item._id,
            idLower: item._id.toLowerCase(),
            internalLower: (item._name ?? "").toLowerCase(),
        }));
        this.localeIndex.clear();
        this.meta = snapshot.meta;
    }

    private localeIndexFor(code: string): Map<string, [string, string]> {
        let index = this.localeIndex.get(code);
        if (!index) {
            index = new Map();
            for (const [id, entry] of Object.entries(this.locales[code] ?? {})) {
                index.set(id, [entry.Name.toLowerCase(), entry.ShortName.toLowerCase()]);
            }
            this.localeIndex.set(code, index);
        }
        return index;
    }
}
