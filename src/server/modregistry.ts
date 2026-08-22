import { Database } from "bun:sqlite";
import { statSync } from "node:fs";
import type { ImportedMod, LocaleEntry } from "../shared/types";
import type { ForgeMod } from "./forge";
import type { ItemCandidate, SkippedFile, Verdict } from "./modscan";
import { versionSortKey } from "./semver";

export type ScanOutcome = Verdict | "no-repo" | "error";

export interface SlotAddition {
    id: string;
    modId: number;
    mod: string;
}

export interface BranchPin {
    versionId: number;
    sptVersion: string;
    owner: string;
    repo: string;
    ref: string;
    sha: string | null;
}

export interface ScanRecord {
    versionId: number;
    sptVersion: string;
    outcome: ScanOutcome;
    repo?: { owner: string; name: string; ref: string; refKind: string; sha?: string } | null;
    truncated?: boolean;
    skipped?: SkippedFile[];
    scannedAt?: string;
}

export interface ModRef {
    id: number;
    name: string;
    slug: string;
    detailUrl: string;
    bindsProfile: boolean;
}

export interface SearchRow {
    itemId: string;
    name: string;
    shortName: string;
    mod: ModRef;
    version: string;
    sptVersion: string;
    approximateRef: boolean;
}

export interface StoredItem {
    itemId: string;
    sptVersion: string;
    kind: ItemCandidate["kind"];
    cloneOf: string | null;
    parentId: string | null;
    handbookParentId: string | null;
    props: Record<string, unknown> | null;
    locales: Record<string, LocaleEntry>;
    fleaPrice: number | null;
    handbookPrice: number | null;
    sourcePath: string;
    modSlots: string[] | null;
    mod: ModRef;
    version: string;
    approximateRef: boolean;
}

const SCHEMA_VERSION = 5;

const LISTING_KEY = "lastListing";

/** Served only if the latest complete listing still contained the mod; republishing restores it. */
const VISIBLE = `m.seen_at >= COALESCE((SELECT value FROM sync_state WHERE key = '${LISTING_KEY}'), '')`;

const SCHEMA = `
CREATE TABLE mod (
    id INTEGER PRIMARY KEY, guid TEXT, name TEXT NOT NULL, slug TEXT NOT NULL,
    detail_url TEXT NOT NULL DEFAULT '', owner TEXT, category TEXT,
    downloads INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT '',
    seen_at TEXT NOT NULL DEFAULT '', binds_profile INTEGER NOT NULL DEFAULT 0);

CREATE TABLE mod_version (
    id INTEGER PRIMARY KEY, mod_id INTEGER NOT NULL REFERENCES mod(id),
    version TEXT NOT NULL, sort_key INTEGER NOT NULL DEFAULT 0,
    spt_constraint TEXT NOT NULL DEFAULT '', link TEXT, content_length INTEGER,
    updated_at TEXT NOT NULL DEFAULT '');
CREATE INDEX mod_version_mod ON mod_version(mod_id);

CREATE TABLE scan (
    version_id INTEGER NOT NULL REFERENCES mod_version(id), spt_version TEXT NOT NULL,
    outcome TEXT NOT NULL, repo_owner TEXT, repo_name TEXT, repo_ref TEXT, ref_kind TEXT,
    repo_sha TEXT,
    truncated INTEGER NOT NULL DEFAULT 0, item_count INTEGER NOT NULL DEFAULT 0,
    skipped TEXT, scanned_at TEXT NOT NULL,
    PRIMARY KEY (version_id, spt_version));

CREATE TABLE mod_item (
    version_id INTEGER NOT NULL REFERENCES mod_version(id), spt_version TEXT NOT NULL,
    item_id TEXT NOT NULL, kind TEXT NOT NULL,
    clone_of TEXT, parent_id TEXT, handbook_parent_id TEXT,
    props TEXT, locales TEXT NOT NULL DEFAULT '{}',
    flea_price INTEGER, handbook_price INTEGER, source_path TEXT NOT NULL DEFAULT '',
    mod_slots TEXT,
    PRIMARY KEY (version_id, spt_version, item_id));
CREATE INDEX mod_item_id ON mod_item(item_id, spt_version);

CREATE TABLE sync_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);

`;

