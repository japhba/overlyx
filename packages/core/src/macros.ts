/**
 * Math macro collection: LyX FormulaMacro insets, preamble \newcommand/\def & co,
 * and \input{...}ed macro files. The result feeds MathLive's macro dictionary so that
 * user macros render instantly in the WYSIWYG view without any conversion.
 */
import type { LyxDocument } from './lyx/ast.ts';
import { getPreamble, walkInsets, unquote, paramMap } from './lyx/ast.ts';

export interface MacroDef {
  name: string;          // without backslash
  args: number;
  def: string;           // LaTeX definition body (#1..#n)
  optional?: string;     // default value of the optional first argument, if any
  display?: string;      // LyX "display" form (what LyX shows instead of the expansion)
  source: 'lyx' | 'preamble' | 'file';
  raw: string;           // the original definition text
}

/** Read a balanced {...} group starting at s[i] === '{'. Returns [content, indexAfter]. */
export function readGroup(s: string, i: number): [string, number] | null {
  if (s[i] !== '{') return null;
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (c === '\\') { j++; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return [s.slice(i + 1, j), j + 1]; }
  }
  return null;
}

function readBracket(s: string, i: number): [string, number] | null {
  if (s[i] !== '[') return null;
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (c === '\\') { j++; continue; }
    if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === ']' && depth === 0) return [s.slice(i + 1, j), j + 1];
  }
  return null;
}

function skipWs(s: string, i: number): number {
  while (i < s.length && /\s/.test(s[i])) i++;
  return i;
}

/** Read a control sequence name at s[i] (which may be '{\name}' or '\name'). */
function readCsName(s: string, i: number): [string, number] | null {
  i = skipWs(s, i);
  if (s[i] === '{') {
    const g = readGroup(s, i);
    if (!g) return null;
    const m = /^\s*\\([A-Za-z@]+|.)\s*$/.exec(g[0]);
    return m ? [m[1], g[1]] : null;
  }
  if (s[i] === '\\') {
    const m = /^\\([A-Za-z@]+|.)/.exec(s.slice(i));
    if (!m) return null;
    return [m[1], i + m[0].length];
  }
  return null;
}

/**
 * Parse one macro definition starting at position `i` in `s` (s[i] should be the backslash of
 * \newcommand, \renewcommand, \providecommand, \def, \global\long\def, \DeclareMathOperator,
 * \DeclarePairedDelimiter, \NewDocumentCommand, \DeclareRobustCommand, \let). Returns the macro and
 * the index after the definition, or null if this is not a definition.
 */
