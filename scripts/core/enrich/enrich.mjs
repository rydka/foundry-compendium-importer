/**
 * Enrichment of one document (C3-C14, C18-C23, C25), pure and synchronous.
 * The text parser (dnd5e-text-parser API v1) is injected: no import of Foundry URLs here.
 *
 * Policy (C3): only empty fields are filled, never a filled one. Exceptions, both signalled in the report:
 *  - C12: "Legendary Resistance (n/Day)" is moved from the legendary activation to `special`;
 *  - v3 decision: "Costs N Actions" in the text overrides the legendary cost of the file.
 * Names of the file are always kept, also for elements taken from a compendium.
 */

import { adjustToFacts, appendPdfNote, isMultiattackKey } from "./compendium.mjs";
import { challengeRatingOf, formatChallengeRating } from "../challenge.mjs";

const KEY = "compendium-json-importer.Enrich.";
const clone = v => JSON.parse(JSON.stringify(v));

/**
 * Empty-value helpers of the library (isEmpty, isEmptyUtility, mergeMissing), bound by `enrichEntry` from `ctx.parser`
 * so that the pure core never imports a Foundry URL.
 */
let lib = null;
const isEmpty = v => lib.isEmpty(v);
const isEmptyUtility = a => lib.isEmptyUtility(a);
const merge = (target, patch, options) => lib.mergeMissing(target, patch, options);
const SPELL_ONLY = new Set(["attack", "save"]);
const FILLABLE = new Set(["attack", "save", "damage"]);

// ---------------------------------------------------------------- facts of the file

const num = v => (v === "" || v === null || v === undefined || Number.isNaN(Number(v)) ? null : Number(v));
const toPart = p => ({ number: p.number ?? null, denomination: p.denomination ?? null, bonus: p.bonus ?? "", type: [...(p.types ?? [])][0] ?? null, raw: "" });

/** Non-empty values of the file, in the shape of a FeaturePlan (plus `quantity`). */
export function factsFromItem(item, parser) {
  if (parser) lib = parser;
  const facts = {};
  const system = item?.system ?? {};
  const acts = Array.isArray(system.activities) ? system.activities : Object.values(system.activities ?? {});
  const attack = acts.find(a => a.type === "attack" && (a.attack?.flat || !isEmpty(a.attack?.bonus)));
  if (attack) {
    facts.attack = {
      type: attack.attack?.type?.value || null,
      classification: attack.attack?.type?.classification || null,
      bonus: num(attack.attack?.bonus) ?? 0
    };
  }
  const dmg = (attack && !isEmpty(attack.damage?.parts) ? attack : null)
    ?? acts.find(a => (a.type === "attack" || a.type === "damage") && !isEmpty(a.damage?.parts));
  if (dmg) facts.damage = dmg.damage.parts.map(toPart);
  const save = acts.find(a => a.type === "save" && !isEmpty(a.save?.ability));
  if (save) {
    const formula = save.save?.dc?.formula;
    const dc = num(formula);
    facts.save = {
      ability: [...save.save.ability][0],
      dc,
      dcFormula: dc === null && !isEmpty(formula) ? String(formula) : null, // a DC that is a formula, like the library's
      onSave: save.damage?.onSave || "half",
      damage: (save.damage?.parts ?? []).map(toPart)
    };
  }
  if (item?.type === "weapon" && system.range) {
    const { reach, value, long } = system.range;
    if (num(reach) || num(value) || num(long)) facts.range = { reach: num(reach), value: num(value), long: num(long) };
  } else {
    const r = acts.find(a => !isEmpty(a.range?.value));
    if (r && (r.range.units === "ft" || r.range.units === undefined)) facts.range = { reach: num(r.range.value), value: null, long: null };
  }
  const rec = system.uses?.recovery?.[0];
  if (rec?.period === "recharge") facts.recharge = { min: num(rec.formula) ?? 0 };
  else if (!isEmpty(system.uses?.max) && num(system.uses.max)) {
    facts.uses = { max: num(system.uses.max), period: rec?.period ?? "day" };
  }
  const act = acts.find(a => !isEmpty(a.activation?.type));
  if (act) facts.activation = { type: act.activation.type, cost: num(act.activation.value) };
  if (!isEmpty(system.quantity) && item?.type !== "feat") facts.quantity = num(system.quantity);
  return facts;
}

