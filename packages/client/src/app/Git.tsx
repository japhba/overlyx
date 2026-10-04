/**
 * Git dialog: the project's clone URL and how to use it from a local machine, how to connect a
 * local agent (Claude Code, Codex) to the MCP connector, the account access token (shared by git,
 * the CLI and MCP — Google accounts have no password), the recent commits (each can be restored as a
 * new commit) and what OverLyX has not committed yet. Every project is a repository; OverLyX commits its own
 * writes automatically and before every clone / pull / push, and a push updates the project.
 */
import { useEffect, useState } from 'preact/hooks';
import { api, zipUrl, type GitInfo, type GitToken, type MirrorStatus, type User } from '../api';
import { Dialog, uiConfirm } from './Dialogs';

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

/** The row-level Copy of a re-copyable token (accounts with token re-copy on, Settings ▸ Account). */
function CopyMini({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(value); }
    catch { const ta = document.createElement('textarea'); ta.value = value; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); }
    setCopied(true); setTimeout(() => setCopied(false), 2000);
  };
  return <button class="mini" data-token-copy title="Copy this token (re-copy is enabled for your account)" onClick={() => void copy()}>{copied ? 'Copied ✓' : 'Copy'}</button>;
}

export function GitDialog({ project, onClose }: { project: string; user: User; onClose: () => void }) {
  const [info, setInfo] = useState<GitInfo | null>(null);
  const [tokens, setTokens] = useState<GitToken[] | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [newToken, setNewToken] = useState<{ id: number; token: string } | null>(null);
  const [message, setMessage] = useState('');
  const [mcpTokens, setMcpTokens] = useState<GitToken[] | null>(null);
  const [mirror, setMirror] = useState<MirrorStatus | null>(null);
  const [mirrorBusy, setMirrorBusy] = useState(false);

  const load = () => Promise.all([
    api.gitInfo(project).then(setInfo),
    api.gitTokens().then(r => setTokens(r.tokens)),
    api.mcpTokens().then(r => setMcpTokens(r.tokens)),
    api.mirrorStatus(project).then(setMirror).catch(() => setMirror(null)),
  ]).catch(e => setErr((e as Error).message));
  useEffect(() => { setInfo(null); void load(); }, [project]);
  useEffect(() => {
    const t = setInterval(() => { if (!document.hidden) { api.gitInfo(project).then(setInfo).catch(() => {}); api.mirrorStatus(project).then(setMirror).catch(() => {}); } }, 5000);
    return () => clearInterval(t);
  }, [project]);

  const createToken = async () => {
    if (busy) return;
    if (tokens?.length && !(await uiConfirm('Rotate Access Token', 'Rotate your account access token? Every Git, CLI and manual MCP client using the current token will need the new one.'))) return;
    setBusy(true); setErr('');
    try {
      const r = await api.rotateGitToken();
      setTokens(r.tokens); setNewToken({ id: r.id, token: r.token });
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  };
  const revoke = async (t: GitToken) => {
    if (!(await uiConfirm('Revoke Access Token', 'Revoke your account access token? Every Git, CLI and manual MCP client using it will stop working.', { danger: true, okLabel: 'Revoke' }))) return;
    try { setTokens((await api.deleteGitToken(t.id)).tokens); if (newToken?.id === t.id) setNewToken(null); }
    catch (e) { setErr((e as Error).message); }
  };
  const revokeMcpToken = async (t: GitToken) => {
    if (!(await uiConfirm('Disconnect', `Disconnect "${t.name}"? That OAuth or legacy connection will stop working.`, { danger: true, okLabel: 'Disconnect' }))) return;
    try { setMcpTokens((await api.deleteMcpToken(t.id)).tokens); }
    catch (e) { setErr((e as Error).message); }
  };

  const commit = async () => {
    if (busy) return;
    setBusy(true); setErr('');
    try { const r = await api.gitCommit(project, message.trim() || undefined); setInfo(i => ({ ...(i as GitInfo), ...r })); setMessage(''); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  };

  const restore = async (c: GitInfo['commits'][number]) => {
    if (busy) return;
    if (!(await uiConfirm('Restore Commit', `Put the whole project back to how it was at ${c.hash.slice(0, 7)} ("${c.message}", ${fmtDate(c.date)})?\n\nThis is a new commit on top: everything since stays in the history, so it can be undone the same way. Open documents take the restored text over.`, { okLabel: 'Restore' }))) return;
    setBusy(true); setErr('');
    try { const r = await api.gitRestore(project, c.hash); setInfo(i => ({ ...(i as GitInfo), ...r })); if (!r.restored) setErr('The project is already as it was at that commit.'); }
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
          <div class="hint">Just want a backup, not a git clone? <a href={zipUrl(project)} data-download-zip={project}>Download the whole project as a .zip</a>.</div>

          <h4>Local agents — Claude Code, Codex, … on your computer</h4>
          <div class="hint" data-git-agents>
            An agent on your own machine edits your projects <b>right here on the server</b>, through the MCP connector below — no
            copy of the projects, no sync, no shell: it acts with your account token and your role in each project. Its document
            edits are tracked changes you review; when tracked editing runs into any problem (an edit that will not apply, a build
            it breaks) the server tells the agent to fall back to direct edits. Every state stays in the history — <i>Restore</i>{' '}
            below, or the agent's own <code>restore_project</code>, steps back.
          </div>
          <pre class="git-cmds">{`# with the OverLyX CLI (above): sign in through the browser, then Claude Code and Codex are registered —
# nothing to redo when the server or your token changes
overlyx auth login${location.origin === 'https://overlyx.app' ? '' : ' --host ' + location.origin}
overlyx mcp install`}</pre>
          <div class="hint">
            The agents run the CLI as their bridge (<code>overlyx mcp serve</code>): it connects with your current login and the server's
            current settings at every session. In a clone of the OverLyX repository nothing needs registering — its <code>.mcp.json</code>{' '}
            and <code>.codex/config.toml</code> do it. Without the CLI, register the connector directly (the token below in{' '}
            <code>OVERLYX_TOKEN</code>):
          </div>
          <pre class="git-cmds">{`claude mcp add -s user --transport http overlyx ${location.origin}/mcp \\
  --header "Authorization: Bearer $OVERLYX_TOKEN"

# Codex: ~/.codex/config.toml
[mcp_servers.overlyx]
url = "${location.origin}/mcp"
bearer_token_env_var = "OVERLYX_TOKEN"`}</pre>
          <div class="hint" data-git-agents-live>
            The agent <b>sees where you are</b>: your cursor and selection in an open document (its <code>get_presence</code>{' '}
            tool), so "this paragraph" or "the selected equation" means yours. You see it too — as a collaborator with its
            own cursor where it last edited or what it points at. And you can <b>write to it from OverLyX</b>: in the Agent
            panel (right sidebar) pick it and send a message; ask it once, in its terminal, to <i>listen to OverLyX</i> and it
            waits for your messages and answers there. Claude Code can get your messages pushed into its session instead —
            start it with <code>claude --dangerously-load-development-channels server:overlyx</code>. Only you (the owner of
            the token) can write to your agent, never the people you share a project with.
          </div>

          <h4>Your account access token — Git, CLI and MCP</h4>
          <div class="hint">Your account has one manually-managed token, shared by every project and client. Use it as the password for Git or the OverLyX CLI, or as an MCP Bearer token. Rotating it replaces the old token everywhere.</div>
          {newToken && (
            <div class="git-newtoken">
              <div><b>Your new account token</b> — copy it now; unless token re-copy is enabled for your account, it is not shown again:</div>
              <CopyField value={newToken.token} />
            </div>
          )}
          <div class="git-tokens">
            {(tokens ?? []).map(t => (
              <div class="git-token" key={t.id}>
                <span class="name">🔑 Account access token</span>
                <span class="meta">created {fmtDate(t.created_at)}{t.last_used_at ? ` · last used ${ago(t.last_used_at)}` : ' · never used'}</span>
                {t.token && <CopyMini value={t.token} />}
                <button class="mini" title="Revoke this token" onClick={() => void revoke(t)}>Revoke</button>
              </div>
            ))}
            {tokens && !tokens.length && <div class="hint">No account token yet.</div>}
          </div>
          <button class="btn" disabled={busy} onClick={() => void createToken()}>{tokens?.length ? 'Rotate token' : 'Create token'}</button>

          <h4>MCP connector — let an AI agent read, comment and edit</h4>
          <div class="hint">
            Any MCP-compatible client can connect — it acts as <b>your account</b>: one connection reaches{' '}
            <b>every project you can access</b> (a <code>list_projects</code> tool names them; the other tools take a{' '}
            <code>project</code> argument), with your role in each: read documents, comments and project files, build
            the PDF, and (with edit access) comment and write raw LaTeX — document edits land as a <b>tracked
            change</b> attributed to the agent, reviewed from the Review toolbar like any collaborator's edit (or, as
            the fallback when tracked editing gets in the way, directly — the history keeps the state before).
            <b>ChatGPT</b> connects with no token at all (Settings ▸ Apps ▸ Developer
            mode ▸ Create, this URL, OAuth — you approve it on a consent page); Claude, Claude Code and others use
            your account token above as a Bearer header.
          </div>
          <CopyField value={`${location.origin}/mcp`} label="MCP server URL (all your projects)" />
          <div class="hint">To pin a client to just this project, give it <code>{location.origin}/mcp/{project.split('/').map(encodeURIComponent).join('/')}</code> instead.</div>
          <h4>Sign-ins, OAuth connections and agent tokens</h4>
          <div class="hint">Each CLI sign-in (<code>overlyx auth login</code>) and each OAuth client keeps a credential of its own, so you can disconnect one without rotating your account token. Older manually-created agent tokens remain usable and can be revoked here, but new manual connections use the account token above. With Settings ▸ Account ▸ Fine-grained access, a new sign-in can be limited to some projects or to reading.</div>
          <div class="git-tokens">
            {(mcpTokens ?? []).map(t => (
              <div class="git-token" key={t.id}>
                <span class="name">🤖 {t.name}</span>
                <span class="meta">created {fmtDate(t.created_at)}{t.expires_at ? ` · expires ${fmtDate(t.expires_at)}` : ''}{t.last_used_at ? ` · last used ${ago(t.last_used_at)}` : ' · never used'}{t.scope && <span data-token-scope> · {t.scope.projects ? `only ${t.scope.projects.join(', ') || 'no projects'}` : 'all projects'}{t.scope.readonly ? ', read only' : ''}</span>}</span>
                {t.token && <CopyMini value={t.token} />}
                <button class="mini" title="Revoke this token" onClick={() => void revokeMcpToken(t)}>Revoke</button>
              </div>
            ))}
            {mcpTokens && !mcpTokens.length && <div class="hint">No sign-ins or OAuth connections.</div>}
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
            external save. <i>Restore</i> puts the whole project back to an earlier commit, as a new commit on top.
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
            {info.commits.map((c, i) => (
              <div class="git-commit" key={c.hash} title={c.hash}>
                <code class="hash">{c.hash.slice(0, 7)}</code>
                <span class="msg">{c.message}</span>
                <span class="meta">{c.author} · {ago(c.date)}</span>
                {canPush && i > 0 && <button class="mini" disabled={busy} data-git-restore={c.hash} title="Put the whole project back to how it was at this commit (a new commit on top)" onClick={() => void restore(c)}>Restore</button>}
              </div>
            ))}
            {!info.commits.length && <div class="hint">No commits yet.</div>}
          </div>
        </div>
      )}
    </Dialog>
  );

}
