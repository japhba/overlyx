/**
 * OverLyX: New Slide Deck… / New Poster… / New Web Page… (HTML deliverables: a folder with an
 * index.html, host/deliverables.ts) and New Document… (command palette, File ▸ New File…): a LaTeX
 * or Markdown document (core newdoc.ts) or a LaTeX layout document (slides, poster or page, core
 * layout/templates.ts) — the templates the web app's File ▸ New uses — saved where the user picks
 * and opened in the OverLyX editor.
 */
import * as vscode from 'vscode';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { PAGE_PRESETS, newDocumentText, newMarkdownText } from '@overlyx/core';
import { newLayoutDocumentText } from './texdoc.ts';
import { newDeliverable } from './deliverables.ts';

type Kind = 'slides' | 'poster' | 'page' | 'latex' | 'markdown';

interface Choice extends vscode.QuickPickItem { doc: Kind; preset?: string }

/** the name offered in the save dialog; a file named like this (or `slides-2.tex` …) gets the template's placeholder title */
const DEFAULT_NAME: Record<Kind, string> = { slides: 'slides.tex', poster: 'poster.tex', page: 'page.tex', latex: 'document.tex', markdown: 'document.md' };

const ICON: Record<Kind, string> = { slides: '$(preview)', poster: '$(layout)', page: '$(file)', latex: '$(file-text)', markdown: '$(markdown)' };

const mm = (n: number) => String(Math.round(n * 10) / 10);

function choices(kinds: Kind[]): (Choice | vscode.QuickPickItem)[] {
  const out: (Choice | vscode.QuickPickItem)[] = [];
  const section = (label: string) => { if (kinds.length > 1) out.push({ label, kind: vscode.QuickPickItemKind.Separator }); };
  if (kinds.includes('latex') || kinds.includes('markdown')) section('Documents');
  if (kinds.includes('latex')) out.push({ doc: 'latex', label: `${ICON.latex} LaTeX document`, description: 'article' } as Choice);
  if (kinds.includes('markdown')) out.push({ doc: 'markdown', label: `${ICON.markdown} Markdown document` } as Choice);
  for (const [kind, title] of [['slides', 'Slides'], ['poster', 'Posters'], ['page', 'Pages']] as const) {
    if (!kinds.includes(kind)) continue;
    section(title);
    for (const p of PAGE_PRESETS.filter(x => x.kind === kind)) out.push({ doc: kind, preset: p.id, label: `${ICON[kind]} ${p.label}`, description: `${mm(p.w)} × ${mm(p.h)} mm` } as Choice);
  }
  return out;
}

const PICK: Record<'any' | 'slides' | 'poster', { title: string; placeholder: string; kinds: Kind[] }> = {
  any: { title: 'New document', placeholder: 'What to create — LaTeX slides, posters and pages are beamer files of freely placed text boxes, shapes and images (New Slide Deck / Poster / Web Page make HTML ones)', kinds: ['latex', 'markdown', 'slides', 'poster', 'page'] },
  slides: { title: 'New slide deck', placeholder: 'Aspect ratio — a beamer file of slides with freely placed text boxes, shapes and images', kinds: ['slides'] },
  poster: { title: 'New poster', placeholder: 'Paper size — a beamer file of freely placed text boxes, shapes and images', kinds: ['poster'] },
};

/** where the save dialog starts: the folder of the active file (each folder is a project), else the workspace's */
function startFolder(): string {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  const uri = input instanceof vscode.TabInputCustom || input instanceof vscode.TabInputText ? input.uri : undefined;
  if (uri?.scheme === 'file') return path.dirname(uri.fsPath);
  return vscode.workspace.workspaceFolders?.find(f => f.uri.scheme === 'file')?.uri.fsPath ?? os.homedir();
}

function freeName(dir: string, name: string): string {
  const ext = path.extname(name), stem = name.slice(0, -ext.length);
  for (let i = 2, n = name; ; n = `${stem}-${i++}${ext}`) if (!fs.existsSync(path.join(dir, n))) return n;
}

