import type { ToolButton } from './Toolbar';
import { getInk, setInk, isShapeTool } from '../editor/plugins/ink';
import { drawingToolbar } from '../deliverable/drawingToolbar';
import { loadDeckInk, patchDeckInk, saveDeckInk } from '../deliverable/deckink';

export function inkToolbar(): ToolButton[][] {
  const ink = getInk();
  return drawingToolbar({
    tool: ink.tool === 'pen' || ink.tool === 'highlighter' ? 'pen' : ink.tool,
    setTool: tool => { if (tool === 'eraser') setInk({ tool: 'eraser' }); else if (tool === 'pen') setInk({ tool: loadDeckInk().pen }); },
    ink: { presets: loadDeckInk(), set: patch => saveDeckInk(patchDeckInk(loadDeckInk(), patch)), draw: active => setInk({ active }) },
    done: false,
    // the layout editor's Lines and Shapes, in the pen's colour and width
    shapes: { tool: isShapeTool(ink.tool) ? ink.tool : null, set: kind => setInk({ tool: kind }) },
    extras: [
      { id: 'i-lasso', title: 'Lasso — select strokes and images to move, resize or delete', icon: 'inklasso', active: ink.tool === 'lasso', action: () => setInk({ tool: 'lasso' }) },
      { id: 'i-laser', title: 'Laser pointer — a temporary trace visible to collaborators', icon: 'inklaser', active: ink.tool === 'laser', action: () => setInk({ tool: 'laser' }) },
    ],
  });
}
