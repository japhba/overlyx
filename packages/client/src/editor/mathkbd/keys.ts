/**
 * The math keyboard's pages (keyboard.ts): what each key shows and does. A key types as the
 * hardware keyboard would (LyX's interpretChar: `^` opens a superscript, `\` a command name …),
 * inserts LaTeX the way the math toolbar does (a structure is entered, the selection goes into its
 * first cell), runs a field command, or presses a key. Long-pressed, a key offers its `alt`
 * variants (as iOS's keyboard does for accented letters).
 */

export type KeyAction =
  /** typed, character by character, as on a hardware keyboard */
  | { type: string }
  /** LaTeX inserted as the toolbars do (LyxMathField.execute('insert')) */
  | { insert: string }
  /** a LyxMathField.execute command */
  | { cmd: string; args?: unknown[] }
  /** a key pressed in the field */
  | { key: string; shift?: boolean; mod?: boolean }
  /** one after the other */
  | { seq: KeyAction[] }
  /** handled by the keyboard itself */
  | { kb: 'shift' | 'close' | 'pairClose' };

export interface KeyDef {
  /** text on the key (plain); `tex` instead: drawn as a formula (□ for empty places) */
  label?: string;
  tex?: string;
  /** what screen readers and the tooltip say */
  name: string;
  a: KeyAction;
  /** long-press variants */
  alt?: KeyDef[];
  /** width in key units (default 1) */
  w?: number;
  /** look: digits and letters light, operators and structures tinted, actions dark */
  kind?: 'num' | 'op' | 'fn' | 'act';
  /** repeats while held (Backspace, the arrows) */
  repeat?: boolean;
  /** the key's label with Shift (letters, Greek) */
  shifted?: KeyDef;
}

export interface KeyPage {
  id: string;
  /** the tab's label */
  tab: string;
  name: string;
  /** rows of keys */
  rows: KeyDef[][];
}

const t = (label: string, name = label, kind: KeyDef['kind'] = 'num'): KeyDef => ({ label, name, a: { type: label }, kind });
const sym = (label: string, cmd: string, name: string, alt?: KeyDef[]): KeyDef => ({ label, name, a: { insert: cmd }, kind: 'op', alt });
const fn = (name: string, alt?: KeyDef[]): KeyDef => ({ label: name, name, a: { insert: '\\' + name }, kind: 'fn', alt });

/* -------------------------------------------------------------- 123: numbers, the common structures */

const SQUARE: KeyDef = { tex: '\\square^{2}', name: 'Square', a: { seq: [{ cmd: 'moveToSuperscript' }, { type: '2' }, { key: 'ArrowRight' }] }, kind: 'fn' };
const SUP: KeyDef = { tex: '\\square^{\\square}', name: 'Superscript', a: { cmd: 'moveToSuperscript' }, kind: 'fn' };
const SUB: KeyDef = { tex: '\\square_{\\square}', name: 'Subscript', a: { cmd: 'moveToSubscript' }, kind: 'fn' };
const FRAC: KeyDef = { tex: '\\frac{\\square}{\\square}', name: 'Fraction', a: { cmd: 'smartFrac' }, kind: 'fn' };
const SQRT: KeyDef = { tex: '\\sqrt{\\square}', name: 'Square root', a: { insert: '\\sqrt' }, kind: 'fn', alt: [{ tex: '\\sqrt[\\square]{\\square}', name: 'Root', a: { cmd: 'root' } }] };
const ROOT: KeyDef = { tex: '\\sqrt[\\square]{\\square}', name: 'Root', a: { cmd: 'root' }, kind: 'fn' };
const ABS: KeyDef = { tex: '|\\square|', name: 'Absolute value', a: { cmd: 'pair', args: ['|', '|'] }, kind: 'fn', alt: [{ tex: '\\|\\square\\|', name: 'Norm', a: { cmd: 'pair', args: ['\\|', '\\|'] } }] };

