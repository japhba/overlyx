/**
 * MathJax for the unit tests (node): OverLyX's TeX input (client/editor/lyxmath/mathjax-tex.ts)
 * with MathJax's lite DOM. `toMathml` parses a source into MathML — strictly, an undefined command
 * or a TeX error throws; `toChtml` lays it out with the default font (awaiting its font data).
 */
import { mathjax } from '@mathjax/src/js/mathjax.js';
import { liteAdaptor } from '@mathjax/src/js/adaptors/liteAdaptor.js';
import { RegisterHTMLHandler } from '@mathjax/src/js/handlers/html.js';
import { CHTML } from '@mathjax/src/js/output/chtml.js';
import { STATE } from '@mathjax/src/js/core/MathItem.js';
import { SerializedMmlVisitor } from '@mathjax/src/js/core/MmlTree/SerializedMmlVisitor.js';
import { MathJaxNewcmFont } from '@mathjax/mathjax-newcm-font/js/chtml.js';
import type { MmlNode } from '@mathjax/src/js/core/MmlTree/MmlNode.js';
import { makeTexInput, withFormula } from '../packages/client/src/editor/lyxmath/mathjax-tex.ts';

const adaptor = liteAdaptor();
RegisterHTMLHandler(adaptor);
mathjax.asyncLoad = (file: string) => import(file.replace(/^(@mathjax\/[^/]+)\/js\//, '$1/mjs/').replace(/(?<!\.js)$/, '.js'));
const mmlDoc = mathjax.document('', { InputJax: makeTexInput({ strict: true }) });
const htmlDoc = mathjax.document('', { InputJax: makeTexInput({ strict: true }), OutputJax: new CHTML({ fontData: MathJaxNewcmFont, linebreaks: { inline: false } } as never) });
const serializer = new SerializedMmlVisitor();

/** The MathML of a source (with the document macros of `macros`); throws on a TeX error or an undefined command. */
export function toMathml(tex: string, macros?: Record<string, string>, display = false): string {
  return withFormula(macros, undefined, () => serializer.visitTree(mmlDoc.convert(tex, { display, end: STATE.COMPILED }) as MmlNode)).value;
}

/** The CHTML markup of a source (lite DOM; font data loaded as needed). */
export async function toChtml(tex: string, macros?: Record<string, string>, image?: (src: string) => string): Promise<string> {
  const node = await mathjax.handleRetriesFor(() => withFormula(macros, image, () => htmlDoc.convert(tex, { display: false })).value);
  return adaptor.outerHTML(node as never);
}
