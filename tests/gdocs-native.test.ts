import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = vi.hoisted(() => {
  const root = (process.env.OVERLYX_SCRATCH || process.env.TMPDIR || '/tmp') + '/overlyx-gdocs-native-test';
  process.env.OVERLYX_DATA_DIR = root + '/data';
  process.env.OVERLYX_PROJECTS_DIR = root + '/projects';
  return root;
});
import { parseMarkdown, writeMarkdown } from '../packages/core/src/md/index.ts';
import { project, strip, readGoogle, blockRuns, toParagraphs, MEDIA_WARNING, UNKNOWN_WARNING, type DocsDocument } from '../packages/server/src/gdocs/model.ts';
import { attachObjectSources, bindImportedObjects, nativeElements } from '../packages/server/src/gdocs/native.ts';
import { planRound } from '../packages/server/src/gdocs/edits.ts';
import { FakeGoogle } from '../packages/server/src/gdocs/fake.ts';
import * as docx from '../packages/server/src/gdocs/docx.ts';

// Recorded from a real DOCX import. Native equation spans are 19, 24 and 14 UTF-16 code units.
const converted = JSON.parse(fs.readFileSync(new URL('./fixtures/gdocs/docx-import.json', import.meta.url), 'utf8')) as DocsDocument;
const PROBE = '# Google Docs fidelity probe\n\nInline equation: $x^2 + y^2 = z^2$.\n\nA display equation:\n\n$$\n\\frac{\\partial L}{\\partial w} = \\sum_{i=1}^{n} x_i^2\n$$\n\nA matrix:\n\n$$\nA = \\begin{pmatrix}1 & 2 \\\\ 3 & 4\\end{pmatrix}\n$$\n\nAn embedded local image:\n\n![Test figure](figure.png){width=4in}\n\nText after the image.\n';
const model = () => parseMarkdown(PROBE).doc;

async function boundDoc() {
  const google = new FakeGoogle(), file = await google.createDocument('Fidelity');
  google.doc(file.id).load(converted);
  const { bindings, requests } = bindImportedObjects(await google.getDocument(file.id), project(model(), true).blocks);
  await google.batchUpdate(file.id, requests);
  const raw = async () => attachObjectSources(await google.getDocument(file.id), bindings);
  return { google, file, bindings, raw };
}

