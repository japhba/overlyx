import type { ToolButton } from './Toolbar';
import { getInk, setInk, inkColorsInUse } from '../editor/plugins/ink';
import { drawingToolbar } from '../deliverable/drawingToolbar';
import { loadDeckInk, patchDeckInk, saveDeckInk } from '../deliverable/deckink';

export function inkToolbar(): ToolButton[][] {
  const ink = getInk();
  return drawingToolbar({
    tool: ink.tool === 'pen' || ink.tool === 'highlighter' ? 'pen' : ink.tool,
    setTool: tool => { if (tool === 'eraser' || tool === 'lasso') setInk({ tool }); else if (tool === 'pen') setInk({ tool: loadDeckInk().pen }); },
    ink: { presets: loadDeckInk(), set: patch => saveDeckInk(patchDeckInk(loadDeckInk(), patch)), draw: active => setInk({ active }) },
    done: false,
    // the margins hold strokes and pictures (and the Draw row's lines and shapes, drawn as strokes)
    lasso: { kinds: ['ink', 'shapes', 'pictures'], colors: inkColorsInUse },
    extras: [
      { id: 'i-laser', title: 'Laser pointer — a temporary trace visible to collaborators', icon: 'inklaser', active: ink.tool === 'laser', action: () => setInk({ tool: 'laser' }) },
    ],
  });
}
