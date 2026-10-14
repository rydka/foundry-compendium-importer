// C3 (empty-only policy), C4 (nothing invented), C11-C13 inputs, C12 exception, C14 statuses,
// C19-C22 (compendium reuse and spells) of enrichEntry, against a fake parser (see support/fake-parser.mjs).
import { describe, expect, it } from "vitest";
import { enrichEntry, factsFromItem, fillMissing, isEmpty, isEmptyUtility } from "../../scripts/core/enrich/enrich.mjs";
import { changedLeaves, counter, deepFreeze, makeParser } from "../support/fake-parser.mjs";

const KEY = "compendium-json-importer.Enrich.";
const attackActivity = (extra = {}) => ({
  _id: "genAtk", type: "attack", activation: { type: "action", value: 1 },
  attack: { flat: true, bonus: "6", type: { value: "melee", classification: "weapon" } },
  damage: { parts: [{ number: 1, denomination: 4, bonus: "4", types: ["bludgeoning"] }] },
  range: { value: "5", units: "ft" }, ...extra
});
const utility = (id = "u1", name = "Slam") => ({ _id: id, type: "utility", name, activation: { type: "action", value: 1, condition: "" }, roll: { formula: "" } });
const feat = (name, activities, system = {}) => ({
  _id: `${name}`.padEnd(16, "0").slice(0, 16), name, type: "feat",
  system: { description: { value: `<p><strong>${name}.</strong> text</p>` }, activities, ...system }
});
const ctx = (parser, extra = {}) => ({ parser, keys: {}, idGen: counter(), pdfLabel: "PDF version", ...extra });
const acts = (d) => Object.values(d.system.activities);

describe("helpers", () => {
  it("isEmpty", () => {
    for (const v of [undefined, null, "", [], {}]) expect(isEmpty(v)).toBe(true);
    for (const v of [0, "0", false, "x", [0], { a: 1 }]) expect(isEmpty(v)).toBe(false);
  });

  it("isEmptyUtility: only a type, an activation and a name", () => {
    expect(isEmptyUtility(utility())).toBe(true);
    expect(isEmptyUtility({ ...utility(), range: { value: "5" } })).toBe(false);
    expect(isEmptyUtility({ ...utility(), roll: { formula: "1d6" } })).toBe(false);
    expect(isEmptyUtility({ ...utility(), uses: { max: "3" } })).toBe(false);
    expect(isEmptyUtility({ ...utility(), type: "attack" })).toBe(false);
  });

  it("fillMissing fills empty leaves only and records them", () => {
    const target = { a: "keep", b: "", c: { d: 1, e: null }, z: 0 };
    const filled = fillMissing(target, { a: "NEW", b: "x", c: { d: 9, e: 2 }, f: { g: 1 }, z: 5 }, { zeroEmpty: [] });
    expect(target).toEqual({ a: "keep", b: "x", c: { d: 1, e: 2 }, z: 0, f: { g: 1 } });
    expect(filled.map((f) => f.path).sort()).toEqual(["b", "c.e", "f.g"]);
  });

  it("fillMissing: zeroEmpty paths treat 0 as empty", () => {
    const target = { max: 0 };
    fillMissing(target, { max: 3 }, { zeroEmpty: ["max"] });
    expect(target.max).toBe(3);
  });

  it("factsFromItem reads only non-empty values of the file", () => {
    expect(factsFromItem({ type: "feat", system: { activities: { u: utility("u") } } })).toEqual({ activation: { type: "action", cost: 1 } });
    expect(factsFromItem({ type: "feat", system: {} })).toEqual({});
    const full = factsFromItem({
      type: "weapon",
      system: {
        quantity: 3, range: { reach: 5, value: 80, long: 320 },
        uses: { max: "3", recovery: [{ period: "day" }] },
        activities: {
          a: { type: "attack", attack: { flat: true, bonus: "7", type: { value: "ranged", classification: "weapon" } }, damage: { parts: [{ number: 1, denomination: 8, bonus: "3", types: ["piercing"] }] } },
          s: { type: "save", save: { ability: ["dex"], dc: { formula: "14" } }, damage: { onSave: "half", parts: [] } }
        }
      }
    });
    expect(full.attack).toMatchObject({ bonus: 7, type: "ranged", classification: "weapon" });
    expect(full.damage[0]).toMatchObject({ number: 1, denomination: 8, type: "piercing" });
    expect(full.save).toMatchObject({ ability: "dex", dc: 14, onSave: "half" });
    expect(full.range).toEqual({ reach: 5, value: 80, long: 320 });
    expect(full.uses).toEqual({ max: 3, period: "day" });
    expect(full.quantity).toBe(3);
    expect(factsFromItem({ type: "feat", system: { uses: { max: "", recovery: [{ period: "recharge", formula: "5" }] } } }).recharge).toEqual({ min: 5 });
  });
});

