/**
 * OverLyX — parser for LyX layout files (lib/layouts/*.layout, *.inc, *.module).
 *
 * Produces a `DocumentClass` description that the LaTeX exporter and the UI use:
 * paragraph styles (with their LaTeX type / name / arguments / preamble),
 * inset layouts (Flex:*, Note:*, ...), float definitions, counters and the
 * class-level settings (options, requires, provides, preamble, ...).
 *
 * The grammar follows src/TextClass.cpp / src/Layout.cpp / src/insets/InsetLayout.cpp
 * closely enough for the export use case; unknown keys are kept in `props`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

/* ------------------------------------------------------------------ types */

export type LatexType = 'Paragraph' | 'Command' | 'Environment' | 'Item_Environment' | 'List_Environment' | 'Bib_Environment';

export type LabelType =
  | 'No_Label' | 'Manual' | 'Static' | 'Above' | 'Centered' | 'Sensitive'
  | 'Enumerate' | 'Itemize' | 'Bibliography';

export interface LayoutFont {
  family?: string;   // roman | sans | typewriter
  series?: string;   // medium | bold
  shape?: string;    // up | italic | slanted | smallcaps
  size?: string;     // tiny ... giant
  color?: string;
  misc?: string[];   // emph, noun, underbar ...
}

export interface ArgumentSpec {
  /** Argument id as used in the layout: "1", "2", "item:1", "listpreamble:1", "post:1" */
  id: string;
  labelString: string;
  menuString: string;
  tooltip: string;
  mandatory: boolean;
  nodelims: boolean;
  leftDelim: string;
  rightDelim: string;
  presetArg: string;
  defaultArg: string;
  decoration: string;
  passThru: boolean;
  passThruChars: string;
  freeSpacing: boolean;
  requires: string[];
  isTocCaption: boolean;
  insertCotext: boolean;
  autoInsert: boolean;
  newlineCmd: string;
  font?: LayoutFont;
  labelFont?: LayoutFont;
}

export interface LayoutStyle {
  name: string;
  latexType: LatexType;
  latexName: string;
  latexParam: string;
  itemCommand: string;
  labelType: LabelType;
  labelString: string;
  labelStringAppendix: string;
  labelCounter: string;
  category: string;
  tocLevel: number;
  nextNoIndent: boolean;
  keepEmpty: boolean;
  passThru: boolean;
  passThruChars: string;
  freeSpacing: boolean;
  parbreakIsNewline: boolean;
  needProtect: boolean;
  needCProtect: boolean;
  needMBoxProtect: boolean;
  inTitle: boolean;
  inPreamble: boolean;
  resetArgs: boolean;
  align: string;          // block | left | right | center
  alignPossible: string[];
  toggleIndent: string;   // default | always | never
  leftDelim: string;
  rightDelim: string;
  preamble: string;
  langPreamble: string;
  babelPreamble: string;
  requires: string[];
  refPrefix: string;
  font: LayoutFont;
  labelFont: LayoutFont;
  args: Map<string, ArgumentSpec>;
  obsoletedBy?: string;
  dependsOn?: string;
  /** Raw single-line properties that were not interpreted (lower-cased key). */
  props: Map<string, string>;
}

export interface InsetLayout {
  name: string;
  lyxType: string;        // charstyle | custom | element | end | standard
  latexType: 'none' | 'command' | 'environment';
  latexName: string;
  latexParam: string;
  decoration: string;
  labelString: string;
  preamble: string;
  langPreamble: string;
  babelPreamble: string;
  requires: string[];
  passThru: boolean;
  passThruChars: string;
  freeSpacing: boolean;
  parbreakIsNewline: boolean;
  parbreakIgnored: boolean;
  keepEmpty: boolean;
  multiPar: boolean;
  customPars: boolean;
  forcePlain: boolean;
  forceOwnlines: boolean;
  forceLocalFontSwitch: boolean;
  display: boolean;
  needProtect: boolean;
  needCProtect: boolean;
  needMBoxProtect: boolean;
  inToc: boolean;
  leftDelim: string;
  rightDelim: string;
  newlineCmd: string;
  font: LayoutFont;
  labelFont: LayoutFont;
  args: Map<string, ArgumentSpec>;
  obsoletedBy?: string;
  props: Map<string, string>;
}

export interface FloatSpec {
  type: string;
  guiName: string;
  placement: string;
  extension: string;
  numberWithin: string;
  style: string;
  listName: string;
  isPredefined: boolean;
  usesFloatPkg: boolean;
  listCommand: string;
  refPrefix: string;
  allowedPlacement: string;
  allowsSideways: boolean;
  allowsWide: boolean;
  requires: string[];
}

