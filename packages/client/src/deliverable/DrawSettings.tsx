/**
 * Draw's eraser and lasso settings, as GoodNotes has them (the active button clicked again), shared by
 * slides, whiteboards and documents' margins and kept in this browser with the pens (deckink.ts):
 *
 * - the eraser: whole strokes or only the part of a stroke under it (precise), its size, the
 *   highlighter's strokes alone (the writing under them kept), back to the pen after erasing;
 * - the lasso: what it takes (handwriting, shapes, pictures, text — the kinds the surface has), and of
 *   which colours: the colours used where it is, picked as a filter for this visit (none: any colour).
 */
import type { EraserSet, LassoKind } from './deckink';
import { ERASER_PX } from './deckink';
import { inkColorName } from '../editor/plugins/ink';

const SIZES: { size: 0 | 1 | 2; label: string }[] = [{ size: 0, label: 'Small' }, { size: 1, label: 'Medium' }, { size: 2, label: 'Large' }];
const pd = (e: Event) => e.preventDefault();

export function EraserSettings({ eraser, onChange }: { eraser: EraserSet; onChange: (p: Partial<EraserSet>) => void }) {
  return (
    <div class="ink-pick pen-set" data-eraser-settings>
      <div class="pen-set-kind" role="radiogroup" aria-label="Eraser">
        {([['stroke', 'Whole strokes', false], ['precise', 'Precise', true]] as const).map(([k, label, precise]) => (
          <button key={k} type="button" role="radio" aria-checked={eraser.precise === precise} class={'pen-set-k' + (eraser.precise === precise ? ' active' : '')} data-eraser-mode={k}
            title={precise ? 'Rubs out only the part of a stroke under it; what is left either side stays' : 'Takes a stroke it touches, all of it'}
            onMouseDown={pd} onClick={() => onChange({ precise })}>{label}</button>
        ))}
      </div>
      <div class="ink-pick-title">Size</div>
      <div class="eraser-sizes" role="radiogroup" aria-label="Eraser size">
        {SIZES.map(s => (
          <button key={s.size} type="button" role="radio" aria-checked={eraser.size === s.size} class={'eraser-size' + (eraser.size === s.size ? ' active' : '')} data-eraser-size={s.size} title={s.label}
            onMouseDown={pd} onClick={() => onChange({ size: s.size })}>
            <span style={`width:${ERASER_PX[s.size] * 1.2 + 4}px;height:${ERASER_PX[s.size] * 1.2 + 4}px`} />
          </button>
        ))}
      </div>
      <label class="pen-set-check" title="Only the highlighter's strokes are erased: the writing under them stays">
        <input type="checkbox" checked={eraser.hlOnly} data-eraser-hl onChange={e => onChange({ hlOnly: (e.target as HTMLInputElement).checked })} /> Highlighter only
      </label>
      <label class="pen-set-check" title="After erasing, the pen is back in hand (GoodNotes' auto-deselect)">
        <input type="checkbox" checked={eraser.back} data-eraser-back onChange={e => onChange({ back: (e.target as HTMLInputElement).checked })} /> Back to the pen after erasing
      </label>
      <div class="pen-set-note">The pen's other end erases too, whichever tool is in hand.</div>
    </div>
  );
}

const KIND_LABELS: Record<LassoKind, string> = { ink: 'Handwriting', shapes: 'Shapes', pictures: 'Pictures', text: 'Text' };

/**
 * `kinds`: what this surface's lasso can take; `colors`: the colours used on it now; `picked`: the
 * colour filter (none: any colour).
 */
export function LassoSettings({ kinds, value, onChange, colors, picked, onPick, textLabel }: {
  kinds: LassoKind[]; value: LassoKind[]; onChange: (kinds: LassoKind[]) => void;
  colors: string[]; picked: string[]; onPick: (colors: string[]) => void;
  /** what "text" is called here (a whiteboard's sticky notes) */
  textLabel?: string;
}) {
  const on = kinds.filter(k => value.includes(k));
  const all = on.length === kinds.length;
  const toggle = (k: LassoKind) => {
    const next = on.includes(k) ? on.filter(x => x !== k) : [...on, k];
    if (next.length) onChange(next);
  };
  const shown = [...new Set([...picked, ...colors])];
  return (
    <div class="ink-pick pen-set lasso-set" data-lasso-settings>
      <div class="ink-pick-title">The lasso takes</div>
      <div class="lasso-kinds">
        <button type="button" class={'lasso-kind' + (all ? ' active' : '')} aria-pressed={all} data-lasso-kind="all" title="Everything it goes round or touches"
          onMouseDown={pd} onClick={() => onChange([...kinds])}>Everything</button>
        {kinds.map(k => (
          <button key={k} type="button" class={'lasso-kind' + (on.includes(k) && !all ? ' active' : '')} aria-pressed={on.includes(k)} data-lasso-kind={k}
            title={all ? `Only ${(k === 'text' && textLabel ? textLabel : KIND_LABELS[k]).toLowerCase()}` : on.includes(k) ? `Not ${(k === 'text' && textLabel ? textLabel : KIND_LABELS[k]).toLowerCase()}` : `${k === 'text' && textLabel ? textLabel : KIND_LABELS[k]} too`}
            onMouseDown={pd} onClick={() => (all ? onChange([k]) : toggle(k))}>{k === 'text' && textLabel ? textLabel : KIND_LABELS[k]}</button>
        ))}
      </div>
      <div class="ink-pick-title">Of the colours</div>
      {shown.length ? (
        <div class="lasso-colors">
          <button type="button" class={'lasso-kind' + (picked.length ? '' : ' active')} aria-pressed={!picked.length} data-lasso-color="any" title="Whatever its colour" onMouseDown={pd} onClick={() => onPick([])}>Any</button>
          {shown.map(c => (
            <button key={c} type="button" class={'ink-pick-sw' + (picked.includes(c) ? ' active' : '')} aria-pressed={picked.includes(c)} data-lasso-color={c} style={`background:${c}`}
              title={`${inkColorName(c)}${picked.includes(c) ? ' — taken (click: no longer)' : ' — only things of this colour (more than one: any of them)'}`}
              onMouseDown={pd} onClick={() => onPick(picked.includes(c) ? picked.filter(x => x !== c) : [...picked, c])} />
          ))}
        </div>
      ) : <div class="pen-set-note">Nothing here has a colour yet.</div>}
      <div class="pen-set-note">A loop round things selects them: whatever it touches of handwriting, the rest when most of it is inside.</div>
    </div>
  );
}
