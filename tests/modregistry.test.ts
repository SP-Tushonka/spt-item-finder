import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ForgeMod, ForgeVersion } from "../src/server/forge";
import type { ItemCandidate } from "../src/server/modscan";
import { ModRegistry } from "../src/server/modregistry";

function version(id: number, v: string, constraint = "~4.1.0"): ForgeVersion {
    return {
        id,
        version: v,
        link: `https://sp-mod.com/mod/download/2512/x/${v}`,
        sptConstraint: constraint,
        contentLength: 1000,
        description: "",
        updatedAt: "2026-08-01T00:00:00.000000Z",
    };
}

function mod(overrides: Partial<ForgeMod> = {}): ForgeMod {
    return {
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
        versions: [version(1, "2.0.1")],
        ...overrides,
    };
}

function candidate(id: string, overrides: Partial<ItemCandidate> = {}): ItemCandidate {
    return {
        id,
        kind: "clone-json",
        sourcePath: "db/CustomItems/a.json",
        cloneOf: "655746010177119f4a097ff7",
        parentId: "644120aa86ffbe10ee032b6f",
        props: { Width: 2 },
        locales: { en: { Name: `Item ${id.slice(0, 4)}`, ShortName: "IT", Description: "" } },
        fleaPrice: 5200,
        handbookPrice: 4350,
        ...overrides,
    };
}

const A = "6943c85be2f21398e70378cc";
const B = "661cb36922c9e10dc2d9514b";

let registry: ModRegistry;
beforeEach(() => {
    registry = ModRegistry.open(":memory:");
});
afterEach(() => {
    registry.close();
});

describe("upsertMods", () => {
    test("stores mods and their versions", () => {
        registry.upsertMods([mod()]);
        expect(registry.counts()).toMatchObject({ mods: 1, versions: 1 });
    });

    test("is idempotent and refreshes changing fields", () => {
        registry.upsertMods([mod()]);
        registry.upsertMods([mod({ downloads: 999999, name: "Renamed" })]);
        expect(registry.counts().mods).toBe(1);

        registry.recordScan({ versionId: 1, sptVersion: "4.1", outcome: "items" }, [candidate(A)]);
        expect(registry.item(A, "4.1")?.mod.name).toBe("Renamed");
    });
});

describe("needsScan", () => {
    test("is true before a scan and false after, including for no-items", () => {
        registry.upsertMods([mod()]);
        expect(registry.needsScan(1, "4.1")).toBe(true);
        registry.recordScan({ versionId: 1, sptVersion: "4.1", outcome: "no-items" });
        expect(registry.needsScan(1, "4.1")).toBe(false);
    });

    test("is tracked per sptVersion", () => {
        registry.upsertMods([mod({ versions: [version(1, "2.0.1", "~4")] })]);
        registry.recordScan({ versionId: 1, sptVersion: "4.1", outcome: "items" }, [candidate(A)]);
        expect(registry.needsScan(1, "4.1")).toBe(false);
        expect(registry.needsScan(1, "4.0")).toBe(true);
    });

    // An author can replace a version's archive without minting a new version id.
    test("is true again once the mod reports a change after the scan", () => {
        registry.upsertMods([mod()]);
        registry.recordScan({
            versionId: 1,
            sptVersion: "4.1",
            outcome: "items",
            scannedAt: "2026-08-01T00:00:00.000Z",
        });
        expect(registry.needsScan(1, "4.1", "2026-07-01T00:00:00.000Z")).toBe(false);
        expect(registry.needsScan(1, "4.1", "2026-08-20T00:00:00.000Z")).toBe(true);
    });
});

