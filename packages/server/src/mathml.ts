/**
 * TeX as MathML, with the TeX kept in it (an `application/x-tex` annotation): how a formula is
 * written into an HTML article whose page shows its math rendered ahead of time — KaTeX's or
 * MathJax's output, no script that would typeset TeX (core html/article.ts writeArticlePreserving).
 * Every current browser shows MathML by itself, and the article's parser reads the TeX back.
 */
import { mathjax } from '@mathjax/src/js/mathjax.js';
import { TeX } from '@mathjax/src/js/input/tex.js';
import { liteAdaptor } from '@mathjax/src/js/adaptors/liteAdaptor.js';
import { RegisterHTMLHandler } from '@mathjax/src/js/handlers/html.js';
import { SerializedMmlVisitor } from '@mathjax/src/js/core/MmlTree/SerializedMmlVisitor.js';
import { STATE } from '@mathjax/src/js/core/MathItem.js';
import type { MmlNode } from '@mathjax/src/js/core/MmlTree/MmlNode.js';
import '@mathjax/src/js/input/tex/base/BaseConfiguration.js';
import '@mathjax/src/js/input/tex/ams/AmsConfiguration.js';
import '@mathjax/src/js/input/tex/newcommand/NewcommandConfiguration.js';
import '@mathjax/src/js/input/tex/boldsymbol/BoldsymbolConfiguration.js';
import '@mathjax/src/js/input/tex/color/ColorConfiguration.js';
import '@mathjax/src/js/input/tex/cancel/CancelConfiguration.js';
import '@mathjax/src/js/input/tex/mathtools/MathtoolsConfiguration.js';
import '@mathjax/src/js/input/tex/textmacros/TextMacrosConfiguration.js';
import '@mathjax/src/js/input/tex/noundefined/NoUndefinedConfiguration.js';

let convert: ((tex: string, display: boolean) => MmlNode) | null = null;
const visitor = new SerializedMmlVisitor();
const escText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** `tex` (no delimiters; a display environment whole) as a <math> element; null: TeX MathJax cannot read */
export function texToMathML(tex: string, display: boolean): string | null {
  if (!convert) {
    RegisterHTMLHandler(liteAdaptor());
    const doc = mathjax.document('', { InputJax: new TeX({ packages: ['base', 'ams', 'newcommand', 'boldsymbol', 'color', 'cancel', 'mathtools', 'textmacros', 'noundefined'] }) });
    convert = (t, d) => doc.convert(t, { display: d, end: STATE.CONVERT }) as MmlNode;
  }
  let mml: string;
  try { mml = visitor.visitTree(convert(tex, display)); } catch { return null; }
  if (/<merror\b/.test(mml)) return null;
  // one line, without MathJax's TeX of every part; the TeX beside the rendering
  const m = /^<math([^>]*)>([\s\S]*)<\/math>$/.exec(mml.replace(/\n\s*/g, '').replace(/ data-latex="[^"]*"/g, ''));
  if (!m) return null;
  return `<math${m[1]}><semantics><mrow>${m[2]}</mrow><annotation encoding="application/x-tex">${escText(tex)}</annotation></semantics></math>`;
}
