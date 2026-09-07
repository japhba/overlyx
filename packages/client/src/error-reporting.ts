/** Browser diagnostics that are not uncaught application failures and should not become issues. */
export function isBenignBrowserError(message: string): boolean {
  return /^ResizeObserver loop (?:completed with undelivered notifications\.?|limit exceeded\.?)$/.test(message.trim());
}
