/**
 * Compendium lookup helpers (C18-C21), pure: no Foundry global, no parser import.
 * The parser (dnd5e-text-parser) is always injected by the caller; names are compared with `parser.nameKey`.
 */

/** Names whose items are never enriched nor taken from a compendium (Multiattack, out of scope). */
export function isMultiattackKey(key) {
  return key === "multiattack" || key === "attaques multiples";
}

/**
 * Elements of the actors that deserve a compendium lookup: their items and the spells listed by their
 * spellcasting traits. Returns unique { key, type, name }.
 */
export function collectLookups(entries, parser) {
  const seen = new Map();
  const add = (name, type) => {
    const key = parser.nameKey(name);
    if (!key || !type || isMultiattackKey(key)) return;
    const id = `${type}|${key}`;
    if (!seen.has(id)) seen.set(id, { key, type, name });
  };
  for (const entry of entries ?? []) {
    if (!entry || !Array.isArray(entry.items)) continue;
    for (const item of entry.items) add(item?.name, item?.type);
    let plan;
    try { plan = parser.parseActor(entry); } catch { plan = null; }
    for (const casting of plan?.spellcasting ?? []) {
      for (const list of casting.lists ?? []) for (const spell of list.spells ?? []) add(spell, "spell");
    }
  }
  return [...seen.values()];
}

function indexEntries(indexByPack, pack) {
  if (indexByPack instanceof Map) return indexByPack.get(pack) ?? [];
  return indexByPack?.[pack] ?? [];
}

/**
 * Looks a (key, type) up in the packs, in priority order. The first pack with at least one entry decides:
 * one entry = found, several = ambiguous.
 * @param {Map<string, {_id: string, name: string, type: string}[]>|object} indexByPack
 * @param {({pack: string, enabled?: boolean}|string)[]} order
 * @param {{ keyOf: (name: string) => string }} options `keyOf` is the `nameKey` of the parser
 */
export function findMatch(indexByPack, order, key, type, { keyOf } = {}) {
  if (typeof keyOf !== "function") throw new TypeError("findMatch: keyOf (parser.nameKey) is required");
  for (const source of order ?? []) {
    const pack = typeof source === "string" ? source : source.pack;
    if (typeof source !== "string" && source.enabled === false) continue;
    const hits = indexEntries(indexByPack, pack).filter(e => e.type === type && keyOf(e.name) === key);
    if (hits.length === 1) return { status: "found", pack, id: hits[0]._id };
    if (hits.length > 1) return { status: "ambiguous", pack, id: null };
  }
  return { status: "none", pack: null, id: null };
}

// ---------------------------------------------------------------- source order

const MODERN = ["spells24", "equipment24", "monsterfeatures24", "spells", "items", "monsterfeatures", "tradegoods"];
const LEGACY = ["spells", "items", "monsterfeatures", "tradegoods", "spells24", "equipment24", "monsterfeatures24"];
const EXCLUDED = new Set(["classfeatures", "classes", "subclasses", "races", "backgrounds", "classes24", "origins24", "feats24"]);

/**
 * Default source order. `packs` = [{ collection, label, packageType: "system"|"world"|"module" }].
 * Returns [{ pack, enabled }]: dnd5e (per rules version), then world, then modules (by label).
 */
export function defaultSourceOrder(packs, rulesVersion = "modern") {
  const known = rulesVersion === "legacy" ? LEGACY : MODERN;
  const rank = pack => {
    if (pack.packageType === "system") {
      const name = pack.collection.split(".").slice(1).join(".");
      const i = known.indexOf(name);
      return [0, i < 0 ? known.length : i, pack.label ?? ""];
    }
    return [pack.packageType === "world" ? 1 : 2, 0, pack.label ?? ""];
  };
  return [...packs]
    .sort((a, b) => {
      const [ga, ia, la] = rank(a);
      const [gb, ib, lb] = rank(b);
      return ga - gb || ia - ib || la.localeCompare(lb);
    })
    .map(pack => ({
      pack: pack.collection,
      enabled: !(pack.packageType === "system" && EXCLUDED.has(pack.collection.split(".").slice(1).join(".")))
    }));
}

