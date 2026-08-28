/**
 * The preamble side of a .tex document: splitting the file, reading \documentclass, the
 * OverLyX managed block (packages/macros generated from the content + a settings line), the
 * packages the user's preamble provides, and the synthesis of the LyX-style header lines the
 * rest of the application (exporter, dialogs) reads its settings from.
 */
import { stripComments } from '../macros.ts';


export const MANAGED_BEGIN = '%% OverLyX ------------------------------------------------------------------';
export const MANAGED_END = '%% end OverLyX --------------------------------------------------------------';
export const SETTINGS_PREFIX = '%% overlyx-settings: ';

/** Header keys that live in the settings line (everything the writer needs that LaTeX cannot express). */
export const SETTINGS_KEYS = [
  'textclass', 'language', 'language_package', 'inputencoding', 'fontencoding', 'use_non_tex_fonts', 'default_output_format',
  'cite_engine', 'cite_engine_type', 'biblio_style', 'biblio_options', 'biblatex_bibstyle', 'biblatex_citestyle', 'use_bibtopic', 'use_indices',
  'crossref_package', 'use_refstyle', 'use_formatted_ref', 'tracking_changes', 'output_changes', 'change_bars', 'postpone_fragile_content',
  'paragraph_separation', 'defskip', 'quotes_style', 'dynamic_quotes', 'float_placement', 'float_alignment', 'use_dash_ligatures',
  'use_minted', 'listings_params', 'secnumdepth', 'tocdepth', 'notefontcolor', 'boxbgcolor', 'use_hyperref', 'graphics', 'papercolumns',
  'spacing', 'justification', 'is_math_indent', 'math_numbering_side', 'paperfontsize', 'papersize', 'use_geometry', 'suppress_date',
  'pdf_colorlinks', 'index_command', 'bibtex_command', 'tablestyle', 'use_lineno', 'lineno_options',
];

export interface DocumentSplit {
  /** text before \documentclass (comments) */
  head: string;
  /** \documentclass line as written ('' when absent) */
  documentclass: string;
  classOptions: string;
  className: string;
  /** everything between \documentclass and \begin{document}, the managed block removed */
  userPreamble: string;
  /** the managed block (between the markers), '' when absent */
  managed: string;
  body: string;
  /** text after \end{document} */
  trailer: string;
  /** the file has \begin{document} ... \end{document} */
  hasDocument: boolean;
  /** settings JSON from the settings line (in the managed block, or at the top of a child) */
  settings: Record<string, unknown>;
}

