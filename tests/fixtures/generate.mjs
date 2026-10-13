// Deterministic generator for the test data sets of compendium-json-importer.
//
//   node tests/fixtures/generate.mjs        (re-writes the files next to this script)
//
// Sets written here (pure Node, no Foundry):
//   formats/*                 C9, C10   same 3 items in every supported shape, plus broken files
//   conformity-items.json     C18-C20, M8
//   conformity-actors.json    C18-C20, M8
//   conformity-expected.json  ground truth of the two files above (one record per document)
//   legacy-3x.json            C19, M9   dnd5e 3.x documents (_stats.systemVersion 3.3.1)
//   id-conflicts.json         C22       small item set whose _id values are shared with a seeded pack
//   activity-links.json       C23       item whose activity points to an effect by id
//
// Sets built at run time inside Foundry (they need the dnd5e compendium packs) live in
// tests/integration/helpers.mjs: sample-20 (M3) and items-500 (M4).
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/** Deterministic 16-character id generator (Foundry id format). */
export function makeIdGen(seed = 1) {
  let state = seed >>> 0 || 1;
  return () => {
    let id = "";
    for (let i = 0; i < 16; i++) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      id += ALPHABET[(state >>> 24) % ALPHABET.length];
    }
    return id;
  };
}

const STATS_CURRENT = { systemId: "dnd5e", systemVersion: "6.0.6", coreVersion: "14.369" };
const STATS_3X = { systemId: "dnd5e", systemVersion: "3.3.1", coreVersion: "12.331" };

// ---------------------------------------------------------------- formats (C9, C10)

export const FORMAT_ITEM_NAMES = ["Format Sword", "Format Potion", "Format Amulet"];

function formatItems() {
  const id = makeIdGen(11);
  return [
    { _id: id(), name: FORMAT_ITEM_NAMES[0], type: "weapon", img: "icons/svg/sword.svg", system: {}, effects: [], flags: {} },
    { _id: id(), name: FORMAT_ITEM_NAMES[1], type: "consumable", img: "icons/svg/aura.svg", system: {}, effects: [], flags: {} },
    { _id: id(), name: FORMAT_ITEM_NAMES[2], type: "loot", img: "icons/svg/mystery-man.svg", system: {}, effects: [], flags: {} }
  ];
}

/** @returns {Record<string, string>} file name to content */
export function buildFormats() {
  const items = formatItems();
  const json = (value) => JSON.stringify(value, null, 2);
  return {
    "items.db": items.map((i) => JSON.stringify(i)).join("\n") + "\n",
    "items-crlf.db": items.map((i) => JSON.stringify(i)).join("\r\n") + "\r\n",
    "array.json": json(items),
    "entries.json": json({ type: "Item", label: "Format set", name: "format-set", entries: items }),
    "documents.json": json({ documents: items }),
    "items-key.json": json({ items }),
    "data.json": json({ data: items }),
    "array-bom.json": "﻿" + json(items),
    "mixed-types.json": json([
      ...items,
      { _id: makeIdGen(12)(), name: "Format Journal", pages: [], flags: {} }
    ]),
    "empty.json": "",
    "whitespace.json": "  \n \n",
    "broken.json": '{ "entries": [ { "name": "x" ',
    "broken-line.db": [JSON.stringify(items[0]), "{ not json", JSON.stringify(items[1])].join("\n") + "\n",
    "empty-object.json": "{}",
    "empty-array.json": "[]",
    "empty-entries.json": json({ entries: [] })
  };
}

// ---------------------------------------------------------------- conformity (C18-C20, M8)

const DEFECTS = {
  unknownType: "type inconnu",
  invalidValue: "valeur invalide dans system",
  droppedField: "champ system inconnu sur un document a jour",
  unknownActivityType: "activite de type inconnu",
  nestedUnknownType: "objet imbrique de type inconnu",
  nestedInvalid: "objet ou effet imbrique invalide",
  itemsNotArray: "items n'est pas un tableau",
  systemNotObject: "system n'est pas un objet"
};

function item(id, name, type, system = {}, extra = {}) {
  return { _id: id(), name, type, img: "icons/svg/item-bag.svg", system, effects: [], flags: {}, _stats: { ...STATS_CURRENT }, ...extra };
}

function actor(id, name, type, system = {}, items = [], extra = {}) {
  return { _id: id(), name, type, img: "icons/svg/mystery-man.svg", system, items, effects: [], flags: {}, _stats: { ...STATS_CURRENT }, ...extra };
}