export interface CounterSpec {
  name: string;
  within: string;
  labelString: string;
  labelStringAppendix: string;
  prettyFormat: string;
  guiName: string;
  latexName: string;
  initialValue: string;
}

export interface DocumentClass {
  /** LyX textclass name (layout file basename) */
  name: string;
  /** LaTeX class name (\DeclareLaTeXClass[...]) */
  latexName: string;
  /** Description (\DeclareLaTeXClass{...}) */
  description: string;
  category: string;
  /** Extra packages the class needs (from \DeclareLaTeXClass[cls,pkg.sty,...]) */
  classPackages: string[];
  /** ClassOptions Other */
  options: string;
  fontSizes: string[];
  fontSizeFormat: string;
  pageSizes: string[];
  pageSizeFormat: string;
  pageStyles: string[];
  columns: number;
  sides: number;
  secNumDepth: number;
  tocDepth: number;
  defaultStyle: string;
  titleLatexName: string;
  titleLatexType: 'CommandAfter' | 'Environment';
  preamble: string;
  provides: Set<string>;
  requires: string[];
  packageOptions: Map<string, string>;
  styles: Map<string, LayoutStyle>;
  insetLayouts: Map<string, InsetLayout>;
  floats: Map<string, FloatSpec>;
  counters: Map<string, CounterSpec>;
  defaultFont: LayoutFont;
  bibInToc: boolean;
  modules: string[];
  /** Names of layout/module files that were read (for diagnostics) */
  sources: string[];
  warnings: string[];
}

/* ---------------------------------------------------------------- helpers */

const LATEX_TYPES: Record<string, LatexType> = {
  paragraph: 'Paragraph', command: 'Command', environment: 'Environment',
  item_environment: 'Item_Environment', list_environment: 'List_Environment', bib_environment: 'Bib_Environment',
};

const LABEL_TYPES: Record<string, LabelType> = {
  no_label: 'No_Label', manual: 'Manual', static: 'Static', above: 'Above', centered: 'Centered',
  sensitive: 'Sensitive', enumerate: 'Enumerate', itemize: 'Itemize', bibliography: 'Bibliography',
  // legacy names
  top_environment: 'Above', centered_top_environment: 'Centered', counter: 'Static',
};

function isTrue(v: string): boolean {
  const l = v.trim().toLowerCase();
  return l === '1' || l === 'true' || l === 'yes' || l === 'on';
}

/** Split a layout line into tokens, honouring double quotes and stripping # comments. */
function tokenize(line: string): string[] {
  const out: string[] = [];
  let i = 0;
  const n = line.length;
  while (i < n) {
    const c = line[i];
    if (c === ' ' || c === '\t') { i++; continue; }
    if (c === '#') break;
    if (c === '"') {
      let j = i + 1; let s = '';
      while (j < n && line[j] !== '"') { s += line[j]; j++; }
      out.push(s);
      i = j + 1;
      continue;
    }
    let j = i;
    while (j < n && line[j] !== ' ' && line[j] !== '\t') j++;
    out.push(line.slice(i, j));
    i = j;
  }
  return out;
}

/** Rest of the line after the first token, unquoted if quoted. */
function valueOf(line: string): string {
  const t = line.trim();
  const m = /^\S+\s*(.*)$/.exec(t);
  const rest = (m ? m[1] : '').trim();
  if (rest.startsWith('"')) {
    const end = rest.indexOf('"', 1);
    return end < 0 ? rest.slice(1) : rest.slice(1, end);
  }
  // strip trailing comment
  const hash = rest.indexOf('#');
  return (hash >= 0 ? rest.slice(0, hash) : rest).trim();
}

function firstToken(line: string): string {
  const t = line.trim();
  const sp = t.search(/\s/);
  return (sp < 0 ? t : t.slice(0, sp)).toLowerCase();
}

function newStyle(name: string): LayoutStyle {
  return {
    name, latexType: 'Paragraph', latexName: 'dummy', latexParam: '', itemCommand: 'item',
    labelType: 'No_Label', labelString: '', labelStringAppendix: '', labelCounter: '', category: '',
    tocLevel: -1000, nextNoIndent: false, keepEmpty: false, passThru: false, passThruChars: '', freeSpacing: false,
    parbreakIsNewline: false, needProtect: false, needCProtect: false, needMBoxProtect: false, inTitle: false,
    inPreamble: false, resetArgs: false, align: 'block', alignPossible: [], toggleIndent: 'default',
    leftDelim: '', rightDelim: '', preamble: '', langPreamble: '', babelPreamble: '', requires: [], refPrefix: '',
    font: {}, labelFont: {}, args: new Map(), props: new Map(),
  };
}

