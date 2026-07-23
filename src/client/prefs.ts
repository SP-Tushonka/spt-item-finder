const LOCALE_KEY = "sptdb.locale";

export function getLocale(): string {
    try {
        return localStorage.getItem(LOCALE_KEY) ?? "en";
    } catch {
        return "en";
    }
}

export function setLocale(code: string): void {
    try {
        localStorage.setItem(LOCALE_KEY, code);
    } catch {}
}
