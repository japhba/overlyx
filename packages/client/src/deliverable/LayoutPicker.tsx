/**
 * The layouts a slide can take, as Google Slides' New slide ▾ and Apply layout show them: a card per
 * layout, drawn small (decklayouts.ts layoutThumb) — the deck's own layouts first (Save as layout;
 * each can be removed), then those made of its design —, and below them what else a new slide can be
 * (like this slide, blank, like another of its slides).
 */
import type { ComponentChildren } from 'preact';

export interface LayoutCard { id: string; name: string; thumb: string; saved?: boolean }
export interface LayoutExtra { label: string; action: () => void; shortcut?: string }

export function LayoutPicker({ cards, pick, remove, extras = [], close, aspect }: {
  cards: LayoutCard[]; pick: (id: string) => void; remove?: (id: string) => void;
  extras?: LayoutExtra[]; close: () => void; aspect: number;
}) {
  const card = (c: LayoutCard): ComponentChildren => (
    <div key={c.id} class={'dl-layout-card' + (c.saved ? ' saved' : '')}>
      <button type="button" class="dl-layout-pick" data-dl-layout={c.id} title={c.name} onMouseDown={e => e.preventDefault()} onClick={() => { close(); pick(c.id); }}>
        <span class="dl-layout-thumb" style={{ aspectRatio: String(aspect) }} dangerouslySetInnerHTML={{ __html: c.thumb }} />
        <span class="dl-layout-name">{c.name}</span>
      </button>
      {c.saved && remove && (
        <button type="button" class="dl-layout-remove" title={`Remove the layout “${c.name}” from the deck (Undo brings it back)`} aria-label={`Remove the layout ${c.name}`}
          onMouseDown={e => e.preventDefault()} onClick={() => { close(); remove(c.id); }}>×</button>
      )}
    </div>
  );
  const saved = cards.filter(c => c.saved), built = cards.filter(c => !c.saved);
  return (
    <div class="dl-layouts" data-dl-layouts>
      {saved.length > 0 && <>
        <div class="dl-layouts-head">This deck’s layouts</div>
        <div class="dl-layouts-grid">{saved.map(card)}</div>
        <div class="dl-layouts-head">From its design</div>
      </>}
      <div class="dl-layouts-grid">{built.map(card)}</div>
      {extras.length > 0 && (
        <div class="dl-layouts-extra">
          {extras.map((x, i) => (
            <button key={i} type="button" class="tb-pal-item" onMouseDown={e => e.preventDefault()} onClick={() => { close(); x.action(); }}>
              <span class="tb-pal-label">{x.label}</span>{x.shortcut && <span class="dl-layouts-key">{x.shortcut}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
