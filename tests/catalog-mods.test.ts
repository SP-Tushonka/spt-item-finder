import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Catalog } from "../src/server/catalog";
import type { ForgeMod } from "../src/server/forge";
import { ModRegistry } from "../src/server/modregistry";
import { FixtureSource, IDS, testConfig } from "./helpers";

const MOD_ITEM = "6943c85be2f21398e70378cc";
const CHAINED_ITEM = "6a4d4d3b4b248ca65d9ee731";
const DEEP_ITEM = "6a4d4d3b4b248ca65d9ee732";
const CONTESTED_ITEM = "6a4d4d3b4b248ca65d9ee733";

const MOD: ForgeMod = {
    id: 2512,
    guid: "com.wtt.backport",
    name: "WTT - Content Backport",
    slug: "wtt-content-backport",
    detailUrl: "https://sp-mod.com/mod/2512/wtt-content-backport",
    downloads: 434494,
    category: "Overhauls",
    owner: "WTT",
    updatedAt: "2026-08-20T00:00:00.000000Z",
    sourceLinks: [{ url: "https://github.com/WelcomeToTarkov/Tarkov-1.0-Backport", label: "" }],
    bindsProfile: true,
    versions: [
        {
            id: 14001,
            version: "2.0.1",
            link: "",
            sptConstraint: "~4.1.1",
            contentLength: 1,
            description: "",
            updatedAt: "2026-08-20T00:00:00.000000Z",
        },
    ],
};

let dir: string;
let catalog: Catalog;

beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "sptdb-mods-"));
    const dbPath = join(dir, "mods.sqlite");

    const registry = ModRegistry.open(dbPath);
    registry.upsertMods([MOD]);
    registry.recordScan(
        {
            versionId: 14001,
            sptVersion: "4.1",
            outcome: "items",
            repo: { owner: "w", name: "r", ref: "main", refKind: "branch" },
        },
        [
            {
                id: MOD_ITEM,
                kind: "clone-json",
                sourcePath: "db/CustomItems/plates.json",
                cloneOf: IDS.bottle,
                parentId: IDS.foodNode,
                props: { Width: 2 },
                locales: {
                    en: { Name: "Tac-Kek SAPI plate", ShortName: "TK SAPI", Description: "" },
                },
                handbookPrice: 4350,
            },
        ],
    );
    // Its own mod: the re-scan test below wipes mod 2512's items, and a clone chain must survive.
    registry.upsertMods([
        {
            ...MOD,
            id: 3001,
            name: "Chain Mod",
            slug: "chain-mod",
            versions: [{ ...MOD.versions[0]!, id: 30010 }],
        },
    ]);
    registry.recordScan({ versionId: 30010, sptVersion: "4.1", outcome: "items" }, [
        {
            id: CHAINED_ITEM,
            kind: "clone-json",
            sourcePath: "db/CustomItems/plates.json",
            cloneOf: MOD_ITEM,
            parentId: IDS.foodNode,
            props: { Height: 3 },
            locales: { en: { Name: "Relayed plate Tan", ShortName: "RP Tan", Description: "" } },
        },
        {
            id: DEEP_ITEM,
            kind: "clone-json",
            sourcePath: "db/CustomItems/plates.json",
            cloneOf: CHAINED_ITEM,
            parentId: IDS.foodNode,
            props: { StackMaxSize: 4 },
            locales: { en: { Name: "Relayed plate Black", ShortName: "RP Blk", Description: "" } },
        },
        {
            id: CONTESTED_ITEM,
            kind: "clone-json",
            sourcePath: "db/CustomItems/plates.json",
            cloneOf: IDS.bottle,
            parentId: IDS.foodNode,
            props: { Width: 7 },
            locales: { en: { Name: "Contested plate", ShortName: "CP", Description: "" } },
        },
    ]);
    registry.upsertMods([
        {
            ...MOD,
            id: 3002,
            name: "Rival Mod",
            slug: "rival-mod",
            downloads: 100,
            versions: [{ ...MOD.versions[0]!, id: 30020 }],
        },
    ]);
    registry.recordScan({ versionId: 30020, sptVersion: "4.1", outcome: "items" }, [
        {
            id: CONTESTED_ITEM,
            kind: "clone-json",
            sourcePath: "db/CustomItems/plates.json",
            cloneOf: IDS.bottle,
            parentId: IDS.foodNode,
            props: { Width: 9 },
            locales: { en: { Name: "Contested plate", ShortName: "CP", Description: "" } },
        },
    ]);
    registry.close();

    catalog = await Catalog.init(
        testConfig(dir, { MODS_DB_PATH: dbPath, DEFAULT_SPT_VERSION: "4.1" }),
        new FixtureSource(),
        () => {},
    );
});

