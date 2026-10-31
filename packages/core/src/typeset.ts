/**
 * Formulas the editor could not typeset while they were on the screen — a command MathJax does not
 * know (drawn as its name in red), a TeX error (the formula's source shown in red) — reported as
 * errors are (server feedback.ts, POST /api/client-typeset; the VS Code extension's through its
 * telemetry; the client's typesetreports.ts notices them), so that what fails to render can be
 * fixed without anybody having to tell. A report carries command names, the error's own words with
 * anything quoted from the formula cut out, how the document's preamble defines the command (the
 * command it is defined with, or that it is not), the packages the preamble loads and fixed words —
 * never a formula, the document's text or its name. The server takes nothing else (typesetReport).
 */

export const TYPESET_PROBLEMS = ['undefined', 'error', 'parse'] as const;
export type TypesetProblem = typeof TYPESET_PROBLEMS[number];

/** how the preamble has the command: a definition (`via` says with what), its name without one, not at all — or the preamble was not to be had */
export const TYPESET_DEFINED = ['definition', 'mentioned', 'absent', 'unknown'] as const;

export interface TypesetInput {
  problem: TypesetProblem;
  /** the command MathJax did not know, `\name` */
  command?: string;
  /** the TeX error's message (cut down by cleanTypeset) */
  error?: string;
  defined?: typeof TYPESET_DEFINED[number];
  /** the command defining it in the preamble, `\NewDocumentCommand` */
  via?: string;
  /** the preamble's \usepackage names */
  packages?: string[];
  /** the preamble \input s a file or two (whose definitions the editor reads too) */
  inputs?: number;
  format?: 'tex' | 'md' | 'article';
  app?: 'web' | 'vscode';
  display?: boolean;
}

const COMMAND = /^\\[A-Za-z@]{1,40}\*?$|^\\[^A-Za-z\s]$/;
const PACKAGE = /^[A-Za-z][A-Za-z0-9-]{0,39}$/;

/** a TeX error's words: what it quotes of the formula goes, commands and fixed words stay */
export function cleanTexError(message: string): string {
  return message
    .replace(/(['"`])([^'"`]*)\1/g, (_m, q: string, inner: string) => (/^\\?[A-Za-z@*]{1,30}$/.test(inner) ? `${q}${inner}${q}` : '…'))
    .replace(/[^A-Za-z0-9 \\{}@*'&^_#.,:;()<>/=+|[\]…-]/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, 160);
}

/** the fields of a report as they may be kept, or null when it is not one */
export function cleanTypeset(v: unknown): TypesetInput | null {
  const o = (v ?? {}) as Record<string, unknown>;
  if (!(TYPESET_PROBLEMS as readonly unknown[]).includes(o.problem)) return null;
  const out: TypesetInput = { problem: o.problem as TypesetProblem };
  if (typeof o.command === 'string' && COMMAND.test(o.command)) out.command = o.command;
  if (typeof o.error === 'string') { const e = cleanTexError(o.error); if (e) out.error = e; }
  if (out.problem === 'undefined' ? !out.command : !out.error) return null;
  if ((TYPESET_DEFINED as readonly unknown[]).includes(o.defined)) out.defined = o.defined as TypesetInput['defined'];
  if (typeof o.via === 'string' && COMMAND.test(o.via)) out.via = o.via;
  if (Array.isArray(o.packages)) {
    const p = [...new Set(o.packages.filter((x): x is string => typeof x === 'string' && PACKAGE.test(x)))].slice(0, 30);
    if (p.length) out.packages = p;
  }
  if (typeof o.inputs === 'number' && Number.isInteger(o.inputs) && o.inputs >= 0 && o.inputs < 1000) out.inputs = o.inputs;
  if (o.format === 'tex' || o.format === 'md' || o.format === 'article') out.format = o.format;
  if (o.app === 'web' || o.app === 'vscode') out.app = o.app;
  if (typeof o.display === 'boolean') out.display = o.display;
  return out;
}

/** a report as the reports keep it: its message (one report per command or error; repeats are counted) and details */
export function typesetReport(v: unknown): { message: string; details: Record<string, string> } | null {
  const t = cleanTypeset(v);
  if (!t) return null;
  const how = t.defined === 'definition' ? `defined in the preamble${t.via ? ` with ${t.via}` : ''}`
    : t.defined === 'mentioned' ? 'named in the preamble, no definition recognised'
    : t.defined === 'absent' ? (t.inputs ? 'not in the preamble (it \\inputs files)' : 'not in the preamble') : null;
  const message = t.problem === 'undefined'
    ? `Not typeset: ${t.command} is unknown to the editor${how ? ` · ${how}` : ''}`
    : t.problem === 'parse' ? `Not typeset: the editor could not read a formula · ${t.error}` : `Not typeset: TeX error · ${t.error}`;
  const details: Record<string, string> = {};
  for (const k of ['format', 'app', 'display', 'defined', 'via', 'inputs'] as const) if (t[k] !== undefined) details[k] = String(t[k]);
  if (t.packages) details.packages = t.packages.join(', ');
  return { message, details };
}

/** the preamble's commands that define another: `\newcommand{\x}`, `\def\x`, `\DeclareMathOperator*{\x}` … */
const DEFINERS = 'newcommand|renewcommand|providecommand|DeclareRobustCommand|DeclareMathOperator|NewDocumentCommand|RenewDocumentCommand|ProvideDocumentCommand|DeclareDocumentCommand|NewExpandableDocumentCommand|DeclarePairedDelimiter|DeclarePairedDelimiterX|DeclarePairedDelimiterXPP|NewCommandCopy|RenewCommandCopy|DeclareCommandCopy|DeclareMathSymbol|DeclareMathAlphabet|DeclareMathDelimiter|DeclareMathAccent|DeclareMathRadical|DeclareTextCommand|newmathalphabet|def|gdef|edef|xdef|let|global\\s*\\\\def|newcommandx|renewcommandx|newrobustcmd|renewrobustcmd|providerobustcmd|newtheorem|newenvironment';

/**
 * How `preamble` has `command` (`\name`): its definition and with what, its name alone, or not at
 * all; the packages it loads and the files it \inputs — for a report (no text of the preamble).
 */
export function preambleFacts(preamble: string, command: string): Pick<TypesetInput, 'defined' | 'via' | 'packages' | 'inputs'> {
  const text = preamble.replace(/(^|[^\\])%.*$/gm, '$1');
  const name = command.replace(/^\\/, '').replace(/\*$/, '');
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const def = new RegExp(`\\\\(${DEFINERS})\\*?\\s*\\{?\\s*\\\\${esc}(?![A-Za-z@])`).exec(text);
  const packages = [...text.matchAll(/\\(?:usepackage|RequirePackage)\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g)].flatMap(m => m[1].split(',').map(s => s.trim()).filter(Boolean));
  const inputs = [...text.matchAll(/\\(?:input|include|subfile)\s*\{[^}]*\}/g)].length;
  const defined = def ? 'definition' : new RegExp(`\\\\${esc}(?![A-Za-z@])`).test(text) ? 'mentioned' : 'absent';
  return { defined, ...(def ? { via: '\\' + def[1].replace(/^global\s*\\/, '') } : {}), packages, inputs };
}
