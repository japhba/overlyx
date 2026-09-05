import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Bridge, type BridgeDelegate } from '../packages/vscode/src/host/bridge.ts';
import { graphicsUrl, fileUrl } from '../packages/client/src/api.ts';
import { resolveDocPath } from '../packages/client/src/editor/context.ts';

const fixtures = new URL('../packages/vscode/test/fixtures/', import.meta.url);
const png = fs.readFileSync(new URL('graphics.png', fixtures));
let workspace: string, root: string, bridge: Bridge;

beforeAll(async () => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'overlyx-graphics-'));
  root = path.join(workspace, 'paper');
  fs.mkdirSync(path.join(root, 'chapters'), { recursive: true });
  fs.mkdirSync(path.join(workspace, 'figures'));
  fs.writeFileSync(path.join(root, 'local.png'), png);
  fs.writeFileSync(path.join(workspace, 'figures', 'plot #1.png'), png);
  fs.copyFileSync(new URL('graphics.pdf', fixtures), path.join(workspace, 'figures', 'plot.pdf'));
  fs.writeFileSync(path.join(workspace, 'private.txt'), 'not an image');
  bridge = new Bridge({ projectRoot: project => project === 'paper' ? root : undefined, cacheDir: () => path.join(workspace, 'cache') } as BridgeDelegate);
  await bridge.start();
});
afterAll(() => { bridge?.dispose(); if (workspace) fs.rmSync(workspace, { recursive: true, force: true }); });

describe('VS Code relative graphics paths', () => {
  it.each([
    ['local.png', ''],
    ['../local.png', 'chapters'],
    ['../figures/plot #1.png', ''],
    ['../../figures/plot #1.png', 'chapters'],
    ['../figures/plot #1', ''],
  ])('renders %s from document directory %s', async (filename, docDir) => {
    const response = await fetch(bridge.base + graphicsUrl('paper', resolveDocPath(filename, docDir)));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(png);
  });

  it.each(['../figures/plot.pdf', '../figures/plot'])('converts a parent PDF figure to PNG: %s', async filename => {
    const response = await fetch(bridge.base + graphicsUrl('paper', resolveDocPath(filename, ''), 100));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await response.arrayBuffer()).subarray(0, 8)).toEqual(png.subarray(0, 8));
  });

  it('reports a missing parent image without substituting a file in the paper folder', async () => {
    const response = await fetch(bridge.base + graphicsUrl('paper', resolveDocPath('../missing.png', '')));
    expect(response.status).toBe(404);
  });

  it('keeps non-image reads, raw files and uploads bounded to the project', async () => {
    const nonImage = await fetch(bridge.base + graphicsUrl('paper', '../private.txt'));
    expect(nonImage.status).toBe(403);
    const raw = await fetch(bridge.base + fileUrl('paper', '../figures/plot.pdf'));
    expect(raw.status).toBe(403);
    const upload = await fetch(`${bridge.base}/api/projects/paper/upload?path=${encodeURIComponent('../outside.png')}`, { method: 'POST', body: png });
    expect(upload.status).toBe(400);
    expect(fs.existsSync(path.join(workspace, 'outside.png'))).toBe(false);
  });
});
