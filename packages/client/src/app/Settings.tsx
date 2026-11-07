/**
 * The centralized Settings panel (Tools ▸ Settings… in every editor and on the start screen, the
 * avatar menu, the ◑ menu's Appearance settings…, and "… settings" links in quick menus). One dialog
 * for everything a user configures, each thing in one place — and, as VS Code's settings, in scopes,
 * the more specific winning (core projectsettings.ts, core textstyles.ts cascadeStyles):
 *
 *   User      yours, in every project and document (this browser, prefs.ts; some with the account)
 *   Project   everyone's in the project of the open document (`.overlyx/settings.json`, projectsettings.ts)
 *   Document  the open document's own (its header: the PDF and everyone's editor follow it)
 *
 * A tab per scope along the top (Project and Document only with one open). A setting that can be set
 * in more than one scope says where the value it shows comes from (set here, from User, Default) and
 * when a more specific scope sets it too ("Project sets Off — that applies to its documents"); set
 * here, it has a bar at its left and ↺ to inherit again. The sections, by scope:
 *
 *   Editor          User: spell checking, the quick menu, the math keyboard, automatic PDF builds (this
 *                   browser); new documents' paragraph separation and Zotero (the account).
 *                   Project: spell checking, autocorrect, PDF builds, new documents' paragraphs.
 *                   Document (“Paragraphs”): this document's paragraph separation.
 *   Fonts           the editor's text and math fonts (User, Project), My fonts (the account)
 *   Text styles     Title, Normal text, Quote, the headings (EditorStyles in User and Project, the
 *                   document's own in Document: TextStylesPanel in place)
 *   Drawing & pen   the pen of slides, boards and margins (this browser, deliverable/deckink.ts)
 *   Keyboard        shortcuts (the account, keybindings.ts), shortcut tips, LyX's keys
 *   AI assistance   the AI features and models        (this browser, prefs.ts)
 *   Appearance      Classic / Modern, light / dark / follow the system, smart invert (theme.ts)
 *   Privacy         usage statistics and diagnostics
 *   Account         who is signed in, the account's own access token and sign-ins (Git.tsx, as in
 *                   File ▸ Git repository), fine-grained access, token re-copy, deleting the account
 *   Administration  administrators: token re-copy per account, backups, mail and reports
 * `settingsSearchEntries` puts the sections into the command palette. */
