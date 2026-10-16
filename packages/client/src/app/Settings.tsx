/**
 * The centralized Settings panel (Tools ▸ Settings…, and the avatar menu on every screen — so it
 * is reachable from the start screen too, which has no Tools menu). One dialog for everything a
 * user configures:
 *   Editor       the editor's font, spell checking, automatic PDF builds (this browser, prefs.ts)
 *   AI           the AI features and models        (this browser, prefs.ts)
 *   Appearance   light / dark / follow the system  (this browser, theme.ts)
 *   Account      who is signed in, the account's own access token and sign-ins (Git.tsx, as in
 *                File ▸ Git repository), and the per-account server settings (userSettings.ts):
 *                fine-grained access for new sign-ins (the user's own switch); token re-copy —
 *                administrators switch it per account right here.
 */
import { UiChoice } from './Tour';
import { useEffect, useMemo, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { api, type AiStatus, type AiModelInfo, type User, type UserSettings, type AdminUser, type DeletionPreview, type AdminReport } from '../api';
import { clearLocalData } from './localData';
import { getPrefs, setPref, subscribePrefs, type Prefs } from '../prefs';
import { recordReliability } from '../usage';
import { resetShortcutTips } from '../shortcuttips';
import { useAccountTokens, AccountTokenList, SignInList } from './Git';
import { stashLyxBind, ctrlINow, ctrlIPlan, CTRLI_COMMANDS, type CtrlI } from './lyxbind';
import { resetAllBindings, getBindings, setBinding, subscribeBindings } from './keybindings';
import { useUiMode } from './uimode';
import { formatShortcut } from './shortcuts';
import { setThemePref, useTheme, DARK_TONES, type ThemePref } from './theme';
import { REWRITE_KEY } from '../editor/ai/rewrite';
import { Dialog, uiAlert } from './Dialogs';
import { AUTO_BUILD_CHOICES, AUTO_BUILD_DELAYS } from './pdfstatus';
import { EDITOR_FACES, MATH_FONTS, FOLLOW_DOCUMENT, MATCH_TEXT, editorFace, mathFont } from '../fonts/catalog';
import { resolvedFace, resolvedMath } from '../fonts/editorfont';
import { renderMath } from '../editor/lyxmath/mathjax';
import { useMathRendererVersion } from '../editor/lyxmath/usemath';

const SECTIONS = [['editor', 'Editor'], ['ai', 'AI assistance'], ['appearance', 'Appearance'], ['privacy', 'Privacy'], ['account', 'Account']] as const;
export type SettingsSection = (typeof SECTIONS)[number][0];

const Row = ({ label, children }: { label: string; children: ComponentChildren }) => <div class="row"><label>{label}</label>{children}</div>;

/** A model choice: the server's default, one of the offered models, or a typed-in id. */
function ModelPicker({ label, value, fallback, models, onChange, pref }: { label: string; value: string; fallback: string; models: AiModelInfo[]; onChange: (v: string) => void; pref: string }) {
  const known = !value || models.some(m => m.id === value);
  const [custom, setCustom] = useState(!known);
  const cur = models.find(m => m.id === (value || fallback));
  return (
    <div class="row model-row">
      <label>{label}</label>
      <div style="flex:1;display:flex;flex-direction:column;gap:4px">
        <select data-pref={pref} value={custom ? '__custom' : value} onChange={e => { const v = (e.target as HTMLSelectElement).value; if (v === '__custom') { setCustom(true); return; } setCustom(false); onChange(v); }}>
          <option value="">Server default{fallback ? ` (${models.find(m => m.id === fallback)?.label ?? fallback})` : ''}</option>
          {models.map(m => <option key={m.id} value={m.id}>{m.label} — AA {m.aa ?? '?'} · {m.speed} — {m.note}</option>)}
          <option value="__custom">Other model id…</option>
        </select>
        {custom && <input type="text" data-pref-custom={pref} placeholder="provider/model-id (OpenRouter)" value={value} onInput={e => onChange((e.target as HTMLInputElement).value.trim())} />}
        {!custom && cur && value && <span class="sub">{cur.id}</span>}
      </div>
    </div>
  );
}

/**
 * The sample under Settings ▸ Editor ▸ Font, in the fonts chosen: the test document of
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

export function SettingsPanel({ ai, user, initial, onClose, sections = SECTIONS.map(([id]) => id) }: { sections?: SettingsSection[]; ai: AiStatus | null; user: User; initial?: SettingsSection; onClose: () => void }) {
  const [section, setSection] = useState<SettingsSection>(initial ?? 'editor');
  const [p, setP] = useState<Prefs>(getPrefs);
  useEffect(() => subscribePrefs(setP), []);
  const { pref: themeChoice } = useTheme();
  // LyX's keys and .bind files are offered in the Classic interface only (people who know LyX)
  const classic = useUiMode() === 'classic';
  const [bindings, setBindings] = useState(getBindings);
  useEffect(() => subscribeBindings(() => setBindings(getBindings())), []);
  const ctrlI = ctrlINow(bindings, CTRLI_COMMANDS);
  const setCtrlI = (v: CtrlI) => { for (const b of ctrlIPlan(v, CTRLI_COMMANDS)) setBinding(b.id, b.key); };
  const [settings, setSettings] = useState<UserSettings | null>(null);
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => { if (sections.includes('account')) api.settings().then(r => setSettings(r.settings)).catch(() => {}); }, []);
  useEffect(() => {
    if (section === 'account' && user.isAdmin && users === null) api.users().then(r => setUsers(r.users)).catch(e => setErr((e as Error).message));
  }, [section]);

  const check = (key: 'spellcheck' | 'autoCorrect' | 'invertFigures' | 'aiButton' | 'aiRewrite' | 'aiCompleteText' | 'aiCompleteMath' | 'aiInk' | 'usageStats' | 'betaDiagnostics' | 'shortcutTips' | 'darkPages', label: string, hint: string, disabled = false) => (
    <label class={'pref' + (disabled ? ' disabled' : '')}><input type="checkbox" data-pref={key} checked={p[key]} disabled={disabled} onChange={e => { const checked = (e.target as HTMLInputElement).checked; setPref(key, checked); if (key === 'betaDiagnostics' && checked) recordReliability('diagnostics.enabled'); }} /><span>{label}<span class="sub">{hint}</span></span></label>
  );
  // smart invert and the text tone (app/darkpages.ts): Appearance, or the editor's section where a shell has no Appearance (VS Code)
  const darkTheme = <div data-settings-dark>
    <h3>Dark theme</h3>
    {check('darkPages', 'Smart invert pages', 'The content of every page is shown light on dark — documents, PDFs, slides and posters, layout pages — in the page colour and text tone of the dark theme; colours keep their hue. Off: every page keeps its own colours, white paper inside the dark interface. Presenting shows slides as designed. The theme switch’s menu, the ◐ in the PDF toolbar and beside a deck’s zoom switch it too.')}
    {check('invertFigures', 'Smart invert figures too', 'Plots and diagrams on a white or transparent base turn light on dark with the page; photographs keep their colours (each picture is judged by its pixels). Off: every picture keeps its colours.', !p.darkPages)}
    <Row label="Text">{DARK_TONES.map(t => (
      <label class="pref inline" key={t.id}><input type="radio" name="ol-dark-tone" data-pref-tone={t.id} checked={p.darkTone === t.id} onChange={() => setPref('darkTone', t.id)} /><span>{t.label}</span></label>
    ))}</Row>
    <div class="sub">The text and formulas of the dark theme in white, or in a warmer or softer tone like Apple Books’ sepia and grey reading themes — PDFs take it too.</div>
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

  return (
    <Dialog title="Settings" onClose={onClose} wide>
      <div class="settings-dialog">
        <div class="settings-nav">
          {SECTIONS.filter(([id]) => sections.includes(id)).map(([id, label]) => <button key={id} class={section === id ? 'active' : ''} onClick={() => setSection(id)}>{label}</button>)}
        </div>
        <div class="settings-content">
          {section === 'editor' && <>
            <h3>Font</h3>
            <div class="sub">How the editor shows the text and formulas, in this browser; the PDF has its own fonts (Document ▸ Settings ▸ Fonts). The fonts come with OverLyX and are loaded once chosen. Formulas are laid out by MathJax from the math font’s own data, as TeX does from an OpenType math font; text inside formulas is in the text font.</div>
            <Row label="Text font"><select data-pref="editorFont" value={p.editorFont === FOLLOW_DOCUMENT ? p.editorFont : editorFace(p.editorFont).id} onChange={e => setPref('editorFont', (e.target as HTMLSelectElement).value)}>
              <option value={FOLLOW_DOCUMENT}>As in the document — the closest of these to the PDF’s font (now {editorFace(resolvedFace(FOLLOW_DOCUMENT)).label})</option>
              {EDITOR_FACES.map(f => <option key={f.id} value={f.id}>{f.label} — {f.hint}</option>)}
            </select></Row>
            <Row label="Math font"><select data-pref="editorMathFont" value={p.editorMathFont === MATCH_TEXT ? p.editorMathFont : mathFont(p.editorMathFont).id} onChange={e => setPref('editorMathFont', (e.target as HTMLSelectElement).value)}>
              <option value={MATCH_TEXT}>Matching the text font (now {mathFont(resolvedMath({ editorFont: p.editorFont, editorMathFont: MATCH_TEXT })).label})</option>
              {MATH_FONTS.map(f => <option key={f.id} value={f.id}>{f.label} — {f.hint}</option>)}
            </select></Row>
            <FontSample />
            <h3>Text</h3>
            {check('spellcheck', 'Spell checking', 'Misspelt words are underlined; the right-click menu offers corrections.')}
            {check('autoCorrect', 'Autocorrect typos', 'A minor typo is fixed when the word is finished (never in formulas); Backspace right after puts it back.')}
            <Row label="Checker"><select data-pref="spellEngine" value={p.spellEngine} onChange={e => setPref('spellEngine', (e.target as HTMLSelectElement).value as Prefs['spellEngine'])}>
              <option value="overlyx">OverLyX — instant, knows LaTeX (skips formulas, commands, code), suggestions in the menu; English, British, German, French</option>
              <option value="browser">Browser — the browser's own checker (checks slowly after a click; suggestions only via {/Mac/.test(navigator.platform) ? '⇧' : 'Shift+'}right-click)</option>
            </select></Row>
            <h3>Formulas</h3>
            <Row label="Math keyboard"><select data-pref="mathKeyboard" value={p.mathKeyboard} onChange={e => setPref('mathKeyboard', (e.target as HTMLSelectElement).value as Prefs['mathKeyboard'])}>
              <option value="auto">On touch screens — until a hardware keyboard is used</option>
              <option value="on">Always — whenever a formula has the cursor</option>
              <option value="off">Never — the system keyboard</option>
            </select></Row>
            <div class="sub">A keyboard for formulas at the bottom of the screen, in place of the system keyboard: numbers and structures, functions, Greek, relations, letters — and ✎ Write, to write a formula by hand (Settings ▸ AI). Its ⌨ key hands over to the system keyboard.</div>
            <h3>PDF</h3>
            <div class="sub">Build the PDF by itself a moment after the document is saved (it is saved 1.5 s after you stop typing). Builds run in the background on the server.</div>
            {AUTO_BUILD_CHOICES.map(([v, label, hint]) => (
              <label class="pref" key={v}><input type="radio" name="ol-autobuild-settings" data-pref-autobuild={v} checked={p.autoBuild === v} onChange={() => setPref('autoBuild', v)} /><span>{label}<span class="sub">{hint}</span></span></label>
            ))}
            <Row label="Start after the save"><select data-pref="autoBuildDelay" value={String(p.autoBuildDelay)} disabled={p.autoBuild === 'off'} onChange={e => setPref('autoBuildDelay', Number((e.target as HTMLSelectElement).value))}>
              {AUTO_BUILD_DELAYS.map(d => <option key={d} value={String(d)}>{d === 0 ? 'right away' : `${d} s`}</option>)}
            </select></Row>
            {!sections.includes('appearance') && darkTheme}
            <h3>Shortcuts</h3>
            {check('shortcutTips', 'Shortcut tips', 'An action that has a shortcut but is taken with the mouse — a toolbar button, a menu entry, the right-click menu — shows its shortcut from the third time on, five times; pressing the shortcut once ends its tips.')}
            <Row label=""><button type="button" data-reset-shortcut-tips disabled={!p.shortcutTips} onClick={() => resetShortcutTips()}>Show all tips again</button></Row>
            {classic ? <div data-from-lyx>
              <h3>Coming from LyX</h3>
              <div class="sub">OverLyX uses LyX’s default keys (cua.bind, menus.bind, math.bind), except that {formatShortcut('Ctrl+I')} is italic, as in other editors, unless you choose LyX’s meaning here. Bring your own keys from LyX too: choose its <code>bind/user.bind</code> (or another .bind file) — what it binds to a command OverLyX has becomes that command’s shortcut, on every browser you sign in with.</div>
              <Row label={formatShortcut('Ctrl+I')}><select data-ctrl-i value={ctrlI} onChange={e => setCtrlI((e.target as HTMLSelectElement).value as CtrlI)}>
                <option value="italic">Italic, as in other editors</option>
                <option value="inset">Opens and closes the inset at the cursor, as in LyX</option>
              </select></Row>
              <Row label="">
                <button type="button" data-import-lyxbind onClick={e => (e.currentTarget.nextElementSibling as HTMLInputElement | null)?.click()}>Import LyX key bindings (.bind)…</button>
                <input type="file" accept=".bind,text/plain" hidden data-import-lyxbind-file onChange={e => { const f = (e.target as HTMLInputElement).files?.[0]; (e.target as HTMLInputElement).value = ''; if (f) void f.text().then(t => stashLyxBind(f.name, t)); }} />
                <button type="button" data-reset-shortcuts onClick={() => resetAllBindings()}>Back to the default keys</button>
              </Row>
            </div> : (
              <Row label=""><button type="button" data-reset-shortcuts onClick={() => resetAllBindings()}>Back to the default keys</button></Row>
            )}
          </>}
          {section === 'ai' && <>
            <h3>AI assistance</h3>
            <div class="sub">{ai === null ? 'Checking the server…' : ai.available ? `Available on this server — model ${ai.model}${ai.completionModel !== ai.model ? `, autocomplete ${ai.completionModel}` : ''}.` : 'Not configured on this server: the administrator has to set OPENROUTER_API_KEY (deploy/secrets.env). The switches below have no effect until then.'}</div>
            {check('aiButton', 'Show the ✦ AI button on the toolbar', 'One button that switches autocomplete (text and formulas) on and off. Hidden until you enable it here.')}
            {check('aiRewrite', `Rewrite with AI (${REWRITE_KEY})`, 'Select text or a formula, press the key and describe the change; the proposal is shown in place and applied only when you accept it.')}
            {check('aiCompleteText', 'Autocomplete text', 'After a pause while typing, a continuation appears in grey after the caret — formulas already rendered — while ✦ AI… shows in the status bar. Tab inserts it, anything else dismisses it. Works at the end of a word or paragraph, in ordinary text.')}
            {check('aiCompleteMath', 'Autocomplete formulas', 'The same inside formulas: a suggested continuation at the caret, Tab inserts it.')}
            {check('aiInk', 'Read handwritten formulas', `The math keyboard’s ✎ Write: what you write with a pen or a finger is read as LaTeX — a picture of it and the formula around the cursor go to the model${ai?.inkModel ? ` (${ai.inkModel})` : ''}. Nothing is inserted until you tap a reading.`)}
            <Row label="Pause before suggesting"><input type="number" min={80} max={5000} step={20} value={p.aiCompleteDelay} onInput={e => setPref('aiCompleteDelay', Math.max(80, Number((e.target as HTMLInputElement).value) || 200))} style="max-width:90px" /> ms</Row>
            <h3>Models</h3>
            <div class="sub">Any OpenRouter model id works; the notes are from measurements on a real paper. The choice is kept in this browser.</div>
            <ModelPicker label={`Rewrite (${REWRITE_KEY})`} value={p.aiModel} fallback={ai?.model ?? ''} models={ai?.models ?? []} onChange={v => setPref('aiModel', v)} pref="aiModel" />
            <ModelPicker label="Autocomplete" value={p.aiCompletionModel} fallback={ai?.completionModel ?? ''} models={ai?.models ?? []} onChange={v => setPref('aiCompletionModel', v)} pref="aiCompletionModel" />
            <div class="sub">What is sent: your instruction or the text around the cursor together with the document’s LaTeX source (so the model knows the notation, macros, citation keys) goes to the model through the OverLyX server. Nothing is written to the document without your Tab or Accept. The switches are also in the Tools menu, so the command palette finds them.</div>
          </>}
          {section === 'appearance' && <>
            <h3>Interface</h3>
            <div class="sub">Classic shows LyX’s toolbars and menus; Modern is calmer and simpler — one toolbar, tools that appear when you need them. The same functions either way. Kept for your account.</div>
            <UiChoice />
            <h3>Theme</h3>
            <div class="sub">Kept in this browser.</div>
            {THEMES.map(([v, label, hint]) => (
              <label class="pref" key={v}><input type="radio" name="ol-theme" data-theme-pref={v} checked={themeChoice === v} onChange={() => setThemePref(v)} /><span>{label}{hint && <span class="sub">{hint}</span>}</span></label>
            ))}
            {darkTheme}
          </>}
          {section === 'privacy' && <>
            <h3>Usage statistics</h3>
            {check('usageStats', 'Send anonymous usage statistics', 'Which menu entries, buttons, shortcuts and dialogs are used, and which of them do nothing, are undone right away or end in an error message — so that confusing parts of the editor can be found and fixed.')}
            <div class="sub" data-setting="usage-what">What is sent: the kind of action (for example “Edit ▸ Text Style ▸ Bold”, “toolbar m-frac”, “Ctrl+Shift+K unbound”, “Citation dialog dismissed”), where it happened (text, formula, table, dialog), the template of an error message with its data removed, the kind of screen, and a random id for this page load. Never your name or account, document or project names, text, formulas or file names — quoted strings, file names and numbers are removed before anything leaves the browser, and again on the server. The browser’s Global Privacy Control signal switches it off as well. Kept in this browser.</div>
            <div class="sub">Detailed diagnostics also record fixed categories for clicks, context menus, drag/drop, paste/cut and deletion outcomes, selection type, empty or filled notes, collapsed or margin display, editing permissions, change tracking, pointer type, API success or failure, connectivity, resource errors and duration buckets. Short action trails help investigate errors, repeated attempts and undo. No input values, typed text, clipboard contents, positions, URLs or identifiers are collected. Detailed events are kept for 30 days.</div>
            <h3>Beta reliability diagnostics</h3>
            {check('betaDiagnostics', 'Send beta reliability diagnostics', 'Optional: keyboard-load fallback, cancelled touch/pen gestures, canvas recovery, save-state transitions and background/orientation changes. Only fixed event names, pointer kind, coarse context, duration buckets and a random ID for this page load; never text, formulas, coordinates, pressure, file names, document or account identifiers. Kept on this server for 30 days. Usage statistics, Global Privacy Control and the server’s statistics switch still apply.', !p.usageStats)}
            <h3>Problem reports</h3>
            <div class="sub">What you send with Help ▸ Report a problem, and errors the app runs into, stay on this server — read by its operator, never published. Never the content of your documents.</div>
            <h3>Privacy notice</h3>
            <div class="sub">What OverLyX keeps about you, who else sees it, how long it stays and how to delete it: <a href="/privacy" target="_blank" rel="noopener" data-privacy-link>the privacy notice</a>.</div>
          </>}
          {section === 'account' && <>
            <h3>Signed in</h3>
            <div data-setting="whoami">{user.name} ({user.username}){user.isAdmin ? ' — administrator' : ''}</div>
            {!user.guest && <AccountCredentials><label class="pref"><input type="checkbox" data-setting="fine-grained" disabled={settings === null} checked={!!settings?.fineGrainedAccess} onChange={e => void toggleAccountSetting({ fineGrainedAccess: (e.target as HTMLInputElement).checked })} /><span>Fine-grained access<span class="sub">When you authorize a new sign-in, choose which projects it reaches and whether it may only read (clone, pull, read and build — no push, edits or comments). Sign-ins made before keep their access; switching this off does not widen narrowed ones.</span></span></label></AccountCredentials>}
            {!user.guest && <>
              <h3>New documents</h3>
              <label class="pref"><input type="checkbox" data-setting="paragraph-skip" disabled={settings === null} checked={!!settings?.paragraphSkip} onChange={e => void toggleAccountSetting({ paragraphSkip: (e.target as HTMLInputElement).checked })} /><span>No paragraph indentation<span class="sub">Documents you create separate paragraphs by vertical space instead of indenting their first line, in the editor and in the PDF (Document ▸ Settings ▸ Paragraph separation, which each document can change). Documents that exist already keep their setting.</span></span></label>
            </>}
            {err && !user.isAdmin && <div class="err">{err}</div>}
            <h3>Token re-copy</h3>
            <div class="sub">The account access token (File ▸ Git repository…) works with Git, the CLI and MCP. It is normally shown exactly once — only a hash is kept. With re-copy enabled, its plaintext remains on the server and the Git dialog offers Copy again later. This convenience stores a recoverable secret, so it is off by default; an administrator switches it per account.</div>
            <div data-setting="recopy"><b>{settings === null ? 'Checking…' : settings.allowRecopyTokens ? 'Enabled for your account' : 'Disabled for your account'}</b>{settings !== null && !settings.allowRecopyTokens ? ' (the default)' : ''}</div>
            {user.isAdmin && <>
              <h3>Per-account (administrator)</h3>
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
            </>}
            {user.isAdmin && <AdminReports />}
            {!user.guest && <DeleteAccount user={user} />}
          </>}
        </div>
      </div>
    </Dialog>
  );
}

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
    <h3>Delete account</h3>
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
const REPORT_KINDS: [string, string][] = [['mail', 'Mail'], ['feedback', 'Problem reports'], ['client-error', 'Errors (browser)'], ['server-error', 'Errors (server)'], ['vscode-error', 'Errors (VS Code)']];
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
    <h3>Messages and reports (administrator)</h3>
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
            <button class="btn small danger" onClick={() => void remove(r.id)}>Delete</button>
          </>}
        </div>
      ))}
    </div>
  </>;
}

/** Settings ▸ Account: the account's own access token and sign-ins — never anybody else's */
function AccountCredentials({ children }: { children: ComponentChildren }) {
  const t = useAccountTokens();
  return <>
    <h3>Access token</h3>
    <div class="sub">Your account access token is the password for Git and the OverLyX CLI, and an MCP Bearer token. Its text can be copied again only with token re-copy (below); otherwise it was shown once, when it was made.</div>
    <AccountTokenList t={t} />
    <h3>Sign-ins</h3>
    <div class="sub">Signing in the OverLyX CLI on a computer (<code>overlyx auth login</code>) gives it — git, builds, the AI agents there — a credential of its own; so does connecting an OAuth client such as ChatGPT. Each reaches your projects with your role in each, unless it was narrowed; revoke one here.</div>
    <SignInList t={t} />
    {children}
  </>;
}
