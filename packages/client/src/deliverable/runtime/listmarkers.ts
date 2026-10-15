/** Editor-only list-marker measurements; browsers expose no ::marker DOMRect. */
export interface InkBox { cx: number; cy: number; w: number; h: number; a: number }
const measured = new WeakMap<Element, { key: string; widths: number[] }>();

/** Expand in the object's own axes, then rotate the shifted centre back into document space. */
export function expandInlineBox(box: InkBox, left: number, right: number): InkBox {
  if (!left && !right) return box;
  const shift = (right - left) / 2, a = box.a * Math.PI / 180;
  return { ...box, cx: box.cx + shift * Math.cos(a), cy: box.cy + shift * Math.sin(a), w: box.w + left + right };
}

function markerWidths(list: Element, items: HTMLElement[]): number[] {
  const styles = items.map(li => ({ item: getComputedStyle(li), marker: getComputedStyle(li, '::marker') }));
  const key = JSON.stringify([list.getAttribute('start'), list.hasAttribute('reversed'), document.fonts?.status,
    ...items.map((li, i) => [li.getAttribute('value'), styles[i].item.listStyleType, styles[i].item.listStyleImage,
      styles[i].item.direction, styles[i].marker.font, styles[i].marker.fontSize, styles[i].marker.fontFamily,
      styles[i].marker.letterSpacing, styles[i].marker.content, styles[i].marker.textTransform])]);
  const old = measured.get(list);
  if (old?.key === key) return old.widths;

  // Let this browser format its own ordinal, reversed/value counters, marker font and spacing.
  // An inside marker's advance is measurable at an empty inline pin and conservatively encloses
  // the corresponding outside marker. This avoids guessed digit widths and fixed digit limits.
  const wrapper = document.createElement('div');
  wrapper.setAttribute('data-ol-runtime', '');
  wrapper.setAttribute('aria-hidden', 'true');
  wrapper.style.cssText = 'all:initial;position:fixed;left:0;top:-100000px;visibility:hidden;pointer-events:none;width:max-content;';
  const probe = list.cloneNode(false) as HTMLElement;
  probe.removeAttribute('id');
  probe.style.cssText = 'position:static!important;display:block!important;width:max-content!important;height:auto!important;margin:0!important;padding:0!important;border:0!important;transform:none!important;rotate:none!important;scale:none!important;';
  const pins: HTMLElement[] = [];
  const rules: string[] = [];
  for (let i = 0; i < items.length; i++) {
    const li = items[i].cloneNode(false) as HTMLElement, { item, marker } = styles[i];
    li.removeAttribute('id');
    li.dataset.olMarkerMeasure = String(i);
    li.style.cssText = 'position:static!important;display:list-item!important;width:auto!important;height:auto!important;min-width:0!important;margin:0!important;padding:0!important;border:0!important;white-space:nowrap!important;';
    for (const [property, value] of Object.entries({ 'list-style-position':'inside', 'list-style-type':item.listStyleType,
      'list-style-image':item.listStyleImage, direction:item.direction, font:item.font })) li.style.setProperty(property, value, 'important');
    const pin = document.createElement('span');
    pin.style.cssText = 'display:inline-block!important;width:0!important;height:0!important;margin:0!important;padding:0!important;border:0!important;';
    li.append(pin); pins.push(pin); probe.append(li);
    const font = ['font-family', 'font-size', 'font-style', 'font-weight', 'font-stretch', 'font-variant-numeric', 'letter-spacing', 'text-transform', 'content']
      .map(p => `${p}:${marker.getPropertyValue(p)}!important`).join(';');
    rules.push(`[data-ol-marker-measure="${i}"]::marker{${font}}`);
  }
  const style = document.createElement('style');
  style.textContent = rules.join('\n');
  wrapper.append(style, probe);
  let widths: number[];
  try {
    document.body.append(wrapper);
    widths = pins.map((pin, i) => {
      const row = pin.parentElement!.getBoundingClientRect(), p = pin.getBoundingClientRect();
      return Math.max(0, styles[i].item.direction === 'rtl' ? row.right - p.right : p.left - row.left);
    });
  } finally { wrapper.remove(); }
  measured.set(list, { key, widths });
  return widths;
}

/** Only extend past the actual box: existing list padding may already contain the marker. */
export function listInkBox(el: Element, box: InkBox): InkBox {
  const lists = [...(el.matches('ul,ol') ? [el] : []), ...Array.from(el.querySelectorAll(':scope > ul,:scope > ol'))];
  if (!lists.length) return box;
  let left = -box.w / 2, right = box.w / 2;
  const a = box.a * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  for (const list of lists) {
    const items = Array.from(list.querySelectorAll<HTMLElement>(':scope > li'));
    if (!items.length) continue;
    const widths = markerWidths(list, items);
    for (let i = 0; i < items.length; i++) {
      const item = items[i], cs = getComputedStyle(item);
      if (cs.display === 'none' || cs.listStylePosition === 'inside'
        || cs.listStyleType === 'none' && cs.listStyleImage === 'none' && getComputedStyle(item, '::marker').content === 'normal') continue;
      const r = item.getBoundingClientRect();
      if (!r.width && !r.height) continue;
      const dx = r.x + r.width / 2 + scrollX - box.cx, dy = r.y + r.height / 2 + scrollY - box.cy;
      const centre = dx * c + dy * s, half = item.offsetWidth / 2;
      if (cs.direction === 'rtl') right = Math.max(right, centre + half + widths[i]);
      else left = Math.min(left, centre - half - widths[i]);
    }
  }
  return expandInlineBox(box, Math.max(0, -box.w / 2 - left), Math.max(0, right - box.w / 2));
}
