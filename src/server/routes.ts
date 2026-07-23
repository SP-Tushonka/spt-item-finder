import type { BunRequest } from "bun";
import type { Config } from "../config";
import type { Catalog } from "./catalog";

function jsonError(status: number, message: string): Response {
    return Response.json({ error: message }, { status });
}

export function apiRoutes(catalog: Catalog, cfg: Config) {
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
                const { results, truncated } = catalog.search(q, locale);
                return Response.json({ query: q, locale, truncated, results });
            },
        },

        "/api/item/:id": {
            GET(req: BunRequest<"/api/item/:id">) {
                const locale = requireLocale(new URL(req.url));
                if (locale instanceof Response) return locale;
                const detail = catalog.getItem(req.params.id, locale);
                return detail ? Response.json(detail) : jsonError(404, "item not found");
            },
        },

        "/api/item/:id/hierarchy": {
            GET(req: BunRequest<"/api/item/:id/hierarchy">) {
                const locale = requireLocale(new URL(req.url));
                if (locale instanceof Response) return locale;
                const chain = catalog.hierarchy(req.params.id, locale);
                return chain ? Response.json({ chain }) : jsonError(404, "item not found");
            },
        },

        "/api/locales": {
            GET() {
                return Response.json({ locales: catalog.localeCodes(), default: "en" });
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
    };
}
