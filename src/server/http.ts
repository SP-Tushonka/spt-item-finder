export const USER_AGENT = "sp-tushonka-db";

export interface RateLimited {
    status: number;
    headers: { get(name: string): string | null };
}

export function retryDelayMs(res: RateLimited, now = Date.now()): number | null {
    if (res.status !== 429 && res.status !== 403) return null;
    const retryAfter = Number.parseInt(res.headers.get("retry-after") ?? "", 10);
    if (Number.isFinite(retryAfter)) return Math.max(0, retryAfter * 1000);
    if (res.headers.get("x-ratelimit-remaining") !== "0") return null;
    const reset = Number.parseInt(res.headers.get("x-ratelimit-reset") ?? "", 10);
    if (!Number.isFinite(reset)) return null;
    return Math.max(0, reset * 1000 - now);
}

export interface GetJsonOptions {
    headers?: Record<string, string>;
    maxWaitMs?: number;
}

export async function getJson<T>(url: string, options: GetJsonOptions = {}): Promise<T | null> {
    const maxWait = options.maxWaitMs ?? 120_000;
    for (let attempt = 0; attempt < 2; attempt++) {
        const res = await fetch(url, { headers: options.headers });
        if (res.ok) return (await res.json()) as T;

        const wait = retryDelayMs(res);
        if (attempt === 1 || wait === null || wait > maxWait) return null;
        await Bun.sleep(wait);
    }
    return null;
}
