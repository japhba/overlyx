/**
 * The Share dialog's part for an end-to-end encrypted project: who holds its key. Sharing makes
 * someone a member, as for any project, but they can read nothing until a member who holds the key
 * gives it to them (wrapped for their public key, e2e/keys.ts). The server decides who is a member,
 * so the key is given only here, by a person: compare the fingerprint with theirs (Settings shows
 * it) when it matters.
 */
import { useEffect, useState } from 'preact/hooks';
import { waitingMembers, membersWithoutKeys, grantWaiting, myFingerprint, type KeyMember } from '../e2e/keys';
import { e2eUser } from '../e2e/project';

export function E2eShareKeys({ project, busy }: { project: string; busy: boolean }) {
  const [waiting, setWaiting] = useState<(KeyMember & { fingerprint: string })[] | null>(null);
  const [noKeys, setNoKeys] = useState<KeyMember[]>([]);
  const [mine, setMine] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const [giving, setGiving] = useState(false);
  const load = () => {
    void waitingMembers(project).then(setWaiting).catch(e => setErr((e as Error).message));
    void membersWithoutKeys(project).then(setNoKeys).catch(() => {});
  };
  useEffect(() => {
    load();
    void myFingerprint(e2eUser().id).then(setMine).catch(() => {});
    const t = setInterval(() => { if (!document.hidden) load(); }, 5000);
    return () => clearInterval(t);
  }, [project]);
  const give = async (m: KeyMember) => {
    setGiving(true); setErr('');
    try { await grantWaiting(project, e2eUser().id, [m]); load(); }
    catch (e) { setErr((e as Error).message); }
    finally { setGiving(false); }
  };
  return (
    <div class="e2e-share" data-e2e-share>
      <h4>🔒 End-to-end encrypted</h4>
      <div class="hint">Only people who hold the project’s key can read it — the server cannot. A new member gets the key when someone who has it gives it to them here.</div>
      {waiting?.map(m => (
        <div key={m.userId} class="e2e-waiting" data-e2e-waiting={m.username}>
          <span><b>{m.name}</b> ({m.username}) waits for the key · fingerprint <code>{m.fingerprint}</code></span>
          <button class="btn small" disabled={busy || giving} data-e2e-give={m.username} onClick={() => void give(m)}>Give key</button>
        </div>
      ))}
      {waiting && !waiting.length && <div class="hint small">Everyone who is in the project and has set up encryption holds the key.</div>}
      {noKeys.length > 0 && <div class="hint small">{noKeys.map(m => m.name).join(', ')} {noKeys.length === 1 ? 'has' : 'have'} not set up encryption yet: they appear here to receive the key once they open the project.</div>}
      {mine && <div class="hint small">Your fingerprint: <code>{mine}</code> — the others see it beside your name. If a fingerprint differs from the one its person sees in their own Share dialog, do not give them the key.</div>}
      {err && <div class="err">{err}</div>}
    </div>
  );
}