/** `s` with every comment replaced by blanks of the same length (positions are preserved). */
function maskComments(s: string): string {
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') { out += s.slice(i, i + 2); i += 2; continue; }
    if (c === '%') {
      let j = i;
      while (j < s.length && s[j] !== '\n') j++;
      out += ' '.repeat(j - i);
      i = j;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Position of `re` in `s` outside comments, or -1. */
function findOutsideComments(s: string, re: RegExp): number {
  const m = re.exec(maskComments(s));
  return m ? m.index : -1;
}

export function splitDocument(text: string): DocumentSplit {
  const out: DocumentSplit = { head: '', documentclass: '', classOptions: '', className: '', userPreamble: '', managed: '', body: text, trailer: '', hasDocument: false, settings: {} };
  const dcPos = findOutsideComments(text, /\\documentclass\s*(\[[^\]]*\])?\s*\{[^}]*\}/);
  const beginPos = findOutsideComments(text, /\\begin\{document\}/);
  if (beginPos >= 0) {
    out.hasDocument = true;
    let preamble = text.slice(0, beginPos);
    const endPos = findOutsideComments(text, /\\end\{document\}/);
    const bodyStart = beginPos + '\\begin{document}'.length;
    out.body = endPos >= 0 ? text.slice(bodyStart, endPos) : text.slice(bodyStart);
    out.trailer = endPos >= 0 ? text.slice(endPos + '\\end{document}'.length) : '';
    if (dcPos >= 0 && dcPos < beginPos) {
      const m = /\\documentclass\s*(\[[^\]]*\])?\s*\{([^}]*)\}/.exec(text.slice(dcPos))!;
      out.head = text.slice(0, dcPos);
      out.documentclass = m[0];
      out.classOptions = m[1] ? m[1].slice(1, -1).trim() : '';
      out.className = m[2].trim();
      preamble = text.slice(dcPos + m[0].length, beginPos);
    }
    // the managed block
    const mb = preamble.indexOf(MANAGED_BEGIN);
    if (mb >= 0) {
      const me = preamble.indexOf(MANAGED_END, mb);
      const blockEnd = me >= 0 ? me + MANAGED_END.length : preamble.length;
      out.managed = preamble.slice(mb, blockEnd);
      preamble = preamble.slice(0, mb) + preamble.slice(blockEnd).replace(/^\n/, '');
    }
    out.userPreamble = preamble.replace(/^\n/, '').replace(/\s+$/, '');
    out.settings = readSettings(out.managed) ?? {};
  } else {
    // a child document / fragment: body only, possibly with a settings line at the top
    const settings = readSettings(text);
    if (settings) {
      out.settings = settings;
      out.body = text.replace(new RegExp('^[ \\t]*' + SETTINGS_PREFIX.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&') + '.*\\n?', 'm'), '');
    }
  }
  return out;
}

export function readSettings(s: string): Record<string, unknown> | null {
  const i = s.indexOf(SETTINGS_PREFIX);
  if (i < 0) return null;
  const line = s.slice(i + SETTINGS_PREFIX.length, s.indexOf('\n', i) < 0 ? undefined : s.indexOf('\n', i));
  try { const v = JSON.parse(line); return v && typeof v === 'object' ? v as Record<string, unknown> : null; } catch { return null; }
}

/* ------------------------------------------------------------ packages */

export interface PreambleFacts {
  /** packages loaded with \usepackage / \RequirePackage (also in \input'ed files, one level) */
  packages: Set<string>;
  /** options given to those packages */
  packageOptions: Map<string, string>;
  /** macro / environment names defined (\newcommand, \def, \newenvironment, ...) */
  defined: Set<string>;
  addbibresources: string[];
  bibliographystyle: string;
}

export function preambleFacts(preamble: string, readFile?: (name: string) => string | undefined, depth = 0, seen = new Set<string>()): PreambleFacts {
  const facts: PreambleFacts = { packages: new Set(), packageOptions: new Map(), defined: new Set(), addbibresources: [], bibliographystyle: '' };
  const s = stripComments(preamble);
  const re = /\\(usepackage|RequirePackage)\s*(\[[^\]]*\])?\s*\{([^}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    for (const p of m[3].split(',')) {
      const name = p.trim();
      if (!name) continue;
      facts.packages.add(name);
      if (m[2]) facts.packageOptions.set(name, m[2].slice(1, -1));
    }
  }
  const defRe = /\\(?:newcommand|renewcommand|providecommand|DeclareRobustCommand|newenvironment|renewenvironment|def|ProvideTextCommandDefault|DeclareTextSymbolDefault|newcommandx|renewcommandx)\*?\s*\{?\\([A-Za-z@]+)\}?/g;
  while ((m = defRe.exec(s))) facts.defined.add(m[1]);
  const envRe = /\\(?:newenvironment|renewenvironment)\*?\s*\{([^}]+)\}/g;
  while ((m = envRe.exec(s))) facts.defined.add(m[1]);
  const bibRe = /\\addbibresource\s*(\[[^\]]*\])?\s*\{([^}]*)\}/g;
  while ((m = bibRe.exec(s))) facts.addbibresources.push(m[2].trim());
  const bst = /\\bibliographystyle\s*\{([^}]*)\}/.exec(s);
  if (bst) facts.bibliographystyle = bst[1].trim();
  if (readFile && depth < 3) {
    const inRe = /\\(?:input|include)\s*\{([^}]*)\}/g;
    while ((m = inRe.exec(s))) {
      const name = m[1].trim();
      for (const cand of name.endsWith('.tex') ? [name] : [name + '.tex', name]) {
        if (seen.has(cand)) break;
        const txt = readFile(cand);
        if (txt === undefined) continue;
        seen.add(cand);
        const sub = preambleFacts(txt, readFile, depth + 1, seen);
        for (const p of sub.packages) facts.packages.add(p);
        for (const [k, v] of sub.packageOptions) facts.packageOptions.set(k, v);
        for (const d of sub.defined) facts.defined.add(d);
        facts.addbibresources.push(...sub.addbibresources);
        if (!facts.bibliographystyle) facts.bibliographystyle = sub.bibliographystyle;
        break;
      }
    }
  }
  return facts;
}

/**
 * Features (in the exporter's sense) that the user's preamble already provides, so that the
 * managed block does not load them a second time.
 */
