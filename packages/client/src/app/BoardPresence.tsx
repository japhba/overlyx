/**
 * The others on a whiteboard (app/BoardEditor.tsx), over the board: their faces in its top right
 * corner — a tap opens Go to / Follow —; a marker at the view's edge for everyone whose pointer (or,
 * without one, whose view) is out of sight, pointing their way — a tap goes there —; and, while
 * following someone, their colour round the view with the way to stop.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { AvatarContent, initials } from './Avatar';
import { inkOn } from './contrast';
import { edgeSpot, peerSpot, type BoardPeer, type Camera, type Insets } from './boardview';

/** how many faces the corner shows before "+n" */
const MAX_FACES = 5;

const firstName = (name: string): string => name.replace(/\s*\([^)]*\)\s*$/, '').trim().split(/\s+/)[0] || name;

function Face({ p, size }: { p: BoardPeer; size?: number }) {
  return (
    <span class="avatar board-face" style={{ background: p.color, color: inkOn(p.color), ...(size ? { width: size + 'px', height: size + 'px', lineHeight: size + 'px' } : {}) }}
      data-initials={p.avatar ? undefined : initials(p.name).length}><AvatarContent name={p.name} src={p.avatar} /></span>
  );
}

export function BoardPresence({ peers, cam, size, insets, following, faces, onGo, onFollow }: {
  peers: BoardPeer[];
  cam: Camera;
  /** the board's view (px) */
  size: [number, number];
  /** the view's edges taken by bars: the markers stay clear of them */
  insets: Insets;
  /** whose view this one follows */
  following: number | null;
  /** the faces in the corner shown (in full screen the bars can be tapped away: the markers and the follow frame stay) */
  faces: boolean;
  onGo: (p: BoardPeer) => void;
  onFollow: (clientId: number | null) => void;
}) {
  const [menu, setMenu] = useState<number | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (menu === null) return;
    const away = (e: PointerEvent) => { const t = e.target as Element | null; if (!menuRef.current?.contains(t) && !t?.closest?.('[data-board-face]')) setMenu(null); };
    document.addEventListener('pointerdown', away, true);
    return () => document.removeEventListener('pointerdown', away, true);
  }, [menu]);
  // (someone left: their menu goes with them)
  useEffect(() => { if (menu !== null && !peers.some(p => p.clientId === menu)) setMenu(null); }, [peers, menu]);

  const [W, H] = size;
  const followed = peers.find(p => p.clientId === following) ?? null;
  const open = peers.find(p => p.clientId === menu) ?? null;
  const shown = peers.slice(0, MAX_FACES), more = peers.length - shown.length;
  const markers = W > 0 && H > 0 ? peers.flatMap(p => {
    if (p.clientId === following) return [];
    const at = peerSpot(p);
    const e = at && edgeSpot(cam.tx + at.x * cam.s, cam.ty + at.y * cam.s, W, H, insets);
    return e ? [{ p, e }] : [];
  }) : [];

  return (
    <>
      {markers.map(({ p, e }) => (
        <button key={'edge' + p.clientId} type="button" class={'board-edge' + (e.y > H / 2 ? ' below' : '')} data-board-edge={p.clientId}
          style={{ left: `${e.x}px`, top: `${e.y}px`, '--peer': p.color } as never}
          title={`${p.name} is over there — go to ${p.cursor ? 'their pointer' : 'what they see'}`} aria-label={`Go to ${p.name}`}
          onPointerDown={ev => ev.stopPropagation()} onClick={() => onGo(p)}>
          <span class="board-edge-arrow" style={{ transform: `rotate(${e.angle}rad)` }} aria-hidden="true">
            <svg viewBox="0 0 10 10" width="10" height="10"><path d="M2 1.5L9 5 2 8.5z" /></svg>
          </span>
          <Face p={p} />
          <span class="board-edge-name">{firstName(p.name)}</span>
        </button>
      ))}
      {followed && (
        <div class="board-follow" data-board-following={followed.clientId} style={{ '--peer': followed.color } as never}>
          <div class="board-follow-bar" onPointerDown={ev => ev.stopPropagation()}>
            <span>Following <b>{followed.name}</b></span>
            <button type="button" data-board-follow-stop onClick={() => onFollow(null)}>Stop</button>
          </div>
        </div>
      )}
      {faces && peers.length > 0 && (
        <div class="board-people" data-board-people onPointerDown={ev => ev.stopPropagation()}>
          {shown.map(p => (
            <button key={p.clientId} type="button" class={'board-person' + (p.clientId === following ? ' following' : '') + (p.clientId === menu ? ' open' : '')}
              data-board-face={p.clientId} style={{ '--peer': p.color } as never} aria-haspopup="menu" aria-expanded={p.clientId === menu}
              title={`${p.name} — go to them, or follow their view`} onClick={() => setMenu(m => (m === p.clientId ? null : p.clientId))}>
              <Face p={p} />
            </button>
          ))}
          {more > 0 && <span class="avatar board-face more" title={peers.slice(MAX_FACES).map(p => p.name).join(', ')}>+{more}</span>}
          {open && (
            <div class="board-person-menu" ref={menuRef} role="menu" data-board-person-menu>
              <div class="board-person-head"><Face p={open} size={22} /><span>{open.name}</span></div>
              <button type="button" role="menuitem" data-board-go disabled={!peerSpot(open)}
                onClick={() => { setMenu(null); onGo(open); }}>
                Go to {firstName(open.name)}<small>{open.cursor ? 'Where their pointer is' : open.view ? 'What they see' : 'They have not looked at the board yet'}</small>
              </button>
              <button type="button" role="menuitem" data-board-follow disabled={following !== open.clientId && !open.view}
                onClick={() => { setMenu(null); onFollow(following === open.clientId ? null : open.clientId); }}>
                {following === open.clientId ? 'Stop following' : `Follow ${firstName(open.name)}`}
                <small>{following === open.clientId ? 'Your view stays where it is' : 'Your view moves with theirs until you move it'}</small>
              </button>
            </div>
          )}
        </div>
      )}
    </>
  );
}
