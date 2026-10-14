// C18 (key, lookup, source order), C20 (adjustToFacts, appendPdfNote), C23 inputs (collectLookups).
import { describe, expect, it } from "vitest";
import {
  adjustToFacts, appendPdfNote, collectLookups, defaultSourceOrder, findMatch, isMultiattackKey, matchKey, resolveSourceOrder
} from "../../scripts/core/enrich/compendium.mjs";
import { deepFreeze, makeParser } from "../support/fake-parser.mjs";

describe("matchKey (C18)", () => {
  it.each([
    ["Fireball", "fireball"],
    ["  FIREBALL  ", "fireball"],
    ["Boule de Feu", "boule de feu"],
    ["Éclair  Électrique", "eclair electrique"],
    ["Hunter's Mark", "hunters mark"],
    ["Hunter’s Mark", "hunters mark"],
    ["Rope, Hempen (50 feet)", "rope hempen 50 feet"],
    ["Water (Pint)", "water pint"]
  ])("normalizes %j to %j", (input, key) => expect(matchKey(input)).toBe(key));

  it.each([
    "Legendary Resistance (3/Day)", "Legendary Resistance (3/day)", "Legendary Resistance ((3/Day))",
    "Legendary Resistance", "Résistance légendaire (3/jour)".replace("Résistance légendaire", "Legendary Resistance"),
    "Legendary Resistance (3/Day Each)"
  ])("ignores the usage mention of %j", (name) => expect(matchKey(name)).toBe("legendary resistance"));

  it.each([
    ["Fire Breath (Recharge 5–6)", "fire breath"],
    ["Fire Breath (Recharge 5-6)", "fire breath"],
    ["Fire Breath (Recharge 6)", "fire breath"],
    ["Frost Ray (Recharges after a Short or Long Rest)", "frost ray"],
    ["Tail Swipe (Costs 2 Actions)", "tail swipe"],
    ["Coup de queue (coûte 2 actions)", "coup de queue"],
    ["Souffle (se recharge après un repos)", "souffle"],
    ["Cri (2/Turn)", "cri"]
  ])("ignores the mention of %j", (input, key) => expect(matchKey(input)).toBe(key));

  it("keeps parentheses that are not a mention, and handles missing names", () => {
    expect(matchKey("Torch (Lit)")).toBe("torch lit");
    expect(matchKey(undefined)).toBe("");
    expect(matchKey(null)).toBe("");
  });

  it("separates names that only differ by a letter", () => {
    expect(matchKey("Longsword")).not.toBe(matchKey("Long sword"));
    expect(matchKey("Shield")).not.toBe(matchKey("Shields"));
  });
});

describe("isMultiattackKey", () => {
  it("recognizes Multiattack in English and French only", () => {
    expect(isMultiattackKey(matchKey("Multiattack"))).toBe(true);
    expect(isMultiattackKey(matchKey("Attaques multiples"))).toBe(true);
    expect(isMultiattackKey(matchKey("Multiattack Plus"))).toBe(false);
  });
});

describe("findMatch (C18)", () => {
  const index = {
    "dnd5e.spells24": [
      { _id: "s1", name: "Shield", type: "spell" },
      { _id: "s2", name: "Fireball", type: "spell" }
    ],
    "dnd5e.equipment24": [
      { _id: "e1", name: "Shield", type: "equipment" },
      { _id: "t1", name: "Torch", type: "consumable" },
      { _id: "t2", name: "Torch", type: "consumable" }
    ],
    "dnd5e.monsterfeatures": [
      { _id: "m1", name: "Shield", type: "feat" },
      { _id: "m2", name: "Fireball", type: "feat" },
      { _id: "m3", name: "Torch", type: "consumable" }
    ],
    "world.mine": [{ _id: "w1", name: "Fireball", type: "spell" }]
  };
  const order = ["dnd5e.spells24", "dnd5e.equipment24", "dnd5e.monsterfeatures", "world.mine"];

  it("filters by document type", () => {
    expect(findMatch(index, order, "shield", "spell")).toEqual({ status: "found", pack: "dnd5e.spells24", id: "s1" });
    expect(findMatch(index, order, "shield", "equipment")).toEqual({ status: "found", pack: "dnd5e.equipment24", id: "e1" });
    expect(findMatch(index, order, "shield", "feat")).toEqual({ status: "found", pack: "dnd5e.monsterfeatures", id: "m1" });
    expect(findMatch(index, order, "fireball", "feat").id).toBe("m2");
  });

  it("the first pack in priority order wins", () => {
    expect(findMatch(index, ["world.mine", "dnd5e.spells24"], "fireball", "spell")).toEqual({ status: "found", pack: "world.mine", id: "w1" });
    expect(findMatch(index, order, "fireball", "spell").pack).toBe("dnd5e.spells24");
  });

  it("several entries of the same pack are ambiguous and do not fall through to a later pack", () => {
    expect(findMatch(index, order, "torch", "consumable")).toEqual({ status: "ambiguous", pack: "dnd5e.equipment24", id: null });
  });

  it("reports none when nothing matches or the type differs", () => {
    expect(findMatch(index, order, "boule de feu", "spell")).toEqual({ status: "none", pack: null, id: null });
    expect(findMatch(index, order, "shield", "weapon").status).toBe("none");
    expect(findMatch(index, [], "shield", "spell").status).toBe("none");
  });

  it("skips disabled sources and accepts {pack, enabled} entries and a Map", () => {
    const o = [{ pack: "dnd5e.spells24", enabled: false }, { pack: "world.mine", enabled: true }];
    expect(findMatch(index, o, "fireball", "spell").pack).toBe("world.mine");
    expect(findMatch(new Map(Object.entries(index)), o, "fireball", "spell").id).toBe("w1");
  });

  it("ignores packs that have no index", () => {
    expect(findMatch(index, ["unknown.pack", "dnd5e.spells24"], "shield", "spell").pack).toBe("dnd5e.spells24");
  });

  it("compares through the key function", () => {
    const idx = { p: [{ _id: "a", name: "Fire Breath (Recharge 5–6)", type: "feat" }] };
    expect(findMatch(idx, ["p"], "fire breath", "feat").status).toBe("found");
  });
});

