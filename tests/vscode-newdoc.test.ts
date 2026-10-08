/**
 * VS Code ▸ OverLyX: New Slide Deck… / New Poster… / New Document…: the extension writes a new
 * slide deck, poster or page exactly as the web app's File ▸ New slides / poster / page does (server
 * texdoc.ts), and the file opens as layout pages; LaTeX and Markdown documents come from the
 * templates both shells share (core newdoc.ts).
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(process.env.OVERLYX_SCRATCH ?? tmpdir(), 'overlyx-vscode-newdoc-test');
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(join(ROOT, 'projects', 'ann', 'p'), { recursive: true });
mkdirSync(join(ROOT, 'folder'), { recursive: true });
process.env.OVERLYX_DATA_DIR = join(ROOT, 'data');
process.env.OVERLYX_PROJECTS_DIR = join(ROOT, 'projects');

const { config } = await import('../packages/server/src/config.ts');
const server = await import('../packages/server/src/texdoc.ts');
const host = await import('../packages/vscode/src/host/texdoc.ts');
const { PAGE_PRESETS, lyxToPm, MANAGED_BEGIN, newDocumentText, newMarkdownText } = await import('@overlyx/core');

afterAll(() => { rmSync(ROOT, { recursive: true, force: true }); });

describe('new documents in VS Code', () => {
  const ctx = { root: join(ROOT, 'folder'), layoutDir: config.layoutDir };

  it.each(PAGE_PRESETS.map(p => [p.id, p.kind]))('%s (%s): the same file as the web app, opening as layout pages', (preset) => {
    const opts = { title: 'Why the sky is blue', author: 'Ann Example' };
    const text = host.newLayoutDocumentText(ctx, 'talk.tex', preset, opts);
    expect(text).toBe(server.newLayoutDocumentText('ann/p', 'talk.tex', preset, opts));
    expect(text).toContain(MANAGED_BEGIN);
    expect(text).toContain('Why the sky is blue');
    const pm = lyxToPm(host.parseDocumentText(text, ctx, 'talk.tex').doc) as { content: { type: string }[] };
    expect(pm.content.length).toBeGreaterThan(0);
    expect(pm.content.every(n => n.type === 'ol_page')).toBe(true);
  });

  it('LaTeX and Markdown documents: the shared templates', () => {
    expect(newDocumentText()).toMatch(/^\\documentclass\[11pt\]\{article\}[\s\S]*\\begin\{document\}\n\n\n\\end\{document\}\n$/);
    expect(newDocumentText({ title: 'Notes_1', author: 'Ann' })).toContain('\\title{Notes\\_1}\n\\author{Ann}\n\\maketitle\n');
    expect(newMarkdownText(' My  notes ')).toBe('# My notes\n\n');
    expect(newMarkdownText()).toBe('');
  });
});