describe("enrichEntry: scope and immutability", () => {
  it("passes other document types through untouched", () => {
    const data = { name: "J", pages: [] };
    const out = enrichEntry(data, "JournalEntry", ctx(makeParser()));
    expect(out.data).toBe(data);
    expect(out.report.status).toBe("unchanged");
  });

  it("never modifies its input (deep-frozen document)", () => {
    const input = deepFreeze(feat("Slam", { u1: utility() }));
    const parser = makeParser({ Slam: { _activities: [attackActivity()] } });
    expect(() => enrichEntry(input, "Item", ctx(parser))).not.toThrow();
  });

  it("an actor is enriched item by item and keeps its other items in order", () => {
    const parser = makeParser({ Slam: { _activities: [attackActivity()] } }, null);
    const actor = { name: "A", type: "npc", system: {}, items: [feat("Other", {}), feat("Slam", { u1: utility() })] };
    const { data } = enrichEntry(actor, "Actor", ctx(parser));
    expect(data.items.map((i) => i.name)).toEqual(["Other", "Slam"]);
    expect(acts(data.items[1])[0].type).toBe("attack");
  });
});

describe("enrichEntry: empty-only policy (C3)", () => {
  it("an empty utility activity becomes the extracted attack, keeping its id, name and activation", () => {
    const parser = makeParser({ Slam: { _activities: [attackActivity()] } });
    const item = feat("Slam", { u1: utility("u1", "Slam") });
    const { data, report } = enrichEntry(item, "Item", ctx(parser));
    expect(Object.keys(data.system.activities)).toEqual(["u1"]);
    const a = data.system.activities.u1;
    expect(a).toMatchObject({ _id: "u1", type: "attack", name: "Slam", activation: { type: "action", value: 1 } });
    expect(a.attack.bonus).toBe("6");
    expect(a.damage.parts).toHaveLength(1);
    expect(report.status).toBe("enriched");
    expect(report.items[0]).toMatchObject({ name: "Slam", origin: "text", status: "enriched" });
  });

  it("an item without activity receives the extracted attack/save activities", () => {
    const save = { _id: "genSave", type: "save", save: { ability: ["wis"], dc: { calculation: "", formula: "13" } }, damage: { onSave: "half", parts: [] } };
    const parser = makeParser({ Gaze: { _activities: [attackActivity(), save] } });
    const { data, report } = enrichEntry(feat("Gaze", {}), "Item", ctx(parser));
    expect(acts(data).map((a) => a.type).sort()).toEqual(["attack", "save"]);
    expect(report.status).toBe("enriched");
  });

  it("a partial attack keeps its bonus and range and only receives the missing damage", () => {
    const parser = makeParser({ Slam: { _activities: [attackActivity({ attack: { flat: true, bonus: "6", type: { value: "melee", classification: "weapon" } }, range: { value: "5", units: "ft" } })] } });
    const partial = { _id: "p1", type: "attack", attack: { flat: true, bonus: "11", type: { value: "ranged", classification: "spell" } }, damage: { parts: [] }, range: { value: "30", units: "ft" }, activation: { type: "bonus", value: 1 } };
    const item = feat("Slam", { p1: partial });
    const { data } = enrichEntry(item, "Item", ctx(parser));
    const a = data.system.activities.p1;
    expect(a.attack.bonus).toBe("11");
    expect(a.attack.type).toEqual({ value: "ranged", classification: "spell" });
    expect(a.range.value).toBe("30");
    expect(a.activation.type).toBe("bonus");
    expect(a.damage.parts[0]).toMatchObject({ number: 1, denomination: 4 });
  });

  it("a save activity with a DC already set keeps it", () => {
    const gen = { _id: "g", type: "save", save: { ability: ["con"], dc: { calculation: "", formula: "20" } }, damage: { onSave: "half", parts: [{ number: 2, denomination: 6, bonus: "", types: ["fire"] }] } };
    const parser = makeParser({ Breath: { _activities: [gen] } });
    const item = feat("Breath", { s1: { _id: "s1", type: "save", save: { ability: ["con"], dc: { calculation: "", formula: "15" } }, damage: { parts: [] } } });
    const { data } = enrichEntry(item, "Item", ctx(parser));
    expect(data.system.activities.s1.save.dc.formula).toBe("15");
    expect(data.system.activities.s1.damage.parts).toHaveLength(1);
  });

  it("M5 property: no non-empty value of the file changes, over partial documents", () => {
    const gens = [attackActivity(), { _id: "gs", type: "save", save: { ability: ["dex"], dc: { calculation: "", formula: "17" } }, damage: { onSave: "half", parts: [{ number: 4, denomination: 6, bonus: "", types: ["fire"] }] }, range: { value: "60", units: "ft" } }];
    const parser = makeParser({ X: { _activities: gens, _patch: { uses: { max: "3", recovery: [{ period: "day", type: "recoverAll" }] } } } });
    const docs = [
      feat("X", { a: { _id: "a", type: "attack", attack: { flat: true, bonus: "9" }, damage: { parts: [] }, range: { value: "10", units: "ft" } } }),
      feat("X", { a: { _id: "a", type: "attack", attack: { flat: false, bonus: "" }, damage: { parts: [{ number: 3, denomination: 8, bonus: "", types: ["acid"] }] } } }),
      feat("X", { s: { _id: "s", type: "save", save: { ability: ["str"], dc: { calculation: "", formula: "" } }, damage: { parts: [] } } }),
      feat("X", { s: { _id: "s", type: "save", save: { ability: ["str"], dc: { calculation: "", formula: "12" } }, damage: { onSave: "none", parts: [] }, range: { value: "5", units: "ft" } } }),
      feat("X", { u: { ...utility("u"), name: "Custom name" } }, { uses: { max: "2", recovery: [] } }),
      feat("X", {}, { uses: { max: "", recovery: [{ period: "sr", type: "recoverAll" }] }, identifier: "mine" })
    ];
    for (const doc of docs) {
      const { data } = enrichEntry(doc, "Item", ctx(parser));
      const changed = changedLeaves(doc.system, data.system).filter((c) => !c.path.startsWith("activities.u.type"));
      expect(changed, JSON.stringify(doc.system.activities)).toEqual([]);
    }
  });

  it("existing item uses are never replaced by the extracted ones", () => {
    const parser = makeParser({ X: { _activities: [], _patch: { uses: { max: "3", recovery: [{ period: "day", type: "recoverAll" }] } } } });
    const item = feat("X", {}, { uses: { max: "1", recovery: [{ period: "lr", type: "recoverAll" }] } });
    expect(enrichEntry(item, "Item", ctx(parser)).data.system.uses).toEqual(item.system.uses);
  });

  it("empty item uses are filled from the patch", () => {
    const parser = makeParser({ X: { _activities: [], _patch: { uses: { max: "3", recovery: [{ period: "day", type: "recoverAll" }] } } } });
    const { data, report } = enrichEntry(feat("X", {}), "Item", ctx(parser));
    expect(data.system.uses.max).toBe("3");
    expect(report.status).toBe("enriched");
  });
});

