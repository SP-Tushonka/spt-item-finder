import type { LocaleEntry } from "../shared/types";

export interface ModFile {
    path: string;
    text(): Promise<string>;
}

export type CandidateKind = "database" | "clone-json" | "clone-csharp" | "config-json";

export interface ItemCandidate {
    id: string;
    kind: CandidateKind;
    sourcePath: string;
    cloneOf?: string;
    parentId?: string;
    handbookParentId?: string;
    props?: Record<string, unknown>;
    locales?: Record<string, LocaleEntry>;
    handbookPrice?: number;
    fleaPrice?: number;
    modSlots?: string[];
}

export type SkipReason = "unparseable" | "bulk-override" | "no-stable-id" | "dynamic-id";

export interface SkippedFile {
    path: string;
    reason: SkipReason;
    count?: number;
}

export type Verdict = "items" | "items-unextractable" | "no-items";

export interface ScanResult {
    candidates: ItemCandidate[];
    verdict: Verdict;
    skipped: SkippedFile[];
}

const MONGO_ID = /^[0-9a-f]{24}$/;
const BULK_OVERRIDE_LIMIT = 500;

export async function scan(files: ModFile[], enums?: Map<string, string>): Promise<ScanResult> {
    const candidates: ItemCandidate[] = [];
    const skipped: SkippedFile[] = [];
    const localeTables: LocaleTable[] = [];

    for (const file of files) {
        const lower = file.path.toLowerCase();
        const isJson = lower.endsWith(".json") || lower.endsWith(".jsonc");
        const isCs = lower.endsWith(".cs");
        if (!isJson && !isCs) continue;

        let text: string;
        try {
            text = await file.text();
        } catch {
            skipped.push({ path: file.path, reason: "unparseable" });
            continue;
        }

        if (isJson) {
            const table = readLocaleTable(text, file.path);
            if (table) {
                localeTables.push(table);
                continue;
            }
        }

        const found = isJson
            ? scanJson(text, file.path, skipped)
            : scanCsharp(text, file.path, enums, skipped);

        if (found.length > BULK_OVERRIDE_LIMIT) {
            skipped.push({ path: file.path, reason: "bulk-override", count: found.length });
            continue;
        }
        candidates.push(...found);
    }

    applyLocaleTables(candidates, localeTables);
    return { candidates, verdict: verdictFor(candidates, skipped), skipped };
}

interface LocaleTable {
    code: string;
    entries: Map<string, Partial<LocaleEntry>>;
}

const LOCALE_KEY = /^([0-9a-f]{24}) (Name|ShortName|Description)$/;

function readLocaleTable(text: string, path: string): LocaleTable | null {
    if (!text.includes(' Name"')) return null;
    let root: unknown;
    try {
        root = parseJsonc(text);
    } catch {
        return null;
    }
    if (!isRecord(root)) return null;

    const entries = new Map<string, Partial<LocaleEntry>>();
    for (const [key, value] of Object.entries(root)) {
        const match = key.match(LOCALE_KEY);
        if (!match || typeof value !== "string") continue;
        const entry = entries.get(match[1]!) ?? {};
        entry[match[2] as keyof LocaleEntry] = value;
        entries.set(match[1]!, entry);
    }
    if (entries.size === 0) return null;

    const code = (path.split("/").pop() ?? "").replace(/\.jsonc?$/i, "").toLowerCase();
    return code ? { code, entries } : null;
}

/** Entries for ids the mod does not add are dropped, so a vanilla locale dump costs nothing. */
function applyLocaleTables(candidates: ItemCandidate[], tables: LocaleTable[]): void {
    if (tables.length === 0) return;
    for (const candidate of candidates) {
        for (const table of tables) {
            const entry = table.entries.get(candidate.id);
            if (!entry?.Name) continue;
            const locales = (candidate.locales ??= {});
            locales[table.code] ??= {
                Name: entry.Name,
                ShortName: entry.ShortName ?? "",
                Description: entry.Description ?? "",
            };
        }
    }
}

