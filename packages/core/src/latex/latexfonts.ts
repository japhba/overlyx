/**
 * Loader for lib/latexfonts and generation of the font package lines, mirroring
 * src/LaTeXFonts.cpp (LaTeXFont::getLaTeXCode).
 */
import { existsSync, readFileSync } from 'node:fs';

export interface LatexFontInfo {
  name: string;
  guiName: string;
  family: string;
  packageName: string;
  packageOptions: string;
  altFonts: string[];
  osfOption: string;
  osfFont: string;
  osfDefault: boolean;
  osfScOption: string;
  scOption: string;
  scaleOption: string;
  scaleCommand: string;
  noMathFont: string;
  completeFont: string;
  ot1Font: string;
  requires: string;
  switchDefault: boolean;
  moreOptions: boolean;
  fontEncodings: string[];
  preamble: string;
  isAlt: boolean;
}

export type LatexFontDB = Map<string, LatexFontInfo>;

const cache = new Map<string, LatexFontDB>();

function unq(v: string): string {
  v = v.trim();
  if (v.startsWith('"')) { const e = v.indexOf('"', 1); return e < 0 ? v.slice(1) : v.slice(1, e); }
  const sp = v.search(/\s/);
  return sp < 0 ? v : v.slice(0, sp);
}

export function loadLatexFonts(file: string): LatexFontDB {
  const cached = cache.get(file);
  if (cached) return cached;
  const db: LatexFontDB = new Map();
  if (existsSync(file)) {
    const lines = readFileSync(file, 'utf8').split('\n');
    let cur: LatexFontInfo | undefined;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line || line.startsWith('#')) continue;
      const sp = line.search(/\s/);
      const key = (sp < 0 ? line : line.slice(0, sp)).toLowerCase();
      const val = sp < 0 ? '' : line.slice(sp + 1).trim();
      if (key === 'font' || key === 'altfont') {
        cur = {
          name: unq(val), guiName: '', family: '', packageName: '', packageOptions: '', altFonts: [], osfOption: '',
          osfFont: '', osfDefault: false, osfScOption: '', scOption: '', scaleOption: '', scaleCommand: '', noMathFont: '',
          completeFont: '', ot1Font: '', requires: '', switchDefault: false, moreOptions: false, fontEncodings: [],
          preamble: '', isAlt: key === 'altfont',
        };
        continue;
      }
      if (!cur) continue;
      if (key === 'endfont') { db.set(cur.name, cur); cur = undefined; continue; }
      if (key === 'preamble') {
        const buf: string[] = [];
        while (++i < lines.length && lines[i].trim().toLowerCase() !== 'endpreamble') buf.push(lines[i].replace(/^\t/, ''));
        cur.preamble = buf.join('\n') + '\n';
        continue;
      }
      switch (key) {
        case 'guiname': cur.guiName = unq(val); break;
        case 'family': cur.family = unq(val); break;
        case 'package': cur.packageName = unq(val); break;
        case 'packageoptions': cur.packageOptions = unq(val); break;
        case 'altfonts': cur.altFonts = unq(val).split(',').map(s => s.trim()).filter(Boolean); break;
        case 'osfoption': cur.osfOption = unq(val); break;
        case 'osffont': cur.osfFont = unq(val); break;
        case 'osfdefault': cur.osfDefault = /^(1|true)$/i.test(unq(val)); break;
        case 'osfscoption': cur.osfScOption = unq(val); break;
        case 'scoption': cur.scOption = unq(val); break;
        case 'scaleoption': cur.scaleOption = unq(val); break;
        case 'scalecommand': cur.scaleCommand = unq(val); break;
        case 'nomathfont': cur.noMathFont = unq(val); break;
        case 'completefont': cur.completeFont = unq(val); break;
        case 'ot1font': cur.ot1Font = unq(val); break;
        case 'requires': cur.requires = unq(val); break;
        case 'switchdefault': cur.switchDefault = /^(1|true)$/i.test(unq(val)); break;
        case 'moreoptions': cur.moreOptions = /^(1|true)$/i.test(unq(val)); break;
        case 'fontencoding': cur.fontEncodings = unq(val).split(',').map(s => s.trim()); break;
        default: break;
      }
    }
  }
  cache.set(file, db);
  return db;
}

