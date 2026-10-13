// M3 (fidelity on a 20-document sample), M4 (500 items, timed), C15 (500/500 created).
// The data comes from the dnd5e compendium packs inside the running Foundry (deterministic pick by _id).
// Skeleton: not yet run in a real Foundry.
import { expect, test } from "../../../../test-env/fixtures.mjs";
import { clientDeletePacks, clientExtractFromPacks, clientPipeline, clientReadPack, uniqueName } from "./helpers.mjs";

const created = [];
test.afterEach(async ({ foundry }) => {
  if (created.length) await foundry(clientDeletePacks, created.splice(0));
});

const IGNORED = /^(_id|_stats|folder|sort|ownership)(\.|$)/;

/** Leaves of an object as "a.b.0.c" -> value; empty containers are kept as "[]" / "{}". */
function flatten(value, prefix = "", out = {}) {
  if (Array.isArray(value) && value.length) value.forEach((v, i) => flatten(v, prefix ? `${prefix}.${i}` : String(i), out));
  else if (value && typeof value === "object" && Object.keys(value).length) {
    for (const [k, v] of Object.entries(value)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
  } else out[prefix] = Array.isArray(value) ? "[]" : value && typeof value === "object" ? "{}" : value;
  return out;
}

/** Fields of `source` that are missing or different in `stored` (ids, stats, folder, sort, ownership excluded). */
function differences(source, stored) {
  const diffs = [];
  const a = flatten({ ...source, items: undefined });
  const b = flatten({ ...stored, items: undefined });
  for (const [key, value] of Object.entries(a)) {
    if (!key || IGNORED.test(key) || key === "items") continue;
    if (!(key in b)) diffs.push(`${key}: missing`);
    else if (JSON.stringify(b[key]) !== JSON.stringify(value)) diffs.push(`${key}: ${JSON.stringify(value)} -> ${JSON.stringify(b[key])}`);
  }
  const used = new Set();
  for (const nested of source.items ?? []) {
    const match = (stored.items ?? []).find((s, i) => !used.has(i) && s.name === nested.name);
    if (!match) {
      diffs.push(`items[${nested.name}]: missing`);
      continue;
    }
    used.add((stored.items ?? []).indexOf(match));
    diffs.push(...differences(nested, match).map((d) => `items[${nested.name}].${d}`));
  }
  return diffs;
}

async function importSet(foundry, documentName, docs, prefix, stripIds) {
  const name = uniqueName(prefix);
  created.push(name);
  const result = await foundry(clientPipeline, {
    text: JSON.stringify(docs), fileName: `${prefix}.json`, documentName, stripIds,
    newPack: { label: name, name, type: documentName }
  });
  const stored = await foundry(clientReadPack, `world.${name}`);
  return { result, stored };
}

test("M3: a sample of 20 varied dnd5e documents is imported with 100% of documents and fields identical", async ({ foundry }) => {
  test.setTimeout(180_000);
  const actors = await foundry(clientExtractFromPacks, {
    picks: [
      { pack: "dnd5e.monsters", count: 6, type: "npc", filter: "nested" },
      { pack: "dnd5e.heroes", count: 2, type: "character" }
    ]
  });
  const items = await foundry(clientExtractFromPacks, {
    picks: [
      { pack: "dnd5e.items", count: 4, filter: "activities" },
      { pack: "dnd5e.spells", count: 4, filter: "activities" },
      { pack: "dnd5e.items", count: 4, filter: "effects" }
    ]
  });
  expect(actors).toHaveLength(8);
  expect(items.length).toBeGreaterThanOrEqual(10);

  const all = [];
  for (const [documentName, docs, prefix] of [["Actor", actors, "m3a"], ["Item", items, "m3i"]]) {
    const { result, stored } = await importSet(foundry, documentName, docs, prefix, false);
    expect(result.rejected, JSON.stringify(result.rejected.map((r) => [r.name, r.reasons]))).toEqual([]);
    for (const doc of docs) {
      const found = stored.find((s) => s.name === doc.name);
      all.push({ name: doc.name, imported: !!found, diffs: found ? differences(doc, found) : ["not imported"] });
    }
  }
  const total = all.length;
  const importedCount = all.filter((d) => d.imported).length;
  const identical = all.filter((d) => d.diffs.length === 0).length;
  test.info().annotations.push({
    type: "M3",
    description: `documents ${importedCount}/${total}; documents with identical fields ${identical}/${total}`
  });
  const report = all.filter((d) => d.diffs.length).map((d) => `${d.name}: ${d.diffs.slice(0, 5).join("; ")}`);
  expect(importedCount).toBe(total);
  expect(report).toEqual([]);
});

test("M4/C15: 500 dnd5e items are imported in a new compendium in 30 s or less", async ({ foundry }) => {
  test.setTimeout(300_000);
  const docs = await foundry(clientExtractFromPacks, {
    suffix: "m4-",
    picks: [
      { pack: "dnd5e.items", count: 250 },
      { pack: "dnd5e.spells", count: 250, type: "spell" }
    ]
  });
  // Complete with more items if the packs were short.
  if (docs.length < 500) {
    docs.push(...await foundry(clientExtractFromPacks, {
      suffix: "m4b-",
      picks: [{ pack: "dnd5e.items", count: 500 - docs.length, skip: 250 }]
    }));
  }
  expect(docs).toHaveLength(500);

  const name = uniqueName("m4");
  created.push(name);
  const started = Date.now();
  const result = await foundry(clientPipeline, {
    text: JSON.stringify(docs), fileName: "items-500.json", documentName: "Item", stripIds: true,
    newPack: { label: name, name, type: "Item" }
  });
  const totalMs = Date.now() - started;
  const stored = await foundry(async (id) => (await game.packs.get(id).getIndex()).size, `world.${name}`);

  test.info().annotations.push({
    type: "M4",
    description: `write ${Math.round(result.ms)} ms; analysis + write ${totalMs} ms; ${result.created}/500 created; rejected ${result.rejected.length}`
  });
  expect(result.rejected, JSON.stringify(result.rejected.slice(0, 3))).toEqual([]);
  expect(result.created).toBe(500);
  expect(stored).toBe(500);
  expect(result.ms).toBeLessThanOrEqual(30_000);
});
