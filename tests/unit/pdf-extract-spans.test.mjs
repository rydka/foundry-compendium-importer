// A stat block that runs over two pages (one column and two columns), a block cut short and not continued, and the
// text of a PDF that looks like Foundry enrichers (@UUID[...], [[/r ...]]): it stays text.
import path from "node:path";
import { describe, expect, it } from "vitest";
import { hasFoundryPdfjs, pagesOfDoc, runExtract, SYNTHETIC } from "../support/pdf-env.mjs";
import { CREATURE_FIELDS, commonFromSpec, nameKey, readActor, readItem, scoreCreature, scoreEntries } from "../support/score.mjs";
import { containsFingerprint } from "../support/fingerprint.mjs";
import { expectedOfDoc, loadDoc } from "../support/synth.mjs";

const doc = (name) => loadDoc(path.join(SYNTHETIC, `${name}.json`));

describe.skipIf(!hasFoundryPdfjs())("stat block over two pages", () => {
  for (const name of ["ref-span-2col", "ref-span-1col"]) {
    describe(`${name} (${doc(name).cols} column${doc(name).cols > 1 ? "s" : ""})`, () => {
      const d = doc(name);
      const want = expectedOfDoc(d).creatures[0];
      const truth = commonFromSpec(want);
      let result;
      it("the block really runs over the page break (the test document is what it claims)", async () => {
        const { pages } = await pagesOfDoc(d);
        expect(pages).toHaveLength(2);
        const onPage2 = pages[1].items.map((w) => w.str).join(" ");
        expect(onPage2).toMatch(/Cold|Snuff/);
        expect(pages[1].items.some((w) => w.str === want.name.split(" ")[0] && w.size > 15), "no second title on page 2").toBe(false);
      }, 60_000);

      it("is read whole: one creature, every field, every trait and action with its exact text, no problem", async () => {
        const { pages } = await pagesOfDoc(d);
        result = await runExtract(pages, { fileName: `${name}.pdf` });
        expect(result.problems).toEqual([]);
        expect(result.actors.map((a) => nameKey(a.name))).toEqual([nameKey(want.name)]);
        const got = readActor(result.actors[0]);
        const score = scoreCreature(got, truth);
        expect(Object.entries(score).filter(([, ok]) => !ok).map(([f]) => f), `fields wrong among ${CREATURE_FIELDS}`).toEqual([]);
        const s = scoreEntries(got, truth);
        expect({ missing: s.missing, different: s.different, extra: s.extra }).toEqual({ missing: [], different: [], extra: [] });
      }, 60_000);

      it("keeps the page where the block starts, and no page number leaks into a text", async () => {
        const { pages } = await pagesOfDoc(d);
        result = await runExtract(pages, { fileName: `${name}.pdf` });
        const got = readActor(result.actors[0]);
        expect(got.flags.page).toBe(1);
        for (const e of got.entries) expect(e.html, e.name).not.toMatch(/\s[12]\s*<\/p>\s*$/);
      }, 60_000);

      it("is deterministic", async () => {
        const { pages } = await pagesOfDoc(d);
        const a = JSON.stringify((await runExtract(pages, { fileName: `${name}.pdf` })).actors);
        const b = JSON.stringify((await runExtract(pages, { fileName: `${name}.pdf` })).actors);
        expect(b).toBe(a);
      }, 60_000);
    });
  }

  describe("a block cut short and not continued (the second page is missing)", () => {
    it("is reported in the review with its name and page, never imported as if complete", async () => {
      const d = doc("ref-span-cut");
      const { pages } = await pagesOfDoc(d);
      expect(pages).toHaveLength(1);
      const result = await runExtract(pages, { fileName: "cut.pdf" });
      const want = expectedOfDoc(d).creatures[0];
      const problem = result.problems.find((p) => p.page === 1 && (p.name === null || nameKey(p.name) === nameKey("Cut Bearer")));
      expect(problem, `a problem for the cut block: ${JSON.stringify(result.problems)}`).toBeTruthy();
      expect(typeof problem.reason).toBe("string");
      expect(problem.reason.length).toBeGreaterThan(0);
      // if the part that is there is still produced, the review must say it is incomplete (the problem above)
      const got = result.actors.length ? readActor(result.actors[0]) : null;
      if (got) expect(got.entries.length, "entries it could read").toBeLessThan(want.entries.length);
    }, 60_000);
  });

  describe("text that looks like Foundry enrichers stays text", () => {
    const d = doc("ref-enrichers");
    const want = expectedOfDoc(d);
    let result;
    it("is extracted", async () => {
      const { pages } = await pagesOfDoc(d);
      result = await runExtract(pages, { fileName: "enrichers.pdf" });
      expect(result.problems).toEqual([]);
      expect(result.actors).toHaveLength(1);
      expect(result.items).toHaveLength(1);
    }, 60_000);
    it("no description of a creature holds a literal @UUID[ or [[ (they are written as entities)", () => {
      for (const item of result.actors[0].items) {
        const html = item.system.description.value;
        expect(html, item.name).not.toMatch(/@\w+\[/);
        expect(html, item.name).not.toContain("[[");
      }
    });
    it("the text a reader sees is the one of the book, character for character", () => {
      const s = scoreEntries(readActor(result.actors[0]), commonFromSpec(want.creatures[0]));
      expect({ missing: s.missing, different: s.different }).toEqual({ missing: [], different: [] });
      const margin = result.actors[0].items.find((i) => i.name === "Margin Notes").system.description.value;
      expect(margin).toMatch(/&#64;UUID&#91;|&#x40;UUID&#x5B;|&commat;UUID/i);
    });
    it("a magic item description is neutralized too and keeps its text", () => {
      const html = readItem(result.items[0]).html;
      expect(html).not.toMatch(/@\w+\[/);
      expect(html).not.toContain("[[");
      expect(containsFingerprint(html, want.items[0].intro)).toBe(true);
    });
    it("the document itself keeps the printed names unchanged", () => {
      expect(result.actors[0].items.map((i) => i.name)).toContain("Ink Spray");
    });
  });
});
