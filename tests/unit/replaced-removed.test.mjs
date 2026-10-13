import { describe, expect, it } from "vitest";
import { findReplacedPaths } from "../../scripts/core/conformity.mjs";

describe("findReplacedPaths, removed fields", () => {
  it("does not report a key absent from the cleaned data (it is a dropped field)", () => {
    expect(findReplacedPaths({ system: { gone: "x", list: ["a", "b"] } }, { system: { list: ["a"] } })).toEqual([]);
  });
});

import { findReplaced } from "../../scripts/core/conformity.mjs";

describe("findReplaced", () => {
  it("returns the provided value, truncated", () => {
    const long = "x".repeat(100);
    const [hit] = findReplaced({ system: { a: long } }, { system: { a: null } });
    expect(hit.path).toBe("system.a");
    expect(hit.value.length).toBe(40);
    expect(findReplaced({ system: { a: "oops" } }, { system: { a: null } })[0].value).toBe('"oops"');
  });
});