function verdictFor(candidates: ItemCandidate[], skipped: SkippedFile[]): Verdict {
    if (candidates.length > 0) return "items";
    const blocked = skipped.some((s) => s.reason === "no-stable-id" || s.reason === "dynamic-id");
    return blocked ? "items-unextractable" : "no-items";
}

function scanJson(text: string, path: string, skipped: SkippedFile[]): ItemCandidate[] {
    let root: unknown;
    try {
        root = parseJsonc(text);
    } catch {
        skipped.push({ path, reason: "unparseable" });
        return [];
    }
    const out: ItemCandidate[] = [];
    if (Array.isArray(root)) {
        for (const value of root) {
            const candidate = isRecord(value) ? readConfigEntry(value, path) : null;
            if (candidate) out.push(candidate);
        }
        return out;
    }
    if (!isRecord(root)) return [];

    const wrapped = readNewItemFile(root, path);
    if (wrapped !== undefined) return wrapped ? [wrapped] : [];

    for (const [key, value] of Object.entries(root)) {
        if (!isRecord(value)) continue;
        const candidate =
            readDatabaseEntry(key, value, path) ??
            readCloneEntry(key, value, path) ??
            readConfigEntry(value, path);
        if (candidate) out.push(candidate);
    }
    return out;
}

/** SPT's NewItemDetails shape: the template under `newItem`, locales and prices beside it. */
function readNewItemFile(
    root: Record<string, unknown>,
    path: string,
): ItemCandidate | null | undefined {
    const item = pick(root, "newItem");
    if (!isRecord(item)) return undefined;
    const entry = readDatabaseEntry("", item, path);
    if (!entry) return undefined;

    // The mod itself says the item cannot be obtained anywhere, so it is not one to index.
    const blacklist = pick(root, "blacklist");
    if (isRecord(blacklist) && pick(blacklist, "all") === true) return null;

    return {
        ...entry,
        locales: readJsonLocales(pick(root, "locales")) ?? undefined,
        handbookPrice: num(pick(root, "handbookPriceRoubles")),
        fleaPrice: num(pick(root, "fleaPriceRoubles")),
    };
}

function readDatabaseEntry(
    key: string,
    value: Record<string, unknown>,
    path: string,
): ItemCandidate | null {
    const id = typeof value._id === "string" ? value._id : key;
    if (!MONGO_ID.test(id)) return null;
    if (typeof value._parent !== "string" || !isRecord(value._props)) return null;
    return { id, kind: "database", sourcePath: path, parentId: value._parent, props: value._props };
}

function readCloneEntry(
    key: string,
    value: Record<string, unknown>,
    path: string,
): ItemCandidate | null {
    if (!MONGO_ID.test(key)) return null;
    const cloneOf = str(pick(value, "itemTplToClone"));
    if (!cloneOf) return null;
    const overrides = pick(value, "overrideProperties");
    const locales = readJsonLocales(pick(value, "locales"));
    // itemTplToClone alone also appears in assort and bot-loadout entries.
    if (!isRecord(overrides) && !locales) return null;
    return {
        id: key,
        kind: "clone-json",
        sourcePath: path,
        cloneOf,
        parentId: str(pick(value, "parentId")),
        handbookParentId: str(pick(value, "handbookParentId")),
        props: isRecord(overrides) ? overrides : undefined,
        locales: locales ?? undefined,
        handbookPrice: num(pick(value, "handbookPriceRoubles")),
        fleaPrice: num(pick(value, "fleaPriceRoubles")),
        modSlots: readModSlots(value),
    };
}

const SPECIAL_SLOTS = ["SpecialSlot1", "SpecialSlot2", "SpecialSlot3"];
const SECURE_SLOTS = ["SecuredContainer"];

