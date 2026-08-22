import { getJson, USER_AGENT } from "./http";
import { compareVersions, targetsSptVersion } from "./semver";

export interface SourceLink {
    url: string;
    label: string;
}

export interface ForgeVersion {
    id: number;
    version: string;
    link: string;
    sptConstraint: string;
    contentLength: number | null;
    description: string;
    updatedAt: string;
}

export interface ForgeMod {
    id: number;
    guid: string | null;
    name: string;
    slug: string;
    detailUrl: string;
    downloads: number;
    category: string | null;
    owner: string | null;
    updatedAt: string;
    sourceLinks: SourceLink[];
    bindsProfile: boolean;
    versions: ForgeVersion[];
}

export interface ForgePage {
    mods: ForgeMod[];
    lastPage: number;
    total: number;
}

export interface ForgeApi {
    page(query: Record<string, string>, page: number): Promise<ForgePage | null>;
}

export interface ModGate {
    minDownloads: number;
    sptVersions: string[];
}

export const DEFAULT_GATE: ModGate = { minDownloads: 2000, sptVersions: ["4.0", "4.1"] };

export interface GatedMod {
    mod: ForgeMod;
    versionByLine: Record<string, ForgeVersion>;
}

export function selectVersion(mod: ForgeMod, sptVersion: string): ForgeVersion | null {
    const eligible = mod.versions.filter((version) =>
        targetsSptVersion(version.sptConstraint, sptVersion),
    );
    if (eligible.length === 0) return null;
    return eligible.reduce((best, version) =>
        compareVersions(version.version, best.version) > 0 ? version : best,
    );
}

export function gateMod(mod: ForgeMod, gate: ModGate = DEFAULT_GATE): GatedMod | null {
    if (mod.downloads < gate.minDownloads) return null;
    const versionByLine: Record<string, ForgeVersion> = {};
    for (const sptVersion of gate.sptVersions) {
        const version = selectVersion(mod, sptVersion);
        if (version) versionByLine[sptVersion] = version;
    }
    return Object.keys(versionByLine).length > 0 ? { mod, versionByLine } : null;
}

export function gateMods(mods: ForgeMod[], gate: ModGate = DEFAULT_GATE): GatedMod[] {
    return mods.flatMap((mod) => gateMod(mod, gate) ?? []);
}

export function updatedBetweenQuery(since: string, until: string): Record<string, string> {
    return { "filter[updated_between]": `${day(since)},${day(until)}` };
}

function day(value: string): string {
    return value.slice(0, 10);
}

export interface Listing {
    mods: ForgeMod[];
    /** A listing that lost a page is no evidence the mods it missed are gone. */
    complete: boolean;
    total: number;
}

export async function listMods(
    api: ForgeApi,
    query: Record<string, string> = {},
    onProgress: (page: number, lastPage: number) => void = () => {},
): Promise<Listing> {
    const mods: ForgeMod[] = [];
    let page = 1;
    let lastPage = 1;
    let total = 0;
    do {
        const body = await api.page(query, page);
        if (!body) return { mods, complete: false, total };
        mods.push(...body.mods);
        lastPage = body.lastPage;
        total = body.total;
        onProgress(page, lastPage);
        page++;
    } while (page <= lastPage);

    return { mods, complete: mods.length >= total, total };
}

const PER_PAGE = "50";

export class Forge implements ForgeApi {
    constructor(
        private baseUrl = "https://sp-mod.com/api/v0",
        private userAgent = USER_AGENT,
    ) {}

    async page(query: Record<string, string>, page: number): Promise<ForgePage | null> {
        const params = new URLSearchParams({
            ...query,
            include: "versions,source_code_links",
            per_page: PER_PAGE,
            page: String(page),
        });
        const body = await getJson<RawList>(`${this.baseUrl}/mods?${params}`, {
            headers: { Accept: "application/json", "User-Agent": this.userAgent },
        });
        if (!body?.success || !Array.isArray(body.data)) return null;
        return {
            mods: body.data.map(toMod),
            lastPage: body.meta?.last_page ?? page,
            total: body.meta?.total ?? body.data.length,
        };
    }
}

interface RawList {
    success?: boolean;
    data?: RawMod[];
    meta?: { last_page?: number; total?: number };
}

interface RawMod {
    id: number;
    guid?: string | null;
    name?: string;
    slug?: string;
    detail_url?: string;
    downloads?: number;
    updated_at?: string;
    category?: { title?: string } | null;
    owner?: { name?: string } | null;
    source_code_links?: { url?: string; label?: string }[] | null;
    shows_profile_binding_notice?: boolean;
    versions?: RawVersion[];
}

interface RawVersion {
    id: number;
    version?: string;
    link?: string;
    spt_version_constraint?: string | null;
    content_length?: number | null;
    description?: string | null;
    updated_at?: string;
}

function toMod(raw: RawMod): ForgeMod {
    return {
        id: raw.id,
        guid: raw.guid ?? null,
        name: raw.name ?? "",
        slug: raw.slug ?? "",
        detailUrl: raw.detail_url ?? "",
        downloads: raw.downloads ?? 0,
        category: raw.category?.title ?? null,
        owner: raw.owner?.name ?? null,
        updatedAt: raw.updated_at ?? "",
        sourceLinks: (raw.source_code_links ?? [])
            .filter((link): link is { url: string; label?: string } => !!link.url)
            .map((link) => ({ url: link.url, label: (link.label ?? "").trim() })),
        bindsProfile: raw.shows_profile_binding_notice === true,
        versions: (raw.versions ?? []).map(toVersion),
    };
}

function toVersion(raw: RawVersion): ForgeVersion {
    return {
        id: raw.id,
        version: raw.version ?? "",
        link: raw.link ?? "",
        sptConstraint: raw.spt_version_constraint ?? "",
        contentLength: raw.content_length ?? null,
        description: raw.description ?? "",
        updatedAt: raw.updated_at ?? "",
    };
}
