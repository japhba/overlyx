/**
 * A project's settings: what everyone in the project gets, over each person's own (Settings ▸
 * Project, as VS Code's workspace settings are over its user settings), kept in the project as
 * `.overlyx/settings.json` — in its git history, cloned with it, hidden from the file tree as dot
 * folders are. The scopes, the more specific winning:
 *
 *   Default   OverLyX's (client prefs.ts DEFAULT_PREFS, core textstyles.ts TYPE_DEFAULTS)
 *   User      one person's own (the client's preferences; new documents' paragraphs: the account)
 *   Project   this file
 *   Document  the document's own (its text styles, fonts and paragraph separation: the PDF's)
 *
 * Only what a project may sensibly decide for everyone is kept: spell checking, automatic PDF builds,
 * the editor's fonts and text styles, new documents' paragraph separation. The theme, keys, AI and
 * privacy stay each person's. What the file says is checked here (server and client alike): anything
 * else, or anything invalid, is left out.
 */
import { screenStylesOf, type ScreenStyles } from './textstyles.ts';

export const PROJECT_SETTINGS_FILE = '.overlyx/settings.json';

export interface ProjectSettings {
  /** spell checking in the text (red underlines) */
  spellcheck?: boolean;
  /** minor typos fixed as a word is finished */
  autoCorrect?: boolean;
  /** build the PDF by itself after a save: never, while the PDF is shown, always */
  autoBuild?: 'off' | 'shown' | 'always';
  /** seconds after the save before such a build starts */
  autoBuildDelay?: number;
  /** the editor's text font (client fonts/catalog.ts: 'document', a face id, `gf:Family|axes|features`) */
  editorFont?: string;
  /** the editor's math font ('match' or a math font id) */
  editorMathFont?: string;
  /** how the editor draws each kind of text (the tree of Settings ▸ Text styles, with All headings) */
  textStyles?: ScreenStyles;
  /** new documents of the project separate paragraphs by vertical space instead of indenting */
  paragraphSkip?: boolean;
}

export const AUTO_BUILD_VALUES = ['off', 'shown', 'always'] as const;
/** a font id as the preferences take it: no control characters, not absurdly long */
const fontId = (v: unknown, max: number) => (typeof v === 'string' && v.length > 0 && v.length <= max && !/[\u0000-\u001f<>"]/.test(v) ? v : undefined);

/** the settings `v` (the file's JSON) gives, only what is valid */
export function projectSettingsOf(v: unknown): ProjectSettings {
  const out: ProjectSettings = {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
  const o = v as Record<string, unknown>;
  for (const k of ['spellcheck', 'autoCorrect', 'paragraphSkip'] as const) if (typeof o[k] === 'boolean') out[k] = o[k] as boolean;
  if ((AUTO_BUILD_VALUES as readonly unknown[]).includes(o.autoBuild)) out.autoBuild = o.autoBuild as ProjectSettings['autoBuild'];
  if (typeof o.autoBuildDelay === 'number' && Number.isFinite(o.autoBuildDelay) && o.autoBuildDelay >= 0 && o.autoBuildDelay <= 60) out.autoBuildDelay = o.autoBuildDelay;
  const font = fontId(o.editorFont, 400), math = fontId(o.editorMathFont, 80);
  if (font) out.editorFont = font;
  if (math) out.editorMathFont = math;
  const styles = screenStylesOf(o.textStyles);
  if (Object.keys(styles).length) out.textStyles = styles;
  return out;
}

/** the file's text: the settings in a fixed order, two spaces, a final newline ('' when nothing is set — the file goes) */
export function projectSettingsJson(s: ProjectSettings): string {
  const v = projectSettingsOf(s);
  if (!Object.keys(v).length) return '';
  const order: (keyof ProjectSettings)[] = ['spellcheck', 'autoCorrect', 'autoBuild', 'autoBuildDelay', 'paragraphSkip', 'editorFont', 'editorMathFont', 'textStyles'];
  const sorted = Object.fromEntries(order.filter(k => v[k] !== undefined).map(k => [k, v[k]]));
  return JSON.stringify(sorted, null, 2) + '\n';
}
