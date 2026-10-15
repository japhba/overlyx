/** A captured drag belongs to one pointer and releases every listener on interruption. */
export function capturePointerDrag(
  target: HTMLElement,
  start: PointerEvent,
  move: (event: PointerEvent) => void,
  finish: (cancelled: boolean, event?: PointerEvent) => void,
): () => void {
  const id = start.pointerId;
  const doc = target.ownerDocument;
  const win = doc.defaultView;
  let ended = false;
  const end = (cancelled: boolean, event?: PointerEvent) => {
    if (ended) return;
    ended = true;
    target.removeEventListener('pointermove', moved);
    target.removeEventListener('pointerup', lifted);
    target.removeEventListener('pointercancel', interrupted);
    target.removeEventListener('lostpointercapture', interrupted);
    win?.removeEventListener('blur', cancel);
    win?.removeEventListener('resize', cancel);
    doc.removeEventListener('visibilitychange', hidden);
    try { if (target.hasPointerCapture(id)) target.releasePointerCapture(id); } catch { /* detached or already released */ }
    finish(cancelled, event);
  };
  const cancel = () => end(true);
  const moved = (event: PointerEvent) => { if (event.pointerId === id) move(event); };
  const lifted = (event: PointerEvent) => { if (event.pointerId === id) end(false, event); };
  const interrupted = (event: PointerEvent) => { if (event.pointerId === id) end(true, event); };
  const hidden = () => { if (doc.hidden) cancel(); };
  target.addEventListener('pointermove', moved);
  target.addEventListener('pointerup', lifted);
  target.addEventListener('pointercancel', interrupted);
  target.addEventListener('lostpointercapture', interrupted);
  win?.addEventListener('blur', cancel);
  win?.addEventListener('resize', cancel);
  doc.addEventListener('visibilitychange', hidden);
  try { target.setPointerCapture(id); } catch { /* synthetic event or capture unsupported */ }
  return cancel;
}
