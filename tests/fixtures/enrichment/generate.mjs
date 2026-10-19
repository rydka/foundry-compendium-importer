// Deterministic generator of the hand-annotated data sets of activity-enrichment (T1).
//
//   node tests/fixtures/enrichment/generate.mjs
//
// Writes next to this script:
//   compendium-40.json / compendium-40-expected.json   C18-C21, C23, M9, M10
//   spellcasting.json / spellcasting-expected.json     C22, M11
// `items-500-text` (M7) is built at run time by tests/support/items-500.mjs.
//
// The expectations below are WRITTEN BY HAND from the pack contents (dnd5e 6.0.6) and the rules of the
// spec; they are not produced by the analyzer. Default order (modern rules): spells24, equipment24,
// monsterfeatures24, spells, items, monsterfeatures, tradegoods. Pack-level ambiguity = several
// documents of the same type and normalized name in the first pack that has one.
//
// Expectation vocabulary: "<pack>|<document name>" (found), "none", "ambiguous", "skip" (Multiattack).
// Extracted values (`facts`) are chosen to differ from any compendium value (+17, DC 23, 18d10...).
// Facts use the canonical forms of the plan de test: attack "melee/weapon +17", range "reach 10",
// damage ["1d4+7 piercing"], save "dex 23 half", template "cone 30", uses "recharge 4" / "3/day",
// activation "bonus 1".
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
let state = 20261014;
const id = () => {
  let out = "";
  for (let i = 0; i < 16; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out += ALPHABET[(state >>> 24) % ALPHABET.length];
  }
  return out;
};

const html = (name, header, text) => `<p>${header ? `<small>${header}</small><br/>` : ""}<strong>${name}.</strong> ${text}</p>`;

function item(row) {
  const [type, name, text, expect, facts = {}, header = "Action"] = row;
  const system = { description: { value: text ? html(name, header, text) : "" } };
  if (facts.quantity) system.quantity = facts.quantity;
  return { doc: { _id: id(), name, type, system }, truth: { name, type, expect, facts, hasText: !!text } };
}

function actor(name, rows, extra = {}) {
  const built = rows.map(item);
  return {
    doc: {
      _id: id(), name, type: "npc", img: "icons/svg/mystery-man.svg",
      system: { attributes: { hp: { value: 100, max: 100 }, ac: { value: 15 } }, abilities: { str: { value: 10 }, int: { value: 14 } }, ...extra },
      items: built.map((b) => b.doc), flags: {}
    },
    truth: { name, items: built.map((b) => b.truth) }
  };
}

const MF24 = "dnd5e.monsterfeatures24", MF = "dnd5e.monsterfeatures", S24 = "dnd5e.spells24", E24 = "dnd5e.equipment24";

