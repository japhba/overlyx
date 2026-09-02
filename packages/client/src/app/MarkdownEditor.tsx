/**
 * A WYSIWYG editor for the project's markdown files (README.md, notes.md, …): headings render at
 * their real sizes as you type (`## ` becomes a second-level heading on the spot), bold/italic/
 * code/lists/quotes/links likewise — ProseMirror with the markdown schema; the file on disk stays
 * ordinary markdown (parsed on load, serialized on save). Autosave and the conflict check follow
 * the plain text editor's rules; the Source button switches to that editor for the raw text.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { EditorState, Plugin } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { history, undo, redo } from 'prosemirror-history';
import { keymap } from 'prosemirror-keymap';
import { baseKeymap, toggleMark, setBlockType, chainCommands, exitCode } from 'prosemirror-commands';
import { splitListItem, liftListItem, sinkListItem } from 'prosemirror-schema-list';
import { inputRules, textblockTypeInputRule, wrappingInputRule, smartQuotes, ellipsis } from 'prosemirror-inputrules';
import { schema, defaultMarkdownParser, defaultMarkdownSerializer } from 'prosemirror-markdown';
import { api } from '../api';
import { TextEditor } from './TextEditor';

function mdInputRules() {
  const rules = [
    ...smartQuotes, ellipsis,
    // the ask: "## " resizes into a real heading while typing
    textblockTypeInputRule(/^(#{1,6})\s$/, schema.nodes.heading, m => ({ level: m[1].length })),
    textblockTypeInputRule(/^```$/, schema.nodes.code_block),
    wrappingInputRule(/^\s*([-+*])\s$/, schema.nodes.bullet_list),
    wrappingInputRule(/^(\d+)\.\s$/, schema.nodes.ordered_list, m => ({ order: +m[1] }), (m, node) => node.childCount + (node.attrs.order as number) === +m[1]),
    wrappingInputRule(/^\s*>\s$/, schema.nodes.blockquote),
  ];
  return inputRules({ rules });
}

function mdKeymap() {
  return keymap({
    'Mod-z': undo, 'Mod-y': redo, 'Mod-Shift-z': redo,
    'Mod-b': toggleMark(schema.marks.strong),
    'Mod-i': toggleMark(schema.marks.em),
    'Mod-`': toggleMark(schema.marks.code),
    'Shift-Ctrl-0': setBlockType(schema.nodes.paragraph),
    ...Object.fromEntries([1, 2, 3, 4, 5, 6].map(n => [`Shift-Ctrl-${n}`, setBlockType(schema.nodes.heading, { level: n })])),
    Enter: chainCommands(splitListItem(schema.nodes.list_item), baseKeymap.Enter),
    Tab: sinkListItem(schema.nodes.list_item),
    'Shift-Tab': liftListItem(schema.nodes.list_item),
    'Mod-Enter': exitCode,
  });
}

type SaveState = 'loading' | 'saved' | 'dirty' | 'saving' | 'conflict' | 'error' | 'readonly';
const LABEL: Record<SaveState, string> = { loading: 'Loading…', saved: '✓ Saved', dirty: 'Unsaved changes…', saving: 'Saving…', conflict: 'Not saved — changed on the server', error: 'Could not save', readonly: '👁 view only' };

export function MarkdownEditor({ id, notify }: { id: string; notify: (text: string, kind?: 'info' | 'error') => void }) {
  const [source, setSource] = useState(false);
  if (source) {
    return (
      <div class="md-editor as-source">
        <button class="small-btn md-mode" data-md-mode title="Back to the formatted view" onClick={() => setSource(false)}>Rich text</button>
        <TextEditor key={'src:' + id} id={id} notify={notify} />
      </div>
    );
  }
  return <RichMarkdown key={'rich:' + id} id={id} notify={notify} onSource={() => setSource(true)} />;
}

function RichMarkdown({ id, notify, onSource }: { id: string; notify: (text: string, kind?: 'info' | 'error') => void; onSource: () => void }) {
  const project = id.split('/')[0];
  const path = id.slice(project.length + 1);
  const host = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<SaveState>('loading');
  const stateRef = useRef<SaveState>('loading');
  const setSt = (s: SaveState) => { stateRef.current = s; setState(s); };
  const mtime = useRef(0);
  const lastSaved = useRef('');
  const viewRef = useRef<EditorView | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const serialize = () => (viewRef.current ? defaultMarkdownSerializer.serialize(viewRef.current.state.doc) : lastSaved.current);

  const save = async (force = false) => {
    const cur = stateRef.current;
    if (cur === 'readonly' || cur === 'loading' || (!force && cur !== 'dirty' && cur !== 'error' && cur !== 'conflict')) return;
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    const text = serialize();
    if (text === lastSaved.current && !force) { setSt('saved'); return; }
    setSt('saving');
    try {
      const r = await api.writeText(project, path, text, mtime.current);
      mtime.current = r.mtime; lastSaved.current = text;
      setSt(serialize() === text ? 'saved' : 'dirty');
    } catch (e) {
      const msg = (e as Error).message;
      if (/changed on the server/i.test(msg) || /conflict/i.test(msg)) { setSt('conflict'); notify('The file changed on the server — open the Source view to compare before saving over it', 'error'); }
      else { setSt('error'); notify(msg, 'error'); }
    }
  };

  useEffect(() => {
    let dead = false;
    void (async () => {
      try {
        const r = await api.readText(project, path);
        if (dead || !host.current) return;
        mtime.current = r.mtime; lastSaved.current = r.text;
        const doc = defaultMarkdownParser.parse(r.text);
        const view: EditorView = new EditorView(host.current, {
          state: EditorState.create({
            doc,
            plugins: [
              mdInputRules(), mdKeymap(), keymap(baseKeymap), history(),
              new Plugin({ props: { handleClickOn: (_v, _p, node, _np, ev) => {
                if (!(ev.metaKey || ev.ctrlKey)) return false;
                const mark = node.marks?.find(m => m.type === schema.marks.link);
                if (mark) { window.open(String(mark.attrs.href), '_blank', 'noopener'); return true; }
                return false;
              } } }),
            ],
          }),
          editable: () => r.role !== 'view',
          dispatchTransaction: (tr) => {
            view.updateState(view.state.apply(tr));
            if (tr.docChanged && stateRef.current !== 'readonly') {
              setSt('dirty');
              if (timer.current) clearTimeout(timer.current);
              timer.current = setTimeout(() => { void save(); }, 1500);
            }
          },
        });
        viewRef.current = view;
        setSt(r.role === 'view' ? 'readonly' : 'saved');
        view.focus();
      } catch (e) { if (!dead) { setSt('error'); notify((e as Error).message, 'error'); } }
    })();
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); void save(true); }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      dead = true;
      window.removeEventListener('keydown', onKey);
      if (timer.current) clearTimeout(timer.current);
      // a dirty buffer is flushed on the way out (tab switch)
      if (stateRef.current === 'dirty') void save(true);
      viewRef.current?.destroy(); viewRef.current = null;
    };
  }, [id]);

  return (
    <div class="md-editor">
      <div class="md-bar">
        <span class="name" title={id}>{path.split('/').pop()}</span>
        <span class={'save-state s-' + state} data-md-state={state}>{LABEL[state]}</span>
        <span style="flex:1" />
        <button class="small-btn" data-md-mode title="Edit the raw markdown" onClick={() => { if (stateRef.current === 'dirty') void save(true); onSource(); }}>Source</button>
      </div>
      <div class="md-host" ref={host} data-md-editor />
    </div>
  );
}
