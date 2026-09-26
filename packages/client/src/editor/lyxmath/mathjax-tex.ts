/**
 * MathJax's TeX input for OverLyX: LyX's command set — MathJax's base, AMS, … packages plus the
 * commands below — for the renderer (mathjax.ts) and the scripts that check it
 * (scripts/gen-mathjax-macros.mjs, scripts/math-mathjax-check.ts). OverLyX's own commands:
 *  - `\htmlClass{cls}{…}`: an mrow with the class — always a box of its own (MathJax's `\class`
 *    puts the class on a lone child instead), except that an atom marker around a single character
 *    goes on the character. The editor's cell and atom markers (core/math/mathjax.ts) are these; an
 *    mrow is transparent to TeX's spacing. Also in `\text{…}`.
 *  - `\includegraphics[height=…]{file}`: the image as a glyph (macros drawn with a picture).
 *  - `\raisebox{lift}[height][depth]{…}`.
 *  - stmaryrd's `\llbracket` `\rrbracket` and `\llangle` `\rrangle`, as (stretchy) delimiters.
 *  - `\textsc{…}`; `\middle` inside the editor's cell boxes.
 *  - an undefined command shows its name (`lm-undefined`) instead of failing the whole formula.
 *  - the argument-less macros of the formula's document, looked up in the table passed with each
 *    formula (MathJax otherwise fixes its macros when the input jax is made).
 */
import { TeX } from '@mathjax/src/js/input/tex.js';
import { Configuration } from '@mathjax/src/js/input/tex/Configuration.js';
import { CommandMap, DelimiterMap } from '@mathjax/src/js/input/tex/TokenMap.js';
import { Macro } from '@mathjax/src/js/input/tex/Token.js';
import NodeUtil from '@mathjax/src/js/input/tex/NodeUtil.js';
import { ParseUtil } from '@mathjax/src/js/input/tex/ParseUtil.js';
import { UnitUtil } from '@mathjax/src/js/input/tex/UnitUtil.js';
import ParseMethods from '@mathjax/src/js/input/tex/ParseMethods.js';
import TexError from '@mathjax/src/js/input/tex/TexError.js';
import BaseMethods from '@mathjax/src/js/input/tex/base/BaseMethods.js';
import type TexParser from '@mathjax/src/js/input/tex/TexParser.js';
import { TEXCLASS, type MmlNode } from '@mathjax/src/js/core/MmlTree/MmlNode.js';
import '@mathjax/src/js/input/tex/base/BaseConfiguration.js';
import '@mathjax/src/js/input/tex/ams/AmsConfiguration.js';
import '@mathjax/src/js/input/tex/amscd/AmsCdConfiguration.js';
import '@mathjax/src/js/input/tex/newcommand/NewcommandConfiguration.js';
import '@mathjax/src/js/input/tex/configmacros/ConfigMacrosConfiguration.js';
import '@mathjax/src/js/input/tex/boldsymbol/BoldsymbolConfiguration.js';
import '@mathjax/src/js/input/tex/color/ColorConfiguration.js';
import '@mathjax/src/js/input/tex/cancel/CancelConfiguration.js';
import '@mathjax/src/js/input/tex/mathtools/MathtoolsConfiguration.js';
import '@mathjax/src/js/input/tex/extpfeil/ExtpfeilConfiguration.js';
import '@mathjax/src/js/input/tex/upgreek/UpgreekConfiguration.js';
import '@mathjax/src/js/input/tex/gensymb/GensymbConfiguration.js';
import '@mathjax/src/js/input/tex/centernot/CenternotConfiguration.js';
import '@mathjax/src/js/input/tex/units/UnitsConfiguration.js';
import '@mathjax/src/js/input/tex/textmacros/TextMacrosConfiguration.js';
import '@mathjax/src/js/input/tex/textcomp/TextcompConfiguration.js';
import { MATHJAX_BASE_MACROS } from '@overlyx/core';