describe("enrichEntry: nothing recognized or ambiguous (C4) and statuses (C14)", () => {
  it("an utility activity whose text is not recognized is left as is and counted notEnriched", () => {
    const parser = makeParser({});
    const item = feat("Chill", { u1: utility("u1", "Chill") });
    const { data, report } = enrichEntry(item, "Item", ctx(parser));
    expect(data).toEqual(item);
    expect(report.status).toBe("notEnriched");
  });

  it("an ambiguous formulation does not create an activity and is reported", () => {
    const parser = makeParser({ Chill: { ambiguous: [{ key: "dnd5e-text-parser.Ambiguous.Attack", data: {} }] } });
    const item = feat("Chill", { u1: utility("u1", "Chill") });
    const { data, report } = enrichEntry(item, "Item", ctx(parser));
    expect(data.system.activities).toEqual(item.system.activities);
    expect(report.status).toBe("notEnriched");
    expect(report.items[0].notes[0].key).toBe("dnd5e-text-parser.Ambiguous.Attack");
  });

  it("a passive trait without activity is unchanged and not listed", () => {
    const { data, report } = enrichEntry(feat("Amorphous", {}), "Item", ctx(makeParser({})));
    expect(data).toEqual(feat("Amorphous", {}));
    expect(report).toMatchObject({ status: "unchanged", items: [] });
  });

  it("Multiattack is never enriched, even when the library returns a plan for it", () => {
    const parser = makeParser({ Multiattack: { _activities: [attackActivity()] } });
    const item = feat("Multiattack", { u1: utility("u1", "Multiattack") });
    const { data, report } = enrichEntry(item, "Item", ctx(parser));
    expect(data).toEqual(item);
    expect(report.items).toEqual([]);
    expect(report.status).toBe("unchanged");
  });

  it("a plan flagged skip by the library is left alone", () => {
    const parser = makeParser({ Odd: { skip: "multiattack", _activities: [attackActivity()] } });
    const item = feat("Odd", { u1: utility() });
    expect(enrichEntry(item, "Item", ctx(parser)).data).toEqual(item);
  });

  it("a library that throws gives an unchanged document", () => {
    const parser = { ...makeParser(), parseFeature() { throw new Error("boom"); } };
    const item = feat("Slam", { u1: utility() });
    const { data, report } = enrichEntry(item, "Item", ctx(parser));
    expect(data).toEqual(item);
    expect(report.status).toBe("unchanged");
  });

  it("statuses over an actor: enriched wins over notEnriched", () => {
    const parser = makeParser({ Slam: { _activities: [attackActivity()] } });
    const actor = { name: "A", type: "npc", system: {}, items: [feat("Slam", { u1: utility() }), feat("Chill", { u2: utility("u2") })] };
    const { report } = enrichEntry(actor, "Actor", ctx(parser));
    expect(report.status).toBe("enriched");
    expect(report.items.map((i) => i.status).sort()).toEqual(["enriched", "notEnriched"]);
  });
});

