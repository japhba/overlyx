/**
 * Check, in people's words: what the runtime's report (runtime/report.ts — the one agents get from
 * render_page) found on the slides, said as what is wrong and what would fix it. Sizes as the
 * toolbar shows them (points, units.ts), never CSS px; no element names.
 */
import type { DeliverableKind, PageIssue, PageReport, Path } from './protocol';
import { sizePt } from './units';

export interface CheckEntry {
  kind: PageIssue['kind'];
  slide: number;
  /** the object a click selects (none: the slide alone is shown) */
  path?: Path;
  /** what is wrong */
  say: string;
  /** what would fix it */
  fix: string;
  /** "It is meant": the overlap (or the cut at the edge) is on purpose — the object gets this word in `data-ol-lint` and is not reported for it again */
  lint?: Lint;
}
/** the words of `data-ol-lint` the Check honours: overlap on purpose, running off the edge on purpose */
export type Lint = 'no-overlap' | 'no-edge';
export interface CheckGroup { slide: number; title: string; entries: CheckEntry[] }

const short = (t: string, n = 36) => (t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t);
/** an object by its words, else by what it is */
function called(i: PageIssue, cap = true): string {
  if (i.name) return `“${short(i.name)}”`;
  const w = i.what === 'picture' ? 'a picture' : i.what === 'text' ? 'a text' : 'an object';
  return cap ? w[0].toUpperCase() + w.slice(1) : w;
}
/** the agents' label of the other object ("words" or <tag.class>), for people */
const other = (label: unknown): string => typeof label === 'string' && label.startsWith('"') ? `“${short(label.slice(1, -1))}”` : 'another object';
const num = (v: unknown): number => (typeof v === 'number' && isFinite(v) ? v : 0);
const SIDE: Record<string, string> = { left: 'left', top: 'top', right: 'right', bottom: 'bottom' };
function sides(v: unknown): string {
  const s = String(v ?? '').split(/\s+/).map(x => SIDE[x]).filter(Boolean);
  return s.length > 1 ? `${s.slice(0, -1).join(', ')} and ${s[s.length - 1]}` : s[0] ?? '';
}

