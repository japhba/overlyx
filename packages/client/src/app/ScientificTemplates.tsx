import { useEffect, useRef } from 'preact/hooks';
import { SCIENTIFIC_TEMPLATES, templateLabel, type ScientificKind } from '@overlyx/core/html/scientific.ts';
import { pageSizes, initialDeckSize, initialPosterSize, ratioLabel, sizeOf, sizeText, turned, type BlankKind, type DeckSizeChoice } from './decksize';

/** the design a dialog makes when none was picked: a deck starts blank, a poster with its first design */
export const chosenDesign = (kind: string, template?: string): string | undefined => template ?? (kind === 'deck' ? 'blank' : undefined);

/**
 * Shared by + New and File > New: the design and its actual page proportions are visible. A deck or
 * a poster can also start blank — then `size` is asked for too (a deck's: this screen's, a common slide
 * or paper size; a poster's: the board's, A0 … 36 × 24 in — the designs come only in the size they
 * were made in).
 */
export function ScientificTemplates({ kind, value, onChange, size = kind === 'poster' ? initialPosterSize() : initialDeckSize(), onSize }: { kind: ScientificKind; value?: string; onChange: (id: string) => void; size?: DeckSizeChoice; onSize?: (c: DeckSizeChoice) => void }) {
  const templates = SCIENTIFIC_TEMPLATES.filter(t => t.kind === kind);
  const blank = chosenDesign(kind, value) === 'blank';
  const selected = templates.find(t => t.id === value) ?? templates[0];
  const page = sizeOf(size, kind), k = Math.min(84 / page.width, 72 / page.height);
  const preset = pageSizes(kind).find(s => s.id === size.id);
  // (a poster's designs fill the dialog: its sizes, under them, come into view when Blank is chosen)
  const sizesRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (blank && kind === 'poster') sizesRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }, [blank, kind]);
  return <fieldset class="ol-scientific-templates">
    <legend>Style</legend>
    <div class={'ol-template-grid' + (kind === 'deck' ? ' four' : '')} role="radiogroup" aria-label={`${kind === 'poster' ? 'Poster' : 'Slide'} style`}>
      <button type="button" role="radio" aria-checked={blank} class={'ol-template-card' + (blank ? ' active' : '')} data-template="blank" onClick={() => onChange('blank')}>
        <span class="ol-template-preview"><span class="ol-blank-page" style={{ width: `${page.width * k}px`, height: `${page.height * k}px` }} /></span>
        <strong>Blank</strong>
        <small>{kind === 'poster' ? 'A0, A1, 48 × 36 in … · empty' : `${!preset || preset.id === 'device' ? ratioLabel(page) : preset.label} · empty`}</small>
      </button>
      {templates.map(t => <button key={t.id} type="button" role="radio" aria-checked={!blank && selected.id === t.id}
        class={'ol-template-card' + (!blank && selected.id === t.id ? ' active' : '')} data-template={t.id} onClick={() => onChange(t.id)}>
        <span class="ol-template-preview"><img src={`/templates/${t.id}.png`} alt="" loading="lazy" /></span>
        <strong>{templateLabel(t)}</strong>
        <small>{t.size}</small>
      </button>)}
    </div>
    {blank ? <>
      <p class="dialog-hint">{kind === 'poster'
        ? 'An empty poster in the size your board takes — lay it out yourself, or ask your agent to design it. It prints at exactly this size.'
        : 'Empty pages to write, draw or build on, as in GoodNotes or Keynote’s blank theme — nothing to delete first.'}</p>
      <div ref={sizesRef}>{onSize && <PageSizePicker value={size} onChange={onSize} kind={kind} />}</div>
    </> : <>
      <p class="dialog-hint">{selected.description}</p>
      {/* the source design's name and authors stay with it (its license asks for the attribution); a layout with no public page says where it comes from */}
      <p class="dialog-hint">{selected.source.startsWith('/') ? <>{selected.author} · {selected.license}.</>
        : <>Editable adaptation of <a href={selected.source} target="_blank" rel="noopener noreferrer">{selected.name}</a> by {selected.author} · {selected.license}.</>}</p>
    </>}
  </fieldset>;
}

/** A blank deck's page size: this screen's first, then the common slide and paper sizes; a blank poster's: the boards'; landscape or portrait. */
export function PageSizePicker({ value, onChange, kind = 'deck' }: { value: DeckSizeChoice; onChange: (c: DeckSizeChoice) => void; kind?: BlankKind }) {
  const sizes = pageSizes(kind);
  const sel = sizes.find(s => s.id === value.id) ?? sizes[0];
  return <fieldset class="ol-page-sizes">
    <legend>Page size</legend>
    <div class="ol-size-grid" role="radiogroup" aria-label="Page size">
      {sizes.map(s => {
        const p = turned(s, value.portrait), k = 30 / Math.max(p.width, p.height), on = s.id === sel.id;
        return <button key={s.id} type="button" role="radio" aria-checked={on} class={'ol-size-card' + (on ? ' active' : '')} data-deck-size={s.id} title={s.hint} onClick={() => onChange({ ...value, id: s.id })}>
          <span class="ol-size-thumb"><span style={{ width: `${p.width * k}px`, height: `${p.height * k}px` }} /></span>
          <strong>{s.label}</strong>
          <small>{s.id === 'device' ? ratioLabel(p) : sizeText(p)}</small>
        </button>;
      })}
    </div>
    <div class="ol-orient" role="radiogroup" aria-label="Orientation">
      {([false, true] as const).map(portrait => <button key={String(portrait)} type="button" role="radio" aria-checked={value.portrait === portrait} data-deck-orient={portrait ? 'portrait' : 'landscape'}
        class={'ol-orient-btn' + (value.portrait === portrait ? ' active' : '')} onClick={() => onChange({ ...value, portrait })}>
        <span style={portrait ? { width: '9px', height: '12px' } : { width: '12px', height: '9px' }} />{portrait ? 'Portrait' : 'Landscape'}</button>)}
    </div>
    <p class="dialog-hint">{sel.hint} — {sizeText(turned(sel, value.portrait))}{sel.id === 'device' ? ` (${ratioLabel(turned(sel, value.portrait))})` : ''}.</p>
  </fieldset>;
}
