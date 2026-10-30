// Scoring of extracted creatures and magic items against a truth (annotated PDF or synthetic spec).
// Pure: no Foundry global. Used by the unit tests (assertions), by tests/metrics/*.mjs (measures, never fail) and
// by the integration specs.
//
// Common expected shape (see `commonCreature`):
//   { name, ac, hp:{value,formula}, speed:{walk,fly,..,hover}, abilities:{str..}, saves:[keys], skills:{key:level},
//     senses:{darkvision:60..}, cr, counts:{trait,action,bonus,reaction,legendary}, countsAlt:{trait:[6,7]}, entries:[{name,section,sha1,length}] }
import { SKILL_ABILITY } from "./synth.mjs";
import { fingerprintOf } from "./fingerprint.mjs";

const ABILITIES = ["str", "dex", "con", "int", "wis", "cha"];
const SKILL_KEY = {
  acrobatics: "acr", "animal handling": "ani", arcana: "arc", athletics: "ath", deception: "dec", history: "his", insight: "ins",
  intimidation: "itm", investigation: "inv", medicine: "med", nature: "nat", perception: "prc", performance: "prf",
  persuasion: "per", religion: "rel", "sleight of hand": "slt", stealth: "ste", survival: "sur"
};
const mod = (s) => Math.floor((s - 10) / 2);
const SECTIONS = ["trait", "action", "bonus", "reaction", "legendary"];
const norm = (s) => String(s ?? "").normalize("NFKC").toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, " ").trim();
export const nameKey = norm;

/** Field list of M3 (one point each, per creature). */
export const CREATURE_FIELDS = ["ac", "hp", "speed", "abilities", "cr", "senses", "saves", "skills", "counts"];

// ------------------------------------------------------------------------------------------ expected, common shape

/** Better Undead truth (better-undead.truth.json) -> common shape. */
export function commonFromTruth(t) {
  const skills = {};
  for (const [name, bonus] of Object.entries(t.skills ?? {})) {
    const key = SKILL_KEY[name];
    skills[key] = bonus >= mod(t.abilities[SKILL_ABILITY[key]]) + 2 * t.prof ? 2 : 1;
  }
  return {
    name: t.name, size: t.size, alignment: t.alignment,
    ac: t.ac.value, acNatural: t.ac.natural,
    hp: { value: t.hp.value, formula: t.hp.formula },
    speed: { ...t.speed }, abilities: { ...t.abilities }, saves: Object.keys(t.saves ?? {}), skills,
    senses: { ...t.senses }, cr: t.cr, prof: t.prof,
    counts: { ...t.counts }, countsAlt: t.alsoCountedAs ?? {},
    entries: t.entries, extras: t.extras ?? []
  };
}

/** Synthetic expected (synth.expectedCreature) -> common shape. */
export function commonFromSpec(e) {
  return {
    name: e.name, size: e.size, alignment: e.alignment,
    ac: e.ac.value, acNatural: e.ac.natural,
    hp: { ...e.hp }, speed: { ...e.speed }, abilities: { ...e.abilities }, saves: Object.keys(e.saves),
    skills: Object.fromEntries(Object.entries(e.skills).map(([k, v]) => [k, v.level])),
    senses: { ...e.senses }, cr: e.cr, prof: e.prof, counts: { ...e.counts }, countsAlt: {},
    traits: e.traits, entries: e.entries, extras: []
  };
}

// ------------------------------------------------------------------------------------------ reading an extracted actor

const SMALL = /<small>\s*(Legendary Action|Bonus Action|Action|Reaction)s?\s*<\/small>/i;
const SECTION_OF_SMALL = { "legendary action": "legendary", "bonus action": "bonus", action: "action", reaction: "reaction" };
const HEADING_ITEM = /^(legendary actions?|actions? l[ée]gendaires?|actions?|bonus actions?|actions? bonus|reactions?|r[ée]actions?)$/i;

/** Section of an actor item, read from its `<small>` header (no header: trait). */
export function sectionOfItem(item) {
  const m = SMALL.exec(item?.system?.description?.value ?? "");
  return m ? SECTION_OF_SMALL[m[1].toLowerCase()] : "trait";
}

/** The facts the tests compare, read from a dnd5e actor source produced by the extractor. */
export function readActor(src) {
  if (!src) return null;
  const s = src.system ?? {};
  const ac = s.attributes?.ac ?? {};
  const hp = s.attributes?.hp ?? {};
  const speeds = s.attributes?.movement?.speeds ?? {};
  const ranges = s.attributes?.senses?.ranges ?? {};
  const speed = {};
  for (const [k, v] of Object.entries(speeds)) if (v) speed[k] = Number(v);
  speed.walk ??= 0;
  if (s.attributes?.movement?.hover) speed.hover = true;
  const senses = {};
  for (const [k, v] of Object.entries(ranges)) if (v) senses[k] = Number(v);
  const abilities = {};
  const saves = [];
  for (const k of ABILITIES) {
    abilities[k] = s.abilities?.[k]?.value;
    if (s.abilities?.[k]?.proficient) saves.push(k);
  }
  const skills = {};
  for (const [k, v] of Object.entries(s.skills ?? {})) if (v?.value) skills[k] = Number(v.value);
  const entries = (src.items ?? [])
    .filter((i) => !HEADING_ITEM.test(String(i.name).trim()))
    .map((i) => ({ name: i.name, section: sectionOfItem(i), html: i.system?.description?.value ?? "", type: i.type }));
  const counts = Object.fromEntries(SECTIONS.map((x) => [x, 0]));
  for (const e of entries) counts[e.section]++;
  return {
    name: src.name, type: src.type,
    ac: ac.flat ?? ac.override ?? ac.value ?? null, acNatural: Array.isArray(ac.calcs) ? ac.calcs.includes("natural") : (ac.calc === "natural"),
    hp: { value: hp.value, max: hp.max, formula: hp.formula },
    speed, senses, abilities, saves, skills,
    cr: s.details?.cr, size: s.traits?.size, creatureType: s.details?.type?.value, alignment: s.details?.alignment,
    traits: { dr: s.traits?.dr?.value ?? [], di: s.traits?.di?.value ?? [], dv: s.traits?.dv?.value ?? [], ci: s.traits?.ci?.value ?? [] },
    entries, counts, flags: src.flags?.["compendium-json-importer"]?.pdf ?? null
  };
}

