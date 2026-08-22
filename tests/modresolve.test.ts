import { describe, expect, test } from "bun:test";
import type { Item } from "../src/shared/types";
import {
    applySlotAdditions,
    merge,
    resolveAll,
    resolveItem,
    type VanillaLookup,
} from "../src/server/modresolve";
import type { ItemCandidate } from "../src/server/modscan";

const CLONE_TARGET = "655746010177119f4a097ff7";
const NEW_ID = "6943c85be2f21398e70378cc";

const VANILLA: Item = {
    _id: CLONE_TARGET,
    _name: "plate_sapi_iii",
    _parent: "644120aa86ffbe10ee032b6f",
    _type: "Item",
    _props: {
        Width: 1,
        Height: 1,
        Weight: 3.2,
        ArmorMaterial: "Ceramic",
        Prefab: { path: "assets/plate.bundle", rcid: "" },
        Slots: [{ _name: "mod_a" }],
    },
};

const lookup: VanillaLookup = (id) => (id === CLONE_TARGET ? VANILLA : null);
const missing: VanillaLookup = () => null;

function candidate(overrides: Partial<ItemCandidate> = {}): ItemCandidate {
    return {
        id: NEW_ID,
        kind: "clone-json",
        sourcePath: "db/CustomItems/a.json",
        cloneOf: CLONE_TARGET,
        parentId: "644120aa86ffbe10ee032b6f",
        props: { Width: 2, Weight: 1.1 },
        locales: { en: { Name: "Tac-Kek SAPI", ShortName: "TK", Description: "" } },
        ...overrides,
    };
}

describe("resolveItem", () => {
    test("merges a clone override onto the vanilla template", () => {
        const { item, fidelity } = resolveItem(candidate(), lookup);
        expect(fidelity).toBe("resolved");
        expect(item?._props).toEqual({
            Width: 2,
            Height: 1,
            Weight: 1.1,
            ArmorMaterial: "Ceramic",
            Prefab: { path: "assets/plate.bundle", rcid: "" },
            Slots: [{ _name: "mod_a" }],
        });
        expect(item?._id).toBe(NEW_ID);
    });

    test("a full template needs no clone target", () => {
        const full = candidate({ kind: "database", cloneOf: undefined, props: { Width: 5 } });
        const { item, fidelity } = resolveItem(full, missing);
        expect(fidelity).toBe("exact");
        expect(item?._props).toEqual({ Width: 5 });
    });

    test("a C# clone inherits the target untouched", () => {
        const cs = candidate({ kind: "clone-csharp", props: undefined });
        const { item, fidelity } = resolveItem(cs, lookup);
        expect(fidelity).toBe("inherited");
        expect(item?._props).toEqual(VANILLA._props);
    });

    // Expected under one shared vanilla snapshot: a 4.0 clone target dropped from the newer sptVersion.
    test("a clone target outside the snapshot is unresolved, not wrong", () => {
        const { item, fidelity, cloneOf } = resolveItem(candidate(), missing);
        expect(fidelity).toBe("unresolved");
        expect(item).toBeNull();
        expect(cloneOf).toBe(CLONE_TARGET);
    });

    test("a config-declared item has no properties to resolve", () => {
        const config = candidate({ kind: "config-json", cloneOf: undefined, props: undefined });
        expect(resolveItem(config, lookup).fidelity).toBe("unresolved");
    });

    test("the mod's parent wins over the clone target's", () => {
        const moved = candidate({ parentId: "5448e8d04bdc2ddf718b4569" });
        expect(resolveItem(moved, lookup).item?._parent).toBe("5448e8d04bdc2ddf718b4569");
    });

    test("falls back to the clone target's parent when the mod declares none", () => {
        const noParent = candidate({ parentId: undefined });
        expect(resolveItem(noParent, lookup).item?._parent).toBe(VANILLA._parent);
    });

    test("does not mutate the vanilla template", () => {
        resolveItem(candidate(), lookup);
        expect(VANILLA._props.Width).toBe(1);
    });
});

