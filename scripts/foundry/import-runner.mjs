import { BATCH_SIZE, MODULE_ID, TYPE_FILTERS } from "../constants.mjs";
import { chunk } from "../core/batch.mjs";
import { slugify, worldPackId } from "../core/naming.mjs";
import { remapIds } from "../core/ids.mjs";
import { findIdConflicts, findOverwriteTargets } from "../core/matching.mjs";

const KEY = `${MODULE_ID}.Reason`;
const error = (name, data = {}) => ({ key: `${KEY}.${name}`, data });

/**
 * Resolve the import target from the window choices, without writing anything.
 * @param {{typeFilter: string, targetPack: string, newPackLabel?: string, newPackName?: string, newPackType?: string}} choices
 * @returns {{pack: object|null, newPackSpec: {label: string, name: string, type: string}|null,
 *   errors: {key: string, data: object}[]}}
 */
export function resolveTarget(choices) {
  const filterType = TYPE_FILTERS[choices.typeFilter] ?? null;
  const result = { pack: null, newPackSpec: null, errors: [] };
  if (choices.targetPack && choices.targetPack !== "new") {
    const pack = game.packs.get(choices.targetPack);
    if (!pack) result.errors.push(error("Unreadable", { message: choices.targetPack }));
    else if (pack.locked) result.errors.push(error("PackLocked", { name: pack.metadata.label }));
    else result.pack = pack;
    return result;
  }
  const label = String(choices.newPackLabel ?? "").trim();
  const name = String(choices.newPackName ?? "").trim() || slugify(label);
  const type = filterType ?? choices.newPackType;
  if (!label) result.errors.push(error("MissingLabel"));
  else if (!name) result.errors.push(error("InvalidName"));
  else if (game.packs.has(worldPackId(name))) result.errors.push(error("PackExists", { name }));
  if (!CONST.COMPENDIUM_DOCUMENT_TYPES.includes(type)) result.errors.push(error("Invalid", { message: String(type) }));
  if (!result.errors.length) result.newPackSpec = { label, name, type };
  return result;
}

/**
 * Write the confirmed import: create the pack if needed, delete the documents to overwrite, create the
 * documents in batches. Documents are written with their `_id` (`keepId`, `keepEmbeddedIds`).
 * @param {{pack?: object, newPackSpec?: {label: string, name: string, type: string},
 *   documents: object[], deleteIds?: string[]}} plan
 * @returns {Promise<{created: number, replaced: number}>}
 * @throws {Error} For a non-GM user, a locked pack, or an existing pack name
 */
export async function runImport({ pack, newPackSpec, documents, deleteIds = [] }) {
  if (!game.user.isGM) throw new Error(game.i18n.localize(`${MODULE_ID}.Error.NotGM`));
  if (!pack) {
    const id = worldPackId(newPackSpec.name);
    if (game.packs.has(id)) throw new Error(game.i18n.format(`${KEY}.PackExists`, { name: newPackSpec.name }));
    pack = await foundry.documents.collections.CompendiumCollection.createCompendium({
      label: newPackSpec.label, name: newPackSpec.name, type: newPackSpec.type
    });
  }
  if (pack.locked) throw new Error(game.i18n.format(`${KEY}.PackLocked`, { name: pack.metadata.label }));

  if (deleteIds.length) await pack.documentClass.deleteDocuments(deleteIds, { pack: pack.collection });
  let created = 0;
  for (const batch of chunk(documents, BATCH_SIZE)) {
    const result = await pack.documentClass.createDocuments(batch, {
      pack: pack.collection, keepId: true, keepEmbeddedIds: true
    });
    created += result.length;
  }
  return { created, replaced: deleteIds.length };
}

/**
 * Import from the result of `analyzeEntries`, building the plan like the window does (public API).
 * @param {{accepted: object[], rejected: object[], other: object[]}} analysis
 * @param {{pack?: object, newPackSpec?: object, overwrite?: boolean, stripIds?: boolean,
 *   conflictSelection?: string[], conflictAction?: "replace"|"newId", idGen?: () => string}} options
 *   `conflictSelection`: `_id` values of the conflicting documents to import (others are ignored).
 * @returns {Promise<{created: number, replaced: number, ignored: number, rejected: number}>}
 */
export async function importFromAnalysis(analysis, options = {}) {
  if (!game.user.isGM) throw new Error(game.i18n.localize(`${MODULE_ID}.Error.NotGM`));
  const { pack, newPackSpec, overwrite = true, stripIds = true, conflictSelection = [], conflictAction = "replace",
    idGen = () => foundry.utils.randomID() } = options;
  let documents = [...analysis.accepted, ...(analysis.other ?? [])].map((d) => d.data);
  if (stripIds) documents = documents.map((data) => remapIds(data, idGen));
  const index = pack ? await pack.getIndex({ fields: ["name", "type"] }) : [];
  const deleteIds = new Set(pack && overwrite ? findOverwriteTargets(index, documents) : []);
  const conflicts = pack && !stripIds ? findIdConflicts(index, documents, deleteIds) : new Set();
  const selected = new Set(conflictSelection);
  let ignored = 0;
  const toCreate = [];
  for (let data of documents) {
    if (conflicts.has(data._id)) {
      if (!selected.has(data._id)) {
        ignored++;
        continue;
      }
      if (conflictAction === "replace") deleteIds.add(data._id);
      else data = remapIds(data, idGen);
    }
    toCreate.push(data);
  }
  const result = await runImport({ pack, newPackSpec, documents: toCreate, deleteIds: [...deleteIds] });
  return { ...result, ignored, rejected: analysis.rejected?.length ?? 0 };
}