describe("defaultSourceOrder / resolveSourceOrder (C18, C24)", () => {
  const sys = (name, label = name) => ({ collection: `dnd5e.${name}`, label, packageType: "system" });
  const packs = [
    { collection: "mod-b.items", label: "B items", packageType: "module" },
    sys("monsterfeatures"), sys("classfeatures"), sys("items"), sys("spells24"), sys("spells"), sys("monsterfeatures24"),
    sys("equipment24"), sys("tradegoods"), sys("classes24"),
    { collection: "world.mine", label: "Mine", packageType: "world" },
    { collection: "mod-a.spells", label: "A spells", packageType: "module" }
  ];
  const names = (order) => order.map((o) => o.pack);

  it("modern: 2024 packs first, then 2014, then world, then modules by label", () => {
    expect(names(defaultSourceOrder(packs, "modern"))).toEqual([
      "dnd5e.spells24", "dnd5e.equipment24", "dnd5e.monsterfeatures24", "dnd5e.spells", "dnd5e.items", "dnd5e.monsterfeatures",
      "dnd5e.tradegoods", "dnd5e.classes24", "dnd5e.classfeatures", "world.mine", "mod-a.spells", "mod-b.items"
    ]); // unknown dnd5e packs (disabled ones) follow the known ones, by label
  });

  it("legacy: 2014 packs first", () => {
    const order = names(defaultSourceOrder(packs, "legacy"));
    expect(order.slice(0, 4)).toEqual(["dnd5e.spells", "dnd5e.items", "dnd5e.monsterfeatures", "dnd5e.tradegoods"]);
    expect(order.indexOf("dnd5e.spells24")).toBeLessThan(order.indexOf("world.mine"));
  });

  it("disables the character option packs of dnd5e and nothing else", () => {
    const disabled = defaultSourceOrder(packs).filter((o) => !o.enabled).map((o) => o.pack).sort();
    expect(disabled).toEqual(["dnd5e.classes24", "dnd5e.classfeatures"]);
  });

  it("does not modify its input", () => {
    const copy = JSON.parse(JSON.stringify(packs));
    defaultSourceOrder(packs);
    expect(packs).toEqual(copy);
  });

  it("resolve: saved order and flags kept, vanished packs dropped, new packs appended in default order", () => {
    const saved = [
      { pack: "world.mine", enabled: true }, { pack: "dnd5e.items", enabled: false }, { pack: "gone.pack", enabled: true },
      { pack: "world.mine", enabled: false }
    ];
    const order = resolveSourceOrder(saved, packs);
    expect(order[0]).toEqual({ pack: "world.mine", enabled: true });
    expect(order[1]).toEqual({ pack: "dnd5e.items", enabled: false });
    expect(names(order)).not.toContain("gone.pack");
    expect(names(order)).toHaveLength(packs.length);
    expect(new Set(names(order)).size).toBe(packs.length);
    expect(names(order).slice(2, 4)).toEqual(["dnd5e.spells24", "dnd5e.equipment24"]);
  });

  it("resolve: empty or missing saved value gives the default order", () => {
    expect(resolveSourceOrder([], packs)).toEqual(defaultSourceOrder(packs));
    expect(resolveSourceOrder(undefined, packs)).toEqual(defaultSourceOrder(packs));
  });
});

