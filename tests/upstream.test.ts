import { describe, expect, test } from "bun:test";
import {
    FALLBACK_LOCALE_FILES,
    lfsBatchBody,
    parseLfsPointer,
    refForSptVersion,
} from "../src/server/upstream";

const OID = "3f35bd85bc19c6c224e0dcc0a05120b7cba412ec885c4f73613c615092a2fe96";
const POINTER = `version https://git-lfs.github.com/spec/v1\noid sha256:${OID}\nsize 19116421\n`;

describe("parseLfsPointer", () => {
    test("parses a real pointer", () => {
        expect(parseLfsPointer(POINTER)).toEqual({ oid: OID, size: 19116421 });
    });

    test("rejects JSON content", () => {
        expect(parseLfsPointer('{ "_id": "x" }')).toBeNull();
    });

    test("rejects bodies over 1KB", () => {
        expect(parseLfsPointer(POINTER + " ".repeat(2000))).toBeNull();
    });

    test("rejects a malformed oid", () => {
        expect(
            parseLfsPointer(
                `version https://git-lfs.github.com/spec/v1\noid sha256:nothex\nsize 5\n`,
            ),
        ).toBeNull();
    });

    test("rejects a missing size", () => {
        expect(
            parseLfsPointer(`version https://git-lfs.github.com/spec/v1\noid sha256:${OID}\n`),
        ).toBeNull();
    });
});

describe("lfsBatchBody", () => {
    test("matches the git-lfs batch spec", () => {
        expect(lfsBatchBody({ oid: OID, size: 42 })).toEqual({
            operation: "download",
            transfers: ["basic"],
            objects: [{ oid: OID, size: 42 }],
        });
    });
});

describe("FALLBACK_LOCALE_FILES", () => {
    test("includes the known upstream locales", () => {
        expect(FALLBACK_LOCALE_FILES).toContain("en.json");
        expect(FALLBACK_LOCALE_FILES).toContain("es-mx.json");
        expect(FALLBACK_LOCALE_FILES.length).toBe(17);
    });
});

describe("refForSptVersion", () => {
    const tags = [
        "v4.2.0",
        "4.1.3-BEM-20260816",
        "4.1.3",
        "4.1.2",
        "4.1.0",
        "4.0.13",
        "4.0.9",
        "3.11.4",
    ];

    test("picks the newest tag on the sptVersion", () => {
        expect(refForSptVersion(tags, "4.0", "main")).toBe("4.0.13");
        expect(refForSptVersion(tags, "4.1", "main")).toBe("4.1.3");
    });

    // Build tags have no database in their tree, and v-prefixed ones are the fork's own releases.
    test("ignores build tags and v-prefixed tags", () => {
        expect(refForSptVersion(["4.1.3-BEM-20260816"], "4.1", "main")).toBe("main");
        expect(refForSptVersion(["v4.2.0"], "4.2", "main")).toBe("main");
    });

    test("falls back when the sptVersion has no tag", () => {
        expect(refForSptVersion(tags, "5.0", "main")).toBe("main");
        expect(refForSptVersion([], "4.0", "develop")).toBe("develop");
    });
});
