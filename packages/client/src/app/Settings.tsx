/**
 * The centralized Settings panel (Tools ▸ Settings…, and the avatar menu on every screen — so it
 * is reachable from the start screen too, which has no Tools menu). One dialog for everything a
 * user configures:
 *   Editor       spell checking                    (this browser, prefs.ts)
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

const SECTIONS = [['editor', 'Editor'], ['ai', 'AI assistance'], ['appearance', 'Appearance'], ['account', 'Account']] as const;
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
          {models.map(m => <option key={m.id} value={m.id}>{m.label} — {m.note}</option>)}
          <option value="__custom">Other model id…</option>
        </select>
        {custom && <input type="text" data-pref-custom={pref} placeholder="provider/model-id (OpenRouter)" value={value} onInput={e => onChange((e.target as HTMLInputElement).value.trim())} />}
        {!custom && cur && value && <span class="sub">{cur.id}</span>}
      </div>
    </div>
  );
}

const THEMES: [ThemePref, string, string][] = [
  ['system', 'Follow the system', 'Light or dark with the operating system.'],
  ['light', 'Light', ''],
  ['dark', 'Dark', ''],
];

export function SettingsPanel({ ai, user, initial, onClose }: { ai: AiStatus | null; user: User; initial?: SettingsSection; onClose: () => void }) {
  const [section, setSection] = useState<SettingsSection>(initial ?? 'editor');
  const [p, setP] = useState<Prefs>(getPrefs);
  useEffect(() => subscribePrefs(setP), []);
  const { pref: themeChoice } = useTheme();
  const [settings, setSettings] = useState<UserSettings | null>(null);
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => { api.settings().then(r => setSettings(r.settings)).catch(() => {}); }, []);
  useEffect(() => {
    if (section === 'account' && user.isAdmin && users === null) api.users().then(r => setUsers(r.users)).catch(e => setErr((e as Error).message));
  }, [section]);

  const check = (key: 'spellcheck' | 'autoCorrect' | 'aiButton' | 'aiRewrite' | 'aiCompleteText' | 'aiCompleteMath', label: string, hint: string) => (
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
          {SECTIONS.map(([id, label]) => <button key={id} class={section === id ? 'active' : ''} onClick={() => setSection(id)}>{label}</button>)}
        </div>
        <div class="settings-content">
          {section === 'editor' && <>
            <h3>Text</h3>
            {check('spellcheck', 'Spell checking', 'Misspelt words are underlined; the right-click menu offers corrections.')}
            {check('autoCorrect', 'Autocorrect typos', 'A minor typo is fixed when the word is finished (never in formulas); Backspace right after puts it back.')}
            <Row label="Checker"><select data-pref="spellEngine" value={p.spellEngine} onChange={e => setPref('spellEngine', (e.target as HTMLSelectElement).value as Prefs['spellEngine'])}>
              <option value="overlyx">OverLyX — instant, knows LaTeX (skips formulas, commands, code), suggestions in the menu; English, British, German, French</option>
              <option value="browser">Browser — the browser's own checker (checks slowly after a click; suggestions only via {/Mac/.test(navigator.platform) ? '⇧' : 'Shift+'}right-click)</option>
            </select></Row>
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
          {section === 'account' && <>
            <h3>Signed in</h3>
            <div data-setting="whoami">{user.name} ({user.username}){user.isAdmin ? ' — administrator' : ''}</div>
            <h3>Token re-copy</h3>
            <div class="sub">Access tokens and MCP agent tokens (File ▸ Git repository…) are normally shown exactly once — only a hash is kept. With re-copy enabled for an account, tokens that account creates keep their plaintext on the server, and the Git dialog offers Copy again later. A convenience that stores recoverable secrets, so it is off by default; an administrator switches it per account.</div>
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
