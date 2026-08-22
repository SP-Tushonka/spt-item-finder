import { describe, expect, test } from "bun:test";
import {
    parseItemTplEnum,
    parseJsonc,
    scan,
    type ItemCandidate,
    type ModFile,
} from "../src/server/modscan";

function file(path: string, text: string): ModFile {
    return { path, text: async () => text };
}

function byId(candidates: ItemCandidate[], id: string): ItemCandidate {
    const found = candidates.find((c) => c.id === id);
    if (!found) throw new Error(`no candidate ${id}`);
    return found;
}

// Trimmed from WTT-ContentBackport db/CustomItems/ArmorPlate_config_2.json.
const CLONE_JSON = `{
  "6943c85be2f21398e70378cc": {
    "itemTplToClone": "655746010177119f4a097ff7",
    "parentId": "644120aa86ffbe10ee032b6f",
    "handbookParentId": "5b5f704686f77447ec5d76d7",
    "overrideProperties": {
      "Height": 2,
      "Width": 2,
      "Weight": 1.1,
      "ArmorMaterial": "UHMWPE",
      "Prefab": { "path": "assets/plate.bundle", "rcid": "" }
    },
    "locales": {
      "en": {
        "name": "Tac-Kek SAPI Level III+ ballistic plate (Replica)",
        "shortName": "TK SAPI III+",
        "description": "A lightweight non-ballistic replica."
      }
    },
    "fleaPriceRoubles": 5200,
    "handbookPriceRoubles": 4350,
    "addtoTraders": false,
    "traders": {}
  }
}`;

// Trimmed from sp-tarkov/server-mod-examples 18CustomItemService.
const CLONE_CSHARP = `
public Task OnLoadAsync(CancellationToken cancellationToken)
{
    // Example of adding new item by cloning an existing item
    var exampleCloneItem = new NewItemFromCloneDetails
    {
        NewItemName = string.Empty,
        ItemTplToClone = ItemTpl.SHOTGUN_MP18_762X54R_SINGLESHOT_RIFLE,
        ParentId = "5447b6094bdc2dc3278b4567",
        NewId = "677eed5f2e040616bc7246b6",
        FleaPriceRoubles = 50000,
        HandbookPriceRoubles = 42500,
        HandbookParentId = "5b5f78e986f77447ed5636b1",
        Locales = new Dictionary<string, LocaleDetails>
        {
            {
                "en", new LocaleDetails
                {
                    Name = "MP-18 12g",
                    ShortName = "Custom MP18",
                    Description = "A custom MP18 chambered in 12G"
                }
            },
            {
                "fr", new LocaleDetails { Name = "MP-18 12g", ShortName = "MP18", Description = "" }
            }
        },
        OverrideProperties = new TemplateItemProperties
        {
            Chambers =
            [
                new Slot
                {
                    Name = "patron_in_weapon_000",
                    Properties = new SlotProperties { Filters = [ new SlotFilter { Filter = [ "560d5e524bdc2d25448b4571" ] } ] }
                }
            ]
        }
    };
    customItemService.CreateItemFromClone(exampleCloneItem);
    return Task.CompletedTask;
}`;

const ITEM_TPL = `namespace SPTarkov.Server.Core.Models.Enums;

public static class ItemTpl
{
    public static readonly MongoId SHOTGUN_MP18_762X54R_SINGLESHOT_RIFLE = new MongoId("61f7c9e189e6fb1a5e3ea78d");
    public static readonly MongoId ARMOREDEQUIPMENT_DIAMOND_AGE_NEOSTEEL_HELMET_BALLISTIC_MANDIBLE = new MongoId(
        "65719f0775149d62ce0a670b"
    );
}`;

