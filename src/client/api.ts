import type {
    HierarchyResponse,
    ItemDetail,
    LocalesResponse,
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

export function searchItems(
    query: string,
    locale: string,
    signal?: AbortSignal,
): Promise<SearchResponse> {
    return get(
        `/api/search?q=${encodeURIComponent(query)}&locale=${encodeURIComponent(locale)}`,
        signal,
    );
}

export function getItem(id: string, locale: string): Promise<ItemDetail> {
    return get(`/api/item/${encodeURIComponent(id)}?locale=${encodeURIComponent(locale)}`);
}

export function getHierarchy(id: string, locale: string): Promise<HierarchyResponse> {
    return get(
        `/api/item/${encodeURIComponent(id)}/hierarchy?locale=${encodeURIComponent(locale)}`,
    );
}

export function getLocales(): Promise<LocalesResponse> {
    return get("/api/locales");
}
