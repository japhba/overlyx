/**
 * Exercise the actual renderer lifecycle without importing config, the database, or Chromium.
 * Only browser launches and the clock are faked; the selected source declarations execute as-is.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../packages/server/src/render.ts', import.meta.url), 'utf8');
const parsed = ts.createSourceFile('render.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const selectedNames = new Set(['IDLE_MS', 'browser', 'idleTimer', 'running', 'queue', 'acquire', 'getBrowser', 'release', 'shutdownRenderer']);
const foundNames = new Set<string>();
const declarations: string[] = [];
for (const statement of parsed.statements) {
  const names = ts.isFunctionDeclaration(statement) && statement.name ? [statement.name.text]
    : ts.isVariableStatement(statement) ? statement.declarationList.declarations.flatMap(declaration =>
      ts.isIdentifier(declaration.name) ? [declaration.name.text] : []) : [];
  if (!names.some(name => selectedNames.has(name))) continue;
  if (names.some(name => !selectedNames.has(name))) throw new Error('Renderer lifecycle declaration must be isolated');
  names.forEach(name => foundNames.add(name));
  declarations.push(statement.getText(parsed).replace(/^export\s+/, ''));
}
if (foundNames.size !== selectedNames.size) throw new Error('Renderer lifecycle declarations are missing');
const lifecycle = ts.transpileModule(declarations.join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function fakeBrowser(delayClose = false) {
  const disconnected = new Set<() => void>();
  const closed = deferred<void>();
  const disconnect = () => disconnected.forEach(callback => callback());
  return {
    on: vi.fn((event: string, callback: () => void) => { if (event === 'disconnected') disconnected.add(callback); }),
    close: vi.fn(async () => { if (delayClose) await closed.promise; disconnect(); }),
    finishClose: () => closed.resolve(undefined),
    disconnect,
  };
}
type FakeBrowser = ReturnType<typeof fakeBrowser>;

function pool() {
  const launches: ReturnType<typeof deferred<FakeBrowser>>[] = [];
  const launch = vi.fn(() => { const pending = deferred<FakeBrowser>(); launches.push(pending); return pending.promise; });
  let timerId = 0;
  const timers = new Map<number, { callback: () => void; delay: number }>();
  const api = runInNewContext(`${lifecycle}\n({ getBrowser, acquire, release, shutdownRenderer })`, {
    chromium: { launch },
    sandboxedChrome: () => '/sandboxed/chromium',
    setTimeout: (callback: () => void, delay: number) => {
      const id = ++timerId; timers.set(id, { callback, delay }); return id;
    },
    clearTimeout: (id: number) => timers.delete(id),
  }, { timeout: 1000 }) as {
    getBrowser(): Promise<FakeBrowser>;
    acquire(): Promise<void>;
    release(): void;
    shutdownRenderer(): Promise<void>;
  };
  return {
    ...api, launches, launch, timers,
    expireIdle() {
      expect(timers.size).toBe(1);
      const [id, timer] = [...timers.entries()][0];
      expect(timer.delay).toBe(3 * 60 * 1000);
      timers.delete(id);
      timer.callback();
    },
  };
}
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

describe('renderer browser-pool ownership', () => {
  it('shares a pending launch and reuses the resolved browser', async () => {
    const p = pool();
    const first = p.getBrowser();
    const concurrent = p.getBrowser();
    const b = fakeBrowser();
    p.launches[0].resolve(b);
    expect(await first).toBe(b);
    expect(await concurrent).toBe(b);
    expect(await p.getBrowser()).toBe(b);
    expect(p.launch).toHaveBeenCalledTimes(1);
    expect(p.launch).toHaveBeenCalledWith(expect.objectContaining({ executablePath: '/sandboxed/chromium', timeout: 30000 }));
  });

  it('cancels idle closure on reuse, then closes the browser after the next idle period', async () => {
    const p = pool();
    await p.acquire();
    const first = p.getBrowser();
    const b = fakeBrowser();
    p.launches[0].resolve(b);
    await first;
    p.release();
    expect(p.timers.size).toBe(1);
    await p.acquire();
    expect(await p.getBrowser()).toBe(b);
    expect(p.timers.size).toBe(0);
    expect(b.close).not.toHaveBeenCalled();
    p.release();
    p.expireIdle();
    await flush();
    expect(b.close).toHaveBeenCalledTimes(1);
    const next = p.getBrowser();
    const replacement = fakeBrowser();
    p.launches[1].resolve(replacement);
    expect(await next).toBe(replacement);
    expect(p.launch).toHaveBeenCalledTimes(2);
  });

  it('replaces the currently disconnected browser', async () => {
    const p = pool();
    const first = p.getBrowser();
    const b = fakeBrowser();
    p.launches[0].resolve(b);
    await first;
    b.disconnect();
    const next = p.getBrowser();
    const replacement = fakeBrowser();
    p.launches[1].resolve(replacement);
    expect(await next).toBe(replacement);
    expect(await p.getBrowser()).toBe(replacement);
    expect(p.launch).toHaveBeenCalledTimes(2);
  });

  it('keeps a replacement when an idle browser disconnects late', async () => {
    const p = pool();
    await p.acquire();
    const first = p.getBrowser();
    const old = fakeBrowser(true);
    p.launches[0].resolve(old);
    await first;
    p.release();
    p.expireIdle();
    await flush();
    expect(old.close).toHaveBeenCalledTimes(1);
    const next = p.getBrowser();
    const replacement = fakeBrowser();
    p.launches[1].resolve(replacement);
    await next;
    old.finishClose();
    await flush();
    const reused = p.getBrowser();
    expect(p.launch).toHaveBeenCalledTimes(2);
    expect(await reused).toBe(replacement);
    expect(replacement.close).not.toHaveBeenCalled();
  });

  it('keeps a replacement when a shutdown browser disconnects late', async () => {
    const p = pool();
    const first = p.getBrowser();
    const old = fakeBrowser(true);
    p.launches[0].resolve(old);
    await first;
    const shutdown = p.shutdownRenderer();
    const next = p.getBrowser();
    const replacement = fakeBrowser();
    p.launches[1].resolve(replacement);
    await next;
    old.finishClose();
    await shutdown;
    expect(old.close).toHaveBeenCalledTimes(1);
    const reused = p.getBrowser();
    expect(p.launch).toHaveBeenCalledTimes(2);
    expect(await reused).toBe(replacement);
  });

  it('keeps a replacement when a launch retired by shutdown rejects late', async () => {
    const p = pool();
    const first = p.getBrowser();
    const rejected = expect(first).rejects.toThrow('launch failed');
    const shutdown = p.shutdownRenderer();
    const next = p.getBrowser();
    const replacement = fakeBrowser();
    p.launches[1].resolve(replacement);
    await next;
    p.launches[0].reject(new Error('launch failed'));
    await rejected;
    await shutdown;
    const reused = p.getBrowser();
    expect(p.launch).toHaveBeenCalledTimes(2);
    expect(await reused).toBe(replacement);
  });

  it('keeps a pending replacement when a launch retired by shutdown rejects late', async () => {
    const p = pool();
    const first = p.getBrowser();
    const rejected = expect(first).rejects.toThrow('launch failed');
    const shutdown = p.shutdownRenderer();
    const next = p.getBrowser();
    p.launches[0].reject(new Error('launch failed'));
    await rejected;
    await shutdown;
    const concurrent = p.getBrowser();
    expect(p.launch).toHaveBeenCalledTimes(2);
    const replacement = fakeBrowser();
    p.launches[1].resolve(replacement);
    expect(await next).toBe(replacement);
    expect(await concurrent).toBe(replacement);
  });

  it('allows a retry when the current launch rejects', async () => {
    const p = pool();
    const first = p.getBrowser();
    const rejected = expect(first).rejects.toThrow('launch failed');
    p.launches[0].reject(new Error('launch failed'));
    await rejected;
    const next = p.getBrowser();
    const replacement = fakeBrowser();
    p.launches[1].resolve(replacement);
    expect(await next).toBe(replacement);
    expect(p.launch).toHaveBeenCalledTimes(2);
  });

  it('keeps the two-render limit and starts idle closure only after the queue drains', async () => {
    const p = pool();
    await p.acquire();
    await p.acquire();
    let admitted = false;
    const queued = p.acquire().then(() => { admitted = true; });
    await flush();
    expect(admitted).toBe(false);
    p.release();
    await queued;
    expect(admitted).toBe(true);
    expect(p.timers.size).toBe(0);
    p.release();
    expect(p.timers.size).toBe(0);
    p.release();
    expect(p.timers.size).toBe(1);
  });
});
