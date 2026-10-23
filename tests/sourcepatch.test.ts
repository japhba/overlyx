import { describe, it, expect } from 'vitest';
import { parse } from 'parse5';
import { parseSource, sourcePatch, opSplices, applySplices, elementAt, type HNode, type HtmlOp, type Splice } from '../packages/core/src/html/source.ts';

const stroke = (i: number) => `<svg class="ol-ink" style="position: absolute; left: ${10 + i}px; top: ${20 + i}px; width: 12px; height: 11px; overflow: visible" viewBox="0 0 12 11"><g fill="none" stroke="#202124" stroke-linecap="round"><path stroke-width="2" d="M2 9L2.0${i % 10} 9"/><path stroke-width="2.05" d="M2 9L2.03 8.31L${i} 4"/></g></svg>`;

const DECK = `<!doctype html>
<html>
<head>
<meta name="overlyx" content="deck">
<title>Talk</title>
<style>.slide { width: 1280px; height: 720px }</style>
</head>
<body>
<main>

<section class="slide">
  <h1 style="position: absolute; left: 100px; top: 80px">Hello &amp; welcome</h1>
  <p class="sub" style='color: red'>Sub <b>bold</b></p>
  ${stroke(1)}
  <aside class="notes">Say hello.</aside>
</section>

<section class="slide">
  <div class="box" style="left: 5px"><p>One</p><p>Two</p></div>
  <ul style="position:absolute;left:10px">
    <li>One</li>
    <li>Two
  </ul>
  <svg viewBox="0 0 10 10"><foreignObject><div>x</div></foreignObject></svg>
</section>

<section class="slide"></section>

</main>
<script>window.x = 1</script>
</body>
</html>
`;

/** the tree as plain data: names, attributes, text and every place in the text (lines and columns left out) */
function shape(n: HNode): unknown {
  const l = n.sourceCodeLocation as Record<string, unknown> | undefined | null;
  const offs = (o: unknown): unknown => {
    if (!o || typeof o !== 'object') return o;
    const r = o as Record<string, unknown>;
    const out: Record<string, unknown> = { s: r.startOffset, e: r.endOffset };
    if (r.startTag) out.st = offs(r.startTag);
    if (r.endTag) out.et = offs(r.endTag);
    if (r.attrs) out.a = Object.fromEntries(Object.entries(r.attrs as Record<string, unknown>).map(([k, v]) => [k, offs(v)]));
    return out;
  };
  const x = n as unknown as { nodeName: string; tagName?: string; attrs?: { name: string; value: string }[]; value?: string; data?: string; childNodes?: HNode[]; content?: HNode; namespaceURI?: string };
  return {
    n: x.nodeName, ns: x.namespaceURI, a: x.attrs?.map(a => `${a.name}=${a.value}`), v: x.value ?? x.data, l: l ? offs(l) : null,
    k: x.childNodes?.map(shape), c: x.content ? shape(x.content) : undefined,
  };
}
const fresh = (text: string) => shape(parse(text, { sourceCodeLocationInfo: true, scriptingEnabled: false }) as unknown as HNode);

/** the edit made, its patch checked against the parser: the tree made from the old one is the one parsed afresh */
function edit(text: string, ops: HtmlOp[], useSplices = true): { next: string; patched: boolean; at: boolean } {
  const src = parseSource(text);
  const sp: Splice[] = ops.flatMap(op => opSplices(src, op));
  const next = applySplices(text, sp);
  const p = sourcePatch(text, next, useSplices ? sp : undefined);
  if (p) {
    expect(applySplices(text, [{ from: p.from, to: p.to, insert: p.html }])).toBe(next);
    expect(shape(parseSource(next).doc as unknown as HNode)).toEqual(fresh(next));
  }
  return { next, patched: !!p, at: p?.at !== undefined };
}

describe('source patches', () => {
  it('a stroke added to a slide: new nodes among its children, the tree made from the last one', () => {
    let text = DECK;
    for (let i = 0; i < 30; i++) {
      const r = edit(text, [{ t: 'insert', parent: [1, 0, 0], index: 3 + i, html: stroke(i + 2) }]);
      expect(r.patched).toBe(true);
      expect(r.at).toBe(true);
      text = r.next;
    }
    expect(elementAt(parseSource(text).doc, [1, 0, 0])!.childNodes.filter(n => 'tagName' in n).length).toBe(34);
  });

  it('strokes on an empty slide and at the end of one', () => {
    let text = DECK;
    for (let i = 0; i < 4; i++) { const r = edit(text, [{ t: 'insert', parent: [1, 0, 2], index: i, html: stroke(i) }]); expect(r.patched).toBe(true); text = r.next; }
    for (let i = 0; i < 3; i++) { const r = edit(text, [{ t: 'insert', parent: [1, 0, 1], index: 99, html: stroke(i) }]); expect(r.patched).toBe(true); text = r.next; }
  });

  it('removals, moves, styles and retyping inside a slide', () => {
    let text = DECK;
    const steps: HtmlOp[][] = [
      [{ t: 'remove', paths: [[1, 0, 0, 2]] }],
      [{ t: 'style', path: [1, 0, 0, 0], set: { left: '120px' } }],
      [{ t: 'inner', path: [1, 0, 0, 1], html: 'New <i>text</i> here' }],
      [{ t: 'attr', path: [1, 0, 1, 0], name: 'data-ol-name', value: 'Box' }],
      [{ t: 'inner', path: [1, 0, 1, 0, 0], html: 'One<div>two</div>' }],
      [{ t: 'duplicate', paths: [[1, 0, 1, 1]] }],
      [{ t: 'move', path: [1, 0, 0, 0], parent: [1, 0, 0], index: 2 }],
      [{ t: 'style', path: [1, 0, 1, 2, 0], set: { color: 'red' } }],
    ];
    for (const ops of steps) {
      const r = edit(text, ops);
      expect(r.patched).toBe(true);
      // (only the nodes it touched parsed again, not the slide — a <div> retyped into a <p>: the parser ends the <p> there, all of the box)
      expect(r.at).toBe(!(ops[0].t === 'inner' && ops[0].html.includes('<div>')));
      text = r.next;
      // (the same again, from the two texts only)
      parseSource(DECK);
    }
  });

  it('from the two texts alone (undo, another person): the change put between two elements', () => {
    let text = DECK;
    const added = edit(text, [{ t: 'insert', parent: [1, 0, 0], index: 3, html: stroke(7) }], false);
    expect(added.patched).toBe(true);
    expect(added.at).toBe(true);
    text = added.next;
    const gone = edit(text, [{ t: 'remove', paths: [[1, 0, 0, 3]] }], false);
    expect(gone.patched).toBe(true);
  });

  it("a slide's own attribute: the slides' container parsed again", () => {
    expect(edit(DECK, [{ t: 'attr', path: [1, 0, 0], name: 'data-x', value: '1' }]).patched).toBe(true);
  });

  it('not a patch: a change outside a container, a script', () => {
    expect(edit(DECK, [{ t: 'attr', path: [1], name: 'data-x', value: '1' }]).patched).toBe(false);
    expect(edit(DECK, [{ t: 'insert', parent: [1, 0, 0], index: 0, html: '<script>alert(1)</script>' }]).patched).toBe(false);
    expect(edit(DECK, [{ t: 'inner', path: [0, 1], html: 'Other' }]).patched).toBe(false);
  });

  it('a text not parsed lately: no patch (nothing parsed for it)', () => {
    const other = DECK.replace('Talk', 'Talk two');
    expect(sourcePatch(other, other.replace('Say hello.', 'Say hi.'))).toBeNull();
  });
});
