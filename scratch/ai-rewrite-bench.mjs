// Latency + quality benchmark for ⌘K rewrite candidates on OpenRouter (key from env; never printed).
// Replays the server's exact rewrite prompt (ai.ts REWRITE_SYSTEM / user-message shape) on a
// realistic paper. Two probes per model: (a) tighten a paragraph, (b) an instruction that only
// works with the document context (the passage writes "the weight matrix W", the paper's
// notation is \bW and the claim to cite sits elsewhere in the document).
//   node scratch/ai-rewrite-bench.mjs model[@noreason|@minimal|@low] ...
const key = process.env.OPENROUTER_API_KEY;
if (!key) { console.error('OPENROUTER_API_KEY missing'); process.exit(1); }

const SEL_OPEN = '⟦SELECTION⟧', SEL_CLOSE = '⟦/SELECTION⟧', CURSOR = '⟦CURSOR⟧';
const SYSTEM = `You are a writing and LaTeX assistant built into OverLyX, a WYSIWYG editor for scientific papers written in LaTeX. The user has selected a passage of their document and gives an instruction. Produce the replacement for the passage.

Rules:
- Reply with the replacement LaTeX only. No explanations, no markdown fences, no quotation marks around it, no \\documentclass / \\begin{document}.
- Keep the document's conventions: its notation, its macros (a list is given), the citation keys and labels that exist in it, its language and tone. Inline math as $…$; keep display environments (equation, align, …) as in the original and preserve every \\label.
- Change only what the instruction asks for. Do not add remarks, headings, or content the instruction does not call for.
- If nothing is selected, the instruction asks for new text to insert at the cursor, marked ${CURSOR} in the document: write exactly that, fitting between what is before and after the marker.
- The document text is provided for context only; the passage to replace is delimited by ${SEL_OPEN} … ${SEL_CLOSE} (the markers are not part of the document).
- Comments in the source that start with "%%" and macros \\lyxadded / \\lyxdeleted are the editor's own bookkeeping (notes, tracked changes): never produce them.`;

const fillPar = i => `In Section ${2 + (i % 4)} we analyse regime ${i}: the local field $h_i = \\sum_j \\bW_{ij}\\phi(x_j)$ concentrates for large $N$, and the order parameter $\\Delta_${i % 9}(t)$ obeys a self-consistent equation derived in Appendix~A \\cite{sompolinsky1988chaos,molgedey1992suppressing}. The gain $g$ sets the distance to the transition.`;
const PAR_A = `Deep networks can be trained with gradient descent. The dynamics of training are complicated and hard to analyse. Many people have studied this problem with different methods and found different results. In this paper we look at the problem again with our own method and find some new results that we think are interesting.`;
const PAR_B = `We now introduce the weight matrix W, whose entries are random numbers with mean zero. The size of the entries is set by a parameter. As shown before, when this parameter is big the network becomes chaotic.`;
const paper = (sel) => `\\documentclass{article}
\\usepackage{amsmath}
\\newcommand{\\bW}{\\mathbf{W}}
\\newcommand{\\lyap}{\\lambda_{\\max}}
\\newcommand{\\E}[1]{\\mathbb{E}\\left[#1\\right]}
\\title{Chaos and Trainability in Random Recurrent Networks}
\\begin{document}
\\maketitle
\\section{Introduction}\\label{sec:intro}
Recurrent networks $\\dot{x}_i = -x_i + \\sum_j \\bW_{ij}\\phi(x_j)$ with i.i.d.\\ weights of variance $g^2/N$ undergo a transition to chaos at $g=1$ \\cite{sompolinsky1988chaos}: the largest Lyapunov exponent $\\lyap$ becomes positive, and $\\E{x_i^2}$ saturates. Throughout, the weight matrix is written $\\bW$ and the nonlinearity is $\\phi=\\tanh$.

${sel}

\\section{Model}\\label{sec:model}
${Array.from({ length: 28 }, (_, i) => fillPar(i)).join('\n\n')}
\\end{document}`;

const probes = [
  { name: 'tighten', sel: PAR_A, instruction: 'Make this paragraph concise and precise — at most two sentences, academic tone.', check: t => t.length > 40 && t.length < 700 && !/```|Here is|I have/.test(t) },
  { name: 'context', sel: PAR_B, instruction: "Rewrite this paragraph using the document's notation and macros, citing the chaos result properly.", check: t => /\\bW/.test(t) && /sompolinsky1988chaos/.test(t) },
];

for (const spec of process.argv.slice(2)) {
  const [model, flag] = spec.split('@');
  for (const p of probes) {
    const doc = paper(SEL_OPEN + p.sel + SEL_CLOSE);
    const user = `## Document (for context; the passage to replace is marked)\n${doc}\n\n## Macros known to the document\n\\bW = \\mathbf{W}\n\\lyap = \\lambda_{\\max}\n\\E[1] = \\mathbb{E}\\left[#1\\right]\n\n## Passage to replace\n${p.sel}\n\n## Instruction\n${p.instruction}\n\nReply with the replacement for the passage only.`;
    const body = { model, max_tokens: 2048, messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }] };
    if (!/^openai\/gpt-5/.test(model)) body.temperature = 0.2;
    if (flag === 'noreason') body.reasoning = { enabled: false };
    if (flag === 'minimal') body.reasoning = { effort: 'minimal' };
    if (flag === 'low') body.reasoning = { effort: 'low' };
    const t0 = Date.now();
    let text = '', err = '', usage = null;
    try {
      const r = await fetch('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify(body) });
      const j = await r.json();
      text = j.choices?.[0]?.message?.content ?? '';
      if (j.error) err = JSON.stringify(j.error).slice(0, 140);
      usage = j.usage;
    } catch (e) { err = String(e).slice(0, 140); }
    const ms = Date.now() - t0;
    const reason = usage?.completion_tokens_details?.reasoning_tokens ?? 0;
    const ok = err ? 'ERR' : !text.trim() ? 'EMPTY' : p.check(text) ? 'ok' : 'weak';
    console.log(`${spec.padEnd(40)} ${p.name.padEnd(8)} ${String(ms).padStart(6)} ms  ${String(usage?.completion_tokens ?? '?').padStart(5)} tok (${String(reason).padStart(4)} reason)  ${ok.padEnd(5)} ${err || JSON.stringify(text.slice(0, 110))}`);
  }
}
