import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config";
import { ModRegistry, type SlotAddition, type StoredItem } from "./modregistry";
import { applySlotAdditions, resolveItem } from "./modresolve";
import { Forge } from "./forge";
import { parseItemTplEnum, type ItemCandidate } from "./modscan";
import { GitHubRepoSource } from "./modsource";
import { syncMods, type SyncOptions, type SyncReport } from "./modsync";
import type {
    HandbookEntry,
    HierarchyNode,
    Item,
    ImportedMod,
    ItemDetail,
    LocaleEntry,
    ModRef,
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

function toCandidate(stored: StoredItem): ItemCandidate {
    return {
        id: stored.itemId,
        kind: stored.kind,
        sourcePath: stored.sourcePath,
        cloneOf: stored.cloneOf ?? undefined,
        parentId: stored.parentId ?? undefined,
        props: stored.props ?? undefined,
        locales: stored.locales,
    };
}

interface SearchRow {
    id: string;
    idLower: string;
    internalLower: string;
}

const MAX_HIERARCHY_DEPTH = 32;
const EMPTY: ReadonlySet<number> = new Set();

interface SnapshotData {
    items: Record<string, Item>;
    locales: Record<string, Record<string, LocaleEntry>>;
    handbook: Record<string, HandbookEntry>;
    rows: SearchRow[];
    /** locale code → item id → [lowercased Name, lowercased ShortName]; built lazily per locale. */
    localeIndex: Map<string, Map<string, [string, string]>>;
    /** ItemTpl constant name to template id, for reading mods written in C#. */
    itemTpl: Map<string, string>;
    meta: SnapshotMeta;
}

export class Catalog {
    private bySptVersion = new Map<string, SnapshotData>();
    private mods: ModRegistry | null = null;
    private slotCache = new Map<string, Map<string, SlotAddition[]>>();
    private slotCacheAt: string | null = null;
    private refreshing: Promise<RefreshResponse> | null = null;
    private autoRefreshTimer: ReturnType<typeof setInterval> | null = null;
    private modSyncTimer: ReturnType<typeof setInterval> | null = null;

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
        // Snapshots used to live loose in DATA_DIR; they are unused now and just take up room.
        if (existsSync(join(cfg.dataDir, "meta.json"))) {
            log(
                `catalog: a pre-sptVersion snapshot in ${cfg.dataDir} is no longer used and can be deleted`,
            );
        }
        for (const sptVersion of cfg.sptVersions) {
            await catalog.loadSptVersion(sptVersion);
        }
        catalog.mods =
            cfg.modSyncIntervalHours > 0
                ? ModRegistry.open(cfg.modsDbPath)
                : ModRegistry.openIfPresent(cfg.modsDbPath);
        if (catalog.mods) log(`catalog: modded items from ${cfg.modsDbPath}`);
        return catalog;
    }

    private lineDir(sptVersion: string): string {
        return join(this.cfg.dataDir, sptVersion);
    }

    private async loadSptVersion(sptVersion: string, force = false): Promise<void> {
        const existing = force ? null : await loadSnapshot(this.lineDir(sptVersion));
        if (existing) {
            this.build(sptVersion, existing);
            this.log(
                `catalog: SPT ${sptVersion} at ${existing.meta.ref ?? existing.meta.sha.slice(0, 8)} from disk`,
            );
            return;
        }
        this.log(`catalog: downloading SPT ${sptVersion} (first boot, may take a minute)`);
        const snapshot = await downloadSnapshot(this.source, this.cfg, sptVersion, this.log);
        await saveSnapshot(this.lineDir(sptVersion), snapshot);
        this.build(sptVersion, snapshot);
    }

    /** The requested sptVersion, or the default when it is not one we hold. */
    private data(sptVersion?: string): SnapshotData {
        return (
            this.bySptVersion.get(sptVersion ?? this.cfg.defaultSptVersion) ??
            this.bySptVersion.get(this.cfg.defaultSptVersion)!
        );
    }

    get meta(): SnapshotMeta {
        return this.data().meta;
    }

    sptVersions(): string[] {
        return [...this.bySptVersion.keys()];
    }

    /**
     * `mods: false` hides modded items from results only. A direct link to one still resolves,
     * so a shared URL never dead-ends because of a viewer's preference.
     */
    search(
        query: string,
        locale: string,
        limit = 50,
        mods = true,
        sptVersion = this.cfg.defaultSptVersion,
        without: ReadonlySet<number> = EMPTY,
    ): { results: SearchResult[]; truncated: boolean } {
        const q = query.trim().toLowerCase();
        const data = this.data(sptVersion);
        const entries = data.locales[locale] ?? {};
        const index = this.localeIndexFor(data, locale);
        const matches: { score: number; nameLower: string; result: SearchResult }[] = [];

        for (const row of data.rows) {
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
            const item = data.items[row.id]!;
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

        for (const row of (mods ? this.mods?.searchRows(sptVersion, locale) : null) ?? []) {
            if (without.has(row.mod.id)) continue;
            const nameLower = row.name.toLowerCase();
            const shortLower = row.shortName.toLowerCase();
            const score =
                nameLower === q || shortLower === q
                    ? 0
                    : nameLower.startsWith(q) || shortLower.startsWith(q)
                      ? 1
                      : nameLower.includes(q) || shortLower.includes(q)
                        ? 2
                        : null;
            if (score === null) continue;
            matches.push({
                score,
                nameLower,
                result: {
                    id: row.itemId,
                    name: row.name,
                    shortName: row.shortName || null,
                    description: null,
                    mod: modRef(row.mod, row.version, row.sptVersion, row.approximateRef),
                },
            });
        }

        matches.sort((a, b) => a.score - b.score || a.nameLower.localeCompare(b.nameLower));
        return {
            results: matches.slice(0, limit).map((m) => m.result),
            truncated: matches.length > limit,
        };
    }

    getItem(
        id: string,
        locale: string,
        sptVersion = this.cfg.defaultSptVersion,
        mods = true,
        without: ReadonlySet<number> = EMPTY,
        modId?: number,
    ): ItemDetail | null {
        const data = this.data(sptVersion);
        const item = data.items[id];
        if (!item) return mods ? this.getModItem(id, locale, sptVersion, without, modId) : null;
        const patched = mods
            ? applySlotAdditions(item, this.slotAdditions(sptVersion, without))
            : { item, added: {} };
        return {
            item: patched.item,
            locale: data.locales[locale]?.[id] ?? null,
            handbook: data.handbook[id] ?? null,
            moddedFilters: Object.keys(patched.added).length > 0 ? patched.added : undefined,
        };
    }

    /** Built once per sptVersion and reused; rebuilt when the mod database is reopened. */
    private slotAdditions(
        sptVersion: string,
        without: ReadonlySet<number>,
    ): Map<string, SlotAddition[]> {
        // A sync in another process writes the same file, so compare its watermark rather than
        // trusting the cache to have been cleared in here.
        const syncedAt = this.mods?.state("lastSync") ?? null;
        if (syncedAt !== this.slotCacheAt) {
            this.slotCache.clear();
            this.slotCacheAt = syncedAt;
        }

        let bySlot = this.slotCache.get(sptVersion);
        if (!bySlot) {
            bySlot = this.mods?.slotAdditions(sptVersion) ?? new Map();
            this.slotCache.set(sptVersion, bySlot);
        }
        if (without.size === 0) return bySlot;

        const kept = new Map<string, SlotAddition[]>();
        for (const [slot, additions] of bySlot) {
            const keep = additions.filter((addition) => !without.has(addition.modId));
            if (keep.length > 0) kept.set(slot, keep);
        }
        return kept;
    }

    /** Vanilla wins an id outright; only ids it does not know reach the mod registry. */
    private getModItem(
        id: string,
        locale: string,
        sptVersion: string,
        without: ReadonlySet<number> = EMPTY,
        modId?: number,
    ): ItemDetail | null {
        // Falls back to another sptVersion rather than 404ing: a shared link should still open, and
        // the mod reference tells the reader which SPT version it came from.
        const claims = this.mods?.claims(id, sptVersion) ?? [];
        const stored =
            (modId === undefined ? undefined : claims.find((c) => c.mod.id === modId)) ?? claims[0];
        if (!stored || without.has(stored.mod.id)) return null;
        const conflicts = claims
            .filter((c) => c.sptVersion === stored.sptVersion && c.mod.id !== stored.mod.id)
            .map((c) => modRef(c.mod, c.version, c.sptVersion, c.approximateRef));
        const vanilla = this.data(sptVersion).items;

        const walked = new Set<string>([stored.itemId]);
        const lookup = (target: string): Item | null => {
            const base = vanilla[target];
            if (base) return base;
            if (walked.has(target)) return null;
            walked.add(target);
            const other = this.mods?.itemAnyLine(target, sptVersion);
            return other ? resolveItem(toCandidate(other), lookup).item : null;
        };
        const resolved = resolveItem(toCandidate(stored), lookup);
        const entry = stored.locales[locale] ?? stored.locales.en ?? null;
        return {
            item: resolved.item ?? {
                _id: stored.itemId,
                _name: entry?.Name ?? stored.itemId,
                _parent: stored.parentId ?? "",
                _type: "Item",
                _props: {},
            },
            locale: entry,
            handbook: stored.handbookPrice
                ? { ParentId: stored.handbookParentId ?? "", Price: stored.handbookPrice }
                : null,
            mod: modRef(stored.mod, stored.version, stored.sptVersion, stored.approximateRef),
            cloneOf: resolved.cloneOf,
            ...(conflicts.length > 0 ? { conflicts } : {}),
        };
    }

    hierarchy(
        id: string,
        locale: string,
        sptVersion = this.cfg.defaultSptVersion,
    ): HierarchyNode[] | null {
        const data = this.data(sptVersion);
        let current = data.items[id] ?? this.getModItem(id, locale, sptVersion)?.item;
        if (!current) return null;
        const entries = data.locales[locale] ?? {};
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
            current = data.items[current._parent]; // undefined (dangling parent) ends the walk
        }
        return chain.reverse();
    }

    /** Runs a mod sync against the database this catalog already has open. */
    async syncMods(options: SyncOptions = {}): Promise<SyncReport | null> {
        if (!this.mods) return null;
        const report = await syncMods(
            {
                forge: new Forge(),
                repos: new GitHubRepoSource(this.cfg.githubToken),
                registry: this.mods,
                enums: (sptVersion) => this.itemTplEnum(sptVersion),
                log: this.log,
            },
            {
                gate: { minDownloads: this.cfg.modMinDownloads, sptVersions: this.cfg.sptVersions },
                ...options,
            },
        );
        this.slotCache.clear();
        return report;
    }

    startModSync(): void {
        if (this.modSyncTimer || this.cfg.modSyncIntervalHours <= 0) return;

        // A fresh volume has no scans, and waiting a whole interval would serve vanilla-only
        // until then. Runs in the background so the site is up while it works.
        if (this.mods && this.mods.counts().scans === 0) {
            this.log("catalog: no mod scans yet, running a first sync in the background");
            this.syncMods({ full: true }).catch((err) =>
                this.log(`catalog: first mod sync failed: ${err}`),
            );
        }

        this.modSyncTimer = setInterval(
            () => {
                this.syncMods().catch((err) => this.log(`catalog: mod sync failed: ${err}`));
            },
            this.cfg.modSyncIntervalHours * 60 * 60 * 1000,
        );
    }

    /** Reopens the mod database, picking up a sync that replaced the file underneath us. */
    reloadMods(): void {
        this.mods?.close();
        this.mods = ModRegistry.openIfPresent(this.cfg.modsDbPath);
        this.slotCache.clear();
    }

    close(): void {
        this.mods?.close();
        this.mods = null;
    }

    importedMods(sptVersion?: string): ImportedMod[] {
        return this.mods?.importedMods(sptVersion) ?? [];
    }

    /** The C# template table for a sptVersion, used when scanning mods written against it. */
    itemTplEnum(sptVersion?: string): Map<string, string> {
        return this.data(sptVersion).itemTpl;
    }

    modItems(modId: number, sptVersion: string, locale = "en"): SearchResult[] {
        return (this.mods?.modItems(modId, sptVersion, locale) ?? []).map((row) => ({
            id: row.itemId,
            name: row.name,
            shortName: row.shortName || null,
            description: null,
        }));
    }

    modSptVersions(): string[] {
        return this.mods?.sptVersions() ?? [];
    }

    defaultSptVersion(): string {
        return this.cfg.defaultSptVersion;
    }

    /** One URL per item: ?spt= only where the default sptVersion has nothing to show. */
    sitemapPaths(): string[] {
        const vanilla = this.data().rows;
        const paths = vanilla.map((row) => `/item/${row.id}`);
        const covered = new Set(vanilla.map((row) => row.id));

        for (const row of this.mods?.searchRows(this.cfg.defaultSptVersion) ?? []) {
            if (covered.has(row.itemId)) continue;
            covered.add(row.itemId);
            paths.push(`/item/${row.itemId}`);
        }
        for (const sptVersion of this.modSptVersions()) {
            if (sptVersion === this.cfg.defaultSptVersion) continue;
            for (const row of this.mods?.searchRows(sptVersion) ?? []) {
                if (covered.has(row.itemId)) continue;
                covered.add(row.itemId);
                paths.push(`/item/${row.itemId}?spt=${encodeURIComponent(sptVersion)}`);
            }
        }
        return paths;
    }

    itemIds(): string[] {
        return this.data().rows.map((row) => row.id);
    }

    localeCodes(): string[] {
        return Object.keys(this.data().locales).sort();
    }

    hasLocale(code: string): boolean {
        return code in this.data().locales;
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
        let refreshed = false;
        for (const sptVersion of this.cfg.sptVersions) {
            const current = this.bySptVersion.get(sptVersion);
            const latest = await this.source.latestSha(current?.meta.ref ?? this.cfg.branch);
            if (!force && latest !== null && latest === current?.meta.sha) continue;
            await this.loadSptVersion(sptVersion, true);
            refreshed = true;
        }

        const data = this.data();
        return {
            refreshed,
            sha: data.meta.sha,
            fetchedAt: data.meta.fetchedAt,
            counts: { items: data.rows.length, locales: Object.keys(data.locales).length },
        };
    }

    private build(sptVersion: string, snapshot: Snapshot): void {
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

        this.bySptVersion.set(sptVersion, {
            items,
            locales,
            handbook,
            rows: itemList.map((item) => ({
                id: item._id,
                idLower: item._id.toLowerCase(),
                internalLower: (item._name ?? "").toLowerCase(),
            })),
            localeIndex: new Map(),
            itemTpl: parseItemTplEnum(snapshot.itemTpl),
            meta: snapshot.meta,
        });
    }

    private localeIndexFor(data: SnapshotData, code: string): Map<string, [string, string]> {
        let index = data.localeIndex.get(code);
        if (!index) {
            index = new Map();
            for (const [id, entry] of Object.entries(data.locales[code] ?? {})) {
                index.set(id, [entry.Name.toLowerCase(), entry.ShortName.toLowerCase()]);
            }
            data.localeIndex.set(code, index);
        }
        return index;
    }
}

function modRef(
    mod: { id: number; name: string; slug: string; detailUrl: string; bindsProfile: boolean },
    version: string,
    sptVersion: string,
    approximate: boolean,
): ModRef {
    return { ...mod, version, sptVersion, approximate };
}