// ------------------------------------------------------------------------------------------ comparison

const sameSet = (a, b) => a.length === b.length && [...a].sort().join() === [...b].sort().join();
const compact = (s) => String(s ?? "").replace(/\s+/g, "").toLowerCase();

function sameMap(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) if ((a[k] ?? 0) !== (b[k] ?? 0)) return false;
  return true;
}

/**
 * M3 fields of one creature: { field: true|false }.
 * @param {object} got  readActor() result (null when the creature is missing).
 * @param {object} want  common shape.
 */
export function scoreCreature(got, want) {
  if (!got) return Object.fromEntries(CREATURE_FIELDS.map((f) => [f, false]));
  const speedWant = { ...want.speed };
  const speedGot = { ...got.speed };
  const counts = SECTIONS.every((s) => got.counts[s] === want.counts[s] || (want.countsAlt?.[s] ?? []).includes(got.counts[s]));
  return {
    ac: got.ac === want.ac,
    hp: got.hp.value === want.hp.value && got.hp.max === want.hp.value && compact(got.hp.formula) === compact(want.hp.formula),
    speed: sameMap(speedGot, speedWant) && !!speedGot.hover === !!speedWant.hover,
    abilities: ABILITIES.every((k) => got.abilities[k] === want.abilities[k]),
    cr: Number(got.cr) === Number(want.cr),
    senses: sameMap(got.senses, want.senses),
    saves: sameSet(got.saves, want.saves),
    skills: sameMap(got.skills, want.skills),
    counts
  };
}

/**
 * Text fidelity: for each expected entry, the extracted entry of the same name and section must carry the same text.
 * @returns {{ ok: number, total: number, missing: string[], different: string[], extra: string[] }}
 */
export function scoreEntries(got, want) {
  const pool = got.entries.map((e) => ({ ...e, key: `${e.section}|${nameKey(e.name)}`, used: false }));
  let ok = 0;
  const missing = [];
  const different = [];
  for (const w of want.entries) {
    const key = `${w.section}|${nameKey(w.name)}`;
    const cand = pool.find((p) => !p.used && p.key === key);
    if (!cand) { missing.push(`${w.section}: ${w.name}`); continue; }
    cand.used = true;
    const fp = fingerprintOf(cand.html);
    if (fp.sha1 === w.sha1 && fp.length === w.length) ok++;
    else different.push(`${w.section}: ${w.name} (length ${fp.length}, expected ${w.length})`);
  }
  return { ok, total: want.entries.length, missing, different, extra: pool.filter((p) => !p.used).map((p) => `${p.section}: ${p.name}`) };
}

// ------------------------------------------------------------------------------------------ magic items

/** Fields of M4: type, rarity, attunement. */
export const ITEM_FIELDS = ["type", "rarity", "attunement"];

/** Facts of an item source. */
export function readItem(src) {
  if (!src) return null;
  const s = src.system ?? {};
  const rarities = Array.isArray(s.rarities) ? s.rarities : (s.rarity ? [s.rarity] : []);
  return {
    name: src.name, docType: src.type, typeValue: s.type?.value ?? null,
    rarity: rarities[0] ?? "", attunement: s.attunement ?? "",
    html: s.description?.value ?? "", flags: src.flags?.["compendium-json-importer"]?.pdf ?? null
  };
}

export function scoreItem(got, want) {
  if (!got) return { type: false, rarity: false, attunement: false };
  const typeOk = got.docType === want.docType && (want.typeValue === null || got.typeValue === want.typeValue);
  return { type: typeOk, rarity: got.rarity === want.rarity, attunement: (got.attunement || "") === (want.attunement || "") };
}

/** Pairs expected and extracted creatures by name. */
export function pairByName(gotList, wantList) {
  const pool = [...gotList];
  return wantList.map((w) => {
    const i = pool.findIndex((g) => nameKey(g.name) === nameKey(w.name));
    return { want: w, got: i >= 0 ? pool.splice(i, 1)[0] : null };
  });
}

/** Aggregates a set of per-creature scores. */
export function aggregate(scores, fields) {
  let ok = 0;
  let total = 0;
  const byField = Object.fromEntries(fields.map((f) => [f, { ok: 0, total: 0 }]));
  for (const s of scores) for (const f of fields) { total++; byField[f].total++; if (s[f]) { ok++; byField[f].ok++; } }
  return { ok, total, ratio: total ? ok / total : 0, byField };
}