describe("collectLookups (C18, C22)", () => {
  const parser = makeParser({}, { spellcasting: [{ lists: [{ spells: ["Fireball", "Shield"] }, { spells: ["fireball"] }] }] });

  it("lists items and spells of casting traits once per (type, key), without Multiattack", () => {
    const entries = [{
      name: "A", items: [
        { name: "Longsword", type: "weapon" }, { name: "Multiattack", type: "feat" }, { name: "Shield", type: "spell" },
        { name: "Longsword", type: "weapon" }, { name: "Torch" }
      ]
    }];
    const out = collectLookups(entries, parser);
    const ids = out.map((o) => `${o.type}|${o.key}`).sort();
    expect(ids).toEqual(["spell|fireball", "spell|shield", "weapon|longsword"]);
    expect(out.find((o) => o.key === "longsword").name).toBe("Longsword");
  });

  it("ignores entries without items and survives a parser that throws", () => {
    const bad = { ...parser, parseActor() { throw new Error("boom"); } };
    expect(collectLookups([{ name: "x" }, null, { items: [{ name: "Dagger", type: "weapon" }] }], bad)).toHaveLength(1);
    expect(collectLookups(undefined, parser)).toEqual([]);
  });
});

describe("adjustToFacts (C20)", () => {
  const weapon = () => ({
    name: "Dagger", type: "weapon",
    system: {
      quantity: 1, range: { reach: 5, value: 20, long: 60, units: "ft" },
      uses: { max: "", recovery: [] },
      activities: {
        atk: { _id: "atk", type: "attack", attack: { flat: false, bonus: "" }, damage: { includeBase: true, parts: [] }, activation: { type: "action", value: 1 } }
      }
    }
  });
  const saveItem = () => ({
    name: "Breath", type: "feat",
    system: {
      uses: { max: "1", recovery: [{ period: "recharge", formula: "5", type: "recoverAll" }] },
      activities: {
        sv: {
          _id: "sv", type: "save", save: { ability: ["con"], dc: { calculation: "", formula: "12" } },
          damage: { onSave: "half", parts: [{ number: 6, denomination: 6, bonus: "", types: ["fire"] }] }, range: { value: "15", units: "ft" },
          activation: { type: "action", value: 1 }, consumption: { targets: [{ type: "itemUses", target: "", value: "1" }] }
        }
      }
    }
  });
  const part = (number, denomination, bonus, type) => ({ number, denomination, bonus, type, raw: "" });

  it("does not modify the compendium data and reports nothing when values are equal", () => {
    const src = deepFreeze(saveItem());
    const { data, adjusted } = adjustToFacts(src, { save: { ability: "con", dc: 12, damage: [part(6, 6, "", "fire")] }, recharge: { min: 5 }, activation: { type: "action", cost: 1 } });
    expect(adjusted).toEqual([]);
    expect(data).toEqual(src);
  });

  it("attack bonus becomes a flat bonus", () => {
    const { data, adjusted } = adjustToFacts(weapon(), { attack: { bonus: 17 } });
    expect(data.system.activities.atk.attack).toMatchObject({ flat: true, bonus: "17" });
    expect(adjusted).toEqual([{ field: "attack", from: null, to: "17" }]);
  });

  it("an existing flat bonus is reported as the old value", () => {
    const w = weapon();
    w.system.activities.atk.attack = { flat: true, bonus: "6" };
    const { adjusted } = adjustToFacts(w, { attack: { bonus: 11 } });
    expect(adjusted).toEqual([{ field: "attack", from: "6", to: "11" }]);
  });

  it("damage parts are replaced, and a weapon stops adding its base damage", () => {
    const { data, adjusted } = adjustToFacts(weapon(), { damage: [part(1, 4, "+7", "piercing")] });
    const act = data.system.activities.atk;
    expect(act.damage.parts).toEqual([{ number: 1, denomination: 4, bonus: "+7", types: ["piercing"] }]);
    expect(act.damage.includeBase).toBe(false);
    expect(adjusted).toHaveLength(1);
    expect(adjusted[0].field).toBe("damage");
    expect(adjusted[0].to).toContain("1d4+7");
  });

  it("save ability, fixed DC and damage are reported", () => {
    const { data, adjusted } = adjustToFacts(saveItem(), { save: { ability: "dex", dc: 23, damage: [part(18, 10, "", "fire")] } });
    const act = data.system.activities.sv;
    expect(act.save.ability).toEqual(["dex"]);
    expect(act.save.dc).toEqual({ calculation: "", formula: "23" });
    expect(act.damage.parts[0]).toMatchObject({ number: 18, denomination: 10 });
    expect(adjusted.map((a) => a.field).sort()).toEqual(["saveAbility", "saveDC", "saveDamage"]);
  });

  it("a DC calculated from the actor is replaced by the extracted fixed DC", () => {
    const s = saveItem();
    s.system.activities.sv.save.dc = { calculation: "spellcasting", formula: "" };
    const { data } = adjustToFacts(s, { save: { ability: "con", dc: 20, damage: [] } });
    expect(data.system.activities.sv.save.dc).toEqual({ calculation: "", formula: "20" });
  });

  it("weapon range goes to system.range in feet", () => {
    const { data, adjusted } = adjustToFacts(weapon(), { range: { reach: 10, value: null, long: null } });
    expect(data.system.range.reach).toBe(10);
    expect(data.system.range.value).toBe(20);
    expect(adjusted).toEqual([{ field: "range.reach", from: 5, to: 10 }]);
  });

  it("feature range goes to the first activity", () => {
    const { data } = adjustToFacts(saveItem(), { range: { reach: null, value: 30, long: null } });
    expect(data.system.activities.sv.range).toMatchObject({ value: "30", units: "ft" });
  });

  it("recharge and uses per day replace the item uses; a recharge adds the item uses consumption", () => {
    const a = adjustToFacts(saveItem(), { recharge: { min: 4 } });
    expect(a.data.system.uses.recovery[0]).toMatchObject({ period: "recharge", formula: "4" });
    expect(a.data.system.activities.sv.consumption.targets.some((t) => t.type === "itemUses")).toBe(true);
    expect(a.adjusted[0].field).toBe("uses");

    const b = adjustToFacts(saveItem(), { uses: { max: 3, period: "day" } });
    expect(b.data.system.uses).toMatchObject({ max: "3" });
    expect(b.data.system.uses.recovery[0].period).toBe("day");
  });

  it("activation type and cost are set on every activity", () => {
    const { data, adjusted } = adjustToFacts(weapon(), { activation: { type: "legendary", cost: 2 } });
    expect(data.system.activities.atk.activation).toMatchObject({ type: "legendary", value: 2 });
    expect(adjusted[0]).toMatchObject({ field: "activation", to: "legendary 2" });
  });

  it("a spell without activity gets the activation on the item", () => {
    const { data } = adjustToFacts({ type: "spell", system: { activation: { type: "action" } } }, { activation: { type: "reaction", cost: 1 } });
    expect(data.system.activation.type).toBe("reaction");
  });

  it("quantity", () => {
    const { data, adjusted } = adjustToFacts(weapon(), { quantity: 4 });
    expect(data.system.quantity).toBe(4);
    expect(adjusted).toEqual([{ field: "quantity", from: 1, to: 4 }]);
  });

  it("no facts, no change", () => {
    const w = weapon();
    const { data, adjusted } = adjustToFacts(w, {});
    expect(adjusted).toEqual([]);
    expect(data).toEqual(w);
    expect(adjustToFacts(w).adjusted).toEqual([]);
  });

  it("facts for an activity the item does not have are ignored here (no invention)", () => {
    const { data, adjusted } = adjustToFacts({ type: "feat", system: { activities: {} } }, { attack: { bonus: 5 }, save: { ability: "wis", dc: 13, damage: [] } });
    expect(adjusted).toEqual([]);
    expect(data.system.activities).toEqual({});
  });
});

