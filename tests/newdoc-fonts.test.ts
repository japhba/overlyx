/**
 * A new LaTeX document keeps TeX's default fonts until its author chooses others (the owner, 7 Nov
 * 2026; CLAUDE.md): the article template, any class, a title block and the account's paragraph
 * separation name no font — not Anodyne, OverLyX's own sans-serif, nor any other.
 */
import { describe, it, expect } from 'vitest';
import { newDocumentText } from '../packages/core/src/newdoc.ts';
import { withDocumentSettings, NO_INDENT_SETTINGS } from '../packages/server/src/texdoc.ts';

const FONT = /\\(?:setmainfont|setsansfont|setmonofont|setmathfont|fontspec|olmainfont|olfontset|olfont)\b|\\usepackage(?:\[[^\]]*\])?\{[^}]*\b(?:fontspec|unicode-math|lmodern|libertinus|newtx\w*|mathptmx|mathpazo|helvet|times|palatino|noto\w*|FiraSans|firamath\w*|lato|sfmath|sansmath|kpfonts|fourier|tgtermes|tgpagella|Anodyne|anodyne)\b/;

describe('new .tex documents', () => {
  it('name no font: TeX’s defaults (Computer Modern) until the author chooses', () => {
    for (const text of [
      newDocumentText(),
      newDocumentText({ textclass: 'report', title: 'A title', author: 'Ada' }),
      withDocumentSettings(newDocumentText({ title: 'x' }), 'ada/notes', 'x.tex', NO_INDENT_SETTINGS),
    ]) {
      expect(text).not.toMatch(FONT);
      expect(text).not.toMatch(/anodyne/i);
    }
  });
});
