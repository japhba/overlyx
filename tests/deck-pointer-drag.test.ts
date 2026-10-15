// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { capturePointerDrag } from '../packages/client/src/deliverable/pointerdrag';

afterEach(() => { vi.restoreAllMocks(); document.body.replaceChildren(); });

function drag() {
  const target = document.createElement('div');
  document.body.append(target);
  const move = vi.fn(), finish = vi.fn();
  const cancel = capturePointerDrag(target, new PointerEvent('pointerdown', { pointerId: 7 }), move, finish);
  const send = (type: string, id = 7) => target.dispatchEvent(new PointerEvent(type, { pointerId: id, clientX: 23 }));
  return { target, move, finish, cancel, send };
}

describe('captured slide rail pointer drag', () => {
  it('commits only the owning pointer and stops listening after release', () => {
    const d = drag();
    d.send('pointermove', 8); d.send('pointerup', 8);
    expect(d.move).not.toHaveBeenCalled(); expect(d.finish).not.toHaveBeenCalled();
    d.send('pointermove'); expect(d.move).toHaveBeenCalledTimes(1);
    d.send('pointerup');
    expect(d.finish).toHaveBeenCalledTimes(1);
    expect(d.finish.mock.calls[0][0]).toBe(false);
    expect(d.finish.mock.calls[0][1].clientX).toBe(23);
    d.send('pointermove'); d.send('lostpointercapture'); d.cancel();
    expect(d.move).toHaveBeenCalledTimes(1); expect(d.finish).toHaveBeenCalledTimes(1);
  });

  it.each(['pointercancel', 'lostpointercapture'])('rolls back on %s, without accepting later moves', type => {
    const d = drag();
    d.send(type, 9); expect(d.finish).not.toHaveBeenCalled();
    d.send(type);
    expect(d.finish).toHaveBeenCalledTimes(1); expect(d.finish.mock.calls[0][0]).toBe(true);
    d.send('pointermove'); d.send('pointerup');
    expect(d.move).not.toHaveBeenCalled(); expect(d.finish).toHaveBeenCalledTimes(1);
  });

  it.each(['blur', 'resize'])('rolls back on window %s and removes that global listener', type => {
    const d = drag();
    window.dispatchEvent(new Event(type));
    expect(d.finish).toHaveBeenCalledTimes(1); expect(d.finish.mock.calls[0][0]).toBe(true);
    d.send('pointermove'); window.dispatchEvent(new Event(type));
    expect(d.move).not.toHaveBeenCalled(); expect(d.finish).toHaveBeenCalledTimes(1);
  });

  it('ignores visible-document changes but cancels on backgrounding', () => {
    const d = drag();
    const visible = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(d.finish).not.toHaveBeenCalled();
    visible.mockReturnValue(true);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(d.finish).toHaveBeenCalledTimes(1); expect(d.finish.mock.calls[0][0]).toBe(true);
  });

  it('can be disposed before unmount and never calls back again', () => {
    const d = drag(); d.cancel(); d.target.remove(); d.cancel();
    window.dispatchEvent(new Event('blur')); d.send('pointerup');
    expect(d.finish).toHaveBeenCalledTimes(1); expect(d.finish.mock.calls[0][0]).toBe(true);
    expect(d.move).not.toHaveBeenCalled();
  });

  it('releases owned capture after removing the lost-capture listener', () => {
    const target = document.createElement('div'); document.body.append(target);
    const release = vi.fn(() => target.dispatchEvent(new PointerEvent('lostpointercapture', { pointerId: 7 })));
    Object.assign(target, { setPointerCapture: vi.fn(), hasPointerCapture: () => true, releasePointerCapture: release });
    const finish = vi.fn();
    const cancel = capturePointerDrag(target, new PointerEvent('pointerdown', { pointerId: 7 }), vi.fn(), finish);
    cancel();
    expect(release).toHaveBeenCalledExactlyOnceWith(7);
    expect(finish).toHaveBeenCalledTimes(1);
  });
});
