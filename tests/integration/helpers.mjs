// Shared helpers for the integration specs of compendium-json-importer.
//
// Node-side helpers read the generated fixtures. The `client*` functions run INSIDE Foundry through
// `foundry(fn, arg)` (Playwright serializes them), so they must stay self-contained: no reference to
// anything declared in this file. They drive the module through its public pieces:
//   game.modules.get("compendium-json-importer").api = { open, analyze, runImport }
// and through the core modules served by Foundry at /modules/compendium-json-importer/scripts/core/*.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MODULE_ID = "compendium-json-importer";
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

export const fixturePath = (name) => path.join(FIXTURES, name);
export const fixtureText = (name) => readFileSync(fixturePath(name), "utf8");
export const fixtureJson = (name) => JSON.parse(fixtureText(name));

/** Unique, valid pack name for a test (world packs are named world.<name>). */
export const uniqueName = (prefix) => `${prefix}-${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;

/**
 * Runs the same steps as the window, without the window: parse, analyze (dnd5e migration + strict
 * validation), optional renumbering, then (unless dryRun) overwrite deletion and creation.
 *
 * arg: { text, fileName, documentName, stripIds=true, overwrite=false, packId?, newPack?: {label,name,type},
 *        dryRun=false, deleteIds?: string[] }
 * returns: { counts, accepted: [{name,type,updated}], rejected: [{name,type,reasons:[string]}],
 *            other: n, notes, created, replaced, packId, ms, rawKeys }
 */
export async function clientPipeline(arg) {
  const base = `/modules/compendium-json-importer/scripts`;
  const { parseImportFile } = await import(`${base}/core/parse.mjs`);
  const { remapIds } = await import(`${base}/core/ids.mjs`);
  const { findOverwriteTargets } = await import(`${base}/core/matching.mjs`);
  const api = game.modules.get("compendium-json-importer").api;
  const idGen = () => foundry.utils.randomID();
  const stripIds = arg.stripIds ?? true;

  const { entries } = parseImportFile(arg.text, arg.fileName);
  const pack = arg.packId ? game.packs.get(arg.packId) : null;
  const documentName = arg.documentName ?? pack?.documentName ?? arg.newPack?.type;
  const migrationData = await dnd5e.migrations.getMigrationData();
  const analysis = await api.analyze(entries, documentName, { migrationData, idGen });

  const text = (reason) => {
    for (const key of [reason.key, `compendium-json-importer.${reason.key}`]) {
      if (game.i18n.has(key)) return game.i18n.format(key, reason.data ?? {});
    }
    return `${reason.key} ${JSON.stringify(reason.data ?? {})}`;
  };
  const out = {
    accepted: analysis.accepted.map((d) => ({ name: d.name, type: d.type, updated: !!d.updated, notes: d.notes?.length ?? 0 })),
    rejected: analysis.rejected.map((r) => ({ name: r.name, type: r.type, reasons: r.reasons.map(text), rawReasons: r.reasons })),
    other: analysis.other.length,
    created: 0,
    replaced: 0,
    packId: pack?.collection ?? null,
    ms: 0
  };
  if (arg.dryRun) return out;

  let documents = analysis.accepted.map((d) => d.data);
  documents.push(...analysis.other.map((o) => o.data ?? o));
  if (stripIds) documents = documents.map((d) => remapIds(d, idGen));
  let deleteIds = arg.deleteIds ?? [];
  if (arg.overwrite && pack) {
    const index = await pack.getIndex({ fields: ["name", "type"] });
    deleteIds = findOverwriteTargets(index, documents);
  }
  const t0 = performance.now();
  const result = await api.runImport({ pack: pack ?? undefined, newPackSpec: arg.newPack, documents, deleteIds });
  out.ms = performance.now() - t0;
  out.created = result.created;
  out.replaced = result.replaced;
  const target = pack ?? game.packs.get(`world.${arg.newPack.name}`);
  out.packId = target.collection;
  return out;
}

/** Documents of a pack as plain objects, plus counts, for assertions. */
export async function clientReadPack(packId) {
  const pack = game.packs.get(packId);
  if (!pack) return null;
  const docs = await pack.getDocuments();
  return docs.map((d) => d.toObject());
}

/** Deletes world packs by name (cleanup). Missing packs are ignored. */
export async function clientDeletePacks(names) {
  for (const name of names) {
    const pack = game.packs.get(`world.${name}`);
    if (pack) await pack.deleteCompendium();
  }
  return game.packs.filter((p) => p.collection.startsWith("world.")).length;
}

/**
 * Picks a deterministic sample from dnd5e packs and returns plain objects (toObject()).
 * arg: [{ pack: "dnd5e.items", count, type?, filter?: "activities"|"effects", skip? }]
 * Names are made unique with a suffix when suffix is given.
 */
export async function clientExtractFromPacks(arg) {
  const out = [];
  for (const spec of arg.picks) {
    const pack = game.packs.get(spec.pack);
    if (!pack) throw new Error(`pack ${spec.pack} not found`);
    const index = await pack.getIndex({ fields: ["name", "type"] });
    const sorted = Array.from(index).filter((e) => !spec.type || e.type === spec.type).sort((a, b) => (a._id < b._id ? -1 : 1));
    let taken = 0;
    for (const entry of sorted.slice(spec.skip ?? 0)) {
      if (taken >= spec.count) break;
      const doc = await pack.getDocument(entry._id);
      const data = doc.toObject();
      const activities = Object.keys(data.system?.activities ?? {}).length;
      if (spec.filter === "activities" && !activities) continue;
      if (spec.filter === "effects" && !data.effects?.length) continue;
      if (spec.filter === "nested" && !data.items?.length) continue;
      if (arg.suffix) data.name = `${data.name} ${arg.suffix}${out.length}`;
      out.push(data);
      taken++;
    }
  }
  return out;
}

/** Counts of things that must be unchanged after a refused or cancelled import. */
export async function clientSnapshot() {
  const worldPacks = game.packs.filter((p) => p.collection.startsWith("world."));
  const sizes = {};
  for (const p of worldPacks) sizes[p.collection] = (await p.getIndex()).size;
  return { packs: game.packs.size, sizes };
}

/** Parses text with the module parser inside Foundry. Returns { count } or { code, line }. */
export async function clientParse(arg) {
  const { parseImportFile, ImportFormatError } = await import("/modules/compendium-json-importer/scripts/core/parse.mjs");
  try {
    return { count: parseImportFile(arg.text, arg.fileName).entries.length };
  } catch (err) {
    if (err instanceof ImportFormatError) return { code: err.code, line: err.line ?? null };
    return { code: "other", message: String(err) };
  }
}

/** Creates a world Item pack seeded with documents (keeps their ids). Returns the pack id. */
export async function clientSeedPack(arg) {
  const pack = await foundry.documents.collections.CompendiumCollection.createCompendium({
    label: arg.name, name: arg.name, type: arg.type ?? "Item"
  });
  if (arg.documents?.length) {
    await pack.documentClass.createDocuments(arg.documents, { pack: pack.collection, keepId: true, keepEmbeddedIds: true });
  }
  return pack.collection;
}
