// M7: 500 deterministic `feat` documents built from real and synthetic feature texts (names suffixed).
// Texts: the feats of tools/out/items.json that have a formulation, plus EN/FR synthetic ones. Extra texts
// (e.g. the reference set of dnd5e-text-parser) can be passed in.
import { readFileSync } from "node:fs";

const SYNTHETIC = [
  "Melee Weapon Attack: +6 to hit, reach 5 ft., one target. Hit: 7 (1d4 + 4) bludgeoning damage.",
  "Ranged Weapon Attack: +8 to hit, range 80/320 ft., one target. Hit: 9 (2d4 + 4) piercing damage plus 7 (2d6) poison damage.",
  "Each creature in a 15-foot cone must make a DC 13 Wisdom saving throw, taking 18 (4d8) necrotic damage on a failed save, or half as much damage on a successful one. (Recharge 5-6)",
  "Attaque d'arme au corps à corps : +6 au toucher, allonge 1,50 m, une cible. Touché : 7 (1d4 + 4) dégâts contondants.",
  "Chaque créature dans un cône de 4,50 m doit réussir un jet de sauvegarde de Sagesse DD 13, sinon elle subit 18 (4d8) dégâts nécrotiques, ou la moitié en cas de réussite. (Recharge 5-6)",
  "The creature can use this ability 3/Day. It regains all uses after a Long Rest.",
  "The creature has advantage on saving throws against being charmed."
];

export function makeItems500(extraTexts = [], root = new URL("../../", import.meta.url)) {
  const real = JSON.parse(readFileSync(new URL("tools/out/items.json", root), "utf8"))
    .filter((i) => i.type === "feat" && /to hit|saving throw|Recharge|\/Day/i.test(i.system?.description?.value ?? ""))
    .map((i) => i.system.description.value);
  const texts = [...real, ...SYNTHETIC, ...extraTexts.map((t) => `<p>${t}</p>`)];
  const html = (t) => (t.startsWith("<") ? t : `<p><strong>X.</strong> ${t}</p>`);
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  return Array.from({ length: 500 }, (_, n) => {
    const text = html(texts[n % texts.length]);
    return {
      _id: `ITEM${String(n).padStart(12, "0")}`.slice(0, 16), name: `Feature ${n} ${alphabet[n % 62]}`, type: "feat",
      system: { description: { value: text }, activities: n % 2 ? { [`ACT${String(n).padStart(13, "0")}`]: { _id: `ACT${String(n).padStart(13, "0")}`, type: "utility", name: "", activation: { type: "action", value: 1, condition: "" } } } : {} }
    };
  });
}