describe("recordScan", () => {
    beforeEach(() => registry.upsertMods([mod()]));

    test("round-trips a candidate with its provenance", () => {
        registry.recordScan(
            {
                versionId: 1,
                sptVersion: "4.1",
                outcome: "items",
                repo: {
                    owner: "WelcomeToThursday",
                    name: "Tarkov-1.0-Backport",
                    ref: "2.0.1",
                    refKind: "tag",
                },
            },
            [candidate(A)],
        );

        const stored = registry.item(A, "4.1");
        expect(stored).toMatchObject({
            itemId: A,
            kind: "clone-json",
            cloneOf: "655746010177119f4a097ff7",
            props: { Width: 2 },
            fleaPrice: 5200,
            version: "2.0.1",
            approximateRef: false,
        });
        expect(stored?.locales.en?.Name).toBe("Item 6943");
        expect(stored?.mod.slug).toBe("wtt-content-backport");
    });

    test("flags data taken from a branch rather than a release tag", () => {
        registry.recordScan(
            {
                versionId: 1,
                sptVersion: "4.1",
                outcome: "items",
                repo: { owner: "w", name: "r", ref: "main", refKind: "branch" },
            },
            [candidate(A)],
        );
        expect(registry.item(A, "4.1")?.approximateRef).toBe(true);
    });

    test("rescanning a version replaces its items rather than doubling them", () => {
        registry.recordScan({ versionId: 1, sptVersion: "4.1", outcome: "items" }, [
            candidate(A),
            candidate(B),
        ]);
        registry.recordScan({ versionId: 1, sptVersion: "4.1", outcome: "items" }, [candidate(A)]);
        expect(registry.counts().items).toBe(1);
        expect(registry.searchRows("4.1")).toHaveLength(1);
    });

    test("keeps the skipped diagnostics", () => {
        registry.recordScan({
            versionId: 1,
            sptVersion: "4.1",
            outcome: "items-unextractable",
            skipped: [{ path: "Mod.cs", reason: "dynamic-id" }],
        });
        expect(registry.needsScan(1, "4.1")).toBe(false);
    });
});

describe("branch drift", () => {
    test("records the commit a scan read, and lists branch-pinned scans", () => {
        registry.upsertMods([mod()]);
        registry.recordScan({
            versionId: 1,
            sptVersion: "4.1",
            outcome: "items",
            repo: {
                owner: "WelcomeToTarkov",
                name: "Tarkov-1.0-Backport",
                ref: "main",
                refKind: "branch",
                sha: "a".repeat(40),
            },
        });
        expect(registry.branchPinnedScans()).toEqual([
            {
                versionId: 1,
                sptVersion: "4.1",
                owner: "WelcomeToTarkov",
                repo: "Tarkov-1.0-Backport",
                ref: "main",
                sha: "a".repeat(40),
            },
        ]);
    });

    // A tag does not move, so it never needs re-checking.
    test("tag-pinned scans are not listed", () => {
        registry.upsertMods([mod()]);
        registry.recordScan({
            versionId: 1,
            sptVersion: "4.1",
            outcome: "items",
            repo: { owner: "a", name: "b", ref: "2.0.1", refKind: "tag", sha: "d".repeat(40) },
        });
        expect(registry.branchPinnedScans()).toEqual([]);
    });
});

describe("profile binding notice", () => {
    test("travels from the Forge listing to the item's mod reference", () => {
        registry.upsertMods([mod()]);
        registry.recordScan({ versionId: 1, sptVersion: "4.1", outcome: "items" }, [candidate(A)]);
        expect(registry.item(A, "4.1")?.mod.bindsProfile).toBe(true);
        expect(registry.searchRows("4.1")[0]?.mod.bindsProfile).toBe(true);
    });

    test("is false for a mod that declares none", () => {
        registry.upsertMods([mod({ bindsProfile: false })]);
        registry.recordScan({ versionId: 1, sptVersion: "4.1", outcome: "items" }, [candidate(A)]);
        expect(registry.item(A, "4.1")?.mod.bindsProfile).toBe(false);
    });
});

