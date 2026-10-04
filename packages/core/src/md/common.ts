/**
 * What markdown documents share between the parser and the writer: the paragraph layouts markdown
 * can express, and the document settings a markdown file implies (it has none of its own).
 */
import type { Header } from '../lyx/ast.ts';

/** `#` … `#####` (`######` is written as `#####`: the article class has five heading levels) */
export const HEADING_LAYOUTS = ['Section', 'Subsection', 'Subsubsection', 'Paragraph', 'Subparagraph'];

/** heading level (1–5) of a layout, unnumbered variants and the bigger class headings included */
export function headingLevel(layout: string): number {
  const l = layout.replace(/\*$/, '');
  const i = HEADING_LAYOUTS.indexOf(l);
  if (i >= 0) return i + 1;
  if (l === 'Part' || l === 'Chapter' || l === 'Title') return 1;
  return 0;
}

/**
 * The paragraph layouts of a markdown document: what the layout menu offers and what the editor
 * keeps (anything else — pasted from a LaTeX document — becomes the closest of these).
 */
export const MARKDOWN_LAYOUTS = ['Standard', ...HEADING_LAYOUTS, 'Itemize', 'Enumerate', 'Quote'];

/** a layout markdown cannot express → the one it is written as */
export function markdownLayoutFor(layout: string): string {
  if (MARKDOWN_LAYOUTS.includes(layout)) return layout;
  const level = headingLevel(layout);
  if (level) return HEADING_LAYOUTS[level - 1];
  if (layout === 'Quotation' || layout === 'Verse') return 'Quote';
  if (layout === 'Description' || layout === 'Labeling' || layout === 'List') return 'Itemize';
  return 'Standard';
}

/** Is this file a markdown document (opened in the editor, written as markdown)? */
export function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown|mdown|mkd)$/i.test(path);
}

/**
 * The settings of every markdown document: the article class without section numbers, paragraphs
 * separated by space rather than indented (as markdown renders them), links via hyperref.
 */
export function markdownHeader(): Header {
  return {
    lines: [
      '\\textclass article', '\\use_default_options true', '\\maintain_unincluded_children no', '\\language english', '\\language_package default',
      '\\inputencoding utf8', '\\fontencoding auto', '\\font_roman "default" "default"', '\\font_sans "default" "default"', '\\font_typewriter "default" "default"',
      '\\font_math "auto" "auto"', '\\font_default_family default', '\\use_non_tex_fonts false', '\\font_sc false', '\\font_roman_osf false',
      '\\font_sans_osf false', '\\font_typewriter_osf false', '\\font_sf_scale 100 100', '\\font_tt_scale 100 100', '\\use_microtype false',
      '\\use_dash_ligatures true', '\\graphics default', '\\default_output_format default', '\\output_sync 0', '\\bibtex_command default',
      '\\index_command default', '\\float_placement class', '\\float_alignment class', '\\paperfontsize default', '\\spacing single',
      '\\use_hyperref true', '\\papersize default', '\\use_geometry false', '\\use_package amsmath 1', '\\use_package amssymb 1',
      '\\use_package cancel 1', '\\use_package esint 1', '\\use_package mathdots 1', '\\use_package mathtools 1', '\\use_package mhchem 1',
      '\\use_package stackrel 1', '\\use_package stmaryrd 1', '\\use_package undertilde 1', '\\cite_engine basic', '\\cite_engine_type default',
      '\\biblio_style plain', '\\use_bibtopic false', '\\use_indices false', '\\paperorientation portrait', '\\suppress_date false',
      '\\justification false', '\\crossref_package prettyref', '\\use_formatted_ref 0', '\\use_minted 0', '\\use_lineno 0', '\\index Index',
      '\\shortcut idx', '\\color #008000', '\\end_index', '\\secnumdepth -1', '\\tocdepth 3', '\\paragraph_separation skip', '\\defskip medskip',
      '\\is_math_indent 0', '\\math_numbering_side default', '\\quotes_style english', '\\dynamic_quotes 0', '\\papercolumns 1', '\\papersides 1',
      '\\paperpagestyle default', '\\tablestyle default', '\\tracking_changes false', '\\output_changes true', '\\change_bars false',
      '\\postpone_fragile_content true', '\\html_math_output 0', '\\html_css_as_file 0', '\\html_be_strict false', '\\docbook_table_output 0',
      '\\docbook_mathml_prefix 1',
    ],
  };
}
