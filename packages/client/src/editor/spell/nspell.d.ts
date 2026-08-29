declare module 'nspell' {
  interface NSpell {
    correct(word: string): boolean;
    suggest(word: string): string[];
    add(word: string): NSpell;
    remove(word: string): NSpell;
    personal(dic: string): NSpell;
    dictionary(dic: string): NSpell;
  }
  function nspell(aff: string | { aff: string; dic: string }, dic?: string): NSpell;
  export default nspell;
}
