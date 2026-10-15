/**
 * GUI diagnostic for small slide-math shifts. It compares the painted MathJax SVG glyphs with the
 * CHTML glyphs shown by LyX's formula editor, while recording the underlying chip, the overlay's
 * zero-height baseline mark, and the canvas/frame transforms. It creates and edits the deck only
 * through the visible UI. This is intentionally a diagnostic gate: measurements and screenshots
 * are written before tight assertions so a failure remains useful evidence.
 */
import { test, expect, type Locator, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { login, PROJECTS_DIR, userCredentials } from './helpers';
import { readLogicalMath, logicalMathProblems, type LogicalMathGeometry } from './math-stability-oracle';

const RUN = process.env.OVERLYX_MATH_STABILITY_RUN ?? Date.now().toString(36);
const NAME = `math-stability-${RUN}`;
const PROJECT = `luna4/${NAME}`;
const FILE = path.join(PROJECTS_DIR, 'luna4', NAME, 'slides', 'index.html');
const EVIDENCE = path.resolve(`scratch/slide-audit/evidence/math-stability/${RUN}`);
const DPR = 2;
const VIEWPORT = { width: 1920, height: 1200 };
const frame = (page: Page) => page.frameLocator('.dl-frame');
const slides = (page: Page) => frame(page).locator('section.slide');
const rail = (page: Page) => page.frameLocator('.dl-railframe').locator('section.slide');

type Rect = { x: number; y: number; width: number; height: number };

async function twoFrames(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

async function hostBounds(page: Page) {
  const canvas = await page.locator('.dl-canvas').boundingBox();
  const iframe = page.locator('.dl-frame');
  const frameRect = await iframe.boundingBox();
  const intrinsic = await iframe.evaluate(el => ({ width: el.clientWidth, height: el.clientHeight }));
  const toolbarControl = await page.locator('[data-dl-zoom]').boundingBox();
  if (!canvas || !frameRect || !intrinsic.width || !intrinsic.height) throw new Error('Canvas or iframe bounds are unavailable');
  return {
    canvas, frame: frameRect, intrinsic,
    scaleX: frameRect.width / intrinsic.width,
    scaleY: frameRect.height / intrinsic.height,
    zoomControl: toolbarControl,
  };
}

/** Page-space SVG viewport, viewBox baseline, and actual painted vector descendants. */
async function svgMetrics(root: Locator) {
  return root.evaluate(el => {
    const svgs = Array.from(el.querySelectorAll(':scope > svg')) as SVGSVGElement[];
    if (!svgs.length) throw new Error('No direct MathJax SVGs found under the formula root');
    const parts = svgs.map(svg => {
      const r = svg.getBoundingClientRect();
      const vb = svg.viewBox.baseVal;
      const raw = svg.getAttribute('data-mjx-viewBox')?.trim().split(/[\s,]+/).map(Number);
      const vx = vb.width ? vb.x : raw?.[0] ?? 0;
      const vy = vb.height ? vb.y : raw?.[1] ?? 0;
      const vw = vb.width ? vb.width : raw?.[2] ?? 0;
      const vh = vb.height ? vb.height : raw?.[3] ?? 0;
      if (!vh || !r.height) throw new Error('MathJax SVG has no measurable viewBox');
      const paths = Array.from(svg.querySelectorAll('use, path, rect, line, circle, ellipse, polygon, polyline'))
        .filter(node => !node.closest('defs'))
        .map(node => {
          const g = node.getBoundingClientRect();
          return { x: g.x, y: g.y, width: g.width, height: g.height, tag: node.localName };
        })
        .filter(box => box.width > 0 && box.height > 0);
      return {
        viewport: { x: r.x, y: r.y, width: r.width, height: r.height },
        viewBox: { x: vx, y: vy, width: vw, height: vh },
        verticalAlign: getComputedStyle(svg).verticalAlign,
        baseline: r.top - vy / vh * r.height,
        inkRuns: paths,
      };
    });
    const rect = el.getBoundingClientRect();
    const baselines = parts.map(p => p.baseline);
    const styleMetrics = (node: Element) => {
      const r = node.getBoundingClientRect();
      const cs = getComputedStyle(node);
      return {
        tag: node.localName,
        className: typeof node.className === 'string' ? node.className : node.getAttribute('class'),
        rect: { x: r.x, y: r.y, width: r.width, height: r.height },
        fontFamily: cs.fontFamily, fontSize: cs.fontSize, letterSpacing: cs.letterSpacing,
        marginLeft: cs.marginLeft, marginRight: cs.marginRight,
      };
    };
    const breaks = Array.from(el.querySelectorAll('mjx-break')).map(styleMetrics);
    return {
      tex: el.querySelector('svg [data-mml-node="math"]')?.getAttribute('data-latex') ?? el.textContent ?? '',
      rootRect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      rootStyle: styleMetrics(el),
      parts,
      breakGlue: breaks,
      baseline: baselines.reduce((a, b) => a + b, 0) / baselines.length,
      inkRunCount: parts.reduce((n, p) => n + p.inkRuns.length, 0),
    };
  });
}

async function editorMetrics(page: Page) {
  const root = page.locator('.dl-mathedit .lm-content mjx-container').first();
  await expect(root).toBeVisible();
  const editorRoot = await root.evaluate(el => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const verticalAlign = cs.verticalAlign;
    const value = Number.parseFloat(verticalAlign);
    let verticalAlignPx: number | null = null;
    if (Number.isFinite(value) && /px$/.test(verticalAlign)) verticalAlignPx = value;
    else if (Number.isFinite(value) && /ex$/.test(verticalAlign)) {
      // Resolve ex using the CHTML element's own font without changing document flow.
      const probe = document.createElement('span');
      probe.style.cssText = `position:fixed;left:-10000px;top:-10000px;visibility:hidden;display:block;width:0;height:1ex;line-height:0;font-family:${cs.fontFamily};font-size:${cs.fontSize};font-style:${cs.fontStyle};font-weight:${cs.fontWeight}`;
      document.body.append(probe);
      verticalAlignPx = value * probe.getBoundingClientRect().height;
      probe.remove();
    } else if (Number.isFinite(value) && /em$/.test(verticalAlign)) verticalAlignPx = value * parseFloat(cs.fontSize);
    const breakGlue = Array.from(el.querySelectorAll('mjx-break')).map(node => {
      const b = node.getBoundingClientRect(), s = getComputedStyle(node);
      return {
        rect: { x: b.x, y: b.y, width: b.width, height: b.height },
        fontFamily: s.fontFamily, fontSize: s.fontSize, letterSpacing: s.letterSpacing,
        marginLeft: s.marginLeft, marginRight: s.marginRight,
      };
    });
    return {
      rect: { x: r.x, y: r.y, width: r.width, height: r.height },
      verticalAlign, verticalAlignPx, fontFamily: cs.fontFamily, fontSize: cs.fontSize, breakGlue,
      baselineEstimate: verticalAlignPx !== null ? r.bottom + verticalAlignPx : null,
      mathText: el.textContent ?? '',
    };
  });
  const baseline = await page.locator('.dl-mathedit-base').evaluate(el => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height, top: r.top, bottom: r.bottom };
  });
  const activeChip = frame(page).locator('.ol-mathchip[data-ol-mathediting]').first();
  const chip = await activeChip.evaluate(el => {
    const r = el.getBoundingClientRect();
    const root = el.querySelector('mjx-container');
    const rr = root?.getBoundingClientRect();
    const svgs = Array.from(root?.querySelectorAll(':scope > svg') ?? []) as SVGSVGElement[];
    const svgBaselines = svgs.map(svg => {
      const b = svg.getBoundingClientRect(), vb = svg.viewBox.baseVal;
      return b.top - vb.y / vb.height * b.height;
    });
    return {
      className: el.className,
      visibility: getComputedStyle(el).visibility,
      rect: { x: r.x, y: r.y, width: r.width, height: r.height },
      mathRect: rr ? { x: rr.x, y: rr.y, width: rr.width, height: rr.height } : null,
      baseline: svgBaselines.length ? svgBaselines.reduce((a, b) => a + b, 0) / svgBaselines.length : null,
    };
  });
  return { editorRoot, zeroBaselineMarker: baseline, underlyingChip: chip };
}