export function parseMacroAt(s: string, i: number, source: MacroDef['source']): [MacroDef, number] | null {
  const head = /^(?:\\global\s*)?(?:\\long\s*)?(?:\\outer\s*)?(?:\\protected\s*)?\\(newcommand\*?|renewcommand\*?|providecommand\*?|DeclareRobustCommand\*?|NewDocumentCommand|RenewDocumentCommand|DeclareDocumentCommand|ProvideDocumentCommand|DeclareMathOperator\*?|DeclarePairedDelimiter(?:X|XPP)?|def|edef|gdef|xdef|let)\b/.exec(s.slice(i));
  if (!head) return null;
  const kind = head[1];
  let j = i + head[0].length;
  const nameRes = readCsName(s, j);
  if (!nameRes) return null;
  const [name, afterName] = nameRes;
  j = afterName;
  const rawStart = i;

  if (kind === 'let') {
    j = skipWs(s, j);
    if (s[j] === '=') j++;
    const t = readCsName(s, j);
    if (!t) return null;
    return [{ name, args: 0, def: '\\' + t[0], source, raw: s.slice(rawStart, t[1]) }, t[1]];
  }
  if (kind === 'def' || kind === 'edef' || kind === 'gdef' || kind === 'xdef') {
    // parameter text: #1#2... (possibly with delimiters, which we ignore)
    let args = 0;
    while (j < s.length && s[j] !== '{') {
      if (s[j] === '#' && /\d/.test(s[j + 1] ?? '')) { args = Math.max(args, Number(s[j + 1])); j += 2; }
      else j++;
    }
    const g = readGroup(s, j);
    if (!g) return null;
    return [{ name, args, def: g[0].trim(), source, raw: s.slice(rawStart, g[1]) }, g[1]];
  }
  if (kind.startsWith('DeclareMathOperator')) {
    j = skipWs(s, j);
    const g = readGroup(s, j);
    if (!g) return null;
    const star = kind.endsWith('*') ? '*' : '';
    return [{ name, args: 0, def: `\\operatorname${star}{${g[0]}}`, source, raw: s.slice(rawStart, g[1]) }, g[1]];
  }
  if (kind.startsWith('DeclarePairedDelimiter')) {
    // \DeclarePairedDelimiter{\abs}{\lvert}{\rvert}  (X/XPP variants have extra args; approximate)
    j = skipWs(s, j);
    let nargs = 1;
    if (kind === 'DeclarePairedDelimiterX' || kind === 'DeclarePairedDelimiterXPP') {
      const b = readBracket(s, j);
      if (b) { nargs = Number(b[0]) || 1; j = b[1]; }
    }
    const groups: string[] = [];
    let pos = skipWs(s, j);
    while (groups.length < (kind === 'DeclarePairedDelimiterXPP' ? 5 : kind === 'DeclarePairedDelimiterX' ? 3 : 2)) {
      const g = readGroup(s, pos);
      if (!g) break;
      groups.push(g[0]);
      pos = skipWs(s, g[1]);
    }
    if (groups.length < 2) return null;
    let l: string, r: string, body: string;
    if (kind === 'DeclarePairedDelimiterXPP') { l = groups[1]; r = groups[2]; body = groups[4] ?? '#1'; }
    else if (kind === 'DeclarePairedDelimiterX') { l = groups[0]; r = groups[1]; body = groups[2] ?? '#1'; }
    else { l = groups[0]; r = groups[1]; body = '#1'; }
    return [{ name, args: nargs, def: `\\left${l}${body}\\right${r}`, source, raw: s.slice(rawStart, pos) }, pos];
  }
  if (kind.endsWith('DocumentCommand')) {
    j = skipWs(s, j);
    const spec = readGroup(s, j);
    if (!spec) return null;
    const specStr = spec[0].replace(/\s/g, '');
    const args = (specStr.match(/[mOodvbr]/gi) ?? []).length;
    const g = readGroup(s, skipWs(s, spec[1]));
    if (!g) return null;
    return [{ name, args, def: g[0].trim(), source, raw: s.slice(rawStart, g[1]) }, g[1]];
  }
  // \newcommand-like
  j = skipWs(s, j);
  let args = 0;
  let optional: string | undefined;
  const b1 = readBracket(s, j);
  if (b1) {
    args = Number(b1[0].trim()) || 0;
    j = skipWs(s, b1[1]);
    const b2 = readBracket(s, j);
    if (b2) { optional = b2[0]; j = skipWs(s, b2[1]); }
  }
  let def: string;
  let end: number;
  if (s[j] === '{') {
    const g = readGroup(s, j);
    if (!g) return null;
    def = g[0]; end = g[1];
  } else {
    // single-token body like \newcommand\foo\bar
    const m = /^\\[A-Za-z@]+|^./.exec(s.slice(j));
    if (!m) return null;
    def = m[0]; end = j + m[0].length;
  }
  const md: MacroDef = { name, args, def: def.trim(), source, raw: s.slice(rawStart, end) };
  if (optional !== undefined) md.optional = optional;
  return [md, end];
}

/** Strip LaTeX comments (unescaped % to end of line). */
export function stripComments(s: string): string {
  return s.split('\n').map(line => {
    let out = '';
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '\\') { out += c + (line[i + 1] ?? ''); i++; continue; }
      if (c === '%') break;
      out += c;
    }
    return out;
  }).join('\n');
}

