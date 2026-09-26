// Renders the sample of Settings ▸ Editor ▸ Font (tex.stackexchange.com/q/425098) with KaTeX, once in KaTeX's
// Computer Modern and once per math font id given (fonts/web/math), as the editor's CSS combines the faces;
// writes $OUT/probe.html and $OUT/probe.png (default /tmp/mathfont-probe). Usage: node scratch/mathfont-probe.mjs stix2 euler
import { chromium } from 'playwright';
import katex from 'katex';
import fs from 'fs';
const R = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const OUT = process.env.OUT ?? '/tmp/mathfont-probe';
fs.mkdirSync(OUT, { recursive: true });
const ids = process.argv.slice(2);
const macros = { '\\Res': '\\operatorname{Res}', '\\diff': '\\mathop{}\\!\\mathrm{d}', '\\BbbC': '\\mathbb{C}', '\\iiiint': '\\mathop{\\int\\kern-0.65em\\int\\kern-0.65em\\int\\kern-0.65em\\int}' };
const k = (s, d) => katex.renderToString(s, { displayMode: d, throwOnError: false, strict: false, macros, output: 'html' });
const extra = (process.env.EXTRA ?? '').split('|').filter(Boolean).map(x => k(x, true)).join('');
const body = extra + `<p><b>Theorem 1</b> (Residue theorem). <i>Let ${k('f')} be analytic in the region ${k('G')} except for the isolated singularities ${k('a_1,a_2,\\dots,a_m')}. If ${k('\\gamma')} is a closed rectifiable curve in ${k('G')} which does not pass through any of the points ${k('a_k')} and if ${k('\\gamma\\approx 0')} in ${k('G')}, then</i></p>
${k('\\frac{1}{2\\pi i} \\int\\limits_\\gamma f\\Bigl(x^{\\mathbf{N}\\in\\mathbb{C}^{N\\times 10}}\\Bigr) = \\sum_{k=1}^m n(\\gamma;a_k)\\Res(f;a_k)\\,.', true)}
<p>Large operators ${k('\\iiint\\limits_{Q}f(x,y,z) \\diff x \\diff y \\diff z')} and ${k('\\prod_{\\gamma\\in\\Gamma_{\\bar{C}}}\\partial(\\tilde{X}_\\gamma)')}; accents ${k('\\hat a\\ \\tilde b\\ \\bar c\\ \\vec v\\ \\dot x\\ \\ddot y\\ \\breve u\\ \\check z\\ \\acute e\\ \\grave e\\ \\widehat{AB}\\ \\widetilde{xyz}\\ \\overline{z}')}; ${k('a\\neq b,\\ x\\not< y,\\ \\mathcal{L}\\mathscr{L}\\mathfrak{g}\\boldsymbol{\\alpha\\beta} \\mathsf{Ab}\\mathtt{Ab}\\ \\varepsilon\\epsilon\\varphi\\phi\\vartheta\\varGamma\\leqslant\\varnothing')}</p>
${k('\\oint_{\\partial Q} f\'\\Biggl(\\max\\Biggl\\{\\frac{\\Vert w\\Vert}{\\vert w^2+x^2\\vert};\\frac{\\Vert w\\oplus z\\Vert}{\\vert x\\oplus y\\vert}\\Biggr\\}\\Biggr)\\bigl[\\Bigl[\\biggl[\\Biggl[\\left(\\frac{a}{\\frac{b}{\\frac{c}{d}}}\\right)\\sqrt{x^2}\\,\\sum_i\\prod_j\\bigcup_k\\bigoplus_l', true)}`;
const css = fs.readFileSync(R + '/packages/client/src/fonts/web/webfonts.css', 'utf8').replace(/url\("\.\//g, `url("file://${R}/packages/client/src/fonts/web/`);
const katexCss = fs.readFileSync(R + '/node_modules/katex/dist/katex.css', 'utf8').replace(/url\(fonts\//g, `url(file://${R}/node_modules/katex/dist/fonts/`);
const rules = (id) => id === 'cm' ? '' : `
#s-${id} .katex { font-family: "OLM ${id}", KaTeX_Main, serif; }
#s-${id} .katex .mathnormal, #s-${id} .katex .mathit { font-family: "OLM ${id} It", KaTeX_Math; }
#s-${id} .katex .mathbf { font-family: "OLM ${id} Bf", KaTeX_Main; }
#s-${id} .katex .boldsymbol { font-family: "OLM ${id} BfIt", KaTeX_Math; }
#s-${id} .katex .amsrm { font-family: "OLM ${id} AMS", KaTeX_AMS; }
#s-${id} .katex :is(.mathbb, .textbb) { font-family: "OLM ${id} Bb", KaTeX_AMS; }
#s-${id} .katex .mathcal { font-family: "OLM ${id} Cal", KaTeX_Caligraphic; }
#s-${id} .katex :is(.mathfrak, .textfrak) { font-family: "OLM ${id} Frak", KaTeX_Fraktur; }
#s-${id} .katex .mathsf { font-family: "OLM ${id} Sf", KaTeX_SansSerif; }
#s-${id} .katex .mathtt { font-family: "OLM ${id} Tt", KaTeX_Typewriter; }
#s-${id} .katex .delimsizing.size1, #s-${id} .katex .op-symbol.small-op { font-family: "OLM ${id} S1", KaTeX_Size1; }
#s-${id} .katex .delimsizing.size2, #s-${id} .katex .op-symbol.large-op { font-family: "OLM ${id} S2", KaTeX_Size2; }
#s-${id} .katex .delimsizing.size3 { font-family: "OLM ${id} S3", KaTeX_Size3; }
#s-${id} .katex .delimsizing.size4 { font-family: "OLM ${id} S4", KaTeX_Size4; }`;
const all = ['cm', ...ids];
const html = `<!doctype html><meta charset=utf-8><style>${katexCss}${css}${all.map(rules).join('')} body{font:17px "OLT ${ids[0] ?? 'x'}", "CMU Serif", serif; width: 760px; margin: 10px} .s{border-bottom:1px solid #ccc; padding: 4px 0} .s h4{margin:0;font:12px sans-serif;color:#888}</style>` + all.map(id => `<div class=s id="s-${id}"><h4>${id}</h4>${body}</div>`).join('');
fs.writeFileSync(OUT + '/probe.html', html);
const b = await chromium.launch({ args: ['--allow-file-access-from-files'] });
const p = await b.newPage({ deviceScaleFactor: 1.5 });
await p.goto('file://' + OUT + '/probe.html');
await p.evaluate(() => document.fonts.ready);
await p.waitForTimeout(500);
await p.screenshot({ path: OUT + '/probe.png', fullPage: true });
await b.close();
