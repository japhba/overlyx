/**
 * The button of a panel folded away (the files, a deck's slides, its speaker notes): in the bottom-left
 * corner of the screen — the status bar's start (StatusBar `corner`, and the slot a deck fills); a deck
 * in VS Code, a strip of its own under the canvas — so that nothing lies over the page or the slide.
 */
import type { ComponentChildren, JSX } from 'preact';

const ICONS: Record<'files' | 'slides' | 'notes', JSX.Element> = {
  // a folder
  files: <path d="M2.5 4.5a1 1 0 0 1 1-1h3l1.5 1.5h4.5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z" />,
  // a window with a column on its left
  slides: <><rect x="2" y="3" width="12" height="10" rx="1.2" /><path d="M6 3v10" /></>,
  // a window with a strip along its bottom
  notes: <><rect x="2" y="3" width="12" height="10" rx="1.2" /><path d="M2 9.5h12" /></>,
};

export function CornerButton({ icon, title, onClick, children, ...rest }: { icon: keyof typeof ICONS; title: string; onClick: () => void; children: ComponentChildren } & Record<`data-${string}`, string | boolean>) {
  return (
    <button type="button" class="corner-btn" title={title} onClick={onClick} {...rest}>
      <svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round">{ICONS[icon]}</svg>
      <span>{children}</span>
    </button>
  );
}