export const PAGE_123: KeyPage = {
  id: '123', tab: '123', name: 'Numbers',
  rows: [
    [t('x', 'x', 'num'), t('y', 'y', 'num'), SQUARE, SUP, t('7'), t('8'), t('9'), sym('÷', '\\div', 'Divided by', [{ label: '/', name: 'Slash', a: { type: '/' } }]), { label: '(', name: 'Parentheses', a: { cmd: 'pair', args: ['(', ')'] }, kind: 'op', alt: [{ label: '(', name: 'Opening parenthesis', a: { type: '(' } }, { tex: '\\left(\\square\\right)', name: 'Growing parentheses', a: { cmd: 'delim', args: ['(', ')'] } }] }, { label: ')', name: 'Closing parenthesis', a: { kb: 'pairClose' }, kind: 'op' }],
    [t('a', 'a', 'num'), t('b', 'b', 'num'), SQRT, ROOT, t('4'), t('5'), t('6'), sym('×', '\\times', 'Times', [{ label: '·', name: 'Dot', a: { insert: '\\cdot' } }, { label: '∗', name: 'Asterisk', a: { type: '*' } }]), { label: '[', name: 'Brackets', a: { cmd: 'pair', args: ['[', ']'] }, kind: 'op', alt: [{ label: '{', name: 'Braces', a: { cmd: 'pair', args: ['\\{', '\\}'] } }, { label: '⟨', name: 'Angle brackets', a: { cmd: 'pair', args: ['\\langle', '\\rangle'] } }, { label: '⌊', name: 'Floor', a: { cmd: 'pair', args: ['\\lfloor', '\\rfloor'] } }, { label: '⌈', name: 'Ceiling', a: { cmd: 'pair', args: ['\\lceil', '\\rceil'] } }] }, { label: ']', name: 'Closing bracket', a: { kb: 'pairClose' }, kind: 'op' }],
    [t('<', 'Less than', 'op'), t('>', 'Greater than', 'op'), FRAC, SUB, t('1'), t('2'), t('3'), { label: '−', name: 'Minus', a: { type: '-' }, kind: 'op', alt: [sym('±', '\\pm', 'Plus or minus'), sym('∓', '\\mp', 'Minus or plus')] }, ABS, t(',', 'Comma', 'op')],
    [sym('≤', '\\leq', 'Less or equal', [sym('≪', '\\ll', 'Much less')]), sym('≥', '\\geq', 'Greater or equal', [sym('≫', '\\gg', 'Much greater')]), sym('π', '\\pi', 'Pi'), sym('∞', '\\infty', 'Infinity'), t('0'), t('.', 'Point'), { label: '=', name: 'Equals', a: { type: '=' }, kind: 'op', alt: [sym('≠', '\\neq', 'Not equal'), sym('≈', '\\approx', 'Approximately'), sym('≡', '\\equiv', 'Identical'), sym('≔', '\\coloneqq', 'Defined as')] }, { label: '+', name: 'Plus', a: { type: '+' }, kind: 'op', alt: [sym('±', '\\pm', 'Plus or minus')] }, sym('∑', '\\sum', 'Sum', [sym('∏', '\\prod', 'Product')]), sym('∫', '\\int', 'Integral', [sym('∬', '\\iint', 'Double integral'), sym('∮', '\\oint', 'Contour integral')])],
  ],
};

/* -------------------------------------------------------------- f(x): functions, calculus, accents */

const deco = (n: string, tex: string, name: string): KeyDef => ({ tex, name, a: { insert: '\\' + n }, kind: 'fn' });

