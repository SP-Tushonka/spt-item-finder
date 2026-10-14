export interface Config {
    port: number;
    siteUrl: string;
    dataDir: string;
    refreshToken: string | null;
    refreshIntervalHours: number;
    repo: string;
    branch: string;
    dbPaths: string[];
    enumPaths: string[];
    lfsBaseUrl: string;
    githubToken: string | null;
    modsDbPath: string;
    defaultSptVersion: string;
    modSyncIntervalHours: number;
    modMinDownloads: number;
    sptVersions: string[];
    /** Git ref each SPT version is read from. Versions not listed use their newest release tag. */
    refs: Record<string, string>;
    production: boolean;
}

const DEFAULT_DB_PATHS = [
    "Libraries/SPTarkov.Server.Assets/SPT_Data/database",
    "Libraries/SPTushonka.Server.Assets/SPT_Data/database",
];

const DEFAULT_ENUM_PATHS = [
    "Libraries/SPTarkov.Server.Core/Models/Enums/ItemTpl.cs",
    "Libraries/SPTushonka.Server.Core/Models/Enums/ItemTpl.cs",
];

export function loadConfig(env: Record<string, string | undefined> = Bun.env): Config {
    const port = intOr(env.PORT, 3000);
    return {
        port,
        siteUrl: (env.SITE_URL || `http://localhost:${port}`).replace(/\/$/, ""),
        dataDir: env.DATA_DIR || "./data",
        refreshToken: env.REFRESH_TOKEN || null,
        refreshIntervalHours: intOr(env.REFRESH_INTERVAL_HOURS, 24),
        repo: env.UPSTREAM_REPO || "SP-Tushonka/server-csharp",
        branch: env.UPSTREAM_BRANCH || "main",
        dbPaths: (env.UPSTREAM_DB_PATH || DEFAULT_DB_PATHS.join(","))
            .split(",")
            .map((path) => path.trim())
            .filter(Boolean),
        enumPaths: (env.UPSTREAM_ENUM_PATH || DEFAULT_ENUM_PATHS.join(","))
            .split(",")
            .map((path) => path.trim())
            .filter(Boolean),
        lfsBaseUrl: env.LFS_BASE_URL || "https://lfs.sp-tushonka.com/sp-tushonka/server-csharp",
        githubToken: env.GITHUB_TOKEN || null,
        modsDbPath: env.MODS_DB_PATH || `${env.DATA_DIR || "./data"}/mods.sqlite`,
        defaultSptVersion: env.DEFAULT_SPT_VERSION || "4.1",
        modSyncIntervalHours: intOr(env.MOD_SYNC_INTERVAL_HOURS, 0),
        modMinDownloads: intOr(env.MOD_MIN_DOWNLOADS, 2000),
        sptVersions: (env.SPT_VERSIONS || "5.0,4.1,4.0")
            .split(",")
            .map((sptVersion) => sptVersion.trim())
            .filter(Boolean),
        refs: parseRefs(env.SPT_REFS ?? "5.0=5.0x-dev,4.1=4.1x-dev,4.0=4.0.13"),
        production: env.NODE_ENV === "production",
    };
}

/** "5.0=5.0x-dev,4.0=4.0.13" to { "5.0": "5.0x-dev", "4.0": "4.0.13" }. */
function parseRefs(value: string): Record<string, string> {
    const refs: Record<string, string> = {};
    for (const pair of value.split(",")) {
        const [sptVersion, ref] = pair.split("=").map((part) => part.trim());
        if (sptVersion && ref) refs[sptVersion] = ref;
    }
    return refs;
}

function intOr(value: string | undefined, fallback: number): number {
    const parsed = Number.parseInt(value ?? "", 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}
