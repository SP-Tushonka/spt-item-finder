import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Catalog } from "../src/server/catalog";
import { FixtureSource, IDS, testConfig } from "./helpers";

let dir: string;
let source: FixtureSource;
let catalog: Catalog;

beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "sptdb-catalog-"));
    source = new FixtureSource();
    catalog = await Catalog.init(testConfig(dir), source, () => {});
});

afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
});

describe("ingestion", () => {
    test("merges customization items into the item set", () => {
        const detail = catalog.getItem(IDS.customizationHead, "en");
        expect(detail).not.toBeNull();
        expect(detail!.item._name).toBe("customization_head");
        expect(detail!.locale?.Name).toBe("Head");
    });

    test("skips Node items when building locales", () => {
        const detail = catalog.getItem(IDS.foodNode, "en");
        expect(detail).not.toBeNull();
        expect(detail!.locale).toBeNull();
    });

    test("extracts Name/ShortName/Description locale triples", () => {
        const detail = catalog.getItem(IDS.waterRation, "en");
        expect(detail!.locale).toEqual({
            Name: "Emergency Water Ration",
            ShortName: "Water",
            Description: "An emergency water ration.",
        });
    });

    test("maps handbook entries and leaves null for uncovered items", () => {
        expect(catalog.getItem(IDS.waterRation, "en")!.handbook).toEqual({
            ParentId: "5b47574386f77428ca22b33e",
            Price: 12000,
        });
        expect(catalog.getItem(IDS.foodNode, "en")!.handbook).toBeNull();
    });

    test("exposes sorted locale codes", () => {
        expect(catalog.localeCodes()).toEqual(["en", "fr"]);
        expect(catalog.hasLocale("en")).toBe(true);
        expect(catalog.hasLocale("de")).toBe(false);
    });
});

describe("search", () => {
    test("ranks exact ShortName match above prefix match", () => {
        const { results } = catalog.search("water", "en");
        expect(results.map((r) => r.id)).toEqual([IDS.waterRation, IDS.bottle]);
    });

    test("is case-insensitive", () => {
        const { results } = catalog.search("WATER", "en");
        expect(results.map((r) => r.id)).toEqual([IDS.waterRation, IDS.bottle]);
    });

    test("matches internal template names, falling back to _name for display", () => {
        const { results } = catalog.search("food_dr", "en");
        expect(results).toHaveLength(1);
        expect(results[0]!.id).toBe(IDS.foodNode);
        expect(results[0]!.name).toBe("food_drink");
        expect(results[0]!.shortName).toBeNull();
    });

    test("matches by item id substring", () => {
        const { results } = catalog.search("544fb62a", "en");
        expect(results.map((r) => r.id)).toEqual([IDS.waterRation]);
    });

    test("caps results and reports truncation", () => {
        const { results, truncated } = catalog.search("water", "en", 1);
        expect(results).toHaveLength(1);
        expect(truncated).toBe(true);
    });

    test("searches localized names in other locales", () => {
        const { results } = catalog.search("bouteille", "fr");
        expect(results.map((r) => r.id)).toEqual([IDS.bottle]);
        expect(results[0]!.name).toBe("Bouteille d'eau (0,6L)");
    });

    test("finds nothing for a miss", () => {
        expect(catalog.search("zzzznope", "en").results).toHaveLength(0);
    });
});

describe("hierarchy", () => {
    test("returns a root-first parent chain", () => {
        const chain = catalog.hierarchy(IDS.bottle, "en")!;
        expect(chain.map((n) => n.id)).toEqual([IDS.root, IDS.foodNode, IDS.bottle]);
        expect(chain[0]!.parent).toBe("");
        expect(chain[2]!.name).toBe("Bottle of water (0.6L)");
        expect(chain[1]!.name).toBe("food_drink"); // Node: falls back to _name
    });

    test("terminates cleanly on a dangling parent", () => {
        const chain = catalog.hierarchy(IDS.orphan, "en")!;
        expect(chain.map((n) => n.id)).toEqual([IDS.orphan]);
    });

    test("terminates cleanly on a parent cycle", () => {
        const chain = catalog.hierarchy(IDS.cycleOne, "en")!;
        expect(chain.length).toBe(2);
    });

    test("returns null for an unknown item", () => {
        expect(catalog.hierarchy("0".repeat(24), "en")).toBeNull();
    });
});

describe("snapshot persistence and refresh", () => {
    test("a second init loads from disk with zero upstream calls", async () => {
        const coldSource = new FixtureSource();
        const reloaded = await Catalog.init(testConfig(dir), coldSource, () => {});
        expect(coldSource.fetchCalls).toBe(0);
        expect(reloaded.search("water", "en").results).toHaveLength(2);
    });

    test("refresh is a no-op when the upstream sha is unchanged", async () => {
        const before = source.fetchCalls;
        const result = await catalog.refresh();
        expect(result.refreshed).toBe(false);
        expect(source.fetchCalls).toBe(before);
    });

    test("refresh with force refetches", async () => {
        const before = source.fetchCalls;
        const result = await catalog.refresh(true);
        expect(result.refreshed).toBe(true);
        expect(result.counts?.items).toBe(8);
        expect(result.counts?.locales).toBe(2);
        expect(source.fetchCalls).toBeGreaterThan(before);
    });

    test("refresh refetches when the upstream sha changes", async () => {
        source.sha = "b".repeat(40);
        const result = await catalog.refresh();
        expect(result.refreshed).toBe(true);
        expect(result.sha).toBe("b".repeat(40));
    });
});

describe("ItemTpl table", () => {
    // Mods written in C# say ItemTpl.SOME_GUN; the table that resolves it is per SPT sptVersion.
    test("is parsed from the snapshot", async () => {
        const dir2 = mkdtempSync(join(tmpdir(), "sptdb-enum-"));
        const withEnum = new FixtureSource();
        withEnum.itemTpl = `public static readonly MongoId SHOTGUN = new MongoId("61f7c9e189e6fb1a5e3ea78d");`;
        const built = await Catalog.init(testConfig(dir2), withEnum, () => {});
        expect(built.itemTplEnum().get("SHOTGUN")).toBe("61f7c9e189e6fb1a5e3ea78d");
        built.close();
        await rm(dir2, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }).catch(
            () => {},
        );
    });

    test("is empty when the snapshot has none", () => {
        expect(catalog.itemTplEnum().size).toBe(0);
    });
});
