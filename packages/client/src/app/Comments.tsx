/**
 * Comments panel (right sidebar): every comment thread of the open editors — the open ones
 * first, the resolved ones in an archive below, as Google Docs keeps its comment history.
 * A resolved thread leaves the text (only a small grey marker stays where it was anchored); from
 * here it can be found again and reopened.
 */
import { useMemo, useState } from 'preact/hooks';
import type { EditorView } from 'prosemirror-view';
import { collectComments, gotoComment, setCommentResolved, type CommentInfo } from '../editor/commentops';
import { viewDocId } from '../editor/context';
import { navHistory } from './navhistory';

export function Comments({ views, tick }: { views: EditorView[]; /** bumps when a document changed */ tick: number }) {
  const [showResolved, setShowResolved] = useState(true);
  const items = useMemo(() => views.flatMap(v => collectComments(v)), [views, tick]);
  const open = items.filter(i => !i.resolved);
  const resolved = items.filter(i => i.resolved);
  const many = views.length > 1;
  const row = (it: CommentInfo) => (
    <div key={viewDocId(it.view) + ':' + it.pos} class={'comment-row' + (it.resolved ? ' resolved' : '')} data-comment={it.resolved ? 'resolved' : 'open'}
      onClick={() => navHistory.jump(() => gotoComment(it.view, it.pos))} title="Show this comment in the text">
      <div class="who">
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
      </div>
      {showResolved && (resolved.length ? resolved.map(row) : <div class="empty">Nothing resolved yet.</div>)}
    </div>
  );
}
