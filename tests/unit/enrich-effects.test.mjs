// C25 (challenge rating from the text), C26 (passive effects, "not automated" notes), C27 (no double, re-import changes nothing)
// of enrichEntry and describeReport pieces, against the fake parser.
import { describe, expect, it } from "vitest";
import { enrichEntry } from "../../scripts/core/enrich/enrich.mjs";
import { parseChallengeRating, parseChallengeValue, formatChallengeRating, challengeRatingOf } from "../../scripts/core/challenge.mjs";
import { counter, deepFreeze, makeParser } from "../support/fake-parser.mjs";

const KEY = "compendium-json-importer.Enrich.";
const ctx = (parser, extra = {}) => ({ parser, keys: {}, idGen: counter(), pdfLabel: "PDF", ...extra });
const feat = (name, extra = {}) => ({
  _id: `${name}`.padEnd(16, "0").slice(0, 16), name, type: "feat",
  system: { description: { value: `<p><strong>${name}.</strong> text</p>` }, activities: {} }, ...extra
});
const npc = (system = {}, items = []) => ({ name: "Beast", type: "npc", system, items });
const withBio = (text, system = {}) => npc({ details: { biography: { value: `<p>${text}</p>` } }, ...system });

const REDUCTION_PLAN = {
  effects: [{ kind: "damageReduction", value: 3, scope: "bludgeoning" }, { kind: "damageReduction", value: 3, scope: "piercing" }, { kind: "damageReduction", value: 3, scope: "slashing" }],
  _effects: [{ _id: "eff0000000000001", name: "Heavy Armor Master", transfer: true, changes: [{ key: "system.traits.dm.amount.bludgeoning", mode: 2, value: "-3" }] }]
};

describe("C25: challenge rating from the text", () => {
  it("reads whole numbers, fractions and French wording", () => {
    expect(parseChallengeRating("Challenge 5 (1,800 XP)")).toBe(5);
    expect(parseChallengeRating("<p>Challenge 1/2 (100 XP)</p>")).toBe(0.5);
    expect(parseChallengeRating("Challenge 1/8 (25 XP)")).toBe(0.125);
    expect(parseChallengeRating("Facteur de puissance 1/4")).toBe(0.25);
    expect(parseChallengeRating("Challenge 17 (18,000 XP)")).toBe(17);
    expect(parseChallengeRating("a challenge for the whole party")).toBeNull();
    expect(parseChallengeValue("½")).toBe(0.5);
    expect(formatChallengeRating(0.125)).toBe("1/8");
    expect(formatChallengeRating(17)).toBe("17");
  });

  it("an NPC without a cr takes the one of its biography and reports it", () => {
    const { data, report } = enrichEntry(withBio("Challenge 5 (1,800 XP)"), "Actor", ctx(makeParser()));
    expect(data.system.details.cr).toBe(5);
    expect(report.changes.find((c) => c.key === `${KEY}Cr`)?.data.value).toBe("5");
  });

  it("also reads the description of one of its items", () => {
    const actor = npc({}, [feat("Stats", { system: { description: { value: "<p>Challenge 1/2 (100 XP)</p>" }, activities: {} } })]);
    expect(enrichEntry(actor, "Actor", ctx(makeParser())).data.system.details.cr).toBe(0.5);
  });

  it("a cr already in the file is never modified (C3), even at 0", () => {
    expect(enrichEntry(withBio("Challenge 5 (1,800 XP)", { details: { cr: 3, biography: { value: "<p>Challenge 5 (1,800 XP)</p>" } } }), "Actor", ctx(makeParser())).data.system.details.cr).toBe(3);
    expect(enrichEntry(withBio("Challenge 5 (1,800 XP)", { details: { cr: 0, biography: { value: "<p>Challenge 5 (1,800 XP)</p>" } } }), "Actor", ctx(makeParser())).data.system.details.cr).toBe(0);
  });

  it("no text, no cr invented; characters are left alone", () => {
    expect(enrichEntry(npc(), "Actor", ctx(makeParser())).data.system.details?.cr).toBeUndefined();
    expect(enrichEntry({ ...withBio("Challenge 5 (1,800 XP)"), type: "character" }, "Actor", ctx(makeParser())).data.system.details.cr).toBeUndefined();
    expect(challengeRatingOf(npc())).toBeNull();
  });

  it("does not modify its (frozen) input", () => {
    expect(() => enrichEntry(deepFreeze(withBio("Challenge 5 (1,800 XP)")), "Actor", ctx(makeParser()))).not.toThrow();
  });
});

