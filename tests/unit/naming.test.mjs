// C11: pack name proposals.
import { describe, expect, it } from "vitest";
import { slugify, suggestPackFields, worldPackId } from "../../scripts/core/naming.mjs";

describe("slugify (C11)", () => {
  it("lowercases and replaces runs of other characters by one dash", () => {
    expect(slugify("My Cool  Items!!")).toBe("my-cool-items");
  });

  it("trims leading and trailing dashes", () => {
    expect(slugify("  --Hello--  ")).toBe("hello");
  });

  it("returns an empty string for null, undefined or symbols only", () => {
    expect(slugify(null)).toBe("");
    expect(slugify(undefined)).toBe("");
    expect(slugify("!!!")).toBe("");
  });

  it("limits the result to 64 characters", () => {
    expect(slugify("a".repeat(100))).toHaveLength(64);
  });

  it("only produces characters valid in a pack name", () => {
    expect(slugify("Épée Longue (2024) / v2")).toMatch(/^[a-z0-9-]*$/);
  });
});

describe("suggestPackFields (C11)", () => {
  it("proposes a label and a slug name from the file name without extension", () => {
    const { label, name } = suggestPackFields("undead-actors.json");
    expect(name).toBe("undead-actors");
    expect(label.toLowerCase()).toContain("undead");
    expect(label).not.toMatch(/\.json$/);
  });

  it("strips .db the same way, case-insensitively", () => {
    expect(suggestPackFields("Items.DB").name).toBe("items");
  });

  it("slugifies a file name with spaces", () => {
    expect(suggestPackFields("My Monsters v2.json").name).toBe("my-monsters-v2");
  });
});

describe("worldPackId (C11)", () => {
  it("prefixes with world.", () => {
    expect(worldPackId("my-pack")).toBe("world.my-pack");
  });
});
