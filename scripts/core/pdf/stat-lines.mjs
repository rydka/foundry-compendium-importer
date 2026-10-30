/**
 * Stat lines of a block ("Armor Class 16", "Speed 0 ft., fly 60 ft. (hover)", "Challenge 12 (8,400 XP)") to values.
 * Port of `labelled_value`, `stat_line`, `parse_ac/hp/speed/abilities`, `parse_challenge_text`, `parse_senses_text`,
 * `parse_languages_text`, `parse_saving_throws_text` and `parse_skills_text` of the Python tool, extended to French
 * and to the 2024 layout ("AC 17 Initiative +2 (12)", "Str 16 +3 +3", "CR 5 (XP 1,800; PB +3)").
 */
import {
  ABILITY_CELL_RE, ABILITY_ORDER, ABILITY_ROW_RE, LEXICON, abilityKey, alternation, fold, isWord, labelOf, lookup,
  tableAlternation
} from "./lexicon.mjs";

const normalize = value => String(value ?? "").replace(/\s+/g, " ").trim();
const CR_VALUE = String.raw`(\d+\s*/\s*\d+|[⅛¼½]|\d+(?:[.,]\d+)?)`;
const UNIT_RE = `(${alternation([...LEXICON.units.ft, ...LEXICON.units.m])})`;
const TABLE_HEADER_RE = new RegExp(`^(?:\\s*(?:${alternation(LEXICON.tableHeaders)})\\.?)+\\s*$`, "iu");
const ABILITY_CELL = new RegExp(ABILITY_CELL_RE.source, "iu");

const unitOf = text => (LEXICON.units.m.some(u => fold(u) === fold(text)) ? "m" : "ft");
const feet = (value, unit, toFeet) => (toFeet ? toFeet(value, unit) : Math.round(Number(value) * (unit === "m" ? 10 / 3 : 1)));

/** "18", "1/2", "½", "0.25" -> number, null otherwise. */
export function parseCrValue(raw) {
  const s = normalize(raw).replace(/\s/g, "").replace(",", ".");
  if ( s in LEXICON.crFractions ) return LEXICON.crFractions[s];
  const fraction = s.match(/^(\d+)\/(\d+)$/);
  if ( fraction && Number(fraction[2]) ) return Number(fraction[1]) / Number(fraction[2]);
  const value = Number(s);
  return Number.isFinite(value) ? value : null;
}

/** Comma- or semicolon-separated parts. */
export const splitList = value => normalize(value).split(/[,;]/).map(p => p.trim()).filter(Boolean);

/**
 * "Medium undead/fiend (wraith), neutral evil", "Medium Undead, Neutral Evil", "Mort-vivant (fantôme) de taille M,
 * tout alignement", "Medium swarm of Tiny beasts, unaligned" -> `{ size, type, types, subtype, swarm, alignment }`,
 * or null when the line is not a size line.
 * @param {string} text
 * @returns {object|null}
 */
