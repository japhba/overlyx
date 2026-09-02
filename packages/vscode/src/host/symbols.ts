/**
 * Document symbols for .tex files: sections as a nested DocumentSymbol tree, so VS Code's
 * built-in Outline view and breadcrumbs work when a .tex file is open in a TEXT editor.
 * (The built-in Outline pane cannot be fed by webview custom editors at all — for the OverLyX
 * editor the Structure views show the live outline instead.)
 */
import * as vscode from 'vscode';
import { headingPlainText } from '@overlyx/core';

const LEVELS: Record<string, number> = { part: -1, chapter: 0, section: 1, subsection: 2, subsubsection: 3, paragraph: 4, subparagraph: 5 };
const HEAD_RE = /^\s*\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)(\*?)\s*(?:\[[^\]]*\])?\s*\{(.*)$/;

interface Heading { level: number; text: string; line: number }

export function texHeadingLines(text: string): Heading[] {
  const out: Heading[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*%/.test(line)) continue;
    const m = HEAD_RE.exec(line);
    if (!m) continue;
    // the {…} argument, up to its matching brace (same line; a multi-line title keeps the first line)
    let depth = 1, body = '';
    for (let k = 0; k < m[3].length; k++) {
      const c = m[3][k];
      if (c === '\\') { body += c + (m[3][k + 1] ?? ''); k++; continue; }
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) break; }
      body += c;
    }
    out.push({ level: LEVELS[m[1]], text: headingPlainText(body) || '(untitled)', line: i });
  }
  return out;
}

export function texDocumentSymbols(document: vscode.TextDocument): vscode.DocumentSymbol[] {
  const headings = texHeadingLines(document.getText());
  const lastLine = Math.max(0, document.lineCount - 1);
  const roots: vscode.DocumentSymbol[] = [];
  const stack: { level: number; sym: vscode.DocumentSymbol }[] = [];
  headings.forEach((h, i) => {
    // the section runs to the line before the next heading of the same or a higher level
    let end = lastLine;
    for (let j = i + 1; j < headings.length; j++) { if (headings[j].level <= h.level) { end = Math.max(h.line, headings[j].line - 1); break; } }
    const range = new vscode.Range(h.line, 0, end, document.lineAt(Math.min(end, lastLine)).text.length);
    const sel = new vscode.Range(h.line, 0, h.line, document.lineAt(Math.min(h.line, lastLine)).text.length);
    const sym = new vscode.DocumentSymbol(h.text, '', vscode.SymbolKind.String, range, sel);
    while (stack.length && stack[stack.length - 1].level >= h.level) stack.pop();
    (stack.length ? stack[stack.length - 1].sym.children : roots).push(sym);
    stack.push({ level: h.level, sym });
  });
  return roots;
}

export function registerTexSymbols(): vscode.Disposable {
  const provider: vscode.DocumentSymbolProvider = { provideDocumentSymbols: (doc) => texDocumentSymbols(doc) };
  // one selector only — a second (e.g. language 'latex') would double every outline entry,
  // since VS Code concatenates the results of all matching providers
  return vscode.languages.registerDocumentSymbolProvider({ pattern: '**/*.tex', scheme: 'file' }, provider, { label: 'OverLyX' });
}
