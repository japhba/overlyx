import type { ExportContext } from '../latex/context.ts';
import { fontsCode } from '../latex/preamble.ts';
import { latexLength } from '../latex/lengths.ts';
import { EARLY_BEGIN, EARLY_END } from './preamble.ts';

/** Package options that must be supplied before a user's own \\usepackage{hyperref}. */
export function nativeEarlySettings(ctx: ExportContext, settings: Record<string, unknown>): string {
  const options: string[] = [];
  if ('pdf_bookmarks' in settings) options.push('bookmarks=' + ctx.bp.pdf.bookmarks);
  if ('pdf_backref' in settings) options.push('backref=' + ctx.bp.pdf.backref);
  if ('pdf_pdfusetitle' in settings) options.push('pdfusetitle=' + ctx.bp.pdf.pdfusetitle);
  return options.length ? `${EARLY_BEGIN}\n\\PassOptionsToPackage{${options.join(',')}}{hyperref}\n${EARLY_END}\n` : '';
}

/** Keep arbitrary class options, replacing only categories selected in Document Settings. */
export function nativeClassOptions(ctx: ExportContext, settings: Record<string, unknown>): string {
  const opts = ctx.bp.options.split(',').map(x => x.trim()).filter(Boolean);
  const set = (key: string, pattern: RegExp, value: string) => {
    if (!(key in settings)) return;
    for (let i = opts.length - 1; i >= 0; i--) if (pattern.test(opts[i])) opts.splice(i, 1);
    if (value) opts.push(value);
  };
  const b = ctx.bp;
  set('paperfontsize', /^\d+pt$/, b.paperFontSize === 'default' ? '' : b.paperFontSize + 'pt');
  set('papersize', /^(?:[abc]\d|letter|legal|executive)paper$/, ['default', 'custom'].includes(b.paperSize) ? '' : b.paperSize + 'paper');
  set('papercolumns', /^(one|two)column$/, b.columns === 2 ? 'twocolumn' : 'onecolumn');
  set('papersides', /^(one|two)side$/, b.sides === 2 ? 'twoside' : 'oneside');
  set('paperorientation', /^(landscape|portrait)$/, b.orientation === 'landscape' ? 'landscape' : '');
  set('is_math_indent', /^fleqn$/, b.isMathIndent ? 'fleqn' : '');
  set('math_numbering_side', /^(leqno|reqno)$/, b.mathNumberingSide === 'left' ? 'leqno' : b.mathNumberingSide === 'right' ? 'reqno' : '');
  return opts.join(',');
}

