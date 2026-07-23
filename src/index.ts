import type { BunRequest } from "bun";
import index from "./client/index.html";
import { loadConfig, type Config } from "./config";
import { Catalog } from "./server/catalog";
import { apiRoutes } from "./server/routes";
import { injectMeta, metaDescription, robotsTxt, sitemapXml } from "./server/seo";
import { Upstream } from "./server/upstream";

export function createServer(catalog: Catalog, cfg: Config) {
    // The SPA shell (with hashed asset links) is only obtainable by asking the
    // running server for "/". Cached in production; re-fetched in dev for HMR.
    let shellCache: string | null = null;
    const getShell = async (origin: URL | string): Promise<string> => {
        if (shellCache !== null && cfg.production) return shellCache;
        shellCache = await (await fetch(new URL("/", origin))).text();
        return shellCache;
    };

    let sitemapCache: { sha: string; xml: string } | null = null;

    return Bun.serve({
        port: cfg.port,
        idleTimeout: 120, // a forced refresh downloads ~20MB before responding
        development: cfg.production ? false : { hmr: true, console: true },
        routes: {
            "/": index,
            "/item/:id": async (req: BunRequest<"/item/:id">, server) => {
                const shell = await getShell(server.url);
                const id = req.params.id;
                const detail = catalog.getItem(id, "en");
                const html = detail
                    ? injectMeta(shell, {
                          title: `${detail.locale?.Name ?? detail.item._name} · SPT Item Finder`,
                          description: metaDescription(detail),
                          url: `${cfg.siteUrl}/item/${id}`,
                      })
                    : shell;
                return new Response(html, {
                    status: detail ? 200 : 404,
                    headers: { "content-type": "text/html;charset=utf-8" },
                });
            },
            "/sitemap.xml": () => {
                if (sitemapCache?.sha !== catalog.meta.sha) {
                    sitemapCache = {
                        sha: catalog.meta.sha,
                        xml: sitemapXml(
                            catalog.itemIds(),
                            cfg.siteUrl,
                            catalog.meta.fetchedAt.slice(0, 10),
                        ),
                    };
                }
                return new Response(sitemapCache.xml, {
                    headers: { "content-type": "application/xml;charset=utf-8" },
                });
            },
            "/robots.txt": () =>
                new Response(robotsTxt(cfg.siteUrl), {
                    headers: { "content-type": "text/plain;charset=utf-8" },
                }),
            ...apiRoutes(catalog, cfg),
        },
        fetch() {
            return new Response("Not Found", { status: 404 });
        },
        error(err) {
            console.error(err);
            return Response.json({ error: "internal error" }, { status: 500 });
        },
    });
}

if (import.meta.main) {
    const cfg = loadConfig();
    // Stashed on globalThis so `bun --hot` reloads reuse the parsed catalog.
    const g = globalThis as typeof globalThis & { __catalog?: Catalog };
    let catalog = g.__catalog;
    if (!catalog) {
        try {
            catalog = await Catalog.init(cfg, new Upstream(cfg));
        } catch (err) {
            console.error(
                `fatal: no data snapshot in ${cfg.dataDir} and upstream fetch failed:`,
                err,
            );
            process.exit(1);
        }
        g.__catalog = catalog;
    }
    catalog.startAutoRefresh();
    const server = createServer(catalog, cfg);
    console.log(`sp-tarkov-db listening on ${server.url} (data ${catalog.meta.sha.slice(0, 8)})`);
}
