/**
 * OverLyX only names open fonts: no font stack in the app, its templates or its pages lists a proprietary
 * face (Helvetica, Arial, Georgia, Times New Roman, Courier New, Menlo, Consolas, Calibri, Segoe UI,
 * Palatino, …) — the owner, 3 Nov 2026. A stack ends in a generic family (sans-serif, serif, monospace)
 * after its bundled or open faces. Prose that only mentions a face (an editor font's hint "a Times",
 * LaTeX's psnfss names, which TeX Live sets in open URW clones) is fine. starters-legacy keeps the
 * starters exactly as they shipped, to recognise untouched copies; scientific-fonts.ts is font data.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const NAMES = ['Arial Black', 'Helvetica Neue', 'Segoe UI', 'Apple Color Emoji', 'Times New Roman', 'Courier New', 'Century Gothic', 'Iowan Old Style',
  'Palatino Linotype', 'Book Antiqua', 'Lucida Grande', 'Lucida Console', 'Helvetica', 'Arial', 'Verdana', 'Tahoma', 'Georgia', 'Menlo', 'Consolas',
  'Monaco', 'Courier', 'Calibri', 'Cambria', 'Futura', 'Palatino'];
const NAME = new RegExp(`(?<![\\w-])(?:${NAMES.join('|')})(?![\\w-])`);
/** a line that sets a font: a declaration, an attribute, a canvas font or a stack ending in a generic family */
const FONT_CONTEXT = /font(?:-family)?\s*[:=]|fontFamily|\bfont\s*=|css:\s*['"]|[\s,'"](?:sans-serif|serif|monospace)\b|SERIF\s*=|MONO\s*=/;

describe('open fonts only', () => {
  it('no font stack names a proprietary face', () => {
    const files = execFileSync('git', ['ls-files', 'packages', 'scripts'], { cwd: ROOT, encoding: 'utf8' })
      .split('\n').filter(f => /\.(ts|tsx|js|mjs|css|html)$/.test(f) && !/\/(node_modules|dist|starters-legacy)\//.test(f) && !f.endsWith('scientific-fonts.ts'));
    const hits: string[] = [];
    for (const f of files) {
      readFileSync(join(ROOT, f), 'utf8').split('\n').forEach((raw, i) => {
        const line = raw.replace(/base64,[A-Za-z0-9+/=]+/g, 'base64,');
        if (FONT_CONTEXT.test(line) && NAME.test(line) && !/^\s*(\*|\/\/|\/\*)/.test(line)) hits.push(`${f}:${i + 1}: ${line.trim().slice(0, 140)}`);
      });
    }
    expect(hits).toEqual([]);
  });
});
