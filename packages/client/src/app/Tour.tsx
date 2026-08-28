/**
 * Interactive walkthrough ("coach marks"): a sequence of steps, each pointing at a part of the UI
 * and asking the user to try something. A step completes when the editor state shows that they did
 * (typed, entered a formula, started a comment, opened the Versions tab, …) — or when they skip it;
 * the whole tour can be left at any time. It is offered once per browser (`localStorage.ol.tour`)
 * and can be restarted from Help ▸ Take the tour or the start screen.
 *
 * The tour never blocks the interface: the dimmed overlay lets clicks through, only the card itself
 * takes them (without stealing the editor's focus), so the user works in the real editor.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';

const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = isMac ? '⌘' : 'Ctrl';

/** Live state of the workspace the steps look at. */
export interface TourCtx {
  docId: string | null;
  /** a LyX document is open, synced and its editor is on screen */
  ready: boolean;
  /** bumps on every document change */
  docTick: number;
  /** layout of the paragraph under the cursor */
  layout: string;
  /** the cursor is inside a formula */
  inMath: boolean;
  saveState: string;
  rightTab: string | null;
  pdfBusy: boolean;
  pdfBuiltAt: number;
  shareOpen: boolean;
  gitOpen: boolean;
  marginMode: boolean;
}
export interface TourActions {
  /** open the user's example document (or another document to practise on); resolves false if there is none */
  openExample: () => Promise<boolean>;
  showRight: () => void;
  showFiles: () => void;
}

/** ctx plus what the tour reads from the DOM itself */
interface Snap extends TourCtx { comments: number; /** paragraphs whose layout is not Standard */ styled: number }

interface Step {
  id: string;
  title: string;
  body: ComponentChildren | ((now: Snap, base: Snap | null) => ComponentChildren);
  /** CSS selectors tried in order; the first element found is highlighted */
  target?: string[];
  /** the task: complete when it holds, compared with the snapshot taken when the step became active */
  done?: (now: Snap, base: Snap) => boolean;
  /** the base snapshot is only taken once this holds (e.g. the document has loaded) */
  ready?: (now: Snap) => boolean;
  /** prepare the interface for the step */
  enter?: (a: TourActions) => void;
}

const kbd = (k: string) => <kbd>{k}</kbd>;

