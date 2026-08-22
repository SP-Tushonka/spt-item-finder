// Only what mods actually declare: tilde, exact, comparators, x-ranges, caret, `||`.
// Hyphen ranges never match; two versions in the whole corpus use one.

export type Version = [number, number, number];

const NUMERIC = /^\d+$/;
const WILDCARD = /^[xX*]$/;

export function parseVersion(value: string): Version | null {
    const cleaned = value.trim().replace(/^[v=]\s*/i, "");
    const core = cleaned.split(/[-+]/)[0] ?? "";
    const parts = core.split(".");
    if (parts.length === 0 || !NUMERIC.test(parts[0] ?? "")) return null;
    const at = (i: number) => (NUMERIC.test(parts[i] ?? "") ? Number.parseInt(parts[i]!, 10) : 0);
    return [at(0), at(1), at(2)];
}

export function compareVersions(a: string, b: string): number {
    const left = parseVersion(a);
    const right = parseVersion(b);
    if (!left || !right) return a.localeCompare(b);
    for (let i = 0; i < 3; i++) {
        if (left[i]! !== right[i]!) return left[i]! - right[i]!;
    }
    // A bare version is the release: 1.0.0 beats 1.0.0+pre1.
    return b.trim().length - a.trim().length;
}

function compare(a: Version, b: Version): number {
    for (let i = 0; i < 3; i++) {
        if (a[i]! !== b[i]!) return a[i]! - b[i]!;
    }
    return 0;
}

interface Partial {
    floor: Version;
    given: number;
}

function parsePartial(value: string): Partial | null {
    const cleaned = value.trim().replace(/^v/i, "");
    if (cleaned === "" || WILDCARD.test(cleaned)) return { floor: [0, 0, 0], given: 0 };

    const parts = cleaned.split(/[-+]/)[0]!.split(".");
    const floor: Version = [0, 0, 0];
    let given = 0;
    for (let i = 0; i < Math.min(parts.length, 3); i++) {
        const part = parts[i]!;
        if (WILDCARD.test(part) || part === "") break;
        if (!NUMERIC.test(part)) return null;
        floor[i] = Number.parseInt(part, 10);
        given = i + 1;
    }
    return { floor, given };
}

function bump(version: Version, index: number): Version {
    const out: Version = [...version];
    out[index] = out[index]! + 1;
    for (let i = index + 1; i < 3; i++) out[i] = 0;
    return out;
}

type Predicate = (v: Version) => boolean;

function comparatorFor(raw: string): Predicate | null {
    const match = raw.match(/^(>=|<=|>|<|=|\^|~>|~)?\s*(.*)$/);
    if (!match) return null;
    const op = match[1] ?? "=";
    const partial = parsePartial(match[2] ?? "");
    if (!partial) return null;

    const { floor, given } = partial;
    if (given === 0) return () => op !== "<" && op !== ">";

    switch (op) {
        case ">=":
            return (v) => compare(v, floor) >= 0;
        case ">":
            return (v) => compare(v, floor) > 0;
        case "<=":
            return (v) => compare(v, floor) <= 0;
        case "<":
            return (v) => compare(v, floor) < 0;
        case "~":
        case "~>": {
            const ceiling = bump(floor, given === 1 ? 0 : 1);
            return (v) => compare(v, floor) >= 0 && compare(v, ceiling) < 0;
        }
        case "^": {
            const first = floor.findIndex((part) => part !== 0);
            const ceiling = bump(floor, first === -1 ? 2 : Math.min(first, given - 1));
            return (v) => compare(v, floor) >= 0 && compare(v, ceiling) < 0;
        }
        default: {
            if (given === 3) return (v) => compare(v, floor) === 0;
            const ceiling = bump(floor, given - 1);
            return (v) => compare(v, floor) >= 0 && compare(v, ceiling) < 0;
        }
    }
}

export function satisfies(version: string, range: string): boolean {
    const target = parseVersion(version);
    if (!target || range.trim() === "") return false;

    return range.split("||").some((group) => {
        const comparators = group.trim().split(/\s+/).filter(Boolean);
        if (comparators.length === 0) return false;
        return comparators.every((raw) => {
            const predicate = comparatorFor(raw);
            return predicate ? predicate(target) : false;
        });
    });
}

const PATCH_LIMIT = 60;

export function targetsSptVersion(range: string, sptVersion: string): boolean {
    const parsed = parseVersion(`${sptVersion}.0`);
    if (!parsed) return false;
    const [major, minor] = parsed;
    for (let patch = 0; patch <= PATCH_LIMIT; patch++) {
        if (satisfies(`${major}.${minor}.${patch}`, range)) return true;
    }
    return false;
}

export function versionSortKey(value: string): number {
    const parsed = parseVersion(value);
    if (!parsed) return 0;
    return parsed[0] * 1e12 + parsed[1] * 1e6 + parsed[2];
}
