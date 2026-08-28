/**
 * Help ▸ Report a problem / send feedback: becomes a GitHub issue of the project's repository right
 * away (server/src/feedback.ts). The person sees what is sent and where; the document name and the
 * last error are opt-in.
 */
import { useEffect, useState } from 'preact/hooks';
import { api, type FeedbackInfo } from '../api';
import { editorContext } from '../editor/context';
import { Dialog } from './Dialogs';

export function FeedbackDialog({ docId, onClose }: { docId: string | null; onClose: () => void }) {
  const [info, setInfo] = useState<FeedbackInfo | null>(null);
  const [kind, setKind] = useState<'bug' | 'idea' | 'question'>('bug');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [withDoc, setWithDoc] = useState(true);
  const [withError, setWithError] = useState(true);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ url: string; number?: number; fallback?: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lastError = editorContext.lastError ?? null;
  useEffect(() => { api.feedbackInfo().then(setInfo).catch(() => setInfo(null)); }, []);

  const send = async () => {
    if (!title.trim() && !body.trim()) { setError('Please write something first.'); return; }
    setBusy(true); setError(null);
    try {
      const r = await api.feedback({ kind, title: title.trim(), body: body.trim(), doc: withDoc ? docId : null, error: withError ? lastError : null });
      setResult({ url: r.url, number: r.number });
    } catch (e) {
      const err = e as Error & { data?: { fallback?: string } };
      if (err.data?.fallback) { window.open(err.data.fallback, '_blank', 'noopener'); setResult({ url: err.data.fallback, fallback: true }); }
      else setError(err.message);
    } finally { setBusy(false); }
  };

  const repoUrl = info ? `https://github.com/${info.repo}` : null;
  return (
    <Dialog title="Report a problem / send feedback" onClose={onClose} buttons={!result && <button class="btn primary" disabled={busy} onClick={() => void send()} data-feedback-send>{busy ? 'Sending…' : 'Send to GitHub'}</button>}>
      {result ? (
        <div class="feedback-done" data-feedback-done>
          {result.fallback
            ? <p>This server is not connected to GitHub, so a pre-filled issue form was opened in a new tab — please submit it there: <a href={result.url} target="_blank" rel="noopener">GitHub issue form</a>.</p>
            : <p>Thank you! Your report is <a href={result.url} target="_blank" rel="noopener">issue #{result.number}</a>. You will get e-mail from GitHub when somebody answers if you leave a comment there.</p>}
        </div>
      ) : (
        <>
          <p class="feedback-note">
            Reports become issues in {repoUrl ? <a href={repoUrl + '/issues'} target="_blank" rel="noopener">{info!.repo}</a> : 'the OverLyX repository'} on GitHub — a <b>public</b> tracker.
            Sent with it: your name and user name, the app version ({info?.version ?? '…'}) and your browser; never the content of your documents.
          </p>
          <div class="row"><label>Kind</label>
            <select value={kind} onChange={e => setKind((e.target as HTMLSelectElement).value as any)} data-feedback-kind>
              <option value="bug">Something is broken</option><option value="idea">An idea / a missing feature</option><option value="question">A question</option>
            </select>
          </div>
          <div class="row"><label>Title</label><input type="text" value={title} onInput={e => setTitle((e.target as HTMLInputElement).value)} placeholder="One line" data-feedback-title /></div>
          <textarea rows={7} value={body} onInput={e => setBody((e.target as HTMLTextAreaElement).value)} data-feedback-body
            placeholder={kind === 'bug' ? 'What did you do, what happened, what did you expect? (Markdown is fine)' : 'Tell us more (Markdown is fine)'} />
          {docId && <label class="feedback-opt"><input type="checkbox" checked={withDoc} onChange={e => setWithDoc((e.target as HTMLInputElement).checked)} /> Include the document name (<code>{docId}</code>) — visible publicly</label>}
          {lastError && <label class="feedback-opt"><input type="checkbox" checked={withError} onChange={e => setWithError((e.target as HTMLInputElement).checked)} /> Include the last error message shown in the app (<code>{lastError.split('\n')[0].slice(0, 80)}</code>)</label>}
          {error && <div class="feedback-error">{error}</div>}
        </>
      )}
    </Dialog>
  );
}