describe("enrichEntry: the legendary resistance exception (C12) and legendary cost (v3)", () => {
  const lrParser = () => makeParser({ "Legendary Resistance (3/Day)": { legendaryResistance: 3 } });

  it("moves the activity from legendary to special with the legres consumption and identifier", () => {
    const item = feat("Legendary Resistance (3/Day)", { a: { _id: "a", type: "utility", activation: { type: "legendary", value: 1, condition: "" }, consumption: { targets: [] } } });
    const { data, report } = enrichEntry(item, "Item", ctx(lrParser()));
    const a = data.system.activities.a;
    expect(a.activation.type).toBe("special");
    expect(a.activation.condition).toMatch(/saving throw/i);
    expect(a.consumption.targets).toEqual([{ type: "attribute", target: "resources.legres.value", value: "1" }]);
    expect(data.system.identifier).toBe("legendary-resistance");
    expect(report.items[0].notes.some((n) => n.key === `${KEY}LegendaryResistanceReplaced`)).toBe(true);
  });

  it("does not put the n/Day into the item uses", () => {
    const item = feat("Legendary Resistance (3/Day)", {});
    const { data } = enrichEntry(item, "Item", ctx(lrParser()));
    expect(isEmpty(data.system.uses?.max)).toBe(true);
  });

  it("keeps an existing condition, consumption target and identifier", () => {
    const item = feat("Legendary Resistance (3/Day)", { a: { _id: "a", type: "utility", activation: { type: "legendary", value: 1, condition: "my condition" }, consumption: { targets: [{ type: "itemUses", target: "", value: "1" }] } } }, { identifier: "lr" });
    const { data } = enrichEntry(item, "Item", ctx(lrParser()));
    const a = data.system.activities.a;
    expect(a.activation.condition).toBe("my condition");
    expect(a.consumption.targets).toEqual([{ type: "itemUses", target: "", value: "1" }]);
    expect(data.system.identifier).toBe("lr");
  });

  it("French resistance gets a French condition", () => {
    const parser = makeParser({ "Résistance légendaire (3/jour)": { legendaryResistance: 3 } });
    const item = { ...feat("Résistance légendaire (3/jour)", {}), system: { description: { value: "<p>Si la créature rate un jet de sauvegarde, elle peut réussir.</p>" }, activities: {} } };
    const { data } = enrichEntry(item, "Item", ctx(parser));
    expect(acts(data)[0].activation.condition).toMatch(/rate un jet/);
  });

  it("the text cost of a legendary action overrides the file cost, with a note", () => {
    const parser = makeParser({ Wing: { activation: { type: "legendary", cost: 2 } } });
    const item = feat("Wing", { a: { _id: "a", type: "attack", activation: { type: "legendary", value: 1 } } });
    const { data, report } = enrichEntry(item, "Item", ctx(parser));
    expect(data.system.activities.a.activation.value).toBe(2);
    expect(report.items[0].notes).toContainEqual({ key: `${KEY}LegendaryCost`, data: { from: 1, to: 2 } });
  });

  it("an equal legendary cost raises no note", () => {
    const parser = makeParser({ Wing: { activation: { type: "legendary", cost: 2 } } });
    const item = feat("Wing", { a: { _id: "a", type: "attack", activation: { type: "legendary", value: 2 } } });
    expect(enrichEntry(item, "Item", ctx(parser)).report.items.flatMap((i) => i.notes)).toEqual([]);
  });
});

