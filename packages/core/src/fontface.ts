/**
 * A font by name on a run of text — the toolbar's font list, as in Google Docs: a family (a Google
 * font), where its design axes are set (a variable font's weight, width, optical size, …: any
 * value; a family of static faces: its weights) and the OpenType features switched on or off
 * (old-style figures, small capitals, stylistic sets, …). The `face` font attribute (FontState.face /
 * the `face` mark) holds it as `Family|axes|features`: `Inter`, `Inter|350`, `Inter|wght=350,opsz=32|+onum;+tnum`.
 *
 *   .tex      \olfont[wght=350,opsz=32][+onum;+tnum]{Inter}{text} (`[350]`: the weight alone) —
 *             OLFONT_DEF in the managed block defines it with fontspec, which needs LuaLaTeX (the
 *             server builds such a document with it); under pdflatex the text is printed in the
 *             document's font
 *   markdown  <span style="font-family: 'Inter'; font-weight: 350; font-variation-settings: 'opsz' 32; font-feature-settings: 'onum' 1">text</span>
 *   editor    the same CSS on the mark's span; the server serves the font's files (googlefonts.ts)
 */

export interface FontFace {
  family: string;
  /** design axes by tag (`wght` 1…1000, `wdth`, `opsz`, `slnt`, a font's own like `GRAD`); unset: the font's default */
  axes: Record<string, number>;
  /** OpenType feature tags, `+tag` on / `-tag` off */
  features: string[];
}

