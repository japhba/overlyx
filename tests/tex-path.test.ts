import { describe, expect, it } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { parseTex, writeTex } from '../packages/core/src/tex/index.ts';
import { plainText, walkInsets } from '../packages/core/src/lyx/ast.ts';
import { schema } from '../packages/core/src/schema.ts';
import { inRawText } from '../packages/client/src/editor/rawtext.ts';
import { NO_SPELL_INSETS } from '../packages/client/src/editor/spell/tokenize.ts';
import { LYX_LAYOUTS } from './lyxlib';

const source = (body: string, preamble = '\\usepackage{url}') =>
  `\\documentclass{article}\n${preamble}\n\\begin{document}\n${body}\n\\end{document}\n`;
const parse = (text: string) => parseTex(text, { layoutDir: LYX_LAYOUTS }).doc;
const paths = (text: string) => [...walkInsets(parse(text).body)].map(x => x.inset)
  .filter(i => i.type === 'Text' && i.name === 'Flex' && i.arg === 'Path');

describe('literal file paths in text', () => {
  it('renders braced paths without interpreting TeX punctuation or commands', () => {
    const path = String.raw`C:\data\textbf{raw}_#1%~&$.txt`;
    const src = source(`Before \\path{${path}} after.`);
    const [inset] = paths(src);
    expect(inset?.type).toBe('Text');
    if (inset?.type !== 'Text') throw new Error('missing path inset');
    expect(plainText(inset.paragraphs)).toBe(path);
    expect(inset.paragraphs[0].items.every(i => i.kind === 'text')).toBe(true);
    const out = writeTex(parse(src)).text;
    expect(out).toContain(`Before \\path{${path}} after.`);
    expect(writeTex(parse(out)).text).toBe(out);
  });

  it.each(['|', '!', '+'])('retains %s delimiters and unmatched literal braces', delimiter => {
    const path = String.raw`draft{\data_100%.txt`;
    const src = source(`Before \\path${delimiter}${path}${delimiter} after.`);
    const [inset] = paths(src);
    if (inset?.type !== 'Text') throw new Error('missing path inset');
    expect(plainText(inset.paragraphs)).toBe(path);
    const out = writeTex(parse(src)).text;
    expect(out).toContain(`Before \\path${delimiter}${path}${delimiter} after.`);
    expect(writeTex(parse(out)).text).toBe(out);
  });

  it('supplies the url package and preserves empty paths and trailing backslashes', () => {
    const src = source(String.raw`\path{} and \path{C:\data\}.`, '');
    expect(paths(src)).toHaveLength(2);
    const out = writeTex(parse(src)).text;
    expect(out).toContain('\\usepackage{url}');
    expect(out).toContain(String.raw`\path{} and \path{C:\data\}.`);
    expect(writeTex(parse(out)).text).toBe(out);
  });

  it('keeps drawing commands and user-defined path commands as code', () => {
    for (const body of [String.raw`\path[draw] (0,0) -- (1,1);`, String.raw`\path (0,0) -- (1,1);`, String.raw`\path node {text};`, String.raw`\begin{tikzpicture}\path[draw] (0,0) -- (1,1);\end{tikzpicture}`]) {
      expect(paths(source(body))).toHaveLength(0);
      expect(writeTex(parse(source(body))).text).toContain('\\path');
    }
    expect(paths(source('\\path{custom}', '\\newcommand{\\path}[1]{#1}'))).toHaveLength(0);
    expect(paths(source('\\path|unfinished'))).toHaveLength(0);
  });

  it('keeps path editing literal and excludes it from spell checking', () => {
    const path = schema.nodes.inset.create({ name: 'Flex', arg: 'Path' },
      schema.nodes.paragraph.create({ layout: 'Plain Layout' }, schema.text('a->b')));
    const doc = schema.nodes.doc.create(null, schema.nodes.paragraph.create(null, path));
    const state = EditorState.create({ schema, doc, selection: TextSelection.create(doc, 4) });
    expect(inRawText(state)).toBe(true);
    expect(NO_SPELL_INSETS.has('Flex Path')).toBe(true);
  });
});
