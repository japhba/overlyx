/**
 * Document ▸ Settings… of a markdown document: its typesetting, kept as keys of its YAML front matter
 * (core md/typesetting.ts — pandoc's variables, and `headings`), so the file stays plain markdown that
 * pandoc sets alike, and the keys stay readable and editable by hand. The server rewrites only the
 * keys changed here and the settings follow at once (the editor's fonts, numbering, run-in headings).
 */
import { useEffect, useState } from 'preact/hooks';
import { api, type MdFrontMatterValue } from '../api';
import { Dialog } from './Dialogs';

type Vars = Record<string, MdFrontMatterValue>;
type Font = { label: string; main: string; math: string; hint: string };
type HeadingKeys = { [key: string]: MdFrontMatterValue };
/** Heading spacing's choices: the space above / below every heading (`space-above` / `space-below` in `headings`) */
const SPACINGS: Record<string, [string, string]> = { compact: ['2ex', '0.8ex'], tight: ['1.2ex', '0.3ex'] };
const one = (v: MdFrontMatterValue | undefined) => (typeof v === 'string' ? v : Array.isArray(v) ? v[0] ?? '' : '').trim();
/** `headings` as keys (`run-in` is { display: run-in }) — the levels' own and the rest an agent or the file set stay */
const headingKeys = (v: MdFrontMatterValue | undefined): HeadingKeys => (typeof v === 'string' ? (/^run-in$/i.test(v.trim()) ? { display: 'run-in' } : {}) : v && !Array.isArray(v) ? { ...v } : {});

