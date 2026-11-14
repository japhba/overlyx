/**
 * A citation in a document links back to My library: resting the pointer on it shows a card with the
 * library's reference for each of its keys — title, authors, venue and year, the private note — and
 * Open PDF / Open link / Show in my library. A key is the library's when the reference has that key,
 * or when the project's entry for it has the same title (an entry cited before it was in the library).
 * A cited paper the library does not have offers "Add to my library" (the project's entry, server
 * library.ts entryOfDocument).
 *
 * The citation views (editor/nodeviews/leaf.ts) carry their keys in `data-cite-keys`; one listener on
 * the document serves every editor of the web app. Installed by App.tsx (the VS Code extension has no
 * library).
 */
import { editorContext } from '../editor/context';
import { libraryState, refreshLibrary, refForCitation, authorsLine, libraryApi, openLibrary, putRef, type LibRef } from './store';
import './library.css';

let installed = false;

/** a card's action: a link to open (a new tab) or a thing to do */
const actionLink = (acts: HTMLElement) => (text: string, href: string | null, onClick?: () => void): HTMLAnchorElement => {
  const a = document.createElement('a'); a.textContent = text;
  if (href) { a.href = href; a.target = '_blank'; a.rel = 'noopener'; }
  if (onClick) a.addEventListener('click', ev => { ev.preventDefault(); onClick(); });
  acts.append(a);
  return a;
};

export function installCiteHover(): () => void {
  if (installed || typeof document === 'undefined') return () => {};
  installed = true;
  let card: HTMLElement | null = null, over: HTMLElement | null = null, timer = 0;
  const hide = () => {
    clearTimeout(timer);
    card?.remove(); card = null;
    if (over?.dataset.citeTitle !== undefined) { over.title = over.dataset.citeTitle; delete over.dataset.citeTitle; }
    over = null;
  };
  /** the library's references of a citation, and the project's entries the library does not have */
  const refsOf = (el: HTMLElement) => {
    const bib = editorContext.meta?.bib ?? [];
    const refs: LibRef[] = [], missing: { key: string; author: string; year: string; title: string }[] = [];
    for (const key of (el.dataset.citeKeys ?? '').split(',').map(k => k.trim()).filter(Boolean)) {
      const e = bib.find(b => b.key === key);
      const r = refForCitation(key, e?.title);
      if (r) { if (!refs.includes(r)) refs.push(r); }
      else if (e) missing.push(e);
    }
    return { refs, missing };
  };
  const show = (el: HTMLElement) => {
    const st = libraryState();
    if (!st.loaded) { void refreshLibrary().then(() => { if (over === el) show(el); }); return; }
    if (!st.available) return;
    const { refs, missing } = refsOf(el);
    if (!refs.length && !missing.length) return;
    card?.remove();
    card = document.createElement('div');
    card.className = 'cite-card';
    card.setAttribute('role', 'tooltip');
    card.dataset.citeCard = '';
    for (const r of refs.slice(0, 4)) {
      const item = document.createElement('div');
      item.className = 'cite-card-item';
      const b = document.createElement('b'); b.textContent = r.title; item.append(b);
      const sub = document.createElement('div'); sub.className = 'sub';
      sub.textContent = [authorsLine(r.authors, 4), [r.venue, r.year].filter(Boolean).join(', ')].filter(Boolean).join(' · ');
      item.append(sub);
      if (r.note) { const n = document.createElement('div'); n.className = 'cite-card-note'; n.textContent = r.note.length > 200 ? r.note.slice(0, 200) + '…' : r.note; item.append(n); }
      const acts = document.createElement('div'); acts.className = 'cite-card-actions';
      const link = actionLink(acts);
      if (r.pdf) link('Open PDF', libraryApi.pdfUrl(r.id));
      if (r.url) link('Open link ↗', r.url);
      link('Show in my library', null, () => { hide(); openLibrary(true); });
      item.append(acts);
      card.append(item);
    }
    // a cited paper the library does not have: one click takes the project's entry in
    const doc = editorContext.docId;
    for (const m of missing.slice(0, 3)) {
      const item = document.createElement('div');
      item.className = 'cite-card-item';
      const b = document.createElement('b'); b.textContent = m.title || m.key; item.append(b);
      const sub = document.createElement('div'); sub.className = 'sub'; sub.textContent = [m.author, m.year].filter(Boolean).join(' · ') + ' — not in your library'; item.append(sub);
      const acts = document.createElement('div'); acts.className = 'cite-card-actions';
      if (doc) {
        const a = actionLink(acts)('Add to my library', null, () => {
          a.textContent = 'Adding…';
          libraryApi.fromDocument(doc, m.key)
            .then(o => { for (const r of [...o.added, ...o.duplicates]) putRef(r); a.textContent = o.added.length ? `Added as [${o.added[0].key}]` : 'In your library already'; })
            .catch(e => { a.textContent = (e as Error).message; });
        });
        a.dataset.citeAddLibrary = m.key;
      }
      item.append(acts);
      card.append(item);
    }
    card.addEventListener('mouseenter', () => clearTimeout(timer));
    card.addEventListener('mouseleave', () => { timer = window.setTimeout(hide, 250); });
    document.body.append(card);
    // below the citation, inside the window
    const rect = el.getBoundingClientRect(), w = card.offsetWidth, h = card.offsetHeight;
    const top = rect.bottom + 6 + h > innerHeight ? Math.max(4, rect.top - 6 - h) : rect.bottom + 6;
    card.style.left = `${Math.max(4, Math.min(innerWidth - w - 4, rect.left))}px`;
    card.style.top = `${top}px`;
    // the card says it all: the browser's own tooltip would cover it
    if (el.title) { el.dataset.citeTitle = el.title; el.title = ''; }
  };
  const onOver = (e: MouseEvent) => {
    const target = e.target as Element | null;
    if (card && target?.closest?.('[data-cite-card]')) { clearTimeout(timer); return; }
    const el = (target?.closest?.('[data-cite-keys]') as HTMLElement | null) ?? null;
    if (el === over) { clearTimeout(timer); return; }
    clearTimeout(timer);
    if (!el) { if (card) timer = window.setTimeout(hide, 250); else over = null; return; }
    if (card) hide();
    over = el;
    timer = window.setTimeout(() => { if (over === el) show(el); }, 350);
  };
  const onDown = (e: Event) => { if (card && !(e.target as Element | null)?.closest?.('[data-cite-card]')) hide(); };
  document.addEventListener('mouseover', onOver);
  document.addEventListener('pointerdown', onDown, true);
  document.addEventListener('keydown', hide, true);
  return () => {
    installed = false; hide();
    document.removeEventListener('mouseover', onOver);
    document.removeEventListener('pointerdown', onDown, true);
    document.removeEventListener('keydown', hide, true);
  };
}
