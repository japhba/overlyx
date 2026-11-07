/**
 * Arrows typed as text become arrows (the user, 7 Nov 2026: "make -> and <- always render as a proper
 * arrow, same for --> and <--"): -> →, <- ←, --> ⟶, <-- ⟵, and the double-headed <-> ↔, <--> ⟷ that
 * the same keys make on the way — also after a dash the keyboard made of -- (iPad's smart punctuation:
 * —> is ⟶). One rule table for documents (client editor/plugins/arrows.ts) and the text retyped on
 * slides (deliverable/runtime/arrows.ts).
 */

/** the text before the caret, ending with the character just typed → the arrow it makes (longest first) */
export const ARROW_RULES: [RegExp, string][] = [
  [/(?:⟵|←-|<--|<–|<—)>$/, '⟷'],
  [/(?:←|<-)>$/, '↔'],
  [/(?:--|–|—)>$/, '⟶'],
  [/->$/, '→'],
  [/(?:←|<-)-$/, '⟵'],
  [/<-$/, '←'],
];
export const ARROWS = new Set(ARROW_RULES.map(([, a]) => a));

/** the arrow the text before the caret makes with `typed` after it, and how many characters (the typed one included) it replaces */
export function arrowFor(before: string, typed: string): { arrow: string; length: number } | null {
  if (typed !== '>' && typed !== '-') return null;
  const s = before + typed;
  for (const [re, arrow] of ARROW_RULES) {
    const m = re.exec(s);
    if (m) return { arrow, length: m[0].length };
  }
  return null;
}