function readModSlots(value: Record<string, unknown>): string[] | undefined {
    const names = new Set<string>();
    if (pick(value, "addtoModSlots") === true) addNames(names, pick(value, "modSlot"));
    addNames(names, pick(value, "addtoInventorySlots"));
    if (pick(value, "addtoSpecialSlots") === true) for (const s of SPECIAL_SLOTS) names.add(s);
    if (pick(value, "addtoSecureFilters") === true) for (const s of SECURE_SLOTS) names.add(s);
    return names.size > 0 ? [...names] : undefined;
}

function addNames(into: Set<string>, value: unknown): void {
    if (!Array.isArray(value)) return;
    for (const name of value) {
        if (typeof name === "string" && name !== "") into.add(name);
    }
}

const CONFIG_ID = ["id", "_id", "itemId"];
const CONFIG_NAME = ["item_name", "itemName", "name"];
const CONFIG_SHORT = ["item_short_name", "itemShortName", "short_name", "shortName"];
const CONFIG_DESC = ["item_description", "itemDescription", "description"];
const CONFIG_FLEA = ["flea_price", "fleaPrice"];
const CONFIG_HANDBOOK = ["handbook_price", "handbookPrice"];

/** A short name is the discriminator: quests and assorts have ids and names, not short names. */
function readConfigEntry(value: Record<string, unknown>, path: string): ItemCandidate | null {
    const id = firstStr(value, CONFIG_ID);
    if (!id || !MONGO_ID.test(id)) return null;
    const shortName = firstStr(value, CONFIG_SHORT);
    if (!shortName) return null;
    const name = firstStr(value, CONFIG_NAME);
    const description = firstStr(value, CONFIG_DESC);
    if (!name && !description) return null;
    return {
        id,
        kind: "config-json",
        sourcePath: path,
        // A config schema has nowhere to declare a language; in practice these strings are English.
        locales: {
            en: { Name: name ?? shortName, ShortName: shortName, Description: description ?? "" },
        },
        fleaPrice: firstNum(value, CONFIG_FLEA),
        handbookPrice: firstNum(value, CONFIG_HANDBOOK),
    };
}

function readJsonLocales(value: unknown): Record<string, LocaleEntry> | null {
    if (!isRecord(value)) return null;
    const out: Record<string, LocaleEntry> = {};
    for (const [code, entry] of Object.entries(value)) {
        if (!isRecord(entry)) continue;
        const name = str(pick(entry, "name"));
        if (name === undefined) continue;
        out[code] = {
            Name: name,
            ShortName: str(pick(entry, "shortName")) ?? "",
            Description: str(pick(entry, "description")) ?? "",
        };
    }
    return Object.keys(out).length > 0 ? out : null;
}

const CLONE_DETAILS = /\bnew\s+(?:NewItemFromCloneDetails|NewItemDetails)\b/g;

function scanCsharp(
    text: string,
    path: string,
    enums: Map<string, string> | undefined,
    skipped: SkippedFile[],
): ItemCandidate[] {
    const out: ItemCandidate[] = [];
    CLONE_DETAILS.lastIndex = 0;
    for (let m = CLONE_DETAILS.exec(text); m; m = CLONE_DETAILS.exec(text)) {
        const block = readInitializer(text, m.index + m[0].length);
        if (!block) continue;
        CLONE_DETAILS.lastIndex = block.end;

        const fields = assignments(block.body);
        const id = csId(fields.get("newid"), enums);
        if (!id) {
            // No NewId means a random one each launch; a non-literal one comes from config.
            const reason = fields.has("newid") ? "dynamic-id" : "no-stable-id";
            skipped.push({ path, reason });
            continue;
        }
        out.push({
            id,
            kind: "clone-csharp",
            sourcePath: path,
            cloneOf: csId(fields.get("itemtpltoclone"), enums),
            parentId: csId(fields.get("parentid"), enums),
            handbookParentId: csId(fields.get("handbookparentid"), enums),
            locales: readCsLocales(fields.get("locales")),
            handbookPrice: csNumber(fields.get("handbookpriceroubles")),
            fleaPrice: csNumber(fields.get("fleapriceroubles")),
        });
    }
    return out;
}

