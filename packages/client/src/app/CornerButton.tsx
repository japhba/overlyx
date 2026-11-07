/**
 * The button of a panel folded away (the files, a deck's slides, its speaker notes): in the bottom-left
 * corner of the screen — the status bar's start (StatusBar `corner`, and the slot a deck fills); a deck
 * in VS Code, a strip of its own under the canvas — so that nothing lies over the page or the slide.
 * The files' and the slides' are there only where the bar at the left (ActivityBar.tsx) would take room
 * from the slide, or on a narrow screen; the notes' always (the notes open at the bottom).
 */
import type { ComponentChildren, JSX } from 'preact';

const ICONS: Record<'files' | 'slides' | 'notes' | 'bars', JSX.Element> = {
  // a folder
  files: <path d="M2.5 4.5a1 1 0 0 1 1-1h3l1.5 1.5h4.5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z" />,
  // a window with a column on its left
  slides: <><rect x="2" y="3" width="12" height="10" rx="1.2" /><path d="M6 3v10" /></>,
  // a window with a strip along its bottom
  notes: <><rect x="2" y="3" width="12" height="10" rx="1.2" /><path d="M2 9.5h12" /></>,
  // a window with a strip along its top, coming down (the bars floating over a slide: DeliverableEditor)
  bars: <><rect x="2" y="3" width="12" height="10" rx="1.2" /><path d="M2 6h12M6.2 8.7 8 10.5l1.8-1.8" /></>,
};
export type PanelIconName = keyof typeof ICONS;

/** a panel's icon (16 px drawing, sized by CSS) */
export function PanelIcon({ name }: { name: PanelIconName }) {
  return <svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round">{ICONS[name]}</svg>;
}

export function CornerButton({ icon, title, onClick, children, ...rest }: { icon: PanelIconName; title: string; onClick: () => void; children: ComponentChildren } & Record<`data-${string}`, string | boolean>) {
  return (
    <button type="button" class="corner-btn" title={title} onClick={onClick} {...rest}>
      <PanelIcon name={icon} />
      <span>{children}</span>
    </button>
  );
}
