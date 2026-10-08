/**
 * What a new document starts as, in both shells — the web app's New File / File ▸ New (server) and
 * the VS Code extension's New Document commands: a LaTeX article or a Markdown document. Slides,
 * posters and pages come from layout/templates.ts.
 */
import { texEscape } from './layout/templates.ts';

const ARTICLE = `\\documentclass[11pt]{article}
\\usepackage[T1]{fontenc}
\\usepackage[utf8]{inputenc}
\\usepackage{amsmath}
\\usepackage{amssymb}
\\usepackage{graphicx}

\\begin{document}
@@BODY@@

\\end{document}
`;

/** A new markdown document: its title as the first heading, then an empty paragraph to type in. */
export function newMarkdownText(title?: string): string {
  const t = (title ?? '').replace(/\s+/g, ' ').trim();
  return t ? `# ${t}\n\n` : '';
}

/** A new LaTeX document: the article template (another class with `textclass`), with a title block when given one. */
export function newDocumentText(opts: { textclass?: string; title?: string; author?: string } = {}): string {
  let tpl = ARTICLE;
  if (opts.textclass) tpl = tpl.replace(/^\\documentclass(\[[^\]]*\])?\{[^}]*\}/m, (m, o: string | undefined) => `\\documentclass${o ?? ''}{${opts.textclass}}`);
  const body: string[] = [];
  if (opts.title) body.push(`\\title{${texEscape(opts.title)}}`);
  if (opts.author) body.push(`\\author{${texEscape(opts.author)}}`);
  if (opts.title || opts.author) body.push('\\maketitle', '');
  return tpl.replace('@@BODY@@', body.join('\n'));
}