function attackActivity(id) {
  const _id = id();
  return { _id, type: "attack", name: "Strike", activation: { type: "action", value: 1 } };
}

function withoutStats(doc) {
  const copy = structuredClone(doc);
  delete copy._stats;
  return copy;
}

function effect(id, name, extra = {}) {
  return { _id: id(), name, img: "icons/svg/aura.svg", changes: [], disabled: false, transfer: true, ...extra };
}

/**
 * Builds the conformity sets. Conforming documents are written to be valid in dnd5e 6; the expected.json
 * is the ground truth that integration tests compare the analysis with.
 */
export function buildConformity() {
  const id = makeIdGen(40);
  const records = [];
  const track = (doc, documentName, conform, defect = null) => {
    records.push({ name: doc.name, documentName, type: doc.type, conform, defect });
    return doc;
  };

  // ---- Items, conforming (22)
  const ok = (doc) => track(doc, "Item", true);
  const act = attackActivity(id);
  const actArray = attackActivity(id);
  const items = [
    ok(item(id, "Ok Longsword", "weapon", { quantity: 1, weight: { value: 3, units: "lb" }, price: { value: 15, denomination: "gp" } })),
    ok(item(id, "Ok Dagger", "weapon", { quantity: 3 })),
    ok(item(id, "Ok Longsword Active", "weapon", { quantity: 1, activities: { [act._id]: act } })),
    ok(item(id, "Ok Shortbow Array Activities", "weapon", { quantity: 1, activities: [actArray] })),
    ok(item(id, "Ok Chain Shirt", "equipment", { quantity: 1, armor: { value: 13 } })),
    ok(item(id, "Ok Shield", "equipment", { quantity: 1 })),
    ok(item(id, "Ok Healing Potion", "consumable", { quantity: 2 })),
    ok(item(id, "Ok Arrows", "consumable", { quantity: 20 })),
    ok(item(id, "Ok Thieves Tools", "tool", { quantity: 1 })),
    ok(item(id, "Ok Lute", "tool", {})),
    ok(item(id, "Ok Gemstone", "loot", { quantity: 5, price: { value: 50, denomination: "gp" } })),
    ok(item(id, "Ok Rope", "loot", { weight: { value: 10, units: "lb" } })),
    ok(item(id, "Ok Backpack", "container", {})),
    ok(item(id, "Ok Legacy Backpack Alias", "backpack", {})),
    ok(item(id, "Ok Fire Bolt", "spell", { level: 0 })),
    ok(item(id, "Ok Fireball", "spell", { level: 3, school: "evo" })),
    ok(item(id, "Ok Second Wind", "feat", {})),
    ok(item(id, "Ok Darkvision", "feat", { description: { value: "<p>See in the dark.</p>" } })),
    ok(item(id, "Ok Glowing Ring", "equipment", { quantity: 1 }, { effects: [effect(id, "Glow")] })),
    ok(withoutStats(item(id, "Ok Plain Tool File Item", "tool", {}))),
    ok(withoutStats(item(id, "Ok Plain Weapon File Item", "weapon", { quantity: 1 }))),
    ok(withoutStats(item(id, "Ok Plain Feat File Item", "feat", {})))
  ];

  // ---- Items, non conforming (9). All carry _stats.systemVersion 6.0.6 (up to date).
  const bad = (doc, defect) => track(doc, "Item", false, defect);
  items.push(
    bad(item(id, "Bad Unknown Item Type", "weapon2", {}), "unknownType"),
    bad(item(id, "Bad Quantity Text", "loot", { quantity: "beaucoup" }), "invalidValue"),
    bad(item(id, "Bad Weight Text", "loot", { weight: { value: "lourd", units: "lb" } }), "invalidValue"),
    bad(item(id, "Bad Spell Level", "spell", { level: "haut" }), "invalidValue"),
    bad(item(id, "Bad Extra Field", "weapon", { quantity: 1, foo: "bar" }), "droppedField"),
    bad(item(id, "Bad Activity Type", "weapon", {
      activities: { zapzapzapzap0001: { _id: "zapzapzapzap0001", type: "zap" } }
    }), "unknownActivityType"),
    bad(item(id, "Bad System String", "loot", "oops"), "systemNotObject"),
    bad(item(id, "Bad Effect Duration", "equipment", {}, {
      effects: [effect(id, "Broken effect", { duration: { units: "fortnights" } })]
    }), "nestedInvalid"),
    bad(item(id, "Bad Uses Spent", "consumable", { uses: { spent: "beaucoup", max: "3" } }), "invalidValue")
  );

  // ---- Actors, conforming (10)
  const okA = (doc) => track(doc, "Actor", true);
  const actors = [
    okA(actor(id, "Ok Goblin", "npc", { abilities: { str: { value: 8 }, dex: { value: 14 } }, attributes: { hp: { value: 7, max: 7 } }, details: { cr: 0.25 } })),
    okA(actor(id, "Ok Ogre", "npc", { abilities: { str: { value: 19 } }, details: { cr: 2 } })),
    okA(actor(id, "Ok Skeleton With Club", "npc", { details: { cr: 0.25 } }, [
      item(id, "Ok Club", "weapon", { quantity: 1 }),
      item(id, "Ok Bone Fortitude", "feat", {})
    ])),
    okA(actor(id, "Ok Wolf", "npc", {}, [item(id, "Ok Bite", "feat", {})])),
    okA(actor(id, "Ok Commoner", "npc", { abilities: { str: { value: 10 } } })),
    okA(actor(id, "Ok Wizard Hero", "character", { abilities: { int: { value: 16 } } }, [item(id, "Ok Spell Fire Bolt", "spell", { level: 0 })])),
    okA(actor(id, "Ok Fighter Hero", "character", { abilities: { str: { value: 17 } } }, [item(id, "Ok Hero Sword", "weapon", { quantity: 1 })])),
    okA(actor(id, "Ok Blessed Hero", "character", {}, [], { effects: [effect(id, "Blessing", { transfer: false })] })),
    okA(withoutStats(actor(id, "Ok Plain File Npc", "npc", { details: { cr: 1 } }))),
    okA(withoutStats(actor(id, "Ok Plain File Hero", "character", {})))
  ];

  // ---- Actors, non conforming (6)
  const badA = (doc, defect) => track(doc, "Actor", false, defect);
  actors.push(
    badA(actor(id, "Bad Unknown Actor Type", "monster", {}), "unknownType"),
    badA(actor(id, "Bad Strength Text", "npc", { abilities: { str: { value: "fort" } } }), "invalidValue"),
    badA(actor(id, "Bad Hit Points Text", "npc", { attributes: { hp: { value: "plein" } } }), "invalidValue"),
    badA(actor(id, "Bad Nested Item Type", "npc", {}, [item(id, "Nested Mystery", "gizmo", {})]), "nestedUnknownType"),
    badA(actor(id, "Bad Nested Item Value", "npc", {}, [item(id, "Nested Bad Loot", "loot", { quantity: "beaucoup" })]), "nestedInvalid"),
    badA(actor(id, "Bad Items Not Array", "npc", {}, "oops"), "itemsNotArray")
  );

  return {
    items,
    actors,
    expected: {
      note: "Ground truth for conformity-items.json and conformity-actors.json. conform=false documents are all up to date (systemVersion 6.0.6).",
      defects: DEFECTS,
      counts: {
        items: items.length,
        actors: actors.length,
        total: records.length,
        conform: records.filter((r) => r.conform).length,
        nonConform: records.filter((r) => !r.conform).length
      },
      documents: records
    }
  };
}

