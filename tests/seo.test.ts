import { describe, expect, test } from "bun:test";
import { escapeHtml, injectMeta, metaDescription, robotsTxt, sitemapXml } from "../src/server/seo";
import type { ItemDetail } from "../src/shared/types";

const SHELL = [
    "<!doctype html>",
    "<html><head>",
    "<title>SPT Item Finder</title>",
    '<meta name="description" content="static homepage description" />',
    "</head><body></body></html>",
].join("\n");

function detailWith(overrides: { name?: string; description?: string | null }): ItemDetail {
    return {
        item: {
            _id: "544fb62a4bdc2dd4348b456b",
            _name: "emergency_water_ration",
            _parent: "",
            _type: "Item",
            _props: {},
        },
        locale:
            overrides.description === null
                ? null
                : {
                      Name: overrides.name ?? "Emergency Water Ration",
                      ShortName: "Water",
                      Description: overrides.description ?? "An emergency water ration.",
                  },
        handbook: null,
    };
}

describe("escapeHtml", () => {
    test("escapes markup-significant characters", () => {
        expect(escapeHtml(`<script>"a" & 'b'</script>`)).toBe(
            "&lt;script&gt;&quot;a&quot; &amp; 'b'&lt;/script&gt;",
        );
    });
});

describe("metaDescription", () => {
    test("uses the locale description with collapsed whitespace", () => {
        const detail = detailWith({ description: "A kit.\n\nWith  sptVersions." });
        expect(metaDescription(detail)).toBe("A kit. With sptVersions.");
    });

    test("truncates long descriptions with an ellipsis", () => {
        const detail = detailWith({ description: "word ".repeat(100) });
        const result = metaDescription(detail);
        expect(result.length).toBeLessThanOrEqual(200);
        expect(result.endsWith("…")).toBe(true);
    });

    test("falls back to the template identity when no locale entry exists", () => {
        const detail = detailWith({ description: null });
        expect(metaDescription(detail)).toBe(
            "Item template 544fb62a4bdc2dd4348b456b (emergency_water_ration) in the SPT server database.",
        );
    });
});

describe("injectMeta", () => {
    const meta = {
        title: `Emergency "Water" Ration · SPT Item Finder`,
        description: "An emergency water ration.",
        url: "https://db.example.com/item/544fb62a4bdc2dd4348b456b",
    };
    const html = injectMeta(SHELL, meta);

    test("replaces the title", () => {
        expect(html).toContain(
            "<title>Emergency &quot;Water&quot; Ration · SPT Item Finder</title>",
        );
        expect(html).not.toContain("<title>SPT Item Finder</title>");
    });

    test("replaces the meta description instead of duplicating it", () => {
        expect(html.match(/name="description"/g)).toHaveLength(1);
        expect(html).toContain('content="An emergency water ration."');
    });

    test("adds canonical and Open Graph tags", () => {
        expect(html).toContain(`<link rel="canonical" href="${meta.url}" />`);
        expect(html).toContain('property="og:title"');
        expect(html).toContain(`<meta property="og:url" content="${meta.url}" />`);
        expect(html).toContain('name="twitter:card"');
    });

    test("escapes injected values", () => {
        const hostile = injectMeta(SHELL, { ...meta, title: `<script>alert(1)</script>` });
        expect(hostile).not.toContain("<script>alert(1)</script>");
        expect(hostile).toContain("&lt;script&gt;");
    });

    test("replaces a description tag whose attributes span multiple sptVersions", () => {
        const multilineShell = SHELL.replace(
            '<meta name="description" content="static homepage description" />',
            '<meta\n      name="description"\n      content="static homepage description"\n    />',
        );
        const result = injectMeta(multilineShell, meta);
        expect(result).not.toContain("static homepage description");
        expect(result).toContain('content="An emergency water ration."');
    });
});

describe("sitemapXml", () => {
    const xml = sitemapXml(["/item/aaa", "/item/bbb"], "https://db.example.com/", "2026-07-22");

    test("lists the homepage and every item URL with lastmod", () => {
        expect(xml).toStartWith(`<?xml version="1.0" encoding="UTF-8"?>`);
        expect(xml).toContain("<loc>https://db.example.com/</loc>");
        expect(xml).toContain("<loc>https://db.example.com/item/aaa</loc>");
        expect(xml).toContain("<loc>https://db.example.com/item/bbb</loc>");
        expect(xml.match(/<url>/g)).toHaveLength(3);
        expect(xml).toContain("<lastmod>2026-07-22</lastmod>");
    });

    test("escapes the query a non-default SPT sptVersion adds", () => {
        const tagged = sitemapXml(["/item/ccc?spt=4.0"], "https://db.example.com", "2026-07-22");
        expect(tagged).toContain("<loc>https://db.example.com/item/ccc?spt=4.0</loc>");
    });
});

describe("robotsTxt", () => {
    test("allows everything and points at the sitemap", () => {
        const txt = robotsTxt("https://db.example.com");
        expect(txt).toContain("User-agent: *");
        expect(txt).toContain("Sitemap: https://db.example.com/sitemap.xml");
    });
});