/** Scan LaTeX source for macro definitions. Also returns \input/\include file references. */
export function macrosFromLatex(text: string, source: MacroDef['source'] = 'preamble'): { macros: MacroDef[]; inputs: string[] } {
  const s = stripComments(text);
  const macros: MacroDef[] = [];
  const inputs: string[] = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '\\') continue;
    const inp = /^\\(?:input|include)\s*\{([^}]+)\}/.exec(s.slice(i));
    if (inp) { inputs.push(inp[1].trim()); i += inp[0].length - 1; continue; }
    const res = parseMacroAt(s, i, source);
    if (res) { macros.push(res[0]); i = res[1] - 1; }
  }
  return { macros, inputs };
}

/** Parse a LyX FormulaMacro inset (lines[0] definition, optional lines[1] "{display}"). */
export function macroFromLyxLines(lines: string[]): MacroDef | null {
  if (!lines.length) return null;
  const res = parseMacroAt(lines[0].trim(), 0, 'lyx');
  if (!res) return null;
  const md = res[0];
  if (lines[1] && lines[1].startsWith('{')) {
    const g = readGroup(lines[1], 0);
    if (g && g[0].trim()) md.display = g[0].trim();
  }
  return md;
}

export interface MacroResolver {
  /** resolve a LyX child document by its filename (relative to the document) */
  include?: (filename: string) => LyxDocument | undefined;
  /** read a text file (for \input{macros} in the preamble), relative to the document */
  readFile?: (filename: string) => string | undefined;
}

/**
 * Collect all macros visible in a document: preamble (+ \input files, recursively),
 * FormulaMacro insets in the body, and included child documents (in document order).
 * Later definitions override earlier ones (like LaTeX).
 */
export function collectMacros(doc: LyxDocument, resolver: MacroResolver = {}, seen = new Set<string>()): MacroDef[] {
  const out: MacroDef[] = [];
  // preamble
  const pre = macrosFromLatex(getPreamble(doc), 'preamble');
  out.push(...pre.macros);
  const visitFile = (name: string) => {
    const candidates = name.endsWith('.tex') ? [name] : [name + '.tex', name];
    for (const c of candidates) {
      if (seen.has('file:' + c)) return;
      const txt = resolver.readFile?.(c);
      if (txt === undefined) continue;
      seen.add('file:' + c);
      const r = macrosFromLatex(txt, 'file');
      out.push(...r.macros);
      for (const inp of r.inputs) visitFile(inp);
      return;
    }
  };
  for (const inp of pre.inputs) visitFile(inp);
  // body
  for (const { inset } of walkInsets(doc.body)) {
    if (inset.type === 'FormulaMacro') {
      const md = macroFromLyxLines(inset.lines);
      if (md) out.push(md);
    } else if (inset.type === 'Leaf' && inset.name === 'CommandInset' && inset.arg === 'include') {
      const pm = paramMap(inset.params);
      const fn = unquote(pm.get('filename'));
      if (fn && !seen.has('lyx:' + fn)) {
        seen.add('lyx:' + fn);
        // a child document (.lyx or .tex) is read as a document: its macros keep their positions
        // (also the ones inside notes, which LyX evaluates); other files are scanned as text
        const child = fn.endsWith('.lyx') || fn.endsWith('.tex') || !fn.includes('.') ? resolver.include?.(fn) : undefined;
        if (child) out.push(...collectMacros(child, resolver, seen));
        else if (!fn.endsWith('.lyx')) visitFile(fn);
      }
    }
  }
  return out;
}

