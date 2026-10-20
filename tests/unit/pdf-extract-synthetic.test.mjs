// C2 / C3 on the synthetic reference books (EN / FR, 2014 / 2024). The PDFs are built with pdf-lib, read back with
// the pdf.js of Foundry and given to the pure extractor: the values expected come from the specs, never from the PDF.
// Skipped when Foundry's pdf.js is not installed on the machine.
import { beforeAll, describe, expect, it } from "vitest";
import {
  hasFoundryPdfjs, loadDocs, expectedOf, pagesOfDoc, runExtract
} from "../support/pdf-env.mjs";
import {
  CREATURE_FIELDS, commonFromSpec, nameKey, readActor, readItem, scoreCreature, scoreEntries, scoreItem
} from "../support/score.mjs";
import { containsFingerprint } from "../support/fingerprint.mjs";

const docs = loadDocs(undefined, (f) => f.startsWith("ref-") && !/scanned|partial|unreadable|span|enrichers/.test(f));
const sortedStr = (a) => [...a].sort().join(",");

describe.skipIf(!hasFoundryPdfjs())("synthetic reference books", () => {
  for (const { doc } of docs) {
    describe(`${doc.id} (${doc.edition}, ${doc.lang})`, () => {
      const want = expectedOf(doc);
      let result;
      beforeAll(async () => {
        const { pages } = await pagesOfDoc(doc);
        result = await runExtract(pages, { fileName: `${doc.id}.pdf` });
      }, 60_000);

      if (want.creatures.length) {
        it(`C2: finds the ${want.creatures.length} stat block(s), reads them all and reports no problem`, () => {
          expect(result.actors.map((a) => nameKey(a.name))).toEqual(want.creatures.map((c) => nameKey(c.name)));
          expect(result.problems).toEqual([]);
          expect(result.stats.blocksFound).toBe(want.creatures.length);
          expect(result.items, "a stat block is not a magic item").toEqual([]);
        });

        for (const exp of want.creatures) {
          describe(exp.name, () => {
            const truth = commonFromSpec(exp);
            const read = () => readActor(result.actors.find((a) => nameKey(a.name) === nameKey(exp.name)));

            it("C2: type is an NPC", () => {
              expect(result.actors.find((a) => nameKey(a.name) === nameKey(exp.name))?.type).toBe("npc");
            });
            for (const field of CREATURE_FIELDS) {
              it(`C2: ${field}`, () => {
                const got = read();
                const score = scoreCreature(got, truth);
                expect(score[field], `${field}: got ${JSON.stringify(pick(got, field))}, expected ${JSON.stringify(pick(truth, field))}`).toBe(true);
              });
            }
            it("C2: size, creature type and alignment", () => {
              const got = read();
              expect(got.size).toBe(exp.size);
              expect(got.creatureType).toBe(exp.type);
              expect(nameKey(got.alignment)).toBe(nameKey(exp.alignment));
            });
            it("C2: damage and condition traits (dr / di / dv / ci)", () => {
              const got = read();
              for (const k of ["dr", "di", "dv", "ci"]) expect(sortedStr(got.traits[k]), k).toBe(sortedStr(exp.traits[k] ?? []));
            });
            it("C2: the exact text of every trait, action, bonus action, reaction and legendary action", () => {
              const s = scoreEntries(read(), truth);
              expect({ missing: s.missing, different: s.different, extra: s.extra }).toEqual({ missing: [], different: [], extra: [] });
              expect(s.ok).toBe(s.total);
            });
            it("C2: every entry carries the file and page it was read from, read by the rules", () => {
              const flags = read().flags;
              expect(flags).toMatchObject({ source: `${doc.id}.pdf`, readBy: "rules" });
              expect(flags.page).toBeGreaterThanOrEqual(1);
            });
          });
        }
      }

      if (want.items.length) {
        it(`C3: finds the ${want.items.length} magic item(s) and no creature`, () => {
          expect(result.items.map((i) => nameKey(i.name))).toEqual(want.items.map((i) => nameKey(i.name)));
          expect(result.actors).toEqual([]);
          expect(result.problems).toEqual([]);
        });
        for (const exp of want.items) {
          describe(exp.name, () => {
            const read = () => readItem(result.items.find((i) => nameKey(i.name) === nameKey(exp.name)));
            it("C3: type, rarity and attunement", () => {
              const got = read();
              const score = scoreItem(got, exp);
              expect(score, `got ${JSON.stringify({ t: got.docType, v: got.typeValue, r: got.rarity, a: got.attunement })}, expected ${JSON.stringify(exp)}`)
                .toEqual({ type: true, rarity: true, attunement: true });
            });
            it("C3: the description keeps the first paragraph of the book, word for word", () => {
              expect(containsFingerprint(read().html, exp.intro)).toBe(true);
            });
            it("C3: flags the file and page", () => {
              expect(read().flags).toMatchObject({ source: `${doc.id}.pdf` });
            });
          });
        }
      }
    });
  }
});

function pick(obj, field) {
  if (!obj) return obj;
  if (field === "hp") return obj.hp;
  if (field === "counts") return obj.counts;
  return obj[field];
}
