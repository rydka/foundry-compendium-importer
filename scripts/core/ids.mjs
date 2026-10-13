const isObject = (value) => value !== null && typeof value === "object";

function collectIds(node, found) {
  if (Array.isArray(node)) return node.forEach((child) => collectIds(child, found));
  if (!isObject(node)) return;
  if (typeof node._id === "string" && node._id) found.add(node._id);
  if (isObject(node.system?.activities) && !Array.isArray(node.system.activities)) {
    for (const key of Object.keys(node.system.activities)) found.add(key);
  }
  for (const child of Object.values(node)) collectIds(child, found);
}

function rewriteString(value, map) {
  if (map.has(value)) return map.get(value);
  if (!value.includes(".")) return value;
  return value.split(".").map((part) => map.get(part) ?? part).join(".");
}

function rewrite(node, map) {
  if (typeof node === "string") return rewriteString(node, map);
  if (Array.isArray(node)) return node.map((child) => rewrite(child, map));
  if (!isObject(node)) return node;
  const out = {};
  for (const [key, value] of Object.entries(node)) out[map.get(key) ?? key] = rewrite(value, map);
  return out;
}

/**
 * Give every document, embedded document and activity a new `_id`, and rewrite the internal references
 * (strings equal to an old id, or containing it as a dot-separated segment).
 * @param {object} data
 * @param {() => string} idGen
 * @returns {object} A new object
 */
export function remapIds(data, idGen) {
  const found = new Set();
  collectIds(data, found);
  const map = new Map();
  for (const id of found) map.set(id, idGen());
  return rewrite(data, map);
}