function newInsetLayout(name: string): InsetLayout {
  return {
    name, lyxType: 'standard', latexType: 'none', latexName: '', latexParam: '', decoration: 'default', labelString: '',
    preamble: '', langPreamble: '', babelPreamble: '', requires: [], passThru: false, passThruChars: '', freeSpacing: false,
    parbreakIsNewline: false, parbreakIgnored: false, keepEmpty: false, multiPar: true, customPars: true, forcePlain: false,
    forceOwnlines: false, forceLocalFontSwitch: false, display: true, needProtect: false, needCProtect: false,
    needMBoxProtect: false, inToc: false, leftDelim: '', rightDelim: '', newlineCmd: '', font: {}, labelFont: {},
    args: new Map(), props: new Map(),
  };
}

function newArgument(id: string): ArgumentSpec {
  return {
    id, labelString: '', menuString: '', tooltip: '', mandatory: false, nodelims: false, leftDelim: '', rightDelim: '',
    presetArg: '', defaultArg: '', decoration: '', passThru: false, passThruChars: '', freeSpacing: false, requires: [],
    isTocCaption: false, insertCotext: false, autoInsert: false, newlineCmd: '',
  };
}

function cloneFont(f: LayoutFont): LayoutFont { return { ...f, misc: f.misc ? [...f.misc] : undefined }; }

function cloneArgs(m: Map<string, ArgumentSpec>): Map<string, ArgumentSpec> {
  const out = new Map<string, ArgumentSpec>();
  for (const [k, v] of m) out.set(k, { ...v, requires: [...v.requires], font: v.font && cloneFont(v.font), labelFont: v.labelFont && cloneFont(v.labelFont) });
  return out;
}

function cloneStyle(s: LayoutStyle, name: string): LayoutStyle {
  return {
    ...s, name, requires: [...s.requires], alignPossible: [...s.alignPossible],
    font: cloneFont(s.font), labelFont: cloneFont(s.labelFont), args: cloneArgs(s.args), props: new Map(s.props),
  };
}

function cloneInsetLayout(s: InsetLayout, name: string): InsetLayout {
  return { ...s, name, requires: [...s.requires], font: cloneFont(s.font), labelFont: cloneFont(s.labelFont), args: cloneArgs(s.args), props: new Map(s.props) };
}

function splitList(v: string): string[] {
  return v.split(',').map(s => s.trim()).filter(Boolean);
}

/* ---------------------------------------------------------------- reader */

class LineReader {
  pos = 0;
  constructor(public lines: string[], public file: string) {}
  get done(): boolean { return this.pos >= this.lines.length; }
  next(): string { return this.lines[this.pos++]; }
  peek(): string { return this.lines[this.pos]; }
  /** Collect raw lines until a line whose first token equals `end` (case-insensitive). */
  block(end: string): string {
    const out: string[] = [];
    const e = end.toLowerCase();
    while (!this.done) {
      const l = this.next();
      if (firstToken(l) === e) break;
      out.push(l);
    }
    // Like Lexer::getLongString: remove the indentation of the first line from all lines.
    const first = out.find(l => l.trim() !== '');
    const prefix = first ? /^[ \t]*/.exec(first)![0] : '';
    const stripped = out.map(l => (prefix && l.startsWith(prefix) ? l.slice(prefix.length) : l.replace(/^[ \t]+/, '')));
    return stripped.join('\n') + (out.length ? '\n' : '');
  }
}

/** Keys that open a multi-line block terminated by a specific end token. */
const BLOCK_END: Record<string, string> = {
  preamble: 'endpreamble', langpreamble: 'endlangpreamble', babelpreamble: 'endbabelpreamble',
  htmlpreamble: 'endpreamble', htmlstyle: 'endhtmlstyle', addtopreamble: 'endpreamble',
  addtohtmlpreamble: 'endpreamble', htmlstyles: 'endstyles', addtohtmlstyles: 'endstyles',
  docbookpreamble: 'enddocbookpreamble',
};

function readFont(r: LineReader): LayoutFont {
  const f: LayoutFont = {};
  while (!r.done) {
    const l = r.next();
    const k = firstToken(l);
    if (k === 'endfont') break;
    const v = valueOf(l).toLowerCase();
    switch (k) {
      case 'family': f.family = v; break;
      case 'series': f.series = v; break;
      case 'shape': f.shape = v; break;
      case 'size': f.size = v; break;
      case 'color': f.color = v; break;
      case 'misc': (f.misc ??= []).push(v); break;
      default: break;
    }
  }
  return f;
}