// ---- compendium-40 ----------------------------------------------------------------------------------
const compendium = [
  actor("Archmage Test", [
    ["spell", "Fireball", "Each creature in a 20-foot-radius sphere centered on that point must make a DC 23 Dexterity saving throw, taking 35 (10d6) fire damage on a failed save, or half as much damage on a successful one.", `${S24}|Fireball`, { save: "dex 23 half", damage: ["10d6 fire"], template: "sphere 20" }, ""],
    ["spell", "Shield", "", `${S24}|Shield`],
    ["spell", "Mage Hand", "", `${S24}|Mage Hand`],
    ["spell", "Counterspell", "", `${S24}|Counterspell`],
    ["spell", "Misty Step", "", `${S24}|Misty Step`],
    ["spell", "Magic Missile", "", `${S24}|Magic Missile`],
    ["spell", "Detect Magic", "", `${S24}|Detect Magic`],
    ["spell", "Darkness", "", `${S24}|Darkness`],
    ["spell", "Hellish Rebuke", "", `${S24}|Hellish Rebuke`],
    ["spell", "Boule de feu", "", "none"],
    ["feat", "Fireball", "", "none"],
    ["feat", "Shield", "The creature adds 5 to its AC against one attack that would hit it.", `${MF}|Shield`, { activation: "reaction 1" }, "Reaction"],
    ["equipment", "Shield", "", `${E24}|Shield`],
    ["weapon", "Dagger", "Melee Weapon Attack: +17 to hit, reach 10 ft., one target. Hit: 9 (1d4 + 7) piercing damage.", `${E24}|Dagger`, { attack: "melee/weapon +17", range: "reach 10", target: "1 creature", damage: ["1d4+7 piercing"], quantity: 4 }, ""],
    ["weapon", "Longsword", "", `${E24}|Longsword`, { quantity: 2 }],
    ["equipment", "Plate Armor", "", `${E24}|Plate Armor`],
    ["equipment", "Chain Mail", "", `${E24}|Chain Mail`],
    ["consumable", "Torch", "", "ambiguous"],
    ["loot", "Marshal Undead", "Allies gain advantage.", "none"]
  ]),
  actor("Undead Test", [
    ["feat", "Legendary Resistance (3/Day)", "If the creature fails a saving throw, it can choose to succeed instead.", `${MF24}|Legendary Resistance`, { legres: 3 }, "Legendary Resistance"],
    ["feat", "Invisibility", "", `${MF24}|Invisibility`],
    ["feat", "Incorporeal Movement", "", `${MF24}|Incorporeal Movement`],
    ["feat", "Magic Resistance", "", `${MF24}|Magic Resistance`],
    ["feat", "Amorphous", "", `${MF24}|Amorphous`],
    ["feat", "Shadow Stealth", "", `${MF24}|Shadow Stealth`],
    ["feat", "Agile", "", `${MF24}|Agile`],
    ["feat", "Pack Tactics", "", `${MF24}|Pack Tactics`],
    ["feat", "Charge", "The creature moves 20 feet and makes one attack as a bonus action.", `${MF24}|Charge`, { activation: "bonus 1" }, "Bonus Action"],
    ["feat", "Siege Monster", "", `${MF24}|Siege Monster`],
    ["feat", "Life Drain", "", `${MF24}|Life Drain`],
    ["feat", "Regeneration", "", `${MF24}|Regeneration`],
    ["feat", "Turn Immunity", "", `${MF}|Turn Immunity`],
    ["feat", "Parry", "", `${MF24}|Parry`],
    ["feat", "Spider Climb", "", `${MF24}|Spider Climb`],
    ["feat", "Vampire Weaknesses", "", `${MF}|Vampire Weaknesses`],
    ["feat", "Immutable Form", "", `${MF24}|Immutable Form`],
    ["feat", "Innate Spellcasting", "", `${MF}|Innate Spellcasting`],
    ["feat", "Paralyzing Touch", "", `${MF}|Paralyzing Touch`],
    ["feat", "Disrupt Life (3/Day)", "Each non-undead creature within 20 feet must make a DC 21 Constitution saving throw, taking 24 (7d6) necrotic damage on a failed save, or half as much damage on a successful one.", `${MF24}|Disrupt Life`, { save: "con 21 half", damage: ["7d6 necrotic"], uses: "3/day" }],
    ["feat", "Rejuvenation", "", `${MF}|Rejuvenation`],
    ["feat", "False Appearance", "", `${MF}|False Appearance`],
    ["feat", "Multiattack", "The creature makes two Slam attacks.", "skip"],
    ["feat", "Indomitable", "The creature can reroll a failed saving throw.", "none"],
    ["feat", "Sneak Attack", "", `${MF}|Sneak Attack`],
    ["weapon", "Slam", "+15 to hit, reach 15 ft., one target. Hit: 22 (4d8 + 4) bludgeoning damage.", `${MF24}|Slam`, { attack: "+15", range: "reach 15", target: "1 creature", damage: ["4d8+4 bludgeoning"] }],
    ["weapon", "Bite", "Melee Weapon Attack: +19 to hit, reach 5 ft., one target. Hit: 31 (5d10 + 4) piercing damage.", `${MF24}|Bite`, { attack: "melee/weapon +19", range: "reach 5", target: "1 creature", damage: ["5d10+4 piercing"] }],
    ["weapon", "Withering Touch", "", `${MF24}|Withering Touch`],
    ["feat", "Fire Breath (Recharge 4–6)", "The creature exhales fire in a 30-foot cone. Each creature in that area must make a DC 23 Dexterity saving throw, taking 99 (18d10) fire damage on a failed save, or half as much damage on a successful one.", `${MF24}|Fire Breath`, { save: "dex 23 half", damage: ["18d10 fire"], template: "cone 30", uses: "recharge 4" }],
    ["feat", "Frightful Presence", "", `${MF24}|Frightful Presence`],
    ["feat", "Death Burst", "", `${MF24}|Death Burst`],
    ["feat", "Undead Fortitude", "", `${MF24}|Undead Fortitude`],
    ["feat", "Hold Breath", "", `${MF24}|Hold Breath`],
    ["feat", "Horrifying Visage", "", `${MF}|Horrifying Visage`],
    ["feat", "Everfrost Aura", "Creatures that start their turn within 15 feet must succeed on a DC 19 Constitution saving throw.", "none"],
    ["feat", "Spellcasting", "", `${MF24}|Spellcasting`]
  ], { resources: { legact: { max: 0 }, legres: { max: 0 } } })
];

