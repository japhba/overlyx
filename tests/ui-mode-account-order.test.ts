// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { useEffect, useState } from 'preact/hooks';
import * as ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';

const modeText = readFileSync(resolve('packages/client/src/app/uimode.ts'), 'utf8');
const appText = readFileSync(resolve('packages/client/src/app/App.tsx'), 'utf8');
const modeAst = ts.createSourceFile('uimode.ts', modeText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const appAst = ts.createSourceFile('App.tsx', appText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const modeModule = ts.createPrinter().printFile(ts.factory.updateSourceFile(modeAst,
  modeAst.statements.filter(statement => !ts.isImportDeclaration(statement))));
const effects: ts.CallExpression[] = [];
const find = (node: ts.Node) => {
  if (ts.isCallExpression(node) && node.expression.getText(appAst) === 'useEffect'
    && node.arguments[0]?.getText(appAst).includes('adoptAccountUi')) effects.push(node);
  ts.forEachChild(node, find);
};
find(appAst);
if (effects.length !== 1) throw new Error('Expected the one account-interface effect in App');
const effect = effects[0].getText(appAst);
const compile = (text: string) => ts.transpileModule(text, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const mounts: HTMLDivElement[] = [];

afterEach(async () => {
  await act(() => { for (const mount of mounts.splice(0)) render(null, mount); });
  document.body.replaceChildren();
  localStorage.clear();
  delete document.documentElement.dataset.ui;
  vi.restoreAllMocks();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

function fixture(initial?: 'classic' | 'modern') {
  localStorage.clear();
  if (initial) localStorage.setItem('ol.ui', initial);
  const requests: ReturnType<typeof deferred<{ settings: { interface: 'classic' | 'modern' } }>>[] = [];
  const settings = vi.fn(() => {
    const request = deferred<{ settings: { interface: 'classic' | 'modern' } }>();
    requests.push(request);
    return request.promise;
  });
  const setSettings = vi.fn(async (_settings: { interface: string }) => ({}));
  const context = createContext({ exports: {} as Record<string, any>, document, localStorage, useEffect, useState,
    api: { settings, setSettings } });
  runInContext(compile(modeModule), context);
  const mode = context.exports as {
    uiMode(): 'classic' | 'modern';
    setUiMode(value: 'classic' | 'modern'): void;
  };
  Object.assign(context, mode);
  runInContext(compile(`function PreferenceProbe({ user }) { ${effect}; return null; }
    exports.PreferenceProbe = PreferenceProbe;`), context);
  const Probe = context.exports.PreferenceProbe;
  const mount = document.createElement('div');
  document.body.append(mount);
  mounts.push(mount);
  return {
    mode, requests, settings, setSettings,
    mount: async (username = 'member-a', guest = false) => {
      await act(() => { render(h(Probe, { user: { username, guest } }), mount); });
    },
    unmount: async () => { await act(() => { render(null, mount); }); },
    reply: async (index: number, value: 'classic' | 'modern') => {
      await act(async () => { requests[index].resolve({ settings: { interface: value } }); await Promise.resolve(); });
    },
    reject: async (index: number) => {
      await act(async () => { requests[index].reject(new Error('offline')); await Promise.resolve(); });
    },
  };
}

function expectMode(state: ReturnType<typeof fixture>, value: 'classic' | 'modern') {
  expect(state.mode.uiMode()).toBe(value);
  expect(document.documentElement.dataset.ui).toBe(value);
  expect(localStorage.getItem('ol.ui')).toBe(value);
}

describe('account interface preferences respect newer local choices and request ownership', () => {
  it('keeps a local choice when an older settings response arrives', async () => {
    const state = fixture();
    await state.mount();
    expect(state.settings).toHaveBeenCalledOnce();
    state.mode.setUiMode('classic');
    await state.reply(0, 'modern');
    expectMode(state, 'classic');
    expect(state.setSettings).toHaveBeenCalledExactlyOnceWith({ interface: 'classic' });
  });

  it('treats explicitly choosing the already-current mode as a newer preference', async () => {
    const state = fixture('classic');
    await state.mount();
    state.mode.setUiMode('classic');
    await state.reply(0, 'modern');
    expectMode(state, 'classic');
    expect(state.setSettings).toHaveBeenCalledExactlyOnceWith({ interface: 'classic' });
  });

  it('adopts an account preference normally without posting it back', async () => {
    const state = fixture();
    expect(state.mode.uiMode()).toBe('modern');
    expect(document.documentElement.dataset.ui).toBe('modern');
    await state.mount();
    await state.reply(0, 'classic');
    expectMode(state, 'classic');
    expect(state.setSettings).not.toHaveBeenCalled();
  });

  it('ignores the previous account response after a new account has mounted', async () => {
    const state = fixture();
    await state.mount('member-a');
    await state.mount('member-b');
    expect(state.settings).toHaveBeenCalledTimes(2);
    await state.reply(1, 'classic');
    await state.reply(0, 'modern');
    expectMode(state, 'classic');
    expect(state.setSettings).not.toHaveBeenCalled();
  });

  it('does not apply a response after the preference effect is unmounted', async () => {
    const state = fixture('modern');
    await state.mount();
    await state.unmount();
    await state.reply(0, 'classic');
    expectMode(state, 'modern');
    expect(state.setSettings).not.toHaveBeenCalled();
  });

  it('requests account preferences when a guest becomes a member with the same username', async () => {
    const state = fixture();
    await state.mount('member-a', true);
    expect(state.settings).not.toHaveBeenCalled();
    await state.mount('member-a', false);
    expect(state.settings).toHaveBeenCalledOnce();
    await state.reply(0, 'classic');
    expectMode(state, 'classic');
  });

  it('retains the current interface if fetching account settings fails', async () => {
    const state = fixture('classic');
    await state.mount();
    await state.reject(0);
    expectMode(state, 'classic');
    expect(state.setSettings).not.toHaveBeenCalled();
  });
});
