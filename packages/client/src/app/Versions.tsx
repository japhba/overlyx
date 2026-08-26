import { useEffect, useState } from 'preact/hooks';
import { api, type VersionInfo } from '../api';

function diffLines(a: string, b: string): { type: 'same' | 'add' | 'del'; text: string }[] {
  // simple LCS-based line diff (documents are small enough)
  const A = a.split('\n'), B = b.split('\n');
  const n = A.length, m = B.length;
  if (n * m > 4_000_000) return [{ type: 'same', text: '(diff too large)' }];
  const dp: Uint16Array[] = [];
  for (let i = 0; i <= n; i++) dp.push(new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: { type: 'same' | 'add' | 'del'; text: string }[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { out.push({ type: 'same', text: A[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ type: 'del', text: A[i] }); i++; }
    else { out.push({ type: 'add', text: B[j] }); j++; }
  }
  while (i < n) out.push({ type: 'del', text: A[i++] });
  while (j < m) out.push({ type: 'add', text: B[j++] });
  return out;
}

export function Versions({ docId, refreshKey }: { docId: string; refreshKey: number }) {
  const [versions, setVersions] = useState<VersionInfo[]>([]);
  const [diff, setDiff] = useState<{ name: string; lines: ReturnType<typeof diffLines> } | null>(null);
  const load = () => api.versions(docId).then(r => setVersions(r.versions)).catch(() => {});
  useEffect(() => { load(); }, [docId, refreshKey]);

  const create = async () => {
    const name = prompt('Version name:', new Date().toLocaleString());
    if (name === null) return;
    await api.createVersion(docId, name || 'version');
    load();
  };
  const restore = async (v: VersionInfo) => {
    if (!confirm(`Restore version "${v.name}" from ${new Date(v.created_at).toLocaleString()}? The current state is saved as a version first.`)) return;
    await api.restoreVersion(docId, v.id);
    load();
  };
  const showDiff = async (v: VersionInfo) => {
    const [old, cur] = await Promise.all([api.getVersion(docId, v.id), api.lyxText(docId)]);
    const lines = diffLines(old.lyx, cur).filter((l, i, arr) => l.type !== 'same' || arr.slice(Math.max(0, i - 2), i + 3).some(x => x.type !== 'same'));
    setDiff({ name: v.name, lines });
  };
  const del = async (v: VersionInfo) => { if (confirm('Delete this version?')) { await api.deleteVersion(docId, v.id); load(); } };

  return (
    <div>
      <div style="display:flex;gap:6px;margin-bottom:6px">
        <button class="small-btn" onClick={create}>+ Save version</button>
        <button class="small-btn" onClick={load}>↻</button>
      </div>
      {versions.map(v => (
        <div class="version" key={v.id}>
          <div class="name">{v.name} {v.kind === 'auto' && <span style="color:#999;font-weight:400">(auto)</span>}</div>
          <div class="meta">{new Date(v.created_at).toLocaleString()} · {v.author} · {(v.size / 1024).toFixed(0)} KB</div>
          <div class="buttons">
            <button class="small-btn" onClick={() => showDiff(v)}>Diff vs now</button>
            <button class="small-btn" onClick={() => restore(v)}>Restore</button>
            <button class="small-btn" onClick={() => del(v)}>Delete</button>
          </div>
        </div>
      ))}
      {!versions.length && <div style="color:#888">No versions yet. Versions are created automatically while editing (every 10 minutes) and manually here.</div>}
      {diff && (
        <div style="margin-top:8px">
          <div style="display:flex;justify-content:space-between"><b>Changes since "{diff.name}"</b><button class="small-btn" onClick={() => setDiff(null)}>close</button></div>
          <div class="version-diff">
            {diff.lines.length ? diff.lines.map((l, i) => <div key={i} class={l.type}>{(l.type === 'add' ? '+ ' : l.type === 'del' ? '- ' : '  ') + l.text}</div>) : <div>(identical)</div>}
          </div>
        </div>
      )}
    </div>
  );
}
