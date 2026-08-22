import { join } from "node:path";
import { loadConfig, type Config } from "../src/config";
import type { UpstreamSource } from "../src/server/upstream";

const FIXTURES = join(import.meta.dir, "fixtures");

export const IDS = {
    root: "54009119af1c881c07000029",
    foodNode: "5448e8d04bdc2ddf718b4569",
    waterRation: "544fb62a4bdc2dd4348b456b",
    bottle: "5448fee04bdc2dbc018b4567",
    orphan: "aaaaaaaaaaaaaaaaaaaaaaaa",
    cycleOne: "bbbbbbbbbbbbbbbbbbbbbbbb",
    customizationHead: "5cc0868e14c02e000c6bea68",
};

export class FixtureSource implements UpstreamSource {
    fetchCalls = 0;
    tags: string[] = [];
    itemTpl = "";
    constructor(public sha: string = "a".repeat(40)) {}

    async latestSha(): Promise<string | null> {
        return this.sha;
    }

    async fetchFile(relPath: string): Promise<string> {
        this.fetchCalls++;
        const mapped = relPath.replace("templates/", "").replace("locales/global/", "locales/");
        return Bun.file(join(FIXTURES, mapped)).text();
    }

    async listLocaleFiles(): Promise<string[]> {
        return ["en.json", "fr.json"];
    }

    async listTags(): Promise<string[]> {
        return this.tags;
    }

    async fetchItemTpl(): Promise<string> {
        return this.itemTpl;
    }
}

export function testConfig(dataDir: string, overrides: Record<string, string> = {}): Config {
    return loadConfig({
        DATA_DIR: dataDir,
        REFRESH_INTERVAL_HOURS: "0",
        SPT_VERSIONS: "4.1",
        ...overrides,
    });
}
