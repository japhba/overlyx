/**
 * A markdown document's typesetting — the keys of its YAML front matter (core md/typesetting.ts) —
 * read and changed as one change of the live document: the front matter is rewritten around the keys
 * set (the rest stays as written) and the settings it amounts to follow, so the editor shows the
 * fonts, numbering and headings at once and the file is saved with the new front matter. Used by
 * Document ▸ Settings (index.ts /docs/*\/frontmatter) and agents (mcp.ts set_markdown_style).
 */
import { isMarkdownPath, frontMatterVars, setFrontMatter, MD_FONTS } from '@overlyx/core/md/index.ts';
import { withTypesetting, type FMSet, type FMValue } from '@overlyx/core/md/typesetting.ts';
import { manager } from './docs.ts';

/** the keys of the front matter that set the typesetting (others — a title, tags — are left to the file) */
export const STYLE_KEYS = ['mainfont', 'sansfont', 'monofont', 'mathfont', 'fontsize', 'papersize', 'geometry', 'linestretch', 'numbersections', 'headings', 'header-includes'];

export async function markdownStyle(docId: string): Promise<{ vars: Record<string, FMValue>; fonts: typeof MD_FONTS }> {
  if (!isMarkdownPath(docId)) throw new Error('Only markdown documents keep their settings in front matter');
  const doc = await manager.open(docId);
  return { vars: frontMatterVars(doc.getMeta().preamble), fonts: MD_FONTS };
}

/** Set front matter keys (null takes one out); `onlyStyle`: refuse keys that are not STYLE_KEYS. */
export async function setMarkdownStyle(docId: string, set: Record<string, unknown>, onlyStyle = false): Promise<{ vars: Record<string, FMValue>; headerLines: string[] }> {
  if (!isMarkdownPath(docId)) throw new Error('Only markdown documents keep their settings in front matter');
  const values: Record<string, FMSet> = {};
  for (const [k, v] of Object.entries(set)) {
    if (!/^[A-Za-z][\w-]{0,40}$/.test(k)) continue;
    if (onlyStyle && !STYLE_KEYS.includes(k)) throw new Error(`"${k}" is not a typesetting key (${STYLE_KEYS.join(', ')})`);
    values[k] = clean(v, 0);
  }
  const doc = await manager.open(docId);
  const meta = doc.getMeta();
  const preamble = setFrontMatter(meta.preamble, values);
  const headerLines = withTypesetting(meta.headerLines, preamble);
  doc.ydoc.transact(() => { doc.meta.set('preamble', JSON.stringify(preamble)); doc.meta.set('header', JSON.stringify(headerLines)); }, 'header');
  return { vars: frontMatterVars(preamble), headerLines };
}

/** a value as the front matter may hold it: text, a list of texts, or (two levels at most) keys of its own */
function clean(v: unknown, depth: number): FMSet {
  if (v === null || v === undefined) return null;
  if (typeof v === 'boolean' || typeof v === 'number') return v;
  if (Array.isArray(v)) return v.slice(0, 40).map(x => String(x).slice(0, 300));
  if (typeof v === 'object' && depth < 2) {
    const out: Record<string, FMSet> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (/^[A-Za-z][\w-]{0,40}$/.test(k) && x !== null) out[k] = clean(x, depth + 1);
    return out as FMSet;
  }
  return String(v).slice(0, 300);
}
