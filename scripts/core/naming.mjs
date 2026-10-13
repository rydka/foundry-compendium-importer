/** Lower-case, dash-separated identifier of at most 64 characters. */
export function slugify(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 64)
    .replace(/-$/, "");
}

/** Label and pack name proposed from an import file name. */
export function suggestPackFields(fileName) {
  const label = String(fileName ?? "").split(/[\\/]/).pop().replace(/\.(json|db)$/i, "");
  return { label, name: slugify(label) };
}

/** Collection id of a world pack. */
export function worldPackId(name) {
  return `world.${name}`;
}
