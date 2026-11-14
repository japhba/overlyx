/**
 * The status bar's Tandem chip (app/tandem.ts): shown while another device of this account has the
 * project open — "Tandem with iPad" turns tandem on here, "In tandem with iPad" off. Never on by itself:
 * a screen whose partner turned it on says so ("Join iPad in tandem") and waits for a click.
 */
import { useEffect, useState } from 'preact/hooks';
import { setTandemOn, subscribeTandem, type TandemView } from './tandem';
import './tandem.css';

const GLYPH = (
  <svg class="tandem-glyph" viewBox="0 0 20 14" width="18" height="13" aria-hidden="true">
    <rect x="1" y="2" width="8" height="11" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4" />
    <rect x="11" y="1" width="8" height="9" rx="1" fill="none" stroke="currentColor" stroke-width="1.4" />
    <path d="M10 12.5h9" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
  </svg>
);

export function TandemChip() {
  const [v, setV] = useState<TandemView | null>(null);
  useEffect(() => subscribeTandem(setV), []);
  if (!v?.project || !v.others.length) return null;
  // (one name per device: a second tab there is the same device)
  const names = [...new Set(v.others.map(o => o.name))];
  const other = names.length > 1 ? 'your other devices' : names[0] === v.name ? `your other ${names[0]}` : `${names[0]}`;
  const otherOn = v.others.some(o => o.on);
  const state = v.on ? (otherOn ? 'on' : 'waiting') : otherOn ? 'asked' : 'off';
  const label = state === 'on' ? `In tandem with ${other}` : state === 'waiting' ? `Tandem: waiting for ${other}` : state === 'asked' ? `Join ${other} in tandem` : `Tandem with ${other}`;
  const title = state === 'on'
    ? `This ${v.name} and ${other} work as one: the file, the slide or the place in the text, the pen and presenting follow whichever you used last. Each shows it at its own size. Click to work separately again.`
    : state === 'waiting'
      ? `Tandem is on here. Turn it on on ${other} too (the same chip there), and both follow each other.`
      : `${other[0].toUpperCase() + other.slice(1)} has this project open too. Tandem: each follows what you do on the other — the file, the slide or the place in the text, the pen, presenting (on a tablet with only the drawing tools). Each shows it at its own size.`;
  return (
    <button type="button" class={'tandem-chip ' + state} data-tandem={state} aria-pressed={v.on} title={title} onClick={() => setTandemOn(!v.on)}>
      {GLYPH}<span>{label}</span>
    </button>
  );
}
