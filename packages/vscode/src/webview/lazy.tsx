import { useEffect, useState } from 'preact/hooks';
import type { ComponentType } from 'preact';

/**
 * A component whose module is loaded the first time it is shown: its code (pdf.js for the built PDF)
 * stays out of what the webview loads and compiles before the document appears.
 */
export function lazyComponent<P extends object>(load: () => Promise<ComponentType<P>>): ComponentType<P> {
  let loaded: ComponentType<P> | null = null;
  let loading: Promise<ComponentType<P>> | null = null;
  return function Lazy(props: P) {
    const [C, setC] = useState<ComponentType<P> | null>(() => loaded);
    useEffect(() => {
      if (C) return;
      let mounted = true;
      void (loading ??= load().then(c => (loaded = c))).then(c => { if (mounted) setC(() => c); }, e => console.error('OverLyX: could not load a part of the editor', e));
      return () => { mounted = false; };
    }, []);
    return C ? <C {...props} /> : null;
  };
}