export function parseSizeLine(text) {
  const line = normalize(text);
  if ( !line || line.length > 120 ) return null;
  const [head, ...rest] = line.split(",");
  const alignment = rest.join(",").trim();
  const sizeWords = tableAlternation(LEXICON.sizes);
  const swarmWords = alternation(LEXICON.swarm);
  const sizeFr = alternation(LEXICON.sizePrefixFr);
  let m = head.match(new RegExp(`^(${sizeWords})(?:\\s+(?:or|ou)\\s+(?:${sizeWords}))?\\s+(?:(${swarmWords})\\s+(${sizeWords})\\s+)?(.+)$`, "iu"));
  let size; let body; let swarm = "";
  if ( m ) {
    size = lookup(LEXICON.sizes, m[1]);
    body = m[4];
    if ( m[2] ) swarm = lookup(LEXICON.sizes, m[3]) ?? "";
  } else {
    // French swarm: "Nuée de taille M de bêtes de taille TP"
    const swarmFr = alternation(LEXICON.swarmFr);
    m = head.match(new RegExp(`^(?:${swarmFr})\\s+(?:${sizeFr})\\s+(${sizeWords})\\s+(?:de|d['’])\\s*(.+?)\\s+(?:${sizeFr})\\s+(${sizeWords})\\s*$`, "iu"));
    if ( m ) {
      size = lookup(LEXICON.sizes, m[1]);
      body = m[2];
      swarm = lookup(LEXICON.sizes, m[3]) ?? "";
    } else {
      // French: "Mort-vivant (fantôme) de taille M", "Humanoïde de taille M ou P", "Nuée de bêtes de taille TP"
      m = head.match(new RegExp(`^(.+?)\\s+(?:${sizeFr})\\s+(${sizeWords})(?:\\s+(?:or|ou)\\s+(?:${sizeWords}))?\\s*$`, "iu"));
      if ( !m ) return null;
      size = lookup(LEXICON.sizes, m[2]);
      body = m[1];
      const swarmMatch = body.match(new RegExp(`^(?:${swarmWords})\\s*(.+)$`, "iu"));
      if ( swarmMatch ) { body = swarmMatch[1]; swarm = size; }
    }
  }
  if ( !size ) return null;
  const paren = body.match(/\(([^)]*)\)/);
  const typeText = body.replace(/\([^)]*\)/g, " ").trim();
  const types = typeText.split(/\s*\/\s*|\s+(?:or|ou)\s+/i).map(t => lookup(LEXICON.creatureTypes, t)).filter(Boolean);
  if ( !types.length ) {
    // A word of the type at the start of the text ("undead (ghost)" reads as a type with a trailing word)
    const first = typeText.split(/\s+/).map(t => lookup(LEXICON.creatureTypes, t)).find(Boolean);
    if ( !first ) return null;
    types.push(first);
  }
  const subtypeParts = [...types.slice(1), paren?.[1]?.trim()].filter(Boolean);
  return {
    size, type: types[0], types, subtype: subtypeParts.join(", "), swarm, alignment,
    anyAlignment: isWord(LEXICON.anyAlignment, alignment)
  };
}

/** True for a size and type line (see `parseSizeLine`). */
export const isSizeLine = text => parseSizeLine(text) !== null;

/**
 * Group the stat lines into labelled records: a line that starts with a label opens a record, the next lines without
 * a label continue it (two-column stat blocks wrap their values). The ability header row and the 2024 ability cells
 * are records of their own.
 * @param {string[]} lines
 * @returns {{kind: string, label: string, text: string}[]}
 */
export function groupRecords(lines) {
  const records = [];
  let current = null;
  for ( const raw of lines ) {
    const text = normalize(raw);
    if ( !text || TABLE_HEADER_RE.test(text) ) continue;
    const label = labelOf(text);
    if ( label ) {
      current = { kind: label.kind, label: label.word, text: text.slice(label.length).replace(/^[\s:]+/, "").trim() };
      records.push(current);
      continue;
    }
    if ( ABILITY_ROW_RE.test(text) || ABILITY_CELL.test(text) ) {
      current = { kind: "abilities", label: "", text };
      records.push(current);
      continue;
    }
    if ( current ) current.text = normalize(`${current.text} ${text}`);
    else records.push(current = { kind: "unknown", label: "", text });
  }
  return records;
}

const firstOf = (records, kind) => records.find(r => r.kind === kind) ?? null;
const allOf = (records, kind) => records.filter(r => r.kind === kind);

/** "16 (natural armor)" -> { value, detail, natural }. */
export function parseAc(text) {
  const m = normalize(text).match(/^(\d+)(?:\s*\(([^)]*)\))?/);
  if ( !m ) return null;
  const detail = normalize(m[2] ?? "");
  return { value: Number(m[1]), detail, natural: LEXICON.naturalArmor.some(w => fold(detail).includes(fold(w))) };
}