export interface FontCodeOptions {
  ot1: boolean;
  complete: boolean;
  sc: boolean;
  osf: boolean;
  nomath: boolean;
  extraOpts: string;
  scale: number;
}

function formatScale(scale: number): string {
  return String(Number((scale / 100).toFixed(4)));
}

/** Which font (name or alt font) is actually used, following LaTeXFont::getUsedFont. */
function usedFont(db: LatexFontDB, f: LatexFontInfo, o: FontCodeOptions): LatexFontInfo | undefined {
  if (o.nomath && f.noMathFont) return db.get(f.noMathFont) ?? f;
  if (f.family === 'rm' && o.complete && f.completeFont) return db.get(f.completeFont) ?? f;
  if (o.ot1 && f.ot1Font) return f.ot1Font === 'none' ? undefined : db.get(f.ot1Font) ?? f;
  return f;
}

/** LaTeX code (\usepackage lines) for the given font. */
export function fontLatexCode(db: LatexFontDB, fontName: string, o: FontCodeOptions): string {
  if (!fontName || fontName === 'default') return '';
  const f = db.get(fontName);
  if (!f) return '';
  const u = usedFont(db, f, o);
  if (!u) return '';
  if (u !== f) return fontLatexCode(db, u.name, o);
  let out = '';
  if (f.switchDefault) {
    if (f.family) out += `\\renewcommand{\\${f.family}default}{${f.name}}\n`;
  } else if (f.packageName) {
    const opts: string[] = [];
    if (f.packageOptions) opts.push(f.packageOptions);
    const hasOsf = !!(f.osfOption || f.osfScOption || f.osfFont);
    const needOsf = o.osf !== f.osfDefault;
    if (o.sc && needOsf && hasOsf && f.scOption) {
      opts.push(f.osfScOption || `${f.osfOption},${f.scOption}`);
    } else if (needOsf && hasOsf && !f.osfFont) {
      if (f.osfOption) opts.push(f.osfOption);
    } else if (o.sc && f.scOption) {
      opts.push(f.scOption);
    }
    if (o.scale !== 100 && f.scaleOption) opts.push(f.scaleOption.replace('$$val', formatScale(o.scale)));
    if (f.moreOptions && o.extraOpts) opts.push(o.extraOpts);
    const optStr = opts.filter(Boolean).join(',');
    out += optStr ? `\\usepackage[${optStr}]{${f.packageName}}\n` : `\\usepackage{${f.packageName}}\n`;
  }
  if (o.osf && f.osfFont) out += fontLatexCode(db, f.osfFont, o);
  if (o.scale !== 100 && f.scaleCommand) {
    const cmd = f.scaleCommand.replace('$$val', formatScale(o.scale));
    if (cmd.includes('@')) out += '\\makeatletter\n' + cmd + '\n\\makeatother\n';
    else out += cmd + '\n';
  }
  if (f.preamble) out += f.preamble;
  return out;
}

/** The package that would be loaded (to detect e.g. newtxmath). */
export function fontUsedPackage(db: LatexFontDB, fontName: string, o: FontCodeOptions): string {
  const f = db.get(fontName);
  if (!f) return '';
  const u = usedFont(db, f, o);
  return u ? u.packageName : '';
}

/** Font encodings supported by the roman font (for Language::fontenc). */
export function fontEncodings(db: LatexFontDB, fontName: string): string[] {
  const f = db.get(fontName);
  if (!f || f.fontEncodings.length === 0) return ['T1', 'OT1'];
  return f.fontEncodings;
}
