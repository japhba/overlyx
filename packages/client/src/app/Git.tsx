/**
 * Git dialog: the project's clone URL and how to use it from a local machine, personal access
 * tokens (the password for git over HTTPS — Google accounts have no other), the recent commits
 * and what OverLyX has not committed yet. Every project is a repository; OverLyX commits its own
 * writes automatically and before every clone / pull / push, and a push updates the project.
 */
import { useEffect, useState } from 'preact/hooks';
import { api, type GitInfo, type GitToken, type MirrorStatus, type User } from '../api';
import { Dialog } from './Dialogs';

const fmtDate = (t: number) => new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
export const ago = (t: number) => {
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return fmtDate(t);
};

function CopyField({ value, label }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async (e: Event) => {
    const input = (e.currentTarget as HTMLElement).parentElement?.querySelector('input');
    try { await navigator.clipboard.writeText(value); } catch { input?.select(); document.execCommand('copy'); }
    setCopied(true); setTimeout(() => setCopied(false), 2000);
  };
  return (
    <div class="git-copy">
      {label && <span class="lbl">{label}</span>}
      <input type="text" readonly value={value} onFocus={e => (e.target as HTMLInputElement).select()} />
      <button class="btn" onClick={e => void copy(e)}>{copied ? 'Copied ✓' : 'Copy'}</button>
    </div>
  );
}

