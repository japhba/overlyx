// A stand-in for OpenRouter's chat completions API for manual / e2e testing of the AI features:
// answers depend on the kind of request (recognised from the system prompt) and echo parts of
// the request so the UI flow can be checked without a real model.
import http from 'node:http';
const port = Number(process.env.PORT ?? 3999);
const log = [];
http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/log') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(log)); return; }
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    let reply = '';
    try {
      const j = JSON.parse(body);
      const sys = j.messages[0].content, user = j.messages[1].content;
      log.push({ model: j.model, sys: sys.slice(0, 60), user });
      const m = /## Instruction\n([\s\S]*?)\n\nReply/.exec(user);
      const instruction = m ? m[1].trim() : '';
      if (sys.includes('autocomplete engine') && sys.includes('formula')) reply = '+ \\frac{\\sigma^{2}}{2} g^{2}';
      else if (sys.includes('autocomplete engine')) reply = ' is governed by the largest Lyapunov exponent $\\lambda_{1}$.';
      else if (user.includes('## The formula being edited')) reply = instruction.includes('fail') ? '' : '\\frac{\\alpha}{\\beta} + \\sqrt{x}';
      else if (user.includes('## The selected source to replace') || user.includes('write new source for the cursor')) reply = user.includes('## Your proposal') ? `\\textit{refined source (${instruction})}` : `\\textbf{rewritten source (${instruction})}`;
      else if (user.includes('## Your proposal')) reply = `Refined (${instruction}): the gain $g$ rules the chaotic transition.`;
      else if (instruction.includes('two paragraphs')) reply = 'First proposed paragraph with $x^{2}$.\n\nSecond proposed paragraph.';
      else if (instruction.includes('fail')) { res.statusCode = 500; res.end('{"error":{"message":"model exploded"}}'); return; }
      else reply = `Rewritten (${instruction}): the gain $g$ sets the transition to chaos, see \\cite{sompolinsky1988chaos}.`;
    } catch (e) { reply = 'stub error ' + e; }
    setTimeout(() => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: reply } }] }));
    }, Number(process.env.DELAY ?? 300));
  });
}).listen(port, '127.0.0.1', () => console.log('ai stub on', port));
