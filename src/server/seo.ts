import type { ItemDetail } from "../shared/types";

export function escapeHtml(text: string): string {
    return text
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
}

const DESCRIPTION_LIMIT = 200;

export function metaDescription(detail: ItemDetail): string {
    const raw = detail.locale?.Description?.trim();
    const fallback = `Item template ${detail.item._id} (${detail.item._name}) in the SPT server database.`;
    const text = (raw || fallback).replace(/\s+/g, " ");
    if (text.length <= DESCRIPTION_LIMIT) return text;
    return `${text.slice(0, DESCRIPTION_LIMIT - 1).trimEnd()}…`;
}

export interface PageMeta {
    title: string;
    description: string;
    url: string;
}

/** Rewrites the SPA shell's title/description and adds canonical + Open Graph tags. */
export function injectMeta(shell: string, meta: PageMeta): string {
    const title = escapeHtml(meta.title);
    const description = escapeHtml(meta.description);
    const url = escapeHtml(meta.url);
    const headExtra =
        `<link rel="canonical" href="${url}" />` +
        `<meta property="og:site_name" content="SPT Item Finder" />` +
        `<meta property="og:type" content="website" />` +
        `<meta property="og:title" content="${title}" />` +
        `<meta property="og:description" content="${description}" />` +
        `<meta property="og:url" content="${url}" />` +
        `<meta name="twitter:card" content="summary" />`;
    return shell
        .replace(/<title>.*?<\/title>/s, `<title>${title}</title>`)
        .replace(/(<meta\s+name="description"\s+content=")[^"]*(")/s, `$1${description}$2`)
        .replace("</head>", `${headExtra}</head>`);
}

export function sitemapXml(ids: string[], siteUrl: string, lastmod: string): string {
    const base = siteUrl.replace(/\/$/, "");
    const urls = [`${base}/`, ...ids.map((id) => `${base}/item/${id}`)];
    const body = urls
        .map((loc) => `  <url><loc>${escapeHtml(loc)}</loc><lastmod>${lastmod}</lastmod></url>`)
        .join("\n");
    return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
}

export function robotsTxt(siteUrl: string): string {
    return `User-agent: *\nAllow: /\n\nSitemap: ${siteUrl.replace(/\/$/, "")}/sitemap.xml\n`;
}
