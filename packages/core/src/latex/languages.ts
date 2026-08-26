/**
 * Loader for lib/languages (LyX language database).
 */
import { existsSync, readFileSync } from 'node:fs';

export interface LanguageInfo {
  name: string;
  guiName: string;
  babel: string;
  polyglossia: string;
  polyglossiaOpts: string;
  encoding: string;
  /** "ASCII" means any T* encoding / OT1 */
  fontEncoding: string[];
  quoteStyle: string;
  rtl: boolean;
  internalEncoding: boolean;
  requires: string;
  langCode: string;
}

export type LanguageDB = Map<string, LanguageInfo>;

const cache = new Map<string, LanguageDB>();

function unq(v: string): string {
  v = v.trim();
  if (v.startsWith('"')) {
    const e = v.indexOf('"', 1);
    return e < 0 ? v.slice(1) : v.slice(1, e);
  }
  const sp = v.search(/\s/);
  return sp < 0 ? v : v.slice(0, sp);
}

export function loadLanguages(file: string): LanguageDB {
  const cached = cache.get(file);
  if (cached) return cached;
  const db: LanguageDB = new Map();
  if (existsSync(file)) {
    let cur: LanguageInfo | undefined;
    for (const raw of readFileSync(file, 'utf8').split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const sp = line.search(/\s/);
      const key = (sp < 0 ? line : line.slice(0, sp)).toLowerCase();
      const val = sp < 0 ? '' : line.slice(sp + 1).trim();
      if (key === 'language') {
        cur = {
          name: unq(val), guiName: '', babel: '', polyglossia: '', polyglossiaOpts: '', encoding: 'iso8859-1',
          fontEncoding: ['ASCII'], quoteStyle: 'english', rtl: false, internalEncoding: false, requires: '', langCode: '',
        };
        continue;
      }
      if (!cur) continue;
      if (key === 'end') { db.set(cur.name, cur); cur = undefined; continue; }
      switch (key) {
        case 'guiname': cur.guiName = unq(val); break;
        case 'babelname': cur.babel = unq(val); break;
        case 'polyglossianame': cur.polyglossia = unq(val); break;
        case 'polyglossiaopts': cur.polyglossiaOpts = unq(val); break;
        case 'encoding': cur.encoding = unq(val); break;
        case 'fontencoding': cur.fontEncoding = unq(val).split(',').map(s => s.trim()); break;
        case 'quotestyle': cur.quoteStyle = unq(val); break;
        case 'rtl': cur.rtl = /^(true|1)$/i.test(unq(val)); break;
        case 'internalencoding': cur.internalEncoding = /^(true|1)$/i.test(unq(val)); break;
        case 'requires': cur.requires = unq(val); break;
        case 'langcode': cur.langCode = unq(val); break;
        default: break;
      }
    }
  }
  cache.set(file, db);
  return db;
}

/** Map an encoding LyX name (iso8859-15) to its LaTeX (inputenc) name (latin9). */
export const ENCODING_LATEX_NAMES: Record<string, string> = {
  'utf8': 'utf8', 'utf8x': 'utf8x', 'utf8-plain': 'utf8', 'ascii': 'ascii',
  'iso8859-1': 'latin1', 'iso8859-2': 'latin2', 'iso8859-3': 'latin3', 'iso8859-4': 'latin4',
  'iso8859-5': 'iso88595', 'iso8859-6': '8859-6', 'iso8859-7': 'iso-8859-7', 'iso8859-8': '8859-8',
  'iso8859-9': 'latin5', 'iso8859-13': 'l7enc', 'iso8859-15': 'latin9', 'iso8859-16': 'latin10',
  'cp1250': 'cp1250', 'cp1251': 'cp1251', 'cp1252': 'cp1252', 'cp1255': 'cp1255', 'cp1256': 'cp1256', 'cp1257': 'cp1257',
  'koi8': 'koi8-r', 'koi8-u': 'koi8-u', 'applemac': 'applemac', 'cp437': 'cp437', 'cp850': 'cp850', 'cp852': 'cp852',
  'cp858': 'cp858', 'cp862': 'cp862', 'cp865': 'cp865', 'cp866': 'cp866', 'armscii8': 'armscii8',
};
