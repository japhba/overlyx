/** Preact components that show formulas outside the editor (toolbars, the settings sample, the agent panel). */
import { useEffect, useState } from 'preact/hooks';
import { onMathRendererChange, mathRendererVersion } from './mathjax';

/** The renderer's version: the component renders again when formulas must be drawn anew (another math font). */
export function useMathRendererVersion(): number {
  const [version, setVersion] = useState(mathRendererVersion());
  useEffect(() => { const off = onMathRendererChange(() => setVersion(mathRendererVersion())); return () => { off(); }; }, []);
  return version;
}
