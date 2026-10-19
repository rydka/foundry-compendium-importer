// Reference snapshot of api.analyze (v0.2.0 behaviour), used to prove C1 (checkbox off = 0.2.0) and C16 (enrich: false).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Files covered by the snapshot: [id, path relative to the module root, document name]. */
export const BASELINE_FILES = [
  ["tools-out/actors.json", "tools/out/actors.json", "Actor"],
  ["tools-out/items.json", "tools/out/items.json", "Item"],
  ["fixtures/conformity-actors.json", "tests/fixtures/conformity-actors.json", "Actor"],
  ["fixtures/conformity-items.json", "tests/fixtures/conformity-items.json", "Item"],
  ["fixtures/legacy-3x.json", "tests/fixtures/legacy-3x.json", "Item"],
  ["fixtures/activity-link.json", "tests/fixtures/activity-link.json", "Item"],
  ["fixtures/id-conflicts.json", "tests/fixtures/id-conflicts.json", "Item"]
];

export const BASELINE_PATH = path.join(ROOT, "tests", "fixtures", "baseline-v0.2.0.json");
export const readSource = (rel) => readFileSync(path.join(ROOT, rel), "utf8");

export function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
export const sha = (value) => createHash("sha256").update(stable(value)).digest("hex");

/** Compact, comparable digest of an analysis result: one hash per document plus readable facts. */
export function digest(analysis) {
  const activities = (d) => Object.values(d.system?.activities ?? {}).map((a) => a.type);
  const doc = (d) => ({
    name: d.name, type: d.type, hash: sha(d), activities: activities(d),
    items: (d.items ?? []).map((i) => ({ name: i.name, type: i.type, hash: sha(i), activities: activities(i) }))
  });
  return {
    documentName: analysis.documentName,
    accepted: analysis.accepted.map(doc),
    rejected: analysis.rejected.map((r) => ({ name: r.name, type: r.type, hash: sha(r.reasons) })),
    other: analysis.other.length
  };
}
