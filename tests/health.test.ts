/**
 * Structural health checks catch a .tex file broken by an external edit: managed-block markers
 * out of sync, a corrupted settings line, wrong \begin/\end{document} counts, unbalanced braces —
 * and repairTex mends the mechanical (marker) cases without touching content.
 */
import { describe, it, expect } from 'vitest';
import { checkTexHealth, repairTex } from '../packages/core/src/tex/health.ts';
import { splitDocument } from '../packages/core/src/tex/preamble.ts';

const SETTINGS = '{"textclass":"article"}';
function good(): string {
  return `\\documentclass{article}\n%% OverLyX ------------------------------------------------------------------\n%% overlyx-settings: ${SETTINGS}\n%% end OverLyX --------------------------------------------------------------\n\\begin{document}\nHello.\n\\end{document}\n`;
}

describe('checkTexHealth: a well-formed document', () => {
  it('has no issues', () => {
    expect(checkTexHealth(good())).toEqual([]);
  });
});

describe('checkTexHealth: managed block markers', () => {
  it('flags a missing end marker as fixable', () => {
    const t = good().replace(/%% end OverLyX.*\n/, '');
    const issues = checkTexHealth(t);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ code: 'managed-block-missing-end', fixable: true });
  });

  it('flags a missing begin marker as fixable', () => {
    const t = good().replace(/%% OverLyX -+\n/, '');
    const issues = checkTexHealth(t);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ code: 'managed-block-missing-begin', fixable: true });
  });

  it('flags a duplicated begin marker as not fixable', () => {
    const t = good().replace('\\documentclass{article}\n', '\\documentclass{article}\n%% OverLyX ------------------------------------------------------------------\n');
    const issues = checkTexHealth(t);
    expect(issues.some(i => i.code === 'managed-block-duplicated-begin' && !i.fixable)).toBe(true);
    // with two begins, "missing end" repair must not fire (ambiguous which begin it belongs to)
    expect(issues.find(i => i.code === 'managed-block-missing-end')).toBeUndefined();
  });

  it('flags reversed markers (end before begin)', () => {
    const swapped = `\\documentclass{article}\n%% end OverLyX --------------------------------------------------------------\n%% overlyx-settings: ${SETTINGS}\n%% OverLyX ------------------------------------------------------------------\n\\begin{document}\nHello.\n\\end{document}\n`;
    const issues = checkTexHealth(swapped);
    expect(issues.some(i => i.code === 'managed-block-reversed')).toBe(true);
  });
});

describe('checkTexHealth: settings line', () => {
  it('flags a missing settings line', () => {
    const t = good().replace(/%% overlyx-settings:.*\n/, '');
    const issues = checkTexHealth(t);
    expect(issues.some(i => i.code === 'settings-missing' && !i.fixable)).toBe(true);
  });

  it('flags invalid JSON on the settings line', () => {
    const t = good().replace(SETTINGS, '{not json');
    const issues = checkTexHealth(t);
    expect(issues.some(i => i.code === 'settings-invalid' && !i.fixable)).toBe(true);
  });
});

describe('checkTexHealth: document boundary', () => {
  it('flags a missing \\end{document}', () => {
    const t = good().replace('\\end{document}\n', '');
    expect(checkTexHealth(t).some(i => i.code === 'document-boundary')).toBe(true);
  });

  it('flags a duplicated \\begin{document}', () => {
    const t = good().replace('\\begin{document}', '\\begin{document}\n\\begin{document}');
    expect(checkTexHealth(t).some(i => i.code === 'document-boundary')).toBe(true);
  });

  it('is skipped for fragments (child documents have no \\begin{document})', () => {
    const frag = `%% overlyx-settings: ${SETTINGS}\nJust a paragraph.\n`;
    expect(checkTexHealth(frag, { isFragment: true }).some(i => i.code === 'document-boundary')).toBe(false);
  });
});

describe('checkTexHealth: brace balance', () => {
  it('flags an unclosed group', () => {
    const t = good().replace('Hello.', 'Hello \\textbf{world.');
    expect(checkTexHealth(t).some(i => i.code === 'brace-imbalance')).toBe(true);
  });

  it('does not count escaped braces or comments', () => {
    const t = good().replace('Hello.', 'Hello \\{ \\} % a stray { brace in a comment\nreal text.');
    expect(checkTexHealth(t).some(i => i.code === 'brace-imbalance')).toBe(false);
  });
});

describe('repairTex', () => {
  it('inserts the missing end marker right before \\begin{document}', () => {
    const broken = good().replace(/%% end OverLyX.*\n/, '');
    const issues = checkTexHealth(broken);
    const { text, fixed } = repairTex(broken, issues);
    expect(fixed).toEqual(['managed-block-missing-end']);
    expect(checkTexHealth(text)).toEqual([]);
    // the settings the document already had survive the repair (readSettings recovers them)
    expect(splitDocument(text).settings).toEqual({ textclass: 'article' });
  });

  it('inserts the missing begin marker right before the settings line', () => {
    const broken = good().replace(/%% OverLyX -+\n/, '');
    const issues = checkTexHealth(broken);
    const { text, fixed } = repairTex(broken, issues);
    expect(fixed).toEqual(['managed-block-missing-begin']);
    expect(checkTexHealth(text)).toEqual([]);
    expect(splitDocument(text).settings).toEqual({ textclass: 'article' });
  });

  it('is a no-op on a healthy document', () => {
    const t = good();
    const { text, fixed } = repairTex(t, checkTexHealth(t));
    expect(fixed).toEqual([]);
    expect(text).toBe(t);
  });

  it('leaves non-fixable issues untouched (settings corruption is not guessed at)', () => {
    const broken = good().replace(SETTINGS, '{not json');
    const issues = checkTexHealth(broken);
    const { text, fixed } = repairTex(broken, issues);
    expect(fixed).toEqual([]);
    expect(text).toBe(broken);
  });
});
