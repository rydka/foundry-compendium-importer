import { describe, expect, it } from "vitest";
import { findReplacedPaths } from "../../scripts/core/conformity.mjs";

describe("findReplacedPaths, removed fields", () => {
  it("does not report a key absent from the cleaned data (it is a dropped field)", () => {
    expect(findReplacedPaths({ system: { gone: "x", list: ["a", "b"] } }, { system: { list: ["a"] } })).toEqual([]);
  });
});