describe("clone-json recognizer", () => {
    test("reads a real CommonLib item record", async () => {
        const result = await scan([file("db/CustomItems/plates.json", CLONE_JSON)]);
        expect(result.verdict).toBe("items");
        expect(result.candidates).toHaveLength(1);

        const item = result.candidates[0]!;
        expect(item.id).toBe("6943c85be2f21398e70378cc");
        expect(item.kind).toBe("clone-json");
        expect(item.cloneOf).toBe("655746010177119f4a097ff7");
        expect(item.parentId).toBe("644120aa86ffbe10ee032b6f");
        expect(item.handbookParentId).toBe("5b5f704686f77447ec5d76d7");
        expect(item.fleaPrice).toBe(5200);
        expect(item.handbookPrice).toBe(4350);
        expect(item.sourcePath).toBe("db/CustomItems/plates.json");
        expect(item.locales?.en).toEqual({
            Name: "Tac-Kek SAPI Level III+ ballistic plate (Replica)",
            ShortName: "TK SAPI III+",
            Description: "A lightweight non-ballistic replica.",
        });
    });

    test("keeps overrideProperties as an unresolved diff", async () => {
        const { candidates } = await scan([file("a.json", CLONE_JSON)]);
        expect(candidates[0]!.props).toEqual({
            Height: 2,
            Width: 2,
            Weight: 1.1,
            ArmorMaterial: "UHMWPE",
            Prefab: { path: "assets/plate.bundle", rcid: "" },
        });
    });

    test("accepts PascalCase keys from C#-serialized JSON", async () => {
        const text = `{ "6943c85be2f21398e70378cc": {
            "ItemTplToClone": "655746010177119f4a097ff7",
            "Locales": { "en": { "Name": "Thing", "ShortName": "Th" } } } }`;
        const { candidates } = await scan([file("a.json", text)]);
        expect(candidates[0]?.cloneOf).toBe("655746010177119f4a097ff7");
        expect(candidates[0]?.locales?.en?.Name).toBe("Thing");
    });

    test("ignores an entry carrying only a clone target", async () => {
        const text = `{ "6943c85be2f21398e70378cc": {
            "itemTplToClone": "655746010177119f4a097ff7", "count": 3 } }`;
        const { candidates, verdict } = await scan([file("db/assort.json", text)]);
        expect(candidates).toHaveLength(0);
        expect(verdict).toBe("no-items");
    });

    test("ignores keys that are not template ids", async () => {
        const text = `{ "someConfigKey": {
            "itemTplToClone": "655746010177119f4a097ff7",
            "overrideProperties": { "Width": 1 } } }`;
        expect((await scan([file("a.json", text)])).candidates).toHaveLength(0);
    });
});

// SamSWAT's Fire Support ships its A-10 and 30mm round in this shape.
const NEW_ITEM_FILE = `{
  "blacklist": { "all": true, "flea": true, "fence": true, "scavCase": true },
  "locales": {
    "en": { "name": "Fairchild Republic A-10 Thunderbolt II", "shortName": "A-10" }
  },
  "newItem": {
    "_id": "660b2d05cec10101410e7d7b",
    "_name": "weapon_ge_gau8_avenger",
    "_parent": "5447bedf4bdc2d87278b4568",
    "_props": { "Weight": 1 }
  }
}`;

describe("NewItemDetails files", () => {
    test("takes the locales and prices sitting beside the template", async () => {
        const text = NEW_ITEM_FILE.replace(`"all": true`, `"all": false`);
        const { candidates } = await scan([file("db/gau8.json", text)]);
        expect(candidates).toHaveLength(1);
        expect(candidates[0]).toMatchObject({
            id: "660b2d05cec10101410e7d7b",
            kind: "database",
            parentId: "5447bedf4bdc2d87278b4568",
        });
        expect(candidates[0]!.locales?.en?.Name).toBe("Fairchild Republic A-10 Thunderbolt II");
    });

    // The mod says it cannot be obtained anywhere, so it is scenery, not an item to index.
    test("skips a template the mod blacklists everywhere", async () => {
        const result = await scan([file("db/gau8.json", NEW_ITEM_FILE)]);
        expect(result.candidates).toHaveLength(0);
        expect(result.verdict).toBe("no-items");
    });

    test("a plain database file is unaffected", async () => {
        const text = `{ "5448fee04bdc2dbc018b4567": {
            "_id": "5448fee04bdc2dbc018b4567", "_parent": "p", "_props": { "Width": 1 } } }`;
        expect((await scan([file("db/items.json", text)])).candidates).toHaveLength(1);
    });
});

