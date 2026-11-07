/**
 * Asking the person for what only they can give: their recovery code on a new device, or their
 * consent to set up encryption (and to keep the code it shows). app/E2eKeys.tsx renders the request;
 * the e2e modules wait for its answer. One request at a time — several documents opening at once
 * share it.
 */
import { accountState, setUpAccount, unlockAccount } from './keys';

export type KeyRequest =
  | { kind: 'setup'; replace?: boolean; resolve: (ok: boolean) => void }
  | { kind: 'unlock'; resolve: (ok: boolean) => void };

let pending: KeyRequest | null = null;
const listeners = new Set<() => void>();
export function keyRequest(): KeyRequest | null { return pending; }
export function onKeyRequest(fn: () => void): () => void { listeners.add(fn); return () => listeners.delete(fn); }
function set(r: KeyRequest | null): void { pending = r; for (const l of [...listeners]) l(); }

/** Once no key dialog is open (a notice must not cover the recovery code before it was kept). */
export function whenNoKeyRequest(): Promise<void> {
  if (!pending) return Promise.resolve();
  return new Promise(resolve => { const off = onKeyRequest(() => { if (!pending) { off(); resolve(); } }); });
}

let inFlight: Promise<boolean> | null = null;
function ask(kind: 'setup' | 'unlock', replace = false): Promise<boolean> {
  return inFlight ??= new Promise<boolean>(resolve => {
    set(kind === 'setup' ? { kind, replace, resolve: ok => { set(null); resolve(ok); } } : { kind, resolve: ok => { set(null); resolve(ok); } });
  }).finally(() => { inFlight = null; });
}

/** This browser can open encrypted projects (asks for setup or the recovery code when needed); false when the person declined. */
export async function ensureAccountKeys(userId: number): Promise<boolean> {
  const st = await accountState(userId);
  if (st === 'ready') return true;
  return ask(st);
}

/** a fresh key pair after a lost recovery code (the encrypted projects need their keys given again) */
export function askReset(): Promise<boolean> { return ask('setup', true); }

export { setUpAccount, unlockAccount };