function readArgument(r: LineReader, id: string, existing?: ArgumentSpec): ArgumentSpec {
  const a = existing ?? newArgument(id);
  while (!r.done) {
    const l = r.next();
    const k = firstToken(l);
    if (k === 'endargument') break;
    if (k === '' ) continue;
    const v = valueOf(l);
    switch (k) {
      case 'labelstring': a.labelString = v; break;
      case 'menustring': a.menuString = v; break;
      case 'tooltip': a.tooltip = v; break;
      case 'mandatory': a.mandatory = isTrue(v); break;
      case 'nodelims': a.nodelims = isTrue(v); break;
      case 'leftdelim': a.leftDelim = v.replace(/<br\/>/g, '\n'); break;
      case 'rightdelim': a.rightDelim = v.replace(/<br\/>/g, '\n'); break;
      case 'presetarg': a.presetArg = v; break;
      case 'defaultarg': a.defaultArg = v; break;
      case 'decoration': a.decoration = v; break;
      case 'passthru': a.passThru = isTrue(v); break;
      case 'passthruchars': a.passThruChars = v; break;
      case 'freespacing': a.freeSpacing = isTrue(v); break;
      case 'requires': a.requires = splitList(v); break;
      case 'istoccaption': a.isTocCaption = isTrue(v); break;
      case 'insertcotext': a.insertCotext = isTrue(v); break;
      case 'autoinsert': a.autoInsert = isTrue(v); break;
      case 'newlinecmd': a.newlineCmd = v; break;
      case 'font': a.font = readFont(r); break;
      case 'labelfont': a.labelFont = readFont(r); break;
      default: break;
    }
  }
  return a;
}

/** Parse the body of a Style block (until `End`). */
function readStyle(r: LineReader, s: LayoutStyle, dc: DocumentClass): void {
  while (!r.done) {
    const l = r.next();
    const k = firstToken(l);
    if (k === 'end') break;
    if (k === '' || k.startsWith('#')) continue;
    const v = valueOf(l);
    const vl = v.toLowerCase();
    if (BLOCK_END[k]) {
      const text = r.block(BLOCK_END[k]);
      if (k === 'preamble') s.preamble = text;
      else if (k === 'langpreamble') s.langPreamble = text;
      else if (k === 'babelpreamble') s.babelPreamble = text;
      continue;
    }
    switch (k) {
      case 'copystyle': {
        const src = dc.styles.get(v.replace(/_/g, ' '));
        if (src) {
          const name = s.name;
          Object.assign(s, cloneStyle(src, name));
        } else dc.warnings.push(`CopyStyle: unknown style '${v}' in ${r.file}`);
        break;
      }
      case 'obsoletedby': s.obsoletedBy = v.replace(/_/g, ' '); break;
      case 'dependson': s.dependsOn = v.replace(/_/g, ' '); break;
      case 'latextype': s.latexType = LATEX_TYPES[vl] ?? s.latexType; break;
      case 'latexname': s.latexName = v; break;
      case 'latexparam': s.latexParam = l.trim().replace(/^\S+\s*/, '').replace(/&quot;/g, '"').trim(); break;
      case 'itemcommand': s.itemCommand = v; break;
      case 'labeltype': s.labelType = LABEL_TYPES[vl] ?? s.labelType; break;
      case 'labelstring': s.labelString = v; break;
      case 'labelstringappendix': s.labelStringAppendix = v; break;
      case 'labelcounter': s.labelCounter = v; break;
      case 'category': s.category = v; break;
      case 'toclevel': s.tocLevel = parseInt(v, 10); break;
      case 'nextnoindent': s.nextNoIndent = isTrue(v); break;
      case 'keepempty': s.keepEmpty = isTrue(v); break;
      case 'passthru': s.passThru = isTrue(v); break;
      case 'passthruchars': s.passThruChars = v; break;
      case 'freespacing': s.freeSpacing = isTrue(v); break;
      case 'parbreakisnewline': s.parbreakIsNewline = isTrue(v); break;
      case 'needprotect': s.needProtect = isTrue(v); break;
      case 'needcprotect': s.needCProtect = isTrue(v); break;
      case 'needmboxprotect': s.needMBoxProtect = isTrue(v); break;
      case 'intitle': s.inTitle = isTrue(v); break;
      case 'inpreamble': s.inPreamble = isTrue(v); break;
      case 'resetargs': s.resetArgs = isTrue(v); if (s.resetArgs) s.args = new Map(); break;
      case 'align': s.align = vl; break;
      case 'alignpossible': s.alignPossible = splitList(vl); break;
      case 'toggleindent': s.toggleIndent = vl; break;
      case 'leftdelim': s.leftDelim = v.replace(/<br\/>/g, '\n'); break;
      case 'rightdelim': s.rightDelim = v.replace(/<br\/>/g, '\n'); break;
      case 'requires': s.requires = splitList(v); break;
      case 'refprefix': s.refPrefix = v; break;
      case 'font': s.font = readFont(r); break;
      case 'labelfont': s.labelFont = readFont(r); break;
      case 'textfont': s.font = readFont(r); break;
      case 'argument': {
        const id = v;
        s.args.set(id, readArgument(r, id, s.args.get(id)));
        break;
      }
      default:
        s.props.set(k, v);
    }
  }
}

