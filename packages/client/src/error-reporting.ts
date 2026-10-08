/** Browser diagnostics that are not uncaught application failures and should not become issues. */
export const BENIGN_BROWSER_ERROR = /^ResizeObserver loop (?:completed with undelivered notifications\.?|limit exceeded\.?)$/;

export function isBenignBrowserError(message: string): boolean {
  return BENIGN_BROWSER_ERROR.test(message.trim());
}
