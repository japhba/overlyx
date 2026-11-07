/**
 * My fonts: Google fonts installed into an account — the font list's ★ (client FontPicker.tsx,
 * fonts/myfonts.ts). They come first in every font list, in the web app and in the VS Code
 * extension, whose editors reach this through the git API with the CLI's sign-in (git.ts; the
 * extension's bridge, vscode host/fonts.ts, keeps their files for offline use). A font added is
 * fetched into the server's cache at once (googlefonts.ts: the repository's complete files, every
 * axis and OpenType feature), so it is ready when first used.
 *
 *   GET /api/fonts/mine   { fonts }
 *   PUT /api/fonts/mine   { fonts } → { fonts } (valid family names, duplicates and the excess dropped)
 */
import express from 'express';
import { userSettings, setUserSettings } from './userSettings.ts';
import { googleFont } from './googlefonts.ts';

export function myFontRoutes(): express.Router {
  const r = express.Router();
  r.get('/fonts/mine', (req, res) => {
    if (req.user!.guest) { res.json({ fonts: [] }); return; }
    res.json({ fonts: userSettings(req.user!.id).fonts });
  });
  r.put('/fonts/mine', express.json({ limit: '64kb' }), (req, res) => {
    const u = req.user!;
    if (u.guest) { res.status(403).json({ error: 'Sign in to keep fonts in your account' }); return; }
    if (u.scope?.readonly) { res.status(403).json({ error: 'This sign-in is read only' }); return; }
    if (!Array.isArray(req.body?.fonts)) { res.status(400).json({ error: 'fonts: a list of family names' }); return; }
    const before = new Set(userSettings(u.id).fonts);
    const { fonts } = setUserSettings(u.id, { fonts: req.body.fonts });
    for (const f of fonts) if (!before.has(f)) void googleFont(f).catch(() => { /* fetched when first used */ });
    res.json({ fonts });
  });
  return r;
}
