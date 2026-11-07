/**
 * The theme pane beside the canvas in the theme view (DeliverableEditor's Edit theme — Google Slides'
 * theme builder, PowerPoint's Slide Master view): what is on every slide (deckmaster.ts, the slide's
 * linked copies: a click selects one, the pointer over a row outlines it on the canvas), the
 * background of every slide, the deck's colours and fonts as its stylesheet names them
 * (decktheme.ts: a colour clicked opens the colour grid, a font is picked from the deck's list), and
 * its own layouts (decklayouts.ts: a card's menu makes a slide of it, renames it, puts the slide shown
 * in its place, deletes it; Save this slide as a layout). Every change is one undo step.
 */
import type { ComponentChildren } from 'preact';
import type { Path, SelItem } from './protocol';
import type { DeckTheme } from './decktheme';
import type { MasterObject } from './deckmaster';
import type { LayoutCard } from './LayoutPicker';
import { ColorGrid } from '../app/ColorGrid';
import { deckFontSections, deckFontNamed, embeddedDeckFonts, DECK_GOOGLE_NOTE } from './decktoolbar';
import { firstFontFamily, previewBundledFonts } from './deckfonts';
import { FontChooser } from '../app/FontPicker';
import { useEffect } from 'preact/hooks';

interface Props {
  theme: DeckTheme;
  fontWarning(css: string): string | null;
  /** the objects on every slide, of the slide shown */
  objects: MasterObject[];
  slide: number;
  sel: SelItem[];
  /** the deck's own layouts (<template data-ol-layout>), drawn small */
  layouts: LayoutCard[];
  aspect: number;
  readOnly: boolean;
  /** a picker at (x, y) — the editor's (FloatPopover) */
  pick(x: number, y: number, title: string, render: (close: () => void) => ComponentChildren): void;
  setColor(name: string, value: string): void;
  /** `css` null: the headings as the text */
  setFont(which: 'text' | 'headings', css: string | null, google?: string): void;
  background(c: string | null): void;
  select(path: Path): void;
  hover(path: Path | null): void;
  /** a saved layout's menu at (x, y): a new slide in it, rename, the slide shown in its place, delete */
  layoutMenu(id: string, x: number, y: number): void;
  saveLayout(): void;
  close(): void;
}

const keyOf = (p: Path) => p.join('.');
/** `--accent-2` → "Accent 2" */
const colorName = (v: string) => { const s = v.replace(/^--/, '').replace(/[-_]+/g, ' ').trim(); return s ? s[0].toUpperCase() + s.slice(1) : v; };
const familyOf = (css: string | null) => (css ? firstFontFamily(css) : null);

/**
 * one of the theme's fonts: the font list every font is picked from (app/FontPicker.tsx FontChooser) —
 * the deck's embedded fonts, My fonts, Google's; `none`: a row for no font of its own (the headings as the text)
 */