describe("C26: passive effects", () => {
  it("a passive feature receives the transferred effect built by toEffects, and the report says so", () => {
    const parser = makeParser({ "Heavy Armor Master": REDUCTION_PLAN });
    const { data, report } = enrichEntry(npc({}, [feat("Heavy Armor Master")]), "Actor", ctx(parser));
    const item = data.items[0];
    expect(item.effects).toHaveLength(1);
    expect(item.effects[0].transfer).toBe(true);
    const line = report.items[0].changes.find((c) => c.key === `${KEY}EffectAdded`);
    expect(line.data.name).toBe("Heavy Armor Master");
    expect(line.data.effects).toEqual([{ kind: "damageReduction", value: 3, on: null, scopes: ["bludgeoning", "piercing", "slashing"] }]);
    expect(report.items[0].status).toBe("enriched");
  });

  it("the not-automated remarks of the library reach the report of the item", () => {
    const note = { key: "dnd5e-text-parser.Note.NotAutomated", data: { raw: "advantage on saving throws against spells" } };
    const parser = makeParser({ "Magic Resistance": { effects: [{ kind: "advantage", scope: "spells" }], _effects: [], _effectNotes: [note] } });
    const { data, report } = enrichEntry(npc({}, [feat("Magic Resistance")]), "Actor", ctx(parser));
    expect(report.items[0].notes).toContainEqual(note);
    expect(data.items[0].effects ?? []).toHaveLength(0);
    expect(report.items[0].changes.some((c) => c.key === `${KEY}EffectAdded`)).toBe(false);
  });

  it("a plan without effects adds none, and a library without toEffects is tolerated", () => {
    const { data } = enrichEntry(npc({}, [feat("Plain")]), "Actor", ctx(makeParser({ Plain: { effects: [] } })));
    expect(data.items[0].effects ?? []).toHaveLength(0);
    const parser = makeParser({ "Heavy Armor Master": REDUCTION_PLAN });
    delete parser.toEffects;
    expect(() => enrichEntry(npc({}, [feat("Heavy Armor Master")]), "Actor", ctx(parser))).not.toThrow();
  });
});

describe("C27: no double effect, a re-import changes nothing", () => {
  it("an effect already on the feature is neither modified nor doubled", () => {
    const own = { _id: "own0000000000001", name: "Mine", transfer: true, changes: [{ key: "system.attributes.ac.bonus", mode: 2, value: "1" }] };
    const parser = makeParser({ "Heavy Armor Master": REDUCTION_PLAN });
    const input = feat("Heavy Armor Master", { effects: [own] });
    const { data, report } = enrichEntry(npc({}, [input]), "Actor", ctx(parser));
    expect(data.items[0].effects).toEqual([own]);
    expect(report.items[0]?.changes?.some((c) => c.key === `${KEY}EffectAdded`) ?? false).toBe(false);
  });

  it("enriching the result again gives the same effects", () => {
    const parser = makeParser({ "Heavy Armor Master": REDUCTION_PLAN });
    const first = enrichEntry(npc({}, [feat("Heavy Armor Master")]), "Actor", ctx(parser)).data;
    const second = enrichEntry(first, "Actor", ctx(parser)).data;
    expect(second.items[0].effects).toEqual(first.items[0].effects);
    expect(second.items[0].effects).toHaveLength(1);
  });
});
