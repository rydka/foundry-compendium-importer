import { MODULE_ID } from "../constants.mjs";

const LIBRARY = "dnd5e-text-parser";

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
  [`${LIBRARY}.Describe.Rarity`]: { rarity: "itemRarity" }
};

function configLabel(table, value) {
  const entry = CONFIG.DND5E?.[table]?.[value];
  const label = entry?.label ?? entry;
  return (typeof label === "string") ? game.i18n.localize(label) : value;
}

/** Trait changes of the importer: the values are damage types, or conditions for "ci". */
function labelsFor({ key, data }) {
  if ( key === `${MODULE_ID}.Enrich.Trait` ) {
    const table = data?.trait === "ci" ? "conditionTypes" : "damageTypes";
    return { values: table, bypasses: "itemProperties" };
  }
  return LABELS[key] ?? {};
}

function localizeValue(table, value) {
  if ( value === null || value === undefined ) return "";
  if ( Array.isArray(value) ) return value.map(v => localizeValue(table, v)).join(", ");
  return table && (typeof value === "string") ? configLabel(table, value) : value;
}

/** Turn a descriptor (from the parser or from the importer) into a sentence. */
function text(descriptor) {
  const { key, data = {} } = descriptor;
  const tables = labelsFor(descriptor);
  const values = {};
  for ( const [field, value] of Object.entries(data) ) values[field] = localizeValue(tables[field], value);
  for ( const candidate of [key, `${MODULE_ID}.${key}`] ) {
    if ( game.i18n.has(candidate) ) {
      const line = game.i18n.format(candidate, values);
      const proposed = (descriptor.origin === "fallback") || (data.origin === "fallback");
      return proposed ? `${line} (${game.i18n.localize(`${LIBRARY}.Describe.Fallback`)})` : line;
    }
  }
  return `${key} ${JSON.stringify(data)}`;
}

/**
 * Localized view of the report of one document (C14, C23).
 * @param {{changes: object[], notes?: object[], items: object[], reasons?: object[]}} report
 * @returns {{lines: string[], compendium: object[], notFound: string[], ambiguous: string[], reasons: string[]}}
 */
export function describeReport(report) {
  const view = { lines: [...report.changes ?? [], ...report.notes ?? []].map(text), compendium: [], notFound: [], ambiguous: [], reasons: [] };
  for ( const item of report.items ?? [] ) {
    if ( item.origin === "compendium" ) {
      view.compendium.push({
        name: item.name,
        pack: item.pack,
        uuid: item.uuid,
        adjusted: (item.adjusted ?? []).map(a => game.i18n.format(`${MODULE_ID}.Enrich.Adjusted`, a)),
        lines: [...item.changes ?? [], ...item.notes ?? []].map(text)
      });
      continue;
    }
    if ( item.origin === "notFound" ) view.notFound.push(item.name);
    if ( item.origin === "ambiguous" ) view.ambiguous.push(item.name);
    view.lines.push(...[...item.changes ?? [], ...item.notes ?? []].map(d => `${item.name} : ${text(d)}`));
  }
  view.reasons = (report.reasons ?? []).map(text);
  return view;
}
