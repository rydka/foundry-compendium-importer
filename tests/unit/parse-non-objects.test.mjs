import { describe, expect, it } from "vitest";
import { parseImportFile } from "../../scripts/core/parse.mjs";

describe("parseImportFile, non-object entries", () => {
  it("keeps them so that the analysis can reject them visibly", () => {
    expect(parseImportFile('[{"name":"a"}, 3, null]', "x.json").entries).toEqual([{ name: "a" }, 3, null]);
    expect(parseImportFile('{"name":"a"}\n"text"', "x.db").entries).toEqual([{ name: "a" }, "text"]);
  });
});
