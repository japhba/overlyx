/**
 * The look of a new HTML article (article.ts): a research post's — a serif text column, sans-serif
 * headings, notes in the margin, figures that may run wider than the text. It is the page's own
 * stylesheet, written into its <head>, so the page stays one file that any host can serve and that
 * people and agents restyle freely.
 *
 * The design is set by the custom properties at the top (ARTICLE_VARS). The document editor shows an
 * article in its own look built on the same properties (client styles.css, `.ol-article`), reading
 * their values from the page (articleVars): a page restyled through them looks restyled while it is
 * written, too; rules of its own show in the page view.
 */

/** the design's custom properties and their values in a new article */
export const ARTICLE_VARS: Record<string, string> = {
  '--font-text': '"Source Serif 4", "Iowan Old Style", Georgia, serif',
  '--font-ui': 'Inter, system-ui, -apple-system, "Segoe UI", sans-serif',
  '--font-code': '"JetBrains Mono", ui-monospace, Menlo, monospace',
  '--text-size': '19px',
  '--leading': '1.68',
  '--measure': '680px',
  '--wide': '1040px',
  '--ink': '#1b1d21',
  '--muted': '#5f646d',
  '--accent': '#b4532a',
  '--paper': '#fbfaf7',
  '--rule': '#e4e0d6',
  '--code-bg': '#f2f0ea',
};

const FONTS = 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;600&family=Source+Serif+4:ital,opsz,wght@0,8..60,400;0,8..60,600;1,8..60,400&display=swap';

export const ARTICLE_CSS = `:root {
${Object.entries(ARTICLE_VARS).map(([k, v]) => `  ${k}: ${v};`).join('\n')}
}
*, *::before, *::after { box-sizing: border-box; }
html { background: var(--paper); -webkit-text-size-adjust: 100%; }
body { margin: 0; color: var(--ink); font-family: var(--font-text); font-size: var(--text-size); line-height: var(--leading); font-optical-sizing: auto; -webkit-font-smoothing: antialiased; }
article { max-width: var(--measure); margin: 0 auto; padding: clamp(48px, 9vw, 112px) 24px 128px; }
h1, h2, h3, h4, h5, h6 { font-family: var(--font-ui); line-height: 1.2; text-wrap: balance; }
h1 { font-size: clamp(2.1em, 5vw, 2.85em); font-weight: 700; letter-spacing: -0.025em; line-height: 1.08; margin: 0 0 .5em; }
h2 { font-size: 1.4em; font-weight: 650; letter-spacing: -0.012em; margin: 2.4em 0 .7em; }
h3 { font-size: 1.12em; font-weight: 600; margin: 2em 0 .55em; }
h4, h5, h6 { font-size: .95em; font-weight: 600; margin: 1.6em 0 .4em; }
h5, h6 { color: var(--muted); }
.byline, .date { font-family: var(--font-ui); font-size: .78em; color: var(--muted); margin: 0 0 .4em; }
.abstract { font-size: 1.12em; line-height: 1.6; color: var(--muted); margin: 2.2em 0 2.6em; }
p { margin: 0 0 1.05em; }
a { color: var(--accent); text-decoration-thickness: 1px; text-underline-offset: .18em; }
strong { font-weight: 650; }
ul, ol { margin: 0 0 1.05em; padding-left: 1.3em; }
li { margin: .3em 0; padding-left: .2em; }
li::marker { color: var(--muted); }
blockquote { margin: 1.6em 0; padding-left: 1.1em; border-left: 2px solid var(--accent); color: var(--muted); }
blockquote p { margin-bottom: .6em; }
code { font-family: var(--font-code); font-size: .82em; background: var(--code-bg); padding: .12em .32em; border-radius: 4px; }
pre { font-family: var(--font-code); font-size: .78em; line-height: 1.6; background: var(--code-bg); padding: 1.1em 1.3em; border-radius: 8px; overflow-x: auto; margin: 1.6em 0; }
pre code { background: none; padding: 0; font-size: inherit; }
hr { border: 0; height: 1px; background: var(--rule); margin: 3em 0; }
figure { margin: 2.4em 0; }
figure img, figure svg, figure canvas, figure video { display: block; max-width: 100%; height: auto; margin: 0 auto; }
figcaption { font-family: var(--font-ui); font-size: .74em; line-height: 1.55; color: var(--muted); margin-top: .9em; }
figure.wide { width: min(var(--wide), 100vw - 48px); margin-left: 50%; transform: translateX(-50%); }
table { width: 100%; border-collapse: collapse; margin: 1.8em 0; font-family: var(--font-ui); font-size: .8em; font-variant-numeric: tabular-nums; }
th, td { text-align: left; padding: .55em .75em; border-bottom: 1px solid var(--rule); vertical-align: top; }
th { font-weight: 600; border-bottom: 1.5px solid var(--ink); }
.widget { font-family: var(--font-ui); font-size: .8em; color: var(--muted); }
.widget input[type=range] { accent-color: var(--accent); vertical-align: middle; }
/* notes: in the margin beside their mark on a wide screen, in brackets in the text on a narrow one */
.sidenote-ref { font-family: var(--font-ui); font-size: .62em; font-weight: 600; color: var(--accent); vertical-align: super; line-height: 0; margin-left: .1em; }
.sidenote, .footnote, .marginnote { font-family: var(--font-ui); font-size: .74em; line-height: 1.5; color: var(--muted); }
.sidenote::before, .footnote::before { content: attr(data-n) ". "; font-weight: 600; color: var(--accent); }
@media (min-width: 1180px) {
  .sidenote, .footnote, .marginnote { float: right; clear: right; width: 220px; margin: .35em -260px .8em 0; }
}
@media (max-width: 1179px) {
  .sidenote-ref { display: none; }
  .sidenote::before, .footnote::before { content: "("; font-weight: inherit; color: inherit; }
  .sidenote::after, .footnote::after, .marginnote::after { content: ")"; }
  .marginnote::before { content: "("; }
}
@media (max-width: 600px) { body { font-size: 17px; } }
@media print { html { background: none; } article { padding: 0; } figure.wide { width: auto; margin-left: 0; transform: none; } }`;