async function installDiagnosticStyles(page: Page): Promise<void> {
  // Only suppress drawing aids, selection outlines, the floating formatting bar and the caret.
  // No styles that affect text, font metrics, layout, scale, or positioning are changed.
  await page.addStyleTag({ content: '.dl-mathedit .lm-overlay { display:none !important } .dl-mathedit .lm-field { outline:none !important } .dl-quick { visibility:hidden !important }' });
  await frame(page).locator('html').evaluate(html => {
    let style = html.querySelector<HTMLStyleElement>('#ol-math-stability-test-style');
    if (!style) {
      style = document.createElement('style');
      style.id = 'ol-math-stability-test-style';
      style.textContent = 'ol-overlay { visibility:hidden !important }';
      html.appendChild(style);
    }
  });
}

async function addDisplayFormula(page: Page, tex: string, y: number, index: number): Promise<Locator> {
  // Use the template's mostly blank title slide so GUI insertion cannot collide with its content
  // slide's existing figure card or illustration.
  const pageSlide = slides(page).first();
  await rail(page).first().click();
  await expect(pageSlide).toBeVisible();
  await page.locator('[data-tb="dk-formula"]').click();
  const box = await pageSlide.boundingBox();
  if (!box) throw new Error('Content slide has no visible canvas box');
  // Place the formulas down a clear central column. Coordinates are taken from the visible slide,
  // and the pointer click itself inserts the formula through the GUI.
  await page.mouse.click(box.x + box.width * 0.52, box.y + box.height * y / 720);
  const field = page.locator('[data-dl-mathedit] .lm-field');
  await expect(field).toBeVisible();
  await page.keyboard.type(tex, { delay: 2 });
  await twoFrames(page);
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-dl-mathedit]')).toHaveCount(0, { timeout: 5000 });
  await page.keyboard.press('Escape');
  // TeX serialization is canonicalized by the math field (for example x^2 becomes x^{2}),
  // so validate the number of saved display blocks rather than comparing the raw keystrokes.
  await expect.poll(() => (readFileSync(FILE, 'utf8').match(/\\\[/g) ?? []).length, { timeout: 15000 }).toBe(index);
  // Drawing saves the empty placeholder before the finished formula. Its block count can
  // already be correct while that final save is in flight (observed in WebKit). Require the
  // same nonempty-source oracle to settle, rather than sampling that intermediate write.
  await expect.poll(() => readFileSync(FILE, 'utf8'), { timeout: 15000 }).not.toMatch(/\\\[\s*\\\]/);
  const math = pageSlide.locator('mjx-container').nth(index - 1);
  await expect(math).toBeVisible();
  await expect(pageSlide.locator('mjx-container')).toHaveCount(index);
  return math;
}


