/**
 * Whiteboard documents (.board): the BoardDoc side of the document manager — JSON file ↔
 * Y.Map('objects') round trip, deterministic serialisation, external changes, and the sketch
 * sidecar SVGs a .tex document writes on save.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(process.env.OVERLYX_SCRATCH ?? tmpdir(), 'overlyx-board-test');
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(join(ROOT, 'projects', 'p'), { recursive: true });
process.env.OVERLYX_DATA_DIR = join(ROOT, 'data');
process.env.OVERLYX_PROJECTS_DIR = join(ROOT, 'projects');

const { manager, BoardDoc } = await import('../packages/server/src/docs.ts');
const { inkSvg } = await import('../packages/core/src/ink.ts');

const file = (name: string) => join(ROOT, 'projects', 'p', name);
const EMPTY = '{"overlyx":"board","v":1,"objects":{\n}}\n';

beforeAll(() => {
  writeFileSync(file('plan.board'), EMPTY);
  writeFileSync(file('full.board'), '{"overlyx":"board","v":1,"objects":{\n"b": {"t":"note","x":1,"y":2,"w":100,"h":40,"text":"hi"},\n"a": {"t":"stroke","x":0,"y":0,"color":"#000","w":2,"pts":[[0,0,1],[5,5,1]]}\n}}\n');
});

describe('board documents', () => {
  it('opens a .board file as a BoardDoc and loads its objects', async () => {
    const doc = await manager.open('p/full.board');
    expect(doc).toBeInstanceOf(BoardDoc);
    const b = doc as InstanceType<typeof BoardDoc>;
    expect(b.objects.size).toBe(2);
    expect((b.objects.get('b') as { text: string }).text).toBe('hi');
  });

  it('writes edits back as deterministic, sorted, line-per-object JSON', async () => {
    const doc = await manager.open('p/plan.board') as InstanceType<typeof BoardDoc>;
    doc.ydoc.transact(() => {
      doc.objects.set('s1', { t: 'note', x: 10, y: 20, w: 120, h: 60, text: 'todo' });
      doc.objects.set('a9', { t: 'stroke', x: 0, y: 0, color: '#1a73e8', w: 2, pts: [[0, 0, 0.5]] });
    }, 'test');
    expect(doc.dirty).toBe(true);
    expect(await doc.saveToFile()).toBe(true);
    const onDisk = readFileSync(file('plan.board'), 'utf8');
    expect(onDisk.indexOf('"a9"')).toBeLessThan(onDisk.indexOf('"s1"'));   // sorted keys
    expect(onDisk.endsWith('}}\n')).toBe(true);
    expect(JSON.parse(onDisk).objects.s1.text).toBe('todo');
    // a second save changes nothing
    doc.dirty = true;
    await doc.saveToFile();
    expect(readFileSync(file('plan.board'), 'utf8')).toBe(onDisk);
  });

  it('absorbs an external change to the file (git, another editor)', async () => {
    const doc = await manager.open('p/plan.board') as InstanceType<typeof BoardDoc>;
    const text = '{"overlyx":"board","v":1,"objects":{\n"x": {"t":"note","x":0,"y":0,"w":50,"h":20,"text":"from git"}\n}}\n';
    writeFileSync(file('plan.board'), text);
    expect(doc.absorbExternalChange(text)).toBe(true);
    expect(doc.objects.size).toBe(1);
    expect((doc.objects.get('x') as { text: string }).text).toBe('from git');
  });
});

describe('sketch sidecar files', () => {
  it('a .tex document with a sketch writes the SVG next to it on save', async () => {
    const data = JSON.stringify({ v: 1, strokes: [{ side: 'left', color: '#d93025', w: 3, pts: [[0, 0, 0.7], [12, 8, 0.9]] }] });
    mkdirSync(file('figures'), { recursive: true });
    writeFileSync(file('figures/sketch-t.svg'), inkSvg(data));
    writeFileSync(file('s.tex'), '\\documentclass{article}\n\\begin{document}\n\\olsketch{figures/sketch-t.svg}Anchored paragraph.\n\\end{document}\n');
    const doc = await manager.open('p/s.tex');
    expect(doc.toText()).toContain('\\olsketch{figures/sketch-t.svg}');
    // the drawing changes (as a client stroke commit would): the save regenerates the SVG
    const d2 = JSON.stringify({ v: 1, strokes: [{ side: 'left', color: '#d93025', w: 3, pts: [[0, 0, 0.7], [12, 8, 0.9], [20, 2, 0.4]] }] });
    const lyx = doc.toLyxDocument();
    for (const p of lyx.body) for (const it of p.items) if (it.kind === 'inset' && it.inset.type === 'Leaf' && it.inset.name === 'Sketch') it.inset.params = [d2];
    doc.loadFromLyx(lyx, 'test');
    doc.dirty = true;
    expect(await doc.saveToFile()).toBe(true);
    expect(readFileSync(file('figures/sketch-t.svg'), 'utf8')).toBe(inkSvg(d2));
  });
});
