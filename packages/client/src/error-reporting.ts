/** Browser diagnostics that are not uncaught application failures and should not become issues. */
export const BENIGN_BROWSER_ERROR = /^ResizeObserver loop (?:completed with undelivered notifications\.?|limit exceeded\.?)$/;

export function isBenignBrowserError(message: string): boolean {
  return BENIGN_BROWSER_ERROR.test(message.trim());
}

/** A rejected IndexedDB write the browser's own closing of the database cut off (editor/localreopen.ts opens it again). */
export const STORAGE_CLOSED = /^(?:AbortError: |InvalidStateError: )?(?:The connection was closed|The database connection is closing)\.?$/i;
