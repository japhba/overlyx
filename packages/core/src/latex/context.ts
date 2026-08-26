/**
 * Shared state of one LaTeX export run.
 */
import type { LyxDocument, Paragraph } from '../lyx/ast.ts';
import type { BufferParams } from './params.ts';
import type { DocumentClass, InsetLayout } from './layouts.ts';
import type { Features } from './features.ts';
import type { LanguageDB, LanguageInfo } from './languages.ts';
import type { UnicodeDB } from './unicode.ts';
import type { MathSymbolDB } from './symbols.ts';
import type { LatexFontDB } from './latexfonts.ts';

export interface ExportOptions {
  /** Resolve an included child document (filename as written in the include inset). */
  resolveInclude?: (filename: string) => LyxDocument | undefined;
  /** Export as child: body only, no preamble. */
  isChild?: boolean;
  /** Directory with LyX layout files (default: $LYX_LAYOUT_DIR or /root/lyx/lib/layouts). */
  layoutDir?: string;
  /** Base name of the document (used for warnings / child file names). */
  basename?: string;
  /** Emit change tracking markup (\lyxadded/\lyxdeleted) — overrides \output_changes. */
  outputChanges?: boolean;
  /** Master document parameters (internal: set when exporting children). */
  masterParams?: BufferParams;
}

export interface ExportResult {
  tex: string;
  /** Child documents: 'lyxmacros.tex' → content */
  files: Record<string, string>;
  /** Graphics that must be copied/converted: dest is the file name referenced from the .tex */
  graphics: { src: string; dest: string }[];
  warnings: string[];
  /** LaTeX packages used (\usepackage) */
  requires: Set<string>;
}

export type EncodingMode = 'utf8' | 'legacy' | 'plain';

export interface ExportContext {
  doc: LyxDocument;
  bp: BufferParams;
  dc: DocumentClass;
  features: Features;
  opts: ExportOptions;
  warnings: string[];
  files: Record<string, string>;
  graphics: { src: string; dest: string }[];
  langs: LanguageDB;
  unicode: UnicodeDB;
  symbols: MathSymbolDB;
  fonts: LatexFontDB;
  docLanguage: LanguageInfo;
  useBabel: boolean;
  usePolyglossia: boolean;
  /** main font encoding: "T1", "OT1", "default", ... */
  mainFontenc: string;
  encodingMode: EncodingMode;
  /** inputenc name of the document encoding (utf8, latin9, ...) */
  encodingName: string;
  outputChanges: boolean;
  isChild: boolean;
  /** \maketitle bookkeeping (shared by the whole document) */
  needMaketitle: boolean;
  haveMaketitle: boolean;
  /** Bibliography paragraphs (for \begin{thebibliography}{widest}) */
  bibLabels: string[];
  /** Language currently open by \selectlanguage (babel name) */
  openLanguage: string;
  /** Depth of the include recursion (guards against loops) */
  includeDepth: number;
  /** All body paragraphs of the document (for lookups like bibitem widest) */
  bodyPars: Paragraph[];
  /** Layout of the main inset text */
  mainInsetLayout?: InsetLayout;
  /** Names of math macros defined in the document (protected in moving arguments) */
  macroNames: Set<string>;
}

/** Output parameters passed down while writing a text (LyX OutputParams). */
export interface RunParams {
  movingArg: boolean;
  passThru: boolean;
  passThruChars: string;
  freeSpacing: boolean;
  inFloat: 'none' | 'main' | 'sub';
  inTableCell: 'none' | 'plain' | 'aligned';
  /** LyX language name of the text surrounding this inset */
  outerLang: string;
  inComment: boolean;
  inDeletedInset: boolean;
  inulemcmd: number;
  isMainText: boolean;
  forcePlain: boolean;
  parbreakIsNewline: boolean;
  parbreakIgnored: boolean;
  newlineCmd: string;
  inIPA: boolean;
  inIndexEntry: boolean;
  isNonLong: boolean;
  /** Owner inset kind (for alignment env selection) */
  owner: 'main' | 'float' | 'wrap' | 'cell' | 'other';
  /** Inset text is "InTitle" (thanks instead of footnote etc.) */
  inTitle: boolean;
  /** Fragile commands (labels) postponed after a moving argument command */
  postMacro: string;
  postponeFragile: boolean;
  /** Language switches within this text use local commands (\foreignlanguage) */
  localSwitch: boolean;
  /** Paragraph customization (alignment, noindent, spacing) allowed in this text */
  customPars: boolean;
  /** Layout font used as base (family/series/shape/size) */
  baseFont: { family?: string; series?: string; shape?: string; size?: string };
}

export function newRunParams(outerLang: string, isMainText: boolean): RunParams {
  return {
    movingArg: false, passThru: false, passThruChars: '', freeSpacing: false, inFloat: 'none', inTableCell: 'none',
    outerLang, inComment: false, inDeletedInset: false, inulemcmd: 0, isMainText, forcePlain: false,
    parbreakIsNewline: false, parbreakIgnored: false, newlineCmd: '', inIPA: false, inIndexEntry: false, isNonLong: false,
    owner: isMainText ? 'main' : 'other', inTitle: false, postMacro: '', postponeFragile: false, localSwitch: false,
    baseFont: {}, customPars: true,
  };
}