/** File facts first, text facts where the file has nothing. The legendary cost of the text wins (v3). */
function mergeFacts(fileFacts, plan) {
  const out = { ...fileFacts };
  const take = k => {
    const v = plan?.[k];
    if (isEmpty(out[k]) && !isEmpty(v)) out[k] = v;
  };
  for (const k of ["attack", "damage", "save", "range", "uses", "recharge", "activation"]) take(k);
  if (plan?.activation?.type === "legendary" && plan.activation.cost) out.activation = plan.activation;
  if (plan?.legendaryResistance) { delete out.uses; delete out.recharge; }
  if (out.save && !out.save.dc && !out.save.dcFormula) delete out.save;
  return out;
}

// ---------------------------------------------------------------- activities (C3)

function activitiesOf(item) {
  const acts = item.system?.activities;
  return acts && !Array.isArray(acts) ? acts : null;
}

function fillActivity(act, gen, filled, base, { weapon, converted } = {}) {
  const g = clone(gen);
  delete g._id;
  delete g.type;
  if (!isEmpty(act.attack?.bonus) || act.attack?.flat === true) { delete g.attack?.bonus; delete g.attack?.flat; }
  const cal = act.save?.dc?.calculation;
  if (g.save && (!isEmpty(act.save?.dc?.formula) || !(isEmpty(cal) || cal === "initial"))) delete g.save.dc;
  if (!isEmpty(act.damage?.parts) || weapon) { delete g.damage?.parts; delete g.damage?.includeBase; }
  if (!converted && g.damage) delete g.damage.onSave;
  if (!isEmpty(act.range?.value) && g.range) delete g.range;
  else if (g.range && act.range?.units && act.range.units !== "self") delete g.range.units;
  if (!isEmpty(act.target?.template?.type) && g.target) delete g.target.template;
  filled.push(...merge(act, g, { path: base }));
  if (g.range?.value && act.range?.units === "self" && act.range.value === g.range.value) act.range.units = g.range.units ?? "ft";
}

function pickGenerated(generated, used, wanted) {
  const i = generated.findIndex((g, n) => !used.has(n) && wanted(g));
  if (i < 0) return null;
  used.add(i);
  return generated[i];
}

// ---------------------------------------------------------------- variants (B10)

/**
 * Indexes of the generated activities that come from `plan.variants` (conditional results, B9): `toActivities`
 * names each of them after its variant ("Gore (if the target is Bloodied)"), the main activities have no name.
 */
function variantIndexes(generated, plan) {
  const names = new Set((plan?.variants ?? []).map(v => lib.nameKey(v.name)).filter(Boolean));
  const out = new Set();
  generated.forEach((g, n) => { if (names.has(lib.nameKey(g.name))) out.add(n); });
  return out;
}

const partKey = p => JSON.stringify([p.number ?? null, p.denomination ?? null, String(p.bonus ?? ""), [...(p.types ?? [])].sort()]);
const partsKey = parts => (parts ?? []).map(partKey).sort().join("|");

/** An activity of the item already plays this variant: same name, same condition, or the same damage parts. */
function hasEquivalent(acts, variant, condition) {
  const name = lib.nameKey(variant.name);
  const cond = lib.nameKey(condition);
  const parts = partsKey(variant.damage?.parts);
  return Object.values(acts ?? {}).some(a => {
    if (isEmptyUtility(a)) return false;
    if (name && lib.nameKey(a.name) === name) return true;
    if (cond && lib.nameKey(a.activation?.condition) === cond) return true;
    return Boolean(parts) && partsKey(a.damage?.parts) === parts;
  });
}

