// C2 / C3 / C4 on the real book: Better Undead Compendium.pdf (local file, ignored by git: the test is skipped
// when it is absent). The truth is tests/fixtures/pdf/better-undead.truth.json, annotated from the printed pages
// (values, names and fingerprints of the texts only; no book text is versioned).
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { BETTER_UNDEAD_PDF, FIXTURES, hasBetterUndead, runExtract } from "../support/pdf-env.mjs";
import { readPages } from "../support/pdfjs-node.mjs";
import { CREATURE_FIELDS, commonFromTruth, nameKey, readActor, readItem, scoreCreature, scoreEntries, scoreItem } from "../support/score.mjs";
import { containsFingerprint } from "../support/fingerprint.mjs";

const truth = JSON.parse(readFileSync(path.join(FIXTURES, "better-undead.truth.json"), "utf8"));
const OUT_ACTORS = path.join(path.dirname(BETTER_UNDEAD_PDF), "out", "actors.json");

describe.skipIf(!hasBetterUndead())("Better Undead Compendium", () => {
  let result;
  beforeAll(async () => {
    const { pages } = await readPages(BETTER_UNDEAD_PDF, { key: "better-undead" });
    expect(pages).toHaveLength(35);
    result = await runExtract(pages, { fileName: "Better Undead Compendium.pdf" });
  }, 120_000);

  it("C2/C4: finds the 12 stat blocks, reads them all, reports no problem", () => {
    expect(result.actors.map((a) => nameKey(a.name))).toEqual(truth.creatures.map((c) => nameKey(c.name)));
    expect(result.stats.blocksFound).toBe(12);
    expect(result.blocks.filter((b) => b.status !== "rules")).toEqual([]);
    expect(result.problems).toEqual([]);
    expect(result.scanned).toBe(false);
  });

  for (const t of truth.creatures) {
    describe(`${t.name} (p. ${t.page})`, () => {
      const want = commonFromTruth(t);
      const source = () => result.actors.find((a) => nameKey(a.name) === nameKey(t.name));
      for (const field of CREATURE_FIELDS) {
        it(`C2: ${field}`, () => {
          const got = readActor(source());
          const score = scoreCreature(got, want);
          expect(score[field], `got ${JSON.stringify(got?.[field === "counts" ? "counts" : field])} expected ${JSON.stringify(want[field])}`).toBe(true);
        });
      }
      it("C2: the exact text of every trait and action (and nothing else: no neighbouring variant, lore or pull quote)", () => {
        const got = readActor(source());
        const s = scoreEntries(got, want);
        const allowedExtra = new Set((t.extras ?? []).map((e) => `${e.section === "spellcasting-block" ? "trait" : e.section}: ${e.name}`));
        expect({ missing: s.missing, different: s.different, extra: s.extra.filter((e) => !allowedExtra.has(e)) })
          .toEqual({ missing: [], different: [], extra: [] });
      });
      it("C2: flags the page it was read from", () => {
        expect(readActor(source()).flags).toMatchObject({ source: "Better Undead Compendium.pdf", page: t.page, readBy: "rules" });
      });
    });
  }

  describe("magic items (C3)", () => {
    it("finds the 3 tomes and nothing else (the 3rd one is named in full, not 'Challenge Gem')", () => {
      expect(result.items.map((i) => nameKey(i.name))).toEqual(truth.items.map((i) => nameKey(i.name)));
      expect(result.items.some((i) => /challenge gem/i.test(i.name))).toBe(false);
    });
    for (const t of truth.items) {
      it(`${t.name}: equipment / wondrous, legendary, no attunement`, () => {
        const got = readItem(result.items.find((i) => nameKey(i.name) === nameKey(t.name)));
        expect(scoreItem(got, { docType: "equipment", typeValue: "wondrous", rarity: t.rarity, attunement: t.attunement }))
          .toEqual({ type: true, rarity: true, attunement: true });
        expect(got.flags).toMatchObject({ page: t.page });
        expect(containsFingerprint(got.html, t.intro), "first paragraph of the description").toBe(true);
      });
    }
  });

  // Parity with the Python extractor (tools/out is local and ignored by git): the stats must agree wherever both
  // read the same creature. The texts are compared above, against the printed pages.
  describe.skipIf(!existsSync(OUT_ACTORS))("parity with tools/out/actors.json", () => {
    it("C2: AC, HP, abilities and CR agree for the creatures both tools read", () => {
      const python = JSON.parse(readFileSync(OUT_ACTORS, "utf8"));
      const list = Array.isArray(python) ? python : Object.values(python);
      const diffs = [];
      for (const p of list) {
        const mine = result.actors.find((a) => nameKey(a.name) === nameKey(p.name));
        if (!mine) { diffs.push(`${p.name}: missing from the new extractor`); continue; }
        const a = readActor(mine);
        const ps = p.system ?? {};
        const pac = ps.attributes?.ac?.flat ?? ps.attributes?.ac?.override ?? ps.attributes?.ac?.value;
        if (pac !== undefined && a.ac !== pac) diffs.push(`${p.name}: ac ${a.ac} vs ${pac}`);
        if (ps.attributes?.hp?.max !== undefined && a.hp.max !== ps.attributes.hp.max) diffs.push(`${p.name}: hp ${a.hp.max} vs ${ps.attributes.hp.max}`);
        if (ps.details?.cr !== undefined && Number(a.cr) !== Number(ps.details.cr)) diffs.push(`${p.name}: cr ${a.cr} vs ${ps.details.cr}`);
        for (const k of ["str", "dex", "con", "int", "wis", "cha"]) {
          const v = ps.abilities?.[k]?.value;
          if (v !== undefined && a.abilities[k] !== v) diffs.push(`${p.name}: ${k} ${a.abilities[k]} vs ${v}`);
        }
      }
      expect(diffs).toEqual([]);
    });
  });
});