// ---------------------------------------------------------------- legacy dnd5e 3.x (C19, M9)

/**
 * Each record is { doc, expectActivities, nestedWithActivities?, kind }.
 * expectActivities: after import system.activities has at least one entry (item has actionType or activation.type).
 */
export function buildLegacy3x() {
  const id = makeIdGen(300);
  const base = (name, type, system, extra = {}) => ({
    _id: id(), name, type, img: "icons/svg/item-bag.svg", system, effects: [], flags: {}, _stats: { ...STATS_3X }, ...extra
  });
  const desc = { value: "", chat: "", unidentified: "" };

  const records = [
    {
      kind: "weapon", expectActivities: true,
      doc: base("Legacy Longsword", "weapon", {
        description: desc, quantity: 1, weight: 3, price: { value: 15, denomination: "gp" }, rarity: "",
        actionType: "mwak", ability: "", attackBonus: "", critical: { threshold: null, damage: "" },
        damage: { parts: [["1d8 + @mod", "slashing"]], versatile: "1d10" },
        activation: { type: "action", cost: 1, condition: "" }, range: { value: 5, long: null, units: "ft" },
        target: { value: null, type: "", units: "" }, equipped: true, proficient: null, identified: true,
        properties: ["ver"], type: { value: "martialM", baseItem: "longsword" }
      })
    },
    {
      kind: "weapon", expectActivities: true,
      doc: base("Legacy Shortbow", "weapon", {
        description: desc, quantity: 1, weight: 2, price: { value: 25, denomination: "gp" },
        actionType: "rwak", damage: { parts: [["1d6 + @mod", "piercing"]], versatile: "" },
        activation: { type: "action", cost: 1, condition: "" }, range: { value: 80, long: 320, units: "ft" },
        equipped: true, properties: ["amm", "two"], type: { value: "martialR", baseItem: "shortbow" }
      })
    },
    {
      kind: "weapon", expectActivities: true,
      doc: base("Legacy Dagger Throw", "weapon", {
        description: desc, quantity: 2, weight: 1, actionType: "mwak",
        damage: { parts: [["1d4 + @mod", "piercing"]], versatile: "" },
        activation: { type: "action", cost: 1, condition: "" }, range: { value: 20, long: 60, units: "ft" },
        properties: ["fin", "lgt", "thr"], type: { value: "simpleM", baseItem: "dagger" }
      })
    },
    {
      kind: "spell-save", expectActivities: true,
      doc: base("Legacy Fireball", "spell", {
        description: desc, level: 3, school: "evo", properties: ["vocal", "somatic", "material"],
        actionType: "save", save: { ability: "dex", dc: null, scaling: "spell" },
        damage: { parts: [["8d6", "fire"]], versatile: "" },
        activation: { type: "action", cost: 1, condition: "" }, range: { value: 150, units: "ft" },
        target: { value: 20, type: "sphere", units: "ft" }, duration: { value: "", units: "inst" },
        materials: { value: "a tiny ball of bat guano and sulfur", consumed: false, cost: 0, supply: 0 },
        preparation: { mode: "prepared", prepared: false }
      })
    },
    {
      kind: "spell-attack", expectActivities: true,
      doc: base("Legacy Fire Bolt", "spell", {
        description: desc, level: 0, school: "evo", properties: ["vocal", "somatic"], actionType: "rsak",
        damage: { parts: [["1d10", "fire"]], versatile: "" }, activation: { type: "action", cost: 1, condition: "" },
        range: { value: 120, units: "ft" }, duration: { value: "", units: "inst" }
      })
    },
    {
      kind: "heal", expectActivities: true,
      doc: base("Legacy Cure Wounds", "spell", {
        description: desc, level: 1, school: "evo", properties: ["vocal", "somatic"], actionType: "heal",
        damage: { parts: [["1d8 + @mod", "healing"]], versatile: "" },
        activation: { type: "action", cost: 1, condition: "" }, range: { value: null, units: "touch" },
        duration: { value: "", units: "inst" }
      })
    },
    {
      kind: "consumable", expectActivities: true,
      doc: base("Legacy Healing Potion", "consumable", {
        description: desc, quantity: 3, weight: 0.5, actionType: "heal", consumableType: "potion",
        damage: { parts: [["2d4 + 2", "healing"]], versatile: "" },
        activation: { type: "action", cost: 1, condition: "" }, range: { value: null, units: "self" },
        uses: { value: 1, max: "1", per: "charges", recovery: "", autoDestroy: true }, type: { value: "potion" }
      })
    },
    {
      kind: "consumable-recovery", expectActivities: true,
      doc: base("Legacy Wand Of Sparks", "consumable", {
        description: desc, quantity: 1, activation: { type: "action", cost: 1, condition: "" },
        uses: { value: 3, max: "3", per: "charges", recovery: "1d3", autoDestroy: false }, type: { value: "wand" }
      })
    },
    {
      kind: "tool", expectActivities: false,
      doc: base("Legacy Smith Tools", "tool", {
        description: desc, quantity: 1, weight: 8, ability: "int", chatFlavor: "", proficient: null, bonus: "",
        type: { value: "art", baseItem: "smith" }
      })
    },
    {
      kind: "backpack", expectActivities: false,
      doc: base("Legacy Backpack", "backpack", {
        description: desc, quantity: 1, weight: 5, capacity: { type: "weight", value: 30, weightless: false }
      })
    },
    {
      kind: "loot", expectActivities: false,
      doc: base("Legacy Gem", "loot", { description: desc, quantity: 2, weight: 0, price: { value: 100, denomination: "gp" } })
    },
    {
      kind: "feat", expectActivities: true,
      doc: base("Legacy Second Wind", "feat", {
        description: desc, activation: { type: "bonus", cost: 1, condition: "" }, actionType: "heal",
        damage: { parts: [["1d10 + @classes.fighter.levels", "healing"]], versatile: "" },
        uses: { value: 1, max: "1", per: "sr", recovery: "" }, type: { value: "class", subtype: "" }
      })
    },
    {
      kind: "npc", expectActivities: false, nestedWithActivities: ["Legacy Scimitar"],
      doc: {
        _id: id(), name: "Legacy Goblin", type: "npc", img: "icons/svg/mystery-man.svg",
        system: {
          abilities: { str: { value: 8 }, dex: { value: 14 }, con: { value: 10 }, int: { value: 10 }, wis: { value: 8 }, cha: { value: 8 } },
          attributes: { ac: { flat: 15, calc: "natural", value: 15 }, hp: { value: 7, max: 7, formula: "2d6" }, movement: { walk: 30 } },
          details: { cr: 0.25, type: { value: "humanoid" }, biography: { value: "" } }
        },
        items: [
          base("Legacy Scimitar", "weapon", {
            description: desc, quantity: 1, actionType: "mwak", damage: { parts: [["1d6 + 2", "slashing"]], versatile: "" },
            activation: { type: "action", cost: 1, condition: "" }, range: { value: 5, units: "ft" }, equipped: true,
            type: { value: "martialM", baseItem: "scimitar" }
          }),
          base("Legacy Nimble Escape", "feat", { description: desc, type: { value: "monster" } })
        ],
        effects: [], flags: {}, _stats: { ...STATS_3X }
      }
    },
    {
      kind: "character", expectActivities: false,
      doc: {
        _id: id(), name: "Legacy Hero", type: "character", img: "icons/svg/mystery-man.svg",
        system: {
          abilities: { str: { value: 15 }, dex: { value: 12 }, con: { value: 14 }, int: { value: 10 }, wis: { value: 10 }, cha: { value: 8 } },
          attributes: { ac: { calc: "default" }, hp: { value: 12, max: 12 } },
          details: { biography: { value: "" }, alignment: "NG" }
        },
        items: [], effects: [], flags: {}, _stats: { ...STATS_3X }
      }
    }
  ];
  return records;
}

