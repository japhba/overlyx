// Latency benchmark for autocomplete candidates on OpenRouter (key from the environment; never printed).
const key = process.env.OPENROUTER_API_KEY;
if (!key) { console.error('OPENROUTER_API_KEY missing'); process.exit(1); }
const models = process.argv.slice(2);
const SYSTEM = `You are the autocomplete engine of OverLyX, a WYSIWYG editor for scientific papers written in LaTeX. Continue the document at the cursor, marked ⟦CURSOR⟧.

Rules:
- Reply with the continuation only: finish the current sentence or clause, or add at most one short sentence (no more than 25 words). No explanations, no markdown fences, no quotation marks.
- Write LaTeX as the author would: inline math as $…$, the document's macros and notation, \\cite{key} only with keys that occur in the document.
- Start exactly at the cursor: begin with a space if the cursor follows a word and you start a new word; do not repeat text before the cursor.
- If no sensible continuation exists, reply with nothing at all.`;
const filler = Array.from({ length: 40 }, (_, i) => `Paragraph ${i}: we consider a recurrent network $\\dot{x}_i = -x_i + \\sum_j W_{ij}\\phi(x_j)$ with weights $\\bW$ drawn i.i.d. with variance $g^2/N$; for $g>1$ the dynamics are chaotic \\cite{sompolinsky1988chaos}.`).join('\n\n');
const user = `## Document (for context)\n\\documentclass{article}\n\\newcommand{\\bW}{\\mathbf{W}}\n\\begin{document}\n${filler}\n\n## Macros known to the document\n\\bW = \\mathbf{W}\n\n## Text at the cursor\nThe largest Lyapunov exponent $\\lambda_1$ of the network⟦CURSOR⟧\n\nReply with the continuation at ⟦CURSOR⟧ only.`;
console.log('prompt chars', user.length);
for (const spec of models) {
  const [model, flag] = spec.split('@');
  for (let run = 0; run < 2; run++) {
    const body = { model, temperature: 0.2, max_tokens: 120, messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }] };
    if (flag === 'noreason') body.reasoning = { enabled: false };
    if (flag === 'minimal') body.reasoning = { effort: 'minimal' };
    const t0 = Date.now();
    let text = '', err = '';
    try {
      const r = await fetch('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify(body) });
      const j = await r.json();
      text = j.choices?.[0]?.message?.content ?? ''; if (j.error) err = j.error.message;
      var usage = j.usage;
    } catch (e) { err = String(e); }
    console.log(`${spec.padEnd(42)} ${String(Date.now() - t0).padStart(5)} ms  ${err ? 'ERR ' + err.slice(0, 80) : JSON.stringify(text.slice(0, 90))}  ${usage ? 'tok ' + usage.prompt_tokens + '/' + usage.completion_tokens + (usage.completion_tokens_details?.reasoning_tokens ? ' reason ' + usage.completion_tokens_details.reasoning_tokens : '') : ''}`);
  }
}
