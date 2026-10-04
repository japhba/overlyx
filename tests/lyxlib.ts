/**
 * LyX's lib directory (layouts, latexfonts) for the tests: the `lyx` submodule — empty in a git
 * worktree such as autodeploy's, which does not populate submodules — else the parent of
 * $LYX_LAYOUT_DIR (autodeploy exports it), else the LyX tree this box keeps at /root/lyx.
 */
import fs from 'node:fs';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname);
const env = process.env.LYX_LAYOUT_DIR;
export const LYX_LIB = [path.join(here, '../lyx/lib'), env && path.dirname(env), '/root/lyx/lib']
  .find((d): d is string => !!d && fs.existsSync(path.join(d, 'layouts', 'stdclass.inc'))) ?? path.join(here, '../lyx/lib');
export const LYX_LAYOUTS = path.join(LYX_LIB, 'layouts');
