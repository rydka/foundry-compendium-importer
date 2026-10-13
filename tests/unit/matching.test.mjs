// C12 (overwrite targets) and C22 (id conflicts).
import { describe, expect, it } from "vitest";
import { findIdConflicts, findOverwriteTargets, nameKey } from "../../scripts/core/matching.mjs";

describe("nameKey", () => {
  it("ignores case and surrounding / repeated whitespace", () => {
    expect(nameKey("  Long   Sword ")).toBe(nameKey("long sword"));
  });

  it("distinguishes different names", () => {
    expect(nameKey("Longsword")).not.toBe(nameKey("Shortsword"));
  });

  it("handles missing names", () => {
    expect(() => nameKey(undefined)).not.toThrow();
    expect(nameKey(undefined)).toBe(nameKey(""));
  });
});

describe("findOverwriteTargets (C12)", () => {
  const index = [
    { _id: "id00000000000001", name: "Longsword", type: "weapon" },
    { _id: "id00000000000002", name: "Longsword", type: "loot" },
    { _id: "id00000000000003", name: "Rope", type: "loot" },
    { _id: "id00000000000004", name: "Goblin", type: "npc" }
  ];

  it("matches name and type first", () => {
    expect(findOverwriteTargets(index, [{ name: "Longsword", type: "loot" }])).toEqual(["id00000000000002"]);
  });

  it("falls back to the name alone when the type does not match", () => {
    const targets = findOverwriteTargets(index, [{ name: "Rope", type: "weapon" }]);
    expect(targets).toEqual(["id00000000000003"]);
  });

  it("matches when the entry has no type", () => {
    expect(findOverwriteTargets(index, [{ name: "Goblin" }])).toEqual(["id00000000000004"]);
  });

  it("is case and whitespace insensitive", () => {
    expect(findOverwriteTargets(index, [{ name: "  goblin ", type: "npc" }])).toEqual(["id00000000000004"]);
  });

  it("returns each existing id once even when several entries match it", () => {
    const targets = findOverwriteTargets(index, [{ name: "Rope", type: "loot" }, { name: "rope", type: "loot" }]);
    expect(targets).toEqual(["id00000000000003"]);
  });

  it("returns [] when nothing matches or the entry has no name", () => {
    expect(findOverwriteTargets(index, [{ name: "Nothing", type: "loot" }, { type: "loot" }])).toEqual([]);
  });

  it("returns [] for an empty index", () => {
    expect(findOverwriteTargets([], [{ name: "Rope", type: "loot" }])).toEqual([]);
  });
});

describe("findIdConflicts (C22)", () => {
  const index = [
    { _id: "id00000000000001", name: "A", type: "loot" },
    { _id: "id00000000000002", name: "B", type: "loot" }
  ];

  it("returns the file ids that already exist in the pack", () => {
    const entries = [{ _id: "id00000000000001", name: "A2" }, { _id: "newnewnewnewnew1", name: "C" }];
    expect([...findIdConflicts(index, entries, [])]).toEqual(["id00000000000001"]);
  });

  it("ignores ids that the overwrite is about to remove", () => {
    const entries = [{ _id: "id00000000000001", name: "A" }, { _id: "id00000000000002", name: "B" }];
    expect([...findIdConflicts(index, entries, ["id00000000000001"])]).toEqual(["id00000000000002"]);
  });

  it("returns an empty set when entries have no _id or nothing is shared", () => {
    expect(findIdConflicts(index, [{ name: "A" }], []).size).toBe(0);
    expect(findIdConflicts(index, [{ _id: "zzzzzzzzzzzzzzzz" }], []).size).toBe(0);
  });

  it("returns a Set", () => {
    expect(findIdConflicts(index, [], [])).toBeInstanceOf(Set);
  });
});
