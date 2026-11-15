/**
 * Settings ▸ This device (web app, signed in): what stays on this device — the settings that depend
 * on its screen, keyboard or pen (prefs.ts DEVICE_PREF_KEYS: the math keyboard, the text grade; the
 * pens, their calibration and the palm in Drawing & pen; panes, zoom and docked toolbars remembered
 * as they are changed) — and the settings that normally follow the account (app/accountprefs.ts)
 * that this device keeps a value of its own for ("Only on this device").
 */
import { useEffect, useState } from 'preact/hooks';
import { getUserPrefs, setPref, subscribePrefs, DEFAULT_PREFS, type Prefs } from '../prefs';
import { SYNCED_LABELS, deviceOnly, setDeviceOnly, subscribeAccountPrefs, syncStatus, followsAccount } from './accountprefs';
import { Setting } from './Settings';
import { AxisSlider } from './FontPicker';
import { GRADE_RUNGS, GRADE_MIN, GRADE_MAX } from './theme';
import { formatAge } from './pdfstatus';
import './devicesettings.css';

/** `where`: what "this device" is (VS Code: "VS Code, on this computer") */
export function DeviceSettings({ onDrawing, where = 'this browser, on this computer, tablet or phone' }: { onDrawing: () => void; where?: string }) {
  const [p, setP] = useState<Prefs>(getUserPrefs);
  useEffect(() => subscribePrefs(() => setP(getUserPrefs())), []);
  const [, redraw] = useState(0);
  useEffect(() => subscribeAccountPrefs(() => redraw(n => n + 1)), []);
  const only = deviceOnly();
  const status = syncStatus();
  return <>
    <p class="set-desc">These stay on this device — {where} — because they depend on its screen, its keyboard or its pen. Everything in the User tab follows your account to every device you sign in on.</p>
    <p class="set-desc device-sync" data-device-sync>{status.error
      ? `Your account could not be reached just now (${status.error}): what you change here goes up when it can be.`
      : status.at ? `In step with your account (checked ${formatAge(Date.now() - status.at) === 'just now' ? 'just now' : formatAge(Date.now() - status.at) + ' ago'}).` : 'Getting your settings from your account…'}</p>
    <h3 class="set-group">Screen and keyboard</h3>
    <Setting id="mathKeyboard" label="Math keyboard" hint="A keyboard for formulas at the bottom of the screen, in place of the system keyboard: numbers and structures, functions, Greek, relations, letters — and ✎ Write, to write a formula by hand (AI assistance). Its ⌨ key hands over to the system keyboard."
      state={{ here: p.mathKeyboard !== DEFAULT_PREFS.mathKeyboard }} onReset={() => setPref('mathKeyboard', DEFAULT_PREFS.mathKeyboard)}>
      <select data-pref="mathKeyboard" value={p.mathKeyboard} onChange={e => setPref('mathKeyboard', (e.target as HTMLSelectElement).value as Prefs['mathKeyboard'])}>
        <option value="auto">On touch screens — until a hardware keyboard is used</option>
        <option value="on">Always — whenever a formula has the cursor</option>
        <option value="off">Never — the system keyboard</option>
      </select>
    </Setting>
    <Setting id="textGrade" label="Text grade" hint="How dark the interface’s letters are — and those of documents set in Anodyne — on this screen. Grade changes the strokes only, never the width of a letter, so nothing moves. The dark theme takes 25 off by itself, as light letters on dark look heavier."
      state={{ here: p.textGrade !== DEFAULT_PREFS.textGrade }} onReset={() => setPref('textGrade', DEFAULT_PREFS.textGrade)}>
      <div class="settings-grade" data-pref="textGrade">
        <AxisSlider name="Grade" min={GRADE_MIN} max={GRADE_MAX} def={0} rungs={GRADE_RUNGS} value={p.textGrade} onChange={v => setPref('textGrade', v)} />
        <div class="settings-grade-sample">Il1 O0 — The quick brown fox jumps over the lazy dog, 3 × 4 ≠ 12 ± 1</div>
      </div>
    </Setting>
    <Setting id="layout" label="Panes, zoom and toolbars" hint="How wide the panes are, the zoom, which panels are open and where toolbars are docked are remembered here as you change them: a phone and a large screen want different ones." />
    <h3 class="set-group">Pen</h3>
    <Setting id="pen" label="Pens, calibration and palm" hint="The pens of slides, whiteboards and margins, the pen’s calibration and how a resting palm is told apart belong to this screen and this pen.">
      <button type="button" class="btn" data-device-drawing onClick={onDrawing}>Drawing &amp; pen…</button>
    </Setting>
    <h3 class="set-group">Only on this device</h3>
    <p class="set-desc">Everything else follows your account. Tick a setting to give this device a value of its own: changing it here then leaves your other devices alone, and their changes leave this one alone. Untick it to take your account’s value again.</p>
    <div class="device-only-list" data-device-only>
      {Object.entries(SYNCED_LABELS).filter(([key]) => followsAccount(key)).map(([key, label]) => (
        <label class="pref" key={key}>
          <input type="checkbox" data-device-only-key={key} checked={only.has(key)} onChange={e => setDeviceOnly(key, (e.target as HTMLInputElement).checked)} />
          <span>{label}</span>
        </label>
      ))}
    </div>
  </>;
}
