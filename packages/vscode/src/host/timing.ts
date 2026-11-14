import fs from 'node:fs';

const file = process.env.OVERLYX_TIMING_LOG;

/**
 * A step of the extension's start or of a document's opening, with the wall clock — written only
 * when OVERLYX_TIMING_LOG names a file (test/probeOpenTiming.mjs sets it and prints the steps on its
 * timeline, beside the webview's `ol:*` marks).
 */
export function timing(step: string): void {
  if (file) try { fs.appendFileSync(file, `${Date.now()} ${step}\n`); } catch { /* not measured */ }
}
