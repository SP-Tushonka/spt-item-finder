export interface Config {
    port: number;
    siteUrl: string;
    dataDir: string;
    refreshToken: string | null;
    refreshIntervalHours: number;
    repo: string;
    branch: string;
    dbPath: string;
    lfsBaseUrl: string;
    production: boolean;
}

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
        dbPath: env.UPSTREAM_DB_PATH || "Libraries/SPTarkov.Server.Assets/SPT_Data/database",
        lfsBaseUrl: env.LFS_BASE_URL || "https://lfs.sp-tushonka.com/sp-tushonka/server-csharp",
        production: env.NODE_ENV === "production",
    };
}

function intOr(value: string | undefined, fallback: number): number {
    const parsed = Number.parseInt(value ?? "", 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}