export function MarkdownSettingsDialog({ docId, onClose, onSaved }: { docId: string; onClose: () => void; onSaved?: () => void }) {
  const [fonts, setFonts] = useState<Font[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [v, setV] = useState({ main: '', math: '', size: '', paper: '', margins: '', stretch: '', numbered: false, runIn: false, headingFont: '', headingColor: '', spacing: '' });
  const [headings, setHeadings] = useState<HeadingKeys>({});
  useEffect(() => {
    api.mdFrontMatter(docId).then(r => {
      const vars: Vars = r.vars;
      setFonts(r.fonts);
      const geometry = Array.isArray(vars.geometry) ? vars.geometry : one(vars.geometry) ? one(vars.geometry).split(/,\s*/) : [];
      // `margin=2cm` alone shows as "2cm"; other geometry options as they are
      const margins = geometry.length === 1 && /^margin=/.test(geometry[0]) ? geometry[0].slice(7) : geometry.join(', ');
      const h = headingKeys(vars.headings);
      setHeadings(h);
      setV({ main: one(vars.mainfont), math: one(vars.mathfont), size: one(vars.fontsize), paper: one(vars.papersize).toLowerCase(), margins, stretch: one(vars.linestretch),
        numbered: one(vars.numbersections) === 'true', runIn: one(h.display) === 'run-in', headingFont: one(h.font), headingColor: one(h.color),
        spacing: !h['space-above'] && !h['space-below'] ? '' : Object.keys(SPACINGS).find(k => SPACINGS[k][0] === one(h['space-above']) && SPACINGS[k][1] === one(h['space-below'])) ?? 'custom' });
    }).catch(e => setError((e as Error).message));
  }, [docId]);
  const set = (p: Partial<typeof v>) => setV(x => ({ ...x, ...p }));
  const pair = fonts.find(f => f.main === v.main);
  const save = async () => {
    setBusy(true); setError('');
    try {
      const margins = v.margins.trim();
      // the heading keys changed here, the others (a level's own, case, rule… — Document ▸ Settings does not show them all) kept
      const h: HeadingKeys = { ...headings };
      const put = (k: string, val: string) => { if (val) h[k] = val; else delete h[k]; };
      put('display', v.runIn ? 'run-in' : ''); put('font', v.headingFont); put('color', v.headingColor);
      // (a spacing of the front matter's own stays as it is)
      if (v.spacing !== 'custom') { put('space-above', SPACINGS[v.spacing]?.[0] ?? ''); put('space-below', SPACINGS[v.spacing]?.[1] ?? ''); }
      const keys = Object.keys(h);
      await api.setMdFrontMatter(docId, {
        mainfont: v.main || null,
        // the math font drawn for the text font, written out (pandoc needs it named)
        mathfont: v.math || null,
        fontsize: v.size || null,
        papersize: v.paper || null,
        geometry: !margins ? null : margins.includes('=') ? margins.split(/\s*,\s*/).filter(Boolean) : `margin=${margins}`,
        linestretch: v.stretch && v.stretch !== '1' ? v.stretch : null,
        numbersections: v.numbered ? true : null,
        headings: !keys.length ? null : keys.length === 1 && h.display === 'run-in' ? 'run-in' : h,
      });
      onSaved?.();
      onClose();
    } catch (e) { setError((e as Error).message); setBusy(false); }
  };
  const row = (label: string, control: preact.ComponentChildren, hint?: string) => (
    <label class="md-set-row"><span class="md-set-label">{label}</span><span class="md-set-control">{control}{hint && <small class="hint">{hint}</small>}</span></label>
  );
  return (
    <Dialog title="Document Settings" onClose={onClose} buttons={<button class="btn primary" data-md-settings-apply disabled={busy} onClick={() => void save()}>Apply</button>}>
      <div class="md-settings" data-md-settings>
        <p class="hint">Kept in the document's front matter (pandoc's keys, so <code>pandoc --pdf-engine=lualatex</code> sets it alike); you can also edit them there.</p>
        {row('Font', <select data-md-font value={pair ? pair.main : v.main ? '__other' : ''} onChange={e => {
          const val = (e.target as HTMLSelectElement).value;
          if (val === '__other') return;
          const f = fonts.find(x => x.main === val);
          set({ main: f?.main ?? '', math: f?.math ?? '' });
        }}>
          <option value="">Computer Modern — LaTeX’s default</option>
          {fonts.map(f => <option key={f.main} value={f.main}>{f.label} — {f.hint}</option>)}
          {v.main && !pair && <option value="__other">{v.main} (from the front matter)</option>}
        </select>)}
        {row('Math font', <select data-md-math value={v.math} onChange={e => set({ math: (e.target as HTMLSelectElement).value })}>
          <option value="">{v.main ? 'As LaTeX has it (Computer Modern)' : 'Computer Modern'}</option>
          {fonts.map(f => <option key={f.math} value={f.math}>{f.math}{pair?.math === f.math ? ' — drawn for the text font' : ''}</option>)}
          {v.math && !fonts.some(f => f.math === v.math) && <option value={v.math}>{v.math}</option>}
        </select>)}
        {row('Size', <select value={v.size} onChange={e => set({ size: (e.target as HTMLSelectElement).value })}>
          <option value="">10 pt (default)</option><option value="11pt">11 pt</option><option value="12pt">12 pt</option>
        </select>)}
        {row('Paper', <select value={v.paper} onChange={e => set({ paper: (e.target as HTMLSelectElement).value })}>
          <option value="">Default (Letter)</option><option value="a4">A4</option><option value="letter">Letter</option><option value="a5">A5</option>
        </select>)}
        {row('Margins', <input type="text" data-md-margins value={v.margins} placeholder="LaTeX’s default" onInput={e => set({ margins: (e.target as HTMLInputElement).value })} />, 'e.g. 2cm, or geometry’s options: left=3cm, top=2cm')}
        {row('Line spacing', <select value={v.stretch || '1'} onChange={e => set({ stretch: (e.target as HTMLSelectElement).value })}>
          {['1', '1.15', '1.25', '1.5', '2'].map(s => <option key={s} value={s}>{s === '1' ? 'Single' : s === '2' ? 'Double' : s}</option>)}
          {v.stretch && !['1', '1.15', '1.25', '1.5', '2'].includes(v.stretch) && <option value={v.stretch}>{v.stretch}</option>}
        </select>)}
        <label class="md-set-check"><input type="checkbox" data-md-numbered checked={v.numbered} onChange={e => set({ numbered: (e.target as HTMLInputElement).checked })} /> Numbered sections</label>
        <label class="md-set-check"><input type="checkbox" data-md-runin checked={v.runIn} onChange={e => set({ runIn: (e.target as HTMLInputElement).checked })} /> Headings run into their paragraph</label>
        {row('Heading font', <select data-md-heading-font value={v.headingFont} onChange={e => set({ headingFont: (e.target as HTMLSelectElement).value })}>
          <option value="">As the text</option>
          {fonts.map(f => <option key={f.main} value={f.main}>{f.label}</option>)}
          {v.headingFont && !fonts.some(f => f.main === v.headingFont) && <option value={v.headingFont}>{v.headingFont}</option>}
        </select>)}
        {row('Heading spacing', <select data-md-heading-spacing value={v.spacing} onChange={e => set({ spacing: (e.target as HTMLSelectElement).value })}>
          <option value="">LaTeX’s</option><option value="compact">Compact — less space above and below</option><option value="tight">Tight</option>
          {v.spacing === 'custom' && <option value="custom">As the front matter has it</option>}
        </select>)}
        {row('Heading colour', <span class="md-set-inline"><input type="color" data-md-heading-color value={v.headingColor || '#000000'} onInput={e => set({ headingColor: (e.target as HTMLInputElement).value })} />
          {v.headingColor ? <button type="button" class="small-btn" onClick={() => set({ headingColor: '' })}>As the text</button> : <small class="hint">as the text</small>}</span>)}
        <p class="hint">More heading styles — size, small capitals, a rule, centring, exact spacing (<code>space-below: 0.5ex</code>), each level its own — go in the front matter's <code>headings</code> (see DOCS), or ask an agent: it sets them with <code>set_markdown_style</code>.</p>
        {error && <p class="error">{error}</p>}
      </div>
    </Dialog>
  );
}
