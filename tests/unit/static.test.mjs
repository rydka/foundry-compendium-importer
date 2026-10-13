// C2 and M7: static checks on the source of the module (no Foundry needed).
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SCRIPTS = fileURLToPath(new URL("../../scripts", import.meta.url));
const TEMPLATES = fileURLToPath(new URL("../../templates", import.meta.url));

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const files = walk(SCRIPTS).filter((f) => /\.(m?js)$/.test(f));
const source = (file) => readFileSync(file, "utf8");
const rel = (file) => path.relative(SCRIPTS, file).replaceAll("\\", "/");

describe("deprecated API usage (C2)", () => {
  it("has script files to check", () => {
    expect(files.length).toBeGreaterThan(5);
  });

  // Global names are only an error when not prefixed by "foundry." (namespaced access is the supported one).
  const bare = [
    ["FormApplication", /(?<![\w.])FormApplication\b/],
    ["CompendiumCollection.", /(?<![\w.])CompendiumCollection\./],
    ["renderTemplate(", /(?<![\w.])renderTemplate\(/],
    ["readTextFromFile(", /(?<![\w.])readTextFromFile\(/],
    ["loadTemplates(", /(?<![\w.])loadTemplates\(/],
    ["getDocumentClass(", /(?<![\w.])getDocumentClass\(/],
    ["mergeObject(", /(?<![\w.])mergeObject\(/],
    ["randomID(", /(?<![\w.])randomID\(/],
    ["Application (V1)", /extends\s+Application\b/],
    ["jQuery", /(?<![\w.])\$\(|\bhtml\.find\(/]
  ];

  for (const [label, pattern] of bare) {
    it(`does not use the bare global ${label}`, () => {
      const hits = files.filter((f) => pattern.test(source(f))).map(rel);
      expect(hits).toEqual([]);
    });
  }

  it("does not use the removed {{#select}} Handlebars helper", () => {
    const tpl = walk(TEMPLATES).filter((f) => f.endsWith(".hbs") || f.endsWith(".html"));
    expect(tpl.filter((f) => /\{\{#select\b/.test(readFileSync(f, "utf8")))).toEqual([]);
  });

  it("does not use the deprecated '-=' deletion keys or performDeletions", () => {
    expect(files.filter((f) => /performDeletions|["'`]-=/.test(source(f))).map(rel)).toEqual([]);
  });

  it("builds the window on ApplicationV2", () => {
    const app = files.find((f) => rel(f) === "foundry/importer-app.mjs");
    expect(source(app)).toContain("ApplicationV2");
    expect(source(app)).toContain("HandlebarsApplicationMixin");
  });

  it("keeps scripts/core free of Foundry and browser globals", () => {
    const core = files.filter((f) => rel(f).startsWith("core/"));
    const forbidden = /(?<![\w.])(game|ui|foundry|CONFIG|CONST|Hooks|document|window|dnd5e|console|fetch)\b(?=[.[(])/;
    expect(core.filter((f) => forbidden.test(source(f).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ""))).map(rel)).toEqual([]);
  });
});

describe("size and duplication (M7)", () => {
  it("reports the line count of scripts/ (M7 is recorded, not blocking; see tests/metrics/m7.mjs)", () => {
    const total = files.reduce((n, f) => n + source(f).split("\n").length, 0);
    console.log(`M7: ${total} lines in scripts/ (target 700)`);
    expect(total).toBeGreaterThan(0);
  });

  it("defines no function twice across files", () => {
    const seen = new Map();
    for (const f of files) {
      for (const m of source(f).matchAll(/^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)/gm)) {
        seen.set(m[1], [...(seen.get(m[1]) ?? []), rel(f)]);
      }
    }
    const dups = [...seen].filter(([, where]) => where.length > 1);
    expect(dups).toEqual([]);
  });
});
