/** Native browser measurements used by the saved-style and SVG GUI assertions. */
export function nativePointReference(element: Element, points: number) {
  const css = getComputedStyle(element);
  const snapshot = {
    actual: css.fontSize, color: css.color, inline: element.getAttribute('style'),
    elementId: element.id,
  };
  const probe = element.cloneNode(false) as HTMLElement;
  probe.removeAttribute('id');
  probe.removeAttribute('contenteditable');
  for (const attribute of [...probe.attributes]) {
    if (attribute.name.startsWith('data-ol-')) probe.removeAttribute(attribute.name);
  }
  probe.setAttribute('aria-hidden', 'true');
  const parent = element.parentElement;
  if (!parent) throw new Error('Font reference needs the same computed parent context');
  for (const [name, value] of Object.entries({
    position: 'absolute', visibility: 'hidden', 'pointer-events': 'none',
    width: '0', height: '0', padding: '0', margin: '0', border: '0',
    overflow: 'hidden', transition: 'none', animation: 'none',
  })) probe.style.setProperty(name, value, 'important');
  // No formulas or citation syntax for the runtime's parse-time math observer.
  probe.textContent = 'M';
  parent.appendChild(probe);
  try {
    const at = (value: number) => {
      probe.style.setProperty('font-size', `${value}pt`, 'important');
      return getComputedStyle(probe).fontSize;
    };
    return { ...snapshot, lower: at(points - 1), expected: at(points), upper: at(points + 1) };
  } finally { probe.remove(); }
}

export type SvgGeometry = { centerX: number; centerY: number; angle: number; sx: number; sy: number };

export function sameSvgGeometry(a: SvgGeometry, b: SvgGeometry) {
  return a.centerX === b.centerX && a.centerY === b.centerY &&
    a.angle === b.angle && a.sx === b.sx && a.sy === b.sy;
}

export const roundSvgPosition = (value: number) => Math.round(value * 1000) / 1000 || 0;

/** Persisted SVG syntax and live geometry, at the editor's declared save precision. */
export function nativeSvgGeometry(element: Element, persisted: string) {
  const operations = [...persisted.matchAll(/(matrix|translate|rotate|scale)\s*\(([^()]*)\)/g)];
  const number = '[-+]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][-+]?\\d+)?';
  const argumentsSyntax = new RegExp(`^\\s*${number}(?:(?:\\s*,\\s*|\\s+)${number})*\\s*$`);
  const arity: Record<string, number[]> = { matrix: [6], translate: [1, 2], rotate: [1, 3], scale: [1, 2] };
  let cursor = 0;
  for (const operation of operations) {
    if (persisted.slice(cursor, operation.index).trim() || !argumentsSyntax.test(operation[2])) {
      throw new Error('Invalid persisted transform syntax');
    }
    const values = operation[2].trim().split(/[\s,]+/).map(Number);
    if (!arity[operation[1]].includes(values.length) || !values.every(Number.isFinite)) {
      throw new Error('Invalid persisted transform arguments');
    }
    cursor = operation.index! + operation[0].length;
  }
  if (!operations.length || persisted.slice(cursor).trim()) throw new Error('Invalid persisted transform list');
  // Consolidate only a detached probe: doing this on the drawing changes its spelling.
  const probe = element.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'g');
  probe.setAttribute('transform', persisted);
  if (probe.transform.baseVal.numberOfItems !== operations.length) throw new Error('Native SVG parser rejected transform');
  const saved = probe.transform.baseVal.consolidate()!.matrix;
  const part = element as SVGGraphicsElement;
  const parent = element.parentElement as unknown as SVGGraphicsElement;
  const parentMatrix = parent.getScreenCTM(), screenMatrix = part.getScreenCTM();
  if (!parentMatrix || !screenMatrix) throw new Error('Missing live SVG geometry');
  const live = parentMatrix.inverse().multiply(screenMatrix);
  const box = part.getBBox(), center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const q = (value: number, places: number) => Math.round(value * 10 ** places) / 10 ** places || 0;
  const describe = (matrix: { a: number; b: number; c: number; d: number; e: number; f: number }): SvgGeometry => {
    const coefficients = [matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f];
    const determinant = matrix.a * matrix.d - matrix.b * matrix.c;
    const sx = Math.hypot(matrix.a, matrix.b), sy = Math.hypot(matrix.c, matrix.d);
    if (!coefficients.every(Number.isFinite) || determinant <= 0 || sx <= 0 || sy <= 0) {
      throw new Error('Nonfinite, singular or reflected SVG transform');
    }
    const angle = q(Math.atan2(matrix.b, matrix.a) * 180 / Math.PI, 2);
    if (angle !== q(Math.atan2(-matrix.c, matrix.d) * 180 / Math.PI, 2)) {
      throw new Error('SVG skew changes a saved axis angle');
    }
    return {
      centerX: q(matrix.a * center.x + matrix.c * center.y + matrix.e, 3),
      centerY: q(matrix.b * center.x + matrix.d * center.y + matrix.f, 3),
      angle, sx: Number(sx.toPrecision(5)), sy: Number(sy.toPrecision(5)),
    };
  };
  const inverseParent = parentMatrix.inverse();
  return {
    saved: describe(saved), live: describe(live),
    shiftDown: { x: inverseParent.c * 10, y: inverseParent.d * 10 },
  };
}