const compendiumTruth = compendium.map((a) => a.truth);
const count = compendiumTruth.flatMap((a) => a.items).length;
if (count < 40) throw new Error(`compendium-40 has only ${count} items`);

// ---- spellcasting ------------------------------------------------------------------------------------
// Each spell: { name, method, uses, level, expect }. Method: atwill | innate | cantrip | slots.
// All listed English spells exist in both dnd5e.spells and dnd5e.spells24 (checked), so the first pack
// of the default order (spells24) is expected. French names and invented spells are not found.
const sp = (names, method, uses, level) => names.map((n) => ({ name: n, method, uses, level, expect: `${S24}|${n}` }));
const un = (names, method, uses, level) => names.map((n) => ({ name: n, method, uses, level, expect: "none" }));

const casters = [
  {
    name: "Mage 2014", language: "en",
    trait: ["Spellcasting", "<p><strong>Spellcasting.</strong> The mage is a 9th-level spellcaster. Its spellcasting ability is Intelligence (spell save DC 17, +9 to hit with spell attacks). The mage has the following wizard spells prepared:</p><p>Cantrips (at will): fire bolt, light, mage hand, prestidigitation</p><p>1st level (4 slots): detect magic, mage armor, magic missile, shield</p><p>2nd level (3 slots): misty step, suggestion</p><p>3rd level (3 slots): counterspell, fireball, fly</p><p>4th level (3 slots): greater invisibility, ice storm</p><p>5th level (1 slot): cone of cold, arcane whisper</p>"],
    expected: {
      ability: "int", dc: 17, attack: 9, slots: { 1: 4, 2: 3, 3: 3, 4: 3, 5: 1 },
      spells: [
        ...sp(["Fire Bolt", "Light", "Mage Hand", "Prestidigitation"], "cantrip", null, 0),
        ...sp(["Detect Magic", "Mage Armor", "Magic Missile", "Shield"], "slots", null, 1),
        ...sp(["Misty Step", "Suggestion"], "slots", null, 2),
        ...sp(["Counterspell", "Fireball", "Fly"], "slots", null, 3),
        ...sp(["Greater Invisibility", "Ice Storm"], "slots", null, 4),
        ...sp(["Cone of Cold"], "slots", null, 5),
        ...un(["Arcane Whisper"], "slots", null, 5)
      ]
    }
  },
  {
    name: "Djinni 2014", language: "en",
    trait: ["Innate Spellcasting", "<p><strong>Innate Spellcasting.</strong> The djinni's innate spellcasting ability is Charisma (spell save DC 17, +9 to hit with spell attacks). It can innately cast the following spells, requiring no material components:</p><p>At will: detect evil and good, detect magic, thunderwave</p><p>3/day each: create food and water, tongues, wind walk</p><p>1/day each: conjure elemental, creation, gaseous form, invisibility, major image, plane shift</p>"],
    expected: {
      ability: "cha", dc: 17, attack: 9, slots: {},
      spells: [
        ...sp(["Detect Evil and Good", "Detect Magic", "Thunderwave"], "atwill", null, null),
        ...sp(["Create Food and Water", "Tongues", "Wind Walk"], "innate", 3, null),
        ...sp(["Conjure Elemental", "Creation", "Gaseous Form", "Invisibility", "Major Image", "Plane Shift"], "innate", 1, null)
      ]
    }
  },
  {
    name: "Lich 2024", language: "en",
    trait: ["Spellcasting", "<p><strong>Spellcasting.</strong> The lich casts one of the following spells, using Intelligence as the spellcasting ability (spell save DC 20, +12 to hit with spell attacks):</p><p><strong>At Will:</strong> <em>@UUID[Compendium.dnd5e.spells24.Item.phbsplMageHand00]{Mage Hand}</em>, <em>Detect Magic</em>, <em>Prestidigitation</em></p><p><strong>2/Day Each:</strong> <em>Animate Dead</em>, <em>Dimension Door</em>, <em>Plane Shift</em></p><p><strong>1/Day Each:</strong> <em>Chain Lightning</em>, <em>@UUID[Compendium.dnd5e.spells24.Item.phbsplFingerOfDea]{Finger of Death}</em>, <em>Power Word Kill</em>, <em>Soul Siphon</em></p>"],
    expected: {
      ability: "int", dc: 20, attack: 12, slots: {},
      spells: [
        ...sp(["Mage Hand", "Detect Magic", "Prestidigitation"], "atwill", null, null),
        ...sp(["Animate Dead", "Dimension Door", "Plane Shift"], "innate", 2, null),
        ...sp(["Chain Lightning", "Finger of Death", "Power Word Kill"], "innate", 1, null),
        ...un(["Soul Siphon"], "innate", 1, null)
      ]
    }
  },
  {
    name: "Sorcier FR", language: "fr",
    trait: ["Incantation innée", "<p><strong>Incantation innée.</strong> La caractéristique d'incantation innée du sorcier est le Charisme (DD du jet de sauvegarde des sorts 15, +7 au toucher avec les attaques de sort). Il peut lancer les sorts suivants, sans composante matérielle :</p><p>À volonté : détection de la magie, main de mage</p><p>3/jour chacun : boule de feu, vol</p><p>1/jour chacun : image majeure</p>"],
    expected: {
      ability: "cha", dc: 15, attack: 7, slots: {},
      spells: [
        ...un(["détection de la magie", "main de mage"], "atwill", null, null),
        ...un(["boule de feu", "vol"], "innate", 3, null),
        ...un(["image majeure"], "innate", 1, null)
      ]
    }
  },
  {
    name: "Magicien FR", language: "fr",
    trait: ["Incantation", "<p><strong>Incantation.</strong> Le magicien est un lanceur de sorts de niveau 5. Sa caractéristique d'incantation est l'Intelligence (DD du jet de sauvegarde des sorts 14, +6 au toucher avec les attaques de sort). Sorts de magicien préparés :</p><p>Sorts mineurs (à volonté) : trait de feu, lumière</p><p>Niveau 1 (4 emplacements) : bouclier, projectile magique</p><p>Niveau 2 (3 emplacements) : image miroir</p>"],
    expected: {
      ability: "int", dc: 14, attack: 6, slots: { 1: 4, 2: 3 },
      spells: [
        ...un(["trait de feu", "lumière"], "cantrip", null, 0),
        ...un(["bouclier", "projectile magique"], "slots", null, 1),
        ...un(["image miroir"], "slots", null, 2)
      ]
    }
  },
  {
    name: "Warlock 2024", language: "en",
    trait: ["Spellcasting", "<p><strong>Spellcasting.</strong> The warlock uses Charisma as its spellcasting ability (spell save DC 15, +7 to hit with spell attacks):</p><p><strong>At Will:</strong> <em>Minor Illusion</em>, <em>Disguise Self</em></p><p><strong>2/Day Each:</strong> <em>Hold Person</em>, <em>Fear</em>, <em>Hex Whisper</em></p><p><strong>1/Day Each:</strong> <em>Haste</em>, <em>Dispel Magic</em></p>"],
    expected: {
      ability: "cha", dc: 15, attack: 7, slots: {},
      spells: [
        ...sp(["Minor Illusion", "Disguise Self"], "atwill", null, null),
        ...sp(["Hold Person", "Fear"], "innate", 2, null),
        ...un(["Hex Whisper"], "innate", 2, null),
        ...sp(["Haste", "Dispel Magic"], "innate", 1, null)
      ]
    }
  }
];

