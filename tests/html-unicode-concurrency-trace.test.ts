import { describe, expect, it } from 'vitest';
import { parseSource } from '../packages/core/src/html/source.ts';
import { applyTo, rebasedSplices } from '../packages/client/src/deliverable/sourceops.ts';

// The Firefox trace records these textContent snapshots, but not the runtime's outgoing
// HtmlOp payloads. Keep the fixture exact and keep append-vs-caret-replacement as separate
// cases; this test cannot identify which local HtmlOp the browser actually emitted.
const paragraph = (text: string) => `<!doctype html><html><head><title>Concurrent editing</title></head><body>
<section class="slide"><p class="sub">${text}</p><p>Other box</p></section></body></html>`;
const baseText = 'Shared baseline. B0Ω A0😀 B1Ω A1😀';
const base = paragraph(baseText);
const current = paragraph(`${baseText} B2Ω`); // the coauthor's independently saved round-2 append
const path = [1, 0, 0];
const proposed = (html: string) => ({ t: 'inner' as const, path, before: baseText, html });
const applyLocal = (html: string) => {
  const splices = rebasedSplices(base, current, [proposed(html)]);
  return splices === null ? null : applyTo(current, splices);
};
const textOf = (html: string) => {
  const el = parseSource(html).doc.childNodes; // parse to ensure the fixture remains valid HTML
  expect(el).toBeDefined();
  const p = html.match(/<p class="sub">([\s\S]*?)<\/p>/)?.[1] ?? '';
  return p;
};

describe('Firefox Unicode concurrency trace fixture (operation payload not captured)', () => {
  it('preserves B1Ω when the local operation is a genuine end append', () => {
    const output = applyLocal(`${baseText} A2😀`);
    expect(output).not.toBeNull();
    const text = textOf(output!);
    expect(text).toContain('B1Ω');
    expect(text).toContain('A2😀');
    expect(text).toContain('B2Ω');
  });

  it('models the observed displaced Ω when the local input is inserted before it', () => {
    const localHtml = baseText.replace('B1Ω', 'B1 A2😀Ω');
    const output = applyLocal(localHtml);
    expect(output).not.toBeNull();
    expect(textOf(output!)).toBe('Shared baseline. B0Ω A0😀 B1 A2😀Ω A1😀 B2Ω');
  });

  it('keeps explicit deletion semantics when a local edit intentionally replaces B1Ω with B1', () => {
    const localHtml = baseText.replace('B1Ω', 'B1');
    const output = applyLocal(localHtml);
    expect(output).not.toBeNull();
    expect(textOf(output!)).toBe('Shared baseline. B0Ω A0😀 B1 A1😀 B2Ω');
  });
});
