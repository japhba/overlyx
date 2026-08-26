/**
 * Loader for lib/symbols: which LaTeX package a math command requires
 * (amssymb, amsmath, mathtools, esint, wasysym, stmaryrd, ...).
 */
import { existsSync, readFileSync } from 'node:fs';

export type MathSymbolDB = Map<string, string>;

const cache = new Map<string, MathSymbolDB>();

const IMPLICIT_FONT_REQUIRES: Record<string, string> = {
  msa: 'amssymb', msb: 'amssymb', wasy: 'wasysym', mathscr: 'mathrsfs', mathds: 'dsfont',
};

/** Extra requirements not encoded in lib/symbols (from the mathed insets' validate()). */
const EXTRA_REQUIRES: Record<string, string> = {
  mathbb: 'amssymb', mathfrak: 'amssymb', mathscr: 'mathrsfs', mathds: 'dsfont', bm: 'bm',
  text: 'amstext', textrm: 'amstext', textsf: 'amstext', texttt: 'amstext', textit: 'amstext', textbf: 'amstext', textsc: 'amstext',
  boldsymbol: 'amsbsy', dfrac: 'amsmath', tfrac: 'amsmath', cfrac: 'amsmath', binom: 'binom', tbinom: 'amsmath', dbinom: 'amsmath',
  overset: 'amsmath', underset: 'amsmath', substack: 'amsmath', sideset: 'amsmath', xrightarrow: 'amsmath', xleftarrow: 'amsmath',
  intertext: 'amsmath', shortintertext: 'mathtools', operatorname: 'amsmath', genfrac: 'amsmath', smash: 'amsmath',
  lyxmathsym: 'lyxmathsym', mathclap: 'mathtools', mathllap: 'mathtools', mathrlap: 'mathtools', coloneqq: 'mathtools',
  cancel: 'cancel', bcancel: 'cancel', xcancel: 'cancel', cancelto: 'cancel', nicefrac: 'units', unitfrac: 'units', unit: 'units',
  xleftrightarrow: 'amsmath', overbrace: '', underbrace: '', mathring: 'amsmath', iddots: 'mathdots', utilde: 'undertilde',
  mathcircumflex: 'mathcircumflex', ensuremath: '', ce: 'mhchem', cf: 'mhchem', stackrel: '',
};

const AMS_ENVIRONMENTS = new Set([
  'align', 'align*', 'alignat', 'alignat*', 'flalign', 'flalign*', 'gather', 'gather*', 'multline', 'multline*',
  'xalignat', 'xalignat*', 'xxalignat', 'equation*', 'split', 'aligned', 'gathered', 'alignedat', 'cases', 'subarray',
  'smallmatrix', 'matrix', 'pmatrix', 'bmatrix', 'Bmatrix', 'vmatrix', 'Vmatrix', 'subequations',
]);

export function loadMathSymbols(file: string): MathSymbolDB {
  const cached = cache.get(file);
  if (cached) return cached;
  const db: MathSymbolDB = new Map();
  if (existsSync(file)) {
    let skip = false;
    for (const raw of readFileSync(file, 'utf8').split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      if (line.startsWith('iffont')) { skip = false; continue; }
      if (line.startsWith('else')) { skip = !skip; continue; }
      if (line.startsWith('endif')) { skip = false; continue; }
      if (skip) continue;
      const t = line.split(/\s+/);
      if (line.startsWith('\\def\\')) {
        // \def\name{def} [extra xmlname] requires
        const m = /^\\def\\([A-Za-z]+)/.exec(line);
        if (!m) continue;
        let req = '';
        if (t.length === 2) req = t[1];
        else if (t.length >= 4) req = t[3];
        if (req && req !== 'hiddensymbol') db.set(m[1], req);
        continue;
      }
      const name = t[0];
      const inset = t[1];
      let req = '';
      if (t.length >= 6 && /^\d+(\|\d+)?$/.test(t[2])) {
        req = t[6] ?? '';
        if (!req) req = IMPLICIT_FONT_REQUIRES[inset] ?? '';
      } else if (t.length >= 4) {
        req = t[3];
      }
      if (req === 'esintoramsmath') req = 'esint|amsmath';
      if (req && req !== 'hiddensymbol') db.set(name, req);
    }
  }
  for (const [k, v] of Object.entries(EXTRA_REQUIRES)) if (v && !db.has(k)) db.set(k, v);
  cache.set(file, db);
  return db;
}

/**
 * Scan LaTeX math source and return the set of required features
 * (package names, possibly "a|b" alternatives).
 */
export function mathRequirements(latex: string, db: MathSymbolDB): Set<string> {
  const out = new Set<string>();
  const cmdRe = /\\([A-Za-z]+\*?)/g;
  let m: RegExpExecArray | null;
  while ((m = cmdRe.exec(latex))) {
    const name = m[1];
    const req = db.get(name);
    if (req) out.add(req);
    if (name === 'begin') {
      const env = /^\{([A-Za-z*]+)\}/.exec(latex.slice(cmdRe.lastIndex));
      if (env && AMS_ENVIRONMENTS.has(env[1])) out.add('amsmath');
    }
  }
  return out;
}
