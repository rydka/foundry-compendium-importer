// Sanity of the generated data sets themselves (T2): sizes required by the spec, determinism, truth file.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildConformity, buildFormats, buildLegacy3x, makeIdGen } from "../fixtures/generate.mjs";

const read = (name) => JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8"));

describe("fixtures: conformity (M8)", () => {
  const expected = read("conformity-expected.json");
  const items = read("conformity-items.json");
  const actors = read("conformity-actors.json");

  it("has at least 40 documents of which at least 10 are not conforming", () => {
    expect(expected.counts.total).toBeGreaterThanOrEqual(40);
    expect(expected.counts.nonConform).toBeGreaterThanOrEqual(10);
    expect(expected.counts.conform).toBeGreaterThanOrEqual(30);
  });

  it("covers varied defects including the three required families", () => {
    const defects = new Set(expected.documents.filter((d) => !d.conform).map((d) => d.defect));
    expect(defects.size).toBeGreaterThanOrEqual(6);
    for (const required of ["unknownType", "invalidValue", "nestedInvalid"]) expect(defects.has(required)).toBe(true);
  });

  it("has one truth record per document, with unique names", () => {
    expect(expected.documents).toHaveLength(items.length + actors.length);
    const names = [...items, ...actors].map((d) => d.name);
    expect(new Set(names).size).toBe(names.length);
    expect(expected.documents.map((d) => d.name).sort()).toEqual(names.slice().sort());
  });

  it("has unique 16-character ids everywhere", () => {
    const all = [...items, ...actors].flatMap((d) => [d, ...(Array.isArray(d.items) ? d.items : [])]);
    const ids = all.map((d) => d._id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => /^[A-Za-z0-9]{16}$/.test(id))).toBe(true);
  });

  it("only has non conforming documents that declare an up-to-date system version", () => {
    const bad = new Set(expected.documents.filter((d) => !d.conform).map((d) => d.name));
    for (const doc of [...items, ...actors].filter((d) => bad.has(d.name))) expect(doc._stats.systemVersion).toBe("6.0.6");
  });
});

describe("fixtures: legacy 3.x (M9)", () => {
  const docs = read("legacy-3x.json");
  const truth = read("legacy-3x-expected.json");

  it("has at least 10 documents, all declaring systemVersion 3.3.1", () => {
    expect(docs.length).toBeGreaterThanOrEqual(10);
    expect(docs.every((d) => d._stats.systemVersion === "3.3.1")).toBe(true);
  });

  it("gives every item an _id and effects: [] (precondition of initializeActivities)", () => {
    for (const d of docs.filter((x) => x.type !== "npc" && x.type !== "character")) {
      expect(d._id).toBeTruthy();
      expect(d.effects).toEqual([]);
    }
  });

  it("records, per document, whether activities are expected", () => {
    expect(truth).toHaveLength(docs.length);
    expect(truth.filter((t) => t.expectActivities).length).toBeGreaterThanOrEqual(5);
  });
});

describe("fixtures: determinism", () => {
  it("makeIdGen yields the same sequence for the same seed", () => {
    const a = makeIdGen(5);
    const b = makeIdGen(5);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  it("builders are repeatable and match the files on disk", () => {
    expect(JSON.stringify(buildConformity().expected)).toBe(JSON.stringify(read("conformity-expected.json")));
    expect(JSON.stringify(buildLegacy3x().map((r) => r.doc))).toBe(JSON.stringify(read("legacy-3x.json")));
    expect(Object.keys(buildFormats())).toContain("items.db");
  });
});