function readInsetLayout(r: LineReader, il: InsetLayout, dc: DocumentClass): void {
  while (!r.done) {
    const l = r.next();
    const k = firstToken(l);
    if (k === 'end') break;
    if (k === '' || k.startsWith('#')) continue;
    const v = valueOf(l);
    const vl = v.toLowerCase();
    if (BLOCK_END[k]) {
      const text = r.block(BLOCK_END[k]);
      if (k === 'preamble') il.preamble = text;
      else if (k === 'langpreamble') il.langPreamble = text;
      else if (k === 'babelpreamble') il.babelPreamble = text;
      continue;
    }
    switch (k) {
      case 'copystyle': {
        const src = dc.insetLayouts.get(v.replace(/_/g, ' '));
        if (src) Object.assign(il, cloneInsetLayout(src, il.name));
        else dc.warnings.push(`InsetLayout CopyStyle: unknown '${v}' in ${r.file}`);
        break;
      }
      case 'obsoletedby': il.obsoletedBy = v.replace(/_/g, ' '); break;
      case 'lyxtype': il.lyxType = vl; break;
      case 'latextype': il.latexType = vl === 'command' ? 'command' : vl === 'environment' ? 'environment' : 'none'; break;
      case 'latexname': il.latexName = v; break;
      case 'latexparam': il.latexParam = l.trim().replace(/^\S+\s*/, '').replace(/&quot;/g, '"').trim(); break;
      case 'decoration': il.decoration = vl; break;
      case 'labelstring': il.labelString = v; break;
      case 'requires': il.requires = splitList(v); break;
      case 'passthru': il.passThru = isTrue(v); break;
      case 'passthruchars': il.passThruChars = v; break;
      case 'freespacing': il.freeSpacing = isTrue(v); break;
      case 'parbreakisnewline': il.parbreakIsNewline = isTrue(v); break;
      case 'parbreakignored': il.parbreakIgnored = isTrue(v); break;
      case 'keepempty': il.keepEmpty = isTrue(v); break;
      case 'multipar': il.multiPar = isTrue(v); il.customPars = il.multiPar; il.forcePlain = !il.multiPar; break;
      case 'custompars': il.customPars = isTrue(v); break;
      case 'forceplain': il.forcePlain = isTrue(v); break;
      case 'forceownlines': il.forceOwnlines = isTrue(v); break;
      case 'forcelocalfontswitch': il.forceLocalFontSwitch = isTrue(v); break;
      case 'display': il.display = isTrue(v); break;
      case 'needprotect': il.needProtect = isTrue(v); break;
      case 'needcprotect': il.needCProtect = isTrue(v); break;
      case 'needmboxprotect': il.needMBoxProtect = isTrue(v); break;
      case 'intoc': il.inToc = isTrue(v); break;
      case 'leftdelim': il.leftDelim = v.replace(/<br\/>/g, '\n'); break;
      case 'rightdelim': il.rightDelim = v.replace(/<br\/>/g, '\n'); break;
      case 'newlinecmd': il.newlineCmd = v; break;
      case 'font': il.font = readFont(r); break;
      case 'labelfont': il.labelFont = readFont(r); break;
      case 'resetargs': if (isTrue(v)) il.args = new Map(); break;
      case 'argument': il.args.set(v, readArgument(r, v, il.args.get(v))); break;
      default: il.props.set(k, v);
    }
  }
}

