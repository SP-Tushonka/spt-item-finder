import { describe, expect, test } from "bun:test";
import {
    DEFAULT_LIMITS,
    discoverRepo,
    matchTag,
    openMod,
    parseRepoUrl,
    resolveRef,
    selectPaths,
    type RepoRef,
    type RepoSource,
    type TreeEntry,
} from "../src/server/modsource";

class FakeRepoSource implements RepoSource {
    tags: string[] = [];
    branch: string | null = "main";
    commit: string | null = "a".repeat(40);
    entries: TreeEntry[] = [];
    truncated = false;
    contents: Record<string, string> = {};
    calls: string[] = [];

    async listTags(): Promise<string[]> {
        this.calls.push("tags");
        return this.tags;
    }
    async resolveCommit(_owner: string, _repo: string, ref: string): Promise<string | null> {
        this.calls.push(`commit:${ref}`);
        return this.commit;
    }
    async defaultBranch(): Promise<string | null> {
        this.calls.push("branch");
        return this.branch;
    }
    async tree(): Promise<{ entries: TreeEntry[]; truncated: boolean }> {
        this.calls.push("tree");
        return { entries: this.entries, truncated: this.truncated };
    }
    async read(_ref: RepoRef, path: string): Promise<string> {
        this.calls.push(`read:${path}`);
        const found = this.contents[path];
        if (found === undefined) throw new Error(`no such blob ${path}`);
        return found;
    }
}

function blob(path: string, size = 100): TreeEntry {
    return { path, type: "blob", size };
}

describe("parseRepoUrl", () => {
    // Every resolved Forge download in a 14-mod sample had this shape.
    test("takes owner, repo and tag from a release asset url", () => {
        expect(
            parseRepoUrl(
                "https://github.com/House16SPT/LegsTheTrader/releases/download/2.1.2/Legs.2.1.2.zip",
            ),
        ).toEqual({ owner: "House16SPT", repo: "LegsTheTrader", ref: "2.1.2", refKind: "tag" });
    });

    test("keeps a tag containing punctuation", () => {
        expect(
            parseRepoUrl(
                "https://github.com/MrVibesRSA/Secure-Mapbook/releases/download/Ver-1.5.6/x.zip",
            )?.ref,
        ).toBe("Ver-1.5.6");
    });

    test("reads a tree url", () => {
        expect(parseRepoUrl("https://github.com/a/b/tree/dev/src")).toEqual({
            owner: "a",
            repo: "b",
            ref: "dev",
            refKind: "branch",
        });
    });

    test("a plain repo url yields no ref", () => {
        expect(parseRepoUrl("https://github.com/WelcomeToThursday/Tarkov-1.0-Backport")).toEqual({
            owner: "WelcomeToThursday",
            repo: "Tarkov-1.0-Backport",
            ref: "",
            refKind: "branch",
        });
    });

    test("strips a .git suffix", () => {
        expect(parseRepoUrl("https://github.com/a/b.git")?.repo).toBe("b");
    });

    test("returns null for a non-GitHub host", () => {
        expect(parseRepoUrl("https://downloads-backport.welcometotarkov.com/x.7z")).toBeNull();
        expect(parseRepoUrl("https://gitlab.com/a/b")).toBeNull();
    });
});

describe("matchTag", () => {
    test("prefers an exact tag", () => {
        expect(matchTag("2.0.1", ["2.0.0", "2.0.1", "v2.0.1"])).toBe("2.0.1");
    });

    test("matches a v prefix", () => {
        expect(matchTag("5.0.0", ["v4.9.0", "v5.0.0"])).toBe("v5.0.0");
    });

    test("matches a decorated tag", () => {
        expect(matchTag("1.5.6", ["Ver-1.5.5", "Ver-1.5.6"])).toBe("Ver-1.5.6");
    });

    test("prefers the shortest of several containing tags", () => {
        expect(matchTag("1.0.0", ["v1.0.0-fix", "v1.0.0"])).toBe("v1.0.0");
    });

    test("does not match a different version", () => {
        expect(matchTag("2.0.1", ["1.9.9", "3.0.0"])).toBeNull();
    });

    test("does not mistake 1.0.0 for 11.0.0", () => {
        expect(matchTag("1.0.0", ["11.0.0"])).toBeNull();
    });
});

