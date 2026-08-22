import { loadConfig } from "./config";
import { Catalog } from "./server/catalog";
import { Upstream } from "./server/upstream";

const cfg = loadConfig();
const args = process.argv.slice(2);
const limitArg = args[args.indexOf("--limit") + 1];
const limit = Number.parseInt(limitArg ?? "", 10);
const concurrencyArg = args[args.indexOf("--concurrency") + 1];
const concurrency = Number.parseInt(concurrencyArg ?? "", 10);

const catalog = await Catalog.init(cfg, new Upstream(cfg));
const report = await catalog.syncMods({
    full: args.includes("--full"),
    limit: Number.isFinite(limit) ? limit : undefined,
    concurrency: Number.isFinite(concurrency) ? concurrency : undefined,
});

if (!report) {
    console.error(`no mod database at ${cfg.modsDbPath}`);
    process.exit(1);
}
console.log(JSON.stringify(report, null, 2));
catalog.close();
