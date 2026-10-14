// Replay of the text-parser library reference / control sets through the importer (M2, M3).
// The cases are read from the sibling repository (read-only): modules/dnd5e-text-parser/tests/fixtures/<set>/.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  compare, expectedActorTokens, expectedFeatureTokens, filterTokens, isCritical
} from "../../../dnd5e-text-parser/tests/support/canon.mjs";
import { actorTokens, itemTokens, minus } from "./canon.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const LIB = path.resolve(HERE, "../../../dnd5e-text-parser");
export const REAL_ITEMS = path.resolve(HERE, "../../tools/out/items.json");
const json = (file) => JSON.parse(readFileSync(file, "utf8"));
export const hasFile = (file) => existsSync(file);

const ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
export const idMaker = (seed = 7) => {
  let s = seed;
  return () => {
    let out = "";
    for (let i = 0; i < 16; i++) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; out += ALPHABET[(s >>> 24) % ALPHABET.length]; }
    return out;
  };
};

export const realItems = () => new Map(json(REAL_ITEMS).map((i) => [i._id, i]));

const HEADERS = [
  [/legendary action|action l[ée]gendaire/i, "legendary"], [/bonus action|action bonus/i, "bonus"],
  [/reaction|r[ée]action/i, "reaction"], [/action/i, "action"]
];
/**
 * The extraction of tools/ writes one empty utility per ability, with the activation of the "<small>Header</small>"
 * (cost always 1). `headerActivation` mimics it; false gives an empty activation (probe).
 */
const utility = (id, html, headerActivation) => {
  const header = /<small>([^<]*)<\/small>/.exec(html ?? "")?.[1] ?? "";
  const type = headerActivation ? (HEADERS.find(([re]) => re.test(header))?.[1] ?? "") : "";
  return { _id: id, type: "utility", name: "", activation: { type, value: type ? 1 : null, condition: "" }, roll: { formula: "" } };
};

/** A feat built from a reference case: a real item (activities as extracted) or a synthetic skeleton. */
export function buildFeature(c, real, newId, { headerActivation = true } = {}) {
  const base = real.get(c.ref ?? c.from);
  const item = base
    ? JSON.parse(JSON.stringify(base))
    : { type: "feat", system: { activities: {} } };
  item._id = newId();
  item.name = c.name ?? base.name;
  item.type = base?.type ?? "feat";
  item.system ??= {};
  item.system.description = { value: c.html ?? base.system.description.value };
  if (!base) {
    const id = newId();
    item.system.activities = { [id]: utility(id, c.html, headerActivation) };
  } else if (c.from) {
    // translated case: the activity of the real item is kept, its content is the one of the English extraction
    item.system.activities ??= {};
  }
  return item;
}

export function loadSet(setDir) {
  const dir = path.join(LIB, "tests/fixtures", setDir);
  const real = existsSync(REAL_ITEMS) ? realItems() : new Map();
  const read = (f) => (existsSync(path.join(dir, f)) ? json(path.join(dir, f)).cases : []);
  const features = [...read("features-real.json"), ...read("features-synthetic.json"), ...read("features-en.json"), ...read("features-fr.json")]
    .filter((c) => !(c.ref && !real.has(c.ref)));
  return { dir, features, actors: read("actors.json"), real };
}

const pct = (a, b) => (b ? Math.round((a / b) * 10000) / 100 : null);

function bucket() { return { cases: 0, expected: 0, produced: 0, correct: 0, critical: 0, missing: [], wrong: [], failed: [] }; }

function addResult(b, id, r) {
  b.cases++; b.expected += r.expected; b.produced += r.produced; b.correct += r.correct;
  b.critical += r.wrong.filter(isCritical).length;
  if (r.missing.length || r.wrong.length) {
    b.failed.push(id);
    r.missing.forEach((m) => b.missing.push(`${id}: ${m}`));
    r.wrong.forEach((w) => b.wrong.push(`${id}: ${w}`));
  }
}

const summarize = (b) => ({
  cases: b.cases, expectedFacts: b.expected, producedFacts: b.produced, correct: b.correct,
  recallPct: pct(b.correct, b.expected), precisionPct: pct(b.correct, b.produced), criticalErrors: b.critical,
  failedCases: b.failed, missing: b.missing, wrong: b.wrong
});

/**
 * Scores the analyzed documents of a set. `output` maps case id -> { input, output, enrichment } (documents as
 * plain data). Recall counts the expected facts that were empty in the input; precision counts the facts the
 * enrichment added.
 */
/**
 * Item level: the number of uses of a legendary resistance lives on the actor (resources.legres), the item only
 * carries the activity: its count is checked on the actor (C12). A feat activity has one range value: the long range is only carried by weapons (spec, "ajustements de mesure").
 * Both the expected and the produced range tokens are reduced to their first distance.
 */
export const normRange = (t) => t.startsWith("legendaryResistance=") ? "legendaryResistance=yes" : (t.startsWith("range=")
  ? t.replace(/^range=(reach \d+(?:\.\d+)?)(?: range .*)?$/, "range=$1").replace(/^range=range (\d+(?:\.\d+)?)\/\d+(?:\.\d+)?$/, "range=range $1")
  : t);

export function scoreFeatures(cases, output) {
  const perLang = { en: bucket(), fr: bucket(), all: bucket() };
  for (const c of cases) {
    const o = output.get(c.id);
    const before = itemTokens(o.input).map(normRange);
    const expectedAll = expectedFeatureTokens(c).map(normRange);
    const after = o.output ? filterTokens(itemTokens(o.output), c).map(normRange) : [];
    let expected = minus(expectedAll, before);
    let produced = minus(after, filterTokens(before, c));
    if (c.onlySkip) {
      // Multiattack: the document must come back untouched
      const same = o.output && JSON.stringify(o.input) === JSON.stringify(o.output);
      expected = expectedAll;
      produced = same ? expectedAll : ["skip=changed"];
    } else if (c.expectAmbiguous) {
      // an ambiguous text: nothing is invented
      expected = [];
      produced = produced.filter((x) => /^(attack|save|saveDamage|damage)=/.test(x));
    }
    const r = compare(expected, produced);
    for (const key of [c.lang, "all"]) addResult(perLang[key], c.id, r);
  }
  return Object.fromEntries(Object.entries(perLang).map(([k, b]) => [k, summarize(b)]));
}

export function scoreActors(cases, output) {
  const perLang = { en: bucket(), fr: bucket(), all: bucket() };
  for (const c of cases) {
    const o = output.get(c.id);
    const before = actorTokens(o.input);
    const r = compare(minus(expectedActorTokens(c), before), minus(o.output ? actorTokens(o.output) : [], before));
    for (const key of [c.lang, "all"]) addResult(perLang[key], c.id, r);
  }
  return Object.fromEntries(Object.entries(perLang).map(([k, b]) => [k, summarize(b)]));
}