/** the document macros of the formula being parsed: name (no backslash) → definition */
let currentMacros: Record<string, string> = {};
/** how the formula being parsed resolves an image file name to a URL */
let currentImage: ((src: string) => string) | null = null;
/** images whose shape the formula being parsed still waits for */
let imageWaits: Promise<void>[] = [];
/** undefined commands the formula being parsed uses */
let undefinedSeen: string[] = [];

/**
 * Runs `f` (a conversion) with the formula's document macros and image resolver in effect; returns
 * its result, the images whose shape it had to guess (render again once they have arrived) and
 * the undefined commands it met.
 */
export function withFormula<T>(macros: Record<string, string> | undefined, image: ((src: string) => string) | undefined, f: () => T): { value: T; images: Promise<void>[]; undefinedCommands: string[] } {
  currentMacros = macros ? stripKeys(macros) : {};
  currentImage = image ?? null;
  imageWaits = [];
  undefinedSeen = [];
  try {
    const value = f();
    return { value, images: imageWaits, undefinedCommands: undefinedSeen };
  } finally {
    currentMacros = {};
    currentImage = null;
    imageWaits = [];
    undefinedSeen = [];
  }
}

const keyCache = new WeakMap<Record<string, string>, Record<string, string>>();
function stripKeys(m: Record<string, string>): Record<string, string> {
  let hit = keyCache.get(m);
  if (!hit) { hit = Object.fromEntries(Object.entries(m).map(([k, v]) => [k.replace(/^\\/, ''), v])); keyCache.set(m, hit); }
  return hit;
}

/** Argument-less macros of the formula's own document (looked up per formula). */
class DocumentMacroMap extends CommandMap {
  lookup(token: string) {
    const def = Object.prototype.hasOwnProperty.call(currentMacros, token) ? currentMacros[token] : undefined;
    return (def === undefined ? undefined : new Macro(token, BaseMethods.Macro, [def, 0])) as Macro;
  }
  contains(token: string) { return Object.prototype.hasOwnProperty.call(currentMacros, token); }
}

/**
 * The parsed argument as the children of a new mrow with the class — or, for an atom (`lm-a`) that
 * is a single character, that token itself with the class: the same layout with one box fewer
 * (typing re-renders the whole formula; most atoms are characters).
 */
function classBox(parser: TexParser, cls: string, arg: MmlNode): MmlNode {
  if (cls === 'lm-a' && !NodeUtil.isInferred(arg) && arg.isToken && !arg.attributes.get('class')) {
    NodeUtil.setAttribute(arg, 'class', cls);
    return arg;
  }
  const mrow = parser.create('node', 'mrow') as MmlNode;
  // (only an inferred mrow is dissolved: a real one — \left…\right, a matrix — keeps its TeX class, INNER)
  if (NodeUtil.isInferred(arg)) NodeUtil.copyChildren(arg, mrow);
  else NodeUtil.appendChildren(mrow, [arg]);
  NodeUtil.setAttribute(mrow, 'class', cls);
  return mrow;
}

/** image files' width / height, once known (an image glyph is laid out square until then) */
const aspects = new Map<string, number>();
const aspectWaits = new Map<string, Promise<void>>();
function aspectOf(url: string): number | undefined {
  const known = aspects.get(url);
  if (known !== undefined) return known;
  if (typeof Image === 'undefined') return undefined;
  let wait = aspectWaits.get(url);
  if (!wait) {
    wait = new Promise<void>(resolve => {
      const img = new Image();
      img.onload = () => { aspects.set(url, img.naturalHeight ? img.naturalWidth / img.naturalHeight : 1); resolve(); };
      img.onerror = () => { aspects.set(url, 1); resolve(); };
      img.src = url;
    });
    aspectWaits.set(url, wait);
  }
  imageWaits.push(wait);
  return undefined;
}

/** TeX's em in math is the text font's, also in scripts; MathJax's scales with them: px (1em = 16px) does not */
const textEm = (em: number) => `${+(em * 16).toFixed(3)}px`;