function FontSelect({ label, value, family, none, disabled, onPick, fontWarning }: { label: string; value: string | null; family: string | null; none?: string; disabled: boolean; onPick: (css: string | null, google?: string) => void; fontWarning: Props['fontWarning'] }) {
  useEffect(previewBundledFonts, []);
  const fam = (family ?? familyOf(value) ?? '').trim().replace(/^["']|["']$/g, '');
  // (an embedded font is drawn in its own face already, previewBundledFonts; a Google one is loaded for the button)
  const embedded = !!fam && embeddedDeckFonts().some(f => familyOf(f.css)!.toLowerCase() === fam.toLowerCase());
  const warning = value ? fontWarning(value) : null;
  return (
    <>
      <div class="dl-theme-font">
        <span>{label}</span>
        <FontChooser label={value === null ? (none ?? 'Default') : fam || value} labelFont={embedded ? value ?? undefined : undefined} face={fam && !embedded ? { family: fam, axes: {}, features: [] } : null}
          title={`${label} font`} disabled={disabled} markdown googleNote={DECK_GOOGLE_NOTE} data={{ 'data-dl-theme-font': label }}
          sections={deckFontSections(fam, f => onPick(f.css, f.google), none ? { label: none, active: value === null, pick: () => onPick(null) } : undefined)}
          onPick={name => { void deckFontNamed(name).then(f => onPick(f.css, f.google)); }} />
      </div>
      {warning && <div class="dl-anim-hint">⚠ {warning}</div>}
    </>
  );
}

export function ThemePane({ theme, fontWarning, objects, slide, sel, layouts, aspect, readOnly, pick, setColor, setFont, background, select, hover, layoutMenu, saveLayout, close }: Props) {
  const selected = new Set(sel.map(s => keyOf(s.path)));
  const at = (e: MouseEvent) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); return { x: r.left, y: r.bottom + 4 }; };
  return (
    <div class="dl-anim dl-theme" data-dl-theme>
      <div class="dl-anim-head">
        <span>Theme</span>
        <button class="dl-btn" onClick={close} title="Hide the theme pane (the theme view stays: Done leaves it)">×</button>
      </div>
      <div class="dl-theme-scroll">
        <div class="dl-anim-hint dl-theme-hint">What is here is on every slide: change an object and every slide follows, anything added goes on every slide, Delete takes it off all of them. The slide’s own objects are dimmed.</div>

        <div class="dl-anim-stephead">On every slide{slide >= 0 ? <span> · slide {slide + 1}</span> : null}</div>
        <div class="dl-theme-list" onMouseLeave={() => hover(null)}>
          {!objects.length && <div class="dl-anim-empty">Nothing on this slide is on every slide yet. Add a text box, a shape, a picture here — it goes on every slide. (On a slide, right-click an object ▸ Put on every slide.)</div>}
          {objects.map(o => (
            <div key={o.key} class={'dl-anim-row' + (selected.has(keyOf(o.path)) ? ' sel' : '')} onMouseEnter={() => hover(o.path)}>
              <button type="button" class="dl-anim-label" data-dl-theme-object={o.key} onClick={() => select(o.path)} title="Select it on the slide">{o.label}</button>
              <span class="dl-theme-count" title={`On ${o.slides} slide${o.slides === 1 ? '' : 's'}`}>{o.slides}</span>
            </div>
          ))}
        </div>

        <div class="dl-anim-stephead">Background</div>
        <div class="dl-theme-row">
          <button type="button" class="dl-btn dl-theme-wide" disabled={readOnly} data-dl-theme-bg
            onClick={e => { const p = at(e); pick(p.x, p.y, 'Background of every slide', c => <ColorGrid current={null} close={c} none="As the design has it" onPick={background} />); }}>
            Background of every slide…
          </button>
        </div>

        <div class="dl-anim-stephead">Colours</div>
        <div class="dl-theme-colors">
          {!theme.colors.length && <div class="dl-anim-empty">The deck names no colours in its stylesheet (custom properties at <code>:root</code>, such as <code>--accent</code>).</div>}
          {theme.colors.map(c => (
            <button key={c.name} type="button" class="dl-theme-color" disabled={readOnly} data-dl-theme-color={c.name} title={`${c.name}: ${c.value} — click to change it everywhere the design uses it`}
              onClick={e => { const p = at(e); pick(p.x, p.y, colorName(c.name), cl => <ColorGrid current={c.hex} close={cl} onPick={v => { if (v) setColor(c.name, v); }} />); }}>
              <span class="dl-theme-swatch" style={{ background: c.value }} />
              <span class="dl-theme-cname">{colorName(c.name)}</span>
              <span class="dl-theme-cval">{c.value}</span>
            </button>
          ))}
        </div>

        <div class="dl-anim-stephead">Fonts</div>
        <div class="dl-theme-fonts">
          <FontSelect label="Text" value={theme.text.value} family={theme.text.family} disabled={readOnly} fontWarning={fontWarning} onPick={(css, g) => { if (css) setFont('text', css, g); }} />
          <FontSelect label="Headings" value={theme.headings.value} family={theme.headings.family} none="As the text" disabled={readOnly} fontWarning={fontWarning} onPick={(css, g) => setFont('headings', css, g)} />
        </div>

        <div class="dl-anim-stephead">Layouts</div>
        {!layouts.length && <div class="dl-anim-empty">The deck has no layouts of its own yet; new slides take those made of its design.</div>}
        {layouts.length > 0 && (
          <div class="dl-layouts-grid dl-theme-layouts">
            {layouts.map(l => (
              <div key={l.id} class="dl-layout-card saved">
                <button type="button" class="dl-layout-pick" data-dl-theme-layout={l.name} title={`${l.name} — a new slide in it, rename, replace, delete`}
                  onClick={e => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); layoutMenu(l.id, r.left, r.bottom + 2); }}>
                  <span class="dl-layout-thumb" style={{ aspectRatio: String(aspect) }} dangerouslySetInnerHTML={{ __html: l.thumb }} />
                  <span class="dl-layout-name">{l.name}</span>
                </button>
              </div>
            ))}
          </div>
        )}
        <div class="dl-theme-row">
          <button type="button" class="dl-btn dl-theme-wide" disabled={readOnly} data-dl-theme-savelayout onClick={saveLayout}>Save this slide as a layout…</button>
        </div>
      </div>
    </div>
  );
}
