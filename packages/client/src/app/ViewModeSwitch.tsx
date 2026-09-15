export type ViewMode = 'wysiwyg' | 'tex' | 'split';

/** The primary writing modes, always visible even when optional toolbars are hidden. */
export function ViewModeSwitch({ mode, onChange }: { mode: ViewMode; onChange: (mode: ViewMode) => void }) {
  return <div class="view-mode-switch" role="group" aria-label="Editor view">
    {(['wysiwyg', 'tex', 'split'] as const).map(value => <button type="button" key={value}
      aria-pressed={mode === value} class={mode === value ? 'active' : ''}
      title={value === 'wysiwyg' ? 'Edit the rendered document' : value === 'tex' ? 'Edit LaTeX source' : 'Show the document and LaTeX source side by side'}
      onClick={() => onChange(value)}>{value === 'wysiwyg' ? 'WYSIWYG' : value === 'tex' ? 'TeX' : 'Split'}</button>)}
  </div>;
}
