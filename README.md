# SPT Item Finder

Search every item template in the [SPT](https://sp-tarkov.com) server database and inspect its raw JSON: names, IDs, `_props`, handbook prices, and parent hierarchy, in all 17 game locales.

A ground-up rebuild of [sp-tarkov/db-website](https://github.com/sp-tarkov/db-website) on a deliberately small stack: **Bun only, zero runtime dependencies**. `Bun.serve` handles routing and bundles the vanilla-TypeScript frontend from an HTML import; item data is fetched straight from the [server-csharp](https://github.com/sp-tarkov/server-csharp) repo over HTTPS (including the Git-LFS `items.json`, which is resolved via SPT's LFS server, so no git or git-lfs is required).

## Run

```sh
docker compose up --build
```

Open http://localhost:3000. The first boot downloads a ~20MB data snapshot into a named volume; later boots are instant and offline-friendly.

Local development (Bun ≥ 1.2.3):

```sh
bun install
bun run dev        # hot reload, server + frontend
bun test           # unit + HTTP tests
bun run typecheck
```

## API

| Route                                       | Purpose                                                                    |
| ------------------------------------------- | -------------------------------------------------------------------------- |
| `GET /api/search?q=<query>&locale=<code>`   | Ranked item search (min 3 chars; exact > prefix > substring; capped at 50) |
| `GET /api/item/:id?locale=<code>`           | Full item template + locale entry + handbook entry                         |
| `GET /api/item/:id/hierarchy?locale=<code>` | Root-first parent chain                                                    |
| `GET /api/locales`                          | Available data locales                                                     |
| `POST /api/refresh?force=1`                 | Re-sync from upstream (no-op unless the upstream commit changed)           |

Item pages are served with per-item `<title>`, meta description, canonical, and Open Graph tags (so shared links embed properly), unknown item IDs return real 404s, and `/sitemap.xml` + `/robots.txt` cover every item for crawlers.

## Deploy

Pushes to `main` (and `v*` tags) run the test suite, then build and push a multi-arch image to
GHCR via `.github/workflows/build.yaml`. On a server, pull it with a compose file like:

```yaml
services:
    app:
        image: ghcr.io/OWNER/sp-tarkov-db:latest
        ports:
            - "3000:3000"
        environment:
            SITE_URL: https://db.example.com
            REFRESH_TOKEN: change-me
        volumes:
            - data:/app/data
        restart: unless-stopped
volumes:
    data:
```

## Configuration

All optional; see `.env.example`. Highlights:

- `SITE_URL`: public base URL, used in canonical/Open Graph tags, `sitemap.xml`, and `robots.txt`. Set it in production.
- `REFRESH_TOKEN`: when set, `POST /api/refresh` requires `Authorization: Bearer <token>`. Set it in production.
- `REFRESH_INTERVAL_HOURS`: automatic upstream check interval (default 24; `0` disables).
- `UPSTREAM_REPO` / `UPSTREAM_BRANCH` / `UPSTREAM_DB_PATH` / `LFS_BASE_URL`: data source overrides.

## How data flows

1. On boot (or refresh) the server resolves the upstream branch to a commit SHA and fetches `templates/items.json`, `templates/customization.json`, `templates/handbook.json`, and `locales/global/*.json` at that pinned SHA. `items.json` arrives as a Git-LFS pointer, which is resolved through SPT's LFS batch API.
2. The raw files are written atomically to `DATA_DIR` (`meta.json` last, certifying a complete snapshot) and parsed into in-memory indexes.
3. Refreshes are cheap no-ops unless the upstream commit changed; on failure, the previous snapshot stays in service.
