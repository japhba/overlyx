import { useEffect, useMemo, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import type { DocMeta, ProjectFile, BibItem } from '../api';
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
export function GraphicsDialog({ meta, project, docDir = '', initial, onInsert, onClose }: { meta: DocMeta | null; project: string; docDir?: string; initial?: { filename: string; width?: string; scale?: string; lyxscale?: string }; onInsert: (o: { filename: string; width?: string; scale?: string; lyxscale?: string }) => void; onClose: () => void }) {
  const [filename, setFilename] = useState(initial?.filename ?? '');
  const [width, setWidth] = useState(initial?.width ?? (initial ? '' : '100col%'));
  const [scale, setScale] = useState(initial?.scale ?? '');
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
  return (
    <Dialog title="Graphics" onClose={onClose} buttons={<button class="btn primary" disabled={!filename} onClick={() => { onInsert({ filename, width: width || undefined, scale: scale || undefined, lyxscale: initial?.lyxscale }); onClose(); }}>{initial ? 'Apply' : 'Insert'}</button>}>
      <Row label="File"><input type="text" value={filename} onInput={e => setFilename((e.target as HTMLInputElement).value)} placeholder="figures/plot.pdf" /><button class="small-btn" onClick={upload}>Upload…</button></Row>
      <div class="list" style="max-height:180px">
        {files.map(f => <div key={f.path} class={toDocRel(f.path) === filename ? 'sel' : ''} onClick={() => setFilename(toDocRel(f.path))}>{f.path}</div>)}
        {!files.length && <div class="sub">No image files in this project yet — upload one.</div>}
      </div>
      {filename && <img src={graphicsUrl(project, toProjectRel(filename), 600)} style="max-height:180px;max-width:100%;object-fit:contain;border:1px solid #ddd" alt="" />}
      <Row label="Width"><input type="text" value={width} onInput={e => setWidth((e.target as HTMLInputElement).value)} placeholder="e.g. 100col%, 0.5text%, 8cm (empty = natural)" /></Row>
      <Row label="Scale (%)"><input type="text" value={scale} onInput={e => setScale((e.target as HTMLInputElement).value)} placeholder="e.g. 50" /></Row>
      <div class="sub" style="color:#777;font-size:11px">LyX units: <code>col%</code> = column width, <code>text%</code> = text width, <code>page%</code>, <code>line%</code>, or absolute lengths (cm, in, pt).</div>
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
export function LabelDialog({ initial, onInsert, onClose }: { initial: string; onInsert: (name: string) => void; onClose: () => void }) {
  const [name, setName] = useState(initial);
  return (
    <Dialog title="Label" onClose={onClose} buttons={<button class="btn primary" disabled={!name} onClick={() => { onInsert(name); onClose(); }}>OK</button>}>
      <Row label="Label"><input type="text" autofocus value={name} onInput={e => setName((e.target as HTMLInputElement).value)} onKeyDown={e => { if (e.key === 'Enter' && name) { onInsert(name); onClose(); } }} /></Row>
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
  const [textclass, setTextclass] = useState(get('textclass') || 'article');
  const [options, setOptions] = useState(get('options'));
  const [language, setLanguage] = useState(get('language') || 'english');
  const [fontsize, setFontsize] = useState(get('paperfontsize') || 'default');
  const [papersize, setPapersize] = useState(get('papersize') || 'default');
  const [citeEngine, setCiteEngine] = useState(get('cite_engine') || 'basic');
  const [citeType, setCiteType] = useState(get('cite_engine_type') || 'default');
  const [bibStyle, setBibStyle] = useState(get('biblio_style') || 'plain');
  const [hyperref, setHyperref] = useState(get('use_hyperref') === 'true');
  const [tracking, setTracking] = useState(get('tracking_changes') === 'true');
  const [outputChanges, setOutputChanges] = useState(get('output_changes') === 'true');
  const [preamble, setPreamble] = useState(preStart >= 0 ? headerLines.slice(preStart + 1, preEnd).join('\n') : '');
  const [modules, setModules] = useState((() => { const s = headerLines.indexOf('\\begin_modules'), e = headerLines.indexOf('\\end_modules'); return s >= 0 ? headerLines.slice(s + 1, e).join(', ') : ''; })());
  const [raw, setRaw] = useState(false);
  const [rawText, setRawText] = useState(headerLines.join('\n'));
  const [tab, setTab] = useState<'general' | 'preamble' | 'raw'>('general');
  const save = async () => {
    if (tab === 'raw' || raw) { await api.setHeader(docId, { headerLines: rawText.split('\n') }); onSaved(); onClose(); return; }
    const lines = [...headerLines];
    const setL = (k: string, v: string) => { const i = lines.findIndex(l => l === '\\' + k || l.startsWith('\\' + k + ' ')); if (i >= 0) lines[i] = `\\${k} ${v}`; else { const ti = lines.findIndex(l => l.startsWith('\\textclass')); lines.splice(ti + 1, 0, `\\${k} ${v}`); } };
    setL('textclass', textclass); setL('language', language); setL('paperfontsize', fontsize); setL('papersize', papersize);
    setL('cite_engine', citeEngine); setL('cite_engine_type', citeType); setL('biblio_style', bibStyle);
    setL('use_hyperref', String(hyperref)); setL('tracking_changes', String(tracking)); setL('output_changes', String(outputChanges));
    if (options.trim()) { setL('options', options.trim()); setL('use_default_options', 'false'); } else { const i = lines.findIndex(l => l.startsWith('\\options ')); if (i >= 0) lines.splice(i, 1); }
    const mods = modules.split(',').map(s => s.trim()).filter(Boolean);
    const ms = lines.indexOf('\\begin_modules'), me = lines.indexOf('\\end_modules');
    if (ms >= 0) lines.splice(ms, me - ms + 1);
    if (mods.length) { const ti = lines.findIndex(l => l.startsWith('\\use_default_options')); lines.splice(ti + 1, 0, '\\begin_modules', ...mods, '\\end_modules'); }
    await api.setHeader(docId, { headerLines: lines, preamble });
    onSaved(); onClose();
  };
  return (
    <Dialog title="Document Settings" onClose={onClose} wide buttons={<button class="btn primary" onClick={save}>Apply</button>}>
      <div class="panel-tabs">
        <button class={tab === 'general' ? 'active' : ''} onClick={() => setTab('general')}>Document class & options</button>
        <button class={tab === 'preamble' ? 'active' : ''} onClick={() => setTab('preamble')}>LaTeX preamble</button>
        <button class={tab === 'raw' ? 'active' : ''} onClick={() => { setTab('raw'); setRaw(true); }}>Raw header (advanced)</button>
      </div>
      {tab === 'general' && <>
        <Row label="Document class"><input type="text" list="ol-classes" value={textclass} onInput={e => setTextclass((e.target as HTMLInputElement).value)} /><datalist id="ol-classes">{CLASSES.map(c => <option key={c} value={c} />)}</datalist></Row>
        <Row label="Class options"><input type="text" value={options} onInput={e => setOptions((e.target as HTMLInputElement).value)} placeholder="e.g. prx,amsmath,superscriptaddress" /></Row>
        <Row label="Modules"><input type="text" value={modules} onInput={e => setModules((e.target as HTMLInputElement).value)} placeholder="e.g. theorems-ams, customHeadersFooters" /></Row>
        <Row label="Language"><input type="text" value={language} onInput={e => setLanguage((e.target as HTMLInputElement).value)} /></Row>
        <Row label="Font size"><select value={fontsize} onChange={e => setFontsize((e.target as HTMLSelectElement).value)}>{['default', '10', '11', '12'].map(v => <option key={v} value={v}>{v}</option>)}</select></Row>
        <Row label="Paper size"><select value={papersize} onChange={e => setPapersize((e.target as HTMLSelectElement).value)}>{['default', 'a4', 'letter', 'a5', 'b5', 'legal'].map(v => <option key={v} value={v}>{v}</option>)}</select></Row>
        <Row label="Citation engine"><select value={citeEngine} onChange={e => setCiteEngine((e.target as HTMLSelectElement).value)}>{['basic', 'natbib', 'biblatex', 'jurabib'].map(v => <option key={v} value={v}>{v}</option>)}</select>
          <select value={citeType} onChange={e => setCiteType((e.target as HTMLSelectElement).value)}>{['default', 'authoryear', 'numerical'].map(v => <option key={v} value={v}>{v}</option>)}</select></Row>
        <Row label="Bibliography style"><input type="text" value={bibStyle} onInput={e => setBibStyle((e.target as HTMLInputElement).value)} /></Row>
        <Row label="Hyperref"><input type="checkbox" checked={hyperref} onChange={e => setHyperref((e.target as HTMLInputElement).checked)} /></Row>
        <Row label="Track changes"><input type="checkbox" checked={tracking} onChange={e => setTracking((e.target as HTMLInputElement).checked)} /> <span class="sub">show changes in output</span> <input type="checkbox" checked={outputChanges} onChange={e => setOutputChanges((e.target as HTMLInputElement).checked)} /></Row>
      </>}
      {tab === 'preamble' && <textarea style="min-height:360px" value={preamble} onInput={e => setPreamble((e.target as HTMLTextAreaElement).value)} spellcheck={false} />}
      {tab === 'raw' && <textarea style="min-height:420px" value={rawText} onInput={e => setRawText((e.target as HTMLTextAreaElement).value)} spellcheck={false} />}
      {meta && <div style="color:#777;font-size:11px">Macros available: {meta.macroList.length} · Bibliography entries: {meta.bib.length} · Layouts: {meta.layouts?.length ?? 'n/a'}</div>}
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
    ['Ctrl+L', 'TeX code (ERT)'],
    ['Ctrl+Alt+F / Ctrl+Alt+M / Ctrl+Alt+N', 'Footnote / margin note / LyX note'],
    ['Ctrl+Alt+C', 'New comment thread'],
    ['Ctrl+Shift+C, Ctrl+Shift+I, Ctrl+Alt+L', 'Citation, cross-reference, label'],
    ['Ctrl+Shift+G, Ctrl+Alt+T', 'Graphics, table'],
    ['Ctrl+I', 'Open/close inset'],
    ['Ctrl+Space, Ctrl+Enter', 'Protected space, line break'],
    ['Ctrl+A', 'Select inset content (again: whole document)'],
    ['Ctrl+S / Ctrl+R / Ctrl+F', 'Save now / view PDF / find & replace'],
    ['Ctrl+Shift+E', 'Track changes'],
    ['Ctrl+Alt+O', 'Outline pane'],
    ['Ctrl+Z / Ctrl+Y', 'Undo / redo (per user)'],
    ['Ctrl++ / Ctrl+-', 'Zoom'],
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
