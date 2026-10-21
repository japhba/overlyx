/**
 * An HTML article's right-hand pane (core html/article.ts): where a LaTeX document has its PDF, the
 * page as it is published — its own styles, scripts and fonts, running in the sandbox (server
 * deliverables.ts, runtime "view" mode) — loaded again a moment after each save, where it was
 * scrolled to (runtime/embed.ts startViewSync). A phone's width on request; the PDF is the page
 * printed by the server's browser.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { api } from '../api';
import { projectOfDoc, docPathOf } from '@overlyx/core';

const PHONE = 390;

export function ArticlePage({ docId, savedAt, onClose }: {
  docId: string;
  /** when the document was last written: the page is loaded again after it */
  savedAt: number;
  onClose?: () => void;
}) {
  const project = projectOfDoc(docId), path = docPathOf(docId);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [phone, setPhone] = useState(false);
  const [n, setN] = useState(0);
  const frame = useRef<HTMLIFrameElement>(null);
  const scrolled = useRef(0);

  useEffect(() => {
    let live = true;
    api.deliverableLink(project, path)
      .then(l => { if (live) setUrl(l.base + l.entry.split('/').map(encodeURIComponent).join('/')); })
      .catch(e => { if (live) setError((e as Error).message); });
    return () => { live = false; };
  }, [project, path]);

  // the page saved anew: shown anew, a moment later (the next save may follow right away)
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    const t = setTimeout(() => setN(x => x + 1), 900);
    return () => clearTimeout(t);
  }, [savedAt]);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (!frame.current || e.source !== frame.current.contentWindow) return;
      const d = e.data as { ol?: string; y?: number } | null;
      if (d?.ol === 'viewScroll' && typeof d.y === 'number') scrolled.current = d.y;
      // (loaded: back where the reader was)
      if (d?.ol === 'viewReady' && scrolled.current) frame.current.contentWindow?.postMessage({ ol: 'viewScrollTo', y: scrolled.current }, '*');
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const src = url ? `${url}?ol=view&n=${n}` : null;
  const pdfHref = `/api/projects/${encodeURIComponent(project)}/deliverable-pdf?path=${encodeURIComponent(path)}`;
  return (
    <div class="pdf-panel article-page" data-article-page>
      <div class="bar">
        <button type="button" class="small-btn" onClick={() => setN(x => x + 1)} title="Load the page again">↻</button>
        <button type="button" class={'small-btn' + (phone ? ' active' : '')} aria-pressed={phone} onClick={() => setPhone(p => !p)} title="The page at a phone's width">Phone</button>
        <div class="pdf-bar-fill" />
        {src && <a class="small-btn" href={`${url}?ol=view`} target="_blank" rel="noopener" title="The page in a tab of its own">Open ↗</a>}
        <a class="small-btn" href={pdfHref} target="_blank" rel="noopener" title="The page printed as a PDF">PDF</a>
        {onClose && <button type="button" class="small-btn close" onClick={onClose} title="Hide the page">✕</button>}
      </div>
      <div class={'article-page-view' + (phone ? ' phone' : '')}>
        {src ? <iframe ref={frame} key={src} src={src} style={phone ? { width: PHONE + 'px' } : undefined} title="The page as published"
          sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms allow-modals allow-downloads" />
          : <div class="pdf-empty">{error ? 'Could not show the page: ' + error : 'Loading the page…'}</div>}
      </div>
    </div>
  );
}
