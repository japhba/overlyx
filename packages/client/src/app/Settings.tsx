/**
 * The centralized Settings panel (Tools ▸ Settings…, and the avatar menu on every screen — so it
 * is reachable from the start screen too, which has no Tools menu). One dialog for everything a
 * user configures:
 *   Editor       the editor's font, spell checking, automatic PDF builds (this browser, prefs.ts)
 *   AI           the AI features and models        (this browser, prefs.ts)
 *   Appearance   light / dark / follow the system  (this browser, theme.ts)
 *   Account      who is signed in, and the per-account server settings (userSettings.ts):
 *                token re-copy — administrators switch it per account right here.
 */
import { useEffect, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { api, type AiStatus, type AiModelInfo, type User, type UserSettings, type AdminUser } from '../api';
import { getPrefs, setPref, subscribePrefs, type Prefs } from '../prefs';
import { setThemePref, useTheme, type ThemePref } from './theme';
import { REWRITE_KEY } from '../editor/ai/rewrite';
import { Dialog } from './Dialogs';
import { AUTO_BUILD_CHOICES, AUTO_BUILD_DELAYS } from './pdfstatus';
import { EDITOR_FACES, FOLLOW_DOCUMENT, editorFace } from '../fonts/catalog';
import { resolvedFace } from '../fonts/editorfont';
import katex from 'katex';

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

/** A line of text with a formula in the editor's current face (the sample under Settings ▸ Editor ▸ Font). */
const FONT_SAMPLE_MATH = katex.renderToString('\\nabla_{\\!\\theta}\\, \\mathcal{L} = \\sum_{k=1}^{n} \\alpha_k x_k^2 \\le \\int_0^\\infty e^{-t}\\, dt', { throwOnError: false, output: 'html' });
function FontSample() {
  return <div class="lyx-editor font-sample" data-font-sample aria-hidden="true">The quick brown fox, <i>jumps over</i> <b>the lazy dog</b> — 0123456789. <span dangerouslySetInnerHTML={{ __html: FONT_SAMPLE_MATH }} /></div>;
}

const THEMES: [ThemePref, string, string][] = [
  ['system', 'Follow the system', 'Light or dark with the operating system.'],
  ['light', 'Light', ''],
  ['dark', 'Dark', ''],
];

export function SettingsPanel({ ai, user, initial, onClose, sections = SECTIONS.map(([id]) => id) }: { sections?: SettingsSection[]; ai: AiStatus | null; user: User; initial?: SettingsSection; onClose: () => void }) {
  const [section, setSection] = useState<SettingsSection>(initial ?? 'editor');
  const [p, setP] = useState<Prefs>(getPrefs);
  useEffect(() => subscribePrefs(setP), []);
  const { pref: themeChoice } = useTheme();
  const [settings, setSettings] = useState<UserSettings | null>(null);
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => { if (sections.includes('account')) api.settings().then(r => setSettings(r.settings)).catch(() => {}); }, []);
  useEffect(() => {
    if (section === 'account' && user.isAdmin && users === null) api.users().then(r => setUsers(r.users)).catch(e => setErr((e as Error).message));
  }, [section]);

  const check = (key: 'spellcheck' | 'autoCorrect' | 'invertFigures' | 'aiButton' | 'aiRewrite' | 'aiCompleteText' | 'aiCompleteMath' | 'usageStats', label: string, hint: string) => (
    <label class="pref"><input type="checkbox" data-pref={key} checked={p[key]} onChange={e => setPref(key, (e.target as HTMLInputElement).checked)} /><span>{label}<span class="sub">{hint}</span></span></label>
  );
  const toggleRecopy = async (u: AdminUser) => {
    setErr('');
    try {
      const r = await api.adminUserSettings(u.id, { allowRecopyTokens: !u.allowRecopyTokens });
      setUsers(list => (list ?? []).map(x => (x.id === u.id ? { ...x, allowRecopyTokens: r.settings.allowRecopyTokens } : x)));
      if (u.id === user.id) setSettings(r.settings);
    } catch (e) { setErr((e as Error).message); }
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
            <div class="sub">How the editor shows the text and formulas, in this browser. The PDF has its own fonts: Document ▸ Settings ▸ Fonts. Fonts other than Computer Modern come from Google Fonts, loaded once you choose one; the sans-serif is the system’s San Francisco where it has one.</div>
            <Row label="Editor font"><select data-pref="editorFont" value={p.editorFont === FOLLOW_DOCUMENT ? p.editorFont : editorFace(p.editorFont).id} onChange={e => setPref('editorFont', (e.target as HTMLSelectElement).value)}>
              <option value={FOLLOW_DOCUMENT}>As in the document — the closest of these to the PDF’s font (now {editorFace(resolvedFace(FOLLOW_DOCUMENT)).label})</option>
              {EDITOR_FACES.map(f => <option key={f.id} value={f.id}>{f.label} — {f.hint}</option>)}
            </select></Row>
            <FontSample />
            <h3>Text</h3>
            {check('spellcheck', 'Spell checking', 'Misspelt words are underlined; the right-click menu offers corrections.')}
            {check('autoCorrect', 'Autocorrect typos', 'A minor typo is fixed when the word is finished (never in formulas); Backspace right after puts it back.')}
            <Row label="Checker"><select data-pref="spellEngine" value={p.spellEngine} onChange={e => setPref('spellEngine', (e.target as HTMLSelectElement).value as Prefs['spellEngine'])}>
              <option value="overlyx">OverLyX — instant, knows LaTeX (skips formulas, commands, code), suggestions in the menu; English, British, German, French</option>
              <option value="browser">Browser — the browser's own checker (checks slowly after a click; suggestions only via {/Mac/.test(navigator.platform) ? '⇧' : 'Shift+'}right-click)</option>
            </select></Row>
            <h3>PDF</h3>
            <div class="sub">Build the PDF by itself a moment after the document is saved (it is saved 1.5 s after you stop typing). Builds run in the background on the server.</div>
            {AUTO_BUILD_CHOICES.map(([v, label, hint]) => (
              <label class="pref" key={v}><input type="radio" name="ol-autobuild-settings" data-pref-autobuild={v} checked={p.autoBuild === v} onChange={() => setPref('autoBuild', v)} /><span>{label}<span class="sub">{hint}</span></span></label>
            ))}
            <Row label="Start after the save"><select data-pref="autoBuildDelay" value={String(p.autoBuildDelay)} disabled={p.autoBuild === 'off'} onChange={e => setPref('autoBuildDelay', Number((e.target as HTMLSelectElement).value))}>
              {AUTO_BUILD_DELAYS.map(d => <option key={d} value={String(d)}>{d === 0 ? 'right away' : `${d} s`}</option>)}
            </select></Row>
            <h3>Figures</h3>
            {check('invertFigures', 'Invert figures in the dark theme', 'Plots and diagrams use a white base, including transparent images, and turn light-on-dark in the dark theme. Photographs keep their colours. Figures reload when their file changes on disk.')}
          </>}
          {section === 'ai' && <>
            <h3>AI assistance</h3>
            <div class="sub">{ai === null ? 'Checking the server…' : ai.available ? `Available on this server — model ${ai.model}${ai.completionModel !== ai.model ? `, autocomplete ${ai.completionModel}` : ''}.` : 'Not configured on this server: the administrator has to set OPENROUTER_API_KEY (deploy/secrets.env). The switches below have no effect until then.'}</div>
            {check('aiButton', 'Show the ✦ AI button on the toolbar', 'One button that switches autocomplete (text and formulas) on and off. Hidden until you enable it here.')}
            {check('aiRewrite', `Rewrite with AI (${REWRITE_KEY})`, 'Select text or a formula, press the key and describe the change; the proposal is shown in place and applied only when you accept it. While this is on, LyX’s Ctrl+K (delete to the end of the paragraph) is taken over.')}
            {check('aiCompleteText', 'Autocomplete text', 'After a pause while typing, a continuation appears in grey after the caret — formulas already rendered — while ✦ AI… shows in the status bar. Tab inserts it, anything else dismisses it. Works at the end of a word or paragraph, in ordinary text.')}
            {check('aiCompleteMath', 'Autocomplete formulas', 'The same inside formulas: a suggested continuation at the caret, Tab inserts it.')}
            <Row label="Pause before suggesting"><input type="number" min={80} max={5000} step={20} value={p.aiCompleteDelay} onInput={e => setPref('aiCompleteDelay', Math.max(80, Number((e.target as HTMLInputElement).value) || 200))} style="max-width:90px" /> ms</Row>
            <h3>Models</h3>
            <div class="sub">Any OpenRouter model id works; the notes are from measurements on a real paper. The choice is kept in this browser.</div>
            <ModelPicker label="Rewrite (⌘K)" value={p.aiModel} fallback={ai?.model ?? ''} models={ai?.models ?? []} onChange={v => setPref('aiModel', v)} pref="aiModel" />
            <ModelPicker label="Autocomplete" value={p.aiCompletionModel} fallback={ai?.completionModel ?? ''} models={ai?.models ?? []} onChange={v => setPref('aiCompletionModel', v)} pref="aiCompletionModel" />
            <div class="sub">What is sent: your instruction or the text around the cursor together with the document’s LaTeX source (so the model knows the notation, macros, citation keys) goes to the model through the OverLyX server. Nothing is written to the document without your Tab or Accept. The switches are also in the Tools menu, so the command palette finds them.</div>
          </>}
          {section === 'appearance' && <>
            <h3>Theme</h3>
            <div class="sub">Kept in this browser.</div>
            {THEMES.map(([v, label, hint]) => (
              <label class="pref" key={v}><input type="radio" name="ol-theme" data-theme-pref={v} checked={themeChoice === v} onChange={() => setThemePref(v)} /><span>{label}{hint && <span class="sub">{hint}</span>}</span></label>
            ))}
          </>}
          {section === 'privacy' && <>
            <h3>Usage statistics</h3>
            {check('usageStats', 'Send anonymous usage statistics', 'Which menu entries, buttons, shortcuts and dialogs are used, and which of them do nothing, are undone right away or end in an error message — so that confusing parts of the editor can be found and fixed.')}
            <div class="sub" data-setting="usage-what">What is sent: the kind of action (for example “Edit ▸ Text Style ▸ Bold”, “toolbar m-frac”, “Ctrl+Shift+K unbound”, “Citation dialog dismissed”), where it happened (text, formula, table, dialog), the template of an error message with its data removed, the kind of screen, and a random id for this page load. Never your name or account, document or project names, text, formulas or file names — quoted strings, file names and numbers are removed before anything leaves the browser, and again on the server. The browser’s Global Privacy Control signal switches it off as well. Kept in this browser.</div>
          </>}
          {section === 'account' && <>
            <h3>Signed in</h3>
            <div data-setting="whoami">{user.name} ({user.username}){user.isAdmin ? ' — administrator' : ''}</div>
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
          </>}
        </div>
      </div>
    </Dialog>
  );
}
