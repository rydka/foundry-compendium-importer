// Canonical facts of a dnd5e document produced by the importer (the "canon(item, actor?)" of the test plan).
// The tokens use the vocabulary of the text-parser library's hand-annotated truth
// (modules/dnd5e-text-parser/tests/fixtures/reference/README.md), so that the same annotations score the
// result of the whole importer (`api.analyze`) in a real Foundry. Pure; no Foundry global.
import { canonDamagePart } from "../../../dnd5e-text-parser/tests/support/canon.mjs";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const signed = (n) => `${n >= 0 ? "+" : ""}${n}`;
const norm = (s) => String(s ?? "").normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim();
const activitiesOf = (item) => Object.values(item?.system?.activities ?? {});
const storedPart = (p) => canonDamagePart({ number: p.number, denomination: p.denomination, bonus: p.bonus, type: [...(p.types ?? [])][0] ?? null });

/** Tokens ("field=value") of the actionable content of one feature-like item. */
export function itemTokens(item) {
  const t = [];
  const acts = activitiesOf(item);
  const system = item?.system ?? {};
  const typed = (type) => acts.find((a) => a.type === type);

  const withActivation = acts.find((a) => a.activation?.type);
  if (withActivation) {
    const cost = Number(withActivation.activation.value);
    t.push(`activation=${withActivation.activation.type}${cost > 1 ? ` ${cost}` : ""}`);
  }

  const attack = typed("attack");
  if (attack) {
    const at = attack.attack ?? {};
    const bonus = Number(String(at.bonus ?? "").replace(/^\+/, ""));
    if (at.flat && Number.isFinite(bonus) && String(at.bonus ?? "") !== "") {
      t.push(`attack=${at.type?.value || "-"}/${at.type?.classification || "-"} ${signed(bonus)}`);
    }
  }
  const rangeOwner = attack ?? typed("save") ?? typed("damage") ?? acts[0];
  const range = rangeOwner?.range;
  if (item?.type === "weapon" && system.range) {
    // a weapon keeps its range on the item
    const { reach, value, long } = system.range;
    if (Number(reach)) t.push(`range=reach ${Number(reach)}`);
    if (Number(value)) t.push(`range=range ${Number(value)}${Number(long) ? `/${Number(long)}` : ""}`);
  } else if (range && String(range.value ?? "") !== "" && range.units === "ft") {
    const melee = attack?.attack?.type?.value === "melee";
    t.push(`range=${melee ? "reach" : "range"} ${Number(range.value)}`);
  }
  const owner = acts.find((a) => String(a.target?.affects?.count ?? "") !== "" && a.type !== "utility");
  if (owner) t.push(`target=${owner.target.affects.count} ${owner.target.affects.type || "target"}`);

  const dmgOwner = attack ?? typed("damage");
  for (const p of dmgOwner?.damage?.parts ?? []) if (p.number || p.bonus) t.push(`damage=${storedPart(p)}`);
  const save = typed("save");
  if (save && [...(save.save?.ability ?? [])].length) {
    const dc = save.save?.dc?.formula;
    if (String(dc ?? "") !== "") t.push(`save=${[...save.save.ability][0]} ${dc} ${save.damage?.onSave || "none"}`);
    for (const p of save.damage?.parts ?? []) t.push(`saveDamage=${storedPart(p)}`);
  }
  const tpl = acts.map((a) => a.target?.template).find((x) => x?.type);
  if (tpl) t.push(`template=${tpl.type} ${Number(tpl.size)}${tpl.width ? `x${Number(tpl.width)}` : ""}`);

  // B9: a conditional / alternative result is a second activity of the same kind (one "variant" group per extra activity)
  const main = new Set([attack, save, typed("damage")].filter(Boolean));
  for (const a of acts) {
    if (main.has(a) || !["attack", "save", "damage"].includes(a.type) || !a.name) continue;
    t.push("variant=activity");
    if (a.type === "attack") {
      const at = a.attack ?? {};
      const b = Number(String(at.bonus ?? "").replace(/^[+]/, ""));
      if (at.flat && Number.isFinite(b) && String(at.bonus ?? "") !== "") t.push(`variant.attack=${at.type?.value || "-"}/${at.type?.classification || "-"} ${signed(b)}`);
    }
    if (a.type === "save") {
      const dc = a.save?.dc?.formula;
      if ([...(a.save?.ability ?? [])].length && String(dc ?? "") !== "") t.push(`variant.save=${[...a.save.ability][0]} ${dc} ${a.damage?.onSave || "none"}`);
      for (const p of a.damage?.parts ?? []) t.push(`variant.saveDamage=${storedPart(p)}`);
    } else {
      for (const p of a.damage?.parts ?? []) if (p.number || p.bonus) t.push(`variant.damage=${storedPart(p)}`);
    }
  }

  const lr = system.identifier === "legendary-resistance";
  const rec = system.uses?.recovery?.[0];
  if (lr) {
    if (acts.some((a) => a.activation?.type === "special")) t.push("legendaryResistance=yes");
  } else if (rec?.period === "recharge") {
    t.push(`recharge=${Number(rec.formula)}`);
  } else if (String(system.uses?.max ?? "") !== "" && rec?.period) {
    t.push(`uses=${Number(system.uses.max)}/${rec.period}`);
  }
  return t;
}

/** Tokens of the trait lines and legendary counters of an actor. */
export function actorTokens(actor) {
  const t = [];
  const r = actor?.system?.resources ?? {};
  if (Number(r.legact?.max) > 0) t.push(`legact=${Number(r.legact.max)}`);
  if (Number(r.legres?.max) > 0) t.push(`legres=${Number(r.legres.max)}`);
  for (const k of ["dr", "di", "dv", "ci"]) {
    const tr = actor?.system?.traits?.[k] ?? {};
    [...(tr.value ?? [])].forEach((v) => t.push(`${k}.values=${v}`));
    [...(tr.bypasses ?? [])].forEach((v) => t.push(`${k}.bypasses=${v}`));
    String(tr.custom ?? "").split(";").map((s) => s.trim()).filter(Boolean).forEach((v) => t.push(`${k}.custom=${norm(v)}`));
  }
  return t;
}

/** Multiset difference a \ b. */
export function minus(a, b) {
  const pool = new Map();
  for (const x of b) pool.set(x, (pool.get(x) ?? 0) + 1);
  const out = [];
  for (const x of a) {
    const n = pool.get(x) ?? 0;
    if (n > 0) pool.set(x, n - 1); else out.push(x);
  }
  return out;
}

/** Every non-empty leaf of `before` (path -> value) that is absent or different in `after`. */
export function changedLeaves(before, after, path = "") {
  const out = [];
  if (isObj(before)) {
    for (const [k, v] of Object.entries(before)) out.push(...changedLeaves(v, after?.[k], path ? `${path}.${k}` : k));
  } else if (Array.isArray(before)) {
    if (!before.length) return out;
    before.forEach((v, i) => out.push(...changedLeaves(v, after?.[i], `${path}[${i}]`)));
  } else if (before !== undefined && before !== null && before !== "") {
    if (JSON.stringify(before) !== JSON.stringify(after)) out.push({ path, before, after });
  }
  return out;
}