export const TOUR_STEPS: Step[] = [
  {
    id: 'type', title: 'A real LyX document',
    target: ['.lyx-editor'],
    ready: s => s.ready,
    body: (now) => now.ready ? <>
      <p>What you see is your personal example project: an ordinary <code>.tex</code> file, rendered as you type — no compiling needed to read it, and any LaTeX editor (or Overleaf) opens the same file.</p>
      <p><b>Click into the text and type a few words.</b></p>
    </> : <p>Opening your example document…</p>,
    done: (now, base) => now.docTick > base.docTick,
  },
  {
    id: 'layout', title: 'Paragraph layouts',
    target: ['.toolbar-standard select'],
    body: <>
      <p>Headings, lists, theorems and the like are <i>layouts</i> of the document class, not formatting. The list here shows the layout of the paragraph under the cursor.</p>
      <p><b>Press {kbd('Enter')} for a new paragraph and make it a <i>Section</i></b> — pick it from this list, or press {kbd('Alt+P')} then {kbd('2')} (LyX's shortcut).</p>
    </>,
    // a new heading (or list item, …) appeared, or the paragraph under the cursor got another layout
    done: (now, base) => now.styled > base.styled || (now.docTick > base.docTick && now.layout !== base.layout && now.layout !== 'Standard'),
  },
  {
    id: 'math', title: 'Formulas, edited like in LyX',
    target: ['[data-tb="math"]'],
    body: <>
      <p>Formulas are edited in place with LyX's keys: {kbd('^')} and {kbd('_')} for scripts, {kbd('\\')} starts a command ({kbd('Space')} or {kbd('Tab')} completes it), {kbd('Esc')} leaves the formula. The math toolbar appears while the cursor is in one.</p>
      <p><b>Press {kbd(MOD + '+M')} (or this button) and type</b> <code>\alpha^2 + \beta</code>.</p>
    </>,
    done: now => now.inMath,
  },
  {
    id: 'save', title: 'Everything is saved for you',
    target: ['.statusbar .save-state'],
    body: (now) => <>
      <p>There is no Save button: every edit goes to the server at once and is written to the <code>.tex</code> file a moment later; this indicator turns green when the file is up to date. If the connection drops you keep editing offline and your changes sync when it is back.</p>
      <p><b>Wait for “All changes saved”.</b>{now.saveState === 'saved' && <> ✓</>}</p>
    </>,
    done: now => now.saveState === 'saved',
  },
  {
    id: 'comment', title: 'Comments and notes',
    target: ['[data-tb="comment"]'],
    body: <>
      <p>Comment threads (author, time, replies, resolve) are stored as LyX <i>Comment</i> notes, so colleagues on desktop LyX see them too. <i>View ▸ Notes &amp; comments in the margin</i> moves them next to the text, Google-Docs style.</p>
      <p><b>Select a word and press {kbd(MOD + '+Alt+C')}</b> (or this button) to start a thread, then type your remark.</p>
    </>,
    done: (now, base) => now.comments > base.comments,
  },
  {
    id: 'pdf', title: 'Compile to PDF',
    target: ['[data-tb="pdf"]'],
    enter: a => a.showRight(),
    body: <>
      <p>PDF builds run in the background on the server (LaTeX export + <code>latexmk</code>) — keep editing while they run. The <i>PDF</i> tab on the right shows the progress, the result and the log.</p>
      <p><b>Press {kbd(MOD + '+R')}</b> or this button to build the PDF.</p>
    </>,
    done: (now, base) => now.pdfBusy || now.pdfBuiltAt !== base.pdfBuiltAt,
  },
  {
    id: 'versions', title: 'Nothing is ever lost',
    target: ['[data-tab="versions"]', '.sidebar.right .panel-tabs'],
    enter: a => a.showRight(),
    body: <>
      <p>The history of every document is kept: automatic snapshots, versions you name yourself, and the state before anything drastic (a large deletion, an external change, offline edits that could not be merged). Compare any of them with the current text and restore it.</p>
      <p><b>Open the <i>Versions</i> tab.</b></p>
    </>,
    done: now => now.rightTab === 'versions',
  },
  {
    id: 'share', title: 'Work together',
    target: ['.filetree [data-share]', '.sidebar [data-share]'],
    enter: a => a.showFiles(),
    body: <>
      <p>Projects are private until you share them. Invite colleagues by e-mail or user name as <i>editors</i> or <i>viewers</i>, or turn on a link. Everybody edits the same document live — the avatars in the status bar show who is here; click one to jump to their cursor.</p>
      <p><b>Click 👥 in the file browser</b> (or <i>File ▸ Share project…</i>) to see the sharing dialog. You can close it again without inviting anyone.</p>
    </>,
    done: now => now.shareOpen,
  },
  {
    id: 'git', title: 'Your files stay yours',
    target: ['.filetree [data-git]', '.sidebar [data-git]'],
    enter: a => a.showFiles(),
    body: <>
      <p>The project folder on the server is a git repository: ⎇ shows the clone URL and creates access tokens, so you can <code>git clone</code>, edit with desktop LyX or your favourite editor, and <code>push</code> — OverLyX commits what people edit here and merges what you push. Every document is also mirrored in this browser, so it opens instantly and works offline.</p>
    </>,
  },
  {
    id: 'end', title: 'That’s the tour',
    body: <>
      <p>The example document itself goes on with figures, tables, citations, cross-references and math macros — edit it freely, it is yours. <i>Help ▸ Keyboard shortcuts</i> lists LyX's bindings ({kbd('Alt+P')} … layouts, {kbd('Alt+M')} … math, {kbd(MOD + '+Shift+E')} change tracking, …).</p>
      <p>You can take this tour again any time from <i>Help ▸ Take the tour</i>.</p>
    </>,
  },
];

const countComments = () => document.querySelectorAll('.lyx-editor .lyx-inset-note-comment').length;
const countStyled = () => document.querySelectorAll('.lyx-editor > .lyx-par:not(.lyx-layout-standard)').length;

function findTarget(sels: string[] | undefined): HTMLElement | null {
  if (!sels) return null;
  for (const s of sels) {
    const el = document.querySelector<HTMLElement>(s);
    if (el && el.getBoundingClientRect().width > 0) return el;
  }
  return null;
}

export type TourEnd = 'finished' | 'left' | 'declined';

export function Tour({ ctx, actions, intro, onEnd }: { ctx: TourCtx; actions: TourActions; intro: boolean; onEnd: (how: TourEnd) => void }) {
  const [step, setStep] = useState(intro ? -1 : 0);
  const [base, setBase] = useState<Snap | null>(null);
  /** the task was seen done once — it stays done even if the condition is transient (dialog closed again, cursor left the formula) */
  const [done, setDone] = useState(false);
  const [, setTick] = useState(0);
  const [noExample, setNoExample] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const spotRef = useRef<HTMLDivElement>(null);
  const snap: Snap = { ...ctx, comments: countComments(), styled: countStyled() };
  const cur = step >= 0 ? TOUR_STEPS[step] : null;

  // the interface moves under us (panels open, formulas render): re-measure and re-evaluate regularly
  useEffect(() => { const t = setInterval(() => setTick(x => x + 1), 250); return () => clearInterval(t); }, []);
  // moving between steps resets the snapshot and the task state in the same update (no window with stale ones)
  const go = (n: number) => { setStep(n); setBase(null); setDone(false); };
  useEffect(() => { cur?.enter?.(actions); }, [step]);
  // take the base snapshot once the step is ready (once: base goes from null to a value)
  useEffect(() => { if (cur && !base && (cur.ready?.(snap) ?? true)) setBase(snap); });
  useEffect(() => { if (cur && base && !done && cur.done?.(snap, base)) setDone(true); });

  const task = !!cur?.done;
  const last = step === TOUR_STEPS.length - 1;

  const start = async () => {
    const ok = await actions.openExample();
    if (!ok) { setNoExample(true); return; }
    go(0);
  };

  // position the spotlight and the card imperatively (no state → no render loops)
  useLayoutEffect(() => {
    const card = cardRef.current, spot = spotRef.current;
    if (!card) return;
    const el = step >= 0 ? findTarget(cur?.target) : null;
    const r = el?.getBoundingClientRect() ?? null;
    const vw = window.innerWidth, vh = window.innerHeight, W = card.offsetWidth, H = card.offsetHeight, m = 12;
    if (spot) {
      if (r) { spot.style.display = 'block'; spot.style.left = r.left - 4 + 'px'; spot.style.top = r.top - 4 + 'px'; spot.style.width = r.width + 8 + 'px'; spot.style.height = r.height + 8 + 'px'; }
      else spot.style.display = 'none';
    }
    let left: number, top: number;
    if (step < 0) { left = (vw - W) / 2; top = Math.max(m, (vh - H) / 2 - 40); }
    else if (!r) { left = vw - W - 24; top = vh - H - 40; }
    else if (r.height > vh * 0.45) { left = Math.min(r.right, vw) - W - 24; top = Math.min(r.bottom, vh) - H - 40; }   // a big area (the page): sit in its lower right corner
    else if (r.bottom + 10 + H < vh) { left = r.left + r.width / 2 - W / 2; top = r.bottom + 10; }
    else { left = r.left + r.width / 2 - W / 2; top = r.top - H - 10; }
    card.style.left = Math.max(m, Math.min(left, vw - W - m)) + 'px';
    card.style.top = Math.max(m, Math.min(top, vh - H - m)) + 'px';
  });

  const body = cur ? (typeof cur.body === 'function' ? cur.body(snap, base) : cur.body) : null;
  return (
    <div class="tour" data-tour-step={cur?.id ?? 'intro'} data-tour-done={done ? '1' : '0'}>
      {step < 0 && <div class="tour-backdrop" />}
      {step >= 0 && <div class="tour-spot" ref={spotRef} />}
      {/* never take the focus: the user keeps typing in the editor, and Enter/Space there must not activate a tour button */}
      <div class="tour-card" ref={cardRef} role="dialog" aria-label="Tour" onMouseDown={e => e.preventDefault()}>
        {step < 0 ? (
          <>
            <h3>Welcome to OverLyX 👋</h3>
            <p>A three-minute hands-on tour: it opens your example document and asks you to try the essentials — typing, layouts, a formula, a comment, a PDF build, versions and sharing.</p>
            <p class="tour-muted">Every step can be skipped and you can leave at any time; restart it from <i>Help ▸ Take the tour</i>.</p>
            {noExample && <p class="tour-error">You have no document to practise on — create a project and a document first, or open one shared with you, then start the tour from the Help menu.</p>}
            <div class="tour-buttons">
              <button class="btn" onClick={() => onEnd('declined')}>Not now</button>
              <button class="btn primary" onClick={() => void start()}>Take the tour</button>
            </div>
          </>
        ) : (
          <>
            <div class="tour-head">
              <h3>{cur!.title}</h3>
              <span class="tour-count">{step + 1} / {TOUR_STEPS.length}</span>
              <button class="tour-close" title="End the tour" onClick={() => onEnd('left')}>✕</button>
            </div>
            <div class="tour-body">{body}</div>
            {task && <div class={'tour-task' + (done ? ' done' : '')}>{done ? '✓ Done — go on when you are ready' : base ? 'Try it — the tour notices when you have' : 'Waiting for the document…'}</div>}
            <div class="tour-buttons">
              <button class="btn" disabled={step === 0} onClick={() => go(step - 1)}>Back</button>
              <span class="tour-dots">{TOUR_STEPS.map((s, i) => <i key={s.id} class={i === step ? 'on' : i < step ? 'past' : ''} />)}</span>
              {last ? <button class="btn primary" onClick={() => onEnd('finished')}>Finish</button>
                : task && !done ? <button class="btn" onClick={() => go(step + 1)} title="Go on without doing this">Skip step</button>
                : <button class="btn primary" onClick={() => go(step + 1)}>Next</button>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** Whether the tour should be offered on this browser (never seen, not declined). */
export function tourWanted(): boolean { try { return !localStorage.getItem('ol.tour'); } catch { return false; } }
export function rememberTour(how: TourEnd): void { try { localStorage.setItem('ol.tour', how); } catch { /* ignore */ } }