describe("enrichEntry: actor data (C11, C13)", () => {
  const actorWith = (system) => ({ name: "A", type: "npc", system, items: [] });
  const withPlan = (patch) => makeParser({}, { spellcasting: [], _patch: patch });

  it("fills legact and legres when they are 0 or missing, and never replaces a set value", () => {
    const parser = withPlan({ resources: { legact: { max: 3 }, legres: { max: 3 } } });
    const a = enrichEntry(actorWith({ resources: { legact: { max: 0 }, legres: { max: 0 } } }), "Actor", ctx(parser));
    expect(a.data.system.resources).toMatchObject({ legact: { max: 3 }, legres: { max: 3 } });
    expect(a.report.changes.map((c) => c.key)).toEqual([`${KEY}Legact`, `${KEY}Legres`]);
    const b = enrichEntry(actorWith({ resources: { legact: { max: 5 } } }), "Actor", ctx(parser));
    expect(b.data.system.resources.legact.max).toBe(5);
    expect(b.data.system.resources.legres.max).toBe(3);
  });

  it("traits: union with the existing values, never removing, with bypasses and custom text", () => {
    const parser = withPlan({ traits: { dr: { value: ["fire", "cold"], bypasses: ["mgc"], custom: ["from Vampire's bite"] }, ci: { value: ["charmed"], bypasses: [], custom: [] } } });
    const system = { traits: { dr: { value: ["cold", "acid"], bypasses: [], custom: "keep me" }, di: { value: ["poison"] }, ci: { value: [] } } };
    const { data, report } = enrichEntry(actorWith(system), "Actor", ctx(parser));
    expect(data.system.traits.dr.value.sort()).toEqual(["acid", "cold", "fire"]);
    expect(data.system.traits.dr.bypasses).toEqual(["mgc"]);
    expect(data.system.traits.dr.custom).toBe("keep me; from Vampire's bite");
    expect(data.system.traits.di.value).toEqual(["poison"]);
    expect(data.system.traits.ci.value).toEqual(["charmed"]);
    expect(report.changes.filter((c) => c.key === `${KEY}Trait`).map((c) => c.data.trait).sort()).toEqual(["ci", "dr"]);
    expect(report.status).toBe("enriched");
  });

  it("traits: nothing new, nothing reported", () => {
    const parser = withPlan({ traits: { dr: { value: ["cold"], bypasses: [], custom: [] } } });
    const { report } = enrichEntry(actorWith({ traits: { dr: { value: ["cold"] } } }), "Actor", ctx(parser));
    expect(report.changes).toEqual([]);
    expect(report.status).toBe("unchanged");
  });
});

