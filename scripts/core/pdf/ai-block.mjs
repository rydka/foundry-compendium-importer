/**
 * Local AI for a stat block the rules could not read (C5): the request (lines of the block, JSON schema as the
 * `format` of Ollama) and the validation of the answer. Every value must be in the text of the block; the text of
 * each capacity is cut from the source, never taken from the answer.
 */
import { labelOf, sectionOf } from "./lexicon.mjs";

const MOVEMENT = ["walk", "fly", "swim", "climb", "burrow"];
const SENSES = ["darkvision", "blindsight", "tremorsense", "truesight"];
const ABILITIES = ["str", "dex", "con", "int", "wis", "cha"];
const SECTIONS = ["trait", "action", "bonus", "reaction", "legendary"];
const SECTION_KEYS = { trait: "features", action: "actions", bonus: "bonus", reaction: "reactions", legendary: "legendary" };

const integer = { type: "integer" };
const objectOf = keys => ({ type: "object", properties: Object.fromEntries(keys.map(k => [k, integer])) });

/** JSON schema of the answer (Ollama `format`). */
export const BLOCK_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    name: { type: "string" },
    ac: integer,
    hp: integer,
    hpFormula: { type: "string" },
    speed: objectOf(MOVEMENT),
    abilities: objectOf(ABILITIES),
    senses: objectOf(SENSES),
    cr: { type: "number" },
    entries: {
      type: "array",
      items: {
        type: "object",
        properties: { name: { type: "string" }, section: { type: "string", enum: SECTIONS } },
        required: ["name", "section"]
      }
    }
  },
  required: ["name", "ac", "hp", "hpFormula", "speed", "abilities", "cr", "entries"]
});

const PROMPT = [
  "You read a Dungeons & Dragons 5e stat block. Answer only with JSON that follows the schema.",
  "Copy the numbers exactly as printed. hpFormula is the dice formula in parentheses after the hit points.",
  "speed: feet per movement mode, 0 when absent. abilities: the six scores (not the modifiers). senses: feet, 0 when absent.",
  "cr: the challenge rating as a number (1/2 is 0.5). entries: every trait, action, bonus action, reaction and legendary",
  "action, in order, with its exact printed name and its section (trait, action, bonus, reaction or legendary).",
  "Do not invent anything that is not in the text."
].join(" ");

/**
 * Chat request for a block.
 * @param {string[]} lines  Lines of the block region, in reading order.
 * @param {{model: string}} opts
 * @returns {object}  Body of `/api/chat`.
 */
export function buildBlockRequest(lines, { model } = {}) {
  return {
    model,
    stream: false,
    format: BLOCK_SCHEMA,
    options: { temperature: 0, seed: 0 },
    messages: [
      { role: "system", content: PROMPT },
      { role: "user", content: lines.join("\n") }
    ]
  };
}

const normalize = value => String(value ?? "").replace(/\s+/g, " ").trim();
const fold = value => normalize(value).toLowerCase();
const numbersOf = text => new Set(Array.from(String(text).matchAll(/(?<!\d)\d+(?!\d)/g), m => m[0]));

/** Index of the line that starts with the name (case-insensitive), from `from`; -1 when absent. */
function lineStartingWith(lines, name, from = 0) {
  const wanted = fold(name);
  for ( let i = from; i < lines.length; i++ ) {
    const low = fold(lines[i]);
    if ( low.startsWith(wanted) && !/[\p{L}\d]/u.test(low.charAt(wanted.length)) ) return i;
  }
  return -1;
}

/**
 * Validate the answer of the AI against the lines of the block.
 * @param {object} json  Answer (shape of `BLOCK_SCHEMA`).
 * @param {string[]} lines  Lines of the block region.
 * @returns {{stats: object, entries: object[], rejected: {field: string, value: *, reason: string}[], firstEntryLine: number}}
 *   `stats` has the shape of `parseStatLines` (ac, hp, speed, abilities, senses, cr), with only the accepted
 *   values; `entries` = `[{ name, meta, text, section }]` with the text cut from the source.
 */