function assignments(body: string): Map<string, string> {
    const out = new Map<string, string>();
    for (const segment of splitTopLevel(body)) {
        const eq = segment.match(/^\s*(\w+)\s*=\s*([\s\S]+)$/);
        if (eq) out.set(eq[1]!.toLowerCase(), eq[2]!.trim());
    }
    return out;
}

function readCsLocales(expr: string | undefined): Record<string, LocaleEntry> | undefined {
    if (!expr) return undefined;
    const block = readInitializer(expr, 0);
    if (!block) return undefined;
    const out: Record<string, LocaleEntry> = {};
    for (const pair of splitTopLevel(block.body)) {
        const inner = readInitializer(pair, 0);
        if (!inner) continue;
        const [codeExpr, detailsExpr] = splitTopLevel(inner.body);
        const code = codeExpr === undefined ? undefined : csString(codeExpr);
        const details = detailsExpr === undefined ? null : readInitializer(detailsExpr, 0);
        if (!code || !details) continue;
        const fields = assignments(details.body);
        const name = csString(fields.get("name") ?? "");
        if (name === undefined) continue;
        out[code] = {
            Name: name,
            ShortName: csString(fields.get("shortname") ?? "") ?? "",
            Description: csString(fields.get("description") ?? "") ?? "",
        };
    }
    return Object.keys(out).length > 0 ? out : undefined;
}

// The generated enum wraps the argument onto its own line when the name is long.
const ITEM_TPL_CONST =
    /static\s+readonly\s+MongoId\s+(\w+)\s*=\s*new\s+MongoId\(\s*"([0-9a-f]{24})"\s*\)/g;

export function parseItemTplEnum(source: string): Map<string, string> {
    const map = new Map<string, string>();
    ITEM_TPL_CONST.lastIndex = 0;
    for (let m = ITEM_TPL_CONST.exec(source); m; m = ITEM_TPL_CONST.exec(source)) {
        map.set(m[1]!, m[2]!);
    }
    return map;
}

