/**
 * Help ▸ Report a problem / send feedback: kept on the OverLyX server and read by its operator
 * (server/src/feedback.ts) — never published. The person sees what is sent; the document name and
 * the last error are opt-in.
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
  const [result, setResult] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lastError = editorContext.lastError ?? null;
  useEffect(() => { api.feedbackInfo().then(setInfo).catch(() => setInfo(null)); }, []);

  const send = async () => {
    if (!title.trim() && !body.trim()) { setError('Please write something first.'); return; }
    setBusy(true); setError(null);
    try {
      const r = await api.feedback({ kind, title: title.trim(), body: body.trim(), doc: withDoc ? docId : null, error: withError ? lastError : null });
      setResult(r.id);
    } catch (e) {
      setError((e as Error).message);
    } finally { setBusy(false); }
  };

  return (
    <Dialog title="Report a problem / send feedback" onClose={onClose} buttons={result === null && <button class="btn primary" disabled={busy} onClick={() => void send()} data-feedback-send>{busy ? 'Sending…' : 'Send'}</button>}>
      {result !== null ? (
        <div class="feedback-done" data-feedback-done>
          <p>Thank you! Your report (#{result}) reached the people who run OverLyX. If they have a question, they will answer by e-mail.</p>
        </div>
      ) : (
        <>
          <p class="feedback-note">
            Your report stays on the OverLyX server and is read only by the people who run it — it is not published.
            Sent with it: your account, the app version ({info?.version ?? '…'}) and your browser; never the content of your documents (<a href="/privacy" target="_blank" rel="noopener">privacy notice</a>).
          </p>
          <div class="row"><label>Kind</label>
            <select value={kind} onChange={e => setKind((e.target as HTMLSelectElement).value as any)} data-feedback-kind>
              <option value="bug">Something is broken</option><option value="idea">An idea / a missing feature</option><option value="question">A question</option>
            </select>
          </div>
          <div class="row"><label>Title</label><input type="text" value={title} onInput={e => setTitle((e.target as HTMLInputElement).value)} placeholder="One line" data-feedback-title /></div>
          <textarea rows={7} value={body} onInput={e => setBody((e.target as HTMLTextAreaElement).value)} data-feedback-body
            placeholder={kind === 'bug' ? 'What did you do, what happened, what did you expect? (Markdown is fine)' : 'Tell us more (Markdown is fine)'} />
          {docId && <label class="feedback-opt"><input type="checkbox" checked={withDoc} onChange={e => setWithDoc((e.target as HTMLInputElement).checked)} /> Include the document name (<code>{docId}</code>)</label>}
          {lastError && <label class="feedback-opt"><input type="checkbox" checked={withError} onChange={e => setWithError((e.target as HTMLInputElement).checked)} /> Include the last error message shown in the app (<code>{lastError.split('\n')[0].slice(0, 80)}</code>)</label>}
          {error && <div class="feedback-error">{error}</div>}
        </>
      )}
    </Dialog>
  );
}
