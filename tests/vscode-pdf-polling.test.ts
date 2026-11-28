import { expect, it } from 'vitest';
import { lastBuild } from '../packages/vscode/src/host/build';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

it('restores an already compiled PDF after the extension host reloads', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overlyx-existing-pdf-'));
  try {
    const tex = path.join(dir, 'main.tex'), pdf = path.join(dir, 'main.pdf');
    expect(lastBuild(dir, tex)).toBeUndefined();
    fs.writeFileSync(pdf, '%PDF-1.4\n');
    const build = lastBuild(dir, tex);
    expect(build).toMatchObject({ status: 'ok', pdf_path: pdf, tex_path: tex, log: '' });
    expect(build?.updated_at).toBe(Math.round(fs.statSync(pdf).mtimeMs));
    expect(lastBuild(dir)).toEqual(build);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// (how the preview follows a build: tests/buildwatch.test.ts — the web app's PDF pane and this preview share app/buildwatch.ts)
