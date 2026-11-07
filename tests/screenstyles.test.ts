/**
 * Text styles in scopes (core textstyles.ts), as VS Code's settings: the defaults, one person's own
 * (User), a project's (Project), the document's (what the PDF has) — the more specific winning key by
 * key. User and Project are trees: heading levels take what they do not set from All headings, and
 * every style takes the font and colour from Normal text where nothing else sets them.
 */
import { describe, it, expect } from 'vitest';
import { resolveScreenStyles, cascadeStyles, scopedStyleValue, screenStylesOf, type ScreenStyles, type TextStyles } from '../packages/core/src/textstyles.ts';
import { projectSettingsOf, projectSettingsJson } from '../packages/core/src/projectsettings.ts';

describe('editor styles in scopes', () => {
  const user: ScreenStyles = { headings: { font: 'Anodyne|wdth=80', weight: 650, color: '#1f4e79' }, subsection: { weight: 500 }, body: { color: '#222222' } };
  const project: ScreenStyles = { headings: { color: '#0b7a75' }, title: { size: 'larger' } };
  const pdf: TextStyles = { section: { size: 'huge' }, subsection: { font: 'Fira Sans' }, quote: { shape: 'italic' } };

  it('heading levels take All headings where they set nothing; their own values win', () => {
    const r = resolveScreenStyles(user);
    expect(r.section).toEqual({ font: 'Anodyne|wdth=80', weight: 650, color: '#1f4e79' });
    expect(r.subsection).toEqual({ font: 'Anodyne|wdth=80', weight: 500, color: '#1f4e79' });
    expect(r.title).toBeUndefined();
    expect(r.body).toEqual({ color: '#222222' });
    expect('headings' in r).toBe(false);
  });

  it('the editor draws the more specific scope key by key: the document over the project over the person', () => {
    const e = cascadeStyles({ user, project, document: pdf });
    // the project's All headings colour over the person's; the document's font and size over both
    expect(e.subsection).toEqual({ font: 'Fira Sans', weight: 500, color: '#0b7a75' });
    expect(e.section).toEqual({ font: 'Anodyne|wdth=80', weight: 650, color: '#0b7a75', size: 'huge' });
    expect(e.title).toEqual({ size: 'larger' });
    expect(e.quote).toEqual({ shape: 'italic' });
    // without a project or a document: the person's own
    expect(cascadeStyles({ user }).section).toEqual(resolveScreenStyles(user).section);
  });

  it('says where a value shown in a scope comes from, and which scopes above set it too', () => {
    const s = { user, project, document: pdf };
    expect(scopedStyleValue(s, 'user', 'subsection', 'weight')).toEqual({ value: 500, origin: { scope: 'user' }, over: [] });
    expect(scopedStyleValue(s, 'user', 'section', 'weight')).toEqual({ value: 650, origin: { scope: 'user', via: 'headings' }, over: [] });
    // the person's colour, set again by the project's All headings
    expect(scopedStyleValue(s, 'user', 'section', 'color')).toEqual({ value: '#1f4e79', origin: { scope: 'user', via: 'headings' }, over: ['project'] });
    // the person's font for Subsection, set again by the document
    expect(scopedStyleValue(s, 'user', 'subsection', 'font')).toEqual({ value: 'Anodyne|wdth=80', origin: { scope: 'user', via: 'headings' }, over: ['document'] });
    // the project's tab shows what it inherits from User
    expect(scopedStyleValue(s, 'project', 'subsection', 'weight')).toEqual({ value: 500, origin: { scope: 'user' }, over: [] });
    expect(scopedStyleValue(s, 'project', 'section', 'size')).toEqual({ value: undefined, origin: { scope: 'default' }, over: ['document'] });
    // the font and colour from Normal text, nothing else
    expect(scopedStyleValue(s, 'user', 'title', 'color')).toEqual({ value: '#222222', origin: { scope: 'user', via: 'body' }, over: [] });
    expect(scopedStyleValue(s, 'user', 'title', 'weight')).toEqual({ value: undefined, origin: { scope: 'default' }, over: [] });
    expect(scopedStyleValue(s, 'document', 'quote', 'shape')).toEqual({ value: 'italic', origin: { scope: 'document' }, over: [] });
    expect(scopedStyleValue({ document: pdf }, 'document', 'headings', 'size')).toEqual({ value: 'huge', origin: { scope: 'document' }, over: [] });
  });

  it('reads styles from JSON, only what is valid', () => {
    expect(screenStylesOf({ headings: { color: '#ABCDEF', weight: 'bold' }, section: { size: '99pt', font: 'Inter' }, nonsense: { color: '#000000' }, body: 'x' }))
      .toEqual({ headings: { color: '#abcdef', weight: 700 }, section: { font: 'Inter' } });
    expect(screenStylesOf(null)).toEqual({});
  });
});

describe('project settings (.overlyx/settings.json)', () => {
  it('keeps only what a project may set, valid', () => {
    expect(projectSettingsOf({
      spellcheck: false, autoCorrect: 'yes', autoBuild: 'always', autoBuildDelay: 3, paragraphSkip: true,
      editorFont: 'gf:Inter|wdth=90', editorMathFont: 'match', theme: 'dark', textStyles: { section: { color: '#123456' } },
    })).toEqual({ spellcheck: false, autoBuild: 'always', autoBuildDelay: 3, paragraphSkip: true, editorFont: 'gf:Inter|wdth=90', editorMathFont: 'match', textStyles: { section: { color: '#123456' } } });
    expect(projectSettingsOf({ autoBuild: 'sometimes', autoBuildDelay: -1, editorFont: '<script>' })).toEqual({});
    expect(projectSettingsOf([1, 2])).toEqual({});
  });

  it('writes a stable file, nothing when nothing is set', () => {
    expect(projectSettingsJson({ textStyles: { title: { size: 'huge' } }, spellcheck: false })).toBe('{\n  "spellcheck": false,\n  "textStyles": {\n    "title": {\n      "size": "huge"\n    }\n  }\n}\n');
    expect(projectSettingsJson({})).toBe('');
    expect(projectSettingsJson({ textStyles: {} })).toBe('');
  });
});
