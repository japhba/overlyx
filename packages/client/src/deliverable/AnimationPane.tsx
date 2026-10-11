/**
 * The Animation pane beside a deck's canvas: PowerPoint's animation pane over beamer's overlays.
 * It lists what appears (▸, blue) and disappears (◂, red) on each step of the slide being worked
 * on, as the runtime reports it (runtime/animate.ts `sequence`), and sends it commands (`steps`):
 * the selection made to appear / disappear on the next clicks in the order its objects were clicked
 * (or all on one click), click-in-order mode, an event a notch earlier or later, removed.
 * Step 1 is the slide as it comes up; step n comes with the (n−1)th click.
 */
import { useEffect, useState } from 'preact/hooks';
import type { Path, SelItem, StepCmd, StepKind, StepRow } from './protocol';

export interface Sequence { slide: number; rows: StepRow[]; steps: number; ordering: StepKind | null }

interface Props {
  seq: Sequence;
  sel: SelItem[];
  readOnly: boolean;
  send(cmd: StepCmd): void;
  select(path: Path): void;
  close(): void;
}

export function AnimationPane({ seq, sel, readOnly, send, select, close }: Props) {
  const [together, setTogether] = useState(false);
  const [orderKind, setOrderKind] = useState<StepKind>('appear');
  const ordering = seq.ordering;
  // Escape here (the pane has the keyboard) ends click-in-order mode as it does on the canvas
  useEffect(() => {
    if (!ordering) return;
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); send({ how: 'order', kind: null }); } };
    addEventListener('keydown', k, true);
    return () => removeEventListener('keydown', k, true);
  }, [ordering]);
  const onSlide = sel.filter(s => s.slide === seq.slide || seq.slide < 0);
  const animated = new Set(seq.rows.filter(r => r.selected).map(r => JSON.stringify(r.path)));
  const list = sel.length === 1 ? sel[0].list : undefined;
  const steps = new Map<number, StepRow[]>();
  for (const r of seq.rows) { const g = steps.get(r.step); if (g) g.push(r); else steps.set(r.step, [r]); }
  const add = (kind: StepKind) => send({ how: 'add', kind, together: together && onSlide.length > 1 });

  return (
    <div class="dl-anim" data-dl-anim>
      <div class="dl-anim-head">
        <span>Animation{seq.slide >= 0 ? ` · slide ${seq.slide + 1}` : ''}</span>
        <button class="dl-btn" onClick={close} title="Close">×</button>
      </div>
      {!readOnly && (
        <div class="dl-anim-tools">
          <div class="dl-anim-add">
            <button class="dl-btn" data-anim-add="appear" disabled={!onSlide.length || !!ordering} onClick={() => add('appear')}
              title="The selected objects appear on the next clicks, in the order you selected them (Shift+click to add)">▸ Appear</button>
            <button class="dl-btn" data-anim-add="disappear" disabled={!onSlide.length || !!ordering} onClick={() => add('disappear')}
              title="The selected objects disappear on the next clicks, in the order you selected them">◂ Disappear</button>
          </div>
          {onSlide.length > 1 && !ordering && (
            <label class="dl-anim-check"><input type="checkbox" checked={together} onChange={e => setTogether((e.target as HTMLInputElement).checked)} data-anim-together />
              All {onSlide.length} on one click (else one click each, in the order selected)</label>
          )}
          {list && !ordering && (
            <label class="dl-anim-check"><input type="checkbox" checked={!!list.steps} data-anim-list
              onChange={e => send({ how: 'list', path: list.path, on: (e.target as HTMLInputElement).checked })} /> List items one by one</label>
          )}
          {ordering ? (
            <div class="dl-anim-ordering" data-anim-ordering>
              <div class="dl-anim-hint">
                Click the objects in the order they should {ordering === 'appear' ? 'appear' : 'disappear'}.<br />
                <kbd>Shift</kbd>+click: on the same click as the one before · <kbd>Ctrl</kbd>/<kbd>⌘</kbd>+click: a part of a drawing (a path of an SVG).
              </div>
              <button class="dl-btn on" data-anim-order-done onClick={() => send({ how: 'order', kind: null })}>Done (Esc)</button>
            </div>
          ) : (
            <div class="dl-anim-order">
              <button class="dl-btn" data-anim-order onClick={() => send({ how: 'order', kind: orderKind })}
                title="Then click objects one after the other: each comes on the next click">Click objects in order…</button>
              <select value={orderKind} onChange={e => setOrderKind((e.target as HTMLSelectElement).value as StepKind)} title="What the objects clicked do" data-anim-order-kind>
                <option value="appear">to appear</option>
                <option value="disappear">to disappear</option>
              </select>
            </div>
          )}
        </div>
      )}
      <div class="dl-anim-list" data-anim-list-rows>
        {!seq.rows.length && <div class="dl-anim-empty">Everything on this slide shows from the start. Select objects and choose Appear, or click them in order.</div>}
        {[...steps].map(([step, rows]) => (
          <div class="dl-anim-step" key={step} data-anim-step={step}>
            <div class="dl-anim-stephead">Step {step} <span>· click {step - 1}</span></div>
            {rows.map(r => (
              <div class={'dl-anim-row ' + r.kind + (r.selected ? ' sel' : '')} key={`${r.path.join('.')}:${r.step}`} data-anim-row={r.kind}>
                <span class="dl-anim-kind" title={r.kind === 'appear' ? 'Appears' : 'Disappears'}>{r.kind === 'appear' ? '▸' : '◂'}</span>
                <button class="dl-anim-label" onClick={() => select(r.path)} title={`${r.kind === 'appear' ? 'Appears' : 'Disappears'} at step ${r.step} — click to select it`}>{r.label}</button>
                {!readOnly && <>
                  <button class="dl-anim-btn" disabled={!r.up} onClick={() => send({ how: 'move', path: r.path, step: r.step, dir: -1 })} title="Earlier (with the step before, then before it)" data-anim-up>↑</button>
                  <button class="dl-anim-btn" disabled={!r.down} onClick={() => send({ how: 'move', path: r.path, step: r.step, dir: 1 })} title="Later (with the step after, then after it)" data-anim-down>↓</button>
                  <button class="dl-anim-btn" onClick={() => send({ how: 'remove', path: r.path, step: r.step })} title={r.kind === 'appear' ? 'Shown from the start instead' : 'Stays instead'} data-anim-remove>×</button>
                </>}
              </div>
            ))}
          </div>
        ))}
      </div>
      {!readOnly && !ordering && sel.some(s => animated.has(JSON.stringify(s.path)) || s.list?.steps) && (
        <button class="dl-btn dl-anim-clear" onClick={() => send({ how: 'clear' })} data-anim-clear>Selection: no animation</button>
      )}
    </div>
  );
}
