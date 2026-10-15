/**
 * Challenge rating read from the text of an actor (C25), pure and synchronous.
 * "Challenge 17 (18,000 XP)" or "Facteur de puissance 17 (18 000 PX)" in the biography or in the description
 * of an item of the actor gives `system.details.cr` when the file does not have it.
 */

const FRACTIONS = { "1/8": 0.125, "1/4": 0.25, "1/2": 0.5, "⅛": 0.125, "¼": 0.25, "½": 0.5 };
const VALUE = "(\\d+\\s*/\\s*\\d+|[⅛¼½]|\\d+(?:[.,]\\d+)?)";
const XP = "\\(\\s*[\\d\\s,.\\u00a0\\u202f]*(?:XP|PX)\\s*\\)";
const PATTERNS = [
  new RegExp(`\\bChallenge(?:\\s+Rating)?\\s*:?\\s*${VALUE}\\s*${XP}`, "i"),
  new RegExp(`\\bFacteur\\s+de\\s+puissance\\s*:?\\s*${VALUE}`, "i"),
  new RegExp(`\\bFP\\s*:?\\s*${VALUE}\\s*${XP}`, "i")
];
const TAGS = /<[^>]*>/g;

/** "1/2", "½", "17", "0,5" -> number, or null. */
export function parseChallengeValue(raw) {
  const s = String(raw ?? "").replace(/\s+/g, "").replace(",", ".");
  if (s in FRACTIONS) return FRACTIONS[s];
  const fraction = /^(\d+)\/(\d+)$/.exec(s);
  if (fraction) return Number(fraction[2]) ? Number(fraction[1]) / Number(fraction[2]) : null;
  const n = Number(s);
  return s && Number.isFinite(n) && n >= 0 ? n : null;
}

/** First challenge rating stated in a text (HTML allowed), or null. */
export function parseChallengeRating(text) {
  const plain = String(text ?? "").replace(TAGS, " ");
  for (const pattern of PATTERNS) {
    const m = pattern.exec(plain);
    if (!m) continue;
    const value = parseChallengeValue(m[1]);
    if (value !== null) return value;
  }
  return null;
}

/** Texts of a raw actor that may state its challenge rating: biography first, then the item descriptions. */
export function challengeTextsOf(actor) {
  const biography = actor?.system?.details?.biography ?? {};
  const texts = [biography.value, biography.public];
  for (const item of actor?.items ?? []) texts.push(item?.system?.description?.value);
  return texts.filter(t => typeof t === "string" && t.trim());
}

/** Challenge rating of a raw actor from its texts, or null. */
export function challengeRatingOf(actor) {
  for (const text of challengeTextsOf(actor)) {
    const value = parseChallengeRating(text);
    if (value !== null) return value;
  }
  return null;
}

/** 0.125 -> "1/8", 17 -> "17" (for the summary). */
export function formatChallengeRating(value) {
  const fraction = Object.entries(FRACTIONS).find(([k, v]) => v === value && k.includes("/"));
  return fraction ? fraction[0] : String(value);
}
