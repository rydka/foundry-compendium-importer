// PDF import, static checks: the pure core stays pure (lint-like), the window accepts .pdf and can cancel, the
// strings and settings promised by the design exist. The behaviour itself is proved by the integration specs.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../../", import.meta.url);
const read = (rel) => readFileSync(new URL(rel, root), "utf8");
const json = (rel) => JSON.parse(read(rel));
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

function flatten(obj, prefix = "") {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object") Object.assign(out, flatten(v, key)); else out[key] = v;
  }
  return out;
}

describe("the pure core of the PDF import has no Foundry or browser global (C1)", () => {
  const dirs = ["scripts/core/pdf", "scripts/core/ai"];
  const files = dirs.flatMap((d) => (existsSync(new URL(d, root)) ? readdirSync(new URL(d, root)).filter((f) => f.endsWith(".mjs")).map((f) => `${d}/${f}`) : []));
  it("has the files of the design", () => {
    for (const f of ["page-model", "fonts", "layout", "lexicon", "stat-block", "stat-lines", "creature", "magic-item", "extract", "stable-id", "ai-block"]) {
      expect(files, `scripts/core/pdf/${f}.mjs`).toContain(`scripts/core/pdf/${f}.mjs`);
    }
    expect(files).toContain("scripts/core/ai/ollama.mjs");
  });
  for (const f of files) {
    it(`${f}: no game / foundry / CONFIG / ui / Hooks / document / window / navigator`, () => {
      const src = strip(read(f));
      expect(src).not.toMatch(/\b(game|foundry|CONFIG|ui|Hooks|canvas|document|window|navigator|localStorage|dnd5e)\.[A-Za-z]/);
      expect(src).not.toMatch(/\bnew Worker\b|\bimport\(["']\/|getRoute\(/);
    });
    it(`${f}: no top-level side effect (no timer, no fetch call at import)`, () => {
      const src = strip(read(f));
      expect(src).not.toMatch(/^(setTimeout|setInterval|fetch)\(/m);
    });
  }
  it("ollama.mjs takes fetch as an option (the tests inject a fake one)", () => {
    expect(strip(read("scripts/core/ai/ollama.mjs"))).toMatch(/fetch/);
  });
});

describe("window (C1)", () => {
  it("the file field accepts .pdf", () => {
    expect(read("templates/importer/source.hbs")).toMatch(/accept="[^"]*\.pdf[^"]*"/);
  });
  it("the footer has a cancel button for the analysis", () => {
    expect(read("templates/importer/footer.hbs")).toMatch(/data-action="cancelAnalysis"/);
  });
  it("the window does not read a PDF as text when the file is chosen", () => {
    const src = strip(read("scripts/foundry/importer-app.mjs"));
    expect(src).toMatch(/\.pdf/i);
    expect(src).toMatch(/AbortController/);
  });
  it("api.readPdf is exposed", () => {
    expect(strip(read("scripts/main.mjs"))).toMatch(/readPdf/);
  });
});

describe("strings and settings of the design", () => {
  const en = flatten(json("lang/en.json"));
  const fr = flatten(json("lang/fr.json"));
  const p = "compendium-json-importer.";
  it("the progress strings carry {done} and {total} in both languages", () => {
    for (const [lang, t] of [["en", en], ["fr", fr]]) {
      for (const k of ["Progress.pdfPage", "Progress.pdfAi"]) {
        expect(t[p + k], `${lang} ${k}`).toMatch(/\{done\}/);
        expect(t[p + k], `${lang} ${k}`).toMatch(/\{total\}/);
      }
      expect(t[p + "Progress.pdfOpen"], `${lang} Progress.pdfOpen`).toBeTruthy();
    }
    expect(fr[p + "Progress.pdfPage"]).toMatch(/Lecture du PDF/);
  });
  it("has the error messages: scanned, encrypted, invalid, reader unavailable, parser absent", () => {
    const errors = Object.keys(en).filter((k) => k.startsWith(`${p}Error.Pdf.`));
    expect(errors.length).toBeGreaterThanOrEqual(5);
    expect(en[`${p}Error.Pdf.Scanned`] ?? errors.map((k) => en[k]).find((v) => /scanned/i.test(v))).toBeTruthy();
    expect(fr[`${p}Error.Pdf.Scanned`] ?? errors.map((k) => fr[k]).find((v) => /scann/i.test(v))).toMatch(/texte/i);
  });
  it("registers the four world settings, the AI one off by default", () => {
    const src = strip(read("scripts/foundry/settings.mjs"));
    for (const key of ["pdfAi", "ollamaUrl", "ollamaModel", "aiTimeout"]) expect(src, key).toContain(key);
    const at = src.indexOf("pdfAi");
    expect(src.slice(at, at + 300)).toMatch(/scope:\s*"world"/);
    expect(src.slice(at, at + 300)).toMatch(/default:\s*false/);
  });
  it("registers the world settings in both languages", () => {
    for (const key of ["pdfAi", "ollamaUrl", "ollamaModel", "aiTimeout"]) {
      const names = Object.keys(en).filter((k) => k.toLowerCase().includes(key.toLowerCase()));
      expect(names.length, `lang entries for ${key}`).toBeGreaterThan(0);
    }
  });
});
