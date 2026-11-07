/**
 * The left panels' buttons in a bar of their own along the screen's left edge, as VS Code's activity
 * bar (the user, 7 Nov 2026: "its unintuitive that the files and slides menu are [in] the bottom bar.
 * id like them to be in the left bar again, like in vscode"): the files, and an open deck's slides —
 * lit while their panel is shown, a click shows or hides it. Beside a deck the files and the slides
 * take turns (one panel at a time, as in VS Code): two of them beside the slide left it little room.
 *
 * Where the bar would take room from a slide, its buttons go into the status bar's corner instead
 * (CornerButton.tsx); on a small screen where any bar would, all the bars float over the slide until
 * asked for (DeliverableEditor `floatOn`). An open deck says which (`setDeckBars`): it knows its slide
 * and the room round it. Elsewhere the bar is at the left — on a narrow screen, in the corner.
 */
import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { PanelIcon, type PanelIconName } from './CornerButton';

/** the bar's width (styles.css .activitybar) */
export const ACTIVITY_W = 40;

/** the bar at the left, or its buttons in the status bar's corner */
export type BarsPlace = 'left' | 'bottom';

/** what an open deck tells the app's shell */
export interface DeckBars {
  /** where the buttons go (none: as anywhere else) */
  place: BarsPlace | null;
  /** its slide rail shown: the files' panel is not (they take turns) */
  rail: boolean;
  /** shows or hides the slide rail */
  showRail: (on: boolean) => void;
}

let deckBars: DeckBars | null = null;
const listeners = new Set<(d: DeckBars | null) => void>();

/** the open deck's say (none: no deck open) */
export function setDeckBars(d: DeckBars | null): void {
  const same = d && deckBars && d.place === deckBars.place && d.rail === deckBars.rail;
  deckBars = d;
  if (!same) for (const f of listeners) f(d);
}

export function useDeckBars(): DeckBars | null {
  const [d, setD] = useState(deckBars);
  useEffect(() => {
    listeners.add(setD);
    setD(deckBars);
    return () => { listeners.delete(setD); };
  }, []);
  return d;
}

/** a panel's button in the bar: its icon, its name for screen readers (and tests), lit while it is shown */
export function ActivityButton({ icon, title, label, on, onClick, ...rest }: { icon: PanelIconName; title: string; label: string; on: boolean; onClick: () => void } & Record<`data-${string}`, string | boolean | undefined>) {
  return (
    <button type="button" class={'activity-btn' + (on ? ' on' : '')} title={title} aria-pressed={on} onClick={onClick} {...rest}>
      <PanelIcon name={icon} />
      <span class="activity-label">{label}</span>
    </button>
  );
}

/** the bar: the app's buttons, then a deck's (portalled into `data-activity-slot`) */
export function ActivityBar({ children }: { children: ComponentChildren }) {
  return (
    <nav class="activitybar" aria-label="Panels" data-activitybar>
      {children}
      <span class="activity-slot" data-activity-slot />
    </nav>
  );
}
