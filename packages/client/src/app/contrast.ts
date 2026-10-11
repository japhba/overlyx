/**
 * The text colour that reads on a person's colour: dark on the light ones (amber, cyan, pink, olive
 * of server db.ts USER_COLORS), white on the rest — cursor labels, avatars' initials, name tags.
 */
export function inkOn(bg: string | null | undefined): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(bg ?? '');
  if (!m) return '#fff';
  const [r, g, b] = m.slice(1).map(h => parseInt(h, 16));
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.6 ? '#1c1b19' : '#fff';
}
