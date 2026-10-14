// C3: module.json declares the v14 / dnd5e 6 target.
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const manifest = JSON.parse(readFileSync(new URL("../../module.json", import.meta.url), "utf8"));

describe("module.json (C3)", () => {
  it("targets Foundry 14", () => {
    expect(manifest.compatibility.minimum).toBe("14");
    expect(manifest.compatibility.verified).toBe("14");
  });

  it("is version 0.3.0 and requires dnd5e-text-parser 1.0.0", () => {
    expect(manifest.version).toBe("0.3.0");
    const lib = manifest.relationships.requires.find((r) => r.id === "dnd5e-text-parser");
    expect(lib).toBeDefined();
    expect(lib.type).toBe("module");
    expect(lib.compatibility.minimum).toBe("1.0.0");
  });

  it("requires dnd5e 6.0.0 and was verified on 6.0.6", () => {
    const dnd5e = manifest.relationships.systems.find((s) => s.id === "dnd5e");
    expect(dnd5e).toBeDefined();
    expect(dnd5e.compatibility.minimum).toBe("6.0.0");
    expect(dnd5e.compatibility.verified).toBe("6.0.6");
  });

  it("loads only main.mjs, no macro script", () => {
    expect(manifest.esmodules).toEqual(["scripts/main.mjs"]);
  });

  it("declares en and fr languages whose files exist", () => {
    expect(manifest.languages.map((l) => l.lang).sort()).toEqual(["en", "fr"]);
    for (const l of manifest.languages) {
      expect(existsSync(new URL(`../../${l.path}`, import.meta.url)), l.path).toBe(true);
    }
  });
});
