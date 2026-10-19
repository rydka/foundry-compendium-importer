/**
 * Deterministic document identifiers: the same PDF gives the same `_id`s on every import (C6), so a second import
 * into the same compendium is a "replace" conflict instead of a duplicate.
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
