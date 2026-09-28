/**
 * Rewriting paths in a document's LaTeX for the build directory (pure: no server state).
 */
import path from 'node:path';

/**
 * Paths that climb out of the document's directory (`\\input{../macros}`, `\\graphicspath{{../figures/}}`,
 * `\\includegraphics{../logos/x}` — a poster in a sub-folder of its paper's project) as paths from the
 * project's root: TeX runs with openin_any=p, which refuses any name containing `../`, and the project
 * root is on TEXINPUTS (texInputs). Paths that would leave the project are left alone.
 */
export function rewriteParentPaths(text: string, docDir: string, projDir: string): string {
  const fix = (name: string): string => {
    const n = name.trim();
    if (!n.startsWith('../')) return name;
    const abs = path.resolve(docDir, n);
    if (abs !== projDir && !abs.startsWith(projDir + path.sep)) return name;
    // the project root itself (a \\graphicspath entry {../}): the empty prefix, found through TEXINPUTS
    const rel = path.relative(projDir, abs).split(path.sep).join('/');
    return rel ? rel + (n.endsWith('/') ? '/' : '') : '';
  };
  let out = text.replace(/\\(input|include|includeonly|subfile|bibliography|addbibresource|olsketch)(\s*(?:\[[^\]]*\])?\s*)\{([^}]*)\}/g, (_m, cmd: string, opt: string, arg: string) => `\\${cmd}${opt}{${arg.split(',').map(fix).join(',')}}`);
  out = out.replace(/\\includegraphics(\s*\*?\s*(?:\[[^\]]*\])?\s*)\{([^}]*)\}/g, (_m, opt: string, arg: string) => `\\includegraphics${opt}{${fix(arg)}}`);
  out = out.replace(/\\olimage(\s*\{(?:[^{}]|\{[^{}]*\})*\}\s*)\{([^}]*)\}/g, (_m, keys: string, arg: string) => `\\olimage${keys}{${fix(arg)}}`);
  out = out.replace(/\\graphicspath\s*\{((?:\s*\{[^{}]*\})*)\s*\}/g, (_m, dirs: string) => `\\graphicspath{${dirs.replace(/\{([^{}]*)\}/g, (_d, d: string) => `{${fix(d)}}`)}}`);
  return out;
}

