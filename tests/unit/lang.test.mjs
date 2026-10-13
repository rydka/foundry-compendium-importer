// C17: en.json and fr.json hold exactly the same keys, all under the module prefix, none empty.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (lang) => JSON.parse(readFileSync(new URL(`../../lang/${lang}.json`, import.meta.url), "utf8"));

function flatten(obj, prefix = "") {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object") Object.assign(out, flatten(v, key));
    else out[key] = v;
  }
  return out;
}

describe("translations (C17)", () => {
  const en = flatten(read("en"));
  const fr = flatten(read("fr"));

  it("have the same keys in en and fr", () => {
    expect(Object.keys(fr).sort()).toEqual(Object.keys(en).sort());
  });

  it("use only the compendium-json-importer prefix", () => {
    for (const key of Object.keys(en)) expect(key.startsWith("compendium-json-importer.")).toBe(true);
  });

  it("have no empty value", () => {
    for (const [key, value] of Object.entries(en)) expect(String(value).trim(), `en ${key}`).not.toBe("");
    for (const [key, value] of Object.entries(fr)) expect(String(value).trim(), `fr ${key}`).not.toBe("");
  });

  it("French is actually translated (fewer than 30 % identical strings)", () => {
    const keys = Object.keys(en);
    const same = keys.filter((k) => en[k] === fr[k]);
    expect(same.length / keys.length).toBeLessThan(0.3);
  });

  it("keeps the same {placeholders} in both languages", () => {
    const ph = (s) => (String(s).match(/\{[^}]+\}/g) ?? []).sort();
    for (const key of Object.keys(en)) expect(ph(fr[key]), key).toEqual(ph(en[key]));
  });
});