export const PAGE_FN: KeyPage = {
  id: 'fn', tab: 'f(x)', name: 'Functions',
  rows: [
    [fn('sin', [fn('arcsin'), fn('sinh')]), fn('cos', [fn('arccos'), fn('cosh')]), fn('tan', [fn('arctan'), fn('tanh'), fn('cot')]), fn('ln'), fn('log', [fn('lg'), fn('exp')]), fn('exp'), fn('lim', [fn('limsup'), fn('liminf')]), fn('max', [fn('min'), fn('sup'), fn('inf'), fn('arg')])],
    [{ tex: '\\frac{d}{dx}', name: 'Derivative', a: { seq: [{ insert: '\\frac{d}{d}' }, { key: 'End' }] }, kind: 'fn' }, { tex: '\\frac{\\partial}{\\partial x}', name: 'Partial derivative', a: { seq: [{ insert: '\\frac{\\partial}{\\partial}' }, { key: 'End' }] }, kind: 'fn' }, sym('∂', '\\partial', 'Partial'), sym('∇', '\\nabla', 'Nabla'), { label: '′', name: 'Prime', a: { type: "'" }, kind: 'op' }, sym('∑', '\\sum', 'Sum', [sym('∏', '\\prod', 'Product'), sym('⋃', '\\bigcup', 'Union'), sym('⋂', '\\bigcap', 'Intersection')]), sym('∫', '\\int', 'Integral', [sym('∬', '\\iint', 'Double integral'), sym('∮', '\\oint', 'Contour integral')]), { tex: '\\binom{\\square}{\\square}', name: 'Binomial', a: { insert: '\\binom' }, kind: 'fn' }],
    [deco('hat', '\\hat{x}', 'Hat'), deco('bar', '\\bar{x}', 'Bar'), deco('vec', '\\vec{x}', 'Vector'), deco('dot', '\\dot{x}', 'Dot'), deco('ddot', '\\ddot{x}', 'Double dot'), deco('tilde', '\\tilde{x}', 'Tilde'), deco('overline', '\\overline{xy}', 'Overline'), { tex: '\\mathbb{R}', name: 'Blackboard', a: { cmd: 'font', args: ['mathbb'] }, kind: 'fn', alt: [sym('ℝ', '\\mathbb{R}', 'Reals'), sym('ℕ', '\\mathbb{N}', 'Naturals'), sym('ℤ', '\\mathbb{Z}', 'Integers'), sym('ℚ', '\\mathbb{Q}', 'Rationals'), sym('ℂ', '\\mathbb{C}', 'Complex numbers')] }],
    [{ tex: '\\begin{pmatrix}\\square&\\square\\\\\\square&\\square\\end{pmatrix}', name: 'Matrix', a: { cmd: 'matrix', args: [2, 2, 'pmatrix'] }, kind: 'fn', alt: [{ tex: '\\begin{bmatrix}\\square\\end{bmatrix}', name: 'Bracket matrix', a: { cmd: 'matrix', args: [2, 2, 'bmatrix'] } }, { tex: '\\begin{vmatrix}\\square\\end{vmatrix}', name: 'Determinant', a: { cmd: 'matrix', args: [2, 2, 'vmatrix'] } }] }, { tex: '\\begin{cases}\\square\\\\\\square\\end{cases}', name: 'Cases', a: { cmd: 'matrix', args: [2, 2, 'cases'] }, kind: 'fn' }, { label: '+row', name: 'Add a row', a: { cmd: 'appendRow' }, kind: 'act' }, { label: '+col', name: 'Add a column', a: { cmd: 'appendColumn' }, kind: 'act' }, { tex: '\\mathrm{T}', name: 'Upright', a: { cmd: 'font', args: ['mathrm'] }, kind: 'fn', alt: [{ tex: '\\mathbf{B}', name: 'Bold', a: { cmd: 'font', args: ['mathbf'] } }, { tex: '\\mathcal{C}', name: 'Calligraphic', a: { cmd: 'font', args: ['mathcal'] } }] }, { label: 'text', name: 'Text in the formula', a: { cmd: 'text' }, kind: 'act' }, sym('…', '\\ldots', 'Dots', [sym('⋯', '\\cdots', 'Centred dots'), sym('⋮', '\\vdots', 'Vertical dots'), sym('⋱', '\\ddots', 'Diagonal dots')]), sym('ℏ', '\\hbar', 'h-bar', [sym('ℓ', '\\ell', 'Script l')])],
  ],
};

/* -------------------------------------------------------------- αβγ: Greek */