const spellActors = casters.map((c) => {
  const feat = { _id: id(), name: c.trait[0], type: "feat", system: { description: { value: c.trait[1] } } };
  return {
    doc: { _id: id(), name: c.name, type: "npc", img: "icons/svg/mystery-man.svg", system: { attributes: { hp: { value: 50, max: 50 }, ac: { value: 12 } }, abilities: { int: { value: 16 }, cha: { value: 16 } } }, items: [feat], flags: {} },
    truth: { name: c.name, language: c.language, trait: c.trait[0], ...c.expected }
  };
});
const total = spellActors.reduce((n, a) => n + a.truth.spells.length, 0);
if (total < 30) throw new Error(`spellcasting has only ${total} spells`);

const write = (file, data) => writeFileSync(path.join(HERE, file), `${JSON.stringify(data, null, 1)}\n`);
write("compendium-40.json", compendium.map((a) => a.doc));
write("compendium-40-expected.json", {
  order: ["spells24", "equipment24", "monsterfeatures24", "spells", "items", "monsterfeatures", "tradegoods"].map((p) => `dnd5e.${p}`),
  actors: compendiumTruth
});
write("spellcasting.json", spellActors.map((a) => a.doc));
write("spellcasting-expected.json", { actors: spellActors.map((a) => a.truth) });
console.log(`compendium-40: ${count} items; spellcasting: ${total} spells`);
