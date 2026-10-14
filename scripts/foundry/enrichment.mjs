import { MODULE_ID } from "../constants.mjs";
import { collectLookups, defaultSourceOrder, findMatch, resolveSourceOrder } from "../core/enrich/compendium.mjs";

const LIBRARY = "dnd5e-text-parser";
const API_MAJOR = "1";
let parserPromise;

/**
 * Load the text parser library (ES import, once). Resolves to null when the module is missing, inactive
 * or of another major version: the importer then works as before.
 * @returns {Promise<object|null>}
 */
export function loadParser() {
  parserPromise ??= (async () => {
    if ( !game.modules.get(LIBRARY)?.active ) return null;
    try {
      const parser = await import(foundry.utils.getRoute(`modules/${LIBRARY}/scripts/index.mjs`));
      return String(parser.API_VERSION).split(".")[0] === API_MAJOR ? parser : null;
    } catch(err) {
      console.error(`${MODULE_ID} | cannot load ${LIBRARY}`, err);
      return null;
    }
  })();
  return parserPromise;
}

/** Item compendiums the GM can see, in the shape the core expects. */
export function itemPacks() {
  return game.packs.filter(p => (p.documentName === "Item") && p.visible).map(p => ({
    collection: p.collection,
    label: p.metadata.label,
    packageType: p.metadata.packageType,
    packageName: p.metadata.packageName
  }));
}

/** The rules version decides which dnd5e packs come first (2024 or 2014 content). */
export function rulesVersion() {
  return game.settings.get("dnd5e", "rulesVersion");
}

/** Saved sources merged with the packs that exist now: `[{ pack, enabled }]`. */
export function resolveSources() {
  return resolveSourceOrder(game.settings.get(MODULE_ID, "compendiumSources"), itemPacks(), rulesVersion());
}

/** The default order, ignoring what the GM saved. */
export function defaultSources() {
  return defaultSourceOrder(itemPacks(), rulesVersion());
}

/** Collections to search, in priority order. */
export function getSourceOrder() {
  return resolveSources().filter(source => source.enabled).map(source => source.pack);
}

/** Read the indexes of the sources. A pack that cannot be read is skipped and reported. */
async function loadIndexes(order, skipped) {
  const indexes = new Map();
  for ( const collection of order ) {
    try {
      indexes.set(collection, Array.from((await game.packs.get(collection).getIndex()).values()));
    } catch(err) {
      console.warn(`${MODULE_ID} | ${collection} skipped`, err);
      skipped.push({ pack: collection, message: err.message });
    }
  }
  return indexes;
}

/**
 * Look up the items of the actors in the compendiums, and load only the documents found (one request per pack).
 * @returns {Promise<Map<string, {status: "found"|"ambiguous", data?: object, uuid?: string, packLabel: string}>>}
 */
async function findInCompendiums(entries, parser, skipped) {
  const matches = new Map();
  const lookups = collectLookups(entries, parser);
  if ( !lookups.length ) return matches;
  const order = getSourceOrder();
  const indexes = await loadIndexes(order, skipped);
  const wanted = new Map();
  for ( const { key, type } of lookups ) {
    const id = `${type}|${key}`;
    if ( matches.has(id) ) continue;
    const found = findMatch(indexes, order, key, type);
    if ( found.status === "ambiguous" ) matches.set(id, { status: "ambiguous", packLabel: game.packs.get(found.pack).metadata.label });
    if ( found.status !== "found" ) continue;
    if ( !wanted.has(found.pack) ) wanted.set(found.pack, new Map());
    wanted.get(found.pack).set(found.id, id);
  }
  for ( const [collection, ids] of wanted ) {
    const pack = game.packs.get(collection);
    const documents = await pack.getDocuments({ _id__in: Array.from(ids.keys()) });
    for ( const doc of documents ) {
      const data = game.items.fromCompendium(doc, { clearFolder: true });
      matches.set(ids.get(doc.id), { status: "found", data, uuid: doc.uuid, packLabel: pack.metadata.label });
    }
  }
  return matches;
}

/**
 * Everything the synchronous enrichment needs, read before the analysis loop.
 * Compendiums are only used for actors (their items and the spells of their spellcasting traits).
 * @param {object[]} entries Raw entries of the file
 * @param {string} documentName
 * @param {{useCompendiums: boolean}} options
 * @returns {Promise<{keys: object, matches: Map, pdfLabel: string, skipped: object[]}>}
 */
export async function prepareEnrichment(entries, documentName, { useCompendiums }) {
  const parser = await loadParser();
  const skipped = [];
  const matches = (useCompendiums && (documentName === "Actor"))
    ? await findInCompendiums(entries, parser, skipped) : new Map();
  return {
    keys: parser.keysFromConfig(CONFIG.DND5E),
    matches,
    pdfLabel: game.i18n.localize(`${MODULE_ID}.Enrich.PdfVersion`),
    skipped
  };
}
