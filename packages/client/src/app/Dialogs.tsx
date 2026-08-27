import { useEffect, useMemo, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import type { DocMeta, ProjectFile, BibItem } from '../api';
import type { GraphicsOpts, TableChanges } from '../editor/commands';
import { api, graphicsUrl } from '../api';
import type { Node as PMNode } from 'prosemirror-model';
import { paramMap, unquote } from '@overlyx/core';

export function Dialog({ title, onClose, children, buttons, wide }: { title: string; onClose: () => void; children: ComponentChildren; buttons?: ComponentChildren; wide?: boolean }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    document.addEventListener('keydown', k, true);
    return () => document.removeEventListener('keydown', k, true);
  }, []);
  return (
    <div class="dialog-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div class="dialog" style={wide ? { minWidth: '720px' } : undefined}>
        <h2>{title}</h2>
        <div class="body">{children}</div>
        <div class="buttons">{buttons}<button class="btn" onClick={onClose}>Close</button></div>
      </div>
    </div>
  );
}

const Row = ({ label, children }: { label: string; children: ComponentChildren }) => <div class="row"><label>{label}</label>{children}</div>;

/* ------------------------------------------------------------- graphics */
export function GraphicsDialog({ meta, project, docDir = '', initial, onInsert, onClose }: { meta: DocMeta | null; project: string; docDir?: string; initial?: GraphicsOpts & { filename: string }; onInsert: (filename: string, o: GraphicsOpts) => void; onClose: () => void }) {
  const [filename, setFilename] = useState(initial?.filename ?? '');
  const [o, setO] = useState<GraphicsOpts>(() => (initial ? { ...initial } : { width: '100col%' }));
  const set = (k: keyof GraphicsOpts, v: string | boolean) => setO(prev => ({ ...prev, [k]: v }));
  const [tab, setTab] = useState<'graphics' | 'clip' | 'latex'>('graphics');
  // file names are stored relative to the document's directory (as LyX does)
  const toDocRel = (projectRel: string) => { const up = docDir ? docDir.split('/').filter(Boolean).length : 0; if (docDir && projectRel.startsWith(docDir + '/')) return projectRel.slice(docDir.length + 1); return '../'.repeat(up) + projectRel; };
  const toProjectRel = (docRel: string) => { const parts = [...docDir.split('/').filter(Boolean), ...docRel.split('/')]; const out: string[] = []; for (const p of parts) { if (p === '..') out.pop(); else if (p && p !== '.') out.push(p); } return out.join('/'); };
  const [files, setFiles] = useState<ProjectFile[]>(meta?.files.filter(f => f.kind === 'image') ?? []);
  const upload = () => {
    const input = document.createElement('input'); input.type = 'file'; input.accept = 'image/*,.pdf,.eps,.svg';
    input.onchange = async () => {
      const f = input.files?.[0]; if (!f) return;
      const path = 'figures/' + f.name;
      const projPath = toProjectRel(path);
      await api.upload(project, projPath, f);
      setFiles([...files, { path: projPath, name: f.name, size: f.size, mtime: Date.now(), kind: 'image' }]);
      setFilename(path);
    };
    input.click();
  };
  const text = (k: keyof GraphicsOpts, placeholder = '') => <input type="text" value={String(o[k] ?? '')} onInput={e => set(k, (e.target as HTMLInputElement).value)} placeholder={placeholder} />;
  const check = (k: keyof GraphicsOpts) => <input type="checkbox" checked={!!o[k]} onChange={e => set(k, (e.target as HTMLInputElement).checked)} />;
  return (
    <Dialog title="Graphics" onClose={onClose} wide buttons={<button class="btn primary" disabled={!filename} onClick={() => { onInsert(filename, o); onClose(); }}>{initial ? 'Apply' : 'Insert'}</button>}>
      <Row label="File"><input type="text" value={filename} onInput={e => setFilename((e.target as HTMLInputElement).value)} placeholder="figures/plot.pdf" /><button class="small-btn" onClick={upload}>Upload…</button></Row>
      <div class="list" style="max-height:140px">
        {files.map(f => <div key={f.path} class={toDocRel(f.path) === filename ? 'sel' : ''} onClick={() => setFilename(toDocRel(f.path))}>{f.path}</div>)}
        {!files.length && <div class="sub">No image files in this project yet — upload one.</div>}
      </div>
      {filename && <img src={graphicsUrl(project, toProjectRel(filename), 600)} style="max-height:140px;max-width:100%;object-fit:contain;border:1px solid #ddd" alt="" />}
      <div class="panel-tabs">
        <button class={tab === 'graphics' ? 'active' : ''} onClick={() => setTab('graphics')}>Graphics</button>
        <button class={tab === 'clip' ? 'active' : ''} onClick={() => setTab('clip')}>Clipping</button>
        <button class={tab === 'latex' ? 'active' : ''} onClick={() => setTab('latex')}>LaTeX and LyX options</button>
      </div>
      {tab === 'graphics' && <>
        <Row label="Scale on screen (%)">{text('lyxscale', 'e.g. 50 (display size in the editor)')}</Row>
        <Row label="Scale (%)">{text('scale', 'e.g. 50 — output scaling')}</Row>
        <Row label="Width">{text('width', 'e.g. 100col%, 0.5text%, 8cm (empty = natural)')}</Row>
        <Row label="Height">{text('height', 'e.g. 5cm, 30theight%')}</Row>
        <Row label="Maintain aspect ratio">{check('keepAspectRatio')}</Row>
        <Row label="Rotation angle">{text('rotateAngle', 'degrees, e.g. 90')}<select value={o.rotateOrigin ?? 'center'} onChange={e => set('rotateOrigin', (e.target as HTMLSelectElement).value)}>{['center', 'leftTop', 'leftBottom', 'leftBaseline', 'centerTop', 'centerBottom', 'centerBaseline', 'rightTop', 'rightBottom', 'rightBaseline'].map(v => <option key={v} value={v}>{v}</option>)}</select></Row>
        <Row label="Scale before rotation">{check('scaleBeforeRotation')}</Row>
        <div class="sub" style="color:#777;font-size:11px">LyX units: <code>col%</code> = column width, <code>text%</code> = text width, <code>page%</code>, <code>line%</code>, <code>theight%</code>, or absolute lengths (cm, in, pt).</div>
      </>}
      {tab === 'clip' && <>
        <Row label="Clip to bounding box">{check('clip')}</Row>
        <Row label="Bounding box">{text('BoundingBox', 'llx lly urx ury, e.g. 0bp 0bp 200bp 100bp')}</Row>
        <div class="sub" style="color:#777;font-size:11px">Empty bounding box: the one stored in the file.</div>
      </>}
      {tab === 'latex' && <>
        <Row label="Draft mode">{check('draft')}<span class="sub">only a frame is printed</span></Row>
        <Row label="LaTeX options">{text('special', 'extra \\includegraphics options, e.g. angle=45')}</Row>
        <Row label="Group">{text('groupId', 'graphics group name')}</Row>
      </>}
    </Dialog>
  );
}