describe("slot compatibility declarations", () => {
    async function slotsOf(fields: string): Promise<string[] | undefined> {
        const text = `{ "6943c85be2f21398e70378cc": {
            "itemTplToClone": "655746010177119f4a097ff7",
            "overrideProperties": { "Width": 1 }, ${fields} } }`;
        return (await scan([file("a.json", text)])).candidates[0]?.modSlots;
    }

    // How a modded attachment becomes mountable on a stock weapon.
    test("reads the slots a mod asks to be added to", async () => {
        expect(await slotsOf(`"addtoModSlots": true, "modSlot": ["mod_scope", "mod_muzzle"]`)) //
            .toEqual(["mod_scope", "mod_muzzle"]);
    });

    test("ignores the slot list when the flag is off", async () => {
        expect(await slotsOf(`"addtoModSlots": false, "modSlot": ["mod_scope"]`)).toBeUndefined();
    });

    test("inventory slots come as their own list", async () => {
        expect(await slotsOf(`"addtoInventorySlots": ["Earpiece"]`)).toEqual(["Earpiece"]);
    });

    test("flag-only declarations expand to the slots the server uses", async () => {
        expect(await slotsOf(`"addtoSpecialSlots": true`)).toEqual([
            "SpecialSlot1",
            "SpecialSlot2",
            "SpecialSlot3",
        ]);
        expect(await slotsOf(`"addtoSecureFilters": true`)).toEqual(["SecuredContainer"]);
    });

    test("several declarations merge without duplicates", async () => {
        expect(
            await slotsOf(
                `"addtoModSlots": true, "modSlot": ["Earpiece"], "addtoInventorySlots": ["Earpiece"]`,
            ),
        ).toEqual(["Earpiece"]);
    });

    test("an item declaring none has no slots", async () => {
        expect(await slotsOf(`"fleaPriceRoubles": 100`)).toBeUndefined();
    });
});

describe("database recognizer", () => {
    test("reads a vanilla-shaped template", async () => {
        const text = `{ "5448fee04bdc2dbc018b4567": {
            "_id": "5448fee04bdc2dbc018b4567",
            "_name": "water_bottle",
            "_parent": "5448e8d04bdc2ddf718b4569",
            "_type": "Item",
            "_props": { "Width": 1, "Height": 2 } } }`;
        const { candidates } = await scan([file("db/items/custom.json", text)]);
        expect(candidates[0]).toMatchObject({
            id: "5448fee04bdc2dbc018b4567",
            kind: "database",
            parentId: "5448e8d04bdc2ddf718b4569",
            props: { Width: 1, Height: 2 },
        });
    });

    test("skips a file that dumps the whole vanilla database", async () => {
        const dump: Record<string, unknown> = {};
        for (let i = 0; i < 600; i++) {
            const id = i.toString(16).padStart(24, "0");
            dump[id] = { _id: id, _parent: "5448e8d04bdc2ddf718b4569", _props: {} };
        }
        const result = await scan([file("db/items.json", JSON.stringify(dump))]);
        expect(result.candidates).toHaveLength(0);
        expect(result.skipped).toEqual([
            { path: "db/items.json", reason: "bulk-override", count: 600 },
        ]);
    });
});

// Trimmed from DrakiaXYZ/SPT-GildedKeyStorage-CSharp Resources/config/cases.json.
const CONFIG_JSON = `[
    {
        "name": "golden_key_box",
        "case_type": "container",
        "id": "661cb36922c9e10dc2d9514b",
        "item_name": "Golden Key Box",
        "item_short_name": "Key Box",
        "item_description": "Secure and compact storage for your Golden Keychains.",
        "bundle": "CaseBundles/golden_key_pouch.bundle",
        "flea_price": 3000000,
        "trader": "therapist"
    }
]`;

