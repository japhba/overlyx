import type { Response } from 'express';

/**
 * Google's file picker (gdocs/google.ts pickerConfigured: linking / importing Google Docs that exist)
 * runs Google's script and opens Google's frame in the page — allowed only where it is set up. Google
 * checks the picker's API key against the page that opened the frame, so there other sites are told
 * the origin (never the path: public PDF links carry their token there) instead of nothing. (The
 * environment is read here, not config.ts: importing that would fix the configuration at whatever
 * moment this module is first loaded — before a test has pointed it at its scratch directories.)
 */
const googleOrigins = () => (process.env.GOOGLE_PICKER_API_KEY && process.env.GOOGLE_CLIENT_ID
  ? { script: ' https://apis.google.com https://www.gstatic.com', frame: ' https://docs.google.com https://drive.google.com https://accounts.google.com https://content.googleapis.com', connect: ' https://www.googleapis.com https://content.googleapis.com', img: ' https://*.gstatic.com https://*.googleusercontent.com' }
  : { script: '', frame: '', connect: '', img: '' });

/**
 * The TeX engine of end-to-end encrypted projects (client public/vendor/swiftlatex) is WebAssembly: its
 * worker script may compile WebAssembly ('wasm-unsafe-eval' — not JavaScript's eval). A dedicated
 * worker runs under the policy of its own script's response, so nothing else gets this.
 */
const WASM_WORKERS = /^\/vendor\/swiftlatex\/[^/]+\.js$/;

/** Only OAuth consent pages pass an already-validated client redirect URI. `path`: the request's (the TeX engine's worker may compile WebAssembly). */
export function setSecurityHeaders(res: Response, formRedirectUri?: string, path?: string): void {
  const G = googleOrigins();
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', G.frame ? 'strict-origin-when-cross-origin' : 'same-origin');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // the site is served over https only: browsers keep to it (ignored on plain-http responses, e.g. in development)
  res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  // Only our own scripts run in the app; project files are user content and are served as
  // downloads (see /file/*), so a stray script in a project can never run as us.
  // Chromium checks form-action on the redirect after a form POST, too. The consent page
  // must allow that client's callback origin before the user clicks Allow or Deny.
  // The editor's fonts are served with the client (fonts/web), so style-src and font-src stay 'self'.
  // connect-src blob:: a PDF built in the browser (end-to-end encrypted projects) is a blob: URL pdf.js fetches.
  const formAction = formRedirectUri ? `'self' ${new URL(formRedirectUri).origin}` : "'self'";
  res.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self'${path && WASM_WORKERS.test(path) ? " 'wasm-unsafe-eval'" : ''}${G.script}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:${G.img}; font-src 'self' data:; connect-src 'self' blob: ws: wss:${G.connect}; frame-src 'self' blob:${G.frame}; worker-src 'self' blob:; object-src 'self'; base-uri 'self'; form-action ${formAction}; frame-ancestors 'self'`);
}