/** "136 (16d8 + 64)" -> { value, formula }. */
export function parseHp(text) {
  const m = normalize(text).match(/(\d+)\s*(?:\(([^)]+)\))?/);
  if ( !m ) return null;
  return { value: Number(m[1]), formula: normalize(m[2] ?? "") };
}

/** "+2 (12)" -> { bonus, score } (2024 "Initiative" after the AC). */
export function parseInitiative(text) {
  const m = normalize(text).match(/([+-]\s*\d+)(?:\s*\((\d+)\))?/);
  if ( !m ) return null;
  return { bonus: Number(m[1].replace(/\s/g, "")), score: m[2] ? Number(m[2]) : null };
}

/**
 * "0 ft., fly 60 ft. (hover)", "9 m, vol 18 m (vol stationnaire)" -> { speeds: { walk, fly… } (feet), hover }.
 * @param {string} text
 * @param {{toFeet?: Function}} [opts]
 */
export function parseSpeed(text, { toFeet } = {}) {
  const line = normalize(text);
  if ( !line ) return null;
  const hover = LEXICON.hover.some(w => fold(line).includes(fold(w)));
  const modeWords = tableAlternation(LEXICON.movement);
  const re = new RegExp(`^(?:(${modeWords})\\s*:?\\s*)?(\\d+(?:[.,]\\d+)?)\\s*${UNIT_RE}?(?![\\p{L}\\d])`, "iu");
  const speeds = {};
  for ( const part of splitList(line.replace(/\([^)]*\)/g, " ")) ) {
    const m = part.match(re);
    if ( !m ) continue;
    const mode = m[1] ? lookup(LEXICON.movement, m[1]) : "walk";
    if ( !mode ) continue;
    speeds[mode] = feet(m[2].replace(",", "."), m[3] ? unitOf(m[3]) : "ft", toFeet);
  }
  if ( !Object.keys(speeds).length ) return null;
  return { speeds, hover };
}

/**
 * Ability scores from the ability records: the 2024 cells ("Str 16 +3 +3": score, modifier, save; a save that
 * differs from the modifier is a proficient save) or the 2014 row of six scores under the header row.
 * @param {{text: string}[]} records  Records of kind "abilities".
 * @returns {{scores: object, saves: object}|null}  `scores` = { str: 12… }, `saves` = { dex: 10… } (2024 only).
 */
export function parseAbilities(records) {
  const scores = {};
  const saves = {};
  const cells = records.flatMap(r => Array.from(r.text.matchAll(new RegExp(ABILITY_CELL_RE.source, "giu"))));
  if ( cells.length >= 6 ) {
    for ( const [, name, score, mod, save] of cells ) {
      const key = abilityKey(name);
      if ( !key ) continue;
      scores[key] = Number(score);
      const modValue = Number(mod.replace(/\s/g, ""));
      const saveValue = Number(save.replace(/\s/g, ""));
      if ( saveValue !== modValue ) saves[key] = saveValue;
    }
    return Object.keys(scores).length === 6 ? { scores, saves } : null;
  }
  const headerWords = new RegExp(`\\b(?:${tableAlternation(LEXICON.abilities)})\\b`, "giu");
  for ( const record of records ) {
    const cleaned = record.text.replace(headerWords, " ").replace(/\([^)]*\)/g, " ");
    const numbers = Array.from(cleaned.matchAll(/(?<![\d+-])(\d{1,2})(?![\d])/g), m => Number(m[1]));
    if ( numbers.length >= 6 ) {
      ABILITY_ORDER.forEach((key, i) => { scores[key] = numbers[i]; });
      return { scores, saves };
    }
  }
  return null;
}