describe('native Google Docs objects', () => {
  it('retains object-only paragraphs and matches sources through moving ranges', async () => {
    const { raw } = await boundDoc();
    const read = readGoogle(await raw());
    const objects = read.blocks.flatMap(blockRuns).filter(r => r.native);
    expect(objects.map(r => r.native!.kind)).toEqual(['equation', 'equation', 'equation', 'image']);
    expect(objects.map(r => r.nativeSize)).toEqual([19, 24, 14, 1]);
    const result = writeMarkdown({ ...model(), body: toParagraphs(strip(read.blocks), project(model()).headings, true) }).text;
    expect(result).toContain('$x^2 + y^2 = z^2$');
    expect(result).toContain('figure.png');
    expect(result).toContain('\\begin{pmatrix}');
  });

  it('edits punctuation after an equation at its real index, preserving the equation and a comment', async () => {
    const { google, file, raw } = await boundDoc();
    const before = await raw(), equation = nativeElements(before)[0];
    const wanted = strip(readGoogle(before).blocks);
    const paragraph = wanted[1];
    if (paragraph.t !== 'p') throw new Error('expected paragraph');
    paragraph.runs.at(-1)!.text = '!';
    const comment = google.comment(file.id, 28, 34, 'Keep the lead-in');
    const requests = planRound(before, wanted);
    const deletion = requests.find(r => r.deleteContentRange) as { deleteContentRange: { range: { startIndex: number; endIndex: number } } };
    expect(deletion.deleteContentRange.range).toEqual({ startIndex: equation.endIndex, endIndex: equation.endIndex + 1 });
    await google.batchUpdate(file.id, requests, before.revisionId);
    expect(nativeElements(await raw())).toHaveLength(4);
    expect(google.anchored(file.id, comment.id)).toBe(true);
    expect(planRound(await raw(), wanted)).toEqual([]);
  });

  it('edits text on both sides of multiple objects and keeps their sources after index shifts', async () => {
    const { google, file, raw } = await boundDoc();
    const before = await raw(), wanted = strip(readGoogle(before).blocks);
    if (wanted[1].t !== 'p') throw new Error('expected paragraph');
    wanted[1].runs[0].text = 'Changed introduction: ';
    wanted[1].runs.at(-1)!.text = ' after the equation.';
    await google.batchUpdate(file.id, planRound(before, wanted), before.revisionId);
    const after = await raw();
    expect(readGoogle(after).blocks.flatMap(blockRuns).filter(r => r.native?.kind === 'unknown')).toEqual([]);
    expect(planRound(after, wanted)).toEqual([]);
  });

  it('preserves unmapped objects and reports the skipped paragraph', async () => {
    const raw = structuredClone(converted), warnings: string[] = [];
    expect(readGoogle(raw).blocks.flatMap(blockRuns).filter(r => r.native)).toHaveLength(4);
    const requests = planRound(raw, strip(project(model()).blocks), warnings);
    expect(warnings).toContain(UNKNOWN_WARNING);
    for (const r of requests as any[]) if (r.deleteContentRange) {
      for (const el of nativeElements(raw)) expect(r.deleteContentRange.range.startIndex < el.endIndex && r.deleteContentRange.range.endIndex > el.startIndex).toBe(false);
    }
  });

  it('edits every text segment around two equations and an inline image without replacing any object', async () => {
    const doc = parseMarkdown('Before $x$ between ![plot](figure.png) after $y$ end.').doc;
    const wanted = strip(project(doc, true).blocks);
    const paragraph = wanted[0];
    if (paragraph.t !== 'p') throw new Error('expected paragraph');
    let at = 1;
    const elements = paragraph.runs.map(r => {
      const startIndex = at;
      at += r.native ? r.native.kind === 'equation' ? 7 : 1 : r.text.length;
      return { startIndex, endIndex: at, ...(r.native ? r.native.kind === 'equation' ? { equation: {} } : { inlineObjectElement: { inlineObjectId: 'inline-image' } } : { textRun: { content: r.text } }) };
    });
    elements.push({ startIndex: at, endIndex: at + 1, textRun: { content: '\n' } });
    const raw: DocsDocument = { documentId: 'mixed', body: { content: [{ startIndex: 1, endIndex: at + 1, paragraph: { elements } }] } };
    const google = new FakeGoogle(), file = await google.createDocument('Mixed objects');
    google.doc(file.id).load(raw);
    const { bindings, requests } = bindImportedObjects(raw, wanted);
    await google.batchUpdate(file.id, requests);
    for (const r of paragraph.runs) if (!r.native) r.text = '🙂 ' + r.text.toUpperCase();
    const before = attachObjectSources(await google.getDocument(file.id), bindings);
    await google.batchUpdate(file.id, planRound(before, wanted), before.revisionId);
    const after = attachObjectSources(await google.getDocument(file.id), bindings);
    expect(nativeElements(after)).toHaveLength(3);
    expect(readGoogle(after).blocks.flatMap(blockRuns).filter(r => r.native?.kind === 'unknown')).toEqual([]);
    expect(planRound(after, wanted)).toEqual([]);
  });

  it('leaves a range spanning multiple objects unmapped rather than guessing their source', async () => {
    const { raw, bindings } = await boundDoc();
    const doc = await raw(), objects = nativeElements(doc);
    const name = Object.keys(bindings)[0];
    doc.namedRanges![name].namedRanges[0].ranges = [{ startIndex: objects[0].startIndex, endIndex: objects[1].endIndex }];
    expect(readGoogle(attachObjectSources(doc, bindings)).blocks.flatMap(blockRuns).some(r => r.native?.kind === 'unknown')).toBe(true);
  });

  it('leaves changed or newly inserted native objects out of the write plan with an explicit warning', async () => {
    const { raw } = await boundDoc();
    const original = await raw(), wanted = strip(readGoogle(original).blocks);
    const equation = wanted[1];
    if (equation.t !== 'p') throw new Error('expected paragraph');
    const run = equation.runs.find(r => r.native)!;
    run.native = { ...run.native!, text: '$different$' };
    const warnings: string[] = [];
    expect(planRound(original, wanted, warnings)).toEqual([]);
    expect(warnings).toContain(MEDIA_WARNING);
    const additional = project(parseMarkdown('New $formula$ paragraph.').doc, true).blocks;
    expect(planRound(original, [...strip(readGoogle(original).blocks), ...additional], warnings)).toEqual([]);
  });

  it('rejects missing or ambiguously mapped objects during initial conversion', () => {
    const raw = structuredClone(converted);
    raw.body.content = [];
    expect(() => bindImportedObjects(raw, project(model(), true).blocks)).toThrow(/conversion changed/);
  });
});

