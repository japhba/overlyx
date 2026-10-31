/**
 * The dialogs of end-to-end encryption's keys (e2e/ui.ts asks for them): setting encryption up — the
 * account's key pair is made here and its recovery code shown once, to be kept — and unlocking it on
 * another device with that code. Mount once per shell, beside DialogHost.
 */
import { useEffect, useState } from 'preact/hooks';
import { Dialog } from './Dialogs';
import { keyRequest, onKeyRequest, setUpAccount, unlockAccount, askReset, type KeyRequest } from '../e2e/ui';
import { e2eUser } from '../e2e/project';

export function E2eKeyHost() {
  const [, bump] = useState(0);
  useEffect(() => onKeyRequest(() => bump(n => n + 1)), []);
  const r = keyRequest();
  if (!r) return null;
  return r.kind === 'setup' ? <SetupDialog key="setup" req={r} /> : <UnlockDialog key="unlock" req={r} />;
}

function SetupDialog({ req }: { req: Extract<KeyRequest, { kind: 'setup' }> }) {
  const [code, setCode] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const start = async () => {
    setBusy(true); setError(null);
    try { setCode(await setUpAccount(e2eUser().id, !!req.replace)); }
    catch (e) { setError((e as Error).message); }
    setBusy(false);
  };
  const copy = () => { if (code) void navigator.clipboard?.writeText(code).catch(() => {}); };
  const download = () => {
    if (!code) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([`OverLyX recovery code for ${e2eUser().name}\n\n${code}\n\nIt unlocks your end-to-end encrypted projects on a new device. Nobody else has it — not even the server.\n`], { type: 'text/plain' }));
    a.download = 'overlyx-recovery-code.txt';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  if (!code) {
    return (
      <Dialog title={req.replace ? 'New encryption keys' : 'Set up end-to-end encryption'} onClose={() => req.resolve(false)} buttons={<>
        <button class="small-btn" onClick={() => req.resolve(false)}>Cancel</button>
        <button class="small-btn primary" disabled={busy} onClick={() => void start()} data-e2e-setup>{busy ? 'Making keys…' : req.replace ? 'Make new keys' : 'Set up'}</button>
      </>}>
        <p>Encrypted projects are locked with keys that only you and the people you share them with hold. The server keeps only ciphertext: it cannot read the documents, the files or their names, and nobody running it can either.</p>
        <p>This browser makes your keys now and shows you a <b>recovery code</b>. Keep it somewhere safe: you need it to open your encrypted projects on another device, and if it is lost, nobody can recover them for you.</p>
        {req.replace && <p class="dialog-hint error">Your old keys stop working: the encrypted projects you are in must give you their keys again (their other members see a request when they open them). Projects only you could open stay locked.</p>}
        {error && <p class="dialog-hint error">{error}</p>}
      </Dialog>
    );
  }
  return (
    <Dialog title="Your recovery code" onClose={() => { if (saved) req.resolve(true); }} buttons={
      <button class="small-btn primary" disabled={!saved} onClick={() => req.resolve(true)} data-e2e-saved>Continue</button>
    }>
      <p>Write it down or keep it in your password manager. It is shown only now.</p>
      <p class="e2e-code" data-e2e-code><code>{code}</code></p>
      <p><button class="small-btn" onClick={copy}>Copy</button> <button class="small-btn" onClick={download}>Download as a text file</button></p>
      <label class="feedback-opt"><input type="checkbox" checked={saved} onChange={e => setSaved((e.target as HTMLInputElement).checked)} data-e2e-confirm /> I have kept my recovery code</label>
    </Dialog>
  );
}

function UnlockDialog({ req }: { req: Extract<KeyRequest, { kind: 'unlock' }> }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const unlock = async () => {
    setBusy(true); setError(null);
    try { await unlockAccount(e2eUser().id, code); req.resolve(true); }
    catch (e) { setError((e as Error).message); setBusy(false); }
  };
  const lost = async () => {
    req.resolve(false);
    await askReset();
  };
  return (
    <Dialog title="Unlock encrypted projects" onClose={() => req.resolve(false)} buttons={<>
      <button class="small-btn" onClick={() => req.resolve(false)}>Not now</button>
      <button class="small-btn primary" disabled={busy || !code.trim()} onClick={() => void unlock()} data-e2e-unlock>Unlock</button>
    </>}>
      <p>This project is end-to-end encrypted. To open it in this browser, enter the recovery code you were shown when you set up encryption.</p>
      <label class="dialog-row">Recovery code <input type="text" value={code} autofocus spellcheck={false} autocomplete="off" placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XX" data-e2e-code-input
        onInput={e => setCode((e.target as HTMLInputElement).value)} onKeyDown={e => { if (e.key === 'Enter' && code.trim()) void unlock(); }} /></label>
      {error && <p class="dialog-hint error">{error}</p>}
      <p class="dialog-hint"><a href="#" onClick={e => { e.preventDefault(); void lost(); }}>I lost my recovery code</a></p>
    </Dialog>
  );
}