function readFloat(r: LineReader, dc: DocumentClass): void {
  const f: FloatSpec = {
    type: '', guiName: '', placement: '', extension: '', numberWithin: '', style: '', listName: '',
    isPredefined: false, usesFloatPkg: true, listCommand: '', refPrefix: '', allowedPlacement: '!htbpH',
    allowsSideways: true, allowsWide: true, requires: [],
  };
  while (!r.done) {
    const l = r.next();
    const k = firstToken(l);
    if (k === 'end') break;
    if (k === '' || k.startsWith('#')) continue;
    const v = valueOf(l);
    if (BLOCK_END[k]) { r.block(BLOCK_END[k]); continue; }
    switch (k) {
      case 'type': f.type = v; break;
      case 'guiname': f.guiName = v; break;
      case 'placement': f.placement = v; break;
      case 'extension': f.extension = v; break;
      case 'numberwithin': f.numberWithin = v === 'none' ? '' : v; break;
      case 'style': f.style = v; break;
      case 'listname': f.listName = v; break;
      case 'ispredefined': f.isPredefined = isTrue(v); break;
      case 'usesfloatpkg': f.usesFloatPkg = isTrue(v); break;
      case 'listcommand': f.listCommand = v; break;
      case 'refprefix': f.refPrefix = v; break;
      case 'allowedplacement': f.allowedPlacement = v === 'none' ? '' : v; break;
      case 'allowssideways': f.allowsSideways = isTrue(v); break;
      case 'allowswide': f.allowsWide = isTrue(v); break;
      case 'requires': f.requires = splitList(v); break;
      default: break;
    }
  }
  if (f.type) {
    const prev = dc.floats.get(f.type);
    if (prev) {
      // merging: unset fields keep previous values
      dc.floats.set(f.type, { ...prev, ...Object.fromEntries(Object.entries(f).filter(([, val]) => val !== '' && !(Array.isArray(val) && val.length === 0))) } as FloatSpec);
    } else dc.floats.set(f.type, f);
  }
}

function readCounter(r: LineReader, name: string, dc: DocumentClass): void {
  const c: CounterSpec = dc.counters.get(name) ?? {
    name, within: '', labelString: '', labelStringAppendix: '', prettyFormat: '', guiName: '', latexName: name, initialValue: '',
  };
  while (!r.done) {
    const l = r.next();
    const k = firstToken(l);
    if (k === 'end') break;
    if (k === '' || k.startsWith('#')) continue;
    const v = valueOf(l);
    switch (k) {
      case 'within': c.within = v === 'none' ? '' : v; break;
      case 'labelstring': c.labelString = v; break;
      case 'labelstringappendix': c.labelStringAppendix = v; break;
      case 'prettyformat': c.prettyFormat = v; break;
      case 'guiname': c.guiName = v; break;
      case 'latexname': c.latexName = v; break;
      case 'initialvalue': c.initialValue = v; break;
      default: break;
    }
  }
  dc.counters.set(name, c);
}

function readClassOptions(r: LineReader, dc: DocumentClass): void {
  while (!r.done) {
    const l = r.next();
    const k = firstToken(l);
    if (k === 'end') break;
    const v = valueOf(l);
    switch (k) {
      case 'fontsize': dc.fontSizes = v.split('|').map(s => s.trim()); break;
      case 'fontsizeformat': dc.fontSizeFormat = v; break;
      case 'pagesize': dc.pageSizes = v.split('|').map(s => s.trim()); break;
      case 'pagesizeformat': dc.pageSizeFormat = v; break;
      case 'pagestyle': dc.pageStyles = v.split('|').map(s => s.trim()); break;
      case 'other': dc.options = v; break;
      default: break;
    }
  }
}

/** Skip an unknown `... End` block. */
function skipBlock(r: LineReader): void {
  while (!r.done) {
    const l = r.next();
    if (firstToken(l) === 'end') break;
  }
}

/* ------------------------------------------------------------- main read */

