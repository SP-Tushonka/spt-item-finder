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

const MODS_KEY = "sptdb.mods";

export function getModsEnabled(): boolean {
    try {
        return localStorage.getItem(MODS_KEY) !== "0";
    } catch {
        return true;
    }
}

export function setModsEnabled(enabled: boolean): void {
    try {
        localStorage.setItem(MODS_KEY, enabled ? "1" : "0");
    } catch {}
}

const SPT_KEY = "sptdb.spt";

export function getSptVersion(): string {
    try {
        return localStorage.getItem(SPT_KEY) ?? "";
    } catch {
        return "";
    }
}

export function setSptVersion(sptVersion: string): void {
    try {
        localStorage.setItem(SPT_KEY, sptVersion);
    } catch {}
}

const EXPAND_KEY = "sptdb.expand";

export function getExpandAll(): boolean {
    try {
        return localStorage.getItem(EXPAND_KEY) !== "0";
    } catch {
        return true;
    }
}

export function setExpandAll(expanded: boolean): void {
    try {
        localStorage.setItem(EXPAND_KEY, expanded ? "1" : "0");
    } catch {}
}

const OFF_MODS_KEY = "sptdb.offmods";

/** Stores the mods switched off, so a newly indexed one is on without any migration. */
export function getDisabledMods(): Set<number> {
    try {
        const raw = localStorage.getItem(OFF_MODS_KEY) ?? "";
        // Number("") is 0, so the empty preference would read as "mod 0 is off".
        return new Set(
            raw
                .split(",")
                .filter(Boolean)
                .map((id) => Number.parseInt(id, 10))
                .filter(Number.isFinite),
        );
    } catch {
        return new Set();
    }
}

export function setDisabledMods(ids: Set<number>): void {
    try {
        localStorage.setItem(OFF_MODS_KEY, [...ids].join(","));
    } catch {}
}