/** Saved choices (kept if the pack still exists), then the packs not saved yet, in default order. */
export function resolveSourceOrder(saved, packs, rulesVersion = "modern") {
  const existing = new Set(packs.map(p => p.collection));
  const result = [];
  const used = new Set();
  for (const entry of saved ?? []) {
    if (!entry?.pack || !existing.has(entry.pack) || used.has(entry.pack)) continue;
    used.add(entry.pack);
    result.push({ pack: entry.pack, enabled: entry.enabled !== false });
  }
  for (const entry of defaultSourceOrder(packs, rulesVersion)) if (!used.has(entry.pack)) result.push(entry);
  return result;
}

// ---------------------------------------------------------------- PDF note

function plain(html) {
  return String(html ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function stripHeader(text, name) {
  let out = text.replace(/^(?:action|bonus action|reaction|legendary action[^.]*?|action bonus|réaction|action légendaire[^.]*?)\s+/i, "");
  if (name) {
    const n = String(name).trim();
    if (out.toLowerCase().startsWith(n.toLowerCase())) out = out.slice(n.length).replace(/^[\s.:]+/, "");
  }
  return out.trim();
}

/** Appends the file description after the compendium one, as a "PDF version" note, only if it differs. */
export function appendPdfNote(html, fileHtml, label, { name } = {}) {
  const fileText = stripHeader(plain(fileHtml), name);
  if (!fileText) return html ?? "";
  const norm = s => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  if (norm(plain(html)).includes(norm(fileText))) return html ?? "";
  return `${html ?? ""}<hr><p><strong>${label}</strong></p>${fileHtml}`;
}

// ---------------------------------------------------------------- adjustment (C20)

const clone = v => JSON.parse(JSON.stringify(v));

function partFormula(p) {
  const dice = p.number && p.denomination ? `${p.number}d${p.denomination}` : "";
  const bonus = String(p.bonus ?? "").replace(/\s+/g, "");
  const sign = dice && bonus && !/^[+-]/.test(bonus) ? "+" : "";
  return `${dice}${sign}${bonus}`;
}
const fromStored = p => ({ number: p.number ?? null, denomination: p.denomination ?? null, bonus: p.bonus ?? "", type: [...(p.types ?? [])][0] ?? null });
const keyOfPart = p => `${partFormula(p)} ${p.type ?? ""}`;
const sameParts = (a, b) => a.length === b.length && a.every((p, i) => keyOfPart(p) === keyOfPart(b[i]));

/** DamagePart (parser) -> dnd5e damage part source. */
export function toStoredPart(p) {
  return {
    number: p.number ?? null,
    denomination: p.denomination ?? null,
    bonus: p.bonus ?? "",
    types: p.type ? [p.type] : []
  };
}

const showParts = parts => parts.map(keyOfPart).join(" + ").trim();

/**
 * Reports onto a compendium item the values extracted from the file / text. The input is not modified.
 * @param {object} data item source (copy of the compendium document)
 * @param {object} facts partial FeaturePlan + `quantity`
 * @returns {{ data: object, adjusted: {field: string, from: any, to: any}[] }}
 */
export function adjustToFacts(data, facts = {}) {
  const out = clone(data);
  const adjusted = [];
  const system = out.system ??= {};
  const acts = system.activities && !Array.isArray(system.activities) ? system.activities : {};
  const list = Object.values(acts);
  const first = type => list.find(a => a.type === type);
  const note = (field, from, to) => adjusted.push({ field, from, to });
  const isWeapon = out.type === "weapon";
  const isSpell = out.type === "spell";

  if (facts.attack && facts.attack.bonus !== undefined && facts.attack.bonus !== null) {
    const a = first("attack");
    if (a) {
      const to = String(facts.attack.bonus);
      const from = a.attack?.flat ? String(a.attack.bonus ?? "") : "";
      if (from !== to) {
        a.attack = { ...(a.attack ?? {}), flat: true, bonus: to };
        note("attack", from || null, to);
      }
    }
  }

  if (facts.damage?.length) {
    const a = first("attack") ?? first("damage");
    if (a) {
      const from = (a.damage?.parts ?? []).map(fromStored);
      if (!sameParts(from, facts.damage)) {
        a.damage = { ...(a.damage ?? {}), parts: facts.damage.map(toStoredPart) };
        if (isWeapon) a.damage.includeBase = false;
        note("damage", showParts(from) || null, showParts(facts.damage));
      }
    }
  }

  if (facts.save) {
    const a = first("save");
    if (a) {
      const abilities = [...(a.save?.ability ?? [])];
      if (facts.save.ability && (abilities.length !== 1 || abilities[0] !== facts.save.ability)) {
        a.save = { ...(a.save ?? {}), ability: [facts.save.ability] };
        note("saveAbility", abilities.join(",") || null, facts.save.ability);
      }
      const dc = String(facts.save.dc ?? "");
      const fromDc = a.save?.dc?.calculation ? null : String(a.save?.dc?.formula ?? "");
      if (dc && fromDc !== dc) {
        a.save = { ...(a.save ?? {}), dc: { calculation: "", formula: dc } };
        note("saveDC", fromDc || null, dc);
      }
      if (facts.save.damage?.length) {
        const from = (a.damage?.parts ?? []).map(fromStored);
        if (!sameParts(from, facts.save.damage)) {
          a.damage = { ...(a.damage ?? {}), parts: facts.save.damage.map(toStoredPart) };
          note("saveDamage", showParts(from) || null, showParts(facts.save.damage));
        }
      }
    }
  }

  if (facts.range) {
    const { reach, value, long } = facts.range;
    if (isWeapon || isSpell) {
      for (const [k, v] of [["reach", reach], ["value", value], ["long", long]]) {
        if (v === null || v === undefined) continue;
        if (Number(system.range?.[k]) !== Number(v)) {
          const range = system.range ??= {};
          note(`range.${k}`, range[k] ?? null, v);
          range[k] = v;
          range.units = "ft";
        }
      }
    } else if (list.length) {
      const v = reach ?? value;
      const a = list[0];
      if (v !== null && v !== undefined && String(a.range?.value ?? "") !== String(v)) {
        note("range", a.range?.value || null, v);
        a.range = { ...(a.range ?? {}), value: String(v), units: "ft" };
      }
    }
  }

  const usesFact = facts.recharge
    ? { max: "1", recovery: [{ period: "recharge", formula: String(facts.recharge.min), type: "recoverAll" }] }
    : facts.uses
      ? { max: String(facts.uses.max), recovery: [{ period: facts.uses.period, type: "recoverAll" }] }
      : null;
  if (usesFact) {
    const uses = system.uses ?? {};
    const fromRec = uses.recovery?.[0];
    const sig = (max, rec) => `${max ?? ""}|${rec?.period ?? ""}|${rec?.period === "recharge" ? rec.formula : ""}`;
    const sigTo = sig(usesFact.max, usesFact.recovery[0]);
    const changed = sig(uses.max, fromRec) !== sigTo;
    if (changed) {
      note("uses", sig(uses.max, fromRec) === "||" ? null : sig(uses.max, fromRec), sigTo);
      system.uses = { ...uses, max: usesFact.max, recovery: usesFact.recovery };
    }
    const a = list[0];
    if (changed && a && !(a.consumption?.targets ?? []).some(t => t.type === "itemUses")) {
      a.consumption = { ...(a.consumption ?? {}), targets: [...(a.consumption?.targets ?? []), { type: "itemUses", target: "", value: "1" }] };
    }
  }

  if (facts.activation?.type) {
    const to = facts.activation.type;
    const cost = facts.activation.cost;
    if (isSpell && list.length === 0) {
      const act = system.activation ??= {};
      if (act.type !== to) { note("activation", act.type ?? null, to); act.type = to; }
    }
    for (const a of list) {
      const costDiffers = cost !== null && cost !== undefined && Number(a.activation?.value) !== Number(cost);
      if (a.activation?.type !== to || costDiffers) {
        const act = a.activation ??= {};
        note("activation", `${act.type ?? ""} ${act.value ?? ""}`.trim() || null, `${to}${cost ? ` ${cost}` : ""}`);
        act.type = to;
        if (cost !== null && cost !== undefined) act.value = cost;
      }
    }
  }

  if (facts.quantity !== undefined && facts.quantity !== null && Number(system.quantity) !== Number(facts.quantity)) {
    note("quantity", system.quantity ?? null, facts.quantity);
    system.quantity = facts.quantity;
  }

  return { data: out, adjusted };
}
