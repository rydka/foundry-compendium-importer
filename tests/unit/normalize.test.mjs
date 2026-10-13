// C14 (activities), and the pre-validation guarantees of design.md (ids, effects: [], systemVersion).
import { describe, expect, it } from "vitest";
import { normalizeActivities, normalizeEntry } from "../../scripts/core/normalize.mjs";
import { makeIdGen } from "../fixtures/generate.mjs";

const ID = /^[A-Za-z0-9]{16}$/;

describe("normalizeActivities (C14)", () => {
  it("turns an array of activities into an object indexed by _id", () => {
    const system = { activities: [{ _id: "aaaaaaaaaaaaaaaa", type: "attack" }, { _id: "bbbbbbbbbbbbbbbb", type: "save" }] };
    const out = normalizeActivities(system, makeIdGen(1)) ?? system;
    expect(Array.isArray(out.activities)).toBe(false);
    expect(Object.keys(out.activities).sort()).toEqual(["aaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbb"]);
    expect(out.activities.aaaaaaaaaaaaaaaa.type).toBe("attack");
  });

  it("creates an _id for an activity that has none, and uses it as the key", () => {
    const system = { activities: [{ type: "attack" }] };
    const out = normalizeActivities(system, makeIdGen(2)) ?? system;
    const entries = Object.entries(out.activities);
    expect(entries).toHaveLength(1);
    const [key, activity] = entries[0];
    expect(activity._id).toMatch(ID);
    expect(key).toBe(activity._id);
  });

  it("keeps an object of activities indexed by _id and fills a missing _id", () => {
    const system = { activities: { kkkkkkkkkkkkkkkk: { type: "heal" }, mmmmmmmmmmmmmmmm: { _id: "mmmmmmmmmmmmmmmm", type: "utility" } } };
    const out = normalizeActivities(system, makeIdGen(3)) ?? system;
    for (const [key, activity] of Object.entries(out.activities)) {
      expect(activity._id).toBeTruthy();
      expect(key).toBe(activity._id);
    }
    expect(Object.keys(out.activities)).toHaveLength(2);
    expect(out.activities.mmmmmmmmmmmmmmmm.type).toBe("utility");
  });

  it("leaves a system without activities alone", () => {
    const system = { quantity: 2 };
    const out = normalizeActivities(system, makeIdGen(4)) ?? system;
    expect(out.quantity).toBe(2);
    expect(out.activities === undefined || Object.keys(out.activities).length === 0).toBe(true);
  });

  it("treats an empty array as no activity (empty object)", () => {
    const out = normalizeActivities({ activities: [] }, makeIdGen(5)) ?? { activities: [] };
    expect(Array.isArray(out.activities)).toBe(false);
    expect(Object.keys(out.activities)).toHaveLength(0);
  });
});

describe("normalizeEntry: ids and effects", () => {
  const opts = (extra = {}) => ({ documentName: "Item", idGen: makeIdGen(7), systemVersion: "6.0.6", ...extra });

  it("adds an _id on the document when missing and keeps an existing one", () => {
    expect(normalizeEntry({ name: "A", type: "loot", system: {} }, opts()).data._id).toMatch(ID);
    expect(normalizeEntry({ _id: "keepkeepkeepkeep", name: "A", type: "loot", system: {} }, opts()).data._id).toBe("keepkeepkeepkeep");
  });

  it("adds effects: [] on an item", () => {
    expect(normalizeEntry({ name: "A", type: "loot", system: {} }, opts()).data.effects).toEqual([]);
  });

  it("gives an _id to effects of an item", () => {
    const { data } = normalizeEntry({ name: "A", type: "equipment", system: {}, effects: [{ name: "Glow" }] }, opts());
    expect(data.effects[0]._id).toMatch(ID);
  });

  it("gives _id and effects: [] to the nested items of an actor, and an _id to their effects", () => {
    const entry = {
      name: "Boss", type: "npc", system: {},
      items: [{ name: "Sword", type: "weapon", system: {} }, { name: "Ring", type: "equipment", system: {}, effects: [{ name: "Fx" }] }],
      effects: [{ name: "Aura" }]
    };
    const { data } = normalizeEntry(entry, opts({ documentName: "Actor" }));
    expect(data._id).toMatch(ID);
    expect(data.effects[0]._id).toMatch(ID);
    expect(data.items[0]._id).toMatch(ID);
    expect(data.items[0].effects).toEqual([]);
    expect(data.items[1].effects[0]._id).toMatch(ID);
  });

  it("generates distinct ids", () => {
    const entry = { name: "Boss", type: "npc", system: {}, items: [{ name: "a", type: "loot" }, { name: "b", type: "loot" }] };
    const { data } = normalizeEntry(entry, opts({ documentName: "Actor" }));
    const ids = [data._id, data.items[0]._id, data.items[1]._id];
    expect(new Set(ids).size).toBe(3);
  });

  it("normalizes the activities of the item and of nested items (array to object)", () => {
    const item = { name: "Axe", type: "weapon", system: { activities: [{ type: "attack" }] } };
    expect(Array.isArray(normalizeEntry(item, opts()).data.system.activities)).toBe(false);
    const actor = { name: "Boss", type: "npc", system: {}, items: [{ name: "Axe", type: "weapon", system: { activities: [{ type: "attack" }] } }] };
    const nested = normalizeEntry(actor, opts({ documentName: "Actor" })).data.items[0].system.activities;
    expect(Array.isArray(nested)).toBe(false);
    expect(Object.values(nested)[0]._id).toBeTruthy();
  });

  it("does not choke on an entry without system or items", () => {
    expect(() => normalizeEntry({ name: "Bare", type: "loot" }, opts())).not.toThrow();
    expect(() => normalizeEntry({ name: "Bare", type: "npc" }, opts({ documentName: "Actor" }))).not.toThrow();
  });
});

describe("normalizeEntry: system version (design Q1)", () => {
  const opts = { documentName: "Item", idGen: makeIdGen(9), systemVersion: "6.0.6" };

  it("keeps a declared _stats.systemVersion and reports it as declaredVersion", () => {
    const { data, declaredVersion } = normalizeEntry({ name: "Old", type: "loot", system: {}, _stats: { systemVersion: "3.3.1" } }, opts);
    expect(data._stats.systemVersion).toBe("3.3.1");
    expect(declaredVersion).toBe("3.3.1");
  });

  it("adds the current system version when none is declared, and reports no declared version", () => {
    const { data, declaredVersion } = normalizeEntry({ name: "Tools", type: "loot", system: {} }, opts);
    expect(data._stats.systemVersion).toBe("6.0.6");
    expect(declaredVersion ?? null).toBeNull();
  });

  it("keeps the other _stats keys", () => {
    const { data } = normalizeEntry({ name: "Old", type: "loot", system: {}, _stats: { systemVersion: "3.3.1", coreVersion: "12.331" } }, opts);
    expect(data._stats.coreVersion).toBe("12.331");
  });
});
