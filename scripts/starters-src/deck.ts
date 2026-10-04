/**
 * The starter slide deck (`<user>/example-deck`): a 16:9 deck in OverLyX's Layout mode — pages of
 * freely placed objects, the PowerPoint-style kind of deck — laid out here object by object and
 * written by scripts/gen-starters.ts (which fits the text boxes' heights to the compiled PDF).
 *
 * The talk is a short one about why the sky is blue; its speaker notes are a guided tour of the
 * canvas: each says how the slide it belongs to was made. One grid for every slide: 12 mm margins,
 * a kicker and a 20 pt title at the top of the light slides, a horizon line at 74 mm on the dark
 * ones (where the sun sets from section to section). The colours are defined once in the preamble.
 */
import { writeBoxKeys, writeShapeKeys, writeImageKeys, writePageKeys, parseBoxKeys, parseShapeKeys, parseImageKeys, parsePageKeys, normalizePath, pathToString, pathBounds, type BoxProps, type ShapeProps, type ImageProps, type PageProps } from '../../packages/core/src/index.ts';

export const DECK_PREAMBLE = String.raw`% A slide deck made in OverLyX's Layout mode: 16:9 pages of freely placed objects.
\documentclass[aspectratio=169]{beamer}
\usefonttheme{professionalfonts} % keep beamer from overriding the math fonts
\usepackage[T1]{fontenc}
\usepackage[utf8]{inputenc}
\usepackage[british]{babel}
\usepackage{amsmath}
\usepackage[sfdefault]{notomath} % Noto Sans for text and formulas
\usepackage{graphicx}
\usepackage{booktabs}

% the palette: change a colour here and every slide follows
\definecolor{night}{HTML}{13213C}
\definecolor{paper}{HTML}{FAF7F2}
\definecolor{ink}{HTML}{222838}
\definecolor{mist}{HTML}{6E7487}
\definecolor{rule}{HTML}{E2DCD2}
\definecolor{sky}{HTML}{2F7BF6}
\definecolor{dusk}{HTML}{F2704E}
\definecolor{sun}{HTML}{FFC24B}
\definecolor{leaf}{HTML}{3DAA77}
\definecolor{iris}{HTML}{7A5AF0}
\colorlet{gold}{sun!70!black}

\setbeamertemplate{navigation symbols}{}
\setbeamercolor{normal text}{fg=ink}
\setbeamercolor{itemize item}{fg=sky}
\setbeamertemplate{itemize item}[circle]
`;

/* ------------------------------------------------------------------ objects */

/** text boxes' heights (mm) by slide and name ("4/Caption 1"), measured in the compiled PDF; until then a guess */
export type Heights = Map<string, number>;

const r2 = (n: number) => Math.round(n * 100) / 100;

/** A shape from SVG path data in page millimetres: its box is the path's bounds (a line gets 1 mm of height or width). */
function path(p: Partial<ShapeProps>, d: string): string {
  const segs = normalizePath(d);
  const b = pathBounds(segs);
  let { x, y, w, h } = b;
  if (h < 0.5) { y -= 0.5; h = 1; }
  if (w < 0.5) { x -= 0.5; w = 1; }
  const local = segs.map(s => (s.c === 'Z' ? s : { ...s, p: s.p.map((v, i) => r2(i % 2 === 0 ? v - x : v - y)) })) as typeof segs;
  return `\\olshape{${writeShapeKeys({ ...parseShapeKeys(''), x: r2(x), y: r2(y), w: r2(w), h: r2(h), vb: `0 0 ${r2(w)} ${r2(h)}`, ...p })}}{${pathToString(local)}}`;
}

const rect = (x: number, y: number, w: number, h: number, p: Partial<ShapeProps>) => path(p, `M ${x} ${y} L ${x + w} ${y} L ${x + w} ${y + h} L ${x} ${y + h} Z`);

/** a circle as four Béziers (the editor's ellipse preset) */
const circle = (cx: number, cy: number, r: number, p: Partial<ShapeProps>) => {
  const k = 0.5523 * r;
  return path(p, `M ${cx + r} ${cy} C ${cx + r} ${cy + k} ${cx + k} ${cy + r} ${cx} ${cy + r} C ${cx - k} ${cy + r} ${cx - r} ${cy + k} ${cx - r} ${cy} C ${cx - r} ${cy - k} ${cx - k} ${cy - r} ${cx} ${cy - r} C ${cx + k} ${cy - r} ${cx + r} ${cy - k} ${cx + r} ${cy} Z`);
};

/** the upper half of a circle, standing on y = cy (the setting sun) */
const halfDisc = (cx: number, cy: number, r: number, p: Partial<ShapeProps>) => path(p, `M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy} Z`);

/** a sine wave from x0 to x1 around y (a polyline: smooth at this size) */
const wave = (x0: number, x1: number, y: number, amp: number, period: number, p: Partial<ShapeProps>) => {
  const n = Math.round((x1 - x0) / period * 16);
  const pts = Array.from({ length: n + 1 }, (_, i) => { const x = x0 + (x1 - x0) * i / n; return `${r2(x)} ${r2(y - amp * Math.sin((x - x0) / period * 2 * Math.PI))}`; });
  return path(p, `M ${pts.join(' L ')}`);
};

