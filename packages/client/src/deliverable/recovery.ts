/** Local recovery copies are never written into a coauthor's object without consent. */
import type { KeyPress } from './protocol';

export interface TextDraft { id: string; html: string; reason: string }

/** Plain text retained while a newly drawn box has not arrived yet. */
export function bufferedTextHtml(keys: readonly KeyPress[]): string {
  let chars: string[] = [], anchor = 0, head = 0;
  const replace = (value: string) => {
    const from = Math.min(anchor, head), to = Math.max(anchor, head), inserted = Array.from(value);
    chars = [...chars.slice(0, from), ...inserted, ...chars.slice(to)];
    anchor = head = from + inserted.length;
  };
  for (const key of keys) {
    if (key.ctrl || key.meta) continue;
    if (key.text !== undefined) replace(key.text);
    else if (key.key.length === 1 && !key.alt) replace(key.key);
    else if (key.key === 'Enter') replace('\n');
    else if (key.key === 'Backspace' || key.key === 'Delete') {
      if (head === anchor) {
        if (key.key === 'Backspace') anchor = Math.max(0, head - 1);
        else anchor = Math.min(chars.length, head + 1);
      }
      replace('');
    } else if (key.key === 'ArrowLeft' || key.key === 'ArrowRight') {
      const next = !key.shift && head !== anchor
        ? (key.key === 'ArrowLeft' ? Math.min(head, anchor) : Math.max(head, anchor))
        : Math.max(0, Math.min(chars.length, head + (key.key === 'ArrowLeft' ? -1 : 1)));
      head = next; if (!key.shift) anchor = head;
    } else if (key.key === 'Escape') break;
  }
  return chars.join('').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
}

export function loadTextDrafts(key: string): TextDraft[] {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? '[]');
    return Array.isArray(value) ? value.filter(d => d && typeof d.id === 'string' && typeof d.html === 'string' && typeof d.reason === 'string') : [];
  } catch { return []; }
}

export function saveTextDrafts(key: string, drafts: readonly TextDraft[]): boolean {
  try {
    if (drafts.length) localStorage.setItem(key, JSON.stringify(drafts));
    else localStorage.removeItem(key);
    return true;
  } catch { return false; }
}

export function draftWords(html: string): string {
  const doc = new DOMParser().parseFromString(html.replace(/<br\s*\/?>|<\/(?:p|div|li)>/gi, '$&\n'), 'text/html');
  return doc.body.textContent ?? '';
}

/** Each open editor writes its own buffer, so two tabs cannot replace one another's drafts. */
export function pendingDraftKey(key: string, owner: string): string { return key + ':pending:' + owner; }

export function loadPendingTextDrafts(key: string): TextDraft[] {
  try {
    return Object.keys(localStorage).filter(k => k.startsWith(key + ':pending:'))
      .flatMap(k => loadTextDrafts(k));
  } catch { return []; }
}

export function forgetPendingTextDraft(key: string, id: string): void {
  try { localStorage.removeItem(pendingDraftKey(key, id)); } catch { /* private mode */ }
}
