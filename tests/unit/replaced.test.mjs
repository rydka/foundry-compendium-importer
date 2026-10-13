// B1: values replaced by cleaning and unknown activity types are reported.
import { describe, expect, it } from "vitest";
import { checkActivityTypes, findReplacedPaths } from "../../scripts/core/conformity.mjs";

describe("findReplacedPaths", () => {
  it("reports a system object replaced by an empty object", () => {
    expect(findReplacedPaths({ system: "oops" }, { system: {} })).toEqual(["system"]);
  });

  it("reports a nested value turned into NaN or null", () => {
    const before = { items: [{ name: "Loot", system: { quantity: "beaucoup", price: { value: "x" } } }] };
    const after = { items: [{ name: "Loot", system: { quantity: Number.NaN, price: { value: null } } }] };
    expect(findReplacedPaths(before, after)).toEqual(["items[Loot].system.quantity", "items[Loot].system.price.value"]);
  });

  it("accepts plain conversions, added defaults and missing keys", () => {
    expect(findReplacedPaths({ system: { quantity: "3", other: 1, list: ["a", "b"] } }, { system: { quantity: 3, extra: 0, list: ["a"] } })).toEqual([]);
  });

  it("ignores empty strings and null in the source", () => {
    expect(findReplacedPaths({ system: { a: "", b: null } }, { system: { a: null, b: 0 } })).toEqual([]);
  });

  it("reports an array turned into an object", () => {
    expect(findReplacedPaths({ system: { parts: [1] } }, { system: { parts: {} } })).toEqual(["system.parts"]);
  });
});

describe("checkActivityTypes", () => {
  const known = ["attack", "save"];

  it("accepts known types", () => {
    expect(checkActivityTypes({ name: "A", system: { activities: { a: { type: "attack" } } } }, known)).toEqual([]);
  });

  it("rejects an unknown or missing type, also in embedded items", () => {
    const data = { name: "Actor", items: [{ name: "Bow", system: { activities: { z: { type: "zap" }, y: {} } } }] };
    const reasons = checkActivityTypes(data, known);
    expect(reasons).toHaveLength(2);
    expect(reasons[0].data).toMatchObject({ type: "zap", item: "Bow" });
  });
});
