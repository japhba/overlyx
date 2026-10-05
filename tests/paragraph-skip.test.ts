/**
 * "No paragraph indentation" (Settings ▸ Account ▸ New documents, userSettings paragraphSkip): a
 * document the account creates gets Document ▸ Settings ▸ Paragraph separation = vertical space,
 * written into the file the way the settings dialog writes it (texdoc.ts withDocumentSettings) —
 * and the editor draws such a document's paragraphs flush left (editor/paragraphsep.ts).
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(process.env.OVERLYX_SCRATCH ?? tmpdir(), 'overlyx-parskip-test');
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(join(ROOT, 'projects', 'ann', 'p'), { recursive: true });
process.env.OVERLYX_DATA_DIR = join(ROOT, 'data');
process.env.OVERLYX_PROJECTS_DIR = join(ROOT, 'projects');

const { config } = await import('../packages/server/src/config.ts');
const { createUser } = await import('../packages/server/src/auth.ts');
const { userSettings, setUserSettings } = await import('../packages/server/src/userSettings.ts');
const { newDocumentText } = await import('../packages/server/src/projects.ts');
const { withDocumentSettings, NO_INDENT_SETTINGS, parseDocumentText, writeDocumentText } = await import('../packages/server/src/texdoc.ts');
const { paragraphSkip } = await import('../packages/client/src/editor/paragraphsep.ts');

afterAll(() => { rmSync(ROOT, { recursive: true, force: true }); });

describe('no paragraph indentation for new documents', () => {
  it('runs against the scratch data dir', () => {
    expect(config.dataDir.startsWith(ROOT)).toBe(true);
  });

  it('is an account setting, off by default, switched by the user', () => {
    const ann = createUser('ann', 'Ann', 'pw-ann-12345');
    expect(userSettings(ann.id).paragraphSkip).toBe(false);
    expect(setUserSettings(ann.id, { paragraphSkip: true })).toMatchObject({ paragraphSkip: true, fineGrainedAccess: false });
    expect(userSettings(ann.id).paragraphSkip).toBe(true);
    setUserSettings(ann.id, { fineGrainedAccess: true });
    expect(userSettings(ann.id)).toMatchObject({ paragraphSkip: true, fineGrainedAccess: true });
  });

  it('a new document gets vertical space between paragraphs, the template otherwise as it was', () => {
    const plain = newDocumentText({ title: 'Notes', author: 'Ann' });
    const text = withDocumentSettings(plain, 'ann/p', 'notes.tex', NO_INDENT_SETTINGS);
    expect(text).toContain('\\AtBeginDocument{\\setlength{\\parskip}{\\medskipamount}\\setlength{\\parindent}{0pt}}');
    expect(text).toMatch(/%% overlyx-settings: \{[^\n]*"paragraph_separation":"skip"/);
    for (const line of plain.split('\n').filter(l => l.trim())) expect(text).toContain(line);
    const parsed = parseDocumentText(text, 'ann/p', 'notes.tex');
    expect(parsed.warnings).toEqual([]);
    expect(parsed.doc.header.lines).toContain('\\paragraph_separation skip');
    expect(paragraphSkip(parsed.doc.header.lines)).toBe('medskip');
    // the editor's next save writes the same file
    expect(writeDocumentText(parsed.doc, 'ann/p', 'notes.tex', false, undefined, { base: text }).text).toBe(text);
  });
});

describe('paragraphSkip (what the editor draws)', () => {
  it('reads the document settings', () => {
    expect(paragraphSkip(['\\paragraph_separation indent', '\\defskip medskip'])).toBeNull();
    expect(paragraphSkip([])).toBeNull();
    expect(paragraphSkip(['\\paragraph_separation skip', '\\defskip bigskip'])).toBe('bigskip');
    expect(paragraphSkip(['\\paragraph_separation skip'])).toBe('medskip');
    expect(paragraphSkip(['\\paragraph_separation skip', '\\defskip 0.3cm'])).toBe('medskip');
  });
});