/** Commands follow the user's preamble; only stored choices get generated overrides. */
export function nativeSettings(ctx: ExportContext, settings: Record<string, unknown>, loaded: Set<string>): string {
  const { bp } = ctx;
  let out = '';
  const has = (key: string) => key in settings;
  const use = (pkg: string, options = '') => { if (!loaded.has(pkg)) { out += `\\usepackage${options ? '[' + options + ']' : ''}{${pkg}}\n`; loaded.add(pkg); } };
  const begin = (s: string) => { out += '\\AtBeginDocument{' + s + '}\n'; };
  if (has('spacing')) {
    use('setspace');
    begin(bp.spacing === 'onehalf' ? '\\onehalfspacing' : bp.spacing === 'double' ? '\\doublespacing' : bp.spacing === 'other' ? `\\setstretch{${bp.spacingValue}}` : '\\singlespacing');
  }
  for (const [key, value] of [['secnumdepth', bp.secNumDepth], ['tocdepth', bp.tocDepth]] as const) if (has(key)) begin(`\\setcounter{${key}}{${value}}`);
  if (has('use_lineno')) { use('lineno', bp.linenoOptions); begin(bp.useLineno ? '\\linenumbers' : '\\nolinenumbers'); }
  if (has('suppress_date')) out += bp.suppressDate ? '\\date{}\n' : '\\date{\\today}\n';
  if (has('justification') && settings.justification !== 'default') { use('ragged2e'); begin(settings.justification === 'false' ? '\\RaggedRight' : '\\justifying'); }
  if (has('paragraph_separation') || has('defskip')) {
    const skip = ({ smallskip: '\\smallskipamount', medskip: '\\medskipamount', bigskip: '\\bigskipamount', halfline: '0.5\\baselineskip', fullline: '\\baselineskip' } as Record<string, string>)[bp.defSkip] ?? (bp.defSkip ? latexLength(bp.defSkip) : '0.5\\baselineskip');
    begin(bp.paragraphSeparation === 'skip' ? `\\setlength{\\parskip}{${skip}}\\setlength{\\parindent}{0pt}` : '\\setlength{\\parskip}{0pt}\\setlength{\\parindent}{1.5em}');
  }
  if (has('paragraph_indentation') && bp.paragraphIndentation !== 'default') begin(`\\setlength{\\parindent}{${latexLength(bp.paragraphIndentation)}}`);
  if (bp.useGeometry || bp.paperSize === 'custom') {
    use('geometry');
    const options: string[] = [];
    if (bp.paperSize === 'custom') { if (bp.paperWidth) options.push(`paperwidth=${latexLength(bp.paperWidth)}`); if (bp.paperHeight) options.push(`paperheight=${latexLength(bp.paperHeight)}`); }
    if (has('paperorientation')) options.push(bp.orientation);
    for (const [key, val] of Object.entries({ left: bp.leftMargin, right: bp.rightMargin, top: bp.topMargin, bottom: bp.bottomMargin, headheight: bp.headHeight, headsep: bp.headSep, footskip: bp.footSkip, columnsep: bp.columnSep })) if (val && bp.useGeometry) options.push(`${key}=${latexLength(val)}`);
    if (options.length) out += `\\geometry{${options.join(',')}}\n`;
  }
  if (has('paperpagestyle') && bp.pageStyle !== 'default') { if (bp.pageStyle === 'fancy') use('fancyhdr'); begin(`\\pagestyle{${bp.pageStyle}}`); }
  if (Object.keys(settings).some(k => k.startsWith('font_') || k === 'use_non_tex_fonts')) {
    if (bp.useNonTexFonts) use('fontspec');
    out += fontsCode(ctx).replace(/\\usepackage(\[[^\]]*\])?\{([^}]+)\}\n/g, (line, _options, pkg) => { if (loaded.has(pkg)) return ''; loaded.add(pkg); return line; });
    if (has('font_default_family') && bp.fontDefaultFamily !== 'default') out += `\\renewcommand{\\familydefault}{\\${bp.fontDefaultFamily}}\n`;
  }
  if (has('use_microtype')) { use('microtype'); out += `\\microtypesetup{activate=${settings.use_microtype === 'true' ? 'true' : 'false'}}\n`; }
  const pdfKeys = Object.keys(settings).filter(k => k.startsWith('pdf_'));
  if (pdfKeys.length || (has('use_hyperref') && bp.pdf.useHyperref)) {
    use('hyperref');
    const options: string[] = [];
    const p = bp.pdf;
    for (const key of ['title', 'author', 'subject', 'keywords'] as const) if (has('pdf_' + key)) options.push(`pdf${key}={${p[key]}}`);
    for (const key of ['bookmarksnumbered', 'bookmarksopen', 'breaklinks', 'colorlinks'] as const) if (has('pdf_' + key)) options.push(`${key}=${p[key]}`);
    if (has('pdf_pdfborder')) options.push(`pdfborder={0 0 ${p.pdfborder ? 0 : 1}}`);
    if (has('pdf_quoted_options') && p.quotedOptions) options.push(p.quotedOptions);
    if (options.length) out += `\\hypersetup{${options.join(',')}}\n`;
  }
  let explicit: string[] = [];
  try { explicit = JSON.parse(String(settings.overlyx_managed_settings ?? '[]')); } catch { /* old document */ }
  if (explicit.includes('use_hyperref') && loaded.has('hyperref')) out += `\\hypersetup{draft=${bp.pdf.useHyperref ? 'false' : 'true'}}\n`;
  return out;
}
