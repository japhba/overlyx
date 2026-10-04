/**
 * Agent text in the Agent panel — the embedded agent's transcript and the replies of agents
 * connected from elsewhere: block structure (fenced code, tables, quotes, headings, rules —
 * app/mdblocks.ts) over running text with $…$ / \[…\] formulas, rendered through the math
 * editor's MathJax path with the open document's macros, `code`, **bold** and links.
 */
import { useMemo, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { editorContext } from '../editor/context';
import { renderStaticHtml } from '../editor/lyxmath/field';
import { useMathRendererVersion } from '../editor/lyxmath/usemath';
import { latexSelectionText } from './richcopy';
import { parseBlocks, type MdBlock } from './mdblocks';

/** Copying from a transcript: rendered formulas leave as their LaTeX source (see richcopy.ts). */
export const transcriptCopy = (e: ClipboardEvent) => {
  const t = latexSelectionText(document.getSelection());
  if (t === null || !e.clipboardData) return;
  e.preventDefault();
  e.clipboardData.setData('text/plain', t);
};

function MathBit({ latex, display }: { latex: string; display: boolean }) {
  // drawn again with another math font, or once the font data it waited for has arrived
  const version = useMathRendererVersion();
  const [retried, setRetried] = useState(0);
  const html = useMemo(() => {
    try { return renderStaticHtml(latex, display, (editorContext.meta?.macros ?? {}) as never, undefined, () => setRetried(n => n + 1)); } catch { return null; }
  }, [latex, display, version, retried]);
  const attrs = { 'data-latex': latex, 'data-display': display ? '1' : undefined };
  if (!html) return <span class="agent-math" {...attrs}>{display ? `\\[${latex}\\]` : `$${latex}$`}</span>;
  return <span class={'agent-math' + (display ? ' display' : '')} {...attrs} dangerouslySetInnerHTML={{ __html: html }} />;
}

function inlineBits(text: string): ComponentChildren[] {
  const out: ComponentChildren[] = [];
  const re = /\$([^$\n]+?)\$|\\\((.+?)\\\)|`([^`\n]+)`|\*\*([^*\n]+?)\*\*|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g;
  let last = 0, k = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1] !== undefined || m[2] !== undefined) out.push(<MathBit key={k++} latex={m[1] ?? m[2]} display={false} />);
    else if (m[3] !== undefined) out.push(<code key={k++}>{m[3]}</code>);
    else if (m[4] !== undefined) out.push(<b key={k++}>{m[4]}</b>);
    else out.push(<a key={k++} href={m[6]} target="_blank" rel="noreferrer">{m[5]}</a>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Running text: $$…$$/\[…\] display math (also a stray fence), $…$/\(…\) inline math, `code`, **bold**, [links](https://…). */
function FlowText({ text }: { text: string }) {
  const parts: ComponentChildren[] = [];
  const re = /```[\w-]*\n?([\s\S]*?)```|\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]/g;
  let last = 0, k = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) parts.push(...inlineBits(text.slice(last, m.index)));
    if (m[1] !== undefined) parts.push(<pre key={'c' + k++} class="agent-code">{m[1].replace(/\n$/, '')}</pre>);
    else parts.push(<div key={'m' + k++} class="agent-math-block"><MathBit latex={(m[2] ?? m[3]).trim()} display /></div>);
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(...inlineBits(text.slice(last)));
  return <>{parts}</>;
}

/** Assistant text: block structure (fenced code, tables, quotes, headings, rules — app/mdblocks.ts) over FlowText. */
export function RichText({ text }: { text: string }) {
  return <>{parseBlocks(text).map((b, i) => <Block key={i} b={b} />)}</>;
}

function Block({ b }: { b: MdBlock }) {
  switch (b.kind) {
    case 'text': return <FlowText text={b.text} />;
    case 'code': return <pre class="agent-code" data-lang={b.lang || undefined}>{b.code}</pre>;
    case 'heading': return <div class={`agent-h agent-h${b.level}`}>{inlineBits(b.text)}</div>;
    case 'rule': return <hr class="agent-hr" />;
    case 'quote': return <blockquote class="agent-quote">{b.blocks.map((x, i) => <Block key={i} b={x} />)}</blockquote>;
    case 'table': {
      const style = (i: number) => (b.align[i] ? { textAlign: b.align[i]! } : undefined);
      return (
        <div class="agent-table-wrap">
          <table class="agent-table">
            <thead><tr>{b.head.map((c, i) => <th key={i} style={style(i)}>{inlineBits(c)}</th>)}</tr></thead>
            <tbody>{b.rows.map((r, ri) => <tr key={ri}>{r.map((c, i) => <td key={i} style={style(i)}>{inlineBits(c)}</td>)}</tr>)}</tbody>
          </table>
        </div>
      );
    }
  }
}
