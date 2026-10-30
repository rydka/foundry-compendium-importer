// C4 (blocks reported, never imported half-read), C5 (queue for the local AI), C6 (determinism), C7 (scanned PDF).
import { beforeAll, describe, expect, it } from "vitest";
import { hasFoundryPdfjs, pagesOfDoc, runExtract, SYNTHETIC } from "../support/pdf-env.mjs";
import { loadDoc } from "../support/synth.mjs";
import { nameKey, readActor } from "../support/score.mjs";
import path from "node:path";
import { isScanned } from "../../scripts/core/pdf/extract.mjs";
import { stableId } from "../../scripts/core/pdf/stable-id.mjs";

const REASONS = ["noTitle", "missingStats", "noEntries", "fontUnknown", "countMismatch", "aiRejected", "aiUnreachable", "aiTimeout", "itemNoTitle"];
const doc = (name) => loadDoc(path.join(SYNTHETIC, `${name}.json`));

describe.skipIf(!hasFoundryPdfjs())("PDF problems and determinism", () => {
  describe("C4 / C5: a page whose block the layout rules cannot read (one font only)", () => {
    let result;
    beforeAll(async () => {
      const { pages } = await pagesOfDoc(doc("ref-partial"));
      result = await runExtract(pages, { fileName: "partial.pdf" });
    }, 60_000);

    it("C4: the legible block is extracted, the other one is not", () => {
      expect(result.actors.map((a) => nameKey(a.name))).toEqual(["bone piper"]);
      expect(result.stats.blocksFound).toBe(2);
      expect(result.blocks.map((b) => [nameKey(b.name), b.page, b.status])).toEqual([["bone piper", 1, "rules"], ["smudged reeve", 2, "failed"]]);
    });
    it("C4: the failure is reported with name, page and a known reason", () => {
      expect(result.problems).toHaveLength(1);
      const [p] = result.problems;
      expect(p.page).toBe(2);
      expect(REASONS).toContain(p.reason);
      expect(p.name === null || /smudged reeve/i.test(p.name), "name of the block or unknown").toBe(true);
    });
    it("C4: no half-read actor in the entries (an incomplete actor is never produced)", () => {
      expect(result.actors.every((a) => a.name !== "Smudged Reeve")).toBe(true);
      for (const a of result.actors) {
        const r = readActor(a);
        expect(r.ac).not.toBeNull();
        expect(r.hp.value).toBeGreaterThan(0);
      }
    });
    it("C5: the unreadable block is queued for the local AI with its lines", () => {
      expect(result.aiQueue).toHaveLength(1);
      const q = result.aiQueue[0];
      expect(q.page).toBe(2);
      expect(q.lines.join("\n")).toMatch(/Armor Class 16/);
      expect(q.lines.join("\n")).toMatch(/Cudgel\. Melee Weapon Attack/);
    });
    it("C3: the magic item of the third page is still found", () => {
      expect(result.items.map((i) => nameKey(i.name))).toEqual(["whistle of the marsh warden"]);
    });
  });

  describe("C4: more Armor Class lines than detected blocks", () => {
    it("reports countMismatch for the page and produces no actor", async () => {
      const broken = structuredClone(doc("ref-2014-en"));
      // A type line the detector cannot read: the Armor Class line is there, the block is not found.
      const creature = broken.flow.find((f) => f.creature).creature;
      creature.typeLine = "~ ~ ~";
      broken.flow = broken.flow.filter((f) => !f.creature || f.creature === creature);
      const { pages } = await pagesOfDoc({ ...broken, id: "broken-type-line" });
      const result = await runExtract(pages, { fileName: "broken.pdf" });
      expect(result.actors.find((a) => /cinder wraith/i.test(a.name))).toBeUndefined();
      expect(result.problems.some((p) => p.reason === "countMismatch" && p.page === 1)).toBe(true);
    }, 60_000);
  });

  describe("C7: a scanned PDF (images, no text)", () => {
    it("is detected and nothing is extracted", async () => {
      const { pages } = await pagesOfDoc(doc("ref-scanned"));
      expect(pages).toHaveLength(3);
      expect(isScanned(pages)).toBe(true);
      const result = await runExtract(pages, { fileName: "scan.pdf" });
      expect(result.scanned).toBe(true);
      expect(result.actors).toEqual([]);
      expect(result.items).toEqual([]);
    }, 60_000);
    it("a PDF with text is not scanned", async () => {
      const { pages } = await pagesOfDoc(doc("ref-2014-en"));
      expect(isScanned(pages)).toBe(false);
    }, 60_000);
    it("a cover with a few words and blank pages is still scanned", () => {
      const page = (n, str) => ({ number: n, width: 595, height: 842, items: str ? [{ str, x0: 10, x1: 80, y: 700, size: 12, font: "F" }] : [] });
      expect(isScanned([page(1, "Cover title"), page(2), page(3)])).toBe(true);
      expect(isScanned([])).toBe(true);
    });
  });

  describe("C6: the extraction is deterministic", () => {
    for (const name of ["ref-2014-en", "ref-2014-fr", "ref-2024-en", "ref-items-en", "ref-partial"]) {
      it(`${name}: two complete runs (document built, read and extracted twice) give the same result, ids included`, async () => {
        const run = async () => {
          const { pages } = await pagesOfDoc({ ...doc(name), id: `${name}-${Math.random()}` });
          const r = await runExtract(pages, { fileName: `${name}.pdf` });
          return JSON.stringify({ actors: r.actors, items: r.items, problems: r.problems, blocks: r.blocks });
        };
        const a = await run();
        const b = await run();
        expect(b).toBe(a);
      }, 60_000);
    }
    it("the same pages extracted twice, in one process, give the same result (no hidden state)", async () => {
      const { pages } = await pagesOfDoc(doc("ref-2024-fr"));
      const a = JSON.stringify((({ actors, items }) => ({ actors, items }))(await runExtract(pages, { fileName: "x.pdf" })));
      const b = JSON.stringify((({ actors, items }) => ({ actors, items }))(await runExtract(pages, { fileName: "x.pdf" })));
      expect(b).toBe(a);
    }, 60_000);
    it("a different file name gives different ids; the same name gives the same ids", async () => {
      const { pages } = await pagesOfDoc(doc("ref-2014-en"));
      const ids = async (fileName) => (await runExtract(pages, { fileName })).actors.map((a) => a._id);
      const a = await ids("one.pdf");
      expect(a.every((id) => typeof id === "string" && /^[A-Za-z0-9]{16}$/.test(id))).toBe(true);
      expect(new Set(a).size).toBe(a.length);
      expect(await ids("one.pdf")).toEqual(a);
      expect(await ids("two.pdf")).not.toEqual(a);
    }, 60_000);
  });
});

describe("stableId", () => {
  it("16 alphanumeric characters, a pure function of the seed", () => {
    const id = stableId("book.pdf|5|Poltergeist|0");
    expect(id).toMatch(/^[A-Za-z0-9]{16}$/);
    expect(stableId("book.pdf|5|Poltergeist|0")).toBe(id);
  });
  it("changes with the file, the page, the name and the rank", () => {
    const ids = ["a.pdf|5|X|0", "b.pdf|5|X|0", "a.pdf|6|X|0", "a.pdf|5|Y|0", "a.pdf|5|X|1"].map(stableId);
    expect(new Set(ids).size).toBe(5);
  });
});