describe("config-json recognizer", () => {
    test("reads items declared in a mod's own config list", async () => {
        const { candidates, verdict } = await scan([
            file("Resources/config/cases.json", CONFIG_JSON),
        ]);
        expect(verdict).toBe("items");
        expect(candidates).toHaveLength(1);
        expect(candidates[0]).toMatchObject({
            id: "661cb36922c9e10dc2d9514b",
            kind: "config-json",
            fleaPrice: 3000000,
            sourcePath: "Resources/config/cases.json",
        });
        expect(candidates[0]!.locales?.en).toEqual({
            Name: "Golden Key Box",
            ShortName: "Key Box",
            Description: "Secure and compact storage for your Golden Keychains.",
        });
    });

    test("reads the same shape from a keyed map", async () => {
        const text = `{ "goldenKeyBox": ${CONFIG_JSON.slice(1, -1).trim()} }`;
        const { candidates } = await scan([file("config.json", text)]);
        expect(candidates[0]?.id).toBe("661cb36922c9e10dc2d9514b");
    });

    test("a quest entry has an id, name and description but no short name", async () => {
        const text = `[{ "id": "661cb36922c9e10dc2d9514b", "name": "Debut",
            "description": "Eliminate Scavs", "type": "Elimination" }]`;
        const result = await scan([file("db/quests.json", text)]);
        expect(result.candidates).toHaveLength(0);
        expect(result.verdict).toBe("no-items");
    });

    test("a short name alone is not enough", async () => {
        const text = `[{ "id": "661cb36922c9e10dc2d9514b", "short_name": "KB" }]`;
        expect((await scan([file("a.json", text)])).candidates).toHaveLength(0);
    });

    test("ignores entries whose id is not a template id", async () => {
        const text = `[{ "id": "golden_key_box", "item_name": "Golden Key Box",
            "item_short_name": "Key Box" }]`;
        expect((await scan([file("a.json", text)])).candidates).toHaveLength(0);
    });

    test("falls back to the short name when no long name is given", async () => {
        const text = `[{ "id": "661cb36922c9e10dc2d9514b", "shortName": "KB",
            "description": "A box." }]`;
        const { candidates } = await scan([file("a.json", text)]);
        expect(candidates[0]?.locales?.en?.Name).toBe("KB");
    });
});

describe("mod locale files", () => {
    // WTT Content Backport ships db/CustomLocales/{ch,en,ru}.json in the vanilla flat format.
    const RU = `{
        "6943c85be2f21398e70378cc Name": "Бронеплита Tac-Kek",
        "6943c85be2f21398e70378cc ShortName": "ТК",
        "6943c85be2f21398e70378cc Description": "Реплика."
    }`;

    test("fills in a language the item's own record does not declare", async () => {
        const { candidates } = await scan([
            file("db/CustomItems/plates.json", CLONE_JSON),
            file("db/CustomLocales/ru.json", RU),
        ]);
        expect(candidates).toHaveLength(1);
        expect(candidates[0]!.locales?.ru).toEqual({
            Name: "Бронеплита Tac-Kek",
            ShortName: "ТК",
            Description: "Реплика.",
        });
        expect(candidates[0]!.locales?.en?.ShortName).toBe("TK SAPI III+");
    });

    test("takes the language from the filename", async () => {
        const { candidates } = await scan([
            file("db/CustomItems/a.json", CLONE_JSON),
            file("db/CustomLocales/es-mx.JSON", RU),
        ]);
        expect(candidates[0]!.locales?.["es-mx"]?.Name).toBe("Бронеплита Tac-Kek");
    });

    test("an entry beside the item wins over the locale file", async () => {
        const en = `{ "6943c85be2f21398e70378cc Name": "Overwritten" }`;
        const { candidates } = await scan([
            file("db/CustomItems/a.json", CLONE_JSON),
            file("db/CustomLocales/en.json", en),
        ]);
        expect(candidates[0]!.locales?.en?.Name).toBe(
            "Tac-Kek SAPI Level III+ ballistic plate (Replica)",
        );
    });

    // A mod that ships the whole vanilla locale file must not add 40k names.
    test("translations for items the mod does not add are dropped", async () => {
        const bulk = `{
            "5448fee04bdc2dbc018b4567 Name": "Water bottle",
            "6943c85be2f21398e70378cc Name": "Mine"
        }`;
        const { candidates } = await scan([
            file("db/CustomItems/a.json", CLONE_JSON),
            file("db/CustomLocales/de.json", bulk),
        ]);
        expect(candidates).toHaveLength(1);
        expect(candidates[0]!.locales?.de?.Name).toBe("Mine");
    });

    test("a locale file yields no items of its own", async () => {
        const result = await scan([file("db/CustomLocales/ru.json", RU)]);
        expect(result.candidates).toHaveLength(0);
        expect(result.verdict).toBe("no-items");
        expect(result.skipped).toHaveLength(0);
    });

    test("an ordinary item file is not mistaken for a locale table", async () => {
        const { candidates } = await scan([file("db/CustomItems/a.json", CLONE_JSON)]);
        expect(candidates).toHaveLength(1);
    });
});