function readLayoutFile(file: string, dc: DocumentClass, seen: Set<string>): void {
  if (seen.has(file)) return;
  seen.add(file);
  if (!existsSync(file)) { dc.warnings.push(`layout file not found: ${file}`); return; }
  dc.sources.push(file);
  const text = readFileSync(file, 'utf8');
  const r = new LineReader(text.split(/\r?\n/), file);
  const dir = join(file, '..');

  while (!r.done) {
    const l = r.next();
    const trimmed = l.trim();
    if (trimmed === '') continue;
    if (trimmed.startsWith('#')) {
      // class declaration comment
      const m = /\\DeclareLaTeXClass(?:\[([^\]]*)\])?\{([^}]*)\}/.exec(trimmed);
      if (m && file.endsWith('.layout') && dc.name === basename(file, '.layout')) {
        dc.description = m[2];
        if (m[1]) {
          const parts = m[1].split(',').map(s => s.trim()).filter(Boolean);
          if (parts.length) { dc.latexName = parts[0]; dc.classPackages = parts.slice(1); }
        }
      }
      const cat = /\\DeclareCategory\{([^}]*)\}/.exec(trimmed);
      if (cat && !dc.category) dc.category = cat[1];
      continue;
    }
    const k = firstToken(l);
    const v = valueOf(l);
    if (BLOCK_END[k]) {
      const body = r.block(BLOCK_END[k]);
      if (k === 'preamble') dc.preamble = body;
      else if (k === 'addtopreamble') dc.preamble += body;
      continue;
    }
    switch (k) {
      case 'format': break;
      case 'input': {
        const name = v.endsWith('.inc') || v.endsWith('.layout') || v.endsWith('.module') ? v : v + '.inc';
        let f = join(dir, name);
        if (!existsSync(f)) f = join(dc.sources[0] ? join(dc.sources[0], '..') : dir, name);
        readLayoutFile(f, dc, seen);
        break;
      }
      case 'inputglobal': {
        readLayoutFile(join(dir, v.endsWith('.layout') ? v : v + '.layout'), dc, seen);
        break;
      }
      case 'style':
      case 'modifystyle':
      case 'ifstyle':
      case 'providestyle': {
        const name = v.replace(/_/g, ' ');
        const existing = dc.styles.get(name);
        if ((k === 'modifystyle' || k === 'ifstyle') && !existing) { skipBlock(r); break; }
        if (k === 'providestyle' && existing) { skipBlock(r); break; }
        const s = existing ?? newStyle(name);
        readStyle(r, s, dc);
        if (!existing) dc.styles.set(name, s);
        break;
      }
      case 'nostyle': dc.styles.delete(v.replace(/_/g, ' ')); break;
      case 'insetlayout':
      case 'modifyinsetlayout':
      case 'provideinsetlayout': {
        const name = v.replace(/_/g, ' ');
        const existing = dc.insetLayouts.get(name);
        if (k === 'modifyinsetlayout' && !existing) { skipBlock(r); break; }
        if (k === 'provideinsetlayout' && existing) { skipBlock(r); break; }
        const il = existing ?? newInsetLayout(name);
        readInsetLayout(r, il, dc);
        if (!existing) dc.insetLayouts.set(name, il);
        break;
      }
      case 'noinsetlayout': dc.insetLayouts.delete(v.replace(/_/g, ' ')); break;
      case 'float': readFloat(r, dc); break;
      case 'nofloat': dc.floats.delete(v); break;
      case 'counter': readCounter(r, v, dc); break;
      case 'ifcounter': if (dc.counters.has(v)) readCounter(r, v, dc); else skipBlock(r); break;
      case 'nocounter': dc.counters.delete(v); break;
      case 'classoptions': readClassOptions(r, dc); break;
      case 'columns': dc.columns = parseInt(v, 10) || 1; break;
      case 'sides': dc.sides = parseInt(v, 10) || 1; break;
      case 'pagestyle': break;
      case 'secnumdepth': dc.secNumDepth = parseInt(v, 10); break;
      case 'tocdepth': dc.tocDepth = parseInt(v, 10); break;
      case 'defaultstyle': dc.defaultStyle = v.replace(/_/g, ' '); break;
      case 'defaultfont': dc.defaultFont = readFont(r); break;
      case 'titlelatexname': dc.titleLatexName = v; break;
      case 'titlelatextype': dc.titleLatexType = v.toLowerCase() === 'environment' ? 'Environment' : 'CommandAfter'; break;
      case 'provides': {
        const toks = tokenize(l);
        const feature = toks[1] ?? '';
        const on = toks.length < 3 || isTrue(toks[2]);
        if (on) dc.provides.add(feature); else dc.provides.delete(feature);
        break;
      }
      case 'requires': for (const req of splitList(v)) if (!dc.requires.includes(req)) dc.requires.push(req); break;
      case 'packageoptions': {
        const toks = tokenize(l);
        if (toks.length >= 3) dc.packageOptions.set(toks[1], toks[2]);
        break;
      }
      case 'bibintoc': dc.bibInToc = isTrue(v); break;
      case 'citeengine':
      case 'citeformat':
      case 'addtociteengine':
        skipBlock(r);
        break;
      default:
        // single-line keys we do not care about (OutputType, OutputFormat, DefaultModule, ...)
        break;
    }
  }
}

/* ------------------------------------------------------------ public API */

function builtinLayouts(dc: DocumentClass): void {
  // "Plain Layout" and "Standard" are created by LyX itself if missing.
  if (!dc.styles.has('Plain Layout')) {
    const s = newStyle('Plain Layout');
    s.category = '';
    dc.styles.set('Plain Layout', s);
  }
  if (!dc.styles.has('Standard')) {
    const s = newStyle('Standard');
    s.category = 'MainText';
    dc.styles.set('Standard', s);
  }
}

function resolveObsoleted(dc: DocumentClass): void {
  for (const [, s] of dc.styles) {
    let target = s.obsoletedBy;
    let guard = 0;
    while (target && guard++ < 10) {
      const t = dc.styles.get(target);
      if (!t) break;
      if (!t.obsoletedBy) break;
      target = t.obsoletedBy;
    }
    if (target) s.obsoletedBy = target;
  }
}

const cache = new Map<string, DocumentClass>();

export const DEFAULT_LAYOUT_DIR = process.env.LYX_LAYOUT_DIR ?? '/root/lyx/lib/layouts';

