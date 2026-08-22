import type { BunRequest } from "bun";
import type { Config } from "../config";
import type { Catalog } from "./catalog";

function jsonError(status: number, message: string): Response {
    return Response.json({ error: message }, { status });
}

function redirect(location: string, status: 301 | 302): Response {
    return new Response(null, { status, headers: { location } });
}

function decodeSegment(segment: string): string {
    try {
        return decodeURIComponent(segment);
    } catch {
        return segment;
    }
}

export function apiRoutes(catalog: Catalog, cfg: Config) {
    const sptVersionOf = (url: URL): string =>
        url.searchParams.get("spt") || catalog.defaultSptVersion();

    /** Mods the viewer switched off, as ids; anything unparseable is simply not excluded. */
    const withoutOf = (url: URL): Set<number> =>
        new Set(
            (url.searchParams.get("without") ?? "")
                .split(",")
                .map((id) => Number.parseInt(id, 10))
                .filter(Number.isFinite),
        );

    const requireLocale = (url: URL): string | Response => {
        const locale = url.searchParams.get("locale") ?? "en";
        return catalog.hasLocale(locale) ? locale : jsonError(400, `unknown locale "${locale}"`);
    };

    return {
        "/api/search": {
            GET(req: BunRequest) {
                const url = new URL(req.url);
                const q = (url.searchParams.get("q") ?? "").trim();
                if (q.length < 3) return jsonError(400, "query must be at least 3 characters");
                if (q.length > 128) return jsonError(400, "query must be at most 128 characters");
                const locale = requireLocale(url);
                if (locale instanceof Response) return locale;
                const mods = url.searchParams.get("mods") !== "0";
                const { results, truncated } = catalog.search(
                    q,
                    locale,
                    50,
                    mods,
                    sptVersionOf(url),
                    withoutOf(url),
                );
                return Response.json({ query: q, locale, truncated, results });
            },
        },

        "/api/item/:id": {
            GET(req: BunRequest<"/api/item/:id">) {
                const url = new URL(req.url);
                const locale = requireLocale(url);
                if (locale instanceof Response) return locale;
                const mods = url.searchParams.get("mods") !== "0";
                const detail = catalog.getItem(
                    req.params.id,
                    locale,
                    sptVersionOf(url),
                    mods,
                    withoutOf(url),
                );
                return detail ? Response.json(detail) : jsonError(404, "item not found");
            },
        },

        "/api/item/:id/hierarchy": {
            GET(req: BunRequest<"/api/item/:id/hierarchy">) {
                const url = new URL(req.url);
                const locale = requireLocale(url);
                if (locale instanceof Response) return locale;
                const chain = catalog.hierarchy(req.params.id, locale, sptVersionOf(url));
                return chain ? Response.json({ chain }) : jsonError(404, "item not found");
            },
        },

        "/api/mods": {
            GET(req: BunRequest) {
                const mods = catalog.importedMods(sptVersionOf(new URL(req.url)));
                const items = mods.reduce(
                    (sum, mod) => sum + mod.sptVersions.reduce((n, l) => n + l.items, 0),
                    0,
                );
                return Response.json({ mods, totals: { mods: mods.length, items } });
            },
        },

        "/api/mods/:id/items": {
            GET(req: BunRequest<"/api/mods/:id/items">) {
                const url = new URL(req.url);
                const locale = requireLocale(url);
                if (locale instanceof Response) return locale;
                const modId = Number.parseInt(req.params.id, 10);
                if (!Number.isFinite(modId)) return jsonError(400, "bad mod id");
                return Response.json({
                    items: catalog.modItems(modId, sptVersionOf(url), locale),
                });
            },
        },

        "/api/locales": {
            GET() {
                return Response.json({ locales: catalog.localeCodes(), default: "en" });
            },
        },

        "/api/versions": {
            GET() {
                return Response.json({
                    sptVersions: catalog.sptVersions(),
                    default: catalog.defaultSptVersion(),
                });
            },
        },

        "/api/refresh": {
            async POST(req: BunRequest) {
                if (
                    cfg.refreshToken &&
                    req.headers.get("authorization") !== `Bearer ${cfg.refreshToken}`
                ) {
                    return jsonError(401, "unauthorized");
                }
                const force = new URL(req.url).searchParams.get("force") === "1";
                try {
                    return Response.json(await catalog.refresh(force));
                } catch (err) {
                    return jsonError(
                        502,
                        `upstream fetch failed: ${err instanceof Error ? err.message : String(err)}`,
                    );
                }
            },
        },

        "/api/*": () => jsonError(404, "not found"),

        "/health": {
            GET() {
                return Response.json({
                    status: "ok",
                    sha: catalog.meta.sha,
                    fetchedAt: catalog.meta.fetchedAt,
                });
            },
        },

        "/search/:query": {
            GET(req: BunRequest<"/search/:query">) {
                const query = decodeSegment(req.params.query).trim();
                const id = query.toLowerCase();
                return catalog.getItem(id, "en")
                    ? redirect(`/item/${id}`, 301)
                    : redirect(`/?q=${encodeURIComponent(query)}`, 302);
            },
        },

        "/search": () => redirect("/", 301),
    };
}