const CURRENT_SCAN_VIEW = `CREATE VIEW current_scan AS
SELECT s.*, v.mod_id, v.version, v.sort_key
FROM scan s JOIN mod_version v ON v.id = s.version_id
WHERE v.sort_key = (
    SELECT MAX(v2.sort_key) FROM scan s2 JOIN mod_version v2 ON v2.id = s2.version_id
    WHERE v2.mod_id = v.mod_id AND s2.spt_version = s.spt_version);`;

export class ModRegistry {
    private constructor(private db: Database) {}

    static open(path = ":memory:"): ModRegistry {
        const db = new Database(path, { create: true });
        db.run("PRAGMA journal_mode = WAL");
        db.run("PRAGMA foreign_keys = ON");
        const version = (
            db.query<{ user_version: number }, []>("PRAGMA user_version").get() ?? {
                user_version: 0,
            }
        ).user_version;
        if (version === 0) {
            // Set before the tables exist; changing it later would need a full VACUUM.
            db.run("PRAGMA auto_vacuum = INCREMENTAL");
            db.run(SCHEMA);
            db.run(CURRENT_SCAN_VIEW);
        } else {
            if (version < 2) {
                db.run("ALTER TABLE mod ADD COLUMN binds_profile INTEGER NOT NULL DEFAULT 0");
            }
            if (version < 3) db.run("ALTER TABLE scan ADD COLUMN repo_sha TEXT");
            if (version < 4) db.run("ALTER TABLE mod_item ADD COLUMN mod_slots TEXT");
            if (version < 5) renameLineColumn(db);
        }
        if (version !== SCHEMA_VERSION) db.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
        return new ModRegistry(db);
    }

    static openIfPresent(path: string): ModRegistry | null {
        try {
            return statSync(path).isFile() ? ModRegistry.open(path) : null;
        } catch {
            return null;
        }
    }

    compact(): void {
        this.db.run("PRAGMA incremental_vacuum");
    }

    close(): void {
        // Folds the write-ahead log back in, so a copied or replaced file is never half a database.
        try {
            this.db.run("PRAGMA wal_checkpoint(TRUNCATE)");
        } catch {}
        this.db.close();
    }

    upsertMods(mods: ForgeMod[], seenAt = new Date().toISOString()): void {
        const mod = this.db.prepare(
            `INSERT INTO mod (id, guid, name, slug, detail_url, owner, category, downloads,
                              updated_at, seen_at, binds_profile)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET guid = excluded.guid, name = excluded.name,
                 slug = excluded.slug, detail_url = excluded.detail_url, owner = excluded.owner,
                 category = excluded.category, downloads = excluded.downloads,
                 updated_at = excluded.updated_at, seen_at = excluded.seen_at,
                 binds_profile = excluded.binds_profile`,
        );
        const version = this.db.prepare(
            `INSERT INTO mod_version (id, mod_id, version, sort_key, spt_constraint, link,
                                      content_length, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET version = excluded.version,
                 sort_key = excluded.sort_key, spt_constraint = excluded.spt_constraint,
                 link = excluded.link, content_length = excluded.content_length,
                 updated_at = excluded.updated_at`,
        );

        this.db.transaction(() => {
            for (const entry of mods) {
                mod.run(
                    entry.id,
                    entry.guid,
                    entry.name,
                    entry.slug,
                    entry.detailUrl,
                    entry.owner,
                    entry.category,
                    entry.downloads,
                    entry.updatedAt,
                    seenAt,
                    entry.bindsProfile ? 1 : 0,
                );
                for (const v of entry.versions) {
                    version.run(
                        v.id,
                        entry.id,
                        v.version,
                        versionSortKey(v.version),
                        v.sptConstraint,
                        v.link,
                        v.contentLength,
                        v.updatedAt,
                    );
                }
            }
        })();
    }

    needsScan(versionId: number, sptVersion: string, changedAt?: string): boolean {
        const row = this.db
            .query<{ scanned_at: string }, [number, string]>(
                "SELECT scanned_at FROM scan WHERE version_id = ? AND spt_version = ?",
            )
            .get(versionId, sptVersion);
        if (!row) return true;
        return changedAt !== undefined && row.scanned_at < changedAt;
    }

