import type { Response } from 'express';

/** Only OAuth consent pages pass an already-validated client redirect URI. */
export function setSecurityHeaders(res: Response, formRedirectUri?: string): void {
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Only our own scripts run in the app; project files are user content and are served as
  // downloads (see /file/*), so a stray script in a project can never run as us.
  // Chromium checks form-action on the redirect after a form POST, too. The consent page
  // must allow that client's callback origin before the user clicks Allow or Deny.
  // The editor's fonts are served with the client (fonts/web), so style-src and font-src stay 'self'.
  const formAction = formRedirectUri ? `'self' ${new URL(formRedirectUri).origin}` : "'self'";
  res.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws: wss:; frame-src 'self' blob:; worker-src 'self' blob:; object-src 'self'; base-uri 'self'; form-action ${formAction}; frame-ancestors 'self'`);
}