import { UiChoice } from './Tour';
import { ZoteroConnect } from './ZoteroConnect';
import { useEffect, useMemo, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import type { EditorView } from 'prosemirror-view';
import { api, type AiStatus, type AiModelInfo, type User, type UserSettings, type AdminUser, type DeletionPreview, type AdminReport, type BackupRun } from '../api';
import { clearLocalData } from './localData';
import { getUserPrefs, setPref, subscribePrefs, DEFAULT_PREFS, type Prefs, type ProjectPrefKey } from '../prefs';
import { saveProjectSettings, useProjectSettings } from '../projectsettings';
import { recordReliability } from '../usage';
import { resetShortcutTips } from '../shortcuttips';
import { useAccountTokens, AccountTokenList, SignInList } from './Git';
import { stashLyxBind, ctrlINow, ctrlIPlan, CTRLI_COMMANDS, type CtrlI } from './lyxbind';
import { resetAllBindings, getBindings, setBinding, subscribeBindings } from './keybindings';
import { useUiMode } from './uimode';
import { formatShortcut } from './shortcuts';
import { setThemePref, useTheme, DARK_TONES, GRADE_RUNGS, GRADE_MIN, GRADE_MAX, type ThemePref } from './theme';
import { AxisSlider } from './FontPicker';
import { EditorStyles } from './EditorStyles';
import { TextStylesPanel } from './TextStyles';
import { REWRITE_KEY } from '../editor/ai/rewrite';
import { Dialog, uiAlert } from './Dialogs';
import { InlineModelPicker } from './AgentModelPicker';
import { speechChoices, chooseHearer, hearerLabel } from '../deliverable/speechchoice';
import { AUTO_BUILD_CHOICES, AUTO_BUILD_DELAYS } from './pdfstatus';
import { FOLLOW_DOCUMENT, GOOGLE_FACE, editorFace } from '../fonts/catalog';
import { resolvedFace, documentSetsFont } from '../fonts/editorfont';
import { loadMyFonts, toggleMyFont, useMyFonts } from '../fonts/myfonts';
import { loadGoogleFont } from '../fonts/googlefont';
import { FontChooser, editorFontSections, editorFontLabel, mathFontSections, mathFontLabel } from './FontPicker';
import { PALETTE_LABEL, openPalette, type SearchEntry } from './MenuBar';
import { PenSettings } from '../deliverable/PenSettings';
import { loadDeckInk, saveDeckInk, patchDeckInk, subscribeDeckInk, type DeckInkPatch } from '../deliverable/deckink';
import { parseFace, projectShortName, type ProjectSettings } from '@overlyx/core';
import { renderMath } from '../editor/lyxmath/mathjax';
import { useMathRendererVersion } from '../editor/lyxmath/usemath';

const SECTIONS = [['editor', 'Editor'], ['fonts', 'Fonts'], ['styles', 'Text styles'], ['drawing', 'Drawing & pen'], ['keyboard', 'Keyboard'], ['ai', 'AI assistance'], ['appearance', 'Appearance'], ['privacy', 'Privacy'], ['account', 'Account'], ['admin', 'Administration']] as const;
export type SettingsSection = (typeof SECTIONS)[number][0];
export type SettingsScope = 'user' | 'project' | 'document';
/** the sections of each scope: a project and a document set what concerns their documents; the rest is each person's own */
const SCOPE_SECTIONS: Record<SettingsScope, SettingsSection[]> = {
  user: SECTIONS.map(([id]) => id),
  project: ['editor', 'fonts', 'styles'],
  document: ['styles', 'editor'],
};
const sectionLabel = (id: SettingsSection, scope: SettingsScope) => (scope === 'document' && id === 'editor' ? 'Paragraphs' : SECTIONS.find(([s]) => s === id)![1]);
/** which project settings each section has (its dot in the Project tab) */
const PROJECT_KEYS: Partial<Record<SettingsSection, (keyof ProjectSettings)[]>> = {
  editor: ['spellcheck', 'autoCorrect', 'autoBuild', 'autoBuildDelay', 'paragraphSkip'], fonts: ['editorFont', 'editorMathFont'], styles: ['textStyles'],
};

/** Settings' argument (setDialog's arg): a section, or a section in a scope */
export type SettingsArg = SettingsSection | { section?: SettingsSection; scope?: SettingsScope } | undefined;
export const settingsArg = (arg: unknown): { initial?: SettingsSection; scope?: SettingsScope } =>
  typeof arg === 'string' ? { initial: arg as SettingsSection } : arg && typeof arg === 'object' ? { initial: (arg as { section?: SettingsSection }).section, scope: (arg as { scope?: SettingsScope }).scope } : {};

/** the document open behind Settings: its tab (the Text styles panel's document scope, its paragraph separation) */
export interface SettingsDocument {
  docId: string;
  headerLines: readonly string[];
  view: EditorView | null;
  markdown: boolean;
  /** after a change was saved (a shell without live settings reads the header again: VS Code) */
  onSaved?: () => void;
  /** Document ▸ Settings… (the class, paper, margins …) */
  openSettings?: () => void;
}

/** where a scoped setting's value comes from, and what overrides it */
type RowState = { here: boolean; from?: string; over?: string };

/**
 * A setting: its name and what it does at the left, its control at the right (one column on a
 * narrow screen); a scoped one says where its value comes from, a bar at its left when set in the
 * scope shown, ↺ to inherit again, and what a more specific scope sets instead.
 */
function Setting({ label, hint, state, onReset, id, children }: { label: ComponentChildren; hint?: ComponentChildren; state?: RowState; onReset?: () => void; id?: string; children?: ComponentChildren }) {
  return (
    <div class={'set-row' + (state?.here ? ' here' : '')} data-setting-row={id}>
      <div class="set-text">
        <div class="set-label">
          <span>{label}</span>
          {state && (state.here || state.from) && <span class={'set-origin' + (state.here ? ' own' : '')}>{state.here ? 'Set here' : state.from}</span>}
          {state?.here && onReset && <button type="button" class="set-reset" title="Reset: inherit it again" data-setting-reset={id} onClick={onReset}>↺</button>}
        </div>
        {hint && <div class="set-hint">{hint}</div>}
      </div>
      <div class="set-ctl">
        {children}
        {state?.over && <div class="set-over" data-setting-over>{state.over}</div>}
      </div>
    </div>
  );
}

/** a switch (a checkbox styled as one) */
const Switch = ({ checked, disabled, onChange, data }: { checked: boolean; disabled?: boolean; onChange: (v: boolean) => void; data?: Record<string, string> }) => (
  <label class={'set-switch' + (disabled ? ' disabled' : '')}>
    <input type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={e => onChange((e.target as HTMLInputElement).checked)} {...(data ?? {})} />
    <span class="set-switch-track" aria-hidden="true" />
    <span class="set-switch-say">{checked ? 'On' : 'Off'}</span>
  </label>
);

/** A model choice: the server's default, one of the offered models, or a typed-in id. */
function ModelPicker({ value, fallback, models, onChange, pref }: { value: string; fallback: string; models: AiModelInfo[]; onChange: (v: string) => void; pref: string }) {
  const known = !value || models.some(m => m.id === value);
  const [custom, setCustom] = useState(!known);
  const cur = models.find(m => m.id === (value || fallback));
  return (
    <div class="model-row" style="display:flex;flex-direction:column;gap:4px">
      <select data-pref={pref} value={custom ? '__custom' : value} onChange={e => { const v = (e.target as HTMLSelectElement).value; if (v === '__custom') { setCustom(true); return; } setCustom(false); onChange(v); }}>
        <option value="">Server default{fallback ? ` (${models.find(m => m.id === fallback)?.label ?? fallback})` : ''}</option>
        {models.map(m => <option key={m.id} value={m.id}>{m.label} — AA {m.aa ?? '?'} · {m.speed} — {m.note}</option>)}
        <option value="__custom">Other model id…</option>
      </select>
      {custom && <input type="text" data-pref-custom={pref} placeholder="provider/model-id (OpenRouter)" value={value} onInput={e => onChange((e.target as HTMLInputElement).value.trim())} />}
      {!custom && cur && value && <span class="sub">{cur.id}</span>}
    </div>
  );
}

/**
 * The sample under Settings ▸ Fonts, in the fonts chosen: the test document of
 * https://tex.stackexchange.com/q/425098 (which OpenType math fonts are available — the fonts offered
 * here), with a line of accents added.
 */
const SAMPLE_MACROS = { '\\Res': '\\operatorname{Res}', '\\diff': '\\mathop{}\\!\\mathrm{d}', '\\BbbC': '\\mathbb{C}' };
/** the sample's markup, and what it waits for (font data still loading) */
function fontSample(): { html: string; retry: Promise<void> | null } {
  const waits: Promise<void>[] = [];
  const m = (src: string, display = false) => {
    const r = renderMath(src, { display, macros: SAMPLE_MACROS });
    if (r.retry) waits.push(r.retry);
    const html = r.node?.outerHTML ?? `<span class="lm-error lm-pending">${src.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</span>`;
    return display ? `<div class="sample-display">${html}</div>` : html;
  };
  const html = [
  `<p><b>Theorem 1</b> (Residue theorem). <i>Let ${m('f')} be analytic in the region ${m('G')} except for the isolated singularities ${m('a_1,a_2,\\dots,a_m')}. If ${m('\\gamma')} is a closed rectifiable curve in ${m('G')} which does not pass through any of the points ${m('a_k')} and if ${m('\\gamma\\approx 0')} in ${m('G')}, then</i></p>`,
  m('\\frac{1}{2\\pi i} \\int\\limits_\\gamma f\\Bigl(x^{\\mathbf{N}\\in\\mathbb{C}^{N\\times 10}}\\Bigr) = \\sum_{k=1}^m n(\\gamma;a_k)\\Res(f;a_k)\\,.', true),
  `<p><b>Theorem 2</b> (Maximum modulus). <i>Let ${m('G')} be a bounded open set in ${m('\\BbbC')} and suppose that ${m('f')} is a continuous function on ${m('G^-')} which is analytic in ${m('G')}. Then</i></p>`,
  m('\\max\\{\\, |f(z)|:z\\in G^- \\,\\} = \\max\\{\\, |f(z)|:z\\in \\partial G \\,\\}\\,.', true),
  `<p>First some large operators both in text: ${m('\\iiint\\limits_{Q}f(x,y,z) \\diff x \\diff y \\diff z')} and ${m('\\prod_{\\gamma\\in\\Gamma_{\\bar{C}}}\\partial(\\tilde{X}_\\gamma)')}; and also on display</p>`,
  m('\\iiiint\\limits_{Q}f(w,x,y,z) \\diff w \\diff x \\diff y \\diff z \\leq \\oint_{\\partial Q} f\'\\Biggl(\\max\\Biggl\\{ \\frac{\\Vert w\\Vert}{\\vert w^2+x^2\\vert}; \\frac{\\Vert z\\Vert}{\\vert y^2+z^2\\vert}; \\frac{\\Vert w\\oplus z\\Vert}{\\vert x\\oplus y\\vert} \\Biggr\\}\\Biggr)\\,.', true),
  `<p>Accents: ${m('\\hat{a}\\ \\tilde{b}\\ \\bar{c}\\ \\vec{v}\\ \\dot{x}\\ \\ddot{y}\\ \\breve{u}\\ \\check{z}\\ \\acute{e}\\ \\grave{e}\\quad \\hat{A}\\ \\tilde{N}\\ \\bar{X}\\ \\dot{\\Phi}\\quad \\widehat{xyz}\\ \\widetilde{abc}\\ \\overline{z+w}')}, and ${m('a\\neq b,\\ x\\not< y,\\ \\mathcal{L},\\ \\mathfrak{g},\\ \\boldsymbol{\\alpha}\\cdot\\mathbf{v},\\ \\varepsilon\\ne\\epsilon,\\ \\varphi\\ne\\phi')}.</p>`,
  ].join('');
  return { html, retry: waits.length ? Promise.all(waits).then(() => {}) : null };
}
/** the sample, drawn again whenever the math font changes */
function FontSample() {
  const version = useMathRendererVersion();
  const [stamp, setStamp] = useState(0);
  const sample = useMemo(fontSample, [version, stamp]);
  useEffect(() => { let live = true; void sample.retry?.then(() => { if (live) setStamp(n => n + 1); }); return () => { live = false; }; }, [sample]);
  return <div class="lyx-editor font-sample" data-font-sample aria-hidden="true" dangerouslySetInnerHTML={{ __html: sample.html }} />;
}

const THEMES: [ThemePref, string, string][] = [
  ['system', 'Default', 'Light or dark with the operating system.'],
  ['light', 'Light', ''],
  ['dark', 'Dark', ''],
];

export function SettingsPanel({ ai, user, initial, scope: initialScope, onClose, sections: shown = SECTIONS.map(([id]) => id), project = null, projectReadOnly = false, document: doc = null }: {
  sections?: SettingsSection[]; ai: AiStatus | null; user: User; initial?: SettingsSection; scope?: SettingsScope; onClose: () => void;
  /** the project of the open document (its tab); read-only for its viewers */
  project?: string | null; projectReadOnly?: boolean;
  /** the open document (its tab) */
  document?: SettingsDocument | null;
}) {
  const scopes: SettingsScope[] = ['user', ...(project ? ['project' as const] : []), ...(doc ? ['document' as const] : [])];
  const [scope, setScopeState] = useState<SettingsScope>(initialScope && scopes.includes(initialScope) ? initialScope : 'user');
  // (Administration only for administrators; the shell's sections in the User tab)
  const sectionsOf = (s: SettingsScope) => SCOPE_SECTIONS[s].filter(id => (s !== 'user' || shown.includes(id)) && (id !== 'admin' || user.isAdmin));
  const sections = sectionsOf(scope);
  const [section, setSection] = useState<SettingsSection>(initial && sections.includes(initial) ? initial : sections[0] ?? 'editor');
  const setScope = (s: SettingsScope) => { setScopeState(s); if (!sectionsOf(s).includes(section)) setSection(sectionsOf(s)[0]); };
  const [p, setP] = useState<Prefs>(getUserPrefs);
  useEffect(() => subscribePrefs(() => setP(getUserPrefs())), []);
  const { settings: ps, error: projectError } = useProjectSettings(project);
  const projectName = project ? projectShortName(project) : '';
  const docName = doc ? doc.docId.split('/').pop() ?? '' : '';
  const { pref: themeChoice } = useTheme();
  // LyX's keys and .bind files are offered in the Classic interface only (people who know LyX)
  const classic = useUiMode() === 'classic';
  const [bindings, setBindings] = useState(getBindings);
  useEffect(() => subscribeBindings(() => setBindings(getBindings())), []);
  const ctrlI = ctrlINow(bindings, CTRLI_COMMANDS);
  const setCtrlI = (v: CtrlI) => { for (const b of ctrlIPlan(v, CTRLI_COMMANDS)) setBinding(b.id, b.key); };
  // the account's server settings: where the web app has an Account section (not in VS Code)
  const web = shown.includes('account');
  const [settings, setSettings] = useState<UserSettings | null>(null);
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => { if (web) api.settings().then(r => setSettings(r.settings)).catch(() => {}); }, []);
  useEffect(() => {
    if (section === 'admin' && user.isAdmin && users === null) api.users().then(r => setUsers(r.users)).catch(e => setErr((e as Error).message));
  }, [section]);
  // who can transcribe spoken comments: asked again as the section opens (an OpenAI key may have been added since)
  const [speech, setSpeech] = useState(ai?.speech ?? null);
  useEffect(() => { if (section === 'ai') api.aiStatus().then(s => setSpeech(s.speech ?? null)).catch(() => {}); }, [section]);
  const deviceSpeech = typeof window !== 'undefined' && !!((window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition ?? (window as unknown as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition);

  /* ------------------------------------------------------------ scopes */

  const saveProject = (patch: Partial<ProjectSettings>) => {
    if (!project || projectReadOnly) return;
    const next: ProjectSettings = { ...(ps ?? {}) };
    for (const [k, v] of Object.entries(patch) as [keyof ProjectSettings, unknown][]) { if (v === undefined) delete next[k]; else (next as Record<string, unknown>)[k] = v; }
    saveProjectSettings(project, next);
  };
  /**
   * A preference a project may set (prefs.ts PROJECT_PREF_KEYS) in the scope shown: its value there
   * (the project's, else inherited from User), how to change and reset it, and its row's state.
   */
  const scoped = <K extends ProjectPrefKey>(key: K, say: (v: Prefs[K]) => string) => {
    const mine = p[key], theirs = ps?.[key] as Prefs[K] | undefined;
    if (scope === 'project') return {
      value: theirs ?? mine, set: (v: Prefs[K]) => saveProject({ [key]: v }), reset: () => saveProject({ [key]: undefined }),
      state: { here: theirs !== undefined, from: mine !== DEFAULT_PREFS[key] ? `from User (yours: ${say(mine)})` : 'Default' } as RowState,
    };
    return {
      value: mine, set: (v: Prefs[K]) => setPref(key, v), reset: () => setPref(key, DEFAULT_PREFS[key]),
      state: { here: mine !== DEFAULT_PREFS[key], over: theirs !== undefined ? `${projectName} sets ${say(theirs)} for everyone in it — its documents follow that.` : undefined } as RowState,
    };
  };
  const onOff = (v: boolean) => (v ? 'On' : 'Off');

  /** a switch for a preference of this person's own (User only) */
  const check = (key: 'invertFigures' | 'aiButton' | 'aiRewrite' | 'aiCompleteText' | 'aiCompleteMath' | 'aiInk' | 'usageStats' | 'betaDiagnostics' | 'shortcutTips' | 'selectionBar' | 'darkPages', label: string, hint: string, disabled = false) => (
    <Setting id={key} label={label} hint={hint} state={{ here: p[key] !== DEFAULT_PREFS[key] }} onReset={() => setPref(key, DEFAULT_PREFS[key])}>
      <Switch checked={p[key]} disabled={disabled} data={{ 'data-pref': key }} onChange={v => { setPref(key, v); if (key === 'betaDiagnostics' && v) recordReliability('diagnostics.enabled'); }} />
    </Setting>
  );
  /** a switch for a preference a project may set */
  const scopedCheck = (key: 'spellcheck' | 'autoCorrect', label: string, hint: string) => {
    const s = scoped(key, onOff);
    return <Setting id={key} label={label} hint={hint} state={s.state} onReset={s.reset}><Switch checked={s.value} data={{ 'data-pref': key }} onChange={s.set} /></Setting>;
  };

  // smart invert and the text tone (app/darkpages.ts): Appearance, or the editor's section where a shell has no Appearance (VS Code)
  const darkTheme = <div data-settings-dark>
    <h3 class="set-group">Dark theme</h3>
    {check('darkPages', 'Smart invert pages', 'The content of every page is shown light on dark — documents, PDFs, slides and posters, layout pages — in the page colour and text tone of the dark theme; colours keep their hue. Off: every page keeps its own colours, white paper inside the dark interface. Presenting shows slides as designed. The theme switch’s menu, the ◐ in the PDF toolbar and beside a deck’s zoom switch it too.')}
    {check('invertFigures', 'Smart invert figures too', 'Plots and diagrams on a white or transparent base turn light on dark with the page; photographs keep their colours (each picture is judged by its pixels). Off: every picture keeps its colours.', !p.darkPages)}
    <Setting id="darkTone" label="Text" hint="The text and formulas of the dark theme in white, or in a warmer or softer tone like Apple Books’ sepia and grey reading themes — PDFs take it too." state={{ here: p.darkTone !== DEFAULT_PREFS.darkTone }} onReset={() => setPref('darkTone', DEFAULT_PREFS.darkTone)}>
      <div class="set-choices">{DARK_TONES.map(t => (
        <label class="pref inline" key={t.id}><input type="radio" name="ol-dark-tone" data-pref-tone={t.id} checked={p.darkTone === t.id} onChange={() => setPref('darkTone', t.id)} /><span>{t.label}</span></label>
      ))}</div>
    </Setting>
  </div>;
  const toggleRecopy = async (u: AdminUser) => {
    setErr('');
    try {
      const r = await api.adminUserSettings(u.id, { allowRecopyTokens: !u.allowRecopyTokens });
      setUsers(list => (list ?? []).map(x => (x.id === u.id ? { ...x, allowRecopyTokens: r.settings.allowRecopyTokens } : x)));
      if (u.id === user.id) setSettings(r.settings);
    } catch (e) { setErr((e as Error).message); }
  };
  const toggleAccountSetting = async (patch: { fineGrainedAccess?: boolean; paragraphSkip?: boolean }) => {
    setErr('');
    try { setSettings((await api.setSettings(patch)).settings); }
    catch (e) { setErr((e as Error).message); }
  };

  /* ------------------------------------------------------------ the sections */

  const autoBuild = scoped('autoBuild', v => AUTO_BUILD_CHOICES.find(c => c[0] === v)?.[1] ?? v);
  const autoBuildDelay = scoped('autoBuildDelay', v => (v === 0 ? 'right away' : `${v} s`));
  /** new documents' paragraph separation: the account's (User), the project's over it */
  const paragraphSkip = (() => {
    const mine = !!settings?.paragraphSkip, theirs = ps?.paragraphSkip;
    const say = (v: boolean) => (v ? 'vertical space' : 'indentation');
    return scope === 'project'
      ? { value: theirs ?? mine, set: (v: boolean) => saveProject({ paragraphSkip: v }), reset: () => saveProject({ paragraphSkip: undefined }), state: { here: theirs !== undefined, from: mine ? 'from User (yours: vertical space)' : 'Default' } as RowState }
      : { value: mine, set: (v: boolean) => void toggleAccountSetting({ paragraphSkip: v }), reset: () => void toggleAccountSetting({ paragraphSkip: false }), state: { here: mine, over: theirs !== undefined ? `New documents of ${projectName} get ${say(theirs)} (the project sets it).` : undefined } as RowState };
  })();

  const editorSection = <>
    <h3 class="set-group">Text</h3>
    {scopedCheck('spellcheck', 'Spell checking', 'Misspelt words are underlined; the right-click menu offers corrections.')}
    {scopedCheck('autoCorrect', 'Autocorrect typos', 'A minor typo is fixed when the word is finished (never in formulas); Backspace right after puts it back.')}
    {scope === 'user' && <>
      <Setting id="spellEngine" label="Checker" hint="OverLyX’s own knows LaTeX: it skips formulas, commands and code, and offers suggestions in the right-click menu.">
        <select data-pref="spellEngine" value={p.spellEngine} onChange={e => setPref('spellEngine', (e.target as HTMLSelectElement).value as Prefs['spellEngine'])}>
          <option value="overlyx">OverLyX — instant, knows LaTeX; English, British, German, French</option>
          <option value="browser">Browser — the browser's own (suggestions via {/Mac/.test(navigator.platform) ? '⇧' : 'Shift+'}right-click)</option>
        </select>
      </Setting>
      {check('selectionBar', 'Quick menu over selected text', 'Selecting words brings up a small bar right above them: font, size, bold / italic / underline, colour, link, comment — the toolbar’s own buttons, where the words are. Escape puts it away.')}
      <h3 class="set-group">Formulas</h3>
      <Setting id="mathKeyboard" label="Math keyboard" hint="A keyboard for formulas at the bottom of the screen, in place of the system keyboard: numbers and structures, functions, Greek, relations, letters — and ✎ Write, to write a formula by hand (AI assistance). Its ⌨ key hands over to the system keyboard."
        state={{ here: p.mathKeyboard !== DEFAULT_PREFS.mathKeyboard }} onReset={() => setPref('mathKeyboard', DEFAULT_PREFS.mathKeyboard)}>
        <select data-pref="mathKeyboard" value={p.mathKeyboard} onChange={e => setPref('mathKeyboard', (e.target as HTMLSelectElement).value as Prefs['mathKeyboard'])}>
          <option value="auto">On touch screens — until a hardware keyboard is used</option>
          <option value="on">Always — whenever a formula has the cursor</option>
          <option value="off">Never — the system keyboard</option>
        </select>
      </Setting>
    </>}
    <h3 class="set-group">PDF</h3>
    <Setting id="autoBuild" label="Automatic builds" hint="Build the PDF by itself a moment after the document is saved (it is saved 1.5 s after you stop typing). Builds run in the background on the server. The ▾ beside View PDF switches it too." state={autoBuild.state} onReset={autoBuild.reset}>
      <div class="set-choices column">{AUTO_BUILD_CHOICES.map(([v, label, hint]) => (
        <label class="pref" key={v}><input type="radio" name={`ol-autobuild-${scope}`} data-pref-autobuild={v} checked={autoBuild.value === v} onChange={() => autoBuild.set(v)} /><span>{label}<span class="sub">{hint}</span></span></label>
      ))}</div>
    </Setting>
    <Setting id="autoBuildDelay" label="Start after the save" state={autoBuildDelay.state} onReset={autoBuildDelay.reset}>
      <select data-pref="autoBuildDelay" value={String(autoBuildDelay.value)} disabled={autoBuild.value === 'off'} onChange={e => autoBuildDelay.set(Number((e.target as HTMLSelectElement).value))}>
        {AUTO_BUILD_DELAYS.map(d => <option key={d} value={String(d)}>{d === 0 ? 'right away' : `${d} s`}</option>)}
      </select>
    </Setting>
    {(scope === 'project' || (web && !user.guest)) && <>
      <h3 class="set-group">New documents</h3>
      <Setting id="paragraphSkip" label="No paragraph indentation" state={paragraphSkip.state} onReset={paragraphSkip.reset}
        hint={<>Documents created {scope === 'project' ? 'in this project' : 'by you'} separate paragraphs by vertical space instead of indenting their first line, in the editor and in the PDF. Each document keeps its own (Document ▸ Settings ▸ Paragraph separation{doc ? ', or the Document tab' : ''}); documents that exist already keep theirs. {scope === 'project' ? 'Kept in the project.' : 'Kept for your account.'}</>}>
        <Switch checked={paragraphSkip.value} disabled={scope === 'user' && settings === null} data={{ 'data-setting': 'paragraph-skip' }} onChange={paragraphSkip.set} />
      </Setting>
    </>}
    {scope === 'user' && web && !user.guest && <>
      <h3 class="set-group">Citations from Zotero</h3>
      <div class="set-block" data-setting="zotero"><ZoteroConnect /></div>
    </>}
    {err && <div class="err">{err}</div>}
    {scope === 'user' && !shown.includes('appearance') && darkTheme}
  </>;

  const textFont = scoped('editorFont', editorFontLabel);
  const mathFontS = scoped('editorMathFont', v => mathFontLabel(v, textFont.value));
  const googleFace = textFont.value.startsWith(GOOGLE_FACE) ? parseFace(textFont.value.slice(GOOGLE_FACE.length)) : null;
  // (the document open has a font of its own: it shows that, whatever the text font — core textstyles.ts)
  const docFontOver = doc && documentSetsFont() ? `The document open has a font of its own (${editorFace(resolvedFace(FOLLOW_DOCUMENT)).label}) — it shows that; this font is for documents that keep LaTeX’s.` : undefined;
  const fontsSection = <>
    <p class="set-desc">{scope === 'project'
      ? `How the editor shows the text and the formulas of ${projectName}’s documents, for everyone in it — over each person’s own fonts. The PDF stays as it is.`
      : 'How your editor shows the text and the formulas of every document, in this browser — the PDF and other people’s editors stay as they are. A project or a document can set its own.'}</p>
    <Setting id="editorFont" label="Text font" hint="Normal text’s font in the editor; Text styles set the rest — headings, sizes, colours." state={{ ...textFont.state, over: [textFont.state.over, docFontOver].filter(Boolean).join(' ') || undefined }} onReset={textFont.reset}>
      <FontChooser label={editorFontLabel(textFont.value)} face={googleFace} labelFont={googleFace ? undefined : editorFace(textFont.value === FOLLOW_DOCUMENT ? resolvedFace(FOLLOW_DOCUMENT) : textFont.value).text}
        sections={editorFontSections(textFont.value, id => textFont.set(id))} onPick={f => textFont.set(GOOGLE_FACE + f)} title="Text font" data={{ 'data-pref': 'editorFont', 'data-value': textFont.value }} />
    </Setting>
    <Setting id="editorMathFont" label="Math font" hint="Formulas are laid out by MathJax from the math font’s own data, as TeX does from an OpenType math font; text inside formulas is in the text font." state={mathFontS.state} onReset={mathFontS.reset}>
      <FontChooser label={mathFontLabel(mathFontS.value, textFont.value)} google={false} sections={mathFontSections(mathFontS.value, textFont.value, id => mathFontS.set(id))}
        onPick={() => {}} title="Math font" data={{ 'data-pref': 'editorMathFont', 'data-value': mathFontS.value }} />
    </Setting>
    <div class="set-block"><FontSample /></div>
    {scope === 'user' && <>
      <h3 class="set-group">My fonts</h3>
      <MyFontsList />
      <h3 class="set-group">The document’s fonts</h3>
      <p class="set-desc">What the PDF and everyone’s editor show is the document’s own: Text styles in the Document tab{doc ? '' : ' (with a document open)'} or Document ▸ Text styles (its text and headings), the toolbar’s font button (the selected text), and for LaTeX documents the details in Document ▸ Settings ▸ Fonts.</p>
    </>}
  </>;

  const stylesSection = scope === 'document' && doc
    ? <>
      <p class="set-desc">The document’s own text styles: saved in it, so its PDF and everyone’s editor show them — over the project’s and each person’s. Where it sets nothing, the editor shows the project’s or yours (“Your editor shows …”).</p>
      <div class="set-block"><TextStylesPanel embedded docId={doc.docId} headerLines={doc.headerLines} view={doc.view} markdown={doc.markdown} onClose={() => {}} onSaved={doc.onSaved} /></div>
    </>
    : <>
      <p class="set-desc">{scope === 'project'
        ? `How the editor draws each kind of text in ${projectName}, for everyone in it — over each person’s own styles, under a document’s. Values not set here come from User (yours) or the defaults. The PDF keeps the document’s own.`
        : 'How your editor draws each kind of text — Title, Normal text, Quote, the headings — in every document, in this browser. They start from sensible defaults (LaTeX’s article); a project or a document can set its own, and the more specific wins. The PDF keeps the document’s own.'}</p>
      <div class="set-block"><EditorStyles key={scope} scope={scope === 'project' ? 'project' : 'user'} project={project} document={!!doc} readOnly={scope === 'project' && projectReadOnly} /></div>
    </>;

  const content = (() => {
    switch (section) {
      case 'editor': return scope === 'document' && doc ? <DocumentParagraphs doc={doc} /> : editorSection;
      case 'fonts': return fontsSection;
      case 'styles': return stylesSection;
      case 'drawing': return <DrawingSettings onClose={onClose} />;
      case 'keyboard': return <>
        <h3 class="set-group">Shortcuts</h3>
        <Setting id="shortcuts" label="Your shortcuts" hint={`To give a command a shortcut of your own, find it with Help ▸ ${PALETTE_LABEL.replace(/ \(.*\)$/, '')} and click ✎ beside it, then press the keys (Backspace: none). Your shortcuts follow your account to every browser you sign in with.`}>
          <div class="set-buttons">
            {/* (the palette, where ✎ records a shortcut: once this dialog is gone) */}
            <button type="button" class="btn" data-open-palette onClick={() => { onClose(); setTimeout(openPalette, 0); }}>Change a shortcut…</button>
            <button type="button" class="btn" data-reset-shortcuts onClick={() => resetAllBindings()}>Back to the default keys</button>
          </div>
        </Setting>
        {check('shortcutTips', 'Shortcut tips', 'An action that has a shortcut but is taken with the mouse — a toolbar button, a menu entry, the right-click menu — shows its shortcut from the third time on, five times; pressing the shortcut once ends its tips.')}
        <Setting id="shortcutTipsAgain" label="Tips already shown"><button type="button" class="btn" data-reset-shortcut-tips disabled={!p.shortcutTips} onClick={() => resetShortcutTips()}>Show all tips again</button></Setting>
        {classic && <div data-from-lyx>
          <h3 class="set-group">Coming from LyX</h3>
          <p class="set-desc">OverLyX uses LyX’s default keys (cua.bind, menus.bind, math.bind), except that {formatShortcut('Ctrl+I')} is italic, as in other editors, unless you choose LyX’s meaning here. Bring your own keys from LyX too: choose its <code>bind/user.bind</code> (or another .bind file) — what it binds to a command OverLyX has becomes that command’s shortcut, on every browser you sign in with.</p>
          <Setting id="ctrlI" label={formatShortcut('Ctrl+I')}>
            <select data-ctrl-i value={ctrlI} onChange={e => setCtrlI((e.target as HTMLSelectElement).value as CtrlI)}>
              <option value="italic">Italic, as in other editors</option>
              <option value="inset">Opens and closes the inset at the cursor, as in LyX</option>
            </select>
          </Setting>
          <Setting id="lyxbind" label="LyX key bindings">
            <button type="button" class="btn" data-import-lyxbind onClick={e => (e.currentTarget.nextElementSibling as HTMLInputElement | null)?.click()}>Import LyX key bindings (.bind)…</button>
            <input type="file" accept=".bind,text/plain" hidden data-import-lyxbind-file onChange={e => { const f = (e.target as HTMLInputElement).files?.[0]; (e.target as HTMLInputElement).value = ''; if (f) void f.text().then(t => stashLyxBind(f.name, t)); }} />
          </Setting>
        </div>}
      </>;
      case 'ai': return <>
        <p class="set-desc">{ai === null ? 'Checking the server…' : ai.available ? `Available on this server — model ${ai.model}${ai.completionModel !== ai.model ? `, autocomplete ${ai.completionModel}` : ''}.` : 'Not configured on this server: the administrator has to set OPENROUTER_API_KEY (deploy/secrets.env). The switches below have no effect until then.'}</p>
        <h3 class="set-group">Features</h3>
        {check('aiButton', 'Show the ✦ AI button on the toolbar', 'One button that switches autocomplete (text and formulas) on and off. Hidden until you enable it here.')}
        {check('aiRewrite', `Rewrite with AI (${REWRITE_KEY})`, 'Select text or a formula, press the key and describe the change; the proposal is shown in place and applied only when you accept it.')}
        {check('aiCompleteText', 'Autocomplete text', 'After a pause while typing, a continuation appears in grey after the caret — formulas already rendered — while ✦ AI… shows in the status bar. Tab inserts it, anything else dismisses it. Works at the end of a word or paragraph, in ordinary text.')}
        {check('aiCompleteMath', 'Autocomplete formulas', 'The same inside formulas: a suggested continuation at the caret, Tab inserts it.')}
        {check('aiInk', 'Read handwritten formulas', `The math keyboard’s ✎ Write: what you write with a pen or a finger is read as LaTeX — a picture of it and the formula around the cursor go to the model${ai?.inkModel ? ` (${ai.inkModel})` : ''}. Nothing is inserted until you tap a reading.`)}
        <Setting id="aiCompleteDelay" label="Pause before suggesting" state={{ here: p.aiCompleteDelay !== DEFAULT_PREFS.aiCompleteDelay }} onReset={() => setPref('aiCompleteDelay', DEFAULT_PREFS.aiCompleteDelay)}>
          <span><input type="number" min={80} max={5000} step={20} value={p.aiCompleteDelay} onInput={e => setPref('aiCompleteDelay', Math.max(80, Number((e.target as HTMLInputElement).value) || 200))} style="max-width:90px" /> ms</span>
        </Setting>
        <h3 class="set-group">Models</h3>
        <p class="set-desc">Any OpenRouter model id works; the notes are from measurements on a real paper. The choice is kept in this browser. What is sent: your instruction or the text around the cursor together with the document’s LaTeX source (so the model knows the notation, macros, citation keys) goes to the model through the OverLyX server. Nothing is written to the document without your Tab or Accept. The switches are also in the Tools menu, so the command palette finds them.</p>
        {/* the rewrite's picker is the ⌘J prompt's and the Agent panel's: the server's models, then your own providers */}
        <Setting id="aiModel" label={`Rewrite (${REWRITE_KEY})`}>
          <div data-pref="aiModel"><InlineModelPicker server={ai ?? null} value={p.aiModel} onChange={v => setPref('aiModel', v)} placement="down" /></div>
        </Setting>
        <Setting id="aiCompletionModel" label="Autocomplete">
          <ModelPicker value={p.aiCompletionModel} fallback={ai?.completionModel ?? ''} models={ai?.models ?? []} onChange={v => setPref('aiCompletionModel', v)} pref="aiCompletionModel" />
        </Setting>
        <h3 class="set-group">Spoken comments</h3>
        <Setting id="speechEngine" label="Put into words by" hint={<span data-speech-now>What you say with the comment pen’s push to talk becomes a comment on the slide. Now: {hearerLabel(chooseHearer(p.speechEngine, speech, deviceSpeech), speech)}. Kept in this browser.</span>}>
          <div class="set-choices column">{speechChoices(speech, deviceSpeech).map(c => (
            <label class={'pref' + (c.available ? '' : ' disabled')} key={c.value}><input type="radio" name="ol-speech" data-pref-speech={c.value} checked={p.speechEngine === c.value} disabled={!c.available} onChange={() => setPref('speechEngine', c.value)} /><span>{c.label}<span class="sub">{c.hint}</span></span></label>
          ))}</div>
        </Setting>
      </>;
      case 'appearance': return <>
        <h3 class="set-group">Interface</h3>
        <p class="set-desc">Classic shows LyX’s toolbars and menus; Modern is calmer and simpler — one toolbar, tools that appear when you need them. The same functions either way. Kept for your account.</p>
        <div class="set-block"><UiChoice /></div>
        <h3 class="set-group">Theme</h3>
        <Setting id="theme" label="Theme" hint="Kept in this browser." state={{ here: themeChoice !== 'system' }} onReset={() => setThemePref('system')}>
          <div class="set-choices column">{THEMES.map(([v, label, hint]) => (
            <label class="pref" key={v}><input type="radio" name="ol-theme" data-theme-pref={v} checked={themeChoice === v} onChange={() => setThemePref(v)} /><span>{label}{hint && <span class="sub">{hint}</span>}</span></label>
          ))}</div>
        </Setting>
        {darkTheme}
        <h3 class="set-group">Text grade</h3>
        <Setting id="textGrade" label="Grade" hint="How dark the interface’s letters are — and those of documents set in Anodyne — in this browser. Grade changes the strokes only, never the width of a letter, so nothing moves. The dark theme takes 25 off by itself, as light letters on dark look heavier."
          state={{ here: p.textGrade !== DEFAULT_PREFS.textGrade }} onReset={() => setPref('textGrade', DEFAULT_PREFS.textGrade)}>
          <div class="settings-grade" data-pref="textGrade">
            <AxisSlider name="Grade" min={GRADE_MIN} max={GRADE_MAX} def={0} rungs={GRADE_RUNGS} value={p.textGrade} onChange={v => setPref('textGrade', v)} />
            <div class="settings-grade-sample">Il1 O0 — The quick brown fox jumps over the lazy dog, 3 × 4 ≠ 12 ± 1</div>
          </div>
        </Setting>
      </>;
      case 'privacy': return <>
        <h3 class="set-group">Usage statistics</h3>
        {check('usageStats', 'Send anonymous usage statistics', 'Which menu entries, buttons, shortcuts and dialogs are used, and which of them do nothing, are undone right away or end in an error message — so that confusing parts of the editor can be found and fixed.')}
        <p class="set-desc" data-setting="usage-what">What is sent: the kind of action (for example “Edit ▸ Text Style ▸ Bold”, “toolbar m-frac”, “Ctrl+Shift+K unbound”, “Citation dialog dismissed”), where it happened (text, formula, table, dialog), the template of an error message with its data removed, the kind of screen, and a random id for this page load. Never your name or account, document or project names, text, formulas or file names — quoted strings, file names and numbers are removed before anything leaves the browser, and again on the server. The browser’s Global Privacy Control signal switches it off as well. Kept in this browser.</p>
        <p class="set-desc">Detailed diagnostics also record fixed categories for clicks, context menus, drag/drop, paste/cut and deletion outcomes, selection type, empty or filled notes, collapsed or margin display, editing permissions, change tracking, pointer type, API success or failure, connectivity, resource errors and duration buckets. Short action trails help investigate errors, repeated attempts and undo. No input values, typed text, clipboard contents, positions, URLs or identifiers are collected. Detailed events are kept for 30 days.</p>
        <h3 class="set-group">Beta reliability diagnostics</h3>
        {check('betaDiagnostics', 'Send beta reliability diagnostics', 'Optional: keyboard-load fallback, cancelled touch/pen gestures, canvas recovery, save-state transitions and background/orientation changes. Only fixed event names, pointer kind, coarse context, duration buckets and a random ID for this page load; never text, formulas, coordinates, pressure, file names, document or account identifiers. Kept on this server for 30 days. Usage statistics, Global Privacy Control and the server’s statistics switch still apply.', !p.usageStats)}
        <h3 class="set-group">Problem reports</h3>
        <p class="set-desc">What you send with Help ▸ Report a problem, and errors the app runs into, stay on this server — read by its operator, never published. Never the content of your documents.</p>
        <h3 class="set-group">Privacy notice</h3>
        <p class="set-desc">What OverLyX keeps about you, who else sees it, how long it stays and how to delete it: <a href="/privacy" target="_blank" rel="noopener" data-privacy-link>the privacy notice</a>.</p>
      </>;
      case 'account': return <>
        <h3 class="set-group">Signed in</h3>
        <p class="set-desc" data-setting="whoami">{user.name} ({user.username}){user.isAdmin ? ' — administrator' : ''}</p>
        {!user.guest && <AccountCredentials>
          <Setting id="fineGrained" label="Fine-grained access" hint="When you authorize a new sign-in, choose which projects it reaches and whether it may only read (clone, pull, read and build — no push, edits or comments). Sign-ins made before keep their access; switching this off does not widen narrowed ones.">
            <Switch checked={!!settings?.fineGrainedAccess} disabled={settings === null} data={{ 'data-setting': 'fine-grained' }} onChange={v => void toggleAccountSetting({ fineGrainedAccess: v })} />
          </Setting>
        </AccountCredentials>}
        {err && <div class="err">{err}</div>}
        <h3 class="set-group">Token re-copy</h3>
        <Setting id="recopy" label="Re-copy the access token" hint={`The account access token (File ▸ Git repository…) works with Git, the CLI and MCP. It is normally shown exactly once — only a hash is kept. With re-copy enabled, its plaintext remains on the server and the Git dialog offers Copy again later. This convenience stores a recoverable secret, so it is off by default; an administrator switches it per account${user.isAdmin ? ' (Administration)' : ''}.`}>
          <div data-setting="recopy"><b>{settings === null ? 'Checking…' : settings.allowRecopyTokens ? 'Enabled for your account' : 'Disabled for your account'}</b>{settings !== null && !settings.allowRecopyTokens ? ' (the default)' : ''}</div>
        </Setting>
        {!user.guest && <DeleteAccount user={user} />}
      </>;
      case 'admin': return user.isAdmin ? <>
        <h3 class="set-group">Token re-copy, per account</h3>
        {err && <div class="err">{err}</div>}
        <div class="settings-users">
          {(users ?? []).map(u => (
            <label key={u.id}>
              <input type="checkbox" checked={u.allowRecopyTokens} onChange={() => void toggleRecopy(u)} />
              <span>{u.name} <span class="sub">({u.username}{u.email ? ` · ${u.email}` : ''})</span></span>
            </label>
          ))}
          {users === null && <div class="sub">Loading…</div>}
        </div>
        <AdminBackups />
        <AdminReports />
      </> : null;
    }
  })();

  const scopeSay: Record<SettingsScope, ComponentChildren> = {
    user: <>Yours, in every project and document — kept in this browser, some with your account.{scopes.length > 1 ? ' A project or a document can set its own: the more specific wins.' : ''}</>,
    project: <>Everyone’s in <b>{projectName}</b>: kept in the project (<code>.overlyx/settings.json</code>, in its history) — over each person’s own, under a document’s.{projectReadOnly ? ' You can see them; the project’s editors change them.' : ''}</>,
    document: <><b>{docName}</b> alone: kept in the document, so its PDF and everyone’s editor follow it — over the project’s and each person’s.</>,
  };
  const projectCount = ps ? Object.keys(ps).length : 0;

  return (
    <Dialog title="Settings" onClose={onClose} wide>
      <div class="settings-dialog" data-scope={scope}>
        {scopes.length > 1 && (
          <div class="settings-scopes">
            <div class="settings-scope-tabs" role="tablist" aria-label="Where the settings apply">
              {scopes.map(s => (
                <button key={s} type="button" role="tab" aria-selected={scope === s} class={'settings-scope' + (scope === s ? ' active' : '')} data-settings-scope={s} onClick={() => setScope(s)}>
                  <span class="settings-scope-name">{s === 'user' ? 'User' : s === 'project' ? 'Project' : 'Document'}</span>
                  <span class="settings-scope-where">{s === 'user' ? user.username : s === 'project' ? projectName : docName}</span>
                  {s === 'project' && projectCount > 0 && <span class="settings-scope-count" title={`${projectCount} set in the project`}>{projectCount}</span>}
                </button>
              ))}
            </div>
            <div class="settings-scope-say">{scopeSay[scope]}</div>
          </div>
        )}
        <div class="settings-nav" role="tablist" aria-label="Sections">
          {sections.map(id => {
            const set = scope === 'project' && ps && (PROJECT_KEYS[id] ?? []).some(k => ps[k] !== undefined);
            return <button key={id} role="tab" aria-selected={section === id} data-settings-section={id} class={section === id ? 'active' : ''} onClick={() => setSection(id)}>
              {sectionLabel(id, scope)}{set && <span class="settings-nav-dot" title="Set in the project" />}
            </button>;
          })}
        </div>
        <div class="settings-content" key={scope + section}>
          <div class="settings-page">
            <h2 class="settings-title">{sectionLabel(section, scope)}<span class="settings-title-scope">{scope === 'user' ? '' : scope === 'project' ? ` · ${projectName}` : ` · ${docName}`}</span></h2>
            {scope === 'project' && projectError && <div class="err" data-project-settings-error>{projectError}</div>}
            {scope === 'project' && ps === null && !projectError && <p class="set-desc">Loading the project’s settings…</p>}
            {scope === 'project' && projectReadOnly
              ? <fieldset class="settings-readonly" disabled>{content}</fieldset>
              : content}
          </div>
        </div>
      </div>
    </Dialog>
  );
}

/** Settings ▸ Document ▸ Paragraphs: the open document's paragraph separation (the account's or the project's choice is only for new documents) */
function DocumentParagraphs({ doc }: { doc: SettingsDocument }) {
  const header = (k: string) => doc.headerLines.find(l => l.startsWith('\\' + k + ' '))?.slice(k.length + 2).trim();
  const saved = header('paragraph_separation') === 'skip';
  const [skip, setSkip] = useState(saved);
  useEffect(() => setSkip(saved), [saved]);
  const [err, setErr] = useState('');
  const set = async (v: boolean) => {
    setSkip(v); setErr('');
    try {
      await api.setHeader(doc.docId, { set: v ? { paragraph_separation: 'skip', ...(header('defskip') ? {} : { defskip: 'medskip' }) } : { paragraph_separation: 'indent' } });
      doc.onSaved?.();
    } catch (e) { setErr((e as Error).message); setSkip(saved); }
  };
  return <>
    <h3 class="set-group">Paragraph separation</h3>
    {doc.markdown
      ? <p class="set-desc">A markdown document separates its paragraphs by vertical space, in the editor and in the PDF.</p>
      : <Setting id="documentParagraphs" label="Between paragraphs"
          hint="Indentation (LaTeX’s default) indents each paragraph’s first line; vertical space starts paragraphs flush left with a gap between them — in the editor and in the PDF. New documents start with what User or Project ▸ Editor ▸ New documents say.">
          <div class="set-choices column">
            <label class="pref"><input type="radio" name="ol-doc-parsep" data-doc-parsep="indent" checked={!skip} onChange={() => void set(false)} /><span>Indentation</span></label>
            <label class="pref"><input type="radio" name="ol-doc-parsep" data-doc-parsep="skip" checked={skip} onChange={() => void set(true)} /><span>Vertical space</span></label>
          </div>
        </Setting>}
    {err && <div class="err">{err}</div>}
    {doc.openSettings && <>
      <h3 class="set-group">More of the document</h3>
      <Setting id="documentSettings" label="Document settings" hint="The class, paper and margins, fonts for LaTeX, numbering, the preamble — everything else a document says about itself.">
        <button type="button" class="btn" data-open-document-settings onClick={doc.openSettings}>Document ▸ Settings…</button>
      </Setting>
    </>}
  </>;
}

/** Settings ▸ Fonts ▸ My fonts: the account's Google fonts (fonts/myfonts.ts), first in every font list — removed here, added from the list */
function MyFontsList() {
  const mine = useMyFonts();
  useEffect(() => { void loadMyFonts(); }, []);
  useEffect(() => { for (const f of mine ?? []) loadGoogleFont(f); }, [mine]);
  return <>
    <p class="set-desc">Google fonts kept with your account: first in every font list — documents, slides, Text styles, these settings — in the web app and in VS Code. The ★ beside a font in any font list adds or removes it too.</p>
    {mine === null ? <div class="sub">Loading…</div> : !mine.length ? <div class="sub" data-my-fonts-empty>None yet.</div> : (
      <div class="settings-myfonts" data-my-fonts>
        {mine.map(f => (
          <div class="settings-myfont" key={f}>
            <span class="settings-myfont-name" style={{ fontFamily: `'${f}', var(--ui-font)` }}>{f}</span>
            <button type="button" class="btn small" data-my-font-remove={f} title={`Take ${f} out of My fonts`} onClick={() => void toggleMyFont(f)}>Remove</button>
          </div>
        ))}
      </div>
    )}
    <div class="set-buttons"><FontChooser label="Add a Google font…" onPick={f => { if (!mine?.includes(f)) void toggleMyFont(f); }} title="Add to My fonts" data={{ 'data-my-fonts-add': '' }} /></div>
  </>;
}

/** Settings ▸ Drawing & pen: the pen of slides, posters, whiteboards and a document's margins (deliverable/deckink.ts, this browser) — Draw's own pen settings */
function DrawingSettings({ onClose }: { onClose: () => void }) {
  const [ink, setInk] = useState(loadDeckInk);
  useEffect(() => subscribeDeckInk(setInk), []);
  const patch = (x: DeckInkPatch) => saveDeckInk(patchDeckInk(loadDeckInk(), x));
  return <>
    <h3 class="set-group">Pen</h3>
    <p class="set-desc">The pen of slides, posters, whiteboards and a document’s margins, in this browser. The same settings come up when you tap the pen again in Draw.</p>
    <div class="settings-pen" data-settings-pen>
      <PenSettings nib={ink.nib} color={ink.pens.pen.color} width={ink.pens.pen.width} habits={{ scribble: ink.scribble, fingersDraw: ink.fingersDraw, pencil: ink.pencil, penInks: ink.penInks, snap: ink.snap }}
        onChange={nib => patch({ nib })} onHabits={h => patch(h)} onClose={onClose} />
    </div>
  </>;
}

/**
 * Settings' sections in the command palette (Help ▸ search): "font" finds Settings ▸ Fonts, "pen" the
 * pen settings — each opens the dialog there.
 */
const SECTION_WORDS: Record<SettingsSection, string> = {
  editor: 'spell checking, autocorrect, quick menu, math keyboard, automatic PDF builds, new documents, Zotero, project settings',
  fonts: 'the editor’s text font and math font, My fonts',
  styles: 'Title, Normal text, Quote, headings: font, weight, size, colour, spacing — yours, the project’s, the document’s',
  drawing: 'pen tip, pressure, smoothing, rounding, calibration, scribble to erase',
  keyboard: 'shortcuts, shortcut tips, LyX key bindings',
  ai: 'rewrite, autocomplete, models, handwriting, spoken comments',
  appearance: 'Classic or Modern interface, light or dark theme, smart invert',
  privacy: 'usage statistics, diagnostics',
  account: 'access token, sign-ins, delete account',
  admin: 'token re-copy per account, backups, messages and reports',
};
export function settingsSearchEntries(open: (s: SettingsSection) => void, shown: SettingsSection[] = SECTIONS.map(([id]) => id), admin = false): SearchEntry[] {
  return SECTIONS.filter(([id]) => shown.includes(id) && (id !== 'admin' || admin))
    .map(([id, label]) => ({ id: 'Settings ▸ ' + label, label: `${label} — ${SECTION_WORDS[id]}`, path: ['Settings'], fixed: true, stat: 'Settings ▸ ' + label, action: () => open(id) }));
}
/** a document's own font in the command palette: Document ▸ Text styles ▸ Normal text, as the document and its PDF have it */
export const documentFontEntry = (open: () => void): SearchEntry => ({ id: 'Document ▸ Font of the whole document', label: 'Font of the whole document (Text styles ▸ Normal text)', path: ['Document'], fixed: true, stat: 'Document ▸ Font of the whole document', action: open });

/**
 * Settings ▸ Account ▸ Delete account: what goes (the projects owned, shared ones marked — they can be
 * handed over in their Share dialog first), confirmed by typing the user name; then this browser
 * forgets the account as at sign-out and the start page appears (server accounts.ts).
 */
function DeleteAccount({ user }: { user: User }) {
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<DeletionPreview | null>(null);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => { if (open && !preview) api.accountDeletion().then(setPreview).catch(e => setErr((e as Error).message)); }, [open]);
  const confirmed = typed.trim().toLowerCase() === user.username.toLowerCase();
  const remove = async () => {
    if (!confirmed || busy) return;
    setBusy(true); setErr('');
    try {
      await api.deleteAccount(typed.trim());
      await clearLocalData();
      try { localStorage.removeItem('ol.user'); localStorage.removeItem('ol.spell.words'); } catch { /* ignore */ }
      await uiAlert('Account deleted', 'Your account and your projects have been deleted. The nightly backups forget them within 14 days.');
      location.replace('/');
    } catch (e) { setErr((e as Error).message); setBusy(false); }
  };
  const shared = preview?.owned.filter(p => p.people > 0) ?? [];
  return <>
    <h3 class="set-group">Delete account</h3>
    {!open && <div class="sub">Deletes your account, the projects you own and everything OverLyX keeps about you (<a href="/privacy#delete" target="_blank" rel="noopener">what exactly</a>). <button class="btn small danger" data-delete-account onClick={() => setOpen(true)}>Delete account…</button></div>}
    {open && <div class="delete-account" data-delete-panel>
      {!preview && !err && <div class="sub">Checking what would be deleted…</div>}
      {preview?.refused && <div class="err">{preview.refused}</div>}
      {preview && !preview.refused && <>
        <p>This deletes your account <b>{user.username}</b> right away. It cannot be undone.</p>
        {preview.owned.length
          ? <p>{preview.owned.length === 1 ? 'The project you own is' : `The ${preview.owned.length} projects you own are`} deleted with it, with their history:</p>
          : <p>You own no projects.</p>}
        {preview.owned.length > 0 && <ul class="delete-projects" data-delete-projects>
          {preview.owned.map(p => <li key={p.project}>{p.title || p.project.split('/').pop()}{p.people > 0 && <b class="warn"> — shared with {p.people} {p.people === 1 ? 'person' : 'people'}, who lose it too</b>}</li>)}
        </ul>}
        {shared.length > 0 && <p class="sub">To keep a shared project going, open its Share dialog and choose <b>Make owner…</b> next to a collaborator first.</p>}
        {preview.memberOf > 0 && <p class="sub">You leave {preview.memberOf} project{preview.memberOf === 1 ? '' : 's'} of other people; what you wrote there stays.</p>}
        <p class="sub">Download what you want to keep first (Download on the start page).</p>
        <label class="row">Type your user name <code>{user.username}</code> to confirm:
          <input type="text" value={typed} autoComplete="off" spellcheck={false} data-delete-confirm onInput={e => setTyped((e.target as HTMLInputElement).value)} onKeyDown={e => { if (e.key === 'Enter') void remove(); }} />
        </label>
        <div class="row">
          <button class="btn danger" disabled={!confirmed || busy} data-delete-go onClick={() => void remove()}>{busy ? 'Deleting…' : 'Delete my account'}</button>
          <button class="btn" disabled={busy} onClick={() => { setOpen(false); setTyped(''); setErr(''); }}>Cancel</button>
        </div>
      </>}
      {err && <div class="err">{err}</div>}
    </div>}
  </>;
}

/**
 * Administrators: what reached the people who run the instance — mail to privacy@ / contact@ (received
 * on the server, never forwarded), problem reports from Help ▸ Report a problem, and errors the app
 * ran into (server feedback.ts). Read here; a handled one can be deleted.
 */
const REPORT_KINDS: [string, string][] = [['mail', 'Mail'], ['feedback', 'Problem reports'], ['client-error', 'Errors (browser)'], ['client-glitch', 'Glitches (touch screens)'], ['server-error', 'Errors (server)'], ['vscode-error', 'Errors (VS Code)']];
/** The off-site backup at a glance (administrators): its last run and its last restore check — red when one failed or is overdue. */
function AdminBackups() {
  const [s, setS] = useState<{ configured: boolean; backup: BackupRun | null; check: BackupRun | null } | null>(null);
  useEffect(() => { api.adminBackups().then(setS).catch(() => setS(null)); }, []);
  if (!s) return null;
  const ago = (iso: string) => { const h = (Date.now() - Date.parse(iso)) / 3_600_000; return h < 48 ? `${Math.max(0, Math.round(h))} h ago` : `${Math.round(h / 24)} days ago`; };
  const line = (label: string, r: BackupRun | null, maxHours: number, what: (r: BackupRun) => string) => {
    const late = !r || Date.now() - Date.parse(r.finished) > maxHours * 3_600_000;
    const bad = !r || !r.ok || late;
    return (
      <div class={bad ? 'err' : 'sub'} data-backup={label}>
        {label}: {!r ? 'no run yet' : r.ok ? `ok, ${ago(r.finished)} — ${what(r)}` : `FAILED ${ago(r.finished)} — ${r.note ?? ''}`}{r?.ok && late ? ' — overdue' : ''}
      </div>
    );
  };
  return (
    <>
      <h3 class="set-group">Backups</h3>
      {!s.configured
        ? <div class="err" data-backup="none">No off-site backup is set up: as root, <code>bash deploy/setup-backup-offsite.sh</code> (DOCS.md “Backups and restoring”).</div>
        : <>
          {line('Off-site backup', s.backup, 36, r => `${r.files ?? '?'} files, ${Math.round(Number(r.added ?? 0) / 1048576)} MB new`)}
          {line('Restore check', s.check, 9 * 24, r => r.note ?? '')}
        </>}
    </>
  );
}

function AdminReports() {
  const [kind, setKind] = useState('mail');
  const [rows, setRows] = useState<AdminReport[] | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => { setRows(null); api.adminReports(kind).then(r => setRows(r.reports)).catch(e => setErr((e as Error).message)); }, [kind]);
  const remove = async (id: number) => {
    try { await api.deleteAdminReport(id); setRows(list => (list ?? []).filter(r => r.id !== id)); } catch (e) { setErr((e as Error).message); }
  };
  const when = (t: number) => new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  return <>
    <h3 class="set-group">Messages and reports (administrator)</h3>
    <div class="admin-reports" data-admin-reports>
      <div class="ar-kinds">{REPORT_KINDS.map(([k, label]) => <button key={k} class={'btn small' + (k === kind ? ' active' : '')} onClick={() => setKind(k)} data-ar-kind={k}>{label}</button>)}</div>
      {err && <div class="err">{err}</div>}
      {rows === null && !err && <div class="sub">Loading…</div>}
      {rows && !rows.length && <div class="sub">Nothing here.</div>}
      {rows?.map(r => (
        <div key={r.id} class={'ar-row' + (open === r.id ? ' open' : '')} data-ar-row={r.id}>
          <button class="ar-head" onClick={() => setOpen(o => (o === r.id ? null : r.id))}>
            <span class="ar-title">{r.title}</span>
            <span class="sub">{r.from ? `${r.from} · ` : ''}{when(r.lastAt)}{r.count > 1 ? ` · ${r.count}×` : ''}</span>
          </button>
          {open === r.id && <>
            <pre class="ar-body">{r.body}</pre>
            {r.kind === 'mail' && <MailAnswer id={r.id} onSent={() => void api.adminReports(kind).then(x => setRows(x.reports)).catch(() => {})} />}
            <button class="btn small danger" onClick={() => void remove(r.id)}>Delete</button>
          </>}
        </div>
      ))}
    </div>
  </>;
}

