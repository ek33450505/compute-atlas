/**
 * A–Z paging for the long hub index pages (/operators, /counties).
 *
 * The index is split by first letter and selected with `?letter=`, the way
 * /table pages through `?page=`. Every letter is a plain link, so every detail
 * page stays reachable from the index without JavaScript.
 */

/** Bucket for names that do not start with A–Z (digits, symbols). */
export const OTHER_LETTER = "other";

export const LETTERS: readonly string[] = [
  ..."abcdefghijklmnopqrstuvwxyz",
  OTHER_LETTER,
];

/**
 * Validates a raw `?letter=` value. Returns a lowercase bucket (`a`–`z` or
 * `other`), or `null` for a missing, repeated, or unrecognised value so the
 * caller falls back to the default view rather than erroring.
 */
export function parseLetter(raw: string | string[] | undefined): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim().toLowerCase();
  return LETTERS.includes(value) ? value : null;
}

/**
 * The bucket a name sorts under: its first letter or digit, with diacritics
 * folded ("Émile" -> `e`), or `other` when that character is not A–Z. Leading
 * punctuation and whitespace are skipped, so "(Acme)" sorts under `a`.
 */
export function letterOf(name: string): string {
  for (const ch of name.normalize("NFD")) {
    if (/[\p{L}\p{N}]/u.test(ch)) {
      const lower = ch.toLowerCase();
      return /^[a-z]$/.test(lower) ? lower : OTHER_LETTER;
    }
  }
  return OTHER_LETTER;
}

/** Display form of a bucket: `C`, or "0–9 & other". */
export function letterLabel(letter: string): string {
  return letter === OTHER_LETTER ? "0–9 & other" : letter.toUpperCase();
}

/** Letters that hold at least one name, as a set. */
export function lettersInUse(names: Iterable<string>): Set<string> {
  const used = new Set<string>();
  for (const name of names) used.add(letterOf(name));
  return used;
}
