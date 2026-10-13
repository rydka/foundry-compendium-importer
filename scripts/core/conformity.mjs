const KEY = "compendium-json-importer.Reason";
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Reject an unknown document type. `aliases` maps legacy types to current ones (accepted).
 * @param {*} type
 * @param {string[]} knownTypes
 * @param {Record<string, string>} [aliases]
 * @param {string} [nestedName] Name of the embedded document being checked, if any
 * @returns {{key: string, data: object}|null}
 */
export function checkType(type, knownTypes, aliases = {}, nestedName = undefined) {
  const nested = nestedName === undefined ? "" : "Nested";
  const data = nestedName === undefined ? { type } : { type, name: nestedName };
  if (typeof type !== "string" || !type) return { key: `${KEY}.MissingType${nested}`, data };
  if (knownTypes.includes(type) || Object.hasOwn(aliases ?? {}, type)) return null;
  return { key: `${KEY}.UnknownType${nested}`, data: { ...data, known: knownTypes.join(", ") } };
}

function walk(before, after, prefix, embedded, out) {
  if (isObject(before.system)) dropped(before.system, isObject(after?.system) ? after.system : {}, `${prefix}system`, out);
  for (const key of embedded) {
    if (!Array.isArray(before[key])) continue;
    const afterList = Array.isArray(after?.[key]) ? after[key] : [];
    before[key].forEach((child, i) => {
      if (!isObject(child)) return;
      const match = afterList.find((c) => child._id && c?._id === child._id) ?? afterList[i];
      walk(child, match ?? {}, `${prefix}${key}[${child.name ?? child._id ?? i}].`, embedded, out);
    });
  }
}

function dropped(before, after, path, out) {
  if (Array.isArray(before)) {
    before.forEach((value, i) => {
      if (isObject(value) || Array.isArray(value)) dropped(value, Array.isArray(after) ? (after[i] ?? {}) : {}, `${path}[${i}]`, out);
    });
    return;
  }
  for (const [key, value] of Object.entries(before)) {
    const here = `${path}.${key}`;
    if (!isObject(after) || !Object.hasOwn(after, key)) out.push(here);
    else if (value !== null && typeof value === "object") dropped(value, after[key], here, out);
  }
}

/**
 * Paths present in `before` and removed by cleaning (`after`), within `system` of the document and of its
 * embedded `items` / `effects`.
 * @param {object} before Data before pruning
 * @param {object} after Data after pruning
 * @param {{scope?: string, embedded?: string[]}} [options]
 * @returns {string[]} Readable paths, for example `items[Longsword].system.foo`
 */
export function findDroppedPaths(before, after, { embedded = ["items", "effects"] } = {}) {
  const out = [];
  walk(before ?? {}, after ?? {}, "", embedded, out);
  return out;
}

/**
 * Turn validation failures into readable reasons.
 * @param {Record<string, {message?: string}>} failures Keyed by field path (`items.<id>.system.foo`)
 * @param {Record<string, string>} [embeddedNames] Embedded document names by `_id`
 * @returns {{key: string, data: {path: string, message: string}}[]}
 */
export function describeFailures(failures, embeddedNames = {}) {
  return Object.entries(failures ?? {}).map(([field, failure]) => {
    const path = field.split(".").reduce((acc, part) => {
      if (Object.hasOwn(embeddedNames, part)) return `${acc}[${embeddedNames[part]}]`;
      return acc ? `${acc}.${part}` : part;
    }, "");
    return { key: `${KEY}.InvalidField`, data: { path, message: failure?.message ?? String(failure) } };
  });
}

const parseVersion = (value) => (/^\d+(\.\d+)*$/.test(String(value)) ? String(value).split(".").map(Number) : null);

/** True if `version` is a valid version strictly lower than `reference`. Unknown versions are not older. */
export function isOlderThan(version, reference) {
  const a = parseVersion(version);
  const b = parseVersion(reference);
  if (!a || !b) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff) return diff < 0;
  }
  return false;
}

/** Counts for the review step. `toReplace` is the list of existing ids to be replaced. */
export function summarize({ accepted = [], rejected = [], other = [], toReplace = [] } = {}) {
  return {
    conform: accepted.length,
    updated: accepted.filter((doc) => doc.updated).length,
    rejected,
    other: other.length,
    toReplace: toReplace.length
  };
}