describe("searchRows", () => {
    test("returns only the newest scanned version per mod and sptVersion", () => {
        registry.upsertMods([mod({ versions: [version(1, "1.1.5"), version(2, "2.0.1")] })]);
        registry.recordScan({ versionId: 1, sptVersion: "4.1", outcome: "items" }, [candidate(A)]);
        registry.recordScan({ versionId: 2, sptVersion: "4.1", outcome: "items" }, [candidate(B)]);

        const rows = registry.searchRows("4.1");
        expect(rows.map((r) => r.itemId)).toEqual([B]);
        expect(rows[0]?.version).toBe("2.0.1");
    });

    // 1.10.0 must beat 1.9.0, which string ordering gets backwards.
    test("orders versions numerically", () => {
        registry.upsertMods([mod({ versions: [version(1, "1.9.0"), version(2, "1.10.0")] })]);
        registry.recordScan({ versionId: 1, sptVersion: "4.1", outcome: "items" }, [candidate(A)]);
        registry.recordScan({ versionId: 2, sptVersion: "4.1", outcome: "items" }, [candidate(B)]);
        expect(registry.searchRows("4.1")[0]?.version).toBe("1.10.0");
    });

    test("keeps the sptVersions separate", () => {
        registry.upsertMods([mod({ versions: [version(1, "1.1.5"), version(2, "2.0.1")] })]);
        registry.recordScan({ versionId: 1, sptVersion: "4.0", outcome: "items" }, [candidate(A)]);
        registry.recordScan({ versionId: 2, sptVersion: "4.1", outcome: "items" }, [candidate(B)]);
        expect(registry.searchRows("4.0").map((r) => r.itemId)).toEqual([A]);
        expect(registry.searchRows("4.1").map((r) => r.itemId)).toEqual([B]);
    });

    test("falls back to English when the locale is missing", () => {
        registry.upsertMods([mod()]);
        registry.recordScan({ versionId: 1, sptVersion: "4.1", outcome: "items" }, [candidate(A)]);
        expect(registry.searchRows("4.1", "fr")[0]?.name).toBe("Item 6943");
    });
});

describe("across SPT sptVersions", () => {
    // A mod that only ever targeted 4.0 is the only place its items exist.
    test("an item on another sptVersion is still found by a direct lookup", () => {
        registry.upsertMods([mod({ versions: [version(1, "2.0.5", "~4.0")] })]);
        registry.recordScan({ versionId: 1, sptVersion: "4.0", outcome: "items" }, [candidate(A)]);

        expect(registry.item(A, "4.1")).toBeNull();
        expect(registry.itemAnyLine(A, "4.1")?.sptVersion).toBe("4.0");
        expect(registry.itemAnyLine(A, "4.0")?.sptVersion).toBe("4.0");
    });

    test("the preferred sptVersion wins when an item is on both", () => {
        registry.upsertMods([mod({ versions: [version(1, "1.1.5"), version(2, "2.0.1")] })]);
        registry.recordScan({ versionId: 1, sptVersion: "4.0", outcome: "items" }, [candidate(A)]);
        registry.recordScan({ versionId: 2, sptVersion: "4.1", outcome: "items" }, [candidate(A)]);

        expect(registry.itemAnyLine(A, "4.1")?.version).toBe("2.0.1");
        expect(registry.itemAnyLine(A, "4.0")?.version).toBe("1.1.5");
    });

    test("search spans sptVersions but lists each item once", () => {
        registry.upsertMods([mod({ versions: [version(1, "1.1.5"), version(2, "2.0.1")] })]);
        registry.recordScan({ versionId: 1, sptVersion: "4.0", outcome: "items" }, [
            candidate(A),
            candidate(B),
        ]);
        registry.recordScan({ versionId: 2, sptVersion: "4.1", outcome: "items" }, [candidate(A)]);

        const rows = registry.allSearchRows("4.1");
        expect(rows.map((r) => r.itemId).sort()).toEqual([B, A].sort());
        expect(rows.find((r) => r.itemId === A)?.sptVersion).toBe("4.1");
        expect(rows.find((r) => r.itemId === B)?.sptVersion).toBe("4.0");
    });

    test("an unknown id is still null", () => {
        expect(registry.itemAnyLine(A, "4.1")).toBeNull();
    });
});