describe("clone-csharp recognizer", () => {
    const enums = parseItemTplEnum(ITEM_TPL);

    test("reads the official CustomItemService example", async () => {
        const { candidates } = await scan([file("CustomItemExample.cs", CLONE_CSHARP)], enums);
        expect(candidates).toHaveLength(1);
        expect(candidates[0]).toMatchObject({
            id: "677eed5f2e040616bc7246b6",
            kind: "clone-csharp",
            cloneOf: "61f7c9e189e6fb1a5e3ea78d",
            parentId: "5447b6094bdc2dc3278b4567",
            handbookParentId: "5b5f78e986f77447ed5636b1",
            fleaPrice: 50000,
            handbookPrice: 42500,
        });
    });

    test("reads every locale in the dictionary", async () => {
        const { candidates } = await scan([file("a.cs", CLONE_CSHARP)], enums);
        expect(candidates[0]!.locales).toEqual({
            en: {
                Name: "MP-18 12g",
                ShortName: "Custom MP18",
                Description: "A custom MP18 chambered in 12G",
            },
            fr: { Name: "MP-18 12g", ShortName: "MP18", Description: "" },
        });
    });

    test("leaves OverrideProperties unextracted rather than half-parsed", async () => {
        const { candidates } = await scan([file("a.cs", CLONE_CSHARP)], enums);
        expect(candidates[0]!.props).toBeUndefined();
    });

    test("takes a raw id or a MongoId wrapper without the enum table", async () => {
        const source = `new NewItemFromCloneDetails {
            NewId = new MongoId("677eed5f2e040616bc7246b6"),
            ItemTplToClone = "61f7c9e189e6fb1a5e3ea78d" }`;
        const { candidates } = await scan([file("a.cs", source)]);
        expect(candidates[0]).toMatchObject({
            id: "677eed5f2e040616bc7246b6",
            cloneOf: "61f7c9e189e6fb1a5e3ea78d",
        });
    });

    test("skips an item whose id the server would randomise", async () => {
        const source = `new NewItemFromCloneDetails {
            ItemTplToClone = ItemTpl.SHOTGUN_MP18_762X54R_SINGLESHOT_RIFLE,
            ParentId = "5447b6094bdc2dc3278b4567" }`;
        const result = await scan([file("Mod.cs", source)], enums);
        expect(result.candidates).toHaveLength(0);
        expect(result.skipped).toEqual([{ path: "Mod.cs", reason: "no-stable-id" }]);
        expect(result.verdict).toBe("items-unextractable");
    });

    // GildedKeyStorage builds a case per config entry, so the id is never a literal.
    test("separates an id built at runtime from a missing one", async () => {
        const source = `new NewItemFromCloneDetails {
            ItemTplToClone = itemToCloneTpl,
            NewId = newCase.Id,
            HandbookParentId = HANDBOOK_GEARCASES }`;
        const result = await scan([file("Mod.cs", source)], enums);
        expect(result.skipped).toEqual([{ path: "Mod.cs", reason: "dynamic-id" }]);
        expect(result.verdict).toBe("items-unextractable");
    });

    test("braces inside strings and comments do not end the initializer", async () => {
        const source = `new NewItemFromCloneDetails {
            NewId = "677eed5f2e040616bc7246b6",
            // } this brace is a comment
            NewItemName = "a } brace and a \\" quote",
            Note = @"verbatim } with ""doubled"" quotes",
            ItemTplToClone = "61f7c9e189e6fb1a5e3ea78d"
        };
        var after = 1;`;
        const { candidates } = await scan([file("a.cs", source)]);
        expect(candidates[0]?.cloneOf).toBe("61f7c9e189e6fb1a5e3ea78d");
    });

    test("finds several declarations in one file", async () => {
        const one = `new NewItemFromCloneDetails { NewId = "677eed5f2e040616bc7246b6" }`;
        const two = `new NewItemDetails { NewId = "5448fee04bdc2dbc018b4567" }`;
        const { candidates } = await scan([file("a.cs", `${one};\n${two};`)]);
        expect(candidates.map((c) => c.id)).toEqual([
            "677eed5f2e040616bc7246b6",
            "5448fee04bdc2dbc018b4567",
        ]);
    });

    test("an unknown ItemTpl constant leaves the clone target unresolved", async () => {
        const source = `new NewItemFromCloneDetails {
            NewId = "677eed5f2e040616bc7246b6", ItemTplToClone = ItemTpl.NOT_IN_THIS_BRANCH }`;
        const { candidates } = await scan([file("a.cs", source)], enums);
        expect(candidates[0]?.cloneOf).toBeUndefined();
    });
});