afterAll(async () => {
    catalog.close();
    // Windows can keep the sqlite handle a moment after close; the OS clears its own temp dir.
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }).catch(() => {});
});

describe("modded search", () => {
    test("modded items appear alongside vanilla ones", () => {
        const { results } = catalog.search("tac-kek", "en");
        expect(results).toHaveLength(1);
        expect(results[0]).toMatchObject({ id: MOD_ITEM, name: "Tac-Kek SAPI plate" });
        expect(results[0]?.mod).toMatchObject({
            name: "WTT - Content Backport",
            version: "2.0.1",
            sptVersion: "4.1",
            approximate: true,
        });
    });

    test("vanilla results carry no mod reference", () => {
        const { results } = catalog.search("water", "en");
        expect(results.length).toBeGreaterThan(0);
        expect(results.every((r) => r.mod === undefined)).toBe(true);
    });

    test("mods: false hides them from search", () => {
        expect(catalog.search("tac-kek", "en", 50, false).results).toHaveLength(0);
    });

    test("mods: false still leaves vanilla search working", () => {
        expect(catalog.search("water", "en", 50, false).results.length).toBeGreaterThan(0);
    });
});

describe("a sync in another process", () => {
    // The CLI writes the same file the server has open; nothing in here clears its caches.
    test("new slot compatibility is picked up without a restart", () => {
        expect(catalog.getItem(IDS.orphan, "en")?.moddedFilters).toBeUndefined();

        const writer = ModRegistry.open(join(dir, "mods.sqlite"));
        writer.upsertMods([{ ...MOD, id: 99, name: "Other Mod", slug: "other" }]);
        writer.recordScan({ versionId: 14001, sptVersion: "4.1", outcome: "items" }, [
            {
                id: MOD_ITEM,
                kind: "clone-json",
                sourcePath: "db/CustomItems/plates.json",
                cloneOf: IDS.bottle,
                parentId: IDS.foodNode,
                props: { Width: 2 },
                locales: {
                    en: { Name: "Tac-Kek SAPI plate", ShortName: "TK SAPI", Description: "" },
                },
                handbookPrice: 4350,
                modSlots: ["mod_stock"],
            },
        ]);
        writer.setState("lastSync", "2026-08-23T00:00:00.000Z");
        writer.close();

        const after = catalog.getItem(IDS.orphan, "en")?.moddedFilters;
        expect(after).toEqual({ [MOD_ITEM]: "WTT - Content Backport" });
    });
});

describe("mods switched off individually", () => {
    const OFF = new Set([MOD.id]);

    test("its items leave search", () => {
        expect(catalog.search("tac-kek", "en", 50, true, "4.1", OFF).results).toHaveLength(0);
        expect(catalog.search("tac-kek", "en").results).toHaveLength(1);
    });

    test("its items stop resolving by id", () => {
        expect(catalog.getItem(MOD_ITEM, "en", "4.1", true, OFF)).toBeNull();
        expect(catalog.getItem(MOD_ITEM, "en")).not.toBeNull();
    });

    test("another mod's id is unaffected", () => {
        const other = new Set([99]);
        expect(catalog.search("tac-kek", "en", 50, true, "4.1", other).results).toHaveLength(1);
    });

    test("vanilla search is untouched", () => {
        expect(catalog.search("water", "en", 50, true, "4.1", OFF).results.length) //
            .toBeGreaterThan(0);
    });
});

