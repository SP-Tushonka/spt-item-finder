import {
    DEFAULT_GATE,
    gateMods,
    listMods,
    updatedBetweenQuery,
    type ForgeApi,
    type ForgeVersion,
    type ModGate,
} from "./forge";
import { ModRegistry, type ScanOutcome } from "./modregistry";
import { scan } from "./modscan";
import { discoverRepo, openMod, resolveRef, type RepoSource } from "./modsource";

export interface SyncDeps {
    forge: ForgeApi;
    repos: RepoSource;
    registry: ModRegistry;
    enums: (sptVersion: string) => Map<string, string>;
    log?: (message: string) => void;
}

export interface SyncOptions {
    gate?: ModGate;
    concurrency?: number;
    since?: string;
    full?: boolean;
    limit?: number;
    now?: string;
}

export interface SyncReport {
    listed: number;
    listingComplete: boolean;
    gated: number;
    scanned: number;
    reused: number;
    drifted: number;
    items: number;
    outcomes: Record<string, number>;
}

const LAST_SYNC = "lastSync";

export async function syncMods(deps: SyncDeps, options: SyncOptions = {}): Promise<SyncReport> {
    const log = deps.log ?? (() => {});
    const gate = options.gate ?? DEFAULT_GATE;
    const now = options.now ?? new Date().toISOString();
    const since = options.full ? undefined : (options.since ?? deps.registry.state(LAST_SYNC));
    const query = since ? updatedBetweenQuery(since, now) : {};

    log(since ? `sync: mods changed since ${since.slice(0, 10)}` : "sync: full listing");
    const listing = await listMods(deps.forge, query, (page, last) =>
        log(`sync: listing page ${page}/${last}`),
    );
    deps.registry.upsertMods(listing.mods, now);

    const gated = gateMods(listing.mods, gate).slice(0, options.limit);
    const drifted = await findDrift(deps, log);
    log(`sync: ${listing.mods.length} listed, ${gated.length} gated, ${drifted.size} drifted`);

    const report: SyncReport = {
        listed: listing.mods.length,
        listingComplete: listing.complete,
        gated: gated.length,
        scanned: 0,
        reused: 0,
        drifted: drifted.size,
        items: 0,
        outcomes: {},
    };

    const tasks = gated.flatMap((entry) =>
        Object.entries(entry.versionByLine).map(([sptVersion, version]) => async () => {
            await syncOne(deps, entry.mod.name, entry.mod.sourceLinks, sptVersion, version, {
                drifted,
                report,
                log,
            });
        }),
    );
    await pool(tasks, options.concurrency ?? 4);

    // Only a complete, unfiltered listing is evidence that a missing mod is gone.
    if (listing.complete && !since) deps.registry.completeListing(now);
    deps.registry.setState(LAST_SYNC, now);
    deps.registry.compact();

    log(`sync: ${report.scanned} scanned, ${report.reused} reused, ${report.items} items`);
    return report;
}

interface RunContext {
    drifted: Set<string>;
    report: SyncReport;
    log: (message: string) => void;
}

async function syncOne(
    deps: SyncDeps,
    modName: string,
    sourceLinks: { url: string; label: string }[],
    sptVersion: string,
    version: ForgeVersion,
    ctx: RunContext,
): Promise<void> {
    const stale = ctx.drifted.has(`${version.id}:${sptVersion}`);
    if (!stale && !deps.registry.needsScan(version.id, sptVersion, version.updatedAt)) {
        ctx.report.reused++;
        return;
    }

    const count = (outcome: ScanOutcome) => {
        ctx.report.outcomes[outcome] = (ctx.report.outcomes[outcome] ?? 0) + 1;
        ctx.report.scanned++;
    };

    try {
        const found = discoverRepo(sourceLinks, sptVersion);
        if (!found) {
            deps.registry.recordScan({ versionId: version.id, sptVersion, outcome: "no-repo" });
            return count("no-repo");
        }

        const ref = await resolveRef(deps.repos, found, version.version);
        if (!ref) {
            deps.registry.recordScan({ versionId: version.id, sptVersion, outcome: "error" });
            return count("error");
        }

        const tree = await openMod(deps.repos, ref);
        const result = await scan(tree.files, deps.enums(sptVersion));
        deps.registry.recordScan(
            {
                versionId: version.id,
                sptVersion,
                outcome: result.verdict,
                repo: {
                    owner: ref.owner,
                    name: ref.repo,
                    ref: ref.ref,
                    refKind: ref.refKind,
                    sha: ref.sha,
                },
                truncated: tree.truncated,
                skipped: result.skipped,
            },
            result.candidates,
        );
        count(result.verdict);
        ctx.report.items += result.candidates.length;
        if (result.candidates.length > 0) {
            ctx.log(
                `sync: ${modName} ${version.version} (${sptVersion}) -> ${result.candidates.length}`,
            );
        }
    } catch (err) {
        ctx.log(`sync: ${modName} ${version.version} (${sptVersion}) failed: ${err}`);
        deps.registry.recordScan({ versionId: version.id, sptVersion, outcome: "error" });
        count("error");
    }
}

async function findDrift(deps: SyncDeps, log: (message: string) => void): Promise<Set<string>> {
    const stale = new Set<string>();
    for (const pin of deps.registry.branchPinnedScans()) {
        if (!pin.sha) continue;
        const head = await deps.repos.resolveCommit(pin.owner, pin.repo, pin.ref);
        if (head && head !== pin.sha) {
            stale.add(`${pin.versionId}:${pin.sptVersion}`);
            log(`sync: ${pin.owner}/${pin.repo}@${pin.ref} moved, rescanning`);
        }
    }
    return stale;
}

async function pool(tasks: (() => Promise<void>)[], size: number): Promise<void> {
    let next = 0;
    const workers = Array.from({ length: Math.min(size, tasks.length) }, async () => {
        while (next < tasks.length) {
            await tasks[next++]!();
        }
    });
    await Promise.all(workers);
}
