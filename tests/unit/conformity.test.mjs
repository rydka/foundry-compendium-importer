// C18-C21: pure pieces of the conformity check.
import { describe, expect, it } from "vitest";
import { checkType, describeFailures, findDroppedPaths, isOlderThan, summarize } from "../../scripts/core/conformity.mjs";
import { LEGACY_TYPE_ALIASES } from "../../scripts/constants.mjs";

const ITEM_TYPES = ["weapon", "equipment", "consumable", "tool", "loot", "container", "spell", "feat"];

describe("checkType (C18)", () => {
  it("accepts a known type", () => {
    expect(checkType("weapon", ITEM_TYPES, {})).toBeNull();
  });

  it("accepts a legacy alias (backpack for container)", () => {
    expect(checkType("backpack", ITEM_TYPES, LEGACY_TYPE_ALIASES.Item)).toBeNull();
  });

  it("rejects an unknown type with a {key, data} reason that names the type", () => {
    const reason = checkType("weapon2", ITEM_TYPES, LEGACY_TYPE_ALIASES.Item);
    expect(reason).not.toBeNull();
    expect(typeof reason.key).toBe("string");
    expect(reason.key.length).toBeGreaterThan(0);
    expect(JSON.stringify(reason)).toContain("weapon2");
  });

  it("rejects a missing type", () => {
    expect(checkType(undefined, ITEM_TYPES, {})).not.toBeNull();
  });

  it("does not accept the alias when no alias table is given", () => {
    expect(checkType("backpack", ITEM_TYPES, {})).not.toBeNull();
  });
});

describe("findDroppedPaths (C18)", () => {
  const opts = { scope: "system", embedded: ["items", "effects"] };

  it("returns [] when nothing was dropped", () => {
    const doc = { name: "A", system: { quantity: 1, price: { value: 5 } } };
    expect(findDroppedPaths(doc, structuredClone(doc), opts)).toEqual([]);
  });

  it("returns [] when only values changed", () => {
    expect(findDroppedPaths({ system: { quantity: "3" } }, { system: { quantity: 3 } }, opts)).toEqual([]);
  });

  it("lists a dropped key of system", () => {
    expect(findDroppedPaths({ system: { quantity: 1, foo: "bar" } }, { system: { quantity: 1 } }, opts)).toEqual(["system.foo"]);
  });

  it("lists a deep dropped key with its full path", () => {
    const before = { system: { price: { value: 1, coin: "gp" } } };
    const after = { system: { price: { value: 1 } } };
    expect(findDroppedPaths(before, after, opts)).toEqual(["system.price.coin"]);
  });

  it("ignores keys added by the cleaning", () => {
    expect(findDroppedPaths({ system: {} }, { system: { quantity: 1 } }, opts)).toEqual([]);
  });

  it("ignores dropped keys outside system (name, flags...) at the top level", () => {
    const before = { name: "A", system: {}, bogusTop: 1, flags: { x: 1 } };
    expect(findDroppedPaths(before, { name: "A", system: {}, flags: {} }, opts)).toEqual([]);
  });

  it("names the nested item in the path of a dropped key", () => {
    const before = { name: "Boss", system: {}, items: [{ _id: "i1i1i1i1i1i1i1i1", name: "Épée longue", system: { foo: 1, quantity: 1 } }] };
    const after = { name: "Boss", system: {}, items: [{ _id: "i1i1i1i1i1i1i1i1", name: "Épée longue", system: { quantity: 1 } }] };
    expect(findDroppedPaths(before, after, opts)).toEqual(["items[Épée longue].system.foo"]);
  });

  it("works with the default options", () => {
    expect(findDroppedPaths({ system: { foo: 1 } }, { system: {} })).toEqual(["system.foo"]);
  });
});

describe("describeFailures (C20)", () => {
  it("returns one reason {key, data} per failure", () => {
    const failures = { "system.quantity": { message: "is not a number" }, "system.weight.value": { message: "is not a number" } };
    const reasons = describeFailures(failures, {});
    expect(reasons).toHaveLength(2);
    for (const r of reasons) expect(typeof r.key).toBe("string");
  });

  it("mentions the field path in each reason", () => {
    const [reason] = describeFailures({ "system.quantity": { message: "is not a number" } }, {});
    expect(JSON.stringify(reason)).toContain("quantity");
  });

  it("names the embedded item (by name, not by id) for a nested failure", () => {
    const [reason] = describeFailures({ "items.abcdefghijklmnop.system.quantity": { message: "is not a number" } }, { abcdefghijklmnop: "Épée longue" });
    const text = JSON.stringify(reason);
    expect(text).toContain("Épée longue");
    expect(text).toContain("quantity");
  });

  it("returns [] when there is no failure", () => {
    expect(describeFailures({}, {})).toEqual([]);
  });
});

describe("isOlderThan", () => {
  it("is true for older versions", () => {
    expect(isOlderThan("3.3.1", "6.0.0")).toBe(true);
    expect(isOlderThan("5.9.9", "6.0.0")).toBe(true);
  });

  it("is false for equal and newer versions", () => {
    expect(isOlderThan("6.0.0", "6.0.0")).toBe(false);
    expect(isOlderThan("6.0.6", "6.0.0")).toBe(false);
  });

  it("compares numerically, not as text", () => {
    expect(isOlderThan("10.0.0", "6.0.0")).toBe(false);
    expect(isOlderThan("4.10.0", "4.9.0")).toBe(false);
  });
});

describe("summarize (C21)", () => {
  // Assumed input: the output of analyzeEntries plus the lists computed by the application.
  const count = (v) => (Array.isArray(v) ? v.length : v);
  const results = {
    accepted: [{ name: "A", updated: false }, { name: "B", updated: true }, { name: "C", updated: true }],
    rejected: [{ name: "D", type: "loot", reasons: [{ key: "k", data: {} }] }],
    other: [{ name: "Journal" }, { name: "Table" }]
  };

  it("counts conforming documents, updated documents and others separately", () => {
    const s = summarize(results);
    expect(count(s.conform)).toBe(3);
    expect(count(s.updated)).toBe(2);
    expect(count(s.other)).toBe(2);
  });

  it("keeps the rejected documents with their reasons", () => {
    const s = summarize(results);
    expect(s.rejected).toHaveLength(1);
    expect(s.rejected[0]).toMatchObject({ name: "D", type: "loot" });
    expect(s.rejected[0].reasons).toHaveLength(1);
  });
});
