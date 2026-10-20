/**
 * Deterministic document identifiers: the same PDF gives the same `_id`s on every import (C6), so a second import
 * into the same compendium is a "replace" conflict instead of a duplicate.
 *
 * Seed convention: `"<page>|<name>|<rank>"` for an actor (`|item` appended for a magic item), where `rank` is the
 * rank of the block or item among those of the same name on the same page (two "Sword +1" on one page get two ids).
 * The file name is deliberately not part of the seed: renaming the PDF keeps the ids, so a new import of the same
 * book still replaces instead of duplicating. The price is that two different books with the same creature name
 * on the same page number give the same id, which the review shows as a "replace" conflict (never silent).
 * Embedded items are seeded on the actor's seed, the item name and its rank in the block.
 */

const ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const ID_LENGTH = 16;

/** FNV-1a, 32 bits. */
export function fnv1a(text) {
  let hash = 0x811c9dc5;
  for ( const char of String(text) ) {
    const code = char.codePointAt(0);
    hash ^= code & 0xff;
    hash = Math.imul(hash, 0x01000193) >>> 0;
    if ( code > 0xff ) {
      hash ^= code >>> 8;
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
  }
  return hash >>> 0;
}

/**
 * 16 alphanumeric characters drawn from the hash of a seed (`"<file>|<page>|<name>|<rank>"`).
 * @param {string} seed
 * @returns {string}
 */
export function stableId(seed) {
  let out = "";
  let hash = fnv1a(seed);
  for ( let i = 0; i < ID_LENGTH; i++ ) {
    hash = fnv1a(`${seed}|${i}|${hash}`);
    out += ALPHABET[hash % ALPHABET.length];
  }
  return out;
}
