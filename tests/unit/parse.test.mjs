// C9, C10: reading .db / .json files. Uses the generated fixtures in tests/fixtures/formats.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FORMAT_ITEM_NAMES } from "../fixtures/generate.mjs";
import { ImportFormatError, parseImportFile } from "../../scripts/core/parse.mjs";

const fixture = (name) => readFileSync(new URL(`../fixtures/formats/${name}`, import.meta.url), "utf8");
const names = (entries) => entries.map((e) => e.name);

function failure(text, file) {
  try {
    parseImportFile(text, file);
  } catch (err) {
    return err;
  }
  return null;
}

describe("parseImportFile: accepted shapes (C9)", () => {
  it.each([
    "items.db",
    "items-crlf.db",
    "array.json",
    "entries.json",
    "documents.json",
    "items-key.json",
    "data.json",
    "array-bom.json"
  ])("reads the 3 documents of %s", (file) => {
    const { entries } = parseImportFile(fixture(file), file);
    expect(names(entries)).toEqual(FORMAT_ITEM_NAMES);
  });

  it("keeps documents of other types (journal) in the entries", () => {
    const { entries } = parseImportFile(fixture("mixed-types.json"), "mixed-types.json");
    expect(entries).toHaveLength(4);
  });

  it("returns the declared document type of a compendium export in meta", () => {
    const { meta } = parseImportFile(fixture("entries.json"), "entries.json");
    expect(meta.docType).toBe("Item");
  });

  it("has no declared type for a bare array", () => {
    const { meta } = parseImportFile(fixture("array.json"), "array.json");
    expect(meta?.docType).toBeUndefined();
  });

  it("reads a .db with blank lines and a single document", () => {
    const text = `\n${JSON.stringify({ name: "Solo", type: "loot" })}\n\n`;
    expect(parseImportFile(text, "solo.db").entries).toHaveLength(1);
  });

  it("recognizes an uppercase extension", () => {
    expect(parseImportFile(fixture("array.json"), "ITEMS.JSON").entries).toHaveLength(3);
  });
});

describe("parseImportFile: errors (C10)", () => {
  it("raises ImportFormatError 'empty' for an empty file", () => {
    const err = failure(fixture("empty.json"), "empty.json");
    expect(err).toBeInstanceOf(ImportFormatError);
    expect(err.code).toBe("empty");
  });

  it("raises 'empty' for a whitespace-only file", () => {
    expect(failure(fixture("whitespace.json"), "w.json")?.code).toBe("empty");
  });

  it("raises 'invalidJson' for a truncated json", () => {
    const err = failure(fixture("broken.json"), "broken.json");
    expect(err).toBeInstanceOf(ImportFormatError);
    expect(err.code).toBe("invalidJson");
  });

  it("raises 'invalidLine' with the line number for a broken .db line", () => {
    const err = failure(fixture("broken-line.db"), "broken-line.db");
    expect(err).toBeInstanceOf(ImportFormatError);
    expect(err.code).toBe("invalidLine");
    expect(err.line).toBe(2);
  });

  it.each(["empty-object.json", "empty-array.json", "empty-entries.json"])("raises 'noDocuments' for %s", (file) => {
    const err = failure(fixture(file), file);
    expect(err).toBeInstanceOf(ImportFormatError);
    expect(err.code).toBe("noDocuments");
  });

  it("is an Error subclass with a message", () => {
    const err = failure("", "x.json");
    expect(err).toBeInstanceOf(Error);
    expect(typeof err.message).toBe("string");
  });
});
