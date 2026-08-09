import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Catalog } from "../src/server/catalog";
import { apiRoutes } from "../src/server/routes";
import { FixtureSource, IDS, testConfig } from "./helpers";
import type { ItemDetail, SearchResponse } from "../src/shared/types";

let dir: string;
let catalog: Catalog;
let server: ReturnType<typeof Bun.serve>;

const api = (path: string, init?: RequestInit) => fetch(new URL(path, server.url), init);

beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "sptdb-routes-"));
    const cfg = testConfig(dir);
    catalog = await Catalog.init(cfg, new FixtureSource(), () => {});
    server = Bun.serve({ port: 0, routes: apiRoutes(catalog, cfg) });
});

afterAll(async () => {
    await server.stop(true);
    await rm(dir, { recursive: true, force: true });
});

describe("GET /api/search", () => {
    test("returns ranked results", async () => {
        const res = await api("/api/search?q=water");
        expect(res.status).toBe(200);
        const body = (await res.json()) as SearchResponse;
        expect(body.query).toBe("water");
        expect(body.locale).toBe("en");
        expect(body.truncated).toBe(false);
        expect(body.results.map((r) => r.id)).toEqual([IDS.waterRation, IDS.bottle]);
        expect(body.results[0]).toEqual({
            id: IDS.waterRation,
            name: "Emergency Water Ration",
            shortName: "Water",
            description: "An emergency water ration.",
        });
    });

    test("honors the locale parameter", async () => {
        const res = await api("/api/search?q=bouteille&locale=fr");
        const body = (await res.json()) as SearchResponse;
        expect(body.results[0]!.name).toBe("Bouteille d'eau (0,6L)");
    });

    test("rejects short, missing, and overlong queries", async () => {
        expect((await api("/api/search?q=ab")).status).toBe(400);
        expect((await api("/api/search")).status).toBe(400);
        expect((await api(`/api/search?q=${"a".repeat(129)}`)).status).toBe(400);
    });

    test("rejects an unknown locale", async () => {
        const res = await api("/api/search?q=water&locale=xx");
        expect(res.status).toBe(400);
        expect(((await res.json()) as { error: string }).error).toContain("locale");
    });
});

describe("GET /api/item/:id", () => {
    test("returns the full item with locale and handbook", async () => {
        const res = await api(`/api/item/${IDS.waterRation}`);
        expect(res.status).toBe(200);
        const body = (await res.json()) as ItemDetail;
        expect(body.item._props).toEqual({ Weight: 0.5, StackMaxSize: 1 });
        expect(body.locale?.ShortName).toBe("Water");
        expect(body.handbook?.Price).toBe(12000);
    });

    test("404s for an unknown id", async () => {
        const res = await api(`/api/item/${"0".repeat(24)}`);
        expect(res.status).toBe(404);
    });
});

describe("GET /api/item/:id/hierarchy", () => {
    test("returns a root-first chain", async () => {
        const res = await api(`/api/item/${IDS.bottle}/hierarchy`);
        expect(res.status).toBe(200);
        const { chain } = (await res.json()) as { chain: { id: string; parent: string }[] };
        expect(chain[0]!.parent).toBe("");
        expect(chain.at(-1)!.id).toBe(IDS.bottle);
    });

    test("404s for an unknown id", async () => {
        expect((await api(`/api/item/${"0".repeat(24)}/hierarchy`)).status).toBe(404);
    });
});

describe("GET /api/locales", () => {
    test("lists locales with the default", async () => {
        const res = await api("/api/locales");
        expect(await res.json()).toEqual({ locales: ["en", "fr"], default: "en" });
    });
});

describe("POST /api/refresh", () => {
    test("is open when no token is configured", async () => {
        const res = await api("/api/refresh", { method: "POST" });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { refreshed: boolean };
        expect(body.refreshed).toBe(false); // fixture sha unchanged
    });

    test("requires a bearer token when configured", async () => {
        const cfg = testConfig(dir, { REFRESH_TOKEN: "s3cret" });
        const guarded = Bun.serve({ port: 0, routes: apiRoutes(catalog, cfg) });
        try {
            const noAuth = await fetch(new URL("/api/refresh", guarded.url), { method: "POST" });
            expect(noAuth.status).toBe(401);
            const wrongAuth = await fetch(new URL("/api/refresh", guarded.url), {
                method: "POST",
                headers: { Authorization: "Bearer nope" },
            });
            expect(wrongAuth.status).toBe(401);
            const ok = await fetch(new URL("/api/refresh", guarded.url), {
                method: "POST",
                headers: { Authorization: "Bearer s3cret" },
            });
            expect(ok.status).toBe(200);
        } finally {
            await guarded.stop(true);
        }
    });
});

describe("GET /health", () => {
    test("reports the loaded snapshot", async () => {
        const res = await api("/health");
        expect(res.status).toBe(200);
        const body = (await res.json()) as { status: string; sha: string };
        expect(body.status).toBe("ok");
        expect(body.sha).toBe(catalog.meta.sha);
    });
});

describe("legacy /search URLs", () => {
    const noFollow = (path: string) => api(path, { redirect: "manual" });

    test("redirects an item ID to its item page", async () => {
        const res = await noFollow(`/search/${IDS.waterRation}`);
        expect(res.status).toBe(301);
        expect(res.headers.get("location")).toBe(`/item/${IDS.waterRation}`);
    });

    test("lowercases the ID before matching", async () => {
        const res = await noFollow(`/search/${IDS.waterRation.toUpperCase()}`);
        expect(res.headers.get("location")).toBe(`/item/${IDS.waterRation}`);
    });

    test("sends anything else to the search page", async () => {
        const res = await noFollow("/search/water%20ration");
        expect(res.status).toBe(302);
        expect(res.headers.get("location")).toBe("/?q=water%20ration");
    });

    test("redirects a bare /search home", async () => {
        const res = await noFollow("/search");
        expect(res.status).toBe(301);
        expect(res.headers.get("location")).toBe("/");
    });
});

describe("unknown API paths", () => {
    test("return JSON 404s", async () => {
        const res = await api("/api/nope");
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ error: "not found" });
    });
});
