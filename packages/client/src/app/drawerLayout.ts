/** Match the workspace drawers in styles.css, not the narrower document-pane tabs. */
export const DRAWER_LAYOUT_QUERY = '(max-width: 900px)';

type DrawerMedia = Pick<MediaQueryList, 'matches' | 'addEventListener' | 'removeEventListener'>;

/** Fold once on entry into the drawer layout; a drawer deliberately reopened there stays open. */
export function foldDrawersOnNarrow(media: DrawerMedia, fold: () => void): () => void {
  let narrow = media.matches;
  const changed = () => {
    const next = media.matches;
    const entered = next && !narrow;
    narrow = next;
    if (entered) fold();
  };
  media.addEventListener('change', changed);
  return () => media.removeEventListener('change', changed);
}
