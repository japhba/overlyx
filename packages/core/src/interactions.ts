/** Content-free usage diagnostics. Both ends accept only these finite categories. */
export const INTERACTION_ACTIONS = ['click', 'double-click', 'context-menu', 'drag', 'drop', 'paste', 'cut', 'change',
  'backspace', 'delete', 'enter', 'escape', 'note-toggle', 'note-dissolve', 'comment-reply', 'comment-resolve', 'zoom',
  'api-read', 'api-write', 'api-import', 'api-export', 'api-upload', 'api-save', 'api-fileop', 'connection', 'app-error', 'image-load', 'long-task',
  'api-meta', 'api-source', 'api-build', 'api-bibliography', 'api-google', 'api-agent',
  'canvas-style', 'canvas-attr', 'canvas-text', 'canvas-edit', 'canvas-remove', 'canvas-insert', 'canvas-move', 'canvas-duplicate', 'canvas-reorder',
  'extension-activate', 'extension-command', 'extension-open', 'extension-close', 'extension-save', 'extension-edit', 'extension-build', 'extension-sync', 'extension-agent', 'extension-update'] as const;
export const INTERACTION_OUTCOMES = ['attempt', 'changed', 'unchanged', 'removed', 'emptied', 'success', 'failed', 'denied', 'missing', 'conflict', 'invalid', 'offline', 'online', 'cancelled'] as const;
export const INTERACTION_TARGETS = ['ui', 'text', 'math', 'table', 'note', 'comment', 'greyedout', 'inset', 'figure', 'toolbar', 'menu', 'dialog', 'form', 'files', 'tabs', 'sidebar', 'source', 'pdf', 'canvas', 'home', 'api'] as const;
const FIELDS = {
  selection: ['none', 'caret', 'range', 'node'],
  content: ['none', 'empty', 'filled'],
  display: ['none', 'inline', 'margin', 'collapsed'],
  access: ['none', 'edit', 'view'],
  tracking: ['none', 'on', 'off'],
  pointer: ['none', 'mouse', 'touch', 'pen'],
} as const;
export type InteractionAction = typeof INTERACTION_ACTIONS[number];
export type InteractionOutcome = typeof INTERACTION_OUTCOMES[number];
export type InteractionTarget = typeof INTERACTION_TARGETS[number];
export type InteractionState = { [K in keyof typeof FIELDS]?: typeof FIELDS[K][number] };
const keys = Object.keys(FIELDS) as (keyof typeof FIELDS)[];
export const isInteractionTarget = (v: unknown): v is InteractionTarget => typeof v === 'string' && (INTERACTION_TARGETS as readonly string[]).includes(v);

export function makeInteractionDetail(action: InteractionAction, outcome: InteractionOutcome, state: InteractionState = {}): string | null {
  const detail = [action, outcome, ...keys.map(k => state[k] ?? 'none')].join(' ');
  return parseInteractionDetail(detail) ? detail : null;
}
export function parseInteractionDetail(value: unknown): { action: InteractionAction; outcome: InteractionOutcome; state: InteractionState } | null {
  if (typeof value !== 'string') return null;
  const tokens = value.split(' ');
  if (tokens.length !== keys.length + 2 || !(INTERACTION_ACTIONS as readonly string[]).includes(tokens[0]) || !(INTERACTION_OUTCOMES as readonly string[]).includes(tokens[1])) return null;
  if (!keys.every((k, i) => (FIELDS[k] as readonly string[]).includes(tokens[i + 2]))) return null;
  return { action: tokens[0] as InteractionAction, outcome: tokens[1] as InteractionOutcome, state: Object.fromEntries(keys.map((k, i) => [k, tokens[i + 2]])) as InteractionState };
}

/** Paths are classified locally; no path, query, method payload or server error enters an event. */
export function apiInteraction(method: string, url: string): InteractionAction | null {
  if (/\/(usage|auth|feedback|client-error|settings)(?:[/?]|$)/.test(url)) return null;
  if (/\/(import(?:-lyx)?|gdocs\/import)(?:[/?]|$)/.test(url)) return 'api-import';
  if (/\/(export|lyx|zip)(?:[/?]|$)/.test(url)) return 'api-export';
  if (/\/upload(?:[/?]|$)/.test(url)) return 'api-upload';
  if (/\/(save|source|header)(?:[/?]|$)/.test(url) && method !== 'GET') return 'api-save';
  if (/\/fileops(?:[/?]|$)/.test(url)) return 'api-fileop';
  if (/\/meta(?:[/?]|$)/.test(url)) return 'api-meta';
  if (/\/(tex|source)(?:[/?]|$)/.test(url)) return 'api-source';
  if (/\/build(?:[/?]|$)/.test(url)) return 'api-build';
  if (/\/bib(?:[/?]|$)/.test(url)) return 'api-bibliography';
  if (/\/gdocs(?:[/?]|$)/.test(url)) return 'api-google';
  if (/\/(agent|mcp-agents)(?:[/?]|$)/.test(url)) return 'api-agent';
  return method === 'GET' ? 'api-read' : 'api-write';
}
export function requestOutcome(status: number): InteractionOutcome {
  return status === 0 ? 'offline' : status < 400 ? 'success' : status === 401 || status === 403 ? 'denied' : status === 404 ? 'missing' : status === 409 ? 'conflict' : status < 500 ? 'invalid' : 'failed';
}

export function canvasInteraction(type: unknown): InteractionAction | null {
  switch (type) {
    case 'inner': return 'canvas-text';
    case 'outer': return 'canvas-edit';
    case 'style': case 'attr': case 'remove': case 'insert': case 'move': case 'duplicate': case 'reorder': return `canvas-${type}`;
    default: return null;
  }
}

/** The bundled build timestamp, shared by every client of a release. */
export const isClientBuildVersion = (value: unknown): value is string => typeof value === 'string' && value.length <= 150 && /^(?:\d{2}\/\d{2}\/\d{2}-\d{2}:\d{2}|vscode:(?:\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?|unknown);code:(?:\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?|unknown))$/.test(value);