export const validFontFamily = (name: string) => /^[A-Za-z0-9][A-Za-z0-9 ]{0,59}$/.test(name.trim());
const FEATURE = /^[+-][a-z0-9]{4}$/;
export const validFeature = (f: string) => FEATURE.test(f);
const AXIS = /^[A-Za-z][A-Za-z0-9]{3}$/;
const num = (v: string | undefined) => (v !== undefined && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
/** a value as LaTeX and CSS write it: at most 2 decimals */
const fmt = (n: number) => String(Math.round(n * 100) / 100);

export const faceWeight = (f: FontFace) => f.axes.wght ?? 400;

/** `axes` of the value / of \olfont's option: `350` (the weight) or `wght=350,opsz=32` */
export function parseAxes(s: string): Record<string, number> {
  const axes: Record<string, number> = {};
  const t = s.trim();
  if (!t) return axes;
  const w = num(t);
  if (w !== null) { if (w >= 1 && w <= 1000) axes.wght = w; return axes; }
  for (const part of t.split(/[,;]/)) {
    const [k = '', v] = part.split('=');
    const n = num(v);
    if (AXIS.test(k.trim()) && n !== null) axes[k.trim()] = n;
  }
  return axes;
}

export function axesText(axes: Record<string, number>): string {
  const keys = Object.keys(axes).filter(k => AXIS.test(k)).sort();
  if (!keys.length) return '';
  if (keys.length === 1 && keys[0] === 'wght') return fmt(axes.wght);
  return keys.map(k => `${k}=${fmt(axes[k])}`).join(',');
}

/** `Family|axes|features` → the face (null: no family) */
export function parseFace(value: string | null | undefined): FontFace | null {
  if (!value) return null;
  const [family = '', axes = '', feats = ''] = value.split('|');
  if (!validFontFamily(family)) return null;
  return { family: family.trim(), axes: parseAxes(axes), features: feats.split(/[;,\s]+/).filter(validFeature) };
}

export function faceValue(f: FontFace): string {
  const axes = axesText(f.axes);
  const feats = f.features.filter(validFeature).join(';');
  return f.family + (axes || feats ? '|' + axes : '') + (feats ? '|' + feats : '');
}

/** the usual names of the weights (CSS's), as font files call their faces */
export const WEIGHT_NAMES: Record<number, string> = { 100: 'Thin', 200: 'ExtraLight', 300: 'Light', 400: 'Regular', 500: 'Medium', 600: 'SemiBold', 700: 'Bold', 800: 'ExtraBold', 900: 'Black' };
/** what people see */
export const WEIGHT_LABELS: Record<number, string> = { 100: 'Thin', 200: 'Extra light', 300: 'Light', 400: 'Regular', 500: 'Medium', 600: 'Semibold', 700: 'Bold', 800: 'Extra bold', 900: 'Black' };

/** the weight bold text takes in a face of weight `w` (the PDF's choice too: OLFONT_DEF) */
export const boldWeightOf = (w: number) => (Math.round(w / 100) * 100 >= 700 ? 900 : 700);

/**
 * The face as CSS declarations (the editor's span, a markdown <span style>): the weight as
 * font-weight (bold text inside still turns bold), the other axes as font-variation-settings.
 */
export function faceCss(f: FontFace, fallback = ''): Record<string, string> {
  const css: Record<string, string> = { 'font-family': `'${f.family}'` + (fallback ? ', ' + fallback : '') };
  if (f.axes.wght !== undefined && f.axes.wght !== 400) css['font-weight'] = fmt(f.axes.wght);
  const other = Object.keys(f.axes).filter(k => k !== 'wght' && AXIS.test(k)).sort();
  if (other.length) css['font-variation-settings'] = other.map(k => `'${k}' ${fmt(f.axes[k])}`).join(', ');
  if (f.features.length) css['font-feature-settings'] = f.features.map(t => `'${t.slice(1)}' ${t[0] === '+' ? 1 : 0}`).join(', ');
  return css;
}

/** a style attribute's declarations → the face it names (null: no font-family) */
export function faceFromCss(style: string): FontFace | null {
  const decl: Record<string, string> = {};
  for (const part of style.split(';')) {
    const i = part.indexOf(':');
    if (i > 0) decl[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1).trim();
  }
  const fam = /^\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z0-9 ]+?))\s*(?:,|$)/.exec(decl['font-family'] ?? '');
  const family = (fam?.[1] ?? fam?.[2] ?? fam?.[3] ?? '').trim();
  if (!validFontFamily(family)) return null;
  const axes: Record<string, number> = {};
  const w = decl['font-weight'];
  const wn = w === 'bold' ? 700 : num(w);
  if (wn !== null && wn !== 400) axes.wght = wn;
  for (const m of (decl['font-variation-settings'] ?? '').matchAll(/['"]([A-Za-z0-9]{4})['"]\s+(-?[\d.]+)/g)) axes[m[1]] = Number(m[2]);
  const features: string[] = [];
  for (const m of (decl['font-feature-settings'] ?? '').matchAll(/['"]([a-z0-9]{4})['"]\s*(on|off|\d+)?/g)) {
    features.push((m[2] === 'off' || m[2] === '0' ? '-' : '+') + m[1]);
  }
  return { family, axes, features };
}

/** the markdown form: `<span style="…">` */
export function faceSpan(f: FontFace): string {
  return `<span style="${Object.entries(faceCss(f)).map(([k, v]) => `${k}: ${v}`).join('; ')}">`;
}

/** the .tex form's opening, `\olfont[300][+onum;+tnum]{Inter}{` (closed by `}`) */
export function faceLatexOpen(f: FontFace): string {
  const axes = axesText(f.axes);
  const feats = f.features.join(';');
  return '\\olfont' + (axes || feats ? `[${axes}]` : '') + (feats ? `[${feats}]` : '') + `{${f.family}}{`;
}

/**
 * \olfont[axes][features]{family}{text} for the managed block (`[350]` is `[wght=350]`). With LuaTeX /
 * XeTeX it loads fontspec unless the preamble did — keeping the document's own fonts and encoding
 * (fontspec would reset them: a Times document would turn Latin Modern). A family of static faces
 * is taken by their names ("Inter Light", "Libertinus Serif Semibold Italic"), each only if it
 * exists (fontspec stops at a face that is missing); a variable font (no such names) by its axes,
 * set per face — bold text is the weight's bold (700, or 900 from 700 on), which a setting for the
 * whole font would override. Under pdflatex the text is printed as it is. (The managed block's
 * macros are inside \makeatletter.)
 */
export const OLFONT_DEF = String.raw`\def\ol@loadfontspec{\let\ol@enc\encodingdefault\let\ol@rm\rmdefault\let\ol@sf\sfdefault\let\ol@tt\ttdefault\let\ol@fam\familydefault
  \RequirePackage[no-math]{fontspec}%
  \let\encodingdefault\ol@enc\let\rmdefault\ol@rm\let\sfdefault\ol@sf\let\ttdefault\ol@tt\let\familydefault\ol@fam}
\@ifpackageloaded{fontspec}{}{\ifdefined\directlua\let\ol@tu\@firstofone\else\ifdefined\XeTeXrevision\let\ol@tu\@firstofone\else\let\ol@tu\@gobble\fi\fi
  \ol@tu{\ol@loadfontspec}}
\ExplSyntaxOn
\cs_if_exist:NTF \fontspec
  {
    \prop_const_from_keyval:Nn \c__olfont_weights_prop
      { 100 = {Thin,Hairline}, 200 = {ExtraLight,UltraLight}, 300 = {Light}, 400 = {Regular}, 500 = {Medium},
        600 = {SemiBold,DemiBold}, 700 = {Bold}, 800 = {ExtraBold,UltraBold,Heavy}, 900 = {Black,Heavy} }
    \prop_new:N \l__olfont_axes_prop
    \tl_new:N \l__olfont_face_tl
    \tl_new:N \l__olfont_names_tl
    \tl_new:N \l__olfont_opts_tl
    \tl_new:N \l__olfont_w_tl
    \tl_new:N \l__olfont_axis_tl
    \int_new:N \l__olfont_w_int
    \int_new:N \l__olfont_b_int
    % the face of weight #2 (a hundred) by its name, #3 a suffix (~Italic): * Light Italic, or empty
    \cs_new_protected:Npn \__olfont_face:nnn #1#2#3
      {
        \tl_clear:N \l__olfont_face_tl
        \exp_args:NNe \prop_get:NnNT \c__olfont_weights_prop {#2} \l__olfont_names_tl
          {
            \clist_map_inline:Nn \l__olfont_names_tl
              { \IfFontExistsTF { #1~##1#3 } { \tl_set:Nn \l__olfont_face_tl { *~##1#3 } \clist_map_break: } { } }
          }
      }
    % the axes with the weight #1: axis={wght=…,opsz=…}
    \cs_new_protected:Npn \__olfont_axis:n #1
      {
        \tl_set:Ne \l__olfont_axis_tl { wght = #1 }
        \prop_map_inline:Nn \l__olfont_axes_prop
          { \str_if_eq:nnF {##1} {wght} { \tl_put_right:Nn \l__olfont_axis_tl { , ##1 = ##2 } } }
      }
    \cs_new_protected:Npn \__olfont_put:n #1 { \tl_put_right:Ne \l__olfont_opts_tl { #1 , } }
    \DeclareDocumentCommand \olfont { O{} O{} m +m }
      {
        \group_begin:
        \tl_clear:N \l__olfont_opts_tl
        \prop_clear:N \l__olfont_axes_prop
        \tl_if_in:nnTF {#1} {=}
          { \prop_set_from_keyval:Nn \l__olfont_axes_prop {#1} }
          { \tl_if_blank:nF {#1} { \prop_put:Nnn \l__olfont_axes_prop {wght} {#1} } }
        \prop_get:NnNF \l__olfont_axes_prop {wght} \l__olfont_w_tl { \tl_set:Nn \l__olfont_w_tl {400} }
        \int_set:Nn \l__olfont_w_int { \fp_eval:n { max(100, min(900, round(\l__olfont_w_tl / 100) * 100)) } }
        \int_set:Nn \l__olfont_b_int { \int_compare:nNnTF { \l__olfont_w_int } < {700} {700} {900} }
        % static faces by name
        \int_compare:nNnF { \l__olfont_w_int } = {400}
          {
            \__olfont_face:nnn {#3} { \int_use:N \l__olfont_w_int } { }
            \tl_if_empty:NF \l__olfont_face_tl { \__olfont_put:n { UprightFont = \l__olfont_face_tl } }
            \__olfont_face:nnn {#3} { \int_use:N \l__olfont_w_int } { ~Italic }
            \tl_if_empty:NF \l__olfont_face_tl { \__olfont_put:n { ItalicFont = \l__olfont_face_tl } }
          }
        \__olfont_face:nnn {#3} { \int_use:N \l__olfont_b_int } { }
        \tl_if_empty:NTF \l__olfont_face_tl { \__olfont_put:n { BoldFont = { \exp_not:n {#3} } } } { \__olfont_put:n { BoldFont = \l__olfont_face_tl } }
        \__olfont_face:nnn {#3} { \int_use:N \l__olfont_b_int } { ~Italic }
        \tl_if_empty:NTF \l__olfont_face_tl { \__olfont_put:n { BoldItalicFont = { \exp_not:n {#3} /I } } } { \__olfont_put:n { BoldItalicFont = \l__olfont_face_tl } }
        % a variable font by its axes (a static one has none: ignored)
        \__olfont_axis:n { \l__olfont_w_tl }
        \__olfont_put:n { UprightFeatures = { RawFeature = { axis = { \l__olfont_axis_tl } } } }
        \__olfont_put:n { ItalicFeatures = { RawFeature = { axis = { \l__olfont_axis_tl } } } }
        \__olfont_axis:n { \int_use:N \l__olfont_b_int }
        \__olfont_put:n { BoldFeatures = { RawFeature = { axis = { \l__olfont_axis_tl } } } }
        \__olfont_put:n { BoldItalicFeatures = { RawFeature = { axis = { \l__olfont_axis_tl } } } }
        \tl_if_blank:nF {#2} { \__olfont_put:n { RawFeature = { \exp_not:n {#2} } } }
        \use:e { \exp_not:N \fontspec { \exp_not:n {#3} } [ \exp_not:V \l__olfont_opts_tl ] }
        #4
        \group_end:
      }
  }
  { \DeclareDocumentCommand \olfont { O{} O{} m +m } {#4} }
\ExplSyntaxOff`;
