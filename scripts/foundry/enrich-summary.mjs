import { MODULE_ID } from "../constants.mjs";

/** Descriptor fields whose values are dnd5e keys, with the CONFIG.DND5E table that names them. */
const LABELS = {
  damageType: "damageTypes",
  ability: "abilities",
  condition: "conditionTypes",
  template: "areaTargetTypes",
  activation: "activityActivationTypes"
};

function configLabel(table, value) {
  const entry = CONFIG.DND5E?.[table]?.[value];
  const label = entry?.label ?? entry;
  return (typeof label === "string") ? game.i18n.localize(label) : value;
}

/** Turn a `{ key, data }` descriptor (from the parser or from the importer) into a sentence. */
function text({ key, data = {} }) {
  const values = {};
  for ( const [field, value] of Object.entries(data) ) {
    const table = LABELS[field];
    values[field] = table && (typeof value === "string") ? configLabel(table, value) : value;
  }
  for ( const candidate of [key, `${MODULE_ID}.${key}`] ) {
    if ( game.i18n.has(candidate) ) return game.i18n.format(candidate, values);
  }
  return `${key} ${JSON.stringify(data)}`;
}

/**
 * Localized view of the report of one document (C14, C23).
 * @param {{changes: object[], items: object[], reasons?: object[]}} report
 * @returns {{lines: string[], compendium: object[], notFound: string[], ambiguous: string[], reasons: string[]}}
 */
export function describeReport(report) {
  const view = { lines: (report.changes ?? []).map(text), compendium: [], notFound: [], ambiguous: [], reasons: [] };
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