/** Detector controls touch only rendered glyph DOM/styles and restore each exact node/style.
 * They never change the math field model, source file, caret, or user-authored contents. */
async function checkLogicalDetectorControls(page: Page, source: LogicalMathGeometry,
  host: Awaited<ReturnType<typeof hostBounds>>, expected: string, rules: number,
  readControlPaint: (fault: string) => Promise<{ name: string; exclusivePixels: number; exclusiveArea: number; unsupportedNoExclusiveCell: boolean }[]>) {
  const root = page.locator('.dl-mathedit .lm-content mjx-container').first();
  const findings: { fault: string; problems: string[]; paint?: unknown; movement?: { axis: string; targetTag: string; targetDisplay: string; intrinsicDelta: number } }[] = [];
  const faults = rules === 1 ? ['bar-translate', 'bar-shorten']
    : ['translate-x', 'translate-y', 'removed-middle', 'removed-final', 'hidden-middle', 'hidden-final', 'transparent-middle', 'own-clip-middle', 'wrong-em'];
  for (const fault of faults) {
    const beforeControl = await root.evaluate(readLogicalMath, 'chtml');
    const nativeFraction = beforeControl.fractionNative;
    if (fault.startsWith('bar-') && (!nativeFraction || nativeFraction.rulePaint !== 'background')) throw new Error('Bar control requires the nominal background fraction');
    const independentlyExpectedAxis = rules === 1 ? host.frame.y + source.rules[0].logical.axis * host.scaleY : 0;
    const barDirection = rules === 1 && beforeControl.rules[0].logical.axis < independentlyExpectedAxis ? -1 : 1;
    const targetInfo = await root.evaluate((el, args) => {
      const node = el as HTMLElement & { __olOracleRestore?: () => void };
      if (node.__olOracleRestore) throw new Error('Unrestored detector control');
      const glyphs = Array.from(el.querySelectorAll<HTMLElement>('mjx-c'));
      if (glyphs.length !== args.count) throw new Error('Detector controls require the complete known fixture');
      if (args.fault.startsWith('bar-')) {
        const bar = el.querySelector<HTMLElement>('mjx-line');
        if (!bar || el.querySelectorAll('mjx-line').length !== 1) throw new Error('Detector controls require one fraction bar');
        const previous = bar.getAttribute('style');
        if (args.fault === 'bar-translate') bar.style.transform = `translate(${0.75 * args.sx}px,${args.barDirection * 0.75 * args.sy}px)`;
        else bar.style.width = `${bar.getBoundingClientRect().width - 1.5 * args.sx}px`;
        node.__olOracleRestore = () => {
          if (previous === null) bar.removeAttribute('style'); else bar.setAttribute('style', previous);
          if (bar.getAttribute('style') !== previous) throw new Error('Bar control style did not restore exactly');
        };
        return { tag: bar.localName, display: getComputedStyle(bar).display };
      } else if (args.fault.startsWith('translate')) {
        // mjx-container is inline and CSS transforms do not move it. The shipped
        // first mjx-c is an actual inline-block: prove its displacement below.
        const glyph = glyphs[0], display = getComputedStyle(glyph).display;
        if (display !== 'inline-block') throw new Error('Movement control requires the actual transformable glyph');
        const previous = glyph.getAttribute('style');
        const shift = args.fault === 'translate-x' ? `translateX(${0.75 * args.sx}px)` : `translateY(${0.75 * args.sy}px)`;
        glyph.style.transform = (getComputedStyle(glyph).transform === 'none' ? '' : getComputedStyle(glyph).transform + ' ') + shift;
        node.__olOracleRestore = () => {
          if (previous === null) glyph.removeAttribute('style'); else glyph.setAttribute('style', previous);
          if (glyph.getAttribute('style') !== previous) throw new Error('Movement control style did not restore exactly');
        };
        return { tag: glyph.localName, display };
      } else {
        const glyph = glyphs[args.fault.endsWith('final') ? glyphs.length - 1 : Math.floor(glyphs.length / 2)];
        const previous = glyph.getAttribute('style');
        if (args.fault.startsWith('removed')) {
          const parent = glyph.parentNode!, next = glyph.nextSibling;
          glyph.remove();
          node.__olOracleRestore = () => parent.insertBefore(glyph, next);
        } else {
          if (args.fault === 'wrong-em') glyph.style.fontSize = `${parseFloat(getComputedStyle(glyph).fontSize) + 0.75 * args.sx}px`;
          else if (args.fault === 'transparent-middle') glyph.style.color = 'transparent';
          else if (args.fault === 'own-clip-middle') glyph.style.clipPath = 'inset(0 50% 0 0)';
          else glyph.style.visibility = 'hidden';
          node.__olOracleRestore = () => { if (previous === null) glyph.removeAttribute('style'); else glyph.setAttribute('style', previous); };
        }
      }
    }, { fault, sx: host.scaleX, sy: host.scaleY, count: Array.from(expected).length, barDirection });
    try {
      await twoFrames(page);
      const actual = await root.evaluate(readLogicalMath, 'chtml');
      const problems = logicalMathProblems(source, actual, host, expected, rules);
      let movement: { axis: string; targetTag: string; targetDisplay: string; intrinsicDelta: number } | undefined;
      if (fault === 'translate-x' || fault === 'translate-y') {
        const axis = fault === 'translate-x' ? 'x' : 'y';
        const scale = axis === 'x' ? host.scaleX : host.scaleY;
        const intrinsicDelta = (actual.glyphs[0].origin[axis] - beforeControl.glyphs[0].origin[axis]) / scale;
        expect(intrinsicDelta, `${fault}: actual glyph displacement must exceed the unchanged bound`).toBeGreaterThan(0.5);
        movement = { axis, targetTag: targetInfo!.tag, targetDisplay: targetInfo!.display, intrinsicDelta };
      }
      if (fault === 'bar-translate') {
        const intrinsicDelta = (actual.rules[0].logical.axis - beforeControl.rules[0].logical.axis) / host.scaleY;
        expect(intrinsicDelta * barDirection, 'bar-translate: measured native movement away from independent expected axis').toBeGreaterThan(0.5);
        movement = { axis: 'rule-y', targetTag: targetInfo!.tag, targetDisplay: targetInfo!.display, intrinsicDelta };
      }
      let paint: unknown;
      if (fault === 'transparent-middle') {
        const cells = await readControlPaint(fault);
        const middle = cells.find(cell => cell.name === 'glyph-3');
        expect(middle, 'transparent-middle: measured actual cell').toBeDefined();
        expect(middle!.unsupportedNoExclusiveCell).toBe(false);
        expect(middle!.exclusiveArea).toBeGreaterThan(0);
        expect(middle!.exclusivePixels, 'transparent-middle: actual exclusive paint must disappear').toBe(0);
        expect(problems, 'transparent color leaves identity and placement intact').toEqual([]);
        paint = cells;
      }
      findings.push({ fault, problems, paint, movement });
      const check = fault === 'translate-x' ? ': logical x' : fault === 'translate-y' ? ': logical baseline'
        : fault.startsWith('removed') ? 'glyph count' : fault.startsWith('hidden') || fault.startsWith('own-clip') ? 'hidden or clipped'
          : fault === 'bar-translate' ? 'rule 0: logical axis' : fault === 'bar-shorten' ? 'rule 0: logical width' : ': em';
      if (fault !== 'transparent-middle') expect(problems.some(problem => problem.includes(check)), `${fault}: actual DOM detector must reject the fault`).toBe(true);
    } finally {
      await root.evaluate(el => {
        const node = el as HTMLElement & { __olOracleRestore?: () => void };
        if (!node.__olOracleRestore) throw new Error('Missing detector restoration');
        node.__olOracleRestore(); delete node.__olOracleRestore;
      });
      await twoFrames(page);
    }
    expect(logicalMathProblems(source, await root.evaluate(readLogicalMath, 'chtml'), host, expected, rules), `${fault}: restored actual DOM`).toEqual([]);
  }
  return findings;
}

