/**
 * What the deliverable editor (DeliverableEditor.tsx) needs from where it runs: the page's text and
 * a way to change it, the address of its folder for the sandboxed frames, uploads, files changed on
 * disk, other people. The web app keeps the text in a Y.Text synced with the server (webHost.ts);
 * the VS Code extension in the file's TextDocument (packages/vscode, deliverable webview).
 */
import type { Splice } from '@overlyx/core/html/source.ts';
import type { Path, PeerInfo, TextCaret } from './protocol';
import type { MenuItem } from '../editor/contextmenu';
import type { RuntimeMode } from '@overlyx/core/html/serve.ts';
import type { AssetUrls } from './offlineassets';
import type { PresentState, PresenterState } from '../app/presentshare';

export type { Splice };

/** what made a change: the canvas or the toolbar ('canvas'), the code view ('code'), anybody else */
export type ChangeOrigin = 'canvas' | 'code' | 'remote';

export type Peer = PeerInfo;
export interface DeliverableSaveState { pending: boolean; localPending?: boolean; localError?: string; state: 'saved' | 'saving' | 'offline' | 'connecting' | 'stale' }

export interface DeliverableHost {
  /** project-relative path of the page (folder of uploads, the title) */
  readonly path: string;
  /** a web page made an article — written in the document editor from now on (the web app's; core html/article.ts) */
  makeArticle?(): Promise<void>;
  /** Embedded drawings load the runtime separately from their project's images. */
  readonly folderBase?: string;
  /** the text now */
  text(): string;
  /** One change; discrete actions get a separate undo step, while typing may continue a group. */
  apply(splices: Splice[], origin: 'canvas' | 'code', separateUndo?: boolean): void;
  /** after every change of the text */
  onChange(cb: (origin: ChangeOrigin) => void): () => void;
  undo(): void;
  redo(): void;
  /** the text has arrived (a web document syncs first) */
  ready(): boolean;
  onReady(cb: () => void): () => void;
  /** connected (the web app; always true elsewhere) */
  online(): boolean;
  onStatus(cb: () => void): () => void;
  readOnly(): boolean;
  /** Confirmed disk-write status (hosts without autosave may omit it). */
  saveState?(): DeliverableSaveState;
  onSaveState?(cb: () => void): () => void;
  discardLocal?(): Promise<void>;
  /** where the page's folder is served to the sandboxed frames: `base` + `entry` + `?ol=<mode>` */
  link(): Promise<{ base: string; entry: string; expires?: number }>;
  /** A locally rendered sandbox document when its server cannot be reached. */
  offlineFrame?(mode: RuntimeMode, link?: { base: string; entry: string }): Promise<string | null>;
  offlineResources?(): Promise<AssetUrls>;
  onOfflineResources?(callback: (assets: AssetUrls) => void): () => void;
  /** a file put into the project (project-relative path); rejects when the name is taken */
  upload(rel: string, data: Blob): Promise<void>;
  /** a file of the project changed on disk (project-relative path, a version stamp) */
  onAsset(cb: (path: string, v: number) => void): () => void;
  /** this person's selection, for the others; the others' */
  setSelection(paths: Path[]): void;
  /** this person's caret in the text they retype (null: none), and the slide they look at — for the others (a host without others leaves them out) */
  setCaret?(caret: TextCaret | null): void;
  setSlide?(slide: number): void;
  /** the slide of a deck this person looked at last (null: none), to reopen it there — and noting the one looked at now (a host without memory leaves them out: the first slide) */
  lastSlide?(): Promise<number | null>;
  noteSlide?(slide: number): void;
  onPeers(cb: (peers: Peer[]) => void): () => void;
  /**
   * Presenting on several screens (app/presentshare.ts): this presenter's state for the others (null:
   * it stopped), and the others' `present` states as they come — at once, and on every change. A
   * host without others leaves them out.
   */
  setPresent?(state: PresentState | null): void;
  onPresent?(cb: (peers: PresenterState[]) => void): () => void;
  /** the Download menu's entries (the web app: PDF, website; VS Code: print, open in the browser) */
  downloads(open: (mode: string) => string): MenuItem[];
  /** present here (a full-screen frame) — or elsewhere, returning true (VS Code: the browser) */
  present?(url: string): boolean;
  /** ⌘S (the web app saves by itself; VS Code saves the document) */
  save?(): void;
  /** A drawing embedded in a document uses the same canvas and exports its page as SVG (`except`: a selector for objects to leave out). */
  bindSvgExporter?(exporter: (except?: string) => Promise<string>): () => void;
  /** a key pressed on the canvas that the editor does not handle (VS Code: its own shortcuts) */
  key?(k: { key: string; ctrl: boolean; shift: boolean; alt: boolean; meta: boolean }): void;
  /** the name comments and suggestions are made under (the account's; VS Code: git's user.name) */
  author?(): string;
  /** the page's document id on the server (the citation dialog searches and adds papers with it); absent: no citation dialog */
  readonly docId?: string;
  /** the page's web address, which links to a slide or an object extend (editor/permalink.ts); absent or null: no such links */
  webLink?(): string | null;
  /** the project's bibliography (its .bib files): the entries of `keys` (with their fields), for citations typed or pasted */
  bibliography?(keys: string[]): Promise<BibRecord[]>;
}

/** an entry of the project's bibliography as the server sends it */
export interface BibRecord { key: string; type?: string; fields?: Record<string, string>; authorShort?: string; author?: string; year?: string; title?: string }
