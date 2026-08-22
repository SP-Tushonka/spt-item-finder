// API DTOs shared by the server handlers and the client fetch wrapper.

export interface LocaleEntry {
    Name: string;
    ShortName: string;
    Description: string;
}

export interface HandbookEntry {
    ParentId: string;
    Price: number;
}

/** Raw upstream item template. `_props` is a large, schema-less bag. */
export interface Item {
    _id: string;
    _name: string;
    _parent: string;
    _type: string;
    _props: Record<string, unknown>;
    _proto?: string;
}

export interface ModRef {
    id: number;
    name: string;
    slug: string;
    detailUrl: string;
    version: string;
    sptVersion: string;
    /** Data came from the mod's default branch, not the release tag for this version. */
    approximate: boolean;
    /** The author warns that installing or removing the mod binds to a profile. */
    bindsProfile: boolean;
}

export interface ImportedModScan {
    sptVersion: string;
    version: string;
    items: number;
    scannedAt: string;
    /** Read from the mod's default branch rather than a release tag. */
    approximate: boolean;
}

export interface ImportedMod {
    id: number;
    name: string;
    slug: string;
    detailUrl: string;
    category: string | null;
    owner: string | null;
    downloads: number;
    sptVersions: ImportedModScan[];
}

export interface SptVersionsResponse {
    sptVersions: string[];
    default: string;
}

export interface ModItemsResponse {
    items: SearchResult[];
}

export interface ModsResponse {
    mods: ImportedMod[];
    totals: { mods: number; items: number };
}

export interface SearchResult {
    id: string;
    name: string;
    shortName: string | null;
    description: string | null;
    mod?: ModRef;
}

export interface SearchResponse {
    query: string;
    locale: string;
    truncated: boolean;
    results: SearchResult[];
}

export interface ItemDetail {
    item: Item;
    locale: LocaleEntry | null;
    handbook: HandbookEntry | null;
    mod?: ModRef;
    /** Vanilla template this modded item was cloned from, if it was. */
    cloneOf?: string | null;
    /** Ids a mod added to this item's slot filters, mapped to the mod that added them. */
    moddedFilters?: Record<string, string>;
    /** Other mods shipping this same id. */ 
    conflicts?: ModRef[];
}

export interface HierarchyNode {
    id: string;
    name: string;
    parent: string;
}

export interface HierarchyResponse {
    chain: HierarchyNode[];
}

export interface LocalesResponse {
    locales: string[];
    default: string;
}

export interface RefreshResponse {
    refreshed: boolean;
    sha: string;
    fetchedAt?: string;
    counts?: { items: number; locales: number };
}

export interface ApiErrorBody {
    error: string;
}
