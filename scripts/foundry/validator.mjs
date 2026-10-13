import { CHECKED_DOCUMENTS, LEGACY_TYPE_ALIASES } from "../constants.mjs";
import { checkActivityTypes, checkType, describeFailures, findDroppedPaths, findReplaced, isOlderThan } from "../core/conformity.mjs";
import { normalizeEntry } from "../core/normalize.mjs";

const KEY = "compendium-json-importer.Reason";
const MAX_PATHS = 8;

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const NOT_AN_OBJECT = { name: "", type: "", reasons: [{ key: `${KEY}.NotAnObject`, data: {} }] };
const label = (entry) => String(entry?.name ?? entry?._id ?? "");

/** Names of the embedded documents by `_id`, used to make failure paths readable. */
function embeddedNames(data, names = {}) {
  for (const key of ["items", "effects"]) {
    if (!Array.isArray(data?.[key])) continue;
    for (const child of data[key]) {
      if (!isObject(child)) continue;
      if (child._id) names[child._id] = child.name ?? child._id;
      embeddedNames(child, names);
    }
  }
  return names;
}

function hasPersistFlag(data) {
  if (data?.flags?.dnd5e?.persistSourceMigration) return true;
  return ["items", "effects"].some((key) => Array.isArray(data?.[key]) && data[key].some(hasPersistFlag));
}

function typeReasons(data, documentName) {
  const reasons = [];
  const own = checkType(data.type, Object.keys(CONFIG[documentName].dataModels), LEGACY_TYPE_ALIASES[documentName]);
  if (own) reasons.push(own);
  if (documentName === "Actor" && Array.isArray(data.items)) {
    const known = Object.keys(CONFIG.Item.dataModels);
    for (const item of data.items) {
      const reason = isObject(item) && checkType(item.type, known, LEGACY_TYPE_ALIASES.Item, label(item));
      if (reason) reasons.push(reason);
    }
  }
  const activityTypes = Object.keys(CONFIG.DND5E?.activityTypes ?? {});
  if (activityTypes.length) reasons.push(...checkActivityTypes(data, activityTypes));
  return reasons;
}

function failureReasons(err, data, fallbackKey = "Unreadable") {
  if (err instanceof foundry.data.validation.DataModelValidationError) {
    const reasons = describeFailures(err.getAllFailures(), embeddedNames(data));
    return reasons.length ? reasons : [{ key: `${KEY}.Invalid`, data: { message: err.message } }];
  }
  return [{ key: `${KEY}.${fallbackKey}`, data: { message: err.message } }];
}

function droppedReason(paths) {
  const shown = paths.slice(0, MAX_PATHS).join(", ") + (paths.length > MAX_PATHS ? ", …" : "");
  return { key: `${KEY}.DroppedFields`, data: { count: paths.length, paths: shown } };
}

/** Run the dnd5e "world" migrations on the in-memory document. Returns true if anything changed. */
function migrateDocument(doc, documentName, migrationData) {
  const flags = { bypassVersionCheck: false, persistSourceMigration: false };
  const source = doc.toObject();
  const migrations = dnd5e.migrations;
  const update = documentName === "Actor"
    ? migrations.migrateActorData(doc, source, migrationData, flags, {})
    : migrations.migrateItemData(doc, source, migrationData, flags);
  if (foundry.utils.isEmpty(update)) return false;
  doc.updateSource(update);
  doc.validate({ strict: true });
  return true;
}

function checkEntry(entry, documentName, { migrationData, idGen }) {
  const name = label(entry);
  const type = String(entry?.type ?? "");
  const reject = (reasons) => ({ rejected: { name, type, reasons } });
  const cls = CONFIG[documentName].documentClass;
  const systemVersion = game.system.version;
  let normalized;
  try {
    normalized = normalizeEntry(entry, { documentName, idGen, systemVersion });
  } catch (err) {
    return reject(failureReasons(err, entry));
  }
  const { data, declaredVersion } = normalized;
  const reasons = typeReasons(data, documentName);
  if (reasons.length) return reject(reasons);
  let before;
  let doc;
  try {
    before = cls.cleanData(data, { prune: false }, { creation: true });
    doc = new cls(foundry.utils.deepClone(before), { strict: true, creation: true, clean: { migrate: false } });
  } catch (err) {
    return reject(failureReasons(err, data));
  }

  let updated = isOlderThan(declaredVersion, "6.0.0") || hasPersistFlag(before);
  const built = doc.toObject();
  const dropped = findDroppedPaths(before, built);
  // Cleaning turns some invalid values into defaults, null or NaN without failing: compare with what was provided.
  // Older documents are skipped: their legacy shapes are converted by the migration, not by an error.
  const replaced = updated ? [] : findReplaced(data, built);
  if (replaced.length) return reject(replaced.map((data) => ({ key: `${KEY}.ReplacedValue`, data })));
  try {
    updated = migrateDocument(doc, documentName, migrationData) || updated;
  } catch (err) {
    return reject(failureReasons(err, data, "MigrationFailed"));
  }
  const notes = [];
  if (dropped.length) {
    if (!updated) return reject([droppedReason(dropped)]);
    notes.push(droppedReason(dropped));
  }
  const result = doc.toObject();
  if (result._stats) result._stats.systemVersion = systemVersion;
  return { accepted: { data: result, name: result.name ?? name, type: result.type ?? type, updated, notes } };
}

/**
 * Check and migrate entries in memory against the dnd5e 6 data model. Nothing is written.
 * `entries` are the raw entries from the file: the declared `_stats.systemVersion` is read here.
 * @param {object[]} entries
 * @param {string} documentName Document name of the target pack
 * @param {{migrationData?: object, idGen: () => string}} options
 * @returns {Promise<{accepted: object[], rejected: object[], other: object[], documentName: string}>}
 */
export async function analyzeEntries(entries, documentName, { migrationData, idGen = () => foundry.utils.randomID() } = {}) {
  const result = { accepted: [], rejected: [], other: [], documentName };
  const checked = CHECKED_DOCUMENTS.includes(documentName);
  const context = checked && { migrationData: migrationData ?? await dnd5e.migrations.getMigrationData(), idGen };
  for (const entry of entries) {
    if (!isObject(entry)) {
      result.rejected.push(NOT_AN_OBJECT);
    } else if (!checked) {
      const { data } = normalizeEntry(entry, { documentName, idGen, systemVersion: game.system.version });
      result.other.push({ data, name: label(entry), type: String(entry?.type ?? "") });
    } else {
      const { accepted, rejected } = checkEntry(entry, documentName, context);
      if (accepted) result.accepted.push(accepted);
      else result.rejected.push(rejected);
    }
  }
  return result;
}