const PIL_INK_ANALYSIS = String.raw`
import hashlib, json, sys
from PIL import Image

paths = sys.argv[1:4]
roi = [int(v) for v in sys.argv[4:8]]
left, top, width, height = roi
threshold = 190
node_rois = json.loads(sys.argv[8])
out = {}
for phase, path in zip(["before", "during", "after"], paths):
    im = Image.open(path).convert('RGB')
    px = im.load()
    points = []
    # The slide is light, and formulas use the same dark ink in both renderers.
    for y in range(max(0, top), min(im.height, top + height)):
        for x in range(max(0, left), min(im.width, left + width)):
            r, g, b = px[x, y]
            if (r + g + b) / 3 < threshold:
                points.append((x, y))
    if points:
        xs = [p[0] for p in points]; ys = [p[1] for p in points]
        out[path] = {"pixels": len(points), "bbox": {"left": min(xs), "top": min(ys), "right": max(xs) + 1, "bottom": max(ys) + 1}, "roiPx": roi, "sizePx": list(im.size)}
    else:
        out[path] = {"pixels": 0, "bbox": None, "roiPx": roi, "sizePx": list(im.size)}
    mask = bytes(1 if (sum(px[x, y]) / 3 < threshold) else 0
        for y in range(max(0, top), min(im.height, top + height))
        for x in range(max(0, left), min(im.width, left + width)))
    out[path]["maskSha256"] = hashlib.sha256(mask).hexdigest()
    out[path]["nodePaint"] = []
    for node in node_rois[phase]:
        x0, y0, x1, y1 = node["box"]
        inside = x0 >= 0 and y0 >= 0 and x1 <= im.width and y1 <= im.height
        exclusive_area = 0; exclusive_pixels = 0
        peers = [p["box"] for p in node_rois[phase] if p is not node]
        for y in range(max(0, y0), min(im.height, y1)):
            for x in range(max(0, x0), min(im.width, x1)):
                if any(px0 <= x < px1 and py0 <= y < py1 for px0, py0, px1, py1 in peers):
                    continue
                exclusive_area += 1
                if sum(px[x, y]) / 3 < threshold:
                    exclusive_pixels += 1
        out[path]["nodePaint"].append({"name": node["name"], "exclusivePixels": exclusive_pixels,
            "exclusiveArea": exclusive_area, "unsupportedNoExclusiveCell": exclusive_area == 0,
            "insideScreenshot": inside})
print(json.dumps(out))
`;