/** "12 (8,400 XP) Proficiency Bonus +4", "5 (XP 1,800; PB +3)" -> { cr, xp, prof }. */
export function parseChallenge(text) {
  let line = normalize(text);
  if ( !line ) return null;
  const profWords = alternation(LEXICON.labels.prof);
  let prof = null;
  line = line.replace(new RegExp(`(?:${profWords})\\s*:?\\s*\\+?\\s*(\\d+)`, "iu"), (_, n) => { prof = Number(n); return " "; });
  const m = line.match(new RegExp(`${CR_VALUE}(?:\\s*\\(([^)]*)\\))?(?:\\s*\\+\\s*(\\d+))?`, "u"));
  if ( !m ) return null;
  const cr = parseCrValue(m[1]);
  if ( cr === null ) return null;
  let xp = null;
  const inside = m[2] ?? "";
  const xpWords = alternation(LEXICON.xp);
  const xpMatch = inside.match(new RegExp(`([\\d,.\\s]+?)\\s*(?:${xpWords})\\b`, "iu"))
    ?? inside.match(new RegExp(`(?:${xpWords})\\s*:?\\s*([\\d,.\\s]+)`, "iu"));
  if ( xpMatch ) {
    const digits = xpMatch[1].replace(/\D/g, "");
    if ( digits ) xp = Number(digits);
  }
  if ( prof === null && m[3] ) prof = Number(m[3]);
  return { cr, xp, prof };
}

/** dnd5e: Proficiency.calculateMod(max(cr, 1)). */
export const proficiencyFromCr = cr => (cr === null || cr === undefined ? null : Math.floor((Math.max(Number(cr), 1) + 7) / 4));

/** A custom trait entry is short prose without numbers; interleaved lines of the other column are not. */
export const isPlausibleCustom = part => /\p{L}/u.test(part) && !/[\d:.]/.test(part) && part.length <= 60;

/**
 * "darkvision 120 ft., passive Perception 13" -> { ranges: { darkvision: 120 }, units: "ft", special }.
 */
export function parseSenses(text, { toFeet } = {}) {
  const line = normalize(text);
  if ( !line ) return null;
  const ranges = {};
  const special = [];
  const senseWords = tableAlternation(LEXICON.senses);
  const re = new RegExp(`^(${senseWords})\\s+(\\d+)\\s*${UNIT_RE}?\\s*(.*)$`, "iu");
  const passive = new RegExp(`^(?:${alternation(LEXICON.passivePerception)})\\b`, "iu");
  for ( const part of splitList(line) ) {
    const m = part.match(re);
    if ( m ) {
      const key = lookup(LEXICON.senses, m[1]);
      ranges[key] = feet(m[2], m[3] ? unitOf(m[3]) : "ft", toFeet);
      const rest = normalize(m[4]);
      if ( rest && isPlausibleCustom(rest) ) special.push(`${key} ${rest}`);
    } else if ( !passive.test(part) && isPlausibleCustom(part) ) special.push(part);
  }
  if ( !Object.keys(ranges).length && !special.length ) return null;
  return { ranges, units: "ft", special: special.join("; ") };
}

/**
 * "Common, Abyssal, telepathy 60 ft." -> { value: ["common", "abyssal"], custom: "", communication: { telepathy } }.
 */
