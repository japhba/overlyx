/**
 * Comments panel (right sidebar): every comment thread of the open editors — the open ones
 * first, the resolved ones in an archive below, as Google Docs keeps its comment history.
 * A resolved thread leaves the text — a small grey marker stays where it was anchored only with
 * "In the text" ticked here (View ▸ Resolved comments in the text); from here it can be found
 * again and reopened.
 */
import { useEffect, useMemo, useState } from 'preact/hooks';
import type { EditorView } from 'prosemirror-view';
import { collectComments, gotoComment, setCommentResolved, authorInitials, authorHue, type CommentInfo } from '../editor/commentops';
import { viewDocId } from '../editor/context';
import { navHistory } from './navhistory';
import { getPrefs, setPref, subscribePrefs } from '../prefs';

export function Comments({ views, tick }: { views: EditorView[]; /** bumps when a document changed */ tick: number }) {
  const [showResolved, setShowResolved] = useState(true);
  const [inText, setInText] = useState(getPrefs().showResolvedComments);
  useEffect(() => subscribePrefs(p => setInText(p.showResolvedComments)), []);
  const items = useMemo(() => views.flatMap(v => collectComments(v)), [views, tick]);
  const open = items.filter(i => !i.resolved);
  const resolved = items.filter(i => i.resolved);
  const many = views.length > 1;
  const row = (it: CommentInfo) => (
    <div key={viewDocId(it.view) + ':' + it.pos} class={'comment-row' + (it.resolved ? ' resolved' : '')} data-comment={it.resolved ? 'resolved' : 'open'}
      onClick={() => navHistory.jump(() => gotoComment(it.view, it.pos))} title="Show this comment in the text">
      <div class="who">
        <span class="avatar" style={`--who-hue:${authorHue(it.author || 'Comment')}`}>{authorInitials(it.author || 'C')}</span>
        <span class="author">{it.author || 'Comment'}</span>
        {it.time && <span class="time">{it.time}</span>}
        {many && <span class="doc">{viewDocId(it.view).split('/').pop()}</span>}
        {it.replies > 0 && <span class="replies">{it.replies} {it.replies === 1 ? 'reply' : 'replies'}</span>}
      </div>
      <div class="excerpt">{it.text || <i>(empty)</i>}</div>
      <div class="actions">
        <button type="button" class="small-btn" data-action={it.resolved ? 'reopen' : 'resolve'} onClick={e => { e.stopPropagation(); setCommentResolved(it.view, it.pos, !it.resolved); }}>{it.resolved ? 'Reopen' : 'Resolve'}</button>
      </div>
    </div>
  );
  return (
    <div class="comments-panel">
      <div class="section-title">Open <span class="count">{open.length}</span></div>
      {open.length ? open.map(row) : <div class="empty">No open comments.</div>}
      <div class="section-title archive" onClick={() => setShowResolved(s => !s)} title="Resolved comments are kept here">
        <span class="chev">{showResolved ? '▾' : '▸'}</span> Resolved <span class="count">{resolved.length}</span>
        <label class="in-text" title="A small marker in the text where each resolved thread was (View ▸ Resolved comments in the text)" onClick={e => e.stopPropagation()}>
          <input type="checkbox" checked={inText} onChange={e => setPref('showResolvedComments', (e.currentTarget as HTMLInputElement).checked)} /> In the text
        </label>
      </div>
      {showResolved && (resolved.length ? resolved.map(row) : <div class="empty">Nothing resolved yet.</div>)}
    </div>
  );
}