async function captureCase(page: Page, testInfo: { attach(name: string, options: { path: string; contentType: string }): Promise<void> }, label: string, formula: Locator) {
  mkdirSync(EVIDENCE, { recursive: true });
  await expect(formula).toBeVisible();
  await twoFrames(page);
  await formula.evaluate(el => el.ownerDocument.fonts.ready.then(() => undefined));
  const svgBefore = await svgMetrics(formula);
  const logicalSource = await formula.evaluate(readLogicalMath, 'svg');
  const rootBefore = await formula.boundingBox();
  if (!rootBefore) throw new Error(`${label}: source formula has no rendered bounds`);
  const hostBefore = await hostBounds(page);
  const view = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  const centered = {
    x: Math.max(0, rootBefore.x + rootBefore.width / 2 - Math.max(60, rootBefore.width / 2 + 6)),
    y: Math.max(0, rootBefore.y + rootBefore.height / 2 - Math.max(44, rootBefore.height / 2 + 6)),
  };
  const clip: Rect = {
    x: Math.floor(centered.x), y: Math.floor(centered.y),
    width: Math.ceil(Math.min(view.width - Math.floor(centered.x), Math.max(120, rootBefore.width + 12))),
    height: Math.ceil(Math.min(view.height - Math.floor(centered.y), Math.max(88, rootBefore.height + 12))),
  };
  // Restrict pixel analysis to the formula's own viewport plus 3 CSS px, excluding adjacent prose
  // from the inline starter equation while leaving room to observe a 1–2 px displacement.
  const pixelRoi = [
    Math.round((rootBefore.x - 3 - clip.x) * DPR),
    Math.round((rootBefore.y - 3 - clip.y) * DPR),
    Math.round((rootBefore.width + 6) * DPR),
    Math.round((rootBefore.height + 6) * DPR),
  ];
  const beforePath = path.join(EVIDENCE, `${label}-before.png`);
  const duringPath = path.join(EVIDENCE, `${label}-during.png`);
  const afterPath = path.join(EVIDENCE, `${label}-after.png`);

  await page.mouse.move(hostBefore.canvas.x + hostBefore.canvas.width - 4, hostBefore.canvas.y + hostBefore.canvas.height - 4);
  await twoFrames(page);
  await page.screenshot({ path: beforePath, clip, scale: 'device' });

  // Open using explicit screen coordinates from the visible formula. Locator.dblclick can scroll
  // the page, which would confound a 1 px geometry comparison.
  const viewBounds = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  const center = { x: rootBefore.x + rootBefore.width / 2, y: rootBefore.y + rootBefore.height / 2 };
  expect(center.x).toBeGreaterThanOrEqual(clip.x);
  expect(center.y).toBeGreaterThanOrEqual(clip.y);
  expect(center.x).toBeLessThan(viewBounds.width);
  expect(center.y).toBeLessThan(viewBounds.height);
  await page.mouse.move(center.x, center.y);
  await page.mouse.dblclick(center.x, center.y);
  await expect(page.locator('[data-dl-mathedit]:not(.pending)')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('.dl-mathedit .lm-content mjx-container')).toBeVisible();
  await installDiagnosticStyles(page);
  await page.mouse.move(hostBefore.canvas.x + hostBefore.canvas.width - 4, hostBefore.canvas.y + hostBefore.canvas.height - 4);
  await twoFrames(page);
  const hostDuring = await hostBounds(page);
  await expect(frame(page).locator('.ol-mathchip[data-ol-mathediting]')).toHaveCount(1, { timeout: 5000 });
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  const editDuring = await editorMetrics(page);
  const logicalEditor = await page.locator('.dl-mathedit .lm-content mjx-container').first().evaluate(readLogicalMath, 'chtml');
  const fixture = label === 'inline-euler' || label === 'display-euler' ? { text: 'eiπ+1=0', rules: 0 }
    : label === 'display-square' ? { text: 'x2', rules: 0 }
    : label === 'display-fraction' ? { text: 'a+bc+d', rules: 1 } : null;
  if (!fixture) throw new Error('Unsupported math diagnostic fixture');
  const logicalProblems = logicalMathProblems(logicalSource, logicalEditor, hostDuring, fixture.text, fixture.rules);
  // Persist numeric evidence before any detector/control can abort the case.
  const beforeControlsPath = path.join(EVIDENCE, `${label}-before-controls.json`);
  writeFileSync(beforeControlsPath, JSON.stringify({ label, source: logicalSource, editor: logicalEditor,
    host: { before: hostBefore, during: hostDuring }, editorMetrics: editDuring, problems: logicalProblems }, null, 2));
  await testInfo.attach(`${label}-before-controls`, { path: beforeControlsPath, contentType: 'application/json' });
  expect.soft(logicalProblems, `${label}: intrinsic logical placement/completeness`).toEqual([]);
  const activeSvg = frame(page).locator('.ol-mathchip[data-ol-mathediting] mjx-container').first();
  const chipSvgDuring = await svgMetrics(activeSvg);
  await page.screenshot({ path: duringPath, clip, scale: 'device' });
  const nodes = (geometry: LogicalMathGeometry, host: Awaited<ReturnType<typeof hostBounds>>, local: boolean) => [
    ...geometry.glyphs.map((g, i) => ({ name: `glyph-${i}`, rect: g.rect })),
    ...geometry.rules.map((g, i) => ({ name: `rule-${i}`, rect: g.rect })),
  ].map(g => {
    const r = g.rect;
    const x = local ? host.frame.x + r.x * host.scaleX : r.x;
    const y = local ? host.frame.y + r.y * host.scaleY : r.y;
    const width = local ? r.width * host.scaleX : r.width;
    const height = local ? r.height * host.scaleY : r.height;
    return { name: g.name, box: [Math.floor((x - clip.x) * DPR), Math.floor((y - clip.y) * DPR),
      Math.ceil((x + width - clip.x) * DPR), Math.ceil((y + height - clip.y) * DPR)] };
  });
  const readControlPaint = async (fault: string) => {
    const file = path.join(EVIDENCE, `${label}-negative-${fault}.png`);
    await page.screenshot({ path: file, clip, scale: 'device' });
    const boxes = nodes(logicalEditor, hostDuring, false);
    const text = execFileSync('python3', ['-c', PIL_INK_ANALYSIS, file, file, file, ...pixelRoi.map(String),
      JSON.stringify({ before: boxes, during: boxes, after: boxes })], { encoding: 'utf8' });
    await testInfo.attach(`${label}-${fault}`, { path: file, contentType: 'image/png' });
    return JSON.parse(text)[file].nodePaint;
  };
  const detectorControls = label === 'inline-euler' || label === 'display-fraction'
    ? await checkLogicalDetectorControls(page, logicalSource, hostDuring, fixture.text, fixture.rules, readControlPaint) : [];

  await page.keyboard.press('Escape');
  await expect(page.locator('[data-dl-mathedit]')).toHaveCount(0, { timeout: 5000 });
  // Inline math lives inside the starter slide's text editor. The first Escape closes the formula
  // field; a second Escape ends that text edit so later toolbar actions start a fresh draw gesture.
  await page.keyboard.press('Escape');
  await twoFrames(page);
  const hostAfter = await hostBounds(page);
  const logicalAfter = await formula.evaluate(readLogicalMath, 'svg');
  await page.screenshot({ path: afterPath, clip, scale: 'device' });

  const nodeRois = { before: nodes(logicalSource, hostBefore, true), during: nodes(logicalEditor, hostDuring, false), after: nodes(logicalAfter, hostAfter, true) };
  const analysisText = execFileSync('python3', ['-c', PIL_INK_ANALYSIS, beforePath, duringPath, afterPath, ...pixelRoi.map(String), JSON.stringify(nodeRois)], { encoding: 'utf8' });
  const analysis = JSON.parse(analysisText) as Record<string, { maskSha256: string; nodePaint: { name: string; exclusivePixels: number; exclusiveArea: number; unsupportedNoExclusiveCell: boolean; insideScreenshot: boolean }[]; pixels: number; bbox: { left: number; top: number; right: number; bottom: number } | null; sizePx: number[] }>;
  const localInk = (file: string, host: Awaited<ReturnType<typeof hostBounds>>) => {
    const ink = analysis[file]?.bbox;
    if (!ink) return null;
    const screen = { x: clip.x + ink.left / DPR, y: clip.y + ink.top / DPR, width: (ink.right - ink.left) / DPR, height: (ink.bottom - ink.top) / DPR };
    return { screen, frameCss: { x: (screen.x - host.frame.x) / host.scaleX, y: (screen.y - host.frame.y) / host.scaleY, width: screen.width / host.scaleX, height: screen.height / host.scaleY } };
  };
  const beforeInk = localInk(beforePath, hostBefore);
  const duringInk = localInk(duringPath, hostDuring);
  const afterInk = localInk(afterPath, hostAfter);
  const inkDelta = beforeInk && duringInk ? {
    left: duringInk.frameCss.x - beforeInk.frameCss.x,
    top: duringInk.frameCss.y - beforeInk.frameCss.y,
    right: (duringInk.frameCss.x + duringInk.frameCss.width) - (beforeInk.frameCss.x + beforeInk.frameCss.width),
    bottom: (duringInk.frameCss.y + duringInk.frameCss.height) - (beforeInk.frameCss.y + beforeInk.frameCss.height),
  } : null;
  const baselineMarkerInFrameCss = (editDuring.zeroBaselineMarker.y - hostDuring.frame.y) / hostDuring.scaleY;
  const baselineMarkerError = baselineMarkerInFrameCss - svgBefore.baseline;
  const chipBaselineDelta = chipSvgDuring.baseline - svgBefore.baseline;
  const editorBaselineInFrameCss = editDuring.editorRoot.baselineEstimate === null ? null : (editDuring.editorRoot.baselineEstimate - hostDuring.frame.y) / hostDuring.scaleY;
  const editorBaselineError = editorBaselineInFrameCss === null ? null : editorBaselineInFrameCss - svgBefore.baseline;
  const result = {
    label, tex: svgBefore.tex, dpr: DPR, screenshotClipCss: clip,
    logical: { source: logicalSource, editor: logicalEditor, after: logicalAfter, problems: logicalProblems, detectorControls },
    host: { before: hostBefore, during: hostDuring, after: hostAfter },
    source: { before: svgBefore, hiddenChipAfterOpen: chipSvgDuring },
    editor: editDuring,
    screenshotInk: { before: beforeInk, during: duringInk, after: afterInk, pixelAnalysis: analysis, normalizedDuringMinusBefore: inkDelta },
    diagnostics: { baselineMarkerErrorFrameCss: baselineMarkerError, hiddenChipBaselineDeltaFrameCss: chipBaselineDelta, editorBaselineInFrameCss, editorBaselineErrorFrameCss: editorBaselineError },
    artifacts: { before: beforePath, during: duringPath, after: afterPath },
  };
  mkdirSync(EVIDENCE, { recursive: true });
  writeFileSync(path.join(EVIDENCE, `${label}.json`), JSON.stringify(result, null, 2));
  await testInfo.attach(`${label}-metrics`, { path: path.join(EVIDENCE, `${label}.json`), contentType: 'application/json' });
  await testInfo.attach(`${label}-before`, { path: beforePath, contentType: 'image/png' });
  await testInfo.attach(`${label}-during`, { path: duringPath, contentType: 'image/png' });
  await testInfo.attach(`${label}-after`, { path: afterPath, contentType: 'image/png' });

  // Logical pen positions/baselines/em/advance use the unchanged half-intrinsic-pixel
  // bound. SVG paths and CHTML font glyphs can rasterize different painted edges;
  // their raw edge deltas remain evidence, never a fitted positional correction.
  expect(editDuring.zeroBaselineMarker.width).toBe(0);
  expect(editDuring.zeroBaselineMarker.height).toBe(0);
  expect.soft(Math.abs(baselineMarkerError), `${label}: MathOverlay baseline marker vs source SVG baseline`).toBeLessThanOrEqual(0.5);
  expect(chipSvgDuring.inkRunCount, `${label}: source chip should stay intact beneath the editor`).toBeGreaterThan(0);
  expect(analysis[beforePath]?.pixels, `${label}: source formula ink was not captured`).toBeGreaterThan(0);
  expect(analysis[duringPath]?.pixels, `${label}: editor formula ink was not captured`).toBeGreaterThan(0);
  expect(inkDelta, `${label}: pixel analysis needs both ink masks`).not.toBeNull();
  expect(analysis[afterPath]?.maskSha256, `${label}: unchanged source renderer after close`).toBe(analysis[beforePath]?.maskSha256);
  expect(logicalMathProblems(logicalAfter, logicalEditor, hostDuring, fixture.text, fixture.rules), `${label}: complete unclipped source after close`).toEqual([]);
  for (const phase of [beforePath, duringPath, afterPath]) {
    for (const node of analysis[phase].nodePaint) {
      expect.soft(node.insideScreenshot, `${label}: ${node.name} screenshot clipping`).toBe(true);
      expect.soft(node.unsupportedNoExclusiveCell, `${label}: ${node.name} unsupported empty exclusive cell`).toBe(false);
      expect.soft(node.exclusiveArea, `${label}: ${node.name} disjoint paint cell`).toBeGreaterThan(0);
      expect.soft(node.exclusivePixels, `${label}: ${node.name} actual exclusive paint coverage`).toBeGreaterThan(0);
    }
  }
  if (afterInk && beforeInk) {
    expect.soft(Math.abs(afterInk.frameCss.x - beforeInk.frameCss.x), `${label}: glyph left after close`).toBeLessThanOrEqual(0.5);
    expect.soft(Math.abs(afterInk.frameCss.y - beforeInk.frameCss.y), `${label}: glyph top after close`).toBeLessThanOrEqual(0.5);
  }
  return result;
}

