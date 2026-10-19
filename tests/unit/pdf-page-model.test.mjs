// C1/C2 (D1): conversion of the pdf.js text content into the page model (scripts/core/pdf/page-model.mjs).
import { describe, expect, it } from "vitest";
import { cleanText, splitWords, toPageModel } from "../../scripts/core/pdf/page-model.mjs";

// pdf.js reports `height` as the font size; when it is 0 the scale of the transform (here 9) is the fallback.
const item = (str, x, y, width, height = 9, fontName = "g_d0_f1") => ({ str, transform: [height || 9, 0, 0, height || 9, x, y], width, height, fontName });

describe("cleanText", () => {
  it("removes private-use glyphs (dice fonts) and soft hyphens", () => {
    expect(cleanText("burial , cause")).toBe("burial , cause");
    expect(cleanText("inter­nal")).toBe("internal");
  });
  it("turns the minus sign into a hyphen and non-breaking spaces into spaces", () => {
    expect(cleanText("1 (−2)")).toBe("1 (-2)");
    expect(cleanText("5 ft.")).toBe("5 ft.");
  });
});

describe("splitWords", () => {
  it("splits a line item into words and shares the width in proportion to the characters", () => {
    const words = splitWords([{ str: "ab cde", x0: 100, x1: 160, y: 50, size: 9, font: "F" }]);
    expect(words.map((w) => w.str)).toEqual(["ab", "cde"]);
    expect(words[0].x0).toBeCloseTo(100);
    expect(words[0].x1).toBeCloseTo(120);
    expect(words[1].x0).toBeCloseTo(130);
    expect(words[1].x1).toBeCloseTo(160);
    expect(words.every((w) => w.y === 50 && w.size === 9 && w.font === "F")).toBe(true);
  });
  it("keeps one-character items and drops empty ones", () => {
    const words = splitWords([
      { str: "A", x0: 10, x1: 16, y: 5, size: 9, font: "F" },
      { str: " ", x0: 16, x1: 18, y: 5, size: 9, font: "F" },
      { str: "", x0: 18, x1: 18, y: 5, size: 9, font: "F" }
    ]);
    expect(words.map((w) => w.str)).toEqual(["A"]);
  });
});

describe("toPageModel", () => {
  const content = {
    items: [
      item("Armor Class", 40, 700, 50, 9, "g_d0_f3"),
      item("14 (natural armor)", 95, 700, 80, 9, "g_d0_f4"),
      item("  ", 180, 700, 3),
      item("Poltergeist", 40, 740, 90, 17.6, "g_d0_f5"),
      item("1 (−5)", 40, 650, 30, 0, "g_d0_f9")
    ]
  };
  const names = { g_d0_f3: "KAAAAA+ScalySansRemakeBold", g_d0_f4: "GAAAAA+ScalySansRemakeRegular", g_d0_f5: "DAAAAA+MrEavesSCRemakeMedium" };
  const page = toPageModel(content, { number: 5, width: 612, height: 792 }, names);

  it("carries the page number and size", () => {
    expect(page.number).toBe(5);
    expect(page.width).toBe(612);
    expect(page.height).toBe(792);
  });
  it("maps x0 / x1 / y / size from the transform, width and height", () => {
    const ac = page.items.find((w) => w.str === "Armor");
    expect(ac.x0).toBe(40);
    expect(ac.y).toBe(700);
    expect(ac.size).toBe(9);
    const title = page.items.find((w) => w.str === "Poltergeist");
    expect(title.size).toBe(17.6);
    expect(title.x1 - title.x0).toBeCloseTo(90);
  });
  it("replaces the pdf.js identifier by the real font name, or keeps the identifier when unknown", () => {
    expect(page.items.find((w) => w.str === "Armor").font).toBe("KAAAAA+ScalySansRemakeBold");
    expect(page.items.find((w) => w.str === "(natural").font).toBe("GAAAAA+ScalySansRemakeRegular");
    expect(page.items.find((w) => w.str === "(-5)").font).toBe("g_d0_f9");
  });
  it("falls back to the scale of the transform when the height is 0, and cleans the text", () => {
    const w = page.items.find((x) => x.str === "(-5)");
    expect(w).toBeTruthy();
    expect(w.size).toBe(9);
  });
  it("drops whitespace-only items and tolerates an empty content", () => {
    expect(page.items.some((w) => !w.str.trim())).toBe(false);
    expect(toPageModel({ items: [] }, { number: 1, width: 100, height: 100 }).items).toEqual([]);
  });
});
