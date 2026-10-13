// C9-C15, C23: reading, creating, overwriting, ids, activities, batches. Driven through the module pieces
// (parser, api.analyze, api.runImport) inside the real Foundry and dnd5e; the window flow is in window.spec.mjs.
// Skeleton: not yet run in a real Foundry.
import { expect, test } from "../../../../test-env/fixtures.mjs";
import {
  clientDeletePacks, clientParse, evidence, clientPipeline, clientReadPack, clientSnapshot, fixtureJson, fixtureText, uniqueName
} from "./helpers.mjs";

const created = [];
test.afterEach(async ({ foundry }) => {
  if (created.length) await foundry(clientDeletePacks, created.splice(0));
});

function newPack(prefix, type = "Item") {
  const name = uniqueName(prefix);
  created.push(name);
  return { name, spec: { label: `${prefix} ${name}`, name, type } };
}

const FORMAT_FILES = ["items.db", "array.json", "entries.json", "documents.json", "items-key.json", "data.json", "array-bom.json"];

for (const file of FORMAT_FILES) {
  test(`C9: formats/${file} imports its 3 documents`, async ({ foundry }) => {
    const pack = newPack("fmt");
    const result = await foundry(clientPipeline, {
      text: fixtureText(`formats/${file}`), fileName: file, documentName: "Item", newPack: pack.spec
    });
    expect(result.created).toBe(3);
    expect(result.rejected).toEqual([]);
    const docs = await foundry(clientReadPack, `world.${pack.name}`);
    evidence(`C9-format-${file}.json`, { file, created: result.created, rejected: result.rejected, names: docs.map((d) => d.name).sort() });
    expect(docs.map((d) => d.name).sort()).toEqual(["Format Amulet", "Format Potion", "Format Sword"]);
  });
}

for (const [file, code] of [
  ["empty.json", "empty"], ["whitespace.json", "empty"], ["broken.json", "invalidJson"],
  ["broken-line.db", "invalidLine"], ["empty-object.json", "noDocuments"], ["empty-array.json", "noDocuments"],
  ["empty-entries.json", "noDocuments"]
]) {
  test(`C10: ${file} is refused (${code}) and nothing is created`, async ({ foundry }) => {
    const before = await foundry(clientSnapshot);
    const parsed = await foundry(clientParse, { text: fixtureText(`formats/${file}`), fileName: file });
    evidence(`C10-refus-${file}.json`, { file, expected: code, parsed });
    expect(parsed.code).toBe(code);
    expect(await foundry(clientSnapshot)).toEqual(before);
  });
}

test("C11: a new world compendium is created with the given label and name; a duplicate name is refused", async ({ foundry }) => {
  const pack = newPack("newpack");
  const text = fixtureText("formats/array.json");
  const first = await foundry(clientPipeline, { text, fileName: "array.json", documentName: "Item", newPack: pack.spec });
  expect(first.packId).toBe(`world.${pack.name}`);
  const meta = await foundry((id) => ({ label: game.packs.get(id).metadata.label, type: game.packs.get(id).documentName }), `world.${pack.name}`);
  evidence("C11-nouveau-compendium.json", { packId: first.packId, meta });
  expect(meta).toEqual({ label: pack.spec.label, type: "Item" });

  const before = await foundry(clientSnapshot);
  const dup = await foundry(async ({ spec }) => {
    try {
      const api = game.modules.get("compendium-json-importer").api;
      await api.runImport(await api.analyze([{ name: "x", type: "loot" }], "Item"), { newPackSpec: spec });
      return { refused: false };
    } catch (err) {
      return { refused: true, message: err.message };
    }
  }, { spec: pack.spec });
  evidence("C11-nom-en-double.json", dup);
  expect(dup.refused).toBe(true);
  expect(dup.message).toBeTruthy();
  expect(await foundry(clientSnapshot)).toEqual(before);
});

test("C12: overwrite replaces same-name documents, without it nothing is deleted", async ({ foundry }) => {
  const pack = newPack("overwrite");
  const text = fixtureText("formats/array.json");
  await foundry(clientPipeline, { text, fileName: "array.json", documentName: "Item", newPack: pack.spec });
  const id = `world.${pack.name}`;

  const kept = await foundry(clientPipeline, { text, fileName: "array.json", packId: id, overwrite: false });
  expect(kept.replaced).toBe(0);
  expect(await foundry(async (p) => (await game.packs.get(p).getIndex()).size, id)).toBe(6);

  const replaced = await foundry(clientPipeline, { text, fileName: "array.json", packId: id, overwrite: true });
  expect(replaced.replaced).toBe(6);
  expect(replaced.created).toBe(3);
  const names = (await foundry(clientReadPack, id)).map((d) => d.name).sort();
  evidence("C12-ecrasement.json", { withoutOverwrite: { replaced: kept.replaced }, withOverwrite: { replaced: replaced.replaced, created: replaced.created }, names });
  expect(names).toEqual(["Format Amulet", "Format Potion", "Format Sword"]);
});

