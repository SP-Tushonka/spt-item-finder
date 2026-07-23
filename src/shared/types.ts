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

export interface SearchResult {
    id: string;
    name: string;
    shortName: string | null;
    description: string | null;
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
