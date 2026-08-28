/**
 * Blank parameter lines in text insets: LyX never writes them and its lexer ignores them. The
 * parser drops them and the writer never emits them (an inset-settings dialog once produced
 * params [''] for a note, which came back as a blank line before `status` and broke the byte-exact
 * round trip of that document).
 */
import { describe, it, expect } from 'vitest';
import { parseLyx, writeLyx, walkInsets } from '../packages/core/src/index.ts';

const HEAD = `#LyX 2.5 created this file. For more info see https://www.lyx.org/
\\lyxformat 643
\\begin_document
\\begin_header
\\save_transient_properties true
\\origin unavailable
\\textclass article
\\end_header

\\begin_body
`;
const canonical = `${HEAD}
\\begin_layout Standard
Text
\\begin_inset Note Note
status collapsed

\\begin_layout Plain Layout
A note.
\\end_layout

\\end_inset

 more.
\\end_layout

\\end_body
\\end_document
`;

describe('blank parameter lines in text insets', () => {
  it('a blank line before status is dropped on read and never written back', () => {
    const odd = canonical.replace('\\begin_inset Note Note\nstatus collapsed', '\\begin_inset Note Note\n\nstatus collapsed');
    expect(odd).not.toBe(canonical);
    const doc = parseLyx(odd);
    expect(writeLyx(doc)).toBe(canonical);
    expect(writeLyx(parseLyx(canonical))).toBe(canonical);
  });
  it('an inset whose params contain an empty string still writes canonically', () => {
    const doc = parseLyx(canonical);
    const [{ inset }] = [...walkInsets(doc.body)];
    (inset as any).params = [''];
    expect(writeLyx(doc)).toBe(canonical);
  });
});