describe("items", () => {
    test("returns every mod shipping the same template id", () => {
        registry.upsertMods([
            mod(),
            mod({ id: 99, slug: "other", name: "Other Mod", versions: [version(2, "1.0.0")] }),
        ]);
        registry.recordScan({ versionId: 1, sptVersion: "4.1", outcome: "items" }, [candidate(A)]);
        registry.recordScan({ versionId: 2, sptVersion: "4.1", outcome: "items" }, [candidate(A)]);

        const ids = registry.items(A, "4.1").map((i) => i.mod.id);
        expect(ids.sort((a, b) => a - b)).toEqual([99, 2512]);
        expect(registry.item(A, "4.1", 99)?.mod.name).toBe("Other Mod");
    });

    test("returns null for an unknown id", () => {
        expect(registry.item(A, "4.1")).toBeNull();
    });
});

describe("items dropped by an update", () => {
    test("an item the new version no longer ships is deleted", () => {
        registry.upsertMods([mod({ versions: [version(1, "1.1.5"), version(2, "2.0.1")] })]);
        registry.recordScan({ versionId: 1, sptVersion: "4.1", outcome: "items" }, [
            candidate(A),
            candidate(B),
        ]);
        registry.recordScan({ versionId: 2, sptVersion: "4.1", outcome: "items" }, [candidate(A)]);

        expect(registry.item(B, "4.1")).toBeNull();
        expect(registry.item(A, "4.1")?.version).toBe("2.0.1");
        expect(registry.counts().items).toBe(1);
    });

    test("an update that adds nothing leaves the other sptVersion alone", () => {
        registry.upsertMods([mod({ versions: [version(1, "1.1.5"), version(2, "2.0.1")] })]);
        registry.recordScan({ versionId: 1, sptVersion: "4.0", outcome: "items" }, [candidate(B)]);
        registry.recordScan({ versionId: 2, sptVersion: "4.1", outcome: "items" }, [candidate(A)]);

        expect(registry.item(B, "4.0")?.itemId).toBe(B);
        expect(registry.item(A, "4.1")?.itemId).toBe(A);
    });

    test("a version that stops shipping items at all clears them", () => {
        registry.upsertMods([mod({ versions: [version(1, "1.1.5"), version(2, "2.0.1")] })]);
        registry.recordScan({ versionId: 1, sptVersion: "4.1", outcome: "items" }, [candidate(A)]);
        registry.recordScan({ versionId: 2, sptVersion: "4.1", outcome: "no-items" });

        expect(registry.searchRows("4.1")).toHaveLength(0);
        expect(registry.counts().items).toBe(0);
    });
});

describe("unpublished mods", () => {
    function seedScanned(seenAt: string) {
        registry.upsertMods([mod()], seenAt);
        registry.recordScan({ versionId: 1, sptVersion: "4.1", outcome: "items" }, [candidate(A)]);
    }

    test("everything is visible before any listing has completed", () => {
        seedScanned("2026-08-01T00:00:00.000Z");
        expect(registry.searchRows("4.1")).toHaveLength(1);
        expect(registry.item(A, "4.1")).not.toBeNull();
    });

    test("a mod the latest listing still contains stays visible", () => {
        seedScanned("2026-08-20T00:00:00.000Z");
        registry.completeListing("2026-08-20T00:00:00.000Z");
        expect(registry.searchRows("4.1")).toHaveLength(1);
        expect(registry.hiddenMods()).toEqual([]);
    });

    test("a mod missing from the latest listing leaves the api entirely", () => {
        seedScanned("2026-08-20T00:00:00.000Z");
        registry.completeListing("2026-08-22T00:00:00.000Z");

        expect(registry.searchRows("4.1")).toHaveLength(0);
        expect(registry.item(A, "4.1")).toBeNull();
        expect(registry.items(A, "4.1")).toEqual([]);
        expect(registry.hiddenMods()).toEqual([
            { id: 2512, name: "WTT - Content Backport", seenAt: "2026-08-20T00:00:00.000Z" },
        ]);
    });

    // The scans and items were only hidden, so coming back costs nothing.
    test("republishing restores it without a rescan", () => {
        seedScanned("2026-08-20T00:00:00.000Z");
        registry.completeListing("2026-08-22T00:00:00.000Z");
        expect(registry.searchRows("4.1")).toHaveLength(0);

        registry.upsertMods([mod()], "2026-08-23T00:00:00.000Z");
        registry.completeListing("2026-08-23T00:00:00.000Z");

        expect(registry.searchRows("4.1")).toHaveLength(1);
        expect(registry.needsScan(1, "4.1")).toBe(false);
    });

    test("hiding one mod leaves the others alone", () => {
        registry.upsertMods([mod()], "2026-08-20T00:00:00.000Z");
        registry.upsertMods(
            [mod({ id: 99, slug: "other", name: "Other", versions: [version(2, "1.0.0")] })],
            "2026-08-22T00:00:00.000Z",
        );
        registry.recordScan({ versionId: 1, sptVersion: "4.1", outcome: "items" }, [candidate(A)]);
        registry.recordScan({ versionId: 2, sptVersion: "4.1", outcome: "items" }, [candidate(B)]);
        registry.completeListing("2026-08-22T00:00:00.000Z");

        expect(registry.searchRows("4.1").map((r) => r.itemId)).toEqual([B]);
    });
});