/** one issue of the report as people read it */
export function sayIssue(i: PageIssue, kind: DeliverableKind): { say: string; fix: string; lint?: Lint } {
  const page = kind === 'poster' ? 'poster' : kind === 'page' ? 'page' : 'slide';
  const n = i.n ?? {};
  switch (i.kind) {
    case 'overflow':
      return n.cut
        ? { say: `${called(i)} does not fit its box: the end is cut off.`, fix: 'Make the box bigger or the text smaller, or shorten the text.' }
        : { say: `${called(i)} runs out of its box.`, fix: 'Make the box bigger or the text smaller, or shorten the text.' };
    case 'wrap':
      return { say: `${called(i)} now takes ${num(n.lines)} lines${num(n.was) ? ` (${num(n.was)} when its box was sized)` : ''}.`, fix: 'Make its box wider or shorten the text.' };
    case 'offpage':
      return { say: `${called(i)} runs off the ${page}${sides(n.sides) ? ` at the ${sides(n.sides)}` : ''}.`, fix: `Move it back onto the ${page}, or make it narrower or its text smaller.` };
    case 'off-slide':
      return n.all
        ? { say: `${called(i)} lies outside the ${page}: it does not show.`, fix: `Move it onto the ${page}, or delete it.` }
        : { say: `${called(i)} is cut off at the ${page}’s ${sides(n.sides) || 'edge'}${num(n.cut) ? ` (about ${num(n.cut)} % of it)` : ''}.`, fix: `Move it back onto the ${page} or make it smaller — unless it is meant to run off the edge.`, lint: 'no-edge' };
    case 'overlap':
      return n.covers
        ? { say: `${called(i)} covers part of ${other(n.other)}.`, fix: 'Move one of them, or send the picture behind the text (Arrange).', lint: 'no-overlap' }
        : { say: `${called(i)} and ${other(n.other)} lie on top of each other.`, fix: 'Move one of them or make its box smaller.', lint: 'no-overlap' };
    case 'small-text': {
      const want = sizePt(num(n.min));
      if (kind === 'poster') {
        return n.assumed
          ? { say: `${called(i)} is too small to read on the printed poster: about ${num(n.pt)} pt when it is printed as an A0.`, fix: `Use ${want} pt or more here (${num(n.minPt)} pt in print reads from a metre or two away).` }
          : { say: `${called(i)} is ${num(n.pt)} pt in print — too small to read from a metre or two away.`, fix: `Use ${num(n.minPt)} pt or more; 24 pt and up for running text.` };
      }
      return kind === 'deck'
        ? { say: `${called(i)} is ${sizePt(num(n.px))} pt — too small to read from the back of a room.`, fix: `Use ${want} pt or more on this slide.` }
        : { say: `${called(i)} is ${sizePt(num(n.px))} pt — small for a screen.`, fix: `Use ${want} pt or more.` };
    }
    case 'contrast':
      return { say: `${called(i)} is hard to tell from what is behind it (contrast ${num(n.ratio)} to 1).`, fix: `Make the text darker or lighter, or change the colour behind it — ${num(n.need) || 3} to 1 or more reads well.` };
    case 'low-res':
      return { say: `${called(i)} has too few pixels for its size in print: ${num(n.w)} across ${num(n.cm)} cm${n.assumed ? ' (as an A0)' : ''} — it will look blurred.`, fix: `Use a picture at least ${num(n.need)} pixels wide, or show it smaller.` };
    case 'image':
      return { say: `A picture did not load${n.src ? ` (${short(String(n.src), 40)})` : ''}.`, fix: 'Replace it (right-click ▸ Replace picture) or delete it.' };
    case 'math':
      return n.raw
        ? { say: `A formula is shown as it was typed: ${short(String(n.raw), 40)}`, fix: 'Open it and check its braces and that it is closed.' }
        : { say: `A formula could not be shown${n.why ? `: ${short(String(n.why), 60)}` : '.'}`, fix: 'Open the formula and correct it.' };
    case 'citation':
      return { say: `A citation’s source is missing${n.key ? `: ${String(n.key)}` : '.'}`, fix: 'Add the source to the project’s references, or cite another.' };
    case 'reference':
      return { say: `A cross-reference points to no equation${n.ref ? `: ${String(n.ref)}` : '.'}`, fix: 'Give the equation that label, or refer to another.' };
  }
  return { say: i.text, fix: '' };
}

/** the report as the pane lists it: the slides that have something, in order */
export function checkGroups(pages: PageReport[], kind: DeliverableKind): CheckGroup[] {
  const out: CheckGroup[] = [];
  for (const p of pages) {
    if (!p.issues.length) continue;
    const seen = new Set<string>();
    const entries: CheckEntry[] = [];
    // (text running off the slide also runs out of its box: said once, as running off the slide)
    const offEdge = new Set(p.issues.filter(i => i.kind === 'offpage' && i.path).map(i => i.path!.join('.')));
    for (const i of p.issues) {
      if (i.kind === 'overflow' && !i.n?.cut && i.path && offEdge.has(i.path.join('.'))) continue;
      const s = sayIssue(i, kind);
      // (the same thing said twice of one object: once)
      const key = `${i.kind}|${i.path?.join('.') ?? ''}|${s.say}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ kind: i.kind, slide: p.index, ...(i.path ? { path: i.path } : {}), say: s.say, fix: s.fix, ...(s.lint && i.path ? { lint: s.lint } : {}) });
    }
    out.push({ slide: p.index, title: p.title.replace(/\\[()[\]]/g, '').replace(/\s+/g, ' ').trim(), entries });
  }
  return out;
}

/** what the Check button says of the count */
export const checkCount = (groups: CheckGroup[]): number => groups.reduce((a, g) => a + g.entries.length, 0);

/** the section a kind of issue is listed under, for the pane's little label */
export const CHECK_LABEL: Record<PageIssue['kind'], string> = {
  overflow: 'Text does not fit', wrap: 'Text wraps', offpage: 'Off the edge', 'off-slide': 'Off the edge', overlap: 'Overlap', 'small-text': 'Small text',
  contrast: 'Low contrast', 'low-res': 'Blurred in print', image: 'Missing picture', math: 'Formula', citation: 'Citation', reference: 'Cross-reference',
};

/** `data-ol-lint` with one more word (the words it had kept) */
export const withLint = (was: string | null, word: Lint): string => [...new Set([...(was ?? '').split(/\s+/).filter(Boolean), word])].join(' ');
