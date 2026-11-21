/**
 * The texts of a deck's slides that become editable text in the PowerPoint file (pptx.ts), read in
 * the renderer's page (render-export.ts) after the slides were marked `data-ol-shot`.
 *
 * An object of a slide (a child of the slide) becomes a text box when its mapping is clean: text
 * only — no formula, picture, drawing, table, video or embedded page inside, not rotated or
 * otherwise transformed. Its paragraphs keep alignment, bullets / numbers and nesting, line height
 * and spacing; its runs the font (by name: the first of the family list), size, colour, bold,
 * italic, underline, strike-through, super- / subscript. Everything else stays in the slide's
 * picture; the texts taken are then painted transparent there (their boxes' fills and borders stay
 * in the picture), so they are not there twice.
 *
 * A string evaluated in the page, not a function: the server runs under tsx, whose helper for
 * function names the page does not have.
 */
export const PPTX_TEXT_SCRIPT = String.raw`(() => {
  var BAD = 'img,svg,canvas,video,audio,iframe,object,embed,table,mjx-container,math,picture,input,textarea,select,button,[data-ol-ink],.ol-crop';
  var INLINE = { inline: 1, 'inline-block': 1, contents: 1 };
  var hex = function (c) {
    var m = /rgba?\(([\d.]+)[, ]+([\d.]+)[, ]+([\d.]+)(?:[,/ ]+([\d.]+%?))?/.exec(c || '');
    if (!m) return null;
    var a = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    if (a < 0.05) return null;
    return [m[1], m[2], m[3]].map(function (v) { return ('0' + Math.round(+v).toString(16)).slice(-2); }).join('').toUpperCase();
  };
  // CSS's generic families name no face to write into the file (nor do the system-/ui- keywords, which
  // OverLyX never sets — the test no-sf-fonts keeps their names out of the code)
  var GENERIC = { serif: 1, 'sans-serif': 1, monospace: 1, cursive: 1, fantasy: 1, math: 1, emoji: 1 };
  var family = function (f) { var n = (f || '').split(',')[0].trim().replace(/^["']|["']$/g, ''); return GENERIC[n] || /^(?:system|ui)-/.test(n) ? '' : n; };
  var out = {};
  var marked = [];
  document.querySelectorAll('[data-ol-shot]').forEach(function (slide) {
    var n = slide.getAttribute('data-ol-shot');
    var sr = slide.getBoundingClientRect();
    var k = slide.offsetWidth ? sr.width / slide.offsetWidth : 1;
    var boxes = [];
    Array.prototype.forEach.call(slide.children, function (el) {
      if (el.matches('aside, script, style, template, link, meta, .notes')) return;
      var cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity < 0.99) return;
      if (cs.transform !== 'none' || cs.writingMode !== 'horizontal-tb' || cs.filter !== 'none') return;
      if (el.matches(BAD) || el.querySelector(BAD)) return;
      if (!(el.textContent || '').trim()) return;
      var r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return;
      var paras = [];
      var cur = null;
      var start = function (block) {
        var bs = getComputedStyle(block);
        var br = block.getBoundingClientRect();
        var size = parseFloat(bs.fontSize) || 16;
        var lh = parseFloat(bs.lineHeight);
        var al = bs.textAlign;
        var p = { runs: [], align: al === 'center' ? 'ctr' : al === 'right' || al === 'end' ? 'r' : al === 'justify' ? 'just' : 'l',
          size: size * 0.75, lineHeight: lh > 0 ? lh / size : undefined, bullet: null, level: 0 };
        var li = block.closest('li');
        if (li && el.contains(li)) {
          var list = li.parentElement;
          var lst = getComputedStyle(li).listStyleType;
          var depth = 0;
          for (var a = li.parentElement; a && a !== el.parentElement; a = a.parentElement) if (a.tagName === 'UL' || a.tagName === 'OL') depth++;
          p.level = Math.max(0, depth - 1);
          if (lst !== 'none' && block === li) {
            if (list && list.tagName === 'OL') { p.bullet = 'num'; p.start = Array.prototype.indexOf.call(list.children, li) + (+(list.getAttribute('start') || 1)); }
            else { p.bullet = 'char'; p.char = lst === 'circle' ? '◦' : lst === 'square' ? '▪' : lst === 'disc' || !lst ? '•' : '•'; }
          }
          if (p.bullet) p.hang = Math.min(48, size * 1.1);
        }
        // where its text begins in the box (CSS px): the box's insets and the paragraphs' margins are worked out from these below
        p.left = (br.left - r.left) / k + (parseFloat(bs.paddingLeft) || 0) + (parseFloat(bs.borderLeftWidth) || 0);
        if (block !== el) {
          p.before = (parseFloat(bs.marginTop) || 0) * 0.75;
          p.after = (parseFloat(bs.marginBottom) || 0) * 0.75;
        }
        paras.push(p);
        cur = p;
      };
      var addText = function (node) {
        var t = node.nodeValue.replace(/[\s ]+/g, function (s) { return s.indexOf(' ') >= 0 ? ' ' : ' '; });
        if (!t) return;
        if (!cur) start(node.parentElement);
        if (!cur.runs.length || cur.runs[cur.runs.length - 1].br) t = t.replace(/^ +/, '');
        if (!t) return;
        var s = getComputedStyle(node.parentElement);
        // (the case as shown: a kicker in capitals is typed in lower case)
        if (s.textTransform === 'uppercase') t = t.toUpperCase();
        else if (s.textTransform === 'lowercase') t = t.toLowerCase();
        var color = hex(s.color);
        if (!color && s.color !== 'transparent') color = undefined;
        var deco = s.textDecorationLine || '';
        var va = s.verticalAlign;
        var run = { text: t, font: family(s.fontFamily) || undefined, size: (parseFloat(s.fontSize) || 16) * 0.75, color: color || undefined,
          bold: (parseInt(s.fontWeight, 10) || 400) >= 600 || undefined, italic: s.fontStyle === 'italic' || s.fontStyle.indexOf('oblique') === 0 || undefined,
          underline: deco.indexOf('underline') >= 0 || undefined, strike: deco.indexOf('line-through') >= 0 || undefined,
          baseline: va === 'super' ? 30 : va === 'sub' ? -25 : undefined };
        cur.runs.push(run);
      };
      var walk = function (node, isRoot) {
        if (node.nodeType === 3) { addText(node); return; }
        if (node.nodeType !== 1) return;
        if (node.matches('script, style, template, aside.notes, .notes')) return;
        var ns = getComputedStyle(node);
        if (ns.display === 'none') return;
        if (node.tagName === 'BR') { if (!cur) start(node.parentElement); cur.runs.push({ text: '', br: true }); return; }
        var block = !INLINE[ns.display];
        if (block && !isRoot) cur = null;
        if (block) start(node);
        Array.prototype.forEach.call(node.childNodes, function (c) { walk(c, false); });
        if (block) cur = null;
      };
      walk(el, true);
      // trailing spaces off, empty paragraphs between blocks dropped (CSS shows none)
      paras.forEach(function (p) { var last = p.runs[p.runs.length - 1]; if (last && !last.br) last.text = last.text.replace(/ +$/, ''); });
      paras = paras.filter(function (p) { return p.runs.some(function (r) { return r.br || r.text; }); });
      if (!paras.length) return;
      var pad = [cs.paddingLeft, cs.paddingTop, cs.paddingRight, cs.paddingBottom].map(function (v) { return (parseFloat(v) || 0); });
      var bw = [cs.borderLeftWidth, cs.borderTopWidth, cs.borderRightWidth, cs.borderBottomWidth].map(function (v) { return (parseFloat(v) || 0); });
      // the left inset: the box's own, less where a bullet hangs out into it; each paragraph's margin from there
      var insetL = pad[0] + bw[0];
      paras.forEach(function (p) { insetL = Math.min(insetL, p.left - (p.hang || 0)); });
      insetL = Math.max(0, insetL);
      paras.forEach(function (p) {
        var m = p.left - insetL;
        if (m > 0.5) p.marL = m;
        if (p.hang) p.indent = -p.hang;
        delete p.left; delete p.hang;
      });
      var flex = cs.display.indexOf('flex') >= 0;
      var col = cs.flexDirection.indexOf('column') === 0;
      var v = flex ? (col ? cs.justifyContent : cs.alignItems) : 'start';
      var anchor = /center/.test(v) ? 'ctr' : /end/.test(v) ? 'b' : 't';
      if (flex && !col && /center/.test(cs.justifyContent)) paras.forEach(function (p) { if (p.align === 'l') p.align = 'ctr'; });
      boxes.push({ x: (r.left - sr.left) / k, y: (r.top - sr.top) / k, w: r.width / k + 2, h: r.height / k,
        insets: [insetL, pad[1] + bw[1], pad[2] + bw[2], pad[3] + bw[3]], anchor: anchor,
        wrap: !(cs.whiteSpace === 'nowrap' || cs.whiteSpace === 'pre') && el.style.width !== 'max-content', paras: paras });
      marked.push(el);
    });
    out[n] = boxes;
  });
  marked.forEach(function (el) { el.setAttribute('data-ol-pptx-text', ''); });
  var st = document.createElement('style');
  st.textContent = '[data-ol-pptx-text], [data-ol-pptx-text] * { color: transparent !important; -webkit-text-fill-color: transparent !important; text-shadow: none !important; text-decoration-color: transparent !important; caret-color: transparent !important; }'
    + '[data-ol-pptx-text] ::marker, [data-ol-pptx-text]::marker { color: transparent !important; }';
  document.head.appendChild(st);
  return out;
})()`;
