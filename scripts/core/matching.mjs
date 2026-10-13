const entriesOf = (index) => (typeof index?.values === "function" ? [...index.values()] : [...(index ?? [])]);

/** Normalized form of a name used to match documents: trimmed, single spaces, lower case. */
export function nameKey(name) {
  return String(name ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Ids of the existing documents an import would overwrite: same name and type, otherwise same name.
 * @param {Iterable<{_id: string, name: string, type?: string}>} index
 * @param {object[]} entries
 * @returns {string[]}
 */
export function findOverwriteTargets(index, entries) {
  const byKey = new Map();
  const byName = new Map();
  for (const doc of entriesOf(index)) {
    const name = nameKey(doc.name);
    if (!name) continue;
    byKey.set(`${name}::${doc.type ?? ""}`, doc._id);
    if (!byName.has(name)) byName.set(name, doc._id);
  }
  const ids = new Set();
  for (const entry of entries) {
    const name = nameKey(entry.name);
    if (!name) continue;
    const id = byKey.get(`${name}::${entry.type ?? ""}`) ?? byName.get(name);
    if (id) ids.add(id);
  }
  return [...ids];
}

/**
 * `_id` values of the entries that already exist in the index and are not about to be removed.
 * @param {Iterable<{_id: string}>} index
 * @param {object[]} entries
 * @param {Iterable<string>} removedIds
 * @returns {Set<string>}
 */
export function findIdConflicts(index, entries, removedIds = []) {
  const existing = new Set(entriesOf(index).map((doc) => doc._id));
  const removed = new Set(removedIds);
  const conflicts = new Set();
  for (const entry of entries) {
    if (entry._id && existing.has(entry._id) && !removed.has(entry._id)) conflicts.add(entry._id);
  }
  return conflicts;
}
