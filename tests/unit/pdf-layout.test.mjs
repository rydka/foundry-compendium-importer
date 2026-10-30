// C2 (D1): page layout (scripts/core/pdf/layout.mjs): columns, lines, text of a line, footers.
import { describe, expect, it } from "vitest";
import { columnSplit, groupLines, isFooterLine, joinWords, pageColumns, pageLines } from "../../scripts/core/pdf/layout.mjs";

const W = 612;
const word = (str, x0, y, { size = 9, font = "F", w } = {}) => ({ str, x0, x1: x0 + (w ?? str.length * size * 0.5), y, size, font });

/** A column of `n` lines at x0, from y = 700 down, each made of 3 words. */
function column(x0, n, tag) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(word(`${tag}${i}a`, x0, 700 - i * 11), word(`${tag}${i}b`, x0 + 40, 700 - i * 11), word(`${tag}${i}c`, x0 + 80, 700 - i * 11));
  }
  return out;
}

describe("columnSplit", () => {
  it("finds the gutter of a two-column page", () => {
    const x = columnSplit([...column(40, 20, "L"), ...column(330, 20, "R")], W);
    expect(x).toBeGreaterThan(40 + 80 + 20);
    expect(x).toBeLessThan(330);
  });
  it("returns null for a single column of text", () => {
    const words = [];
    for (let i = 0; i < 20; i++) words.push(word("a", 40, 700 - i * 11, { w: 520 }));
    expect(columnSplit(words, W)).toBeNull();
  });
  it("tolerates a full-width banner crossing the gutter (a word wider than the gutter)", () => {
    const banner = [word("THE-EMBER-ARCHIVE", 100, 760, { size: 25, w: 380 })];
    const x = columnSplit([...banner, ...column(40, 20, "L"), ...column(330, 20, "R")], W);
    expect(x).not.toBeNull();
    expect(x).toBeGreaterThan(130);
    expect(x).toBeLessThan(330);
  });
});

describe("joinWords", () => {
  it("puts a space only where the layout has a gap (0.15 x the font size)", () => {
    expect(joinWords([word("Hit", 40, 0, { w: 15 }), word("Points", 58, 0, { w: 28 })])).toBe("Hit Points");
    expect(joinWords([word("invisible", 40, 0, { w: 40, font: "I" }), word(".", 80.2, 0, { w: 2 })])).toBe("invisible.");
  });
  it("keeps the hyphen of a word and does not add a space inside a split word", () => {
    expect(joinWords([word("non-", 40, 0, { w: 18 }), word("evil", 58, 0, { w: 18 })])).toBe("non-evil");
  });
});

describe("groupLines", () => {
  it("groups by baseline (tolerance 2.5), top to bottom, words left to right", () => {
    const lines = groupLines([
      word("world", 70, 600.5), word("Hello", 40, 601), word("next", 40, 589), word("far", 40, 500)
    ]);
    expect(lines.map((l) => l.text)).toEqual(["Hello world", "next", "far"]);
    expect(lines[0].y).toBeGreaterThan(lines[1].y);
  });
  it("is stable: the same input in another order gives the same lines", () => {
    const words = [...column(40, 5, "L")];
    const a = groupLines(words).map((l) => l.text);
    const b = groupLines([...words].reverse()).map((l) => l.text);
    expect(b).toEqual(a);
  });
  it("gives each line its largest font size and its extent", () => {
    const [l] = groupLines([word("Big", 40, 600, { size: 17.6, w: 30 }), word("small", 75, 600, { size: 9, w: 25 })]);
    expect(l.size).toBe(17.6);
    expect(l.x0).toBe(40);
    expect(l.x1).toBe(100);
  });
});

describe("pageColumns / pageLines", () => {
  const page = { number: 1, width: W, height: 792, items: [...column(330, 4, "R"), ...column(40, 4, "L")] };
  it("reads the left column, then the right column", () => {
    const text = pageLines(page).map((l) => l.text);
    expect(text.slice(0, 4).every((t) => t.startsWith("L"))).toBe(true);
    expect(text.slice(4).every((t) => t.startsWith("R"))).toBe(true);
  });
  it("returns the columns separately", () => {
    const cols = pageColumns(page);
    expect(cols).toHaveLength(2);
    expect(cols[0]).toHaveLength(4);
    expect(cols[1]).toHaveLength(4);
  });
  it("keeps a line of the left column whose baseline matches a line of the right column apart (interleaved baselines)", () => {
    const text = pageLines(page).map((l) => l.text);
    expect(text.some((t) => t.includes("L0a") && t.includes("R0a"))).toBe(false);
  });
});

describe("isFooterLine", () => {
  it("recognizes a repeated running head / page number", () => {
    expect(isFooterLine("12 12 12 12 12 12 12 12 12 12")).toBe(true);
  });
  it("does not take stat lines or prose for a footer", () => {
    expect(isFooterLine("Armor Class 14 (natural armor)")).toBe(false);
    expect(isFooterLine("Challenge 3 (700 XP) Proficiency Bonus +2")).toBe(false);
  });
});