// ---------------------------------------------------------------- id conflicts (C22) and links (C23)

export const ID_CONFLICT_IDS = ["conflictItem0001", "conflictItem0002", "conflictItem0003"];

/** Three loot items whose _id are fixed, so a test can seed a pack with the same ids first. */
export function buildIdConflicts() {
  return ID_CONFLICT_IDS.map((_id, i) => ({
    _id, name: `Conflict Item ${i + 1}`, type: "loot", img: "icons/svg/item-bag.svg", system: { quantity: i + 1 },
    effects: [], flags: {}, _stats: { ...STATS_CURRENT }
  }));
}

/** An item whose attack activity applies an effect of the same item: the link is activity.effects[]._id. */
export function buildActivityLink() {
  const effectId = "linkedEffect0001";
  const activityId = "linkedActiv00001";
  return {
    _id: "linkedItem000001", name: "Link Ring", type: "equipment", img: "icons/svg/item-bag.svg",
    system: {
      quantity: 1,
      activities: {
        [activityId]: { _id: activityId, type: "save", name: "Burst", effects: [{ _id: effectId }] }
      }
    },
    effects: [{ _id: effectId, name: "Linked Burn", img: "icons/svg/fire.svg", changes: [], disabled: false, transfer: false }],
    flags: {}, _stats: { ...STATS_CURRENT }
  };
}

export const ACTIVITY_LINK_IDS = { item: "linkedItem000001", effect: "linkedEffect0001", activity: "linkedActiv00001" };

// ---------------------------------------------------------------- writing

export function writeAll(dir = HERE) {
  const put = (rel, content) => {
    const file = path.join(dir, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content, null, 2) + "\n");
  };
  for (const [name, content] of Object.entries(buildFormats())) put(`formats/${name}`, content);
  const conformity = buildConformity();
  put("conformity-items.json", conformity.items);
  put("conformity-actors.json", conformity.actors);
  put("conformity-expected.json", conformity.expected);
  const legacy = buildLegacy3x();
  put("legacy-3x.json", legacy.map((r) => r.doc));
  put("legacy-3x-expected.json", legacy.map((r) => ({
    name: r.doc.name, type: r.doc.type, kind: r.kind, expectActivities: r.expectActivities,
    nestedWithActivities: r.nestedWithActivities ?? []
  })));
  put("id-conflicts.json", buildIdConflicts());
  put("activity-link.json", [buildActivityLink()]);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  writeAll();
  console.log("Fixtures written to", HERE);
}