/** Inserts `next` right after the activity `afterId` (at the end without it), keeping the order of the keys. */
function insertActivity(item, next, afterId) {
  const out = {};
  let placed = false;
  for (const [id, act] of Object.entries(activitiesOf(item) ?? {})) {
    out[id] = act;
    if (id === afterId) { out[next._id] = next; placed = true; }
  }
  if (!placed) out[next._id] = next;
  item.system.activities = out;
}

/**
 * The variant is the same attack (or save) as its origin, with other damage: it takes the item-uses consumption of
 * the origin (as `toActivities` does), and its attack bonus or save DC when the origin states one (the file wins, C3).
 */
function alignToOrigin(next, origin) {
  if (!origin) return;
  const own = (next.consumption?.targets ?? []).filter(t => t.type !== "itemUses");
  const uses = (origin.consumption?.targets ?? []).filter(t => t.type === "itemUses").map(clone);
  const targets = [...own, ...uses];
  if (targets.length) next.consumption = { ...(next.consumption ?? {}), targets };
  else delete next.consumption;
  if (next.attack && origin.attack?.flat && !isEmpty(origin.attack.bonus)) {
    next.attack = { ...next.attack, flat: true, bonus: String(origin.attack.bonus) };
  }
  const dc = origin.save?.dc;
  if (next.save && dc && isEmpty(dc.calculation) && !isEmpty(dc.formula)) next.save.dc = clone(dc);
}

/**
 * Adds the variants of the text as new activities, each after its origin (the activity of the item that plays the
 * main result of the same type), unless the item already has an equivalent one. Returns the added activities.
 * @param {object} item
 * @param {object[]} generated   result of `toActivities`
 * @param {Set<number>} variants indexes of the variants in `generated`
 * @param {(g: object) => string|undefined} originOf  id of the origin activity of a variant, in the item
 */
function addVariants(item, generated, variants, plan, ctx, originOf) {
  const added = [];
  for (const n of variants) {
    const g = generated[n];
    const variant = (plan.variants ?? []).find(v => lib.nameKey(v.name) === lib.nameKey(g.name));
    if (hasEquivalent(activitiesOf(item), g, variant?.condition)) continue;
    const originId = originOf(g);
    const next = clone(g);
    next._id = ctx.idGen();
    alignToOrigin(next, originId ? activitiesOf(item)?.[originId] : null);
    insertActivity(item, next, originId);
    added.push(next);
  }
  return added;
}

function applyActivities(item, generated, ctx, filled, plan) {
  const acts = () => activitiesOf(item) ?? (item.system.activities = {});
  const variants = variantIndexes(generated, plan);
  const used = new Set(variants); // a variant never fills an existing activity: it is added after its origin
  const placed = new Map(); // index in `generated` -> id of the activity of the item that holds it
  const weaponHasBase = item.type === "weapon" && !(isEmpty(item.system.damage?.base?.number) && isEmpty(item.system.damage?.base?.custom?.formula));
  const existing = Object.values(activitiesOf(item) ?? {});
  let converted = 0;
  for (const act of existing) {
    if (!isEmptyUtility(act)) continue;
    const g = pickGenerated(generated, used, x => FILLABLE.has(x.type));
    if (!g) continue;
    const next = clone(g);
    next._id = act._id;
    if (!isEmpty(act.activation)) next.activation = clone(act.activation);
    if (!isEmpty(act.name)) next.name = act.name;
    acts()[act._id ?? next._id] = next;
    placed.set(generated.indexOf(g), next._id);
    filled.push(...merge({}, g, { path: `system.activities.${next._id}` }));
    converted++;
  }
  for (const act of existing) {
    if (isEmptyUtility(act) || !FILLABLE.has(act.type)) continue;
    const g = pickGenerated(generated, used, x => x.type === act.type);
    if (!g) continue;
    placed.set(generated.indexOf(g), act._id);
    fillActivity(act, g, filled, `system.activities.${act._id}`, { weapon: weaponHasBase });
  }
  if (!existing.length || converted) {
    for (const g of generated) {
      const n = generated.indexOf(g);
      if (used.has(n) || !SPELL_ONLY.has(g.type)) continue;
      const next = clone(g);
      next._id = ctx.idGen();
      acts()[next._id] = next;
      used.add(n);
      placed.set(n, next._id);
      filled.push(...merge({}, next, { path: `system.activities.${next._id}` }));
    }
  }
  const originOf = g => placed.get(generated.findIndex((x, n) => !variants.has(n) && x.type === g.type));
  const added = addVariants(item, generated, variants, plan, ctx, originOf);
  // One entry per added activity (not its fields: they are described by the "activity added" line, not as fills)
  for (const next of added) filled.push({ path: `system.activities.${next._id}`, value: next });
  return added;
}

