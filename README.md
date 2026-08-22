# SPT Item Finder

Search every item template in the [SPT](https://sp-tarkov.com) server database and inspect its raw JSON: names, IDs, `_props`, handbook prices, and parent hierarchy, in all 17 game locales — for SPT 4.0 and 4.1, vanilla and modded.

Items added by mods are indexed alongside vanilla ones: the site reads each mod's own repository, extracts the templates it adds, resolves them against that SPT line's vanilla data, and applies the slot compatibility mods declare, so a stock M4 lists the modded attachments that actually fit it.

A ground-up rebuild of [sp-tarkov/db-website](https://github.com/sp-tarkov/db-website) on a deliberately small stack: **Bun only, zero runtime dependencies**. `Bun.serve` handles routing and bundles the vanilla-TypeScript frontend from an HTML import; item data is fetched straight from the [server-csharp](https://github.com/SP-Tushonka/server-csharp) repo over HTTPS (including the Git-LFS `items.json`, which is resolved via the SP-Tushonka LFS server, so no git or git-lfs is required).

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
| `GET /api/lines`                            | SPT versions with indexed mod data, and the default                        |
| `GET /api/mods`                             | Mods currently contributing items, with the version each was read from     |
| `POST /api/refresh?force=1`                 | Re-sync from upstream (no-op unless the upstream commit changed)           |
| `GET /health`                               | Snapshot SHA and fetch time; also the container healthcheck                |

Every read route takes `?spt=` to pick the SPT line (default 4.1), `&mods=0` to exclude modded
items, and `&without=<ids>` to exclude particular mods.

Item pages are served with per-item `<title>`, meta description, canonical, and Open Graph tags (so shared links embed properly), unknown item IDs return real 404s, and `/sitemap.xml` + `/robots.txt` cover every item for crawlers.

## Deploy

Pushes to `main` (and `v*` tags) run the test suite, then build and push a multi-arch image to
GHCR via `.github/workflows/build.yaml`. On a server, pull it with a compose file like:

```yaml
services:
    app:
        image: ghcr.io/sp-tushonka/spt-item-finder:latest
        ports:
            - "3000:3000"
        environment:
            SITE_URL: https://db.example.com
            REFRESH_TOKEN: change-me
            # Leave these out and the site runs vanilla-only, exactly as before.
            GITHUB_TOKEN: ghp_xxx
            MOD_SYNC_INTERVAL_HOURS: 24
        volumes:
            - data:/app/data
        restart: unless-stopped
volumes:
    data:
```

### Upgrading from a vanilla-only version

Nothing has to be migrated. Snapshots moved from `DATA_DIR` into `DATA_DIR/<line>`, so the first
boot re-downloads one per SPT line (~70MB each) and logs that the old files can be deleted. Mods
stay off until `MOD_SYNC_INTERVAL_HOURS` is set, and the first sync then runs in the background
while the site serves.

## Configuration

All optional; see `.env.example`. Highlights:

- `SITE_URL`: public base URL, used in canonical/Open Graph tags, `sitemap.xml`, and `robots.txt`. Set it in production.
- `REFRESH_TOKEN`: when set, `POST /api/refresh` requires `Authorization: Bearer <token>`. Set it in production.
- `REFRESH_INTERVAL_HOURS`: automatic upstream check interval (default 24; `0` disables).
- `SPT_VERSIONS`: SPT versions to index, newest first (default `4.1,4.0`). One vanilla snapshot is fetched per version.
- `GITHUB_TOKEN`: read-only token for reading mod repositories. **Required for mod syncing** — unauthenticated GitHub allows 60 requests an hour, which is not enough to finish a sync. A classic token with no scopes is enough.
- `MOD_SYNC_INTERVAL_HOURS`: how often to sync mods (default 24; `0` disables mods entirely). With syncing on, an empty database triggers a full sync at startup, in the background.
- `MOD_MIN_DOWNLOADS`: lifetime downloads a mod needs before it is indexed (default 2000).
- `UPSTREAM_REPO` / `UPSTREAM_BRANCH` / `UPSTREAM_DB_PATH` / `LFS_BASE_URL`: data source overrides.

## How data flows

1. On boot (or refresh) the server resolves each SPT line to that line's newest release tag and fetches `templates/items.json`, `templates/customization.json`, `templates/handbook.json`, `locales/global/*.json`, and `ItemTpl.cs` at that tag. `items.json` arrives as a Git-LFS pointer, which is resolved through SPT's LFS batch API.
2. The raw files are written atomically to `DATA_DIR/<line>` (`meta.json` last, certifying a complete snapshot) and parsed into in-memory indexes.
3. Refreshes are cheap no-ops unless the upstream commit changed; on failure, the previous snapshot stays in service.
4. Separately, the mod sync lists the Forge once (37 requests for the whole catalogue), keeps mods clearing `MOD_MIN_DOWNLOADS` that target an indexed line, reads each one's declared source repository at the tag matching the published version, and stores the items it finds in `DATA_DIR/mods.sqlite`. Scans are cached per mod version, so a daily sync only touches what changed.
