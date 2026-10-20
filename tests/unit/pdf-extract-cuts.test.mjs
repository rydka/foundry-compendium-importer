// Stat blocks that go on over a page break, and what the extractor does at the break:
// a. cut in the stat lines, b. lore in another font at the top of the next page (ignored),
// c. lore in the body font (documented limitation), d. block that ends cleanly at the bottom of a page,
// e. cut right after "Challenge" (no entry: noEntries, candidate for the AI), g. attack entry split over the break.
import path from "node:path";
import { describe, expect, it } from "vitest";
import { hasFoundryPdfjs, pagesOfDoc, runExtract, SYNTHETIC } from "../support/pdf-env.mjs";
import { commonFromSpec, nameKey, readActor, scoreCreature, scoreEntries } from "../support/score.mjs";
import { expectedOfDoc, loadDoc } from "../support/synth.mjs";

const doc = (name) => loadDoc(path.join(SYNTHETIC, `${name}.json`));
const run = async (name) => {
  const d = doc(name);
  const { pages } = await pagesOfDoc(d);
  return { d, pages, result: await runExtract(pages, { fileName: `${name}.pdf` }), want: expectedOfDoc(d).creatures };
};
const failing = (score) => Object.entries(score).filter(([, ok]) => !ok).map(([f]) => f);

describe.skipIf(!hasFoundryPdfjs())("blocks over a page break", () => {
  describe("a. the break falls inside the stat lines", () => {
    for (const [name, firstLineOfPage2] of [["ref-cut-stats-dr", /Damage Resistances/], ["ref-cut-stats-table", /STR\s+DEX/]]) {
      it(`${name}: page 2 starts with "${firstLineOfPage2.source}" and the creature is complete`, async () => {
        const { pages, result, want } = await run(name);
        expect(pages).toHaveLength(2);
        expect(pages[1].items.slice(0, 8).map((w) => w.str).join(" ")).toMatch(firstLineOfPage2);
        expect(result.problems).toEqual([]);
        expect(result.actors.map((a) => nameKey(a.name))).toEqual([nameKey(want[0].name)]);
        const got = readActor(result.actors[0]);
        const truth = commonFromSpec(want[0]);
        expect(failing(scoreCreature(got, truth)), "wrong fields").toEqual([]);
        const s = scoreEntries(got, truth);
        expect({ missing: s.missing, different: s.different, extra: s.extra }).toEqual({ missing: [], different: [], extra: [] });
        expect(got.flags.page, "the page where the block starts").toBe(1);
        expect(got.traits.dr.sort()).toEqual(["cold", "necrotic"]);
      }, 60_000);
    }
  });

  describe("b. lore in another font at the top of the next page", () => {
    it("is ignored: the block is complete and no entry carries the lore", async () => {
      const { result, want } = await run("ref-cut-lore-other");
      expect(result.problems).toEqual([]);
      const got = readActor(result.actors[0]);
      const s = scoreEntries(got, commonFromSpec(want[0]));
      expect({ missing: s.missing, different: s.different, extra: s.extra }).toEqual({ missing: [], different: [], extra: [] });
      expect(got.entries.some((e) => /CHAPTER THREE|travellers who kept/i.test(e.html))).toBe(false);
    }, 60_000);
  });

  describe("c. lore in the body font at the top of the next page, without a title", () => {
    // KNOWN LIMITATION (documented, not a defect of this version): nothing tells this paragraph from the
    // continuation of the entry above it, so it is added to the last entry that precedes the break. If the extractor
    // learns to tell them apart, this test fails on purpose: move it to the "b" expectation.
    it("is added to the last entry of the first page; every other entry is exact", async () => {
      const { result, want } = await run("ref-cut-lore-body");
      expect(result.problems).toEqual([]);
      const got = readActor(result.actors[0]);
      const s = scoreEntries(got, commonFromSpec(want[0]));
      expect(s.missing).toEqual([]);
      expect(s.different, "only the entry before the break differs").toHaveLength(1);
      const carrier = got.entries.filter((e) => /travellers who kept to them/i.test(e.html));
      expect(carrier).toHaveLength(1);
      expect(carrier[0].name).toBe("Lantern Swing");
      expect(failing(scoreCreature(got, commonFromSpec(want[0])))).toEqual([]);
    }, 60_000);
  });

  describe("d. a block that ends at the bottom of a page, the next page starts with a title", () => {
    it("is complete, not reported as cut, and the next creature is read too", async () => {
      const { result, want } = await run("ref-cut-sentence-end");
      expect(result.problems.filter((p) => p.reason === "blockCut")).toEqual([]);
      expect(result.problems).toEqual([]);
      expect(result.actors.map((a) => nameKey(a.name))).toEqual(want.map((c) => nameKey(c.name)));
      for (const exp of want) {
        const got = readActor(result.actors.find((a) => nameKey(a.name) === nameKey(exp.name)));
        const s = scoreEntries(got, commonFromSpec(exp));
        expect({ missing: s.missing, different: s.different, extra: s.extra }).toEqual({ missing: [], different: [], extra: [] });
      }
    }, 60_000);
  });

  describe("e. the break falls right after the Challenge line, no entry on the page", () => {
    it("is noEntries (not blockCut), nothing imported, and the block is queued for the AI", async () => {
      const { pages, result } = await run("ref-cut-noentries");
      expect(pages).toHaveLength(1);
      expect(result.actors).toEqual([]);
      expect(result.problems.map((p) => p.reason)).toContain("noEntries");
      expect(result.problems.some((p) => p.reason === "blockCut")).toBe(false);
      const p = result.problems.find((x) => x.reason === "noEntries");
      expect(p.page).toBe(1);
      expect(p.name).toMatch(/Flint Bearer/i);
      expect(result.aiQueue.map((q) => [nameKey(q.name), q.page])).toEqual([["flint bearer", 1]]);
    }, 60_000);
  });

  describe("g. an attack entry cut in two, \"Hit:\" on the next page", () => {
    it("is one entry with its whole text, recognized as an attack (weapon item)", async () => {
      const { pages, result, want } = await run("ref-attack-span");
      expect(pages).toHaveLength(2);
      expect(pages[1].items.slice(0, 6).map((w) => w.str).join(" ")).toMatch(/Hit:/);
      expect(result.problems).toEqual([]);
      const got = readActor(result.actors[0]);
      const s = scoreEntries(got, commonFromSpec(want[0]));
      expect({ missing: s.missing, different: s.different, extra: s.extra }).toEqual({ missing: [], different: [], extra: [] });
      const swing = result.actors[0].items.find((i) => i.name === "Lantern Swing");
      expect(swing.type, "an entry with Melee Weapon Attack and Hit is a weapon").toBe("weapon");
      expect(swing.system.description.value).toMatch(/Hit: 8 \(1d10 \+ 3\)/);
    }, 60_000);
  });
});