function describeFilled(plan, filled, parser) {
  if (!filled.length || typeof parser.describe !== "function") return [];
  const has = re => filled.some(f => re.test(f.path));
  const partial = {
    ...plan,
    attack: has(/\.attack\./) ? plan.attack : null,
    damage: has(/\.damage\.parts/) ? plan.damage : [],
    save: has(/\.save\./) ? plan.save : null,
    range: has(/range/) ? plan.range : null,
    target: has(/\.target\./) ? plan.target : null,
    template: has(/\.target\.template/) ? plan.template : null,
    uses: has(/system\.uses/) ? plan.uses : null,
    recharge: has(/system\.uses/) ? plan.recharge : null,
    activation: has(/\.activation\./) ? plan.activation : null,
    variants: [], // the added variants are reported by `activityAdded`, not described as activities of the plan
    effects: [] // the passive effect is reported by `addPassiveEffects` (C26)
  };
  try { return parser.describe(partial) ?? []; } catch { return []; }
}

const activityAdded = next => ({ key: `${KEY}ActivityAdded`, data: { name: next.name ?? "" } });

// ---------------------------------------------------------------- passive effects (C26, C27)

/** The effects of a plan for the report: one group per kind and value, with its scopes ("−3: bludgeoning, piercing"). */
function effectGroups(effects) {
  const groups = [];
  for (const e of effects) {
    const on = e.on ?? null;
    let g = groups.find(x => x.kind === e.kind && x.value === e.value && x.on === on);
    if (!g) { g = { kind: e.kind, value: e.value ?? null, on, scopes: [] }; groups.push(g); }
    if (e.scope && !g.scopes.includes(e.scope)) g.scopes.push(e.scope);
  }
  return groups;
}

/**
 * C26: a passive feature whose plan has effects receives the transferred ActiveEffect that `toEffects` builds
 * (one effect, `transfer: true`), whether the item comes from the text or from a compendium.
 * C27: a feature that already has an effect (file or compendium) is left alone: nothing is added nor doubled,
 * so a second import of the same file changes nothing.
 */
function addPassiveEffects(item, plan, ctx, entry) {
  const { parser } = ctx;
  if (!plan.effects?.length || typeof parser.toEffects !== "function") return;
  if (Array.isArray(item.effects) && item.effects.length) return;
  let effects;
  try { effects = parser.toEffects(plan, { keys: ctx.keys, idGen: ctx.idGen, name: item.name, img: item.img }) ?? []; } catch { return; }
  for (const n of effects.notes ?? []) entry.notes.push(n);
  const transferred = effects.filter(e => e.transfer);
  if (!transferred.length) return;
  item.effects = [...(item.effects ?? []), ...transferred];
  entry.changes.push({ key: `${KEY}EffectAdded`, data: { name: item.name, effects: effectGroups(plan.effects) } });
  entry.status = "enriched";
}

// ---------------------------------------------------------------- one item

function conditionFor(item) {
  return /résistance|rate un jet/i.test(`${item.name} ${item.system?.description?.value ?? ""}`)
    ? "rate un jet de sauvegarde" : "fails a saving throw";
}

