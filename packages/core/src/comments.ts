/**
 * OverLyX comment threads are stored *inside* the LyX document as `Note Comment` insets whose
 * paragraphs follow a small, human-readable convention:
 *
 *   Jan Bauer (2026-08-26 14:03):          <- thread header paragraph (author + timestamp)
 *   The comment text (one or more paragraphs)
 *   Kirsten (2026-08-27 09:10):             <- reply header
 *   Reply text
 *
 * A resolved thread has " [resolved]" appended to the first header. Reactions to a message follow
 * in parentheses (plain text in LyX, TeX and markdown alike), each one's key (an emoji, Yes, No or a
 * short word) and who reacted:
 *
 *   Kirsten (2026-08-27 09:10) (👍: Jan Bauer, Ada; Yes: Ada):
 *
 * LyX users see a normal
 * comment note; OverLyX users get threaded comment cards. Plain LyX comment notes (no header)
 * are shown as comment cards with an unknown author.
 */
import type { Paragraph } from './lyx/ast.ts';
import { itemText } from './lyx/ast.ts';

export interface CommentMessage { author: string; time: string; text: string }
export interface Reaction { key: string; who: string[] }
export interface CommentThread { messages: CommentMessage[]; resolved: boolean; isStructured: boolean }

// (several groups: two people reacting at once each inserted one — read as one)
const HEADER_RE = /^(.+?) \((\d{4}-\d{2}-\d{2} \d{2}:\d{2})\)( \[resolved\])?((?: \([^()]*:[^()]*\))*):\s*$/;
const clean = (s: string) => s.replace(/[()[\]{};:,\\\n]/g, ' ').replace(/\s+/g, ' ').trim();

export function formatTimestamp(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function commentHeader(author: string, time: string, resolved = false, reactions: Reaction[] = []): string {
  const r = reactions.map(x => ({ key: clean(x.key), who: x.who.map(clean).filter(Boolean) })).filter(x => x.key && x.who.length);
  return `${author} (${time})${resolved ? ' [resolved]' : ''}${r.length ? ` (${r.map(x => `${x.key}: ${x.who.join(', ')}`).join('; ')})` : ''}:`;
}

export function parseReactions(groups: string): Reaction[] {
  const out: Reaction[] = [];
  for (const g of groups.match(/\([^()]*\)/g) ?? []) {
    for (const entry of g.slice(1, -1).split(';')) {
      const i = entry.indexOf(':');
      if (i < 0) continue;
      const key = entry.slice(0, i).trim(), who = entry.slice(i + 1).split(',').map(s => s.trim()).filter(Boolean);
      if (!key || !who.length) continue;
      const had = out.find(r => r.key === key);
      if (had) for (const w of who) { if (!had.who.includes(w)) had.who.push(w); }
      else out.push({ key, who: [...new Set(who)] });
    }
  }
  return out;
}

export function parseHeader(line: string): { author: string; time: string; resolved: boolean; reactions: Reaction[] } | null {
  const m = HEADER_RE.exec(line);
  return m ? { author: m[1], time: m[2], resolved: !!m[3], reactions: m[4] ? parseReactions(m[4]) : [] } : null;
}

/** Parse the paragraphs of a Note Comment inset into a thread (plain text only). */
export function parseThread(paragraphs: Paragraph[]): CommentThread {
  const lines = paragraphs.map(p => p.items.map(itemText).join(''));
  const messages: CommentMessage[] = [];
  let resolved = false;
  let cur: CommentMessage | null = null;
  let structured = false;
  for (const l of lines) {
    const h = parseHeader(l.trim());
    if (h) {
      if (!messages.length && h.resolved) resolved = true;
      cur = { author: h.author, time: h.time, text: '' };
      messages.push(cur);
      structured = true;
    } else if (cur) {
      cur.text += (cur.text ? '\n' : '') + l;
    } else {
      cur = { author: '', time: '', text: l };
      messages.push(cur);
    }
  }
  return { messages, resolved, isStructured: structured };
}
