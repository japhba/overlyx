/**
 * The inside of an avatar circle: the user's picture when they have one (Google sign-in; served
 * through /api/users/:id/avatar), otherwise their initials. The circle itself (class `avatar`,
 * background = the user's colour) is drawn by the caller, so it can be a <span> or a <button>.
 */
import { useState } from 'preact/hooks';

export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
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