/** Convert macro definitions to MathLive's macro dictionary format. */
export function toMathliveMacros(macros: MacroDef[]): Record<string, { def: string; args: number; expand: boolean }> {
  const out: Record<string, { def: string; args: number; expand: boolean }> = {};
  for (const m of macros) {
    if (!/^[A-Za-z]+$/.test(m.name)) continue;
    let def = m.display ?? sanitizeForMathlive(m.def, m);
    if (m.optional !== undefined && m.args > 0) {
      // MathLive has no optional args; substitute the default for #1 and shift the rest
      let d = def.replace(/#1/g, m.optional);
      for (let k = 2; k <= m.args; k++) d = d.replace(new RegExp('#' + k, 'g'), '#' + (k - 1));
      out[m.name] = { def: d, args: m.args - 1, expand: false };
      continue;
    }
    out[m.name] = { def, args: m.args, expand: false };
  }
  return out;
}

/** Replace a command with a single braced argument (\cmd{X}, optionally with [..] options) using `fn(content)`. */
function replaceCommand(def: string, cmd: string, fn: (content: string, opts: string[]) => string, nGroups = 1): string {
  let out = def;
  for (let guard = 0; guard < 50; guard++) {
    const i = out.indexOf('\\' + cmd);
    if (i < 0) break;
    // the command name must end here (not a prefix of a longer command)
    const after = out[i + cmd.length + 1];
    if (after && /[A-Za-z]/.test(after)) { const rest = replaceCommand(out.slice(i + 1), cmd, fn, nGroups); return out.slice(0, i + 1) + rest; }
    let j = skipWs(out, i + cmd.length + 1);
    const opts: string[] = [];
    let groups: string[] = [];
    for (let g = 0; g < nGroups; g++) {
      // [options] and {mandatory} groups in any order before the last mandatory group
      for (;;) {
        j = skipWs(out, j);
        if (out[j] === '[') { const b = readBracket(out, j); if (!b) break; opts.push(b[0]); j = b[1]; continue; }
        break;
      }
      const grp = readGroup(out, j);
      if (!grp) { groups = []; break; }
      groups.push(grp[0]); j = grp[1];
    }
    if (!groups.length) { out = out.slice(0, i) + '\\mathrm{' + cmd + '}' + out.slice(i + cmd.length + 1); continue; }
    out = out.slice(0, i) + fn(groups[groups.length - 1], [...opts, ...groups.slice(0, -1)]) + out.slice(j);
  }
  return out;
}

/** Strip a text-mode `$...$` wrapper (math inside \raisebox / \scalebox content). */
function unmath(s: string): string {
  const t = s.trim();
  const m = /^\$([\s\S]*)\$$/.exec(t);
  return m ? m[1] : t;
}

/**
 * MathLive cannot render some TeX internals / text-mode constructs used in macro definitions.
 * Rewrite the common ones into a visual approximation, and fall back to the macro name
 * (keeping the arguments visible) for the rest.
 */
export function sanitizeForMathlive(def: string, m: { name: string; args: number }): string {
  let d = def;
  // text-mode boxes that only change size / position: keep the content
  d = replaceCommand(d, 'scalebox', c => `{${unmath(c)}}`, 2);
  d = replaceCommand(d, 'resizebox', c => `{${unmath(c)}}`, 3);
  d = replaceCommand(d, 'rotatebox', c => `{${unmath(c)}}`, 2);
  d = replaceCommand(d, 'vcenter', c => `{${c}}`);
  d = replaceCommand(d, 'vbox', c => `{${c}}`);
  d = replaceCommand(d, 'hbox', c => `\\text{${c}}`);
  d = replaceCommand(d, 'ensuremath', c => `{${c}}`);
  d = replaceCommand(d, 'textnormal', c => `\\text{${c}}`);
  d = replaceCommand(d, 'accentset', (c, o) => `\\overset{${o[0] ?? ''}}{${c}}`, 2);
  d = replaceCommand(d, 'mathchoice', (c, o) => `{${o[0] ?? c}}`, 4);
  d = d.replace(/\\relax\b/g, '');
  // things we cannot approximate: show the macro name with its arguments
  if (/\\(includesvg|includegraphics|sbox|usebox|ooalign|mathpalette|fontcharht|fontdimen|csname|expandafter|noexpand|@)/.test(d)) {
    let f = `\\mathrm{${m.name}}`;
    for (let k = 1; k <= m.args; k++) f += `\\{#${k}\\}`;
    return f;
  }
  return d;
}
