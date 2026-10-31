/**
 * What is selected in an OverLyX editor, for the agents on this computer (Claude Code, Codex): VS
 * Code tells them the selection of a text editor itself, but an OverLyX editor is a webview they
 * cannot see into. The webview sends its selection as the source pane knows places
 * (`AgentSelection`: the top-level paragraphs and the text around each end, app/sourcelocate.ts),
 * the host places it in the file's source (`placeSelection`, with the source map the source pane
 * uses, app/sourcemap.ts) and the local tool server's get_selection hands it to an agent that asks
 * (agents/server.ts). Pure text functions.
 */
import { findSourceOffset, type CursorContext } from '../../../client/src/app/sourcelocate.ts';
import { sourceOffsetInSpan, lineOfOffset, lineStart, type Span } from '../../../client/src/app/sourcemap.ts';

/** one end of the selection: its top-level paragraph, and the text around it */
export interface SelectionEnd { block: number; ctx: CursorContext | null }

export interface AgentSelection {
  /** what is selected as it reads (formulas as $LaTeX$); '' for a caret */
  text: string;
  /** the document's top-level paragraphs in the editor (the source map fits when the file has as many) */
  blocks: number;
  from: SelectionEnd;
  to: SelectionEnd;
}

/** a selection placed in the file */
export interface PlacedSelection {
  /** 1-based, inclusive */
  startLine: number;
  endLine: number;
  /** the source of those lines */
  source: string;
}

export const SELECTION_MAX = 6000;

/** Where `sel` is in the document's source `text` (`spans`: its source map, null when there is none). */
export function placeSelection(text: string, spans: Span[] | null, sel: AgentSelection): PlacedSelection {
  const fits = !!spans && spans.length === sel.blocks;
  const offsetOf = (end: SelectionEnd, last: boolean): number => {
    const span = fits ? spans![end.block] : null;
    if (span) return end.ctx ? sourceOffsetInSpan(text, span, end.ctx) : last ? span.end : span.start;
    return (end.ctx ? findSourceOffset(text, end.ctx) : null) ?? 0;
  };
  let start = offsetOf(sel.from, false);
  let end = sel.text ? offsetOf(sel.to, true) : start;
  if (end < start) [start, end] = [end, start];
  const from = lineStart(text, start);
  // (a selection ending at a line's start ends on the line before)
  const nl = text.indexOf('\n', end > start ? end - 1 : end);
  const to = nl < 0 ? text.length : nl;
  const startLine = lineOfOffset(text, from) + 1;
  return { startLine, endLine: Math.max(startLine, lineOfOffset(text, to) + 1), source: text.slice(from, Math.min(to, from + SELECTION_MAX)) };
}