test("C13: with 'strip ids' no _id of the file survives, nested documents included", async ({ foundry }) => {
  const doc = fixtureJson("conformity-actors.json").find((d) => d.name === "Ok Skeleton With Club");
  const fileIds = [doc._id, ...doc.items.map((i) => i._id)];
  const pack = newPack("strip", "Actor");
  await foundry(clientPipeline, {
    text: JSON.stringify([doc]), fileName: "a.json", documentName: "Actor", newPack: pack.spec, stripIds: true
  });
  const [stored] = await foundry(clientReadPack, `world.${pack.name}`);
  const storedIds = [stored._id, ...stored.items.map((i) => i._id)];
  evidence("C13-ids-renumerotes.json", { fileIds, storedIds });
  expect(stored.items).toHaveLength(2);
  for (const id of fileIds) expect(storedIds).not.toContain(id);
});

test("C13: without 'strip ids' the _id of the file are kept, nested documents included", async ({ foundry }) => {
  const doc = fixtureJson("conformity-actors.json").find((d) => d.name === "Ok Skeleton With Club");
  const pack = newPack("keepids", "Actor");
  await foundry(clientPipeline, {
    text: JSON.stringify([doc]), fileName: "a.json", documentName: "Actor", newPack: pack.spec, stripIds: false
  });
  const [stored] = await foundry(clientReadPack, `world.${pack.name}`);
  evidence("C13-ids-conserves.json", { fileId: doc._id, storedId: stored._id, nested: stored.items.map((i) => i._id) });
  expect(stored._id).toBe(doc._id);
  expect(stored.items.map((i) => i._id).sort()).toEqual(doc.items.map((i) => i._id).sort());
});

test("C14: activities given as an array become an object indexed by _id, usable in dnd5e", async ({ foundry }) => {
  const doc = fixtureJson("conformity-items.json").find((d) => d.name === "Ok Shortbow Array Activities");
  expect(Array.isArray(doc.system.activities)).toBe(true);
  const pack = newPack("acts");
  const result = await foundry(clientPipeline, { text: JSON.stringify([doc]), fileName: "i.json", documentName: "Item", newPack: pack.spec });
  expect(result.created).toBe(1);
  const info = await foundry(async (id) => {
    const [item] = await game.packs.get(id).getDocuments();
    const source = item.toObject().system.activities;
    return {
      size: item.system.activities.size,
      keysMatch: Object.entries(source).every(([k, a]) => a._id === k),
      isArray: Array.isArray(source)
    };
  }, `world.${pack.name}`);
  evidence("C14-activites.json", info);
  expect(info).toEqual({ size: 1, keysMatch: true, isArray: false });
});

test("C23: renumbered ids keep the activity -> effect link valid", async ({ foundry }) => {
  const doc = fixtureJson("activity-link.json")[0];
  const pack = newPack("links");
  await foundry(clientPipeline, { text: JSON.stringify([doc]), fileName: "l.json", documentName: "Item", newPack: pack.spec, stripIds: true });
  const info = await foundry(async (id) => {
    const [item] = await game.packs.get(id).getDocuments();
    const activity = item.system.activities.contents[0];
    const linked = activity.effects.map((e) => e._id);
    return {
      itemId: item.id,
      activityId: activity.id,
      linked,
      effectIds: item.effects.map((e) => e.id),
      resolved: activity.effects.map((e) => !!item.effects.get(e._id))
    };
  }, `world.${pack.name}`);
  evidence("C23-liens-renumerotes.json", info);
  expect(info.itemId).not.toBe("linkedItem000001");
  expect(info.activityId).not.toBe("linkedActiv00001");
  expect(info.effectIds).not.toContain("linkedEffect0001");
  expect(info.linked).toHaveLength(1);
  expect(info.resolved).toEqual([true]);
});

test("C23: without renumbering the link keeps the file ids and stays valid", async ({ foundry }) => {
  const doc = fixtureJson("activity-link.json")[0];
  const pack = newPack("linkskeep");
  await foundry(clientPipeline, { text: JSON.stringify([doc]), fileName: "l.json", documentName: "Item", newPack: pack.spec, stripIds: false });
  const resolved = await foundry(async (id) => {
    const [item] = await game.packs.get(id).getDocuments();
    return item.system.activities.contents[0].effects.map((e) => !!item.effects.get(e._id));
  }, `world.${pack.name}`);
  evidence("C23-liens-conserves.json", { resolved });
  expect(resolved).toEqual([true]);
});

test("C15: 120 documents are all imported (several batches)", async ({ foundry }) => {
  const docs = Array.from({ length: 120 }, (_, i) => ({ name: `Batch Loot ${i}`, type: "loot", system: { quantity: i + 1 } }));
  const pack = newPack("batch");
  const result = await foundry(clientPipeline, { text: JSON.stringify(docs), fileName: "batch.json", documentName: "Item", newPack: pack.spec });
  evidence("C15-120-documents.json", { created: result.created, rejected: result.rejected.length });
  expect(result.created).toBe(120);
  expect(await foundry(async (id) => (await game.packs.get(id).getIndex()).size, `world.${pack.name}`)).toBe(120);
});
