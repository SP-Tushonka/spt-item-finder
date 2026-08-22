import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ForgeApi, ForgeMod, ForgePage, ForgeVersion } from "../src/server/forge";
import { ModRegistry } from "../src/server/modregistry";
import type { RepoRef, RepoSource, TreeEntry } from "../src/server/modsource";
import { syncMods } from "../src/server/modsync";

const CLONE_JSON = `{
  "6943c85be2f21398e70378cc": {
    "itemTplToClone": "655746010177119f4a097ff7",
    "overrideProperties": { "Width": 2 },
    "locales": { "en": { "name": "Tac-Kek plate", "shortName": "TK" } }
  }
}`;

function version(id: number, v: string, constraint = "~4.1.0"): ForgeVersion {
    return {
        id,
        version: v,
        link: "",
        sptConstraint: constraint,
        contentLength: 10,
        description: "",
        updatedAt: "2026-08-01T00:00:00.000Z",
    };
}

function mod(overrides: Partial<ForgeMod> = {}): ForgeMod {
    return {
        id: 2512,
        guid: null,
        name: "WTT - Content Backport",
        slug: "backport",
        detailUrl: "",
        downloads: 400000,
        category: "Overhauls",
        owner: "WTT",
        updatedAt: "2026-08-01T00:00:00.000Z",
        sourceLinks: [{ url: "https://github.com/w/backport", label: "" }],
        bindsProfile: true,
        versions: [version(1, "2.0.1")],
        ...overrides,
    };
}

class FakeForge implements ForgeApi {
    pages: ForgePage[] = [];
    queries: Record<string, string>[] = [];
    async page(query: Record<string, string>, page: number): Promise<ForgePage | null> {
        this.queries.push(query);
        return this.pages[page - 1] ?? null;
    }
}

class FakeRepos implements RepoSource {
    tags: string[] = [];
    branch: string | null = "main";
    commit: string | null = "a".repeat(40);
    entries: TreeEntry[] = [{ path: "db/CustomItems/a.json", type: "blob", size: 200 }];
    contents: Record<string, string> = { "db/CustomItems/a.json": CLONE_JSON };
    treeCalls = 0;

    async listTags(): Promise<string[]> {
        return this.tags;
    }
    async resolveCommit(): Promise<string | null> {
        return this.commit;
    }
    async defaultBranch(): Promise<string | null> {
        return this.branch;
    }
    async tree(): Promise<{ entries: TreeEntry[]; truncated: boolean }> {
        this.treeCalls++;
        return { entries: this.entries, truncated: false };
    }
    async read(_ref: RepoRef, path: string): Promise<string> {
        const found = this.contents[path];
        if (found === undefined) throw new Error(`missing ${path}`);
        return found;
    }
}

let registry: ModRegistry;
let forge: FakeForge;
let repos: FakeRepos;

function deps() {
    return { forge, repos, registry, enums: () => new Map<string, string>() };
}

beforeEach(() => {
    registry = ModRegistry.open(":memory:");
    forge = new FakeForge();
    repos = new FakeRepos();
    forge.pages = [{ mods: [mod()], lastPage: 1, total: 1 }];
});
afterEach(() => registry.close());

