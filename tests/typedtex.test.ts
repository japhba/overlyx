/**
 * LaTeX typed in a LaTeX document's text (packages/client/src/editor/plugins/typedtex.ts): a
 * finished command becomes what it means once the caret leaves it — parsed as pasted LaTeX is (here
 * by core's parser itself, the server's /clip does the same), a heading alone in its paragraph, a
 * command without arguments at the space after it. Typed the way the view would: handleTextInput
 * first, else the character inserted; the plugin's view sees every update.
 */
import { describe, it, expect, vi } from 'vitest';
import { EditorState, TextSelection, type Transaction } from 'prosemirror-state';
import { schema, lyxToPm } from '../packages/core/src/index.ts';
import { parseTex } from '../packages/core/src/tex/index.ts';
import { LYX_LAYOUTS } from './lyxlib.ts';

const parsed = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock('../packages/client/src/api', () => ({
  API_BASE: '',
  api: {
    parseClip: async (_id: string, latex: string) => {
      parsed.calls.push(latex);
      const r = parseTex(latex, { layoutDir: LYX_LAYOUTS, localDirs: [], readFile: () => null, masterHeader: ['\\documentclass{article}'] } as never);
      return { blocks: (lyxToPm(r.doc) as { content?: unknown[] }).content ?? [], warnings: [] };
    },
  },
}));
const { typedTexPlugin, commandRunAt, insideOpenGroup } = await import('../packages/client/src/editor/plugins/typedtex.ts');

function setup(docId = 'jan/paper/main.tex', text = '') {
  const plugin = typedTexPlugin();
  const par = schema.nodes.paragraph.create({ layout: 'Standard' }, text ? [schema.text(text)] : []);
  let state = EditorState.create({ doc: schema.nodes.doc.create(null, [par]), plugins: [plugin] });
  state = state.apply(state.tr.setSelection(TextSelection.atEnd(state.doc)));
  const view = {
    state, isDestroyed: false, composing: false, dom: { dataset: { docId } },
    dispatch(tr: Transaction) { const prev = view.state; view.state = view.state.apply(tr); pv.update!(view as never, prev); },
  };
  const pv = plugin.spec.view!(view as never);
  const type = (chars: string) => {
    for (const ch of chars) {
      const { from, to } = view.state.selection;
      if (!plugin.props.handleTextInput!.call(plugin, view as never, from, to, ch, () => view.state.tr)) view.dispatch(view.state.tr.insertText(ch, from, to));
    }
  };
  return { view, type };
}
const settle = async () => { for (let i = 0; i < 4; i++) await new Promise(r => setTimeout(r, 0)); };
const json = (view: { state: EditorState }) => view.state.doc.toJSON().content as { attrs: { layout: string }; content?: { type: string; text?: string; marks?: { type: string }[]; attrs?: Record<string, unknown> }[] }[];

describe('typed LaTeX commands', () => {
  it('finds the finished command before the caret', () => {
    expect(commandRunAt('see \\textbf{bold}', 17)).toBe(4);
    expect(commandRunAt('\\href{u}{t}', 11)).toBe(0);
    expect(commandRunAt('\\section[S]{Long}', 17)).toBe(0);
    expect(commandRunAt('\\textbf{a {b} c}', 16)).toBe(0);
    expect(commandRunAt('\\\\textbf{x}', 11)).toBe(null);   // a line break, then a word
    expect(commandRunAt('a \\{b\\}', 7)).toBe(null);
    expect(commandRunAt('plain {x}', 9)).toBe(null);
    expect(insideOpenGroup('\\textbf{a \\emph{b}', 10)).toBe(true);
    expect(insideOpenGroup('x \\emph{b}', 2)).toBe(false);
  });

  it('\\textbf{…} becomes bold once the caret goes on', async () => {
    const { view, type } = setup();
    type('a \\textbf{bold}');
    await settle();
    expect(view.state.doc.textContent).toBe('a \\textbf{bold}');   // the caret is still at its end
    type(' x');
    await settle();
    const [p] = json(view);
    expect(view.state.doc.textContent).toBe('a bold x');
    expect(p.content!.find(n => n.text === 'bold')!.marks![0].type).toBe('series');
  });

  it('\\section{…} alone in its paragraph makes a heading, at Enter', async () => {
    const { view, type } = setup();
    type('\\section{Intro}');
    view.dispatch(view.state.tr.split(view.state.selection.from));
    await settle();
    const [h, next] = json(view);
    expect(h.attrs.layout).toBe('Section');
    expect(h.content![0].text).toBe('Intro');
    expect(next.attrs.layout).toBe('Standard');
  });

  it('waits for every argument (\\href{…}{…}) and for the command whose braces are still open', async () => {
    const { view, type } = setup();
    type('\\href{https://x.org}');
    type('{site} ');
    await settle();
    expect(json(view)[0].content![0]).toMatchObject({ type: 'command', attrs: { cmd: 'href' } });
    const b = setup();
    b.type('\\textbf{a \\emph{b} ');
    await settle();
    expect(b.view.state.doc.textContent).toBe('\\textbf{a \\emph{b} ');
    b.type('c} ');
    await settle();
    expect(b.view.state.doc.textContent).toBe('a b c ');
  });

  it('a command without arguments at the space after it; unknown ones become TeX code', async () => {
    const { view, type } = setup();
    type('\\LaTeX and \\foo{x} ');
    await settle();
    const nodes = json(view)[0].content!;
    expect(nodes[0]).toMatchObject({ type: 'special' });
    expect(nodes.some(n => n.type === 'inset' && n.attrs!.name === 'ERT')).toBe(true);
  });

  it('math only behind $: \\alpha and \\frac{…}{…} typed in the text stay TeX code, no formula', async () => {
    const { view, type } = setup();
    type('let \\alpha be \\frac{a}{b} here');
    await settle();
    const nodes = json(view)[0].content!;
    expect(nodes.some(n => n.type === 'math_inline')).toBe(false);
    // (TeX code as pasted LaTeX gets it: an unknown command's braces are code, its arguments text)
    const code = view.state.doc.firstChild!.content.content.filter(n => n.type.name === 'inset' && n.attrs.name === 'ERT').map(n => n.textContent);
    expect(code).toEqual(['\\alpha', '\\frac{', '}{', '}']);
  });

  it('leaves markdown documents, a caret back inside the command and a command changed meanwhile alone', async () => {
    const md = setup('jan/notes/a.md');
    md.type('\\textbf{x} ');
    await settle();
    expect(md.view.state.doc.textContent).toBe('\\textbf{x} ');
    // the caret goes back into the command: it waits
    const { view, type } = setup();
    type('\\emph{y}');
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 4)));
    await settle();
    expect(view.state.doc.textContent).toBe('\\emph{y}');
    const before = parsed.calls.length;
    view.dispatch(view.state.tr.setSelection(TextSelection.atEnd(view.state.doc)));
    type(' ');
    await settle();
    expect(parsed.calls.length).toBe(before + 1);
    expect(view.state.doc.textContent).toBe('y ');
  });
});