export function GitDialog({ project, user, onClose }: { project: string; user: User; onClose: () => void }) {
  const [info, setInfo] = useState<GitInfo | null>(null);
  const [tokens, setTokens] = useState<GitToken[] | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [tokenName, setTokenName] = useState('');
  const [newToken, setNewToken] = useState<{ name: string; token: string } | null>(null);
  const [message, setMessage] = useState('');
  const [mcpTokens, setMcpTokens] = useState<GitToken[] | null>(null);
  const [mcpName, setMcpName] = useState('');
  const [newMcpToken, setNewMcpToken] = useState<{ name: string; token: string } | null>(null);
  const [mcpBusy, setMcpBusy] = useState(false);
  const [mirror, setMirror] = useState<MirrorStatus | null>(null);
  const [mirrorBusy, setMirrorBusy] = useState(false);

  const load = () => Promise.all([
    api.gitInfo(project).then(setInfo),
    api.gitTokens().then(r => setTokens(r.tokens)),
    api.mcpTokens(project).then(r => setMcpTokens(r.tokens)),
    api.mirrorStatus(project).then(setMirror).catch(() => setMirror(null)),
  ]).catch(e => setErr((e as Error).message));
  useEffect(() => { setInfo(null); void load(); }, [project]);
  useEffect(() => {
    const t = setInterval(() => { if (!document.hidden) { api.gitInfo(project).then(setInfo).catch(() => {}); api.mirrorStatus(project).then(setMirror).catch(() => {}); } }, 5000);
    return () => clearInterval(t);
  }, [project]);

  const createToken = async () => {
    if (busy) return;
    setBusy(true); setErr('');
    try {
      const name = tokenName.trim() || defaultTokenName();
      const r = await api.createGitToken(name);
      setTokens(r.tokens); setNewToken({ name, token: r.token }); setTokenName('');
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  };
  const revoke = async (t: GitToken) => {
    if (!confirm(`Revoke the token “${t.name}”? Clones using it will no longer be able to pull or push.`)) return;
    try { setTokens((await api.deleteGitToken(t.id)).tokens); if (newToken && tokens?.find(x => x.id === t.id)?.name === newToken.name) setNewToken(null); }
    catch (e) { setErr((e as Error).message); }
  };
  const createMcpToken = async () => {
    if (mcpBusy) return;
    setMcpBusy(true); setErr('');
    try {
      const name = mcpName.trim() || 'agent';
      const r = await api.createMcpToken(project, name);
      setMcpTokens(r.tokens); setNewMcpToken({ name, token: r.token }); setMcpName('');
    } catch (e) { setErr((e as Error).message); }
    finally { setMcpBusy(false); }
  };
  const revokeMcpToken = async (t: GitToken) => {
    if (!confirm(`Revoke the agent token “${t.name}”? It will no longer be able to connect.`)) return;
    try { setMcpTokens((await api.deleteMcpToken(project, t.id)).tokens); if (newMcpToken?.name === t.name) setNewMcpToken(null); }
    catch (e) { setErr((e as Error).message); }
  };

  const commit = async () => {
    if (busy) return;
    setBusy(true); setErr('');
    try { const r = await api.gitCommit(project, message.trim() || undefined); setInfo(i => ({ ...(i as GitInfo), ...r })); setMessage(''); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  };

  const mirrorUpdate = async (body: { enabled?: boolean; now?: boolean }) => {
    if (mirrorBusy) return;
    setMirrorBusy(true); setErr('');
    try { setMirror(await api.mirrorUpdate(project, body)); }
    catch (e) { setErr((e as Error).message); }
    finally { setMirrorBusy(false); }
  };

  const canPush = info ? info.role !== 'view' : false;
  const isOwner = info?.role === 'owner';
  const secretHint = info?.hasPassword ? 'an access token (below) or your OverLyX password' : 'an access token (create one below — Google accounts have no password)';

  return (
    <Dialog title={`Git repository of “${project}”`} onClose={onClose} wide>
      {err && <div class="err">{err}</div>}
      {!info && !err && <div class="hint">Loading…</div>}
      {info && (
        <div class="git-dialog">
          <h4>Clone to your computer</h4>
          <CopyField value={info.url} />
          <pre class="git-cmds">{`git clone ${info.url.includes(' ') ? `"${info.url}"` : info.url}\n# …edit with desktop LyX, then\ngit pull      # get what was edited in OverLyX\ngit push      # your commits go straight into the project`}</pre>
          <div class="hint">
            Username <b>{info.username}</b>, password: {secretHint}. Git remembers it when a credential helper is set up
            (<code>git config --global credential.helper store</code>, or the macOS keychain / Windows credential manager).
            {!canPush && <> You have <b>view</b> access to this project: you can clone and pull, but not push.</>}
          </div>

          <h4>Access tokens</h4>
          <div class="hint">A token stands for your account in git only. Create one per computer and revoke it when the computer is gone.</div>
          {newToken && (
            <div class="git-newtoken">
              <div><b>Your new token “{newToken.name}”</b> — copy it now, it is not shown again:</div>
              <CopyField value={newToken.token} />
            </div>
          )}
          <div class="git-tokens">
            {(tokens ?? []).map(t => (
              <div class="git-token" key={t.id}>
                <span class="name">🔑 {t.name}</span>
                <span class="meta">created {fmtDate(t.created_at)}{t.last_used_at ? ` · last used ${ago(t.last_used_at)}` : ' · never used'}</span>
                <button class="mini" title="Revoke this token" onClick={() => void revoke(t)}>Revoke</button>
              </div>
            ))}
            {tokens && !tokens.length && <div class="hint">No tokens yet.</div>}
          </div>
          <div class="share-add">
            <input type="text" placeholder={`Token name, e.g. ${defaultTokenName()}`} value={tokenName} onInput={e => setTokenName((e.target as HTMLInputElement).value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void createToken(); } }} />
            <button class="btn" disabled={busy} onClick={() => void createToken()}>New token</button>
          </div>

          <h4>MCP connector — let an AI agent read, comment and propose edits</h4>
          <div class="hint">
            Any MCP-compatible client (Claude, Claude Code, …) can connect to this project with a token below:
            read documents and comments, add/resolve comments, and propose paragraph edits — edits are always
            applied as a <b>tracked change</b> attributed to the agent, never a silent overwrite, so you review
            them from the Review toolbar or Versions like any collaborator's edit.
          </div>
          <CopyField value={`${location.origin}/mcp/${encodeURIComponent(project)}`} label="MCP server URL" />
          {newMcpToken && (
            <div class="git-newtoken">
              <div><b>Agent token “{newMcpToken.name}”</b> — copy it now, it is not shown again. Use it as an
                <code> Authorization: Bearer {'<token>'}</code> header, or in your MCP client's config as the token/API key for this server.</div>
              <CopyField value={newMcpToken.token} />
            </div>
          )}
          <div class="git-tokens">
            {(mcpTokens ?? []).map(t => (
              <div class="git-token" key={t.id}>
                <span class="name">🤖 {t.name}</span>
                <span class="meta">created {fmtDate(t.created_at)}{t.last_used_at ? ` · last used ${ago(t.last_used_at)}` : ' · never used'}</span>
                <button class="mini" title="Revoke this token" onClick={() => void revokeMcpToken(t)}>Revoke</button>
              </div>
            ))}
            {mcpTokens && !mcpTokens.length && <div class="hint">No agent tokens yet.</div>}
          </div>
          <div class="share-add">
            <input type="text" placeholder="Agent name, e.g. Research assistant" value={mcpName} onInput={e => setMcpName((e.target as HTMLInputElement).value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void createMcpToken(); } }} />
            <button class="btn" disabled={mcpBusy} onClick={() => void createMcpToken()}>New agent token</button>
          </div>

          <h4>Off-site mirror</h4>
          {mirror?.configured ? (
            <div class="git-mirror" data-git-mirror>
              <div>
                Mirrored to {mirror.url ? <a href={mirror.url} target="_blank" rel="noopener">{mirror.org}/{mirror.repo}</a> : <code>{mirror.repo}</code>}
                {' · '}{mirror.lastPushAt ? `last push ${ago(mirror.lastPushAt)}` : 'not pushed yet'}
                {' · '}
                {!mirror.enabled ? <b>paused</b>
                  : mirror.lastError ? <span class="err-inline" title={mirror.lastError}>last push failed: {mirror.lastError.slice(0, 120)}</span>
                  : mirror.behind ? `changes go out with the next push (every ${Math.round(mirror.intervalMs / 60000)} min)` : 'up to date'}
              </div>
              {isOwner && (
                <div class="git-mirror-actions">
                  <button class="btn" disabled={mirrorBusy} onClick={() => void mirrorUpdate({ now: true })}>Mirror now</button>
                  <button class="btn" disabled={mirrorBusy} onClick={() => void mirrorUpdate({ enabled: !mirror.enabled })}>{mirror.enabled ? 'Pause mirroring' : 'Resume mirroring'}</button>
                </div>
              )}
              <div class="hint">A private copy of this repository, with its whole history, in the server's GitHub organisation — the server only ever pushes to it. It is a backup, not a place to work: push your own changes to the clone URL above.</div>
            </div>
          ) : <div class="hint">No off-site mirror is configured on this server.</div>}

          <h4>History</h4>
          <div class="hint">
            OverLyX commits what people edit here about half a minute after the last change, and always before a clone, pull or push, so the
            repository is never behind the editor. A push into the project updates it at once — open documents merge the change like an
            external save.
          </div>
          {info.pending > 0 && (
            <div class="git-pending">
              <span>{info.pending} uncommitted change{info.pending === 1 ? '' : 's'}: <span class="files" title={info.pendingFiles.join('\n')}>{info.pendingFiles.slice(0, 4).join(', ')}{info.pendingFiles.length > 4 ? ', …' : ''}</span></span>
              {canPush && <>
                <input type="text" placeholder="Commit message (optional)" value={message} onInput={e => setMessage((e.target as HTMLInputElement).value)}
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void commit(); } }} />
                <button class="btn" disabled={busy} onClick={() => void commit()} data-git-commit>Commit now</button>
              </>}
            </div>
          )}
          {info.pending === 0 && <div class="hint">Everything is committed (branch <code>{info.branch}</code>).</div>}
          <div class="git-log" data-git-log>
            {info.commits.map(c => (
              <div class="git-commit" key={c.hash} title={c.hash}>
                <code class="hash">{c.hash.slice(0, 7)}</code>
                <span class="msg">{c.message}</span>
                <span class="meta">{c.author} · {ago(c.date)}</span>
              </div>
            ))}
            {!info.commits.length && <div class="hint">No commits yet.</div>}
          </div>
        </div>
      )}
    </Dialog>
  );

  function defaultTokenName(): string {
    const ua = navigator.userAgent;
    const os = /Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows PC' : /Linux/.test(ua) ? 'Linux machine' : 'computer';
    return `${user.name.split(/\s+/)[0]}'s ${os}`;
  }
}
