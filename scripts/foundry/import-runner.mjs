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
    if (!pack) result.errors.push(error("PackNotFound", { name: choices.targetPack }));
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
  if (!CONST.COMPENDIUM_DOCUMENT_TYPES.includes(type)) result.errors.push(error("InvalidPackType", { type: String(type) }));
  if (!result.errors.length) result.newPackSpec = { label, name, type };
  return result;
}

/** Put back the overwritten documents whose replacement was not created; returns whether it worked. */
async function putBack(pack, lost, options) {
  try {
    return (await pack.documentClass.createDocuments(lost, options)).length === lost.length;
  } catch (restoreErr) {
    console.error(restoreErr);
    return false;
  }
}

/** Overwritten documents (as data) that no created document replaces, matched by `_id` or by name and type. */
function unreplaced(removed, planned, createdIds) {
  const made = planned.filter((data) => createdIds.has(data._id));
  const replacedIds = new Set(findOverwriteTargets(removed, made));
  for (const data of made) replacedIds.add(data._id);
  return removed.filter((data) => !replacedIds.has(data._id));
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

  const options = { pack: pack.collection, keepId: true, keepEmbeddedIds: true };
  const removed = deleteIds.length ? (await pack.getDocuments({ _id__in: deleteIds })).map((doc) => doc.toObject()) : [];
  if (removed.length) await pack.documentClass.deleteDocuments(deleteIds, { pack: pack.collection });
  const createdIds = new Set();
  let failure = null;
  try {
    for (const batch of chunk(documents, BATCH_SIZE)) {
      const result = await pack.documentClass.createDocuments(batch, options);
      for (const doc of result) createdIds.add(doc.id);
    }
  } catch (err) {
    failure = err;
  }
  const lost = unreplaced(removed, documents, createdIds);
  const restored = lost.length ? await putBack(pack, lost, options) : true;
  const names = lost.map((data) => data.name).join(", ");
  if (failure) {
    if (!lost.length) throw failure;
    const key = `${MODULE_ID}.Error.${restored ? "Restored" : "Lost"}`;
    throw new Error(game.i18n.format(key, { names, message: failure.message }), { cause: failure });
  }
  if (lost.length) {
    const message = game.i18n.format(`${MODULE_ID}.Error.${restored ? "Skipped" : "SkippedLost"}`, { names });
    if (!restored) throw new Error(message);
    ui.notifications.warn(message);
  }
  return { created: createdIds.size, replaced: removed.length - lost.length };
}

/**
 * Plan an import without writing: new ids, documents to overwrite, id conflicts, duplicate ids in the file.
 * @param {object[]} documents Data of the documents to import
 * @param {Iterable<{_id: string}>} index Index of the target pack ([] for a new pack)
 * @param {{overwrite: boolean, stripIds: boolean, hasPack: boolean, idGen: () => string}} options
 */
export function planImport(documents, index, { overwrite, stripIds, hasPack, idGen }) {
  const planned = stripIds ? documents.map((data) => remapIds(data, idGen)) : documents;
  const overwriteIds = hasPack && overwrite ? findOverwriteTargets(index, planned) : [];
  const conflictIds = hasPack && !stripIds ? findIdConflicts(index, planned, new Set(overwriteIds)) : new Set();
  const seen = new Set();
  const duplicateIds = new Set();
  for (const { _id } of planned) (seen.has(_id) ? duplicateIds : seen).add(_id);
  return { documents: planned, overwriteIds, conflictIds, duplicateIds: [...duplicateIds] };
}

/** Apply the choices made on id conflicts: returns the documents to create and the ids to delete. */
export function applyConflictChoices(documents, plan, { selected, action, idGen }) {
  const deleteIds = new Set(plan.overwriteIds);
  const toCreate = [];
  let ignored = 0;
  for (let data of documents) {
    if (plan.conflictIds.has(data._id)) {
      if (!selected.has(data._id)) {
        ignored++;
        continue;
      }
      if (action === "replace") deleteIds.add(data._id);
      else data = remapIds(data, idGen);
    }
    toCreate.push(data);
  }
  return { toCreate, deleteIds: [...deleteIds], ignored };
}

/**
 * Import from the result of `analyzeEntries`, planning like the window does (public API).
 * @param {{accepted: object[], rejected: object[], other: object[], documentName?: string}} analysis
 * @param {{pack?: object, newPackSpec?: object, overwrite?: boolean, stripIds?: boolean,
 *   conflictSelection?: string[], conflictAction?: "replace"|"newId", idGen?: () => string}} options
 *   `conflictSelection`: `_id` values of the conflicting documents to import (others are ignored).
 * @returns {Promise<{created: number, replaced: number, ignored: number, rejected: number}>}
 */
export async function importFromAnalysis(analysis, options = {}) {
  if (!game.user.isGM) throw new Error(game.i18n.localize(`${MODULE_ID}.Error.NotGM`));
  const { pack, newPackSpec, overwrite = true, stripIds = true, conflictSelection = [], conflictAction = "replace",
    idGen = () => foundry.utils.randomID() } = options;
  const fail = (key, data) => new Error(game.i18n.format(`${MODULE_ID}.Error.${key}`, data));
  if (!Array.isArray(analysis?.accepted)) throw fail("BadAnalysis");
  if (!pack && !newPackSpec?.name) throw fail("NoTarget");
  const documentName = pack ? pack.documentName : newPackSpec.type;
  if (analysis.documentName && analysis.documentName !== documentName) {
    throw fail("AnalysisType", { analysis: analysis.documentName, pack: documentName });
  }
  const documents = [...analysis.accepted, ...(analysis.other ?? [])].map((d) => d.data);
  const index = pack ? await pack.getIndex({ fields: ["name", "type"] }) : [];
  const plan = planImport(documents, index, { overwrite, stripIds, hasPack: !!pack, idGen });
  if (plan.duplicateIds.length) throw fail("DuplicateIds", { ids: plan.duplicateIds.join(", ") });
  const { toCreate, deleteIds, ignored } = applyConflictChoices(plan.documents, plan,
    { selected: new Set(conflictSelection), action: conflictAction, idGen });
  const result = await runImport({ pack, newPackSpec, documents: toCreate, deleteIds });
  return { ...result, ignored, rejected: analysis.rejected?.length ?? 0 };
}
