/**
 * A stat block read from the layout and its parsed stat lines to a dnd5e 6 NPC source with its items. The exact
 * text of every trait and action goes into the description, in the format the enrichment reads
 * (`<small>Action</small><br/><strong>Name (meta).</strong> text`); activities and effects are left to it.
 */
import { LEXICON, fold } from "./lexicon.mjs";
import { stableId } from "./stable-id.mjs";

const MODULE_ID = "compendium-json-importer";
const ACTOR_IMG = "icons/svg/mystery-man.svg";
const TRAIT_KINDS = ["dr", "di", "dv", "ci"];
const SECTIONS = ["actions", "bonus", "reactions", "legendary"];

const escapeHtml = text => String(text ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** "Name" or "Name (meta)". */
const entryTitle = entry => (entry.meta ? `${entry.name} (${entry.meta})` : entry.name);

/**
 * Description of a trait: `<p><strong>Name (meta).</strong> text</p>`; of an action, with the section header the
 * text parser reads as the activation: `<p><small>Bonus Action</small><br/><strong>Name.</strong> text</p>`.
 * @param {{name: string, meta: string, text: string}} entry
 * @param {string|null} sectionLabel  English label of the section (`LEXICON.sectionLabelsEn`), null for a trait.
 * @returns {string}
 */
export function entryDescription(entry, sectionLabel = null) {
  const head = `<strong>${escapeHtml(entryTitle(entry))}.</strong> ${escapeHtml(entry.text)}`;
  return sectionLabel ? `<p><small>${sectionLabel}</small><br/>${head}</p>` : `<p>${head}</p>`;
}

/**
 * Biography-like text of the trait lines, with English labels (the text parser knows English labels with French
 * values, not every French label). "Immunities" (2024) keeps its merged form.
 * @param {{kind: string, label: string, text: string}[]} traitLines
 * @returns {string}
 */
export function traitLinesText(traitLines) {
  return (traitLines ?? []).map(({ kind, label, text }) => {
    const short = ["di", "immunities"].includes(kind) && /^immunit/iu.test(fold(label)) && !/(dégâts|damage|état|condition)/iu.test(fold(label));
    const english = short ? LEXICON.immunitiesEn : LEXICON.traitLabelsEn[kind];
    return `${english} ${text}`;
  }).join("\n");
}

/**
 * dr/di/dv/ci of the actor, read by the text parser from the trait lines.
 * @param {{kind: string, label: string, text: string}[]} traitLines
 * @param {object} parser  dnd5e-text-parser API (`parseActor`).
 * @returns {Record<string, {value: string[], bypasses: string[], custom: string}>}
 */
export function parseTraits(traitLines, parser) {
  const out = {};
  const text = traitLinesText(traitLines);
  if ( !text || !parser?.parseActor ) return out;
  const html = `<p>${text.split("\n").map(escapeHtml).join("<br>")}</p>`;
  const plan = parser.parseActor({ system: { details: { biography: { value: html } } }, items: [] });
  const present = new Set(traitLines.map(t => t.kind));
  const hasImmunities = traitLines.some(t => t.kind === "di");
  for ( const kind of TRAIT_KINDS ) {
    const trait = plan?.traits?.[kind];
    if ( !trait ) continue;
    const stated = present.has(kind) || (kind === "ci" && hasImmunities);
    if ( !stated && !trait.values.length && !trait.custom.length ) continue;
    out[kind] = { value: [...trait.values], bypasses: [...trait.bypasses], custom: trait.custom.join("; ") };
  }
  return out;
}

/**
 * Item source of an entry: a natural weapon when the text parser reads an attack, else a monster feature.
 * @param {{name: string, meta: string, text: string}} entry
 * @param {string} section  features | actions | bonus | reactions | legendary
 * @param {{parser: object, seed: string, rank: number}} ctx
 * @returns {object}
 */
export function toEntryItem(entry, section, { parser, seed, rank }) {
  const sectionLabel = LEXICON.sectionLabelsEn[section] ?? null;
  const description = entryDescription(entry, sectionLabel);
  const attack = sectionLabel && parser?.parseFeature ? parser.parseFeature(entry.name, description)?.attack : null;
  const weapon = !!attack;
  return {
    _id: stableId(`${seed}|item|${entry.name}|${rank}`),
    name: entry.name,
    type: weapon ? "weapon" : "feat",
    img: weapon ? "icons/svg/sword.svg" : "icons/svg/book.svg",
    system: {
      description: { value: description },
      type: weapon ? { value: "natural", baseItem: "" } : { value: "monster", subtype: "" }
    }
  };
}

/**
 * Actor source of a block.
 * @param {object} block  Result of `readStatBlock`.
 * @param {object} stats  Result of `parseStatLines`.
 * @param {object} ctx  `{ parser, source, page, readBy, size, sizeLine }`: `size` is the parsed size line
 *   (`parseSizeLine`), `source` the file name, `readBy` "rules" or "ai".
 * @returns {object}
 */
export function toActorSource(block, stats, { parser, source = "", page = block.page, readBy = "rules", size = null } = {}) {
  const seed = `${source}|${page}|${block.title}`;
  const system = { abilities: {}, attributes: {}, details: {}, skills: {}, traits: {} };

  for ( const [key, value] of Object.entries(stats.abilities ?? {}) ) {
    system.abilities[key] = { value };
  }
  for ( const key of Object.keys(stats.saves ?? {}) ) {
    system.abilities[key] = { ...(system.abilities[key] ?? {}), proficient: 1 };
  }
  if ( stats.ac ) {
    // dnd5e 6: "natural" computes @attributes.ac.flat; any other printed AC is an override (attributes.mjs:41-59, 346)
    system.attributes.ac = stats.ac.natural ? { flat: stats.ac.value, calcs: ["natural"] } : { override: stats.ac.value };
  }
  if ( stats.hp ) system.attributes.hp = { value: stats.hp.value, max: stats.hp.value, formula: stats.hp.formula ?? "" };
  if ( stats.speed ) {
    const speeds = Object.fromEntries(Object.entries(stats.speed.speeds).map(([k, v]) => [k, String(v)]));
    system.attributes.movement = { speeds, units: "ft", hover: !!stats.speed.hover };
  }
  if ( stats.senses ) system.attributes.senses = { ranges: { ...stats.senses.ranges }, units: "ft", special: stats.senses.special ?? "" };
  if ( stats.initiative?.bonus !== undefined && stats.initiative?.bonus !== null ) {
    system.attributes.init = { bonus: String(stats.initiative.bonus) };
  }
  for ( const [key, level] of Object.entries(stats.skills ?? {}) ) {
    system.skills[key] = { value: level, ability: LEXICON.skillAbilities[key] };
  }
  if ( stats.cr !== null && stats.cr !== undefined ) system.details.cr = stats.cr;
  if ( size ) {
    system.traits.size = size.size;
    system.details.type = { value: size.type, subtype: size.subtype ?? "", swarm: size.swarm ?? "", custom: "" };
    if ( size.alignment ) system.details.alignment = size.alignment;
  }
  Object.assign(system.traits, parseTraits(stats.traitLines ?? [], parser));
  if ( stats.languages ) {
    const languages = { value: [...stats.languages.value], custom: stats.languages.custom ?? "" };
    if ( stats.languages.communication?.telepathy ) languages.communication = { telepathy: { ...stats.languages.communication.telepathy } };
    system.traits.languages = languages;
  }

  const items = [];
  let rank = 0;
  for ( const entry of block.features ?? [] ) items.push(toEntryItem(entry, "features", { parser, seed, rank: rank++ }));
  for ( const section of SECTIONS ) {
    for ( const entry of block[section] ?? [] ) items.push(toEntryItem(entry, section, { parser, seed, rank: rank++ }));
  }

  const pdf = { source, page, readBy };
  if ( stats.xp !== null && stats.xp !== undefined ) pdf.xp = stats.xp;
  if ( stats.prof !== null && stats.prof !== undefined ) pdf.proficiencyBonus = stats.prof;
  return {
    _id: stableId(`${seed}|actor`),
    name: block.title,
    type: "npc",
    img: ACTOR_IMG,
    system,
    items,
    flags: { [MODULE_ID]: { pdf } }
  };
}
