/**
 * The offline merge (packages/core/src/lyx/merge3.ts): edits of different words merge without a
 * trace, edits of the same words become a conflict — the live text, with the offline author's
 * version over it as tracked changes (Reject all = live, Accept all = offline).
 */
import { describe, it, expect } from 'vitest';
import { parseTex, writeTex } from '../packages/core/src/tex/index.ts';
import { merge3, reviewBody, adoptReview } from '../packages/core/src/lyx/merge3.ts';
import { resolveChanges } from '../packages/core/src/lyx/trackdiff.ts';
import { lyxAuthorId, addAuthor, type LyxDocument, type Paragraph } from '../packages/core/src/lyx/ast.ts';

const REVIEWER = 'Ada (offline)';
const as = { author: lyxAuthorId(REVIEWER, ''), time: 1790000000 };
const pre = '\\documentclass{article}\n\\begin{document}\n';
const post = '\n\\end{document}\n';

const parse = (body: string): LyxDocument => {
  const doc = parseTex(pre + body + post).doc;
  addAuthor(doc.header, as.author, REVIEWER, '');
  return doc;
};
const tex = (doc: LyxDocument, pars: Paragraph[]): string => {
  const t = writeTex({ ...doc, body: pars }).text;
  return t.slice(t.indexOf('\\begin{document}') + '\\begin{document}'.length, t.indexOf('\\end{document}')).trim();
};

function merge(base: string, live: string, offline: string) {
  const b = parse(base), l = parse(live), o = parse(offline);
  const m = merge3(b.body, l.body, o.body);
  const review = reviewBody(m, as);
  return { m, doc: b, review, live: tex(b, m.live), offline: tex(b, m.offline), accepted: tex(b, resolveChanges(review, true)), rejected: tex(b, resolveChanges(review, false)) };
}

const BASE = 'The first sentence is here. The second sentence follows it.\n\nAnother paragraph stays.';

describe('merge3: different words merge, the same words conflict', () => {
  it('edits of different sentences of one paragraph merge cleanly', () => {
    const r = merge(BASE,
      'The first sentence is right here. The second sentence follows it.\n\nAnother paragraph stays.',
      'The first sentence is here. The second sentence follows it closely.\n\nAnother paragraph stays.');
    expect(r.m.conflicts).toBe(0);
    expect(r.live).toBe('The first sentence is right here. The second sentence follows it closely.\n\nAnother paragraph stays.');
    expect(r.offline).toBe(r.live);
  });

  it('the same word changed differently is a conflict the review shows', () => {
    const r = merge(BASE,
      'The first sentence is there. The second sentence follows it.\n\nAnother paragraph stays.',
      'The first sentence is everywhere. The second sentence follows it.\n\nAnother paragraph stays.');
    expect(r.m.conflicts).toBe(1);
    expect(r.live).toContain('is there.');
    expect(r.offline).toContain('is everywhere.');
    // Reject keeps the live text, Accept takes the offline author's
    expect(r.rejected).toBe(r.live);
    expect(r.accepted).toBe(r.offline);
    expect(tex(r.doc, r.review)).toMatch(/\\lyxdeleted\{[^}]*\}\{[^}]*\}\{there/);
  });

  it('a conflict and a clean edit in the same paragraph: only the conflict is marked', () => {
    const r = merge(BASE,
      'The first sentence is there. The second sentence follows it.\n\nAnother paragraph stays.',
      'The first sentence is everywhere. The second sentence follows it closely.\n\nAnother paragraph stays.');
    expect(r.m.conflicts).toBe(1);
    expect(r.rejected).toBe('The first sentence is there. The second sentence follows it closely.\n\nAnother paragraph stays.');
    expect(r.accepted).toBe('The first sentence is everywhere. The second sentence follows it closely.\n\nAnother paragraph stays.');
  });

  it('a paragraph split offline and edited online merges', () => {
    const r = merge(BASE,
      'The very first sentence is here. The second sentence follows it.\n\nAnother paragraph stays.',
      'The first sentence is here.\n\nThe second sentence follows it.\n\nAnother paragraph stays.');
    expect(r.m.conflicts).toBe(0);
    expect(r.live).toBe('The very first sentence is here.\n\nThe second sentence follows it.\n\nAnother paragraph stays.');
  });

  it('both changing the same words alike is no conflict', () => {
    const same = 'The first sentence is gone. The second sentence follows it.\n\nAnother paragraph stays.';
    const r = merge(BASE, same, same);
    expect(r.m.conflicts).toBe(0);
    expect(r.live).toBe(same);
  });

  it('a footnote both changed is merged inside', () => {
    const base = 'Text\\footnote{One two three. Four five six.} after.';
    const r = merge(base, 'Text\\footnote{One TWO three. Four five six.} after.', 'Text\\footnote{One two three. Four five SIX.} after.');
    expect(r.m.conflicts).toBe(0);
    expect(r.live).toBe('Text\\footnote{One TWO three. Four five SIX.} after.');
  });

  it('adoptReview puts the conflicts into the live document and keeps everything else', () => {
    const b = parse(BASE);
    const live = parse('The first sentence is there. The second sentence follows it.\n\nAnother paragraph stays.');
    const offline = parse('The first sentence is everywhere. The second sentence follows it.\n\nAnother paragraph stays.');
    const review = reviewBody(merge3(b.body, live.body, offline.body), as);
    // the CRDT's interleaving, and somebody typed into the last paragraph meanwhile
    const now = parse('The first sentence is therewhere. The second sentence follows it.\n\nAnother paragraph stays put.');
    const out = adoptReview(live.body, now.body, review, as);
    expect(tex(b, resolveChanges(out, false))).toBe('The first sentence is there. The second sentence follows it.\n\nAnother paragraph stays put.');
    expect(tex(b, resolveChanges(out, true))).toBe('The first sentence is everywhere. The second sentence follows it.\n\nAnother paragraph stays put.');
  });
});