const OverlyxMethods = {
  HtmlClass(parser: TexParser, name: string) {
    const cls = parser.GetArgument(name);
    parser.Push(classBox(parser, cls, parser.ParseArg(name)));
  },
  /** \includegraphics[height=…,width=…]{file}: the image as a glyph standing on the baseline */
  IncludeGraphics(parser: TexParser, name: string) {
    const opts = ParseUtil.keyvalOptions(parser.GetBrackets(name, '') ?? '');
    const file = parser.GetArgument(name).trim();
    const src = currentImage ? currentImage(file) : file;
    const len = (v: unknown) => (typeof v === 'string' && v.trim() ? UnitUtil.dimen2em(v.trim()) : 0);
    let h = len(opts.height) || len(opts.totalheight), w = len(opts.width);
    const aspect = h && w ? w / h : aspectOf(src);
    if (!h && !w) h = 0.7;
    if (!w) w = h * (aspect ?? 1);
    if (!h) h = w / (aspect ?? 1);
    const glyph = parser.create('node', 'mglyph', [], { src, width: textEm(w), height: textEm(h), alt: file }) as MmlNode;
    parser.Push(parser.create('node', 'TeXAtom', [glyph], { texClass: 0 }) as MmlNode);
  },
  /** \raisebox{lift}[height][depth]{text}: the text (math inside $…$) moved up */
  Raisebox(parser: TexParser, name: string) {
    const lift = parser.GetArgument(name).trim();
    const h = parser.GetBrackets(name, '');
    const d = parser.GetBrackets(name, '');
    const nodes = ParseUtil.internalMath(parser, parser.GetArgument(name), 0);
    const def: Record<string, string> = { voffset: lift };
    const up = !lift.startsWith('-'), amount = lift.replace(/^[+-]/, '');
    def.height = h || (up ? '+' : '-') + amount;
    def.depth = d || (up ? '-' : '+') + amount;
    parser.Push(parser.create('node', 'mpadded', nodes, def) as MmlNode);
  },
  /**
   * \middle: also inside a class box within \left…\right (the editor's cell around the content),
   * where MathJax's own finds no \left — a stretchy delimiter that grows with the cell's content.
   */
  Middle(parser: TexParser, name: string) {
    const delim = parser.GetDelimiter(name);
    const color = parser.stack.env.color as string | undefined;
    if (parser.stack.Top().isKind('left')) { parser.Push(parser.itemFactory.create('middle', delim, color)); return; }
    const def: Record<string, unknown> = { stretchy: true, symmetric: true, fence: true, texClass: TEXCLASS.ORD };
    if (color) def.mathcolor = color;
    parser.Push(parser.create('token', 'mo', def, delim) as MmlNode);
  },
  /** \textsc{…}: small capitals of the surrounding text font */
  TextSc(parser: TexParser, name: string) {
    const nodes = ParseUtil.internalMath(parser, parser.GetArgument(name), 0);
    const mrow = parser.create('node', 'mrow', nodes) as MmlNode;
    NodeUtil.setAttribute(mrow, 'class', 'lm-sc');
    parser.Push(mrow);
  },
};

// A relation at the start of an aligned column gets TeX's space before it: MathJax puts an empty
// ord in front when the cell starts with one (fixInitialMO) — it has to look inside the editor's
// cell box (and a \displaystyle around it) to see it.
{
  const util = ParseUtil as unknown as { fixInitialMO(config: unknown, nodes: MmlNode[]): void };
  const fix = util.fixInitialMO.bind(ParseUtil);
  const isCell = (n: MmlNode | undefined) => !!n && n.isKind('mrow') && /(?:^|\s)lm-c\d+(?:\s|$)/.test(String(n.attributes.get('class') ?? ''));
  util.fixInitialMO = (config, nodes) => {
    let box = nodes.length === 1 ? nodes[0] : undefined;
    if (box && box.isKind('mstyle') && box.childNodes.length === 1) box = box.childNodes[0] as MmlNode;
    if (!isCell(box)) { fix(config, nodes); return; }
    const kids = [...(box!.childNodes as MmlNode[])];
    fix(config, kids);
    if (kids.length > box!.childNodes.length) box!.setChildren(kids);
  };
}

