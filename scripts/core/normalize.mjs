const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Put activities in the dnd5e 6 shape: an object indexed by activity `_id`, creating missing ids.
 * @param {object} system
 * @param {() => string} idGen
 * @returns {object} The same system object
 */
export function normalizeActivities(system, idGen) {
  const activities = system?.activities;
  if (!activities || typeof activities !== "object") return system;
  const rebuilt = {};
  const entries = Array.isArray(activities) ? activities.map((a) => [null, a]) : Object.entries(activities);
  for (const [key, activity] of entries) {
    if (!isObject(activity)) {
      if (key !== null) rebuilt[key] = activity;
      continue;
    }
    const id = activity._id || activity.id || key || idGen();
    activity._id = id;
    rebuilt[id] = activity;
  }
  system.activities = rebuilt;
  return system;
}

function ensureIds(list, idGen) {
  if (!Array.isArray(list)) return;
  for (const doc of list) if (isObject(doc) && !doc._id) doc._id = idGen();
}

function prepareItem(item, { idGen, version }) {
  if (!item._id) item._id = idGen();
  if (!("effects" in item)) item.effects = [];
  ensureIds(item.effects, idGen);
  if (isObject(item.system)) normalizeActivities(item.system, idGen);
  if (!isObject(item._stats)) item._stats = {};
  item._stats.systemVersion ??= version;
}

/**
 * Prepare one raw entry for the conformity check. Works on a copy.
 * @param {object} entry
 * @param {{documentName: string, idGen: () => string, systemVersion: string}} options
 * @returns {{data: object, declaredVersion: string|null}} declaredVersion: the `_stats.systemVersion` found in the file
 */
export function normalizeEntry(entry, { documentName, idGen, systemVersion }) {
  const data = JSON.parse(JSON.stringify(entry));
  if (!data._id) data._id = idGen();
  ensureIds(data.effects, idGen);
  const declaredVersion = data._stats?.systemVersion ?? null;
  const version = declaredVersion ?? systemVersion;
  if (!isObject(data._stats)) data._stats = {};
  data._stats.systemVersion ??= systemVersion;
  if (documentName === "Item") prepareItem(data, { idGen, version: systemVersion });
  if (documentName === "Actor" && Array.isArray(data.items)) {
    for (const item of data.items) if (isObject(item)) prepareItem(item, { idGen, version });
  }
  return { data, declaredVersion };
}
