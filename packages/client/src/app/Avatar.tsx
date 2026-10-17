/**
 * The inside of an avatar circle: the user's picture when they have one (Google sign-in; served
 * through /api/users/:id/avatar), otherwise their initials. The circle itself (class `avatar`,
 * background = the user's colour) is drawn by the caller, so it can be a <span> or a <button>.
 */
import { useState } from 'preact/hooks';

export function initials(name: string): string {
  // "Claude Code (Jan)" — an agent named after its owner: the initials of the agent, not "C("
  const words = name.replace(/\s*\([^)]*\)\s*$/, '').trim().split(/\s+/).filter(w => /\p{L}|\p{N}/u.test(w));
  if (!words.length) return '?';
  const first = words[0][0] ?? '';
  const last = words.length > 1 ? words[words.length - 1][0] ?? '' : '';
  return (first + last).toUpperCase();
}

export function AvatarContent({ name, src }: { name: string; src?: string | null }) {
  const [failed, setFailed] = useState(false);
  if (src && !failed) return <img src={src} alt="" referrerpolicy="no-referrer" onError={() => setFailed(true)} />;
  return <>{initials(name)}</>;
}

/**
 * A small robot (an agent connected over MCP): drawn in `currentColor`, eyes cut out so the
 * background shows through. The badge on an agent's avatar and its caret label (editor.ts).
 */
export const ROBOT_SVG = '<svg class="ol-robot" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">'
  + '<circle cx="8" cy="1.7" r="1.3"/><rect x="7.35" y="2.6" width="1.3" height="2.4"/>'
  + '<path fill-rule="evenodd" d="M5 4.5h6a2.5 2.5 0 0 1 2.5 2.5v4a2.5 2.5 0 0 1-2.5 2.5H5A2.5 2.5 0 0 1 2.5 11V7A2.5 2.5 0 0 1 5 4.5zM4.55 8.6a1.35 1.35 0 1 0 2.7 0a1.35 1.35 0 1 0-2.7 0zM8.75 8.6a1.35 1.35 0 1 0 2.7 0a1.35 1.35 0 1 0-2.7 0z"/>'
  + '<rect x="0.7" y="7.4" width="1.3" height="3.2" rx="0.65"/><rect x="14" y="7.4" width="1.3" height="3.2" rx="0.65"/></svg>';

/** The robot in the lower right corner of an agent's avatar (which shows the account it works for). */
export function AgentBadge() {
  return <span class="agent-badge" dangerouslySetInnerHTML={{ __html: ROBOT_SVG }} />;
}