export function parseLanguages(text, { toFeet } = {}) {
  const line = normalize(text);
  if ( !line ) return null;
  const value = new Set();
  const custom = [];
  const communication = {};
  const telepathy = new RegExp(`^(?:${alternation(LEXICON.telepathy)})\\s+(\\d+)\\s*${UNIT_RE}?`, "iu");
  for ( let part of splitList(line) ) {
    const tele = part.match(telepathy);
    if ( tele ) {
      communication.telepathy = { value: feet(tele[1], tele[2] ? unitOf(tele[2]) : "ft", toFeet), units: "ft" };
      continue;
    }
    part = part.replace(/\s*\(.*$/, "").trim();
    const low = fold(part).replace(/[.\s]+$/, "");
    if ( !low || isWord(LEXICON.noLanguage, low) || !/\p{L}/u.test(low) ) continue;
    const key = lookup(LEXICON.languages, low);
    if ( key ) value.add(key);
    else custom.push(part.replace(/[.\s]+$/, ""));
  }
  if ( !value.size && !custom.length && !communication.telepathy ) return null;
  return { value: [...value].sort(), custom: custom.join("; "), communication };
}

/** "Str +11, Wis +9", "For +11, Sag +9" -> { str: 11, wis: 9 }. */
export function parseSaves(text) {
  const out = {};
  for ( const m of normalize(text).matchAll(/([\p{L}]+)\.?\s*([+-]\s*\d+)/gu) ) {
    const key = abilityKey(m[1]);
    if ( key ) out[key] = Number(m[2].replace(/\s/g, ""));
  }
  return Object.keys(out).length ? out : null;
}

/**
 * "Athletics +11, Perception +4" -> { ath: 2, prc: 1 }: proficiency level (2 = expertise when the bonus reaches
 * the ability modifier plus twice the proficiency bonus).
 */
export function parseSkills(text, { scores, prof, cr } = {}) {
  const line = normalize(text);
  if ( !line ) return null;
  const bonus = prof ?? proficiencyFromCr(cr);
  const out = {};
  for ( const m of line.matchAll(/([\p{L}][\p{L} '’-]*?)\s*([+-]\s*\d+)/gu ) ) {
    const key = lookup(LEXICON.skills, m[1].trim());
    if ( !key ) continue;
    let level = 1;
    const value = Number(m[2].replace(/\s/g, ""));
    const score = scores?.[LEXICON.skillAbilities[key]];
    if ( bonus && (score !== undefined) && (value >= Math.floor((score - 10) / 2) + 2 * bonus) ) level = 2;
    out[key] = level;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Read the stat lines of a block.
 * @param {string[]} lines  Lines between the size line and the first trait, in reading order.
 * @param {{toFeet?: Function}} [opts]  `toFeet(value, unit)` of the text parser (metres to feet).
 * @returns {object}  `{ ac, hp, initiative, speed, abilities, saves, skills, senses, languages, cr, xp, prof,
 *   traitLines, gear, records }`; every field null when its line is absent. `traitLines` = `[{ kind, text }]` with
 *   the printed text of the dr/di/dv/ci lines (the text parser reads them).
 */
export function parseStatLines(lines, { toFeet } = {}) {
  const records = groupRecords(lines);
  const text = kind => firstOf(records, kind)?.text ?? "";
  const acRecord = text("ac");
  const initiativeWords = alternation(LEXICON.labels.initiative);
  // 2024: "AC 17 Initiative +2 (12)" on one line, or "Initiative +12 (22)" on its own line
  const initiativeMatch = acRecord.match(new RegExp(`(?:${initiativeWords})\\s*(.*)$`, "iu")) ?? [null, text("initiative")];
  const abilities = parseAbilities(allOf(records, "abilities"));
  const challenge = parseChallenge(text("cr"));
  const profLine = text("prof").match(/\+?\s*(\d+)/);
  const prof = profLine ? Number(profLine[1]) : challenge?.prof ?? null;
  const cr = challenge?.cr ?? null;
  const saves = parseSaves(text("saves")) ?? (abilities && Object.keys(abilities.saves).length ? abilities.saves : null);
  return {
    ac: parseAc(acRecord),
    hp: parseHp(text("hp")),
    initiative: initiativeMatch ? parseInitiative(initiativeMatch[1]) : null,
    speed: parseSpeed(text("speed"), { toFeet }),
    abilities: abilities?.scores ?? null,
    saves,
    skills: parseSkills(text("skills"), { scores: abilities?.scores, prof, cr }),
    senses: parseSenses(text("senses"), { toFeet }),
    languages: parseLanguages(text("languages"), { toFeet }),
    cr,
    xp: challenge?.xp ?? null,
    prof,
    traitLines: records.filter(r => ["dr", "di", "dv", "ci"].includes(r.kind)).map(r => ({ kind: r.kind, label: r.label, text: r.text })),
    gear: text("gear") || null,
    records
  };
}

/** The four values a creature needs (the Python `has_required_creature_stats`). */
export function hasRequiredStats(stats) {
  return !!(stats?.ac && stats.hp && stats.speed && stats.abilities);
}
