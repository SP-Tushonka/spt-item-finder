import type {
    HierarchyResponse,
    ItemDetail,
    SptVersionsResponse,
    LocalesResponse,
    ModItemsResponse,
    ModsResponse,
    SearchResponse,
} from "../shared/types";

export class ApiError extends Error {
    constructor(
        public status: number,
        message: string,
    ) {
        super(message);
    }
}

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
    const res = await fetch(path, { signal });
    if (!res.ok) {
        let message = res.statusText;
        try {
            message = ((await res.json()) as { error?: string }).error ?? message;
        } catch {}
        throw new ApiError(res.status, message);
    }
    return res.json() as Promise<T>;
}

function params(locale: string, sptVersion: string, without: Set<number> = new Set()): string {
    const base = `locale=${encodeURIComponent(locale)}&spt=${encodeURIComponent(sptVersion)}`;
    return without.size > 0 ? `${base}&without=${[...without].join(",")}` : base;
}

export function searchItems(
    query: string,
    locale: string,
    sptVersion: string,
    mods: boolean,
    without: Set<number>,
    signal?: AbortSignal,
): Promise<SearchResponse> {
    return get(
        `/api/search?q=${encodeURIComponent(query)}&${params(locale, sptVersion, without)}` +
            (mods ? "" : "&mods=0"),
        signal,
    );
}

export function getItem(
    id: string,
    locale: string,
    sptVersion: string,
    without: Set<number>,
): Promise<ItemDetail> {
    return get(`/api/item/${encodeURIComponent(id)}?${params(locale, sptVersion, without)}`);
}

export function getHierarchy(
    id: string,
    locale: string,
    sptVersion: string,
): Promise<HierarchyResponse> {
    return get(`/api/item/${encodeURIComponent(id)}/hierarchy?${params(locale, sptVersion)}`);
}

export function getModItems(
    modId: number,
    locale: string,
    sptVersion: string,
): Promise<ModItemsResponse> {
    return get(`/api/mods/${modId}/items?${params(locale, sptVersion)}`);
}

export function getMods(sptVersion: string): Promise<ModsResponse> {
    return get(`/api/mods?spt=${encodeURIComponent(sptVersion)}`);
}

export function getSptVersions(): Promise<SptVersionsResponse> {
    return get("/api/versions");
}

export function getLocales(): Promise<LocalesResponse> {
    return get("/api/locales");
}
