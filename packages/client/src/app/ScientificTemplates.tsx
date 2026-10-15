import { SCIENTIFIC_TEMPLATES, type ScientificKind } from '@overlyx/core/html/scientific.ts';

/** Shared by + New and File > New: the design and its actual page proportions are visible. */
export function ScientificTemplates({ kind, value, onChange }: { kind: ScientificKind; value?: string; onChange: (id: string) => void }) {
  const templates = SCIENTIFIC_TEMPLATES.filter(t => t.kind === kind);
  const selected = templates.find(t => t.id === value) ?? templates[0];
  return <fieldset class="ol-scientific-templates">
    <legend>Style</legend>
    <div class="ol-template-grid" role="radiogroup" aria-label={`${kind === 'poster' ? 'Poster' : 'Slide'} style`}>
      {templates.map(t => <button key={t.id} type="button" role="radio" aria-checked={selected.id === t.id}
        class={'ol-template-card' + (selected.id === t.id ? ' active' : '')} data-template={t.id} onClick={() => onChange(t.id)}>
        <span class="ol-template-preview"><img src={`/templates/${t.id}.png`} alt="" loading="lazy" /></span>
        <strong>{t.name}</strong>
        <small>{t.size}</small>
      </button>)}
    </div>
    <p class="dialog-hint">{selected.description}</p>
    <p class="dialog-hint">Editable adaptation of <a href={selected.source} target="_blank" rel="noopener noreferrer">{selected.kind === 'poster' ? 'MIT’s published template' : selected.name}</a> · {selected.license}.</p>
  </fieldset>;
}
