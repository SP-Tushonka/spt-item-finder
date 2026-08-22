import type { Item } from "../shared/types";
import type { CandidateKind, ItemCandidate } from "./modscan";

export type Fidelity = "exact" | "resolved" | "inherited" | "unresolved";

export interface ResolvedItem {
    item: Item | null;
    fidelity: Fidelity;
    cloneOf: string | null;
}

export type VanillaLookup = (id: string) => Item | null;

const FIDELITY_BY_KIND: Record<CandidateKind, Fidelity> = {
    database: "exact",
    "clone-json": "resolved",
    "clone-csharp": "inherited",
    "config-json": "unresolved",
};

export function resolveItem(candidate: ItemCandidate, lookup: VanillaLookup): ResolvedItem {
    const cloneOf = candidate.cloneOf ?? null;

    if (candidate.kind === "database") {
        return {
            item: toItem(candidate, candidate.props ?? {}, candidate.parentId ?? ""),
            fidelity: "exact",
            cloneOf,
        };
    }

    const base = cloneOf ? lookup(cloneOf) : null;
    if (!base) return { item: null, fidelity: "unresolved", cloneOf };

    const props =
        candidate.kind === "clone-json"
            ? (merge(base._props, candidate.props ?? {}) as Record<string, unknown>)
            : base._props;

    return {
        item: {
            ...toItem(candidate, props, candidate.parentId ?? base._parent),
            _name: base._name,
            _proto: base._proto,
        },
        fidelity: FIDELITY_BY_KIND[candidate.kind],
        cloneOf,
    };
}

export function resolveAll(
    candidates: ItemCandidate[],
    vanilla: VanillaLookup,
): Map<string, ResolvedItem> {
    const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
    const done = new Map<string, ResolvedItem>();
    const inFlight = new Set<string>();

    const lookup: VanillaLookup = (id) => {
        const base = vanilla(id);
        if (base) return base;
        const candidate = byId.get(id);
        if (!candidate || inFlight.has(id)) return null;
        return resolve(candidate).item;
    };

    function resolve(candidate: ItemCandidate): ResolvedItem {
        const cached = done.get(candidate.id);
        if (cached) return cached;
        inFlight.add(candidate.id);
        const resolved = resolveItem(candidate, lookup);
        inFlight.delete(candidate.id);
        done.set(candidate.id, resolved);
        return resolved;
    }

    for (const candidate of candidates) resolve(candidate);
    return done;
}

function toItem(candidate: ItemCandidate, props: Record<string, unknown>, parent: string): Item {
    return {
        _id: candidate.id,
        _name: candidate.locales?.en?.Name ?? candidate.id,
        _parent: parent,
        _type: "Item",
        _props: props,
    };
}

interface SlotShape {
    _name?: string;
    _props?: { filters?: { Filter?: string[] }[] };
}

export interface SlotAddition {
    id: string;
    modId: number;
    mod: string;
}

export function applySlotAdditions(
    item: Item,
    bySlot: Map<string, SlotAddition[]>,
): { item: Item; added: Record<string, string> } {
    const slots = item._props.Slots;
    if (bySlot.size === 0 || !Array.isArray(slots)) return { item, added: {} };

    const added: Record<string, string> = {};
    let patched: Item | null = null;
    slots.forEach((slot: SlotShape, index) => {
        const extra = slot?._name ? bySlot.get(slot._name) : undefined;
        const filter = slot?._props?.filters?.[0]?.Filter;
        if (!extra || !Array.isArray(filter)) return;
        const missing = extra.filter((addition) => !filter.includes(addition.id));
        if (missing.length === 0) return;

        // Copied lazily so the parsed vanilla snapshot is never mutated.
        patched ??= structuredClone(item);
        const target = (patched._props.Slots as SlotShape[])[index]!;
        target._props!.filters![0]!.Filter = [...filter, ...missing.map((a) => a.id)];
        for (const addition of missing) added[addition.id] = addition.mod;
    });
    return { item: patched ?? item, added };
}

/** Arrays replace wholesale: an override listing Slots means "these are the slots". */
export function merge(base: unknown, patch: unknown): unknown {
    if (!isRecord(base) || !isRecord(patch)) return patch;
    const out: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(patch)) {
        out[key] = key in out ? merge(out[key], value) : value;
    }
    return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
