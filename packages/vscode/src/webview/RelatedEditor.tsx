import { useEffect, useRef, useState } from 'preact/hooks';
import type { EditorView } from 'prosemirror-view';
import type { DocMeta } from '@client/api';
import { api } from '@client/api';
import { refreshMacros } from '@client/editor/editor';
import { setMarginMode } from '@client/editor/plugins/margin';
import { editorSessions } from './editorSession';
import { createLocalEditor, type LocalEditorHandle } from './localEditor';
import { vscode } from './globals';
import type { HostToEditor } from '../shared/protocol';

export interface RelatedHandle extends LocalEditorHandle { meta: DocMeta; flush(): void }

export function RelatedEditor(props: {
  id: string; marginMode: boolean;
  register(id: string, handle: RelatedHandle | null): void;
  onSelection(view: EditorView): void;
  onDocChange(): void;
}) {
  const { id, marginMode } = props;
  const container = useRef<HTMLDivElement>(null);
  const callbacks = useRef(props);
  callbacks.current = props;
  const handleRef = useRef<RelatedHandle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const flush = () => {
      clearTimeout(timer);
      const handle = handleRef.current;
      const update = handle?.takeUpdate(editorSessions.get(id)!.headerLines!);
      if (update) vscode.postMessage({ type: 'updateRelated', id, ...update });
    };
    const receive = (event: MessageEvent<HostToEditor>) => {
      const msg = event.data;
      if (msg.type === 'metadataChanged') {
        void api.meta(id).then(meta => {
          const handle = handleRef.current;
          if (handle) { handle.meta = meta; refreshMacros(handle.view, meta.macros, true); callbacks.current.onDocChange(); }
        });
        return;
      }
      if (!('id' in msg) || msg.id !== id) return;
      if (msg.type === 'relatedError') { setError(msg.error); return; }
      if (msg.type === 'relatedExternalUpdate') {
        const handle = handleRef.current;
        if (handle) {
          clearTimeout(timer);
          handle.applyExternal(msg.pmDoc, msg.headerLines);
          flush();
        }
      }
      if (msg.type === 'relatedInit' && !handleRef.current) {
        const handle = createLocalEditor({
          docId: id, child: true, container: container.current!, pmDoc: msg.pmDoc, headerLines: msg.headerLines, marginMode,
          onSelectionChange: view => callbacks.current.onSelection(view),
          onDocChange: () => { clearTimeout(timer); timer = setTimeout(flush, 300); callbacks.current.onDocChange(); },
        });
        // A hidden view may have retained its undo history while its TextDocument changed.
        handle.applyExternal(msg.pmDoc, msg.headerLines);
        handleRef.current = { ...handle, meta: msg.meta, flush };
        refreshMacros(handle.view, msg.meta.macros, true);
        callbacks.current.register(id, handleRef.current);
        setLoaded(true);
      }
    };
    window.addEventListener('message', receive);
    vscode.postMessage({ type: 'loadRelated', id });
    return () => {
      window.removeEventListener('message', receive);
      flush();
      callbacks.current.register(id, null);
      handleRef.current?.destroy(true);
      handleRef.current = null;
    };
  }, [id]);
  useEffect(() => { if (handleRef.current) setMarginMode(handleRef.current.view, marginMode); }, [marginMode]);
  return <div class="child-doc" data-related-id={id}>
    <div class="child-doc-header">
      <span class="name">{id.split('/').pop()}</span>
      <button class="small-btn" onClick={() => vscode.postMessage({ type: 'openDoc', id, beside: true })}>Open in editor tab</button>
      {!loaded && !error && <span>Loading…</span>}
    </div>
    {error && <div class="child-doc-error" role="alert">Could not open {id}: {error}</div>}
    <div class="editor-host child" ref={container} />
  </div>;
}