export function validateAiBlock(json, lines) {
  const text = (lines ?? []).join("\n");
  const numbers = numbersOf(text);
  const folded = fold(text);
  const rejected = [];
  const reject = (field, value, reason = "notInText") => rejected.push({ field, value, reason });
  const stats = { ac: null, hp: null, speed: null, abilities: null, senses: null, cr: null };
  const data = json && typeof json === "object" ? json : {};

  // Numbers: a value is accepted only when it is a word of the text
  const number = (field, value) => {
    if ( value === null || value === undefined || value === "" ) return null;
    const n = Number(value);
    if ( !Number.isFinite(n) ) { reject(field, value, "notANumber"); return null; }
    const printed = Number.isInteger(n) ? String(n) : null;
    const fraction = { 0.125: "1/8", 0.25: "1/4", 0.5: "1/2" }[n];
    if ( (printed && numbers.has(printed)) || (fraction && folded.includes(fraction)) ) return n;
    reject(field, value);
    return null;
  };

  const ac = number("ac", data.ac);
  if ( ac !== null ) stats.ac = { value: ac, detail: "", natural: /natural armou?r|armure naturelle/iu.test(folded) };
  const hp = number("hp", data.hp);
  let formula = normalize(data.hpFormula);
  if ( formula && !folded.includes(fold(formula)) ) { reject("hpFormula", data.hpFormula); formula = ""; }
  if ( hp !== null ) stats.hp = { value: hp, formula };

  const speeds = {};
  for ( const [mode, value] of Object.entries(data.speed ?? {}) ) {
    if ( !MOVEMENT.includes(mode) || !value ) continue;
    const n = number(`speed.${mode}`, value);
    if ( n !== null ) speeds[mode] = n;
  }
  if ( Object.keys(speeds).length ) stats.speed = { speeds, hover: /\bhover\b|stationnaire/iu.test(folded) };

  const abilities = {};
  for ( const key of ABILITIES ) {
    const n = number(`abilities.${key}`, data.abilities?.[key]);
    if ( n !== null ) abilities[key] = n;
  }
  if ( Object.keys(abilities).length === 6 ) stats.abilities = abilities;
  else if ( Object.keys(abilities).length ) reject("abilities", data.abilities, "incomplete");

  const ranges = {};
  for ( const [sense, value] of Object.entries(data.senses ?? {}) ) {
    if ( !SENSES.includes(sense) || !value ) continue;
    const n = number(`senses.${sense}`, value);
    if ( n !== null ) ranges[sense] = n;
  }
  if ( Object.keys(ranges).length ) stats.senses = { ranges, units: "ft", special: "" };

  const cr = number("cr", data.cr);
  if ( cr !== null ) stats.cr = cr;

  // Entries: the name must start a line; the text runs from there to the next entry or section header
  const found = [];
  for ( const entry of Array.isArray(data.entries) ? data.entries : [] ) {
    const name = normalize(entry?.name);
    const section = SECTIONS.includes(entry?.section) ? entry.section : "trait";
    const index = name ? lineStartingWith(lines, name) : -1;
    if ( index < 0 ) { reject("entries", entry?.name ?? entry, "notInText"); continue; }
    if ( found.some(f => f.index === index) ) { reject("entries", name, "duplicate"); continue; }
    found.push({ name, section, index });
  }
  found.sort((a, b) => a.index - b.index);
  const starts = new Set(found.map(f => f.index));
  const entries = found.map((f, i) => {
    const first = lines[f.index].slice(f.name.length).replace(/^[.:\s]+/, "");
    const end = found[i + 1]?.index ?? lines.length;
    const parts = [first];
    for ( let j = f.index + 1; j < end; j++ ) {
      const line = lines[j];
      if ( starts.has(j) || sectionOf(line) || labelOf(line) ) break;
      parts.push(line);
    }
    let body = normalize(parts.join(" "));
    let meta = "";
    const mm = body.match(/^\(([^)]*)\)\.?\s*(.*)$/);
    if ( mm ) { meta = normalize(mm[1]); body = mm[2]; }
    return { name: f.name, meta, text: body, section: f.section, sectionKey: SECTION_KEYS[f.section] };
  });
  return { stats, entries, rejected, firstEntryLine: found[0]?.index ?? lines.length };
}