describe("parseItemTplEnum", () => {
    test("reads both inline and line-wrapped declarations", () => {
        const map = parseItemTplEnum(ITEM_TPL);
        expect(map.size).toBe(2);
        expect(map.get("SHOTGUN_MP18_762X54R_SINGLESHOT_RIFLE")).toBe("61f7c9e189e6fb1a5e3ea78d");
        expect(map.get("ARMOREDEQUIPMENT_DIAMOND_AGE_NEOSTEEL_HELMET_BALLISTIC_MANDIBLE")).toBe(
            "65719f0775149d62ce0a670b",
        );
    });
});

describe("parseJsonc", () => {
    test("tolerates comments and trailing commas", () => {
        const text = `{
            // leading comment
            "a": 1, /* inline */ "b": [1, 2,],
        }`;
        expect(parseJsonc(text)).toEqual({ a: 1, b: [1, 2] });
    });

    test("leaves comment-like text inside strings alone", () => {
        expect(parseJsonc(`{ "path": "assets//content/item.bundle" }`)).toEqual({
            path: "assets//content/item.bundle",
        });
    });
});

describe("scan", () => {
    test("ignores files that are neither json nor cs", async () => {
        const result = await scan([file("README.md", CLONE_JSON), file("item.bundle", CLONE_JSON)]);
        expect(result.candidates).toHaveLength(0);
        expect(result.verdict).toBe("no-items");
    });

    test("records unparseable json instead of throwing", async () => {
        const result = await scan([file("db/broken.json", "{ not json")]);
        expect(result.skipped).toEqual([{ path: "db/broken.json", reason: "unparseable" }]);
    });

    test("a config-only mod reports no items", async () => {
        const result = await scan([
            file("config/config.json", `{ "enabled": true, "multiplier": 1.5 }`),
            file("Mod.cs", `public class Mod { public void OnLoad() { } }`),
        ]);
        expect(result.verdict).toBe("no-items");
        expect(result.skipped).toHaveLength(0);
    });

    test("mixed sources are all attributed to their file", async () => {
        const result = await scan(
            [file("db/CustomItems/a.json", CLONE_JSON), file("src/Mod.cs", CLONE_CSHARP)],
            parseItemTplEnum(ITEM_TPL),
        );
        expect(result.candidates).toHaveLength(2);
        expect(byId(result.candidates, "6943c85be2f21398e70378cc").sourcePath).toBe(
            "db/CustomItems/a.json",
        );
        expect(byId(result.candidates, "677eed5f2e040616bc7246b6").sourcePath).toBe("src/Mod.cs");
    });
});
