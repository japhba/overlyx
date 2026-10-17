/** Google fonts for markdown documents (server googlefonts.ts): fetched once, cached, a name Google lacks remembered. */
import { describe, it, expect, vi } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = vi.hoisted(() => {
  const r = require('node:path').join(require('node:os').tmpdir(), 'overlyx-googlefonts-test');
  process.env.OVERLYX_DATA_DIR = require('node:path').join(r, 'data');
  return r;
});
rmSync(ROOT, { recursive: true, force: true });
const { googleFont, fontFaces, setFetch, validFamily } = await import('../packages/server/src/googlefonts.ts');

const CSS = (fam: string) => `@font-face {\n  font-family: '${fam}';\n  font-style: normal;\n  font-weight: 400;\n  src: url(https://fonts.gstatic.com/s/x/v1/regular.ttf) format('truetype');\n}\n@font-face {\n  font-family: '${fam}';\n  font-style: italic;\n  font-weight: 700;\n  src: url(https://fonts.gstatic.com/s/x/v1/bolditalic.ttf) format('truetype');\n}\n`;

describe('google fonts', () => {
  it('fetches a family once (regular, bold, italic, bold italic asked for) and keeps it', async () => {
    const asked: string[] = [];
    setFetch((async (u: string) => {
      asked.push(String(u));
      if (String(u).includes('css2?family=Lora')) return new Response(CSS('Lora'));
      if (String(u).startsWith('https://fonts.gstatic.com/')) return new Response(new Uint8Array([0, 1, 0, 0, 7]));
      return new Response('', { status: 400 });
    }) as typeof fetch);
    const f = (await googleFont('Lora'))!;
    expect(asked[0]).toBe('https://fonts.googleapis.com/css2?family=Lora:ital,wght@0,400;0,700;1,400;1,700');
    expect(f.files.map(x => x.file)).toEqual(['lora-400.ttf', 'lora-700i.ttf']);
    expect(existsSync(join(f.dir, 'lora-400.ttf'))).toBe(true);
    expect(fontFaces(f)).toEqual({ regular: 'lora-400.ttf', bold: undefined, italic: undefined, boldItalic: 'lora-700i.ttf' });
    asked.length = 0;
    expect((await googleFont('Lora'))!.files.length).toBe(2);
    expect(asked).toEqual([]);
  });
  it('remembers a name Google does not know, and refuses names that are no family name', async () => {
    let calls = 0;
    setFetch((async () => { calls++; return new Response('', { status: 400 }); }) as typeof fetch);
    expect(await googleFont('No Such Font')).toBeNull();
    const before = calls;
    expect(await googleFont('No Such Font')).toBeNull();
    expect(calls).toBe(before);
    expect(validFamily('Inter')).toBe(true);
    expect(validFamily('../etc')).toBe(false);
    expect(await googleFont('x}\\\\bad')).toBeNull();
  });
});
