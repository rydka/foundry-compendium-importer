// C2 (D1): font names (scripts/core/pdf/fonts.mjs).
import { describe, expect, it } from "vitest";
import { fontFamily, fontStyle, inferEntryFont } from "../../scripts/core/pdf/fonts.mjs";

describe("fontFamily", () => {
  it("ignores the ABCDEF+ subset prefix and the style suffix", () => {
    const f = fontFamily("MAAAAA+ScalySansRemakeBoldItalic");
    expect(f).toBe(fontFamily("GAAAAA+ScalySansRemakeRegular"));
    expect(f).toBe(fontFamily("LAAAAA+ScalySansRemakeItalic"));
    expect(f).not.toBe(fontFamily("DAAAAA+MrEavesSCRemakeMedium"));
  });
  it("groups the standard Helvetica styles, Oblique included", () => {
    const f = fontFamily("Helvetica");
    for (const n of ["Helvetica-Bold", "Helvetica-Oblique", "Helvetica-BoldOblique"]) expect(fontFamily(n)).toBe(f);
    expect(fontFamily("Times-Roman")).not.toBe(f);
  });
});

describe("fontStyle", () => {
  it("reads bold and italic from the name", () => {
    expect(fontStyle("MAAAAA+ScalySansRemakeBoldItalic")).toMatchObject({ bold: true, italic: true });
    expect(fontStyle("KAAAAA+ScalySansRemakeBold")).toMatchObject({ bold: true, italic: false });
    expect(fontStyle("LAAAAA+ScalySansRemakeItalic")).toMatchObject({ bold: false, italic: true });
    expect(fontStyle("GAAAAA+ScalySansRemakeRegular")).toMatchObject({ bold: false, italic: false });
  });
  it("reads Oblique as italic (standard PDF fonts)", () => {
    expect(fontStyle("Helvetica-BoldOblique")).toMatchObject({ bold: true, italic: true });
    expect(fontStyle("Helvetica-Oblique")).toMatchObject({ bold: false, italic: true });
  });
  it("does not invent a style for an unresolved pdf.js identifier", () => {
    expect(fontStyle("g_d0_f16")).toMatchObject({ bold: false, italic: false });
  });
});

describe("inferEntryFont (fallback when the font names are unknown)", () => {
  const line = (...pairs) => ({ words: pairs.map(([str, font]) => ({ str, font })) });
  const body = "g_d0_f4";
  const entry = "g_d0_f7";
  it("returns the font most often found at the start of lines that end their first words with a period", () => {
    const lines = [
      line(["Magic", entry], ["Resistance.", entry], ["The", body], ["ghost", body], ["has", body], ["advantage", body]),
      line(["against", body], ["spells", body], ["and", body], ["other", body]),
      line(["Marshal", entry], ["Undead.", entry], ["Unless", body], ["the", body]),
      line(["Heroic", entry], ["Possession.", entry], ["Forced", body])
    ];
    expect(inferEntryFont(lines, [body])).toBe(entry);
  });
  it("returns null when no line looks like an entry", () => {
    expect(inferEntryFont([line(["plain", body], ["text", body])], [body])).toBeNull();
  });
});