const image = (p: Partial<ImageProps>, file: string) => `\\olimage{${writeImageKeys({ ...parseImageKeys(''), ...p })}}{${file}}`;

/** a slide: its background, transition and name (\olpage), its objects in drawing order, its speaker notes */
const page = (props: Partial<PageProps>, objects: string[], notes: string) => {
  const keys = writePageKeys({ ...parsePageKeys(''), ...props });
  return `\\begin{frame}[plain]\n${keys ? `\\olpage{${keys}}\n` : ''}${objects.join('\n')}\n\\note{${notes.replace(/\s+/g, ' ').trim()}}\n\\end{frame}`;
};

/* -------------------------------------------------------------------- slides */

const W = 160, M = 12, CW = W - 2 * M, HORIZON = 74;

/**
 * The deck. Every text box that grows with its text has a name of its own on its slide, under which
 * fitDeck (gen-starters.ts) records the height TeX gives its text.
 */
export function deck(heights: Heights = new Map()): string {
  /** the slide being laid out (1-based, as beamer counts frames) */
  let cur = 0;
  /** a text box; one that grows with its text gets the height TeX gave it (by slide and name) */
  const box = (p: Partial<BoxProps>, body: string) => {
    const h = p.grow && p.name ? heights.get(`${cur}/${p.name}`) ?? p.h ?? 8 : p.h ?? 8;
    return `\\begin{olbox}{${writeBoxKeys({ ...parseBoxKeys(''), ...p, h })}}\n${body}\n\\end{olbox}`;
  };
  const slides: string[] = [];
  const next = () => ++cur;

  // the parts every light slide has: kicker and title
  const header = (kicker: string, title: string) => [
    box({ x: M, y: 8, w: CW, h: 3, font: 7, color: 'dusk', grow: true, name: 'Kicker' }, `\\textbf{${kicker}}`),
    box({ x: M, y: 12.5, w: CW, h: 8, font: 20, leading: 1.1, color: 'night', grow: true, name: 'Title' }, `\\textbf{${title}}`),
  ];
  // the dark slides' ground: the horizon, and the talk's title under it
  const horizon = (footer = true) => [
    rect(0, HORIZON, W, 0.3, { fill: 'white!24!night', name: 'Horizon' }),
    ...(footer ? [box({ x: M, y: 78, w: 80, h: 3, font: 7, color: 'white!45!night', grow: true, name: 'Footer' }, 'Why the sky is blue')] : []),
  ];
  // the sun: a disc (or a half disc on the horizon), a faint ring, night-coloured stripes across its lower part
  const sun = (cx: number, cy: number, r: number, fill: string, o: { half?: boolean; ring?: boolean; stripes?: number } = {}) => {
    const out: string[] = [];
    if (o.ring) out.push(circle(cx, cy, r * 1.22, { stroke: 'sun', lw: 0.6, opacity: 0.4, name: 'Sun ring' }));
    out.push(o.half ? halfDisc(cx, cy, r, { fill, name: 'Sun' }) : circle(cx, cy, r, { fill, name: 'Sun' }));
    // the stripes: thicker, the slices of sun between them thinner towards the bottom (gap, stripe, gap, …, stripe, gap)
    const k = o.stripes ?? 0;
    const top = o.half ? cy - r * 0.62 : cy + r * 0.12, bottom = o.half ? cy : cy + r;
    const gaps = Array.from({ length: k + 1 }, (_, i) => 1.6 - 0.9 * i / k), bars = Array.from({ length: k }, (_, i) => 0.7 + 0.8 * i / Math.max(1, k - 1));
    const unit = (bottom - top) / [...gaps, ...bars].reduce((a, b) => a + b, 0);
    let y = top;
    for (let i = 0; i < k; i++) {
      y += gaps[i] * unit;
      out.push(rect(cx - r - 0.5, r2(y), 2 * r + 1, r2(bars[i] * unit), { fill: 'night', name: `Sun stripe ${i + 1}` }));
      y += bars[i] * unit;
    }
    return out;
  };

  /* 1 · title */
  next();
  slides.push(page({ fill: 'night', name: 'Title' }, [
    ...sun(122, 44, 24, 'dusk', { ring: true, stripes: 5 }),
    circle(101, 13, 1.3, { fill: 'sky', name: 'Scattered light' }),
    circle(108.5, 8.5, 0.8, { fill: 'sky', name: 'Scattered light' }),
    circle(95, 19, 0.7, { fill: 'sky', name: 'Scattered light' }),
    ...horizon(false),
    rect(M, 18.5, 8, 0.9, { fill: 'dusk', name: 'Accent' }),
    box({ x: M, y: 22, w: 80, h: 3, font: 7, color: 'sun', grow: true, name: 'Kicker' }, '\\textbf{AN OVERLYX EXAMPLE DECK}'),
    box({ x: M, y: 27, w: 84, h: 27, font: 36, leading: 1.05, color: 'white', grow: true, name: 'Title' }, '\\textbf{Why the sky}\n\n\\textbf{is blue}'),
    box({ x: M, y: 57, w: 84, h: 10, font: 11, leading: 1.3, color: 'white!72!night', grow: true, name: 'Subtitle' }, 'Rayleigh scattering, from one oscillating\n\ndipole to the colour of the sunset'),
    box({ x: M, y: 78, w: 120, h: 4, font: 8.5, color: 'white', grow: true, name: 'Author' }, '\\textbf{@@NAME@@}\\qquad{}\\textcolor{white!60!night}{Your institute\\quad{}·\\quad{}the date of the talk}'),
  ], `Welcome to a canvas deck: slides made of freely placed objects, as in PowerPoint or Keynote.
    Everything on this slide is an object --- the sun, its stripes, every line of text. Click one to select it,
    drag it to move it, pull its handles to resize or rotate it; double-click a text box (or select it and start
    typing) to edit its text. The slide rail on the left shows all slides: click a thumbnail to go there.
    Press F5 to present from the first slide, Shift+F5 from the current one, and S during the presentation for
    the presenter view with these notes.`));

  /* 2 · agenda */
  const parts = [
    ['Light meets air', 'What we see when we look up, and what happens to a sunbeam on its way down.'],
    ['The $\\boldsymbol{\\lambda^{-4}}$ law', 'Why tiny molecules scatter blue light six times more than red.'],
    ['Beyond blue', 'Why clouds are white, why the sky is not violet, and who explained it all.'],
  ];
  next();
  slides.push(page({ fill: 'paper', name: 'Agenda' }, [
    rect(0, 0, 56, 90, { fill: 'night', name: 'Panel' }),
    rect(0, HORIZON, 56, 0.3, { fill: 'white!24!night', name: 'Horizon' }),
    ...sun(40, HORIZON, 8, 'dusk', { half: true, stripes: 2 }),
    box({ x: 10, y: 22, w: 40, h: 10, font: 26, leading: 1.1, color: 'white', grow: true, name: 'Heading' }, '\\textbf{Agenda}'),
    box({ x: 10, y: 34, w: 38, h: 9, font: 9, leading: 1.3, color: 'white!65!night', grow: true, name: 'Heading text' }, 'Three parts, fifteen slides, twenty minutes'),
    ...parts.flatMap(([title, text], i) => {
      const y = 14 + 25 * i;
      return [
        box({ x: 66, y, w: 16, h: 10, font: 24, leading: 1.1, color: 'sky', grow: true, name: `Number ${i + 1}` }, `\\textbf{0${i + 1}}`),
        box({ x: 84, y: y + 1.2, w: 64, h: 6, font: 15, leading: 1.15, color: 'night', grow: true, name: `Part ${i + 1}` }, `\\textbf{${title}}`),
        box({ x: 84, y: y + 8.6, w: 61, h: 9, font: 9.5, leading: 1.3, color: 'mist', grow: true, name: `Part ${i + 1} text` }, text),
        ...(i < 2 ? [rect(66, y + 21.5, 82, 0.25, { fill: 'rule', name: 'Separator' })] : []),
      ];
    }),
  ], `Text boxes carry their own font size, line spacing, colour and alignment: select one and use the Layout
    toolbar or the font size box. While you drag an object, guides snap it to the page's edges and centre and to
    the other objects. To space several objects evenly, select them (Shift+click, or drag a rubber band on the
    empty page) and use Align and distribute. The colours of this deck --- night, paper, sky, dusk, sun --- are
    defined once at the top of the file with \\texttt{\\textbackslash definecolor}: change one there and every
    slide follows.`));

  // a section divider: the number, the title, a line; the sun lower in every section
  const divider = (num: string, title: string, text: string, sunObjs: string[], notes: string) => page({ fill: 'night', transition: 'fade', name: `Section ${num}` }, [
    ...sunObjs,
    ...horizon(),
    box({ x: M, y: 15, w: 70, h: 27, font: 76, leading: 1, color: 'sky', grow: true, name: 'Number' }, `\\textbf{${num}}`),
    box({ x: M, y: 46, w: 90, h: 11, font: 28, leading: 1.1, color: 'white', grow: true, name: 'Section title' }, `\\textbf{${title}}`),
    box({ x: M, y: 59.5, w: 100, h: 5, font: 11, leading: 1.3, color: 'white!70!night', grow: true, name: 'Section text' }, text),
  ], notes);

  /* 3 · section 1 */
  next();
  slides.push(divider('01', 'Light meets air', 'What we see, and what a sunbeam does on its way down', [...sun(128, 26, 9, 'sun', { ring: true }), ...[[111, 15, 1.1], [116.5, 9, 0.7], [107, 23, 0.6], [143.5, 39, 0.8]].map(([x, y, r]) => circle(x, y, r, { fill: 'sky', name: 'Scattered light' }))],
    `A section divider is an ordinary slide with a background colour and a transition: the Page menu on the
    Layout toolbar sets both (this one fades in). New slide adds a slide with the layout you pick; drag the
    thumbnails in the rail to reorder slides, and duplicate or delete a slide from its thumbnail's menu. A
    duplicated slide is the quickest way to keep a deck consistent.`));

  /* 4 · two cropped pictures */
  const crop: [number, number][] = [[0, 0.5], [0.5, 0]];
  next();
  slides.push(page({ fill: 'paper', name: 'Noon and sunset' }, [
    ...header('01 · LIGHT MEETS AIR', 'Look up at noon, then west at dusk'),
    ...crop.flatMap(([l, r], i) => {
      const x = M + 70 * i;
      return [
        image({ x, y: 27, w: 66, h: 40, crop: [l, 0.06, r, 0.0309], name: i ? 'Sunset' : 'Noon' }, 'figures/sky'),
        box({ x: x + 3, y: 30, w: 13, h: 5, fill: 'white', radius: 2.5, valign: 'c', font: 7, color: 'night', align: 'center', name: i ? 'Time 2' : 'Time 1' }, i ? '\\textbf{19:42}' : '\\textbf{12:00}'),
        box({ x, y: 70, w: 66, h: 8, font: 9, leading: 1.3, color: 'ink', grow: true, name: `Caption ${i + 1}` },
          i ? '\\textbf{Sunset.} The sun itself turns orange and red, illuminating the clouds from below.' : '\\textbf{Noon.} The whole sky glows blue, and its light reaches us from everywhere.'),
      ];
    }),
  ], `Both pictures are one file, figures/sky.pdf, placed twice and cropped differently. Double-click an image
    (or select it and press C) to crop it: the handles crop, and dragging inside moves the picture in its frame.
    To use a picture of your own, drop a PNG, JPEG or PDF onto the slide, or use the image button on the Layout
    toolbar. The time labels are text boxes with a white fill and rounded corners.`));

  /* 5 · diagram */
  const beam = [['sky', -1.2], ['leaf', 0], ['dusk', 1.2]] as const;
  next();
  slides.push(page({ fill: 'paper', name: 'Diagram' }, [
    ...header('01 · LIGHT MEETS AIR', 'One sunbeam, two fates'),
    circle(24, 54, 11, { stroke: 'sun', lw: 0.6, opacity: 0.6, name: 'Sun ring' }),
    circle(24, 54, 8, { fill: 'sun', name: 'Sun' }),
    box({ x: 8, y: 68, w: 32, h: 7, font: 8, leading: 1.25, color: 'mist', align: 'center', grow: true, name: 'Sun label' }, 'Sunlight:\n\nall colours at once'),
    ...beam.map(([c, dy]) => path({ stroke: c, lw: 1.2, name: 'Beam' }, `M 37 ${54 + dy} L 62 ${54 + dy}`)),
    box({ x: 62, y: 42, w: 28, h: 24, fill: 'white', stroke: 'rule', lw: 0.6, radius: 3, name: 'Molecule card' }, ''),
    circle(70.2, 49.5, 1.7, { fill: 'night', name: 'N' }), circle(73.2, 49.5, 1.7, { fill: 'night', name: 'N' }),
    circle(79.2, 51, 1.7, { fill: 'sky', name: 'O' }), circle(82.2, 51, 1.7, { fill: 'sky', name: 'O' }),
    box({ x: 63, y: 56, w: 26, h: 7, font: 7.5, leading: 1.25, color: 'mist', align: 'center', grow: true, name: 'Molecule label' }, 'air molecules,\n\nN$_{2}$ and O$_{2}$'),
    path({ stroke: 'sky', lw: 1.2, arrows: '-Stealth', step: '2-', effect: 'wipe', name: 'Scattered' }, 'M 90.5 48 C 94 48 95 37 98.5 37'),
    box({ x: 99.5, y: 28, w: 48.5, h: 18, fill: 'sky!10!paper', radius: 2.5, pad: 3, font: 8.5, leading: 1.3, color: 'ink', grow: true, step: '2-', effect: 'fade', name: 'Blue card' },
      '\\textcolor{sky}{\\textbf{Blue scatters sideways}}\n\nYour eyes catch it from every direction: the sky glows blue.'),
    path({ stroke: 'dusk', lw: 1.2, arrows: '-Stealth', step: '3-', effect: 'wipe', name: 'Transmitted' }, 'M 90.5 60 C 94 60 95 67 98.5 67'),
    box({ x: 99.5, y: 58, w: 48.5, h: 18, fill: 'dusk!10!paper', radius: 2.5, pad: 3, font: 8.5, leading: 1.3, color: 'ink', grow: true, step: '3-', effect: 'fade', name: 'Red card' },
      '\\textcolor{dusk}{\\textbf{Red goes straight on}}\n\nAt sunset the path is 40 times longer: orange and red remain.'),
  ], `Diagrams are shapes and arrows: R draws a rectangle, E an ellipse, L a line and A an arrow; the arrows here
    are curves with a tip (Arrow tips on the Layout toolbar), and N edits a shape's nodes. The two branches
    appear one after the other: select objects and give them an animation step and an entrance effect under
    Animation (steps 2 and 3 here). In the PDF every step becomes a page of its own --- beamer overlays.`));

  /* 6 · section 2 */
  next();
  slides.push(divider('02', 'The $\\boldsymbol{\\lambda^{-4}}$ law', 'Why small molecules prefer short waves', sun(128, 44, 11, 'sun!40!dusk', { ring: true, stripes: 2 }),
    `This divider fades in as well. The section numbers and the sun that sinks from divider to divider are
    ordinary objects: copy them from one slide to another with Ctrl+C and Ctrl+V, or duplicate a selected object
    with Ctrl+D.`));

  /* 7 · formula, step by step */
  const rows = [
    ['Light shakes the molecule', 'a dipole, driven by the field', 'p(t)=\\alpha\\,E_{0}\\cos\\omega t'],
    ['The dipole radiates', 'its power grows as $\\omega^{4}$', 'P=\\frac{\\alpha^{2}E_{0}^{2}}{12\\pi\\varepsilon_{0}c^{3}}\\,\\omega^{4}'],
    ['Frequency is wavelength', 'short waves oscillate faster', '\\omega=\\frac{2\\pi c}{\\lambda}\\quad\\Longrightarrow\\quad P\\propto\\lambda^{-4}'],
    ['Blue against red', '$450\\,\\mathrm{nm}$ against $700\\,\\mathrm{nm}$', '\\frac{P_{\\text{blue}}}{P_{\\text{red}}}=\\left(\\frac{700}{450}\\right)^{4}\\approx5.9'],
  ];
  next();
  slides.push(page({ fill: 'paper', name: 'Formula' }, [
    ...header('02 · THE $\\boldsymbol{\\lambda^{-4}}$ LAW', 'Where the fourth power comes from'),
    // the thread between the numbers grows with the rows
    ...[1, 2, 3].map(k => rect(14.85, 36 + 13.5 * (k - 1), 0.3, 7.5, { fill: 'rule', step: `${k + 1}-`, effect: 'fade', name: `Thread ${k}` })),
    ...rows.flatMap(([label, text, tex], i) => {
      const y = 27 + 13.5 * i;
      const anim = i ? { step: `${i + 1}-`, effect: 'fade' } : {};
      return [
        box({ x: 12, y: y + 3, w: 6, h: 6, fill: 'sky', shape: 'ellipse', valign: 'c', font: 8, color: 'white', align: 'center', ...anim, name: `Step ${i + 1}` }, `\\textbf{${i + 1}}`),
        box({ x: 22, y, w: 54, h: 12, valign: 'c', font: 9.5, leading: 1.25, color: 'ink', ...anim, name: `Step ${i + 1} text` }, `\\textbf{${label}}\n\n\\textcolor{mist}{${text}}`),
        box({ x: 80, y, w: 68, h: 12, valign: 'c', font: 11, color: 'night', ...(i === 3 ? { fill: 'sun!28!paper', radius: 2.5 } : {}), ...anim, name: `Step ${i + 1} formula` }, `\\[\n${tex}\n\\]`),
      ];
    }),
  ], `Formulas are typed exactly as in OverLyX documents: in a text box, press Ctrl+M (or type a dollar sign) and
    write LaTeX --- the formula renders as you type, in the fonts of the PDF. Each row appears on a click of its
    own: rows 2 to 4 have the animation steps 2-, 3- and 4- with a fade. Present with F5 and step through with
    Space or the arrow keys.`));

  /* 8 · one big number */
  next();
  slides.push(page({ fill: 'sky', transition: 'push', name: 'Big number' }, [
    box({ x: M, y: 10, w: 96, h: 3, font: 7, color: 'white!78!sky', grow: true, name: 'Kicker' }, '\\textbf{02 · THE $\\boldsymbol{\\lambda^{-4}}$ LAW}'),
    box({ x: 10, y: 18, w: 100, h: 32, font: 120, leading: 1, color: 'white', grow: true, name: 'Number' }, '\\textbf{5.9×}'),
    box({ x: M, y: 55, w: 96, h: 14, font: 17, leading: 1.2, color: 'white', grow: true, name: 'Statement' }, 'more blue light than red is scattered out of every sunbeam'),
    box({ x: M, y: 73, w: 96, h: 4, font: 9, color: 'white!80!sky', grow: true, name: 'Formula' }, '$(700\\,\\mathrm{nm}/450\\,\\mathrm{nm})^{4}=1.556^{4}\\approx5.9$'),
    rect(114, 76, 34, 0.3, { fill: 'white!60!sky', step: '2-', effect: 'fade', name: 'Baseline' }),
    rect(118, 76 - 5.86 * 7.5, 11, 5.86 * 7.5, { fill: 'white', step: '2-', effect: 'fly-up', name: 'Blue bar' }),
    rect(134, 76 - 7.5, 11, 7.5, { fill: 'dusk', step: '2-', effect: 'fly-up', name: 'Red bar' }),
    box({ x: 113.5, y: 76 - 5.86 * 7.5 - 6, w: 20, h: 4, font: 9, color: 'white', align: 'center', step: '2-', effect: 'fade', grow: true, name: 'Blue value' }, '\\textbf{5.9}'),
    box({ x: 129.5, y: 76 - 7.5 - 6, w: 20, h: 4, font: 9, color: 'white', align: 'center', step: '2-', effect: 'fade', grow: true, name: 'Red value' }, '\\textbf{1}'),
    box({ x: 113.5, y: 78, w: 20, h: 3, font: 7, color: 'white!80!sky', align: 'center', step: '2-', effect: 'fade', grow: true, name: 'Blue label' }, '$450\\,\\mathrm{nm}$'),
    box({ x: 129.5, y: 78, w: 20, h: 3, font: 7, color: 'white!80!sky', align: 'center', step: '2-', effect: 'fade', grow: true, name: 'Red label' }, '$700\\,\\mathrm{nm}$'),
  ], `A bold statement needs only two things: a background colour for the page (the Page menu on the Layout
    toolbar) and a very large font size --- this number is a text box set at 120 pt. The two bars rise on the
    second click (effect: fly up), and the slide itself comes in with a push transition.`));

  /* 9 · a plot with callouts: the figure's axis is 84 mm x 40 mm, its corner 12 mm in and 11 mm up (figures/scattering.tex) */
  const fig = { x: M, y: 26, w: 100, h: 54 };
  const X = (nm: number) => r2(fig.x + 12 + (nm - 380) / 380 * 84);
  const Y = (v: number) => r2(fig.y + fig.h - 11 - v / 12 * 40);
  const at = (nm: number) => [X(nm), Y((700 / nm) ** 4)] as const;
  const dot = (nm: number, name: string) => circle(at(nm)[0], at(nm)[1], 1.1, { fill: 'night', stroke: 'paper', lw: 0.8, name });
  const [vx, vy] = at(400), [bx, by] = at(450), [rx, ry] = at(700);
  next();
  slides.push(page({ fill: 'paper', name: 'Plot' }, [
    ...header('02 · THE $\\boldsymbol{\\lambda^{-4}}$ LAW', 'Blue scatters far more than red'),
    image({ ...fig, name: 'Plot' }, 'figures/scattering'),
    path({ stroke: 'ink', lw: 0.5, name: 'Violet leader' }, `M ${vx + 0.9} ${vy - 0.9} L ${vx + 4} ${r2(vy - 7.2)} L ${vx + 6} ${r2(vy - 7.2)}`),
    dot(400, 'Violet point'),
    box({ x: r2(vx + 6.8), y: r2(vy - 9.4), w: 74, h: 4, font: 8, color: 'ink', grow: true, name: 'Violet callout' }, '\\textbf{Violet scatters most of all}\\,--- so why is the sky not violet?'),
    path({ stroke: 'ink', lw: 0.5, name: 'Blue leader' }, `M ${bx + 0.9} ${by - 0.9} L ${bx + 7} ${r2(by - 8)} L ${bx + 12} ${r2(by - 8)}`),
    dot(450, 'Blue point'),
    box({ x: r2(bx + 12.8), y: r2(by - 10.3), w: 38, h: 7, font: 8, leading: 1.25, color: 'ink', grow: true, name: 'Blue callout' }, '\\textbf{Blue,} $\\mathbf{450\\,nm}$\n\n5.9 times as much as red'),
    path({ stroke: 'ink', lw: 0.5, name: 'Red leader' }, `M ${rx} ${ry - 1.3} L ${rx} ${r2(ry - 6)}`),
    dot(700, 'Red point'),
    box({ x: r2(rx - 14), y: r2(ry - 14), w: 28, h: 7, font: 8, leading: 1.25, color: 'ink', align: 'center', grow: true, name: 'Red callout' }, '\\textbf{Red,} $\\mathbf{700\\,nm}$\n\nthe reference: 1'),
    rect(115, 27, 0.3, 52, { fill: 'rule', name: 'Divider' }),
    box({ x: 118.5, y: 27, w: 29.5, h: 5, font: 10, leading: 1.2, color: 'night', grow: true, name: 'Panel heading' }, '\\textbf{How to read it}'),
    box({ x: 118.5, y: 33.5, w: 29.5, h: 30, font: 8.5, leading: 1.3, color: 'ink', grow: true, name: 'Panel text' }, 'The curve is\n\\[\n\\left(\\frac{700\\,\\mathrm{nm}}{\\lambda}\\right)^{4}\n\\]\nHalve the wavelength\n\nand 16 times as much\n\nlight is scattered.'),
    box({ x: 118.5, y: 71, w: 29.5, h: 7, font: 7, leading: 1.3, color: 'mist', grow: true, name: 'Panel note' }, 'Computed from Rayleigh\'s law, not measured.'),
  ], `The plot is a PDF made with pgfplots (figures/scattering.pdf), placed as an image. The callouts on top of it
    --- dots, leader lines and labels --- are ordinary objects, so they stay editable and can be moved one by one.
    Select several and press Ctrl+G to group them (Ctrl+Shift+G ungroups). A plot that should be compiled with
    the deck can be a raw LaTeX object instead (the TeX button on the Layout toolbar).`));

  /* 10 · section 3 */
  next();
  slides.push(divider('03', 'Beyond blue', 'Clouds, violet, and who worked it all out', sun(128, HORIZON, 15, 'dusk', { half: true, stripes: 3 }),
    `Last section. Speaker notes like these belong to their slide: they show under the slides when Speaker notes
    is switched on (the notes button on the Layout toolbar), in the presenter view (S while presenting), and in
    the file they are beamer's \\texttt{\\textbackslash note}.`));

  /* 11 · comparison */
  const sides = [
    { x: M, fill: 'sky!9!paper', title: 'Rayleigh scattering', sub: 'tiny particles, far smaller than the wavelength: molecules',
      rows: ['strongly colour-dependent, $\\propto\\lambda^{-4}$', 'forwards and backwards alike', 'the blue sky and the red sunset'] },
    { x: 83, fill: 'night!6!paper', title: 'Mie scattering', sub: 'particles as large as the wavelength, or larger: droplets',
      rows: ['nearly the same for all colours', 'mostly forwards', 'white clouds, grey haze and fog'] },
  ];
  next();
  slides.push(page({ fill: 'paper', name: 'Comparison' }, [
    ...header('03 · BEYOND BLUE', 'Why clouds are white'),
    ...sides.flatMap((s, i) => [
      box({ x: s.x, y: 27, w: 65, h: 53, fill: s.fill, radius: 3, lock: true, name: `Card ${i + 1}` }, ''),
      wave(s.x + 6, s.x + 30, 34, 2.2, 8, { stroke: i ? 'mist' : 'sky', lw: 1, name: 'Wave' }),
      i ? circle(s.x + 40, 34, 4.6, { fill: 'white', stroke: 'mist', lw: 0.6, name: 'Droplet' }) : circle(s.x + 34, 34, 0.9, { fill: 'night', name: 'Molecule' }),
      box({ x: s.x + 6, y: 41, w: 54, h: 6, font: 13, leading: 1.15, color: 'night', grow: true, name: `Side ${i + 1} title` }, `\\textbf{${s.title}}`),
      box({ x: s.x + 6, y: 47.5, w: 51, h: 7, font: 8, leading: 1.3, color: 'mist', grow: true, name: `Side ${i + 1} text` }, s.sub),
      ...['COLOUR', 'DIRECTION', 'WHERE YOU SEE IT'].flatMap((label, k) => [
        box({ x: s.x + 6, y: 56.5 + 7.6 * k, w: 54, h: 3, font: 6.5, color: 'mist', grow: true, name: `Side ${i + 1} label ${k + 1}` }, `\\textbf{${label}}`),
        box({ x: s.x + 6, y: 59.4 + 7.6 * k, w: 54, h: 4, font: 9, color: 'ink', grow: true, name: `Side ${i + 1} row ${k + 1}` }, s.rows[k]),
      ]),
    ]),
    box({ x: 76, y: 49.5, w: 8, h: 8, fill: 'night', shape: 'ellipse', valign: 'c', font: 8, color: 'white', align: 'center', name: 'Versus' }, '\\textbf{vs}'),
  ], `Two columns are two cards: a text box with a fill and rounded corners (the text box settings on the Layout
    toolbar) and the text boxes on top of it. The cards are locked, so that clicks reach the text on them --- the
    lock button unlocks them. The waves are shapes too: double-click one to edit its nodes, or draw your own with
    the pen (B).`));

  /* 12 · table */
  const colours = [['iris', 'Violet', 400], ['sky', 'Blue', 450], ['leaf', 'Green', 530], ['gold', 'Yellow', 580], ['dusk', 'Red', 700]] as const;
  const table = '\\begin{tabular}{lrr}\n\\toprule\n\\textbf{Colour} & \\textbf{Wavelength} & \\textbf{Scattered}\\tabularnewline\n\\midrule\n'
    + colours.map(([c, name, nm]) => `\\textcolor{${c}}{\\textbf{${name}}} & ${nm} nm & ${((700 / nm) ** 4).toFixed(1)}\\tabularnewline\n`).join('')
    + '\\bottomrule\n\\end{tabular}';
  const reasons = [
    'Sunlight brings less violet than blue.',
    'Our eyes are much less sensitive to violet.',
    'The mix of violet, blue and green looks pale blue.',
  ];
  next();
  slides.push(page({ fill: 'paper', name: 'Table' }, [
    ...header('03 · BEYOND BLUE', 'Why is the sky not violet?'),
    box({ x: M, y: 29, w: 78, h: 38, font: 12, color: 'ink', grow: true, name: 'Table' }, table),
    box({ x: M, y: 72, w: 78, h: 4, font: 7.5, leading: 1.3, color: 'mist', grow: true, name: 'Table note' }, 'Light scattered, relative to red: $(700\\,\\mathrm{nm}/\\lambda)^{4}$.'),
    rect(96, 29, 0.3, 50, { fill: 'rule', name: 'Divider' }),
    box({ x: 100, y: 29, w: 48, h: 5, font: 11, leading: 1.2, color: 'night', grow: true, name: 'Reasons heading' }, '\\textbf{Three reasons}'),
    ...reasons.flatMap((text, i) => [
      box({ x: 100, y: 38 + 13 * i, w: 6, h: 6, fill: 'dusk', shape: 'ellipse', valign: 'c', font: 8, color: 'white', align: 'center', name: `Reason ${i + 1} number` }, `\\textbf{${i + 1}}`),
      box({ x: 109, y: 38.3 + 13 * i, w: 39, h: 11, font: 9, leading: 1.3, color: 'ink', grow: true, name: `Reason ${i + 1}` }, text),
    ]),
  ], `Tables live in text boxes and are edited as in documents: the table button on the toolbar (Ctrl+Alt+T)
    inserts one, and Tab moves from cell to cell; the rules are booktabs. Text is coloured as anywhere else in OverLyX, with the colours of the preamble. The
    numbered circles are text boxes with an ellipse shape.`));

  /* 13 · timeline */
  const events = [
    ['1869', 'John Tyndall sees\n\na beam of light turn\n\nblue in fine mist'],
    ['1871', 'Lord Rayleigh finds\n\nthe $\\lambda^{-4}$ law for\n\ntiny particles'],
    ['1899', 'Rayleigh shows\n\nthat air molecules\n\nalone are enough'],
    ['1908', 'Gustav Mie solves\n\nscattering by spheres\n\nof any size'],
    ['1910', 'Albert Einstein\n\nlinks it to changes\n\nin the air\'s density'],
  ];
  next();
  slides.push(page({ fill: 'paper', transition: 'wipe', name: 'Timeline' }, [
    ...header('03 · BEYOND BLUE', '150 years of looking up'),
    path({ stroke: 'mist!50!paper', lw: 0.8, arrows: '-Stealth', name: 'Time axis' }, `M ${M} 52 L ${W - M} 52`),
    ...events.flatMap(([year, text], i) => {
      const x = 22 + 28.5 * i;
      const anim = (effect: string) => (i ? { step: `${i + 1}-`, effect } : {});
      return [
        circle(x, 52, 2.2, { fill: i === 1 ? 'dusk' : 'sky', stroke: 'paper', lw: 1.2, ...anim('zoom'), name: `${year} dot` }),
        box({ x: x - 12, y: 41, w: 24, h: 6, font: 15, color: 'night', align: 'center', grow: true, ...anim('fade'), name: `${year} year` }, `\\textbf{${year}}`),
        box({ x: x - 13.5, y: 58, w: 27, h: 14, font: 7.5, leading: 1.3, color: 'ink', align: 'center', grow: true, ...anim('fade'), name: `${year} text` }, text),
      ];
    }),
  ], `The milestones appear one at a time (steps 2 to 5), and the slide comes in with a wipe. Even spacing is
    what Align and distribute is for: select the five dots and choose Distribute horizontally. The arrow keys
    nudge a selection by 1 mm, with Shift by 10 mm.`));

  /* 14 · the talk in one sentence */
  next();
  slides.push(page({ fill: 'paper', name: 'Quote' }, [
    box({ x: 15, y: 13, w: 30, h: 40, font: 110, leading: 1, color: 'dusk', name: 'Quote mark' }, '\\textbf{``}'),
    box({ x: 30, y: 30, w: 118, h: 29, font: 22, leading: 1.22, color: 'night', grow: true, name: 'Quote' }, 'The blue of the sky and the red\n\nof the sunset are the same\n\nsunlight, sorted by the air.'),
    rect(30, 64.5, 8, 0.9, { fill: 'dusk', name: 'Accent' }),
    box({ x: 30, y: 67.5, w: 100, h: 4, font: 10, color: 'mist', grow: true, name: 'Attribution' }, 'The whole talk in one sentence'),
  ], `Build the PDF with Ctrl+R (or the build button). Every slide becomes a page and every animation step an
    overlay page; OverLyX then compares each text box with the PDF and marks a box whose text runs out of it ---
    click the mark to make the box tall enough.`));

  /* 15 · questions */
  const stars = [[97, 12, 0.5], [112, 21, 0.35], [124, 9, 0.6], [139, 15, 0.4], [151, 27, 0.5], [104, 33, 0.35], [146, 44, 0.45], [118, 41, 0.3], [133, 31, 0.3], [154, 9, 0.35]];
  next();
  slides.push(page({ fill: 'night', transition: 'dissolve', name: 'Questions' }, [
    ...stars.map(([x, y, r]) => circle(x, y, r, { fill: 'white', opacity: 0.8, name: 'Star' })),
    ...sun(128, HORIZON, 9, 'dusk!80!night', { half: true, stripes: 2 }),
    rect(0, HORIZON, W, 0.3, { fill: 'white!24!night', name: 'Horizon' }),
    box({ x: M, y: 26, w: 90, h: 15, font: 40, leading: 1.05, color: 'white', grow: true, name: 'Questions' }, '\\textbf{Questions?}'),
    box({ x: M, y: 43.5, w: 90, h: 6, font: 14, leading: 1.2, color: 'white!72!night', grow: true, name: 'Thanks' }, 'Thank you for looking up.'),
    box({ x: M, y: 56, w: 90, h: 4, font: 10, color: 'white', grow: true, name: 'Name' }, '\\textbf{@@NAME@@}'),
    box({ x: M, y: 61.5, w: 90, h: 4, font: 8.5, color: 'white!65!night', grow: true, name: 'Contact' }, 'you@example.org'),
    box({ x: M, y: 78, w: 120, h: 3, font: 7, color: 'white!45!night', grow: true, name: 'Footer' }, 'Slides made with OverLyX: every object on them is yours to change.'),
  ], `To start a deck of your own: File, New slides / poster / page\\ldots{}, and pick Slides 16:9 --- or keep this
    project and replace its content slide by slide. The file, deck.tex, is an ordinary beamer document: it
    compiles anywhere, and its history stays readable. Delete this project when you no longer need it.`));

  return `${DECK_PREAMBLE}\\begin{document}\n${slides.join('\n\n')}\n\\end{document}\n`;
}