describe("selectPaths", () => {
    test("keeps only scannable extensions", () => {
        const { paths } = selectPaths([
            blob("db/CustomItems/a.json"),
            blob("Mod.cs"),
            blob("config.jsonc"),
            blob("Resources/bundles/x.bundle", 5_000_000),
            blob("README.md"),
            blob("icon.png"),
        ]);
        expect(paths).toEqual(["db/CustomItems/a.json", "Mod.cs", "config.jsonc"]);
    });

    test("ignores build output and tooling directories", () => {
        const { paths } = selectPaths([
            blob("obj/Debug/generated.cs"),
            blob("bin/Release/x.json"),
            blob("node_modules/pkg/package.json"),
            blob(".github/workflows/build.json"),
            blob("Properties/launchSettings.json"),
            blob("src/Mod.cs"),
        ]);
        expect(paths).toEqual(["src/Mod.cs"]);
    });

    test("skips a file over the per-file cap", () => {
        const result = selectPaths([blob("db/items.json", 20_000_000), blob("ok.json", 10)]);
        expect(result.paths).toEqual(["ok.json"]);
        expect(result.skipped).toEqual([{ path: "db/items.json", reason: "too-large" }]);
    });

    test("stops at the total budget and records what it dropped", () => {
        const limits = { ...DEFAULT_LIMITS, maxTotalBytes: 150 };
        const result = selectPaths([blob("a.json", 100), blob("b.json", 100)], limits);
        expect(result.paths).toEqual(["a.json"]);
        expect(result.skipped).toEqual([{ path: "b.json", reason: "over-budget" }]);
    });

    test("ignores tree entries that are not blobs", () => {
        expect(selectPaths([{ path: "db", type: "tree" }]).paths).toEqual([]);
    });
});

describe("discoverRepo", () => {
    const link = (url: string, label = "") => ({ url, label });

    test("takes the repo from the Forge's declared source links", () => {
        expect(
            discoverRepo([link("https://github.com/WelcomeToTarkov/Tarkov-1.0-Backport")]),
        ).toMatchObject({ owner: "WelcomeToTarkov", repo: "Tarkov-1.0-Backport" });
    });

    // 12 of the gated mods point at GitLab or Codeberg, which we cannot read.
    test("skips hosts we cannot read and takes the next link", () => {
        expect(
            discoverRepo([
                link("https://gitlab.com/a/b"),
                link("https://github.com/House16SPT/LegsTheTrader"),
            ]),
        ).toMatchObject({ owner: "House16SPT", repo: "LegsTheTrader" });
    });

    test("a mod with no usable source link is not indexable", () => {
        expect(discoverRepo([])).toBeNull();
        expect(discoverRepo([link("https://drexira.github.io/docs")])).toBeNull();
    });

    test("takes a release url apart when an author links one", () => {
        expect(
            discoverRepo([link("https://github.com/a/b/releases/download/2.0.1/b.zip")]),
        ).toEqual({ owner: "a", repo: "b", ref: "2.0.1", refKind: "tag" });
    });

    // More Energy Drinks lists its old TypeScript repo first and the C# rewrite second.
    test("prefers the repo labelled for the sptVersion being scanned", () => {
        const links = [
            link("https://github.com/Hood26/Hoods-Energy-Drinks", "3.11"),
            link("https://github.com/Hood26/HoodsEnergyDrinks-CSharp", "4.0"),
        ];
        expect(discoverRepo(links, "4.0")?.repo).toBe("HoodsEnergyDrinks-CSharp");
    });

    test("falls back to the same major when no label matches the sptVersion exactly", () => {
        const links = [
            link("https://github.com/Hood26/Hoods-Energy-Drinks", "3.11"),
            link("https://github.com/Hood26/HoodsEnergyDrinks-CSharp", "4.0"),
        ];
        expect(discoverRepo(links, "4.1")?.repo).toBe("HoodsEnergyDrinks-CSharp");
    });

    test("an unlabelled repo beats one labelled for another sptVersion", () => {
        const links = [
            link("https://github.com/old/three-x", "3.11"),
            link("https://github.com/new/unlabelled"),
        ];
        expect(discoverRepo(links, "4.1")?.repo).toBe("unlabelled");
    });

    // The Blacklist labels its two repos "C#" and "Node"; Freecam uses "Current" and "OG".
    test("prefers the C# rewrite over the node original", () => {
        const links = [
            link("https://github.com/x/spt-the-blacklist", "Node"),
            link("https://github.com/x/the-blacklist", "C#"),
        ];
        expect(discoverRepo(links, "4.1")?.repo).toBe("the-blacklist");
    });

    test("prefers the current repo over the original", () => {
        const links = [
            link("https://github.com/x/old-freecam", "OG"),
            link("https://github.com/x/SPT-Freecam", "Current"),
        ];
        expect(discoverRepo(links, "4.1")?.repo).toBe("SPT-Freecam");
    });

    test("without a sptVersion, the first usable link still wins", () => {
        const links = [link("https://github.com/a/first"), link("https://github.com/b/second")];
        expect(discoverRepo(links)?.repo).toBe("first");
    });
});