export function providedFeatures(f: PreambleFacts): Set<string> {
  const out = new Set<string>(f.packages);
  const macroFeature: Record<string, string> = {
    lyxadded: 'ct-xcolor-ulem', lyxdeleted: 'ct-xcolor-ulem', LyX: 'LyX', noun: 'noun', lyxarrow: 'lyxarrow', LyXZeroWidthSpace: 'lyxzerowidthspace',
    lyxgreyedout: 'lyxgreyedout', lyxdot: 'lyxdot', binom: 'binom', mathcircumflex: 'mathcircumflex', LyXParagraphLeftIndent: 'ParagraphLeftIndent',
    tabularnewline: 'NeedTabularnewline', cellvarwidth: 'cellvarwidth', lyxmathsym: 'lyxmathsym', textgreek: 'textgreek', textcyrillic: 'textcyrillic',
    quotesinglbase: 'quotesinglbase', quotedblbase: 'quotedblbase', guilsinglleft: 'guilsinglleft', guilsinglright: 'guilsinglright',
    guillemotleft: 'guillemotleft', guillemotright: 'guillemotright', textquotedbl: 'textquotedbl',
  };
  for (const d of f.defined) if (macroFeature[d]) out.add(macroFeature[d]);
  if (out.has('xcolor')) out.add('color');
  return out;
}

/* ------------------------------------------------------------ header synthesis */

const DEFAULT_HEADER: string[] = [
  '\\use_default_options false',
  '\\maintain_unincluded_children no',
  '\\language english',
  '\\language_package default',
  '\\inputencoding utf8',
  '\\fontencoding auto',
  '\\font_roman "default" "default"',
  '\\font_sans "default" "default"',
  '\\font_typewriter "default" "default"',
  '\\font_math "auto" "auto"',
  '\\font_default_family default',
  '\\use_non_tex_fonts false',
  '\\font_sc false',
  '\\font_roman_osf false',
  '\\font_sans_osf false',
  '\\font_typewriter_osf false',
  '\\font_sf_scale 100 100',
  '\\font_tt_scale 100 100',
  '\\use_microtype false',
  '\\use_dash_ligatures true',
  '\\graphics default',
  '\\default_output_format default',
  '\\output_sync 0',
  '\\bibtex_command default',
  '\\index_command default',
  '\\float_placement class',
  '\\float_alignment class',
  '\\paperfontsize default',
  '\\spacing single',
  '\\use_hyperref false',
  '\\papersize default',
  '\\use_geometry false',
  '\\use_package amsmath 1',
  '\\use_package amssymb 1',
  '\\use_package cancel 1',
  '\\use_package esint 1',
  '\\use_package mathdots 1',
  '\\use_package mathtools 1',
  '\\use_package mhchem 1',
  '\\use_package stackrel 1',
  '\\use_package stmaryrd 1',
  '\\use_package undertilde 1',
  '\\cite_engine basic',
  '\\cite_engine_type default',
  '\\biblio_style plain',
  '\\use_bibtopic false',
  '\\use_indices false',
  '\\paperorientation portrait',
  '\\suppress_date false',
  '\\justification true',
  '\\crossref_package prettyref',
  '\\use_formatted_ref 0',
  '\\use_minted 0',
  '\\use_lineno 0',
  '\\index Index',
  '\\shortcut idx',
  '\\color #008000',
  '\\end_index',
  '\\secnumdepth 3',
  '\\tocdepth 3',
  '\\paragraph_separation indent',
  '\\paragraph_indentation default',
  '\\is_math_indent 0',
  '\\math_numbering_side default',
  '\\quotes_style english',
  '\\dynamic_quotes 0',
  '\\papercolumns 1',
  '\\papersides 1',
  '\\paperpagestyle default',
  '\\tablestyle default',
  '\\tracking_changes false',
  '\\output_changes true',
  '\\change_bars false',
  '\\postpone_fragile_content true',
  '\\html_math_output 0',
  '\\html_css_as_file 0',
  '\\html_be_strict false',
  '\\docbook_table_output 0',
  '\\docbook_mathml_prefix 1',
];

export interface HeaderInput {
  textclass: string;
  options: string;
  preamble: string;
  modules: string[];
  settings: Record<string, unknown>;
  /** derived from the preamble / body when the settings line does not say */
  derived: Record<string, string>;
  authors: { id: number; name: string; email: string }[];
}

