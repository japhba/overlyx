/**
 * LaTeX typed in a LaTeX document's text (packages/client/src/editor/plugins/typedtex.ts): a heading,
 * a font, a footnote at its `{` (its `}` only ends it), one-argument commands and formulas at their
 * last `}`, the rest once the caret leaves them — parsed as pasted LaTeX is (here by core's parser
 * itself, the server's /clip does the same) — and command names completed by Tab. Typed the way the
 * view would: handleTextInput first, else the character inserted; the plugin's view sees every update.
 */
import { describe, it, expect, vi } from 'vitest';
import { EditorState, TextSelection, type Transaction } from 'prosemirror-state';
import type { DecorationSet } from 'prosemirror-view';
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
const { typedTexPlugin, commandRunAt, insideOpenGroup, isMathCommand } = await import('../packages/client/src/editor/plugins/typedtex.ts');
const { editorContext } = await import('../packages/client/src/editor/context.ts');

function setup(docId = 'jan/paper/main.tex', text = '', hooks: Parameters<typeof typedTexPlugin>[0] = {}) {
  const plugin = typedTexPlugin(hooks);
  const par = schema.nodes.paragraph.create({ layout: 'Standard' }, text ? [schema.text(text)] : []);
  let state = EditorState.create({ doc: schema.nodes.doc.create(null, [par]), plugins: [plugin] });
  state = state.apply(state.tr.setSelection(TextSelection.atEnd(state.doc)));
  const view = {
    state, isDestroyed: false, composing: false, dom: { dataset: { docId } },
    dispatch(tr: Transaction) { const prev = view.state; view.state = view.state.apply(tr); pv.update!(view as never, prev); },
    someProp(name: string, f: (h: (...a: unknown[]) => unknown) => unknown) { const h = (plugin.props as Record<string, unknown>)[name]; return typeof h === 'function' ? f(h.bind(plugin) as never) : undefined; },
  };
  const pv = plugin.spec.view!(view as never);
  const type = (chars: string) => {
    for (const ch of chars) {
      const { from, to } = view.state.selection;
      if (!plugin.props.handleTextInput!.call(plugin, view as never, from, to, ch, () => view.state.tr)) view.dispatch(view.state.tr.insertText(ch, from, to));
    }
  };
  const key = (k: string) => (plugin.props.handleKeyDown!.call(plugin, view as never, { key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false } as KeyboardEvent) as boolean);
  /** the completion shown after the caret ('' none) */
  const hint = () => (plugin.props.decorations!.call(plugin, view.state) as DecorationSet | null)?.find().map(d => String((d.spec as { key: string }).key).replace('tex-hint:', ''))[0] ?? '';
  return { view, type, key, hint };
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

  it('\\textbf{ types on in bold, \\emph{ inside it in both; each } ends its font', () => {
    const { view, type } = setup();
    type('a \\textbf{bold \\emph{both} only} x');
    const runs = json(view)[0].content!.map(n => `${n.text}:${(n.marks ?? []).map(m => m.type).sort().join('+')}`);
    expect(runs).toEqual(['a :', 'bold :series', 'both:emph+series', ' only:series', ' x:']);
  });

  it('\\section{ at a paragraph\'s start makes it the heading, typed on as one; Esc right after gives the text back', () => {
    const { view, type, key } = setup();
    type('\\section{Intro');
    expect(json(view)[0]).toMatchObject({ attrs: { layout: 'Section' }, content: [{ text: 'Intro' }] });
    type('}');   // (only ends it)
    expect(view.state.doc.textContent).toBe('Intro');
    const s = setup();
    s.type('\\subsection*{');
    expect(s.view.state.doc.firstChild!.attrs.layout).toBe('Subsection*');
    expect(s.key('Escape')).toBe(true);
    expect(s.view.state.doc.firstChild!.attrs.layout).toBe('Standard');
    expect(s.view.state.doc.textContent).toBe('\\subsection*{');
    // not after text
    const t = setup();
    t.type('see \\section{x');
    expect(t.view.state.doc.firstChild!.attrs.layout).toBe('Standard');
    void key;
  });

  it('\\footnote{ opens a footnote to type in, its } leaves it', () => {
    const { view, type } = setup();
    type('See\\footnote{A note.} on');
    const [p] = json(view);
    expect(p.content!.map(n => n.type)).toEqual(['text', 'inset', 'text']);
    expect(p.content![1]).toMatchObject({ attrs: { name: 'Foot' } });
    expect(view.state.doc.firstChild!.child(1).textContent).toBe('A note.');
    expect(p.content![2].text).toBe(' on');
  });

  it('\\cite{…} at its }, \\href{…}{…} once the caret goes on, a command inside open braces with the one around it', async () => {
    const c = setup();
    c.type('see \\cite{key}');
    await settle();
    expect(json(c.view)[0].content!.at(-1)).toMatchObject({ type: 'command', attrs: { cmd: 'citation' } });
    const { view, type } = setup();
    type('\\href{https://x.org}');
    type('{see \\emph{b}}');
    await settle();
    expect(view.state.doc.textContent).toBe('\\href{https://x.org}{see \\emph{b}}');
    type(' ');
    await settle();
    expect(json(view)[0].content![0]).toMatchObject({ type: 'command', attrs: { cmd: 'href' } });
  });

  it('completes command names as a formula does: the rest shown, Tab takes it and finishes the command', () => {
    const { view, type, key, hint } = setup();
    type('\\sec');
    expect(hint()).toBe('tion');
    key('Tab');
    expect(view.state.doc.firstChild!.attrs.layout).toBe('Section');   // `\section{`: a heading to type
    expect(view.state.doc.textContent).toBe('');
    const m = setup();
    m.type('so \\alp');
    expect(m.hint()).toBe('ha');
    expect(m.key('Escape')).toBe(true);   // (away with it)
    expect(m.hint()).toBe('');
    m.key('Tab');
    expect(json(m.view)[0].content!.map(n => n.type)).toEqual(['text', 'math_inline', 'text']);
    const f = setup();
    f.type('\\begin{fig');
    expect(f.hint()).toBe('ure');
    f.key('Tab');
    expect(f.view.state.doc.firstChild!.firstChild!.attrs).toMatchObject({ name: 'Float', arg: 'figure' });
    f.view.dispatch(f.view.state.tr.split(f.view.state.selection.from));
    f.type('\\end{');
    expect(f.hint()).toBe('figure');   // the environment the caret is in
    f.key('Tab');
    expect(f.view.state.selection.$from.parent).toBe(f.view.state.doc.lastChild);
    // nothing to complete: Tab is Tab
    const n = setup();
    n.type('C:\\Wxyz');
    expect(n.key('Tab')).toBe(false);
  });

  it('a command without arguments at the space after it; unknown ones become TeX code', async () => {
    const { view, type } = setup();
    type('\\LaTeX and \\foo{x} ');
    await settle();
    const nodes = json(view)[0].content!;
    expect(nodes[0]).toMatchObject({ type: 'special' });
    expect(nodes.some(n => n.type === 'inset' && n.attrs!.name === 'ERT')).toBe(true);
  });

  it('math typed in the text is a formula at once — \\alpha at the space, \\frac{…}{…} when finished; Esc gives the text back', async () => {
    expect([isMathCommand('alpha'), isMathCommand('frac'), isMathCommand('mathbb'), isMathCommand('hat')]).toEqual([true, true, true, true]);
    expect([isMathCommand('textbf'), isMathCommand('ldots'), isMathCommand('underline'), isMathCommand('LaTeX'), isMathCommand('smiley')]).toEqual([false, false, false, false, false]);
    const { view, type, key } = setup();
    type('let \\alpha be \\frac{a}{b} here');
    await settle();
    const maths = json(view)[0].content!.filter(n => n.type === 'math_inline').map(n => n.attrs!.latex);
    expect(maths).toEqual(['\\alpha', '\\frac{a}{b}']);
    expect(parsed.calls.filter(c => c.includes('alpha') || c.includes('frac'))).toEqual([]);   // (no server for those)
    // Esc right after: the typed text back, the space typed after it kept
    type(' and \\gamma ');
    expect(json(view)[0].content!.at(-2)).toMatchObject({ type: 'math_inline' });
    expect(key('Escape')).toBe(true);
    expect(view.state.doc.textContent.endsWith('and \\gamma ')).toBe(true);
    expect(key('Escape')).toBe(false);   // (once)
    // …and only right after: typing on, Esc is Esc again
    type('\\beta x');
    expect(key('Escape')).toBe(false);
  });

  it('Enter ends a command without arguments as a space does; \\centering centres the paragraph', async () => {
    const { view, type, key } = setup();
    type('\\alpha');
    key('Enter');
    expect(json(view)[0].content![0]).toMatchObject({ type: 'math_inline', attrs: { latex: '\\alpha' } });
    const c = setup();
    c.type('\\centering ');
    expect(c.view.state.doc.firstChild!.attrs.align).toBe('center');
    expect(c.view.state.doc.textContent).toBe('');
  });

  it('environments alone in a paragraph: a float to type into and out of, a display formula, the class\'s paragraph styles', async () => {
    const { view, type } = setup();
    type('\\begin{figure}');
    const float = view.state.doc.firstChild!.firstChild!;
    expect(float.attrs).toMatchObject({ name: 'Float', arg: 'figure' });
    expect(view.state.selection.$from.parent.attrs).toMatchObject({ layout: 'Plain Layout', align: 'center' });
    type('\\includegraphics{plot.pdf}');
    view.dispatch(view.state.tr.split(view.state.selection.from));
    type('\\end{figure}');
    await settle();
    const f = view.state.doc.firstChild!.firstChild!;
    expect(f.childCount).toBe(1);   // (the paragraph \end{figure} was typed in went)
    expect(f.firstChild!.firstChild!.type.name).toBe('graphics');
    expect(view.state.selection.$from.parent).toBe(view.state.doc.lastChild);   // a paragraph of its own after the float
    expect(view.state.doc.lastChild!.attrs.layout).toBe('Standard');
    // a display formula: the editor's (assembly.ts hands insertMath in)
    const opened: string[] = [];
    const m = setup('jan/paper/main.tex', '', { displayMath: (_v, env) => { opened.push(env); return true; } });
    m.type('\\begin{align*}');
    expect(opened).toEqual(['align*']);
    expect(m.view.state.doc.textContent).toBe('');
    // the class's environments
    editorContext.meta = { layouts: [{ name: 'Standard' }, { name: 'Theorem', latexType: 'Environment', latexName: 'theorem' }] } as never;
    try {
      const t = setup();
      t.type('\\begin{theorem}');
      expect(t.view.state.doc.firstChild!.attrs.layout).toBe('Theorem');
      t.type('Every proof ends.');
      t.view.dispatch(t.view.state.tr.split(t.view.state.selection.from));
      t.type('\\end{theorem}');
      expect(t.view.state.doc.lastChild!.attrs.layout).toBe('Standard');
      expect(t.view.state.doc.lastChild!.textContent).toBe('');
    } finally { editorContext.meta = null; }
  });

  it('leaves markdown documents, a caret back inside the command and a command changed meanwhile alone', async () => {
    const md = setup('jan/notes/a.md');
    md.type('\\textbf{x} ');
    await settle();
    expect(md.view.state.doc.textContent).toBe('\\textbf{x} ');
    // the caret goes back into the command: it waits
    const { view, type } = setup();
    type('\\textcolor{red}{y}');
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 4)));
    await settle();
    expect(view.state.doc.textContent).toBe('\\textcolor{red}{y}');
    const before = parsed.calls.length;
    view.dispatch(view.state.tr.setSelection(TextSelection.atEnd(view.state.doc)));
    type(' ');
    await settle();
    expect(parsed.calls.length).toBe(before + 1);
    expect(view.state.doc.textContent).toBe('y ');
  });
});
