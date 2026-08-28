// @vitest-environment happy-dom
/**
 * Copy & paste inside the editor goes through the schema's toDOM / parseDOM (ProseMirror puts
 * HTML on the clipboard and parses it back): every node kind must survive that round trip with
 * all its attributes — a citation, a cross-reference, a table or a figure pasted elsewhere in the
 * document must still be the same inset. Foreign HTML (a web page) becomes sensible LyX content.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { DOMParser as PMDOMParser, DOMSerializer, Node as PMNode } from 'prosemirror-model';
import { schema } from '../packages/core/src/schema.ts';
import { parseLyx } from '../packages/core/src/lyx/parser.ts';
import { lyxToPm, pmToLyxBody } from '../packages/core/src/convert.ts';
import { writeParagraphs } from '../packages/core/src/lyx/writer.ts';

const serializer = DOMSerializer.fromSchema(schema);
const parser = PMDOMParser.fromSchema(schema);

function roundTrip(doc: PMNode): PMNode {
  const frag = serializer.serializeFragment(doc.content, { document });
  const div = document.createElement('div');
  div.appendChild(frag);
  const html = div.innerHTML;
  const dom = new window.DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  return parser.parse(dom.body, { preserveWhitespace: true });
}

function pmDoc(lyx: string): PMNode {
  return PMNode.fromJSON(schema, lyxToPm(parseLyx(lyx)));
}

const HEAD = `#LyX 2.5 created this file. For more info see https://www.lyx.org/
\\lyxformat 643
\\begin_document
\\begin_header
\\textclass article
\\end_header

\\begin_body
`;
const TAIL = `
\\end_body
\\end_document
`;

const SYNTH = HEAD + `
\\begin_layout Section
Intro
\\begin_inset CommandInset label
LatexCommand label
name "sec:intro"

\\end_inset


\\end_layout

\\begin_layout Standard
See
\\begin_inset CommandInset ref
LatexCommand ref
reference "sec:intro"
plural "false"
caps "false"
noprefix "false"
nolink "false"

\\end_inset

 and
\\begin_inset CommandInset citation
LatexCommand citep
key "Hubel59,Hubel62"
literal "false"

\\end_inset

, a formula
\\begin_inset Formula $E=mc^{2}$
\\end_inset

,
\\begin_inset Quotes eld
\\end_inset

quoted
\\begin_inset Quotes erd
\\end_inset

,
\\begin_inset space ~
\\end_inset

a
\\begin_inset space \\hspace{}
\\length 2cm
\\end_inset

space,
\\emph on
emphasised
\\emph default
 and
\\series bold
bold
\\series default
 text
\\begin_inset Foot
status collapsed

\\begin_layout Plain Layout
a footnote with
\\begin_inset Formula $x$
\\end_inset


\\end_layout

\\end_inset

.
\\begin_inset Newline newline
\\end_inset

Next line
\\begin_inset SpecialChar ldots
\\end_inset


\\end_layout

\\begin_layout Standard
\\begin_inset Float figure
placement h
alignment document
wide false
sideways false
status open

\\begin_layout Plain Layout
\\align center
\\begin_inset Graphics
	filename fig.png
	width 50col%

\\end_inset


\\end_layout

\\begin_layout Plain Layout
\\begin_inset Caption Standard

\\begin_layout Plain Layout
A figure.
\\begin_inset CommandInset label
LatexCommand label
name "fig:a"

\\end_inset


\\end_layout

\\end_inset


\\end_layout

\\end_inset


\\end_layout

\\begin_layout Standard
\\begin_inset Tabular
<lyxtabular version="3" rows="2" columns="2">
<features tabularvalignment="middle">
<column alignment="center" valignment="top">
<column alignment="center" valignment="top">
<row>
<cell alignment="center" valignment="top" topline="true" bottomline="true" leftline="true" usebox="none">
\\begin_inset Text

\\begin_layout Plain Layout
a
\\end_layout

\\end_inset
</cell>
<cell alignment="center" valignment="top" topline="true" bottomline="true" leftline="true" rightline="true" usebox="none">
\\begin_inset Text

\\begin_layout Plain Layout
b
\\end_layout

\\end_inset
</cell>
</row>
<row>
<cell multicolumn="1" alignment="center" valignment="top" bottomline="true" leftline="true" rightline="true" usebox="none">
\\begin_inset Text

\\begin_layout Plain Layout
wide
\\end_layout

\\end_inset
</cell>
<cell multicolumn="2" alignment="center" valignment="top" bottomline="true" leftline="true" rightline="true" usebox="none">
\\begin_inset Text

\\begin_layout Plain Layout

\\end_layout

\\end_inset
</cell>
</row>
</lyxtabular>

\\end_inset


\\end_layout

\\begin_layout Standard
\\begin_inset FormulaMacro
\\newcommand{\\R}{\\mathbb{R}}
\\end_inset


\\begin_inset VSpace bigskip
\\end_inset


\\begin_inset Newpage clearpage
\\end_inset


\\end_layout

\\begin_layout Standard
\\begin_inset Formula
\\begin{equation}
a=b\\label{eq:ab}
\\end{equation}

\\end_inset


\\end_layout
` + TAIL;

describe('clipboard round trip (toDOM → parseDOM)', () => {
  it('every inset kind of a synthetic document survives', () => {
    const doc = pmDoc(SYNTH);
    const back = roundTrip(doc);
    expect(back.toJSON()).toEqual(doc.toJSON());
    // and the LyX text is identical too
    expect(writeParagraphs(pmToLyxBody(back.toJSON() as never))).toBe(writeParagraphs(pmToLyxBody(doc.toJSON() as never)));
  });

  const papers = ['/root/projects/recurrent_feature/main.lyx', '/root/projects/bayesian_chaos/main.lyx', '/root/lyx/lib/doc/UserGuide.lyx'].filter(existsSync);
  it.each(papers)('a real document survives: %s', (file) => {
    const doc = pmDoc(readFileSync(file, 'utf8'));
    const back = roundTrip(doc);
    expect(back.nodeSize).toBe(doc.nodeSize);
    expect(writeParagraphs(pmToLyxBody(back.toJSON() as never))).toBe(writeParagraphs(pmToLyxBody(doc.toJSON() as never)));
  });
});

describe('pasting foreign HTML', () => {
  const parseHtml = (html: string) => parser.parse(new window.DOMParser().parseFromString(`<body>${html}</body>`, 'text/html').body, { preserveWhitespace: true });

  it('headings, emphasis, lists and tables become LyX layouts, font attributes and a tabular', () => {
    const doc = parseHtml('<h2>A title</h2><p>Some <b>bold</b>, <i>italic</i> and <code>mono</code> text<br>next line</p><ul><li>one</li><li>two</li></ul><table><tr><th>h1</th><th>h2</th></tr><tr><td>1</td><td colspan="2">2</td></tr></table>');
    const pars = pmToLyxBody(doc.toJSON() as never);
    expect(pars[0].layout).toBe('Subsection');
    const text = writeParagraphs(pars);
    expect(text).toContain('\\series bold\nbold');
    expect(text).toContain('\\emph on\nitalic');
    expect(text).toContain('\\family typewriter\nmono');
    expect(text).toContain('\\begin_inset Newline newline');
    expect(pars.filter(p => p.layout === 'Itemize').length).toBe(2);
    expect(text).toContain('<lyxtabular version="3" rows="2" columns="3">');   // the colspan makes it three columns
    expect(text).toContain('<column alignment="center" valignment="top">');
    expect(text).toContain('multicolumn="1"');
    // and what came out is a valid, re-parseable document body
    const again = parseLyx(HEAD + text + TAIL);
    expect(writeParagraphs(again.body)).toBe(text);
  });
});