function legendaryResistance(item, ctx, notes, filled) {
  const acts = activitiesOf(item) ?? (item.system.activities = {});
  if (!Object.keys(acts).length) {
    const id = ctx.idGen();
    acts[id] = { _id: id, type: "utility", name: "", activation: {}, consumption: { targets: [] } };
  }
  let replaced = false;
  for (const act of Object.values(acts)) {
    act.activation ??= {};
    if (act.activation.type === "legendary") {
      act.activation.type = "special";
      replaced = true;
    } else if (isEmpty(act.activation.type)) {
      act.activation.type = "special";
      filled.push({ path: `system.activities.${act._id}.activation.type`, value: "special" });
    }
    if (isEmpty(act.activation.condition)) act.activation.condition = conditionFor(item);
    if (isEmpty(act.consumption?.targets)) {
      act.consumption = { ...(act.consumption ?? {}), targets: [{ type: "attribute", target: "resources.legres.value", value: "1" }] };
    }
  }
  if (isEmpty(item.system.identifier)) item.system.identifier = "legendary-resistance";
  if (replaced) notes.push({ key: `${KEY}LegendaryResistanceReplaced`, data: {} });
}

function legendaryCost(item, plan, notes) {
  const cost = plan.activation?.cost;
  if (plan.activation?.type !== "legendary" || !cost) return;
  for (const act of Object.values(activitiesOf(item) ?? {})) {
    if (act.activation?.type !== "legendary") continue;
    const from = act.activation.value;
    if (!isEmpty(from) && Number(from) !== Number(cost)) {
      notes.push({ key: `${KEY}LegendaryCost`, data: { from: Number(from), to: cost } });
      act.activation.value = cost;
    }
  }
}

function enrichText(item, plan, ctx, entry) {
  const filled = [];
  const hadSystem = item.system !== undefined;
  const system = item.system ?? {};
  const generated = ctx.parser.toActivities(plan, { keys: ctx.keys, idGen: ctx.idGen, item }) ?? [];
  const patch = ctx.parser.toItemPatch(plan, { keys: ctx.keys, item }) ?? {};
  const lr = plan.legendaryResistance;
  const stripItemUses = () => {
    for (const g of generated) if (g.consumption?.targets) g.consumption.targets = g.consumption.targets.filter(t => t.type !== "itemUses");
  };
  if (lr || !isEmpty(system.uses?.max) || !isEmpty(system.uses?.recovery)) {
    // The item keeps its uses: the activities must not consume item uses that are not there.
    delete patch.uses;
    stripItemUses();
  } else if (isEmpty(patch.uses?.max)) {
    // No uses on the item (none in the file, none built from the text): nothing to consume.
    stripItemUses();
  }
  item.system ??= system;
  const added = lr ? [] : applyActivities(item, generated, ctx, filled, plan);
  filled.push(...merge(item.system, patch, { path: "system" }));
  if (lr) legendaryResistance(item, ctx, entry.notes, filled);
  else legendaryCost(item, plan, entry.notes);
  if (!hadSystem && !Object.keys(item.system).length) delete item.system; // "unchanged" stays strictly identical
  entry.changes = [...describeFilled(plan, filled, ctx.parser), ...added.map(activityAdded)];
  return filled;
}

function replaceFromCompendium(item, match, plan, ctx, entry) {
  const src = clone(match.data);
  src._id = item._id;
  src.name = item.name;
  if (item.sort !== undefined) src.sort = item.sort;
  src._stats = { ...(src._stats ?? {}), compendiumSource: match.uuid ?? src._stats?.compendiumSource };
  const facts = mergeFacts(factsFromItem(item, ctx.parser), plan);
  const { data, adjusted } = adjustToFacts(src, facts);
  const generated = ctx.parser.toActivities(plan, { keys: ctx.keys, idGen: ctx.idGen, item: data }) ?? [];
  const variants = variantIndexes(generated, plan);
  if (facts.attack && !Object.values(data.system?.activities ?? {}).some(a => a.type === "attack")) {
    const g = generated.find((a, n) => a.type === "attack" && !variants.has(n));
    if (g) {
      (data.system.activities ??= {})[g._id] = g;
      adjusted.push({ field: "attackActivity", from: null, to: String(facts.attack.bonus) });
    }
  }
  // Variants of the text (B10): added after the compendium activity of the same type, unless it already has one
  const originOf = g => Object.values(activitiesOf(data) ?? {}).find(a => a.type === g.type)?._id;
  const added = addVariants(data, generated, variants, plan, ctx, originOf);
  entry.changes.push(...added.map(activityAdded));
  const desc = data.system.description ??= {};
  desc.value = appendPdfNote(desc.value ?? "", item.system?.description?.value ?? "", ctx.pdfLabel ?? "PDF", { name: item.name });
  entry.origin = "compendium";
  entry.pack = match.packLabel;
  entry.uuid = match.uuid;
  entry.adjusted = adjusted;
  return data;
}

