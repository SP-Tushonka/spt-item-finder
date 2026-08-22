import { describe, expect, test } from "bun:test";
import { compareVersions, parseVersion, satisfies, targetsSptVersion } from "../src/server/semver";

describe("parseVersion", () => {
    test("reads a plain version", () => {
        expect(parseVersion("4.1.3")).toEqual([4, 1, 3]);
    });

    test("fills in missing parts", () => {
        expect(parseVersion("4.1")).toEqual([4, 1, 0]);
        expect(parseVersion("4")).toEqual([4, 0, 0]);
    });

    test("drops prerelease and build metadata", () => {
        expect(parseVersion("0.13.1+pre1")).toEqual([0, 13, 1]);
        expect(parseVersion("1.0.0-rc.2")).toEqual([1, 0, 0]);
    });

    test("tolerates a v or = prefix", () => {
        expect(parseVersion("v2.0.1")).toEqual([2, 0, 1]);
        expect(parseVersion("=4.0.13")).toEqual([4, 0, 13]);
    });

    test("rejects a non-version", () => {
        expect(parseVersion("main")).toBeNull();
        expect(parseVersion("")).toBeNull();
    });
});

describe("compareVersions", () => {
    test("orders by each part numerically", () => {
        expect(compareVersions("4.1.3", "4.1.2")).toBeGreaterThan(0);
        expect(compareVersions("4.2.0", "4.10.0")).toBeLessThan(0);
        expect(compareVersions("1.1.5", "1.1.5")).toBe(0);
    });

    test("does not compare as strings", () => {
        expect(compareVersions("2.0.1", "10.0.0")).toBeLessThan(0);
    });

    test("a release beats its own prerelease", () => {
        expect(compareVersions("0.13.1", "0.13.1+pre1")).toBeGreaterThan(0);
        expect(compareVersions("4.1.3", "4.1.3-BEM-20260816")).toBeGreaterThan(0);
    });

    test("sorts a real version list", () => {
        const sorted = ["1.1.5", "2.0.1", "1.0.6", "1.1.10", "2.0.0"].sort(compareVersions);
        expect(sorted).toEqual(["1.0.6", "1.1.5", "1.1.10", "2.0.0", "2.0.1"]);
    });
});

describe("satisfies", () => {
    test("tilde stops at the next minor", () => {
        expect(satisfies("4.1.1", "~4.1.1")).toBe(true);
        expect(satisfies("4.1.9", "~4.1.1")).toBe(true);
        expect(satisfies("4.1.0", "~4.1.1")).toBe(false);
        expect(satisfies("4.2.0", "~4.1.1")).toBe(false);
    });

    test("a two-part tilde covers the whole minor", () => {
        expect(satisfies("4.1.0", "~4.1")).toBe(true);
        expect(satisfies("4.1.99", "~4.1")).toBe(true);
        expect(satisfies("4.2.0", "~4.1")).toBe(false);
    });

    test("a one-part tilde covers the whole major", () => {
        expect(satisfies("4.9.0", "~4")).toBe(true);
        expect(satisfies("5.0.0", "~4")).toBe(false);
    });

    test("an exact constraint matches only itself", () => {
        expect(satisfies("4.0.10", "4.0.10")).toBe(true);
        expect(satisfies("4.0.11", "4.0.10")).toBe(false);
    });

    test("a partial version behaves as an x-range", () => {
        expect(satisfies("4.1.7", "4.1")).toBe(true);
        expect(satisfies("4.2.0", "4.1")).toBe(false);
        expect(satisfies("4.1.7", "4.1.x")).toBe(true);
        expect(satisfies("4.9.9", "4.x")).toBe(true);
        expect(satisfies("5.0.0", "4.x")).toBe(false);
    });

    test("caret stops at the next major", () => {
        expect(satisfies("4.9.9", "^4.1.0")).toBe(true);
        expect(satisfies("5.0.0", "^4.1.0")).toBe(false);
        expect(satisfies("4.0.0", "^4.1.0")).toBe(false);
    });

    test("comparators work alone and combined", () => {
        expect(satisfies("4.0.13", ">=4.0.13")).toBe(true);
        expect(satisfies("4.0.12", ">=4.0.13")).toBe(false);
        expect(satisfies("4.0.5", "4.x <4.1.0")).toBe(true);
        expect(satisfies("4.1.0", "4.x <4.1.0")).toBe(false);
    });

    test("alternatives are ored", () => {
        expect(satisfies("4.1.0", "~4.0.0 || ~4.1.0")).toBe(true);
        expect(satisfies("4.2.0", "~4.0.0 || ~4.1.0")).toBe(false);
    });

    test("a wildcard accepts anything", () => {
        expect(satisfies("4.1.3", "*")).toBe(true);
    });

    // 36% of Forge versions declare nothing; those are legacy hub imports, not universal matches.
    test("an empty constraint matches nothing", () => {
        expect(satisfies("4.1.3", "")).toBe(false);
        expect(satisfies("4.1.3", "   ")).toBe(false);
    });

    test("unsupported syntax does not match rather than throwing", () => {
        expect(satisfies("1.5.0", "1.0.0 - 2.0.0")).toBe(false);
        expect(satisfies("4.1.3", "nonsense")).toBe(false);
    });
});

describe("targetsSptVersion", () => {
    // The Forge's own filter is a point test, so ~4.0.13 looks like it misses 4.0 entirely.
    test("a late-patch tilde still targets its sptVersion", () => {
        expect(targetsSptVersion("~4.0.13", "4.0")).toBe(true);
        expect(targetsSptVersion("~4.0.13", "4.1")).toBe(false);
    });

    test("separates the two sptVersions", () => {
        expect(targetsSptVersion("~4.1.1", "4.1")).toBe(true);
        expect(targetsSptVersion("~4.1.1", "4.0")).toBe(false);
        expect(targetsSptVersion("~3.11.0", "4.0")).toBe(false);
    });

    test("a range spanning both sptVersions targets both", () => {
        expect(targetsSptVersion("~4", "4.0")).toBe(true);
        expect(targetsSptVersion("~4", "4.1")).toBe(true);
    });

    test("an exact pin targets its own sptVersion only", () => {
        expect(targetsSptVersion("4.0.10", "4.0")).toBe(true);
        expect(targetsSptVersion("4.0.10", "4.1")).toBe(false);
    });

    test("an undeclared constraint targets nothing", () => {
        expect(targetsSptVersion("", "4.0")).toBe(false);
    });
});
