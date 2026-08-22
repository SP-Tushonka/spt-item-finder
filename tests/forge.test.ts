import { describe, expect, test } from "bun:test";
import { retryDelayMs } from "../src/server/http";
import {
    DEFAULT_GATE,
    gateMod,
    gateMods,
    listMods,
    selectVersion,
    updatedBetweenQuery,
    type ForgeApi,
    type ForgeMod,
    type ForgePage,
    type ForgeVersion,
} from "../src/server/forge";

function version(v: string, constraint: string, id = 1): ForgeVersion {
    return {
        id,
        version: v,
        link: `https://sp-mod.com/mod/download/1/x/${v}`,
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
        versions: [],
        ...overrides,
    };
}

// The real version list of mod 2512, which spans both release sptVersions.
const BACKPORT_VERSIONS = [
    version("2.0.1", "~4.1.1", 1),
    version("2.0.0", "~4.1.1", 2),
    version("1.1.5", "~4.0.13", 3),
    version("1.1.3", "~4.0.13", 4),
    version("1.0.6", "~4.0.3", 5),
];

describe("selectVersion", () => {
    test("picks the newest version targeting each sptVersion", () => {
        const backport = mod({ versions: BACKPORT_VERSIONS });
        expect(selectVersion(backport, "4.1")?.version).toBe("2.0.1");
        expect(selectVersion(backport, "4.0")?.version).toBe("1.1.5");
    });

    test("returns null for a sptVersion the mod never targeted", () => {
        expect(selectVersion(mod({ versions: BACKPORT_VERSIONS }), "3.11")).toBeNull();
    });

    test("compares versions numerically, not as strings", () => {
        const candidate = mod({
            versions: [version("1.9.0", "~4.1.0", 1), version("1.10.0", "~4.1.0", 2)],
        });
        expect(selectVersion(candidate, "4.1")?.version).toBe("1.10.0");
    });

    test("ignores versions with no declared constraint", () => {
        const legacy = mod({ versions: [version("1.0.0", ""), version("0.9.0", "~4.1.0")] });
        expect(selectVersion(legacy, "4.1")?.version).toBe("0.9.0");
    });
});

describe("gateMod", () => {
    test("keeps a popular mod and pins a version per sptVersion", () => {
        const gated = gateMod(mod({ versions: BACKPORT_VERSIONS }));
        expect(gated?.versionByLine["4.1"]?.version).toBe("2.0.1");
        expect(gated?.versionByLine["4.0"]?.version).toBe("1.1.5");
    });

    test("drops a mod under the download threshold", () => {
        expect(gateMod(mod({ downloads: 1999, versions: BACKPORT_VERSIONS }))).toBeNull();
        expect(gateMod(mod({ downloads: 2000, versions: BACKPORT_VERSIONS }))).not.toBeNull();
    });

    test("drops a mod that targets no indexed sptVersion", () => {
        const old = mod({ versions: [version("1.0.0", "~3.11.0")] });
        expect(gateMod(old)).toBeNull();
    });

    test("keeps a mod that targets only one sptVersion", () => {
        const only41 = mod({ versions: [version("1.0.0", "~4.1.1")] });
        expect(Object.keys(gateMod(only41)!.versionByLine)).toEqual(["4.1"]);
    });

    test("honours a custom gate", () => {
        const quiet = mod({ downloads: 10, versions: BACKPORT_VERSIONS });
        expect(gateMod(quiet, { minDownloads: 0, sptVersions: ["4.1"] })).not.toBeNull();
        expect(Object.keys(gateMod(quiet, { minDownloads: 0, sptVersions: ["4.1"] })!.versionByLine)) //
            .toEqual(["4.1"]);
    });

    test("the default gate is 2k downloads across 4.0 and 4.1", () => {
        expect(DEFAULT_GATE).toEqual({ minDownloads: 2000, sptVersions: ["4.0", "4.1"] });
    });
});

describe("gateMods", () => {
    test("filters a listing down to the indexable set", () => {
        const mods = [
            mod({ id: 1, versions: BACKPORT_VERSIONS }),
            mod({ id: 2, downloads: 5, versions: BACKPORT_VERSIONS }),
            mod({ id: 3, versions: [version("1.0.0", "~3.11.0")] }),
        ];
        expect(gateMods(mods).map((g) => g.mod.id)).toEqual([1]);
    });
});

describe("updatedBetweenQuery", () => {
    test("builds the incremental filter from ISO timestamps", () => {
        expect(
            updatedBetweenQuery("2026-08-20T11:09:16.000000Z", "2026-08-23T00:00:00.000000Z"),
        ).toEqual({ "filter[updated_between]": "2026-08-20,2026-08-23" });
    });
});

class FakeForge implements ForgeApi {
    pages: ForgePage[] = [];
    queries: Record<string, string>[] = [];

    async page(query: Record<string, string>, page: number): Promise<ForgePage | null> {
        this.queries.push(query);
        return this.pages[page - 1] ?? null;
    }
}

describe("listMods", () => {
    test("walks every page and reports the listing complete", async () => {
        const api = new FakeForge();
        api.pages = [
            { mods: [mod({ id: 1 })], lastPage: 3, total: 3 },
            { mods: [mod({ id: 2 })], lastPage: 3, total: 3 },
            { mods: [mod({ id: 3 })], lastPage: 3, total: 3 },
        ];
        const seen: number[] = [];
        const listing = await listMods(api, {}, (page) => seen.push(page));
        expect(listing.mods.map((m) => m.id)).toEqual([1, 2, 3]);
        expect(listing.complete).toBe(true);
        expect(seen).toEqual([1, 2, 3]);
    });

    // Committing a partial listing as complete would hide every mod it never reached.
    test("a failed page makes the listing incomplete", async () => {
        const api = new FakeForge();
        api.pages = [{ mods: [mod({ id: 1 })], lastPage: 5, total: 5 }];
        const listing = await listMods(api);
        expect(listing.mods.map((m) => m.id)).toEqual([1]);
        expect(listing.complete).toBe(false);
    });

    test("a listing shorter than the reported total is incomplete", async () => {
        const api = new FakeForge();
        api.pages = [{ mods: [mod({ id: 1 })], lastPage: 1, total: 900 }];
        expect((await listMods(api)).complete).toBe(false);
    });

    test("passes the query through to every page", async () => {
        const api = new FakeForge();
        api.pages = [
            { mods: [], lastPage: 2, total: 0 },
            { mods: [], lastPage: 2, total: 0 },
        ];
        await listMods(api, { "filter[updated_between]": "2026-08-20,2026-08-23" });
        expect(api.queries).toHaveLength(2);
        expect(api.queries[1]).toEqual({ "filter[updated_between]": "2026-08-20,2026-08-23" });
    });
});

describe("retryDelayMs", () => {
    function res(status: number, headers: Record<string, string>) {
        return { status, headers: { get: (n: string) => headers[n] ?? null } };
    }

    test("honours retry-after", () => {
        expect(retryDelayMs(res(429, { "retry-after": "30" }))).toBe(30_000);
    });

    test("uses the reset timestamp when the budget is spent", () => {
        const now = 1_800_000_000_000;
        const reset = Math.floor(now / 1000) + 60;
        const delay = retryDelayMs(
            res(403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) }),
            now,
        );
        expect(delay).toBe(60_000);
    });

    test("a 403 with budget left is a real failure, not a limit", () => {
        expect(retryDelayMs(res(403, { "x-ratelimit-remaining": "42" }))).toBeNull();
    });

    test("ignores successful responses", () => {
        expect(retryDelayMs(res(200, {}))).toBeNull();
    });
});