describe("appendPdfNote (C20)", () => {
  const label = "PDF version";
  it("appends the file description after the compendium one when it differs", () => {
    const out = appendPdfNote("<p>Compendium text.</p>", "<p><strong>Slam.</strong> Hit: 7 damage.</p>", label, { name: "Slam" });
    expect(out.startsWith("<p>Compendium text.</p><hr>")).toBe(true);
    expect(out).toContain(`<strong>${label}</strong>`);
    expect(out.endsWith("<p><strong>Slam.</strong> Hit: 7 damage.</p>")).toBe(true);
  });

  it("adds nothing when the texts are the same (header, name, tags and case ignored)", () => {
    const html = "<p>Hit: 7 damage.</p>";
    expect(appendPdfNote(html, "<p><small>Action</small><br/><strong>Slam.</strong> hit: 7   DAMAGE.</p>", label, { name: "Slam" })).toBe(html);
  });

  it("adds nothing when the file has no text", () => {
    expect(appendPdfNote("<p>x</p>", "", label)).toBe("<p>x</p>");
    expect(appendPdfNote("<p>x</p>", "<p><small>Action</small> <strong>Slam.</strong></p>", label, { name: "Slam" })).toBe("<p>x</p>");
    expect(appendPdfNote(undefined, undefined, label)).toBe("");
  });

  it("works when the compendium description is empty", () => {
    expect(appendPdfNote("", "<p>Something.</p>", label)).toContain("Something.");
  });
});