describe("syncMods", () => {
    test("lists, gates, scans and stores in one pass", async () => {
        const report = await syncMods(deps(), { now: "2026-08-22T00:00:00.000Z" });
        expect(report).toMatchObject({ listed: 1, gated: 1, scanned: 1, items: 1 });
        expect(report.outcomes).toEqual({ items: 1 });
        expect(registry.searchRows("4.1")[0]?.name).toBe("Tac-Kek plate");
    });

    test("a second pass reuses the scan instead of refetching", async () => {
        await syncMods(deps(), { now: "2026-08-22T00:00:00.000Z" });
        const before = repos.treeCalls;
        const report = await syncMods(deps(), { now: "2026-08-23T00:00:00.000Z", full: true });
        expect(report.reused).toBe(1);
        expect(report.scanned).toBe(0);
        expect(repos.treeCalls).toBe(before);
    });

    test("a mod that changed after its scan is scanned again", async () => {
        await syncMods(deps(), { now: "2026-08-22T00:00:00.000Z" });
        forge.pages = [{ mods: [mod({ versions: [version(1, "2.0.1")] })], lastPage: 1, total: 1 }];
        forge.pages[0]!.mods[0]!.versions[0]!.updatedAt = "2026-09-01T00:00:00.000Z";
        const report = await syncMods(deps(), { now: "2026-09-02T00:00:00.000Z", full: true });
        expect(report.scanned).toBe(1);
    });

    // A branch moves without the Forge listing changing at all.
    test("a moved branch is rescanned", async () => {
        repos.tags = [];
        await syncMods(deps(), { now: "2026-08-22T00:00:00.000Z" });
        expect(registry.branchPinnedScans()).toHaveLength(1);

        repos.commit = "b".repeat(40);
        const report = await syncMods(deps(), { now: "2026-08-23T00:00:00.000Z", full: true });
        expect(report.drifted).toBe(1);
        expect(report.scanned).toBe(1);
    });

    test("a tag-pinned scan is never rechecked for drift", async () => {
        repos.tags = ["2.0.1"];
        await syncMods(deps(), { now: "2026-08-22T00:00:00.000Z" });
        repos.commit = "b".repeat(40);
        expect((await syncMods(deps(), { now: "2026-08-23T00:00:00.000Z", full: true })).drifted) //
            .toBe(0);
    });

    test("a mod with no usable source link is recorded, not retried forever", async () => {
        forge.pages = [{ mods: [mod({ sourceLinks: [] })], lastPage: 1, total: 1 }];
        const first = await syncMods(deps(), { now: "2026-08-22T00:00:00.000Z" });
        expect(first.outcomes).toEqual({ "no-repo": 1 });
        const second = await syncMods(deps(), { now: "2026-08-23T00:00:00.000Z", full: true });
        expect(second.reused).toBe(1);
    });

    test("a failing repo is recorded as an error rather than aborting the run", async () => {
        forge.pages = [
            {
                mods: [mod(), mod({ id: 99, slug: "other", versions: [version(2, "1.0.0")] })],
                lastPage: 1,
                total: 2,
            },
        ];
        repos.contents = {};
        const report = await syncMods(deps(), { now: "2026-08-22T00:00:00.000Z" });
        expect(report.scanned).toBe(2);
        expect(report.outcomes["no-items"]).toBe(2);
    });

    test("mods below the gate are never fetched", async () => {
        forge.pages = [{ mods: [mod({ downloads: 10 })], lastPage: 1, total: 1 }];
        const report = await syncMods(deps(), { now: "2026-08-22T00:00:00.000Z" });
        expect(report.gated).toBe(0);
        expect(repos.treeCalls).toBe(0);
    });

    test("limit caps how many mods a run touches", async () => {
        forge.pages = [
            {
                mods: [mod(), mod({ id: 99, slug: "other", versions: [version(2, "1.0.0")] })],
                lastPage: 1,
                total: 2,
            },
        ];
        const report = await syncMods(deps(), { now: "2026-08-22T00:00:00.000Z", limit: 1 });
        expect(report.gated).toBe(1);
    });
});

describe("listing completeness", () => {
    test("a full listing lets missing mods disappear", async () => {
        await syncMods(deps(), { now: "2026-08-22T00:00:00.000Z" });
        expect(registry.state("lastListing")).toBe("2026-08-22T00:00:00.000Z");
    });

    // Committing a partial listing would hide every mod it never reached.
    test("an incomplete listing does not move the watermark", async () => {
        forge.pages = [{ mods: [mod()], lastPage: 5, total: 900 }];
        const report = await syncMods(deps(), { now: "2026-08-22T00:00:00.000Z" });
        expect(report.listingComplete).toBe(false);
        expect(registry.state("lastListing")).toBeNull();
    });

    test("an incremental run never moves it either", async () => {
        await syncMods(deps(), { now: "2026-08-22T00:00:00.000Z", since: "2026-08-01" });
        expect(registry.state("lastListing")).toBeNull();
        expect(Object.keys(forge.queries[0]!)).toContain("filter[updated_between]");
    });

    test("the sync watermark advances so the next run is incremental", async () => {
        await syncMods(deps(), { now: "2026-08-22T00:00:00.000Z" });
        expect(registry.state("lastSync")).toBe("2026-08-22T00:00:00.000Z");
        await syncMods(deps(), { now: "2026-08-23T00:00:00.000Z" });
        expect(Object.keys(forge.queries[1]!)).toContain("filter[updated_between]");
    });
});