/** Returns an item entry for the report, or null when there is nothing to say. */
function enrichItem(item, ctx, { fromActor }) {
  const { parser } = ctx;
  const key = parser.nameKey(item.name);
  if (isMultiattackKey(key)) return { item, entry: null };
  const html = item.system?.description?.value ?? "";
  let plan;
  try { plan = parser.parseFeature(item.name, html, { keys: ctx.keys }); } catch { plan = null; }
  if (!plan || plan.skip) return { item, entry: null };

  const entry = { name: item.name, origin: "text", changes: [], adjusted: [], notes: [], status: "unchanged" };
  const searched = fromActor && ctx.useCompendiums;
  const match = searched ? ctx.matches?.get?.(`${item.type}|${key}`) : null;
  if (match?.status === "ambiguous") {
    entry.origin = "ambiguous";
    entry.pack = match.packLabel;
  }
  if (searched && !match) entry.notFound = true; // looked up in the compendiums, built from the text (C21, C23)
  let result;
  if (match && match.status !== "ambiguous" && match.data) {
    result = replaceFromCompendium(item, match, plan, ctx, entry);
    if (plan.legendaryResistance) legendaryResistance(result, ctx, entry.notes, []);
    entry.status = "enriched";
  } else {
    result = clone(item);
    const filled = enrichText(result, plan, ctx, entry);
    entry.status = filled.length ? "enriched" : "unchanged";
  }
  addPassiveEffects(result, plan, ctx, entry);
  for (const n of plan.notes ?? []) entry.notes.push(n);
  for (const n of plan.ambiguous ?? []) entry.notes.push(n);

  if (entry.status === "unchanged") {
    const acts = Object.values(activitiesOf(result) ?? {});
    if (acts.some(isEmptyUtility)) entry.status = "notEnriched";
    else if (!entry.notes.length && entry.origin === "text" && !entry.notFound) return { item: result, entry: null };
  }
  return { item: result, entry };
}

// ---------------------------------------------------------------- actor level

const TRAITS = ["dr", "di", "dv", "ci"];
const splitCustom = text => String(text ?? "").split(";").map(t => t.trim()).filter(Boolean);

/**
 * The trait patch of toActorPatch is a union with the traits of the actor (arrays complete, `custom` a string):
 * it is applied as it is, not with the "empty fields" merge. Returns the descriptors of what was added.
 */
function applyTraits(system, patch, changes) {
  for (const t of TRAITS) {
    const p = patch?.[t];
    if (!p) continue;
    const target = (system.traits ??= {})[t] ??= {};
    const added = { values: [], bypasses: [], custom: [] };
    for (const [field, bucket] of [["value", "values"], ["bypasses", "bypasses"]]) {
      if (!Array.isArray(p[field])) continue;
      const before = new Set(target[field] ?? []);
      added[bucket] = p[field].filter(v => !before.has(v));
      target[field] = [...p[field]];
    }
    if (typeof p.custom === "string") {
      const before = splitCustom(target.custom).map(c => c.toLowerCase());
      added.custom = splitCustom(p.custom).filter(c => !before.includes(c.toLowerCase()));
      target.custom = p.custom;
    }
    if (added.values.length || added.bypasses.length || added.custom.length) {
      changes.push({ key: `${KEY}Trait`, data: { trait: t, ...added } });
    }
  }
}

function modeProps(list) {
  switch (list.mode) {
    case "atwill": return { method: "atwill", prepared: 1 };
    case "innate": {
      const props = { method: "innate", prepared: 1 };
      if (list.uses) props.uses = { max: String(list.uses), recovery: [{ period: "day", type: "recoverAll" }] };
      return props;
    }
    case "cantrip": return { method: "spell", prepared: 1, level: 0 };
    default: return { method: "spell", prepared: 1, level: list.level ?? undefined };
  }
}

