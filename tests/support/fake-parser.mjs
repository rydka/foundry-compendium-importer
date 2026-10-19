// Fake dnd5e-text-parser (API v1) for unit tests of core/enrich: plans are looked up by feature name,
// so the tests control exactly what the "library" recognizes. Real parsing is tested in the library and,
// end to end, in the integration specs.
// The pure helpers (nameKey, mergeMissing, isEmpty, isEmptyUtility, toActorPatch) are those of the real library.
import { isEmpty, isEmptyUtility, mergeMissing, nameKey, toActorPatch } from "dnd5e-text-parser";

export const emptyPlan = (extra = {}) => ({
  skip: null, activation: null, attack: null, range: null, target: null, damage: [], save: null,
  template: null, uses: null, recharge: null, legendaryResistance: null, notes: [], ambiguous: [], unrecognized: [],
  ...extra
});

/**
 * @param {Record<string, object>} plans feature name -> plan (+ `_activities`, `_patch`)
 * @param {object} actorPlan returned by parseActor (+ `_patch`)
 */
export function makeParser(plans = {}, actorPlan = null) {
  return {
    nameKey, mergeMissing, isEmpty, isEmptyUtility,
    parseFeature: (name) => (plans[name] ? emptyPlan(plans[name]) : emptyPlan()),
    toActivities: (plan) => JSON.parse(JSON.stringify(plan._activities ?? [])),
    toItemPatch: (plan) => JSON.parse(JSON.stringify(plan._patch ?? {})),
    parseActor: () => actorPlan,
    // `_patch` (real format: traits as a complete union, attributes.spellcasting, spells.spellN) wins; else the real translation
    toActorPatch: (plan, options) => (plan?._patch
      ? { system: JSON.parse(JSON.stringify(plan._patch)), notes: [] }
      : toActorPatch(plan, options)),
    // `_effects` (effects built by the "library") and `_effectNotes` (its Note.NotAutomated remarks)
    toEffects: (plan) => Object.assign(JSON.parse(JSON.stringify(plan._effects ?? [])), { notes: JSON.parse(JSON.stringify(plan._effectNotes ?? [])) }),
    toSpellStubs: () => [],
    describe: () => [],
    keysFromConfig: () => ({})
  };
}

export const counter = (prefix = "gen") => {
  let n = 0;
  return () => `${prefix}${String(++n).padStart(13, "0")}`;
};

export function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const empty = (v) => v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length) || (isObj(v) && !Object.keys(v).length);

/** Leaves (path -> value) that are non-empty in `before` and differ in `after`. */
export function changedLeaves(before, after, path = "") {
  const out = [];
  if (isObj(before)) {
    for (const [k, v] of Object.entries(before)) out.push(...changedLeaves(v, after?.[k], path ? `${path}.${k}` : k));
  } else if (!empty(before) && JSON.stringify(before) !== JSON.stringify(after)) {
    out.push({ path, before, after });
  }
  return out;
}
