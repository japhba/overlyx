/**
 * Structural health of a .tex file — catches the case an external tool (a text editor, git merge,
 * hand edit) broke the conventions OverLyX relies on: the managed block markers, the settings
 * line, or basic LaTeX document/brace balance. A total, text-only check (never throws), so it can
 * run on anything absorbed from disk before the parser gets a chance to paper over it silently.
 *
 * `fixable` issues can be mended mechanically by `repairTex` (safe: it only ever inserts a marker
 * back where its counterpart already anchors it). Everything else — a corrupted settings line, a
 * missing/duplicated `\begin{document}`, unbalanced braces — cannot be fixed without understanding
 * the surrounding content, and is left for a human or the "Escalate to AI" repair instead.
 */
import { MANAGED_BEGIN, MANAGED_END, SETTINGS_PREFIX, readSettings, maskComments } from './preamble.ts';

export interface HealthIssue {
  code: 'managed-block-duplicated-begin' | 'managed-block-duplicated-end' | 'managed-block-missing-end'
      | 'managed-block-missing-begin' | 'managed-block-reversed' | 'settings-missing' | 'settings-invalid'
      | 'document-boundary' | 'brace-imbalance';
  message: string;
  severity: 'warning' | 'error';
  /** whether `repairTex` can mend this issue mechanically, without guessing at content */
  fixable: boolean;
}

/** Checks `text` (the file as it would be saved) for structural damage. `isFragment` skips the
 *  single-\begin{document}-\end{document} check for child documents (they have none). */
export function checkTexHealth(text: string, opts: { isFragment?: boolean } = {}): HealthIssue[] {
  const issues: HealthIssue[] = [];
  const masked = maskComments(text);

  const beginIdx = text.indexOf(MANAGED_BEGIN);
  const beginIdx2 = beginIdx >= 0 ? text.indexOf(MANAGED_BEGIN, beginIdx + 1) : -1;
  const endIdx = text.indexOf(MANAGED_END);
  const endIdx2 = endIdx >= 0 ? text.indexOf(MANAGED_END, endIdx + 1) : -1;

  if (beginIdx2 >= 0) issues.push({ code: 'managed-block-duplicated-begin', message: 'The OverLyX managed-block start marker appears more than once.', severity: 'error', fixable: false });
  if (endIdx2 >= 0) issues.push({ code: 'managed-block-duplicated-end', message: 'The OverLyX managed-block end marker appears more than once.', severity: 'error', fixable: false });
  if (beginIdx >= 0 && endIdx < 0) issues.push({ code: 'managed-block-missing-end', message: 'The OverLyX managed block is missing its end marker.', severity: 'error', fixable: beginIdx2 < 0 });
  else if (endIdx >= 0 && beginIdx < 0) issues.push({ code: 'managed-block-missing-begin', message: 'The OverLyX managed block is missing its start marker.', severity: 'error', fixable: endIdx2 < 0 });
  else if (beginIdx >= 0 && endIdx >= 0 && endIdx < beginIdx) issues.push({ code: 'managed-block-reversed', message: "The managed block's end marker appears before its start marker.", severity: 'error', fixable: false });

  if (beginIdx >= 0 && endIdx > beginIdx) {
    const block = text.slice(beginIdx, endIdx + MANAGED_END.length);
    if (!block.includes(SETTINGS_PREFIX)) issues.push({ code: 'settings-missing', message: 'The managed block has no settings line — the document class and other settings will reset to defaults on the next save.', severity: 'error', fixable: false });
    else if (!readSettings(block)) issues.push({ code: 'settings-invalid', message: 'The settings line is not valid JSON — settings will reset to defaults on the next save.', severity: 'error', fixable: false });
  }

  if (!opts.isFragment) {
    const beginDoc = (masked.match(/\\begin\{document\}/g) ?? []).length;
    const endDoc = (masked.match(/\\end\{document\}/g) ?? []).length;
    if (beginDoc !== 1 || endDoc !== 1) issues.push({ code: 'document-boundary', message: `Found ${beginDoc} \\begin{document} and ${endDoc} \\end{document} (expected exactly one each).`, severity: 'error', fixable: false });
  }

  let depth = 0;
  for (let i = 0; i < masked.length; i++) {
    const c = masked[i];
    if (c === '\\') { i++; continue; }   // an escaped char (incl. \{ \}) is literal, not a group delimiter
    if (c === '{') depth++;
    else if (c === '}') depth--;
  }
  if (depth !== 0) issues.push({ code: 'brace-imbalance', message: `Unbalanced braces (${depth > 0 ? depth + ' unclosed' : -depth + ' extra closing'}) — the document may fail to compile.`, severity: 'warning', fixable: false });

  return issues;
}

/** Mends the `fixable` issues in `issues` by inserting the missing marker next to its counterpart.
 *  Never touches content, and is a no-op when nothing fixable is present. */
export function repairTex(text: string, issues: HealthIssue[]): { text: string; fixed: HealthIssue['code'][] } {
  let out = text;
  const fixed: HealthIssue['code'][] = [];
  for (const issue of issues) {
    if (!issue.fixable) continue;
    if (issue.code === 'managed-block-missing-end') {
      const beginIdx = out.indexOf(MANAGED_BEGIN);
      if (beginIdx < 0) continue;
      const docIdx = out.indexOf('\\begin{document}', beginIdx);
      const insertAt = docIdx >= 0 ? docIdx : out.length;
      out = out.slice(0, insertAt).replace(/\n*$/, '\n\n') + MANAGED_END + '\n\n' + out.slice(insertAt);
      fixed.push(issue.code);
    } else if (issue.code === 'managed-block-missing-begin') {
      const endIdx = out.indexOf(MANAGED_END);
      if (endIdx < 0) continue;
      const settingsIdx = out.lastIndexOf(SETTINGS_PREFIX, endIdx);
      const insertAt = settingsIdx >= 0 && settingsIdx < endIdx ? out.lastIndexOf('\n', settingsIdx) + 1 : endIdx;
      out = out.slice(0, insertAt) + MANAGED_BEGIN + '\n' + out.slice(insertAt);
      fixed.push(issue.code);
    }
  }
  return { text: out, fixed };
}
