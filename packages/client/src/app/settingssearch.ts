/**
 * Settings' search box (app/Settings.tsx): what a query finds. Every word typed must occur — in a
 * section's name and its keywords (which sections to offer), or in a setting row's text (which rows
 * of the open section to mark). Case and accents do not matter; a word may be the start of one
 * ("calib" finds the calibration).
 */

/** the words of a query, folded */
export function queryTerms(query: string): string[] {
  return fold(query).split(/\s+/).filter(Boolean);
}

/** lower case without accents, so "colour" ≈ "Colour" and "creme" finds "crème" */
export function fold(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** does a text hold every term? */
export function matchesAll(terms: string[], text: string): boolean {
  if (!terms.length) return false;
  const hay = fold(text);
  return terms.every(t => hay.includes(t));
}

/** a section to search: where it is, and the words it is found by */
export interface SearchableSection<S extends string = string, I extends string = string> { scope: S; id: I; label: string; words: string }

/** the sections a query finds, in the order given (the scope shown first is the caller's to arrange) */
export function findSections<T extends SearchableSection>(query: string, sections: T[]): T[] {
  const terms = queryTerms(query);
  return terms.length ? sections.filter(s => matchesAll(terms, s.label + ' ' + s.words)) : [];
}
