export interface MathNodeGeometry {
  code: string; text: string;
  rect: { x: number; y: number; width: number; height: number };
  origin: { x: number; y: number }; em: number;
  visible: boolean; unclipped: boolean; definitionPresent: boolean;
  fonts: { family: string; registeredLoaded: boolean }[];
  requestedFontReady: boolean;
}
export interface LogicalMathGeometry {
  kind: 'svg' | 'chtml'; glyphs: MathNodeGeometry[];
  rules: { rect: MathNodeGeometry['rect']; visible: boolean; unclipped: boolean;
    logical: { x: number; width: number; axis: number }; declaredHeight?: number; declaredBorder?: number; usedBorder?: number }[];
  advance: number; fontSetStatus: string; errors: number; unsupported: string[];
  breakFonts: { family: string; registeredLoaded: boolean; requestedFontReady: boolean }[];
  fractionNative?: { numeratorIndices: number[]; nominalHeight: number; expectedHeight: number;
    expectedBorder: number; actualHeight: number; actualBorder: number; deltaHeight: number; fontSize: string; rulePaint: 'background' };

}

/** A standalone browser function: all geometry comes from the actual rendered DOM. */
export function readLogicalMath(root: Element, kind: 'svg' | 'chtml'): LogicalMathGeometry {
  const rect = (el: Element) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  };
  const num = (value: string) => Number.parseFloat(value) || 0;
  const unsupported: string[] = [];
  const visible = (node: Element) => {
    for (let p: Element | null = node; p; p = p.parentElement) {
      const s = getComputedStyle(p);
      if (s.display === 'none' || s.visibility !== 'visible' || num(s.opacity) === 0) return false;
    }
    return node.isConnected;
  };
  // Shipped CHTML.commonStyles clips ZERO-font excess outside the glyph padding box.
  // Its four-corner rectangle expands that box by 1em horizontally and 2px vertically;
  // it never cuts the represented glyph cell. Compare the EXACT native computed value
  // rather than guessing em-to-px or padding-box serialization in each engine.
  const knownGlyphClip = 'padding-box polygon(-1em -2px, calc(100% + 1em) -2px, calc(100% + 1em) calc(100% + 2px), -1em calc(100% + 2px))';
  const clipReferences = new Map<string, string>();
  const expandingMathJaxGlyphClip = (node: Element, actual: string): boolean => {
    if (kind !== 'chtml' || node.localName !== 'mjx-c'
      || !['mjx-mo', 'mjx-mi', 'mjx-mn', 'mjx-ms', 'mjx-mtext'].includes(node.parentElement?.localName ?? '')) return false;
    const size = getComputedStyle(node).fontSize;
    if (!Number.isFinite(Number.parseFloat(size)) || Number.parseFloat(size) <= 0) return false;
    let reference = clipReferences.get(size);
    if (reference === undefined) {
      const probe = document.createElement('span');
      probe.style.cssText = 'position:fixed;left:-100000px;top:-100000px;visibility:hidden;pointer-events:none;display:inline-block;width:0;height:0;padding:0;border:0;margin:0';
      probe.style.fontSize = size;
      probe.style.clipPath = knownGlyphClip;
      try {
        document.body.append(probe);
        reference = getComputedStyle(probe).clipPath;
        clipReferences.set(size, reference);
      } finally { probe.remove(); }
    }
    return !!reference && reference !== 'none' && actual === reference;
  };
  const unclipped = (node: Element) => {
    const r = node.getBoundingClientRect();
    const ownClip = getComputedStyle(node).clipPath;
    if (ownClip && ownClip !== 'none' && !expandingMathJaxGlyphClip(node, ownClip)) { unsupported.push('own clip-path'); return false; }
    for (let p = node.parentElement; p; p = p.parentElement) {
      const s = getComputedStyle(p), b = p.getBoundingClientRect();
      if (s.clipPath !== 'none' && s.clipPath !== '') { unsupported.push('clip-path'); return false; }
      const clipsX = /hidden|clip|scroll|auto/.test(s.overflowX), clipsY = /hidden|clip|scroll|auto/.test(s.overflowY);
      if (clipsX && (r.left < b.left - 0.5 || r.right > b.right + 0.5)) return false;
      if (clipsY && (r.top < b.top - 0.5 || r.bottom > b.bottom + 0.5)) return false;
    }
    return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight;
  };
  const canonical = (code: string) => {
    const n = Number.parseInt(code, 16);
    if (!Number.isInteger(n) || n < 0 || n > 0x10ffff) { unsupported.push('invalid glyph code'); return ''; }
    return String.fromCodePoint(n).normalize('NFKC');
  };
  const norm = (s: string) => s.trim().replace(/^['"]|['"]$/g, '');
  const breakFonts = Array.from(root.querySelectorAll('mjx-break')).flatMap(gap => {
    const style = getComputedStyle(gap);
    const families = style.fontFamily.split(',').map(norm);
    if (families.some(f => !f.startsWith('MJX-'))) unsupported.push('unknown break-glue font family');
    if (!families.length) unsupported.push('no registered break-glue font');
    return families.map(family => ({ family,
      registeredLoaded: Array.from(document.fonts).some(face => norm(face.family) === family && face.status === 'loaded'),
      requestedFontReady: document.fonts.check(`${style.fontSize} ${family}`, gap.textContent ?? '\u00a0'),
    }));
  });
  let advance = 0;
  let glyphs: MathNodeGeometry[] = [];
  if (kind === 'svg') {
    const svgs = Array.from(root.querySelectorAll(':scope > svg')) as SVGSVGElement[];
    if (!svgs.length) unsupported.push('no direct SVG viewport');
    const boxes = svgs.map(svg => svg.getBoundingClientRect());
    advance = boxes.length ? Math.max(...boxes.map(b => b.right)) - Math.min(...boxes.map(b => b.left)) : 0;
    const baselines = svgs.map(svg => {
      const r = svg.getBoundingClientRect(), v = svg.viewBox.baseVal;
      return v.height ? r.top - v.y / v.height * r.height : NaN;
    });
    if (baselines.some(b => !Number.isFinite(b) || Math.abs(b - baselines[0]) > 0.5)) unsupported.push('wrapped or unknown SVG line');
    if (Array.from(root.querySelectorAll('path[data-c]')).some(el => !el.closest('defs'))) unsupported.push('uncached SVG glyph');
    glyphs = Array.from(root.querySelectorAll<SVGUseElement>('use')).filter(el => !el.closest('defs')).map(el => {
      const m = el.getScreenCTM();
      const code = (el.getAttribute('data-c') ?? '').toUpperCase();
      const href = el.getAttribute('href') ?? el.getAttributeNS('http://www.w3.org/1999/xlink', 'href') ?? '';
      const definition = href.startsWith('#') ? document.getElementById(href.slice(1)) : null;
      if (!m || Math.abs(m.b) > 1e-7 || Math.abs(m.c) > 1e-7 || m.a <= 0 || m.d >= 0) unsupported.push('unsupported SVG glyph transform');
      // A glyph path's outline bearing is not its pen position. Explicit use
      // x/y is applied in the use's own coordinate system, before its CTM.
      const p = m ? new DOMPoint(el.x.baseVal.value, el.y.baseVal.value).matrixTransform(m) : { x: NaN, y: NaN };
      return { code, text: canonical(code), rect: rect(el), origin: { x: p.x, y: p.y }, em: m ? Math.hypot(m.a, m.b) * 1000 : NaN,
        visible: visible(el), unclipped: unclipped(el), definitionPresent: definition?.localName === 'path' && !!definition.getAttribute('d'),
        fonts: [], requestedFontReady: true };
    });
  } else {
    if (root.querySelector('mjx-utext, mjx-stretchy-h, mjx-stretchy-v, mjx-phantom')) unsupported.push('unsupported CHTML glyph layout');
    advance = root.getBoundingClientRect().width;
    glyphs = Array.from(root.querySelectorAll('mjx-c')).map(el => {
      const s = getComputedStyle(el), r = el.getBoundingClientRect();
      const code = Array.from(el.classList).find(c => /^mjx-c[\da-f]+$/i.test(c))?.slice(5).toUpperCase() ?? '';
      // MathJax's shipped TextNode appends real text. Its zero-width glyph
      // inline block uses [h, w+ic, d, 0] padding at line-height zero.
      const text = (el.textContent ?? '').normalize('NFKC');
      if (text !== canonical(code) || !Number.isFinite(Number.parseFloat(s.lineHeight)) || Number.parseFloat(s.lineHeight) !== 0) unsupported.push('unknown CHTML glyph text or line-height');
      for (let p: Element | null = el; p; p = p.parentElement) {
        const t = getComputedStyle(p).transform;
        if (!t || t === 'none') continue;
        const m = new DOMMatrix(t);
        if (Math.abs(m.a - 1) > 1e-7 || Math.abs(m.d - 1) > 1e-7 || Math.abs(m.b) > 1e-7 || Math.abs(m.c) > 1e-7) unsupported.push('unsupported CHTML transform');
      }
      const families = s.fontFamily.split(',').map(norm);
      if (families.some(f => !f.startsWith('MJX-'))) unsupported.push('unknown CHTML font family');
      if (!families.length) unsupported.push('no registered math font family');
      const fonts = families.map(family => ({ family, registeredLoaded: Array.from(document.fonts).some(face => norm(face.family) === family && face.status === 'loaded') }));
      return { code, text, rect: rect(el), origin: { x: r.left + num(s.borderLeftWidth) + num(s.paddingLeft), y: r.top + num(s.borderTopWidth) + num(s.paddingTop) },
        em: num(s.fontSize), visible: visible(el), unclipped: unclipped(el), definitionPresent: true, fonts,
        requestedFontReady: document.fonts.check(`${s.fontSize} ${s.fontFamily}`, el.textContent ?? '') };
    });
  }
  const ruleElements = kind === 'svg'
    ? Array.from(root.querySelectorAll('rect')).filter(el => !el.closest('defs'))
    : Array.from(root.querySelectorAll('mjx-line'));
  let fractionNative: LogicalMathGeometry['fractionNative'];
  const rules = ruleElements.map(el => {
    const r = el.getBoundingClientRect();
    if (kind === 'svg') {
      const bar = el as SVGRectElement, m = bar.getScreenCTM();
      const x = bar.x.baseVal.value, y = bar.y.baseVal.value + bar.height.baseVal.value / 2;
      const left = m ? new DOMPoint(x, y).matrixTransform(m) : { x: NaN, y: NaN };
      const right = m ? new DOMPoint(x + bar.width.baseVal.value, y).matrixTransform(m) : { x: NaN, y: NaN };
      return { rect: rect(el), visible: visible(el), unclipped: unclipped(el),
        logical: { x: left.x, width: right.x - left.x, axis: left.y } };
    }
    // The slide overlay paints the nominal rule height as currentColor background.
    // Read the declarations and native layout centre; the actual border stays zero.
    // MathJax's later stylesheet can still supply the raw .075em declaration;
    // the earlier app's !important override wins. Raw declarations are diagnostics.
    const style = getComputedStyle(el);
    let height = '', border = '', topMargin = '', bottomMargin = '';
    const inspect = (list: CSSRuleList) => {
      for (const rule of Array.from(list)) {
        if ('selectorText' in rule && 'style' in rule) {
          const css = rule as CSSStyleRule;
          try {
            if (!css.selectorText.includes('mjx-line') || !el.matches(css.selectorText)) continue;
          } catch { continue; }
          height = css.style.getPropertyValue('height') || height;
          border = css.style.getPropertyValue('border-top-width') || border;
          topMargin = css.style.getPropertyValue('margin-top') || topMargin;
          bottomMargin = css.style.getPropertyValue('margin-bottom') || bottomMargin;
        }
      }
    };
    for (const sheet of Array.from(document.styleSheets)) { try { inspect(sheet.cssRules); } catch { /* Cross-origin sheets cannot declare the injected MathJax line. */ } }
    const own = (el as HTMLElement).style;
    height = own.height || height; border = own.borderTopWidth || border;
    topMargin = own.marginTop || topMargin; bottomMargin = own.marginBottom || bottomMargin;
    const px = (value: string) => /^[-+.\d]+em$/.test(value) ? parseFloat(value) * num(style.fontSize)
      : /^[-+.\d]+px$/.test(value) ? parseFloat(value) : NaN;
    const declaredHeight = px(height), declaredBorder = px(border), usedBorder = num(style.borderTopWidth);
    if (!Number.isFinite(declaredHeight) || !Number.isFinite(declaredBorder) || declaredHeight <= 0
      || usedBorder !== 0 || style.boxSizing !== 'border-box'
      || style.borderTopStyle !== 'solid') unsupported.push('unknown nominal fraction rule declaration');
    // Native app-unit rounding remains diagnostic; it never changes the source
    // pen-position or rule-axis expectation.
    const layoutHeight = r.height;
    // Supported fixed display fraction only. Independently predict the native
    // nominal background box to reject unexpected styles/heights. All placement
    // comparisons below use RAW source SVG geometry without any fraction offset.
    const frac = el.closest('mjx-frac');
    const numerator = frac?.querySelector('mjx-num'), denominator = frac?.querySelector('mjx-den');
    const numerators = Array.from(numerator?.querySelectorAll('mjx-c') ?? []);
    const denominators = Array.from(denominator?.querySelectorAll('mjx-c') ?? []);
    const emValue = (value: string) => /^[-+.\d]+em$/.test(value.trim()) ? parseFloat(value) : NaN;
    const supported = root.querySelectorAll('mjx-mfrac').length === 1 && ruleElements.length === 1
      && frac?.getAttribute('type') === 'd' && el.parentElement?.localName === 'mjx-dtable'
      && numerators.length === 3 && denominators.length === 3 && glyphs.map(g => g.text).join('') === 'a+bc+d'
      && emValue(height) === 0.06 && (emValue(border) === 0.075 || border === '0px' || border === '0')
      && emValue(topMargin) === 0.18 && emValue(bottomMargin) === 0.18
      && style.display === 'block' && style.boxSizing === 'border-box'
      && style.borderTopStyle === 'solid' && usedBorder === 0 && style.minHeight === '0px'
      && style.backgroundColor === style.color && style.backgroundImage === 'none'
      && !!el.closest('.dl-mathedit .lm-content');
    if (!supported) unsupported.push('unsupported nominal background display fraction style');
    else {
      const probe = document.createElement('span');
      probe.style.cssText = 'position:fixed;left:-100000px;top:-100000px;visibility:hidden;pointer-events:none;display:block;box-sizing:border-box;min-height:0;height:.06em;border-top:0 solid;background:currentColor;margin:.18em -.1em;overflow:hidden;width:100px;padding:0;border-left:0;border-right:0;border-bottom:0';
      probe.style.fontSize = style.fontSize;
      try {
        document.body.append(probe);
        const ps = getComputedStyle(probe), expectedHeight = probe.getBoundingClientRect().height;
        const nominalHeight = 0.06 * num(ps.fontSize);
        const elements = Array.from(root.querySelectorAll('mjx-c'));
        fractionNative = { numeratorIndices: numerators.map(node => elements.indexOf(node)), nominalHeight,
          expectedHeight, expectedBorder: num(ps.borderTopWidth), actualHeight: layoutHeight, actualBorder: usedBorder,
          deltaHeight: expectedHeight - nominalHeight, fontSize: ps.fontSize, rulePaint: 'background' };
      } finally { probe.remove(); }
    }
    return { rect: rect(el), visible: visible(el), unclipped: unclipped(el), declaredHeight, declaredBorder, usedBorder,
      logical: { x: r.left, width: r.width, axis: r.top + layoutHeight / 2 } };
  });
  return { kind, glyphs, rules,
    advance, fontSetStatus: document.fonts.status,
    errors: root.querySelectorAll('mjx-merror, [data-mml-node="merror"], [data-mjx-error]').length,
    breakFonts, fractionNative, unsupported: Array.from(new Set(unsupported)) };
}

/** Compare logical pen positions, never cross-renderer painted-edge bounds. */
export function logicalMathProblems(source: LogicalMathGeometry, editor: LogicalMathGeometry,
  host: { frame: { x: number; y: number }; scaleX: number; scaleY: number }, expected: string, ruleCount: number): string[] {
  const problems: string[] = [];
  const check = (ok: boolean, label: string) => { if (!ok) problems.push(label); };
  for (const side of [source, editor]) {
    check(side.unsupported.length === 0, `${side.kind}: unsupported ${side.unsupported.join(', ')}`);
    check(side.errors === 0, `${side.kind}: MathJax error`);
    check(side.fontSetStatus === 'loaded', `${side.kind}: font set not loaded`);
    check(side.glyphs.map(g => g.text).join('') === expected, `${side.kind}: fixture glyph sequence`);
    check(side.glyphs.length === Array.from(expected).length, `${side.kind}: fixture glyph count`);
    check(side.rules.length === ruleCount, `${side.kind}: fixture rule count`);
    check(side.breakFonts.every(f => f.registeredLoaded && f.requestedFontReady), `${side.kind}: break-glue font not registered/loaded`);
    for (const [i, glyph] of side.glyphs.entries()) {
      check(glyph.visible && glyph.unclipped, `${side.kind}: glyph ${i} hidden or clipped`);
      check(glyph.definitionPresent, `${side.kind}: glyph ${i} missing definition`);
      check(glyph.requestedFontReady && glyph.fonts.every(f => f.registeredLoaded), `${side.kind}: glyph ${i} font not registered/loaded`);
    }
    for (const [i, rule] of side.rules.entries()) check(rule.visible && rule.unclipped, `${side.kind}: rule ${i} hidden or clipped`);
  }
  if (ruleCount === 1) {
    const native = editor.fractionNative;
    check(!!native, 'missing independently predicted nominal fraction');
    if (native) {
      check(source.rules.length === 1 && source.glyphs.length === 6 && expected === 'a+bc+d', 'unsupported source fraction');
      check(!!source.rules[0] && Math.abs(native.nominalHeight / host.scaleY - source.rules[0].rect.height) <= 0.5, 'fraction nominal SVG thickness');
      check(Math.abs((native.actualHeight - native.expectedHeight) / host.scaleY) <= 0.5, 'fraction unexpected native line height');
      check(Math.abs((native.actualBorder - native.expectedBorder) / host.scaleY) <= 0.5, 'fraction unexpected native line border');
      check(native.rulePaint === 'background' && native.actualBorder === 0, 'fraction nominal background paint');
    }
  }
  check(source.glyphs.length === editor.glyphs.length, 'renderer glyph count');
  for (let i = 0; i < Math.min(source.glyphs.length, editor.glyphs.length); i++) {
    const s = source.glyphs[i], e = editor.glyphs[i];
    check(s.code === e.code, `glyph ${i}: canonical code`);
    check(Math.abs((e.origin.x - host.frame.x) / host.scaleX - s.origin.x) <= 0.5, `glyph ${i}: logical x`);
    const expectedY = s.origin.y;
    check(Math.abs((e.origin.y - host.frame.y) / host.scaleY - expectedY) <= 0.5, `glyph ${i}: logical baseline`);
    check(Math.abs(e.em / host.scaleX - s.em) <= 0.5, `glyph ${i}: em`);
  }
  for (let i = 0; i < Math.min(source.rules.length, editor.rules.length); i++) {
    const s = source.rules[i].logical, e = editor.rules[i].logical;
    check(Math.abs((e.x - host.frame.x) / host.scaleX - s.x) <= 0.5, `rule ${i}: logical x`);
    check(Math.abs(e.width / host.scaleX - s.width) <= 0.5, `rule ${i}: logical width`);
    check(Math.abs((e.axis - host.frame.y) / host.scaleY - s.axis) <= 0.5, `rule ${i}: logical axis`);
  }
  check(Math.abs(editor.advance / host.scaleX - source.advance) <= 0.5, 'logical root advance');
  return problems;
}