const GREEK: [string, string, string?, string?][] = [
  // [glyph, command, capital glyph, capital command] (capitals TeX has; the others are Latin letters)
  ['α', 'alpha', 'A', 'A'], ['β', 'beta', 'B', 'B'], ['γ', 'gamma', 'Γ', 'Gamma'], ['δ', 'delta', 'Δ', 'Delta'], ['ε', 'varepsilon', 'E', 'E'], ['ζ', 'zeta', 'Z', 'Z'], ['η', 'eta', 'H', 'H'], ['θ', 'theta', 'Θ', 'Theta'],
  ['ι', 'iota', 'I', 'I'], ['κ', 'kappa', 'K', 'K'], ['λ', 'lambda', 'Λ', 'Lambda'], ['μ', 'mu', 'M', 'M'], ['ν', 'nu', 'N', 'N'], ['ξ', 'xi', 'Ξ', 'Xi'], ['π', 'pi', 'Π', 'Pi'], ['ρ', 'rho', 'P', 'P'],
  ['σ', 'sigma', 'Σ', 'Sigma'], ['τ', 'tau', 'T', 'T'], ['υ', 'upsilon', 'Υ', 'Upsilon'], ['φ', 'varphi', 'Φ', 'Phi'], ['χ', 'chi', 'X', 'X'], ['ψ', 'psi', 'Ψ', 'Psi'], ['ω', 'omega', 'Ω', 'Omega'],
];
const GREEK_ALT: Record<string, [string, string][]> = {
  varepsilon: [['ϵ', 'epsilon']], theta: [['ϑ', 'vartheta']], varphi: [['ϕ', 'phi']], rho: [['ϱ', 'varrho']], sigma: [['ς', 'varsigma']], pi: [['ϖ', 'varpi']], kappa: [['ϰ', 'varkappa']],
};
const greekKey = ([g, n, G, N]: [string, string, string?, string?]): KeyDef => ({
  label: g, name: n, a: { insert: '\\' + n }, kind: 'num',
  alt: GREEK_ALT[n]?.map(([l, c]) => ({ label: l, name: c, a: { insert: '\\' + c } })),
  shifted: G && N ? { label: G, name: N, a: N.length === 1 ? { type: N } : { insert: '\\' + N }, kind: 'num' } : undefined,
});
const SHIFT: KeyDef = { label: '⇧', name: 'Shift', a: { kb: 'shift' }, kind: 'act' };

export const PAGE_GREEK: KeyPage = {
  id: 'greek', tab: 'αβγ', name: 'Greek letters',
  rows: [
    GREEK.slice(0, 8).map(greekKey),
    GREEK.slice(8, 16).map(greekKey),
    [...GREEK.slice(16, 23).map(greekKey), SHIFT],
  ],
};

/* -------------------------------------------------------------- ≤∈→: relations, sets, logic, arrows */