describe("resolveRef", () => {
    const REPO: RepoRef = { owner: "a", repo: "b", ref: "", refKind: "branch" };

    test("keeps a tag that came from a release url without listing tags", async () => {
        const source = new FakeRepoSource();
        const ref: RepoRef = { ...REPO, ref: "2.0.1", refKind: "tag" };
        expect(await resolveRef(source, ref, "2.0.1")).toEqual({ ...ref, sha: "a".repeat(40) });
        expect(source.calls).toEqual(["commit:2.0.1"]);
    });

    test("pins to the tag matching the Forge version", async () => {
        const source = new FakeRepoSource();
        source.tags = ["v1.9.0", "v2.0.1"];
        expect(await resolveRef(source, REPO, "2.0.1")).toMatchObject({
            ref: "v2.0.1",
            refKind: "tag",
        });
    });

    test("falls back to the default branch when no tag matches", async () => {
        const source = new FakeRepoSource();
        source.tags = ["v1.0.0"];
        source.branch = "master";
        expect(await resolveRef(source, REPO, "2.0.1")).toMatchObject({
            ref: "master",
            refKind: "branch",
        });
    });

    // The sha is what makes a later sync able to notice a branch has moved.
    test("records the commit the ref pointed at", async () => {
        const source = new FakeRepoSource();
        source.commit = "b".repeat(40);
        expect((await resolveRef(source, REPO, "2.0.1"))?.sha).toBe("b".repeat(40));
    });

    test("a ref whose commit cannot be read still resolves", async () => {
        const source = new FakeRepoSource();
        source.commit = null;
        expect((await resolveRef(source, REPO, "2.0.1"))?.sha).toBeUndefined();
    });

    test("returns null when the repo cannot be read at all", async () => {
        const source = new FakeRepoSource();
        source.branch = null;
        expect(await resolveRef(source, REPO, "2.0.1")).toBeNull();
    });
});

describe("openMod", () => {
    const REF: RepoRef = { owner: "a", repo: "b", ref: "1.0.0", refKind: "tag" };

    test("returns lazily read files for the selected paths", async () => {
        const source = new FakeRepoSource();
        source.entries = [blob("db/CustomItems/a.json"), blob("art.png")];
        source.contents["db/CustomItems/a.json"] = "{}";

        const tree = await openMod(source, REF);
        expect(tree.files.map((f) => f.path)).toEqual(["db/CustomItems/a.json"]);
        expect(source.calls).toEqual(["tree"]);

        expect(await tree.files[0]!.text()).toBe("{}");
        expect(source.calls).toEqual(["tree", "read:db/CustomItems/a.json"]);
    });

    test("reads blobs at the pinned commit, not the moving ref", async () => {
        const source = new FakeRepoSource();
        source.entries = [blob("db/a.json")];
        source.contents["db/a.json"] = "{}";
        const tree = await openMod(source, {
            ...REF,
            refKind: "branch",
            ref: "main",
            sha: "c".repeat(40),
        });
        expect(await tree.files[0]!.text()).toBe("{}");
    });

    test("passes the truncation flag through", async () => {
        const source = new FakeRepoSource();
        source.truncated = true;
        expect((await openMod(source, REF)).truncated).toBe(true);
    });
});