/** An answer to mail sent to privacy@ / contact@: it goes out from that address (server feedback.ts answerMail) and is kept with the message. */
function MailAnswer({ id, onSent }: { id: number; onSent: () => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ err: boolean; text: string } | null>(null);
  const send = async () => {
    setBusy(true); setNote(null);
    try {
      const r = await api.answerAdminReport(id, text);
      setText(''); setNote({ err: false, text: `Sent to ${r.to} from ${r.from}.` }); onSent();
    } catch (e) { setNote({ err: true, text: (e as Error).message }); }
    finally { setBusy(false); }
  };
  return (
    <div class="ar-answer" data-ar-answer>
      <textarea rows={5} placeholder="Answer (sent from the address this message was sent to)" value={text} onInput={e => setText((e.target as HTMLTextAreaElement).value)} />
      <button class="btn small" disabled={busy || !text.trim()} onClick={() => void send()}>{busy ? 'Sending…' : 'Send answer'}</button>
      {note && <div class={note.err ? 'err' : 'sub'}>{note.text}</div>}
    </div>
  );
}

/** Settings ▸ Account: the account's own access token and sign-ins — never anybody else's */
function AccountCredentials({ children }: { children: ComponentChildren }) {
  const t = useAccountTokens();
  return <>
    <h3 class="set-group">Access token</h3>
    <p class="set-desc">Your account access token is the password for Git and the OverLyX CLI, and an MCP Bearer token. Its text can be copied again only with token re-copy (below); otherwise it was shown once, when it was made.</p>
    <AccountTokenList t={t} />
    <h3 class="set-group">Sign-ins</h3>
    <p class="set-desc">Signing in the OverLyX CLI on a computer (<code>overlyx auth login</code>) gives it — git, builds, the AI agents there — a credential of its own; so does connecting an OAuth client such as ChatGPT. Each reaches your projects with your role in each, unless it was narrowed; revoke one here.</p>
    <SignInList t={t} />
    {children}
  </>;
}
