import { MODULE_ID } from "../constants.mjs";

const LIBRARY = "dnd5e-text-parser";
const KEY = `${MODULE_ID}.Enrich.`;

/**
 * Fields of a descriptor whose values are dnd5e keys, with the CONFIG.DND5E table that names them, per descriptor.
 * Descriptors are `{ key, data, group, raw, origin, paths }` (parser.describe) or `{ key, data }` (importer).
 */
const LABELS = {
  [`${LIBRARY}.Describe.Damage`]: { type: "damageTypes" },
  [`${LIBRARY}.Describe.ExtraDamage`]: { type: "damageTypes" },
  [`${LIBRARY}.Describe.Heal`]: { type: "damageTypes" },
  [`${LIBRARY}.Describe.Save`]: { ability: "abilities" },
  [`${LIBRARY}.Describe.Activation`]: { type: "activityActivationTypes" },
  [`${LIBRARY}.Describe.Template`]: { type: "areaTargetTypes" },
  [`${LIBRARY}.Describe.Target`]: { type: "individualTargetTypes" },
  [`${LIBRARY}.Describe.Rarity`]: { rarity: "itemRarity" },
  [`${KEY}Spellcasting`]: { ability: "abilities" }
};

function configLabel(table, value) {
  const entry = CONFIG.DND5E?.[table]?.[value];
  const label = entry?.label ?? entry?.labels?.title ?? entry;
  return (typeof label === "string") ? game.i18n.localize(label) : value;
}

/** Trait changes of the importer: the trait itself (CONFIG.DND5E.traits), damage types, or conditions for "ci". */
function labelsFor({ key, data }) {
  if ( key === `${KEY}Trait` ) {
    const table = data?.trait === "ci" ? "conditionTypes" : "damageTypes";
    return { trait: "traits", values: table, bypasses: "itemProperties" };
  }
  return LABELS[key] ?? {};
}

function localizeValue(table, value) {
  if ( value === null || value === undefined ) return "";
  if ( Array.isArray(value) ) return value.map(v => localizeValue(table, v)).join(", ");
  return table && (typeof value === "string") ? configLabel(table, value) : value;
}

const tidy = line => line.replace(/\s{2,}/g, " ").trim();

// ---------------------------------------------------------------- passive effects (C26)

/** CONFIG.DND5E tables that may name the scope of a plan effect, per kind (abilities and skills share no key). */
const SCOPE_TABLES = {
  resistance: ["damageTypes"], vulnerability: ["damageTypes"], damageReduction: ["damageTypes"],
  immunity: ["damageTypes", "conditionTypes"], sense: ["senses"], speed: ["movementTypes"],
  save: ["abilities"], check: ["abilities", "skills"], abilityScore: ["abilities"],
  advantage: ["abilities", "skills"], disadvantage: ["abilities", "skills"]
};
const SIGNED = new Set(["ac", "attack", "damage", "save", "check"]);

function scopeLabel(kind, scope) {
  for ( const table of SCOPE_TABLES[kind] ?? [] ) {
    if ( CONFIG.DND5E?.[table]?.[scope] !== undefined ) return configLabel(table, scope);
  }
  return scope === "all" ? game.i18n.localize(`${KEY}Effect.All`) : scope;
}

/** One group `{ kind, value, scopes }` of an added effect -> "damage reduction −3: bludgeoning, piercing". */
function effectText({ kind, value, scopes }) {
  const key = `${KEY}Effect.${kind}`;
  const shown = SIGNED.has(kind) && (typeof value === "number") && (value > 0) ? `+${value}` : (value ?? "");
  const data = { value: shown, scopes: (scopes ?? []).map(s => scopeLabel(kind, s)).join(", ") };
  return tidy(game.i18n.has(key) ? game.i18n.format(key, data) : `${kind} ${data.value} ${data.scopes}`);
}

const NOT_AUTOMATED = `${LIBRARY}.Note.NotAutomated`;

/** Turn a descriptor (from the parser or from the importer) into a sentence. */
function text(descriptor) {
  const { key, data = {} } = descriptor;
  if ( key === `${KEY}EffectAdded` ) {
    return tidy(game.i18n.format(key, { name: data.name ?? "", details: (data.effects ?? []).map(effectText).join("; ") }));
  }
  const tables = labelsFor(descriptor);
  const values = {};
  for ( const [field, value] of Object.entries(data) ) values[field] = localizeValue(tables[field], value);
  for ( const candidate of [key, `${MODULE_ID}.${key}`] ) {
    if ( game.i18n.has(candidate) ) {
      const line = tidy(game.i18n.format(candidate, values));
      const proposed = (descriptor.origin === "fallback") || (data.origin === "fallback");
      return proposed ? `${line} (${game.i18n.localize(`${LIBRARY}.Describe.Fallback`)})` : line;
    }
  }
  return `${key} ${JSON.stringify(data)}`;
}