/** numbered notes: a mark in the text, the number on the note */
const NOTES_SCRIPT = `addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('article .sidenote, article .footnote').forEach((note, i) => {
    note.dataset.n = i + 1;
    const ref = document.createElement('sup');
    ref.className = 'sidenote-ref';
    ref.textContent = i + 1;
    note.before(ref);
  });
});`;

/** The <head> content of a new article: its fonts, its stylesheet and the notes' numbering. */
export function articleHead(): string {
  return `<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${FONTS}">
<style>
${ARTICLE_CSS}
</style>
<script>
${NOTES_SCRIPT}
</script>`;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** A new article: the page with a title, a byline and a few sections to write over, an interactive figure among them. */
export function newArticleText(opts: { title?: string; author?: string; date?: Date } = {}): string {
  const title = esc((opts.title ?? '').replace(/\s+/g, ' ').trim() || 'Untitled article');
  const author = esc((opts.author ?? '').trim() || 'Your Name');
  const date = (opts.date ?? new Date()).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="overlyx" content="article">
<title>${title}</title>
${articleHead()}
</head>
<body>
<article>
  <h1>${title}</h1>
  <p class="byline">${author} · ${date}</p>
  <p class="abstract">One or two sentences that say what this piece shows and why it matters.</p>
  <h2>Introduction</h2>
  <p>Write here as in any document: comment, suggest changes, ask an agent to draft a section. Formulas are TeX, inline as \\(e^{i\\pi} + 1 = 0\\) or on a line of their own:</p>
  <p>\\[ \\mathcal{L}(\\theta) = \\mathbb{E}_{x \\sim p}\\bigl[-\\log q_\\theta(x)\\bigr] \\]</p>
  <p>Notes go beside the text.<span class="sidenote">On a wide screen in the margin, on a phone in the text.</span> Figures are pictures with a caption, or anything a web page can show:</p>
  <figure class="wide widget">
    <svg viewBox="0 0 800 200" role="img" aria-label="A damped wave"><path fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linecap="round"/></svg>
    <label>Frequency <input type="range" min="1" max="8" step="0.1" value="3"></label>
    <figcaption>An interactive figure: HTML and a script of its own, running here as in the published page.</figcaption>
    <script>
      (() => {
        const fig = document.currentScript.closest('figure'), path = fig.querySelector('path'), f = fig.querySelector('input');
        const draw = () => {
          let d = '';
          for (let x = 0; x <= 800; x += 4) d += (x ? 'L' : 'M') + x + ' ' + (100 + 80 * Math.exp(-x / 500) * Math.sin(x / 800 * 2 * Math.PI * f.value)).toFixed(1);
          path.setAttribute('d', d);
        };
        f.addEventListener('input', draw);
        draw();
      })();
    </script>
  </figure>
  <h2>Results</h2>
  <p>What was found.</p>
  <h2>Discussion</h2>
  <p>What it means, and what is left open.</p>
</article>
</body>
</html>
`;
}

/**
 * The custom properties a page sets at :root — in its <style> elements and the stylesheets of the
 * project it links (`readFile`: a linked file's text, relative to the page) — at the top level of its
 * CSS (not inside @media): the editor shows the article in these (client editor/article.ts).
 */
export function articleVars(head: string, readFile?: (href: string) => string | undefined): Record<string, string> {
  const sheets: string[] = [];
  for (const m of head.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) sheets.push(m[1]);
  if (readFile) {
    for (const m of head.matchAll(/<link\b[^>]*>/gi)) {
      const rel = /\brel\s*=\s*["']?([^"'>]*)/i.exec(m[0])?.[1] ?? '', href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(m[0]);
      const url = href ? href[1] ?? href[2] ?? href[3] : '';
      if (!/\bstylesheet\b/i.test(rel) || !url || /^([a-z][a-z0-9+.-]*:|\/\/)/i.test(url)) continue;
      const text = readFile(url);
      if (text) sheets.push(text);
    }
  }
  const out: Record<string, string> = {};
  for (const sheet of sheets) {
    const css = sheet.replace(/\/\*[\s\S]*?\*\//g, '');
    // the top level's rules: `:root { … }` at brace depth 0
    let depth = 0, start = 0;
    for (let i = 0; i < css.length; i++) {
      const c = css[i];
      if (c === '{') {
        if (depth === 0 && /(^|[\s,}]):root\s*$/.test(css.slice(start, i)) && !/@/.test(css.slice(start, i))) {
          const end = css.indexOf('}', i);
          if (end < 0) break;
          for (const d of css.slice(i + 1, end).matchAll(/(--[\w-]+)\s*:\s*([^;]+)/g)) out[d[1]] = d[2].trim();
        }
        depth++;
      } else if (c === '}') { depth = Math.max(0, depth - 1); if (depth === 0) start = i + 1; }
      else if (c === ';' && depth === 0) start = i + 1;
    }
  }
  return out;
}