/* ------------------------------------------------------------ paragraph */
export interface ParagraphSettings { align: string | null; spacing: string | null; noindent: boolean; labelwidthstring: string | null }
export function ParagraphDialog({ initial, indentSeparation, onApply, onClose }: { initial: ParagraphSettings; indentSeparation: boolean; onApply: (s: ParagraphSettings) => void; onClose: () => void }) {
  const [align, setAlign] = useState(initial.align ?? '');
  const sp = initial.spacing ?? '';
  const [spacing, setSpacing] = useState(sp.startsWith('other') ? 'other' : sp);
  const [spacingValue, setSpacingValue] = useState(sp.startsWith('other') ? sp.slice(6).trim() : '1.5');
  const [noindent, setNoindent] = useState(initial.noindent);
  const [labelwidth, setLabelwidth] = useState(initial.labelwidthstring ?? '');
  const apply = () => {
    onApply({ align: align || null, spacing: spacing === 'other' ? `other ${spacingValue || '1.5'}` : spacing || null, noindent, labelwidthstring: labelwidth || null });
    onClose();
  };
  return (
    <Dialog title="Paragraph Settings" onClose={onClose} buttons={<button class="btn primary" onClick={apply}>Apply</button>}>
      <Row label="Alignment"><select value={align} onChange={e => setAlign((e.target as HTMLSelectElement).value)}>{[['', 'Default (layout)'], ['block', 'Justified'], ['left', 'Left'], ['center', 'Center'], ['right', 'Right']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Row>
      <Row label="Line spacing"><select value={spacing} onChange={e => setSpacing((e.target as HTMLSelectElement).value)}>{[['', 'Default (document)'], ['single', 'Single'], ['onehalf', 'One and a half'], ['double', 'Double'], ['other', 'Custom']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
        {spacing === 'other' && <input type="text" value={spacingValue} onInput={e => setSpacingValue((e.target as HTMLInputElement).value)} style="width:5em" />}</Row>
      <Row label={indentSeparation ? 'Indent paragraph' : 'No indentation'}>{indentSeparation
        ? <input type="checkbox" checked={!noindent} onChange={e => setNoindent(!(e.target as HTMLInputElement).checked)} />
        : <input type="checkbox" checked={noindent} onChange={e => setNoindent((e.target as HTMLInputElement).checked)} />}</Row>
      <Row label="Label width"><input type="text" value={labelwidth} onInput={e => setLabelwidth((e.target as HTMLInputElement).value)} placeholder="longest label (for lists / description)" /></Row>
    </Dialog>
  );
}

/* ---------------------------------------------------------------- table */
export function TableDialog({ onInsert, onClose }: { onInsert: (rows: number, cols: number) => void; onClose: () => void }) {
  const [rows, setRows] = useState(3), [cols, setCols] = useState(3);
  return (
    <Dialog title="Insert Table" onClose={onClose} buttons={<button class="btn primary" onClick={() => { onInsert(rows, cols); onClose(); }}>Insert</button>}>
      <Row label="Rows"><input type="number" min={1} max={100} value={rows} onInput={e => setRows(Number((e.target as HTMLInputElement).value))} /></Row>
      <Row label="Columns"><input type="number" min={1} max={30} value={cols} onInput={e => setCols(Number((e.target as HTMLInputElement).value))} /></Row>
    </Dialog>
  );
}

/* ---------------------------------------------------------------- label */
export function LabelDialog({ initial, editing, refCount = 0, existing = [], onInsert, onRemove, onClose }: { initial: string; editing?: boolean; refCount?: number; existing?: string[]; onInsert: (name: string) => void; onRemove?: () => void; onClose: () => void }) {
  const [name, setName] = useState(initial);
  const trimmed = name.trim();
  const dup = editing ? existing.includes(trimmed) && trimmed !== initial : existing.includes(trimmed);
  const ok = () => { if (trimmed && !dup) { onInsert(trimmed); onClose(); } };
  return (
    <Dialog title={editing ? 'Label Settings' : 'Label'} onClose={onClose} buttons={<>
      {editing && onRemove && <button class="btn" onClick={() => { onRemove(); onClose(); }}>Remove label</button>}
      <button class="btn primary" disabled={!trimmed || dup} onClick={ok}>{editing ? 'Apply' : 'OK'}</button>
    </>}>
      <Row label="Label"><input type="text" autofocus value={name} onInput={e => setName((e.target as HTMLInputElement).value)} onKeyDown={e => { if (e.key === 'Enter') ok(); }} /></Row>
      {dup && <div style="color:#b00020;font-size:11px">A label named “{trimmed}” already exists.</div>}
      {editing && refCount > 0 && <div style="color:#777;font-size:11px">Used by {refCount} cross-reference{refCount === 1 ? '' : 's'} — renaming updates {refCount === 1 ? 'it' : 'them'} automatically.</div>}
      {editing && refCount === 0 && <div style="color:#777;font-size:11px">Not referenced yet.</div>}
      <div style="color:#777;font-size:11px">Conventions: sec:, subsec:, fig:, tab:, eq:, alg: … (used by formatted references).</div>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ ref */
export function RefDialog({ labels, useRefstyle, initial, onInsert, onClose }: { labels: { name: string; context: string; file?: string }[]; useRefstyle: boolean; initial?: { name: string; kind: string }; onInsert: (name: string, kind: string) => void; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(initial?.name ?? labels[0]?.name ?? '');
  const [kind, setKind] = useState(initial?.kind ?? 'ref');
  const [group, setGroup] = useState(true);
  const filtered = labels.filter(l => l.name.toLowerCase().includes(q.toLowerCase()) || l.context.toLowerCase().includes(q.toLowerCase()));
  // LyX-like: group by prefix (sec:, fig:, eq: ...) and sort alphabetically
  const list = group ? [...filtered].sort((a, b) => a.name.localeCompare(b.name)) : filtered;
  const prefixOf = (n: string) => (n.includes(':') ? n.slice(0, n.indexOf(':') + 1) : '(no prefix)');
  let lastPrefix = '';
  const kinds = [['ref', '<reference>'], ['eqref', '(<reference>)'], ['pageref', '<page>'], ['vref', 'on page <page>'], ['vpageref', '<reference> on page <page>'], ['formatted', useRefstyle ? 'Formatted reference (refstyle)' : 'Formatted reference (prettyref)'], ['nameref', 'Textual reference'], ['labelonly', 'Label only']];
  return (
    <Dialog title="Cross-reference" onClose={onClose} wide buttons={<button class="btn primary" disabled={!sel} onClick={() => { onInsert(sel, kind); onClose(); }}>{initial ? 'Apply' : 'Insert'}</button>}>
      <Row label="Filter"><input type="text" autofocus value={q} onInput={e => setQ((e.target as HTMLInputElement).value)} placeholder="label or heading text" /><label style="min-width:0"><input type="checkbox" checked={group} onChange={e => setGroup((e.target as HTMLInputElement).checked)} /> group by prefix</label></Row>
      <div class="list" style="max-height:360px">
        {list.map(l => {
          const pre = prefixOf(l.name);
          const header = group && pre !== lastPrefix ? <div class="group-header">{pre}</div> : null;
          lastPrefix = pre;
          return <div key={l.name + (l.file ?? '')} style="display:contents">{header}<div class={l.name === sel ? 'sel' : ''} onClick={() => setSel(l.name)} onDblClick={() => { onInsert(l.name, kind); onClose(); }}><b>{l.name}</b> <span class="sub">{l.context}</span>{l.file && <span class="sub"> — {l.file}</span>}</div></div>;
        })}
        {!list.length && <div class="sub">No labels found.</div>}
      </div>
      <Row label="Selected"><input type="text" value={sel} onInput={e => setSel((e.target as HTMLInputElement).value)} /></Row>
      <Row label="Format"><select value={kind} onChange={e => setKind((e.target as HTMLSelectElement).value)}>{kinds.map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Row>
    </Dialog>
  );
}

/* ----------------------------------------------------------------- cite */
export function CiteDialog({ meta, docId, initial, onInsert, onClose }: { meta: DocMeta | null; docId?: string; initial?: { keys: string[]; cmd: string; before: string; after: string }; onInsert: (keys: string[], cmd: string, before: string, after: string, entries: BibItem[]) => void; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [keys, setKeys] = useState<string[]>(initial?.keys ?? []);
  const [cmd, setCmd] = useState(initial?.cmd ?? (meta?.citeEngine === 'natbib' || meta?.citeEngine === 'biblatex' ? 'citep' : 'cite'));
  const [before, setBefore] = useState(initial?.before ?? ''), [after, setAfter] = useState(initial?.after ?? '');
  const local = meta?.bib ?? [];
  const total = meta?.bibTotal ?? local.length;
  const remote = total > local.length;    // large bibliography: search on the server
  const [hits, setHits] = useState<BibItem[]>([]);
  const [searching, setSearching] = useState(false);
  useEffect(() => {
    if (!remote || !docId) return;
    setSearching(true);
    const t = setTimeout(() => { api.bibSearch(docId, q, 200).then(r => setHits(r.entries)).catch(() => setHits([])).finally(() => setSearching(false)); }, q ? 200 : 0);
    return () => clearTimeout(t);
  }, [q, remote, docId]);
  const known = useMemo(() => { const m = new Map<string, BibItem>(); for (const e of [...local, ...hits]) m.set(e.key, e); return m; }, [local, hits]);
  const list = useMemo(() => {
    const ql = q.toLowerCase().split(/\s+/).filter(Boolean);
    const match = (e: BibItem) => ql.every(t => e.key.toLowerCase().includes(t) || e.author.toLowerCase().includes(t) || e.year.includes(t) || e.title.toLowerCase().includes(t));
    if (remote) {
      // cited entries first (they are what the author usually wants again), then the search results
      const citedHits = local.filter(match);
      const rest = hits.filter(e => !citedHits.some(c => c.key === e.key));
      return [...citedHits, ...rest].slice(0, 300);
    }
    if (!ql.length) return local.slice(0, 200);
    return local.filter(match).slice(0, 200);
  }, [q, local, hits, remote]);
  const toggle = (k: string) => setKeys(keys.includes(k) ? keys.filter(x => x !== k) : [...keys, k]);
  const cmds = meta?.citeEngine === 'natbib' ? ['citep', 'citet', 'citealp', 'citealt', 'citeauthor', 'citeyear', 'citeyearpar', 'nocite'] : meta?.citeEngine === 'biblatex' ? ['cite', 'parencite', 'textcite', 'autocite', 'citeauthor', 'citeyear', 'nocite'] : ['cite', 'nocite'];
  const insert = () => { onInsert(keys, cmd, before, after, keys.map(k => known.get(k)).filter((e): e is BibItem => !!e)); onClose(); };
  return (
    <Dialog title="Citation" onClose={onClose} wide buttons={<button class="btn primary" disabled={!keys.length} onClick={insert}>{initial ? 'Apply' : 'Insert'}</button>}>
      <Row label="Search"><input type="text" autofocus value={q} onInput={e => setQ((e.target as HTMLInputElement).value)} placeholder="author, year, title, key" /><span class="sub" style="color:#888;font-size:11px;white-space:nowrap">{searching ? 'searching…' : `${total} entries`}</span></Row>
      <div class="list" style="max-height:320px">
        {keys.filter(k => !list.some(e => e.key === k)).map(k => <div key={'sel-' + k} class="sel" onClick={() => toggle(k)}><b>{known.get(k)?.author || k}</b> <span class="sub">[{k}] (selected)</span></div>)}
        {list.map(e => <div key={e.key} class={keys.includes(e.key) ? 'sel' : ''} onClick={() => toggle(e.key)}><b>{e.author || e.key}</b> {e.year} <span class="sub">— {e.title}</span> <span class="sub">[{e.key}]</span></div>)}
        {!total && <div class="sub">No bibliography entries found (add a BibTeX inset or .bib files to the project).</div>}
        {remote && !q && total > local.length && <div class="sub" style="padding:4px 6px;color:#888">Type to search all {total} entries; the cited ones are listed first.</div>}
      </div>
      <Row label="Selected">{keys.join(', ') || <span class="sub">none</span>}</Row>
      <Row label="Style"><select value={cmd} onChange={e => setCmd((e.target as HTMLSelectElement).value)}>{cmds.map(c => <option key={c} value={c}>\{c}</option>)}</select></Row>
      <Row label="Text before"><input type="text" value={before} onInput={e => setBefore((e.target as HTMLInputElement).value)} /></Row>
      <Row label="Text after"><input type="text" value={after} onInput={e => setAfter((e.target as HTMLInputElement).value)} placeholder="e.g. p. 12" /></Row>
    </Dialog>
  );
}

/* ----------------------------------------------------------------- href */
export function HrefDialog({ initial, onInsert, onClose }: { initial?: { target: string; name: string }; onInsert: (target: string, name: string) => void; onClose: () => void }) {
  const [target, setTarget] = useState(initial?.target ?? 'https://');
  const [name, setName] = useState(initial?.name ?? '');
  return (
    <Dialog title="Hyperlink" onClose={onClose} buttons={<button class="btn primary" disabled={!target} onClick={() => { onInsert(target, name); onClose(); }}>OK</button>}>
      <Row label="Target"><input type="text" autofocus value={target} onInput={e => setTarget((e.target as HTMLInputElement).value)} /></Row>
      <Row label="Name"><input type="text" value={name} onInput={e => setName((e.target as HTMLInputElement).value)} placeholder="(optional link text)" /></Row>
    </Dialog>
  );
}

/* ------------------------------------------------------------- settings */
const CLASSES = ['article', 'report', 'book', 'scrartcl', 'scrreprt', 'scrbook', 'amsart', 'amsbook', 'revtex4-2', 'revtex4-1', 'IEEEtran', 'elsarticle', 'llncs', 'beamer', 'letter', 'memoir', 'extarticle', 'acmart'];
export function SettingsDialog({ docId, meta, headerLines, onSaved, onClose }: { docId: string; meta: DocMeta | null; headerLines: string[]; onSaved: () => void; onClose: () => void }) {
  const get = (k: string) => headerLines.find(l => l.startsWith('\\' + k + ' '))?.slice(k.length + 2) ?? '';
  const preStart = headerLines.indexOf('\\begin_preamble'), preEnd = headerLines.indexOf('\\end_preamble');
  // a single map of header values edited by the tabs; only keys that changed are written back
  const KEYS = ['textclass', 'language', 'paperfontsize', 'papersize', 'cite_engine', 'cite_engine_type', 'biblio_style', 'use_hyperref', 'tracking_changes', 'output_changes',
    'paperorientation', 'use_geometry', 'paperwidth', 'paperheight', 'leftmargin', 'topmargin', 'rightmargin', 'bottommargin', 'headheight', 'headsep', 'footskip', 'columnsep', 'papercolumns', 'papersides',
    'paragraph_separation', 'defskip', 'spacing', 'justification', 'is_math_indent', 'math_numbering_side', 'quotes_style', 'secnumdepth', 'tocdepth', 'float_placement', 'float_alignment',
    'font_roman', 'font_sans', 'font_typewriter', 'font_math', 'font_default_family', 'use_microtype', 'font_sc', 'font_roman_osf', 'font_sf_scale', 'font_tt_scale', 'use_non_tex_fonts',
    'pdf_title', 'pdf_author', 'pdf_subject', 'pdf_keywords', 'pdf_bookmarks', 'pdf_bookmarksnumbered', 'pdf_bookmarksopen', 'pdf_breaklinks', 'pdf_pdfborder', 'pdf_colorlinks', 'pdf_backref', 'pdf_pdfusetitle', 'pdf_quoted_options',
    'suppress_date', 'use_refstyle', 'use_minted', 'use_lineno', 'index_command', 'paperpagestyle', 'html_math_output'] as const;
  const [v, setV] = useState<Record<string, string>>(() => Object.fromEntries(KEYS.map(k => [k, get(k)])));
  const set = (k: string, val: string) => setV(prev => ({ ...prev, [k]: val }));
  const [options, setOptions] = useState(get('options'));
  const [preamble, setPreamble] = useState(preStart >= 0 ? headerLines.slice(preStart + 1, preEnd).join('\n') : '');
  const [modules, setModules] = useState((() => { const s = headerLines.indexOf('\\begin_modules'), e = headerLines.indexOf('\\end_modules'); return s >= 0 ? headerLines.slice(s + 1, e).join(', ') : ''; })());
  // branches: \branch NAME … \end_branch blocks (kept verbatim apart from \selected)
  const parseBranches = () => {
    const out: { name: string; selected: boolean; lines: string[] }[] = [];
    for (let i = 0; i < headerLines.length; i++) {
      if (!headerLines[i].startsWith('\\branch ')) continue;
      const j = headerLines.indexOf('\\end_branch', i);
      const lines = headerLines.slice(i + 1, j);
      out.push({ name: headerLines[i].slice(8), selected: lines.some(l => l === '\\selected 1'), lines });
      i = j;
    }
    return out;
  };
  const [branches, setBranches] = useState(parseBranches);
  const [newBranch, setNewBranch] = useState('');
  const [raw, setRaw] = useState(false);
  const [rawText, setRawText] = useState(headerLines.join('\n'));
  type Tab = 'general' | 'page' | 'text' | 'numbering' | 'fonts' | 'branches' | 'pdf' | 'preamble' | 'raw';
  const [tab, setTab] = useState<Tab>('general');
  const save = async () => {
    if (tab === 'raw' || raw) { await api.setHeader(docId, { headerLines: rawText.split('\n') }); onSaved(); onClose(); return; }
    const lines = [...headerLines];
    const findKey = (k: string) => lines.findIndex(l => l === '\\' + k || l.startsWith('\\' + k + ' '));
    /** insert a missing key before the first of the `before` keys that exists (LyX's header order), else after \textclass */
    const insertAt = (k: string, before: string[]) => { for (const b of before) { const i = findKey(b); if (i >= 0) return i; } return findKey('textclass') + 1; };
    const ORDER: Record<string, string[]> = {
      options: ['use_default_options'], paperorientation: ['suppress_date'], use_geometry: ['use_package'],
      paperwidth: ['paperheight', 'leftmargin', 'topmargin', 'rightmargin', 'bottommargin', 'headheight', 'headsep', 'footskip', 'columnsep', 'secnumdepth'],
      paperheight: ['leftmargin', 'topmargin', 'rightmargin', 'bottommargin', 'headheight', 'headsep', 'footskip', 'columnsep', 'secnumdepth'],
      leftmargin: ['topmargin', 'rightmargin', 'bottommargin', 'headheight', 'headsep', 'footskip', 'columnsep', 'secnumdepth'],
      topmargin: ['rightmargin', 'bottommargin', 'headheight', 'headsep', 'footskip', 'columnsep', 'secnumdepth'],
      rightmargin: ['bottommargin', 'headheight', 'headsep', 'footskip', 'columnsep', 'secnumdepth'],
      bottommargin: ['headheight', 'headsep', 'footskip', 'columnsep', 'secnumdepth'], headheight: ['headsep', 'footskip', 'columnsep', 'secnumdepth'],
      headsep: ['footskip', 'columnsep', 'secnumdepth'], footskip: ['columnsep', 'secnumdepth'], columnsep: ['secnumdepth'],
      defskip: ['is_math_indent', 'math_numbering_side', 'quotes_style'], float_placement: ['float_alignment', 'paperfontsize'], float_alignment: ['paperfontsize'],
      pdf_title: ['pdf_author', 'pdf_subject', 'pdf_keywords', 'pdf_bookmarks'], pdf_author: ['pdf_subject', 'pdf_keywords', 'pdf_bookmarks'], pdf_subject: ['pdf_keywords', 'pdf_bookmarks'], pdf_keywords: ['pdf_bookmarks'],
      pdf_quoted_options: ['papersize'], use_lineno: ['use_indices'], papersides: ['paperpagestyle'],
    };
    const setL = (k: string, val: string) => {
      const i = findKey(k);
      if (val === '' && !['options', 'paperwidth', 'paperheight', 'leftmargin', 'topmargin', 'rightmargin', 'bottommargin', 'headheight', 'headsep', 'footskip', 'columnsep', 'pdf_title', 'pdf_author', 'pdf_subject', 'pdf_keywords', 'pdf_quoted_options', 'defskip'].includes(k)) return;
      if (val === '') { if (i >= 0) lines.splice(i, 1); return; }
      if (i >= 0) lines[i] = `\\${k} ${val}`; else lines.splice(insertAt(k, ORDER[k] ?? []), 0, `\\${k} ${val}`);
    };
    for (const k of KEYS) if (v[k] !== get(k)) setL(k, v[k]);
    // margins are only meaningful with geometry; LyX drops them otherwise
    if (v.use_geometry !== 'true') for (const k of ['leftmargin', 'topmargin', 'rightmargin', 'bottommargin', 'headheight', 'headsep', 'footskip', 'columnsep', 'paperwidth', 'paperheight']) if (get(k) && v[k] === get(k)) { /* keep as is */ }
    if (options.trim()) { setL('options', options.trim()); setL('use_default_options', 'false'); } else setL('options', '');
    const mods = modules.split(',').map(s => s.trim()).filter(Boolean);
    const ms = lines.indexOf('\\begin_modules'), me = lines.indexOf('\\end_modules');
    if (ms >= 0) lines.splice(ms, me - ms + 1);
    if (mods.length) { const ti = lines.findIndex(l => l.startsWith('\\use_default_options')); lines.splice(ti + 1, 0, '\\begin_modules', ...mods, '\\end_modules'); }
    // branches: rewrite all blocks in place (LyX writes them before the \index blocks)
    let first = lines.findIndex(l => l.startsWith('\\branch '));
    while (true) { const i = lines.findIndex(l => l.startsWith('\\branch ')); if (i < 0) break; const j = lines.indexOf('\\end_branch', i); lines.splice(i, j - i + 1); }
    if (first < 0) { first = lines.findIndex(l => l.startsWith('\\index ')); if (first < 0) first = findKey('secnumdepth'); }
    const blocks = branches.flatMap(b => ['\\branch ' + b.name, ...b.lines.map(l => (l.startsWith('\\selected') ? `\\selected ${b.selected ? 1 : 0}` : l)), '\\end_branch']);
    if (blocks.length) lines.splice(first, 0, ...blocks);
    await api.setHeader(docId, { headerLines: lines, preamble });
    onSaved(); onClose();
  };
  const text = (k: string, placeholder = '', style = '') => <input type="text" value={v[k] ?? ''} onInput={e => set(k, (e.target as HTMLInputElement).value)} placeholder={placeholder} style={style} />;
  const sel = (k: string, opts: (string | [string, string])[]) => <select value={v[k] ?? ''} onChange={e => set(k, (e.target as HTMLSelectElement).value)}>{opts.map(o => { const [val, label] = Array.isArray(o) ? o : [o, o]; return <option key={val} value={val}>{label}</option>; })}</select>;
  const bool = (k: string) => <input type="checkbox" checked={v[k] === 'true'} onChange={e => set(k, String((e.target as HTMLInputElement).checked))} />;
  const TABS: [Tab, string][] = [['general', 'Class & options'], ['page', 'Page & margins'], ['text', 'Text layout'], ['numbering', 'Numbering & floats'], ['fonts', 'Fonts'], ['branches', 'Branches'], ['pdf', 'PDF properties'], ['preamble', 'LaTeX preamble'], ['raw', 'Raw header']];
  const geometry = v.use_geometry === 'true';
  return (
    <Dialog title="Document Settings" onClose={onClose} wide buttons={<button class="btn primary" onClick={save}>Apply</button>}>
      <div class="panel-tabs" style="flex-wrap:wrap">
        {TABS.map(([t, l]) => <button key={t} class={tab === t ? 'active' : ''} onClick={() => { setTab(t); if (t === 'raw') setRaw(true); }}>{l}</button>)}
      </div>
      {tab === 'general' && <>
        <Row label="Document class"><input type="text" list="ol-classes" value={v.textclass} onInput={e => set('textclass', (e.target as HTMLInputElement).value)} /><datalist id="ol-classes">{CLASSES.map(c => <option key={c} value={c} />)}</datalist></Row>
        <Row label="Class options"><input type="text" value={options} onInput={e => setOptions((e.target as HTMLInputElement).value)} placeholder="e.g. prx,amsmath,superscriptaddress" /></Row>
        <Row label="Modules"><input type="text" value={modules} onInput={e => setModules((e.target as HTMLInputElement).value)} placeholder="e.g. theorems-ams, customHeadersFooters" /></Row>
        <Row label="Language">{text('language')}</Row>
        <Row label="Citation engine">{sel('cite_engine', ['basic', 'natbib', 'biblatex', 'jurabib'])}{sel('cite_engine_type', ['default', 'authoryear', 'numerical'])}</Row>
        <Row label="Bibliography style">{text('biblio_style')}</Row>
        <Row label="Hyperref">{bool('use_hyperref')}</Row>
        <Row label="Track changes">{bool('tracking_changes')} <span class="sub">show changes in output</span> {bool('output_changes')}</Row>
        <Row label="Suppress date">{bool('suppress_date')}</Row>
      </>}
      {tab === 'page' && <>
        <Row label="Paper size">{sel('papersize', ['default', 'custom', 'a3', 'a4', 'a5', 'b4', 'b5', 'letter', 'legal', 'executive'])}</Row>
        {v.papersize === 'custom' && <Row label="Custom size">{text('paperwidth', 'width, e.g. 21cm', 'width:8em')}{text('paperheight', 'height, e.g. 29.7cm', 'width:8em')}</Row>}
        <Row label="Orientation">{sel('paperorientation', ['portrait', 'landscape'])}</Row>
        <Row label="Two-sided">{sel('papersides', [['1', 'Single-sided'], ['2', 'Double-sided']])}</Row>
        <Row label="Columns">{sel('papercolumns', [['1', 'One'], ['2', 'Two']])}{v.papercolumns === '2' && text('columnsep', 'column separation, e.g. 1cm', 'width:10em')}</Row>
        <Row label="Page style">{sel('paperpagestyle', ['default', 'empty', 'plain', 'headings', 'fancy'])}</Row>
        <Row label="Custom margins">{bool('use_geometry')}<span class="sub">(geometry package)</span></Row>
        {geometry && <>
          <Row label="Top / bottom">{text('topmargin', 'e.g. 2.5cm', 'width:7em')}{text('bottommargin', 'e.g. 2.5cm', 'width:7em')}</Row>
          <Row label="Inner / outer">{text('leftmargin', 'e.g. 2.5cm', 'width:7em')}{text('rightmargin', 'e.g. 2.5cm', 'width:7em')}</Row>
          <Row label="Head height / sep">{text('headheight', '', 'width:7em')}{text('headsep', '', 'width:7em')}</Row>
          <Row label="Foot skip">{text('footskip', '', 'width:7em')}</Row>
        </>}
      </>}
      {tab === 'text' && <>
        <Row label="Paragraph separation">{sel('paragraph_separation', [['indent', 'Indentation'], ['skip', 'Vertical space']])}
          {v.paragraph_separation === 'skip' && sel('defskip', ['smallskip', 'medskip', 'bigskip', 'halfline', 'fullline'])}</Row>
        <Row label="Line spacing">{sel('spacing', [['single', 'Single'], ['onehalf', 'One and a half'], ['double', 'Double']])}</Row>
        <Row label="Justification">{sel('justification', [['true', 'Justified'], ['false', 'Ragged right'], ['default', 'Default']])}</Row>
        <Row label="Quote style">{sel('quotes_style', ['english', 'swedish', 'german', 'polish', 'swiss', 'danish', 'plain', 'british', 'swedishg', 'french', 'frenchin', 'russian', 'cjk', 'cjkangle', 'hungarian', 'hebrew'])}</Row>
        <Row label="Math indentation">{sel('is_math_indent', [['0', 'Centered formulas'], ['1', 'Indented formulas']])}</Row>
        <Row label="Equation numbers">{sel('math_numbering_side', ['default', 'left', 'right'])}</Row>
        <Row label="Line numbers">{bool('use_lineno')}</Row>
      </>}
      {tab === 'numbering' && <>
        <Row label="Numbering depth">{sel('secnumdepth', [['-2', 'none'], ['-1', 'part'], ['0', 'chapter'], ['1', 'section'], ['2', 'subsection'], ['3', 'subsubsection'], ['4', 'paragraph'], ['5', 'subparagraph']])}</Row>
        <Row label="Table of contents depth">{sel('tocdepth', [['-2', 'none'], ['-1', 'part'], ['0', 'chapter'], ['1', 'section'], ['2', 'subsection'], ['3', 'subsubsection'], ['4', 'paragraph'], ['5', 'subparagraph']])}</Row>
        <Row label="Float placement">{sel('float_placement', [['class', 'Class default'], ['h', 'Here if possible'], ['H', 'Here definitely'], ['t', 'Top of page'], ['b', 'Bottom of page'], ['p', 'Page of floats'], ['htbp', 'htbp'], ['tbp', 'tbp'], ['!htbp', '!htbp']])}</Row>
        <Row label="Float alignment">{sel('float_alignment', ['class', 'document', 'left', 'center', 'right'])}</Row>
        <Row label="Reference style">{bool('use_refstyle')}<span class="sub">refstyle (\\eqref, \\secref …) instead of prettyref</span></Row>
      </>}
      {tab === 'fonts' && <>
        <Row label="Non-TeX fonts">{bool('use_non_tex_fonts')}<span class="sub">(XeTeX/LuaTeX)</span></Row>
        <Row label="Roman">{text('font_roman', '"default" "default" — LaTeX name, non-TeX name')}</Row>
        <Row label="Sans serif">{text('font_sans', '"default" "default"')}</Row>
        <Row label="Typewriter">{text('font_typewriter', '"default" "default"')}</Row>
        <Row label="Math">{text('font_math', '"auto" "auto"')}</Row>
        <Row label="Default family">{sel('font_default_family', ['default', 'rmdefault', 'sfdefault', 'ttdefault'])}</Row>
        <Row label="Base size">{sel('paperfontsize', ['default', '8', '9', '10', '11', '12', '14', '17', '20'])}</Row>
        <Row label="Sans / typewriter scale">{text('font_sf_scale', '100 100', 'width:7em')}{text('font_tt_scale', '100 100', 'width:7em')}</Row>
        <Row label="Microtype">{bool('use_microtype')}</Row>
      </>}
      {tab === 'branches' && <>
        <div class="list" style="max-height:220px">
          {branches.map((b, i) => <div key={b.name} style="display:flex;gap:8px;align-items:center">
            <input type="checkbox" checked={b.selected} onChange={e => setBranches(bs => bs.map((x, j) => (j === i ? { ...x, selected: (e.target as HTMLInputElement).checked } : x)))} />
            <b style="flex:1">{b.name}</b><span class="sub">{b.selected ? 'activated' : 'not activated'}</span>
            <button class="small-btn" onClick={() => setBranches(bs => bs.filter((_, j) => j !== i))}>Remove</button>
          </div>)}
          {!branches.length && <div class="sub">No branches defined. Text in a branch inset is only output when the branch is activated.</div>}
        </div>
        <Row label="New branch"><input type="text" value={newBranch} onInput={e => setNewBranch((e.target as HTMLInputElement).value)} placeholder="name" />
          <button class="small-btn" disabled={!newBranch.trim() || branches.some(b => b.name === newBranch.trim())} onClick={() => { setBranches([...branches, { name: newBranch.trim(), selected: true, lines: ['\\selected 1', '\\filename_suffix 0', '\\color #faf0e6 #faf0e6'] }]); setNewBranch(''); }}>Add</button></Row>
      </>}
      {tab === 'pdf' && <>
        <Row label="Use title & author">{bool('pdf_pdfusetitle')}</Row>
        <Row label="Title">{text('pdf_title', '(quoted as LyX writes it, e.g. "My title")')}</Row>
        <Row label="Author">{text('pdf_author')}</Row>
        <Row label="Subject">{text('pdf_subject')}</Row>
        <Row label="Keywords">{text('pdf_keywords')}</Row>
        <Row label="Bookmarks">{bool('pdf_bookmarks')} <span class="sub">numbered</span> {bool('pdf_bookmarksnumbered')} <span class="sub">open</span> {bool('pdf_bookmarksopen')}</Row>
        <Row label="Links">
          <span class="sub">break across lines</span> {bool('pdf_breaklinks')} <span class="sub">border</span> {bool('pdf_pdfborder')} <span class="sub">colour</span> {bool('pdf_colorlinks')} <span class="sub">back references</span> {bool('pdf_backref')}
        </Row>
        <Row label="Extra hyperref options">{text('pdf_quoted_options', 'e.g. linkcolor=blue')}</Row>
      </>}
      {tab === 'preamble' && <textarea style="min-height:360px" value={preamble} onInput={e => setPreamble((e.target as HTMLTextAreaElement).value)} spellcheck={false} />}
      {tab === 'raw' && <textarea style="min-height:420px" value={rawText} onInput={e => setRawText((e.target as HTMLTextAreaElement).value)} spellcheck={false} />}
      {meta && <div style="color:#777;font-size:11px">Macros available: {meta.macroList.length} · Bibliography entries: {meta.bib.length} · Layouts: {meta.layouts?.length ?? 'n/a'}</div>}
    </Dialog>
  );
}

/* ---------------------------------------------------------- table settings */
export interface TableSettingsInitial { cell: Map<string, string>; column: Map<string, string>; row: Map<string, string>; table: Map<string, string>; rowIndex: number; colIndex: number; nrows: number; ncols: number }
export function TableSettingsDialog({ initial, onApply, onClose }: { initial: TableSettingsInitial; onApply: (ch: TableChanges) => void; onClose: () => void }) {
  type Tab = 'cell' | 'column' | 'row' | 'table';
  const [tab, setTab] = useState<Tab>('cell');
  const mk = (m: Map<string, string>) => Object.fromEntries([...m.entries()]);
  const [cell, setCell] = useState<Record<string, string>>(mk(initial.cell));
  const [column, setColumn] = useState<Record<string, string>>(mk(initial.column));
  const [row, setRow] = useState<Record<string, string>>(mk(initial.row));
  const [table, setTable] = useState<Record<string, string>>(mk(initial.table));
  const diff = (before: Map<string, string>, after: Record<string, string>): [string, string | null][] => {
    const out: [string, string | null][] = [];
    for (const [k, val] of Object.entries(after)) if (before.get(k) !== val) out.push([k, val === '' ? null : val]);
    for (const k of before.keys()) if (!(k in after)) out.push([k, null]);
    return out;
  };
  const apply = () => { onApply({ cell: diff(initial.cell, cell), column: diff(initial.column, column), row: diff(initial.row, row), table: diff(initial.table, table) }); onClose(); };
  const field = (st: Record<string, string>, setSt: (f: (p: Record<string, string>) => Record<string, string>) => void) => ({
    sel: (k: string, opts: (string | [string, string])[]) => <select value={st[k] ?? ''} onChange={e => { const val = (e.target as HTMLSelectElement).value; setSt(p => ({ ...p, [k]: val })); }}>{opts.map(o => { const [val, label] = Array.isArray(o) ? o : [o, o]; return <option key={val} value={val}>{label}</option>; })}</select>,
    bool: (k: string) => <input type="checkbox" checked={st[k] === 'true'} onChange={e => { const c = (e.target as HTMLInputElement).checked; setSt(p => ({ ...p, [k]: c ? 'true' : '' })); }} />,
    text: (k: string, placeholder = '') => <input type="text" value={st[k] ?? ''} onInput={e => { const val = (e.target as HTMLInputElement).value; setSt(p => ({ ...p, [k]: val })); }} placeholder={placeholder} />,
  });
  const c = field(cell, setCell), col = field(column, setColumn), r = field(row, setRow), t = field(table, setTable);
  const H_ALIGN: [string, string][] = [['', 'Column default'], ['left', 'Left'], ['center', 'Center'], ['right', 'Right'], ['block', 'Justified'], ['decimal', 'At decimal separator']];
  const V_ALIGN: [string, string][] = [['', 'Column default'], ['top', 'Top'], ['middle', 'Middle'], ['bottom', 'Bottom']];
  return (
    <Dialog title={`Table Settings — row ${initial.rowIndex + 1} of ${initial.nrows}, column ${initial.colIndex + 1} of ${initial.ncols}`} onClose={onClose} wide buttons={<button class="btn primary" onClick={apply}>Apply</button>}>
      <div class="panel-tabs">{(['cell', 'column', 'row', 'table'] as Tab[]).map(x => <button key={x} class={tab === x ? 'active' : ''} onClick={() => setTab(x)}>{x === 'cell' ? 'This cell' : x === 'column' ? 'This column' : x === 'row' ? 'This row' : 'Table'}</button>)}</div>
      {tab === 'cell' && <>
        <Row label="Horizontal alignment">{c.sel('alignment', H_ALIGN)}</Row>
        <Row label="Vertical alignment">{c.sel('valignment', V_ALIGN)}</Row>
        <Row label="Width">{c.text('width', 'e.g. 3cm, 20col% (fixed-width cell = paragraph)')}</Row>
        <Row label="Rotate">{c.sel('rotate', [['', 'No'], ['90', '90°'], ['-90', '−90°'], ['180', '180°']])}</Row>
        <Row label="Borders"><span class="sub">top</span> {c.bool('topline')} <span class="sub">bottom</span> {c.bool('bottomline')} <span class="sub">left</span> {c.bool('leftline')} <span class="sub">right</span> {c.bool('rightline')}</Row>
        <div class="sub" style="color:#777;font-size:11px">Multi-column / multi-row cells: Edit ▸ Table ▸ Merge cells.</div>
      </>}
      {tab === 'column' && <>
        <Row label="Horizontal alignment">{col.sel('alignment', H_ALIGN.slice(1))}</Row>
        <Row label="Vertical alignment">{col.sel('valignment', V_ALIGN.slice(1))}</Row>
        <Row label="Width">{col.text('width', 'e.g. 3cm (empty/0pt = automatic)')}</Row>
        <Row label="LaTeX column spec">{col.text('special', 'e.g. p{3cm} or >{\\raggedright}X (overrides the above)')}</Row>
      </>}
      {tab === 'row' && <>
        <Row label="Lines"><span class="sub">top</span> {r.bool('topline')} <span class="sub">bottom</span> {r.bool('bottomline')} <span class="sub">(all cells of the row)</span></Row>
        <Row label="Space above">{r.text('topspace', 'e.g. 3mm or default')}</Row>
        <Row label="Space below">{r.text('bottomspace', 'e.g. 3mm or default')}</Row>
        <Row label="Interline space">{r.text('interlinespace', 'e.g. 2mm or default')}</Row>
        {table.islongtable === 'true' && <>
          <Row label="Long table header">{r.bool('endfirsthead')} <span class="sub">first page</span> {r.bool('endhead')} <span class="sub">every page</span></Row>
          <Row label="Long table footer">{r.bool('endfoot')} <span class="sub">every page</span> {r.bool('endlastfoot')} <span class="sub">last page</span></Row>
          <Row label="Page break after">{r.bool('newpage')}</Row>
          <Row label="Caption row">{r.bool('caption')}</Row>
        </>}
      </>}
      {tab === 'table' && <>
        <Row label="Vertical alignment">{t.sel('tabularvalignment', [['', 'Middle (default)'], ['top', 'Top'], ['middle', 'Middle'], ['bottom', 'Bottom']])}</Row>
        <Row label="Table width">{t.text('tabularwidth', 'e.g. 100col% (empty = automatic)')}</Row>
        <Row label="Rotate">{t.sel('rotate', [['', 'No'], ['90', '90°'], ['-90', '−90°']])}</Row>
        <Row label="Booktabs style">{t.bool('booktabs')}</Row>
        <Row label="Long table">{t.bool('islongtable')} <span class="sub">(multi-page)</span>{table.islongtable === 'true' && t.sel('longtabularalignment', ['center', 'left', 'right'])}</Row>
      </>}
    </Dialog>
  );
}

/* ------------------------------------------------------------- math insert */
const DELIMS: [string, string][] = [['(', ')'], ['[', ']'], ['\\{', '\\}'], ['|', '|'], ['\\|', '\\|'], ['\\langle', '\\rangle'], ['\\lfloor', '\\rfloor'], ['\\lceil', '\\rceil'], ['.', '.']];
const DELIM_LABEL: Record<string, string> = { '(': '(', ')': ')', '[': '[', ']': ']', '\\{': '{', '\\}': '}', '|': '|', '\\|': '‖', '\\langle': '⟨', '\\rangle': '⟩', '\\lfloor': '⌊', '\\rfloor': '⌋', '\\lceil': '⌈', '\\rceil': '⌉', '.': '(none)' };
export function DelimiterDialog({ onInsert, onClose }: { onInsert: (latex: string) => void; onClose: () => void }) {
  const [left, setLeft] = useState('(');
  const [right, setRight] = useState(')');
  const [matched, setMatched] = useState(true);
  const [size, setSize] = useState('');
  const latex = size ? `${size}l${left} #0 ${size}r${right}` : `\\left${left} #0 \\right${right}`;
  const pickLeft = (l: string) => { setLeft(l); if (matched) setRight(DELIMS.find(d => d[0] === l)?.[1] ?? l); };
  return (
    <Dialog title="Math Delimiters" onClose={onClose} buttons={<button class="btn primary" onClick={() => { onInsert(latex); onClose(); }}>Insert</button>}>
      <Row label="Left"><div style="display:flex;gap:4px;flex-wrap:wrap">{DELIMS.map(d => <button key={d[0]} class={'small-btn' + (left === d[0] ? ' active' : '')} onClick={() => pickLeft(d[0])}>{DELIM_LABEL[d[0]]}</button>)}</div></Row>
      <Row label="Right"><div style="display:flex;gap:4px;flex-wrap:wrap">{DELIMS.map(d => <button key={d[1]} class={'small-btn' + (right === d[1] ? ' active' : '')} onClick={() => { setRight(d[1]); setMatched(false); }}>{DELIM_LABEL[d[1]]}</button>)}</div></Row>
      <Row label="Keep matched"><input type="checkbox" checked={matched} onChange={e => { setMatched((e.target as HTMLInputElement).checked); if ((e.target as HTMLInputElement).checked) setRight(DELIMS.find(d => d[0] === left)?.[1] ?? left); }} /></Row>
      <Row label="Size"><select value={size} onChange={e => setSize((e.target as HTMLSelectElement).value)}>{[['', 'Variable (\\left … \\right)'], ['\\big', 'big'], ['\\Big', 'Big'], ['\\bigg', 'bigg'], ['\\Bigg', 'Bigg']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Row>
      <div class="sub" style="color:#777;font-size:11px"><code>{latex.replace(' #0 ', ' … ')}</code></div>
    </Dialog>
  );
}

export function MatrixDialog({ onInsert, onClose }: { onInsert: (latex: string) => void; onClose: () => void }) {
  const [rows, setRows] = useState(2);
  const [cols, setCols] = useState(2);
  const [kind, setKind] = useState('pmatrix');
  const [halign, setHalign] = useState('c');
  const body = Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => (r === 0 && c === 0 ? '#0' : '#?')).join(' & ')).join('\\\\ ');
  const latex = kind === 'array' ? `\\begin{array}{${halign.repeat(cols)}}${body}\\end{array}` : kind === 'cases' ? `\\begin{cases}${body}\\end{cases}` : `\\begin{${kind}}${body}\\end{${kind}}`;
  return (
    <Dialog title="Math Matrix" onClose={onClose} buttons={<button class="btn primary" onClick={() => { onInsert(latex); onClose(); }}>Insert</button>}>
      <Row label="Rows × columns"><input type="number" min={1} max={20} value={rows} onInput={e => setRows(Math.max(1, Number((e.target as HTMLInputElement).value) || 1))} style="width:4em" /> × <input type="number" min={1} max={20} value={cols} onInput={e => setCols(Math.max(1, Number((e.target as HTMLInputElement).value) || 1))} style="width:4em" /></Row>
      <Row label="Decoration"><select value={kind} onChange={e => setKind((e.target as HTMLSelectElement).value)}>{[['matrix', 'None'], ['pmatrix', '( ) parentheses'], ['bmatrix', '[ ] brackets'], ['Bmatrix', '{ } braces'], ['vmatrix', '| | bars'], ['Vmatrix', '‖ ‖ double bars'], ['cases', 'cases'], ['array', 'array (alignment below)']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Row>
      {kind === 'array' && <Row label="Horizontal alignment"><select value={halign} onChange={e => setHalign((e.target as HTMLSelectElement).value)}>{[['l', 'Left'], ['c', 'Center'], ['r', 'Right']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Row>}
      <div class="sub" style="color:#777;font-size:11px">Move between cells with Tab / arrow keys.</div>
    </Dialog>
  );
}

/* --------------------------------------------------------- inset settings */
export function InsetDialog({ node, onApply, onClose }: { node: PMNode; onApply: (attrs: Record<string, unknown>) => void; onClose: () => void }) {
  const type = node.type.name;
  const [params, setParams] = useState<string>(() => { try { return (JSON.parse(node.attrs.params ?? '[]') as string[]).join('\n'); } catch { return ''; } });
  const [arg, setArg] = useState(String(node.attrs.arg ?? node.attrs.cmd ?? ''));
  const apply = () => {
    const lines = params.split('\n');
    const attrs: Record<string, unknown> = { params: JSON.stringify(lines) };
    if (type === 'inset') attrs.arg = arg;
    if (type === 'command') attrs.cmd = arg;
    if (type === 'leaf') attrs.arg = arg;
    onApply(attrs); onClose();
  };
  const noteTypes = ['Note', 'Comment', 'Greyedout'];
  const floatParams = type === 'inset' && node.attrs.name === 'Float';
  const pm = paramMap(params.split('\n'));
  const setP = (k: string, v: string) => {
    const lines = params.split('\n').filter(l => l.trim());
    const i = lines.findIndex(l => l.replace(/^\t/, '').startsWith(k + ' '));
    if (i >= 0) lines[i] = `${k} ${v}`; else lines.push(`${k} ${v}`);
    setParams(lines.join('\n'));
  };
  return (
    <Dialog title={`${type === 'inset' ? node.attrs.name : type} settings`} onClose={onClose} buttons={<button class="btn primary" onClick={apply}>Apply</button>}>
      {type === 'inset' && node.attrs.name === 'Note' && <Row label="Note type"><select value={arg} onChange={e => setArg((e.target as HTMLSelectElement).value)}>{noteTypes.map(t => <option key={t} value={t}>{t}</option>)}</select></Row>}
      {type === 'inset' && node.attrs.name === 'Box' && <Row label="Box type"><select value={arg} onChange={e => setArg((e.target as HTMLSelectElement).value)}>{['Frameless', 'Boxed', 'Shadowbox', 'Doublebox', 'ovalbox', 'Ovalbox'].map(t => <option key={t} value={t}>{t}</option>)}</select></Row>}
      {type === 'inset' && (node.attrs.name === 'Flex' || node.attrs.name === 'Branch' || node.attrs.name === 'Argument') && <Row label={node.attrs.name}><input type="text" value={arg} onInput={e => setArg((e.target as HTMLInputElement).value)} /></Row>}
      {floatParams && <>
        <Row label="Float type"><select value={arg} onChange={e => setArg((e.target as HTMLSelectElement).value)}>{['figure', 'table', 'algorithm'].map(t => <option key={t} value={t}>{t}</option>)}</select></Row>
        <Row label="Placement"><select value={pm.get('placement') ?? 'document'} onChange={e => setP('placement', (e.target as HTMLSelectElement).value)}>{['document', 'H', 'h', 't', 'b', 'p', 'htbp', 'tbp'].map(t => <option key={t} value={t}>{t}</option>)}</select></Row>
        <Row label="Alignment"><select value={pm.get('alignment') ?? 'document'} onChange={e => setP('alignment', (e.target as HTMLSelectElement).value)}>{['document', 'left', 'center', 'right'].map(t => <option key={t} value={t}>{t}</option>)}</select></Row>
        <Row label="Wide (two columns)"><input type="checkbox" checked={pm.get('wide') === 'true'} onChange={e => setP('wide', String((e.target as HTMLInputElement).checked))} /></Row>
        <Row label="Sideways"><input type="checkbox" checked={pm.get('sideways') === 'true'} onChange={e => setP('sideways', String((e.target as HTMLInputElement).checked))} /></Row>
      </>}
      {type === 'command' && <Row label="Command"><input type="text" value={arg} onInput={e => setArg((e.target as HTMLInputElement).value)} /></Row>}
      <Row label="Parameters"><textarea value={params} onInput={e => setParams((e.target as HTMLTextAreaElement).value)} spellcheck={false} style="min-height:120px" /></Row>
      <div style="color:#777;font-size:11px">Parameters are stored exactly as LyX writes them (one <code>key value</code> per line).</div>
    </Dialog>
  );
}

export function commandParams(node: PMNode): Map<string, string> {
  try { return paramMap(JSON.parse(node.attrs.params || '[]')); } catch { return new Map(); }
}

/* ------------------------------------------------------------------ help */
export function HelpDialog({ onClose }: { onClose: () => void }) {
  const rows: [string, string][] = [
    ['Ctrl+M / Ctrl+Shift+M', 'Inline / display formula (Alt+M n: numbered equation)'],
    ['Alt+M t a / t m / t g', 'Display formula: align / multline / gather'],
    ['Alt+M f, s, x, e, (, [', 'In math: fraction, root, subscript, superscript, delimiters'],
    ['Alt+M n', 'In math: toggle equation numbering'],
    ['Esc', 'Leave formula / inset'],
    ['Alt+P s/1/2/3/4/i/e/d/q/t/a', 'Layout: Standard/Chapter/Section/Subsection/…/Itemize/Enumerate/Description/Quote/Title/Abstract'],
    ['Alt+P *2', 'Unnumbered section (Section*)'],
    ['Alt+Shift+→ / ←', 'Increase / decrease list depth'],
    ['Alt+↑ / ↓', 'Move paragraph up / down'],
    ['Alt+A l/r/c/j, i', 'Paragraph alignment; toggle indent'],
    ['Alt+S t/s/n/l/h', 'Font size tiny/small/normal/large/huge'],
    ['Ctrl+E, Ctrl+B, Ctrl+U', 'Emphasis, bold, underline'],
    ['Ctrl+Shift+P, Ctrl+Shift+O, Ctrl+Shift+N', 'Typewriter, strikeout, noun (small caps)'],
    ['Ctrl+Alt+D', 'Reset font'],
    ['Ctrl+L', 'TeX code (ERT); in a formula: start a \\command'],
    ['Ctrl+Alt+P', 'Paragraph settings'],
    ['Ctrl+Alt+F / Ctrl+Alt+M / Ctrl+Alt+N', 'Footnote / margin note / LyX note'],
    ['Ctrl+Alt+C', 'New comment thread'],
    ['Ctrl+Shift+C, Ctrl+Shift+I, Ctrl+Alt+L', 'Citation, cross-reference, label'],
    ['Ctrl+Shift+G, Ctrl+Alt+T', 'Graphics, table'],
    ['Ctrl+I', 'Open/close inset'],
    ['Ctrl+Space, Ctrl+Enter', 'Protected space, line break'],
    ['Ctrl+A', 'Select inset content (again: whole document)'],
    ['Ctrl+S / Ctrl+R / Ctrl+F', 'Write the file now (everything is saved automatically anyway) / view PDF / find & replace'],
    ['Ctrl+Shift+E', 'Track changes'],
    ['Ctrl+Alt+O', 'Outline pane'],
    ['Ctrl+Z / Ctrl+Y', 'Undo / redo (per user)'],
    ['Ctrl++ / Ctrl+- / Ctrl+0', 'Zoom the text (the interface keeps its size)'],
    ['Ctrl+Alt++ / Ctrl+Alt+-', 'Wider / narrower text column'],
  ];
  return (
    <Dialog title="Keyboard shortcuts (LyX bindings)" onClose={onClose} wide>
      <table class="help-table"><tbody>{rows.map(([k, v]) => <tr key={k}><td>{k}</td><td>{v}</td></tr>)}</tbody></table>
    </Dialog>
  );
}

export function TexDialog({ tex, onClose }: { tex: string; onClose: () => void }) {
  return (
    <Dialog title="Generated LaTeX" onClose={onClose} wide buttons={<button class="btn" onClick={() => navigator.clipboard.writeText(tex)}>Copy</button>}>
      <textarea style="min-height:60vh;width:70vw" value={tex} readOnly spellcheck={false} />
    </Dialog>
  );
}

export function MacrosDialog({ meta, onClose }: { meta: DocMeta | null; onClose: () => void }) {
  return (
    <Dialog title="Math macros in this document" onClose={onClose} wide>
      <div class="list" style="max-height:60vh">
        {(meta?.macroList ?? []).map(m => <div key={m.name + m.source}><code>\{m.name}{m.args ? `[${m.args}]` : ''}</code> → <code>{m.display ? `${m.display}  (display of ${m.def})` : m.def}</code> <span class="sub">{m.source}</span></div>)}
        {!meta?.macroList.length && <div class="sub">No macros found.</div>}
      </div>
    </Dialog>
  );
}

export { unquote };
