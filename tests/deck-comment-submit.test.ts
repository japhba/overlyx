// @vitest-environment jsdom
/** Actual comment component: an input event followed by submit must not wait for a render. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { h, render } from 'preact';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import ts from 'typescript';

const source = readFileSync(resolve('packages/client/src/deliverable/ReviewPane.tsx'), 'utf8');
const ast = ts.createSourceFile('ReviewPane.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let declaration: ts.FunctionDeclaration | undefined;
ts.forEachChild(ast, node => {
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'DraftCard') declaration = node;
});
if (!declaration) throw new Error('actual DraftCard component is missing');
const js = ts.transpileModule(declaration.getText(ast), { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None, jsx: ts.JsxEmit.React, jsxFactory: 'h',
} }).outputText;
// Only the avatar's visual markup is stubbed; all component hooks and event handlers are real.
const DraftCard = new Function('h', 'useState', 'useRef', 'useLayoutEffect', 'Avatar', `${js}\nreturn DraftCard;`)(
  h, useState, useRef, useLayoutEffect, () => h('span', {}),
);

let root: HTMLDivElement, textarea: HTMLTextAreaElement, sent: string[], cancelled: number;
beforeEach(() => {
  root = document.createElement('div'); document.body.append(root);
  sent = []; cancelled = 0;
  render(h(DraftCard, { draft: { path: [0, 1, 1], slide: 0, what: 'control', quote: 'word' },
    me: 'Control', submitDraft: (value: string) => sent.push(value), cancelDraft: () => cancelled++ }), root);
  textarea = root.querySelector('textarea')!;
  expect(document.activeElement).toBe(textarea);
});
afterEach(() => { render(null, root); root.remove(); });
const input = (value: string) => {
  textarea.value = value;
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
};
const key = (name: string, ctrl = false, meta = false) => textarea.dispatchEvent(new KeyboardEvent('keydown', {
  key: name, ctrlKey: ctrl, metaKey: meta, bubbles: true, cancelable: true,
}));

describe('slide comment draft submission uses the visible input immediately', () => {
  it('submits the complete text on Ctrl+Enter before a pending state render', () => {
    input('control comment'); key('Enter', true);
    expect(sent).toEqual(['control comment']);
  });
  it('also submits on Meta+Enter without waiting for a state render', () => {
    input('control comment'); key('Enter', false, true);
    expect(sent).toEqual(['control comment']);
  });
  it('trims the latest visible input without losing its contents', () => {
    input('  control comment  '); key('Enter', true);
    expect(sent).toEqual(['control comment']);
  });
  it('does not submit an empty or whitespace-only draft', () => {
    for (const value of ['', '  \n  ']) { input(value); key('Enter', true); }
    expect(sent).toEqual([]);
  });
  it('keeps ordinary Enter distinct from the explicit submit shortcut', () => {
    input('control comment'); key('Enter');
    expect(sent).toEqual([]); expect(cancelled).toBe(0);
  });
  it('preserves Escape cancellation without submitting', () => {
    input('control comment'); key('Escape');
    expect(sent).toEqual([]); expect(cancelled).toBe(1);
  });
  it('preserves normal button submission after a rendered input update', async () => {
    input('control comment'); await new Promise(resolve => setTimeout(resolve, 0));
    root.querySelector<HTMLButtonElement>('[data-rv-submit]')!.click();
    expect(sent).toEqual(['control comment']);
  });
});
