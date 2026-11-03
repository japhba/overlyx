// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { applyOp } from '../packages/core/src/html/source.ts';
import { DEFAULT_GROUP_LAYOUT, groupLayoutOf, laidOutGroup } from '../packages/client/src/deliverable/grouplayout.ts';
import type { GroupLayout, HtmlOp, Rect } from '../packages/client/src/deliverable/protocol.ts';

const canvas = vi.hoisted(() => ({ selected: [] as Element[], commit: vi.fn() }));
vi.mock('../packages/client/src/deliverable/runtime/edit', () => ({
  selection: () => canvas.selected, commit: canvas.commit, stopText: vi.fn(), report: vi.fn(), setSelection: vi.fn(),
  cs: (el: Element) => getComputedStyle(el),
  isLocked: (el: Element) => el.hasAttribute('data-ol-locked'), isSvgPart: () => false,
  kindOf: () => 'group',
  fixedHeight: (el: Element) => !!(el as HTMLElement).style.height && (el as HTMLElement).style.height !== 'auto',
  containerOf: (el: Element) => el.parentElement,
  slidePoint: (el: Element, x: number, y: number) => { const r = el.getBoundingClientRect(); return [x - r.x, y - r.y]; },
  union: (rs: Rect[]) => ({ x: Math.min(...rs.map(r => r.x)), y: Math.min(...rs.map(r => r.y)),
    w: Math.max(...rs.map(r => r.x + r.w)) - Math.min(...rs.map(r => r.x)),
    h: Math.max(...rs.map(r => r.y + r.h)) - Math.min(...rs.map(r => r.y)) }),
}));
vi.mock('../packages/client/src/deliverable/runtime/pathedit', () => ({ pathCommand: vi.fn() }));
import { arrange, setGroupLayout } from '../packages/client/src/deliverable/runtime/arrange.ts';
import { link, state } from '../packages/client/src/deliverable/runtime/env.ts';

const row: GroupLayout = { direction: 'row', gap: 18, align: 'center', equal: false };
function sourceGroup() {
  const doc = new DOMParser().parseFromString('<div class="ol-group" id="card" style="position:absolute;left:50px;top:80px;width:360px;height:120px;background:navy"><p id="title" style="position:absolute;left:12px;top:20px;width:140px">A <b>title</b></p><div id="panel" style="position:absolute;left:180px;top:10px;width:160px;height:80px"></div></div>', 'text/html');
  return doc.querySelector<HTMLElement>('#card')!;
}
function members(src: Element) {
  return [{ src: src.children[0], x: 12, y: 20, width: '140px', height: '40px', autoHeight: true },
    { src: src.children[1], x: 180, y: 10, width: '160px', height: '80px' }];
}
const size = { width: '360px', height: '120px' };

describe('persistent group layout', () => {
  it('uses native layout, keeps rich content and paint, and lets text height follow edits', () => {
    const src = sourceGroup(), before = src.outerHTML;
    const out = laidOutGroup(src, members(src), size, row) as HTMLElement;
    expect(src.outerHTML).toBe(before);
    expect(out.style.display).toBe('flex'); expect(out.style.flexDirection).toBe('row');
    expect(out.style.gap).toBe('18px'); expect(out.style.alignItems).toBe('center');
    expect(out.style.height).toBe('auto'); expect(out.style.background).toBe('navy');
    const title = out.children[0] as HTMLElement;
    expect(title.innerHTML).toBe('A <b>title</b>'); expect(title.style.height).toBe('auto');
    expect(title.style.position).toBe('relative'); expect(title.style.left).toBe('0px');
    expect((out.children[1] as HTMLElement).style.height).toBe('80px');
  });

  it('shares available width or height equally and allows cross-axis stretch', () => {
    const src = sourceGroup();
    const equalRow = laidOutGroup(src, members(src), size, { ...row, equal: true }) as HTMLElement;
    expect((equalRow.children[0] as HTMLElement).style.flex).toBe('1 1 0px');
    expect((equalRow.children[0] as HTMLElement).style.width).toBe('0px');
    const column = laidOutGroup(src, members(src), size, { ...row, direction: 'column', equal: true, align: 'stretch' }) as HTMLElement;
    expect(column.style.height).toBe('120px');
    expect((column.children[0] as HTMLElement).style.height).toBe('0px');
    expect((column.children[0] as HTMLElement).style.width).toBe('auto');
    const stretchedRow = laidOutGroup(src, members(src), size, { ...row, align: 'stretch' }) as HTMLElement;
    expect(stretchedRow.style.height).toBe('120px');
    expect((stretchedRow.children[1] as HTMLElement).style.height).toBe('auto');
  });

  it('freezes the measured positions when changing back to a free group', () => {
    const src = sourceGroup();
    const flow = laidOutGroup(src, members(src), size, row);
    const out = laidOutGroup(flow, members(flow), size, DEFAULT_GROUP_LAYOUT) as HTMLElement;
    expect(out.style.display).toBe('block'); expect(out.style.height).toBe('120px');
    expect(out.style.gap).toBe('');
    const title = out.children[0] as HTMLElement;
    expect(title.style.position).toBe('absolute'); expect(title.style.left).toBe('12px');
    expect(title.style.top).toBe('20px'); expect(title.style.flex).toBe('');
    expect(title.style.height).toBe('auto');
  });

  it('reports layout controls from the saved CSS', () => {
    const src = sourceGroup();
    const flow = laidOutGroup(src, members(src), size, { ...row, equal: true }) as HTMLElement;
    document.body.replaceChildren(flow);
    expect(groupLayoutOf(flow, getComputedStyle(flow))).toEqual({ ...row, equal: true });
    expect(groupLayoutOf(src, getComputedStyle(src))).toEqual(DEFAULT_GROUP_LAYOUT);
  });
});