// ---------------------------------------------------------------- adjustments (C20)

/** "1d6+2 fire + 1d4 cold" with the damage types named. */
function damageText(value) {
  return String(value).split(" + ").map(part => part.replace(/\s(\S+)$/, (m, type) => ` ${configLabel("damageTypes", type)}`)).join(" + ");
}

/** "legendary 2" -> "2 Legendary Action". */
function activationText(value) {
  const [type, cost] = String(value).split(/\s+/);
  const label = configLabel("activityActivationTypes", type);
  return cost ? `${cost} ${label}` : label;
}

/** { max, period, formula } -> "Recharge 5–6" or "3/Day". */
function usesText(value) {
  if ( typeof value !== "object" ) return String(value);
  if ( value.period === "recharge" ) {
    const formula = value.formula || "";
    const range = /^[1-5]$/.test(formula) ? `${formula}–6` : formula;
    return tidy(`${game.i18n.localize("DND5E.Recharge")} ${range}`);
  }
  const period = value.period ? configLabel("limitedUsePeriods", value.period) : "";
  return period ? `${value.max}/${period}` : String(value.max);
}

function adjustedValue(field, value) {
  if ( value === null || value === undefined || value === "" ) return game.i18n.localize(`${KEY}Empty`);
  switch ( field ) {
    case "uses": return usesText(value);
    case "activation": return activationText(value);
    case "saveAbility": return localizeValue("abilities", String(value).split(","));
    case "damage": case "saveDamage": return damageText(value);
    case "range": case "range.reach": case "range.value": case "range.long":
      return game.i18n.format(`${KEY}Feet`, { value });
    case "method": return configLabel("spellcasting", String(value));
    default: return String(value);
  }
}

/** One adjustment `{ field, from, to }` -> "Attack bonus: (empty) → +7". */
function adjustedText({ field, from, to }) {
  const id = String(field).replace(/\.(\w)/g, (m, c) => c.toUpperCase());
  const labelKey = `${KEY}Field.${id}`;
  const label = game.i18n.has(labelKey) ? game.i18n.localize(labelKey) : field;
  return game.i18n.format(`${KEY}Adjusted`, { field: label, from: adjustedValue(field, from), to: adjustedValue(field, to) });
}

/**
 * Localized view of the report of one document (C14, C23). The `Note.NotAutomated` remarks of the parser (C26:
 * what dnd5e cannot apply without inventing it) go to their own list, as the sentence of the text, prefixed by the
 * name of the feature.
 * @param {{changes: object[], notes?: object[], items: object[], reasons?: object[]}} report
 * @returns {{lines: string[], compendium: object[], notFound: string[], ambiguous: string[], reasons: string[], notAutomated: string[]}}
 */
export function describeReport(report) {
  const view = { lines: [], compendium: [], notFound: [], ambiguous: [], reasons: [], notAutomated: [] };
  const prefixed = (name, line) => (name ? `${name} : ${line}` : line);
  /** Sentences of the descriptors, the "not automated" ones apart; `prefix` names the item on its sentences. */
  const collect = (descriptors, name, { prefix = true } = {}) => {
    const lines = [];
    for ( const d of descriptors ) {
      if ( d.key === NOT_AUTOMATED ) view.notAutomated.push(prefixed(name, String(d.data?.raw ?? "")));
      else lines.push(prefixed(prefix ? name : "", text(d)));
    }
    return lines;
  };
  view.lines.push(...collect([...report.changes ?? [], ...report.notes ?? []], ""));
  for ( const item of report.items ?? [] ) {
    const descriptors = [...item.changes ?? [], ...item.notes ?? []];
    if ( item.origin === "compendium" ) {
      view.compendium.push({
        name: item.name,
        pack: item.pack,
        uuid: item.uuid,
        adjusted: (item.adjusted ?? []).map(adjustedText),
        lines: collect(descriptors, item.name, { prefix: false }) // the block already shows the name
      });
      continue;
    }
    if ( (item.origin === "notFound") || item.notFound ) view.notFound.push(item.name);
    if ( item.origin === "ambiguous" ) view.ambiguous.push(item.name);
    view.lines.push(...collect(descriptors, item.name));
  }
  view.reasons = (report.reasons ?? []).map(text);
  return view;
}
