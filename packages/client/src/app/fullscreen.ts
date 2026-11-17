/**
 * The browser's own full screen under an editor's (a deck's slide edge to edge, a whiteboard alone on
 * the screen): asked for where there is one to ask for — not in a web app opened from the home
 * screen, which has no bars of its own —, given up with the editor's. The editor's own stays when the
 * browser leaves its full screen by itself (iPad Safari does as text is typed in), unless it says otherwise.
 */
export function standaloneApp(): boolean {
  try { return (navigator as { standalone?: boolean }).standalone === true || matchMedia('(display-mode: standalone)').matches; } catch { return false; }
}

export function browserFullscreen(on: boolean): void {
  const html = document.documentElement;
  try {
    if (on && !standaloneApp() && !document.fullscreenElement && document.fullscreenEnabled) void html.requestFullscreen?.()?.catch(() => undefined);
    else if (!on && document.fullscreenElement === html) void document.exitFullscreen().catch(() => undefined);
  } catch { /* no full screen here */ }
}
