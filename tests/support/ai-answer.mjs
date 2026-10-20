// Builds the answer a local model would give for BLOCK_SCHEMA (scripts/core/pdf/ai-block.mjs), from the facts of a
// synthetic creature spec. The schema is the developer's, so the property names are matched loosely (ac / armorClass,
// hp / hitPoints, ...); an unknown required property gets a neutral value of its type.
//
// facts: { ac, hp, hpFormula, cr, xp, speed:{walk,fly..}, abilities:{str..}, senses:{darkvision..}, entries:[{name, section}] }
import { ABILITIES } from "./synth.mjs";

const key = (k) => String(k).toLowerCase().replace(/[^a-z]/g, "");
const ABILITY_WORDS = { str: "strength", dex: "dexterity", con: "constitution", int: "intelligence", wis: "wisdom", cha: "charisma" };
const SECTION_WORDS = { trait: "trait", action: "action", bonus: "bonus", reaction: "reaction", legendary: "legendary" };

function neutral(schema) {
  switch (schema?.type) {
    case "string": return schema.enum?.[0] ?? "";
    case "integer": case "number": return 0;
    case "boolean": return false;
    case "array": return [];
    case "object": return Object.fromEntries(Object.entries(schema.properties ?? {}).map(([k, s]) => [k, neutral(s)]));
    default: return null;
  }
}

function fill(schema, name, facts) {
  const k = key(name);
  if (k === "name") return facts.name;
  if (/^(ac|armorclass|armourclass)$/.test(k)) return facts.ac;
  if (/^(hp|hitpoints|hpvalue|hitpointsvalue|maxhp)$/.test(k)) return facts.hp;
  if (/(hpformula|hitdice|hitpointsformula|formula)$/.test(k)) return facts.hpFormula;
  if (/^(cr|challenge|challengerating)$/.test(k)) return facts.cr;
  if (/^(xp|experience)$/.test(k)) return facts.xp;
  if (/speed|movement/.test(k)) {
    if (schema.type === "object") return Object.fromEntries(Object.keys(schema.properties ?? {}).map((p) => [p, facts.speed[key(p)] ?? 0]));
    return facts.speed.walk;
  }
  if (/sense/.test(k) && schema.type === "object") return Object.fromEntries(Object.keys(schema.properties ?? {}).map((p) => [p, facts.senses?.[key(p)] ?? 0]));
  if (/abilit|scores/.test(k) && schema.type === "object") {
    return Object.fromEntries(Object.keys(schema.properties ?? {}).map((p) => {
      const a = ABILITIES.find((x) => x === key(p) || ABILITY_WORDS[x] === key(p));
      return [p, a ? facts.abilities[a] : 0];
    }));
  }
  if (/abilit|scores|stats/.test(k) && schema.type === "array") return ABILITIES.map((a) => facts.abilities[a]);
  if (schema.type === "array" && schema.items?.type === "object" && /entr|feature|trait|action|capab/.test(k)) {
    return facts.entries.map((e) => Object.fromEntries(Object.entries(schema.items.properties ?? {}).map(([p, s]) => {
      const pk = key(p);
      if (/^(name|title)$/.test(pk)) return [p, e.name];
      if (/section|kind|category|type|group/.test(pk)) return [p, s.enum ? (s.enum.find((v) => key(v).startsWith(key(SECTION_WORDS[e.section]).slice(0, 4))) ?? s.enum[0]) : SECTION_WORDS[e.section]];
      return [p, neutral(s)];
    })));
  }
  return undefined;
}

/** @returns {object} an object that validates against `schema`. */
export function buildAnswer(schema, facts) {
  const out = {};
  for (const [name, sub] of Object.entries(schema?.properties ?? {})) {
    const v = fill(sub, name, facts);
    out[name] = v === undefined ? neutral(sub) : v;
  }
  return out;
}

/** Facts of a synthetic creature spec (synth.expectedCreature output) for `buildAnswer`. */
export function factsOf(exp) {
  return {
    name: exp.name, ac: exp.ac.value, hp: exp.hp.value, hpFormula: exp.hp.formula, cr: exp.cr, xp: exp.xp,
    speed: exp.speed, abilities: exp.abilities, senses: exp.senses,
    entries: exp.entries.map((e) => ({ name: e.name, section: e.section }))
  };
}