new DocumentMacroMap('overlyx-document-macros', {});
new CommandMap('overlyx-macros', {
  htmlClass: OverlyxMethods.HtmlClass,
  includegraphics: OverlyxMethods.IncludeGraphics,
  raisebox: OverlyxMethods.Raisebox,
  textsc: OverlyxMethods.TextSc,
  middle: OverlyxMethods.Middle,
} as never);
new DelimiterMap('overlyx-delimiters', ParseMethods.delimiter as never, {
  '\\llbracket': '⟦', '\\rrbracket': '⟧', '\\llangle': '⟪', '\\rrangle': '⟫',
} as never);
// inside \text{…}: the same class boxes around text (every character of a text cell is an atom)
new CommandMap('text-overlyx-macros', {
  htmlClass(parser: TexParser, name: string) {
    const p = parser as TexParser & { saveText(): void; ParseTextArg(name: string, env: object): MmlNode };
    p.saveText();
    const cls = parser.GetArgument(name);
    parser.Push(classBox(parser, cls, p.ParseTextArg(name, {})));
  },
  textsc(parser: TexParser, name: string) {
    const p = parser as TexParser & { saveText(): void; ParseTextArg(name: string, env: object): MmlNode };
    p.saveText();
    parser.Push(classBox(parser, 'lm-sc', p.ParseTextArg(name, {})));
  },
} as never);
Configuration.create('text-overlyx', { parser: 'text', handler: { macro: ['text-overlyx-macros'] } } as never);
/** an undefined command: its name in red (`lm-undefined`), or an error for the checking scripts (option overlyx.strict) */
function undefinedCommand(parser: TexParser, name: string) {
  if ((parser.options as { overlyx?: { strict?: boolean } }).overlyx?.strict) throw new TexError('UndefinedControlSequence', 'Undefined control sequence %1', '\\' + name);
  undefinedSeen.push(name);
  const mtext = parser.create('node', 'mtext', [], { class: 'lm-undefined' }, parser.create('text', '\\' + name)) as MmlNode;
  parser.Push(mtext);
}

Configuration.create('overlyx', {
  // before MathJax's own packages (priority 5): OverLyX's commands and fallback win
  priority: 3,
  handler: { macro: ['overlyx-macros', 'overlyx-delimiters'], delimiter: ['overlyx-delimiters'] },
  fallback: { macro: undefinedCommand },
  options: { overlyx: { strict: false } },
  config: (_config: unknown, jax: TeX<unknown, unknown, unknown>) => {
    // the document's macros before MathJax's own commands (a document may redefine them), after \def / \newcommand in the formula itself
    jax.parseOptions.handlers.add({ character: [], delimiter: [], macro: ['overlyx-document-macros'], environment: [] } as never, {}, -90);
  },
} as never);

/** MathJax's TeX packages for LyX's command set, OverLyX's own last */
export const TEX_PACKAGES = ['base', 'ams', 'amscd', 'newcommand', 'configmacros', 'boldsymbol', 'color', 'cancel', 'mathtools', 'extpfeil',
  'upgreek', 'gensymb', 'centernot', 'units', 'textmacros', 'textcomp', 'overlyx'];

/**
 * A TeX input jax for OverLyX's formulas. `throwErrors` (default): a TeX error throws (the caller
 * shows the formula's source) instead of becoming MathJax's red error box. `macros`: LyX's
 * predefined macros MathJax lacks (core's MATHJAX_BASE_MACROS by default). `strict`: an undefined
 * command is an error too.
 */
export function makeTexInput(opts: { throwErrors?: boolean; packages?: string[]; macros?: Record<string, string>; strict?: boolean } = {}): TeX<unknown, unknown, unknown> {
  return new TeX({
    overlyx: { strict: !!opts.strict },
    packages: opts.packages ?? TEX_PACKAGES,
    macros: stripKeys(opts.macros ?? MATHJAX_BASE_MACROS),
    // the editor's markup makes long sources; MathJax's defaults are for hand-written formulas
    maxBuffer: 1 << 22, maxMacros: 20000,
    textmacros: { packages: ['text-base', 'text-overlyx'] },
    ...(opts.throwErrors === false ? {} : { formatError: (_jax: unknown, err: Error) => { throw err; } }),
  } as never);
}
