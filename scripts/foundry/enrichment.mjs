import { MODULE_ID } from "../constants.mjs";
import { collectLookups, defaultSourceOrder, findMatch, LookupTable, resolveSourceOrder } from "../core/enrich/compendium.mjs";

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

/**
 * Index entries of one pack. The lookup only needs `_id`, `name` and `type`, which the index sent with the
 * world already holds for every pack: no request, and no wait on the fuller indexes dnd5e asks for at startup.
 * An empty index is requested once (a pack really empty stays empty).
 */
async function readIndex(pack) {
  const index = pack.index.size ? pack.index : await pack.getIndex();
  return Array.from(index.values());
}

/** Read the indexes of the sources, all at once. A pack that cannot be read is skipped and reported. */
async function loadIndexes(order) {
  const skipped = [];
  const read = await Promise.all(order.map(async collection => {
    try {
      return [collection, await readIndex(game.packs.get(collection))];
    } catch(err) {
      console.warn(`${MODULE_ID} | ${collection} skipped`, err);
      skipped.push({ pack: collection, message: err.message });
      return null;
    }
  }));
  return { indexes: new Map(read.filter(Boolean)), skipped };
}

// The indexes read for one source order, kept until the sources, the packs or their contents change.
let indexCache = null;

/**
 * Indexes of the enabled sources, read in the background the first time (the window calls it when it opens,
 * the analysis reuses the same promise). The cache follows the source order: a source toggled or reordered, a
 * pack created or deleted changes the order and triggers a new read; `invalidateIndexes` handles the contents.
 * @returns {Promise<{order: string[], indexes: Map<string, object[]>, skipped: {pack: string, message: string}[]}>}
 */
export function preloadIndexes() {
  const order = getSourceOrder();
  const key = order.join("\n");
  if ( indexCache?.key !== key ) {
    indexCache = { key, promise: loadIndexes(order).then(result => ({ order, ...result })) };
  }
  return indexCache.promise;
}

/** Forget the indexes read so far (called when the contents of a compendium change). */
export function invalidateIndexes() {
  indexCache = null;
}

/**
 * Look up the items of the actors in the compendiums, and load only the documents found (one request per pack).
 * The index of each pack is keyed once (`LookupTable`); the actor plans go to `plans` for the enrichment.
 * @returns {Promise<Map<string, {status: "found"|"ambiguous", data?: object, uuid?: string, packLabel: string}>>}
 */
async function findInCompendiums(entries, parser, skipped, { keys, plans }) {
  const matches = new Map();
  const lookups = collectLookups(entries, parser, { keys, plans });
  if ( !lookups.length ) return matches;
  const { order, indexes, skipped: unread } = await preloadIndexes();
  skipped.push(...unread);
  const table = new LookupTable(indexes, parser.nameKey);
  const wanted = new Map();
  for ( const { key, type } of lookups ) {
    const id = `${type}|${key}`;
    if ( matches.has(id) ) continue;
    const found = findMatch(table, order, key, type);
    if ( found.status === "ambiguous" ) matches.set(id, { status: "ambiguous", packLabel: game.packs.get(found.pack).metadata.label });
    if ( found.status !== "found" ) continue;
    if ( !wanted.has(found.pack) ) wanted.set(found.pack, new Map());
    wanted.get(found.pack).set(found.id, id);
  }
  // The documents are needed before the review: the enrichment builds the actor items from them (adjusted
  // values of the summary, C23) and the enriched actor is then validated (C2). All packs are read at once.
  await Promise.all(Array.from(wanted, async ([collection, ids]) => {
    const pack = game.packs.get(collection);
    const documents = await pack.getDocuments({ _id__in: Array.from(ids.keys()) });
    for ( const doc of documents ) {
      const data = game.items.fromCompendium(doc, { clearFolder: true });
      matches.set(ids.get(doc.id), { status: "found", data, uuid: doc.uuid, packLabel: pack.metadata.label });
    }
  }));
  return matches;
}

/**
 * Everything the synchronous enrichment needs, read before the analysis loop.
 * Compendiums are only used for actors (their items and the spells of their spellcasting traits).
 * @param {object[]} entries Raw entries of the file
 * @param {string} documentName
 * @param {{useCompendiums: boolean}} options
 * @returns {Promise<{keys: object, matches: Map, plans: WeakMap, pdfLabel: string, skipped: object[]}>}
 */
export async function prepareEnrichment(entries, documentName, { useCompendiums }) {
  const parser = await loadParser();
  const skipped = [];
  const keys = parser.keysFromConfig(CONFIG.DND5E);
  const plans = new WeakMap(); // raw entry -> ActorPlan, parsed once during the lookup
  const matches = (useCompendiums && (documentName === "Actor"))
    ? await findInCompendiums(entries, parser, skipped, { keys, plans }) : new Map();
  return {
    keys,
    matches,
    plans,
    pdfLabel: game.i18n.localize(`${MODULE_ID}.Enrich.PdfVersion`),
    skipped
  };
}