/**
 * DC and attack bonus of the spellcasting trait, on the activities of a spell taken from a compendium.
 * The compendium spells leave the attack `classification` empty: an attack of a spell is a spell attack
 * unless the classification says otherwise (weapon, unarmed).
 */
function applyCastingFacts(spell, casting) {
  for (const act of Object.values(spell.system?.activities ?? {})) {
    if (act.type === "save" && casting.dc) act.save = { ...(act.save ?? {}), dc: { calculation: "", formula: String(casting.dc) } };
    const classification = act.attack?.type?.classification;
    const spellAttack = act.type === "attack" && (isEmpty(classification) || classification === "spell");
    if (spellAttack && casting.attack !== null && casting.attack !== undefined) {
      act.attack = { ...act.attack, flat: true, bonus: String(casting.attack) };
    }
  }
}

function addSpells(data, actorPlan, ctx, report, summary) {
  let first = true;
  const have = new Set((data.items ?? []).filter(i => i.type === "spell").map(i => ctx.parser.nameKey(i.name)));
  for (const casting of actorPlan?.spellcasting ?? []) {
    const stubs = new Map((ctx.parser.toSpellStubs(casting) ?? []).map(s => [ctx.parser.nameKey(s.name), s]));
    for (const list of casting.lists ?? []) {
      const props = modeProps(list);
      for (const name of list.spells ?? []) {
        const key = ctx.parser.nameKey(name);
        if (!key || have.has(key)) continue;
        have.add(key);
        const match = ctx.useCompendiums ? ctx.matches?.get?.(`spell|${key}`) : null;
        const entry = { name, origin: "notFound", changes: [], adjusted: [], notes: [], status: "enriched" };
        let spell;
        if (match?.status === "found" && match.data) {
          spell = clone(match.data);
          spell._stats = { ...(spell._stats ?? {}), compendiumSource: match.uuid ?? spell._stats?.compendiumSource };
          spell.system ??= {};
          const mode = { ...props };
          delete mode.level; // a compendium spell keeps its own level
          Object.assign(spell.system, mode);
          applyCastingFacts(spell, casting);
          entry.origin = "compendium";
          entry.pack = match.packLabel;
          entry.uuid = match.uuid;
          entry.adjusted.push({ field: "method", from: null, to: props.method });
        } else {
          spell = clone(stubs.get(key) ?? { name, type: "spell", system: {} });
          spell.type = "spell";
          spell.name = spell.name || name;
          spell.system ??= {};
          merge(spell.system, props, { path: "system" });
          if (props.level === undefined) entry.notes.push({ key: `${KEY}SpellLevelUnknown`, data: { name } });
          if (match?.status === "ambiguous") { entry.origin = "ambiguous"; entry.pack = match.packLabel; }
        }
        spell._id = ctx.idGen();
        (data.items ??= []).push(spell);
        report.items.push(entry);
      }
    }
    if (casting.dc || (casting.attack ?? null) !== null || (first && summary.length)) {
      report.changes.push({ key: `${KEY}Spellcasting`, data: { ability: casting.ability, dc: casting.dc, attack: casting.attack, level: casting.casterLevel } });
    }
    first = false;
  }
}

const SLOT_LEVELS = [1, 2, 3, 4, 5, 6, 7, 8, 9];
const ZERO_IS_EMPTY = [
  "system.resources.legact.max", "system.resources.legres.max", "system.attributes.spell.level",
  ...SLOT_LEVELS.flatMap(n => [`system.spells.spell${n}.value`, `system.spells.spell${n}.override`])
];