describe("resolveAll", () => {
    const OWN = "69cfe095b96c8e8d3e002aa3";

    // Both unresolved items in WTT Content Backport turned out to be this: a variant cloning
    // another item the same mod adds.
    test("resolves an item cloning another item from the same mod", () => {
        const base = candidate({ id: OWN, props: { Width: 3 } });
        const variant = candidate({ id: NEW_ID, cloneOf: OWN, props: { Height: 4 } });

        const resolved = resolveAll([variant, base], lookup);
        expect(resolved.get(NEW_ID)?.fidelity).toBe("resolved");
        expect(resolved.get(NEW_ID)?.item?._props).toMatchObject({ Width: 3, Height: 4 });
    });

    test("resolves regardless of declaration order", () => {
        const base = candidate({ id: OWN, props: { Width: 3 } });
        const variant = candidate({ id: NEW_ID, cloneOf: OWN, props: { Height: 4 } });
        expect(resolveAll([base, variant], lookup).get(NEW_ID)?.fidelity).toBe("resolved");
    });

    test("a clone cycle is unresolved rather than infinite", () => {
        const first = candidate({ id: NEW_ID, cloneOf: OWN });
        const second = candidate({ id: OWN, cloneOf: NEW_ID });
        const resolved = resolveAll([first, second], missing);
        expect(resolved.get(NEW_ID)?.fidelity).toBe("unresolved");
        expect(resolved.get(OWN)?.fidelity).toBe("unresolved");
    });

    test("still resolves plain vanilla clones", () => {
        expect(resolveAll([candidate()], lookup).get(NEW_ID)?.fidelity).toBe("resolved");
    });
});

describe("merge", () => {
    test("merges nested objects", () => {
        expect(merge({ a: { b: 1, c: 2 } }, { a: { c: 3 } })).toEqual({ a: { b: 1, c: 3 } });
    });

    // An override listing Slots means "these are the slots", not "add to the clone target's".
    test("replaces arrays wholesale", () => {
        expect(merge({ Slots: [1, 2, 3] }, { Slots: [9] })).toEqual({ Slots: [9] });
    });

    test("keeps keys the patch does not mention", () => {
        expect(merge({ a: 1, b: 2 }, { b: 3 })).toEqual({ a: 1, b: 3 });
    });

    test("a null override clears the value", () => {
        expect(merge({ a: 1 }, { a: null })).toEqual({ a: null });
    });
});

interface SlotRow {
    _props: { filters: { Filter: string[] }[] };
}

describe("applySlotAdditions", () => {
    const MOD_ITEM = "6943c85be2f21398e70378cc";
    const MOD_NAME = "WTT - Content Backport";
    const from = (...ids: string[]) => ids.map((id) => ({ id, modId: 2512, mod: MOD_NAME }));

    function weapon(): Item {
        return {
            _id: "5447a9cd4bdc2dbd208b4567",
            _name: "weapon_m4a1",
            _parent: "5447b5f14bdc2d61278b4567",
            _type: "Item",
            _props: {
                Slots: [
                    { _name: "mod_scope", _props: { filters: [{ Filter: ["aaa"] }] } },
                    { _name: "mod_stock", _props: { filters: [{ Filter: ["bbb"] }] } },
                ],
            },
        };
    }

    test("adds a modded item to the vanilla slot its mod targets", () => {
        const { item, added } = applySlotAdditions(
            weapon(),
            new Map([["mod_scope", from(MOD_ITEM)]]),
        );
        const slots = item._props.Slots as SlotRow[];
        expect(slots[0]!._props.filters[0]!.Filter).toEqual(["aaa", MOD_ITEM]);
        expect(slots[1]!._props.filters[0]!.Filter).toEqual(["bbb"]);
    });

    // The UI names the source rather than saying "a mod".
    test("reports which mod contributed each id", () => {
        const { added } = applySlotAdditions(weapon(), new Map([["mod_scope", from(MOD_ITEM)]]));
        expect(added).toEqual({ [MOD_ITEM]: MOD_NAME });
    });

    test("leaves the item alone when nothing targets its slots", () => {
        const original = weapon();
        expect(applySlotAdditions(original, new Map([["mod_muzzle", from(MOD_ITEM)]])).item) //
            .toBe(original);
        expect(applySlotAdditions(original, new Map()).item).toBe(original);
    });

    // The parsed snapshot is shared by every request, so patching must never write to it.
    test("does not mutate the vanilla item it was given", () => {
        const original = weapon();
        applySlotAdditions(original, new Map([["mod_scope", from(MOD_ITEM)]]));
        const slots = original._props.Slots as SlotRow[];
        expect(slots[0]!._props.filters[0]!.Filter).toEqual(["aaa"]);
    });

    test("does not add an id the slot already lists", () => {
        const original = weapon();
        const result = applySlotAdditions(original, new Map([["mod_scope", from("aaa")]]));
        expect(result.item).toBe(original);
        expect(result.added).toEqual({});
    });

    test("tolerates an item with no slots", () => {
        const bottle: Item = {
            _id: "x",
            _name: "bottle",
            _parent: "p",
            _type: "Item",
            _props: { Width: 1 },
        };
        expect(applySlotAdditions(bottle, new Map([["mod_scope", from(MOD_ITEM)]])).item) //
            .toBe(bottle);
    });
});
