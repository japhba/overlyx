/**
 * Collector of LaTeX requirements while the body is generated — a small
 * counterpart of src/LaTeXFeatures.cpp.
 */
import type { DocumentClass } from './layouts.ts';

export class Features {
  private required = new Set<string>();
  private snippets: string[] = [];
  readonly usedLayouts: string[] = [];
  readonly usedInsetLayouts: string[] = [];
  /** float type → uses subfloats */
  readonly usedFloats = new Map<string, boolean>();
  /** babel names of languages used other than the document language */
  readonly usedLanguages = new Map<string, { babel: string; polyglossia: string; polyglossiaOpts: string }>();
  readonly fontEncodings: string[] = [];

  constructor(readonly dc: DocumentClass) {}

  require(name: string | string[]): void {
    if (Array.isArray(name)) { for (const n of name) this.require(n); return; }
    if (!name) return;
    if (name.includes(',')) { for (const n of name.split(',')) this.require(n.trim()); return; }
    this.required.add(name);
  }

  isRequired(name: string): boolean { return this.required.has(name); }

  isProvided(name: string): boolean { return this.dc.provides.has(name); }

  mustProvide(name: string): boolean { return this.required.has(name) && !this.dc.provides.has(name); }

  addPreambleSnippet(s: string): void { if (!this.snippets.includes(s)) this.snippets.push(s); }

  get preambleSnippets(): string[] { return this.snippets; }

  /** LaTeXFeatures::useLayout: a layout whose preamble builds on another one (theorems-ams: \newtheorem{prop}[thm] needs Theorem's thm) pulls that one in first. */
  useLayout(name: string): void {
    if (this.usedLayouts.includes(name)) return;
    const st = this.dc.styles.get(name);
    if (st?.dependsOn && st.dependsOn !== name) { this.useLayout(st.dependsOn); if (this.usedLayouts.includes(name)) return; }
    this.usedLayouts.push(name);
    if (st?.dependsOn) { const dep = this.dc.styles.get(st.dependsOn); if (dep) for (const r of dep.requires) this.require(r); }
  }

  useInsetLayout(name: string): void { if (!this.usedInsetLayouts.includes(name)) this.usedInsetLayouts.push(name); }

  useFloat(type: string, subfloat = false): void {
    this.usedFloats.set(type, (this.usedFloats.get(type) ?? false) || subfloat);
  }

  addFontEncoding(enc: string): void { if (!this.fontEncodings.includes(enc)) this.fontEncodings.push(enc); }

  /** Resolve "a|b" alternatives: keep an alternative already required, else pick the first allowed one. */
  resolveAlternatives(allowed: (name: string) => boolean): void {
    for (const r of [...this.required]) {
      if (!r.includes('|')) continue;
      this.required.delete(r);
      const alts = r.split('|');
      if (alts.some(a => this.required.has(a) || this.isProvided(a))) continue;
      const pick = alts.find(allowed) ?? alts[0];
      this.required.add(pick);
    }
  }

  get all(): string[] { return [...this.required]; }

  /** The same requirements against a class that additionally provides `extra` (tex mode: the user's preamble). */
  withProvides(extra: Set<string>): Features {
    const dc = { ...this.dc, provides: new Set([...this.dc.provides, ...extra]) };
    const f = new Features(dc);
    for (const r of this.required) f.required.add(r);
    f.snippets.push(...this.snippets);
    f.usedLayouts.push(...this.usedLayouts);
    f.usedInsetLayouts.push(...this.usedInsetLayouts);
    for (const [k, v] of this.usedFloats) f.usedFloats.set(k, v);
    for (const [k, v] of this.usedLanguages) f.usedLanguages.set(k, v);
    f.fontEncodings.push(...this.fontEncodings);
    return f;
  }
}