/** Build LyX header lines for a .tex document. */
export function makeHeaderLines(h: HeaderInput): string[] {
  const values = new Map<string, string>();
  for (const l of DEFAULT_HEADER) { const sp = l.indexOf(' '); values.set(sp < 0 ? l : l.slice(0, sp), sp < 0 ? '' : l.slice(sp + 1)); }
  for (const [k, v] of Object.entries(h.derived)) values.set('\\' + k, v);
  const usePackage = new Map<string, string>();
  for (const l of DEFAULT_HEADER) if (l.startsWith('\\use_package ')) { const [n, v] = l.slice(13).split(' '); usePackage.set(n, v); }
  let branches: string[] = [];
  for (const [k, v] of Object.entries(h.settings)) {
    if (k === 'modules' || k === 'textclass') continue;
    if (k === 'use_package' && v && typeof v === 'object') { for (const [n, val] of Object.entries(v as Record<string, unknown>)) usePackage.set(n, String(val)); continue; }
    if (k === 'branches' && Array.isArray(v)) { branches = v.map(String); continue; }
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') values.set('\\' + k, String(v));
  }
  const modules = Array.isArray(h.settings.modules) ? (h.settings.modules as unknown[]).map(String) : h.modules;
  const lines: string[] = ['\\textclass ' + h.textclass];
  if (h.preamble.trim()) lines.push('\\begin_preamble', ...h.preamble.replace(/\s+$/, '').split('\n'), '\\end_preamble');
  if (h.options) lines.push('\\options ' + h.options);
  lines.push('\\use_default_options false');
  if (modules.length) lines.push('\\begin_modules', ...modules, '\\end_modules');
  for (const l of DEFAULT_HEADER) {
    if (l.startsWith('\\use_default_options')) continue;
    if (l.startsWith('\\use_package ')) continue;
    if (l === '\\index Index') {
      lines.push('\\index Index', '\\shortcut idx', '\\color #008000', '\\end_index');
      continue;
    }
    if (l === '\\shortcut idx' || l === '\\color #008000' || l === '\\end_index') continue;
    const sp = l.indexOf(' ');
    const key = sp < 0 ? l : l.slice(0, sp);
    const v = values.get(key);
    lines.push(v === undefined || v === '' ? key : key + ' ' + v);
    if (key === '\\use_geometry') for (const [n, val] of usePackage) lines.push(`\\use_package ${n} ${val}`);
    if (key === '\\paperpagestyle' && branches.length) lines.push(...branches);
  }
  for (const a of h.authors) lines.push(`\\author ${a.id} "${a.name.replace(/"/g, '\\"')}" "${a.email.replace(/"/g, '\\"')}"`);
  return lines;
}

/** The settings line for a header (the keys LaTeX cannot express, plus modules / branches). */
export function settingsFromHeader(headerLines: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const value = (key: string): string | undefined => {
    for (const l of headerLines) { if (l === '\\' + key) return ''; if (l.startsWith('\\' + key + ' ')) return l.slice(key.length + 2); }
    return undefined;
  };
  for (const k of SETTINGS_KEYS) {
    const v = value(k);
    if (v === undefined) continue;
    // keep only what differs from the defaults (the file stays readable)
    const def = DEFAULT_HEADER.find(l => l === '\\' + k || l.startsWith('\\' + k + ' '));
    const defVal = def === undefined ? undefined : def === '\\' + k ? '' : def.slice(k.length + 2);
    if (v === defVal) continue;
    out[k] = v;
  }
  const mods = block(headerLines, 'modules');
  if (mods.length) out.modules = mods;
  const up: Record<string, string> = {};
  for (const l of headerLines) if (l.startsWith('\\use_package ')) { const [n, v] = l.slice(13).trim().split(/\s+/); if (v !== '1') up[n] = v; }
  if (Object.keys(up).length) out.use_package = up;
  const branches: string[] = [];
  for (let i = 0; i < headerLines.length; i++) {
    if (!headerLines[i].startsWith('\\branch ')) continue;
    const j = headerLines.indexOf('\\end_branch', i);
    if (j < 0) break;
    branches.push(...headerLines.slice(i, j + 1));
    i = j;
  }
  if (branches.length) out.branches = branches;
  return out;
}

function block(lines: string[], name: string): string[] {
  const s = lines.indexOf('\\begin_' + name);
  if (s < 0) return [];
  const e = lines.indexOf('\\end_' + name, s);
  return e < 0 ? [] : lines.slice(s + 1, e);
}

export function settingsLine(settings: Record<string, unknown>): string {
  return SETTINGS_PREFIX + JSON.stringify(settings);
}
