/**
 * How an AI agent signs its tracked changes and comments: the assistant, the model behind it, and
 * whose agent it is — "Claude (Opus 5.5) [Jan]", "Codex (GPT-5.5) [Ada]". The server's MCP
 * connector and Agent panel and the VS Code extension's local tool server all sign this way, and
 * the editor greys these authors' changes (isAgentAuthor).
 */

/** Characters a name keeps: they end up in LaTeX (\lyxadded{author}…), LyX's \author line and comment headers. */
const tidy = (s: string) => s.replace(/[^\p{L}\p{N} .+_'-]/gu, ' ').replace(/\s+/g, ' ').trim();
const cap = (w: string) => (/^[a-z]+$/.test(w) ? w[0].toUpperCase() + w.slice(1) : w);

/**
 * A model's name as people say it: "claude-opus-5-5[1m]" → "Opus 5.5", "gpt-5.1-codex-max" →
 * "GPT-5.1 Codex Max", "google/gemini-2.5-pro" → "Gemini 2.5 Pro". A name an agent gave itself
 * ("Opus 5.5", "Claude Opus 5.5") stays as it is.
 */
export function modelLabel(model: string): string {
  let m = model.trim().replace(/\[[^\]]*\]$/, '').trim();
  if (/\s/.test(m) || /[A-Z]/.test(m)) return tidy(m).slice(0, 40);
  m = m.replace(/^[\w.-]+\//, '').replace(/-(\d{8}|latest)$/, '');   // a provider's prefix, a dated snapshot
  const parts = m.split('-').filter(Boolean);
  if (parts[0] === 'claude') {
    const family = parts.find(p => /^[a-z]+$/.test(p) && p !== 'claude');
    const version = parts.filter(p => /^\d+(\.\d+)*$/.test(p)).join('.');
    if (family) return tidy(`${cap(family)}${version ? ' ' + version : ''}`);
  }
  if (parts[0] === 'gpt' && parts.length > 1) return tidy(`GPT-${parts[1]}${parts.length > 2 ? ' ' + parts.slice(2).map(cap).join(' ') : ''}`).slice(0, 40);
  return tidy(parts.map(cap).join(' ')).slice(0, 40);
}

/** "Claude (Opus 5.5) [Jan]"; without a model "Claude [Jan]", without an owner "Claude (Opus 5.5)". */
export function agentAuthorName(assistant: string, model?: string | null, owner?: string | null): string {
  const a = tidy(assistant) || 'AI agent';
  let m = model ? modelLabel(model) : '';
  if (m.toLowerCase().startsWith(a.toLowerCase() + ' ')) m = m.slice(a.length + 1);   // "Claude (Claude Opus 5.5)"
  if (m.toLowerCase() === a.toLowerCase()) m = '';
  const o = owner ? tidy(owner.trim().split(/\s+/)[0] ?? '') : '';
  return `${a}${m ? ` (${m})` : ''}${o ? ` [${o}]` : ''}`;
}

/** An agent's name (agentAuthorName, or the MCP connector's older "… (MCP)"), as opposed to a person's. */
export const isAgentAuthor = (name: string): boolean => /\(MCP\)\s*$|\s\[[^[\]]+\]\s*$/.test(name);