/** git's user.name — the author on a new title page, as the web app puts the account's name there */
function gitUserName(cwd: string): string | undefined {
  try { return execFileSync('git', ['config', 'user.name'], { cwd, encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined; } catch { return undefined; }
}

/** The new file's text; `abs` is where it goes (the writer reads the folder's packages and macros). */
function newFileText(choice: { doc: Kind; preset?: string }, abs: string, layoutDir: string, author?: string): string {
  const stem = path.basename(abs).replace(/\.[^.]+$/, '');
  // a name the user chose is the title; the offered one keeps the template's placeholder
  const title = stem.replace(/-\d+$/, '') === DEFAULT_NAME[choice.doc].replace(/\.[^.]+$/, '') ? undefined : stem.replace(/[-_]+/g, ' ').trim() || undefined;
  if (choice.doc === 'markdown') return newMarkdownText(title);
  if (choice.doc === 'latex') return newDocumentText(title ? { title, author } : {});
  return newLayoutDocumentText({ root: path.dirname(abs), layoutDir }, path.basename(abs), choice.preset ?? 'slides169', { title, author });
}

async function createNew(which: keyof typeof PICK, layoutDir: () => string): Promise<void> {
  const pick = PICK[which];
  const choice = await vscode.window.showQuickPick(choices(pick.kinds), { title: pick.title, placeHolder: pick.placeholder, matchOnDescription: true }) as Choice | undefined;
  if (!choice) return;
  const ext = choice.doc === 'markdown' ? '.md' : '.tex';
  const dir = startFolder();
  const uri = await vscode.window.showSaveDialog({
    title: choice.label.replace(/^\$\([\w-]+\) /, 'New '),
    saveLabel: 'Create',
    defaultUri: vscode.Uri.file(path.join(dir, freeName(dir, DEFAULT_NAME[choice.doc]))),
    filters: ext === '.md' ? { Markdown: ['md', 'markdown'] } : { 'LaTeX document': ['tex'] },
  });
  if (!uri) return;
  let abs = uri.fsPath;
  if (ext === '.md' ? !/\.(md|markdown)$/i.test(abs) : !/\.tex$/i.test(abs)) {
    abs += ext;
    // the dialog asked about replacing the name as typed, not this one
    if (fs.existsSync(abs)) { void vscode.window.showErrorMessage(`OverLyX: ${path.basename(abs)} already exists`); return; }
  }
  const author = choice.doc === 'markdown' ? undefined : gitUserName(path.dirname(abs));
  const text = newFileText(choice, abs, layoutDir(), author);
  await vscode.workspace.fs.writeFile(vscode.Uri.file(abs), Buffer.from(text, 'utf8'));
  await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(abs), 'overlyx.texEditor', { preview: false });
}

export function registerNewDocumentCommands(layoutDir: () => string, report: (error: unknown, area: string) => void): vscode.Disposable[] {
  const command = (id: string, which: keyof typeof PICK) => vscode.commands.registerCommand(id, () => createNew(which, layoutDir).catch(e => {
    report(e, 'newDocument');
    void vscode.window.showErrorMessage('OverLyX: could not create the document: ' + ((e as Error)?.message ?? String(e)));
  }));
  // slide decks, posters and web pages are HTML deliverables now (host/deliverables.ts); the LaTeX layout documents stay in New Document…
  const html = (id: string, kind: 'deck' | 'poster' | 'page') => vscode.commands.registerCommand(id, () => newDeliverable(kind, startFolder()).catch(e => {
    report(e, 'newDeliverable');
    void vscode.window.showErrorMessage('OverLyX: could not create it: ' + ((e as Error)?.message ?? String(e)));
  }));
  return [command('overlyx.newDocument', 'any'), html('overlyx.newSlides', 'deck'), html('overlyx.newPoster', 'poster'), html('overlyx.newWebPage', 'page')];
}