describe("modded item detail", () => {
    // The toggle is a search preference: a shared link must never dead-end because of it.
    test("a direct lookup resolves whether or not search hides mods", () => {
        const detail = catalog.getItem(MOD_ITEM, "en");
        expect(detail?.locale?.Name).toBe("Tac-Kek SAPI plate");
        expect(detail?.mod?.slug).toBe("wtt-content-backport");
    });

    test("the clone target's properties are merged in", () => {
        const detail = catalog.getItem(MOD_ITEM, "en");
        expect(detail?.item._props.Width).toBe(2);
        expect(detail?.cloneOf).toBe(IDS.bottle);
    });

    // A mod item whose base is another mod item: vanilla alone cannot resolve it.
    test("a clone of another mod's item still resolves its properties", () => {
        const detail = catalog.getItem(CHAINED_ITEM, "en");
        expect(detail?.item._props.Height).toBe(3);
        expect(detail?.item._props.Width).toBe(2); // from the mod item it clones
        expect(detail?.item._props.Weight).toBe(0.65); // from vanilla, two hops up
    });

    test("clone chains resolve to any depth", () => {
        const detail = catalog.getItem(DEEP_ITEM, "en");
        expect(detail?.item._props.StackMaxSize).toBe(4);
        expect(detail?.item._props.Height).toBe(3);
        expect(detail?.item._props.Width).toBe(2);
    });

    // Two mods can ship one id, but only one wins in a real install.
    test("the more popular mod wins a contested id and the other is named", () => {
        const detail = catalog.getItem(CONTESTED_ITEM, "en");
        expect(detail?.mod?.name).toBe("Chain Mod"); // 434,494 downloads vs Rival's 100
        expect(detail?.item._props.Width).toBe(7);
        expect(detail?.conflicts?.map((c) => c.name)).toEqual(["Rival Mod"]);
    });

    test("asking for the losing mod serves its own version instead", () => {
        const detail = catalog.getItem(CONTESTED_ITEM, "en", "4.1", true, undefined, 3002);
        expect(detail?.mod?.name).toBe("Rival Mod");
        expect(detail?.item._props.Width).toBe(9);
        expect(detail?.conflicts?.map((c) => c.name)).toEqual(["Chain Mod"]);
    });

    test("an unknown mod id falls back to the winner rather than 404ing", () => {
        expect(catalog.getItem(CONTESTED_ITEM, "en", "4.1", true, undefined, 999)?.mod?.name) //
            .toBe("Chain Mod");
    });

    test("an uncontested item carries no conflict list", () => {
        expect(catalog.getItem(MOD_ITEM, "en")?.conflicts).toBeUndefined();
    });

    test("handbook price comes from the mod's own declaration", () => {
        expect(catalog.getItem(MOD_ITEM, "en")?.handbook?.Price).toBe(4350);
    });

    test("hierarchy walks from the modded item up through vanilla parents", () => {
        const chain = catalog.hierarchy(MOD_ITEM, "en");
        expect(chain?.at(-1)?.id).toBe(MOD_ITEM);
        expect(chain!.length).toBeGreaterThan(1);
    });

    test("vanilla still wins an id it already owns", () => {
        expect(catalog.getItem(IDS.bottle, "en")?.mod).toBeUndefined();
    });
});

describe("a fresh deployment", () => {
    // openIfPresent would return null on an empty volume, leaving nothing to sync into ever.
    test("creates the mod database when syncing is enabled", async () => {
        const fresh = mkdtempSync(join(tmpdir(), "sptdb-fresh-"));
        const built = await Catalog.init(
            testConfig(fresh, { MOD_SYNC_INTERVAL_HOURS: "24" }),
            new FixtureSource(),
            () => {},
        );
        expect(built.importedMods()).toEqual([]);
        expect(existsSync(join(fresh, "mods.sqlite"))).toBe(true);
        built.close();
        await rm(fresh, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }).catch(
            () => {},
        );
    });

    test("leaves no database behind when syncing is off", async () => {
        const fresh = mkdtempSync(join(tmpdir(), "sptdb-off-"));
        const built = await Catalog.init(testConfig(fresh), new FixtureSource(), () => {});
        expect(existsSync(join(fresh, "mods.sqlite"))).toBe(false);
        built.close();
        await rm(fresh, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }).catch(
            () => {},
        );
    });
});
