/** LaTeX colouring of the source pane (packages/client/src/app/texhighlight.ts). */
import { describe, it, expect } from 'vitest';
import { highlightTex } from '../packages/client/src/app/texhighlight.ts';

const strip = (html: string) => html.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

describe('highlightTex', () => {
  it('keeps the text intact (only spans are added, HTML is escaped)', () => {
    const src = '\\section{A & B <c>}\nText % note\n$x<y$ \\[ a \\] \\begin{align}\nx &= 1\n\\end{align}\n';
    expect(strip(highlightTex(src))).toBe(src);
    expect(highlightTex('a<b')).toBe('a&lt;b');
  });
  it('colours comments, commands, environments and sectioning arguments', () => {
    const h = highlightTex('\\documentclass{article} % class\n\\begin{document}\n\\section*{Intro}\n\\end{document}');
    expect(h).toContain('<span class="hl-cmd">\\documentclass</span>');
    expect(h).toContain('<span class="hl-comment">% class</span>');
    expect(h).toContain('<span class="hl-kw">\\begin</span>');
    expect(h).toContain('<span class="hl-env">document</span>');
    expect(h).toContain('<span class="hl-sec">\\section*</span>');
    expect(h).toContain('<span class="hl-arg">Intro</span>');
  });
  it('marks math regions: $…$, \\[…\\], math environments; commands inside get the m class', () => {
    expect(highlightTex('a $x^2$ b')).toBe('a <span class="hl-mdelim">$</span><span class="hl-math">x^2</span><span class="hl-mdelim">$</span> b');
    const d = highlightTex('\\[\n\\alpha\n\\]');
    expect(d).toContain('<span class="hl-cmd m">\\alpha</span>');
    expect(d.endsWith('<span class="hl-mdelim">\\]</span>')).toBe(true);
    const env = highlightTex('\\begin{align}\nx &= \\sqrt{2}\n\\end{align}\nplain');
    expect(env).toContain('<span class="hl-amp m">&amp;</span>');
    expect(env).toContain('<span class="hl-cmd m">\\sqrt</span>');
    expect(env.endsWith('\nplain')).toBe(true);   // math is closed by \end{align}
    expect(highlightTex('$$x$$ y')).toContain('<span class="hl-mdelim">$$</span> y');
  });
  it('an empty inline formula ($$) and stray delimiters do not colour the rest of the file', () => {
    const h = highlightTex('we “unroll”$$ this and $x$ later.\n\nNext paragraph.');
    expect(h).toContain('<span class="hl-mdelim">$$</span> this and ');
    expect(h).toContain('<span class="hl-math">x</span>');
    expect(h.endsWith('\n\nNext paragraph.')).toBe(true);
    expect(highlightTex('$$ a $$ b')).toContain('<span class="hl-math"> a </span>');
    const stray = highlightTex('a $b\n\nc \\( d\n\ne');
    expect(stray.endsWith('\n\ne')).toBe(true);
    expect(stray).toContain('\n\nc ');
  });
  it('survives unbalanced input', () => {
    for (const s of ['$', '\\[', '\\begin{align} x', '\\section{open', '}}}', '\\', '%']) expect(strip(highlightTex(s))).toBe(s);
  });
});