    recordScan(record: ScanRecord, candidates: ItemCandidate[] = []): void {
        const scan = this.db.prepare(
            `INSERT INTO scan (version_id, spt_version, outcome, repo_owner, repo_name, repo_ref,
                               ref_kind, repo_sha, truncated, item_count, skipped, scanned_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(version_id, spt_version) DO UPDATE SET outcome = excluded.outcome,
                 repo_owner = excluded.repo_owner, repo_name = excluded.repo_name,
                 repo_ref = excluded.repo_ref, ref_kind = excluded.ref_kind,
                 repo_sha = excluded.repo_sha,
                 truncated = excluded.truncated, item_count = excluded.item_count,
                 skipped = excluded.skipped, scanned_at = excluded.scanned_at`,
        );
        const item = this.db.prepare(
            `INSERT OR REPLACE INTO mod_item (version_id, spt_version, item_id, kind, clone_of, parent_id,
                 handbook_parent_id, props, locales, flea_price, handbook_price, source_path,
                 mod_slots)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );

        this.db.transaction(() => {
            scan.run(
                record.versionId,
                record.sptVersion,
                record.outcome,
                record.repo?.owner ?? null,
                record.repo?.name ?? null,
                record.repo?.ref ?? null,
                record.repo?.refKind ?? null,
                record.repo?.sha ?? null,
                record.truncated ? 1 : 0,
                candidates.length,
                record.skipped ? JSON.stringify(record.skipped) : null,
                record.scannedAt ?? new Date().toISOString(),
            );
            this.db.run(
                `DELETE FROM mod_item WHERE spt_version = ? AND version_id IN
                 (SELECT id FROM mod_version WHERE mod_id =
                    (SELECT mod_id FROM mod_version WHERE id = ?))`,
                [record.sptVersion, record.versionId],
            );
            for (const candidate of candidates) {
                item.run(
                    record.versionId,
                    record.sptVersion,
                    candidate.id,
                    candidate.kind,
                    candidate.cloneOf ?? null,
                    candidate.parentId ?? null,
                    candidate.handbookParentId ?? null,
                    candidate.props ? JSON.stringify(candidate.props) : null,
                    JSON.stringify(candidate.locales ?? {}),
                    candidate.fleaPrice ?? null,
                    candidate.handbookPrice ?? null,
                    candidate.sourcePath,
                    candidate.modSlots ? JSON.stringify(candidate.modSlots) : null,
                );
            }
        })();
    }

    searchRows(sptVersion: string, locale = "en"): SearchRow[] {
        return this.searchRowsFor(sptVersion, sptVersion, locale);
    }

    private searchRowsFor(
        sptVersion: string | null,
        preferredSptVersion: string,
        locale: string,
    ): SearchRow[] {
        const rows = this.db
            .query<RawItemRow, [string, string]>(
                `SELECT i.item_id, i.locales, m.id AS mod_id, m.name AS mod_name, m.slug AS mod_slug,
                        m.detail_url, m.binds_profile, c.version, i.spt_version, c.ref_kind
                 FROM mod_item i
                 JOIN current_scan c ON c.version_id = i.version_id AND c.spt_version = i.spt_version
                 JOIN mod m ON m.id = c.mod_id
                 WHERE (?1 IS NULL OR i.spt_version = ?1) AND ${VISIBLE}
                 ORDER BY (i.spt_version = ?2) DESC`,
            )
            .all(sptVersion as string, preferredSptVersion);

        return rows.map((row) => {
            const entry = localeEntry(row.locales, locale);
            return {
                itemId: row.item_id,
                name: entry?.Name ?? row.item_id,
                shortName: entry?.ShortName ?? "",
                mod: modRef(row),
                version: row.version,
                sptVersion: row.spt_version,
                approximateRef: row.ref_kind === "branch",
            };
        });
    }

    allSearchRows(preferredSptVersion: string, locale = "en"): SearchRow[] {
        const seen = new Set<string>();
        return this.searchRowsFor(null, preferredSptVersion, locale).filter((row) => {
            if (seen.has(row.itemId)) return false;
            seen.add(row.itemId);
            return true;
        });
    }

    item(itemId: string, sptVersion: string, modId?: number): StoredItem | null {
        const rows = this.items(itemId, sptVersion);
        return rows.find((row) => modId === undefined || row.mod.id === modId) ?? null;
    }

    itemAnyLine(itemId: string, preferredSptVersion: string): StoredItem | null {
        return (
            this.db
                .query<RawItemRow, [string, string]>(
                    `SELECT i.*, m.id AS mod_id, m.name AS mod_name, m.slug AS mod_slug,
                            m.detail_url, m.binds_profile, c.version, c.ref_kind
                     FROM mod_item i
                     JOIN current_scan c ON c.version_id = i.version_id AND c.spt_version = i.spt_version
                     JOIN mod m ON m.id = c.mod_id
                     WHERE i.item_id = ?1 AND ${VISIBLE}
                     ORDER BY (i.spt_version = ?2) DESC
                     LIMIT 1`,
                )
                .all(itemId, preferredSptVersion)
                .map(toStoredItem)[0] ?? null
        );
    }

    items(itemId: string, sptVersion: string): StoredItem[] {
        return this.db
            .query<RawItemRow, [string, string]>(
                `SELECT i.*, m.id AS mod_id, m.name AS mod_name, m.slug AS mod_slug, m.detail_url,
                        m.binds_profile, c.version, c.ref_kind
                 FROM mod_item i
                 JOIN current_scan c ON c.version_id = i.version_id AND c.spt_version = i.spt_version
                 JOIN mod m ON m.id = c.mod_id
                 WHERE i.item_id = ? AND i.spt_version = ? AND ${VISIBLE}`,
            )
            .all(itemId, sptVersion)
            .map(toStoredItem);
    }

    /** Vanilla slot name to the modded items the server adds to it. */
    slotAdditions(sptVersion: string): Map<string, SlotAddition[]> {
        const rows = this.db
            .query<
                { item_id: string; mod_slots: string; mod_name: string; mod_id: number },
                [string]
            >(
                `SELECT i.item_id, i.mod_slots, m.name AS mod_name, m.id AS mod_id
                 FROM mod_item i
                 JOIN current_scan c ON c.version_id = i.version_id AND c.spt_version = i.spt_version
                 JOIN mod m ON m.id = c.mod_id
                 WHERE i.spt_version = ? AND i.mod_slots IS NOT NULL AND ${VISIBLE}`,
            )
            .all(sptVersion);

        const bySlot = new Map<string, SlotAddition[]>();
        for (const row of rows) {
            const addition = { id: row.item_id, modId: row.mod_id, mod: row.mod_name };
            for (const slot of JSON.parse(row.mod_slots) as string[]) {
                const ids = bySlot.get(slot);
                if (ids) ids.push(addition);
                else bySlot.set(slot, [addition]);
            }
        }
        return bySlot;
    }

    branchPinnedScans(): BranchPin[] {
        return this.db
            .query<BranchPin, []>(
                `SELECT version_id AS versionId, spt_version AS sptVersion, repo_owner AS owner, repo_name AS repo,
                        repo_ref AS ref, repo_sha AS sha
                 FROM scan
                 WHERE ref_kind = 'branch' AND repo_owner IS NOT NULL AND repo_name IS NOT NULL`,
            )
            .all();
    }

    sptVersions(): string[] {
        return this.db
            .query<{ spt_version: string }, []>(
                "SELECT DISTINCT spt_version FROM mod_item ORDER BY spt_version DESC",
            )
            .all()
            .map((row) => row.spt_version);
    }

    importedMods(sptVersion?: string): ImportedMod[] {
        const rows = this.db
            .query<RawImportedRow, [string]>(
                `SELECT m.id, m.name, m.slug, m.detail_url, m.category, m.owner, m.downloads,
                        c.spt_version, c.version, c.item_count, c.ref_kind, c.scanned_at
                 FROM current_scan c
                 JOIN mod m ON m.id = c.mod_id
                 WHERE c.item_count > 0 AND (?1 IS NULL OR c.spt_version = ?1) AND ${VISIBLE}
                 ORDER BY m.name COLLATE NOCASE, c.spt_version`,
            )
            .all((sptVersion ?? null) as string);

        const byId = new Map<number, ImportedMod>();
        for (const row of rows) {
            let mod = byId.get(row.id);
            if (!mod) {
                mod = {
                    id: row.id,
                    name: row.name,
                    slug: row.slug,
                    detailUrl: row.detail_url,
                    category: row.category,
                    owner: row.owner,
                    downloads: row.downloads,
                    sptVersions: [],
                };
                byId.set(row.id, mod);
            }
            mod.sptVersions.push({
                sptVersion: row.spt_version,
                version: row.version,
                items: row.item_count,
                scannedAt: row.scanned_at,
                approximate: row.ref_kind === "branch",
            });
        }
        return [...byId.values()];
    }

    /** Only for a listing that fully succeeded: a partial pass would hide the mods it missed. */
    completeListing(seenAt: string): void {
        this.setState(LISTING_KEY, seenAt);
    }

    hiddenMods(): { id: number; name: string; seenAt: string }[] {
        return this.db
            .query<{ id: number; name: string; seenAt: string }, []>(
                `SELECT id, name, seen_at AS seenAt FROM mod m WHERE NOT (${VISIBLE})`,
            )
            .all();
    }

    state(key: string): string | null {
        return (
            this.db
                .query<{ value: string }, [string]>("SELECT value FROM sync_state WHERE key = ?")
                .get(key)?.value ?? null
        );
    }

    setState(key: string, value: string): void {
        this.db.run(
            `INSERT INTO sync_state (key, value) VALUES (?, ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
            [key, value],
        );
    }

    counts(): { mods: number; versions: number; scans: number; items: number } {
        const one = (sql: string) => this.db.query<{ n: number }, []>(sql).get()!.n;
        return {
            mods: one("SELECT COUNT(*) AS n FROM mod"),
            versions: one("SELECT COUNT(*) AS n FROM mod_version"),
            scans: one("SELECT COUNT(*) AS n FROM scan"),
            items: one("SELECT COUNT(*) AS n FROM mod_item"),
        };
    }
}

interface RawImportedRow {
    id: number;
    name: string;
    slug: string;
    detail_url: string;
    category: string | null;
    owner: string | null;
    downloads: number;
    spt_version: string;
    version: string;
    item_count: number;
    ref_kind: string | null;
    scanned_at: string;
}

interface RawItemRow {
    item_id: string;
    spt_version: string;
    kind?: string;
    clone_of?: string | null;
    parent_id?: string | null;
    handbook_parent_id?: string | null;
    props?: string | null;
    locales: string;
    flea_price?: number | null;
    handbook_price?: number | null;
    source_path?: string;
    mod_slots?: string | null;
    mod_id: number;
    mod_name: string;
    mod_slug: string;
    detail_url: string;
    binds_profile?: number;
    version: string;
    ref_kind?: string | null;
}

function modRef(row: RawItemRow): ModRef {
    return {
        id: row.mod_id,
        name: row.mod_name,
        slug: row.mod_slug,
        detailUrl: row.detail_url,
        bindsProfile: row.binds_profile === 1,
    };
}

function localeEntry(json: string, locale: string): LocaleEntry | undefined {
    const parsed = JSON.parse(json) as Record<string, LocaleEntry>;
    return parsed[locale] ?? parsed.en;
}

function toStoredItem(row: RawItemRow): StoredItem {
    return {
        itemId: row.item_id,
        sptVersion: row.spt_version,
        kind: (row.kind ?? "database") as ItemCandidate["kind"],
        cloneOf: row.clone_of ?? null,
        parentId: row.parent_id ?? null,
        handbookParentId: row.handbook_parent_id ?? null,
        props: row.props ? (JSON.parse(row.props) as Record<string, unknown>) : null,
        locales: JSON.parse(row.locales) as Record<string, LocaleEntry>,
        fleaPrice: row.flea_price ?? null,
        handbookPrice: row.handbook_price ?? null,
        sourcePath: row.source_path ?? "",
        modSlots: row.mod_slots ? (JSON.parse(row.mod_slots) as string[]) : null,
        mod: modRef(row),
        version: row.version,
        approximateRef: row.ref_kind === "branch",
    };
}

/** The column was called `line` before it was named after what it holds. */
function renameLineColumn(db: Database): void {
    db.run("DROP VIEW IF EXISTS current_scan");
    db.run("ALTER TABLE scan RENAME COLUMN line TO spt_version");
    db.run("ALTER TABLE mod_item RENAME COLUMN line TO spt_version");
    db.run(CURRENT_SCAN_VIEW);
}
