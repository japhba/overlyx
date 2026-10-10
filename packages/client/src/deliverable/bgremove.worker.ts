/**
 * Background removal off the main thread (BgRemoveDialog.tsx): the picture is sent once (`load`,
 * analysed here), then each change of the tolerance or the marks asks for a `preview` at the
 * analysis size, and "Keep changes" for the `final` picture at full size. Every answer carries the
 * request's id, so the dialog drops answers to requests it has superseded.
 */
import { analyse, backgroundMask, composite, scaleOptions, type BgAnalysis, type BgOptions, type MaskCache, type RGBAImage } from './bgremove';

export type BgRequest =
  | { id: number; type: 'load'; image: RGBAImage }
  | { id: number; type: 'preview' | 'final'; opts: BgOptions };

export type BgResponse =
  | { id: number; type: 'loaded'; width: number; height: number }
  | { id: number; type: 'image'; image: RGBAImage; allBackground: boolean }
  | { id: number; type: 'error'; message: string };

let full: RGBAImage | null = null;
let an: BgAnalysis | null = null;
let cache: MaskCache = {};

const post = (m: BgResponse, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(m, transfer);

self.onmessage = (e: MessageEvent<BgRequest>) => {
  const m = e.data;
  try {
    if (m.type === 'load') {
      full = m.image;
      an = analyse(full);
      cache = {};
      post({ id: m.id, type: 'loaded', width: an.width, height: an.height });
      return;
    }
    if (!full || !an) throw new Error('no picture loaded');
    const mask = backgroundMask(an, m.opts, cache);
    const r = m.type === 'preview' ? composite(an.image, an, mask, scaleOptions(m.opts, an.scale)) : composite(full, an, mask, m.opts);
    post({ id: m.id, type: 'image', image: r.image, allBackground: r.allBackground }, [r.image.data.buffer]);
  } catch (err) {
    post({ id: m.id, type: 'error', message: String((err as Error)?.message ?? err) });
  }
};