/**
 * Load a document class (textclass + modules) from LyX layout files.
 * Results are cached per (layoutDir, textclass, modules).
 */
export function loadDocumentClass(textclass: string, modules: string[] = [], layoutDir?: string): DocumentClass {
  const dir = layoutDir ?? DEFAULT_LAYOUT_DIR;
  const key = `${dir}|${textclass}|${modules.join(',')}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const dc: DocumentClass = {
    name: textclass, latexName: textclass, description: '', category: '', classPackages: [], options: '',
    fontSizes: ['10', '11', '12'], fontSizeFormat: '$$spt',
    pageSizes: ['default', 'a4', 'a5', 'b5', 'letter', 'legal', 'executive'], pageSizeFormat: '$$spaper',
    pageStyles: ['empty', 'plain', 'headings', 'fancy'], columns: 1, sides: 1, secNumDepth: 3, tocDepth: 3,
    defaultStyle: 'Standard', titleLatexName: 'maketitle', titleLatexType: 'CommandAfter', preamble: '',
    provides: new Set(), requires: [], packageOptions: new Map(), styles: new Map(), insetLayouts: new Map(),
    floats: new Map(), counters: new Map(), defaultFont: {}, bibInToc: false, modules: [...modules], sources: [], warnings: [],
  };
  const seen = new Set<string>();
  let classFile = join(dir, textclass + '.layout');
  if (!existsSync(classFile)) {
    dc.warnings.push(`textclass '${textclass}' not found in ${dir}; falling back to article`);
    classFile = join(dir, 'article.layout');
    dc.latexName = textclass;
  }
  readLayoutFile(classFile, dc, seen);
  if (!dc.latexName) dc.latexName = textclass;
  for (const m of modules) {
    const f = join(dir, m + '.module');
    if (!existsSync(f)) { dc.warnings.push(`module '${m}' not found`); continue; }
    readLayoutFile(f, dc, seen);
  }
  builtinLayouts(dc);
  resolveObsoleted(dc);
  cache.set(key, dc);
  return dc;
}

/** Clear the document class cache (tests / layout dir changes). */
export function clearLayoutCache(): void { cache.clear(); }

export interface LayoutDescription {
  name: string;
  category: string;
  labelType: LabelType;
  labelString: string;
  tocLevel: number;
  latexType: LatexType;
  latexName: string;
  isNumbered: boolean;
  isEnvironment: boolean;
  isCommand: boolean;
  inTitle: boolean;
  obsoletedBy?: string;
}

/** Plain-JSON description of the paragraph styles (for the layout dropdown). */
export function describeLayouts(dc: DocumentClass): LayoutDescription[] {
  const out: LayoutDescription[] = [];
  for (const [, s] of dc.styles) {
    out.push({
      name: s.name, category: s.category, labelType: s.labelType, labelString: s.labelString, tocLevel: s.tocLevel,
      latexType: s.latexType, latexName: s.latexName, isNumbered: s.labelCounter !== '' && s.labelType !== 'No_Label',
      isEnvironment: s.latexType !== 'Paragraph' && s.latexType !== 'Command', isCommand: s.latexType === 'Command',
      inTitle: s.inTitle, obsoletedBy: s.obsoletedBy,
    });
  }
  return out;
}

/** Names of the Flex insets defined by the class/modules ("Code", "URL", ...). */
export function flexInsetNames(dc: DocumentClass): string[] {
  const out: string[] = [];
  for (const [name] of dc.insetLayouts) if (name.startsWith('Flex:')) out.push(name.slice(5));
  return out;
}

/** Float types defined by the class/modules ("figure", "table", "algorithm", ...). */
export function floatTypes(dc: DocumentClass): string[] {
  return [...dc.floats.keys()];
}

/** Look up a style by name, following ObsoletedBy; falls back to the default style. */
export function findStyle(dc: DocumentClass, name: string): LayoutStyle | undefined {
  let s = dc.styles.get(name);
  if (!s) s = dc.styles.get(name.replace(/_/g, ' '));
  if (s?.obsoletedBy) s = dc.styles.get(s.obsoletedBy) ?? s;
  return s;
}

/** Look up an inset layout ("Flex:Code", "Note:Comment", "Foot", ...). */
export function findInsetLayout(dc: DocumentClass, name: string): InsetLayout | undefined {
  let il = dc.insetLayouts.get(name);
  if (!il) il = dc.insetLayouts.get(name.replace(/_/g, ' '));
  if (il?.obsoletedBy) il = dc.insetLayouts.get(il.obsoletedBy) ?? il;
  return il;
}

export { tokenize as tokenizeLayoutLine };