describe("enrichEntry: reuse of a compendium document (C19, C20, C21)", () => {
  const compendiumDoc = () => deepFreeze({
    name: "Longsword (SRD)", type: "weapon", img: "icons/sword.svg",
    system: {
      description: { value: "<p>A fine blade.</p>" }, quantity: 1, range: { reach: 5, units: "ft" },
      activities: { c1: { _id: "c1", type: "attack", attack: { flat: false, bonus: "" }, damage: { includeBase: true, parts: [] }, activation: { type: "action", value: 1 } } }
    },
    effects: [{ _id: "e1", name: "Glow" }], _stats: { compendiumSource: "Compendium.dnd5e.equipment24.Item.old", modifiedTime: 1 }
  });
  const match = (extra = {}) => new Map([["weapon|longsword", { status: "found", data: compendiumDoc(), uuid: "Compendium.dnd5e.equipment24.Item.phbwepLongsword0", packLabel: "Equipment (2024)", ...extra }]]);
  const fileItem = () => ({ _id: "FILEID0000000001", name: "Longsword", type: "weapon", sort: 5, system: { description: { value: "<p>Melee Weapon Attack: +17 to hit, reach 10 ft. Hit: 9 (1d8 + 5) slashing damage.</p>" }, quantity: 3, activities: {} } });
  const plan = { attack: { type: "melee", classification: "weapon", bonus: 17 }, range: { reach: 10, value: null, long: null }, damage: [{ number: 1, denomination: 8, bonus: "5", type: "slashing", raw: "" }] };
  const actor = () => ({ name: "A", type: "npc", system: {}, items: [fileItem()] });

  it("takes the compendium document, keeps the file id, name and order, and links the source", () => {
    const { data, report } = enrichEntry(actor(), "Actor", ctx(makeParser({ Longsword: plan }), { matches: match(), useCompendiums: true }));
    const it = data.items[0];
    expect(it._id).toBe("FILEID0000000001");
    expect(it.name).toBe("Longsword");
    expect(it.sort).toBe(5);
    expect(it.img).toBe("icons/sword.svg");
    expect(it.effects).toEqual([{ _id: "e1", name: "Glow" }]);
    expect(it._stats.compendiumSource).toBe("Compendium.dnd5e.equipment24.Item.phbwepLongsword0");
    expect(report.items[0]).toMatchObject({ origin: "compendium", pack: "Equipment (2024)", uuid: "Compendium.dnd5e.equipment24.Item.phbwepLongsword0" });
  });

  it("adjusts to the extracted values and reports them (M10)", () => {
    const { data, report } = enrichEntry(actor(), "Actor", ctx(makeParser({ Longsword: plan }), { matches: match(), useCompendiums: true }));
    const it = data.items[0];
    const a = it.system.activities.c1;
    expect(a.attack).toMatchObject({ flat: true, bonus: "17" });
    expect(a.damage.parts[0]).toMatchObject({ number: 1, denomination: 8, bonus: "5", types: ["slashing"] });
    expect(it.system.range.reach).toBe(10);
    expect(it.system.quantity).toBe(3);
    expect(report.items[0].adjusted.map((x) => x.field).sort()).toEqual(["attack", "damage", "quantity", "range.reach"]);
  });

  it("keeps the compendium description and appends the PDF version", () => {
    const { data } = enrichEntry(actor(), "Actor", ctx(makeParser({ Longsword: plan }), { matches: match(), useCompendiums: true }));
    const d = data.items[0].system.description.value;
    expect(d.startsWith("<p>A fine blade.</p><hr>")).toBe(true);
    expect(d).toContain("<strong>PDF version</strong>");
    expect(d).toContain("+17 to hit");
  });

  it("does not modify the compendium document (frozen)", () => {
    expect(() => enrichEntry(actor(), "Actor", ctx(makeParser({ Longsword: plan }), { matches: match(), useCompendiums: true }))).not.toThrow();
  });

  it("ignores matches when compendiums are off, and for an Item document", () => {
    const off = enrichEntry(actor(), "Actor", ctx(makeParser({ Longsword: plan }), { matches: match(), useCompendiums: false }));
    expect(off.data.items[0].img).not.toBe("icons/sword.svg");
    expect(off.report.items.every((i) => i.origin === "text")).toBe(true);
    expect(off.data.items[0].system.range).toBeUndefined();
    const asItem = enrichEntry(fileItem(), "Item", ctx(makeParser({ Longsword: plan }), { matches: match(), useCompendiums: true }));
    expect(asItem.report.items[0]?.origin ?? "text").toBe("text");
  });

  it("an ambiguous match is not used and is reported", () => {
    const m = new Map([["weapon|longsword", { status: "ambiguous", packLabel: "Equipment (2024)" }]]);
    const { data, report } = enrichEntry(actor(), "Actor", ctx(makeParser({ Longsword: plan }), { matches: m, useCompendiums: true }));
    expect(data.items[0].img).not.toBe("icons/sword.svg");
    expect(report.items[0]).toMatchObject({ origin: "ambiguous", pack: "Equipment (2024)" });
  });

  it("an item without a match is built from the text (C21)", () => {
    const gen = attackActivity();
    const parser = makeParser({ Longsword: { _activities: [gen] } });
    const { data, report } = enrichEntry(actor(), "Actor", ctx(parser, { matches: new Map(), useCompendiums: true }));
    expect(acts(data.items[0])[0].type).toBe("attack");
    expect(report.items[0].origin).toBe("text");
  });

  it("Multiattack is never taken from a compendium", () => {
    const m = new Map([["feat|multiattack", { status: "found", data: { name: "Multiattack", type: "feat", system: {} }, uuid: "x", packLabel: "P" }]]);
    const item = feat("Multiattack", { u1: utility("u1", "Multiattack") });
    const { data } = enrichEntry({ name: "A", type: "npc", system: {}, items: [item] }, "Actor", ctx(makeParser({ Multiattack: {} }), { matches: m, useCompendiums: true }));
    expect(data.items[0]).toEqual(item);
  });

  it("legendary resistance taken from a compendium also gets the exception", () => {
    const src = { name: "Legendary Resistance", type: "feat", system: { description: { value: "<p>x</p>" }, activities: { l: { _id: "l", type: "utility", activation: { type: "legendary", value: 1 }, consumption: { targets: [] } } } } };
    const m = new Map([["feat|legendary resistance", { status: "found", data: src, uuid: "u", packLabel: "P" }]]);
    const item = feat("Legendary Resistance (3/Day)", {});
    const { data } = enrichEntry({ name: "A", type: "npc", system: {}, items: [item] }, "Actor", ctx(makeParser({ "Legendary Resistance (3/Day)": { legendaryResistance: 3 } }), { matches: m, useCompendiums: true }));
    expect(data.items[0].system.activities.l.activation.type).toBe("special");
  });
});