/** The browser's measured boxes are the seam; arrangement and source operations are real. */
function setup(html: string, rects: Record<string, Rect>) {
  const text = `<html><head></head><body><section class="slide" id="slide">${html}</section></body></html>`;
  state.src = new DOMParser().parseFromString(text, 'text/html');
  document.body.innerHTML = state.src.body.innerHTML;
  for (const src of Array.from(state.src.body.querySelectorAll('*'))) {
    const live = document.getElementById(src.id)!;
    if (!live) continue;
    link(live, src);
    const r = rects[src.id] ?? { x: 0, y: 0, w: 1280, h: 720 };
    live.getBoundingClientRect = () => ({ x: r.x, y: r.y, left: r.x, top: r.y, width: r.w, height: r.h, right: r.x + r.w, bottom: r.y + r.h, toJSON: () => ({}) });
  }
  return text;
}
function committed(text: string): Document {
  expect(canvas.commit).toHaveBeenCalledTimes(1);
  const ops = canvas.commit.mock.calls[0][0] as HtmlOp[];
  // All operations address the same pre-edit source; apply from the last object backwards.
  for (const op of [...ops].reverse()) text = applyOp(text, op);
  return new DOMParser().parseFromString(text, 'text/html');
}
beforeEach(() => { canvas.selected = []; canvas.commit.mockClear(); });

describe('canvas group layout commands', () => {
  it('groups objects in visual order in one undo step', () => {
    const text = setup('<p id="later" style="position:absolute;left:220px;top:20px;width:100px">Later</p><p id="first" style="position:absolute;left:20px;top:20px;width:100px">First</p>', {
      later: { x: 220, y: 20, w: 100, h: 40 }, first: { x: 20, y: 20, w: 100, h: 40 },
    });
    canvas.selected = [document.getElementById('later')!, document.getElementById('first')!];
    arrange('group-row');
    const doc = committed(text), group = doc.querySelector<HTMLElement>('.ol-group')!;
    expect(group.style.display).toBe('flex'); expect(group.style.flexDirection).toBe('row');
    expect(group.style.width).toBe('224px');
    expect(Array.from(group.children).map(el => el.id)).toEqual(['first', 'later']);
    expect(doc.getElementById('later')!.parentElement).toBe(group);
    expect((doc.getElementById('first') as HTMLElement).style.height).toBe('auto');
  });

  it('changes an existing container layout and preserves its nested content', () => {
    const text = setup(sourceGroup().outerHTML, { card: { x: 50, y: 80, w: 360, h: 120 }, title: { x: 62, y: 100, w: 140, h: 40 }, panel: { x: 230, y: 90, w: 160, h: 80 } });
    canvas.selected = [document.getElementById('card')!];
    setGroupLayout({ ...row, direction: 'column', gap: 32 });
    const group = committed(text).querySelector<HTMLElement>('#card')!;
    expect(group.style.flexDirection).toBe('column'); expect(group.style.gap).toBe('32px');
    expect(group.querySelector('b')?.textContent).toBe('title');
  });

  it('ungroups flow items at their measured slide positions, including equal-size items', () => {
    const src = sourceGroup();
    const flow = laidOutGroup(src, members(src), size, { ...row, equal: true });
    const text = setup(flow.outerHTML, { card: { x: 50, y: 80, w: 360, h: 120 }, title: { x: 50, y: 100, w: 171, h: 40 }, panel: { x: 239, y: 80, w: 171, h: 80 } });
    canvas.selected = [document.getElementById('card')!];
    // CSS layout is supplied by the browser; jsdom only needs its resolved size here.
    (document.getElementById('title') as HTMLElement).style.width = '171px';
    (document.getElementById('panel') as HTMLElement).style.width = '171px';
    arrange('ungroup');
    const doc = committed(text), title = doc.getElementById('title') as HTMLElement;
    expect(doc.getElementById('card')).toBeNull();
    expect(title.style.position).toBe('absolute'); expect(title.style.left).toBe('50px');
    expect(title.style.top).toBe('100px'); expect(title.style.width).toBe('171px');
    expect(title.style.flex).toBe('');
  });

  it('leaves locked groups and invalid layout values unchanged', () => {
    setup(sourceGroup().outerHTML, {}); canvas.selected = [document.getElementById('card')!];
    setGroupLayout({ ...row, gap: NaN }); expect(canvas.commit).not.toHaveBeenCalled();
    canvas.selected[0].setAttribute('data-ol-locked', '');
    setGroupLayout(row); expect(canvas.commit).not.toHaveBeenCalled();
  });
});
