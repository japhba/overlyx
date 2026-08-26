/**
 * Editable macro arguments for MathLive.
 *
 * MathLive treats a user macro such as `\inv{A}` as one atom: its body is rendered from the
 * definition, but the caret cannot change the *arguments* (edits inside the body are dropped on
 * serialisation). LyX, on the other hand, lets you edit macro arguments in place while the rest
 * of the macro is shown greyed out.
 *
 * To get LyX behaviour we expand macros-with-arguments before handing the formula to MathLive:
 *
 *   \inv{A+B}   ->   \htmlData{lyxmacro=inv,n=1,id=1}{(\htmlData{lyxarg=1,id=1}{A+B})^{-1}}
 *
 * The `\htmlData` groups render as plain spans (with data-attributes we can style), their content
 * is fully editable, and `contractMacroArgs` turns the edited formula back into `\inv{...}` with
 * the (possibly edited) argument. Edits in the fixed part of the template are discarded, as in LyX.
 */
import { readGroup } from './macros.ts';

export interface EditMacro { def: string; args: number }

const NAME_RE = /^\\([A-Za-z]+)/;

function skipWs(s: string, i: number): number { while (i < s.length && /\s/.test(s[i])) i++; return i; }

/** Read one macro argument at s[i]: a {group}, a control sequence, or a single character. */
function readArg(s: string, i: number): [string, number] | null {
  i = skipWs(s, i);
  if (i >= s.length) return null;
  if (s[i] === '{') { const g = readGroup(s, i); return g ? [g[0], g[1]] : null; }
  if (s[i] === '\\') {
    const m = /^\\([A-Za-z]+|.)/.exec(s.slice(i));
    if (!m) return null;
    return [m[0], i + m[0].length];
  }
  return [s[i], i + 1];
}

/** Expand every macro with arguments into an editable `\htmlData` template. */
export function expandMacroArgs(latex: string, macros: Record<string, EditMacro>): string {
  if (!latex.includes('\\')) return latex;
  let counter = 0;
  const expand = (s: string, stack: string[]): string => {
    let out = '';
    for (let i = 0; i < s.length; ) {
      if (s[i] !== '\\') { out += s[i]; i++; continue; }
      // already expanded argument groups are copied verbatim
      if (s.startsWith('\\htmlData{lyxarg=', i)) {
        const tag = readGroup(s, i + 9);
        const grp = tag ? readGroup(s, tag[1]) : null;
        if (tag && grp) { out += s.slice(i, grp[1]); i = grp[1]; continue; }
      }
      const m = NAME_RE.exec(s.slice(i));
      if (!m) { out += s.slice(i, i + 2); i += 2; continue; }
      const name = m[1];
      const def = macros[name];
      if (!def || def.args <= 0 || stack.includes(name) || stack.length > 8) { out += m[0]; i += m[0].length; continue; }
      let j = i + m[0].length;
      const args: string[] = [];
      let ok = true;
      for (let k = 0; k < def.args; k++) {
        const a = readArg(s, j);
        if (!a) { ok = false; break; }
        args.push(a[0]); j = a[1];
      }
      if (!ok) { out += m[0]; i += m[0].length; continue; }
      const id = ++counter;
      const inner = [...stack, name];
      const body = def.def.replace(/#(\d)/g, (whole, d) => {
        const k = Number(d);
        if (k < 1 || k > def.args) return whole;
        return `\\htmlData{lyxarg=${k},id=${id}}{${expand(args[k - 1], inner)}}`;
      });
      out += `\\htmlData{lyxmacro=${name},n=${def.args},id=${id}}{${expand(body, inner)}}`;
      i = j;
    }
    return out;
  };
  return expand(latex, []);
}

const MACRO_TAG = /^lyxmacro=([A-Za-z]+),n=(\d+),id=(\d+)$/;

/** Turn the expanded (and possibly edited) formula back into macro calls. */
export function contractMacroArgs(latex: string): string {
  if (!latex.includes('\\htmlData{lyx')) return latex;
  let out = '';
  for (let i = 0; i < latex.length; ) {
    if (latex.startsWith('\\htmlData{', i)) {
      const tag = readGroup(latex, i + 9);
      const grp = tag ? readGroup(latex, skipWs(latex, tag[1])) : null;
      if (tag && grp) {
        const mm = MACRO_TAG.exec(tag[0]);
        if (mm) {
          const [, name, nStr, id] = mm;
          const n = Number(nStr);
          let call = '\\' + name;
          for (let k = 1; k <= n; k++) {
            const content = findArg(grp[0], k, id);
            call += `{${content === null ? '' : contractMacroArgs(content)}}`;
          }
          out += call;
          i = grp[1];
          continue;
        }
        if (/^lyxarg=\d+,id=\d+$/.test(tag[0])) {
          // an argument whose macro wrapper was deleted: keep its content
          out += contractMacroArgs(grp[0]);
          i = grp[1];
          continue;
        }
      }
    }
    out += latex[i]; i++;
  }
  return out;
}

/** Find the content of `\htmlData{lyxarg=k,id=ID}{...}` anywhere inside `body`. */
function findArg(body: string, k: number, id: string): string | null {
  const marker = `\\htmlData{lyxarg=${k},id=${id}}`;
  const at = body.indexOf(marker);
  if (at < 0) return null;
  const g = readGroup(body, skipWs(body, at + marker.length));
  return g ? g[0] : null;
}

/** True if the formula contains expanded macro templates. */
export function hasExpandedMacros(latex: string): boolean { return latex.includes('\\htmlData{lyxmacro='); }