export const PAGE_REL: KeyPage = {
  id: 'rel', tab: '≤ ∈ →', name: 'Relations and symbols',
  rows: [
    [t('=', 'Equals', 'op'), sym('≠', '\\neq', 'Not equal'), sym('≈', '\\approx', 'Approximately'), sym('≡', '\\equiv', 'Identical'), sym('∼', '\\sim', 'Similar', [sym('≃', '\\simeq', 'Similar or equal'), sym('≅', '\\cong', 'Congruent')]), sym('∝', '\\propto', 'Proportional'), t('<', 'Less than', 'op'), t('>', 'Greater than', 'op'), sym('≤', '\\leq', 'Less or equal'), sym('≥', '\\geq', 'Greater or equal')],
    [sym('≪', '\\ll', 'Much less'), sym('≫', '\\gg', 'Much greater'), sym('±', '\\pm', 'Plus or minus', [sym('∓', '\\mp', 'Minus or plus')]), sym('·', '\\cdot', 'Dot'), sym('×', '\\times', 'Times'), sym('∘', '\\circ', 'Composition'), sym('⊗', '\\otimes', 'Tensor product'), sym('⊕', '\\oplus', 'Direct sum'), sym('†', '\\dagger', 'Dagger'), sym('⊥', '\\perp', 'Perpendicular', [sym('∥', '\\parallel', 'Parallel')])],
    [sym('∈', '\\in', 'Element of', [sym('∋', '\\ni', 'Contains')]), sym('∉', '\\notin', 'Not an element of'), sym('⊂', '\\subset', 'Subset', [sym('⊃', '\\supset', 'Superset')]), sym('⊆', '\\subseteq', 'Subset or equal', [sym('⊇', '\\supseteq', 'Superset or equal')]), sym('∪', '\\cup', 'Union'), sym('∩', '\\cap', 'Intersection'), sym('∖', '\\setminus', 'Set minus'), sym('∅', '\\emptyset', 'Empty set'), t('|', 'Bar', 'op'), t(':', 'Colon', 'op')],
    [sym('∀', '\\forall', 'For all'), sym('∃', '\\exists', 'Exists', [sym('∄', '\\nexists', 'Does not exist')]), sym('¬', '\\neg', 'Not'), sym('∧', '\\wedge', 'And'), sym('∨', '\\vee', 'Or'), sym('→', '\\to', 'To', [sym('←', '\\leftarrow', 'Left arrow'), sym('↔', '\\leftrightarrow', 'Both ways'), sym('⟶', '\\longrightarrow', 'Long arrow'), sym('↑', '\\uparrow', 'Up'), sym('↓', '\\downarrow', 'Down')]), sym('↦', '\\mapsto', 'Maps to'), sym('⇒', '\\Rightarrow', 'Implies', [sym('⇐', '\\Leftarrow', 'Implied by')]), sym('⇔', '\\Leftrightarrow', 'If and only if'), t(';', 'Semicolon', 'op')],
  ],
};

/* -------------------------------------------------------------- abc: Latin letters, commands, text */

const letter = (c: string): KeyDef => ({ label: c, name: c, a: { type: c }, kind: 'num', shifted: { label: c.toUpperCase(), name: c.toUpperCase(), a: { type: c.toUpperCase() }, kind: 'num' } });

export const PAGE_ABC: KeyPage = {
  id: 'abc', tab: 'abc', name: 'Letters',
  rows: [
    [...'qwertyuiop'].map(letter),
    [...'asdfghjkl'].map(letter).concat([{ label: '\\', name: 'Command (as in LaTeX: \\alpha)', a: { type: '\\' }, kind: 'op' }]),
    [SHIFT, ...[...'zxcvbnm'].map(letter), { label: "'", name: 'Prime', a: { type: "'" }, kind: 'op' }, { label: '!', name: 'Factorial', a: { type: '!' }, kind: 'op' }],
    [{ label: 'text', name: 'Text in the formula', a: { cmd: 'text' }, kind: 'act', w: 1.5 }, { label: '{ }', name: 'Group', a: { type: '{' }, kind: 'op' }, { label: 'space', name: 'Space', a: { type: ' ' }, kind: 'num', w: 4.5 }, t('_', 'Subscript', 'op'), t('^', 'Superscript', 'op'), t('&', 'Next cell', 'op'), { label: '↵ row', name: 'New row', a: { cmd: 'newline' }, kind: 'act', w: 1.5 }],
  ],
};

export const PAGES: KeyPage[] = [PAGE_123, PAGE_FN, PAGE_GREEK, PAGE_REL, PAGE_ABC];

/** the column at the right edge, on every page (and beside the pen's pad) */
export const SIDE_KEYS: KeyDef[][] = [
  [{ label: '⌫', name: 'Delete', a: { key: 'Backspace' }, kind: 'act', w: 2, repeat: true }],
  [{ label: '←', name: 'Left', a: { key: 'ArrowLeft' }, kind: 'act', repeat: true }, { label: '→', name: 'Right', a: { key: 'ArrowRight' }, kind: 'act', repeat: true }],
  [{ label: '↑', name: 'Up', a: { key: 'ArrowUp' }, kind: 'act', repeat: true }, { label: '↓', name: 'Down', a: { key: 'ArrowDown' }, kind: 'act', repeat: true }],
  [{ label: '⏎', name: 'Enter (leaves an inline formula, a new line in a displayed one)', a: { key: 'Enter' }, kind: 'act', w: 2 }],
];