describe("enrichEntry: spells of the casting traits (C22)", () => {
  const casting = (lists, extra = {}) => ({ ability: "int", dc: 17, attack: 9, casterLevel: 9, innate: false, lists, ...extra });
  const spellDoc = (name, level = 3) => ({
    name, type: "spell",
    system: {
      level, activities: {
        sv: { _id: "sv", type: "save", save: { ability: ["dex"], dc: { calculation: "spellcasting", formula: "" } } },
        at: { _id: "at", type: "attack", attack: { flat: false, bonus: "", type: { value: "ranged", classification: "spell" } } },
        wa: { _id: "wa", type: "attack", attack: { flat: false, bonus: "", type: { value: "melee", classification: "weapon" } } }
      }
    }
  });
  const run = (lists, { matches = new Map(), system = {}, items = [], casting: c } = {}) => {
    const parser = makeParser({}, { spellcasting: [c ?? casting(lists)] });
    return enrichEntry({ name: "Mage", type: "npc", system, items }, "Actor", ctx(parser, { matches, useCompendiums: true }));
  };
  const spellsOf = (data) => Object.fromEntries(data.items.filter((i) => i.type === "spell").map((i) => [i.name, i]));

  it("at will, n per day, cantrip and slot spells get the right mode (stubs for unknown spells)", () => {
    const { data, report } = run([
      { mode: "atwill", uses: null, level: null, slots: null, spells: ["Detect Magic"] },
      { mode: "innate", uses: 3, level: null, slots: null, spells: ["Fly"] },
      { mode: "cantrip", uses: null, level: 0, slots: null, spells: ["Light"] },
      { mode: "slots", uses: null, level: 3, slots: 3, spells: ["Fireball"] }
    ]);
    const s = spellsOf(data);
    expect(s["Detect Magic"].system).toMatchObject({ method: "atwill", prepared: 1 });
    expect(s.Fly.system).toMatchObject({ method: "innate", uses: { max: "3", recovery: [{ period: "day", type: "recoverAll" }] } });
    expect(s.Light.system).toMatchObject({ method: "spell", level: 0 });
    expect(s.Fireball.system).toMatchObject({ method: "spell", level: 3 });
    expect(report.items.every((i) => i.origin === "notFound")).toBe(true);
    expect(report.status).toBe("enriched");
    expect(new Set(data.items.map((i) => i._id)).size).toBe(4);
  });

  it("no invented content: a spell not found has no activity", () => {
    const { data } = run([{ mode: "atwill", uses: null, level: null, slots: null, spells: ["Arcane Whisper"] }]);
    expect(spellsOf(data)["Arcane Whisper"].system.activities).toBeUndefined();
  });

  it("an unknown level for a spell that is not found is flagged in the report", () => {
    const { report } = run([{ mode: "atwill", uses: null, level: null, slots: null, spells: ["Arcane Whisper"] }]);
    expect(report.items[0].notes.some((n) => n.key === `${KEY}SpellLevelUnknown`)).toBe(true);
  });

  it("slot lines set the slots of the actor (override and value) once, keeping a set value", () => {
    const lists = [
      { mode: "slots", uses: null, level: 1, slots: 4, spells: ["Shield"] },
      { mode: "slots", uses: null, level: 2, slots: 3, spells: ["Misty Step"] }
    ];
    const { data } = run(lists, { system: { spells: { spell2: { override: 5, value: 5 } } } });
    expect(data.system.spells.spell1).toMatchObject({ override: 4, value: 4 });
    expect(data.system.spells.spell2).toMatchObject({ override: 5, value: 5 });
  });

  it("the casting ability and level are set on the actor only when empty", () => {
    const lists = [{ mode: "atwill", uses: null, level: null, slots: null, spells: ["Light"] }];
    const a = run(lists).data.system.attributes;
    expect(a.spellcasting).toBe("int");
    expect(a.spell.level).toBe(9);
    const b = run(lists, { system: { attributes: { spellcasting: "wis", spell: { level: 3 } } } }).data.system.attributes;
    expect(b.spellcasting).toBe("wis");
    expect(b.spell.level).toBe(3);
  });

  it("spells found in a compendium are reused with the trait's mode, DC and spell attack bonus", () => {
    const matches = new Map([
      ["spell|fireball", { status: "found", data: spellDoc("Fireball"), uuid: "Compendium.dnd5e.spells24.Item.f", packLabel: "Spells (2024)" }]
    ]);
    const { data, report } = run([{ mode: "innate", uses: 2, level: null, slots: null, spells: ["Fireball"] }], { matches });
    const s = spellsOf(data).Fireball;
    expect(s._stats.compendiumSource).toBe("Compendium.dnd5e.spells24.Item.f");
    expect(s.system.method).toBe("innate");
    expect(s.system.uses.max).toBe("2");
    expect(s.system.activities.sv.save.dc).toEqual({ calculation: "", formula: "17" });
    expect(s.system.activities.at.attack).toMatchObject({ flat: true, bonus: "9" });
    expect(s.system.activities.wa.attack.flat).toBe(false);
    expect(report.items[0]).toMatchObject({ origin: "compendium", pack: "Spells (2024)" });
  });

  it("a spell already on the actor is not added twice (same key), nor repeated in the lists", () => {
    const items = [{ _id: "X", name: "Fireball", type: "spell", system: {} }];
    const { data } = run([
      { mode: "innate", uses: 1, level: null, slots: null, spells: ["fireball", "Fly"] },
      { mode: "atwill", uses: null, level: null, slots: null, spells: ["FLY"] }
    ], { items });
    expect(data.items.filter((i) => i.type === "spell").map((i) => i.name)).toEqual(["Fireball", "Fly"]);
    expect(data.items[0]).toMatchObject({ _id: "X", name: "Fireball", type: "spell" });
  });

  it("an ambiguous spell is created as a stub and reported as ambiguous", () => {
    const matches = new Map([["spell|fly", { status: "ambiguous", packLabel: "Spells" }]]);
    const { report } = run([{ mode: "atwill", uses: null, level: null, slots: null, spells: ["Fly"] }], { matches });
    expect(report.items[0]).toMatchObject({ origin: "ambiguous", pack: "Spells" });
  });

  it("with compendiums off every spell is built from the trait", () => {
    const parser = makeParser({}, { spellcasting: [casting([{ mode: "atwill", uses: null, level: null, slots: null, spells: ["Fly"] }])] });
    const matches = new Map([["spell|fly", { status: "found", data: spellDoc("Fly"), uuid: "u", packLabel: "P" }]]);
    const { report } = enrichEntry({ name: "M", type: "npc", system: {}, items: [] }, "Actor", ctx(parser, { matches, useCompendiums: false }));
    expect(report.items[0].origin).toBe("notFound");
  });

  it("an actor without a casting plan is unchanged", () => {
    const { data, report } = enrichEntry({ name: "M", type: "npc", system: {}, items: [] }, "Actor", ctx(makeParser({}, { spellcasting: [] })));
    expect(data.items).toEqual([]);
    expect(report.status).toBe("unchanged");
  });
});
