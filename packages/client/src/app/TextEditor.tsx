/**
 * A simple editor for the project's text files (.tex, .bib, .sty, …): plain textarea with line
 * numbers, autosave (1.5 s after the last change, or Ctrl+S), and a conflict check — a save is
 * refused when the file changed on the server in the meantime (someone else, desktop LyX, git).
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { api, fileUrl, type Role } from '../api';

type SaveState = 'loading' | 'saved' | 'dirty' | 'saving' | 'conflict' | 'error' | 'readonly';
const LABEL: Record<SaveState, string> = { loading: 'Loading…', saved: '✓ Saved', dirty: 'Unsaved changes…', saving: 'Saving…', conflict: 'Not saved — changed on the server', error: 'Could not save', readonly: '👁 view only' };

export function TextEditor({ id, notify }: { id: string; notify: (text: string, kind?: 'info' | 'error') => void }) {
  const project = id.split('/')[0];
  const path = id.slice(project.length + 1);
  const [text, setText] = useState('');
  const [state, setState] = useState<SaveState>('loading');
  const [err, setErr] = useState('');
  const [conflict, setConflict] = useState<{ text: string; mtime: number } | null>(null);
  const [pos, setPos] = useState({ line: 1, col: 1 });
  const role = useRef<Role>('edit');
  const mtime = useRef(0);
  const dirty = useRef(false);
  const latest = useRef('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ta = useRef<HTMLTextAreaElement>(null);
  const gutter = useRef<HTMLDivElement>(null);

  const load = async () => {
    try {
      const r = await api.readText(project, path);
      latest.current = r.text; setText(r.text); mtime.current = r.mtime; role.current = r.role;
      dirty.current = false; setConflict(null); setErr('');
      setState(r.role === 'view' ? 'readonly' : 'saved');
    } catch (e) { setErr((e as Error).message); setState('error'); }
  };

  const save = async (force = false) => {
    if (role.current === 'view' || (!dirty.current && !force)) return;
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    setState('saving');
    const snapshot = latest.current;
    try {
      const r = await api.writeText(project, path, snapshot, force ? undefined : mtime.current);
      mtime.current = r.mtime; setConflict(null);
      if (latest.current === snapshot) { dirty.current = false; setState('saved'); } else { setState('dirty'); schedule(); }
    } catch (e) {
      const err = e as Error & { status?: number; data?: { text?: string; mtime?: number } };
      if (err.status === 409 && err.data && typeof err.data.text === 'string') { setConflict({ text: err.data.text, mtime: err.data.mtime ?? 0 }); setState('conflict'); }
      else { setErr(err.message); setState('error'); notify('Could not save ' + path + ': ' + err.message, 'error'); }
    }
  };
  const schedule = () => { if (timer.current) clearTimeout(timer.current); timer.current = setTimeout(() => void save(), 1500); };

  useEffect(() => {
    void load();
    return () => {
      if (timer.current) clearTimeout(timer.current);
      // leaving the tab with unsaved text: write it now (best effort)
      if (dirty.current && role.current !== 'view') void api.writeText(project, path, latest.current, mtime.current).catch(() => {});
    };
  }, [id]);
  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => { if (dirty.current) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, []);

  const onInput = (e: Event) => {
    const v = (e.target as HTMLTextAreaElement).value;
    latest.current = v; setText(v); dirty.current = true;
    if (state !== 'conflict') { setState('dirty'); schedule(); }
    updatePos();
  };
  const updatePos = () => {
    const el = ta.current; if (!el) return;
    const before = el.value.slice(0, el.selectionStart);
    const line = before.split('\n').length;
    setPos({ line, col: before.length - before.lastIndexOf('\n') });
  };
  const onKeyDown = (e: KeyboardEvent) => {
    const mod = navigator.platform.includes('Mac') ? e.metaKey : e.ctrlKey;
    if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); void save(dirty.current); if (!dirty.current) notify('Nothing to save'); return; }
    if (e.key === 'Tab' && !e.ctrlKey && !e.altKey && !e.metaKey && role.current !== 'view') {
      e.preventDefault();
      const el = ta.current!;
      if (!document.execCommand('insertText', false, '  ')) {
        const s = el.selectionStart, end = el.selectionEnd;
        el.value = el.value.slice(0, s) + '  ' + el.value.slice(end);
        el.selectionStart = el.selectionEnd = s + 2;
      }
      onInput({ target: el } as unknown as Event);
    }
  };
  const lines = text.split('\n').length;
  const readonly = state === 'readonly' || state === 'loading' || state === 'error';

  return (
    <div class="text-editor" data-text-editor={id}>
      <div class="te-head">
        <span class="path" title={id}>📝 {path}</span>
        <span class={'state ' + state} data-state={state}>{LABEL[state]}{state === 'error' && err ? ': ' + err : ''}</span>
        <span class="spacer" />
        <span title="Line and column of the cursor">Ln {pos.line}, Col {pos.col} · {lines} lines</span>
        <button class="small-btn" title="Reload from the server" onClick={() => { if (!dirty.current || confirm('Discard your unsaved changes and reload?')) void load(); }}>↻ Reload</button>
        <a class="small-btn" href={fileUrl(project, path)} download={path.split('/').pop()} title="Download this file">⬇</a>
      </div>
      {conflict && (
        <div class="te-conflict">
          <span>This file was changed on the server while you were editing (by someone else, desktop LyX or git).</span>
          <button class="small-btn" onClick={() => { latest.current = conflict.text; setText(conflict.text); mtime.current = conflict.mtime; dirty.current = false; setConflict(null); setState('saved'); }}>Take the server's version</button>
          <button class="small-btn" onClick={() => void save(true)}>Overwrite with mine</button>
        </div>
      )}
      <div class="te-body">
        <div class="te-gutter" ref={gutter} aria-hidden="true">{Array.from({ length: lines }, (_, i) => i + 1).join('\n')}</div>
        <textarea ref={ta} value={text} spellcheck={false} readOnly={readonly} wrap="off" autocomplete="off" autocorrect="off" autocapitalize="off"
          onInput={onInput} onKeyDown={onKeyDown} onClick={updatePos} onKeyUp={updatePos}
          onScroll={e => { if (gutter.current) gutter.current.scrollTop = (e.target as HTMLTextAreaElement).scrollTop; }} />
      </div>
    </div>
  );
}
