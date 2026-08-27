import fs from 'node:fs';
const prof = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const nodes = new Map(prof.nodes.map(n => [n.id, n]));
const parent = new Map(); for (const n of prof.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
const B = Number(process.argv[3] ?? 100) * 1000;
let t = 0; const buckets = [];
for (let i = 0; i < prof.samples.length; i++) {
  t += prof.timeDeltas[i];
  const b = Math.floor(t / B);
  buckets[b] ??= new Map();
  const n = nodes.get(prof.samples[i]);
  // attribute to the top-most "interesting" frame: walk up to find first app-level frame name
  let cur = prof.samples[i]; let label = n.callFrame.functionName || '(anon)';
  const chain = []; while (cur !== undefined) { const cf = nodes.get(cur).callFrame; chain.push(cf.functionName || '(anon)'); cur = parent.get(cur); }
  const key = label + ' < ' + chain.slice(1, 6).join(' < ');
  buckets[b].set(key, (buckets[b].get(key) ?? 0) + prof.timeDeltas[i]);
}
buckets.forEach((m, i) => {
  const total = [...m.values()].reduce((a, b) => a + b, 0);
  const idle = m.get('(idle) < (root)') ?? 0;
  const top = [...m.entries()].filter(([k]) => !k.startsWith('(idle)')).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k, v]) => `${Math.round(v / 1000)}ms ${k.slice(0, 110)}`).join(' | ');
  console.log(`${String(i * B / 1000).padStart(5)}ms busy ${String(Math.round((total - idle) / 1000)).padStart(4)}ms: ${top}`);
});