function enrichActorData(data, original, ctx, report) {
  const { parser } = ctx;
  let plan;
  if (ctx.plans?.has?.(ctx.source)) plan = ctx.plans.get(ctx.source); // parsed once by collectLookups
  else {
    try { plan = parser.parseActor(original, { keys: ctx.keys }); } catch { plan = null; }
  }
  if (!plan) return;
  const { system: patch = {}, notes = [] } = parser.toActorPatch(plan, { keys: ctx.keys, actor: data }) ?? {};
  const { traits, ...rest } = patch;
  const system = data.system ?? {};
  const filled = merge(system, rest, { path: "system", zeroIsEmpty: ZERO_IS_EMPTY });
  const traitChanges = [];
  if (traits) applyTraits(system, traits, traitChanges);
  if (filled.length || traitChanges.length) data.system = system;
  for (const f of filled) {
    if (f.path === "system.resources.legact.max") report.changes.push({ key: `${KEY}Legact`, data: { value: f.value } });
    if (f.path === "system.resources.legres.max") report.changes.push({ key: `${KEY}Legres`, data: { value: f.value } });
    const slot = /^system\.spells\.spell(\d)\.override$/.exec(f.path);
    if (slot) report.changes.push({ key: `${KEY}Slots`, data: { level: Number(slot[1]), slots: f.value } });
  }
  report.changes.push(...traitChanges);
  if (notes.length) (report.notes ??= []).push(...notes);
  const summary = filled.filter(f => /^system\.attributes\.(spellcasting|spell\.level)$/.test(f.path));
  addSpells(data, plan, ctx, report, summary);
}

/**
 * C25: an NPC without a challenge rating takes the one stated in its texts ("Challenge 17 (18,000 XP)",
 * "Facteur de puissance 17"). Only an empty field is filled (C3); the system defaults a missing `cr` to 1.
 */
function fillChallengeRating(data, report) {
  if (data.type !== "npc") return;
  const current = data.system?.details?.cr;
  if (current !== undefined && current !== null && current !== "") return;
  const value = challengeRatingOf(data);
  if (value === null) return;
  ((data.system ??= {}).details ??= {}).cr = value;
  report.changes.push({ key: `${KEY}Cr`, data: { value: formatChallengeRating(value) } });
}

// ---------------------------------------------------------------- entry point

/**
 * Enriches a raw document (after `normalizeEntry`, before the conformity check). The input is not modified.
 * @param {object} data raw document
 * @param {"Item"|"Actor"} documentName
 * @param {object} ctx
 * @param {object} ctx.parser dnd5e-text-parser API v1
 * @param {object} ctx.keys result of `parser.keysFromConfig(CONFIG.DND5E)`
 * @param {Map<string, object>} [ctx.matches] "type|key" -> { status: "found"|"ambiguous", data, uuid, packLabel }
 * @param {WeakMap<object, object>} [ctx.plans] raw entry -> ActorPlan already parsed (see `collectLookups`)
 * @param {object} [ctx.source] the raw entry `data` comes from (key of `ctx.plans`)
 * @param {() => string} ctx.idGen
 * @param {string} [ctx.pdfLabel]
 * @param {boolean} [ctx.useCompendiums]
 * @returns {{ data: object, report: object }}
 */
export function enrichEntry(data, documentName, ctx) {
  const report = { status: "unchanged", changes: [], items: [] };
  if (documentName !== "Item" && documentName !== "Actor") return { data, report };
  lib = ctx.parser;
  const out = clone(data);
  const c = { ...ctx, useCompendiums: ctx.useCompendiums === true };
  const record = entry => { if (entry) report.items.push(entry); };

  if (documentName === "Item") {
    const { item, entry } = enrichItem(out, c, { fromActor: false });
    record(entry);
    return { data: item, report: finish(report) };
  }
  const items = [];
  for (const it of out.items ?? []) {
    const { item, entry } = enrichItem(it, c, { fromActor: true });
    items.push(item);
    record(entry);
  }
  if (Array.isArray(out.items)) out.items = items;
  fillChallengeRating(out, report);
  enrichActorData(out, data, c, report);
  return { data: out, report: finish(report) };
}

function finish(report) {
  const enriched = report.changes.length || report.items.some(i => i.status === "enriched");
  report.status = enriched ? "enriched" : report.items.some(i => i.status === "notEnriched") ? "notEnriched" : "unchanged";
  return report;
}