test('inline and display math ink stays aligned with the source SVG while editing', async ({ browser }, testInfo) => {
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: DPR, colorScheme: 'light' });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  page.setDefaultNavigationTimeout(30000);
  const browserErrors: string[] = [];
  page.on('pageerror', e => browserErrors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') browserErrors.push(m.text()); });
  try {
    // Do not inject a localStorage init script into the sandboxed canvas iframe.
    await login(page, userCredentials('luna4'), { ui: 'default' });
    await page.locator('[data-new-project]').click();
    await page.locator('[data-new-kind="deck"]').click();
    await page.locator('[data-new-name]').fill(NAME);
    await page.locator('[data-new-create]').click();
    await slides(page).first().waitFor({ timeout: 30000 });
    await expect(rail(page)).toHaveCount(2);
    await expect.poll(() => readFileSync(FILE, 'utf8'), { timeout: 15000 }).toContain('<meta name="overlyx" content="deck">');
    await page.locator('[data-dl-zoom]').selectOption('fit');
    await installDiagnosticStyles(page);

    const contentSlide = slides(page).nth(1);
    await rail(page).nth(1).click();
    await expect(contentSlide).toBeVisible();
    const inline = contentSlide.locator('li').nth(1).locator('mjx-container').first();
    await expect(inline).toBeVisible();
    const inlineResult = await captureCase(page, testInfo, 'inline-euler', inline);

    // Three independently editable display formulas; all are created on the canvas with the
    // visible Formula tool, then opened with actual pointer coordinates for the measurements.
    const square = await addDisplayFormula(page, 'x^2', 300, 1);
    const squareResult = await captureCase(page, testInfo, 'display-square', square);
    const fraction = await addDisplayFormula(page, '\\frac{a+b}{c+d}', 420, 2);
    const fractionResult = await captureCase(page, testInfo, 'display-fraction', fraction);
    const euler = await addDisplayFormula(page, 'e^{i\\pi}+1=0', 540, 3);
    const eulerResult = await captureCase(page, testInfo, 'display-euler', euler);

    const summary = {
      run: RUN, project: PROJECT, file: FILE, viewport: VIEWPORT, dpr: DPR,
      cases: [inlineResult, squareResult, fractionResult, eulerResult].map(r => ({ label: r.label, tex: r.tex, baselineMarkerErrorFrameCss: r.diagnostics.baselineMarkerErrorFrameCss, hiddenChipBaselineDeltaFrameCss: r.diagnostics.hiddenChipBaselineDeltaFrameCss, inkDelta: r.screenshotInk.normalizedDuringMinusBefore, frameBefore: r.host.before.frame, frameDuring: r.host.during.frame })),
      browserErrors,
    };
    mkdirSync(EVIDENCE, { recursive: true });
    writeFileSync(path.join(EVIDENCE, 'summary.json'), JSON.stringify(summary, null, 2));
    await testInfo.attach('math-stability-summary', { path: path.join(EVIDENCE, 'summary.json'), contentType: 'application/json' });
    expect(browserErrors).toEqual([]);
  } finally {
    await context.close();
  }
});