describe("importedMods", () => {
    // The SQL column is snake_case and the field is camelCase; a mismatch is invisible to tsc.
    test("every field the mods page renders is populated", () => {
        registry.upsertMods([mod()]);
        registry.recordScan(
            {
                versionId: 1,
                sptVersion: "4.1",
                outcome: "items",
                repo: { owner: "w", name: "r", ref: "main", refKind: "branch" },
                scannedAt: "2026-08-22T00:00:00.000Z",
            },
            [candidate(A)],
        );

        const [imported] = registry.importedMods();
        expect(imported).toMatchObject({
            id: 2512,
            name: "WTT - Content Backport",
            slug: "wtt-content-backport",
            category: "Overhauls",
            downloads: 434494,
        });
        expect(imported!.sptVersions).toEqual([
            {
                sptVersion: "4.1",
                version: "2.0.1",
                items: 1,
                scannedAt: "2026-08-22T00:00:00.000Z",
                approximate: true,
            },
        ]);
    });

    test("filters to one SPT version", () => {
        registry.upsertMods([mod({ versions: [version(1, "1.1.5"), version(2, "2.0.1")] })]);
        registry.recordScan({ versionId: 1, sptVersion: "4.0", outcome: "items" }, [candidate(A)]);
        registry.recordScan({ versionId: 2, sptVersion: "4.1", outcome: "items" }, [candidate(B)]);

        expect(registry.importedMods("4.0")[0]?.sptVersions.map((s) => s.sptVersion)).toEqual([
            "4.0",
        ]);
        expect(registry.importedMods()[0]?.sptVersions).toHaveLength(2);
    });
});

describe("compact", () => {
    test("runs after items are replaced without disturbing what is left", () => {
        registry.upsertMods([mod({ versions: [version(1, "1.1.5"), version(2, "2.0.1")] })]);
        registry.recordScan({ versionId: 1, sptVersion: "4.1", outcome: "items" }, [
            candidate(A),
            candidate(B),
        ]);
        registry.recordScan({ versionId: 2, sptVersion: "4.1", outcome: "items" }, [candidate(A)]);

        registry.compact();
        expect(registry.counts().items).toBe(1);
        expect(registry.item(A, "4.1")?.itemId).toBe(A);
    });
});

describe("sync state", () => {
    test("round-trips a watermark", () => {
        expect(registry.state("lastSync")).toBeNull();
        registry.setState("lastSync", "2026-08-22T00:00:00.000Z");
        registry.setState("lastSync", "2026-08-23T00:00:00.000Z");
        expect(registry.state("lastSync")).toBe("2026-08-23T00:00:00.000Z");
    });
});