describe('DOCX-backed sync', async () => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(path.join(ROOT, 'projects/u/p'), { recursive: true });
  fs.mkdirSync(path.join(ROOT, 'data/cache'), { recursive: true });
  const sync = await import('../packages/server/src/gdocs/sync.ts');
  const { manager } = await import('../packages/server/src/docs.ts');
  const { createUser } = await import('../packages/server/src/auth.ts');
  const { registerProject } = await import('../packages/server/src/access.ts');
  const owner = createUser('u', 'U', null);
  registerProject('u/p', owner.id);
  const google = new FakeGoogle();
  const importer = vi.fn(async (title: string) => {
    const file = await google.createDocument(title);
    google.doc(file.id).load(converted);
    return file;
  });
  google.importDocument = importer;
  sync.setGoogleApiFactory(() => google);
  const file = path.join(ROOT, 'projects/u/p/probe.md'), id = 'u/p/probe.md';
  let fileId = '';
  let exporter: import('vitest').MockInstance<typeof docx.buildDocx>;
  beforeAll(async () => {
    exporter = vi.spyOn(docx, 'buildDocx').mockResolvedValue(Buffer.from('DOCX test payload'));
    fs.writeFileSync(file, PROBE);
    const link = await sync.linkNewGoogleDoc(id, owner.id, 'Native probe');
    fileId = link.file_id;
  });
  afterAll(async () => { exporter.mockRestore(); await manager.closeProject('u/p'); });

  it('uses conversion once and stores a verified native baseline; a second sync writes nothing', async () => {
    expect(importer).toHaveBeenCalledTimes(1);
    expect(sync.publicLink(sync.linkOf(id))?.format).toBe('docx');
    expect(Object.keys(JSON.parse(sync.linkOf(id)!.objects!))).toHaveLength(4);
    const report = await sync.syncDoc(id);
    expect(report.pushed).toBe(0);
    expect(report.warnings).toEqual([]);
    expect(importer).toHaveBeenCalledTimes(1);
  });

  it('pulls text edits beside a native equation as tracked changes without losing its source', async () => {
    const at = google.indexOf(fileId, 'Inline');
    await google.batchUpdate(fileId, [{ deleteContentRange: { range: { startIndex: at, endIndex: at + 6 } } }, { insertText: { location: { index: at }, text: 'Edited' } }], undefined, 'Kirsten');
    const report = await sync.syncDoc(id);
    expect(report.pulled).toBeGreaterThan(0);
    expect(report.pushed).toBe(0);
    const source = fs.readFileSync(file, 'utf8');
    expect(source).toContain('Edited');
    expect(source).toContain('$x^2 + y^2 = z^2$');
    expect(nativeElements(await google.getDocument(fileId))).toHaveLength(4);
  });

  it('persists warnings for a native object deletion and preserves the local formula', async () => {
    const equation = nativeElements(await google.getDocument(fileId))[0];
    await google.batchUpdate(fileId, [{ deleteContentRange: { range: { startIndex: equation.startIndex, endIndex: equation.endIndex } } }], undefined, 'Kirsten');
    const report = await sync.syncDoc(id);
    expect(report.warnings).toContain(MEDIA_WARNING);
    expect(sync.publicLink(sync.linkOf(id))?.warnings).toContain(MEDIA_WARNING);
    expect(fs.readFileSync(file, 'utf8')).toContain('$x^2 + y^2 = z^2$');
  });

  // Drive converting a DOCX uploaded into the Google Doc: its whole content becomes the recorded import
  const replacer = vi.fn(async (fileId: string) => {
    const d = google.doc(fileId);
    d.load(converted);
    d.namedRanges.clear();
    d.revision++;
  });

  it('uploads the document again when its formulas differ from the Google Doc’s, and binds them anew', async () => {
    google.replaceWithDocx = replacer;
    try {
      // (the equation deleted in Google Docs above: the formula here goes back as a native equation)
      expect(nativeElements(await google.getDocument(fileId))).toHaveLength(3);
      const report = await sync.syncDoc(id);
      expect(replacer).toHaveBeenCalledTimes(1);
      expect(report.warnings).not.toContain(MEDIA_WARNING);
      expect(nativeElements(await google.getDocument(fileId))).toHaveLength(4);
      expect(Object.keys(JSON.parse(sync.linkOf(id)!.objects!))).toHaveLength(4);
      // in step: the next sync uploads nothing
      expect((await sync.syncDoc(id)).pushed).toBe(0);
      expect(replacer).toHaveBeenCalledTimes(1);
    } finally { delete google.replaceWithDocx; replacer.mockClear(); }
  });

  it('an upload carries the open comment threads along: anchored again, replies included, the old comments let go', async () => {
    const at = google.indexOf(fileId, 'Text after');
    const theirs = google.comment(fileId, at, at + 10, 'Check this phrase');
    await google.createReply(fileId, theirs.id, { content: 'And a reply' }, 'Kirsten');
    expect((await sync.syncDoc(id)).comments.fromGoogle).toBe(1);
    expect(fs.readFileSync(file, 'utf8')).toContain('And a reply');
    const threads = () => (fs.readFileSync(file, 'utf8').match(/<!-- @comment/g) ?? []).length;
    expect(threads()).toBe(1);
    // Drive's conversion makes an anchored comment (by the account) of each Word comment in the upload
    const importing = vi.fn(async (gid: string) => {
      await replacer(gid);
      const doc = await manager.open(id);
      for (const t of docx.markThreads(doc.toLyxDocument()).threads) {
        const k = google.indexOf(gid, 'Text after');
        google.comment(gid, k, k + 10, t.content).author = { displayName: 'U', me: true };
      }
    });
    google.replaceWithDocx = importing;
    try {
      const equation = nativeElements(await google.getDocument(fileId))[1];
      await google.batchUpdate(fileId, [{ deleteContentRange: { range: { startIndex: equation.startIndex, endIndex: equation.endIndex } } }], undefined, 'Kirsten');
      const report = await sync.syncDoc(id);
      expect(importing).toHaveBeenCalledTimes(1);
      expect(report.notes.join(' ')).toMatch(/1 comment anchored in the Google Doc again/);
      const all = await google.listComments(fileId);
      const moved = all.find(c => c.id !== theirs.id && c.content === 'Kirsten: Check this phrase')!;
      expect(google.anchored(fileId, moved.id)).toBe(true);
      expect(moved.replies?.map(r => r.content)).toEqual(['Kirsten: And a reply']);
      // Kirsten's own comment cannot be deleted by the account: resolved instead, and no longer synced
      expect(all.find(c => c.id === theirs.id)?.resolved).toBe(true);
      expect(threads()).toBe(1);
      const again = await sync.syncDoc(id);
      expect(again.comments).toEqual({ fromGoogle: 0, toGoogle: 0 });
      expect(threads()).toBe(1);
      expect(fs.readFileSync(file, 'utf8')).not.toMatch(/\[resolved\]/);
    } finally { delete google.replaceWithDocx; replacer.mockClear(); }
  });

  it('turns an older text link (formulas as $…$) into a DOCX link with native equations', async () => {
    const legacy = path.join(ROOT, 'projects/u/p/legacy.md'), legacyId = 'u/p/legacy.md';
    fs.writeFileSync(legacy, PROBE);
    const importing = google.importDocument;
    delete google.importDocument;   // linked the old way: text, formulas written as $…$
    const link = await sync.linkNewGoogleDoc(legacyId, owner.id, 'Legacy').finally(() => { google.importDocument = importing; });
    expect(link.format).toBe('text');
    expect(JSON.stringify((await google.getDocument(link.file_id)).body)).toContain('$x^2 + y^2 = z^2$');
    google.replaceWithDocx = replacer;
    try {
      const report = await sync.syncDoc(legacyId);
      expect(replacer).toHaveBeenCalledTimes(1);
      expect(report.notes.join(' ')).toMatch(/formulas and images uploaded/);
      expect(sync.publicLink(sync.linkOf(legacyId))?.format).toBe('docx');
      expect(nativeElements(await google.getDocument(link.file_id))).toHaveLength(4);
      expect(fs.readFileSync(legacy, 'utf8')).toContain('$x^2 + y^2 = z^2$');
      await sync.syncDoc(legacyId);
      expect(replacer).toHaveBeenCalledTimes(1);
    } finally { delete google.replaceWithDocx; replacer.mockClear(); }
  });

  it('does not create a link or a Drive file when local DOCX export fails', async () => {
    fs.writeFileSync(path.join(ROOT, 'projects/u/p/failure.md'), 'Broken export.');
    exporter.mockRejectedValueOnce(new Error('Pandoc failed'));
    const calls = importer.mock.calls.length;
    await expect(sync.linkNewGoogleDoc('u/p/failure.md', owner.id, 'Broken')).rejects.toThrow('Pandoc failed');
    expect(importer.mock.calls).toHaveLength(calls);
    expect(sync.linkOf('u/p/failure.md')).toBeNull();
  });
});