function csId(
    expr: string | undefined,
    enums: Map<string, string> | undefined,
): string | undefined {
    if (!expr) return undefined;
    const unwrapped = expr.replace(/^new\s+MongoId\s*\(/, "").trim();
    const literal = csString(expr) ?? csString(unwrapped);
    if (literal && MONGO_ID.test(literal)) return literal;
    const named = expr.match(/^ItemTpl\.(\w+)/);
    return (named && enums?.get(named[1]!)) || undefined;
}

function csNumber(expr: string | undefined): number | undefined {
    const n = expr === undefined ? NaN : Number.parseFloat(expr);
    return Number.isFinite(n) ? n : undefined;
}

function csString(expr: string): string | undefined {
    const src = expr.trimStart();
    if (src.startsWith('@"')) {
        let out = "";
        for (let i = 2; i < src.length; i++) {
            if (src[i] === '"') {
                if (src[i + 1] !== '"') return out;
                i++;
            }
            out += src[i];
        }
        return undefined;
    }
    if (!src.startsWith('"')) return undefined;
    let out = "";
    for (let i = 1; i < src.length; i++) {
        const ch = src[i]!;
        if (ch === "\\") {
            const next = src[++i];
            out += next === "n" ? "\n" : next === "t" ? "\t" : (next ?? "");
        } else if (ch === '"') {
            return out;
        } else {
            out += ch;
        }
    }
    return undefined;
}

function readInitializer(src: string, from: number): { body: string; end: number } | null {
    const open = skipToBrace(src, from);
    if (open < 0) return null;
    let depth = 0;
    for (let i = open; i < src.length; i++) {
        const skip = skipNonCode(src, i);
        if (skip > i) {
            i = skip - 1;
            continue;
        }
        const ch = src[i];
        if (ch === "{") depth++;
        else if (ch === "}" && --depth === 0) return { body: src.slice(open + 1, i), end: i + 1 };
    }
    return null;
}

function skipToBrace(src: string, from: number): number {
    for (let i = from; i < src.length; i++) {
        const skip = skipNonCode(src, i);
        if (skip > i) {
            i = skip - 1;
            continue;
        }
        if (src[i] === "{") return i;
        if (!/[\s<>,\w.()[\]]/.test(src[i]!)) return -1;
    }
    return -1;
}

function skipNonCode(src: string, i: number): number {
    const two = src.slice(i, i + 2);
    if (two === "//") {
        const nl = src.indexOf("\n", i);
        return nl < 0 ? src.length : nl;
    }
    if (two === "/*") {
        const close = src.indexOf("*/", i + 2);
        return close < 0 ? src.length : close + 2;
    }
    if (two === '@"') {
        for (let j = i + 2; j < src.length; j++) {
            if (src[j] === '"') {
                if (src[j + 1] !== '"') return j + 1;
                j++;
            }
        }
        return src.length;
    }
    const ch = src[i];
    if (ch === '"' || ch === "'") {
        for (let j = i + 1; j < src.length; j++) {
            if (src[j] === "\\") j++;
            else if (src[j] === ch) return j + 1;
        }
        return src.length;
    }
    return i;
}

/** Without this the comma in `Dictionary<string, LocaleDetails>` reads as a separator. */
function skipGenerics(src: string, i: number): number {
    if (src[i] !== "<" || !/[\w>]/.test(src.slice(0, i).trimEnd().slice(-1))) return i;
    let depth = 0;
    for (let j = i; j < src.length; j++) {
        const ch = src[j]!;
        if (ch === "<") depth++;
        else if (ch === ">") {
            if (--depth === 0) return j + 1;
        } else if (!/[\w\s,.?[\]]/.test(ch)) return i;
    }
    return i;
}

function splitTopLevel(body: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < body.length; i++) {
        const skip = skipNonCode(body, i);
        if (skip > i) {
            i = skip - 1;
            continue;
        }
        const generic = skipGenerics(body, i);
        if (generic > i) {
            i = generic - 1;
            continue;
        }
        const ch = body[i]!;
        if ("{[(".includes(ch)) depth++;
        else if ("}])".includes(ch)) depth--;
        else if (ch === "," && depth === 0) {
            parts.push(body.slice(start, i));
            start = i + 1;
        }
    }
    parts.push(body.slice(start));
    return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

export function parseJsonc(text: string): unknown {
    let out = "";
    for (let i = 0; i < text.length; i++) {
        const two = text.slice(i, i + 2);
        if (two === "//") {
            const nl = text.indexOf("\n", i);
            i = nl < 0 ? text.length : nl - 1;
            continue;
        }
        if (two === "/*") {
            const close = text.indexOf("*/", i + 2);
            i = close < 0 ? text.length : close + 1;
            continue;
        }
        if (text[i] === '"') {
            const end = skipNonCode(text, i);
            out += text.slice(i, end);
            i = end - 1;
            continue;
        }
        out += text[i];
    }
    return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

function pick(obj: Record<string, unknown>, name: string): unknown {
    if (name in obj) return obj[name];
    const lower = name.toLowerCase();
    for (const key of Object.keys(obj)) {
        if (key.toLowerCase() === lower) return obj[key];
    }
    return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
    return typeof value === "string" ? value : undefined;
}

function firstStr(obj: Record<string, unknown>, names: string[]): string | undefined {
    for (const name of names) {
        const value = str(pick(obj, name));
        if (value) return value;
    }
    return undefined;
}

function firstNum(obj: Record<string, unknown>, names: string[]): number | undefined {
    for (const name of names) {
        const value = num(pick(obj, name));
        if (value !== undefined) return value;
    }
    return undefined;
}

function num(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
